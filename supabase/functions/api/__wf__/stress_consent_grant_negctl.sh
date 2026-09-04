#!/usr/bin/env bash
# Negative controls for the consent-grant concurrency stress suite: prove the
# invariants FAIL when the modelled Supabase is deliberately broken (a green
# stress suite is only evidence if it can go red).
#
#   ./stress_consent_grant_negctl.sh            # → exit 0 when all mutants are caught
#
# Each mutant is applied to a COPY of the harness in a temp dir; the checked-in
# files are never modified.
set -uo pipefail
cd "$(dirname "$0")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp deno.json stress_consent_grant_harness.ts stress_consent_grant_concurrency.test.ts "$work/"
mkdir -p "$work/parent"
# the harness imports ../index.ts and ./xc_concurrency_harness.ts
cp xc_concurrency_harness.ts "$work/"
ln -s "$(cd .. && pwd)" "$work/api-src"
sed -i 's#"../index.ts"#"./api-src/index.ts"#' "$work/stress_consent_grant_harness.ts"

run_mutant() {
  local name="$1" scenario="$2"
  shift 2
  cp stress_consent_grant_harness.ts "$work/stress_consent_grant_harness.ts"
  sed -i 's#"../index.ts"#"./api-src/index.ts"#' "$work/stress_consent_grant_harness.ts"
  if ! python3 - "$work/stress_consent_grant_harness.ts" "$@" <<'PY'
import sys
path, specs = sys.argv[1], sys.argv[2:]
src = open(path).read()
for spec in specs:
    old, new = spec.split("||")
    if old not in src:
        sys.exit(f"mutant target not found: {old}")
    src = src.replace(old, new, 1)
open(path, "w").write(src)
PY
  then
    echo "MUTANT $name: could not apply"
    return 1
  fi
  local out
  out="$(cd "$work" && STRESS_ITER=3 deno test -A --no-check --config deno.json \
    stress_consent_grant_concurrency.test.ts --filter "$scenario" 2>&1)"
  if echo "$out" | grep -q "BROKEN"; then
    echo "MUTANT $name: CAUGHT — $(echo "$out" | grep -o 'BROKEN: [^;]*' | head -1)"
    return 0
  fi
  echo "MUTANT $name: NOT CAUGHT (the suite stayed green — invariants too weak)"
  return 1
}

status=0
SELECT_LINE='      const rows = sortLedger(wanted ? visible.filter((r) => r.user_id === wanted) : visible).map('
RLS_LINE='            ? this.consent.filter((r) => r.user_id === who.userId)'

# A — a committed row silently disappears (lost write)
run_mutant "A_lost_write" duplicate_grant_burst \
  '        this.consent.push(row);||        if (attempt % 5 !== 0) this.consent.push(row);' || status=1
# B — both isolation layers off: RLS and the route's eq(user_id) filter
run_mutant "B_cross_tenant_fold" two_actors_same_scope \
  "${SELECT_LINE}||      const rows = sortLedger(visible).map(" \
  "${RLS_LINE}||            ? this.consent" || status=1
# C — the primary key collides under concurrency
run_mutant "C_duplicate_row_id" duplicate_grant_burst \
  '          id: this.prng.uuid(),||          id: attempt % 4 === 0 ? "00000000-0000-0000-0000-000000000000" : this.prng.uuid(),' || status=1
# D — the read-back misses the newest committed row (stale read / lost update)
run_mutant "D_stale_read_back" grant_withdraw_race \
  "${SELECT_LINE}||      const rows = sortLedger(wanted ? visible.filter((r) => r.user_id === wanted) : visible).slice(0, -1).map(" || status=1

if [ "$status" -eq 0 ]; then
  echo "negative controls: all mutants caught"
else
  echo "negative controls: FAILED"
fi
exit "$status"
