#!/usr/bin/env bash
# Adversarial harness for work package P0-04 (SQL security matrix).
#
#   ./supabase/tests/attacks/run_attacks.sh
#
# Builds the SAME four migration histories as ../run_rls_tests.sh (fresh,
# production_20260906, upstream_20260906, ordered_20260907) in a throwaway
# Docker Postgres, then runs every attacks/attack_*.sql against each history
# with ON_ERROR_STOP=1 and, last, dumps a deterministic privilege/RLS/trigger
# catalog snapshot per history and diffs them pairwise: an upgraded database
# must end in exactly the security state a fresh install ends in.
#
# Environment:
#   PG_IMAGE            Docker image (default postgres:16 — the runner's).
#   RUN_CANDIDATE_TESTS 1 → also run the candidate's own three test files
#                       before the attacks (used for the Postgres major-version
#                       boundary attack: 15 and 17 are what Supabase hosts).
#   ATTACK_LOG_DIR      where snapshots are written (default
#                       supabase/tests/attacks/out).
#
# Never modifies run_rls_tests.sh, the candidate tests or any migration.
set -euo pipefail

cd "$(dirname "$0")/../.."

PG_IMAGE="${PG_IMAGE:-postgres:16}"
RUN_CANDIDATE_TESTS="${RUN_CANDIDATE_TESTS:-0}"
ATTACK_LOG_DIR="${ATTACK_LOG_DIR:-tests/attacks/out}"
mkdir -p "$ATTACK_LOG_DIR"

HISTORIES=(fresh production_20260906 upstream_20260906 ordered_20260907)

is_applied() {
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

run_matrices() {
  local migration_root="$1" test_root="$2" history database phase file name version attack
  local attack_files=0
  for history in "${HISTORIES[@]}"; do
    database="pickle_attack_$history"
    printf '\nAttack migration history: %s (%s)\n' "$history" "$PG_IMAGE"
    run_psql -d postgres -v ON_ERROR_STOP=1 -q -c "create database $database;"
    run_psql -d "$database" -v ON_ERROR_STOP=1 -q -f "$test_root/shim_auth.sql"
    for phase in base pending; do
      for file in migrations/*.sql; do
        name="${file##*/}"
        version="${name%%_*}"
        if is_applied "$history" "$version"; then applied=1; else applied=0; fi
        if { [ "$phase" = base ] && [ "$applied" = 1 ]; } || { [ "$phase" = pending ] && [ "$applied" = 0 ]; }; then
          printf '%s %s %s\n' "$history" "$phase" "$name"
          run_psql -d "$database" -v ON_ERROR_STOP=1 -q -f "$migration_root/$name"
        fi
      done
    done
    if [ "$RUN_CANDIDATE_TESTS" = 1 ]; then
      run_psql -d "$database" -v ON_ERROR_STOP=1 -f "$test_root/security_regression.sql"
      run_psql -d "$database" -v ON_ERROR_STOP=1 -f "$test_root/account_deletion_operations.sql"
      run_psql -d "$database" -v ON_ERROR_STOP=1 -f "$test_root/analysis_release_policy.sql"
    fi
    attack_files=0
    for attack in tests/attacks/attack_*.sql; do
      name="${attack##*/}"
      printf '\n%s ATTACK %s\n' "$history" "$name"
      run_psql -d "$database" -v ON_ERROR_STOP=1 -f "$test_root/attacks/$name"
      attack_files=$((attack_files + 1))
    done
    if [ "$attack_files" -eq 0 ]; then
      echo "no attack files found — a zero-test run is not a pass" >&2
      exit 3
    fi
    run_psql -d "$database" -v ON_ERROR_STOP=1 -X -q -A -t -f "$test_root/attacks/catalog_snapshot.sql" \
      > "$ATTACK_LOG_DIR/catalog_$history.txt"
    printf '%s catalog snapshot: %s lines\n' "$history" "$(wc -l < "$ATTACK_LOG_DIR/catalog_$history.txt")"
  done

  local divergent=0 other
  for other in "${HISTORIES[@]:1}"; do
    if ! diff -u "$ATTACK_LOG_DIR/catalog_fresh.txt" "$ATTACK_LOG_DIR/catalog_$other.txt" \
         > "$ATTACK_LOG_DIR/catalog_diff_fresh_vs_$other.txt"; then
      divergent=1
      printf 'ATTACK 01 FAIL: security catalog of %s diverges from fresh (see %s)\n' \
        "$other" "$ATTACK_LOG_DIR/catalog_diff_fresh_vs_$other.txt"
      cat "$ATTACK_LOG_DIR/catalog_diff_fresh_vs_$other.txt"
    else
      printf 'ATTACK 01 ok: %s catalog identical to fresh\n' "$other"
    fi
  done
  if [ "$divergent" -ne 0 ]; then
    exit 4
  fi
  printf '\nATTACK HARNESS: %s attack files x %s histories passed on %s\n' \
    "$attack_files" "${#HISTORIES[@]}" "$PG_IMAGE"
}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the attack harness." >&2
  exit 1
fi

CONTAINER="pickle-attack-$(echo "$PG_IMAGE" | tr -c 'a-zA-Z0-9\n' '-')"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg "$PG_IMAGE" >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "$PG_IMAGE container did not become ready within 60s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

run_psql() { docker exec "$CONTAINER" psql -U postgres "$@"; }
docker exec "$CONTAINER" psql -U postgres -At -c 'select version()'
run_matrices /migrations /tests
