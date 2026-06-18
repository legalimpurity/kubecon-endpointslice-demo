#!/usr/bin/env bash
# churn-demo.sh [DURATION_S] [KILL_PCT] [SCALE_DELTA] [INTERVAL_S]
# Laptop-sized churn: each cycle kill KILL_PCT% of browsers + flip scale ±DELTA.
# These are GRACEFUL deletes (SIGTERM), so a busy worker drains its in-flight job before
# exiting -> the client sees nothing. This is "planned churn." (Abrupt spot-style loss is
# shown separately via `demo.sh killbrowser`.)
set -euo pipefail
NS=bf-demo
DURATION=${1:-90}; KILL=${2:-25}; DELTA=${3:-4}; INT=${4:-8}
BASE=$(kubectl -n $NS get deploy worker -o jsonpath='{.spec.replicas}')
END=$((SECONDS + DURATION)); CYCLE=0
echo "churn: ${DURATION}s · kill ${KILL}%/cycle · scale ±${DELTA} · every ${INT}s (base=$BASE)"
while [ $SECONDS -lt $END ]; do
  CYCLE=$((CYCLE+1))
  TOTAL=$(kubectl -n $NS get pods -l app=browser --no-headers 2>/dev/null | wc -l | tr -d ' ')
  K=$((TOTAL * KILL / 100))
  if [ "$K" -gt 0 ]; then
    # portable shuffle (macOS has no shuf): randomize, take K
    kubectl -n $NS get pods -l app=browser -o name --field-selector=status.phase=Running \
      | awk 'BEGIN{srand()}{print rand()"\t"$0}' | sort -n | cut -f2- | head -n "$K" \
      | while read -r pod; do kubectl -n $NS delete "$pod" --wait=false >/dev/null 2>&1 || true; done
  fi
  if [ $((CYCLE % 2)) -eq 1 ]; then
    kubectl -n $NS scale deploy worker --replicas=$((BASE + DELTA)) >/dev/null
  else
    kubectl -n $NS scale deploy worker --replicas="$BASE" >/dev/null
  fi
  echo "$(date +%T) cycle=$CYCLE killed=$K of $TOTAL"
  sleep "$INT"
done
kubectl -n $NS scale deploy worker --replicas="$BASE" >/dev/null
echo "churn done"
