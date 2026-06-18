# kubecon-endpointslice-demo

**The live demo from the talk _"Why We Ditched Kube-proxy: Scaling 10M Daily Browser Sessions with Kubernetes EndpointSlices"_ — KubeCon + CloudNativeCon India 2026.**

A tiny, **zero-dependency** request router that **holds** an incoming request until a browser pod is free, **leases** exactly one browser to it, and **dials that pod's IP directly** — bypassing the `ClusterIP` Service / kube-proxy path. It watches the **same `EndpointSlice` API kube-proxy reads**; it just does something a Service can't: hold, and lease one.

Everything runs on Minikube, fully offline — the router and the fake "browser" are mounted into a stock `node:20-alpine` image from a ConfigMap, so there's no image to build and no `npm install`. It is the *same* `watch → free-pool → lease → direct-dial` design used in production, shrunk to a laptop.

> This is a teaching artifact, not production code — it exists to make one routing *requirement* visible on screen. It leases; it does not load-balance.

## The requirement (why a Service is the wrong shape)

Dispatching a browser scrape is **not** load-balancing across interchangeable replicas:

- **Exclusive** — one job per browser at a time. A browser mid-session is not a shared backend; it must never get a second caller.
- **Held** — if no browser is free, the incoming connection *waits* until one is (we start more), rather than failing or being sprayed across whichever pods happen to be ready.

A `ClusterIP` Service answers *now or never* and spreads connections across every ready endpoint. It can express neither "wait until one is free" nor "give this one caller exactly one browser, untouchable until the job is done." So we consume the EndpointSlice API ourselves and do the routing on top of it.

## What the demo shows

**Act 1 — held until free.** The pool starts empty. One request comes in and the connection *hangs* — held, not rejected (`queued=1`). A browser pod scales up; the moment it passes readiness, the held request is leased to that exact pod and dialed directly. Availability flips `0 → 1`, live.

**Act 2 — survive churn.** A steady pool under constant pod churn:

- **Stale endpoint → invisible.** The watch is always a half-step behind, so the router sometimes dials a pod that's already gone. The dial fails *before any session starts*, so the pod is set aside and the request re-queues to another free browser. The client sees nothing (`requeues` ticks; `ok%` holds).
- **Mid-session death → one honest failure.** Kill a browser that's leased and mid-job, and that one request **fails** — a live browser holds navigation, cookies, an open DevTools session, so its work can't be handed to a blank browser. Blast radius of exactly one; the job is retried from scratch upstream. **There is no resume, and the demo doesn't fake one.**
- **Watcher self-heal.** Kill the router itself and it relists EndpointSlices and recovers in seconds. Sessions already dialed are direct pod-to-pod, so they keep running — the watcher was never in their data path.

## Architecture

```
   GET /scrape     ┌──────────────────────────────────────────────┐
  ───────────────▶ │  router.js   (the only long-lived pod)        │
                   │  • watches EndpointSlices (raw Kubernetes API)│
                   │  • in-memory free-pool + FIFO hold-queue      │
                   │  • free?  lease ONE + dial POD_IP directly    │
                   │  • none?  HOLD the connection until one frees │
                   └───────┬──────────────────────────────────────┘
                           │  dials pod IP :8080  (direct — no Service in the path)
                           ▼
          ┌────────────┐ ┌────────────┐ ┌────────────┐
          │ worker pod │ │ worker pod │ │ worker pod │   "browsers" (fake headless Chrome)
          └────────────┘ └────────────┘ └────────────┘
                 ▲ a headless Service publishes these pods' EndpointSlices —
                   the only thing the router watches
```

## Prerequisites

- Minikube + kubectl
- Node 18+ on the host (only for the `loadgen.js` / `watch.js` display panes and the tests)
- The single image `node:20-alpine` (pre-pull it for offline use)

## Quick start

```bash
# one-time
minikube start --cpus=4 --memory=4096
minikube image pull node:20-alpine          # offline hardening
chmod +x scripts/*.sh
./scripts/demo.sh prep                       # deploy; build the ConfigMap; pool starts EMPTY

# docker-driver (Mac/Windows): the NodePort IP isn't host-routable, so port-forward
# in its own terminal and leave it running for the whole demo:
kubectl -n bf-demo port-forward svc/demo-router 30081:8081

# pane 2 — live availability: free · busy · queued + counters
./scripts/demo.sh watch

# ACT 1 — clears the pool, fires the held request, then ENTER to scale 0 -> 1
./scripts/demo.sh act1

# ACT 2 — start the load pane first, then drive churn
node loadgen.js http://localhost:30081/scrape 0.5 "browser-farm"
./scripts/demo.sh act2          # steady pool, then press ENTER to start 90s graceful churn
./scripts/demo.sh killbrowser   # abrupt kill of a BUSY browser -> ONE failure, no resume
./scripts/demo.sh kill          # kill the router -> relists + recovers in seconds

# shortcut — Act 1 then Act 2 back-to-back (clears the pool first; still ENTER-gated between steps):
./scripts/demo.sh all

./scripts/demo.sh reset         # back to a steady pool
./scripts/demo.sh nuke          # delete the namespace
```

