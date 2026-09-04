# screen-ux-a11y-i18n-2 — HomeScreen / ProgressScreen / StreakCalendarScreen / LibraryScreen

Execution-based UX / accessibility / i18n audit harness. It renders each screen
with React Test Renderer under the Jest preset, drives every reachable state
(loading, empty, error, stale, populated, retry/recovery, navigation), walks the
rendered tree and records text, controls, roles, labels, states, hit slop,
estimated sizes and copy problems for every cell of the matrix.

Nothing here touches production code or existing tests. The default
`apps/mobile` Jest `testMatch` only covers `__tests__/` and `tsconfig.json`'s
`include` only covers `src/` + `__tests__/`, so the harness runs through its own
`jest.config.js` / `tsconfig.json` and leaves the canonical
`npx tsc --noEmit && npx jest --ci --silent` gate unchanged.

## Run

```bash
cd apps/mobile
npx jest --ci -c audit/screen-ux-a11y-i18n-2/jest.config.js          # all four screens
npx jest --ci -c audit/screen-ux-a11y-i18n-2/jest.config.js homeScreen
npx tsc --noEmit -p audit/screen-ux-a11y-i18n-2/tsconfig.json         # type-check the harness
npx prettier --check audit/screen-ux-a11y-i18n-2
(cd ../.. && npx eslint apps/mobile/audit/screen-ux-a11y-i18n-2)      # root ESLint covers apps/mobile
```

Artifacts land in `artifacts/screen-ux-a11y-i18n-2/` (repo root, gitignored):

- `<Screen>.json` — every scenario × cell: inputs, seed, texts, controls, focus
  order, issues (`confidence: VERIFIED | INFERRED`), console errors, thrown.
- `<Screen>.summary.json` — issue counts by kind + per-cell matrix + the
  screen-specific probes (loading/error/locale/pending-cap notes).
- `<Screen>.matrix.tsv` — issue kind × cell table.

## Matrix

`harness/treeAudit.ts`: font scales `1 / 1.35 / 3.12` × widths `320 / 375 / 430`
plus two RTL cells (`fs1@375`, `fs1.35@320`) = 11 cells per state. Seeded fuzz
(`harness/fixtures.ts` `Rng`) runs 100–120 seeds per screen over two cells;
every result carries `seed` + `inputs` so a failure replays by id.

## Confidence

React Test Renderer on Linux does not run Yoga or native text measurement.
Every `layout.*` and `control.target*` issue is therefore `INFERRED` (an
estimate from style + character-width heuristics) and must be confirmed on the
iOS Simulator before it is reported as native behaviour. `copy.*`,
`control.duplicateLabel`, `control.labelSlug`, role/label/state facts and the
state-transition probes are `VERIFIED` (they read the rendered tree directly).
