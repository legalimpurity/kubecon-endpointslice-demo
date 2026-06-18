// loadgen.js — stage-friendly load display. Hits a URL at fixed QPS and prints
// one line per second: success rate, errors, p50/p99. Designed to be READ BY AN
// AUDIENCE (big, stable, one line/sec) — unlike fortio's wall of text.
//
// Usage: node loadgen.js <url> [qps] [label]
//   node loadgen.js http://localhost:30081/scrape 0.5 "browser-farm"
const http = require('http');

const TARGET = process.argv[2];
const QPS = parseFloat(process.argv[3] || '80');   // supports fractional rates, e.g. 0.5
const LABEL = process.argv[4] || TARGET;
if (!TARGET) { console.error('usage: node loadgen.js <url> [qps] [label]'); process.exit(1); }

const u = new URL(TARGET);
// Per-request patience. The router HOLDS a caller until a browser is free and a render now
// runs >=10s, so a legitimately-served request can take tens of seconds. This must exceed the
// router's hold+render budget (MAX_HOLD_MS + a job) — otherwise the load client gives up before
// the router does and reports false errors. Matches act1's `curl --max-time 150`.
const REQ_TIMEOUT_MS = parseInt(process.env.REQ_TIMEOUT_MS || '150000', 10);
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
let ok = 0, err = 0, lat = [];
let totOk = 0, totErr = 0;

function shoot() {
  const t0 = process.hrtime.bigint();
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, agent, timeout: REQ_TIMEOUT_MS }, (res) => {
    res.resume();
    res.on('end', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (res.statusCode === 200) { ok++; lat.push(ms); } else err++;
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => err++);
  req.end();
}
// fire at the requested rate; an accumulator supports any QPS, including fractional/low (e.g. 0.5)
let _acc = 0;
setInterval(() => { _acc += QPS / 10; while (_acc >= 1) { shoot(); _acc -= 1; } }, 100);

let sec = 0;
console.log(`\n=== ${LABEL} @ ${QPS} qps ===`);
setInterval(() => {
  sec++;
  const total = ok + err;
  if (total === 0) {
    // long jobs mean some seconds complete nothing — say so, don't print a misleading 0% line
    console.log(`t=${String(sec).padStart(3)}s  (idle — jobs still in flight, none completed this second)`);
    ok = 0; err = 0; lat = [];
    return;
  }
  lat.sort((a, b) => a - b);
  const p = (q) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(0) : '-';
  const rate = (100 * ok / total).toFixed(1);
  totOk += ok; totErr += err;
  const bar = err === 0 ? '✓' : '✗'.repeat(Math.min(err, 20));
  console.log(`t=${String(sec).padStart(3)}s  ok=${rate.padStart(5)}%  err=${String(err).padStart(3)}  p50=${p(0.5).padStart(4)}ms  p99=${p(0.99).padStart(4)}ms  ${bar}`);
  ok = 0; err = 0; lat = [];
}, 1000);

process.on('SIGINT', () => {
  console.log(`\nTOTAL ok=${totOk} err=${totErr} (${(100 * totOk / Math.max(1, totOk + totErr)).toFixed(2)}% success)`);
  process.exit(0);
});
