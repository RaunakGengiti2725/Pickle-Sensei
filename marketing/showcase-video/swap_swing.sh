#!/bin/bash
# Re-render the showcase with a real swing clip.
# usage: ./swap_swing.sh /path/to/swing.mov [start_seconds] [contact_seconds_into_window]
#   start_seconds  = where in the source clip the 4.6 s capture window begins (default 0)
#   contact        = seconds into that window when the paddle meets the ball (default 1.9)
set -euo pipefail
cd "$(dirname "$0")"
SRC="$1"; START="${2:-0}"; CONTACT="${3:-1.9}"
rm -rf vid/swing && mkdir -p vid/swing
ffmpeg -v error -y -ss "$START" -t 4.6 -i "$SRC" -vf "fps=30,scale=640:-2" -q:v 3 vid/swing/%04d.jpg
N=$(ls vid/swing | wc -l | tr -d ' ')
sed -i '' -E "s/const INTRO_N=151, OUTRO_N=72, SWING_N=[0-9]+;/const INTRO_N=151, OUTRO_N=72, SWING_N=$N;/" timeline.html
sed -i '' -E "s/const contact=[0-9.]+;/const contact=$CONTACT;/" timeline.html
sed -i '' -E "s/const SWING_MODE='[a-z]+';/const SWING_MODE='clip';/" timeline.html
echo "swing frames: $N, contact at ${CONTACT}s"
node render.js --mode=pipe --fps=30 --start=0 --end=41 --out=v_noaudio.mp4
ffmpeg -v error -y -i v_noaudio.mp4 -i audio.wav -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart PickleSensei_showcase.mp4
echo "done: $(pwd)/PickleSensei_showcase.mp4"
