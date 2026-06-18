#!/usr/bin/env bash
# demo.sh — the only thing you type on stage. act1/act2 PAUSE for you to press ENTER
# before each key transition, so you control the timing live (nothing auto-advances).
#   ./demo.sh prep         deploy everything, build the ConfigMap, pre-warm the router
#   ./demo.sh act1         ACT 1: clear the pool, fire a HELD request -> [ENTER] -> scale 0->1
#   ./demo.sh watch        run in a 2nd pane: live availability (free/busy/queued) from /statusz
#   ./demo.sh act2         ACT 2: bring up a steady pool -> [ENTER] -> 90s graceful churn
#   ./demo.sh all          run ACT 1 then ACT 2 back-to-back (still ENTER-gated between steps)
#   ./demo.sh killbrowser  kill one browser mid-load -> ONE honest failure (no resume)
#   ./demo.sh kill         kill the router pod (the watcher) -> relist + recover in seconds
#   ./demo.sh reset        back to a steady pool between rehearsals
#   ./demo.sh dashboard    open the Kubernetes dashboard (debug: inspect / delete pods)
#   ./demo.sh nuke         delete the namespace
set -euo pipefail
cd "$(dirname "$0")/.."
NS=bf-demo
BASE=6                      # steady pool size for Act 2
# Router entry point. The docker-driver minikube (Mac/Win) can't route the NodePort IP
# from the host, so we default to a `kubectl port-forward` on localhost:30081 (see README).
# Routable setup? Override:  ROUTER_URL="http://$(minikube ip):30081" ./scripts/demo.sh ...
url() { echo "${ROUTER_URL:-http://localhost:30081}"; }

# Pause until the presenter hits ENTER — you drive the timing, nothing auto-advances.
pause() { printf '\n>>> %s ' "${1:-Press ENTER to continue}"; read -r _ || true; }

# Act 1 must open on an EMPTY pool (so the first request is HELD, not served instantly).
# If a previous run/rehearsal left browsers around, scale to 0 and clear them first.
ensure_empty() {
  local n i
  n=$(kubectl -n $NS get pods -l app=browser --no-headers 2>/dev/null | wc -l | tr -d ' ') || n=0
  if [ "${n:-0}" -gt 0 ]; then
    echo ">>> pool is NOT empty (${n} browser pod(s)) — clearing it so Act 1 opens empty ..."
    kubectl -n $NS scale deploy worker --replicas=0 >/dev/null
    kubectl -n $NS delete pod -l app=browser --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true
    for i in $(seq 1 30); do
      n=$(kubectl -n $NS get pods -l app=browser --no-headers 2>/dev/null | wc -l | tr -d ' ') || n=0
      [ "${n:-0}" -eq 0 ] && break
      sleep 1
    done
    echo ">>> pool is now EMPTY."
  else
    echo ">>> pool already EMPTY."
  fi
}

act1() {
  local U; U="$(url)"
  ensure_empty
  echo ">>> ACT 1: the pool is EMPTY. Firing one request — it is HELD, not rejected."
  ( SECONDS=0
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 150 "$U/scrape" || echo ERR)
    echo ""
    if [ "$code" = "200" ]; then
      echo ">>> request RETURNED after ${SECONDS}s (HTTP 200) — it landed on the browser that just appeared."
    else
      echo ">>> request FAILED after ${SECONDS}s (HTTP ${code}) — NOT served."
      echo ">>> the router log has the real cause (LEASE / MID-SESSION-FAIL / HOLD-TIMEOUT), trust it over this line:"
      echo ">>>   kubectl -n $NS logs deploy/demo-router | tail"
      echo ">>> if you haven't yet, run './scripts/demo.sh prep' first (reloads manifest env + resets counters)."
    fi
  ) &
  HELD=$!
  sleep 1   # let the request register as queued=1 on the watch pane
  pause "watch pane shows queued=1 (HELD). Press ENTER to scale the pool 0 -> 1"
  echo ">>> scaling the pool 0 -> 1 ..."
  kubectl -n $NS scale deploy worker --replicas=1
  wait $HELD || true
  echo ">>> availability flipped 0 -> 1 live. That flip is the whole talk."
}

