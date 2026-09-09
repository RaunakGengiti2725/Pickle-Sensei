/**
 * W01-05 adversarial attacks (round 4, candidate 1ace3523) — the MOUNTED
 * shipping flow. The candidate suite proves the runner settles a typed
 * refusal as a non-chargeable partial and that ResultScreen renders the
 * benchmark-unavailable state when it is opened with the analysis id. These
 * attacks ask whether the user ever GETS there: AnalyzeScreen is the only
 * thing that navigates to Result after a capture, and it learned nothing
 * about the new `partial` outcome kind.
 *
 * Same harness as analyzeScreenFullFlowE2E: real AnalyzeScreen, real
 * pipeline, real migrated SQLite; the native camera seam and HTTP are the
 * only simulated pieces.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as pipeline from '@pickle/analysis-pipeline';
import { fail, failure } from '@pickle/shared-types';
import { guidedClipFixture as guidedClip } from '../testSupport/guidedClipFixture';
import * as captureRunner from '../src/analysis/runCaptureAnalysis';
import { useAppStore } from '../src/state/appStore';
import { Button } from '../src/design/components';
import type { LocalDb } from '../src/data/db';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../testSupport/sqlite';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type {
  CameraEvent,
  CameraReadinessState,
  CapturedClip,
} from '../src/camera/capture';

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ key: 'analyze-attack', params: { source: 'camera' } }),
}));
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
jest.mock('../src/data/syncRuntime', () => ({ triggerOutboxSync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(() => mockCaptureImpl()),
    importStrokeVideo: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    verifyCapturedClipCurrentBytes: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { verifyCapturedClipCurrentBytes } from '../src/camera/capture';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

const owner = '22222222-2222-4222-8222-222222222222';
const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';
const SERVER_MESSAGE =
  'Validated ratings are not available right now. No rating was counted.';
const originalProfile = {
  skillLevel: 'intermediate',
  handedness: 'right' as const,
  goal: 'drives',
  biggestProblem: 'control',
  focusCheckpoint: 'preparation' as const,
};

let activeDb: ReturnType<typeof createSqliteTestDb>;
function mockCurrentDb(): LocalDb {
  return activeDb.db;
}

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** The release authority refuses admission with the typed, settled 409. */
function refusalServer() {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.endsWith('/v1/analysis-permits'))
      return jsonResponse(
        {
          error: { code: RELEASE_NOT_AUTHORIZED_CODE, message: SERVER_MESSAGE },
          release: { status: 'ineligible', reasonCode: 'unreleased' },
        },
        409,
      );
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return fetchMock;
}

function reservationCount(fetchMock: jest.Mock): number {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith('/v1/analysis-permits'),
  ).length;
}

const mountedScreens = new Set<TestRenderer.ReactTestRenderer>();

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
    mountedScreens.add(renderer);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
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

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function buttonLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Button)
    .map(node => String(node.props.label));
}

