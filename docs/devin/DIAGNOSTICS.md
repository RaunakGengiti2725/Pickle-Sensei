# DIAGNOSTICS — how a session inspects the REAL system without guessing

Bootstrap artifact (observability stream, 2026-09-04). Every claim below is tagged:

- **VERIFIED** — a command was executed on Ubuntu 22.04 in this repo and the result is
  quoted (exit code / summary).
- **INFERRED** — read from source with a file reference; not executed against a live
  system.
- **UNKNOWN** — no evidence in the repo and nothing executable here; do not assume.

Companion files this document owns/depends on:

- `tools/diagnostics/local_api_probe.mjs` — Node-only probe for the LOCAL Fastify API.
- `tools/diagnostics/edge_error_taxonomy.ts` — Deno probe that runs the REAL Edge Function
  handler in-process under the `__wf__` test doubles.
- Source of truth for telemetry semantics: `docs/OBSERVABILITY.md`,
  `infra/observability/{alerts.json,views.sql}`, `packages/analytics/src/index.ts`.

---

## 0. Which system are you looking at? (read this first)

There are FOUR evidence sources and they are not interchangeable. Mixing them up is the
main way a session "diagnoses" the wrong thing.

| Surface                          | What it is                                                                                   | Is it production?                                   | Where evidence lives                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Supabase Edge Function `api`** | `supabase/functions/api/index.ts` (Deno). The backend the shipped iPhone app calls.          | **YES** (project `ucqnaiwqwjtgvlduiuib`)            | Supabase Dashboard logs (needs access, §2), Postgres tables (needs DB access, §4.6), the client's response. |
| **Legacy/local Fastify API**     | `services/api/src/**`. Older implementation; `AGENTS.md`: "the mobile app does not call" it. | **NO** — local dev / CI only                        | Its own stdout (structured), `x-request-id`, `/v1/health/slo`, local Postgres.                              |
| **Mobile app (RN 0.87)**         | `apps/mobile/src/**`. Pose runs on-device; telemetry recorders are in-memory.                | Yes, but you have no device here                    | Jest tests on Linux; Xcode/device logs ONLY on the self-hosted M4 runner (never claim Mac results).         |
| **SQL views + alerts**           | `infra/observability/views.sql`, `alerts.json` over a conceptual `analytics_event` table.    | **NOT WIRED** — no ingestion endpoint exists (§1.3) | Committed definitions only. They prove intent, not live health.                                             |

