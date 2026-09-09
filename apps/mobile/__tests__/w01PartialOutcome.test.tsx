/**
 * W01-05 — mechanics-only PARTIAL outcome never spends a free rating and
 * Result shows the honest partial state.
 *
 * The release authority answers the permit reservation with the typed,
 * settled HTTP 409 `access.release_not_authorized` ("no rating was counted").
 * The run must still deliver the mechanics evidence as an explicit
 * non-chargeable partial: no permit, no `local_shot` product row, no outbox
 * sync, no release call, the local free-rating view untouched, and a Result
 * page that states the technique benchmark is unavailable without any
 * invented score, confidence or benchmark range.
 *
 * Covered paths: the plain `runCaptureAnalysis` run and its replay, the
 * shipping original-operation path (`prepareOriginalCaptureAnalysis` +
 * `runOriginalCaptureAnalysis`, what AnalyzeScreen runs for a signed-in
 * pose-backed capture) and its replay, the technique-confirmation
 * continuation and its replay, refusal-message boundary values, a local
 * record-write failure between the settled refusal and the commit (plain and
 * original path — the same operation resumes without reserving again), the
 * non-partial answers (transport, 429, 5xx, paywall, unrelated 409) that must
 * keep their existing meaning, and the adversarial cases: double submit,
 * account switch mid-run, AUTO DETECT under refusal, tampered journal /
 * refusal metadata / record rows, owner purge under real foreign keys, and an
 * offline replay after restart.
 *
 * Real pipeline + real migrated SQLite (foreign keys ON, as in the app); only
 * the sidecar read, the native byte verification and HTTP are simulated.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
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
// Pinned contract values: the typed refusal code and the authority's own
// statement, used when the 409 body carries no usable message.
const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';
const SERVER_MESSAGE =
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

/** Any other answer on the reservation: the run keeps its existing meaning. */
function reservationServer(answer: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) return answer();
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

/** Normal permit authority (reserve + finalize both succeed). */
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
    if (url.includes('/finalize')) {
      // The real route acknowledges a release by naming the settled permit.
      const id = decodeURIComponent(
        url.slice(
          url.indexOf('/analysis-permits/') + 18,
          url.indexOf('/finalize'),
        ),
      );
      const body: unknown = JSON.parse(String(init?.body ?? '{}'));
      const outcome =
        typeof body === 'object' && body !== null && 'outcome' in body
          ? (body as { outcome: unknown }).outcome
          : null;
      return jsonResponse(
        { permit: { id, status: 'released', outcome }, access: freeAccess },
        200,
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

/** Offline device: every fetch fails before reaching any server. */
function offlineServer() {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    throw new TypeError('Network request failed');
  });
  return { fetchMock, urls };
}

function swingClipWithSidecar(label = 'w01-partial'): {
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
    apiConfig: { baseUrl: ORIGIN, token: 'token-w01-partial' },
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

type SettledOutcome =
  RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown };

async function settleOutcome(
  promise: Promise<RunCaptureAnalysisOutcome>,
): Promise<SettledOutcome> {
  return promise.catch((error: unknown) => ({ kind: 'threw' as const, error }));
}

