#!/usr/bin/env python3
"""Minimal ISO-BMFF (MP4/QuickTime) inspector and timeline mutator.

Pure Python 3.9+, no dependencies. Used by the attack harness to

  inspect <file>            print the box tree plus the header durations
                            (mvhd / tkhd / mdhd), edit lists, per-fragment
                            sample counts and default durations — enough to
                            see when a container's declared duration
                            disagrees with its samples (the shape that made
                            AVFoundation report 12 fps / 121.75 s for the
                            60.9 s, 24 fps committed reference clip).
  rotate-90cw <in> <out>    write the iPhone-portrait display matrix
                            (a=0,b=1,c=-1,d=0,tx=stored height) into the
                            first video track: a non-identity
                            preferredTransform with the stored size intact.
  elst-rewind <in> <out>    add an edit list that plays media [0, A) and then
                            REWINDS to media [B, C): a PTS rewind expressed
                            the way concatenation tools express it.
  ctts-rewind <in> <out>    give a run of samples a large NEGATIVE
                            composition offset (ctts version 1) so the raw
                            sample PTS jumps backwards mid-stream.

Both mutators require a flat MP4 whose `moov` follows `mdat` (ffmpeg's
default without `-movflags faststart`), so growing `moov` never moves the
sample data and `stco`/`co64` offsets stay valid. Only the FIRST video
track is edited.
"""

from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass
from typing import Iterator, Optional

CONTAINERS = {
    b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"moof", b"traf",
    b"mvex", b"dinf", b"udta",
}
FULL_BOX_CONTAINERS = {b"meta"}


@dataclass
class Box:
    type: bytes
    offset: int
    size: int
    header: int

    @property
    def payload(self) -> slice:
        return slice(self.offset + self.header, self.offset + self.size)


def iter_boxes(data: bytes, start: int, end: int) -> Iterator[Box]:
    offset = start
    while offset + 8 <= end:
        size, kind = struct.unpack(">I4s", data[offset:offset + 8])
        header = 8
        if size == 1:
            size = struct.unpack(">Q", data[offset + 8:offset + 16])[0]
            header = 16
        elif size == 0:
            size = end - offset
        if size < header:
            raise ValueError(f"corrupt box {kind!r} at {offset}: size {size}")
        yield Box(kind, offset, size, header)
        offset += size


def find(data: bytes, start: int, end: int, path: list[bytes]) -> Optional[Box]:
    for box in iter_boxes(data, start, end):
        if box.type == path[0]:
            if len(path) == 1:
                return box
            inner = box.payload
            skip = 4 if box.type in FULL_BOX_CONTAINERS else 0
            found = find(data, inner.start + skip, inner.stop, path[1:])
            if found is not None:
                return found
    return None


def find_all(data: bytes, start: int, end: int, kind: bytes) -> list[Box]:
    return [b for b in iter_boxes(data, start, end) if b.type == kind]


def _version_and_durations(payload: bytes, kind: bytes) -> tuple[int, int, int]:
    """(version, timescale, duration) for mvhd/mdhd; tkhd has no timescale."""
    version = payload[0]
    if kind == b"tkhd":
        if version == 1:
            duration = struct.unpack(">Q", payload[28:36])[0]
        else:
            duration = struct.unpack(">I", payload[20:24])[0]
        return version, 0, duration
    if version == 1:
        timescale, duration = struct.unpack(">IQ", payload[20:32])
    else:
        timescale, duration = struct.unpack(">II", payload[12:20])
    return version, timescale, duration


