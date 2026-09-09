/**
 * W01-05 adversarial attacks against candidate be625bc6 (mechanics-only
 * PARTIAL outcome never spends a free rating; Result shows the honest
 * partial state).
 *
 * Each test drives the candidate to one of its failure boundaries and
 * asserts the behaviour the objective and the product invariants require:
 * a partial settles as non-chargeable, never decrements the local free-rating
 * view, never creates a shot/outbox row, never reserves the same settled
 * operation twice, never fabricates a benchmark, and never turns a corrupt or
 * half-written state into a charge, a dead end or a crash.
 *
 * Attack categories: concurrency/reentrancy (double submit, concurrent
 * resume, account switch mid-reservation), crash between steps (commit lost
 * before / after the refusal transaction), replay + duplicate identities,
 * boundary values (refusal code under the wrong HTTP status, redirect),
 * network failure ordering (transport failure then refusal on the recovery
 * re-reserve of a permit-less attempt), corrupt persisted state, free-rating
 * conservation, copy/accessibility of the partial Result.
 *
 * Real pipeline + real migrated SQLite; only the sidecar read, the native
 * byte verification and HTTP are simulated. Nothing here modifies the
 * candidate's own tests or production code.
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
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: () => () => {},
  };
});
jest.mock('../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(),
}));
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
  useRoute: () => ({ key: 'w01-attack-route', params: mockRouteParams }),
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
} from '../src/analysis/runCaptureAnalysis';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations,
} from '../src/analysis/originalAnalysisOperations';
import {
  recoverAnalysisJournals,
  runJournal,
  RunJournalError,
} from '../src/analysis/runJournal';
import { createAnalysisPermitClient } from '../src/data/api';
import { captureDataOwnerContext } from '../src/data/accountScope';
import { useAccessStore } from '../src/state/accessStore';
import { useAppStore } from '../src/state/appStore';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
const otherOwner = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://api.test';
const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';
const APP_MESSAGE =
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

function refusalBody(message: unknown = APP_MESSAGE) {
  return {
    error: { code: RELEASE_NOT_AUTHORIZED_CODE, message },
    release: { status: 'ineligible', reasonCode: 'unreleased' },
  };
}

/** One scripted answer per reservation, in order; an unscripted reservation
 * throws (surfacing as a transport failure, never as a grant). */
function scriptedReservationServer(
  answers: Array<() => Response | Promise<Response>>,
  onReserve?: (index: number) => void,
) {
  const urls: string[] = [];
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) {
      const index = reservations;
      reservations += 1;
      onReserve?.(index);
      const answer = answers[index];
      if (!answer) throw new TypeError(`Unscripted reservation #${index + 1}`);
      return answer();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

const refusal409 = () => jsonResponse(refusalBody(), 409);

function swingClipWithSidecar(name: string): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${name}.mov`,
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
      uri: `file:///captures/${name}.pose.json`,
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
const finalizeCalls = (urls: string[]) =>
  urls.filter(url => url.includes('/finalize'));
const captureStatuses = (db: LocalDb) =>
  captureDbState(db).captures.map(row => (row as { status: string }).status);

type NativeTestDb = ReturnType<typeof createCaptureAnalysisDb>['native'];

const rowsFor = (native: NativeTestDb, table: string, ownerKey: string) =>
  native
    .prepare(`SELECT * FROM ${table} WHERE owner_key = ?`)
    .all(ownerKey) as Array<Record<string, unknown>>;
const refusalRows = (native: NativeTestDb, ownerKey = owner) =>
  rowsFor(native, 'analysis_reservation_refusal', ownerKey);
const attemptRows = (native: NativeTestDb, ownerKey = owner) =>
  rowsFor(native, 'analysis_execution_attempts', ownerKey);

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
      message: APP_MESSAGE,
    }),
  );
  expect('freeLimitReached' in outcome).toBe(false);
  return outcome;
}

function expectNoChargeableWrites(
  calls: RecordedCall[],
  urls: string[],
  db: LocalDb,
) {
  expect(localShotInserts(calls)).toHaveLength(0);
  expect(outboxInserts(calls)).toHaveLength(0);
  expect(finalizeCalls(urls)).toHaveLength(0);
  const state = captureDbState(db);
  expect(state.shots).toBe(0);
  expect(state.outbox).toBe(0);
  expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
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

function allAccessibilityLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => node.props.accessibilityLabel as string);
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

