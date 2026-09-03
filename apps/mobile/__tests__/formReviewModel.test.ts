import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  SHOT_TYPES,
  type CheckpointKey,
  type CheckpointScore,
  type FaultDirection,
  type PhaseKey,
  type PhaseSpan,
  type ScoreBand,
  type ShotAnalysis,
} from '@pickle/shared-types';
import { parsePoseSequence, type PoseSequence } from '@pickle/swing-domain';
import {
  CHECKPOINT_PHASE,
  PHASE_TITLES,
  POSE_FRAME_TOLERANCE_MS,
  REVIEW_JOINTS,
  SKELETON_SEGMENTS,
  buildFormReviewScript,
  checkpointJoints,
  coachingCue,
  dominantSide,
  facingSign,
  fixList,
  jointHeatAt,
  poseFrameAt,
  reviewArrow,
  reviewVideoSize,
  stopHeadline,
  strengthList,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
} from '../src/review';

/**
 * Form review script — pure selectors over one ShotAnalysis plus its pose
 * sequence. Every stop, headline, cue, arrow and heat value must trace to a
 * scored checkpoint or a measured phase span; frames are never invented.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

const PHASES_FIXTURE: PhaseSpan[] = [
  phase('ready', 0, 900),
  phase('prepare', 900, 1500),
  phase('accelerate', 1500, 1900),
  phase('contact', 1880, 1920, 1900),
  phase('follow_through', 1920, 2400),
  phase('recover', 2400, 3200),
];

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

const CHECKPOINTS_FIXTURE: CheckpointScore[] = [
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
];

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: PHASES_FIXTURE.map(span => ({ ...span })),
    measurements: [],
    checkpoints: CHECKPOINTS_FIXTURE.map(cp => ({ ...cp })),
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

type JointPoint = { x: number; y: number; v?: number };

function frameAt(
  timestampMs: number,
  joints: Partial<Record<ReviewJoint, JointPoint>>,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: Object.entries(joints).map(([name, point]) => ({
      name,
      x: point.x,
      y: point.y,
      visibility: point.v ?? 0.95,
    })),
  };
}

function sequenceOf(frames: ReviewPoseFrame[]): ReviewPoseSequence {
  return { frames, video: { w: 1080, h: 1920, fps: 30 } };
}

/** 40ms frames across the fixture clip; `wrists(t)` places both wrists. */
function wristSequence(
  wrists: (t: number) => { left: JointPoint; right: JointPoint },
): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= 3200; t += 40) {
    const { left, right } = wrists(t);
    frames.push(
      frameAt(t, {
        left_shoulder: { x: 0.45, y: 0.3 },
        right_shoulder: { x: 0.55, y: 0.3 },
        left_hip: { x: 0.46, y: 0.55 },
        right_hip: { x: 0.54, y: 0.55 },
        left_wrist: left,
        right_wrist: right,
      }),
    );
  }
  return sequenceOf(frames);
}

const stopByPhase = (
  script: ReturnType<typeof buildFormReviewScript>,
  key: PhaseKey,
) => {
  const stop = script.stops.find(entry => entry.phase === key);
  if (!stop) throw new Error(`expected a ${key} stop`);
  return stop;
};

// ─── Vocabulary ─────────────────────────────────────────────────────────────

describe('review vocabulary', () => {
  it('13 joints, 12 skeleton segments over known joints only', () => {
    expect(REVIEW_JOINTS).toHaveLength(13);
    expect(new Set(REVIEW_JOINTS).size).toBe(13);
    expect(SKELETON_SEGMENTS).toHaveLength(12);
    for (const [a, b] of SKELETON_SEGMENTS) {
      expect(REVIEW_JOINTS).toContain(a);
      expect(REVIEW_JOINTS).toContain(b);
      expect(a).not.toBe(b);
    }
    // The neck (head ↔ shoulder midpoint) is the caller's; head is unpaired.
    expect(SKELETON_SEGMENTS.flat()).not.toContain('head');
  });

  it('every checkpoint maps to a phase that has a title', () => {
    for (const key of CHECKPOINTS) {
      expect(PHASE_TITLES[CHECKPOINT_PHASE[key]]).toBeTruthy();
    }
    expect(CHECKPOINT_PHASE.contact_position).toBe('contact');
    expect(CHECKPOINT_PHASE.recovery).toBe('recover');
    expect(PHASE_TITLES.follow_through).toBe('Follow-through');
  });

  it('checkpointJoints is dominant-side aware and never empty', () => {
    for (const key of CHECKPOINTS) {
      for (const side of ['left', 'right'] as const) {
        const joints = checkpointJoints(key, side);
        expect(joints.length).toBeGreaterThan(0);
        for (const joint of joints) expect(REVIEW_JOINTS).toContain(joint);
      }
    }
    expect(checkpointJoints('contact_position', 'left')).toEqual([
      'left_wrist',
      'left_elbow',
      'left_shoulder',
    ]);
    expect(checkpointJoints('contact_position', 'right')).toEqual([
      'right_wrist',
      'right_elbow',
      'right_shoulder',
    ]);
    expect(checkpointJoints('preparation', 'left')).toContain('left_elbow');
    expect(checkpointJoints('preparation', 'left')).not.toContain(
      'right_elbow',
    );
    expect(checkpointJoints('athletic_base', 'right')).toEqual(
      expect.arrayContaining(['left_knee', 'right_knee', 'left_ankle']),
    );
    expect(checkpointJoints('ready_position', 'right')).toEqual([
      'right_wrist',
      'left_hip',
      'right_hip',
    ]);
    expect(checkpointJoints('recovery', 'right')).toEqual(
      expect.arrayContaining(['left_wrist', 'right_wrist', 'left_ankle']),
    );
  });
});

