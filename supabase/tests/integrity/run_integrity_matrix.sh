#!/usr/bin/env bash
# Data-integrity adversarial matrix for the Supabase schema.
#
#   ./supabase/tests/integrity/run_integrity_matrix.sh [--out DIR] [--scale-users N]
#
# Boots a throwaway postgres:16 container, installs the auth shim + the pg_cron
# stub, applies every migration in lexical order, runs integrity_matrix.sql
# (every FK / ON DELETE / nullability / unique / cascade / sweep / ledger
# case) and integrity_scale.sql (N users × full worlds → cascade delete
# timings, sweep timings, orphan scan), then exports raw evidence:
#
#   DIR/matrix.json            every case: statement, seed, outcome, guard, verdict
#   DIR/matrix.md              the same as a table
#   DIR/kv.json                catalog snapshots, cascade counts, cron jobs, grants
#   DIR/bad_states.json        allowed-but-bad rows (finding material)
#   DIR/scale.json             per-user cascade timings, sweep timings, heap sizes
#   DIR/scale_plans.txt        EXPLAIN (ANALYZE, BUFFERS) of the sweeps + a cascade
#   DIR/*.log                  raw psql logs, exit codes in DIR/exit_codes.txt
#
# Exit 0 iff migrations apply, the matrix has zero MISMATCH rows, and the scale
# stage leaves zero orphans. bad_state rows never fail the run — they are the
# report. Never touches a hosted project; never modifies migrations.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${ROOT}/artifacts/integrity/$(date -u +%Y%m%dT%H%M%SZ)"
SCALE_USERS=200
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --scale-users) SCALE_USERS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
CONTAINER="pickle-integrity-$$"
IMAGE="postgres:16"
: > "$OUT/exit_codes.txt"

log() { printf '[integrity] %s\n' "$*" | tee -a "$OUT/runner.log"; }
record() { printf '%s\t%s\n' "$1" "$2" >> "$OUT/exit_codes.txt"; }
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  log "docker is required"; exit 3
fi

log "revision: $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
log "starting $IMAGE as $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" -c shared_buffers=256MB -c fsync=off -c synchronous_commit=off -c log_min_messages=warning >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || { log "postgres did not start"; exit 3; }
docker exec "$CONTAINER" psql -U postgres -tAc 'select version()' | tee -a "$OUT/runner.log"

docker cp "$ROOT/supabase/tests" "$CONTAINER:/tests" >/dev/null
docker cp "$ROOT/supabase/migrations" "$CONTAINER:/migrations" >/dev/null

PSQL=(docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q)

log "applying shim_auth.sql + integrity/cron_stub.sql"
"${PSQL[@]}" -f /tests/shim_auth.sql > "$OUT/00_shim.log" 2>&1; rc=$?; record shim_auth "$rc"
[ $rc -eq 0 ] || { log "shim failed (see 00_shim.log)"; exit 1; }
"${PSQL[@]}" -f /tests/integrity/cron_stub.sql > "$OUT/01_cron_stub.log" 2>&1; rc=$?; record cron_stub "$rc"
[ $rc -eq 0 ] || { log "cron stub failed (see 01_cron_stub.log)"; exit 1; }

log "applying migrations"
: > "$OUT/02_migrations.log"
mig_rc=0
for f in $(docker exec "$CONTAINER" sh -c 'ls /migrations/*.sql | sort'); do
  printf '\n===== %s =====\n' "$f" >> "$OUT/02_migrations.log"
  "${PSQL[@]}" -f "$f" >> "$OUT/02_migrations.log" 2>&1; rc=$?
  [ $rc -eq 0 ] || { mig_rc=$rc; log "migration failed: $f (rc=$rc)"; break; }
done
record migrations "$mig_rc"
[ $mig_rc -eq 0 ] || exit 1

