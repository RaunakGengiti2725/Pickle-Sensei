# PICKLE SENSEI — RELEASE PLAN v1 (Wave H, h25-release-cert, 2026-08-29)

> Companion to the pinned release-candidate record:
> `datasets/experiments/wave-h/h25-release-candidate-record.json` (RC =
> `104ea0f6383f5573ddc9393401700c7ecc163436`, head of
> `devin/1787988068-wave-c-integration`) and the open-issue register:
> `datasets/experiments/wave-h/h25-p0p1-remaining-register.json`.
>
> This document PLANS the release. It performs no irreversible action. No App
> Store submission, production deploy, or DNS/infra change is executed by this
> plan; each GO step below is what a human integrator would run **after** an
> explicit GO decision.
>
> HARD PRECONDITION ON ANY GO: the external claim gate is FAIL
> (`docs/CLAIM_REVIEW.md`). The only approved external language is
> "Pickle Sensei is still being validated." All coach-validated surfaces
> (technique score, fault diagnosis, drill recommendation) read
> RELEASE_BLOCKED by frozen, hash-pinned gates (wave-g2 h04) — a GO under this
> plan releases the _capture → honest-analysis → honest-abstention_ product,
> not accuracy claims.

## 1. Staged rollout

Stage 0 — INTERNAL (team devices only)

- Scope: TestFlight internal group (≤ ~10 team testers), backend on a staging
  stack (staging DB, staging media bucket).
- Entry: GO decision on the RC record; all root gates green at the release SHA;
  mobile suite green on a Mac (`cd apps/mobile && npm ci && npx tsc --noEmit && npx jest`);
  C09 native Swift sources built + tested on Mac (currently NEVER compiled —
  this is a hard Stage-0 blocker until done).
- Exit: Mac re-measure list executed (HANDOFF_V4_DRAFT §4): cascade n=5
  re-measured at the RC SHA, E2E latency with warm worker measured (verify or
  retire the ~11.9 s projection), zero new P0 findings from internal use for
  5 consecutive days, crash-free sessions ≥ 99% on internal builds.

Stage 1 — CANARY (small external cohort)

- Scope: TestFlight external cohort of 25–100 users, real consent flow
  (video-analysis-v1; model-training consent strictly optional and OFF by
  default), production backend at pinned artifact versions.
- Entry: Stage 0 exit met; iPhone device latency measured on ≥ 2 physical
  devices via the h06 GATE B harness (currently BLOCKED_EXTERNAL — hardware);
  monitoring plan (§6) live; support notes (§5) published to the support inbox.
- Exit: 14 days with: no P0 (per the triage taxonomy in the register), silent
  high-confidence-failure rate on canary traffic within the silent-failure-v1.1
  budget, abstention rate on SUPPORTED-envelope captures below the excess-
  abstention alarm line (§6), consent ledger integrity checks clean
  (export v2 signature verification), crash-free ≥ 99.5%.
- Canary is where TARGET's known silent-failure exposure (g16: 17/54 errors,
  0 abstentions) is measured on real traffic for the first time — the TARGET
  silent-failure telemetry line in §6 is mandatory before entry.

Stage 2 — BROADER RELEASE

- Scope: public App Store release (phased release ON at 1%→10%→50%→100% over
  ≥ 7 days), still under "being validated" language.
- Entry: Stage 1 exit met; P0 register empty; every P1 in the register either
  fixed at the release SHA or explicitly accepted in writing by the release
  owner with rationale recorded in `docs/DECISIONS.md` (new D-number).
- Any P0 discovered at any stage: halt phased rollout immediately (App Store
  phased release pause), assess, fix-forward or rollback per §3/§4.

## 2. Exact release steps that would execute on GO (none executed now)

1. Freeze: tag the audited SHA `git tag rc-v0.1.0 104ea0f6383f5573ddc9393401700c7ecc163436 && git push origin rc-v0.1.0`
   (or the post-wave-H integration SHA after re-audit — re-pin the RC record if
   the SHA moves; the record, not this prose, is authoritative).
2. Backend: build `services/api` and `services/media-worker` images from their
   Dockerfiles at the tag; push to the registry with the git SHA as the image
   tag; deploy staging; run migration set 0001–0017 via the migration runner
   against staging; smoke-test consent lifecycle (grant → export v2 verify →
   withdraw → append-only rejection) and the analysis permit path.
3. Mobile: from a Mac at the tag, `cd apps/mobile && npm ci && npx tsc --noEmit && npx jest`;
   build the iOS archive (Release config, FIXED completion strategy verified in
   the build); upload to TestFlight internal.
4. Verify feature-flag state in the built artifacts matches the RC record
   (worker ON; merge/crop-recovery/two-pass/tight-window/pass1-roi OFF;
   completion FIXED; coach surfaces RELEASE_BLOCKED).
5. Enable monitoring dashboards + alerts (§6) before any user traffic.
6. Promote per §1 stages, with the GO/HALT criteria written there.

## 3. Rollback procedure (application)

