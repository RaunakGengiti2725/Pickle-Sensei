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
see its `clockCaveat`) were stamped i*1000/fps from the FIRST DECODED FRAME,
so on a container with nonzero start_time every label of such a clip sits one
start_time early: the strict inversion names label 0 as frame -1 and label i as
frame i-1. The two clocks share the same frame grid, so a single label cannot
tell them apart — but a clip can: any label lying (at most one frame period)
BEFORE the stream start is only possible on the relative clock, and then the
WHOLE clip's labels are relative to the first frame (label 0 -> frame 0,
label 33.37 -> frame 1). `frame_indices_for_labelled_clip` implements that and
the caller warns once per clip; a label earlier than one period still raises.
`frame_index_for_labelled_t_ms` is the single-label primitive (frame 0 for a
lone pre-start label).

Whole-clip frame count: `nb_frames` counts STORED samples, which for a
stream-copied cut (`ffmpeg -ss .. -to .. -c copy`) includes the keyframe
pre-roll the edit list hides from playback (110 stored, 77 presented), while
the duration counts the PRESENTED timeline but need not be a whole number of
frame periods (3.100 s at 25 fps = 77.5). A complete decode therefore yields at
least min(nb_frames, floor(duration * fps)) frames and exactly that many for a
clean CFR file, so `clip_frame_count` takes that minimum. The duration comes
from the stream, else the Matroska per-track DURATION tag, else the format;
when none is known the whole-clip decode is open-ended and truncation cannot
be detected (callers print one warning line, never fail a valid container).
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import threading
from typing import Callable, Iterable, NamedTuple

SEEK_EPS = 1e-6
# duration * fps lands within this many frames of an integer for a clean CFR
# stream (4.4044 s * 30000/1001 = 131.99999...); floor after adding it.
FRAME_COUNT_EPS = 1e-3
# A label may sit this many frame periods before the stream start and still
# name frame 0 (the legacy relative clock's first frame). The epsilon absorbs
# ffprobe's microsecond start_time rounding (33.367 ms vs 1000/29.97).
LEGACY_PRE_START_TOLERANCE_FRAMES = 1.0
LEGACY_PRE_START_EPS_FRAMES = 1e-3
# Documented upper bound for every millisecond window argument (--start-ms,
# --end-ms, label tMs): ~31.7 years. Anything above is a typo or an attack and
# is refused at argparse time; window_frame_range raises ValueError for it so
# float->int conversions can never overflow.
MAX_TIME_MS = 1e12
# --scale bounds: >= 8x upscaling of any real clip exhausts memory before it
# helps; the lower bound is enforced by the >= 2x2 output-size check.
MAX_SCALE = 8.0
# ffmpeg exits 0 for truncated/partial media and only reports it on stderr.
CORRUPT_MEDIA_MARKERS = ("partial file", "Invalid data", "Packet corrupt", "Error while decoding")
STDERR_TAIL_CHARS = 400


class LegacyClockWarning(UserWarning):
    """A clip's labels were interpreted on the legacy relative clock."""


class StreamMeta(NamedTuple):
    width: int
    height: int
    fps: float
    duration_ms: float  # 0.0 when neither the stream nor the format knows it
    start_time_ms: float
    nb_frames: int | None = None
    duration_source: str | None = None  # "stream" | "stream_tag" | "format" | None


