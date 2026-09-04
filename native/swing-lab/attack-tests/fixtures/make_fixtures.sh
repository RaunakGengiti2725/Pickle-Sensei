#!/usr/bin/env bash
# Deterministic adversarial media for `swing-lab extract`.
#
# Every fixture is derived from the committed reference clip
# (datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4 — real people, the
# same file Mac Full Verify extracts) or from synthetic lavfi sources, so the
# harness needs nothing that is not already in the repo plus ffmpeg/ffprobe.
# No randomness is used except the corrupt-bytes fixture, which is seeded
# (SEED below) and therefore byte-identical on every run.
#
# Each fixture is VERIFIED after it is written (ffprobe + fixtures/mp4_edit.py):
# the script exits non-zero if a fixture does not actually have the property
# it is supposed to attack with (e.g. a rotation tag that did not stick).
#
# usage: make_fixtures.sh <out-dir>        (writes <out-dir>/*.mp4|*.m4a|*.bin
#                                            and <out-dir>/manifest.json)
set -euo pipefail

OUT="${1:?usage: make_fixtures.sh <out-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
REF="$REPO/datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4"
SEED=20260904

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg / apt install ffmpeg)"; exit 2; }
command -v ffprobe >/dev/null || { echo "ffprobe is required"; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }
[ -f "$REF" ] || { echo "reference clip missing: $REF"; exit 2; }

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
FF=(ffmpeg -hide_banner -loglevel error -nostdin -y)
# libx264 is what the reference clip uses; -bf 0 keeps the sample tables free
# of ctts so the rewind mutator can add its own. -g 12 keeps seeking sane.
X264=(-c:v libx264 -preset veryfast -pix_fmt yuv420p -bf 0 -g 12 -an)

probe() { ffprobe -v error -select_streams v:0 -show_entries "$1" -of default=noprint_wrappers=1:nokey=1 "$2"; }
fail() { echo "FIXTURE BROKEN: $*" >&2; exit 1; }

echo "== reference clip"
python3 "$HERE/mp4_edit.py" inspect "$REF"

# ── flat.mp4: first 4 s of the reference, re-muxed as a FLAT (non-fragmented,
#    moov-after-mdat) MP4 — the base for the rewind mutators.
echo "== flat.mp4"
"${FF[@]}" -i "$REF" -t 4 "${X264[@]}" "$OUT/flat.mp4"
[ "$(probe stream=nb_frames "$OUT/flat.mp4")" = "96" ] || fail "flat.mp4 should have 96 frames (4 s @ 24 fps), got $(probe stream=nb_frames "$OUT/flat.mp4")"

# ── rotated90.mp4 [rotated]: pixels stored LANDSCAPE (1080x608, the reference
#    frame turned 90° counter-clockwise) plus a +90° display matrix so the
#    upright presentation is 608x1080 again. A reader that ignores the
#    preferredTransform reports 1080x608 and hands Vision sideways people.
#    The matrix is the exact iPhone-portrait shape (a=0,b=1,c=-1,d=0,
#    tx=stored height) written by mp4_edit.py, not an ffmpeg `rotate` tag
#    (ffmpeg 4.4 drops that tag on re-encode and writes no translation).
echo "== rotated90.mp4"
"${FF[@]}" -i "$REF" -t 6 -vf transpose=2 "${X264[@]}" "$OUT/rotated90.stored.mp4"
python3 "$HERE/mp4_edit.py" rotate-90cw "$OUT/rotated90.stored.mp4" "$OUT/rotated90.mp4"
rm -f "$OUT/rotated90.stored.mp4"
[ "$(probe stream=width,height "$OUT/rotated90.mp4" | tr '\n' 'x')" = "1080x608x" ] || fail "rotated90.mp4 must store 1080x608 pixels"
python3 "$HERE/mp4_edit.py" inspect "$OUT/rotated90.mp4" | grep -q 'matrix=\[0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 608.0, 0.0, 1.0\]' \
  || fail "rotated90.mp4 does not carry the 90° CW display matrix"
# The rotation sense must bring the picture back upright: with autorotate on,
# frame 0 of rotated90.mp4 must match frame 0 of the reference (PSNR > 30 dB).
PSNR_LOG="$OUT/rotated90.psnr.log"
"${FF[@]}" -i "$OUT/rotated90.mp4" -i "$REF" -frames:v 1 -lavfi "[0:v][1:v]psnr=stats_file=$PSNR_LOG" -f null - 2>/dev/null
PSNR_AVG="$(sed -n 's/.*psnr_avg:\([0-9.inf]*\).*/\1/p' "$PSNR_LOG" | head -1)"
python3 - "$PSNR_AVG" <<'EOF' || fail "autorotated rotated90.mp4 does not match the upright reference (psnr_avg=$PSNR_AVG)"
import sys
value = sys.argv[1]
sys.exit(0 if value == "inf" or float(value) > 30 else 1)
EOF

