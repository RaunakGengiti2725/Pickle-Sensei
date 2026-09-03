import type { LocalDb } from '../src/data/db';
import {
  loadAnalysisRecordById,
  loadStrokeResultEvidence,
} from '../src/components/strokeResultData';

/**
 * W8 — Result-route evidence loading. The three real stores (local_shot,
 * local_analysis_record, local_capture) are read honestly: corrupt rows are
 * skipped (never repaired), records without a strokeIntent envelope stay
 * consumable, and a result-null record still yields an openable abstention
 * surface.
 */

const RECORD = {
  id: 'analysis-1',
  captureId: 'capture-1',
  createdAtIso: '2026-08-30T10:00:30.000Z',
  strokeIntent: {
    declaredStroke: null,
    predictedStroke: null,
    resolutionBasis: 'abstained',
    resolvedProfileId: null,
    resolvedProfileVersion: null,
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0,
    presentation: 'abstain',
    limitingFactors: ['single_modality_pose_only'],
  },
};

function fakeDb(byTable: {
  record?: string | null;
  shotPayload?: string | null;
  capture?: Record<string, unknown> | null;
}): LocalDb {
  return {
    async execute(sql: string) {
      if (sql.includes('FROM local_analysis_record')) {
        return {
          rows:
            byTable.record === null || byTable.record === undefined
              ? []
              : [{ record: byTable.record }],
        };
      }
      if (sql.includes('FROM local_shot')) {
        return {
          rows:
            byTable.shotPayload === null || byTable.shotPayload === undefined
              ? []
              : [{ payload: byTable.shotPayload }],
        };
      }
      if (sql.includes('FROM local_capture')) {
        return { rows: byTable.capture ? [byTable.capture] : [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}

const CAPTURE_ROW = {
  id: 'capture-1',
  uri: 'file:///private/clip.mov',
  shot_type: 'unrecognized',
  declared_stroke: null,
  captured_at: '2026-08-30T10:00:00.000Z',
  duration_ms: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  payload: null,
};

describe('loadAnalysisRecordById', () => {
  it('parses the stored record including the strokeIntent envelope', async () => {
    const record = await loadAnalysisRecordById(
      fakeDb({ record: JSON.stringify(RECORD) }),
      'analysis-1',
    );
    expect(record?.strokeIntent?.resolutionBasis).toBe('abstained');
    expect(record?.result).toBeNull();
  });

  it('skips a corrupt row instead of repairing it', async () => {
    const record = await loadAnalysisRecordById(
      fakeDb({ record: '{not json' }),
      'analysis-1',
    );
    expect(record).toBeNull();
  });

  it('returns null when no record row exists (legacy rating-only rows)', async () => {
    const record = await loadAnalysisRecordById(fakeDb({}), 'analysis-1');
    expect(record).toBeNull();
  });
});

describe('loadStrokeResultEvidence', () => {
  it('a result-null record still yields an openable abstention surface with its real clip', async () => {
    const evidence = await loadStrokeResultEvidence(
      fakeDb({ record: JSON.stringify(RECORD), capture: CAPTURE_ROW }),
      'analysis-1',
    );
    expect(evidence.analysis).toBeNull();
    expect(evidence.record?.strokeIntent?.resolutionBasis).toBe('abstained');
    expect(evidence.clip).toEqual({
      uri: 'file:///private/clip.mov',
      durationMs: 4200,
    });
    // Legacy capture row (no payload): the frame size is real, the pose
    // sidecar honestly absent.
    expect(evidence.review).toEqual({
      width: 720,
      height: 1280,
      poseSequence: null,
    });
  });

  it('carries the pose sidecar ref from the capture payload for the form review', async () => {
    const poseSequence = {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/clip.pose.json',
      frameCount: 126,
      sha256: 'ab'.repeat(32),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    };
    const evidence = await loadStrokeResultEvidence(
      fakeDb({
        record: JSON.stringify(RECORD),
        capture: {
          ...CAPTURE_ROW,
          payload: JSON.stringify({
            uri: 'file:///private/clip.mov',
            durationMs: 4200,
            fps: 59.94,
            width: 720,
            height: 1280,
            capturedAtIso: '2026-08-30T10:00:00.000Z',
            captureMode: 'imported_video',
            recognition: { status: 'unknown', reason: 'analysis_not_run' },
            ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
            posterUri: 'file:///private/clip.poster.jpg',
            poseSequence,
          }),
        },
      }),
      'analysis-1',
    );
    expect(evidence.clip).toEqual({
      uri: 'file:///private/clip.mov',
      durationMs: 4200,
      posterUri: 'file:///private/clip.poster.jpg',
    });
    expect(evidence.review).toEqual({
      width: 720,
      height: 1280,
      poseSequence,
    });
  });

  it('a session-less analysis yields a solo attempt list (no invented grouping)', async () => {
    const analysis = {
      id: 'analysis-1',
      sessionId: null,
      shotType: 'forehand_drive',
      capturedAtIso: '2026-08-30T10:00:00.000Z',
      source: 'real',
    };
    const evidence = await loadStrokeResultEvidence(
      fakeDb({
        record: JSON.stringify({ ...RECORD, result: analysis }),
        shotPayload: JSON.stringify(analysis),
        capture: CAPTURE_ROW,
      }),
      'analysis-1',
    );
    expect(evidence.attempts).toEqual([
      {
        analysisId: 'analysis-1',
        capturedAtIso: '2026-08-30T10:00:00.000Z',
        sessionId: null,
      },
    ]);
  });

  it('returns all-null evidence when nothing is stored', async () => {
    const evidence = await loadStrokeResultEvidence(fakeDb({}), 'missing');
    expect(evidence).toEqual({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
  });
});
