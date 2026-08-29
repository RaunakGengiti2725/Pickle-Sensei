# F14 — S3 ownership re-run on post-E05 corrected gold: worst slice forensics

Workstream: `f14-ownership-s3-rerun` · bench `ownership-bench-v1` (`packages/swing-lab/src/ownershipBench.ts`, unmodified) · dev split, grouped by source session · held-out `wm-dink-01` / `afn-vic-rally1` untouched and excluded.

## 1. Label state since E05

Zero ownership labels or corrections have been added since the E05 merge (`git log c97925b..HEAD -- datasets/paddle-bench` touches only wave-D2 **contact**-audit sidecars). The current corrected gold is therefore exactly the E05 after-state: waveC/wave-a annotation passes + the three `devin-visual-v4-waveE-ownership-corrections.json` sets (6 corrections: 2 supersede-point, 4 add-visible).

## 2. Re-run vs Wave C baseline and e05-after

Fresh run: `tsx src/ownershipBench.ts --apply-corrections --out datasets/experiments/wave-f/f14-ownership-eval.json` (this tree, commit recorded in the summary). The f14 report is **numerically identical** to `wave-e/e05-ownership-eval-after.json` on every method (verified field-by-field), which is the expected proven-negative for "labels added since": there are none.

| method (dev) | Wave C baseline (`wave-d/d02-ownership-eval.json`, uncorrected, 38 duals / 17 pose) | e05-after = f14 (corrected, 39 duals / 18 pose) |
| --- | --- | --- |
| incumbent_wrist_ratio | .342 all (13/38) · .765 pose (13/17) | .333 all (13/39) · .722 pose (13/18) |
| b1_wrist_distance_only | .316 all (12/38) · .706 pose (12/17) | .333 all (13/39) · .722 pose (13/18) |
| b2_target_geometry | .211 all (8/38) · .471 pose (8/17) | .205 all (8/39) · .444 pose (8/18) |
| b3_temporal_continuity | .533 (16/30) · .25 pose (3/12) | .516 (16/31) · .231 pose (3/13) |

No ranking flips. On corrected gold the incumbent loses its correct-count lead over B1 (both 13/18 on the pose subset); the incumbent's only remaining edge is precision-when-answering (.765 vs .722) bought with one abstention.

## 3. Worst slice

Failure modes must be separated: **abstentions** (22 of 26 incumbent failures) are all on the five no-committed-pose cases (`wm-*`, `afn-*` groups, acc 0 by construction — a data-availability gap, not an S3 ranking error). **Wrong picks** — the wrong-player attribution S3 exists to prevent — number 4, and all 4 land in one slice:

> **`dvids-944403` group, case `wavea-944403-dink`, dark_on_dark dual frames** — incumbent pose-subset group acc .643 (9/14, 1 abstain, 4 wrong picks). Every wrong pick is `dark_on_dark`; 3/4 are also `multi_paddle`, 2/4 `edge_on`. Wrong-pick rate when answering: 4/17 = 23.5% overall, but 4/13 = 30.8% within this group. No other group has a single wrong pick.

## 4. Forensics — top 3 wrong picks (evidence: `f14-forensics-evidence.json`)

All distances are normalized image units; veto = candidate is discarded as other-owned when `dOtherWrist < 0.85 × dTargetWrist` (`TRACKER_GATES.otherOwnershipFactor`).

| # | tMs | picked (gold=other) | dTargetWrist picked | gold target paddle dTargetWrist | nearest other wrist to picked | veto needed | veto shortfall |
| - | --- | --- | --- | --- | --- | --- | --- |
| 1 | 22338.98 | (0.3141, 0.3815) | **0.021** | 0.0741 | 0.1456 | <0.0179 | 8.1× |
| 2 | 22589.23 | (0.2950, 0.3850) | **0.0263** | 0.0698 | 0.1588 | <0.0224 | 7.1× |
| 3 | 22088.73 | (0.3255, 0.3773) | **0.0706** | 0.0812 | 0.1376 | <0.0600 | 2.3× |
| (4) | 21171.15 | (0.3177, 0.3611) | 0.0625 | 0.1440 | 0.1300 | <0.0531 | 2.4× — same signature |

**Single shared root cause.** In every wrong pick, an *other-owned* paddle point sits at x≈0.30–0.33, y≈0.36–0.39 — within 0.02–0.07 of the target's leading wrist and strictly closer than the true target paddle (which hangs low at y≈0.46–0.53 during the dink). The pose other-wrist set for these frames contains wrists only at x≥0.44: the player who owns the intruding paddle has **no detected wrist near it** (occluded/undetected in the committed wave-a pose), so the other-wrist-ratio veto is structurally unable to fire — it misses by 2–8×, not marginally. Nearest-target-wrist ranking then does exactly what it is designed to do and picks the intruder. Failures #1 and #2 involve adjudicated labels (#2's picked point is the ADJ-D7 corrected coordinate), so this is confirmed on human-adjudicated gold, not on disputed points.

Corroboration: the gold target paddle is never vetoed on these frames (pinned in `packages/swing-lab/test/f14OwnershipForensics.test.ts`) — the failure is purely the ranking term, not an over-aggressive veto. B1 (no veto) fails these same frames identically; b2 geometry also fails 3/4 (the intruding paddle is also near the torso). No committed-data method survives this slice.

## 5. Verdict for Wave G

Ownership **does** need a Wave G code workstream. The dominant live failure mode (100% of wrong picks) is: *opponent/partner paddle inside the target's wrist neighborhood while its owner's wrist is missing from pose*. A wrist-distance ranker with a wrist-presence-dependent veto cannot fix this by threshold tuning — `otherOwnershipFactor` would need to drop below ~0.12 (from 0.85) to catch failure #1, which would veto essentially everything. Candidate directions (for Wave G, not implemented here): person-box / limb-association evidence that does not require a detected wrist; temporal handover consistency (the intruding paddle at ≈(0.30, 0.37) persists across 21171→22589 while the target paddle stays low); paddle-height-vs-wrist-height plausibility during dinks. Regression fixtures pinning the current wrong picks are in `f14OwnershipForensics.test.ts`; a fix must flip those pins consciously.

## Honesty

- No production code modified; bench evaluator untouched. New files: this report, `f14-forensics.ts` (read-only evidence dumper), `f14-forensics-evidence.json`, `f14-ownership-eval.json`, regression fixture test, summary JSON.
- No labels created or changed; held-out cases and fresh-candidate pool untouched.
- Numbers above are recomputed from committed data in this tree; the d02/e05 columns are quoted from their committed artifacts.
