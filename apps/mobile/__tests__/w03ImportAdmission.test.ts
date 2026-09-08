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
    // Conservative: a second event at well under half the peak still counts.
    expect(IMPORT_ADMISSION_LIMITS.comparablePeakRatio).toBeLessThanOrEqual(
      0.4,
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
    const softPeak =
      driveDecision.event.peakSpeed *
      (IMPORT_ADMISSION_LIMITS.comparablePeakRatio + 0.05);
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
    // ~0.3× the swing's peak wrist speed: measurable motion, not a stroke.
    const idleFidget = wristSpeedProfile(2000, 60, hump(1000, 400, 0.7));
    const clip = concatSequences(swing.sequence, idleFidget, 600);
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
    // The drive peaks more than 2.5× the swing: below comparablePeakRatio.
    expect(
      swingDecision.event.peakSpeed / driveDecision.event.peakSpeed,
    ).toBeLessThan(IMPORT_ADMISSION_LIMITS.comparablePeakRatio);

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
    ).toBeLessThan(IMPORT_ADMISSION_LIMITS.comparablePeakRatio);

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
    // cannot be a second one here.
    const windUp = wristSpeedProfile(3000, 60, hump(1200, 150, 0.6));
    const alone = admitImportedStrokeEvents(windUp);
    expect(alone.admitted).toBe(false);
    if (alone.admitted) return;
    expect(alone.reason).toBe('motion_not_stroke_like');

    const stroke = wristSpeedProfile(
      3000,
      60,
      sumOf(hump(1200, 150, 0.6), hump(1700, 150, 5)),
    );
    const decision = admitImportedStrokeEvents(stroke);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.comparableEventCount).toBe(1);
    expect(Math.abs(decision.event.peakMs - 1700)).toBeLessThanOrEqual(60);
    expect(decision.candidates.filter(c => !c.comparable)).toHaveLength(1);
  });

  it('never demotes a stroke-sized wind-up: a burst admitted alone stays a stroke however hard the next one is', () => {
    // The same wind-up at 1.2 image heights/s clears the absolute stroke
    // floor on its own. A stroke-sized burst 500 ms before a 4× harder one
    // is indistinguishable from a soft stroke followed by a hard stroke, so
    // the clip is ambiguous and refused — at 500 ms and a second apart alike.
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
    expect(decision.reason).toBe('no_stroke_event');
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

    const brief = hideWrists(wristSpeedProfile(1000, 60, () => 0));
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
        timestampMs: frame.timestampMs + 1000,
      })),
    };
    const clip = importedClip(shifted, {
      durationMs:
        (shifted.frames[shifted.frames.length - 1]?.timestampMs ?? 0) + 1000,
    });
    const decision = admitImportedClip(clip, shifted);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(
      Math.abs(decision.event.peakMs - (window.peakMs + 1000)),
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
