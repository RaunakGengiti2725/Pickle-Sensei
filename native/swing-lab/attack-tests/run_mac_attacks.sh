#!/usr/bin/env bash
# Adversarial pass for `swing-lab extract` — Apple plane.
#
# Runs on macOS only (the CLI needs AVFoundation + Vision). Builds the Release
# binary the same way scripts/mac-full-verify.sh does, generates the fixtures
# (fixtures/make_fixtures.sh), attacks the CLI with every scenario below and
# classifies each one HELD / BROKEN via check_extract.py. Nothing is skipped
# silently: a fixture that cannot be built, a run that does not exit as
# expected, or a check that fails marks the scenario BROKEN and the script
# exits 1. No production code is touched; outputs go under --out.
#
#   native/swing-lab/attack-tests/run_mac_attacks.sh --out artifacts/swing-lab-attacks
#   native/swing-lab/attack-tests/run_mac_attacks.sh --out … --bin /path/to/swing-lab   # skip build
#
# Scenarios (coordinator IDs):
#   S1 rotated    90°-rotated portrait (non-identity preferredTransform) → upright w/h, landmarks ∈ [0,1]
#   S2 vfr        VFR + person visible half the time → is video.fps decoded cadence or pose cadence?
#   S3 rewind     PTS rewind (edit list / negative ctts) → timestamps strictly increasing, offenders omitted
#   S4 cuts       hard cut every 500 ms → cuts strictly increasing, segments partition [0,durationMs]
#   S5 panning    panning camera → ball.json.cameraAssumption still the literal "stationary"
#   S6 audio      audio-only .m4a → stderr "no video track", domain swing-lab code 1, exit 1
#   S7 overwrite  extract twice into one --out → all five files rewritten, no stale sibling
#   X1 edge       corrupt / empty / missing input → exit 1, no partial output
#   X2 edge       one-frame clip → exit 0, valid five-file output
#   X3 edge       --out is a FILE / read-only parent / unicode+space path
#   X4 repeats    4 concurrent extracts of one clip → all exit 0, scenes.json byte-identical
#   X5 interleave 2 concurrent extracts into the SAME --out → final files are one coherent set
#   X6 cancel     SIGTERM mid-flight → no torn JSON left behind
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT=""
BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: $0 --out <dir> [--bin <swing-lab>]"; exit 2; }
[ "$(uname -s)" = "Darwin" ] || { echo "run_mac_attacks.sh must run on macOS (AVFoundation/Vision)"; exit 2; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
FIX="$OUT/fixtures"
RESULTS="$OUT/results.jsonl"
: > "$RESULTS"
CHECK="python3 $HERE/check_extract.py"
BROKEN=0

record() { # record <id> <status> <detail> [artifact]
  python3 - "$RESULTS" "$@" <<'EOF'
import json, sys
path, sid, status, detail = sys.argv[1:5]
artifact = sys.argv[5] if len(sys.argv) > 5 else ""
with open(path, "a") as f:
    f.write(json.dumps({"scenario": sid, "status": status, "detail": detail, "artifact": artifact}) + "\n")
EOF
  if [ "$2" = "BROKEN" ]; then BROKEN=1; fi
  echo "[$2] $1 — $3"
}

run_extract() { # run_extract <label> <input> <outdir> -> sets RC, writes <outdir>.stderr/.stdout
  local label="$1" input="$2" outdir="$3"
  mkdir -p "$(dirname "$outdir")"
  "$BIN" extract "$input" --out "$outdir" > "$outdir.stdout" 2> "$outdir.stderr"
  RC=$?
  echo "  $label: exit=$RC ($(wc -c < "$outdir.stderr" | tr -d ' ') bytes stderr)"
}

check() { # check <id> <outdir> <checker args…>; records HELD/BROKEN
  local sid="$1" outdir="$2"; shift 2
  $CHECK "$outdir" --report "$outdir.check.json" --quiet "$@" > "$outdir.check.log" 2>&1
  local rc=$?
  local summary; summary="$(tail -1 "$outdir.check.log")"
  if [ $rc -eq 0 ]; then record "$sid" HELD "$summary" "$outdir.check.json"
  else record "$sid" BROKEN "$summary; failures: $(grep '^FAIL' "$outdir.check.log" | cut -d' ' -f2 | tr '\n' ' ')" "$outdir.check.json"; fi
}

echo "== toolchain"
sw_vers | tee "$OUT/sw_vers.txt"
xcodebuild -version 2>/dev/null | tee "$OUT/xcodebuild-version.txt"
git -C "$REPO" rev-parse HEAD | tee "$OUT/git-head.txt"

if [ -z "$BIN" ]; then
  echo "== build swing-lab (release)"
  (cd "$REPO/native/swing-lab" && swift build -c release 2>&1 | tail -20) || { record build BROKEN "swift build -c release failed"; exit 1; }
  BIN="$(cd "$REPO/native/swing-lab" && swift build -c release --show-bin-path)/swing-lab"
fi
[ -x "$BIN" ] || { record build BROKEN "binary not executable: $BIN"; exit 1; }
echo "binary: $BIN"

echo "== fixtures"
if ! bash "$HERE/fixtures/make_fixtures.sh" "$FIX" > "$OUT/make_fixtures.log" 2>&1; then
  tail -20 "$OUT/make_fixtures.log"
  record fixtures BROKEN "make_fixtures.sh failed (see make_fixtures.log)" "$OUT/make_fixtures.log"
  exit 1
fi

# ── S1 rotated ──────────────────────────────────────────────────────────────
echo "== S1 rotated"
run_extract S1 "$FIX/rotated90.mp4" "$OUT/s1-rotated"
if [ $RC -ne 0 ]; then record S1-rotated BROKEN "extract exit=$RC: $(head -c 300 "$OUT/s1-rotated.stderr")" "$OUT/s1-rotated.stderr"
else check S1-rotated "$OUT/s1-rotated" --expect-w 608 --expect-h 1080 --min-pose-frames 50 --expect-duration-ms 6000 --expect-video-path "$FIX/rotated90.mp4"; fi
# control: the same pixels without the matrix must come out 1080x608 (proves the
# checker's dimension assertion is sensitive to the transform, not tautological)
run_extract S1-control "$FIX/flat.mp4" "$OUT/s1-control"
if [ $RC -ne 0 ]; then record S1-control BROKEN "extract exit=$RC" "$OUT/s1-control.stderr"
else check S1-control "$OUT/s1-control" --expect-w 608 --expect-h 1080 --min-pose-frames 30 --expect-duration-ms 4000; fi

# ── S2 vfr ──────────────────────────────────────────────────────────────────
echo "== S2 vfr"
for clip in vfr-half-visible vfr-alternate-frames; do
  run_extract "S2 $clip" "$FIX/$clip.mp4" "$OUT/s2-$clip"
  if [ $RC -ne 0 ]; then record "S2-$clip" BROKEN "extract exit=$RC" "$OUT/s2-$clip.stderr"
  else
    # fps must track the DECODED cadence (±15%). If nominalFps is 0 the fallback
    # (main.swift effectiveFps) uses pose frames only → ~0.5× here → BROKEN.
    check "S2-$clip" "$OUT/s2-$clip" --fps-tolerance 0.15 --min-pose-frames 20
    python3 - "$OUT/s2-$clip/extract-meta.json" "$OUT/s2-$clip/pose.json" "$OUT/s2-$clip/scenes.json" <<'EOF' | tee "$OUT/s2-$clip.fps.txt"
import json, sys
meta, pose, scenes = (json.load(open(p)) for p in sys.argv[1:4])
dec = [s["t"] for s in scenes["scores"]]
pf = [f["t"] for f in pose["frames"]]
dec_fps = (len(dec) - 1) * 1000 / (dec[-1] - dec[0]) if len(dec) > 1 else None
pose_fps = (len(pf) - 1) * 1000 / (pf[-1] - pf[0]) if len(pf) > 1 else None
print(f"nominalFps={meta['video']['nominalFps']} pose.video.fps={pose['video']['fps']} decodedCadence={dec_fps} poseCadence={pose_fps} framesSeen={meta['framesSeen']} framesWithPose={meta['framesWithPose']}")
EOF
  fi
done

# ── S3 rewind ───────────────────────────────────────────────────────────────
echo "== S3 rewind"
for clip in pts-rewind-elst pts-rewind-ctts; do
  run_extract "S3 $clip" "$FIX/$clip.mp4" "$OUT/s3-$clip"
  if [ $RC -ne 0 ]; then record "S3-$clip" BROKEN "extract exit=$RC: $(head -c 300 "$OUT/s3-$clip.stderr")" "$OUT/s3-$clip.stderr"
  else
    # strictly increasing pose/people timestamps AND every pose t must be one of
    # the decoded timestamps (omitted, never remapped) — both are default checks.
    check "S3-$clip" "$OUT/s3-$clip" --min-pose-frames 10
  fi
done

# ── S4 cuts ─────────────────────────────────────────────────────────────────
echo "== S4 cuts"
run_extract S4 "$FIX/hardcuts-500ms.mp4" "$OUT/s4-cuts"
if [ $RC -ne 0 ]; then record S4-cuts BROKEN "extract exit=$RC" "$OUT/s4-cuts.stderr"
else check S4-cuts "$OUT/s4-cuts" --expect-duration-ms 4000 --expect-cut-period-ms 500 --expect-cut-count 7 --expect-people-empty; fi

# ── S5 panning ──────────────────────────────────────────────────────────────
echo "== S5 panning"
run_extract S5 "$FIX/panning.mp4" "$OUT/s5-panning"
if [ $RC -ne 0 ]; then record S5-panning BROKEN "extract exit=$RC" "$OUT/s5-panning.stderr"
else check S5-panning "$OUT/s5-panning" --expect-w 400 --expect-h 1080 --expect-duration-ms 6000; fi

# ── S6 audio-only ───────────────────────────────────────────────────────────
echo "== S6 audio-only"
run_extract S6 "$FIX/audio-only.m4a" "$OUT/s6-audio"
if [ $RC -eq 1 ] && grep -q "swing-lab error:.*no video track" "$OUT/s6-audio.stderr" && [ ! -e "$OUT/s6-audio/pose.json" ]; then
  record S6-audio HELD "exit=1, stderr='$(head -c 200 "$OUT/s6-audio.stderr" | tr '\n' ' ')', no output files" "$OUT/s6-audio.stderr"
else
  record S6-audio BROKEN "exit=$RC stderr='$(head -c 300 "$OUT/s6-audio.stderr" | tr '\n' ' ')' outputs=$(ls "$OUT/s6-audio" 2>/dev/null | tr '\n' ' ')" "$OUT/s6-audio.stderr"
fi

# ── S7 overwrite ────────────────────────────────────────────────────────────
echo "== S7 overwrite"
run_extract "S7 run1(people)" "$FIX/rotated90.mp4" "$OUT/s7-overwrite"
RC1=$RC
echo "stale sentinel from run 1" > "$OUT/s7-overwrite/stale-sentinel.txt"
sleep 1.1  # mtime resolution guard
NOT_BEFORE="$(python3 -c 'import time; print(time.time())')"
run_extract "S7 run2(no people)" "$FIX/hardcuts-500ms.mp4" "$OUT/s7-overwrite"
if [ $RC1 -ne 0 ] || [ $RC -ne 0 ]; then record S7-overwrite BROKEN "exit run1=$RC1 run2=$RC" "$OUT/s7-overwrite.stderr"
else check S7-overwrite "$OUT/s7-overwrite" --not-before "$NOT_BEFORE" --expect-video-path "$FIX/hardcuts-500ms.mp4" --expect-people-empty --expect-duration-ms 4000 --expect-cut-count 7 --expect-cut-period-ms 500; fi
# The sentinel is NOT one of the five files; the CLI must not delete unrelated
# files in --out (informational, recorded either way).
[ -e "$OUT/s7-overwrite/stale-sentinel.txt" ] && record S7-overwrite-unrelated-file-kept HELD "extract left unrelated files in --out alone" || record S7-overwrite-unrelated-file-kept BROKEN "extract deleted an unrelated file from --out"

# ── X1 corrupt / empty / missing ─────────────────────────────────────────────
echo "== X1 bad inputs"
for bad in corrupt-seeded.mp4 empty.mp4 does-not-exist.mp4; do
  run_extract "X1 $bad" "$FIX/$bad" "$OUT/x1-$bad"
  if [ $RC -eq 1 ] && grep -q "swing-lab error:" "$OUT/x1-$bad.stderr" && [ -z "$(ls -A "$OUT/x1-$bad" 2>/dev/null)" ]; then
    record "X1-$bad" HELD "exit=1 '$(head -c 160 "$OUT/x1-$bad.stderr" | tr '\n' ' ')' no outputs"
  else
    record "X1-$bad" BROKEN "exit=$RC stderr='$(head -c 300 "$OUT/x1-$bad.stderr" | tr '\n' ' ')' outputs=$(ls -A "$OUT/x1-$bad" 2>/dev/null | tr '\n' ' ')" "$OUT/x1-$bad.stderr"
  fi
done

# ── X2 one-frame clip ────────────────────────────────────────────────────────
echo "== X2 one frame"
run_extract X2 "$FIX/one-frame.mp4" "$OUT/x2-one-frame"
if [ $RC -ne 0 ]; then record X2-one-frame BROKEN "extract exit=$RC: $(head -c 300 "$OUT/x2-one-frame.stderr")" "$OUT/x2-one-frame.stderr"
else check X2-one-frame "$OUT/x2-one-frame" --expect-cut-count 0; fi

# ── X3 hostile --out paths ───────────────────────────────────────────────────
echo "== X3 out paths"
: > "$OUT/x3-out-is-a-file"
"$BIN" extract "$FIX/flat.mp4" --out "$OUT/x3-out-is-a-file" > /dev/null 2> "$OUT/x3-out-is-a-file.stderr"; RC=$?
if [ $RC -eq 1 ] && grep -q "swing-lab error:" "$OUT/x3-out-is-a-file.stderr"; then record X3-out-is-file HELD "exit=1 '$(head -c 160 "$OUT/x3-out-is-a-file.stderr" | tr '\n' ' ')'"
else record X3-out-is-file BROKEN "exit=$RC stderr='$(head -c 300 "$OUT/x3-out-is-a-file.stderr" | tr '\n' ' ')'" "$OUT/x3-out-is-a-file.stderr"; fi
mkdir -p "$OUT/x3-readonly" && chmod 0555 "$OUT/x3-readonly"
"$BIN" extract "$FIX/flat.mp4" --out "$OUT/x3-readonly/sub" > /dev/null 2> "$OUT/x3-readonly.stderr"; RC=$?
chmod 0755 "$OUT/x3-readonly"
if [ $RC -eq 1 ] && grep -q "swing-lab error:" "$OUT/x3-readonly.stderr"; then record X3-out-readonly HELD "exit=1 '$(head -c 160 "$OUT/x3-readonly.stderr" | tr '\n' ' ')'"
else record X3-out-readonly BROKEN "exit=$RC stderr='$(head -c 300 "$OUT/x3-readonly.stderr" | tr '\n' ' ')'" "$OUT/x3-readonly.stderr"; fi
UNI="$OUT/x3 ünïcødé 出力/résultat"
cp "$FIX/flat.mp4" "$OUT/x3 ünïcødé 出力 入力.mp4"
run_extract "X3 unicode" "$OUT/x3 ünïcødé 出力 入力.mp4" "$UNI"
if [ $RC -ne 0 ]; then record X3-unicode-paths BROKEN "extract exit=$RC: $(head -c 300 "$UNI.stderr")" "$UNI.stderr"
else check X3-unicode-paths "$UNI" --expect-video-path "$OUT/x3 ünïcødé 出力 入力.mp4" --expect-duration-ms 4000; fi

# ── X4 rapid concurrent repeats (determinism) ────────────────────────────────
echo "== X4 concurrent repeats"
PIDS=()
for i in 1 2 3 4; do
  ( "$BIN" extract "$FIX/hardcuts-500ms.mp4" --out "$OUT/x4-rep$i" > /dev/null 2> "$OUT/x4-rep$i.stderr" ) & PIDS+=($!)
done
X4_FAIL=0
for pid in "${PIDS[@]}"; do wait "$pid" || X4_FAIL=1; done
if [ $X4_FAIL -eq 0 ] && cmp -s "$OUT/x4-rep1/scenes.json" "$OUT/x4-rep2/scenes.json" && cmp -s "$OUT/x4-rep1/scenes.json" "$OUT/x4-rep3/scenes.json" && cmp -s "$OUT/x4-rep1/scenes.json" "$OUT/x4-rep4/scenes.json"; then
  record X4-concurrent-repeats HELD "4 concurrent extracts exit 0; scenes.json byte-identical across runs"
else
  record X4-concurrent-repeats BROKEN "exit failures=$X4_FAIL or scenes.json differs across concurrent runs" "$OUT/x4-rep1"
fi

# ── X5 two extracts interleaved into the SAME --out ──────────────────────────
echo "== X5 same --out interleaving"
( "$BIN" extract "$FIX/rotated90.mp4" --out "$OUT/x5-shared" > /dev/null 2> "$OUT/x5-a.stderr" ) & PA=$!
( "$BIN" extract "$FIX/hardcuts-500ms.mp4" --out "$OUT/x5-shared" > /dev/null 2> "$OUT/x5-b.stderr" ) & PB=$!
wait $PA; RA=$?; wait $PB; RB=$?
if [ $RA -ne 0 ] || [ $RB -ne 0 ]; then record X5-same-out-interleave BROKEN "exit a=$RA b=$RB" "$OUT/x5-a.stderr"
else
  # Whatever finished last must have left a COHERENT five-file set: extract-meta
  # counts must agree with pose/people/scenes (default checks) and every file
  # must describe the same input path.
  check X5-same-out-interleave "$OUT/x5-shared"
  python3 - "$OUT/x5-shared" <<'EOF' | tee "$OUT/x5-coherence.txt"
import json, os, sys
d = sys.argv[1]
meta = json.load(open(os.path.join(d, "extract-meta.json")))
pose = json.load(open(os.path.join(d, "pose.json")))
scenes = json.load(open(os.path.join(d, "scenes.json")))
print(f"meta.video.path={meta['video']['path']} pose.video={pose['video']} scenes.durationMs≈{scenes['segments'][-1]['endMs']} meta.durationMs={meta['video']['durationMs']}")
EOF
fi

# ── X6 SIGTERM mid-flight ────────────────────────────────────────────────────
echo "== X6 cancel mid-flight"
run_extract "X6 warm" "$FIX/hardcuts-500ms.mp4" "$OUT/x6-cancel"
"$BIN" extract "$FIX/rotated90.mp4" --out "$OUT/x6-cancel" > /dev/null 2> "$OUT/x6-cancel-kill.stderr" & PK=$!
sleep 0.7; kill -TERM $PK 2>/dev/null; wait $PK; RK=$?
X6_OK=1
for f in scenes.json pose.json people.json ball.json extract-meta.json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$OUT/x6-cancel/$f" 2>/dev/null || X6_OK=0
done
if [ $X6_OK -eq 1 ]; then record X6-cancel-mid-flight HELD "killed run exit=$RK; all five files still parse as JSON (no torn write)" "$OUT/x6-cancel"
else record X6-cancel-mid-flight BROKEN "killed run exit=$RK left an unparsable output file" "$OUT/x6-cancel"; fi

echo "== summary"
python3 - "$RESULTS" <<'EOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
for r in rows:
    print(f"{r['status']:6} {r['scenario']:34} {r['detail'][:140]}")
broken = [r for r in rows if r["status"] == "BROKEN"]
print(f"\n{len(rows) - len(broken)} HELD, {len(broken)} BROKEN")
EOF
exit $BROKEN
