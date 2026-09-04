#!/usr/bin/env bash
# ADVERSARIAL PASS (native-swing-lab-camera-engine #2) — swing-lab CLI attacks.
#
# Apple plane ONLY (AVFoundation/Vision): run on the M4 runner or any macOS 13+
# host with Xcode. Linux cannot execute this; the static pin for the same
# properties is tools/attack/native-swing-lab/static-review.test.mjs.
#
# Builds native/swing-lab in Release, then attacks:
#   S1a  extract with --out omitted                 → usage(), exit 2, nothing written
#   S1b  extract with --out under a read-only dir   → createDirectory throws, exit 1,
#                                                     stderr "swing-lab error:", no output dir
#   S2a  overlay with a TRUNCATED pose.json         → exit 1, "swing-lab error:", no o.mov
#   S2b  overlay with frames missing `l` / garbage  → exit 0 AND an output movie (malformed
#                                                     frames skipped) — or exit 1; never a crash
#                                                     (exit ≥ 128 / signal) either way
#   S3a  extract on a 0-byte .mov                   → exit 1, "swing-lab error:", DIR has no pose.json
#   S3b  extract on a .mov with a video track but   → the honest outcome is exit 1 + no pose.json;
#        ZERO decodable samples                       main.swift has no framesSeen==0 guard, so a
#                                                     `frames: []` pose.json + exit 0 is the
#                                                     predicted BREAK (partial-output honesty)
#
# Every step records command, exit code and artifact path into $OUT/report.jsonl.
# Usage: tools/attack/native-swing-lab/cli-attacks.sh [--clip <video>] [--out <dir>]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIP="$ROOT/datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4"
OUT="$ROOT/artifacts/attack-native-2/cli-attacks"
while [ $# -gt 0 ]; do
  case "$1" in
    --clip) CLIP="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 64 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "cli-attacks.sh: Apple plane only (uname=$(uname -s)); nothing executed, nothing claimed." >&2
  exit 75 # EX_TEMPFAIL — not a pass
fi

mkdir -p "$OUT"
REPORT="$OUT/report.jsonl"
: > "$REPORT"
FAILED=0

record() { # name expectation actual status detail
  printf '{"scenario":"%s","expected":"%s","actual":"%s","status":"%s","detail":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" >> "$REPORT"
  echo "[$4] $1 — expected: $2 — actual: $3 ($5)"
  [ "$4" = "HELD" ] || FAILED=1
}

run() { # name, then command…; captures stdout/stderr, returns exit code in RC
  local name="$1"; shift
  "$@" > "$OUT/$name.stdout" 2> "$OUT/$name.stderr"
  RC=$?
  echo "\$ $* → exit $RC" > "$OUT/$name.cmd"
}

echo "--- build native/swing-lab (release) ---"
(cd "$ROOT/native/swing-lab" && swift build -c release 2>&1 | tee "$OUT/swift-build.log" | tail -5)
BIN="$(cd "$ROOT/native/swing-lab" && swift build -c release --show-bin-path)/swing-lab"
[ -x "$BIN" ] || { echo "no binary at $BIN"; exit 1; }
[ -f "$CLIP" ] || { echo "clip missing: $CLIP"; exit 1; }

# ── S1a: --out omitted ─────────────────────────────────────────────────────────
run s1a-out-omitted "$BIN" extract "$CLIP"
if [ "$RC" -eq 2 ] && grep -q '^usage:' "$OUT/s1a-out-omitted.stderr"; then
  record S1a "exit 2 + usage on stderr" "exit $RC" HELD "$OUT/s1a-out-omitted.stderr"
else
  record S1a "exit 2 + usage on stderr" "exit $RC" BROKEN "$OUT/s1a-out-omitted.stderr"
fi
# `--out` given as the LAST token (no value) must also be usage, not a silent run.
run s1a-out-dangling "$BIN" extract "$CLIP" --out
if [ "$RC" -eq 2 ]; then
  record S1a-dangling "exit 2 (dangling --out)" "exit $RC" HELD "$OUT/s1a-out-dangling.stderr"
else
  record S1a-dangling "exit 2 (dangling --out)" "exit $RC" BROKEN "$OUT/s1a-out-dangling.stderr"
fi

# ── S1b: --out under a read-only directory ────────────────────────────────────
RO="$OUT/readonly-parent"; rm -rf "$RO"; mkdir -p "$RO"; chmod 0555 "$RO"
run s1b-readonly "$BIN" extract "$CLIP" --out "$RO/child"
chmod 0755 "$RO"
if [ "$RC" -eq 1 ] && grep -q '^swing-lab error:' "$OUT/s1b-readonly.stderr" && [ ! -e "$RO/child/pose.json" ]; then
  record S1b "exit 1 + 'swing-lab error:' + no output" "exit $RC" HELD "$OUT/s1b-readonly.stderr"
