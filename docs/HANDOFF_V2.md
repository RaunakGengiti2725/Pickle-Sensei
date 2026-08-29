# PICKLE SENSEI — HANDOFF V2 (STATE OF THE WORLD)

> **SUPERSEDED by `docs/HANDOFF_V3.md` (2026-08-28 full-convergence run). Kept for history.**
> **Start a fresh session with: "Read `docs/HANDOFF_V3.md` and continue from there."**
> Supersedes `docs/HANDOFF.md` (kept for history). Last updated: 2026-08-28, end of the
> master product-validation run. Everything below is MEASURED, not aspirational.
> Companions: `docs/DATA_ENGINE.md` (data factory) · `docs/CLAIM_REVIEW.md` (best-in-class
> gate: **FAIL**) · `docs/DECISIONS.md` (D-001…D-032) · `docs/PERCEPTION.md` (deep history).

---

## 1. THE PRODUCT

iOS/Android pickleball technique analysis (React Native + native Swift capture + TS analysis
packages + Python/Swift research tooling). Two modes on ONE intelligence engine:

- **STROKE ANALYSIS (flagship):** choose technique → tap start spot → walk out → auto target
  lock → ONE stroke → auto event → analysis → Result. Zero touches after walking out.
- **SESSION ANALYSIS:** target lock → play → E1, E2, E3… each analyzed independently, then
  aggregated. (Still routes to LiveCourt; multi-event engine NOT built.)

Atomic unit everywhere: **ONE TARGET ATHLETE + ONE StrokeEvent.** A session is never one motion.
Approved external language: **"Pickle Sensei is still being validated."** (claim gate FAILED).

---

## 2. NON-NEGOTIABLE RULES (each one exists because a violation burned us)

1. **TECHNIQUE SCORING = BLOCKED_ON_VALIDATION.** Qualified coach labels = **0**. Never fabricate
   scores/faults/drills; the Result stays honest. Coach program infra exists (§7) — recruitment is human.
2. **No fake observations.** DETECTED / TRACKED_ESTIMATE / PREDICTED stay distinct everywhere.
3. **Held-out discipline.** Cases `wm-dink-01` + `afn-vic-rally1` (session `afn-vic-2025`,
   split locked_test) are never tuned against. NOTE: both were regenerated TWICE on 2026-08-28
   (event-v2, then contact-scope fix) — disclosed in EXP-2026-08-28-event-decoupling. Dev cases:
   `wm-volley-02`, `afn-sasebo-rally1`, `afn-sasebo-rally2`.
4. **Frozen baselines/releases are immutable** — new results are new artifacts.
5. **Provenance + per-modality rights for all media** (store/analyze/annotate/train/redistribute/
   commercial). Unknown license ⇒ quarantined. `lab:acquire` is the ONLY door into the corpus.
6. **declared / predicted / annotated stroke stay separate fields.** Declaration narrows, never forces.
7. **No training theater.** Every learned task is BLOCKED_ON_DATA; do not train on ~5 labels.
8. **Region/tap seeds are INITIALIZATION ONLY** — after lock, identity follows the physical person.
9. **Scene + gameplay validity are hard-gated.** No track/event/contact across a shot cut; static/
   graphic humans (title cards) produce no candidates (liveness-v1, D-028; exhibits preserved).
10. **Mac numbers are not iPhone numbers. PHYSICAL IPHONE LATENCY: NOT MEASURED.**
11. **SHADOW split is untouchable** (2 sessions, 40.1 min). Pins tighten, never loosen. val is
    EMPTY — it fills deterministically from new sessions; never hand-assign.
12. **Tier separation is semantic.** GOLD = human-verified; SILVER = 0 (nothing earned it);
    Tier-C = machine candidates, never reported as labels.
13. **EVENT PROPOSAL CONTRACT (D-030).** Target BODY motion proposes StrokeEvents; paddle/ball/
    contact only confirm/rank/refine. Paddle content must never create, delete, or re-bound a
    proposal (unit-tested; verified byte-identical under `--merge-tracklets`).
14. **Live-acquisition Swift changes are gated on the TA bench** (D-026/D-027 precedent:
    ≥30 verified cases, dev dominance + one-shot held-out confirmation).
15. **Impossible timelines never reach consumers** — phase ordering invariant (followEnd > contact
    or abstain with PHASE_NO_POST_CONTACT_EVIDENCE).

---

## 3. THE NORTH-STAR METRIC — FULL-CASCADE SURVIVAL (n=5 gold, `pnpm lab:cascade`)