def inspect(path: str) -> int:
    data = open(path, "rb").read()
    top = list(iter_boxes(data, 0, len(data)))
    print(f"{path}: {len(data)} bytes, top-level boxes: {[b.type.decode('latin1') for b in top]}")
    moov = find(data, 0, len(data), [b"moov"])
    if moov is None:
        print("no moov box")
        return 1
    mdat = find(data, 0, len(data), [b"mdat"])
    if mdat is not None:
        print(f"moov@{moov.offset} mdat@{mdat.offset} -> {'moov AFTER mdat (patchable)' if moov.offset > mdat.offset else 'moov BEFORE mdat (faststart; not patchable here)'}")
    mvhd = find(data, moov.payload.start, moov.payload.stop, [b"mvhd"])
    if mvhd is not None:
        _, ts, dur = _version_and_durations(data[mvhd.payload], b"mvhd")
        print(f"mvhd timescale={ts} duration={dur} ({dur / ts if ts else 0:.3f}s)")
    for index, trak in enumerate(find_all(data, moov.payload.start, moov.payload.stop, b"trak")):
        hdlr = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"hdlr"])
        handler = data[hdlr.payload][8:12].decode("latin1") if hdlr else "?"
        tkhd = find(data, trak.payload.start, trak.payload.stop, [b"tkhd"])
        mdhd = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"mdhd"])
        line = f"trak[{index}] handler={handler}"
        if tkhd is not None:
            _, _, tdur = _version_and_durations(data[tkhd.payload], b"tkhd")
            matrix = struct.unpack(">9i", data[tkhd.payload][40 if data[tkhd.payload][0] == 0 else 52:][:36])
            width, height = struct.unpack(">II", data[tkhd.payload][76 if data[tkhd.payload][0] == 0 else 88:][:8])
            line += f" tkhd.duration={tdur} matrix={[m / 65536 if i % 3 != 2 else m / (1 << 30) for i, m in enumerate(matrix)]} size={width >> 16}x{height >> 16}"
        if mdhd is not None:
            _, mts, mdur = _version_and_durations(data[mdhd.payload], b"mdhd")
            line += f" mdhd timescale={mts} duration={mdur} ({mdur / mts if mts else 0:.3f}s)"
        print(line)
        elst = find(data, trak.payload.start, trak.payload.stop, [b"edts", b"elst"])
        if elst is not None:
            payload = data[elst.payload]
            version = payload[0]
            count = struct.unpack(">I", payload[4:8])[0]
            entries = []
            pos = 8
            for _ in range(count):
                if version == 1:
                    seg, media = struct.unpack(">Qq", payload[pos:pos + 16]); pos += 16
                else:
                    seg, media = struct.unpack(">Ii", payload[pos:pos + 8]); pos += 8
                rate = struct.unpack(">i", payload[pos:pos + 4])[0]; pos += 4
                entries.append({"segmentDuration": seg, "mediaTime": media, "rate": rate / 65536})
            print(f"  elst v{version}: {entries}")
        stts = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"minf", b"stbl", b"stts"])
        if stts is not None:
            payload = data[stts.payload]
            count = struct.unpack(">I", payload[4:8])[0]
            runs = [struct.unpack(">II", payload[8 + 8 * i:16 + 8 * i]) for i in range(count)]
            samples = sum(r[0] for r in runs)
            print(f"  stts runs={len(runs)} samples={samples} first={runs[:3]}")
        ctts = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"minf", b"stbl", b"ctts"])
        if ctts is not None:
            payload = data[ctts.payload]
            version = payload[0]
            count = struct.unpack(">I", payload[4:8])[0]
            fmt = ">Ii" if version == 1 else ">II"
            runs = [struct.unpack(fmt, payload[8 + 8 * i:16 + 8 * i]) for i in range(count)]
            print(f"  ctts v{version} runs={len(runs)} first={runs[:4]} min_offset={min(r[1] for r in runs) if runs else None}")
    moofs = find_all(data, 0, len(data), b"moof")
    if moofs:
        total = 0
        for moof in moofs:
            for traf in find_all(data, moof.payload.start, moof.payload.stop, b"traf"):
                tfhd = find(data, traf.payload.start, traf.payload.stop, [b"tfhd"])
                flags = struct.unpack(">I", data[tfhd.payload][:4])[0] & 0xFFFFFF if tfhd else 0
                default_duration = None
                if tfhd and flags & 0x08:
                    pos = 8 + (8 if flags & 0x01 else 0) + (4 if flags & 0x02 else 0)
                    default_duration = struct.unpack(">I", data[tfhd.payload][pos:pos + 4])[0]
                for trun in find_all(data, traf.payload.start, traf.payload.stop, b"trun"):
                    total += struct.unpack(">I", data[trun.payload][4:8])[0]
                if moof is moofs[0]:
                    print(f"  first moof: tfhd.flags={flags:#x} default_sample_duration={default_duration}")
        print(f"fragmented: moof count={len(moofs)} total trun samples={total}")
    return 0


def _replace_range(data: bytes, start: int, stop: int, new: bytes) -> bytes:
    return data[:start] + new + data[stop:]


def _set_size(data: bytes, box: Box, delta: int) -> bytes:
    if box.header == 16:
        return _replace_range(data, box.offset + 8, box.offset + 16, struct.pack(">Q", box.size + delta))
    return _replace_range(data, box.offset, box.offset + 4, struct.pack(">I", box.size + delta))


def _video_trak(data: bytes, moov: Box) -> Box:
    for trak in find_all(data, moov.payload.start, moov.payload.stop, b"trak"):
        hdlr = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"hdlr"])
        if hdlr is not None and data[hdlr.payload][8:12] == b"vide":
            return trak
    raise SystemExit("no video track")


