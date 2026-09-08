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
      expect(admitImportedMedia(clip, { rotationDegrees }).admitted).toBe(
        true,
      );
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
    ['frame_rate_too_low', { fps: 12 }, false],
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
    expect(IMPORT_ADMISSION_LIMITS.minFps).toBe(15);
    expect(IMPORT_ADMISSION_LIMITS.minDurationMs).toBeGreaterThan(0);
    expect(Object.isFrozen(IMPORT_ADMISSION_LIMITS)).toBe(true);
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
    expect(Math.abs((comparable[0]?.peakMs ?? 0) - first.window.peakMs)).toBeLessThanOrEqual(100);
    expect(Math.abs((comparable[1]?.peakMs ?? 0) - secondPeak)).toBeLessThanOrEqual(100);
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

  it('admits one stroke beside clearly weaker incidental motion, exposing both', () => {
    const swing = singleSwing();
    const idleFidget = wristSpeedProfile(2000, 60, hump(1000, 400, 0.04));
    const clip = concatSequences(swing.sequence, idleFidget, 600);
    const decision = admitImportedStrokeEvents(clip);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(Math.abs(decision.event.peakMs - swing.window.peakMs)).toBeLessThanOrEqual(
      100,
    );
    expect(decision.comparableEventCount).toBe(1);
    expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
    expect(decision.candidates.filter(c => !c.comparable).length).toBeGreaterThanOrEqual(1);
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
    const sparse: PoseSequence = { ...sequence, frames: sequence.frames.slice(0, 11) };
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

  it('refuses a sidecar whose timeline runs past the clip', () => {
    const { sequence } = singleSwing();
    const last = sequence.frames[sequence.frames.length - 1]?.timestampMs ?? 0;
    const clip = importedClip(sequence, { durationMs: last - 500 });
    const decision = admitImportedClip(clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_geometry_mismatch');
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
