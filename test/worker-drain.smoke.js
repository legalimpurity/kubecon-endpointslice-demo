// worker-drain.smoke.js — proves the graceful-drain contract Act 2 relies on:
// a PLANNED shutdown (SIGTERM) finishes the in-flight job, refuses new work (503), then exits.
// (An abrupt SIGKILL skips all this and loses the session — that's the on-purpose Act 2 failure.)
// Run: node test/worker-drain.smoke.js
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const assert = require('assert');

const PORT = 8099;
const child = spawn('node', ['worker.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT), READY_MS: '0', LATENCY_MEDIAN_MS: '1200', LATENCY_SIGMA: '0.01' },
  stdio: 'ignore',
});
const get = (p) => new Promise((res) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 6000 }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); });
  q.on('error', () => res('ERR'));
  q.on('timeout', () => { q.destroy(); res('TIMEOUT'); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(500);                                   // let it bind
  assert.strictEqual(await get('/healthz'), 200, 'healthy before drain');
  const inflight = get('/scrape');                    // a ~1.2s job
  await sleep(300);                                   // ensure it is mid-job
  child.kill('SIGTERM');                              // PLANNED shutdown -> drain
  await sleep(120);
  assert.strictEqual(await get('/healthz'), 503, 'healthz 503 while draining (pod leaves the EndpointSlice)');
  assert.strictEqual(await get('/scrape'), 503, 'new work refused (503) while draining -> router re-queues it');
  assert.strictEqual(await inflight, 200, 'the in-flight job COMPLETES during drain (no loss on planned shutdown)');
  const exited = await new Promise((r) => { child.on('exit', () => r(true)); setTimeout(() => r(false), 3000); });
  assert.strictEqual(exited, true, 'worker exits once drained');
  console.log('  ✓ graceful drain: in-flight completes, new work refused, then exits');
  console.log('\nWORKER DRAIN OK');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); try { child.kill('SIGKILL'); } catch {} process.exit(1); });
