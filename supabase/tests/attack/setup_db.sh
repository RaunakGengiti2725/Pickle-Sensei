#!/usr/bin/env bash
# Build the throwaway postgres:16 container the attack scenarios run against:
# hosted-like default privileges (supabase/tests/shim_auth.sql) followed by
# every migration in sorted order — the same recipe as run_rls_tests.sh.
#
#   ./supabase/tests/attack/setup_db.sh            # creates pickle-attack-db
#   ATTACK_CONTAINER=other ./supabase/tests/attack/setup_db.sh
#
# Refuses to touch an existing container of that name; remove it first with
# `docker rm -f <name>` if you want a fresh schema.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
supabase_dir="$(cd "$here/../.." && pwd)"
container="${ATTACK_CONTAINER:-pickle-attack-db}"
host_port="${ATTACK_HOST_PORT:-55432}"

if docker container inspect "$container" >/dev/null 2>&1; then
  echo "container $container already exists; docker rm -f $container to rebuild" >&2
  exit 65
fi

docker run -d --name "$container" -e POSTGRES_PASSWORD=pg -p "$host_port":5432 postgres:16 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null

docker cp "$supabase_dir/tests" "$container":/tests
docker cp "$supabase_dir/migrations" "$container":/migrations
docker exec "$container" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in $(ls /migrations/*.sql | sort); do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
'
docker exec "$container" psql -U postgres -Atc "select 'migrations applied; server ' || version()"
