# Static-health harness (apps/mobile)

Type-aware TypeScript AST scanner over `App.tsx` + `src/**` (production) and
optionally `__tests__/**`. Categories: TODO/FIXME/HACK markers, empty and
error-dropping catches, swallowed rejections, `as any` / double casts /
non-null assertions, `@ts-*` and `eslint-disable` directives, floating and
unguarded voided promises, `.then()` without rejection handling, timers /
subscriptions / effects without cleanup, unbounded and unbounded-await-poll
loops, dead exports and dead files (symbol-level, reachability from
`index.js` / `App.tsx`), constant conditions and platform / `__DEV__` flags.

All commands run from `apps/mobile` with npm/npx (never pnpm here).

```sh
# build the scanner (standalone tsconfig, emits to build/static-health)
npx tsc -p scripts/staticHealth/tsconfig.build.json

# full production scan + ratchet against the committed baseline
node build/static-health/scan.js --out ../../artifacts/static-health/run \
  --baseline scripts/staticHealth/baseline.json
# exit 1 when a fingerprint not in the baseline appears; ratchet-diff.json lists it

# include __tests__ in the scan
node build/static-health/scan.js --out ../../artifacts/static-health/tests --include-tests
```

Outputs per run: `static-health.json` (findings + counts + duration + heap/RSS

- tool versions), `static-health.md`, `baseline.json`, `fingerprints.txt`,
  and `ratchet-diff.json` when `--baseline` is given. Fingerprints are
  line-independent (`category|file|anchor`), with an ordinal suffix for
  repeated shapes in one file.

Jest suites (part of the default `npx jest` run):

- `__tests__/staticHealthScanners.test.ts` — each detector against canonical
  bad/good fixtures compiled with the real checker.
- `__tests__/staticHealthRatchet.test.ts` — the production scan must not add a
  fingerprint outside `baseline.json`. To accept a new finding on purpose,
  regenerate the baseline with the scan command above and copy
  `baseline.json` here.

Adversarial probes (NOT in the default suite; a failing probe is a finding):

```sh
npx jest --ci --rootDir . --testMatch '<rootDir>/scripts/staticHealth/probes/*.probe.ts'
```

- `probes/authHydrateDbFailure.probe.ts` — durable-session contract when the
  local SQLite database fails at launch (`authStore.hydrate()`).