```
TARGET 5/5 → EVENT 3/5 → PADDLE 3/5 → BALL 2/5 → CONTACT 1/5 → PHASE 1/5 → STROKE 1/5
```

**1/5 strokes survives end-to-end (wm-volley-02).** Per-case losses (all named):

- `wm-dink-01` [held-out]: EVENT 42% overlap (<50% gate) + CONTACT abstained — compact strokes
  peak wrist speed AFTER contact; disagreement gate fires (307ms spread).
- `afn-sasebo-rally1` [dev]: honestly MULTI_STROKE_AMBIGUOUS (correct window IS in top-2 at 80%
  overlap; no contact anchor — ball dies at body overlap, paddle weak post-contact).
- `afn-sasebo-rally2` [dev]: BALL untracked (body-overlap slice) + contact 274ms (estimator
  prefers an early paddle whip — pre-existing fusion trait).
- `afn-vic-rally1` [held-out]: EVENT 88% overlap ✓ but CONTACT abstained (380ms spread).
  **CONTACT FUSION is the binding constraint** — was event identity before D-030.

---

## 4. MEASURED SUBSYSTEM STATE

**Target acquisition (PROMOTED D-027, in shipped Swift):** verified n=36 (31 dev + 5 locked_test;
253 machine proposals remain unreviewed). Dev: lock .806→**1.0**, correct locks 16→**22**/31,
false gesture locks 2→**0**, post-lock on-target .543→**.612** (+111ms median lock). One-shot
held-out: locks 4/5→**5/5**, correct 5/5, on-target .553→**.639**. Swift: 5-frame sustained
gesture, 3s ambiguity timeout → closest occupant, incumbent hysteresis follower (challenger needs
1.43×). Legacy behavior preserved as replay variant + regression tests. Residual: crowd-region
locks pick bystanders ~29% (partly case-construction artifact).

**Events (stroke-event-2, D-030):** target recall 4/5→**5/5**, false proposals 8/14→**3/9**,
start/end median 350/260ms, contact-inside 4/6. Wrist-fragment glue ≤350ms + boundary relaxation
≥max(12% peak, 0.08); paddle confirmation refines peak ≤250ms + breaks prominence ties; contact
scan scope = peak ±450ms (decoupled from event bounds). Paddle fallback only when body absent, flagged.

**Merge (still NOT promoted):** events now stable under merge (volley identical, contact 43→49ms).
Remaining block is precise: merged OTHER-player fragments + opponent-side ball direction change
fabricate a "ball+paddle confirmed" contact in the wrong window (rally1 @546ms vs gold 2900).
Needs target-conditioned reconciliation + **target-gated contact evidence**. Oracle merge ceiling R .98.

