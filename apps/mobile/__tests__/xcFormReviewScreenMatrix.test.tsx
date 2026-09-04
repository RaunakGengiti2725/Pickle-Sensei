/**
 * xc-3 · FormReviewScreen render-state a11y/copy matrix.
 *
 * Mounts the real screen + player (evidence loader, sidecar reader and
 * navigation mocked) in every reachable state and audits the rendered tree
 * with `auditRenderedTree`. Written to
 * artifacts/xc-screen-ux-a11y-i18n-3/formreview-state-matrix.json.
 *
 * States: loading · missing (no analysis) · missing (loader rejected) ·
 * ready (clip + verified pose) at each stop, playing, speed cycle, auto-pause
 * off · ready with clip gone (pose-only) · ready with sidecar rejected
 * (video-only, honest caption) · clip gone AND sidecar rejected (nothing to
 * draw — no invented frames) · sequence with zero frames · sequence whose
 * frames are all low-visibility · requested phase present / absent ·
 * abstained record (result null) · legacy row (record.result only) ·
 * re-analyze handoff + back.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockLoadEvidence = jest.fn();
jest.mock('../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockLoadSequence = jest.fn();
jest.mock('../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = { analysisId: 'analysis-1' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: {
      children?: React.ReactNode;
      testID?: string;
      style?: unknown;
    }) =>
      React.createElement(
        View,
        { testID: props.testID, style: props.style },
        props.children,
      ),
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

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { FormReviewScreen } from '../src/screens/FormReviewScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import { FormReviewOverlay } from '../src/review/FormReviewOverlay';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../src/review/formReviewModel';
import {
  auditRenderedTree,
  summarize,
  writeArtifact,
  appendLog,
  type StateAudit,
} from '../xc-audit/auditKit';
import { color } from '../src/design/tokens';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

const analysis: ShotAnalysis = {
  id: 'analysis-1',
  sessionId: 'set-1',
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
  phases: [
    phase('ready', 0, 900),
    phase('prepare', 900, 1500),
    phase('accelerate', 1500, 1900),
    phase('contact', 1880, 1920, 1900),
    phase('follow_through', 1920, 2400),
    phase('recover', 2400, 3200),
  ],
  measurements: [],
  checkpoints: [
    checkpoint('ready_position', 85, 'green', 'none'),
    checkpoint('athletic_base', 72, 'yellow', 'narrow'),
    checkpoint('preparation', 88, 'green', 'none'),
    checkpoint('paddle_set', 90, 'green', 'none'),
    checkpoint('swing_length', null, 'unscored', 'none'),
    checkpoint('sequencing', 82, 'green', 'none'),
    checkpoint('paddle_path', 61, 'red', 'low'),
    checkpoint('contact_position', 48, 'red', 'late'),
    checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
      applicable: false,
    }),
    checkpoint('follow_through', 80, 'green', 'short'),
    checkpoint('recovery', 92, 'green', 'none'),
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
    appVersion: '0.1.0',
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

const record = {
  id: 'analysis-1',
  captureId: 'capture-1',
  strokeIntent: {
    declaredStroke: 'forehand_drive' as const,
    predictedStroke: null,
    resolutionBasis: 'declared' as const,
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0.84,
    presentation: 'normal' as const,
    limitingFactors: [],
  },
};

const sidecarRef = {
  schemaVersion: 1 as const,
  format: 'pickle.pose-sequence.v1' as const,
  uri: 'file:///captures/clip.pose.json',
  frameCount: 81,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left' as const,
  poseModelVersion: 'apple-vision-bodypose-1',
};

function frameAt(
  timestampMs: number,
  joints: Partial<Record<ReviewJoint, { x: number; y: number }>>,
  visibility = 0.95,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: Object.entries(joints).map(([name, point]) => ({
      name,
      x: point.x,
      y: point.y,
      visibility,
    })),
  };
}

function fullBodySequence(visibility = 0.95): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= 3200; t += 40) {
    const sweep = t / 3200;
    frames.push(
      frameAt(
        t,
        {
          head: { x: 0.5, y: 0.18 },
          left_shoulder: { x: 0.45, y: 0.3 },
          right_shoulder: { x: 0.55, y: 0.3 },
          left_elbow: { x: 0.4, y: 0.42 },
          right_elbow: { x: 0.62, y: 0.42 },
          left_wrist: { x: 0.38, y: 0.52 },
          right_wrist: { x: 0.3 + 0.4 * sweep, y: 0.5 },
          left_hip: { x: 0.46, y: 0.55 },
          right_hip: { x: 0.54, y: 0.55 },
          left_knee: { x: 0.46, y: 0.72 },
          right_knee: { x: 0.54, y: 0.72 },
          left_ankle: { x: 0.45, y: 0.9 },
          right_ankle: { x: 0.55, y: 0.9 },
        },
        visibility,
      ),
    );
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    analysis,
    record,
    clip: {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef },
    attempts: [],
    ...overrides,
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

const matrix: StateAudit[] = [];
const LOG = 'formreview-state-matrix.log';
const mounted: ReactTestRenderer[] = [];

function record_(
  renderer: ReactTestRenderer,
  state: string,
  input: unknown,
): StateAudit {
  const audit = auditRenderedTree(renderer, {
    screen: 'FormReviewScreen',
    state,
    input,
    screenBackground: color.ink,
    // "STOP 1 OF 6", "AUTO", "1×", "FIX", "WATCH · READY STANCE".
    allowTokens: [/^[A-Z]{1,4}$/, /^\d(\.\d)?×$/],
  });
  matrix.push(audit);
  appendLog(LOG, JSON.stringify(summarize(audit)));
  return audit;
}

async function renderScreen(params: Record<string, unknown> = {}) {
  mockRouteParams = { analysisId: 'analysis-1', ...params };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FormReviewScreen />);
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll(n => String(n.type) === 'Text')
    .map(n =>
      (n.children ?? []).map(c => (typeof c === 'string' ? c : '')).join(''),
    )
    .join('\n');
}

function byTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props['testID'] === testID &&
      typeof candidate.props['onPress'] === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = byTestId(renderer, testID);
  await act(async () => {
    node.props['onPress']();
  });
}

function pressText(renderer: ReactTestRenderer, text: string): void {
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

/** The pose frame the overlay was asked to draw (null = no exoskeleton). */
function overlayFrames(renderer: ReactTestRenderer): unknown[] {
  return renderer.root
    .findAllByType(FormReviewOverlay)
    .map(node => node.props['frame'] ?? null);
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props['testID'] === testID,
  );
}

