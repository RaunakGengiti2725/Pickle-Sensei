"""Shared helpers for the paddle student-model groundwork (D4-06).

The student is a tiny CPU-feasible center-heatmap detector distilled from the
committed D-FINE teacher detections in datasets/releases/paddle-distill-v0.1.
Everything here is groundwork on tiny data — see train_student.py /
student_bench.py headers for the honest framing.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

INPUT_SIZE = 320  # letterboxed square input
HEATMAP_STRIDE = 8
HEATMAP_SIZE = INPUT_SIZE // HEATMAP_STRIDE
TEACHER_SCORE_FLOOR = 0.30  # dets below this are ByteTrack extension noise
GAUSSIAN_SIGMA_PX = 2.0  # in heatmap cells


def load_examples(release_dir: Path) -> list[dict]:
    examples = []
    with open(release_dir / "examples.jsonl") as f:
        for line in f:
            examples.append(json.loads(line))
    return examples


def video_meta(path: Path) -> tuple[int, int, float]:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    w, h, rate = out.split(",")
    num, den = rate.split("/")
    return int(w), int(h), float(num) / float(den)


def extract_frames(video: Path, t_ms_list: list[float]) -> dict[float, np.ndarray]:
    """Extract absolute-CFR frames (ffmpeg select=eq(n,IDX)) for each tMs."""
    w, h, fps = video_meta(video)
    frames: dict[float, np.ndarray] = {}
    indices = sorted({round(t * fps / 1000.0) for t in t_ms_list})
    expr = "+".join(f"eq(n\\,{i})" for i in indices)
    proc = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(video),
            "-vf",
            f"select='{expr}'",
            "-vsync",
            "0",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        capture_output=True,
        check=True,
    )
    raw = np.frombuffer(proc.stdout, dtype=np.uint8)
    frame_bytes = w * h * 3
    n = len(raw) // frame_bytes
    imgs = raw[: n * frame_bytes].reshape(n, h, w, 3)
    idx_to_img = {idx: imgs[i] for i, idx in enumerate(indices[:n])}
    for t in t_ms_list:
        img = idx_to_img.get(round(t * fps / 1000.0))
        if img is not None:
            frames[t] = img
    return frames


def letterbox(img: np.ndarray, size: int = INPUT_SIZE) -> tuple[np.ndarray, float, float, float]:
    """Resize keeping aspect, pad to square. Returns (img, scale, padX, padY)."""
    h, w = img.shape[:2]
    scale = size / max(h, w)
    nh, nw = round(h * scale), round(w * scale)
    t = torch.from_numpy(img.copy()).permute(2, 0, 1).float().unsqueeze(0)
    resized = nn.functional.interpolate(t, size=(nh, nw), mode="bilinear", align_corners=False)
    out = torch.zeros(1, 3, size, size)
    pad_y, pad_x = (size - nh) // 2, (size - nw) // 2
    out[:, :, pad_y : pad_y + nh, pad_x : pad_x + nw] = resized
    return out[0].numpy() / 255.0, scale, float(pad_x), float(pad_y)


def px_to_heatmap(x: float, y: float, scale: float, pad_x: float, pad_y: float) -> tuple[float, float]:
    return ((x * scale + pad_x) / HEATMAP_STRIDE, (y * scale + pad_y) / HEATMAP_STRIDE)


def heatmap_to_px(hx: float, hy: float, scale: float, pad_x: float, pad_y: float) -> tuple[float, float]:
    return (
        (hx * HEATMAP_STRIDE - pad_x) / scale,
        (hy * HEATMAP_STRIDE - pad_y) / scale,
    )


def render_target(centers: list[tuple[float, float, float]]) -> np.ndarray:
    """Gaussian heatmap from (hx, hy, weight) centers in heatmap coords."""
    hm = np.zeros((HEATMAP_SIZE, HEATMAP_SIZE), dtype=np.float32)
    ys, xs = np.mgrid[0:HEATMAP_SIZE, 0:HEATMAP_SIZE]
    for hx, hy, wgt in centers:
        g = np.exp(-((xs - hx) ** 2 + (ys - hy) ** 2) / (2 * GAUSSIAN_SIGMA_PX**2)) * wgt
        hm = np.maximum(hm, g.astype(np.float32))
    return hm


class StudentPaddleNet(nn.Module):
    """~90k-param center-heatmap detector head (paddle-student-v0)."""

    def __init__(self) -> None:
        super().__init__()

        def block(cin: int, cout: int, stride: int) -> nn.Sequential:
            return nn.Sequential(
                nn.Conv2d(cin, cout, 3, stride=stride, padding=1, bias=False),
                nn.BatchNorm2d(cout),
                nn.ReLU(inplace=True),
            )

        self.backbone = nn.Sequential(
            block(3, 16, 2),  # /2
            block(16, 32, 2),  # /4
            block(32, 48, 2),  # /8
            block(48, 64, 1),
            block(64, 64, 1),
        )
        self.head = nn.Conv2d(64, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.backbone(x)).squeeze(1)


def heatmap_peaks(hm: np.ndarray, floor: float, max_peaks: int = 8) -> list[tuple[float, float, float]]:
    """Greedy NMS peak picking. Returns (hx, hy, score) above floor."""
    hm = hm.copy()
    peaks = []
    radius = int(2 * GAUSSIAN_SIGMA_PX)
    for _ in range(max_peaks):
        idx = int(hm.argmax())
        hy, hx = divmod(idx, hm.shape[1])
        score = float(hm[hy, hx])
        if score < floor:
            break
        peaks.append((float(hx), float(hy), score))
        y0, y1 = max(0, hy - radius), min(hm.shape[0], hy + radius + 1)
        x0, x1 = max(0, hx - radius), min(hm.shape[1], hx + radius + 1)
        hm[y0:y1, x0:x1] = -1.0
    return peaks
