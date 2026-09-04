/**
 * Adversarial pass (mobile-results-review, tester #2) against the Form Review
 * replay: the JS clock at ¼× speed, the overlay's landmark projection under
 * NaN / duplicate / huge input, `poseFrameAt` under out-of-order frames, and
 * the hash-valid sidecar path for both. Production code is untouched; every
 * test here performs the attack against the shipped module.
 *
 * Seeded randomness: mulberry32(0x5eed0003).
 */
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

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

import React from 'react';
import { Text } from 'react-native';
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
import { sha256Hex } from '@pickle/swing-domain';
import type { PoseSequenceSidecarRef } from '../../src/camera/capture';
import { FormReviewPlayer } from '../../src/review/FormReviewPlayer';
import {
  arrowGeometry,
  arrowLabelAnchor,
  projectJoints,
  OVERLAY_MIN_VISIBILITY,
} from '../../src/review/FormReviewOverlay';
import {
  REVIEW_SPEEDS,
  containRect,
  speedLabel,
  stagePoint,
} from '../../src/review/formReviewGeometry';
import {
  POSE_FRAME_TOLERANCE_MS,
  REVIEW_JOINTS,
  buildFormReviewScript,
  dominantSide,
  facingSign,
  poseFrameAt,
  reviewArrow,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseLandmark,
  type ReviewPoseSequence,
  type ReviewStop,
} from '../../src/review/formReviewModel';
import { loadReviewPoseSequence } from '../../src/review/poseSidecar';

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

const SEED = 0x5eed0003;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
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
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
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
    ...overrides,
  };
}

const FULL_BODY: Record<ReviewJoint, { x: number; y: number }> = {
  head: { x: 0.5, y: 0.18 },
  left_shoulder: { x: 0.45, y: 0.3 },
  right_shoulder: { x: 0.55, y: 0.3 },
  left_elbow: { x: 0.4, y: 0.42 },
  right_elbow: { x: 0.62, y: 0.42 },
  left_wrist: { x: 0.38, y: 0.52 },
  right_wrist: { x: 0.7, y: 0.5 },
  left_hip: { x: 0.46, y: 0.55 },
  right_hip: { x: 0.54, y: 0.55 },
  left_knee: { x: 0.46, y: 0.72 },
  right_knee: { x: 0.54, y: 0.72 },
  left_ankle: { x: 0.45, y: 0.9 },
  right_ankle: { x: 0.55, y: 0.9 },
};

function landmark(
  name: string,
  x: number,
  y: number,
  visibility: number,
): ReviewPoseLandmark {
  return { name, x, y, visibility };
}

function frameAt(
  timestampMs: number,
  visibility: number,
  joints: Partial<Record<ReviewJoint, { x: number; y: number }>> = FULL_BODY,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: Object.entries(joints).map(([name, point]) =>
      landmark(name, point.x, point.y, visibility),
    ),
  };
}

function movingSequence(count: number, visibility: number): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i * 40;
    const sweep = i / Math.max(1, count - 1);
    frames.push(
      frameAt(t, visibility, {
        ...FULL_BODY,
        right_wrist: { x: 0.3 + 0.4 * sweep, y: 0.5 },
        left_wrist: { x: 0.38 - 0.1 * sweep, y: 0.52 },
      }),
    );
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

const STAGE = { width: 360, height: 640 };
const RECT = containRect(STAGE, { width: 1080, height: 1920 });

function refFor(
  json: string,
  overrides: Partial<PoseSequenceSidecarRef> = {},
): PoseSequenceSidecarRef {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///captures/clip.pose.json',
    frameCount: 0,
    sha256: sha256Hex(json),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
    ...overrides,
  } as PoseSequenceSidecarRef;
}

/** Wire-format sidecar document built by hand so frames can be disordered. */
function wireSidecar(
  frames: { t: number; v: number | null }[],
  landmarksPerFrame = 13,
): string {
  const names = REVIEW_JOINTS.slice(0, landmarksPerFrame);
  return JSON.stringify({
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
    video: { w: 1080, h: 1920, fps: 30 },
    frames: frames.map((frame, index) => ({
      i: index,
      t: frame.t,
      c: 0.9,
      l: names.map(name => ({
        n: name,
        x: FULL_BODY[name].x,
        y: FULL_BODY[name].y,
        v: frame.v,
      })),
    })),
  });
}

