# DATA_CARD — yt-o_NeuHjTEVE (schema data-card-v1)

Per-clip card produced by wave-f/f11-e22-intake (2026-08-29) following the
`data-card-v1` schema used by `datasets/pickleball/DATA_CARD.md`.

## Identity

- Clip id: `yt-o_NeuHjTEVE`
- Path: `datasets/pickleball/dev-pool/yt-o_NeuHjTEVE.mp4`
- Title: Pickleball Doubles Mixed 3.5 to 4.5 in Melbourne, FL 06/04/2023 Game 1
- Uploader/publisher: BT Pickleball
- Source URL: https://www.youtube.com/watch?v=o_NeuHjTEVE
- Upload date: 2023-06-10

## Contents

- Media: video/mp4 (H.264, no audio)
- Segment: ~60s segment re-encoded (libx264) from the 846s source video
- Resolution/fps: 1920x1080@29.97
- Duration: 60.027 s · Bytes: 52,288,985
- Decoded frames (intake full-decode check): 1798
- Pickleball relevance: Outdoor mixed doubles 3.5-4.5 rec play in Florida, elevated behind-court fixed camera with on-screen score overlay, daylight hard court

## Provenance & rights

- License: CC BY 3.0 (YouTube page license field: "Creative Commons Attribution license (reuse allowed)")
- License verification: License field read directly from the YouTube watch page metadata on 2026-08-29 via yt-dlp page parse; YouTube's 'Creative Commons Attribution license (reuse allowed)' setting maps to CC BY 3.0 (https://support.google.com/youtube/answer/2797468). CC BY 3.0 permits commercial use with attribution.
- Provenance assessment: Uploader is a personal channel publishing self-recorded games from a fixed camera at the recorder's own venue; channel context is consistent with the uploader being the videographer and rights holder. Uploader authority is assessed from channel context, not independently confirmed by the rights holder — recorded as a residual caveat.
- Rights basis: CC BY 3.0 declared by the uploader on YouTube permits any use including commercial with attribution.
- Restrictions:
  - attribution to the uploader required on redistribution
  - uploader authority assessed from channel context, not independently confirmed

## Roles / splits

- Role: `dev_label_eligible` (assigned by f11 intake) — labels MAY be created
  (append-only, versioned taxonomy). Never usable as holdout/locked_test/shadow.
  Corpus registration and split assignment still require the acquisition front
  door (`lab:acquire`, D-025) with session-level grouping.
- Classification rationale: Standard target capture geometry (elevated behind-court fixed camera, 4K-source 1080p30, dense continuous doubles rallies with score overlay) — the exact envelope the dev pipeline needs new labels on (D-035: next contact tuning must come from NEW dev labels). Holdout retains two independent outdoor elevated behind-court sources (yt-tJuJ4MQdYy0, yt-I5wYCXCL4dY), so this assignment does not thin holdout coverage of the setting family.

## Lineage

- Acquired by: wave-e/e22-acquisition-wave2 on 2026-08-29
- Acquisition method: yt-dlp download of the CC BY source video (video stream only, no audio), 60s segment re-encode with ffmpeg (libx264 crf20)

## Integrity (f11 intake verification, 2026-08-29)

- sha256: `1bc758763707884b7ea380f973dc0fad1519f8cb7af507a9d6637e69274be969` — recomputed at intake, byte-match: PASS
- Byte count matches registry `clipBytes`: PASS
- Full-stream decode (`ffprobe -count_frames`): zero errors

## Caveats

- attribution to the uploader required on redistribution
- uploader authority assessed from channel context, not independently confirmed
