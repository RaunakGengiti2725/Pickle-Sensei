#!/usr/bin/env bash
# Adversarial probe (shared-packages-ops #2, pass 3) for infra/observability.
#
# Installs the ingestion table documented at the top of views.sql plus every
# view, then injects analytics rows whose `props` carry values the views cast
# with ::numeric / ::int / ::boolean, and records whether ONE malformed event
# takes a whole dashboard view down. Also probes the init-roles.sql least-
# privilege roles: can pickle_ro / pickle_app read the views, and can the
# application runtime role tamper with them?
#
# Usage: infra/observability/attack/views_hostile_props.sh [container]
#   container defaults to the docker compose postgres_test service.
# Exit 0 when every probe ran and produced a verdict (HELD/BROKEN lines on
# stdout), non-zero when the harness itself failed. Never touches production.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTAINER="${1:-$(docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q postgres_test)}"
if [[ -z "$CONTAINER" ]]; then
  echo "harness: postgres_test container not running (docker compose up -d postgres_test)" >&2
  exit 3
fi
DB="obs_attack_$$"

psql_super() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -X -q -U pickle -d "$1" "${@:2}"; }
psql_as() { docker exec -i -e PGPASSWORD="$2" "$CONTAINER" psql -X -q -t -A -U "$1" -d "$DB" -c "$3" 2>&1; }

verdict=0
report() { # report <HELD|BROKEN> <id> <detail>
  echo "$1 $2 :: $3"
  [[ "$1" == "BROKEN" ]] && verdict=1
  return 0
}

for i in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U pickle >/dev/null 2>&1 && break
  sleep 1
done

psql_super pickle_test -c "CREATE DATABASE $DB" >/dev/null
trap 'psql_super pickle_test -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1' EXIT

psql_super "$DB" <<'SQL' >/dev/null
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
psql_super "$DB" < "$REPO_ROOT/infra/observability/views.sql" >/dev/null \
  && report HELD views-install "views.sql applies cleanly on the documented analytics_event table" \
  || report BROKEN views-install "views.sql failed to apply"

# Well-formed baseline rows.
psql_super "$DB" <<'SQL' >/dev/null
INSERT INTO analytics_event (name, at, props) VALUES
  ('analysis_started',   '2026-09-01T10:00:00Z', '{"inferenceMode":"on_device"}'),
  ('analysis_completed', '2026-09-01T10:00:05Z', '{"shotType":"dink","confidenceBand":"normal","latencyMs":4200,"modelVersion":"m1"}'),
  ('app_opened',         '2026-09-01T10:00:00Z', '{"appBuild":"100"}'),
  ('app_crash',          '2026-09-01T10:00:01Z', '{"appBuild":"100","fatal":true}'),
  ('api_failure',        '2026-09-01T10:00:02Z', '{"route":"/v1/x","statusCode":503,"errorCode":"E"}'),
  ('queue_depth_sampled','2026-09-01T10:00:03Z', '{"queue":"analysis","depth":3}');
SQL

probe_view() { # probe_view <view>
  # A dashboard does `SELECT *`; a bare count(*) over the view lets the
  # planner prune the casting aggregates and would hide the failure.
  out=$(psql_super "$DB" -t -A -c "SELECT * FROM $1" 2>&1)
  rc=$?
  local lines err
  lines=$(printf '%s\n' "$out" | grep -c .)
  err=$(printf '%s\n' "$out" | awk '/ERROR/ { print; found = 1 } END { if (!found) print "" }')
  echo "$rc|$lines|$err"
}

baseline_latency=$(probe_view obs_analysis_latency)
[[ "$baseline_latency" == 0\|* ]] \
  && report HELD baseline-views "obs_analysis_latency readable with well-formed rows ($baseline_latency)" \
  || report BROKEN baseline-views "obs_analysis_latency fails on well-formed rows: $baseline_latency"

