import {
  aggregateStabilitySlo,
  type StabilitySloEvent,
} from '@pickle/shared-types';
import {
  UNASSIGNED_STABILITY_USER_KEY,
  createStabilityRecorder,
  recordPreviousRunOutcome,
  stabilitySlo,
  type PreviousRunMarker,
  type StabilityContext,
  type StabilityEventInput,
  type StabilityRecorder,
} from '../../src/analysis/stabilityTelemetry';
import {
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import { startSessionCapture } from '../../src/camera/capture';
import {
  pick,
  pseudoUuid,
  randomInt,
  recordScenario,
  runBurst,
  sameJson,
  scenarioSeeds,
  seededRandom,
  shuffle,
  type Actor,
  type Random,
  type Scheduler,
} from '../../testing/stress/telemetryConcurrency';

/**
 * mod-telemetry / stabilityTelemetry — CONCURRENCY lens.
 *
 * Bursts of interleaved actors (analysis runs, camera startups, TRY AGAIN
 * consumers, context rotations / sign-outs mid-run, previous-run crash
 * attribution, mid-flight metric readers, duplicate and mutated inputs,
 * resets) drive one recorder under a seeded cooperative scheduler. An
 * oracle log is appended synchronously beside every `record` call, so the
 * recorder's stream must equal the oracle EXACTLY: no lost update, no
 * duplicate row, no reordering, every event stamped with the context that
 * was current at the moment it was recorded, attributed events never
 * contaminated by (or contaminating) the live context, metrics always the
 * pure aggregation of the stream, and every burst settling inside a bounded
 * wall time. Replay: `STRESS_SEED=<seed> npx jest --ci <this file>`.
 */

const SUITE = 'telemetryStabilityConcurrency';
const WALL_BUDGET_MS = 5_000;

type ActorKind =
  | 'analysis'
  | 'cancelled_analysis'
  | 'camera'
  | 'rotation'
  | 'signout'
  | 'previous_run'
  | 'attributed'
  | 'duplicate_input'
  | 'metrics_reader'
  | 'reset';

const ACTOR_KINDS: readonly ActorKind[] = [
  'analysis',
  'analysis',
  'cancelled_analysis',
  'camera',
  'rotation',
  'signout',
  'previous_run',
  'attributed',
  'duplicate_input',
  'metrics_reader',
];

const CAUSES = ['unavailable', 'paywall_required', 'exception'] as const;

/** Counter clock: every reading is unique and predictable, so the oracle
 * can stamp `at` exactly as the recorder will. */
function counterClock(): { nowIso: () => string; readings: number } {
  let n = 0;
  const clock = {
    readings: 0,
    nowIso: () => {
      n += 1;
      clock.readings = n;
      return `T${n}`;
    },
  };
  return clock;
}

interface Oracle {
  expected: StabilitySloEvent[];
  context: StabilityContext;
  violations: string[];
}

/** Mirror of `recorder.record` — records AND appends the oracle row with
 * the context the oracle believes is current and the clock reading the
 * recorder is about to consume. */
function recordMirrored(
  recorder: StabilityRecorder,
  clock: { readings: number },
  oracle: Oracle,
  input: StabilityEventInput,
): void {
  const at = `T${clock.readings + 1}`;
  recorder.record(input);
  oracle.expected.push({
    ...input,
    userKey: oracle.context.userKey,
    sessionKey: oracle.context.sessionKey,
    at,
  } as StabilitySloEvent);
}

function recordAttributedMirrored(
  recorder: StabilityRecorder,
  clock: { readings: number },
  oracle: Oracle,
  input: StabilityEventInput,
  attribution: StabilityContext,
): void {
  const at = `T${clock.readings + 1}`;
  recorder.recordAttributed(input, attribution);
  oracle.expected.push({
    ...input,
    userKey: attribution.userKey,
    sessionKey: attribution.sessionKey,
    at,
  } as StabilitySloEvent);
}

function buildActor(
  kind: ActorKind,
  random: Random,
  recorder: StabilityRecorder,
  clock: { readings: number },
  oracle: Oracle,
  plan: Record<string, unknown>[],
): Actor {
  const steps = randomInt(random, 1, 4);
  switch (kind) {
    case 'analysis': {
      const outcome = pick(random, ['completed', 'failed'] as const);
      const cause = pick(random, CAUSES);
      plan.push({ kind, steps, outcome, cause });
      return async (sched: Scheduler) => {
        recordMirrored(recorder, clock, oracle, { kind: 'analysis_started' });
        for (let i = 0; i < steps; i += 1) await sched.yield();
        recordMirrored(
          recorder,
          clock,
          oracle,
          outcome === 'completed'
            ? { kind: 'analysis_completed' }
            : { kind: 'analysis_failed', failureKind: cause },
        );
      };
    }
    case 'cancelled_analysis': {
      plan.push({ kind, steps });
      return async (sched: Scheduler) => {
        recordMirrored(recorder, clock, oracle, { kind: 'analysis_started' });
        for (let i = 0; i < steps; i += 1) await sched.yield();
        // Cancelled mid-flight: nothing else is ever recorded for it.
      };
    }
    case 'camera': {
      const ok = random() < 0.6;
      plan.push({ kind, steps, ok });
      return async (sched: Scheduler) => {
        for (let i = 0; i < steps; i += 1) await sched.yield();
        recordMirrored(
          recorder,
          clock,
          oracle,
          ok
            ? { kind: 'camera_startup_succeeded' }
            : { kind: 'camera_startup_failed', reason: 'guided_capture_error' },
        );
      };
    }
    case 'rotation': {
      const userKey = pseudoUuid(random);
      const sessionKey = pseudoUuid(random);
      plan.push({ kind, steps, userKey, sessionKey });
      return async (sched: Scheduler) => {
        for (let i = 0; i < steps; i += 1) await sched.yield();
        const next = { userKey, sessionKey };
        recorder.setContext(next);
        oracle.context = next;
        // The caller mutating its own object afterwards must not rewrite
        // history; it MAY affect future stamps (documented reference
        // semantics) so the oracle mirrors the same object.
      };
    }
    case 'signout': {
      plan.push({ kind, steps });
      return async (sched: Scheduler) => {
        for (let i = 0; i < steps; i += 1) await sched.yield();
        const next = {
          userKey: UNASSIGNED_STABILITY_USER_KEY,
          sessionKey: oracle.context.sessionKey,
        };
        recorder.setContext(next);
        oracle.context = next;
      };
    }
    case 'previous_run': {
      const previousUserKey = pseudoUuid(random);
      const marker: PreviousRunMarker = {
        sessionKey: random() < 0.8 ? pseudoUuid(random) : null,
        endedClean: random() < 0.3,
        memoryWarningSeen: random() < 0.5,
        crashFingerprint:
          random() < 0.5 ? `fp-${randomInt(random, 1, 9)}` : null,
      };
      plan.push({ kind, steps, previousUserKey, marker });
      return async (sched: Scheduler) => {
        for (let i = 0; i < steps; i += 1) await sched.yield();
        const contextBefore = oracle.context;
        const at = `T${clock.readings + 1}`;
        const classification = recordPreviousRunOutcome(
          recorder,
          previousUserKey,
          marker,
        );
        const attribution = {
          userKey: previousUserKey,
          sessionKey: marker.sessionKey,
        };
        if (classification === 'crash' && marker.crashFingerprint !== null) {
          oracle.expected.push({
            kind: 'crash',
            fatal: true,
            fingerprint: marker.crashFingerprint,
            ...attribution,
            at,
          });
        } else if (classification === 'memory_pressure_termination') {
          oracle.expected.push({
            kind: 'memory_pressure_termination',
            ...attribution,
            at,
          });
        }
        // Attribution must never leak into the live context.
        await sched.yield();
        recordMirrored(recorder, clock, oracle, { kind: 'session_started' });
        if (oracle.context !== contextBefore) return; // a rotation ran meanwhile
        const last = recorder.events()[recorder.events().length - 1];
        if (
          last &&
          (last.userKey !== contextBefore.userKey ||
            last.sessionKey !== contextBefore.sessionKey)
        ) {
          oracle.violations.push(
            `previous-run attribution leaked into live context: ${JSON.stringify(last)}`,
          );
        }
      };
    }
    case 'attributed': {
      const attribution = {
        userKey: pseudoUuid(random),
        sessionKey: random() < 0.7 ? pseudoUuid(random) : null,
      };
      plan.push({ kind, steps, attribution });
      return async (sched: Scheduler) => {
        // Explicit attribution racing live rotations: the row must carry
        // the attribution, the next live record must carry the live
        // context, whatever interleaves between them.
        recordAttributedMirrored(
          recorder,
          clock,
          oracle,
          { kind: 'crash', fatal: false, fingerprint: 'attributed' },
          attribution,
        );
        for (let i = 0; i < steps; i += 1) await sched.yield();
        recordMirrored(recorder, clock, oracle, { kind: 'analysis_started' });
        recordAttributedMirrored(
          recorder,
          clock,
          oracle,
          { kind: 'memory_pressure_termination' },
          attribution,
        );
      };
    }
    case 'duplicate_input': {
      const reason = `reason-${randomInt(random, 1, 5)}`;
      plan.push({ kind, steps, reason });
      return async (sched: Scheduler) => {
        const input: { kind: 'try_again_failed'; reason: string } = {
          kind: 'try_again_failed',
          reason,
        };
        recordMirrored(recorder, clock, oracle, input);
        for (let i = 0; i < steps; i += 1) await sched.yield();
        // Same object recorded again = a second observation (a stream, not
        // an idempotent upsert) — then mutated: stored rows must not move.
        recordMirrored(recorder, clock, oracle, input);
        input.reason = 'mutated-after-record';
      };
    }
    case 'metrics_reader': {
      plan.push({ kind, steps });
      return async (sched: Scheduler) => {
        for (let i = 0; i < steps; i += 1) {
          await sched.yield();
          const snapshot = [...recorder.events()];
          const metrics = recorder.metrics();
          const again = recorder.metrics();
          if (!sameJson(metrics, again)) {
            oracle.violations.push(
              'metrics() not idempotent between two calls',
            );
          }
          if (!sameJson(metrics, aggregateStabilitySlo(snapshot))) {
            oracle.violations.push(
              'metrics() differs from aggregating the events() snapshot',
            );
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
        for (let i = 0; i < steps; i += 1) await sched.yield();
        recorder.reset();
        oracle.expected = [];
      };
    }
  }
}

describe('stabilityTelemetry — seeded interleaving bursts', () => {
  const scenario = 'burst/attribution-conservation';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: stream == oracle, metrics pure, bounded wall time`, async () => {
      const random = seededRandom(seed);
      const actorCount = randomInt(random, 4, 24);
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
          const recorder = createStabilityRecorder(clock.nowIso);
          const initial = {
            userKey: pseudoUuid(random),
            sessionKey: pseudoUuid(random),
          };
          recorder.setContext(initial);
          const oracle: Oracle = {
            expected: [],
            context: initial,
            violations: [],
          };
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
          expect(recorder.metrics()).toEqual(
            aggregateStabilitySlo(oracle.expected),
          );
          // No duplicate rows: every stored event object is distinct.
          expect(new Set(events).size).toBe(events.length);
          // Every `at` was consumed from the clock exactly once, in order.
          const ats = events.map(e => Number(e.at.slice(1)));
          expect([...ats].sort((a, b) => a - b)).toEqual(ats);
          expect(elapsedMs).toBeLessThan(WALL_BUDGET_MS);
          return {
            events: events.length,
            steps,
            elapsedMs,
            clockReadings: clock.readings,
            metrics: recorder.metrics(),
          };
        },
      );
    });
  }
});

describe('stabilityTelemetry — hostile clocks', () => {
  const scenario = 'clock/throwing-and-reentrant';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: record never throws; drops exactly the readings that threw; reentrancy terminates`, async () => {
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
          let recorderRef: StabilityRecorder | null = null;
          const nowIso = (): string => {
            const outcome = outcomes[call] ?? 'ok';
            call += 1;
            const myCall = call;
            depth += 1;
            maxDepth = Math.max(maxDepth, depth);
            try {
              if (outcome === 'throw') throw new Error('clock unavailable');
              if (outcome === 'reenter' && depth < 3 && recorderRef) {
                // call-during-call: the clock itself records an event.
                recorderRef.record({
                  kind: 'session_flow_failed',
                  reason: 'clock_reentry',
                });
              }
              return `T${myCall}`;
            } finally {
              depth -= 1;
            }
          };
          const recorder = createStabilityRecorder(nowIso);
          recorderRef = recorder;
          recorder.setContext({
            userKey: pseudoUuid(random),
            sessionKey: 'run',
          });
          let threw = 0;
          const actors: Actor[] = [];
          for (let i = 0; i < total; i += 1) {
            actors.push(async sched => {
              await sched.yield();
              try {
                recorder.record({ kind: 'analysis_started' });
              } catch {
                threw += 1;
              }
              // metrics/events must stay readable at every point.
              try {
                recorder.metrics();
                recorder.events();
              } catch {
                threw += 1;
              }
            });
          }
          const { elapsedMs } = await runBurst(random, actors, WALL_BUDGET_MS);
          expect(threw).toBe(0);
          const events = recorder.events();
          // Exact oracle: replay the clock script. The recorder evaluates
          // `at: nowIso()` BEFORE pushing, so a re-entrant record lands
          // before the row whose clock call triggered it, and a throwing
          // reading drops exactly that row and nothing else.
          const expectedKinds: string[] = [];
          let simCall = 0;
          const simulate = (kind: string, depth: number): void => {
            const outcome = outcomes[simCall] ?? 'ok';
            simCall += 1;
            const at = `T${simCall}`;
            if (outcome === 'throw') return;
            if (outcome === 'reenter' && depth < 3) {
              simulate('session_flow_failed', depth + 1);
            }
            expectedKinds.push(`${kind}@${at}`);
          };
          // The dispatcher's order of top-level records is seed-driven but
          // every actor records the same kind, so the script is order-free.
          for (let i = 0; i < total; i += 1) simulate('analysis_started', 1);
          expect(events.map(e => `${e.kind}@${e.at}`)).toEqual(expectedKinds);
          expect(call).toBe(simCall);
          const started = events.filter(
            e => e.kind === 'analysis_started',
          ).length;
          const reentered = events.filter(
            e => e.kind === 'session_flow_failed',
          ).length;
          expect(maxDepth).toBeLessThanOrEqual(3);
          expect(elapsedMs).toBeLessThan(WALL_BUDGET_MS);
          return {
            events: events.length,
            started,
            reentered,
            maxDepth,
            clockCalls: call,
          };
        },
      );
    });
  }
});