function action(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): () => void {
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
async function settled() {
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
 * operation runs. */
async function startGuided(id: string, options: { auto?: boolean } = {}) {
  useAppStore.setState({ profile: originalProfile });
  const data = guidedClip(id);
  mockReadArtifact = async () => data.sidecarJson;
  mockCaptureImpl = async () => data.clip;
  const renderer = await renderScreen();
  pressByLabel(renderer, options.auto ? 'Auto detect' : 'Forehand Drive');
  pressByLabel(renderer, 'Open automatic camera');
  await flush();
  driveNativeCaptureSequence();
  await settled();
  return { renderer, ...data };
}

function storedRecords(): Array<Record<string, unknown>> {
  return activeDb.native
    .prepare('SELECT record FROM local_analysis_record WHERE owner_key = ?')
    .all(owner)
    .map(row => JSON.parse(String((row as { record: unknown }).record)));
}

function attempts() {
  return activeDb.native
    .prepare(
      'SELECT * FROM analysis_execution_attempts WHERE owner_key = ? ORDER BY attempt_ordinal',
    )
    .all(owner) as Array<Record<string, unknown>>;
}

function refusalRows() {
  return activeDb.native
    .prepare('SELECT * FROM analysis_reservation_refusal WHERE owner_key = ?')
    .all(owner) as Array<Record<string, unknown>>;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useAppStore.setState({ profile: null });
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
  jest
    .mocked(verifyCapturedClipCurrentBytes)
    .mockReset()
    .mockImplementation(async value => ({
      status: 'verified-current-bytes',
      comparedExpectation: (value as CapturedClip).nativeMediaIdentity!,
    }));
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  activeDb = createSqliteTestDb();
  mockCameraListeners.clear();
  mockNavigation.replace.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
  fetchMock = refusalServer();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedScreens) renderer.unmount();
    mountedScreens.clear();
  });
  closeSqliteTestDatabases();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({ profile: null });
  jest.restoreAllMocks();
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('W01-05 R4 attacks — does the athlete ever reach the partial Result?', () => {
  it('F1 declared stroke under the typed refusal: the shipping flow lands on Result with the durable partial, one reservation, no shot', async () => {
    const { renderer } = await startGuided('r4-f1-declared');
    expect(reservationCount(fetchMock)).toBe(1);
    const records = storedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: null,
      partialOutcome: {
        status: 'partial',
        billingDisposition: 'not_chargeable',
        reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
      },
    });
    expect(activeDb.count('local_shot', owner)).toBe(0);
    expect(activeDb.count('outbox', owner)).toBe(0);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: records[0]!['id'],
    });
    expect(textOf(renderer)).not.toContain('Retry saved analysis');
  });

  it('F2 Auto detect under the typed refusal: the athlete must be able to reach the benchmark-unavailable Result (or see it inline), not a classifier dead end', async () => {
    const { renderer } = await startGuided('r4-f2-auto', { auto: true });
    // The runner did its part: a durable, non-chargeable partial exists.
    expect(reservationCount(fetchMock)).toBe(1);
    const records = storedRecords();
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
    expect(activeDb.count('local_shot', owner)).toBe(0);
    expect(attempts()[0]).toMatchObject({
      state: 'terminal',
      terminal_reason: 'reservation_rejected',
      permit_id: null,
    });
    const capture = activeDb.native
      .prepare('SELECT status FROM local_capture WHERE owner_key = ?')
      .get(owner) as { status: string };
    expect(capture.status).toBe('analyzed');

    // The user-visible contract: EITHER the screen navigated to Result (which
    // renders the explicit benchmark-unavailable state) OR the screen itself
    // offers that state and a way to open the record. Anything else is a
    // dead end: the capture is already 'analyzed', so it is gone from the
    // Library's pending list, and it has no local_shot, so it is absent from
    // the Library's history too.
    const visible = textOf(renderer);
    const navigatedToResult = mockNavigation.replace.mock.calls.some(
      ([route, params]) =>
        route === 'Result' &&
        (params as { analysisId?: unknown }).analysisId === partial['id'],
    );
    const canOpenResult = buttonLabels(renderer).includes('See the full read');
    const statesBenchmarkUnavailable =
      visible.includes('BENCHMARK UNAVAILABLE') ||
      visible.includes('benchmark unavailable');
    expect({
      reachable:
        navigatedToResult || (canOpenResult && statesBenchmarkUnavailable),
      // The benchmark was withheld by the release authority. Copy that blames
      // the measurement ("couldn't be measured cleanly enough to score") or
      // the classifier invents a cause the run never had.
      inventsCause:
        visible.includes('couldn’t be measured cleanly enough') ||
        visible.includes('would not commit to a stroke'),
      visible,
      buttons: buttonLabels(renderer),
      navigation: mockNavigation.replace.mock.calls,
    }).toEqual(
      expect.objectContaining({ reachable: true, inventsCause: false }),
    );
  });

  it('F3 refusal settled, then the inference crashes once: the saved-analysis retry delivers the partial with ZERO new reservations and no dead end', async () => {
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
    const { renderer } = await startGuided('r4-f3-crash-after-refusal');
    expect(reservationCount(fetchMock)).toBe(1);
    expect(refusalRows()).toHaveLength(1);
    expect(storedRecords()).toHaveLength(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    const firstScreen = textOf(renderer);
    // The athlete must have a way forward on the SAME saved capture: the
    // saved-analysis retry (technical failure) or the reconcile check (held).
    // Press whichever the screen offers, at most twice, as a user would.
    const forward = ['Retry saved analysis', 'Check saved analysis'];
    const pressed: string[] = [];
    for (let round = 0; round < 2 && storedRecords().length === 0; round += 1) {
      const offered = buttonLabels(renderer).find(label =>
        forward.includes(label),
      );
      if (!offered) break;
      pressed.push(offered);
      act(() => action(renderer, offered)());
      await settled();
    }
    expect(reservationCount(fetchMock)).toBe(1);
    const records = storedRecords();
    expect({
      firstScreen,
      pressed,
      afterRetry: textOf(renderer),
      records: records.length,
      attempts: attempts().map(row => ({
        state: row['state'],
        terminal_reason: row['terminal_reason'],
        technical_failure: row['technical_failure'],
        permit_id: row['permit_id'],
      })),
    }).toEqual(expect.objectContaining({ records: 1 }));
    expect(records[0]).toMatchObject({
      result: null,
      partialOutcome: { reasonCode: RELEASE_NOT_AUTHORIZED_CODE },
    });
    expect(activeDb.count('local_shot', owner)).toBe(0);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: records[0]!['id'],
    });
  });

  it('F4 refusal settled, then an unclassified pipeline throw: nothing is fabricated, nothing charged, the screen stays honest and a later retry cannot reserve again', async () => {
    jest
      .mocked(pipeline.analyzeCapture)
      .mockRejectedValueOnce(new Error('Unclassified failure'));
    const { renderer } = await startGuided('r4-f4-throw-after-refusal');
    expect(reservationCount(fetchMock)).toBe(1);
    expect(storedRecords()).toHaveLength(0);
    expect(activeDb.count('local_shot', owner)).toBe(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    const visible = textOf(renderer);
    expect(visible).not.toMatch(/\d+\s*%|out of 10|TECHNIQUE SCORE/);
    const labels = buttonLabels(renderer);
    if (labels.includes('Retry saved analysis')) {
      act(() => action(renderer, 'Retry saved analysis')());
      await settled();
    }
    expect(reservationCount(fetchMock)).toBe(1);
    expect(activeDb.count('local_shot', owner)).toBe(0);
    expect(activeDb.count('outbox', owner)).toBe(0);
  });
});
