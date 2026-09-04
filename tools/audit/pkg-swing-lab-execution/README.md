# pkg-swing-lab execution audit harnesses (pass 2)

Audit-only tooling for `packages/swing-lab` and `packages/model-registry`.
Nothing here is used by the product, CI, or the verify scripts. All scripts
run against a caller-supplied checkout and write only to a caller-supplied
output directory; the lab-script runners require a _scratch git worktree_
because the swing-lab scripts rewrite tracked `datasets/**` artifacts.

| file                                              | what it exercises                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_suites.sh <repo> <out>`                      | both suites twice, shuffled (2 seeds), `--reporter=hanging-process` (Vitest's open-handle check), the isolated crossfade test, both typechecks, and the `/tmp` temp-dir count before/after              |
| `run_lab_scripts.sh <worktree> <out> [script…]`   | every `tsx src/*.ts` package script with no arguments; records exit, wall time, stdout/stderr and the tracked/untracked files each script wrote, then restores the worktree                             |
| `determinism_check.sh <worktree> <out> <script…>` | runs a script twice and diffs run1 vs run2 (timestamps normalised) and committed vs run1 (stale-artifact detection)                                                                                     |
| `annotate_probe.sh <repo> <out>`                  | drives `src/annotate.ts` through missing/empty/mixed roots, non-bundle paths, traversal, valid save + revision bump, malformed bodies                                                                   |
| `probe_model_registry.ts [repo]`                  | `npx tsx probe_model_registry.ts` from `packages/swing-lab`: malformed manifests, forbidden aliases, missing hashes, rollback cycles, version ordering, committed dataset-release hashes, lineage audit |

Example:

```bash
git worktree add /tmp/ps-scratch HEAD && (cd /tmp/ps-scratch && pnpm install --frozen-lockfile --offline)
tools/audit/pkg-swing-lab-execution/run_suites.sh . /tmp/audit
tools/audit/pkg-swing-lab-execution/run_lab_scripts.sh /tmp/ps-scratch /tmp/audit/scripts
tools/audit/pkg-swing-lab-execution/determinism_check.sh /tmp/ps-scratch /tmp/audit/determinism session:scheduler-sim corpus:sessions
tools/audit/pkg-swing-lab-execution/annotate_probe.sh . /tmp/audit/annotate
```

Linux results from these harnesses are replay-proxy evidence only; they say
nothing about Apple Vision / iOS runtime behaviour.
