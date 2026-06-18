// router.js — the demo's hold + lease + free-pool router (zero dependencies).
//
// Runs on a stock node:20-alpine image, mounted from a ConfigMap (no npm install).
// It mirrors the PRODUCTION proxy's design — watch EndpointSlices → keep an in-memory
// per-pool free-pool → HOLD a request until a browser is free → lease ONE browser
// exclusively → dial the pod IP directly. It does not load-balance across
// interchangeable replicas — it leases one browser to one request.
//
// Routing model (what the talk argues a Service cannot do):
//   GET /scrape  -> free browser in the pool?
//                     yes -> ACQUIRE (mark busy) + dial POD_IP:TARGET_PORT direct
//                     no  -> HOLD the connection on a FIFO wait queue (no error),
//                            woken when a lease releases or a new browser goes ready
//   GET /statusz -> JSON: pool {total,ready,busy,free,queued} + counters (drives the stage pane)
//   GET /healthz -> 200 once the initial EndpointSlice list has completed
//
// FAILURE MODEL (this is the honest part):
//   * STALE endpoint / never-connected, or worker says 503/409 (didn't take the job):
//       the session never started -> set the browser aside briefly + RE-QUEUE this
//       request to another free browser. Invisible: the client never sees it.
//   * MID-SESSION death (we connected & handed off the job, then the browser died):
//       the in-flight automation CANNOT move to a fresh blank browser -> that one
//       request FAILS (502). We do not, and cannot, resume it. Blast radius = one job;
//       the upstream layer retries it from scratch as a new session.
//
// One headless Service publishes the EndpointSlices for one pool; production runs one
// of these informers per pool. The demo uses a single pool for clarity.

'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');

// ---------- config ----------
const PORT = parseInt(process.env.PORT || '8081', 10);
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '8080', 10);
// End-to-end dial budget. This is a socket-INACTIVITY timeout, and a healthy render sends
// nothing until it finishes, so the socket is idle for the WHOLE job — the budget must
// therefore comfortably EXCEED the worker's longest job (p99 ~16s with the manifest's
// 10s floor) or a slow-but-healthy render is aborted and misread as a mid-session death.
const DIAL_TIMEOUT_MS = parseInt(process.env.DIAL_TIMEOUT_MS || '30000', 10);
const SETASIDE_MS = parseInt(process.env.SETASIDE_MS || '3000', 10);  // how long a stale browser is benched
const MAX_HOLD_MS = parseInt(process.env.MAX_HOLD_MS || '30000', 10); // how long we hold a caller before 503
const POOL = process.env.POOL_NAME || 'browsers';