- Mobile: App Store phased release can be PAUSED but a shipped iOS binary
  cannot be un-shipped. Rollback = pause phased release + expedited-review
  submission of the previous good build (or a build with the offending flag
  forced off). Because of this asymmetry, any behavior that is not
  flag-guarded must clear the full P0 bar before Stage 2. Client kill-switch:
  coach surfaces are already gate-blocked server-side; analysis endpoints can
  return typed maintenance errors (existing typed-error contract) to disable
  analysis without a client update.
- Backend: images are SHA-tagged and stateless; rollback = redeploy the
  previous image tag. Config/flags roll back with the deployment.

## 4. Database rollback / forward-fix strategy

- Migrations 0001–0017 are forward-only; the consent ledger (0015–0017) is
  append-only BY DESIGN with immutability triggers — a down-migration that
  rewrites or drops consent history would itself be a consent-integrity
  violation. Therefore: **DB strategy is forward-fix only.**
  - Take an automated snapshot/backup immediately before running any new
    migration in production; verify restore on staging quarterly.
  - A bad migration is remediated by a new forward migration (001N+1), never
    by editing or reverting an applied one.
  - Restoring from snapshot is the last resort and is only permissible before
    real user consent records exist in the window being discarded; once real
    consent data exists, snapshot-rollback that loses consent writes is
    prohibited — forward-fix only.
- If the g10/g11 least-privilege work (migration 0018) merges before release:
  production prerequisite becomes (a) admin pre-creates `pgcrypto`, (b)
  migrations run as the migration-owner role, (c) runtime services connect as
  the least-privilege runtime roles. Add a staging rehearsal of exactly that
  sequence to step 2 of §2.

## 5. Known limitations & support notes (v0.1, honest)

- Accuracy is NOT validated: 0 real coach reviews; all coaching-quality
  surfaces are blocked; external language is "still being validated".
- The app abstains often and on purpose. Latest measured strict-cascade
  success is 2/5, usable-result 2/5 (Mac, 2026-08-28, n=5 gold). Support
  script: an honest "couldn't analyze this clip" is expected behavior, not an
  outage; capture guidance (wave-c C13) tells the user what to change.
- Target selection never abstains at the RC SHA (g16): a wrong target is
  silent. Support script: user-visible wrong-player analysis → collect the
  clip (with consent) and file as SEV-affecting; this is the top known risk.
- Capture envelope thresholds are provisional (v0.3-provisional; e15/f18
  re-derivations failed to validate them) and the camera-motion proxy can be
  fooled (g09): a DEGRADED/SUPPORTED verdict is advisory, not a guarantee.
- iPhone latency is unmeasured (all numbers are Mac); cold-start analysis may
  be slow on device. Do not quote latency numbers to users.
- Store receipts: purchase validation returns typed-501 (D-016) — no paid
  features may be sold in this release.
- Held-out cases wm-dink-01 / afn-vic-rally1 are untouchable evaluation
  assets; they must never be used in demos, marketing, or support replies.

## 6. Monitoring plan (all lines pre-wired before Stage 1)

Product truthfulness

- silent-failure-v1.1 rate per stage (contact/stroke/ownership), grouped by
  user/session/source — never per-frame; alarm on any stage exceeding its
  frozen budget.
- TARGET wrong-lock reports (support-sourced + tap-distance telemetry from C17
  `targetLock` events): alarm on any confirmed wrong-target with confident
  downstream output.
- Abstention rate on SUPPORTED-envelope captures (excess-abstention alarm):
  baseline from Stage 0; alarm at ≥ 2× baseline over a 24 h window.
- Envelope verdict distribution (SUPPORTED/DEGRADED/UNSUPPORTED/NOT_MEASURED)
  — a spike in NOT_MEASURED is a capture-contract regression (h08).

Reliability & latency

- Crash-free session rate; analysis pipeline completion rate; per-stage
  latency percentiles (cold vs warm; worker fallback count — a nonzero
  paddle-worker fallback rate means the warm path is degrading silently).
- Session-engine event states (g21 semantics): READY events with missing
  content, retry-queue depth, recoverPending() outcomes after restart.

Consent & privacy

- Consent ledger append-only violations (should be structurally impossible —
  any nonzero count is a P0 page), export v2 signature verification failures,
  account-deletion cascade completions, training-consent opt-in rate (audit
  that no training use occurs without it).

Release hygiene

- Feature-flag drift check on every deploy against the RC record.
- Alert routing: P0-class alarms page the release owner; P1-class open
  register entries reviewed weekly against canary data.

## 7. GO / NO-GO inputs (who decides on what)

The GO decision consumes: (1) the RC record, (2) the P0/P1 remaining register
(P0 must be empty; every P1 fixed or explicitly accepted), (3) Mac re-measure
results at the release SHA, (4) device-latency results from the h06 harness,
(5) claim-gate language check. The decision and its rationale get a D-number
in `docs/DECISIONS.md`. Nothing in this plan pre-commits the answer.