def _parse_seconds(text: object) -> float | None:
    """ffprobe seconds ("8.000000") or a Matroska DURATION tag ("00:00:08.000000000")."""
    if text is None:
        return None
    try:
        if isinstance(text, str) and text.count(":") == 2:
            hours, minutes, seconds = text.split(":")
            value = int(hours) * 3600.0 + int(minutes) * 60.0 + float(seconds)
        else:
            value = float(text)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def probe_stream(video: str) -> StreamMeta:
    """One ffprobe call: geometry, fps, start_time, stored frame count and the
    best available duration (stream -> per-track DURATION tag -> format)."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,duration,start_time,nb_frames"
            ":stream_tags=DURATION:format=duration",
            "-of", "json", video,
        ],
        capture_output=True, text=True, check=True,
    )
    probe = json.loads(out.stdout)
    streams = probe.get("streams") or []
    if not streams:
        raise ValueError(f"{video}: ffprobe found no video stream")
    stream = streams[0]
    num, _, den = str(stream.get("avg_frame_rate", "")).partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError(f"{video}: ffprobe reports no usable frame rate ({stream.get('avg_frame_rate')!r})")
    start_time_s = _parse_seconds(stream.get("start_time"))
    start_time_ms = start_time_s * 1000 if start_time_s is not None else 0.0
    duration_ms, duration_source = 0.0, None
    for source, text in (
        ("stream", stream.get("duration")),
        ("stream_tag", (stream.get("tags") or {}).get("DURATION")),
        ("format", (probe.get("format") or {}).get("duration")),
    ):
        seconds = _parse_seconds(text)
        if seconds is not None and seconds > 0:
            duration_ms, duration_source = seconds * 1000, source
            break
    nb_frames: int | None = None
    try:
        nb_frames = int(stream["nb_frames"])
    except (KeyError, TypeError, ValueError):
        pass
    if nb_frames is not None and nb_frames <= 0:
        nb_frames = None
    return StreamMeta(
        int(stream["width"]), int(stream["height"]), fps, duration_ms, start_time_ms,
        nb_frames, duration_source,
    )


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
    if not math.isfinite(t_ms) or abs(t_ms) > MAX_TIME_MS:
        raise ValueError(f"tMs {t_ms!r} is not a finite timestamp within +-{MAX_TIME_MS:g} ms")
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


def frame_indices_for_labelled_clip(
    t_ms_list: Iterable[float],
    fps: float,
    start_time_ms: float = 0.0,
    *,
    legacy_clock: bool = False,
) -> tuple[dict[float, int], list[float]]:
    """({tMs: absolute frame index}, pre-start labels) for ALL labels of one clip.

    The clock is decided per clip, provenance first: `legacy_clock=True` (the
    release stamps the clip's teacher rows with a `clockCaveat`) forces the
    legacy relative clock. Heuristic second: if any label lies before the
    stream start (strict inversion < 0, at most one frame period early —
    anything earlier raises ValueError, whatever the clock) the clip was
    labelled on the legacy relative clock too. On that clock EVERY label maps
    as round(tMs * fps / 1000) from the first decoded frame (0.0 -> frame 0,
    33.37 -> frame 1, never below 0); otherwise labels are absolute pts
    (frame_index_for_t_ms). The returned pre-start list holds the labels that
    triggered the heuristic (empty when only provenance did), so the caller
    can warn once per clip via `legacy_clock or pre_start`.
    """
    labels = list(t_ms_list)
    pre_start = [t for t in labels if frame_index_for_labelled_t_ms(t, fps, start_time_ms)[1]]
    if legacy_clock or pre_start:
        return {t: max(0, frame_index_for_t_ms(t, fps, 0.0)) for t in labels}, pre_start
    return {t: frame_index_for_t_ms(t, fps, start_time_ms) for t in labels}, pre_start


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


def clip_frame_count(fps: float, duration_ms: float, nb_frames: int | None = None) -> int:
    """Frames a complete whole-clip decode yields: min(nb_frames, floor(duration * fps)).

    nb_frames counts stored samples (a stream-copied cut keeps its keyframe
    pre-roll behind the edit list), floor(duration * fps) counts presented
    frame periods (a cut duration need not be whole). Each alone over-counts a
    complete clip in one of those cases; their minimum never does, and a file
    byte-truncated behind a complete header (200 frames promised, 199 stored)
    still fails it. 0 when neither is known.
    """
    from_duration = math.floor(duration_ms * fps / 1000.0 + FRAME_COUNT_EPS) if duration_ms > 0 else 0
    if nb_frames is not None and nb_frames > 0:
        return min(nb_frames, from_duration) if from_duration > 0 else nb_frames
    return max(from_duration, 0)


def check_time_ms(value: float, name: str = "time") -> float:
    """Typed range check for a millisecond argument: finite and within [0, MAX_TIME_MS]."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{name} must be a number, got {value!r}")
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite, got {value!r}")
    if value < 0 or value > MAX_TIME_MS:
        raise ValueError(f"{name} {value:g} ms is outside the supported range 0..{MAX_TIME_MS:g} ms")
    return float(value)


