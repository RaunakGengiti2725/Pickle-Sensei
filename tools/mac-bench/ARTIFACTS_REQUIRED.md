# Artifacts required on the Mac before `run-mac-bench.sh` can run

Everything the single-command harness needs but the repo does not carry.
The script checks each of these and fails fast with the missing item named.

Hash policy: hashes below are SHA-256 (`shasum -a 256 <file>`). Where a
hash says UNAVAILABLE-HERE it is because the artifact is gitignored and
absent from the Linux environment that authored this harness — record the
hash the first time the artifact lands on the Mac and update this file.

## 1. Source videos (gitignored: `datasets/paddle-bench/videos/`)

The benchmark case list is `datasets/paddle-bench/regen-manifest.json`
(frozen, committed). It needs these five files under
`datasets/paddle-bench/videos/`; identity/provenance for each is in the
committed `datasets/paddle-bench/registry.json` (source URL, license,
resolution, fps, durationMs):

| case id           | file                     | registry id          |
| ----------------- | ------------------------ | -------------------- |
| wm-dink-01        | wm-dink-nearplayer.mp4   | wm-dink-nearplayer   |
| wm-volley-02      | wm-volley-nearplayer.mp4 | wm-volley-nearplayer |
| afn-sasebo-rally1 | afn-sasebo-rally1.mp4    | afn-sasebo-rally1    |
| afn-sasebo-rally2 | afn-sasebo-rally2.mp4    | afn-sasebo-rally2    |
| afn-vic-rally1    | afn-vic-rally1.mp4       | afn-vic-rally1       |

Expected SHA-256: UNAVAILABLE-HERE for all five (videos are gitignored and
not present in this environment). Cross-check instead against the committed
registry metadata (resolution/fps/durationMs) and — for the three cases that
have committed bundle clips — against the event-window clips, whose hashes
ARE known and committed:

| committed bundle clip                                    | sha256                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4 | `21fb75446a038ed5fb268b4287b7b6b2831d3712cbb05fedb21b97e440ad2daf` |
| datasets/paddle-bench/bundles/wm-dink-01/clip.mp4        | `7d396a6d65669fc3b7fc3c33988e257be08f830e93ca20c51f38171fca0959a7` |
| datasets/paddle-bench/bundles/wm-volley-02/clip.mp4      | `8b77606225ba0e3543accc6195c7fb10a7d312f445a73a5e4a03ab68b8862c15` |

(These clip hashes were measured in this environment on 2026-08-29 from the
committed files; they identify the event windows, not the source videos.)

## 2. Model weights

- Paddle detector: Hugging Face `ustc-community/dfine-medium-coco`
  (`DETECTOR_VERSION = "dfine-medium-coco@transformers"`, Apache-2.0,
  COCO-pretrained — no paddle class; proxy classes recorded in artifacts).
  Fetched into the local HF cache on first run
  (`~/.cache/huggingface/hub/models--ustc-community--dfine-medium-coco`).
  Expected weight hash: UNAVAILABLE-HERE — pin by recording
  the `snapshots/<revision>` directory name from the HF cache on first
  Mac run. `detect_paddle.py` prefers the local cache
  (`local_files_only=True`) so after the first run no network is needed.
- Pose: Apple Vision framework (ships with macOS; no downloadable weights).
  Version is whatever the OS provides — record `sw_vers` output (the results
  JSON captures this in `host`).

## 3. Environment

- macOS 14+ on Apple silicon (Vision body-pose + MPS for torch).
- Xcode command-line tools (`swift` on PATH) — builds `native/swing-lab`
  via `swift build -c release`.
- Node 20.x (`>=20 <21`, repo engines) + pnpm 10.15.1; `pnpm install` run
  at repo root.
- `ffmpeg` on PATH (window decode in `detect_paddle.py`).
- Python venv at `tools/paddle-lab/.venv` with: `torch` (MPS build),
  `transformers`, `numpy`, `pillow`. Exact versions: UNAVAILABLE-HERE — no
  lockfile is committed for the venv; freeze one (`pip freeze`) on the Mac
  and commit it alongside this file.

## 4. Canonical runs (gitignored: `datasets/paddle-bench/runs/`)

Not required as inputs — the harness REGENERATES them via
`pnpm lab:regen --exec` (step 3) and `lab:regen` verifies target-track
identity against the frozen manifest. They must simply be writable.
