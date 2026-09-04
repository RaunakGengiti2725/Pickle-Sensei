#!/usr/bin/env bash
# Runs the Edge Function perf benchmark across the 2×2 matrix
# (redis off/on × injected latency zero/simulated), each mode in its OWN deno
# process (Redis wiring and the L1 cache inside index.ts are module state),
# then renders results/SUMMARY.md. Every run's stdout/stderr lands in
# results/<mode>.log; the JSON is the raw evidence.
#
#   (cd supabase/functions/api/__wf__ && bash perf/run_matrix.sh [requests] [seed])
set -euo pipefail

cd "$(dirname "$0")/.."
REQUESTS="${1:-1000}"
SEED="${2:-perf-edge-latency-n1}"
OUT_DIR="perf/results"
mkdir -p "$OUT_DIR"

run_mode() {
  local redis="$1" latency="$2"
  local name="redis-${redis}_latency-${latency}"
  echo "[matrix] ${name}: requests=${REQUESTS} seed=${SEED}"
  deno run -A --v8-flags=--expose-gc --config deno.json perf/perf_edge_latency_bench.ts \
    --redis "$redis" --latency "$latency" --requests "$REQUESTS" --seed "$SEED" \
    --out "${OUT_DIR}/${name}.json" 2>&1 | tee "${OUT_DIR}/${name}.log"
  echo "[matrix] ${name}: exit=${PIPESTATUS[0]}" | tee -a "${OUT_DIR}/${name}.log"
}

run_mode off zero
run_mode on zero
run_mode off simulated
run_mode on simulated

deno run -A --config deno.json perf/perf_summarize.ts \
  "${OUT_DIR}/redis-off_latency-zero.json" \
  "${OUT_DIR}/redis-on_latency-zero.json" \
  "${OUT_DIR}/redis-off_latency-simulated.json" \
  "${OUT_DIR}/redis-on_latency-simulated.json" > "${OUT_DIR}/SUMMARY.md"
echo "[matrix] wrote ${OUT_DIR}/SUMMARY.md"
