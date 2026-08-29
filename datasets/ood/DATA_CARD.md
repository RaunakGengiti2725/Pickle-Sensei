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