**VERIFIED** `AGENTS.md` + `docs/OBSERVABILITY.md` §"Status" both state the SQL views target a
table no service currently writes ("There is no server-side analytics ingestion endpoint in
the release candidate"). Treat every "dashboard" statement in older docs as a design, not a
running system.

---

## 1. Telemetry contract (what CAN be emitted, by whom)

### 1.1 Event vocabulary — INFERRED from `packages/analytics/src/index.ts`

Typed `AnalyticsEvent` union; every event carries `appBuild`, `platform`, `deviceClass`
and an opaque session id. Names: `analysis_started`, `analysis_completed`,
`analysis_failed`, `analysis_abstained`, `capture_envelope_verdict`, `target_lock_failed`,
`event_proposal_failed`, `app_crash`, `worker_failure`, `queue_backlog`, `api_failure`.
Analysis events carry `modelVersion`, `latencyMs`, `confidenceBand`, `failureKind`,
`reasonCategory` (categorical only).

Redaction (`packages/analytics`): rejects media/storage URI schemes, filesystem paths,
emails, base64-looking blobs, oversized strings/arrays, and the forbidden keys `uri`,
`url`, `path`, `objectKey`, `email`, `phone`, `deviceId`, `idfa`, `stackTrace`,
`rawFrame`, `imageData`, `videoData`, `poseFrames`. Anything you add to diagnostics output
must pass the same bar (§6).

### 1.2 Who actually emits today

| Emitter                         | Mechanism                                                                                                                                                                                         | Reaches an operator?                                        | Evidence                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Fastify (`services/api`)        | `onResponse` hook → `api_failure` for 5xx/401/403 + `ApiSloRecorder.recordRequest`                                                                                                                | Only as process stdout (structured log transport)           | INFERRED `services/api/src/app.ts:200-252`                                                                                                      |
| media-worker                    | `BufferedAnalytics` whose transport is `console.error("[media-worker] analytics …")`                                                                                                              | stdout only                                                 | INFERRED `services/media-worker/src/main.ts:17-19`                                                                                              |
| Edge Function (production)      | **No `@pickle/analytics` import.** `console.error/warn` with `[api]` prefix on failures.                                                                                                          | Only via Supabase function logs (§2)                        | VERIFIED: `rg '@pickle/analytics' --glob package.json` lists only `services/api`, `services/media-worker`                                       |
| Mobile                          | `stabilitySlo` (`apps/mobile/src/analysis/stabilityTelemetry.ts`) and `usabilityFunnel` (`usabilityTelemetry.ts`) — **in-memory recorders; nothing reads `.events()`/`.metrics()` outside tests** | **No.** Never leaves the process.                           | VERIFIED: `rg '\.metrics\(\)\|\.events\(\)' apps/mobile/src -g '!**/__tests__/**'` → 0 hits                                                     |
| Mobile → server (consent-gated) | `recordEvaluationTrial` → durable outbox → `POST /v1/me/evaluation/trials` → `public.evaluation_trials.payload` jsonb                                                                             | Yes, but ONLY when `evaluation_telemetry` consent is active | INFERRED `apps/mobile/src/analysis/runCaptureAnalysis.ts:152-170`; table in `supabase/migrations/20260829140000_permits_sync_consent.sql:78-83` |

### 1.3 SQL views & alerts — INFERRED, NOT LIVE

`infra/observability/views.sql` defines `obs_*` views (`obs_analysis_latency` p50/p95 by
`modelVersion`/`deviceClass`, `obs_api_failures` by route template/status/code,
`obs_queue_backlog`, crash rate, abstention reasons…). `infra/observability/alerts.json`
(`observability-alerts-v1`) defines thresholds (e.g. `backend-error-spike`: >25
`api_failure` ≥500 in 10 min; `analysis-latency-spike`: p95 > 60 s over 1 h with ≥20
events). **There is no `analytics_event` table in `supabase/migrations/`** (VERIFIED:
`rg analytics_event supabase/migrations` → no hits), so these cannot be queried anywhere
today. Use them as the schema to aim for, never as evidence.

---

## 2. Reading production Edge Function logs (Supabase)

**What the logs contain — INFERRED from `supabase/functions/api/index.ts`:**

- Every 5xx path calls `serviceUnavailable(context, detail)` (index.ts:153-160):
  `console.error("[api] <context>:", detail)` then a **generic** 503 body
  `{ error: { message: "<context> is temporarily unavailable. Please try again." } }`.
  The DB error string / stack is ONLY in the function log, never in the response.
- Unhandled exceptions: `console.error("[api] unhandled error:", error)` (index.ts:2803)
  → generic 500.
- Other `[api]` log lines: shot sync RPC failed (1243), evaluation trial write failed
  (1532), webhook lookup/log/persist failed (2271/2287/2314), account deletion warnings
  (2530, 2629, 2737). `grep '[api]'` isolates handler output from platform lines.
- Coded 4xx errors (`codedError`, index.ts:164) are returned to the client as
  `{ error: { code, message } }` and are **not logged**.

**How to get at them — access you must have (do NOT assume it exists):**

1. Supabase Dashboard → project `ucqnaiwqwjtgvlduiuib` → Edge Functions → `api` → Logs
   (also Logs Explorer). Requires a Supabase account that is a member of the project's
   organization. **UNKNOWN** whether any Devin identity has this; nothing in the repo or
   environment grants it. Ask the owner; never try to log in with borrowed credentials.
2. Supabase CLI. **VERIFIED** with `npx --yes supabase@latest --version` → `2.116.0` and
   `supabase functions --help`: subcommands are `list, delete, download, deploy, new,
serve`. **There is NO `supabase functions logs` subcommand in this CLI version** — do not
   put it in runbooks. What the CLI does need for anything remote:
   - an access token: `supabase login` (browser) or `supabase login --token <PAT>` /
     `SUPABASE_ACCESS_TOKEN` env (a Personal Access Token created at
     app.supabase.com → Account → Access Tokens by a project member);
   - a linked project: `supabase link --project-ref ucqnaiwqwjtgvlduiuib` (prompts for the
     DB password for `inspect db` / `db` commands; `--password` flag exists).
   - `supabase inspect db <db-stats|locks|blocking|outliers|calls|long-running-queries|
index-stats|table-stats|…>` (VERIFIED subcommand list) is the CLI's live-DB
     diagnostic surface — needs the linked project + DB password. **Read-only, but it is
     production**: only run with explicit human go-ahead.
3. Management API (`GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all?sql=…`
   with a PAT) — **INFERRED from Supabase public docs, not verified here.** Only reach for
   it if the Dashboard is unavailable; still requires the same PAT.

**Healthy signal:** log stream shows platform boot lines and occasional `[api] account
deleted:` warnings; no `[api] … :` error lines. **Unhealthy:** repeated
`[api] <context>: <postgres error>` (a 42501 here means a missing column grant — see
`AGENTS.md` "Defense in depth": "every 42501 shows up as a 503"), or
`[api] unhandled error:` lines (a bug reached the outer catch).

---

## 3. Correlation / request ids — how they flow (or don't)

| Hop                      | Request id present?                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile → any API         | **No.** Sends `content-type`, `authorization`, `x-client-version` only.                                                                                                                                                                                                                                                                                                                  | INFERRED `apps/mobile/src/data/api.ts:84`; VERIFIED `rg 'x-request-id\|requestId' apps/mobile/src -g '!**/__tests__/**'` → only an unrelated React `requestIdRef` in DrillLibraryScreen |
| Edge Function → response | **Yes.** `x-request-id` on EVERY response: a well-formed client id (`[A-Za-z0-9._-]{8,64}`) is echoed, anything else is replaced by `crypto.randomUUID()` (`http.ts resolveRequestId/withRequestId`).                                                                                                                                                                                    | VERIFIED `tools/diagnostics/edge_error_taxonomy.ts`: "x-request-id on 15/15 responses"; `__wf__/request_id_test.ts` (echo / malformed / 204)                                            |
| Edge Function → its logs | One JSON access line per request on stdout: `{"evt":"api_request","requestId","method","route","status","durationMs","code"?}` (route template only — UUID/digit segments → `:id`; no user id, IP, query, body). The `[api] <context>: <detail>` error line for a 5xx is emitted by the same isolate immediately before it; `[api] unhandled error (<requestId>)` carries the id inline. | VERIFIED `edge_error_taxonomy.ts` "15/15 correlated" (access line id = header id, status and `code` match the response); `request_id_test.ts` asserts no bearer/query/uuid in the line  |
| Edge Function → Postgres | Nothing propagated. PostgREST/RPC calls carry the user's JWT, not a trace id.                                                                                                                                                                                                                                                                                                            | INFERRED (no `application_name`/comment plumbing anywhere in index.ts)                                                                                                                  |
| Supabase gateway         | The platform may add its own request id header at the gateway; the handler does not read or log it.                                                                                                                                                                                                                                                                                      | **UNKNOWN** — cannot be observed from Linux without hitting production                                                                                                                  |
| Local Fastify            | **Yes, end to end.** `genReqId` = incoming `x-request-id` or `randomUUID()`; echoed on every response header and in `error.requestId`.                                                                                                                                                                                                                                                   | INFERRED `services/api/src/app.ts:161,252`; VERIFIED `local_api_probe.mjs`: 12/12 probes echoed our id in header AND body; 27 of 42 server stdout lines carried our ids                 |

Consequence: in production, filter Function logs by the `x-request-id` the client
received (`"requestId":"<id>"`) to get the access line (route/status/code/latency), then
read the `[api] …:` error line directly above it for the server-side detail. The mobile
app does not yet SEND an id (gap G2), so today the id must be read off the failing
response (device logs / a reproduction with `curl -H 'x-request-id: repro-…'`).

---

## 4. Diagnosis map — symptom → where → command → healthy vs unhealthy

Conventions: `$EDGE = https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api` (do not hit
it without a human go-ahead; the only safe unauthenticated call is `GET $EDGE/healthz`).
`$LOCAL = http://127.0.0.1:3001`. Local DB DSNs are in `.env.example` (dev) and
`docs/LOCAL_DEVELOPMENT.md` (`DATABASE_URL_APP`/`DATABASE_URL_WORKER` fallbacks).

### 4.1 Backend errors

| Step      | Production (Edge)                                                                                                                                                                                                       | Local (Fastify)                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Symptom   | App shows "temporarily unavailable" / retry; sync stalls with 5xx                                                                                                                                                       | Same on :3001                                                                                                                       |
| Where     | Function logs (§2). Response body is deliberately generic.                                                                                                                                                              | Process stdout + response body                                                                                                      |
| Command   | Dashboard → Edge Functions → api → Logs, filter `[api]`. Reproduce the taxonomy locally: `~/.deno/bin/deno run -A --no-check --config supabase/functions/api/__wf__/deno.json tools/diagnostics/edge_error_taxonomy.ts` | `docker compose up -d postgres redis && node tools/diagnostics/local_api_probe.mjs --start --with-account` (VERIFIED exit 0, 12/12) |
| Healthy   | No `[api] … :` error lines; access lines show 2xx/4xx only; probe prints `PASS: 15/15 probes matched, 15/15 correlated` (VERIFIED exit 0)                                                                               | Probe `PASS`; every failure has `kind/code/retryable/requestId`                                                                     |
| Unhealthy | `[api] <context>: <pg error>` (503 to client), `[api] unhandled error:` (500), or a probe `FAIL` line = handler contract drifted                                                                                        | `kind: "transient"` with `api.datastore_unavailable` (DB down), `api.internal_error` (bug)                                          |

Error-code taxonomy (VERIFIED by static scan in the edge probe, 32 codes in `index.ts` +
`rate_limited` in `rateLimit.ts`): `access.*` (paywall_required, permit_not_found,
permit_already_finalized), `validation.*` (refresh, analysis_permit, …_finalize,
shots_sync, session, consent_grant/withdraw, evaluation_trials, analysis_feedback,
saved_drill, account_deletion), `auth.apple_authorization_*`, `account.deletion_*`,
`session.*`, `analysis.*`, `evaluation.*`, `billing_unconfigured|billing_unavailable`,
`drill.not_found`, `training.plan_unavailable`. 401/404/413/500/503 bodies carry **no
code** (`{error:{message}}` only). Fastify's taxonomy (`services/api/src/lib/replies.ts`) is
different (`auth.missing_token`, `validation.path_id`, `api.rate_limited`, …) — never
compare the two.

### 4.2 API requests (what was asked, what came back)

- **Production**: per-request visibility is **UNKNOWN/limited** — function logs show only
  error lines; there is no access log with route/status per request in the repo. The
  gateway's own request logs (Dashboard → Logs → Edge Functions) are the only source;
  `x-client-version` is the only client-provided context.
- **Local**: every request is logged by Fastify with `reqId` (`app.ts:161`) and SLO'd.
  `curl -sS -H 'x-request-id: diag-1' $LOCAL/v1/health -i` → `x-request-id: diag-1`
  echoed (VERIFIED via probe). Full route list: `curl $LOCAL/v1/openapi.json`.
- **Rate limiting** (production, INFERRED `rateLimit.ts`): 429 with `Retry-After`,
  `RateLimit-Limit`, `RateLimit-Remaining` (VERIFIED locally: probe "rate limited (auth
  refresh budget)" → `retry-after=34 ratelimit-limit=30 ratelimit-remaining=0`). Without
  Upstash env the limiter is per-isolate memory (`rateLimit.ts:3,26-43`) — a 429 seen by
  one user may not reproduce.

### 4.3 Analysis jobs & permits

- Symptom: "free rating spent but no result", "can't start rating", paywall shown
  unexpectedly.
- Where: `public.analysis_permits` (status `reserved|finalized|released`, outcome
  `scored|low_confidence|cancelled|failed|unsupported|incorrect_recognition|expired`,
  `unique(user_id, idempotency_key)`) — INFERRED
  `supabase/migrations/20260829140000_permits_sync_consent.sql:35-50`. Access math is
  `access_state()` / `lifetime_scored_count()` (AGENTS.md "Scale & security").
- Query (needs DB access; **production only with go-ahead**, otherwise run against local
  `pickle_dev` after `migrate`):
  ```sql
  select status, outcome, count(*) from public.analysis_permits
   where created_at > now() - interval '24 hours' group by 1,2 order by 3 desc;
  -- stuck holds: reserved > 1h (pg_cron 'expire-stale-analysis-permits' releases at 24h, hourly at :17)
  select count(*) from public.analysis_permits where status='reserved' and created_at < now() - interval '1 hour';
  ```
- Healthy: reserved rows age out within the analysis window; `finalized` dominates.
  Unhealthy: growing `reserved` older than 1 h (client never finalized → sync outbox
  stuck, §4.10), or many `released/failed`.
- Local reproduction of the server contract: edge probe cases "permit reserve
  paywalled" (402 `access.paywall_required`), "accepted" (200), "RPC missing" (503
  generic), "finalize unknown id" (404 `access.permit_not_found`) — VERIFIED.

