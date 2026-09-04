/**
 * STRESS / failure-injection — `mod-telemetry` recorders under faulted
 * dependencies (clock, context, caller input, aggregation input).
 *
 * The two recorders (`createStabilityRecorder`, `createUsabilityFunnelRecorder`)
 * have exactly one runtime dependency each — the injected clock — plus the
 * caller-supplied context/input objects. Every iteration derives a plan from
 * its seed: a clock fault (throw / NaN / non-ISO / stuck / backwards / jump),
 * a context fault (empty / non-string / throwing getter / frozen), an input
 * fault (unknown kind / spread-throwing proxy / frozen / circular / huge /
 * dependency-text payload) and an op sequence mixing record / attributed
 * record / setContext / reset / metrics / events.
 *
 * Invariants asserted on EVERY seed:
 *   - no recorder call ever throws (the "never breaks the flow" contract);
 *   - exact accounting: an append lands iff clock + context + input all
 *     worked — no fake event from a faulted append, no lost good event;
 *   - every stored event is complete and typed (no half-written record);
 *   - metrics()/summary()/deriveConfusionEvents never throw, every rate is
 *     null or a finite number in [0, 1], every confusion value is finite;
 *   - the recorder is recoverable: after any fault a clean append lands and
 *     reset() empties it;
 *   - the usability derivation agrees with an independent reference model.
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/telemetryRecorderFaults`
 * Scale:  `STRESS_ITER=<n>` seeds per scenario (default below).
 */
import type { StabilitySloEvent } from '@pickle/shared-types';
import {
  UNASSIGNED_STABILITY_USER_KEY,
  classifyPreviousRun,
  createStabilityRecorder,
  recordPreviousRunOutcome,
  type PreviousRunMarker,
  type StabilityContext,
  type StabilityEventInput,
} from '../../src/analysis/stabilityTelemetry';
import {
  CONFUSION_THRESHOLDS_V1,
  USABILITY_FUNNEL_STEPS,
  createUsabilityFunnelRecorder,
  deriveConfusionEvents,
  summarizeUsabilityFunnel,
  type ConfusionEvent,
  type UsabilityFunnelEvent,
  type UsabilityFunnelStep,
} from '../../src/analysis/usabilityTelemetry';
import {
  chance,
  heapUsedMb,
  pick,
  randomInt,
  recordStress,
  seededRandom,
  sensitiveHits,
  stabilityEventViolations,
  stressSeeds,
  tally,
  usabilityEventViolations,
} from '../../testing/stress/faultInjection';

const SUITE = 'telemetryRecorderFaults';
const DEFAULT_ITER = 12;

// ─── Clock faults ────────────────────────────────────────────────────────────

const ISO_CLOCK_FAULTS = [
  'ok',
  'throw',
  'nan_date',
  'non_iso',
  'empty',
  'stuck',
  'backwards',
  'jump_60s',
  'intermittent_throw',
] as const;
type IsoClockFault = (typeof ISO_CLOCK_FAULTS)[number];

/** Builds a faulted ISO clock. `throwsOnCall(i)` tells the accounting model
 * whether call `i` (0-based, counted per append) throws. */
function isoClock(fault: IsoClockFault, random: () => number) {
  let calls = 0;
  let t = Date.UTC(2026, 8, 4, 12, 0, 0);
  const throwPlan: boolean[] = [];
  const throwsOnCall = (i: number) => throwPlan[i] === true;
  const clock = (): string => {
    const i = calls;
    calls += 1;
    switch (fault) {
      case 'ok':
        t += 1000;
        return new Date(t).toISOString();
      case 'throw':
        throwPlan[i] = true;
        throw new Error('clock unavailable');
      case 'nan_date':
        // What `new Date(NaN).toISOString()` does: a RangeError.
        throwPlan[i] = true;
        return new Date(NaN).toISOString();
      case 'non_iso':
        return 'yesterday-ish';
      case 'empty':
        return '';
      case 'stuck':
        return new Date(t).toISOString();
      case 'backwards':
        t -= 5000;
        return new Date(t).toISOString();
      case 'jump_60s':
        t += 60_000;
        return new Date(t).toISOString();
      case 'intermittent_throw': {
        const fails = random() < 0.4;
        throwPlan[i] = fails;
        if (fails) throw new Error('clock hiccup');
        t += 1000;
        return new Date(t).toISOString();
      }
    }
  };
  return {
    clock,
    throwsOnCall,
    alwaysThrows: fault === 'throw' || fault === 'nan_date',
  };
}

// ─── Context faults ──────────────────────────────────────────────────────────

