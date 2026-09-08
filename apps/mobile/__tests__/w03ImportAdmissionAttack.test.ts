import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  captureDataOwnerContext,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  extractImportedPoseSequence,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../src/camera/capture';
import {
  IMPORT_ADMISSION_LIMITS,
  admitImportedClip,
  admitImportedMedia,
  admitImportedStrokeEvents,
} from '../src/camera/importAdmission';
import {
  prepareOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

/**
 * W03-01 adversarial attacks against candidate ad5187ac.
 *
 * Every test here encodes the behaviour the work package promises — an
 * ambiguous imported clip is refused with a precise reason and never reaches
 * a permit reservation — and is expected to FAIL on the candidate where the
 * candidate breaks that promise. Tests that pass on the candidate document
 * attacks that did not break anything.
 */

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
    verifyCapturedClipCurrentBytes: jest.fn(),
    extractImportedPoseSequence: jest.fn(),
  };
});

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';
const CAPTURE = '77777777-7777-4777-8777-777777777777';
const LOGICAL = '88888888-8888-4888-8888-888888888888';
const SESSION = '99999999-9999-4999-8999-999999999999';

type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

function importedClip(
  sequence: PoseSequence,
  overrides: Partial<ImportedClip> = {},
): { clip: ImportedClip; sidecarJson: string } {
  const sidecarJson = serializePoseSequence(sequence);
  const last = sequence.frames[sequence.frames.length - 1];
  const clip: ImportedClip = {
    uri: 'file:///imports/w03-attack.mov',
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
      uri: 'file:///imports/w03-attack.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
    ...overrides,
  };
  return { clip, sidecarJson };
}

/**
 * Same construction as the candidate's own `wristSpeedProfile`: a still
 * skeleton whose right wrist alternates between two points so the measured
 * frame-to-frame speed follows `speedAt` exactly (image heights per second).
 */
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

/** Peak torso-lengths/second of a lone hump of `peak` image heights/s. */
function admittedAlone(peak: number): number {
  const decision = admitImportedStrokeEvents(
    wristSpeedProfile(3000, 60, hump(1500, 150, peak)),
  );
  expect(decision.admitted).toBe(true);
  if (!decision.admitted) return 0;
  expect(decision.event.peakTorsoPerSecond).toBeGreaterThanOrEqual(
    IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
  );
  return decision.event.peakTorsoPerSecond;
}

function signIn(account = owner) {
  setActiveDataOwner(account);
  establishApiSession({
    canonicalAppUserId: account,
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    provider: 'apple',
  });
}

