/**
 * W01-05 adversarial attacks (round 4, candidate 1ace3523) — runner level.
 *
 * Every attack here starts from the candidate's own settled refusal (the
 * typed HTTP 409 `access.release_not_authorized` on the permit reservation)
 * and then pushes on a boundary the candidate suite does not: what the
 * Library can still see of the "recorded" mechanics, a second inference
 * failure after the settled refusal, an original-operation double submit,
 * wall-clock rollback / far-future replays, another account opening the
 * partial's Result, and a refusal message that is cut inside a surrogate
 * pair or carries a NUL byte. Same harness as the candidate suite: real
 * pipeline, real migrated SQLite (foreign keys ON); only the sidecar read,
 * the native byte verification and HTTP are simulated.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import * as pipeline from '@pickle/analysis-pipeline';
import { generateSwingSequence } from '@pickle/evaluation';
import { fail, failure } from '@pickle/shared-types';
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
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
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
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations,
} from '../src/analysis/originalAnalysisOperations';
import { captureDataOwnerContext } from '../src/data/accountScope';
import { listPendingCaptures, listShots } from '../src/data/repository';
import { useAccessStore } from '../src/state/accessStore';
import { ResultScreen } from '../src/screens/ResultScreen';

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

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function releaseNotAuthorizedServer(message: unknown = SERVER_MESSAGE) {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits'))
      return jsonResponse(
        {
          error: { code: RELEASE_NOT_AUTHORIZED_CODE, message },
          release: { status: 'ineligible', reasonCode: 'unreleased' },
        },
        409,
      );
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

function swingClipWithSidecar(label: string): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${label}.mov`,
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
      uri: `file:///captures/${label}.pose.json`,
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

const reserveCalls = (urls: string[]) =>
  urls.filter(url => url.endsWith('/v1/analysis-permits'));

const storeByDb = new Map<
  LocalDb,
  ReturnType<typeof createCaptureAnalysisDb>
>();

function testDb() {
  const store = createCaptureAnalysisDb();
  storeByDb.set(store.db, store);
  mockCurrentDb = () => store.db;
  return store;
}

function nativeOf(db: LocalDb) {
  const store = storeByDb.get(db);
  if (!store) throw new Error('unknown test db');
  return store.native;
}

function refusalRows(db: LocalDb) {
  return nativeOf(db)
    .prepare('SELECT * FROM analysis_reservation_refusal')
    .all() as Array<Record<string, unknown>>;
}

function storedRecords(db: LocalDb) {
  return nativeOf(db)
    .prepare('SELECT record FROM local_analysis_record')
    .all()
    .map(
      row =>
        JSON.parse(String((row as { record: unknown }).record)) as Record<
          string,
          unknown
        >,
    );
}

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

function allTextOf(root: ReactTestInstance): string {
  return root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function snapshotAccess() {
  return JSON.parse(JSON.stringify(useAccessStore.getState().canonicalAccess));
}

function expectPartial(outcome: RunCaptureAnalysisOutcome) {
  expect(outcome.kind).toBe('partial');
  if (outcome.kind !== 'partial') throw new Error('not a partial');
  expect(outcome.record.result).toBeNull();
  expect(outcome.record.partialOutcome).toEqual(
    expect.objectContaining({
      status: 'partial',
      billingDisposition: 'not_chargeable',
      withheld: 'technique_benchmark',
      reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
    }),
  );
  return outcome;
}

async function runPartial(label: string, message: unknown = SERVER_MESSAGE) {
  const { db, calls, failNext } = testDb();
  const { clip, sidecarJson } = swingClipWithSidecar(label);
  mockReadArtifact = async () => sidecarJson;
  const server = releaseNotAuthorizedServer(message);
  setFetch(server.fetchMock);
  const req = request(db, clip, label);
  const before = snapshotAccess();
  const outcome = await runCaptureAnalysis(req);
  return { db, calls, failNext, server, outcome, req, before };
}

/** What AnalyzeScreen does for a signed-in, pose-backed camera capture. */
async function prepareOriginal(label: string) {
  const { db, calls } = testDb();
  const { clip: bare, sidecarJson } = swingClipWithSidecar(label);
  const clip: CapturedClip = {
    ...bare,
    byteSize: 25,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: fixtureUuid(`${label}-receipt`),
      operationId: fixtureUuid(`${label}-native-op`),
      origin: 'native_export',
      algorithm: 'sha256',
      videoFileName: `${label}.mov`,
      byteSize: 25,
      sha256: sha256Hex(`synthetic movie bytes ${label}`),
    },
  };
  mockReadArtifact = async () => sidecarJson;
  mockVerifyBytes = async () => ({
    status: 'verified-current-bytes',
    comparedExpectation: clip.nativeMediaIdentity!,
  });
  const server = releaseNotAuthorizedServer();
  setFetch(server.fetchMock);
  const req: RunCaptureAnalysisRequest = request(db, clip, label);
  await db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE id = ?',
    ['forehand_drive', req.captureId],
  );
  const execution = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    ORIGIN,
  );
  leases.push(execution);
  const operation = await prepareOriginalCaptureAnalysis(
    { ...req, ownerContext: execution.ownerContext },
    execution,
    fixtureUuid(`${label}-logical`),
  );
  const run = () =>
    runOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });
  const readOperation = () =>
    originalAnalysisOperations.read(db, execution, operation.operationId);
  const readCurrentAttempt = async () => {
    const current = await readOperation();
    if (!current?.currentAttemptId)
      throw new Error('original operation has no current attempt');
    const attempt = await originalAnalysisOperations.readAttempt(
      db,
      current,
      current.currentAttemptId,
    );
    return {
      state: attempt.run.state,
      permitId: attempt.run.permitId,
      resultId: attempt.run.resultId,
      terminalReason: attempt.run.terminalReason,
      technicalFailure: attempt.technicalFailure,
      finalRecordId: current.finalRecordId,
      completionKind: current.completionKind,
    };
  };
  return { db, calls, server, req, run, readOperation, readCurrentAttempt };
}

