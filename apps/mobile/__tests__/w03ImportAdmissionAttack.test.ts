import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * W03-01 adversary — module-boundary attacks against candidate e7d0a078.
 *
 * Each `describe` is one attack class. A test that FAILS here is a confirmed
 * break of the candidate's stated contract ("ambiguous clips are rejected
 * with a precise reason"; "extra motion never reduces the comparable
 * count"); a test that passes documents an attack that did not break it.
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
    capturedAtIso: '2026-09-08T09:00:00.000Z',
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

/** Body at rest; the right wrist's frame-to-frame speed follows `speedAt`. */
function wristSpeedProfile(
  durationMs: number,
  fps: number,
  speedAt: (tMs: number) => number,
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const step = (speedAt(tMs) * dtMs) / 1000;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark =>
        mark.name === 'right_wrist'
          ? { ...mark, x: 0.55 + (index % 2 === 0 ? 0 : step) }
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

function comparableCount(sequence: PoseSequence): number {
  return admitImportedStrokeEvents(sequence).comparableEventCount;
}

function rejectionReason(
  decision: ReturnType<typeof admitImportedMedia>,
): string | null {
  return decision.admitted ? null : decision.reason;
}

describe('ATTACK 1 — boundary values on the media envelope', () => {
  const { sequence } = generateSwingSequence();
  const clip = importedClip(sequence);

  it.each([
    [Number.NaN, 'duration_unknown'],
    [Number.POSITIVE_INFINITY, 'duration_unknown'],
    [Number.NEGATIVE_INFINITY, 'duration_unknown'],
    [-1, 'duration_too_short'],
    [0, 'duration_too_short'],
    [IMPORT_ADMISSION_LIMITS.minDurationMs - 0.001, 'duration_too_short'],
    [IMPORT_ADMISSION_LIMITS.maxDurationMs + 0.001, 'duration_too_long'],
    [Number.MAX_SAFE_INTEGER, 'duration_too_long'],
  ])('rejects durationMs %p as %s', (durationMs, reason) => {
    expect(rejectionReason(admitImportedMedia({ ...clip, durationMs }))).toBe(
      reason,
    );
  });

  it('admits the inclusive duration limits exactly', () => {
    for (const durationMs of [
      IMPORT_ADMISSION_LIMITS.minDurationMs,
      IMPORT_ADMISSION_LIMITS.maxDurationMs,
    ]) {
      expect(admitImportedMedia({ ...clip, durationMs }).admitted).toBe(true);
    }
  });

  it.each([
    [Number.NaN, 'frame_rate_unknown'],
    [0, 'frame_rate_unknown'],
    [-30, 'frame_rate_unknown'],
    [Number.POSITIVE_INFINITY, 'frame_rate_unknown'],
    [IMPORT_ADMISSION_LIMITS.minFps - 0.001, 'frame_rate_too_low'],
    [IMPORT_ADMISSION_LIMITS.maxFps + 0.001, 'frame_rate_too_high'],
  ])('rejects fps %p as %s', (fps, reason) => {
    expect(rejectionReason(admitImportedMedia({ ...clip, fps }))).toBe(reason);
  });

  it('admits the inclusive frame-rate limits exactly', () => {
    for (const fps of [
      IMPORT_ADMISSION_LIMITS.minFps,
      IMPORT_ADMISSION_LIMITS.maxFps,
    ]) {
      expect(admitImportedMedia({ ...clip, fps }).admitted).toBe(true);
    }
  });

  it.each([
    [0, 1080],
    [1080, 0],
    [-1080, 1080],
    [1080.5, 1080],
    [Number.NaN, 1080],
    [1080, Number.POSITIVE_INFINITY],
    [IMPORT_ADMISSION_LIMITS.maxFrameDimension + 1, 100],
    [100, IMPORT_ADMISSION_LIMITS.maxFrameDimension + 1],
    [4096, 2161],
    [2161, 4096],
  ])('rejects %p x %p as unsupported_dimensions', (width, height) => {
    expect(
      rejectionReason(admitImportedMedia({ ...clip, width, height })),
    ).toBe('unsupported_dimensions');
  });

  it('admits the largest supported frame in both orientations', () => {
    expect(
      admitImportedMedia({ ...clip, width: 4096, height: 2160 }).admitted,
    ).toBe(true);
    expect(
      admitImportedMedia({ ...clip, width: 2160, height: 4096 }).admitted,
    ).toBe(true);
    expect(admitImportedMedia({ ...clip, width: 1, height: 1 }).admitted).toBe(
      true,
    );
  });

  it.each([
    [-90, 270],
    [-270, 90],
    [450, 90],
    [-0, 0],
    [720, 0],
  ])('normalizes rotation %p° to %p°', (rotationDegrees, normalized) => {
    const decision = admitImportedMedia(clip, { rotationDegrees });
    expect(decision.admitted).toBe(true);
    if (decision.admitted) {
      expect(decision.media.rotationDegrees).toBe(normalized);
    }
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    89.999,
    90.0001,
    45,
    1e300,
    Number.MAX_SAFE_INTEGER,
  ])('rejects rotation %p° as unsupported_rotation', rotationDegrees => {
    expect(rejectionReason(admitImportedMedia(clip, { rotationDegrees }))).toBe(
      'unsupported_rotation',
    );
  });

  it.each(['HVC1', 'Avc1', 'HEVC', 'hev1', 'h264'])(
    'admits codec tag %p case-insensitively',
    codec => {
      const decision = admitImportedMedia(clip, { codec });
      expect(decision.admitted).toBe(true);
      if (decision.admitted)
        expect(decision.media.codec).toBe(codec.toLowerCase());
    },
  );

  it.each([
    'avc1 ',
    ' avc1',
    'avc1\u0000',
    'avc1\n',
    '\uff41vc1',
    '',
    'h.264',
    'hvc1;base64',
    'ap4h',
    'jpeg',
    'mp4v',
  ])('rejects codec tag %p as unsupported_codec', codec => {
    expect(rejectionReason(admitImportedMedia(clip, { codec }))).toBe(
      'unsupported_codec',
    );
  });

  it('documents that the avc3 H.264 sample-entry tag is refused (implementer summary lists it as supported)', () => {
    // Recorded as a P3 contract/summary mismatch, not as a policy assertion.
    expect(rejectionReason(admitImportedMedia(clip, { codec: 'avc3' }))).toBe(
      'unsupported_codec',
    );
  });

  it.each([Number.NaN, -1, 0, 1.5, 2, Number.POSITIVE_INFINITY])(
    'rejects videoTrackCount %p as unsupported_track_layout',
    videoTrackCount => {
      expect(
        rejectionReason(admitImportedMedia(clip, { videoTrackCount })),
      ).toBe('unsupported_track_layout');
    },
  );

  it('checks the whole probe, not the first failing field only when others are fine', () => {
    expect(
      rejectionReason(
        admitImportedMedia(clip, {
          rotationDegrees: 90,
          codec: 'hvc1',
          videoTrackCount: 1,
        }),
      ),
    ).toBeNull();
    expect(
      rejectionReason(
        admitImportedMedia(clip, {
          rotationDegrees: 90,
          codec: 'hvc1',
          videoTrackCount: 2,
        }),
      ),
    ).toBe('unsupported_track_layout');
  });
});

describe('ATTACK 2 — the comparable-event threshold is relative to the strongest peak, so extra motion CAN reduce the count', () => {
  it('two comparable strokes are refused on their own (precondition)', () => {
    const rally = concatSequences(
      generateSwingSequence().sequence,
      generateSwingSequence().sequence,
      1000,
    );
    const decision = admitImportedStrokeEvents(rally);
    expect(decision.admitted).toBe(false);
    expect(decision.comparableEventCount).toBe(2);
  });

  it('adding a third motion 3x faster after two full strokes must not turn the clip into an admitted single stroke', () => {
    const drive = generateSwingSequence();
    const rally = concatSequences(drive.sequence, drive.sequence, 1000);
    const twoStrokes = admitImportedStrokeEvents(rally);
    expect(twoStrokes.comparableEventCount).toBe(2);
    const drivePeak = Math.max(
      ...twoStrokes.candidates.map(candidate => candidate.peakSpeed),
    );
    // A third, stroke-length (~500 ms core) motion about three times faster.
    const faster = wristSpeedProfile(2000, 60, hump(1000, 300, drivePeak * 3));
    expect(admitImportedStrokeEvents(faster).admitted).toBe(true);
    const clip = concatSequences(rally, faster, 1000);
    const decision = admitImportedStrokeEvents(clip);
    // Monotonicity contract from the module docs: adding a candidate never
    // reduces the comparable count.
    expect(decision.comparableEventCount).toBeGreaterThanOrEqual(
      twoStrokes.comparableEventCount,
    );
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.reason).toBe('multiple_stroke_events');
    }
  });

  it('a brief wrist-tracking jump (~200 ms burst) beside two full strokes must not be admitted as THE stroke', () => {
    const drive = generateSwingSequence();
    const rally = concatSequences(drive.sequence, drive.sequence, 1000);
    const twoStrokes = admitImportedStrokeEvents(rally);
    const drivePeak = Math.max(
      ...twoStrokes.candidates.map(candidate => candidate.peakSpeed),
    );
    const glitch = wristSpeedProfile(1200, 60, hump(600, 130, drivePeak * 4));
    const clip = concatSequences(rally, glitch, 800);
    const decision = admitImportedStrokeEvents(clip);
    expect(decision.admitted).toBe(false);
    expect(decision.comparableEventCount).toBeGreaterThanOrEqual(2);
  });

  it('two soft strokes followed by one hard stroke (dink, dink, drive), each admitted alone, is a rally — not a single stroke', () => {
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
    const dinkOnly = admitImportedStrokeEvents(dink.sequence);
    const driveOnly = admitImportedStrokeEvents(drive.sequence);
    // Each is a real stroke the gate admits on its own.
    expect(dinkOnly.admitted).toBe(true);
    expect(driveOnly.admitted).toBe(true);
    const rally = concatSequences(
      concatSequences(dink.sequence, dink.sequence, 900),
      drive.sequence,
      900,
    );
    const decision = admitImportedStrokeEvents(rally);
    expect(decision.candidates.length).toBeGreaterThanOrEqual(3);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.reason).toBe('multiple_stroke_events');
      expect(decision.comparableEventCount).toBe(3);
    }
  });

  it('comparable count is monotonic under appending ANY admitted stroke to a two-stroke rally', () => {
    const base = concatSequences(
      generateSwingSequence().sequence,
      generateSwingSequence().sequence,
      1000,
    );
    const baseCount = comparableCount(base);
    expect(baseCount).toBe(2);
    const variants = [
      generateSwingSequence(),
      generateSwingSequence({ accelerateMs: 120, followMs: 150 }),
      generateSwingSequence({ backswingLengthNorm: 1.4, accelerateMs: 150 }),
      generateSwingSequence({ torsoLength: 0.32 }),
      generateSwingSequence({
        backswingLengthNorm: 1.4,
        accelerateMs: 150,
        followMs: 200,
        torsoLength: 0.3,
      }),
    ];
    for (const variant of variants) {
      expect(admitImportedStrokeEvents(variant.sequence).admitted).toBe(true);
      const extended = concatSequences(base, variant.sequence, 1000);
      expect(comparableCount(extended)).toBeGreaterThanOrEqual(baseCount);
    }
  });
});

