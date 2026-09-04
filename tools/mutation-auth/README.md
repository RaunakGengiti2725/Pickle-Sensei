# mutation-auth — mutation testing of the auth/session contract

Execution-based check that the durable sign-in contract (AGENTS.md → "Auth
sessions") is pinned by tests that actually FAIL when the behaviour changes.
Every mutant in `mutants.json` replaces exactly one snippet in one production
file (`sessionKeeper.ts`, `sessionLifecycle.ts`, `apiSession.ts`,
`sessionVault.ts`, `authStore.ts` on mobile; `authenticate()` / auth cache /
bootstrap / refresh / logout / rate limits in `supabase/functions/api/index.ts`
on the edge). The runner applies the mutant, runs the suites that depend on the
file, restores the original bytes (hash-verified) and records the outcome.

```
node tools/mutation-auth/run.mjs [--plane mobile|edge|all] [--only SK-01,ED-06]
     [--out <dir>] [--suites existing|all] [--baseline]
```

- `--suites existing` ignores the tests under `apps/mobile/__tests__/xc/` and
  `supabase/functions/api/__wf__/xc_*` so the matrix reflects the suites that
  predate this tool. `--suites all` includes them.
- Mobile runs `npx jest --ci --silent --json --findRelatedTests <file>` inside
  `apps/mobile` (npm project — never pnpm). Edge runs
  `deno test -A --no-check --config deno.json .` inside `__wf__`.
- Output: `results.json` (one row per mutant: id, plane, mutation, exact
  command, exit code, failed/total, killing tests, ms), `matrix.md`, and the raw
  `<id>.log` + `<id>.jest.json` / `<id>.junit.xml` per mutant.
- The runner refuses to start when a target file has uncommitted changes and
  aborts the run (after restoring) if a snippet is not found exactly once.

Result on `4d812e1a` (see `results/`): 74 mutants — 37 killed / 37 survived by
the pre-existing suites; 74 killed / 0 survived once the regression tests on
this branch are included.

A survivor is a test-quality gap: write the missing test (new file), never
weaken the mutant or the production code.
