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

/**
 * W03-01 ADVERSARIAL TESTS — charging boundary (attack branch, candidate
 * b391819a). The objective says ambiguous clips "never reach charging". Each
 * test feeds a clip the unit-level attacks showed to be wrongly admitted (or
 * a corrupt persisted artefact) through the two shipping entry points and
 * asserts that POST /v1/analysis-permits is never reached and no durable
 * attempt is minted. A FAILING test is a confirmed break.
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
const OTHER_OWNER = '44444444-4444-4444-8444-444444444444';
const CAPTURE = '77777777-7777-4777-8777-777777777777';
const LOGICAL = '88888888-8888-4888-8888-888888888888';
const SESSION = '99999999-9999-4999-8999-999999999999';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

/** A permit server that records every reservation it is asked for. */
function permitServer() {
  const reservations: string[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reservations.push(String(init?.body ?? ''));
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
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  return { fetchMock, reservations };
}

function importedClipWithSidecar(sequence: PoseSequence): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const last = sequence.frames[sequence.frames.length - 1];
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///imports/attack-clip.mov',
    durationMs: (last?.timestampMs ?? 0) + 200,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-08T08:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    posterUri: 'file:///imports/attack-clip.poster.jpg',
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/attack-clip.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
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

function wristProfile(
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
    const odd = index % 2 === 1;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark => {
        if (mark.name === 'right_wrist')
          return { ...mark, x: 0.55 + (odd ? rightStep : 0) };
        if (mark.name === 'left_wrist')
          return { ...mark, x: 0.3 + (odd ? leftStep : 0) };
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

/** Six-stroke non-stop paddle-hand rally with one off-hand gesture. */
function rallyWithOffHandGesture(): PoseSequence {
  return wristProfile(
    4000,
    60,
    tMs =>
      tMs > 500 && tMs < 3500
        ? 0.65 + 0.35 * Math.sin((2 * Math.PI * tMs) / 500)
        : 0,
    hump(2000, 150, 1.0),
  );
}

/** Four volleys in 1.85 s whose wrist never slows below 60% of peak. */
function fourVolleys(): PoseSequence {
  return wristProfile(5000, 60, tMs => {
    if (tMs < 1000 || tMs > 2800) return 0;
    const phase = ((tMs - 1000) % 450) / 450;
    return 0.6 + 0.4 * Math.max(0, 1 - Math.abs(phase - 0.5) * 2);
  });
}

/** Two complete strokes with a dead stop between them, peaks 340 ms apart. */
function twoStrokesCloseTogether(): PoseSequence {
  const first = hump(1000, 150, 1.0);
  const second = hump(1340, 150, 1.0);
  return wristProfile(3000, 60, tMs => first(tMs) + second(tMs));
}

/** Two swings one second apart — the candidate refuses this one. */
function twoStrokeRally(): PoseSequence {
  const first = generateSwingSequence().sequence;
  const second = generateSwingSequence().sequence;
  const lastFirst = first.frames[first.frames.length - 1];
  const offset = (lastFirst?.timestampMs ?? 0) + 1000;
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

// ───────────────────────────────────────────────────────────────────────────
// Session-less entry point (runCaptureAnalysis).
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 10 — wrongly admitted clips reach POST /v1/analysis-permits (session-less path)', () => {
  beforeEach(() => {
    signIn();
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it.each([
    [
      'a 3 s paddle-hand rally with one off-hand gesture',
      rallyWithOffHandGesture,
    ],
    ['four volleys in 1.85 s', fourVolleys],
    ['two complete strokes 340 ms apart', twoStrokesCloseTogether],
  ])('%s is refused before any permit is reserved', async (_label, build) => {
    const { db } = createSqliteTestDb();
    const { clip, sidecarJson } = importedClipWithSidecar(build());
    mockReadArtifact = async () => sidecarJson;
    const { reservations } = permitServer();

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(reservations).toHaveLength(0);
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toBe(
      importAdmissionRejectionMessage('multiple_stroke_events'),
    );
  });

  it('double submit: two concurrent session-less runs of a refused rally never reserve', async () => {
    const { db } = createSqliteTestDb();
    const { clip, sidecarJson } = importedClipWithSidecar(twoStrokeRally());
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    const req = request(db, clip);
    const results = await Promise.all([
      runCaptureAnalysis(req),
      runCaptureAnalysis(req),
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        kind: 'quality_blocked',
        reason: importAdmissionRejectionMessage('multiple_stroke_events'),
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('interleaved account switch while the sidecar is being read: no admission verdict, no permit', async () => {
    const { db } = createSqliteTestDb();
    const { clip, sidecarJson } = importedClipWithSidecar(
      generateSwingSequence().sequence,
    );
    mockReadArtifact = async () => {
      clearApiSession();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      signIn(OTHER_OWNER);
      return sidecarJson;
    };
    const { fetchMock } = permitServer();
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).not.toBe('quality_blocked');
    expect(outcome.kind).not.toBe('completed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Signed-in saved-original entry point (runOriginalCaptureAnalysis).
// ───────────────────────────────────────────────────────────────────────────
describe('ATTACK 11 — wrongly admitted or corrupt imports on the saved-original path', () => {
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
    sequence: PoseSequence,
    options: { sidecarBytes?: (json: string) => string } = {},
  ) {
    const store = createSqliteTestDb();
    const built = importedClipWithSidecar(sequence);
    const sidecarText = options.sidecarBytes
      ? options.sidecarBytes(built.sidecarJson)
      : built.sidecarJson;
    const identity = {
      schemaVersion: 1 as const,
      format: 'pickle.native-media-identity.v1' as const,
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '55555555-5555-4555-8555-555555555555',
      origin: 'import_copy' as const,
      algorithm: 'sha256' as const,
      videoFileName: 'attack-clip.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    };
    const clip: CapturedClip = {
      ...built.clip,
      byteSize: 25,
      nativeMediaIdentity: identity,
      poseSequence: {
        ...built.clip.poseSequence!,
        sha256: sha256Hex(sidecarText),
      },
    };
    seedSqliteCapture(store.db, owner, CAPTURE, clip);
    const targetSeed = {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-09-08T08:01:00.000Z',
    };
    await store.db.execute(
      'UPDATE local_capture SET declared_stroke = ?, target_seed = ? WHERE id = ?',
      ['forehand_drive', JSON.stringify(targetSeed), CAPTURE],
    );
    mockReadArtifact = async () => sidecarText;
    const { fetchMock, reservations } = permitServer();
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
    return { store, lease, run, attemptRows, reservations, fetchMock };
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

  it.each([
    [
      'a 3 s paddle-hand rally with one off-hand gesture',
      rallyWithOffHandGesture,
    ],
    ['four volleys in 1.85 s', fourVolleys],
    ['two complete strokes 340 ms apart', twoStrokesCloseTogether],
  ])(
    '%s reserves nothing, infers nothing and mints no attempt',
    async (_label, build) => {
      const saved = await savedImport(build());
      const outcome = await saved.run();
      expect(saved.reservations).toHaveLength(0);
      expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
      expect(saved.attemptRows()).toEqual([]);
      expect(outcome.kind).toBe('quality_blocked');
    },
  );

  it('corrupt persisted sidecar (hash-consistent, unparseable): no attempt survives, and startup recovery performs no permit traffic', async () => {
    // The stored artefact matches its recorded hash but is not a pose
    // sequence at all. The import can never be analyzed; it must not leave a
    // live attempt behind for the next launch to reserve a permit against.
    const saved = await savedImport(generateSwingSequence().sequence, {
      sidecarBytes: json => json.slice(0, Math.floor(json.length / 2)),
    });
    const outcome = await saved.run();
    expect(outcome.kind).toBe('unavailable');
    expect(saved.reservations).toHaveLength(0);
    expect(
      saved
        .attemptRows()
        .filter(row => (row as { state: string }).state !== 'terminal'),
    ).toEqual([]);

    saved.lease.dispose();
    const startup = mockPort();
    await recoverAnalysisJournals(saved.store.db, saved.lease.scope, startup);
    expect(startup.reserve).not.toHaveBeenCalled();
    expect(startup.release).not.toHaveBeenCalled();
  });

  it('corrupt persisted sidecar (hash mismatch): no attempt survives, and startup recovery performs no permit traffic', async () => {
    const saved = await savedImport(generateSwingSequence().sequence);
    // The bytes on disk drift after the capture recorded its hash.
    mockReadArtifact = async () => '{"drifted":true}';
    const outcome = await saved.run();
    expect(outcome.kind).toBe('unavailable');
    expect(saved.reservations).toHaveLength(0);
    expect(
      saved
        .attemptRows()
        .filter(row => (row as { state: string }).state !== 'terminal'),
    ).toEqual([]);

    saved.lease.dispose();
    const startup = mockPort();
    await recoverAnalysisJournals(saved.store.db, saved.lease.scope, startup);
    expect(startup.reserve).not.toHaveBeenCalled();
    expect(startup.release).not.toHaveBeenCalled();
  });
});
