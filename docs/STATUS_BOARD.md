# FULL-CONVERGENCE RUN — FINAL STATUS BOARD (2026-08-28)

Run complete. 24 agent workstreams (15 Wave A + 9 Wave B) + commander integration + held-out
one-shot. Per-workstream evidence: `datasets/experiments/wave-a|wave-b/*-summary.json`.
State of the world: `docs/HANDOFF_V3.md`. Decisions: D-033…D-043.

## NORTH STARS (n=5 gold, measured)

```
            TARGET  EVENT  PADDLE  BALL  CONTACT  PHASE  STROKE   STRICT   USABLE
run start:   5/5    3/5    5/5     4/5    1/5      2/5    2/5      1/5      1/5
run end:     5/5    3/5    5/5     5/5    2/5      4/5    3/5      2/5      2/5
```

## FINAL WORKSTREAM BOARD

| ID | Workstream | Result | State |
|----|-----------|--------|-------|
| A  | contact-evidence-4 (target-gated KDE fusion) | dev 30/30ms + honest abstain; held-out did NOT transfer (250/245ms where v3 abstained — disclosed) | GREEN dev / ORANGE held-out |
| B  | S4 forensics | root cause PROVEN (flip-truncation of the already-won track) | GREEN |
| W1 | paddle-track-2 flip-segmentation | S4 R .29→.43 (dev .20→.53); Δ −.22→−.02; rally1 13/20 = ceiling | GREEN |
| I  | ball-track-2 occlusion machine | BALL 5/5; body-overlap slice 0→.17; volley byte-identical | GREEN |
| W9 | stroke-heuristic-2 honesty | rally2 OVERHEAD correct; dev L1 2/2; vic held-out still wrong (disclosed) | GREEN dev / ORANGE held-out |
| W5 | phases v2.1 anchor-free + ordering repair | PHASE 2/5→4/5; accel≤contact invariant closed (held-out-found) | GREEN |
| U  | usable-result-v1 second north-star | live in lab:cascade; exposed fabricated markers + confident-wrong strokes | GREEN |
| D+W4 | AUTO DETECT end-to-end | real chip → declared-null → family/L3/abstain → honest Result; permits safe | GREEN |
| E+W6 | Session engine + mobile wiring | replay-validated (Δ=0ms); honest per-event states; 2 native gaps named | GREEN (engine/UI) · RED (native stream+clips) |
| G  | Adaptive completion live instrumentation | shipped flagged, default FIXED; telemetry always-on | GREEN (instrument) |
| Q  | Event labels 9→34 | D-029 data gate MET (FIXED 1371 vs ADAPTIVE 668ms, n=20) | GREEN |
| C  | Mobile TS errors | 5→0; unreachable imported-video branch fixed | GREEN |
| W8 | Stroke Result + Try Again (Mobbin) | canonical surface, evidence-gated marker/phases, handoff loop; 214 tests | GREEN |
| J  | Coach review lab | operational; 46-fault draft taxonomy; drills schema; 0 reviews (by design) | GREEN infra · BLOCKED_EXTERNAL (recruitment) |
| K  | TA gold 36→59 | contested slice 16→36; anatomy of 17 wrong locks | GREEN |
| W3 | acquire-v4 bench candidate | correct .685→.863; contested wrong .361→.167 (dev n=54) | GREEN bench · awaiting D-027 gate |
| L  | Ownership duals 14→30 | S3 problem replicates at 1.6× labels (real, not small-n) | GREEN |
| W14| Blind multi-annotator overlap | TA 83.3%/κ.44 · ownership 90.3%/κ.78; 5 adjudications filed | GREEN (first ever) |
| P  | Latency forensics | real profile: 55.07s cold; attribution map; prewarm plan | GREEN |
| W2 | Detector drain fix + serve worker | bit-equal; E2E 55.07→17.25s measured; ~11.9s projected w/ worker wiring | GREEN |
| H  | stride-3+ROI full-pipeline validation | INVALIDATED downstream (honest negative); adaptive two-pass designed | GREEN (verdict) |
| W12| Edge-on paddle probe | wrist-conditioned multi-scale crops recover the blind slice; FP family named | GREEN (strategy) |
| W13| Data engine refresh | corpus/learning-curve/failure-mine snapshot + top-20 label queue | GREEN |
| T  | Competitor matrix (44 sources) | claim gate stays FAIL, differentiators named | GREEN |
| —  | Merge reactivation | re-verified NOT SAFE (rally2 30→145ms; rally1 fabricated 695ms) | RED (correctly) |

## GATES AT RUN END

typecheck 17/17 · workspace tests all green (swing-lab 151, vision-geometry 47,
analysis-pipeline 29, admin-web 19, shared-types 13, model-registry 7, …) · mobile tsc 0 errors ·
mobile jest 214/214 · Swift extractor builds · pod sources typecheck (xcrun swiftc) ·
shadow untouched · locked_test regenerated exactly once (disclosed one-shot + one disclosed
invariant-repair regen of wm-dink-01 with unchanged verdict).

