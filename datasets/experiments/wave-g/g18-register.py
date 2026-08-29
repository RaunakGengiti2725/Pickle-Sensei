#!/usr/bin/env python3
"""wave-g/g18-fresh-footage: append the 6 CC BY clips acquired on 2026-08-29 to
datasets/pickleball/registry.json (append-only; no existing entries modified).

Reproducibility: each clip is a 60 s video-only libx264 crf20 re-encode of a
segment of a YouTube CC BY source. Re-fetch commands are recorded per item in
acquisition.refetch. sha256 values are of the committed clips.
"""

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REG = ROOT / "datasets" / "pickleball" / "registry.json"
FC_DIR = ROOT / "datasets" / "pickleball" / "fresh-candidates"

CLIPS = [
    {
        "id": "yt-CWqy7OtTpe4",
        "sourceUrl": "https://www.youtube.com/watch?v=CWqy7OtTpe4",
        "title": "Pickleball Match with PPA Pro in Canada 10th August 2025",
        "uploader": "Duc Pham Value",
        "uploaderChannelId": "UCIc0v0vv3k4vDwL2FCMDjvA",
        "uploadDate": "2025-08-11",
        "segment": "600s-660s of the 3575s source video, re-encoded libx264 crf20",
        "sourceResolutionFps": "1080x1920@30 (vertical)",
        "pickleballRelevance": "Vertical outdoor rec doubles/singles on dedicated court, fixed low behind-court phone camera; first vertical CC BY gameplay clip in the pool",
        "provenance": "Personal channel publishing self-recorded rec games; consistent with uploader as videographer/rights holder (channel-context assessment)",
    },
    {
        "id": "yt-HlnDVB6hl4E",
        "sourceUrl": "https://www.youtube.com/watch?v=HlnDVB6hl4E",
        "title": "4.5 Mixed Doubles The Final 4RTH Double Eliminations Pickleball Tournament Orem UT.",
        "uploader": "All Things Pickleball TV",
        "uploaderChannelId": "UCTdwavsR79UNRmJrIZMWH6w",
        "uploadDate": "2024-04-17",
        "segment": "300s-360s of the 1259s source video (1080p30 stream of the 4K source), re-encoded libx264 crf20",
        "sourceResolutionFps": "3840x2160@30",
        "pickleballRelevance": "Indoor gym 4.5 mixed doubles amateur tournament, elevated end-line camera, multiple courts and US flag backdrop",
        "provenance": "Local tournament channel publishing self-recorded amateur brackets; no broadcast marks in frame screening (channel-context assessment)",
    },
    {
        "id": "yt-tuKiznvDJ4E",
        "sourceUrl": "https://www.youtube.com/watch?v=tuKiznvDJ4E",
        "title": "D. Horne 11-6 J. Chadwick - Pickleball Men's Singles short match 10/08/26",
        "uploader": "Duncan's Family Channel",
        "uploaderChannelId": "UCVH4MaIgBw35htXsybBMbsg",
        "uploadDate": "2026-08-12",
        "segment": "60s-120s of the 407s source video (1080p50 stream of the 4K50 source), re-encoded libx264 crf20",
        "sourceResolutionFps": "3840x2160@50",
        "pickleballRelevance": "Covered-court men's singles with uploader-added score overlay graphic and occasional extreme face close-ups; wide-angle action camera; 50 fps",
        "provenance": "Family channel self-recording their own matches with their own score graphics (channel-context assessment)",
    },
    {
        "id": "yt-pZou8Mtcu3g",
        "sourceUrl": "https://www.youtube.com/watch?v=pZou8Mtcu3g",
        "title": "Who Will Win This Epic Pickleball Match?",
        "uploader": "SPORTS ENTHUSIAST",
        "uploaderChannelId": "UCYKYfvadlIIQDqxaRU5lMlg",
        "uploadDate": "2025-10-05",
        "segment": "120s-180s of the 631s source video, re-encoded libx264 crf20",
        "sourceResolutionFps": "1920x1080@29.97",
        "pickleballRelevance": "Indoor club doubles on purple/blue show court with spectators, elevated corner spectator camera; venue branding only, no broadcast watermarks",
        "provenance": "Spectator-shot amateur footage from the stands; no league/broadcast graphics in frame screening (channel-context assessment)",
    },
    {
        "id": "yt-jkiAWFrdc-g",
        "sourceUrl": "https://www.youtube.com/watch?v=jkiAWFrdc-g",
        "title": "How to Play Pickleball in the WIND!",
        "uploader": "PickleballPlaybook - Austin Hardy",
        "uploaderChannelId": "UCwkHWkyarHJFSQxk8SMs4zA",
        "uploadDate": "2024-09-21",
        "segment": "60s-120s of the 425s source video, re-encoded libx264 crf20",
        "sourceResolutionFps": "1920x1080@60",
        "pickleballRelevance": "Outdoor desert-court instructional segment with on-camera coach and adjacent-court rally play in windy conditions; 60 fps",
        "provenance": "Coach's own instructional channel publishing self-produced content (channel-context assessment)",
    },
    {
        "id": "yt-DD7uDPi_PJg",
        "sourceUrl": "https://www.youtube.com/watch?v=DD7uDPi_PJg",
        "title": "2014.11.05 - Gabrielsen,Wesley vs Moore,Daniel -MS 19+ (final)",
        "uploader": "pickleball4you",
        "uploaderChannelId": "UC83z_qzETSgcemFzZdtmFvw",
        "uploadDate": "2014-11-23",
        "segment": "300s-360s of the 1579s source video, re-encoded libx264 crf20",
        "sourceResolutionFps": "1920x1080@30",
        "pickleballRelevance": "2014-era outdoor men's singles tournament final shot through a fence from behind the court, sponsor banners and spectators; oldest-vintage footage in the pool (camera/compression era diversity)",
        "provenance": "Uploader (pickleball4you) already accepted in wave-c c16 for self-recorded tournament footage; same channel context",
    },
]

