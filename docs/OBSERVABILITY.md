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

**Deployment boundary:** production API v35 is still the baseline98 deployment.
The production migration ledger was checked on September 6, 2026 and already
contains `20260905190106_api_only_database_access`; its identifier and contents
must remain unchanged. The upstream audit migrations follow a different history,
including older pending entries. A plain `supabase db push` can therefore refuse
the reconciled history. Before any separately approved rollout, inspect
`supabase migration list` and `supabase db push --dry-run --include-all` against
the intended project. Apply only the reviewed missing migrations with
`supabase db push --include-all`, coordinated with the matching Edge deployment;
do not rename an applied migration or mark missing SQL as applied.

The forward integration migrations preserve late-permit/webhook behavior and
restore the permit predicate grant after either upgrade order. The RLS runner
checks fresh databases, the recorded production history, and the upstream audit
history before running the complete security matrix on each. This monitoring
change itself applies no production migrations and deploys nothing. Default
monitoring works with the existing public endpoints, but reports
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

### Edge served-bundle size and cold start (local measurement, H07-COLD-START)

`supabase/functions/api/index.ts` is the shipping backend and grew by ~1.5k
lines in the 2026-09-07 integration. The reproducible local measurement is
`tools/diagnostics/edge_cold_start.ts`, run from the repo root:

```bash
deno run -A tools/diagnostics/edge_cold_start.ts            # 3 cycles × (1 cold + 10 warm)
deno run -A tools/diagnostics/edge_cold_start.ts --cycles 5 --warm-requests 20 --out /tmp/ecs
deno test -A tools/diagnostics/edge_cold_start.ts           # self-tests + regressions (no Docker)
```

Scope: everything runs on the local machine. The hosted project
`ucqnaiwqwjtgvlduiuib` is never contacted; these numbers are NOT hosted-latency
evidence. Prerequisites: Deno 2.x, Node/npx (the pinned Supabase CLI is fetched
as `npx --yes supabase@2.117.0`; override with
`EDGE_COLD_START_SUPABASE_CLI_VERSION`), Docker, and network access for the
first image pull. Options: `--cycles N`, `--warm-requests N`, `--out DIR`
(default `artifacts/edge-cold-start/<UTC>`, git-ignored), `--startup-timeout-ms N`;
malformed values are usage errors (exit 2).

Method — three steps, each persisted to `report.json` as soon as it completes:

1. **Served bundle** — `deno bundle --config supabase/functions/api/deno.json
--platform deno -o <out>/supabase/functions/api/index.js supabase/functions/api/index.ts`
   (Deno's esbuild-backed bundler, honouring the function's import map and
   `deno.lock`; `npm:` dependencies are inlined; the lockfile is not rewritten).
   The bundler labels every inlined npm module with its path **relative to the
   cwd** — `// ../../.cache/deno/npm/registry.npmjs.org/tslib/2.8.1/tslib.js`
   comments and the matching `__commonJS({ "…"(exports, module) {` keys — so the
   raw output is a property of where the checkout sits relative to `$DENO_DIR`
   (VERIFIED: the same commit bundled from `/home/ubuntu/repos/Pickle-Sensei`
   and from a `/tmp` copy gives 1,033,186 B vs 1,033,690 B and different
   sha256). The script therefore resolves `DENO_DIR` (`deno info --json`), rewrites
   the cwd→`DENO_DIR` prefix to the literal `$DENO_DIR/` in the bundle text, and
   counts both the rewrites and any remaining outside-cwd label it could not
   attribute (`unresolved`; 0 on the recorded run — a non-zero count is printed
   as a WARNING and means that run's raw bytes/sha256 are not path-independent,
   while gzip bytes and module count stay comparable). Raw bytes, gzip bytes (Web
   `CompressionStream("gzip")`), module count and sha256 are computed over the
   **normalised** bytes, which identify (commit, `deno.lock`, Deno version) on any
   checkout path; the pre-rewrite byte count is recorded for reference only. This
   normalised file is also what the `bundle` serve target runs. Pinned by the
   self-test "bundle identity does not depend on the checkout path", which
   bundles the same sources from two directories and asserts equal size/sha256.
2. **Source graph** — `deno info --json --config supabase/functions/api/deno.json
supabase/functions/api/index.ts`: first-party (`file:`) module count/bytes and
   the npm packages in the graph, i.e. what `supabase functions deploy` uploads
   before the platform bundles it. `@types/node`/`undici-types` appear because
   `deno.json` `compilerOptions.types` pulls them in for type-checking; they are
   not runtime code.
3. **Cold start** — `npx --yes supabase@2.117.0 functions serve --no-verify-jwt`
   against the local stack. If `supabase_db_<project_id>` and
   `supabase_kong_<project_id>` are not both running the script starts the
   minimal stack it needs (`npx --yes supabase@2.117.0 start -x
gotrue,realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`;
   the exact command is printed and recorded in `report.json`
   `environment.stack`) and leaves it running — `npx --yes supabase@2.117.0 stop`
   tears it down. Each cycle removes
   `supabase_edge_runtime_<project_id>` (only if its
   `com.supabase.cli.project` label matches this project; a foreign container
   with that name aborts the run instead of being destroyed), spawns the CLI
   fresh, waits for the runtime main service (`GET
/functions/v1/_internal/health` → 200 through Kong on `[api] port` from
   `supabase/config.toml`), then times the FIRST `GET /functions/v1/api/healthz`
   — user-worker creation + module evaluation + handler — followed by N warm
   requests to the same worker. Two serve targets are attempted, `bundle` first:
   - `bundle` — a generated workdir (`<out>/workdir`) whose
     `[functions.api] entrypoint` is the normalised bundle from step 1. This is
     the target the exit code depends on.
   - `source-tree` — the repo checkout itself (what `supabase functions serve`
     from the repo root does). Comparison only.