// ─── Cues, arrows, headlines ────────────────────────────────────────────────

describe('coachingCue', () => {
  it('is non-empty, trimmed and ≤ 160 chars for EVERY checkpoint × direction × shot', () => {
    for (const key of CHECKPOINTS) {
      for (const direction of FAULT_DIRECTIONS) {
        for (const shotType of SHOT_TYPES) {
          const cue = coachingCue(key, direction, shotType);
          expect(typeof cue).toBe('string');
          expect(cue.length).toBeGreaterThan(0);
          expect(cue.length).toBeLessThanOrEqual(160);
          expect(cue).toBe(cue.trim());
          expect(cue).not.toMatch(/\s{2,}/);
        }
      }
    }
  });

  it("'none' is a positive cue that differs from the measured-fault cue", () => {
    const keep = coachingCue('contact_position', 'none', 'forehand_drive');
    const late = coachingCue('contact_position', 'late', 'forehand_drive');
    expect(keep).not.toBe(late);
    expect(keep).toMatch(/Keep/);
    expect(late).toMatch(/front/i);
  });

  it('matches the measured direction, not its opposite', () => {
    expect(coachingCue('paddle_path', 'low', 'forehand_drive')).toMatch(
      /low-to-high/,
    );
    expect(coachingCue('paddle_path', 'high', 'forehand_drive')).toMatch(
      /steep|flatten/,
    );
    expect(coachingCue('athletic_base', 'narrow', 'dink')).toMatch(/Widen/);
    expect(coachingCue('athletic_base', 'low', 'dink')).toMatch(/lower|knees/i);
    expect(coachingCue('contact_position', 'early', 'forehand_drive')).toMatch(
      /come to you/,
    );
    expect(coachingCue('face_wrist_stability', 'unstable', 'volley')).toMatch(
      /firm wrist/i,
    );
  });

  it('is shot-aware where the technique differs', () => {
    expect(coachingCue('swing_length', 'long', 'dink')).toMatch(/compact/);
    expect(coachingCue('swing_length', 'long', 'volley')).toMatch(
      /No backswing/,
    );
    expect(coachingCue('contact_position', 'high', 'serve')).toMatch(/waist/);
    expect(coachingCue('paddle_set', 'low', 'overhead')).toMatch(
      /behind your head/,
    );
    expect(coachingCue('paddle_path', 'low', 'serve')).toMatch(/upward/);
    expect(coachingCue('contact_position', 'late', 'forehand_drive')).toMatch(
      /front hip/,
    );
  });

  it('never claims medical outcomes or promises results', () => {
    for (const key of CHECKPOINTS) {
      for (const direction of FAULT_DIRECTIONS) {
        for (const shotType of SHOT_TYPES) {
          expect(coachingCue(key, direction, shotType)).not.toMatch(
            /guarantee|injur|pain|always win|never miss|cure|prevent/i,
          );
        }
      }
    }
  });
});