def _require_moov_after_mdat(data: bytes) -> Box:
    moov = find(data, 0, len(data), [b"moov"])
    mdat = find(data, 0, len(data), [b"mdat"])
    if moov is None or mdat is None:
        raise SystemExit("need both moov and mdat")
    if moov.offset < mdat.offset:
        raise SystemExit("moov precedes mdat (faststart); re-mux without -movflags faststart")
    if find_all(data, 0, len(data), b"moof"):
        raise SystemExit("fragmented input is not supported by the mutators")
    return moov


def _set_durations(data: bytes, moov: Box, trak: Box, movie_duration_units: int) -> bytes:
    """Write mvhd.duration and tkhd.duration (movie timescale units)."""
    mvhd = find(data, moov.payload.start, moov.payload.stop, [b"mvhd"])
    tkhd = find(data, trak.payload.start, trak.payload.stop, [b"tkhd"])
    assert mvhd is not None and tkhd is not None
    payload = data[mvhd.payload]
    if payload[0] == 1:
        data = _replace_range(data, mvhd.payload.start + 24, mvhd.payload.start + 32, struct.pack(">Q", movie_duration_units))
    else:
        data = _replace_range(data, mvhd.payload.start + 16, mvhd.payload.start + 20, struct.pack(">I", movie_duration_units))
    payload = data[tkhd.payload]
    if payload[0] == 1:
        data = _replace_range(data, tkhd.payload.start + 28, tkhd.payload.start + 36, struct.pack(">Q", movie_duration_units))
    else:
        data = _replace_range(data, tkhd.payload.start + 20, tkhd.payload.start + 24, struct.pack(">I", movie_duration_units))
    return data


def elst_rewind(src: str, dst: str, first_end_s: float, second_start_s: float, second_end_s: float) -> int:
    data = open(src, "rb").read()
    moov = _require_moov_after_mdat(data)
    trak = _video_trak(data, moov)
    mvhd = find(data, moov.payload.start, moov.payload.stop, [b"mvhd"])
    mdhd = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"mdhd"])
    assert mvhd is not None and mdhd is not None
    _, movie_ts, _ = _version_and_durations(data[mvhd.payload], b"mvhd")
    _, media_ts, media_dur = _version_and_durations(data[mdhd.payload], b"mdhd")
    if second_end_s * media_ts > media_dur:
        raise SystemExit(f"second edit ends past media duration {media_dur / media_ts:.3f}s")

    seg1 = int(round(first_end_s * movie_ts))
    seg2 = int(round((second_end_s - second_start_s) * movie_ts))
    media2 = int(round(second_start_s * media_ts))
    entries = struct.pack(">Ii i", seg1, 0, 1 << 16) + struct.pack(">Ii i", seg2, media2, 1 << 16)
    elst_payload = struct.pack(">B3xI", 0, 2) + entries
    elst_box = struct.pack(">I4s", 8 + len(elst_payload), b"elst") + elst_payload
    edts_box = struct.pack(">I4s", 8 + len(elst_box), b"edts") + elst_box

    existing = find(data, trak.payload.start, trak.payload.stop, [b"edts"])
    if existing is not None:
        delta = len(edts_box) - existing.size
        data = _replace_range(data, existing.offset, existing.offset + existing.size, edts_box)
    else:
        # Insert edts right after tkhd (spec order: tkhd, [tref], [edts], mdia).
        tkhd = find(data, trak.payload.start, trak.payload.stop, [b"tkhd"])
        assert tkhd is not None
        insert_at = tkhd.offset + tkhd.size
        delta = len(edts_box)
        data = data[:insert_at] + edts_box + data[insert_at:]
    data = _set_size(data, trak, delta)
    data = _set_size(data, moov, delta)
    data = _set_durations(data, moov, trak, seg1 + seg2)
    open(dst, "wb").write(data)
    print(
        f"wrote {dst}: edits play media [0,{first_end_s}s) then rewind to media "
        f"[{second_start_s}s,{second_end_s}s); movie duration {(seg1 + seg2) / movie_ts:.3f}s"
    )
    return 0


