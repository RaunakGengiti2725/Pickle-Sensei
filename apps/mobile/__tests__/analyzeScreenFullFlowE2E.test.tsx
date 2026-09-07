import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import { fail, failure } from '@pickle/shared-types';
import * as captureRunner from '../src/analysis/runCaptureAnalysis';
import * as practiceSets from '../src/analysis/practiceSet';
import * as providerModule from '../src/vision/providers';
import { loadSavedTechniqueConfirmation } from '../src/analysis/savedTechniqueConfirmation';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import type { OriginalAnalysisSnapshot } from '../src/analysis/originalAnalysisSnapshot';
import { useAppStore } from '../src/state/appStore';
import { Button, ScreenHeader } from '../src/design/components';
import { TargetSelector } from '../src/camera/TargetSelector';
import { TechniqueIntentPicker } from '../src/flow/TechniqueIntentPicker';
import { reportScoredAnalysisForReview } from '../src/review/appStoreReview';
import { triggerOutboxSync } from '../src/data/syncRuntime';
import type { LocalDb } from '../src/data/db';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../testSupport/sqlite';
import {
  SIGNED_OUT_DATA_OWNER,
  captureDataOwnerContext,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type {
  CameraEvent,
  CameraReadinessState,
  CapturedClip,
} from '../src/camera/capture';

/**
 * Wave H (h10-stroke-flow-e2e) — the LITERAL guided product flow, mounted:
 * launch → declare (tap / voice / Auto Detect) → open camera → permission →
 * capture-envelope guidance → starting position → athlete lock → Ready →
 * stroke → auto trigger → pre-roll retained → event closes → clip finalizes →
 * analysis → Result navigation with real scored content → Try Again → clean
 * next attempt. Native iOS execution is BLOCKED_EXTERNAL; the native camera
 * seam is driven through its typed event/clip contract while everything from
 * AnalyzeScreen down through the real analysis pipeline runs for real.
 *
 * Fault scenarios: cancel/restart, background/foreground (unmount mid
 * capture), camera interruption, permission denial + re-enable, low storage,
 * network loss, and 10 consecutive Try Again attempts.
 */

// ─── Navigation / environment seams ─────────────────────────────────────────

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
let mockSource: 'camera' | 'library' = 'camera';
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ key: 'analyze-test', params: { source: mockSource } }),
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
    prepareOriginalCaptureAnalysis: jest.fn(
      actual.prepareOriginalCaptureAnalysis,
    ),
    runOriginalCaptureAnalysis: jest.fn(actual.runOriginalCaptureAnalysis),
    reconcileOriginalCaptureAnalysis: jest.fn(
      actual.reconcileOriginalCaptureAnalysis,
    ),
  };
});
jest.mock('../src/analysis/practiceSet', () => {
  const actual = jest.requireActual('../src/analysis/practiceSet');
  return { ...actual, planPracticeSet: jest.fn(actual.planPracticeSet) };
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

// ─── Native camera seam (typed contract, controllable per test) ─────────────

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
const mockCancelSpy = jest.fn();
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
    cancelCameraOperation: (operationId: string) => mockCancelSpy(operationId),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import {
  captureStrokeVideo,
  importStrokeVideo,
  extractImportedPoseSequence,
  verifyCapturedClipCurrentBytes,
} from '../src/camera/capture';
import {
  armTryAgain,
  consumeTryAgainHandoff,
  tryAgainFromResult,
} from '../src/screens/tryAgainHandoff';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import { contactMarkerPresentation } from '../src/components/strokeResultModel';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

const owner = '22222222-2222-4222-8222-222222222222';

let activeDb: ReturnType<typeof createSqliteTestDb>;
function recordingDb() {
  return createSqliteTestDb();
}
function mockCurrentDb(): LocalDb {
  return activeDb.db;
}

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  const reservations = new Map<string, string>();
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      const key = String(JSON.parse(String(init?.body)).idempotencyKey);
      const permitId =
        reservations.get(key) ??
        `66666666-6666-4666-8666-${String(reservations.size + 1).padStart(12, '0')}`;
      reservations.set(key, permitId);
      return jsonResponse({
        permit: {
          id: permitId,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-29T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalized.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalized };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

// ─── Recorded-clip fixture (real generated pose sequence + real sidecar) ────

function guidedClip(id: string): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
  const preRollMs = 2000;
  const postRollMs = 1500;
  const durationMs = window.endMs + preRollMs + postRollMs;
  const sidecarJson = serializePoseSequence({
    ...sequence,
    frames: sequence.frames.map(frame => ({
      ...frame,
      timestampMs: frame.timestampMs + preRollMs,
    })),
  });
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    byteSize: 25,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'native_export',
      algorithm: 'sha256',
      videoFileName: `${id}.mov`,
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
    durationMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs + preRollMs,
      endMs: window.endMs + preRollMs,
      peakMotionMs: window.peakMs + preRollMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
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
      trackedDurationMs: window.endMs,
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
    preRollMs,
    postRollMs,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

// ─── Render / driving helpers ────────────────────────────────────────────────

let lastRenderer: TestRenderer.ReactTestRenderer | null = null;
const mountedScreens = new Set<TestRenderer.ReactTestRenderer>();

async function renderScreen(
  props: React.ComponentProps<typeof AnalyzeScreen> = {},
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen {...props} />);
    mountedScreens.add(renderer);
  });
  lastRenderer = renderer;
  return renderer;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    if (Date.now() > deadline) {
      const visible = lastRenderer ? textOf(lastRenderer) : '';
      throw new Error(`Timed out waiting for ${what}: ${visible ?? ''}`);
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 15));
    });
  }
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  const text = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number')
      return String(node);
    if (Array.isArray(node)) return node.map(text).join('\n');
    if (node && typeof node === 'object' && 'children' in node)
      return text(node.children);
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

/** Presses the design-system Button rendered with this label text. */
function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  act(() => node.props.onPress());
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

function permissionEvent(
  state: 'requesting' | 'granted' | 'denied',
): CameraEvent {
  return { ...eventBase(), type: 'permission', state };
}

function sessionEvent(
  state: 'configured' | 'observing' | 'armed' | 'interrupted',
): CameraEvent {
  return { ...eventBase(), type: 'session', state };
}

function strokeDetectedEvent(confidence: number): CameraEvent {
  return {
    ...eventBase(),
    type: 'stroke_detected',
    startTimestampMs: 2000,
    endTimestampMs: 2700,
    peakMotionTimestampMs: 2400,
    confidence,
    detectionModelVersion: 'temporal-stroke-heuristic-2',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
  };
}

function processingEvent(): CameraEvent {
  return { ...eventBase(), type: 'processing', state: 'preparing_clip' };
}

function deferredCapture() {
  let resolveFn!: (clip: CapturedClip) => void;
  let rejectFn!: (error: Error) => void;
  mockCaptureImpl = () =>
    new Promise<CapturedClip>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
  return {
    resolve: (clip: CapturedClip) => act(() => resolveFn(clip)),
    reject: (error: Error) => act(() => rejectFn(error)),
  };
}

/** The literal on-device sequence the native camera walks through before a
 * clip exists: permission → guidance far/near → starting position → athlete
 * lock (hold_still) → Ready → stroke auto-trigger → clip finalization. */