describe('reviewArrow', () => {
  it("returns null for 'none' and for directions a checkpoint never produces", () => {
    for (const key of CHECKPOINTS) {
      expect(reviewArrow(key, 'none', 'right')).toBeNull();
    }
    expect(reviewArrow('contact_position', 'wide', 'right')).toBeNull();
    expect(reviewArrow('recovery', 'short', 'left')).toBeNull();
  });

  it('anchors a late contact on the dominant wrist, pointing forward', () => {
    expect(reviewArrow('contact_position', 'late', 'right')).toEqual({
      joint: 'right_wrist',
      direction: 'forward',
      label: 'Meet it out front',
    });
    expect(reviewArrow('contact_position', 'late', 'left')?.joint).toBe(
      'left_wrist',
    );
    expect(reviewArrow('contact_position', 'early', 'left')?.direction).toBe(
      'back',
    );
    expect(reviewArrow('contact_position', 'low', 'left')?.direction).toBe(
      'up',
    );
  });

  it('maps the measured lower-body and set faults', () => {
    expect(reviewArrow('athletic_base', 'narrow', 'left')).toEqual({
      joint: 'left_ankle',
      direction: 'wider',
      label: 'Widen your base',
    });
    expect(reviewArrow('athletic_base', 'low', 'right')).toEqual({
      joint: 'right_knee',
      direction: 'down',
      label: 'Bend more',
    });
    expect(reviewArrow('paddle_set', 'high', 'right')?.direction).toBe('down');
    expect(reviewArrow('paddle_set', 'low', 'right')?.direction).toBe('up');
    expect(reviewArrow('paddle_path', 'low', 'right')).toEqual({
      joint: 'right_wrist',
      direction: 'up',
      label: 'Finish higher',
    });
    expect(reviewArrow('face_wrist_stability', 'unstable', 'right')).toEqual({
      joint: 'right_wrist',
      direction: 'steadier',
      label: 'Firm wrist',
    });
    expect(reviewArrow('follow_through', 'short', 'left')?.direction).toBe(
      'forward',
    );
    expect(reviewArrow('preparation', 'short', 'right')).toEqual({
      joint: 'right_shoulder',
      direction: 'back',
      label: 'Turn more',
    });
    expect(reviewArrow('preparation', 'long', 'right')?.direction).toBe(
      'forward',
    );
    expect(reviewArrow('swing_length', 'long', 'right')).toEqual({
      joint: 'right_wrist',
      direction: 'forward',
      label: 'Shorter backswing',
    });
  });

  it('every arrow joint is a known joint on the requested side or bilateral', () => {
    for (const key of CHECKPOINTS) {
      for (const direction of FAULT_DIRECTIONS) {
        const left = reviewArrow(key, direction, 'left');
        const right = reviewArrow(key, direction, 'right');
        if (left) {
          expect(REVIEW_JOINTS).toContain(left.joint);
          expect(left.joint.startsWith('right_')).toBe(false);
          expect(left.label.length).toBeGreaterThan(0);
        }
        if (right) expect(right.joint.startsWith('left_')).toBe(false);
        expect(left === null).toBe(right === null);
      }
    }
  });
});

describe('stopHeadline', () => {
  it('states the rounded score and the measured direction', () => {
    expect(
      stopHeadline({
        key: 'contact_position',
        name: 'Contact position',
        score: 48,
        band: 'red',
        direction: 'late',
        severity: 0.52,
      }),
    ).toBe('Contact position scored 48 — contact came late');
    expect(
      stopHeadline({
        key: 'paddle_path',
        name: 'Paddle path',
        score: 60.6,
        band: 'red',
        direction: 'low',
        severity: 0.39,
      }),
    ).toBe('Paddle path scored 61 — sat low');
    expect(
      stopHeadline({
        key: 'recovery',
        name: 'Recovery',
        score: 92.4,
        band: 'green',
        direction: 'none',
        severity: 0.08,
      }),
    ).toBe('Recovery scored 92 — held its target');
    expect(
      stopHeadline({
        key: 'face_wrist_stability',
        name: 'Face / wrist stability',
        score: 55,
        band: 'red',
        direction: 'unstable',
        severity: 0.45,
      }),
    ).toBe('Face / wrist stability scored 55 — wobbled');
  });
});

// ─── Pose frames ────────────────────────────────────────────────────────────

