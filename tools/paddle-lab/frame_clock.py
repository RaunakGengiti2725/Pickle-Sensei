"""Absolute constant-frame-rate clock shared by every paddle-lab / mining tool.

Frame k of a CFR stream sits at pts = start_time + k/fps. Every tool that
names a frame by tMs (detect_paddle.frame_iter / run_crops, ball_candidates,
student_lib.extract_frames, the g03 miner frame packs) must map tMs <-> k with
the SAME arithmetic, otherwise a nonzero container start_time (e.g. 33.367 ms
on afn-sasebo-rally1) or a non-frame-aligned `-ss` shifts one tool by a frame
relative to the others. This module is stdlib-only so it can be imported
without torch/numpy.

ffmpeg CLI semantics relied on here: `-ss`/`-to` input options are expressed
relative to the stream start (ffmpeg adds the input start_time), and the first
frame emitted after a seek is the first frame whose pts >= target.

Legacy relative clock: labels written before this module (paddle-distill-v0.1,
see its `clockCaveat`) put the first frame at tMs=0 even when the container
start_time is nonzero, which the strict inversion names as frame -1.
`frame_index_for_labelled_t_ms` tolerates exactly that — a label at most ONE
frame period before the stream start is frame 0 and the caller warns once per
clip — while anything earlier still raises.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import threading
from typing import Callable, NamedTuple

SEEK_EPS = 1e-6
# A label may sit this many frame periods before the stream start and still
# name frame 0 (the legacy relative clock's first frame). The epsilon absorbs
# ffprobe's microsecond start_time rounding (33.367 ms vs 1000/29.97).
LEGACY_PRE_START_TOLERANCE_FRAMES = 1.0
LEGACY_PRE_START_EPS_FRAMES = 1e-3
# ffmpeg exits 0 for truncated/partial media and only reports it on stderr.
CORRUPT_MEDIA_MARKERS = ("partial file", "Invalid data", "Packet corrupt", "Error while decoding")
STDERR_TAIL_CHARS = 400


class LegacyClockWarning(UserWarning):
    """A label timestamp before the stream start was mapped to frame 0."""


class StreamMeta(NamedTuple):
    width: int
    height: int
    fps: float
    duration_ms: float
    start_time_ms: float


def probe_stream(video: str) -> StreamMeta:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate,duration,start_time",
            "-of", "json", video,
        ],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    num, den = stream["avg_frame_rate"].split("/")
    fps = float(num) / float(den)
    try:
        start_time_ms = float(stream.get("start_time", 0)) * 1000
    except (TypeError, ValueError):
        start_time_ms = 0.0
    try:
        duration_ms = float(stream.get("duration", 0)) * 1000
    except (TypeError, ValueError):
        duration_ms = 0.0
    return StreamMeta(int(stream["width"]), int(stream["height"]), fps, duration_ms, start_time_ms)


def frame_index_for_t_ms(t_ms: float, fps: float, start_time_ms: float = 0.0) -> int:
    """Absolute source frame k whose pts is nearest to t_ms."""
    return int(round((t_ms - start_time_ms) * fps / 1000.0))


def pre_start_frames(t_ms: float, fps: float, start_time_ms: float = 0.0) -> float:
    """How many frame periods t_ms lies BEFORE the stream start (<= 0: at/after it)."""
    return (start_time_ms - t_ms) * fps / 1000.0


def frame_index_for_labelled_t_ms(t_ms: float, fps: float, start_time_ms: float = 0.0) -> tuple[int, bool]:
    """(absolute frame index, legacy_tolerance_used) for a LABEL timestamp.

    Same arithmetic as frame_index_for_t_ms, except that a timestamp at most
    LEGACY_PRE_START_TOLERANCE_FRAMES frame periods before the stream start
    (the legacy relative clock's tMs=0 on a container with nonzero start_time)
    maps to frame 0 and the flag is set so the caller can warn once per clip.
    Raises ValueError for anything earlier: it cannot name a real frame.
    """
    index = frame_index_for_t_ms(t_ms, fps, start_time_ms)
    if index >= 0:
        return index, False
    early = pre_start_frames(t_ms, fps, start_time_ms)
    if early > LEGACY_PRE_START_TOLERANCE_FRAMES + LEGACY_PRE_START_EPS_FRAMES:
        raise ValueError(
            f"tMs {t_ms:.3f} lies {early:.3f} frame periods before the stream start "
            f"({start_time_ms:.3f} ms); only one frame period of legacy-clock tolerance is allowed"
        )
    return 0, True


def t_ms_for_frame_index(index: int, fps: float, start_time_ms: float = 0.0) -> float:
    """Absolute pts (ms) of source frame `index` under the CFR model."""
    return start_time_ms + index * 1000.0 / fps


def seek_sec_for_frame_index(index: int, fps: float) -> float:
    """`-ss` value (relative to stream start) that lands exactly on frame `index`:
    its pts floored to ffmpeg's millisecond CLI precision, never rounded up past it."""
    return math.floor(index / fps * 1000.0) / 1000.0


def first_frame_index_at_or_after(start_ms: float, fps: float, start_time_ms: float = 0.0) -> int:
    """Index of the first frame whose pts >= start_ms (what ffmpeg emits after `-ss`)."""
    return max(0, math.ceil((start_ms - start_time_ms) * fps / 1000.0 - SEEK_EPS))


def plan_window_seek(start_ms: float, fps: float, start_time_ms: float = 0.0) -> tuple[int, float]:
    """(first absolute frame index, `-ss` seconds) for a window starting at start_ms."""
    first_index = first_frame_index_at_or_after(start_ms, fps, start_time_ms)
    return first_index, seek_sec_for_frame_index(first_index, fps)


def clip_frame_count(fps: float, duration_ms: float) -> int:
    return int(round(duration_ms * fps / 1000.0))


def window_frame_range(
    start_ms: float,
    end_ms: float,
    fps: float,
    start_time_ms: float,
    duration_ms: float,
) -> tuple[int, int]:
    """Absolute [first, last) frame indices a decode of window [start_ms, end_ms) yields.

    end_ms <= 0 means "to the end of the clip"; an end past the clip is clamped
    to it. Raises ValueError for windows that cannot contain a frame
    (end <= start, or start at/after the clip's end) so callers fail before
    spawning ffmpeg instead of emitting an empty artifact.
    """
    if end_ms > 0 and end_ms <= start_ms:
        raise ValueError(f"window end {end_ms:.3f} ms is not after start {start_ms:.3f} ms")
    total = clip_frame_count(fps, duration_ms)
    clip_end_ms = start_time_ms + duration_ms
    if duration_ms > 0 and start_ms >= clip_end_ms:
        raise ValueError(
            f"window start {start_ms:.3f} ms is at/after the clip end {clip_end_ms:.3f} ms"
        )
    first_index = first_frame_index_at_or_after(start_ms, fps, start_time_ms)
    if duration_ms > 0 and first_index >= total:
        raise ValueError(
            f"window start {start_ms:.3f} ms names frame {first_index} but the clip has only {total} frames"
        )
    if end_ms > 0:
        last_exclusive = math.ceil((end_ms - start_time_ms) * fps / 1000.0 - SEEK_EPS)
        if duration_ms > 0:
            last_exclusive = min(last_exclusive, total)
    elif duration_ms > 0:
        last_exclusive = total
    else:
        raise ValueError("open-ended window on a stream with unknown duration")
    return first_index, max(first_index, last_exclusive)


def window_to_sec(last_exclusive: int, fps: float, seek_sec: float = 0.0) -> float:
    """`-to` value (relative to stream start) that includes frame last_exclusive-1
    and excludes frame last_exclusive: the midpoint between their pts, so the
    millisecond CLI rounding can never clip the last wanted frame."""
    return max((last_exclusive - 0.5) / fps, seek_sec + 0.001)


def stderr_reader(proc: subprocess.Popen) -> Callable[[], str]:
    """Drain `proc.stderr` on a thread (a chatty decoder must not deadlock the
    frame pipe) and return a callable giving the whole stderr text once the
    process has finished (scan it with corruption_marker; show stderr_tail)."""
    chunks: list[bytes] = []
    stream = proc.stderr
    assert stream is not None

    def pump() -> None:
        for line in stream:
            chunks.append(line)
        stream.close()

    worker = threading.Thread(target=pump, daemon=True)
    worker.start()

    def text() -> str:
        worker.join(timeout=5.0)
        return b"".join(chunks).decode("utf-8", "replace").strip()

    return text


def stderr_tail(stderr_text: str) -> str:
    return stderr_text[-STDERR_TAIL_CHARS:]


def corruption_marker(stderr_text: str) -> str | None:
    """The CORRUPT_MEDIA_MARKERS phrase ffmpeg printed, or None for a clean decode."""
    for marker in CORRUPT_MEDIA_MARKERS:
        if marker in stderr_text:
            return marker
    return None


def check_decode_health(returncode: int, stderr_text: str, video: str) -> None:
    """Raise RuntimeError when ffmpeg exited non-zero or reported partial /
    corrupt media on stderr (which it does with exit status 0)."""
    tail = stderr_tail(stderr_text)
    if returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed (exit {returncode}) for {video}: {tail}")
    marker = corruption_marker(stderr_text)
    if marker is not None:
        raise RuntimeError(f"ffmpeg reported corrupt or partial media ({marker!r}) in {video}: {tail}")


def min_decoded_frames(expected: int, stride: int = 1, *, bounded_end: bool = False) -> int:
    """Fewest frames a complete decode of `expected` window frames may yield.

    With a `-to` bound (bounded_end) ffmpeg may drop the final frame on the
    boundary, so exactly one missing frame is tolerated. Without one the decode
    runs to the end of the media, so every frame the probe promised must arrive:
    a clip missing only its last packet still probes as complete.
    """
    tolerated = expected - 1 if bounded_end else expected
    return math.ceil(max(tolerated, 0) / stride)


def finite_float(text: str) -> float:
    """argparse type: a finite float (nan/inf/1e400 are refused with exit 2)."""
    value = float(text)
    if not math.isfinite(value):
        raise argparse.ArgumentTypeError(f"must be a finite number, got {text}")
    return value


def positive_float(text: str) -> float:
    value = finite_float(text)
    if not value > 0:
        raise argparse.ArgumentTypeError(f"must be > 0, got {text}")
    return value


def non_negative_float(text: str) -> float:
    value = finite_float(text)
    if value < 0:
        raise argparse.ArgumentTypeError(f"must be >= 0, got {text}")
    return value


def positive_int(text: str) -> int:
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be >= 1, got {text}")
    return value
