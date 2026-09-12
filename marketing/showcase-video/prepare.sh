#!/bin/bash
# One-time setup for the showcase renderer: copies the fonts and brand assets
# out of the app, extracts frames from the two Higgsfield (Kling 3.0) clips,
# and synthesizes the SFX/pad track. Needs ffmpeg, python3 with numpy + scipy.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(git rev-parse --show-toplevel)"
mkdir -p fonts assets vid/intro vid/outro vid/swing
cp "$ROOT"/apps/mobile/assets/fonts/Manrope_*.ttf fonts/
cp "$ROOT"/apps/mobile/assets/brand/pickle-mark@3x.png assets/mark.png
cp "$ROOT"/apps/mobile/assets/capture/silhouette@3x.png assets/silhouette.png
# Whites are pushed to pure white so the clips multiply cleanly onto the chalk background.
LEVELS="lutrgb=r='min(255,val*1.36)':g='min(255,val*1.36)':b='min(255,val*1.36)'"
# Intro: the ninja was generated leaping OUT of frame; reversed it drops IN and lands.
ffmpeg -v error -y -i clips/kling-intro-leap.mp4 -vf "reverse,$LEVELS,fps=30" -q:v 2 vid/intro/%04d.jpg
# Outro: skip the idle opening, keep the slash that floods the frame black.
ffmpeg -v error -y -ss 2.6 -i clips/kling-outro-slash.mp4 -vf "$LEVELS,fps=30" -q:v 2 vid/outro/%04d.jpg
python3 audio.py
echo "intro $(ls vid/intro | wc -l | tr -d ' ') frames, outro $(ls vid/outro | wc -l | tr -d ' ') frames, audio.wav written."
echo "Render: node render.js --mode=pipe --out=v_noaudio.mp4 && ffmpeg -i v_noaudio.mp4 -i audio.wav -c:v copy -c:a aac -b:a 192k -shortest PickleSensei_showcase.mp4"
