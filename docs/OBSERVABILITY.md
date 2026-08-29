# Observability (Gate 15)

Source of truth for privacy-safe telemetry, operational views, and alert
conditions. Companion artifacts (validated by
`packages/analytics/test/observability.test.ts`):

- `infra/observability/alerts.json` — versioned alert conditions.
- `infra/observability/views.sql` — SQL view definitions over the event stream.

## Event taxonomy

All telemetry flows through the typed `AnalyticsEvent` union in
`@pickle/analytics` (`packages/analytics/src/index.ts`). Gate 15 mandated
signals and where they are emitted:

| Signal                       | Event                                                                     | Emitter                        | Status                                         |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| Analysis started             | `analysis_started` (inferenceMode, modelVersion)                          | mobile pipeline                | contract shipped; mobile wiring per HANDOFF_V4 |
| Analysis completed + latency | `analysis_completed` (confidenceBand, latencyMs, modelVersion)            | mobile pipeline                | contract shipped                               |
| Analysis failed              | `analysis_failed` (failureKind, latencyMs, modelVersion)                  | mobile pipeline                | contract shipped                               |
| Abstention reason category   | `analysis_abstained` (reasonCategory)                                     | mobile pipeline                | contract shipped                               |
| Capture-envelope verdict     | `capture_envelope_verdict` (overall, failedDimensions, thresholdsVersion) | mobile capture                 | contract shipped                               |
| Target lock failure          | `target_lock_failed` (reason, algorithmVersion)                           | mobile capture                 | contract shipped                               |
| Event failure                | `event_proposal_failed` (reasonCategory)                                  | mobile pipeline                | contract shipped                               |
| Crash                        | `app_crash` (fingerprint, fatal)                                          | mobile crash handler           | contract shipped                               |
| Worker failure               | `worker_failure` (jobKind, failureKind)                                   | `services/media-worker`        | **wired + tested**                             |
| Queue backlog                | `queue_backlog` (queue, depth)                                            | `services/media-worker`        | **wired + tested**                             |
| API failure                  | `api_failure` (route template, method, statusCode, errorCode)             | `services/api` onResponse hook | **wired + tested**                             |
| Model version                | `modelVersion` field on analysis events                                   | —                              | contract shipped                               |
| Device/build version         | `appBuild`, `platform`, `deviceClass` on the event base                   | all emitters                   | contract shipped                               |

`ANALYTICS_EVENT_NAMES` is the runtime list of valid names; alert and view
definitions are tested against it so config can never reference a
nonexistent event.

## Privacy / redaction

`findPrivacyViolations()` structurally scans every event; `BufferedAnalytics`
refuses to buffer (and reports via counter/callback) any event containing:

- media/storage URI schemes (`file:`, `content:`, `ph:`, `s3:`, `blob:`, `data:`),
- filesystem paths, email addresses, base64-like blobs,
- forbidden keys (`uri`, `url`, `path`, `objectKey`, `email`, `phone`,
  `deviceId`, `idfa`, `stackTrace`, `rawFrame`, `imageData`, `videoData`,
  `poseFrames`, ...),
- oversized strings (>200 chars) or arrays (>32 items).

Regression coverage: `packages/analytics/test/redaction.test.ts`. Service
emitters additionally send only categorical values: the API hook logs route
_templates_ (never concrete URLs, query strings, bodies, or identities), and
the worker sends failure _categories_ (raw error text stays in worker logs).

## Ingestion status (honest disclosure)

There is no server-side analytics ingestion endpoint in the release
candidate: `BufferedAnalytics` accepts a pluggable transport; services
default to structured-log transport. The views in `views.sql` are the
committed, reviewed definitions for the `analytics_event` table described in
that file's header, to be installed with the ingestion migration. Until
ingestion ships, the same queries can be run over structured service logs.

## Alert conditions

Defined in `infra/observability/alerts.json` (see runbooks there). Families:

| Family                  | Alert id(s)                                                              | Severity      |
| ----------------------- | ------------------------------------------------------------------------ | ------------- |
| Crash spikes            | `crash-spike`                                                            | page          |
| Analysis-failure spikes | `analysis-failure-spike`, `abstention-spike`                             | page / ticket |
| Latency spikes          | `analysis-latency-spike`                                                 | ticket        |
| Backend errors          | `backend-error-spike`                                                    | page          |
| Queue backlog           | `queue-backlog-growth`, `worker-failure-spike`                           | ticket        |
| Security-sensitive      | `auth-failure-spike`, `consent-change-anomaly`, `account-deletion-spike` | page / ticket |
| Capture quality         | `target-lock-failure-spike`, `event-proposal-failure-spike`              | ticket        |

Thresholds are initial operating points; tuning is done by editing the
versioned JSON (reviewed change), never ad hoc in a dashboard. Rate alerts
require a minimum denominator so low-traffic windows cannot page. Trials are
counted per event/session — never per frame.