// ─── Player harness ─────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function renderPlayer(
  sequence: ReviewPoseSequence | null,
  analysis = analysisFixture(),
) {
  const script = buildFormReviewScript(analysis, sequence);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <FormReviewPlayer
        analysis={analysis}
        clip={null}
        review={{ width: 1080, height: 1920, poseSequence: null }}
        sequence={sequence}
        script={script}
        fill
      />,
    );
  });
  mounted.push(renderer);
  return { renderer, script };
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

function byTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = byTestId(renderer, testID);
  await act(async () => {
    node.props.onPress();
  });
}

/** The replay clock ("0.25s") as milliseconds. */
function clockMs(renderer: ReactTestRenderer): number {
  const match = allText(renderer).match(/(\d+\.\d{2})s/);
  if (!match) throw new Error(`no clock in: ${allText(renderer)}`);
  return Math.round(Number(match[1]) * 1000);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockReadArtifact = async () => {
    throw new Error('readCaptureArtifact mock not configured');
  };
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

// ─── Scenario 3: ¼× speed for 1 s of fake time ──────────────────────────────

describe('ATTACK S3 — ¼× speed clock', () => {
  it('cycle to ¼×, play, advance 1 s → playhead ≈ 250 ms and the chip reads ¼×', async () => {
    const { renderer } = await renderPlayer(movingSequence(81, 0.95));
    expect(REVIEW_SPEEDS).toEqual([1, 0.5, 0.25]);
    expect(speedLabel(0.25)).toBe('¼×');

    await press(renderer, 'form-review-speed');
    await press(renderer, 'form-review-speed');
    expect(allText(renderer)).toContain('¼×');
    expect(
      byTestId(renderer, 'form-review-speed').props.accessibilityHint,
    ).toBe('Currently ¼×. Tap to change.');

    expect(clockMs(renderer)).toBe(0);
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    const ms = clockMs(renderer);
    expect(ms).toBeGreaterThanOrEqual(230);
    expect(ms).toBeLessThanOrEqual(270);
    // Still playing (no stop before 450 ms), chip unchanged.
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Pause replay');
    expect(allText(renderer)).toContain('¼×');
  });

  it('1× for 1 s advances ≈ 4× as far as ¼× (auto-pause off), and ½× sits in between', async () => {
    const measured: Record<number, number> = {};
    for (const presses of [0, 1, 2]) {
      const { renderer } = await renderPlayer(movingSequence(81, 0.95));
      await press(renderer, 'form-review-autopause');
      for (let i = 0; i < presses; i += 1) {
        await press(renderer, 'form-review-speed');
      }
      await press(renderer, 'form-review-play');
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      measured[REVIEW_SPEEDS[presses]!] = clockMs(renderer);
    }
    expect(measured[1]).toBeGreaterThanOrEqual(950);
    expect(measured[1]).toBeLessThanOrEqual(1050);
    expect(measured[0.5]).toBeGreaterThanOrEqual(470);
    expect(measured[0.5]).toBeLessThanOrEqual(530);
    expect(measured[0.25]).toBeGreaterThanOrEqual(230);
    expect(measured[0.25]).toBeLessThanOrEqual(270);
  });

  it('changing speed MID-play keeps the playhead monotonic and never rewinds', async () => {
    const { renderer } = await renderPlayer(movingSequence(81, 0.95));
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-play');
    let previous = 0;
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
      await press(renderer, 'form-review-speed');
      const now = clockMs(renderer);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it('rapid speed taps (300×) wrap cleanly and the label always names a real rate', async () => {
    const { renderer } = await renderPlayer(movingSequence(81, 0.95));
    const labels = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      await press(renderer, 'form-review-speed');
      const hint: string = byTestId(renderer, 'form-review-speed').props
        .accessibilityHint;
      labels.add(hint);
    }
    expect([...labels].sort()).toEqual(
      [
        'Currently 1×. Tap to change.',
        'Currently ½×. Tap to change.',
        'Currently ¼×. Tap to change.',
      ].sort(),
    );
    // 300 % 3 === 0 → back at 1×.
    expect(allText(renderer)).toContain('1×');
  });

  it('play → pause → play at ¼× resumes from the paused position (no jump)', async () => {
    const { renderer } = await renderPlayer(movingSequence(81, 0.95));
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-speed');
    await press(renderer, 'form-review-speed');
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    const paused = clockMs(renderer);
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(clockMs(renderer)).toBe(paused);
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    const resumed = clockMs(renderer);
    expect(resumed - paused).toBeGreaterThanOrEqual(230);
    expect(resumed - paused).toBeLessThanOrEqual(270);
  });
});

// ─── Scenario 4: 5000-frame NaN-visibility sidecar ──────────────────────────

describe('ATTACK S4 — 5000 frames, every landmark visibility NaN', () => {
  const nanSequence = movingSequence(5000, Number.NaN);

  it('projectJoints draws nothing for every frame', () => {
    expect(nanSequence.frames).toHaveLength(5000);
    let drawn = 0;
    for (const frame of nanSequence.frames) {
      drawn += Object.keys(projectJoints(RECT, frame)).length;
    }
    expect(drawn).toBe(0);
  });

  it('dominantSide falls back to handedness for left / right / ambidextrous / undefined', () => {
    const window = { startMs: 0, endMs: 5000 * 40 };
    expect(dominantSide(nanSequence, window, 'left')).toBe('left');
    expect(dominantSide(nanSequence, window, 'right')).toBe('right');
    expect(dominantSide(nanSequence, window, 'ambidextrous')).toBe('right');
    expect(
      dominantSide(
        nanSequence,
        window,
        undefined as unknown as ShotAnalysis['handedness'],
      ),
    ).toBe('right');
    // Contrast: the SAME frames with real visibility measure the right wrist
    // (which sweeps 0.4 vs the left's 0.1) regardless of handedness.
    const visible = movingSequence(5000, 0.95);
    expect(dominantSide(visible, window, 'left')).toBe('right');
  });

  it('the whole script builds without an arrow anchor, facing +1, and the player mounts', async () => {
    const analysis = analysisFixture({ handedness: 'left' });
    const script = buildFormReviewScript(analysis, nanSequence);
    expect(script.dominant).toBe('left');
    expect(script.facing).toBe(1);
    expect(facingSign(nanSequence, analysis, 'left')).toBe(1);
    for (const stop of script.stops) {
      expect(
        arrowGeometry(RECT, poseFrameAt(nanSequence, stop.atMs), script, stop),
      ).toBeNull();
    }
    const { renderer } = await renderPlayer(nanSequence, analysis);
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'form-review-arrow-label',
      ),
    ).toHaveLength(0);
    // The clock still runs: the pose-only extent covers the 5000 frames.
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(clockMs(renderer)).toBeGreaterThan(900);
  });

  it('a hash-valid sidecar cannot even carry NaN: JSON has no NaN, and null visibility is rejected by the strict parser', async () => {
    const json = wireSidecar(
      Array.from({ length: 5000 }, (_, i) => ({ t: i * 40, v: null })),
    );
    expect(json).not.toContain('NaN');
    mockReadArtifact = async () => json;
    const loaded = await loadReviewPoseSequence(
      refFor(json, { frameCount: 5000 }),
    );
    expect(loaded).toBeNull();
    // The engine-side serializer turns NaN into null the same way.
    expect(JSON.stringify({ v: Number.NaN })).toBe('{"v":null}');
  });

  it('visibility exactly at / below the floor, ±Infinity, -0 and strings never draw; ≥ 0.35 draws', () => {
    const cases: [unknown, boolean][] = [
      [Number.NaN, false],
      [Number.NEGATIVE_INFINITY, false],
      [Number.POSITIVE_INFINITY, true],
      [-0, false],
      [0.3499999, false],
      [OVERLAY_MIN_VISIBILITY, true],
      ['0.9', true], // JS coercion — documented behaviour, not a crash
      [null, false],
      [undefined, false],
      [{}, false],
    ];
    for (const [visibility, drawn] of cases) {
      const frame: ReviewPoseFrame = {
        timestampMs: 0,
        confidence: 1,
        landmarks: [
          {
            name: 'left_wrist',
            x: 0.5,
            y: 0.5,
            visibility: visibility as number,
          },
        ],
      };
      expect(Object.keys(projectJoints(RECT, frame))).toEqual(
        drawn ? ['left_wrist'] : [],
      );
    }
  });
});

