"""Shared helpers for the paddle student-model groundwork (D4-06).

The student is a tiny CPU-feasible center-heatmap detector distilled from the
committed D-FINE teacher detections in datasets/releases/paddle-distill-v0.1.
Everything here is groundwork on tiny data — see train_student.py /
student_bench.py headers for the honest framing.
"""

from __future__ import annotations

import json
import subprocess
import warnings
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

import frame_clock

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
    meta = frame_clock.probe_stream(str(path))
    return meta.width, meta.height, meta.fps


def extract_frames(video: Path, t_ms_list: list[float]) -> dict[float, np.ndarray]:
    """Extract absolute-CFR frames (ffmpeg select=eq(n,IDX)) for each tMs.

    tMs values are the detector's absolute clock (start_time + k/fps, as
    emitted by detect_paddle.frame_iter), so the source index is
    k = round((tMs - start_time) * fps / 1000) — the same inversion run_crops
    uses. Legacy relative-clock labels (paddle-distill-v0.1 `clockCaveat`:
    afn-sasebo-rally1 labelled at tMs=0.0 with start_time 33.367 ms) may sit up
    to one frame period before the stream start; those map to frame 0 with one
    LegacyClockWarning per clip, anything earlier raises ValueError. Raises
    RuntimeError if ffmpeg fails, reports partial/corrupt media, or any
    requested frame is not decoded (index past the end of the media /
    truncated file) instead of silently returning a partial mapping.
    """
    meta = frame_clock.probe_stream(str(video))
    w, h, fps, start_time_ms = meta.width, meta.height, meta.fps, meta.start_time_ms
    frames: dict[float, np.ndarray] = {}
    if not t_ms_list:
        return frames
    index_for_t: dict[float, int] = {}
    legacy_t_ms: list[float] = []
    for t in t_ms_list:
        try:
            index_for_t[t], legacy = frame_clock.frame_index_for_labelled_t_ms(t, fps, start_time_ms)
        except ValueError as exc:
            raise ValueError(f"{exc} (requested from {video})") from None
        if legacy:
            legacy_t_ms.append(t)
    if legacy_t_ms:
        warnings.warn(
            f"{video}: {len(legacy_t_ms)} label timestamp(s) (tMs {min(legacy_t_ms):.3f}..{max(legacy_t_ms):.3f}) "
            f"lie within one frame period before the stream start ({start_time_ms:.3f} ms); "
            "mapped to frame 0 (legacy relative-clock labels, see the dataset clockCaveat)",
            frame_clock.LegacyClockWarning,
            stacklevel=2,
        )
    indices = sorted(set(index_for_t.values()))
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
            "-frames:v",
            str(len(indices)),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        capture_output=True,
    )
    stderr_text = proc.stderr.decode("utf-8", "replace").strip()
    frame_clock.check_decode_health(proc.returncode, stderr_text, str(video))
    raw = np.frombuffer(proc.stdout, dtype=np.uint8)
    frame_bytes = w * h * 3
    n = len(raw) // frame_bytes
    if n < len(indices):
        raise RuntimeError(
            f"ffmpeg decoded {n} of {len(indices)} requested frames from {video}; "
            f"frames {indices[n:]} are missing (past the end of the media, or truncated file). "
            f"ffmpeg stderr: {frame_clock.stderr_tail(stderr_text)}"
        )
    imgs = raw[: n * frame_bytes].reshape(n, h, w, 3)
    idx_to_img = {idx: imgs[i] for i, idx in enumerate(indices)}
    for t in t_ms_list:
        frames[t] = idx_to_img[index_for_t[t]]
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
