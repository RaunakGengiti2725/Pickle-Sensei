#!/usr/bin/env python3
"""H16 stage-2 aggregator (LINUX-CPU, label-free).

Reads the per-clip swing-lab reports produced over the fresh pools (MediaPipe
pose on Linux — an operational probe, NOT Apple Vision canonical accuracy) and
produces per-source/per-session counts of coverage, success, abstention,
silent failure, and technical failure. Creates no labels.

Usage: python3 h16-aggregate.py <extract_root> <out_json>
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
registry = json.loads((REPO / "datasets/pickleball/registry.json").read_text())
items = registry["freshCandidates"]["items"] + registry["devPool"]["items"]

extract_root = Path(sys.argv[1])
out_path = Path(sys.argv[2])

rows = []
for it in items:
    session = it.get("uploaderChannelId") or it.get("uploader") or "unknown"
    rpt_path = extract_root / it["id"] / "report.json"
    row = {
        "id": it["id"],
        "role": it["role"],
        "labelBlind": it["labelBlind"],
        "session": session,
        "uploader": it.get("uploader"),
    }
    if not rpt_path.exists():
        row["outcome"] = "technical_failure"
        row["detail"] = "no report.json produced"
        rows.append(row)
        continue
    r = json.loads(rpt_path.read_text())
    kind = (r.get("outcome") or {}).get("kind")
    detail = (r.get("outcome") or {}).get("detail")
    quality = r.get("quality") or {}
    paddle = (r.get("paddle") or {}).get("status")
    ball = (r.get("ballStage") or {}).get("status")
    span = r.get("detectSpan") or {}
    silent_flags = []
    if span.get("spanMs") is not None and span["spanMs"] <= 0:
        silent_flags.append("inverted_or_empty_detect_span")
    if kind in ("scored", "analyzed") and not quality.get("analyzable"):
        silent_flags.append("scored_despite_failed_capture_gate")
    if kind in ("scored", "analyzed"):
        outcome = "success"
    elif kind in ("not_analyzable", "abstained", "no_stroke", "rejected"):
        outcome = "abstention"
    else:
        outcome = f"other:{kind}"
    if silent_flags:
        row["silentFailureFlags"] = silent_flags
    row.update(
        {
            "outcome": outcome,
            "outcomeKind": kind,
            "detail": detail,
            "captureAnalyzable": quality.get("analyzable"),
            "captureReasons": quality.get("reasons"),
            "paddleStatus": paddle,
            "ballStatus": ball,
            "detectSpanMs": span.get("spanMs"),
            "contactStatus": (r.get("contact") or {}).get("status"),
            "contactConfidence": (r.get("contact") or {}).get("confidence"),
        }
    )
    rows.append(row)

per_session = defaultdict(
    lambda: {"clips": 0, "success": 0, "abstention": 0, "silent_failure": 0, "technical_failure": 0}
)
for row in rows:
    bucket = per_session[row["session"]]
    bucket["clips"] += 1
    if row["outcome"] == "success":
        bucket["success"] += 1
    elif row["outcome"] == "abstention":
        bucket["abstention"] += 1
    elif row["outcome"] == "technical_failure":
        bucket["technical_failure"] += 1
    if row.get("silentFailureFlags"):
        bucket["silent_failure"] += 1

out = {
    "platform": "LINUX-CPU (MediaPipe pose probe — NOT Apple Vision canonical)",
    "labelsCreated": 0,
    "clipCount": len(rows),
    "perSession": dict(sorted(per_session.items())),
    "rows": rows,
}
out_path.write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out["perSession"], indent=1))
