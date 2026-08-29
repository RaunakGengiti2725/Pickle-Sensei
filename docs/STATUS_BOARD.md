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

| ID   | Workstream                                   | Result                                                                                             | State                                         |
| ---- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| A    | contact-evidence-4 (target-gated KDE fusion) | dev 30/30ms + honest abstain; held-out did NOT transfer (250/245ms where v3 abstained — disclosed) | GREEN dev / ORANGE held-out                   |
| B    | S4 forensics                                 | root cause PROVEN (flip-truncation of the already-won track)                                       | GREEN                                         |
| W1   | paddle-track-2 flip-segmentation             | S4 R .29→.43 (dev .20→.53); Δ −.22→−.02; rally1 13/20 = ceiling                                    | GREEN                                         |
| I    | ball-track-2 occlusion machine               | BALL 5/5; body-overlap slice 0→.17; volley byte-identical                                          | GREEN                                         |
| W9   | stroke-heuristic-2 honesty                   | rally2 OVERHEAD correct; dev L1 2/2; vic held-out still wrong (disclosed)                          | GREEN dev / ORANGE held-out                   |
| W5   | phases v2.1 anchor-free + ordering repair    | PHASE 2/5→4/5; accel≤contact invariant closed (held-out-found)                                     | GREEN                                         |
| U    | usable-result-v1 second north-star           | live in lab:cascade; exposed fabricated markers + confident-wrong strokes                          | GREEN                                         |
| D+W4 | AUTO DETECT end-to-end                       | real chip → declared-null → family/L3/abstain → honest Result; permits safe                        | GREEN                                         |
| E+W6 | Session engine + mobile wiring               | replay-validated (Δ=0ms); honest per-event states; 2 native gaps named                             | GREEN (engine/UI) · RED (native stream+clips) |
| G    | Adaptive completion live instrumentation     | shipped flagged, default FIXED; telemetry always-on                                                | GREEN (instrument)                            |
| Q    | Event labels 9→34                            | D-029 data gate MET (FIXED 1371 vs ADAPTIVE 668ms, n=20)                                           | GREEN                                         |
| C    | Mobile TS errors                             | 5→0; unreachable imported-video branch fixed                                                       | GREEN                                         |
| W8   | Stroke Result + Try Again (Mobbin)           | canonical surface, evidence-gated marker/phases, handoff loop; 214 tests                           | GREEN                                         |
| J    | Coach review lab                             | operational; 46-fault draft taxonomy; drills schema; 0 reviews (by design)                         | GREEN infra · BLOCKED_EXTERNAL (recruitment)  |
| K    | TA gold 36→59                                | contested slice 16→36; anatomy of 17 wrong locks                                                   | GREEN                                         |
| W3   | acquire-v4 bench candidate                   | correct .685→.863; contested wrong .361→.167 (dev n=54)                                            | GREEN bench · awaiting D-027 gate             |
| L    | Ownership duals 14→30                        | S3 problem replicates at 1.6× labels (real, not small-n)                                           | GREEN                                         |
| W14  | Blind multi-annotator overlap                | TA 83.3%/κ.44 · ownership 90.3%/κ.78; 5 adjudications filed                                        | GREEN (first ever)                            |
| P    | Latency forensics                            | real profile: 55.07s cold; attribution map; prewarm plan                                           | GREEN                                         |
| W2   | Detector drain fix + serve worker            | bit-equal; E2E 55.07→17.25s measured; ~11.9s projected w/ worker wiring                            | GREEN                                         |
| H    | stride-3+ROI full-pipeline validation        | INVALIDATED downstream (honest negative); adaptive two-pass designed                               | GREEN (verdict)                               |
| W12  | Edge-on paddle probe                         | wrist-conditioned multi-scale crops recover the blind slice; FP family named                       | GREEN (strategy)                              |
| W13  | Data engine refresh                          | corpus/learning-curve/failure-mine snapshot + top-20 label queue                                   | GREEN                                         |
| T    | Competitor matrix (44 sources)               | claim gate stays FAIL, differentiators named                                                       | GREEN                                         |
| —    | Merge reactivation                           | re-verified NOT SAFE (rally2 30→145ms; rally1 fabricated 695ms)                                    | RED (correctly)                               |

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

18 parallel workstreams (C01–C18) ran on Linux boxes; 18/18 branches merged into one
integration branch.
Per-workstream evidence: `datasets/experiments/wave-c/*-summary.json`.

