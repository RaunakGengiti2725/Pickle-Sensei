import React from 'react';
import { Text } from 'react-native';
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
  CaptureQualitySignalsV1,
  CapturedClip,
} from '../src/camera/capture';

/**
 * ATTEMPT EVIDENCE CORRELATION (mobile-analyze-capture::A4).
 *
 * The persisted attempt envelope may rest ONLY on readiness/quality evidence
 * measured inside its own attempt and — for readiness — at or before the
 * stroke. The native camera stamps every event with the capture's id and an
 * emission time; the buffer correlates on both so a readiness frame that
 * drains after the stroke, or a quality event from the previous attempt,
 * can never degrade a valid full-body clip to UNSUPPORTED.
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

// ─── Native camera seam ─────────────────────────────────────────────────────

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
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () =>
      Promise.reject(new Error('library import is out of scope here')),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import {
  attemptCaptureEnvelope,
  createAttemptEvidenceBuffer,
} from '../src/camera/captureEnvelope';
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

function permitServer(): jest.Mock {
  let permitSeq = 0;
  return jest.fn(async (url: string) => {
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
    if (url.includes('/finalize')) return jsonResponse({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

// ─── Recorded-clip fixture (real full-body pose sequence) ───────────────────

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

/** Native clock: every event says which capture emitted it and when. */
const T0 = Date.parse('2026-08-29T18:00:00.000Z');
function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}
function stamp(captureId: string, offsetMs: number) {
  return { captureId, emittedAtIso: at(offsetMs) };
}