Result semantics: exit 0 (`RESULT: measured`, `ok: true`) only when the bundle
was measured AND the `bundle` target produced a cold-start sample for every
requested cycle. A target whose CLI exits before the runtime is healthy is
`UNAVAILABLE` (0 cycles, the CLI's own message as `reason`); a target whose later
cycle fails is `PARTIAL` with every completed cycle kept. Neither counts as a
sample. `report.json` is written atomically (tmp + rename) after the bundle
step, the source-graph step, stack start and every completed cycle, so a run
that fails part-way still leaves the bundle metrics and every measured cycle
on disk with `ok: false` — only the exit code (1) signals failure. SIGINT,
SIGTERM and SIGHUP interrupt the whole spawned CLI tree (npx → sh → node) plus
its edge-runtime container, persist the report as `interrupted`, and exit
128+signal. A per-project lock in the OS temp dir refuses concurrent runs, an
existing `supabase functions serve` on the same port/container name aborts
the run instead of being measured, and the CLI's checkout side effects (the
tracked marker `supabase/.temp/cli-latest`, the `supabase/.branches/` directory)
are restored/removed on every exit path so a measurement never dirties the
checkout. Artifacts per run: `report.json`, the normalised bundle, the
generated workdir and one CLI log per serve cycle.

Recorded run (VERIFIED, `deno run -A tools/diagnostics/edge_cold_start.ts`,
exit 0, 2026-09-08, sources at `55d80326`, Linux x86_64, Deno 2.9.6, Supabase
CLI 2.117.0, Docker 29.7.2, `supabase-edge-runtime-1.74.3` (compatible with
Deno v2.1.4); report `artifacts/edge-cold-start/20260908T193622Z/report.json`;
two earlier runs of the same commit, `…/20260908T192141Z` and
`…/20260908T193247Z`, reproduced every bundle metric byte-for-byte and cold
medians of 58.06 / 55.42 ms):

| Measurement                                      | Value                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Served bundle (normalised raw)                   | 1,032,850 B (1008.6 KiB), 62 modules, sha256 `4d6cb2a82a12b8f31356699e5aa6ce3f50d1c883c1706b685caa93f76d4e6ce3`                                                      |
| Served bundle (gzip of normalised)               | 218,821 B (213.7 KiB)                                                                                                                                                |
| Path labels rewritten / unresolved               | 42 × `../../.cache/deno` → `$DENO_DIR/` / 0; pre-rewrite 1,033,186 B on this checkout                                                                                |
| Bundle time                                      | 80.78 ms                                                                                                                                                             |
| First-party source graph                         | 17 `file:` modules, 438,144 B (427.9 KiB)                                                                                                                            |
| npm packages in graph                            | 13 (`@supabase/supabase-js@2.112.4` + 6 transitive `@supabase/*`/`iceberg-js`/`tslib`, `jose@6.2.10`, `canonicalize@4.0.0`, type-only `@types/node`, `undici-types`) |
| Cold `GET /healthz` (`bundle` target, 3 cycles)  | min 55.79 / median 60.25 / max 93.99 ms                                                                                                                              |
| Warm `GET /healthz` (same worker, n=30)          | median 2.57 ms                                                                                                                                                       |
| CLI spawn → runtime healthy (container bring-up) | median 2065.95 ms (1753.52–2068.00)                                                                                                                                  |
| `source-tree` target                             | UNAVAILABLE — see below                                                                                                                                              |

Reading the numbers: the ~1 MiB bundle evaluates in well under 100 ms on this
machine once the container is up, so the 2026-09-07 growth of `index.ts` has
not made local cold start material; the dominant local cost is container
bring-up, a CLI/Docker cost that is not part of a hosted cold start. Hosted
cold start additionally includes the platform's eszip load and isolate
scheduling, which this method cannot observe — treat hosted latency as UNKNOWN
until measured from the hosted project's own logs (`api_request.durationMs`
covers only the handler, not the worker boot). Cold/warm samples are wall-clock
`fetch` timings through Kong on one machine; run more cycles before comparing
two commits, and compare medians.

Known limitation surfaced by the measurement (VERIFIED with CLI 2.117.0, present
on `55d80326` before this script existed): `supabase functions serve` on the
repo checkout exits before creating the runtime container with
`failed to read file: open packages/shared-types/src/techniqueBenchmark.js: no such file or directory`.
INFERRED from the CLI's behaviour: its import scanner matches import-map keys
against the raw specifier, so the relative `./techniqueBenchmark.js` /
`./errors.js` / `./domain.js` imports inside `packages/shared-types/src/*.ts`
are resolved literally instead of through the
`../../../packages/shared-types/src/*.js → *.ts` entries in
`supabase/functions/api/deno.json` that Deno itself applies (which is why
`deno bundle`, `deno info` and the in-process `__wf__` harness resolve the same
graph). Whether `supabase functions deploy` is affected has NOT been verified
here (UNKNOWN); making the source tree servable (e.g. `.ts` specifiers in
shared-types or relative keys in the function's import map) is a
`shared-types` / `edge-index` decision outside this measurement. The `bundle`
target is unaffected because the bundle has no unresolved imports.

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
