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

  it.each(['5', '[]', '"text"', 'true', 'null', '[{"result":null}]', '{}'])(
    'skips a row whose JSON is not a record object (%s)',
    async payload => {
      await expect(
        loadAnalysisRecordById(fakeDb({ record: payload }), 'analysis-1'),
      ).resolves.toBeNull();
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['id is not a string', { id: 1 }],
    ['captureId is not a string', { id: 'x', captureId: 123 }],
    ['strokeIntent is a number', { id: 'x', strokeIntent: 7 }],
    [
      'strokeIntent without a resolutionBasis',
      { id: 'x', strokeIntent: { declaredStroke: null } },
    ],
    [
      'predicted_l3 with an empty predictedStroke',
      {
        id: 'x',
        strokeIntent: { resolutionBasis: 'predicted_l3', predictedStroke: {} },
      },
    ],
    [
      'declared basis with a numeric declaredStroke',
      {
        id: 'x',
        strokeIntent: { resolutionBasis: 'declared', declaredStroke: 42 },
      },
    ],
    [
      'disagreement without a declared slug',
      {
        id: 'x',
        strokeIntent: {
          resolutionBasis: 'declared',
          declaredStroke: 'forehand_drive',
          disagreement: { predictedLabel: 'BACKHAND' },
        },
      },
    ],
    ['result is an array', { id: 'x', result: [] }],
    [
      'result without timestamps',
      { id: 'x', result: { shotType: 'forehand_drive' } },
    ],
    [
      'result with a non-numeric stroke window',
      {
        id: 'x',
        result: {
          shotType: 'forehand_drive',
          timestamps: { startMs: '0', contactMs: null, endMs: 900 },
        },
      },
    ],
    [
      'result measurements with a non-numeric value',
      {
        id: 'x',
        result: {
          shotType: 'forehand_drive',
          timestamps: { startMs: 0, contactMs: null, endMs: 900 },
          measurements: [{ metricKey: 'k', value: 'fast', unit: 'ms' }],
        },
      },
    ],
    [
      'result guidance is not text',
      {
        id: 'x',
        result: {
          shotType: 'forehand_drive',
          timestamps: { startMs: 0, contactMs: null, endMs: 900 },
          guidance: { text: 'nope' },
        },
      },
    ],
    ['contact is a string', { id: 'x', contact: 'nope' }],
    [
      'contact with an unknown status',
      { id: 'x', contact: { status: 'maybe' } },
    ],
    [
      'abstained contact without a reason',
      { id: 'x', contact: { status: 'abstained' } },
    ],
    [
      'temporalPhasesV2 with no status',
      { id: 'x', temporalPhasesV2: { kind: 'segments', segments: 'nope' } },
    ],
    [
      'segmented temporalPhasesV2 without boundaries',
      { id: 'x', temporalPhasesV2: { status: 'segmented' } },
    ],
    [
      'segmented temporalPhasesV2 with a non-numeric boundary',
      {
        id: 'x',
        temporalPhasesV2: {
          status: 'segmented',
          boundaries: {
            version: 'v2',
            source: 'wrist',
            anchor: 'speed_peak',
            confidence: 0.5,
            preparationStartMs: null,
            accelerationStartMs: 'soon',
            contactMs: null,
            followThroughEndMs: 900,
            recoveryEndMs: null,
          },
        },
      },
    ],
    [
      'uncertainty limitingFactors is a number',
      { id: 'x', uncertainty: { presentation: '???', limitingFactors: 5 } },
    ],
    [
      'uncertainty limitingFactors holds a non-string',
      { id: 'x', uncertainty: { limitingFactors: ['ok', 5] } },
    ],
    ['captureEnvelope is a string', { id: 'x', captureEnvelope: 'DEGRADED' }],
    [
      'captureEnvelope without an overall verdict',
      { id: 'x', captureEnvelope: { thresholdsVersion: 'v1' } },
    ],
  ])(
    'skips a row whose envelope field has the wrong type (%s)',
    async (_label, row) => {
      await expect(
        loadAnalysisRecordById(
          fakeDb({ record: JSON.stringify(row) }),
          'analysis-1',
        ),
      ).resolves.toBeNull();
    },
  );

  it('a pre-strokeIntent row (id + result only) still loads unchanged', async () => {
    const legacy = {
      id: 'analysis-1',
      captureId: 'capture-1',
      createdAtIso: '2026-08-01T10:00:00.000Z',
      engineVersion: 'on-device-fusion-1',
      result: {
        id: 'analysis-1',
        sessionId: null,
        shotType: 'forehand_drive',
        capturedAtIso: '2026-08-01T10:00:00.000Z',
        timestamps: { startMs: 100, contactMs: 480, endMs: 900 },
        phases: [],
        measurements: [],
        checkpoints: [],
        overallScore: null,
        analysisConfidence: 0.4,
        resultKind: 'low_confidence',
        guidance: 'Move the camera back.',
        priorityFix: null,
        source: 'real',
      },
    };
    await expect(
      loadAnalysisRecordById(
        fakeDb({ record: JSON.stringify(legacy) }),
        'analysis-1',
      ),
    ).resolves.toEqual(legacy);
  });

  it('a well-typed record with every envelope field loads unchanged', async () => {
    const full = {
      ...RECORD,
      contact: {
        status: 'estimated',
        estimatedContactMs: 480,
        confidence: 0.7,
        ballConfirmed: false,
        paddleConfirmed: false,
        limitingFactors: [],
        supportingEvidence: [],
      },
      temporalPhasesV2: {
        status: 'segmented',
        boundaries: {
          version: 'v2',
          source: 'wrist',
          anchor: 'speed_peak',
          anchorBasis: 'event_peak',
          confidence: 0.6,
          preparationStartMs: 100,
          accelerationStartMs: 300,
          contactMs: null,
          motionPeakMs: 480,
          followThroughEndMs: 900,
          recoveryEndMs: 1200,
        },
      },
      captureEnvelope: {
        thresholdsVersion: 'v1',
        provisional: true,
        dimensions: [],
        overall: 'DEGRADED',
        overallWithCoverage: 'DEGRADED',
        notMeasured: [],
      },
    };
    await expect(
      loadAnalysisRecordById(
        fakeDb({ record: JSON.stringify(full) }),
        'analysis-1',
      ),
    ).resolves.toEqual(full);
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
