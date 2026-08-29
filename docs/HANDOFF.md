# PICKLE SENSEI — PROJECT HANDOFF / STATE OF THE WORLD

> **⚠ SUPERSEDED: start new sessions from `docs/HANDOFF_V2.md`.** This file is
> retained as history for the 2026-08-28 morning/evening runs; V2 incorporates the
> later master-mandate run (event decoupling D-030, technique intent D-031, ROI grid
> D-032, coach program, claim review) and corrects any numbers that moved.
>
> **Purpose of this file:** complete context for starting a fresh working session.
> Last updated: 2026-08-28 (night: PRODUCT-VALIDATION run — TA promoted, cascade measured). Everything below is measured, not aspirational.
> Companion docs: `docs/DATA_ENGINE.md` (the data factory — READ THIS SECOND),
> `docs/PERCEPTION.md` (deep perception history), `docs/IMPLEMENTATION_STATUS.md`.

---

## 1. WHAT THIS PRODUCT IS

Pickle Sensei is a production-bound iOS/Android pickleball technique-analysis app
(React Native + native Swift capture + TypeScript analysis packages + Python/Swift
research tooling). Long-term standard: world-class perception + temporal stroke
understanding + expert-validated coaching, at consumer latency (≤2–5s post-capture).

Two product modes:

- **STROKE ANALYSIS (flagship):** one declared movement → zero-touch capture → deep analysis of ONE StrokeEvent.
- **SESSION ANALYSIS:** long gameplay → many StrokeEvents → per-event analysis + aggregation. (Foundation only today — routes to existing LiveCourt experience; multi-event engine NOT built.)

The atomic unit everywhere: **ONE TARGET PLAYER + ONE STROKE EVENT.** Never analyze a rally as one motion.

---

## 2. NON-NEGOTIABLE RULES (violating these has burned us before)

1. **TECHNIQUE SCORING = BLOCKED_ON_VALIDATION.** Expert coach labels = **0**. Do NOT touch sm-v1 thresholds, do not fabricate scores/faults/drills, do not lower abstention to fill UI. The Result screen stays honest.
2. **No fake observations.** DETECTED / TRACKED_ESTIMATE / PREDICTED are distinct everywhere (ball bridge points are hollow/flagged; merged paddle gaps stay gaps).
3. **Held-out discipline.** `wm-dink-01` + `afn-vic-rally1` (session `afn-vic-2025`) are held-out. Never tune against them; evaluate once after freezing. Dev cases: `wm-volley-02`, `afn-sasebo-rally1`, `afn-sasebo-rally2`.
4. **Frozen baselines are immutable** (`datasets/ball-bench/baselines.json`, experiment JSONs). New results = new artifacts, never edits.
5. **Provenance for all media.** Only PD/CC-BY/consented footage. Pexels/Pixabay/Coverr ToS forbid ML training — rejected. Every acquisition records license/source/author/session in `datasets/paddle-bench/registry.json`.
6. **Declared vs predicted vs annotated stroke stay separate fields.** User declaration is context, never ground truth.
7. **No training theater.** Every learned task is currently **BLOCKED_ON_DATA** with floors recorded in `datasets/releases/pickle-real-v0.1/training-justification.json`. Do not train on ~5 labels to "have ML".
8. **Region/tap seeds are INITIALIZATION ONLY.** After target lock, identity follows the PHYSICAL PERSON (crossing, stacking, kitchen). Court half never re-decides identity.
9. **Scene validity is hard-gated.** No track/event/contact may cross a shot cut (the whiteboard-interview false-contact exhibit is the regression case).
10. **Mac numbers are not iPhone numbers.** PHYSICAL IPHONE LATENCY: NOT MEASURED — say so until measured.
11. **`lab:acquire` is the ONLY door into the corpus.** Every file needs origin, per-modality rights (store/analyze/annotate/train/redistribute/commercial), SHA-256, probe. Unknown license ⇒ all modalities quarantined.
12. **SHADOW is untouchable.** Never mine, render, inspect, or annotate shadow sessions; split pins may tighten (→dev) but never loosen (→shadow). Same venue+occasion = one session = one split.
13. **Tier separation is semantic, not cosmetic.** GOLD = human-verified; SILVER = verification-passed teacher output (currently 0 — keep it 0 until something earns it); Tier-C = candidates, never reported as labels. Live-acquisition Swift changes are gated on the TA bench (D-026).

---

## 3. CURRENT MEASURED STATE (the numbers that matter)

### Paddle (THE quality bottleneck — fully diagnosed)