### 4.4 Pipeline stages & stage timing

- **Production/device**: only ONE number exists — `latencyMs` of the whole
  `runCaptureAnalysis` (`runCaptureAnalysis.ts:134,161`), and it is persisted only in a
  consent-gated `evaluation_trials.payload` row. There is **no per-stage timing**
  (pose read → envelope validation → fusion providers → scoring) anywhere — VERIFIED
  `rg 'stage|durationMs|performance.now' packages/analysis-pipeline/src/analyzeCapture.ts`
  → 0 hits. Gap G3.
- **Linux trend data**: `tools/latency-bench/bench_e2e.py` → records labelled
  `LINUX_BENCH_NOT_DEVICE`, summarised by `pnpm --filter @pickle/latency-slo …`
  (`tools/latency-slo/README.md`, thresholds ideal ≤2000 / strong ≤3000 / max ≤5000 ms at
  p95). These are analysis-stage CPU numbers, **never iPhone evidence**.
- Healthy/unhealthy can only be judged on device via `tools/iphone-trials` (BLOCKED:
  no device).

### 4.5 Provider / model versions

- Every synced shot carries a mandatory `versionVector` with exactly these keys
  (INFERRED index.ts:899-908): `appVersion, modelBundleVersion, poseModelVersion,
paddleModelVersion, strokeDetectorVersion, phaseModelVersion, scoringModelVersion,
shotConfigVersion`; persisted verbatim into `public.shots` columns
  (`app_version, model_bundle_version, pose_model_version, …`, ≤64 chars each,
  `20260831160000_defense_in_depth.sql:192-194`).
