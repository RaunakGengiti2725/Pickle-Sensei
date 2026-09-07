# Review guidelines — Pickle Sensei

Used by Devin Review and by human/agent reviewers. `AGENTS.md` holds the
product invariants and their pinning tests; this file says what a REVIEWER
must check and where the evidence has to come from. Verdicts must cite
executed checks (CI job, `artifacts/verify-cloud/*/summary.json`, Mac run
URL), never "the code looks right".

## Evidence bar

- A PR is mergeable only when the `CI` workflow is green. Apple-side claims
  (Swift, Vision, Xcode build, simulator launch) need a green
  `Mac Full Verify` run on the self-hosted M4 runner for the same SHA
  (`.github/workflows/mac-full-verify.yml`); Linux cannot prove them.
- A change to user-visible behaviour without a new/updated test is a Flag.
  Every invariant in `AGENTS.md` names its pinning test; if the PR changes
  the behaviour it must change that test deliberately, not delete it.
- "Fixed" by skipping/deleting a test, `|| true`, widening a type to `any`,
  or disabling a lint rule → Bug.

## Critical areas (extra scrutiny, always)

### Supabase migrations — `supabase/migrations/`

- Never modify an already-committed migration; add a new
  `YYYYMMDDHHMMSS_description.sql`.
- Any new client-writable column → the column-level UPDATE grant must be
  extended in the same migration (`AGENTS.md` → Scale & security: defense in
  depth). PostgREST upserts put every payload column in `DO UPDATE`.
- New tables default to: RLS enabled, no `anon` grants, owner-scoped
  policies. Service-only tables (`billing_entitlements`, `webhook_events`,
  `free_rating_ledger`) must never gain user INSERT/UPDATE policies.
- Anything that counts free ratings must go through
  `public.lifetime_scored_count()`; `count(*) from public.shots` in a
  decision point is a Bug.
- Expect the RLS matrix (`supabase/tests/security_regression.sql`) to gain
  a case for every new policy/grant. CI job `supabase-security` must pass.

### Edge function — `supabase/functions/api/`

- Every non-public route calls `authenticate()` and scopes queries to the
  authenticated user; public routes are exactly `GET /healthz`, `/privacy`,
  `/terms`, `/support`, `POST /webhooks/revenuecat`.
- Bearer semantics: Supabase ACCESS token (bootstrap/refresh/logout
  contract). A new route that accepts a raw provider ID token is a Bug.
- 5xx bodies stay generic; free text goes through `sanitizeUserText`; new
  routes get a `rateLimit.ts` budget. Service-role client only for
  billing/audit/external-credential rows.
- Webhook payloads are never trusted for entitlements — re-verify against
  RevenueCat.
- `deno check index.ts` has known pre-existing errors; standalone modules
  (`cache.ts`, `rateLimit.ts`, `http.ts`, `legal.ts`) must stay clean and
  `__wf__` tests (`deno task test`) must pass.

### Auth & session on mobile — `apps/mobile/src/auth`, `src/account`

- Access token and provider token are never persisted; only the refresh
  token + descriptor in Keychain (`sessionVault.ts`).
- The only implicit sign-out is the server refusing the refresh token
  (401/403). Any new code path that clears the session on a transient error
  is a Bug (`__tests__/authDurableSession.test.ts`).
- Long-lived clients resolve the bearer per request via
  `bearerTokenFor(...)`; capturing `bearerToken` at construction is a Bug.

### Privacy & telemetry — `packages/analytics`, `src/analysis/*Telemetry.ts`

- Pose/keypoint data and media never leave the device. Telemetry payloads
  are categorical; media URIs, filesystem paths, emails, free text, base64,
  device identifiers are rejected by the redaction layer — do not add
  fields that would be rejected or bypass it.
- Logs (mobile and edge) must not contain tokens, emails, or user text.

### Perception / analysis pipeline — `native/`, `apps/mobile/src/vision`, `src/analysis`, `packages/scoring`, `packages/vision-geometry`

- Any change that can alter analysis output must bump the relevant version
  (`SCORING_MODEL_VERSION`, `GEOMETRY_BUNDLE_VERSION`, provider entry
  `version` in `src/vision/providers.ts`) so results stay attributable, and
  must include benchmark evidence (`packages/evaluation`,
  `packages/swing-lab`) — a before/after metric table, not a description.
- Abstention paths (`analysis_abstained`, capture-envelope verdicts) must
  survive: a change that turns an abstain into a confident score with no
  new evidence is a Flag.
- Swift/Vision code: request/observation lifecycle must be bounded (no
  unbounded frame buffers, dispatch queues released, camera session torn
  down on background). Verified only on the Mac runner.

### Video / media lifecycle — `src/camera`, `src/analysis/runCaptureAnalysis.ts`, `services/media-worker`

- Every temp file/recording has an owner that deletes it on success,
  failure, AND cancellation. Look for early returns that skip cleanup.
- Async work started by a screen is cancelled on unmount; check for state
  updates after unmount and for retries without a bound.
- Analysis must never block the UI thread; long steps report progress or
  time out with an explicit error code.

### Billing — `src/billing`, `runtimeConfig.ts`, edge billing routes

- Only the two paywall buttons may reach StoreKit auth; auto restore/sync
  is a Bug. Entitlement id `pickle_sensei_pro` (alias `premium`). Prices are
  only ever store-returned.

### Launch flow & copy — `App.tsx`, `src/flow/launchGate.ts`, screens

- Onboarding before sign-in, non-skippable (`launchGate.test.ts`,
  `onboardingScreen.test.tsx`). Any new skip affordance is a Bug.
- User-facing/store copy: no Android, Google Play, guest mode, Live Court,
  DUPR, competitor names, accuracy percentages, or superlatives
  (`docs/APP_STORE_SUBMISSION.md` is authoritative). Typography must use
  `src/design/tokens.ts` roles, never ad-hoc font sizes.

### CI, runner and verification scripts — `.github/workflows/`, `scripts/`, `tools/macos-ci/`

- Workflows call `scripts/*.sh`; logic in YAML beyond argument plumbing is a
  Flag. `permissions:` must stay `contents: read`.
- `mac-full-verify.yml` must never gain a `pull_request` trigger (public
  repo × personal self-hosted Mac). Runner labels stay
  `[self-hosted, macOS, ARM64]`; no runner registration steps.
- Verification scripts: a stage that swallows its exit code or reports
  "skipped/unavailable" as passed is a Bug.

## Ignore / low priority

- `apps/mobile/package-lock.json`, `pnpm-lock.yaml`, `Podfile.lock` unless
  the PR intends a dependency change (then check the version is ≥7 days
  old and the changelog).
- `datasets/**` binaries and `docs/HANDOFF*.md` / `docs/*_2026-*.md`
  historical reports.
- Generated artifacts under `artifacts/`, `macos-ci-artifacts/`.

## Not a reviewer's call

Do not approve or request merge on the basis of an AI review alone, and do
not release, deploy (`supabase db push`, `functions deploy`, fastlane), or
submit to App Store review — those are human actions
(`docs/RELEASE_OPERATIONS.md`, `docs/PRELAUNCH_CHECKLIST.md`).
