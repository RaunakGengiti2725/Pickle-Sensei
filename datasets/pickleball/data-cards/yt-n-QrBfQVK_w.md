# DATA_CARD — yt-n-QrBfQVK_w (schema data-card-v1)

Per-clip card produced by wave-f/f11-e22-intake (2026-08-29) following the
`data-card-v1` schema used by `datasets/pickleball/DATA_CARD.md`.

## Identity

- Clip id: `yt-n-QrBfQVK_w`
- Path: `datasets/pickleball/fresh-candidates/yt-n-QrBfQVK_w.mp4`
- Title: Thirstday Pickleball | MIXED DOUBLES FIGHT! | Dave/Eunice vs WeiCong/Jiawei
- Uploader/publisher: Vernonchan.com
- Source URL: https://www.youtube.com/watch?v=n-QrBfQVK_w
- Upload date: 2025-08-01

## Contents

- Media: video/mp4 (H.264, no audio)
- Segment: ~60s segment re-encoded (libx264) from the 242s source video
- Resolution/fps: 1920x1080@30.0
- Duration: 60.0 s · Bytes: 23,545,444
- Decoded frames (intake full-decode check): 1800
- Pickleball relevance: Indoor commercial pickleball venue, fixed camera, mixed doubles social play; venue signage and hall lighting distinct from existing footage

## Provenance & rights

- License: CC BY 3.0 (YouTube page license field: "Creative Commons Attribution license (reuse allowed)")
- License verification: License field read directly from the YouTube watch page metadata on 2026-08-29 via yt-dlp page parse; YouTube's 'Creative Commons Attribution license (reuse allowed)' setting maps to CC BY 3.0 (https://support.google.com/youtube/answer/2797468). CC BY 3.0 permits commercial use with attribution.
- Provenance assessment: Uploader is a personal channel publishing self-recorded games from a fixed camera at the recorder's own venue; channel context is consistent with the uploader being the videographer and rights holder. Uploader authority is assessed from channel context, not independently confirmed by the rights holder — recorded as a residual caveat.
- Rights basis: CC BY 3.0 declared by the uploader on YouTube permits any use including commercial with attribution.
- Restrictions:
  - attribution to the uploader required on redistribution
  - uploader authority assessed from channel context, not independently confirmed

## Roles / splits

- Role: `fresh_holdout_candidate` (`fresh_candidate`, labelBlind: true) — NO
  labels of any kind exist or may be created before a future acquisition freeze.
- Classification rationale: Only commercial indoor-venue setting (distinct signage/hall lighting) in either pool — highest marginal holdout diversity; kept unseen.

## Lineage

- Acquired by: wave-e/e22-acquisition-wave2 on 2026-08-29
- Acquisition method: yt-dlp download of the CC BY source video (video stream only, no audio), 60s segment re-encode with ffmpeg (libx264 crf20)

## Integrity (f11 intake verification, 2026-08-29)

- sha256: `e11d1508a07fc8e6ff21e581e750fd973deab9c73b05e5ca967159db51b9e443` — recomputed at intake, byte-match: PASS
- Byte count matches registry `clipBytes`: PASS
- Full-stream decode (`ffprobe -count_frames`): zero errors

## Caveats

- attribution to the uploader required on redistribution
- uploader authority assessed from channel context, not independently confirmed
- Label-blind: this card is built solely from registry metadata and mechanical
  integrity checks; no content review beyond e22's disclosed frame screening.