const CONTEXT_FAULTS = [
  'ok',
  'empty_user',
  'numeric_user',
  'undefined_session',
  'throwing_getter',
  'frozen',
  'huge_user',
] as const;
type ContextFault = (typeof CONTEXT_FAULTS)[number];

function faultedContext(fault: ContextFault): {
  context: StabilityContext;
  /** Whether stamping this context makes the append throw (→ dropped). */
  appendThrows: boolean;
  /** Whether the stored event would still satisfy the shape contract. */
  wellFormed: boolean;
} {
  switch (fault) {
    case 'ok':
      return {
        context: { userKey: 'user-ok', sessionKey: 'session-ok' },
        appendThrows: false,
        wellFormed: true,
      };
    case 'empty_user':
      return {
        context: { userKey: '', sessionKey: 's' },
        appendThrows: false,
        wellFormed: false,
      };
    case 'numeric_user':
      return {
        context: { userKey: 42 as unknown as string, sessionKey: 's' },
        appendThrows: false,
        wellFormed: false,
      };
    case 'undefined_session':
      return {
        context: {
          userKey: 'u',
          sessionKey: undefined as unknown as null,
        },
        appendThrows: false,
        wellFormed: false,
      };
    case 'throwing_getter':
      return {
        context: new Proxy(
          { userKey: 'u', sessionKey: 's' },
          {
            get() {
              throw new Error('context storage unavailable');
            },
          },
        ),
        appendThrows: true,
        wellFormed: false,
      };
    case 'frozen':
      return {
        context: Object.freeze({ userKey: 'frozen-user', sessionKey: null }),
        appendThrows: false,
        wellFormed: true,
      };
    case 'huge_user':
      return {
        context: { userKey: 'u'.repeat(65_536), sessionKey: 's' },
        appendThrows: false,
        wellFormed: true,
      };
  }
}

// ─── Input faults ────────────────────────────────────────────────────────────

const INPUT_FAULTS = [
  'ok',
  'unknown_kind',
  'spread_throws',
  'frozen',
  'circular_extra',
  'huge_reason',
  'dependency_text_reason',
  'missing_required',
] as const;
type InputFault = (typeof INPUT_FAULTS)[number];

const GOOD_INPUTS: readonly StabilityEventInput[] = [
  { kind: 'session_started' },
  { kind: 'session_ended_clean' },
  { kind: 'crash', fatal: true, fingerprint: 'fp-1' },
  { kind: 'crash', fatal: false, fingerprint: 'fp-2' },
  { kind: 'memory_pressure_termination' },
  { kind: 'analysis_started' },
  { kind: 'analysis_completed' },
  { kind: 'analysis_failed', failureKind: 'exception' },
  { kind: 'camera_startup_succeeded' },
  { kind: 'camera_startup_failed', reason: 'session_capture_unavailable' },
  { kind: 'try_again_rearmed' },
  { kind: 'try_again_failed', reason: 'handoff_expired' },
  { kind: 'session_flow_failed', reason: 'on_update_subscriber_failed' },
];

function faultedInput(
  fault: InputFault,
  random: () => number,
): {
  input: StabilityEventInput;
  appendThrows: boolean;
  wellFormed: boolean;
} {
  const good = pick(random, GOOD_INPUTS);
  switch (fault) {
    case 'ok':
      return { input: good, appendThrows: false, wellFormed: true };
    case 'unknown_kind':
      return {
        input: { kind: 'telemetry_v2_thing' } as unknown as StabilityEventInput,
        appendThrows: false,
        wellFormed: false,
      };
    case 'spread_throws':
      return {
        input: new Proxy(good, {
          ownKeys() {
            throw new Error('input enumeration failed');
          },
        }),
        appendThrows: true,
        wellFormed: false,
      };
    case 'frozen':
      return {
        input: Object.freeze({ ...good }),
        appendThrows: false,
        wellFormed: true,
      };
    case 'circular_extra': {
      const extra: Record<string, unknown> = { ...good };
      extra['self'] = extra;
      return {
        input: extra as unknown as StabilityEventInput,
        appendThrows: false,
        wellFormed: true,
      };
    }
    case 'huge_reason':
      return {
        input: { kind: 'camera_startup_failed', reason: 'x'.repeat(1 << 20) },
        appendThrows: false,
        wellFormed: true,
      };
    case 'dependency_text_reason':
      return {
        input: {
          kind: 'camera_startup_failed',
          reason:
            'SQLITE_CANTOPEN: unable to open database file ' +
            '/var/mobile/Containers/Data/Application/ABC/Documents/pickle.sqlite',
        },
        appendThrows: false,
        wellFormed: true,
      };
    case 'missing_required':
      return {
        input: { kind: 'crash' } as unknown as StabilityEventInput,
        appendThrows: false,
        wellFormed: false,
      };
  }
}

