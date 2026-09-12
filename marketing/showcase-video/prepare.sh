#!/bin/bash
# One-time setup for the showcase renderer: copies the fonts and app icon out
# of the app, extracts frames and audio from the swing clip, converts the
# voiceover lines, and mixes the audio track. Needs ffmpeg and python3 with
# numpy + scipy.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(git rev-parse --show-toplevel)"
mkdir -p fonts assets vid/swing
cp "$ROOT"/apps/mobile/assets/fonts/Manrope_*.ttf fonts/
ffmpeg -v error -y -i "$ROOT"/apps/mobile/ios/PickleSensei/Images.xcassets/AppIcon.appiconset/icon-1024.png -vf "scale=520:520" assets/icon520.png
# The swing clip plays inside the phone at 30 fps; 720 px wide is plenty for a 568 px screen.
ffmpeg -v error -y -i clips/swing.mp4 -vf "fps=30,scale=720:-2" -q:v 2 vid/swing/%04d.jpg
# Court ambience under the scan (the committed clip is silent; use the original if you have it).
if ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 clips/swing.mp4 | grep -q audio; then
  ffmpeg -v error -y -i clips/swing.mp4 -vn -ac 2 -ar 48000 swing_audio.wav
else
  ffmpeg -v error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 3.8 swing_audio.wav
fi
for i in 1 2 3 4 5 6 7; do ffmpeg -v error -y -i vo/vo$i.mp3 -ac 2 -ar 48000 vo/vo$i.wav; done
python3 audio.py
echo "swing $(ls vid/swing | wc -l | tr -d ' ') frames, audio.wav written."
echo "Render: node render.js --mode=pipe --out=v_noaudio.mp4 && ffmpeg -i v_noaudio.mp4 -i audio.wav -c:v copy -c:a aac -b:a 192k -shortest PickleSensei_showcase.mp4"
