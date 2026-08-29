# DECISIONS

Format: date, decision, why, alternatives considered. Ambiguity hierarchy (directive §69): Deep Research spec → existing repo architecture → platform docs → simplest reversible professional choice.

## 2026-08-26 — D-001: pnpm workspaces monorepo

Spec/directive require monorepo. pnpm chosen over yarn/npm workspaces: installed locally (10.15.1), strict node_modules isolation, fast, standard for RN+backend monorepos. Turborepo deferred — plain pnpm scripts suffice until build graph grows; reversible.

## 2026-08-26 — D-002: Fastify over NestJS for services/api

Spec allows either. Fastify: lighter, faster cold start, first-class JSON-schema validation pairs directly with Zod-generated schemas, fewer decorator abstractions. Modular monolith boundaries enforced by folder/module convention + lint rules instead of Nest DI. Reversible; contracts live in packages/api-contracts either way.

## 2026-08-26 — D-003: Zod as single schema source

Directive §29 forbids duplicate drifting types. Zod schemas in `packages/api-contracts` produce (a) static TS types for mobile+backend, (b) JSON Schema for Fastify validation, (c) OpenAPI document. zod v4 with native JSON Schema conversion (no external converter dep).

## 2026-08-26 — D-004: Scoring engine as pure TypeScript package first

The scoring math (spec pp. 33–35) is deterministic and model-independent: it consumes measurements, applies data-driven config. Implementing it as a pure package makes it testable now, shared by backend validation + mobile JS orchestration, and portable to native (C++) for the live loop later. The native mirror must pass the same golden test vectors.

## 2026-08-26 — D-005: FixtureVisionProvider guard (superseded)

The first test harness put a guarded deterministic provider beside runtime contracts. D-018 supersedes that compromise: deterministic providers belong under test support only and are not exported by the runtime vision package. The database retains the old `fixture` source value solely for migration/test compatibility.

## 2026-08-26 — D-006: SQL-file migrations with tiny in-repo runner

Full control over DDL from spec pp. 13–17 (checks, FKs, partial indexes) argued against ORM-generated migrations. Runner: ordered `NNNN_name.sql` files + `schema_migrations` table, transactional per file, checksum verification. Drizzle/Prisma can be layered later for query ergonomics; schema source of truth stays SQL.

## 2026-08-26 — D-007: Version vector embedded as one JSONB + typed columns

Spec §22 requires eight version fields per analysis. Hot query fields (`scoring_model_id`, `model_bundle_version`) are real columns; the complete vector is also stored as validated `version_vector` JSONB on `shot` for forward-compatible additions. Never rescored in place.

## 2026-08-26 — D-008: Node 20 LTS baseline

Installed runtime v20.20.0. `engines` pinned `>=20 <21` for now; bump deliberately.

## 2026-08-26 — D-009: Docker not present on dev machine

docker-compose file provided for Postgres/Redis/MinIO/ElasticMQ; documented as prerequisite in LOCAL_DEVELOPMENT.md. DB-integration tests are skipped (not faked) when `DATABASE_URL` is absent — they report SKIPPED, never green-washed.

## 2026-08-26 — D-010: Scoring config v1 shipped as seed data + bundled JSON

The eleven-checkpoint weighting matrix (spec p. 32) and per-shot metric targets ship as `scoring_model` seeds (DB) and as a versioned JSON bundle consumed by mobile offline. Both generated from one source module in `packages/scoring/src/config/v1.ts` to prevent drift. Explicitly labeled "starting hypothesis for expert validation" per spec.

## 2026-08-26 — D-011: Mobile app deferred to Stage 2 with RN New Architecture

Directive §12. Creating the RN project requires iOS toolchain steps done interactively; Stage 1 of this build focuses on foundation packages + backend so mobile lands on stable contracts. Not a scope cut — sequencing per §59. (Superseded same day by the all-at-once build session: RN 0.87 app created, built, and running — see D-013.)

## 2026-08-26 — D-012: Migration 0007 additions beyond the spec table list

`shot_rating` (user feedback per analysis), `billing_offering` (remote-configurable pricing the spec demands but did not table), `feature_flag`, `user_profile.handle` (friend discovery without phone/email), `deletion_task` (the §58 deletion workflow needs a resumable queue). Each maps to an explicit spec requirement; documented here because they extend the p. 13–17 table inventory.

