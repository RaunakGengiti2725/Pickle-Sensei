# Stress suites (`apps/mobile/__tests__/stress/`)

Failure-injection campaigns that render a REAL screen inside a real
`NavigationContainer` + native stack with the real Zustand stores, hooks and
consistency engine. Only native modules, SQLite (`src/data/db`) and `fetch`
are faked. Every iteration is derived from a seed and is replayable.

## StreakCalendarScreen — failure injection

```
cd apps/mobile
npx jest --ci __tests__/stress/streakCalendarScreen.failureInjection
```

- `STRESS_ITER=<n>` — number of randomized seeds on top of the fixed fault
  catalog (default 16; the reported campaign used 72 → 139 iterations).
- `STRESS_SEED=<seed>` — run exactly one randomized seed (skips the catalog),
  e.g. `STRESS_SEED=20027 npx jest --ci -t "seed 20027" __tests__/stress/streakCalendarScreen.failureInjection`.
- `STRESS_OUT=/abs/path.json` — write the seed → outcome table.
- Catalog entries are addressable with `-t`, e.g.
  `-t "kvRead/throw/throw/always"`.

Faults: `throw | reject | slow | timeout | never | malformed | partial` against
`sqlite.getDb | sqlite.shots | sqlite.kvRead | sqlite.kvWrite | clock.timeZone |
clock.systemTime | navigation | account | fetch | native.unrelated`, in phase
`first` (initial load), `always`, or `second` (a later refocus refresh).

Invariants per iteration: no render crash, no infinite spinner / no silent
stall after 60 s of fake time, a visible Back (and, for surfaced errors,
"Try again") control, no fake success (hero numbers must equal the
independently computed truth), no corrupted persisted ledger (valid drills
and celebrations survive, neighbour owners' keys untouched, no foreign-key
writes), `fetch` never called, unrelated native modules never touched.

A BROKEN iteration fails its test on purpose — the failure message carries the
seed, the fault and the exact invariant(s) that broke. Known BROKEN classes at
the time of writing (production behaviour, not harness defects):

1. A SQLite call that never settles jams `refreshQueue` for the process
   lifetime; the screen shows the empty "first analysis" hero forever, with no
   error card and no way to retry (`sqlite.*/never`).
2. A refresh that fails after a successful one sets `loadError` but the stale
   hero stays on screen with no error surface (`getDb|shots throw/reject`,
   phase `second`).
3. A failed ledger read (`getKv` throw/reject) is treated as an empty ledger;
   the next celebration write then persists that empty ledger, dropping every
   recorded drill and rewriting `celebrated` (`sqlite.kvRead throw|reject`).