function readinessEvent(
  captureId: string,
  offsetMs: number,
  state: CameraReadinessState,
  jointCoverage: number,
): CameraEvent {
  return {
    ...stamp(captureId, offsetMs),
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

function strokeDetectedEvent(captureId: string, offsetMs: number): CameraEvent {
  return {
    ...stamp(captureId, offsetMs),
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
  };
}

function qualitySignals(
  overrides: Partial<CaptureQualitySignalsV1> = {},
): CaptureQualitySignalsV1 {
  return {
    schemaVersion: 1,
    frameWidthPx: 1080,
    frameHeightPx: 1920,
    avgFrameRateFps: 60,
    brightnessMeanLuma: 120,
    laplacianVarianceMedian: 250,
    meanAbsFrameDiff: 2,
    sampledFrameCount: 12,
    ...overrides,
  };
}

function qualityEvent(
  captureId: string,
  offsetMs: number,
  signals: CaptureQualitySignalsV1,
): CameraEvent {
  return { ...stamp(captureId, offsetMs), type: 'capture_quality', signals };
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

interface PersistedEnvelope {
  overall: string;
  dimensions: { dimension: string; status: string }[];
}

function lastPersistedEnvelope(): PersistedEnvelope {
  const inserts = activeDb.calls.filter(call =>
    call.sql.includes('INSERT INTO local_analysis_record'),
  );
  const insert = inserts[inserts.length - 1];
  if (!insert) throw new Error('No persisted analysis record');
  const record = JSON.parse(String(insert.params[6])) as {
    captureEnvelope: PersistedEnvelope | null;
  };
  if (!record.captureEnvelope) throw new Error('No persisted envelope');
  return record.captureEnvelope;
}

function status(envelope: PersistedEnvelope, dimension: string): string {
  const found = envelope.dimensions.find(d => d.dimension === dimension);
  if (!found) throw new Error(`dimension ${dimension} missing`);
  return found.status;
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
  mockNavigation.replace.mockClear();
  (globalThis as { fetch?: unknown }).fetch = permitServer();
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('AnalyzeScreen — attempt evidence is correlated to the attempt and the stroke window', () => {
  it('a readiness read delivered AFTER stroke_detected does not overwrite the swing-time visibility, and the full-body clip is never refused UNSUPPORTED', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const { clip, sidecarJson } = guidedClip('post-stroke-readiness');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();

    emit(readinessEvent('cap-1', 1000, 'ready', 0.93));
    emit(strokeDetectedEvent('cap-1', 2000));
    expect(textOf(renderer)).toContain('Motion captured');
    // A frame already queued on the native vision queue drains after the
    // stroke was committed: the athlete has walked out of frame.
    emit(readinessEvent('cap-1', 2300, 'no_person', 0));
    // The post-stroke frame must not re-open the live readiness surface.
    expect(textOf(renderer)).toContain('Motion captured');
    expect(textOf(renderer)).not.toContain('Step fully into frame');

    capture.resolve(clip);
    await waitFor(
      () =>
        mockNavigation.replace.mock.calls.length > 0 ||
        textOf(renderer).includes('Nothing was rated'),
      'analysis outcome',
    );

    // The real full-body clip scored — it was not refused as UNSUPPORTED.
    expect(textOf(renderer)).not.toContain('Nothing was rated');
    expect(mockNavigation.replace).toHaveBeenCalledWith(
      'Result',
      expect.objectContaining({ analysisId: expect.any(String) }),
    );
    const envelope = lastPersistedEnvelope();
    expect(status(envelope, 'player_visibility')).toBe('SUPPORTED');
    expect(envelope.overall).not.toBe('UNSUPPORTED');
    await act(async () => renderer.unmount());
  });

  it('a capture_quality event belonging to attempt 1 that arrives after attempt 2 started is ignored for attempt 2', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');

    // Attempt 1 (native capture cap-1): the athlete was in frame, the user
    // cancelled before a clip existed.
    const first = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('cap-1', 1000, 'ready', 0.93));
    first.reject(new Error('Capture cancelled by user.'));
    await flush();

    // Attempt 2 (native capture cap-2) starts and sees the athlete.
    const { clip, sidecarJson } = guidedClip('second-attempt');
    mockReadArtifact = async () => sidecarJson;
    const second = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('cap-2', 5000, 'ready', 0.93));
    // A quality summary from the torn-down cap-1 pipeline drains late: a
    // dark frame sample that would be UNSUPPORTED brightness.
    emit(
      qualityEvent('cap-1', 1500, qualitySignals({ brightnessMeanLuma: 10 })),
    );
    // The live guidance for attempt 2 must not adopt it.
    expect(textOf(renderer)).not.toContain('brighter');
    emit(strokeDetectedEvent('cap-2', 6000));
    second.resolve(clip);
    await waitFor(
      () =>
        mockNavigation.replace.mock.calls.length > 0 ||
        textOf(renderer).includes('Nothing was rated'),
      'attempt 2 outcome',
    );

    expect(textOf(renderer)).not.toContain('Nothing was rated');
    expect(mockNavigation.replace).toHaveBeenCalledWith(
      'Result',
      expect.objectContaining({ analysisId: expect.any(String) }),
    );
    const envelope = lastPersistedEnvelope();
    // Brightness was never measured for THIS attempt's clip.
    expect(status(envelope, 'brightness')).toBe('NOT_MEASURED');
    expect(status(envelope, 'player_visibility')).toBe('SUPPORTED');
    await act(async () => renderer.unmount());
  });
});

