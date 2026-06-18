// router-integration.smoke.js — end-to-end check of the REAL dial path against a live worker.
//
// router.smoke.js injects a fake dial to test the lease engine in isolation. This test instead
// boots the actual worker.js over HTTP and drives the engine through realDial(), proving the two
// things the injected test can't:
//   1) a real lease + direct pod dial returns 200, and
//   2) the EXCLUSIVE lease HOLDS a second caller until the first releases (one job per browser),
//      so two requests at a single browser are serialized rather than run concurrently.
//
// Run: node test/router-integration.smoke.js   (exits non-zero on any failed assertion)
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const PORT = 8090;
// realDial reads TARGET_PORT at module load, so set it BEFORE requiring the router.
process.env.TARGET_PORT = String(PORT);
process.env.DIAL_TIMEOUT_MS = '5000';
const { createEngine, realDial } = require('../router.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const worker = spawn('node', ['worker.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT), READY_MS: '0', LATENCY_MEDIAN_MS: '500', LATENCY_SIGMA: '0.01' },
  stdio: 'ignore',
});

(async () => {
  await sleep(600);                                   // let the worker bind
  const engine = createEngine({ dial: realDial, log: () => {} });
  engine._add('127.0.0.1');                            // stands in for the EndpointSlice watch adding a ready pod

  // Two requests at the SAME single browser. Exclusivity => the 2nd must HOLD until the 1st frees.
  const t0 = Date.now();
  const a = engine.handle();
  await sleep(60);
  const b = engine.handle();
  await sleep(60);
  assert.strictEqual(engine.counts().busy, 1, 'exactly one browser busy (exclusive lease)');
  assert.strictEqual(engine.counts().queued, 1, 'the second caller is HELD while the only browser is busy');

  const ra = await a;
  assert.strictEqual(ra.ip, '127.0.0.1', 'first request served by the live worker (200 via direct dial)');
  const rb = await b;                                  // wakes once the first releases
  assert.strictEqual(rb.ip, '127.0.0.1', 'second request served after the lease releases');

  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 850, `two ~500ms jobs serialized by exclusivity took ${elapsed}ms (>=850 expected)`);
  assert.strictEqual(engine.stats.midSessionFails, 0, 'no mid-session failures on the happy path');

  console.log('  ✓ real dial -> 200 via the live worker');
  console.log('  ✓ exclusive lease holds the second caller until the first releases');
  console.log(`  ✓ two ~500ms jobs serialized end-to-end (${elapsed}ms)`);
  console.log('\nROUTER INTEGRATION OK');
  worker.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); try { worker.kill('SIGKILL'); } catch {} process.exit(1); });