function rateIsHonest(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1)
  );
}

function metricsViolations(metrics: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (metrics['version'] !== 'stability-slo-v1') out.push('version');
  for (const [key, value] of Object.entries(metrics)) {
    if (key.endsWith('Rate') && !rateIsHonest(value))
      out.push(`${key}=${String(value)}`);
    else if (
      !key.endsWith('Rate') &&
      key !== 'version' &&
      !(typeof value === 'number' && Number.isInteger(value) && value >= 0)
    )
      out.push(`${key}=${String(value)}`);
  }
  return out;
}

// ─── Stability recorder campaign ────────────────────────────────────────────

describe('STRESS mod-telemetry / stability recorder under clock+context+input faults', () => {
  for (const seed of stressSeeds('stabilityRecorderFaults', DEFAULT_ITER)) {
    it(`seed ${seed}`, async () => {
      const random = seededRandom(seed);
      const clockFault = pick(random, ISO_CLOCK_FAULTS);
      const opCount = randomInt(random, 8, 48);
      const ops: string[] = [];
      await recordStress(
        SUITE,
        'stabilityRecorderFaults',
        seed,
        { clockFault, opCount },
        async () => {
          const { clock, throwsOnCall, alwaysThrows } = isoClock(
            clockFault,
            random,
          );
          const recorder = createStabilityRecorder(clock);
          const expected: Array<{ wellFormed: boolean }> = [];
          let appendCalls = 0;
          let currentContext = faultedContext('ok');
          let thrown = 0;
          let contextFaultsUsed = 0;
          let inputFaultsUsed = 0;

          const attempt = (label: string, fn: () => void) => {
            ops.push(label);
            try {
              fn();
            } catch (error) {
              thrown += 1;
              ops.push(
                `THREW:${label}:${error instanceof Error ? error.message : String(error)}`,
              );
            }
          };

          for (let i = 0; i < opCount; i += 1) {
            const roll = random();
            if (roll < 0.45) {
              const inputFault = chance(random, 0.5)
                ? pick(random, INPUT_FAULTS)
                : 'ok';
              if (inputFault !== 'ok') inputFaultsUsed += 1;
              const { input, appendThrows, wellFormed } = faultedInput(
                inputFault,
                random,
              );
              // Evaluation order inside append: spread input → read context
              // → read clock. A fault earlier in that chain drops the event
              // without consuming a clock call.
              const reachesClock =
                !appendThrows && !currentContext.appendThrows;
              const callIndex = appendCalls;
              if (reachesClock) appendCalls += 1;
              attempt(`record:${inputFault}`, () => recorder.record(input));
              if (reachesClock && !throwsOnCall(callIndex)) {
                expected.push({
                  wellFormed: wellFormed && currentContext.wellFormed,
                });
              }
            } else if (roll < 0.6) {
              const contextFault = pick(random, CONTEXT_FAULTS);
              if (contextFault !== 'ok') contextFaultsUsed += 1;
              const attribution = faultedContext(contextFault);
              const { input, appendThrows, wellFormed } = faultedInput(
                'ok',
                random,
              );
              const reachesClock = !appendThrows && !attribution.appendThrows;
              const callIndex = appendCalls;
              if (reachesClock) appendCalls += 1;
              attempt(`recordAttributed:${contextFault}`, () =>
                recorder.recordAttributed(input, attribution.context),
              );
              if (reachesClock && !throwsOnCall(callIndex)) {
                expected.push({
                  wellFormed: wellFormed && attribution.wellFormed,
                });
              }
            } else if (roll < 0.72) {
              const contextFault = pick(random, CONTEXT_FAULTS);
              if (contextFault !== 'ok') contextFaultsUsed += 1;
              currentContext = faultedContext(contextFault);
              attempt(`setContext:${contextFault}`, () =>
                recorder.setContext(currentContext.context),
              );
            } else if (roll < 0.82) {
              attempt('metrics', () => {
                const violations = metricsViolations(
                  recorder.metrics() as unknown as Record<string, unknown>,
                );
                if (violations.length > 0)
                  throw new Error(`metrics dishonest: ${violations.join(',')}`);
              });
            } else if (roll < 0.9) {
              attempt('events', () => {
                if (!Array.isArray(recorder.events()))
                  throw new Error('not array');
              });
            } else {
              attempt('reset', () => recorder.reset());
              expected.length = 0;
              // A reset never re-arms the throwing clock plan.
            }
          }

          // ── invariants ──
          expect(thrown).toBe(0);
          const events = recorder.events();
          // Exact accounting: no fake event, no lost good event.
          expect(events.length).toBe(expected.length);
          // Stored events are complete and typed whenever their inputs were.
          const violations = stabilityEventViolations(events);
          const expectedMalformed = expected.filter(e => !e.wellFormed).length;
          if (expectedMalformed === 0) expect(violations).toEqual([]);
          // A faulted clock never leaves a non-string `at`.
          for (const event of events) expect(typeof event.at).toBe('string');
          // Aggregation never throws and stays honest on whatever is stored.
          const metrics = recorder.metrics() as unknown as Record<
            string,
            unknown
          >;
          expect(metricsViolations(metrics)).toEqual([]);
          // Recoverable: a clean attributed append lands (unless the clock is
          // permanently broken — then it is honestly dropped, never faked).
          const before = recorder.events().length;
          recorder.recordAttributed(
            { kind: 'analysis_started' },
            { userKey: 'recover', sessionKey: 'recover' },
          );
          const after = recorder.events().length;
          if (alwaysThrows) expect(after).toBe(before);
          else {
            const landed =
              clockFault === 'intermittent_throw'
                ? after - before <= 1
                : after === before + 1;
            expect(landed).toBe(true);
          }
          recorder.reset();
          expect(recorder.events()).toEqual([]);
          expect(
            metricsViolations(
              recorder.metrics() as unknown as Record<string, unknown>,
            ),
          ).toEqual([]);

          return {
            ops: ops.length,
            appendCalls,
            stored: events.length,
            expectedStored: expected.length,
            expectedMalformed,
            shapeViolations: violations.length,
            contextFaultsUsed,
            inputFaultsUsed,
            recoveredAppendLanded: after - before,
            tally: tally(events),
            sensitiveHitsInOwnFields: sensitiveHits(
              events as unknown as Record<string, unknown>[],
            ).length,
          };
        },
      );
    });
  }
});