describe('poseFrameAt', () => {
  it('returns the nearest frame within tolerance, else null — never interpolates', () => {
    const sequence = sequenceOf([
      frameAt(0, { head: { x: 0.5, y: 0.1 } }),
      frameAt(1000, { head: { x: 0.5, y: 0.2 } }),
    ]);
    expect(POSE_FRAME_TOLERANCE_MS).toBe(120);
    expect(poseFrameAt(sequence, 119)?.timestampMs).toBe(0);
    expect(poseFrameAt(sequence, 120)?.timestampMs).toBe(0);
    expect(poseFrameAt(sequence, 121)).toBeNull();
    expect(poseFrameAt(sequence, 881)?.timestampMs).toBe(1000);
    expect(poseFrameAt(sequence, 500)).toBeNull();
    expect(poseFrameAt(sequence, -119)?.timestampMs).toBe(0);
    expect(poseFrameAt(sequence, 1119)?.timestampMs).toBe(1000);
    expect(poseFrameAt(sequence, 1121)).toBeNull();
  });

  it('handles null, empty and non-finite input', () => {
    expect(poseFrameAt(null, 100)).toBeNull();
    expect(poseFrameAt(sequenceOf([]), 100)).toBeNull();
    expect(
      poseFrameAt(sequenceOf([frameAt(0, { head: { x: 0, y: 0 } })]), NaN),
    ).toBeNull();
    const single = sequenceOf([frameAt(500, { head: { x: 0, y: 0 } })]);
    expect(poseFrameAt(single, 560)?.timestampMs).toBe(500);
    expect(poseFrameAt(single, 700)).toBeNull();
  });

  it('binary search agrees with a linear scan on 200 irregularly spaced frames', () => {
    const frames: ReviewPoseFrame[] = [];
    for (let index = 0; index < 200; index += 1) {
      frames.push(
        frameAt(index * 33 + (index % 3) * 5, { head: { x: 0, y: 0 } }),
      );
    }
    const sequence = sequenceOf(frames);
    const linear = (tMs: number): ReviewPoseFrame | null => {
      let best: ReviewPoseFrame | null = null;
      for (const frame of frames) {
        if (
          best === null ||
          Math.abs(frame.timestampMs - tMs) < Math.abs(best.timestampMs - tMs)
        ) {
          best = frame;
        }
      }
      return best && Math.abs(best.timestampMs - tMs) <= POSE_FRAME_TOLERANCE_MS
        ? best
        : null;
    };
    for (let tMs = -300; tMs <= 7200; tMs += 7) {
      expect(poseFrameAt(sequence, tMs)?.timestampMs).toBe(
        linear(tMs)?.timestampMs,
      );
    }
    // Exact hits and exact ties (earlier frame wins a tie).
    expect(poseFrameAt(sequence, 38)?.timestampMs).toBe(38);
    expect(poseFrameAt(sequence, 19)?.timestampMs).toBe(0);
  });

  it('accepts a parsed @pickle/swing-domain PoseSequence directly', () => {
    const wire = JSON.stringify({
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
      video: { w: 1080, h: 1920, fps: 30 },
      frames: [
        {
          i: 0,
          t: 0,
          c: 0.9,
          l: [{ n: 'right_wrist', x: 0.4, y: 0.5, v: 0.9 }],
        },
        {
          i: 1,
          t: 33,
          c: 0.9,
          l: [{ n: 'right_wrist', x: 0.5, y: 0.5, v: 0.9 }],
        },
      ],
    });
    const parsed = parsePoseSequence(wire, {
      providerId: 'pose.apple-vision',
      runtime: 'vision_framework',
      executionTarget: 'on_device',
      artifactHash: null,
    });
    if (!parsed.ok) throw new Error('fixture sidecar must parse');
    const sequence: PoseSequence = parsed.value;
    // Compile-time: the parsed value is a ReviewPoseSequence as-is.
    const review: ReviewPoseSequence = sequence;
    expect(poseFrameAt(review, 30)?.timestampMs).toBe(33);
    expect(reviewVideoSize(review)).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(reviewVideoSize(sequenceOf([]))).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(reviewVideoSize({ frames: [] })).toBeNull();
    expect(reviewVideoSize(null)).toBeNull();
    expect(() =>
      buildFormReviewScript(analysisFixture(), review),
    ).not.toThrow();
  });
});

// ─── Dominant side and facing ───────────────────────────────────────────────

describe('dominantSide', () => {
  const window = { startMs: 0, endMs: 3200 };

  it('picks the wrist with the longer measured path, overriding handedness', () => {
    const leftSwings = wristSequence(t => ({
      left: { x: 0.2 + (0.6 * t) / 3200, y: 0.5 },
      right: { x: 0.5, y: 0.5 },
    }));
    expect(dominantSide(leftSwings, window, 'right')).toBe('left');
    const rightSwings = wristSequence(t => ({
      left: { x: 0.5, y: 0.5 },
      right: { x: 0.8 - (0.6 * t) / 3200, y: 0.5 },
    }));
    expect(dominantSide(rightSwings, window, 'left')).toBe('right');
  });

  it('falls back to handedness when nothing was measured', () => {
    expect(dominantSide(null, window, 'left')).toBe('left');
    expect(dominantSide(null, window, 'right')).toBe('right');
    expect(dominantSide(null, window, 'ambidextrous')).toBe('right');
    expect(dominantSide(sequenceOf([]), window, 'left')).toBe('left');
    // Frames exist but no wrist clears the visibility floor.
    const blind = wristSequence(() => ({
      left: { x: 0.2, y: 0.5, v: 0.1 },
      right: { x: 0.8, y: 0.5, v: 0.1 },
    }));
    expect(dominantSide(blind, window, 'left')).toBe('left');
    // Frames outside the window do not count.
    const swings = wristSequence(t => ({
      left: { x: 0.2 + (0.6 * t) / 3200, y: 0.5 },
      right: { x: 0.5, y: 0.5 },
    }));
    expect(dominantSide(swings, { startMs: 5000, endMs: 6000 }, 'right')).toBe(
      'right',
    );
  });
});

