#!/usr/bin/env bash
# W04-01 adversarial attack runner (attack branch only).
#
# Builds ONE disposable postgres:16 database exactly the way
# supabase/tests/run_rls_tests.sh builds its fresh-install history (shim_auth
# + every migration in order), then runs every a*.sql attack in its own
# psql process. Each attack file is a real test: it opens a transaction,
# drives the candidate through its RPCs, asserts the invariant under attack
# and rolls back. A failing assertion is a confirmed break; the runner keeps
# going so one run reports every break, then exits non-zero.
#
# Usage: supabase/tests/attacks/w04_01/run.sh [migrations-dir]
# Requires Docker. Set ATTACK_PG_CONTAINER to reuse a container name.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
migrations="${1:-$repo/supabase/migrations}"
container="${ATTACK_PG_CONTAINER:-pickle-w04-01-attack-$$}"
artifacts="${ATTACK_ARTIFACTS:-$repo/artifacts/attacks/w04_01}"
mkdir -p "$artifacts"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
cleanup() {
  local status=$?
  if docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
    docker rm -f "$container" >/dev/null 2>&1
  fi
  exit "$status"
}
trap cleanup EXIT
for _ in $(seq 1 60); do
  docker exec "$container" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null || { echo "postgres did not start" >&2; exit 2; }

docker cp "$repo/supabase/tests" "$container:/tests"
docker cp "$migrations" "$container:/migrations"
psql_in() { docker exec -i "$container" psql -U postgres -d atk -v ON_ERROR_STOP=1 -q "$@"; }
docker exec "$container" psql -U postgres -q -c "create database atk" >/dev/null
psql_in -f /tests/shim_auth.sql >"$artifacts/00_shim.log" 2>&1 || { cat "$artifacts/00_shim.log"; exit 2; }
mapfile -t migration_files < <(docker exec "$container" bash -c 'ls /migrations/*.sql | sort')
[ "${#migration_files[@]}" -gt 0 ] || { echo "no migrations found in $migrations" >&2; exit 2; }
for f in "${migration_files[@]}"; do
  psql_in -f "$f" </dev/null >>"$artifacts/01_migrations.log" 2>&1 || { echo "migration failed: $f" >&2; tail -20 "$artifacts/01_migrations.log" >&2; exit 2; }
done
echo "applied ${#migration_files[@]} migrations from $migrations"

pass=0; fail=0; failed=()
for f in "$here"/a*.sql; do
  name="$(basename "$f" .sql)"
  log="$artifacts/$name.log"
  if docker exec -i "$container" psql -U postgres -d atk -v ON_ERROR_STOP=1 -f "/tests/attacks/w04_01/$(basename "$f")" >"$log" 2>&1; then
    pass=$((pass + 1)); echo "PASS  $name"
  else
    fail=$((fail + 1)); failed+=("$name"); echo "FAIL  $name"
    grep -E "ERROR|BREAK|CONTEXT|LINE" "$log" | head -20 | sed 's/^/      /'
  fi
done
echo
echo "W04-01 attacks: executed=$((pass + fail)) passed=$pass failed=$fail (logs: $artifacts)"
if [ "$fail" -gt 0 ]; then
  printf 'BROKEN: %s\n' "${failed[@]}"
  exit 1
fi
