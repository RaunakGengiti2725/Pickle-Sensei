# PICKLE SENSEI — HANDOFF V4 (DRAFT — NOT the live handoff)

> **STATUS: DRAFT produced by Wave D4 workstream d4-12 (2026-08-29, Linux box).**
> The integrator owns the final `HANDOFF_V4.md`. Until it exists, `docs/HANDOFF_V3.md`
> remains the live handoff. This draft does NOT modify `HANDOFF_V3.md`,
> `STATUS_BOARD.md`, or `DECISIONS.md`.
>
> Method: every claim below was reconstructed from COMMITTED artifacts on the Wave C
> integration branch (`devin/1787988068-wave-c-integration`) — wave A/B/C summary JSONs,
> experiment JSONs, annotation files, and the decision log — with each claim citing the
> artifact path. Label counts were recounted programmatically from the annotation files
> themselves (script results in `datasets/experiments/wave-d4/d4-12-summary.json`), not
> copied from prose. Contradictions between prose docs and artifacts are FINDINGS (§7).
> This box is Linux: no pose extraction, no canonical run dirs, no cascade re-measure —
> nothing here claims new Mac/iPhone/cascade numbers.

---

## 1. NORTH STARS — LATEST MEASURED TRUTH (Mac, 2026-08-28; NOT re-measured since)

```
            TARGET  EVENT  PADDLE  BALL  CONTACT  PHASE  STROKE   STRICT   USABLE
run start:   5/5    3/5    5/5     4/5    1/5      2/5    2/5      1/5      1/5
run end:     5/5    3/5    5/5     5/5    2/5      4/5    3/5      2/5      2/5
```

- Source: `docs/STATUS_BOARD.md` (table) + `datasets/experiments/EXP-2026-08-28-cascade-waterfall.json`
  - `datasets/experiments/wave-a/U-usable-result-v1-measurement.json`.
- Wave C explicitly did NOT re-measure the cascade (Linux boundary stated in
  `docs/STATUS_BOARD.md` Wave C addendum). Any Wave C effect on these numbers is
  UNMEASURED until the Mac re-measure list (§4) is executed.
- Held-out one-shot verdict stands: dev contact gains did NOT transfer
  (`datasets/experiments/wave-a/A-summary.json`; D-033 in `docs/DECISIONS.md`).
  Held-out cases `wm-dink-01`, `afn-vic-rally1` remain untouchable
  (re-affirmed by every Wave C summary's `excludedHeldOutBundles`, e.g.
  `datasets/experiments/wave-c/c05-summary.json`).

## 2. PER-SUBSYSTEM STATUS (with evidence pointers)

### 2.1 Target acquisition

- Live Swift = D-027 promoted candidate (5-frame sustained gesture, 3s ambiguity
  timeout, incumbent hysteresis) — `docs/DECISIONS.md` D-027.
- Verified TA gold: **59 cases (54 dev + 5 locked_test)** — recounted from
  `datasets/ta-bench/cases.json` (`verification.state === "verified"`); total case pool
  301 (rest machine-proposed Tier-C). Matches HANDOFF_V3 §"TARGET ACQUISITION".
- Bench candidate **acquire-v4** (correct .863, contested wrong .167 on dev n=54):
  `datasets/experiments/wave-b/W3-summary.json`, `W3-variant-table.json`. NOT promoted —
  awaiting D-027-pattern gate. Its prerequisite (live tap-distance instrumentation)
  SHIPPED in Wave C: `datasets/experiments/wave-c/c17-acquire-v4-instrumentation-summary.json`
  (always-on `targetLock` telemetry, shipped behavior unchanged). Remaining gate input:
  live captures + one-shot locked_test.
- Calibration proxy: TA ECE .121 (n=12, agreement proxy) —
  `datasets/experiments/wave-c/c11-coverage-risk.json` (caveat stated in-file).

### 2.2 Event proposal / session engine

- `stroke-event-2` (body-motion proposes, paddle confirms) is live — D-030;
  invariance re-verified byte-identical under paddle changes and merge
  (`datasets/experiments/wave-b/W1-summary.json`, `wave-a/E-replay-validation.json`).
