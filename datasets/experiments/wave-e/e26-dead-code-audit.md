# E26 — Post-integration dead-code / duplicate / stale-flag audit (waves C/D)

Scope: `packages/` and `services/`, changes introduced between `52ba173` (main tip,
pre-wave-C base) and the wave-c-integration head (`8fc388e`). Method: knip@5 full-workspace
scan + per-symbol whole-repo grep (packages, services, apps incl. npm-managed apps/mobile,
tools, native, ml) + `git log -S` provenance for every candidate, so nothing was judged from
knip output alone (apps/mobile is outside the pnpm workspace and invisible to knip).

## REMOVED (safe mechanical — export-surface only, zero behavior change)

Every symbol below was introduced during waves C/D, is used ONLY inside its defining file,
and is imported nowhere else in the repo (including tests, apps/mobile, tools, native).
The `export` keyword was removed; declarations stay (they are referenced internally and/or
appear in exported signatures, which TypeScript permits for non-exported types).

| File | Symbols unexported | Introduced by |
| --- | --- | --- |
| packages/swing-lab/src/calibration.ts | `ReliabilityBin`, `CoverageRiskPoint` | C11 (8ad41de) |
| packages/swing-lab/src/paddleSchedule.ts | `DenseReason`, `SchedulePassRecord`, `MergedDetectionResult` | C08 (ff42cab) |
| packages/swing-lab/src/paddleWorker.ts | `PaddleDetectRequest`, `PaddleReadyEvent`, `PaddleDetectResponse`, `PaddleServeWorkerOptions`, `PaddleWorkerSupervisorOptions`, `PaddleDetectHandle` | C07 (91cf284) / D09 (e8a7ecc) |
| packages/swing-lab/src/silentFailure.ts | `ClaimStatus` | C11 (8ad41de) |
| packages/swing-lab/src/eventFailureOracle.ts | `smooth` (function) | D06 (cfbfd25) |
| services/media-worker/src/trainingConsent.ts | `TrainingEligibleSelection` | C10 (fb1b4ca/a697726) |

Regression coverage: root `pnpm typecheck` (19/19 packages), `pnpm lint` (0 problems),
`pnpm format:check`, full `pnpm test` all green after the change (see summary JSON).

## NOT REMOVED — and why

### Intentional mirrors / ports (look like duplicates, are drift-guarded contracts)

- `packages/analysis-pipeline/src/sessionEngine.ts` carries a VERBATIM mirror of
  `packages/swing-lab/src/strokeEvents.ts` (`proposeStrokeEvents`, `proposeStrokeEventsV2`,
  `selectTargetEvent`, `selectTargetEventV2`, `STROKE_EVENT_VERSION*`). Deliberate (W6/D-040):
  mobile cannot import swing-lab; the mirror is byte-compared in
  `packages/analysis-pipeline/test/sessionEngine.test.ts` and replay-validated in swing-lab.
  Deduplicating would invert the dependency direction the mirror exists to avoid.
- `packages/vision-geometry/src/strokeHeuristicLite.ts` `classifyStroke` vs
  `packages/swing-lab/src/strokeHeuristic.ts` — intentional mobile port (D-039); the two are
  versioned separately (mobile port is still v1; sync follow-up already filed in D-036).
- `packages/swing-lab/src/sessionEngine.ts` re-export shim over analysis-pipeline — keeps every
  swing-lab import path working (documented in the file header). Knip's "unused export" hits on
  its re-exported types are false positives (consumed via `@pickle/swing-lab` index).

### Near-duplicates with real semantic differences (consolidation = refactor, not mechanical)

- `dominantWristSpeeds`: 5 variants (analyzeVideo private, detectSpanPlan export, engine/minerCore,
  contactForensics private, paddleSelectionForensics private, mineVideo private). analyzeVideo's
  variant takes pre-projected legacy frames to honor the D4-05 pose-reuse optimization
  (single `toLegacyPoseFrames` call in `buildPoseDerivatives`); detectSpanPlan's recomputes the
  projection; minerCore's is unwindowed. Consolidating changes measured D4-05/D4-07 code paths —
  out of "safe mechanical" scope. Filed as follow-up refactor candidate.