# ── vfr-half-visible.mp4 [vfr]: 8 s, person visible during EVEN seconds and a
#    black frame during ODD seconds; irregular frame selection + vfr muxing
#    so the container is genuinely variable-frame-rate. The pose stream
#    covers ~half of the decoded frames.
echo "== vfr-half-visible.mp4"
"${FF[@]}" -i "$REF" -t 8 \
  -vf "select='not(mod(n,2))+not(mod(n,5))',drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(mod(t,2),1)'" \
  -vsync vfr "${X264[@]}" "$OUT/vfr-half-visible.mp4"
# ── vfr-alternate-frames.mp4 [vfr]: constant cadence, person on EVEN frames
#    only (odd frames black). Pose-frame cadence is exactly half the decoded
#    cadence, so an fps derived from pose frames under-reports by 2×.
echo "== vfr-alternate-frames.mp4"
"${FF[@]}" -i "$REF" -t 6 \
  -vf "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(mod(n,2),1)'" \
  "${X264[@]}" "$OUT/vfr-alternate-frames.mp4"

# ── pts-rewind-elst.mp4 [rewind]: edit list plays media [0,2s) then rewinds to
#    media [1s,3s) — the shape produced by edit-list concatenation.
echo "== pts-rewind-elst.mp4"
python3 "$HERE/mp4_edit.py" elst-rewind "$OUT/flat.mp4" "$OUT/pts-rewind-elst.mp4" --first-end 2 --second-start 1 --second-end 3
python3 "$HERE/mp4_edit.py" inspect "$OUT/pts-rewind-elst.mp4" | grep -q "'mediaTime': 12288" \
  || python3 "$HERE/mp4_edit.py" inspect "$OUT/pts-rewind-elst.mp4" | grep -q "'mediaTime': 1[0-9]*, 'rate': 1.0}\]" \
  || fail "pts-rewind-elst.mp4 has no rewinding edit"
# ── pts-rewind-ctts.mp4 [rewind]: raw sample PTS jumps back 0.75 s for 15
#    samples starting at sample 30 (negative composition offsets, ctts v1).
echo "== pts-rewind-ctts.mp4"
python3 "$HERE/mp4_edit.py" ctts-rewind "$OUT/flat.mp4" "$OUT/pts-rewind-ctts.mp4" --from-sample 30 --samples 15 --rewind-seconds 0.75
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "$OUT/pts-rewind-ctts.mp4" > "$OUT/pts-rewind-ctts.pts.txt"
python3 - "$OUT/pts-rewind-ctts.pts.txt" <<'EOF' || fail "pts-rewind-ctts.mp4 presentation timestamps never rewind"
import sys
pts = [float(line) for line in open(sys.argv[1]) if line.strip() and line.strip() != "N/A"]
rewinds = [(i, pts[i - 1], pts[i]) for i in range(1, len(pts)) if pts[i] < pts[i - 1]]
print(f"pts-rewind-ctts.mp4: {len(pts)} frames, {len(rewinds)} backwards step(s), first={rewinds[:2]}")
sys.exit(0 if rewinds else 1)
EOF

# ── hardcuts-500ms.mp4 [cuts]: eight 500 ms solid-luma shots, 30 fps, 4.000 s.
#    Expected cuts: 500, 1000, …, 3500 (7 cuts, 8 segments).
echo "== hardcuts-500ms.mp4"
LEVELS=(0x101010 0xEBEBEB 0x505050 0xB0B0B0 0x303030 0xD0D0D0 0x707070 0x909090)
FILTER=""
INPUTS=()
for i in "${!LEVELS[@]}"; do
  INPUTS+=(-f lavfi -i "color=c=${LEVELS[$i]}:s=640x360:r=30:d=0.5")
  FILTER+="[$i:v]"
done
FILTER+="concat=n=${#LEVELS[@]}:v=1:a=0,format=yuv420p[v]"
"${FF[@]}" "${INPUTS[@]}" -filter_complex "$FILTER" -map "[v]" -r 30 -frames:v 120 "${X264[@]}" "$OUT/hardcuts-500ms.mp4"
[ "$(probe stream=nb_frames "$OUT/hardcuts-500ms.mp4")" = "120" ] || fail "hardcuts-500ms.mp4 should have exactly 120 frames"

