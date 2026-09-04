#!/usr/bin/env bash
# Adversarial pass 3 (tester #4) — executable check of infra/observability/views.sql
# and infra/postgres/init-roles.sql against a REAL Postgres (the docker-compose
# `postgres_test` service, or any $ATTACK4_PSQL command).
#
# Usage:
#   docker compose up -d postgres_test
#   infra/observability/attack4_views.sh            # exit 0 = every check held
#
# Checks (each prints HELD/BROKEN; the script exits non-zero if any BROKEN):
#   V1 views.sql installs cleanly on the documented analytics_event contract
#   V2 every obs_* view is queryable on an empty table
#   V3 views are queryable with well-typed rows
#   V4 a single malformed `latencyMs` (non-numeric jsonb) breaks obs_analysis_latency
#      for EVERY row in the hour (cast error) — pinned as observed behaviour
#   V5 role hierarchy from init-roles.sql: pickle_readonly cannot write
#   V6 init-roles.sql is idempotent (re-running it does not error)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL="${ATTACK4_PSQL:-docker exec -i pickle-sensei-postgres_test-1 psql -v ON_ERROR_STOP=1 -U pickle -d pickle_test -qAt}"
DB="attack4_obs_$$"
fail=0

run() { $PSQL "$@" 2>&1; }
runq() { $PSQL -d "$DB" "$@" 2>&1; }
verdict() { # $1 label, $2 0|1 (0 = held)
  if [ "$2" -eq 0 ]; then echo "HELD   $1"; else echo "BROKEN $1"; fail=1; fi
}

# A superuser-owned scratch DB so views.sql is exercised in isolation.
run -c "CREATE DATABASE $DB" >/dev/null || { echo "cannot create scratch db"; exit 2; }
trap 'run -c "DROP DATABASE IF EXISTS $DB" >/dev/null' EXIT

# --- V1: documented contract + views.sql ------------------------------------
runq <<'SQL' >/dev/null
CREATE TABLE analytics_event (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,
  at          timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  session_id  text,
  props       jsonb       NOT NULL
);
CREATE INDEX analytics_event_name_at ON analytics_event (name, at);
SQL
out=$(runq < "$ROOT/infra/observability/views.sql"); rc=$?
verdict "V1 views.sql installs on the documented analytics_event contract (rc=$rc)" $rc
[ $rc -ne 0 ] && echo "$out"

views=$(runq -c "SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname LIKE 'obs_%' ORDER BY 1")
echo "  views: $(echo "$views" | tr '\n' ' ')"
[ -z "$views" ] && { echo "no obs_* views installed; aborting"; exit 1; }

# --- V2: every view queryable on empty table ---------------------------------
rc=0
for v in $views; do
  runq -c "SELECT * FROM $v LIMIT 5" >/dev/null || { echo "  $v failed on empty table"; rc=1; }
done
verdict "V2 every obs_* view is queryable on an empty analytics_event" $rc

# --- V3: well-typed rows ------------------------------------------------------
runq <<'SQL' >/dev/null
INSERT INTO analytics_event (name, at, session_id, props) VALUES
 ('analysis_started',   '2026-09-04T10:00:00Z', 's1', '{"shotType":"forehand_drive"}'),
 ('analysis_completed', '2026-09-04T10:00:05Z', 's1', '{"shotType":"forehand_drive","confidenceBand":"normal","latencyMs":4200,"modelVersion":"sm-v1","deviceClass":"iphone15"}'),
 ('analysis_started',   '2026-09-04T10:01:00Z', 's2', '{"shotType":"dink"}'),
 ('analysis_abstained', '2026-09-04T10:01:02Z', 's2', '{"reasonCategory":"capture"}'),
 ('capture_envelope_verdict', '2026-09-04T10:01:00Z', 's2', '{"overall":"UNSUPPORTED","thresholdsVersion":"v1"}'),
 ('api_failure', '2026-09-04T10:02:00Z', NULL, '{"route":"/v1/shots/:id","method":"POST","statusCode":503,"errorCode":"db_unavailable"}'),
 ('queue_backlog', '2026-09-04T10:02:00Z', NULL, '{"queue":"media","depth":12}'),
 ('app_crash', '2026-09-04T10:03:00Z', 's3', '{"fingerprint":"abc","fatal":true}');
SQL
rc=0
for v in $views; do
  runq -c "SELECT * FROM $v" >/dev/null || { echo "  $v failed on typed rows"; rc=1; }
done
verdict "V3 every obs_* view is queryable with well-typed rows" $rc

# --- V4: one malformed latencyMs poisons the latency view ---------------------
runq -c "INSERT INTO analytics_event (name, at, session_id, props) VALUES ('analysis_completed','2026-09-04T10:00:07Z','s9','{\"shotType\":\"dink\",\"confidenceBand\":\"normal\",\"latencyMs\":\"4.2s\",\"modelVersion\":\"sm-v1\",\"deviceClass\":\"iphone15\"}')" >/dev/null
out=$(runq -c "SELECT * FROM obs_analysis_latency"); rc=$?
if [ $rc -ne 0 ]; then
  echo "OBSERVED obs_analysis_latency errors on ONE bad row: $(echo "$out" | head -1)"
  echo "BROKEN V4 one non-numeric latencyMs makes obs_analysis_latency unqueryable for the whole table (P3; no ingestion endpoint exists yet)"
  fail=1
else
  verdict "V4 obs_analysis_latency tolerates a non-numeric latencyMs" 0
fi
runq -c "DELETE FROM analytics_event WHERE session_id='s9'" >/dev/null

# --- V5: role hierarchy --------------------------------------------------------
# init-roles.sql ran in this container at init (docker-entrypoint-initdb.d).
roles=$(runq -c "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'pickle_%'")
echo "  roles: $roles"
runq -c "GRANT SELECT ON analytics_event TO pickle_readonly" >/dev/null
out=$(runq -c "SET ROLE pickle_ro; INSERT INTO analytics_event (name, at, props) VALUES ('x', now(), '{}')"); rc=$?
verdict "V5 pickle_ro (IN ROLE pickle_readonly) cannot INSERT (rc=$rc, expected non-zero)" $([ $rc -ne 0 ] && echo 0 || echo 1)
out=$(runq -c "SET ROLE pickle_ro; SELECT count(*) FROM analytics_event"); rc=$?
verdict "V5 pickle_ro can SELECT after GRANT (rc=$rc)" $rc

# --- V6: idempotent init ---------------------------------------------------------
out=$(run < "$ROOT/infra/postgres/init-roles.sql"); rc=$?
verdict "V6 init-roles.sql re-runs without error (rc=$rc)" $rc
[ $rc -ne 0 ] && echo "$out" | head -5

# --- V7: default passwords are literal in the file (documented dev-only?) -----------
if grep -q "PASSWORD 'pickle_" "$ROOT/infra/postgres/init-roles.sql"; then
  if grep -qi "dev\|local\|never.*prod\|not.*production" "$ROOT/infra/postgres/init-roles.sql"; then
    verdict "V7 literal dev passwords in init-roles.sql are labelled non-production" 0
  else
    echo "BROKEN V7 init-roles.sql hard-codes LOGIN passwords with no dev-only disclaimer (P3)"; fail=1
  fi
fi

exit $fail
