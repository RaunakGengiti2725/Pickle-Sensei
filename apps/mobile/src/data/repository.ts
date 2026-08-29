import {
  SHOT_TYPES,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { LocalDb } from './db';
import { assertCapturedClip, type CapturedClip } from '../camera/capture';
import { getActiveDataOwner, requireWritableDataOwner } from './accountScope';

/**
 * Local repository: every analysis persists offline first; the outbox syncs
 * to the API when a connection exists (directive §32). Pure over LocalDb so
 * Jest tests use a fake driver.
 */

export interface LocalShotRow {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  confidence: number;
  resultKind: string;
  source: string;
  favorite: boolean;
}

export interface RealAnalysisFact {
  id: string;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  confidence: number;
  resultKind: ShotAnalysis['resultKind'];
  scoringModelVersion: string;
  shotConfigVersion: string;
}

export interface PendingCapture {
  id: string;
  shotType: string;
  /**
   * The user's own statement of what they were practicing. Deliberately
   * separate from `clip.recognition` (a model's prediction with provenance);
   * null means the user declined to declare.
   */
  declaredStroke: ShotTypeSlug | null;
  uri: string;
  capturedAtIso: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  /** Full native result when this app version recorded valid provenance. */
  clip: CapturedClip | null;
  evidenceStatus: 'valid' | 'legacy' | 'corrupt' | 'metadata_mismatch';
}

export interface CaptureHistoryEntry extends PendingCapture {
  /** Durable processing state from local_capture; neither state implies a score. */
  status: 'awaiting_model' | 'analyzed';
}

async function inTransaction(
  db: LocalDb,
  operation: () => Promise<void>,
): Promise<void> {
  await db.execute('BEGIN IMMEDIATE');
  try {
    await operation();
    await db.execute('COMMIT');
  } catch (error) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

export async function saveAnalysis(
  db: LocalDb,
  analysis: ShotAnalysis,
  analysisPermitId: string,
): Promise<void> {
  if (analysis.source !== 'real') {
    throw new Error('Only real analyses may be persisted by the app runtime.');
  }
  if (!analysisPermitId.trim()) {
    throw new Error(
      'A server-reserved analysis permit is required before persisting a rating.',
    );
  }
  const owner = requireWritableDataOwner();
  await inTransaction(db, async () => {
    await db.execute(
      `INSERT OR REPLACE INTO local_shot
       (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        owner,
        analysis.id,
        analysis.sessionId,
        analysis.shotType,
        analysis.capturedAtIso,
        analysis.overallScore,
        analysis.analysisConfidence,
        analysis.resultKind,
        analysis.source,
        JSON.stringify(analysis),
      ],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload)
       VALUES (?, 'shot.sync', ?)`,
      [owner, JSON.stringify({ ...analysis, analysisPermitId })],
    );
  });
}

/**
 * Persists a low-confidence (unscored) analysis for local display only. It
 * never enters the sync outbox: abstentions are not ratings, consume no
 * permit, and must not masquerade as scored shots anywhere downstream.
 */
export async function saveLocalOnlyAnalysis(
  db: LocalDb,
  analysis: ShotAnalysis,
): Promise<void> {
  if (analysis.source !== 'real') {
    throw new Error('Only real analyses may be persisted by the app runtime.');
  }
  if (analysis.resultKind === 'scored') {
    throw new Error(
      'Scored analyses must be persisted with their analysis permit via saveAnalysis.',
    );
  }
  const owner = requireWritableDataOwner();
  await db.execute(
    `INSERT OR REPLACE INTO local_shot
     (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      owner,
      analysis.id,
      analysis.sessionId,
      analysis.shotType,
      analysis.capturedAtIso,
      analysis.overallScore,
      analysis.analysisConfidence,
      analysis.resultKind,
      analysis.source,
      JSON.stringify(analysis),
    ],
  );
}

export async function listShots(
  db: LocalDb,
  limit = 50,
): Promise<LocalShotRow[]> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite
     FROM local_shot
     WHERE owner_key = ? AND source = 'real'
     ORDER BY captured_at DESC LIMIT ?`,
    [owner, limit],
  );
  return rows.map(r => ({
    id: String(r['id']),
    sessionId: r['session_id'] ? String(r['session_id']) : null,
    shotType: String(r['shot_type']),
    capturedAt: String(r['captured_at']),
    overallScore:
      r['overall_score'] === null ? null : Number(r['overall_score']),
    confidence: Number(r['confidence']),
    resultKind: String(r['result_kind']),
    source: String(r['source']),
    favorite: Boolean(r['favorite']),
  }));
}

export async function getAnalysis(
  db: LocalDb,
  id: string,
): Promise<ShotAnalysis | null> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT payload FROM local_shot
     WHERE owner_key = ? AND id = ? AND source = 'real'`,
    [owner, id],
  );
  const payload = rows[0]?.['payload'];
  return payload ? (JSON.parse(String(payload)) as ShotAnalysis) : null;
}

export async function recentScores(
  db: LocalDb,
  shotType: string | null,
  limit = 30,
): Promise<number[]> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT overall_score FROM local_shot
     WHERE owner_key = ? AND source = 'real' AND result_kind = 'scored'
       AND (? IS NULL OR shot_type = ?)
     ORDER BY captured_at DESC LIMIT ?`,
    [owner, shotType, shotType, limit],
  );
  return rows
    .map(r => (r['overall_score'] === null ? null : Number(r['overall_score'])))
    .filter((v): v is number => v !== null)
    .reverse();
}