def ctts_rewind(src: str, dst: str, rewind_from_sample: int, rewind_samples: int, rewind_seconds: float) -> int:
    data = open(src, "rb").read()
    moov = _require_moov_after_mdat(data)
    trak = _video_trak(data, moov)
    stbl = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"minf", b"stbl"])
    mdhd = find(data, trak.payload.start, trak.payload.stop, [b"mdia", b"mdhd"])
    assert stbl is not None and mdhd is not None
    if find(data, stbl.payload.start, stbl.payload.stop, [b"ctts"]) is not None:
        raise SystemExit("input already has ctts (B-frames); encode with -bf 0")
    stts = find(data, stbl.payload.start, stbl.payload.stop, [b"stts"])
    assert stts is not None
    payload = data[stts.payload]
    count = struct.unpack(">I", payload[4:8])[0]
    total = sum(struct.unpack(">I", payload[8 + 8 * i:12 + 8 * i])[0] for i in range(count))
    if rewind_from_sample + rewind_samples > total:
        raise SystemExit(f"rewind range exceeds {total} samples")
    _, media_ts, _ = _version_and_durations(data[mdhd.payload], b"mdhd")
    offset = -int(round(rewind_seconds * media_ts))
    runs = []
    if rewind_from_sample > 0:
        runs.append((rewind_from_sample, 0))
    runs.append((rewind_samples, offset))
    tail = total - rewind_from_sample - rewind_samples
    if tail > 0:
        runs.append((tail, 0))
    ctts_payload = struct.pack(">B3xI", 1, len(runs)) + b"".join(struct.pack(">Ii", n, o) for n, o in runs)
    ctts_box = struct.pack(">I4s", 8 + len(ctts_payload), b"ctts") + ctts_payload
    insert_at = stts.offset + stts.size
    data = data[:insert_at] + ctts_box + data[insert_at:]
    delta = len(ctts_box)
    # Grow every ancestor: stbl, minf, mdia, trak, moov.
    for path in ([b"mdia", b"minf", b"stbl"], [b"mdia", b"minf"], [b"mdia"]):
        box = find(data, trak.payload.start, trak.payload.stop, path)
        assert box is not None
        data = _set_size(data, box, delta)
    data = _set_size(data, trak, delta)
    data = _set_size(data, moov, delta)
    open(dst, "wb").write(data)
    print(
        f"wrote {dst}: samples [{rewind_from_sample},{rewind_from_sample + rewind_samples}) get "
        f"composition offset {offset} ({-rewind_seconds}s) -> raw PTS rewinds mid-stream"
    )
    return 0


def set_rotation_90cw(src: str, dst: str) -> int:
    """Write the iPhone-portrait display matrix (a=0,b=1,c=-1,d=0,tx=height)
    into the first video track: stored pixel (x, y) -> (height - y, x), i.e.
    the presentation is the stored picture rotated 90° clockwise. tkhd
    width/height keep the STORED (landscape) size exactly as iPhone files do."""
    data = open(src, "rb").read()
    moov = find(data, 0, len(data), [b"moov"])
    if moov is None:
        raise SystemExit("no moov")
    trak = _video_trak(data, moov)
    tkhd = find(data, trak.payload.start, trak.payload.stop, [b"tkhd"])
    assert tkhd is not None
    payload = data[tkhd.payload]
    version = payload[0]
    matrix_at = tkhd.payload.start + (52 if version == 1 else 40)
    size_at = tkhd.payload.start + (88 if version == 1 else 76)
    width, height = struct.unpack(">II", data[size_at:size_at + 8])
    stored_height = height >> 16
    fixed = lambda v: int(round(v * 65536))
    matrix = struct.pack(
        ">9i",
        fixed(0), fixed(1), 0,
        fixed(-1), fixed(0), 0,
        fixed(stored_height), fixed(0), 1 << 30,
    )
    data = _replace_range(data, matrix_at, matrix_at + 36, matrix)
    open(dst, "wb").write(data)
    print(f"wrote {dst}: tkhd matrix = rotate 90° CW with tx={stored_height} (stored {width >> 16}x{stored_height})")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inspect"); p.add_argument("file")
    p = sub.add_parser("rotate-90cw"); p.add_argument("src"); p.add_argument("dst")
    p = sub.add_parser("elst-rewind")
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--first-end", type=float, default=2.0, help="seconds of media played before the rewind")
    p.add_argument("--second-start", type=float, default=1.0, help="media time the second edit rewinds to")
    p.add_argument("--second-end", type=float, default=3.0, help="media time the second edit ends at")
    p = sub.add_parser("ctts-rewind")
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--from-sample", type=int, default=30)
    p.add_argument("--samples", type=int, default=15)
    p.add_argument("--rewind-seconds", type=float, default=0.75)
    args = parser.parse_args(argv)
    if args.command == "inspect":
        return inspect(args.file)
    if args.command == "rotate-90cw":
        return set_rotation_90cw(args.src, args.dst)
    if args.command == "elst-rewind":
        return elst_rewind(args.src, args.dst, args.first_end, args.second_start, args.second_end)
    return ctts_rewind(args.src, args.dst, args.from_sample, args.samples, args.rewind_seconds)


if __name__ == "__main__":
    sys.exit(main())
