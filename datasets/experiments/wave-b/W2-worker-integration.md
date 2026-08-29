# W2 — Warm detector worker: protocol + integration sketch

**Status:** worker shipped and measured in `tools/paddle-lab/detect_paddle.py --serve`.
Integration below is a SKETCH for a later workstream — no TS/Swift was modified in W2.

## Why stdio JSONL (not a socket daemon)

- Child-process pipes are the lowest-friction pattern for both Node
  (`child_process.spawn` + readline) and Swift (`Process` + pipe): no socket
  file lifecycle, no stale-socket cleanup, no permissions, worker lifetime is
  tied to the parent (no orphan daemon holding MPS memory).
- One request at a time matches the pipeline's actual shape (one detect span
  per stroke) and keeps the worker trivially robust.

## Protocol (`paddle-serve-v1`, JSON Lines over stdio)

stdout carries protocol lines ONLY; all logs go to stderr.

```
startup   <- {"event":"ready","protocol":"paddle-serve-v1","modelLoadSec":0.737,"warmupSec":0.786,"device":"mps"}
detect    -> {"id":"r1","video":"/abs/clip.mp4","out":"/abs/paddle-dets.json",
              "startMs":1386,"endMs":3853,"stride":1,"floor":0.08,"roi":null,
              "decodeSize":null,"legacyDecode":false}
          <- {"id":"r1","ok":true,"out":"...","framesProcessed":74,"paddleDetections":2833,
              "extras":1686,"timing":{...same block as the artifact...},"requestWallSec":5.81}
ping      -> {"id":"p","op":"ping"}         <- {"id":"p","ok":true,"event":"pong"}
shutdown  -> {"id":"q","op":"shutdown"}     <- {"id":"q","ok":true,"event":"shutdown"} then exit 0
error     <- {"id":"r2","ok":false,"error":"..."}   (worker keeps serving; verified in serve-timings.json)
EOF on stdin -> clean exit.
```

Each detect request writes the exact same `paddle-dets.json` schema as one-shot
mode (verified bit-equal on rally2 + wm-volley-02), with `timing.modelLoadSec`
= 0.0 because the load was paid once at startup.

Measured (Mac, W2-runs/detector/serve-timings.json): startup→ready 5.5s
(python+torch import ~4s + model load 0.74s local-cache-first + warmup forward
0.79s), then 5.81s per 74-frame request (vs 26.8–30.4s per legacy one-shot
invocation, or 17.1s per fixed one-shot).

## analyzeVideo.ts (lab pipeline) — later workstream

- Spawn the worker immediately after CLI parse (`--paddle-worker` flag or env),
  BEFORE `swing-lab extract` runs: the ~5.5s startup overlaps the 4–6s pose
  extraction, so the worker is warm by the time the pre-pass produces
  `detectSpan`.
- In `runPaddleStage` (analyzeVideo.ts:803-919): instead of `execFileSync`,
  write one JSONL line `{id, video, out: detsPath, startMs: wantedStart,
  endMs: wantedEnd}` to the worker's stdin and await the matching-id response
  line; then read `detsPath` exactly as today (schema unchanged, so
  `buildPaddleTracks` and reuse checks need no changes).
- Fallback: worker missing/crashed (EOF, timeout, non-ok response) → current
  one-shot `execFileSync` path unchanged. `--reuse-extract` semantics untouched.
- Bench loops (multiple cases) amortize one worker across all cases: n×(import+
  load) → 1×.
- `ball_candidates.py` deserves the same treatment (~1s startup) — out of W2
  scope.

## Mobile (guided capture) — Wave B mapping

Per P-latency-plan §4: start warmup at T1 (camera open). The user's
tap-start-region → walk-out → lock flow is comfortably longer than the
measured 5.5s Mac warmup, so by swing time the detector is resident and each
stroke costs only the per-request time.

On-device Wave B will NOT run this python worker: the D-FINE proxy must become
a native (CoreML) model. What transfers is the *pattern*, now validated on Mac:
load-once + keep-resident + dummy-inference warmup at camera-open, serve
per-stroke windows from the resident model. The JSONL protocol is the
lab/desktop shape of that pattern (and is what a TS/Swift lab harness should
speak to this worker).

## Ops semantics

- Serial requests; the parent owns restart policy (respawn on EOF/`ok:false`
  storm; `ping` for liveness).
- Worker holds D-FINE resident on MPS (~model footprint) for its lifetime —
  intentional; kill it when the session ends (`shutdown` op or just close
  stdin).
- Requests for different videos/windows/strides/ROIs are all valid against the
  one resident model (verified: rally2 + volley served by one worker).