act2() {
  echo ">>> ACT 2: bringing up a steady pool of ${BASE}; the 90s GRACEFUL churn starts after you press ENTER."
  echo ">>> loadgen should already be running:  node loadgen.js $(url)/scrape 0.5"
  kubectl -n $NS scale deploy worker --replicas=$BASE >/dev/null
  kubectl -n $NS rollout status deploy/worker --timeout=120s
  pause "Steady pool of ${BASE} is up (watch pane settling). Press ENTER to start the 90s churn storm"
  ./scripts/churn-demo.sh 90 25 4 8
  echo ">>> graceful churn was invisible (ok% held; requeues may tick from brief stale windows)."
  echo ">>> the real loss comes from an ABRUPT kill ->  ./scripts/demo.sh killbrowser"
}

case "${1:-}" in
  prep)
    kubectl apply -f manifests/demo.yaml
    kubectl -n $NS delete cm demo-app --ignore-not-found
    kubectl -n $NS create cm demo-app \
      --from-file=router.js=./router.js \
      --from-file=worker.js=./worker.js
    kubectl -n $NS rollout restart deploy/demo-router
    kubectl -n $NS rollout status deploy/demo-router --timeout=180s
    kubectl -n $NS scale deploy worker --replicas=0
    echo ""
    echo "PRE-WARM OK. Router restarted — lease/requeue counters reset to 0; manifest env (re)loaded."
    echo "  scrape : $(url)/scrape"
    echo "  status : $(url)/statusz"
    echo "Pool starts EMPTY (0 browsers) — ready for Act 1."
    ;;

  act1) act1 ;;

  watch)
    exec node scripts/watch.js "$(url)/statusz"
    ;;

  act2) act2 ;;

  all)
    act1
    pause "Act 1 done (pool = 1 browser). Start the loadgen in your load pane, then press ENTER to run Act 2"
    act2
    ;;

  killbrowser)
    # Target a browser that is actually mid-session (leased right now), then ABRUPT-kill it
    # (SIGKILL, like a spot reclaim) so the in-flight session is genuinely lost — deterministic.
    BUSY_IP=$(curl -s --max-time 2 "$(url)/statusz" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).busyIps||[])[0]||"")}catch{console.log("")}})')
    if [ -z "${BUSY_IP:-}" ]; then
      echo "no browser is mid-session right now — is the loadgen running? give it a second and retry."
      exit 0
    fi
    POD=$(kubectl -n $NS get pods -l app=browser -o jsonpath="{range .items[?(@.status.podIP==\"$BUSY_IP\")]}{.metadata.name}{end}")
    if [ -z "${POD:-}" ]; then echo "busy IP $BUSY_IP not mapped to a pod yet (watch lag) — retry."; exit 0; fi
    echo ">>> ABRUPT kill (spot-style, SIGKILL) of a BUSY browser: $POD ($BUSY_IP)"
    kubectl -n $NS delete pod "$POD" --grace-period=0 --force
    echo ">>> that session is GONE — one 502, midSessionFails ticks. No resume; the job retries fresh upstream. Blast radius = one."
    ;;

  kill)
    echo ">>> killing the ROUTER pod (the watcher) mid-load"
    kubectl -n $NS delete pod -l app=demo-router --wait=false
    echo ">>> it relists EndpointSlices on restart and recovers in seconds. Already-dialed sessions are direct pod-to-pod, untouched."
    ;;

  reset)
    kubectl -n $NS scale deploy worker --replicas=$BASE
    kubectl -n $NS rollout status deploy/worker --timeout=120s
    echo "reset done (pool=${BASE})."
    ;;

  dashboard)
    echo ">>> opening the Kubernetes dashboard (Ctrl-C to stop the proxy). Namespace '$NS' — inspect or delete pods there."
    minikube dashboard
    ;;

  nuke)
    kubectl delete ns $NS --ignore-not-found
    ;;

  *)
    grep '^#   ' "$0" | sed 's/^#   //'
    ;;
esac