// =====================================================================================
// The lease engine — cluster-agnostic and dial-injected, so it can be unit-tested off
// a cluster (see test/router.smoke.js). The K8s watch below just feeds it endpoint IPs.
// =====================================================================================
function createEngine({ dial, now = () => Date.now(), log = () => {} }) {
  const eps = new Map();   // ip -> { ready:bool, busy:bool, setAsideUntil:number }
  const waiters = [];      // FIFO: { resolve, reject, enqueuedAt, timer, tries:Set<ip> }
  const stats = {
    leases: 0, releases: 0, holds: 0, requeues: 0, setAsides: 0,
    midSessionFails: 0, holdTimeouts: 0, watchEvents: 0, relists: 0,
  };

  const isFree = (e, t) => e.ready && !e.busy && e.setAsideUntil <= t;

  function counts() {
    const t = now();
    let ready = 0, busy = 0, free = 0;
    for (const e of eps.values()) { if (e.ready) ready++; if (e.busy) busy++; if (isFree(e, t)) free++; }
    return { total: eps.size, ready, busy, free, queued: waiters.length };
  }

  function pickFree(exclude) {
    const t = now();
    for (const [ip, e] of eps) {
      if (isFree(e, t) && !(exclude && exclude.has(ip))) return ip;
    }
    return null;
  }

  // Reconcile the ready set from the watch. Preserve busy/set-aside state on survivors.
  // A busy browser that disappears from the slice stays tracked (ready=false, busy=true)
  // so its in-flight dial resolves as a MID-SESSION failure rather than vanishing silently.
  function setReadyEndpoints(readyIps) {
    const set = new Set(readyIps);
    for (const ip of set) {
      const e = eps.get(ip) || { ready: false, busy: false, setAsideUntil: 0 };
      e.ready = true;
      eps.set(ip, e);
    }
    for (const [ip, e] of [...eps]) {
      if (!set.has(ip)) { e.ready = false; if (!e.busy) eps.delete(ip); }
    }
    wakeWaiters();
  }

  function wakeWaiters() {
    while (waiters.length) {
      const ip = pickFree();
      if (!ip) break;
      const w = waiters.shift();
      clearTimeout(w.timer);
      log(`WAKE waiter (held ${now() - w.enqueuedAt}ms, depth now ${waiters.length})`);
      serve(ip, w);
    }
  }

  // Lease `ip` to waiter `w`: mark busy, dial, then apply the failure model.
  function serve(ip, w) {
    const e = eps.get(ip);
    if (!e) return dispatch(w);          // vanished between pick and serve — try again
    e.busy = true;
    stats.leases++;
    log(`LEASE ${ip}`);
    Promise.resolve()
      .then(() => dial(ip))
      .then(() => {                       // upstream 200 — the lease succeeded
        releaseToFree(ip);
        log(`RELEASE ${ip} (ok)`);
        w.resolve({ ip });
      })
      .catch((err) => {
        const retryable = err && err.retryable === true;
        if (retryable) {
          // PRE-SESSION: stale endpoint or worker-not-ready. Invisible re-queue.
          stats.setAsides++; stats.requeues++;
          setAside(ip);
          log(`STALE ${ip} (${err.reason || 'pre-session'}) -> set aside ${SETASIDE_MS}ms, re-queue (invisible)`);
          w.tries = w.tries || new Set();
          w.tries.add(ip);
          dispatch(w);                    // hand this request to another free browser, or hold
        } else {
          // MID-SESSION: we committed to this browser and it died. No resume.
          stats.midSessionFails++;
          dropBusy(ip);
          log(`MID-SESSION-FAIL ${ip} (${err && err.reason || 'died'}) -> 502 to client (no resume)`);
          w.reject({ code: 502, reason: 'browser died mid-session (not resumable)', ip });
        }
      });
  }

  function releaseToFree(ip) {
    const e = eps.get(ip);
    if (!e) return;
    e.busy = false; stats.releases++;
    if (!e.ready) { eps.delete(ip); return; }   // released a now-gone browser
    wakeWaiters();
  }
  function setAside(ip) {
    const e = eps.get(ip);
    if (!e) return;
    e.busy = false; e.setAsideUntil = now() + SETASIDE_MS;
    setTimeout(wakeWaiters, SETASIDE_MS + 5).unref?.();
  }
  function dropBusy(ip) {
    const e = eps.get(ip);
    if (!e) return;
    e.busy = false;
    if (!e.ready) eps.delete(ip); else wakeWaiters();
  }

  // Route one request: lease a free browser if any, else HOLD it on the queue.
  function dispatch(w) {
    const ip = pickFree(w.tries);
    if (ip) return serve(ip, w);
    stats.holds++;
    if (!w.enqueuedAt) w.enqueuedAt = now();
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      stats.holdTimeouts++;
      log(`HOLD-TIMEOUT after ${MAX_HOLD_MS}ms -> 503`);
      w.reject({ code: 503, reason: 'no free browser within hold window' });
    }, MAX_HOLD_MS);
    waiters.push(w);
    log(`HOLD queued (depth ${waiters.length})`);
  }

  function handle() {
    return new Promise((resolve, reject) => dispatch({ resolve, reject }));
  }

  return {
    handle, setReadyEndpoints, counts, stats,
    busyIps: () => { const a = []; for (const [ip, e] of eps) if (e.busy) a.push(ip); return a; },
    // test-only hooks (used by test/router.smoke.js; never called in cluster):
    _add: (ip) => { const e = eps.get(ip) || { ready: false, busy: false, setAsideUntil: 0 }; e.ready = true; eps.set(ip, e); wakeWaiters(); },
    _remove: (ip) => { const e = eps.get(ip); if (e) { e.ready = false; if (!e.busy) eps.delete(ip); } },
    _eps: eps,
  };
}

