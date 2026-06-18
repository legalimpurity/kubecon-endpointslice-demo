// worker.js — a fake "browser" for the demo. Zero dependencies; runs on node:20-alpine
// from a ConfigMap mount. It stands in for one headless Chrome leased for one job.
//
//   GET /scrape  -> simulate a render: wait a lognormal-sampled latency, then 200.
//                   EXCLUSIVE: if a scrape is already in flight, reply 409 (busy) —
//                   one job per browser, never a second caller. (The router leases
//                   exclusively so this should never fire; it's here to PROVE it.)
//   GET /healthz -> 503 until READY_MS elapsed (cold Chrome still starting), then 200.
//                   This is what the readinessProbe hits, so a cold pod stays out of
//                   the headless Service's EndpointSlices until it's up.
//
// Optional "ready ≠ warm" gap: set COLD_JOB_MS > 0 and the FIRST job after
// the pod goes Ready still fails (503) for that window — Ready, but not warm yet.
//
// ENV: PORT=8080, LATENCY_MEDIAN_MS=120, LATENCY_SIGMA=0.5, LATENCY_MIN_MS=0, READY_MS=0, COLD_JOB_MS=0

'use strict';
const http = require('http');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MEDIAN = parseFloat(process.env.LATENCY_MEDIAN_MS || '120');
const SIGMA = parseFloat(process.env.LATENCY_SIGMA || '0.5'); // lognormal shape; p99 ≈ median*exp(2.33*sigma)
const MIN_MS = parseInt(process.env.LATENCY_MIN_MS || '0', 10); // floor: a job never finishes faster than this
const READY_MS = parseInt(process.env.READY_MS || '0', 10);   // cold-start before /healthz = 200
const COLD_JOB_MS = parseInt(process.env.COLD_JOB_MS || '0', 10); // "ready but not warm" window after ready

const start = Date.now();
const mu = Math.log(MEDIAN);
const POD = os.hostname();
let served = 0, rejectedBusy = 0, coldFails = 0, active = 0, draining = false;

function sampleLatency() {
  const u1 = Math.random(), u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // Box–Muller
  return Math.min(Math.exp(mu + SIGMA * z), MEDIAN * 50); // cap the tail
}

const srv = http.createServer((req, res) => {
  const age = Date.now() - start;

  if (req.url.startsWith('/healthz')) {
    if (draining) { res.writeHead(503); return res.end('draining'); }
    if (age < READY_MS) { res.writeHead(503); return res.end('starting'); }
    res.writeHead(200); return res.end('ok');
  }

  if (req.url.startsWith('/scrape')) {
    if (draining) { res.writeHead(503); return res.end('draining'); }   // planned shutdown: refuse new work
    // exclusivity: one job per browser at a time
    if (active > 0) { rejectedBusy++; res.writeHead(409); return res.end('busy'); }
    // ready-but-not-warm: first jobs after becoming Ready still fail briefly
    if (COLD_JOB_MS > 0 && age < READY_MS + COLD_JOB_MS) {
      coldFails++; res.writeHead(503); return res.end('warming up');
    }
    active++;
    const wait = Math.max(MIN_MS, sampleLatency());
    return setTimeout(() => {
      active--; served++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pod: POD, simulatedMs: Math.round(wait) }));
    }, wait);
  }

  res.writeHead(200); res.end(`browser ${POD}`);
});

srv.keepAliveTimeout = 5000;
srv.listen(PORT, HOST, () =>
  console.log(`[worker] ${POD} ${HOST}:${PORT} min=${MIN_MS}ms median=${MEDIAN}ms ready=${READY_MS}ms coldJob=${COLD_JOB_MS}ms`));
setInterval(() => console.log(`[worker] ${POD} served=${served} busy409=${rejectedBusy} coldFails=${coldFails} active=${active}`), 10000).unref?.();

// Graceful drain: a PLANNED shutdown (SIGTERM from scale-down / rolling update) finishes the
// in-flight job, refuses new work (503 -> the router re-queues it), then exits. So routine
// churn is invisible to clients. An ABRUPT kill (SIGKILL / spot reclaim) skips this entirely,
// so the in-flight session is lost — that's the one honest failure Act 2 shows on purpose.
function drain(sig) {
  if (draining) return;
  draining = true;
  console.log(`[worker] ${POD} ${sig}: draining (active=${active})`);
  const finish = () => srv.close(() => { console.log(`[worker] ${POD} drained, exiting`); process.exit(0); });
  if (active === 0) return finish();
  const iv = setInterval(() => { if (active === 0) { clearInterval(iv); finish(); } }, 50);
}
process.on('SIGTERM', () => drain('SIGTERM'));
process.on('SIGINT', () => drain('SIGINT'));
