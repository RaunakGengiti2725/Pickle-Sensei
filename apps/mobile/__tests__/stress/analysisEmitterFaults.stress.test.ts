/**
 * STRESS mod-telemetry / failure-injection — the `analysis_*` stability
 * emitter (`runCaptureAnalysis`) under faulted dependencies.
 *
 * The REAL analysis pipeline, permit client and module-level `stabilitySlo`
 * recorder run; only the unit's dependency boundaries are faked so each
 * fault lands at an exact statement:
 *   - fetch / API   (permit reserve + release): reject / sync throw / hang
 *                   honouring abort (→ 20s network.timeout) / hang IGNORING
 *                   abort / malformed JSON / partial permit / 401 / 402 /
 *                   500 / slow / empty permit id / not-reserved
 *   - Vision sidecar (readCaptureArtifact): reject / malformed / truncated /
 *                   hash mismatch / slow / never
 *   - SQLite (LocalDb.execute): throw on the record insert, the promotion
 *                   insert, COMMIT, every statement / slow / first call hangs
 *   - evaluation-consent queue write (also SQLite): throws
 *
 * Invariants asserted on EVERY seed (`STRESS_SEED=<n>` replays one):
 *   - exactly one `analysis_started` per run; the terminal event matches the
 *     outcome honestly — completed ONLY for scored / low_confidence /
 *     quality_blocked, failed (`failureKind` = cause | unavailable |
 *     exception) otherwise, nothing at all while the run is still pending;
 *   - a run whose API, sidecar or SQLite dependency is faulted never reports
 *     `analysis_completed` and never returns `scored` (no fake success);
 *   - a resolved run never leaves a working promise (after 60s of fake time)
 *     unless a dependency ignores abort / never settles — those are recorded
 *     as `pendingAfter60s` and still carry no completion event;
 *   - `failureKind` is one of the closed set (never free text, never a
 *     dependency error message); no event carries PII / paths / pose;
 *   - permit accounting: at most one reserve, at most one release attempt,
 *     none for a scored run, exactly one for a reserved-then-not-scored run;
 *   - the module recorder itself never throws and `reset()` recovers.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
} from '../../src/analysis/runCaptureAnalysis';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { API_REQUEST_TIMEOUT_MS } from '../../src/data/api';
import type { EvaluationTelemetryContext } from '../../src/evaluation/trialCapture';
import {
  pick,
  recordStress,
  sensitiveHits,
  stabilityEventViolations,
  stressSeeds,
  seededRandom,
  tally,
} from '../../testing/stress/faultInjection';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const SUITE = 'mod-telemetry';
const owner = '44444444-4444-4444-8444-444444444444';

// ─── Dependency fault modes ─────────────────────────────────────────────────

const API_MODES = [
  'ok',
  'reject_network',
  'throw_sync',
  'hang_honours_abort',
  'hang_ignores_abort',
  'malformed_json',
  'partial_permit',
  'status_401',
  'status_402_paywall',
  'status_500',
  'slow_5s',
  'empty_permit_id',
  'not_reserved',
] as const;
type ApiMode = (typeof API_MODES)[number];

const SIDECAR_MODES = [
  'ok',
  'reject',
  'malformed_json',
  'truncated',
  'hash_mismatch',
  'slow_2s',
  'never',
] as const;
type SidecarMode = (typeof SIDECAR_MODES)[number];

const DB_MODES = [
  'ok',
  'throw_record_insert',
  'throw_local_shot',
  'throw_commit',
  'throw_all',
  'slow_50ms',
  'never_first',
] as const;
type DbMode = (typeof DB_MODES)[number];

const RELEASE_MODES = ['ok', 'reject', 'hang_honours_abort'] as const;
type ReleaseMode = (typeof RELEASE_MODES)[number];

const HEALTHY_API: ReadonlySet<ApiMode> = new Set(['ok', 'slow_5s']);
const HEALTHY_SIDECAR: ReadonlySet<SidecarMode> = new Set(['ok', 'slow_2s']);
const HEALTHY_DB: ReadonlySet<DbMode> = new Set(['ok', 'slow_50ms']);
const FAILURE_KINDS = new Set(['unavailable', 'paywall_required', 'exception']);

interface Plan {
  api: ApiMode;
  sidecar: SidecarMode;
  db: DbMode;
  release: ReleaseMode;
  consent: boolean;
}

function planFor(seed: number): Plan {
  const random = seededRandom(seed);
  // Bias toward faulted dependencies (the point of the campaign) while
  // keeping enough healthy runs to prove the scored path still completes.
  const api = random() < 0.25 ? 'ok' : pick(random, API_MODES);
  const sidecar = random() < 0.5 ? 'ok' : pick(random, SIDECAR_MODES);
  const db = random() < 0.5 ? 'ok' : pick(random, DB_MODES);
  const release = pick(random, RELEASE_MODES);
  return { api, sidecar, db, release, consent: random() < 0.3 };
}

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeServer {
  fetchMock: jest.Mock;
  reserves: number;
  releases: Array<{ permitId: string; body: unknown }>;
  releaseAttempts: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

function abortable(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
  });
}

const goodPermit = (n: number) => ({
  id: `permit-${n}`,
  accessSource: 'free',
  status: 'reserved',
  expiresAt: '2026-09-04T20:00:00.000Z',
});

function fakeServer(api: ApiMode, release: ReleaseMode): FakeServer {
  const server: FakeServer = {
    reserves: 0,
    releases: [],
    releaseAttempts: 0,
    fetchMock: jest.fn(),
  };
  server.fetchMock.mockImplementation(
    (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/v1/analysis-permits')) {
        server.reserves += 1;
        const n = server.reserves;
        switch (api) {
          case 'ok':
            return Promise.resolve(
              jsonResponse(200, { permit: goodPermit(n) }),
            );
          case 'reject_network':
            return Promise.reject(new TypeError('Network request failed'));
          case 'throw_sync':
            throw new TypeError('fetch is not a function (sync)');
          case 'hang_honours_abort':
            return abortable(init?.signal);
          case 'hang_ignores_abort':
            return new Promise<never>(() => {});
          case 'malformed_json':
            return Promise.resolve({
              ok: true,
              status: 200,
              statusText: 'OK',
              json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
              },
            } as unknown as Response);
          case 'partial_permit':
            return Promise.resolve(
              jsonResponse(200, { permit: { id: `permit-${n}` } }),
            );
          case 'status_401':
            return Promise.resolve(
              jsonResponse(401, {
                error: { code: 'auth.invalid', message: 'Session expired.' },
              }),
            );
          case 'status_402_paywall':
            return Promise.resolve(
              jsonResponse(402, {
                error: {
                  code: 'access.paywall_required',
                  message: 'Upgrade to keep rating strokes.',
                },
              }),
            );
          case 'status_500':
            return Promise.resolve(jsonResponse(500, null));
          case 'slow_5s':
            return new Promise(resolve =>
              setTimeout(
                () => resolve(jsonResponse(200, { permit: goodPermit(n) })),
                5_000,
              ),
            );
          case 'empty_permit_id':
            return Promise.resolve(
              jsonResponse(200, { permit: { ...goodPermit(n), id: '   ' } }),
            );
          case 'not_reserved':
            return Promise.resolve(
              jsonResponse(200, {
                permit: { ...goodPermit(n), status: 'consumed' },
              }),
            );
        }
      }
      const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
      if (finalize) {
        server.releaseAttempts += 1;
        switch (release) {
          case 'ok':
            server.releases.push({
              permitId: decodeURIComponent(finalize[1]!),
              body: JSON.parse(String(init?.body)),
            });
            return Promise.resolve(jsonResponse(200, { ok: true }));
          case 'reject':
            return Promise.reject(new TypeError('Network request failed'));
          case 'hang_honours_abort':
            return abortable(init?.signal);
        }
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    },
  );
  return server;
}

interface RecordedCall {
  sql: string;
}

function fakeDb(mode: DbMode): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const error = new Error(
    'SQLITE_CANTOPEN: unable to open database file /var/mobile/Containers/Data/Application/ABC/Library/pickle.db',
  );
  const db: LocalDb = {
    async execute(sql) {
      const index = calls.length;
      calls.push({ sql });
      const s = sql.trim();
      switch (mode) {
        case 'ok':
          return { rows: [] };
        case 'throw_record_insert':
          if (s.startsWith('INSERT INTO local_analysis_record')) throw error;
          return { rows: [] };
        case 'throw_local_shot':
          if (s.includes('INSERT OR REPLACE INTO local_shot')) throw error;
          return { rows: [] };
        case 'throw_commit':
          if (s === 'COMMIT') throw error;
          return { rows: [] };
        case 'throw_all':
          throw error;
        case 'slow_50ms':
          await new Promise(resolve => setTimeout(resolve, 50));
          return { rows: [] };
        case 'never_first':
          if (index === 0) return new Promise(() => {});
          return { rows: [] };
      }
    },
    close() {},
  };
  return { db, calls };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stress-telemetry.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
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
      uri: 'file:///captures/stress-telemetry.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function sidecarReader(
  mode: SidecarMode,
  sidecarJson: string,
): (uri: string) => Promise<string> {
  switch (mode) {
    case 'ok':
      return async () => sidecarJson;
    case 'reject':
      return async () => {
        throw new Error(
          'ENOENT: no such file /var/mobile/Containers/Data/Application/ABC/Documents/captures/x.pose.json',
        );
      };
    case 'malformed_json':
      return async () => '{"schemaVersion":1,"frames":[{';
    case 'truncated':
      return async () =>
        sidecarJson.slice(0, Math.floor(sidecarJson.length / 2));
    case 'hash_mismatch':
      return async () => sidecarJson.replace(/"fps":\s*\d+/, '"fps": 61');
    case 'slow_2s':
      return () =>
        new Promise(resolve => setTimeout(() => resolve(sidecarJson), 2_000));
    case 'never':
      return () => new Promise(() => {});
  }
}

const { clip: CLIP, sidecarJson: SIDECAR } = swingClipWithSidecar();

const CONSENT: EvaluationTelemetryContext = {
  consentActive: true,
  dims: {
    userPseudonym: 'stress-u',
    sessionId: 'stress-s',
    courtId: null,
    deviceModel: 'iPhone15,2',
    devicePlatform: 'ios',
    osVersion: '17.5',
  },
};

function request(db: LocalDb, consent: boolean) {
  return {
    db,
    captureId: 'capture-stress',
    clip: CLIP,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    ...(consent ? { evaluationTelemetry: CONSENT } : {}),
  };
}

type Settled =
  | { state: 'resolved'; outcome: CaptureAnalysisOutcome }
  | { state: 'rejected'; message: string }
  | { state: 'pending' };

/** Runs the analysis under fake timers, advancing 60s of fake time in steps
 * so timer-based dependencies (API abort at 20s, slow resolutions) fire. */
