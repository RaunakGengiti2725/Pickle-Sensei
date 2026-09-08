import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import { detectOfflineStrokeWindow } from '@pickle/vision-geometry';
import type { CapturedClip } from '../src/camera/capture';
import {
  IMPORT_ADMISSION_LIMITS,
  IMPORT_ADMISSION_REASONS,
  IMPORT_ADMISSION_VERSION,
  admitImportedClip,
  admitImportedMedia,
  admitImportedStrokeEvents,
  importAdmissionRejectionMessage,
  type ImportAdmissionReason,
} from '../src/camera/importAdmission';

/**
 * W03-01 — conservative import event admission.
 *
 * An imported clip is admitted only when its container is inside the
 * published envelope (duration, frame rate, rotation, codec, dimensions) AND
 * its measured pose sequence contains exactly ONE plausible stroke event.
 * Zero events and several comparable events are rejected with a precise
 * reason — the loudest motion is never silently chosen — so an ambiguous
 * clip can never reach extraction charging or a permit reservation.
 *
 * Regression (fails on BASE 42291369): the import path had no admission
 * step at all. `runCaptureAnalysis` treated every imported sidecar as ONE
 * stroke spanning the whole clip (`imported-full-clip-1`, confidence 1) and
 * the offline detector then picked the most prominent peak of a multi-stroke
 * rally, so an ambiguous clip was admitted and charged.
 *
 * Round 3 additions (prior candidate b8c1afd4 was rejected): two full
 * strokes separated by a quiet pause shorter than 500 ms were fused into ONE
 * admitted event; slow motion of the OTHER wrist between two rejected
 * strokes bridged them into one cluster (a non-monotonic gate); and a
 * sidecar covering a sliver of a long clip was admitted. Admission must be
 * monotonic — extra motion can only make a clip MORE ambiguous — and the
 * pose evidence must cover the clip it vouches for.
 */

type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

function importedClip(
  sequence: PoseSequence,
  overrides: Partial<ImportedClip> = {},
): ImportedClip {
  const sidecarJson = serializePoseSequence(sequence);
  const last = sequence.frames[sequence.frames.length - 1];
  const clip: ImportedClip = {
    uri: 'file:///imports/w03-clip.mov',
    durationMs: (last?.timestampMs ?? 0) + 100,
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
      uri: 'file:///imports/w03-clip.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
    ...overrides,
  };
  return clip;
}

function singleSwing(): {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
} {
  return generateSwingSequence();
}

/** Two sequences played back to back, the second starting `gapMs` after the
 * first ends. Frame indices and timestamps stay strictly ascending. */
function concatSequences(
  first: PoseSequence,
  second: PoseSequence,
  gapMs: number,
): PoseSequence {
  const lastFirst = first.frames[first.frames.length - 1];
  const offset = (lastFirst?.timestampMs ?? 0) + gapMs;
  return {
    ...first,
    frames: [
      ...first.frames,
      ...second.frames.map(frame => ({
        ...frame,
        frameIndex: first.frames.length + frame.frameIndex,
        timestampMs: frame.timestampMs + offset,
      })),
    ],
  };
}

/**
 * A skeleton standing still except for the right wrist, whose frame-to-frame
 * speed (image heights per second, square video) follows `speedAt`. The
 * wrist alternates between two points so the position stays in frame while
 * the measured speed profile is exactly the requested one.
 */
function wristSpeedProfile(
  durationMs: number,
  fps: number,
  speedAt: (tMs: number) => number,
): PoseSequence {
  const { sequence } = singleSwing();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const stepImageHeights = (speedAt(tMs) * dtMs) / 1000;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark =>
        mark.name === 'right_wrist'
          ? { ...mark, x: 0.55 + (index % 2 === 0 ? 0 : stepImageHeights) }
          : mark,
      ),
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

/** Keeps only the frames inside [fromMs, toMs] and rebases them to 0. */
function trimSequence(
  sequence: PoseSequence,
  fromMs: number,
  toMs: number,
): PoseSequence {
  const kept = sequence.frames.filter(
    frame => frame.timestampMs >= fromMs && frame.timestampMs <= toMs,
  );
  const base = kept[0]?.timestampMs ?? 0;
  return {
    ...sequence,
    frames: kept.map((frame, index) => ({
      ...frame,
      frameIndex: index,
      timestampMs: frame.timestampMs - base,
    })),
  };
}

/** Drops the right wrist's visibility below the floor inside [fromMs, toMs]. */
function occludeRightWrist(
  sequence: PoseSequence,
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
              mark.name === 'right_wrist'
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

/** The right wrist follows `speedAt` while the LEFT wrist follows `leftAt`. */
function twoWristSpeedProfile(
  durationMs: number,
  fps: number,
  speedAt: (tMs: number) => number,
  leftAt: (tMs: number) => number,
): PoseSequence {
  const base = wristSpeedProfile(durationMs, fps, speedAt);
  const dtMs = 1000 / fps;
  return {
    ...base,
    frames: base.frames.map((frame, index) => {
      const stepImageHeights = (leftAt(index * dtMs) * dtMs) / 1000;
      return {
        ...frame,
        landmarks: frame.landmarks.map(mark =>
          mark.name === 'left_wrist'
            ? { ...mark, x: 0.3 + (index % 2 === 0 ? 0 : stepImageHeights) }
            : mark,
        ),
      };
    }),
  };
}

/**
 * A skeleton standing still except for the right wrist, which TRAVELS: its
 * position integrates the requested velocity (image heights per second along
 * x and y, square video), so both the speed profile and the direction of
 * travel are exactly as requested. Used for wind-up / recovery evidence,
 * where the direction of motion matters.
 */
function wristTravelProfile(
  durationMs: number,
  fps: number,
  velocityAt: (tMs: number) => readonly [number, number],
): PoseSequence {
  const { sequence } = singleSwing();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  let x = 0.45;
  let y = 0.55;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const [vx, vy] = velocityAt(tMs);
    x += (vx * dtMs) / 1000;
    y += (vy * dtMs) / 1000;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark =>
        mark.name === 'right_wrist' ? { ...mark, x, y } : mark,
      ),
    });
    index += 1;
  }
  return { ...sequence, video: { ...sequence.video, fps }, frames };
}

/** Velocity along ±x whose magnitude follows `speedAt`; `sign` is the direction. */
function along(sign: 1 | -1, speedAt: (tMs: number) => number) {
  return (tMs: number): readonly [number, number] => [sign * speedAt(tMs), 0];
}

function sumVelocities(
  ...profiles: ReadonlyArray<(tMs: number) => readonly [number, number]>
) {
  return (tMs: number): readonly [number, number] => {
    let vx = 0;
    let vy = 0;
    for (const profile of profiles) {
      const [px, py] = profile(tMs);
      vx += px;
      vy += py;
    }
    return [vx, vy];
  };
}

function expectMultipleStrokes(sequence: PoseSequence, atLeast = 2): void {
  const decision = admitImportedStrokeEvents(sequence);
  expect(decision.admitted).toBe(false);
  if (decision.admitted) return;
  expect(decision.reason).toBe('multiple_stroke_events');
  expect(decision.comparableEventCount).toBeGreaterThanOrEqual(atLeast);
}

describe('W03-01 regression — ambiguous clip admitted on base', () => {
  it('refuses a two-stroke rally that the base import path admits as one stroke', () => {
    const first = singleSwing();
    const second = singleSwing();
    const rally = concatSequences(first.sequence, second.sequence, 1000);
    const clip = importedClip(rally);

    // BASE behaviour, still true on HEAD: the offline detector resolves the
    // rally to a single window (it selects the most prominent peak) and the
    // clip's container is otherwise perfectly importable. Nothing on base
    // refuses this clip before a permit is reserved.
    expect(detectOfflineStrokeWindow(rally).ok).toBe(true);
    expect(admitImportedMedia(clip).admitted).toBe(true);

    const decision = admitImportedClip(clip, rally);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
    expect(decision.candidates.filter(c => c.comparable)).toHaveLength(2);
    expect(importAdmissionRejectionMessage(decision.reason)).toMatch(
      /one stroke|single stroke/i,
    );
  });
});

/**
 * Round 5 — a stroke that is admitted on its own evidence is never demoted
 * to a wind-up by a louder stroke that follows it. Two complete strokes
 * separated by a full stop are two events whatever their relative speed and
 * whatever their spacing, so adding speed to the later stroke, or shifting
 * it by a frame, can never turn a refusal into an admission.
 */