MEASUREMENT BOUNDARY (unchanged): canonical run dirs are gitignored/absent on Linux and pose
extraction is Apple-Vision-only, so the n=5 strict-cascade north stars were NOT re-measured
here. No new cascade numbers are claimed; every entry below states only what was measured on
this fleet. The cascade table above remains the latest measured truth (Mac, 2026-08-28).

## WAVE C BOARD

| ID  | Workstream                                                                     | Evidence on Linux                                                                                 | State                                              |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| C01 | detector timestamp alignment fix                                               | root cause + alignment test suite (`tools/paddle-lab/test_timestamp_alignment.py`)                | GREEN (fix) · cascade effect unmeasured (Mac)      |
| C02 | edge-on crop recovery productionized                                           | behind `--crop-recovery` (OFF); FP-family admission gates; 264-line test file                     | GREEN (flagged) · held-out effect unmeasured       |
| C03 | ownership label scaling                                                        | 30 multi-paddle ownership frames across 6 bundles (20 visible target / 59 other / 6 ambiguous / 4 occluded-target); dual frames 30→50; `wave-c/c03-summary.json` | GREEN (labels)                                     |
| C04 | ball gold 22→60 (+38 labels, occlusion states)                                 | visually verified, append-only; `occlusionState` added to schema                                  | GREEN (labels)                                     |
| C05 | contact gold +13 independent contact observations                              | intra-annotator blind double pass; 1 prior contact disputed (disclosed, not deleted)              | GREEN (labels)                                     |
| C06 | event taxonomy: 5/5 W14 adjudications closed, guide v1, 34/34 QA (1 flag)      | `ml/annotations/ta-ownership-annotation-guide-v1.md`                                              | GREEN                                              |
| C07 | warm worker wired into analyzeVideo (default ON, `--no-paddle-worker` opt-out) | bit-equal payloads re-verified on Linux CPU; fallback on any worker failure                       | GREEN (wiring) · E2E latency needs Mac re-measure  |
| C08 | paddle∥ball prep concurrency + adaptive two-pass (OFF, `--two-pass`)           | prep refactor byte-identical sequential artifacts; schedule tests                                 | GREEN (flagged)                                    |
| C09 | session-native motion stream + per-event clips                                 | Swift sources + tests written; CANNOT compile/run here (no Swift/Apple SDK)                       | ORANGE — needs Mac build+test                      |
| C10 | first-party consent architecture (analyze vs train split)                      | consent types + media-worker trainingConsent + 103-line test                                      | GREEN (architecture)                               |
| C11 | silent-failure-v1 metric + calibration/risk-curves tooling                     | in lab:cascade output; TA ECE .121 (n=12), ownership ECE .098 (n=31) via agreement proxy (stated) | GREEN (tooling) · 0/0 on this box (runs absent)    |
| C12 | capture-envelope checker                                                       | measured over the 3 committed bundle clips only (premise said 13 — corrected, disclosed)          | GREEN (module)                                     |
| C13 | capture guidance + uncertainty UX                                              | mobile screens + tests; Mobbin MCP unavailable (disclosed, no fabricated research)                | GREEN (UI)                                         |
| C14 | coach portal completion audit                                                  | 50/50 tests, typecheck clean                                                                      | GREEN (infra) · BLOCKED_EXTERNAL (0 coach reviews) |
| C15 | OOD gates + property/fuzz tests + corpus invariant check                       | fuzz found 1 real bug (fixed); corpus check 299 files, 0 violations                               | GREEN                                              |
| C16 | rights-cleared footage acquisition                                             | 6 accepted CC BY 3.0 clips (181.08 MB, 360 s) committed + 4 unknown-rights items quarantined; DVIDS remains exhausted | ORANGE (supply still thin)                         |
| C17 | acquire-v4 tap instrumentation                                                 | capture.ts tap plumbing + tests; D-027 gate still not decidable here                              | GREEN (instrument)                                 |
| C18 | stroke taxonomy bench + gold scaling                                           | bench harness + tests; new stroke gold requires footage/Mac loop                                  | GREEN (harness) · BLOCKED_EXTERNAL (labels)        |

## GATES AT INTEGRATION (Linux)

