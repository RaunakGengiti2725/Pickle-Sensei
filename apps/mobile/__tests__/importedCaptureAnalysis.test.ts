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
import { importAdmissionRejectionMessage } from '../src/camera/importAdmission';
import {
  prepareOriginalCaptureAnalysis,
  reconcileOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import {
  recoverAnalysisJournals,
  type RunJournalPermitPort,
} from '../src/analysis/runJournal';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';
import { importedPoseExtractionFailureMessage } from '../src/screens/AnalyzeScreen';

/**
 * Imported-video analysis gate (runCaptureAnalysis).
 *
 * The old behavior refused every imported clip up front. Now the native
 * extraction pass can attach the SAME hash-addressed pose-sequence sidecar
 * guided capture records, and the gate admits exactly that: an imported clip
 * WITH a validated sidecar analyzes for real (integrity hash + canonical
 * parse unchanged), while one WITHOUT keeps the honest refusal — nothing is
 * reconstructed, no permit is touched.
 */

// AnalyzeScreen (imported here only for its pure failure-copy helper) pulls
// in the SQLite-backed db module, whose native binding does not exist under
// jest; the helper never touches it.
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

function recordingDb() {
  return createSqliteTestDb();
}

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
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
  return { fetchMock, finalized };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

/** An imported clip whose extraction pass already attached a REAL sidecar
 * ref (hash of the actual serialized sequence, exactly as native records). */
function importedClipWithSidecar(
  sequenceOverride?: PoseSequence,
  durationOverrideMs?: number,
): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const generated = generateSwingSequence();
  const sequence = sequenceOverride ?? generated.sequence;
  const lastFrame = sequence.frames[sequence.frames.length - 1];
  const durationMs =
    durationOverrideMs ??
    (sequenceOverride
      ? (lastFrame?.timestampMs ?? 0) + 200
      : generated.window.endMs);
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///imports/rally-clip.mov',
    durationMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    posterUri: 'file:///imports/rally-clip.poster.jpg',
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/rally-clip.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
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

/** Two swings one second apart: a rally, never a single stroke. */
function twoStrokeRally(): PoseSequence {
  return concatSequences(
    generateSwingSequence().sequence,
    generateSwingSequence().sequence,
    1000,
  );
}

/** A far harder drive than the generated swing, admitted as ONE stroke alone. */
function hardDrive(): PoseSequence {
  return generateSwingSequence({
    backswingLengthNorm: 1.4,
    accelerateMs: 150,
    followMs: 200,
    torsoLength: 0.3,
  }).sequence;
}

/**
 * A still skeleton whose right wrist alternates between two points so its
 * measured frame-to-frame speed (image heights per second) follows `speedAt`.
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

/**
 * A soft stroke (1.0 image heights/s, admitted alone) then, after 300 ms of
 * complete stillness, a stroke three times harder 600 ms later. Two finished
 * strokes: the soft one is never the hard one's wind-up.
 */
function softThenHardRally(): PoseSequence {
  const soft = hump(1200, 150, 1.0);
  const hard = hump(1800, 150, 3.0);
  return wristSpeedProfile(3000, 60, tMs => soft(tMs) + hard(tMs));
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

function signIn(account = owner) {
  setActiveDataOwner(account);
  establishApiSession({
    canonicalAppUserId: account,
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    provider: 'apple',
  });
}

describe('runCaptureAnalysis imported-video gate', () => {
  beforeEach(() => {
    signIn();
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('analyzes an imported clip once the extraction sidecar is attached — real record, honest provenance', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = importedClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.record.result?.overallScore).not.toBeNull();
    expect(outcome.record.strokeResolution).toEqual({
      kind: 'declared',
      shotType: 'forehand_drive',
    });
    // The analysis window is honestly the WHOLE imported clip, produced by
    // the imported-full-clip provenance — never an impersonated live trigger.
    expect(outcome.record.result?.timestamps.startMs).toBe(0);
    expect(outcome.record.result?.timestamps.endMs).toBe(clip.durationMs);
    const providerIds = outcome.record.provenance.providerVersions.map(
      ref => ref.providerId,
    );
    expect(providerIds).toContain('trigger.imported-full-clip');
    expect(providerIds).not.toContain('trigger.temporal-heuristic');

    // Analysis really ran: durable record + analyzed status + rated shot.
    expect(calls.some(call => call.sql.includes('local_analysis_record'))).toBe(
      true,
    );
    expect(
      calls.some(call => call.sql.includes("SET status = 'analyzed'")),
    ).toBe(true);
    expect(
      calls.some(call =>
        call.sql.includes('INSERT OR REPLACE INTO local_shot'),
      ),
    ).toBe(true);
  });

  it('keeps the honest refusal for imported clips without a pose sequence — no permit is touched', async () => {
    const { db, calls } = recordingDb();
    const { clip } = importedClipWithSidecar();
    const bare = {
      ...clip,
      poseSequence: undefined,
      posterUri: undefined,
    } as CapturedClip;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, bare));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain(
      'Imported videos have no recorded pose sequence yet',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('still rejects an imported sidecar whose bytes drifted from the recorded hash', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = importedClipWithSidecar();
    mockReadArtifact = async () => sidecarJson.replace('"x":0.5', '"x":0.51');
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('integrity check');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('still rejects an imported sidecar that fails the canonical parse', async () => {
    const { db } = recordingDb();
    const { clip } = importedClipWithSidecar();
    const corrupt = '{"schemaVersion": 99}';
    mockReadArtifact = async () => corrupt;
    const tampered = {
      ...clip,
      poseSequence: {
        ...(clip.poseSequence as NonNullable<typeof clip.poseSequence>),
        sha256: sha256Hex(corrupt),
      },
    } as CapturedClip;

    const outcome = await runCaptureAnalysis(request(db, tampered));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('pose_sequence.unsupported_schema');
  });
});

/**
 * W03-01 — conservative import admission on the shipping analysis path.
 *
 * An imported clip that is unsupported (duration, frame rate, geometry) or
 * ambiguous (more than one stroke) is refused BEFORE any permit is reserved,
 * with the precise reason as the outcome. A refused clip never becomes a
 * durable attempt that recovery or reconciliation could later reserve for.
 */
describe('W03-01 import admission — session-less runCaptureAnalysis', () => {
  beforeEach(() => {
    signIn();
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('refuses a two-stroke rally with the precise reason before any permit is reserved', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = importedClipWithSidecar(twoStrokeRally());
    mockReadArtifact = async () => sidecarJson;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('multiple_stroke_events'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('a rally stays refused when a much harder third stroke is appended — never reduced to the loudest peak', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = importedClipWithSidecar(
      concatSequences(twoStrokeRally(), hardDrive(), 1000),
    );
    mockReadArtifact = async () => sidecarJson;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('multiple_stroke_events'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('refuses a soft stroke followed 600 ms later by a 3× harder stroke before any permit is reserved', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = importedClipWithSidecar(softThenHardRally());
    mockReadArtifact = async () => sidecarJson;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('multiple_stroke_events'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('refuses a too-short import before the sidecar is even read', async () => {
    const { db, calls } = recordingDb();
    const { clip } = importedClipWithSidecar(undefined, 500);
    const readSpy = jest.fn(async () => {
      throw new Error('sidecar must not be read for a refused clip');
    });
    mockReadArtifact = readSpy;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('duration_too_short'),
    );
    expect(readSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('refuses a 241 fps import as unsupported frame rate before the sidecar is read or any permit is reserved', async () => {
    const { db, calls } = recordingDb();
    const { sequence } = generateSwingSequence({ handed: 'right', fps: 241 });
    const { clip } = importedClipWithSidecar(sequence);
    const readSpy = jest.fn(async () => {
      throw new Error('sidecar must not be read for a refused clip');
    });
    mockReadArtifact = readSpy;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('frame_rate_too_high'),
    );
    expect(readSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('W03-01 import admission — signed-in saved-original path', () => {
  const OTHER_OWNER = '44444444-4444-4444-8444-444444444444';
  const CAPTURE = '77777777-7777-4777-8777-777777777777';
  const LOGICAL = '88888888-8888-4888-8888-888888888888';
  const SESSION = '99999999-9999-4999-8999-999999999999';
  const leases: OriginalAnalysisExecution[] = [];

  function execution() {
    const value = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      'https://api.test',
    );
    leases.push(value);
    return value;
  }

  function mockPort(account = owner): RunJournalPermitPort & {
    reserve: jest.Mock;
    release: jest.Mock;
  } {
    return {
      ownerKey: account,
      apiOrigin: 'https://api.test',
      reserve: jest.fn(async (key: string) => ({
        permit: {
          id: `cccccccc-cccc-4ccc-8ccc-${key.slice(0, 12)}`,
          status: 'reserved',
        },
      })),
      release: jest.fn(async () => undefined),
    };
  }

  async function savedImport(
    sequence: PoseSequence | undefined,
    durationMs?: number,
    options: { withSidecar?: boolean } = {},
  ) {
    const store = createSqliteTestDb();
    const built = importedClipWithSidecar(sequence, durationMs);
    const identity = {
      schemaVersion: 1 as const,
      format: 'pickle.native-media-identity.v1' as const,
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '55555555-5555-4555-8555-555555555555',
      origin: 'import_copy' as const,
      algorithm: 'sha256' as const,
      videoFileName: 'rally-clip.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    };
    const {
      poseSequence: _poseSequence,
      posterUri: _posterUri,
      ...unextracted
    } = built.clip;
    const clip: CapturedClip =
      options.withSidecar === false
        ? { ...unextracted, byteSize: 25, nativeMediaIdentity: identity }
        : { ...built.clip, byteSize: 25, nativeMediaIdentity: identity };
    seedSqliteCapture(store.db, owner, CAPTURE, clip);
    const targetSeed = {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-08-30T10:01:00.000Z',
    };
    await store.db.execute(
      'UPDATE local_capture SET declared_stroke = ?, target_seed = ? WHERE id = ?',
      ['forehand_drive', JSON.stringify(targetSeed), CAPTURE],
    );
    mockReadArtifact = async () => built.sidecarJson;
    const fetchSpy = jest.fn(async (url: string) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    const permitCalls = () =>
      fetchSpy.mock.calls
        .map(call => String(call[0]))
        .filter(url => url.includes('/v1/analysis-permits'));
    const lease = execution();
    await prepareOriginalCaptureAnalysis(
      {
        db: store.db,
        ownerContext: lease.ownerContext,
        captureId: CAPTURE,
        clip,
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
          startedAtIso: '2026-08-30T10:00:00.000Z',
          nowIso: '2026-08-30T10:00:00.000Z',
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
    const reconcile = () =>
      reconcileOriginalCaptureAnalysis({
        db: store.db,
        execution: lease,
        operationId: LOGICAL,
      });
    return { store, lease, run, reconcile, attemptRows, permitCalls, fetchSpy };
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

  it('a refused rally returns the precise reason, reserves nothing, infers nothing and mints no attempt', async () => {
    const saved = await savedImport(twoStrokeRally());
    const outcome = await saved.run();
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('multiple_stroke_events'),
    );
    expect(saved.permitCalls()).toHaveLength(0);
    expect(saved.fetchSpy).not.toHaveBeenCalled();
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
    expect(saved.attemptRows()).toEqual([]);
  });

  it('a soft-then-hard rally is refused on the saved path: no permit, no inference, no attempt', async () => {
    const saved = await savedImport(softThenHardRally());
    const outcome = await saved.run();
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('multiple_stroke_events'),
    );
    expect(saved.permitCalls()).toHaveLength(0);
    expect(saved.fetchSpy).not.toHaveBeenCalled();
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
    expect(saved.attemptRows()).toEqual([]);
  });

  it('a too-short import is refused before extraction, before the sidecar is read and before any attempt exists', async () => {
    const saved = await savedImport(undefined, 500, { withSidecar: false });
    const readSpy = jest.fn(async () => {
      throw new Error('sidecar must not be read for a refused clip');
    });
    mockReadArtifact = readSpy;
    const outcome = await saved.run();
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('duration_too_short'),
    );
    expect(extractImportedPoseSequence).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(saved.permitCalls()).toHaveLength(0);
    expect(saved.attemptRows()).toEqual([]);
  });

  it('startup recovery after process death never reserves a permit for a refused import', async () => {
    const saved = await savedImport(twoStrokeRally());
    expect((await saved.run()).kind).toBe('quality_blocked');
    saved.lease.dispose();
    const startup = mockPort();
    const recovered = await recoverAnalysisJournals(
      saved.store.db,
      saved.lease.scope,
      startup,
    );
    expect(startup.reserve).not.toHaveBeenCalled();
    expect(startup.release).not.toHaveBeenCalled();
    expect(recovered.items).toEqual([]);
    expect(saved.attemptRows()).toEqual([]);
  });

  it('explicit reconciliation of a refused import performs no permit traffic', async () => {
    const saved = await savedImport(twoStrokeRally());
    expect((await saved.run()).kind).toBe('quality_blocked');
    await saved.reconcile();
    expect(saved.permitCalls()).toHaveLength(0);
    expect(saved.fetchSpy).not.toHaveBeenCalled();
    expect(saved.attemptRows()).toEqual([]);
  });

  it('every retry, before and after reconciliation, repeats the precise reason rather than a recovery placeholder', async () => {
    const saved = await savedImport(twoStrokeRally());
    const expected = importAdmissionRejectionMessage('multiple_stroke_events');
    const first = await saved.run();
    expect(first.kind).toBe('quality_blocked');
    const second = await saved.run();
    expect(second.kind).toBe('quality_blocked');
    if (second.kind !== 'quality_blocked') return;
    expect(second.reason).toBe(expected);
    await saved.reconcile();
    const third = await saved.run();
    expect(third.kind).toBe('quality_blocked');
    if (third.kind !== 'quality_blocked') return;
    expect(third.reason).toBe(expected);
    expect(saved.permitCalls()).toHaveLength(0);
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
  });

  it('two concurrent runs of the same refused import neither reserve nor mint an attempt', async () => {
    const saved = await savedImport(twoStrokeRally());
    const results = await Promise.all([saved.run(), saved.run()]);
    const kinds = results.map(result => result.kind);
    expect(kinds).toContain('quality_blocked');
    for (const result of results) {
      if (result.kind === 'quality_blocked')
        expect(result.reason).toBe(
          importAdmissionRejectionMessage('multiple_stroke_events'),
        );
      else expect(result).toMatchObject({ kind: 'unavailable' });
    }
    expect(saved.permitCalls()).toHaveLength(0);
    expect(saved.attemptRows()).toEqual([]);
    const settled = await saved.run();
    expect(settled.kind).toBe('quality_blocked');
    expect(saved.permitCalls()).toHaveLength(0);
  });

  it("another account cannot recover or reserve the first account's refused import", async () => {
    const saved = await savedImport(twoStrokeRally());
    expect((await saved.run()).kind).toBe('quality_blocked');
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    signIn(OTHER_OWNER);
    const other = execution();
    const otherPort = mockPort(OTHER_OWNER);
    const recovered = await recoverAnalysisJournals(
      saved.store.db,
      other.scope,
      otherPort,
    );
    expect(recovered.items).toEqual([]);
    expect(otherPort.reserve).not.toHaveBeenCalled();
    expect(saved.permitCalls()).toHaveLength(0);
    expect(saved.store.count('analysis_execution_attempts', OTHER_OWNER)).toBe(
      0,
    );
  });

  it('control: an admitted single-stroke import passes the gate and reaches the permit reservation on the saved path', async () => {
    const saved = await savedImport(undefined);
    const outcome = await saved.run();
    expect(outcome.kind).not.toBe('quality_blocked');
    expect(saved.permitCalls()).toHaveLength(1);
  });
});

describe('imported pose-extraction failure copy', () => {
  it('maps the frozen too-long code to actionable trim guidance', () => {
    const error = Object.assign(new Error('native: asset too long'), {
      code: 'camera.import_too_long',
    });
    const message = importedPoseExtractionFailureMessage(error);
    expect(message).toContain('too long');
    expect(message).toContain('Trim');
  });

  it('maps the frozen no-person code to honest tracking copy', () => {
    const error = Object.assign(new Error('native: nobody found'), {
      code: 'camera.import_no_person',
    });
    const message = importedPoseExtractionFailureMessage(error);
    expect(message).toContain('No person could be tracked');
  });

  it('surfaces unknown errors verbatim instead of inventing a cause', () => {
    expect(
      importedPoseExtractionFailureMessage(new Error('Disk is full.')),
    ).toBe('Disk is full.');
    expect(importedPoseExtractionFailureMessage({})).toContain(
      'Reading player movement',
    );
  });
});