/** The plain `runCaptureAnalysis` request for a seeded pose-backed capture. */
function plainRequest(label: string) {
  const store = createCaptureAnalysisDb();
  mockCurrentDb = () => store.db;
  const { clip, sidecarJson } = swingClipWithSidecar(label);
  mockReadArtifact = async () => sidecarJson;
  const req = request(store.db, clip, label);
  return { ...store, clip, sidecarJson, req };
}

/** What AnalyzeScreen does for a signed-in, pose-backed camera capture. */
async function prepareOriginal(
  label: string,
  server: { fetchMock: unknown; urls: string[] },
) {
  const store = createCaptureAnalysisDb();
  const { db } = store;
  mockCurrentDb = () => db;
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
      sha256: sha256Hex('synthetic attack movie bytes'),
    },
  };
  mockReadArtifact = async () => sidecarJson;
  mockVerifyBytes = async () => ({
    status: 'verified-current-bytes',
    comparedExpectation: clip.nativeMediaIdentity!,
  });
  setFetch(server.fetchMock);
  const req = request(db, clip, label);
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
  const reconcile = () =>
    reconcileOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });
  const readAttempt = async () => {
    const current = (await originalAnalysisOperations.read(
      db,
      execution,
      operation.operationId,
    ))!;
    const attempt = await originalAnalysisOperations.readAttempt(
      db,
      current,
      current.currentAttemptId!,
    );
    return { operation: current, attempt };
  };
  return {
    ...store,
    sidecarJson,
    server,
    req,
    execution,
    operation,
    run,
    reconcile,
    readAttempt,
  };
}

async function recoverPlain(
  db: LocalDb,
  apiConfig: { baseUrl: string; token: string },
) {
  const scope = runJournal.scope({
    ownerKey: captureDataOwnerContext().ownerKey,
    apiOrigin: ORIGIN,
  });
  return recoverAnalysisJournals(db, scope, {
    ...scope,
    ...createAnalysisPermitClient(apiConfig),
  });
}

const settledOutcome = (promise: Promise<RunCaptureAnalysisOutcome>) =>
  promise.then(
    value => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
  mockVerifyBytes = async () => ({ status: 'unavailable' });
  mockRouteParams = {};
});
afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  for (const lease of leases.splice(0)) lease.dispose();
  useAccessStore.getState().reset();
  useAppStore.setState({ profile: null });
  closeCaptureHarness();
  setFetch(undefined);
  mockListCatalogDrills.mockClear();
  mockTriggerOutboxSync.mockClear();
});