log "running integrity_matrix.sql"
"${PSQL[@]}" -f /tests/integrity/integrity_matrix.sql > "$OUT/10_matrix.log" 2>&1; rc=$?; record matrix_sql "$rc"
if [ $rc -ne 0 ]; then
  # The matrix is one transaction: an abort rolls every case back, so there is
  # nothing trustworthy to export or to build the scale stage on.
  log "matrix aborted (rc=$rc) — see 10_matrix.log"; tail -n 20 "$OUT/10_matrix.log"
  record final 1
  exit 1
fi
matrix_rc=$rc

log "exporting matrix artifacts"
docker exec "$CONTAINER" psql -U postgres -X -tA -c \
  "select coalesce(jsonb_pretty(jsonb_agg(to_jsonb(r) order by r.seq)), '[]') from it.results r" > "$OUT/matrix.json"
docker exec "$CONTAINER" psql -U postgres -X -tA -c \
  "select coalesce(jsonb_pretty(jsonb_object_agg(k, v)), '{}') from it.kv" > "$OUT/kv.json"
docker exec "$CONTAINER" psql -U postgres -X -tA -c \
  "select coalesce(jsonb_pretty(jsonb_agg(to_jsonb(r) order by r.seq)), '[]') from it.results r where r.bad_state" > "$OUT/bad_states.json"
docker exec "$CONTAINER" psql -U postgres -X -c "
  select seq, section, case_id, outcome, coalesce(returned, '') as returned, coalesce(sqlstate, '') as sqlstate,
         left(coalesce(constraint_name, ''), 40) as constraint_name, expected, verdict, bad_state
  from it.results order by seq" > "$OUT/matrix.md"
docker exec "$CONTAINER" psql -U postgres -X -tA -c "
  select format('cases=%s match=%s mismatch=%s bad_state=%s',
    count(*), count(*) filter (where verdict = 'match'), count(*) filter (where verdict = 'MISMATCH'),
    count(*) filter (where bad_state)) from it.results" | tee -a "$OUT/runner.log"
docker exec "$CONTAINER" psql -U postgres -X -c "
  select section, count(*) as cases, count(*) filter (where verdict = 'MISMATCH') as mismatch,
         count(*) filter (where bad_state) as bad_state
  from it.results group by section order by section" | tee -a "$OUT/runner.log"

docker exec "$CONTAINER" psql -U postgres -X -v ON_ERROR_STOP=1 -tA -c "select it.fail_if_mismatch()" > "$OUT/11_verdict.log" 2>&1
rc=$?; record matrix_verdict "$rc"
if [ "$rc" -eq 0 ]; then
  log "matrix verdict: no MISMATCH"
else
  log "matrix verdict: MISMATCH rows present"
  cat "$OUT/11_verdict.log"
fi
verdict_rc=$rc

log "running integrity_scale.sql (users=$SCALE_USERS)"
"${PSQL[@]}" -v scale_users="$SCALE_USERS" -f /tests/integrity/integrity_scale.sql > "$OUT/20_scale.log" 2>&1; rc=$?; record scale_sql "$rc"
[ $rc -eq 0 ] || { log "scale stage failed (rc=$rc) — see 20_scale.log"; tail -n 20 "$OUT/20_scale.log"; }
scale_rc=$rc
docker exec "$CONTAINER" psql -U postgres -X -tA -c \
  "select coalesce(jsonb_pretty(jsonb_object_agg(k, v)), '{}') from it.scale" > "$OUT/scale.json" 2>/dev/null
docker exec "$CONTAINER" psql -U postgres -X -tA -c \
  "select string_agg(v, E'\n\n' order by k) from it.scale_plans" > "$OUT/scale_plans.txt" 2>/dev/null
docker exec "$CONTAINER" psql -U postgres -X -tA -c \
  "select v ->> 'summary' from it.scale where k = 'summary'" 2>/dev/null | tee -a "$OUT/runner.log"

log "artifacts: $OUT"
tee -a "$OUT/runner.log" < "$OUT/exit_codes.txt"

final=0
[ $matrix_rc -eq 0 ] || final=1
[ $verdict_rc -eq 0 ] || final=1
[ $scale_rc -eq 0 ] || final=1
record final "$final"
exit $final
