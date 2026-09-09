/**
 * W01-05 — a mechanics-only PARTIAL outcome never spends a free rating and
 * Result shows the honest partial state.
 *
 * The release authority answers the permit reservation with the typed,
 * settled HTTP 409 `access.release_not_authorized` ("no rating was counted").
 * The run must still deliver the mechanics evidence as an explicit
 * non-chargeable partial: no permit, no `local_shot` product row, no outbox
 * sync, no release call, the local free-rating view untouched, and a Result
 * page that states the technique benchmark is unavailable without any
 * invented score, confidence, percentage or benchmark range — and without
 * ever rendering free text the server sent.
 *
 * Covered: the plain `runCaptureAnalysis` run and its replay; the shipping
 * original-operation path (`prepareOriginalCaptureAnalysis` +
 * `runOriginalCaptureAnalysis`) and its replay; the technique-confirmation
 * continuation; the typed refusal arriving THROUGH RECOVERY (a 503 or 429
 * first, then the refusal on the re-reservation — plain sweep and original
 * reconcile); a record-write failure between the settled refusal and the
 * commit (plain and original — the SAME operation delivers later without a
 * second reservation); AUTO DETECT; hostile server messages; the mounted
 * AnalyzeScreen (declared, Auto detect, and "Check saved analysis" after a
 * one-off inference crash) reaching Result; an existing install whose SQLite
 * was created by the BASE_SHA DDL; account-deletion purge on the
 * foreign-key-enforced schema; forged durable rows; and the non-partial
 * answers (transport, 429, 5xx, paywall, unrelated 409, malformed 409) that
 * keep their existing meaning.
 *
 * Real pipeline + real migrated SQLite; only the sidecar read, the native
 * camera seam / byte verification and HTTP are simulated.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import { fail, failure } from '@pickle/shared-types';
import type { CanonicalAccessState } from '../src/billing/types';
import type {
  CameraEvent,
  CameraReadinessState,
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
import {
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';
import { guidedClipFixture as guidedClip } from '../testSupport/guidedClipFixture';

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};
let mockVerifyBytes: (
  clip: CapturedClip,
) => Promise<CurrentClipBytesResult> = async () => ({ status: 'unavailable' });
type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(() => mockCaptureImpl()),
    importStrokeVideo: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
    verifyCapturedClipCurrentBytes: (clip: CapturedClip) =>
      mockVerifyBytes(clip),
  };
});

let mockCurrentDb: () => LocalDb = () => {
  throw new Error('db mock not configured');
};
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
});
jest.mock('../src/analysis/runCaptureAnalysis', () => {
  const actual = jest.requireActual('../src/analysis/runCaptureAnalysis');
  return {
    ...actual,
    runCaptureAnalysis: jest.fn(actual.runCaptureAnalysis),
    runOriginalCaptureAnalysis: jest.fn(actual.runOriginalCaptureAnalysis),
  };
});
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
  useRoute: () => ({ key: 'w01-partial-route', params: mockRouteParams }),
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

import * as captureRunner from '../src/analysis/runCaptureAnalysis';
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
import { purgeOwnerData } from '../src/data/repository';
import { useAccessStore } from '../src/state/accessStore';
import { useAppStore } from '../src/state/appStore';
import { Button } from '../src/design/components';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
const ORIGIN = 'https://api.test';
const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';
/** The contract statement the app owns for this refusal. Server text is
 * never persisted or rendered, whatever it says. */
const APP_OWNED_REFUSAL_STATEMENT =
  'Validated ratings are not available right now. No rating was counted.';
const SERVER_MESSAGE = APP_OWNED_REFUSAL_STATEMENT;
const HOSTILE_MESSAGE =
  'Your DUPR is about 4.5 ≈ 87% confidence; rating was counted. SwingVision beats us 9.9 out of 10.';
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

const originalProfile = {
  skillLevel: 'intermediate',
  handedness: 'right' as const,
  goal: 'drives',
  biggestProblem: 'control',
  focusCheckpoint: 'preparation' as const,
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
    release: { status: 'ineligible', reasonCode: RELEASE_NOT_AUTHORIZED_CODE },
  };
}

/** Release authority refuses admission: a settled verdict, not an outage. */
function releaseNotAuthorizedServer(message: unknown = SERVER_MESSAGE) {
  return scriptedReservationServer(() => jsonResponse(refusalBody(message), 409));
}

/** Any other answer on the reservation: the run keeps its existing meaning.
 * An array scripts the answers reservation by reservation; a single function
 * answers every reservation the same way. */
function scriptedReservationServer(
  answers:
    | Array<() => Response | Promise<Response>>
    | (() => Response | Promise<Response>),
) {
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

/** The exact durable marker every partial must carry: app-owned copy only. */
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
  expect(outcome.partialOutcome).toEqual(outcome.record.partialOutcome);
  expect('freeLimitReached' in outcome).toBe(false);
  return outcome;
}

/** No invented number may appear on a partial Result: no score, no range,
 * no percentage, no confidence (the measured "confidence capped" limiting
 * factor is a recorded mechanics fact, everything else would be invented),
 * no forbidden term, and no contradictory billing statement. */
