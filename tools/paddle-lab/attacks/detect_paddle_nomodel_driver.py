"""Run the REAL detect_paddle.py CLI (argparse, serve protocol, ffprobe_meta,
frame_iter, run_window) with ONLY `load_model` replaced by a weight-free stub.

The stub returns zero detections for every frame, so anything about boxes or
scores is out of scope here; everything else — argument validation, media
probing, ffmpeg decode, timestamp model, serve-mode error handling — is the
production code path, byte for byte. This lets the attack suite exercise
detect_paddle on a CPU box without the ~200 MB D-FINE checkpoint.

Usage: python3 detect_paddle_nomodel_driver.py <detect_paddle args...>
"""
from __future__ import annotations

import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import detect_paddle  # noqa: E402


class _Inputs(dict):
    def to(self, _device):
        return self


class _StubProcessor:
    def __call__(self, images, return_tensors="pt"):
        return _Inputs(pixel_values=torch.zeros(1, 3, 8, 8))

    def post_process_object_detection(self, outputs, target_sizes, threshold):
        return [{
            "boxes": torch.zeros((0, 4)),
            "scores": torch.zeros((0,)),
            "labels": torch.zeros((0,), dtype=torch.long),
        }]


class _StubConfig:
    id2label: dict[int, str] = {}


class _StubModel:
    config = _StubConfig()

    def __call__(self, **inputs):
        return {}


def _stub_load_model():
    return _StubProcessor(), _StubModel(), 0.0


detect_paddle.load_model = _stub_load_model

if __name__ == "__main__":
    detect_paddle.main()
