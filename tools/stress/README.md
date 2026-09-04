# Seeded long-run leak harness

Shared by the `test/stress/longRunLeak.stress.test.ts` suites of
`first-party-intake`, `hard-case-queue`, `incident-response`, `release-ops`,
`rollout` and `slo` (imported by relative path — this directory is
deliberately not a pnpm workspace member).

Each campaign invokes one unit N times in one process with forced GC, records a
heap/handle/timing checkpoint every 50 iterations, tracks superseded values via
`WeakRef` to prove they are collectable, and emits one row per iteration
(`seed → outcome/digest/durationMs`) so any iteration is replayable from its
seed. Same-seed determinism is asserted separately with `nondeterministicSeeds`.

Defaults are small (60 iterations) so the suites run in the normal `pnpm test`.
Full campaign (≥500 iterations, `--expose-gc`, JSON reports):

```sh
STRESS_ITER=500 STRESS_OUT=/tmp/stress NODE_OPTIONS=--expose-gc \
  pnpm --filter @pickle/<pkg> exec vitest run test/stress --pool=forks --poolOptions.forks.singleFork=true
```

Report fields: `heap.slopePctPer100` (least-squares heap slope, finding when
monotone and > 5 %/100 it), `handles.grown` (active-resource kinds or process
listeners that increased vs the post-warm-up baseline — the leak signal;
`handles.delta` also lists decreases from runner timers firing),
`timing.driftRatio` (last 50-iteration window mean ÷ first), `retained.*`
(objects from earlier iterations still alive after GC), `rows`, `failures`.

`knownGaps.probe.test.ts` files hold `it.fails` probes for behaviour the
stress models flagged as broken; when a gap is fixed the probe fails loudly and
must be flipped to a plain `it(...)`.