## EXTERNAL BLOCKERS (the only remaining non-engineering items)

1. Physical iPhone hardware (all latency numbers are Mac).
2. Qualified coach recruitment (0 real reviews; infrastructure complete).
3. New footage sources beyond exhausted DVIDS pickleball (first-party consent architecture
   remains future work).

---

# WAVE C ADDENDUM (2026-08-29, Linux integration)

18 parallel workstreams (C01–C18) ran on Linux boxes; 17 branches merged into one
integration branch (C03 ownership-label scaling still in flight — lands separately).
Per-workstream evidence: `datasets/experiments/wave-c/*-summary.json`.

MEASUREMENT BOUNDARY (unchanged): canonical run dirs are gitignored/absent on Linux and pose
extraction is Apple-Vision-only, so the n=5 strict-cascade north stars were NOT re-measured
here. No new cascade numbers are claimed; every entry below states only what was measured on
this fleet. The cascade table above remains the latest measured truth (Mac, 2026-08-28).

## WAVE C BOARD

| ID | Workstream | Evidence on Linux | State |
|----|-----------|-------------------|-------|
| C01 | detector timestamp alignment fix | root cause + alignment test suite (`tools/paddle-lab/test_timestamp_alignment.py`) | GREEN (fix) · cascade effect unmeasured (Mac) |
| C02 | edge-on crop recovery productionized | behind `--crop-recovery` (OFF); FP-family admission gates; 264-line test file | GREEN (flagged) · held-out effect unmeasured |
| C03 | ownership label scaling | still running | IN FLIGHT |
| C04 | ball gold 22→60 (+38 labels, occlusion states) | visually verified, append-only; `occlusionState` added to schema | GREEN (labels) |
| C05 | contact gold +13 independent contact observations | intra-annotator blind double pass; 1 prior contact disputed (disclosed, not deleted) | GREEN (labels) |
| C06 | event taxonomy: 5/5 W14 adjudications closed, guide v1, 34/34 QA (1 flag) | `ml/annotations/ta-ownership-annotation-guide-v1.md` | GREEN |
| C07 | warm worker wired into analyzeVideo (default ON, `--no-paddle-worker` opt-out) | bit-equal payloads re-verified on Linux CPU; fallback on any worker failure | GREEN (wiring) · E2E latency needs Mac re-measure |
| C08 | paddle∥ball prep concurrency + adaptive two-pass (OFF, `--two-pass`) | prep refactor byte-identical sequential artifacts; schedule tests | GREEN (flagged) |
| C09 | session-native motion stream + per-event clips | Swift sources + tests written; CANNOT compile/run here (no Swift/Apple SDK) | ORANGE — needs Mac build+test |
| C10 | first-party consent architecture (analyze vs train split) | consent types + media-worker trainingConsent + 103-line test | GREEN (architecture) |
| C11 | silent-failure-v1 metric + calibration/risk-curves tooling | in lab:cascade output; TA ECE .121 (n=12), ownership ECE .098 (n=31) via agreement proxy (stated) | GREEN (tooling) · 0/0 on this box (runs absent) |
| C12 | capture-envelope checker | measured over the 3 committed bundle clips only (premise said 13 — corrected, disclosed) | GREEN (module) |
| C13 | capture guidance + uncertainty UX | mobile screens + tests; Mobbin MCP unavailable (disclosed, no fabricated research) | GREEN (UI) |
| C14 | coach portal completion audit | 50/50 tests, typecheck clean | GREEN (infra) · BLOCKED_EXTERNAL (0 coach reviews) |
| C15 | OOD gates + property/fuzz tests + corpus invariant check | fuzz found 1 real bug (fixed); corpus check 299 files, 0 violations | GREEN |
| C16 | rights-cleared footage acquisition | 1 new CC-licensed candidate accepted; search log kept; DVIDS remains exhausted | ORANGE (supply still thin) |
| C17 | acquire-v4 tap instrumentation | capture.ts tap plumbing + tests; D-027 gate still not decidable here | GREEN (instrument) |
| C18 | stroke taxonomy bench + gold scaling | bench harness + tests; new stroke gold requires footage/Mac loop | GREEN (harness) · BLOCKED_EXTERNAL (labels) |

## GATES AT INTEGRATION (Linux)

typecheck 19/19 packages · workspace tests all green (swing-lab 231 passed | 4 skipped, all
other packages green) · lint: zero NEW issues (repo has 99 pre-existing errors on main,
unchanged) · mobile jest not runnable in this workspace filter setup (apps/mobile excluded
from pnpm workspace test run here) — re-verify with the mobile suite on Mac.

## EXTERNAL BLOCKERS (unchanged + one new)

1. Physical iPhone hardware (all latency numbers are Mac).
2. Qualified coach recruitment (0 real reviews; infrastructure complete).
3. Footage supply: one new CC candidate (C16), otherwise exhausted.
4. Mac re-measure required to claim any cascade movement from C01/C02/C07/C08/C09.
