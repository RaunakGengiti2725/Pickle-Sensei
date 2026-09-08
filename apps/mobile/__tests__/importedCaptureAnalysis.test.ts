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
 *
 * W03-01 regression (fails on BASE 42291369): an imported sidecar holding
 * TWO comparable strokes reached the permit path — `POST /v1/analysis-permits`
 * was called and the permit finalized downstream — instead of being refused
 * up front with the precise admission reason. Import admission must run
 * BEFORE any permit reservation, journal row or fusion work.
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
  };
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
  const lastMs =
    sequence.frames[sequence.frames.length - 1]?.timestampMs ??
    generated.window.endMs;
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///imports/rally-clip.mov',
    durationMs:
      durationOverrideMs ??
      (sequenceOverride ? lastMs + 200 : generated.window.endMs),
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

/** Two sequences played back to back, the second starting `gapMs` after the
 * first ends. */
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

describe('runCaptureAnalysis imported-video gate', () => {
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

  it('refuses an ambiguous two-stroke import BEFORE any permit is reserved (W03-01)', async () => {
    const { db, calls } = recordingDb();
    const first = generateSwingSequence();
    const second = generateSwingSequence();
    const rally = concatSequences(first.sequence, second.sequence, 1000);
    const { clip, sidecarJson } = importedClipWithSidecar(rally);
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toMatch(/one stroke|single stroke/i);
    // Never reached charging: no reservation, no finalization, no journal.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalized).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses two strokes with a sub-500 ms ready pause BEFORE any permit is reserved (W03-01 round 3)', async () => {
    const { db, calls } = recordingDb();
    const first = generateSwingSequence({ readyMs: 400, recoverMs: 550 });
    const second = generateSwingSequence({ readyMs: 200, recoverMs: 550 });
    const rally = concatSequences(first.sequence, second.sequence, 0);
    const { clip, sidecarJson } = importedClipWithSidecar(rally);
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toMatch(/one stroke|single stroke/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalized).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses an import whose sidecar covers only a sliver of the clip BEFORE any permit is reserved', async () => {
    const { db, calls } = recordingDb();
    const { sequence } = generateSwingSequence();
    const { clip, sidecarJson } = importedClipWithSidecar(sequence, 45_000);
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toMatch(/tracked/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('refuses an import outside the media envelope before the sidecar is even read', async () => {
    const { db, calls } = recordingDb();
    const { clip } = importedClipWithSidecar(undefined, 60_001);
    let sidecarReads = 0;
    mockReadArtifact = async () => {
      sidecarReads += 1;
      throw new Error('sidecar must not be read for an oversized import');
    };
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('60 seconds');
    expect(sidecarReads).toBe(0);
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
