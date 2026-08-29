# Model-Health Review

- Version: model-health-review-v1
- Generated: 2026-08-29T21:20:00.000Z
- Pickle Sensei model-health review, generated from committed telemetry/bench/certification artifacts only. Sections without real evidence are NO_DATA or BLOCKED_EXTERNAL by design.

| Section | Status |
| --- | --- |
| What changed since the last review | OK |
| Active models | OK |
| Input/score drift vs. previous period | NO_DATA |
| New hard slices | ATTENTION |
| Confidence anomalies (calibration) | ATTENTION |
| User complaints / feedback | NO_DATA |
| Coach/model disagreements | BLOCKED_EXTERNAL |
| Latency regressions | NO_DATA |
| Device-specific problems | BLOCKED_EXTERNAL |
| Abstention increases | ATTENTION |
| Capture-envelope regressions | ATTENTION |
| Next-wave recommendations | ATTENTION |

## What changed since the last review — OK

- 201 experiment summary artifacts across 12 waves (wave-a, wave-b, wave-c, wave-d, wave-d2, wave-d3, wave-d4, wave-e, wave-f, wave-g, wave-g2, wave-h); latest wave is wave-h with 17 workstream summaries.
- wave-h: h10-stroke-flow-e2e — MANDATORY GATE 1 — Stroke Analysis full flow
- wave-h: h11-session-cert — MANDATORY GATE 1 (Session): start → target → E1 → clip/analyze E1 while recording continues → E2/E3+ → progressive Results → stop → summary → reopen session, across every executable environment
- wave-h: datasets/experiments/wave-h/h12-import-video-summary.json — GATE 12 — imported video (workstream h12-import-video)
- wave-h: h13-mobile-failure — Gate 11 — mobile failure modes
- wave-h: datasets/experiments/wave-h/h14-cascade-cert-summary.json — GATE 4 — cascade certification (Wave H, workstream h14-cascade-cert)
- wave-h: h15-autodetect-cert — h15-autodetect-cert — Auto Detect (stroke auto-selection vs declared separation, ambiguous/practice-swing/miss/unsupported handling) + adaptive completion adequacy
- wave-h: datasets/experiments/wave-h/h16-fresh-gen-cert-summary.json — MANDATORY GATE 3 — fresh generalization certification
- wave-h: wave-h/h17-envelope-cert — GATE 5 (any-video safety): SUPPORTED/DEGRADED/UNSUPPORTED capture-envelope classification end-to-end
- wave-h: h18-calibration-cert — GATE 6 — calibration / silent failure certification + frozen release thresholds
- wave-h: h19-security-cert — MANDATORY GATE 8 — security/privacy production review of services/api + media handling
- wave-h: h20-data-rights-cert — GATE_9_DATA_RIGHTS_TRAINING_SAFETY
- wave-h: h21-backend-cert — GATE 10 — backend/DB reliability
- wave-h: datasets/experiments/wave-h/h23-flags-cert-summary.json — GATE 14 — model/config/flag safety (h23-flags-cert)
- wave-h: h24-observability-cert — GATE 15 — observability
- wave-h: h25-release-cert — GATE 16 — release-candidate discipline: pinned RC record, release plan, and the consolidated P0/P1 remaining register
- wave-h: datasets/experiments/wave-h/h26-redteam-perception-summary.json — h26-redteam-perception
- wave-h: datasets/experiments/wave-h/h27-redteam-product-summary.json — h27-redteam-product

Evidence:

- `datasets/experiments/wave-h/h10-stroke-flow-e2e-summary.json`
- `datasets/experiments/wave-h/h11-session-cert-summary.json`
- `datasets/experiments/wave-h/h12-import-video-summary.json`
- `datasets/experiments/wave-h/h13-mobile-failure-summary.json`
- `datasets/experiments/wave-h/h14-cascade-cert-summary.json`
- `datasets/experiments/wave-h/h15-autodetect-cert-summary.json`
- `datasets/experiments/wave-h/h16-fresh-gen-cert-summary.json`
- `datasets/experiments/wave-h/h17-envelope-cert-summary.json`
- `datasets/experiments/wave-h/h18-calibration-cert-summary.json`
- `datasets/experiments/wave-h/h19-security-cert-summary.json`
- `datasets/experiments/wave-h/h20-data-rights-cert-summary.json`
- `datasets/experiments/wave-h/h21-backend-cert-summary.json`
- `datasets/experiments/wave-h/h23-flags-cert-summary.json`
- `datasets/experiments/wave-h/h24-observability-cert-summary.json`
- `datasets/experiments/wave-h/h25-release-cert-summary.json`
- `datasets/experiments/wave-h/h26-redteam-perception-summary.json`
- `datasets/experiments/wave-h/h27-redteam-product-summary.json`

