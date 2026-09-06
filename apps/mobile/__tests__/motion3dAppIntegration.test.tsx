/**
 * SOFTWARE-ONLY integration fixtures, not reconstruction-accuracy evidence.
 * The mounted screens, plan selection, native-provider adapter, analysis
 * builder, migrations, repositories and presentation resolver run unchanged.
 * Only platform/dependency seams are controlled: no video is reconstructed or
 * played on physical RN/iOS hardware by this suite. SQLite is real, in memory.
 */
import React from 'react';
import {
  AccessibilityInfo,
  DeviceEventEmitter,
  NativeModules,
  Platform,
  Text,
} from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { open, type DB } from '@op-engineering/op-sqlite';
import {
  buildMotion3DAnalysis,
  type Motion3DAnalysis,
} from '@pickle/analysis-pipeline';
import { sha256Hex, type Motion3DArtifact } from '@pickle/swing-domain';
import type { ShotAnalysis, ShotTypeSlug } from '@pickle/shared-types';

const mockNavigation = {
  navigate: jest.fn(),
  replace: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
  popTo: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = { source: 'library' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(effect, [effect]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView:
    jest.requireActual<typeof import('react-native')>('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-svg', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: View,
    Svg: View,
    Circle: View,
    Defs: View,
    G: View,
    Line: View,
    Path: View,
    Polygon: View,
    Polyline: View,
    RadialGradient: View,
    LinearGradient: View,
    Rect: View,
    Stop: View,
  };
});
jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  captureStrokeVideo: jest.fn(),
  importStrokeVideo: jest.fn(),
  cancelCameraOperation: jest.fn(),
  importedPoseExtractionAvailable: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
  readCaptureArtifact: jest.fn(),
}));
// Account SDKs and the unrelated streak ceremony are not under test.
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));
const mockConsistencyState = {
  refresh: jest.fn(async () => {}),
  daySecured: null,
  consumeDaySecured: jest.fn(() => null),
};
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import * as practiceSet from '../src/analysis/practiceSet';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import {
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importedPoseExtractionAvailable,
  importStrokeVideo,
  readCaptureArtifact,
  type CapturedClip,
} from '../src/camera/capture';
import { resolveAnalysisPresentation } from '../src/components/analysisPresentation';
import { StrokeResult } from '../src/components/StrokeResult';
import { loadStrokeResultEvidence } from '../src/components/strokeResultData';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import {
  captureDataOwnerScope,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import * as api from '../src/data/api';
import { getDb, type LocalDb } from '../src/data/db';
import {
  loadMotion3DAnalysis,
  saveMotion3DAnalysis,
} from '../src/data/motion3dRepository';
import { getPendingCapture, savePendingCapture } from '../src/data/repository';
import * as syncRuntime from '../src/data/syncRuntime';
import { Button, ScoreRing } from '../src/design/components';
import * as appStoreReview from '../src/review/appStoreReview';
import { FormReviewPlayer } from '../src/review/FormReviewPlayer';
import { coachingCue } from '../src/review/formReviewModel';
import { Motion3DPlayer } from '../src/review/Motion3DPlayer';
import { Motion3DResult } from '../src/review/Motion3DResult';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { FormReviewScreen } from '../src/screens/FormReviewScreen';
import { LibraryScreen } from '../src/screens/LibraryScreen';
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';
import { ResultScreen } from '../src/screens/ResultScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import { useAccessStore } from '../src/state/accessStore';
import { useAppStore } from '../src/state/appStore';
import { clearTrainingStoreConfiguration } from '../src/training/store';
import { currentAnalysisPlan } from '../src/vision/motion3d';
import * as providers from '../src/vision/providers';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const capturedAtIso = '2026-09-05T11:00:00.000Z';
type QueryResult = { rows: Record<string, unknown>[] };
interface SoftwareSqlite {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}
const { DatabaseSync } = jest.requireActual<{
  DatabaseSync: new (path: string) => SoftwareSqlite;
}>('node:sqlite');
let sqlite: SoftwareSqlite;
let db: LocalDb;
const mockExecute = jest.fn<Promise<QueryResult>, [string, unknown[]?]>();
const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const mockRefreshAccess = jest.fn(async () => true);
const originalFetch = globalThis.fetch;
const originalBridge = NativeModules.PickleMotion3D;
const originalRefreshAccess = useAccessStore.getState().refreshAccess;
const mounted = new Set<ReactTestRenderer>();
const pendingCleanup = new Set<() => void>();
let permitsSpy: jest.SpyInstance;
let planPracticeSpy: jest.SpyInstance;
let commitPracticeSpy: jest.SpyInstance;
let fusionSpy: jest.SpyInstance;
let syncSpy: jest.SpyInstance;
let reviewSpy: jest.SpyInstance;
let abortSpy: jest.SpyInstance;

type NativeRequest = { uri: string; captureId: string; runId: string };
type NativeReceipt = { json: string; sha256: string };
const bridge = {
  available: true,
  schemaVersion: 1,
  reconstruct: jest.fn<Promise<NativeReceipt>, [NativeRequest]>(),
  cancel: jest.fn<void, [string]>(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

function softwareImport(name = 'software-import'): CapturedClip {
  return {
    uri: `file:///private/Captures/${name}.mov`,
    captureMode: 'imported_video',
    durationMs: 1000,
    fps: 30,
    width: 1080,
    height: 1920,
    capturedAtIso,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

function softwareGuidedClip(): CapturedClip {
  return {
    ...softwareImport('software-record-again'),
    captureMode: 'automatic_pose_trigger',
    trigger: {
      startMs: 0,
      endMs: 1000,
      peakMotionMs: 500,
      confidence: 0.8,
      source: 'temporal_pose_motion',
      modelVersion: 'software-test-only',
    },
    preRollMs: 100,
    postRollMs: 100,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'software-test-only',
      triggerAlgorithmVersion: 'software-test-only',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 30,
      poseFrameCount: 30,
      poseMissingFrameCount: 0,
      trackedDurationMs: 1000,
      meanCanonicalJointVisibility: 0.8,
      meanJointCoverage: 0.8,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 30,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 29,
          meanNormalizedPerSecond: 0.3,
          peakNormalizedPerSecond: 0.8,
        },
      ],
    },
  };
}

/** Contract-valid, invented software samples; never an accuracy benchmark. */
function softwareArtifact(captureId: string): Motion3DArtifact {
  return {
    schemaVersion: 1,
    format: 'pickle.motion-3d.v1',
    role: 'reconstructed_estimate',
    coordinateSystem: 'vision_root_relative',
    axes: 'right_handed_y_up',
    units: 'vision_estimated_meters',
    imageCoordinates: 'normalized_image_top_left',
    uncertainty: 'uncalibrated',
    temporalProcessing: 'none',
    source: {
      captureId,
      videoSha256: 'a'.repeat(64),
      videoByteLength: 1234,
      width: 1080,
      height: 1920,
      durationMs: 1000,
      nominalFrameRate: 30,
      preferredTransform: [1, 0, 0, 1, 0, 0],
      orientationPolicy: 'preferred_track_transform_applied',
      mirroring: 'as_encoded',
    },
    estimator: {
      providerId: 'pose.apple-vision-3d',
      revision: 1,
      osVersion: 'software-test-only',
      modelAsset: 'os_managed',
      modelAssetSha256: null,
      configurationVersion: 'apple-vision-3d-raw-1',
      maxSampleRate: 30,
    },
    frames: [0, 1].map(frameIndex => ({
      frameIndex,
      timestampMs: (frameIndex * 1000) / 30,
      ptsValue: frameIndex,
      ptsTimescale: 30,
      segmentId: 0,
      status: 'estimated',
      observationConfidence: 0.8,
      height: { meters: 1.8, source: 'reference' },
      cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1],
      joints: [
        {
          name: 'root',
          x: 0,
          y: 0,
          z: 0,
          imageX: 0.5,
          imageY: 0.5,
          confidence: null,
          visibility2D: null,
        },
      ],
    })),
  };
}

function softwareReceipt(captureId: string): NativeReceipt {
  // Whitespace is deliberate: storage must retain the exact hashed bytes.
  const json = `\n${JSON.stringify(softwareArtifact(captureId), null, 2)}\n`;
  return { json, sha256: sha256Hex(json) };
}

function softwareMotion(id = 'software-motion'): Motion3DAnalysis {
  const captureId = `${id}-capture`;
  const receipt = softwareReceipt(captureId);
  const built = buildMotion3DAnalysis({
    id,
    captureId,
    createdAtIso: '2026-09-05T12:00:00.000Z',
    capturedAtIso,
    declaredStroke: 'dink',
    declaredCanonical: 'BACKHAND_DINK',
    handedness: 'left',
    artifactJson: receipt.json,
    artifactSha256: receipt.sha256,
  });
  if (!built.ok) throw new Error(built.failure.message);
  return built.value;
}

/** Historical product-row shape, also software-only (not a measured score). */
function softwareLegacy(): ShotAnalysis {
  return {
    id: 'software-legacy',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    phases: [
      {
        key: 'contact',
        startMs: 450,
        representativeMs: 500,
        endMs: 550,
        confidence: 0.8,
      },
    ],
    measurements: [],
    checkpoints: [
      {
        key: 'contact_position',
        score: 48,
        confidence: 0.8,
        band: 'red',
        direction: 'late',
        severity: 0.52,
        applicable: true,
      },
    ],
    overallScore: 7.1,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: 'software-test-only',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

function query(sql: string, params: unknown[] = []): QueryResult {
  return { rows: sqlite.prepare(sql).all(...params) };
}

async function seedCapture(
  captureId: string,
  declared: ShotTypeSlug | null = null,
) {
  const clip = softwareImport(captureId);
  await savePendingCapture(db, captureId, 'unrecognized', clip, declared);
  return clip;
}

async function seedMotion(motion = softwareMotion()) {
  const clip = await seedCapture(
    motion.record.captureId,
    motion.record.declaredStroke,
  );
  await saveMotion3DAnalysis(db, motion, captureDataOwnerScope());
  return { motion, clip };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // Also clean up an early assertion failure before the dependency was entered.
  void promise.catch(() => {});
  pendingCleanup.add(() => reject(new Error('software test cleanup')));
  return { promise, resolve, reject };
}

async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted.add(renderer);
  await settle();
  return renderer;
}

async function unmount(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
  mounted.delete(renderer);
  await settle();
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function textOf(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => [node.props.children].flat(3))
    .filter(child => typeof child === 'string' || typeof child === 'number')
    .join(' ')
    .replace(/\s+/g, ' ');
}

function host(renderer: ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function press(renderer: ReactTestRenderer, labelOrId: string) {
  const node = renderer.root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      (candidate.props.testID === labelOrId ||
        candidate.props.accessibilityLabel === labelOrId ||
        (candidate.type === Button && candidate.props.label === labelOrId)),
  )[0];
  if (!node) throw new Error(`No pressable: ${labelOrId}`);
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

function nativeRequest(index = 0) {
  const input = bridge.reconstruct.mock.calls[index]?.[0];
  if (!input) throw new Error(`Native reconstruction ${index} never started`);
  return input;
}

async function emitProgress(
  runId: string,
  timestampMs: number,
  durationMs = 1000,
) {
  await act(async () => {
    DeviceEventEmitter.emit('PickleMotion3DProgress', {
      runId,
      processedFrames: 3,
      timestampMs,
      durationMs,
    });
  });
  await settle();
}

function expectNoLegacyWork() {
  expect(importedPoseExtractionAvailable).not.toHaveBeenCalled();
  expect(extractImportedPoseSequence).not.toHaveBeenCalled();
  expect(readCaptureArtifact).not.toHaveBeenCalled();
  expect(permitsSpy).not.toHaveBeenCalled();
  expect(fusionSpy).not.toHaveBeenCalled();
  expect(planPracticeSpy).not.toHaveBeenCalled();
  expect(commitPracticeSpy).not.toHaveBeenCalled();
  expect(syncSpy).not.toHaveBeenCalled();
  expect(reviewSpy).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
  for (const table of [
    'local_shot',
    'local_analysis_record',
    'local_session',
    'outbox',
  ]) {
    expect(query(`SELECT * FROM ${table}`).rows).toEqual([]);
  }
}

function expectNoLegacySurface(renderer: ReactTestRenderer) {
  expect(renderer.root.findAllByType(StrokeResult)).toHaveLength(0);
  expect(renderer.root.findAllByType(FormReviewPlayer)).toHaveLength(0);
  expect(renderer.root.findAllByType(ScoreRing)).toHaveLength(0);
  expect(textOf(renderer)).not.toMatch(
    /TECHNIQUE SCORE|DUPR|WHAT THE CAMERA MEASURED|PRIORITY FIX|Contact position scored/,
  );
  expect(textOf(renderer)).not.toContain(
    coachingCue('contact_position', 'late', 'forehand_drive'),
  );
}

async function beginImport() {
  mockRouteParams = { source: 'library' };
  const renderer = await mount(<AnalyzeScreen />);
  await advance(160);
  return renderer;
}

const resultRoutes = [
  { route: 'Result', Screen: ResultScreen, missing: 'Result missing' },
  {
    route: 'ResultDetails',
    Screen: ResultDetailsScreen,
    missing: 'Result missing',
  },
  {
    route: 'FormReview',
    Screen: FormReviewScreen,
    missing: 'Review unavailable',
  },
] as const;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.replaceProperty(
    globalThis as typeof globalThis & { __DEV__: boolean },
    '__DEV__',
    true,
  );
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue('17.5');
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(true);
  NativeModules.PickleMotion3D = bridge;
  bridge.available = true;
  bridge.reconstruct
    .mockReset()
    .mockImplementation(async input => softwareReceipt(input.captureId));
  sqlite = new DatabaseSync(':memory:');
  mockExecute
    .mockReset()
    .mockImplementation(async (sql, params) => query(sql, params));
  jest.mocked(open).mockReturnValue({
    executeSync: query,
    execute: mockExecute,
    close: () => sqlite.close(),
  } as unknown as DB);
  db = getDb();
  setActiveDataOwner(ownerA);
  establishApiSession({
    canonicalAppUserId: ownerA,
    provider: 'apple',
    apiBaseUrl: 'https://software-test.invalid',
    bearerToken: 'software-test-token',
  });
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  useAppStore.setState({ profile: null });
  useAccessStore.setState({
    status: 'ready',
    canonicalAccess: null,
    refreshAccess: mockRefreshAccess,
  });
  jest
    .mocked(importStrokeVideo)
    .mockReset()
    .mockResolvedValue(softwareImport());
  jest
    .mocked(captureStrokeVideo)
    .mockReset()
    .mockResolvedValue(softwareGuidedClip());
  jest.mocked(importedPoseExtractionAvailable).mockReturnValue(true);
  jest.mocked(extractImportedPoseSequence).mockReset();
  jest.mocked(readCaptureArtifact).mockReset();
  mockFetch
    .mockReset()
    .mockRejectedValue(
      new Error('Unexpected network access in software-only test'),
    );
  globalThis.fetch = mockFetch;
  // Call-through observers: dispatch, persistence and presentation are never mocked.
  permitsSpy = jest.spyOn(api, 'createAnalysisPermitClient');
  planPracticeSpy = jest.spyOn(practiceSet, 'planPracticeSet');
  commitPracticeSpy = jest.spyOn(practiceSet, 'commitPracticeSet');
  fusionSpy = jest.spyOn(providers, 'createFusionProviders');
  syncSpy = jest.spyOn(syncRuntime, 'triggerOutboxSync');
  reviewSpy = jest.spyOn(appStoreReview, 'reportScoredAnalysisForReview');
  abortSpy = jest.spyOn(AbortController.prototype, 'abort');
});

afterEach(async () => {
  for (const renderer of [...mounted]) await unmount(renderer);
  await act(async () => {
    for (const cleanup of pendingCleanup) cleanup();
    pendingCleanup.clear();
  });
  await settle();
  await db.execute('SELECT 1');
  db.close();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAccessStore.setState({
    status: 'idle',
    refreshAccess: originalRefreshAccess,
  });
  globalThis.fetch = originalFetch;
  if (originalBridge === undefined) delete NativeModules.PickleMotion3D;
  else NativeModules.PickleMotion3D = originalBridge;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('software-only Analyze to stored 3D Result integration', () => {
  it('auto-analyzes an import, displays only native measured progress, and opens its newly saved Result without legacy work', async () => {
    const job = deferred<NativeReceipt>();
    bridge.reconstruct.mockReturnValueOnce(job.promise);
    const renderer = await beginImport();
    expect(currentAnalysisPlan().engine).toBe('motion_3d');
    expect(importStrokeVideo).toHaveBeenCalledTimes(1);
    expect(captureStrokeVideo).not.toHaveBeenCalled();
    const input = nativeRequest();
    expect(input.uri).toBe(softwareImport().uri);
    expect(textOf(renderer)).toContain('Reconstructing your movement in 3D');
    expect(textOf(renderer)).not.toContain('Which player are you?');
    expect(
      host(renderer, 'stroke-result-analyzing-progress').props
        .accessibilityValue,
    ).toEqual({ min: 0, max: 100 });
    expectNoLegacyWork();
    await advance(2000);
    expect(
      host(renderer, 'stroke-result-analyzing-progress').props
        .accessibilityValue.now,
    ).toBeUndefined();
    await emitProgress('stale-software-run', 900);
    await emitProgress(input.runId, 1200);
    expect(
      host(renderer, 'stroke-result-analyzing-progress').props
        .accessibilityValue.now,
    ).toBeUndefined();
    await emitProgress(input.runId, 250);
    expect(
      host(renderer, 'stroke-result-analyzing-progress').props
        .accessibilityValue,
    ).toEqual({ min: 0, max: 100, now: 25 });
    expect(textOf(renderer)).toContain('25% of recording processed');
    await advance(2000);
    expect(
      host(renderer, 'stroke-result-analyzing-progress').props
        .accessibilityValue.now,
    ).toBe(25);
    await emitProgress(input.runId, 750);
    expect(
      host(renderer, 'stroke-result-analyzing-progress').props
        .accessibilityValue.now,
    ).toBe(75);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(query('SELECT * FROM local_motion_analysis').rows).toEqual([]);

    const receipt = softwareReceipt(input.captureId);
    await act(async () => {
      job.resolve(receipt);
    });
    await settle();
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: input.runId,
    });
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(query('SELECT * FROM local_motion_analysis').rows).toEqual([
      expect.objectContaining({
        owner_key: ownerA,
        id: input.runId,
        capture_id: input.captureId,
        artifact_json: receipt.json,
      }),
    ]);
    expect(query('SELECT status, payload FROM local_capture').rows).toEqual([
      { status: 'analyzed', payload: JSON.stringify(softwareImport()) },
    ]);
    expectNoLegacyWork();
    await unmount(renderer);
    expect(mockRefreshAccess).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    mockRouteParams = { analysisId: input.runId };
    const result = await mount(<ResultScreen />);
    expect(result.root.findByType(Motion3DResult).props.motion.record.id).toBe(
      input.runId,
    );
    host(result, 'motion3d-result');
    expectNoLegacySurface(result);
    expect(DeviceEventEmitter.listenerCount('PickleMotion3DProgress')).toBe(0);
  });

  it('opens a saved Library capture directly, without launching camera or import picker', async () => {
    const captureId = 'software-saved-import';
    const clip = await seedCapture(captureId, 'dink');
    expect(await getPendingCapture(db, captureId)).toMatchObject({
      evidenceStatus: 'valid',
      clip,
    });
    const library = await mount(<LibraryScreen />);
    await press(library, `motion3d-analyze-saved-${captureId}`);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
      captureId,
    });
    await unmount(library);
    mockRouteParams = mockNavigation.navigate.mock.calls[0]![1];
    await mount(<AnalyzeScreen />);
    await advance(200);
    expect(nativeRequest()).toMatchObject({ captureId, uri: clip.uri });
    expect(captureStrokeVideo).not.toHaveBeenCalled();
    expect(importStrokeVideo).not.toHaveBeenCalled();
    expect(query('SELECT id FROM local_capture').rows).toEqual([
      { id: captureId },
    ]);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: nativeRequest().runId,
    });
    expectNoLegacyWork();
  });

  it('default dispatch selects 3D before the legacy pose gate, and saved-capture reanalysis appends a fresh Result without overwriting the first', async () => {
    const captureId = 'software-reanalysis';
    const clip = await seedCapture(captureId, 'dink');
    const first = await runCaptureAnalysis({
      db,
      captureId,
      clip,
      declaredStroke: 'dink',
      declaredCanonical: 'BACKHAND_DINK',
      handedness: 'left',
      cameraView: 'side',
      apiConfig: { baseUrl: '', token: null },
      appVersion: 'software-test-only',
    });
    expect(first.kind).toBe('motion_3d');
    if (first.kind !== 'motion_3d') throw new Error(`Unexpected ${first.kind}`);
    const firstRow = query(
      'SELECT record_json, artifact_json FROM local_motion_analysis WHERE id = ?',
      [first.analysisId],
    ).rows;
    mockRouteParams = { source: 'camera', captureId };
    const renderer = await mount(<AnalyzeScreen />);
    const second = nativeRequest(1);
    expect(second.captureId).toBe(captureId);
    expect(second.runId).not.toBe(first.analysisId);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: second.runId,
    });
    expect(
      query(
        'SELECT record_json, artifact_json FROM local_motion_analysis WHERE id = ?',
        [first.analysisId],
      ).rows,
    ).toEqual(firstRow);
    expect(query('SELECT id FROM local_motion_analysis').rows).toHaveLength(2);
    expect(await loadMotion3DAnalysis(db, first.analysisId)).toEqual(
      first.analysis,
    );
    expect(Object.isFrozen(first.analysis.record)).toBe(true);
    expect(importStrokeVideo).not.toHaveBeenCalled();
    expect(captureStrokeVideo).not.toHaveBeenCalled();
    expectNoLegacyWork();
    await unmount(renderer);
    mockRouteParams = { analysisId: second.runId };
    const result = await mount(<ResultScreen />);
    expect(result.root.findByType(Motion3DResult).props.motion.record.id).toBe(
      second.runId,
    );
  });

  it.each(['motion3d.busy', 'motion3d.timeout'])(
    'retries transient %s against the same saved capture with a new run id, not a new import',
    async code => {
      bridge.reconstruct.mockRejectedValueOnce({
        code,
        message: 'private native detail',
      });
      const retry = deferred<NativeReceipt>();
      bridge.reconstruct.mockReturnValueOnce(retry.promise);
      const renderer = await beginImport();
      const first = nativeRequest();
      expect(textOf(renderer)).toContain('Nothing was rated.');
      expect(textOf(renderer)).not.toContain('private native detail');
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(query('SELECT status FROM local_capture').rows).toEqual([
        { status: 'awaiting_model' },
      ]);
      await press(renderer, 'Try again');
      const second = nativeRequest(1);
      expect(second).toMatchObject({
        uri: first.uri,
        captureId: first.captureId,
      });
      expect(second.runId).not.toBe(first.runId);
      await emitProgress(first.runId, 900);
      expect(
        host(renderer, 'stroke-result-analyzing-progress').props
          .accessibilityValue.now,
      ).toBeUndefined();
      await emitProgress(second.runId, 500);
      expect(
        host(renderer, 'stroke-result-analyzing-progress').props
          .accessibilityValue.now,
      ).toBe(50);
      await act(async () => {
        retry.resolve(softwareReceipt(second.captureId));
      });
      await settle();
      expect(importStrokeVideo).toHaveBeenCalledTimes(1);
      expect(query('SELECT id FROM local_capture').rows).toEqual([
        { id: first.captureId },
      ]);
      expect(query('SELECT id FROM local_motion_analysis').rows).toEqual([
        { id: second.runId },
      ]);
      expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: second.runId,
      });
      expectNoLegacyWork();
    },
  );

  it.each(['Close', 'unmount'] as const)(
    '%s aborts only the active 3D run and discards a late successful native receipt',
    async exit => {
      const job = deferred<NativeReceipt>();
      bridge.reconstruct.mockReturnValueOnce(job.promise);
      const renderer = await beginImport();
      const input = nativeRequest();
      if (exit === 'Close') await press(renderer, 'Close');
      else await unmount(renderer);
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(bridge.cancel).toHaveBeenCalledTimes(1);
      expect(bridge.cancel).toHaveBeenCalledWith(input.runId);
      if (exit === 'Close') {
        expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
        await emitProgress(input.runId, 900);
        expect(
          host(renderer, 'stroke-result-analyzing-progress').props
            .accessibilityValue.now,
        ).toBeUndefined();
      }
      await act(async () => {
        job.resolve(softwareReceipt(input.captureId));
      });
      await settle();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(query('SELECT id FROM local_motion_analysis').rows).toEqual([]);
      expect(query('SELECT status FROM local_capture').rows).toEqual([
        { status: 'awaiting_model' },
      ]);
      expect(DeviceEventEmitter.listenerCount('PickleMotion3DProgress')).toBe(
        0,
      );
      if (exit === 'Close') await unmount(renderer);
      expect(mockRefreshAccess).not.toHaveBeenCalled();
      expectNoLegacyWork();
    },
  );

  it.each(['Close', 'unmount'] as const)(
    '%s does not retrofit a 3D AbortSignal onto an in-flight legacy analysis',
    async exit => {
      jest.replaceProperty(
        globalThis as typeof globalThis & { __DEV__: boolean },
        '__DEV__',
        false,
      );
      const reading = deferred<string>();
      jest.mocked(extractImportedPoseSequence).mockResolvedValue({
        framesWithPose: 1,
        framesTotal: 1,
        poseSequence: {
          schemaVersion: 1,
          format: 'pickle.pose-sequence.v1',
          uri: 'file:///private/Captures/software-legacy.pose.json',
          frameCount: 1,
          sha256: 'b'.repeat(64),
          coordinateSystem: 'normalized_image_top_left',
          poseModelVersion: 'software-test-only',
        },
      });
      jest.mocked(readCaptureArtifact).mockReturnValue(reading.promise);
      const renderer = await beginImport();
      expect(currentAnalysisPlan().engine).toBe('legacy_2d');
      await press(renderer, 'Forehand drive');
      await press(renderer, 'Skip — pick automatically');
      expect(extractImportedPoseSequence).toHaveBeenCalledTimes(1);
      expect(readCaptureArtifact).toHaveBeenCalledTimes(1);
      expect(planPracticeSpy).toHaveBeenCalledTimes(1);
      expect(textOf(renderer)).toContain('Measuring your swing');
      if (exit === 'Close') await press(renderer, 'Close');
      else await unmount(renderer);
      expect(abortSpy).not.toHaveBeenCalled();
      expect(bridge.cancel).not.toHaveBeenCalled();
      expect(bridge.reconstruct).not.toHaveBeenCalled();
      // Deliberate sidecar I/O failure, not a fabricated valid 2D observation.
      await act(async () => {
        reading.reject(new Error('software sidecar read failure'));
      });
      await settle();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      if (exit === 'Close') {
        expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
        await unmount(renderer);
      }
      expect(mockRefreshAccess).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels an A-to-B-to-A account transition and never saves or routes its late 3D result', async () => {
    const job = deferred<NativeReceipt>();
    bridge.reconstruct.mockReturnValueOnce(job.promise);
    const renderer = await beginImport();
    const input = nativeRequest();
    await act(async () => {
      setActiveDataOwner(ownerB);
      setActiveDataOwner(ownerA);
    });
    expect(bridge.cancel).toHaveBeenCalledWith(input.runId);
    await emitProgress(input.runId, 800);
    expect(
      host(renderer, 'stroke-result-analyzing-progress').props
        .accessibilityValue.now,
    ).toBeUndefined();
    await act(async () => {
      job.resolve(softwareReceipt(input.captureId));
    });
    await settle();
    expect(textOf(renderer)).toContain(
      'The account changed during reconstruction',
    );
    expect(query('SELECT * FROM local_motion_analysis').rows).toEqual([]);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expectNoLegacyWork();
  });

  it('refuses another owner’s saved capture before decoding and never opens a replacement picker', async () => {
    setActiveDataOwner(ownerB);
    const captureId = 'software-other-owner';
    await seedCapture(captureId);
    setActiveDataOwner(ownerA);
    mockRouteParams = { source: 'camera', captureId };
    const renderer = await mount(<AnalyzeScreen />);
    await advance(200);
    expect(textOf(renderer)).toContain(
      'This saved recording could not be verified in the current account.',
    );
    expect(bridge.reconstruct).not.toHaveBeenCalled();
    expect(importStrokeVideo).not.toHaveBeenCalled();
    expect(captureStrokeVideo).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(query('SELECT owner_key, status FROM local_capture').rows).toEqual([
      { owner_key: ownerB, status: 'awaiting_model' },
    ]);
  });
});

