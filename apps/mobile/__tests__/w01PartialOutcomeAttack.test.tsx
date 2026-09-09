/**
 * W01-05 adversarial attacks against candidate dc6f7b81.
 *
 * Each test drives the real pipeline on real migrated SQLite through the
 * failure boundary the candidate claims to hold: concurrency, account switch
 * and cancellation mid-refusal, clock rollback / far-future clocks, corrupt
 * or tampered persisted refusal and record state, a redirected reservation
 * answer, transport failure followed by the settled refusal on the shipping
 * original-operation path, cross-owner isolation, a replay after the
 * authority would now grant a permit, purge in the resume state, and the
 * copy of a server refusal message that carries forbidden or invented
 * numbers. Only the sidecar read, the native byte verification and HTTP are
 * simulated.
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
  recoverAnalysisJournals,
  runJournal,
  RunJournalError,
} from '../src/analysis/runJournal';
import { createAnalysisPermitClient } from '../src/data/api';
import { finalizeAcknowledgement } from '../__harness__/analysisPermitRoute';
import { captureDataOwnerContext } from '../src/data/accountScope';
import { purgeOwnerData } from '../src/data/repository';
import { useAccessStore } from '../src/state/accessStore';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
const otherOwner = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://api.test';
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
  transport: { redirected?: boolean; url?: string } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    redirected: transport.redirected ?? false,
    ...(transport.url !== undefined ? { url: transport.url } : {}),
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

/** Release authority refuses admission; `beforeAnswer` runs mid round trip. */
function releaseNotAuthorizedServer(
  message: unknown = SERVER_MESSAGE,
  beforeAnswer: (call: number) => Promise<void> | void = () => {},
) {
  const urls: string[] = [];
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) {
      reservations += 1;
      await beforeAnswer(reservations);
      return jsonResponse(refusalBody(message), 409);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

/** A scripted sequence of reservation answers, one per reservation call. */
function scriptedReservationServer(
  answers: Array<() => Response | Promise<Response>>,
) {
  const urls: string[] = [];
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) {
      const answer = answers[reservations];
      reservations += 1;
      if (!answer) throw new Error(`Unscripted reservation #${reservations}`);
      return answer();
    }
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
    if (url.includes('/finalize'))
      return jsonResponse(
        finalizeAcknowledgement(url, JSON.parse(String(init?.body))),
        200,
      );
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
const finalizeCalls = (urls: string[]) =>
  urls.filter(url => url.includes('/finalize'));
const captureStatuses = (db: LocalDb) =>
  captureDbState(db).captures.map(row => (row as { status: string }).status);

type NativeTestDb = ReturnType<typeof createCaptureAnalysisDb>['native'];

const ownerRowCount = (
  native: NativeTestDb,
  table: string,
  ownerKey: string = owner,
) =>
  Number(
    (
      native
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
        .get(ownerKey) as { n: number }
    ).n,
  );

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
  expect(outcome.partialOutcome).toEqual(outcome.record.partialOutcome);
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

function unavailableCause(outcome: RunCaptureAnalysisOutcome) {
  expect(outcome.kind).toBe('unavailable');
  if (outcome.kind !== 'unavailable') throw new Error('not unavailable');
  return outcome.cause;
}

function prepareRun(
  label: string,
  fault?: (sql: string, index: number) => void,
) {
  const { db, native, calls, failNext } = createCaptureAnalysisDb(fault);
  mockCurrentDb = () => db;
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const req = request(db, clip, label);
  return { db, native, calls, failNext, clip, req };
}

/** What AnalyzeScreen does for a signed-in, pose-backed camera capture. */
async function prepareOriginal(label: string, fetchMock: unknown) {
  const { db, native, calls, failNext } = createCaptureAnalysisDb();
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
  setFetch(fetchMock);
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
  const run = (predecessorAttemptId?: string) =>
    runOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
      ...(predecessorAttemptId !== undefined ? { predecessorAttemptId } : {}),
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
    db,
    native,
    calls,
    failNext,
    req,
    execution,
    operation,
    run,
    readAttempt,
  };
}