- EVENT is the only cascade stage that did not move (3/5) — HANDOFF_V3 §6 item 1;
  named losses: rally1 perception coverage, dink 42% boundary overlap
  (`datasets/experiments/wave-a/A-summary.json`).
- Session engine canonical + mobile-wired (D-040), replay-validated Δ=0ms
  (`datasets/experiments/wave-a/E-replay-validation.json`). Native gaps (motion
  stream + per-event clips): Swift sources + tests WRITTEN in Wave C but never
  compiled (no Apple SDK) — `datasets/experiments/wave-c/c09-session-native-summary.json`
  → ORANGE, Mac-gated (§4).
- W14 adjudications: all 5 closed, annotation guide v1 written —
  `datasets/experiments/wave-c/C06-adjudications.json`,
  `ml/annotations/ta-ownership-annotation-guide-v1.md`.

### 2.3 Paddle

- `paddle-track-2` flip-segmentation live (D-035): S4 R .29→.43, Δrecall −.02
  (`datasets/experiments/wave-b/W1-summary.json`, `W1-waterfall-{before,after}.txt`).
- Detector timestamp off-by-one (W12 discovery) ROOT-CAUSED AND FIXED in Wave C:
  `datasets/experiments/wave-c/c01-summary.json` +
  `tools/paddle-lab/test_timestamp_alignment.py`. Cascade effect UNMEASURED (Mac).
- Edge-on crop recovery productionized behind `--crop-recovery` (OFF, version
  `crop-recovery-v1`): `datasets/experiments/wave-c/c02-edgeon-crop-production-summary.json`,
  `packages/swing-lab/src/paddleCropRecovery.ts`. Held-out effect unmeasured.
- Fragment merge remains NOT production-safe (D-042, re-verified;
  `datasets/experiments/EXP-2026-08-28-tracklet-merge.json`).

### 2.4 Ball

- `ball-track-2` occlusion state machine live (D-034); BALL 5/5
  (`datasets/experiments/wave-a/I-summary.json`).
- Ball gold **22→60 frame labels** with `occlusionState`
  (`datasets/experiments/wave-c/c04-ball-gold-summary.json`); recount confirms 60
  ballFrames total (47 visible / 4 uncertain / 5 not_visible / 4 occluded; 37 carry
  occlusionState) — see §5.

### 2.5 Contact

- `contact-evidence-4` target-gated KDE fusion live (D-033). Dev 30/30ms + honest
  rally1 abstention; held-out regression disclosed
  (`datasets/experiments/wave-a/A-summary.json`, `A-forensics-final.txt`).
- +13 independent contact observations in Wave C (blind intra-annotator double pass;
  1 prior contact DISPUTED, disclosed not deleted):
  `datasets/experiments/wave-c/c05-summary.json`. Unique contact events: 28
  (countReconciliation in that file — do not conflate with annotation-record counts, §5/§7).
- Binding rule (HANDOFF_V3 rule 17): next contact iteration from NEW dev labels only.

### 2.6 Phases / stroke

- phases v2.1 anchor-free + ordering repair live (D-038); PHASE 2/5→4/5
  (`datasets/experiments/wave-b/W5-summary.json`, `W5-anchor-free-measurement.json`).
- `stroke-heuristic-2` live (D-036); dev L1 2/2, zero confidently-wrong dev
  (`datasets/experiments/wave-b/W9-summary.json`, `W9-cascade-stroke-verdict.json`).
  Mobile port `strokeHeuristicLite` still v1 — sync follow-up open (D-036 text).
- Stroke taxonomy bench (`pickleball-taxonomy-v2` gold contract, L1/L2/L3 scoring)
  shipped; **22 stroke gold labels** committed in `datasets/paddle-bench/stroke-gold.json`
  (recounted); further gold BLOCKED_EXTERNAL on footage/Mac loop
  (`datasets/experiments/wave-c/c18-stroke-taxonomy-labels-summary.json`).

### 2.7 Product (mobile)

- AUTO DETECT real end-to-end (D-039); Stroke Result + TRY AGAIN surface (W8,
  `datasets/experiments/wave-b/W8-summary.json`); 214 mobile jest tests at Wave B end
  (`docs/STATUS_BOARD.md` gates). Wave C mobile additions (capture guidance +
  uncertainty UX: `datasets/experiments/wave-c/c13-summary.json`; session bridge:
  `c09-session-native-summary.json`; tap telemetry: `c17-...json`) — mobile jest was
  NOT runnable in the Wave C workspace filter setup; Mac re-verify required
  (`docs/STATUS_BOARD.md` Wave C gates).
