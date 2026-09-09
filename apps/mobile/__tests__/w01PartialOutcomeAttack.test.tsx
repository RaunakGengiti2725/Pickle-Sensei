/**
 * W01-05 ADVERSARIAL ATTACKS against candidate b7b9ac7f (mechanics-only
 * PARTIAL outcome). Each `it` is one attack at a failure boundary of the
 * partial-outcome contract:
 *
 *   A1 concurrency      — double submit of the same operation under refusal
 *   A2 account switch   — owner changes between settlement and commit
 *   A3 process death    — original-operation record write fails after the
 *                         settled refusal, then the user retries
 *   A4 AUTO DETECT      — ambiguous stroke + refusal on the shipping path
 *   A5 boundary values  — non-string / blank refusal messages reach Result
 *   A6 corrupt state    — tampered journal, tampered refusal metadata,
 *                         corrupt stored record
 *   A7 account deletion — purgeOwnerData with a settled refusal row
 *   A8 offline replay   — replay/Result after restart with no network
 *
 * Attacks that expect the contract to hold assert it directly. Attacks that
 * probe a suspected break collect `observed` first and compare it with the
 * contract's `expected` in ONE assertion so the failure output documents the
 * whole state. Real pipeline + real migrated SQLite (node:sqlite, foreign
 * keys enforced); only the sidecar read, byte verification and HTTP are
 * simulated. Candidate production code and candidate tests are untouched.
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
  reconcileOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations,
} from '../src/analysis/originalAnalysisOperations';
import {
  RELEASE_NOT_AUTHORIZED_MESSAGE,
  RELEASE_NOT_AUTHORIZED_CODE,
} from '../src/analysis/partialOutcome';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { purgeOwnerData } from '../src/data/repository';
import { useAccessStore } from '../src/state/accessStore';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
const otherOwner = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://api.test';
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

function releaseNotAuthorizedServer(message: unknown = SERVER_MESSAGE) {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits'))
      return jsonResponse(refusalBody(message), 409);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

/** Device offline / authority unreachable: every request fails. */
function offlineServer() {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    throw new TypeError('Network request failed');
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

const localShotInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT OR REPLACE INTO local_shot'));
const outboxInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT INTO outbox'));
const reserveCalls = (urls: string[]) =>
  urls.filter(url => url.endsWith('/v1/analysis-permits'));
const captureStatuses = (db: LocalDb) =>
  captureDbState(db).captures.map(row => (row as { status: string }).status);

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

function expectPartialMarker(outcome: RunCaptureAnalysisOutcome) {
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

function describeOutcome(
  outcome: RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown },
) {
  if (outcome.kind === 'threw')
    return {
      kind: 'threw',
      error:
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error),
    };
  if (outcome.kind === 'unavailable')
    return { kind: 'unavailable', cause: outcome.cause ?? null };
  return { kind: outcome.kind };
}

async function settleOutcome(
  promise: Promise<RunCaptureAnalysisOutcome>,
): Promise<RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown }> {
  return promise.catch((error: unknown) => ({ kind: 'threw' as const, error }));
}

function refusalRows(db: LocalDb) {
  return stores(db)
    .native.prepare('SELECT * FROM analysis_reservation_refusal')
    .all();
}

const storeByDb = new Map<
  LocalDb,
  ReturnType<typeof createCaptureAnalysisDb>
>();
function stores(db: LocalDb) {
  const store = storeByDb.get(db);
  if (!store) throw new Error('unknown test db');
  return store;
}

function attackDb(fault?: (sql: string, index: number) => void) {
  const store = createCaptureAnalysisDb(fault);
  storeByDb.set(store.db, store);
  mockCurrentDb = () => store.db;
  return store;
}

/** What AnalyzeScreen does for a signed-in, pose-backed camera capture. */
async function prepareOriginal(
  label: string,
  options: { declaredStroke: 'forehand_drive' | null; message?: unknown } = {
    declaredStroke: 'forehand_drive',
  },
  fault?: (sql: string, index: number) => void,
) {
  const store = attackDb(fault);
  const { db, calls, failNext } = store;
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
  const server = releaseNotAuthorizedServer(options.message);
  setFetch(server.fetchMock);
  const base = request(db, clip, label);
  const req: RunCaptureAnalysisRequest =
    options.declaredStroke === null
      ? { ...base, declaredStroke: null, declaredCanonical: null }
      : base;
  await db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE id = ?',
    [options.declaredStroke, req.captureId],
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
    settleOutcome(
      runOriginalCaptureAnalysis({
        db,
        execution,
        operationId: operation.operationId,
      }),
    );
  return { db, calls, failNext, server, req, execution, operation, run, store };
}

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
  mockVerifyBytes = async () => ({ status: 'unavailable' });
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
  storeByDb.clear();
  setFetch(undefined);
  mockListCatalogDrills.mockClear();
  mockTriggerOutboxSync.mockClear();
});

