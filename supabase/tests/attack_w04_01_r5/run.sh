#!/usr/bin/env bash
# W04-01 round-5 adversary suite. Builds a disposable database from the
# checked-out migrations (supabase/tests/shim_auth.sql first, then every
# migration in order) and runs each attack file against it. A01–A03, A05 and
# A06 roll back; A04 and A07 commit through dblink connections, so the
# database is rebuilt before each of them. Exit 0 only when every attack
# PASSED (i.e. the candidate resisted all of them).
set -uo pipefail

cd "$(dirname "$0")"
CONTAINER="${PICKLE_ATTACK_CONTAINER:-pickle-attack}"
DB="${PICKLE_ATTACK_DB:-pickle_attack_w04}"
LOG_DIR="${PICKLE_ATTACK_LOG_DIR:-../../../artifacts/w04-01/attack_r5}"
mkdir -p "$LOG_DIR"

run_psql() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

executed=0 passed=0 failed=0
build() { ./build_db.sh "$DB" >"$LOG_DIR/build.log" 2>&1 || { cat "$LOG_DIR/build.log"; exit 2; }; }

build
for file in a0*.sql; do
  case "$file" in a04_*|a07_*) build ;; esac
  executed=$((executed + 1))
  if run_psql -f "/tests/attack_w04_01_r5/$file" >"$LOG_DIR/${file%.sql}.log" 2>&1; then
    passed=$((passed + 1)); status=PASSED
  else
    failed=$((failed + 1)); status=BREAK
  fi
  printf '%-45s %s\n' "$file" "$status"
  grep -E 'NOTICE|ERROR' "$LOG_DIR/${file%.sql}.log" | sed 's/^psql:[^:]*:[0-9]*: //' | sed 's/^/    /'
done
printf 'executed=%d passed=%d failed=%d (attacked sha %s)\n' "$executed" "$passed" "$failed" "$(git -C ../../.. rev-parse HEAD)"
[ "$failed" -eq 0 ]
