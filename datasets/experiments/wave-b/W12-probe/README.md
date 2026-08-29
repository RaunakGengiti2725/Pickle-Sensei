# W12 probe — edge-on / motion-blur paddle recovery study (wave-b)

Tool: `tools/paddle-lab/edge_on_probe.py` (W12-owned; imports read-only helpers
from the busy `detect_paddle.py`, duplicates only its inline model-load/infer).

Pipeline (all artifacts in this directory):

1. `extract` -> `frames/` (33 PNGs) + `frames-manifest.json`
   - rally2 (DEV): missA i75-81 (2502-2703ms), missB i87-93 (2903-3103ms),
     controls i62/64/65/66/68/69 (pre-stroke, paddle detected today)
   - wm-dink-01 (HELD-OUT): i42-54 (1680-2160ms) — DIAGNOSTIC ONLY
2. `grid` / `zoom` -> `grids/` — pixel-grid renders used for the eyeball pass
3. visual truth -> `visual-truth.json` (annotator `devin-visual-v2-wave-b`);
   3 window-B frames marked `uncertain` and excluded from denominators;
   distractor boxes (other-player paddles, balls, static hardware) included
4. `detect` -> `probe-dets.json` — baseline full-frame + wrist crops
   (256/448/704, both wrists) + TTA, one 0.03-floor pass; ALL kind=DETECTED
5. `propagate` -> `probe-propagation.json` — hold/interp/wrist-anchored gap
   fills; ALL kind=TRACKED_ESTIMATE (never counted as detections)
6. `truthviz` -> `truthviz/` — truth/distractor/baseline overlays
7. `score` -> `strategy-report.json` — recovery @IoU .30/.10, mean IoU,
   false boxes (region + within 150px of wrist), wrongInstance split,
   annotation-point hits, per-frame rows at floor .08, runtime table

Headline (rally2 dev, floor .08, IoU>=.30): baseline 4/7 missA & 1/4 missB ->
cropMULTI both-wrists 5/7 & 3/4 (11/11 @IoU>=.10). TTA rejected. Propagation
bridges missA only (upper bound) and fails the edge-on carry.

Key caveat measured en route: canonical run dets / review stills are ONE FRAME
(~33ms) EARLY vs absolute CFR indexing (ffmpeg -ss 502ms seek); see
`visual-truth.json.timestampCaveat`.

Discipline: wm-dink-01 is held_out — its rows are quarantined as diagnostic;
every threshold/strategy choice is justified on rally2 evidence alone.

Final deliverable: `../W12-summary.json`.