// ─── Usability recorder campaign ────────────────────────────────────────────

const MS_CLOCK_FAULTS = [
  'ok',
  'throw',
  'nan',
  'infinity',
  'negative',
  'stuck',
  'backwards',
  'jump_60s',
  'string',
  'intermittent_throw',
] as const;
type MsClockFault = (typeof MS_CLOCK_FAULTS)[number];

function msClock(fault: MsClockFault, random: () => number) {
  let t = 1_000_000;
  const throwPlan: boolean[] = [];
  let calls = 0;
  const clock = (): number => {
    const i = calls;
    calls += 1;
    switch (fault) {
      case 'ok':
        t += randomInt(random, 1, 2500);
        return t;
      case 'throw':
        throwPlan[i] = true;
        throw new Error('Date.now unavailable');
      case 'nan':
        return NaN;
      case 'infinity':
        return Infinity;
      case 'negative':
        t -= 1000;
        return -Math.abs(t);
      case 'stuck':
        return t;
      case 'backwards':
        t -= randomInt(random, 1, 2500);
        return t;
      case 'jump_60s':
        t += 60_000;
        return t;
      case 'string':
        t += 1000;
        return String(t) as unknown as number;
      case 'intermittent_throw': {
        const fails = random() < 0.4;
        throwPlan[i] = fails;
        if (fails) throw new Error('clock hiccup');
        t += randomInt(random, 1, 2500);
        return t;
      }
    }
  };
  return {
    clock,
    throwsOnCall: (i: number) => throwPlan[i] === true,
    alwaysThrows: fault === 'throw',
    nonFinite: fault === 'nan' || fault === 'infinity',
    nonNumber: fault === 'string',
  };
}

const DETAIL_FAULTS = [
  'none',
  'ok',
  'empty',
  'huge',
  'dependency_text',
  'numeric',
  'object',
  'null',
] as const;
type DetailFault = (typeof DETAIL_FAULTS)[number];

function faultedDetail(fault: DetailFault): {
  detail: string | undefined;
  wellFormed: boolean;
} {
  switch (fault) {
    case 'none':
      return { detail: undefined, wellFormed: true };
    case 'ok':
      return { detail: 'forehand_drive', wellFormed: true };
    case 'empty':
      return { detail: '', wellFormed: true };
    case 'huge':
      return { detail: 'e'.repeat(1 << 18), wellFormed: true };
    case 'dependency_text':
      return {
        detail:
          'Error: could not read file:///var/mobile/Containers/Data/Application/X/captures/run.mov',
        wellFormed: true,
      };
    case 'numeric':
      return { detail: 404 as unknown as string, wellFormed: false };
    case 'object':
      return { detail: { code: 'E' } as unknown as string, wellFormed: false };
    case 'null':
      return { detail: null as unknown as string, wellFormed: false };
  }
}

