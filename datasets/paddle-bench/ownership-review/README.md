# ownership-review — paddle ownership label registry

`ownership-review.json` is the append-only sidecar of per-frame ownership
verdicts (target / other / reject / ambiguous). Coordinates live in the bundle
annotation files (`bundles/<case>/annotation/<annotatorId>.json`,
`paddleFrames` / `otherPaddleFrames`); the sidecar preserves verdicts, box
provenance, wrist-proximity and uncertainty notes. Never overwrite or delete
entries — append with a new `annotator` id.

## Counts (recomputed from committed files, not estimated)

Same-timestamp dual frames = frames with >=1 visible `target` point AND >=1
visible `other` point at the same tMs, aggregated across all annotator files
per bundle.

| metric | pre-waveC | post-waveC |
| --- | --- | --- |
| sidecar verdict entries | 70 | 100 |
| same-timestamp target+other dual frames | 30 | 50 |
| visible target points (annotation files) | 65 | 85 |
| visible other points (annotation files) | 81 | 140 |

(STATUS_BOARD's "78 target / 83 other boxes" uses a different counting than
either row above — do not conflate the denominators. Sidecar per-box verdicts:
pre-waveC target 38 / other 79 / reject 80 / ambiguous 14; waveC adds target 24
(20 visible + 4 occluded) / other 59 / ambiguous 6.)

waveC contribution (`annotator: devin-visual-v2-waveC`, 2026-08-29): 30
multi-paddle frames (each with >=2 paddle boxes judged) across 6 bundles —
wavea-944403-dink 12, wavea-944403-smash 4, wavea-faead-rally 5,
wavea-marne-dig 5, wavea-faead-feed 2, afn-sasebo-rally1 2. Box tally: 20
visible target, 59 visible other, 6 ambiguous (sidecar-only, with uncertainty
notes), 4 occluded-target (`visibility: "occluded"`, no point). 20 of the 30
frames are new strict target+other duals (30 -> 50); the other 10 have the
target occluded/uncertain plus >=2 other/ambiguous paddles (honest occlusion,
not interpolated). Every point was read off an extracted absolute-CFR frame
(ffmpeg `select=eq(n\,IDX)` on hash-verified corpus sources / the committed
sasebo clip); nothing was interpolated. Hard slices included: edge-on blades,
dark-on-dark low contrast, motion blur, net-post occlusion.

Per-bundle dual-frame counts (pre -> post): afn-sasebo-rally1 11 -> 13,
afn-sasebo-rally2 1, afn-vic-rally1 5, wm-dink-01 7, wm-volley-02 6,
wavea-944403-dink 0 -> 11, wavea-944403-smash 0 -> 3, wavea-faead-feed 0 -> 2,
wavea-faead-rally 0 -> 1, wavea-marne-dig 0 -> 1.

Held-out cases (wm-dink-01, afn-vic-rally1) received no new labels.
