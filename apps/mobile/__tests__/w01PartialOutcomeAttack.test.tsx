/**
 * W01-05 ADVERSARIAL — failure boundaries of the mechanics-only PARTIAL
 * outcome (candidate 4277a655).
 *
 * Every test states the product invariant the work package promises and
 * drives the candidate through a boundary the happy-path suite does not
 * visit: the shipping original-operation path, the technique-confirmation
 * continuation replay, concurrent double submit, refusal-message boundary
 * values, a local commit failure between the settled refusal and the record
 * write, retryable transport failures, corrupt persisted partial state and an
 * interleaved account switch.
 *
 * Real pipeline + real migrated SQLite; only the sidecar read and HTTP are
 * simulated (same seams as w01PartialOutcome.test.tsx).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CanonicalAccessState } from '../src/billing/types';
import type {
  CapturedClip,
  CurrentClipBytesResult,
} from '../src/camera/capture';
import type { LocalDb } from '../src/data/db';
import {
  createCaptureAnalysisDb,
  captureDbState,
  signInCaptureOwner,
  closeCaptureHarness,
  seedCaptureRequest,
  fixtureUuid,
} from '../testSupport/captureAnalysisHarness';

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};
let mockVerifyBytes: (
  clip: CapturedClip,
) => Promise<CurrentClipBytesResult> = async () => ({ status: 'unavailable' });
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
    verifyCapturedClipCurrentBytes: (clip: CapturedClip) =>
      mockVerifyBytes(clip),
  };
});

let mockCurrentDb: () => LocalDb = () => {
  throw new Error('db mock not configured');
};
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockLoadSequence = jest.fn();
jest.mock('../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));
const mockTriggerOutboxSync = jest.fn();
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: () => mockTriggerOutboxSync(),
}));
const mockListCatalogDrills = jest.fn();
jest.mock('../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));
const mockConsistencyState = {
  refresh: jest.fn(async () => {}),
  daySecured: null as unknown,
  consumeDaySecured: jest.fn(() => null),
};
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement(View, { testID: props.testID }, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});
jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

import {
  prepareOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { useAccessStore } from '../src/state/accessStore';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
const otherOwner = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://api.test';
const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';
const SERVER_MESSAGE =
  'Validated ratings are not available right now. No rating was counted.';

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function refusalBody(message: unknown = SERVER_MESSAGE) {
  return {
    error: { code: RELEASE_NOT_AUTHORIZED_CODE, message },
    release: { status: 'ineligible', reasonCode: 'unreleased' },
  };
}

/** Release authority refuses admission: a settled verdict, not an outage. */
function releaseNotAuthorizedServer(
  message: unknown = SERVER_MESSAGE,
  onReserve: () => void = () => {},
) {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) {
      onReserve();
      return jsonResponse(refusalBody(message), 409);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

/** Normal permit authority (reserve + finalize both succeed). */
function permitServer() {
  const urls: string[] = [];
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) {
      reservations += 1;
      return jsonResponse(
        {
          permit: {
            id: `77777777-7777-4777-8777-${String(reservations).padStart(12, '0')}`,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: '2026-09-09T20:00:00.000Z',
          },
        },
        200,
      );
    }
    if (url.includes('/finalize')) return jsonResponse({ ok: true }, 200);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/w01-attack.mov',
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-08T12:00:00.000Z',
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
      poseModelVersion: sequence.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs - window.startMs,
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
      uri: 'file:///captures/w01-attack.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip, label: string) {
  return {
    db,
    ...seedCaptureRequest(db, clip, label),
    clip,
    declaredStroke: 'forehand_drive' as const,
    declaredCanonical: 'FOREHAND_DRIVE' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: ORIGIN, token: 'token-w01-attack' },
    appVersion: '0.1.0',
  };
}

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

const localShotInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT OR REPLACE INTO local_shot'));
const outboxInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT INTO outbox'));
const reserveCalls = (urls: string[]) =>
  urls.filter(url => url.endsWith('/v1/analysis-permits'));

