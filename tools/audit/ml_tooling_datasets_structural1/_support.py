"""Shared helpers for the ml-tooling-datasets structural audit tests.

These tests are demonstrations written against commit 4d812e1a. They never
modify production code or committed datasets; everything they write goes to a
temporary directory.

Runtime: the paddle-lab tools import numpy/scipy/PIL and (detect_paddle) torch.
Only the torch import is stubbed here, and only when torch is absent, because
none of the code paths exercised by these tests execute a tensor op — the stub
exists solely so `import detect_paddle` succeeds on a CPU box without PyTorch.
numpy/scipy/PIL must be real (`pip install numpy scipy pillow jsonschema`).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import subprocess
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PADDLE_LAB = REPO_ROOT / "tools" / "paddle-lab"
ML_SCRIPTS = REPO_ROOT / "ml" / "scripts"
BUNDLES = REPO_ROOT / "datasets" / "paddle-bench" / "bundles"

WM_VOLLEY = BUNDLES / "wm-volley-02" / "clip.mp4"          # 25 fps, start_time 0
AFN_RALLY1 = BUNDLES / "afn-sasebo-rally1" / "clip.mp4"    # 29.97 fps, start_time 33.367 ms


def install_torch_stub_if_missing() -> bool:
    """Return True when a stub was installed (torch absent)."""
    try:
        import torch  # noqa: F401
        return False
    except ImportError:
        pass
    stub = types.ModuleType("torch")
    backends = types.ModuleType("torch.backends")
    mps = types.ModuleType("torch.backends.mps")
    mps.is_available = lambda: False
    backends.mps = mps
    stub.backends = backends
    stub.no_grad = contextlib.nullcontext
    sys.modules["torch"] = stub
    sys.modules["torch.backends"] = backends
    sys.modules["torch.backends.mps"] = mps
    return True


def add_paddle_lab_to_path() -> None:
    if str(PADDLE_LAB) not in sys.path:
        sys.path.insert(0, str(PADDLE_LAB))


def add_ml_scripts_to_path() -> None:
    if str(ML_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(ML_SCRIPTS))


def ffprobe_frame_pts_ms(video: Path) -> list[float]:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(video),
        ],
        capture_output=True, text=True, check=True,
    )
    return [float(f["best_effort_timestamp_time"]) * 1000.0 for f in json.loads(out.stdout)["frames"]]


def ffprobe_stream(video: Path) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate,start_time,nb_frames",
            "-of", "json", str(video),
        ],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)["streams"][0]


def fps_of(stream: dict) -> float:
    num, den = stream["avg_frame_rate"].split("/")
    return float(num) / float(den)


def full_decode_hashes(video: Path, extra_vf: str | None, pix_fmt: str, frame_bytes: int) -> list[str]:
    """sha256 of every frame of a full (unseeked) CFR decode, in source order."""
    args = ["ffmpeg", "-v", "error", "-i", str(video)]
    if extra_vf:
        args += ["-vf", extra_vf]
    args += ["-f", "rawvideo", "-pix_fmt", pix_fmt, "-"]
    hashes = []
    with subprocess.Popen(args, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL) as proc:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(frame_bytes)
            if len(chunk) < frame_bytes:
                break
            hashes.append(hashlib.sha256(chunk).hexdigest())
    return hashes