describe('W03-01 regression — a complete stroke is never demoted by a later, harder stroke', () => {
  // Both humps are 300 ms wide and separated by 300 ms of exactly zero wrist
  // speed: a finished soft stroke, then a harder one 600 ms later.
  const SOFT = 1.0;
  const HARD = 3.0;

  /** Peak torso lengths/s of a lone hump of `peak` image heights/s, admitted alone. */
  function admittedAlone(peak: number): number {
    const decision = admitImportedStrokeEvents(
      wristSpeedProfile(3000, 60, hump(1500, 150, peak)),
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return 0;
    return decision.event.peakTorsoPerSecond;
  }

  function softThenHard(hard: number, hardMs = 1800): PoseSequence {
    return wristSpeedProfile(
      3000,
      60,
      sumOf(hump(1200, 150, SOFT), hump(hardMs, 150, hard)),
    );
  }

  it('each stroke alone clears the absolute stroke floor and is admitted', () => {
    expect(admittedAlone(SOFT)).toBeGreaterThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
    );
    expect(admittedAlone(HARD)).toBeGreaterThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
    );
  });

  it('two complete strokes 600 ms apart are two events even when the second is 3× harder', () => {
    const decision = admitImportedStrokeEvents(softThenHard(HARD));
    expect(decision.candidates).toHaveLength(2);
    for (const candidate of decision.candidates) {
      expect(candidate.peakTorsoPerSecond).toBeGreaterThanOrEqual(
        IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
      );
      expect(candidate.comparable).toBe(true);
    }
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('is monotonic in the second stroke: making it harder never turns the refusal into an admission', () => {
    for (const hard of [1.0, 1.5, 2.0, 2.4, 2.6, 3.0, 5.0, 8.0]) {
      const decision = admitImportedStrokeEvents(softThenHard(hard));
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBe(2);
    }
  });

  it('refuses an escalating three-stroke rally whose every stroke is admitted alone', () => {
    for (const peak of [1.0, 2.6, 7.0]) admittedAlone(peak);
    const rally = wristSpeedProfile(
      4000,
      60,
      sumOf(hump(1200, 150, 1.0), hump(1800, 150, 2.6), hump(2400, 150, 7.0)),
    );
    const decision = admitImportedStrokeEvents(rally);
    expect(decision.candidates).toHaveLength(3);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(3);
  });

  it('gives the same verdict whether the peaks are 500, 600, 700, 717, 900 or 1200 ms apart', () => {
    for (const spacingMs of [500, 600, 700, 717, 900, 1200]) {
      const decision = admitImportedStrokeEvents(
        softThenHard(HARD, 1200 + spacingMs),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBe(2);
    }
  });

  it('refuses the soft-then-hard rally through the combined clip gate with the precise reason', () => {
    const rally = softThenHard(HARD);
    const decision = admitImportedClip(importedClip(rally), rally);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });
});

/**
 * Round 6 — the adversary broke candidate b391819a three ways, all of them
 * relative judgements: (1) a whole-wrist "distinct peak" filter compared the
 * peak with the wrist's MEDIAN speed, so constant paddle-hand motion hid a
 * whole rally and the lone off-hand gesture became THE stroke; (2) events
 * were "comparable" relative to the loudest one, so what counted depended on
 * the loudest motion; (3) a `continuous` valley rule fused any peaks whose
 * valley stayed above half the lesser peak, so four volleys with 60 % valleys
 * were one admitted "stroke". Every stroke judgement is now ABSOLUTE in body
 * scale (torso lengths per second) and per event: a stroke-sized event is a
 * stroke wherever it sits, a comparable event counts whatever else moves,
 * and only a slower wind-up or recovery that is continuous with a stroke
 * AND travels against it is folded into that stroke.
 */
describe('W03-01 regression — round 6: absolute, per-event stroke judgement', () => {
  // Two right-hand strokes 1.2 s apart plus one off-hand gesture between them:
  // three comparable events, refused.
  const rightStrokes = sumOf(hump(1000, 150, 1.0), hump(2200, 150, 1.0));
  const leftGesture = hump(1600, 200, 0.8);

  it('control: two paddle-hand strokes and an off-hand gesture are three events', () => {
    const decision = admitImportedStrokeEvents(
      twoWristSpeedProfile(3200, 60, rightStrokes, leftGesture),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(3);
  });

  it('is monotonic under constant paddle-hand motion: the rally is never hidden and the off-hand gesture never becomes THE stroke', () => {
    for (const floor of [0.3, 0.6, 0.7, 1.0]) {
      const decision = admitImportedStrokeEvents(
        twoWristSpeedProfile(
          3200,
          60,
          tMs => rightStrokes(tMs) + floor,
          leftGesture,
        ),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBeGreaterThanOrEqual(3);
      expect(
        decision.candidates.filter(
          c => c.comparable && c.wrist === 'right_wrist',
        ).length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('refuses a continuous six-stroke rally that never rests, with or without an off-hand gesture', () => {
    // 1.5–5 torso lengths/s throughout: the wrist never stops, so a
    // median-relative peak filter sees no "distinct" peak at all.
    const rally = (tMs: number) => {
      if (tMs < 500 || tMs > 3500) return 0;
      const phase = ((tMs - 500) % 500) / 500;
      return 0.35 + 0.85 * Math.max(0, 1 - Math.abs(phase - 0.5) * 2);
    };
    expectMultipleStrokes(wristSpeedProfile(4000, 60, rally), 6);
    // The off-hand gesture overlaps one volley in time and may cluster with
    // it; it can never REDUCE the count.
    expectMultipleStrokes(
      twoWristSpeedProfile(4000, 60, rally, hump(2000, 200, 0.8)),
      6,
    );
  });

  it('refuses two complete strokes 340 ms apart with a dead stop between them', () => {
    for (const spacingMs of [320, 340, 360]) {
      const decision = admitImportedStrokeEvents(
        wristSpeedProfile(
          3000,
          60,
          sumOf(hump(1200, 100, 1.4), hump(1200 + spacingMs, 100, 1.4)),
        ),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBe(2);
    }
  });

  it('refuses four volleys in 1.85 s whose valleys stay at 60 % of the peaks', () => {
    const volleys = (tMs: number) => {
      if (tMs < 1000 || tMs > 2800) return 0;
      const phase = ((tMs - 1000) % 450) / 450;
      return 0.6 + 0.4 * Math.max(0, 1 - Math.abs(phase - 0.5) * 2);
    };
    const decision = admitImportedStrokeEvents(
      wristSpeedProfile(5000, 60, volleys),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBeGreaterThanOrEqual(3);
  });

  it('refuses two soft strokes followed 900 ms later by a hard drive — the drive never demotes them', () => {
    const decision = admitImportedStrokeEvents(
      wristSpeedProfile(
        4500,
        60,
        sumOf(hump(800, 150, 0.6), hump(1700, 150, 0.6), hump(2900, 150, 3.0)),
      ),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(3);
  });

  it('refuses a dink-speed second movement after a stroke: comparable is an absolute floor, not a share of the loudest', () => {
    const swing = singleSwing();
    const dink = wristSpeedProfile(2000, 60, hump(1000, 400, 0.7));
    const decision = admitImportedStrokeEvents(
      concatSequences(swing.sequence, dink, 600),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('refuses a half stroke that emerges from a tracking gap at full speed', () => {
    const swing = wristSpeedProfile(3000, 60, tMs =>
      tMs >= 1500 && tMs <= 1800 ? 1.0 * (1 - (tMs - 1500) / 300) : 0,
    );
    const gapped: PoseSequence = {
      ...swing,
      frames: swing.frames.map(frame =>
        frame.timestampMs >= 1000 && frame.timestampMs < 1500
          ? {
              ...frame,
              landmarks: frame.landmarks.map(mark =>
                mark.name === 'right_wrist' ? { ...mark, visibility: 0 } : mark,
              ),
            }
          : frame,
      ),
    };
    const decision = admitImportedStrokeEvents(gapped);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('stroke_truncated_at_clip_edge');
  });

  it('publishes absolute floors only: no whole-wrist or loudest-relative ratio remains', () => {
    expect('distinctPeakRatio' in IMPORT_ADMISSION_LIMITS).toBe(false);
    expect('comparablePeakRatio' in IMPORT_ADMISSION_LIMITS).toBe(false);
    expect(
      IMPORT_ADMISSION_LIMITS.minComparablePeakTorsoPerSecond,
    ).toBeLessThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond / 2,
    );
    expect(IMPORT_ADMISSION_LIMITS.maxWindUpPeakRatio).toBeLessThanOrEqual(0.5);
    expect(IMPORT_ADMISSION_LIMITS.maxWindUpPauseMs).toBeLessThanOrEqual(400);
  });
});

/**
 * Round 6 — wind-up and recovery. A real swing has a slower backswing before
 * contact and a slower recovery after it, each travelling AGAINST the
 * forward swing and continuous with it. Only such motion is folded into the
 * stroke; a burst that travels the same way, that pauses for long, or that
 * has no net travel at all is a separate event.
 */
describe('W03-01 regression — round 6: wind-up and recovery are direction-aware', () => {
  const STROKE = 1.6;
  const forward = along(1, hump(1700, 150, STROKE));

  it('admits a forward swing with a slower backward wind-up and a backward recovery as ONE stroke', () => {
    const decision = admitImportedStrokeEvents(
      wristTravelProfile(
        3200,
        60,
        sumVelocities(
          along(-1, hump(1300, 150, 0.6)),
          forward,
          along(-1, hump(2150, 200, 0.5)),
        ),
      ),
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.comparableEventCount).toBe(1);
    expect(Math.abs(decision.event.peakMs - 1700)).toBeLessThanOrEqual(60);
    expect(decision.event.startMs).toBeLessThan(1300);
    expect(decision.event.endMs).toBeGreaterThan(2150);
    expect(decision.candidates).toHaveLength(3);
    expect(decision.candidates.filter(c => c.comparable)).toHaveLength(1);
  });

  it('a wind-up of the same shape is a second stroke when it travels FORWARD (a soft stroke, then a hard one)', () => {
    const decision = admitImportedStrokeEvents(
      wristTravelProfile(
        3200,
        60,
        sumVelocities(along(1, hump(1300, 150, 0.6)), forward),
      ),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('a backward burst is a second stroke when the pause before the swing exceeds the wind-up budget', () => {
    const pauseMs = IMPORT_ADMISSION_LIMITS.maxWindUpPauseMs + 200;
    const decision = admitImportedStrokeEvents(
      wristTravelProfile(
        3600,
        60,
        sumVelocities(
          along(-1, hump(1700 - 150 - pauseMs - 150, 150, 0.6)),
          forward,
        ),
      ),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('a backward burst faster than half the swing is a second stroke, not a wind-up', () => {
    const decision = admitImportedStrokeEvents(
      wristTravelProfile(
        3200,
        60,
        sumVelocities(along(-1, hump(1300, 150, STROKE * 0.6)), forward),
      ),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('folds at most one wind-up and one recovery: a second backward burst before the swing is a stroke', () => {
    const decision = admitImportedStrokeEvents(
      wristTravelProfile(
        3600,
        60,
        sumVelocities(
          along(-1, hump(900, 150, 0.6)),
          along(-1, hump(1300, 150, 0.6)),
          forward,
        ),
      ),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
  });

  it('a swing that is itself a stroke-sized burst with no net travel gets no wind-up allowance', () => {
    // Oscillating fixtures have no direction of travel; a slower burst next
    // to them is never a wind-up, so soft-then-hard stays two events.
    const decision = admitImportedStrokeEvents(
      wristSpeedProfile(
        3000,
        60,
        sumOf(hump(1300, 150, 0.6), hump(1700, 150, STROKE)),
      ),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });
});

describe('W03-01 import admission — container envelope', () => {
  it('admits a supported single-track import inside the published envelope', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence);
    const decision = admitImportedMedia(clip, {
      rotationDegrees: 90,
      codec: 'hvc1',
      videoTrackCount: 1,
    });
    expect(decision).toEqual({
      admitted: true,
      version: IMPORT_ADMISSION_VERSION,
      media: {
        durationMs: clip.durationMs,
        fps: clip.fps,
        width: clip.width,
        height: clip.height,
        rotationDegrees: 90,
        codec: 'hvc1',
      },
    });
  });

  it('accepts every quarter-turn rotation and each supported codec spelling', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence);
    for (const rotationDegrees of [0, 90, 180, 270, -90, 450]) {
      expect(admitImportedMedia(clip, { rotationDegrees }).admitted).toBe(true);
    }
    for (const codec of ['avc1', 'AVC1', 'h264', 'hvc1', 'hev1', 'hevc']) {
      expect(admitImportedMedia(clip, { codec }).admitted).toBe(true);
    }
  });

  it.each([
    ['not_imported_clip', {} as Partial<ImportedClip>, true],
    ['duration_too_short', { durationMs: 500 }, false],
    ['duration_too_long', { durationMs: 60_001 }, false],
    ['frame_rate_unknown', { fps: 0 }, false],
    ['frame_rate_too_high', { fps: 241 }, false],
    ['unsupported_dimensions', { width: 4097 }, false],
    ['unsupported_dimensions', { width: 4096, height: 4096 }, false],
  ] as const)(
    'rejects %s before extraction',
    (reason, overrides, useLiveClip) => {
      const { sequence } = singleSwing();
      const imported = importedClip(sequence, overrides);
      const clip: CapturedClip = useLiveClip
        ? ({
            ...imported,
            captureMode: 'automatic_pose_trigger',
            trigger: {
              startMs: 0,
              endMs: imported.durationMs,
              peakMotionMs: null,
              confidence: 1,
              producedBy: {
                providerId: 'trigger.temporal-heuristic',
                modelVersion: 'test',
                runtime: 'deterministic',
                executionTarget: 'on_device',
                artifactHash: null,
              },
            },
          } as unknown as CapturedClip)
        : imported;
      const decision = admitImportedMedia(clip);
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe(reason);
      expect(decision.detail.length).toBeGreaterThan(0);
    },
  );

  it('leaves a low but measured frame rate to the pose-quality floor rather than the container metadata', () => {
    // 23.976 fps ("24p") and 12 fps are both measured frame rates; whether
    // the recorded timestamps are dense enough is the quantization-aware
    // pose-quality gate's verdict (`insufficient_fps`), so container fps
    // alone never refuses an import.
    for (const fps of [12, 23.976, 24, 30, 60, 120, 240]) {
      const { sequence } = singleSwing();
      expect(admitImportedMedia(importedClip(sequence, { fps })).admitted).toBe(
        true,
      );
    }
  });

  it('rejects a non-quarter-turn rotation and an unsupported or unknown codec', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence);
    const rotated = admitImportedMedia(clip, { rotationDegrees: 45 });
    expect(rotated.admitted).toBe(false);
    if (!rotated.admitted) expect(rotated.reason).toBe('unsupported_rotation');
    const nanRotation = admitImportedMedia(clip, {
      rotationDegrees: Number.NaN,
    });
    expect(nanRotation.admitted).toBe(false);
    if (!nanRotation.admitted) {
      expect(nanRotation.reason).toBe('unsupported_rotation');
    }
    for (const codec of ['vp09', 'av01', 'mp4v', 'apcn', '', '   ']) {
      const decision = admitImportedMedia(clip, { codec });
      expect(decision.admitted).toBe(false);
      if (!decision.admitted) {
        expect(decision.reason).toBe('unsupported_codec');
        expect(decision.detail).toContain(JSON.stringify(codec));
      }
    }
  });

  it('rejects a container with more or fewer than one video track', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence);
    for (const videoTrackCount of [0, 2]) {
      const decision = admitImportedMedia(clip, { videoTrackCount });
      expect(decision.admitted).toBe(false);
      if (!decision.admitted) {
        expect(decision.reason).toBe('unsupported_track_layout');
      }
    }
  });

  it('publishes the envelope it enforces (mirrors the native import budget)', () => {
    expect(IMPORT_ADMISSION_LIMITS.maxDurationMs).toBe(60_000);
    expect(IMPORT_ADMISSION_LIMITS.maxFps).toBe(240);
    expect(IMPORT_ADMISSION_LIMITS.maxFrameDimension).toBe(4096);
    expect(IMPORT_ADMISSION_LIMITS.maxFramePixels).toBe(4096 * 2160);
    expect('minFps' in IMPORT_ADMISSION_LIMITS).toBe(false);
    expect(IMPORT_ADMISSION_LIMITS.minDurationMs).toBeGreaterThan(0);
    // Conservative: a second event at half the stroke floor still counts.
    expect(
      IMPORT_ADMISSION_LIMITS.minComparablePeakTorsoPerSecond,
    ).toBeLessThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond / 2,
    );
    // One swing's continuous motion fits; two complete swings cannot.
    expect(IMPORT_ADMISSION_LIMITS.maxStrokeMotionMs).toBeLessThanOrEqual(2000);
    expect(Object.isFrozen(IMPORT_ADMISSION_LIMITS)).toBe(true);
    expect(Object.isFrozen(IMPORT_ADMISSION_REASONS)).toBe(true);
  });
});

describe('W03-01 import admission — single-stroke plausibility', () => {
  it('admits exactly one distinct stroke and reports its measured event', () => {
    const { sequence, window } = singleSwing();
    const decision = admitImportedStrokeEvents(sequence);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.version).toBe(IMPORT_ADMISSION_VERSION);
    expect(decision.event.wrist).toBe('right_wrist');
    expect(Math.abs(decision.event.peakMs - window.peakMs)).toBeLessThanOrEqual(
      100,
    );
    expect(decision.event.startMs).toBeGreaterThan(0);
    expect(decision.event.endMs).toBeLessThan(window.endMs);
    expect(decision.event.startMs).toBeLessThan(decision.event.peakMs);
    expect(decision.event.peakMs).toBeLessThan(decision.event.endMs);
    // Every measured candidate is exposed; the admitted one is the only
    // comparable event.
    expect(decision.candidates.length).toBeGreaterThanOrEqual(1);
    expect(decision.candidates.filter(c => c.comparable)).toHaveLength(1);
    expect(decision.comparableEventCount).toBe(1);
  });

  it('follows the striking wrist for a left-handed player', () => {
    const { sequence, window } = generateSwingSequence({ handed: 'left' });
    const decision = admitImportedStrokeEvents(sequence);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.event.wrist).toBe('left_wrist');
    expect(Math.abs(decision.event.peakMs - window.peakMs)).toBeLessThanOrEqual(
      100,
    );
  });

  it.each([12, 24, 30, 120, 240])(
    'measures the same single swing at %d fps as one stroke (smoothing spans time, not samples)',
    fps => {
      const { sequence, window } = generateSwingSequence({
        handed: 'right',
        fps,
      });
      const decision = admitImportedStrokeEvents(sequence);
      expect(decision.admitted).toBe(true);
      if (!decision.admitted) return;
      expect(decision.comparableEventCount).toBe(1);
      expect(
        Math.abs(decision.event.peakMs - window.peakMs),
      ).toBeLessThanOrEqual(Math.max(100, 1000 / fps));
      expect(decision.event.endMs).toBeLessThan(window.endMs);
    },
  );

  it('treats both wrists moving through the same swing as ONE event', () => {
    const { sequence, window } = singleSwing();
    const twoHanded: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => {
        const right = frame.landmarks.find(mark => mark.name === 'right_wrist');
        return {
          ...frame,
          landmarks: frame.landmarks.map(mark =>
            mark.name === 'left_wrist' && right
              ? { ...mark, x: right.x - 0.02, y: right.y + 0.01 }
              : mark,
          ),
        };
      }),
    };
    const decision = admitImportedStrokeEvents(twoHanded);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.comparableEventCount).toBe(1);
    expect(decision.candidates.filter(c => c.comparable)).toHaveLength(2);
    expect(new Set(decision.candidates.map(c => c.wrist)).size).toBe(2);
    expect(Math.abs(decision.event.peakMs - window.peakMs)).toBeLessThanOrEqual(
      100,
    );
  });

  it('is deterministic for identical input', () => {
    const { sequence } = singleSwing();
    expect(admitImportedStrokeEvents(sequence)).toEqual(
      admitImportedStrokeEvents(sequence),
    );
  });

  it('rejects two comparable strokes instead of picking the louder one', () => {
    const first = singleSwing();
    const second = singleSwing();
    const rally = concatSequences(first.sequence, second.sequence, 1000);

    // The offline detector (BASE behaviour for imports) happily returns ONE
    // window for this clip — it selects the most prominent peak. Admission
    // must refuse it.
    expect(detectOfflineStrokeWindow(rally).ok).toBe(true);

    const decision = admitImportedStrokeEvents(rally);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
    const comparable = decision.candidates.filter(c => c.comparable);
    expect(comparable).toHaveLength(2);
    const secondPeak =
      (first.sequence.frames[first.sequence.frames.length - 1]?.timestampMs ??
        0) +
      1000 +
      second.window.peakMs;
    expect(
      Math.abs((comparable[0]?.peakMs ?? 0) - first.window.peakMs),
    ).toBeLessThanOrEqual(100);
    expect(
      Math.abs((comparable[1]?.peakMs ?? 0) - secondPeak),
    ).toBeLessThanOrEqual(100);
    expect(decision.detail).toContain(String(comparable[0]?.peakMs));
    expect(decision.detail).toContain(String(comparable[1]?.peakMs));
  });

  it('rejects a slower second stroke that still peaks comparably', () => {
    const fast = singleSwing();
    const slower = generateSwingSequence({
      accelerateMs: 400,
      followMs: 450,
    });
    const rally = concatSequences(fast.sequence, slower.sequence, 800);
    const decision = admitImportedStrokeEvents(rally);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
  });

  it('rejects a much softer second stroke (about 45% of the peak) as ambiguous', () => {
    const drive = singleSwing();
    const driveDecision = admitImportedStrokeEvents(drive.sequence);
    expect(driveDecision.admitted).toBe(true);
    if (!driveDecision.admitted) return;
    const softPeak = driveDecision.event.peakSpeed * 0.45;
    const soft = wristSpeedProfile(2000, 60, hump(1000, 400, softPeak));
    const rally = concatSequences(drive.sequence, soft, 800);
    const decision = admitImportedStrokeEvents(rally);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('admits one stroke beside clearly weaker incidental motion, exposing both', () => {
    const swing = singleSwing();
    // ~1.75 torso lengths/s: measurable motion, below the comparable floor.
    const idleFidget = wristSpeedProfile(2000, 60, hump(1000, 400, 0.35));
    const clip = concatSequences(swing.sequence, idleFidget, 100);
    const decision = admitImportedStrokeEvents(clip);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(
      Math.abs(decision.event.peakMs - swing.window.peakMs),
    ).toBeLessThanOrEqual(100);
    expect(decision.comparableEventCount).toBe(1);
    expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
    expect(
      decision.candidates.filter(c => !c.comparable).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('is monotonic: a much stronger third stroke never demotes two admitted strokes', () => {
    const swing = singleSwing();
    const rally = concatSequences(swing.sequence, swing.sequence, 1000);
    const rallyDecision = admitImportedStrokeEvents(rally);
    expect(rallyDecision.admitted).toBe(false);
    if (rallyDecision.admitted) return;
    expect(rallyDecision.comparableEventCount).toBe(2);

    const drive = generateSwingSequence({
      backswingLengthNorm: 1.4,
      accelerateMs: 150,
      followMs: 200,
      torsoLength: 0.3,
    });
    const driveDecision = admitImportedStrokeEvents(drive.sequence);
    expect(driveDecision.admitted).toBe(true);
    if (!driveDecision.admitted) return;
    const swingDecision = admitImportedStrokeEvents(swing.sequence);
    expect(swingDecision.admitted).toBe(true);
    if (!swingDecision.admitted) return;
    // The drive peaks more than 2.5× the swing: a loudest-relative rule
    // would demote the swings.
    expect(
      swingDecision.event.peakSpeed / driveDecision.event.peakSpeed,
    ).toBeLessThan(0.4);

    for (const gapMs of [400, 800, 1500]) {
      const decision = admitImportedStrokeEvents(
        concatSequences(rally, drive.sequence, gapMs),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBe(3);
    }

    // A brief tracking burst far louder than any stroke behaves the same.
    for (const halfWidthMs of [130, 200, 300]) {
      const burst = wristSpeedProfile(
        1200,
        60,
        hump(600, halfWidthMs, driveDecision.event.peakSpeed * 4),
      );
      const decision = admitImportedStrokeEvents(
        concatSequences(rally, burst, 800),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps dink, dink, drive a rally: each is a stroke alone, so together they are three', () => {
    const dink = generateSwingSequence({
      backswingLengthNorm: 0.25,
      swingDipNorm: 0.03,
      shoulderTurnDeg: 10,
      accelerateMs: 400,
      followMs: 450,
    });
    const drive = generateSwingSequence({
      backswingLengthNorm: 1.4,
      accelerateMs: 150,
      followMs: 200,
      torsoLength: 0.3,
    });
    const dinkDecision = admitImportedStrokeEvents(dink.sequence);
    const driveDecision = admitImportedStrokeEvents(drive.sequence);
    expect(dinkDecision.admitted).toBe(true);
    expect(driveDecision.admitted).toBe(true);
    if (!dinkDecision.admitted || !driveDecision.admitted) return;
    expect(
      dinkDecision.event.peakSpeed / driveDecision.event.peakSpeed,
    ).toBeLessThan(0.4);

    const dinks = concatSequences(dink.sequence, dink.sequence, 900);
    const dinksDecision = admitImportedStrokeEvents(dinks);
    expect(dinksDecision.admitted).toBe(false);
    if (dinksDecision.admitted) return;
    expect(dinksDecision.reason).toBe('multiple_stroke_events');
    expect(dinksDecision.comparableEventCount).toBe(2);

    const decision = admitImportedStrokeEvents(
      concatSequences(dinks, drive.sequence, 900),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(3);
    expect(decision.candidates.filter(c => c.comparable)).toHaveLength(3);
  });

  it('is monotonic: appending ANY admitted stroke to a two-stroke rally keeps at least two events', () => {
    const rally = concatSequences(
      singleSwing().sequence,
      singleSwing().sequence,
      1000,
    );
    const variants = [
      generateSwingSequence(),
      generateSwingSequence({ accelerateMs: 120, followMs: 150 }),
      generateSwingSequence({ backswingLengthNorm: 1.4, accelerateMs: 150 }),
      generateSwingSequence({ torsoLength: 0.32 }),
      generateSwingSequence({
        backswingLengthNorm: 0.25,
        swingDipNorm: 0.03,
        shoulderTurnDeg: 10,
        accelerateMs: 400,
        followMs: 450,
      }),
      generateSwingSequence({
        backswingLengthNorm: 1.4,
        accelerateMs: 150,
        followMs: 200,
        torsoLength: 0.3,
      }),
    ];
    for (const variant of variants) {
      expect(admitImportedStrokeEvents(variant.sequence).admitted).toBe(true);
      for (const gapMs of [400, 1000]) {
        const decision = admitImportedStrokeEvents(
          concatSequences(rally, variant.sequence, gapMs),
        );
        expect(decision.admitted).toBe(false);
        if (decision.admitted) return;
        expect(decision.reason).toBe('multiple_stroke_events');
        // At least the three swings; a variant whose own wind-up clears the
        // absolute stroke floor against the rally's body scale adds a fourth.
        expect(decision.comparableEventCount).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps a sub-stroke wind-up shortly before a much harder forward swing as ONE stroke', () => {
    // Wind-up peaks 500 ms before contact at ~12% of the forward speed and
    // below the absolute stroke floor: alone it is not a stroke, so it
    // cannot be a second one here. It travels backward, the swing forward.
    const windUp = wristTravelProfile(
      3000,
      60,
      along(-1, hump(1200, 150, 0.6)),
    );
    const alone = admitImportedStrokeEvents(windUp);
    expect(alone.admitted).toBe(false);
    if (alone.admitted) return;
    expect(alone.reason).toBe('motion_not_stroke_like');

    const stroke = wristTravelProfile(
      3000,
      60,
      sumVelocities(
        along(-1, hump(1200, 150, 0.6)),
        along(1, hump(1700, 150, 1.6)),
      ),
    );
    const decision = admitImportedStrokeEvents(stroke);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.comparableEventCount).toBe(1);
    expect(Math.abs(decision.event.peakMs - 1700)).toBeLessThanOrEqual(60);
    expect(decision.candidates.filter(c => !c.comparable)).toHaveLength(1);
  });

  it('never demotes a stroke-sized burst without net travel: admitted alone, it stays a stroke however hard the next one is', () => {
    // The same burst at 1.2 image heights/s clears the absolute stroke floor
    // on its own and has no direction of travel, so it can be nobody's
    // wind-up: a stroke-sized burst 500 ms before a 4× harder one is a soft
    // stroke followed by a hard stroke, and the clip is refused — at 500 ms
    // and a second apart alike.
    const alone = admitImportedStrokeEvents(
      wristSpeedProfile(3000, 60, hump(1200, 150, 1.2)),
    );
    expect(alone.admitted).toBe(true);
    if (!alone.admitted) return;
    expect(alone.event.peakTorsoPerSecond).toBeGreaterThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
    );
    for (const windUpMs of [700, 1200]) {
      const decision = admitImportedStrokeEvents(
        wristSpeedProfile(
          3000,
          60,
          sumOf(hump(windUpMs, 150, 1.2), hump(1700, 150, 5)),
        ),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBe(2);
      expect(decision.candidates.filter(c => c.comparable)).toHaveLength(2);
    }
  });

  it('refuses a lone wrist movement too slow to be a stroke, in body-scale units', () => {
    // Same shape as the incidental fidget above: admitted alone it would be
    // demoted the moment a real stroke is appended — so it is not a stroke.
    const fidget = wristSpeedProfile(2000, 60, hump(1000, 400, 0.7));
    const decision = admitImportedStrokeEvents(fidget);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('motion_not_stroke_like');
    expect(decision.detail).toContain('torso lengths/s');
  });

  it('refuses a clip whose shoulders and hips are never tracked together', () => {
    const { sequence } = singleSwing();
    const hidden: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: frame.landmarks.map(mark =>
          mark.name === 'left_hip' || mark.name === 'right_hip'
            ? { ...mark, visibility: 0 }
            : mark,
        ),
      })),
    };
    const decision = admitImportedStrokeEvents(hidden);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('body_scale_unmeasured');
    expect(importAdmissionRejectionMessage(decision.reason)).toContain(
      'shoulders and hips',
    );
  });

  it('rejects a clip with no stroke event (idle player)', () => {
    const idle = wristSpeedProfile(3000, 60, () => 0);
    const decision = admitImportedStrokeEvents(idle);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('no_stroke_event');
    expect(decision.comparableEventCount).toBe(0);
    expect(decision.candidates).toEqual([]);
  });

  it('rejects steady motion without a distinct peak (walking, not swinging)', () => {
    const steady = wristSpeedProfile(4000, 60, () => 0.6);
    const decision = admitImportedStrokeEvents(steady);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    // Four seconds of motion at one speed is one long movement, never a
    // stroke: refused on its duration in absolute terms, not on a
    // whole-wrist baseline that constant motion could raise.
    expect(decision.reason).toBe('motion_not_stroke_like');
    expect(decision.detail).toContain('ms');
  });

  it('rejects a sustained motion burst far longer than a stroke', () => {
    const longBurst = wristSpeedProfile(12_000, 60, hump(6000, 2500, 2.0));
    const decision = admitImportedStrokeEvents(longBurst);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('motion_not_stroke_like');
    expect(decision.comparableEventCount).toBe(1);
  });

  it('rejects a stroke cut off at the start or end of the clip', () => {
    const { sequence, window } = singleSwing();
    const midSwing = sequence.frames.filter(
      frame => frame.timestampMs >= window.peakMs - 60,
    );
    const truncatedStart: PoseSequence = {
      ...sequence,
      frames: midSwing.map((frame, index) => ({
        ...frame,
        frameIndex: index,
        timestampMs: frame.timestampMs - (midSwing[0]?.timestampMs ?? 0),
      })),
    };
    const startDecision = admitImportedStrokeEvents(truncatedStart);
    expect(startDecision.admitted).toBe(false);
    if (!startDecision.admitted) {
      expect(startDecision.reason).toBe('stroke_truncated_at_clip_edge');
    }

    const truncatedEnd: PoseSequence = {
      ...sequence,
      frames: sequence.frames.filter(
        frame => frame.timestampMs <= window.peakMs + 60,
      ),
    };
    const endDecision = admitImportedStrokeEvents(truncatedEnd);
    expect(endDecision.admitted).toBe(false);
    if (!endDecision.admitted) {
      expect(endDecision.reason).toBe('stroke_truncated_at_clip_edge');
    }
  });

  it('rejects sequences with too few frames or no tracked wrist', () => {
    const { sequence } = singleSwing();
    const sparse: PoseSequence = {
      ...sequence,
      frames: sequence.frames.slice(0, 11),
    };
    const sparseDecision = admitImportedStrokeEvents(sparse);
    expect(sparseDecision.admitted).toBe(false);
    if (!sparseDecision.admitted) {
      expect(sparseDecision.reason).toBe('too_few_pose_frames');
    }

    const wristless: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: frame.landmarks.map(mark =>
          mark.name.endsWith('_wrist') ? { ...mark, visibility: 0.1 } : mark,
        ),
      })),
    };
    const wristDecision = admitImportedStrokeEvents(wristless);
    expect(wristDecision.admitted).toBe(false);
    if (!wristDecision.admitted) {
      expect(wristDecision.reason).toBe('wrist_not_tracked');
    }
  });

  it('rejects two full strokes whose ready pause is shorter than the merge gap (round-3 review)', () => {
    // Reviewer probe: the second swing's ready pause is 200 ms instead of
    // 400, so the wrist is quiet for < 500 ms between two complete, equal
    // strokes whose contacts are ~1.77 s apart — a normal rally cadence.
    for (const readyMs of [100, 200, 300, 400]) {
      const first = generateSwingSequence({ readyMs: 400, recoverMs: 550 });
      const second = generateSwingSequence({ readyMs, recoverMs: 550 });
      expectMultipleStrokes(
        concatSequences(first.sequence, second.sequence, 0),
      );
    }
    const shortRecovery = generateSwingSequence({
      readyMs: 300,
      recoverMs: 300,
    });
    expectMultipleStrokes(
      concatSequences(
        shortRecovery.sequence,
        generateSwingSequence({ readyMs: 300 }).sequence,
        0,
      ),
    );
  });

  it('counts two identical trimmed swings 0–100 ms apart as two events, not one', () => {
    const core = trimSequence(singleSwing().sequence, 200, 1500);
    for (const gapMs of [0, 100, 200]) {
      const rally = concatSequences(core, core, gapMs);
      expectMultipleStrokes(rally);
      const decision = admitImportedStrokeEvents(rally);
      if (decision.admitted) return;
      expect(decision.comparableEventCount).toBe(2);
      const comparable = decision.candidates.filter(c => c.comparable);
      expect(comparable).toHaveLength(2);
      // Neither event may swallow the other: each ends before the next
      // one's peak.
      expect(comparable[0]?.endMs ?? 0).toBeLessThan(
        comparable[1]?.peakMs ?? 0,
      );
    }
  });

  it('counts two identical speed peaks 600–800 ms apart as two events, not one', () => {
    for (const separationMs of [600, 800, 1000]) {
      const twoPeaks = wristSpeedProfile(
        4000,
        60,
        sumOf(hump(1500, 250, 2.5), hump(1500 + separationMs, 250, 2.5)),
      );
      const decision = admitImportedStrokeEvents(twoPeaks);
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBe(2);
      const peaks = decision.candidates
        .filter(c => c.comparable)
        .map(c => c.peakMs)
        .sort((a, b) => a - b);
      expect(Math.abs((peaks[0] ?? 0) - 1500)).toBeLessThanOrEqual(60);
      expect(
        Math.abs((peaks[1] ?? 0) - (1500 + separationMs)),
      ).toBeLessThanOrEqual(60);
    }
  });

  it('keeps one continuous swing with a brief contact dip as ONE event', () => {
    // Speed dips to ~70% of the peak for ~80 ms around contact and the two
    // local maxima are 150 ms apart — one stroke, not two.
    const dipped = wristSpeedProfile(3000, 60, tMs =>
      Math.max(hump(1500, 400, 2.5)(tMs) - hump(1500, 60, 0.9)(tMs), 0),
    );
    const decision = admitImportedStrokeEvents(dipped);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.comparableEventCount).toBe(1);
    expect(Math.abs(decision.event.peakMs - 1500)).toBeLessThanOrEqual(120);
  });

  it('is monotonic: motion of the OTHER wrist between two rejected strokes never admits them', () => {
    const strokes = sumOf(hump(1000, 250, 2.5), hump(2800, 250, 2.5));
    const alone = twoWristSpeedProfile(4000, 60, strokes, () => 0);
    const aloneDecision = admitImportedStrokeEvents(alone);
    expect(aloneDecision.admitted).toBe(false);
    if (aloneDecision.admitted) return;
    expect(aloneDecision.reason).toBe('multiple_stroke_events');
    expect(aloneDecision.comparableEventCount).toBe(2);

    // Adversary shape: a slow left-wrist hump (about half the peak) that
    // overlaps BOTH right-wrist strokes in time.
    for (const leftPeak of [0.6, 1.2, 2.5]) {
      const bridged = twoWristSpeedProfile(
        4000,
        60,
        strokes,
        hump(1900, 800, leftPeak),
      );
      const decision = admitImportedStrokeEvents(bridged);
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBeGreaterThanOrEqual(
        aloneDecision.comparableEventCount,
      );
    }

    // Same wrist: a slow hump between the two strokes must not fuse them.
    const sameWrist = wristSpeedProfile(
      4000,
      60,
      sumOf(strokes, hump(1900, 600, 1.2)),
    );
    expectMultipleStrokes(sameWrist);
  });

  it('is monotonic: appending a second swing to an admitted clip always rejects it', () => {
    const swing = singleSwing();
    expect(admitImportedStrokeEvents(swing.sequence).admitted).toBe(true);
    for (const gapMs of [0, 50, 150, 350, 500, 1000, 3000]) {
      expectMultipleStrokes(
        concatSequences(swing.sequence, swing.sequence, gapMs),
      );
    }
  });

  it('never fabricates a stroke from a single-sample tracking spike', () => {
    const idle = wristSpeedProfile(3000, 60, () => 0);
    const spikeIndex = 90;
    const spiked: PoseSequence = {
      ...idle,
      frames: idle.frames.map((frame, index) =>
        index === spikeIndex
          ? {
              ...frame,
              landmarks: frame.landmarks.map(mark =>
                mark.name === 'right_wrist' ? { ...mark, x: 0.05 } : mark,
              ),
            }
          : frame,
      ),
    };
    const decision = admitImportedStrokeEvents(spiked);
    expect(decision.admitted).toBe(false);
  });
});

describe('W03-01 import admission — combined gate', () => {
  it('admits a supported clip with one stroke and returns media + event', () => {
    const { sequence, window } = singleSwing();
    const clip = importedClip(sequence);
    const decision = admitImportedClip(clip, sequence, { codec: 'avc1' });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.media.codec).toBe('avc1');
    expect(Math.abs(decision.event.peakMs - window.peakMs)).toBeLessThanOrEqual(
      100,
    );
  });

  it('refuses the container first, before any stroke evidence is consulted', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence, { durationMs: 61_000 });
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('duration_too_long');
  });

  it('refuses a clip whose sidecar is missing', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence, { poseSequence: undefined });
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_sequence_missing');
  });

  it('refuses a sidecar whose frame geometry disagrees with the clip (rotation applied inconsistently)', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence, { width: 1920, height: 1080 });
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('refuses a sidecar whose frame rate disagrees with the clip', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence, { fps: sequence.video.fps + 1 });
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('refuses a sidecar whose frame count disagrees with the recorded ref', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence);
    const shortened: PoseSequence = {
      ...sequence,
      frames: sequence.frames.slice(0, -1),
    };
    const decision = admitImportedClip(clip, shortened);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('refuses a sidecar whose timeline runs past the clip', () => {
    const { sequence } = singleSwing();
    const last = sequence.frames[sequence.frames.length - 1]?.timestampMs ?? 0;
    const clip = importedClip(sequence, { durationMs: last - 500 });
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('refuses a sidecar whose timeline starts before the clip', () => {
    const { sequence } = singleSwing();
    const shifted: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        timestampMs: frame.timestampMs - 1000,
      })),
    };
    const clip = importedClip(sequence);
    const decision = admitImportedClip(clip, shifted);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('refuses a sidecar that covers only a sliver of a long clip', () => {
    // 2 s of tracked poses inside a 45 s import: 43 s of the clip carry no
    // evidence at all, so a single stroke cannot be vouched for.
    const { sequence } = singleSwing();
    const clip = importedClip(sequence, { durationMs: 45_000 });
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_coverage_incomplete');

    const lateStart: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        timestampMs: frame.timestampMs + 20_000,
      })),
    };
    const lateClip = importedClip(lateStart);
    const lateDecision = admitImportedClip(lateClip, lateStart);
    expect(lateDecision.admitted).toBe(false);
    if (lateDecision.admitted) return;
    expect(lateDecision.reason).toBe('pose_coverage_incomplete');
  });

  it('refuses a sidecar with a long untracked gap inside the clip', () => {
    const swing = singleSwing();
    const idle = wristSpeedProfile(2000, 60, () => 0);
    const gapped = concatSequences(swing.sequence, idle, 6000);
    const clip = importedClip(gapped);
    const decision = admitImportedClip(clip, gapped);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_coverage_incomplete');
  });

  it('refuses a clip whose body is tracked but whose wrists are unmeasured for seconds', () => {
    // Pose coverage passes frame by frame; other strokes may have happened
    // while neither wrist was measured, so the clip is not a single stroke.
    const swing = singleSwing();
    const hideWrists = (sequence: PoseSequence): PoseSequence => ({
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: frame.landmarks.map(mark =>
          mark.name === 'left_wrist' || mark.name === 'right_wrist'
            ? { ...mark, visibility: 0 }
            : mark,
        ),
      })),
    });
    const armless = hideWrists(wristSpeedProfile(4000, 60, () => 0));
    const sequence = concatSequences(
      concatSequences(armless, swing.sequence, 17),
      armless,
      17,
    );
    const clip = importedClip(sequence);
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('wrist_not_tracked');
    expect(decision.detail).toContain('without either wrist tracked');

    const brief = hideWrists(wristSpeedProfile(17, 60, () => 0));
    const okSequence = concatSequences(
      concatSequences(brief, swing.sequence, 17),
      brief,
      17,
    );
    expect(
      admitImportedClip(importedClip(okSequence), okSequence).admitted,
    ).toBe(true);
  });

  it('still admits a single stroke with short untracked lead-in and tail', () => {
    const { sequence, window } = singleSwing();
    const shifted: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        timestampMs: frame.timestampMs + 100,
      })),
    };
    const clip = importedClip(shifted, {
      durationMs:
        (shifted.frames[shifted.frames.length - 1]?.timestampMs ?? 0) + 100,
    });
    const decision = admitImportedClip(clip, shifted);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(
      Math.abs(decision.event.peakMs - (window.peakMs + 100)),
    ).toBeLessThanOrEqual(100);
  });

  it('refuses an ambiguous two-stroke clip through the combined gate', () => {
    const first = singleSwing();
    const second = singleSwing();
    const rally = concatSequences(first.sequence, second.sequence, 1000);
    const clip = importedClip(rally);
    const decision = admitImportedClip(clip, rally);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
  });

  it('does not mutate its inputs and is deterministic across calls', () => {
    const first = singleSwing();
    const rally = concatSequences(first.sequence, first.sequence, 300);
    const clip = importedClip(rally);
    const clipSnapshot = JSON.stringify(clip);
    const rallySnapshot = JSON.stringify(rally);
    const a = admitImportedClip(clip, rally);
    const b = admitImportedClip(clip, rally);
    expect(a).toEqual(b);
    expect(JSON.stringify(clip)).toBe(clipSnapshot);
    expect(JSON.stringify(rally)).toBe(rallySnapshot);
  });
});

