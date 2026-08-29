// AnalyzeScreen pulls in the SQLite-backed db, whose native binding does not
// exist under jest. The presentation helper under test never touches it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import { strokeIntentPresentation } from '../src/screens/AnalyzeScreen';

/**
 * AUTO DETECT end to end (W4): declared-null runs route through the REAL
 * ported hierarchical classifier and the fusion resolution ladder.
 *
 * Hard rules locked here:
 *  - declared and predicted stay separate (an AUTO run never writes a
 *    declaration, a family read never becomes a leaf slug);
 *  - abstention/family outcomes release the analysis permit — they must
 *    never burn the user's rating allowance — and render honest copy;
 *  - the declared path is byte-for-byte unchanged;
 *  - imported videos still require a declared technique and are refused
 *    before any stroke routing or permit reservation.
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

const owner = '22222222-2222-4222-8222-222222222222';

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
          id: 'permit-auto-1',
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
    uri: 'file:///captures/stroke-auto.mov',
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
      uri: 'file:///captures/stroke-auto.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

const importedClip: CapturedClip = {
  uri: 'file:///imports/rally.mov',
  durationMs: 5100,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: '2026-08-27T18:10:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

function request(
  db: LocalDb,
  clip: CapturedClip,
  declaredStroke: 'forehand_drive' | null,
  declaredCanonical: string | null = null,
) {
  return {
    db,
    captureId: 'capture-auto-1',
    clip,
    declaredStroke,
    declaredCanonical,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

describe('runCaptureAnalysis with AUTO DETECT (declared-null)', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('resolves a clear side swing at family depth: durable record, permit released, no invented leaf', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip, null));
    expect(outcome.kind).toBe('low_confidence');
    if (outcome.kind !== 'low_confidence') return;

    // declared/predicted stay separate; the family read is not a leaf slug.
    const intent = outcome.record.strokeIntent;
    expect(intent.declaredStroke).toBeNull();
    expect(intent.resolutionBasis).toBe('predicted_family');
    expect(intent.resolvedProfileId).toBe('SHARED_FOREHAND_SWING');
    expect(intent.predictedStroke?.label).toBe('FOREHAND');
    expect(intent.predictedStroke?.leaf).toBeNull();
    expect(intent.disagreement).toBeNull();
    expect(outcome.record.result).toBeNull(); // no per-technique score invented
    expect(outcome.record.strokeResolution.kind).toBe('unresolved');

    // Provenance: the classifier ran as a registry-governed model run.
    expect(
      outcome.record.modelRuns.some(
        run =>
          run.task === 'stroke_classification' &&
          run.model.providerId === 'stroke.heuristic-hierarchical',
      ),
    ).toBe(true);

    // Permit accounting: released, never a rating.
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      outcome: 'low_confidence',
      ratingId: null,
    });
    expect(
      calls.filter(call => call.sql.includes('INSERT INTO outbox')),
    ).toHaveLength(0);
    expect(
      calls.filter(call => call.sql.includes('local_shot')),
    ).toHaveLength(0);
    // The run is durably recorded for reprocessing history.
    expect(
      calls.some(call => call.sql.includes('local_analysis_record')),
    ).toBe(true);

    // Honest surface copy for the family-level outcome.
    const presentation = strokeIntentPresentation(outcome.record);
    expect(presentation?.title).toBe('Auto-detected: FOREHAND (family)');
    expect(presentation?.body).toContain('not to an exact stroke');
    expect(presentation?.body).toContain('did not use a rating');
    expect(presentation?.showResult).toBe(false);
  });

  it('abstains honestly on a midline contact: permit released and the result withheld, not guessed', async () => {
    const { db, calls } = recordingDb();
    // Contact exactly on the body midline — the heuristic refuses a side.
    const { clip, sidecarJson } = swingClipWithSidecar({
      contactForwardNorm: 0,
    });
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip, null));
    expect(outcome.kind).toBe('low_confidence');
    if (outcome.kind !== 'low_confidence') return;

    const intent = outcome.record.strokeIntent;
    expect(intent.resolutionBasis).toBe('abstained');
    expect(intent.resolvedProfileId).toBeNull();
    expect(intent.predictedStroke?.label).toBe('UNKNOWN');
    expect(outcome.record.result).toBeNull();

    // The abstention did NOT consume the user's rating allowance.
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      outcome: 'low_confidence',
      ratingId: null,
    });
    expect(
      calls.filter(call => call.sql.includes('INSERT INTO outbox')),
    ).toHaveLength(0);

    // Honest abstention copy, exactly as the product promises it.
    const presentation = strokeIntentPresentation(outcome.record);
    expect(presentation?.title).toBe(
      'We couldn’t identify this stroke — result withheld.',
    );
    expect(presentation?.eyebrow).toBe('RATING NOT CONSUMED');
    expect(presentation?.body).toContain('did not use a rating');
    expect(presentation?.showResult).toBe(false);
  });

  it('keeps the declared path unchanged: full chain on the declaration, permit consumed via sync', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(
      request(db, clip, 'forehand_drive', 'FOREHAND_DRIVE'),
    );
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.record.strokeResolution).toEqual({
      kind: 'declared',
      shotType: 'forehand_drive',
    });
    const intent = outcome.record.strokeIntent;
    expect(intent.declaredStroke).toBe('forehand_drive');
    expect(intent.resolutionBasis).toBe('declared');
    expect(intent.resolvedProfileId).toBe('FOREHAND_DRIVE');
    // The classifier's side read agrees with the declaration: no claim.
    expect(intent.disagreement).toBeNull();
    expect(outcome.record.result?.overallScore).not.toBeNull();

    // No honest-surface interruption: the clean declared run navigates
    // straight to the Result screen exactly as before this workstream.
    expect(strokeIntentPresentation(outcome.record)).toBeNull();

    const outboxInsert = calls.find(call =>
      call.sql.includes('INSERT INTO outbox'),
    );
    expect(outboxInsert).toBeDefined();
    expect(
      JSON.parse(String(outboxInsert!.params[1])).analysisPermitId,
    ).toBe('permit-auto-1');
    expect(finalized).toHaveLength(0); // consumed by sync, never finalized
  });

  it('still refuses imported videos before stroke routing — declared or not, no permit is touched', async () => {
    const { db, calls } = recordingDb();
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, importedClip, null));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('Imported videos');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
