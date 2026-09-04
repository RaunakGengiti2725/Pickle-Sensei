---
name: pre-pr-verification
description: Run exactly what CI gates before opening or updating a Pickle Sensei PR — the canonical Linux gate (scripts/verify-cloud.sh --tier pr) plus the real Mac run when Apple paths changed. Use before every PR, and again after every push to it.
---

# Pre-PR verification

CI (`.github/workflows/ci.yml`) does not contain test logic; it calls
`scripts/verify-cloud.sh`. Running the same script locally is therefore a
faithful prediction of CI. Never open a PR on the basis of "the code looks
right" or "the subset I touched passes".

## Setup (once per session)

```bash
cd /home/ubuntu/repos/Pickle-Sensei
docker compose up -d postgres postgres-test          # 5432 dev, 5433 test
scripts/verify-cloud.sh --only deps                  # pnpm install --frozen-lockfile + apps/mobile npm ci
```

Node must be 22.x (`node -v`); pnpm is `pnpm@10.15.1` via corepack. Never run
pnpm inside `apps/mobile` (npm + package-lock there).

## Procedure

1. Commit your work (the tree you verify must be the tree you push).
2. Run the PR tier — this is byte-for-byte the CI gate:
   ```bash
   set -o pipefail
   scripts/verify-cloud.sh --tier pr 2>&1 | tee /tmp/verify-pr.log
   echo "exit=${PIPESTATUS[0]}"
   ```
   Stages: `deps format lint typecheck test db mobile ml edge rls security`.
   `test` needs `DATABASE_URL_TEST` (default matches docker-compose); `db`
   needs `DATABASE_URL`. `rls` needs Docker (postgres:16 throwaway).
3. Read `artifacts/verify-cloud/<UTC>/summary.json`. Every stage must be
   `passed`; `skipped`/`unavailable` is not a pass. Per-stage logs are next
   to it (`<stage>.log`).
4. If you changed anything under `native/`, `apps/mobile/ios/`,
   `apps/mobile/package.json`, `tools/macos-ci/`, or `scripts/mac-full-verify.sh`,
   ALSO run the Mac half (see the `macos-verification` skill):
   ```bash
   scripts/mac-full-verify.sh --remote        # pushes HEAD to ci/mac-<branch>, waits, downloads artifacts
   ```
   Linux cannot compile Swift or run Vision/XCTest; do not claim Apple
   behaviour without this run's artifacts.
5. Only then open/update the PR. In the PR body list the exact commands
   above and paste the `summary.json` stage table (or link the CI run).

## Fast inner loop (not a substitute for step 2)

```bash
scripts/verify-cloud.sh --only typecheck,test          # workspace packages
scripts/verify-cloud.sh --only mobile                  # apps/mobile tsc + jest
(cd apps/mobile && npx jest __tests__/<file>.test.ts)  # one suite
(cd supabase/functions/api/__wf__ && deno task test)   # edge fn
./supabase/tests/run_rls_tests.sh                      # RLS/security matrix
```

## Failure handling

- A failing stage is a real failure until proven otherwise: open the stage
  log, reproduce with the single command from the log header, fix the root
  cause, re-run the full tier.
- `format` failures: `pnpm format` (root prettier is the authority; apps/mobile
  pins the same version).
- `test` failing with `ECONNREFUSED :5433`: the test Postgres is not up —
  `docker compose up -d postgres-test`; do not skip the stage.
- `rls` needing Docker: if Docker is genuinely absent the script falls back
  to a local `initdb` cluster; if neither exists the stage FAILS — that is
  correct, report it.
- `security` reports `unavailable` when `scripts/security-scan.sh` is absent;
  that is not a pass and must be stated in the PR.

## Forbidden

- `--skip` of a failing stage to get green.
- Editing tests, snapshots, or lint config to make a stage pass (unless the
  task is explicitly about that test).
- `|| true`, `--passWithNoTests`, `@ts-ignore`/`eslint-disable` to silence a
  gate.
- Claiming "CI will catch it" — CI runs the same script; run it first.