typecheck 19/19 packages · workspace tests all green (swing-lab 231 passed | 4 skipped, all
other packages green) · lint: zero NEW issues (repo has 99 pre-existing errors on main,
unchanged) · mobile jest not runnable in this workspace filter setup (apps/mobile excluded
from pnpm workspace test run here) — re-verify with the mobile suite on Mac.

## EXTERNAL BLOCKERS (unchanged + one new)

1. Physical iPhone hardware (all latency numbers are Mac).
2. Qualified coach recruitment (0 real reviews; infrastructure complete).
3. Footage supply: 6 CC clips accepted in C16 (+2 in Wave D2, +7 in Wave E e22), otherwise exhausted.
4. Mac re-measure required to claim any cascade movement from C01/C02/C07/C08/C09.

---

# WAVES D / D2 / D3 / D4 ADDENDUM (2026-08-29, Linux, 50 workstreams)

Four concurrent waves ran after Wave C integration. Per-workstream evidence:
`datasets/experiments/wave-d/*.json`, `wave-d2/*.json`, `wave-d3/*.json`, `wave-d4/*.json`.
MEASUREMENT BOUNDARY unchanged: no Mac/Apple Vision/iPhone; no cascade re-measure claimed.

Highlights (all artifact-backed, dated 2026-08-29):

- Wave D (14): D04 contact gold +15 eventLabel records; D08 real-OOD corpus grown and
  measured; D09 warm-worker hardening (crash/restart/fallback, LINUX-CPU only); D10
  single-command Mac bench harness prepared (BLOCKED_EXTERNAL to run); D13 stroke gold
  29 labels / 11 cases.
- Wave D2 (12): lawful acquisition from NARA/Commons/.mil-gov (2 voa clips accepted;
  unknown-rights quarantined); D2-04 blind ownership audit; D2-05 blind contact audit
  (6/7 re-derivable labels within 0.5 frame, median Δ 0.1 frame, 4 disputes preserved);
  D2-09 data-integrity audit.
- Wave D3 (12): red teams across target, ownership, phase, session, OOD gate, API errors;
  D3-05 phase red team measured anchor-free coverage; findings preserved as pinned tests.
- Wave D4 (12): S4 stress replay, modality learning curves, ROI bench, pose-derivative
  cache (D4-05, byte-equal), result/try-again state audit, HANDOFF_V4 draft + decision-log
  reconciliation (D4-12).