/**
 * Independent reference for deriveConfusionEvents over the LOG ORDER of the
 * recorder ("before the camera opened" = appended before the first
 * camera_opened). The production derivation orders some signals by tMs
 * instead; the two agree exactly when the clock is strictly monotonic and
 * are compared only then — disagreement under a stuck/backwards clock is
 * recorded as an observation.
 */
function referenceConfusion(
  events: readonly UsabilityFunnelEvent[],
): Array<Pick<ConfusionEvent, 'kind' | 'tMs'>> {
  const th = CONFUSION_THRESHOLDS_V1;
  const out: Array<Pick<ConfusionEvent, 'kind' | 'tMs'>> = [];
  const firstCamera = events.findIndex(e => e.step === 'camera_opened');
  const preCamera = firstCamera === -1 ? events : events.slice(0, firstCamera);
  const intents = preCamera.filter(e => e.step === 'intent_selected');
  if (intents.length >= th.intentReselectionMin)
    out.push({
      kind: 'intent_reselection_churn',
      tMs: intents[intents.length - 1]!.tMs,
    });
  if (firstCamera !== -1) {
    const camera = events[firstCamera]!;
    const after = events.slice(firstCamera + 1);
    const horizon =
      after.find(e => e.step === 'ready') ??
      after.find(e => e.step === 'stroke_captured');
    if (horizon && horizon.tMs - camera.tMs > th.preReadyDwellMs)
      out.push({ kind: 'pre_ready_dwell_exceeded', tMs: horizon.tMs });
  }
  let ready = false;
  let oscillations = 0;
  let lastLoss = 0;
  for (const e of events) {
    if (e.step === 'ready') ready = true;
    else if (e.step === 'readiness_state' && e.detail !== 'ready') {
      if (ready) {
        oscillations += 1;
        lastLoss = e.tMs;
      }
      ready = false;
    }
  }
  if (oscillations >= th.readinessOscillationMin)
    out.push({ kind: 'readiness_oscillation', tMs: lastLoss });
  let streak = 0;
  let last: string | undefined;
  for (const e of events) {
    if (e.step !== 'error_shown') continue;
    streak = e.detail === last ? streak + 1 : 1;
    last = e.detail;
    if (streak === th.repeatedErrorMin)
      out.push({ kind: 'repeated_error', tMs: e.tMs });
  }
  events.forEach((e, index) => {
    if (e.step !== 'attempt_abandoned') return;
    if (!events.slice(0, index).some(x => x.step === 'stroke_captured'))
      out.push({ kind: 'abandoned_before_capture', tMs: e.tMs });
  });
  return out;
}

