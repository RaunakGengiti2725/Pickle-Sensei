#!/usr/bin/env bash
# Adversarial pass 3 — db-rls-grants-isolation (#1). Same bootstrap as
# run_rls_tests.sh (Docker postgres:16, shim + every migration), then:
#
#   1. supabase/tests/security_regression.sql          (baseline matrix)
#   2. supabase/tests/attack_rls_isolation_1.sql       (single-session attacks)
#   3. supabase/tests/attack_rls_isolation_1_sessions.sh (multi-session attacks)
#
# Logs land in $ATTACK_ARTIFACTS (default artifacts/attack-rls-isolation-1/<ts>).
# Exit code: 0 only when every scenario is HELD/INFO; the results table is
# printed and saved as attack_results.json either way.
set -euo pipefail

cd "$(dirname "$0")/.."

TS=$(date -u +%Y%m%dT%H%M%SZ)
ART="${ATTACK_ARTIFACTS:-$PWD/../artifacts/attack-rls-isolation-1/$TS}"
mkdir -p "$ART"
echo "artifacts: $ART"
git -C "$PWD/.." rev-parse HEAD >"$ART/commit.txt" 2>/dev/null || true

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the attack harness (multi-session scenarios)." >&2
  exit 1
fi

CONTAINER=pickle-rls-attack-1
cleanup() {
  docker cp "$CONTAINER":/tmp/attack_sessions "$ART/sessions" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' 2>&1 | tee "$ART/01_migrations.log"

set +e
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f /tests/security_regression.sql \
  2>&1 | tee "$ART/02_security_regression.log"
RC_BASE=${PIPESTATUS[0]}
echo "security_regression.sql exit=$RC_BASE" | tee -a "$ART/02_security_regression.log"

docker exec "$CONTAINER" psql -U postgres -f /tests/attack_rls_isolation_1.sql \
  2>&1 | tee "$ART/03_attack_single_session.log"
RC_SQL=${PIPESTATUS[0]}
echo "attack_rls_isolation_1.sql exit=$RC_SQL" | tee -a "$ART/03_attack_single_session.log"

docker exec -e ATTACK_OUT=/tmp/attack_sessions "$CONTAINER" bash /tests/attack_rls_isolation_1_sessions.sh \
  2>&1 | tee "$ART/04_attack_sessions.log"
RC_SESS=${PIPESTATUS[0]}
echo "attack_rls_isolation_1_sessions.sh exit=$RC_SESS" | tee -a "$ART/04_attack_sessions.log"
set -e

docker exec "$CONTAINER" psql -U postgres -X -q -At -c \
  "select json_agg(json_build_object('ord', ord, 'scenario', scenario, 'verdict', verdict, 'detail', detail) order by ord) from public.attack_results" \
  >"$ART/attack_results.json"
docker exec "$CONTAINER" psql -U postgres -X -c \
  "select verdict, count(*) from public.attack_results group by verdict order by verdict" | tee "$ART/summary.txt"

cat >"$ART/exit_codes.json" <<EOF
{"security_regression": $RC_BASE, "attack_single_session": $RC_SQL, "attack_sessions": $RC_SESS}
EOF
cat "$ART/exit_codes.json"

[ "$RC_BASE" = 0 ] && [ "$RC_SQL" = 0 ] && [ "$RC_SESS" = 0 ]