- Adaptive completion: data gate MET (n=20, FIXED 1371ms vs ADAPTIVE 668ms —
  `datasets/experiments/EXP-2026-08-28-adaptive-completion.json`, D-043); live Swift
  instrumentation shipped, default FIXED (D-043). Promotion awaits live replay captures.
- Capture envelope checker (`packages/capture-envelope`, thresholds
  `capture-envelope-thresholds-v0.1-provisional`): measured over the 3 committed bundle
  clips only — premise said 13, corrected and disclosed
  (`datasets/experiments/wave-c/c12-summary.json`, `c12-envelope-measurements.json`).

### 2.8 Latency (ALL numbers Mac unless labeled LINUX-CPU; iPhone = BLOCKED_EXTERNAL)

- Cold E2E 55.07→17.25s bit-equal drain fix (D-041;
  `datasets/experiments/wave-b/W2-summary.json`, `P-summary.json`).
- Warm worker NOW WIRED into runPaddleStage, default ON with fallback
  (`datasets/experiments/wave-c/c07-summary.json`,
  `packages/swing-lab/src/paddleWorker.ts`); bit-equal payloads re-verified on
  LINUX-CPU only. The ~11.9s E2E remains a PROJECTION until Mac re-measure.
- paddle∥ball prep concurrency shipped; adaptive two-pass behind `--two-pass` (OFF)
  (`datasets/experiments/wave-c/c08-concurrency-twopass-summary.json`).
- Static stride-3+ROI stays INVALIDATED (D-041 supersedes D-032's shortlist;
  `datasets/experiments/wave-a/H-downstream.json`).

### 2.9 Data / truth infrastructure

- Corpus engine (D-024/D-025), splits, shadow untouched (`docs/STATUS_BOARD.md` gates).
- silent-failure-v1 third-north-star contract + calibration tooling shipped; 0/0
  measurable on Linux (runs absent) — `datasets/experiments/wave-c/c11-summary.json`,
  `packages/swing-lab/src/silentFailure.ts`.
- OOD gates + property/fuzz suite: 1 real bug found and fixed; corpus invariant check
  299 files / 0 violations (`datasets/experiments/wave-c/c15-ood-property-tests-summary.json`).
- Consent architecture (analyze vs train split): migration `0015_consent_records.sql`,
  `packages/shared-types/src/consent.ts`
  (`datasets/experiments/wave-c/c10-consent-architecture-summary.json`).
- Footage: 6 new rights-cleared 60s clips committed under
  `datasets/pickleball/fresh-candidates/` (label-blind fresh holdout candidates), 4
  unknown-rights items quarantined (`datasets/experiments/wave-c/c16-data-acquisition-summary.json`).
  NOTE: `docs/STATUS_BOARD.md` Wave C addendum says "1 new CC-licensed candidate" — see §7.
- Coach program: infra 100% complete, 0 real reviews, recruitment BLOCKED_EXTERNAL
  (`datasets/experiments/wave-c/c14-coach-portal-summary.json`, `docs/COACHING.md`).
- Claim gate: FAIL — approved external language unchanged: "Pickle Sensei is still
  being validated" (`docs/CLAIM_REVIEW.md`).

## 3. OPEN D-NUMBERS / PENDING GATES

| D#        | State                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-016     | Store receipt validation typed-501 until Apple/Google credentials exist (external).                                                                                                                                                                                                          |
| D-026/027 | TA bench gates live Swift changes; acquire-v4 awaits live tap captures (instrument shipped, C17) + one-shot locked_test.                                                                                                                                                                     |
| D-029     | Adaptive completion NOT promoted; data gate MET (D-043); waits on live-trigger replay captures (instrument shipped, wave-a/G).                                                                                                                                                               |
| D-032     | SUPERSEDED by D-041 (stride/ROI invalidated; service path instead).                                                                                                                                                                                                                          |
| D-036     | Mobile `strokeHeuristicLite` still v1 — sync to stroke-heuristic-2 open.                                                                                                                                                                                                                     |
| D-040     | Session native gaps: C09 Swift written but unbuilt — Mac build+test gate.                                                                                                                                                                                                                    |
| D-042     | Merge stays research-only; path = segment-level ownership inside reconciliation.                                                                                                                                                                                                             |
| (gap)     | Wave C shipped versioned contracts and a default-ON behavior change with NO decision-log entries (D-044+ not written): c01 timestamp fix, c02 crop-recovery-v1, c07 worker default ON, c10 consent, c11 silent-failure-v1, c12 envelope thresholds. Integrator should append D-044… entries. |

