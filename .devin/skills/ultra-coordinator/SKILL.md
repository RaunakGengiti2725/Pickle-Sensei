---
name: ultra-coordinator
description: Fan-out/fan-in orchestration for a Pickle Sensei improvement session — baseline on main, competing implementers per workstream, independent reviewer + adversarial tester per candidate, deterministic evidence-based judge, single integration PR verified across Cloud, M4 and benchmarks. Use when an Ultra lead has 3+ independent workstreams to run in parallel; run via the run_workflow tool with script_path pointing at workflow.py.
---

# Ultra coordinator (dynamic workflow)

`workflow.py` is a deterministic `run_workflow` script. It never edits code
itself; every unit of work is a separate-VM child session with its own clone
of `RaunakGengiti2725/Pickle-Sensei`, and code moves between stages only via
git branch names returned in structured output.

```
baseline(main) ─► for each workstream: implement ×N ─► review ∥ adversary ─► judge ─► integrate ─► ONE draft PR
```

## Before running

1. Copy `workstreams.example.json` to `workstreams.json` (same directory;
   git-ignored is fine, or commit it as the record of the session) and edit:
   - `objective` — one sentence the whole run serves.
   - one entry per workstream with disjoint `scope_paths` (the script refuses
     overlapping prefixes), `plane` (`cloud` / `mac` / `bench`), executable
     `acceptance` criteria, and `competing` (2–3 for hard optimisation
     problems: independent approaches judged on identical benchmarks).
   - Validate the shape against `workstreams.schema.json`.
2. Confirm `main` is green: the workflow aborts when the baseline
   `scripts/verify-cloud.sh --tier full` has a failing stage — improving a red
   base is not measurable.
3. Invoke the builtin `dynamic-workflows` skill (authoring/resume semantics),
   then:

```text
run_workflow(
  workflow_name="pickle-sensei-ultra-<date>",
  script_path="/abs/path/to/repo/.devin/skills/ultra-coordinator/workflow.py",
)
```

Optional env for the orchestrating machine: `PS_WORKSTREAMS=/path/to/spec.json`,
`PS_REPO_ROOT=/path/to/repo`.

## What each role is held to

| Role                   | Must                                                                                                                                                                                                                                   | Reports                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| baseline               | `verify-cloud --tier full` + `bench:regression`/`bench:compare` on the base SHA; changes nothing                                                                                                                                       | base SHA, failing stages, metric count          |
| implementer            | stay inside `scope_paths`; regression tests; `verify-cloud --tier pr` exit 0; bench counts (bench plane) or Mac run URL (mac plane); push branch, no PR                                                                                | `PASS/FAIL` per acceptance criterion            |
| reviewer               | distrust the implementer; diff scope check; `REVIEW.md`/`AGENTS.md`; re-run verification                                                                                                                                               | `approve` only when every criterion is VERIFIED |
| adversary              | try to break it (edge media, cancellation, auth expiry, RLS, size/rate limits, model-version mismatch); push failing tests to an attack branch                                                                                         | `break_found` only with an exact repro          |
| judge (code, no agent) | candidate eligible iff implementer PASS on all criteria ∧ verify exit 0 ∧ reviewer approve ∧ no adversarial break ∧ (bench plane ⇒ 0 regressions); rank by bench improvements, then fewest reviewer issues, then most attacks survived | winner branch or none                           |
| integrator             | merge winners; `verify-cloud --tier full`, `bench:compare`, `mac-full-verify --remote` when Apple paths changed; open ONE draft PR only when green; never merge                                                                        | PR URL + exit codes                             |

## Planes

- **cloud** — `scripts/verify-cloud.sh --tier pr|full --start-services`; `artifacts/verify-cloud/<run>/summary.json`.
- **mac** — `scripts/mac-full-verify.sh --remote` on the self-hosted M4 runner (labels `self-hosted, macOS, ARM64`); artifacts `run.json`, `.xcresult`, vision summary. Nobody has a Mac locally.
- **bench** — `pnpm --filter @pickle/evaluation bench:regression` + `bench:compare` against `datasets/reports/regression/baseline.json` on a clean commit; tolerances and datasets are read-only.

## Resume / cost

Every completed `agent()` is recorded; re-run with the reported `run_id` after
a timeout or interruption and completed stages replay. Watch progress and ACU
totals with `get_workflow_output`. Expect roughly (1 + 4·Σcompeting + 1)
child sessions.

## Forbidden (enforced by prompts; verify in review)

Weakening or skipping tests, `|| true`, editing `regression.tolerances.json`
or `datasets/`, touching production Supabase or App Store Connect, storing
secrets, pushing to `main`, modifying the Mac runner or reading anything on
the Mac outside the workflow, user-facing copy that violates
`APP_STORE_SUBMISSION.md`.
