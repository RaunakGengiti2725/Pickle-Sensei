import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));
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
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () =>
      Promise.reject(new Error('library import is out of scope here')),
    cancelCameraOperation: () => mockCancelSpy(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
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

interface RecordedCall {
  sql: string;
  params: unknown[];
}

let activeDb: { db: LocalDb; calls: RecordedCall[] };
function recordingDb(): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}
function mockCurrentDb(): LocalDb {
  return activeDb.db;
}

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  let permitSeq = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      permitSeq += 1;
      return jsonResponse({
        permit: {
          id: `permit-${permitSeq}`,
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
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
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
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
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
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

// ─── Render / driving helpers ────────────────────────────────────────────────

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
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
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 15));
    });
  }
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
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

/** A user cancel as the native bridge rejects it: typed by `code`. */
function userCancel(): Error {
  return Object.assign(new Error('Camera capture was canceled.'), {
    code: 'camera.cancelled',
  });
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
    call.sql.includes('local_analysis_record'),
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

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
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
      () =>
        mockNavigation.replace.mock.calls.length > 0 ||
        textOf(renderer).includes('AUTO-DETECTED') ||
        textOf(renderer).includes('RATING NOT CONSUMED'),
      'auto outcome surface',
    );
    const record = lastPersistedRecord();
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
    capture.reject(userCancel());
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
    first.reject(userCancel());
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
      () => textOf(renderer).includes('Nothing was rated.'),
      'honest network-loss surface',
    );
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
    first.reject(userCancel());
    await flush();

    // Attempt 2: the native layer produces a clip WITHOUT any readiness
    // event reaching JS. Visibility was never measured for THIS clip, so the
    // persisted envelope must say NOT_MEASURED — not attempt 1's 0.93.
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
    expect(visibility?.status).toBe('NOT_MEASURED');
    await act(async () => renderer.unmount());
  });
});
