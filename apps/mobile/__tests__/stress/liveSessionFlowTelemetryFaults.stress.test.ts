/**
 * STRESS mod-telemetry / failure-injection — the `session_flow_failed`
 * stability emitter in LiveSessionFlow (src/flow/session.ts) with every
 * dependency of the live session faulted at its seam:
 *   - Vision / analysis provider (`analyzeEvent`): reject, sync throw,
 *     malformed outcome, partial outcome, slow, never, honest abstain/pending
 *   - clip source (per-event pose/clip extraction): reject, sync throw,
 *     malformed, partial, slow, never
 *   - TTS: a LiveSessionCoach driven from the onUpdate subscriber whose voice
 *     port throws on `speak` / `available` / `stop`
 *   - onUpdate subscriber (navigation/UI): throws always or intermittently
 *   - clock: Date.now faulted (throw / NaN) while the module clock stamps
 *     events
 *
 * Invariants (per seed, replayable with STRESS_SEED=<n>):
 *   - pushSample / end / snapshot never throw because of a faulted dependency;
 *   - every stability event is a well-formed `session_flow_failed` with a
 *     bounded enum reason, never carrying the dependency's message;
 *   - `snapshot.onUpdateFailures` equals the number of
 *     `on_update_subscriber_failed` records (no silent loss, no double count);
 *   - a rejecting/throwing provider yields `analysis_dispatch_failed` and an
 *     'abstained' event — never 'ready' without an analysis (no fake success);
 *   - settled dependencies never leave an event in 'processing' (no infinite
 *     spinner) — a never-settling dependency leaves it 'processing' honestly,
 *     and that gap is recorded (`hungDependencyInvisible`);
 *   - recorder reset restores an empty, usable recorder (no corrupted state).
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';
import {
  LiveSessionFlow,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventClipSource,
  type SessionMotionSample,
} from '../../src/flow/session';
import {
  LiveSessionCoach,
  type CoachVoicePort,
} from '../../src/flow/liveSessionCoach';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  pick,
  recordStress,
  sensitiveHits,
  stabilityEventViolations,
  stressSeeds,
  seededRandom,
  tally,
} from '../../testing/stress/faultInjection';

const SUITE = 'mod-telemetry';
const samples: SessionMotionSample[] = fixture.wristSamples;
const EVENT_IDS = ['E1', 'E2', 'E3'] as const;

const DEPENDENCY_MESSAGE =
  'VNDetectHumanBodyPoseRequest failed: /var/mobile/Containers/Data/Application/1234/tmp/session-E2.pose.json';

// ─── Fault modes ────────────────────────────────────────────────────────────

const PROVIDER_FAULTS = [
  'ready',
  'abstained',
  'pending',
  'reject',
  'throw_sync',
  'malformed_status',
  'partial_ready',
  'slow_5s',
  'never',
] as const;
type ProviderFault = (typeof PROVIDER_FAULTS)[number];

const CLIP_FAULTS = [
  'none',
  'ok',
  'unavailable',
  'reject',
  'throw_sync',
  'malformed',
  'partial',
  'slow_2s',
  'never',
] as const;
type ClipFault = (typeof CLIP_FAULTS)[number];

const SUBSCRIBER_FAULTS = [
  'none',
  'ok',
  'throw_always',
  'throw_intermittent',
  'tts_speak_throws',
  'tts_available_throws',
  'tts_ok',
] as const;
type SubscriberFault = (typeof SUBSCRIBER_FAULTS)[number];

const CLOCK_FAULTS = ['ok', 'throw_intermittent', 'nan'] as const;
type ClockFault = (typeof CLOCK_FAULTS)[number];

interface Plan {
  provider: Record<(typeof EVENT_IDS)[number], ProviderFault>;
  clip: ClipFault;
  subscriber: SubscriberFault;
  clock: ClockFault;
}

function planFor(seed: number): Plan {
  const random = seededRandom(seed);
  const provider = {
    E1: pick(random, PROVIDER_FAULTS),
    E2: pick(random, PROVIDER_FAULTS),
    E3: pick(random, PROVIDER_FAULTS),
  };
  const clip = random() < 0.4 ? 'none' : pick(random, CLIP_FAULTS);
  const subscriber = pick(random, SUBSCRIBER_FAULTS);
  const clock = random() < 0.7 ? 'ok' : pick(random, CLOCK_FAULTS);
  return { provider, clip, subscriber, clock };
}

// ─── Doubles ────────────────────────────────────────────────────────────────

function analysisRecordDouble(id: string): AnalysisRecord {
  return {
    schemaVersion: 1,
    id,
    captureId: `capture-${id}`,
    createdAtIso: '2026-01-01T00:00:00.000Z',
    engineVersion: 'test-double',
    strokeTaxonomyVersion: 'test-double',
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    provenance: {
      appVersion: 'test-double',
      pipelineVersion: 'test-double',
      providerVersions: [
        {
          providerId: 'test-double',
          modelVersion: 'test-double',
          runtime: 'deterministic',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      ],
      scoreVersion: 'test-double',
      taxonomyVersion: 'test-double',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: '2026-01-01T00:00:00.000Z',
    },
    result: null,
    faults: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      perCheckpoint: {},
      limitingFactors: ['TEST_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  };
}

function outcomeFor(
  fault: ProviderFault,
  eventId: string,
): Promise<SessionEventAnalysisOutcome> {
  switch (fault) {
    case 'ready':
      return Promise.resolve({
        status: 'ready',
        analysis: analysisRecordDouble(`analysis-${eventId}`),
      });
    case 'abstained':
      return Promise.resolve({
        status: 'abstained',
        abstainReason: 'LOW_POSE_COVERAGE',
      });
    case 'pending':
      return Promise.resolve({
        status: 'pending',
        pendingReason: 'PROVIDER_BUSY',
      });
    case 'reject':
      return Promise.reject(new Error(DEPENDENCY_MESSAGE));
    case 'throw_sync':
      throw new TypeError("Cannot read properties of null (reading 'frames')");
    case 'malformed_status':
      return Promise.resolve({
        status: 'scored',
      } as unknown as SessionEventAnalysisOutcome);
    case 'partial_ready':
      return Promise.resolve({
        status: 'ready',
      } as unknown as SessionEventAnalysisOutcome);
    case 'slow_5s':
      return new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              status: 'ready',
              analysis: analysisRecordDouble(`analysis-${eventId}`),
            }),
          5_000,
        ),
      );
    case 'never':
      return new Promise(() => {});
  }
}

function providerFor(plan: Plan): SessionEventAnalysisProvider {
  return {
    providerId: 'stress-vision-provider',
    availability: () => ({ status: 'available' }),
    analyzeEvent: request =>
      outcomeFor(
        plan.provider[request.eventId as (typeof EVENT_IDS)[number]] ?? 'ready',
        request.eventId,
      ),
  };
}

function clipSourceFor(fault: ClipFault): SessionEventClipSource | undefined {
  if (fault === 'none') return undefined;
  return {
    sourceId: `stress-clip-source-${fault}`,
    extract: () => {
      switch (fault) {
        case 'ok':
          return Promise.resolve({
            status: 'extracted' as const,
            clip: null as never,
            poseSequenceSlice: null,
          });
        case 'unavailable':
          return Promise.resolve({
            status: 'unavailable' as const,
            pendingReason: 'SESSION_CLIP_EXTRACTION_FAILED: ring buffer empty',
          });
        case 'reject':
          return Promise.reject(new Error(DEPENDENCY_MESSAGE));
        case 'throw_sync':
          throw new RangeError('Invalid array length');
        case 'malformed':
          return Promise.resolve({
            status: 'done',
          } as unknown as Awaited<
            ReturnType<SessionEventClipSource['extract']>
          >);
        case 'partial':
          return Promise.resolve({
            status: 'extracted',
          } as unknown as Awaited<
            ReturnType<SessionEventClipSource['extract']>
          >);
        case 'slow_2s':
          return new Promise(resolve =>
            setTimeout(
              () =>
                resolve({
                  status: 'extracted' as const,
                  clip: null as never,
                  poseSequenceSlice: null,
                }),
              2_000,
            ),
          );
        case 'never':
        default:
          return new Promise(() => {});
      }
    },
  };
}

function voiceFor(fault: SubscriberFault): CoachVoicePort {
  return {
    available: () => {
      if (fault === 'tts_available_throws') {
        throw new Error('AVSpeechSynthesizer unavailable');
      }
      return true;
    },
    speak: () => {
      if (fault === 'tts_speak_throws') {
        throw new Error('PickleAudioCoach.speak: native module is null');
      }
      return true;
    },
    stop: () => undefined,
  };
}

function subscriberFor(
  fault: SubscriberFault,
  random: () => number,
): {
  onUpdate?: (snapshot: LiveSessionSnapshot) => void;
  calls: () => number;
  throws: () => number;
} {
  let calls = 0;
  let throws = 0;
  const count = () => calls;
  const thrown = () => throws;
  if (fault === 'none') return { calls: count, throws: thrown };
  const coach =
    fault === 'tts_speak_throws' ||
    fault === 'tts_available_throws' ||
    fault === 'tts_ok'
      ? new LiveSessionCoach({ voice: voiceFor(fault) })
      : null;
  const onUpdate = (snapshot: LiveSessionSnapshot) => {
    calls += 1;
    try {
      switch (fault) {
        case 'ok':
          return;
        case 'throw_always':
          throw new Error('setState on unmounted LiveSessionScreen');
        case 'throw_intermittent':
          if (random() < 0.3) {
            throw new Error('navigation.setParams: no navigator');
          }
          return;
        default:
          coach!.consumeSnapshot(snapshot);
      }
    } catch (error) {
      throws += 1;
      throw error;
    }
  };
  return { onUpdate, calls: count, throws: thrown };
}

const SETTLING: ReadonlySet<ProviderFault> = new Set([
  'ready',
  'abstained',
  'pending',
  'reject',
  'throw_sync',
  'malformed_status',
  'partial_ready',
  'slow_5s',
]);

let realDateNow: () => number;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  realDateNow = Date.now;
  stabilitySlo.reset();
  stabilitySlo.setContext({ userKey: 'stress-user', sessionKey: 'stress-s' });
});

afterEach(() => {
  Date.now = realDateNow;
  stabilitySlo.reset();
  jest.useRealTimers();
});

async function drain(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
  await drain();
}

describe('STRESS mod-telemetry / LiveSessionFlow session_flow_failed emitter under faulted Vision provider, clip source, TTS, subscriber, clock', () => {
  for (const seed of stressSeeds('liveSessionFlowTelemetryFaults', 24)) {
    const plan = planFor(seed);
    it(`seed ${seed} — provider=${plan.provider.E1}/${plan.provider.E2}/${plan.provider.E3} clip=${plan.clip} subscriber=${plan.subscriber} clock=${plan.clock}`, async () => {
      await recordStress(
        SUITE,
        'liveSessionFlowTelemetryFaults',
        seed,
        { ...plan },
        async note => {
          const random = seededRandom(seed ^ 0x5bd1e995);
          if (plan.clock === 'nan') {
            Date.now = () => NaN;
          } else if (plan.clock === 'throw_intermittent') {
            let n = 0;
            Date.now = () => {
              n += 1;
              if (n % 3 === 0) throw new Error('clock unavailable');
              return realDateNow();
            };
          }
          const subscriber = subscriberFor(plan.subscriber, random);
          const clipSource = clipSourceFor(plan.clip);
          const flow = new LiveSessionFlow({
            sessionId: `stress-${seed}`,
            source: 'replay',
            startedAtIso: '2026-01-01T00:00:00.000Z',
            provider: providerFor(plan),
            ...(clipSource ? { clipSource } : {}),
            ...(subscriber.onUpdate ? { onUpdate: subscriber.onUpdate } : {}),
          });

          let pushThrew: string | null = null;
          try {
            for (const sample of samples) flow.pushSample(sample);
          } catch (error) {
            pushThrew = error instanceof Error ? error.message : String(error);
          }
          let endThrew: string | null = null;
          try {
            flow.end();
          } catch (error) {
            endThrew = error instanceof Error ? error.message : String(error);
          }

          // Settle everything that can settle, then push the fake clock 60s.
          let settledFlag = false;
          void flow.settled().then(() => {
            settledFlag = true;
          });
          await drain();
          await advance(60_000);

          const snapshot = flow.snapshot();
          const states = Object.fromEntries(
            snapshot.events.map(e => [e.eventId, e.state]),
          );
          const readyWithoutAnalysis = snapshot.events.filter(
            e => e.state === 'ready' && !e.analysis,
          ).length;
          const stillProcessing = snapshot.events.filter(
            e => e.state === 'processing',
          );
          const stability = [...stabilitySlo.events()];
          const stabilityTally = tally(stability);
          const reasons = tally(
            stability.map(e => ({
              kind: e.kind === 'session_flow_failed' ? e.reason : 'other',
            })),
            'kind',
          );
          const expectHang =
            plan.clip === 'never' ||
            (plan.clip !== 'unavailable' &&
              plan.clip !== 'reject' &&
              plan.clip !== 'throw_sync' &&
              EVENT_IDS.some(id => plan.provider[id] === 'never'));

          note({
            pushThrew,
            endThrew,
            settled: settledFlag,
            states,
            readyWithoutAnalysis,
            stillProcessing: stillProcessing.map(e => e.eventId),
            pendingReasons: snapshot.events
              .filter(e => e.state === 'pending')
              .map(e => e.pendingReason),
            abstainReasons: snapshot.events
              .filter(e => e.state === 'abstained')
              .map(e => e.abstainReason),
            onUpdateCalls: subscriber.calls(),
            onUpdateThrows: subscriber.throws(),
            onUpdateFailures: snapshot.onUpdateFailures,
            stability: stabilityTally,
            reasons,
            hungDependencyInvisible:
              stillProcessing.length > 0 &&
              (stabilityTally['session_flow_failed'] ?? 0) === 0,
            sensitiveHits: sensitiveHits(
              stability as unknown as Array<Record<string, unknown>>,
            ).map(h => `${h.field}:${h.pattern}`),
          });

          // Dependencies never take down the motion feed.
          expect(pushThrew).toBeNull();
          expect(endThrew).toBeNull();
          expect(snapshot.events).toHaveLength(3);

          // Telemetry shape + privacy: bounded enum reasons only.
          expect(
            stabilityEventViolations(stability, { requireParsableAt: false }),
          ).toEqual([]);
          expect(stability.every(e => e.kind === 'session_flow_failed')).toBe(
            true,
          );
          for (const e of stability) {
            if (e.kind !== 'session_flow_failed') continue;
            expect([
              'analysis_dispatch_failed',
              'on_update_subscriber_failed',
            ]).toContain(e.reason);
            expect(JSON.stringify(e)).not.toContain('/var/mobile');
          }
          expect(
            sensitiveHits(
              stability as unknown as Array<Record<string, unknown>>,
            ),
          ).toEqual([]);

          // Subscriber failures are counted exactly once each, never lost.
          expect(snapshot.onUpdateFailures).toBe(subscriber.throws());
          expect(reasons['on_update_subscriber_failed'] ?? 0).toBe(
            subscriber.throws(),
          );

          // Per-event honesty.
          const clipBlocksProvider =
            plan.clip === 'unavailable' ||
            plan.clip === 'reject' ||
            plan.clip === 'throw_sync';
          for (const id of EVENT_IDS) {
            const fault = plan.provider[id];
            const event = snapshot.events.find(e => e.eventId === id)!;
            if (plan.clip === 'never') {
              expect(event.state).toBe('processing');
              continue;
            }
            if (clipBlocksProvider) {
              // Extraction failed → honest pending, provider never consulted.
              expect(event.state).toBe('pending');
              expect(event.pendingReason).toContain(
                'SESSION_CLIP_EXTRACTION_FAILED',
              );
              expect(event.analysis).toBeNull();
              continue;
            }
            if (plan.clip === 'malformed' || plan.clip === 'partial') {
              // Contract-violating extraction: recorded above, only the
              // "no fake success" half is asserted here.
              expect(readyWithoutAnalysis).toBe(0);
              if (event.state === 'ready') {
                expect(event.analysis).not.toBeNull();
              }
              continue;
            }
            switch (fault) {
              case 'ready':
              case 'slow_5s':
                expect(event.state).toBe('ready');
                expect(event.analysis?.id).toBe(`analysis-${id}`);
                break;
              case 'abstained':
                expect(event.state).toBe('abstained');
                expect(event.abstainReason).toBe('LOW_POSE_COVERAGE');
                break;
              case 'pending':
                expect(event.state).toBe('pending');
                expect(event.pendingReason).toBe('PROVIDER_BUSY');
                break;
              case 'reject':
              case 'throw_sync':
                expect(event.state).toBe('abstained');
                expect(event.abstainReason).toContain(
                  'ANALYSIS_DISPATCH_FAILED',
                );
                expect(event.analysis).toBeNull();
                break;
              case 'partial_ready':
                // The engine refuses 'ready' without an AnalysisRecord: the
                // contract violation becomes a counted dispatch failure and
                // an honest abstain, never a fake ready.
                expect(event.state).toBe('abstained');
                expect(event.abstainReason).toContain(
                  'ANALYSIS_DISPATCH_FAILED',
                );
                expect(event.analysis).toBeNull();
                break;
              case 'malformed_status':
                // Unknown status falls through to the honest 'pending' arm.
                expect(event.state).toBe('pending');
                expect(event.analysis).toBeNull();
                break;
              case 'never':
                expect(event.state).toBe('processing');
                expect(event.analysis).toBeNull();
                break;
            }
          }
          const dispatchFailures = EVENT_IDS.filter(
            id =>
              !clipBlocksProvider &&
              plan.clip !== 'never' &&
              (plan.provider[id] === 'reject' ||
                plan.provider[id] === 'throw_sync' ||
                plan.provider[id] === 'partial_ready'),
          ).length;
          if (plan.clip !== 'malformed' && plan.clip !== 'partial') {
            expect(reasons['analysis_dispatch_failed'] ?? 0).toBe(
              dispatchFailures,
            );
          }
          if (!expectHang) {
            expect(stillProcessing).toEqual([]);
            expect(settledFlag).toBe(true);
          } else {
            expect(settledFlag).toBe(false);
          }
          expect(
            snapshot.events.every(
              e =>
                SETTLING.has(
                  plan.provider[e.eventId as (typeof EVENT_IDS)[number]],
                ) ||
                plan.clip === 'never' ||
                clipBlocksProvider ||
                e.state === 'processing',
            ),
          ).toBe(true);

          // Recorder recovers: reset yields an empty, writable recorder.
          stabilitySlo.reset();
          expect(stabilitySlo.events()).toEqual([]);
          Date.now = realDateNow;
          stabilitySlo.record({
            kind: 'session_flow_failed',
            reason: 'on_update_subscriber_failed',
          });
          expect(stabilitySlo.events()).toHaveLength(1);
          return {};
        },
      );
    });
  }
});

describe('STRESS mod-telemetry / LiveSessionFlow pinned observations', () => {
  it('TTS speak throwing inside the coach is isolated by notify(): counted, recorded as on_update_subscriber_failed, event states intact', async () => {
    await recordStress(
      SUITE,
      'liveSessionFlowTelemetryFaults.pinned',
      1,
      { subscriber: 'tts_speak_throws', provider: 'ready' },
      async note => {
        const coach = new LiveSessionCoach({
          voice: voiceFor('tts_speak_throws'),
        });
        const flow = new LiveSessionFlow({
          sessionId: 'stress-tts',
          source: 'replay',
          provider: providerFor({
            provider: { E1: 'ready', E2: 'ready', E3: 'ready' },
            clip: 'none',
            subscriber: 'tts_speak_throws',
            clock: 'ok',
          }),
          onUpdate: snapshot => coach.consumeSnapshot(snapshot),
        });
        for (const sample of samples) flow.pushSample(sample);
        flow.end();
        await flow.settled();
        const snapshot = flow.snapshot();
        const reasons = tally(stabilitySlo.events(), 'reason');
        note({
          states: snapshot.events.map(e => e.state),
          onUpdateFailures: snapshot.onUpdateFailures,
          reasons,
        });
        expect(snapshot.events.map(e => e.state)).toEqual([
          'ready',
          'ready',
          'ready',
        ]);
        expect(snapshot.onUpdateFailures).toBeGreaterThan(0);
        expect(reasons['on_update_subscriber_failed']).toBe(
          snapshot.onUpdateFailures,
        );
        return {};
      },
    );
  });

  it('provider.availability() throwing is NOT isolated: pushSample propagates it to the motion feed (recorded observation, in-process provider contract)', async () => {
    await recordStress(
      SUITE,
      'liveSessionFlowTelemetryFaults.pinned',
      2,
      { provider: 'availability_throws' },
      async note => {
        const flow = new LiveSessionFlow({
          sessionId: 'stress-availability',
          source: 'replay',
          provider: {
            providerId: 'stress-availability-throws',
            availability: () => {
              throw new Error('CoreML model failed to load');
            },
            analyzeEvent: () => new Promise(() => {}),
          },
        });
        let thrown: string | null = null;
        try {
          for (const sample of samples) flow.pushSample(sample);
        } catch (error) {
          thrown = error instanceof Error ? error.message : String(error);
        }
        const stability = tally(stabilitySlo.events());
        note({ thrown, stability, events: flow.snapshot().events.length });
        expect(thrown).toBe('CoreML model failed to load');
        expect(stability).toEqual({});
        return {};
      },
    );
  });
});