Decision log currently ends at **D-043** (`docs/DECISIONS.md`, 175 lines) — consistent
with HANDOFF_V3's "D-001…D-043".

## 4. EXACT MAC-GATED RE-MEASURE LIST

From `docs/STATUS_BOARD.md` Wave C addendum blocker 4 + per-summary notes:

1. **Cascade n=5 re-measure** (`pnpm lab:cascade` after `pnpm lab:regen`) to claim any
   effect from C01 (timestamp fix), C02 (`--crop-recovery`), C07 (worker default ON),
   C08 (`--two-pass`) — canonical run dirs and Apple Vision pose are Mac-only.
2. **E2E latency re-measure** with the wired warm worker (verify the ~11.9s projection;
   `wave-c/c07-summary.json`).
3. **C09 session-native Swift build + tests** (motion stream + per-event clips) — no
   Apple SDK on Linux (`wave-c/c09-session-native-summary.json`).
4. **Mobile suite on Mac**: `cd apps/mobile && npm ci && npx tsc --noEmit && npx jest`
   (not runnable in the Wave C workspace filter setup — `docs/STATUS_BOARD.md` gates).
5. **Adaptive completion**: collect live captures → replay → flip
   `CaptureCompletionStrategyStore` (D-043).
6. **acquire-v4 gate**: live tap-distance captures (C17 telemetry) → one-shot
   locked_test (D-027 pattern).
7. **iPhone**: all physical-device latency remains BLOCKED_EXTERNAL (hardware).

## 5. LABEL INVENTORY (RECOUNTED PROGRAMMATICALLY, 2026-08-29)

Recount script output committed at `datasets/experiments/wave-d4/d4-12-summary.json`.
Counted from `datasets/ta-bench/cases.json`,
`datasets/paddle-bench/bundles/*/annotation/*.json`,
`datasets/paddle-bench/stroke-gold.json`,
`datasets/paddle-bench/ownership-review/ownership-review.json`.

| inventory                                       | recounted value                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| TA cases (total pool / verified / dev / locked) | 301 / **59** / 54 / 5                                                                  |
| Event label records (all annotation files)      | **47** (29 target / 18 other); 44 carry contactMs                                      |
| Unique contact events (per c05 reconciliation)  | 28 (41 contact annotation records incl. independent relabels)                          |
| Ball gold frame labels                          | **60** (47 visible / 4 uncertain / 5 not_visible / 4 occluded); 37 with occlusionState |
| Paddle frames: target / other                   | 102 / 142                                                                              |
| Ownership sidecar verdict entries               | 100 (`ownership-review/README.md`: dual frames 30→50 pre/post Wave C)                  |
| Same-tMs target+other dual frames (recount)     | 50                                                                                     |
| Stroke gold labels (pickleball-taxonomy-v2)     | 22                                                                                     |

Denominator warning (from `datasets/paddle-bench/ownership-review/README.md`):
HANDOFF_V3 §3's "target boxes 78, other 83" uses a different counting basis than either
the annotation-file point counts or the sidecar verdict counts — never conflate them.

## 6. CONTRACT VERSIONS CURRENTLY LIVE (grep-verified on this branch)

