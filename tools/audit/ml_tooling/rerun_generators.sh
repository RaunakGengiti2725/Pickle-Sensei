#!/usr/bin/env bash
# Re-run the two committed-artifact generators in scratch roots (never writing
# into the repo's datasets/) and diff their outputs against the committed
# artifacts. Runs each generator TWICE to prove run-to-run determinism.
#
#   tools/mining/wave_g_g03_multi_paddle_miner.py -> datasets/mining/wave-g-g03/
#   tools/paddle-lab/distill_export.py            -> datasets/releases/paddle-distill-v0.1/
#
# Usage: tools/audit/ml_tooling/rerun_generators.sh <scratch-dir> [python]
# Exit 0 only when both generators exit 0 twice, are byte-stable across the two
# runs, and match the committed artifacts (semantic JSON equality; byte diffs
# are reported but only fail when the parsed JSON differs).
set -u
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="${1:?scratch dir}"
PY="${2:-python3}"
mkdir -p "$SCRATCH"
rc=0

json_eq() {  # semantic compare, ignoring keys passed as 3rd arg (comma list)
  "$PY" - "$1" "$2" "${3:-}" <<'EOF'
import json, sys
a, b, ignore = sys.argv[1], sys.argv[2], [k for k in sys.argv[3].split(",") if k]
def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)
def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k not in ignore}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o
da, db = strip(load(a)), strip(load(b))
if da == db:
    print(f"SEMANTIC_EQUAL {a} {b}")
    sys.exit(0)
def walk(x, y, path="$"):
    if type(x) != type(y):
        print(f"  {path}: type {type(x).__name__} vs {type(y).__name__}"); return
    if isinstance(x, dict):
        for k in sorted(set(x) | set(y)):
            if k not in x: print(f"  {path}.{k}: only in committed")
            elif k not in y: print(f"  {path}.{k}: only in regenerated")
            else: walk(x[k], y[k], f"{path}.{k}")
    elif isinstance(x, list):
        if len(x) != len(y): print(f"  {path}: len {len(x)} vs {len(y)}")
        for i, (p, q) in enumerate(zip(x, y)):
            walk(p, q, f"{path}[{i}]")
    elif x != y:
        print(f"  {path}: {x!r} vs {y!r}")
print(f"SEMANTIC_DIFF {a} {b}")
walk(da, db)
sys.exit(1)
EOF
}

echo "=== miner (tools/mining/wave_g_g03_multi_paddle_miner.py)"
MROOT="$SCRATCH/miner-root"
rm -rf "$MROOT"; mkdir -p "$MROOT/tools/mining" "$MROOT/datasets"
cp "$REPO/tools/mining/wave_g_g03_multi_paddle_miner.py" "$MROOT/tools/mining/"
ln -s "$REPO/datasets/paddle-bench" "$MROOT/datasets/paddle-bench"
for run in 1 2; do
  ( cd "$MROOT" && "$PY" tools/mining/wave_g_g03_multi_paddle_miner.py > "$SCRATCH/miner-run$run.log" 2>&1 )
  e=$?; echo "miner run$run exit=$e"; [ $e -eq 0 ] || rc=1
  mkdir -p "$SCRATCH/miner-out$run"; cp -r "$MROOT/datasets/mining/wave-g-g03/." "$SCRATCH/miner-out$run/"
done
if diff -r "$SCRATCH/miner-out1" "$SCRATCH/miner-out2" > "$SCRATCH/miner-run1-vs-run2.diff"; then
  echo "miner run1 vs run2: BYTE-IDENTICAL (incl. frame-pack PNGs)"
else
  echo "miner run1 vs run2: DIFFERS ($(wc -l < "$SCRATCH/miner-run1-vs-run2.diff") diff lines)"; rc=1
