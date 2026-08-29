# DATA_CARD — datasets/pickleball (schema data-card-v1)

No prior DATA_CARD convention existed in this repo; this card follows the minimal
versioned schema `data-card-v1` documented in
`datasets/experiments/wave-d2/d2-09-integrity-report.json` (sections: Identity,
Contents, Provenance & rights, Roles/splits, Lineage, Integrity, Caveats).

## Identity

- Dataset: public-source registry + fresh holdout candidates
- Path: `datasets/pickleball/`
- Registry schemaVersion: 2 · registry verifiedAt: 2026-08-27 · freshCandidates addedAt: 2026-08-29
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `registry.json`: 2 registered-not-downloaded sources · 6 evaluated-but-excluded
  sources · 1 official search check · 6 fresh candidates · 4 quarantined/excluded
  unknown-rights items
- `fresh-candidates/`: 6 mp4 clips, 181,080,528 bytes total (matches registered
  `totalBytes` exactly)
- `collection_manifest.schema.json`: consent-first first-party manifest schema
  (intentionally example-free)

## Provenance & rights

- All `sources[]` remain `registered_not_downloaded`; none is
  commercial-training cleared (`commercialTrainingReadyTemporalSourceCount: 0`).
- All 6 fresh candidates declare CC BY 3.0 read from the YouTube watch page
  (license text quoted in each entry's `licenseVerification`); uploader
  authority is a channel-context assessment, recorded as a residual caveat in
  `restrictions`.
- Quarantined items have no declared license (or NC terms) and were never
  downloaded.

## Roles / splits

- Every fresh candidate: `role: fresh_candidate`, `labelBlind: true` — excluded
  from corpus, splits, and training until a future freeze. No labels exist for
  these clips.

## Lineage

- Each fresh candidate records source URL, segment window, re-encode method,
  sha256, and byte count of the derived clip.

## Integrity (d2-09 audit, 2026-08-29)

- sha256 and byte counts of all 6 clips verified against on-disk media: 6/6 match.
- URL probe: 22/24 registry URLs returned HTTP 2xx. Both Roboflow project pages
  returned HTTP 403 to non-browser clients (bot challenge) — recorded as
  status-403, not confirmed dead; entries and their license claims are otherwise
  unchanged.
- No missing provenance fields; no count drift found in this registry.

## Caveats

- Roboflow license claims cannot be re-verified programmatically while the pages
  serve 403 to non-browser clients.
- Fresh-candidate uploader authority is assessed, not rights-holder-confirmed.