## 2026-08-26 — D-013: apps/mobile is npm-managed, excluded from the pnpm workspace

Metro + pnpm's symlinked node_modules is a known friction source; the RN app uses npm (its lockfile committed) and consumes shared packages from TypeScript source via a metro `resolveRequest` that maps the packages' ESM ".js" specifiers to ".ts" files, plus `nodeModulesPaths` for helper resolution. Jest mirrors this with moduleNameMapper. tsconfig paths mirror it for typecheck. One convention, three configs, all committed.

## 2026-08-26 — D-014: Native modules via local CocoaPod, not pbxproj editing

`ios/LocalPods/PickleNative` (podspec + Swift/ObjC sources) is added by one Podfile line; `pod install` wires it into the Xcode project. Hand-editing project.pbxproj is fragile and unreviewable. First module: PickleAudioCoach (AVSpeechSynthesizer TTS). VisionCore/CameraEngine follow the same pattern when wired.

## 2026-08-26 — D-015: Apple Vision body-pose as the real pose baseline

Spec p. 26 allows a proven on-device baseline. `ApplePoseProvider` (`VNDetectHumanBodyPoseRequest`) needs no model download and runs on-device. It is now wired into iOS capture; Android uses bundled MediaPipe BlazePose. Both render real live pose and measured joint-motion intensity, but neither is validated yet as a source for coaching metrics.

## 2026-08-26 — D-016: Store receipt validation is typed-501 until credentials exist

Directive §5 forbids fake subscription validation. Offerings, entitlements (grant/check/expiry), quota gating, and audited admin grants are fully implemented and tested; the Apple/Google verification calls activate only when `APPLE_IAP_PRIVATE_KEY`/`GOOGLE_PLAY_SERVICE_ACCOUNT` are configured, and say so in their error envelopes.

## 2026-08-26 — D-017: Test databases are per-suite sequential, not parallel

The DB-backed suites (database, api, media-worker) each reset the schema of the test database; root `pnpm test` pins `--workspace-concurrency=1` so they serialize. CI uses one Postgres service container. Parallelization later = per-suite database names.

## 2026-08-27 — D-018: No deterministic inference outside tests

Production and development app runtime now share the same truth boundary: camera observations are real, and absent validated models produce `unknown`/`awaiting_model`. Deterministic inputs remain useful for unit-testing pure scoring/cue orchestration, but live under test support only. Production seeds publish no placeholder drills or instructional media.

## 2026-08-27 — D-019: Successful-rating entitlement accounting

The canonical allowance is exactly two lifetime successful ratings, not launches or capture attempts. A pre-inference permit is consumed atomically only with an accepted scored shot; abstentions, `awaiting_model`, errors, cancellations, unsupported devices, and incorrect recognition release it. The third future successful-rating attempt is a hard paywall unless the server reports an active entitlement.

## 2026-08-27 — D-020: Motion visualization is not a diagnosis

The live colored pose glow is calculated from observed joint displacement and is labeled as motion intensity. It must not be described as muscle activation, injury risk, or form quality. Likewise, no MPH is shown until calibrated ball tracking supplies a measured trajectory with validated error bounds.

## 2026-08-27 — D-021: Scoring config presence is not release authority

Migration `0013` makes seeded scoring configs validating hypotheses and leaves a fresh database with zero active scoring models. Canonical score sync requires an explicit audited release at `PUT /v1/admin/scoring-models/:shotType/:version/release`, bound to a 100%-active SHA-256 model bundle, dataset snapshot, locked evaluation-report hash, coach-validation reference, releasing admin, and exact shot-config version. A client cannot turn a known config into an accepted score by naming its version.

## 2026-08-27 — D-022: Dataset eligibility requires human and legal evidence

The v2 annotation/manifest contracts use the exact 61-technique taxonomy and explicit `unknown_technique`, `no_stroke`, `partial`, and `aborted` outcomes. Synthetic data cannot be release-eligible. Every eligible item must carry consent and rights evidence, at least two annotations, and coach adjudication; the validator enforces these gates before a dataset snapshot can support scoring release.

## 2026-08-27 — D-023: Preserve pose evidence; gate physical speed