## Active models — OK

- pose.apple-vision@apple-vision-bodypose-1 — task=pose_estimation, status=production, platforms=ios, training dataset=none (no trained artifact)
- pose.mediapipe@mediapipe-pose-landmarker-1 — task=pose_estimation, status=production, platforms=android, training dataset=none (no trained artifact)
- trigger.temporal-heuristic@temporal-stroke-heuristic-2 — task=stroke_trigger, status=production, platforms=ios/android, training dataset=none (no trained artifact)
- stroke.heuristic-hierarchical@stroke-heuristic-7 — task=stroke_classification, status=production, platforms=ios/android/server, training dataset=none (no trained artifact)
- phase.geometry@phase-geometry-1 — task=phase_segmentation, status=production, platforms=ios/android/server, training dataset=none (no trained artifact)
- biomech.geometry@features-geometry-1 — task=biomechanics_extraction, status=production, platforms=ios/android/server, training dataset=none (no trained artifact)
- scorer.sm-v1@sm-v1 — task=technique_scoring, status=production, platforms=ios/android/server, training dataset=none (no trained artifact)
- faults.checkpoint-threshold@faults-v1 — task=fault_detection, status=production, platforms=ios/android/server, training dataset=none (no trained artifact)
- uncertainty.engine@uncertainty-v1 — task=uncertainty_estimation, status=production, platforms=ios/android/server, training dataset=none (no trained artifact)
- coach.priority@priority-v1 — task=coaching_ranking, status=production, platforms=ios/android/server, training dataset=none (no trained artifact)

Evidence:

- `packages/model-registry/src/defaultManifest.ts`

## Input/score drift vs. previous period — NO_DATA

- Drift requires production evaluation-trial telemetry over at least two periods. The consent-gated ingest path exists (h07 evaluation_telemetry), but zero real trials have been uploaded, so no drift measurement is possible and none is claimed.

Evidence:

- `datasets/experiments/wave-g2/h07-distribution-telemetry-summary.json`

## New hard slices — ATTENTION

- 15 hard-slice artifacts across 5 locations; most recent location is wave-h. Hard slices remain open work: each artifact records slices where the ball/stroke pipeline underperforms the pooled benchmark.

Evidence:

- `datasets/experiments/wave-d2/d2-06-ball-hard-slices-summary.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices-summary.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices/candidates/afn-sasebo-rally2.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices/candidates/wavea-sasebo-volleys.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices/candidates/wavea-wgm-wheelchair.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices/candidates/wm-volley-02.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices/manifest.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices/report-after.json`
- `datasets/experiments/wave-e/e12-ball-hard-slices/report-before.json`
- `datasets/experiments/wave-f/f08-ball-hard-slice-fixes-summary.json`
- `datasets/experiments/wave-f/f08-ball-hard-slice-fixes/e12-rerun-after.json`
- `datasets/experiments/wave-f/f08-ball-hard-slice-fixes/e12-rerun-baseline.json`
- `datasets/experiments/wave-f/f16-ball-hardslice-linux-proxy.json`
- `datasets/experiments/wave-g/g16-ball-hardslice-replay.json`
- `datasets/experiments/wave-h/h14-ball-hardslice-linux-proxy.json`

## Confidence anomalies (calibration) — ATTENTION

- W14 TA blind overlap (n=12 verdicts): n=12, ECE@10=0.1208, AURC=0.0765
- W14 ownership blind overlap (n=31 boxes): n=31, ECE@10=0.0977, AURC=0.0176
- D2-04 ownership audit pooled (n=80 slots, 3 bundles): n=80, ECE@10=0.1094, AURC=0.1245
- D2-04 ownership audit — wavea-944403-dink (n=44 slots): n=44, ECE@10=0.1193, AURC=0.1379
- D2-04 ownership audit — wavea-944403-smash (n=16 slots): n=16, ECE@10=0.2438, AURC=0.2695
- D2-04 ownership audit — wavea-faead-rally (n=20 slots): n=20, ECE@10=0.2000, AURC=0.0209
- Single certified snapshot only — anomaly detection over time requires a second comparable calibration run, which does not exist yet.
- Calibration thresholds are governed by the frozen gate release-gate-g6-calibration-v1 (status FROZEN, frozen 2026-08-29T18:10:00Z); this review reports against it and never adjusts it.

