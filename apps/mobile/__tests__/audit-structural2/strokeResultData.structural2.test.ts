import type { LocalDb } from '../../src/data/db';
import { loadStrokeResultEvidence } from '../../src/components/strokeResultData';
import { replayStageCaption } from '../../src/review/FormReviewPlayer';

/**
 * Structural audit #2 (mobile-results-review) — evidence-loading edge the
 * architecture map flags: a capture with `durationMs <= 0` yields
 * `clip = null` while `review.poseSequence` might still exist (pose-only
 * replay from a broken row). These probes pin what the data layer actually
 * hands the Result / Form Review for such rows.
 */

const RECORD = {
  id: 'analysis-1',
  captureId: 'capture-1',
  createdAtIso: '2026-08-30T10:00:30.000Z',
  strokeIntent: {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: null,
};

const POSE_SEQUENCE = {
  schemaVersion: 1,
  format: 'pickle.pose-sequence.v1',
  uri: 'file:///private/clip.pose.json',
  frameCount: 126,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left',
  poseModelVersion: 'apple-vision-bodypose-1',
};

function capturePayload(durationMs: number): string {
  return JSON.stringify({
    uri: 'file:///private/clip.mov',
    durationMs,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    posterUri: 'file:///private/clip.poster.jpg',
    poseSequence: POSE_SEQUENCE,
  });
}

function fakeDb(capture: Record<string, unknown> | null): LocalDb {
  return {
    async execute(sql: string) {
      if (sql.includes('FROM local_analysis_record')) {
        return { rows: [{ record: JSON.stringify(RECORD) }] };
      }
      if (sql.includes('FROM local_capture')) {
        return { rows: capture ? [capture] : [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}

const ROW = {
  id: 'capture-1',
  uri: 'file:///private/clip.mov',
  shot_type: 'forehand_drive',
  declared_stroke: 'forehand_drive',
  captured_at: '2026-08-30T10:00:00.000Z',
  duration_ms: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  payload: capturePayload(4200),
};

describe('loadStrokeResultEvidence — nonpositive capture duration', () => {
  it('sanity: a valid row yields both the clip and the sidecar ref', async () => {
    const evidence = await loadStrokeResultEvidence(fakeDb(ROW), 'analysis-1');
    expect(evidence.clip?.durationMs).toBe(4200);
    expect(evidence.review?.poseSequence).toEqual(POSE_SEQUENCE);
  });

  it.each([0, -1, Number.NaN])(
    'duration_ms=%p (payload agrees): clip is null AND no pose sidecar is offered — the broken row never becomes a pose-only replay',
    async durationMs => {
      const evidence = await loadStrokeResultEvidence(
        fakeDb({
          ...ROW,
          duration_ms: durationMs,
          payload: capturePayload(durationMs),
        }),
        'analysis-1',
      );
      expect(evidence.clip).toBeNull();
      expect(evidence.review).toEqual({
        width: 720,
        height: 1280,
        poseSequence: null,
      });
      expect(replayStageCaption(evidence.clip, null)).toContain(
        'No clip file or recorded pose is stored',
      );
    },
  );

  it('duration_ms column 0 while the payload says 4200: metadata mismatch → clip null and sidecar withheld (no repair from adjacent columns)', async () => {
    const evidence = await loadStrokeResultEvidence(
      fakeDb({ ...ROW, duration_ms: 0 }),
      'analysis-1',
    );
    expect(evidence.clip).toBeNull();
    expect(evidence.review?.poseSequence).toBeNull();
  });

  it('a capture row that is missing altogether leaves review null (legacy rating rows)', async () => {
    const evidence = await loadStrokeResultEvidence(fakeDb(null), 'analysis-1');
    expect(evidence.clip).toBeNull();
    expect(evidence.review).toBeNull();
  });
});
