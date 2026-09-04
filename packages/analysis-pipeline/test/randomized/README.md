# randomized-pipeline-D — seeded randomized tests (seeds 4000–4099)

Adversarial, replayable property tests over the analysis pipeline's
segmentation / classification / fusion / streaming surfaces, driven by the
committed deterministic synthetic generator (`@pickle/evaluation`
`generateSwingSequence`). Linux replay evidence only — nothing here is Apple
Vision / iOS runtime truth.

## Files

- `harness.ts` — seeded RNG (Mulberry32 + Box–Muller), per-seed scenario
  (handedness, 30/60 fps, body/contact/timing), coupled and position-only
  noise ladders (common random numbers so ladder rungs share one perturbation
  realisation), landmark dropout, frame dropout, monotone timing jitter,
  adjacent-swap frame reordering, and thin runners for
  `GeometricPhaseSegmenter`, `classifyStroke`, `analyzeCapture`
  (declared + AUTO) and `SessionEventEngine` (batching / shuffle / jitter /
  late delivery).
- `randomizedPipelineD.test.ts` — the property suite. Hard properties are
  plain `it(...)`. Properties the baseline (4d812e1a) does NOT satisfy are
  pinned as `it.fails(...)` with a `[FINDING D-n]` tag: they stay red-as-
  documented, and the suite fails loudly the day production starts satisfying
  them (remove the marker then).
- `replay.test.ts` — replay one row and dump the exact generated input and
  every surface's output.

## Run

```bash
# whole suite; RANDOMIZED_D_OUT writes the raw JSON tables / matrices / heap numbers
RANDOMIZED_D_OUT=/tmp/randomized-D pnpm --filter @pickle/analysis-pipeline exec vitest run test/randomized

# replay one finding row: <seed>:<perturbation>[:<param>]
#   clean | ladder:<0-5> | position:<0-5> | dropout:<p> | jitter:<frameFraction> | reorder:<swaps>
RANDOMIZED_D_REPLAY=4056:dropout:0.5 RANDOMIZED_D_OUT=/tmp/randomized-D \
  pnpm --filter @pickle/analysis-pipeline exec vitest run test/randomized/replay
```

## Properties

| id  | property                                                                                                                                                                                  | status on 4d812e1a        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| D1  | same seed ⇒ byte-identical outputs on all four surfaces (1200 double runs)                                                                                                                | holds                     |
| D2  | confidence never increases along the coupled noise ladder; no label/result appears on noisier input                                                                                       | fails — FINDING D-2       |
| D2b | same under position-only noise; no mirrored side label                                                                                                                                    | fails — FINDING D-1 / D-3 |
| D3  | abstention rate is 0 on clean input and non-decreasing along the ladder                                                                                                                   | holds                     |
| D4  | no fabricated label on the coupled ladder (declared stroke never rewritten; AUTO never scores an unresolved disagreement)                                                                 | holds                     |
| D5  | sub-frame monotone timing jitter never flips label / contact > 1.5 frames / score > 0.5                                                                                                   | fails — FINDING D-4       |
| D6  | frame dropout p ∈ {0.1, 0.3, 0.5}: typed outcomes only, ordered phases, valid ranges                                                                                                      | holds                     |
| D6  | frame dropout never yields a mirrored (BACKHAND) label on the forehand fixture                                                                                                            | fails — FINDING D-3       |
| D7  | reordered (non-monotonic) frames: no crash, no mirrored label, exactly N inversions                                                                                                       | holds                     |
| D7  | non-monotonic input is rejected with a typed failure or yields the sorted result                                                                                                          | fails — FINDING D-5       |
| D8  | `SessionEventEngine`: one-by-one == random batches == intra-batch shuffle == whole stream; late-sample drop count matches the frontier contract exactly; `closedAtMs ≤ endMs + safetyMax` | holds                     |