/**
 * Round 7 — the round-6 adversary (attack-42bf4c60) broke the candidate four
 * ways. A1: four volleys whose valleys stayed at 64–75 % of the peaks fused
 * into ONE admitted stroke (the absolute jitter floor swallowed the dips).
 * A2: a slower opposite-direction burst that is a stroke on its own was
 * folded into a harder neighbour as its wind-up or recovery, so ADDING a
 * burst turned a refused two-stroke clip into an admitted one. A3: the
 * clip-edge check looked at the stroke core only, so a clip starting
 * mid-wind-up or ending mid-recovery was admitted. A4: a second stroke
 * inside a wrist-tracking hole shorter than `maxUntrackedSpanMs` was
 * invisible and the lone visible stroke was admitted. Each must be refused
 * before any permit is reserved.
 */
describe('W03-01 regression — round 7: hand battles with shallow valleys', () => {
  /** `count` volleys every `periodMs` from 1000 ms, speed oscillating valley→peak. */
  function volleys(
    peak: number,
    valley: number,
    count: number,
    periodMs = 450,
  ) {
    const endMs = 1000 + count * periodMs;
    return (tMs: number): number => {
      if (tMs < 1000 || tMs > endMs) return 0;
      const phase = ((tMs - 1000) % periodMs) / periodMs;
      return (
        valley + (peak - valley) * Math.max(0, 1 - Math.abs(phase - 0.5) * 2)
      );
    };
  }

  it('control: one lone volley of this shape is a stroke on its own', () => {
    const decision = admitImportedStrokeEvents(
      wristSpeedProfile(5000, 60, volleys(1.0, 0.72, 1)),
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.event.peakTorsoPerSecond).toBeGreaterThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
    );
  });

  it('refuses four volleys in 1.8 s however shallow the valleys between them (60–75 % of the peaks)', () => {
    // Each volley is a stroke on its own (control above); four of them in
    // 1.8 s are four strokes however little the hand rests between them.
    for (const valley of [0.6, 0.64, 0.66, 0.68, 0.7, 0.72, 0.75]) {
      const decision = admitImportedStrokeEvents(
        wristSpeedProfile(5000, 60, volleys(1.0, valley, 4)),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBeGreaterThanOrEqual(3);
    }
  });

  it('refuses a drive followed by three volleys that never drop below 72 % of their own peaks', () => {
    const rally = sumOf(hump(1000, 150, 2.0), volleys(1.0, 0.72, 3, 450));
    expectMultipleStrokes(wristSpeedProfile(5000, 60, rally), 3);
  });

  it('refuses 1.8 s at stroke speed even when the valleys all but vanish: one stroke never keeps the wrist at speed that long', () => {
    for (const valley of [0.85, 0.9, 0.95]) {
      const decision = admitImportedStrokeEvents(
        wristSpeedProfile(5000, 60, volleys(1.0, valley, 4)),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(['multiple_stroke_events', 'motion_not_stroke_like']).toContain(
        decision.reason,
      );
    }
  });

  it('refuses two volleys 450 ms apart at 72 % and at 90 % valleys', () => {
    for (const valley of [0.72, 0.9]) {
      const decision = admitImportedStrokeEvents(
        wristSpeedProfile(5000, 60, volleys(1.0, valley, 2)),
      );
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(['multiple_stroke_events', 'motion_not_stroke_like']).toContain(
        decision.reason,
      );
    }
  });
});

describe('W03-01 regression — round 7: a stroke-sized burst folds only as a backswing flowing straight into a far harder swing', () => {
  const SOFT = 1.2;
  const HARD = 3.0;

  it('control: each soft backward burst is a stroke on its own', () => {
    const decision = admitImportedStrokeEvents(
      wristTravelProfile(3000, 60, along(-1, hump(1000, 150, SOFT))),
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.event.peakTorsoPerSecond).toBeGreaterThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
    );
  });

  it('control: two backward strokes 700 ms apart are refused as two events', () => {
    expectMultipleStrokes(
      wristTravelProfile(
        3000,
        60,
        sumVelocities(
          along(-1, hump(1000, 150, SOFT)),
          along(-1, hump(1700, 150, SOFT)),
        ),
      ),
      2,
    );
  });

  it('adding a harder forward burst between the two refused strokes keeps the refusal', () => {
    // Adding motion can only keep or raise the number of comparable events.
    // The forward burst sits between the two backward strokes with a 50 ms
    // pause on each side; the trailing burst is a stroke, not a recovery.
    expectMultipleStrokes(
      wristTravelProfile(
        3000,
        60,
        sumVelocities(
          along(-1, hump(1000, 150, SOFT)),
          along(1, hump(1350, 150, HARD)),
          along(-1, hump(1700, 150, SOFT)),
        ),
      ),
      2,
    );
  });

  it('a soft backward stroke resting 300 ms before a hard forward one stays two events', () => {
    // A stroke-sized burst is a wind-up only when it flows straight into
    // the swing; after a rest it was a stroke of its own.
    expectMultipleStrokes(
      wristTravelProfile(
        3000,
        60,
        sumVelocities(
          along(-1, hump(1200, 150, 1.0)),
          along(1, hump(1800, 150, HARD)),
        ),
      ),
      2,
    );
  });

  it('still folds a stroke-sized backswing that flows straight into a far harder swing', () => {
    const decision = admitImportedStrokeEvents(
      wristTravelProfile(
        3000,
        60,
        sumVelocities(
          along(-1, hump(1000, 150, SOFT)),
          along(1, hump(1350, 150, HARD)),
        ),
      ),
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.comparableEventCount).toBe(1);
    expect(Math.abs(decision.event.peakMs - 1350)).toBeLessThanOrEqual(60);
  });

  it('a stroke-sized burst after the swing is a second stroke, never a recovery', () => {
    expectMultipleStrokes(
      wristTravelProfile(
        3000,
        60,
        sumVelocities(
          along(1, hump(1000, 150, HARD)),
          along(-1, hump(1350, 150, SOFT)),
        ),
      ),
      2,
    );
  });
});