function driveNativeCaptureSequence() {
  emit(permissionEvent('requesting'));
  emit(permissionEvent('granted'));
  emit(sessionEvent('configured'));
  emit(sessionEvent('observing'));
  emit(readinessEvent('no_person', 0));
  emit(readinessEvent('move_closer', 0.55));
  emit(readinessEvent('full_body_required', 0.7));
  emit(readinessEvent('hold_still', 0.88));
  emit(sessionEvent('armed'));
  emit(readinessEvent('ready', 0.93));
  emit(strokeDetectedEvent(0.86));
  emit(processingEvent());
}

function persistedRecordInserts() {
  return activeDb.calls.filter(call =>
    call.sql.includes('INSERT INTO local_analysis_record'),
  );
}

function lastPersistedRecord(): StrokeResultEvidenceRecord & {
  captureEnvelope?: {
    overall: string;
    dimensions: { dimension: string; status: string }[];
  } | null;
} {
  const inserts = persistedRecordInserts();
  const insert = inserts[inserts.length - 1];
  if (!insert) throw new Error('No persisted analysis record');
  return JSON.parse(String(insert.params[6]));
}

async function completeAttempt(
  renderer: TestRenderer.ReactTestRenderer,
  clipId: string,
  options: { pressOpen?: boolean } = {},
): Promise<string> {
  const { clip, sidecarJson } = guidedClip(clipId);
  mockReadArtifact = async () => sidecarJson;
  const capture = deferredCapture();
  if (options.pressOpen !== false) {
    pressButton(renderer, 'Open automatic camera');
  }
  await flush();
  driveNativeCaptureSequence();
  capture.resolve(clip);
  const before = mockNavigation.replace.mock.calls.length;
  await waitFor(
    () => mockNavigation.replace.mock.calls.length > before,
    `Result navigation for ${clipId}`,
  );
  const call = mockNavigation.replace.mock.calls.at(-1)!;
  expect(call[0]).toBe('Result');
  return call[1].analysisId as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSource = 'camera';
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
    .mocked(captureRunner.reconcileOriginalCaptureAnalysis)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof captureRunner>(
        '../src/analysis/runCaptureAnalysis',
      ).reconcileOriginalCaptureAnalysis,
    );
  jest
    .mocked(verifyCapturedClipCurrentBytes)
    .mockReset()
    .mockImplementation(async value => ({
      status: 'verified-current-bytes',
      comparedExpectation: (value as CapturedClip).nativeMediaIdentity!,
    }));
  jest.mocked(extractImportedPoseSequence).mockReset();
  jest.mocked(importStrokeVideo).mockReset();
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  activeDb = recordingDb();
  mockCameraListeners.clear();
  mockCancelSpy.mockClear();
  mockNavigation.replace.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
  consumeTryAgainHandoff(); // never leak a handoff between tests
  const { fetchMock } = permitServer();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedScreens) renderer.unmount();
    mountedScreens.clear();
    lastRenderer = null;
  });
  closeSqliteTestDatabases();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({ profile: null });
  jest.restoreAllMocks();
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

// ─── SCENARIO: first attempt, tap-declared, full literal flow ───────────────

describe('first attempt — tap-declared full flow to a real Result', () => {
  it('launch → tap declare → permission → guidance → lock → Ready → stroke → auto trigger → clip → analysis → Result with real scored content', async () => {
    const renderer = await renderScreen();
    // Launch surface is the ready phase with the declaration picker.
    expect(textOf(renderer)).toContain('AUTOMATIC CAPTURE');

    // TAP path: the player declares the technique on the real chip grid.
    pressByLabel(renderer, 'Forehand Drive');

    const { clip, sidecarJson } = guidedClip('first-attempt');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();

    // Camera permission then starting-position guidance, straight from the
    // native event contract; each stage must reach the working surface.
    emit(permissionEvent('requesting'));
    emit(permissionEvent('granted'));
    emit(sessionEvent('observing'));
    emit(readinessEvent('no_person', 0));
    expect(textOf(renderer)).toContain('Step fully into frame');
    // Live capture-envelope guidance reacts to the measured visibility.
    expect(textOf(renderer)).toContain(
      'Keep your full body visible inside the corners.',
    );

    emit(readinessEvent('move_closer', 0.55));
    expect(textOf(renderer)).toContain('Move a little closer');

    // Athlete lock: the camera asks for stillness while locking on.
    emit(readinessEvent('hold_still', 0.88));
    expect(textOf(renderer)).toContain('Hold still while the camera locks on');

    // Ready — the automatic trigger is armed, no shutter exists.
    emit(sessionEvent('armed'));
    emit(readinessEvent('ready', 0.93));
    expect(textOf(renderer)).toContain('Ready — swing when comfortable');

    // Stroke: the temporal trigger fires and the event closes.
    emit(strokeDetectedEvent(0.86));
    expect(textOf(renderer)).toContain('Motion captured');
    emit(processingEvent());
    expect(textOf(renderer)).toContain('Saving the private clip');

    // Clip finalizes with the pre-roll retained.
    capture.resolve(clip);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );

    // Pre-roll/post-roll retained on the persisted capture row.
    const pendingInsert = activeDb.calls.find(call =>
      call.sql.includes('INSERT INTO local_capture'),
    );
    expect(pendingInsert).toBeDefined();
    const storedClip = JSON.parse(String(pendingInsert!.params[10]));
    expect(storedClip.preRollMs).toBe(2000);
    expect(storedClip.postRollMs).toBe(1500);
    expect(storedClip.poseSequence.sha256).toBe(
      clip.captureMode === 'automatic_pose_trigger'
        ? clip.poseSequence!.sha256
        : '',
    );

    // The declaration was persisted as a USER statement.
    const declaredUpdate = activeDb.calls.find(call =>
      call.sql.includes('SET declared_stroke'),
    );
    expect(declaredUpdate).toBeDefined();
    expect(declaredUpdate!.params).toContain('forehand_drive');

    // REAL analysis content reached the Result — not a UI shell.
    const [route, params] = mockNavigation.replace.mock.calls[0]!;
    expect(route).toBe('Result');
    expect(typeof params.analysisId).toBe('string');
    const record = lastPersistedRecord();
    expect(record.result).not.toBeNull();
    expect(record.result!.overallScore).not.toBeNull();
    expect(record.result!.checkpoints.length).toBeGreaterThan(0);
    expect(record.result!.phases.length).toBeGreaterThan(0);
    expect(record.result!.timestamps.startMs).toBe(clip.trigger!.startMs);
    expect(record.result!.timestamps.endMs).toBe(clip.trigger!.endMs);
    expect(record.strokeIntent!.declaredStroke).toBe('forehand_drive');
    expect(record.strokeIntent!.resolutionBasis).toBe('declared');
    // Contact evidence is never an unlabeled fabrication: either an explicit
    // status (estimated/abstained) or honestly absent — on-device fusion
    // records carry no contact estimate, and the Result marker gate renders
    // absence as "Exact contact not established" rather than drawing a marker.
    if (record.contact != null) {
      expect(['estimated', 'abstained']).toContain(record.contact.status);
    } else {
      const marker = contactMarkerPresentation(record.contact);
      expect(marker.kind).toBe('not_established');
      expect(marker.caption).toContain('Exact contact not established');
    }
    // The attempt-time capture envelope rode along with measured values.
    expect(record.captureEnvelope).toBeTruthy();
    const visibility = record.captureEnvelope!.dimensions.find(
      d => d.dimension === 'player_visibility',
    );
    expect(visibility?.status).toBe('SUPPORTED');

    // The scored rating entered the durable shot + outbox path.
    expect(
      activeDb.calls.some(call =>
        call.sql.includes('INSERT OR REPLACE INTO local_shot'),
      ),
    ).toBe(true);
    expect(
      activeDb.calls.some(call => call.sql.includes('INSERT INTO outbox')),
    ).toBe(true);

    await act(async () => renderer.unmount());
  });
});

