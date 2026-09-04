# static-health

Read-only static code-health census for `packages/*`, `services/*`, `tools/*`, `ml/`.
Nothing here modifies source, manifests, datasets or baselines; every harness
writes JSON + markdown so the result is a checkable table, not an opinion.

| harness                    | question                                                                            | external tool                |
| -------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `dead-packages.mjs`        | who references each `@pickle/*` package (imports, manifests, aliases, scripts, CLI) | none                         |
| `workspace-cycles.mjs`     | package-manifest cycles (`workspace:*` edges), runtime vs dev                       | none                         |
| `circular-deps.sh`         | file-level import cycles per package and across all `src/`                          | `madge@8`                    |
| `depcheck-all.sh`          | unused / missing npm deps per package                                               | `depcheck@1.4`               |
| `depcheck-consolidate.mjs` | triage table for the depcheck output                                                | none                         |
| `type-escapes.mjs`         | `any`, `as any`, `as unknown as`, `!`, ts-ignore, eslint-disable, py `type: ignore` | none (repo `typescript` AST) |
| `duplicates.sh`            | copy-paste clones, src-only and src+test passes                                     | `jscpd@4`                    |
| `duplicates-summarize.mjs` | ranks clones, flags cross-package ones                                              | none                         |

The external tools are not repo dependencies. Install them once outside the
workspace and point the scripts at them:

```sh
mkdir -p ~/static-health-tools && (cd ~/static-health-tools && npm i madge@8 depcheck@1.4.7 jscpd@4)
export MADGE=~/static-health-tools/node_modules/.bin/madge
export DEPCHECK=~/static-health-tools/node_modules/.bin/depcheck
export JSCPD=~/static-health-tools/node_modules/.bin/jscpd
```

Run everything (artifacts under `artifacts/static-health/` by default, git-ignored):

```sh
tools/static-health/run-all.sh [out-dir]
```

Verdict vocabulary for `dead-packages.mjs`:

- `shipping` — imported by `apps/mobile/src` or `supabase/functions` (non-test).
- `library` — imported by production code of another workspace package/tool.
- `test-only` — imported only from other packages' tests.
- `cli-only` — not imported, but invoked via `pnpm --filter` from root scripts / CI / `scripts/**`.
- `standalone-cli` — not referenced from outside, but ships its own CLI scripts / `*.sh`.
- `dead-candidate` — no importer, no invocation, no entrypoint; only its own tests exercise it.
  This is a census label, not a deletion verdict — confirm intent with the owner first.

Tests (pure Node, no vitest needed):

```sh
node --test 'tools/static-health/test/*.test.mjs'
```
