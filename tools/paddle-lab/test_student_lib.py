"""Frame-clock and decode-completeness regression tests for the paddle-lab tools.

Every tool that names a frame by tMs must agree with detect_paddle.frame_iter
on WHICH absolute source frame k = round((tMs - start_time) * fps / 1000) that
is — pinned here on afn-sasebo-rally1, whose container start_time is 33.367 ms,
so any tool that forgets start_time is off by one frame. Ground truth is pixel
identity (sha256) against a full-clip CFR decode.

Run from the repo root:
  .venv/bin/python -m unittest tools/paddle-lab/test_student_lib.py
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "mining"))

import ball_candidates  # noqa: E402
import detect_paddle  # noqa: E402
import student_lib  # noqa: E402
import wave_g_g03_multi_paddle_miner as miner  # noqa: E402

REPO_ROOT = HERE.parents[1]
BUNDLES = REPO_ROOT / "datasets/paddle-bench/bundles"
AFN_CLIP = BUNDLES / "afn-sasebo-rally1/clip.mp4"  # start_time 33.367 ms, 29.97 fps
WM_CLIP = BUNDLES / "wm-volley-02/clip.mp4"  # start_time 0, 25 fps, 8.0 s
TOLERANCE_MS = 0.51
PYTHON = sys.executable


def full_decode(video: Path, pix_fmt: str, out_w: int | None = None, out_h: int | None = None) -> list[bytes]:
    """Every frame of `video` decoded in one pass (the absolute-index oracle)."""
    width, height, _, _, _ = detect_paddle.ffprobe_meta(str(video))
    args = ["ffmpeg", "-v", "error", "-i", str(video)]
    if out_w is not None and out_h is not None:
        args += ["-vf", f"scale={out_w}:{out_h}"]
        width, height = out_w, out_h
    args += ["-f", "rawvideo", "-pix_fmt", pix_fmt, "-"]
    proc = subprocess.run(args, capture_output=True, check=True)
    frame_bytes = width * height * (3 if pix_fmt == "rgb24" else 1)
    data = proc.stdout
    assert len(data) % frame_bytes == 0, "full decode produced a partial frame"
    return [data[i : i + frame_bytes] for i in range(0, len(data), frame_bytes)]


def sha(buf: bytes) -> str:
    return hashlib.sha256(buf).hexdigest()


def make_truncated_faststart(src: Path, tmp: Path, fraction: float = 0.6) -> Path:
    fast = tmp / "faststart.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(fast)],
        check=True,
    )
    data = fast.read_bytes()
    trunc = tmp / "faststart60.mp4"
    trunc.write_bytes(data[: int(len(data) * fraction)])
    return trunc


def run_ball_candidates(*extra: str, video: Path = WM_CLIP, out: Path, timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PYTHON, str(HERE / "ball_candidates.py"), "--video", str(video), "--out", str(out), *extra],
        capture_output=True, text=True, timeout=timeout,
    )


class FrameClockAgreement(unittest.TestCase):
    """MLT-1: every tool names the same absolute frame as detect_paddle.frame_iter."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.width, cls.height, cls.fps, cls.duration_ms, cls.start_time_ms = detect_paddle.ffprobe_meta(str(AFN_CLIP))
        assert cls.start_time_ms > 1.0, "fixture must have a nonzero container start_time"
        cls.rgb_index = {sha(f): k for k, f in enumerate(full_decode(AFN_CLIP, "rgb24"))}
        cls.frame_ms = 1000.0 / cls.fps

    def t_ms_of(self, k: int) -> float:
        return self.start_time_ms + k * self.frame_ms

    def test_frame_iter_emits_absolute_clock(self) -> None:
        seen = 0
        for _, t_ms, rgb in detect_paddle.frame_iter(
            str(AFN_CLIP), 1234.0, 1234.0 + 6 * self.frame_ms, self.width, self.height, self.fps,
            start_time_ms=self.start_time_ms,
        ):
            k = self.rgb_index[sha(rgb.tobytes())]
            self.assertAlmostEqual(t_ms, self.t_ms_of(k), delta=TOLERANCE_MS)
            self.assertEqual(detect_paddle.frame_index_for_t_ms(t_ms, self.fps, self.start_time_ms), k)
            seen += 1
        self.assertGreaterEqual(seen, 5)

    def test_extract_frames_returns_named_frame(self) -> None:
        wanted = [10, 37, 61, 90]
        t_list = [self.t_ms_of(k) for k in wanted]
        frames = student_lib.extract_frames(AFN_CLIP, t_list)
        self.assertEqual(sorted(frames), sorted(t_list))
        for k, t in zip(wanted, t_list):
            got = self.rgb_index.get(sha(np.ascontiguousarray(frames[t]).tobytes()))
            self.assertEqual(got, k, f"extract_frames(tMs={t:.3f}) returned frame {got}, detector names {k}")

    def test_run_crops_index_matches_frame_iter(self) -> None:
        for k in (10, 37, 61):
            t = self.t_ms_of(k)
            self.assertEqual(detect_paddle.frame_index_for_t_ms(t, self.fps, self.start_time_ms), k)
        decoded = list(detect_paddle.decode_frames_at(str(AFN_CLIP), [10, 37, 61], self.width, self.height, self.fps))
        self.assertEqual([idx for idx, _ in decoded], [10, 37, 61])
        for idx, rgb in decoded:
            self.assertEqual(self.rgb_index[sha(rgb.tobytes())], idx)

    def test_ball_candidates_gray_frames_are_absolute_frames(self) -> None:
        out_w, out_h = int(self.width * 0.5) // 2 * 2, int(self.height * 0.5) // 2 * 2
        gray_index = {sha(f): k for k, f in enumerate(full_decode(AFN_CLIP, "gray", out_w, out_h))}
        start_ms = 1234.0
        end_ms = start_ms + 8 * self.frame_ms
        expected_first = detect_paddle.plan_window_seek(start_ms, self.fps, self.start_time_ms)[0]
        rows = list(ball_candidates.gray_frames(
            str(AFN_CLIP), start_ms, end_ms, out_w, out_h,
            fps=self.fps, start_time_ms=self.start_time_ms, duration_ms=self.duration_ms,
        ))
        self.assertGreaterEqual(len(rows), 7)
        self.assertEqual(rows[0][0], expected_first)
        for index, t_ms, frame in rows:
            k = gray_index[sha(frame.astype(np.uint8).tobytes())]
            self.assertEqual(index, k)
            self.assertAlmostEqual(t_ms, self.t_ms_of(k), delta=TOLERANCE_MS)
            self.assertGreaterEqual(t_ms, start_ms)

    def test_ball_candidates_cli_tms_on_absolute_grid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "bc.json"
            for start_ms in (0.0, 1234.0):
                end_ms = start_ms + 12 * self.frame_ms
                res = run_ball_candidates("--start-ms", str(start_ms), "--end-ms", str(end_ms), video=AFN_CLIP, out=out)
                self.assertEqual(res.returncode, 0, res.stderr)
                payload = json.loads(out.read_text())
                first_index = detect_paddle.plan_window_seek(start_ms, self.fps, self.start_time_ms)[0]
                # candidate frame i is the middle of the (i-1, i, i+1) triple
                self.assertEqual(len(payload["frames"]), 12 - 2)
                for offset, frame in enumerate(payload["frames"], start=1):
                    self.assertAlmostEqual(frame["tMs"], self.t_ms_of(first_index + offset), delta=TOLERANCE_MS)

    def test_miner_frame_pack_grabs_named_frame(self) -> None:
        candidates = [
            {"candidateId": f"test-{k}", "caseId": "afn-sasebo-rally1", "tMs": round(self.t_ms_of(k), 2)}
            for k in (0, 13, 43, 78)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            previous = miner.OUT_DIR
            miner.OUT_DIR = tmp
            try:
                packs = miner.extract_crops(candidates, no_crops=False)
            finally:
                miner.OUT_DIR = previous
            frames = full_decode(AFN_CLIP, "rgb24")
            for cand, pack in zip(candidates, packs):
                self.assertIsNotNone(pack["cropPath"], cand)
                png = REPO_ROOT / pack["cropPath"]
                got = np.asarray(Image.open(png).convert("RGB")).astype(np.int16)
                diffs = [float(np.mean(np.abs(np.frombuffer(f, np.uint8).reshape(self.height, self.width, 3).astype(np.int16) - got))) for f in frames]
                k_got = int(np.argmin(diffs))
                k_named = detect_paddle.frame_index_for_t_ms(cand["tMs"], self.fps, self.start_time_ms)
                self.assertEqual(k_got, k_named, f"{cand['candidateId']}: miner grabbed frame {k_got}, tMs names {k_named}")
                self.assertEqual(pack["frameIndexHint"], k_named)


class DecodeCompleteness(unittest.TestCase):
    """MLT-2: truncated media and impossible windows fail loudly, never a partial artifact."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.trunc = make_truncated_faststart(WM_CLIP, Path(cls.tmp.name))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_frame_iter_raises_on_truncated_media(self) -> None:
        w, h, fps, _, st = detect_paddle.ffprobe_meta(str(self.trunc))
        with self.assertRaises(RuntimeError):
            for _ in detect_paddle.frame_iter(str(self.trunc), 0.0, 8000.0, w, h, fps, stride=10,
                                              decode_size=(64, 64), start_time_ms=st):
                pass

    def test_frame_iter_rejects_impossible_windows(self) -> None:
        w, h, fps, dur, st = detect_paddle.ffprobe_meta(str(WM_CLIP))
        with self.assertRaises(ValueError):
            list(detect_paddle.frame_iter(str(WM_CLIP), 9000.0, 9500.0, w, h, fps, start_time_ms=st, duration_ms=dur))
        with self.assertRaises(ValueError):
            list(detect_paddle.frame_iter(str(WM_CLIP), 2000.0, 1000.0, w, h, fps, start_time_ms=st, duration_ms=dur))

    def test_ball_candidates_fails_on_truncated_media(self) -> None:
        out = Path(self.tmp.name) / "trunc-cands.json"
        res = run_ball_candidates("--scale", "0.25", video=self.trunc, out=out, timeout=600)
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(out.exists(), "partial artifact must not be written")

    def test_ball_candidates_rejects_window_beyond_clip(self) -> None:
        out = Path(self.tmp.name) / "beyond.json"
        res = run_ball_candidates("--start-ms", "9000", "--end-ms", "9500", out=out)
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(out.exists())

    def test_ball_candidates_rejects_end_before_start(self) -> None:
        out = Path(self.tmp.name) / "reversed.json"
        res = run_ball_candidates("--start-ms", "2000", "--end-ms", "1000", out=out)
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(out.exists())

    def test_extract_frames_raises_when_frame_missing(self) -> None:
        _, _, fps, dur, st = detect_paddle.ffprobe_meta(str(WM_CLIP))
        with self.assertRaises(RuntimeError):
            student_lib.extract_frames(WM_CLIP, [st + 10 * 1000.0 / fps, st + dur + 5000.0])

    def test_decode_frames_at_raises_when_frame_missing(self) -> None:
        w, h, fps, _, _ = detect_paddle.ffprobe_meta(str(WM_CLIP))
        with self.assertRaises(RuntimeError):
            list(detect_paddle.decode_frames_at(str(WM_CLIP), [10, 100000], w, h, fps))


class BallCandidatesArgumentContract(unittest.TestCase):
    """MLT-3: --max-per-frame is honoured for every positive cap; bad args exit 2 before ffmpeg."""

    def test_argparse_rejects_bad_values_before_ffmpeg(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "bad.json"
            for extra in (
                ["--scale", "0"],
                ["--scale", "-0.5"],
                ["--max-per-frame", "0"],
                ["--min-area", "800", "--max-area", "700"],
            ):
                res = run_ball_candidates(*extra, out=out, timeout=20)
                self.assertEqual(res.returncode, 2, f"{extra}: rc={res.returncode} stderr={res.stderr}")
                self.assertFalse(out.exists(), extra)

    def test_max_per_frame_is_honoured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for cap in (1, 10, 40):
                out = Path(tmp) / f"cap{cap}.json"
                res = run_ball_candidates("--end-ms", "1500", "--max-per-frame", str(cap), out=out)
                self.assertEqual(res.returncode, 0, res.stderr)
                payload = json.loads(out.read_text())
                self.assertGreater(len(payload["frames"]), 0)
                worst = max(len(f["candidates"]) for f in payload["frames"])
                self.assertLessEqual(worst, cap, f"--max-per-frame {cap} produced {worst} candidates on a frame")
                self.assertGreater(sum(len(f["candidates"]) for f in payload["frames"]), 0)


if __name__ == "__main__":
    unittest.main()
