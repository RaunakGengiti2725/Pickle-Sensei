"""Shared helpers for the pass-3 adversarial tests (ml-tooling-datasets).

Every test builds its own scratch repo root under $ATTACK3_SCRATCH (default:
a fresh tempdir) and copies ONLY the committed inputs a tool reads, so no
test ever writes into the real datasets/ tree.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PADDLE_LAB = REPO_ROOT / "tools" / "paddle-lab"
VENV_PYTHON = PADDLE_LAB / ".venv" / "bin" / "python"
ARTIFACT_DIR = Path(os.environ.get("ATTACK3_ARTIFACTS", REPO_ROOT / "artifacts" / "attack3"))

DEV_CLIPS = [
    REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4",
    REPO_ROOT / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",
]

# Inputs distill_export.py reads (see its module docstring). Copied verbatim.
DISTILL_INPUTS = [
    "datasets/corpus/sources.json",
    "datasets/paddle-bench/registry.json",
    "datasets/paddle-bench/paddle-bench.json",
    "datasets/paddle-bench/event-bounds-wave-a.json",
    "datasets/paddle-bench/ownership-review/ownership-review.json",
    "datasets/experiments/wave-a/H-logs",
    "datasets/experiments/wave-b/W12-probe/probe-dets.json",
]
DISTILL_BUNDLE_GLOB = "datasets/paddle-bench/bundles/*/annotation/devin-visual-v2-waveC*.json"

# Inputs the wave-g miner reads (module docstring).
MINER_INPUTS = [
    "datasets/paddle-bench/ownership-review/queue.json",
    "datasets/paddle-bench/runs-wave-a",
]
MINER_BUNDLE_GLOB = "datasets/paddle-bench/bundles/*/annotation/devin-visual-v2-waveC-ownership.json"


def python() -> str:
    """Interpreter with torch/transformers when the lab venv exists, else sys.executable."""
    return str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable


def scratch_root(name: str) -> Path:
    base = os.environ.get("ATTACK3_SCRATCH")
    if base:
        root = Path(base) / name
        if root.exists():
            shutil.rmtree(root)
        root.mkdir(parents=True)
        return root
    return Path(tempfile.mkdtemp(prefix=f"attack3-{name}-"))


def copy_rel(root: Path, rel: str) -> Path:
    src = REPO_ROOT / rel
    dst = root / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)
    return dst


def copy_glob(root: Path, pattern: str) -> list[Path]:
    out = []
    for src in sorted(REPO_ROOT.glob(pattern)):
        out.append(copy_rel(root, str(src.relative_to(REPO_ROOT))))
    return out


def build_distill_root(name: str, with_clips: bool = True) -> Path:
    root = scratch_root(name)
    for rel in DISTILL_INPUTS:
        copy_rel(root, rel)
    copy_glob(root, DISTILL_BUNDLE_GLOB)
    if with_clips:
        # clip presence only toggles media.pixelsCommitted; a 0-byte stand-in is enough
        for clip in REPO_ROOT.glob("datasets/paddle-bench/bundles/*/clip.mp4"):
            dst = root / clip.relative_to(REPO_ROOT)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(b"")
    return root


def build_miner_root(name: str) -> Path:
    """The miner hardcodes REPO from its own file location, so a scratch root
    needs a copy of the script at tools/mining/ inside it."""
    root = scratch_root(name)
    for rel in MINER_INPUTS:
        copy_rel(root, rel)
    copy_glob(root, MINER_BUNDLE_GLOB)
    copy_rel(root, "tools/mining/wave_g_g03_multi_paddle_miner.py")
    return root


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    return subprocess.run(cmd, **kw)


def save_artifact(name: str, text: str) -> Path:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / name
    path.write_text(text)
    return path