def window_frame_range(
    start_ms: float,
    end_ms: float,
    fps: float,
    start_time_ms: float,
    duration_ms: float,
    nb_frames: int | None = None,
) -> tuple[int, int | None]:
    """Absolute [first, last) frame indices a decode of window [start_ms, end_ms) yields.

    end_ms <= 0 means "to the end of the clip"; an end past the clip is clamped
    to it. `last` is None only for an open-ended window on a clip whose
    duration is unknown (no stream, tag or format duration): the decode then
    runs to the end of the media and callers must not enforce a frame count
    (see unknown_duration_message). Raises ValueError — never OverflowError —
    for out-of-range arguments (non-finite, negative, > MAX_TIME_MS) and for
    windows that cannot contain a frame (end <= start, or start at/after the
    clip's end) so callers fail before spawning ffmpeg instead of emitting an
    empty artifact.
    """
    start_ms = check_time_ms(start_ms, "window start")
    end_ms = check_time_ms(end_ms, "window end")
    if not (math.isfinite(fps) and 0 < fps <= 1e6):
        raise ValueError(f"frame rate {fps!r} is not usable")
    if not (math.isfinite(start_time_ms) and abs(start_time_ms) <= MAX_TIME_MS):
        raise ValueError(f"stream start_time {start_time_ms!r} ms is not usable")
    if not (math.isfinite(duration_ms) and duration_ms <= MAX_TIME_MS):
        raise ValueError(f"stream duration {duration_ms!r} ms is not usable")
    if end_ms > 0 and end_ms <= start_ms:
        raise ValueError(f"window end {end_ms:.3f} ms is not after start {start_ms:.3f} ms")
    total = clip_frame_count(fps, duration_ms, nb_frames)
    clip_end_ms = start_time_ms + duration_ms
    if duration_ms > 0 and start_ms >= clip_end_ms:
        raise ValueError(
            f"window start {start_ms:.3f} ms is at/after the clip end {clip_end_ms:.3f} ms"
        )
    first_index = first_frame_index_at_or_after(start_ms, fps, start_time_ms)
    if total > 0 and first_index >= total:
        raise ValueError(
            f"window start {start_ms:.3f} ms names frame {first_index} but the clip has only {total} frames"
        )
    if end_ms > 0:
        last_exclusive = math.ceil((end_ms - start_time_ms) * fps / 1000.0 - SEEK_EPS)
        if total > 0:
            last_exclusive = min(last_exclusive, total)
        return first_index, max(first_index, last_exclusive)
    if total > 0:
        return first_index, max(first_index, total)
    return first_index, None


def unknown_duration_message(video: str) -> str:
    """The one-line stderr notice for an open-ended decode whose completeness cannot be checked."""
    return (
        f"frame_clock: {video}: neither the stream nor the container reports a duration; "
        "decoding to the end of the media — a truncated file cannot be detected"
    )


def min_frames_for_window(
    first_index: int, last_exclusive: int | None, stride: int = 1, *, bounded_end: bool, video: str
) -> int:
    """Fewest frames a complete decode of the planned window must yield. When
    the clip length is unknown (open-ended window, last_exclusive None) the
    count cannot be checked — unknown_duration_message is printed once and the
    decode must merely yield a frame at all (a start inside the media always
    does; an empty decode means the start lies past the end)."""
    if last_exclusive is None:
        print(unknown_duration_message(video), file=sys.stderr)
        return 1
    return min_decoded_frames(last_exclusive - first_index, stride, bounded_end=bounded_end)


def shortfall_message(
    decoded: int, min_frames: int, first_index: int, last_exclusive: int | None, start_ms: float, end_ms: float,
    video: str, stderr_text: str, stride: int = 1,
) -> str:
    """RuntimeError text for a decode that yielded fewer frames than the window implies."""
    window = f"window [{start_ms:.1f}, {end_ms:.1f}) ms in {video}"
    tail = f"ffmpeg stderr: {stderr_tail(stderr_text)}"
    if last_exclusive is None:
        return (
            f"ffmpeg decoded no frames of {window}: the window start (frame {first_index}) lies at/after "
            f"the end of the media, whose duration the container does not report. {tail}"
        )
    frames = f"frames {first_index}..{last_exclusive - 1}" + (f", stride {stride}" if stride != 1 else "")
    return (
        f"ffmpeg decoded {decoded} frames of {window} but the probed stream implies at least "
        f"{min_frames} ({frames}) — truncated or partial media? {tail}"
    )


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


def time_ms(text: str) -> float:
    """argparse type for --start-ms/--end-ms: finite, >= 0 and <= MAX_TIME_MS (1e12 ms)."""
    value = non_negative_float(text)
    if value > MAX_TIME_MS:
        raise argparse.ArgumentTypeError(f"must be <= {MAX_TIME_MS:g} ms, got {text}")
    return value


def scale_factor(text: str) -> float:
    """argparse type for --scale: finite, > 0 and <= MAX_SCALE."""
    value = positive_float(text)
    if value > MAX_SCALE:
        raise argparse.ArgumentTypeError(f"must be <= {MAX_SCALE:g}, got {text}")
    return value


def positive_int(text: str) -> int:
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be >= 1, got {text}")
    return value
