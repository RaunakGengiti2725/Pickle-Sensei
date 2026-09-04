"""S3 + S7 — detect_paddle.py on degenerate media and contradictory arguments.

Runs the real CLI through detect_paddle_nomodel_driver.py (only `load_model`
is stubbed; see that file). One-shot mode and serve mode are both exercised
because they have different error contracts: one-shot should fail with a
readable message (not a Python traceback) and serve mode must answer every
request with a JSON line and keep serving.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from attack_common import (
    WM_VOLLEY_02, ffmpeg_available, make_audio_only_mp4, make_empty_mp4,
    make_truncated_mp4, py, run, torch_importable,
)
import sys

DRIVER = Path(__file__).resolve().parent / "detect_paddle_nomodel_driver.py"


@unittest.skipUnless(ffmpeg_available(), "ffmpeg/ffprobe required")
@unittest.skipUnless(torch_importable(), "torch required to import detect_paddle")
class DetectPaddleMediaArgsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="detect-paddle-attack-"))
        self.out = self.tmp / "out.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- S3: ffprobe_meta on media without a usable video stream -------------

    def test_oneshot_zero_byte_video_gives_clean_error_not_traceback(self) -> None:
        """FINDING on 4d812e1a: ffprobe exits 1 on a 0-byte file and
        `subprocess.run(check=True)` raises CalledProcessError straight out of
        main() -> traceback, exit 1, no 'error' event, no artifact."""
        empty = make_empty_mp4(self.tmp)
        r = py(DRIVER, "--video", str(empty), "--out", str(self.out), timeout=60)
        r.record("s3_detect_oneshot_zero_byte")
        self.assertFalse(r.timed_out)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("Traceback", r.stderr, r)
        self.assertFalse(self.out.exists())

    def test_oneshot_audio_only_mp4_gives_clean_error_not_indexerror(self) -> None:
        """FINDING on 4d812e1a: `json.loads(out.stdout)["streams"][0]` on an
        audio-only container -> IndexError: list index out of range (traceback)."""
        audio = make_audio_only_mp4(self.tmp)
        r = py(DRIVER, "--video", str(audio), "--out", str(self.out), timeout=60)
        r.record("s3_detect_oneshot_audio_only")
        self.assertFalse(r.timed_out)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("IndexError", r.stderr, r)
        self.assertNotIn("Traceback", r.stderr, r)

    def test_oneshot_truncated_mp4(self) -> None:
        trunc = make_truncated_mp4(self.tmp, WM_VOLLEY_02, keep_bytes=4096)
        r = py(DRIVER, "--video", str(trunc), "--out", str(self.out), timeout=60)
        r.record("s3_detect_oneshot_truncated")
        self.assertFalse(r.timed_out)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("Traceback", r.stderr, r)

    def test_serve_mode_answers_bad_media_with_json_and_keeps_serving(self) -> None:
        """Serve contract (module docstring): one bad request must not kill the
        worker. Expect ok:false JSON for the 0-byte and audio-only requests, then
        a pong, then a clean shutdown."""
        empty = make_empty_mp4(self.tmp)
        audio = make_audio_only_mp4(self.tmp)
        reqs = [
            {"id": "e", "video": str(empty), "out": str(self.tmp / "e.json")},
            {"id": "a", "video": str(audio), "out": str(self.tmp / "a.json")},
            {"id": "missing", "video": str(self.tmp / "nope.mp4"), "out": str(self.tmp / "m.json")},
            {"id": "p", "op": "ping"},
            {"id": "s", "op": "shutdown"},
        ]
        stdin = "".join(json.dumps(q) + "\n" for q in reqs)
        r = run([sys.executable, str(DRIVER), "--serve", "--no-warmup"], stdin=stdin, timeout=60)
        r.record("s3_detect_serve_bad_media")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 0, r)
        lines = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual(lines[0]["event"], "ready")
        by_id = {l.get("id"): l for l in lines[1:]}
        self.assertEqual(set(by_id), {"e", "a", "missing", "p", "s"}, lines)
        for rid in ("e", "a", "missing"):
            self.assertIs(by_id[rid]["ok"], False, by_id[rid])
            self.assertIn("error", by_id[rid])
        self.assertEqual(by_id["p"]["event"], "pong")
        self.assertEqual(by_id["s"]["event"], "shutdown")
        # Record the exact error strings: the audio-only one is a bare
        # 'IndexError: list index out of range' (P3, nothing tells the caller
        # the stream has no video) — asserted as a note, not a hard fail.
        r.record("s3_detect_serve_bad_media", errors={k: by_id[k].get("error") for k in ("e", "a", "missing")})

    def test_serve_mode_window_past_clip_end_is_ok_with_zero_frames(self) -> None:
        req = {"id": "past", "video": str(WM_VOLLEY_02), "out": str(self.out),
               "startMs": 59900, "endMs": 70000}
        stdin = json.dumps(req) + "\n" + json.dumps({"id": "s", "op": "shutdown"}) + "\n"
        r = run([sys.executable, str(DRIVER), "--serve", "--no-warmup"], stdin=stdin, timeout=60)
        r.record("s5_detect_serve_past_end")
        self.assertEqual(r.returncode, 0, r)
        lines = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        past = next(l for l in lines if l.get("id") == "past")
        self.assertIs(past["ok"], True, past)
        self.assertEqual(past["framesProcessed"], 0, past)
        self.assertTrue(self.out.exists())

    def test_serve_mode_malformed_request_lines(self) -> None:
        """Garbage JSON, a non-object, unknown op, and a missing 'video' key must
        each produce ok:false and never kill the loop."""
        stdin = "\n".join([
            "this is not json",
            "[1,2,3]",
            json.dumps({"id": "u", "op": "explode"}),
            json.dumps({"id": "nv", "out": str(self.out)}),
            json.dumps({"id": "s", "op": "shutdown"}),
        ]) + "\n"
        r = run([sys.executable, str(DRIVER), "--serve", "--no-warmup"], stdin=stdin, timeout=60)
        r.record("s3_detect_serve_malformed")
        self.assertEqual(r.returncode, 0, r)
        lines = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual(lines[-1].get("event"), "shutdown", lines)
        # ready + 4 error responses + shutdown
        self.assertEqual(len(lines), 6, lines)
        self.assertTrue(all(l["ok"] is False for l in lines[1:-1]), lines)

    # ---- S7: argparse rejects --decode-size + --legacy-decode ---------------

    def test_decode_size_640_with_legacy_decode_is_rejected_by_argparse(self) -> None:
        """The exact assigned command. FINDING on 4d812e1a: `parse_decode_size`
        runs OUTSIDE argparse (not a `type=` callable) and unpacks `"640".split("x")`
        -> ValueError traceback, exit 1 — before the combination guard is reached.
        A CLI rejection must be argparse's exit 2 + usage line."""
        r = py(DRIVER, "--video", str(WM_VOLLEY_02), "--out", str(self.out),
               "--decode-size", "640", "--legacy-decode", timeout=60)
        r.record("s7_decode_size_640_legacy")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 2, r)
        self.assertIn("usage:", r.stderr)
        self.assertNotIn("Traceback", r.stderr, r)

    def test_decode_size_640x640_with_legacy_decode_is_rejected_by_argparse(self) -> None:
        r = py(DRIVER, "--video", str(WM_VOLLEY_02), "--out", str(self.out),
               "--decode-size", "640x640", "--legacy-decode", timeout=60)
        r.record("s7_decode_size_640x640_legacy")
        self.assertEqual(r.returncode, 2, r)
        self.assertIn("--decode-size cannot be combined with --legacy-decode", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertFalse(self.out.exists())

    def test_decode_size_below_floor_and_garbage_are_argparse_errors(self) -> None:
        """`assert w >= 32` and `int('abc')` are raw AssertionError/ValueError
        tracebacks on 4d812e1a (same root cause as the 640 case)."""
        for value in ("16x16", "abcxdef", "640x", "0x0", "-640x640"):
            with self.subTest(value=value):
                r = py(DRIVER, "--video", str(WM_VOLLEY_02), "--out", str(self.out),
                       "--decode-size", value, timeout=60)
                r.record(f"s7_decode_size_{value.replace('-', 'neg')}")
                self.assertEqual(r.returncode, 2, r)
                self.assertNotIn("Traceback", r.stderr, r)

    def test_serve_mode_legacy_plus_decode_size_is_a_json_error(self) -> None:
        req = {"id": "x", "video": str(WM_VOLLEY_02), "out": str(self.out),
               "endMs": 200, "legacyDecode": True, "decodeSize": "640x640"}
        stdin = json.dumps(req) + "\n" + json.dumps({"id": "s", "op": "shutdown"}) + "\n"
        r = run([sys.executable, str(DRIVER), "--serve", "--no-warmup"], stdin=stdin, timeout=60)
        r.record("s7_serve_legacy_plus_decode_size")
        self.assertEqual(r.returncode, 0, r)
        lines = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        x = next(l for l in lines if l.get("id") == "x")
        self.assertIs(x["ok"], False, x)
        self.assertFalse(self.out.exists(), "no artifact may be written for a rejected request")

    def test_crops_mode_silently_ignores_decode_flags(self) -> None:
        """`--crops` returns before the decode-size/legacy guard, so the very
        combination the guard rejects is accepted silently in crops mode."""
        crops = self.tmp / "crops.json"
        crops.write_text(json.dumps({"crops": []}))
        r = py(DRIVER, "--video", str(WM_VOLLEY_02), "--out", str(self.out),
               "--crops", str(crops), "--decode-size", "640x640", "--legacy-decode", timeout=60)
        r.record("s7_crops_ignores_decode_flags")
        self.assertEqual(r.returncode, 2, f"contradictory flags accepted in --crops mode: {r}")


if __name__ == "__main__":
    unittest.main()
