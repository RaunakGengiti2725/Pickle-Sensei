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
 * original-operation paths — the same operation must still deliver its
 * partial without a second reservation), an AUTO DETECT capture whose
 * reservation is refused on the original-operation path (mechanics stay
 * durable and replayable), account-deletion purge with a settled refusal on
 * the real foreign-key-enforced schema, and the non-partial answers
 * (transport, 429, 5xx, paywall, unrelated 409) that must keep their existing
 * meaning.
 *
 * Round 4 adds: the typed refusal arriving through a RECOVERY re-reserve
 * (transient 503/429 first, then the settled 409 on the sync-runtime sweep or
 * the original-operation reconcile) must settle exactly like a direct
 * refusal; the partial Result must render only bounded app-owned copy (an
 * untrusted server message never reaches the screen); the MOUNTED
 * AnalyzeScreen must deliver the partial for AUTO DETECT and after a
 * post-refusal inference failure while an unresolved hold stays in recovery;
 * and an EXISTING install created by the previous schema must be upgraded in
 * place so the partial completion is accepted there too.
 *
 * Real pipeline + real migrated SQLite; only the sidecar read, the native
 * byte verification, the native camera seam and HTTP are simulated.
 */
import React from 'react';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
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
import { createSqliteTestDb } from '../testSupport/sqlite';
import { guidedClipFixture } from '../testSupport/guidedClipFixture';

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
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
    verifyCapturedClipCurrentBytes: (clip: CapturedClip) =>
      mockVerifyBytes(clip),
    captureStrokeVideo: jest.fn(() => mockCaptureImpl()),
    importStrokeVideo: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
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
import { finalizeAcknowledgement } from '../__harness__/analysisPermitRoute';
import {
  recoverAnalysisJournals,
  runJournal,
} from '../src/analysis/runJournal';
import { createAnalysisPermitClient } from '../src/data/api';
import { captureDataOwnerContext } from '../src/data/accountScope';
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

/** One scripted answer per reservation, in order; a further reservation is a
 * test failure (the settled refusal must never be re-asked). */
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

const transient503 = () =>
  jsonResponse(
    { error: { code: 'unavailable', message: 'Try again later.' } },
    503,
  );
const transient429 = () =>
  jsonResponse(
    { error: { code: 'rate_limited', message: 'Slow down.' } },
    429,
    { 'retry-after': '1' },
  );

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
  // The measured limiting factor "… confidence capped" is a mechanics fact
  // the classifier recorded; every other mention would be an invented number.
  expect(copy.replace(/confidence capped/gi, '')).not.toMatch(/confidence/i);
  expect(copy).not.toMatch(/DUPR|≈/);
  expect(mockListCatalogDrills).not.toHaveBeenCalled();
  expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
  return copy;
}

async function runPartial(label: string, message: unknown = SERVER_MESSAGE) {
  const { db, native, calls, failNext } = createCaptureAnalysisDb();
  mockCurrentDb = () => db;
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const server = releaseNotAuthorizedServer(message);
  setFetch(server.fetchMock);
  const req = request(db, clip, label);
  const before = snapshotAccess();
  const outcome = await runCaptureAnalysis(req);
  return { db, native, calls, failNext, server, outcome, req, before };
}

type NativeTestDb = ReturnType<typeof createCaptureAnalysisDb>['native'];

const ownerRowCount = (native: NativeTestDb, table: string) =>
  Number(
    (
      native
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
        .get(owner) as { n: number }
    ).n,
  );

type CaptureStore = Pick<
  ReturnType<typeof createCaptureAnalysisDb>,
  'db' | 'native' | 'calls' | 'failNext'
>;

/** What AnalyzeScreen does for a signed-in, pose-backed camera capture. */
async function prepareOriginal(
  label: string,
  message: unknown = SERVER_MESSAGE,
  declaredStroke: 'forehand_drive' | null = 'forehand_drive',
  options: {
    store?: CaptureStore;
    server?: { fetchMock: unknown; urls: string[] };
  } = {},
) {
  const { db, native, calls, failNext } =
    options.store ?? createCaptureAnalysisDb();
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
  const server = options.server ?? releaseNotAuthorizedServer(message);
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

/** C0/C1 controls (except the whitespace the layout collapses) and the
 * Unicode bidi/format controls that can re-order or hide rendered text. */
function controlOrBidiCodePoints(text: string): number[] {
  const found: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      found.push(code);
  }
  return found;
}

const refusalRows = (native: NativeTestDb) =>
  native
    .prepare('SELECT * FROM analysis_reservation_refusal WHERE owner_key = ?')
    .all(owner) as Array<Record<string, unknown>>;

/** Every chargeable route stayed closed: no product row, no outbox, no
 * release call, nothing synced. */
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

/* ---- the mounted shipping flow (real AnalyzeScreen) ---- */

const originalProfile = {
  skillLevel: 'intermediate',
  handedness: 'right' as const,
  goal: 'drives',
  biggestProblem: 'control',
  focusCheckpoint: 'preparation' as const,
};

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

/** Flushes until the screen reaches the awaited state; a flow that never
 * gets there fails here instead of hanging. */
