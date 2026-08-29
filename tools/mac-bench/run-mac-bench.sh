#!/usr/bin/env bash
#
# run-mac-bench.sh — SINGLE-COMMAND Mac benchmark for the Pickle Sensei
# perception pipeline. One invocation:
#
#   tools/mac-bench/run-mac-bench.sh [--warm N] [--cases id1,id2,…] [--skip-regen]
#
# does, in order:
#   1. builds the Swift extractor      (native/swing-lab, release)
#   2. COLD timing pass                (fresh scratch dirs, full extraction,
#                                       one run per case — process, model,
#                                       and file caches all cold)
#   3. canonical regen                 (pnpm lab:regen --exec <cases> — the
#                                       versioned regeneration every bench
#                                       reads; identity-verified per case)
#   4. WARM timing passes              (N further full runs per case into
#                                       scratch dirs; caches warm, extraction
#                                       still real — warm E2E is honest E2E)
#   5. cascade + silent-failure +      (pnpm lab:cascade over the canonical
#      usable-result metrics            runs regenerated in step 3)
#   6. exports ONE versioned results   (mac-bench-results-v1; schema in
#      JSON                             src/resultsSchema.ts, fixture-tested
#                                       on Linux; compare runs with
#                                       src/compareResults.ts)
#
# OUTPUT: tools/mac-bench/results/mac-bench-<unix-ms>.json
# (plus raw stage samples next to it as mac-bench-<unix-ms>.samples.jsonl)
#
# REQUIREMENTS: see tools/mac-bench/ARTIFACTS_REQUIRED.md — gold videos,
# python venv with the D-FINE stack, Xcode toolchain. The script fails fast
# with a precise message when any requirement is missing.
#
# HONESTY NOTES:
#  - This script is macOS-only BY MEASUREMENT NECESSITY (Apple Vision pose
#    extraction). It has never been executed on a Mac by the workstream that
#    wrote it (Linux box) — the macOS execution path ships UNVERIFIED-HERE.
#    Everything that can run on Linux (schema, stats, assembly, comparison,
#    sample harvesting) is unit-tested in tools/mac-bench/test/.
#  - Cold/warm semantics are documented in src/runCase.ts and carried into
#    the results document; percentiles over few samples are labeled by
#    sampleCount, never presented as stable estimates.
#  - Cascade counters are copied verbatim from lab:cascade output — this
#    script never recomputes or reinterprets them.

set -euo pipefail

# ── 0. Environment guards (fail fast, precisely) ─────────────────────────
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "run-mac-bench.sh: REFUSING TO RUN — this benchmark requires macOS." >&2
  echo "  Pose extraction uses Apple Vision (native/swing-lab), which only" >&2
  echo "  exists on macOS. On Linux you can still run the harness tests:" >&2
  echo "    pnpm --filter @pickle/mac-bench test" >&2
  echo "  and compare existing results JSONs:" >&2
  echo "    pnpm --filter @pickle/mac-bench compare -- <old.json> <new.json>" >&2
  exit 3
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PB="$REPO_ROOT/datasets/paddle-bench"
SWING_LAB="$REPO_ROOT/packages/swing-lab"

command -v pnpm >/dev/null || { echo "run-mac-bench.sh: pnpm not on PATH" >&2; exit 3; }
command -v swift >/dev/null || { echo "run-mac-bench.sh: swift not on PATH (install Xcode command-line tools)" >&2; exit 3; }
[[ -f "$PB/regen-manifest.json" ]] || { echo "run-mac-bench.sh: $PB/regen-manifest.json missing" >&2; exit 3; }
[[ -d "$REPO_ROOT/tools/paddle-lab/.venv" ]] || {
  echo "run-mac-bench.sh: tools/paddle-lab/.venv missing — create it per ARTIFACTS_REQUIRED.md" >&2
  exit 3
}

WARM_ITERATIONS=3
CASES=""
SKIP_REGEN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --warm) WARM_ITERATIONS="$2"; shift 2 ;;
    --cases) CASES="$2"; shift 2 ;;
    --skip-regen) SKIP_REGEN=1; shift ;;
    *) echo "run-mac-bench.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

# Default case list = every case in the frozen regen manifest.
if [[ -z "$CASES" ]]; then
  CASES="$(node -e 'const m=require(process.argv[1]);console.log(m.map(e=>e.id).join(","))' "$PB/regen-manifest.json")"
fi
[[ -n "$CASES" ]] || { echo "run-mac-bench.sh: empty case list" >&2; exit 3; }

