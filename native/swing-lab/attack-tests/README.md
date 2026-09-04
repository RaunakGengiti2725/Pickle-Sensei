# swing-lab adversarial harness (pass 3, `native-swing-lab-camera-engine`)

Attack tests for the `swing-lab extract` CLI at `4d812e1a`. New files only —
nothing under `native/swing-lab/Sources` or `native/camera-engine` is touched,
and the production `Package.swift` gains no test target.

| file | plane | purpose |
| --- | --- | --- |
| `fixtures/make_fixtures.sh` | Linux/mac (ffmpeg) | deterministic clips (seed `20260904`): rotated-90° preferredTransform, VFR nominalFrameRate=0 with a person visible half the time, PTS rewind via edit-list and via CTTS, hard cut every 500 ms, panning camera, audio-only `.m4a`, one-frame, seeded-corrupt, empty. Fails loudly if a fixture does not carry the property it is supposed to attack with. |
| `fixtures/mp4_edit.py` | Linux/mac | box-level MP4 inspector/mutator (`inspect`, `rotate-90cw`, `elst-rewind`, `ctts-rewind`). |
| `check_extract.py` | Linux/mac | asserts the contract over the five `extract` outputs (`scenes/pose/people/ball/extract-meta.json`): upright w/h, landmarks ∈ [0,1], strictly increasing timestamps that are a subset of decoded PTS, fps vs decoded cadence, duration vs decoded media, cuts strictly increasing + exact `[0,durationMs]` partition, `cameraAssumption == "stationary"` verbatim, overwrite freshness (`--not-before`). Exit 1 on any failure; `--report` writes JSON. |
| `test_check_extract.py` | Linux | 18 unittests: the checker catches every scenario's failure mode on synthetic outputs, the fixture generator self-verifies, and the same-SHA Mac artifact (`SWING_LAB_MAC_EXTRACT_DIR`) reproduces the baseline observations. |
| `run_linux_checks.sh` | Linux | byte-compile → unittests → fixtures → checker vs Mac artifact. |
| `run_mac_attacks.sh` | **mac only** | builds Release `swing-lab`, runs every scenario (S1–S7) plus extras (X1–X6: corrupt/empty/missing input, one-frame, out-is-a-file, read-only out, unicode paths, 8× concurrent repeats, interleaved same `--out`, SIGTERM mid-flight), writes `results.jsonl` (`HELD`/`BROKEN` per scenario) and exits 1 iff any row is `BROKEN`. Refuses to run on non-Darwin. |
| `SwingLabAttackTests/` | **mac only** | XCTest wrapper: `swift test` runs the driver once and surfaces each scenario as its own assertion. |

## Run

```bash
# Linux (harness health + Apple evidence from the existing same-SHA artifact)
gh run download 33841813597 -n mac-full-verify-3 -D ~/mac-artifacts/run-33841813597/mac-full-verify-3
native/swing-lab/attack-tests/run_linux_checks.sh --out /tmp/swing-lab-attack-linux

# mac (Apple truth for the seven scenarios; needs ffmpeg + Xcode toolchain)
native/swing-lab/attack-tests/run_mac_attacks.sh --out /tmp/swing-lab-attack-mac
# or
(cd native/swing-lab/attack-tests/SwingLabAttackTests && swift test)
```

Linux runs never prove AVFoundation/Vision behaviour; only `results.jsonl`
from a Mac run of the driver (or a same-SHA `mac-full-verify` artifact) does.
