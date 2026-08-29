# W13 — Data-Engine Refresh After Label Growth + Next Annotation Batch

Run: 2026-08-29 ~02:12Z. All four instruments exited 0 on the FIRST attempt despite parallel
working-tree churn — no retries needed. Numbers below are from those runs plus direct recounts
of the label files (every count re-derived this run; nothing copied from briefs unverified).

Instrument provenance:
- `pnpm lab:corpus-status` — exit 0, integrity OK
- `pnpm lab:data-gaps` — exit 0
- `pnpm lab:failure-mine` — exit 0 → `datasets/corpus/failure-queue.json` (generatedAtIso 2026-08-29T02:12:47.168Z, 101 findings), `datasets/corpus/annotation-queue.json` (02:12:47.172Z, 203 entries)
- `pnpm lab:learning-curve` — exit 0 → `datasets/corpus/learning-curves.json` (02:12:52.557Z)
- Shadow-split media/labels were never opened (aggregate registry/instrument counts only).

---

## 1. Corpus totals (lab:corpus-status, computed live)

| metric | value |
|---|---|
| sources | 20 (wikimedia_commons 4 · dvids 16); 20 training-eligible, 0 quarantined |
| recordings | 26 (17 roots + 9 derived) |
| root footage | 62.9 min |
| sessions | 12 |
| split ladder | dev 9 sessions · 21.7 min; locked_test 1 · 1.0 min; shadow 2 · 40.1 min |
| factory failed stages | none |
| integrity | OK (ids, hashes, lineage, licenses, files) |

## 2. Gold by task (before → after this run's growth; all recounted from files)

