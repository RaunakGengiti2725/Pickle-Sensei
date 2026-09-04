# Pickle Sensei — Devin operating system

The one-page control plane for autonomous sessions. It says _where truth comes
from_ and _which tool to reach for_; procedures live in the Skills it points to,
facts in Devin Knowledge, and product rules in `AGENTS.md` / `REVIEW.md`.
Nothing here is a claim of correctness — every entry names the artifact that
proves it.

## 1. Execution planes

| Plane                                                                                                                                                                                            | What it proves                                                                                                                                                                                                                                                                                                              | Entry point                                                                                                                                                                                      | Machine-readable result                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloud (Linux)** — Devin VM, Ubuntu 22.04, Node 22, pnpm 10.15.1, Python 3.12, Deno 2.x, Docker, ffmpeg                                                                                         | everything that does not need Apple SDKs: format, lint, typecheck, workspace + mobile TS/Jest tests, Postgres migrations/seed, ElasticMQ-backed queue tests, ML unittests, Edge Function (Deno) tests, RLS/security matrix, secret scan, admin build, Playwright smoke, release-manifest coherence                          | `scripts/verify-cloud.sh --tier pr\|full [--start-services] [--only s1,s2] [--skip s1]`                                                                                                          | `artifacts/verify-cloud/<UTC>/summary.json` (+ one `<stage>.log` each); statuses `passed` / `failed` / `skipped` / `unavailable` — only `failed` is a failure, nothing is masked with `\|\| true`                               |
| **Mac (Apple truth)** — the user's physical Apple Silicon M4 MacBook, GitHub self-hosted runner labels `self-hosted, macOS, ARM64` (already registered; **never re-register or reconfigure it**) | SwiftPM build/test, XCTest on macOS + iOS Simulator, Apple Vision pose extraction on the committed clip, Release `xcodebuild` of `apps/mobile/ios/PickleSensei.xcworkspace` scheme `PickleSensei` (bundle `com.picklesensei`, iOS 15.1+), unsigned simulator app + `main.jsbundle` validation, simulator launch/crash check | on the Mac: `scripts/mac-full-verify.sh`; from Linux: `scripts/mac-full-verify.sh --remote` (pushes a throwaway `ci/mac-*` branch → `.github/workflows/mac-full-verify.yml` → waits → downloads) | `artifacts/mac-full-verify/<run-id>/` — `run.json`, `summary.json`, `*.xcresult`, vision summary, logs. `workflow_dispatch` is **not** available to Devin's GitHub identity (HTTP 403) — the push trigger is the supported path |
| **Both**                                                                                                                                                                                         | release-grade statement "everything works"                                                                                                                                                                                                                                                                                  | `scripts/verify-all.sh`                                                                                                                                                                          | the two artifact trees above                                                                                                                                                                                                    |

CI mirrors the planes: `.github/workflows/ci.yml` runs the Cloud stages as
jobs `verify`, `mobile`, `edge`, `supabase-security`, aggregated by the single
`ci-gate` check (branch protection and the CI-failure automation key off
`ci-gate` only); `mac-full-verify.yml` runs the Mac script on `ci/mac-*`
pushes and `main`. `mac-smoke-test.yml` is the user's original runner smoke
check and is left untouched.

Local services (`docker compose up -d postgres postgres_test redis elasticmq`):
Postgres dev `:5432/pickle_dev`, test `:5433/pickle_test`, Redis `:6379`,
ElasticMQ `:9324`, MinIO `:9000`/`:9001`. Local Fastify API `pnpm dev:api` →
`http://127.0.0.1:3001/v1/health`; admin web `pnpm --filter @pickle/admin-web dev`
→ `:5173`. The **production** backend is the Supabase Edge Function
`supabase/functions/api` (project `ucqnaiwqwjtgvlduiuib`) — autonomous
sessions never deploy to it, push migrations to it, or mutate its data.

## 2. Verification map (what gates what)

`docs/devin/TEST_MATRIX.md` is the authoritative table. Summary:

- **Deterministic gates (block merge):** verify-cloud `--tier pr` stages
  (`deps format lint typecheck test db mobile ml tooling edge rls security`), plus the
  Mac run when `native/`, `apps/mobile/ios/`, Podfile/SwiftPM, or
  Vision/CoreML/AVFoundation code changed.
- **Full tier adds:** `admin` (Vite build), `e2e` (Playwright smoke against the
  admin web, `apps/mobile` not covered), `release` (release-manifest and
  `APP_STORE_SUBMISSION.md` coherence).
- **Report-only / external:** k6 load tests (`tools/loadtest/`), production
  dashboards, App Store / TestFlight state — never inferred, always read.

Skills (procedures, each with exact commands, artifacts, failure conditions
and forbidden shortcuts) in `.agents/skills/`:
`pre-pr-verification` · `full-product-verification` · `macos-verification` ·
`release-verification` · `test-authentication` · `admin-web-manual-smoke`.
Repository workflow skill:
`.devin/skills/ultra-coordinator/` (§8).