An automatic clip now retains a bounded, versioned summary of the exact detected-motion interval: inference attempts, usable/missing poses, canonical visibility/coverage, and sparse per-joint normalized-image movement. This makes the visible scan inspectable after capture without retaining a full landmark stream or inventing a diagnosis. The trigger's highest wrist/paddle-motion timestamp is named `peakMotionMs`; it is never represented as ball contact. Every clip also carries a discriminated ball-speed state. Numeric MPH is accepted only with calibration id, ball-tracker version, high-rate measured track, distance/time, positive confidence, clip-bounded timing, plausible sample density, and bounded reprojection evidence whose units agree. Current native capture returns `unavailable`; wrist/body motion is never converted to MPH. Legacy local captures remain payload-null and explicitly labeled; malformed or metadata-mismatched current payloads receive separate integrity states instead of being disguised as legacy data.

## 2026-08-28 — D-024: Corpus data engine with per-modality rights and a 4-layer split ladder

The flat per-bench registry could not carry the product to real scale. `datasets/corpus/` is now the hierarchical source of truth (SOURCE → RECORDING → SESSION → EVENT), with content-addressed recording ids, per-modality rights profiles (store/analyze/annotate/train/redistribute/commercial — unknown licenses quarantine all modalities), declared+detected lineage, temporal-dHash dedup that auto-merges sessions on detected overlap (it caught all three DVIDS re-uploads of Commons content on first run), same-venue+occasion session grouping, and a deterministic salted-hash split ladder (dev/val/locked_test/shadow) assigned at registration before any human sees a frame. Pins only tighten. Shadow is never mined. The factory (`lab:factory`) is resumable, stage-versioned, and parallel; Tier-C events live in per-recording JSONL shards. Acquisition (`lab:acquire`) is the only door into the corpus and records provenance verbatim. See docs/DATA_ENGINE.md.

## 2026-08-28 — D-025: Windowed mining after a measured zero-recall failure

video-mining-2 produced 0 candidates on a 237s continuous recording with 4.1 visible people per frame because track coverage collapses over long scenes and every track died at the coverage gate. video-mining-3 mines scenes in 12s windows (2s overlap) with cross-window dedup by peak-time + torso proximity. Corpus candidates went 74 → 199, and the previously-zero recordings now yield (tournament 0→24, Sasebo 0→5). Recorded so nobody re-tunes coverage gates against whole-scene semantics again.

## 2026-08-28 — D-026: Target-acquisition bench gates any change to live acquisition Swift

The live guided-capture logic now has an offline replica (`engine/taReplay.ts`, port semantics unit-tested) and a benchmark with human-verified cases. First measurement: sticky ambiguity dead-ends (3/7 verified cases never lock), 37/288 natural false gesture locks, post-lock following mean on-target ≈0.5. Candidate fixes (incumbent hysteresis, 3s ambiguity timeout, 5-frame sustained gesture) dominate the 288-case Tier-C aggregate (false gestures −76%, ≥90%-stable locks +53%) but are unconfirmed on n=7 verified cases, where the timeout fallback locked the wrong person twice. DECISION: no Swift change until ≥30 verified TA cases exist and the variants win on them. The bench makes that a five-minute measurement instead of a shipped regression.

## 2026-08-28 — D-027: Target-acquisition candidate PROMOTED to live Swift after the D-026 gate was met

Verified TA cases grew 7 → 36 (31 dev + 5 locked_test; every verdict has a written note; 6 rejects preserved incl. two graphic-title-card and two non-pickleball-sport exhibits). On dev n=31 the candidate dominates shipped on every dimension (correct locks 16→22, lock rate .806→1.0, false gesture locks 2→0, post-lock on-target .543→.612, cost +111ms median lock latency); a one-shot frozen evaluation on locked_test n=5 confirmed (locks 4/5→5/5, on-target .553→.639). Promoted into `GuidedCaptureViewController` (5-frame sustained gesture; 3s ambiguity timeout → closest-occupant lock) and `ApplePoseProvider.primaryPerson` (incumbent hysteresis: nearest-to-anchor candidate keeps identity unless a challenger wins by 1/0.7≈1.43×). The TS replay's `shipped` variant now mirrors the promoted semantics; the pre-promotion behavior stays replayable as `legacy` with regression tests (single-frame flick must NOT lock; legacy follower newcomer-jump preserved as a documented failure). Residual: crowd-region wrong-locks (~0.29 of locks on machine-proposed regions) — partly case-construction artifact; keep verifying queue cases before further tuning.

