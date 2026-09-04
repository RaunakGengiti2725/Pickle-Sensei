#!/usr/bin/env bash
# Boundary / malformed-input stress campaign for the free-rating ledger unit
# (free_rating_ledger + lifetime/identity_scored_count + record/inherit ledger
# triggers + reject_ledger_mutation + the scored-shot write gate), driven
# through the real database boundary: public.apply_synced_shot(jsonb),
# public.reserve_analysis_permit(text), direct table access from the
# anon / authenticated / service_role roles, and auth.identities churn.
#
# Disposable Postgres only (docker postgres:16). Never points at a hosted
# project. Applies supabase/tests/shim_auth.sql + every supabase/migrations/*.sql
# in lexical order, then supabase/tests/stress/boundary_malformed_ledger.sql.
#
#   STRESS_ITER      total seeds to run (default 60 — suite-sized; the campaign
#                    in the report used 3000+)
#   STRESS_WORKERS   parallel psql sessions (default 4; READ COMMITTED)
#   STRESS_SEED_BASE first seed (default 1); seed = base + i, i in [0, ITER)
#   STRESS_SEEDS     comma-separated explicit seeds to replay (overrides ITER)
#   STRESS_REPEAT    run every seed this many times (flake rate; default 1)
#   STRESS_POOL_FREE / STRESS_POOL_PREMIUM   users in the pool (default 6 / 4)
#   STRESS_OUT       artifact dir (default artifacts/stress/boundary-malformed/<ts>)
#   STRESS_STRICT    1 → COLLISION verdicts also fail the run (default: only
#                    BROKEN / HARNESS_ERROR / final-invariant failures fail)
#   STRESS_KEEP      1 → leave the container running for manual psql repro
#   STRESS_PG_IMAGE  default postgres:16
#
# Replay one seed by hand (after the run, with STRESS_KEEP=1):
#   docker exec -i <container> psql -U postgres -X -c \
#     "select * from stress_bm.run_one(<seed>, 0, 0)"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STRESS_ITER="${STRESS_ITER:-60}"
STRESS_WORKERS="${STRESS_WORKERS:-4}"
STRESS_SEED_BASE="${STRESS_SEED_BASE:-1}"
STRESS_SEEDS="${STRESS_SEEDS:-}"
STRESS_REPEAT="${STRESS_REPEAT:-1}"
STRESS_POOL_FREE="${STRESS_POOL_FREE:-6}"
STRESS_POOL_PREMIUM="${STRESS_POOL_PREMIUM:-4}"
STRESS_STRICT="${STRESS_STRICT:-0}"
STRESS_KEEP="${STRESS_KEEP:-0}"
STRESS_PG_IMAGE="${STRESS_PG_IMAGE:-postgres:16}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STRESS_OUT="${STRESS_OUT:-$ROOT/artifacts/stress/boundary-malformed/$RUN_ID}"
mkdir -p "$STRESS_OUT"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

CONTAINER="stress_bm_$$"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$STRESS_PG_IMAGE" -c max_connections=64 -c log_min_messages=warning >/dev/null
cleanup() {
  if [[ "$STRESS_KEEP" == "1" ]]; then
    echo "container kept: $CONTAINER (docker rm -f $CONTAINER to dispose)"
  else
    if ! docker rm -f "$CONTAINER" >/dev/null 2>&1; then
      echo "[stress] warning: could not remove container $CONTAINER" >&2
    fi
  fi
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres -q

PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1)

echo "[stress] applying shim + migrations" | tee "$STRESS_OUT/run.log"
"${PSQL[@]}" <"$ROOT/supabase/tests/shim_auth.sql" >>"$STRESS_OUT/run.log" 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  "${PSQL[@]}" <"$f" >>"$STRESS_OUT/run.log" 2>&1 || { echo "migration failed: $f" >&2; exit 1; }
done
"${PSQL[@]}" <"$ROOT/supabase/tests/stress/boundary_malformed_ledger.sql" >>"$STRESS_OUT/run.log" 2>&1
"${PSQL[@]}" -c "select stress_bm.setup($STRESS_POOL_FREE, $STRESS_POOL_PREMIUM)" >>"$STRESS_OUT/run.log" 2>&1

# Seed list → one SQL file per worker; each statement is its own transaction
# (autocommit, READ COMMITTED) so workers interleave on the shared pool users.
if [[ -n "$STRESS_SEEDS" ]]; then
  mapfile -t SEEDS < <(tr ',' '\n' <<<"$STRESS_SEEDS" | sed '/^$/d')
else
  mapfile -t SEEDS < <(seq "$STRESS_SEED_BASE" $((STRESS_SEED_BASE + STRESS_ITER - 1)))
fi
for w in $(seq 0 $((STRESS_WORKERS - 1))); do : >"$STRESS_OUT/worker_$w.sql"; done
i=0
for rep in $(seq 1 "$STRESS_REPEAT"); do
  for s in "${SEEDS[@]}"; do
    w=$((i % STRESS_WORKERS))
    if [[ "$STRESS_REPEAT" == "1" ]]; then
      echo "select stress_bm.run_one($s, $w, $i);" >>"$STRESS_OUT/worker_$w.sql"
    else
      # repeated runs: record under a derived key so every attempt is kept
      echo "select stress_bm.run_one_repeat($s, $rep, $w, $i);" >>"$STRESS_OUT/worker_$w.sql"
    fi
    i=$((i + 1))
  done