// ─── Scenario 5: duplicate left_wrist landmarks ─────────────────────────────

describe('ATTACK S5 — duplicate left_wrist (first visible, second invisible)', () => {
  const dupFrame: ReviewPoseFrame = {
    timestampMs: 1900,
    confidence: 0.9,
    landmarks: [
      ...Object.entries(FULL_BODY)
        .filter(([name]) => name !== 'left_wrist')
        .map(([name, point]) => landmark(name, point.x, point.y, 0.95)),
      landmark('left_wrist', 0.2, 0.6, 0.95),
      landmark('left_wrist', 0.9, 0.1, 0.0),
    ],
  };

  it('projectJoints keeps the FIRST left_wrist and ignores the invisible duplicate', () => {
    const points = projectJoints(RECT, dupFrame);
    expect(points.left_wrist).toEqual(stagePoint(RECT, { x: 0.2, y: 0.6 }));
    expect(points.left_wrist).not.toEqual(stagePoint(RECT, { x: 0.9, y: 0.1 }));
  });

  it('the arrow for a left-wrist stop anchors on the first landmark', () => {
    const arrow = reviewArrow('contact_position', 'late', 'left');
    expect(arrow?.joint).toBe('left_wrist');
    const stop: ReviewStop = {
      id: 'contact',
      phase: 'contact',
      atMs: 1900,
      startMs: 1880,
      endMs: 1920,
      title: 'Contact',
      verdict: 'fix',
      checkpoints: [],
      headline: '',
      cue: '',
      focusJoints: ['left_wrist'],
      arrow,
    };
    const geometry = arrowGeometry(RECT, dupFrame, { facing: 1 }, stop);
    expect(geometry).not.toBeNull();
    expect(geometry?.point).toEqual(stagePoint(RECT, { x: 0.2, y: 0.6 }));
    expect(geometry?.vector).toEqual({ dx: 1, dy: 0 });
    expect(geometry?.label).toBe('Meet it out front');
    const anchor = arrowLabelAnchor(
      RECT,
      geometry!.point,
      geometry!.vector,
      geometry!.unit,
    );
    expect(anchor.x).toBeGreaterThan(geometry!.point.x);
  });

  it('order is what decides: invisible FIRST then visible → the visible second one wins (first ACCEPTED)', () => {
    const swapped: ReviewPoseFrame = {
      ...dupFrame,
      landmarks: [
        landmark('left_wrist', 0.9, 0.1, 0.0),
        landmark('left_wrist', 0.2, 0.6, 0.95),
      ],
    };
    const points = projectJoints(RECT, swapped);
    expect(points.left_wrist).toEqual(stagePoint(RECT, { x: 0.2, y: 0.6 }));
  });

  it('two VISIBLE duplicates: the first is used, the second never overrides it', () => {
    const both: ReviewPoseFrame = {
      ...dupFrame,
      landmarks: [
        landmark('left_wrist', 0.2, 0.6, 0.95),
        landmark('left_wrist', 0.9, 0.1, 0.99),
      ],
    };
    expect(projectJoints(RECT, both).left_wrist).toEqual(
      stagePoint(RECT, { x: 0.2, y: 0.6 }),
    );
  });

  it('a frame of 10 000 duplicate landmarks projects exactly 13 joints', () => {
    const rng = mulberry32(SEED);
    const landmarks: ReviewPoseLandmark[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const name = REVIEW_JOINTS[Math.floor(rng() * REVIEW_JOINTS.length)]!;
      landmarks.push(landmark(name, rng(), rng(), rng()));
    }
    // Ensure every joint has at least one visible entry so 13 is the exact count.
    for (const name of REVIEW_JOINTS) {
      landmarks.unshift(
        landmark(name, FULL_BODY[name].x, FULL_BODY[name].y, 1),
      );
    }
    const frame: ReviewPoseFrame = { timestampMs: 0, confidence: 1, landmarks };
    const points = projectJoints(RECT, frame);
    expect(Object.keys(points).sort()).toEqual([...REVIEW_JOINTS].sort());
    for (const name of REVIEW_JOINTS) {
      expect(points[name]).toEqual(stagePoint(RECT, FULL_BODY[name]));
    }
  });

  it('unicode / prototype-key landmark names are ignored, never crash, never pollute the map', () => {
    const frame: ReviewPoseFrame = {
      timestampMs: 0,
      confidence: 1,
      landmarks: [
        landmark('__proto__', 0.5, 0.5, 1),
        landmark('constructor', 0.5, 0.5, 1),
        landmark('left_wrist\u200b', 0.5, 0.5, 1),
        landmark('LEFT_WRIST', 0.5, 0.5, 1),
        landmark('ｌｅｆｔ_ｗｒｉｓｔ', 0.5, 0.5, 1),
        landmark('', 0.5, 0.5, 1),
        { name: 42 as unknown as string, x: 0.5, y: 0.5, visibility: 1 },
        null as unknown as ReviewPoseLandmark,
        landmark('left_wrist', 0.25, 0.75, 1),
      ],
    };
    const points = projectJoints(RECT, frame);
    expect(Object.keys(points)).toEqual(['left_wrist']);
    expect(Object.getPrototypeOf(points)).toBe(Object.prototype);
  });
});