describe('W03-01 regression — round 7: a stroke cut mid-wind-up or mid-recovery is truncated', () => {
  const WIND_UP = 1.2;
  const SWING = 3.0;

  /** Backward wind-up peaking at `windUpMs`, forward swing 350 ms later. */
  function windUpThenSwing(windUpMs: number, durationMs: number) {
    return wristTravelProfile(
      durationMs,
      60,
      sumVelocities(
        along(-1, hump(windUpMs, 150, WIND_UP)),
        along(1, hump(windUpMs + 350, 150, SWING)),
      ),
    );
  }

  /** A forward swing whose sub-stroke backward recovery decays to rest. */
  function swingThenRecovery(durationMs: number) {
    return wristTravelProfile(
      durationMs,
      60,
      sumVelocities(
        along(1, hump(1000, 150, SWING)),
        along(-1, hump(1350, 150, 0.6)),
      ),
    );
  }

  it('control: the full wind-up + swing is admitted as ONE stroke', () => {
    expect(
      admitImportedStrokeEvents(windUpThenSwing(1000, 3000)).admitted,
    ).toBe(true);
  });

  it('refuses the same stroke when the clip starts in the middle of its wind-up', () => {
    // The first frame lands at the wind-up's peak: the backswing is half
    // outside the video, exactly the moment of setup the copy asks for.
    const decision = admitImportedStrokeEvents(
      trimSequence(windUpThenSwing(1000, 3000), 1000, 3000),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('stroke_truncated_at_clip_edge');
  });

  it('refuses a stroke when the clip ends in the middle of its recovery', () => {
    const full = swingThenRecovery(3000);
    expect(admitImportedStrokeEvents(full).admitted).toBe(true);
    const decision = admitImportedStrokeEvents(trimSequence(full, 0, 1350));
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('stroke_truncated_at_clip_edge');
  });

  it('refuses a wind-up that emerges from a tracking gap at full speed', () => {
    const decision = admitImportedStrokeEvents(
      occludeRightWrist(windUpThenSwing(1000, 3000), 700, 1000),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('stroke_truncated_at_clip_edge');
  });

  it('still admits a stroke whose recovery has decayed to rest by the last frame', () => {
    // The recovery's span reaches the clip edge, but the wrist is at rest
    // there: nothing of the movement is missing.
    const decision = admitImportedStrokeEvents(swingThenRecovery(1650));
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.event.endMs).toBeGreaterThan(1350);
  });
});

describe('W03-01 regression — round 7: a wrist-tracking hole could hide a stroke', () => {
  function twoStrokes(secondMs: number, durationMs: number) {
    return wristSpeedProfile(
      durationMs,
      60,
      sumOf(hump(1000, 150, 1.0), hump(secondMs, 150, 1.0)),
    );
  }

  it('control: two strokes 1.5 s apart are refused', () => {
    expectMultipleStrokes(twoStrokes(2500, 4000), 2);
  });

  it('refuses the clip when the second stroke is exactly the untracked span', () => {
    // Motion blur on the harder stroke loses the wrist for 400 ms: the
    // second stroke is unmeasured, so the clip is NOT known to hold one
    // stroke. Admission refuses rather than vouching for what it cannot see.
    const hidden = occludeRightWrist(twoStrokes(2500, 4000), 2300, 2700);
    const decision = admitImportedClip(importedClip(hidden), hidden);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('wrist_not_tracked');
    expect(decision.detail).toContain('right_wrist');
  });

  it('refuses the clip when a 2.4 s hole (inside maxUntrackedSpanMs) swallows a stroke', () => {
    const hidden = occludeRightWrist(twoStrokes(2500, 5000), 1400, 3800);
    const decision = admitImportedClip(importedClip(hidden), hidden);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('wrist_not_tracked');
  });

  it('refuses the same hole with nothing inside it: the visible evidence is identical either way', () => {
    // With the wrist below the visibility floor the two clips carry the
    // SAME measurable evidence; a gate that admitted this one would admit
    // the hidden stroke too.
    const lone = wristSpeedProfile(4000, 60, hump(1000, 150, 1.0));
    const holed = occludeRightWrist(lone, 2300, 2700);
    const decision = admitImportedClip(importedClip(holed), holed);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('wrist_not_tracked');
  });

  it('a hole in the OTHER wrist does not refuse the striking wrist’s lone stroke', () => {
    const lone = wristSpeedProfile(4000, 60, hump(1000, 150, 1.0));
    const holed: PoseSequence = {
      ...lone,
      frames: lone.frames.map(frame =>
        frame.timestampMs >= 2300 && frame.timestampMs <= 2700
          ? {
              ...frame,
              landmarks: frame.landmarks.map(mark =>
                mark.name === 'left_wrist' ? { ...mark, visibility: 0 } : mark,
              ),
            }
          : frame,
      ),
    };
    expect(admitImportedClip(importedClip(holed), holed).admitted).toBe(true);
  });
});

describe('W03-01 import admission — probe boundary values', () => {
  it('rejects absurd or non-finite rotations instead of normalizing them', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence);
    for (const rotationDegrees of [
      1e300,
      -1e300,
      Number.POSITIVE_INFINITY,
      (Number.MAX_SAFE_INTEGER + 2) * 90,
      0.5,
      90.000001,
    ]) {
      const decision = admitImportedMedia(clip, { rotationDegrees });
      expect(decision.admitted).toBe(false);
      if (!decision.admitted) {
        expect(decision.reason).toBe('unsupported_rotation');
      }
    }
  });

  it('reports an unreadable duration as unknown, not as too short', () => {
    const { sequence } = singleSwing();
    for (const durationMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const clip = importedClip(sequence, { durationMs });
      const decision = admitImportedMedia(clip);
      expect(decision.admitted).toBe(false);
      if (!decision.admitted) {
        expect(decision.reason).toBe('duration_unknown');
      }
    }
  });

  it('rejects a non-finite track count and a codec tag with control bytes', () => {
    const { sequence } = singleSwing();
    const clip = importedClip(sequence);
    for (const videoTrackCount of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const decision = admitImportedMedia(clip, { videoTrackCount });
      expect(decision.admitted).toBe(false);
      if (!decision.admitted) {
        expect(decision.reason).toBe('unsupported_track_layout');
      }
    }
    for (const codec of ['avc1\u0000', 'avc1\n', 'avc1 hvc1']) {
      const decision = admitImportedMedia(clip, { codec });
      expect(decision.admitted).toBe(false);
      if (!decision.admitted) expect(decision.reason).toBe('unsupported_codec');
    }
  });

  it('rejects a sidecar whose timestamps never advance', () => {
    const { sequence } = singleSwing();
    const frozen: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({ ...frame, timestampMs: 0 })),
    };
    const decision = admitImportedStrokeEvents(frozen);
    expect(decision.admitted).toBe(false);
  });
});