## 2026-08-28 — D-028: Gameplay validity is motion-relative, evidence-bounded

Pose fires on humans in title cards, portraits, and non-pickleball segments of multi-sport reels (4 preserved exhibits). liveness-v1 classifies a person-track static_or_graphic only with DENSE wrist evidence (≥10 wrist-pairs/s) and near-zero wrist-motion-RELATIVE-TO-TORSO (<0.02/s) — rigid pans (Ken Burns) have zero relative motion, so animation does not fool it; detection jitter does not condemn live players because a static verdict requires the dense-evidence gate. Measured on real exhibits: catches the static Ohana card and a static human in Sigonella b-roll; the ANIMATED card shows sparse wrists (5.7 pairs/s) and is deliberately NOT auto-condemned (indistinguishable from a blurred live swing) — it surfaces as SPARSE_WRIST_SUSPECT in failure mining for human review. Wired into the miner (v4), TA proposer, and failure mining; synthetic regression tests cover live/rigid-pan/frozen. Sport-context validity (wallyball/flag-football exhibits) needs court/ball evidence and remains recorded future work.

## 2026-08-28 — D-029: Adaptive movement completion is a measured candidate, NOT promoted

FIXED 1.5s post-roll vs ADAPTIVE (settle < max(0.15, 25% peak) for 400ms, OR next-stroke valley: dip <60% peak then ≥1.5× rise → end at valley, OR +2500ms safety) on the 5 gold events: median |end error| 1080→510ms, recovery-end excess 1051→251ms, clips slightly shorter, zero contact/follow-through/recovery losses. The settle-only variant LOSES (median 1750ms) — continuous rallies never settle; the valley condition is what makes adaptive viable, i.e. completion and multi-event segmentation are the same problem. NOT promoted: n=5, replay-only, trigger idealized from label windows. The shipped FIXED behavior stays until the live trigger is instrumented and ≥20 gold events agree (D-027-style gate). The cascade instrument (lab:cascade) is now the product-level gate for any such promotion: today only 1/5 gold strokes survives video→stroke end-to-end (losses: event selection, ball-body overlap, contact error, phase inversion — each named and distinct).

## 2026-08-28 — D-030: StrokeEvent proposal decoupled from paddle representation (stroke-event-2)

Two recorded failures shared one root cause: proposals were paddle-speed-sourced whenever paddle coverage ≥ 0.35, so the paddle representation defined which movement existed (merge flipped rally1 contact 73→2411ms; the cascade found a selected event with 0% gold overlap). stroke-event-2: target BODY (wrist) motion proposes — with ≤350ms fragment glue and two-threshold boundary relaxation ≥max(12% peak, 0.08) — and paddle evidence only confirms/ranks/refines (peak refinement ≤250ms, prominence tie-break); paddle-only proposals exist solely as a flagged fallback. Contact SCOPE was decoupled from event bounds (peak ±450ms) after widened windows tripped the disagreement gate. Contract unit-tested: paddle content cannot create, delete, or re-bound a proposal; verified live under --merge-tracklets (event sets byte-identical). Measured on the 9 event labels: target recall 4/5→5/5, false proposals 8/14→3/9. Cascade survival stays 1/5 but the loss moved from wrong-event to CONTACT abstention (compact strokes peak wrist speed after contact) — contact fusion is now the binding constraint. Merge promotion remains blocked on target-conditioned reconciliation + target-gated contact evidence (a merged other-player fragment plus an opponent-side ball direction change still fabricates a confirmed contact in the wrong window). Held-out cases were regenerated twice tonight (v2, then contact-scope fix); disclosed in EXP-2026-08-28-event-decoupling.

## 2026-08-28 — D-031: Technique intent is one canonical architecture (tap · voice · auto)

