/**
 * W01-05 ADVERSARIAL ATTACKS against candidate cbd06aed (mechanics-only
 * PARTIAL outcome never spends a free rating).
 *
 * Every test here drives the SHIPPING code paths (`runCaptureAnalysis`,
 * `prepareOriginalCaptureAnalysis` + `runOriginalCaptureAnalysis`, the sync
 * runtime's `recoverAnalysisJournals`, the Library / Result readers) at a
 * failure boundary the candidate's own suite does not pin, and asserts the
 * product invariants: partial/replayed/failed outcomes never charge (no
 * permit, no `local_shot`, no outbox, no finalize, local free-rating view
 * unchanged), corrupt or ambiguous state never becomes a fabricated result,
 * the honest partial stays reachable, and settled work does not dead-end.
 *
 * Attack categories: concurrency (double submit), interleaved account switch,
 * process death + restart on a file-backed SQLite, duplicate identities,
 * corrupt / partially persisted sidecars, clock rollback, network (redirected
 * 409, abort mid-reservation), free-rating conservation after the authority
 * re-opens, Library reachability + copy/accessibility, and an install upgraded
 * from BASE_SHA that already holds a settled-but-unmarked refusal.
 *
 * Real pipeline + real migrated SQLite; only the sidecar read, the native
 * byte verification and HTTP are simulated.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { createSqliteTestDb } from '../testSupport/sqlite';

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
jest.mock('../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(),
}));
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
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations,
} from '../src/analysis/originalAnalysisOperations';
import {
  recoverAnalysisJournals,
  runJournal,
} from '../src/analysis/runJournal';
import { finalizeAcknowledgement } from '../__harness__/analysisPermitRoute';
import { captureDataOwnerContext } from '../src/data/accountScope';
import { createAnalysisPermitClient } from '../src/data/api';
import {
  listCaptureHistory,
  listPendingCaptures,
  listShots,
} from '../src/data/repository';
import { useAccessStore } from '../src/state/accessStore';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
const OTHER_OWNER = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://api.test';
const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';
const APP_OWNED_REFUSAL_STATEMENT =
  'Validated ratings are not available right now. No rating was counted.';
const RESULT_LABEL = 'RESULT · BENCHMARK UNAVAILABLE';

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
  extra: Partial<Pick<Response, 'redirected' | 'url' | 'type'>> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    ...extra,
  } as unknown as Response;
}

function refusalBody() {
  return {
    error: {
      code: RELEASE_NOT_AUTHORIZED_CODE,
      message: APP_OWNED_REFUSAL_STATEMENT,
    },
    release: { status: 'ineligible', reasonCode: RELEASE_NOT_AUTHORIZED_CODE },
  };
}

type Answer = () => Response | Promise<Response>;

/** Reservation answers scripted one by one (or one answer for all); every
 * other route is unexpected on a refused run. */
function scriptedReservationServer(answers: Answer[] | Answer) {
  const urls: string[] = [];
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) {
      const answer = Array.isArray(answers) ? answers[reservations] : answers;
      reservations += 1;
      if (!answer) throw new Error(`Unscripted reservation #${reservations}`);
      return answer();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

const releaseNotAuthorizedServer = () =>
  scriptedReservationServer(() => jsonResponse(refusalBody(), 409));

/** Normal permit authority (reserve + finalize both succeed): what a
 * re-opened release authority looks like after the refusal window. */
function permitServer() {
  const urls: string[] = [];
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
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
    if (url.includes('/finalize'))
      return jsonResponse(
        finalizeAcknowledgement(url, JSON.parse(String(init?.body))),
        200,
      );
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

function swingClipWithSidecar(uri = 'file:///captures/w01-attack.mov'): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri,
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
      uri: `${uri}.pose.json`,
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
}

type NativeTestDb = ReturnType<typeof createCaptureAnalysisDb>['native'];

const ownerRowCount = (native: NativeTestDb, table: string, key = owner) =>
  Number(
    (
      native
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
        .get(key) as { n: number }
    ).n,
  );

function refusalRows(native: NativeTestDb, key = owner) {
  return native
    .prepare(
      'SELECT * FROM analysis_reservation_refusal WHERE owner_key = ? ORDER BY created_at_ms',
    )
    .all(key) as Array<Record<string, unknown>>;
}

function attemptRows(native: NativeTestDb) {
  return native
    .prepare(
      'SELECT state, permit_id, result_id, terminal_reason, last_http_status, technical_failure, created_at_ms, updated_at_ms FROM analysis_execution_attempts WHERE owner_key = ? ORDER BY attempt_ordinal',
    )
    .all(owner) as Array<Record<string, unknown>>;
}

const mounted: ReactTestRenderer[] = [];
const leases: OriginalAnalysisExecution[] = [];
const tempFiles: string[] = [];

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
  expect(outcome.record.partialOutcome).toEqual({
    status: 'partial',
    billingDisposition: 'not_chargeable',
    withheld: 'technique_benchmark',
    reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
    message: APP_OWNED_REFUSAL_STATEMENT,
  });
  return outcome;
}

