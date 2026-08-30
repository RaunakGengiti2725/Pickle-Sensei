import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
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
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function recordingDb(): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse({
        permit: {
          id: 'permit-imported-1',
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
function importedClipWithSidecar(): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///imports/rally-clip.mov',
    durationMs: window.endMs,
    fps: 30,
    width: 1080,
    height: 1080,
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
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    captureId: 'capture-imported-1',
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
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
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