const mounted: ReactTestRenderer[] = [];
const leases: OriginalAnalysisExecution[] = [];

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderResult(analysisId: string) {
  mockRouteParams = { analysisId };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
  });
  await settle();
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function snapshotAccess() {
  return JSON.parse(JSON.stringify(useAccessStore.getState().canonicalAccess));
}

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
});
afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  for (const lease of leases.splice(0)) lease.dispose();
  useAccessStore.getState().reset();
  closeCaptureHarness();
  setFetch(undefined);
});

describe('W01-05 ATTACK — partial outcome failure boundaries', () => {
  // ── ATTACK 1: the shipping AnalyzeScreen path ────────────────────────────
  // AnalyzeScreen runs every signed-in, pose-backed capture through
  // prepareOriginalCaptureAnalysis + runOriginalCaptureAnalysis (the
  // original-operation path), not through runCaptureAnalysis. The objective
  // is phrased as behaviour of the shipping product, so the settled 409 must
  // settle as a non-chargeable PARTIAL there too.
  it('ATTACK 1 — the original-operation path (shipping AnalyzeScreen) delivers the mechanics-only partial on the settled 409', async () => {
    const { db, calls } = createCaptureAnalysisDb();
    mockCurrentDb = () => db;
    const { clip: bare, sidecarJson } = swingClipWithSidecar();
    // A saved camera capture carries its byte identity; the original
    // operation refuses to admit a clip without one (original_unverifiable).
    const clip: CapturedClip = {
      ...bare,
      byteSize: 25,
      nativeMediaIdentity: {
        schemaVersion: 1,
        format: 'pickle.native-media-identity.v1',
        receiptId: fixtureUuid('attack-original-receipt'),
        operationId: fixtureUuid('attack-original-native-op'),
        origin: 'native_export',
        algorithm: 'sha256',
        videoFileName: 'w01-attack.mov',
        byteSize: 25,
        sha256: sha256Hex('synthetic attack movie bytes'),
      },
    };
    mockReadArtifact = async () => sidecarJson;
    mockVerifyBytes = async () => ({
      status: 'verified-current-bytes',
      comparedExpectation: clip.nativeMediaIdentity!,
    });
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'attack-original');
    // AnalyzeScreen records the declared stroke on the capture row before it
    // prepares the original operation (repository.setDeclaredStroke).
    await db.execute(
      'UPDATE local_capture SET declared_stroke = ? WHERE id = ?',
      ['forehand_drive', req.captureId],
    );
    const execution = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      ORIGIN,
    );
    leases.push(execution);
    const logicalOperationId = fixtureUuid('attack-original-logical');
    const operation = await prepareOriginalCaptureAnalysis(
      { ...req, ownerContext: execution.ownerContext },
      execution,
      logicalOperationId,
    );
    const before = snapshotAccess();

    const outcome = await runOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });

    // Never chargeable, whatever else happens.
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);

    // The promised behaviour: mechanics delivered as an explicit partial.
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.record.result).toBeNull();
    expect(outcome.record.partialOutcome.reasonCode).toBe(
      RELEASE_NOT_AUTHORIZED_CODE,
    );
    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(
      state.captures.map(row => (row as { status: string }).status),
    ).toEqual(['analyzed']);
  });

  // ── ATTACK 2: technique-confirmation continuation replay ────────────────
  // An AUTO DETECT run that needs confirmation reserves under a live permit;
  // the continuation reserves again and now meets the settled 409. The
  // implementer claims replays of that continuation return the durable
  // partial. Replaying the same continuation must not hold a settled
  // non-chargeable outcome as "recovery pending".
  it('ATTACK 2 — replaying a technique-confirmation continuation that settled as partial returns the durable partial', async () => {
    const { db, calls } = createCaptureAnalysisDb();
    mockCurrentDb = () => db;
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const permits = permitServer();
    setFetch(permits.fetchMock);
    const base = request(db, clip, 'attack-continuation');
    const autoRequest: RunCaptureAnalysisRequest = {
      ...base,
      declaredStroke: null,
      declaredCanonical: null,
    };
    delete (autoRequest as { operationId?: string }).operationId;
    const first = await runCaptureAnalysis(autoRequest);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;

    const refusal = releaseNotAuthorizedServer();
    setFetch(refusal.fetchMock);
    const confirmed: RunCaptureAnalysisRequest = {
      ...autoRequest,
      declaredStroke: 'dink',
      declaredCanonical: 'BACKHAND_DINK',
      techniqueConfirmation: {
        analysisId: first.analysisId,
        intent: {
          version: 'technique-intent-v1',
          source: 'tap',
          canonical: 'BACKHAND_DINK',
          legacySlug: 'dink',
          confidence: 1,
        },
        confirmedAtIso: '2026-09-08T12:05:00.000Z',
      },
    };
    const before = snapshotAccess();
    const continuation = await runCaptureAnalysis(confirmed);
    expect(continuation.kind).toBe('partial');
    if (continuation.kind !== 'partial') return;
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(reserveCalls(refusal.urls)).toHaveLength(1);

    const replay = await runCaptureAnalysis(confirmed);
    expect(reserveCalls(refusal.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
    expect(replay.kind).toBe('partial');
    if (replay.kind !== 'partial') return;
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(continuation.analysisId);
  });

  // ── ATTACK 3: concurrent double submit of the same operation ────────────
  it('ATTACK 3 — a concurrent double submit reserves once, delivers one partial, and the settled replay follows', async () => {
    const { db, calls } = createCaptureAnalysisDb();
    mockCurrentDb = () => db;
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'attack-concurrent');
    const before = snapshotAccess();

    const [a, b] = await Promise.all([
      runCaptureAnalysis(req),
      runCaptureAnalysis(req),
    ]);
    const outcomes = [a, b].sort((x, y) => x.kind.localeCompare(y.kind));
    expect(outcomes.map(outcome => outcome.kind)).toEqual([
      'partial',
      'unavailable',
    ]);
    expect(
      outcomes[1]!.kind === 'unavailable' ? outcomes[1]!.cause : null,
    ).toBe('recovery_pending');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);

    const replay = await runCaptureAnalysis(req);
    expect(replay.kind).toBe('partial');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
  });

  // ── ATTACK 4: refusal message boundary values ───────────────────────────
  // The client accepts any string the authority sends as `error.message`
  // (api.ts: json?.error?.message ?? statusText). Whatever the first run
  // decides, the durable replay and Result must agree with it: a partial
  // that the storage validator later rejects would silently degrade to a
  // held run and a Result with no benchmark-unavailable statement.
  it.each([
    ['empty', ''],
    ['513 characters', 'x'.repeat(513)],
    ['2000 characters (sync verdict cap)', 'y'.repeat(2000)],
  ])(
    'ATTACK 4 — a %s refusal message keeps first run, replay and Result consistent',
    async (_label, message) => {
      const { db, calls } = createCaptureAnalysisDb();
      mockCurrentDb = () => db;
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = releaseNotAuthorizedServer(message);
      setFetch(server.fetchMock);
      const req = request(db, clip, `attack-message-${message.length}`);

      const outcome = await runCaptureAnalysis(req);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(outcome.kind).toBe('partial');
      if (outcome.kind !== 'partial') return;

      const replay = await runCaptureAnalysis(req);
      expect(reserveCalls(server.urls)).toHaveLength(1);

      const renderer = await renderResult(outcome.analysisId);
      const status = hostByTestId(renderer, 'result-benchmark-status');
      const copy = allText(renderer);
      expect(copy).not.toContain('out of 10');
      expect(copy).not.toMatch(/\d+\s*%/);
      // Both surfaces must agree with the first run's settled verdict.
      expect({
        replay: replay.kind === 'unavailable' ? replay.cause : replay.kind,
        partialSection: hostByTestId(renderer, 'result-partial-benchmark')
          .length,
        benchmarkStatus: status.map(node => node.props.children),
        label: copy.includes('BENCHMARK UNAVAILABLE'),
        kicker: copy.includes('RATING NOT CONSUMED'),
      }).toEqual({
        replay: 'partial',
        partialSection: 1,
        benchmarkStatus: [TECHNIQUE_BENCHMARK_UNAVAILABLE],
        label: true,
        kicker: true,
      });
    },
  );

  // ── ATTACK 5: local commit failure after the settled refusal ────────────
  // The authority already settled (journal terminal, 409). If the mechanics
  // record write fails, nothing durable exists yet: no charge is at stake,
  // so the retry of the same operation must be able to deliver the partial
  // — a settled, non-chargeable run must not be held forever.
  it('ATTACK 5 — a failed record write between the settled refusal and the commit leaves the retry able to deliver the partial', async () => {
    const { db, calls, failNext } = createCaptureAnalysisDb();
    mockCurrentDb = () => db;
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'attack-crash');
    const before = snapshotAccess();
    const seededStatus = captureDbState(db).captures.map(
      row => (row as { status: string }).status,
    );
    const failure = new Error('disk I/O error (simulated process death)');
    failNext('INTO local_analysis_record', failure);

    const first = await runCaptureAnalysis(req).catch((error: unknown) => ({
      kind: 'threw' as const,
      error,
    }));
    expect(
      calls.some(call => call.sql.includes('INTO local_analysis_record')),
    ).toBe(true);
    // Nothing chargeable, nothing half-written.
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const afterFailure = captureDbState(db);
    expect(afterFailure.records).toBe(0);
    expect(
      afterFailure.captures.map(row => (row as { status: string }).status),
    ).toEqual(seededStatus);
    expect(snapshotAccess()).toEqual(before);
    // AnalyzeScreen catches a thrown run; either way nothing was delivered.
    expect(first.kind).not.toBe('partial');

    const retry = await runCaptureAnalysis(req);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(retry.kind).toBe('partial');
    expect(captureDbState(db).records).toBe(1);
  });

  // ── ATTACK 6: retryable transport failures must never become partial ────
  it.each([
    [
      '429 with Retry-After',
      () =>
        jsonResponse(
          { error: { code: 'rate.limited', message: 'Slow down.' } },
          429,
          { 'retry-after': '30' },
        ),
    ],
    [
      '503',
      () =>
        jsonResponse(
          { error: { code: 'server.unavailable', message: 'Try later.' } },
          503,
        ),
    ],
    [
      'network failure',
      () => {
        throw new TypeError('Network request failed');
      },
    ],
    [
      '409 with a different code',
      () =>
        jsonResponse(
          { error: { code: 'access.permit_not_reserved', message: 'Gone.' } },
          409,
        ),
    ],
    [
      '409 release code with a non-JSON body',
      () =>
        ({
          ok: false,
          status: 409,
          statusText: 'Conflict',
          json: async () => {
            throw new SyntaxError('Unexpected token');
          },
        }) as unknown as Response,
    ],
  ])(
    'ATTACK 6 — %s on reserve never settles as partial and never writes a record',
    async (_label, respond) => {
      const { db, calls } = createCaptureAnalysisDb();
      mockCurrentDb = () => db;
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const urls: string[] = [];
      setFetch(
        jest.fn(async (url: string) => {
          urls.push(url);
          if (url.endsWith('/v1/analysis-permits')) return respond();
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      const req = request(db, clip, `attack-transport-${_label}`);
      const before = snapshotAccess();
      const seededStatus = captureDbState(db).captures.map(
        row => (row as { status: string }).status,
      );

      const outcome = await runCaptureAnalysis(req);
      expect(outcome.kind).toBe('unavailable');
      expect(reserveCalls(urls)).toHaveLength(1);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      const state = captureDbState(db);
      expect(state.records).toBe(0);
      expect(state.shots).toBe(0);
      expect(
        state.captures.map(row => (row as { status: string }).status),
      ).toEqual(seededStatus);
      expect(state.journal).toHaveLength(1);
      expect((state.journal[0] as { permit_id: unknown }).permit_id).toBeNull();
      expect(snapshotAccess()).toEqual(before);
    },
  );

  // ── ATTACK 7: corrupt persisted partial state ───────────────────────────
  it.each([
    [
      'a fabricated scored result spliced into the partial record',
      (record: Record<string, unknown>) => ({
        ...record,
        result: {
          id: record.id,
          resultKind: 'scored',
          overallScore: 9.4,
          shotType: 'forehand_drive',
        },
      }),
    ],
    [
      'a marker rewritten as chargeable',
      (record: Record<string, unknown>) => ({
        ...record,
        partialOutcome: {
          ...(record.partialOutcome as Record<string, unknown>),
          billingDisposition: 'chargeable',
        },
      }),
    ],
    [
      'a marker with status flipped to scored',
      (record: Record<string, unknown>) => ({
        ...record,
        partialOutcome: {
          ...(record.partialOutcome as Record<string, unknown>),
          status: 'scored',
        },
      }),
    ],
    [
      'a record re-bound to another capture',
      (record: Record<string, unknown>) => ({
        ...record,
        captureId: '88888888-8888-4888-8888-888888888888',
      }),
    ],
    ['truncated JSON', () => '{"schemaVersion":1,"partialOutcome":{'],
  ])(
    'ATTACK 7 — %s never replays as scored or as a fresh reservation',
    async (_label, corrupt) => {
      const { db, calls, native } = createCaptureAnalysisDb();
      mockCurrentDb = () => db;
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = releaseNotAuthorizedServer();
      setFetch(server.fetchMock);
      const req = request(db, clip, `attack-corrupt-${_label}`);
      const outcome = await runCaptureAnalysis(req);
      expect(outcome.kind).toBe('partial');
      if (outcome.kind !== 'partial') return;

      const row = native
        .prepare('SELECT record FROM local_analysis_record WHERE id = ?')
        .get(outcome.analysisId) as { record: string };
      const tampered = corrupt(JSON.parse(row.record));
      native
        .prepare('UPDATE local_analysis_record SET record = ? WHERE id = ?')
        .run(
          typeof tampered === 'string' ? tampered : JSON.stringify(tampered),
          outcome.analysisId,
        );
      const before = snapshotAccess();

      const replay = await runCaptureAnalysis(req);
      expect(replay.kind).not.toBe('scored');
      expect(replay.kind).not.toBe('low_confidence');
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      expect(captureDbState(db).shots).toBe(0);
      expect(snapshotAccess()).toEqual(before);
      if (replay.kind === 'partial') {
        // Only an intact marker may be replayed as partial.
        expect(replay.record.partialOutcome).toEqual(
          outcome.record.partialOutcome,
        );
        expect(replay.record.result).toBeNull();
        expect(replay.record.captureId).toBe(req.captureId);
      }
    },
  );

  // ── ATTACK 8: interleaved account switch during the reservation ─────────
  it('ATTACK 8 — an account switch while the refusal is in flight writes nothing under either owner', async () => {
    const { db, calls } = createCaptureAnalysisDb();
    mockCurrentDb = () => db;
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer(SERVER_MESSAGE, () => {
      setActiveDataOwner(otherOwner);
    });
    setFetch(server.fetchMock);
    const req = request(db, clip, 'attack-account-switch');
    const before = snapshotAccess();
    const seededStatus = captureDbState(db).captures.map(
      row => (row as { status: string }).status,
    );

    const outcome = await runCaptureAnalysis(req);
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' ? outcome.cause : null).toBe(
      'account_changed',
    );
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const state = captureDbState(db);
    expect(state.records).toBe(0);
    expect(state.shots).toBe(0);
    expect(
      state.captures.map(row => (row as { status: string }).status),
    ).toEqual(seededStatus);
    expect(
      state.journal.map(row => (row as { owner_key: string }).owner_key),
    ).toEqual([owner]);
    expect(snapshotAccess()).toEqual(before);

    // The other account never inherits the first owner's settled refusal.
    signInCaptureOwner(otherOwner, ORIGIN);
    const foreign = await runCaptureAnalysis({
      ...req,
      ownerContext: captureDataOwnerContext(),
    }).catch((error: unknown) => ({ kind: 'threw' as const, error }));
    expect(foreign.kind).not.toBe('partial');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);
    expect(captureDbState(db).shots).toBe(0);
  });
});
