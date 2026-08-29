import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

/**
 * Capture → fusion analysis → durable records, with the entitlement system
 * respected and every honesty gate verified.
 */

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

const owner = '11111111-1111-4111-8111-111111111111';

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
          id: 'permit-1',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
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

function swingClipWithSidecar(
  overrides: Parameters<typeof generateSwingSequence>[0] = {},
): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence(overrides);
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-abc.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/stroke-abc.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip, captureId = 'capture-1') {
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

describe('runCaptureAnalysis', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('refuses legacy captures without a recorded pose sequence — no permit is touched', async () => {
    const { db, calls } = recordingDb();
    const { clip } = swingClipWithSidecar();
    const legacy = { ...clip, poseSequence: undefined } as CapturedClip;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, legacy));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('predates pose-sequence recording');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rejects a corrupted sidecar instead of repairing it', async () => {
    const { db, calls } = recordingDb();
    const { clip } = swingClipWithSidecar();
    const corrupt = '{"schemaVersion": 99}';
    mockReadArtifact = async () => corrupt;
    const withMatchingHash = {
      ...clip,
      poseSequence: {
        ...(clip.captureMode === 'automatic_pose_trigger'
          ? clip.poseSequence!
          : (undefined as never)),
        sha256: sha256Hex(corrupt),
      },
    } as CapturedClip;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, withMatchingHash));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('pose_sequence.unsupported_schema');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rejects a tampered sidecar whose bytes no longer match the recorded hash', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    // Valid-looking sequence, but one coordinate was altered after capture.
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

  it('scores a real capture end to end: record appended, capture analyzed, permit consumed by sync', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.record.result?.overallScore).not.toBeNull();
    expect(outcome.record.strokeResolution).toEqual({
      kind: 'declared',
      shotType: 'forehand_drive',
    });

    const recordInsert = calls.find(call =>
      call.sql.includes('local_analysis_record'),
    );
    expect(recordInsert).toBeDefined();
    expect(recordInsert!.params[2]).toBe('capture-1');

    const statusUpdate = calls.find(call =>
      call.sql.includes("SET status = 'analyzed'"),
    );
    expect(statusUpdate).toBeDefined();

    const shotInsert = calls.find(call =>
      call.sql.includes('INSERT OR REPLACE INTO local_shot'),
    );
    expect(shotInsert).toBeDefined();
    const outboxInsert = calls.find(call =>
      call.sql.includes('INSERT INTO outbox'),
    );
    expect(outboxInsert).toBeDefined();
    const outboxPayload = JSON.parse(String(outboxInsert!.params[1]));
    expect(outboxPayload.analysisPermitId).toBe('permit-1');
    // A scored run is consumed by shot sync, never explicitly finalized.
    expect(finalized).toHaveLength(0);
  });

  it('supports multiple analyses of one capture without touching earlier records', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const first = await runCaptureAnalysis(request(db, clip));
    const second = await runCaptureAnalysis(request(db, clip));
    expect(first.kind).toBe('scored');
    expect(second.kind).toBe('scored');
    if (first.kind !== 'scored' || second.kind !== 'scored') return;
    expect(first.analysisId).not.toBe(second.analysisId);

    const recordInserts = calls.filter(call =>
      call.sql.includes('local_analysis_record'),
    );
    expect(recordInserts).toHaveLength(2);
    expect(recordInserts[0]!.params[1]).not.toBe(recordInserts[1]!.params[1]); // ids differ
    expect(recordInserts[0]!.params[2]).toBe(recordInserts[1]!.params[2]); // same capture
    expect(
      recordInserts.every(call => call.sql.startsWith('INSERT INTO')),
    ).toBe(true);
  });

  it('releases the permit on abstention and never syncs an unscored rating', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    // Freeze all wrists: motion never happened, the pipeline must abstain.
    const frozen = JSON.parse(sidecarJson);
    for (const frame of frozen.frames) {
      for (const mark of frame.l) {
        if (String(mark.n).endsWith('wrist')) {
          mark.x = 0.5;
          mark.y = 0.5;
        }
      }
    }
    const frozenJson = JSON.stringify(frozen);
    mockReadArtifact = async () => frozenJson;
    const frozenClip = {
      ...clip,
      poseSequence: {
        ...(clip.captureMode === 'automatic_pose_trigger'
          ? clip.poseSequence!
          : (undefined as never)),
        sha256: sha256Hex(frozenJson),
      },
    } as CapturedClip;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, frozenClip));
    expect(outcome.kind).toBe('unavailable');
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ outcome: 'failed', ratingId: null });
    expect(
      calls.filter(call => call.sql.includes('INSERT INTO outbox')),
    ).toHaveLength(0);
  });
});