| contract / version                                                                 | where                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| usable-result-v1                                                                   | `packages/swing-lab/src/cascadeWaterfall.ts` (rule 16: re-version, never soften) |
| silent-failure-v1                                                                  | `packages/swing-lab/src/silentFailure.ts`                                        |
| contact-evidence-4 · ball-track-2 · paddle-track-2                                 | swing-lab tracker/fusion modules (D-033/034/035)                                 |
| stroke-event-2 (stroke-event-1 legacy-replayable)                                  | swing-lab event proposal (D-030)                                                 |
| stroke-heuristic-2 (mobile Lite port still v1)                                     | swing-lab / vision-geometry (D-036)                                              |
| phases v2.1 (anchor-free `anchorBasis`)                                            | swing-lab phase modules (D-038)                                                  |
| acquire-v4 (bench) · ta-replay-2 · shipped=D-027                                   | ta-bench engine                                                                  |
| liveness-v1                                                                        | miner/TA proposer (D-028)                                                        |
| paddle-serve-v1 (worker default ON)                                                | `packages/swing-lab/src/paddleWorker.ts` + `tools/paddle-lab/detect_paddle.py`   |
| crop-recovery-v1 (flag OFF)                                                        | `packages/swing-lab/src/paddleCropRecovery.ts`                                   |
| capture-envelope-thresholds-v0.1-provisional                                       | `packages/capture-envelope/src/thresholds.ts`                                    |
| pickleball-taxonomy-v2 (stroke gold) · pickleball-stroke-taxonomy-v3 (recognition) | shared-types / stroke-gold.json                                                  |
| technique-intent-v1 · technique-profile-v1                                         | shared-types (D-031/D-039)                                                       |
| video-analysis-v1 · model-training-v1/v2 (consent)                                 | `packages/shared-types/src/consent.ts` (C10)                                     |
| fault-taxonomy-v0-draft (46 faults) · drill-library-v0                             | admin-web coach lab (wave-a/J)                                                   |

## 7. FINDINGS — DOC vs ARTIFACT CONTRADICTIONS (for the integrator)

1. **Event-label counts diverge from HANDOFF_V3.** V3 §3 says "labels 9→34 (21
   target)"; programmatic recount finds **47 eventLabels records (29 target)** because
   Wave C C05 appended 13 independent contact-observation records as new annotation
   files (`c05-summary.json`: 41 contact annotation records, unique events 28). The
   final V4 must state BOTH denominators explicitly (unique events vs annotation records).
2. **Ownership box counts.** HANDOFF_V3 §3 "target boxes 78, other 83" vs recount
   102/142 (annotation-file points, post-Wave-C) vs sidecar-basis counts in
   `ownership-review/README.md` (65→85 target / 81→140 other visible points). Three
   different bases exist in the wild; V4 must pick and define one.
3. **C16 footage count.** STATUS_BOARD Wave C addendum row C16 says "1 new CC-licensed
   candidate accepted"; `c16-data-acquisition-summary.json` documents **6 accepted
   clips (181.08 MB, 360s) committed** + 4 quarantined. The addendum row understates
   the committed artifact.
4. **HANDOFF_V3 latency §3 is stale w.r.t. C07.** V3 says "once runPaddleStage wires
   it"; C07 wired it (default ON). Not a truth violation (V3 predates Wave C) but V4
   must replace the projection language with "wired; Mac re-measure pending".
5. **Decision-log gap.** Wave C behavior changes (esp. worker default ON) and new
   versioned contracts have no D-numbers (see §3 last row).
6. **C12 premise correction** is already disclosed in-artifact (3 committed clips, not 13) — carry the disclosure into V4, don't silently fix.
7. **stroke-heuristic-1 references still live in code** (12 grep hits) alongside
   stroke-heuristic-2 — expected (legacy replay/registry), but V4 should state that the
   mobile Lite port is the only PRODUCT surface still on v1 semantics (D-036).
8. **C03 status.** STATUS_BOARD addendum lists C03 "IN FLIGHT", but the integration
   branch contains the C03 merge (commit f548115 "Merge origin/devin/wave-c/c03-ownership-labels")
   and `c03-summary.json` + 30 ownership frames are committed. The addendum row is stale.

## 8. NON-NEGOTIABLE RULES

All rules of HANDOFF_V3 §4 (1–19) carry forward unchanged. No additions proposed by
this draft; rule candidates from Wave C (silent-failure-v1 re-versioning language is
already stated in `c11-summary.json`) are for the integrator to number.

## 9. EXTERNAL BLOCKERS (unchanged from STATUS_BOARD Wave C addendum)

1. Physical iPhone hardware.
2. Qualified coach recruitment (0 real reviews).
3. Footage supply (6 fresh candidates now committed — see finding 3).
4. Mac re-measure list (§4).
