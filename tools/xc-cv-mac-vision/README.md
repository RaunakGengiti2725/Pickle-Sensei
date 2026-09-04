# xc-cv-mac-vision — Apple Vision vs Linux replay-proxy pose comparison

Read-only inspection of the Apple pose evidence a `mac-full-verify` run leaves
behind (`swing-lab-extract/pose.json`, `people.json`, `extract-meta.json`, the
`.xcresult` bundles) and a like-for-like comparison against the Linux MediaPipe
replay PROXY on the same clip. It never triggers a Mac run and never claims
Apple runtime behaviour from Linux: the Apple side is only ever read from an
artifact the physical M4 runner produced.

Files:

- `compare_pose_planes.py` — per-plane statistics (pose count, confidence
  distribution + histogram, first/last timestamp, effective/implied/declared fps,
  cadence + gaps, frame-index semantics, per-joint visibility, zeroed landmarks,
  core-joint full-body fraction, people-per-frame) and a source-frame-grid
  alignment (both / apple-only / linux-only / neither matrix, per-joint position
  deltas, visibility agreement, torso-mid agreement). Writes `comparison.json` +
  `comparison.md`; prints divergence flags. Exit 0 = ran, 2 = bad/missing input.
- `xcresult_sqlite_summary.py` — reads `database.sqlite3` inside `.xcresult`
  bundles on Linux (no `xcrun`): devices, SDKs, actions, per-test result and
  duration. Exit 1 on any non-`Success` run, 2 when a bundle has no test tables
  (build-only bundles are reported as UNREADABLE, never as a pass).
- `run_replay_compare.sh` — end-to-end reproduction: ffprobe both files, OpenCV
  decode probe, frame-exact lossless H.264 re-mux (OpenCV cannot decode the AV1
  clip), Linux MediaPipe extraction, `analyze:video --reuse-extract` on BOTH
  planes' artifacts through the same TypeScript pipeline, then the comparison
  and xcresult summaries. Every stage writes a log under `--out`.
- `test_compare_pose_planes.py` — synthetic-fixture unit tests for both scripts.

## Run

```bash
gh run download 33829297073 -D /path/to/mac-artifacts        # or the baseline run once complete
python3 -m unittest discover -s tools/xc-cv-mac-vision -p 'test_*.py'
tools/xc-cv-mac-vision/run_replay_compare.sh \
  --apple-extract /path/to/mac-artifacts/mac-full-verify-2/swing-lab-extract \
  --clip datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4 \
  --out /tmp/xc-cv \
  --python ~/.venv-pose/bin/python --model ~/pose_landmarker_full.task \
  --xcresult /path/to/mac-artifacts/mac-full-verify-2/vision-core-macos.xcresult \
  --xcresult /path/to/mac-artifacts/mac-full-verify-2/vision-core-ios-simulator.xcresult
```

Linux prerequisites: ffmpeg/ffprobe, `pip install mediapipe opencv-python-headless numpy`
in a venv, the MediaPipe `pose_landmarker_full.task` model, pnpm workspace installed.

## Result on the prior-green Mac run (2026-09-04)

Apple artifact: run `33829297073` (SHA `4e4ae958`, prior green — the baseline run
`33841813597` on `4d812e1a` was still `queued`). Clip `va-O1dLhGGPErc` (AV1,
608x1080, 24 fps, 1461 frames, 60.875 s). Full raw tables live in the session
attachments (`comparison.json`, `comparison.md`, logs).

| metric                                    | Apple Vision (M4)              | Linux MediaPipe proxy         |
| ----------------------------------------- | ------------------------------ | ----------------------------- |
| pose frames                               | 1286 (175 misses / 1461)       | 1249                          |
| declared `video.fps` / implied from Δt    | **12 / 23.81**                 | 24 / 24.00                    |
| `extract-meta` durationMs vs source       | **121750 vs 60875**            | 60875                         |
| frame conf mean / p50                     | 0.49 / 0.52                    | 0.76 / 0.75 (different model) |
| full-body fraction (10 core joints v≥0.3) | 0.20                           | 0.35                          |
| people per frame (mean / max)             | 2.10 / 5                       | 1.02 / 3                      |
| `i` semantics                             | dense pose-hit counter 0..1285 | source frame index            |
| source-grid matrix both/apple/linux/none  | 1235 / 51 / 14 / 161           |                               |
| torso-mid within 0.10 on shared frames    | 0.62                           |                               |
| downstream verdict (same TS pipeline)     | not_analyzable                 | not_analyzable                |
| player target / candidates / loss periods | P53 / 53 / 0                   | P47 / 27 / 2                  |
| contact                                   | estimated 33595 ms (0.55)      | abstained (multimodal)        |

Divergences worth acting on are in the session findings: the Apple extractor
writes `video.fps = nominalFrameRate` (12 here, half the real cadence) so the
player tracker's loss-period threshold doubles (re-running the same Apple
artifact with `fps: 24` flips `loss periods 0 → 1` and raises
`TARGET_PLAYER_LOST`); the Linux extractor exits 0 with zero frames on AV1
input; the Linux proxy sees one person per frame where Apple Vision sees two.