- Query:
  ```sql
  select app_version, pose_model_version, scoring_model_version, result_kind, count(*)
    from public.shots where captured_at > now() - interval '7 days'
   group by 1,2,3,4 order by 5 desc;
  ```
- Healthy: a small set of versions per app build; `low_confidence` share stable across
  versions. Unhealthy: a new `scoring_model_version` with a jump in `low_confidence`.
- Client-side provider ids (`trigger.temporal-heuristic`, `trigger.imported-full-clip`,
  `ball_tracker_not_installed`) are in `runCaptureAnalysis.ts:237-322` but are **not** sent
  anywhere except inside the version vector / evaluation trial payload.

### 4.6 Database state

- **Local (VERIFIED path)**: `docker compose up -d postgres postgres_test redis`; migrate
  - seed per `docs/LOCAL_DEVELOPMENT.md`; then
    `psql postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev`. Fastify
    `/v1/health/slo` probes the DB (`SELECT 1`) and reports `dbLatency`, pool, queue depth
    (VERIFIED: probe line `health/slo 200`, summary `requests=… db_p95=…ms pool=…`).
- **Production**: `supabase inspect db …` after link (§2) or Dashboard → Table editor /
  SQL editor. Tables that matter: `profiles, sessions, shots, shot_phases,
shot_measurements, shot_checkpoints, captures, analysis_permits, consent_records,
evaluation_trials, analysis_feedback, billing_entitlements, webhook_events,
free_rating_ledger, account_deletion_requests`. pg_cron jobs (INFERRED
  `20260831000000_scale_and_security.sql:361-378`): `expire-stale-analysis-permits`
  (`17 * * * *`), `purge-expired-deletion-requests` (`23 3 * * *`),
  `purge-old-webhook-events` (`41 4 * * *`). Check they ran:
  `select jobname, last_run_started_at, last_run_status from cron.job_run_details …`
  (INFERRED pg_cron schema; verify column names on the target).
