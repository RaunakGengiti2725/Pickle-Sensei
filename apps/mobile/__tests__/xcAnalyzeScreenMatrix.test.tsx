/**
 * xc-screen-ux-a11y-i18n-3 — AnalyzeScreen render-state matrix.
 *
 * Drives the REAL AnalyzeScreen through every phase the screen can render
 * (ready / working / saved / analyzed / free_limit / error), every camera
 * readiness caption, and every failure-copy path the JS layer owns:
 * capture errors, cancellation, imported-video extraction failures
 * (too long / no person / unknown), the real runCaptureAnalysis pre-inference
 * gates (missing / unreadable / hash-mismatched / invalid pose sequence,
 * quality-blocked envelope), paywall, generic service failure, thrown
 * exceptions, retry and duplicate-tap behaviour. Every rendered state is run
 * through the shared a11y/copy auditor and written to
 * artifacts/xc-screen-ux-a11y-i18n-3/analyze-state-matrix.json.
 *
 * Native camera / Apple Vision execution is BLOCKED_EXTERNAL on Linux — the
 * native bridge is mocked at exactly the seam the screen consumes.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
  updateCaptureClipPayload: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => {
  const actual = jest.requireActual('../src/analysis/runCaptureAnalysis');
  return { ...actual, runCaptureAnalysis: jest.fn() };
});
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));
const mockCameraListeners = new Set<(event: unknown) => void>();
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    readCaptureArtifact: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => false),
    extractImportedPoseSequence: jest.fn(),
    subscribeToCameraEvents: jest.fn((listener: (event: unknown) => void) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    }),
  };
});
jest.mock('../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
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
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
  };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { ENVELOPE_DIMENSIONS } from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';
import { AnalyzeScreen, READINESS_COPY } from '../src/screens/AnalyzeScreen';
import { TargetSelector } from '../src/camera/TargetSelector';
import {
  assertCapturedClip,
  captureStrokeVideo,
  importStrokeVideo,
  readCaptureArtifact,
  importedPoseExtractionAvailable,
  extractImportedPoseSequence,
  type CameraEvent,
  type CameraReadinessState,
  type CapturedClip,
} from '../src/camera/capture';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
} from '../src/analysis/runCaptureAnalysis';
import { useAccessStore } from '../src/state/accessStore';
import type { CanonicalAccessState } from '../src/billing/types';
import {
  auditRenderedTree,
  summarize,
  writeArtifact,
  appendLog,
  type StateAudit,
} from '../xc-audit/auditKit';
import { color } from '../src/design/tokens';

const realRunCaptureAnalysis = (
  jest.requireActual('../src/analysis/runCaptureAnalysis') as {
    runCaptureAnalysis: typeof runCaptureAnalysis;
  }
).runCaptureAnalysis;

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

// Guided clips here feed runCaptureAnalysis' pre-inference gates directly;
// the native-contract validator (trigger/evidence telemetry) is not the
// subject, so the fixture is shaped without it.
function guidedClip(overrides: Record<string, unknown> = {}): CapturedClip {
  return {
    uri: 'file:///private/var/mobile/guided.mov',
    durationMs: 2600,
    fps: 60,
    width: 1080,
    height: 1920,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    ...overrides,
  } as unknown as CapturedClip;
}

const matrix: StateAudit[] = [];
const LOG = 'analyze-state-matrix.log';

function record(
  renderer: ReactTestRenderer,
  state: string,
  input: unknown,
  extra: Partial<StateAudit> = {},
): StateAudit {
  const audit = auditRenderedTree(renderer, {
    screen: 'AnalyzeScreen',
    state,
    input,
    screenBackground: color.surface,
    allowTokens: [/^[A-Z]{1,3}$/],
  });
  Object.assign(audit, extra);
  matrix.push(audit);
  appendLog(LOG, JSON.stringify(summarize(audit)));
  return audit;
}

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function pressText(renderer: ReactTestRenderer, text: string): void {
  // Buttons render their label inside a host Text; walk up to the pressable.
  const textNode = renderer.root.findAll(
    n =>
      String(n.type) === 'Text' &&
      Array.isArray(n.children) &&
      n.children.some(c => c === text),
  )[0];
  if (!textNode) throw new Error(`text not found: ${text}`);
  let cursor = textNode.parent;
  while (cursor && typeof cursor.props['onPress'] !== 'function') {
    cursor = cursor.parent;
  }
  if (!cursor) throw new Error(`no pressable ancestor for: ${text}`);
  cursor.props['onPress']();
}

async function mount(params: Record<string, unknown>) {
  mockRouteParams = params;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

async function mountLibrary(): Promise<ReactTestRenderer> {
  const renderer = await mount({ source: 'library' });
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => {});
  await act(async () => {
    jest.advanceTimersByTime(50);
  });
  await act(async () => {});
}

function emit(event: CameraEvent): void {
  for (const listener of mockCameraListeners) listener(event);
}

function readinessEvent(state: CameraReadinessState): CameraEvent {
  return {
    type: 'readiness',
    state,
    poseConfidence: 0.8,
    jointCoverage: state === 'no_person' ? 0 : 0.9,
    stableForMs: 400,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'test',
    emittedAtIso: '2026-08-27T18:00:00.000Z',
  };
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

/** Import a library clip and run scoring with the mocked analysis outcome. */
async function libraryRunTo(
  outcome: CaptureAnalysisOutcome | (() => Promise<CaptureAnalysisOutcome>),
): Promise<ReactTestRenderer> {
  (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
  if (typeof outcome === 'function') {
    (runCaptureAnalysis as jest.Mock).mockImplementation(outcome);
  } else {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue(outcome);
  }
  const renderer = await mountLibrary();
  expect(rendered(renderer)).toContain('Which stroke was this?');
  await declareAndScore(renderer);
  return renderer;
}

/** Declare the first stroke, then skip the target tap → scoring run. */
async function declareAndScore(renderer: ReactTestRenderer): Promise<void> {
  const radios = renderer.root.findAll(
    node => node.props['accessibilityRole'] === 'radio',
  );
  expect(radios.length).toBeGreaterThan(0);
  await act(async () => {
    radios[0]!.props['onPress']();
  });
  const selector = renderer.root.findByType(TargetSelector);
  await act(async () => {
    void selector.props['onSkip']();
  });
  await flush();
}

describe('xc-3 · AnalyzeScreen render-state matrix', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockCameraListeners.clear();
    (importedPoseExtractionAvailable as jest.Mock).mockReturnValue(false);
    useAccessStore.setState({ canonicalAccess: null });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    const file = writeArtifact('analyze-state-matrix.json', {
      generatedAtIso: new Date().toISOString(),
      screen: 'AnalyzeScreen',
      states: matrix.length,
      summary: matrix.map(summarize),
      states_detail: matrix,
    });
    appendLog(LOG, `wrote ${file}`);
  });

  it('ready (camera landing): named controls, no forbidden copy, privacy line audited', async () => {
    const renderer = await mount({ source: 'camera' });
    const audit = record(renderer, 'ready.camera', { source: 'camera' });
    expect(rendered(renderer)).toContain('Open automatic camera');
    expect(audit.controls.length).toBeGreaterThan(0);
    expect(
      audit.controls.filter(c => c.issues.includes('unnamed_control')),
    ).toEqual([]);
    expect(audit.lexicon.filter(h => h.rule !== 'cloud_video_feature')).toEqual(
      [],
    );
    await unmount(renderer);
  });

  it('working: opening camera + every readiness caption', async () => {
    let resolveCapture!: (clip: CapturedClip) => void;
    let rejectCapture!: (error: unknown) => void;
    (captureStrokeVideo as jest.Mock).mockImplementation(
      () =>
        new Promise<CapturedClip>((resolve, reject) => {
          resolveCapture = resolve;
          rejectCapture = reject;
        }),
    );
    const renderer = await mount({ source: 'camera' });
    pressText(renderer, 'Open automatic camera');
    await flush();
    expect(rendered(renderer)).toContain('Opening camera…');
    record(renderer, 'working.opening_camera', null);

    const states: CameraReadinessState[] = [
      'no_person',
      'full_body_required',
      'move_closer',
      'move_farther',
      'hold_still',
      'ready',
    ];
    for (const state of states) {
      await act(async () => {
        emit(readinessEvent(state));
      });
      const out = rendered(renderer);
      expect(out).toContain(READINESS_COPY[state]);
      const audit = record(renderer, `working.readiness.${state}`, { state });
      // Status must not depend on colour alone: the caption text is present.
      expect(
        audit.texts.some(t => t.text.includes(READINESS_COPY[state])),
      ).toBe(true);
    }
    // Unknown readiness token from a newer native build → generic fallback.
    await act(async () => {
      emit(readinessEvent('spinning' as CameraReadinessState));
    });
    expect(rendered(renderer)).toContain('Reading your position…');
    record(renderer, 'working.readiness.unknown_token', { state: 'spinning' });

    await act(async () => {
      emit({
        type: 'stroke_detected',
        startTimestampMs: 0,
        endTimestampMs: 900,
        confidence: 0.9,
        detectionModelVersion: 'test',
        recognition: { status: 'unknown', reason: 'analysis_not_run' },
        emittedAtIso: '2026-08-27T18:00:00.000Z',
      });
    });
    expect(rendered(renderer)).toContain('Motion captured');
    record(renderer, 'working.stroke_detected', null);
    await act(async () => {
      emit({
        type: 'processing',
        state: 'preparing_clip',
        emittedAtIso: '2026-08-27T18:00:00.000Z',
      });
    });
    expect(rendered(renderer)).toContain('Saving the private clip…');
    record(renderer, 'working.processing', null);

    // Capture failure → error/capture with retry.
    await act(async () => {
      rejectCapture(
        new Error(
          'The camera could not start. Close other camera apps and try again.',
        ),
      );
    });
    await flush();
    const out = rendered(renderer);
    expect(out).toContain('Capture interrupted');
    expect(out).toContain('Nothing was rated.');
    expect(out).toContain('Try again');
    const audit = record(renderer, 'error.capture.generic', {
      error: 'The camera could not start.',
    });
    expect(audit.alerts).toBeGreaterThanOrEqual(1);
    void resolveCapture;
    await unmount(renderer);
  });

  it('cancellation copy heuristic: any message containing "cancel" is swallowed silently', async () => {
    (captureStrokeVideo as jest.Mock).mockRejectedValueOnce(
      new Error('Guided capture was canceled.'),
    );
    const renderer = await mount({ source: 'camera' });
    pressText(renderer, 'Open automatic camera');
    await flush();
    expect(rendered(renderer)).toContain('Open automatic camera');
    record(renderer, 'ready.after_user_cancel', {
      error: 'Guided capture was canceled.',
    });

    // Adversarial: a NON-user failure whose text merely contains "cancel".
    const impostor =
      'Recording failed: the encoder could not cancel the pending export session.';
    (captureStrokeVideo as jest.Mock).mockRejectedValueOnce(
      new Error(impostor),
    );
    pressText(renderer, 'Open automatic camera');
    await flush();
    const out = rendered(renderer);
    const swallowed = !out.includes('Nothing was rated.');
    record(
      renderer,
      'ready.after_impostor_cancel',
      { error: impostor },
      {
        issues: swallowed
          ? [
              'cancel_substring_heuristic: non-cancellation error silently swallowed (AnalyzeScreen.tsx run() catch: message.toLowerCase().includes("cancel"))',
            ]
          : [],
      },
    );
    expect(swallowed).toBe(true);
    await unmount(renderer);
  });

  it('saved (imported clip): declaration sheet, radios named, skip → scoring', async () => {
    let resolveAnalysis!: (o: CaptureAnalysisOutcome) => void;
    const renderer = await libraryRunTo(
      () =>
        new Promise<CaptureAnalysisOutcome>(
          resolve => (resolveAnalysis = resolve),
        ),
    );
    // Declared + skipped target tap; the scoring run is in flight.
    const working = rendered(renderer);
    expect(working).toContain('Measuring your swing…');
    record(renderer, 'working.measuring_declared', {
      declaredStroke: 'first-radio',
    });
    await act(async () => {
      resolveAnalysis({
        kind: 'unavailable',
        reason:
          'Imported videos have no recorded pose sequence yet. Record with the guided camera to get a Technique Score.',
      });
    });
    await flush();
    expect(rendered(renderer)).toContain('Analysis stopped');
    record(renderer, 'error.analysis.imported_no_pose_sequence', null);
    await unmount(renderer);

    // Saved state itself (before Skip).
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const saved = await mountLibrary();
    const audit = record(saved, 'saved.imported.declaration_sheet', {
      captureMode: importedClip.captureMode,
    });
    expect(audit.roles['radio'] ?? 0).toBeGreaterThan(0);
    expect(
      audit.controls.filter(c => c.issues.includes('unnamed_control')),
    ).toEqual([]);
    await unmount(saved);
  });

  it('imported-video extraction failures: too long / no person / unknown / non-Error', async () => {
    (importedPoseExtractionAvailable as jest.Mock).mockReturnValue(true);
    const cases: { name: string; error: unknown; expect: string }[] = [
      {
        name: 'import_too_long',
        error: Object.assign(new Error('native'), {
          code: 'camera.import_too_long',
        }),
        expect: 'This video is too long to analyze.',
      },
      {
        name: 'import_no_person',
        error: Object.assign(new Error('native'), {
          code: 'camera.import_no_person',
        }),
        expect: 'No person could be tracked in this video',
      },
      {
        name: 'unknown_error_message',
        error: new Error(
          'Pose extraction failed: VNDetectHumanBodyPoseRequest returned no observations',
        ),
        expect: 'VNDetectHumanBodyPoseRequest',
      },
      {
        name: 'non_error_object',
        error: { code: 'camera.import_failed' },
        expect: 'Reading player movement from this video failed.',
      },
      {
        name: 'empty_message',
        error: new Error('   '),
        expect: 'Reading player movement from this video failed.',
      },
    ];
    for (const c of cases) {
      (extractImportedPoseSequence as jest.Mock).mockRejectedValue(c.error);
      const renderer = await libraryRunTo({
        kind: 'unavailable',
        reason: 'unreachable',
      });
      const out = rendered(renderer);
      expect(out).toContain('Analysis stopped');
      expect(out).toContain(c.expect);
      expect(runCaptureAnalysis).not.toHaveBeenCalled();
      const audit = record(renderer, `error.analysis.extraction.${c.name}`, {
        error:
          c.error instanceof Error
            ? { ...c.error, message: c.error.message }
            : c.error,
      });
      expect(audit.alerts).toBeGreaterThanOrEqual(1);
      await unmount(renderer);
      jest.clearAllMocks();
      (importedPoseExtractionAvailable as jest.Mock).mockReturnValue(true);
    }
  });

  it('real runCaptureAnalysis pre-inference gates → error copy (missing/unreadable/hash/invalid/quality)', async () => {
    const outcomes: Record<string, CaptureAnalysisOutcome> = {};
    const base = {
      db: {} as never,
      captureId: 'cap-1',
      declaredStroke: null,
      handedness: 'right' as const,
      cameraView: 'side' as const,
      apiConfig: { kind: 'unconfigured' } as never,
      appVersion: '0.0.0-test',
    };
    // 1. imported without pose sequence
    outcomes['imported_no_pose'] = await realRunCaptureAnalysis({
      ...base,
      clip: importedClip,
    });
    // 2. guided clip that predates pose recording
    outcomes['guided_missing_pose'] = await realRunCaptureAnalysis({
      ...base,
      clip: guidedClip(),
    });
    // 3. sidecar unreadable
    const ref = {
      uri: 'file:///private/var/mobile/guided.pose.json',
      sha256: 'a'.repeat(64),
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      frameCount: 10,
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-test',
    };
    (readCaptureArtifact as jest.Mock).mockRejectedValueOnce(
      new Error('ENOENT'),
    );
    outcomes['sidecar_unreadable'] = await realRunCaptureAnalysis({
      ...base,
      clip: guidedClip({ poseSequence: ref }),
    });
    // 4. hash mismatch
    (readCaptureArtifact as jest.Mock).mockResolvedValueOnce(
      '{"tampered":true}',
    );
    outcomes['hash_mismatch'] = await realRunCaptureAnalysis({
      ...base,
      clip: guidedClip({ poseSequence: ref }),
    });
    // 5. invalid sidecar (hash matches, content invalid)
    const invalid = '{"not":"a pose sequence"}';
    (readCaptureArtifact as jest.Mock).mockResolvedValueOnce(invalid);
    outcomes['invalid_sidecar'] = await realRunCaptureAnalysis({
      ...base,
      clip: guidedClip({
        poseSequence: { ...ref, sha256: sha256Hex(invalid) },
      }),
    });
    // 5b. invalid sidecar: valid JSON array
    const invalidArray = '[]';
    (readCaptureArtifact as jest.Mock).mockResolvedValueOnce(invalidArray);
    outcomes['invalid_sidecar_array'] = await realRunCaptureAnalysis({
      ...base,
      clip: guidedClip({
        poseSequence: { ...ref, sha256: sha256Hex(invalidArray) },
      }),
    });
    // 6. quality blocked
    const envelope: EnvelopeVerdict = {
      thresholdsVersion: 'test',
      provisional: true,
      overall: 'UNSUPPORTED',
      overallWithCoverage: 'UNSUPPORTED',
      dimensions: ENVELOPE_DIMENSIONS.map(dimension => ({
        dimension,
        status:
          dimension === 'brightness' || dimension === 'player_pixel_height'
            ? 'UNSUPPORTED'
            : 'NOT_MEASURED',
        measured: null,
        unit: '',
        thresholdId: 'test',
      })),
    } as EnvelopeVerdict;
    outcomes['quality_blocked'] = await realRunCaptureAnalysis({
      ...base,
      clip: guidedClip(),
      captureEnvelope: envelope,
    });

    const rows: Record<string, unknown>[] = [];
    for (const [name, outcome] of Object.entries(outcomes)) {
      const renderer = await libraryRunTo(outcome);
      const out = rendered(renderer);
      expect(out).toContain('Nothing was rated.');
      const audit = record(renderer, `error.analysis.gate.${name}`, outcome);
      rows.push({
        name,
        outcome,
        machineTokenLeak: audit.lexicon.filter(h =>
          ['snake_case_token', 'dotted_code', 'js_leak'].includes(h.rule),
        ),
      });
      await unmount(renderer);
      jest.clearAllMocks();
    }
    writeArtifact('analyze-runCaptureAnalysis-gates.json', rows);
    // The invalid-sidecar reason interpolates the raw parser failure code.
    const invalidRow = rows.find(r => r['name'] === 'invalid_sidecar');
    const reason = (invalidRow?.['outcome'] as { reason: string }).reason;
    expect(reason).toMatch(/\(pose_sequence\.[a-z_]+\)/);
    expect(
      (invalidRow?.['machineTokenLeak'] as unknown[]).length,
    ).toBeGreaterThan(0);
  });

  it('analysis outcomes: paywall → upgrade, generic unavailable → retry, thrown → retry, empty reason', async () => {
    const cases: {
      name: string;
      run: CaptureAnalysisOutcome | (() => Promise<CaptureAnalysisOutcome>);
      title: string;
      cta: string;
    }[] = [
      {
        name: 'paywall_required',
        run: {
          kind: 'unavailable',
          reason:
            'Your free analyses are used up. Upgrade to Pro to keep rating.',
          cause: 'paywall_required',
        },
        title: 'Analysis stopped',
        cta: 'Upgrade to Pro',
      },
      {
        name: 'generic_unavailable',
        run: {
          kind: 'unavailable',
          reason:
            'Nothing was rated: the analysis service was unreachable. Check your connection and try again.',
        },
        title: 'Analysis stopped',
        cta: 'Try again',
      },
      {
        name: 'unavailable_empty_reason',
        run: { kind: 'unavailable', reason: '' },
        title: 'Analysis stopped',
        cta: 'Try again',
      },
      {
        name: 'thrown_error',
        run: () => Promise.reject(new Error('Network request failed')),
        title: 'Analysis stopped',
        cta: 'Try again',
      },
      {
        name: 'thrown_non_error',
        run: () => Promise.reject({ code: 'weird' }),
        title: 'Analysis stopped',
        cta: 'Try again',
      },
      {
        name: 'thrown_empty_string',
        run: () => Promise.reject(''),
        title: 'Analysis stopped',
        cta: 'Try again',
      },
    ];
    const rows: Record<string, unknown>[] = [];
    for (const c of cases) {
      const renderer = await libraryRunTo(c.run);
      const out = rendered(renderer);
      expect(out).toContain(c.title);
      expect(out).toContain(c.cta);
      const audit = record(renderer, `error.analysis.${c.name}`, {
        outcome: typeof c.run === 'function' ? 'thrown' : c.run,
      });
      const bodyTexts = audit.texts.map(t => t.text);
      const hasBody = bodyTexts.some(
        t =>
          t !== 'Nothing was rated.' &&
          t !== 'Analysis stopped' &&
          t !== c.cta &&
          t !== 'Close' &&
          t.length > 0,
      );
      rows.push({
        name: c.name,
        texts: bodyTexts,
        hasExplanatoryBody: hasBody,
      });
      if (c.name === 'paywall_required') {
        pressText(renderer, 'Upgrade to Pro');
        expect(mockNavigation.navigate).toHaveBeenCalledWith('Paywall', {
          source: 'rating',
        });
      }
      if (c.name === 'generic_unavailable') {
        // Retry after an ANALYSIS failure reopens the picker (a fresh capture),
        // it does not re-score the saved clip.
        const before = (importStrokeVideo as jest.Mock).mock.calls.length;
        pressText(renderer, 'Try again');
        await flush();
        expect((importStrokeVideo as jest.Mock).mock.calls.length).toBe(
          before + 1,
        );
      }
      await unmount(renderer);
      jest.clearAllMocks();
    }
    writeArtifact('analyze-error-bodies.json', rows);
    const empty = rows
      .filter(r => r['hasExplanatoryBody'] === false)
      .map(r => r['name']);
    // Empty-reason / empty-throw render a bare "Nothing was rated." with no
    // explanation — recorded as a finding, not asserted away.
    expect(empty).toEqual(
      expect.arrayContaining([
        'unavailable_empty_reason',
        'thrown_empty_string',
      ]),
    );
  });

  it('analyzed (abstained / predicted family / declared disagreement) + free-limit modal + scored navigation', async () => {
    const prediction = (label: string, leaf: string | null) => ({
      taxonomyVersion: 'test',
      classifierVersion: 'test',
      label,
      leaf,
      taxonomyDepth: leaf ? 3 : 1,
      confidence: 0.5,
      evidence: [],
      limitingFactors: [],
    });
    const intent = (overrides: Record<string, unknown>) => ({
      declaredStroke: null,
      predictedStroke: null,
      resolutionBasis: 'abstained',
      disagreement: null,
      ...overrides,
    });
    const record0 = { result: null, shotType: 'forehand_drive' };
    const cases: {
      name: string;
      outcome: CaptureAnalysisOutcome;
      expectText: string;
    }[] = [
      {
        name: 'low_confidence.abstained',
        outcome: {
          kind: 'low_confidence',
          analysisId: 'an-1',
          record: { ...record0, strokeIntent: intent({}) } as never,
          guidance: 'Keep your whole body in frame for the full swing.',
        },
        expectText: 'couldn’t identify this stroke',
      },
      {
        name: 'low_confidence.predicted_family',
        outcome: {
          kind: 'low_confidence',
          analysisId: 'an-2',
          record: {
            ...record0,
            strokeIntent: intent({
              resolutionBasis: 'predicted_family',
              predictedStroke: prediction('FOREHAND', null),
            }),
          } as never,
          guidance: null,
        },
        expectText: 'Auto-detected: FOREHAND (family)',
      },
      {
        name: 'low_confidence.predicted_family_null_prediction',
        outcome: {
          kind: 'low_confidence',
          analysisId: 'an-2b',
          record: {
            ...record0,
            strokeIntent: intent({ resolutionBasis: 'predicted_family' }),
          } as never,
          guidance: null,
        },
        expectText: 'Auto-detected: UNKNOWN (family)',
      },
      {
        name: 'low_confidence.predicted_l3_leaf',
        outcome: {
          kind: 'low_confidence',
          analysisId: 'an-2c',
          record: {
            ...record0,
            strokeIntent: intent({
              resolutionBasis: 'predicted_l3',
              predictedStroke: prediction('FOREHAND_DRIVE', 'FOREHAND_DRIVE'),
            }),
          } as never,
          guidance: null,
        },
        expectText: 'Auto-detected: FOREHAND_DRIVE',
      },
      {
        name: 'low_confidence.declared_disagreement',
        outcome: {
          kind: 'low_confidence',
          analysisId: 'an-3',
          record: {
            ...record0,
            strokeIntent: intent({
              resolutionBasis: 'declared',
              declaredStroke: 'forehand_drive',
              disagreement: {
                declared: 'forehand_drive',
                predictedLabel: 'BACKHAND_DINK',
                basis: 'leaf_vs_declared',
              },
            }),
          } as never,
          guidance: null,
        },
        expectText:
          'You declared forehand drive — the camera read BACKHAND_DINK.',
      },
    ];
    for (const c of cases) {
      const renderer = await libraryRunTo(c.outcome);
      await flush();
      const out = rendered(renderer);
      expect(out).toContain(c.expectText);
      record(renderer, `analyzed.${c.name}`, c.outcome);
      await unmount(renderer);
      jest.clearAllMocks();
    }

    // free limit reached, default limit (2)
    const scoredLimit: CaptureAnalysisOutcome = {
      kind: 'scored',
      analysisId: 'an-9',
      record: {
        ...record0,
        strokeIntent: intent({
          resolutionBasis: 'declared',
          declaredStroke: 'forehand_drive',
        }),
      } as never,
      freeLimitReached: true,
    };
    const r1 = await libraryRunTo(scoredLimit);
    await flush();
    expect(rendered(r1)).toContain('That was your last free analysis.');
    const a1 = record(r1, 'free_limit.limit_2', { limit: 2 });
    expect(a1.modals.count).toBe(1);
    expect(a1.modals.withViewIsModal).toBe(1);
    pressText(r1, 'See my score');
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'an-9',
    });
    await unmount(r1);
    jest.clearAllMocks();

    // limit variations from the server snapshot
    for (const limit of [1, 3, 0]) {
      useAccessStore.setState({
        canonicalAccess: {
          freeRatings: {
            limit,
            used: limit,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
        } as unknown as CanonicalAccessState,
      });
      const r = await libraryRunTo(scoredLimit);
      await flush();
      const a = record(r, `free_limit.limit_${limit}`, { limit });
      const modalLabel = a.texts.map(t => t.text).join(' | ');
      appendLog(LOG, `free_limit limit=${limit}: ${modalLabel}`);
      await unmount(r);
      jest.clearAllMocks();
    }
    useAccessStore.setState({ canonicalAccess: null });

    // scored, not last free → straight to Result
    const r2 = await libraryRunTo({ ...scoredLimit, freeLimitReached: false });
    await flush();
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'an-9',
    });
    await unmount(r2);
  });

  it('duplicate Skip taps run exactly one analysis', async () => {
    let resolveAnalysis!: (o: CaptureAnalysisOutcome) => void;
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    (runCaptureAnalysis as jest.Mock).mockImplementation(
      () =>
        new Promise<CaptureAnalysisOutcome>(
          resolve => (resolveAnalysis = resolve),
        ),
    );
    const renderer = await mountLibrary();
    const radios = renderer.root.findAll(
      node => node.props['accessibilityRole'] === 'radio',
    );
    await act(async () => {
      radios[0]!.props['onPress']();
    });
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      void selector.props['onSkip']();
      void selector.props['onSkip']();
      void selector.props['onSkip']();
    });
    await flush();
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
    record(renderer, 'working.duplicate_tap_guard', { taps: 3, runs: 1 });
    await act(async () => {
      resolveAnalysis({ kind: 'unavailable', reason: 'x' });
    });
    await unmount(renderer);
  });

  it('late camera readiness event is NOT phase-gated: it overrides error / free-limit surfaces', async () => {
    // Error phase, then a trailing readiness event arrives from the bridge.
    const r1 = await libraryRunTo({
      kind: 'unavailable',
      reason: 'Nothing was rated: the analysis service was unreachable.',
    });
    expect(rendered(r1)).toContain('Nothing was rated.');
    await act(async () => {
      emit(readinessEvent('hold_still'));
    });
    const afterError = rendered(r1);
    const errorOverridden =
      !afterError.includes('Nothing was rated.') &&
      afterError.includes(READINESS_COPY.hold_still);
    record(
      r1,
      'error.then_late_readiness_event',
      { event: 'readiness:hold_still' },
      {
        issues: errorOverridden
          ? [
              'late_readiness_event_overrides_error_phase (AnalyzeScreen.tsx subscribeToCameraEvents readiness branch sets phase=working unconditionally)',
            ]
          : [],
      },
    );
    expect(errorOverridden).toBe(true);
    await unmount(r1);
    jest.clearAllMocks();

    // Free-limit modal, then a trailing readiness event.
    const r2 = await libraryRunTo({
      kind: 'scored',
      analysisId: 'an-77',
      record: {
        result: null,
        shotType: 'forehand_drive',
        strokeIntent: {
          declaredStroke: 'forehand_drive',
          predictedStroke: null,
          resolutionBasis: 'declared',
          disagreement: null,
        },
      } as never,
      freeLimitReached: true,
    });
    await flush();
    expect(rendered(r2)).toContain('That was your last free analysis.');
    await act(async () => {
      emit(readinessEvent('ready'));
    });
    const afterLimit = rendered(r2);
    const limitOverridden = !afterLimit.includes(
      'That was your last free analysis.',
    );
    record(
      r2,
      'free_limit.then_late_readiness_event',
      { event: 'readiness:ready' },
      {
        issues: limitOverridden
          ? [
              'late_readiness_event_dismisses_free_limit_modal (analysisId path to Result lost from this screen)',
            ]
          : [],
      },
    );
    expect(limitOverridden).toBe(true);
    await unmount(r2);
  });
});