describe('createAttemptEvidenceBuffer — explicit correlation id and stroke window', () => {
  it('carries an explicit attempt id, binds the native capture id from the first correlated event, and ignores foreign captures', () => {
    const buffer = createAttemptEvidenceBuffer();
    buffer.beginAttempt('attempt-1');
    expect(buffer.attemptId).toBe('attempt-1');
    expect(buffer.captureId).toBeNull();

    expect(
      buffer.noteReadiness(
        { state: 'ready', jointCoverage: 0.93 },
        stamp('cap-1', 1000),
      ),
    ).toBe(true);
    expect(buffer.captureId).toBe('cap-1');

    // Evidence stamped with another capture id never enters this attempt.
    expect(
      buffer.noteReadiness(
        { state: 'no_person', jointCoverage: 0 },
        stamp('cap-other', 1100),
      ),
    ).toBe(false);
    expect(
      buffer.noteQuality(
        qualitySignals({ brightnessMeanLuma: 10 }),
        stamp('cap-other', 1100),
      ),
    ).toBe(false);
    expect(buffer.readiness).toEqual({ state: 'ready', jointCoverage: 0.93 });
    expect(buffer.quality).toBeNull();
  });

  it('compares readiness timestamps against the stroke window: later reads are dropped whether they arrive before or after the stroke event', () => {
    const buffer = createAttemptEvidenceBuffer();
    buffer.beginAttempt('attempt-1');
    buffer.noteReadiness(
      { state: 'ready', jointCoverage: 0.93 },
      stamp('cap-1', 1000),
    );
    // Delivered after the stroke_detected event: rejected.
    expect(buffer.noteStroke(stamp('cap-1', 2000))).toBe(true);
    expect(
      buffer.noteReadiness(
        { state: 'no_person', jointCoverage: 0 },
        stamp('cap-1', 2300),
      ),
    ).toBe(false);
    expect(buffer.readiness).toEqual({ state: 'ready', jointCoverage: 0.93 });

    // Out-of-order delivery: a read MEASURED after the stroke that arrived
    // before the stroke event is dropped once the stroke time is known.
    const reordered = createAttemptEvidenceBuffer();
    reordered.beginAttempt('attempt-2');
    reordered.noteReadiness(
      { state: 'no_person', jointCoverage: 0 },
      stamp('cap-2', 2300),
    );
    reordered.noteStroke(stamp('cap-2', 2000));
    expect(reordered.readiness).toBeNull();
    const verdict = attemptCaptureEnvelope(
      { width: 1080, height: 1920, fps: 60, durationMs: 3200 },
      reordered.quality,
      reordered.readiness,
    );
    expect(
      verdict.dimensions.find(d => d.dimension === 'player_visibility')?.status,
    ).toBe('NOT_MEASURED');
    expect(verdict.overall).not.toBe('UNSUPPORTED');
  });

  it('a new attempt retires the previous capture id, so its late events are rejected even before the new capture is bound', () => {
    const buffer = createAttemptEvidenceBuffer();
    buffer.beginAttempt('attempt-1');
    buffer.noteReadiness(
      { state: 'ready', jointCoverage: 0.93 },
      stamp('cap-1', 1000),
    );
    buffer.beginAttempt('attempt-2');
    expect(buffer.attemptId).toBe('attempt-2');
    expect(buffer.captureId).toBeNull();
    expect(buffer.readiness).toBeNull();

    expect(
      buffer.noteQuality(
        qualitySignals({ brightnessMeanLuma: 10 }),
        stamp('cap-1', 1500),
      ),
    ).toBe(false);
    expect(buffer.captureId).toBeNull();
    expect(buffer.quality).toBeNull();

    expect(buffer.noteQuality(qualitySignals(), stamp('cap-2', 5000))).toBe(
      true,
    );
    expect(buffer.captureId).toBe('cap-2');
  });

  it('sealing the attempt (clip resolved) closes the window for every kind of evidence', () => {
    const buffer = createAttemptEvidenceBuffer();
    buffer.beginAttempt('attempt-1');
    buffer.noteReadiness(
      { state: 'ready', jointCoverage: 0.93 },
      stamp('cap-1', 1000),
    );
    buffer.sealAttempt();
    expect(
      buffer.noteReadiness(
        { state: 'no_person', jointCoverage: 0 },
        stamp('cap-1', 4000),
      ),
    ).toBe(false);
    expect(
      buffer.noteQuality(
        qualitySignals({ brightnessMeanLuma: 10 }),
        stamp('cap-1', 4000),
      ),
    ).toBe(false);
    expect(buffer.readiness).toEqual({ state: 'ready', jointCoverage: 0.93 });
    expect(buffer.quality).toBeNull();
  });
});