describe('W01-05 attacks — mechanics-only partial outcome (candidate b7b9ac7f)', () => {
  it('A1 concurrency: a double submit of the same operation under refusal reserves once, stores one partial and charges nothing', async () => {
    const { db, calls } = attackDb();
    const { clip, sidecarJson } = swingClipWithSidecar('a1-double-submit');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'a1-double-submit');
    const before = snapshotAccess();

    const [first, second] = await Promise.all([
      settleOutcome(runCaptureAnalysis(req)),
      settleOutcome(runCaptureAnalysis(req)),
    ]);
    const kinds = [first.kind, second.kind];
    expect(kinds).not.toContain('threw');
    expect(kinds).not.toContain('scored');
    expect(kinds).not.toContain('low_confidence');
    for (const outcome of [first, second])
      if (outcome.kind === 'partial') expectPartialMarker(outcome);
    expect(
      kinds.filter(kind => kind === 'partial').length,
    ).toBeGreaterThanOrEqual(1);

    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const state = captureDbState(db);
    expect(state.shots).toBe(0);
    expect(state.outbox).toBe(0);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    expect(refusalRows(db)).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    // Whatever the loser saw, a later submit converges on the durable partial.
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);
  });

  it.each([
    [
      'right after the refusal metadata is written',
      'INTO analysis_reservation_refusal',
    ],
    [
      'while the mechanics record is being committed',
      'INTO local_analysis_record',
    ],
  ])(
    'A2 account switch %s: nothing lands for either owner, and the original owner later gets the partial without a second reservation',
    async (_label, statement) => {
      let switched = false;
      const { db, calls } = attackDb(sql => {
        if (!switched && sql.includes(statement)) {
          switched = true;
          setActiveDataOwner(otherOwner);
        }
      });
      const { clip, sidecarJson } = swingClipWithSidecar(`a2-${statement}`);
      mockReadArtifact = async () => sidecarJson;
      const server = releaseNotAuthorizedServer();
      setFetch(server.fetchMock);
      const req = request(db, clip, `a2-${statement}`);
      const before = snapshotAccess();

      const outcome = await settleOutcome(runCaptureAnalysis(req));
      expect(switched).toBe(true);
      expect(describeOutcome(outcome)).toEqual({
        kind: 'unavailable',
        cause: 'account_changed',
      });
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      const afterSwitch = captureDbState(db);
      expect(afterSwitch.records).toBe(0);
      expect(afterSwitch.shots).toBe(0);
      expect(afterSwitch.outbox).toBe(0);
      expect(captureStatuses(db)).toEqual(['awaiting_model']);
      // Nothing of the first owner's run is attributed to the other account.
      for (const row of afterSwitch.journal)
        expect((row as { owner_key: string }).owner_key).toBe(owner);
      for (const row of refusalRows(db))
        expect((row as { owner_key: string }).owner_key).toBe(owner);
      expect(snapshotAccess()).toEqual(before);

      // The other account cannot see or finish the first owner's run.
      signInCaptureOwner(otherOwner, ORIGIN);
      const foreign = await settleOutcome(
        runCaptureAnalysis({ ...req, ownerContext: captureDataOwnerContext() }),
      );
      expect(foreign.kind).not.toBe('partial');
      expect(foreign.kind).not.toBe('scored');
      expect(captureDbState(db).records).toBe(0);
      expect(reserveCalls(server.urls)).toHaveLength(1);

      // The original owner returns: the same operation resumes from its
      // settled refusal, never reserving again.
      signInCaptureOwner(owner, ORIGIN);
      const resumed = expectPartialMarker(
        await runCaptureAnalysis({
          ...req,
          ownerContext: captureDataOwnerContext(),
        }),
      );
      expect(resumed.record.partialOutcome.message).toBe(SERVER_MESSAGE);
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      const state = captureDbState(db);
      expect(state.records).toBe(1);
      expect(state.journal).toHaveLength(1);
      expect(captureStatuses(db)).toEqual(['analyzed']);
      expect(snapshotAccess()).toEqual(before);
    },
  );

  it('A3 process death on the shipping original path: a failed record write after the settled refusal must not strand the capture forever', async () => {
    const { db, calls, failNext, server, run, execution, operation } =
      await prepareOriginal('a3-original-write-failure');
    const before = snapshotAccess();
    failNext(
      'INTO local_analysis_record',
      new Error('disk I/O error (simulated process death)'),
    );
    const first = await run();
    expect(first.kind).not.toBe('partial');
    expect(first.kind).not.toBe('scored');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);

    // What AnalyzeScreen does next for an operation it could not finish:
    // reconcile the current attempt, then run the same operation again.
    const readOperation = () =>
      originalAnalysisOperations.read(db, execution, operation.operationId);
    const afterFailure = (await readOperation())!;
    const attempt = await originalAnalysisOperations.readAttempt(
      db,
      afterFailure,
      afterFailure.currentAttemptId!,
    );
    await reconcileOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });
    const retry = await run();
    const again = await run();
    const finalOperation = (await readOperation())!;

    const observed = {
      attemptAfterFailure: {
        state: attempt.run.state,
        permitId: attempt.run.permitId,
        terminalReason: attempt.run.terminalReason,
        technicalFailure: attempt.technicalFailure,
      },
      retry: describeOutcome(retry),
      again: describeOutcome(again),
      finalRecordId: finalOperation.finalRecordId,
      reservations: reserveCalls(server.urls).length,
      records: captureDbState(db).records,
      captureStatus: captureStatuses(db),
      shots: captureDbState(db).shots,
      outbox: captureDbState(db).outbox,
      localShotInserts: localShotInserts(calls).length,
      accessUnchanged:
        JSON.stringify(snapshotAccess()) === JSON.stringify(before),
    };
    // Contract: the settled refusal already happened (terminal, permit-less,
    // never chargeable); the same operation must still deliver the mechanics
    // partial, exactly as the plain path does after the same fault.
    expect(observed).toEqual({
      attemptAfterFailure: {
        state: 'terminal',
        permitId: null,
        terminalReason: 'reservation_rejected',
        technicalFailure: null,
      },
      retry: { kind: 'partial' },
      again: { kind: 'partial' },
      finalRecordId: expect.any(String),
      reservations: 1,
      records: 1,
      captureStatus: ['analyzed'],
      shots: 0,
      outbox: 0,
      localShotInserts: 0,
      accessUnchanged: true,
    });
  });

  it('A4 AUTO DETECT + refusal on the shipping original path: an ambiguous stroke must not turn the settled refusal into a permanent dead end', async () => {
    const { db, calls, server, run, execution, operation } =
      await prepareOriginal('a4-auto-detect', { declaredStroke: null });
    const before = snapshotAccess();

    const first = await run();
    const again = await run();
    const finalOperation = (await originalAnalysisOperations.read(
      db,
      execution,
      operation.operationId,
    ))!;
    const attempt = await originalAnalysisOperations.readAttempt(
      db,
      finalOperation,
      finalOperation.currentAttemptId!,
    );
    const observed = {
      first: describeOutcome(first),
      again: describeOutcome(again),
      attempt: {
        state: attempt.run.state,
        permitId: attempt.run.permitId,
        terminalReason: attempt.run.terminalReason,
        technicalFailure: attempt.technicalFailure,
      },
      finalRecordId: finalOperation.finalRecordId,
      reservations: reserveCalls(server.urls).length,
      records: captureDbState(db).records,
      captureStatus: captureStatuses(db),
      shots: captureDbState(db).shots,
      localShotInserts: localShotInserts(calls).length,
      accessUnchanged:
        JSON.stringify(snapshotAccess()) === JSON.stringify(before),
    };
    // Contract: mechanics were measured and the authority settled the
    // refusal — the run must deliver something durable (a partial, or at least
    // the technique-confirmation record) instead of nothing, and the same
    // operation must not stay "unavailable" forever.
    expect(observed).toEqual({
      first: expect.objectContaining({
        kind: expect.stringMatching(/^(partial|needs_technique_confirmation)$/),
      }),
      again: expect.objectContaining({
        kind: expect.stringMatching(/^(partial|needs_technique_confirmation)$/),
      }),
      attempt: {
        state: 'terminal',
        permitId: null,
        terminalReason: 'reservation_rejected',
        technicalFailure: null,
      },
      finalRecordId: expect.any(String),
      reservations: 1,
      records: 1,
      captureStatus: ['analyzed'],
      shots: 0,
      localShotInserts: 0,
      accessUnchanged: true,
    });
  });

  it.each([
    ['an object', { nested: true }],
    ['a number', 42],
    ['an array', ['not', 'a', 'sentence']],
    ['a whitespace-only string', '   '],
    ['a null', null],
  ])(
    'A5 boundary: %s refusal message must not be presented as the authority statement on Result',
    async (_label, message) => {
      const { db, calls } = attackDb();
      const { clip, sidecarJson } = swingClipWithSidecar(`a5-${_label}`);
      mockReadArtifact = async () => sidecarJson;
      const server = releaseNotAuthorizedServer(message);
      setFetch(server.fetchMock);
      const req = request(db, clip, `a5-${_label}`);
      const before = snapshotAccess();

      const outcome = await settleOutcome(runCaptureAnalysis(req));
      expect(outcome.kind).toBe('partial');
      if (outcome.kind !== 'partial') return;
      expectPartialMarker(outcome);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(snapshotAccess()).toEqual(before);

      const renderer = await renderResult(outcome.analysisId);
      const copy = allText(renderer);
      const observed = {
        storedMessage: outcome.record.partialOutcome.message,
        statusNode: hostByTestId(renderer, 'result-benchmark-status').length,
        renderedFallback: copy.includes(TECHNIQUE_BENCHMARK_UNAVAILABLE),
        renderedObjectToString: /\[object Object\]/.test(copy),
        renderedBareNumberStatement: /RATING NOT CONSUMED[^.]*\b42\b/.test(
          copy,
        ),
        renderedHttpStatusAsStatement: /HTTP 409/.test(copy),
      };
      // Contract: the authority's message is a bounded HUMAN statement; when
      // the body carried none (or not a string), the fallback statement is
      // used — never a coerced JavaScript value or a transport status code.
      expect(observed).toEqual({
        storedMessage:
          typeof message === 'string' && message.trim().length > 0
            ? message
            : RELEASE_NOT_AUTHORIZED_MESSAGE,
        statusNode: 1,
        renderedFallback: true,
        renderedObjectToString: false,
        renderedBareNumberStatement: false,
        renderedHttpStatusAsStatement: false,
      });
    },
  );

  it('A6a corrupt state: a journal row that later claims a permit is no longer a settled refusal — replay must hold, never re-reserve or charge', async () => {
    const { db, calls, native } = attackDb();
    const { clip, sidecarJson } = swingClipWithSidecar('a6a-journal');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'a6a-journal');
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const before = snapshotAccess();

    native
      .prepare(
        `UPDATE analysis_run_journal SET permit_id = ? WHERE owner_key = ? AND operation_id = ?`,
      )
      .run(fixtureUuid('a6a-forged-permit'), owner, req.operationId);

    const replay = await settleOutcome(runCaptureAnalysis(req));
    expect(replay.kind).not.toBe('partial');
    expect(replay.kind).not.toBe('scored');
    expect(replay.kind).not.toBe('low_confidence');
    expect(replay.kind).not.toBe('threw');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(captureDbState(db).records).toBe(1);
    expect(captureDbState(db).shots).toBe(0);
    expect(snapshotAccess()).toEqual(before);
    expect(partial.analysisId).toBeTruthy();
  });

  it('A6b corrupt state: durable refusal metadata with a foreign reason code must not be replayed as the typed partial', async () => {
    const { db, native, failNext } = attackDb();
    const { clip, sidecarJson } = swingClipWithSidecar('a6b-refusal');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'a6b-refusal');
    // Settle the refusal but lose the record write, like the candidate's own
    // resume scenario; then corrupt the stored reason before the resume.
    failNext('INTO local_analysis_record', new Error('disk I/O error'));
    const first = await settleOutcome(runCaptureAnalysis(req));
    expect(first.kind).not.toBe('partial');
    expect(refusalRows(db)).toHaveLength(1);
    native
      .prepare(
        `UPDATE analysis_reservation_refusal SET reason_code = ? WHERE owner_key = ? AND operation_id = ?`,
      )
      .run('access.paywall_required', owner, req.operationId);
    const before = snapshotAccess();

    const resumed = await settleOutcome(runCaptureAnalysis(req));
    const observed = {
      kind: resumed.kind,
      reasonCode:
        resumed.kind === 'partial'
          ? resumed.record.partialOutcome.reasonCode
          : null,
      reservations: reserveCalls(server.urls).length,
      shots: captureDbState(db).shots,
      accessUnchanged:
        JSON.stringify(snapshotAccess()) === JSON.stringify(before),
    };
    // Contract: only the exact typed refusal is a partial. Metadata carrying
    // any other code is unknown state: hold, do not fabricate the marker.
    expect(observed).toEqual({
      kind: 'unavailable',
      reasonCode: null,
      reservations: 1,
      shots: 0,
      accessUnchanged: true,
    });
  });

  it('A6c corrupt state: a truncated stored partial record must resolve to a typed hold, not an unhandled SQLite error', async () => {
    const { db, native, calls } = attackDb();
    const { clip, sidecarJson } = swingClipWithSidecar('a6c-record');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'a6c-record');
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const before = snapshotAccess();
    // Simulate a torn write: the row exists but its JSON is cut short.
    native
      .prepare(
        `UPDATE local_analysis_record SET record = substr(record, 1, 40) WHERE owner_key = ? AND id = ?`,
      )
      .run(owner, partial.analysisId);

    const replay = await settleOutcome(runCaptureAnalysis(req));
    const observed = {
      replay: describeOutcome(replay),
      reservations: reserveCalls(server.urls).length,
      records: captureDbState(db).records,
      shots: captureDbState(db).shots,
      localShotInserts: localShotInserts(calls).length,
      captureStatus: captureStatuses(db),
      accessUnchanged:
        JSON.stringify(snapshotAccess()) === JSON.stringify(before),
    };
    // Contract: corrupt state never becomes a fabricated result, a second
    // reservation, or an unhandled exception on the analysis path.
    expect(observed).toEqual({
      replay: { kind: 'unavailable', cause: 'recovery_pending' },
      reservations: 1,
      records: 1,
      shots: 0,
      localShotInserts: 0,
      captureStatus: ['analyzed'],
      accessUnchanged: true,
    });
  });

  it('A7 account deletion: purgeOwnerData must remove every row of an owner who has a settled refusal', async () => {
    const { db, native } = attackDb();
    const { clip, sidecarJson } = swingClipWithSidecar('a7-purge');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'a7-purge');
    expectPartialMarker(await runCaptureAnalysis(req));
    expect(refusalRows(db)).toHaveLength(1);

    const purge = await purgeOwnerData(db, owner).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const count = (table: string) =>
      Number(
        native
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
          .get(owner)?.n,
      );
    const observed = {
      purge,
      remaining: {
        local_capture: count('local_capture'),
        local_analysis_record: count('local_analysis_record'),
        analysis_run_journal: count('analysis_run_journal'),
        analysis_reservation_refusal: count('analysis_reservation_refusal'),
      },
      foreignKeyCheck: native.prepare('PRAGMA foreign_key_check').all(),
    };
    // Contract: after the server confirms account deletion, no row of the
    // deleted owner survives on the device — including the refusal metadata.
    expect(observed).toEqual({
      purge: { kind: 'resolved' },
      remaining: {
        local_capture: 0,
        local_analysis_record: 0,
        analysis_run_journal: 0,
        analysis_reservation_refusal: 0,
      },
      foreignKeyCheck: [],
    });
  });

  it('A8 restart offline: the durable partial replays and renders with zero network calls and no charge', async () => {
    const { db, calls } = attackDb();
    const { clip, sidecarJson } = swingClipWithSidecar('a8-offline');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'a8-offline');
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const before = snapshotAccess();

    // "Process restart": fresh request object, fresh owner context, no network.
    const offline = offlineServer();
    setFetch(offline.fetchMock);
    const replay = expectPartialMarker(
      await runCaptureAnalysis({
        ...req,
        ownerContext: captureDataOwnerContext(),
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(partial.analysisId);
    expect(replay.record).toEqual(partial.record);
    expect(offline.urls).toHaveLength(0);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(captureDbState(db).records).toBe(1);
    expect(captureDbState(db).shots).toBe(0);
    expect(snapshotAccess()).toEqual(before);

    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    expect(hostByTestId(renderer, 'result-benchmark-status')).toHaveLength(1);
    expect(copy).toContain('RESULT · BENCHMARK UNAVAILABLE');
    expect(copy).toContain('RATING NOT CONSUMED');
    expect(copy).toContain(SERVER_MESSAGE);
    expect(copy).not.toMatch(/\d+\s*%/);
    expect(copy).not.toMatch(/confidence/i);
    expect(copy).not.toMatch(/\d(\.\d)?\s*[–-]\s*\d(\.\d)?/);
    expect(offline.urls).toHaveLength(0);
    expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    expect(snapshotAccess()).toEqual(before);
  });
});
