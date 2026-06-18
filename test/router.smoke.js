// router.smoke.js — off-cluster behavior test for the lease engine.
// Verifies the three claims the demo makes, with a controllable fake dial:
//   1) HOLD:        a request into an empty pool is held, then lands when a browser appears.
//   2) STALE:       a pre-dial (never-connected) failure is re-queued INVISIBLY (request still ok).
//   3) MID-SESSION: a browser that dies after connecting FAILS that one request (no resume).
// Run: node test/router.smoke.js   (exits non-zero on any failed assertion)
'use strict';
const assert = require('assert');
const { createEngine } = require('../router.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// dial behavior is per-ip and controllable
const behavior = new Map();
function dial(ip) {
  const fn = behavior.get(ip);
  if (!fn) return Promise.reject({ retryable: true, reason: 'no-behavior(stale)' });
  return fn();
}
const ok = () => Promise.resolve({ status: 200 });
const stale = () => Promise.reject({ retryable: true, reason: 'stale/never-connected' });
const midSession = () => Promise.reject({ retryable: false, reason: 'died mid-session' });

let passed = 0;
function pass(name) { passed++; console.log(`  ✓ ${name}`); }

(async function run() {
  const engine = createEngine({ dial, log: () => {} });

  // ---- 1) HOLD then land ----
  let landedIp = null, settled = false;
  const held = engine.handle().then((r) => { settled = true; landedIp = r.ip; });
  await sleep(20);
  assert.strictEqual(engine.counts().queued, 1, 'request should be HELD (queued=1) on empty pool');
  assert.strictEqual(settled, false, 'held request must not resolve while pool is empty');
  pass('empty pool -> request is held, not rejected');

  behavior.set('10.0.0.1', ok);
  engine._add('10.0.0.1');               // a browser appears (watch event)
  await held;
  assert.strictEqual(landedIp, '10.0.0.1', 'held request should land on the new browser');
  assert.strictEqual(engine.counts().queued, 0, 'queue should drain after landing');
  pass('browser appears -> held request lands on it (0->1 flip)');

  // ---- 2) STALE -> invisible re-queue ----
  const e2 = createEngine({ dial, log: () => {} });
  behavior.set('10.0.0.A', stale);       // first pick is a stale endpoint
  behavior.set('10.0.0.B', ok);          // healthy fallback
  e2._add('10.0.0.A');
  e2._add('10.0.0.B');
  const r2 = await e2.handle();
  assert.strictEqual(r2.ip, '10.0.0.B', 'stale endpoint should be skipped, request served by B');
  assert.ok(e2.stats.requeues >= 1, 'a stale pre-dial failure must count as a re-queue');
  assert.strictEqual(e2.stats.midSessionFails, 0, 'a stale failure must NOT be a mid-session fail');
  pass('stale endpoint -> re-queued invisibly to a healthy browser (client sees success)');

  // ---- 3) MID-SESSION -> honest failure, no resume ----
  const e3 = createEngine({ dial, log: () => {} });
  behavior.set('10.0.0.C', midSession);  // connects, then dies mid-job
  e3._add('10.0.0.C');
  let rejected = false, code = null;
  await e3.handle().then(() => {}).catch((err) => { rejected = true; code = err.code; });
  assert.strictEqual(rejected, true, 'mid-session death must FAIL the request (no resume)');
  assert.strictEqual(code, 502, 'mid-session failure should surface as 502');
  assert.ok(e3.stats.midSessionFails >= 1, 'mid-session fail must be counted');
  assert.strictEqual(e3.stats.requeues, 0, 'mid-session failure must NOT be re-queued');
  pass('mid-session death -> one honest failure, not re-queued, not resumed');

  // ---- 4) busyIps exposes the in-flight lease (so killbrowser can target it) ----
  const e4 = createEngine({ dial: () => new Promise(() => {}), log: () => {} }); // dial never settles
  e4._add('10.0.0.9');
  e4.handle();                            // leases 10.0.0.9; dial pending -> the browser stays busy
  await sleep(10);
  assert.deepStrictEqual(e4.busyIps(), ['10.0.0.9'], 'busyIps should list the in-flight (leased) browser');
  assert.strictEqual(e4.counts().busy, 1, 'busy count should be 1 during an in-flight lease');
  pass('busyIps exposes the in-flight browser for a targeted kill');

  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