fi
for f in candidates.json annotation-queue.json label-schema.json; do
  if cmp -s "$REPO/datasets/mining/wave-g-g03/$f" "$SCRATCH/miner-out1/$f"; then
    echo "miner $f vs committed: BYTE-IDENTICAL"
  else
    echo "miner $f vs committed: bytes differ"
    json_eq "$REPO/datasets/mining/wave-g-g03/$f" "$SCRATCH/miner-out1/$f" > "$SCRATCH/miner-$f.semantic.txt" 2>&1 || rc=1
    head -20 "$SCRATCH/miner-$f.semantic.txt"
  fi
done
( cd "$REPO/datasets/mining/wave-g-g03" && find frame-packs -type f | sort | xargs sha256sum ) > "$SCRATCH/miner-committed-pngs.sha" 2>/dev/null
( cd "$SCRATCH/miner-out1" && find frame-packs -type f | sort | xargs sha256sum ) > "$SCRATCH/miner-regen-pngs.sha" 2>/dev/null
if cmp -s "$SCRATCH/miner-committed-pngs.sha" "$SCRATCH/miner-regen-pngs.sha"; then
  echo "miner frame-packs vs committed: $(wc -l < "$SCRATCH/miner-regen-pngs.sha") PNGs BYTE-IDENTICAL"
else
  echo "miner frame-packs vs committed: PNG set/content differs ($(diff "$SCRATCH/miner-committed-pngs.sha" "$SCRATCH/miner-regen-pngs.sha" | grep -c '^[<>]') lines)"
fi

echo
echo "=== distill_export (tools/paddle-lab/distill_export.py)"
DROOT="$SCRATCH/distill-root"
rm -rf "$DROOT"; mkdir -p "$DROOT/datasets/releases"
for d in "$REPO"/datasets/*; do
  b="$(basename "$d")"; [ "$b" = releases ] && continue
  ln -s "$d" "$DROOT/datasets/$b"
done
for d in "$REPO"/datasets/releases/*; do
  b="$(basename "$d")"; [ "$b" = paddle-distill-v0.1 ] && continue
  ln -s "$d" "$DROOT/datasets/releases/$b"
done
for run in 1 2; do
  rm -rf "$DROOT/datasets/releases/paddle-distill-v0.1"
  ( cd "$REPO" && "$PY" tools/paddle-lab/distill_export.py --repo-root "$DROOT" > "$SCRATCH/distill-run$run.log" 2>&1 )
  e=$?; echo "distill run$run exit=$e"; [ $e -eq 0 ] || rc=1
  mkdir -p "$SCRATCH/distill-out$run"; cp -r "$DROOT/datasets/releases/paddle-distill-v0.1/." "$SCRATCH/distill-out$run/" 2>/dev/null
done
if diff -r "$SCRATCH/distill-out1" "$SCRATCH/distill-out2" > "$SCRATCH/distill-run1-vs-run2.diff"; then
  echo "distill run1 vs run2: BYTE-IDENTICAL"
else
  echo "distill run1 vs run2: DIFFERS"; rc=1
fi
for f in examples.jsonl manifest.json; do
  if cmp -s "$REPO/datasets/releases/paddle-distill-v0.1/$f" "$SCRATCH/distill-out1/$f"; then
    echo "distill $f vs committed: BYTE-IDENTICAL"
  elif [ "$f" = manifest.json ]; then
    echo "distill $f vs committed: bytes differ"
    json_eq "$REPO/datasets/releases/paddle-distill-v0.1/$f" "$SCRATCH/distill-out1/$f" > "$SCRATCH/distill-manifest.semantic.txt" 2>&1 || rc=1
    head -20 "$SCRATCH/distill-manifest.semantic.txt"
    diff "$REPO/datasets/releases/paddle-distill-v0.1/$f" "$SCRATCH/distill-out1/$f" > "$SCRATCH/distill-manifest.bytes.diff"
  else
    echo "distill $f vs committed: DIFFERS"; rc=1
    diff "$REPO/datasets/releases/paddle-distill-v0.1/$f" "$SCRATCH/distill-out1/$f" | head -10
  fi
done
echo
echo "overall exit=$rc"
exit $rc