## 3. Objective evaluation ("did this make Pickle Sensei smarter?")

`packages/evaluation` is the bench harness (`docs/EVALUATION.md`):

```bash
# no `--` before the flags (pnpm forwards it literally); `-s` keeps pnpm's banner out of the JSON
pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/cand --run-id cand   # 9 benches, ~200 metrics
pnpm -s --filter @pickle/evaluation bench:compare \
  datasets/reports/regression/baseline.json /tmp/cand/cand.json --json > /tmp/cand/compare.json
```

`bench:compare` exits non-zero on any regression beyond
`packages/evaluation/regression.tolerances.json`. Provenance in every summary:
`gitSha`, `gitDirty`, `datasetsInputTreeSha` (committed `datasets/` tree
_excluding_ `datasets/reports/` so writing a report never changes the input
identity), estimator/model versions. Rules: run on a **clean commit**
(`gitDirty:false`) or the comparison is confounded; identical benches for
baseline and candidate; **never** edit tolerances, `datasets/`, or the
committed baseline to make a run pass; **never** fabricate labels — remaining
gold-corpus gaps and the human-labeling needed are listed in
`docs/EVALUATION.md` and `datasets/reports/regression/README.md`.

## 4. Observability & diagnostics

`docs/devin/DIAGNOSTICS.md` is the map. Key surfaces:

- **Edge Function:** every request gets/propagates `x-request-id`
  (`[A-Za-z0-9._-]{8,64}`, otherwise a UUID), one structured access log per
  request with UUID/numeric path segments redacted and no bodies, bearer
  tokens, IPs or user ids. 5xx bodies are generic by design; detail is in
  function logs (Supabase dashboard → Edge Functions → `api`, human access).
- **Error taxonomy probe:** `deno run -A --no-check --config
supabase/functions/api/__wf__/deno.json tools/diagnostics/edge_error_taxonomy.ts [--json]`
  exercises the real handler for every error class (15 probes, exit 1 on drift).
- **Local API probe:** `node tools/diagnostics/local_api_probe.mjs --start
[--with-account] [--json]` (exit 2 `UNAVAILABLE` when no server — never a
  false pass).
- **CV intermediate stages:** `pnpm --filter @pickle/swing-lab analyze:video <clip>
[--overlay]` writes `analysis.json` + `debug.json` (+ `overlay.mp4`) per run;
  research runs under `datasets/experiments/`; Apple Vision extraction summary
  from the Mac run.
- **Mobile:** Jest suites pin runtime contracts; simulator launch/crash
  summary from the Mac run; device logs require the Mac plane.
- **Database/auth/RLS:** `./supabase/tests/run_rls_tests.sh` (fresh Postgres 16
  - every migration + allowed/denied matrix).

If a subsystem cannot be observed, extend the probe/harness first; do not
guess.

## 5. Security boundaries

`docs/devin/SECURITY_BOUNDARIES.md` (audit + rules). Non-negotiable for
autonomous sessions: no production Supabase mutation, no App Store Connect /
TestFlight actions, no secret in source, snapshot, log, Knowledge or Skill;
`scripts/security-scan.sh` (gitleaks with `.gitleaks.toml`) is a verify-cloud
stage; on the Mac only the workflow's checkout is touched — never Keychain,
signing identities, or personal files. Dangerous review areas are enumerated
in `REVIEW.md`.

## 6. Devin context layers

| Layer                                                        | Holds                                                                                                                                                                                                       | Where                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `AGENTS.md`                                                  | product/engineering invariants (auth contract, RLS/grants, billing, copy rules, typography, launch flow)                                                                                                    | repo root, auto-injected                                                    |
| `REVIEW.md`                                                  | review-specific rules for Devin Review and human reviewers                                                                                                                                                  | repo root                                                                   |
| Skills                                                       | procedures with commands + artifacts                                                                                                                                                                        | `.agents/skills/*/SKILL.md`, `.devin/skills/*/`                             |
| Knowledge (repo-pinned to `RaunakGengiti2725/Pickle-Sensei`) | durable facts: architecture, verification commands, backend invariants, evaluation design, diagnostics                                                                                                      | Devin Settings → Knowledge (org)                                            |
| Playbooks                                                    | `!feature` `!bug` `!hard_debug` `!architecture` `!performance` `!security` `!release_gate` — objective, process, acceptance, evidence, delegation, user decision points, forbidden actions, stop conditions | Devin Settings → Playbooks; source text mirrored in `docs/devin/playbooks/` |
| Blueprint                                                    | repo-level environment (Node 22, pnpm, Python, Deno, Docker services, mobile `npm ci`)                                                                                                                      | Devin Settings → Environment → Blueprints                                   |