function expectHonestPartialCopy(copy: string) {
  expect(copy).toContain(RESULT_LABEL);
  expect(copy).not.toContain('RESULT · NOT SCORED');
  expect(copy).toContain('MECHANICS RECORDED');
  expect(copy).toContain('RATING NOT CONSUMED');
  expect(copy).toContain(TECHNIQUE_BENCHMARK_UNAVAILABLE);
  expect(copy).not.toContain('out of 10');
  expect(copy).not.toContain('TECHNIQUE SCORE');
  expect(copy).not.toMatch(/\d(\.\d)?\s*[–-]\s*\d(\.\d)?/);
  expect(copy).not.toMatch(/\d+\s*%/);
  expect(copy.replace(/confidence capped/gi, '')).not.toMatch(/confidence/i);
  expect(copy).not.toMatch(/DUPR|≈|SwingVision|PB Vision|Selkirk|JOOLA/i);
  // The only billing statement is the app-owned one ("No rating was
  // counted."); nothing else may claim a rating was counted.
  expect(copy).toContain(APP_OWNED_REFUSAL_STATEMENT);
  expect(copy.split(APP_OWNED_REFUSAL_STATEMENT).join('')).not.toMatch(
    /rating was counted/i,
  );
  expect(copy).not.toMatch(/Android|Google Play|guest mode|Live Court/i);
}

/** Result for a partial: the honest label and statement, no numbers. */
async function expectPartialResult(analysisId: string) {
  const renderer = await renderResult(analysisId);
  const status = hostByTestId(renderer, 'result-benchmark-status');
  expect(status).toHaveLength(1);
  expect(status[0]!.props.children).toBe(TECHNIQUE_BENCHMARK_UNAVAILABLE);
  expect(hostByTestId(renderer, 'result-guide-step-abstained')).toHaveLength(1);
  expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
  expect(hostByTestId(renderer, 'result-partial-benchmark')).toHaveLength(1);
  const copy = allText(renderer);
  expectHonestPartialCopy(copy);
  expect(mockListCatalogDrills).not.toHaveBeenCalled();
  expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
  return copy;
}

function prepareRun(label: string) {
  const { db, native, calls, failNext } = createCaptureAnalysisDb();
  mockCurrentDb = () => db;
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const req = request(db, clip, label);
  return { db, native, calls, failNext, req };
}

async function runPartial(label: string, message: unknown = SERVER_MESSAGE) {
  const { db, native, calls, failNext, req } = prepareRun(label);
  const server = releaseNotAuthorizedServer(message);
  setFetch(server.fetchMock);
  const before = snapshotAccess();
  const outcome = await runCaptureAnalysis(req);
  return { db, native, calls, failNext, server, outcome, req, before };
}

type NativeTestDb = ReturnType<typeof createCaptureAnalysisDb>['native'];
interface AnalysisStore {
  db: LocalDb;
  native: NativeTestDb;
  calls: RecordedCall[];
  failNext: ReturnType<typeof createSqliteTestDb>['failStatementOnce'];
}

const ownerRowCount = (native: NativeTestDb, table: string) =>
  Number(
    (
      native
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
        .get(owner) as { n: number }
    ).n,
  );

/** What AnalyzeScreen does for a signed-in, pose-backed camera capture. */
async function prepareOriginal(
  label: string,
  server: ReturnType<typeof scriptedReservationServer>,
  declaredStroke: 'forehand_drive' | null = 'forehand_drive',
  store: AnalysisStore = createCaptureAnalysisDb(),
) {
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
  setFetch(server.fetchMock);
  const declared = request(db, clip, label);
  const req: RunCaptureAnalysisRequest =
    declaredStroke === null
      ? { ...declared, declaredStroke: null, declaredCanonical: null }
      : declared;
  await db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE id = ?',
    [declaredStroke, req.captureId],
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
    readAttempt,
  };
}

/** Every attempt row of the owner (original-operation journal). */
function attemptRows(native: NativeTestDb) {
  return native
    .prepare(
      'SELECT state, permit_id, result_id, terminal_reason, last_http_status, technical_failure FROM analysis_execution_attempts WHERE owner_key = ? ORDER BY attempt_ordinal',
    )
    .all(owner) as Array<Record<string, unknown>>;
}

function refusalRows(native: NativeTestDb) {
  return native
    .prepare(
      'SELECT * FROM analysis_reservation_refusal WHERE owner_key = ? ORDER BY created_at_ms',
    )
    .all(owner) as Array<Record<string, unknown>>;
}

function storedRecords(native: NativeTestDb): Array<Record<string, unknown>> {
  return native
    .prepare('SELECT record FROM local_analysis_record WHERE owner_key = ?')
    .all(owner)
    .map(row => JSON.parse(String((row as { record: unknown }).record)));
}

const SETTLED_REFUSAL_ROW = {
  state: 'terminal',
  permit_id: null,
  result_id: null,
  terminal_reason: 'reservation_rejected',
  last_http_status: 409,
};

// --- mounted AnalyzeScreen harness (same seams as analyzeScreenFullFlowE2E) ---

async function renderAnalyze() {
  mockRouteParams = { source: 'camera' };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

function textOf(renderer: ReactTestRenderer): string {
  const text = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number')
      return String(node);
    if (Array.isArray(node)) return node.map(text).join('\n');
    if (node && typeof node === 'object' && 'children' in node)
      return text((node as { children: unknown }).children);
    return '';
  };
  return text(renderer.toJSON());
}

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function buttonLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Button)
    .map(node => String(node.props.label));
}

function action(renderer: ReactTestRenderer, label: string): () => void {
  const button = renderer.root
    .findAllByType(Button)
    .find(node => node.props.label === label);
  if (!button) throw new Error(`Missing action: ${label}`);
  return button.props.onPress;
}

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

const eventBase = () => ({ emittedAtIso: '2026-08-29T18:00:00.000Z' });

