# Adversarial attack suite — ml-tooling-datasets (pass 3, tester #2)

Executable attacks against `tools/e15_download.py`, `ml/scripts/validate_annotations.py`,
`tools/paddle-lab/{ball_candidates,detect_paddle}.py` and
`tools/mining/wave_g_g03_multi_paddle_miner.py` as of `4d812e1a`.

Every test drives the real production script through `subprocess` (no re-implementation);
`detect_paddle_nomodel_driver.py` only stubs `load_model()` so argparse / ffprobe / ffmpeg /
timestamp / serve-protocol code runs without the D-FINE checkpoint. Nothing here writes
into `datasets/`; the miner tests copy their inputs into a scratch tree.

```
python3 -m unittest discover -s tools/paddle-lab/attacks -p 'test_*.py' -v
ATTACK_ARTIFACT_DIR=/tmp/attack-ml-tooling-2   # JSON evidence per attack (default)
```

Requires `ffmpeg`/`ffprobe`, `numpy scipy pillow`, CPU `torch`.

**Failing tests are the findings.** Each assertion encodes the *expected* contract; on
`4d812e1a` the suite reports `FAILED (failures=24)` — those are the BROKEN scenarios in the
pass-3 report, all pre-existing on `origin/main` (the five production files are identical
there). Tests that pass are the HELD scenarios. When a production fix lands, the matching
test turns green with no edit to this suite.

| File | Scenarios |
| --- | --- |
| `test_e15_download_corrupt_present.py` | S1 corrupt pre-placed media, network-blocked; SHA mismatch exit; partial-download promotion |
| `test_validate_annotations_paths.py` | S2 directory / FIFO / permission / symlink loop / bad UTF-8 / BOM / `/dev/zero` / unicode / 2000 files / label look-alikes |
| `test_detect_paddle_media_and_args.py` | S3 0-byte + audio-only + truncated media (one-shot and serve); S7 `--decode-size … --legacy-decode` |
| `test_ball_candidates_windows.py` | S4 `--scale 0.33` on 1080p, inverted area bounds, degenerate scales; S5 past-end window; S6 `tMs` vs CFR model; `--max-per-frame` cap; determinism |
| `test_mining_held_out_and_determinism.py` | held-out leakage (incl. injected records), byte-identical reruns, committed `candidates.json` reproducibility, TZ/locale/hash-seed independence |
