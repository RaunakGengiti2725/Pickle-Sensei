-- Operational views over the typed analytics event stream (Gate 15).
--
-- Ingestion contract: batches from @pickle/analytics BufferedAnalytics land
-- one row per event in:
--
--   CREATE TABLE analytics_event (
--     id         bigserial PRIMARY KEY,
--     name       text        NOT NULL,   -- AnalyticsEventName
--     at         timestamptz NOT NULL,   -- client event time
--     ingested_at timestamptz NOT NULL DEFAULT now(),
--     session_id text,                   -- opaque app-session id (no user id)
--     props      jsonb       NOT NULL    -- the event minus name/at/sessionId
--   );
--   CREATE INDEX analytics_event_name_at ON analytics_event (name, at);
--
-- NO ingestion endpoint exists yet (disclosed in docs/OBSERVABILITY.md); these
-- views are the committed, reviewed definitions the backend will install with
-- the ingestion migration. Every event name referenced here is validated
-- against ANALYTICS_EVENT_NAMES by packages/analytics/test/observability.test.ts.

-- ---------------------------------------------------------------------------
-- Analysis funnel + failure/abstention rates, hourly.
CREATE OR REPLACE VIEW obs_analysis_hourly AS
SELECT
  date_trunc('hour', at) AS hour,
  count(*) FILTER (WHERE name = 'analysis_started')   AS started,
  count(*) FILTER (WHERE name = 'analysis_completed') AS completed,
  count(*) FILTER (WHERE name = 'analysis_failed')    AS failed,
  count(*) FILTER (WHERE name = 'analysis_abstained') AS abstained
FROM analytics_event
WHERE name IN ('analysis_started', 'analysis_completed', 'analysis_failed', 'analysis_abstained')
GROUP BY 1;

-- Abstention reasons: category breakdown (never fine-grained machine codes).
CREATE OR REPLACE VIEW obs_abstention_reasons AS
SELECT
  date_trunc('day', at) AS day,
  props ->> 'reasonCategory' AS reason_category,
  count(*) AS n
FROM analytics_event
WHERE name = 'analysis_abstained'
GROUP BY 1, 2;

-- Analysis latency percentiles by model version and device class.
CREATE OR REPLACE VIEW obs_analysis_latency AS
SELECT
  date_trunc('hour', at) AS hour,
  props ->> 'modelVersion' AS model_version,
  props ->> 'deviceClass'  AS device_class,
  count(*) AS n,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY (props ->> 'latencyMs')::numeric) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (props ->> 'latencyMs')::numeric) AS p95_ms
FROM analytics_event
WHERE name = 'analysis_completed' AND props ? 'latencyMs'
GROUP BY 1, 2, 3;

-- Capture-envelope verdict distribution (capture-quality drift monitor).
CREATE OR REPLACE VIEW obs_envelope_verdicts AS
SELECT
  date_trunc('day', at) AS day,
  props ->> 'overall' AS overall,
  props ->> 'thresholdsVersion' AS thresholds_version,
  count(*) AS n
FROM analytics_event
WHERE name = 'capture_envelope_verdict'
GROUP BY 1, 2, 3;

-- Target-lock failures by reason and acquisition algorithm version.
CREATE OR REPLACE VIEW obs_target_lock_failures AS
SELECT
  date_trunc('day', at) AS day,
  props ->> 'reason' AS reason,
  props ->> 'algorithmVersion' AS algorithm_version,
  count(*) AS n
FROM analytics_event
WHERE name = 'target_lock_failed'
GROUP BY 1, 2, 3;

-- Event-proposal failures relative to capture volume.
CREATE OR REPLACE VIEW obs_event_proposal_failures AS
SELECT
  date_trunc('day', at) AS day,
  count(*) FILTER (WHERE name = 'event_proposal_failed') AS failed,
  count(*) FILTER (WHERE name = 'capture_started')       AS captures
FROM analytics_event
WHERE name IN ('event_proposal_failed', 'capture_started')
GROUP BY 1;

-- Crash rate by app build (fatal only), against app-open volume.
CREATE OR REPLACE VIEW obs_crash_rate AS
SELECT
  date_trunc('hour', at) AS hour,
  props ->> 'appBuild' AS app_build,
  count(*) FILTER (WHERE name = 'app_crash' AND (props ->> 'fatal')::boolean) AS fatal_crashes,
  count(*) FILTER (WHERE name = 'app_opened') AS app_opens
FROM analytics_event
WHERE name IN ('app_crash', 'app_opened')
GROUP BY 1, 2;

-- API failures by route template, status, and typed error code.
CREATE OR REPLACE VIEW obs_api_failures AS
SELECT
  date_trunc('hour', at) AS hour,
  props ->> 'route' AS route,
  (props ->> 'statusCode')::int AS status_code,
  props ->> 'errorCode' AS error_code,
  count(*) AS n
FROM analytics_event
WHERE name = 'api_failure'
GROUP BY 1, 2, 3, 4;

-- Worker failures by job kind and failure category.
CREATE OR REPLACE VIEW obs_worker_failures AS
SELECT
  date_trunc('hour', at) AS hour,
  props ->> 'jobKind' AS job_kind,
  props ->> 'failureKind' AS failure_kind,
  count(*) AS n
FROM analytics_event
WHERE name = 'worker_failure'
GROUP BY 1, 2, 3;

-- Queue backlog gauge (latest depth per queue per 5-minute bucket).
CREATE OR REPLACE VIEW obs_queue_backlog AS
SELECT
  to_timestamp(floor(extract(epoch FROM at) / 300) * 300) AS bucket,
  props ->> 'queue' AS queue,
  max((props ->> 'depth')::int) AS max_depth
FROM analytics_event
WHERE name = 'queue_backlog'
GROUP BY 1, 2;