describe('W03-01 import admission — user-facing copy', () => {
  const forbidden = [
    /android/i,
    /google play/i,
    /guest/i,
    /live court/i,
    /dupr/i,
    /%/,
    /\bbest\b/i,
    /accura/i,
    /\bAI coach\b/i,
  ];

  it('has honest, store-compliant guidance for every rejection reason', () => {
    const reasons: readonly ImportAdmissionReason[] = IMPORT_ADMISSION_REASONS;
    expect(reasons.length).toBeGreaterThanOrEqual(15);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) {
      const message = importAdmissionRejectionMessage(reason);
      expect(message.trim().length).toBeGreaterThan(20);
      expect(message.trim()).toMatch(/[.!]$/);
      for (const pattern of forbidden) {
        expect(message).not.toMatch(pattern);
      }
    }
  });

  it('tells the player about several strokes when the clip is ambiguous', () => {
    expect(importAdmissionRejectionMessage('multiple_stroke_events')).toMatch(
      /one stroke|single stroke/i,
    );
    expect(importAdmissionRejectionMessage('duration_too_long')).toContain(
      '60 seconds',
    );
  });
});

/**
 * Round 8 — adversary shapes against the round-7 candidate (attack-da6ff3c7).
 *
 * (1) A rally whose peaks decay (or rise) 10 % per volley: the valley between
 *     two neighbours sits above 80 % of the LESSER peak, so round 7 fused the
 *     whole rally into one event, while the plateau guard — measured against
 *     the cluster's HIGHEST peak — saw the deeper valleys leave the near-peak
 *     band. One movement never drops more than a jitter below its own
 *     highest peak between its first and last maximum.
 * (2) Two volleys closer together than `sameEventPeakDistanceMs` with a
 *     45-55 % valley were one "contact dip". A contact dip is shallow; a
 *     valley that deep is a reversal between two strokes.
 * (3) A whole-pose gap (the native extractor emits nothing where Vision finds
 *     no person) of up to `maxUntrackedSpanMs` could hide any number of
 *     strokes: a stroke's motion core fits in 150 ms, so no unobserved
 *     stretch — lead-in, tail or interior — may be longer than that.
 * (4) The hitting wrist unobserved before its first / after its last
 *     measurement while the body is tracked was not a "hole" at all.
 * (5) A sidecar that begins 2.4 s into the clip (bounded only by
 *     `maxUntrackedSpanMs`) was admitted with half the clip unobserved.
 * Every shape must be refused with a precise reason; controls pin that a
 * lone volley, a ≤ 150 ms gap and a short lead-in are still admitted.
 */