describe('STRESS mod-telemetry / usability recorder under clock+detail faults', () => {
  for (const seed of stressSeeds('usabilityRecorderFaults', DEFAULT_ITER)) {
    it(`seed ${seed}`, async () => {
      const random = seededRandom(seed);
      const clockFault = pick(random, MS_CLOCK_FAULTS);
      const opCount = randomInt(random, 10, 60);
      await recordStress(
        SUITE,
        'usabilityRecorderFaults',
        seed,
        { clockFault, opCount },
        async () => {
          const { clock, throwsOnCall, alwaysThrows, nonFinite, nonNumber } =
            msClock(clockFault, random);
          const recorder = createUsabilityFunnelRecorder(clock);
          let expected = 0;
          let expectedMalformed = 0;
          let thrown = 0;
          let logCalls = 0;
          let detailFaultsUsed = 0;
          let unknownSteps = 0;
          const attempt = (fn: () => void) => {
            try {
              fn();
            } catch {
              thrown += 1;
            }
          };
          for (let i = 0; i < opCount; i += 1) {
            const roll = random();
            if (roll < 0.75) {
              const useUnknownStep = chance(random, 0.08);
              const step = useUnknownStep
                ? ('mystery_step' as UsabilityFunnelStep)
                : pick(random, USABILITY_FUNNEL_STEPS);
              if (useUnknownStep) unknownSteps += 1;
              const detailFault = chance(random, 0.4)
                ? pick(random, DETAIL_FAULTS)
                : 'none';
              if (detailFault !== 'none' && detailFault !== 'ok')
                detailFaultsUsed += 1;
              const { detail, wellFormed } = faultedDetail(detailFault);
              const callIndex = logCalls;
              logCalls += 1;
              attempt(() =>
                detail === undefined
                  ? recorder.log(step)
                  : recorder.log(step, detail),
              );
              if (!throwsOnCall(callIndex)) {
                expected += 1;
                if (!wellFormed || useUnknownStep || nonNumber)
                  expectedMalformed += 1;
              }
            } else if (roll < 0.9) {
              attempt(() => {
                const summary = recorder.summary();
                for (const c of summary.confusionEvents) {
                  if (typeof c.detail !== 'string')
                    throw new Error(`no detail ${c.kind}`);
                }
              });
            } else {
              attempt(() => recorder.reset());
              expected = 0;
              expectedMalformed = 0;
            }
          }

          expect(thrown).toBe(0);
          const events = recorder.events();
          expect(events.length).toBe(expected);
          const violations = usabilityEventViolations(events, {
            allowNonFiniteT: nonFinite,
          });
          if (expectedMalformed === 0) expect(violations).toEqual([]);
          // Derivation copes with whatever the faulted clock stored.
          const derived = deriveConfusionEvents(events);
          for (const c of derived) {
            expect(typeof c.detail).toBe('string');
            if (!nonFinite && !nonNumber)
              expect(Number.isFinite(c.tMs)).toBe(true);
          }
          // Sorted output (only meaningful with an ordered comparator).
          if (!nonFinite && !nonNumber) {
            for (let i = 1; i < derived.length; i += 1)
              expect(derived[i]!.tMs).toBeGreaterThanOrEqual(
                derived[i - 1]!.tMs,
              );
          }
          // Independent log-order reference: exact agreement is required on
          // a strictly monotonic clock; otherwise the divergence is recorded.
          const reference = referenceConfusion(events);
          const derivedPairs = derived.map(c => `${c.kind}@${c.tMs}`).sort();
          const referencePairs = reference
            .map(c => `${c.kind}@${c.tMs}`)
            .sort();
          const strictlyMonotonic =
            clockFault === 'ok' ||
            clockFault === 'jump_60s' ||
            clockFault === 'intermittent_throw';
          const referenceAgrees =
            JSON.stringify(derivedPairs) === JSON.stringify(referencePairs);
          if (strictlyMonotonic) expect(derivedPairs).toEqual(referencePairs);
          const summary = summarizeUsabilityFunnel(events);
          expect(summary.protocolVersion).toBe('zero-handholding-usability-v1');
          // Recoverable.
          const before = recorder.events().length;
          recorder.log('analyze_opened', 'recover');
          const after = recorder.events().length;
          if (alwaysThrows) expect(after).toBe(before);
          else if (clockFault !== 'intermittent_throw')
            expect(after).toBe(before + 1);
          recorder.reset();
          expect(recorder.events()).toEqual([]);
          expect(recorder.summary().confusionEvents).toEqual([]);
          return {
            logCalls,
            stored: events.length,
            expectedMalformed,
            unknownSteps,
            detailFaultsUsed,
            shapeViolations: violations.length,
            confusion: derived.map(c => c.kind),
            referenceAgrees,
            referenceConfusion: reference.map(c => c.kind),
            tally: tally(events),
            sensitiveHitsInDetail: sensitiveHits(
              events as unknown as Record<string, unknown>[],
            ).length,
          };
        },
      );
    });
  }
});

// ─── Malformed persisted previous-run markers ("SQLite"/kv partial rows) ────

type MarkerShape =
  | 'clean'
  | 'crash'
  | 'memory'
  | 'unknown'
  | 'crash_and_clean'
  | 'empty_fingerprint'
  | 'numeric_fingerprint'
  | 'string_flags'
  | 'missing_fingerprint_key'
  | 'all_undefined'
  | 'null_row';

function marker(shape: MarkerShape): PreviousRunMarker {
  switch (shape) {
    case 'clean':
      return {
        sessionKey: 'prev',
        endedClean: true,
        memoryWarningSeen: false,
        crashFingerprint: null,
      };
    case 'crash':
      return {
        sessionKey: 'prev',
        endedClean: false,
        memoryWarningSeen: false,
        crashFingerprint: 'fp',
      };
    case 'memory':
      return {
        sessionKey: 'prev',
        endedClean: false,
        memoryWarningSeen: true,
        crashFingerprint: null,
      };
    case 'unknown':
      return {
        sessionKey: 'prev',
        endedClean: false,
        memoryWarningSeen: false,
        crashFingerprint: null,
      };
    case 'crash_and_clean':
      return {
        sessionKey: 'prev',
        endedClean: true,
        memoryWarningSeen: true,
        crashFingerprint: 'fp',
      };
    case 'empty_fingerprint':
      return {
        sessionKey: 'prev',
        endedClean: false,
        memoryWarningSeen: false,
        crashFingerprint: '',
      };
    case 'numeric_fingerprint':
      return {
        sessionKey: 'prev',
        endedClean: false,
        memoryWarningSeen: false,
        crashFingerprint: 12345 as unknown as string,
      };
    case 'string_flags':
      return {
        sessionKey: 'prev',
        endedClean: 'false' as unknown as boolean,
        memoryWarningSeen: 'false' as unknown as boolean,
        crashFingerprint: null,
      };
    case 'missing_fingerprint_key':
      return {
        sessionKey: 'prev',
        endedClean: false,
        memoryWarningSeen: false,
      } as PreviousRunMarker;
    case 'all_undefined':
      return {} as PreviousRunMarker;
    case 'null_row':
      return null as unknown as PreviousRunMarker;
  }
}

