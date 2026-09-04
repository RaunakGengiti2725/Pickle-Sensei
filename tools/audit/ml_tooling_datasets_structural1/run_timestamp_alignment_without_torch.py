"""Run tools/paddle-lab/test_timestamp_alignment.py on a box without PyTorch.

The guard only exercises ffmpeg decoding + frame_iter arithmetic, but importing
detect_paddle requires torch. This runner installs the inert torch stub from
_support (only when torch is absent) and then executes the guard unchanged,
propagating its exit code. The guard itself is NOT modified.

Usage: python3 tools/audit/ml_tooling_datasets_structural1/run_timestamp_alignment_without_torch.py [clip.mp4 ...]
"""

from __future__ import annotations

import runpy
import sys

from _support import PADDLE_LAB, add_paddle_lab_to_path, install_torch_stub_if_missing

install_torch_stub_if_missing()
add_paddle_lab_to_path()
sys.argv = [str(PADDLE_LAB / "test_timestamp_alignment.py"), *sys.argv[1:]]
runpy.run_path(sys.argv[0], run_name="__main__")
