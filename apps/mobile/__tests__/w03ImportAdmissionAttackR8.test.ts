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
 * W03-01 adversary, round 8 (candidate 806d511b) — admission module.
 *
 * Every test here is an ATTACK on a failure boundary of the single-stroke
 * plausibility gate. A failing test is a reproducer of a break: the fixture
 * is a clip the objective says must be refused ("ambiguous clips are rejected
 * with a precise reason") but the candidate admits. The fixtures reuse the
 * candidate's own synthetic vocabulary (still skeleton, wrist speed profile
 * in image heights per second) so the expectation is judged on exactly the
 * numbers the module measures.
 */

type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

function importedClip(
  sequence: PoseSequence,
  overrides: Partial<ImportedClip> = {},
): ImportedClip {
  const sidecarJson = serializePoseSequence(sequence);
  const last = sequence.frames[sequence.frames.length - 1];
  return {
    uri: 'file:///imports/w03-attack.mov',
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
      uri: 'file:///imports/w03-attack.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
    ...overrides,
  };
}

/**
 * A still skeleton whose RIGHT wrist's frame-to-frame speed (image heights
 * per second, square video) follows `rightAt` and whose LEFT wrist follows
 * `leftAt`. `scaleAt` scales the whole body about the image centre at each
 * instant — the player walking towards or away from the camera — so the
 * torso length the module measures changes over the clip.
 */
function skeletonProfile(
  durationMs: number,
  fps: number,
  rightAt: (tMs: number) => number,
  options: {
    leftAt?: (tMs: number) => number;
    scaleAt?: (tMs: number) => number;
  } = {},
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const leftAt = options.leftAt ?? (() => 0);
  const scaleAt = options.scaleAt ?? (() => 1);
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const rightStep = (rightAt(tMs) * dtMs) / 1000;
    const leftStep = (leftAt(tMs) * dtMs) / 1000;
    const scale = scaleAt(tMs);
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark => {
        const scaled = {
          ...mark,
          x: 0.5 + (mark.x - 0.5) * scale,
          y: 0.5 + (mark.y - 0.5) * scale,
        };
        if (mark.name === 'right_wrist')
          return { ...scaled, x: 0.55 + (index % 2 === 0 ? 0 : rightStep) };
        if (mark.name === 'left_wrist')
          return { ...scaled, x: 0.3 + (index % 2 === 0 ? 0 : leftStep) };
        return scaled;
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

/** Torso length (image heights) of the generated still skeleton at scale 1. */
function restingTorsoLength(): number {
  const { sequence } = generateSwingSequence();
  const frame = sequence.frames[0];
  if (!frame) throw new Error('synthetic swing produced no frames');
  const point = (name: string) => {
    const mark = frame.landmarks.find(entry => entry.name === name);
    if (!mark) throw new Error(`missing ${name}`);
    return mark;
  };
  const aspect = sequence.video.width / sequence.video.height;
  const ls = point('left_shoulder');
  const rs = point('right_shoulder');
  const lh = point('left_hip');
  const rh = point('right_hip');
  return Math.hypot(
    ((ls.x + rs.x - lh.x - rh.x) / 2) * aspect,
    (ls.y + rs.y - lh.y - rh.y) / 2,
  );
}

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

/** Keeps only the frames whose timestamp satisfies `keep`, re-indexed. */
function keepFrames(
  sequence: PoseSequence,
  keep: (timestampMs: number) => boolean,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames
      .filter(frame => keep(frame.timestampMs))
      .map((frame, index) => ({ ...frame, frameIndex: index })),
  };
}

/** Piecewise-linear speed through (tMs, speed) points; 0 outside them. */
function polyline(points: ReadonlyArray<readonly [number, number]>) {
  return (tMs: number): number => {
    for (let index = 1; index < points.length; index += 1) {
      const [ta, va] = points[index - 1] ?? [0, 0];
      const [tb, vb] = points[index] ?? [0, 0];
      if (tMs >= ta && tMs <= tb)
        return tb === ta ? va : va + ((vb - va) * (tMs - ta)) / (tb - ta);
    }
    return 0;
  };
}

describe('ATTACK 1 — body scale drifts: a far stroke is demoted by a later, nearer one', () => {
  // The player is at the far end of the court for the first 1.5 s (body
  // scaled to 0.4, torso = 0.08 image heights — the pipeline's "player too
  // small" floor, inclusive) and hits a stroke at 5 of THAT torso per
  // second. They then step towards the camera (scale 1, torso 0.2) and hit
  // a second stroke at the same torso-relative speed. Two complete strokes,
  // seconds apart. The module normalizes every wrist speed by ONE median
  // torso length for the whole clip, so the far stroke is measured against
  // the near body and lands under the 2 torso/s "comparable" bar. (The
  // still-skeleton profile moves the wrist on alternate frames, so a
  // requested 5 torso/s measures ≈ 4.25 torso/s.)
  const torso = restingTorsoLength();
  const farScale = 0.4;
  const requested = 5;
  const farStroke = hump(800, 150, requested * torso * farScale);
  const nearStroke = hump(3500, 150, requested * torso);
  const approachingRally = () =>
    skeletonProfile(5000, 60, tMs => farStroke(tMs) + nearStroke(tMs), {
      scaleAt: tMs => (tMs < 1500 ? farScale : 1),
    });

  it('control: the far stroke alone, at the far scale, is an admitted single stroke', () => {
    const alone = skeletonProfile(
      3000,
      60,
      hump(1500, 150, requested * torso * farScale),
      { scaleAt: () => farScale },
    );
    const decision = admitImportedStrokeEvents(alone);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.event.peakTorsoPerSecond).toBeGreaterThanOrEqual(
      IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
    );
  });

  it('control: the near stroke alone is an admitted single stroke', () => {
    const alone = skeletonProfile(3000, 60, hump(1500, 150, requested * torso));
    expect(admitImportedStrokeEvents(alone).admitted).toBe(true);
  });

  it('both strokes in one clip are two comparable events (never reduced to the nearer one)', () => {
    const decision = admitImportedStrokeEvents(approachingRally());
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBeGreaterThanOrEqual(2);
  });

  it('the combined gate refuses the approaching rally', () => {
    const sequence = approachingRally();
    const decision = admitImportedClip(importedClip(sequence), sequence);
    expect(decision.admitted).toBe(false);
  });
});