else
  record S1b "exit 1 + 'swing-lab error:' + no output" "exit $RC; pose.json present=$([ -e "$RO/child/pose.json" ] && echo yes || echo no)" BROKEN "$OUT/s1b-readonly.stderr"
fi

# ── Reference extract (feeds S2) ──────────────────────────────────────────────
REF="$OUT/reference-extract"; rm -rf "$REF"
run ref-extract "$BIN" extract "$CLIP" --out "$REF"
[ "$RC" -eq 0 ] && [ -f "$REF/pose.json" ] || { echo "reference extract failed (exit $RC)"; cat "$OUT/ref-extract.stderr"; exit 1; }

# ── S2a: truncated pose.json ──────────────────────────────────────────────────
SIZE=$(stat -f%z "$REF/pose.json")
head -c $((SIZE / 2)) "$REF/pose.json" > "$OUT/truncated.json"
run s2a-truncated "$BIN" overlay "$CLIP" --pose "$OUT/truncated.json" --out "$OUT/s2a.mov"
if [ "$RC" -eq 1 ] && grep -q '^swing-lab error:' "$OUT/s2a-truncated.stderr" && [ ! -e "$OUT/s2a.mov" ]; then
  record S2a "exit 1 + 'swing-lab error:' + no o.mov" "exit $RC" HELD "$OUT/s2a-truncated.stderr"
else
  record S2a "exit 1 + 'swing-lab error:' + no o.mov" "exit $RC; o.mov present=$([ -e "$OUT/s2a.mov" ] && echo yes || echo no)" BROKEN "$OUT/s2a-truncated.stderr"
fi

# ── S2b: frames missing `l`, wrong-typed fields, non-object frames ────────────
python3 - "$REF/pose.json" "$OUT/missing-l.json" <<'PY'
import json, sys, random
random.seed(0x5eed0004)
pose = json.load(open(sys.argv[1]))
frames = pose["frames"]
for i, frame in enumerate(frames):
    r = random.random()
    if r < 0.3:
        frame.pop("l", None)                     # missing landmarks
    elif r < 0.4:
        frame["l"] = "not-an-array"              # wrong type
    elif r < 0.5:
        frame["l"] = [{"n": "left_wrist"}, {"x": 0.5, "y": 0.5}, 7, None]  # partial marks
    elif r < 0.55:
        frame["t"] = "12"                        # string timestamp → frame skipped
    elif r < 0.6:
        frame["l"] = [{"n": "left_wrist", "x": float("1e308"), "y": -1e308, "v": 2.0}]  # off-canvas
frames.append("garbage-frame")
frames.append(None)
frames.append({"t": 999999999999, "c": 1.0, "l": []})
frames.append({"t": -1, "c": 1.0, "l": [{"n": "rüçkhand-\U0001F3D3", "x": 0.1, "y": 0.1, "v": 1}]})
json.dump(pose, open(sys.argv[2], "w"))
PY
run s2b-missing-l "$BIN" overlay "$CLIP" --pose "$OUT/missing-l.json" --out "$OUT/s2b.mov"
if [ "$RC" -ge 128 ]; then
  record S2b "exit 0 with output (frames skipped) or exit 1; never a crash" "CRASH exit $RC" BROKEN "$OUT/s2b-missing-l.stderr"
elif [ "$RC" -eq 0 ] && [ -s "$OUT/s2b.mov" ]; then
  record S2b "exit 0 with output (frames skipped) or exit 1; never a crash" "exit 0, o.mov $(stat -f%z "$OUT/s2b.mov") bytes" HELD "$OUT/s2b-missing-l.stdout"
elif [ "$RC" -eq 1 ] && grep -q '^swing-lab error:' "$OUT/s2b-missing-l.stderr"; then
  record S2b "exit 0 with output (frames skipped) or exit 1; never a crash" "exit 1 (rejected)" HELD "$OUT/s2b-missing-l.stderr"
else
  record S2b "exit 0 with output (frames skipped) or exit 1; never a crash" "exit $RC, o.mov present=$([ -s "$OUT/s2b.mov" ] && echo yes || echo no)" BROKEN "$OUT/s2b-missing-l.stderr"
fi
# Top-level JSON that is not an object (array) — overlay must not crash.
echo '[]' > "$OUT/array.json"
run s2c-array "$BIN" overlay "$CLIP" --pose "$OUT/array.json" --out "$OUT/s2c.mov"
if [ "$RC" -lt 128 ]; then
  record S2c "no crash on non-object pose JSON" "exit $RC" HELD "$OUT/s2c-array.stderr"
