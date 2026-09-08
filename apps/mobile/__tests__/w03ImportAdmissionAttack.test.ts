import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';
import {
  IMPORT_ADMISSION_LIMITS,
  IMPORT_ADMISSION_REASONS,
  admitImportedClip,
  admitImportedMedia,
  admitImportedStrokeEvents,
  importAdmissionRejectionMessage,
} from '../src/camera/importAdmission';

/**
 * W03-01 adversarial suite against candidate b8c1afd4 (import admission).
 *
 * Every test asserts the behaviour the work package promises ("ambiguous
 * clips are rejected with a precise reason and never reach charging"). A
 * failing test here is a confirmed break; a passing test is an attack the
 * candidate survived. The candidate's own tests and production code are not
 * modified.
 */

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

type ImportedClip = CapturedClip & { captureMode: 'imported_video' };

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

/** Second sequence appended `gapMs` after the first ends; indices and
 * timestamps stay strictly ascending so the canonical parser accepts it. */
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

/** Keep only frames inside [fromMs, toMs] and rebase them to start at 0 —
 * i.e. the clip a player gets when they trim the idle tails off a shot. */
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

/** Skeleton standing still except for the wrists, whose frame-to-frame speed
 * (image heights per second, square video) follows the given profiles. */
function wristSpeedProfiles(
  durationMs: number,
  fps: number,
  rightAt: (tMs: number) => number,
  leftAt: (tMs: number) => number = () => 0,
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
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark => {
        if (mark.name === 'right_wrist') {
          return { ...mark, x: 0.55 + (index % 2 === 0 ? 0 : rightStep) };
        }
        if (mark.name === 'left_wrist') {
          return { ...mark, x: 0.3 + (index % 2 === 0 ? 0 : leftStep) };
        }
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

function sumOf(...profiles: Array<(tMs: number) => number>) {
  return (tMs: number): number =>
    profiles.reduce((total, profile) => total + profile(tMs), 0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

const owner = '33333333-3333-4333-8333-333333333333';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function permitServer(): {
  fetchMock: jest.Mock;
  reservations: string[];
  finalized: unknown[];
} {
  const reservations: string[] = [];
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reservations.push(url);
      return jsonResponse({
        permit: {
          id: '66666666-6666-4666-8666-666666666666',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-30T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalized.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, reservations, finalized };
}

function analysisRequest(db: LocalDb, clip: CapturedClip) {
  const captureId = '77777777-7777-4777-8777-777777777777';
  seedSqliteCapture(db, owner, captureId, clip);
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    targetSeed: {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-08-30T10:01:00.000Z',
    },
  };
}

describe('ATTACK 1 — free-rating conservation: ambiguous import must never reach charging', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    establishApiSession({
      canonicalAppUserId: owner,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      provider: 'apple',
    });
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('a two-stroke rally the admission module rejects does not reserve a permit or score', async () => {
    const rally = concatSequences(
      generateSwingSequence().sequence,
      generateSwingSequence().sequence,
      1000,
    );
    const clip = importedClip(rally);
    // Precondition: the pure gate itself refuses this exact clip.
    const gate = admitImportedClip(clip, rally);
    expect(gate.admitted).toBe(false);
    if (gate.admitted) return;
    expect(gate.reason).toBe('multiple_stroke_events');

    const { db } = createSqliteTestDb();
    mockReadArtifact = async () => serializePoseSequence(rally);
    const { fetchMock, reservations, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(analysisRequest(db, clip));

    // The work package: "ambiguous clips are rejected with a precise reason
    // and never reach charging." A permit reservation IS the charging path.
    expect({
      permitReservations: reservations.length,
      permitFinalizations: finalized,
      kind: outcome.kind,
    }).toEqual({
      permitReservations: 0,
      permitFinalizations: [],
      kind: 'unavailable',
    });
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('multiple_stroke_events'),
    );
  });
});

describe('ATTACK 2 — two comparable strokes fused across a short pause', () => {
  it('two identical trimmed swings 100 ms apart are two events, not one', () => {
    // A player trims the idle tails off each shot (the generator's ready
    // pose lasts ~400 ms and the recovery ~550 ms); back to back the two
    // stroke cores are separated by a quiet gap shorter than mergeGapMs.
    const core = () =>
      trimSequence(generateSwingSequence().sequence, 200, 1500);
    const rally = concatSequences(core(), core(), 100);
    const decision = admitImportedStrokeEvents(rally);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
  });

  it('two identical speed peaks 800 ms apart are two events, not one', () => {
    for (const spacingMs of [600, 800]) {
      const sequence = wristSpeedProfiles(
        4000,
        60,
        sumOf(hump(1500, 250, 2.5), hump(1500 + spacingMs, 250, 2.5)),
      );
      const decision = admitImportedStrokeEvents(sequence);
      // sameEventPeakDistanceMs is 350 ms: peaks 600–800 ms apart are, by
      // the candidate's own definition, NOT the same event.
      expect(spacingMs).toBeGreaterThan(
        IMPORT_ADMISSION_LIMITS.sameEventPeakDistanceMs,
      );
      expect(decision.admitted).toBe(false);
    }
  });
});

describe('ATTACK 3 — transitive bridging through the other wrist', () => {
  it('adding non-stroke motion between two rejected strokes must not admit them', () => {
    const twoStrokes = sumOf(hump(1000, 250, 2.5), hump(2800, 250, 2.5));
    const bare = admitImportedStrokeEvents(
      wristSpeedProfiles(5000, 60, twoStrokes),
    );
    expect(bare.admitted).toBe(false);
    if (bare.admitted) return;
    expect(bare.reason).toBe('multiple_stroke_events');

    // Same two right-wrist strokes, plus a slow left-arm movement that
    // overlaps the pause between them (e.g. reaching for the next ball).
    const bridged = admitImportedStrokeEvents(
      wristSpeedProfiles(5000, 60, twoStrokes, hump(1900, 800, 1.2)),
    );
    // Monotonicity: extra motion can only make a clip MORE ambiguous.
    expect(bridged.admitted).toBe(false);
  });
});

describe('ATTACK 4 — sidecar/clip consistency: pose data covering a fraction of the clip', () => {
  it('a 45 s clip whose sidecar stops after 2 s is not a validated single-stroke clip', () => {
    const { sequence } = generateSwingSequence();
    const clip = importedClip(sequence, { durationMs: 45_000 });
    expect(admitImportedMedia(clip).admitted).toBe(true);
    const decision = admitImportedClip(clip, sequence);
    // 43 s of the imported clip carry no pose evidence at all; whatever
    // happens there (more strokes, a different player) is unknown. A
    // conservative gate cannot vouch for "one analyzable stroke".
    expect(decision.admitted).toBe(false);
  });

  it('a sidecar whose timeline starts before the clip is rejected', () => {
    const { sequence } = generateSwingSequence();
    const shifted: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        timestampMs: frame.timestampMs - 5000,
      })),
    };
    // The canonical parser accepts this record (finite, strictly ascending).
    const clip = importedClip(shifted, { durationMs: 2000 });
    const decision = admitImportedClip(clip, shifted);
    expect(decision.admitted).toBe(false);
  });
});