const realDateNow = Date.now;

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
  mockVerifyBytes = async () => ({ status: 'unavailable' });
});
afterEach(async () => {
  Date.now = realDateNow;
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
});

describe('W01-05 attacks — concurrency and interruption at the refusal boundary', () => {
  it('A1 double submit: two concurrent runs of the same operation reserve once, settle one partial, never charge and never crash', async () => {
    const { db, calls, req } = prepareRun('attack-double-submit');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const server = releaseNotAuthorizedServer(SERVER_MESSAGE, () => gate);
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const first = runCaptureAnalysis(req);
    const second = runCaptureAnalysis(req);
    // Let both runs reach whatever boundary they reach, then answer.
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const outcomes = await Promise.all([first, second]);

    expect(reserveCalls(server.urls)).toHaveLength(1);
    const partials = outcomes.filter(outcome => outcome.kind === 'partial');
    expect(partials.length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      expect(['partial', 'unavailable']).toContain(outcome.kind);
      if (outcome.kind === 'partial') expectPartialMarker(outcome);
      else
        expect(outcome).toMatchObject({
          kind: 'unavailable',
          cause: 'recovery_pending',
        });
    }
    expectNoChargeableWrites(calls, server.urls, db);
    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    // The loser of the race replays the winner's partial, no reservation.
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(server.urls)).toHaveLength(1);
  });

  it('A2 account switch while the authority answers: nothing is delivered to the wrong owner, the original owner later gets the partial with no second reservation', async () => {
    const { db, native, calls, req } = prepareRun('attack-account-switch');
    const server = releaseNotAuthorizedServer(SERVER_MESSAGE, () => {
      signInCaptureOwner(otherOwner, ORIGIN);
    });
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const outcome = await runCaptureAnalysis(req);
    expect(unavailableCause(outcome)).toBe('account_changed');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(0);
    expect(ownerRowCount(native, 'analysis_run_journal', otherOwner)).toBe(0);
    expect(
      ownerRowCount(native, 'analysis_reservation_refusal', otherOwner),
    ).toBe(0);
    expect(ownerRowCount(native, 'local_analysis_record', otherOwner)).toBe(0);
    expect(snapshotAccess()).toEqual(before);

    // The other account renders nothing of the refused run.
    const analysisId = (
      captureDbState(db).journal[0] as { analysis_id: string } | undefined
    )?.analysis_id;
    expect(typeof analysisId).toBe('string');
    const foreign = await renderResult(analysisId!);
    expect(hostByTestId(foreign, 'result-partial-benchmark')).toHaveLength(0);
    expect(allText(foreign)).not.toContain(RESULT_LABEL);

    // Back on the original account the same operation resumes the settled
    // refusal: exactly one reservation ever, one partial, nothing charged.
    signInCaptureOwner(owner, ORIGIN);
    const resumed = await runCaptureAnalysis({
      ...req,
      ownerContext: captureDataOwnerContext(),
    });
    expectPartialMarker(resumed);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A3 cancellation while the authority answers: the run reports cancelled, then the same operation resumes the settled refusal without reserving again', async () => {
    const { db, calls, req } = prepareRun('attack-cancel');
    const controller = new AbortController();
    const server = releaseNotAuthorizedServer(SERVER_MESSAGE, () => {
      controller.abort();
    });
    setFetch(server.fetchMock);
    const before = snapshotAccess();

    const outcome = await runCaptureAnalysis({
      ...req,
      signal: controller.signal,
    });
    expect(unavailableCause(outcome)).toBe('cancelled');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(0);
    expect(snapshotAccess()).toEqual(before);

    const resumed = expectPartialMarker(await runCaptureAnalysis(req));
    expect(resumed.record.partialOutcome.message).toBe(SERVER_MESSAGE);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A4 shipping path: a 503 attempt followed by the settled refusal on the retry attempt delivers the partial, never a dead end or a charge', async () => {
    const server = scriptedReservationServer([
      () =>
        jsonResponse(
          { error: { code: 'unavailable', message: 'Try again later.' } },
          503,
        ),
      () => jsonResponse(refusalBody(), 409),
    ]);
    const { db, calls, run, readAttempt, execution, operation } =
      await prepareOriginal('attack-503-then-409', server.fetchMock);
    const before = snapshotAccess();

    const first = await run();
    expect(first.kind).toBe('unavailable');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);

    // What the screen does: reconcile, then retry the saved analysis.
    await reconcileOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });
    const failed = await readAttempt();
    expect(failed.attempt.technicalFailure).toBe('reservation_transport');
    expect(failed.attempt.run.permitId).toBeNull();
    // The authority has now answered the operation's reservation with the
    // typed refusal (through recovery's re-reservation): exactly two
    // reservation calls were made and the second was refused.
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expect(failed.attempt.run.lastHttpStatus).toBe(409);
    // What the screen offers next is either a retry of the saved analysis or
    // another check; whichever it takes, the refused operation must settle
    // the mechanics as a non-chargeable partial rather than a dead end.
    const retry = await run(failed.attempt.run.operationId);
    const checked = retry.kind === 'partial' ? retry : await run();
    expect({ checked, captures: captureStatuses(db) }).not.toMatchObject({
      checked: { kind: 'unavailable', cause: 'recovery_pending' },
      captures: ['awaiting_model'],
    });
    expectPartialMarker(checked);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
    const delivered = await readAttempt();
    expect(delivered.operation.completionKind).toBe('partial');
    expect(delivered.attempt.run.permitId).toBeNull();

    const replay = expectPartialMarker(await run());
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attacks — clocks', () => {
  it('A5 clock rollback between the settled refusal and its resume/replay never reserves again, never throws and never charges', async () => {
    const { db, calls, failNext, req } = prepareRun('attack-clock-rollback');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const t0 = realDateNow();
    Date.now = () => t0;
    failNext('INTO local_analysis_record', new Error('disk I/O error'));
    const first = await runCaptureAnalysis(req).catch((error: unknown) => ({
      kind: 'threw' as const,
      error,
    }));
    expect(first.kind).not.toBe('partial');
    expect(captureDbState(db).records).toBe(0);

    // The device clock jumps back a full day before the retry.
    Date.now = () => t0 - 24 * 60 * 60 * 1000;
    const resumed = expectPartialMarker(await runCaptureAnalysis(req));
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);

    Date.now = () => t0 - 2 * 24 * 60 * 60 * 1000;
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(resumed.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A6 a far-future device clock still settles the refusal as a bounded partial and replays it', async () => {
    const { db, calls, req } = prepareRun('attack-far-future');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    Date.now = () => Date.UTC(2200, 0, 1);
    const outcome = expectPartialMarker(await runCaptureAnalysis(req));
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(outcome.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attacks — corrupt and tampered persisted state', () => {
  it('A7 the refusal table refuses forged rows: no run, a reserved run, an update, and a duplicate are all rejected', async () => {
    const { db, native, req } = prepareRun('attack-forged-refusal');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    expectPartialMarker(await runCaptureAnalysis(req));
    const journal = captureDbState(db).journal[0] as {
      owner_key: string;
      operation_id: string;
      analysis_id: string;
      capture_id: string;
    };
    const insert = native.prepare(
      `INSERT INTO analysis_reservation_refusal
        (owner_key, operation_id, analysis_id, capture_id, reason_code, message, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // A refusal for a run that never existed.
    expect(() =>
      insert.run(
        owner,
        fixtureUuid('forged-op'),
        fixtureUuid('forged-analysis'),
        journal.capture_id,
        RELEASE_NOT_AUTHORIZED_CODE,
        SERVER_MESSAGE,
        Date.now(),
      ),
    ).toThrow(/settled permit-less run/);
    // A duplicate for the settled run.
    expect(() =>
      insert.run(
        owner,
        journal.operation_id,
        journal.analysis_id,
        journal.capture_id,
        RELEASE_NOT_AUTHORIZED_CODE,
        'a second, different statement',
        Date.now(),
      ),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    // Rewriting the stored statement or reason.
    expect(() =>
      native
        .prepare(
          `UPDATE analysis_reservation_refusal SET message = ? WHERE owner_key = ? AND operation_id = ?`,
        )
        .run('Your rating was counted.', owner, journal.operation_id),
    ).toThrow(/immutable/);
    expect(() =>
      native
        .prepare(
          `UPDATE analysis_reservation_refusal SET reason_code = ? WHERE owner_key = ? AND operation_id = ?`,
        )
        .run('access.paywall_required', owner, journal.operation_id),
    ).toThrow(/immutable/);
    // A refusal against a run that actually holds a permit (reserved).
    native
      .prepare(
        `INSERT INTO analysis_run_journal
          (owner_key, operation_id, owner_generation, capture_id, analysis_id, request_hash,
           api_origin, reservation_key, state, permit_id, created_at_ms, updated_at_ms)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      )
      .run(
        owner,
        fixtureUuid('reserved-op'),
        journal.capture_id,
        fixtureUuid('reserved-analysis'),
        sha256Hex('reserved-request'),
        ORIGIN,
        fixtureUuid('reserved-key'),
        fixtureUuid('reserved-permit'),
        Date.now(),
        Date.now(),
      );
    expect(() =>
      insert.run(
        owner,
        fixtureUuid('reserved-op'),
        fixtureUuid('reserved-analysis'),
        journal.capture_id,
        RELEASE_NOT_AUTHORIZED_CODE,
        SERVER_MESSAGE,
        Date.now(),
      ),
    ).toThrow(/settled permit-less run/);
    expect(ownerRowCount(native, 'analysis_reservation_refusal')).toBe(1);
  });

  it('A8 a settled refusal whose durable refusal row was lost never becomes a scored/low-confidence result, a new reservation, or a crash', async () => {
    const { db, native, calls, req } = prepareRun('attack-lost-refusal-row');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    // Simulate corruption: the refusal metadata is gone, the terminal
    // permit-less journal row and the mechanics record remain.
    native
      .prepare('DELETE FROM analysis_reservation_refusal WHERE owner_key = ?')
      .run(owner);
    expect(ownerRowCount(native, 'analysis_reservation_refusal')).toBe(0);

    let thrown: unknown = null;
    let outcome: RunCaptureAnalysisOutcome | null = null;
    try {
      outcome = await runCaptureAnalysis(req);
    } catch (error) {
      thrown = error;
    }
    if (thrown !== null) expect(thrown).toBeInstanceOf(RunJournalError);
    if (outcome !== null) {
      expect(['partial', 'unavailable']).toContain(outcome.kind);
      if (outcome.kind === 'partial') {
        expect(outcome.record).toEqual(partial.record);
      }
    }
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);

    // Result never invents a benchmark for the stored mechanics-only record.
    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    expect(copy).not.toContain('out of 10');
    expect(copy).not.toContain('TECHNIQUE SCORE');
    expect(copy).not.toMatch(/\d+\s*%/);
  });

  it('A9 a tampered stored partial that smuggles a fabricated result is not replayed as a score and never reserves again', async () => {
    const { db, native, calls, req } = prepareRun('attack-tampered-record');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const row = native
      .prepare(
        'SELECT record FROM local_analysis_record WHERE owner_key = ? AND id = ?',
      )
      .get(owner, partial.analysisId) as { record: string };
    const stored = JSON.parse(row.record) as Record<string, unknown>;
    stored.result = {
      id: partial.analysisId,
      resultKind: 'scored',
      overallScore: 9.9,
      confidence: 0.99,
    };
    native
      .prepare(
        'UPDATE local_analysis_record SET record = ? WHERE owner_key = ? AND id = ?',
      )
      .run(JSON.stringify(stored), owner, partial.analysisId);

    let thrown: unknown = null;
    let outcome: RunCaptureAnalysisOutcome | null = null;
    try {
      outcome = await runCaptureAnalysis(req);
    } catch (error) {
      thrown = error;
    }
    if (thrown !== null) {
      expect(thrown).toBeInstanceOf(RunJournalError);
      expect((thrown as RunJournalError).code).toBe('identity_conflict');
    }
    if (outcome !== null) {
      expect(outcome.kind).not.toBe('scored');
      expect(outcome.kind).not.toBe('low_confidence');
      if (outcome.kind === 'partial') expect(outcome.record.result).toBeNull();
    }
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A10 purge in the resume state (settled refusal, no mechanics record) removes every owner row and leaves no dangling reference', async () => {
    const { db, native, failNext, req } = prepareRun('attack-purge-resume');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    failNext('INTO local_analysis_record', new Error('disk I/O error'));
    const first = await runCaptureAnalysis(req).catch((error: unknown) => ({
      kind: 'threw' as const,
      error,
    }));
    expect(first.kind).not.toBe('partial');
    expect(ownerRowCount(native, 'analysis_reservation_refusal')).toBe(1);
    expect(ownerRowCount(native, 'analysis_run_journal')).toBe(1);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(0);

    await expect(purgeOwnerData(db, owner)).resolves.toBeUndefined();
    expect({
      local_capture: ownerRowCount(native, 'local_capture'),
      analysis_run_journal: ownerRowCount(native, 'analysis_run_journal'),
      analysis_reservation_refusal: ownerRowCount(
        native,
        'analysis_reservation_refusal',
      ),
    }).toEqual({
      local_capture: 0,
      analysis_run_journal: 0,
      analysis_reservation_refusal: 0,
    });
    expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('W01-05 attacks — transport, isolation and replay after a later grant', () => {
  it('A11 a redirected answer carrying the typed refusal body is a transport artifact, never a settled partial', async () => {
    const { db, calls, req } = prepareRun('attack-redirect');
    const server = scriptedReservationServer([
      () =>
        jsonResponse(
          refusalBody(),
          409,
          {},
          {
            redirected: true,
            url: 'https://captive.portal.example/login',
          },
        ),
    ]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const seeded = captureStatuses(db);
    const outcome = await runCaptureAnalysis(req);
    expect(outcome.kind).toBe('unavailable');
    expect(unavailableCause(outcome)).toBeUndefined();
    expect(captureDbState(db).records).toBe(0);
    expect(captureStatuses(db)).toEqual(seeded);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(snapshotAccess()).toEqual(before);
    const refusalRows = (
      await db.execute('SELECT * FROM analysis_reservation_refusal', [])
    ).rows;
    expect(refusalRows).toHaveLength(0);
  });

  it('A12 a 429 with Retry-After followed by the settled refusal (plain path) never charges and never fabricates a result', async () => {
    const { db, calls, req } = prepareRun('attack-429-then-409');
    const server = scriptedReservationServer([
      () =>
        jsonResponse(
          { error: { code: 'rate_limited', message: 'Slow down.' } },
          429,
          { 'retry-after': '1' },
        ),
      () => jsonResponse(refusalBody(), 409),
    ]);
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const first = await runCaptureAnalysis(req);
    expect(first.kind).toBe('unavailable');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    // The sync runtime's recovery sweep (syncRuntime.trigger) re-reserves the
    // permit-less pending run and this time receives the typed refusal.
    const scope = runJournal.scope({
      ownerKey: captureDataOwnerContext().ownerKey,
      apiOrigin: ORIGIN,
    });
    const recovered = await recoverAnalysisJournals(db, scope, {
      ...scope,
      ...createAnalysisPermitClient(req.apiConfig),
    });
    expect(recovered.unknownStorage).toBe(false);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    const journal = captureDbState(db).journal[0] as {
      state: string;
      terminal_reason: string | null;
      last_http_status: number | null;
      permit_id: string | null;
    };
    expect(journal.permit_id).toBeNull();
    expect(journal.last_http_status).toBe(409);
    // The refused operation must now settle the mechanics as a partial;
    // it must never fabricate a score, reserve again or charge.
    const second = await runCaptureAnalysis(req);
    expect(second.kind).not.toBe('scored');
    expect(second.kind).not.toBe('low_confidence');
    expect({ second, captures: captureStatuses(db) }).not.toMatchObject({
      second: { kind: 'unavailable', cause: 'recovery_pending' },
      captures: ['awaiting_model'],
    });
    expectPartialMarker(second);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A13 another signed-in account cannot see, replay or re-reserve the first owner’s settled partial', async () => {
    const { db, native, calls, req } = prepareRun('attack-other-owner');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const before = snapshotAccess();

    signInCaptureOwner(otherOwner, ORIGIN);
    const foreign = await renderResult(partial.analysisId);
    expect(hostByTestId(foreign, 'result-partial-benchmark')).toHaveLength(0);
    expect(hostByTestId(foreign, 'result-benchmark-status')).toHaveLength(0);
    const copy = allText(foreign);
    expect(copy).not.toContain(RESULT_LABEL);
    expect(copy).not.toContain(SERVER_MESSAGE);

    let thrown: unknown = null;
    let outcome: RunCaptureAnalysisOutcome | null = null;
    try {
      outcome = await runCaptureAnalysis({
        ...req,
        ownerContext: captureDataOwnerContext(),
      });
    } catch (error) {
      thrown = error;
    }
    if (thrown !== null) expect(thrown).toBeInstanceOf(RunJournalError);
    if (outcome !== null) {
      expect(outcome.kind).toBe('unavailable');
    }
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(ownerRowCount(native, 'analysis_run_journal', otherOwner)).toBe(0);
    expect(
      ownerRowCount(native, 'analysis_reservation_refusal', otherOwner),
    ).toBe(0);
    expect(ownerRowCount(native, 'local_analysis_record', otherOwner)).toBe(0);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(snapshotAccess()).toEqual(before);
  });

  it('A14 once settled, a replay against an authority that would now grant a permit still returns the partial with zero new reservations', async () => {
    const { db, calls, req } = prepareRun('attack-late-grant');
    const refusing = releaseNotAuthorizedServer();
    setFetch(refusing.fetchMock);
    const before = snapshotAccess();
    const partial = expectPartialMarker(await runCaptureAnalysis(req));

    const granting = permitServer();
    setFetch(granting.fetchMock);
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(partial.record);
    expect(granting.urls).toHaveLength(0);
    expectNoChargeableWrites(calls, [...refusing.urls, ...granting.urls], db);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 attacks — refusal message copy on Result', () => {
  const FORBIDDEN_MESSAGE =
    'Your DUPR is about 4.5 ≈ 87% confidence; rating was counted.';

  it('A15 Result never displays invented numbers or forbidden terms from a server refusal message', async () => {
    const { req } = prepareRun('attack-copy-forbidden');
    const server = releaseNotAuthorizedServer(FORBIDDEN_MESSAGE);
    setFetch(server.fetchMock);
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    const renderer = await renderResult(partial.analysisId);
    expect(hostByTestId(renderer, 'result-partial-benchmark')).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain(RESULT_LABEL);
    expect(copy).toContain(TECHNIQUE_BENCHMARK_UNAVAILABLE);
    // The dossier forbids these in any user-facing copy, and W01-05 forbids
    // any invented confidence/number on the partial Result.
    expect(copy).not.toMatch(/DUPR|≈/);
    expect(copy).not.toMatch(/\d+\s*%/);
    expect(copy.replace(/confidence capped/gi, '')).not.toMatch(/confidence/i);
    expect(copy).not.toMatch(/rating was counted/i);
  });

  it('A16 a whitespace-only refusal message falls back to the contract statement instead of a blank line', async () => {
    const { req } = prepareRun('attack-copy-blank');
    const server = releaseNotAuthorizedServer(' \n\t \u00a0 ');
    setFetch(server.fetchMock);
    const partial = expectPartialMarker(await runCaptureAnalysis(req));
    expect(partial.record.partialOutcome.message.trim().length).toBeGreaterThan(
      0,
    );
    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    expect(copy).toContain(RESULT_LABEL);
    expect(copy).toContain(SERVER_MESSAGE);
  });
});
