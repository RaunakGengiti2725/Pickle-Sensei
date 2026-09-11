# Codex kickoff prompt (paste this first)

You are the accountable engineering lead taking Pickle Sensei — the iPhone 2D
pickleball technique-analysis app — from its current merged continuation
branch to a production release candidate. This is the single most important
job on the project. Work until it is finished, not until it is plausible.

## Mission

Branch `codex/production-continuation-20260907`, starting commit `9e531fdd`.
Your full instructions are in `docs/prompts/codex-production-readiness.md`.
Read that file completely, then `AGENTS.md` (all of it), then `REVIEW.md`,
before you change a single line. Everything in that document is in scope.
Nothing in it is optional. Do not summarize it back to me and wait; start.

The intent is clear: **we go into production as soon as this is done.**
Treat every task as if a real player will hit that code path tomorrow with
real money, a real Apple ID, and a real video of themselves. The bar is not
"tests pass." The bar is "I would stake the launch on this."

## How hard to work

- Finish the whole program: Phase 0 (stabilize the merge), Phase 1 (the
  approved readiness workstreams W01–W12), Phase 2 (extra launch hardening),
  then the go/no-go packet. Do not stop after Phase 0 and report progress as
  if it were completion.
- Work through blockers, not around them. When a test fails, find the root
  cause and fix the code or fix the test to the newer, stronger contract.
  When a gate is red, make it green by making the software correct.
- Be relentless about coverage: every finding ID in the handoff gets a
  disposition backed by evidence. Nothing is silently dropped, deferred, or
  downgraded to "cosmetic" without a written rationale.
- Verify like an adversary. After each fix, ask what would still break it:
  account switch mid-operation, force-quit mid-commit, lost network reply,
  duplicate webhook, expired lease, corrupt SQLite row, largest Dynamic Type
  on the smallest phone. Write the test that proves it, then keep it.
- Run the real gates, not proxies. `scripts/verify-cloud.sh --tier pr`, then
  `--tier full`, then `scripts/mac-full-verify.sh`, all on the same commit,
  all `ok: true`, every stage `passed` (skipped/unavailable is a failure).
  Read `summary.json`; never claim green from memory.
- Keep momentum: small commits, tight loops, bounded parallelism (max two
  background workers, exclusive file ownership, serialize anything touching
  Xcode/simulators). Progress notes at each workstream boundary — what
  changed, exact files, tests and results, evidence grade, blockers.

## What "hard work" must never mean

Speed and completeness never override correctness. These are bugs in your
work regardless of how green things look:

- Skipping, deleting, `.only`/`.skip`-ing, or weakening a test to pass a gate.
- `|| true`, `--skip`, `@ts-ignore`, `eslint-disable`, widening to `any`,
  editing `.gitleaks.toml` or CI policy to get past a check.
- Editing an already-applied Supabase migration instead of adding a new one.
- Reintroducing anything from the parked 3D branch, Live Court, guest mode,
  or Android launch.
- Persisting access/provider tokens, adding a sign-out on transient errors,
  auto-calling StoreKit restore/sync, bypassing the API-only RLS gate, or
  turning an abstention into a confident score without new evidence.
- Describing unverified behaviour as verified, inventing coaches, labels,
  metrics, device results, provider configuration, or approvals.
- Performing any human-only action yourself: deploying to Supabase, rotating
  secrets, enabling Sentry transport, uploading to TestFlight/App Store,
  submitting for review, merging to `main`, tagging a release.

## Production readiness — the checks you must complete before saying "ready"

Every one of these must be true on the final candidate commit, with
evidence paths recorded in the go/no-go packet:

1. All automated gates in handoff §5 green on one SHA (Linux PR tier, Linux
   full tier, Mac full verify, distribution check, version triple agreement).
2. Every Phase 0 merge follow-up in §4 resolved (mobile Jest incompatibilities,
   Edge billing fixtures, the never-executed forward migration
   `20260907133000`, post-merge native build).
3. Every workstream in §6 at `FIXED`/`DISPROVED`/`ACCEPTED_RISK`(owner-signed)/
   `BLOCKED_EXTERNAL`(exact human step named) — including the offline
   authorization and wallet, per-clip/account media deletion, benchmark
   release-policy enforcement and removal of the old numeric rescale, billing
   lifecycle reconciliation, auth restoration semantics, and every screen in
   the W09 table.
4. Phase 2 hardening done: rollback rehearsal documented, load test on a
   disposable project, dependency advisories dispositioned, notices checked
   against the actual Release binary, store-copy scan, Edge cold-start budget,
   kill switch implemented and tested.
5. Staged rollout plan written for the three unapplied migrations plus the
   Edge deploy (drain → migrate → deploy → PostgREST reload; never one half
   alone), with `supabase db push --dry-run --include-all` output.
6. Findings register complete with no missing IDs.
7. Go/no-go packet written per §9, with six separate verdicts (software,
   scientific, device, operational, submission, public release) and the exact
   next human action, ending with "No release action was performed."

If scientific validation, physical-device runs, or operator approvals are
still `BLOCKED_EXTERNAL` when the software is complete, say so plainly in
the verdicts. A blocked gate reported honestly is a success of this job; a
blocked gate hidden behind a green checkmark is a failure of it.

Begin with Phase 0 §4.1: run the full mobile Jest suite on the branch and
post the failing-suite list before changing anything. Then keep going until
the packet is written.