done
TOTAL=$i
echo "[stress] running $TOTAL iterations on $STRESS_WORKERS workers (pool free=$STRESS_POOL_FREE premium=$STRESS_POOL_PREMIUM)" | tee -a "$STRESS_OUT/run.log"
START=$(date +%s)
pids=()
for w in $(seq 0 $((STRESS_WORKERS - 1))); do
  # a worker with no seeds (ITER < WORKERS) is skipped: `docker exec -i` fed an
  # empty file does not reliably see EOF and would hang the run
  [[ -s "$STRESS_OUT/worker_$w.sql" ]] || continue
  docker exec -i "$CONTAINER" psql -U postgres -X -q -o /dev/null -v ON_ERROR_STOP=1 \
    <"$STRESS_OUT/worker_$w.sql" >"$STRESS_OUT/worker_$w.log" 2>&1 &
  pids+=($!)
done
WORKER_FAIL=0
for p in "${pids[@]}"; do wait "$p" || WORKER_FAIL=1; done
ELAPSED=$(( $(date +%s) - START ))
echo "[stress] workers done in ${ELAPSED}s (worker_fail=$WORKER_FAIL)" | tee -a "$STRESS_OUT/run.log"

# ── exports ──────────────────────────────────────────────────────────────────
# psql -At prints the json text verbatim (COPY text would escape backslashes)
"${PSQL[@]}" -At -c "select row_to_json(r)::text from stress_bm.results r order by seed" >"$STRESS_OUT/results.jsonl"
"${PSQL[@]}" -At -c "select stress_bm.report()" >"$STRESS_OUT/report.json"
"${PSQL[@]}" -At -c "select coalesce(jsonb_agg(row_to_json(f)), '[]'::jsonb) from stress_bm.final_invariants() f" >"$STRESS_OUT/invariants.json"
"${PSQL[@]}" -At -c "copy (select seed, category, subcategory, user_key, mode, verdict, status, sqlstate, left(sqlmsg, 200) as sqlmsg, deltas, note, left(payload, 400) as payload_head, payload_len from stress_bm.results where verdict not in ('HELD') order by seed) to stdout with (format csv, header)" >"$STRESS_OUT/non_held.csv"

EXECUTED=$("${PSQL[@]}" -At -c "select count(*) from stress_bm.results")
BROKEN=$("${PSQL[@]}" -At -c "select count(*) from stress_bm.results where verdict like 'BROKEN%'")
HARNESS_ERR=$("${PSQL[@]}" -At -c "select count(*) from stress_bm.results where verdict like 'HARNESS_ERROR%'")
COLLISION=$("${PSQL[@]}" -At -c "select count(*) from stress_bm.results where verdict like 'COLLISION%'")
RAISED=$("${PSQL[@]}" -At -c "select count(*) from stress_bm.results where verdict like 'RAISED%'")
HELD=$("${PSQL[@]}" -At -c "select count(*) from stress_bm.results where verdict = 'HELD'")
INV_FAIL=$("${PSQL[@]}" -At -c "select count(*) from stress_bm.final_invariants() where not ok")

cat >"$STRESS_OUT/summary.json" <<EOF
{
  "run_id": "$RUN_ID",
  "requested": $TOTAL,
  "executed": $EXECUTED,
  "workers": $STRESS_WORKERS,
  "seed_base": $STRESS_SEED_BASE,
  "repeat": $STRESS_REPEAT,
  "pool_free": $STRESS_POOL_FREE,
  "pool_premium": $STRESS_POOL_PREMIUM,
  "elapsed_s": $ELAPSED,
  "held": $HELD,
  "raised": $RAISED,
  "collision": $COLLISION,
  "broken": $BROKEN,
  "harness_error": $HARNESS_ERR,
  "worker_fail": $WORKER_FAIL,
  "invariant_failures": $INV_FAIL,
  "strict": $STRESS_STRICT
}
EOF
echo "[stress] executed=$EXECUTED held=$HELD raised=$RAISED collision=$COLLISION broken=$BROKEN harness_error=$HARNESS_ERR invariant_failures=$INV_FAIL" | tee -a "$STRESS_OUT/run.log"
echo "[stress] artifacts: $STRESS_OUT"

FAIL=0
[[ "$EXECUTED" == "$TOTAL" ]] || FAIL=1
[[ "$WORKER_FAIL" == "0" ]] || FAIL=1
[[ "$BROKEN" == "0" ]] || FAIL=1
[[ "$HARNESS_ERR" == "0" ]] || FAIL=1
[[ "$INV_FAIL" == "0" ]] || FAIL=1
if [[ "$STRESS_STRICT" == "1" && "$COLLISION" != "0" ]]; then FAIL=1; fi
if [[ "$FAIL" != "0" ]]; then
  echo "[stress] FAIL — see $STRESS_OUT/non_held.csv and $STRESS_OUT/invariants.json" >&2
  exit 1
fi
echo "[stress] PASS"
