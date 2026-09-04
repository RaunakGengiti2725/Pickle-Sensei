import {
  CONFUSION_THRESHOLDS_V1,
  createUsabilityFunnelRecorder,
  deriveConfusionEvents,
  summarizeUsabilityFunnel,
  usabilityFunnel,
  type ConfusionEvent,
  type UsabilityFunnelEvent,
  type UsabilityFunnelRecorder,
  type UsabilityFunnelStep,
} from '../../src/analysis/usabilityTelemetry';
import {
  pick,
  randomInt,
  recordScenario,
  runBurst,
  sameJson,
  scenarioSeeds,
  seededRandom,
  shuffle,
  skewedClock,
  type Actor,
  type Random,
  type Scheduler,
} from '../../testing/stress/telemetryConcurrency';

/**
 * mod-telemetry / usabilityTelemetry — CONCURRENCY lens.
 *
 * Two "screens" (Analyze mount + intent picker, guided camera flow,
 * abandon path, TRY AGAIN re-arm, summary readers, resets) log into ONE
 * recorder under a seeded cooperative scheduler while an oracle log is
 * appended synchronously beside every `log`. Invariants: the recorded
 * stream equals the oracle exactly (no lost / duplicated / reordered rows,
 * `tMs` consumed from the clock once per row, `detail` present iff passed),
 * `summary()`/`deriveConfusionEvents()` are pure and idempotent under
 * concurrent readers, hostile clocks (throwing, re-entrant) never break the
 * caller and drop exactly the row whose reading threw, and skewed clocks
 * never make derivation throw or emit signals outside the event set.
 * Replay: `STRESS_SEED=<seed> npx jest --ci <this file>`.
 */

const SUITE = 'telemetryUsabilityConcurrency';
const WALL_BUDGET_MS = 5_000;
const READINESS = [
  'searching',
  'adjust',
  'ready',
  'too_close',
  'lost',
] as const;
const ERRORS = [
  'Could not read the clip.',
  'Analysis unavailable.',
  'Network timeout.',
] as const;

type ActorKind =
  | 'mount_and_pick'
  | 'camera_flow'
  | 'abandon'
  | 'try_again'
  | 'summary_reader'
  | 'reset';

const ACTOR_KINDS: readonly ActorKind[] = [
  'mount_and_pick',
  'camera_flow',
  'camera_flow',
  'abandon',
  'try_again',
  'summary_reader',
];

function counterClock(): { now: () => number; readings: number } {
  const clock = {
    readings: 0,
    now: () => {
      clock.readings += 1;
      return clock.readings * 10;
    },
  };
  return clock;
}

interface Oracle {
  expected: UsabilityFunnelEvent[];
  violations: string[];
}

function logMirrored(
  recorder: UsabilityFunnelRecorder,
  clock: { readings: number },
  oracle: Oracle,
  step: UsabilityFunnelStep,
  detail?: string,
): void {
  const tMs = (clock.readings + 1) * 10;
  recorder.log(step, detail);
  oracle.expected.push(
    detail === undefined ? { step, tMs } : { step, tMs, detail },
  );
}