function sessionlessRequest(db: LocalDb, clip: CapturedClip) {
  seedSqliteCapture(db, owner, CAPTURE, clip);
  return {
    db,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    targetSeed: {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-09-08T08:01:00.000Z',
    },
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

/** Records permit reservations and refuses everything else. */
function permitRecorder(): {
  fetchMock: jest.Mock;
  permitCalls: () => string[];
} {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse({
        permit: {
          id: '66666666-6666-4666-8666-666666666666',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-08T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) return jsonResponse({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return {
    fetchMock,
    permitCalls: () =>
      fetchMock.mock.calls
        .map(call => String(call[0]))
        .filter(url => url.endsWith('/v1/analysis-permits')),
  };
}

// ── Attack 1–3: the preparation window demotes a REAL stroke ──────────────

describe('W03-01 attack — preparation window demotes a complete stroke', () => {
  // A: 1.0 image heights/s ≈ 5 torso/s, admitted as a stroke on its own.
  // B: 3.0 image heights/s ≈ 15 torso/s, admitted as a stroke on its own.
  // Both humps are 300 ms wide and separated by a 300 ms COMPLETE stop
  // (speed exactly 0), so nothing about A "prepares" B: it is a finished
  // stroke followed by a harder one 600 ms later.
  const SOFT = 1.0;
  const HARD = 3.0;

  it('A alone and B alone are each admitted as one stroke above the absolute floor', () => {
    expect(admittedAlone(SOFT)).toBeGreaterThanOrEqual(4);
    expect(admittedAlone(HARD)).toBeGreaterThanOrEqual(4);
  });

  it('two complete strokes 600 ms apart are two events, even when the second is 3× harder', () => {
    const clip = wristSpeedProfile(
      3000,
      60,
      sumOf(hump(1200, 150, SOFT), hump(1800, 150, HARD)),
    );
    const decision = admitImportedStrokeEvents(clip);
    // Both candidates were measured and each clears the absolute stroke floor.
    expect(decision.candidates).toHaveLength(2);
    for (const candidate of decision.candidates)
      expect(candidate.peakTorsoPerSecond).toBeGreaterThanOrEqual(
        IMPORT_ADMISSION_LIMITS.minStrokePeakTorsoPerSecond,
      );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('multiple_stroke_events');
    expect(decision.comparableEventCount).toBe(2);
  });

  it('is monotonic in the second stroke: making stroke B harder never turns a refusal into an admission', () => {
    const outcomes = [1.5, 2.0, 2.4, 2.6, 3.0, 5.0].map(hard => {
      const decision = admitImportedStrokeEvents(
        wristSpeedProfile(
          3000,
          60,
          sumOf(hump(1200, 150, SOFT), hump(1800, 150, hard)),
        ),
      );
      return { hard, admitted: decision.admitted };
    });
    // Two equal-ish strokes are refused (the candidate's own 600–800 ms
    // test pins this); a harder B must not flip the verdict to admitted.
    expect(outcomes[0]?.admitted).toBe(false);
    for (const outcome of outcomes) expect(outcome.admitted).toBe(false);
  });

  it('an escalating three-stroke rally (each stroke admitted alone) is refused as several strokes', () => {
    // ≈ 4, 11 and 30 torso lengths/s after smoothing; peaks 600 ms apart.
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

  it('does not decide two strokes by whether their peaks are 700 or 717 ms apart', () => {
    const at = (centerMs: number) =>
      admitImportedStrokeEvents(
        wristSpeedProfile(
          3000,
          60,
          sumOf(hump(1200, 150, SOFT), hump(centerMs, 150, HARD)),
        ),
      ).admitted;
    // Peaks 717 ms apart: two strokes. Peaks 700 ms apart: must be the same
    // verdict — a 17 ms (one frame) shift cannot make a rally one stroke.
    expect(at(1917)).toBe(false);
    expect(at(1900)).toBe(false);
  });
});

// ── Attack 4: the demoted rally reaches the permit reservation ────────────

describe('W03-01 attack — the demoted two-stroke clip reaches charging', () => {
  beforeEach(() => {
    signIn();
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('session-less runCaptureAnalysis refuses the soft-then-hard rally before any permit is reserved', async () => {
    const { db } = createSqliteTestDb();
    const rally = wristSpeedProfile(
      3000,
      60,
      sumOf(hump(1200, 150, 1.0), hump(1800, 150, 3.0)),
    );
    const { clip, sidecarJson } = importedClip(rally);
    mockReadArtifact = async () => sidecarJson;
    const recorder = permitRecorder();
    (globalThis as { fetch?: unknown }).fetch = recorder.fetchMock;

    const outcome = await runCaptureAnalysis(sessionlessRequest(db, clip));
    expect(recorder.permitCalls()).toHaveLength(0);
    expect(outcome.kind).toBe('quality_blocked');
  });
});

// ── Attack 5: corrupt persisted sidecar on the saved-original path ────────

describe('W03-01 attack — corrupt sidecar on the saved-original path', () => {
  const leases: OriginalAnalysisExecution[] = [];

  function execution() {
    const value = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      'https://api.test',
    );
    leases.push(value);
    return value;
  }

  async function savedImport(clip: CapturedClip, sidecarJson: string) {
    const store = createSqliteTestDb();
    const identity = {
      schemaVersion: 1 as const,
      format: 'pickle.native-media-identity.v1' as const,
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '55555555-5555-4555-8555-555555555555',
      origin: 'import_copy' as const,
      algorithm: 'sha256' as const,
      videoFileName: 'w03-attack.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    };
    const saved: CapturedClip = {
      ...clip,
      byteSize: 25,
      nativeMediaIdentity: identity,
    };
    seedSqliteCapture(store.db, owner, CAPTURE, saved);
    const targetSeed = {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-09-08T08:01:00.000Z',
    };
    await store.db.execute(
      'UPDATE local_capture SET declared_stroke = ?, target_seed = ? WHERE id = ?',
      ['forehand_drive', JSON.stringify(targetSeed), CAPTURE],
    );
    mockReadArtifact = async () => sidecarJson;
    const recorder = permitRecorder();
    (globalThis as { fetch?: unknown }).fetch = recorder.fetchMock;
    const lease = execution();
    await prepareOriginalCaptureAnalysis(
      {
        db: store.db,
        ownerContext: lease.ownerContext,
        captureId: CAPTURE,
        clip: saved,
        declaredStroke: 'forehand_drive',
        declaredCanonical: 'FOREHAND_DRIVE',
        handedness: 'right',
        cameraView: 'side',
        appVersion: '0.1.0',
        apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
        sessionId: SESSION,
        practiceSet: {
          owner,
          sessionId: SESSION,
          resumed: false,
          shotType: 'forehand_drive',
          startedAtIso: '2026-09-08T08:00:00.000Z',
          nowIso: '2026-09-08T08:00:00.000Z',
        },
        targetSeed,
      },
      lease,
      LOGICAL,
    );
    const run = () =>
      runOriginalCaptureAnalysis({
        db: store.db,
        execution: lease,
        operationId: LOGICAL,
      });
    const attemptRows = () =>
      store.native
        .prepare(
          'SELECT state, release_outcome, permit_id FROM analysis_execution_attempts WHERE owner_key = ?',
        )
        .all(owner);
    return { store, lease, run, attemptRows, recorder };
  }

  beforeEach(() => {
    signIn();
    jest.mocked(extractImportedPoseSequence).mockReset();
    jest
      .mocked(verifyCapturedClipCurrentBytes)
      .mockReset()
      .mockImplementation(async clip => ({
        status: 'verified-current-bytes',
        comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
      }));
    jest
      .mocked(pipeline.analyzeCapture)
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
          .analyzeCapture,
      );
  });
  afterEach(() => {
    for (const lease of leases.splice(0)) lease.dispose();
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('an imported sidecar that fails the canonical parse mints no attempt and reserves nothing', async () => {
    const { sequence } = generateSwingSequence();
    const corrupt = JSON.stringify({ schemaVersion: 1, frames: 'corrupt' });
    const { clip } = importedClip(sequence, {
      poseSequence: {
        ...importedClip(sequence).clip.poseSequence!,
        sha256: sha256Hex(corrupt),
      },
    });
    const saved = await savedImport(clip, corrupt);
    const outcome = await saved.run();
    expect(outcome.kind).not.toBe('scored');
    expect(saved.recorder.permitCalls()).toHaveLength(0);
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
    expect(saved.attemptRows()).toEqual([]);
  });

  it('the demoted soft-then-hard rally is refused on the saved path before any attempt exists', async () => {
    const rally = wristSpeedProfile(
      3000,
      60,
      sumOf(hump(1200, 150, 1.0), hump(1800, 150, 3.0)),
    );
    const { clip, sidecarJson } = importedClip(rally);
    const saved = await savedImport(clip, sidecarJson);
    const outcome = await saved.run();
    expect(saved.recorder.permitCalls()).toHaveLength(0);
    expect(saved.attemptRows()).toEqual([]);
    expect(outcome.kind).toBe('quality_blocked');
  });
});

// ── Attack 6: container envelope boundary values ──────────────────────────

describe('W03-01 attack — container envelope boundaries', () => {
  const { clip: base } = importedClip(generateSwingSequence().sequence);
  const reasonOf = (overrides: Partial<ImportedClip>) => {
    const decision = admitImportedMedia({ ...base, ...overrides });
    return decision.admitted ? 'admitted' : decision.reason;
  };

  it('treats the published limits as inclusive and one step beyond as rejected', () => {
    const { minDurationMs, maxDurationMs, maxFps, maxFrameDimension } =
      IMPORT_ADMISSION_LIMITS;
    expect(reasonOf({ durationMs: minDurationMs })).toBe('admitted');
    expect(reasonOf({ durationMs: minDurationMs - 0.001 })).toBe(
      'duration_too_short',
    );
    expect(reasonOf({ durationMs: maxDurationMs })).toBe('admitted');
    expect(reasonOf({ durationMs: maxDurationMs + 0.001 })).toBe(
      'duration_too_long',
    );
    expect(reasonOf({ fps: maxFps })).toBe('admitted');
    expect(reasonOf({ fps: maxFps + 1e-9 })).toBe('frame_rate_too_high');
    expect(reasonOf({ width: maxFrameDimension, height: 2160 })).toBe(
      'admitted',
    );
    expect(reasonOf({ width: 2160, height: maxFrameDimension })).toBe(
      'admitted',
    );
    expect(reasonOf({ width: maxFrameDimension, height: 2161 })).toBe(
      'unsupported_dimensions',
    );
    expect(reasonOf({ width: maxFrameDimension + 1, height: 1 })).toBe(
      'unsupported_dimensions',
    );
  });

  it('rejects negative, zero, signed-zero, non-integer and non-finite geometry', () => {
    expect(reasonOf({ durationMs: -1 })).toBe('duration_too_short');
    expect(reasonOf({ durationMs: -0 })).toBe('duration_too_short');
    expect(reasonOf({ durationMs: Number.POSITIVE_INFINITY })).toBe(
      'duration_unknown',
    );
    expect(reasonOf({ durationMs: Number.NaN })).toBe('duration_unknown');
    expect(reasonOf({ fps: 0 })).toBe('frame_rate_unknown');
    expect(reasonOf({ fps: -30 })).toBe('frame_rate_unknown');
    expect(reasonOf({ fps: Number.NaN })).toBe('frame_rate_unknown');
    expect(reasonOf({ fps: Number.POSITIVE_INFINITY })).toBe(
      'frame_rate_unknown',
    );
    expect(reasonOf({ width: 0 })).toBe('unsupported_dimensions');
    expect(reasonOf({ width: -1080 })).toBe('unsupported_dimensions');
    expect(reasonOf({ width: 1080.5 })).toBe('unsupported_dimensions');
    expect(reasonOf({ height: Number.NaN })).toBe('unsupported_dimensions');
    expect(reasonOf({ height: Number.POSITIVE_INFINITY })).toBe(
      'unsupported_dimensions',
    );
  });

  it('reports the earliest failing gate when several fail at once', () => {
    expect(
      reasonOf({ durationMs: 100, fps: 1000, width: 100_000, height: 1 }),
    ).toBe('duration_too_short');
    expect(reasonOf({ fps: 1000, width: 100_000 })).toBe('frame_rate_too_high');
  });
});

// ── Attack 7: sidecar timeline and coverage boundaries ────────────────────

describe('W03-01 attack — sidecar timeline and coverage boundaries', () => {
  const { sequence, window } = generateSwingSequence();

  it('tolerates the last pose stamp up to exactly timelineToleranceMs past the clip and no further', () => {
    const last = sequence.frames[sequence.frames.length - 1];
    if (!last) throw new Error('no frames');
    const tolerance = IMPORT_ADMISSION_LIMITS.timelineToleranceMs;
    const within = importedClip(sequence, {
      durationMs: last.timestampMs - tolerance,
    });
    expect(admitImportedClip(within.clip, sequence).admitted).toBe(true);
    const beyond = importedClip(sequence, {
      durationMs: last.timestampMs - tolerance - 1,
    });
    const decision = admitImportedClip(beyond.clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_geometry_mismatch');
  });

  it('admits an untracked tail of exactly maxUntrackedSpanMs and refuses one millisecond more', () => {
    const last = sequence.frames[sequence.frames.length - 1];
    if (!last) throw new Error('no frames');
    const span = IMPORT_ADMISSION_LIMITS.maxUntrackedSpanMs;
    const exact = importedClip(sequence, {
      durationMs: last.timestampMs + span,
    });
    expect(admitImportedClip(exact.clip, sequence).admitted).toBe(true);
    const over = importedClip(sequence, {
      durationMs: last.timestampMs + span + 1,
    });
    const decision = admitImportedClip(over.clip, sequence);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('pose_coverage_incomplete');
    expect(window.endMs).toBeLessThan(last.timestampMs + span);
  });

  it('refuses an empty sidecar (zero frames) with a precise reason rather than admitting it', () => {
    const empty: PoseSequence = { ...sequence, frames: [] };
    const { clip } = importedClip(empty, { durationMs: 1000 });
    const decision = admitImportedClip(clip, empty);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.reason).toBe('too_few_pose_frames');
  });

  it('refuses a sidecar whose frames all carry the same timestamp', () => {
    const frozen: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({ ...frame, timestampMs: 500 })),
    };
    const { clip } = importedClip(frozen, { durationMs: 1000 });
    const decision = admitImportedClip(clip, frozen);
    expect(decision.admitted).toBe(false);
  });
});

// ── Attack 8: rotation / codec / track gates are reachable from the app ───

describe('W03-01 attack — rotation, codec and track-layout gates are wired', () => {
  it('the shipping analysis paths hand a container probe to the import gate', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'analysis', 'runCaptureAnalysis.ts'),
      'utf8',
    );
    expect(source).toMatch(/admitImportedMedia\(/);
    expect(source).toMatch(/admitImportedClip\(/);
    // Without a probe the rotation, codec and video-track gates of
    // `admitImportedMedia` can never fire for a clip the app analyzes.
    expect(source).not.toMatch(/admitImportedMedia\(\s*clip\s*\)/);
    expect(source).not.toMatch(
      /admitImportedClip\(\s*clip,\s*parsed\.value\s*\)/,
    );
  });
});