function rally(
  startMs: number,
  periodMs: number,
  peaks: readonly number[],
  valleys: readonly number[],
): (tMs: number) => number {
  return (tMs: number): number => {
    const endMs = startMs + peaks.length * periodMs;
    if (tMs < startMs || tMs >= endMs) return 0;
    const index = Math.min(
      Math.floor((tMs - startMs) / periodMs),
      peaks.length - 1,
    );
    const phase = ((tMs - startMs) % periodMs) / periodMs;
    const peak = peaks[index] ?? 0;
    const before = index === 0 ? 0 : (valleys[index - 1] ?? 0);
    const after = index === peaks.length - 1 ? 0 : (valleys[index] ?? 0);
    return phase < 0.5
      ? before + (peak - before) * (phase * 2)
      : peak - (peak - after) * ((phase - 0.5) * 2);
  };
}

/** Removes EVERY frame inside [fromMs, toMs]: Vision found no person there. */
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

/** Delays the whole sidecar by `offsetMs`: the clip starts before the first pose. */
function shiftFrames(sequence: PoseSequence, offsetMs: number): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map(frame => ({
      ...frame,
      timestampMs: frame.timestampMs + offsetMs,
    })),
  };
}

function occludeLeftWrist(
  sequence: PoseSequence,
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
              mark.name === 'left_wrist'
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

function clipReasonOf(
  sequence: PoseSequence,
): ImportAdmissionReason | 'ADMITTED' {
  const decision = admitImportedClip(importedClip(sequence), sequence);
  return decision.admitted ? 'ADMITTED' : decision.reason;
}

describe('W03-01 regression — round 8: decaying and rising rallies are several strokes', () => {
  const DECAYING = [1.0, 0.9, 0.81, 0.73] as const;
  const DECAY_VALLEYS = [0.73, 0.66, 0.6] as const;

  it('refuses four volleys every 450 ms whose peaks decay 10 % each', () => {
    expectMultipleStrokes(
      wristSpeedProfile(4000, 60, rally(1000, 450, DECAYING, DECAY_VALLEYS)),
      3,
    );
  });

  it('refuses the mirror image: four volleys whose peaks rise 10 % each', () => {
    expectMultipleStrokes(
      wristSpeedProfile(
        4000,
        60,
        rally(1000, 450, [...DECAYING].reverse(), [...DECAY_VALLEYS].reverse()),
      ),
      3,
    );
  });

  it('refuses a decaying rally even at contact-dip cadence (300 ms)', () => {
    expectMultipleStrokes(
      wristSpeedProfile(4000, 60, rally(1000, 300, DECAYING, DECAY_VALLEYS)),
      2,
    );
  });

  it('refuses two volleys whose valley sits at 81 % of the softer but 73 % of the harder peak', () => {
    expectMultipleStrokes(
      wristSpeedProfile(3000, 60, rally(1000, 450, [1.0, 0.9], [0.73])),
      2,
    );
  });

  it('control: the hardest volley of the decaying rally is admitted alone', () => {
    const decision = admitImportedStrokeEvents(
      wristSpeedProfile(3000, 60, rally(1000, 450, [DECAYING[0]], [])),
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.candidates).toHaveLength(1);
  });

  it('publishes the jitter rise it tolerates: tighter than the shared-valley wobble of the lesser peak', () => {
    expect(IMPORT_ADMISSION_LIMITS.maxJitterRiseRatio).toBeGreaterThan(0);
    expect(IMPORT_ADMISSION_LIMITS.maxJitterRiseRatio).toBeLessThan(
      1 - IMPORT_ADMISSION_LIMITS.maxSharedValleyRatio,
    );
  });
});

describe('W03-01 regression — round 8: two volleys inside the contact-dip window', () => {
  it('refuses two equal volleys 330 ms apart with a 55 % valley', () => {
    expectMultipleStrokes(
      wristSpeedProfile(3000, 60, rally(1000, 330, [1.0, 1.0], [0.55])),
      2,
    );
  });

  it('refuses a hard then a softer volley 330 ms apart with a 45 % valley', () => {
    expectMultipleStrokes(
      wristSpeedProfile(3000, 60, rally(1000, 330, [1.2, 0.8], [0.45])),
      2,
    );
  });

  it('control: the same two peaks with a dead stop between them are refused too', () => {
    expectMultipleStrokes(
      wristSpeedProfile(3000, 60, rally(1000, 330, [1.0, 1.0], [0])),
      2,
    );
  });

  it('control: a genuine contact dip (90 % of the peak, 150 ms between maxima) is still one stroke', () => {
    const dipped = wristSpeedProfile(3000, 60, tMs =>
      Math.max(hump(1500, 400, 2.5)(tMs) - hump(1500, 60, 0.9)(tMs), 0),
    );
    const decision = admitImportedStrokeEvents(dipped);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.candidates).toHaveLength(1);
  });
});