// =====================================================================================
// Real dial: HTTP to a pod IP. Classifies failures as retryable (pre-session) vs
// non-retryable (mid-session) — the distinction the whole demo turns on.
//
// DIAL_TIMEOUT_MS is a socket-inactivity timeout; WHICH PHASE it fires in is the classifier:
//   * fired BEFORE connect -> stale / unreachable endpoint, no session began -> RETRYABLE
//   * fired AFTER  connect -> the browser took the job then went dark        -> MID-SESSION
// A healthy render is idle on the wire for its full duration, so the budget MUST exceed the
// worker's longest job — otherwise it trips in the connected phase and a good render looks
// like a mid-session death. (That was the Act-1 bug: 2s budget vs a >=10s render.)
// =====================================================================================
function realDial(ip) {
  return new Promise((resolve, reject) => {
    let connected = false, settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = http.request(
      { host: ip, port: TARGET_PORT, path: '/scrape', method: 'GET', timeout: DIAL_TIMEOUT_MS, agent: false },
      (res) => {
        connected = true;
        res.resume(); // drain
        res.on('end', () => {
          if (res.statusCode === 200) return done(resolve, { status: 200 });
          // 503/409 = the worker explicitly did NOT run the job (cold / busy): safe to re-queue.
          if (res.statusCode === 503 || res.statusCode === 409) {
            return done(reject, { retryable: true, reason: `worker ${res.statusCode}` });
          }
          // any other status = the job ran and failed: do not move it.
          return done(reject, { retryable: false, reason: `upstream ${res.statusCode}` });
        });
        res.on('error', () => done(reject, { retryable: false, reason: 'response stream error' }));
      }
    );
    req.on('socket', (s) => {
      if (s.connecting === false) connected = true;
      else s.once('connect', () => { connected = true; });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); // idle past the budget -> abort the dial (-> 'error')
    // connected => we committed to this browser => MID-SESSION (not retryable).
    // never connected => stale endpoint => retryable.
    req.on('error', (e) => done(reject, { retryable: !connected, reason: connected ? `mid-session ${e.message}` : `dial ${e.message}` }));
    req.end();
  });
}

// =====================================================================================
// Kubernetes EndpointSlice watch (raw API, the same plumbing proven in production).
// Feeds the engine the current ready pod IPs. Self-heals: relists when the stream drops.
// =====================================================================================
function startWatch(engine) {
  const SA = process.env.SA_DIR || '/var/run/secrets/kubernetes.io/serviceaccount';
  const saRead = (f) => { try { return fs.readFileSync(`${SA}/${f}`); } catch { return null; } };
  const TOKEN = (saRead('token') || '').toString().trim();
  const CA = saRead('ca.crt');
  const NS = process.env.NAMESPACE || (saRead('namespace') || '').toString().trim();
  const SVC = process.env.SERVICE_NAME;
  const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST;
  const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';
  if (!SVC || !TOKEN || !CA || !NS) { console.error('[router] need SERVICE_NAME + ServiceAccount (token/ca/namespace)'); process.exit(1); }

  const BASE = `/apis/discovery.k8s.io/v1/namespaces/${NS}/endpointslices`;
  const SELECTOR = encodeURIComponent(`kubernetes.io/service-name=${SVC}`);
  const slices = new Map();   // sliceName -> [{ ip, ready }]
  let listed = false;

  const eligible = (ep) => { const c = ep.conditions || {}; return c.ready === true && c.terminating !== true; };
  const ingest = (slice) => {
    const eps = [];
    for (const ep of slice.endpoints || [])
      for (const ip of ep.addresses || [])
        if (eligible(ep)) eps.push(ip);
    slices.set(slice.metadata.name, eps);
  };
  const push = () => { const ips = []; for (const arr of slices.values()) ips.push(...arr); engine.setReadyEndpoints(ips); };

  const apiGet = (path) => new Promise((resolve, reject) => {
    const req = https.request({ host: K8S_HOST, port: K8S_PORT, path, ca: CA, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
      let body = ''; res.on('data', (d) => body += d);
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`${res.statusCode} ${body.slice(0, 200)}`)));
    });
    req.on('error', reject); req.end();
  });

  const watch = (rv) => new Promise((resolve) => {
    const path = `${BASE}?labelSelector=${SELECTOR}&watch=1&allowWatchBookmarks=true&resourceVersion=${rv}&timeoutSeconds=300`;
    const req = https.request({ host: K8S_HOST, port: K8S_PORT, path, ca: CA, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            engine.stats.watchEvents++;
            if (ev.type === 'BOOKMARK') continue;
            if (ev.type === 'ERROR') { req.destroy(); return; }
            if (ev.type === 'DELETED') slices.delete(ev.object.metadata.name); else ingest(ev.object);
            push();
          } catch { /* partial line */ }
        }
      });
      res.on('end', resolve); res.on('error', resolve);
    });
    req.on('error', resolve); req.end();
  });

  (async function listAndWatch() {
    for (;;) {
      try {
        const list = await apiGet(`${BASE}?labelSelector=${SELECTOR}`);
        slices.clear();
        for (const item of list.items || []) ingest(item);
        push();
        listed = true;
        engine.stats.relists++;
        const c = engine.counts();
        console.log(`[router] listed: ${slices.size} slices, ${c.ready} ready (rv=${list.metadata.resourceVersion})`);
        await watch(list.metadata.resourceVersion);
      } catch (e) {
        console.error(`[router] list/watch error: ${e.message}; relisting in 1s`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();

  return { isListed: () => listed };
}

// =====================================================================================
// HTTP server (only runs when executed directly, not when require()'d by tests).
// =====================================================================================
function main() {
  const engine = createEngine({ dial: realDial, log: (m) => console.log(`[router] ${m}`) });
  const watcher = startWatch(engine);

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/statusz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ pool: POOL, ...engine.counts(), busyIps: engine.busyIps(), ...engine.stats }));
    }
    if (req.url.startsWith('/healthz')) { res.writeHead(watcher.isListed() ? 200 : 503); return res.end(); }
    if (req.url.startsWith('/scrape')) {
      engine.handle()
        .then((r) => { res.writeHead(200, { 'content-type': 'text/plain', 'x-browser': r.ip }); res.end(`ok via ${r.ip}\n`); })
        .catch((err) => { res.writeHead(err.code || 502); res.end(`${err.reason || 'error'}\n`); });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.keepAliveTimeout = 5000;
  server.listen(PORT, () => console.log(`[router] :${PORT} pool=${POOL} -> direct pod IPs :${TARGET_PORT} (hold+lease, not load-balance)`));

  setInterval(() => {
    const c = engine.counts(); const s = engine.stats;
    console.log(`[router] free=${c.free} busy=${c.busy} queued=${c.queued} | leases=${s.leases} requeues=${s.requeues} midSessionFails=${s.midSessionFails} holdTimeouts=${s.holdTimeouts}`);
  }, 10000).unref?.();
}

module.exports = { createEngine, realDial };
if (require.main === module) main();