describe('ATTACK 5 — boundary values on the container probe', () => {
  const { sequence } = generateSwingSequence();
  const clip = importedClip(sequence);

  it('a non-finite or absurd rotation is not silently normalised to 0°', () => {
    for (const rotationDegrees of [1e300, (Number.MAX_SAFE_INTEGER + 2) * 90]) {
      const decision = admitImportedMedia(clip, { rotationDegrees });
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).toBe('unsupported_rotation');
    }
  });

  it('a non-finite duration is reported precisely, not as "too short"', () => {
    for (const durationMs of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const decision = admitImportedMedia({ ...clip, durationMs });
      expect(decision.admitted).toBe(false);
      if (decision.admitted) return;
      expect(decision.reason).not.toBe('duration_too_short');
    }
  });

  it('exact envelope edges behave as published (survived)', () => {
    expect(admitImportedMedia({ ...clip, fps: 15 }).admitted).toBe(true);
    expect(admitImportedMedia({ ...clip, fps: 240 }).admitted).toBe(true);
    expect(admitImportedMedia({ ...clip, fps: 14.999 }).admitted).toBe(false);
    expect(admitImportedMedia({ ...clip, fps: 240.001 }).admitted).toBe(false);
    expect(admitImportedMedia({ ...clip, durationMs: 800 }).admitted).toBe(
      true,
    );
    expect(admitImportedMedia({ ...clip, durationMs: 799 }).admitted).toBe(
      false,
    );
    expect(admitImportedMedia({ ...clip, durationMs: 60_000 }).admitted).toBe(
      true,
    );
    expect(admitImportedMedia({ ...clip, durationMs: 60_001 }).admitted).toBe(
      false,
    );
    expect(
      admitImportedMedia({ ...clip, width: 4096, height: 2160 }).admitted,
    ).toBe(true);
    expect(
      admitImportedMedia({ ...clip, width: 4097, height: 2160 }).admitted,
    ).toBe(false);
    expect(
      admitImportedMedia({ ...clip, width: 3000, height: 3000 }).admitted,
    ).toBe(false);
    expect(admitImportedMedia({ ...clip, width: 0 }).admitted).toBe(false);
    expect(admitImportedMedia({ ...clip, width: 1.5 }).admitted).toBe(false);
    expect(
      admitImportedMedia(clip, { videoTrackCount: Number.NaN }).admitted,
    ).toBe(false);
    expect(admitImportedMedia(clip, { videoTrackCount: -1 }).admitted).toBe(
      false,
    );
    expect(
      admitImportedMedia(clip, { rotationDegrees: Number.POSITIVE_INFINITY })
        .admitted,
    ).toBe(false);
    expect(admitImportedMedia(clip, { codec: 'avc1\u0000' }).admitted).toBe(
      false,
    );
  });
});

describe('ATTACK 6 — corrupt/partial pose input handed straight to the stroke gate', () => {
  it('collapsed timestamps do not crash or admit (survived)', () => {
    const { sequence } = generateSwingSequence();
    const collapsed: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({ ...frame, timestampMs: 0 })),
    };
    const decision = admitImportedStrokeEvents(collapsed);
    expect(decision.admitted).toBe(false);
  });

  it('does not mutate its input and is deterministic (survived)', () => {
    const rally = deepFreeze(
      concatSequences(
        generateSwingSequence().sequence,
        generateSwingSequence().sequence,
        1000,
      ),
    );
    const first = admitImportedStrokeEvents(rally);
    const second = admitImportedStrokeEvents(rally);
    expect(second).toEqual(first);
  });
});

describe('ATTACK 7 — published contract surfaces', () => {
  it('IMPORT_ADMISSION_REASONS is frozen like IMPORT_ADMISSION_LIMITS', () => {
    expect(Object.isFrozen(IMPORT_ADMISSION_LIMITS)).toBe(true);
    expect(Object.isFrozen(IMPORT_ADMISSION_REASONS)).toBe(true);
  });

  it('every rejection message follows APP_STORE_SUBMISSION.md copy rules (survived)', () => {
    const forbidden =
      /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|best|most accurate|as good as a coach|ai coach/i;
    for (const reason of IMPORT_ADMISSION_REASONS) {
      const message = importAdmissionRejectionMessage(reason);
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toMatch(forbidden);
      expect(message).toMatch(/[.!]$/);
    }
  });
});
