#!/usr/bin/env bash
# Adversarial pass 3/3 for `db-schema-migrations` (attack tester #4).
#
#   ./supabase/functions/api/__wf__/wf-attack-db-schema-migrations-4.sh [out-dir]
#
# Boots a throwaway postgres:16 (Docker) on a free host port, installs the
# Supabase shim, applies every migration in lexical order (exactly like
# supabase/tests/run_rls_tests.sh), then runs
# attack-db-schema-migrations-4.audit.test.ts against it with
# PICKLE_AUDIT_PG_URL set, and folds the `[attack4] S<n> HELD|BROKEN …` lines
# into <out-dir>/attack4-summary.json. Exit code is deno's (non-zero when any
# pinned invariant or repro flips).
#
# Env: ATTACK4_SEED (hex, default 4d812e1a), ATTACK4_PORT (default 55433).
set -euo pipefail

cd "$(dirname "$0")/../../.."   # → supabase/
REPO="$(cd .. && pwd)"
OUT="${1:-$REPO/artifacts/attack4/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check (a skip is NOT a pass)." >&2
  exit 2
fi
if ! command -v deno >/dev/null 2>&1; then
  export PATH="$HOME/.deno/bin:$PATH"
fi
command -v deno >/dev/null 2>&1 || { echo "deno is required" >&2; exit 2; }

PORT="${ATTACK4_PORT:-55433}"
CONTAINER="pickle-attack4-$PORT"
cleanup() {
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER" >/dev/null
  fi
}
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:5432" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  # TCP probe (not the socket-only bootstrap server) — see run_rls_tests.sh.
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 did not become ready within 60s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations
migrate_code=0
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' > "$OUT/migrate.log" 2>&1 || migrate_code=$?
grep -v NOTICE "$OUT/migrate.log" >&2 || [ "$?" -eq 1 ]   # 1 = every line was a NOTICE
if [ "$migrate_code" -ne 0 ]; then
  echo "migrations failed (exit $migrate_code) — see $OUT/migrate.log" >&2
  exit "$migrate_code"
fi

echo "commit=$(git -C "$REPO" rev-parse HEAD) seed=${ATTACK4_SEED:-4d812e1a} port=$PORT" | tee "$OUT/run.txt"

set +e
PICKLE_AUDIT_PG_URL="postgres://postgres:pg@127.0.0.1:$PORT/postgres" \
ATTACK4_SEED="${ATTACK4_SEED:-4d812e1a}" \
  deno test -A --no-check --config functions/api/__wf__/deno.json \
    functions/api/__wf__/attack-db-schema-migrations-4.audit.test.ts 2>&1 | tee "$OUT/deno-test.log"
code=${PIPESTATUS[0]}
set -e
echo "deno exit=$code" | tee -a "$OUT/run.txt"

# Fold the verdict lines into JSON: one entry per scenario line.
grep -o '\[attack4\] S[0-9]* \(HELD\|BROKEN\) .*' "$OUT/deno-test.log" \
  | sed 's/^\[attack4\] //' \
  | awk -v code="$code" 'BEGIN { printf "{\"deno_exit\":%s,\"lines\":[", code; first=1 }
      { s=$1; v=$2; $1=""; $2=""; sub(/^  /, ""); gsub(/\\/, "\\\\"); gsub(/"/, "\\\"");
        if (!first) printf ","; first=0;
        printf "{\"scenario\":\"%s\",\"verdict\":\"%s\",\"detail\":\"%s\"}", s, v, $0 }
      END { print "]}" }' > "$OUT/attack4-summary.json"
echo "summary → $OUT/attack4-summary.json"
exit "$code"