- Schema truth: `./supabase/tests/run_rls_tests.sh` applies every migration on a fresh
  Postgres and asserts grants/RLS (needs Docker). A 503 whose log detail is `42501` means
  the grant matrix is behind the code (AGENTS.md).

### 4.7 Auth state (session vault / refresh flow)

- Contract (INFERRED `AGENTS.md` "Auth sessions", `apps/mobile/src/account/*`):
  bootstrap spends the provider id token once → `{accessToken, refreshToken, expiresAt}`;
  refresh token lives in Keychain service `com.picklesensei.auth.session`
  (`sessionVault.ts:19`), access token only in memory (`apiSession.ts`);
  `sessionKeeper.ts` refreshes `REFRESH_LEAD_MS=60_000` before expiry, on foreground when
  `< 5 min` remain (`FOREGROUND_LEAD_MS`), retries with backoff up to `RETRY_MAX_MS=5 min`;
  the ONLY implicit sign-out is a non-retryable 401/403 from `POST /v1/auth/refresh`.
- Where to look: on device — Xcode console / `sessionKeeper` behaviour (not available on
  Linux). Server — auth cache (`cache.ts`, L1 + optional Upstash L2, TTL ≤600 s bounded by
  token expiry; Redis ops `AbortSignal.timeout(REDIS_TIMEOUT_MS)`, failures → `null`);
  Supabase Dashboard → Authentication → Users/Sessions; `auth.sessions` /
  `auth.refresh_tokens` via SQL (needs DB access).
- Local probes (VERIFIED): edge probe "auth refresh without refreshToken" → 400
  `validation.refresh`; "rate limited (auth refresh budget)" → 429 `rate_limited`;
  Fastify probe `missing bearer 401 auth_failed/auth.missing_token`, `malformed bearer 401
auth_failed/auth.invalid_token`, `authed, no account 401 auth_failed/auth.no_account`.
- Healthy: users stay signed in across app restarts; refresh 401s are rare. Unhealthy: a
  spike of refresh 401s (alert `auth-failure-spike` is DEFINED but not wired), or users
  reporting sign-outs → suspect refresh-token rotation failure, Keychain read failure
  (`sessionVault.ts` degrades to "nothing persisted"), or clock skew.