function readinessEvent(
  state: CameraReadinessState,
  jointCoverage: number,
): CameraEvent {
  return {
    ...eventBase(),
    type: 'readiness',
    state,
    poseConfidence: 0.9,
    jointCoverage,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
}

function driveNativeCaptureSequence() {
  emit({ ...eventBase(), type: 'permission', state: 'granted' });
  emit({ ...eventBase(), type: 'session', state: 'configured' });
  emit({ ...eventBase(), type: 'session', state: 'observing' });
  emit(readinessEvent('hold_still', 0.88));
  emit({ ...eventBase(), type: 'session', state: 'armed' });
  emit(readinessEvent('ready', 0.93));
  emit({
    ...eventBase(),
    type: 'stroke_detected',
    startTimestampMs: 2000,
    endTimestampMs: 2700,
    peakMotionTimestampMs: 2400,
    confidence: 0.86,
    detectionModelVersion: 'temporal-stroke-heuristic-2',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
  });
  emit({ ...eventBase(), type: 'processing', state: 'preparing_clip' });
}

/** Waits for the most recent shipping runner call to settle. */
async function runnerSettled() {
  await flush();
  const original = jest.mocked(captureRunner.runOriginalCaptureAnalysis).mock;
  const legacy = jest.mocked(captureRunner.runCaptureAnalysis).mock;
  const last =
    (original.invocationCallOrder.at(-1) ?? 0) >
    (legacy.invocationCallOrder.at(-1) ?? 0)
      ? original.results.at(-1)
      : legacy.results.at(-1);
  if (last?.type === 'return')
    await act(async () => {
      await Promise.resolve(last.value).catch(() => {});
    });
  await flush();
}

/** What a signed-in athlete does: declare (or Auto detect), open the camera,
 * swing; the native layer returns the clip and the shipping original
 * operation runs under the refusing authority. */
async function startGuided(id: string, options: { auto?: boolean } = {}) {
  const store = createCaptureAnalysisDb();
  mockCurrentDb = () => store.db;
  useAppStore.setState({ profile: originalProfile });
  const data = guidedClip(id);
  mockReadArtifact = async () => data.sidecarJson;
  mockCaptureImpl = async () => data.clip;
  mockVerifyBytes = async clip => ({
    status: 'verified-current-bytes',
    comparedExpectation: clip.nativeMediaIdentity!,
  });
  const server = releaseNotAuthorizedServer();
  setFetch(server.fetchMock);
  const renderer = await renderAnalyze();
  pressByLabel(renderer, options.auto ? 'Auto detect' : 'Forehand Drive');
  pressByLabel(renderer, 'Open automatic camera');
  await flush();
  driveNativeCaptureSequence();
  await runnerSettled();
  return { renderer, server, store, ...data };
}

function navigatedToResult(analysisId: unknown) {
  return mockNavigation.replace.mock.calls.some(
    ([route, params]) =>
      route === 'Result' &&
      (params as { analysisId?: unknown }).analysisId === analysisId,
  );
}

/** The `analysis_logical_operations` DDL exactly as BASE_SHA
 * 6a6e92a9f2b743f7ff3641930f0c3f3753351339 shipped it (fixture for an
 * install created before this change; `IF NOT EXISTS` never rewrites it). */
const BASE_SHA_LOGICAL_OPERATIONS_DDL = [
  `CREATE TABLE IF NOT EXISTS analysis_logical_operations (
    owner_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    api_origin TEXT NOT NULL CHECK (length(api_origin) BETWEEN 1 AND 2048),
    original_settings TEXT NOT NULL CHECK (length(CAST(original_settings AS BLOB)) BETWEEN 1 AND 65536),
    settings_hash TEXT NOT NULL CHECK (length(settings_hash) = 64),
    model_policy_hash TEXT CHECK (length(model_policy_hash) = 64),
    observation_seal TEXT CHECK (length(CAST(observation_seal AS BLOB)) BETWEEN 1 AND 131072),
    execution_hash TEXT CHECK (length(execution_hash) = 64),
    current_attempt_id TEXT,
    final_record_id TEXT,
    winning_attempt_id TEXT,
    completion_kind TEXT CHECK (completion_kind IN ('scored','low_confidence','needs_technique_confirmation')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (owner_key, operation_id),
    UNIQUE (owner_key, capture_id),
    UNIQUE (owner_key, analysis_id),
    UNIQUE (owner_key, analysis_id, capture_id, api_origin, execution_hash),
    FOREIGN KEY (owner_key, capture_id) REFERENCES local_capture(owner_key, id),
    FOREIGN KEY (owner_key, current_attempt_id) REFERENCES analysis_execution_attempts(owner_key, operation_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_key, winning_attempt_id) REFERENCES analysis_execution_attempts(owner_key, operation_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_key, final_record_id) REFERENCES local_analysis_record(owner_key, id) DEFERRABLE INITIALLY DEFERRED,
    CHECK ((observation_seal IS NULL AND execution_hash IS NULL AND current_attempt_id IS NULL) OR
      (observation_seal IS NOT NULL AND execution_hash IS NOT NULL AND model_policy_hash IS NOT NULL)),
    CHECK ((final_record_id IS NULL AND winning_attempt_id IS NULL AND completion_kind IS NULL) OR
      (final_record_id IS NOT NULL AND final_record_id = analysis_id AND winning_attempt_id IS NOT NULL AND
       current_attempt_id IS NOT NULL AND winning_attempt_id = current_attempt_id AND completion_kind IS NOT NULL))
  )`,
  `CREATE TRIGGER IF NOT EXISTS analysis_logical_operations_immutable
    BEFORE UPDATE ON analysis_logical_operations
    WHEN NEW.owner_key IS NOT OLD.owner_key OR NEW.operation_id IS NOT OLD.operation_id
      OR NEW.capture_id IS NOT OLD.capture_id OR NEW.analysis_id IS NOT OLD.analysis_id OR NEW.api_origin IS NOT OLD.api_origin
      OR NEW.original_settings IS NOT OLD.original_settings OR NEW.settings_hash IS NOT OLD.settings_hash
      OR NEW.model_policy_hash IS NOT OLD.model_policy_hash OR NEW.created_at_ms IS NOT OLD.created_at_ms
      OR (OLD.observation_seal IS NOT NULL AND NEW.observation_seal IS NOT OLD.observation_seal)
      OR (OLD.execution_hash IS NOT NULL AND NEW.execution_hash IS NOT OLD.execution_hash)
      OR (OLD.final_record_id IS NOT NULL AND (NEW.final_record_id IS NOT OLD.final_record_id OR
        NEW.winning_attempt_id IS NOT OLD.winning_attempt_id OR NEW.completion_kind IS NOT OLD.completion_kind))
      OR (NEW.current_attempt_id IS NOT OLD.current_attempt_id AND NOT EXISTS (
        SELECT 1 FROM analysis_execution_attempts a WHERE a.owner_key = NEW.owner_key AND a.analysis_id = NEW.analysis_id
          AND a.operation_id = NEW.current_attempt_id AND a.predecessor_operation_id IS OLD.current_attempt_id AND a.state = 'reserve_pending'))
      OR (NEW.final_record_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM analysis_execution_attempts a JOIN local_analysis_record r ON r.owner_key = a.owner_key AND r.id = a.analysis_id
        WHERE a.owner_key = NEW.owner_key AND a.operation_id = NEW.winning_attempt_id AND a.analysis_id = NEW.final_record_id
          AND ((NEW.completion_kind = 'scored' AND a.state = 'committed' AND a.result_id = NEW.analysis_id) OR
            (NEW.completion_kind <> 'scored' AND a.state = 'release_pending' AND a.release_outcome = 'low_confidence'))))
    BEGIN SELECT RAISE(ABORT, 'Original analysis is immutable'); END`,
];

const LEGACY_OPERATION = {
  operationId: fixtureUuid('legacy-operation'),
  captureId: fixtureUuid('legacy-capture'),
  analysisId: fixtureUuid('legacy-analysis'),
};

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
  useAppStore.setState({ profile: null });
  mockVerifyBytes = async () => ({ status: 'unavailable' });
  mockRouteParams = {};
  mockCameraListeners.clear();
  jest
    .mocked(pipeline.analyzeCapture)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
        .analyzeCapture,
    );
  jest
    .mocked(captureRunner.runOriginalCaptureAnalysis)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof captureRunner>(
        '../src/analysis/runCaptureAnalysis',
      ).runOriginalCaptureAnalysis,
    );
  jest
    .mocked(captureRunner.runCaptureAnalysis)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof captureRunner>(
        '../src/analysis/runCaptureAnalysis',
      ).runCaptureAnalysis,
    );
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
  mockNavigation.replace.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
});

