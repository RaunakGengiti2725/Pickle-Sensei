---
name: production-program
description: Per-work-package dynamic workflow for the Pickle Sensei production-completion program — frozen manifest (.devin/program/manifest.json), pinned base SHA, implementer → independent reviewer → adversary → deterministic evidence judge, requeue on rejection, machine-readable ledger. Use when running the production-readiness workstreams (Phase 0, W00–W12, Phase 2) as bounded, resumable dynamic workflows; run one launcher per package via run_workflow.
---

# production-program

Successor to `ultra-coordinator` for the 2026-09 production continuation. It
fixes the coordinator gaps recorded in the owner directive: pinned base SHA
(never `main`), baseline failures recorded not waived, exact acceptance-
criterion coverage graded by kind, SHA agreement across the three roles,
independent review, adversarial breaks block acceptance, rejected packages
are requeued (never dropped), and every input is frozen so a resumed run
replays byte-for-byte.

## Files

- `.devin/program/build_manifest.py` — package table → `manifest.json`
  (`manifest_sha256` seals it; `load_manifest` refuses a tampered file).
- `.devin/program/manifest.json` — frozen work packages: id, parent
  workstream, objective, severity, source finding ids, plane, deps,
  `serial_groups` (shared-contract ownership), `write_paths`,
  `additive_shared_paths`, acceptance criteria `{id, kind, command,
criterion}`, invariants, `external_blocker`; top-level
  `serial_group_paths` maps each group to the path prefixes it owns (a
  package may edit under a prefix only if it holds the group).
- `program_lib.py` — prompts, schemas, `grade_acceptance`, `judge`,
  `run_package` (runtime primitives injected → unit-testable).
- `make_launcher.py` — writes `.devin/program/runs/<PKG>__<base12>__<wave>.py`,
  the file passed to `run_workflow(script_path=...)`. `--requeue-from
<record.json>` freezes the prior round's blocking findings and continues
  the round numbering so branch names never collide.
- `test_program_lib.py` — offline failure-path tests (`python3
test_program_lib.py` from this directory). Run before trusting a change.
- `schedule.py` — dependency/serial-group aware wave planner and ledger
  roll-up (`python3 schedule.py plan|ledger`).

## Running one package

```sh
python3 .devin/program/build_manifest.py            # only if the table changed
python3 .devin/skills/production-program/make_launcher.py W01-05 <BASE_SHA_40> wave-2 \
  --branch devin/<integration-branch>            # must contain BASE_SHA on origin
# requeue after a REQUEUE record:
python3 .devin/skills/production-program/make_launcher.py W03-01 <BASE_SHA_40> wave-2 \
  --branch devin/<integration-branch> --requeue-from .devin/program/ledger/W03-01/pilot-1/record.json
# then: run_workflow(workflow_name="pp-W01-05", script_path=<printed path>)
```

Resume with the reported `run_id`; the launcher aborts if the manifest hash
changed since it was frozen.

## Concurrency rules (owner-imposed)

- Default: at most TWO package runs active at once. The owner approved lifting
  this on 2026-09-08 ("make 100+ sessions run simultaneously"); pass the
  approved limit explicitly with `schedule.py plan --max-active N`. Each run
  has one implementer at a time, then reviewer and adversary concurrently on
  the same frozen candidate sha.
- `serial_groups` in the manifest: never run two packages that share a group
  concurrently; `schedule.py plan` enforces this plus `deps`.
- Mac plane packages are executed by the coordinator only (one Mac job
  globally); workers are told never to push `ci/mac-*` or run
  `mac-full-verify --remote`.
- Integration (merging accepted candidate branches into the integration
  branch, running the whole-product gates, updating the packet) is done by the
  single coordinator session — W12 packages are `docs` plane and not
  launched.

## Evidence grading (deterministic)

`kind=test|regress`: exit 0, executed>0, failed=0, skipped=0. `kind=check`:
exit 0. `kind=manual`: artifact required. Every acceptance id exactly once;
reviewer must re-execute independently; regression tests must FAIL on base;
adversary P0/P1 breaks or zero attacks reject. `kind=regress` records carry
the proof outcome as `exit_code` (0 only if the new tests fail on base and
pass on head) with head counts; the base run goes in `note`. Output per
package: `.devin/program/ledger/<PKG>/<wave>/record.json` (rounds, agents,
decisions, candidate) — tracked in git so the ledger travels with the PR.
