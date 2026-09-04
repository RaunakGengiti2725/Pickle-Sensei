"""S3 — test_timestamp_alignment.py under other ffmpeg majors (Linux static builds).

The committed pass is on the system ffmpeg (4.4.2 here). This runs the same
harness with static 5.x / 6.x / 7.x builds placed first on PATH and, as a
second probe, decodes one window through detect_paddle.frame_iter under each
build and compares emitted frame indices/tMs (seek semantics) and pixel hashes.

Static builds are looked up in $ATTACK3_FFMPEG_DIR (default $HOME/ffmpeg-static)
as ffmpeg-<ver>-amd64-static/{ffmpeg,ffprobe}. Fetch e.g.:
  cd ~/ffmpeg-static && curl -sSL -O https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz && tar xJf ffmpeg-6.0.1-amd64-static.tar.xz
The test FAILS (not skips) when no static build with a major != system major
is present — an unavailable stage is not a pass.

This is a Linux-plane check only; it says nothing about Apple/VideoToolbox.
Run: tools/paddle-lab/.venv/bin/python -m unittest discover -s tools/paddle-lab/attack3 -p 'test_ffmpeg*.py' -v
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import _scratch  # noqa: E402

HARNESS = _scratch.PADDLE_LAB / "test_timestamp_alignment.py"
STATIC_DIR = Path(os.environ.get("ATTACK3_FFMPEG_DIR", Path.home() / "ffmpeg-static"))


def ffmpeg_version(env: dict) -> str:
    out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, env=env, check=True).stdout
    return re.search(r"ffmpeg version (\S+)", out).group(1)


def builds() -> list[tuple[str, dict]]:
    """[(label, env)] — system first, then every static build found."""
    found = [("system", dict(os.environ))]
    for d in sorted(STATIC_DIR.glob("ffmpeg-*-amd64-static")):
        if (d / "ffmpeg").exists() and (d / "ffprobe").exists():
            env = dict(os.environ)
            env["PATH"] = f"{d}:{env['PATH']}"
            found.append((d.name, env))
    return found


def window_probe(env: dict) -> dict:
    """Decode one window with frame_iter in a subprocess under `env`."""
    code = r"""
import hashlib, json, sys
sys.path.insert(0, %r)
import detect_paddle as dp
video = %r
w, h, fps, dur, st = dp.ffprobe_meta(video)
rows = []
for idx, t_ms, rgb in dp.frame_iter(video, 5300.0, 5800.0, w, h, fps, stride=1, start_time_ms=st):
    rows.append([idx, round(t_ms, 3), hashlib.sha256(rgb.tobytes()).hexdigest()])
print(json.dumps({"meta": [w, h, fps, dur, st], "rows": rows}))
""" % (str(_scratch.PADDLE_LAB), str(_scratch.DEV_CLIPS[0]))
    out = subprocess.run([_scratch.python(), "-c", code], capture_output=True, text=True, env=env, check=True)
    return json.loads(out.stdout)


class FfmpegVersions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builds = builds()
        cls.versions = {label: ffmpeg_version(env) for label, env in cls.builds}
        cls.system_major = cls.versions["system"].split(".")[0]

    def test_a_static_build_with_other_major_is_present(self):
        majors = {v.split(".")[0] for label, v in self.versions.items() if label != "system"}
        self.assertTrue(
            majors - {self.system_major},
            f"no static ffmpeg with major != {self.system_major} under {STATIC_DIR}; versions={self.versions}",
        )

    def test_timestamp_alignment_passes_under_every_build(self):
        results = {}
        for label, env in self.builds:
            proc = subprocess.run([_scratch.python(), str(HARNESS)], capture_output=True, text=True, env=env)
            results[label] = {"ffmpeg": self.versions[label], "exit": proc.returncode,
                              "stdout": proc.stdout, "stderr": proc.stderr[-2000:]}
        _scratch.save_artifact("s3-timestamp-alignment-by-ffmpeg.json", json.dumps(results, indent=1))
        for label, r in results.items():
            with self.subTest(build=label, ffmpeg=r["ffmpeg"]):
                self.assertEqual(r["exit"], 0, r)
                self.assertEqual(r["stdout"].count(": OK"), len(_scratch.DEV_CLIPS), r)

    def test_seek_semantics_identical_across_builds(self):
        probes = {label: window_probe(env) for label, env in self.builds}
        base = probes["system"]
        summary = {label: {"ffmpeg": self.versions[label], "frames": len(p["rows"]),
                           "tMs": [r[1] for r in p["rows"]],
                           "pixelsIdenticalToSystem": [r[2] for r in p["rows"]] == [r[2] for r in base["rows"]]}
                   for label, p in probes.items()}
        _scratch.save_artifact("s3-window-probe-by-ffmpeg.json", json.dumps(summary, indent=1))
        for label, p in probes.items():
            with self.subTest(build=label):
                self.assertEqual(p["meta"], base["meta"])
                self.assertEqual([(r[0], r[1]) for r in p["rows"]], [(r[0], r[1]) for r in base["rows"]])
                self.assertGreater(len(p["rows"]), 0)


if __name__ == "__main__":
    unittest.main()