async function layoutStage(renderer: ReactTestRenderer) {
  const [stage] = renderer.root.findAll(
    node =>
      node.props['testID'] === 'form-review-stage' &&
      typeof node.props['onLayout'] === 'function',
  );
  if (!stage) return;
  await act(async () => {
    stage.props['onLayout']({
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 420 } },
    });
  });
}

function unnamed(a: StateAudit) {
  return a.controls.filter(c => c.issues.includes('unnamed_control'));
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockResolvedValue(evidence());
  mockLoadSequence.mockResolvedValue(fullBodySequence());
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

afterAll(() => {
  const file = writeArtifact('formreview-state-matrix.json', {
    generatedAtIso: new Date().toISOString(),
    screen: 'FormReviewScreen',
    states: matrix.length,
    summary: matrix.map(summarize),
    states_detail: matrix,
  });
  appendLog(LOG, `wrote ${file}`);
});

describe('xc-3 · FormReviewScreen render-state matrix', () => {
  it('loading: dark header with Close + announced caption', async () => {
    mockLoadEvidence.mockReturnValue(new Promise(() => {}));
    const renderer = await renderScreen();
    const audit = record_(renderer, 'loading', {});
    expect(allText(renderer)).toContain('Preparing your form review…');
    expect(audit.controls.some(c => c.name === 'Close')).toBe(true);
    expect(audit.liveRegions.length).toBeGreaterThan(0);
    expect(unnamed(audit)).toEqual([]);
    expect(audit.lexicon).toEqual([]);
  });

  it('missing (no analysis) and missing (loader rejected): honest, alert role, way back, no sidecar read', async () => {
    mockLoadEvidence.mockResolvedValue({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    let renderer = await renderScreen();
    let audit = record_(renderer, 'missing.no_analysis', {});
    expect(allText(renderer)).toContain('Review unavailable');
    expect(allText(renderer)).toContain('nothing to replay');
    expect(audit.alerts).toBeGreaterThan(0);
    expect(mockLoadSequence).not.toHaveBeenCalled();
    expect(audit.controls.some(c => c.name === 'Try again')).toBe(true);
    // ErrorState's default retry label says "Try again" while it goes BACK.
    appendLog(
      LOG,
      `missing-state retry label: ${JSON.stringify(audit.controls.map(c => c.name))}`,
    );
    await act(async () => pressText(renderer, 'Try again'));
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockLoadEvidence).toHaveBeenCalledTimes(1);

    mockLoadEvidence.mockRejectedValue(new Error('sqlite: database is locked'));
    renderer = await renderScreen();
    audit = record_(renderer, 'missing.loader_rejected', {
      error: 'sqlite: database is locked',
    });
    expect(allText(renderer)).toContain('Review unavailable');
    expect(allText(renderer)).not.toContain('database is locked');
    expect(audit.lexicon).toEqual([]);
  });

  it('ready: every stop, playing, speed cycle, auto-pause toggle — all controls named, switch/progress semantics', async () => {
    const renderer = await renderScreen();
    await layoutStage(renderer);
    let audit = record_(renderer, 'ready.stop_1', {});
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(1);
    expect(allText(renderer)).toContain('STOP 1 OF 6');
    expect(unnamed(audit)).toEqual([]);
    expect(audit.lexicon).toEqual([]);
    expect(audit.imagesWithoutLabel).toBe(0);
    expect(audit.roles['switch']).toBe(1);
    const autopause = byTestId(renderer, 'form-review-autopause');
    expect(autopause.props['accessibilityState']).toMatchObject({
      checked: true,
    });

    for (let stop = 2; stop <= 6; stop += 1) {
      await press(renderer, 'form-review-next-stop');
      audit = record_(renderer, `ready.stop_${stop}`, {});
      expect(allText(renderer)).toContain(`STOP ${stop} OF 6`);
      expect(unnamed(audit)).toEqual([]);
      expect(audit.lexicon).toEqual([]);
    }
    // Next on the last stop: no crash, still stop 6.
    await press(renderer, 'form-review-next-stop');
    expect(allText(renderer)).toContain('STOP 6 OF 6');
    // Prev back to 1 and beyond.
    for (let i = 0; i < 7; i += 1)
      await press(renderer, 'form-review-prev-stop');
    expect(allText(renderer)).toContain('STOP 1 OF 6');

    // Playing: caption hides; play control renames to Pause.
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(120);
    });
    audit = record_(renderer, 'ready.playing', {});
    expect(unnamed(audit)).toEqual([]);
    const playNames = audit.controls
      .filter(c => c.testID === 'form-review-play')
      .map(c => c.name);
    appendLog(LOG, `play control while playing: ${JSON.stringify(playNames)}`);
    expect(playNames.every(n => /pause/i.test(n))).toBe(true);
    await press(renderer, 'form-review-play');

    // Speed cycle: each state audited. The rate is exposed only through the
    // hint (no accessibilityValue) — measured here, reported in findings.
    const speeds: { label: string; hint: string; value: unknown }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const speed = byTestId(renderer, 'form-review-speed');
      speeds.push({
        label: String(speed.props['accessibilityLabel'] ?? ''),
        hint: String(speed.props['accessibilityHint'] ?? ''),
        value: speed.props['accessibilityValue'] ?? null,
      });
      audit = record_(renderer, `ready.speed_${i}`, {});
      expect(unnamed(audit)).toEqual([]);
      await press(renderer, 'form-review-speed');
    }
    appendLog(LOG, `speed chip semantics: ${JSON.stringify(speeds)}`);
    expect(new Set(speeds.map(s => s.hint)).size).toBeGreaterThan(1);

    // Timeline semantics: accessible + label + hint, but is it adjustable?
    const timeline = renderer.root.findAll(
      n =>
        typeof n.type === 'string' &&
        n.props['testID'] === 'form-review-timeline',
    )[0]!;
    const timelineSemantics = {
      accessible: timeline.props['accessible'] ?? null,
      role: timeline.props['accessibilityRole'] ?? null,
      value: timeline.props['accessibilityValue'] ?? null,
      actions: timeline.props['accessibilityActions'] ?? null,
      hint: timeline.props['accessibilityHint'] ?? null,
    };
    appendLog(LOG, `timeline semantics: ${JSON.stringify(timelineSemantics)}`);
    writeArtifact('formreview-timeline-semantics.json', {
      timelineSemantics,
      speeds,
    });

    // Auto-pause off.
    await press(renderer, 'form-review-autopause');
    audit = record_(renderer, 'ready.autopause_off', {});
    expect(
      byTestId(renderer, 'form-review-autopause').props['accessibilityState'],
    ).toMatchObject({
      checked: false,
    });
    expect(unnamed(audit)).toEqual([]);
  });

  it('ready: requested phase present opens frozen on it; absent phase is ignored', async () => {
    let renderer = await renderScreen({ phase: 'contact' });
    let audit = record_(renderer, 'ready.requested_phase.contact', {
      phase: 'contact',
    });
    expect(allText(renderer)).toContain('STOP 4 OF 6');
    expect(unnamed(audit)).toEqual([]);

    renderer = await renderScreen({ phase: 'zzz_no_such_phase' });
    audit = record_(renderer, 'ready.requested_phase.unknown', {
      phase: 'zzz_no_such_phase',
    });
    expect(allText(renderer)).toContain('STOP 1 OF 6');
    expect(allText(renderer)).not.toContain('zzz_no_such_phase');
    expect(unnamed(audit)).toEqual([]);
  });

  it('clip gone: pose-only stage, honest caption, no poster invented', async () => {
    mockLoadEvidence.mockResolvedValue(evidence({ clip: null }));
    const renderer = await renderScreen();
    await layoutStage(renderer);
    const audit = record_(renderer, 'ready.clip_missing', {});
    expect(allText(renderer)).toContain(
      'The clip file is gone from this device; the measured pose is shown instead.',
    );
    expect(hostByTestId(renderer, 'form-review-overlay')).toHaveLength(1);
    expect(overlayFrames(renderer)[0]).not.toBeNull();
    expect(
      renderer.root.findAll(
        n => n.props['accessibilityLabel'] === 'Captured clip poster',
      ),
    ).toHaveLength(0);
    expect(unnamed(audit)).toEqual([]);
    expect(audit.lexicon).toEqual([]);
  });

  const SIDECAR_FAILURES: { name: string; setup: () => void }[] = [
    { name: 'null', setup: () => mockLoadSequence.mockResolvedValue(null) },
    {
      name: 'hash_mismatch',
      setup: () =>
        mockLoadSequence.mockRejectedValue(
          new Error('pose_sequence.hash_mismatch'),
        ),
    },
    {
      name: 'unsupported_schema',
      setup: () =>
        mockLoadSequence.mockRejectedValue(
          new Error('pose_sequence.unsupported_schema'),
        ),
    },
    {
      name: 'file_missing',
      setup: () =>
        mockLoadSequence.mockRejectedValue(new Error('ENOENT: no such file')),
    },
    {
      name: 'non_error_rejection',
      setup: () => mockLoadSequence.mockRejectedValue('boom'),
    },
  ];
  for (const c of SIDECAR_FAILURES) {
    it(`sidecar ${c.name}: video without exoskeleton, stops still from the analysis, no raw token`, async () => {
      c.setup();
      const renderer = await renderScreen();
      await layoutStage(renderer);
      const audit = record_(renderer, `ready.sidecar_${c.name}`, {
        sidecar: c.name,
      });
      const text = allText(renderer);
      expect(text).toContain(
        'No verified pose sequence is stored for this clip',
      );
      expect(text).toContain('STOP 1 OF 6');
      expect(text).not.toMatch(/hash_mismatch|unsupported_schema|ENOENT|boom/);
      // Overlay layer exists (arrow/heat host) but draws NO pose frame.
      expect(overlayFrames(renderer)).toEqual([null]);
      expect(unnamed(audit)).toEqual([]);
      expect(audit.lexicon).toEqual([]);
    });
  }

  it('clip gone AND sidecar rejected: nothing is drawn and nothing is invented', async () => {
    mockLoadEvidence.mockResolvedValue(evidence({ clip: null }));
    mockLoadSequence.mockResolvedValue(null);
    const renderer = await renderScreen();
    await layoutStage(renderer);
    const audit = record_(renderer, 'ready.clip_missing.sidecar_null', {});
    const text = allText(renderer);
    expect(overlayFrames(renderer)).toEqual([null]);
    expect(
      renderer.root.findAll(
        n => n.props['accessibilityLabel'] === 'Captured clip poster',
      ),
    ).toHaveLength(0);
    expect(text).toContain('STOP 1 OF 6');
    appendLog(
      LOG,
      `clip+sidecar missing texts: ${JSON.stringify(audit.texts.map(t => t.text))}`,
    );
    expect(unnamed(audit)).toEqual([]);
  });

  it('no sidecar reference at all (review null): pose reader never called', async () => {
    mockLoadEvidence.mockResolvedValue(evidence({ review: null }));
    const renderer = await renderScreen();
    const audit = record_(renderer, 'ready.review_null', {});
    expect(mockLoadSequence).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain('STOP 1 OF 6');
    expect(unnamed(audit)).toEqual([]);
  });

  it('sequence edge cases: zero frames / all-invisible landmarks / single frame render without invented pose', async () => {
    const cases: { name: string; seq: ReviewPoseSequence }[] = [
      {
        name: 'zero_frames',
        seq: { frames: [], video: { width: 1080, height: 1920, fps: 30 } },
      },
      { name: 'invisible', seq: fullBodySequence(0) },
      {
        name: 'single_frame',
        seq: {
          frames: [fullBodySequence().frames[0]!],
          video: { width: 1080, height: 1920, fps: 30 },
        },
      },
      {
        name: 'nan_coords',
        seq: {
          frames: [
            frameAt(0, {
              head: { x: Number.NaN, y: Number.NaN },
              left_hip: { x: 0.5, y: 0.5 },
            }),
          ],
          video: { width: 1080, height: 1920, fps: 30 },
        },
      },
      {
        name: 'zero_video',
        seq: {
          frames: fullBodySequence().frames,
          video: { width: 0, height: 0, fps: 0 },
        },
      },
    ];
    for (const c of cases) {
      mockLoadSequence.mockResolvedValue(c.seq);
      const renderer = await renderScreen();
      await layoutStage(renderer);
      await press(renderer, 'form-review-next-stop');
      const audit = record_(renderer, `ready.sequence.${c.name}`, {
        frames: c.seq.frames.length,
        video: c.seq.video,
      });
      const text = allText(renderer);
      expect(text).toContain('STOP 2 OF 6');
      expect(text).not.toMatch(/NaN|Infinity|undefined|null/);
      expect(unnamed(audit)).toEqual([]);
      expect(audit.lexicon).toEqual([]);
      await act(async () => {
        renderer.unmount();
      });
      mounted.splice(mounted.indexOf(renderer), 1);
    }
  });

  it('abstained record (no scored analysis anywhere) → missing; legacy record.result → ready', async () => {
    mockLoadEvidence.mockResolvedValue(
      evidence({
        analysis: null,
        record: {
          ...record,
          result: null,
          uncertainty: { ...record.uncertainty, presentation: 'abstain' },
        },
      }),
    );
    let renderer = await renderScreen();
    let audit = record_(renderer, 'missing.abstained', {});
    expect(allText(renderer)).toContain('Review unavailable');
    expect(audit.lexicon).toEqual([]);

    mockLoadEvidence.mockResolvedValue(
      evidence({ analysis: null, record: { ...record, result: analysis } }),
    );
    renderer = await renderScreen();
    audit = record_(renderer, 'ready.legacy_record_result', {});
    expect(allText(renderer)).toContain('STOP 1 OF 6');
    expect(unnamed(audit)).toEqual([]);
  });

  it('pinned CTAs: re-analyze arms the same-intent handoff and opens the guided camera; back goes back', async () => {
    const renderer = await renderScreen();
    const audit = record_(renderer, 'ready.footer', {});
    const names = audit.controls.map(c => c.name);
    appendLog(LOG, `footer control names: ${JSON.stringify(names)}`);
    const reanalyze = audit.controls.find(
      c => c.testID === 'form-review-reanalyze',
    );
    const back = audit.controls.find(c => c.testID === 'form-review-back');
    expect(reanalyze).toBeDefined();
    expect(back).toBeDefined();
    expect(reanalyze!.issues.filter(i => /below_44/.test(i))).toEqual([]);
    expect(back!.issues.filter(i => /below_44/.test(i))).toEqual([]);

    await press(renderer, 'form-review-reanalyze');
    expect(peekTryAgainHandoff()).toMatchObject({
      declaredStroke: 'forehand_drive',
    });
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    await press(renderer, 'form-review-back');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('small hit targets and contrast failures are enumerated for the matrix (measured, not asserted away)', () => {
    const small = new Map<string, number>();
    const contrast = new Map<string, number>();
    for (const a of matrix) {
      for (const c of a.controls) {
        if (c.issues.some(i => /below_44/.test(i))) {
          small.set(
            `${c.testID ?? c.name}:${c.minHeight ?? c.height}`,
            (small.get(`${c.testID ?? c.name}:${c.minHeight ?? c.height}`) ??
              0) + 1,
          );
        }
      }
      for (const t of a.texts) {
        if (t.passes === false) {
          const k = `${t.text.slice(0, 40)}|${t.color}|${t.background}|${t.contrast}|${t.fontSize}`;
          contrast.set(k, (contrast.get(k) ?? 0) + 1);
        }
      }
    }
    writeArtifact('formreview-issue-rollup.json', {
      smallTargets: [...small.entries()],
      contrastBelowAA: [...contrast.entries()],
    });
    expect(matrix.length).toBeGreaterThanOrEqual(25);
  });
});
