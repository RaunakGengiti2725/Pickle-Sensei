# @pickle/latency-slo

Latency SLO measurement and regression alerting for the primary product
metric **MOVEMENT_COMPLETION -> RESULT_INTERACTIVE**.

## What this is

- `pickle.latency-slo-record.v1` — one raw latency sample with a full slice
  (device, OS, stroke, model version, capture condition, cold/warm) and a
  mandatory provenance (`LINUX_BENCH_NOT_DEVICE` | `DEVICE_MEASUREMENT`).
- `pickle.latency-slo-report.v1` — nearest-rank P50/P75/P90/P95 summaries
  overall and per (dimension, value, phase) slice, each judged against the
  frozen thresholds.
- `latency-slo-thresholds-v1` (frozen 2026-08-29): ideal <= 2000 ms,
  strong <= 3000 ms, max <= 5000 ms, judged at p95 — identical numbers to
  GATE B `iphone-latency-targets-v1`, so device evidence and Linux trend
  tracking share one bar.
- `latency-slo-regression-alerts-v1` (frozen): a p95 regression alerts only
  when it exceeds BOTH +200 ms AND +10 %; any tier degradation alerts; any
  slice above the frozen max alerts; disappeared slices alert; slices with
  fewer than 5 samples downgrade to WARNING (small-n percentiles must not
  page anyone, but are never hidden).

## Honesty rules

- Every record from the Linux benchmark harness (`tools/latency-bench`,
  bench_e2e.py) is labeled `LINUX_BENCH_NOT_DEVICE` and every report built
  from such records carries a non-removable disclaimer plus
  `deviceEvidence: BLOCKED_EXTERNAL_NO_DEVICE_MEASUREMENTS`. These numbers
  are Linux-CPU analysis-stage trend data — never iPhone evidence and never
  GATE B input. Real device evidence comes only from `tools/iphone-trials`
  (still BLOCKED_EXTERNAL: no physical devices).
- Unknown slice values are labeled honestly (`UNLABELED_CLIP`,
  `UNLABELED_COMMITTED_DEV_CLIP`), never guessed.
- Crashed benchmark runs (non-zero exit) are excluded — their wall time
  measures a crash, not the SLO. Completed-but-abstained runs count: an
  abstention is still a user-visible result.
- Threshold and alert-config numbers change only by re-versioning with a
  decision-log entry — never edit v1 in place.

## Usage

```sh
# Build a sliced SLO report from the committed Linux bench artifact
pnpm --filter @pickle/latency-slo slo report \
  --bench ../latency-bench/artifacts/bench-results.json \
  --out /tmp/slo-report.json

# Compare against a frozen baseline report; exits 1 on any ALERT
pnpm --filter @pickle/latency-slo slo compare \
  --baseline baseline-report.json --current /tmp/slo-report.json
```