- Regression pins to run on Linux: `cd apps/mobile && npx jest --silent
__tests__/authDurableSession.test.ts`.

### 4.8 Storage & uploads

- **Production has no media upload path.** Pose runs on device; the Edge Function has no
  storage-bucket code (VERIFIED `rg 'storage|bucket' supabase/functions/api/index.ts`
  hits only comments). `public.captures` stores metadata (duration, fps, mode,
  evidence_status, status `awaiting_model|analyzed`) — INFERRED
  `20260829120000_progress_data.sql:170-190`. There is nothing to inspect in object
  storage for the shipped app.
- **Legacy stack only**: `services/media-worker/src/objectStore.ts` (S3 delete/list via
  `S3_MEDIA_BUCKET`), `services/api/src/modules/media`. Worker health = its stdout
  (`[media-worker] …`, `deletionBacklog`, `worker.ts:412-510`). Not production.
- Consent-gated `evaluation_trials` upload is the only client→server "upload" and is
  JSON, via the outbox (§4.10).

### 4.9 Crashes

- No crash SDK (VERIFIED `rg 'ErrorUtils|setJSExceptionHandler|crashlytics|Sentry'
apps/mobile/src` → 0 hits). `stabilityTelemetry.ts` provides retroactive previous-run
  classification (`crash | clean_exit | memory_pressure_termination |
unknown_termination`, `classifyPreviousRun`/`recordPreviousRunOutcome`, lines 105-150),
  but **no non-test code calls `recordPreviousRunOutcome`** (VERIFIED grep) and the
  recorder is in-memory. Production crash rate today: **UNKNOWN** except via App Store
  Connect → Crashes / Xcode Organizer (human, Mac, ASC access — out of scope here).
- Alert `crash-spike` exists in `alerts.json` but has no data source. Gap G4.

### 4.10 Network failures & sync outbox

- Client: `API_REQUEST_TIMEOUT_MS = 20_000` → typed `network.timeout` (`api.ts:64-93`).
  Outbox: SQLite `pickle-sensei.db` table `outbox(id, owner_key, kind, payload, attempts,
created_at, last_error)` + `sync_receipt` (`db.ts:61-75`); `OUTBOX_MAX_ATTEMPTS = 8` for
  permanent failures, transient (network/429/5xx/auth-refreshable) never consumes attempts
  (`sync.ts:64-119`); ordering sessions before shots; drained on foreground/timer with
  jittered backoff (`syncRuntime.ts`).
- Where to look on device (Mac only): the app's SQLite via Xcode container download →
  `select kind, attempts, last_error, created_at from outbox order by id;`. **Not
  possible on Linux**; on Linux run the pins:
  `cd apps/mobile && npx jest --silent src/data`.
- Server side: a stuck outbox shows as `analysis_permits.status='reserved'` ageing (§4.3)
  and missing `shots` rows for recent `captures`.
- Healthy: outbox empty within a minute of connectivity. Unhealthy: rows with
  `attempts ≥ 8` (permanent server rejection — read `last_error`, it holds the typed code
  such as `validation.shots_sync`), or `attempts = 0` forever (drain never scheduled).

### 4.11 Latency

- Production server latency: **UNKNOWN** — no per-request timing is emitted by the Edge
  Function; the Dashboard's function-invocation metrics are the only source (needs
  access). Client-perceived analysis latency: only `evaluation_trials.payload->>'latencyMs'`
  for consenting users:
  ```sql
  select percentile_disc(0.5) within group (order by (payload->>'latencyMs')::int) p50,
         percentile_disc(0.95) within group (order by (payload->>'latencyMs')::int) p95, count(*)
    from public.evaluation_trials where created_at > now() - interval '7 days'
     and payload ? 'latencyMs';
  ```
  (INFERRED payload shape from `apps/mobile/src/evaluation/trialCapture.ts:40,153`;
  verify the key exists before trusting the number.)
- Local Fastify: `/v1/health/slo` → `latency.p95`, `dbLatency.p95`, evaluations
  (`met|breached|not_evaluable` from `packages/slo/src/index.ts:140`). VERIFIED via probe summary line.
- Linux benches: §4.4. Thresholds: `tools/latency-slo/README.md`.

### 4.12 Test-account flows

- **Local Fastify**: HS256 dev tokens, issuer `pickle-dev`, `DEV_AUTH_SECRET` ≥16 chars
  (`services/api/src/auth/tokens.ts`). `local_api_probe.mjs --start --with-account` mints
  one for a random subject, bootstraps `/v1/account/bootstrap`, then `GET /v1/me` —
  VERIFIED 200/200. The secret is generated per run and never printed.
