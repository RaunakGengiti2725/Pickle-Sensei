# PICKLE SENSEI — HANDOFF V3 (STATE OF THE WORLD)

> **Start a fresh session with: "Read `docs/HANDOFF_V3.md` and continue from there."**
> Supersedes `docs/HANDOFF_V2.md` (kept for history). Last updated: 2026-08-28, end of the
> FULL-CONVERGENCE parallel run (24 agent workstreams, integration wave, held-out one-shot).
> Everything below is MEASURED, not aspirational.
> Companions: `docs/STATUS_BOARD.md` (this run's live board) · `docs/DATA_ENGINE.md` ·
> `docs/CLAIM_REVIEW.md` (best-in-class gate: **FAIL**) · `docs/COACHING.md` (new) ·
> `docs/DECISIONS.md` (D-001…**D-043**) · `datasets/experiments/wave-a|wave-b/*-summary.json`
> (per-workstream evidence).

---

## 1. THE PRODUCT (unchanged mission)

iOS/Android pickleball technique analysis. Two modes on ONE engine:
- **STROKE ANALYSIS:** technique (tap/voice/**AUTO — now real**) → tap start spot → walk out →
  auto target lock → ONE stroke → auto event → analysis → honest Result → **TRY AGAIN loop (new)**.
- **SESSION ANALYSIS:** target lock → continuous play → E1, E2, E3… **real engine + UI shipped
  this run**; per-event native clip extraction + live motion stream are the named remaining gaps.
Atomic unit: **ONE TARGET ATHLETE + ONE StrokeEvent.** External language: **"Pickle Sensei is
still being validated."**

## 2. NORTH STARS — BOTH MOVED (n=5 gold, `pnpm lab:cascade`)

```
            TARGET  EVENT  PADDLE  BALL  CONTACT  PHASE  STROKE   STRICT   USABLE
run start:   5/5    3/5    5/5     4/5    1/5      2/5    2/5      1/5      1/5
run end:     5/5    3/5    5/5     5/5    2/5      4/5    3/5      2/5      2/5
```
(unconditional rows; conditional survival 2/5; usable-result-v1 contract in cascadeWaterfall.ts)

Survivors: wm-volley-02 (contact 30ms ball+paddle confirmed) + afn-sasebo-rally2 (contact 30ms
paddle-confirmed, OVERHEAD correct — was LOST AT BALL with a 274ms fabricated marker).
Named losses:
- `afn-sasebo-rally1` [dev]: EVENT honestly MULTI_STROKE_AMBIGUOUS (no contact anchor: gold
  2900 has zero tracked support in any modality — perception coverage problem, not fusion).
- `wm-dink-01` [held-out]: EVENT 42% overlap (event proposal untouched this run) + contact 250ms
  on the wrong-event window (v4 answers where v3 abstained — vetoed by usable contract).
- `afn-vic-rally1` [held-out]: contact 245ms (v4 answers where v3 abstained; ball+paddle evidence
  clusters 400-435 vs gold 680) + stroke still confidently wrong (BACKHAND vs FOREHAND_DRIVE).
**Held-out one-shot verdict, disclosed: dev contact gains did NOT transfer to held-out; both
held-out cases traded honest abstention for wrong estimates. Next contact iteration must be
driven by NEW dev labels (the 34-event corpus), never by held-out iteration.**

## 3. WHAT CHANGED THIS RUN (all measured; per-workstream JSON in datasets/experiments/)

**PERCEPTION**
- **contact-evidence-4** (D-033): target-gated temporal kernel-density fusion; distribution +
  modes shipped; 4 named abstentions. Dev 30/30ms + honest rally1 abstention.
- **ball-track-2** (D-034): body-occlusion state machine + honest reacquisition; BALL 5/5;
  body-overlap slice 0→0.17; predictions never observations.
- **paddle-track-2** (D-035): flip-SEGMENTATION replaces flip-truncation; S4 R .29→.43
  (dev .20→.53; rally1 13/20 = case ceiling); stale-score defect fixed; S4 Δrecall −.02.
- **stroke-heuristic-2** (D-036): plausibility-gated contact point; corroborated OVERHEAD;
  abstention band. Dev L1 2/2; zero confidently-wrong dev predictions.
- **phases v2.1** (D-038): anchor-free mode (anchorBasis event_peak, null contact) + NEW
  anchored ordering repair (accel ≤ contact, held-out-discovered). PHASE 2/5→4/5.
- **events**: labels 9→34 (21 target); stroke-event-2 invariance re-verified byte-identical
  under paddle changes AND merge; target recall 10/10; false proposals 0/9.

**PRODUCT**
- **AUTO DETECT real** (D-039): declared-null routing through analysis-pipeline + mobile chip →
  family/L3/abstain resolution; strokeIntent envelope everywhere; permits released on abstention.
- **Stroke Result surface** (W8, Mobbin-researched): honest header, replay card with
  usable-result-gated contact marker + confidence halo, anchor-free phase strip, ONE insight
  selector, provenance-chipped measured rows, reserved coach slot, TRY AGAIN handoff + attempt
  chips. 30 suites / 214 mobile tests green.
- **Session** (D-040): canonical engine (analysis-pipeline) replay-validated on both dev rallies;
  LiveCourtScreen renders real session model with honest per-event pending states. Native gaps:
  continuous motion stream + per-event clip extraction (contracts frozen in flow/session.ts).
- **Adaptive completion** (D-043): Swift live instrumentation shipped (default FIXED unchanged,
  telemetry always on); data gate MET at n=20 (FIXED 1371ms vs ADAPTIVE 668ms end error).
  Promotion = collect live captures → replay → flip CaptureCompletionStrategyStore.
- **Coach program**: admin-web review lab operational (queue, event-bounds video scrubber,
  v2 schema, 46-fault DRAFT taxonomy, drill schema, agreement analytics, append-only reviews).
  **Real coach reviews: 0. Coach recruitment = BLOCKED_EXTERNAL (human).** See docs/COACHING.md.
- Mobile tsc 5 errors→0; jest 107→214; AnalyzeScreen imported-video branch was unreachable (fixed).

**LATENCY (Mac; iPhone = BLOCKED_EXTERNAL, hardware absent)**
- Real profile (P): cold E2E was 55.07s (not ~23s): paddleDetect 43.7s dominated by per-detection
  MPS→CPU syncs (W2 corrected P's ffmpeg attribution) + per-invocation import/load.
- **W2 fix (bit-equal, default): E2E 55.07→17.25s.** `--serve` warm worker ~5.8s/req → ~11.9s E2E
  once runPaddleStage wires it (sketch in W2-worker-integration.md). Phone already reuses capture
  pose (sidecar → runCaptureAnalysis) — the 6.0s recompute is research-path only.
- Static stride-3+ROI **INVALIDATED downstream** (H: volley contact 43→87ms, rally2 paddle
  UNTRACKED). Next: adaptive two-pass (stride-3 scan + stride-1 densification at event peak).
- paddle∥ball concurrency verified possible (analyzeVideo.ts:841/:1052 sequential today).

**TARGET ACQUISITION**
- Verified TA 36→**59** (dev 54; contested slice 16→36). Shipped variant at n=54: correct .685,
  contested wrong .361. **Bench candidate acquire-v4** (tap-centered instant-lock gate +
  sustained-ambiguity): correct **.863**, contested wrong **.167**, false gestures 1. NOT
  promoted: needs live tap-distance instrumentation + one-shot locked_test (D-027 pattern).

**DATA / TRUTH**
- Ownership duals 14→30 (target boxes 78, other 83); wrong-player 4/41 — all one dink edge-on
  episode. **Edge-on/blur S0 blindness now has a MEASURED recovery strategy** (W12 probe,
  rally2-justified): wrist-conditioned multi-scale crops ({256,704} px × BOTH wrists, existing
  0.08 floor) recover the blind slices (overhead-blur 4/7→7/7 @IoU.10, edge-on carry 1/4→4/4
  @IoU.10); TTA rejected; temporal propagation = TRACKED_ESTIMATE bridge for ≤2-frame holes
  only. New hard-negative family found: target's shorts/leg+court-line (0.53 conf). Two W12
  forensic discoveries the next session must know: (a) canonical run `paddle-dets.json`
  timestamps are ONE FRAME (~33ms) early vs absolute CFR indexing (ffmpeg -ss seek off-by-one —
  fix extraction in Wave C; annotation tMs carry ±1-frame fog), (b) Apple Vision swaps L/R
  wrists on rear views (a right-hander's overhead lives on "left_wrist") — never trust
  handedness for wrist selection, always consider both.
- First blind multi-annotator overlap (W14): TA 83.3%/κ0.44 (definitional gaps — write the
  "bystander_target" rule), ownership 90.3%/κ0.78; 5 disagreements filed for adjudication.
- Merge re-verified NOT safe (D-042) — degrades contact via merged paddle-speed series.
- Competitor matrix (T, 44 sources): SwingVision = evidence leader (tennis); PB Vision owns
  pickleball session analytics (unvalidated); technique lane = unvalidated products only.
  **CLAIM GATE: FAIL (correctly).**

## 4. NON-NEGOTIABLE RULES (unchanged + additions)

All 15 rules from HANDOFF_V2 §2 stand. Additions:
16. **usable-result-v1 is versioned truth** — change the contract by re-versioning, never by
    softening in place (cascadeWaterfall.ts).
17. **Held-out contact/stroke misses (dink 250ms, vic 245ms/BACKHAND) are DATA problems.**
    Fix via new dev labels; tuning against held-out remains forbidden.
18. **Regen only via `pnpm lab:regen`** (datasets/paddle-bench/regen-manifest.json — derived,
    verified byte-identical). Never hand-invoke analyze against canonical run dirs.
19. Session engine events are append-only; closed events never mutate (D-040).

## 5. KEY COMMANDS (additions to HANDOFF_V2 §7)

```
pnpm lab:regen [--exec <caseId...|all>]     # reproducible canonical regeneration (NEW)
pnpm lab:cascade                            # now prints STRICT + USABLE side by side
npx tsx src/paddleSelectionForensics.ts     # S3→S4 loss explainer (swing-lab)
npx tsx src/contactForensics.ts             # contact signal replay harness (swing-lab)
tools/paddle-lab: detect_paddle.py [--serve|--legacy-decode] · compare_paddle_dets.py
apps/admin-web: npm run dev → /#/coach      # coach review lab (0 reviews by design)
cd apps/mobile && npx jest                  # 214 tests · npx tsc --noEmit clean
```

## 6. NEXT BOTTLENECKS (ranked, evidence-backed)

1. **EVENT disambiguation** — the only stage that didn't move (3/5). rally1 needs perception
   coverage through the strike (its gold contact has zero tracked support); dink needs event
   boundary work (42% overlap). New: 34 event labels to work against.
2. **Held-out-shaped contact/stroke slices** — grow dev contact labels from the new event corpus
   (rally2-style raw-ball-candidate tracking: A found strong candidates near gold rejected by
   ball gates); teach v4's priors per family from >3 anchors; vic's stale-paddle BACKHAND shape.
3. **Edge-on paddle** — productionize W12's measured winner: crop re-detect ({256,704}×both
   wrists) in the tracker's paddle-lost neighborhood, gated as `detection-source=crop`
   candidates (never raw into selection), suppressing the shorts/leg FP family first. Expected:
   event-window S0 5/11→8/11 @IoU.30 and un-starving rally2's S3=0 slice. Also fix the
   ±33ms detector timestamp off-by-one (W12 discovery) during the same pass.
4. **Latency**: wire `--serve` into runPaddleStage (17.25→~11.9s), paddle∥ball concurrency,
   adaptive two-pass detector schedule, then physical-device instrumentation (hardware).
5. **Session native gaps**: continuous motion stream + per-event clip extraction (contracts
   frozen; then per-event declared-null analysis is already routed).
6. **Promotions awaiting their gates**: acquire-v4 (live tap instrumentation + locked_test
   one-shot), adaptive completion (live replay captures), merge (segment-level ownership inside
   reconciliation).
7. **Coach recruitment** (BLOCKED_EXTERNAL) — infrastructure is ready the day a human coach exists.

## 7. OPERATING LOOP (unchanged, absolute)

MEASURE FAILURE → ROOT CAUSE → IMPLEMENT → TEST → MEASURE → PRESERVE → NEXT BOTTLENECK →
CONTINUE. Do not stop after one win. Do not claim what is unfinished. Do not touch shadow
(2 sessions / 40.1 min — verified untouched this run). Do not fake anything.
