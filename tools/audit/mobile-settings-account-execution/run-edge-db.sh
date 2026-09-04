#!/usr/bin/env bash
# Runs the DB-backed edge audit tests (ignored by `deno task test` without a
# Postgres) against a throwaway postgres:16 container with every migration applied.
set -u
cd "$(git rev-parse --show-toplevel)"
docker rm -f pickle-audit >/dev/null 2>&1
docker run -d --name pickle-audit -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16 || exit 2
for i in $(seq 1 30); do docker exec pickle-audit pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker cp supabase/tests pickle-audit:/tests && docker cp supabase/migrations pickle-audit:/migrations
docker exec pickle-audit bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done' || { echo "migrations failed"; exit 3; }
cd supabase/functions/api/__wf__
PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres deno test -A --no-check --config deno.json .
rc=$?
echo "exit=$rc"
docker rm -f pickle-audit >/dev/null 2>&1
exit $rc
