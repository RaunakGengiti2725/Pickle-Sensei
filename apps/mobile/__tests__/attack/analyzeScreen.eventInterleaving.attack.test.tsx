/**
 * ADVERSARIAL PASS 3 — AnalyzeScreen event interleavings (mounted).
 *
 * Scenarios (baseline 4d812e1a):
 *  S1  import_pose_extraction{extracting, progress:0.9} WITHOUT captureId
 *      after the run latched a different native id → the bar must ignore it.
 *  S2  readiness{no_person} AFTER stroke_detected but BEFORE
 *      captureStrokeVideo resolves → the persisted attempt envelope's
 *      player_visibility must not block a real full-body clip.
 *  S6  imported clip: extraction succeeds, updateCaptureClipPayload throws →
 *      the run must still score on the in-memory clip; the persisted
 *      capture payload (what Form Review later reads) lacks the sidecar.
 *
 * Everything below AnalyzeScreen runs for real (runCaptureAnalysis, the
 * vision providers, the repository SQL against a recording db, the permit
 * client against a fetch mock). The native camera seam is driven through
 * its typed event contract — Linux/Jest, NOT Apple runtime evidence.
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
  ImportedPoseExtraction,
} from '../../src/camera/capture';

// ─── Navigation / environment seams ─────────────────────────────────────────

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = { source: 'camera' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));
jest.mock('../../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));

// ─── Native camera seam (typed contract, controllable per test) ─────────────

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
let mockImportImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('import mock not configured'));
let mockExtractImpl: () => Promise<ImportedPoseExtraction> = () =>
  Promise.reject(new Error('extract mock not configured'));
let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () => mockImportImpl(),
    cancelCameraOperation: jest.fn(),
    importedPoseExtractionAvailable: () => true,
    extractImportedPoseSequence: () => mockExtractImpl(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { TargetSelector } from '../../src/camera/TargetSelector';
import { consumeTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

const owner = '22222222-2222-4222-8222-222222222222';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

let activeDb: { db: LocalDb; calls: RecordedCall[] };
/** SQL fragments whose execution must throw (fault injection). */
let failingSql: string[] = [];