describe('W01-05 attack — concurrency / reentrancy', () => {
  it('A1 double submit: two concurrent runs of the same operation under the typed refusal reserve once, write one record, and neither invents a second identity', async () => {
    const { db, native, calls, req } = plainRequest('attack-double-submit');
    const server = scriptedReservationServer([refusal409, refusal409]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const [first, second] = await Promise.all([
      settledOutcome(runCaptureAnalysis(req)),
      settledOutcome(runCaptureAnalysis(req)),
    ]);
    // Neither concurrent submit may crash the caller.
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const outcomes = [first, second].map(item =>
      item.status === 'fulfilled' ? item.value : null,
    );
    const partials = outcomes.filter(
      (outcome): outcome is RunCaptureAnalysisOutcome & { kind: 'partial' } =>
        outcome?.kind === 'partial',
    );
    expect(partials.length).toBeGreaterThanOrEqual(1);
    for (const partial of partials) expectPartialMarker(partial);
    for (const outcome of outcomes) {
      // The loser may only hold or replay — never score, never charge.
      expect(['partial', 'unavailable']).toContain(outcome!.kind);
      if (outcome!.kind === 'unavailable')
        expect(outcome).toMatchObject({ cause: 'recovery_pending' });
    }
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    // The operation is settled: a later run replays, still one reservation.
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
  });

  it('A2 concurrent resume: two overlapping reruns of a settled refusal whose record write failed deliver exactly one partial record and reserve nothing', async () => {
    const server = scriptedReservationServer([refusal409]);
    const { db, native, calls, run, failNext, readAttempt } =
      await prepareOriginal('attack-concurrent-resume', server);
    const before = snapshotAccess();
    failNext(
      'INTO local_analysis_record',
      new Error('disk I/O error (simulated process death)'),
    );
    const first = await settledOutcome(run());
    expect(first.status === 'fulfilled' ? first.value.kind : 'threw').not.toBe(
      'partial',
    );
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);

    const [a, b] = await Promise.all([
      settledOutcome(run()),
      settledOutcome(run()),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const kinds = [a, b].map(item =>
      item.status === 'fulfilled' ? item.value.kind : 'threw',
    );
    expect(kinds).toContain('partial');
    for (const item of [a, b]) {
      if (item.status !== 'fulfilled') continue;
      if (item.value.kind === 'partial') expectPartialMarker(item.value);
      else
        expect(item.value).toMatchObject({
          kind: 'unavailable',
          cause: 'recovery_pending',
        });
    }
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(attemptRows(native)).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    const delivered = await readAttempt();
    expect(delivered.operation.completionKind).toBe('partial');
    expect(delivered.attempt.run.permitId).toBeNull();
    expect(snapshotAccess()).toEqual(before);
  });

  it('A3 account switch while the reservation is in flight: the refusal stays with the original owner, nothing lands under the new account, and the original owner later gets the partial on the same operation', async () => {
    const { db, native, calls, req } = plainRequest('attack-account-switch');
    const server = scriptedReservationServer([refusal409], () => {
      // The user signs into another account while the authority answers.
      signInCaptureOwner(otherOwner, ORIGIN);
    });
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const first = await settledOutcome(runCaptureAnalysis(req));
    expect(first.status).toBe('fulfilled');
    if (first.status !== 'fulfilled') throw new Error('unreachable');
    expect(first.value.kind).not.toBe('partial');
    expect(first.value.kind).not.toBe('scored');
    expect(first.value).toMatchObject({ kind: 'unavailable' });
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    // Nothing of the other account was touched or fabricated.
    expect(rowsFor(native, 'analysis_run_journal', otherOwner)).toHaveLength(0);
    expect(rowsFor(native, 'local_analysis_record', otherOwner)).toHaveLength(
      0,
    );
    expect(refusalRows(native, otherOwner)).toHaveLength(0);
    // The settled verdict belongs to the original owner only.
    const journal = rowsFor(native, 'analysis_run_journal', owner);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ permit_id: null, result_id: null });
    expect(rowsFor(native, 'local_analysis_record', owner)).toHaveLength(0);
    expect(snapshotAccess()).toEqual(before);

    // The original owner returns: the SAME operation delivers its partial
    // without asking the authority again.
    signInCaptureOwner(owner, ORIGIN);
    const resumed = await runCaptureAnalysis({
      ...req,
      ownerContext: captureDataOwnerContext(),
    });
    expectPartialMarker(resumed);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(rowsFor(native, 'local_analysis_record', owner)).toHaveLength(1);
    expect(rowsFor(native, 'analysis_run_journal', owner)).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attack — crash between steps', () => {
  it('A4 commit of the refusal transaction fails: nothing half-settled, the run holds, and the same operation later settles with at most one more reservation and no charge', async () => {
    const { db, native, calls, req, failCommitOnce } = plainRequest(
      'attack-commit-before',
    );
    const server = scriptedReservationServer([refusal409, refusal409]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    failCommitOnce('before', 'INTO analysis_reservation_refusal');

    const first = await settledOutcome(runCaptureAnalysis(req));
    expect(first.status).toBe('fulfilled');
    if (first.status !== 'fulfilled') throw new Error('unreachable');
    expect(first.value.kind).not.toBe('scored');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    // Half-settled state must not exist: either both rows or neither.
    const journal = captureDbState(db).journal[0] as Record<string, unknown>;
    const refused = refusalRows(native);
    const terminal =
      journal.state === 'terminal' &&
      journal.terminal_reason === 'reservation_rejected';
    expect(refused.length === 1).toBe(terminal);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(snapshotAccess()).toEqual(before);

    // The sync-runtime sweep and a rerun of the SAME operation finish it.
    await recoverPlain(db, req.apiConfig);
    const second = await runCaptureAnalysis(req);
    const third =
      second.kind === 'partial' ? second : await runCaptureAnalysis(req);
    expectPartialMarker(third);
    expect(reserveCalls(server.urls).length).toBeLessThanOrEqual(2);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(captureDbState(db).journal).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A5 commit acknowledgement lost after the refusal committed: the run must read back its durable refusal and deliver the partial without a second reservation', async () => {
    const { db, native, calls, req, failCommitOnce } = plainRequest(
      'attack-commit-after',
    );
    const server = scriptedReservationServer([refusal409]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    failCommitOnce('after', 'INTO analysis_reservation_refusal');

    const outcome = await runCaptureAnalysis(req);
    const partial =
      outcome.kind === 'partial' ? outcome : await runCaptureAnalysis(req);
    expectPartialMarker(partial);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attack — boundary values on the refusal', () => {
  it.each([
    ['HTTP 302 redirect', 302],
    ['HTTP 403', 403],
    ['HTTP 422', 422],
    ['HTTP 500', 500],
  ])(
    'A6 the refusal code under %s is not a settled refusal: no partial, no refusal row, no charge, access unchanged',
    async (_label, status) => {
      const { db, native, calls, req } = plainRequest(
        `attack-status-${status}`,
      );
      const server = scriptedReservationServer([
        () =>
          jsonResponse(
            refusalBody(),
            status,
            status === 302
              ? { location: 'https://elsewhere.test/permits' }
              : {},
          ),
      ]);
      setFetch(server.fetchMock);
      const before = snapshotAccess();
      const outcome = await settledOutcome(runCaptureAnalysis(req));
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status !== 'fulfilled') throw new Error('unreachable');
      expect(outcome.value.kind).not.toBe('partial');
      expect(outcome.value.kind).not.toBe('scored');
      expect(refusalRows(native)).toHaveLength(0);
      expect(captureDbState(db).records).toBe(0);
      expectNoChargeableWrites(calls, server.urls, db);
      expect(captureStatuses(db)).toEqual(['awaiting_model']);
      expect(snapshotAccess()).toEqual(before);
    },
  );

  it('A7 a 409 without the typed code (or with a foreign code) never becomes a partial', async () => {
    const bodies = [
      { error: { message: APP_MESSAGE } },
      {
        error: { code: 'access.release_not_authorized ', message: APP_MESSAGE },
      },
      {
        error: { code: 'ACCESS.RELEASE_NOT_AUTHORIZED', message: APP_MESSAGE },
      },
      {
        error: {
          code: ['access.release_not_authorized'],
          message: APP_MESSAGE,
        },
      },
    ];
    for (const [index, body] of bodies.entries()) {
      const { db, native, calls, req } = plainRequest(`attack-code-${index}`);
      const server = scriptedReservationServer([() => jsonResponse(body, 409)]);
      setFetch(server.fetchMock);
      const before = snapshotAccess();
      const outcome = await settledOutcome(runCaptureAnalysis(req));
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status !== 'fulfilled') throw new Error('unreachable');
      expect(outcome.value.kind).not.toBe('partial');
      expect(outcome.value.kind).not.toBe('scored');
      expect(refusalRows(native)).toHaveLength(0);
      expect(captureDbState(db).records).toBe(0);
      expectNoChargeableWrites(calls, server.urls, db);
      expect(snapshotAccess()).toEqual(before);
      closeCaptureHarness();
      signInCaptureOwner(owner, ORIGIN);
    }
  });
});

describe('W01-05 attack — network failure ordering on the original-operation path', () => {
  it('A8 the pose sidecar fails to read once (permit-less inference failure), then the recovery re-reserve receives the typed refusal: the refusal must settle once — no unbounded re-reservation, no permanent hold', async () => {
    const server = scriptedReservationServer([
      refusal409,
      refusal409,
      refusal409,
      refusal409,
    ]);
    const prepared = await prepareOriginal(
      'attack-sidecar-then-refusal',
      server,
    );
    const { db, native, calls, run, reconcile, sidecarJson } = prepared;
    const before = snapshotAccess();
    // The original run reads the sidecar once to seal the observation and
    // once more inside the core; the second read fails (transient I/O).
    let reads = 0;
    mockReadArtifact = async () => {
      reads += 1;
      if (reads === 2) throw new Error('EIO (simulated transient read)');
      return sidecarJson;
    };

    const first = await settledOutcome(run());
    expect(first.status).toBe('fulfilled');
    if (first.status !== 'fulfilled') throw new Error('unreachable');
    expect(first.value.kind).toBe('unavailable');
    // The permit-less attempt was re-reserved right away (the immediate
    // recovery after the failed read) and met the typed refusal.
    expect(reserveCalls(server.urls)).toHaveLength(1);
    // What the on-screen saved-analysis check and the sync sweep do next.
    await reconcile();
    await reconcile();
    const attempts = attemptRows(native);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.permit_id).toBeNull();
    expect(attempt.result_id).toBeNull();
    // A typed refusal is a settled verdict exactly like after a transport
    // failure: the attempt must not stay pending and must not be re-asked
    // of the authority on every reconcile.
    expect(attempt.state).not.toBe('release_pending');
    expect(attempt.state).toBe('terminal');
    expect(attempt.terminal_reason).toBe('reservation_rejected');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(native)).toEqual([
      expect.objectContaining({
        reason_code: RELEASE_NOT_AUTHORIZED_CODE,
        message: APP_MESSAGE,
      }),
    ]);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(snapshotAccess()).toEqual(before);

    // …and the SAME operation then delivers its mechanics as the partial —
    // never a permanent 'awaiting recovery' dead end, never a new reservation.
    mockReadArtifact = async () => sidecarJson;
    const retry = await run();
    expect({ retry, captures: captureStatuses(db) }).not.toMatchObject({
      retry: { kind: 'unavailable', cause: 'recovery_pending' },
      captures: ['awaiting_model'],
    });
    expectPartialMarker(retry);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attack — corrupt persisted state', () => {
  const CORRUPT_RECORD = '{"kind":"analyzed","result":{"overallScore":9.';

  async function corruptPartialRecord(label: string) {
    const prepared = plainRequest(label);
    const server = scriptedReservationServer([refusal409]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const partial = expectPartialMarker(await runCaptureAnalysis(prepared.req));
    prepared.native
      .prepare(
        'UPDATE local_analysis_record SET record = ? WHERE owner_key = ? AND id = ?',
      )
      .run(CORRUPT_RECORD, owner, partial.analysisId);
    return { ...prepared, server, before, partial };
  }

  it('A9 the durable partial record is corrupted on disk: the replay never fabricates a score, never reserves again, never charges, and Result shows no benchmark', async () => {
    const { db, calls, req, server, before, partial } =
      await corruptPartialRecord('attack-corrupt-record');
    const replay = await settledOutcome(runCaptureAnalysis(req));
    if (replay.status === 'fulfilled') {
      expect(replay.value.kind).not.toBe('scored');
      expect(replay.value.kind).not.toBe('low_confidence');
    }
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(snapshotAccess()).toEqual(before);

    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
    expect(copy).not.toContain('TECHNIQUE SCORE');
    expect(copy).not.toContain('out of 10');
    expect(copy).not.toContain('9.');
  });

  it('A9b the corrupt durable record is surfaced as a typed hold, not as a raw JSON parser exception thrown at the screen', async () => {
    const { req } = await corruptPartialRecord('attack-corrupt-record-typed');
    const replay = await settledOutcome(runCaptureAnalysis(req));
    // A RunJournalError (identity_conflict) is the candidate's own typed
    // verdict for tampered rows; an untyped SyntaxError reaches AnalyzeScreen
    // as `error.message` and becomes on-screen copy.
    if (replay.status === 'rejected') {
      expect(replay.error).toBeInstanceOf(RunJournalError);
      expect(String((replay.error as Error).message)).not.toMatch(/JSON/);
    } else {
      expect(replay.value.kind).toBe('unavailable');
    }
  });

  it('A10 the refusal row is deleted underneath a settled terminal run: the replay must hold (never a new reservation, never an invented partial or score)', async () => {
    const { db, native, calls, req } = plainRequest('attack-missing-refusal');
    const server = scriptedReservationServer([refusal409, refusal409]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    native
      .prepare(
        'DELETE FROM analysis_reservation_refusal WHERE owner_key = ? AND operation_id = ?',
      )
      .run(owner, req.operationId);
    expect(refusalRows(native)).toHaveLength(0);

    const replay = await settledOutcome(runCaptureAnalysis(req));
    expect(replay.status).toBe('fulfilled');
    if (replay.status === 'fulfilled') {
      expect(replay.value.kind).not.toBe('scored');
      // Without its refusal metadata the terminal run has no grounds for a
      // partial either: the honest answer is a hold.
      expect(replay.value.kind).not.toBe('partial');
    }
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);

    // The stored record still renders without inventing a benchmark.
    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
    expect(copy).not.toContain('TECHNIQUE SCORE');
    expect(copy).not.toMatch(/\d+\s*%/);
  });
});

describe('W01-05 attack — free-rating conservation and replay identity', () => {
  it('A11 a settled partial is never re-reserved even when the authority would now grant a permit: replay keeps the partial, zero new reservations, the local free-rating view unchanged', async () => {
    const { db, native, calls, req } = plainRequest('attack-grant-later');
    const server = scriptedReservationServer([
      refusal409,
      () =>
        jsonResponse(
          {
            permit: {
              id: '77777777-7777-4777-8777-000000000001',
              accessSource: 'free',
              status: 'reserved',
              expiresAt: '2026-09-09T20:00:00.000Z',
            },
          },
          200,
        ),
    ]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    for (let i = 0; i < 3; i += 1) {
      const replay = expectPartialMarker(await runCaptureAnalysis(req));
      expect(replay.replayed).toBe(true);
      expect(replay.analysisId).toBe(partial.analysisId);
    }
    await recoverPlain(db, req.apiConfig);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(captureDbState(db).journal).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
    expect(useAccessStore.getState().canonicalAccess?.freeRatings).toEqual(
      freeAccess.freeRatings,
    );
  });

  it('A12 the partial marker cannot be smuggled into a chargeable record: a 409 refusal body that also carries a permit object never yields a permit, a shot or an outbox row', async () => {
    const { db, native, calls, req } = plainRequest(
      'attack-refusal-with-permit',
    );
    const server = scriptedReservationServer([
      () =>
        jsonResponse(
          {
            ...refusalBody(),
            permit: {
              id: '77777777-7777-4777-8777-000000000002',
              accessSource: 'free',
              status: 'reserved',
              expiresAt: '2026-09-09T20:00:00.000Z',
            },
          },
          409,
        ),
    ]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const outcome = await runCaptureAnalysis(req);
    expect(outcome.kind).not.toBe('scored');
    if (outcome.kind === 'partial') expectPartialMarker(outcome);
    const journal = captureDbState(db).journal[0] as Record<string, unknown>;
    expect(journal.permit_id).toBeNull();
    expect(journal.result_id).toBeNull();
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(refusalRows(native).length).toBeLessThanOrEqual(1);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attack — copy and accessibility of the partial Result', () => {
  it('A13 the partial Result carries no score, confidence, range, percentage or DUPR-style claim in visible text OR accessibility labels, and states the benchmark is unavailable', async () => {
    const { req } = plainRequest('attack-result-copy');
    const server = scriptedReservationServer([refusal409]);
    setFetch(server.fetchMock);
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    const labels = allAccessibilityLabels(renderer).join(' | ');
    expect(hostByTestId(renderer, 'result-benchmark-status')).toHaveLength(1);
    expect(copy).toContain('RESULT · BENCHMARK UNAVAILABLE');
    expect(copy).toContain(TECHNIQUE_BENCHMARK_UNAVAILABLE);
    expect(copy).toContain(APP_MESSAGE);
    for (const text of [copy, labels]) {
      expect(text).not.toMatch(/out of 10/i);
      expect(text).not.toMatch(/\bScore \d/);
      expect(text).not.toMatch(/\d+(\.\d+)?\s*%/);
      expect(text).not.toMatch(/\d(\.\d)?\s*[–-]\s*\d(\.\d)?/);
      expect(text).not.toMatch(/DUPR|≈|Android|Google Play|guest|Live Court/i);
      expect(text).not.toMatch(/accura(cy|te)/i);
      expect(text.replace(/confidence capped/gi, '')).not.toMatch(/confiden/i);
      // No invented benchmark words: the rating was not produced.
      expect(text).not.toMatch(
        /your rating (is|was)|rated \d|benchmark(ed)? at/i,
      );
    }
    // The statement that no rating was consumed must not be contradicted.
    expect(copy).toContain('RATING NOT CONSUMED');
    expect(copy).not.toMatch(/rating (was |is )?(consumed|used|spent)\b/i);
    expect(copy).not.toMatch(/[^o] rating was counted/i);
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
  });
});