Evidence:

- `datasets/experiments/wave-h/h18-cert-report.json`
- `datasets/experiments/wave-h/h18-frozen-release-gate-g6-v1.json`

## User complaints / feedback — NO_DATA

- No user-complaint or user-feedback artifacts exist in the repo. The product has no external users yet; nothing is claimed.

## Coach/model disagreements — BLOCKED_EXTERNAL

- Zero real coach reviews exist (AWAITING QUALIFIED COACHES — engine ready; N=0 real reviews). Disagreement analysis is blocked on qualified external coaches; no coach labels are fabricated.

Evidence:

- `datasets/coach-review/agreement/agreement-report.json`

## Latency regressions — NO_DATA

- 6 latency/timing artifacts exist, but each is a single-run measurement of a different instrument/configuration. Regression detection needs >= 2 comparable runs of the same instrument over time; none exist, so no regression (or absence of regression) is claimed.

Evidence:

- `datasets/experiments/wave-a/H-timing.json`
- `datasets/experiments/wave-a/P-latency-plan.md`
- `datasets/experiments/wave-e/e17-latency-e2e-summary.json`
- `datasets/experiments/wave-g/g23-latency-dist-summary.json`
- `datasets/experiments/wave-g/g23-latency-dist/head-latency-dist-report.json`
- `datasets/experiments/wave-g/g23-latency-dist/head-seq-per-request.json`

## Device-specific problems — BLOCKED_EXTERNAL

- No physical-device measurements exist: the iPhone trial harness is built but no devices in the required matrix have been acquired, and this CI box is Linux-only. Device-specific problems cannot be assessed and none are claimed.
- Harness verdict: HARNESS_READY_DEVICE_EVIDENCE_BLOCKED_EXTERNAL: the full GATE B trial harness (matrix, schemas, ground-truth rules, latency targets, cold/warm percentile reporting, fail-fast runner) is built and Linux-validated; every device measurement remains BLOCKED_EXTERNAL until physical iPhones and a Mac exist.

Evidence:

- `datasets/experiments/wave-g2/h06-device-harness-summary.json`

## Abstention increases — ATTENTION

- contact: 4/15 units abstained (26.7%) in the certified snapshot.
- stroke: 13/18 units abstained (72.2%) in the certified snapshot.
- Single snapshot only — an abstention INCREASE requires a second comparable measurement over time, which does not exist; no trend is claimed.

Evidence:

- `datasets/experiments/wave-h/h18-cert-report.json`

## Capture-envelope regressions — ATTENTION

- Envelope certified once (2026-08-29T18:04:16.102Z, thresholds capture-envelope-thresholds-v0.3-provisional): GATE 5 (any-video safety): SUPPORTED/DEGRADED/UNSUPPORTED capture-envelope classification end-to-end.
- Single certification only — regression detection requires re-running the same cert against a later revision; no regression (or absence of regression) is claimed.

Evidence:

- `datasets/experiments/wave-h/h17-envelope-cert-summary.json`

## Next-wave recommendations — ATTENTION

- Unblock "Coach/model disagreements" — this requires external input (coaches, devices, or users) that no engineering workstream can substitute.
- Unblock "Device-specific problems" — this requires external input (coaches, devices, or users) that no engineering workstream can substitute.
- Schedule recurring re-runs of the calibration, abstention, envelope, and latency instruments against each new revision so the next review can report real trends instead of single snapshots.
- Keep hard-slice mining in the next wave: hard-slice artifacts exist and represent known-underperforming slices.
- Ship the fresh-user evaluation-telemetry loop to real consenting users so drift and complaint sections stop being NO_DATA.

Evidence:

- `datasets/coach-review/agreement/agreement-report.json`
- `datasets/experiments/wave-g2/h06-device-harness-summary.json`

