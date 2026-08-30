import type { ShotAnalysis } from '@pickle/shared-types';
import { getActiveDataOwner } from '../data/accountScope';
import type { LocalDb } from '../data/db';
import { getAnalysis, getPendingCapture, listShots } from '../data/repository';
import type { StrokeResultClip } from './StrokeResult';
import type {
  AttemptRef,
  StrokeResultEvidenceRecord,
} from './strokeResultModel';

/**
 * Evidence loading for the canonical Stroke Result surface.
 *
 * The Result route receives only an analysisId. Three real stores can hold
 * evidence for it, each read honestly and none repaired:
 *  - local_shot          → the product-shape ShotAnalysis (may be absent for
 *                          result-null records: family reads / abstentions);
 *  - local_analysis_record → the immutable full record (strokeIntent
 *                          envelope, uncertainty, and — when a future engine
 *                          writes them — contact / temporalPhasesV2);
 *  - local_capture       → the real captured clip file for replay.
 *
 * The record row is looked up by its own id (analysisId IS the record id for
 * every runCaptureAnalysis outcome). Reading it here — owner-scoped exactly
 * like data/repository.ts — instead of adding a repository function keeps
 * this workstream inside its allowed file set.
 */

export interface StrokeResultEvidence {
  analysis: ShotAnalysis | null;
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
  attempts: AttemptRef[];
}

export async function loadAnalysisRecordById(
  db: LocalDb,
  analysisId: string,
): Promise<StrokeResultEvidenceRecord | null> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT record FROM local_analysis_record
     WHERE owner_key = ? AND id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [owner, analysisId],
  );
  const payload = rows[0]?.['record'];
  if (typeof payload !== 'string' || payload.length === 0) return null;
  try {
    // Stored records are heterogeneous (pre-strokeIntent rows exist); the
    // evidence shape types every envelope field as optional, and a corrupt
    // row is skipped — never repaired into a fake analysis.
    return JSON.parse(payload) as StrokeResultEvidenceRecord;
  } catch {
    return null;
  }
}

/** This session's attempts (for §2 chips). Grouping NEVER crosses sessions:
 * a null sessionId yields only the current attempt and no chips render. */
export async function loadSessionAttempts(
  db: LocalDb,
  analysis: ShotAnalysis | null,
): Promise<AttemptRef[]> {
  if (!analysis) return [];
  if (analysis.sessionId === null) {
    return [
      {
        analysisId: analysis.id,
        capturedAtIso: analysis.capturedAtIso,
        sessionId: null,
      },
    ];
  }
  const shots = await listShots(db, 200);
  return shots
    .filter(shot => shot.sessionId === analysis.sessionId)
    .map(shot => ({
      analysisId: shot.id,
      capturedAtIso: shot.capturedAt,
      sessionId: shot.sessionId,
    }));
}

export async function loadStrokeResultEvidence(
  db: LocalDb,
  analysisId: string,
): Promise<StrokeResultEvidence> {
  const [analysis, record] = await Promise.all([
    getAnalysis(db, analysisId).catch(() => null),
    loadAnalysisRecordById(db, analysisId).catch(() => null),
  ]);

  let clip: StrokeResultClip | null = null;
  if (record?.captureId) {
    const capture = await getPendingCapture(db, record.captureId).catch(
      () => null,
    );
    if (capture && capture.durationMs > 0) {
      const posterUri = capture.clip?.posterUri;
      clip = {
        uri: capture.uri,
        durationMs: capture.durationMs,
        ...(posterUri !== undefined ? { posterUri } : {}),
      };
    }
  }

  const attempts = await loadSessionAttempts(db, analysis).catch(() => []);
  return { analysis, record, clip, attempts };
}