describe('stored 3D presentation and legacy isolation (software-only)', () => {
  it.each(resultRoutes)(
    '$route resolves the stored 3D record in Release without legacy score/cue/DUPR and preserves Record again intent',
    async ({ route, Screen }) => {
      const { motion, clip } = await seedMotion();
      jest.replaceProperty(
        globalThis as typeof globalThis & { __DEV__: boolean },
        '__DEV__',
        false,
      );
      expect(currentAnalysisPlan()).toMatchObject({
        engine: 'legacy_2d',
        reason: '3d_release_not_approved',
      });
      const evidence = await loadStrokeResultEvidence(db, motion.record.id);
      expect(resolveAnalysisPresentation(evidence)).toEqual({
        kind: 'motion_3d',
        motion,
        clip: { uri: clip.uri, durationMs: 1000 },
      });
      mockRouteParams = { analysisId: motion.record.id };
      const renderer = await mount(<Screen />);
      host(renderer, 'motion3d-result');
      expect(renderer.root.findByType(Motion3DResult).props).toMatchObject({
        motion,
        videoUri: clip.uri,
      });
      expect(renderer.root.findByType(Motion3DPlayer).props).toMatchObject({
        artifact: motion.artifact,
        artifactJson: motion.artifactJson,
        artifactSha256: motion.record.artifactSha256,
        videoUri: clip.uri,
      });
      expect(textOf(renderer)).toContain(
        'Development analysis. No rating used.',
      );
      expectNoLegacySurface(renderer);
      await press(renderer, 'motion3d-record-again');
      expect(peekTryAgainHandoff()).toEqual({
        source: 'camera',
        declaredStroke: 'dink',
        declaredCanonical: 'BACKHAND_DINK',
        auto: false,
        sessionId: null,
      });
      expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
        source: 'camera',
      });
      await press(renderer, 'motion3d-done');
      expect(
        route === 'Result' ? mockNavigation.popToTop : mockNavigation.goBack,
      ).toHaveBeenCalledTimes(1);
      expect(bridge.reconstruct).not.toHaveBeenCalled();
      expectNoLegacyWork();
    },
  );

  it('Record again re-arms Analyze with the exact saved canonical declaration and opens a fresh 3D recording', async () => {
    const { motion } = await seedMotion();
    mockRouteParams = { analysisId: motion.record.id };
    const result = await mount(<ResultScreen />);
    await press(result, 'motion3d-record-again');
    await unmount(result);
    mockRouteParams = mockNavigation.navigate.mock.calls[0]![1];
    await mount(<AnalyzeScreen />);
    await advance(160);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
    expect(importStrokeVideo).not.toHaveBeenCalled();
    const input = nativeRequest();
    expect(input.captureId).not.toBe(motion.record.captureId);
    const fresh = await loadMotion3DAnalysis(db, input.runId);
    expect(fresh?.record).toMatchObject({
      declaredStroke: 'dink',
      declaredCanonical: 'BACKHAND_DINK',
    });
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: input.runId,
    });
    expect(await loadMotion3DAnalysis(db, motion.record.id)).toEqual(motion);
    expectNoLegacyWork();
  });

  it('a stored Library motion-history item opens the canonical Result in Release, not a legacy review route', async () => {
    const { motion } = await seedMotion();
    jest.replaceProperty(
      globalThis as typeof globalThis & { __DEV__: boolean },
      '__DEV__',
      false,
    );
    const library = await mount(<LibraryScreen />);
    host(library, 'motion3d-history');
    await press(library, `motion3d-history-${motion.record.id}`);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Result', {
      analysisId: motion.record.id,
    });
    expect(bridge.reconstruct).not.toHaveBeenCalled();
    await unmount(library);
    mockRouteParams = mockNavigation.navigate.mock.calls[0]![1];
    const result = await mount(<ResultScreen />);
    expect(result.root.findByType(Motion3DResult).props.motion).toEqual(motion);
    expectNoLegacySurface(result);
  });

  it.each([
    'visualization',
    'comparison',
    'coaching',
    'correction',
    'scoring',
  ] as const)(
    'rejects a stored invalid %s capability on all three routes rather than rendering a legacy fallback',
    async capability => {
      const { motion } = await seedMotion();
      const corrupt = {
        ...motion.record,
        capabilities: {
          ...motion.record.capabilities,
          [capability]: 'unapproved',
        },
      };
      await db.execute(
        'UPDATE local_motion_analysis SET record_json = ? WHERE owner_key = ? AND id = ?',
        [JSON.stringify(corrupt), ownerA, motion.record.id],
      );
      const evidence = await loadStrokeResultEvidence(db, motion.record.id);
      expect(resolveAnalysisPresentation(evidence)).toEqual({
        kind: 'missing',
      });
      for (const { Screen, missing } of resultRoutes) {
        mockRouteParams = { analysisId: motion.record.id };
        const renderer = await mount(<Screen />);
        expect(textOf(renderer)).toContain(missing);
        expect(renderer.root.findAllByType(Motion3DResult)).toHaveLength(0);
        expectNoLegacySurface(renderer);
        await unmount(renderer);
      }
      expect(bridge.reconstruct).not.toHaveBeenCalled();
      expectNoLegacyWork();
    },
  );

  it.each([
    { field: 'engine', patch: { engine: 'legacy_2d' } },
    { field: 'purpose', patch: { purpose: 'production' } },
    {
      field: 'visualization',
      patch: { capabilities: { visualization: 'approved' } },
    },
    { field: 'scoring', patch: { capabilities: { scoring: 'approved' } } },
    { field: 'coaching', patch: { capabilities: { coaching: 'approved' } } },
  ])(
    'the shared resolver rejects invalid $field instead of falling through to otherwise usable legacy evidence',
    async ({ patch }) => {
      const { motion } = await seedMotion();
      const evidence = await loadStrokeResultEvidence(db, motion.record.id);
      const legacy = softwareLegacy();
      const invalid = {
        ...motion,
        record: {
          ...motion.record,
          ...patch,
          capabilities: {
            ...motion.record.capabilities,
            ...patch.capabilities,
          },
        },
      } as unknown as Motion3DAnalysis;
      expect(
        resolveAnalysisPresentation({
          ...evidence,
          analysis: legacy,
          record: { id: legacy.id, result: legacy },
          motion3d: invalid,
        }),
      ).toEqual({ kind: 'missing' });
    },
  );

  it.each(['product row', 'record-only row'] as const)(
    'a failing new table cannot break a known legacy Result loaded from a %s',
    async storage => {
      const legacy = softwareLegacy();
      if (storage === 'product row') {
        await db.execute(
          `INSERT INTO local_shot
        (owner_key, id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ownerA,
            legacy.id,
            legacy.shotType,
            capturedAtIso,
            legacy.overallScore,
            legacy.analysisConfidence,
            legacy.resultKind,
            legacy.source,
            JSON.stringify(legacy),
          ],
        );
      } else {
        const record: StrokeResultEvidenceRecord = {
          id: legacy.id,
          result: legacy,
        };
        await db.execute(
          `INSERT INTO local_analysis_record
        (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            ownerA,
            legacy.id,
            'software-historical-capture',
            capturedAtIso,
            'legacy',
            'sm-v1',
            JSON.stringify(record),
          ],
        );
      }
      await db.execute('DROP TABLE local_motion_analysis');
      await expect(
        loadMotion3DAnalysis(db, 'software-missing'),
      ).rejects.toMatchObject({ code: 'motion_3d.storage_failed' });
      mockExecute.mockClear();
      const evidence = await loadStrokeResultEvidence(db, legacy.id);
      expect(resolveAnalysisPresentation(evidence)).toEqual({
        kind: 'legacy_2d',
      });
      expect(evidence.analysis ?? evidence.record?.result).toEqual(legacy);
      mockRouteParams = { analysisId: legacy.id };
      const renderer = await mount(<ResultScreen />);
      host(renderer, 'result-guide-step-score');
      expect(renderer.root.findAllByType(Motion3DResult)).toHaveLength(0);
      expect(renderer.root.findByType(ScoreRing).props.score).toBe(7.1);
      expect(textOf(renderer)).toContain('Contact position scored 48');
      expect(textOf(renderer)).toContain('DUPR');
      expect(
        mockExecute.mock.calls.filter(([sql]) =>
          sql.includes('local_motion_analysis'),
        ),
      ).toEqual([]);
      expect(bridge.reconstruct).not.toHaveBeenCalled();
    },
  );
});
