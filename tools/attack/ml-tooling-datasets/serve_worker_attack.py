#!/usr/bin/env python3
"""Adversarial harness for tools/paddle-lab/detect_paddle.py --serve (scenario S1 + extras).

Drives the JSONL worker through hostile client behaviour and records, per case:
worker exit code, time-to-exit, protocol responses, and whether any ffmpeg spawned for
the test clip survives (pgrep -f <clip path>; state column exposes zombies `Z`).

Cases
  eof_mid_request     close the worker's stdin while a detect request is decoding
  sigterm_mid_request SIGTERM the worker while ffmpeg is alive
  sigkill_mid_request SIGKILL the worker while ffmpeg is alive
  stdout_closed       close OUR read end of the worker's stdout mid-request (client died)
  hostile_lines       non-JSON, JSON array, unknown op, missing keys, unicode, 1 MiB line,
                      rapid ping bursts — worker must answer each and keep serving
  bad_requests        nonexistent video, unwritable out, stride 0 / negative, NaN floor,
                      degenerate roi, garbage decodeSize — every one must be a JSON error
                      response, the worker must survive, and no ffmpeg may be left behind
  shutdown            explicit {"op":"shutdown"} -> exit 0

Usage (needs the paddle-lab venv: torch, torchvision, transformers, pillow, numpy; ffmpeg):
  <venv>/bin/python tools/attack/ml-tooling-datasets/serve_worker_attack.py \
      [--python <venv>/bin/python] [--out results.json] [--clip-seconds 6] [--seed 20260904]

Exit 0 = every case matched the documented protocol contract; 1 = at least one deviation
(printed as `DEVIATION <case>: <detail>`). A synthetic ffmpeg testsrc clip is used so the
harness never touches datasets/.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
WORKER = REPO / "tools" / "paddle-lab" / "detect_paddle.py"


def make_clip(path: Path, seconds: int) -> None:
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi",
            "-i", f"testsrc=duration={seconds}:size=640x360:rate=10",
            "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
    )


def ffmpeg_for(clip: Path) -> list[str]:
    """`PID PPID STAT` rows for every ffmpeg whose command line names the clip (zombies included)."""
    out = subprocess.run(["ps", "-eo", "pid,ppid,stat,comm,args"], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines()[1:]:
        if "ffmpeg" in line and str(clip) in line:
            rows.append(" ".join(line.split()[:4]))
    return rows


def wait_for_ffmpeg(clip: Path, timeout: float = 60.0) -> list[str]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = ffmpeg_for(clip)
        if rows:
            return rows
        time.sleep(0.05)
    return []


def settle_ffmpeg(clip: Path, timeout: float = 15.0) -> list[str]:
    """Give the tree a moment to reap, then report whatever ffmpeg is still visible."""
    deadline = time.time() + timeout
    rows = ffmpeg_for(clip)
    while rows and time.time() < deadline:
        time.sleep(0.25)
        rows = ffmpeg_for(clip)
    return rows


class Worker:
    def __init__(self, python: str):
        # stdout goes through a raw pipe polled with select() so the harness can drop
        # its read end at any moment (simulating a dead client) without a blocked
        # reader keeping the pipe alive.
        self._out_r, out_w = os.pipe()
        self.proc = subprocess.Popen(
            [python, str(WORKER), "--serve", "--no-warmup"],
            stdin=subprocess.PIPE,
            stdout=out_w,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(REPO / "tools" / "paddle-lab"),
        )
        os.close(out_w)
        self.lines: list[str] = []
        self.stderr_chunks: list[str] = []
        self._stop_reading = threading.Event()
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        self._err = threading.Thread(target=self._pump_err, daemon=True)
        self._err.start()

    def _pump(self) -> None:
        buffer = b""
        while not self._stop_reading.is_set():
            ready, _, _ = select.select([self._out_r], [], [], 0.05)
            if not ready:
                continue
            chunk = os.read(self._out_r, 1 << 16)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                self.lines.append(line.decode("utf-8", errors="replace"))
        if buffer:
            self.lines.append(buffer.decode("utf-8", errors="replace"))

    def drop_stdout(self) -> None:
        """Client dies: stop reading and close our end of the worker's stdout pipe."""
        self._stop_reading.set()
        self._reader.join(timeout=2)
        os.close(self._out_r)
        self._out_r = -1

    def _pump_err(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr_chunks.append(line.rstrip("\n"))

    def wait_ready(self, timeout: float = 300.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for line in self.lines:
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("event") == "ready":
                    return msg
            if self.proc.poll() is not None:
                raise RuntimeError(f"worker died before ready: exit {self.proc.returncode}\n" + "\n".join(self.stderr_chunks[-20:]))
            time.sleep(0.1)
        raise RuntimeError("worker never became ready")

    def send_raw(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    def send(self, obj: dict) -> None:
        self.send_raw(json.dumps(obj) + "\n")

    def responses(self) -> list[dict]:
        out = []
        for line in self.lines:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                out.append({"_nonjson": line})
        return out

    def wait_response(self, request_id, timeout: float = 600.0) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for msg in self.responses():
                if msg.get("id") == request_id:
                    return msg
            if self.proc.poll() is not None:
                return None
            time.sleep(0.05)
        return None

    def close_stdin(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()

    def wait_exit(self, timeout: float = 600.0) -> int | None:
        try:
            code = self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None
        # Drain: the pump sees EOF once the worker's write end is gone.
        self._reader.join(timeout=5)
        return code

    def kill(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self._stop_reading.set()
        if self._out_r != -1:
            self._reader.join(timeout=2)
            os.close(self._out_r)
            self._out_r = -1

    @property
    def traceback(self) -> bool:
        return any("Traceback (most recent call last)" in chunk for chunk in self.stderr_chunks)


def detect_request(request_id: str, clip: Path, out_dir: Path, **overrides) -> dict:
    req = {
        "id": request_id,
        "video": str(clip),
        "out": str(out_dir / f"{request_id}.json"),
        "startMs": 0,
        "endMs": 0,
        "stride": 1,
        "floor": 0.08,
        "roi": None,
        "decodeSize": None,
        "legacyDecode": False,
    }
    req.update(overrides)
    return req


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--out", default=str(Path.cwd() / "serve-worker-attack.json"))
    parser.add_argument("--clip-seconds", type=int, default=6)
    parser.add_argument("--seed", type=int, default=20260904)
    parser.add_argument("--eof-repeats", type=int, default=3, help="extra EOF-mid-request runs at seeded random delays")
    args = parser.parse_args()
    rng = random.Random(args.seed)

    work = Path(tempfile.mkdtemp(prefix="attack-serve-"))
    clip = work / "testsrc.mp4"
    make_clip(clip, args.clip_seconds)
    out_dir = work / "out"
    out_dir.mkdir()
    results: dict = {"seed": args.seed, "clip": str(clip), "python": args.python, "cases": {}}
    deviations: list[str] = []

    def record(case: str, **fields) -> None:
        results["cases"][case] = fields
        print(f"=== {case}\n{json.dumps(fields, indent=2, default=str)}", flush=True)

    def deviation(case: str, detail: str) -> None:
        deviations.append(f"{case}: {detail}")
        print(f"DEVIATION {case}: {detail}", flush=True)

    # ---------------------------------------------------------------- S1 eof
    def mid_request(case: str, action) -> None:
        w = Worker(args.python)
        ready = w.wait_ready()
        w.send(detect_request("r-mid", clip, out_dir))
        seen = wait_for_ffmpeg(clip)
        if not seen:
            deviation(case, "ffmpeg never appeared for the request (cannot attack mid-flight)")
        started = time.time()
        action(w)
        exit_code = w.wait_exit(timeout=600)
        elapsed = round(time.time() - started, 3)
        leftover = settle_ffmpeg(clip)
        resp = w.wait_response("r-mid", timeout=0.1)
        record(
            case,
            ready=ready,
            ffmpeg_seen_during_request=seen,
            worker_exit=exit_code,
            seconds_from_action_to_exit=elapsed,
            request_response=resp,
            ffmpeg_after_exit=leftover,
            traceback=w.traceback,
            stderr_tail=w.stderr_chunks[-5:],
        )
        w.kill()
        return exit_code, leftover, resp, w

    exit_code, leftover, resp, w = mid_request("eof_mid_request", lambda w: w.close_stdin())
    if exit_code != 0:
        deviation("eof_mid_request", f"expected exit 0 on stdin EOF, got {exit_code}")
    if leftover:
        deviation("eof_mid_request", f"ffmpeg left behind: {leftover}")
    if w.traceback:
        deviation("eof_mid_request", "traceback on stderr")

    # Rapid repeats: EOF lands at a seeded random point after ffmpeg spawns (0..2s),
    # including queued extra requests behind the one in flight.
    for i in range(args.eof_repeats):
        delay = round(rng.uniform(0.0, 2.0), 3)
        queued = rng.randint(0, 3)

        def eof_after_delay(w: Worker, delay=delay, queued=queued) -> None:
            for k in range(queued):
                w.send(detect_request(f"r-queued-{k}", clip, out_dir, stride=6))
            time.sleep(delay)
            w.close_stdin()

        case = f"eof_mid_request_repeat{i}"
        exit_code, leftover, _, w = mid_request(case, eof_after_delay)
        results["cases"][case]["delay_s"] = delay
        results["cases"][case]["queued_requests"] = queued
        answered = [m.get("id") for m in w.responses() if str(m.get("id", "")).startswith("r-")]
        results["cases"][case]["answered_ids"] = answered
        if exit_code != 0:
            deviation(case, f"expected exit 0 on stdin EOF, got {exit_code}")
        if leftover:
            deviation(case, f"ffmpeg left behind: {leftover}")
        if len(answered) != 1 + queued:
            deviation(case, f"expected {1 + queued} answered requests before exit, saw {answered}")

    exit_code, leftover, _, _ = mid_request("sigterm_mid_request", lambda w: w.proc.send_signal(signal.SIGTERM))
    if leftover:
        deviation("sigterm_mid_request", f"ffmpeg left behind after SIGTERM: {leftover}")

    exit_code, leftover, _, _ = mid_request("sigkill_mid_request", lambda w: w.proc.send_signal(signal.SIGKILL))
    if leftover:
        deviation("sigkill_mid_request", f"ffmpeg left behind after SIGKILL: {leftover}")

    # ------------------------------------------------- client stdout closed
    # Client dies without closing stdin: the worker's next protocol print hits EPIPE.
    # The docstring promises nothing here; we record exit code + orphan state and only
    # judge the ffmpeg invariant. A follow-up ping is sent so a worker that survived the
    # EPIPE is not left blocking forever on stdin.
    def drop_stdout_then_nudge(w: Worker) -> None:
        w.drop_stdout()
        time.sleep(1.0)
        try:
            w.send({"id": "after-epipe", "op": "ping"})
            w.close_stdin()
        except (BrokenPipeError, OSError):
            pass

    exit_code, leftover, _, w = mid_request("stdout_closed_mid_request", drop_stdout_then_nudge)
    if leftover:
        deviation("stdout_closed_mid_request", f"ffmpeg left behind: {leftover}")
    if w.traceback:
        deviation("stdout_closed_mid_request", f"uncaught traceback on stderr, exit {exit_code} (dead client is not handled)")

    # ------------------------------------------------------ hostile lines
    w = Worker(args.python)
    w.wait_ready()
    hostile = [
        ("nonjson", "this is not json\n"),
        ("array", "[1,2,3]\n"),
        ("number", "42\n"),
        ("null", "null\n"),
        ("unknown_op", json.dumps({"id": "h-op", "op": "explode"}) + "\n"),
        ("missing_video", json.dumps({"id": "h-nov", "out": str(out_dir / "x.json")}) + "\n"),
        ("unicode_id", json.dumps({"id": "\u30d4\u30c3\u30af\u30eb\U0001f3d3", "op": "ping"}, ensure_ascii=False) + "\n"),
        ("huge_line", json.dumps({"id": "h-huge", "op": "ping", "pad": "x" * (1 << 20)}) + "\n"),
        ("blank_lines", "\n\n   \n"),
        ("crlf", json.dumps({"id": "h-crlf", "op": "ping"}) + "\r\n"),
    ]
    for _, text in hostile:
        w.send_raw(text)
    burst_ids = [f"burst-{i}" for i in range(50)]
    w.send_raw("".join(json.dumps({"id": i, "op": "ping"}) + "\n" for i in burst_ids))
    w.send({"id": "h-final", "op": "ping"})
    final = w.wait_response("h-final", timeout=60)
    got = w.responses()
    pongs = {m.get("id") for m in got if m.get("event") == "pong"}
    record(
        "hostile_lines",
        worker_alive=w.proc.poll() is None,
        responses=len(got),
        pongs_for_burst=len(pongs & set(burst_ids)),
        final_pong=final,
        unicode_pong="\u30d4\u30c3\u30af\u30eb\U0001f3d3" in pongs,
        huge_pong="h-huge" in pongs,
        crlf_pong="h-crlf" in pongs,
        errors=[m for m in got if m.get("ok") is False],
        nonjson_out=[m for m in got if "_nonjson" in m],
        traceback=w.traceback,
    )
    if final is None or w.proc.poll() is not None:
        deviation("hostile_lines", "worker died or stopped answering after hostile input")
    if len(pongs & set(burst_ids)) != len(burst_ids):
        deviation("hostile_lines", f"only {len(pongs & set(burst_ids))}/50 burst pings answered")
    if any("_nonjson" in m for m in got):
        deviation("hostile_lines", "non-JSON emitted on protocol stdout")

    # ------------------------------------------------------- bad requests
    unwritable = work / "ro"
    unwritable.mkdir()
    unwritable.chmod(0o500)
    bad = {
        "nonexistent_video": detect_request("b-novid", work / "missing.mp4", out_dir),
        "video_is_directory": detect_request("b-dir", work, out_dir),
        "unwritable_out": detect_request("b-ro", clip, unwritable, stride=6),
        "stride_zero": detect_request("b-s0", clip, out_dir, stride=0),
        "stride_negative": detect_request("b-sneg", clip, out_dir, stride=-3),
        "stride_string": detect_request("b-sstr", clip, out_dir, stride="two"),
        "start_after_end": detect_request("b-rev", clip, out_dir, startMs=5000, endMs=1000),
        "nan_floor": detect_request("b-nan", clip, out_dir, floor="nan", stride=6),
        "roi_offscreen": detect_request("b-roi", clip, out_dir, roi=[1.5, 0.0, 2.0, 1.0], stride=6),
        "roi_garbage": detect_request("b-roig", clip, out_dir, roi="0,0,1"),
        "decode_size_garbage": detect_request("b-ds", clip, out_dir, decodeSize="abc"),
        "decode_size_zero": detect_request("b-ds0", clip, out_dir, decodeSize="0x0"),
        "end_ms_string": detect_request("b-end", clip, out_dir, endMs="soon"),
    }
    order = list(bad)
    rng.shuffle(order)
    bad_results = {}
    for name in order:
        req = bad[name]
        before = ffmpeg_for(clip)
        w.send(req)
        resp = w.wait_response(req["id"], timeout=300)
        alive = w.proc.poll() is None
        leftover = settle_ffmpeg(clip, timeout=3.0)
        entry = {"response": resp, "worker_alive": alive, "ffmpeg_before": before, "ffmpeg_after": leftover}
        if resp and resp.get("ok") and resp.get("out"):
            # A request that should have been refused was served: keep what it wrote.
            payload = json.loads(Path(resp["out"]).read_text(encoding="utf-8"))
            frames = payload.get("frames", [])
            entry["out_summary"] = {
                "detector.stride": payload["detector"].get("stride"),
                "detector.scoreFloor": payload["detector"].get("scoreFloor"),
                "window": payload.get("window"),
                "frameCount": len(frames),
                "tMs_head": [f["tMs"] for f in frames[:4]],
                "tMs_distinct": len({f["tMs"] for f in frames}),
            }
        bad_results[name] = entry
        if not alive:
            deviation(f"bad_requests.{name}", f"worker died (exit {w.proc.returncode}); stderr tail: {w.stderr_chunks[-3:]}")
            break
        if resp is None:
            deviation(f"bad_requests.{name}", "no response")
        if leftover:
            deviation(f"bad_requests.{name}", f"ffmpeg left behind after error response: {leftover}")
        # These requests are semantically invalid; a serve worker that answers ok:true
        # produces an artifact whose provenance block records the nonsense verbatim.
        if name in {"stride_zero", "stride_negative", "start_after_end", "nan_floor"} and resp and resp.get("ok"):
            deviation(f"bad_requests.{name}", f"accepted with ok:true -> {entry.get('out_summary')}")
    record("bad_requests", order=order, results=bad_results, traceback=w.traceback)
    unwritable.chmod(0o700)

    # -------------------------------------------------------- shutdown
    if w.proc.poll() is None:
        w.send({"id": "q", "op": "shutdown"})
        resp = w.wait_response("q", timeout=60)
        exit_code = w.wait_exit(timeout=60)
        record("shutdown", response=resp, worker_exit=exit_code, ffmpeg_after=settle_ffmpeg(clip))
        if exit_code != 0:
            deviation("shutdown", f"expected exit 0, got {exit_code}")
    w.kill()

    results["deviations"] = deviations
    Path(args.out).write_text(json.dumps(results, indent=2, default=str) + "\n", encoding="utf-8")
    print(f"\nwrote {args.out}; deviations: {len(deviations)}")
    for item in deviations:
        print(f"DEVIATION {item}")
    return 1 if deviations else 0


if __name__ == "__main__":
    raise SystemExit(main())
