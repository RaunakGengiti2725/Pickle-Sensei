# DATA_CARD — va-O1dLhGGPErc (schema data-card-v1)

Per-clip card produced by wave-f/f11-e22-intake (2026-08-29) following the
`data-card-v1` schema used by `datasets/pickleball/DATA_CARD.md`.

## Identity

- Clip id: `va-O1dLhGGPErc`
- Path: `datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4`
- Title: 2025 National Veterans Golden Age Games - Day 4 Highlights
- Uploader/publisher: U.S. Dept. of Veterans Affairs (official YouTube channel)
- Source URL: https://www.youtube.com/watch?v=O1dLhGGPErc
- Upload date: 2025-06-05

## Contents

- Media: video/mp4 (AV1, video stream only, no audio)
- Segment: full source video (video stream only, no audio downloaded)
- Resolution/fps: 608x1080@24.0
- Duration: 60.88 s · Bytes: 7,108,712
- Decoded frames (intake full-decode check): 1461
- Pickleball relevance: Vertical multi-sport Golden Age Games highlights including indoor pickleball segments (older-adult doubles, couple play); heavy stylized graphic overlays — perception value modest, registered honestly as low-density supplemental footage

## Provenance & rights

- License: Public domain (PD-USGov, 17 U.S.C. §105) as a U.S. Department of Veterans Affairs production; YouTube page license field is the standard YouTube license (no CC declaration), so the PD basis is the federal-work doctrine, not the YouTube license field
- License verification: Works produced by U.S. federal government employees in the course of their duties are not subject to copyright (17 U.S.C. §105). The videos are published on the U.S. Department of Veterans Affairs' official YouTube channel and are VA productions covering VA's own National Veterans Golden Age Games. YouTube license field read via yt-dlp on 2026-08-29 (standard license). Full-duration frame screening on 2026-08-29 (dense contact sheet) shows only VA/Golden Age Games branding and event graphics, with no third-party agency watermarks or embedded broadcast footage.
- Provenance assessment: Published on the verified official VA YouTube channel; content is VA's own adaptive-sports event (National Veterans Golden Age Games) with VA-branded graphics and interview lower-thirds, consistent with in-house VA production. Residual caveat: per-video confirmation that no contractor-produced (copyrightable) footage is included was not obtainable; assessed from channel authority and frame screening.
- Rights basis: Public domain as a U.S. federal government work (17 U.S.C. §105); courtesy credit to the U.S. Department of Veterans Affairs recorded.
- Restrictions:
  - courtesy credit to the U.S. Department of Veterans Affairs; no implied VA endorsement
  - PD-USGov basis assessed from official-channel provenance and frame screening, not confirmed per-video in writing by VA
  - on-screen persons include identified veterans (event participants); publicity/persona rights for non-news commercial contexts remain a separate consideration
  - vertical 608x1080 format with persistent stylized graphic overlays; gameplay density is low

## Roles / splits

- Role: `fresh_holdout_candidate` (`fresh_candidate`, labelBlind: true) — NO
  labels of any kind exist or may be created before a future acquisition freeze.
- Classification rationale: Vertical 608x1080@24 low-gameplay-density footage with persistent stylized overlays — an OOD-leaning capture envelope worth keeping unseen; low dev-label utility in any case.

## Lineage

- Acquired by: wave-e/e22-acquisition-wave2 on 2026-08-29
- Acquisition method: yt-dlp download of the video stream only (no audio track downloaded, avoiding any potentially licensed music) from the official VA YouTube channel

## Integrity (f11 intake verification, 2026-08-29)

- sha256: `a4443e85b6d8ee2cd7af4ef51d9ebdabf7be4b7ad80ed36f5d77b029735838a2` — recomputed at intake, byte-match: PASS
- Byte count matches registry `clipBytes`: PASS
- Full-stream decode (`ffprobe -count_frames`): zero errors
- Quarantine resolution: quarantinedUnknownRights entry yt-O1dLhGGPErc carries a resolvedBy pointer to this clip's e22 acceptance

## Caveats

- courtesy credit to the U.S. Department of Veterans Affairs; no implied VA endorsement
- PD-USGov basis assessed from official-channel provenance and frame screening, not confirmed per-video in writing by VA
- on-screen persons include identified veterans (event participants); publicity/persona rights for non-news commercial contexts remain a separate consideration
- vertical 608x1080 format with persistent stylized graphic overlays; gameplay density is low
- Label-blind: this card is built solely from registry metadata and mechanical
  integrity checks; no content review beyond e22's disclosed frame screening.