Waterfall on 5 real cases / 3 sources / 27 visible labels (`pnpm lab:paddle-waterfall`):

| Stage                          | P    | R                                        |
| ------------------------------ | ---- | ---------------------------------------- |
| S0 raw D-FINE detector         | 0.68 | **1.00**                                 |
| S1 candidate filter            | 0.65 | 0.96                                     |
| S2 track formation             | 0.65 | 0.96                                     |
| S2b tracklet merge (candidate) | 0.65 | 0.96                                     |
| **S3 ownership**               | 0.26 | **0.22** ← 74 of 78 lost points die HERE |
| S4/S5 final (shipped)          | 0.27 | 0.22                                     |

- **Oracle ceilings:** perfect selection alone R 0.59; perfect fragment merge R **0.96**. Merging is the right attack.
- `mergePaddleTracklets` (shipped behind `--merge-tracklets`, NOT default): S3 → P .59/R .48, final P .67/R .30, wrong-player 0/2 — **but causes a downstream cascade**: merged paddle-speed profile changes EVENT selection → rally1 contact 73ms → 2411ms, event recall 4/5→3/5, stroke L2 3/4→2/4. **Fix needed: decouple event proposal from paddle-speed peaks (target body/wrist proposes; paddle/ball/contact confirm).**
- Failed experiment (recorded, don't repeat): hand-affinity-dominant rescoring → S4 R 0.22→0.04, reverted. Wrist positions too unreliable to carry selection alone.
- **RF-DETR-L evaluated and REJECTED** (P .64/R .93/95ms vs D-FINE P .68/R 1.00/72ms). The detector was never the bottleneck. Don't shop for detectors.
- Root cause A FIXED: duplicate player tracks (same human → P1+P9+P13) were fed to ownership as "other players" → target's own wrist opposed its own paddle. Fixed via torso/wrist coincidence suppression + alias absorption in `playerTracker.ts`.
- **Wrong-player rate now directly measured: 0/2 dual-labeled frames** (only 2 exist — see data gaps).

### Ball

- `ball.motion-diff-tracker.v1` frozen. Volley: P .83/R .83, 9px median. State machine TRACKED→OCCLUDED→REACQUIRED (contact-aware, 1 real SUCCESS) / LOST (2 honest failures). Held-out BLUE ball tracked (35 obs).
- Open failure: **BALL_BODY_OVERLAP** (rally1: 0/4 recall when ball crosses white shirt).

### Contact / Events / Phases / Stroke

- Contact (event-local, per-event scan; contact belongs to exactly one event): **n=5, 0 abstained, median 66ms**; held-out vic **34ms = 1.0 frame**; within-2-frames 3/4. Confidence classes reported separately.
- Events (`stroke-event-1`): n=9 labels — target recall 4/5, contact-inside-matched 5/5, start/end median 224/281ms, false proposals 8/14. MULTI_STROKE_AMBIGUOUS is a first-class honest outcome; per-event confirmed-contact scan resolves it when evidence exists.
- Phases 4-way on identical 15 boundaries: geometry.v1 (FROZEN FAILURE, 880–2366ms) · paddle-speed 765–1065ms · v1+anchor 73–197ms · **v2 event-local best (accel 160 / contact 73 / follow 130 / recovery 400ms), anchor-or-abstain** (PHASE_CONTACT_ANCHOR_MISSING / PHASE_WRONG_EVENT). Known v2 defect: one held-out boundary inversion (followEnd < contact) recorded, unfixed.
- Stroke (heuristic hierarchy, L3 abstains without bounce): **L1 4/5, L2 3/4, L3 0/5 all abstained (by design)**. Remaining L2 miss = perception cascade (post-contact paddle sampling), not classifier logic. `classifyStroke` has NO midpoint fallback — event peak reference only, flagged.
- Player identity: user-tap/seed experiment measured — identity confidence auto→seeded: held-out 0.30→**0.94**, volley .38→.84, dink .50→.83; recovered held-out dink contact to ball+paddle-confirmed. Seeding does NOT move paddle P/R (ownership is the bottleneck, not person selection).

### Latency (Apple M-series research path, 8s clip — NOT mobile numbers)

- pose+people+scenes ~6.9s · **paddle detect ~14.6s event-gated** (21.6s full) · ball ~0.9s · logic small · **wall ~23s** (was 30s; event-gated detector span = −32% and improved contact).
- Target: ≤2s ideal / ≤5s max. **NOT MET.** Two known big wins not yet done: capture-time pose reuse (~6.9s) and target-ROI/keyframe detection (~14.6s).

---

## 4. MOBILE APP — WHAT ACTUALLY SHIPPED (verified: Swift parse 0 err, TS 0 err, 21 suites/107 tests, lint 0)

**Live Stroke Analysis flow (zero-touch after walking out):**

1. Home → two mode cards: **Stroke Analysis** (→ Analyze) / **Session Analysis** (→ LiveCourt).
2. Declare movement → guided camera opens.
3. **STEP 1 OF 2 · SET YOUR POSITION — "Tap where you'll be standing"** (user is AT the phone; we corrected the physically-absurd "tap yourself from 20ft away"). Persistent dashed region ring.
4. **"STARTING SPOT SET / Go to your position"** — 26pt `prominent` distance-readable states.
5. Region-occupancy acquisition (`considerTargetAcquisition` in `GuidedCaptureViewController.swift`): person's torso in region for 9-frame streak → lock. **≥2 occupants → "TWO PLAYERS IN YOUR SPOT / Raise your paddle"** → SUSTAINED wrist-elevation (>0.03 above shoulders for 5 consecutive frames) confirms; if nobody gestures within 3s, the occupant closest to the tapped spot locks (`ambiguity_timeout`). Post-lock following uses incumbent hysteresis in `ApplePoseProvider.primaryPerson` (challenger needs 1.43× score). All promoted via D-027 after 36-verified-case measurement.
6. Lock → ring disappears (region discarded), `poseProvider.setPrimaryPersonSeed(torso)` → anchor follows the PERSON. "PLAYER LOCKED ✓ / Swing when ready".
7. **Stroke trigger gated on lock** (partner motion can't start capture). Existing 2s pre-roll + auto-trigger + 1.5s post-roll auto-finalize.
8. Clip completes with `targetSeed {x,y,source: start_region_occupancy|gesture_confirmed}` → **auto-analysis** (`AnalyzeScreen` zero-touch path) → auto-navigate to Result.

**Imported video:** keeps direct "tap yourself" (`TargetSelector.tsx`, imports-only). Correct context for it.

**Mobile gaps (honest):** movement completion still FIXED 1.5s post-roll (adaptive completion not built); Session multi-event engine not built; capture-time pose reuse not measured as latency delta; on-device acquisition metrics instrumented (`target` events) but unmeasured; iPhone latency unmeasured. TargetSeed reaches analysis request but on-device perception consumption = pose-anchor only (research-grade multi-person TargetIdentity not ported).

---

## 5. DATA STATE — `pickle-real-v0.2` (immutable, hash-sealed) + THE DATA ENGINE

**The data factory now exists** (docs/DATA_ENGINE.md). `datasets/corpus/` is the
hierarchical source of truth: SOURCE → RECORDING (content-addressed `rec-<sha12>`)
→ SESSION (split unit) → windowed scenes → Tier-C candidate events (JSONL shards).

- **20 sources** (16 DVIDS PD + 4 Commons CC-BY/PD) · **26 recordings (17 roots, 62.9 min root footage)** · 12 sessions · all training-eligible with per-modality rights profiles (store/analyze/annotate/train/redistribute/commercial; unknown licenses auto-quarantine).
- **Split ladder (deterministic salted-hash at registration; pins only tighten):** dev 9 sessions/21.6min · val 0 (fills from future acquisitions — do NOT hand-move) · locked_test afn-vic-2025 · **shadow 2 sessions/40.1min NEVER mined or inspected**.
- **Dedup works:** temporal dHash caught all 3 DVIDS re-uploads of Commons content on first run and auto-merged sessions (incl. the VIC copy into locked_test). Spatial crops rely on declared lineage (all 6 legacy crops declared). Same-event grouping via `session-groups.json` (Marne ×3, Warrior Games ×3, ESPN ×2).
- **Tier-C: 199 mined candidate stroke events** (windowed miner v4 with liveness gate — v2 had a measured ZERO-recall failure on long recordings, D-025) + 253 proposed TA cases. **GOLD:** paddle 54 target + 33 other-paddle (**20 dual frames**, was 2; +15 hard negatives, 7 ambiguous with provenance in ownership-review.json), ball 22, contact 5, stroke 5, phase 25, events 9, **36 verified TA cases** — all single-annotator. **SILVER: 0 (honest).** Releases: v0.1/v0.2/v0.3 sealed.
- **Failure mining:** `lab:failure-mine` → 43 stress findings (37 TRACK_FRAGMENTATION, crowded/no-people/churn) merged with high-uncertainty candidates into `datasets/corpus/annotation-queue.json` (**203 ranked entries**).
- **Learning curves:** `lab:learning-curve` → paddle AND ball recall are **UNSTABLE at n=3 dev cases** (leave-one-out swings 0.38/0.63) — quantified proof that no reliability claim is allowed at current n.
- Known coverage holes: left-handers 0, serves/returns 0, bounce labels 0, low light 0, second annotator 0.
- Experiments: `EXP-2026-08-28-{rfdetr-teacher, paddle-waterfall, tracklet-merge, user-target-seed, target-acquisition-bench, ta-candidate-variants}.json`.
- v0.1 remains sealed; v0.2 adds corpus/tiers/ladder sections (schemaVersion 2, 0 problems, 1 documented wm warning).

---

## 6. KEY COMMANDS

```
# DATA ENGINE (new — the factory)
pnpm lab:acquire <dvids|commons> [--query q] [--limit N] [--dry-run]  # ONLY door into the corpus
pnpm lab:corpus-sessions                                  # apply session-groups.json (venue+occasion grouping)
pnpm lab:factory [--stage all|extract|fingerprint|dedup|mine] [--jobs N] [--include-protected]
pnpm lab:corpus-status                                    # live corpus dashboard + integrity audit
pnpm lab:failure-mine                                     # stress scan → annotation-queue.json
pnpm lab:ta-bench propose|render [caseId]|run [--all] [--variant shipped|hysteresis|ambiguity-timeout|sustained-gesture|candidate]
pnpm lab:learning-curve                                   # metric-vs-n with bootstrap intervals
pnpm lab:corpus-init                                      # legacy v1-registry import (idempotent, already run)

# PERCEPTION LAB (unchanged)
pnpm lab:analyze <video> --stroke X [--target-tap x,y|--target-side left] [--merge-tracklets] [--full-scan] [--player N] [--overlay] [--reuse-extract]
pnpm lab:paddle-waterfall [--dev-only|--held-out-only]   # THE instrument
pnpm lab:paddle-bench / lab:ball-bench / lab:stroke-bench # events+stroke+phase 4-way
pnpm lab:mine <video> · lab:dataset-release · lab:data-gaps · lab:dataset-report
pnpm lab:annotate <bundlesDir> <port>                     # accept/correct bench (live-smoke-tested)
pnpm typecheck && pnpm lint && pnpm test                  # workspace (67 swing-lab tests incl. 19 engine)
cd apps/mobile && npx jest                                # 107 tests
cd native/swing-lab && swift build -c release             # extractor+overlay
tools/paddle-lab/.venv                                    # D-FINE detector, ball_candidates.py, RF-DETR teacher script
```

Key files: `packages/swing-lab/src/engine/{corpus,acquire,factory,minerCore,fingerprint,splits,rights,taReplay,failureMine,importLegacy,sessionGroup,corpusStatus,probe}.ts` · `packages/swing-lab/src/{targetAcquisitionBench,learningCurve}.ts` · `packages/swing-lab/src/{paddleTracker,playerTracker,ballTracker,strokeEvents,phaseTemporal,strokeHeuristic,sceneValidity,paddleWaterfall,mineVideo,datasetRelease}.ts` · `native/swing-lab/Sources/main.swift` (extract/overlay v5) · `native/vision-core/Sources/ApplePoseProvider.swift` (extractAllPoses, setPrimaryPersonSeed) · `apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift` · `apps/mobile/src/screens/{HomeScreen,AnalyzeScreen}.tsx`.

---

## 7. TARGET ACQUISITION — MEASURED, FIXED, PROMOTED (D-027)

`lab:ta-bench` replays a unit-tested TS port of the live acquisition. Verified
cases grew **7 → 36** (31 dev + 5 locked_test; 6 honest rejects incl. 2 graphic
title cards + 2 non-pickleball-sport scenes). On dev n=31 the candidate
(incumbent hysteresis + 3s ambiguity timeout + 5-frame sustained gesture)
dominated shipped on EVERY dimension (correct locks 16→22, lock rate .806→1.0,
false gestures 2→0, on-target .543→.612); one-shot frozen locked_test n=5
confirmed (4/5→5/5 locks, on-target .553→.639). **PROMOTED into Swift**
(`GuidedCaptureViewController` + `ApplePoseProvider` incumbent hysteresis);
pre-promotion behavior preserved as `legacy` replay variant with regression
tests. Residual: ~29% of locks on machine-proposed crowd regions pick a
bystander — partly case-construction artifact; keep verifying queue cases.

## 8. THE PRODUCT CASCADE — measured end-to-end (lab:cascade)

**1/5 gold strokes survives video→target→event→paddle→ball→contact→phase→stroke.**
Survival: TARGET 5/5 → EVENT 4/5 → PADDLE 4/5 → BALL 3/5 → CONTACT 2/5 → PHASE 1/5.
Named losses: rally1 EVENT selection picked a 0%-overlap window (paddle-speed
proposal defect → wrong stroke downstream); rally2 BALL body-overlap (contact
still landed 62ms paddle-only); dink CONTACT 147ms; vic PHASE followEnd≤contact
(known v2 inversion). Passing EVENT selections are systematically NARROW
(30-65% overlap; contact-inside saves them). Ownership evidence: **dual-paddle
gold 2 → 20 frames (+15 hard negatives, 7 ambiguous with provenance); shipped
wrong-player rate 1/19 (5.3%)**. New waterfall baseline on 41 labels: S0 R 1.0
→ S3 ownership R .49 (−.49) → **S4 selection −.22 (NEW finding: S4 zeroes
rally1 after S3 kept 9/13)** → S5 R .32; oracle merge ceiling .98.
Completion: ADAPTIVE (settle-or-valley) beats FIXED 1.5s offline (end error
1080→510ms, recovery excess 1051→251ms, zero losses, n=5) — D-029, NOT
promoted (live-trigger instrumentation first). Gameplay validity: liveness-v1
gate live (D-028) with title-card exhibits as permanent regressions.

## 9. EVENT DECOUPLING SHIPPED (D-030) + THE NEW MEASURED STATE

**stroke-event-2 is live:** target BODY motion proposes (≤350ms fragment glue +
two-threshold boundary relaxation); paddle only confirms/ranks/refines; contact
scope = peak ±450ms (decoupled from event bounds). Contract unit-tested AND
verified live: event sets are byte-identical under `--merge-tracklets`. Events:
target recall 4/5→**5/5**, false proposals 8/14→**3/9**. Cascade survival still
1/5 but losses moved from wrong-event to **CONTACT abstention** (compact strokes
peak wrist speed AFTER contact; disagreement gate fires) — **contact fusion is
now the binding constraint**. Merge promotion still blocked: merged other-player
fragments + opponent-side ball direction change fabricate a confirmed contact
(target-conditioned reconciliation + target-gated contact evidence needed).

**Also landed this run:** technique-intent-v1 (D-031: canonical registry +
deterministic resolver + Mobbin-researched mobile picker; tap + dictation-voice
live, AUTO honestly gated) · ROI×keyframe grid (D-032: shortlist = stride 3 +
target ROI, −65% detector compute at equal-or-better S0; NOT promoted — full
pipeline validation pending) · expert-coach program infrastructure
(datasets/coach-review/queue.json — 5 gold events, **0 reviews**, schema+
validator ready) · formal best-in-class claim review: **FAIL**
(docs/CLAIM_REVIEW.md; approved language: "still being validated").

## 10. NEXT BOTTLENECKS (ranked, evidence-backed — start here)

**QUALITY #1 — CONTACT MULTIMODAL FUSION.** The cascade's binding constraint:
1/5 unconditional contact pass. Compact strokes (dink) put the wrist peak after
contact; the disagreement gate abstains (307/380ms spreads on held-out). Fuse
ball/paddle/wrist with per-signal reliability priors + target-gating (evidence
must belong to the TARGET's paddle/wrist) instead of the flat disagreement gate.
Target-gating is ALSO the merge unblock (D-030's fabricated-contact exhibit).

**DATA #1 — queue → GOLD.** TA 36→50-100 (253 proposed remain); dual-paddle
20→30+ (12 rendered frames unreviewed); second annotator ≥3 cases (top
credibility gap); bounce labels 0 (blocks L3); contact-slice gold for
ball-body-overlap.

**LATENCY #1 —** promote stride-3+target-ROI through the full pipeline
(benches + cascade), then capture-time pose sidecar consumption (~6.9s), then
adaptive-completion live-trigger instrumentation (D-029 gate). Physical iPhone
latency: STILL NOT MEASURED.

**PRODUCT #2 —** declared-null (AUTO) routing through runCaptureAnalysis;
Session multi-event engine (completion valley = segmentation primitive);
S3→S4 selection forensics instrument (rally1: S3 9/13 → S4 0/13 unexplained).

**SCALE #3 —** broader PD acquisition + first-party consented capture; Silver
via verified prelabels; val fills deterministically as sessions arrive.