async function flushUntil(done: () => boolean, rounds = 400) {
  for (let round = 0; round < rounds; round += 1) {
    if (done()) return;
    await flush();
  }
  expect(done()).toBe(true);
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

function pressButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType(Button)
    .find(node => node.props.label === label);
  if (!button) throw new Error(`Missing action: ${label}`);
  act(() => button.props.onPress());
}

function emitCamera(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

const eventBase = () => ({ emittedAtIso: '2026-09-08T12:00:00.000Z' });

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
  emitCamera({ ...eventBase(), type: 'permission', state: 'granted' });
  emitCamera({ ...eventBase(), type: 'session', state: 'configured' });
  emitCamera({ ...eventBase(), type: 'session', state: 'observing' });
  emitCamera(readinessEvent('hold_still', 0.88));
  emitCamera({ ...eventBase(), type: 'session', state: 'armed' });
  emitCamera(readinessEvent('ready', 0.93));
  emitCamera({
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
  emitCamera({ ...eventBase(), type: 'processing', state: 'preparing_clip' });
}

const navigatedToResult = () =>
  mockNavigation.replace.mock.calls.some(([route]) => route === 'Result');
const offersRecovery = (renderer: ReactTestRenderer) =>
  buttonLabels(renderer).some(label =>
    ['Retry saved analysis', 'Check saved analysis'].includes(label),
  );
/** The flow has come to rest: Result opened, or the screen offers a way
 * forward / another clip. */
const flowSettled = (renderer: ReactTestRenderer) => () =>
  navigatedToResult() ||
  offersRecovery(renderer) ||
  buttonLabels(renderer).includes('Record another clip');

function storedRecords(native: NativeTestDb): Array<Record<string, unknown>> {
  return native
    .prepare('SELECT record FROM local_analysis_record WHERE owner_key = ?')
    .all(owner)
    .map(row => JSON.parse(String((row as { record: unknown }).record)));
}

/** A signed-in athlete declares (or leaves AUTO DETECT), opens the camera and
 * swings; the native layer returns the clip and the shipping original
 * operation runs inside the real AnalyzeScreen. */
async function startGuided(id: string, options: { auto?: boolean } = {}) {
  const store = createCaptureAnalysisDb();
  mockCurrentDb = () => store.db;
  useAppStore.setState({ profile: originalProfile });
  mockRouteParams = { source: 'camera' };
  const data = guidedClipFixture(id);
  mockReadArtifact = async () => data.sidecarJson;
  mockCaptureImpl = async () => data.clip;
  mockVerifyBytes = async clip => ({
    status: 'verified-current-bytes',
    comparedExpectation: clip.nativeMediaIdentity!,
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  mounted.push(renderer);
  pressByLabel(renderer, options.auto ? 'Auto detect' : 'Forehand Drive');
  pressByLabel(renderer, 'Open automatic camera');
  await flush();
  driveNativeCaptureSequence();
  await flushUntil(flowSettled(renderer));
  return { renderer, store, ...data };
}

/* ---- an install created by the previous schema ---- */

/** The `analysis_logical_operations_immutable` trigger exactly as the
 * previous build created it (no `partial` completion kind). */
const PREVIOUS_LOGICAL_OPERATIONS_TRIGGER = `CREATE TRIGGER analysis_logical_operations_immutable
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
    BEGIN SELECT RAISE(ABORT, 'Original analysis is immutable'); END`;

const schemaSql = (native: NativeTestDb, type: string, name: string) =>
  String(
    (
      native
        .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
        .get(type, name) as { sql: string } | undefined
    )?.sql ?? '',
  );

/** Rewrites a freshly created database into the shape the PREVIOUS build
 * left on devices: `analysis_logical_operations` with the old CHECK
 * (`completion_kind IN ('scored','low_confidence','needs_technique_confirmation')`),
 * the old immutability trigger, and no refusal table. Everything else
 * (rows, indexes, child tables, foreign keys) is untouched. */
function downgradeToPreviousSchema(native: NativeTestDb) {
  const current = schemaSql(native, 'table', 'analysis_logical_operations');
  const previous = current.replace(/,\s*'partial'\s*\)/, ')');
  expect(previous).not.toBe(current);
  expect(previous).not.toContain('partial');
  native.exec('PRAGMA foreign_keys = OFF');
  native.exec('BEGIN');
  native.exec('DROP TRIGGER IF EXISTS analysis_logical_operations_immutable');
  const dependents = native
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = 'analysis_logical_operations' AND sql IS NOT NULL",
    )
    .all() as Array<{ name: string; sql: string }>;
  native.exec(
    previous.replace(
      /CREATE TABLE (IF NOT EXISTS )?analysis_logical_operations/,
      'CREATE TABLE w01_previous_logical_operations',
    ),
  );
  native.exec(
    'INSERT INTO w01_previous_logical_operations SELECT * FROM analysis_logical_operations',
  );
  native.exec('DROP TABLE analysis_logical_operations');
  // Legacy rename: child foreign keys and other tables' triggers keep their
  // textual `analysis_logical_operations` reference, exactly like a device
  // whose schema was created by the previous build.
  native.exec('PRAGMA legacy_alter_table = ON');
  native.exec(
    'ALTER TABLE w01_previous_logical_operations RENAME TO analysis_logical_operations',
  );
  native.exec('PRAGMA legacy_alter_table = OFF');
  for (const dependent of dependents) native.exec(dependent.sql);
  native.exec(PREVIOUS_LOGICAL_OPERATIONS_TRIGGER);
  native.exec('DROP TABLE IF EXISTS analysis_reservation_refusal');
  native.exec('COMMIT');
  native.exec('PRAGMA foreign_keys = ON');
  expect(schemaSql(native, 'table', 'analysis_logical_operations')).not.toMatch(
    /partial/,
  );
  expect(
    schemaSql(native, 'trigger', 'analysis_logical_operations_immutable'),
  ).not.toMatch(/partial/);
}

const upgradeDatabases: string[] = [];

beforeEach(() => {
  signInCaptureOwner(owner, ORIGIN);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
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
  for (const path of upgradeDatabases.splice(0)) rmSync(path, { force: true });
  setFetch(undefined);
  mockNavigation.replace.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
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

  /** Untrusted refusal bodies. The typed CODE is the contract; the message is
   * free text the app never renders — the partial's statement is the bounded
   * app-owned sentence on the first run, on replay, in the durable row and on
   * Result. `fragments` are the pieces that must not reach the screen. */
  const HOSTILE_MESSAGES: Array<[string, unknown, string[]]> = [
    ['the contract sentence itself', SERVER_MESSAGE, []],
    ['an empty string', '', []],
    ['a whitespace-only string', ' \t\n\u00a0 ', []],
    ['a 513-character string', 'x'.repeat(513), ['x'.repeat(513)]],
    ['a 2000-character string', 'y'.repeat(2000), ['y'.repeat(512)]],
    [
      'forbidden terms, invented numbers, a percentage and an approximation',
      'Your DUPR is about 4.5 ≈ 87% confidence; rating was counted.',
      ['DUPR', '4.5', '87%', '≈', 'rating was counted'],
    ],
    [
      'a fabricated score and range',
      'Technique score 7.2 out of 10, benchmark 3.5–4.0.',
      ['7.2', 'out of 10', '3.5–4.0'],
    ],
    [
      'a superlative and an AI-coach-equivalence claim',
      'The best AI coach, as accurate as a certified pro.',
      ['best', 'as accurate as'],
    ],
    [
      'a NUL and control characters',
      'No rating\u0000 was\u0007 counted\u001b[31m.',
      ['\u0000', '\u0007', '\u001b'],
    ],
    [
      'bidi controls',
      'No rating was \u202ecounted\u202c\u200f.',
      ['\u202e', '\u202c', '\u200f'],
    ],
    [
      'a 600-code-unit surrogate-pair string (slicing at 512 would split a pair)',
      '😀'.repeat(300),
      ['😀', '\ud83d'],
    ],
    ['a number', 42, ['42']],
    ['a boolean', true, ['true']],
    ['null', null, ['null']],
    ['an array', ['DUPR 4.5'], ['DUPR']],
    ['an object', { text: 'DUPR 4.5' }, ['DUPR', 'object']],
  ];

  it.each(HOSTILE_MESSAGES)(
    'refusal message %s: the first run, its replay, the durable row and Result all carry only the bounded app-owned statement',
    async (label, message, fragments) => {
      const { native, calls, server, outcome, req, before } = await runPartial(
        `w01-message-${label}`,
        message,
      );
      const partial = expectPartialMarker(outcome);
      expect(localShotInserts(calls)).toHaveLength(0);
      expect(outboxInserts(calls)).toHaveLength(0);
      expect(reserveCalls(server.urls)).toHaveLength(1);
      const stored = partial.record.partialOutcome.message;
      expect(stored).toBe(SERVER_MESSAGE);
      expect(refusalRows(native)).toEqual([
        expect.objectContaining({
          reason_code: RELEASE_NOT_AUTHORIZED_CODE,
          message: SERVER_MESSAGE,
        }),
      ]);

      const replay = expectPartialMarker(await runCaptureAnalysis(req));
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(replay.replayed).toBe(true);
      expect(replay.record.partialOutcome).toEqual(
        partial.record.partialOutcome,
      );
      expect(snapshotAccess()).toEqual(before);

      const copy = await expectPartialResult(
        partial.analysisId,
        SERVER_MESSAGE,
      );
      for (const fragment of fragments) expect(copy).not.toContain(fragment);
      expect(controlOrBidiCodePoints(copy)).toEqual([]);
    },
  );

  it('a durable refusal row or record whose message was tampered with is never rendered and never replayed as that text', async () => {
    const hostile =
      'Your DUPR is about 4.5 ≈ 87% confidence; rating was counted.';
    const { native, server, outcome, req, before } =
      await runPartial('w01-tampered');
    const partial = expectPartialMarker(outcome);
    // Simulate corrupt/foreign durable state: rewrite the stored record's
    // statement outside the app (the refusal row itself is immutable).
    const row = native
      .prepare(
        'SELECT record FROM local_analysis_record WHERE owner_key = ? AND id = ?',
      )
      .get(owner, partial.analysisId) as { record: string };
    const record = JSON.parse(row.record) as {
      partialOutcome: { message: string };
    };
    record.partialOutcome.message = hostile;
    native
      .prepare(
        'UPDATE local_analysis_record SET record = ? WHERE owner_key = ? AND id = ?',
      )
      .run(JSON.stringify(record), owner, partial.analysisId);

    const renderer = await renderResult(partial.analysisId);
    const copy = allText(renderer);
    expect(copy).not.toContain('DUPR');
    expect(copy).not.toContain('4.5');
    expect(copy).not.toMatch(/\d+\s*%|≈/);
    expect(copy).not.toContain('rating was counted');

    let replay: RunCaptureAnalysisOutcome | null = null;
    try {
      replay = await runCaptureAnalysis(req);
    } catch {
      replay = null;
    }
    if (replay?.kind === 'partial')
      expect(replay.record.partialOutcome.message).toBe(SERVER_MESSAGE);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
  });

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

  it('a failed record write on the original-operation path leaves nothing half-delivered, never charges, and the SAME operation later delivers its partial without a second reservation', async () => {
    const {
      db,
      calls,
      failNext,
      server,
      run,
      execution,
      operation,
      readAttempt,
    } = await prepareOriginal('w01-original-write-failure');
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
    const afterFailure = captureDbState(db);
    expect(afterFailure.records).toBe(0);
    expect(afterFailure.shots).toBe(0);
    expect(afterFailure.outbox).toBe(0);
    expect(captureStatuses(db)).toEqual(seededStatus);
    expect(snapshotAccess()).toEqual(before);
    // The authority settled this attempt: terminal, permit-less, no fault.
    const settled = await readAttempt();
    expect(settled.operation.finalRecordId).toBeNull();
    expect(settled.attempt.run.state).toBe('terminal');
    expect(settled.attempt.run.permitId).toBeNull();
    expect(settled.attempt.run.terminalReason).toBe('reservation_rejected');
    expect(settled.attempt.technicalFailure).toBeNull();

    // What the screen does on the next visit: reconcile, then run again.
    await reconcileOriginalCaptureAnalysis({
      db,
      execution,
      operationId: operation.operationId,
    });
    const retry = expectPartialMarker(await run());
    expect(retry.record.partialOutcome.message).toBe(SERVER_MESSAGE);
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
    const delivered = await readAttempt();
    expect(delivered.operation.finalRecordId).toBe(retry.analysisId);
    expect(delivered.operation.completionKind).toBe('partial');
    expect(delivered.operation.currentAttemptId).toBe(
      settled.operation.currentAttemptId,
    );
    expect(delivered.attempt.run.permitId).toBeNull();
    expect(delivered.attempt.run.state).toBe('terminal');

    const replay = expectPartialMarker(await run());
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(retry.analysisId);
    expect(replay.record).toEqual(retry.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(retry.analysisId, SERVER_MESSAGE);
  });

  it('AUTO DETECT on the original-operation path: a typed refusal keeps the measured mechanics as a durable partial that replays, never a dead end', async () => {
    const { db, calls, server, run, readAttempt } = await prepareOriginal(
      'w01-original-auto-detect',
      SERVER_MESSAGE,
      null,
    );
    const before = snapshotAccess();

    const first = expectPartialMarker(await run());
    expect(first.record.partialOutcome.message).toBe(SERVER_MESSAGE);
    expect(first.record.kind ?? 'analyzed').toBe('analyzed');
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(finalizeCalls(server.urls)).toHaveLength(0);
    const state = captureDbState(db);
    expect(state.records).toBe(1);
    expect(state.shots).toBe(0);
    expect(state.outbox).toBe(0);
    expect(captureStatuses(db)).toEqual(['analyzed']);
    expect(snapshotAccess()).toEqual(before);
    const settled = await readAttempt();
    expect(settled.operation.finalRecordId).toBe(first.analysisId);
    expect(settled.operation.completionKind).toBe('partial');
    expect(settled.attempt.run.state).toBe('terminal');
    expect(settled.attempt.run.permitId).toBeNull();
    expect(settled.attempt.run.terminalReason).toBe('reservation_rejected');
    expect(settled.attempt.technicalFailure).toBeNull();

    const again = expectPartialMarker(await run());
    expect(again.replayed).toBe(true);
    expect(again.analysisId).toBe(first.analysisId);
    expect(again.record).toEqual(first.record);
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(captureDbState(db).records).toBe(1);
    expect(captureDbState(db).shots).toBe(0);
    expect(snapshotAccess()).toEqual(before);

    await expectPartialResult(first.analysisId, SERVER_MESSAGE);
  });

  it('account deletion: purgeOwnerData removes every row of an owner who has a settled refusal, including the refusal metadata, on the foreign-key-enforced schema', async () => {
    const { db, native, outcome } = await runPartial('w01-purge');
    expectPartialMarker(outcome);
    expect(ownerRowCount(native, 'analysis_reservation_refusal')).toBe(1);
    expect(ownerRowCount(native, 'analysis_run_journal')).toBe(1);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);
    expect(ownerRowCount(native, 'local_capture')).toBe(1);

    // The deletion flow's local purge (authStore) after the server confirms.
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

  it('account deletion: purgeOwnerData also removes the refusal bound to an original-operation attempt', async () => {
    const { db, native, run } = await prepareOriginal('w01-purge-original');
    expectPartialMarker(await run());
    expect(ownerRowCount(native, 'analysis_reservation_refusal')).toBe(1);
    expect(ownerRowCount(native, 'analysis_execution_attempts')).toBe(1);
    expect(ownerRowCount(native, 'analysis_logical_operations')).toBe(1);
    expect(ownerRowCount(native, 'local_analysis_record')).toBe(1);

    await expect(purgeOwnerData(db, owner)).resolves.toBeUndefined();

    expect({
      local_capture: ownerRowCount(native, 'local_capture'),
      local_analysis_record: ownerRowCount(native, 'local_analysis_record'),
      analysis_execution_attempts: ownerRowCount(
        native,
        'analysis_execution_attempts',
      ),
      analysis_logical_operations: ownerRowCount(
        native,
        'analysis_logical_operations',
      ),
      analysis_reservation_refusal: ownerRowCount(
        native,
        'analysis_reservation_refusal',
      ),
    }).toEqual({
      local_capture: 0,
      local_analysis_record: 0,
      analysis_execution_attempts: 0,
      analysis_logical_operations: 0,
      analysis_reservation_refusal: 0,
    });
    expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
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

describe('W01-05 — the typed refusal arriving through a recovery re-reserve', () => {
  const transientAnswers: Array<[string, () => Response]> = [
    ['HTTP 503', transient503],
    ['HTTP 429 with Retry-After', transient429],
  ];

  it.each(transientAnswers)(
    'plain path: %s, then the settled refusal on the sync-runtime recovery sweep — durable refusal metadata, the same operation delivers the partial, two reservations ever, access unchanged',
    async (_label, transient) => {
      const { db, native, calls } = createCaptureAnalysisDb();
      mockCurrentDb = () => db;
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = scriptedReservationServer([
        transient,
        () => jsonResponse(refusalBody(), 409),
      ]);
      setFetch(server.fetchMock);
      const req = request(db, clip, `w01-recovery-plain-${_label}`);
      const before = snapshotAccess();

      const first = await runCaptureAnalysis(req);
      expect(first.kind).toBe('unavailable');
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(captureDbState(db).records).toBe(0);
      expect(captureStatuses(db)).toEqual(['awaiting_model']);

      // What syncRuntime.trigger runs: the permit-less pending run is
      // re-reserved and this time receives the typed refusal.
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
      const journal = captureDbState(db).journal[0] as Record<string, unknown>;
      expect(journal).toMatchObject({
        state: 'terminal',
        terminal_reason: 'reservation_rejected',
        permit_id: null,
        last_http_status: 409,
      });
      // The settled verdict is durable exactly like a direct refusal.
      expect(refusalRows(native)).toEqual([
        expect.objectContaining({
          operation_id: req.operationId,
          reason_code: RELEASE_NOT_AUTHORIZED_CODE,
          message: SERVER_MESSAGE,
        }),
      ]);
      expect(snapshotAccess()).toEqual(before);

      // The refused operation now settles the mechanics as the partial —
      // never a dead end, never a new reservation, never a charge.
      const second = await runCaptureAnalysis(req);
      expect({ second, captures: captureStatuses(db) }).not.toMatchObject({
        second: { kind: 'unavailable', cause: 'recovery_pending' },
        captures: ['awaiting_model'],
      });
      const partial = expectPartialMarker(second);
      expect(partial.record.partialOutcome.message).toBe(SERVER_MESSAGE);
      expect(reserveCalls(server.urls)).toHaveLength(2);
      expectNoChargeableWrites(calls, server.urls, db);
      expect(captureDbState(db).records).toBe(1);
      expect(captureDbState(db).journal).toHaveLength(1);
      expect(captureStatuses(db)).toEqual(['analyzed']);
      expect(snapshotAccess()).toEqual(before);

      const replay = expectPartialMarker(await runCaptureAnalysis(req));
      expect(replay.replayed).toBe(true);
      expect(replay.record).toEqual(partial.record);
      expect(reserveCalls(server.urls)).toHaveLength(2);
      expect(refusalRows(native)).toHaveLength(1);
      expect(snapshotAccess()).toEqual(before);

      await expectPartialResult(partial.analysisId, SERVER_MESSAGE);
    },
  );

  it.each(transientAnswers)(
    'original-operation path: %s, then the settled refusal on the reconcile re-reserve — the same operation delivers the partial, capture analyzed, two reservations ever, access unchanged',
    async (_label, transient) => {
      const server = scriptedReservationServer([
        transient,
        () => jsonResponse(refusalBody(), 409),
      ]);
      const { db, native, calls, run, reconcile, readAttempt } =
        await prepareOriginal(
          `w01-recovery-original-${_label}`,
          SERVER_MESSAGE,
          'forehand_drive',
          { server },
        );
      const before = snapshotAccess();

      const first = await run();
      expect(first.kind).toBe('unavailable');
      expect(reserveCalls(server.urls)).toHaveLength(1);
      expect(captureDbState(db).records).toBe(0);
      expect(refusalRows(native)).toHaveLength(0);

      await reconcile();
      const failed = await readAttempt();
      expect(reserveCalls(server.urls)).toHaveLength(2);
      expect(failed.attempt.run.permitId).toBeNull();
      expect(failed.attempt.run.lastHttpStatus).toBe(409);
      expect(failed.attempt.run.state).toBe('terminal');
      expect(failed.attempt.run.terminalReason).toBe('reservation_rejected');
      expect(refusalRows(native)).toEqual([
        expect.objectContaining({
          reason_code: RELEASE_NOT_AUTHORIZED_CODE,
          message: SERVER_MESSAGE,
        }),
      ]);
      expect(snapshotAccess()).toEqual(before);

      const retry = await run();
      expect({ retry, captures: captureStatuses(db) }).not.toMatchObject({
        retry: { kind: 'unavailable', cause: 'recovery_pending' },
        captures: ['awaiting_model'],
      });
      const partial = expectPartialMarker(retry);
      expect(reserveCalls(server.urls)).toHaveLength(2);
      expectNoChargeableWrites(calls, server.urls, db);
      expect(captureDbState(db).records).toBe(1);
      expect(captureStatuses(db)).toEqual(['analyzed']);
      expect(snapshotAccess()).toEqual(before);
      const delivered = await readAttempt();
      expect(delivered.operation.completionKind).toBe('partial');
      expect(delivered.operation.finalRecordId).toBe(partial.analysisId);
      expect(delivered.attempt.run.permitId).toBeNull();
      expect(delivered.attempt.technicalFailure).toBeNull();

      const replay = expectPartialMarker(await run());
      expect(replay.replayed).toBe(true);
      expect(replay.record).toEqual(partial.record);
      expect(reserveCalls(server.urls)).toHaveLength(2);
      expect(snapshotAccess()).toEqual(before);

      await expectPartialResult(partial.analysisId, SERVER_MESSAGE);
    },
  );

  it('a recovery refusal whose message is untrusted text is still stored as the bounded app-owned statement', async () => {
    const hostile =
      'Your DUPR is about 4.5 ≈ 87% confidence; rating was counted.';
    const server = scriptedReservationServer([
      transient503,
      () => jsonResponse(refusalBody(hostile), 409),
    ]);
    const { native, run, reconcile } = await prepareOriginal(
      'w01-recovery-hostile',
      SERVER_MESSAGE,
      'forehand_drive',
      { server },
    );
    expect((await run()).kind).toBe('unavailable');
    await reconcile();
    expect(refusalRows(native)).toEqual([
      expect.objectContaining({ message: SERVER_MESSAGE }),
    ]);
    const partial = expectPartialMarker(await run());
    expect(partial.record.partialOutcome.message).toBe(SERVER_MESSAGE);
    const copy = await expectPartialResult(partial.analysisId, SERVER_MESSAGE);
    expect(copy).not.toContain('DUPR');
    expect(copy).not.toContain('4.5');
  });
});

describe('W01-05 — the mounted AnalyzeScreen delivers the partial', () => {
  it('declared stroke under the typed refusal: the shipping flow opens the benchmark-unavailable Result with the durable partial, one reservation, no shot', async () => {
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const { renderer, store } = await startGuided('w01-flow-declared');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    const records = storedRecords(store.native);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: null,
      partialOutcome: {
        status: 'partial',
        billingDisposition: 'not_chargeable',
        reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
        message: SERVER_MESSAGE,
      },
    });
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: records[0]!['id'],
    });
    expect(textOf(renderer)).not.toContain('Retry saved analysis');
    expect(snapshotAccess()).toEqual(before);
    await expectPartialResult(String(records[0]!['id']), SERVER_MESSAGE);
  });

  it('AUTO DETECT under the typed refusal: the athlete reaches the benchmark-unavailable Result — no classifier or measurement cause is invented', async () => {
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const { renderer, store } = await startGuided('w01-flow-auto', {
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
    expect(store.count('outbox', owner)).toBe(0);
    expect(captureStatuses(store.db)).toEqual(['analyzed']);

    const visible = textOf(renderer);
    const opened = mockNavigation.replace.mock.calls.some(
      ([route, params]) =>
        route === 'Result' &&
        (params as { analysisId?: unknown }).analysisId === partial['id'],
    );
    const canOpenResult = buttonLabels(renderer).includes('See the full read');
    const statesBenchmarkUnavailable =
      visible.includes('BENCHMARK UNAVAILABLE') ||
      visible.includes('benchmark unavailable');
    expect({
      reachable: opened || (canOpenResult && statesBenchmarkUnavailable),
      inventsCause:
        visible.includes('couldn’t be measured cleanly enough') ||
        visible.includes('would not commit to a stroke'),
      buttons: buttonLabels(renderer),
    }).toEqual(
      expect.objectContaining({ reachable: true, inventsCause: false }),
    );
    expect(visible).not.toMatch(/\d+\s*%|out of 10|TECHNIQUE SCORE|DUPR|≈/);
    expect(snapshotAccess()).toEqual(before);
    await expectPartialResult(String(partial['id']), SERVER_MESSAGE);
  });

  it('refusal settled, then the inference fails once: the on-screen saved-analysis action reruns the SAME operation once, delivers the partial with zero new reservations and opens Result', async () => {
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
    const server = releaseNotAuthorizedServer();
    setFetch(server.fetchMock);
    const before = snapshotAccess();
    const { renderer, store } = await startGuided('w01-flow-crash');
    expect(reserveCalls(server.urls)).toHaveLength(1);
    expect(refusalRows(store.native)).toHaveLength(1);
    expect(storedRecords(store.native)).toHaveLength(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    const offered = buttonLabels(renderer).find(label =>
      ['Retry saved analysis', 'Check saved analysis'].includes(label),
    );
    expect(offered).toBeDefined();

    pressButton(renderer, offered!);
    await flushUntil(
      () => navigatedToResult() || storedRecords(store.native).length > 0,
    );
    await flushUntil(navigatedToResult);

    expect(reserveCalls(server.urls)).toHaveLength(1);
    const records = storedRecords(store.native);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: null,
      partialOutcome: {
        reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
        message: SERVER_MESSAGE,
      },
    });
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(captureStatuses(store.db)).toEqual(['analyzed']);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: records[0]!['id'],
    });
    const attempts = store.native
      .prepare(
        'SELECT state, terminal_reason, permit_id, technical_failure FROM analysis_execution_attempts WHERE owner_key = ? ORDER BY attempt_ordinal',
      )
      .all(owner);
    expect(attempts).toEqual([
      {
        state: 'terminal',
        terminal_reason: 'reservation_rejected',
        permit_id: null,
        technical_failure: null,
      },
    ]);
    expect(refusalRows(store.native)).toHaveLength(1);
    expect(snapshotAccess()).toEqual(before);
    await expectPartialResult(String(records[0]!['id']), SERVER_MESSAGE);
  });

  it('an unresolved hold (permit reserved, release unconfirmed) stays in the recovery UI: the saved-analysis check never reruns, never reserves again and never fabricates a record', async () => {
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
    // The reservation is granted; every finalize/release attempt fails on
    // transport, so the permit's fate is genuinely uncertain.
    const urls: string[] = [];
    const fetchMock = jest.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/v1/analysis-permits'))
        return jsonResponse(
          {
            permit: {
              id: '77777777-7777-4777-8777-000000000001',
              accessSource: 'free',
              status: 'reserved',
              expiresAt: '2026-09-09T20:00:00.000Z',
            },
          },
          200,
        );
      throw new TypeError('Network request failed');
    });
    setFetch(fetchMock);
    const before = snapshotAccess();
    const { renderer, store } = await startGuided('w01-flow-held');
    expect(reserveCalls(urls)).toHaveLength(1);
    expect(refusalRows(store.native)).toHaveLength(0);
    expect(storedRecords(store.native)).toHaveLength(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(offersRecovery(renderer)).toBe(true);

    for (let round = 0; round < 2; round += 1) {
      const offered = buttonLabels(renderer).find(label =>
        ['Retry saved analysis', 'Check saved analysis'].includes(label),
      );
      expect(offered).toBeDefined();
      pressButton(renderer, offered!);
      await flushUntil(flowSettled(renderer));
    }
    expect(reserveCalls(urls)).toHaveLength(1);
    expect(storedRecords(store.native)).toHaveLength(0);
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(captureStatuses(store.db)).toEqual(['awaiting_model']);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(offersRecovery(renderer)).toBe(true);
    const visible = textOf(renderer);
    expect(visible).not.toMatch(/\d+\s*%|out of 10|TECHNIQUE SCORE/);
    expect(visible).not.toContain('BENCHMARK UNAVAILABLE');
    expect(snapshotAccess()).toEqual(before);
  });
});

describe('W01-05 — an existing install created by the previous schema', () => {
  it('is upgraded in place on open: rows, history, indexes, foreign-key enforcement and immutability survive, and the partial completion is accepted', async () => {
    const path = join(
      tmpdir(),
      `w01-partial-upgrade-${process.pid}-${Date.now()}.sqlite`,
    );
    upgradeDatabases.push(path);

    // 1. A device that already has history on the PREVIOUS build.
    const previous = createSqliteTestDb(path);
    const permits = permitServer();
    const { run } = await prepareOriginal(
      'w01-upgrade-history',
      SERVER_MESSAGE,
      'forehand_drive',
      {
        store: { ...previous, failNext: previous.failStatementOnce },
        server: permits,
      },
    );
    const history = await run();
    expect(['scored', 'low_confidence']).toContain(history.kind);
    const rowsOf = (native: NativeTestDb, table: string) =>
      native.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const indexesOf = (native: NativeTestDb) =>
      native
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'analysis_logical_operations' AND sql IS NOT NULL ORDER BY name",
        )
        .all()
        .map(row => row.name);
    const foreignKeysOf = (native: NativeTestDb) =>
      native
        .prepare('PRAGMA foreign_key_list(analysis_logical_operations)')
        .all();
    downgradeToPreviousSchema(previous.native);
    const tables = [
      'analysis_logical_operations',
      'analysis_execution_attempts',
      'local_analysis_record',
      'local_capture',
      'local_shot',
      'outbox',
      'analysis_run_journal',
    ];
    const snapshotRows = (native: NativeTestDb) =>
      new Map(tables.map(table => [table, rowsOf(native, table)]));
    const rowsBefore = snapshotRows(previous.native);
    const indexesBefore = indexesOf(previous.native);
    const foreignKeysBefore = foreignKeysOf(previous.native);
    const kvBefore = rowsOf(previous.native, 'kv');
    const operationsBefore = rowsBefore.get('analysis_logical_operations')!;
    expect(operationsBefore).toHaveLength(1);
    expect(
      rowsBefore.get('analysis_execution_attempts')!.length,
    ).toBeGreaterThan(0);
    expect(previous.native.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
    previous.close();
    mockNavigation.replace.mockClear();
    mockTriggerOutboxSync.mockClear();

    // 2. The app updates and opens the same database file.
    const upgraded = createSqliteTestDb(path);
    expect(
      schemaSql(upgraded.native, 'table', 'analysis_logical_operations'),
    ).toMatch(/'partial'/);
    expect(
      schemaSql(
        upgraded.native,
        'trigger',
        'analysis_logical_operations_immutable',
      ),
    ).toMatch(/'partial'/);
    expect(
      schemaSql(upgraded.native, 'table', 'analysis_reservation_refusal'),
    ).not.toBe('');
    expect(snapshotRows(upgraded.native)).toEqual(rowsBefore);
    expect(rowsOf(upgraded.native, 'kv')).toEqual(kvBefore);
    expect(indexesOf(upgraded.native)).toEqual(indexesBefore);
    expect(foreignKeysOf(upgraded.native)).toEqual(foreignKeysBefore);
    expect(upgraded.native.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(upgraded.native.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
    // Durable history is still immutable and the primary key still unique.
    const scored = operationsBefore[0] as {
      owner_key: string;
      operation_id: string;
      final_record_id: string | null;
      completion_kind: string | null;
    };
    expect(scored.final_record_id).not.toBeNull();
    expect(() =>
      upgraded.native
        .prepare(
          'UPDATE analysis_logical_operations SET final_record_id = NULL WHERE owner_key = ? AND operation_id = ?',
        )
        .run(scored.owner_key, scored.operation_id),
    ).toThrow(/immutable/);
    expect(() =>
      upgraded.native
        .prepare(
          'INSERT INTO analysis_logical_operations SELECT * FROM analysis_logical_operations WHERE owner_key = ? AND operation_id = ?',
        )
        .run(scored.owner_key, scored.operation_id),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    // Foreign keys are enforced against the rebuilt parent.
    expect(() =>
      upgraded.native
        .prepare(
          `INSERT INTO analysis_execution_attempts (owner_key, operation_id, owner_generation, capture_id, analysis_id,
             request_hash, api_origin, reservation_key, attempt_ordinal, state, attempt_count, created_at_ms, updated_at_ms)
           VALUES (?, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0, 'ffffffff-ffff-4fff-8fff-ffffffffffff',
             'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ?, ?, 'w01-orphan-reservation', 1, 'reserve_pending', 0, 1, 1)`,
        )
        .run(scored.owner_key, 'f'.repeat(64), ORIGIN),
    ).toThrow(/FOREIGN KEY/);
    expect(
      schemaSql(upgraded.native, 'table', 'w01_previous_logical_operations'),
    ).toBe('');

    // 3. On the upgraded install the typed refusal settles as the partial.
    const refusal = releaseNotAuthorizedServer();
    const flow = await prepareOriginal(
      'w01-upgrade-partial',
      SERVER_MESSAGE,
      'forehand_drive',
      {
        store: { ...upgraded, failNext: upgraded.failStatementOnce },
        server: refusal,
      },
    );
    const before = snapshotAccess();
    const partial = expectPartialMarker(await flow.run());
    expect(reserveCalls(refusal.urls)).toHaveLength(1);
    expect(finalizeCalls(refusal.urls)).toHaveLength(0);
    const delivered = await flow.readAttempt();
    expect(delivered.operation.completionKind).toBe('partial');
    expect(delivered.operation.finalRecordId).toBe(partial.analysisId);
    expect(
      upgraded.native
        .prepare('SELECT status FROM local_capture WHERE id = ?')
        .get(flow.req.captureId),
    ).toEqual({ status: 'analyzed' });
    expect(upgraded.count('local_shot', owner)).toBe(
      rowsBefore.get('local_shot')!.length,
    );
    expect(snapshotAccess()).toEqual(before);
    const replay = expectPartialMarker(await flow.run());
    expect(replay.replayed).toBe(true);
    expect(reserveCalls(refusal.urls)).toHaveLength(1);
    expect(upgraded.native.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );

    // 4. Opening the already-upgraded file again is a no-op for the data.
    const rowsAfter = snapshotRows(upgraded.native);
    const schemaAfter = schemaSql(
      upgraded.native,
      'table',
      'analysis_logical_operations',
    );
    upgraded.close();
    const reopened = createSqliteTestDb(path);
    expect(snapshotRows(reopened.native)).toEqual(rowsAfter);
    expect(
      schemaSql(reopened.native, 'table', 'analysis_logical_operations'),
    ).toBe(schemaAfter);
    expect(reopened.native.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
  });
});