function buildActor(
  kind: ActorKind,
  random: Random,
  recorder: UsabilityFunnelRecorder,
  clock: { readings: number },
  oracle: Oracle,
  plan: Record<string, unknown>[],
): Actor {
  const steps = randomInt(random, 1, 4);
  switch (kind) {
    case 'mount_and_pick': {
      const picks = randomInt(random, 0, 5);
      plan.push({ kind, steps, picks });
      return async (sched: Scheduler) => {
        logMirrored(recorder, clock, oracle, 'analyze_opened');
        for (let i = 0; i < picks; i += 1) {
          for (let s = 0; s < steps; s += 1) await sched.yield();
          logMirrored(
            recorder,
            clock,
            oracle,
            'intent_selected',
            pick(random, ['auto', 'drive', 'dink']),
          );
        }
      };
    }
    case 'camera_flow': {
      const readiness = randomInt(random, 0, 12);
      const errors = randomInt(random, 0, 3);
      const errorText = pick(random, ERRORS);
      const outcome = pick(random, [
        'result_opened',
        'intent_outcome_shown',
        'error',
      ] as const);
      plan.push({ kind, steps, readiness, errors, outcome });
      return async (sched: Scheduler) => {
        logMirrored(recorder, clock, oracle, 'camera_opened');
        for (let i = 0; i < readiness; i += 1) {
          await sched.yield();
          logMirrored(
            recorder,
            clock,
            oracle,
            'readiness_state',
            pick(random, READINESS),
          );
        }
        await sched.yield();
        logMirrored(recorder, clock, oracle, 'ready');
        for (let s = 0; s < steps; s += 1) await sched.yield();
        logMirrored(recorder, clock, oracle, 'stroke_captured');
        logMirrored(recorder, clock, oracle, 'capture_saved', 'locked');
        await sched.yield();
        logMirrored(recorder, clock, oracle, 'analysis_started');
        await sched.yield();
        if (outcome === 'error') {
          for (let i = 0; i < Math.max(1, errors); i += 1) {
            logMirrored(recorder, clock, oracle, 'error_shown', errorText);
            await sched.yield();
          }
        } else {
          logMirrored(recorder, clock, oracle, outcome);
        }
      };
    }
    case 'abandon': {
      const readiness = randomInt(random, 0, 6);
      plan.push({ kind, steps, readiness });
      return async (sched: Scheduler) => {
        logMirrored(recorder, clock, oracle, 'camera_opened');
        for (let i = 0; i < readiness; i += 1) {
          await sched.yield();
          logMirrored(
            recorder,
            clock,
            oracle,
            'readiness_state',
            pick(random, READINESS),
          );
        }
        for (let s = 0; s < steps; s += 1) await sched.yield();
        logMirrored(recorder, clock, oracle, 'attempt_abandoned');
      };
    }
    case 'try_again': {
      plan.push({ kind, steps });
      return async (sched: Scheduler) => {
        for (let s = 0; s < steps; s += 1) await sched.yield();
        // Duplicate call: a re-arm surfaced twice is two observations.
        logMirrored(recorder, clock, oracle, 'try_again_rearm');
        logMirrored(recorder, clock, oracle, 'try_again_rearm');
      };
    }
    case 'summary_reader': {
      plan.push({ kind, steps });
      return async (sched: Scheduler) => {
        for (let s = 0; s < steps; s += 1) {
          await sched.yield();
          const snapshot = [...recorder.events()];
          const before = JSON.stringify(snapshot);
          const summary = recorder.summary();
          const again = recorder.summary();
          const derived = deriveConfusionEvents(snapshot);
          if (!sameJson(summary, again)) {
            oracle.violations.push('summary() not idempotent');
          }
          if (!sameJson(summary, summarizeUsabilityFunnel(snapshot))) {
            oracle.violations.push(
              'summary() differs from summarizing the events() snapshot',
            );
          }
          if (!sameJson(summary.confusionEvents, derived)) {
            oracle.violations.push(
              'summary().confusionEvents differs from deriveConfusionEvents(snapshot)',
            );
          }
          if (JSON.stringify(snapshot) !== before) {
            oracle.violations.push('deriveConfusionEvents mutated its input');
          }
          if (!sameJson(snapshot, oracle.expected)) {
            oracle.violations.push(
              `mid-flight events() (${snapshot.length}) differ from oracle (${oracle.expected.length})`,
            );
          }
        }
      };
    }
    case 'reset': {
      plan.push({ kind, steps });
      return async (sched: Scheduler) => {
        for (let s = 0; s < steps; s += 1) await sched.yield();
        recorder.reset();
        oracle.expected = [];
      };
    }
  }
}

function assertDerivationInvariants(
  events: readonly UsabilityFunnelEvent[],
  confusion: readonly ConfusionEvent[],
): void {
  const tMsSet = new Set(events.map(e => e.tMs));
  const count = (kind: ConfusionEvent['kind']) =>
    confusion.filter(c => c.kind === kind).length;
  for (let i = 1; i < confusion.length; i += 1) {
    expect(confusion[i]!.tMs).toBeGreaterThanOrEqual(confusion[i - 1]!.tMs);
  }
  for (const c of confusion) expect(tMsSet.has(c.tMs)).toBe(true);
  expect(count('intent_reselection_churn')).toBeLessThanOrEqual(1);
  expect(count('pre_ready_dwell_exceeded')).toBeLessThanOrEqual(1);
  expect(count('readiness_oscillation')).toBeLessThanOrEqual(1);
  expect(count('repeated_error')).toBeLessThanOrEqual(
    Math.floor(
      events.filter(e => e.step === 'error_shown').length /
        CONFUSION_THRESHOLDS_V1.repeatedErrorMin,
    ),
  );
  expect(count('abandoned_before_capture')).toBeLessThanOrEqual(
    events.filter(e => e.step === 'attempt_abandoned').length,
  );
}