describe('facingSign', () => {
  const analysis = analysisFixture();

  it('is +1 when the dominant wrist travels image-right into contact, -1 when image-left', () => {
    const facesRight = wristSequence(t => ({
      left: { x: 0.45, y: 0.5 },
      right: {
        x: 0.3 + (0.3 * Math.min(Math.max(t - 1500, 0), 400)) / 400,
        y: 0.5,
      },
    }));
    expect(facingSign(facesRight, analysis, 'right')).toBe(1);
    const facesLeft = wristSequence(t => ({
      left: { x: 0.45, y: 0.5 },
      right: {
        x: 0.7 - (0.3 * Math.min(Math.max(t - 1500, 0), 400)) / 400,
        y: 0.5,
      },
    }));
    expect(facingSign(facesLeft, analysis, 'right')).toBe(-1);
  });

  it('falls back to +1 when unmeasurable', () => {
    expect(facingSign(null, analysis, 'right')).toBe(1);
    expect(facingSign(sequenceOf([]), analysis, 'left')).toBe(1);
    // A still wrist has no measurable facing.
    const still = wristSequence(() => ({
      left: { x: 0.45, y: 0.5 },
      right: { x: 0.55, y: 0.5 },
    }));
    expect(facingSign(still, analysis, 'right')).toBe(1);
    // Frames too far from the accelerate start / contact times.
    const sparse = sequenceOf([
      frameAt(0, { right_wrist: { x: 0.9, y: 0.5 } }),
      frameAt(3200, { right_wrist: { x: 0.1, y: 0.5 } }),
    ]);
    expect(facingSign(sparse, analysis, 'right')).toBe(1);
    // No phases → no accelerate→contact window to measure.
    const facesLeft = wristSequence(t => ({
      left: { x: 0.45, y: 0.5 },
      right: { x: 0.7 - (0.3 * t) / 3200, y: 0.5 },
    }));
    expect(
      facingSign(facesLeft, analysisFixture({ phases: [] }), 'right'),
    ).toBe(1);
  });
});

// ─── Script ─────────────────────────────────────────────────────────────────