function describeOutcome(outcome: SettledOutcome) {
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

const storeByDb = new Map<
  LocalDb,
  ReturnType<typeof createCaptureAnalysisDb>
>();

/** Real migrated SQLite bound as the app's current db; `fault` observes every
 * write statement (used to switch the active owner mid-run). */
function testDb(fault?: (sql: string, index: number) => void) {
  const store = createCaptureAnalysisDb(fault);
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

function allText(renderer: ReactTestRenderer): string {
  return allTextOf(renderer.root);
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function snapshotAccess() {
  return JSON.parse(JSON.stringify(useAccessStore.getState().canonicalAccess));
}

/** The exact durable marker every partial must carry. */
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
  expect(typeof outcome.record.partialOutcome.message).toBe('string');
  expect(outcome.record.partialOutcome.message.length).toBeGreaterThan(0);
  expect(outcome.record.partialOutcome.message.length).toBeLessThanOrEqual(512);
  expect(outcome.partialOutcome).toEqual(outcome.record.partialOutcome);
  expect('freeLimitReached' in outcome).toBe(false);
  return outcome;
}

/** Result for a partial: the honest label and statement, no numbers. */
async function expectPartialResult(analysisId: string, message: string) {
  const renderer = await renderResult(analysisId);
  const status = hostByTestId(renderer, 'result-benchmark-status');
  expect(status).toHaveLength(1);
  expect(status[0]!.props.children).toBe(TECHNIQUE_BENCHMARK_UNAVAILABLE);
  expect(hostByTestId(renderer, 'result-guide-step-abstained')).toHaveLength(1);
  expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
  expect(hostByTestId(renderer, 'result-partial-benchmark')).toHaveLength(1);
  const copy = allText(renderer);
  expect(copy).toContain(RESULT_LABEL);
  expect(copy).not.toContain('RESULT · NOT SCORED');
  expect(copy).toContain('RATING NOT CONSUMED');
  expect(copy).toContain(TECHNIQUE_BENCHMARK_UNAVAILABLE);
  expect(copy).toContain(message);
  expect(copy).not.toContain('out of 10');
  expect(copy).not.toContain('TECHNIQUE SCORE');
  expect(copy).not.toMatch(/\d(\.\d)?\s*[–-]\s*\d(\.\d)?/);
  expect(copy).not.toMatch(/\d+\s*%/);
  // No confidence VALUE or LEVEL anywhere (a classifier limiting factor such
  // as "confidence capped" names a withheld measurement, not a number), and
  // the benchmark block itself never speaks of confidence at all.
  expect(copy).not.toMatch(
    /confidence\s*[:=]?\s*\d|\d+(?:\.\d+)?\s*%?\s*confidence|(?:high|medium|low)[\s-]confidence/i,
  );
  expect(
    allTextOf(hostByTestId(renderer, 'result-partial-benchmark')[0]!),
  ).not.toMatch(/confidence|\d/i);
  expect(copy).not.toMatch(/DUPR|≈/);
  expect(mockListCatalogDrills).not.toHaveBeenCalled();
  expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
  return copy;
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
async function prepareOriginal(
  label: string,
  options: { declaredStroke: 'forehand_drive' | null; message?: unknown } = {
    declaredStroke: 'forehand_drive',
  },
) {
  const { db, calls, failNext } = testDb();
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
  const server = releaseNotAuthorizedServer(options.message ?? SERVER_MESSAGE);
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
    };
  };
  return {
    db,
    calls,
    failNext,
    server,
    req,
    execution,
    operation,
    run,
    readOperation,
    readCurrentAttempt,
  };
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

describe('W01-05 — mechanics-only partial outcome', () => {
  it('settles as an explicit non-chargeable partial: no permit, no product row, no outbox, no release call', async () => {
    const { db, calls, server, outcome, before } =
      await runPartial('w01-settle');
    const partial = expectPartialMarker(outcome);
    expect(partial.record.partialOutcome.message).toBe(SERVER_MESSAGE);

    // The chargeable route was never entered.
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(finalizeCalls(server.urls)).toHaveLength(0);
    expect(reserveCalls(server.urls)).toHaveLength(1);

    const state = captureDbState(db);
    expect(state.shots).toBe(0);
    expect(state.outbox).toBe(0);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    const journal = state.journal[0] as Record<string, unknown>;
    expect(journal.permit_id).toBeNull();
    expect(journal.result_id).toBeNull();
    expect(journal.state).toBe('terminal');
    expect(journal.terminal_reason).toBe('reservation_rejected');
    expect(journal.last_http_status).toBe(409);
    expect(journal.analysis_id).toBe(partial.analysisId);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });

  it('leaves the local free-rating view exactly as it was', async () => {
    const { outcome, before } = await runPartial('w01-free-view');
    expectPartialMarker(outcome);
    expect(snapshotAccess()).toEqual(before);
    expect(useAccessStore.getState().canonicalAccess?.freeRatings).toEqual({
      limit: 2,
      used: 1,
      reserved: 0,
      remaining: 1,
      availableToReserve: 1,
    });
  });

  it('replaying the same operation returns the saved partial without a second reservation', async () => {
    const { db, server, outcome, req, before } = await runPartial('w01-replay');
    const partial = expectPartialMarker(outcome);
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(partial.analysisId);
    expect(replay.record).toEqual(partial.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(captureDbState(db).journal).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
  });

  it('Result renders the explicit benchmark-unavailable state with no score, confidence or range', async () => {
    const { outcome } = await runPartial('w01-result');
    const partial = expectPartialMarker(outcome);
    await expectPartialResult(partial.analysisId, SERVER_MESSAGE);
  });

  it('the shipping original-operation path settles the typed refusal as the durable partial and replays it', async () => {
    const { db, calls, server, run } = await prepareOriginal('w01-original');
    const before = snapshotAccess();

    const outcome = await run();
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(finalizeCalls(server.urls)).toHaveLength(0);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);

    const partial = expectPartialMarker(outcome);
    expect(partial.record.partialOutcome.message).toBe(SERVER_MESSAGE);
    const state = captureDbState(db);
    expect(state.shots).toBe(0);
    expect(state.outbox).toBe(0);
    expect(state.records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    // Original attempts journal in analysis_execution_attempts: terminal,
    // no permit, the settled 409.
    const attempts = (
      await db.execute(
        'SELECT state, permit_id, result_id, terminal_reason, last_http_status, technical_failure FROM analysis_execution_attempts',
        [],
      )
    ).rows;
    expect(attempts).toEqual([
      {
        state: 'terminal',
        permit_id: null,
        result_id: null,
        terminal_reason: 'reservation_rejected',
        last_http_status: 409,
        technical_failure: null,
      },
    ]);
    const logical = (
      await db.execute(
        'SELECT analysis_id, current_attempt_id FROM analysis_logical_operations',
        [],
      )
    ).rows;
    expect(logical).toHaveLength(1);
    expect(logical[0]!.analysis_id).toBe(partial.analysisId);
    expect(logical[0]!.current_attempt_id).not.toBeNull();

    const replay = expectPartialMarker(await run());
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(partial.analysisId);
    expect(replay.record).toEqual(partial.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(partial.analysisId, SERVER_MESSAGE);
  });

  it('a technique-confirmation continuation settles as partial and its replay returns the durable partial', async () => {
    const { db, calls } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-continuation');
    mockReadArtifact = async () => sidecarJson;
    const permits = permitServer();
    setFetch(permits.fetchMock);
    const base = request(db, clip, 'w01-continuation');
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
    const continuation = expectPartialMarker(
      await runCaptureAnalysis(confirmed),
    );
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(reserveCalls(refusal.urls)).toHaveLength(1);
    expect(finalizeCalls(refusal.urls)).toHaveLength(0);
    expect(captureStatuses(db)).toEqual(['analyzed']);

    const replay = expectPartialMarker(await runCaptureAnalysis(confirmed));
    expect(reserveCalls(refusal.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(continuation.analysisId);
    expect(replay.record).toEqual(continuation.record);
    // The AUTO DETECT record and the continuation partial: nothing else.
    expect(captureDbState(db).records).toBe(2);

    await expectPartialResult(continuation.analysisId, SERVER_MESSAGE);
  });

  it.each([
    ['an empty', ''],
    ['a 513-character', 'x'.repeat(513)],
    ['a 2000-character', 'y'.repeat(2000)],
  ])(
    '%s refusal message is normalized once and the first run, its replay and Result agree',
    async (_label, message) => {
      const { calls, server, outcome, req, before } = await runPartial(
        `w01-message-${message.length}`,
        message,
      );
      const partial = expectPartialMarker(outcome);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      expect(reserveCalls(server.urls)).toHaveLength(1);
      const stored = partial.record.partialOutcome.message;
      if (message.length === 0) {
        expect(stored).not.toBe('');
      } else {
        expect(stored).toBe(message.slice(0, 512));
      }

      const replay = expectPartialMarker(await runCaptureAnalysis(req));
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(replay.replayed).toBe(true);
      expect(replay.record.partialOutcome).toEqual(
        partial.record.partialOutcome,
      );
      expect(snapshotAccess()).toEqual(before);

      const copy = await expectPartialResult(partial.analysisId, stored);
      if (message.length > 512)
        expect(copy).not.toContain(message.slice(0, 513));
    },
  );

  it('a failed record write after the settled refusal delivers nothing, keeps the capture unanalyzed, and lets the same operation retry without a second reservation', async () => {
    const { db, calls, failNext } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-write-failure');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'w01-write-failure');
    const before = snapshotAccess();
    const seededStatus = captureStatuses(db);
    failNext(
      'INTO local_analysis_record',
      new Error('disk I/O error (simulated process death)'),
    );

    const first = await runCaptureAnalysis(req).catch((error: unknown) => ({
      kind: 'threw' as const,
      error,
    }));
    expect(
      calls.some(call => call.sql.includes('INTO local_analysis_record')),
    ).toBe(true);
    expect(first.kind).not.toBe('partial');
    expect(first.kind).not.toBe('scored');
    expect(first.kind).not.toBe('low_confidence');
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const afterFailure = captureDbState(db);
    expect(afterFailure.records).toBe(0);
    expect(afterFailure.shots).toBe(0);
    expect(afterFailure.outbox).toBe(0);
    expect(captureStatuses(db)).toEqual(seededStatus);
    expect(snapshotAccess()).toEqual(before);
    expect(reserveCalls(server.urls)).toHaveLength(1);

    const retry = expectPartialMarker(await runCaptureAnalysis(req));
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(finalizeCalls(server.urls)).toHaveLength(0);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    expect((state.journal[0] as Record<string, unknown>).permit_id).toBeNull();
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(retry.analysisId);
    expect(reserveCalls(server.urls)).toHaveLength(1);
  });

  it('a failed record write on the original-operation path leaves nothing half-delivered, never charges, and the same operation resumes to the partial without reserving again', async () => {
    const {
      db,
      calls,
      failNext,
      server,
      run,
      execution,
      operation,
      readCurrentAttempt,
    } = await prepareOriginal('w01-original-write-failure');
    const before = snapshotAccess();
    const seededStatus = captureStatuses(db);
    failNext(
      'INTO local_analysis_record',
      new Error('disk I/O error (simulated process death)'),
    );

    const first = await settleOutcome(run());
    expect(
      calls.some(call => call.sql.includes('INTO local_analysis_record')),
    ).toBe(true);
    expect(first.kind).not.toBe('partial');
    expect(first.kind).not.toBe('scored');
    expect(first.kind).not.toBe('low_confidence');
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(finalizeCalls(server.urls)).toHaveLength(0);
    const state = captureDbState(db);
    expect(state.records).toBe(0);
    expect(state.shots).toBe(0);
    expect(state.outbox).toBe(0);
    expect(captureStatuses(db)).toEqual(seededStatus);
    expect(snapshotAccess()).toEqual(before);
    // The refusal itself is settled and durable: terminal, permit-less,
    // never chargeable — and its metadata survived the lost record write.
    expect(await readCurrentAttempt()).toEqual({
      state: 'terminal',
      permitId: null,
      resultId: null,
      terminalReason: 'reservation_rejected',
      technicalFailure: null,
      finalRecordId: null,
    });
    expect(refusalRows(db)).toHaveLength(1);

    // What AnalyzeScreen does next for an operation it could not finish:
    // reconcile the current attempt, then run the same operation again. The
    // mechanics partial must be delivered exactly as on the plain path.
    await reconcileOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });
    const retry = expectPartialMarker(await run());
    expect(retry.record.partialOutcome.message).toBe(SERVER_MESSAGE);
    const again = expectPartialMarker(await run());
    expect(again.replayed).toBe(true);
    expect(again.analysisId).toBe(retry.analysisId);
    expect(again.record).toEqual(retry.record);
    const settled = await readCurrentAttempt();
    expect(settled).toEqual({
      state: 'terminal',
      permitId: null,
      resultId: null,
      terminalReason: 'reservation_rejected',
      technicalFailure: null,
      finalRecordId: retry.analysisId,
    });
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(finalizeCalls(server.urls)).toHaveLength(0);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const after = captureDbState(db);
    expect(after.records).toBe(1);
    expect(after.shots).toBe(0);
    expect(after.outbox).toBe(0);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(retry.analysisId, SERVER_MESSAGE);
  });

  it('AUTO DETECT (no declared stroke) under the typed refusal on the original path delivers a durable partial, never a permanent dead end', async () => {
    const { db, calls, server, run, readCurrentAttempt } =
      await prepareOriginal('w01-auto-detect', { declaredStroke: null });
    const before = snapshotAccess();

    const first = expectPartialMarker(await run());
    const again = expectPartialMarker(await run());
    expect(again.replayed).toBe(true);
    expect(again.analysisId).toBe(first.analysisId);
    expect(again.record).toEqual(first.record);
    expect(first.record.strokeIntent.declaredStroke).toBeNull();
    expect(await readCurrentAttempt()).toEqual({
      state: 'terminal',
      permitId: null,
      resultId: null,
      terminalReason: 'reservation_rejected',
      technicalFailure: null,
      finalRecordId: first.analysisId,
    });
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(finalizeCalls(server.urls)).toHaveLength(0);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(state.shots).toBe(0);
    expect(state.outbox).toBe(0);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(first.analysisId, SERVER_MESSAGE);
  });

  it.each([
    [
      'a transport failure',
      () => {
        throw new TypeError('Network request failed');
      },
      undefined,
    ],
    [
      'HTTP 429',
      () =>
        jsonResponse(
          { error: { code: 'rate_limited', message: 'Slow down.' } },
          429,
          { 'retry-after': '1' },
        ),
      undefined,
    ],
    [
      'HTTP 503',
      () =>
        jsonResponse(
          { error: { code: 'unavailable', message: 'Try again later.' } },
          503,
        ),
      undefined,
    ],
    [
      'a paywall answer',
      () =>
        jsonResponse(
          {
            error: {
              code: 'access.paywall_required',
              message: 'Upgrade to keep rating.',
            },
          },
          402,
        ),
      'paywall_required',
    ],
    [
      'an unrelated typed 409',
      () =>
        jsonResponse(
          {
            error: {
              code: 'access.permit_already_finalized',
              message: 'Analysis permit was already finalized.',
            },
          },
          409,
        ),
      undefined,
    ],
    [
      'a 409 without the typed refusal body',
      () => jsonResponse({ unexpected: true }, 409),
      undefined,
    ],
  ])(
    '%s on the reservation is not a partial: no record, capture unanalyzed, nothing charged',
    async (_label, answer, cause) => {
      const { db, calls } = testDb();
      const { clip, sidecarJson } = swingClipWithSidecar(`w01-${_label}`);
      mockReadArtifact = async () => sidecarJson;
      const server = reservationServer(answer);
      setFetch(server.fetchMock);
      const req = request(db, clip, `w01-non-partial-${_label}`);
      const before = snapshotAccess();
      const seededStatus = captureStatuses(db);

      const outcome = await runCaptureAnalysis(req);
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(outcome.cause).toBe(cause);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      expect(captureDbState(db).records).toBe(0);
      expect(captureStatuses(db)).toEqual(seededStatus);
      expect(snapshotAccess()).toEqual(before);
    },
  );
});

describe('W01-05 — adversarial: concurrency, ownership, corrupt state, deletion, offline', () => {
  it('a double submit of the same operation under refusal reserves once, stores one partial and charges nothing', async () => {
    const { db, calls } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-double-submit');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'w01-double-submit');
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
    'an account switch %s lands nothing for either owner, and the original owner later gets the partial without a second reservation',
    async (_label, statement) => {
      let switched = false;
      const { db, calls } = testDb(sql => {
        if (!switched && sql.includes(statement)) {
          switched = true;
          setActiveDataOwner(otherOwner);
        }
      });
      const { clip, sidecarJson } = swingClipWithSidecar(
        `w01-switch-${statement}`,
      );
      mockReadArtifact = async () => sidecarJson;
      const server = releaseNotAuthorizedServer();
      setFetch(server.fetchMock);
      const req = request(db, clip, `w01-switch-${statement}`);
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
      for (const row of refusalRows(db)) expect(row.owner_key).toBe(owner);
      expect(snapshotAccess()).toEqual(before);

      // The other account cannot see or finish the first owner's run.
      signInCaptureOwner(otherOwner, ORIGIN);
      const foreign = await settleOutcome(
        runCaptureAnalysis({ ...req, ownerContext: captureDataOwnerContext() }),
      );
      expect(foreign.kind).not.toBe('partial');
      expect(foreign.kind).not.toBe('scored');
      expect(foreign.kind).not.toBe('low_confidence');
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

  it.each([
    ['an object', { nested: true }],
    ['a number', 42],
    ['an array', ['not', 'a', 'sentence']],
    ['a whitespace-only string', '   '],
    ['a null', null],
  ])(
    '%s refusal message falls back to the authority statement on Result, never a coerced value or transport status',
    async (_label, message) => {
      const { db, calls } = testDb();
      const { clip, sidecarJson } = swingClipWithSidecar(
        `w01-boundary-${_label}`,
      );
      mockReadArtifact = async () => sidecarJson;
      const server = releaseNotAuthorizedServer(message);
      setFetch(server.fetchMock);
      const req = request(db, clip, `w01-boundary-${_label}`);
      const before = snapshotAccess();

      const outcome = expectPartialMarker(await runCaptureAnalysis(req));
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(snapshotAccess()).toEqual(before);

      const renderer = await renderResult(outcome.analysisId);
      const copy = allText(renderer);
      expect({
        storedMessage: outcome.record.partialOutcome.message,
        statusNode: hostByTestId(renderer, 'result-benchmark-status').length,
        renderedFallback: copy.includes(TECHNIQUE_BENCHMARK_UNAVAILABLE),
        renderedObjectToString: /\[object Object\]/.test(copy),
        renderedBareNumberStatement: /RATING NOT CONSUMED[^.]*\b42\b/.test(
          copy,
        ),
        renderedHttpStatusAsStatement: /HTTP 409/.test(copy),
      }).toEqual({
        storedMessage: SERVER_MESSAGE,
        statusNode: 1,
        renderedFallback: true,
        renderedObjectToString: false,
        renderedBareNumberStatement: false,
        renderedHttpStatusAsStatement: false,
      });
    },
  );

  it('a journal row that later claims a permit is no longer a settled refusal: replay holds, never re-reserves or charges', async () => {
    const { db, calls, native } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-forged-journal');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'w01-forged-journal');
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const before = snapshotAccess();

    native
      .prepare(
        `UPDATE analysis_run_journal SET permit_id = ? WHERE owner_key = ? AND operation_id = ?`,
      )
      .run(fixtureUuid('w01-forged-permit'), owner, req.operationId);

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

  it('durable refusal metadata with a foreign reason code is not replayed as the typed partial', async () => {
    const { db, native, failNext } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-foreign-refusal');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'w01-foreign-refusal');
    // Settle the refusal but lose the record write, then corrupt the stored
    // reason before the resume.
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
    // Only the exact typed refusal is a partial. Metadata carrying any other
    // code is unknown state: hold, do not fabricate the marker.
    expect({
      kind: resumed.kind,
      reasonCode:
        resumed.kind === 'partial'
          ? resumed.record.partialOutcome.reasonCode
          : null,
      reservations: reserveCalls(server.urls).length,
      records: captureDbState(db).records,
      shots: captureDbState(db).shots,
      accessUnchanged:
        JSON.stringify(snapshotAccess()) === JSON.stringify(before),
    }).toEqual({
      kind: 'unavailable',
      reasonCode: null,
      reservations: 1,
      records: 0,
      shots: 0,
      accessUnchanged: true,
    });
  });

  it('a truncated stored partial record resolves to a typed hold, not an unhandled SQLite error or a fabricated result', async () => {
    const { db, native, calls } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-torn-record');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'w01-torn-record');
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const before = snapshotAccess();
    // Simulate a torn write: the row exists but its JSON is cut short.
    native
      .prepare(
        `UPDATE local_analysis_record SET record = substr(record, 1, 40) WHERE owner_key = ? AND id = ?`,
      )
      .run(owner, partial.analysisId);

    const replay = await settleOutcome(runCaptureAnalysis(req));
    expect({
      replay: describeOutcome(replay),
      reservations: reserveCalls(server.urls).length,
      records: captureDbState(db).records,
      shots: captureDbState(db).shots,
      localShotInserts: localShotInserts(calls).length,
      captureStatus: captureStatuses(db),
      accessUnchanged:
        JSON.stringify(snapshotAccess()) === JSON.stringify(before),
    }).toEqual({
      replay: { kind: 'unavailable', cause: 'recovery_pending' },
      reservations: 1,
      records: 1,
      shots: 0,
      localShotInserts: 0,
      captureStatus: ['analyzed'],
      accessUnchanged: true,
    });
  });

  it('account deletion: purgeOwnerData removes every row of an owner who has a settled refusal, under real foreign-key enforcement', async () => {
    const { db, native } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-purge');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'w01-purge');
    expectPartialMarker(await runCaptureAnalysis(req));
    expect(refusalRows(db)).toHaveLength(1);
    expect(
      (native.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
        .foreign_keys,
    ).toBe(1);

    const purge = await purgeOwnerData(db, owner).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const count = (table: string) =>
      Number(
        (
          native
            .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
            .get(owner) as { n: number }
        ).n,
      );
    // After the server confirms account deletion, no row of the deleted
    // owner survives on the device — including the refusal metadata.
    expect({
      purge,
      remaining: {
        local_capture: count('local_capture'),
        local_analysis_record: count('local_analysis_record'),
        analysis_run_journal: count('analysis_run_journal'),
        analysis_reservation_refusal: count('analysis_reservation_refusal'),
      },
      foreignKeyCheck: native.prepare('PRAGMA foreign_key_check').all(),
    }).toEqual({
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

  it('after a restart with no network, the durable partial replays and renders with zero network calls and no charge', async () => {
    const { db, calls } = testDb();
    const { clip, sidecarJson } = swingClipWithSidecar('w01-offline');
    mockReadArtifact = async () => sidecarJson;
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const req = request(db, clip, 'w01-offline');
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

    await expectPartialResult(partial.analysisId, SERVER_MESSAGE);
    expect(offline.urls).toHaveLength(0);
  });
});