technique-intent-v1 (shared-types): SELECTABLE_TECHNIQUES_V1 mirrors the v3 recognition taxonomy with legacy-slug mapping; a DETERMINISTIC resolver (bounded synonym/side grammar, 10 tests) maps natural language to the registry — genuinely ambiguous phrases return narrowed options, garbage returns unknown, nothing outside the registry can become a route. TechniqueAnalysisProfiles are versioned and honest (every evaluator = BLOCKED_ON_VALIDATION, drill mapping = none, abstain-over-invent). Mobile "WHAT ARE YOU WORKING ON?" picker (Mobbin-researched: Oura dictation-in-search field, Life Reset chip grid) ships tap + voice (iOS keyboard dictation → resolver) now; AUTO DETECT is visible but honestly gated with copy explaining the verified-classifier dependency — declared-null routing through the analysis chain is the recorded follow-up. Declared remains context; predictedStroke stays separate.

## 2026-08-28 — D-032: Detector production shortlist = stride 3 + target ROI (not yet promoted)

ROI × keyframe grid (16 cells, 2 dev cases, S0 vs gold labels): stride is the latency lever (rally1 12.2s→2.9s at stride 4 with recall 0.846→0.923), target ROI is the quality lever (volley 0.25→0.375/0.5 — fixed-input-size detector sees the paddle bigger; ms/frame ~constant so ROI does not cut per-frame cost). Shortlisted operating point stride-3 + target-ROI (−65% detector compute, S0 recall ≥ full/stride-1 on both cases). NOT promoted: S0-level only, n=21 labels — must pass the full pipeline (benches + cascade) first. Expert-coach program infrastructure now exists (schema, validator, queue of 5 gold events, 0 reviews — recruitment is a human step); best-in-class claim formally reviewed and FAILED (docs/CLAIM_REVIEW.md) — approved language: "Pickle Sensei is still being validated."

## 2026-08-28 — D-033: contact-evidence-4 — target-gated temporal kernel-density contact fusion