// ─── SCENARIO: voice + Auto Detect declaration paths ────────────────────────

describe('voice and Auto Detect declaration paths', () => {
  it('voice: a dictated phrase resolves through the registry and the run scores as declared', async () => {
    const renderer = await renderScreen();
    const field = renderer.root.findByType(TextInput);
    act(() => field.props.onChangeText('forehand drive'));
    // The resolved chip is now selected; the run proceeds zero-touch.
    const analysisId = await completeAttempt(renderer, 'voice-attempt');
    expect(analysisId).toBeTruthy();
    const record = lastPersistedRecord();
    expect(record.strokeIntent!.declaredStroke).toBe('forehand_drive');
    expect(record.strokeIntent!.resolutionBasis).toBe('declared');
    await act(async () => renderer.unmount());
  });

  it('Auto Detect: an armed AUTO run never fabricates a declaration — outcome is the honest classifier surface', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Auto detect');

    const { clip, sidecarJson } = guidedClip('auto-attempt');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    driveNativeCaptureSequence();
    capture.resolve(clip);

    await waitFor(
      () => textOf(renderer).includes('Confirm technique'),
      'unscored confirmation surface',
    );
    const record = lastPersistedRecord();
    expect(record).toMatchObject({
      kind: 'needs_technique_confirmation',
      result: null,
    });
    expect(activeDb.count('local_shot', owner)).toBe(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    // The declaration column stays empty: predictions are never declarations.
    expect(record.strokeIntent!.declaredStroke).toBeNull();
    expect(
      activeDb.calls.some(call => call.sql.includes('SET declared_stroke')),
    ).toBe(false);
    expect(['abstained', 'predicted_family', 'predicted_l3']).toContain(
      record.strokeIntent!.resolutionBasis,
    );
    await act(async () => renderer.unmount());
  });
});

// ─── SCENARIO: 10 repeated attempts through the real Try Again loop ─────────

describe('10 repeated attempts', () => {
  it('first attempt plus 9 Try Again re-arms: every attempt is a clean, distinct, real analysis', async () => {
    const analysisIds: string[] = [];
    let renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    analysisIds.push(await completeAttempt(renderer, 'attempt-1'));

    for (let attempt = 2; attempt <= 10; attempt += 1) {
      // Exactly what ResultScreen's TRY AGAIN does with the durable record.
      const record = lastPersistedRecord();
      armTryAgain(tryAgainFromResult(record, null));
      await act(async () => renderer.unmount());
      renderer = await renderScreen();
      // The re-arm auto-launches the camera (160ms timer) — no press needed.
      const { clip, sidecarJson } = guidedClip(`attempt-${attempt}`);
      mockReadArtifact = async () => sidecarJson;
      const capture = deferredCapture();
      await waitFor(
        () => textOf(renderer).includes('Opening camera'),
        `auto relaunch for attempt ${attempt}`,
      );
      driveNativeCaptureSequence();
      capture.resolve(clip);
      const before = mockNavigation.replace.mock.calls.length;
      await waitFor(
        () => mockNavigation.replace.mock.calls.length > before,
        `Result for attempt ${attempt}`,
      );
      analysisIds.push(
        mockNavigation.replace.mock.calls.at(-1)![1].analysisId as string,
      );
    }

    // Ten distinct real analyses, ten capture rows, ten scored records —
    // and the declaration survived every re-arm without mutation.
    expect(new Set(analysisIds).size).toBe(10);
    expect(persistedRecordInserts()).toHaveLength(10);
    expect(
      activeDb.calls.filter(call =>
        call.sql.includes('INSERT INTO local_capture'),
      ),
    ).toHaveLength(10);
    for (const insert of persistedRecordInserts()) {
      const record = JSON.parse(String(insert.params[6]));
      expect(record.strokeIntent!.declaredStroke).toBe('forehand_drive');
      expect(record.result?.overallScore).not.toBeNull();
    }
    // No stale handoff remains armed after the loop.
    expect(consumeTryAgainHandoff()).toBeNull();
    await act(async () => renderer.unmount());
  });
});

// ─── SCENARIO: interruption / cancel / background / permission / faults ─────

describe('interrupted and cancelled attempts', () => {
  it('user cancel returns to the ready surface with NOTHING persisted', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('no_person', 0));
    capture.reject(new Error('Capture cancelled by user.'));
    await flush();
    expect(textOf(renderer)).toContain('AUTOMATIC CAPTURE'); // back to ready
    expect(activeDb.calls).toHaveLength(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('cancel → restart: the next attempt completes cleanly end to end', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const first = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    first.reject(new Error('Capture cancelled by user.'));
    await flush();
    const analysisId = await completeAttempt(renderer, 'post-cancel');
    expect(analysisId).toBeTruthy();
    expect(persistedRecordInserts()).toHaveLength(1);
    await act(async () => renderer.unmount());
  });

  it('closing the working screen cancels the native operation before navigating away', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('ready', 0.9));
    // The working surface header close = user backgrounding/aborting.
    const closeNodes = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Close' &&
        typeof n.props.onPress === 'function',
    );
    expect(closeNodes.length).toBeGreaterThan(0);
    act(() => closeNodes[0]!.props.onPress());
    expect(mockCancelSpy).toHaveBeenCalled();
    expect(mockNavigation.goBack).toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('closing during reservation cancels the uncommitted analysis and releases only its original hold', async () => {
    const { fetchMock, finalized } = permitServer();
    let reserveStarted = false;
    let finishReservation!: () => void;
    const reservationGate = new Promise<void>(resolve => {
      finishReservation = resolve;
    });
    (globalThis as { fetch?: unknown }).fetch = async (
      url: string,
      init?: RequestInit,
    ) => {
      if (url.endsWith('/v1/analysis-permits')) {
        reserveStarted = true;
        await reservationGate;
      }
      return fetchMock(url, init);
    };
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const { clip, sidecarJson } = guidedClip('close-during-analysis');
    mockReadArtifact = async () => sidecarJson;
    mockCaptureImpl = async () => clip;
    pressButton(renderer, 'Open automatic camera');
    await waitFor(() => reserveStarted, 'permit reservation');
    pressByLabel(renderer, 'Close');
    await act(async () => renderer.unmount());
    finishReservation();
    await waitFor(() => {
      const marker = activeDb.calls.find(call =>
        call.sql.includes("SET state = 'released'"),
      );
      return (
        marker !== undefined &&
        activeDb.calls.some(
          call =>
            call.transaction === marker.transaction && call.sql === 'COMMIT',
        )
      );
    }, 'original hold release after screen close');
    await flush();

    expect(activeDb.count('local_capture', owner)).toBe(1);
    expect(activeDb.count('analysis_logical_operations', owner)).toBe(1);
    expect(activeDb.count('analysis_execution_attempts', owner)).toBe(1);
    expect(activeDb.count('analysis_run_journal', owner)).toBe(0);
    expect(activeDb.count('local_analysis_record', owner)).toBe(0);
    expect(activeDb.count('local_shot', owner)).toBe(0);
    expect(activeDb.count('local_session', owner)).toBe(0);
    expect(activeDb.count('outbox', owner)).toBe(0);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.endsWith('/v1/analysis-permits'),
      ),
    ).toHaveLength(1);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(finalized).toEqual([{ outcome: 'cancelled', ratingId: null }]);
  });

  it('does not save a late native capture into a newly selected account', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await act(async () =>
      setActiveDataOwner('33333333-3333-4333-8333-333333333333'),
    );
    // The reactive epoch guard hides the old capture before its await settles.
    expect(textOf(renderer)).toContain('no longer open in its bound account');
    capture.resolve(guidedClip('previous-owner').clip);
    await flush();

    expect(activeDb.calls).toHaveLength(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('backgrounding that unmounts the screen mid-capture cancels the native operation', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await act(async () => renderer.unmount());
    expect(mockCancelSpy).toHaveBeenCalledTimes(1);
    expect(activeDb.calls).toHaveLength(0);
  });
});

