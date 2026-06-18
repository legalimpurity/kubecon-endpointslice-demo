// watch.js <statuszURL> — poll the router's /statusz and print one availability line
// every 1.5s, big and stable for the projector. This is the stage's "availability pane":
// free / busy / queued, plus running lease & re-queue counters.
'use strict';
const http = require('http');
const target = process.argv[2];
if (!target) { console.error('usage: node watch.js <statuszURL>'); process.exit(1); }
const u = new URL(target);
const pad = (n, v) => `${n}=${String(v).padStart(3)}`;

function poll() {
  const ts = new Date().toLocaleTimeString();
  const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: 1000 }, (res) => {
    let s = '';
    res.on('data', (d) => s += d);
    res.on('end', () => {
      try {
        const j = JSON.parse(s);
        console.log(`${ts}  ${pad('free', j.free)} ${pad('busy', j.busy)} ${pad('queued', j.queued)}  |  total=${j.total} leases=${j.leases} requeues=${j.requeues} midSessionFails=${j.midSessionFails}`);
      } catch { console.log(`${ts}  (bad response)`); }
    });
  });
  req.on('error', () => console.log(`${ts}  (router not answering)`));
  req.on('timeout', () => req.destroy());
}
setInterval(poll, 1500);
poll();