Event-label denominators at head (e25 recount): 62 annotation records (39 target; 59 with
contactMs; 57 excluding the 2 held-out cases' 5 pre-existing records); unique contact
events are a separate denominator (28 per c05 reconciliation + D04 additions). The bare
"34" from Wave B is retired. Ball gold: 103 frames (86 visible / 6 uncertain / 5 not
visible / 6 occluded), 78 with occlusionState. Ownership bases: annotation records
102 target / 142 other; visible points 85/140 (README basis); sidecar verdicts 100;
dual frames 50. The old "78/83" matches no committed artifact and is retired.

---

# WAVE E ADDENDUM (2026-08-29, Linux, 26 workflow workstreams)

All 26 branches merged into the integration branch. Per-workstream evidence:
`datasets/experiments/wave-e/*-summary.json`. Same measurement boundary (no Mac/iPhone).

| ID  | Workstream                       | Result (Linux, artifact-backed)                                                                    | State             |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------- |
| e01 | event recall                     | 12/16 recall; mean successful overlap .839; no false proposals in explicit non-event spans          | GREEN (measured)  |
| e02 | contact transfer                 | committed-gold replay metrics                                                                        | GREEN             |
| e03 | stroke L1/L2                     | stroke-heuristic-4 absence-of-measurement gates; resolved E10-F3 (near-profile now abstains)        | GREEN             |
| e04 | phase anchor-free                | committed-gold coverage 8/18 → 12/18 (v2.2 → v2.3), invariants intact                              | GREEN             |
| e05 | ownership adjudication           | D2-04 auditor-upheld corrections applied as versioned appends                                        | GREEN             |
| e06 | cascade replay                   | canonical strict-cascade replay needs Mac run dirs                                                   | BLOCKED_EXTERNAL  |
| e07 | silent failure                   | retro + coverage/risk artifacts                                                                      | GREEN             |
| e08 | rt target fresh                  | fresh-holdout guard added; attack did not find a new break                                          | SCIENTIFIC_NEG.   |
| e09 | rt contact adversarial           | adversarial findings preserved                                                                       | ORANGE            |
| e10 | rt stroke ambiguous              | 5 confidently-wrong findings pinned (F3 since resolved by e03); defenses regression-guarded         | GREEN (findings)  |
| e11 | OOD expansion                    | corpus 9 → 20 items (squash, racquetball, derived probes); frame-analyzability-3                   | GREEN             |
| e12 | ball hard slices                 | hard-slice labels + findings                                                                         | ORANGE            |
| e13 | event bounds eval                | bounds evaluation report                                                                             | GREEN             |
| e14 | learning curves                  | first curves for ball + target-acquisition; deterministic refresh script                             | GREEN             |
| e15 | envelope thresholds              | corpus re-derivation could not validate v0.1 thresholds — negative preserved                        | SCIENTIFIC_NEG.   |
| e16 | session scheduler                | scheduler + sim + 47 tests (drain, retry, suspend semantics)                                        | GREEN             |
| e17 | latency e2e                      | 96 Linux CPU runs; iPhone latency remains BLOCKED_EXTERNAL                                          | GREEN (Linux)     |
| e18 | warm worker soak                 | committed soak harness + real/fake soak reports (LINUX-CPU NOT-MAC)                                 | GREEN (Linux)     |
| e19 | result state props               | property tests over Result state machine                                                             | GREEN             |
| e20 | voice robustness                 | 73-utterance bounded eval; v2 accuracy 100%, false activation 0% (bounded scope stated)             | GREEN (bounded)   |
| e21 | consent e2e                      | full Postgres lifecycle; append-only enforcement verified via rejected mutations                    | GREEN             |
| e22 | acquisition wave2                | 7 lawful clips acquired with rights/provenance; AP-watermarked footage excluded                     | GREEN             |
| e23 | active learning queue            | label queue v3                                                                                       | GREEN             |
| e24 | data integrity                   | corpus integrity audit                                                                               | GREEN             |
| e25 | docs evidence pack               | claim→artifact reconciliation; corrections applied to this board (see above)                       | GREEN             |
| e26 | dead code audit                  | dead-code findings with regression coverage                                                          | GREEN             |

## GATES AT WAVE E INTEGRATION (Linux, commit cd4c0bb)

typecheck all packages green · root test suite green (swing-lab 536 passed | 4 skipped,
analysis-pipeline 47, all other packages green) · lint 0 errors · format:check clean ·
mobile tsc 0 errors · PR #1 CI verify + mobile green.

---

# WAVE F ADDENDUM (2026-08-29, Linux, 29 workflow workstreams)

All 29 branches merged into the integration branch. Per-workstream evidence:
`datasets/experiments/wave-f/*-summary.json`. Same measurement boundary (no Mac/iPhone).

| ID  | Workstream                   | Result (Linux, artifact-backed)                                                                                         | State            |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| f01 | stroke E10-F1 contact gate   | absent contact evidence now caps side confidence (limiting factor recorded)                                               | GREEN            |
| f02 | handedness cross-check       | declared-handedness contradiction by dominant-motion wrist degrades or abstains                                            | GREEN            |
| f03 | facing consensus             | multi-frame facing votes (window 200ms, ≥3 votes, ≥2/3 ratio) replace single-frame sign                                   | GREEN            |
| f04 | bimanual gate                | E10-F5 closed: symmetric wide-separation synchronized two-arm motion abstains; two-handed-backhand control preserved       | GREEN            |
| f05 | shoulder degeneracy gate     | E10-F3 root cause closed: image-plane shoulder separation < 0.04u abstains in both implementations                         | GREEN            |
| f06 | event recall misses          | recall 12/16 (.750) → 13/16 (.813); mean overlap .839 → .875; false proposals stayed 0                                   | GREEN (measured) |
| f07 | phase remaining six          | anchor-free v2.4: 12/18 → 13/18; anchored path byte-identical (15/17 unchanged); 5 honest abstentions remain              | GREEN            |
| f08 | ball hard slices             | hard-slice fixes measured; broader generalization still required                                                            | GREEN (bounded)  |
| f09 | contact adversarial          | adversarial contact findings persist; fixes partial                                                                        | ORANGE           |
| f10 | OOD 2x-speed gap             | 2x-speed separation not achievable with current frame statistics — negative preserved                                     | SCIENTIFIC_NEG.  |
| f11 | e22 intake                   | acquired-clip intake completed with rights/provenance                                                                       | GREEN            |
| f12 | label queue execution        | 35 append-only records across 4 modalities; queue ranks 14-18 blocked (source windows unavailable)                        | ORANGE           |
| f13 | contact dispute adjudication | 4/4 disputes adjudicated (all upheld); two-concurrent-balls forensic finding recorded                                       | GREEN            |
| f14 | ownership S3 rerun           | field-by-field identical to e05 after-eval (0 labels added since); worst-slice forensics filed                             | GREEN (verify)   |
| f15 | learning curve actions       | stroke is the LABEL_STARVED subsystem (4 of 9 L1 families at zero gold); TA curve saturating (~.69 asymptote)             | GREEN            |
| f16 | cascade Linux proxy          | per-stage replay scoreboard from committed artifacts; canonical strict cascade still Mac-blocked                            | GREEN (proxy)    |
| f17 | silent failure rerun         | silent-failure metric re-run on post-Wave-E head                                                                            | GREEN            |
| f18 | envelope thresholds v0.2     | corpus re-derivation again failed to validate thresholds — negative preserved                                              | SCIENTIFIC_NEG.  |
| f19 | mobile heuristic parity      | Lite ported to v5; output-identical to swing-lab over 19-fixture parity suite                                              | GREEN            |
| f20 | rt stroke hardened           | F20-F1 closed post-wave by stroke-heuristic-6 sparse-declared-wrist abstention; F20-F2 false OVERHEAD remains open        | ORANGE           |
| f21 | rt session scheduler         | storm/race/retry/livelock red team on real scheduler; executor seam scripted (native gap D-040 disclosed)                  | GREEN (bounded)  |
| f22 | rt envelope bypass           | 8 KNOWN GAP bypasses pinned as regressions (blur+grain, strobing, upscale, tiny subject, crop-jitter…); 2 proven negatives | ORANGE           |
| f23 | rt consent abuse             | consent abuse leaks found and pinned                                                                                        | ORANGE           |
| f24 | rt data provenance           | provenance chain attack found no material break                                                                             | GREEN            |
| f25 | two-pass verdict             | adaptive two-pass promotion not justified by wall-clock evidence — negative preserved                                     | SCIENTIFIC_NEG.  |
| f26 | result evidence audit        | 4 fabricated-provenance Result defects found and fixed (+7 regression tests; mobile 397 tests green)                       | GREEN            |
| f27 | voice adversarial            | 91-case adversarial eval: 97.8% accuracy, 0 false accepts; 2 negation mis-selections pinned                                | GREEN (bounded)  |
| f28 | decisions backlog            | decision log reconciled through Wave F                                                                                      | GREEN            |
| f29 | dead code execution          | dead-code removals executed with regression coverage                                                                        | GREEN            |

## GATES AT WAVE F INTEGRATION (Linux, commit d6f951f)

typecheck all packages green · root test suite green (swing-lab 592 passed | 4 skipped,
vision-geometry 78, analysis-pipeline 56, all other packages green) · lint 0 errors ·
format:check clean · mobile tsc 0 errors · mobile jest 40 suites / 397 tests green.

## OPEN FINDINGS AFTER WAVE F

- F20-F1 RESOLVED post-Wave-F: stroke-heuristic-6 abstains when a non-decisive
  handedness contradiction leaves the declared wrist below MIN_TRAVEL_SAMPLE_FRAMES
  (was: wrong-arm BACKHAND committed at 0.6). Both copies bumped to v6; parity 19/19;
  root gates + mobile gates green at the fixing commit.
- F20-F2: false OVERHEAD at 0.68 in the 0.6–1.0 torso-collapse band remains OPEN (RED).
- Contact adversarial failures (f09) and envelope bypasses (f22) remain ORANGE.
- Consent abuse leaks (f23) remain ORANGE.
- 2x-speed OOD separation (f10), envelope threshold validation (f18), and two-pass
  promotion (f25) are preserved scientific negatives.

## EXTERNAL BLOCKERS (unchanged)

1. Physical iPhone hardware (latency evidence).
2. Mac/Apple Vision (pose extraction, canonical strict-cascade re-measure, Swift builds).
3. Qualified coach recruitment (0 real reviews; technique/fault/severity/drill stay locked).
4. Additional lawful footage beyond the acquired CC/gov pool.
5. Mobbin MCP unavailable in this environment (disclosed; no fabricated research).
