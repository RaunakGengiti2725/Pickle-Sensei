"""Shared helpers for the adversarial ml-tooling tests (pass 3).

Every test in this directory runs the REAL repository scripts as subprocesses
(never a re-implementation) against a scratch tree or the committed bundle
clips, with hard wall-clock timeouts so a hang is reported as a failure
instead of blocking the harness. Nothing here touches production code.

Run:
  python3 -m unittest discover -s tools/paddle-lab/attacks -p 'test_*.py' -v
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PADDLE_LAB = REPO_ROOT / "tools" / "paddle-lab"
BALL_CANDIDATES = PADDLE_LAB / "ball_candidates.py"
DETECT_PADDLE = PADDLE_LAB / "detect_paddle.py"
VALIDATOR = REPO_ROOT / "ml" / "scripts" / "validate_annotations.py"
E15_DOWNLOAD = REPO_ROOT / "tools" / "e15_download.py"
WM_VOLLEY_02 = REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"
AFN_SASEBO_RALLY1 = REPO_ROOT / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4"

ARTIFACT_DIR = Path(os.environ.get("ATTACK_ARTIFACT_DIR", "/tmp/attack-ml-tooling-2"))
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_TIMEOUT_SEC = 60


class Run:
    def __init__(self, proc: subprocess.CompletedProcess | None, timed_out: bool, cmd: list[str]):
        self.cmd = cmd
        self.timed_out = timed_out
        self.returncode = None if proc is None else proc.returncode
        self.stdout = "" if proc is None else proc.stdout
        self.stderr = "" if proc is None else proc.stderr

    def record(self, name: str, **extra) -> Path:
        out = ARTIFACT_DIR / f"{name}.json"
        out.write_text(json.dumps({
            "cmd": self.cmd,
            "timedOut": self.timed_out,
            "returncode": self.returncode,
            "stdout": self.stdout[-20000:],
            "stderr": self.stderr[-20000:],
            **extra,
        }, indent=2))
        return out

    def __repr__(self) -> str:
        return f"Run(rc={self.returncode}, timedOut={self.timed_out}, stderr_tail={self.stderr[-400:]!r})"


def run(cmd: list[str], *, timeout: float = DEFAULT_TIMEOUT_SEC, cwd: Path | None = None,
        env: dict[str, str] | None = None, stdin: str | None = None) -> Run:
    """Run a command with a hard timeout; a timeout is reported, never raised."""
    # New session so a timeout kills the whole tree (script AND its ffmpeg
    # children) — a leaked ffmpeg would otherwise keep spinning after the test.
    proc = subprocess.Popen(
        [str(c) for c in cmd], cwd=cwd, env=env, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace",
        start_new_session=True,
    )
    try:
        out, err = proc.communicate(input=stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        return Run(None, True, [str(c) for c in cmd])
    return Run(subprocess.CompletedProcess(proc.args, proc.returncode, out, err), False,
               [str(c) for c in cmd])


def py(script: Path, *args: str, **kwargs) -> Run:
    return run([sys.executable, str(script), *args], **kwargs)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def torch_importable() -> bool:
    return importlib.util.find_spec("torch") is not None


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def make_empty_mp4(directory: Path) -> Path:
    p = directory / "empty.mp4"
    p.write_bytes(b"")
    return p


def make_audio_only_mp4(directory: Path, seconds: float = 1.0) -> Path:
    """A valid .mp4 container with an AAC track and NO video stream."""
    p = directory / "audio_only.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
         "-t", str(seconds), "-c:a", "aac", str(p)],
        check=True, capture_output=True,
    )
    return p


def make_truncated_mp4(directory: Path, source: Path, keep_bytes: int = 4096) -> Path:
    """The first `keep_bytes` of a real clip: moov atom present or not depending
    on the muxer's layout; ffprobe may or may not see a video stream."""
    p = directory / "truncated.mp4"
    p.write_bytes(source.read_bytes()[:keep_bytes])
    return p


def ffprobe_video_pts_ms(video: Path, start_sec: float, end_sec: float) -> list[float]:
    """Ground truth: pts of every video frame in [start, end] straight from the
    container, independent of any CFR model."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "frame=best_effort_timestamp_time", "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )
    pts = [float(f["best_effort_timestamp_time"]) * 1000.0 for f in json.loads(out.stdout)["frames"]]
    lo, hi = start_sec * 1000.0, end_sec * 1000.0
    return [t for t in pts if lo - 1e-6 <= t <= hi + 1e-6]
