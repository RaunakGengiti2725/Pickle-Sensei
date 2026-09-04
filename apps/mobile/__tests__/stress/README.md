# Stress harnesses

Seeded, replayable stress suites. Every iteration derives from
`STRESS_BASE_SEED + index` (default base `20260904`), so any failure is
reproducible from its seed alone.

| Env                | Default    | Meaning                                              |
| ------------------ | ---------- | ---------------------------------------------------- |
| `STRESS_ITER`      | `24`       | Number of seeded variants per suite (campaign size). |
| `STRESS_SEED`      | _(unset)_  | Replay exactly one seed (overrides `STRESS_ITER`).   |
| `STRESS_BASE_SEED` | `20260904` | First seed of the campaign.                          |

```bash
cd apps/mobile
npx jest --ci __tests__/stress/                                  # default, fast
STRESS_ITER=200 npx jest --ci __tests__/stress/resultScreen.boundaryI18nA11y.stress.test.tsx
STRESS_SEED=20260904 npx jest --ci __tests__/stress/resultScreen.boundaryI18nA11y.stress.test.tsx
```

Each run writes a seed → outcome JSON table plus rendered-tree evidence for
every `BROKEN` seed under `artifacts/stress/<unit>/` (gitignored).

## `resultScreen.boundaryI18nA11y.stress.test.tsx`

Renders `ResultScreen` inside a real `NavigationContainer` + native stack with
the real stores/hooks; only native modules (safe-area, svg) and the data/fetch
boundary (`useStrokeResultEvidence`, sync/outbox, kv, `fetch`) are mocked.
Dimensions per seed: result kind × Unicode text class × numeric profile ×
font scale (1/1.75/3) × width (320/375/430) × 12 locales × 8 time zones ×
DST clock instants. Checks: accessible role + label on every `Pressable`,
declared ≥44pt target (incl. hitSlop), progressbar label/value consistency,
leaked `undefined`/`NaN`/exponent text, Unicode integrity of injected copy,
real navigator route after Close/Try again/Done. Clipping/overlap are
reported as **proxy notes** (react-test-renderer runs no Yoga layout).