/** A settled attempt: the promise's outcome or the error it threw, so an
 * attack can assert "not a fabricated result" without caring which. */
async function attempt(
  promise: Promise<RunCaptureAnalysisOutcome>,
): Promise<RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown }> {
  return promise.catch((error: unknown) => ({ kind: 'threw' as const, error }));
}

const DELIVERED_KINDS: ReadonlyArray<string> = [
  'scored',
  'low_confidence',
  'needs_technique_confirmation',
];

function prepareRun(label: string) {
  const { db, native, calls, failNext } = createCaptureAnalysisDb();
  mockCurrentDb = () => db;
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const req = request(db, clip, label);
  return { db, native, calls, failNext, req };
}

/** What AnalyzeScreen does for a signed-in, pose-backed camera capture. */
async function prepareOriginal(
  label: string,
  server: ReturnType<typeof scriptedReservationServer>,
) {
  const store = createCaptureAnalysisDb();
  const { db, native, calls, failNext } = store;
  mockCurrentDb = () => db;
  const { clip: bare, sidecarJson } = swingClipWithSidecar();
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
  const reconcile = () =>
    reconcileOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });
  const readOperation = async () =>
    (await originalAnalysisOperations.read(
      db,
      execution,
      operation.operationId,
    ))!;
  return {
    db,
    native,
    calls,
    failNext,
    server,
    req,
    execution,
    operation,
    run,
    reconcile,
    readOperation,
  };
}

function plainScope() {
  return runJournal.scope({
    ownerKey: captureDataOwnerContext().ownerKey,
    apiOrigin: ORIGIN,
  });
}

function sweep(db: LocalDb, apiConfig: RunCaptureAnalysisRequest['apiConfig']) {
  const scope = plainScope();
  return recoverAnalysisJournals(db, scope, {
    ...scope,
    ...createAnalysisPermitClient(apiConfig),
  });
}

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
  mockVerifyBytes = async () => ({ status: 'unavailable' });
  mockRouteParams = {};
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  for (const lease of leases.splice(0)) lease.dispose();
  useAccessStore.getState().reset();
  closeCaptureHarness();
  setFetch(undefined);
  mockListCatalogDrills.mockClear();
  mockTriggerOutboxSync.mockClear();
  for (const path of tempFiles.splice(0)) rmSync(path, { force: true });
});

