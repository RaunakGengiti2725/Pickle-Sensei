/**
 * STRESS · mod-capture · lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the public API of
 * src/camera/capture.ts + captureEnvelope.ts + deviceBench.ts against the
 * SIMULATED native bridge (test-support/stress/simulatedBridge.ts). The
 * invariants and the action model live in
 * test-support/stress/captureStressHarness.ts.
 *
 * Scale is env-controlled so the suite stays fast by default:
 *   STRESS_ITER=<n>        sequences to run (default 40; campaign: 2000+)
 *   STRESS_SEED_BASE=<n>   first seed (default 1); seeds are consecutive
 *   STRESS_REPLAY=<seed>   run exactly one seed (replay a recorded failure)
 *   STRESS_OUT=<dir>       artifact directory
 *                          (default <repo>/artifacts/stress/mod-capture)
 *
 * Replay any recorded seed with
 *   cd apps/mobile && STRESS_REPLAY=<seed> npx jest __tests__/stress/captureRandomizedSeeded.test.ts
 *
 * Nothing here runs a camera, AVFoundation, Vision or a device: results
 * are JS-boundary logic evidence only (docs/devin/TEST_MATRIX.md).
 */
jest.mock('react-native', () => {
  // The simulated bridge lives in its own module so the harness can type it;
  // the factory may only reach it through require (jest.mock is hoisted).
  const { createSimulatedBridge } = jest.requireActual<
    typeof import('../../test-support/stress/simulatedBridge')
  >('../../test-support/stress/simulatedBridge');
  const sim = createSimulatedBridge();
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: sim.bridge },
    NativeEventEmitter: sim.NativeEventEmitter,
    __sim: sim,
  };
});

import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  generateActions,
  MAX_SEQUENCE_LENGTH,
  MIN_SEQUENCE_LENGTH,
  minimizeActions,
  runActions,
  runSequence,
  stableJson,
  traceKey,
  type Action,
  type HarnessEnv,
  type InvariantFailure,
  type SequenceResult,
} from '../../test-support/stress/captureStressHarness';
import type { SimulatedBridge } from '../../test-support/stress/simulatedBridge';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see __tests__/matrix/networkAuthMatrix.test.ts), so the shims
// stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number; external: number };
};
const { mkdirSync, writeFileSync } = jest.requireActual<{
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
}>('fs');
const { join } = jest.requireActual<{ join: (...parts: string[]) => string }>(
  'path',
);

const ITER = Number(process.env.STRESS_ITER ?? 40);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1);
const REPLAY = process.env.STRESS_REPLAY;
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(__dirname, '..', '..', '..', '..', 'artifacts', 'stress', 'mod-capture');
const FLAKE_RERUNS = 10;

const { __sim: sim } = jest.requireMock('react-native') as {
  __sim: SimulatedBridge;
};
const env: HarnessEnv = { sim, stability: stabilitySlo };

interface SeedOutcome {
  seed: number;
  length: number;
  steps: number;
  ok: boolean;
  invariant: string | null;
  failedStep: number | null;
  deterministic: boolean;
  traceHash: string;
  replay: string;
}

interface FailureRecord {
  seed: number;
  failure: InvariantFailure;
  trace: SequenceResult['trace'];
  minimized: {
    actions: Action[];
    steps: number;
    failure: InvariantFailure | null;
    ddminRuns: number;
  };
  flakeRate: { failed: number; runs: number };
  replay: string;
}