- **Edge Function locally**: `__wf__/routesHarness.ts` fakes Google/Apple id tokens
  (`fakeGoogleIdToken`, `TEST_USER_ID = 1111…`) against stubbed Supabase Auth. Run
  `(cd supabase/functions/api/__wf__ && deno task test)` for the full matrix or the edge
  probe for the error taxonomy. No real account is created.
- **Production**: sign-in is Apple/Google only; purchases use StoreKit sandbox testers
  created in App Store Connect (AGENTS.md "Billing"). Whether a dedicated reviewer/demo
  account exists: **UNKNOWN** from the repo (`docs/APP_STORE_CONNECT_PUBLISHING_GUIDE.md`
  describes the requirement only). Never create or exercise accounts on production
  without explicit go-ahead.

### 4.13 CV intermediate stages

- On device the pose sequence is written as a `pickle.pose-sequence.v1` sidecar at
  capture time and re-read + SHA-256-verified before analysis (`camera/capture.ts:543-965`,
  `runCaptureAnalysis.ts:201-229`). Envelope verdicts (`packages/shared-types/src/captureEnvelope.ts`,
  e.g. `timing_stability`) are computed but only surfaced to the user and — for consenting
  users — inside the evaluation trial payload.
- Nothing intermediate (keypoint frames, paddle boxes, stroke events) is exported to any
  operator surface; the analytics redaction FORBIDS `poseFrames`/`rawFrame` by design.
  Diagnosis of a wrong verdict therefore requires the user's sidecar via an explicit
  consent flow (`evaluation_telemetry`) or a local re-run:
  `python3 tools/latency-bench/linux_pose_extract.py …` + `packages/swing-lab` benches on
  committed clips (Linux, not device). Gap G5.

---

## 5. Diagnostic tooling shipped with this document (VERIFIED)

| Tool                                       | Command                                                                                                                                 | Result in this session                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/diagnostics/edge_error_taxonomy.ts` | `~/.deno/bin/deno run -A --no-check --config supabase/functions/api/__wf__/deno.json tools/diagnostics/edge_error_taxonomy.ts [--json]` | exit 0, `PASS: 15/15 probes matched, 15/15 correlated` (`x-request-id` on every response and a matching `api_request` access line with the same status/`code`); 1 captured handler error line (`[api] Rating reservation: rpc reserve_analysis_permit not stubbed`) proving 503 detail goes to logs only; 33 static codes. Exit 1 if either the taxonomy or the correlation contract drifts |
| `tools/diagnostics/local_api_probe.mjs`    | `node tools/diagnostics/local_api_probe.mjs --start --with-account [--json]` (needs `docker compose up -d postgres redis` + migrate)    | exit 0, `PASS: 12/12 probes matched`; every response echoed `x-request-id` in header and typed body; 27/42 server log lines carried our ids                                                                                                                                                                                                                                                 |
| same, no server running                    | `API_BASE_URL=http://127.0.0.1:3999 node tools/diagnostics/local_api_probe.mjs`                                                         | exit 2, `UNAVAILABLE: 0/10 probes matched, 10 unavailable` — unavailable is never reported as pass                                                                                                                                                                                                                                                                                          |
| same, server running, no `DEV_AUTH_SECRET` | `node tools/diagnostics/local_api_probe.mjs --start`                                                                                    | exit 0, `PASS: 10/10` (authenticated probes only run with `--with-account`/a known secret)                                                                                                                                                                                                                                                                                                  |

`--no-check` is required because `index.ts` has pre-existing untyped-supabase-client type
errors (AGENTS.md; VERIFIED `deno check … edge_error_taxonomy.ts` → 20 errors, all in
`supabase/functions/api/index.ts`, none in the probe; the `__wf__` test task uses the same
flag). Neither tool contacts the network; neither reads a secret from disk.

---

## 6. Privacy constraints for any diagnostic output

Never dump, log, paste into a PR/issue, or attach:

- user media, pose sidecars, raw frames, keypoints (`poseFrames`, `rawFrame`, `imageData`,
  `videoData` are forbidden keys for a reason);
- access tokens, refresh tokens, provider id tokens, Apple authorization codes,
  `DEV_AUTH_SECRET`, service-role keys, Upstash tokens, RevenueCat keys;
- emails, display names, `auth.users` rows, `profiles` rows keyed to a person, device ids;
- object-store URLs / keys / filesystem paths;
- whole request/response bodies or stack traces from production logs — quote the `[api]`
  context string and the Postgres SQLSTATE only.

When querying production tables, select aggregates (`count`, percentiles, `group by
status`) — never `select *`. Redact user ids to a prefix if one must be cited. The
redaction rules in `packages/analytics` are the model.

---

## 7. Instrumentation gaps (PRODUCT code — G1/G5 closed during bootstrap; the rest described only)