| task | before (HANDOFF/L-baseline) | now (measured this run) | provenance |
|---|---|---|---|
| TA verified cases | 36 | **59** (+12 rejected; 230 still proposed) | ta-bench/cases.json; wave-A K verified 23 of 29 reviewed |
| paddle target boxes | 54 | **78** (65 visible + 13 occluded/oob) | bundles/*/annotation/devin-visual-v1.json |
| other-paddle boxes | 41 | **83** (81 visible) | same |
| dual frames (same-ms target+other visible) | 14 | **30** (rally1 11, wm-dink 7, wm-volley 6, afn-vic 5, rally2 1) | same; matches L-summary |
| wrong-player check pairs (<20ms co-visible) | 19 | **41** | same; = lab:data-gaps "dual-paddle labeled frames 41" |
| ownership sidecar | 26 reject / 6 ambiguous | **80 reject / 14 ambiguous** (70 adjudicated frames total) | ownership-review/ownership-review.json + L-summary |
| ball frame labels | 22 | **22 (unchanged)** — wm-dink-01 still **0** | ballFrames in annotations |
| contact points | 5 target | **7** (5 target + 2 other-owner), uncertainty ±1–2 frames | eventLabels[].contactMs |
| stroke v3 labels | 5 | **5** | annotatedStrokeV3 |
| phase boundaries | 25 | **25** (5 × 5 cases) | phases |
| gold event labels | 9 | **9** across 5 bundles — workstream Q (event-label growth) had NOT landed at run time | eventLabels |

**SILVER: 0** — confirmed (v0.3 manifest tiers.SILVER.count=0: "no teacher output has passed
verification yet — nothing is silver-washed"). Still honest.

**Tier-C (mined candidates, NOT labels):** 199 stroke-event candidates, all dev; 196 multi-person;
62 with uncertainty ≥0.8. Releases sealed: v0.1/v0.2/v0.3.

## 3. Multi-annotator status

Still effectively **single-annotator**: every gold label on file is by the same human
(annotator ids `devin-visual-v1` and `devin-visual-v2-wave-a` are two passes by the same person).
Coach reviews: 0 (queue has 5 items, 0 provisioned coaches — J-summary).
**W14 (independent second-annotator overlap) is IN FLIGHT**: `wave-b/W14-overlap/worklist.json`
(created 2026-08-29T02:00Z) defines a blind 12-TA-case + 12-ownership-frame overlap with a written
blindness protocol — **no verdicts on file yet at W13 run time**, so agreement remains unmeasurable
today. W14 does NOT cover contact points (see queue item 4).

## 4. Learning curves — are metrics stabilizing? (lab:learning-curve, exit 0)

Documented baseline: paddle/ball recall leave-one-out (LOO) swings **0.38 / 0.63 at n=3 dev cases**
(docs/HANDOFF_V2.md, docs/DATA_ENGINE.md).

| task | current n (dev cases) | full-n recall / precision | LOO recall interval (n−1 resampled) | swing vs baseline | instrument verdict |
|---|---|---|---|---|---|
| paddle-detection | 3 (wm-volley-02, sasebo-rally1, sasebo-rally2; held-out wm-dink-01 + afn-vic-rally1 excluded) | 0.425 / 0.630 | [0.400, 0.435] → **spread 0.035** | 0.38 → 0.035 | "flattening at n=3 (Δrecall 0.004) — inspect slices before adding bulk data" |
| ball-detection | 3 (same cases) | 0.417 / 0.833 | [0, 0.625] → **spread 0.63** | 0.63 → 0.63 (unchanged) | "UNSTABLE at n=3 — more labeled cases needed before any reliability claim" |

Source result files (both post-label-growth): `paddle-bench-1787968828222.json`,
`ball-bench-1787966975192.json`.

**Honest reading — NO reliability claims are permitted for either task:**
- **Paddle:** the LOO swing collapsed 0.38→0.035 because denser labels made the three cases'
  recalls homogeneous (0.412 / 0.450 / 0.333), **not because n grew** — n is still 3. This is
  evidence the ~0.42 recall estimate is no longer an artifact of which case you drop; it is NOT
  evidence about the population. Any claim stronger than "≈0.42 on these 3 dev cases" remains
  forbidden. The next unit of information is a **4th labeled dev case**, not more frames in these 3.
- **Ball:** unchanged and honestly UNSTABLE (spread 0.63). Per-case recall is bimodal — wm-volley
  0.833 vs rally1 0/4 and rally2 0/2 — and wm-dink contributes nothing (0 labels). No claim possible.
- **TA / events / contact / stroke / phase:** NOT covered by the curve harness at all. TA n=59
  verified (contested slice n=36, measured wrong-lock 36.1% — K-summary); events n=9, contacts n=7,
  strokes n=5, phases n=25. The cascade artifact itself prints "n=5 gold events — rates are not
  stable estimates". No stability statement of any kind is made for these tasks.

## 5. Failure mining (lab:failure-mine, exit 0)

101 findings across 13 dev/val roots: CROWDED_SCENE 55 · TRACK_FRAGMENTATION 37 · NO_PEOPLE 4 ·
SCENE_CHURN 2 · STATIC_HUMAN_GRAPHIC 2 · SPARSE_WRIST_SUSPECT 1.
Unified queue: **203 entries** (60 failure + 143 candidate events with uncertainty ≥0.7).
Note: the tool has no CLI ranking options (source read: `engine/failureMine.ts`) — it always emits
severity-ranked failures merged with uncertainty-ranked Tier-C candidates.

### Queue depth (all queues, this run)
- corpus annotation-queue: **203** entries
- TA verification backlog: **230** proposed cases
- ownership frame queue: **30** pending (23 on dev-labelable cases + 7 afn-vic locked_test, deferred by policy)
- coach review queue: 5 items, **0** reviews (BLOCKED_EXTERNAL on recruitment)

## 6. Top-20 next-label queue (ranked by information value, cross-referenced vs wave A/B)

Cross-reference sources: wave-a B/K/L/I/U/G summaries + wave-b W3-variant-table, W5-runs, W14-overlap.
Already-solved questions excluded: L's 43 adjudicated ownership frames; K's 29 reviewed TA proposals;
wm-dink 1680–2160 wrong-player episode (needs L's ownership-prior CODE fix, not labels); rally1 S4
collapse root cause (B: flip-truncation diagnosed — needs flip-segmentation code, labels only for validation).

**CONTACT DISAGREEMENT**
1. `afn-sasebo-rally2` 2380–3050 — contact est 2346 vs gold 2620 = **274ms error, the set's only
   usable-result-v1 "fabricated marker"** (U-summary); gold itself is interpolated ±2 frames from
   ball-transit stills. Re-verify contact + densify ball labels 2500–2682. (W5 baseline/candidate
   runs may re-measure the estimator; the gold-side densification is needed regardless.)
2. `afn-sasebo-rally1` 2700–3100 — v3 contact ABSTAINED; working-tree estimator drifts
   abstained→925ms (I-summary). Frame-exact contact + short dense ball segment.
3. `wm-dink-01` 1050–1650 — contact ABSTAINED **and the case has ZERO ball labels** (ball-bench
   0/0/0/0). First ball labels + contact ±1 frame. (Held-out case: improves held-out honesty, does
   not grow dev-curve n.)
4. Second-annotator pass on the 7 existing contact points (incl. other-owner 3870/4360, both ±2fr)
   — W14's overlap covers TA + ownership only; extend its blindness protocol to contact.

**EVENT AMBIGUITY** (verify stroke-or-not + bounds; feeds G's ≥20-gold-events promotion gate and
is the pipeline to the 4th/5th dev bench case the learning curves need)
5. `evt-96ae65019c30-s3w0-p2-43327` (unc 1.00, marne, 3 people)
6. `evt-96ae65019c30-s3w0-p2-46029` (unc 1.00, marne)
7. `evt-faead33a362c-s0w1-p3-10292` (unc 0.95, marne, 5 people)
8. `evt-faead33a362c-s0w1-p3-11292` (unc 0.95)
9. `evt-faead33a362c-s0w1-p3-12583` (unc 0.95)
10. `evt-44c0c451500c-s0w1-p4-15090` (unc 0.90, warriorgames, 9 people — doubles as ownership stress)
    CAUTION (from K): dvids-943757 / dvids-1007845 are multi-sport reels (4 non-pickleball rejects
    measured) — run candidates from `rec-afd0b6bad5d0` / `rec-d230484fbaa5` through the
    gameplay-validity screen BEFORE spending label budget there.

**S3/S4 DISAGREEMENT (ownership)**
11. `afn-sasebo-rally2` pending ownership frames ×10 (tMs 502→4339) — **the S3=0 case**: target
    paddle boxed exactly once (2204, per L). Any confirmed target boxes directly unblock S3
    measurement on this case.
12. `afn-sasebo-rally1` pending ×8 — duals near the flip boundaries are the validation set for
    B's flip-segmentation redesign (S4 truncation deleted the correctly-picked track, 9/13→0/13).
13. `wm-dink-01` pending ×3 + `wm-volley-02` pending ×2 — clears the dev-labelable proposal queue.
14. Propose + adjudicate NEW ownership frames on corpus dev roots beyond the 5 bench clips —
    start `rec-44c0c451500c` / `rec-960a1a200d6d` crowded scenes (9–11 people; 55 CROWDED_SCENE
    findings). (afn-vic-rally1's 7 pending frames stay DEFERRED — locked_test policy, L precedent.)

**BALL DISAPPEARANCE**
15. Dense occlusion sequences: have 1, need 10+ (data-gaps). Start rally2 body-occlusion span —
    I's state machine measured recall 0.17 on that slice; denser labels make that number real —
    then light-clothing crossings.
16. `wm-volley-02` 6700–7100 post-contact exit — 2× BALL_REACQUISITION_FAILURE in failure-review;
    label the outgoing ball to measure reacquisition.
17. `evt-b6f280b2900c-s0w0-p4-2920` (wm-tournament root, 15 people) — the ONLY dev candidate-event
    window with ZERO ball-trajectory coverage (±300ms, measured this run across all 199 windows).
    Label ball presence/absence to decide if it's a real rally or crowd noise.

**TARGET SWITCHES (TA)**
18. `ta-960a1a200d6d-s8w0-p1` — worst verified switch case: 14 post-lock switches, onTarget 0.198,
    longestOff 8466ms. Adjudicate per-frame truth: identity swap vs truth-track gap.
19. `ta-916657917f2b-s0w0-p2` (longestOff 10211ms, onTarget 0.089) + `ta-5bf0e6a85afb-s1w2-p12`
    (onTarget 0.04, longestOff 5105ms) — follow-truth densification on the two other extremes.
20. Next TA verification batch: +20 from the 230 proposed, biased to contested_region windows on
    `rec-6e06a3157947` / `rec-960a1a200d6d` (switch-heavy scenes) to push contested n 36→50+.
    Feeds W3's variant table (dominance-gate / acquire-v3/v4 currently measured on n=59) without
    re-asking K's 29 or W14's 12 overlap cases.

## 7. Verdicts

- Data growth landed exactly where wave A claimed (78/83/30/41 ownership numbers reproduce
  L-summary; 59 verified TA reproduces K-summary). No count drift found.
- Paddle recall is now leave-one-out-tight at n=3 but n=3 is still n=3: **no reliability claim**.
- Ball recall remains quantifiably UNSTABLE (LOO spread 0.63, unchanged) — the single highest-value
  labeling act for curve stability is a NEW labeled dev case (items 5–10 are the pipeline) plus
  occlusion sequences (item 15).
- Silver 0, coach labels 0, agreement unmeasurable until W14 verdicts land — all honest gaps, all
  still open.