describe('W03-01 regression — round 8: a whole-pose gap could hide a stroke', () => {
  function twoStrokes(durationMs: number, secondMs: number): PoseSequence {
    return wristSpeedProfile(
      durationMs,
      60,
      sumOf(hump(1000, 150, 1.0), hump(secondMs, 150, 1.0)),
    );
  }

  it('control: the two visible strokes are refused', () => {
    expectMultipleStrokes(twoStrokes(4000, 2500), 2);
  });

  it('refuses the clip when the second stroke sits inside a 400 ms stretch with no pose at all', () => {
    const gapped = dropPoseFrames(twoStrokes(4000, 2500), 2300, 2700);
    expect(clipReasonOf(gapped)).toBe('pose_coverage_incomplete');
  });

  it('refuses a 2.4 s whole-pose gap that swallows the second stroke, leaving one visible', () => {
    const gapped = dropPoseFrames(twoStrokes(4000, 2500), 1500, 3900);
    expect(clipReasonOf(gapped)).toBe('pose_coverage_incomplete');
  });

  it('refuses a 2.4 s whole-pose gap between two visible strokes', () => {
    const gapped = dropPoseFrames(twoStrokes(6000, 4500), 1400, 3800);
    expect(clipReasonOf(gapped)).toBe('multiple_stroke_events');
  });

  it('refuses the same 400 ms gap with nothing inside it: the evidence is identical', () => {
    const lone = wristSpeedProfile(4000, 60, hump(1000, 150, 1.0));
    expect(clipReasonOf(dropPoseFrames(lone, 2300, 2700))).toBe(
      'pose_coverage_incomplete',
    );
  });

  it('refuses a whole-pose gap barely longer than a stroke’s motion core', () => {
    const lone = wristSpeedProfile(4000, 60, hump(1000, 150, 1.0));
    const gapMs = IMPORT_ADMISSION_LIMITS.maxUnobservedSpanMs + 50;
    expect(clipReasonOf(dropPoseFrames(lone, 2300, 2300 + gapMs))).toBe(
      'pose_coverage_incomplete',
    );
  });

  it('control: a gap of a few frames (≤ 100 ms) does not refuse the lone stroke', () => {
    const lone = wristSpeedProfile(4000, 60, hump(1000, 150, 1.0));
    expect(clipReasonOf(dropPoseFrames(lone, 2300, 2380))).toBe('ADMITTED');
  });

  it('bounds every unobserved stretch by a stroke’s motion core', () => {
    expect(IMPORT_ADMISSION_LIMITS.maxUnobservedSpanMs).toBeLessThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokeMotionMs,
    );
    expect(IMPORT_ADMISSION_LIMITS.maxUnobservedSpanMs).toBeGreaterThan(0);
  });
});

