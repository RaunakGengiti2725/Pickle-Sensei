# DATA_CARD — va-6N3Yc184a_c (schema data-card-v1)

Per-clip card produced by wave-f/f11-e22-intake (2026-08-29) following the
`data-card-v1` schema used by `datasets/pickleball/DATA_CARD.md`.

## Identity

- Clip id: `va-6N3Yc184a_c`
- Path: `datasets/pickleball/dev-pool/va-6N3Yc184a_c.mp4`
- Title: The Pickleball Experience | 2026 National Veterans Golden Age Games
- Uploader/publisher: U.S. Dept. of Veterans Affairs (official YouTube channel)
- Source URL: https://www.youtube.com/watch?v=6N3Yc184a_c
- Upload date: 2026-07-03

## Contents

- Media: video/mp4 (AV1, video stream only, no audio)
- Segment: full source video (video stream only, no audio downloaded)
- Resolution/fps: 1920x1080@29.97
- Duration: 171.67 s · Bytes: 37,467,057
- Decoded frames (intake full-decode check): 5145
- Pickleball relevance: Indoor convention-center pickleball at the National Veterans Golden Age Games: older-adult and wheelchair (adaptive) doubles rallies, interview segments; adaptive play and senior athletes extend corpus diversity

## Provenance & rights

- License: Public domain (PD-USGov, 17 U.S.C. §105) as a U.S. Department of Veterans Affairs production; YouTube page license field is the standard YouTube license (no CC declaration), so the PD basis is the federal-work doctrine, not the YouTube license field
- License verification: Works produced by U.S. federal government employees in the course of their duties are not subject to copyright (17 U.S.C. §105). The videos are published on the U.S. Department of Veterans Affairs' official YouTube channel and are VA productions covering VA's own National Veterans Golden Age Games. YouTube license field read via yt-dlp on 2026-08-29 (standard license). Full-duration frame screening on 2026-08-29 (dense contact sheet) shows only VA/Golden Age Games branding and event graphics, with no third-party agency watermarks or embedded broadcast footage.
- Provenance assessment: Published on the verified official VA YouTube channel; content is VA's own adaptive-sports event (National Veterans Golden Age Games) with VA-branded graphics and interview lower-thirds, consistent with in-house VA production. Residual caveat: per-video confirmation that no contractor-produced (copyrightable) footage is included was not obtainable; assessed from channel authority and frame screening.
- Rights basis: Public domain as a U.S. federal government work (17 U.S.C. §105); courtesy credit to the U.S. Department of Veterans Affairs recorded.
- Restrictions:
  - courtesy credit to the U.S. Department of Veterans Affairs; no implied VA endorsement
  - PD-USGov basis assessed from official-channel provenance and frame screening, not confirmed per-video in writing by VA
  - on-screen persons include identified veterans (event participants); publicity/persona rights for non-news commercial contexts remain a separate consideration

## Roles / splits

- Role: `dev_label_eligible` (assigned by f11 intake) — labels MAY be created
  (append-only, versioned taxonomy). Never usable as holdout/locked_test/shadow.
  Corpus registration and split assignment still require the acquisition front
  door (`lab:acquire`, D-025) with session-level grouping.
- Classification rationale: Strongest rights basis in the cohort (PD-USGov federal work, no attribution dependency). Adaptive/wheelchair and senior-athlete play is unrepresented in the labeled dev corpus, so labels here extend dev diversity the most. Adaptive-play representation remains in the holdout pool via va-O1dLhGGPErc (2025 Games — a separate event year/session).

## Lineage

- Acquired by: wave-e/e22-acquisition-wave2 on 2026-08-29
- Acquisition method: yt-dlp download of the video stream only (no audio track downloaded, avoiding any potentially licensed music) from the official VA YouTube channel

## Integrity (f11 intake verification, 2026-08-29)

- sha256: `9f0505e916df3ece1a703b431f535fa97580a2e19b7c01730e5864fb5543d9df` — recomputed at intake, byte-match: PASS
- Byte count matches registry `clipBytes`: PASS
- Full-stream decode (`ffprobe -count_frames`): zero errors
- Quarantine resolution: quarantinedUnknownRights entry yt-6N3Yc184a_c carries a resolvedBy pointer to this clip's e22 acceptance

## Caveats

- courtesy credit to the U.S. Department of Veterans Affairs; no implied VA endorsement
- PD-USGov basis assessed from official-channel provenance and frame screening, not confirmed per-video in writing by VA
- on-screen persons include identified veterans (event participants); publicity/persona rights for non-news commercial contexts remain a separate consideration