On Linux (or any driver whose node IP routes from the host), skip the port-forward and run the scripts with `ROUTER_URL="http://$(minikube ip):30081"`.

## Router HTTP API

| Route | Purpose |
|---|---|
| `GET /scrape` | Lease a free browser and dial it — or **hold** the connection until one is free. |
| `GET /statusz` | JSON: `{ total, ready, busy, free, queued, leases, requeues, midSessionFails, ... }` — drives the watch pane. |
| `GET /healthz` | `200` once the initial EndpointSlice list completes (readiness = "the router is watching"). |

## Configuration

**Router** (`router.js`)

| Env | Default | Meaning |
|---|---|---|
| `SERVICE_NAME` | — | headless Service whose EndpointSlices to watch (**required**) |
| `NAMESPACE` | service-account namespace | namespace to watch |
| `TARGET_PORT` | `8080` | port to dial on each pod |
| `SETASIDE_MS` | `3000` | how long a stale pod is benched after a failed dial |
| `MAX_HOLD_MS` | `30000` | how long a caller is held before `503` |
| `DIAL_TIMEOUT_MS` | `30000` | end-to-end dial budget (a socket-idle timeout) — **must exceed the worker's longest job** (a healthy render is idle on the wire until it finishes), or a slow-but-healthy render is misread as a mid-session death |

**Worker** (`worker.js`)

| Env | Default | Meaning |
|---|---|---|
| `LATENCY_MIN_MS` | `0` | floor — a job never completes faster than this |
| `LATENCY_MEDIAN_MS` | `120` | lognormal median "render" time |
| `READY_MS` | `0` | cold-start delay before `/healthz` returns 200 |
| `COLD_JOB_MS` | `0` | if `>0`, the first jobs after Ready fail briefly ("ready ≠ warm") |

The manifest sets a 10-second floor (`LATENCY_MIN_MS=10000`), so each job runs ~10–13s — long enough to watch the busy window and to land a mid-session kill. Throughput is then roughly `pool ÷ job-seconds` (a 6-pod pool ≈ 0.5 req/s), which is why Act 2's loadgen runs at ~0.5 QPS; raise `BASE` (the pool size) or the rate for busier traffic.

## The failure model (the honest part)

The router distinguishes two failures that look alike but aren't:

- **Pre-session** (stale endpoint, or the worker replied `503`/`409`): never connected, no session existed yet → set the pod aside briefly and **re-queue the request** to another free browser. Invisible to the client.
- **Mid-session** (connected, then the browser died): the in-flight job **fails** (`502`). It is *not* re-queued and *not* resumed — a fresh blank browser is useless to a half-finished session. The upstream layer retries it as a brand-new session. Blast radius: one.

This distinction is the entire point of the demo, and it's enforced in code — see `realDial()` in `router.js` and the assertions in `test/`.

## How this maps to production

In production, one informer runs per browser pool (one pool per Chrome version), each backed by its own headless Service, with a session service choosing the pool per request. The demo collapses that to a **single pool** for clarity — the primitives (`watch → free-pool → hold → exclusive lease → direct dial`) are identical.

## Tests

```bash
npm test
```

- `test/router.smoke.js` — the lease engine off-cluster (hold, stale re-queue, mid-session failure, busy-IP targeting) with an injected dial.
- `test/worker-drain.smoke.js` — the worker's graceful-drain contract: a planned shutdown finishes the in-flight job, refuses new work, then exits.
- `test/router-integration.smoke.js` — the **real** dial path against a live worker: a lease returns 200, and an exclusive lease holds a second caller until the first releases.

## Project layout

```
router.js               the hold + lease + free-pool router (zero dependencies)
worker.js               a fake headless "browser" (latency, exclusivity, graceful drain)
loadgen.js              stage-friendly load display (ok% / p50 / p99, one line per second)
scripts/demo.sh         the driver: prep | act1 | watch | act2 | all | killbrowser | kill | reset | dashboard | nuke
scripts/watch.js        availability pane (polls /statusz)
scripts/churn-demo.sh   laptop-sized graceful-churn generator
manifests/demo.yaml     namespace, RBAC, headless Service, worker + router Deployments, NodePort
test/                   smoke + integration tests (no external deps)
```

## License

MIT — see [LICENSE](LICENSE).
