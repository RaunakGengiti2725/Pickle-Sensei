/**
 * ADVERSARIAL PASS 3 / mobile-analyze-capture — AnalyzeScreen mounted with
 * the REAL repository, REAL runCaptureAnalysis and REAL analysis pipeline;
 * only the native camera seam, the SQLite handle and `fetch` are faked.
 *
 * Attacks (against 4d812e1a):
 *  S3  savePendingCapture throws (SQLITE_FULL) after a valid clip → error
 *      stage must be 'capture', no analysis, no permit reservation. Also
 *      documents that the clip URI has no JS-side cleanup path.
 *  S7  Score pressed twice in the same tick, and the zero-touch path calling
 *      scoreCapture itself → exactly one permits.reserve.
 *  +   cancellation mid-flight (header close while the permit reserve is in
 *      flight) → permit accounting.
 *  +   permission denied → nothing persisted, no permit.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type {
  CameraEvent,
  CameraReadinessState,
  CapturedClip,
} from '../../src/camera/capture';

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
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
const mockCancelSpy = jest.fn();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
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

import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import * as captureModule from '../../src/camera/capture';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

const owner = '33333333-3333-4333-8333-333333333333';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

let activeDb: { db: LocalDb; calls: RecordedCall[] };
function faultDb(failWhen: (sql: string) => boolean = () => false): {
  db: LocalDb;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (failWhen(sql)) {
        throw new Error('SQLITE_FULL: database or disk is full (code 13)');
      }
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}
function mockCurrentDb(): LocalDb {
  return activeDb.db;
}

interface PermitServer {
  fetchMock: jest.Mock;
  reserves: number;
  finalized: Array<{ permitId: string; body: unknown }>;
  /** When set, reserve responses are held until `releaseReserves()`. */
  holdReserves: boolean;
  releaseReserves: () => void;
}

function permitServer(): PermitServer {
  const pending: Array<() => void> = [];
  const server: PermitServer = {
    reserves: 0,
    finalized: [],
    holdReserves: false,
    fetchMock: jest.fn(),
    releaseReserves: () => {
      for (const fn of pending.splice(0)) fn();
    },
  };
  server.fetchMock.mockImplementation(
    async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/analysis-permits')) {
        server.reserves += 1;
        const id = `permit-${server.reserves}`;
        const body = {
          permit: {
            id,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: '2026-09-04T20:00:00.000Z',
          },
        };
        if (server.holdReserves) {
          await new Promise<void>(resolve => pending.push(resolve));
        }
        return jsonResponse(body);
      }
      const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
      if (finalize) {
        server.finalized.push({
          permitId: decodeURIComponent(finalize[1]!),
          body: JSON.parse(String(init?.body)),
        });
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  return server;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function guidedClip(
  id: string,
  overrides: Partial<
    Extract<CapturedClip, { captureMode: 'automatic_pose_trigger' }>
  > = {},
): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
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
    ...overrides,
  };
  return { clip, sidecarJson };
}

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

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  )[0];
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = findByLabel(renderer, label);
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

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

const eventBase = () => ({ emittedAtIso: '2026-09-04T12:00:00.000Z' });

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

const sqlOf = () => activeDb.calls.map(c => c.sql.trim());
const shotSyncRows = () =>
  activeDb.calls.filter(
    c => c.sql.includes('INSERT INTO outbox') && c.sql.includes("'shot.sync'"),
  );

/** Every test unmounts in `finally`: a mounted working-phase screen keeps an
 * Animated timing loop alive that otherwise spews after environment
 * teardown. */
async function withScreen(
  body: (renderer: TestRenderer.ReactTestRenderer) => Promise<void>,
) {
  const renderer = await renderScreen();
  try {
    await body(renderer);
  } finally {
    await act(async () => renderer.unmount());
  }
}

let server: PermitServer;

