import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import {
  IMPORT_ADMISSION_LIMITS,
  IMPORT_ADMISSION_REASONS,
  admitImportedClip,
  admitImportedMedia,
  admitImportedStrokeEvents,
  importAdmissionRejectionMessage,
} from '../src/camera/importAdmission';

/**
 * W03-01 ADVERSARIAL TESTS (attack branch, candidate b391819a).
 *
 * Every test asserts the behaviour the work package promises — "ambiguous
 * clips are rejected with a precise reason" and the module header's own
 * contract "adding motion to a clip can only keep or raise the number of
 * comparable events, never lower it". A FAILING test here is a confirmed
 * break of the candidate; a passing test is an attack that did not land.
 *
 * Nothing in production code or the candidate's own tests is modified.
 */

type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

function importedClip(
  sequence: PoseSequence,
  overrides: Partial<ImportedClip> = {},
): ImportedClip {
  const sidecarJson = serializePoseSequence(sequence);
  const last = sequence.frames[sequence.frames.length - 1];
  return {
    uri: 'file:///imports/attack-clip.mov',
    durationMs: (last?.timestampMs ?? 0) + 200,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-08T08:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/attack-clip.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
    ...overrides,
  };
}

/**
 * A still skeleton (the synthetic swing's first frame: torso 0.2 image
 * heights) whose RIGHT wrist follows the speed profile `rightAt` and whose
 * LEFT wrist follows `leftAt` (image heights per second). The right wrist is
 * marked untracked (visibility 0) wherever `rightVisibleAt` is false.
 */
function wristProfile(
  durationMs: number,
  fps: number,
  rightAt: (tMs: number) => number,
  leftAt: (tMs: number) => number = () => 0,
  rightVisibleAt: (tMs: number) => boolean = () => true,
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const rightStep = (rightAt(tMs) * dtMs) / 1000;
    const leftStep = (leftAt(tMs) * dtMs) / 1000;
    const odd = index % 2 === 1;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark => {
        if (mark.name === 'right_wrist')
          return {
            ...mark,
            x: 0.55 + (odd ? rightStep : 0),
            visibility: rightVisibleAt(tMs) ? mark.visibility : 0,
          };
        if (mark.name === 'left_wrist')
          return { ...mark, x: 0.3 + (odd ? leftStep : 0) };
        return mark;
      }),
    });
    index += 1;
  }
  return { ...sequence, video: { ...sequence.video, fps }, frames };
}

function hump(centerMs: number, halfWidthMs: number, peak: number) {
  return (tMs: number): number => {
    const distance = Math.abs(tMs - centerMs);
    if (distance >= halfWidthMs) return 0;
    return peak * (1 - distance / halfWidthMs);
  };
}

function sumOf(...profiles: ReadonlyArray<(tMs: number) => number>) {
  return (tMs: number): number =>
    profiles.reduce((total, profile) => total + profile(tMs), 0);
}

/** Torso length of the synthetic skeleton in image heights (square video). */
function torsoLength(): number {
  const { sequence } = generateSwingSequence();
  const frame = sequence.frames[0];
  if (!frame) throw new Error('synthetic swing produced no frames');
  const point = (name: string) => {
    const mark = frame.landmarks.find(entry => entry.name === name);
    if (!mark) throw new Error(`missing ${name}`);
    return mark;
  };
  const ls = point('left_shoulder');
  const rs = point('right_shoulder');
  const lh = point('left_hip');
  const rh = point('right_hip');
  return Math.hypot(
    (ls.x + rs.x - lh.x - rh.x) / 2,
    (ls.y + rs.y - lh.y - rh.y) / 2,
  );
}

