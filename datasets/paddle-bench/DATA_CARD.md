# DATA_CARD — datasets/paddle-bench (schema data-card-v1)

## Identity

- Dataset: real-video paddle/perception benchmark (videos, bundles, gold labels)
- Path: `datasets/paddle-bench/`
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `registry.json`: 13 registered videos (schemaVersion 1), all with id/file/
  source/license/provenance/realFootage/sessionKey present; no duplicate ids.
- `bundles/`: 13 case bundles; annotation sidecars per bundle are append-only
  (`devin-visual-v1`, `devin-visual-v2-wave-a`, `devin-visual-v2-waveC[*]`
  families observed). 3 bundles carry a local `clip.mp4`.
- Gold/label files: `event-bounds-qa-wave-c.json` 34 events + 1 correction ·
  `event-bounds-wave-a.json` 8 cases + 9 rejected candidates ·
  `stroke-gold.json` 22 labels · `paddle-bench.json` 5 cases + 1 excluded ·
  `failure-review.json` 8-item taxonomy · `results/` 14 run files ·
  `runs-wave-a/` 8 case run dirs · `baselines.json` 1 baseline.
- `videos/` is gitignored by design (media stays local); README documents this.

## Provenance & rights

- Every registry entry records source URL, author, license, and attribution;
  sources are Wikimedia Commons (CC BY / PD) and DVIDS (PD-USGov) footage, plus
  derived crops that reference their parent entry for license.

## Roles / splits

- Held-out cases: `wm-dink-01`, `afn-vic-rally1` (locked; not viewed by this
  audit — only file listings and JSON structure counted).
- Session-level split ownership lives in `datasets/corpus/splits.json`;
  `wm-tournament-2014` is dev while also hosting held-out case wm-dink-01
  (documented v0.1 known limitation).

## Lineage

- Derived clips (`wm-dink-nearplayer` etc.) declare `derived from` their parent
  registry entry; corpus-level phash dedup confirms declared lineage.

## Integrity (d2-09 audit, 2026-08-29)

- Per-bundle annotation file inventory and label-atom counts are in
  `datasets/experiments/wave-d2/d2-09-integrity-report.json` (`paddleBench`).
- No missing registry fields, no duplicate ids, no count drift between the
  README's claims (README states no counts) and files on disk.

## Caveats

- Media absence on disk is by design (gitignored); byte/hash verification of
  bench videos is only possible on machines holding the local media.
- Annotation timestamps carry ±1-frame fog from the historical extraction
  off-by-one documented in HANDOFF_V3 §3.
