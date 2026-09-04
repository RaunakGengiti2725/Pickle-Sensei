"""S5 + S6 — detect_paddle.py --serve protocol attacks (real worker, CPU).

S6: start `--serve --no-warmup`, send {"type":"detect"} (no video), then a
    ping; expect an ok=false error object and a pong from a still-alive worker.
    Extra: non-JSON line, unknown op, missing out, unwritable out, roi 1.0,
    unicode/numeric ids, 1 MiB junk line, video path that does not exist.
S5: fire 50 detect requests without awaiting replies; check reply id order ==
    send order, every reply present, and worker RSS growth (/proc VmRSS).

Needs tools/paddle-lab/.venv. Run with that interpreter:
  tools/paddle-lab/.venv/bin/python -m unittest discover -s tools/paddle-lab/attack3 -p 'test_serve*.py' -v
Seeds: S5 window jitter uses random.Random(20260904).
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from queue import Empty, Queue

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _scratch  # noqa: E402

SCRIPT = _scratch.PADDLE_LAB / "detect_paddle.py"
CLIP = _scratch.DEV_CLIPS[0]
SEED = 20260904


def rss_kb(pid: int) -> int:
    with open(f"/proc/{pid}/status") as fh:
        for line in fh:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    raise RuntimeError("no VmRSS")


class Worker:
    def __init__(self, extra_args: list[str] | None = None):
        self.proc = subprocess.Popen(
            [_scratch.python(), str(SCRIPT), "--serve", "--no-warmup", *(extra_args or [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.lines: Queue[str] = Queue()
        self.raw: list[str] = []
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        self._stderr = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr.start()
        self.stderr_lines: list[str] = []

    def _pump(self):
        for line in self.proc.stdout:
            self.raw.append(line)
            self.lines.put(line)

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self.stderr_lines.append(line)

    def send_raw(self, text: str):
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    def send(self, obj: dict):
        self.send_raw(json.dumps(obj) + "\n")

    def recv(self, timeout: float = 120.0) -> dict:
        line = self.lines.get(timeout=timeout)
        return json.loads(line)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def close(self):
        if self.alive():
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()


@unittest.skipUnless(_scratch.VENV_PYTHON.exists(), "tools/paddle-lab/.venv missing")
class ServeMalformed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _scratch.scratch_root("serve-malformed")
        cls.w = Worker()
        ready = cls.w.recv(timeout=300)
        assert ready["event"] == "ready", ready
        assert ready["protocol"] == "paddle-serve-v1"
        assert ready["warmupSec"] == 0.0, ready  # --no-warmup honoured
        cls.ready = ready

    @classmethod
    def tearDownClass(cls):
        cls.w.close()
        _scratch.save_artifact("s6-serve-transcript.jsonl", "".join(cls.w.raw))
        _scratch.save_artifact("s6-serve-stderr.txt", "".join(cls.w.stderr_lines))

    def _roundtrip(self, obj_or_text, timeout=120.0) -> dict:
        if isinstance(obj_or_text, str):
            self.w.send_raw(obj_or_text)
        else:
            self.w.send(obj_or_text)
        return self.w.recv(timeout=timeout)

    def test_01_detect_without_video_then_ping(self):
        resp = self._roundtrip({"type": "detect"})
        self.assertEqual(resp["ok"], False)
        self.assertIsNone(resp["id"])
        self.assertEqual(resp["error"], "KeyError: 'video'")
        pong = self._roundtrip({"id": "p1", "op": "ping"})
        self.assertEqual(pong, {"id": "p1", "ok": True, "event": "pong"})
        self.assertTrue(self.w.alive())

    def test_02_non_json_line(self):
        resp = self._roundtrip("this is not json\n")
        self.assertFalse(resp["ok"])
        self.assertIn("JSONDecodeError", resp["error"])
        self.assertTrue(self.w.alive())

    def test_03_json_non_object(self):
        """A JSON array/number/string is valid JSON but not a request object."""
        for payload in ("[1,2,3]\n", "42\n", '"detect"\n', "null\n"):
            resp = self._roundtrip(payload)
            self.assertFalse(resp["ok"], payload)
            self.assertIn("AttributeError", resp["error"], payload)
        self.assertTrue(self.w.alive())

    def test_04_unknown_op(self):
        resp = self._roundtrip({"id": "u", "op": "explode"})
        self.assertEqual(resp, {"id": "u", "ok": False, "error": "ValueError: unknown op: explode"})

    def test_05_missing_out_errors_before_decode(self):
        resp = self._roundtrip({"id": "no-out", "op": "detect", "video": str(CLIP)})
        self.assertEqual(resp["error"], "KeyError: 'out'")

    def test_06_nonexistent_video(self):
        resp = self._roundtrip({"id": "nv", "op": "detect", "video": "/nonexistent/clip.mp4",
                                "out": str(self.root / "nv.json")})
        self.assertFalse(resp["ok"])
        self.assertIn("CalledProcessError", resp["error"])
        self.assertIn("ffprobe", resp["error"])
        self.assertTrue(self.w.alive())

    def test_07_unwritable_out_wastes_inference_then_errors(self):
        """`out` under a missing dir: the whole window is decoded + inferred and
        only then the write raises (detect_paddle.py:398). Error object still
        returned, worker alive."""
        started = time.perf_counter()
        resp = self._roundtrip({"id": "uw", "op": "detect", "video": str(CLIP), "startMs": 5300,
                                "endMs": 5400, "out": str(self.root / "does-not-exist" / "x.json")})
        wall = time.perf_counter() - started
        self.assertFalse(resp["ok"])
        self.assertIn("FileNotFoundError", resp["error"])
        self.assertGreater(wall, 0.2)  # inference happened before the failure
        self.assertTrue(self.w.alive())

    def test_08_roi_edge_one_returns_error_not_crash(self):
        resp = self._roundtrip({"id": "roi1", "op": "detect", "video": str(CLIP), "startMs": 5300,
                                "endMs": 5400, "roi": "1.0,0.5,1.0,1.0", "out": str(self.root / "roi1.json")})
        self.assertFalse(resp["ok"])
        self.assertIn("RuntimeError", resp["error"])
        self.assertTrue(self.w.alive())
        resp = self._roundtrip({"id": "roi2", "op": "detect", "video": str(CLIP), "startMs": 5300,
                                "endMs": 5400, "roi": [1.2, 0.5, 0.1, 0.1], "out": str(self.root / "roi2.json")})
        self.assertEqual(resp["error"], "AssertionError: roi wants x0,y0,x1,y1 in [0,1]")

    def test_09_ids_are_echoed_verbatim_any_type(self):
        """Numeric / unicode / object ids are echoed as-is. NB the TS client drops
        replies whose id is not a string (paddleWorker.ts:133) — protocol
        mismatch only matters for non-TS clients."""
        for rid in (7, "héllo-🏓", {"nested": True}, None, ""):
            resp = self._roundtrip({"id": rid, "op": "ping"})
            self.assertEqual(resp["id"], rid)
            self.assertEqual(resp["event"], "pong")

    def test_10_one_mib_junk_line(self):
        junk = "x" * (1 << 20) + "\n"
        resp = self._roundtrip(junk)
        self.assertFalse(resp["ok"])
        self.assertIn("JSONDecodeError", resp["error"])
        self.assertTrue(self.w.alive())

    def test_11_blank_lines_ignored(self):
        self.w.send_raw("\n\n   \n")
        pong = self._roundtrip({"id": "after-blank", "op": "ping"})
        self.assertEqual(pong["event"], "pong")
        with self.assertRaises(Empty):
            self.w.lines.get(timeout=0.5)

    def test_12_bad_numeric_fields(self):
        resp = self._roundtrip({"id": "bad-start", "op": "detect", "video": str(CLIP),
                                "startMs": "soon", "out": str(self.root / "b.json")})
        self.assertIn("ValueError", resp["error"])
        self.assertTrue(self.w.alive())

    def test_12b_stride_zero_and_negative_accepted_with_wrong_timestamps(self):
        """BROKEN: stride <= 0 is not validated (detect_paddle.py:168 only
        special-cases stride > 1; :192 multiplies the piped index by stride).
        stride 0 -> every frame is stamped with the FIRST frame's tMs;
        stride -2 -> tMs runs backwards. ok=true, artifact written."""
        out0 = self.root / "stride0.json"
        resp = self._roundtrip({"id": "stride0", "op": "detect", "video": str(CLIP), "startMs": 5300,
                                "endMs": 5450, "stride": 0, "out": str(out0)})
        self.assertTrue(resp["ok"], resp)
        frames0 = json.loads(out0.read_text())["frames"]
        self.assertEqual(len(frames0), 4)
        self.assertEqual(len({f["tMs"] for f in frames0}), 1, [f["tMs"] for f in frames0])
        outn = self.root / "stride-2.json"
        resp = self._roundtrip({"id": "stride-2", "op": "detect", "video": str(CLIP), "startMs": 5300,
                                "endMs": 5450, "stride": -2, "out": str(outn)})
        self.assertTrue(resp["ok"], resp)
        t = [f["tMs"] for f in json.loads(outn.read_text())["frames"]]
        self.assertEqual(t, sorted(t, reverse=True))
        self.assertLess(t[-1], 5300.0)
        _scratch.save_artifact("s6-stride-nonpositive.json", json.dumps(
            {"stride0_tMs": [f["tMs"] for f in frames0], "strideNeg2_tMs": t}, indent=1))
        # legacy path with stride 0 -> ZeroDivisionError, but still an error object
        resp = self._roundtrip({"id": "stride0L", "op": "detect", "video": str(CLIP), "startMs": 5300,
                                "endMs": 5450, "stride": 0, "legacyDecode": True, "out": str(self.root / "l.json")})
        self.assertEqual(resp["error"], "ZeroDivisionError: integer modulo by zero")
        self.assertTrue(self.w.alive())

    def test_13_valid_detect_still_works_after_all_that(self):
        out = self.root / "ok.json"
        resp = self._roundtrip({"id": "ok", "op": "detect", "video": str(CLIP), "startMs": 5300,
                                "endMs": 5400, "out": str(out)})
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["framesProcessed"], 2)
        self.assertTrue(out.exists())

    def test_14_shutdown_op_exits_zero(self):
        resp = self._roundtrip({"id": "bye", "op": "shutdown"})
        self.assertEqual(resp["event"], "shutdown")
        self.assertEqual(self.w.proc.wait(timeout=30), 0)


@unittest.skipUnless(_scratch.VENV_PYTHON.exists(), "tools/paddle-lab/.venv missing")
class ServeFlood(unittest.TestCase):
    N = 50

    def test_50_unawaited_requests_ordered_and_rss(self):
        root = _scratch.scratch_root("serve-flood")
        rng = random.Random(SEED)
        w = Worker()
        try:
            ready = w.recv(timeout=300)
            self.assertEqual(ready["event"], "ready")
            pid = w.proc.pid
            rss_ready = rss_kb(pid)
            # --no-warmup: the first inference allocates torch workspaces (~+290 MB
            # observed). Prime once so the flood measures steady-state drift only.
            w.send({"id": "prime", "op": "detect", "video": str(CLIP), "startMs": 5300,
                    "endMs": 5400, "out": str(root / "prime.json")})
            self.assertTrue(w.recv(timeout=300)["ok"])
            rss_primed = rss_kb(pid)
            sent_ids = []
            for i in range(1, self.N + 1):
                rid = f"r{i}"
                sent_ids.append(rid)
                start = 5300 + rng.choice([0, 33, 67, 100])
                req = {"id": rid, "op": "detect", "video": str(CLIP), "startMs": start,
                       "endMs": start + 100, "out": str(root / f"{rid}.json")}
                if i % 10 == 0:  # interleave a malformed request; it must also reply, in order
                    req = {"id": rid, "op": "detect"}
                w.send(req)
            # nothing awaited so far; now drain
            got_ids, samples, per_request = [], [("ready", rss_ready), ("primed", rss_primed)], []
            deadline = time.time() + 900
            while len(got_ids) < self.N and time.time() < deadline:
                resp = w.recv(timeout=300)
                got_ids.append(resp["id"])
                per_request.append(rss_kb(pid))
                if len(got_ids) % 10 == 0:
                    samples.append((len(got_ids), per_request[-1]))
                if resp["id"].endswith("0"):
                    self.assertEqual(resp["error"], "KeyError: 'video'")
                else:
                    self.assertTrue(resp["ok"], resp)
                    self.assertIn(resp["framesProcessed"], (2, 3), resp)  # 100 ms at 25 fps
            self.assertEqual(got_ids, sent_ids)
            self.assertTrue(w.alive())
            pong = None
            w.send({"id": "final", "op": "ping"})
            pong = w.recv()
            self.assertEqual(pong["event"], "pong")
            self.assertEqual(sum(1 for f in root.glob("r*.json")), self.N - self.N // 10)
            growth = samples[-1][1] - rss_primed
            first_inference_jump = rss_primed - rss_ready
            # least-squares slope of RSS over the 50 replies: the torch allocator makes
            # any two point samples differ by tens of MB, so a leak is a trend, not a delta
            xs = range(1, len(per_request) + 1)
            mx = sum(xs) / len(per_request)
            my = sum(per_request) / len(per_request)
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, per_request)) / sum((x - mx) ** 2 for x in xs)
            report = {
                "seed": SEED, "n": self.N, "orderPreserved": got_ids == sent_ids,
                "rssKbSamples": samples, "firstInferenceJumpKb": first_inference_jump,
                "rssGrowthKbOver50": growth,
                "rssGrowthPctOver50": round(100 * growth / rss_primed, 2),
                "rssMinKbDuringFlood": min(per_request), "rssMaxKbDuringFlood": max(per_request),
                "rssSlopeKbPerRequest": round(slope, 1),
                "rssSlopeExtrapolatedPctOver50": round(100 * slope * self.N / rss_primed, 2),
            }
            _scratch.save_artifact("s5-flood-report.json", json.dumps(report, indent=1))
            # steady state: 50 requests must not grow the primed worker by more than 10%
            self.assertLess(growth, 0.10 * rss_primed, report)
            # and the fitted per-request trend over the flood must stay under 10%/50 requests
            self.assertLess(slope * self.N, 0.10 * rss_primed, report)
        finally:
            w.close()
            _scratch.save_artifact("s5-flood-stderr.txt", "".join(w.stderr_lines))


if __name__ == "__main__":
    unittest.main()