/**
 * Minimal evidence rows used by the performance UI. Payload provenance is
 * checked again after the SQL boundary so malformed historical rows cannot
 * become metrics.
 */
export async function listRealAnalysisFacts(
  db: LocalDb,
  limit: number | null = 1000,
): Promise<RealAnalysisFact[]> {
  const owner = getActiveDataOwner();
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('Analysis fact limit must be a positive integer.');
  }
  const { rows } = await db.execute(
    `SELECT payload FROM local_shot
     WHERE owner_key = ? AND source = 'real'
     ORDER BY captured_at DESC${limit === null ? '' : ' LIMIT ?'}`,
    limit === null ? [owner] : [owner, limit],
  );
  const facts: RealAnalysisFact[] = [];
  for (const row of rows) {
    try {
      const analysis = JSON.parse(String(row['payload'])) as ShotAnalysis;
      if (analysis.source !== 'real') continue;
      facts.push({
        id: analysis.id,
        shotType: analysis.shotType,
        capturedAt: analysis.capturedAtIso,
        overallScore: analysis.overallScore,
        confidence: analysis.analysisConfidence,
        resultKind: analysis.resultKind,
        scoringModelVersion: analysis.versionVector.scoringModelVersion,
        shotConfigVersion: analysis.versionVector.shotConfigVersion,
      });
    } catch {
      // Corrupt local payloads are excluded rather than guessed or coerced.
    }
  }
  return facts;
}

export async function savePendingCapture(
  db: LocalDb,
  id: string,
  shotType: string,
  clip: CapturedClip,
  declaredStroke: ShotTypeSlug | null = null,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await db.execute(
    `INSERT INTO local_capture
      (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_model', ?)`,
    [
      owner,
      id,
      clip.uri,
      shotType,
      declaredStroke,
      clip.capturedAtIso,
      clip.durationMs,
      clip.fps,
      clip.width,
      clip.height,
      JSON.stringify(clip),
    ],
  );
}

export async function getPendingCapture(
  db: LocalDb,
  id: string,
): Promise<PendingCapture | null> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, payload
     FROM local_capture WHERE owner_key = ? AND id = ?`,
    [owner, id],
  );
  const row = rows[0];
  return row ? parseCaptureRow(row) : null;
}

/**
 * Appends an immutable, versioned analysis record for a capture. A capture
 * accumulates one record per (engine, model set) that ever processed it;
 * reprocessing with a future model adds a row and never touches old ones.
 */
export async function saveAnalysisRecord(
  db: LocalDb,
  record: AnalysisRecord,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await db.execute(
    `INSERT INTO local_analysis_record
      (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      owner,
      record.id,
      record.captureId,
      record.createdAtIso,
      record.engineVersion,
      record.result?.versionVector.scoringModelVersion ?? 'abstained',
      JSON.stringify(record),
    ],
  );
}