async function settleWithin60s(
  run: Promise<CaptureAnalysisOutcome>,
): Promise<Settled> {
  let settled: Settled = { state: 'pending' };
  void run.then(
    outcome => {
      settled = { state: 'resolved', outcome };
    },
    (error: unknown) => {
      settled = {
        state: 'rejected',
        message: error instanceof Error ? error.message : String(error),
      };
    },
  );
  for (let elapsed = 0; elapsed <= 60_000 && settled.state === 'pending';) {
    await jest.advanceTimersByTimeAsync(1_000);
    elapsed += 1_000;
  }
  return settled;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  setActiveDataOwner(owner);
  stabilitySlo.reset();
  stabilitySlo.setContext({ userKey: 'stress-user', sessionKey: 'stress-s' });
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
  stabilitySlo.reset();
  jest.useRealTimers();
});

describe('STRESS mod-telemetry / analysis_* emitter under faulted fetch, sidecar, SQLite', () => {
  for (const seed of stressSeeds('analysisEmitterFaults', 24)) {
    const plan = planFor(seed);
    it(`seed ${seed} — api=${plan.api} sidecar=${plan.sidecar} db=${plan.db} release=${plan.release}`, async () => {
      await recordStress(
        SUITE,
        'analysisEmitterFaults',
        seed,
        { ...plan },
        async note => {
          const server = fakeServer(plan.api, plan.release);
          (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
          mockReadArtifact = sidecarReader(plan.sidecar, SIDECAR);
          const { db, calls } = fakeDb(plan.db);

          const settled = await settleWithin60s(
            runCaptureAnalysis(request(db, plan.consent)),
          );
          const events = [...stabilitySlo.events()];
          const kinds = tally(events);
          const observed: Record<string, unknown> = {
            settled: settled.state,
            outcomeKind:
              settled.state === 'resolved' ? settled.outcome.kind : null,
            cause:
              settled.state === 'resolved' &&
              settled.outcome.kind === 'unavailable'
                ? (settled.outcome.cause ?? null)
                : null,
            rejected: settled.state === 'rejected' ? settled.message : null,
            events: kinds,
            failureKinds: events
              .filter(e => e.kind === 'analysis_failed')
              .map(e => (e.kind === 'analysis_failed' ? e.failureKind : '')),
            reserves: server.reserves,
            releaseAttempts: server.releaseAttempts,
            releases: server.releases.map(r => r.body),
            sqlStatements: calls.length,
            pendingAfter60s: settled.state === 'pending',
          };
          note(observed);

          // Shape + privacy of everything the emitter recorded.
          expect(stabilityEventViolations(events)).toEqual([]);
          expect(
            sensitiveHits(events as unknown as Array<Record<string, unknown>>),
          ).toEqual([]);
          for (const e of events) {
            if (e.kind === 'analysis_failed') {
              expect(FAILURE_KINDS.has(e.failureKind)).toBe(true);
            }
          }

          // Exactly one start; the terminal event matches the outcome.
          expect(kinds['analysis_started']).toBe(1);
          const completed = kinds['analysis_completed'] ?? 0;
          const failed = kinds['analysis_failed'] ?? 0;
          if (settled.state === 'pending') {
            expect(completed + failed).toBe(0);
          } else if (settled.state === 'rejected') {
            expect(completed).toBe(0);
            expect(failed).toBe(1);
            expect(observed['failureKinds']).toEqual(['exception']);
          } else if (settled.outcome.kind === 'unavailable') {
            expect(completed).toBe(0);
            expect(failed).toBe(1);
            expect(observed['failureKinds']).toEqual([
              settled.outcome.cause ?? 'unavailable',
            ]);
          } else {
            expect(completed).toBe(1);
            expect(failed).toBe(0);
          }

          // No fake success: a faulted API / sidecar / SQLite never yields a
          // scored outcome or a completion event.
          const faulted =
            !HEALTHY_API.has(plan.api) ||
            !HEALTHY_SIDECAR.has(plan.sidecar) ||
            !HEALTHY_DB.has(plan.db);
          if (faulted) {
            expect(completed).toBe(0);
            expect(observed['outcomeKind']).not.toBe('scored');
          } else if (settled.state === 'resolved') {
            expect(settled.outcome.kind).toBe('scored');
            expect(completed).toBe(1);
          }

          // Paywall is surfaced as its own honest failure kind.
          if (
            plan.api === 'status_402_paywall' &&
            settled.state === 'resolved'
          ) {
            expect(observed['cause']).toBe('paywall_required');
          }

          // Permit accounting: ≤1 reserve, ≤1 release attempt; a scored run
          // never releases; a reserved-but-not-scored run releases once.
          expect(server.reserves).toBeLessThanOrEqual(1);
          expect(server.releaseAttempts).toBeLessThanOrEqual(1);
          const reservedOk = server.reserves === 1 && HEALTHY_API.has(plan.api);
          if (settled.state !== 'pending' && reservedOk) {
            if (observed['outcomeKind'] === 'scored') {
              expect(server.releaseAttempts).toBe(0);
            } else {
              expect(server.releaseAttempts).toBe(1);
            }
          }

          // The recorder is still usable after the run.
          expect(() =>
            stabilitySlo.record({ kind: 'camera_startup_succeeded' }),
          ).not.toThrow();
          stabilitySlo.reset();
          expect(stabilitySlo.events()).toHaveLength(0);
          return {};
        },
      );
    });
  }
});

describe('STRESS mod-telemetry / analysis emitter — pinned dependency faults', () => {
  it('fetch hangs but honours abort → network.timeout after API_REQUEST_TIMEOUT_MS, analysis_failed(unavailable), no completion', async () => {
    await recordStress(
      SUITE,
      'analysisEmitterFaults.pinned',
      1,
      { api: 'hang_honours_abort' },
      async note => {
        const server = fakeServer('hang_honours_abort', 'ok');
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
        mockReadArtifact = sidecarReader('ok', SIDECAR);
        const run = runCaptureAnalysis(request(fakeDb('ok').db, false));
        let resolved: CaptureAnalysisOutcome | null = null;
        void run.then(o => {
          resolved = o;
        });
        await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS - 1);
        expect(resolved).toBeNull();
        await jest.advanceTimersByTimeAsync(2);
        await Promise.resolve();
        const outcome = resolved as CaptureAnalysisOutcome | null;
        note({
          outcome: outcome?.kind ?? null,
          events: tally(stabilitySlo.events()),
        });
        expect(outcome?.kind).toBe('unavailable');
        expect(tally(stabilitySlo.events())).toEqual({
          analysis_started: 1,
          analysis_failed: 1,
        });
        return {};
      },
    );
  });

  it('fetch ignores abort entirely → the run is still pending after 60s with only analysis_started recorded (honest: no fake terminal event)', async () => {
    await recordStress(
      SUITE,
      'analysisEmitterFaults.pinned',
      2,
      { api: 'hang_ignores_abort' },
      async note => {
        const server = fakeServer('hang_ignores_abort', 'ok');
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
        mockReadArtifact = sidecarReader('ok', SIDECAR);
        const settled = await settleWithin60s(
          runCaptureAnalysis(request(fakeDb('ok').db, false)),
        );
        note({ settled: settled.state, events: tally(stabilitySlo.events()) });
        expect(settled.state).toBe('pending');
        expect(tally(stabilitySlo.events())).toEqual({ analysis_started: 1 });
        return {};
      },
    );
  });

  it('SQLite failure message carrying a filesystem path never reaches the stability event (failureKind stays "exception")', async () => {
    await recordStress(
      SUITE,
      'analysisEmitterFaults.pinned',
      3,
      { db: 'throw_record_insert' },
      async note => {
        const server = fakeServer('ok', 'ok');
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
        mockReadArtifact = sidecarReader('ok', SIDECAR);
        const settled = await settleWithin60s(
          runCaptureAnalysis(request(fakeDb('throw_record_insert').db, false)),
        );
        const events = [...stabilitySlo.events()];
        note({
          settled: settled.state,
          rejected: settled.state === 'rejected' ? settled.message : null,
          events: tally(events),
          releases: server.releases.map(r => r.body),
        });
        expect(settled.state).toBe('rejected');
        expect(JSON.stringify(events)).not.toContain('/var/mobile');
        expect(
          sensitiveHits(events as unknown as Array<Record<string, unknown>>),
        ).toEqual([]);
        expect(tally(events)).toEqual({
          analysis_started: 1,
          analysis_failed: 1,
        });
        expect(server.releases.map(r => r.body)).toEqual([
          { outcome: 'failed', ratingId: null },
        ]);
        return {};
      },
    );
  });

  it('evaluation-consent queue write throws → the scored outcome and analysis_completed are unaffected', async () => {
    await recordStress(
      SUITE,
      'analysisEmitterFaults.pinned',
      4,
      { consent: true, db: 'throw_evaluation_trial_outbox_insert' },
      async note => {
        const server = fakeServer('ok', 'ok');
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
        mockReadArtifact = sidecarReader('ok', SIDECAR);
        const calls: string[] = [];
        const db: LocalDb = {
          async execute(sql) {
            calls.push(sql.trim());
            if (sql.includes('evaluation.trial')) {
              throw new Error('SQLITE_FULL: database or disk is full');
            }
            return { rows: [] };
          },
          close() {},
        };
        const settled = await settleWithin60s(
          runCaptureAnalysis(request(db, true)),
        );
        const trialWrites = calls.filter(s =>
          s.includes('evaluation.trial'),
        ).length;
        note({
          settled: settled.state,
          outcomeKind:
            settled.state === 'resolved' ? settled.outcome.kind : null,
          trialWrites,
          events: tally(stabilitySlo.events()),
        });
        expect(settled.state).toBe('resolved');
        expect(trialWrites).toBeGreaterThan(0);
        expect(settled.state === 'resolved' && settled.outcome.kind).toBe(
          'scored',
        );
        expect(tally(stabilitySlo.events())).toEqual({
          analysis_started: 1,
          analysis_completed: 1,
        });
        return {};
      },
    );
  });
});