describe('W01-05 — mechanics-only partial outcome (plain path)', () => {
  it('settles as an explicit non-chargeable partial: no permit, no product row, no outbox, no release call', async () => {
    const { db, native, calls, server, outcome, before } =
      await runPartial('w01-settle');
    const partial = expectPartialMarker(outcome);

    expectNoChargeableWrites(calls, server.urls, db);
    expect(reserveCalls(server.urls)).toHaveLength(1);

    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    expect(state.journal[0]).toMatchObject({
      ...SETTLED_REFUSAL_ROW,
      analysis_id: partial.analysisId,
    });
    expect(refusalRows(native)).toEqual([
      expect.objectContaining({
        analysis_id: partial.analysisId,
        reason_code: RELEASE_NOT_AUTHORIZED_CODE,
        message: APP_OWNED_REFUSAL_STATEMENT,
      }),
    ]);
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
    expect(useAccessStore.getState().status).toBe('ready');
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

  it('once settled, a replay against an authority that would now grant a permit still returns the partial with zero new reservations', async () => {
    const { outcome, req, before } = await runPartial('w01-later-grant');
    const partial = expectPartialMarker(outcome);
    const granting = permitServer();
    setFetch(granting.fetchMock);
    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(partial.analysisId);
    expect(granting.urls).toHaveLength(0);
    expect(snapshotAccess()).toEqual(before);
  });

  it('Result renders the explicit benchmark-unavailable state with no score, confidence or range', async () => {
    const { outcome } = await runPartial('w01-result');
    const partial = expectPartialMarker(outcome);
    await expectPartialResult(partial.analysisId);
  });

  it.each([
    ['a hostile free-text', HOSTILE_MESSAGE],
    ['an empty', ''],
    ['a whitespace-only', '   \n\t '],
    ['a 2000-character', 'y'.repeat(2000)],
    ['a non-string', { nested: 'object' }],
    ['a missing', undefined],
  ])(
    '%s server refusal message is never persisted or rendered: the marker carries the app-owned statement and Result stays honest',
    async (_label, message) => {
      const { native, calls, server, outcome, req, before } = await runPartial(
        `w01-message-${_label}`,
        message,
      );
      const partial = expectPartialMarker(outcome);
      expectNoChargeableWrites(calls, server.urls, req.db);
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(refusalRows(native)).toEqual([
        expect.objectContaining({
          reason_code: RELEASE_NOT_AUTHORIZED_CODE,
          message: APP_OWNED_REFUSAL_STATEMENT,
        }),
      ]);
      expect(JSON.stringify(storedRecords(native))).not.toContain('DUPR');
      expect(JSON.stringify(storedRecords(native))).not.toContain('yyyy');

      const replay = expectPartialMarker(await runCaptureAnalysis(req));
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(replay.replayed).toBe(true);
      expect(snapshotAccess()).toEqual(before);

      const copy = await expectPartialResult(partial.analysisId);
      expect(copy).toContain(APP_OWNED_REFUSAL_STATEMENT);
      if (typeof message === 'string' && message.trim().length > 0)
        expect(copy).not.toContain(message.slice(0, 32));
    },
  );

  it('a failed record write after the settled refusal delivers nothing, keeps the capture unanalyzed, and lets the same operation retry without a second reservation', async () => {
    const { db, native, calls, failNext, req } = prepareRun('w01-write-failure');
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
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
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(0);
    expect(captureStatuses(db)).toEqual(seededStatus);
    expect(snapshotAccess()).toEqual(before);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    // The refusal itself is durable: the resume needs no second answer.
    expect(refusalRows(native)).toHaveLength(1);

    const retry = expectPartialMarker(await runCaptureAnalysis(req));
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
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

  it('a 429 with Retry-After, then the typed refusal on the sync-runtime recovery sweep: the same operation settles the partial (no recovery_pending dead end, no charge)', async () => {
    const { db, native, calls, req } = prepareRun('w01-429-then-409');
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
    expect(refusalRows(native)).toHaveLength(0);

    // The sync runtime's recovery sweep re-reserves the permit-less pending
    // run and this time receives the typed refusal.
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
    expect(captureDbState(db).journal[0]).toMatchObject(SETTLED_REFUSAL_ROW);
    expect(refusalRows(native)).toEqual([
      expect.objectContaining({
        reason_code: RELEASE_NOT_AUTHORIZED_CODE,
        message: APP_OWNED_REFUSAL_STATEMENT,
      }),
    ]);

    const second = await runCaptureAnalysis(req);
    expect({ second, captures: captureStatuses(db) }).not.toMatchObject({
      second: { kind: 'unavailable', cause: 'recovery_pending' },
    });
    const partial = expectPartialMarker(second);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);

    const replay = expectPartialMarker(await runCaptureAnalysis(req));
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(partial.analysisId);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    await expectPartialResult(partial.analysisId);
  });

  it('a technique-confirmation continuation settles as partial and its replay returns the durable partial', async () => {
    const { db, calls, req: base } = prepareRun('w01-continuation');
    const permits = permitServer();
    setFetch(permits.fetchMock);
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
    expectNoChargeableWrites(calls, refusal.urls, db);
    expect(reserveCalls(refusal.urls)).toHaveLength(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);

    const replay = expectPartialMarker(await runCaptureAnalysis(confirmed));
    expect(reserveCalls(refusal.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(continuation.analysisId);
    expect(replay.record).toEqual(continuation.record);
    // The AUTO DETECT record and the continuation partial: nothing else.
    expect(captureDbState(db).records).toBe(2);

    await expectPartialResult(continuation.analysisId);
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
    [
      'the typed refusal code on a non-409 status',
      () => jsonResponse(refusalBody(), 403),
      undefined,
    ],
  ])(
    '%s on the reservation is not a partial: no record, no refusal row, capture unanalyzed, nothing charged',
    async (_label, answer, cause) => {
      const { db, native, calls, req } = prepareRun(
        `w01-non-partial-${_label}`,
      );
      const server = scriptedReservationServer(answer);
      setFetch(server.fetchMock);
      const before = snapshotAccess();
      const seededStatus = captureStatuses(db);

      const outcome = await runCaptureAnalysis(req);
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(outcome.cause).toBe(cause);
      expectNoChargeableWrites(calls, server.urls, db);
      expect(captureDbState(db).records).toBe(0);
      expect(refusalRows(native)).toHaveLength(0);
      expect(captureStatuses(db)).toEqual(seededStatus);
      expect(snapshotAccess()).toEqual(before);
    },
  );
});

describe('W01-05 — original-operation (shipping) path', () => {
  it('settles the typed refusal as the durable partial, completes the SAME operation and replays it', async () => {
    const { db, native, calls, server, run, readAttempt } =
      await prepareOriginal('w01-original', releaseNotAuthorizedServer());
    const before = snapshotAccess();

    const outcome = await run();
    expectNoChargeableWrites(calls, server.urls, db);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);

    const partial = expectPartialMarker(outcome);
    expect(captureDbState(db).records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(attemptRows(native)).toEqual([
      { ...SETTLED_REFUSAL_ROW, technical_failure: null },
    ]);
    const settled = await readAttempt();
    expect(settled.operation.analysisId).toBe(partial.analysisId);
    expect(settled.operation.finalRecordId).toBe(partial.analysisId);
    expect(settled.operation.completionKind).toBe('partial');
    expect(settled.operation.winningAttemptId).toBe(
      settled.operation.currentAttemptId,
    );
    expect(settled.attempt.run.permitId).toBeNull();

    const replay = expectPartialMarker(await run());
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(partial.analysisId);
    expect(replay.record).toEqual(partial.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(attemptRows(native)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(partial.analysisId);
  });

  it('a transient 503, then the typed refusal on the recovery re-reservation: the same operation and attempt settle the partial (never recovery_pending forever)', async () => {
    const server = scriptedReservationServer([
      () =>
        jsonResponse(
          { error: { code: 'unavailable', message: 'Try again later.' } },
          503,
        ),
      () => jsonResponse(refusalBody(HOSTILE_MESSAGE), 409),
    ]);
    const { db, native, calls, run, reconcile, readAttempt } =
      await prepareOriginal('w01-503-then-409', server);
    const before = snapshotAccess();

    const first = await run();
    expect(first.kind).toBe('unavailable');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);
    expect(refusalRows(native)).toHaveLength(0);

    // What the screen does next: reconcile the saved analysis. Recovery
    // re-reserves and receives the typed refusal this time.
    await reconcile();
    expect(reserveCalls(server.urls)).toHaveLength(2);
    const refused = await readAttempt();
    expect(refused.attempt.run.state).toBe('terminal');
    expect(refused.attempt.run.permitId).toBeNull();
    expect(refused.attempt.run.terminalReason).toBe('reservation_rejected');
    expect(refused.attempt.run.lastHttpStatus).toBe(409);
    expect(refusalRows(native)).toEqual([
      expect.objectContaining({
        operation_id: refused.attempt.run.operationId,
        reason_code: RELEASE_NOT_AUTHORIZED_CODE,
        message: APP_OWNED_REFUSAL_STATEMENT,
      }),
    ]);

    const delivered = await run();
    expect({ delivered, captures: captureStatuses(db) }).not.toMatchObject({
      delivered: { kind: 'unavailable', cause: 'recovery_pending' },
    });
    const partial = expectPartialMarker(delivered);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
    // Same logical operation, same (only) attempt: no successor was admitted.
    expect(attemptRows(native)).toHaveLength(1);
    const done = await readAttempt();
    expect(done.operation.currentAttemptId).toBe(
      refused.operation.currentAttemptId,
    );
    expect(done.operation.finalRecordId).toBe(partial.analysisId);
    expect(done.operation.completionKind).toBe('partial');

    const replay = expectPartialMarker(await run());
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(server.urls)).toHaveLength(2);
    await expectPartialResult(partial.analysisId);
  });

  it('a failed record write on the original-operation path leaves nothing half-delivered, never charges, and the SAME operation later delivers its partial without a second reservation', async () => {
    const { db, native, calls, failNext, server, run, reconcile, readAttempt } =
      await prepareOriginal(
        'w01-original-write-failure',
        releaseNotAuthorizedServer(),
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
    expectNoChargeableWrites(calls, server.urls, db);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);
    expect(captureStatuses(db)).toEqual(seededStatus);
    expect(snapshotAccess()).toEqual(before);
    const settled = await readAttempt();
    expect(settled.operation.finalRecordId).toBeNull();
    expect(settled.attempt.run.state).toBe('terminal');
    expect(settled.attempt.run.permitId).toBeNull();
    expect(settled.attempt.run.terminalReason).toBe('reservation_rejected');
    expect(settled.attempt.technicalFailure).toBeNull();
    expect(refusalRows(native)).toHaveLength(1);

    // What the screen does on the next visit: reconcile, then run again.
    await reconcile();
    const retry = expectPartialMarker(await run());
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureDbState(db).records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
    const delivered = await readAttempt();
    expect(delivered.operation.finalRecordId).toBe(retry.analysisId);
    expect(delivered.operation.completionKind).toBe('partial');
    expect(delivered.operation.currentAttemptId).toBe(
      settled.operation.currentAttemptId,
    );
    expect(attemptRows(native)).toHaveLength(1);

    const replay = expectPartialMarker(await run());
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(retry.analysisId);
    expect(replay.record).toEqual(retry.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(retry.analysisId);
  });

  it('refusal settled, then the inference itself fails once: the SAME operation resumes into the partial with zero new reservations', async () => {
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
    const { db, native, calls, server, run, reconcile, readAttempt } =
      await prepareOriginal(
        'w01-original-inference-crash',
        releaseNotAuthorizedServer(),
      );
    const before = snapshotAccess();
    const first = await run();
    expect(first.kind).not.toBe('partial');
    expect(first.kind).not.toBe('scored');
    expect(first.kind).not.toBe('low_confidence');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(native)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(0);

    await reconcile();
    const partial = expectPartialMarker(await run());
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expectNoChargeableWrites(calls, server.urls, db);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(attemptRows(native)).toHaveLength(1);
    expect((await readAttempt()).operation.completionKind).toBe('partial');
    expect(snapshotAccess()).toEqual(before);
    await expectPartialResult(partial.analysisId);
  });

  it('AUTO DETECT: a typed refusal keeps the measured mechanics as a durable partial that replays, never a dead end', async () => {
    const { db, native, calls, server, run, readAttempt } =
      await prepareOriginal(
        'w01-original-auto-detect',
        releaseNotAuthorizedServer(),
        null,
      );
    const before = snapshotAccess();

    const first = expectPartialMarker(await run());
    expectNoChargeableWrites(calls, server.urls, db);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
    const settled = await readAttempt();
    expect(settled.operation.finalRecordId).toBe(first.analysisId);
    expect(settled.operation.completionKind).toBe('partial');
    expect(attemptRows(native)).toEqual([
      { ...SETTLED_REFUSAL_ROW, technical_failure: null },
    ]);

    const again = expectPartialMarker(await run());
    expect(again.replayed).toBe(true);
    expect(again.analysisId).toBe(first.analysisId);
    expect(again.record).toEqual(first.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(first.analysisId);
  });

  it('an install created by the BASE_SHA DDL upgrades in place: the old logical-operations table is kept (rows included) and still completes a partial', async () => {
    const path = `${tmpdir()}/w01-partial-${process.pid}-${Date.now()}.sqlite`;
    // 1. The device's SQLite as the previous build left it.
    const legacy = new DatabaseSync(path, {
      enableForeignKeyConstraints: false,
    });
    for (const sql of BASE_SHA_LOGICAL_OPERATIONS_DDL) legacy.exec(sql);
    legacy
      .prepare(
        `INSERT INTO analysis_logical_operations
          (owner_key, operation_id, capture_id, analysis_id, api_origin, original_settings, settings_hash, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      )
      .run(
        owner,
        LEGACY_OPERATION.operationId,
        LEGACY_OPERATION.captureId,
        LEGACY_OPERATION.analysisId,
        ORIGIN,
        '{"legacy":true}',
        sha256Hex('legacy-settings'),
      );
    legacy.close();

    // 2. This build opens it (every migration re-runs exactly as db.ts does).
    const store = createSqliteTestDb(path);
    const upgraded: AnalysisStore = {
      ...store,
      failNext: store.failStatementOnce,
    };
    const { clip } = swingClipWithSidecar();
    seedSqliteCapture(store.db, owner, LEGACY_OPERATION.captureId, clip);
    const tableSql = String(
      (
        store.native
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analysis_logical_operations'",
          )
          .get() as { sql: string }
      ).sql,
    );
    // The stale CHECK is still the one BASE_SHA created: IF NOT EXISTS did
    // not (and must not need to) rewrite the table.
    expect(tableSql).toContain(
      "completion_kind IN ('scored','low_confidence','needs_technique_confirmation')",
    );
    expect(tableSql).not.toContain("'partial'");

    const { db, calls, server, run, readAttempt } = await prepareOriginal(
      'w01-upgraded-install',
      releaseNotAuthorizedServer(),
      'forehand_drive',
      upgraded,
    );
    const before = snapshotAccess();
    const partial = expectPartialMarker(await run());
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(store.count('local_analysis_record', owner)).toBe(1);
    expect(
      (
        store.native
          .prepare('SELECT status FROM local_capture WHERE id = ?')
          .get(partial.record.captureId) as { status: string }
      ).status,
    ).toBe('analyzed');
    const done = await readAttempt();
    expect(done.operation.finalRecordId).toBe(partial.analysisId);
    expect(done.operation.completionKind).toBe('partial');
    expect(snapshotAccess()).toEqual(before);

    const replay = expectPartialMarker(await run());
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(server.urls)).toHaveLength(1);

    // The pre-existing row survived the upgrade untouched.
    expect(
      store.native
        .prepare(
          'SELECT operation_id, capture_id, analysis_id, original_settings, final_record_id, completion_kind FROM analysis_logical_operations WHERE owner_key = ? AND operation_id = ?',
        )
        .get(owner, LEGACY_OPERATION.operationId),
    ).toEqual({
      operation_id: LEGACY_OPERATION.operationId,
      capture_id: LEGACY_OPERATION.captureId,
      analysis_id: LEGACY_OPERATION.analysisId,
      original_settings: '{"legacy":true}',
      final_record_id: null,
      completion_kind: null,
    });
    expect(store.native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.native.prepare('PRAGMA integrity_check').all()).toEqual([
      { integrity_check: 'ok' },
    ]);
    void db;
    store.close();
    rmSync(path, { force: true });
  });
});

describe('W01-05 — the mounted AnalyzeScreen reaches the honest Result', () => {
  it('declared stroke under the typed refusal: the shipping flow lands on Result with the durable partial, one reservation, no shot', async () => {
    const before = snapshotAccess();
    const { renderer, server, store } = await startGuided('w01-flow-declared');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    const records = storedRecords(store.native);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: null,
      partialOutcome: {
        status: 'partial',
        billingDisposition: 'not_chargeable',
        reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
        message: APP_OWNED_REFUSAL_STATEMENT,
      },
    });
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(navigatedToResult(records[0]!['id'])).toBe(true);
    expect(textOf(renderer)).not.toContain('Retry saved analysis');
    expect(snapshotAccess()).toEqual(before);
  });

  it('Auto detect under the typed refusal: the athlete reaches the benchmark-unavailable Result, never a classifier dead end that invents a measurement cause', async () => {
    const { renderer, server, store } = await startGuided('w01-flow-auto', {
      auto: true,
    });
    expect(reserveCalls(server.urls)).toHaveLength(1);
    const records = storedRecords(store.native);
    expect(records).toHaveLength(1);
    const partial = records[0]!;
    expect(partial).toMatchObject({
      result: null,
      partialOutcome: {
        status: 'partial',
        billingDisposition: 'not_chargeable',
        reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
      },
    });
    expect(store.count('local_shot', owner)).toBe(0);
    expect(attemptRows(store.native)[0]).toMatchObject(SETTLED_REFUSAL_ROW);
    expect(
      (
        store.native
          .prepare('SELECT status FROM local_capture WHERE owner_key = ?')
          .get(owner) as { status: string }
      ).status,
    ).toBe('analyzed');
    const visible = textOf(renderer);
    expect({
      navigated: navigatedToResult(partial['id']),
      inventsCause:
        visible.includes('couldn’t be measured cleanly enough') ||
        visible.includes('would not commit to a stroke'),
    }).toEqual({ navigated: true, inventsCause: false });
    await expectPartialResult(String(partial['id']));
  });

  it('refusal settled, then the inference crashes once: "Check saved analysis" delivers the partial with ZERO new reservations and opens Result', async () => {
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
    const before = snapshotAccess();
    const { renderer, server, store } = await startGuided(
      'w01-flow-crash-after-refusal',
    );
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(store.native)).toHaveLength(1);
    expect(storedRecords(store.native)).toHaveLength(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    const visible = textOf(renderer);
    expect(visible).not.toMatch(/\d+\s*%|out of 10|TECHNIQUE SCORE/);
    // The athlete's only way forward on the SAME saved capture.
    const forward = ['Check saved analysis', 'Retry saved analysis'];
    const offered = buttonLabels(renderer).find(label =>
      forward.includes(label),
    );
    expect(offered).toBeDefined();
    act(() => action(renderer, offered!)());
    await runnerSettled();

    expect(reserveCalls(server.urls)).toHaveLength(1);
    const records = storedRecords(store.native);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: null,
      partialOutcome: {
        reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
        message: APP_OWNED_REFUSAL_STATEMENT,
      },
    });
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(attemptRows(store.native)).toHaveLength(1);
    expect(navigatedToResult(records[0]!['id'])).toBe(true);
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 — durable rows: purge and forgery', () => {
  it('account deletion: purgeOwnerData removes every row of an owner with a settled refusal (plain path), including the refusal metadata, on the foreign-key-enforced schema', async () => {
    const { db, native, outcome } = await runPartial('w01-purge');
    expectPartialMarker(outcome);
    expect(ownerRowCount(native, 'analysis_reservation_refusal')).toBe(1);
    expect(ownerRowCount(native, 'analysis_run_journal')).toBe(1);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    expect(ownerRowCount(native, 'local_capture')).toBe(1);

    await expect(purgeOwnerData(db, owner)).resolves.toBeUndefined();

    expect({
      local_capture: ownerRowCount(native, 'local_capture'),
      local_analysis_record: ownerRowCount(native, 'local_analysis_record'),
      analysis_run_journal: ownerRowCount(native, 'analysis_run_journal'),
      analysis_reservation_refusal: ownerRowCount(
        native,
        'analysis_reservation_refusal',
      ),
    }).toEqual({
      local_capture: 0,
      local_analysis_record: 0,
      analysis_run_journal: 0,
      analysis_reservation_refusal: 0,
    });
    expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('account deletion: purgeOwnerData also removes the refusal and the partial completion bound to an original-operation attempt', async () => {
    const { db, native, run } = await prepareOriginal(
      'w01-purge-original',
      releaseNotAuthorizedServer(),
    );
    expectPartialMarker(await run());
    expect(ownerRowCount(native, 'analysis_reservation_refusal')).toBe(1);
    expect(ownerRowCount(native, 'analysis_execution_attempts')).toBe(1);
    expect(ownerRowCount(native, 'analysis_logical_operations')).toBe(1);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    const sidecars = (
      native
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'analysis_%' AND name NOT IN ('analysis_run_journal','analysis_execution_attempts','analysis_logical_operations','analysis_reservation_refusal')",
        )
        .all() as Array<{ name: string }>
    ).map(row => row.name);
    for (const table of sidecars)
      expect(ownerRowCount(native, table)).toBeGreaterThanOrEqual(0);

    await expect(purgeOwnerData(db, owner)).resolves.toBeUndefined();

    const remaining = Object.fromEntries(
      [
        'local_capture',
        'local_analysis_record',
        'analysis_execution_attempts',
        'analysis_logical_operations',
        'analysis_reservation_refusal',
        ...sidecars,
      ].map(table => [table, ownerRowCount(native, table)]),
    );
    expect(Object.values(remaining).every(count => count === 0)).toBe(true);
    expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the refusal table refuses forged rows: no settled run, a reserved run, an update and a duplicate are all rejected', async () => {
    const { db, native, outcome } = await runPartial('w01-forgery');
    const partial = expectPartialMarker(outcome);
    const insert = (operationId: string, analysisId: string) =>
      db.execute(
        `INSERT INTO analysis_reservation_refusal
          (owner_key, operation_id, analysis_id, capture_id, reason_code, message, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [
          owner,
          operationId,
          analysisId,
          partial.record.captureId,
          RELEASE_NOT_AUTHORIZED_CODE,
          APP_OWNED_REFUSAL_STATEMENT,
        ],
      );
    // No run at all.
    await expect(
      insert(fixtureUuid('forged-op'), fixtureUuid('forged-analysis')),
    ).rejects.toThrow();
    // Duplicate of the genuine row.
    const journal = captureDbState(db).journal[0] as {
      operation_id: string;
    };
    await expect(insert(journal.operation_id, partial.analysisId)).rejects.toThrow();
    // Tampering with the durable statement.
    await expect(
      db.execute(
        'UPDATE analysis_reservation_refusal SET message = ? WHERE owner_key = ?',
        [HOSTILE_MESSAGE, owner],
      ),
    ).rejects.toThrow();
    expect(refusalRows(native)).toEqual([
      expect.objectContaining({ message: APP_OWNED_REFUSAL_STATEMENT }),
    ]);
  });

  it('a tampered stored partial that smuggles a fabricated result is never replayed as a score and never reserves again', async () => {
    const { db, native, server, outcome, req, before } = await runPartial(
      'w01-tampered-record',
    );
    const partial = expectPartialMarker(outcome);
    const forged = {
      ...partial.record,
      result: { overallScore: 9.9, confidence: 0.99 },
    };
    native
      .prepare(
        'UPDATE local_analysis_record SET record = ? WHERE owner_key = ? AND id = ?',
      )
      .run(JSON.stringify(forged), owner, partial.analysisId);
    const replay = await runCaptureAnalysis(req).catch((error: unknown) => ({
      kind: 'threw' as const,
      error,
    }));
    expect(replay.kind).not.toBe('scored');
    expect(replay.kind).not.toBe('low_confidence');
    expect(replay.kind).not.toBe('partial');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).shots).toBe(0);
    expect(snapshotAccess()).toEqual(before);
  });
});