describe('buildFormReviewScript', () => {
  const script = buildFormReviewScript(analysisFixture(), null);

  it('creates one stop per phase owning a scored checkpoint, ordered by time', () => {
    expect(script.shotType).toBe('forehand_drive');
    expect(script.dominant).toBe('right');
    expect(script.facing).toBe(1);
    expect(script.stops.map(stop => stop.phase)).toEqual([
      'ready',
      'prepare',
      'accelerate',
      'contact',
      'follow_through',
      'recover',
    ]);
    expect(script.stops.map(stop => stop.atMs)).toEqual([
      450, 1200, 1700, 1900, 2160, 2800,
    ]);
    expect(new Set(script.stops.map(stop => stop.id)).size).toBe(6);
    for (const stop of script.stops) {
      expect(stop.title).toBe(PHASE_TITLES[stop.phase]);
      expect(stop.startMs).toBeLessThanOrEqual(stop.atMs);
      expect(stop.atMs).toBeLessThanOrEqual(stop.endMs);
      expect(stop.headline.length).toBeGreaterThan(0);
      expect(stop.cue.length).toBeGreaterThan(0);
      expect(stop.focusJoints.length).toBeGreaterThan(0);
    }
  });

  it('verdicts follow the worst band in each stop', () => {
    expect(script.stops.map(stop => stop.verdict)).toEqual([
      'watch',
      'strong',
      'fix',
      'fix',
      'strong',
      'strong',
    ]);
  });

  it('excludes inapplicable and unscored checkpoints', () => {
    const keys = script.stops.flatMap(stop =>
      stop.checkpoints.map(cp => cp.key),
    );
    expect(keys).not.toContain('face_wrist_stability');
    expect(keys).not.toContain('swing_length');
    expect(keys).toHaveLength(9);
    expect(
      stopByPhase(script, 'contact').checkpoints.map(cp => cp.key),
    ).toEqual(['contact_position']);
  });

  it('orders checkpoints worst-first inside a stop', () => {
    const accelerate = stopByPhase(script, 'accelerate');
    expect(accelerate.checkpoints.map(cp => cp.key)).toEqual([
      'paddle_path',
      'sequencing',
    ]);
    const ready = stopByPhase(script, 'ready');
    expect(ready.checkpoints.map(cp => cp.score)).toEqual([72, 85]);
  });

  it('headline is the measured fact for the worst checkpoint; cue and arrow match it', () => {
    const contact = stopByPhase(script, 'contact');
    expect(contact.headline).toBe(
      'Contact position scored 48 — contact came late',
    );
    expect(contact.cue).toBe(
      coachingCue('contact_position', 'late', 'forehand_drive'),
    );
    expect(contact.arrow).toEqual({
      joint: 'right_wrist',
      direction: 'forward',
      label: 'Meet it out front',
    });
    expect(contact.focusJoints).toEqual([
      'right_wrist',
      'right_elbow',
      'right_shoulder',
    ]);

    const ready = stopByPhase(script, 'ready');
    expect(ready.headline).toBe('Athletic base scored 72 — was narrow');
    expect(ready.arrow?.direction).toBe('wider');
    // Focus joints come from the non-green checkpoints only.
    expect(ready.focusJoints).not.toContain('right_wrist');
    expect(ready.focusJoints).toEqual(
      expect.arrayContaining(['left_ankle', 'right_ankle', 'left_knee']),
    );
  });

  it('strong stops use the positive cue, no arrow, and focus the worst checkpoint', () => {
    const follow = stopByPhase(script, 'follow_through');
    expect(follow.verdict).toBe('strong');
    expect(follow.headline).toBe('Follow-through scored 80 — was short');
    expect(follow.cue).toBe(
      coachingCue('follow_through', 'none', 'forehand_drive'),
    );
    expect(follow.arrow).toBeNull();
    expect(follow.focusJoints).toEqual([
      'right_wrist',
      'right_elbow',
      'right_shoulder',
    ]);
  });

  it('static jointHeat is 0..1 and lands only on fault joints', () => {
    const heat = script.jointHeat;
    for (const [joint, value] of Object.entries(heat)) {
      expect(REVIEW_JOINTS).toContain(joint);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(heat.right_wrist).toBeCloseTo(0.52, 6);
    expect(heat.right_elbow).toBeCloseTo(0.52, 6);
    expect(heat.right_shoulder).toBeCloseTo(0.52, 6);
    expect(heat.left_hip).toBeCloseTo(0.28, 6);
    expect(heat.right_knee).toBeCloseTo(0.28, 6);
    expect(heat.left_ankle).toBeCloseTo(0.28, 6);
    expect(heat.head).toBeUndefined();
    expect(heat.left_wrist).toBeUndefined();
    expect(heat.left_elbow).toBeUndefined();
    expect(heat.left_shoulder).toBeUndefined();
  });

  it('reports the strongest and weakest scored checkpoints', () => {
    expect(script.strongest?.key).toBe('recovery');
    expect(script.strongest?.score).toBe(92);
    expect(script.weakest?.key).toBe('contact_position');
    expect(script.weakest?.score).toBe(48);
  });

  it('ties keep CHECKPOINTS order', () => {
    const tied = buildFormReviewScript(
      analysisFixture({
        checkpoints: [
          checkpoint('recovery', 70, 'yellow', 'long'),
          checkpoint('athletic_base', 70, 'yellow', 'wide'),
          checkpoint('ready_position', 70, 'yellow', 'low'),
        ],
        priorityFix: null,
      }),
      null,
    );
    expect(tied.weakest?.key).toBe('ready_position');
    expect(tied.strongest?.key).toBe('ready_position');
    expect(stopByPhase(tied, 'ready').checkpoints.map(cp => cp.key)).toEqual([
      'ready_position',
      'athletic_base',
    ]);
  });

  it('the contact stop exists even with nothing scored there, and claims nothing', () => {
    const noContactScore = buildFormReviewScript(
      analysisFixture({
        checkpoints: CHECKPOINTS_FIXTURE.filter(
          cp => cp.key !== 'contact_position',
        ),
      }),
      null,
    );
    const contact = stopByPhase(noContactScore, 'contact');
    expect(contact.checkpoints).toEqual([]);
    expect(contact.verdict).toBe('strong');
    expect(contact.headline).toBe(
      'Contact — the fastest wrist moment in this swing.',
    );
    expect(contact.cue).toBe(
      'Watch where the paddle meets the ball relative to your front hip.',
    );
    expect(contact.arrow).toBeNull();
    expect(contact.focusJoints).toContain('right_wrist');
  });

  it('phases without scored checkpoints (other than contact) get no stop', () => {
    const sparse = buildFormReviewScript(
      analysisFixture({
        checkpoints: [checkpoint('contact_position', 48, 'red', 'late')],
      }),
      null,
    );
    expect(sparse.stops.map(stop => stop.phase)).toEqual(['contact']);
  });

  it('falls back to ONE contact stop with every scored checkpoint when phases are empty', () => {
    const fallback = buildFormReviewScript(
      analysisFixture({ phases: [] }),
      null,
    );
    expect(fallback.stops).toHaveLength(1);
    const only = fallback.stops[0];
    expect(only?.phase).toBe('contact');
    expect(only?.atMs).toBe(1900);
    expect(only?.startMs).toBe(0);
    expect(only?.endMs).toBe(3200);
    expect(only?.checkpoints).toHaveLength(9);
    expect(only?.checkpoints[0]?.key).toBe('contact_position');
    expect(only?.verdict).toBe('fix');
    expect(only?.headline).toBe(
      'Contact position scored 48 — contact came late',
    );

    const noContact = buildFormReviewScript(
      analysisFixture({
        phases: [],
        timestamps: { startMs: 1000, contactMs: null, endMs: 3000 },
      }),
      null,
    );
    expect(noContact.stops[0]?.atMs).toBe(2000);
  });

  it('uses the dominant side measured from the sequence', () => {
    const leftSwings = wristSequence(t => ({
      left: { x: 0.8 - (0.6 * t) / 3200, y: 0.5 },
      right: { x: 0.5, y: 0.5 },
    }));
    const lefty = buildFormReviewScript(analysisFixture(), leftSwings);
    expect(lefty.dominant).toBe('left');
    expect(lefty.facing).toBe(-1);
    expect(stopByPhase(lefty, 'contact').arrow?.joint).toBe('left_wrist');
    expect(lefty.jointHeat.left_wrist).toBeCloseTo(0.52, 6);
    expect(lefty.jointHeat.right_wrist).toBeUndefined();
  });

  it('does not throw on malformed input', () => {
    const malformed = analysisFixture({
      phases: [
        ...PHASES_FIXTURE,
        { ...phase('contact', 1880, 1920, 1900) },
        {
          key: 'warmup' as PhaseKey,
          startMs: 0,
          representativeMs: 0,
          endMs: 1,
          confidence: 1,
        },
        {
          key: 'ready',
          startMs: NaN,
          representativeMs: NaN,
          endMs: NaN,
          confidence: 1,
        },
      ],
      checkpoints: [
        ...CHECKPOINTS_FIXTURE,
        checkpoint('contact_position', 10, 'red', 'early'),
        checkpoint('paddle_set', NaN, 'red', 'high'),
        checkpoint('paddle_path', Infinity, 'green', 'none'),
        {
          ...checkpoint('recovery', 50, 'red', 'long'),
          key: 'mystery_checkpoint' as CheckpointKey,
        },
        checkpoint('ready_position', 40, 'red', 'sideways' as FaultDirection),
      ],
    });
    expect(() => buildFormReviewScript(malformed, null)).not.toThrow();
    const script2 = buildFormReviewScript(malformed, null);
    // Duplicates keep their first occurrence; NaN/Infinity and unknown keys drop.
    expect(stopByPhase(script2, 'contact').checkpoints[0]?.score).toBe(48);
    expect(
      script2.stops.flatMap(stop => stop.checkpoints.map(cp => cp.key)),
    ).not.toContain('mystery_checkpoint');
    expect(script2.stops.map(stop => stop.phase)).toEqual([
      'ready',
      'prepare',
      'accelerate',
      'contact',
      'follow_through',
      'recover',
    ]);
    expect(
      stopHeadline({
        key: 'ready_position',
        name: 'Ready position',
        score: 40,
        band: 'red',
        direction: 'sideways' as FaultDirection,
        severity: 0.6,
      }),
    ).toBe('Ready position scored 40 — was off target');
    expect(
      coachingCue('ready_position', 'sideways' as FaultDirection, 'dink')
        .length,
    ).toBeGreaterThan(0);

    // Only unknown phase keys → treated as no phases → fallback stop.
    const unknownOnly = buildFormReviewScript(
      analysisFixture({
        phases: [
          {
            key: 'warmup' as PhaseKey,
            startMs: 0,
            representativeMs: 0,
            endMs: 1,
            confidence: 1,
          },
        ],
      }),
      null,
    );
    expect(unknownOnly.stops.map(stop => stop.phase)).toEqual(['contact']);
    expect(unknownOnly.stops[0]?.checkpoints).toHaveLength(9);

    // Nothing scored, no phases: one honest contact stop, no heat, no extremes.
    const empty = buildFormReviewScript(
      analysisFixture({ phases: [], checkpoints: [], priorityFix: null }),
      null,
    );
    expect(empty.stops).toHaveLength(1);
    expect(empty.stops[0]?.checkpoints).toEqual([]);
    expect(empty.jointHeat).toEqual({});
    expect(empty.strongest).toBeNull();
    expect(empty.weakest).toBeNull();
    expect(jointHeatAt(empty, 1900)).toEqual({});
  });
});

// ─── Time-weighted heat ─────────────────────────────────────────────────────

describe('jointHeatAt', () => {
  const script = buildFormReviewScript(analysisFixture(), null);
  const contact = stopByPhase(script, 'contact');

  it('peaks at the stop time and decays away, never below 0.35 × static heat', () => {
    const atContact = jointHeatAt(script, contact.atMs);
    const later = jointHeatAt(script, contact.atMs + 1500);
    expect(atContact.right_wrist).toBeCloseTo(0.52, 6);
    expect(later.right_wrist).toBeDefined();
    expect(later.right_wrist ?? 0).toBeLessThan(atContact.right_wrist ?? 0);
    expect(later.right_wrist).toBeCloseTo(0.35 * 0.52, 6);
    for (const tMs of [
      -500, 0, 450, 1200, 1700, 1900, 2160, 2800, 3200, 9000,
    ]) {
      const heat = jointHeatAt(script, tMs);
      for (const joint of REVIEW_JOINTS) {
        const value = heat[joint];
        const base = script.jointHeat[joint];
        if (base === undefined) {
          expect(value).toBeUndefined();
          continue;
        }
        expect(value).toBeGreaterThanOrEqual(0.35 * base - 1e-9);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('spreads a stop over max(180ms, half its span)', () => {
    // Contact span is 40ms wide → sigma 180ms: one sigma away is exp(-0.5).
    const oneSigma = jointHeatAt(script, contact.atMs + 180);
    expect(oneSigma.right_wrist).toBeCloseTo(0.52 * Math.exp(-0.5), 4);
    // Ready span is 900ms wide → sigma 450ms.
    const ready = stopByPhase(script, 'ready');
    const readyOneSigma = jointHeatAt(script, ready.atMs + 450);
    expect(readyOneSigma.left_ankle).toBeCloseTo(0.28 * Math.exp(-0.5), 4);
  });

  it('strong stops add no heat; non-finite time yields only the floor', () => {
    const recover = stopByPhase(script, 'recover');
    const atRecover = jointHeatAt(script, recover.atMs);
    // Recovery is green: its wrists/ankles only carry the static floor.
    expect(atRecover.left_wrist).toBeUndefined();
    expect(atRecover.left_ankle).toBeCloseTo(0.35 * 0.28, 6);
    const floorOnly = jointHeatAt(script, NaN);
    expect(floorOnly.right_wrist).toBeCloseTo(0.35 * 0.52, 6);
  });
});

// ─── Fix / strength lists ───────────────────────────────────────────────────

describe('fixList', () => {
  it('lists non-green checkpoints, priority first, then worst score first', () => {
    const fixes = fixList(analysisFixture());
    expect(fixes.map(fix => fix.key)).toEqual([
      'contact_position',
      'paddle_path',
      'athletic_base',
    ]);
    expect(fixes.map(fix => fix.isPriority)).toEqual([true, false, false]);
    expect(fixes[0]?.headline).toBe(
      'Contact position scored 48 — contact came late',
    );
    expect(fixes[0]?.cue).toBe(
      coachingCue('contact_position', 'late', 'forehand_drive'),
    );
    expect(fixes[0]?.phase).toBe('contact');
    expect(fixes[2]?.phase).toBe('ready');
    expect(fixes[2]?.band).toBe('yellow');
  });

  it('promotes the priority checkpoint even when it is not the worst', () => {
    const fixes = fixList(
      analysisFixture({
        priorityFix: {
          checkpoint: 'athletic_base',
          reasonKey: 'dependency_root',
          severity: 0.28,
          confidence: 0.8,
        },
      }),
    );
    expect(fixes.map(fix => fix.key)).toEqual([
      'athletic_base',
      'contact_position',
      'paddle_path',
    ]);
    expect(fixes[0]?.isPriority).toBe(true);
  });

  it('respects the limit and ignores a green priority checkpoint', () => {
    expect(fixList(analysisFixture(), 2).map(fix => fix.key)).toEqual([
      'contact_position',
      'paddle_path',
    ]);
    expect(fixList(analysisFixture(), 0)).toEqual([]);
    const greenPriority = fixList(
      analysisFixture({
        priorityFix: {
          checkpoint: 'recovery',
          reasonKey: 'x',
          severity: 0,
          confidence: 1,
        },
      }),
    );
    expect(greenPriority.map(fix => fix.key)).toEqual([
      'contact_position',
      'paddle_path',
      'athletic_base',
    ]);
    expect(greenPriority.every(fix => !fix.isPriority)).toBe(true);
  });

  it('excludes green, unscored and inapplicable checkpoints; empty when all green', () => {
    const fixes = fixList(analysisFixture(), 10);
    expect(fixes.map(fix => fix.key)).not.toContain('face_wrist_stability');
    expect(fixes.map(fix => fix.key)).not.toContain('swing_length');
    expect(fixes.every(fix => fix.band !== 'green')).toBe(true);
    const clean = fixList(
      analysisFixture({
        checkpoints: [
          checkpoint('contact_position', 90, 'green', 'none'),
          checkpoint('paddle_path', 84, 'green', 'none'),
        ],
        priorityFix: null,
      }),
    );
    expect(clean).toEqual([]);
  });
});

describe('strengthList', () => {
  it('returns the best green checkpoints, highest first', () => {
    const strengths = strengthList(analysisFixture());
    expect(strengths.map(cp => [cp.key, cp.score])).toEqual([
      ['recovery', 92],
      ['paddle_set', 90],
    ]);
    expect(strengthList(analysisFixture(), 6).map(cp => cp.key)).toEqual([
      'recovery',
      'paddle_set',
      'preparation',
      'ready_position',
      'sequencing',
      'follow_through',
    ]);
    expect(strengthList(analysisFixture(), 0)).toEqual([]);
  });

  it('is empty when nothing is green', () => {
    expect(
      strengthList(
        analysisFixture({
          checkpoints: [checkpoint('contact_position', 48, 'red', 'late')],
        }),
      ),
    ).toEqual([]);
  });
});