Facts go to Knowledge, procedures to Skills, session shapes to Playbooks,
environment needs to the Blueprint. Session-specific detail goes nowhere.

## 7. Enterprise control plane

- **Devin Review** — active for this repo: every push to a PR gets a review
  and a `Devin Review` check (proven on PR #9, findings on the runner, the
  verifier, the Mac workflow and the admin console were each fixed with a
  regression test); on-demand runs via `devin_review_manage`
  `trigger` / `get_status`; `REVIEW.md` is picked up automatically. Auto-fix
  is an org setting (Settings → Review) — keep it limited to Devin-tracked
  PRs and never auto-merge on a green review; CI/test evidence is authoritative.
- **Automations** (`devin_automation_manage`; every create/update is
  approval-gated) — designed set: CI-failure investigator (triggers only on
  `ci-gate` / Mac Full Verify failures, skips `ci/mac-*`, Devin-authored
  commits, `[devin-ci-fix]` markers, newer commits, duplicate sessions and
  infra-only failures), `/devin` issue-fix (bot-comment and release guards),
  weekly dependency audit (safe patch/minor only), nightly QA (report-only),
  weekly CV evaluation (report-only), weekly Knowledge hygiene (propose-only).
  All carry an explicit Git Manager network policy and invocation/concurrency
  limits; mutating ones stay disabled until the user enables them.
- **Enterprise API v3 / service user** — this deployment's API base is
  `https://la-hacks-rttothemoon.devinenterprise.com/api/v3/organizations/org-64c3d692a7604f66829849dfdd2389ba/…`
  (Bearer `cog_…` key; unauthenticated calls answer 403 problem+json, which
  is how reachability is proven). No Pickle Sensei service user exists yet;
  the minimal one is an _organization_-scoped service user (Settings →
  Service users) with a role limited to view/create sessions and view
  Knowledge/Playbooks — no enterprise scope, and `ImpersonateOrgSessions`
  only if sessions must be attributed to a human. Readiness test (no key
  stored anywhere, read-only, exit 0 only when all three list probes return
  200): `DEVIN_API_KEY=… tools/devin/api_readiness.sh [--json]`.
- **MCP / integrations** — GitHub connected (Git Manager). No Supabase, Sentry,
  Datadog, Linear, Jira, Figma or Vercel integration is configured, and none
  is used by the code today; add one only when a workflow consumes it
  (Supabase read-only MCP is the first candidate once a staging project
  exists — classified _not yet justified_, see §9).
- **DANA / Data Analyst** — no analytics-grade read replica or staging DB is
  exposed; schema and business definitions for future analytics live in
  `supabase/migrations/` and `AGENTS.md` (free-rating ledger, permits,
  billing entitlements). Classified _blocked on a read-only data source_.

## 8. Working pattern for improvement sessions

```
IMPLEMENTER  → implements inside an owned path set, ships evidence
INDEPENDENT REVIEWER → re-verifies without trusting the implementer
ADVERSARIAL TESTER   → tries to break it, pushes failing tests
JUDGE (deterministic) → eligible only when all three agree; ties by bench delta
INTEGRATOR   → merges winners, verify-all + bench:compare, ONE draft PR
```

The Ultra coordinator workflow implements this end to end
(`.devin/skills/ultra-coordinator/`): edit `workstreams.json`, invoke the
`dynamic-workflows` skill, run `run_workflow` with `workflow.py`. Use Cloud for
Linux/backend/general work, the M4 runner for Apple truth, `bench:compare`
for CV intelligence, and the probes in §4 for diagnosis. For 1–2 independent
tasks spawn Managed Devins directly; the Playbooks describe the per-task
shapes.

## 9. Remaining manual dependencies (human actions)

| Item                                | Exact action                                                                                                                                                        | Why                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Knowledge / Playbooks / Automations | approve the pending Devin-management requests raised by the bootstrap session (or re-run them)                                                                      | management mutations are approval-gated; drafts are validated but not applied until approved |
| Repo Blueprint                      | approve the pending repo-level blueprint suggestion (Deno, ffmpeg, Playwright Chromium, gitleaks, DB images, canonical commands) so the snapshot is rebuilt from it | until approved, sessions start from the enterprise blueprint only and re-install these tools |
| Service user                        | Settings → Devin API → Service users → create org-scoped `pickle-sensei-automation` with the minimal role in §7; store the key as a Devin secret, never in the repo | API-driven session creation / automation management                                          |
| Supabase staging + read-only MCP    | create a staging project (or read replica) and connect a read-only Supabase MCP / DB credential                                                                     | DANA analytics and runtime diagnosis without production risk                                 |
| Branch protection                   | require `ci-gate` (and `Mac Full Verify` for Apple paths) on `main`                                                                                                 | makes the aggregate gate binding                                                             |
| Mac runner health                   | keep the M4 runner online; the workflow queues (not fails) when it is offline                                                                                       | Apple truth is unavailable otherwise                                                         |
