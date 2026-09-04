# Shared helpers for the db-schema-migrations adversarial pass #3.
# Sourced by run.sh and every s*.sh scenario. Requires docker + postgres:16.
#
# Every scenario runs against its OWN database cloned from a template that
# holds shim_auth.sql + all supabase/migrations/*.sql + attack helpers, so a
# scenario can never observe another scenario's state.

set -euo pipefail

ATTACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$ATTACK_DIR/../../.." && pwd)"
REPO_DIR="$(cd "$SUPABASE_DIR/.." && pwd)"

CONTAINER="${ATTACK_CONTAINER:-pickle-attack-dbm3}"
TEMPLATE_DB="${ATTACK_TEMPLATE_DB:-tpl}"
OUT_DIR="${ATTACK_OUT_DIR:-$REPO_DIR/artifacts/attack-db-schema-migrations-3/latest}"
mkdir -p "$OUT_DIR"

# psql inside the container. Usage: dpsql <db> [psql args...]  (stdin passes through)
dpsql() {
  local db="$1"; shift
  docker exec -i "$CONTAINER" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"
}

# Scalar query. Usage: dq <db> "<sql>"
dq() {
  local db="$1"; shift
  docker exec -i "$CONTAINER" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 -At -c "$1"
}

# Fresh database cloned from the template.
fresh_db() {
  local db="$1"
  dq postgres "drop database if exists $db with (force)" >/dev/null
  dq postgres "create database $db template $TEMPLATE_DB" >/dev/null
}

# Assertion bookkeeping. Each scenario emits ASSERT lines; run.sh greps them.
FAILS=0
assert_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" == "$want" ]; then
    echo "ASSERT PASS | $label | got=$got"
  else
    echo "ASSERT FAIL | $label | got=$got want=$want"
    FAILS=$((FAILS + 1))
  fi
}

finish_scenario() {
  local name="$1"
  if [ "$FAILS" -eq 0 ]; then
    echo "SCENARIO HELD | $name"
    return 0
  fi
  echo "SCENARIO BROKEN | $name | failures=$FAILS"
  return 1
}
