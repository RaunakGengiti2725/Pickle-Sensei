# ml-tooling-datasets adjudication harnesses (commit 4d812e1a)

Independent reproductions used to adjudicate the auditor / attacker reports for
`ml/`, `datasets/pickleball/`, `tools/mining/`, `tools/paddle-lab/`,
`tools/e15_download.py`. Linux plane only; nothing here touches Apple code.
Every script exits 0 when the tooling behaves and 1 when the defect is present,
so each doubles as an acceptance check for the eventual fix.

Run from the repo root with a Python that has numpy, scipy, Pillow, jsonschema
and (CPU) torch (`/home/ubuntu/adj-venv/bin/python` in the adjudication box):

| script                         | what it proves                                                                                                                          | result on 4d812e1a                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repro_clock_skew.py`          | ball_candidates tMs, `student_lib.extract_frames` and `detect_paddle.run_crops` vs the absolute CFR clock (pixel-identity ground truth) | exit 1: ball_candidates −33.9 ms on afn-sasebo-rally1 (−6 ms on wm-volley-02 for a non-frame-aligned start); extract_frames / run_crops return frame k+1 for every tMs on the 29.97 fps clip |
| `repro_miner_frame_pack.py`    | g03 miner `ffmpeg -ss tMs` frame packs vs the frame the candidate names                                                                 | exit 1: k+1 on both clips, k+2 for two afn candidates                                                                                                                                        |
| `repro_truncated_media.py`     | faststart clip truncated to 60 % (probes as 200 frames)                                                                                 | exit 1: ball_candidates exit 0 with 112/200 frames; `frame_iter` yields 12/20 without raising                                                                                                |
| `repro_ball_candidates_cli.py` | window / scale / cap argument contract                                                                                                  | exit 1: start beyond clip and end<start → empty artifact, exit 0; `--scale 0` spins forever; `--max-per-frame 10` emits 233 candidates/frame                                                 |
| `repro_validator.py`           | validate_annotations CLI contract + agreement with `annotation.schema.json`                                                             | exit 1: 9 traceback crashes (TypeError / UnicodeDecodeError / RecursionError), FIFO hang, 6 schema-invalid optional-field payloads accepted                                                  |
| `repro_e15_download.py`        | e15_download lifecycle in a scratch tree                                                                                                | exit 1: corrupt / partial pre-existing files reported `already_present` and never re-fetched; process exit 0 with 3/5 entries `shaVerified=false`                                            |

Verified OK (no defect): `python3 -m unittest discover -s ml/scripts -p 'test_*.py'`
(17 tests), `tools/paddle-lab/test_timestamp_alignment.py` on the three committed
clips, `packages/swing-lab/test/e08FreshHoldoutGuard.test.ts` (9 tests),
`train_student.py --epochs 2` twice → identical weights and history (124/93
split), miner rerun in a scratch worktree → `git status datasets/mining` clean
(byte-identical candidates, queue and frame packs), `distill_export.py` rerun →
identical `examples.jsonl` (manifest differs only by Prettier line wrapping),
registry devPool + freshCandidates 21/21 files present with matching sha256 and
byte count, no id in two sections, and no held-out / dev-pool id referenced
anywhere under datasets/mining, datasets/releases, datasets/paddle-bench,
tools/paddle-lab, tools/mining or ml/.
