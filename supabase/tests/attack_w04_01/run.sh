#!/usr/bin/env bash
# W04-01 adversarial SQL attacks (candidate 52867e38).
#
# Each a*.sql file is one self-contained attack: BEGIN … ROLLBACK against a
# database that already has supabase/tests/shim_auth.sql + every migration
# applied (supabase/functions/api/__wf__/xc_pg_up.sh builds one). A block
# RAISES when the candidate does NOT behave as the objective/invariants
# require, so a failing file is a confirmed break and a passing file is an
# attack that did not break anything.
#
#   ./supabase/functions/api/__wf__/xc_pg_up.sh           # container pickle-xc-pg
#   ./supabase/tests/attack_w04_01/run.sh pickle-xc-pg     # exit 0 iff every attack held
set -u
container="${1:-pickle-xc-pg}"
here="$(cd "$(dirname "$0")" && pwd)"
docker exec "$container" rm -rf /attack_w04_01 && docker cp "$here" "$container":/attack_w04_01 >/dev/null
pass=0; fail=0; failed=()
for f in "$here"/a*.sql; do
  name="$(basename "$f")"
  if out="$(docker exec "$container" psql -U postgres -v ON_ERROR_STOP=1 -q -f "/attack_w04_01/$name" 2>&1)"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name"
    echo "$out" | grep -E "ERROR|DETAIL|CONTEXT|HINT|psql:" | sed 's/^/     /'
    fail=$((fail + 1)); failed+=("$name")
  fi
done
echo "attack_w04_01: executed=$((pass + fail)) passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