describe('stabilityTelemetry — aggregation is order-independent (clock skew)', () => {
  const scenario = 'aggregate/order-independence';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: any permutation of the stream aggregates identically`, async () => {
      const random = seededRandom(seed);
      const n = randomInt(random, 5, 200);
      const users = [
        pseudoUuid(random),
        pseudoUuid(random),
        pseudoUuid(random),
      ];
      const sessions = [pseudoUuid(random), pseudoUuid(random), null];
      await recordScenario(SUITE, scenario, seed, { n }, async () => {
        const recorder = createStabilityRecorder(
          () => `T${randomInt(random, 0, 50)}`,
        );
        for (let i = 0; i < n; i += 1) {
          recorder.setContext({
            userKey: pick(random, users),
            sessionKey: pick(random, sessions),
          });
          const roll = randomInt(random, 0, 7);
          const input: StabilityEventInput =
            roll === 0
              ? { kind: 'session_started' }
              : roll === 1
                ? {
                    kind: 'crash',
                    fatal: random() < 0.7,
                    fingerprint: `fp${randomInt(random, 1, 3)}`,
                  }
                : roll === 2
                  ? { kind: 'analysis_started' }
                  : roll === 3
                    ? { kind: 'analysis_completed' }
                    : roll === 4
                      ? {
                          kind: 'analysis_failed',
                          failureKind: pick(random, CAUSES),
                        }
                      : roll === 5
                        ? { kind: 'camera_startup_failed', reason: 'x' }
                        : roll === 6
                          ? { kind: 'session_flow_failed', reason: 'y' }
                          : { kind: 'memory_pressure_termination' };
          recorder.record(input);
        }
        const ordered = recorder.metrics();
        const permuted = aggregateStabilitySlo(
          shuffle(random, recorder.events()),
        );
        expect(permuted).toEqual(ordered);
        return { n, ordered };
      });
    });
  }
});

describe('stabilitySlo singleton — real emitters interleaved (two screens, one recorder)', () => {
  const scenario = 'singleton/real-emitters';
  const ALLOWED_KEYS = new Set([
    'kind',
    'userKey',
    'sessionKey',
    'at',
    'fatal',
    'fingerprint',
    'failureKind',
    'reason',
  ]);
  const ALLOWED_REASONS = new Set([
    'session_capture_unavailable',
    'handoff_expired',
    'guided_capture_error',
  ]);
  const handoff = {
    source: 'camera',
    declaredStroke: null,
    declaredCanonical: null,
    auto: true,
    sessionId: null,
  } as const;

  beforeEach(() => {
    stabilitySlo.reset();
    clearTryAgainHandoff();
  });

  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: duplicate TRY AGAIN consumers never double-spend; camera failures and rotations conserve`, async () => {
      const random = seededRandom(seed);
      const armCount = randomInt(random, 1, 4);
      const consumersPerArm = randomInt(random, 2, 5);
      const cameraStarts = randomInt(random, 1, 6);
      const rotations = randomInt(random, 0, 4);
      await recordScenario(
        SUITE,
        scenario,
        seed,
        { armCount, consumersPerArm, cameraStarts, rotations },
        async () => {
          const owner = pseudoUuid(random);
          stabilitySlo.setContext({ userKey: owner, sessionKey: 'run-1' });
          let consumed = 0;
          let nulls = 0;
          let cameraFailures = 0;
          const actors: Actor[] = [];
          for (let a = 0; a < armCount; a += 1) {
            actors.push(async sched => {
              await sched.yield();
              armTryAgain(handoff);
              // Several screens race to consume the same single-shot handoff.
              const consumers: Actor[] = [];
              for (let c = 0; c < consumersPerArm; c += 1) {
                consumers.push(async inner => {
                  await inner.yield();
                  const got = consumeTryAgainHandoff();
                  if (got) consumed += 1;
                  else nulls += 1;
                });
              }
              await Promise.all(consumers.map(consumer => consumer(sched)));
            });
          }
          for (let c = 0; c < cameraStarts; c += 1) {
            actors.push(async sched => {
              await sched.yield();
              try {
                await startSessionCapture();
              } catch {
                cameraFailures += 1;
              }
            });
          }
          for (let r = 0; r < rotations; r += 1) {
            const next = { userKey: pseudoUuid(random), sessionKey: 'run-1' };
            actors.push(async sched => {
              await sched.yield();
              stabilitySlo.setContext(next);
            });
          }
          const { elapsedMs, steps } = await runBurst(
            random,
            actors,
            WALL_BUDGET_MS,
          );
          const events = stabilitySlo.events();
          const rearmed = events.filter(
            e => e.kind === 'try_again_rearmed',
          ).length;
          const failed = events.filter(
            e => e.kind === 'try_again_failed',
          ).length;
          const camFailed = events.filter(
            e => e.kind === 'camera_startup_failed',
          ).length;
          // Arms are sequential per actor but actors overlap: an arm that
          // lands while another arm's consumers are still parked can be
          // taken by them. Regardless of interleaving: each successful
          // consume is exactly one rearm event, never two, and a null
          // consume records nothing (the handoff was already cleared) —
          // no double spend.
          expect(rearmed).toBe(consumed);
          expect(failed).toBe(0);
          expect(consumed).toBeGreaterThanOrEqual(1);
          expect(consumed).toBeLessThanOrEqual(armCount);
          expect(consumed + nulls).toBe(armCount * consumersPerArm);
          expect(camFailed).toBe(cameraFailures);
          expect(cameraFailures).toBe(cameraStarts);
          expect(events).toHaveLength(rearmed + camFailed);
          // PII / pose whitelist on what the real emitters actually stored.
          for (const event of events) {
            for (const key of Object.keys(event))
              expect(ALLOWED_KEYS.has(key)).toBe(true);
            if ('reason' in event)
              expect(ALLOWED_REASONS.has(event.reason)).toBe(true);
            expect(
              event.userKey === owner || /^[0-9a-f-]{36}$/.test(event.userKey),
            ).toBe(true);
            expect(event.sessionKey).toBe('run-1');
          }
          expect(elapsedMs).toBeLessThan(WALL_BUDGET_MS);
          return {
            events: events.length,
            rearmed,
            nulls,
            camFailed,
            steps,
            elapsedMs,
          };
        },
      );
    });
  }
});
