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
 * record-write failure between the settled refusal and the commit, and the
 * non-partial answers (transport, 429, 5xx, paywall, unrelated 409) that must
 * keep their existing meaning.
 *
 * Real pipeline + real migrated SQLite; only the sidecar read, the native
 * byte verification and HTTP are simulated.
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
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import { captureDataOwnerContext } from '../src/data/accountScope';
import { useAccessStore } from '../src/state/accessStore';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
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
    uri: 'file:///captures/w01-partial.mov',
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
      uri: 'file:///captures/w01-partial.pose.json',
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
  expect(copy).not.toMatch(/confidence/i);
  expect(copy).not.toMatch(/DUPR|≈/);
  expect(mockListCatalogDrills).not.toHaveBeenCalled();
  expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
  return copy;
}

async function runPartial(label: string, message: unknown = SERVER_MESSAGE) {
  const { db, calls, failNext } = createCaptureAnalysisDb();
  mockCurrentDb = () => db;
  const { clip, sidecarJson } = swingClipWithSidecar();
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
  message: unknown = SERVER_MESSAGE,
) {
  const { db, calls, failNext } = createCaptureAnalysisDb();
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
      videoFileName: 'w01-partial.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic partial movie bytes'),
    },
  };
  mockReadArtifact = async () => sidecarJson;
  mockVerifyBytes = async () => ({
    status: 'verified-current-bytes',
    comparedExpectation: clip.nativeMediaIdentity!,
  });
  const server = releaseNotAuthorizedServer(message);
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
  return { db, calls, failNext, server, req, execution, operation, run };
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
    const { db, calls } = createCaptureAnalysisDb();
    mockCurrentDb = () => db;
    const { clip, sidecarJson } = swingClipWithSidecar();
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
    ['empty', ''],
    ['513 characters', 'x'.repeat(513)],
    ['2000 characters', 'y'.repeat(2000)],
  ])(
    'a %s refusal message is normalized once and the first run, its replay and Result agree',
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
      expect(copy).not.toContain(message.slice(0, 513));
    },
  );

  it('a failed record write after the settled refusal delivers nothing, keeps the capture unanalyzed, and lets the same operation retry without a second reservation', async () => {
    const { db, calls, failNext } = createCaptureAnalysisDb();
    mockCurrentDb = () => db;
    const { clip, sidecarJson } = swingClipWithSidecar();
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

  it('a failed record write on the original-operation path leaves nothing half-delivered and never charges', async () => {
    const { db, calls, failNext, server, run } = await prepareOriginal(
      'w01-original-write-failure',
    );
    const before = snapshotAccess();
    const seededStatus = captureStatuses(db);
    failNext(
      'INTO local_analysis_record',
      new Error('disk I/O error (simulated process death)'),
    );

    const first = await run();
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

    // Nothing is fabricated afterwards either: no partial, no charge.
    const again = await run();
    expect(again.kind).not.toBe('partial');
    expect(again.kind).not.toBe('scored');
    expect(again.kind).not.toBe('low_confidence');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);
    expect(snapshotAccess()).toEqual(before);
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
      const { db, calls } = createCaptureAnalysisDb();
      mockCurrentDb = () => db;
      const { clip, sidecarJson } = swingClipWithSidecar();
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
