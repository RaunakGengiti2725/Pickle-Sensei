#!/usr/bin/env bash
# INT-backend-sql-rls adversarial matrix (attack tests, not the canonical gate).
#
#   ./supabase/tests/adv/run_adv_tests.sh [artifact_dir]
#
# Builds the SAME four migration histories the canonical runner builds
# (fresh, production_20260906, upstream_20260906, ordered_20260907) plus one
# `hosted_defaults` history whose shim mirrors the hosted Supabase default
# privileges for service_role (`grant all on tables to service_role`, see
# supabase/postgres init-scripts/00000000000000-initial-schema.sql) instead of
# the narrower truncate/references/trigger set the canonical shim installs.
# Then runs every supabase/tests/adv/adv*.sql attack against every history
# and diffs a normalized catalog snapshot across the four canonical histories.
#
# Unlike the canonical runner this one does NOT stop at the first failing
# attack: every (attack, history) pair is executed and tallied so the report
# carries exact executed/passed/failed counts. Exit status is non-zero when
# any attack fails (a failing attack is a confirmed break on the target).
set -uo pipefail

cd "$(dirname "$0")/../.."

ARTIFACTS="${1:-artifacts/adv}"
mkdir -p "$ARTIFACTS/snap"
SUMMARY="$ARTIFACTS/adv_summary.tsv"
: > "$SUMMARY"

CONTAINER=pickle-adv-attack
cleanup() {
  if [ -n "$(docker ps -aq --filter "name=^${CONTAINER}$")" ]; then
    docker rm -f "$CONTAINER" >/dev/null
  fi
}
trap cleanup EXIT
cleanup

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the adversarial matrix." >&2
  exit 2
fi

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2
  exit 2
fi
docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

run_psql() { docker exec "$CONTAINER" psql -U postgres "$@"; }

is_applied_in_base() {
  local history="$1" version="$2"
  case "$history" in
    production_20260906)
      [[ "$version" < "20260902150000" || "$version" == "20260902150000" || "$version" == "20260905190106" ]]
      ;;
    upstream_20260906)
      [[ ( "$version" < "20260907100000" || "$version" == "20260907100000" ) && "$version" != "20260905190106" && "$version" != "20260906233000" && "$version" != "20260907001500" ]]
      ;;
    ordered_20260907)
      [[ "$version" < "20260902150000" || "$version" == "20260902150000" || "$version" == "20260905190106" || "$version" == "20260906233000" || "$version" == "20260907001500" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

build_history() {
  local history="$1" database="$2" phase file name version
  run_psql -d postgres -v ON_ERROR_STOP=1 -q -c "create database $database;" || return 1
  run_psql -d "$database" -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql >/dev/null || return 1
  if [ "$history" = hosted_defaults ]; then
    run_psql -d "$database" -v ON_ERROR_STOP=1 -q -f /tests/adv/shim_hosted_service_role.sql >/dev/null || return 1
  fi
  for phase in base pending; do
    for file in migrations/*.sql; do
      name="${file##*/}"
      version="${name%%_*}"
      if is_applied_in_base "$history" "$version"; then applied=1; else applied=0; fi
      if { [ "$phase" = base ] && [ "$applied" = 1 ]; } || { [ "$phase" = pending ] && [ "$applied" = 0 ]; }; then
        run_psql -d "$database" -v ON_ERROR_STOP=1 -q -f "/migrations/$name" >/dev/null || return 1
      fi
    done
  done
}

executed=0
passed=0
failed=0
declare -a failures=()

record() {
  local attack="$1" history="$2" status="$3" log="$4"
  executed=$((executed + 1))
  if [ "$status" = PASS ]; then passed=$((passed + 1)); else failed=$((failed + 1)); failures+=("$attack@$history"); fi
  printf '%s\t%s\t%s\t%s\n' "$attack" "$history" "$status" "$log" >> "$SUMMARY"
  printf '%-48s %-22s %s\n' "$attack" "$history" "$status"
}

for history in fresh production_20260906 upstream_20260906 ordered_20260907 hosted_defaults; do
  database="adv_$history"
  printf '\n== history %s\n' "$history"
  if ! build_history "$history" "$database" > "$ARTIFACTS/build_$history.log" 2>&1; then
    echo "history $history failed to build; see $ARTIFACTS/build_$history.log" >&2
    exit 2
  fi
  for file in tests/adv/adv*.sql; do
    name="${file##*/}"
    log="$ARTIFACTS/${name%.sql}.$history.log"
    if run_psql -d "$database" -v ON_ERROR_STOP=1 -f "/tests/adv/$name" > "$log" 2>&1; then
      record "$name" "$history" PASS "$log"
    else
      record "$name" "$history" FAIL "$log"
    fi
  done
  run_psql -d "$database" -q -f /tests/adv/catalog_snapshot.sql > "$ARTIFACTS/snap/$history.txt" 2>&1
  # multi-connection attacks (real races) are shell drivers over the same database
  for file in tests/adv/adv*.sh; do
    name="${file##*/}"
    log="$ARTIFACTS/${name%.sh}.$history.log"
    if bash "$file" "$CONTAINER" "$database" > "$log" 2>&1; then
      record "$name" "$history" PASS "$log"
    else
      record "$name" "$history" FAIL "$log"
    fi
  done
done

# Attack 11: the four canonical histories must converge to one catalog.
printf '\n== history convergence (catalog snapshot diff)\n'
converged=PASS
for history in production_20260906 upstream_20260906 ordered_20260907; do
  if ! diff -u "$ARTIFACTS/snap/fresh.txt" "$ARTIFACTS/snap/$history.txt" > "$ARTIFACTS/snap/diff_fresh_vs_$history.txt"; then
    converged=FAIL
  fi
done
record "adv11_history_convergence.diff" "all" "$converged" "$ARTIFACTS/snap"

printf '\nexecuted=%d passed=%d failed=%d skipped=0\n' "$executed" "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  printf 'failing attacks:\n'
  printf '  %s\n' "${failures[@]}"
  exit 1
fi
exit 0
