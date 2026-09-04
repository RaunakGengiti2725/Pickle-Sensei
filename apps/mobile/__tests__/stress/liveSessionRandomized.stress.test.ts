/**
 * SEEDED RANDOMIZED LONG-RUN — Live Court session unit
 * (LiveSessionFlow + LiveSessionCoach + sessionScoreProgression +
 * liveSessionSummary).
 *
 * Every sequence is a seeded plan of 5–60 legal / near-legal actions over
 * the unit's public API (strokes, quiet stretches, pause gaps, duplicate and
 * late samples, malformed samples, out-of-order analysis settlement,
 * duplicate/stale/reversed snapshot replays, mute/voice toggles, faulty UI
 * subscribers, end / post-end pushes / coach end / dispose). The invariants
 * (documented in test-support/stress/liveSessionModel.ts) are checked after every
 * action; every failing seed is minimized with ddmin and recorded, and every
 * seed is run twice to confirm the trace is identical (determinism).
 *
 *   default:   npx jest --ci __tests__/stress/liveSessionRandomized.stress.test.ts
 *   campaign:  STRESS_ITER=2000 STRESS_OUT=/tmp/stress/live-court.json npx jest --ci ...
 *   replay:    STRESS_REPLAY_SEED=<seed> npx jest --ci ...
 *
 * A sequence stops at its FIRST violation, so a plan that trips a known
 * defect (test-support/stress/knownDefects.ts) early leaves its later actions
 * unexercised. STRESS_AVOID_KNOWN=1 strips the three known triggers from
 * every plan (fractional clock → LC-5, non-finite tMs → LC-1, coachStart
 * after coachEnd/dispose → LC-2) so the remaining invariants are checked to
 * full depth; in that mode ANY broken sequence fails the suite.
 */
import {
  campaignConfig,
  minimizeActions,
  subSeed,
  sumStats,
  writeReport,
  type SequenceOutcome,
} from '../../test-support/stress/seededStress';
import {
  failureLabel,
  generatePlan,
  runPlan,
  withActions,
  type Plan,
} from '../../test-support/stress/liveSessionModel';
import { summarizeBroken } from '../../test-support/stress/knownDefects';

declare const process: { env: Record<string, string | undefined> };

const config = campaignConfig(60);
const avoidKnown = process.env.STRESS_AVOID_KNOWN === '1';

const NON_FINITE_T = new Set(['nan_t', 'inf_t', 'neg_inf_t']);

/** Same seed, same plan minus the known-defect triggers (see header). */
function avoidKnownTriggers(plan: Plan): Plan {
  let terminated = false;
  const actions = plan.actions.flatMap(action => {
    if (action.kind === 'coachEnd' || action.kind === 'dispose')
      terminated = true;
    if (action.kind === 'coachStart' && terminated) return [];
    if (action.kind === 'malformed' && NON_FINITE_T.has(action.shape)) {
      return [{ kind: 'duplicateLast' as const }];
    }
    return [action];
  });
  return { ...plan, fractionalClock: false, actions };
}

function planFor(seed: number): Plan {
  const plan = generatePlan(seed);
  return avoidKnown ? avoidKnownTriggers(plan) : plan;
}

function prefixed(
  prefix: string,
  counts: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [`${prefix}${key}`, value]),
  );
}

async function runSeed(seed: number): Promise<SequenceOutcome> {
  const plan: Plan = planFor(seed);
  const first = await runPlan(plan);
  const second = await runPlan(plan);
  const label = failureLabel(first);
  let minimized: unknown[] | null = null;
  if (label !== null) {
    minimized = await minimizeActions(plan.actions, async candidate => {
      const result = await runPlan(withActions(plan, candidate));
      return failureLabel(result) === label;
    });
  }
  const nondeterministic =
    first.traceDigest !== second.traceDigest || failureLabel(second) !== label;
  return {
    seed,
    length: plan.actions.length,
    status: nondeterministic
      ? 'NONDETERMINISTIC'
      : label === null
        ? 'HELD'
        : 'BROKEN',
    failure: first.violation?.message ?? first.crash ?? null,
    invariant: first.violation?.invariant ?? (first.crash ? 'CRASH' : null),
    failingStep: first.failingStep,
    minimized,
    minimizedLength: minimized?.length ?? null,
    stats: first.stats,
    traceDigest: first.traceDigest,
  };
}

describe('Live Court session unit — seeded randomized long-run', () => {
  jest.setTimeout(30 * 60 * 1000);

  if (config.replaySeed !== null) {
    it(`replays seed ${config.replaySeed}`, async () => {
      const plan = planFor(config.replaySeed!);
      const outcome = await runSeed(config.replaySeed!);
      console.error(
        JSON.stringify(
          { plan, outcome: { ...outcome, minimized: outcome.minimized } },
          null,
          2,
        ),
      );
      expect(outcome.status).toBe('HELD');
    });
    return;
  }

  it(`holds every invariant across ${config.iterations} seeded sequences (base seed ${config.baseSeed})`, async () => {
    const outcomes: SequenceOutcome[] = [];
    for (let i = 0; i < config.iterations; i++) {
      outcomes.push(await runSeed(subSeed(config.baseSeed, i)));
    }
    const broken = outcomes.filter(outcome => outcome.status === 'BROKEN');
    const nondeterministic = outcomes.filter(
      outcome => outcome.status === 'NONDETERMINISTIC',
    );
    const { known, unexpected } = summarizeBroken(outcomes);
    writeReport(
      {
        suite: avoidKnown
          ? 'liveSessionRandomized.avoidKnown'
          : 'liveSessionRandomized',
        baseSeed: config.baseSeed,
        iterations: config.iterations,
        executed: outcomes.length,
        held: outcomes.length - broken.length - nondeterministic.length,
        broken: broken.length,
        nondeterministic: nondeterministic.length,
        totals: { ...sumStats(outcomes), ...prefixed('knownDefect.', known) },
        outcomes,
      },
      avoidKnown ? 'liveSession.avoidKnown' : 'liveSession',
    );
    const lengths = outcomes.map(outcome => outcome.length);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(60);
    if (!avoidKnown) expect(Math.min(...lengths)).toBeGreaterThanOrEqual(5);
    if (avoidKnown) expect(known).toEqual({});
    expect(
      nondeterministic.map(outcome => `seed ${outcome.seed}: trace differs`),
    ).toEqual([]);
    // Known defects (test-support/stress/knownDefects.ts) are pinned individually in
    // liveCourtKnownDefects.stress.test.ts; anything else breaking here is new.
    expect(
      unexpected.map(
        outcome =>
          `seed ${outcome.seed} [${outcome.invariant}] step ${outcome.failingStep} (minimized to ${outcome.minimizedLength} actions): ${outcome.failure}`,
      ),
    ).toEqual([]);
  });
});