else
  record S2c "no crash on non-object pose JSON" "CRASH exit $RC" BROKEN "$OUT/s2c-array.stderr"
fi

# ── S3a: 0-byte .mov ──────────────────────────────────────────────────────────
: > "$OUT/empty.mov"
D3A="$OUT/s3a-out"; rm -rf "$D3A"
run s3a-zero-byte "$BIN" extract "$OUT/empty.mov" --out "$D3A"
if [ "$RC" -eq 1 ] && grep -q '^swing-lab error:' "$OUT/s3a-zero-byte.stderr" && [ ! -e "$D3A/pose.json" ]; then
  record S3a "exit 1 + 'swing-lab error:' + no pose.json" "exit $RC (out dir created=$([ -d "$D3A" ] && echo yes || echo no))" HELD "$OUT/s3a-zero-byte.stderr"
else
  record S3a "exit 1 + 'swing-lab error:' + no pose.json" "exit $RC; pose.json present=$([ -e "$D3A/pose.json" ] && echo yes || echo no)" BROKEN "$OUT/s3a-zero-byte.stderr"
fi

# ── S3b: valid container, video track, ZERO decodable frames ──────────────────
# ffmpeg is the most portable way to mint one; without it, fall back to a
# 1-frame clip cut to zero duration via AVFoundation-free `head` of the
# reference clip (a truncated mp4: moov present, mdat cut).
Z="$OUT/zero-frames.mov"; rm -f "$Z"
if command -v ffmpeg >/dev/null; then
  ffmpeg -loglevel error -y -f lavfi -i color=c=black:s=64x64:r=30 -frames:v 1 -t 0.001 -c:v h264 -pix_fmt yuv420p "$OUT/one-frame.mov"
  # Strip every sample: remux with -ss past the end so the track keeps its
  # header but carries no samples.
  ffmpeg -loglevel error -y -ss 10 -i "$OUT/one-frame.mov" -c copy "$Z" 2> "$OUT/zero-frames-ffmpeg.stderr"
  echo "ffmpeg remux exit $?" >> "$OUT/zero-frames-ffmpeg.stderr"
fi
if [ ! -s "$Z" ]; then
  # Fallback: mdat-truncated copy of the reference clip (track present, samples unreadable).
  head -c 4096 "$CLIP" > "$Z"
fi
D3B="$OUT/s3b-out"; rm -rf "$D3B"
run s3b-zero-frames "$BIN" extract "$Z" --out "$D3B"
if [ "$RC" -ge 128 ]; then
  record S3b "exit 1 + no pose.json" "CRASH exit $RC" BROKEN "$OUT/s3b-zero-frames.stderr"
elif [ "$RC" -eq 0 ] && [ -e "$D3B/pose.json" ]; then
  FRAMES=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["frames"]))' "$D3B/pose.json")
  SEEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["framesSeen"])' "$D3B/extract-meta.json")
  if [ "$SEEN" -eq 0 ]; then
    record S3b "exit 1 + no pose.json" "exit 0, pose.json written with frames=$FRAMES, framesSeen=$SEEN" BROKEN "$D3B/extract-meta.json"
  else
    record S3b "exit 1 + no pose.json" "input decoded $SEEN frames — not a 0-frame clip; scenario UNTESTED" BROKEN "$D3B/extract-meta.json"
  fi
elif [ "$RC" -eq 1 ] && grep -q '^swing-lab error:' "$OUT/s3b-zero-frames.stderr" && [ ! -e "$D3B/pose.json" ]; then
  record S3b "exit 1 + no pose.json" "exit 1" HELD "$OUT/s3b-zero-frames.stderr"
else
  record S3b "exit 1 + no pose.json" "exit $RC; pose.json present=$([ -e "$D3B/pose.json" ] && echo yes || echo no)" BROKEN "$OUT/s3b-zero-frames.stderr"
fi

# ── Extra: video path omitted but --out present (`extract --out DIR`) ─────────
D4="$OUT/s4-out"; rm -rf "$D4"
run s4-video-omitted "$BIN" extract --out "$D4"
if [ "$RC" -eq 2 ]; then
  record S4 "usage() exit 2 (no video path)" "exit $RC" HELD "$OUT/s4-video-omitted.stderr"
else
  record S4 "usage() exit 2 (no video path)" "exit $RC; out dir created=$([ -d "$D4" ] && echo yes || echo no) (\"--out\" was taken as the video path)" BROKEN "$OUT/s4-video-omitted.stderr"
fi

echo
echo "report: $REPORT"
exit $FAILED