# --- Hostile row 1: latencyMs is a string ("4200ms"). The client type says
# number, but nothing in the ingestion contract validates props.
psql_super "$DB" -c "INSERT INTO analytics_event (name, at, props) VALUES ('analysis_completed','2026-09-01T11:00:00Z','{\"shotType\":\"dink\",\"confidenceBand\":\"normal\",\"latencyMs\":\"4200ms\"}')" >/dev/null
r=$(probe_view obs_analysis_latency)
if [[ "$r" == 0\|* ]]; then
  report HELD hostile-latency-string "obs_analysis_latency survives a string latencyMs"
else
  report BROKEN hostile-latency-string "ONE analysis_completed row with latencyMs=\"4200ms\" breaks the whole obs_analysis_latency view: ${r#*|}"
fi
psql_super "$DB" -c "DELETE FROM analytics_event WHERE at = '2026-09-01T11:00:00Z'" >/dev/null

# --- Hostile row 2: latencyMs is a JSON object / array / boolean.
for bad in '{"a":1}' '[1,2]' 'true' '"NaN"' '"Infinity"' '"1e400"'; do
  psql_super "$DB" -c "INSERT INTO analytics_event (name, at, props) VALUES ('analysis_completed','2026-09-01T11:00:00Z', jsonb_build_object('shotType','dink','confidenceBand','normal','latencyMs', '$bad'::jsonb))" >/dev/null
  r=$(probe_view obs_analysis_latency)
  if [[ "$r" == 0\|* ]]; then
    report HELD "hostile-latency-$bad" "view survives latencyMs=$bad"
  else
    report BROKEN "hostile-latency-$bad" "latencyMs=$bad breaks obs_analysis_latency: ${r#*|}"
  fi
  psql_super "$DB" -c "DELETE FROM analytics_event WHERE at = '2026-09-01T11:00:00Z'" >/dev/null
done

# --- Hostile row 3: app_crash.fatal = "maybe" → ::boolean.
psql_super "$DB" -c "INSERT INTO analytics_event (name, at, props) VALUES ('app_crash','2026-09-01T11:00:00Z','{\"appBuild\":\"100\",\"fatal\":\"maybe\"}')" >/dev/null
r=$(probe_view obs_crash_rate)
if [[ "$r" == 0\|* ]]; then
  report HELD hostile-fatal-string "obs_crash_rate survives fatal=\"maybe\""
else
  report BROKEN hostile-fatal-string "ONE app_crash row with fatal=\"maybe\" breaks obs_crash_rate (the paging crash-spike source): ${r#*|}"
fi
psql_super "$DB" -c "DELETE FROM analytics_event WHERE at = '2026-09-01T11:00:00Z'" >/dev/null

# --- Hostile row 4: api_failure.statusCode = "5xx" → ::int.
psql_super "$DB" -c "INSERT INTO analytics_event (name, at, props) VALUES ('api_failure','2026-09-01T11:00:00Z','{\"route\":\"/v1/x\",\"statusCode\":\"5xx\"}')" >/dev/null
r=$(probe_view obs_api_failures)
if [[ "$r" == 0\|* ]]; then
  report HELD hostile-status-string "obs_api_failures survives statusCode=\"5xx\""
else
  report BROKEN hostile-status-string "ONE api_failure row with statusCode=\"5xx\" breaks obs_api_failures: ${r#*|}"
fi
psql_super "$DB" -c "DELETE FROM analytics_event WHERE at = '2026-09-01T11:00:00Z'" >/dev/null

# --- Hostile row 5: missing fatal key (props ->> 'fatal' → NULL::boolean is fine).
psql_super "$DB" -c "INSERT INTO analytics_event (name, at, props) VALUES ('app_crash','2026-09-01T11:00:00Z','{\"appBuild\":\"100\"}')" >/dev/null
r=$(probe_view obs_crash_rate)
[[ "$r" == 0\|* ]] && report HELD hostile-fatal-missing "obs_crash_rate survives a crash row without fatal" \
  || report BROKEN hostile-fatal-missing "crash row without fatal breaks obs_crash_rate: ${r#*|}"
