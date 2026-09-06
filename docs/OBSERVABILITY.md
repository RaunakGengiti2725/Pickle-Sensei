# Observability (Gate 15)

Source of truth for privacy-safe telemetry, operational views, and alert
conditions. Companion artifacts (validated by
`packages/analytics/test/observability.test.ts`):

- `infra/observability/alerts.json` — versioned alert conditions.
- `infra/observability/views.sql` — SQL view definitions over the event stream.

## Launch operations (current production)

The lean launch choice is **Apple's existing crash diagnostics + GitHub public
API probes + existing Supabase operational logs**. No new mobile crash/analytics
SDK, ingestion endpoint, user telemetry, or third-party alert service is added.
The Gate 15 taxonomy and alert definitions below are contracts, not evidence of
active production alerts. `services/api` is the older backend; the shipping app
calls `supabase/functions/api`.

### iOS crashes and camera reliability

- The release owner reviews **Xcode → Window → Organizer → Crashes** for the
  shipped version/build, and App Store Connect's TestFlight crash feedback and
  available crash metrics. Review daily during the first launch week and after
  every release. App Store diagnostics depend on users' existing Apple sharing
  opt-in; TestFlight has its own built-in diagnostics/feedback. Do not add an app
  prompt, force sharing, or export these reports into a new collector.
- **Symbolication is a manual release gate, not yet verified by this change.**
  For each distributed build, verify the effective Release setting is **DWARF
  with dSYM File**, retain the exact `.xcarchive` and matching app/framework
  `.dSYM` files privately, and include symbols when distributing to App Store
  Connect. Compare `dwarfdump --uuid` for the archived binary and its dSYM;
  different-build symbols do not work. Confirm a developer-owned test report
  resolves native frames in Organizer before relying on it. Existing Fastlane
  lanes use Release, but that alone is not proof that matching symbols were
  generated, retained, or uploaded. The mobile/build owner handles any necessary
  build-setting correction separately.
- Apple reports are delayed and incomplete. No reports does **not** mean zero
  crashes; native symbolication is not a JS/Hermes source-map pipeline, and
  nonfatal errors, hangs, frozen previews, or missed strokes may produce no
  crash report. After each build, use a tester-owned device and non-customer
  scenes to repeat camera open → record → stop/analyze → return, permission
  denial/recovery, and background/foreground recovery. Keep the device/camera
  checks in `PRELAUNCH_CHECKLIST.md`; do not upload court video or collect new
  per-user camera diagnostics to fill these gaps.

### Public backend monitor

`.github/workflows/production-monitor.yml` runs `scripts/monitor-production.mjs`
on hosted Ubuntu, from trusted `main` only, at minutes **7, 22, 37, 52 UTC** each
hour and through **workflow_dispatch**. There is no PR/push trigger, deployment,
customer credential, repository write permission, or automatic issue/email/Slack
integration. Failure notifications are GitHub's own workflow notifications.

Each run makes nine sequential requests to
`https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api`: GET/HEAD `/healthz`,
GET/HEAD `/support`, `/privacy`, `/terms`, and GET `/v1/me` with a deliberately
invalid **non-JWT, non-provider** bearer. That last probe must return a valid
401 error; it never calls bootstrap, exchanges provider tokens, or creates a
session. It proves rejection at the API boundary, **not Auth availability or
working sign-in/refresh**. Legal checks validate the document, not merely a 200.

Requests have an 8-second whole-request/body deadline, a 64 KiB body cap, no
redirect following and no retries. The job is capped at five minutes. The
stdout/job summary records only fixed check names, outcomes, HTTP statuses and
failure categories, never response bodies, headers, raw URLs, identifiers,
tokens or exceptions. A bad status (including 429), malformed response,
redirect or timeout fails the workflow. Local failure-path tests:
`node --test scripts/tests/monitor-production.test.mjs`.

**Deployment boundary:** production API v35 is still the baseline98 deployment;
the newer local API-only hardening migrations and matching Edge code must not be
deployed independently. This monitoring change applies no migrations and deploys
nothing. Default monitoring works with the existing public endpoints, but reports
**database_readiness: UNVERIFIED**, not passed. A green public run must never be
interpreted as proof of database, billing, authenticated sessions, or camera health.

After a separately approved, coordinated backend rollout, the new
`GET /healthz?readiness=1` can return
`{"ok":true,"readiness":{"database":true}}` (or 503 with both booleans false).
It makes a fresh read-only service-role `get_api_request_key()` RPC, validates
its result without returning/logging the credential, and caches only the verdict
for 30 seconds. The RPC has a two-second deadline and 128-byte response cap;
successes and failures are coalesced/cached per isolate, not fleet-wide. A
non-cooperative request remains coalesced even after timeout. The existing public
health rate budget still applies; normal GET/HEAD `/healthz` remains unchanged.
This verifies that critical database credential RPC, not every table/RLS policy,
Auth session, or RevenueCat/StoreKit operation.

Only **after that rollout**, set repository **Settings → Secrets and variables →
Actions → Variables → `PRODUCTION_MONITOR_READINESS` = `true`** and run the workflow
on `main`. The monitor requires the explicit boolean readiness field before
printing **VERIFIED**; a legacy static `{"ok":true}` fails the opted-in check.
Leaving the variable unset/`false` (or reverting it to `false`) explicitly reports
UNVERIFIED. Other values fail configuration validation; disabling the check is
not incident resolution.

### Activation, notification owner and failure response

1. An authorized owner must review and push/merge these files to default branch
   `main`, ensure Actions/schedules are enabled, and manually run **Actions →
   Production Monitor → Run workflow → main**. No push, merge, dispatch or
   notification delivery is performed by this implementation. The default run
   must show nine public results and the separate UNVERIFIED database row.
2. The responsible owner must watch this repository and choose **personal GitHub
   Settings → Notifications → System → Actions → Email (and optionally On GitHub)
   → Only notify for failed workflows → Save**, with a verified, monitored email
   address. Scheduled failure notifications go to the user who **last changed the
   cron syntax**, not automatically to every repository owner. Ensure that is the
   responsible active owner rather than a bot/unmonitored account. Manual runs
   notify their triggering user according to preferences. Notification settings
   and actual delivery must be verified by the owner before relying on alerts;
   local tests do not verify them. See GitHub's
   [notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)
   and [schedule rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
3. On failure, inspect the fixed-category job summary, then a bounded recent
   window (e.g. 15 minutes) of **Supabase → Edge Functions → api → Logs** and
   platform status. Reuse existing `evt=api_request` status/duration/error-code
   fields to investigate sustained 5xx and latency. Keep raw function logs
   restricted; do not copy request paths, user identifiers, credentials or raw
   error detail into tickets. These logs are not automatically watched for every
   user-specific failure by the public probes. Re-run once to confirm recovery;
   do not create a retry/probe storm or deploy/rollback either backend half alone.
4. Check that scheduled runs are still arriving during daily launch review.
   GitHub schedules can be delayed/dropped, Actions outages/budgets can stop them,
   and public-repository schedules are disabled after 60 days of inactivity.
   There is no independent missed-heartbeat alert, guaranteed 15-minute detection,
   or automatic alert for crashes/user-specific backend failures in this lean setup.

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