type Settled = RunCaptureAnalysisOutcome | { kind: 'threw'; error: string };
const settleOutcome = (promise: Promise<RunCaptureAnalysisOutcome>) =>
  promise.catch((error: unknown): Settled => ({
    kind: 'threw',
    error: error instanceof Error ? error.message : String(error),
  }));

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
  mockVerifyBytes = async () => ({ status: 'unavailable' });
  jest
    .mocked(pipeline.analyzeCapture)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
        .analyzeCapture,
    );
});
afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  for (const lease of leases.splice(0)) lease.dispose();
  jest.restoreAllMocks();
  useAccessStore.getState().reset();
  closeCaptureHarness();
  storeByDb.clear();
  setFetch(undefined);
  mockListCatalogDrills.mockClear();
  mockTriggerOutboxSync.mockClear();
});

describe('W01-05 R4 attacks — runner boundaries around the settled refusal', () => {
  it('A1 "MECHANICS RECORDED" must be reachable: the Library lists the partial as a shot or as a pending capture', async () => {
    const { db, req, outcome } = await runPartial('r4-a1-library');
    const partial = expectPartial(outcome);
    const [shots, pending] = await Promise.all([
      listShots(db, 100),
      listPendingCaptures(db, 100),
    ]);
    const state = captureDbState(db);
    // LibraryScreen renders exactly these two lists. If the partial's capture
    // is in neither, the athlete has no way back to the mechanics Result
    // says were recorded.
    expect({
      captureStatus: (state.captures[0] as { status: string }).status,
      shots: shots.map(row => row.id),
      pending: pending.map(row => row.id),
      records: state.records,
      reachable:
        shots.some(row => row.id === partial.analysisId) ||
        pending.some(row => row.id === req.captureId),
    }).toEqual(expect.objectContaining({ records: 1, reachable: true }));
  });

  it('A2 original-operation double submit under the refusal: one reservation, one refusal row, one record, both callers settle', async () => {
    const { db, server, run, readCurrentAttempt } =
      await prepareOriginal('r4-a2-double');
    const before = snapshotAccess();
    const [first, second] = await Promise.all([
      settleOutcome(run()),
      settleOutcome(run()),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).not.toContain('threw');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(db)).toHaveLength(1);
    expect(storedRecords(db)).toHaveLength(1);
    expect(captureDbState(db).shots).toBe(0);
    expect(captureDbState(db).outbox).toBe(0);
    expect(snapshotAccess()).toEqual(before);
    expect(kinds).toContain('partial');
    // The loser must not be a fabricated failure: replaying afterwards
    // delivers the same durable partial without reserving again.
    const replay = expectPartial(await run());
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(await readCurrentAttempt()).toMatchObject({
      state: 'terminal',
      permitId: null,
      terminalReason: 'reservation_rejected',
      finalRecordId: replay.analysisId,
      completionKind: 'partial',
    });
  });

  it('A3 refusal settled, then the inference itself fails once: the SAME original operation resumes into the partial with zero new reservations', async () => {
    jest
      .mocked(pipeline.analyzeCapture)
      .mockResolvedValueOnce(
        fail(
          failure(
            'permanent',
            'scorer.provider_crash',
            'Transient inference failure',
          ),
        ),
      );
    const { db, server, run, readCurrentAttempt } = await prepareOriginal(
      'r4-a3-inference-after-refusal',
    );
    const before = snapshotAccess();
    const first = await settleOutcome(run());
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(db)).toHaveLength(1);
    expect(storedRecords(db)).toHaveLength(0);
    expect(captureDbState(db).shots).toBe(0);
    const afterFailure = await readCurrentAttempt();

    const second = await settleOutcome(run());
    expect({
      first: first.kind,
      afterFailure,
      second: second.kind,
      afterRetry: await readCurrentAttempt(),
      reservations: reserveCalls(server.urls).length,
      records: storedRecords(db).length,
    }).toEqual(
      expect.objectContaining({
        second: 'partial',
        reservations: 1,
        records: 1,
      }),
    );
    expect(snapshotAccess()).toEqual(before);
    expect(captureDbState(db).shots).toBe(0);
  });

  it('A4 wall clock: the durable partial replays under a far-future clock and after a rollback to the epoch without reserving again', async () => {
    const { db, server, req, outcome, before } =
      await runPartial('r4-a4-clock');
    const partial = expectPartial(outcome);
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(Date.UTC(2126, 0, 1));
    const future = expectPartial(await runCaptureAnalysis(req));
    nowSpy.mockReturnValue(0);
    const epoch = expectPartial(await runCaptureAnalysis(req));
    nowSpy.mockRestore();
    expect(
      new Set([partial.analysisId, future.analysisId, epoch.analysisId]).size,
    ).toBe(1);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(db)).toHaveLength(1);
    expect(storedRecords(db)).toHaveLength(1);
    expect(captureDbState(db).shots).toBe(0);
    expect(snapshotAccess()).toEqual(before);
    for (const row of refusalRows(db))
      expect(Number(row['created_at_ms'])).toBeGreaterThan(0);
  });

  it('A4b a clock before the epoch during replay never reserves again, never charges and never fabricates a result', async () => {
    const { db, server, req, outcome, before } = await runPartial(
      'r4-a4b-negative-clock',
    );
    expectPartial(outcome);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(-1);
    const replay = await settleOutcome(runCaptureAnalysis(req));
    nowSpy.mockRestore();
    expect(['partial', 'recovery_pending', 'threw']).toContain(replay.kind);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(db)).toHaveLength(1);
    expect(storedRecords(db)).toHaveLength(1);
    expect(captureDbState(db).shots).toBe(0);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A5 another account cannot open the partial Result: no mechanics, no partial copy, no fabricated score', async () => {
    const { outcome } = await runPartial('r4-a5-cross-owner');
    const partial = expectPartial(outcome);
    signInCaptureOwner(otherOwner, ORIGIN);
    const renderer = await renderResult(partial.analysisId);
    const copy = allTextOf(renderer.root);
    expect(copy).not.toContain('BENCHMARK UNAVAILABLE');
    expect(copy).not.toContain('MECHANICS RECORDED');
    expect(copy).not.toContain(partial.record.partialOutcome.message);
    expect(copy).not.toContain('out of 10');
    expect(copy).not.toContain('TECHNIQUE SCORE');
    expect(copy).not.toMatch(/\d+\s*%/);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.testID === 'result-partial-benchmark',
      ),
    ).toHaveLength(0);
  });

  it('A6 message cut inside a surrogate pair at the 512 bound: stored, replayed and rendered text stays well-formed UTF-16 and identical everywhere', async () => {
    const message = `${'a'.repeat(511)}\u{1F600}tail`;
    const { db, req, server, outcome } = await runPartial(
      'r4-a6-surrogate',
      message,
    );
    const partial = expectPartial(outcome);
    const stored = partial.record.partialOutcome.message;
    const row = refusalRows(db)[0]!;
    const replay = expectPartial(await runCaptureAnalysis(req));
    const renderer = await renderResult(partial.analysisId);
    expect({
      length: stored.length,
      storedWellFormed: !LONE_SURROGATE.test(stored),
      refusalRowMatches: row['message'] === stored,
      recordMatches:
        (storedRecords(db)[0]!['partialOutcome'] as { message: unknown })
          .message === stored,
      replayMatches: replay.record.partialOutcome.message === stored,
      reservations: reserveCalls(server.urls).length,
      renderedWellFormed: !LONE_SURROGATE.test(allTextOf(renderer.root)),
      tail: JSON.stringify(stored.slice(-4)),
    }).toEqual(
      expect.objectContaining({
        storedWellFormed: true,
        refusalRowMatches: true,
        recordMatches: true,
        replayMatches: true,
        reservations: 1,
        renderedWellFormed: true,
      }),
    );
    expect(stored.length).toBeLessThanOrEqual(512);
  });

  it('A7 message carrying NUL / bidi-override control characters: the durable copies agree and Result renders no control characters', async () => {
    const message = `No rating\u0000 was counted.\u202E\u0007`;
    const { db, req, server, outcome } = await runPartial(
      'r4-a7-control',
      message,
    );
    const partial = expectPartial(outcome);
    const stored = partial.record.partialOutcome.message;
    const row = refusalRows(db)[0]!;
    expect(row['message']).toBe(stored);
    expect(storedRecords(db)[0]).toMatchObject({
      partialOutcome: { message: stored },
    });
    const replay = expectPartial(await runCaptureAnalysis(req));
    expect(replay.record.partialOutcome.message).toBe(stored);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    const renderer = await renderResult(partial.analysisId);
    const controlCharacters = Array.from(allTextOf(renderer.root)).filter(
      character => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069)
        );
      },
    );
    expect(controlCharacters).toEqual([]);
  });
});
