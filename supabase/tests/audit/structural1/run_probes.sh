#!/usr/bin/env bash
# Structural audit probes (pass 1) for supabase/migrations.
#
# Each probes/*.sql file asserts an INVARIANT the schema is expected to hold.
# A probe that exits non-zero is a reproduced defect (finding); a probe that
# exits 0 is a verified invariant. Nothing here modifies production code or
# existing tests; the harness mirrors supabase/tests/run_rls_tests.sh
# (postgres:16 in Docker, tests/shim_auth.sql, every migration in lexical
# order).
#
# Usage: ./supabase/tests/audit/structural1/run_probes.sh [OUT_DIR] [probe-glob]
#   OUT_DIR defaults to artifacts/audit-structural1/<timestamp>.
#   Exit 0 = every probe held; exit 1 = at least one probe reproduced a defect.
#
# Probe header `-- @fresh`: run in a private container (the probe commits
# data or reads cumulative statistics, so it must not share state).
#
# Baseline 4d812e1a (2026-09-04): p01-p10 FAIL (reproduced defects, see the
# audit report), p11-p12 PASS (verified invariants). Local postgres:16 has no
# pg_cron, so p11 runs the sweep statements verbatim and reports the hosted
# schedule state as UNKNOWN.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$HERE/../../.." && pwd)"
REPO_ROOT="$(cd "$SUPABASE_DIR/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/artifacts/audit-structural1/$(date +%Y%m%dT%H%M%SZ)}"
PROBE_GLOB="${2:-*}"
mkdir -p "$OUT_DIR"

if ! docker info >/dev/null 2>&1; then
  echo "docker is required for the structural probes" >&2
  exit 2
fi

CONTAINERS=()
remove_container() {
  if ! docker rm -f "$1" >/dev/null 2>&1; then
    echo "warning: could not remove container $1" >&2
  fi
}
cleanup() {
  local c
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && remove_container "$c"
  done
}
trap cleanup EXIT

# boot_container NAME -> postgres:16 with shim + every migration applied.
# Boot output (including psql NOTICEs such as the pg_cron skip) is kept in
# OUT_DIR/boot-NAME.log.
boot_container() {
  local name="$1" bootlog="$OUT_DIR/boot-$1.log" ready=0 f base
  docker run -d --name "$name" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null || return 1
  CONTAINERS+=("$name")
  for _ in $(seq 1 60); do
    if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "postgres in $name did not become ready" >&2
    return 1
  fi
  docker cp "$SUPABASE_DIR/tests" "$name:/tests" >/dev/null || return 1
  docker cp "$SUPABASE_DIR/migrations" "$name:/migrations" >/dev/null || return 1
  docker cp "$HERE/probes" "$name:/probes" >/dev/null || return 1
  if ! docker exec "$name" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql >"$bootlog" 2>&1; then
    echo "shim_auth.sql failed while booting $name" >&2
    cat "$bootlog" >&2
    return 1
  fi
  for f in "$SUPABASE_DIR"/migrations/*.sql; do
    base="$(basename "$f")"
    echo "== $base" >>"$bootlog"
    if ! docker exec "$name" psql -U postgres -v ON_ERROR_STOP=1 -q -f "/migrations/$base" >>"$bootlog" 2>&1; then
      echo "migration $base failed while booting $name" >&2
      cat "$bootlog" >&2
      return 1
    fi
  done
}

SHARED="audit-s1-shared-$$"
boot_container "$SHARED" || exit 2

pass=0
fail=0
summary="$OUT_DIR/summary.tsv"
: >"$summary"

for probe in "$HERE"/probes/${PROBE_GLOB}.sql; do
  [ -e "$probe" ] || continue
  name="$(basename "$probe" .sql)"
  log="$OUT_DIR/$name.log"
  target="$SHARED"
  if grep -q '^-- @fresh' "$probe"; then
    target="audit-s1-$name-$$"
    if ! boot_container "$target"; then
      echo "ERROR  $name (container boot failed)" | tee -a "$summary"
      fail=$((fail + 1))
      continue
    fi
  fi
  if docker exec "$target" psql -U postgres -v ON_ERROR_STOP=1 -X -q -f "/probes/$name.sql" >"$log" 2>&1; then
    echo "PASS   $name" | tee -a "$summary"
    pass=$((pass + 1))
  else
    echo "FAIL   $name  (see $log)" | tee -a "$summary"
    fail=$((fail + 1))
  fi
  if [ "$target" != "$SHARED" ]; then
    remove_container "$target"
  fi
done

echo "probes passed=$pass failed=$fail out=$OUT_DIR" | tee -a "$summary"
[ "$fail" -eq 0 ]
