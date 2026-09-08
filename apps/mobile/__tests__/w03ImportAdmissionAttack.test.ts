import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import {
  IMPORT_ADMISSION_LIMITS,
  admitImportedClip,
  admitImportedMedia,
  admitImportedStrokeEvents,
} from '../src/camera/importAdmission';

/**
 * W03-01 adversarial tests against candidate da6ff3c7 (round 7).
 *
 * Every `it` is one attack. A FAILING test is a confirmed break: the clip is
 * ambiguous under the candidate's own standard ("none proves exactly one
 * complete stroke") yet `admitImportedStrokeEvents` / `admitImportedClip`
 * admits it, which on the shipping path reaches the permit reservation (see
 * w03ImportAdmissionAttackShipping.test.ts). A PASSING test is an attack the
 * candidate withstood.
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
 * Still skeleton; the right wrist's frame-to-frame speed follows `rightAt`
 * and the left wrist's follows `leftAt` (image heights per second). Frames
 * start at `startMs` so a sidecar can begin after the clip does.
 */
function wristSpeedProfile(
  durationMs: number,
  fps: number,
  rightAt: (tMs: number) => number,
  leftAt: (tMs: number) => number = () => 0,
  startMs = 0,
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = startMs; tMs <= durationMs; tMs += dtMs) {
    const rightStep = (rightAt(tMs) * dtMs) / 1000;
    const leftStep = (leftAt(tMs) * dtMs) / 1000;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark => {
        if (mark.name === 'right_wrist')
          return { ...mark, x: 0.55 + (index % 2 === 0 ? 0 : rightStep) };
        if (mark.name === 'left_wrist')
          return { ...mark, x: 0.35 + (index % 2 === 0 ? 0 : leftStep) };
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

/**
 * A rally of `peaks.length` volleys every `periodMs`, the wrist speed rising
 * linearly to each peak and falling to the following valley (never to rest
 * between volleys — the paddle is already moving for the next block).
 */
function rally(
  startMs: number,
  periodMs: number,
  peaks: readonly number[],
  valleys: readonly number[],
) {
  return (tMs: number): number => {
    const count = peaks.length;
    if (tMs < startMs || tMs > startMs + periodMs * count) return 0;
    const index = Math.min(count - 1, Math.floor((tMs - startMs) / periodMs));
    const phase = ((tMs - startMs) % periodMs) / periodMs;
    const peak = peaks[index] ?? 0;
    const before = index === 0 ? 0 : (valleys[index - 1] ?? 0);
    const after = index === count - 1 ? 0 : (valleys[index] ?? 0);
    if (phase < 0.5) return before + (peak - before) * (phase / 0.5);
    return peak + (after - peak) * ((phase - 0.5) / 0.5);
  };
}

/** Drops one wrist's visibility below the floor inside [fromMs, toMs]. */
function occludeWrist(
  sequence: PoseSequence,
  wrist: 'right_wrist' | 'left_wrist',
  fromMs: number,
  toMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map(frame =>
      frame.timestampMs >= fromMs && frame.timestampMs <= toMs
        ? {
            ...frame,
            landmarks: frame.landmarks.map(mark =>
              mark.name === wrist
                ? {
                    ...mark,
                    visibility:
                      IMPORT_ADMISSION_LIMITS.minLandmarkVisibility - 0.01,
                  }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

/**
 * Removes every pose frame inside [fromMs, toMs]. This is exactly what the
 * native extractor produces when Vision finds no person on those frames
 * (PickleVideoCapture.swift: "Extraction failures (no person, no landmarks)
 * leave a gap; the sequence only ever contains measured poses").
 */
function dropPoseFrames(
  sequence: PoseSequence,
  fromMs: number,
  toMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames
      .filter(frame => frame.timestampMs < fromMs || frame.timestampMs > toMs)
      .map((frame, index) => ({ ...frame, frameIndex: index })),
  };
}

function reasonOf(sequence: PoseSequence) {
  const admission = admitImportedStrokeEvents(sequence);
  return admission.admitted ? 'ADMITTED' : admission.reason;
}

function clipReasonOf(sequence: PoseSequence) {
  const admission = admitImportedClip(importedClip(sequence), sequence);
  return admission.admitted ? 'ADMITTED' : admission.reason;
}

const stroke = (centerMs: number) => hump(centerMs, 150, 1.0);

describe('ATTACK 1 — boundary: rally envelope between the jitter ratio and the plateau ratio', () => {
  /**
   * groupPeaks() fuses a peak into the open event when the valley stays
   * above maxSharedValleyRatio (0.8) of the LESSER peak; the plateau guard
   * (motion_not_stroke_like) only fires when the speed stays above 0.8 of
   * the MAX peak for > maxNearPeakMs. A rally whose volleys decay (each
   * valley ≈ 0.81 of the next, softer peak but ≤ 0.73 of the hardest) sits
   * between the two rules: every volley fuses, the plateau never forms.
   */
  it('refuses four decaying volleys every 450 ms (valleys at 81 % of the next peak, 60-73 % of the hardest)', () => {
    const sequence = wristSpeedProfile(
      5000,
      60,
      rally(1000, 450, [1.0, 0.9, 0.81, 0.73], [0.73, 0.66, 0.6]),
    );
    expect(reasonOf(sequence)).toBe('multiple_stroke_events');
  });

  it('refuses four rising volleys every 450 ms (the mirror image — each block harder than the last)', () => {
    const sequence = wristSpeedProfile(
      5000,
      60,
      rally(1000, 450, [0.73, 0.81, 0.9, 1.0], [0.6, 0.66, 0.73]),
    );
    expect(reasonOf(sequence)).toBe('multiple_stroke_events');
  });

  it('control (passes on the candidate): the same four volleys with equal peaks are refused', () => {
    const sequence = wristSpeedProfile(
      5000,
      60,
      rally(1000, 450, [1.0, 1.0, 1.0, 1.0], [0.73, 0.73, 0.73]),
    );
    expect(reasonOf(sequence)).not.toBe('ADMITTED');
  });
});

describe('ATTACK 2 — boundary: two volleys inside sameEventPeakDistanceMs with a contact-dip valley', () => {
  /**
   * groupPeaks() treats any second peak within sameEventPeakDistanceMs
   * (350 ms) of the first as the same event when the valley stays above
   * eventValleyRatio (0.5) of the lesser peak. Two volleys 330 ms apart whose
   * wrist never stops between them (valley 55 %) are two complete strokes at
   * kitchen-line tempo, not one contact dip.
   */
  it('refuses two equal volleys 330 ms apart whose valley stays at 55 %', () => {
    const sequence = wristSpeedProfile(
      3000,
      60,
      rally(1000, 330, [1.0, 1.0], [0.55]),
    );
    expect(reasonOf(sequence)).toBe('multiple_stroke_events');
  });

  it('refuses a hard volley followed 330 ms later by a softer block (valley 45 % of the hard peak, 56 % of the soft one)', () => {
    const sequence = wristSpeedProfile(
      3000,
      60,
      rally(1000, 330, [1.2, 0.8], [0.45]),
    );
    expect(reasonOf(sequence)).toBe('multiple_stroke_events');
  });

  it('control (passes on the candidate): the same two volleys with a dead stop between them are refused', () => {
    const sequence = wristSpeedProfile(
      3000,
      60,
      sumOf(hump(1200, 100, 1.4), hump(1530, 100, 1.4)),
    );
    expect(reasonOf(sequence)).toBe('multiple_stroke_events');
  });
});

describe('ATTACK 3 — partial persisted state: a whole-pose gap swallows a stroke', () => {
  /**
   * Round 7 closed the wrist-only hole (A4) but left whole-pose gaps to the
   * coverage gate (maxUntrackedSpanMs = 2500 ms). The native extractor emits
   * NO frame when Vision finds no person, so a player who is lost for 400 ms
   * mid-swing produces exactly this sidecar. By the candidate's own standard
   * ("the visible evidence is identical either way") the clip is ambiguous.
   */
  const twoStrokes = () =>
    wristSpeedProfile(4000, 60, sumOf(stroke(1000), stroke(2500)));

  it('refuses a second stroke hidden in a 400 ms whole-pose gap (no frames at all between 2300 and 2700 ms)', () => {
    const sequence = dropPoseFrames(twoStrokes(), 2300, 2700);
    expect(clipReasonOf(sequence)).not.toBe('ADMITTED');
  });

  it('refuses a 2.4 s whole-pose gap (just inside maxUntrackedSpanMs) that could hold an entire rally', () => {
    const sequence = dropPoseFrames(twoStrokes(), 1500, 3900);
    expect(clipReasonOf(sequence)).not.toBe('ADMITTED');
  });

  it('control (passes on the candidate): the same gap as a WRIST-ONLY hole is refused as wrist_not_tracked', () => {
    const sequence = occludeWrist(twoStrokes(), 'right_wrist', 2300, 2700);
    expect(clipReasonOf(sequence)).toBe('wrist_not_tracked');
  });

  it('control (passes on the candidate): a whole-pose gap longer than maxUntrackedSpanMs is refused by coverage', () => {
    const sequence = dropPoseFrames(twoStrokes(), 1300, 3900);
    expect(clipReasonOf(sequence)).toBe('pose_coverage_incomplete');
  });
});

describe('ATTACK 4 — partial tracking: the hitting wrist is untracked before its first / after its last measurement', () => {
  /**
   * wristTrackingHole() only inspects frames BETWEEN the wrist's first and
   * last tracked sample. With the body and the other wrist tracked, the
   * untrackedWristMs coverage gate (either wrist) is satisfied, so a lead-in
   * or tail during which the hitting wrist is invisible has no length bound
   * at all — two full strokes hide in it and the lone visible stroke is
   * admitted.
   */
  const threeStrokes = () =>
    wristSpeedProfile(
      7000,
      60,
      sumOf(stroke(1000), stroke(2500), stroke(6000)),
    );

  it('refuses a clip whose hitting wrist is untracked for the first 4.5 s (two strokes hidden) — body and off-hand tracked', () => {
    const sequence = occludeWrist(threeStrokes(), 'right_wrist', 0, 4500);
    expect(clipReasonOf(sequence)).not.toBe('ADMITTED');
  });

  it('refuses a clip whose hitting wrist is untracked for the last 4.5 s (two strokes hidden) — body and off-hand tracked', () => {
    const sequence = occludeWrist(
      wristSpeedProfile(
        7000,
        60,
        sumOf(stroke(1000), stroke(4000), stroke(5500)),
      ),
      'right_wrist',
      2500,
      7000,
    );
    expect(clipReasonOf(sequence)).not.toBe('ADMITTED');
  });

  it('control (passes on the candidate): the same lead-in with BOTH wrists untracked is refused', () => {
    const sequence = occludeWrist(
      occludeWrist(threeStrokes(), 'right_wrist', 0, 4500),
      'left_wrist',
      0,
      4500,
    );
    expect(clipReasonOf(sequence)).not.toBe('ADMITTED');
  });
});

describe('ATTACK 5 — partial tracking: a hole in the OTHER wrist (withstood — recorded, not a break)', () => {
  it('a 400 ms hole in the non-hitting wrist does not refuse the lone visible stroke', () => {
    const sequence = occludeWrist(
      wristSpeedProfile(4000, 60, stroke(1000), stroke(2500)),
      'left_wrist',
      2300,
      2700,
    );
    // Design decision of the candidate (handedness is not switched mid-clip);
    // pinned here so a change of mind is visible.
    expect(clipReasonOf(sequence)).toBe('ADMITTED');
  });
});

describe('ATTACK 6 — resource exhaustion / crash: the largest admissible sidecar with noisy tracking (withstood)', () => {
  it('60 s at 240 fps with jittery wrist speed finishes in bounded time without throwing', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const sequence = wristSpeedProfile(60_000, 240, () => 0.3 + random() * 0.5);
    const startedAt = Date.now();
    const admission = admitImportedStrokeEvents(sequence);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(admission.admitted).toBe(false);
  });

  it('a frame with NaN wrist coordinates and a duplicated timestamp never throws and never admits a second stroke', () => {
    const base = wristSpeedProfile(4000, 60, sumOf(stroke(1000), stroke(2500)));
    const frames = base.frames.map(frame =>
      frame.timestampMs === 1500
        ? {
            ...frame,
            landmarks: frame.landmarks.map(mark =>
              mark.name === 'right_wrist'
                ? { ...mark, x: Number.NaN, y: Number.NaN }
                : mark,
            ),
          }
        : frame,
    );
    const duplicated = frames[90];
    if (!duplicated) throw new Error('fixture too short');
    frames.splice(91, 0, { ...duplicated });
    const sequence = {
      ...base,
      frames: frames.map((frame, index) => ({ ...frame, frameIndex: index })),
    };
    expect(() => admitImportedStrokeEvents(sequence)).not.toThrow();
    expect(reasonOf(sequence)).not.toBe('ADMITTED');
  });
});

describe('ATTACK 7 — boundary values on the media probe (withstood)', () => {
  const { sequence } = generateSwingSequence();
  const clip = importedClip(sequence);

  it.each([
    ['rotation -270', { rotationDegrees: -270 }, true],
    ['rotation 450', { rotationDegrees: 450 }, true],
    ['rotation 1e-7', { rotationDegrees: 1e-7 }, false],
    ['rotation NaN', { rotationDegrees: Number.NaN }, false],
    ['rotation Infinity', { rotationDegrees: Number.POSITIVE_INFINITY }, false],
    ['rotation 90 * 2^53', { rotationDegrees: 90 * 2 ** 53 }, false],
    ['codec AVC1 (upper case)', { codec: 'AVC1' }, true],
    ['codec "avc1 " (trailing space)', { codec: 'avc1 ' }, false],
    ['codec "" (empty)', { codec: '' }, false],
    ['codec ap4h (ProRes)', { codec: 'ap4h' }, false],
    ['codec av01', { codec: 'av01' }, false],
    ['track count 1.0', { videoTrackCount: 1.0 }, true],
    ['track count 0', { videoTrackCount: 0 }, false],
    ['track count -1', { videoTrackCount: -1 }, false],
    ['track count NaN', { videoTrackCount: Number.NaN }, false],
  ])('%s', (_title, probe, admitted) => {
    expect(admitImportedMedia(clip, probe).admitted).toBe(admitted);
  });

  it.each([
    ['duration exactly min', { durationMs: 800 }, true],
    ['duration one ms under min', { durationMs: 799 }, false],
    ['duration exactly max', { durationMs: 60_000 }, true],
    ['duration max + 0.5 ms', { durationMs: 60_000.5 }, false],
    ['duration -0', { durationMs: -0 }, false],
    ['fps Number.EPSILON', { fps: Number.EPSILON }, true],
    ['fps 240.0000001', { fps: 240.0000001 }, false],
    ['fps -Infinity', { fps: Number.NEGATIVE_INFINITY }, false],
    ['4096x2160 (exact pixel budget)', { width: 4096, height: 2160 }, true],
    ['4096x2161 (one row over)', { width: 4096, height: 2161 }, false],
    ['2160x4096 portrait', { width: 2160, height: 4096 }, true],
    ['1920.5x1080 fractional', { width: 1920.5, height: 1080 }, false],
    ['0x1080', { width: 0, height: 1080 }, false],
  ])('%s', (_title, overrides, admitted) => {
    expect(admitImportedMedia(importedClip(sequence, overrides)).admitted).toBe(
      admitted,
    );
  });
});

describe('ATTACK 8 — sidecar that starts late: whole-pose lead-in bounded only by maxUntrackedSpanMs', () => {
  /**
   * Same class as ATTACK 3, at the clip start: the extractor emits nothing
   * while no person is found, so a sidecar whose first frame is at 2.4 s
   * passes coverage. The lone stroke after it is admitted although 2.4 s of
   * the clip were never observed.
   */
  it('refuses a clip whose pose sequence begins 2.4 s in (nothing observed before it)', () => {
    const sequence = wristSpeedProfile(
      4000,
      60,
      hump(3200, 150, 1.0),
      () => 0,
      2400,
    );
    expect(clipReasonOf(sequence)).not.toBe('ADMITTED');
  });

  it('control (passes on the candidate): a 2.6 s unobserved lead-in is refused by coverage', () => {
    const sequence = wristSpeedProfile(
      4000,
      60,
      hump(3200, 150, 1.0),
      () => 0,
      2600,
    );
    expect(clipReasonOf(sequence)).toBe('pose_coverage_incomplete');
  });
});
