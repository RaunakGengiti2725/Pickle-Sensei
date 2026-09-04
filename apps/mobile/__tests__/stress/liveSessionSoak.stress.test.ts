/**
 * LONG-RUN SOAK — one LiveSessionFlow + LiveSessionCoach driven through
 * STRESS_SOAK_EVENTS stroke events in a single session (seeded, replayable), with the full
 * invariant sweep of test-support/stress/liveSessionModel.ts every `checkEvery` steps and
 * on the final step, plus the same-seed determinism check.
 *
 *   npx jest --ci __tests__/stress/liveSessionSoak.stress.test.ts   # 60 events
 *   STRESS_SOAK_EVENTS=1000 STRESS_OUT=/tmp/stress/soak.json \
 *   npx jest --ci __tests__/stress/liveSessionSoak.stress.test.ts   # campaign
 *
 * The small default is forced by LC-6 (test-support/stress/knownDefects.ts): the
 * production engine re-proposes over the whole sample series on every push,
 * so wall-clock grows quadratically with session length. Throughput is
 * RECORDED in the report (not asserted here — the bound is pinned in
 * liveCourtKnownDefects.stress.test.ts).
 */
import {
  SeededRng,
  campaignConfig,
  subSeed,
  writeReport,
} from '../../test-support/stress/seededStress';
import {
  failureLabel,
  generatePlan,
  runPlan,
  type Action,
  type Plan,
} from '../../test-support/stress/liveSessionModel';
import { knownDefectFor } from '../../test-support/stress/knownDefects';

declare const process: { env: Record<string, string | undefined> };

function soakEvents(): number {
  const raw = process.env.STRESS_SOAK_EVENTS;
  if (raw === undefined || raw === '') return 60;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `STRESS_SOAK_EVENTS must be a positive integer, got ${raw}`,
    );
  }
  return value;
}

/** Legal-only, integer-clock action stream with exactly `events` strokes,
 * each followed by a quiet valley so the proposer sees distinct events. */
function soakPlan(seed: number, events: number): Plan {
  const base = generatePlan(seed);
  const rng = new SeededRng(subSeed(seed, 'soak'));
  const actions: Action[] = [];
  let strokes = 0;
  while (strokes < events) {
    const kind = rng.weighted({
      stroke: 60,
      resolve: 22,
      resolveAll: 4,
      quiet: 6,
      duplicateLast: 4,
      lateSample: 3,
      replaySnapshot: 1,
    });
    switch (kind) {
      case 'stroke':
        strokes += 1;
        actions.push({
          kind,
          // ≥ 0.3 × the largest possible peak: the proposer's
          // minPeakFractionOfMax gate would otherwise drop smaller strokes.
          peak: Number(rng.float(2, 6).toFixed(3)),
          riseMs: rng.int(60, 250),
          fallMs: rng.int(250, 700),
        });
        actions.push({
          kind: 'quiet',
          ms: rng.int(700, 1200),
          level: Number(rng.float(0.02, 0.08).toFixed(3)),
        });
        break;
      case 'resolve':
        actions.push({
          kind,
          which: rng.pick(['oldest', 'newest', 'random'] as const),
          pick: rng.int(0, 1_000_000),
        });
        break;
      case 'quiet':
        actions.push({
          kind,
          ms: rng.int(100, 900),
          level: Number(rng.float(0.02, 0.2).toFixed(3)),
        });
        break;
      case 'lateSample':
        actions.push({
          kind,
          backMs: rng.int(1, 5000),
          v: Number(rng.float(0, 4).toFixed(3)),
        });
        break;
      case 'replaySnapshot':
        actions.push({ kind, which: rng.pick(['stale', 'current'] as const) });
        break;
      default:
        actions.push({ kind });
    }
  }
  return {
    ...base,
    source: 'live',
    providerMode: 'available',
    clipMode: 'scripted',
    mutedInitially: false,
    voiceInitially: true,
    allowMalformed: false,
    fractionalClock: false,
    checkEvery: Math.max(1, Math.floor(actions.length / 40)),
    actions,
  };
}

const config = campaignConfig(1);
const events = soakEvents();

/** Two runs (determinism) of a quadratic-cost workload: measured ~17 min per
 * run at 600 events on a CI-class core. Budget = max(10 min, 4 × the
 * quadratic extrapolation from that point) so a larger STRESS_SOAK_EVENTS
 * does not fail on the clock before the invariants get their verdict. */
function soakTimeoutMs(targetEvents: number): number {
  const measuredRunMs = 17 * 60 * 1000;
  const perRun = measuredRunMs * (targetEvents / 600) ** 2;
  return Math.ceil(Math.max(10 * 60 * 1000, 4 * perRun));
}

describe('Live Court session unit — single-session long-run soak', () => {
  jest.setTimeout(soakTimeoutMs(events));

  it(`survives ${events} stroke events in one session with every invariant intact (seed ${config.baseSeed})`, async () => {
    const seed = subSeed(config.baseSeed, 'soak');
    const plan = soakPlan(seed, events);
    const startedAt = Date.now();
    const first = await runPlan(plan);
    const firstMs = Date.now() - startedAt;
    const second = await runPlan(plan);
    const label = failureLabel(first);
    const outcome = {
      seed,
      length: plan.actions.length,
      status:
        first.traceDigest !== second.traceDigest ||
        failureLabel(second) !== label
          ? ('NONDETERMINISTIC' as const)
          : label === null
            ? ('HELD' as const)
            : ('BROKEN' as const),
      failure: first.violation?.message ?? first.crash ?? null,
      invariant: first.violation?.invariant ?? (first.crash ? 'CRASH' : null),
      failingStep: first.failingStep,
      minimized: null,
      minimizedLength: null,
      stats: first.stats,
      traceDigest: first.traceDigest,
    };
    writeReport(
      {
        suite: 'liveSessionSoak',
        baseSeed: config.baseSeed,
        iterations: 1,
        executed: 1,
        held: outcome.status === 'HELD' ? 1 : 0,
        broken: outcome.status === 'BROKEN' ? 1 : 0,
        nondeterministic: outcome.status === 'NONDETERMINISTIC' ? 1 : 0,
        totals: {
          ...first.stats,
          targetEvents: events,
          wallClockMs: firstMs,
          msPer1000Events: Math.round(
            (firstMs / Math.max(1, first.stats.events ?? 1)) * 1000,
          ),
          checkEvery: plan.checkEvery ?? 1,
        },
        outcomes: [outcome],
      },
      'liveSessionSoak',
    );
    expect(outcome.status).not.toBe('NONDETERMINISTIC');
    expect(
      outcome.status === 'BROKEN'
        ? `[${outcome.invariant}] step ${outcome.failingStep}${knownDefectFor(outcome) ? ` (known ${knownDefectFor(outcome)!.id})` : ''}: ${outcome.failure}`
        : null,
    ).toBeNull();
    expect(first.stats.events).toBeGreaterThanOrEqual(events);
  });
});