beforeEach(() => {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  activeDb = faultDb();
  mockCameraListeners.clear();
  mockCancelSpy.mockClear();
  mockNavigation.replace.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
  server = permitServer();
  (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('ATTACK S3 — savePendingCapture throws (SQLITE_FULL) after a valid clip', () => {
  it('surfaces stage \'capture\' ("Capture interrupted"), runs no analysis, reserves no permit, and leaves the clip URI orphaned with no JS cleanup path', async () => {
    activeDb = faultDb(sql => sql.includes('INSERT INTO local_capture'));
    await withScreen(async renderer => {
      pressByLabel(renderer, 'Forehand Drive');
      const { clip, sidecarJson } = guidedClip('sqlite-full');
      mockReadArtifact = async () => sidecarJson;
      const capture = deferredCapture();
      pressButton(renderer, 'Open automatic camera');
      await flush();
      driveNativeCaptureSequence();
      capture.resolve(clip);
      await waitFor(
        () => textOf(renderer).includes('Nothing was rated.'),
        'capture error surface',
      );
      const copy = textOf(renderer);
      // stage 'capture' renders the "Capture interrupted" header (stage
      // 'analysis' would render "Analysis stopped").
      expect(copy).toContain('Capture interrupted');
      expect(copy).not.toContain('Analysis stopped');
      expect(copy).toContain('SQLITE_FULL');
      expect(copy).toContain('Try again');

      // No analysis: the only statement attempted is the failed capture insert.
      expect(sqlOf()).toEqual([
        expect.stringContaining('INSERT INTO local_capture'),
      ]);
      expect(sqlOf().some(s => s.includes('local_analysis_record'))).toBe(
        false,
      );
      // No permit: the rating service was never contacted.
      expect(server.fetchMock).not.toHaveBeenCalled();
      expect(server.reserves).toBe(0);
      expect(mockNavigation.replace).not.toHaveBeenCalled();

      // Clip URI leak (documented, not fixable from JS): the clip and its
      // sidecar exist on disk (native wrote them before resolving) but no
      // local_capture row references them and the JS capture module exposes
      // no delete/remove/discard API — nothing in JS can reclaim the files.
      const jsCleanupApi = Object.keys(
        jest.requireActual<typeof captureModule>('../../src/camera/capture'),
      ).filter(name =>
        /delete|remove|discard|purge|cleanup|unlink/i.test(name),
      );
      expect(jsCleanupApi).toEqual([]);
      expect(mockCancelSpy).not.toHaveBeenCalled();
    });
  });

  it('Try again after SQLITE_FULL re-runs the camera; a second SQLITE_FULL still reserves no permit; a healthy retry scores exactly once', async () => {
    let failCaptureInsert = true;
    activeDb = faultDb(
      sql => failCaptureInsert && sql.includes('INSERT INTO local_capture'),
    );
    await withScreen(async renderer => {
      pressByLabel(renderer, 'Forehand Drive');
      const first = guidedClip('full-1');
      mockReadArtifact = async () => first.sidecarJson;
      let capture = deferredCapture();
      pressButton(renderer, 'Open automatic camera');
      await flush();
      driveNativeCaptureSequence();
      capture.resolve(first.clip);
      await waitFor(
        () => textOf(renderer).includes('Capture interrupted'),
        'first failure',
      );

      // Retry #1 — disk still full.
      capture = deferredCapture();
      pressButton(renderer, 'Try again');
      await flush();
      driveNativeCaptureSequence();
      capture.resolve(guidedClip('full-2').clip);
      await waitFor(
        () => textOf(renderer).includes('Capture interrupted'),
        'second failure',
      );
      expect(server.reserves).toBe(0);

      // Retry #2 — space freed.
      failCaptureInsert = false;
      const third = guidedClip('full-3');
      mockReadArtifact = async () => third.sidecarJson;
      capture = deferredCapture();
      pressButton(renderer, 'Try again');
      await flush();
      driveNativeCaptureSequence();
      capture.resolve(third.clip);
      await waitFor(
        () => mockNavigation.replace.mock.calls.length > 0,
        'Result navigation',
      );
      expect(server.reserves).toBe(1);
      expect(
        sqlOf().filter(s => s.startsWith('INSERT INTO local_capture')),
      ).toHaveLength(3);
      // Only the successful attempt promoted a rating.
      expect(shotSyncRows()).toHaveLength(1);
    });
  });
});

describe('ATTACK S7 — duplicate Score presses vs the zero-touch scoreCapture', () => {
  it('zero-touch (declared before capture): scoreCapture is called by run(); the saved-phase Score button never mounts, so only ONE permit is reserved', async () => {
    server.holdReserves = true;
    await withScreen(async renderer => {
      pressByLabel(renderer, 'Forehand Drive');
      const { clip, sidecarJson } = guidedClip('zero-touch');
      mockReadArtifact = async () => sidecarJson;
      const capture = deferredCapture();
      pressButton(renderer, 'Open automatic camera');
      await flush();
      driveNativeCaptureSequence();
      capture.resolve(clip);
      await waitFor(() => server.reserves === 1, 'permit reserve in flight');
      // While the reserve is in flight the screen is in the working phase:
      // there is no Score button to double-press.
      expect(textOf(renderer)).toContain('Measuring your swing');
      expect(findByLabel(renderer, 'Get my Technique Score')).toBeUndefined();
      expect(findByLabel(renderer, 'Analyze with Auto Detect')).toBeUndefined();
      await flush();
      await flush();
      expect(server.reserves).toBe(1);

      act(() => server.releaseReserves());
      await waitFor(
        () => mockNavigation.replace.mock.calls.length > 0,
        'Result navigation',
      );
      expect(server.reserves).toBe(1);
      expect(shotSyncRows()).toHaveLength(1);
    });
  });

  it('manual path (declare AFTER capture): Score pressed 3× in the same tick and once more while the reserve is in flight → exactly one permits.reserve, one record, one outbox row', async () => {
    server.holdReserves = true;
    await withScreen(async renderer => {
      // No declaration → run() does NOT enter the zero-touch branch and the
      // saved phase with its Score button is shown.
      const { clip, sidecarJson } = guidedClip('manual');
      mockReadArtifact = async () => sidecarJson;
      const capture = deferredCapture();
      pressButton(renderer, 'Open automatic camera');
      await flush();
      driveNativeCaptureSequence();
      capture.resolve(clip);
      await waitFor(
        () => textOf(renderer).includes('Capture complete'),
        'saved phase',
      );
      expect(server.reserves).toBe(0);
      pressByLabel(renderer, 'Forehand drive');
      const score = findByLabel(renderer, 'Get my Technique Score');
      if (!score) throw new Error('missing score button');
      const onPress = score.props.onPress as () => void;
      await act(async () => {
        onPress();
        onPress();
        onPress();
      });
      await waitFor(() => server.reserves >= 1, 'reserve');
      // A press while the reserve is still pending, delivered through the
      // saved-phase handler closure (what a touch queued before the phase
      // switched to 'working' would invoke).
      await act(async () => {
        onPress();
      });
      await flush();
      expect(server.reserves).toBe(1);
      act(() => server.releaseReserves());
      await waitFor(
        () => mockNavigation.replace.mock.calls.length > 0,
        'Result navigation',
      );
      expect(server.reserves).toBe(1);
      expect(
        sqlOf().filter(s => s.startsWith('INSERT INTO local_analysis_record')),
      ).toHaveLength(1);
      expect(shotSyncRows()).toHaveLength(1);
      expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    });
  });

  it('Open automatic camera pressed 5× in one tick → one capture, one save, one permit', async () => {
    let captureCalls = 0;
    const { clip, sidecarJson } = guidedClip('multi-open');
    mockReadArtifact = async () => sidecarJson;
    mockCaptureImpl = async () => {
      captureCalls += 1;
      return clip;
    };
    await withScreen(async renderer => {
      pressByLabel(renderer, 'Forehand Drive');
      const open = renderer.root.findAll(
        n =>
          typeof n.props.onPress === 'function' &&
          n.findAll(
            t =>
              t.type === Text &&
              String(t.props.children) === 'Open automatic camera',
          ).length > 0,
      );
      const node = open[open.length - 1]!;
      await act(async () => {
        for (let i = 0; i < 5; i += 1) node.props.onPress();
      });
      await waitFor(
        () => mockNavigation.replace.mock.calls.length > 0,
        'Result navigation',
      );
      expect(captureCalls).toBe(1);
      expect(
        sqlOf().filter(s => s.startsWith('INSERT INTO local_capture')),
      ).toHaveLength(1);
      expect(server.reserves).toBe(1);
    });
  });
});

describe('EXTRA — cancellation mid-flight and permission denial', () => {
  it('header Close while the permit reserve is in flight: the run completes in the background, the rating is persisted, exactly one permit, no navigation from the abandoned screen', async () => {
    server.holdReserves = true;
    await withScreen(async renderer => {
      pressByLabel(renderer, 'Forehand Drive');
      const { clip, sidecarJson } = guidedClip('cancel-mid-flight');
      mockReadArtifact = async () => sidecarJson;
      const capture = deferredCapture();
      pressButton(renderer, 'Open automatic camera');
      await flush();
      driveNativeCaptureSequence();
      capture.resolve(clip);
      await waitFor(() => server.reserves === 1, 'reserve in flight');
      // Working-phase header close: marks the screen abandoned and cancels the
      // (already finished) camera operation.
      const closes = renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Close' &&
          typeof n.props.onPress === 'function',
      );
      expect(closes.length).toBeGreaterThan(0);
      act(() => closes[0]!.props.onPress());
      act(() => server.releaseReserves());
      await waitFor(
        () => sqlOf().some(s => s.startsWith('INSERT INTO outbox')),
        'background completion',
      );
      await flush();
      expect(server.reserves).toBe(1);
      // The scored permit is consumed by shot sync, never finalized by the app.
      expect(server.finalized).toHaveLength(0);
      expect(mockNavigation.replace).not.toHaveBeenCalled();
    });
  });

  it('permission denied: capture rejects → stage capture, nothing persisted, no permit', async () => {
    await withScreen(async renderer => {
      pressByLabel(renderer, 'Forehand Drive');
      const capture = deferredCapture();
      pressButton(renderer, 'Open automatic camera');
      await flush();
      emit(permissionEvent('requesting'));
      emit(permissionEvent('denied'));
      capture.reject(
        new Error('Camera access is turned off for Pickle Sensei.'),
      );
      await flush();
      expect(textOf(renderer)).toContain('Nothing was rated.');
      expect(activeDb.calls).toHaveLength(0);
      expect(server.fetchMock).not.toHaveBeenCalled();
    });
  });
});