# ── panning.mp4 [panning]: a 400-px-wide window sweeping left→right across the
#    reference frame over 6 s — a non-stationary camera.
echo "== panning.mp4"
"${FF[@]}" -i "$REF" -t 6 -vf "crop=w=400:h=1080:x='(iw-400)*t/6':y=0" "${X264[@]}" "$OUT/panning.mp4"
[ "$(probe stream=width,height "$OUT/panning.mp4" | tr '\n' 'x')" = "400x1080x" ] || fail "panning.mp4 dimensions"

# ── audio-only.m4a [audio]: 2 s of silence, no video track.
echo "== audio-only.m4a"
"${FF[@]}" -f lavfi -i anullsrc=r=44100:cl=mono -t 2 -c:a aac -b:a 32k "$OUT/audio-only.m4a"
[ -z "$(probe stream=codec_type "$OUT/audio-only.m4a")" ] || fail "audio-only.m4a unexpectedly has a video stream"

# ── one-frame.mp4 [edge]: a single decoded frame (no cadence derivable).
echo "== one-frame.mp4"
"${FF[@]}" -i "$REF" -frames:v 1 "${X264[@]}" "$OUT/one-frame.mp4"
[ "$(probe stream=nb_frames "$OUT/one-frame.mp4")" = "1" ] || fail "one-frame.mp4 should have exactly 1 frame"

# ── corrupt.bin [edge]: 64 KiB of seeded pseudo-random bytes behind an .mp4
#    name; empty.mp4: zero bytes.
echo "== corrupt-seeded.mp4 / empty.mp4"
python3 - "$OUT/corrupt-seeded.mp4" "$SEED" <<'EOF'
import random, sys
rng = random.Random(int(sys.argv[2]))
open(sys.argv[1], "wb").write(bytes(rng.getrandbits(8) for _ in range(65536)))
EOF
: > "$OUT/empty.mp4"

# ── manifest: every fixture with its ffprobe facts + the expectations the
#    checker enforces, so run_mac_attacks.sh and the XCTest read ONE source.
echo "== manifest.json"
python3 - "$OUT" "$SEED" <<'EOF'
import json, os, subprocess, sys
out, seed = sys.argv[1], int(sys.argv[2])

def probe(name):
    path = os.path.join(out, name)
    try:
        raw = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=index,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames",
             "-of", "json", path], capture_output=True, text=True, check=True).stdout
        return json.loads(raw)
    except subprocess.CalledProcessError as error:
        return {"ffprobeError": error.stderr.strip()[:300]}

fixtures = {
    "rotated90.mp4": {"scenario": "rotated", "expect": {"w": 608, "h": 1080, "minPoseFrames": 50}},
    "vfr-half-visible.mp4": {"scenario": "vfr", "expect": {"minPoseFrames": 20}},
    "vfr-alternate-frames.mp4": {"scenario": "vfr", "expect": {"minPoseFrames": 40}},
    "pts-rewind-elst.mp4": {"scenario": "rewind", "expect": {"durationMs": 4000}},
    "pts-rewind-ctts.mp4": {"scenario": "rewind", "expect": {}},
    "hardcuts-500ms.mp4": {"scenario": "cuts", "expect": {"durationMs": 4000, "cutPeriodMs": 500, "cutCount": 7, "peopleEmpty": True}},
    "panning.mp4": {"scenario": "panning", "expect": {"w": 400, "h": 1080}},
    "audio-only.m4a": {"scenario": "audio", "expect": {"exitCode": 1, "stderrContains": "no video track"}},
    "one-frame.mp4": {"scenario": "edge", "expect": {"exitCode": 0}},
    "corrupt-seeded.mp4": {"scenario": "edge", "expect": {"exitCode": 1}, "seed": seed},
    "empty.mp4": {"scenario": "edge", "expect": {"exitCode": 1}},
    "flat.mp4": {"scenario": "base", "expect": {"durationMs": 4000}},
}
for name, entry in fixtures.items():
    entry["bytes"] = os.path.getsize(os.path.join(out, name))
    entry["ffprobe"] = probe(name)
json.dump({"seed": seed, "fixtures": fixtures}, open(os.path.join(out, "manifest.json"), "w"), indent=2, sort_keys=True)
print(json.dumps({k: (v["ffprobe"].get("format", {}).get("duration"), v["bytes"]) for k, v in fixtures.items()}, indent=1))
EOF

echo "fixtures written to $OUT"