| ID     | Gap                                                                                                                                                                                                                                                                                                                                        | Where it would go                                                                                                                                                 | Why it matters                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ~~G1~~ | **Closed** (bootstrap): outer `Deno.serve` handler resolves/mints `x-request-id`, stamps every response, emits one `api_request` access line. Not done: the id inside the generic 5xx BODY (`error.requestId`) — the header is enough for `curl`/device logs; add the body field together with G2 so the mobile `ApiError` can surface it. | `supabase/functions/api/index.ts` outer handler; `http.ts` request-id helpers; `__wf__/request_id_test.ts`                                                        | A client-visible 503 is now matched to its log lines by id, not timestamp.                                                      |
| **G2** | Mobile does not send a client request id. Proposed: `x-request-id: <uuid>` in `apiFetch`, surfaced in the typed `ApiError` and in `outbox.last_error`.                                                                                                                                                                                     | `apps/mobile/src/data/api.ts:80-95`, `apps/mobile/src/data/sync.ts` (last_error)                                                                                  | Closes the loop mobile → edge → log.                                                                                            |
| **G3** | No per-stage timing in the analysis pipeline (sidecar read, envelope validation, fusion providers, scoring). Proposed: a `stageTimings: Record<stage, ms>` on `CaptureAnalysisOutcome`, recorded by `stabilitySlo` and included in the evaluation-trial payload.                                                                           | `apps/mobile/src/analysis/runCaptureAnalysis.ts:131-170`, `packages/analysis-pipeline/src/analyzeCapture.ts`, `apps/mobile/src/evaluation/trialCapture.ts:40,153` | `analysis-latency-spike` cannot be localised to a stage.                                                                        |
| **G4** | `stabilitySlo`/`usabilityFunnel` are in-memory only; `recordPreviousRunOutcome` is never wired into launch. Proposed: persist the previous-run marker in device kv on launch and (consent-gated) ship `metrics()` with the evaluation trial, or via a `BufferedAnalytics` transport once an ingestion endpoint exists.                     | `apps/mobile/src/analysis/stabilityTelemetry.ts:96-150`, `App.tsx` launch path                                                                                    | `crash-spike`, `analysis-failure-spike` alerts have no data.                                                                    |
| ~~G5~~ | **Closed** (bootstrap): one JSON access line per request `{evt:"api_request", requestId, method, route, status, durationMs, code?}` from the outer handler; no user id, IP, query, or body. Still open: nothing SHIPS these lines anywhere but Function logs (no `@pickle/analytics` event, no `analytics_event` row — see G4/G6).         | `supabase/functions/api/index.ts` outer `Deno.serve` handler; `http.ts accessLogEntry/routeTemplate`                                                              | `obs_api_failures`/`backend-error-spike` are computable from Function logs today (filter `"evt":"api_request"`, `status>=500`). |
| **G6** | No `analytics_event` table / ingestion route, so `infra/observability/views.sql` and `alerts.json` are unexecutable. Proposed: a migration creating the table with the documented shape + a service-role-only insert path (NOT a client-writable route).                                                                                   | `supabase/migrations/` (new), `infra/observability/views.sql`                                                                                                     | Turns the committed views into live views.                                                                                      |
| **G7** | Provider/model versions are only on `shots`; abstained/failed runs never reach the server, so version-vs-abstention analysis is blind for the worst outcomes. Proposed: include the version vector in `analysis_permits` finalize (`outcome` already exists) — categorical only.                                                           | `supabase/functions/api/index.ts` finalize route; `20260829140000_permits_sync_consent.sql`                                                                       | `abstention-spike` per model version.                                                                                           |
| **G8** | The `[api]` log lines for account deletion include the raw user id (`index.ts:2530, 2629, 2737`). Proposed: hash or prefix it.                                                                                                                                                                                                             | `supabase/functions/api/index.ts`                                                                                                                                 | Aligns function logs with the redaction rules.                                                                                  |

None of these are implemented in this bootstrap stream (product code is out of scope).

---

## 8. Quick checklist for a future session

1. Decide which surface you are diagnosing (§0). If it is production, stop and confirm
   you have Dashboard/PAT/DB access AND a human go-ahead; otherwise work locally.
2. Local backend contract: run both probes in §5; both must exit 0.
3. Local DB: `docker compose up -d postgres postgres_test redis` → migrate/seed → psql
   queries from §4.3/4.5.
4. Mobile: Jest pins on Linux only (`cd apps/mobile && npx jest --silent`); anything
   requiring a device is a `macos-verify` workflow run on the self-hosted M4 runner —
   report it as pending, never as observed.
5. Record every command + exit code in your output; label VERIFIED / INFERRED / UNKNOWN.