describe('ATTACK 3 — pose coverage counts frames, not wrist evidence', () => {
  function withInvisibleWrists(
    frames: PoseSequence['frames'],
  ): PoseSequence['frames'] {
    return frames.map(frame => ({
      ...frame,
      landmarks: frame.landmarks.map(mark =>
        mark.name === 'left_wrist' || mark.name === 'right_wrist'
          ? { ...mark, visibility: 0 }
          : mark,
      ),
    }));
  }

  it('a 20 s clip whose hitting arm is unmeasured for ~18 s around one visible swing is not a plausible single-stroke clip', () => {
    const swing = generateSwingSequence();
    const rest = swing.sequence.frames[0];
    if (!rest) throw new Error('no frames');
    const dtMs = 1000 / swing.sequence.video.fps;
    const pad = (count: number): PoseSequence['frames'] =>
      Array.from({ length: count }, (_, index) => ({
        ...rest,
        frameIndex: index,
        timestampMs: Math.round(index * dtMs),
      }));
    const lead = withInvisibleWrists(pad(9 * 60));
    const tail = withInvisibleWrists(pad(9 * 60));
    const sequence = concatSequences(
      concatSequences(
        { ...swing.sequence, frames: lead },
        swing.sequence,
        Math.round(dtMs),
      ),
      { ...swing.sequence, frames: tail },
      Math.round(dtMs),
    );
    const clip = importedClip(sequence);
    expect(clip.durationMs).toBeGreaterThan(19_000);
    const decision = admitImportedClip(clip, sequence);
    // Every body frame is tracked, so pose coverage passes; but no wrist was
    // measured for ~18 of 20 seconds — other strokes may have happened there.
    expect(decision.admitted).toBe(false);
  });
});

