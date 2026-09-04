#!/usr/bin/env bash
# Attack S3 (adversarial pass 3, tester #4): run bench:regression with a PATH
# that has no ffmpeg/ffprobe, and with a logging shim in front of the real
# ffmpeg, then compare the two summaries metric-by-metric against a normal run.
#
# Usage: packages/swing-lab/test/attack/benchNoFfmpeg.sh <out-dir>
# Exit 0 when the run without ffmpeg is byte-for-byte metric-identical to the
# run with ffmpeg AND no bench ever invoked ffmpeg/ffprobe (no media dependency,
# so nothing can silently degrade). Exit 1 when metrics differ silently while
# every bench still reports "ok" (the failure mode this attack looks for).
# Exit 2 on harness error.
set -euo pipefail

OUT=${1:?out-dir required}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
mkdir -p "$OUT"
rm -rf "$OUT/with" "$OUT/without" "$OUT/shim"

# 1. PATH without ffmpeg/ffprobe: mirror every PATH dir into a symlink farm
#    that omits the two binaries. Bench subprocesses resolve `node` via PATH.
FARM="$OUT/path-without-ffmpeg"
rm -rf "$FARM" && mkdir -p "$FARM"
IFS=: read -ra DIRS <<<"$PATH"
for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    case "$b" in ffmpeg|ffprobe) continue ;; esac
    [ -e "$FARM/$b" ] || ln -s "$f" "$FARM/$b"
  done
done
if PATH="$FARM" command -v ffmpeg >/dev/null 2>&1; then
  echo "harness error: ffmpeg still resolvable" >&2
  exit 2
fi

# 2. Logging shim in front of the real ffmpeg/ffprobe.
SHIMDIR="$OUT/shim-bin"
rm -rf "$SHIMDIR" && mkdir -p "$SHIMDIR"
: >"$OUT/ffmpeg-invocations.log"
for tool in ffmpeg ffprobe; do
  real=$(command -v "$tool")
  cat >"$SHIMDIR/$tool" <<EOF
#!/usr/bin/env bash
echo "$tool \$*" >>"$OUT/ffmpeg-invocations.log"
exec "$real" "\$@"
EOF
  chmod +x "$SHIMDIR/$tool"
done

cd "$ROOT"
set +e
pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$OUT/with" --run-id with \
  >"$OUT/with.log" 2>&1
echo "with-ffmpeg exit $?" | tee "$OUT/exits.txt"
PATH="$FARM" pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$OUT/without" --run-id without \
  >"$OUT/without.log" 2>&1
echo "without-ffmpeg exit $?" | tee -a "$OUT/exits.txt"
PATH="$SHIMDIR:$PATH" pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$OUT/shim" --run-id shim \
  >"$OUT/shim.log" 2>&1
echo "shim exit $?" | tee -a "$OUT/exits.txt"

# 3. executeBench() with a media-dependent probe bench, with and without ffmpeg
#    (the committed selection has no media bench, so this is the only way to
#    exercise the runner's failed-status path on a real decode).
PROBE="$ROOT/packages/swing-lab/test/attack/benchMediaProbe.ts"
pnpm -s --filter @pickle/swing-lab exec tsx "$PROBE" "$OUT/probe-with.json" >"$OUT/probe-with.log" 2>&1
echo "probe-with exit $?" | tee -a "$OUT/exits.txt"
PATH="$FARM" pnpm -s --filter @pickle/swing-lab exec tsx "$PROBE" "$OUT/probe-without.json" >"$OUT/probe-without.log" 2>&1
echo "probe-without exit $?" | tee -a "$OUT/exits.txt"
set -e

node - "$OUT" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[2];
const load = (n) => JSON.parse(fs.readFileSync(path.join(out, n, `${n}.json`), "utf8"));
const w = load("with"), wo = load("without");
const statuses = (s) => Object.fromEntries(s.benches.map((b) => [b.id, b.status]));
const diffs = [];
for (const key of new Set([...Object.keys(w.metrics), ...Object.keys(wo.metrics)])) {
  if (JSON.stringify(w.metrics[key]) !== JSON.stringify(wo.metrics[key])) {
    diffs.push({ key, with: w.metrics[key], without: wo.metrics[key] });
  }
}
const invocations = fs.readFileSync(path.join(out, "ffmpeg-invocations.log"), "utf8").trim();
const probe = (n) => JSON.parse(fs.readFileSync(path.join(out, `probe-${n}.json`), "utf8"));
const probeWith = probe("with"), probeWithout = probe("without");
const report = {
  exits: fs.readFileSync(path.join(out, "exits.txt"), "utf8").trim().split("\n"),
  withStatuses: statuses(w),
  withoutStatuses: statuses(wo),
  metricDiffs: diffs,
  ffmpegInvokedDuringBench: invocations.length > 0,
  ffmpegInvocations: invocations ? invocations.split("\n") : [],
  mediaProbe: { with: probeWith, without: probeWithout },
};
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
const silentDegradation =
  diffs.length > 0 && Object.values(statuses(wo)).every((s) => s === "ok");
if (silentDegradation) {
  console.error("BROKEN: metrics changed without ffmpeg while every bench still reported ok");
  process.exit(1);
}
const guardedWithout = probeWithout.records.find((r) => r.id === "attack_media_guarded");
const naiveWithout = probeWithout.records.find((r) => r.id === "attack_media_naive");
if (probeWithout.ffmpegOnPath || guardedWithout.status !== "failed" || probeWithout.runnerWouldExit !== 1) {
  console.error("BROKEN: executeBench did not turn a media decode failure into status=failed / exit 1");
  process.exit(1);
}
if (naiveWithout.status === "ok" && naiveWithout.metrics.frame_count === 0) {
  console.error(
    "NOTE: an unguarded media bench reports frame_count=0 with status ok — executeBench only fails on throw; guards must live in each bench",
  );
}
EOF