describe('ATTACK 2 — a two-handed stroke: the slower hitting wrist has a hole the gate ignores', () => {
  // Both wrists swing through ONE stroke at 4 s (a two-handed backhand):
  // the left wrist peaks ~10 % faster than the right, so the module takes the
  // left as the "hitting" wrist. The RIGHT wrist — which also reaches stroke
  // speed inside the admitted event — was untracked for the first 2 s while
  // the body was measured. Two right-hand strokes could hide in that hole.
  const torso = restingTorsoLength();
  const holeEndMs = 2000;
  const twoHandedWithHole = () =>
    occludeRightWrist(
      skeletonProfile(5000, 60, hump(4000, 150, 5 * torso), {
        leftAt: hump(4050, 150, 5.5 * torso),
      }),
      0,
      holeEndMs,
    );

  it('control: the same hole on the SINGLE hitting wrist is refused as wrist_not_tracked', () => {
    const single = occludeRightWrist(
      skeletonProfile(5000, 60, hump(4000, 150, 5 * torso)),
      0,
      holeEndMs,
    );
    const decision = admitImportedStrokeEvents(single);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('wrist_not_tracked');
  });

  it('a wrist that reaches stroke speed inside the admitted event must be tracked throughout', () => {
    const decision = admitImportedStrokeEvents(twoHandedWithHole());
    // Both wrists are comparable members of the one admitted cluster …
    if (decision.admitted) {
      const comparable = decision.candidates.filter(c => c.comparable);
      expect(comparable.map(c => c.wrist).sort()).toEqual([
        'left_wrist',
        'right_wrist',
      ]);
    }
    // … so a 2 s hole in either of them leaves a stroke unaccounted for.
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('wrist_not_tracked');
  });

  it('the combined gate refuses the two-handed stroke with the right-wrist hole', () => {
    const sequence = twoHandedWithHole();
    const decision = admitImportedClip(importedClip(sequence), sequence);
    expect(decision.admitted).toBe(false);
  });
});