**Paddle waterfall (41-label instrument):** S0 P.76/**R1.00** → S1 .74/.98 → S3 ownership
.63/**.49** (−.49) → S4 selection R.27 (**−.22**; rally1: S3 keeps 9/13 → S4 0/13 — unexplained,
forensics instrument not yet built) → S5 P.42/R.32. Oracle: selection .51, merge .98.
**Ownership gold: 20 dual-paddle frames** (was 2) + 15 hard negatives (banner flag ×3, adidas
stripes ×2, wall box ×2, net tape, ground paddle ×2, ball-as-paddle, dup sub-boxes) + 7 ambiguous
(sidecar `ownership-review.json`). **Wrong-player: 1/19 (5.3%).** 12 rendered queue frames unreviewed.

**Ball:** volley P.83/R.83; BALL_BODY_OVERLAP slice = 0 recall (rally1/rally2 exhibits).
**Contact:** volley 43ms ball+paddle-confirmed; rally2 274ms; 3/5 abstain. Multimodal fusion with
per-signal reliability priors + target gating = QUALITY #1.
**Phases:** v2 anchor-or-abstain + ordering invariant (repairs to first post-contact observation,
else abstains). Dev: accel 170 / contact 66 / followEnd 266ms.
**Stroke:** hierarchical L1/L2 honest; predicted vs declared disagreements shown (e.g. "predicted
BACKHAND · declared dink"); L3 abstains without bounce data (0 bounce labels).

**Adaptive completion (D-029, NOT shipped):** vs FIXED 1.5s on 5 gold events — |end error|
1080→**510ms**, recovery excess 1051→**251ms**, zero losses, clips slightly shorter; 2/5
continuous-rally cases hit the 2.5s safety max. Settle-only LOSES; settle-or-next-stroke-valley
works (the valley = Session segmentation primitive). Gate: instrument the LIVE trigger, ≥20 gold events.

**Latency:** research path ~23s (pose ~6.9s, event-gated D-FINE ~14.6s). **ROI×keyframe grid
(D-032):** stride = latency lever, target-ROI = quality lever (ms/frame ~constant ≈90-120).
Shortlist **stride 3 + target ROI**: rally1 12.2→4.0s, volley 6.1→2.2s (−65%) at equal-or-better
S0 recall (rally1 .846, volley .25→.50). NOT promoted — full pipeline validation pending.
Capture-time pose reuse: not measured. Prewarm: not built. iPhone: NOT MEASURED.

**Learning curves:** paddle/ball recall leave-one-out swings 0.38/0.63 at n=3 dev cases — NO
reliability claims permitted at current n (`pnpm lab:learning-curve`).

---

## 5. MOBILE APP (verified: 107 jest tests pass; Swift builds; GuidedCapture parses)

Flow: Home → Stroke Analysis → **"WHAT ARE YOU WORKING ON?"** = `TechniqueIntentPicker`
(D-031, Mobbin-researched: Oura dictation-field + Life Reset chip grid): type/dictate → deterministic
resolver (technique-intent-v1 in shared-types; ambiguity narrows chips, garbage can't invent routes)
or tap canonical chip; **AUTO DETECT visible but honestly gated** (copy explains classifier
dependency; declared-null routing through `runCaptureAnalysis` is the follow-up — it currently
requires a ShotTypeSlug). → tap start spot → walk out → D-027 acquisition → PLAYER LOCKED →
swing → fixed 1.5s finalize → auto-analysis → Result (honest fields only).
KNOWN pre-existing mobile TS errors (NOT from these runs; jest still green): `TargetSelector.tsx`
×2 + `HomeScreen.tsx` ×1 (`color.inkMuted` missing), `AnalyzeScreen.tsx` ×2 (captureMode
comparison ~line 522). Imported-video path: tap-the-person selector unchanged.

---

## 6. DATA STATE (`datasets/corpus/` is canonical; see docs/DATA_ENGINE.md)

- **20 sources** (16 DVIDS PD · 4 Commons) · 26 recordings · **62.9 min** root footage · 12
  sessions · all training-eligible with per-modality rights. DVIDS "pickleball" exhausted (16/16).
- **Splits:** dev 9 sessions/21.7min · val **0** (fills deterministically) · locked_test
  afn-vic-2025 · **shadow 2 sessions/40.1min UNTOUCHED**. Lineage-aware; dedup auto-merged 3
  DVIDS↔Commons re-uploads; same-event grouping via `session-groups.json`.
- **GOLD:** paddle 54 target + 33 other (**20 dual**) · ball 22 · contact 5 · stroke 5 · phase 25 ·
  events 9 · **TA 36** — ALL single-annotator (top credibility gap). **SILVER: 0. Tier-C: 199**
  events (miner v4 + liveness gate) + 253 TA proposals. **Coach labels: 0.**
- **Queues:** `datasets/corpus/annotation-queue.json` (203 ranked) · ownership review 12 unreviewed
  rendered frames (`datasets/paddle-bench/ownership-review/`) · TA `datasets/ta-bench/cases.json` ·
  coach `datasets/coach-review/queue.json` (5 gold events, ≥2 coaches each, **0 reviews**).
- **Releases:** v0.1/v0.2/v0.3 sealed; v0.3+ snapshot annotation bytes into the release dir
  (governance fix — live-path hashes broke under legitimate label growth; lineage test covers legacy).
- **Experiments (2026-08-28):** paddle-waterfall · tracklet-merge · rfdetr-teacher · user-target-seed ·
  target-acquisition-bench · ta-candidate-variants · **ta-promotion** · ownership-gold-expansion ·
  adaptive-completion · cascade-waterfall · **event-decoupling** · **roi-keyframe-grid**.

---

## 7. KEY COMMANDS

```
# INSTRUMENTS (run these to see reality)
pnpm lab:cascade                # THE north-star: end-to-end survival waterfall
pnpm lab:paddle-waterfall       # S0→S5 with oracle ceilings
pnpm lab:stroke-bench           # events + stroke + phase 4-way
pnpm lab:ta-bench run [--variant shipped|legacy|...] [--split locked_test] [--all]
pnpm lab:completion-bench       # FIXED vs ADAPTIVE completion
pnpm lab:learning-curve         # metric-vs-n instability proof
pnpm lab:paddle-bench / lab:ball-bench

# DATA FACTORY
pnpm lab:acquire <dvids|commons> [--query q] [--dry-run]   # ONLY door into the corpus
pnpm lab:factory [--stage all|extract|fingerprint|dedup|mine] [--jobs N]
pnpm lab:corpus-status · lab:corpus-sessions · lab:failure-mine · lab:data-gaps
pnpm lab:own propose|apply <verdicts.json>                 # prelabel-assisted ownership gold
pnpm lab:ta-bench propose|render [caseId]                  # TA case factory
pnpm lab:coach-queue                                       # expert-review bundles (0 reviews)
pnpm lab:dataset-release <version>                         # immutable, snapshots annotations

# ANALYSIS + VERIFY
pnpm lab:analyze <video> --stroke X [--target-tap x,y] [--merge-tracklets] [--reuse-extract] [--out dir]
pnpm typecheck && pnpm lint && pnpm test                   # workspace (82 swing-lab tests)
cd apps/mobile && npx jest                                 # 107 tests
cd native/swing-lab && swift build -c release              # extractor
tools/paddle-lab/.venv                                     # D-FINE; roi_keyframe_grid.py; detect_paddle.py --roi --stride
```

Key files: `packages/swing-lab/src/strokeEvents.ts` (stroke-event-2) · `analyzeVideo.ts` ·
`phaseTemporal.ts` · `cascadeWaterfall.ts` · `ownershipAnnotate.ts` · `coachReview.ts` ·
`engine/{corpus,acquire,factory,minerCore,fingerprint,splits,rights,taReplay,gameplayValidity,failureMine}.ts` ·
`packages/shared-types/src/techniqueIntent.ts` · `apps/mobile/src/flow/TechniqueIntentPicker.tsx` ·
`apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift` ·
`native/vision-core/Sources/ApplePoseProvider.swift`.

---

## 8. NEXT BOTTLENECKS (ranked, evidence-backed — START HERE)

**QUALITY #1 — CONTACT MULTIMODAL FUSION with target-gated evidence.** The cascade's binding
constraint (1/5 unconditional pass; 3/5 abstain; compact strokes peak wrist AFTER contact and the
flat disagreement gate fires at 307/380ms spreads). Replace with per-signal reliability priors
(ball direction change > paddle whip > wrist peak, technique-conditioned lag priors) AND require
ball/paddle proximity to the TARGET's paddle/wrist. Target-gating is simultaneously the
fragment-merge unblock (D-030's fabricated-contact exhibit). Then re-run cascade + benches;
held-out once. This one fix plausibly moves cascade 1/5 → 3/5.

**LATENCY #1 — promote stride-3 + target-ROI through the FULL pipeline** (benches + cascade,
dev-tuned, held-out once). −65% of the 14.6s detector span if downstream holds. Then capture-time
pose sidecar consumption (~6.9s), then D-029 live-trigger instrumentation.

**DATA #1 — queue → GOLD.** TA 36→50-100 (253 proposals + render tooling ready) · dual-paddle
20→30+ (12 frames already rendered) · SECOND ANNOTATOR ≥3 cases (top credibility gap) · bounce
labels 0 (blocks L3) · ball-body-overlap dense sequences (contact slice gold).

**QUALITY #2 — S4 selection forensics.** Build the per-gold-paddle S3→S4 loss explainer
(rally1 9/13→0/13 is unexplained). Then fix selection with evidence, not weight-tweaks.

**PRODUCT #2 —** AUTO declared-null routing through `runCaptureAnalysis`/fusion providers ·
Session multi-event engine (reuse stroke-event-2 + the D-029 valley as segmentation primitive;
event complete → store → KEEP RUNNING) · Result replay polish (trustworthy pieces only).

**SCALE #3 —** broader PD acquisition (NARA/state archives; DVIDS other queries) · first-party
consented capture program (ANALYZE consent ≠ TRAIN consent, separate flags) · coach recruitment
through the queue · Silver via verified prelabels over the 199 Tier-C events.

## 9. OPERATING LOOP (unchanged, absolute)

MEASURE FAILURE → ROOT CAUSE → IMPLEMENT → TEST → MEASURE → PRESERVE (EXP-*.json + DECISIONS.md +
this file) → NEXT BOTTLENECK → CONTINUE. Do not stop after one win. Do not claim what is
unfinished. Do not touch shadow. Do not fake anything.
