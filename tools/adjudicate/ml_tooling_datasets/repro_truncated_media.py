"""Adjudication repro: a faststart-remuxed clip truncated to 60% of its bytes
still probes as the full 8.0 s / 200 frames but only ~60% of the samples
exist.  ffmpeg prints "partial file / Invalid data" but still exits 0, so
neither ball_candidates.py (bare `proc.wait()`) nor detect_paddle.frame_iter
(checks exit status only) notices that fewer frames than the probed window
implies were decoded.  Both must fail loudly instead of writing a partial
artifact.

Exit 0 iff ball_candidates exits non-zero AND frame_iter raises; 1 otherwise.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
BALL = REPO_ROOT / "tools/paddle-lab/ball_candidates.py"
DETECT = REPO_ROOT / "tools/paddle-lab/detect_paddle.py"
SRC = REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="adj-trunc-"))
    fast = tmp / "faststart.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(SRC), "-c", "copy", "-movflags", "+faststart", str(fast)],
                   check=True)
    data = fast.read_bytes()
    trunc = tmp / "faststart60.mp4"
    trunc.write_bytes(data[: int(len(data) * 0.6)])

    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=nb_frames,duration", "-of", "json", str(trunc)], capture_output=True, text=True)
    report = {"probe": json.loads(probe.stdout)["streams"][0] if probe.returncode == 0 else probe.stderr}

    out = tmp / "cands.json"
    p = subprocess.run([sys.executable, str(BALL), "--video", str(trunc), "--out", str(out), "--scale", "0.25"],
                       capture_output=True, text=True, timeout=600)
    payload = json.loads(out.read_text()) if out.exists() else None
    report["ball_candidates"] = {
        "exitCode": p.returncode,
        "framesProcessed": None if payload is None else payload["timing"]["framesProcessed"],
        "stderrTail": p.stderr.strip()[-200:],
    }

    # detect_paddle.frame_iter driven directly (no model needed); expected 20 frames at stride 10
    probe_py = (
        "import sys; sys.path.insert(0, %r); import detect_paddle as d\n"
        "n = 0\n"
        "w, h, fps, dur, st = d.ffprobe_meta(%r)\n"
        "try:\n"
        "    for _ in d.frame_iter(%r, 0.0, 8000.0, w, h, fps, stride=10, decode_size=(64, 64), start_time_ms=st):\n"
        "        n += 1\n"
        "except RuntimeError as exc:\n"
        "    print('RAISED', n, exc); sys.exit(3)\n"
        "print('COMPLETED', n)\n"
    ) % (str(DETECT.parent), str(trunc), str(trunc))
    p2 = subprocess.run([sys.executable, "-c", probe_py], capture_output=True, text=True, timeout=600)
    report["detect_paddle_frame_iter"] = {"exitCode": p2.returncode, "stdout": p2.stdout.strip()[-200:],
                                          "stderrTail": p2.stderr.strip()[-200:]}

    print(json.dumps(report, indent=2))
    ok = p.returncode != 0 and p2.returncode == 3
    print("RESULT:", "OK" if ok else "SILENT_PARTIAL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