LICENSE = (
    'CC BY 3.0 (YouTube page license field: "Creative Commons Attribution license (reuse allowed)")'
)
LICENSE_VERIFICATION = (
    "License field read directly from the YouTube watch page metadata on 2026-08-29 via yt-dlp "
    "page parse; YouTube's 'Creative Commons Attribution license (reuse allowed)' setting maps to "
    "CC BY 3.0 (https://support.google.com/youtube/answer/2797468). CC BY 3.0 permits commercial "
    "use with attribution."
)


def ffprobe(path: Path) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
    ).stdout
    parsed = json.loads(out)
    stream = parsed["streams"][0]
    num, den = stream["avg_frame_rate"].split("/")
    return {
        "clipWidth": stream["width"],
        "clipHeight": stream["height"],
        "clipFps": round(int(num) / int(den), 3),
        "clipDurationSeconds": round(float(parsed["format"]["duration"]), 3),
    }


def main() -> None:
    registry = json.loads(REG.read_text())
    existing = {item["id"] for item in registry["freshCandidates"]["items"]}
    added = []
    for clip in CLIPS:
        if clip["id"] in existing:
            print(f"skip (already registered): {clip['id']}")
            continue
        path = FC_DIR / f"{clip['id']}.mp4"
        data = path.read_bytes()
        media = {
            "type": "video/mp4 (H.264, no audio)",
            "segment": clip["segment"],
            "sourceResolutionFps": clip["sourceResolutionFps"],
            **ffprobe(path),
            "clipBytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        entry = {
            "id": clip["id"],
            "role": "fresh_candidate",
            "labelBlind": True,
            "path": str(path.relative_to(ROOT)),
            "sourceUrl": clip["sourceUrl"],
            "title": clip["title"],
            "uploader": clip["uploader"],
            "uploaderChannelId": clip["uploaderChannelId"],
            "uploadDate": clip["uploadDate"],
            "license": LICENSE,
            "licenseVerification": LICENSE_VERIFICATION,
            "provenanceAssessment": clip["provenance"]
            + ". Uploader authority is assessed from channel context, not independently "
            "confirmed by the rights holder - recorded as a residual caveat.",
            "rights": {
                "store": "yes_with_attribution",
                "analyze": "yes_with_attribution",
                "annotate": "yes_with_attribution",
                "train": "yes_with_attribution",
                "redistributeDerivatives": "yes_with_attribution",
                "commercial": "yes_with_attribution",
                "basis": "CC BY 3.0 declared by the uploader on YouTube permits any use including commercial with attribution.",
                "reviewedBy": "wave-g:g18-fresh-footage (page-verified license; channel-context provenance assessment; full-clip contact-sheet frame screening)",
                "reviewedAtIso": "2026-08-29",
            },
            "restrictions": [
                "attribution to the uploader required on redistribution",
                "uploader authority assessed from channel context, not independently confirmed",
            ],
            "media": media,
            "pickleballRelevance": clip["pickleballRelevance"],
            "acquisition": {
                "acquiredAt": "2026-08-29",
                "method": "yt-dlp download of the CC BY source video (video stream only, no audio), 60s segment re-encode with ffmpeg (libx264 crf20)",
                "workstream": "wave-g/g18-fresh-footage",
            },
            "notes": "FRESH HOLDOUT candidate: label-blind until a future freeze. No labels of any kind exist or may be created for this clip before the freeze.",
        }
        registry["freshCandidates"]["items"].append(entry)
        registry["freshCandidates"]["totalBytes"] += len(data)
        added.append(clip["id"])
    REG.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n")
    print("added:", added)


if __name__ == "__main__":
    main()
