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
  admitImportedClip,
  admitImportedMedia,
  admitImportedStrokeEvents,
  type ImportedMediaProbe,
} from '../src/camera/importAdmission';

/**
 * W03-01 adversarial suite against candidate 42bf4c60 (impl-r6).
 *
 * Every test here encodes what the objective demands — an ambiguous or
 * truncated clip is REFUSED with a precise reason — and probes a boundary of
 * the candidate's admission rules. A failing test is a confirmed break of
 * the candidate; a passing test is an attack the candidate survived.
 *
 * Attacks are numbered A1… and grouped by the attack-surface category they
 * exercise (boundary values, corrupt/partial pose state, monotonicity,
 * truncation at the clip edge, unreachable shipping surfaces).
 */

type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

const LIMITS = IMPORT_ADMISSION_LIMITS;

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

/** Right wrist alternates between two points so its speed follows `speedAt`. */
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

/** Right wrist TRAVELS along the requested velocity (direction matters). */
function wristTravelProfile(
  durationMs: number,
  fps: number,
  velocityAt: (tMs: number) => readonly [number, number],
): PoseSequence {
  const { sequence } = generateSwingSequence();
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
                ? { ...mark, visibility: LIMITS.minLandmarkVisibility - 0.01 }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

function peakTorsoPerSecond(sequence: PoseSequence): number {
  const decision = admitImportedStrokeEvents(sequence);
  expect(decision.admitted).toBe(true);
  if (!decision.admitted) return 0;
  return decision.event.peakTorsoPerSecond;
}

/** Compact view of a decision so a failure prints what was admitted. */
function summarize(
  decision: ReturnType<typeof admitImportedStrokeEvents>,
): Record<string, unknown> {
  if (!decision.admitted) {
    return {
      admitted: false,
      reason: decision.reason,
      comparableEventCount: decision.comparableEventCount,
    };
  }
  return {
    admitted: true,
    event: {
      wrist: decision.event.wrist,
      startMs: decision.event.startMs,
      endMs: decision.event.endMs,
      peakMs: decision.event.peakMs,
      peakTorsoPerSecond: Number(decision.event.peakTorsoPerSecond.toFixed(2)),
    },
    candidates: decision.candidates.map(candidate => ({
      wrist: candidate.wrist,
      peakMs: candidate.peakMs,
      peakTorsoPerSecond: Number(candidate.peakTorsoPerSecond.toFixed(2)),
      comparable: candidate.comparable,
    })),
  };
}

/** Shape of every refusal; `toEqual` against it prints the admitted event on failure. */
const REFUSED = {
  admitted: false,
  reason: expect.any(String),
  comparableEventCount: expect.any(Number),
};

function expectRefused(
  sequence: PoseSequence,
  reasons: ReadonlyArray<string>,
): void {
  const decision = admitImportedStrokeEvents(sequence);
  expect(summarize(decision)).toEqual(REFUSED);
  if (decision.admitted) return;
  expect(reasons).toContain(decision.reason);
}

// ─── A1 · boundary: jitter floor vs. a fast hand battle ────────────────────

describe('W03-01 attack A1 — a hand battle whose valleys sit just under the jitter floor', () => {
  /** N volleys every `periodMs` from 1000 ms, speed oscillating valley→peak. */
  function volleys(
    peak: number,
    valley: number,
    count: number,
    periodMs = 450,
  ) {
    const endMs = 1000 + count * periodMs;
    return (tMs: number) => {
      if (tMs < 1000 || tMs > endMs) return 0;
      const phase = ((tMs - 1000) % periodMs) / periodMs;
      return (
        valley + (peak - valley) * Math.max(0, 1 - Math.abs(phase - 0.5) * 2)
      );
    };
  }

  it('control: the candidate refuses four volleys whose valleys are 60 % of the peaks', () => {
    expectRefused(wristSpeedProfile(5000, 60, volleys(1.0, 0.6, 4)), [
      'multiple_stroke_events',
    ]);
  });

  it('control: one lone volley of this shape is a stroke on its own', () => {
    expect(
      peakTorsoPerSecond(wristSpeedProfile(5000, 60, volleys(1.0, 0.72, 1))),
    ).toBeGreaterThanOrEqual(LIMITS.minStrokePeakTorsoPerSecond);
  });

  it('refuses four volleys in 1.8 s whose valleys stay at 72 % of the peaks', () => {
    // Each volley is a stroke on its own (control above); four of them in
    // 1.8 s are four strokes however little the hand rests between them.
    expectRefused(wristSpeedProfile(5000, 60, volleys(1.0, 0.72, 4)), [
      'multiple_stroke_events',
    ]);
  });

  it.each([0.6, 0.64, 0.66, 0.68, 0.7, 0.72, 0.75])(
    'refuses four volleys in 1.8 s whose valleys stay at %s of the peaks (boundary sweep)',
    valley => {
      expectRefused(wristSpeedProfile(5000, 60, volleys(1.0, valley, 4)), [
        'multiple_stroke_events',
      ]);
    },
  );

  it('refuses a drive followed by three volleys that never drop below 72 % of their own peaks', () => {
    const rally = sumOf(hump(1000, 150, 2.0), volleys(1.0, 0.72, 3, 450));
    expectRefused(
      wristSpeedProfile(5000, 60, tMs => rally(tMs)),
      ['multiple_stroke_events'],
    );
  });
});

// ─── A2 · monotonicity: inserting motion must never admit a refused clip ───

describe('W03-01 attack A2 — inserting a harder opposite-direction burst between two refused strokes', () => {
  const SOFT = 1.2;
  const HARD = 3.0;

  /** Two backward soft strokes 700 ms apart, each admitted alone. */
  function twoBackwardStrokes() {
    return wristTravelProfile(
      3000,
      60,
      sumVelocities(
        along(-1, hump(1000, 150, SOFT)),
        along(-1, hump(1700, 150, SOFT)),
      ),
    );
  }

  it('control: each soft backward burst is a stroke on its own', () => {
    expect(
      peakTorsoPerSecond(
        wristTravelProfile(3000, 60, along(-1, hump(1000, 150, SOFT))),
      ),
    ).toBeGreaterThanOrEqual(LIMITS.minStrokePeakTorsoPerSecond);
  });

  it('control: two backward strokes 700 ms apart are refused as two events', () => {
    expectRefused(twoBackwardStrokes(), ['multiple_stroke_events']);
  });

  it('adding a forward burst between the two refused strokes keeps the refusal', () => {
    // Adding motion to a clip can only keep or raise the number of comparable
    // events (the candidate's own invariant). The forward burst is inserted
    // between the two backward strokes with a 50 ms pause on each side.
    const withForward = wristTravelProfile(
      3000,
      60,
      sumVelocities(
        along(-1, hump(1000, 150, SOFT)),
        along(1, hump(1350, 150, HARD)),
        along(-1, hump(1700, 150, SOFT)),
      ),
    );
    expectRefused(withForward, ['multiple_stroke_events']);
  });

  it('a soft backward stroke 600 ms before a hard forward one stays two events (the zero-travel twin is refused)', () => {
    // The candidate refuses this exact timing when the wrist has no net
    // travel ("two complete strokes 600 ms apart are two events even when
    // the second is 3× harder"). The same two humps, each travelling, must
    // not be admitted just because they travel in opposite directions.
    const travelling = wristTravelProfile(
      3000,
      60,
      sumVelocities(
        along(-1, hump(1200, 150, 1.0)),
        along(1, hump(1800, 150, 3.0)),
      ),
    );
    expectRefused(travelling, ['multiple_stroke_events']);
  });
});

// ─── A3 · truncation hidden inside a folded wind-up / recovery ─────────────

describe('W03-01 attack A3 — a stroke whose wind-up or recovery is cut by the clip edge', () => {
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

  it('control: the full wind-up + swing is admitted as ONE stroke', () => {
    const decision = admitImportedStrokeEvents(windUpThenSwing(1000, 3000));
    expect(decision.admitted).toBe(true);
  });

  it('refuses the same stroke when the clip starts in the middle of its wind-up', () => {
    // Trim so the first frame lands at the wind-up's peak: the backswing is
    // half outside the video, exactly the "moment of setup" the rejection
    // copy asks for.
    const full = windUpThenSwing(1000, 3000);
    const cut = trimSequence(full, 1000, 3000);
    const decision = admitImportedStrokeEvents(cut);
    expect(summarize(decision)).toEqual(REFUSED);
    if (decision.admitted) return;
    expect(decision.reason).toBe('stroke_truncated_at_clip_edge');
  });

  it('refuses the same stroke when the clip ends in the middle of its recovery', () => {
    const full = wristTravelProfile(
      3000,
      60,
      sumVelocities(
        along(1, hump(1000, 150, SWING)),
        along(-1, hump(1350, 150, WIND_UP)),
      ),
    );
    expect(admitImportedStrokeEvents(full).admitted).toBe(true);
    const cut = trimSequence(full, 0, 1350);
    const decision = admitImportedStrokeEvents(cut);
    expect(summarize(decision)).toEqual(REFUSED);
    if (decision.admitted) return;
    expect(decision.reason).toBe('stroke_truncated_at_clip_edge');
  });

  it('refuses a wind-up that emerges from a tracking gap at full speed', () => {
    const full = windUpThenSwing(1000, 3000);
    // Wrist untracked for 300 ms until the wind-up's peak.
    const gapped = occludeRightWrist(full, 700, 1000);
    const decision = admitImportedStrokeEvents(gapped);
    expect(summarize(decision)).toEqual(REFUSED);
    if (decision.admitted) return;
    expect(decision.reason).toBe('stroke_truncated_at_clip_edge');
  });
});

// ─── A4 · corrupt/partial pose state: a stroke hidden in a tracking hole ────

describe('W03-01 attack A4 — a second stroke hidden inside a wrist-tracking hole shorter than maxUntrackedSpanMs', () => {
  function twoStrokes(secondMs: number, durationMs: number) {
    return wristSpeedProfile(
      durationMs,
      60,
      sumOf(hump(1000, 150, 1.0), hump(secondMs, 150, 1.0)),
    );
  }

  it('control: two strokes 1.5 s apart are refused', () => {
    expectRefused(twoStrokes(2500, 4000), ['multiple_stroke_events']);
  });

  it('control: an untracked hole of 400 ms with no stroke inside still admits the lone stroke', () => {
    const lone = wristSpeedProfile(4000, 60, hump(1000, 150, 1.0));
    const decision = admitImportedClip(
      importedClip(lone),
      occludeRightWrist(lone, 2300, 2700),
    );
    expect(decision.admitted).toBe(true);
  });

  it('does not admit the clip when the second stroke is exactly the untracked span', () => {
    // Motion blur on the harder stroke loses the wrist for 400 ms: the
    // second stroke is unmeasured, so the clip is NOT known to hold one
    // stroke. Admission must refuse rather than vouch for what it cannot see.
    const hidden = occludeRightWrist(twoStrokes(2500, 4000), 2300, 2700);
    const clip = importedClip(hidden);
    const decision = admitImportedClip(clip, hidden);
    expect(
      decision.admitted
        ? { admitted: true, event: decision.event }
        : { admitted: false, reason: decision.reason },
    ).toEqual({ admitted: false, reason: expect.any(String) });
  });

  it('does not admit the clip when a 2.4 s hole (inside maxUntrackedSpanMs) swallows a stroke', () => {
    const hidden = occludeRightWrist(twoStrokes(2500, 5000), 1400, 3800);
    const clip = importedClip(hidden);
    const decision = admitImportedClip(clip, hidden);
    expect(
      decision.admitted
        ? { admitted: true, event: decision.event }
        : { admitted: false, reason: decision.reason },
    ).toEqual({ admitted: false, reason: expect.any(String) });
  });
});

// ─── A5 · boundary: clip metadata at the published limits ──────────────────

describe('W03-01 attack A5 — clip metadata boundaries', () => {
  function clipFor(overrides: Partial<ImportedClip>): ImportedClip {
    return importedClip(generateSwingSequence().sequence, overrides);
  }

  it('rejects a negative frame dimension instead of passing the pixel budget via a negative product', () => {
    // (-4096) × (-2160) = 4096 × 2160 passes the max-pixel product; each
    // dimension must be validated on its own.
    const decision = admitImportedMedia(
      clipFor({ width: -1920, height: -1080 }),
    );
    expect(decision.admitted).toBe(false);
  });

  it('rejects zero-sized and non-integer frame dimensions', () => {
    expect(
      admitImportedMedia(clipFor({ width: 0, height: 1080 })).admitted,
    ).toBe(false);
    expect(
      admitImportedMedia(clipFor({ width: 1920.5, height: 1080 })).admitted,
    ).toBe(false);
    expect(
      admitImportedMedia(clipFor({ width: Number.NaN, height: 1080 })).admitted,
    ).toBe(false);
  });

  it('rejects a zero or negative frame rate', () => {
    expect(admitImportedMedia(clipFor({ fps: 0 })).admitted).toBe(false);
    expect(admitImportedMedia(clipFor({ fps: -30 })).admitted).toBe(false);
    expect(
      admitImportedMedia(clipFor({ fps: Number.POSITIVE_INFINITY })).admitted,
    ).toBe(false);
  });

  it('a 60 s clip whose sidecar covers it at 240 fps is judged (not crashed) within a bounded time', () => {
    const long = wristSpeedProfile(59_800, 240, hump(30_000, 150, 1.0));
    const clip = importedClip(long, { durationMs: 60_000 });
    const started = Date.now();
    const decision = admitImportedClip(clip, long);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(decision.admitted).toBe(true);
  });

  it('refuses a probe whose track count is a non-integer or negative number', () => {
    const probe: ImportedMediaProbe = { videoTrackCount: 1.0000001 };
    expect(admitImportedMedia(clipFor({}), probe).admitted).toBe(false);
    expect(
      admitImportedMedia(clipFor({}), { videoTrackCount: -1 }).admitted,
    ).toBe(false);
  });
});

// ─── A6 · unreachable shipping surface: the probe is never supplied ─────────

describe('W03-01 attack A6 — rotation, codec and track-layout rules on the shipping path', () => {
  const runCaptureAnalysisSource = readFileSync(
    join(__dirname, '..', 'src', 'analysis', 'runCaptureAnalysis.ts'),
    'utf8',
  );
  const captureSource = readFileSync(
    join(__dirname, '..', 'src', 'camera', 'capture.ts'),
    'utf8',
  );

  it('the shipping analysis paths pass a media probe so rotation/codec/track rules can fire', () => {
    const calls =
      runCaptureAnalysisSource.match(
        /admitImported(?:Media|Clip)\([^()]*(?:\([^()]*\)[^()]*)*\)/g,
      ) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    // `admitImportedMedia(clip, probe)` / `admitImportedClip(clip, seq, probe)`.
    const withoutProbe = calls.filter(call => {
      const args = call.slice(call.indexOf('(') + 1, -1).split(',').length;
      return call.startsWith('admitImportedMedia') ? args < 2 : args < 3;
    });
    expect(withoutProbe).toEqual([]);
  });

  it('the imported CapturedClip carries the probe fields the rules read', () => {
    const missing = ['rotationDegrees', 'codec', 'videoTrackCount'].filter(
      field => !captureSource.includes(field),
    );
    expect(missing).toEqual([]);
  });
});

// ─── A7 · corrupt / partial pose state must refuse, never throw ─────────────

describe('W03-01 attack A7 — corrupt or partial pose sequences are refused, never thrown', () => {
  const swing = () => generateSwingSequence().sequence;

  function mapFrames(
    sequence: PoseSequence,
    map: (
      frame: PoseSequence['frames'][number],
      index: number,
    ) => PoseSequence['frames'][number],
  ): PoseSequence {
    return { ...sequence, frames: sequence.frames.map(map) };
  }

  const corruptions: ReadonlyArray<[string, () => PoseSequence]> = [
    ['an empty frame list', () => ({ ...swing(), frames: [] })],
    [
      'a single frame',
      () => ({ ...swing(), frames: swing().frames.slice(0, 1) }),
    ],
    [
      'frames whose timestamps run backwards',
      () => {
        const base = swing();
        const last = base.frames[base.frames.length - 1]?.timestampMs ?? 0;
        return mapFrames(base, frame => ({
          ...frame,
          timestampMs: last - frame.timestampMs,
        }));
      },
    ],
    [
      'frames with NaN timestamps',
      () =>
        mapFrames(swing(), (frame, index) => ({
          ...frame,
          timestampMs: index % 7 === 3 ? Number.NaN : frame.timestampMs,
        })),
    ],
    [
      'frames with an Infinity timestamp',
      () =>
        mapFrames(swing(), (frame, index) => ({
          ...frame,
          timestampMs:
            index === 20 ? Number.POSITIVE_INFINITY : frame.timestampMs,
        })),
    ],
    [
      'frames with negative timestamps',
      () =>
        mapFrames(swing(), frame => ({
          ...frame,
          timestampMs: frame.timestampMs - 10_000,
        })),
    ],
    [
      'every landmark NaN',
      () =>
        mapFrames(swing(), frame => ({
          ...frame,
          landmarks: frame.landmarks.map(mark => ({
            ...mark,
            x: Number.NaN,
            y: Number.NaN,
          })),
        })),
    ],
    [
      'a collapsed body (every landmark at one point → zero torso length)',
      () =>
        mapFrames(swing(), frame => ({
          ...frame,
          landmarks: frame.landmarks.map(mark => ({ ...mark, x: 0.5, y: 0.5 })),
        })),
    ],
    [
      'NaN visibility on every landmark',
      () =>
        mapFrames(swing(), frame => ({
          ...frame,
          landmarks: frame.landmarks.map(mark => ({
            ...mark,
            visibility: Number.NaN,
          })),
        })),
    ],
    [
      'frames without any landmarks',
      () => mapFrames(swing(), frame => ({ ...frame, landmarks: [] })),
    ],
    [
      'a zero-fps video header',
      () => ({ ...swing(), video: { ...swing().video, fps: 0 } }),
    ],
    [
      'a zero-height video header (aspect ratio division)',
      () => ({ ...swing(), video: { ...swing().video, height: 0 } }),
    ],
  ];

  it.each(corruptions)(
    '%s never makes the stroke-event measurement throw',
    (_title, build) => {
      const sequence = build();
      expect(() => admitImportedStrokeEvents(sequence)).not.toThrow();
    },
  );

  it.each(corruptions)(
    '%s is refused by the full clip gate without throwing',
    (_title, build) => {
      const sequence = build();
      const clip = importedClip(sequence, {
        durationMs: 3000,
        fps: 60,
        width: 1080,
        height: 1920,
      });
      let decision: ReturnType<typeof admitImportedClip> | undefined;
      expect(() => {
        decision = admitImportedClip(clip, sequence);
      }).not.toThrow();
      expect(decision?.admitted).toBe(false);
    },
  );
});