describe('camera interruption, permission denial, low storage, network loss', () => {
  async function failCapture(message: string) {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(sessionEvent('interrupted'));
    capture.reject(new Error(message));
    await flush();
    return renderer;
  }

  it('camera interruption surfaces an honest error — nothing rated — and Try again recovers', async () => {
    const renderer = await failCapture(
      'The camera session was interrupted by the system.',
    );
    expect(textOf(renderer)).toContain('Nothing was rated.');
    expect(textOf(renderer)).toContain('interrupted by the system');
    expect(activeDb.calls).toHaveLength(0);

    // Recovery: the error surface's Try again runs a clean full attempt.
    const { clip, sidecarJson } = guidedClip('post-interruption');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferredCapture();
    pressButton(renderer, 'Try again');
    await flush();
    driveNativeCaptureSequence();
    capture.resolve(clip);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result after interruption recovery',
    );
    expect(lastPersistedRecord().result?.overallScore).not.toBeNull();
    await act(async () => renderer.unmount());
  });

  it('permission denial is surfaced honestly; re-enabling permissions lets the next run complete', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const denied = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(permissionEvent('requesting'));
    emit(permissionEvent('denied'));
    denied.reject(
      new Error(
        'Camera permission was denied. Enable camera access in Settings.',
      ),
    );
    await flush();
    expect(textOf(renderer)).toContain('Nothing was rated.');
    expect(textOf(renderer)).toContain('Camera permission was denied');
    expect(activeDb.calls).toHaveLength(0);

    // Permission re-enabled: the retry completes the full flow.
    const { clip, sidecarJson } = guidedClip('post-permission');
    mockReadArtifact = async () => sidecarJson;
    const retry = deferredCapture();
    pressButton(renderer, 'Try again');
    await flush();
    driveNativeCaptureSequence();
    retry.resolve(clip);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result after permission re-enable',
    );
    expect(lastPersistedRecord().result?.overallScore).not.toBeNull();
    await act(async () => renderer.unmount());
  });

  it('low storage fails the attempt loudly with nothing persisted and no fake rating', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    capture.reject(
      new Error('Not enough storage available to save the capture.'),
    );
    await flush();
    expect(textOf(renderer)).toContain('Nothing was rated.');
    expect(textOf(renderer)).toContain('Not enough storage');
    expect(activeDb.calls).toHaveLength(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('network loss during analysis: the capture is kept, the failure is honest, and no rating/outbox is fabricated', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const { clip, sidecarJson } = guidedClip('network-loss');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    driveNativeCaptureSequence();
    capture.resolve(clip);
    await waitFor(
      () => textOf(renderer).includes('Check saved analysis'),
      'original-only network recovery surface',
    );
    expect(textOf(renderer)).not.toMatch(/Nothing was rated|Upgrade to Pro/);
    // The real capture survived locally…
    expect(
      activeDb.calls.some(call =>
        call.sql.includes('INSERT INTO local_capture'),
      ),
    ).toBe(true);
    // …but nothing was scored, synced, or invented.
    expect(persistedRecordInserts()).toHaveLength(0);
    expect(
      activeDb.calls.some(call => call.sql.includes('INSERT INTO outbox')),
    ).toBe(false);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});

// ─── REGRESSION: no cross-attempt readiness/quality carry-over ──────────────

describe('attempt isolation of live readiness evidence', () => {
  it('a stale readiness snapshot from a previous attempt never contaminates the next attempt’s persisted envelope', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');

    // Attempt 1: the camera saw the athlete (ready, 0.93) but the user
    // cancelled before any clip existed.
    const first = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('ready', 0.93));
    first.reject(new Error('Capture cancelled by user.'));
    await flush();

    // Attempt 2: the native layer produces a clip WITHOUT any readiness
    // event reaching JS. Its recorded swing carries visibility 0.9, so the
    // persisted envelope uses that evidence — not attempt 1's 0.93.
    const { clip, sidecarJson } = guidedClip('isolated-attempt');
    mockReadArtifact = async () => sidecarJson;
    const second = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    second.resolve(clip);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result for the isolated attempt',
    );
    const record = lastPersistedRecord();
    const visibility = record.captureEnvelope!.dimensions.find(
      d => d.dimension === 'player_visibility',
    );
    expect(visibility).toMatchObject({ status: 'SUPPORTED', measured: 0.9 });
    await act(async () => renderer.unmount());
  });
});

