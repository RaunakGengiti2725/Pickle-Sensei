Playbook: Pickle Sensei — Security (!security)

## Overview

Threat-aware implementation or review for RaunakGengiti2725/Pickle-Sensei: auth (Apple/Google → Supabase session), edge fn input handling, RLS/grants, billing webhooks, secrets, privacy of on-device video/pose, and CI/runner boundaries. Every claim is backed by an executed test (RLS matrix, edge contract test, gitleaks) — see `docs/devin/SECURITY_BOUNDARIES.md`.

## What's Needed From User

- The change or area to review (PR, route, migration, native module) — or "full sweep".
- Confirmation that production is out of scope (default: it is; Devin has no production credentials and must not acquire them).

## Procedure

1. Threat-model the change in a short table: asset, entry point, attacker (anon / other user / compromised device / webhook sender / CI), abuse case, existing control (`REVIEW.md` §auth/RLS/API, `AGENTS.md` §Scale & security).
2. Check the invariants: bearer = Supabase access token; refresh token only in Keychain; generic 5xx bodies; `sanitizeUserText` on free text; rate limits (429 + Retry-After); column-level grants sized to actual writes; `billing_entitlements` service-role only; `free_rating_ledger` service-only; webhook secret-gated and entitlements re-verified with RevenueCat; `x-request-id`/access log carries no user id, IP, body, token.
3. Run the gates: `./supabase/tests/run_rls_tests.sh` (allowed AND denied paths); `(cd supabase/functions/api/__wf__ && deno task test)`; `~/.deno/bin/deno run -A --no-check --config supabase/functions/api/__wf__/deno.json tools/diagnostics/edge_error_taxonomy.ts`; `scripts/security-scan.sh --tree --history`; `pnpm audit --prod` / `npm audit --omit=dev` in apps/mobile for dependency findings (classify, do not blindly bump).
4. For each abuse case without a test, write one (RLS matrix SQL in `supabase/tests`, `__wf__` test, mobile test) that FAILS if the control is removed; add it in the same PR.
5. Review workflow/runner security: `.github/workflows/*.yml` permissions are least-privilege, no `pull_request_target`, the Mac workflow has no `pull_request` trigger (public repo, personal Mac), `ci/mac-*` branches are throwaway, no secrets echoed.
6. If a real secret is found in tree or history: stop, do NOT paste it, report file/commit, and ask the user to rotate; add a `.gitleaks.toml` rule only for confirmed false positives with a justification comment.
7. Run the pre-pr-verification Skill and open the PR (or write the review report) with the threat table, each control's test, gate outputs, and residual risks marked VERIFIED / INFERRED / UNKNOWN.

## Specifications

- RLS matrix, edge tests, taxonomy probe, and gitleaks all green (or failures explained as real findings).
- Every new control has a failing-when-removed test.
- No secret values in any output, log, PR, or artifact; no production access used.

## Delegation

An independent reviewer that attempts the abuse cases against the PR branch without reading the implementation first; an adversarial tester for auth/session and RLS denied paths.

## Ask the User When

- A finding requires rotating a working credential, changing Supabase Dashboard settings, or adding a third-party service.
- A control would change user-visible behaviour (e.g. stricter rate limits).

## Forbidden Actions

- Rotating credentials without cause; weakening RLS/grants/rate limits; disabling `supabase-security` or `security-scan`; adding broad gitleaks allowlists; touching Supabase project ucqnaiwqwjtgvlduiuib; reading Keychain/signing material on the Mac runner.

## Stop Conditions

- BLOCKED immediately on a confirmed live secret (rotation is a human action).
- Stop when gates are green and the report/PR is delivered.