describe('W01-05 attacks — concurrency and account isolation', () => {
  it('A1 double submit of the same operation while the refusal is in flight: exactly one reservation, one refusal row, one record, and no fabricated second result', async () => {
    const { db, native, calls, req } = prepareRun('atk-double-submit');
    let releaseAnswer: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseAnswer = resolve;
    });
    const server = scriptedReservationServer(async () => {
      await gate;
      return jsonResponse(refusalBody(), 409);
    });
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const first = runCaptureAnalysis(req);
    const second = runCaptureAnalysis(req);
    // Let both callers reach (or be refused at) the reservation before the
    // authority answers.
    for (let i = 0; i < 50 && reserveCalls(server.urls).length === 0; i += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    releaseAnswer();
    const outcomes = await Promise.all([attempt(first), attempt(second)]);

    expect(reserveCalls(server.urls)).toHaveLength(1);
    for (const outcome of outcomes)
      expect(DELIVERED_KINDS).not.toContain(outcome.kind);
    expect(
      outcomes.filter(o => o.kind === 'partial').length,
    ).toBeGreaterThanOrEqual(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(captureDbState(db).journal).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    // A third submit (the athlete taps again) replays; still one reservation.
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
  });

  it('A2 the athlete switches account while the refusal is in flight: nothing lands under the new owner, nothing is charged, and the original owner can still settle the same operation', async () => {
    const { db, native, calls, req } = prepareRun('atk-account-switch');
    let releaseAnswer: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseAnswer = resolve;
    });
    const server = scriptedReservationServer(async () => {
      await gate;
      return jsonResponse(refusalBody(), 409);
    });
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const pending = runCaptureAnalysis(req);
    for (let i = 0; i < 50 && reserveCalls(server.urls).length === 0; i += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(reserveCalls(server.urls)).toHaveLength(1);
    signInCaptureOwner(OTHER_OWNER, ORIGIN);
    releaseAnswer();
    const switched = await attempt(pending);

    expect(DELIVERED_KINDS).not.toContain(switched.kind);
    expectNoChargeableWrites(calls, server.urls, db);
    for (const table of [
      'local_analysis_record',
      'analysis_run_journal',
      'analysis_reservation_refusal',
      'local_capture',
      'local_shot',
      'outbox',
    ])
      expect({ table, n: ownerRowCount(native, table, OTHER_OWNER) }).toEqual({
        table,
        n: 0,
      });
    // Whatever landed under the original owner is at most the settled
    // refusal + mechanics of ONE run: never a permit, never a product.
    expect(ownerRowCount(native, 'analysis_run_journal')).toBeLessThanOrEqual(
      1,
    );
    expect(ownerRowCount(native, 'local_analysis_record')).toBeLessThanOrEqual(
      1,
    );
    expect(snapshotAccess()).toEqual(before);

    // The original owner signs back in and AnalyzeScreen builds a request
    // under the current owner context for the same capture/operation: the
    // same operation settles honestly.
    signInCaptureOwner(owner, ORIGIN);
    const again = { ...req, ownerContext: captureDataOwnerContext() };
    const resumedOutcome = await runCaptureAnalysis(again);
    expect({
      outcome: resumedOutcome,
      journal: captureDbState(db).journal,
      refusals: refusalRows(native),
      switched,
    }).toMatchObject({ outcome: { kind: 'partial' } });
    const resumed = expectPartialMarker(resumedOutcome);
    expect(reserveCalls(server.urls).length).toBeLessThanOrEqual(2);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(ownerRowCount(native, 'analysis_run_journal')).toBe(1);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
    const replay = expectPartialMarker(await runCaptureAnalysis(again));
    expect(replay.analysisId).toBe(resumed.analysisId);
  });
});

describe('W01-05 attacks — original-path reentrancy', () => {
  it('A15 two concurrent runs of the SAME original operation while the refusal is in flight: one reservation, one attempt settles, no fabricated result, no charge', async () => {
    let releaseAnswer: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseAnswer = resolve;
    });
    const server = scriptedReservationServer(async () => {
      await gate;
      return jsonResponse(refusalBody(), 409);
    });
    const { db, native, calls, run, readOperation } = await prepareOriginal(
      'atk-original-reentrancy',
      server,
    );
    const before = snapshotAccess();
    const first = run();
    const second = run();
    for (let i = 0; i < 50 && reserveCalls(server.urls).length === 0; i += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    releaseAnswer();
    const outcomes = await Promise.all([attempt(first), attempt(second)]);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    for (const outcome of outcomes)
      expect(DELIVERED_KINDS).not.toContain(outcome.kind);
    expect(outcomes.some(o => o.kind === 'partial')).toBe(true);
    expectNoChargeableWrites(calls, server.urls, db);
    for (const row of attemptRows(native)) expect(row.permit_id).toBeNull();
    expect(refusalRows(native)).toHaveLength(1);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect((await readOperation()).completionKind).toBe('partial');
    expect(snapshotAccess()).toEqual(before);
    const replay = expectPartialMarker(await run());
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(replay.record.result).toBeNull();
  });
});

