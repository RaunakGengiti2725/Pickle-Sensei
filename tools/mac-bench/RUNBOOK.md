# mac-bench RUNBOOK — the moment a Mac is available

Audited at Wave G (g24-mac-harness) against integration head. Everything
Linux-checkable was compiled, schema-validated, unit-tested and dry-run at
head; the macOS execution path itself remains **BLOCKED_EXTERNAL /
UNVERIFIED-HERE** — it has never been executed on Apple hardware by the
workstreams that wrote or audited it.

## One command

```bash
git checkout <the audited branch>   # see docs/STATUS_BOARD.md for current
export PATH=~/.npm-global/bin:$PATH # Node v20.18.1, pnpm
pnpm install
tools/mac-bench/run-mac-bench.sh --warm 3
```

That is the entire benchmark. It fails fast (exit 3) on non-macOS and fails
fast on a Mac missing any prerequisite — the full prerequisite checklist
(videos, gold, python env, Swift toolchain, expected SHA-256s) is in
`ARTIFACTS_REQUIRED.md`. Output:

- `tools/mac-bench/results/mac-bench-<unix-ms>.json` (`mac-bench-results-v1`,
  schema-validated before write)
- `tools/mac-bench/results/mac-bench-<unix-ms>.samples.jsonl` (raw samples)

Then compare against the previous Mac results document:

```bash
pnpm --filter @pickle/mac-bench compare <old.json> <new.json>
```

## What was verified on Linux at head (Wave G audit)

- `bash -n run-mac-bench.sh` clean; Linux refusal path exercised (exit 3).
- `pnpm --filter @pickle/mac-bench test` — 38/38 (schema validation, latency
  stats, sample harvesting, assembly, compare).
- `tsc --noEmit` clean for the package.
- Compare CLI dry-run on fixture documents → `VERDICT: OK`.
- Stage harvest map updated to the CURRENT `analyzeVideo` timing vocabulary,
  including `poseDerivativesMs` and the two-pass split
  (`paddleDetectSparseMs` / `paddleDetectDenseMs`) — previously missing
  (bit-rot fixed this wave).
- Zero-gold `lab:cascade` output no longer crashes assembly: it becomes
  `cascade: null` with an explicit `cascadeUnmeasuredReason` (missing
  evidence stays absent, never zero).
- Linux-measurable pieces profiled at head with counts:
  `datasets/experiments/wave-g/g24-linux-profile.json`
  (regenerate: `pnpm --filter @pickle/mac-bench profile:linux`). Those
  numbers are LINUX-CPU-NOT-MAC and never substitute for a Mac results doc.

## What ONLY a Mac can produce (BLOCKED_EXTERNAL until then)

- Swift extractor build + Apple Vision pose extraction (steps 1–2).
- Real cold/warm end-to-end latency per stage (steps 2, 4).
- Canonical run regeneration (`pnpm lab:regen --exec`) and cascade
  counters (`pnpm lab:cascade`) with gold evidence (steps 3, 5).
- Any iPhone/device numbers (`IPHONE_HARNESS.md`,
  `pickle.device-bench.v1`).

Do not report Mac/iPhone numbers from any other source.