describe('W03-01 regression — round 8: the hitting wrist unobserved at the clip’s edges', () => {
  function threeStrokes(): PoseSequence {
    return wristSpeedProfile(
      7000,
      60,
      sumOf(hump(1000, 150, 1.0), hump(2500, 150, 1.0), hump(6000, 150, 1.0)),
    );
  }

  it('control: the three strokes are refused when the wrist is tracked throughout', () => {
    expectMultipleStrokes(threeStrokes(), 3);
  });

  it('refuses the clip when the hitting wrist is untracked for the first 4.5 s (two strokes hidden)', () => {
    const decision = admitImportedClip(
      importedClip(occludeRightWrist(threeStrokes(), 0, 4500)),
      occludeRightWrist(threeStrokes(), 0, 4500),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('wrist_not_tracked');
    expect(decision.detail).toContain('right_wrist');
  });

  it('refuses the clip when the hitting wrist is untracked after its last measurement (2.5-7 s)', () => {
    expect(clipReasonOf(occludeRightWrist(threeStrokes(), 2500, 7000))).toBe(
      'multiple_stroke_events',
    );
    const lone = wristSpeedProfile(7000, 60, hump(1000, 150, 1.0));
    expect(clipReasonOf(occludeRightWrist(lone, 2500, 7000))).toBe(
      'wrist_not_tracked',
    );
  });

  it('refuses an untracked lead-in with nothing inside it: the visible evidence is identical', () => {
    const lone = wristSpeedProfile(7000, 60, hump(6000, 150, 1.0));
    expect(clipReasonOf(occludeRightWrist(lone, 0, 4500))).toBe(
      'wrist_not_tracked',
    );
  });

  it('refuses a wrist lead-in barely longer than a stroke’s motion core', () => {
    const lone = wristSpeedProfile(4000, 60, hump(2000, 150, 1.0));
    const leadMs = IMPORT_ADMISSION_LIMITS.maxUnobservedSpanMs + 50;
    expect(clipReasonOf(occludeRightWrist(lone, 0, leadMs))).toBe(
      'wrist_not_tracked',
    );
  });

  it('control: the hitting wrist found a few frames late (≤ 100 ms) is still admitted', () => {
    const lone = wristSpeedProfile(4000, 60, hump(2000, 150, 1.0));
    expect(clipReasonOf(occludeRightWrist(lone, 0, 80))).toBe('ADMITTED');
  });

  it('control: the OTHER wrist unobserved at the edges does not refuse the striking wrist’s stroke', () => {
    const lone = wristSpeedProfile(4000, 60, hump(2000, 150, 1.0));
    expect(clipReasonOf(occludeLeftWrist(lone, 0, 1200))).toBe('ADMITTED');
    expect(clipReasonOf(occludeLeftWrist(lone, 2800, 4000))).toBe('ADMITTED');
  });
});

describe('W03-01 regression — round 8: an unobserved lead-in or tail longer than a stroke', () => {
  it('refuses a sidecar that begins 2.4 s into the clip', () => {
    const lone = wristSpeedProfile(1800, 60, hump(800, 150, 1.0));
    expect(clipReasonOf(shiftFrames(lone, 2400))).toBe(
      'pose_coverage_incomplete',
    );
  });

  it('refuses a sidecar that begins 400 ms into the clip', () => {
    const lone = wristSpeedProfile(3000, 60, hump(1000, 150, 1.0));
    expect(clipReasonOf(shiftFrames(lone, 400))).toBe(
      'pose_coverage_incomplete',
    );
  });

  it('refuses a clip that runs 400 ms past the last pose', () => {
    const lone = wristSpeedProfile(3000, 60, hump(1000, 150, 1.0));
    const last = lone.frames[lone.frames.length - 1]?.timestampMs ?? 0;
    const decision = admitImportedClip(
      importedClip(lone, { durationMs: last + 400 }),
      lone,
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_coverage_incomplete');
  });

  it('control: a sidecar that begins 100 ms into the clip is admitted', () => {
    const lone = wristSpeedProfile(3000, 60, hump(1000, 150, 1.0));
    expect(clipReasonOf(shiftFrames(lone, 100))).toBe('ADMITTED');
  });

  it('the generated single swing still passes the combined gate', () => {
    const { sequence } = singleSwing();
    expect(clipReasonOf(sequence)).toBe('ADMITTED');
  });
});