describe('usabilityTelemetry — seeded interleaving bursts (two screens, one recorder)', () => {
  const scenario = 'burst/stream-conservation';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: stream == oracle, summary pure, bounded wall time`, async () => {
      const random = seededRandom(seed);
      const actorCount = randomInt(random, 3, 16);
      const withReset = random() < 0.25;
      const kinds: ActorKind[] = [];
      for (let i = 0; i < actorCount; i += 1)
        kinds.push(pick(random, ACTOR_KINDS));
      if (withReset) kinds.push('reset');
      const plan: Record<string, unknown>[] = [];
      await recordScenario(
        SUITE,
        scenario,
        seed,
        { actorCount, withReset, kinds, plan },
        async () => {
          const clock = counterClock();
          const recorder = createUsabilityFunnelRecorder(clock.now);
          const oracle: Oracle = { expected: [], violations: [] };
          const actors = kinds.map(kind =>
            buildActor(kind, random, recorder, clock, oracle, plan),
          );
          const { elapsedMs, steps } = await runBurst(
            random,
            actors,
            WALL_BUDGET_MS,
          );
          const events = recorder.events();
          expect(oracle.violations).toEqual([]);
          expect(events).toEqual(oracle.expected);
          expect(new Set(events).size).toBe(events.length);
          const t = events.map(e => e.tMs);
          expect([...t].sort((a, b) => a - b)).toEqual(t);
          expect(new Set(t).size).toBe(t.length);
          for (const e of events) {
            expect('detail' in e ? typeof e.detail === 'string' : true).toBe(
              true,
            );
          }
          const summary = recorder.summary();
          expect(summary).toEqual(summarizeUsabilityFunnel(oracle.expected));
          assertDerivationInvariants(events, summary.confusionEvents);
          expect(elapsedMs).toBeLessThan(WALL_BUDGET_MS);
          return {
            events: events.length,
            steps,
            elapsedMs,
            clockReadings: clock.readings,
            confusion: summary.confusionEvents.map(c => c.kind),
          };
        },
      );
    });
  }
});

describe('usabilityTelemetry — hostile clocks', () => {
  const scenario = 'clock/usability-throwing-and-reentrant';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: log never throws; drops exactly the readings that threw; reentrancy terminates`, async () => {
      const random = seededRandom(seed);
      const total = randomInt(random, 20, 120);
      const throwRate = random() * 0.5;
      const reenterRate = random() * 0.2;
      const outcomes: ('ok' | 'throw' | 'reenter')[] = [];
      for (let i = 0; i < total; i += 1) {
        const roll = random();
        outcomes.push(
          roll < throwRate
            ? 'throw'
            : roll < throwRate + reenterRate
              ? 'reenter'
              : 'ok',
        );
      }
      await recordScenario(
        SUITE,
        scenario,
        seed,
        { total, throwRate, reenterRate, outcomes },
        async () => {
          let call = 0;
          let depth = 0;
          let maxDepth = 0;
          let recorderRef: UsabilityFunnelRecorder | null = null;
          const now = (): number => {
            const outcome = outcomes[call] ?? 'ok';
            call += 1;
            const myCall = call;
            depth += 1;
            maxDepth = Math.max(maxDepth, depth);
            try {
              if (outcome === 'throw') throw new Error('clock unavailable');
              if (outcome === 'reenter' && depth < 3 && recorderRef) {
                recorderRef.log('error_shown', 'clock re-entry');
              }
              return myCall;
            } finally {
              depth -= 1;
            }
          };
          const recorder = createUsabilityFunnelRecorder(now);
          recorderRef = recorder;
          let threw = 0;
          const actors: Actor[] = [];
          for (let i = 0; i < total; i += 1) {
            actors.push(async sched => {
              await sched.yield();
              try {
                recorder.log('readiness_state', 'searching');
                recorder.summary();
                recorder.events();
              } catch {
                threw += 1;
              }
            });
          }
          const { elapsedMs } = await runBurst(random, actors, WALL_BUDGET_MS);
          expect(threw).toBe(0);
          const events = recorder.events();
          const expected: string[] = [];
          let simCall = 0;
          const simulate = (step: string, depth2: number): void => {
            const outcome = outcomes[simCall] ?? 'ok';
            simCall += 1;
            const tMs = simCall;
            if (outcome === 'throw') return;
            if (outcome === 'reenter' && depth2 < 3)
              simulate('error_shown', depth2 + 1);
            expected.push(`${step}@${tMs}`);
          };
          for (let i = 0; i < total; i += 1) simulate('readiness_state', 1);
          expect(events.map(e => `${e.step}@${e.tMs}`)).toEqual(expected);
          expect(call).toBe(simCall);
          expect(maxDepth).toBeLessThanOrEqual(3);
          expect(elapsedMs).toBeLessThan(WALL_BUDGET_MS);
          return {
            events: events.length,
            reentered: events.filter(e => e.step === 'error_shown').length,
            maxDepth,
            clockCalls: call,
          };
        },
      );
    });
  }
});

