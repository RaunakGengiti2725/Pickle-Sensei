#!/usr/bin/env bash
# S2 — two `verify-cloud.sh --only test,db` runs at once against ONE Postgres
# (CI points DATABASE_URL and DATABASE_URL_TEST at the same service DB).
# The integration suites `DROP SCHEMA public CASCADE`, so a collision is
# expected; what must hold is that neither run turns a collision into a green
# summary (status passed / ok:true) — a loud, attributable failure is fine.
#
# Env: ATTACK_DB_URL (default: the local docker-compose test DB on :5433).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DB="${ATTACK_DB_URL:-postgres://pickle:pickle_test_password@localhost:5433/pickle_test}"
OUT="$ATTACK_EVIDENCE/s2"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2

# Ensure deps are present (root workspace) — the runs need pg + vitest.
[ -d node_modules ] || { log "root node_modules missing; run scripts/verify-cloud.sh --only deps first"; exit 2; }

launch() {
  # $1 = run label
  DATABASE_URL="$DB" DATABASE_URL_TEST="$DB" VERIFY_ARTIFACTS="$OUT/$1" \
    scripts/verify-cloud.sh --only test,db >"$OUT/$1.stdout" 2>&1
  echo $? >"$OUT/$1.exit"
}

log "launching two concurrent runs against $DB"
launch A &
pa=$!
launch B &
pb=$!
wait "$pa" "$pb"

ea="$(cat "$OUT/A.exit")"
eb="$(cat "$OUT/B.exit")"
log "exit A=$ea B=$eb"

for r in A B; do
  s="$OUT/$r/summary.json"
  if [ ! -f "$s" ]; then
    verdict BROKEN "run $r wrote summary.json" "missing $s"
    continue
  fi
  ok="$(summary_field "$s" ok)"
  ts="$(stage_status "$s" test)"
  ds="$(stage_status "$s" db)"
  ex="$(cat "$OUT/$r.exit")"
  log "run $r: ok=$ok test=$ts db=$ds exit=$ex"
  # Exit code must agree with ok.
  if [ "$ok" = true ]; then assert_eq "run $r: ok:true ⇔ exit 0" 0 "$ex"; else assert_ne "run $r: ok:false ⇔ non-zero exit" 0 "$ex"; fi
  # A `passed` test stage must not have vitest failures in its log.
  if [ "$ts" = passed ]; then
    assert_not_grep "run $r: test stage 'passed' has no failing suites in test.log" "Tests? +[0-9]+ failed|FAIL +[^ ]+ *(>|\\[)|ELIFECYCLE" "$OUT/$r/test.log"
  fi
  if [ "$ds" = passed ]; then
    assert_not_grep "run $r: db stage 'passed' has no error in db.log" "ERR_PNPM|error:|ELIFECYCLE" "$OUT/$r/db.log"
  fi
done

if [ "$ea" = 0 ] && [ "$eb" = 0 ]; then
  verdict HELD "both concurrent runs passed — no observable schema collision" "exit A=0 B=0"
else
  # Not a false pass, but concurrency on a shared DB is unguarded: record it
  # as an observation for the report (severity decided by the reviewer).
  verdict HELD "collision surfaced as a loud failure, not a green summary" "exit A=$ea B=$eb"
  grep -hE "DROP SCHEMA|does not exist|deadlock|ECONNRESET|tuple concurrently|relation .* already exists|FAIL " "$OUT"/A/test.log "$OUT"/B/test.log 2>/dev/null | sort | uniq -c | sort -rn | head -20 >"$OUT/collision-signatures.txt" || true
  log "collision signatures → $OUT/collision-signatures.txt"
fi

finish
