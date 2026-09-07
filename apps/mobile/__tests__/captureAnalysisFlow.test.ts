import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { attemptCaptureEnvelope } from '../src/camera/captureEnvelope';
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

function recordingDb() {
  return createSqliteTestDb();
}

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  const reservations = new Map<string, string>();
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      const key = String(JSON.parse(String(init?.body)).idempotencyKey);
      const permitId =
        reservations.get(key) ??
        `66666666-6666-4666-8666-${String(reservations.size + 1).padStart(12, '0')}`;
      reservations.set(key, permitId);
      return jsonResponse({
        permit: {
          id: permitId,
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
      poseModelVersion: sequence.producedBy.modelVersion,
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
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(
  db: LocalDb,
  clip: CapturedClip,
  captureId = '77777777-7777-4777-8777-777777777777',
) {
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
  };
}

describe('runCaptureAnalysis', () => {
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
    expect(recordInsert!.params[2]).toBe(
      '77777777-7777-4777-8777-777777777777',
    );

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
    expect(outboxPayload.analysisPermitId).toBe(
      '66666666-6666-4666-8666-000000000001',
    );
    // A scored run is consumed by shot sync, never explicitly finalized.
    expect(finalized).toHaveLength(0);
  });

  it('does not reserve or save an analysis after the owner changes while its sidecar loads', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    mockReadArtifact = async () => {
      setActiveDataOwner('22222222-2222-4222-8222-222222222222');
      return sidecarJson;
    };

    const outcome = await runCaptureAnalysis(request(db, clip));

    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('releases the original permit without writing into a different account after reservation', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = async (
      url: string,
      init?: RequestInit,
    ) => {
      const response = await fetchMock(url, init);
      if (url.endsWith('/v1/analysis-permits')) {
        setActiveDataOwner('22222222-2222-4222-8222-222222222222');
      }
      return response;
    };

    const outcome = await runCaptureAnalysis(request(db, clip));

    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    expect(
      calls.some(call =>
        call.sql.includes('INSERT INTO local_analysis_record'),
      ),
    ).toBe(false);
    expect(calls.some(call => call.sql.includes('INSERT INTO outbox'))).toBe(
      false,
    );
    const journal = await db.execute(
      'SELECT owner_key, state FROM analysis_run_journal',
    );
    expect(journal.rows).toEqual([{ owner_key: owner, state: 'released' }]);
    expect(finalized).toEqual([{ outcome: 'cancelled', ratingId: null }]);
  });

  it('invalidates an earlier run even when the same owner signs back in before completion', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      setActiveDataOwner(owner);
      return sidecarJson;
    };
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));

    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('releases a reserved permit when persisting the analysis fails', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const store = recordingDb();
    const { db } = store;
    store.failStatementOnce(
      'INSERT INTO local_analysis_record',
      new Error('local write failed'),
    );

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'local write failed',
    );
    expect(finalized).toEqual([{ outcome: 'failed', ratingId: null }]);
  });

  it('commits the practice set, analysis and outbox together before returning a score', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const sessionId = '33333333-3333-4333-8333-333333333333';

    const outcome = await runCaptureAnalysis({
      ...request(db, clip),
      sessionId,
      practiceSet: {
        sessionId,
        owner,
        resumed: false,
        shotType: 'forehand_drive',
        startedAtIso: clip.capturedAtIso,
        nowIso: clip.capturedAtIso,
      },
    });

    expect(outcome.kind).toBe('scored');
    const resultTransaction = calls.find(call =>
      call.sql.includes('INSERT INTO local_analysis_record'),
    )?.transaction;
    const resultCalls = calls.filter(
      call => call.transaction === resultTransaction,
    );
    expect(
      resultCalls.filter(call => call.sql === 'BEGIN IMMEDIATE'),
    ).toHaveLength(1);
    expect(resultCalls.filter(call => call.sql === 'COMMIT')).toHaveLength(1);
    const sessionWrite = calls.find(call =>
      call.sql.includes('INSERT OR REPLACE INTO local_session'),
    );
    expect(sessionWrite?.params.slice(0, 2)).toEqual([owner, sessionId]);
    const queued = calls.filter(call =>
      call.sql.includes('INSERT INTO outbox'),
    );
    expect(queued).toHaveLength(2);
    expect(queued[0]?.sql).toContain("'session.create'");
    expect(queued[1]?.sql).toContain("'shot.sync'");
    expect(calls.at(-1)?.sql).toBe('COMMIT');
  });

  it('rolls back the whole result when the owner changes during a write', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const store = recordingDb();
    const { db, calls } = store;
    store.observeStatements(call => {
      if (call.sql.includes('INSERT INTO local_analysis_record')) {
        setActiveDataOwner('22222222-2222-4222-8222-222222222222');
      }
    });

    const outcome = await runCaptureAnalysis(request(db, clip));

    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    const resultTransaction = calls.find(call =>
      call.sql.includes('INSERT INTO local_analysis_record'),
    )?.transaction;
    const resultCalls = calls.filter(
      call => call.transaction === resultTransaction,
    );
    expect(resultCalls[0]?.sql).toBe('BEGIN IMMEDIATE');
    expect(resultCalls.at(-1)?.sql).toBe('ROLLBACK');
    expect(resultCalls.some(call => call.sql === 'COMMIT')).toBe(false);
    expect(store.count('local_analysis_record', owner)).toBe(0);
    expect(store.count('local_shot', owner)).toBe(0);
    expect(calls.some(call => call.sql.includes('INSERT INTO outbox'))).toBe(
      false,
    );
    expect(finalized).toEqual([{ outcome: 'cancelled', ratingId: null }]);
  });

  it('supports explicitly distinct analyses of one capture without touching earlier records', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const first = await runCaptureAnalysis({
      ...request(db, clip),
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const second = await runCaptureAnalysis({
      ...request(db, clip),
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
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

  it('UNSUPPORTED capture envelope forces honest abstention BEFORE inference — no permit, no record, no score', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    // 320x240 short side → resolution UNSUPPORTED → overall UNSUPPORTED.
    const envelope = attemptCaptureEnvelope(
      { width: 320, height: 240, fps: 60, durationMs: clip.durationMs },
      null,
      null,
    );
    expect(envelope.overall).toBe('UNSUPPORTED');

    const outcome = await runCaptureAnalysis({
      ...request(db, clip),
      captureEnvelope: envelope,
    });
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toContain('resolution');
    expect(outcome.reason).toContain('Nothing was rated');
    expect(outcome.envelope).toEqual(envelope);
    expect(outcome.envelope).not.toBe(envelope);
    // Poor input never silently became analysis: no permit reserved, no
    // inference, no record, no rating.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('DEGRADED envelope proceeds and is attached to the attempt record', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    // 640 short side → resolution DEGRADED; nothing UNSUPPORTED.
    const envelope = attemptCaptureEnvelope(
      { width: 640, height: 1280, fps: clip.fps, durationMs: clip.durationMs },
      null,
      null,
    );
    expect(envelope.overall).toBe('DEGRADED');

    const outcome = await runCaptureAnalysis({
      ...request(db, clip),
      captureEnvelope: envelope,
    });
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.record.captureEnvelope).toEqual(envelope);
    expect(outcome.record.captureEnvelope).not.toBe(envelope);

    // The persisted record carries the verdict for downstream Result.
    const recordInsert = calls.find(call =>
      call.sql.includes('local_analysis_record'),
    );
    expect(recordInsert).toBeDefined();
    const persisted = JSON.parse(String(recordInsert!.params[6]));
    expect(persisted.captureEnvelope.overall).toBe('DEGRADED');
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
