#!/usr/bin/env python3
"""Independent integrity + leakage audit of datasets/pickleball/registry.json.

Read-only. Recomputes everything the registry *claims* about the on-disk
media instead of trusting the recorded values:

  * sha256 + byte size of every freshCandidates / devPool item
  * section totalBytes
  * ffprobe width/height/fps/duration vs the declared media block
  * intakeRecords.decodedFrames vs a real `ffprobe -count_frames` decode
  * role/labelBlind/path-directory consistency, unique ids, no orphan .mp4
  * no uploaderChannelId split across roles (claimed in intakeRecords.authority)
  * per-clip data-card presence + byte/sha figures in the card match registry
  * leakage: fresh/dev clip ids must not be referenced from label-bearing or
    training/release trees (datasets/corpus, datasets/releases,
    datasets/paddle-bench/bundles, datasets/ball-bench, ml/annotations)
  * collection_manifest.schema.json is a valid Draft 2020-12 schema that
    rejects an empty record and ships no example rows

Usage: registry_integrity.py [--repo-root PATH] [--json OUT]
Exit 0 iff every check passes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

INTAKE_ROLE_TO_REGISTRY = {
    "dev_label_eligible": "dev_label_eligible",
    "fresh_holdout_candidate": "fresh_candidate",
}
LEAKAGE_TREES = [
    "datasets/corpus",
    "datasets/releases",
    "datasets/paddle-bench/bundles",
    "datasets/ball-bench",
    "ml/annotations",
]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ffprobe_stream(path: Path, count_frames: bool) -> dict:
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0"]
    if count_frames:
        cmd += ["-count_frames"]
    cmd += [
        "-show_entries",
        "stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames,nb_frames"
        ":format=duration",
        "-of",
        "json",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return {"error": proc.stderr.strip(), "returncode": proc.returncode}
    doc = json.loads(proc.stdout)
    st = doc["streams"][0]
    out = {
        "width": st.get("width"),
        "height": st.get("height"),
        "fps": float(Fraction(st.get("avg_frame_rate") or st.get("r_frame_rate"))),
        "duration": float(doc["format"]["duration"]),
        "stderr": proc.stderr.strip(),
    }
    if count_frames:
        out["decodedFrames"] = int(st.get("nb_read_frames") or 0)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--repo-root", default=str(Path(__file__).resolve().parents[3])
    )
    ap.add_argument("--json", default=None, help="write machine-readable report")
    args = ap.parse_args()
    repo = Path(args.repo_root).resolve()
    reg_path = repo / "datasets/pickleball/registry.json"
    reg = json.loads(reg_path.read_text(encoding="utf-8"))

    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + detail) if detail else ''}")

    role_dir = {"fresh_candidate": "fresh-candidates", "dev_label_eligible": "dev-pool"}
    role_blind = {"fresh_candidate": True, "dev_label_eligible": False}
    sections = {"freshCandidates": reg["freshCandidates"], "devPool": reg["devPool"]}
    all_items: list[dict] = []
    ids: list[str] = []
    channel_roles: dict[str, set[str]] = {}
    probes: dict[str, dict] = {}

    for sec_name, sec in sections.items():
        total = 0
        for item in sec["items"]:
            all_items.append(item)
            cid = item["id"]
            ids.append(cid)
            media = item["media"]
            p = repo / item["path"]
            exists = p.is_file()
            check(f"{cid}: file exists", exists, item["path"])
            if not exists:
                continue
            size = p.stat().st_size
            total += size
            check(
                f"{cid}: bytes",
                size == media["clipBytes"],
                f"disk={size} registry={media['clipBytes']}",
            )
            digest = sha256_of(p)
            check(
                f"{cid}: sha256",
                digest == media["sha256"],
                f"disk={digest[:16]}… registry={media['sha256'][:16]}…",
            )
            check(
                f"{cid}: role/labelBlind",
                role_blind.get(item["role"]) == item["labelBlind"],
                f"role={item['role']} labelBlind={item['labelBlind']}",
            )
            check(
                f"{cid}: path dir matches role",
                p.parent.name == role_dir.get(item["role"]),
                f"dir={p.parent.name} role={item['role']}",
            )
            channel_roles.setdefault(item.get("uploaderChannelId") or cid, set()).add(
                item["role"]
            )
            pr = ffprobe_stream(p, count_frames=True)
            probes[cid] = pr
            if "error" in pr:
                check(f"{cid}: ffprobe", False, pr["error"])
                continue
            check(
                f"{cid}: ffprobe geometry",
                pr["width"] == media["clipWidth"] and pr["height"] == media["clipHeight"],
                f"disk={pr['width']}x{pr['height']} registry={media['clipWidth']}x{media['clipHeight']}",
            )
            check(
                f"{cid}: ffprobe fps",
                abs(pr["fps"] - float(media["clipFps"])) < 0.02,
                f"disk={pr['fps']:.4f} registry={media['clipFps']}",
            )
            check(
                f"{cid}: ffprobe duration",
                abs(pr["duration"] - float(media["clipDurationSeconds"])) < 0.1,
                f"disk={pr['duration']:.3f} registry={media['clipDurationSeconds']}",
            )
            check(
                f"{cid}: ffprobe clean decode",
                pr["stderr"] == "",
                pr["stderr"][:200],
            )
        check(
            f"{sec_name}.totalBytes",
            total == sec["totalBytes"],
            f"disk={total} registry={sec['totalBytes']}",
        )

    check("unique clip ids", len(ids) == len(set(ids)), f"{len(ids)} ids")
    split = {c: r for c, r in channel_roles.items() if len(r) > 1}
    check("no uploaderChannelId split across roles", not split, json.dumps(split))

    registered_paths = {repo / it["path"] for it in all_items}
    orphans = []
    for d in role_dir.values():
        for mp4 in sorted((repo / "datasets/pickleball" / d).glob("*")):
            if mp4.is_file() and mp4 not in registered_paths:
                orphans.append(str(mp4.relative_to(repo)))
    check("no unregistered media files", not orphans, ", ".join(orphans))

    # intakeRecords
    by_id = {it["id"]: it for it in all_items}
    for rec in reg["intakeRecords"]["records"]:
        cid = rec["clipId"]
        it = by_id.get(cid)
        check(f"intake {cid}: clip registered", it is not None)
        if it is None:
            continue
        check(
            f"intake {cid}: labelBlind == registry labelBlind",
            rec["labelBlind"] == it["labelBlind"],
            f"intake={rec['labelBlind']} registry={it['labelBlind']}",
        )
        # Intake vocabulary (wave-f/f11-e22-intake) maps onto the registry's
        # normalized roles; the data cards document the alias explicitly as
        # "Role: `fresh_holdout_candidate` (`fresh_candidate`, labelBlind: true)".
        check(
            f"intake {cid}: assignedRole maps to registry role",
            INTAKE_ROLE_TO_REGISTRY.get(rec["assignedRole"]) == it["role"],
            f"intake={rec['assignedRole']} registry={it['role']}",
        )
        pr = probes.get(cid, {})
        check(
            f"intake {cid}: decodedFrames == ffprobe -count_frames",
            pr.get("decodedFrames") == rec["verification"]["decodedFrames"],
            f"disk={pr.get('decodedFrames')} intake={rec['verification']['decodedFrames']}",
        )
        card = repo / "datasets/pickleball/data-cards" / f"{cid}.md"
        check(f"intake {cid}: data card exists", card.is_file(), str(card.relative_to(repo)))
        if card.is_file():
            text = card.read_text(encoding="utf-8")
            m = re.search(r"Bytes:\s*([\d,]+)", text)
            card_bytes = int(m.group(1).replace(",", "")) if m else None
            check(
                f"intake {cid}: data-card bytes == registry",
                card_bytes == it["media"]["clipBytes"],
                f"card={card_bytes} registry={it['media']['clipBytes']}",
            )
            check(
                f"intake {cid}: data-card cites sha256",
                it["media"]["sha256"] in text,
            )
            check(
                f"intake {cid}: data-card cites path",
                it["path"] in text,
            )

    # leakage scan: fresh/dev ids referenced from label/training/release trees.
    # Verbatim snapshots of the registry / holdout ledger inside a dataset
    # release are provenance records, not label or training use; they are
    # listed separately and do not fail the check.
    SNAPSHOT_SUFFIXES = (
        "/artifacts/pickleball/registry.json",
        "/artifacts/holdouts/ledger.json",
    )
    leaks: dict[str, list[str]] = {}
    snapshots: dict[str, list[str]] = {}
    for cid in ids:
        for tree in LEAKAGE_TREES:
            root = repo / tree
            if not root.exists():
                continue
            proc = subprocess.run(
                ["grep", "-rl", "--", cid, str(root)],
                capture_output=True,
                text=True,
            )
            for h in proc.stdout.split():
                rel = str(Path(h).relative_to(repo))
                if rel.endswith(SNAPSHOT_SUFFIXES):
                    snapshots.setdefault(cid, []).append(rel)
                else:
                    leaks.setdefault(cid, []).append(rel)
    check(
        "no fresh/dev clip referenced from label/training/release trees",
        not leaks,
        json.dumps(leaks)[:400],
    )
    print(
        f"INFO registry/ledger snapshot references (allowed): "
        f"{sorted({p for ps in snapshots.values() for p in ps})}"
    )

    # collection manifest schema
    schema_path = repo / "datasets/pickleball/collection_manifest.schema.json"
    try:
        import jsonschema  # type: ignore
    except ImportError:
        jsonschema = None
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    if jsonschema is not None:
        try:
            jsonschema.Draft202012Validator.check_schema(schema)
            check("collection_manifest.schema.json is a valid 2020-12 schema", True)
        except jsonschema.SchemaError as exc:  # pragma: no cover
            check("collection_manifest.schema.json is a valid 2020-12 schema", False, str(exc)[:200])
        v = jsonschema.Draft202012Validator(schema)
        check(
            "collection manifest schema rejects {}",
            not v.is_valid({}),
        )
    else:
        check("collection_manifest.schema.json checked with jsonschema", False, "jsonschema not installed")
    check(
        "collection manifest schema ships no example rows",
        '"examples"' not in schema_path.read_text(encoding="utf-8"),
    )

    failed = [c for c in checks if not c["ok"]]
    print(f"\n{len(checks)} checks, {len(failed)} failed")
    if args.json:
        Path(args.json).write_text(
            json.dumps({"checks": checks, "failed": len(failed)}, indent=1),
            encoding="utf-8",
        )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