// W03 exercises the mounted screen through REAL preparation, immutable SQLite
// snapshots, attempt admission/recovery, inference and final product writes.
// Camera/extraction/current-byte comparison and HTTP are explicit test seams;
// these synthetic fixtures do not certify native runtime or release authority.
describe('W03 original saved-analysis retry UI', () => {
  const otherOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherOrigin = 'https://other-api.test';
  const originalProfile = {
    skillLevel: 'intermediate',
    handedness: 'right' as const,
    goal: 'drives',
    biggestProblem: 'control',
    focusCheckpoint: 'preparation' as const,
  };

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
  async function startGuided(
    id = 'retry-original',
    options: {
      auto?: boolean;
      settle?: boolean;
      changeClip?: (clip: CapturedClip) => void;
    } = {},
  ) {
    useAppStore.setState({ profile: originalProfile });
    const data = guidedClip(id);
    options.changeClip?.(data.clip);
    mockReadArtifact = async () => data.sidecarJson;
    mockCaptureImpl = async () => data.clip;
    const renderer = await renderScreen();
    pressByLabel(renderer, options.auto ? 'Auto detect' : 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    if (options.settle !== false) await settled();
    else await flush();
    return { renderer, ...data };
  }
  function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
      resolve = done;
    });
    return { promise, resolve };
  }
  function importedFixture(id = 'retry-import') {
    const { sequence, window } = generateSwingSequence();
    const sidecar = serializePoseSequence(sequence);
    const clip: CapturedClip = {
      uri: `file:///captures/${id}.mov`,
      captureMode: 'imported_video',
      capturedAtIso: '2026-08-29T18:00:00.000Z',
      durationMs: window.endMs,
      width: sequence.video.width,
      height: sequence.video.height,
      fps: sequence.video.fps,
      byteSize: 25,
      nativeMediaIdentity: {
        ...guidedClip(id).clip.nativeMediaIdentity!,
        origin: 'import_copy',
      },
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    };
    const poseSequence = {
      schemaVersion: 1 as const,
      format: 'pickle.pose-sequence.v1' as const,
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left' as const,
      poseModelVersion: sequence.producedBy.modelVersion,
    };
    return {
      clip,
      sidecar,
      extraction: {
        poseSequence,
        framesWithPose: sequence.frames.length,
        framesTotal: sequence.frames.length,
      },
    };
  }
  async function openImport(id: string) {
    mockSource = 'library';
    const data = importedFixture(id);
    jest.mocked(importStrokeVideo).mockResolvedValue(data.clip);
    mockReadArtifact = async () => data.sidecar;
    const renderer = await renderScreen();
    await waitFor(
      () => textOf(renderer).includes('Which stroke was this?'),
      'saved imported clip',
    );
    pressByLabel(renderer, 'Forehand drive');
    return { renderer, ...data };
  }
  function logical() {
    const row = activeDb.native
      .prepare('SELECT * FROM analysis_logical_operations WHERE owner_key = ?')
      .get(owner);
    expect(row).toBeDefined();
    return {
      ...row!,
      operation_id: String(row!.operation_id),
      analysis_id: String(row!.analysis_id),
      snapshot: JSON.parse(
        String(row!.original_settings),
      ) as OriginalAnalysisSnapshot,
    };
  }
  function attempts() {
    return activeDb.native
      .prepare(
        'SELECT * FROM analysis_execution_attempts WHERE owner_key = ? ORDER BY attempt_ordinal',
      )
      .all(owner);
  }
  function reservationKeys(fetchMock: jest.Mock) {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/analysis-permits'))
      .map(([, init]) => JSON.parse(String(init.body)).idempotencyKey);
  }
  function changeBinding(change: string) {
    if (change.startsWith('owner')) setActiveDataOwner(otherOwner);
    establishApiSession({
      canonicalAppUserId: change.startsWith('owner') ? otherOwner : owner,
      apiBaseUrl: change.startsWith('origin')
        ? otherOrigin
        : 'https://api.test',
      bearerToken: 'other-test-token',
      provider: 'apple',
    });
    if (change.endsWith('ABA')) {
      setActiveDataOwner(owner);
      establishApiSession({
        canonicalAppUserId: owner,
        apiBaseUrl: 'https://api.test',
        bearerToken: 'returned-test-token',
        provider: 'apple',
      });
    }
  }

  it('technical failure retries one saved clip/logical definition with the exact predecessor; double taps coalesce', async () => {
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
    const { renderer, clip } = await startGuided();
    expect(activeDb.count('analysis_logical_operations', owner)).toBe(1);
    expect(textOf(renderer)).toContain('Retry saved analysis');
    expect(textOf(renderer)).toContain('Record another clip');
    const original = logical();
    const failed = attempts()[0]!;
    expect(failed).toMatchObject({
      state: 'released',
      release_outcome: 'failed',
      technical_failure: 'inference_technical',
    });
    const retry = action(renderer, 'Retry saved analysis');
    await act(async () => {
      useAppStore.setState({
        profile: {
          ...originalProfile,
          handedness: 'left',
          focusCheckpoint: 'athletic_base',
        },
      });
    });
    act(() => {
      retry();
      retry();
    });
    await settled();
    const next = attempts();
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      state: 'committed',
      predecessor_operation_id: failed.operation_id,
      attempt_ordinal: 2,
    });
    expect(
      jest
        .mocked(captureRunner.runOriginalCaptureAnalysis)
        .mock.calls.map(([input]) => ({
          operationId: input.operationId,
          predecessorAttemptId: input.predecessorAttemptId,
        })),
    ).toEqual([
      { operationId: original.operation_id, predecessorAttemptId: undefined },
      {
        operationId: original.operation_id,
        predecessorAttemptId: failed.operation_id,
      },
    ]);
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
    expect(importStrokeVideo).not.toHaveBeenCalled();
    expect(practiceSets.planPracticeSet).toHaveBeenCalledTimes(1);
    expect(captureRunner.prepareOriginalCaptureAnalysis).toHaveBeenCalledTimes(
      1,
    );
    expect(logical().snapshot).toEqual(original.snapshot);
    expect(logical().snapshot.clip.uri).toBe(clip.uri);
    expect(activeDb.count('local_capture', owner)).toBe(1);
    expect(activeDb.count('local_analysis_record', owner)).toBe(1);
    expect(activeDb.count('outbox', owner)).toBe(2);
    expect(lastPersistedRecord().result?.sessionId).toBe(
      original.snapshot.sessionId,
    );
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: original.analysis_id,
    });
    act(() => retry()); // A retained predecessor handler cannot retry the winner.
    await flush();
    expect(captureRunner.runOriginalCaptureAnalysis).toHaveBeenCalledTimes(2);
  });

  it('persists import settings/target/practice BEFORE extraction fails and retries the saved movie, never the picker', async () => {
    mockSource = 'library';
    useAppStore.setState({ profile: originalProfile });
    const { clip: imported, sidecar, extraction } = importedFixture();
    jest.mocked(importStrokeVideo).mockResolvedValue(imported);
    jest
      .mocked(extractImportedPoseSequence)
      .mockImplementationOnce(async () => {
        expect(logical().snapshot.clip.poseSequence).toBeUndefined();
        expect(logical().snapshot.practiceSet?.sessionId).toBeTruthy();
        throw new Error('Native decoder temporarily unavailable');
      })
      .mockResolvedValue(extraction);
    mockReadArtifact = async () => sidecar;
    const renderer = await renderScreen();
    await waitFor(
      () => textOf(renderer).includes('Which stroke was this?'),
      'saved imported clip',
    );
    pressByLabel(renderer, 'Forehand drive');
    const target = {
      point: { x: 0.48, y: 0.57 },
      selectedAtIso: '2026-08-29T18:01:00.000Z',
    };
    const selector = renderer.root.findByType(TargetSelector);
    act(() => selector.props.onConfirm(target));
    await settled();
    expect(textOf(renderer)).toContain('Retry saved analysis');
    const original = logical();
    expect(original).toMatchObject({
      current_attempt_id: null,
      observation_seal: null,
    });
    expect(original.snapshot.targetSeed).toEqual(target);
    expect(attempts()).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await act(async () => {
      useAppStore.setState({
        profile: {
          ...originalProfile,
          handedness: 'left',
          focusCheckpoint: 'athletic_base',
        },
      });
    });
    act(() => action(renderer, 'Retry saved analysis')());
    await settled();
    expect(importStrokeVideo).toHaveBeenCalledTimes(1);
    expect(captureStrokeVideo).not.toHaveBeenCalled();
    expect(extractImportedPoseSequence).toHaveBeenCalledTimes(2);
    for (const call of jest.mocked(extractImportedPoseSequence).mock.calls) {
      expect(call[0].uri).toBe(imported.uri);
      expect(call[1]).toEqual(target.point);
    }
    expect(logical().snapshot).toEqual(original.snapshot);
    expect(practiceSets.planPracticeSet).toHaveBeenCalledTimes(1);
    expect(captureRunner.prepareOriginalCaptureAnalysis).toHaveBeenCalledTimes(
      1,
    );
    expect(attempts()).toHaveLength(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: original.analysis_id,
    });
  });

  it('unknown reservation only reconciles its original key; released technical proof enables a separate explicit retry', async () => {
    const server = permitServer();
    let lost = false;
    const fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const response = await server.fetchMock(url, init);
        if (url.endsWith('/v1/analysis-permits') && !lost) {
          lost = true;
          throw new TypeError('Lost reserve acknowledgement');
        }
        return response;
      },
    );
    globalThis.fetch = fetch;
    const { renderer } = await startGuided('lost-reserve-ui');
    expect(textOf(renderer)).toContain('Check saved analysis');
    expect(textOf(renderer)).not.toMatch(
      /Nothing was rated|Upgrade to Pro|Retry saved analysis|Record another clip/,
    );
    const original = logical();
    const check = action(renderer, 'Check saved analysis');
    await act(async () => {
      check();
      check();
    });
    await flush();
    expect(
      captureRunner.reconcileOriginalCaptureAnalysis,
    ).toHaveBeenCalledTimes(1);
    expect(captureRunner.runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
    expect(new Set(reservationKeys(fetch)).size).toBe(1);
    expect(attempts()).toHaveLength(1);
    expect(textOf(renderer)).toContain('Retry saved analysis');
    expect(server.finalized).toEqual([{ outcome: 'failed', ratingId: null }]);
    act(() => action(renderer, 'Retry saved analysis')());
    await settled();
    expect(new Set(reservationKeys(fetch)).size).toBe(2);
    expect(attempts()).toHaveLength(2);
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: original.analysis_id,
    });
  });

  it('unknown commit holds without refund or upsell, then replays the same committed score without another review or inference', async () => {
    const server = permitServer();
    globalThis.fetch = server.fetchMock;
    activeDb.failCommitOnce('after');
    activeDb.observeStatements(call => {
      if (call.sql.includes('SET final_record_id ='))
        activeDb.failStatementOnce('FROM local_analysis_record r');
    });
    const { renderer } = await startGuided('lost-commit-ui');
    expect(textOf(renderer)).toContain('Check saved analysis');
    expect(textOf(renderer)).not.toMatch(
      /Nothing was rated|Upgrade to Pro|Record another clip/,
    );
    expect(server.finalized).toEqual([]);
    expect(activeDb.count('local_shot', owner)).toBe(1);
    const original = logical();
    activeDb.observeStatements(null);
    act(() => action(renderer, 'Check saved analysis')());
    await settled();
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: original.analysis_id,
    });
    expect(pipeline.analyzeCapture).toHaveBeenCalledTimes(1);
    expect(reservationKeys(server.fetchMock)).toHaveLength(1);
    expect(activeDb.count('outbox', owner)).toBe(2);
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    expect(
      await jest
        .mocked(captureRunner.runOriginalCaptureAnalysis)
        .mock.results.at(-1)!.value,
    ).toMatchObject({ replayed: true });
  });

  it('lost preparation acknowledgement keeps its chosen logical reference and never prepares from today’s settings again', async () => {
    activeDb.failCommitOnce('after', 'INSERT INTO analysis_logical_operations');
    const { renderer } = await startGuided('lost-preparation-ui');
    expect(textOf(renderer)).toContain('Check saved analysis');
    expect(activeDb.count('analysis_logical_operations', owner)).toBe(1);
    const original = logical();
    expect(attempts()).toHaveLength(0);
    act(() => action(renderer, 'Check saved analysis')());
    await flush();
    expect(textOf(renderer)).toContain('Retry saved analysis');
    act(() => action(renderer, 'Retry saved analysis')());
    await settled();
    expect(captureRunner.prepareOriginalCaptureAnalysis).toHaveBeenCalledTimes(
      1,
    );
    expect(logical().operation_id).toBe(original.operation_id);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: original.analysis_id,
    });
  });

  it.each(['legacy', 'mismatch', 'unavailable'] as const)(
    'fresh byte comparison %s holds with no permit and cannot certify the saved clip',
    async status => {
      jest.mocked(verifyCapturedClipCurrentBytes).mockResolvedValue({ status });
      const { renderer } = await startGuided(`bytes-${status}`);
      expect(textOf(renderer)).toContain('saved analysis');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
      expect(activeDb.count('analysis_logical_operations', owner)).toBe(1);
      expect(attempts()).toHaveLength(0);
      act(() => action(renderer, 'Retry saved analysis')());
      await settled();
      expect(verifyCapturedClipCurrentBytes).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
      expect(mockNavigation.replace).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'owner_ABA', 'origin', 'origin_ABA', 'unmount'])(
    'retained saved-retry/close/new-capture actions are inert after %s',
    async change => {
      jest
        .mocked(pipeline.analyzeCapture)
        .mockResolvedValueOnce(
          fail(
            failure(
              'permanent',
              'scorer.provider_crash',
              'Temporary inference failure',
            ),
          ),
        );
      const { renderer } = await startGuided(`stale-${change}`);
      const retry = action(renderer, 'Retry saved analysis');
      const another = action(renderer, 'Record another clip');
      const close = renderer.root.findByType(ScreenHeader).props.onClose;
      if (change === 'unmount') await act(async () => renderer.unmount());
      else await act(async () => changeBinding(change));
      const nativeCalls = jest.mocked(captureStrokeVideo).mock.calls.length;
      const runs = jest.mocked(captureRunner.runOriginalCaptureAnalysis).mock
        .calls.length;
      act(() => {
        retry();
        another();
        close();
      });
      await flush();
      expect(captureStrokeVideo).toHaveBeenCalledTimes(nativeCalls);
      expect(captureRunner.runOriginalCaptureAnalysis).toHaveBeenCalledTimes(
        runs,
      );
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(mockNavigation.goBack).not.toHaveBeenCalled();
      expect(mockNavigation.navigate).not.toHaveBeenCalled();
      expect(triggerOutboxSync).not.toHaveBeenCalled();
    },
  );

  it.each(['owner_ABA', 'origin_ABA'])(
    'a late native result and retained ready action after %s cannot save or start work',
    async change => {
      const renderer = await renderScreen();
      pressByLabel(renderer, 'Forehand Drive');
      const start = action(renderer, 'Open automatic camera');
      const picker = renderer.root.findByType(TechniqueIntentPicker).props
        .onChange;
      const capture = deferredCapture();
      act(() => start());
      await flush();
      await act(async () => changeBinding(change));
      capture.resolve(guidedClip(`late-${change}`).clip);
      await flush();
      act(() => {
        start();
        picker(null);
      });
      await flush();
      expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
      expect(activeDb.count('local_capture', owner)).toBe(0);
      expect(
        captureRunner.prepareOriginalCaptureAnalysis,
      ).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
    },
  );

  it('ordinary bearer rotation and equivalent normalized origin keep the saved retry live', async () => {
    jest
      .mocked(pipeline.analyzeCapture)
      .mockResolvedValueOnce(
        fail(
          failure(
            'permanent',
            'scorer.provider_crash',
            'Temporary inference failure',
          ),
        ),
      );
    const { renderer } = await startGuided('rotated-session-ui');
    const original = logical();
    await act(async () => {
      establishApiSession({
        canonicalAppUserId: owner,
        apiBaseUrl: 'https://api.test/',
        bearerToken: 'rotated-test-bearer',
        provider: 'apple',
      });
    });
    expect(textOf(renderer)).toContain('Retry saved analysis');
    act(() => action(renderer, 'Retry saved analysis')());
    await settled();
    expect(logical().snapshot).toEqual(original.snapshot);
    expect(JSON.stringify(logical().snapshot)).not.toMatch(
      /token-1|rotated-test-bearer/,
    );
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: original.analysis_id,
    });
  });

  it('Record another clip is an explicit new capture, while retained retry callbacks cannot interfere with it', async () => {
    jest
      .mocked(pipeline.analyzeCapture)
      .mockResolvedValueOnce(
        fail(
          failure(
            'permanent',
            'scorer.provider_crash',
            'Temporary inference failure',
          ),
        ),
      );
    const { renderer } = await startGuided('separate-original-ui');
    const first = logical();
    const retry = action(renderer, 'Retry saved analysis');
    const another = action(renderer, 'Record another clip');
    const nextCapture = deferredCapture();
    const next = guidedClip('explicit-new-clip-ui');
    mockReadArtifact = async () => next.sidecarJson;
    act(() => {
      another();
      another();
      retry();
    });
    await flush();
    expect(captureStrokeVideo).toHaveBeenCalledTimes(2);
    expect(captureRunner.runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
    nextCapture.resolve(next.clip);
    await settled();
    expect(activeDb.count('local_capture', owner)).toBe(2);
    expect(activeDb.count('analysis_logical_operations', owner)).toBe(2);
    expect(captureRunner.prepareOriginalCaptureAnalysis).toHaveBeenCalledTimes(
      2,
    );
    const secondRun = jest.mocked(captureRunner.runOriginalCaptureAnalysis).mock
      .calls[1]![0];
    expect(secondRun.operationId).not.toBe(first.operation_id);
    expect(secondRun.predecessorAttemptId).toBeUndefined();
    const rows = activeDb.native
      .prepare(
        'SELECT original_settings FROM analysis_logical_operations WHERE operation_id = ?',
      )
      .get(first.operation_id);
    expect(JSON.parse(String(rows?.original_settings))).toEqual(first.snapshot);
    expect(attempts().map(attempt => attempt.predecessor_operation_id)).toEqual(
      [null, null],
    );
    expect(activeDb.count('local_shot', owner)).toBe(1);
    act(() => retry());
    expect(captureRunner.runOriginalCaptureAnalysis).toHaveBeenCalledTimes(2);
  });

  it('an unclassified pipeline throw stays held even after release; an old acknowledgement is not retry approval', async () => {
    jest
      .mocked(pipeline.analyzeCapture)
      .mockRejectedValueOnce(new Error('Unclassified failure'));
    const { renderer } = await startGuided('unclassified-ui');
    expect(attempts()[0]).toMatchObject({
      state: 'released',
      release_outcome: 'failed',
      technical_failure: null,
    });
    expect(textOf(renderer)).toContain('Check saved analysis');
    expect(textOf(renderer)).not.toMatch(
      /Retry saved analysis|Record another clip|Nothing was rated|Upgrade to Pro/,
    );
    act(() => action(renderer, 'Check saved analysis')());
    await flush();
    expect(attempts()).toHaveLength(1);
    expect(captureRunner.runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
    expect(pipeline.analyzeCapture).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).toContain('Check saved analysis');
  });

  it('a changed model stays held and never recomputes the original definition; the original policy can later retry', async () => {
    jest
      .mocked(pipeline.analyzeCapture)
      .mockResolvedValueOnce(
        fail(
          failure(
            'permanent',
            'scorer.provider_crash',
            'Temporary inference failure',
          ),
        ),
      );
    const { renderer } = await startGuided('model-hold-ui');
    const original = logical();
    const model = jest
      .spyOn(providerModule, 'createFusionProviders')
      .mockReturnValue({
        kind: 'unavailable',
        reason: 'Different model installation',
      });
    const keys = reservationKeys(globalThis.fetch as jest.Mock);
    act(() => action(renderer, 'Retry saved analysis')());
    await settled();
    expect(attempts()).toHaveLength(1);
    expect(reservationKeys(globalThis.fetch as jest.Mock)).toEqual(keys);
    expect(logical().snapshot).toEqual(original.snapshot);
    expect(captureRunner.prepareOriginalCaptureAnalysis).toHaveBeenCalledTimes(
      1,
    );
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    model.mockRestore();
    act(() => action(renderer, 'Retry saved analysis')());
    await settled();
    expect(attempts()).toHaveLength(2);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: original.analysis_id,
    });
  });

  it('missing native creation expectation is read-only, never filled in or sent through legacy scoring', async () => {
    const { renderer } = await startGuided('missing-identity-ui', {
      changeClip: clip => {
        delete clip.nativeMediaIdentity;
      },
    });
    expect(logical().snapshot.clip.nativeMediaIdentity).toBeUndefined();
    expect(textOf(renderer)).toContain(
      'no complete original file or model proof',
    );
    expect(textOf(renderer)).not.toContain('Retry saved analysis');
    expect(verifyCapturedClipCurrentBytes).not.toHaveBeenCalled();
    expect(captureRunner.runCaptureAnalysis).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(attempts()).toHaveLength(0);
  });

  it('a pose-less legacy capture keeps its unavailable flow instead of manufacturing an original operation', async () => {
    const { renderer } = await startGuided('legacy-poseless-ui', {
      changeClip: clip => {
        delete clip.poseSequence;
        delete clip.nativeMediaIdentity;
      },
    });
    expect(textOf(renderer)).toContain('predates pose-sequence recording');
    expect(textOf(renderer)).not.toContain('Retry saved analysis');
    expect(captureRunner.runCaptureAnalysis).toHaveBeenCalledTimes(1);
    expect(captureRunner.prepareOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(verifyCapturedClipCurrentBytes).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('completed no-charge AUTO reopens through its saved-confirmation loader and keeps original practice/profile on explicit continuation', async () => {
    const { renderer } = await startGuided('original-auto-reopen-ui', {
      auto: true,
    });
    const original = logical();
    expect(textOf(renderer)).toContain('Confirm technique');
    expect(textOf(renderer)).not.toContain('Retry saved analysis');
    expect(attempts()[0]).toMatchObject({
      state: 'released',
      release_outcome: 'low_confidence',
    });
    const loaded = await loadSavedTechniqueConfirmation({
      db: activeDb.db,
      ownerContext: captureDataOwnerContext(),
      captureId: original.snapshot.captureId,
      apiOrigin: original.snapshot.apiOrigin,
    });
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready')
      throw new Error('Expected the verified saved confirmation');
    await act(async () => {
      renderer.unmount();
      useAppStore.setState({
        profile: {
          ...originalProfile,
          handedness: 'left',
          focusCheckpoint: 'athletic_base',
        },
      });
    });
    const reopened = await renderScreen({
      savedTechniqueConfirmation: loaded.saved,
      savedConfirmationStatus: loaded.kind,
    });
    expect(textOf(reopened)).toContain('Confirm technique');
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
    expect(captureRunner.runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
    const earlyConfirm = action(reopened, 'Confirm technique');
    act(() => earlyConfirm());
    expect(captureRunner.runCaptureAnalysis).not.toHaveBeenCalled();
    pressByLabel(reopened, 'Forehand Drive');
    act(() => action(reopened, 'Confirm technique')());
    await settled();
    const confirmed = jest.mocked(captureRunner.runCaptureAnalysis).mock
      .calls[0]![0];
    expect(confirmed).toMatchObject({
      captureId: original.snapshot.captureId,
      sessionId: original.snapshot.sessionId,
      practiceSet: original.snapshot.practiceSet,
      appVersion: original.snapshot.appVersion,
      handedness: original.snapshot.handedness,
      cameraView: original.snapshot.cameraView,
      focusCheckpoint: original.snapshot.focusCheckpoint,
      techniqueConfirmation: { analysisId: original.analysis_id },
    });
    expect(practiceSets.planPracticeSet).toHaveBeenCalledTimes(1);
    expect(captureRunner.prepareOriginalCaptureAnalysis).toHaveBeenCalledTimes(
      1,
    );
    expect(attempts()).toHaveLength(1);
    expect(activeDb.count('analysis_run_journal', owner)).toBe(1);
    expect(activeDb.count('local_analysis_record', owner)).toBe(2);
    expect(activeDb.count('local_shot', owner)).toBe(1);
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(importStrokeVideo).not.toHaveBeenCalled();
    expect(extractImportedPoseSequence).not.toHaveBeenCalled();
  });

  it.each(['owner', 'owner_ABA', 'origin', 'origin_ABA', 'unmount'])(
    'late A inference after %s cannot publish, navigate, share, or cancel B’s new native operation',
    async change => {
      const hold = gate<void>();
      let inferenceStarted = false;
      const actual = jest.requireActual<typeof pipeline>(
        '@pickle/analysis-pipeline',
      ).analyzeCapture;
      jest
        .mocked(pipeline.analyzeCapture)
        .mockImplementationOnce(async (...args) => {
          const result = await actual(...args);
          inferenceStarted = true;
          await hold.promise;
          return result;
        });
      const { renderer } = await startGuided(`late-inference-${change}`, {
        settle: false,
      });
      await waitFor(() => inferenceStarted, 'A inference');
      const aRequest = jest.mocked(captureRunner.runOriginalCaptureAnalysis)
        .mock.calls[0]![0];
      const aPromise = jest.mocked(captureRunner.runOriginalCaptureAnalysis)
        .mock.results[0]!.value;
      const staleClose = renderer.root.findByType(ScreenHeader).props.onClose;
      if (change === 'unmount') await act(async () => renderer.unmount());
      else await act(async () => changeBinding(change));
      expect(aRequest.execution.signal.aborted).toBe(true);
      const b = await renderScreen();
      pressByLabel(b, 'Forehand Drive');
      const captureB = deferredCapture();
      const bData = guidedClip(`new-b-${change}`);
      mockReadArtifact = async () => bData.sidecarJson;
      pressButton(b, 'Open automatic camera');
      await flush();
      const bNative = jest.mocked(captureStrokeVideo).mock.calls.at(-1)![0]!;
      const cancelsBefore = mockCancelSpy.mock.calls.length;
      await act(async () => {
        hold.resolve(undefined);
        await aPromise;
        staleClose();
      });
      await flush();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(mockNavigation.goBack).not.toHaveBeenCalled();
      expect(triggerOutboxSync).not.toHaveBeenCalled();
      expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
      expect(mockCancelSpy).toHaveBeenCalledTimes(cancelsBefore);
      expect(bNative.signal?.aborted).toBe(false);
      expect(
        activeDb.native
          .prepare(
            'SELECT final_record_id FROM analysis_logical_operations WHERE operation_id = ?',
          )
          .get(aRequest.operationId)?.final_record_id,
      ).toBeNull();
      captureB.resolve(bData.clip);
      await settled();
      expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
      expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
      const shots = activeDb.native
        .prepare('SELECT owner_key, id FROM local_shot')
        .all();
      expect(shots).toHaveLength(1);
      expect(shots[0]?.owner_key).toBe(change === 'owner' ? otherOwner : owner);
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: shots[0]?.id,
      });
    },
  );

  it.each(['owner_ABA', 'origin_ABA', 'unmount'])(
    'original import extraction is cancelled after %s; late pose/events cannot write or authorize',
    async change => {
      const data = await openImport(`late-import-${change}`);
      const hold = gate<typeof data.extraction>();
      jest.mocked(extractImportedPoseSequence).mockReturnValue(hold.promise);
      act(() => data.renderer.root.findByType(TargetSelector).props.onSkip());
      await waitFor(
        () => jest.mocked(extractImportedPoseSequence).mock.calls.length === 1,
        'original extraction',
      );
      const extractionOptions = jest.mocked(extractImportedPoseSequence).mock
        .calls[0]![2]!;
      emit({
        type: 'import_pose_extraction',
        state: 'extracting',
        progress: 0.88,
        captureId: 'stale-other-pass',
        emittedAtIso: '2026-08-29T18:00:00.000Z',
      });
      expect(textOf(data.renderer)).not.toContain('88%');
      if (change === 'unmount') await act(async () => data.renderer.unmount());
      else await act(async () => changeBinding(change));
      expect(extractionOptions.signal?.aborted).toBe(true);
      await act(async () => hold.resolve(data.extraction));
      await settled();
      expect(importStrokeVideo).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(attempts()).toHaveLength(0);
      const row = activeDb.native
        .prepare('SELECT payload FROM local_capture WHERE owner_key = ?')
        .get(owner);
      expect(JSON.parse(String(row?.payload)).poseSequence).toBeUndefined();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
    },
  );

  it.each(['selection', 'owner_ABA', 'origin_ABA', 'unmount'])(
    'retained target selection after %s cannot start extraction, preparation, or a permit',
    async change => {
      const { renderer } = await openImport(`stale-selector-${change}`);
      const selector = renderer.root.findByType(TargetSelector).props;
      if (change === 'selection') pressByLabel(renderer, 'Backhand drive');
      else if (change === 'unmount') await act(async () => renderer.unmount());
      else await act(async () => changeBinding(change));
      act(() => {
        selector.onConfirm({
          point: { x: 0.2, y: 0.3 },
          selectedAtIso: '2026-08-29T18:01:00.000Z',
        });
        selector.onSkip();
      });
      await flush();
      expect(
        captureRunner.prepareOriginalCaptureAnalysis,
      ).not.toHaveBeenCalled();
      expect(extractImportedPoseSequence).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(importStrokeVideo).toHaveBeenCalledTimes(1);
      const row = activeDb.native
        .prepare('SELECT target_seed FROM local_capture WHERE owner_key = ?')
        .get(owner);
      expect(row?.target_seed).toBeNull();
    },
  );

  it('retained ready callbacks after unmount cannot open camera or picker, and all execution leases are disposed', async () => {
    const asserted = jest.spyOn(
      OriginalAnalysisExecution.prototype,
      'assertCurrent',
    );
    const disposed = jest.spyOn(OriginalAnalysisExecution.prototype, 'dispose');
    const renderer = await renderScreen();
    const open = action(renderer, 'Open automatic camera');
    const picker = renderer.root.findByType(TechniqueIntentPicker).props
      .onChange;
    await act(async () => renderer.unmount());
    act(() => {
      open();
      picker(null);
    });
    await flush();
    expect(captureStrokeVideo).not.toHaveBeenCalled();
    expect(importStrokeVideo).not.toHaveBeenCalled();
    expect(captureRunner.prepareOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(asserted).toHaveBeenCalled();
    for (const lease of new Set(asserted.mock.contexts))
      expect(disposed.mock.contexts).toContain(lease);
  });
});
