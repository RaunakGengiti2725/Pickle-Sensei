#!/usr/bin/env bash
# Reproduce the Apple-vs-Linux pose plane comparison for one clip on Linux.
#
# It NEVER triggers a Mac run. The Apple side is read from an already
# downloaded `mac-full-verify` artifact (`gh run download <run id>`); the Linux
# side is produced here with the MediaPipe replay PROXY
# (tools/latency-bench/linux_pose_extract.py) and both are pushed through the
# same TypeScript pipeline (`analyze:video --reuse-extract`) so downstream
# divergence is measured on identical code.
#
# Usage:
#   tools/xc-cv-mac-vision/run_replay_compare.sh \
#     --apple-extract <artifact>/swing-lab-extract \
#     --clip datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4 \
#     --out /tmp/xc-cv \
#     [--python /path/to/venv/bin/python] \
#     [--model /path/to/pose_landmarker_full.task] \
#     [--xcresult <bundle.xcresult> ...]
#
# Requirements on Linux: ffmpeg/ffprobe, a Python with `mediapipe` +
# `opencv-python-headless` (pip install mediapipe opencv-python-headless numpy),
# the MediaPipe pose_landmarker_full.task model, pnpm workspace installed.
#
# Note on AV1: OpenCV's bundled FFmpeg (opencv-python-headless) cannot decode
# the AV1 clips in datasets/pickleball/fresh-candidates (cap.read() fails on
# frame 0, linux_pose_extract.py then exits 0 with framesDecoded=0). The script
# therefore re-muxes the clip frame-exactly to lossless H.264 (`-qp 0`, same
# fps/timestamps) before the Linux extraction and records ffprobe of both
# files so the frame count identity is auditable. The Apple plane always reads
# the ORIGINAL clip.
set -euo pipefail

APPLE_EXTRACT=""
CLIP=""
OUT=""
PYTHON="${PYTHON:-python3}"
MODEL="${MODEL:-}"
XCRESULTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apple-extract) APPLE_EXTRACT="$2"; shift 2 ;;
    --clip) CLIP="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --python) PYTHON="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --xcresult) XCRESULTS+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$APPLE_EXTRACT" || -z "$CLIP" || -z "$OUT" ]]; then
  echo "usage: $0 --apple-extract <dir> --clip <mp4> --out <dir> [--python <bin>] [--model <task>] [--xcresult <bundle>]..." >&2
  exit 2
fi
for f in pose.json people.json extract-meta.json; do
  [[ -f "$APPLE_EXTRACT/$f" ]] || { echo "apple extract missing $f: $APPLE_EXTRACT" >&2; exit 2; }
done
[[ -f "$CLIP" ]] || { echo "clip not found: $CLIP" >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo "ffmpeg required" >&2; exit 2; }
command -v ffprobe >/dev/null || { echo "ffprobe required" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/tools/xc-cv-mac-vision"
mkdir -p "$OUT"
CLIP_ABS="$(cd "$(dirname "$CLIP")" && pwd)/$(basename "$CLIP")"
LOG="$OUT/run_replay_compare.log"
exec > >(tee -a "$LOG") 2>&1
echo "== run_replay_compare $(date -u +%Y-%m-%dT%H:%M:%SZ) repo=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "apple extract: $APPLE_EXTRACT"
echo "clip: $CLIP_ABS"

probe() {
  ffprobe -v error -count_frames -select_streams v:0 \
    -show_entries stream=codec_name,r_frame_rate,nb_read_frames,duration,width,height -of json "$1"
}

echo "== ffprobe source"
probe "$CLIP_ABS" | tee "$OUT/ffprobe-source.json"

echo "== Linux decode probe (OpenCV) on the ORIGINAL clip"
"$PYTHON" - "$CLIP_ABS" > "$OUT/opencv-decode-probe.json" <<'EOF'
import json, sys
import cv2
cap = cv2.VideoCapture(sys.argv[1])
ok, _ = cap.read() if cap.isOpened() else (False, None)
print(json.dumps({
    "video": sys.argv[1],
    "opened": bool(cap.isOpened()),
    "reportedFrameCount": cap.get(cv2.CAP_PROP_FRAME_COUNT),
    "reportedFps": cap.get(cv2.CAP_PROP_FPS),
    "firstFrameReadOk": bool(ok),
    "opencv": cv2.__version__,
}))
EOF
cat "$OUT/opencv-decode-probe.json"

TRANSCODE="$OUT/$(basename "${CLIP_ABS%.*}").lossless-h264.mp4"
echo "== frame-exact lossless re-mux for the Linux decoder -> $TRANSCODE"
ffmpeg -v error -y -i "$CLIP_ABS" -c:v libx264 -qp 0 -pix_fmt yuv420p -vsync passthrough "$TRANSCODE"
probe "$TRANSCODE" | tee "$OUT/ffprobe-transcode.json"

LINUX_DIR="$OUT/linux-mediapipe"
rm -rf "$LINUX_DIR"
mkdir -p "$LINUX_DIR"
echo "== Linux MediaPipe proxy extraction (NOT Apple truth)"
MODEL_ARGS=()
[[ -n "$MODEL" ]] && MODEL_ARGS=(--model "$MODEL")
( time "$PYTHON" "$REPO_ROOT/tools/latency-bench/linux_pose_extract.py" --video "$TRANSCODE" --out "$LINUX_DIR" "${MODEL_ARGS[@]}" ) 2>&1 | tee "$OUT/linux-extract.log"
LINUX_DECODED="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['video']['frameCount'])" "$LINUX_DIR/extract-meta.json")"
LINUX_POSES="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['frames']))" "$LINUX_DIR/pose.json")"
echo "linux framesDecoded(reported frameCount)=$LINUX_DECODED posesWritten=$LINUX_POSES"
if [[ "$LINUX_POSES" -eq 0 ]]; then
  echo "Linux proxy produced zero poses — comparison would be meaningless; failing." >&2
  exit 1
fi

run_pipeline() {
  local src="$1" dst="$2" label="$3"
  rm -rf "$dst"
  cp -r "$src" "$dst"
  echo "== analyze:video --reuse-extract on $label artifacts -> $dst"
  ( cd "$REPO_ROOT" && pnpm -s --filter @pickle/swing-lab analyze:video "$CLIP_ABS" --reuse-extract --no-paddle-worker --out "$dst" ) 2>&1 | tee "$OUT/analyze-$label.log"
}
run_pipeline "$APPLE_EXTRACT" "$OUT/apple-reuse" apple
run_pipeline "$LINUX_DIR" "$OUT/linux-reuse" linux

echo "== compare planes"
python3 "$HERE/compare_pose_planes.py" \
  --apple "$APPLE_EXTRACT" --linux "$LINUX_DIR" \
  --source-video "$CLIP_ABS" \
  --apple-report "$OUT/apple-reuse/report.json" \
  --linux-report "$OUT/linux-reuse/report.json" \
  --out "$OUT/compare"

if [[ ${#XCRESULTS[@]} -gt 0 ]]; then
  echo "== xcresult summaries (sqlite, read-only)"
  python3 "$HERE/xcresult_sqlite_summary.py" --out "$OUT/xcresult-summary.json" "${XCRESULTS[@]}"
fi
echo "== done; artifacts under $OUT"
