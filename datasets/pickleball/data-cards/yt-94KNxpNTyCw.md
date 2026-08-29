# DATA_CARD — yt-94KNxpNTyCw (schema data-card-v1)

Per-clip card produced by wave-f/f11-e22-intake (2026-08-29) following the
`data-card-v1` schema used by `datasets/pickleball/DATA_CARD.md`.

## Identity

- Clip id: `yt-94KNxpNTyCw`
- Path: `datasets/pickleball/dev-pool/yt-94KNxpNTyCw.mp4`
- Title: WORST FOOT FAULT EVER!!! Game 9 Indoor REC
- Uploader/publisher: MR. PICKLEBALL
- Source URL: https://www.youtube.com/watch?v=94KNxpNTyCw
- Upload date: 2025-09-13

## Contents

- Media: video/mp4 (H.264, no audio)
- Segment: ~60s segment re-encoded (libx264) from the 1221s source video
- Resolution/fps: 1920x1080@30.0
- Duration: 60.0 s · Bytes: 17,503,619
- Decoded frames (intake full-decode check): 1800
- Pickleball relevance: Indoor rec doubles with score overlay; casual rec players of varied body types

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
- Classification rationale: Indoor rec doubles, 1080p30, gameplay-dense with score overlay and varied body types — high dev-label utility. Holdout retains five independent indoor sources (yt-iuVdtmGoTbo, yt-eK-iPN2XAJQ, voa-6108955, voa-6115790, yt-n-QrBfQVK_w).

## Lineage

- Acquired by: wave-e/e22-acquisition-wave2 on 2026-08-29
- Acquisition method: yt-dlp download of the CC BY source video (video stream only, no audio), 60s segment re-encode with ffmpeg (libx264 crf20)

## Integrity (f11 intake verification, 2026-08-29)

- sha256: `9ab0964d6ee3625fa11ddbe06c636271f209732c100e44fd2e20478ebf74d2c6` — recomputed at intake, byte-match: PASS
- Byte count matches registry `clipBytes`: PASS
- Full-stream decode (`ffprobe -count_frames`): zero errors

## Caveats

- attribution to the uploader required on redistribution
- uploader authority assessed from channel context, not independently confirmed
