# DATA_CARD — datasets/corpus (schema data-card-v1)

## Identity

- Dataset: corpus registry (sources, recordings, sessions, splits, dedup, mining events)
- Path: `datasets/corpus/`
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `sources.json`: 20 sources (4 wikimedia_commons, 16 dvids), all with rights
  blocks (store/analyze/annotate/train/redistribute/commercial + basis + reviewer).
- `recordings.json`: 26 recordings (17 root, 9 derived), all with sha256, probe
  metadata, and sessionKey; every `sourceId` resolves; every `derivedFrom`
  parent resolves.
- `splits.json`: 15 session assignments — 11 dev, 1 val, 1 locked_test
  (afn-vic-2025), 2 shadow. 12 sessions currently carry recordings.
- `dedup-report.json`: 7 phash findings — 2 confirm declared lineage, 3 merged
  duplicate sessions, 2 same-session subclip families.
- `events/`: 13 per-recording JSONL files of mined tier-C event candidates,
  199 candidates total (3 files empty). These are miner outputs, not human labels.
- `fingerprints/`: 26 files (one per recording).

## Provenance & rights

- All 20 sources are training-eligible under PD-USGov / CC BY bases recorded per
  source; 0 rights-quarantined.

## Roles / splits

- Session-level split policy: pinned for previously inspected sessions,
  deterministic salted hash for new ones; derived recordings inherit the parent
  session; shadow is never mined/inspected.

## Lineage / dedup

- 3 split assignments (dvids-956784, dvids-957519, dvids-967848) reference
  sessions that dedup merged into afn-* sessions; the stale entries are retained
  (removing them would change deterministic-reuse semantics owned by the data
  engine) and are flagged in the d2-09 integrity report.

## Integrity (d2-09 audit, 2026-08-29)

- Referential integrity: 0 dangling sourceIds, 0 dangling derivedFrom parents,
  0 sessions with recordings but no split assignment.
- pickle-real-v0.3 manifest corpus claims (20 sources / 26 recordings / 17 root
  / 12 sessions) match this recount exactly.
- Recording media files are not on disk here (gitignored by design); sha256s are
  declared values verifiable only where media is held.

## Caveats

- Temporal dHash dedup does not catch spatial crops; those rely on declared
  lineage at registration (stated in dedup-report.json).