describe('W01-05 attacks — process death, restart and replay', () => {
  it('A3 process death after the durable refusal but before the mechanics record, then a restart on a re-opened authority: the same run finishes as partial with ZERO new reservations (no permit, no charge)', async () => {
    const path = `${tmpdir()}/w01-attack-death-${process.pid}-${Date.now()}.sqlite`;
    tempFiles.push(path);
    const first = createSqliteTestDb(path);
    mockCurrentDb = () => first.db;
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const req = request(first.db, clip, 'atk-process-death');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    const before = snapshotAccess();
    first.failStatementOnce(
      'INTO local_analysis_record',
      new Error('disk I/O error (process killed)'),
    );
    const crashed = await attempt(runCaptureAnalysis(req));
    expect(DELIVERED_KINDS).not.toContain(crashed.kind);
    expect(crashed.kind).not.toBe('partial');
    expect(reserveCalls(refusing.urls)).toHaveLength(1);
    expect(refusalRows(first.native)).toHaveLength(1);
    expect(first.count('local_analysis_record', owner)).toBe(0);
    // The process dies: every in-memory execution guard is gone, only the
    // SQLite file survives.
    first.close();

    const second = createSqliteTestDb(path);
    mockCurrentDb = () => second.db;
    // Meanwhile the release authority re-opened: a reservation now WOULD be
    // granted, so any re-reservation here would spend the free rating.
    const granting = permitServer();
    setFetch(granting.fetchMock);
    const swept = await sweep(second.db, req.apiConfig);
    expect(swept.unknownStorage).toBe(false);
    expect(reserveCalls(granting.urls)).toHaveLength(0);

    const resumed = expectPartialMarker(
      await runCaptureAnalysis({ ...req, db: second.db }),
    );
    expect(reserveCalls(granting.urls)).toHaveLength(0);
    expect(finalizeCalls(granting.urls)).toHaveLength(0);
    expect(second.count('local_shot', owner)).toBe(0);
    expect(second.count('outbox', owner)).toBe(0);
    expect(second.count('local_analysis_record', owner)).toBe(1);
    expect(refusalRows(second.native)).toHaveLength(1);
    expect(
      (
        second.native
          .prepare('SELECT status FROM local_capture WHERE id = ?')
          .get(req.captureId) as { status: string }
      ).status,
    ).toBe('analyzed');
    expect(snapshotAccess()).toEqual(before);

    const replay = expectPartialMarker(
      await runCaptureAnalysis({ ...req, db: second.db }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(resumed.analysisId);
    expect(reserveCalls(granting.urls)).toHaveLength(0);
  });

  it('A4 duplicate identity: a DIFFERENT capture submitted under the operation id of a settled partial never reserves, never charges, and never borrows the partial as its own result', async () => {
    const { db, native, calls, req } = prepareRun('atk-dup-identity-a');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    const settled = expectPartialMarker(await runCaptureAnalysis(req));
    expect(reserveCalls(refusing.urls)).toHaveLength(1);

    const { clip: otherClip } = swingClipWithSidecar(
      'file:///captures/w01-attack-other.mov',
    );
    const other = {
      ...request(db, otherClip, 'atk-dup-identity-b'),
      operationId: req.operationId,
    };
    const granting = permitServer();
    setFetch(granting.fetchMock);
    const before = snapshotAccess();
    const outcome = await attempt(runCaptureAnalysis(other));

    expect(DELIVERED_KINDS).not.toContain(outcome.kind);
    if (outcome.kind === 'partial') {
      // Borrowing another capture's mechanics would be a fabricated result.
      expect(outcome.record.captureId).toBe(other.captureId);
      expect(outcome.analysisId).not.toBe(settled.analysisId);
    }
    expect(reserveCalls(granting.urls)).toHaveLength(0);
    expect(finalizeCalls(granting.urls)).toHaveLength(0);
    expectNoChargeableWrites(calls, [...refusing.urls, ...granting.urls], db);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(
      (
        native
          .prepare('SELECT status FROM local_capture WHERE id = ?')
          .get(other.captureId) as { status: string }
      ).status,
    ).toBe('awaiting_model');
    expect(snapshotAccess()).toEqual(before);
    // The settled partial is untouched.
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.analysisId).toBe(settled.analysisId);
    expect(replay.record.captureId).toBe(req.captureId);
  });
});

describe('W01-05 attacks — corrupt and partially persisted state', () => {
  it('A5 the refusal sidecar row vanishes after a settled partial (partial persistence): the run neither fabricates a result nor re-reserves on a re-opened authority', async () => {
    const { db, native, calls, req } = prepareRun('atk-lost-sidecar');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    expectPartialMarker(await runCaptureAnalysis(req));
    expect(refusalRows(native)).toHaveLength(1);
    native
      .prepare('DELETE FROM analysis_reservation_refusal WHERE owner_key = ?')
      .run(owner);
    expect(refusalRows(native)).toHaveLength(0);

    const granting = permitServer();
    setFetch(granting.fetchMock);
    const before = snapshotAccess();
    const outcome = await attempt(runCaptureAnalysis(req));
    expect(DELIVERED_KINDS).not.toContain(outcome.kind);
    expect(outcome.kind).not.toBe('partial');
    expect(reserveCalls(granting.urls)).toHaveLength(0);
    expectNoChargeableWrites(calls, [...refusing.urls, ...granting.urls], db);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    expect(snapshotAccess()).toEqual(before);
    const swept = await sweep(db, req.apiConfig);
    expect(swept.unknownStorage).toBe(false);
    expect(reserveCalls(granting.urls)).toHaveLength(0);
  });

  it('A6 the stored mechanics record is truncated on disk (corrupt JSON) while its refusal is intact: no invented result, no re-reservation, Result does not render a score', async () => {
    const { db, native, calls, req } = prepareRun('atk-corrupt-record');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    const settled = expectPartialMarker(await runCaptureAnalysis(req));
    native
      .prepare(
        'UPDATE local_analysis_record SET record = ? WHERE owner_key = ? AND id = ?',
      )
      .run(
        '{"kind":"analyzed","result":{"score":9.9',
        owner,
        settled.analysisId,
      );

    const granting = permitServer();
    setFetch(granting.fetchMock);
    const before = snapshotAccess();
    const outcome = await attempt(runCaptureAnalysis(req));
    expect(DELIVERED_KINDS).not.toContain(outcome.kind);
    expect(outcome.kind).not.toBe('partial');
    expect(reserveCalls(granting.urls)).toHaveLength(0);
    expectNoChargeableWrites(calls, [...refusing.urls, ...granting.urls], db);
    expect(snapshotAccess()).toEqual(before);

    const renderer = await renderResult(settled.analysisId);
    const copy = allText(renderer);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
    expect(copy).not.toContain('9.9');
    expect(copy).not.toContain('out of 10');
    expect(copy).not.toMatch(/\d+\s*%/);
    expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
  });

  it('A7 a refusal row whose message was rewritten on disk (only the code still matches) is not trusted: no partial is replayed from it and nothing is charged', async () => {
    const { db, native, calls, req } = prepareRun('atk-tampered-message');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    const settled = expectPartialMarker(await runCaptureAnalysis(req));
    // The row is immutable (UPDATE is refused by trigger), so the tamper is
    // a delete + re-insert that satisfies the admission trigger's shape.
    const stored = refusalRows(native)[0]!;
    native
      .prepare('DELETE FROM analysis_reservation_refusal WHERE owner_key = ?')
      .run(owner);
    native
      .prepare(
        `INSERT INTO analysis_reservation_refusal
           (owner_key, operation_id, analysis_id, capture_id, reason_code, message, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        owner,
        String(stored.operation_id),
        String(stored.analysis_id),
        String(stored.capture_id),
        RELEASE_NOT_AUTHORIZED_CODE,
        'Your rating was counted. DUPR 4.5 (87% confidence).',
        Number(stored.created_at_ms),
      );
    expect(refusalRows(native)).toHaveLength(1);

    const granting = permitServer();
    setFetch(granting.fetchMock);
    const before = snapshotAccess();
    const outcome = await attempt(runCaptureAnalysis(req));
    expect(DELIVERED_KINDS).not.toContain(outcome.kind);
    expect(outcome.kind).not.toBe('partial');
    expect(reserveCalls(granting.urls)).toHaveLength(0);
    expectNoChargeableWrites(calls, [...refusing.urls, ...granting.urls], db);
    expect(snapshotAccess()).toEqual(before);

    const renderer = await renderResult(settled.analysisId);
    const copy = allText(renderer);
    expect(copy).not.toMatch(/DUPR|87\s*%|rating was counted\. DUPR/i);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
  });
});

describe('W01-05 attacks — clocks', () => {
  it('A8 the device clock rolls back below the attempt creation time exactly when the refusal arrives (original path): the run never charges and the same operation still settles once the clock recovers', async () => {
    const realNow = Date.now;
    let rolledBack: number | null = null;
    const server = scriptedReservationServer(() => {
      rolledBack = realNow() - 6 * 60 * 60 * 1000;
      return jsonResponse(refusalBody(), 409);
    });
    const { db, native, calls, run, reconcile, readOperation } =
      await prepareOriginal('atk-clock-rollback', server);
    const spy = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => rolledBack ?? realNow());
    const before = snapshotAccess();

    const first = await attempt(run());
    expect(DELIVERED_KINDS).not.toContain(first.kind);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    for (const row of attemptRows(native)) expect(row.permit_id).toBeNull();
    expect(snapshotAccess()).toEqual(before);

    // The clock recovers (NTP). The operation must not be stuck forever.
    spy.mockRestore();
    const kinds: string[] = [first.kind];
    let settled: RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown } =
      first;
    for (let round = 0; round < 3 && settled.kind !== 'partial'; round += 1) {
      await reconcile().catch(() => null);
      settled = await attempt(run());
      kinds.push(settled.kind);
    }
    expect({ kinds, attempts: attemptRows(native) }).toMatchObject({
      kinds: expect.arrayContaining(['partial']),
    });
    expectPartialMarker(settled as RunCaptureAnalysisOutcome);
    expect(reserveCalls(server.urls).length).toBeLessThanOrEqual(2);
    expectNoChargeableWrites(calls, server.urls, db);
    for (const row of attemptRows(native)) expect(row.permit_id).toBeNull();
    expect(refusalRows(native).length).toBeGreaterThanOrEqual(1);
    expect((await readOperation()).completionKind).toBe('partial');
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attacks — network at the reservation step', () => {
  it('A9 a 409 refusal body delivered THROUGH a redirect (captive portal / proxy) is a transport artifact, not a settled verdict: no refusal row, no partial, the run stays recoverable and settles only on a direct answer', async () => {
    const { db, native, calls, req } = prepareRun('atk-redirected-409');
    const server = scriptedReservationServer([
      () =>
        jsonResponse(
          refusalBody(),
          409,
          {},
          {
            redirected: true,
            url: 'https://portal.example.net/login',
          },
        ),
      () => jsonResponse(refusalBody(), 409),
    ]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const first = await attempt(runCaptureAnalysis(req));
    expect(first.kind).not.toBe('partial');
    expect(DELIVERED_KINDS).not.toContain(first.kind);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(0);
    const journal = captureDbState(db).journal[0] as Record<string, unknown>;
    expect(journal.state).toBe('release_pending');
    expect(journal.terminal_reason).toBeNull();
    expect(captureStatuses(db)).toEqual(['awaiting_model']);
    expectNoChargeableWrites(calls, server.urls, db);

    const swept = await sweep(db, req.apiConfig);
    expect(swept.unknownStorage).toBe(false);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expect(refusalRows(native)).toHaveLength(1);
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
    expect(partial.record.captureId).toBe(req.captureId);
  });

  it('A10 the reservation request is aborted mid-flight (a non-HTTP, non-TypeError failure) on the original path, then the typed refusal on reconcile: no charge, no dead end, one partial', async () => {
    const server = scriptedReservationServer([
      () => {
        throw Object.assign(new Error('The operation was aborted.'), {
          name: 'AbortError',
        });
      },
      () => jsonResponse(refusalBody(), 409),
    ]);
    const { db, native, calls, run, reconcile, readOperation } =
      await prepareOriginal('atk-aborted-reserve', server);
    const before = snapshotAccess();

    const first = await attempt(run());
    expect(DELIVERED_KINDS).not.toContain(first.kind);
    expect(first.kind).not.toBe('partial');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(0);
    expectNoChargeableWrites(calls, server.urls, db);
    for (const row of attemptRows(native)) expect(row.permit_id).toBeNull();

    const kinds: string[] = [first.kind];
    let settled: RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown } =
      first;
    for (let round = 0; round < 3 && settled.kind !== 'partial'; round += 1) {
      await reconcile().catch(() => null);
      settled = await attempt(run());
      kinds.push(settled.kind);
    }
    expect({ kinds, attempts: attemptRows(native) }).toMatchObject({
      kinds: expect.arrayContaining(['partial']),
    });
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expectNoChargeableWrites(calls, server.urls, db);
    for (const row of attemptRows(native)) expect(row.permit_id).toBeNull();
    expect((await readOperation()).completionKind).toBe('partial');
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attacks — free-rating conservation once the authority re-opens', () => {
  it('A11 after an original-path partial the authority grants permits again: reconcile, re-run, both recovery sweeps and a fresh prepare of the same capture make ZERO reservations and never produce a chargeable shot', async () => {
    const refusing = releaseNotAuthorizedServer();
    const { db, native, calls, req, execution, operation, run, reconcile } =
      await prepareOriginal('atk-reopened-authority', refusing);
    const before = snapshotAccess();
    const partial = expectPartialMarker(await run());
    expect(reserveCalls(refusing.urls)).toHaveLength(1);

    const granting = permitServer();
    setFetch(granting.fetchMock);
    await reconcile();
    const again = expectPartialMarker(await run());
    expect(again.analysisId).toBe(partial.analysisId);
    const swept = await sweep(db, req.apiConfig);
    expect(swept.unknownStorage).toBe(false);
    expect(reserveCalls(granting.urls)).toHaveLength(0);

    // AnalyzeScreen "Check saved analysis" / a second launch of the SAME
    // capture: the operation is the same one and stays settled.
    execution.dispose();
    const fresh = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      ORIGIN,
    );
    leases.push(fresh);
    const prepared = await prepareOriginalCaptureAnalysis(
      { ...req, ownerContext: fresh.ownerContext },
      fresh,
      fixtureUuid('atk-reopened-authority-second-logical'),
    );
    expect(prepared.operationId).toBe(operation.operationId);
    const replay = expectPartialMarker(
      await runOriginalCaptureAnalysis({
        db,
        execution: fresh,
        operationId: prepared.operationId,
      }),
    );
    expect(replay.analysisId).toBe(partial.analysisId);
    expect(reserveCalls(granting.urls)).toHaveLength(0);
    expect(finalizeCalls(granting.urls)).toHaveLength(0);
    expectNoChargeableWrites(calls, [...refusing.urls, ...granting.urls], db);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    expect(ownerRowCount(native, 'analysis_logical_operations')).toBe(1);
    for (const row of attemptRows(native)) expect(row.permit_id).toBeNull();
    const current = await originalAnalysisOperations.read(
      db,
      fresh,
      prepared.operationId,
    );
    expect(current?.completionKind).toBe('partial');
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attacks — reachability, copy and accessibility', () => {
  it('A12 the recorded mechanics stay reachable from the Library after the athlete leaves Result: the partial capture is listed as a shot or as a pending capture', async () => {
    const { db, req } = prepareRun('atk-library');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    expect(captureStatuses(db)).toEqual(['analyzed']);

    const [shots, pending, history] = await Promise.all([
      listShots(db, 100),
      listPendingCaptures(db, 100),
      listCaptureHistory(db, null),
    ]);
    // The capture is durable and analyzed…
    expect(history.map(entry => entry.id)).toEqual([req.captureId]);
    expect(history[0]!.status).toBe('analyzed');
    // …so the Library (listShots + listPendingCaptures, LibraryScreen.tsx)
    // must be able to lead back to its Result.
    const reachable = [
      ...shots.map(shot => shot.id),
      ...pending.map(capture => capture.id),
    ];
    expect({
      partialAnalysisId: partial.analysisId,
      captureId: req.captureId,
      libraryEntries: reachable,
    }).toMatchObject({
      libraryEntries: expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^(${partial.analysisId}|${req.captureId})$`),
        ),
      ]),
    });
  });

  it('A13 the partial Result copy is honest and accessible: fixed statement only, every partial-state Text is non-empty and not hidden from assistive technology, no forbidden term, number, range or percentage', async () => {
    const { req } = prepareRun('atk-copy');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    expect(copy).toContain(RESULT_LABEL);
    expect(copy).toContain('MECHANICS RECORDED');
    expect(copy).toContain('RATING NOT CONSUMED');
    expect(copy).toContain(TECHNIQUE_BENCHMARK_UNAVAILABLE);
    expect(copy).toContain(APP_OWNED_REFUSAL_STATEMENT);
    expect(copy.split(APP_OWNED_REFUSAL_STATEMENT).join('')).not.toMatch(
      /rating was counted|counted/i,
    );
    expect(copy).not.toMatch(/\d(\.\d)?\s*[–-]\s*\d(\.\d)?/);
    expect(copy).not.toMatch(/\d+\s*%/);
    expect(copy).not.toMatch(/out of 10|TECHNIQUE SCORE/);
    expect(copy.replace(/confidence capped/gi, '')).not.toMatch(/confidence/i);
    expect(copy).not.toMatch(
      /Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|AI coach|best|most accurate|#1/i,
    );
    expect(copy).not.toMatch(/undefined|null|NaN|\[object Object\]/);

    const partialBlock = hostByTestId(renderer, 'result-partial-benchmark');
    expect(partialBlock).toHaveLength(1);
    const texts = partialBlock[0]!.findAllByType(Text);
    expect(texts.length).toBeGreaterThan(0);
    for (const node of texts) {
      const content = [node.props.children]
        .flat(3)
        .filter((c): c is string => typeof c === 'string')
        .join('')
        .trim();
      expect(content).not.toBe('');
      expect(node.props.accessibilityElementsHidden).not.toBe(true);
      expect(node.props.importantForAccessibility).not.toBe(
        'no-hide-descendants',
      );
    }
    const status = hostByTestId(renderer, 'result-benchmark-status');
    expect(status).toHaveLength(1);
    expect(status[0]!.props.children).toBe(TECHNIQUE_BENCHMARK_UNAVAILABLE);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
  });
});

