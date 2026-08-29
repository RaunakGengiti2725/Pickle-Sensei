# DATA_CARD — datasets/ood (schema data-card-v1)

## Identity

- Dataset: OOD negative clips (rights-cleared real footage with no pickleball
  stroke by a target athlete), used only to measure the pre-analysis OOD gate
- Path: `datasets/ood/`
- Registry schemaVersion: 1 · addedAt: 2026-08-29 · workstream: wave-d/d08-ood-corpus
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `registry.json`: 9 items (`role: ood_negative`) · 3 quarantined unknown-rights
  candidates (`quarantined_not_committed`, never committed) · 4 search-log entries
- `negatives/`: 9 mp4 clips, 72,845,522 bytes total (matches registered
  `totalBytes` exactly); on-disk filenames reconcile 1:1 with registered paths

## Provenance & rights

- Per-item fields follow the `datasets/pickleball/registry.json`
  freshCandidates (wave-c/c16) conventions: verbatim license quote,
  `licenseVerification` method, `provenanceAssessment`, structured `rights`
  block, and `restrictions`.
- Sources: YouTube CC BY 3.0 uploads, Wikimedia Commons, and Internet Archive
  items; uploader authority is a channel/context assessment recorded as a
  residual restriction, not rights-holder confirmation.
- Quarantined candidates carry untrusted CC declarations (broadcast re-uploads)
  and were never downloaded into the dataset.

## Roles / splits

- Every item: `role: ood_negative` — eval-only negatives for the OOD gate;
  not part of corpus splits or training data.

## Lineage

- Each item records source URL, segment window, re-encode method, sha256, byte
  count, and a `contentVerification` note from visual inspection at acquisition.

## Integrity (d2-09 audit, 2026-08-29)

- sha256 and byte counts of all 9 clips verified against on-disk media: 9/9 match.
- URL probe: 12/12 registry URLs (9 items + 3 quarantined) returned HTTP 2xx.
- No missing provenance fields; no count drift found in this registry.

## Caveats

- Uploader authority for CC-declared YouTube items is assessed, not
  rights-holder-confirmed.
- `contentVerification` notes are acquisition-time observations by the d08
  workstream; this audit re-verified hashes/bytes only, not frame content.

## Wave-E expansion (e11-ood-expansion, 2026-08-29)

- Added 2 real negatives (`items`): squash (`yt-x8T5I4YAKNw-squash`, CC BY 3.0,
  1280x720@29.97, 30s) and racquetball (`yt-EckAW5V1wv0-racquetball`, CC BY 3.0,
  1920x1080@59.94, 30s). Both visually verified at acquisition; sha256/bytes in
  the registry. Corpus is now 11 real negatives.
- Added a `derivedItems` section: 9 derived/synthetic probes under
  `datasets/ood/derived/` (still image, still-image-as-video, synthetic
  graphics x2, extreme aspect ratios x2, truncated media, byte-corrupted media,
  random bytes). These are clearly labeled synthetic/derived
  (`role: ood_negative_derived`) and are never real-world observations; the
  truncated/corrupt probes derive from a CC BY source with lineage recorded.
- Gate measurement artifacts:
  `datasets/experiments/wave-e/e11-ood-gate-measurements.json` and
  `datasets/experiments/wave-e/e11-ood-expansion-summary.json`.
- Caveat unchanged: pose-conditioned checks unavailable on Linux (Apple Vision
  is macOS-only); pose-free pass-through of real racket-sport footage and
  animated graphics is a documented finding, not evidence of valid input.
