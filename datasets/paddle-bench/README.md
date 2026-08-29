# paddle-bench — real-video corpus for paddle perception

Drop real pickleball videos into `videos/` and register them in
`registry.json`. Everything here must be REAL footage with recorded
provenance/licensing — synthetic or animated clips are not allowed in this
directory (use the synthetic benchmark path instead).

## Ingestion workflow

1. Copy the video into `videos/` (mp4/mov; H.264 preferred — AVFoundation
   must be able to read it; transcode WebM etc. via
   `ffmpeg -i in.webm -c:v libx264 -crf 18 -an out.mp4`).
2. Add an entry to `registry.json` with source, license, and description.
3. Run the pipeline: `pnpm lab:analyze datasets/paddle-bench/videos/<file> --overlay`
4. Label paddle ground truth: `pnpm lab:annotate datasets/paddle-bench/bundles`
   (bundles are created per stroke; see PERCEPTION.md §5).
5. Score detection/tracking against labels: `pnpm lab:paddle-bench`

`videos/` contents are gitignored (media stays local); `registry.json` and
annotations are committed.

## Current known gaps (missing benchmark coverage)

Recorded honestly; do not claim coverage that does not exist:

- side-view single-player strokes (current footage is rear tournament view)
- left-handed players confirmed on camera-near side
- bright/white paddles (current visible paddles are dark)
- indoor lighting
- close-range framing where the paddle is large in frame
- deliberate motion-blur / low-light stress cases
