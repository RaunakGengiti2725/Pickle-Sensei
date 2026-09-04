# Adversarial harnesses — `ml-tooling-datasets`

Executable attacks against `ml/scripts/validate_annotations.py`,
`tools/paddle-lab/detect_paddle.py --serve`, and the e08 fresh-holdout guard
(`packages/swing-lab/test/e08FreshHoldoutGuard.test.ts`). Written against
commit `4d812e1a`; no production code is touched. Every harness is
deterministic (seed `20260904`, override with `ATTACK_SEED` / `--seed`).

| Harness                               | Scenarios                                                                                                                                                      | Run                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `test_attack_validate_annotations.py` | S2 unreadable inputs, S3 duplicate phase keys, type confusion, schema drift, scale                                                                             | `python3 -m unittest discover -s tools/attack/ml-tooling-datasets -p 'test_*.py' -v`                                        |
| `serve_worker_attack.py`              | S1 stdin EOF mid-request (+ seeded repeats with queued requests), SIGTERM/SIGKILL, dead client (stdout closed), hostile protocol lines, bad requests, shutdown | `<paddle-venv>/bin/python tools/attack/ml-tooling-datasets/serve_worker_attack.py --out /tmp/serve.json`                    |
| `e08_scenarios.mjs`                   | S4 byte-flip positive control, S5 same-channel move, S6 wrong `devPool.totalBytes`, S7 fresh id under `datasets/**/annotations`, S7b corpus positive control   | `node tools/attack/ml-tooling-datasets/e08_scenarios.mjs --worktree <scratch git worktree at 4d812e1a> --out /tmp/e08.json` |
| `registry_integrity.py`               | Registry invariants e08 does not check: pool byte totals, per-item `clipBytes`, sha256, channel disjointness, fresh ids in any labeled artifact                | `python3 tools/attack/ml-tooling-datasets/registry_integrity.py [--root <tree>]`                                            |

Exit codes: each harness exits non-zero when the attacked component deviated
from its contract (a reproduced finding), zero when every attack HELD.
`e08_scenarios.mjs` mutates only the scratch worktree passed via `--worktree`
(it refuses to run against the primary checkout), restores every mutation, and
fails with exit 3 if `git status -- datasets` is not clean afterwards.