export async function listAnalysisRecords(
  db: LocalDb,
  captureId: string,
): Promise<AnalysisRecord[]> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT record FROM local_analysis_record
     WHERE owner_key = ? AND capture_id = ?
     ORDER BY created_at ASC, id ASC`,
    [owner, captureId],
  );
  const records: AnalysisRecord[] = [];
  for (const row of rows) {
    try {
      records.push(JSON.parse(String(row['record'])) as AnalysisRecord);
    } catch {
      // A corrupt record row is skipped, never repaired into a fake analysis.
    }
  }
  return records;
}

/**
 * Records the user's declared stroke for a capture. Declaration is user
 * input and may be set or corrected any time before analysis; it never
 * overwrites the model's prediction, which lives in the clip payload.
 */
export async function setDeclaredStroke(
  db: LocalDb,
  captureId: string,
  declaredStroke: ShotTypeSlug,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await db.execute(
    `UPDATE local_capture SET declared_stroke = ?
     WHERE owner_key = ? AND id = ?`,
    [declaredStroke, owner, captureId],
  );
}

/**
 * Target selection ("tap yourself") is the user's identity seed for a
 * capture. It is stored on the capture row so an imported clip's tap
 * survives app restarts and stays available to any later analysis pass,
 * instead of living only in transient screen state.
 */
export interface CaptureTargetSeed {
  point: { x: number; y: number };
  selectedAtIso: string;
}

function isCaptureTargetSeed(value: unknown): value is CaptureTargetSeed {
  if (typeof value !== 'object' || value === null) return false;
  const seed = value as {
    point?: { x?: unknown; y?: unknown };
    selectedAtIso?: unknown;
  };
  return (
    typeof seed.point === 'object' &&
    seed.point !== null &&
    typeof seed.point.x === 'number' &&
    Number.isFinite(seed.point.x) &&
    typeof seed.point.y === 'number' &&
    Number.isFinite(seed.point.y) &&
    typeof seed.selectedAtIso === 'string'
  );
}

export async function setCaptureTargetSeed(
  db: LocalDb,
  captureId: string,
  seed: CaptureTargetSeed,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await db.execute(
    `UPDATE local_capture SET target_seed = ?
     WHERE owner_key = ? AND id = ?`,
    [JSON.stringify(seed), owner, captureId],
  );
}

export async function getCaptureTargetSeed(
  db: LocalDb,
  captureId: string,
): Promise<CaptureTargetSeed | null> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT target_seed FROM local_capture
     WHERE owner_key = ? AND id = ?`,
    [owner, captureId],
  );
  const raw = rows[0]?.['target_seed'];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCaptureTargetSeed(parsed) ? parsed : null;
  } catch {
    // A corrupt seed row reads as absent, never as a reconstructed tap.
    return null;
  }
}

export async function markCaptureAnalyzed(
  db: LocalDb,
  captureId: string,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await db.execute(
    `UPDATE local_capture SET status = 'analyzed'
     WHERE owner_key = ? AND id = ?`,
    [owner, captureId],
  );
}

export async function listPendingCaptures(
  db: LocalDb,
  limit: number | null = 100,
): Promise<PendingCapture[]> {
  const owner = getActiveDataOwner();
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('Pending capture limit must be a positive integer.');
  }
  const { rows } = await db.execute(
    `SELECT id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, payload
     FROM local_capture
     WHERE owner_key = ? AND status = 'awaiting_model'
     ORDER BY captured_at DESC${limit === null ? '' : ' LIMIT ?'}`,
    limit === null ? [owner] : [owner, limit],
  );
  return rows.map(parseCaptureRow);
}

/**
 * Complete durable capture history for practice metrics. Unlike the pending
 * queue, analyzed rows remain visible here; processing state never substitutes
 * for evidence validation or a technique score.
 */