- `sha256Hex`: `packages/swing-domain/src/sha256.ts` (pure-TS, string input, RN-safe) vs
  `packages/swing-lab/src/experimentBundle.ts` (node:crypto, Buffer input). Different runtimes and
  input types — not a true duplicate.
- `calibrationReport`: `packages/evaluation/src/metrics.ts` vs `packages/swing-lab/src/calibration.ts`
  (C11) — different domains (evaluation metric vs W14 agreement-proxy calibration); both tested.

### Research / provenance tooling (mandate: never remove)

Knip "unused files" that are research CLIs run via `tsx src/<file>.ts` or package scripts, kept:
`contactForensics.ts`, `detectSpanAudit.ts`, `eventBoundsScout.ts`, `eventWindowSlice.ts`,
`oodNegativesMeasure.ts`, `ownershipGuardBench.ts`, `paddleS4StressReplay.ts`,
`paddleSelectionForensics.ts`, `waveaValidate.ts` (swing-lab);
`packages/capture-envelope/src/evalBundles.ts` (C12 measurement CLI, `eval:bundles` script);
everything under `datasets/experiments/**/*.ts` (wave artifacts — hands off).

- `DETECT_SPAN_PLAN_VERSION` (detectSpanPlan.ts, D4-07): defined, never referenced. Kept: it is a
  version identifier for scientific tooling intended for artifact stamping; wiring it into the span
  audit artifact is the right fix, not deletion.
- taReplay exported tuning constants (`FOLLOW_CONTEST_SCORE_RATIO`, `FOLLOW_INCUMBENT_RADIUS`,
  `GESTURE_ELEVATION`, `SOFT_*`, `W3_*`, `DOMINANCE_CONTINUITY_RADIUS`): exported-constant style is
  deliberate in that bench (e.g. `SOFT_OCCUPANT_MIN_V` is imported by taVariantsW3.test.ts);
  D-026/D-027 tooling — left untouched.

### False positives in the knip scan

- `packages/capture-envelope/src/core.ts`: flagged unused file — actually the RN-safe entry that
  apps/mobile aliases via metro.config.js (D07). Knip cannot see apps/mobile.
- `packages/vision-geometry/test/*.test.ts` (7 files): vitest files knip misclassified (no knip
  config in that workspace). Adding a knip config was out of scope (new tool config repo-wide).

### Pre-existing (predates waves C/D → outside this workstream's boundary; listed for a future pass)

- `services/api/src/modules/billing/entitlements.ts`: whole module unimported (c297902-era;
  the entitlement checks live in access.ts/revenueCat.ts today).
- `services/api/src/modules/flags/routes.ts`: `rolloutBucket`, `evaluateFlag` unused exports
  (used only internally); `services/api/src/auth/tokens.ts`: `OidcTokenVerifier`, `DEV_ISSUER`;
  `services/api/src/modules/billing/access.ts`: `LIFETIME_FREE_RATING_LIMIT`;
  `services/api/src/modules/media/objectStore.ts`: `S3ObjectStore` export (media-worker has its own).
- swing-lab pre-C/D unused exports: `CONTACT_UNCERTAINTIES`, `saveSources`, `readEventsShard`,
  `fingerprintPath`, `GAMEPLAY_VALIDITY_VERSION`, `redistributionEligible`, `SCENE_DETECTOR_VERSION`,
  `duplicateAliasesOf`, `MIN_LANDMARK_VISIBILITY` (vision-geometry), `PaddleTrackSegment`,
  `SequenceTimestep`, `TemporalPhaseBoundaries` (doc-referenced), `JobOutcome` (media-worker).
- `apps/admin-web` coachReview unused exports (`isSyntheticMode` etc.) — apps/ outside ownership.

### Stale feature flags: none found

Every CLI flag added in waves C/D is parsed AND consumed: `--crop-recovery` (C02, deliberately OFF),
`--two-pass`/`--sparse-stride` (C08, OFF), `--no-paddle-worker` (C07 opt-out), `--tight-window`
(D4-07), `--serve` (W2/C07), `--merge-tracklets` (research-only per D-042, guarded by
paddleMergeSafety). The api flags module predates C/D and is live route code. No dead flag plumbing
to remove.