function recordingDb(): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      for (const fragment of failingSql) {
        if (sql.includes(fragment)) {
          throw new Error(`SQLITE_FULL: injected failure for ${fragment}`);
        }
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

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
      meanCanonicalJointVisibility: 0.95,
      meanJointCoverage: 0.95,
      minimumJointCoverage: 0.9,
      // A REAL full-body clip: every frame had the whole body in frame.
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

function importedClipWithoutSidecar(id: string): CapturedClip {
  return {
    uri: `file:///private/var/mobile/${id}.mov`,
    durationMs: 4200,
    fps: 30,
    width: 1920,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

function extractionFor(id: string): {
  extraction: ImportedPoseExtraction;
  sidecarJson: string;
} {
  const { sequence } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  return {
    sidecarJson,
    extraction: {
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: `file:///private/var/mobile/${id}.pose.json`,
        frameCount: sequence.frames.length,
        sha256: sha256Hex(sidecarJson),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
      },
      framesWithPose: sequence.frames.length,
      framesTotal: sequence.frames.length,
    },
  };
}

// ─── Driving helpers ─────────────────────────────────────────────────────────

async function renderScreen(source: 'camera' | 'library') {
  mockRouteParams = { source };
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

/** Rendered TEXT content only — style objects (e.g. width '100%') excluded. */
function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('');
    const json = node as { children?: unknown[] };
    return (json.children ?? []).map(collect).join('\n');
  };
  return collect(renderer.toJSON());
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

const eventBase = () => ({ emittedAtIso: '2026-08-29T18:00:00.000Z' });

function readinessEvent(
  state: CameraReadinessState,
  jointCoverage: number,
): CameraEvent {
  return {
    ...eventBase(),
    type: 'readiness',
    state,
    poseConfidence: state === 'no_person' ? 0 : 0.9,
    jointCoverage,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
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

function extractionEvent(
  state: 'extracting' | 'completed' | 'failed',
  options: { progress?: number; captureId?: string; atIso: string },
): CameraEvent {
  return {
    type: 'import_pose_extraction',
    state,
    ...(options.progress !== undefined ? { progress: options.progress } : {}),
    ...(options.captureId !== undefined
      ? { captureId: options.captureId }
      : {}),
    emittedAtIso: options.atIso,
  };
}

function progressBarNode(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.accessibilityRole === 'progressbar',
  );
  if (!node) throw new Error('No progressbar rendered');
  return node;
}

function deferred<T>(assign: (impl: () => Promise<T>) => void) {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  assign(
    () =>
      new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      }),
  );
  return {
    resolve: (value: T) => act(() => resolveFn(value)),
    reject: (error: Error) => act(() => rejectFn(error)),
  };
}

function persistedRecordInserts() {
  return activeDb.calls.filter(call =>
    call.sql.includes('local_analysis_record'),
  );
}

function lastPersistedRecord(): {
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

/** What `local_capture.payload` holds after the run (INSERT, then any UPDATE
 * that did NOT throw). This is exactly what Form Review later reads. */
function persistedCapturePayload(): CapturedClip | null {
  let payload: CapturedClip | null = null;
  for (const call of activeDb.calls) {
    if (call.sql.includes('INSERT INTO local_capture')) {
      const json = call.params.find(
        p => typeof p === 'string' && p.startsWith('{"uri"'),
      );
      if (typeof json === 'string') payload = JSON.parse(json);
    } else if (call.sql.includes('UPDATE local_capture SET payload')) {
      const threw = failingSql.some(f => call.sql.includes(f));
      if (!threw) payload = JSON.parse(String(call.params[0]));
    }
  }
  return payload;
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
  failingSql = [];
  mockCameraListeners.clear();
  mockNavigation.replace.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
  consumeTryAgainHandoff();
  const { fetchMock } = permitServer();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

// ═════════════════════════════════════════════════════════════════════════════
// S1 — extraction progress event WITHOUT captureId after a different id latched
// ═════════════════════════════════════════════════════════════════════════════

describe('S1 — import_pose_extraction without captureId after a different id latched', () => {
  async function armImportedExtraction(clipId: string) {
    mockImportImpl = async () => importedClipWithoutSidecar(clipId);
    const extraction = deferred<ImportedPoseExtraction>(impl => {
      mockExtractImpl = impl;
    });
    const renderer = await renderScreen('library');
    // Library imports auto-launch after a short arming delay (real timers).
    await waitFor(
      () =>
        renderer.root.findAll(
          n => n.props.accessibilityLabel === 'Forehand drive',
        ).length > 0,
      'imported clip saved + declaration picker',
    );
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    await flush();
    expect(renderedText(renderer)).toContain('Reading player movement');
    return { renderer, extraction };
  }

  it('ATTACK: {extracting, progress:0.9} with NO captureId after "native-pass-A" latched must NOT drive the bar', async () => {
    const { renderer, extraction } = await armImportedExtraction('s1');

    emit(
      extractionEvent('extracting', {
        progress: 0.1,
        captureId: 'native-pass-A',
        atIso: '2026-08-29T18:00:00.000Z',
      }),
    );
    expect(renderedText(renderer)).toContain('10%');
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(10);

    // The attack: an id-less event (a leaked/legacy emitter, or a racing pass
    // whose id was dropped) claiming 90 %.
    emit(
      extractionEvent('extracting', {
        progress: 0.9,
        atIso: '2026-08-29T18:00:01.000Z',
      }),
    );
    const text = renderedText(renderer);
    const now = progressBarNode(renderer).props.accessibilityValue.now;

    console.log(
      `[S1] after id-less 0.9 event: bar now=${now} text has 90%=${text.includes('90%')}`,
    );
    expect(text).not.toContain('90%');
    expect(now).toBe(10);

    extraction.reject(
      Object.assign(new Error('native: cancelled'), {
        code: 'camera.import_cancelled',
      }),
    );
    await flush();
    await act(async () => renderer.unmount());
  });

  it('CONTROL: an explicit DIFFERENT captureId is ignored (existing behaviour)', async () => {
    const { renderer, extraction } = await armImportedExtraction('s1-control');
    emit(
      extractionEvent('extracting', {
        progress: 0.2,
        captureId: 'native-pass-A',
        atIso: '2026-08-29T18:00:00.000Z',
      }),
    );
    emit(
      extractionEvent('extracting', {
        progress: 0.9,
        captureId: 'native-pass-B',
        atIso: '2026-08-29T18:00:01.000Z',
      }),
    );
    expect(renderedText(renderer)).not.toContain('90%');
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(20);
    extraction.reject(new Error('cancelled'));
    await flush();
    await act(async () => renderer.unmount());
  });

  it('EXTRA (regression / non-monotonic): after latching, an event for the same id with progress 0.05 must not show 5 % after 40 %… or must, honestly — record it', async () => {
    const { renderer, extraction } = await armImportedExtraction('s1-extra');
    emit(
      extractionEvent('extracting', {
        progress: 0.4,
        captureId: 'native-pass-A',
        atIso: '2026-08-29T18:00:00.000Z',
      }),
    );
    expect(renderedText(renderer)).toContain('40%');
    // Regressing progress from the SAME pass: native never does this, but a
    // reordered event bridge could. Either freezing at 40 or showing 5 is
    // defensible; what is NOT acceptable is a crash or a NaN/negative ETA.
    emit(
      extractionEvent('extracting', {
        progress: 0.05,
        captureId: 'native-pass-A',
        atIso: '2026-08-29T18:00:01.000Z',
      }),
    );
    const text = renderedText(renderer);

    console.log(
      `[S1-extra] regressing progress → ${text.match(/\d+%[^\n]*/)?.[0]}`,
    );
    expect(text).not.toMatch(/NaN|-\d+s left|Infinity/);
    const now = progressBarNode(renderer).props.accessibilityValue.now;
    expect(now).toBeGreaterThanOrEqual(0);
    expect(now).toBeLessThanOrEqual(100);
    extraction.reject(new Error('cancelled'));
    await flush();
    await act(async () => renderer.unmount());
  });

  it('EXTRA (corrupt state): progress NaN / 2.0 / -1 / unicode string never crash the mounted surface or exceed 0..100', async () => {
    const { renderer, extraction } = await armImportedExtraction('s1-corrupt');
    emit(
      extractionEvent('extracting', {
        progress: 0.3,
        captureId: 'native-pass-A',
        atIso: '2026-08-29T18:00:00.000Z',
      }),
    );
    const hostile = [Number.NaN, 2, -1, Number.POSITIVE_INFINITY];
    for (const progress of hostile) {
      emit(
        extractionEvent('extracting', {
          progress,
          captureId: 'native-pass-A',
          atIso: '2026-08-29T18:00:01.000Z',
        }),
      );
      const now = progressBarNode(renderer).props.accessibilityValue.now;
      const text = renderedText(renderer);

      console.log(
        `[S1-corrupt] progress=${progress} → now=${now} label=${text.match(/\d+%[^\n]*/)?.[0] ?? '(none)'}`,
      );
      expect(text).not.toMatch(/NaN|Infinity/);
      if (now !== undefined) {
        expect(now).toBeGreaterThanOrEqual(0);
        expect(now).toBeLessThanOrEqual(100);
      }
    }
    // A string where a number belongs (a malformed bridge payload).
    emit({
      type: 'import_pose_extraction',
      state: 'extracting',
      progress: '٩٠٪' as unknown as number,
      captureId: 'native-pass-A',
      emittedAtIso: '2026-08-29T18:00:02.000Z',
    });
    expect(renderedText(renderer)).not.toMatch(/NaN|Infinity|٩٠٪/);
    extraction.reject(new Error('cancelled'));
    await flush();
    await act(async () => renderer.unmount());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S2 — late readiness{no_person} between stroke_detected and clip resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('S2 — readiness{no_person} after stroke_detected, before captureStrokeVideo resolves', () => {
  it('ATTACK: the persisted attempt envelope must not mark player_visibility UNSUPPORTED for a real full-body clip', async () => {
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');

    const { clip, sidecarJson } = guidedClip('s2-late-no-person');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferred<CapturedClip>(impl => {
      mockCaptureImpl = impl;
    });
    pressButton(renderer, 'Open automatic camera');
    await flush();

    emit(readinessEvent('ready', 0.93));
    emit(strokeDetectedEvent(0.86));
    expect(renderedText(renderer)).toContain('Motion captured');
    // The player steps out of frame during post-roll / clip finalization.
    emit(readinessEvent('no_person', 0));
    emit(processingEvent());
    capture.resolve(clip);

    await waitFor(
      () =>
        mockNavigation.replace.mock.calls.length > 0 ||
        renderedText(renderer).includes('Nothing was rated'),
      'analysis outcome',
    );
    const text = renderedText(renderer);
    const record = persistedRecordInserts().length
      ? lastPersistedRecord()
      : null;
    const visibility = record?.captureEnvelope?.dimensions.find(
      d => d.dimension === 'player_visibility',
    );

    console.log(
      `[S2] replace=${JSON.stringify(mockNavigation.replace.mock.calls)} envelope.overall=${record?.captureEnvelope?.overall} player_visibility=${visibility?.status} blocked=${text.includes('Nothing was rated')} msg=${text.match(/Nothing was rated[^\n]*\n?[^\n]*/)?.[0] ?? ''}`,
    );

    // A full-body clip (fullBodyVisibleFrameCount === poseFrameCount) must
    // reach the Result screen; the late no_person read describes frames
    // AFTER the stroke window, not the clip that was analyzed.
    expect(mockNavigation.replace).toHaveBeenCalledWith(
      'Result',
      expect.anything(),
    );
    expect(visibility?.status).not.toBe('UNSUPPORTED');
    await act(async () => renderer.unmount());
  });

  it('CONTROL: the same clip with readiness ending on ready(0.93) scores and persists player_visibility SUPPORTED', async () => {
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    const { clip, sidecarJson } = guidedClip('s2-control');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferred<CapturedClip>(impl => {
      mockCaptureImpl = impl;
    });
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('ready', 0.93));
    emit(strokeDetectedEvent(0.86));
    emit(processingEvent());
    capture.resolve(clip);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );
    const visibility = lastPersistedRecord().captureEnvelope?.dimensions.find(
      d => d.dimension === 'player_visibility',
    );
    expect(visibility?.status).toBe('SUPPORTED');
    await act(async () => renderer.unmount());
  });

  it('EXTRA (interleaving): no_person → stroke_detected → ready(0.93) → clip: the LAST read before the clip wins today; record what is persisted', async () => {
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    const { clip, sidecarJson } = guidedClip('s2-interleave');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferred<CapturedClip>(impl => {
      mockCaptureImpl = impl;
    });
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('no_person', 0));
    emit(strokeDetectedEvent(0.86));
    emit(readinessEvent('ready', 0.93));
    emit(processingEvent());
    capture.resolve(clip);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );
    const visibility = lastPersistedRecord().captureEnvelope?.dimensions.find(
      d => d.dimension === 'player_visibility',
    );

    console.log(`[S2-interleave] player_visibility=${visibility?.status}`);
    expect(mockNavigation.replace).toHaveBeenCalledWith(
      'Result',
      expect.anything(),
    );
    await act(async () => renderer.unmount());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S6 — imported clip: extraction succeeds, updateCaptureClipPayload throws
// ═════════════════════════════════════════════════════════════════════════════

describe('S6 — imported clip: extraction ok, updateCaptureClipPayload throws', () => {
  it('ATTACK: the run still scores from the in-memory clip; the persisted capture payload (Form Review input) lacks the sidecar', async () => {
    const clip = importedClipWithoutSidecar('s6');
    const { extraction, sidecarJson } = extractionFor('s6');
    mockImportImpl = async () => clip;
    mockExtractImpl = async () => extraction;
    mockReadArtifact = async () => sidecarJson;
    failingSql = ['UPDATE local_capture SET payload'];

    const renderer = await renderScreen('library');
    await waitFor(
      () =>
        renderer.root.findAll(
          n => n.props.accessibilityLabel === 'Forehand drive',
        ).length > 0,
      'imported clip saved + declaration picker',
    );
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });

    await waitFor(
      () =>
        mockNavigation.replace.mock.calls.length > 0 ||
        renderedText(renderer).includes('Nothing was rated'),
      'analysis outcome',
    );
    const text = renderedText(renderer);
    const updateAttempts = activeDb.calls.filter(c =>
      c.sql.includes('UPDATE local_capture SET payload'),
    );
    const payload = persistedCapturePayload();
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch;
    const permitCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).endsWith('/v1/analysis-permits'),
    );

    console.log(
      `[S6] replace=${JSON.stringify(mockNavigation.replace.mock.calls)} updateAttempts=${updateAttempts.length} persistedPayload.poseSequence=${JSON.stringify(payload?.poseSequence ?? null)} permits=${permitCalls.length} records=${persistedRecordInserts().length} errorShown=${text.includes('Nothing was rated')}`,
    );

    expect(updateAttempts).toHaveLength(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith(
      'Result',
      expect.anything(),
    );
    expect(persistedRecordInserts()).toHaveLength(1);
    expect(text).not.toContain('Nothing was rated');
    // Documented degradation: Form Review reads local_capture.payload →
    // poseSequence is absent → pose-less replay (never a fabricated one).
    expect(payload).not.toBeNull();
    expect(payload?.poseSequence).toBeUndefined();
    await act(async () => renderer.unmount());
  });

  it('CONTROL: with persistence healthy the capture payload carries the sidecar after scoring', async () => {
    const clip = importedClipWithoutSidecar('s6-control');
    const { extraction, sidecarJson } = extractionFor('s6-control');
    mockImportImpl = async () => clip;
    mockExtractImpl = async () => extraction;
    mockReadArtifact = async () => sidecarJson;

    const renderer = await renderScreen('library');
    await waitFor(
      () =>
        renderer.root.findAll(
          n => n.props.accessibilityLabel === 'Forehand drive',
        ).length > 0,
      'imported clip saved + declaration picker',
    );
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );
    const payload = persistedCapturePayload();
    expect(payload?.poseSequence?.sha256).toBe(extraction.poseSequence.sha256);
    await act(async () => renderer.unmount());
  });

  it('EXTRA (cancellation mid-flight): unmount while extraction is pending → a late extraction result never scores or writes', async () => {
    const clip = importedClipWithoutSidecar('s6-cancel');
    const { extraction, sidecarJson } = extractionFor('s6-cancel');
    mockImportImpl = async () => clip;
    mockReadArtifact = async () => sidecarJson;
    const pending = deferred<ImportedPoseExtraction>(impl => {
      mockExtractImpl = impl;
    });

    const renderer = await renderScreen('library');
    await waitFor(
      () =>
        renderer.root.findAll(
          n => n.props.accessibilityLabel === 'Forehand drive',
        ).length > 0,
      'imported clip saved + declaration picker',
    );
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    expect(renderedText(renderer)).toContain('Reading player movement');
    const writesBefore = activeDb.calls.length;
    await act(async () => renderer.unmount());
    // Background/foreground: the native pass finishes after the screen died.
    pending.resolve(extraction);
    await flush();
    await flush();
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch;
    const permitCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).endsWith('/v1/analysis-permits'),
    );
    const lateWrites = activeDb.calls.slice(writesBefore);

    console.log(
      `[S6-cancel] permits after unmount=${permitCalls.length} lateWrites=${lateWrites.map(c => c.sql.split(/\s+/).slice(0, 3).join(' ')).join(' | ')}`,
    );
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(permitCalls).toHaveLength(0);
    expect(persistedRecordInserts()).toHaveLength(0);
  });
});