describe('ATTACK 4 — timeline and coverage boundaries', () => {
  const swing = generateSwingSequence();
  const last = swing.sequence.frames[swing.sequence.frames.length - 1];
  const lastMs = last?.timestampMs ?? 0;

  it('admits a trailing untracked span of exactly maxUntrackedSpanMs and refuses one millisecond more', () => {
    const exact = importedClip(swing.sequence, {
      durationMs: lastMs + IMPORT_ADMISSION_LIMITS.maxUntrackedSpanMs,
    });
    expect(admitImportedClip(exact, swing.sequence).admitted).toBe(true);
    const over = importedClip(swing.sequence, {
      durationMs: lastMs + IMPORT_ADMISSION_LIMITS.maxUntrackedSpanMs + 1,
    });
    const decision = admitImportedClip(over, swing.sequence);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted)
      expect(decision.reason).toBe('pose_coverage_incomplete');
  });

  it('a sidecar ending exactly timelineToleranceMs past the clip is admitted; one millisecond more is a geometry mismatch', () => {
    const atTolerance = importedClip(swing.sequence, {
      durationMs: lastMs - IMPORT_ADMISSION_LIMITS.timelineToleranceMs,
    });
    expect(admitImportedClip(atTolerance, swing.sequence).admitted).toBe(true);
    const past = importedClip(swing.sequence, {
      durationMs: lastMs - IMPORT_ADMISSION_LIMITS.timelineToleranceMs - 1,
    });
    const decision = admitImportedClip(past, swing.sequence);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted)
      expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('a negative first timestamp is a geometry mismatch even when every other check passes', () => {
    const shifted: PoseSequence = {
      ...swing.sequence,
      frames: swing.sequence.frames.map(frame => ({
        ...frame,
        timestampMs: frame.timestampMs - 1,
      })),
    };
    const clip = importedClip(shifted);
    const decision = admitImportedClip(clip, shifted);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted)
      expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('a frame-count drift of one is a geometry mismatch in both directions', () => {
    const clip = importedClip(swing.sequence);
    const sidecarRef = clip.poseSequence;
    if (!sidecarRef) throw new Error('imported clip has no sidecar');
    for (const delta of [-1, 1]) {
      const decision = admitImportedClip(
        {
          ...clip,
          poseSequence: {
            ...sidecarRef,
            frameCount: sidecarRef.frameCount + delta,
          },
        },
        swing.sequence,
      );
      expect(decision.admitted).toBe(false);
      if (!decision.admitted)
        expect(decision.reason).toBe('pose_geometry_mismatch');
    }
  });

  it('duplicate and rewinding timestamps never produce a non-finite speed or an admitted event', () => {
    const frames = swing.sequence.frames.map((frame, index) => ({
      ...frame,
      timestampMs:
        index % 2 === 0
          ? frame.timestampMs
          : (swing.sequence.frames[index - 1]?.timestampMs ?? 0),
    }));
    const duplicated: PoseSequence = { ...swing.sequence, frames };
    const decision = admitImportedStrokeEvents(duplicated);
    for (const candidate of decision.candidates) {
      expect(Number.isFinite(candidate.peakSpeed)).toBe(true);
      expect(candidate.peakSpeed).toBeGreaterThanOrEqual(0);
    }
    const rewound: PoseSequence = {
      ...swing.sequence,
      frames: swing.sequence.frames.map((frame, index) => ({
        ...frame,
        timestampMs:
          index % 7 === 3 ? frame.timestampMs - 40 : frame.timestampMs,
      })),
    };
    const rewoundDecision = admitImportedStrokeEvents(rewound);
    for (const candidate of rewoundDecision.candidates) {
      expect(Number.isFinite(candidate.peakSpeed)).toBe(true);
    }
  });

  it('non-finite landmark coordinates are treated as untracked, not as infinite speed', () => {
    const poisoned: PoseSequence = {
      ...swing.sequence,
      frames: swing.sequence.frames.map((frame, index) => ({
        ...frame,
        landmarks: frame.landmarks.map(mark =>
          mark.name === 'right_wrist' && index % 5 === 0
            ? {
                ...mark,
                x: index % 10 === 0 ? Number.NaN : Number.POSITIVE_INFINITY,
              }
            : mark,
        ),
      })),
    };
    const decision = admitImportedStrokeEvents(poisoned);
    for (const candidate of decision.candidates) {
      expect(Number.isFinite(candidate.peakSpeed)).toBe(true);
    }
    expect(JSON.stringify(decision)).not.toMatch(/null|Infinity|NaN/);
  });

  it('exactly minPoseFrames frames is evaluated; one fewer is too_few_pose_frames', () => {
    const idle = wristSpeedProfile(3000, 60, () => 0);
    const exact: PoseSequence = {
      ...idle,
      frames: idle.frames.slice(0, IMPORT_ADMISSION_LIMITS.minPoseFrames),
    };
    const exactDecision = admitImportedStrokeEvents(exact);
    expect(exactDecision.admitted).toBe(false);
    if (!exactDecision.admitted)
      expect(exactDecision.reason).not.toBe('too_few_pose_frames');
    const fewer: PoseSequence = {
      ...idle,
      frames: idle.frames.slice(0, IMPORT_ADMISSION_LIMITS.minPoseFrames - 1),
    };
    const fewerDecision = admitImportedStrokeEvents(fewer);
    expect(fewerDecision.admitted).toBe(false);
    if (!fewerDecision.admitted)
      expect(fewerDecision.reason).toBe('too_few_pose_frames');
  });

  it('an empty sequence and a sequence with an empty landmark list abstain without throwing', () => {
    const empty: PoseSequence = { ...swing.sequence, frames: [] };
    expect(admitImportedStrokeEvents(empty).admitted).toBe(false);
    const clip = importedClip(empty, { durationMs: 1000 });
    const decision = admitImportedClip(clip, empty);
    expect(decision.admitted).toBe(false);
    const noLandmarks: PoseSequence = {
      ...swing.sequence,
      frames: swing.sequence.frames.map(frame => ({ ...frame, landmarks: [] })),
    };
    const bare = admitImportedStrokeEvents(noLandmarks);
    expect(bare.admitted).toBe(false);
    if (!bare.admitted) expect(bare.reason).toBe('wrist_not_tracked');
  });
});

describe('ATTACK 5 — player-facing copy follows the dossier for every reason', () => {
  const forbidden =
    /android|google play|guest|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|accura|best|most|#1|ai coach|guarantee/i;

  it.each([...IMPORT_ADMISSION_REASONS])(
    'reason %s has compliant copy',
    reason => {
      const message = importAdmissionRejectionMessage(reason);
      expect(message.length).toBeGreaterThan(20);
      expect(message.trim()).toBe(message);
      expect(message).toMatch(/[.!]$/);
      expect(message).not.toMatch(forbidden);
      expect(message).not.toMatch(/undefined|null|NaN|\$\{/);
    },
  );

  it('every reason has a distinct message', () => {
    const messages = IMPORT_ADMISSION_REASONS.map(
      importAdmissionRejectionMessage,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('ATTACK 6 — rotation/codec/track-layout admission is unreachable from the shipping analysis path', () => {
  it('runCaptureAnalysis feeds a media probe (rotation/codec/tracks) to the admission gate', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'analysis', 'runCaptureAnalysis.ts'),
      'utf8',
    );
    const mediaCalls = source.match(/admitImportedMedia\([^)]*\)/g) ?? [];
    const clipCalls = source.match(/admitImportedClip\([^)]*\)/g) ?? [];
    expect(mediaCalls.length + clipCalls.length).toBeGreaterThan(0);
    // A call with a single `clip` argument (or `clip, sequence`) never
    // exercises rotation / codec / track-layout: the probe stays `{}`.
    for (const call of mediaCalls) {
      expect(call.split(',').length).toBeGreaterThanOrEqual(2);
    }
    for (const call of clipCalls) {
      expect(call.split(',').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('CapturedClip carries no codec or rotation field the gate could read without a probe', () => {
    const { sequence } = generateSwingSequence();
    const clip = importedClip(sequence);
    expect('codec' in clip).toBe(false);
    expect('rotationDegrees' in clip).toBe(false);
    expect(admitImportedMedia(clip).admitted).toBe(true);
  });
});