describe('usabilityTelemetry — skewed clocks and derivation purity', () => {
  const scenario = 'clock/skew-derivation';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: derivation is total, pure, idempotent and sorted under non-monotonic tMs`, async () => {
      const random = seededRandom(seed);
      const n = randomInt(random, 0, 150);
      const stepsPlan: UsabilityFunnelStep[] = [];
      const allSteps: readonly UsabilityFunnelStep[] = [
        'analyze_opened',
        'intent_selected',
        'camera_opened',
        'readiness_state',
        'ready',
        'stroke_captured',
        'capture_saved',
        'analysis_started',
        'intent_outcome_shown',
        'result_opened',
        'free_limit_prompt_shown',
        'error_shown',
        'attempt_abandoned',
        'try_again_rearm',
      ];
      for (let i = 0; i < n; i += 1) stepsPlan.push(pick(random, allSteps));
      await recordScenario(
        SUITE,
        scenario,
        seed,
        { n, stepsPlan },
        async () => {
          const clock = skewedClock(
            random,
            randomInt(random, 0, 2_000_000_000),
          );
          const recorder = createUsabilityFunnelRecorder(clock.now);
          for (const step of stepsPlan) {
            if (step === 'readiness_state')
              recorder.log(step, pick(random, READINESS));
            else if (step === 'error_shown')
              recorder.log(step, pick(random, ERRORS));
            else recorder.log(step);
          }
          const events = recorder.events();
          expect(events.map(e => e.tMs)).toEqual(clock.readings);
          const before = JSON.stringify(events);
          const first = deriveConfusionEvents(events);
          const second = deriveConfusionEvents(events);
          expect(second).toEqual(first);
          expect(JSON.stringify(events)).toBe(before);
          assertDerivationInvariants(events, first);
          // Funnel completion flags are set-membership: order/time free.
          const summary = recorder.summary();
          const { confusionEvents: _c1, ...flags } = summary;
          const { confusionEvents: _c2, ...shuffledFlags } =
            summarizeUsabilityFunnel(shuffle(random, events));
          expect(shuffledFlags).toEqual(flags);
          const backwardSteps = clock.readings.filter(
            (t, i) => i > 0 && t < clock.readings[i - 1]!,
          ).length;
          return { n, backwardSteps, confusion: first.map(c => c.kind) };
        },
      );
    });
  }
});

describe('usabilityFunnel singleton — two screens logging concurrently', () => {
  const scenario = 'singleton/two-screens';
  beforeEach(() => usabilityFunnel.reset());
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: the shared recorder loses nothing across interleaved screens`, async () => {
      const random = seededRandom(seed);
      const screens = randomInt(random, 2, 6);
      const perScreen = randomInt(random, 1, 20);
      await recordScenario(
        SUITE,
        scenario,
        seed,
        { screens, perScreen },
        async () => {
          const expectedSteps: string[] = [];
          const actors: Actor[] = [];
          for (let s = 0; s < screens; s += 1) {
            actors.push(async sched => {
              for (let i = 0; i < perScreen; i += 1) {
                await sched.yield();
                const step: UsabilityFunnelStep =
                  i === 0 ? 'analyze_opened' : 'readiness_state';
                const detail = i === 0 ? undefined : `screen-${s}`;
                usabilityFunnel.log(step, detail);
                expectedSteps.push(`${step}:${detail ?? ''}`);
              }
            });
          }
          const { elapsedMs } = await runBurst(random, actors, WALL_BUDGET_MS);
          const events = usabilityFunnel.events();
          expect(events.map(e => `${e.step}:${e.detail ?? ''}`)).toEqual(
            expectedSteps,
          );
          for (let i = 1; i < events.length; i += 1) {
            expect(events[i]!.tMs).toBeGreaterThanOrEqual(events[i - 1]!.tMs);
          }
          expect(elapsedMs).toBeLessThan(WALL_BUDGET_MS);
          return { events: events.length, elapsedMs };
        },
      );
    });
  }
});