export async function listCaptureHistory(
  db: LocalDb,
  limit: number | null = null,
): Promise<CaptureHistoryEntry[]> {
  const owner = getActiveDataOwner();
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('Capture history limit must be a positive integer.');
  }
  const { rows } = await db.execute(
    `SELECT id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload
     FROM local_capture
     WHERE owner_key = ? AND status IN ('awaiting_model', 'analyzed')
     ORDER BY captured_at DESC${limit === null ? '' : ' LIMIT ?'}`,
    limit === null ? [owner] : [owner, limit],
  );
  const entries: CaptureHistoryEntry[] = [];
  for (const row of rows) {
    const status = row['status'];
    if (status !== 'awaiting_model' && status !== 'analyzed') continue;
    entries.push({ ...parseCaptureRow(row), status });
  }
  return entries;
}

function parseCaptureRow(row: Record<string, unknown>): PendingCapture {
  const uri = String(row['uri']);
  const capturedAtIso = String(row['captured_at']);
  const durationMs = Number(row['duration_ms']);
  const fps = Number(row['fps']);
  const width = Number(row['width']);
  const height = Number(row['height']);
  let clip: CapturedClip | null = null;
  let evidenceStatus: PendingCapture['evidenceStatus'] =
    row['payload'] === null ? 'legacy' : 'corrupt';
  if (typeof row['payload'] === 'string' && row['payload'].length > 0) {
    try {
      const parsed = assertCapturedClip(JSON.parse(row['payload']));
      const metadataMatches =
        parsed.uri === uri &&
        parsed.capturedAtIso === capturedAtIso &&
        parsed.durationMs === durationMs &&
        parsed.fps === fps &&
        parsed.width === width &&
        parsed.height === height;
      if (metadataMatches) {
        clip = parsed;
        evidenceStatus = 'valid';
      } else {
        evidenceStatus = 'metadata_mismatch';
      }
    } catch {
      // A malformed payload is never trusted or repaired from adjacent
      // columns. It remains distinct from a row created before evidence was
      // recorded so the UI cannot disguise corruption as legacy data.
      evidenceStatus = 'corrupt';
    }
  }
  const declaredRaw = row['declared_stroke'];
  const declaredStroke =
    typeof declaredRaw === 'string' &&
    (SHOT_TYPES as readonly string[]).includes(declaredRaw)
      ? (declaredRaw as ShotTypeSlug)
      : null;
  return {
    id: String(row['id']),
    uri,
    shotType: String(row['shot_type']),
    declaredStroke,
    capturedAtIso,
    durationMs,
    fps,
    width,
    height,
    clip,
    evidenceStatus,
  };
}

export async function saveSession(
  db: LocalDb,
  session: {
    id: string;
    mode: string;
    shotType: string | null;
    focusCheckpoint: string | null;
    startedAt: string;
  },
): Promise<void> {
  const owner = requireWritableDataOwner();
  await inTransaction(db, async () => {
    await db.execute(
      `INSERT OR REPLACE INTO local_session
       (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        owner,
        session.id,
        session.mode,
        session.shotType,
        session.focusCheckpoint,
        session.startedAt,
      ],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload)
       VALUES (?, 'session.create', ?)`,
      [owner, JSON.stringify(session)],
    );
  });
}

export async function finishSession(
  db: LocalDb,
  id: string,
  summary: Record<string, unknown>,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await inTransaction(db, async () => {
    await db.execute(
      `UPDATE local_session
       SET ended_at = datetime('now'), completed = 1, summary = ?
       WHERE owner_key = ? AND id = ?`,
      [JSON.stringify(summary), owner, id],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload)
       VALUES (?, 'session.finalize', ?)`,
      [owner, JSON.stringify({ id })],
    );
  });
}

export async function hasShotSyncReceipt(
  db: LocalDb,
  shotId: string,
): Promise<boolean> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT 1 FROM sync_receipt
     WHERE owner_key = ? AND kind = 'shot.sync' AND entity_id = ?
     LIMIT 1`,
    [owner, shotId],
  );
  return rows.length > 0;
}

export async function getKv(db: LocalDb, key: string): Promise<string | null> {
  const { rows } = await db.execute(`SELECT value FROM kv WHERE key = ?`, [
    key,
  ]);
  return rows[0]?.['value'] ? String(rows[0]['value']) : null;
}

export async function setKv(
  db: LocalDb,
  key: string,
  value: string,
): Promise<void> {
  await db.execute(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, [
    key,
    value,
  ]);
}