The flat weighted-mean + >250ms-spread-abstain fusion (contact-evidence-3) was the cascade's binding constraint (1/5 unconditional; compact strokes and multi-signal spreads always abstained; rally2 pinned 274ms early by an opponent-side ball turn). v4 fuses every signal occurrence as a Gaussian kernel (center = timestamp − per-signal/per-stroke-family offset prior, mass = reliability, width = signal σ), answers at the density argmax, ships the distribution + modes, and abstains for four named reasons (insufficient mass, comparable multi-modes, motion-peak divergence, ball-contradiction). Ball evidence is TARGET-GATED (torso-normalized distance to the target's paddle/wrist; opponent-side turns rejected and logged). Dev: volley 43→30ms (ball+paddle confirmed), rally2 274→30ms (paddle confirmed, opponent ball rejected), rally1 honest structured abstention (evidence at 1970 vs movement peak 3403 — zero tracked support at gold 2900). Held-out ONE-SHOT disclosed honestly: both held-out cases now ESTIMATE where v3 abstained, and both are wrong (dink 250ms on a wrong-event window; vic 245ms with ball+paddle confirmations at 400-435 vs gold 680) — v4 trades held-out abstentions for wrong answers on evidence-shaped-differently cases; the usable-result-v1 fabrication veto catches both. Next contact tuning must come from NEW dev labels (Q's 34-event corpus), not held-out iteration.

## 2026-08-28 — D-034: ball-track-2 — explicit body-occlusion state machine with honest reacquisition

Rally2's ball died at the target's body (BALL_BODY_OVERLAP slice 0 recall) because the primary selector required ball-paddle proximity that an overhead lob never satisfies, so the reacquisition linker never ran. ball-track-2 adds TRACKED → ENTERING_OCCLUSION → OCCLUDED (hard 500ms max) → REACQUIRED|LOST as first-class per-track state, a body-occlusion primary fallback (fires only without a paddle-aligned candidate; straightness/dwell/ends-into-body/ambiguity-margin gated), and body-emergence reacquisition (exit-motion + velocity-corridor + 1.3× margin, else honestly LOST). Predictions are flagged and never observations. Rally2 BALL untracked→TRACKED (43 obs; reacquisition FAILED_AMBIGUOUS honestly); slice recall 0→0.17; volley byte-identical; rally1 unchanged (different failure class: fragmentation, not occlusion). Cascade BALL 4/5→5/5 unconditional.

## 2026-08-28 — D-035: paddle-track-2 — flip-SEGMENTATION replaces flip-truncation in S4 selection

Forensics (46-label parity replica, 5/5 agreement with production) proved the rally1 9/13→0/13 catastrophe was NOT the ranking objective (measured near-optimal: CF0 .50 vs oracle .52): the selector picked the right track, then sustainedOtherPlayerFlip TRUNCATED the winner's observations at a 3-obs flip (734ms), deleting the decisively target-owned tail (wristD .086 vs .239) that held all 13 gold boxes, and kept STALE score terms afterward (rally2: a track cut 79→10 obs kept coverage 0.986). paddle-track-2 splits tracks at sustained-flip boundaries, judges each segment fresh with the same 0.85 ownership test, keeps the decisively-target-owned segment set, and recomputes all terms from surviving observations. Measured (65-label snapshot): S4 R .29→.43 (dev .20→.53, exactly the forensics forecast), S4 Δrecall −.22→−.02, rally1 selection 13/20 = its per-case ceiling; D-030 event invariance verified byte-identical; volley cascade non-regressed. Dink's replay "drop" 9/19→5/19 is the stale-coverage bug's artifact (production already selected T18=5/19).

## 2026-08-28 — D-036: stroke-heuristic-2 — plausibility-gated contact point + corroborated OVERHEAD + abstention band

rally2 was confidently wrong (BACKHAND 0.80 vs gold OVERHEAD) because the classifier trusted a stale mid-body paddle box (conf .08–.28) as the contact point while the real paddle was raised (edge-on, undetected). v2 gates the paddle contact point on kinematic plausibility (≤1.2×arm-length from the dominant wrist, arm measured from pose; else wrist fallback, recorded), decides OVERHEAD from a corroboration matrix (raised-wrist/elbow frame counts over ±150ms vs point provenance; degraded-point + skeleton-quiet claims nothing), and abstains (UNKNOWN) on degraded provenance + small margins instead of guessing. Dev: rally2 → OVERHEAD 0.70 (window-over-degraded-point branch), volley unchanged, dev L1 2/2, zero confidently-wrong dev predictions. Held-out one-shot: vic-rally1 stopped claiming OVERHEAD but now claims BACKHAND 0.80 (still confidently wrong — its stale-paddle shape differs; recorded, not iterated). Mobile port strokeHeuristicLite (W4) is still v1 — sync follow-up filed.

## 2026-08-28 — D-037: usable-result-v1 — the second north-star metric, printed beside strict survival

lab:cascade now scores every gold event against a versioned evidence contract (TARGET+EVENT strict, honest-or-correct stroke, trustworthy replay artifact (contact ≤66ms; or ≤132ms confirmed w/ visible uncertainty; or honest-abstention ordered timeline), fabrication veto >132ms). It exposed product sins strict staging hid: rally2's old 274ms marker was FABRICATED EVIDENCE, 2/5 strokes were confidently wrong, and phase-contact coupling made honest-abstention timelines unreachable. Current: strict 2/5 · usable 2/5 (same survivors; both vetoed held-out cases fail specifically on fabricated markers + wrong confident strokes — the honest-presentation work is now measurable).

## 2026-08-28 — D-038: phases v2.1 — anchor-free segmentation + full ordering invariant

Phases v2 abstained whenever contact abstained (PHASE_CONTACT_ANCHOR_MISSING), making usable-result clause (c) unreachable. v2.1 segments WITHOUT a contact anchor when the selected event + motion series support it: boundaries around the measured kinematic peak, anchorBasis "event_peak", NO contact boundary (NaN in-process, null in JSON — report.ts renders "— (anchor-free)"), stricter evidence gates with named abstentions, byte-identical anchored path (pinned tests). The held-out one-shot then exposed a REAL anchored-path invariant gap: accel could land after contact across a sparse pre-contact gap (dink: accel 1520 > contact 1510) — repaired like the followEnd rule (clamp to last pre-anchor observation, else PHASE_NO_PRE_CONTACT_EVIDENCE; dink re-regenerated with the repair, verdict unchanged — disclosed). Cascade PHASE 2/5→4/5 unconditional.

## 2026-08-28 — D-039: AUTO DETECT is real end-to-end (declared-null routing shipped)

analysis-pipeline accepts declaredStroke=null: prediction resolves the profile (L3 leaf → exact; L1/L2 → SHARED family profile with result:null + phases/evidence recorded; UNKNOWN/low-confidence → typed abstention; conservative structural gates because stroke-heuristic confidence is uncalibrated). Every record carries strokeIntent {declaredStroke, predictedStroke, resolutionBasis, resolvedProfileId, disagreement} — declared/predicted never merge. Mobile: AUTO chip emits a real intent; guided-capture runs declared-null; abstention releases the rating permit (D-019 honored); honest copy for family-level reads and withheld results. Imported video stays declared-only pending import-time pose. Classifier = registry-listed port (strokeHeuristicLite, vision-geometry) — mobile cannot import swing-lab.

## 2026-08-28 — D-040: Session multi-event engine is canonical and mobile-wired; native gaps named

sessionEngine (analysis-pipeline, re-exported through swing-lab) streams wrist-speed samples, emits append-only StrokeEventProposal-canonical events closed by D-029 settle-or-valley-or-safety semantics (constants cited to eventCompletionBench), never mutates a closed event, and was replay-validated on both dev rallies (5/5 batch events, bounds Δ=0ms, closedAt ≤ end+2500). Mobile LiveCourtScreen renders the real session model (header counts, family-colored timeline, per-event state chips pending|processing|ready|abstained) with an honest per-event analysis stub (NATIVE_CLIP_EXTRACTION_NOT_BUILT). Remaining native gaps, precisely: continuous wrist-speed emitter past pendingStroke.endMs+1500, and per-event clip extraction; then per-event analysis dispatch uses declared-null routing.

## 2026-08-28 — D-041: Detector service path — drain-loop fix (bit-equal) + persistent worker; stride/ROI stays unpromoted

P's profiling (55.07s cold E2E on rally2) attributed ~17s to "ffmpeg decode residual"; W2's phase profile corrected the attribution: the waste was per-detection MPS→CPU tensor syncs in the drain loop (~170.7ms/frame). Batching result tensors to CPU once per frame is BIT-EQUAL (4519/4519 boxes, IoU 1.0) and now default; local-first model load and a --serve JSONL worker kill the per-invocation import/load overhead. Measured: E2E 55.07→17.25s (paddleDetect 43,675→11,188ms) with zero TS changes; warm worker ~5.8s/request → ~11.9s E2E projected when runPaddleStage wires --serve. Static stride-3+ROI was full-pipeline INVALIDATED (H: volley COMPLETE→LOST AT CONTACT 43→87ms, rally2 paddle association margin 1.1946<1.25 → UNTRACKED) — D-032's shortlist is superseded by the W2 service path + a future adaptive two-pass (stride-3 scan + stride-1 densification at event peak ±450ms). Mac numbers only; iPhone unmeasured (hardware absent).

## 2026-08-28 — D-042: Fragment merge remains NOT production-safe after target-gated contact (re-verified)

With contact-evidence-4 + paddle-track-2 in, --merge-tracklets on dev: volley identical (6650, confirmed); rally2 contact degrades 30→145ms (merged fragments alter the paddle-speed series feeding fusion); rally1 selects an early-rally event with a target-gated "confirmed" 695ms contact that matches no gold contact (nearest labels 317/1117). Merge stays research-only; the oracle ceiling (R .97) is claimed next through segment-level ownership INSIDE merge reconciliation + per-segment contact evidence, not by flipping the flag.

## 2026-08-28 — D-043: Evidence-growth wave — events 9→34, TA 36→59, ownership duals 14→30, first blind multi-annotator overlap

All growth is frame-verified visual annotation (annotator ids recorded; rejects ledgered incl. non-pickleball contamination in dvids-943757/1007845; shadow untouched; locked_test untouched except pre-existing labels). D-029's ≥20-event data gate is MET: completion bench n=20 usable — FIXED median |end err| 1371ms vs ADAPTIVE 668ms, recovery 1200 vs 620, zero contact losses (clean subset 1385 vs 510) — promotion now waits only on live-trigger replay captures (instrumentation shipped this run, default FIXED). First multi-annotator measurement: TA 83.3% raw/κ0.44 (definitional disagreements — "bystander_target" rule needs writing), ownership 90.3%/κ0.78 (temporal-context tooling recommended); 5 disagreements filed for adjudication. TA bench-only candidate acquire-v4 (tap-centered gate + sustained-ambiguity) measured: correct locks .685→.863, contested wrong-rate .361→.167 on dev n=54 — awaiting D-027-style promotion (one-shot locked_test + live tap-distance instrumentation).