function expectRefusal(sequence: PoseSequence, reason: string): void {
  const decision = admitImportedClip(importedClip(sequence), sequence);
  expect(decision.admitted).toBe(false);
  if (decision.admitted) return;
  expect(decision.reason).toBe(reason);
}

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 1 — monotonicity: the `distinct` filter drops a WHOLE wrist.
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 1 — a busy paddle hand hides its rally; the off hand gets admitted', () => {
  // Two complete right-wrist strokes (each 4.25 torso/s, admitted alone) and
  // one left-wrist gesture of the same size: THREE comparable events.
  const rightRally = sumOf(hump(1000, 150, 1.0), hump(2000, 150, 1.0));
  const leftGesture = hump(1500, 150, 1.0);

  it('control: the three-event clip is refused as several strokes', () => {
    const clip = wristProfile(3000, 60, rightRally, leftGesture);
    const decision = admitImportedStrokeEvents(clip);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(3);
  });

  it('adding constant right-wrist motion to the SAME clip must not turn the refusal into an admission', () => {
    // Extra motion on the right wrist only. Per the header contract this can
    // only keep or raise the comparable-event count (3). Instead the raised
    // median baseline flips `distinct` off for the right wrist, both right
    // strokes vanish from `candidates`, and the lone left-hand gesture is
    // admitted as THE stroke of the clip.
    for (const extra of [0.6, 0.7, 1.0]) {
      const clip = wristProfile(
        3000,
        60,
        tMs => rightRally(tMs) + extra,
        leftGesture,
      );
      const decision = admitImportedClip(importedClip(clip), clip);
      expect({ extra, admitted: decision.admitted }).toEqual({
        extra,
        admitted: false,
      });
      if (decision.admitted) continue;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBeGreaterThanOrEqual(3);
    }
  });

  it('a 3-second continuous paddle-hand rally plus one off-hand gesture is a rally, not one stroke', () => {
    // Right wrist: six strokes in a row (speed oscillates 0.30–1.00 image
    // heights/s, 1.5–5 torso/s, never resting) from 0.5 s to 3.5 s. Left
    // wrist: one 4.25 torso/s gesture at 2.0 s. Expected: refused.
    const rally = (tMs: number) =>
      tMs > 500 && tMs < 3500
        ? 0.65 + 0.35 * Math.sin((2 * Math.PI * tMs) / 500)
        : 0;
    const clip = wristProfile(4000, 60, rally, hump(2000, 150, 1.0));
    expect(admitImportedMedia(importedClip(clip)).admitted).toBe(true);
    const decision = admitImportedClip(importedClip(clip), clip);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 2 — two complete strokes with a full stop between them, peaks
// ≤ 350 ms apart, are fused into ONE event by `sameEventPeakDistanceMs`.
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 2 — two complete strokes separated by a dead stop are fused when their peaks are ≤ 350 ms apart', () => {
  // Each stroke is 300 ms of motion (hump half-width 150 ms) at 4.25 torso/s
  // — each is admitted alone. Between them the wrist speed is exactly zero.
  function twoStrokes(peakSpacingMs: number): PoseSequence {
    return wristProfile(
      3000,
      60,
      sumOf(hump(1000, 150, 1.0), hump(1000 + peakSpacingMs, 150, 1.0)),
    );
  }

  it('control: each stroke alone is admitted; 400 ms apart they are two events', () => {
    const alone = wristProfile(3000, 60, hump(1000, 150, 1.0));
    expect(admitImportedStrokeEvents(alone).admitted).toBe(true);
    const apart = admitImportedStrokeEvents(twoStrokes(400));
    expect(apart.admitted).toBe(false);
    if (apart.admitted) return;
    expect(apart.reason).toBe('multiple_stroke_events');
    expect(apart.comparableEventCount).toBe(2);
  });

  it('with the wrist completely still between them, two strokes 320–360 ms apart must still be two events', () => {
    // groupPeaks() documents: "A quiet pause of any length … ends the event,
    // so two complete strokes are never fused into one." The code joins any
    // peak within 350 ms of the event's FIRST peak regardless of the pause.
    for (const spacing of [320, 340, 350, 360]) {
      const clip = twoStrokes(spacing);
      const decision = admitImportedClip(importedClip(clip), clip);
      expect({ spacing, admitted: decision.admitted }).toEqual({
        spacing,
        admitted: false,
      });
      if (decision.admitted) continue;
      expect(decision.reason).toBe('multiple_stroke_events');
    }
  });

  it('the verdict must not flip between 360 and 400 ms of peak spacing', () => {
    const near = admitImportedStrokeEvents(twoStrokes(360));
    const far = admitImportedStrokeEvents(twoStrokes(400));
    expect(near.admitted).toBe(far.admitted);
    expect(near.comparableEventCount).toBe(far.comparableEventCount);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 3 — relative comparability is non-monotonic: a harder stroke
// demotes two events the module itself refused as "several strokes".
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 3 — appending a harder stroke turns a "several strokes" refusal into an admission', () => {
  const torso = torsoLength();
  // Two soft, identical events at 2.5 torso/s (below the 4 torso/s absolute
  // floor but comparable to each other) 700 ms apart.
  const softPair = sumOf(
    hump(800, 150, torso * 2.5),
    hump(1500, 150, torso * 2.5),
  );

  it('control: the two soft events alone are refused as several strokes', () => {
    const clip = wristProfile(3000, 60, softPair);
    const decision = admitImportedStrokeEvents(clip);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('adding a 8.5 torso/s drive after them must keep at least two comparable events', () => {
    // Header contract: adding motion never lowers the comparable count. The
    // drive raises `strongest`, both soft events drop below 40% of it and
    // below the floor, and the three-motion clip is admitted as ONE stroke.
    const clip = wristProfile(
      3000,
      60,
      sumOf(softPair, hump(2400, 150, torso * 8.5)),
    );
    const decision = admitImportedClip(importedClip(clip), clip);
    expect(decision.comparableEventCount).toBeGreaterThanOrEqual(2);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 4 — a stroke whose first half is hidden by a tracking gap.
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 4 — a half-stroke emerging from an interior tracking gap is admitted as a complete stroke', () => {
  // The right wrist is untracked (occluded, e.g. behind the body during the
  // backswing) from 1000 to 1500 ms and reappears at full speed, then only
  // decelerates. The left wrist stays tracked so wrist coverage passes.
  const clip = wristProfile(
    3000,
    60,
    tMs => (tMs >= 1500 && tMs < 1800 ? 1.0 * (1 - (tMs - 1500) / 300) : 0),
    () => 0,
    tMs => !(tMs >= 1000 && tMs < 1500),
  );

  it('the acceleration phase was never measured, so the event is not an edge-free stroke', () => {
    const decision = admitImportedClip(importedClip(clip), clip);
    // Only the deceleration half was observed: the admitted event begins AT
    // its own peak (startMs === peakMs). The clip-edge rule refuses exactly
    // this shape at the first/last tracked frame; a gap must not be exempt.
    if (decision.admitted) {
      expect(decision.event.startMs).toBeLessThan(decision.event.peakMs);
    }
    expect(decision.admitted).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 5 — several volleys whose wrist never slows below half speed are
// fused by the `continuous` rule into one ≤ 2000 ms "stroke".
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 5 — four volleys in 1.85 s with 60% valleys are admitted as a single stroke', () => {
  // Four 4.8 torso/s peaks every 450 ms (1225, 1675, 2125, 2575 ms) with the
  // wrist never dropping below 60% of peak between them (a fast hand battle
  // at the kitchen). Still before 1000 ms and after 2800 ms so the clip's
  // median baseline stays at zero and every peak is `distinct`.
  const volleys = (tMs: number) => {
    if (tMs < 1000 || tMs > 2800) return 0;
    const phase = ((tMs - 1000) % 450) / 450;
    return 0.6 + 0.4 * Math.max(0, 1 - Math.abs(phase - 0.5) * 2);
  };
  const clip = wristProfile(5000, 60, volleys);

  it('four comparable peaks are several strokes, not one 1.85 s motion event', () => {
    const decision = admitImportedClip(importedClip(clip), clip);
    if (decision.admitted) {
      // Show what got admitted: one event spanning nearly the whole exchange.
      expect(decision.event.endMs - decision.event.startMs).toBeLessThan(
        IMPORT_ADMISSION_LIMITS.maxStrokeMotionMs,
      );
    }
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 6 — precise reason: a clip full of strokes reported as "no stroke".
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 6 — a continuous rally must not be described to the player as "no stroke was found"', () => {
  it('a 4 s non-stop rally (eight 1.5–5 torso/s peaks) is refused for having several strokes', () => {
    const rally = (tMs: number) =>
      0.65 + 0.35 * Math.sin((2 * Math.PI * tMs) / 500);
    const clip = wristProfile(4000, 60, rally);
    const decision = admitImportedClip(importedClip(clip), clip);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).not.toBe('no_stroke_event');
    expect(importAdmissionRejectionMessage(decision.reason)).not.toMatch(
      /no stroke was found/i,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 7 — container boundary values (empty, max, negative, NaN, ±0,
// non-integers, control bytes). These are expected to HOLD.
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 7 — container envelope boundary values', () => {
  const { sequence } = generateSwingSequence();
  const base = importedClip(sequence);
  const reasonOf = (clip: CapturedClip, probe = {}) => {
    const decision = admitImportedMedia(clip, probe);
    return decision.admitted ? 'admitted' : decision.reason;
  };

  it('duration: exact limits admit, one unit outside rejects, non-finite is unknown', () => {
    expect(reasonOf({ ...base, durationMs: 800 })).toBe('admitted');
    expect(reasonOf({ ...base, durationMs: 799.999 })).toBe(
      'duration_too_short',
    );
    expect(reasonOf({ ...base, durationMs: 60_000 })).toBe('admitted');
    expect(reasonOf({ ...base, durationMs: 60_000.001 })).toBe(
      'duration_too_long',
    );
    expect(reasonOf({ ...base, durationMs: 0 })).toBe('duration_too_short');
    expect(reasonOf({ ...base, durationMs: -0 })).toBe('duration_too_short');
    expect(reasonOf({ ...base, durationMs: -1 })).toBe('duration_too_short');
    expect(reasonOf({ ...base, durationMs: Number.NaN })).toBe(
      'duration_unknown',
    );
    expect(reasonOf({ ...base, durationMs: Number.POSITIVE_INFINITY })).toBe(
      'duration_unknown',
    );
    expect(reasonOf({ ...base, durationMs: Number.NEGATIVE_INFINITY })).toBe(
      'duration_unknown',
    );
  });

  it('frame rate: 240 admits, 240.0001 rejects, zero/negative/NaN/∞ are unknown', () => {
    expect(reasonOf({ ...base, fps: 240 })).toBe('admitted');
    expect(reasonOf({ ...base, fps: 240.0001 })).toBe('frame_rate_too_high');
    expect(reasonOf({ ...base, fps: 0 })).toBe('frame_rate_unknown');
    expect(reasonOf({ ...base, fps: -30 })).toBe('frame_rate_unknown');
    expect(reasonOf({ ...base, fps: Number.NaN })).toBe('frame_rate_unknown');
    expect(reasonOf({ ...base, fps: Number.POSITIVE_INFINITY })).toBe(
      'frame_rate_unknown',
    );
    expect(reasonOf({ ...base, fps: Number.MIN_VALUE })).toBe('admitted');
  });

  it('dimensions: 4096×2160 and 2160×4096 admit; 4097, 4096×2161, 0, negatives, fractions, NaN reject', () => {
    expect(reasonOf({ ...base, width: 4096, height: 2160 })).toBe('admitted');
    expect(reasonOf({ ...base, width: 2160, height: 4096 })).toBe('admitted');
    expect(reasonOf({ ...base, width: 4097, height: 100 })).toBe(
      'unsupported_dimensions',
    );
    expect(reasonOf({ ...base, width: 4096, height: 2161 })).toBe(
      'unsupported_dimensions',
    );
    expect(reasonOf({ ...base, width: 0, height: 1080 })).toBe(
      'unsupported_dimensions',
    );
    expect(reasonOf({ ...base, width: -1080, height: 1080 })).toBe(
      'unsupported_dimensions',
    );
    expect(reasonOf({ ...base, width: 1080.5, height: 1080 })).toBe(
      'unsupported_dimensions',
    );
    expect(reasonOf({ ...base, width: Number.NaN, height: 1080 })).toBe(
      'unsupported_dimensions',
    );
    expect(reasonOf({ ...base, width: 1, height: 1 })).toBe('admitted');
  });

  it('rotation: every multiple of 90 (including −0, 360, −270, 1e15·90) admits; anything else rejects', () => {
    expect(reasonOf(base, { rotationDegrees: -0 })).toBe('admitted');
    expect(reasonOf(base, { rotationDegrees: 360 })).toBe('admitted');
    expect(reasonOf(base, { rotationDegrees: -270 })).toBe('admitted');
    expect(reasonOf(base, { rotationDegrees: 90 * 1e15 })).toBe('admitted');
    expect(reasonOf(base, { rotationDegrees: 90 * 2 ** 53 })).toBe(
      'unsupported_rotation',
    );
    expect(reasonOf(base, { rotationDegrees: 89.999999 })).toBe(
      'unsupported_rotation',
    );
    expect(reasonOf(base, { rotationDegrees: Number.NaN })).toBe(
      'unsupported_rotation',
    );
    expect(reasonOf(base, { rotationDegrees: Number.POSITIVE_INFINITY })).toBe(
      'unsupported_rotation',
    );
    const admitted = admitImportedMedia(base, { rotationDegrees: -90 });
    expect(admitted.admitted && admitted.media.rotationDegrees).toBe(270);
  });

  it('codec: case-insensitive tags admit; whitespace, control bytes, empty, unicode and unknown reject', () => {
    expect(reasonOf(base, { codec: 'AVC1' })).toBe('admitted');
    expect(reasonOf(base, { codec: 'HeVc' })).toBe('admitted');
    expect(reasonOf(base, { codec: 'avc1 ' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: ' avc1' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: 'avc1\n' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: 'avc1\u0000' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: '' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: 'ａｖｃ１' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: 'av01' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: 'vp09' })).toBe('unsupported_codec');
    expect(reasonOf(base, { codec: 'ap4h' })).toBe('unsupported_codec');
  });

  it('track count: exactly 1 admits; 0, 2, 1.5, −1, NaN, ∞ reject', () => {
    expect(reasonOf(base, { videoTrackCount: 1 })).toBe('admitted');
    for (const count of [0, 2, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(reasonOf(base, { videoTrackCount: count })).toBe(
        'unsupported_track_layout',
      );
  });

  it('timeline tolerance: last frame at duration+50 admits, +51 rejects; a negative first stamp rejects', () => {
    const last = sequence.frames[sequence.frames.length - 1];
    if (!last) throw new Error('no frames');
    const exact = importedClip(sequence, { durationMs: last.timestampMs - 50 });
    expect(admitImportedClip(exact, sequence).admitted).toBe(true);
    const over = importedClip(sequence, { durationMs: last.timestampMs - 51 });
    const overDecision = admitImportedClip(over, sequence);
    expect(overDecision.admitted).toBe(false);
    if (!overDecision.admitted)
      expect(overDecision.reason).toBe('pose_geometry_mismatch');
    const early: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        timestampMs: frame.timestampMs - 1,
      })),
    };
    const earlyDecision = admitImportedClip(importedClip(early), early);
    expect(earlyDecision.admitted).toBe(false);
    if (!earlyDecision.admitted)
      expect(earlyDecision.reason).toBe('pose_geometry_mismatch');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 8 — user-facing copy compliance (APP_STORE_SUBMISSION.md).
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 8 — rejection copy stays inside the store-compliant vocabulary', () => {
  it('no reason mentions Android, Google Play, guest mode, Live Court, DUPR, competitors, percentages or superlatives', () => {
    const banned =
      /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s*%|best|most accurate|perfect|guarantee|ai coach/i;
    for (const reason of IMPORT_ADMISSION_REASONS) {
      const message = importAdmissionRejectionMessage(reason);
      expect(message.length).toBeGreaterThan(20);
      expect({ reason, ok: !banned.test(message) }).toEqual({
        reason,
        ok: true,
      });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ATTACK 9 — determinism and input immutability under the attack clips.
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 9 — the gate is pure for the attack clips too', () => {
  it('returns byte-identical verdicts twice and never mutates the sequence', () => {
    const torso = torsoLength();
    const clip = wristProfile(
      3000,
      60,
      sumOf(
        hump(800, 150, torso * 2.5),
        hump(1500, 150, torso * 2.5),
        hump(2400, 150, torso * 8.5),
      ),
    );
    const before = JSON.stringify(clip);
    const first = admitImportedStrokeEvents(clip);
    const second = admitImportedStrokeEvents(clip);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(clip)).toBe(before);
  });

  it('control for the file: an ordinary single swing is admitted end to end', () => {
    const { sequence } = generateSwingSequence();
    expect(admitImportedClip(importedClip(sequence), sequence).admitted).toBe(
      true,
    );
    expectRefusal(
      wristProfile(3000, 60, () => 0),
      'no_stroke_event',
    );
  });
});
