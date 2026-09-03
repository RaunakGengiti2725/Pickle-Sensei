import type { CapturedClip } from '../src/camera/capture';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';
import {
  listCaptureHistory,
  listPendingCaptures,
  savePendingCapture,
  updateCaptureClipPayload,
} from '../src/data/repository';

const owner = '11111111-1111-4111-8111-111111111111';

const clip: CapturedClip = {
  uri: 'file:///private/captures/real.mov',
  durationMs: 3900,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger: {
    startMs: 1800,
    endMs: 2450,
    peakMotionMs: 2220,
    confidence: 0.84,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-2',
  },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'mediapipe_pose_landmarker',
    poseModelVersion: 'mediapipe-pose-landmarker-full-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 8,
    poseFrameCount: 7,
    poseMissingFrameCount: 1,
    trackedDurationMs: 600,
    meanCanonicalJointVisibility: 0.86,
    meanJointCoverage: 0.93,
    minimumJointCoverage: 0.83,
    fullBodyVisibleFrameCount: 5,
    jointMotion: [
      {
        joint: 'left_wrist',
        sampleCount: 6,
        meanNormalizedPerSecond: 1.2,
        peakNormalizedPerSecond: 2.1,
      },
    ],
  },
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 1800,
  postRollMs: 1450,
};

describe('durable pending capture evidence', () => {
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('stores the complete validated native payload with the owner-scoped row', async () => {
    setActiveDataOwner(owner);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        calls.push({ sql, params });
        return { rows: [] };
      },
      close() {},
    };

    await savePendingCapture(db, 'capture-1', 'unrecognized', clip);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params[0]).toBe(owner);
    expect(calls[0]?.sql).toContain('payload');
    expect(JSON.parse(String(calls[0]?.params.at(-1)))).toEqual(clip);
  });

  it('persists measured pose evidence added after the save (imported-video extraction) onto the same owner-scoped row', async () => {
    // Without this write an import's exoskeleton lived only for the run that
    // measured it: the Form Review reopened later read the pre-extraction
    // payload and drew nothing.
    setActiveDataOwner(owner);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        calls.push({ sql, params });
        return { rows: [] };
      },
      close() {},
    };
    const enriched: CapturedClip = {
      ...clip,
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: 'file:///private/captures/real.pose.json',
        frameCount: 120,
        sha256: 'a'.repeat(64),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-body-pose-1',
      },
    };

    await updateCaptureClipPayload(db, 'capture-1', enriched);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/UPDATE local_capture SET payload/);
    expect(calls[0]?.params).toEqual([
      JSON.stringify(enriched),
      owner,
      'capture-1',
    ]);
    expect(JSON.parse(String(calls[0]?.params[0])).poseSequence).toBeDefined();
  });

  it('returns the complete payload only when its metadata still matches the row', async () => {
    setActiveDataOwner(owner);
    const row = {
      id: 'capture-1',
      uri: clip.uri,
      shot_type: 'unrecognized',
      captured_at: clip.capturedAtIso,
      duration_ms: clip.durationMs,
      fps: clip.fps,
      width: clip.width,
      height: clip.height,
      payload: JSON.stringify(clip),
    };
    const db: LocalDb = {
      async execute() {
        return { rows: [row] };
      },
      close() {},
    };

    const [pending] = await listPendingCaptures(db);
    expect(pending?.clip).toEqual(clip);
    expect(pending?.evidenceStatus).toBe('valid');
    expect(pending?.clip?.captureMode).toBe('automatic_pose_trigger');
  });

  it('distinguishes legacy, corrupt, and mismatched rows without reconstructing evidence', async () => {
    setActiveDataOwner(owner);
    const baseRow = {
      id: 'capture-legacy',
      uri: clip.uri,
      shot_type: 'unrecognized',
      captured_at: clip.capturedAtIso,
      duration_ms: clip.durationMs,
      fps: clip.fps,
      width: clip.width,
      height: clip.height,
    };
    const db: LocalDb = {
      async execute() {
        return {
          rows: [
            { ...baseRow, payload: null },
            {
              ...baseRow,
              id: 'capture-corrupt',
              payload: '{not-json',
            },
            {
              ...baseRow,
              id: 'capture-mismatch',
              uri: 'file:///private/captures/other.mov',
              payload: JSON.stringify(clip),
            },
          ],
        };
      },
      close() {},
    };

    const pending = await listPendingCaptures(db);
    expect(pending.map(item => item.clip)).toEqual([null, null, null]);
    expect(pending.map(item => item.evidenceStatus)).toEqual([
      'legacy',
      'corrupt',
      'metadata_mismatch',
    ]);
  });

  it('keeps analyzed captures in uncapped durable history', async () => {
    setActiveDataOwner(owner);
    const analyzedClip: CapturedClip = {
      ...clip,
      uri: 'file:///private/captures/analyzed.mov',
      capturedAtIso: '2026-08-26T18:00:00.000Z',
    };
    let observedSql = '';
    let observedParams: unknown[] = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        observedSql = sql;
        observedParams = params;
        return {
          rows: [
            {
              id: 'capture-1',
              uri: clip.uri,
              shot_type: 'unrecognized',
              captured_at: clip.capturedAtIso,
              duration_ms: clip.durationMs,
              fps: clip.fps,
              width: clip.width,
              height: clip.height,
              status: 'awaiting_model',
              payload: JSON.stringify(clip),
            },
            {
              id: 'capture-2',
              uri: analyzedClip.uri,
              shot_type: 'unrecognized',
              captured_at: analyzedClip.capturedAtIso,
              duration_ms: analyzedClip.durationMs,
              fps: analyzedClip.fps,
              width: analyzedClip.width,
              height: analyzedClip.height,
              status: 'analyzed',
              payload: JSON.stringify(analyzedClip),
            },
          ],
        };
      },
      close() {},
    };

    const history = await listCaptureHistory(db);

    expect(observedSql).toContain("status IN ('awaiting_model', 'analyzed')");
    expect(observedSql).not.toContain(' LIMIT ?');
    expect(observedParams).toEqual([owner]);
    expect(history.map(item => item.status)).toEqual([
      'awaiting_model',
      'analyzed',
    ]);
    expect(history.every(item => item.evidenceStatus === 'valid')).toBe(true);
  });
});