describe('W01-05 attacks — upgraded installs', () => {
  it('A14 an install that was refused BEFORE this build (terminal run, HTTP 409, no refusal row — exactly what BASE_SHA left behind) is not dead-ended after the upgrade: the capture is delivered as partial or becomes recoverable, never stuck as awaiting_model forever', async () => {
    const { db, native, calls, failNext, req } = prepareRun(
      'atk-pre-upgrade-refusal',
    );
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    // Reproduce the BASE_SHA leftover on the candidate schema: the refusal
    // made the run terminal (reservation_rejected/409) but the previous build
    // had no sidecar to write and delivered nothing.
    failNext(
      'INTO local_analysis_record',
      new Error('disk I/O error (previous build)'),
    );
    const previousBuild = await attempt(runCaptureAnalysis(req));
    expect(previousBuild.kind).not.toBe('partial');
    native
      .prepare('DELETE FROM analysis_reservation_refusal WHERE owner_key = ?')
      .run(owner);
    const leftover = captureDbState(db).journal[0] as Record<string, unknown>;
    expect(leftover).toMatchObject({
      state: 'terminal',
      terminal_reason: 'reservation_rejected',
      last_http_status: 409,
      permit_id: null,
      result_id: null,
    });
    expect(refusalRows(native)).toHaveLength(0);
    expect(captureStatuses(db)).toEqual(['awaiting_model']);
    expect(captureDbState(db).records).toBe(0);
    const before = snapshotAccess();

    // This build runs: a direct retry, then the sync runtime's sweep, then
    // another retry — the user's whole recovery surface.
    const kinds: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const last = await attempt(runCaptureAnalysis(req));
      kinds.push(last.kind);
      if (last.kind === 'partial') break;
      const swept = await sweep(db, req.apiConfig);
      expect(swept.unknownStorage).toBe(false);
    }
    expectNoChargeableWrites(calls, refusing.urls, db);
    expect(snapshotAccess()).toEqual(before);
    const journal = captureDbState(db).journal[0] as Record<string, unknown>;
    expect({
      kinds,
      captures: captureStatuses(db),
      records: captureDbState(db).records,
      journal,
    }).toMatchObject({
      kinds: expect.arrayContaining(['partial']),
      captures: ['analyzed'],
      records: 1,
    });
  });
});
