#!/bin/bash
# sheet.sh <video> <startMs> <endMs> <fps> <outPrefix> [tileCols tileRows] [scaleW]
# Renders a timestamped contact sheet of frames from startMs to endMs at given fps.
V="$1"; S="$2"; E="$3"; FPS="$4"; OUT="$5"; COLS="${6:-5}"; ROWS="${7:-6}"; W="${8:-320}"
SS=$(python3 -c "print($S/1000)")
TO=$(python3 -c "print(($E-$S)/1000)")
ffmpeg -hide_banner -loglevel error -ss "$SS" -t "$TO" -i "$V" \
  -vf "fps=$FPS,drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='%{eif\\:trunc(t*1000+$S)\\:d}':fontsize=28:fontcolor=yellow:box=1:boxcolor=black@0.6:x=4:y=4,scale=$W:-1,tile=${COLS}x${ROWS}" \
  -fps_mode passthrough "${OUT}-%02d.png"