psql_super "$DB" -c "DELETE FROM analytics_event WHERE at = '2026-09-01T11:00:00Z'" >/dev/null

# --- Hostile row 6: 1 MiB props blob / 10k-key object — view still answers?
psql_super "$DB" -c "INSERT INTO analytics_event (name, at, props) SELECT 'analysis_completed','2026-09-01T11:00:00Z', jsonb_build_object('shotType','dink','confidenceBand','normal','latencyMs',1,'blob', repeat('A', 1048576))" >/dev/null
r=$(probe_view obs_analysis_latency)
[[ "$r" == 0\|* ]] && report HELD hostile-huge-props "obs_analysis_latency survives a 1 MiB props row (no size cap exists on props — noted)" \
  || report BROKEN hostile-huge-props "1 MiB props row breaks obs_analysis_latency: ${r#*|}"
psql_super "$DB" -c "DELETE FROM analytics_event WHERE at = '2026-09-01T11:00:00Z'" >/dev/null

# --- Clock skew: event `at` far in the future / epoch 0 — views group by at,
# so a skewed client lands in a phantom bucket but nothing breaks.
psql_super "$DB" -c "INSERT INTO analytics_event (name, at, props) VALUES ('analysis_started','2999-01-01T00:00:00Z','{}'), ('analysis_started','1970-01-01T00:00:00Z','{}')" >/dev/null
r=$(psql_super "$DB" -t -A -c "SELECT count(*) FROM obs_analysis_hourly WHERE hour > now() OR hour < '2000-01-01'")
[[ "$r" == "2" ]] && report HELD clock-skew-buckets "future/epoch client timestamps land in phantom hourly buckets (2) rather than erroring; views never use ingested_at" \
  || report BROKEN clock-skew-buckets "unexpected: $r"

# --- Role probes (init-roles.sql). The views are created by the superuser
# with no GRANTs in views.sql — can the least-privilege roles read them?
if docker exec "$CONTAINER" psql -X -t -A -U pickle -d "$DB" -c "SELECT 1 FROM pg_roles WHERE rolname='pickle_ro'" | grep -q 1; then
  psql_super "$DB" -c "GRANT CONNECT ON DATABASE $DB TO pickle_ro, pickle_app, pickle_worker" >/dev/null
  ro=$(psql_as pickle_ro pickle_ro_password "SELECT count(*) FROM obs_analysis_hourly")
  if [[ "$ro" =~ permission\ denied ]]; then
    report HELD role-ro-no-grant "pickle_ro cannot read obs_* until an explicit GRANT (views.sql ships none): $ro"
  else
    report BROKEN role-ro-no-grant "pickle_ro can read obs_analysis_hourly without any GRANT: $ro"
  fi
  app=$(psql_as pickle_app pickle_app_password "CREATE OR REPLACE VIEW obs_crash_rate AS SELECT 1 AS hour")
  if [[ "$app" =~ (must be owner|permission denied) ]]; then
    report HELD role-app-cannot-redefine-view "pickle_app cannot redefine obs_crash_rate: $app"
  else
    report BROKEN role-app-cannot-redefine-view "pickle_app redefined obs_crash_rate: $app"
  fi
  ins=$(psql_as pickle_ro pickle_ro_password "INSERT INTO analytics_event (name, at, props) VALUES ('app_crash', now(), '{}')")
  [[ "$ins" =~ permission\ denied ]] && report HELD role-ro-cannot-insert "pickle_ro cannot insert analytics_event: $ins" \
    || report BROKEN role-ro-cannot-insert "pickle_ro inserted into analytics_event: $ins"
else
  echo "UNKNOWN role-probes :: init-roles.sql roles absent on this volume (old data dir) — role probes skipped"
fi

exit $verdict
