#!/usr/bin/env python3
"""Exercise tools/paddle-lab/detect_paddle.py on Linux CPU: one-shot CLI twice
(run-to-run determinism), the --serve JSON-Lines worker (ready/ping/request/
bad request/shutdown protocol), and one-shot vs serve parity on the same
window. Also probes failure states: missing video, missing --video/--out.

Linux CPU numbers are a replay proxy only; nothing here is compared against
the committed (Mac/MPS) detection artifacts for equality.

Usage: detect_paddle_probe.py --out-dir DIR [--clip PATH] [--start-ms N] [--end-ms N]
Exit 0 iff every expectation holds.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LAB = REPO / "tools/paddle-lab"
DETECT = LAB / "detect_paddle.py"


def strip_timing(payload: dict) -> dict:
    d = json.loads(json.dumps(payload))
    d.pop("timing", None)
    d.get("detector", {}).pop("device", None)
    d["video"].pop("path", None)
    return d


def run_oneshot(clip: Path, out: Path, start: int, end: int, log: Path) -> int:
    proc = subprocess.run(
        [sys.executable, str(DETECT), "--video", str(clip), "--out", str(out),
         "--start-ms", str(start), "--end-ms", str(end)],
        cwd=LAB, capture_output=True, text=True, errors="replace",
    )
    log.write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr)
    return proc.returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--clip", default=str(REPO / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"))
    ap.add_argument("--start-ms", type=int, default=1000)
    ap.add_argument("--end-ms", type=int, default=1600)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    clip = Path(args.clip).resolve()
    problems: list[str] = []
    summary: dict = {}

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""), flush=True)
        if not ok:
            problems.append(f"{name}: {detail}")

    # one-shot, twice
    payloads = []
    for i in (1, 2):
        rc = run_oneshot(clip, out / f"oneshot-run{i}.json", args.start_ms, args.end_ms, out / f"oneshot-run{i}.log")
        check(f"one-shot run{i} exit 0", rc == 0, f"exit={rc}")
        if rc == 0:
            payloads.append(json.loads((out / f"oneshot-run{i}.json").read_text()))
    if len(payloads) == 2:
        p = payloads[0]
        summary["framesProcessed"] = p["timing"]["framesProcessed"]
        summary["paddleDetections"] = sum(len(f["detections"]) for f in p["frames"])
        summary["extras"] = sum(len(f["extras"]) for f in p["frames"])
        summary["device"] = p["detector"].get("device")
        print(f"INFO frames={summary['framesProcessed']} paddleDetections={summary['paddleDetections']} extras={summary['extras']} device={summary['device']}")
        check("one-shot run1 == run2 (minus timing/path/device)", strip_timing(payloads[0]) == strip_timing(payloads[1]))
        check("one-shot produced >0 frames", summary["framesProcessed"] > 0)
        check("one-shot window echoed", p["window"] == {"startMs": float(args.start_ms), "endMs": float(args.end_ms)}
              or p["window"] == {"startMs": args.start_ms, "endMs": args.end_ms}, json.dumps(p["window"]))

    # failure states
    proc = subprocess.run([sys.executable, str(DETECT), "--video", str(out / "nope.mp4"), "--out", str(out / "nope.json")],
                          cwd=LAB, capture_output=True, text=True, errors="replace")
    (out / "missing-video.log").write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr)
    check("missing video exits non-zero", proc.returncode != 0, f"exit={proc.returncode}")
    check("missing video: no uncaught traceback", "Traceback (most recent call last)" not in proc.stderr,
          proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "")
    proc = subprocess.run([sys.executable, str(DETECT)], cwd=LAB, capture_output=True, text=True, errors="replace")
    check("no --video/--out exits 2 with usage", proc.returncode == 2 and "usage" in proc.stderr.lower(), f"exit={proc.returncode}")

    # serve mode
    serve_log = out / "serve.log"
    worker = subprocess.Popen(
        [sys.executable, str(DETECT), "--serve", "--no-warmup"],
        cwd=LAB, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(serve_log, "w"), text=True,
    )
    assert worker.stdin and worker.stdout
    responses: list[dict] = []

    def rpc(msg: dict | None) -> dict | None:
        if msg is not None:
            worker.stdin.write(json.dumps(msg) + "\n")
            worker.stdin.flush()
        line = worker.stdout.readline()
        if not line:
            return None
        r = json.loads(line)
        responses.append(r)
        return r

    ready = rpc(None)
    check("serve: ready event", bool(ready) and ready.get("event") == "ready" and ready.get("protocol") == "paddle-serve-v1", json.dumps(ready)[:200])
    pong = rpc({"id": "p", "op": "ping"})
    check("serve: ping -> pong", bool(pong) and pong.get("ok") is True and pong.get("event") == "pong", json.dumps(pong))
    bad = rpc({"id": "bad", "video": str(out / "nope.mp4"), "out": str(out / "serve-bad.json")})
    check("serve: bad request -> ok:false, worker alive", bool(bad) and bad.get("ok") is False and bad.get("id") == "bad" and worker.poll() is None,
          json.dumps(bad)[:200] if bad else "EOF")
    garbage_line = "this is not json\n"
    worker.stdin.write(garbage_line)
    worker.stdin.flush()
    garb = rpc(None)
    check("serve: non-JSON line -> ok:false, worker alive", bool(garb) and garb.get("ok") is False and worker.poll() is None,
          json.dumps(garb)[:200] if garb else "EOF")
    req = {"id": "r1", "video": str(clip), "out": str(out / "serve-r1.json"), "startMs": args.start_ms, "endMs": args.end_ms,
           "stride": 1, "floor": 0.08, "roi": None, "decodeSize": None, "legacyDecode": False}
    r1 = rpc(req)
    check("serve: request ok", bool(r1) and r1.get("ok") is True and r1.get("id") == "r1", json.dumps(r1)[:300] if r1 else "EOF")
    if r1 and r1.get("ok") and payloads:
        sp = json.loads((out / "serve-r1.json").read_text())
        check("serve: response counts match written file",
              r1.get("framesProcessed") == sp["timing"]["framesProcessed"]
              and r1.get("paddleDetections") == sum(len(f["detections"]) for f in sp["frames"]),
              json.dumps({k: r1.get(k) for k in ("framesProcessed", "paddleDetections", "extras")}))
        check("serve: modelLoadSec reported 0.0 per request", sp["timing"].get("modelLoadSec") == 0.0, str(sp["timing"].get("modelLoadSec")))
        check("serve output == one-shot output (minus timing/path/device)", strip_timing(sp) == strip_timing(payloads[0]))
    shut = rpc({"id": "q", "op": "shutdown"})
    check("serve: shutdown ack", bool(shut) and shut.get("ok") is True and shut.get("event") == "shutdown", json.dumps(shut) if shut else "EOF")
    try:
        rc = worker.wait(timeout=30)
    except subprocess.TimeoutExpired:
        worker.kill()
        rc = -9
    check("serve: worker exit 0 after shutdown", rc == 0, f"exit={rc}")
    stderr_text = serve_log.read_text()
    check("serve: stdout carried protocol only (every line JSON)", True)  # rpc() would have raised on non-JSON
    check("serve: no uncaught traceback on stderr", "Traceback (most recent call last)" not in stderr_text)

    (out / "summary.json").write_text(json.dumps({"summary": summary, "responses": responses, "problems": problems}, indent=1))
    print("\nPROBLEMS:" if problems else "\nno problems")
    for p in problems:
        print(" -", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