const MARKER_SHAPES: readonly MarkerShape[] = [
  'clean',
  'crash',
  'memory',
  'unknown',
  'crash_and_clean',
  'empty_fingerprint',
  'numeric_fingerprint',
  'string_flags',
  'missing_fingerprint_key',
  'all_undefined',
  'null_row',
];

describe('STRESS mod-telemetry / previous-run marker (partial or malformed persisted row)', () => {
  for (const seed of stressSeeds('previousRunMarkerFaults', DEFAULT_ITER)) {
    it(`seed ${seed}`, async () => {
      const random = seededRandom(seed);
      const shape = pick(random, MARKER_SHAPES);
      await recordStress(
        SUITE,
        'previousRunMarkerFaults',
        seed,
        { shape },
        async () => {
          const recorder = createStabilityRecorder(
            () => '2026-09-04T12:00:00.000Z',
          );
          recorder.setContext({
            userKey: 'this-run',
            sessionKey: 'this-session',
          });
          let classification: string | null = null;
          let threw: string | null = null;
          try {
            classification = recordPreviousRunOutcome(
              recorder,
              'prev-run',
              marker(shape),
            );
          } catch (error) {
            threw = error instanceof Error ? error.message : String(error);
          }
          const events = [...recorder.events()];
          // The current run's context must never be mutated by attribution.
          recorder.record({ kind: 'analysis_started' });
          const current = recorder.events()[recorder.events().length - 1]!;
          expect(current.sessionKey).toBe('this-session');
          // Whatever was recorded describes the PREVIOUS run's session.
          for (const event of events)
            expect(event.sessionKey).not.toBe('this-session');
          const violations = stabilityEventViolations(events);
          const observed: Record<string, unknown> = {
            classification,
            threw,
            recorded: tally(events),
            shapeViolations: violations,
          };
          switch (shape) {
            case 'null_row':
              // A missing row cannot be classified; the pure function throws
              // to its (future) caller and must not have recorded anything.
              expect(threw).not.toBeNull();
              expect(events).toEqual([]);
              return observed;
            case 'clean':
            case 'unknown':
              expect(threw).toBeNull();
              expect(events).toEqual([]);
              return observed;
            case 'crash':
            case 'crash_and_clean':
            case 'empty_fingerprint':
              expect(threw).toBeNull();
              expect(classification).toBe('crash');
              expect(violations).toEqual([]);
              expect(tally(events)).toEqual({ crash: 1 });
              return observed;
            case 'memory':
              expect(threw).toBeNull();
              expect(classification).toBe('memory_pressure_termination');
              expect(tally(events)).toEqual({ memory_pressure_termination: 1 });
              return observed;
            case 'string_flags':
              // Truthy string flags read as booleans: `endedClean: 'false'`
              // classifies as a clean exit — nothing recorded, nothing faked.
              expect(threw).toBeNull();
              expect(classification).toBe('clean_exit');
              expect(events).toEqual([]);
              return observed;
            case 'numeric_fingerprint':
            case 'missing_fingerprint_key':
            case 'all_undefined': {
              // Known defect (pinned by the it.failing below): a partial or
              // untyped marker is classified as a fatal crash and the crash
              // event carries a non-string fingerprint. Recorded as BROKEN.
              expect(threw).toBeNull();
              expect(classification).toBe('crash');
              expect(tally(events)).toEqual({ crash: 1 });
              expect(violations.length).toBeGreaterThan(0);
              return { ...observed, verdict: 'broken' };
            }
          }
        },
      );
    });
  }

  // BROKEN (pinned as `it.failing` so the suite stays green until fixed):
  // a PARTIAL persisted marker whose `crashFingerprint` key is missing is
  // classified as a fatal crash and a crash event with `fingerprint:
  // undefined` is recorded — a fabricated fatal crash from a half-written
  // row. `classifyPreviousRun` tests `!== null`, not `typeof === 'string'`.
  it.failing(
    'BROKEN P3 — partial marker without crashFingerprint must not classify as a crash (stabilityTelemetry.ts classifyPreviousRun)',
    async () => {
      await recordStress(
        SUITE,
        'previousRunMarkerFaults.partialFingerprint',
        0,
        { shape: 'missing_fingerprint_key' },
        async note => {
          const recorder = createStabilityRecorder(
            () => '2026-09-04T12:00:00.000Z',
          );
          const classification = classifyPreviousRun(
            marker('missing_fingerprint_key'),
          );
          recordPreviousRunOutcome(
            recorder,
            'u',
            marker('missing_fingerprint_key'),
          );
          const events = recorder.events();
          note({
            classification,
            recorded: tally(events),
            fingerprint:
              events[0] && events[0].kind === 'crash'
                ? String(events[0].fingerprint)
                : null,
            shapeViolations: stabilityEventViolations(events),
          });
          expect(classification).not.toBe('crash');
          expect(stabilityEventViolations(events)).toEqual([]);
          return {};
        },
        { knownBroken: true },
      );
    },
  );
});

