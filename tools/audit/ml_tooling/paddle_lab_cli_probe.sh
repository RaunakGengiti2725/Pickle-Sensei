#!/usr/bin/env bash
# Exercise the model-free tools/paddle-lab CLIs end to end (success, repeat for
# determinism, empty window, missing input) and record exit codes.
#
#   ball_candidates.py   real clip -> JSON, run twice, diff minus timing;
#                        empty window (start==end), start>end, missing video
#   bench_decode.py      --verify --runs 1 (frame_iter vs decode_frames_at parity)
#   compare_paddle_dets.py  A==A must pass (exit 0); A vs shifted-B must fail (exit 1);
#                        missing file
#
# Usage: paddle_lab_cli_probe.sh <out-dir> [python]
# Prints one "<probe> exit=<n>" line per invocation; exit 0 iff every probe
# behaved as expected (success paths exit 0, failure paths exit non-zero
# without a traceback, repeat runs are semantically identical).
set -u
set -o pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:?out dir}"; PY="${2:-python3}"
LAB="$REPO/tools/paddle-lab"
CLIP="$REPO/datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"
mkdir -p "$OUT"
rc=0
expect() {  # expect <name> <want: 0|nonzero> <got> <log>
  local name=$1 want=$2 got=$3 log=$4 ok=1
  if [ "$want" = 0 ] && [ "$got" != 0 ]; then ok=0; fi
  if [ "$want" = nonzero ] && [ "$got" = 0 ]; then ok=0; fi
  if [ "$want" = nonzero ] && grep -q "Traceback (most recent call last)" "$log"; then
    echo "$name exit=$got (UNCAUGHT TRACEBACK in $log)"; rc=1; return
  fi
  if [ $ok = 1 ]; then echo "$name exit=$got (as expected)"; else echo "$name exit=$got (EXPECTED $want)"; rc=1; fi
}
strip_timing() {
  "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); d.pop("timing",None); print(json.dumps(d,sort_keys=True))' "$1"
}

echo "=== ball_candidates.py"
for i in 1 2; do
  ( cd "$LAB" && "$PY" ball_candidates.py --video "$CLIP" --out "$OUT/bc-run$i.json" --start-ms 1000 --end-ms 2000 ) > "$OUT/bc-run$i.log" 2>&1
  expect "ball_candidates run$i (1000-2000ms)" 0 $? "$OUT/bc-run$i.log"
done
if [ -f "$OUT/bc-run1.json" ] && [ -f "$OUT/bc-run2.json" ]; then
  if [ "$(strip_timing "$OUT/bc-run1.json")" = "$(strip_timing "$OUT/bc-run2.json")" ]; then
    echo "ball_candidates run1 vs run2 (minus timing): IDENTICAL"
  else echo "ball_candidates run1 vs run2 (minus timing): DIFFERS"; rc=1; fi
  "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); print("frames", len(d["frames"]), "framesProcessed", d["timing"]["framesProcessed"], "window", d["window"])' "$OUT/bc-run1.json"
fi
( cd "$LAB" && "$PY" ball_candidates.py --video "$CLIP" --out "$OUT/bc-empty.json" --start-ms 1000 --end-ms 1000 ) > "$OUT/bc-empty.log" 2>&1
e=$?; echo "ball_candidates empty window (start==end) exit=$e"; grep -q Traceback "$OUT/bc-empty.log" && { echo "  UNCAUGHT TRACEBACK: $(tail -1 "$OUT/bc-empty.log")"; rc=1; }
[ -f "$OUT/bc-empty.json" ] && "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); print("  wrote frames", len(d["frames"]), "framesProcessed", d["timing"]["framesProcessed"])' "$OUT/bc-empty.json"
( cd "$LAB" && "$PY" ball_candidates.py --video "$CLIP" --out "$OUT/bc-inverted.json" --start-ms 2000 --end-ms 1000 ) > "$OUT/bc-inverted.log" 2>&1
e=$?; echo "ball_candidates inverted window (start>end) exit=$e"; grep -q Traceback "$OUT/bc-inverted.log" && { echo "  UNCAUGHT TRACEBACK: $(tail -1 "$OUT/bc-inverted.log")"; rc=1; }
[ -f "$OUT/bc-inverted.json" ] && "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); print("  wrote frames", len(d["frames"]), "framesProcessed", d["timing"]["framesProcessed"], "window", d["window"])' "$OUT/bc-inverted.json"
( cd "$LAB" && "$PY" ball_candidates.py --video "$OUT/does-not-exist.mp4" --out "$OUT/bc-missing.json" ) > "$OUT/bc-missing.log" 2>&1
expect "ball_candidates missing video" nonzero $? "$OUT/bc-missing.log"
tail -1 "$OUT/bc-missing.log" | sed 's/^/  last line: /'

echo; echo "=== bench_decode.py --verify"
( cd "$LAB" && "$PY" bench_decode.py --verify --runs 1 --clips "$CLIP" ) > "$OUT/bench-decode.log" 2>&1
expect "bench_decode --verify --runs 1" 0 $? "$OUT/bench-decode.log"
grep -i "verify\|mismatch\|ok" "$OUT/bench-decode.log" | head -5 | sed 's/^/  /'

echo; echo "=== compare_paddle_dets.py"
# A = a committed real detect_paddle.py output; B = same file with every box shifted 5px
"$PY" - "$REPO/datasets/experiments/wave-a/P-runs/P-detector-fresh2-warm.json" "$OUT" <<'EOF'
import json, shutil, sys
src, out = sys.argv[1], sys.argv[2]
shutil.copy(src, f"{out}/cmp-a.json")
shifted = json.load(open(src))
for f in shifted["frames"]:
    for d in f["detections"] + f["extras"]:
        d["box"][0] += 5.0
        d["box"][2] += 5.0
with open(f"{out}/cmp-b.json", "w") as fh:
    json.dump(shifted, fh)
EOF
( cd "$LAB" && "$PY" compare_paddle_dets.py --a "$REPO/datasets/experiments/wave-a/P-runs/P-detector-fresh2-warm.json" --b "$REPO/datasets/experiments/wave-a/P-runs/P-detector-fresh3-hfoffline.json" --out "$OUT/cmp-warm-vs-offline.json" ) > "$OUT/cmp-warm-vs-offline.log" 2>&1
echo "compare_paddle_dets committed P-detector-fresh2-warm vs fresh3-hfoffline exit=$? : $(tail -1 "$OUT/cmp-warm-vs-offline.log" | cut -c1-200)"
( cd "$LAB" && "$PY" compare_paddle_dets.py --a "$OUT/cmp-a.json" --b "$OUT/cmp-a.json" --out "$OUT/cmp-aa.json" ) > "$OUT/cmp-aa.log" 2>&1
expect "compare_paddle_dets A==A" 0 $? "$OUT/cmp-aa.log"
( cd "$LAB" && "$PY" compare_paddle_dets.py --a "$OUT/cmp-a.json" --b "$OUT/cmp-b.json" --out "$OUT/cmp-ab.json" ) > "$OUT/cmp-ab.log" 2>&1
expect "compare_paddle_dets A vs shifted B" nonzero $? "$OUT/cmp-ab.log"
( cd "$LAB" && "$PY" compare_paddle_dets.py --a "$OUT/cmp-a.json" --b "$OUT/nope.json" --out "$OUT/cmp-missing.json" ) > "$OUT/cmp-missing.log" 2>&1
expect "compare_paddle_dets missing B" nonzero $? "$OUT/cmp-missing.log"
tail -1 "$OUT/cmp-missing.log" | sed 's/^/  last line: /'

echo; echo "overall exit=$rc"
exit $rc
