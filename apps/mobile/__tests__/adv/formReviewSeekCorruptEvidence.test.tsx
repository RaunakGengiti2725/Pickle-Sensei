/**
 * INT-ui-flows-a11y adversary — Form Review seeking against corrupt or
 * missing replay evidence.
 *
 * The adjustable timeline advertises `accessibilityValue {min, max, now}`;
 * VoiceOver reads `now` against `max`. Attacks:
 *  1. A persisted clip row whose durationMs is shorter than the scored
 *     analysis (corrupt persisted state) while the review is deep-linked to
 *     a checkpoint past that duration: `now` must never exceed `max`, and an
 *     increment must never move the playhead backwards.
 *  2. No clip and no pose sequence stored: seeking must still be bounded
 *     and the stage caption must be the honest "nothing stored" copy.
 *  3. The native player reports the stored file unreadable AFTER a seek:
 *     the caption switches to the honest missing-clip copy and seeking keeps
 *     working from the same position.
 *  4. Clip present, pose sequence missing: honest caption, seek bounded.
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
import { FormReviewPlayer } from '../../src/review/FormReviewPlayer';
import { ClipPlayer } from '../../src/components/ClipPlayer';
import {
  buildFormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
} from '../../src/review/formReviewModel';

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
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

const analysis: ShotAnalysis = {
  id: 'analysis-adv',
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

const review = {
  width: 1080,
  height: 1920,
  poseSequence: {
    schemaVersion: 1 as const,
    format: 'pickle.pose-sequence.v1' as const,
    uri: 'file:///captures/clip.pose.json',
    frameCount: 81,
    sha256: 'ab'.repeat(32),
    coordinateSystem: 'normalized_image_top_left' as const,
    poseModelVersion: 'apple-vision-bodypose-1',
  },
};

function frameAt(
  timestampMs: number,
  joints: Partial<Record<ReviewJoint, { x: number; y: number }>>,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: Object.entries(joints).map(([name, point]) => ({
      name,
      x: point.x,
      y: point.y,
      visibility: 0.95,
    })),
  };
}

function fullBodySequence(): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= 3200; t += 40) {
    const sweep = t / 3200;
    frames.push(
      frameAt(t, {
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
      }),
    );
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

const sequence = fullBodySequence();
const script = buildFormReviewScript(analysis, sequence);

const mounted: ReactTestRenderer[] = [];

type PlayerProps = React.ComponentProps<typeof FormReviewPlayer>;

async function renderPlayer(overrides: Partial<PlayerProps>) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <FormReviewPlayer
        analysis={analysis}
        clip={null}
        review={review}
        sequence={sequence}
        script={script}
        {...overrides}
      />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

function timeline(renderer: ReactTestRenderer) {
  const [host] = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'form-review-timeline',
  );
  if (!host) throw new Error('no form-review-timeline host');
  return host;
}

function a11yValue(renderer: ReactTestRenderer): {
  min: number;
  max: number;
  now: number;
  text: string;
} {
  return timeline(renderer).props.accessibilityValue;
}

async function voiceOver(
  renderer: ReactTestRenderer,
  actionName: 'increment' | 'decrement',
) {
  const host = timeline(renderer);
  await act(async () => {
    host.props.onAccessibilityAction({ nativeEvent: { actionName } });
  });
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

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

describe('adv: Form Review seeking against corrupt / missing evidence', () => {
  const corruptClip = {
    uri: 'file:///captures/clip.mov',
    durationMs: 1000,
    posterUri: 'file:///captures/clip.poster.jpg',
  };
  const contactStop = script.stops.find(stop => stop.atMs >= 1800);

  it('deep link to a checkpoint past a corrupt (too short) clip duration keeps the spoken value within [min, max]', async () => {
    expect(contactStop).toBeDefined();
    const renderer = await renderPlayer({
      clip: corruptClip,
      initialStop: contactStop!,
    });
    const opened = a11yValue(renderer);
    expect(opened.min).toBe(0);
    expect(opened.now).toBeGreaterThanOrEqual(opened.min);
    expect(opened.now).toBeLessThanOrEqual(opened.max);
  });

  it('deep link past a corrupt clip duration: a VoiceOver increment never moves the playhead backwards', async () => {
    expect(contactStop).toBeDefined();
    const renderer = await renderPlayer({
      clip: corruptClip,
      initialStop: contactStop!,
    });
    const before = a11yValue(renderer).now;
    await voiceOver(renderer, 'increment');
    const after = a11yValue(renderer).now;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThanOrEqual(a11yValue(renderer).max);
  });

  it('no clip and no pose sequence: honest caption, bounded seek over the measured extent', async () => {
    const renderer = await renderPlayer({
      clip: null,
      sequence: null,
      review: null,
      script: buildFormReviewScript(analysis, null),
    });
    expect(allText(renderer)).toContain(
      'No clip file or recorded pose is stored for this stroke on this device.',
    );
    const { max } = a11yValue(renderer);
    expect(max).toBeGreaterThanOrEqual(3200);
    for (let i = 0; i < 30; i += 1) await voiceOver(renderer, 'increment');
    expect(a11yValue(renderer).now).toBe(max);
    for (let i = 0; i < 30; i += 1) await voiceOver(renderer, 'decrement');
    expect(a11yValue(renderer).now).toBe(0);
  });

  it('clip reported unreadable after a seek: caption turns honest and the playhead position is kept', async () => {
    const clip = {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    };
    const renderer = await renderPlayer({ clip });
    await voiceOver(renderer, 'increment');
    await voiceOver(renderer, 'increment');
    const seeked = a11yValue(renderer).now;
    expect(seeked).toBe(340);

    const player = renderer.root.findByType(ClipPlayer);
    await act(async () => {
      player.props.onError();
    });
    expect(renderer.root.findAllByType(ClipPlayer)).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'The clip file is gone from this device; the measured pose is shown instead.',
    );
    expect(a11yValue(renderer).now).toBe(seeked);
    await voiceOver(renderer, 'increment');
    expect(a11yValue(renderer).now).toBe(510);
    expect(a11yValue(renderer).max).toBe(3400);
  });

  it('clip present but no verified pose sequence: honest caption, bounded seek', async () => {
    const clip = {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    };
    const renderer = await renderPlayer({
      clip,
      sequence: null,
      script: buildFormReviewScript(analysis, null),
    });
    expect(allText(renderer)).toContain(
      'No verified pose sequence is stored for this clip, so the replay shows the video without an exoskeleton.',
    );
    for (let i = 0; i < 25; i += 1) await voiceOver(renderer, 'increment');
    expect(a11yValue(renderer).now).toBe(3400);
    expect(a11yValue(renderer).now).toBeLessThanOrEqual(
      a11yValue(renderer).max,
    );
  });
});
