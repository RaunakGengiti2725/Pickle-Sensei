# boundary-malformed stress harness (pkg-ops-bundle)

Seeded, replayable boundary/malformed-input campaigns for the six ops packages:
`first-party-intake`, `hard-case-queue`, `incident-response`, `release-ops`,
`rollout`, `slo`. Each package owns a `test/boundaryMalformed.stress.test.ts`
that plugs its public APIs into the shared harness here (`harness.ts`,
`payloads.ts`, `rng.ts`). Not a workspace package: it is type-checked, linted
and executed through the package tests that import it.

## Running

The stress test is part of each package's normal `pnpm --filter <pkg> test`
run with a small default (`STRESS_ITER=60`) so the suite stays fast.

| Variable            | Effect                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `STRESS_ITER=<n>`   | iterations per package (campaign scale; `1000` × 6 packages = 6000)                          |
| `STRESS_SEED=<n>`   | campaign base seed (default `0x5eed0b0d`)                                                    |
| `STRESS_REPLAY=<n>` | run exactly the one iteration whose per-iteration seed is `<n>`                              |
| `STRESS_OUT=<dir>`  | where the JSON seed→outcome table is written (default `artifacts/stress/boundary-malformed`) |
| `STRESS_TRACE=1`    | print `seed / api / mutations` to stderr before each case runs                               |

```sh
STRESS_ITER=1000 pnpm --filter @pickle/rollout exec vitest run test/boundaryMalformed.stress.test.ts
STRESS_REPLAY=2124015592 pnpm --filter @pickle/hard-case-queue exec vitest run test/boundaryMalformed.stress.test.ts
```

## What a case does

1. `iterationSeed(baseSeed, i)` seeds an `Rng`; the RNG picks a stress case
   (API) and a category (`malformed-json`, `wrong-type`, `proto-pollution`,
   `numeric-edge`, `null-byte`, `huge-string`, `path-traversal`,
   `future-schema`, `empty`, `unicode-normalization`) and plans 1–3 mutations
   against the case's fixture (`payloads.ts`).
2. The package executor materialises the mutated fixture (as a value and, for
   byte boundaries, as corrupted JSON text) inside an isolated scratch
   directory and calls the API under `runGuarded`.
3. The outcome is classified: `accepted`, `rejected-typed` (package error
   class), `rejected-error` (plain `Error` with an explicit message),
   `rejected-io` (fs error code), `crash-native` (TypeError/RangeError/… escaped),
   `returned-invalid` (the executor's invariant checks failed). Extra invariants
   are recorded as `violations`: writes on the rejected path, input mutation,
   own `__proto__`/`constructor`/`prototype` keys persisted, non-finite numbers
   emitted, oversized error messages, global prototype pollution, in-memory vs
   durable divergence.
4. Every case runs twice; a differing classification is `replayConsistent=false`.
5. Every failure is minimized (greedy mutation subset) and grouped; groups are
   matched against the package's `KNOWN_GAPS` (reproduced, documented behaviour
   with a `finding` string). Any unmatched group fails the test.

The JSON report (`<STRESS_OUT>/<pkg>.json`) carries `summary`, `knownGaps`
(hits per id), `failureGroups` (example seed, minimized mutations, detail) and
`rows` (one per iteration: seed, api, category, outcome, violations,
replayConsistent, shapeViolation, knownGap).

## Surfaces

`boundary` cases feed bytes / parsed JSON / persisted records into the API, so
every mutation is a legitimate input. `typed` cases call TypeScript-typed
in-process APIs; a failure whose minimized repro breaks the runtime _shape_ of
the argument (wrong primitive kind, deleted field) is folded into one
`*-TYPED-NO-GUARDS` gap per package, while shape-correct hostile values (NaN in
a number, unknown enum string, 64 KiB string, extra own `__proto__` key) stay
individually visible.