describe('ATTACK 3 — five stroke-speed peaks 300 ms apart chained as one "jittery" movement', () => {
  // Peaks 10 → 8.5 → 7.8 → 7.2 → 6.6 torso/s, valleys 7.6 / 6.9 / 6.3 / 5.7:
  // every peak is above the 4 torso/s a stroke reaches, every valley keeps
  // > 80 % of the lesser peak and every rise out of its valley is ≤ 10 % of
  // the highest peak — the exact shape the round-8 jitter rule folds. Five
  // volleys 300 ms apart spanning 1.45 s are not one stroke.
  const torso = restingTorsoLength();
  const t0 = 1500;
  const step = 300;
  const chain = polyline([
    [t0 - 150, 0],
    [t0, 10 * torso],
    [t0 + step / 2, 7.6 * torso],
    [t0 + step, 8.5 * torso],
    [t0 + step * 1.5, 6.9 * torso],
    [t0 + step * 2, 7.8 * torso],
    [t0 + step * 2.5, 6.3 * torso],
    [t0 + step * 3, 7.2 * torso],
    [t0 + step * 3.5, 5.7 * torso],
    [t0 + step * 4, 6.6 * torso],
    [t0 + step * 4 + 150, 0],
  ]);

  it('is refused (several stroke events, or a motion core that is not one stroke)', () => {
    const decision = admitImportedStrokeEvents(
      skeletonProfile(4500, 60, chain),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(['multiple_stroke_events', 'motion_not_stroke_like']).toContain(
      decision.reason,
    );
  });
});

describe('ATTACK 4 — pose sampled at exactly the unobserved-span bound, and one ms past it', () => {
  // The extractor emits no frame while it finds no person. Here the pose is
  // found only every `interval` ms for 1.2 s, then a fully sampled stroke
  // follows. At exactly `maxUnobservedSpanMs` (150) the module's published
  // rule admits; at 151 ms every interior stretch is an unobserved gap and
  // the clip must be refused as pose_coverage_incomplete — not admitted, and
  // not refused for some other reason.
  const torso = restingTorsoLength();

  function sparseThenVisible(interval: number): PoseSequence {
    const { sequence } = generateSwingSequence();
    const body = sequence.frames[0];
    if (!body) throw new Error('synthetic swing produced no frames');
    const frames: PoseSequence['frames'] = [];
    const push = (tMs: number, rightX: number) => {
      frames.push({
        frameIndex: frames.length,
        timestampMs: tMs,
        confidence: body.confidence,
        landmarks: body.landmarks.map(mark =>
          mark.name === 'right_wrist' ? { ...mark, x: rightX } : mark,
        ),
      });
    };
    // 0–1000 ms: still, fully sampled at 60 fps (whole ms stamps).
    for (let tMs = 0; tMs < 1000; tMs += 17) push(tMs, 0.55);
    // 1000–2200 ms: sampled every `interval` ms only.
    for (let tMs = 1000; tMs <= 2200; tMs += interval) push(tMs, 0.55);
    // 2200–4000 ms: fully sampled, one visible stroke at 3000 ms.
    const visible = hump(3000, 150, 5.5 * torso);
    let parity = 0;
    for (let tMs = 2217; tMs <= 4000; tMs += 17) {
      const stepImageHeights = (visible(tMs) * 17) / 1000;
      push(tMs, 0.55 + (parity % 2 === 0 ? 0 : stepImageHeights));
      parity += 1;
    }
    return { ...sequence, frames };
  }

  it('control: 150 ms sampling (the bound, inclusive) admits the later stroke', () => {
    const sequence = sparseThenVisible(150);
    const decision = admitImportedClip(importedClip(sequence), sequence);
    expect(decision.admitted).toBe(true);
  });

  it('151 ms sampling is refused as pose_coverage_incomplete', () => {
    const sequence = sparseThenVisible(151);
    const decision = admitImportedClip(importedClip(sequence), sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_coverage_incomplete');
  });
});

describe('ATTACK 5 — container envelope boundary values', () => {
  const { sequence } = generateSwingSequence();

  it('treats the published limits inclusively and one unit past them as refusals', () => {
    const limits = IMPORT_ADMISSION_LIMITS;
    const at = (overrides: Partial<ImportedClip>) =>
      admitImportedMedia(importedClip(sequence, overrides));
    expect(at({ durationMs: limits.minDurationMs }).admitted).toBe(true);
    expect(at({ durationMs: limits.minDurationMs - 1 }).admitted).toBe(false);
    expect(at({ durationMs: limits.maxDurationMs }).admitted).toBe(true);
    expect(at({ durationMs: limits.maxDurationMs + 1 }).admitted).toBe(false);
    expect(at({ durationMs: -1 }).admitted).toBe(false);
    expect(at({ fps: limits.maxFps }).admitted).toBe(true);
    expect(at({ fps: limits.maxFps + 1e-9 }).admitted).toBe(false);
    expect(at({ fps: 0 }).admitted).toBe(false);
    expect(at({ fps: -30 }).admitted).toBe(false);
    expect(at({ fps: Number.NaN }).admitted).toBe(false);
    expect(at({ width: 4096, height: 2160 }).admitted).toBe(true);
    expect(at({ width: 2160, height: 4096 }).admitted).toBe(true);
    expect(at({ width: 4096, height: 2161 }).admitted).toBe(false);
    expect(at({ width: 4097, height: 100 }).admitted).toBe(false);
    expect(at({ width: 0, height: 1080 }).admitted).toBe(false);
    expect(at({ width: 1080.5, height: 1080 }).admitted).toBe(false);
    expect(at({ width: -1080, height: 1080 }).admitted).toBe(false);
  });

  it('normalizes only exact quarter turns and only known codec tags', () => {
    const clip = importedClip(sequence);
    for (const rotationDegrees of [-0, 0, 90, -90, 180, 270, 450, -270, 3600])
      expect(admitImportedMedia(clip, { rotationDegrees }).admitted).toBe(true);
    for (const rotationDegrees of [45, 89.999, 90.001, 1e300, Number.NaN])
      expect(admitImportedMedia(clip, { rotationDegrees }).admitted).toBe(
        false,
      );
    for (const codec of ['avc1', 'AVC1', 'hvc1', 'HEVC', 'h264'])
      expect(admitImportedMedia(clip, { codec }).admitted).toBe(true);
    for (const codec of ['avc1.640028', 'vp09', 'av01', 'ap4h', 'jpeg', ''])
      expect(admitImportedMedia(clip, { codec }).admitted).toBe(false);
    for (const videoTrackCount of [0, 2, -1, 1.0000001])
      expect(admitImportedMedia(clip, { videoTrackCount }).admitted).toBe(
        false,
      );
    expect(admitImportedMedia(clip, { videoTrackCount: 1 }).admitted).toBe(
      true,
    );
  });

  it('accepts a sidecar ending inside the timeline tolerance and refuses one past it', () => {
    const last = sequence.frames[sequence.frames.length - 1];
    const lastMs = last?.timestampMs ?? 0;
    const tolerance = IMPORT_ADMISSION_LIMITS.timelineToleranceMs;
    const inside = admitImportedClip(
      importedClip(sequence, { durationMs: lastMs - tolerance }),
      sequence,
    );
    expect(inside.admitted ? null : inside.reason).not.toBe(
      'pose_geometry_mismatch',
    );
    const past = admitImportedClip(
      importedClip(sequence, { durationMs: lastMs - tolerance - 1 }),
      sequence,
    );
    expect(past.admitted).toBe(false);
    if (!past.admitted) expect(past.reason).toBe('pose_geometry_mismatch');
  });

  it('a sidecar whose frame count disagrees with the recorded ref is a geometry mismatch', () => {
    const clip = importedClip(sequence);
    const dropped = keepFrames(sequence, timestampMs => timestampMs !== 0);
    const decision = admitImportedClip(clip, dropped);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted)
      expect(decision.reason).toBe('pose_geometry_mismatch');
  });
});

describe('ATTACK 6 — corrupt landmark values inside an otherwise valid sequence', () => {
  it('NaN / infinite wrist coordinates on the frames of a stroke never admit and never throw', () => {
    const torso = restingTorsoLength();
    const base = skeletonProfile(3000, 60, hump(1500, 150, 4.5 * torso));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const corrupt: PoseSequence = {
        ...base,
        frames: base.frames.map(frame =>
          frame.timestampMs >= 1400 && frame.timestampMs <= 1600
            ? {
                ...frame,
                landmarks: frame.landmarks.map(mark =>
                  mark.name === 'right_wrist' ? { ...mark, x: bad } : mark,
                ),
              }
            : frame,
        ),
      };
      const decision = admitImportedStrokeEvents(corrupt);
      expect(decision.admitted).toBe(false);
    }
  });

  it('NaN torso landmarks on most frames leave the body scale unmeasured, not a fabricated scale', () => {
    const torso = restingTorsoLength();
    const base = skeletonProfile(3000, 60, hump(1500, 150, 4.5 * torso));
    const corrupt: PoseSequence = {
      ...base,
      frames: base.frames.map((frame, index) =>
        index % 90 === 0
          ? frame
          : {
              ...frame,
              landmarks: frame.landmarks.map(mark =>
                mark.name === 'left_hip' || mark.name === 'right_hip'
                  ? { ...mark, y: Number.NaN }
                  : mark,
              ),
            },
      ),
    };
    const decision = admitImportedStrokeEvents(corrupt);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted)
      expect(decision.reason).toBe('body_scale_unmeasured');
  });
});