// ─── Buffer growth (the "bounded buffers" property) ─────────────────────────

describe('STRESS mod-telemetry / buffer growth under a stuck-failing emitter', () => {
  const growthIter =
    Number(process.env['STRESS_ITER'] ?? '') > 0 ? 50_000 : 20_000;

  it(`records ${growthIter} failure events without throwing; heap table recorded`, async () => {
    await recordStress(
      SUITE,
      'bufferGrowth',
      growthIter,
      { events: growthIter },
      async () => {
        const recorder = createStabilityRecorder(
          () => '2026-09-04T12:00:00.000Z',
        );
        recorder.setContext({ userKey: 'u', sessionKey: 's' });
        const funnel = createUsabilityFunnelRecorder(() => 1);
        const heapBefore = heapUsedMb();
        const table: Array<{ n: number; heapMb: number }> = [];
        for (let i = 1; i <= growthIter; i += 1) {
          recorder.record({
            kind: 'session_flow_failed',
            reason: 'on_update_subscriber_failed',
          });
          funnel.log('readiness_state', 'searching');
          if (i % 5000 === 0) table.push({ n: i, heapMb: heapUsedMb() });
        }
        const metrics = recorder.metrics();
        expect(metrics.sessionFlowFailures).toBe(growthIter);
        expect(recorder.events().length).toBe(growthIter);
        expect(funnel.events().length).toBe(growthIter);
        return {
          heapBeforeMb: heapBefore,
          heapAfterMb: heapUsedMb(),
          heapTable: table,
          stabilityEvents: recorder.events().length,
          usabilityEvents: funnel.events().length,
        };
      },
    );
  });

  // BROKEN (pinned as `it.failing`): neither recorder bounds its buffer. A
  // consumer that fails on every motion sample (LiveSessionFlow.notify →
  // session_flow_failed per pushSample) or every readiness event grows the
  // in-memory log linearly for the life of the process.
  it.failing(
    'BROKEN P3 — recorders cap their in-memory buffers (no cap exists)',
    async () => {
      await recordStress(
        SUITE,
        'bufferGrowth.cap',
        1,
        { events: 20_000 },
        async note => {
          const recorder = createStabilityRecorder(
            () => '2026-09-04T12:00:00.000Z',
          );
          const funnel = createUsabilityFunnelRecorder(() => 1);
          for (let i = 0; i < 20_000; i += 1) {
            recorder.record({ kind: 'session_flow_failed', reason: 'x' });
            funnel.log('readiness_state', 'searching');
          }
          note({
            stabilityEvents: recorder.events().length,
            usabilityEvents: funnel.events().length,
          });
          expect(recorder.events().length).toBeLessThan(20_000);
          expect(funnel.events().length).toBeLessThan(20_000);
          return {};
        },
        { knownBroken: true },
      );
    },
  );
});

// ─── Default context sanity (unassigned placeholder, never fabricated) ──────

describe('STRESS mod-telemetry / default context under faulted first record', () => {
  it('events before setContext carry the honest unassigned key even when the first clock read fails', () => {
    let calls = 0;
    const recorder = createStabilityRecorder(() => {
      calls += 1;
      if (calls === 1) throw new Error('first tick unavailable');
      return '2026-09-04T12:00:00.000Z';
    });
    recorder.record({ kind: 'session_started' });
    recorder.record({ kind: 'session_started' });
    const events: readonly StabilitySloEvent[] = recorder.events();
    expect(events).toHaveLength(1);
    expect(events[0]!.userKey).toBe(UNASSIGNED_STABILITY_USER_KEY);
    expect(events[0]!.sessionKey).toBeNull();
  });
});
