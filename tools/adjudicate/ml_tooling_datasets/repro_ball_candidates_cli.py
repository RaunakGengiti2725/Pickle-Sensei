"""Adjudication repro: ball_candidates.py argument/window robustness.

Cases that must NOT succeed silently (exit 0 with an empty or over-cap
payload):  --start-ms beyond the clip, --end-ms < --start-ms, --scale 0,
and --max-per-frame below the 15-slot small pool (cap must be honoured).
Exit 0 iff every case behaves; 1 otherwise.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "tools/paddle-lab/ball_candidates.py"
CLIP = REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"


HANG_TIMEOUT_SEC = 20


class Hung:
    returncode = "HUNG"
    stderr = f"no exit after {HANG_TIMEOUT_SEC}s (killed)"


def run(extra: list[str], out: Path):
    try:
        p = subprocess.run([sys.executable, str(SCRIPT), "--video", str(CLIP), "--out", str(out), *extra],
                           capture_output=True, text=True, timeout=HANG_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        subprocess.run(["pkill", "-f", str(out)], check=False)
        return Hung(), None
    payload = json.loads(out.read_text()) if out.exists() else None
    return p, payload


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="adj-ballcands-"))
    rows = []
    ok = True

    def case(name, extra, judge):
        nonlocal ok
        out = tmp / f"{name}.json"
        p, payload = run(extra, out)
        frames = None if payload is None else payload["timing"]["framesProcessed"]
        max_c = None if payload is None else max((len(f["candidates"]) for f in payload["frames"]), default=0)
        verdict = False if p.returncode == "HUNG" else judge(p.returncode, payload, frames, max_c)
        rows.append({"case": name, "args": extra, "exitCode": p.returncode, "framesProcessed": frames,
                     "maxCandidatesPerFrame": max_c, "stderrTail": p.stderr.strip()[-160:], "behaves": verdict})
        ok = ok and verdict

    # a start beyond the 8 s clip: must fail (non-zero) rather than write an empty artifact
    case("start_beyond_clip", ["--start-ms", "20000"], lambda rc, pl, fr, mx: rc != 0)
    case("end_before_start", ["--start-ms", "3000", "--end-ms", "1000"], lambda rc, pl, fr, mx: rc != 0)
    case("scale_zero", ["--scale", "0"], lambda rc, pl, fr, mx: rc != 0)
    # cap must be honoured: no frame may carry more than --max-per-frame candidates
    case("max_per_frame_10", ["--max-per-frame", "10", "--end-ms", "1500"],
         lambda rc, pl, fr, mx: rc == 0 and mx is not None and mx <= 10)
    case("max_per_frame_1", ["--max-per-frame", "1", "--end-ms", "1500"],
         lambda rc, pl, fr, mx: rc == 0 and mx is not None and mx <= 1)
    case("baseline_default", ["--end-ms", "1500"], lambda rc, pl, fr, mx: rc == 0 and fr and fr > 0 and mx <= 40)

    print(json.dumps(rows, indent=2))
    print("RESULT:", "OK" if ok else "DEFECTS")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
