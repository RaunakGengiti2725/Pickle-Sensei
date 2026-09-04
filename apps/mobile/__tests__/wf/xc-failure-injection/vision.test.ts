/**
 * xc-failure-injection-mobile — VISION / ANALYSIS PROVIDER THROWS.
 *
 * The real `runCaptureAnalysis` + `@pickle/analysis-pipeline` fusion run is
 * driven with a deterministic synthetic swing (generateSwingSequence, the same
 * fixture captureAnalysisFlow.test.ts uses). `createFusionProviders` is the
 * only mocked seam: it returns the REAL registry providers with one of them
 * wrapped so that it rejects, throws synchronously, resolves garbage or hangs.
 *
 * Invariants checked per scenario: the run settles (or is proven unbounded),
 * a provider failure NEVER becomes a scored rating, nothing is written to the
 * local database, and the server-side permit is released whenever the
 * pipeline converts the failure into a typed outcome.
 *
 * Apple Vision itself (VNDetectHumanBodyPoseRequest) runs during CAPTURE in
 * the native module; its failure modes are Apple-runtime truth and are listed
 * under blocked_external, not claimed here.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { FusionProviders } from '@pickle/analysis-pipeline';
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import type { CapturedClip } from '../../../src/camera/capture';
import {
  runScenario,
  seededRng,
  pick,
  settleWithinFakeTime,
  verdictFor,
  type Invariants,
} from '../../../scripts/failure-injection/recorder';

type ProviderKey =
  | 'phase'
  | 'biomechanics'
  | 'scorer'
  | 'faultDetector'
  | 'uncertainty'
  | 'coach';
type FaultMode = 'reject' | 'throw_sync' | 'garbage' | 'hang';

const PROVIDER_METHOD: Record<ProviderKey, string> = {
  phase: 'segmentPhases',
  biomechanics: 'extract',
  scorer: 'score',
  faultDetector: 'detectFaults',
  uncertainty: 'estimate',
  coach: 'rank',
};

const mockVision = {
  target: null as ProviderKey | null,
  mode: 'reject' as FaultMode,
  message:
    'VNDetectHumanBodyPoseRequest failed (VNErrorDomain code 9: internal error)',
  registryUnavailable: false,
  invocations: 0,
};

jest.mock('../../../src/vision/providers', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/vision/providers')
  >('../../../src/vision/providers');
  return {
    ...actual,
    createFusionProviders: (
      shotType: Parameters<typeof actual.createFusionProviders>[0],
    ) => {
      if (mockVision.registryUnavailable) {
        return {
          kind: 'unavailable' as const,
          reason:
            'A required analysis provider is missing from the model registry.',
        };
      }
      const real = actual.createFusionProviders(shotType);
      if (real.kind !== 'real' || !mockVision.target) return real;
      return {
        kind: 'real' as const,
        providers: mockInjectFault(real.providers),
      };
    },
  };
});

function mockInjectFault(providers: FusionProviders): FusionProviders {
  const key = mockVision.target as ProviderKey;
  const method = PROVIDER_METHOD[key];
  const original = providers[key] as unknown as Record<string, unknown>;
  const faulty = Object.create(original) as Record<string, unknown>;
  faulty[method] = (..._args: unknown[]) => {
    mockVision.invocations += 1;
    switch (mockVision.mode) {
      case 'reject':
        return Promise.reject(new Error(mockVision.message));
      case 'throw_sync':
        throw new Error(mockVision.message);
      case 'garbage':
        return Promise.resolve({ ok: true, value: null });
      case 'hang':
        return new Promise<never>(() => {});
    }
  };
  return { ...providers, [key]: faulty } as FusionProviders;
}

jest.mock('../../../src/camera/capture', () => {
  const actual = jest.requireActual('../../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});
let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

import { runCaptureAnalysis } from '../../../src/analysis/runCaptureAnalysis';

const SUITE = 'vision';
const FILES = {
  runWrapper: 'packages/analysis-pipeline/src/analyzeCapture.ts:147-179',
  phaseGate: 'packages/analysis-pipeline/src/analyzeCapture.ts:325-328',
  permitReserve: 'apps/mobile/src/analysis/runCaptureAnalysis.ts:255-280',
  permitReleaseFailed: 'apps/mobile/src/analysis/runCaptureAnalysis.ts:346-351',
  rethrow: 'apps/mobile/src/analysis/runCaptureAnalysis.ts:137-142',
  registryUnavailable: 'apps/mobile/src/analysis/runCaptureAnalysis.ts:250-253',
  screenCatch: 'apps/mobile/src/screens/AnalyzeScreen.tsx:955-965',
};
const owner = '33333333-3333-4333-8333-333333333333';

interface RecordedCall {
  sql: string;
  params: unknown[];
}
function recordingDb(): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function permitServer(): {
  fetchMock: jest.Mock;
  reserved: number;
  finalized: { outcome: string }[];
} {
  const state = {
    fetchMock: jest.fn(),
    reserved: 0,
    finalized: [] as { outcome: string }[],
  };
  state.fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      state.reserved += 1;
      return jsonResponse({
        permit: {
          id: `permit-${state.reserved}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-29T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      state.finalized.push(
        JSON.parse(String(init?.body)) as { outcome: string },
      );
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return state;
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-fi.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/stroke-fi.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    captureId: 'capture-fi-1',
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

type RunResult =
  | { settled: 'resolved'; kind: string; reason: string | null }
  | { settled: 'rejected'; message: string };

async function runOnce(): Promise<{
  result: RunResult;
  calls: RecordedCall[];
  server: ReturnType<typeof permitServer>;
}> {
  const { db, calls } = recordingDb();
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const server = permitServer();
  (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
  let result: RunResult;
  try {
    const outcome = await runCaptureAnalysis(request(db, clip));
    result = {
      settled: 'resolved',
      kind: outcome.kind,
      reason: 'reason' in outcome ? outcome.reason : null,
    };
  } catch (error) {
    result = {
      settled: 'rejected',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { result, calls, server };
}

function assertNothingRated(calls: RecordedCall[]) {
  expect(calls.some(c => c.sql.includes('local_analysis_record'))).toBe(false);
  expect(calls.some(c => c.sql.includes('local_shot'))).toBe(false);
  expect(calls.some(c => c.sql.includes('INSERT INTO outbox'))).toBe(false);
}

beforeEach(() => {
  jest.useRealTimers();
  setActiveDataOwner(owner);
  mockVision.target = null;
  mockVision.mode = 'reject';
  mockVision.registryUnavailable = false;
  mockVision.invocations = 0;
});
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
  jest.useRealTimers();
});

describe('xc-failure-injection — Vision/analysis provider throws', () => {
  it('VIS-00 control: the deterministic swing scores with the real providers (fixture is valid)', async () => {
    const { result, calls, server } = await runOnce();
    expect(result).toEqual({
      settled: 'resolved',
      kind: 'scored',
      reason: null,
    });
    expect(server.reserved).toBe(1);
    expect(calls.some(c => c.sql.includes('local_analysis_record'))).toBe(true);
  });

  it('VIS-01 phase provider REJECTS: typed unavailable outcome carrying the provider message, permit released as failed, nothing recorded', async () => {
    await runScenario(
      {
        id: 'VIS-01',
        failureClass: 'vision',
        suite: SUITE,
        title: 'phase.segmentPhases rejects',
        seed: 41,
        inputs: {
          target: 'phase',
          mode: 'reject',
          message: mockVision.message,
        },
        files: [FILES.runWrapper, FILES.phaseGate, FILES.permitReleaseFailed],
      },
      async () => {
        mockVision.target = 'phase';
        mockVision.mode = 'reject';
        const { result, calls, server } = await runOnce();
        expect(result.settled).toBe('resolved');
        if (result.settled !== 'resolved') throw new Error('unreachable');
        expect(result.kind).toBe('unavailable');
        expect(result.reason).toContain('VNErrorDomain code 9');
        expect(server.reserved).toBe(1);
        expect(server.finalized).toEqual([
          { outcome: 'failed', ratingId: null },
        ]);
        assertNothingRated(calls);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `outcome=unavailable reason="${result.reason}"; permit finalized failed; 0 analysis writes.`,
          expected:
            'phase_segmentation.provider_crash → typed permanent failure → unavailable.',
        };
      },
    );
  });

  it('VIS-02 scorer REJECTS after phase+biomechanics succeeded: still typed unavailable, permit released, no partial record persisted', async () => {
    await runScenario(
      {
        id: 'VIS-02',
        failureClass: 'vision',
        suite: SUITE,
        title: 'scorer.score rejects mid-pipeline',
        seed: 42,
        inputs: { target: 'scorer', mode: 'reject' },
        files: [FILES.runWrapper, FILES.permitReleaseFailed],
      },
      async () => {
        mockVision.target = 'scorer';
        mockVision.mode = 'reject';
        const { result, calls, server } = await runOnce();
        expect(result).toMatchObject({
          settled: 'resolved',
          kind: 'unavailable',
        });
        expect(server.finalized).toEqual([
          { outcome: 'failed', ratingId: null },
        ]);
        assertNothingRated(calls);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: 'unavailable; permit failed; no partial analysis record.',
          expected:
            'Mid-pipeline provider failure is typed, never partially persisted.',
        };
      },
    );
  });

  it("VIS-03 phase provider THROWS SYNCHRONOUSLY: bypasses the pipeline's .catch, runCaptureAnalysis rejects and the reserved permit is never released client-side", async () => {
    await runScenario(
      {
        id: 'VIS-03',
        failureClass: 'vision',
        suite: SUITE,
        title: 'phase.segmentPhases throws synchronously',
        seed: 43,
        inputs: { target: 'phase', mode: 'throw_sync' },
        files: [
          FILES.runWrapper,
          FILES.rethrow,
          FILES.permitReleaseFailed,
          FILES.screenCatch,
        ],
      },
      async () => {
        mockVision.target = 'phase';
        mockVision.mode = 'throw_sync';
        const { result, calls, server } = await runOnce();
        expect(result.settled).toBe('rejected');
        if (result.settled !== 'rejected') throw new Error('unreachable');
        expect(result.message).toContain('VNErrorDomain code 9');
        expect(server.reserved).toBe(1);
        expect(server.finalized).toEqual([]);
        assertNothingRated(calls);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed:
            'runCaptureAnalysis rejected with the raw provider message; 1 permit reserved, 0 finalize calls (release relies on server-side expiry). AnalyzeScreen catch → error phase (stage analysis, retry).',
          expected:
            'Same typed unavailable + release as the async path — `execute().catch` only covers rejections, a synchronous throw escapes `run()`.',
        };
      },
    );
  });

  it('VIS-04 phase provider RESOLVES GARBAGE ({ok:true,value:null}): the run settles without a score and the outcome shape is recorded', async () => {
    const record = await runScenario(
      {
        id: 'VIS-04',
        failureClass: 'vision',
        suite: SUITE,
        title: 'phase.segmentPhases resolves { ok: true, value: null }',
        seed: 44,
        inputs: { target: 'phase', mode: 'garbage' },
        files: [FILES.runWrapper, FILES.rethrow],
      },
      async () => {
        mockVision.target = 'phase';
        mockVision.mode = 'garbage';
        const { result, calls, server } = await runOnce();
        expect(server.reserved).toBe(1);
        assertNothingRated(calls);
        const released = server.finalized.length === 1;
        const typed = result.settled === 'resolved';
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: typed && released ? 'safe' : 'degraded',
          observed:
            result.settled === 'resolved'
              ? `resolved kind=${result.kind} reason="${result.reason}" permitReleased=${released}`
              : `rejected "${result.message}" permitReleased=${released}`,
          expected:
            'Malformed provider output must never become a score; ideally a typed failure with permit release.',
        };
      },
    );
    expect(record.observed).not.toContain('kind=scored');
  });

  it('VIS-05 provider registry incomplete: createFusionProviders unavailable → typed reason, NO permit reserved, NO fetch', async () => {
    await runScenario(
      {
        id: 'VIS-05',
        failureClass: 'vision',
        suite: SUITE,
        title: 'registry cannot assemble the fusion providers',
        seed: 45,
        inputs: { registryUnavailable: true },
        files: [FILES.registryUnavailable],
      },
      async () => {
        mockVision.registryUnavailable = true;
        const { result, calls, server } = await runOnce();
        expect(result).toMatchObject({
          settled: 'resolved',
          kind: 'unavailable',
        });
        expect(server.fetchMock).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: 'unavailable before any network or DB activity.',
          expected: 'Fail before reserving a permit.',
        };
      },
    );
  });

  it('VIS-06 phase provider HANGS: runCaptureAnalysis has no deadline — unresolved after 600s of fake time (screen would stay on the analysis progress surface)', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'VIS-06',
        failureClass: 'vision',
        suite: SUITE,
        title: 'phase.segmentPhases never settles',
        seed: 46,
        inputs: { target: 'phase', mode: 'hang', fakeTimeBudgetMs: 600_000 },
        files: [FILES.runWrapper, FILES.permitReserve],
      },
      async () => {
        mockVision.target = 'phase';
        mockVision.mode = 'hang';
        const { db } = recordingDb();
        const { clip, sidecarJson } = swingClipWithSidecar();
        mockReadArtifact = async () => sidecarJson;
        const server = permitServer();
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
        const settled = await settleWithinFakeTime(
          runCaptureAnalysis(request(db, clip)),
          600_000,
          ms => jest.advanceTimersByTimeAsync(ms),
          10_000,
        );
        expect(settled.settled).toBe(false);
        expect(server.reserved).toBe(1);
        expect(mockVision.invocations).toBe(1);
        const invariants: Invariants = {
          noInfiniteSpinner: 'fail',
          noSilentFailure: 'fail',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'Promise still pending after 600s fake time with a permit reserved. Realism note: the fusion providers are deterministic TypeScript, so a genuine hang would need a provider bug; recorded as an unbounded seam, not a live defect.',
          expected: 'No JS-side deadline exists for the inference stage.',
        };
      },
    );
  });

  it('VIS-07 seeded sweep ×36: random provider × {reject, throw_sync, garbage} — the matrix records which combos are typed, which escape, which still score', async () => {
    const providers: ProviderKey[] = [
      'phase',
      'biomechanics',
      'scorer',
      'faultDetector',
      'uncertainty',
      'coach',
    ];
    const modes: FaultMode[] = ['reject', 'throw_sync', 'garbage'];
    const matrix: Record<
      string,
      {
        settled: string;
        kind: string | null;
        permitReleased: boolean;
        ratingSynced: boolean;
      }
    > = {};
    for (let seed = 400; seed < 436; seed += 1) {
      const rng = seededRng(seed);
      mockVision.target = pick(rng, providers);
      mockVision.mode = pick(rng, modes);
      mockVision.invocations = 0;
      await runScenario(
        {
          id: `VIS-07/${seed}`,
          failureClass: 'vision',
          suite: SUITE,
          title: 'randomised provider fault',
          seed,
          inputs: { target: mockVision.target, mode: mockVision.mode },
          files: [FILES.runWrapper, FILES.permitReleaseFailed],
        },
        async () => {
          const { result, calls, server } = await runOnce();
          const kind = result.settled === 'resolved' ? result.kind : null;
          const ratingSynced = calls.some(c =>
            c.sql.includes('INSERT INTO outbox'),
          );
          const permitReleased = server.finalized.length === 1;
          matrix[`${mockVision.target}/${mockVision.mode}`] = {
            settled: result.settled,
            kind,
            permitReleased,
            ratingSynced,
          };
          const typed = result.settled === 'resolved';
          // faultDetector / coach are downstream of the score: their failure
          // is recorded in modelRuns but the user still receives a rating
          // with the fallback fix list — silent from the user's seat.
          const silentlyScored = kind === 'scored';
          const invariants: Invariants = {
            noInfiniteSpinner: 'pass',
            noSilentFailure: silentlyScored ? 'fail' : 'pass',
            noStoreCrash: 'pass',
          };
          return {
            invariants,
            verdict: typed && permitReleased ? 'safe' : 'degraded',
            observed: `settled=${result.settled} kind=${kind} invocations=${mockVision.invocations} permitReleased=${permitReleased} ratingSynced=${ratingSynced}${
              result.settled === 'rejected'
                ? ` message="${result.message}"`
                : ''
            }`,
            expected:
              'Typed unavailable with permit release; never a score built on a crashed provider.',
          };
        },
      );
    }
    const upstream = new Set([
      'phase',
      'biomechanics',
      'scorer',
      'uncertainty',
    ]);
    for (const [combo, row] of Object.entries(matrix)) {
      const [target = '', mode = ''] = combo.split('/');
      if (mode === 'reject' && upstream.has(target)) {
        expect(row).toMatchObject({
          settled: 'resolved',
          kind: 'unavailable',
          permitReleased: true,
          ratingSynced: false,
        });
      }
      if (mode === 'reject' && !upstream.has(target)) {
        expect(row).toMatchObject({
          settled: 'resolved',
          kind: 'scored',
          permitReleased: false,
          ratingSynced: true,
        });
      }
      if (mode === 'throw_sync') {
        expect(row).toMatchObject({
          settled: 'rejected',
          permitReleased: false,
          ratingSynced: false,
        });
      }
      // Garbage from a provider the pipeline dereferences (phase →
      // .map, biomechanics → measurements, scorer → .checkpoints) can never
      // score; garbage from uncertainty/coach/faultDetector is stored as-is
      // (uncertainty:null) — the pipeline validates none of its providers'
      // outputs, only their `ok` flag.
      if (
        mode === 'garbage' &&
        ['phase', 'biomechanics', 'scorer'].includes(target)
      ) {
        expect(row.kind).not.toBe('scored');
        expect(row.ratingSynced).toBe(false);
      }
    }
  });
});