# Every case's gold video must exist before any timing starts.
node -e '
  const {join} = require("node:path");
  const {existsSync} = require("node:fs");
  const manifest = require(process.argv[1]);
  const pb = process.argv[2];
  const wanted = process.argv[3].split(",");
  const marker = "datasets/paddle-bench/";
  for (const id of wanted) {
    const entry = manifest.find(e => e.id === id);
    if (!entry) { console.error(`case ${id} not in regen-manifest.json`); process.exit(3); }
    const video = join(pb, entry.video.slice(entry.video.indexOf(marker) + marker.length));
    if (!existsSync(video)) {
      console.error(`case ${id}: gold video missing at ${video} — see ARTIFACTS_REQUIRED.md`);
      process.exit(3);
    }
  }
' "$PB/regen-manifest.json" "$PB" "$CASES"

STAMP="$(node -e 'console.log(Date.now())')"
RESULTS_DIR="$HERE/results"
SCRATCH="$HERE/results/scratch-$STAMP"
SAMPLES="$RESULTS_DIR/mac-bench-$STAMP.samples.jsonl"
OUT="$RESULTS_DIR/mac-bench-$STAMP.json"
mkdir -p "$RESULTS_DIR" "$SCRATCH"
: > "$SAMPLES"

# ── 1. Build the Swift extractor ─────────────────────────────────────────
echo "── building Swift extractor (release) …"
BUILD_START="$(node -e 'console.log(Date.now())')"
(cd "$REPO_ROOT/native/swing-lab" && swift build -c release)
BUILD_MS=$(( $(node -e 'console.log(Date.now())') - BUILD_START ))
EXTRACTOR_BIN="$(cd "$REPO_ROOT/native/swing-lab" && swift build -c release --show-bin-path)/swing-lab"
[[ -x "$EXTRACTOR_BIN" ]] || { echo "run-mac-bench.sh: extractor binary not found at $EXTRACTOR_BIN" >&2; exit 3; }

# ── 2. COLD pass (scratch dirs, everything cold) ─────────────────────────
# Purge python bytecode caches so the first invocation pays real import cost.
find "$REPO_ROOT/tools/paddle-lab" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
IFS=',' read -ra CASE_IDS <<< "$CASES"
for CASE_ID in "${CASE_IDS[@]}"; do
  echo "── COLD $CASE_ID …"
  (cd "$HERE" && npx tsx src/runCase.ts \
    --case "$CASE_ID" --phase cold --iteration 1 \
    --samples "$SAMPLES" --out-dir "$SCRATCH/cold-$CASE_ID")
done

# ── 3. Canonical regen (the runs every bench reads) ──────────────────────
if [[ "$SKIP_REGEN" -eq 0 ]]; then
  echo "── canonical regen (pnpm lab:regen --exec ${CASES//,/ }) …"
  (cd "$REPO_ROOT" && pnpm lab:regen --exec ${CASES//,/ })
else
  echo "── --skip-regen: reusing existing canonical run dirs (cascade below reflects THOSE runs)"
fi

# ── 4. WARM passes ────────────────────────────────────────────────────────
for (( ITERATION=1; ITERATION<=WARM_ITERATIONS; ITERATION++ )); do
  for CASE_ID in "${CASE_IDS[@]}"; do
    echo "── WARM #$ITERATION $CASE_ID …"
    (cd "$HERE" && npx tsx src/runCase.ts \
      --case "$CASE_ID" --phase warm --iteration "$ITERATION" \
      --samples "$SAMPLES" --out-dir "$SCRATCH/warm-$CASE_ID")
  done
done

# ── 5. Cascade + silent-failure + usable-result metrics ──────────────────
echo "── cascade (strict + usable-result-v1 + silent-failure-v1) …"
CASCADE_START="$(node -e 'console.log(Date.now())')"
(cd "$REPO_ROOT" && pnpm lab:cascade)
CASCADE_MS=$(( $(node -e 'console.log(Date.now())') - CASCADE_START ))
echo "{\"stage\":\"cascade\",\"caseId\":\"ALL\",\"phase\":\"warm\",\"iteration\":1,\"wallMs\":$CASCADE_MS}" >> "$SAMPLES"
CASCADE_JSON="$(ls -t "$REPO_ROOT"/datasets/cascade/cascade-*.json | head -1)"
[[ -f "$CASCADE_JSON" ]] || { echo "run-mac-bench.sh: no cascade JSON produced" >&2; exit 3; }

# ── 6. Assemble the versioned results document ────────────────────────────
(cd "$HERE" && npx tsx src/assembleResults.ts \
  --samples "$SAMPLES" \
  --cascade "$CASCADE_JSON" \
  --cases "$CASES" \
  --cold 1 --warm "$WARM_ITERATIONS" \
  --extractor-built true --extractor-ms "$BUILD_MS" --extractor-bin "$EXTRACTOR_BIN" \
  --note "cold/warm semantics: src/runCase.ts header" \
  --out "$OUT")

echo ""
echo "RESULTS: $OUT"
echo "compare against a previous run with:"
echo "  pnpm --filter @pickle/mac-bench compare -- <old-results.json> $OUT"
