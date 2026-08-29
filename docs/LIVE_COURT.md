# LIVE COURT

Live Court is the intended near-screenless coaching loop: the player hits, a validated model recognizes each repetition, a trustworthy score is produced, and the coach gives one concise cue. It is **not currently available** because the learned pickleball recognition and scoring models do not yet exist at release quality.

## Implemented building blocks

| Piece                        | Current state                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Native iOS capture           | AVFoundation capture, rolling pre/post buffer, Apple Vision live body pose, measured joint-motion overlay, automatic motion trigger |
| Native Android capture       | CameraX capture, bundled MediaPipe body pose, measured joint-motion overlay, automatic motion trigger                               |
| Short-clip result            | Private clip plus `unknown`/`awaiting_model`; no invented recognition or score                                                      |
| Cue engine                   | Deterministic correction/improvement/repeat/stable/silence policy, tested with test-only inputs                                     |
| Native speech                | iOS text-to-speech binding implemented                                                                                              |
| Session and sync foundations | Owner-scoped local persistence, permit-bound outbox, canonical server acknowledgement                                               |

## Missing release-critical pieces

- A validated temporal pickleball stroke classifier with measured recall and false-trigger performance.
- Paddle tracking, phase segmentation, trustworthy feature extraction, and coach-calibrated scoring.
- Representative physical-device thermal, latency, lifecycle, and camera-placement validation.
- Reviewed drills and rights-cleared instructional media connected to verified diagnoses.

Until those pieces pass their gates, the product must not synthesize repetitions on a timer, feed deterministic test data into the UI, announce scores, claim progress, or consume a free rating.

## Intended validated loop

```
continuous native capture → validated repetition event → retain pre/post window
→ pose + paddle (+ optional calibrated ball) → phases → mechanics + confidence
→ score or explicit abstention → one cue → owner-scoped persistence → canonical sync
```

Core coaching remains designed for zero network dependency. A future score is accepted only with its complete model/config version vector and sufficient confidence. The server consumes one of the two free ratings only when that successful result is atomically accepted.

## Measurement gates

The planned performance gates remain: supported-setup stroke recall above 95%, false strokes below 1 per 10 minutes, first-score p50 below 1.5 seconds / p95 below 2.5 seconds, cue below 3 seconds, 30-minute thermal pass, and crash-free sessions above 99.5%. These are targets, not achieved measurements. No benchmark is reported until it is measured on the released model and representative devices.