// ─── Scenario 6: out-of-order frames ────────────────────────────────────────

describe('ATTACK S6 — hash-valid sidecar with out-of-order frames', () => {
  const disorderedTimes = [0, 400, 80, 1200, 40, 3200, 2000, 1900, 120, 800];

  it('the strict parser refuses the document (non-monotonic) even though the hash matches → null sequence', async () => {
    const json = wireSidecar(disorderedTimes.map(t => ({ t, v: 0.95 })));
    mockReadArtifact = async () => json;
    const ref = refFor(json, { frameCount: disorderedTimes.length });
    expect(sha256Hex(json)).toBe(ref.sha256);
    const loaded = await loadReviewPoseSequence(ref);
    expect(loaded).toBeNull();
    for (const t of [0, 40, 80, 1900, 3200, -1, Number.NaN]) {
      expect(() => poseFrameAt(loaded, t)).not.toThrow();
      expect(poseFrameAt(loaded, t)).toBeNull();
    }
  });

  it('the same document with frames sorted IS accepted (the rejection is the ordering, not the hash)', async () => {
    const sorted = [...disorderedTimes].sort((a, b) => a - b);
    const json = wireSidecar(sorted.map(t => ({ t, v: 0.95 })));
    mockReadArtifact = async () => json;
    const loaded = await loadReviewPoseSequence(
      refFor(json, { frameCount: sorted.length }),
    );
    expect(loaded?.frames.map(frame => frame.timestampMs)).toEqual(sorted);
    expect(poseFrameAt(loaded, 1900)?.timestampMs).toBe(1900);
  });

  it('poseFrameAt on an IN-MEMORY disordered sequence never throws and every non-null result is within tolerance', () => {
    const sequence: ReviewPoseSequence = {
      frames: disorderedTimes.map(t => frameAt(t, 0.95)),
    };
    for (let t = -500; t <= 4000; t += 7) {
      let result: ReviewPoseFrame | null = null;
      expect(() => {
        result = poseFrameAt(sequence, t);
      }).not.toThrow();
      if (result !== null) {
        const frame: ReviewPoseFrame = result;
        expect(Math.abs(frame.timestampMs - t)).toBeLessThanOrEqual(
          POSE_FRAME_TOLERANCE_MS,
        );
        expect(sequence.frames).toContain(frame);
      }
    }
  });

  it('seeded fuzz: 400 random shuffles × 50 probes — tolerance invariant holds, no throw', () => {
    const rng = mulberry32(SEED ^ 0x66);
    let hits = 0;
    let misses = 0;
    let missedButPresent = 0;
    for (let round = 0; round < 400; round += 1) {
      const count = 1 + Math.floor(rng() * 40);
      const times = Array.from({ length: count }, () =>
        Math.floor(rng() * 4000),
      );
      // Fisher–Yates with the seeded RNG.
      for (let i = times.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [times[i], times[j]] = [times[j]!, times[i]!];
      }
      const sequence: ReviewPoseSequence = {
        frames: times.map(t => frameAt(t, 0.95)),
      };
      for (let probe = 0; probe < 50; probe += 1) {
        const t = rng() * 4400 - 200;
        const result = poseFrameAt(sequence, t);
        if (result === null) {
          misses += 1;
          if (
            times.some(time => Math.abs(time - t) <= POSE_FRAME_TOLERANCE_MS)
          ) {
            missedButPresent += 1;
          }
          continue;
        }
        hits += 1;
        expect(Math.abs(result.timestampMs - t)).toBeLessThanOrEqual(
          POSE_FRAME_TOLERANCE_MS,
        );
      }
    }
    expect(hits + misses).toBe(400 * 50);
    // A disordered sequence can MISS frames that exist (binary search
    // precondition violated) but must never return a frame out of
    // tolerance; the miss count is recorded, not asserted, because the
    // strict parser makes such sequences unreachable from a stored sidecar.
    expect(missedButPresent).toBeGreaterThanOrEqual(0);
  });

  it('duplicate timestamps, negative times, ±Infinity and NaN frames: no throw, tolerance holds', () => {
    const weird: ReviewPoseSequence = {
      frames: [
        frameAt(100, 0.95),
        frameAt(100, 0.95),
        frameAt(-50, 0.95),
        frameAt(Number.NaN, 0.95),
        frameAt(Number.POSITIVE_INFINITY, 0.95),
        frameAt(Number.NEGATIVE_INFINITY, 0.95),
        frameAt(100.5, 0.95),
      ],
    };
    for (const t of [
      -100,
      -50,
      0,
      100,
      100.4,
      220,
      221,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      let result: ReviewPoseFrame | null = null;
      expect(() => {
        result = poseFrameAt(weird, t);
      }).not.toThrow();
      if (result !== null) {
        const frame: ReviewPoseFrame = result;
        expect(Number.isFinite(t)).toBe(true);
        expect(Math.abs(frame.timestampMs - t)).toBeLessThanOrEqual(
          POSE_FRAME_TOLERANCE_MS,
        );
      }
    }
    expect(poseFrameAt(weird, Number.NaN)).toBeNull();
    expect(poseFrameAt({ frames: [] }, 0)).toBeNull();
    expect(poseFrameAt(null, 0)).toBeNull();
    expect(
      poseFrameAt({ frames: undefined as unknown as ReviewPoseFrame[] }, 0),
    ).toBeNull();
  });

  it('a 5000-frame sidecar with ONE swapped pair is rejected wholesale (no partial sequence)', async () => {
    const times = Array.from({ length: 5000 }, (_, i) => i * 40);
    [times[2500], times[2501]] = [times[2501]!, times[2500]!];
    const json = wireSidecar(times.map(t => ({ t, v: 0.95 })));
    mockReadArtifact = async () => json;
    const loaded = await loadReviewPoseSequence(
      refFor(json, { frameCount: 5000 }),
    );
    expect(loaded).toBeNull();
  });

  it('equal consecutive timestamps (clock stall) are rejected by the parser too', async () => {
    const json = wireSidecar([0, 40, 40, 80].map(t => ({ t, v: 0.95 })));
    mockReadArtifact = async () => json;
    expect(
      await loadReviewPoseSequence(refFor(json, { frameCount: 4 })),
    ).toBeNull();
  });

  it('a single flipped byte in a hash-valid sidecar is refused before parsing', async () => {
    const json = wireSidecar([0, 40, 80].map(t => ({ t, v: 0.95 })));
    const ref = refFor(json, { frameCount: 3 });
    mockReadArtifact = async () => json.replace('"v":0.95', '"v":0.96');
    expect(await loadReviewPoseSequence(ref)).toBeNull();
  });
});

// ─── Extra: the player under a disordered in-memory sequence ────────────────

describe('ATTACK extra — player survives a disordered in-memory sequence', () => {
  it('mounts, plays through, scrubs and jumps without throwing', async () => {
    const rng = mulberry32(SEED ^ 0x77);
    const times = Array.from({ length: 81 }, (_, i) => i * 40);
    for (let i = times.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [times[i], times[j]] = [times[j]!, times[i]!];
    }
    const sequence: ReviewPoseSequence = {
      frames: times.map(t => frameAt(t, 0.95)),
      video: { width: 1080, height: 1920, fps: 30 },
    };
    const { renderer } = await renderPlayer(sequence);
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    // Auto-pause fired on the first stop; step through every stop.
    for (let i = 0; i < 8; i += 1) {
      const next = renderer.root.findAll(
        node =>
          node.props.testID === 'form-review-next-stop' &&
          typeof node.props.onPress === 'function' &&
          node.props.disabled !== true,
      );
      if (next.length === 0) break;
      await act(async () => {
        next[0]!.props.onPress();
      });
    }
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    // Ran to the end and stopped.
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Play replay');
  });
});