function hash(text: string): string {
  // FNV-1a 32-bit, hex — enough to compare two traces of one seed.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const replayCommand = (seed: number) =>
  `cd apps/mobile && STRESS_REPLAY=${seed} npx jest __tests__/stress/captureRandomizedSeeded.test.ts`;

describe('STRESS mod-capture · randomized-seeded', () => {
  const seeds: number[] = REPLAY
    ? [Number(REPLAY)]
    : Array.from({ length: ITER }, (_v, i) => SEED_BASE + i);

  it(
    `holds every invariant over ${seeds.length} seeded sequences (length ${MIN_SEQUENCE_LENGTH}–${MAX_SEQUENCE_LENGTH}), replays deterministically, minimizes failures`,
    async () => {
      const startedAt = Date.now();
      const outcomes: SeedOutcome[] = [];
      const failures: FailureRecord[] = [];
      const byKind: Record<string, number> = {};
      const mutationCoverage: Record<string, number> = {};
      const invariantHits: Record<string, number> = {};
      let totalSteps = 0;
      let clipsAccepted = 0;
      let clipsRejected = 0;
      let nativeCalls = 0;
      let eventsDelivered = 0;
      let benchFinalizeOk = 0;
      let benchFinalizeThrew = 0;
      let nonDeterministic = 0;

      for (const seed of seeds) {
        const actions = generateActions(seed);
        for (const action of actions) {
          const response = 'response' in action ? action.response : null;
          if (response && 'applied' in response) {
            for (const id of response.applied)
              mutationCoverage[id] = (mutationCoverage[id] ?? 0) + 1;
          }
        }
        const first = await runActions(actions, env, seed);
        const second = await runActions(generateActions(seed), env, seed);
        const deterministic = traceKey(first) === traceKey(second);
        if (!deterministic) nonDeterministic += 1;

        totalSteps += first.stats.steps;
        clipsAccepted += first.stats.clipsAccepted;
        clipsRejected += first.stats.clipsRejected;
        nativeCalls += first.stats.nativeCalls;
        eventsDelivered += first.stats.eventsDelivered;
        benchFinalizeOk += first.stats.benchFinalizeOk;
        benchFinalizeThrew += first.stats.benchFinalizeThrew;
        for (const [kind, n] of Object.entries(first.stats.byKind))
          byKind[kind] = (byKind[kind] ?? 0) + n;

        const failure = first.failures[0] ?? null;
        if (failure)
          invariantHits[failure.invariant] =
            (invariantHits[failure.invariant] ?? 0) + 1;
        outcomes.push({
          seed,
          length: first.length,
          steps: first.stats.steps,
          ok: first.ok && deterministic,
          invariant:
            failure?.invariant ?? (deterministic ? null : 'I-DETERMINISM'),
          failedStep: failure?.step ?? null,
          deterministic,
          traceHash: hash(traceKey(first)),
          replay: replayCommand(seed),
        });

        if (failure) {
          const minimized = await minimizeActions(
            actions,
            env,
            seed,
            failure.invariant,
          );
          let failed = 0;
          for (let r = 0; r < FLAKE_RERUNS; r++) {
            const rerun = await runActions(generateActions(seed), env, seed);
            if (!rerun.ok) failed += 1;
          }
          failures.push({
            seed,
            failure,
            trace: first.trace,
            minimized: {
              actions: minimized.actions,
              steps: minimized.actions.length,
              failure: minimized.result.failures[0] ?? null,
              ddminRuns: minimized.runs,
            },
            flakeRate: { failed, runs: FLAKE_RERUNS },
            replay: replayCommand(seed),
          });
        } else if (!deterministic) {
          failures.push({
            seed,
            failure: {
              invariant: 'I-DETERMINISM',
              step: -1,
              kind: 'emit',
              detail: 'same seed produced two different traces',
              params: '',
            },
            trace: first.trace,
            minimized: { actions: [], steps: 0, failure: null, ddminRuns: 0 },
            flakeRate: { failed: 0, runs: 0 },
            replay: replayCommand(seed),
          });
        }
      }

      const suffix = REPLAY ? `-seed-${REPLAY}` : '';
      const summary = {
        unit: 'mod-capture',
        lens: 'randomized-seeded',
        startedAtIso: new Date(startedAt).toISOString(),
        wallMs: Date.now() - startedAt,
        seedBase: seeds[0] ?? null,
        sequencesRequested: seeds.length,
        sequencesExecuted: outcomes.length,
        sequencesFailed: failures.length,
        nonDeterministic,
        totalSteps,
        minLength: Math.min(...outcomes.map(o => o.length)),
        maxLength: Math.max(...outcomes.map(o => o.length)),
        actionsByKind: byKind,
        clipsAccepted,
        clipsRejected,
        nativeCalls,
        eventsDelivered,
        benchFinalizeOk,
        benchFinalizeThrew,
        mutationCoverage,
        invariantHits,
        heap: process.memoryUsage(),
        replayHint: replayCommand(seeds[0] ?? 1),
      };
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(
        join(OUT_DIR, `summary${suffix}.json`),
        JSON.stringify(summary, null, 2),
      );
      writeFileSync(
        join(OUT_DIR, `seed-outcomes${suffix}.json`),
        JSON.stringify(outcomes, null, 2),
      );
      writeFileSync(
        join(OUT_DIR, `failures${suffix}.json`),
        stableJson(failures) ?? '[]',
      );
      if (REPLAY) {
        const only = await runSequence(Number(REPLAY), env);
        writeFileSync(
          join(OUT_DIR, `trace${suffix}.json`),
          JSON.stringify(only.trace, null, 2),
        );
      }

      // Scale contract: every requested seed ran to completion or to its
      // first invariant violation, lengths within the lens bounds.
      expect(outcomes).toHaveLength(seeds.length);
      for (const outcome of outcomes) {
        expect(outcome.length).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
        expect(outcome.length).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
      }
      // Same seed twice → identical trace.
      expect(nonDeterministic).toBe(0);
      // Every invariant held after every step. A failure here IS a finding:
      // its seed, minimized action list and replay command are in
      // <STRESS_OUT>/failures.json.
      expect(
        failures.map(f => ({
          seed: f.seed,
          invariant: f.failure.invariant,
          detail: f.failure.detail,
          minimizedSteps: f.minimized.steps,
          flakeRate: f.flakeRate,
        })),
      ).toEqual([]);
    },
    30 * 60 * 1000,
  );

  it('generates only in-bounds action sequences and generation is a pure function of the seed', () => {
    for (const seed of seeds.slice(0, Math.min(seeds.length, 200))) {
      const a = generateActions(seed);
      const b = generateActions(seed);
      expect(a.length).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
      expect(a.length).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
      expect(stableJson(a)).toBe(stableJson(b));
    }
    if (seeds.length >= 2) {
      expect(stableJson(generateActions(seeds[0] as number))).not.toBe(
        stableJson(generateActions(seeds[1] as number)),
      );
    }
  });
});

describe('STRESS mod-capture · device denial without a bridge', () => {
  // Builds without PickleVideoCapture (or a non-mobile platform) must report
  // unavailable honestly and never throw from the passive entry points.
  const load = (platform: string, withBridge: boolean) => {
    let mod: typeof import('../../src/camera/capture') | null = null;
    // The suite-level react-native mock is already instantiated in the main
    // registry and jest serves that instance ahead of any later factory, so
    // drop the registries first. The campaign above keeps its own module
    // references and is unaffected.
    jest.resetModules();
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: platform },
        NativeModules: withBridge
          ? {
              PickleVideoCapture: {
                capture: () => Promise.resolve(null),
                cancel: () => undefined,
              },
            }
          : {},
        NativeEventEmitter: class {
          addListener() {
            return { remove: () => undefined };
          }
        },
      }));
      mod =
        require('../../src/camera/capture') as typeof import('../../src/camera/capture');
    });
    return mod as unknown as typeof import('../../src/camera/capture');
  };

  it('no native module: every availability probe is false, every op rejects with the documented message, subscribe/cancel are no-ops', async () => {
    const capture = load('ios', false);
    expect(capture.cameraAvailable()).toBe(false);
    expect(capture.sessionCaptureAvailable()).toBe(false);
    expect(capture.videoImportAvailable()).toBe(false);
    expect(capture.importedPoseExtractionAvailable()).toBe(false);
    await expect(capture.captureStrokeVideo()).rejects.toThrow(
      'Real guided camera capture is not available on this device.',
    );
    await expect(capture.importStrokeVideo()).rejects.toThrow(
      'Real video import is not available on this device.',
    );
    await expect(capture.startSessionCapture()).rejects.toThrow(
      'Native session capture is not available on this device.',
    );
    await expect(capture.stopSessionCapture('sc-1')).rejects.toThrow(
      'Native session capture is not available on this device.',
    );
    await expect(
      capture.extractSessionEventClip('sc-1', {
        startMs: 0,
        endMs: 1,
        peakMs: null,
        confidence: 1,
        detectionModelVersion: 'v1',
      }),
    ).rejects.toThrow(
      'Native session clip extraction is not available on this device.',
    );
    await expect(capture.setCaptureCompletionStrategy('fixed')).rejects.toThrow(
      'Completion strategy switching is not available in this build.',
    );
    expect(() => capture.cancelCameraOperation()).not.toThrow();
    const unsubscribe = capture.subscribeToCameraEvents(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it('non-mobile platform with a bridge present: availability is still false', () => {
    const capture = load('web', true);
    expect(capture.cameraAvailable()).toBe(false);
    expect(capture.sessionCaptureAvailable()).toBe(false);
    expect(capture.videoImportAvailable()).toBe(false);
    expect(capture.importedPoseExtractionAvailable()).toBe(false);
  });
});
