import {
  SHOT_TYPES,
  type CheckpointScore,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  isConfirmationTargetSelection,
  parseNeedsTechniqueConfirmationRecord,
} from '@pickle/analysis-pipeline';
import type { LocalDb } from './db';
import { assertCapturedClip, type CapturedClip } from '../camera/capture';
import {
  assertDataOwnerContext,
  getActiveDataOwner,
  requireWritableDataOwner,
  type DataOwnerContext,
} from './accountScope';
import { forDataOwner, withTransaction } from './transactions';
import { OUTBOX_MAX_ATTEMPTS, offlineOutputSha256 } from './sync';
import type { ScoredCheckpointFact } from '../library/libraryFocus';

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
  /** Practice set (sitting) the analysis was recorded in; null when none. */
  sessionId: string | null;
  /** The checkpoint the analysis named as the one thing to fix; null when
   * the analysis named none (abstentions, legacy payloads). */
  priorityCheckpoint: string | null;
  /** Applicable checkpoints with a finite 0–100 score, keyed by checkpoint.
   * Non-applicable or unobserved checkpoints are absent, never zero. */
  checkpointScores: Record<string, number>;
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
  techniqueConfirmation?: 'ready' | 'release_pending' | 'blocked';
  hasOriginalOperation?: boolean;
}

export interface CaptureHistoryEntry extends PendingCapture {
  /** Durable processing state from local_capture; neither state implies a score. */
  status: 'awaiting_model' | 'analyzed';
}

function writeOwner(db: LocalDb): string {
  if (!db.ownerContext) return requireWritableDataOwner();
  assertDataOwnerContext(db.ownerContext);
  return db.ownerContext.ownerKey;
}

async function inTransaction(
  db: LocalDb,
  operation: (transaction: LocalDb) => Promise<void>,
): Promise<void> {
  // Preserve the original persistence error.
  await withTransaction(db, operation);
}

/** Every owner-partitioned local table. Kept in one place so account
 * deletion can never silently miss a store added later. */
const OWNER_SCOPED_TABLES = [
  'analysis_execution_attempts',
  'analysis_logical_operations',
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'analysis_run_journal',
  'outbox',
  'sync_receipt',
  'offline_wallet_journal',
  'offline_receipt',
  'offline_ticket',
  'offline_grant',
] as const;

/** Every owner-scoped kv namespace (`<namespace>:<owner>`). Must stay in
 * agreement with the key builders that write them:
 *   profile           → data/accountScope.ts profileKeyForOwner
 *   rank.celebrated   → progress/rankCelebration.ts rankCelebrationKeyForOwner
 *   notifications     → notifications/types.ts notificationPrefsKeyForOwner
 *   consistency       → consistency/store.ts consistencyKeyForOwner
 *   practice.set      → analysis/practiceSet.ts practiceSetKeyForOwner
 * (pinned by repositoryAccountScope tests). */
export const OWNER_SCOPED_KV_NAMESPACES = [
  'profile',
  'rank.celebrated',
  'notifications',
  'consistency',
  'practice.set',
  'billing.pending-fulfilment',
  'analysis.release-policy',
] as const;

/**
 * Removes every locally stored row belonging to `owner` — called after the
 * server confirms account deletion, so no analysis history, outbox entry, or
 * cached profile survives on the device. Transactional: either the whole
 * owner bucket is gone or nothing changed.
 */
export async function purgeOwnerData(
  db: LocalDb,
  owner: string,
): Promise<void> {
  await inTransaction(db, async db => {
    for (const table of OWNER_SCOPED_TABLES) {
      await db.execute(`DELETE FROM ${table} WHERE owner_key = ?`, [owner]);
    }
    for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
      await db.execute(`DELETE FROM kv WHERE key = ?`, [
        `${namespace}:${owner}`,
      ]);
    }
  });
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
  const owner = writeOwner(db);
  await inTransaction(db, async db => {
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
 * Persists a scored analysis rated on the court without a live permit. The
 * local allocation the run consumed has already queued `receiptId` for this
 * exact result (offline_receipt, same owner, same result id, hash of this
 * exact payload); that receipt — not a `shot.sync` outbox row — carries the
 * output to the server, so nothing is queued here. The parent session row
 * still syncs through its own outbox entry.
 */
export async function saveOfflineAnalysis(
  db: LocalDb,
  analysis: ShotAnalysis,
  receiptId: string,
): Promise<void> {
  if (analysis.source !== 'real') {
    throw new Error('Only real analyses may be persisted by the app runtime.');
  }
  if (analysis.resultKind !== 'scored') {
    throw new Error(
      'Only a scored analysis spends an offline allocation; abstentions are persisted via saveLocalOnlyAnalysis.',
    );
  }
  if (!receiptId.trim()) {
    throw new Error(
      'A queued offline consumption receipt is required before persisting an offline rating.',
    );
  }
  const owner = writeOwner(db);
  await inTransaction(db, async db => {
    const { rows } = await db.execute(
      `SELECT receipt FROM offline_receipt
       WHERE owner_key = ? AND receipt_id = ?`,
      [owner, receiptId],
    );
    const receipt = parseOfflineReceiptIdentity(rows[0]?.['receipt']);
    if (receipt === null || receipt.resultId !== analysis.id) {
      throw new Error(
        'The offline receipt does not name this analysis; the rating is not persisted.',
      );
    }
    if (receipt.fullOutputSha256 !== offlineOutputSha256(analysis)) {
      throw new Error(
        'The offline receipt paid for a different output than this analysis; the rating is not persisted.',
      );
    }
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
  });
}

/** The result and output digest a durable offline receipt commits to; null
 * when the stored receipt is missing, unreadable or not a receipt. */
function parseOfflineReceiptIdentity(
  raw: unknown,
): { resultId: string; fullOutputSha256: string } | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const { resultId, fullOutputSha256 } = parsed as Record<string, unknown>;
  return typeof resultId === 'string' && typeof fullOutputSha256 === 'string'
    ? { resultId, fullOutputSha256 }
    : null;
}

/** One of this owner's persisted real scored ratings, or null when the
 * device no longer holds it or holds a payload it can no longer read. */
export async function readScoredShotAnalysis(
  db: LocalDb,
  shotId: string,
): Promise<ShotAnalysis | null> {
  const owner = writeOwner(db);
  const { rows } = await db.execute(
    `SELECT payload FROM local_shot
     WHERE owner_key = ? AND id = ? AND source = 'real' AND result_kind = 'scored'`,
    [owner, shotId],
  );
  const payload = rows[0]?.['payload'];
  if (typeof payload !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const analysis = parsed as ShotAnalysis;
  return analysis.id === shotId &&
    analysis.source === 'real' &&
    analysis.resultKind === 'scored'
    ? analysis
    : null;
}

/** Mark a shot delivered to the server outside the `shot.sync` outbox — an
 * offline receipt the server accepted (`result_recorded`) — exactly as a
 * successful shot.sync marks it. */
export async function recordShotSyncReceipt(
  db: LocalDb,
  shotId: string,
): Promise<void> {
  const owner = writeOwner(db);
  await db.execute(
    `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id)
     VALUES (?, 'shot.sync', ?)`,
    [owner, shotId],
  );
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
  const owner = writeOwner(db);
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

/** One row per real training activity on this device — every real analysis
 * (scored or honestly abstained: the swing happened) with its session tie.
 * Unbounded on purpose: the consistency engine replays the whole history. */
export interface ActivityShotRow {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
}

export async function listActivityShots(
  db: LocalDb,
): Promise<ActivityShotRow[]> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT id, session_id, shot_type, captured_at, overall_score, result_kind
     FROM local_shot
     WHERE owner_key = ? AND source = 'real'
     ORDER BY captured_at ASC`,
    [owner],
  );
  return rows.map(r => ({
    id: String(r['id']),
    sessionId: r['session_id'] ? String(r['session_id']) : null,
    shotType: String(r['shot_type']),
    capturedAt: String(r['captured_at']),
    overallScore:
      r['overall_score'] === null ? null : Number(r['overall_score']),
    resultKind: String(r['result_kind']),
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
        sessionId:
          typeof analysis.sessionId === 'string' && analysis.sessionId !== ''
            ? analysis.sessionId
            : null,
        priorityCheckpoint:
          typeof analysis.priorityFix?.checkpoint === 'string'
            ? analysis.priorityFix.checkpoint
            : null,
        checkpointScores: applicableCheckpointScores(analysis.checkpoints),
      });
    } catch {
      // Corrupt local payloads are excluded rather than guessed or coerced.
    }
  }
  return facts;
}

/** Applicable checkpoints with a finite numeric score only — an unobserved
 * or non-applicable checkpoint is absent from the map, never coerced to 0. */
function applicableCheckpointScores(
  checkpoints: unknown,
): Record<string, number> {
  const scores: Record<string, number> = {};
  if (!Array.isArray(checkpoints)) return scores;
  for (const checkpoint of checkpoints as Array<Partial<CheckpointScore>>) {
    if (
      checkpoint &&
      typeof checkpoint.key === 'string' &&
      checkpoint.applicable === true &&
      typeof checkpoint.score === 'number' &&
      Number.isFinite(checkpoint.score)
    ) {
      scores[checkpoint.key] = checkpoint.score;
    }
  }
  return scores;
}

/**
 * Checkpoint-level evidence from recent scored real analyses, newest first —
 * the drill library's focus signal. Payload provenance is re-checked after
 * the SQL boundary; corrupt or non-conforming rows are skipped, never
 * repaired into evidence.
 */
export async function listScoredCheckpointFacts(
  db: LocalDb,
  limit = 120,
): Promise<ScoredCheckpointFact[]> {
  const owner = getActiveDataOwner();
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Checkpoint fact limit must be a positive integer.');
  }
  const { rows } = await db.execute(
    `SELECT payload FROM local_shot
     WHERE owner_key = ? AND source = 'real' AND result_kind = 'scored'
     ORDER BY captured_at DESC LIMIT ?`,
    [owner, limit],
  );
  const facts: ScoredCheckpointFact[] = [];
  for (const row of rows) {
    try {
      const analysis = JSON.parse(String(row['payload'])) as ShotAnalysis;
      if (analysis.source !== 'real' || analysis.resultKind !== 'scored') {
        continue;
      }
      if (!Array.isArray(analysis.checkpoints)) continue;
      facts.push({
        id: analysis.id,
        shotType: analysis.shotType,
        capturedAt: analysis.capturedAtIso,
        checkpoints: analysis.checkpoints.map(checkpoint => ({
          key: String(checkpoint.key),
          score:
            typeof checkpoint.score === 'number' &&
            Number.isFinite(checkpoint.score)
              ? checkpoint.score
              : null,
          applicable: checkpoint.applicable === true,
        })),
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
  const owner = writeOwner(db);
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

// Exactly one finalized new attempt may own an immutable record. Pending and
// released technical attempts do not become additional library result rows.
const RECORD_JOURNALS_SQL = `(SELECT owner_key, analysis_id, operation_id, api_origin, state, permit_id, result_id, release_outcome FROM analysis_run_journal
  UNION ALL SELECT a.owner_key, a.analysis_id, a.operation_id, a.api_origin, a.state, a.permit_id, a.result_id, a.release_outcome
  FROM analysis_execution_attempts a JOIN analysis_logical_operations p
    ON p.owner_key = a.owner_key AND p.winning_attempt_id = a.operation_id AND p.final_record_id = a.analysis_id)`;

export interface StoredCaptureAnalysisSnapshot {
  capture: PendingCapture;
  status: unknown;
  declaredStrokeRaw: unknown;
  rawTargetSeed: unknown;
  newestRecordId: unknown;
  recordRow: Record<string, unknown> | null;
  journalOperationId: unknown;
  journalApiOrigin: unknown;
  resultId: unknown;
  resultKind: unknown;
  resultSource: unknown;
  resultPayload: unknown;
  resultMetadata: {
    capturedAtIso: unknown;
    shotType: unknown;
    sessionId: unknown;
    overallScore: unknown;
    analysisConfidence: unknown;
  };
}

export async function readCaptureAnalysisSnapshot(
  rawDb: LocalDb,
  owner: DataOwnerContext,
  captureId: string,
  recordId?: string,
): Promise<StoredCaptureAnalysisSnapshot | null> {
  const db = forDataOwner(rawDb, owner);
  const { rows } = await db.execute(
    `SELECT c.*, r.id AS record_id, r.capture_id AS record_capture_id,
       r.created_at AS record_created_at, r.engine_version AS record_engine_version,
       r.scoring_model_version AS record_scoring_model_version, r.record,
       newest.id AS newest_record_id, j.operation_id, j.api_origin,
       s.id AS result_id, s.result_kind, s.source AS result_source, s.payload AS result_payload,
       s.captured_at AS result_captured_at, s.shot_type AS result_shot_type,
       s.session_id AS result_session_id, s.overall_score AS result_score, s.confidence AS result_confidence
     FROM local_capture c
     LEFT JOIN local_analysis_record newest ON newest.owner_key = c.owner_key AND newest.id = (
       SELECT id FROM local_analysis_record WHERE owner_key = c.owner_key AND capture_id = c.id
       ORDER BY created_at DESC, id DESC LIMIT 1)
     LEFT JOIN local_analysis_record r ON r.owner_key = c.owner_key AND r.capture_id = c.id
       AND r.id = ${recordId === undefined ? 'newest.id' : '?'}
     LEFT JOIN ${RECORD_JOURNALS_SQL} j ON j.owner_key = r.owner_key AND j.analysis_id = r.id
     LEFT JOIN local_shot s ON s.owner_key = r.owner_key AND s.id = r.id
     WHERE c.owner_key = ? AND c.id = ?`,
    [...(recordId === undefined ? [] : [recordId]), owner.ownerKey, captureId],
  );
  assertDataOwnerContext(owner);
  const row = rows[0];
  if (!row) return null;
  return {
    capture: parseCaptureRow(row),
    status: row.status,
    declaredStrokeRaw: row.declared_stroke,
    rawTargetSeed: row.target_seed,
    newestRecordId: row.newest_record_id,
    recordRow:
      row.record_id === null
        ? null
        : {
            id: row.record_id,
            captureId: row.record_capture_id,
            createdAtIso: row.record_created_at,
            engineVersion: row.record_engine_version,
            scoringModelVersion: row.record_scoring_model_version,
            record: row.record,
          },
    journalOperationId: row.operation_id,
    journalApiOrigin: row.api_origin,
    resultId: row.result_id,
    resultKind: row.result_kind,
    resultSource: row.result_source,
    resultPayload: row.result_payload,
    resultMetadata: {
      capturedAtIso: row.result_captured_at,
      shotType: row.result_shot_type,
      sessionId: row.result_session_id,
      overallScore: row.result_score,
      analysisConfidence: row.result_confidence,
    },
  };
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
  const owner = writeOwner(db);
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
  const owner = writeOwner(db);
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

export type CaptureTargetSeedRead =
  | { kind: 'absent' }
  | { kind: 'valid'; seed: CaptureTargetSeed }
  | { kind: 'corrupt' };

export function parseCaptureTargetSeed(raw: unknown): CaptureTargetSeedRead {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'corrupt' };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isConfirmationTargetSelection(parsed)
      ? {
          kind: 'valid',
          seed: {
            point: { ...parsed.point },
            selectedAtIso: parsed.selectedAtIso,
          },
        }
      : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

export async function setCaptureTargetSeed(
  db: LocalDb,
  captureId: string,
  seed: CaptureTargetSeed,
): Promise<void> {
  if (!isConfirmationTargetSelection(seed))
    throw new Error('The capture target selection is invalid.');
  const owner = writeOwner(db);
  await db.execute(
    `UPDATE local_capture SET target_seed = ?
     WHERE owner_key = ? AND id = ?`,
    [JSON.stringify(seed), owner, captureId],
  );
}

/**
 * Replaces the stored clip payload after MEASURED evidence was added to it —
 * today the imported-video pose extraction. Without this, an import's
 * exoskeleton existed only for the analysis run that measured it: the row
 * kept the pre-extraction payload, so the Form Review reopened later had no
 * pose sequence to draw. Only a clip that passed the strict parser reaches
 * this function (the caller built it from a validated clip plus the native
 * extraction result); the row's identity columns are not touched.
 */
export async function updateCaptureClipPayload(
  db: LocalDb,
  captureId: string,
  clip: CapturedClip,
): Promise<void> {
  const owner = writeOwner(db);
  await db.execute(
    `UPDATE local_capture SET payload = ?
     WHERE owner_key = ? AND id = ?`,
    [JSON.stringify(clip), owner, captureId],
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
  const parsed = parseCaptureTargetSeed(rows[0]?.['target_seed']);
  if (parsed.kind === 'corrupt') {
    // A corrupt seed stays distinct from absence, never a reconstructed tap.
    throw new Error('The saved capture target selection is corrupt.');
  }
  return parsed.kind === 'valid' ? parsed.seed : null;
}

export async function markCaptureAnalyzed(
  db: LocalDb,
  captureId: string,
): Promise<void> {
  const owner = writeOwner(db);
  const result = await db.execute(
    `UPDATE local_capture SET status = 'analyzed'
     WHERE owner_key = ? AND id = ?`,
    [owner, captureId],
  );
  if (result.rowsAffected === 0) {
    throw new Error('The capture is no longer available in this account.');
  }
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
    `SELECT c.*, r.id AS record_id, r.capture_id AS record_capture_id,
       r.created_at AS record_created_at, r.engine_version AS record_engine_version,
       r.scoring_model_version AS record_scoring_model_version, r.record,
       j.state AS journal_state, j.permit_id, j.result_id, j.release_outcome,
       EXISTS (SELECT 1 FROM analysis_logical_operations p
         WHERE p.owner_key = c.owner_key AND p.capture_id = c.id) AS has_original_operation
     FROM local_capture c
     LEFT JOIN local_analysis_record r ON r.owner_key = c.owner_key AND r.id = (
       SELECT id FROM local_analysis_record WHERE owner_key = c.owner_key AND capture_id = c.id
       ORDER BY created_at DESC, id DESC LIMIT 1)
     LEFT JOIN ${RECORD_JOURNALS_SQL} j ON j.owner_key = r.owner_key AND j.analysis_id = r.id
     WHERE c.owner_key = ? AND c.status = 'awaiting_model'
     ORDER BY c.captured_at DESC${limit === null ? '' : ' LIMIT ?'}`,
    limit === null ? [owner] : [owner, limit],
  );
  return rows.map(row => {
    const capture = parseCaptureRow(row);
    if (row.has_original_operation === 1) capture.hasOriginalOperation = true;
    if (typeof row.record !== 'string') return capture;
    try {
      const value: unknown = JSON.parse(row.record);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('kind' in value) ||
        value.kind !== 'needs_technique_confirmation'
      )
        return capture;
      const parsed = parseNeedsTechniqueConfirmationRecord(value, {
        id: row.record_id,
        captureId: row.record_capture_id,
        createdAtIso: row.record_created_at,
        engineVersion: row.record_engine_version,
        scoringModelVersion: row.record_scoring_model_version,
      });
      capture.techniqueConfirmation =
        parsed.ok &&
        row.permit_id !== null &&
        row.result_id === null &&
        row.release_outcome === 'low_confidence'
          ? row.journal_state === 'released'
            ? 'ready'
            : row.journal_state === 'release_pending'
              ? 'release_pending'
              : 'blocked'
          : 'blocked';
    } catch {
      capture.techniqueConfirmation = 'blocked';
    }
    return capture;
  });
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
  const owner = writeOwner(db);
  await inTransaction(db, async db => {
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
  const owner = writeOwner(db);
  await inTransaction(db, async db => {
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

export interface LiveSessionHistoryRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  /** Raw summary JSON exactly as stored; parsing/validation is the caller's
   * (parseLiveSessionSummaryRecord) responsibility. */
  summary: string | null;
}

/** Completed Live Court sessions for the active owner, oldest first — the
 * cross-session gameplay progression source. Reads only; corrupt rows are
 * returned raw and excluded by the strict parser downstream. */
export async function listLiveSessionHistory(
  db: LocalDb,
  limit = 60,
): Promise<LiveSessionHistoryRow[]> {
  const owner = getActiveDataOwner();
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Live session history limit must be a positive integer.');
  }
  const { rows } = await db.execute(
    `SELECT id, started_at, ended_at, summary FROM local_session
     WHERE owner_key = ? AND mode = 'live_court' AND completed = 1
     ORDER BY started_at ASC, id ASC
     LIMIT ?`,
    [owner, limit],
  );
  return rows.map(row => ({
    id: String(row['id']),
    startedAt: String(row['started_at']),
    endedAt: row['ended_at'] == null ? null : String(row['ended_at']),
    summary: row['summary'] == null ? null : String(row['summary']),
  }));
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

export type ShotOutboxStatus =
  | { state: 'absent' }
  | {
      state: 'queued' | 'rejected' | 'exhausted' | 'needs_repair';
      attempts: number;
      lastError: string | null;
    };

/**
 * Durable state of a shot's outbox row. `rejected` rows were declined by the
 * server at least once but stay inside the retry budget; `exhausted` rows
 * have spent it and are excluded from every future drain (see sync.ts).
 */
export async function getShotOutboxStatus(
  db: LocalDb,
  shotId: string,
): Promise<ShotOutboxStatus> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT attempts, last_error, repair_reason FROM outbox
     WHERE owner_key = ? AND kind = 'shot.sync'
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?
     ORDER BY id DESC LIMIT 1`,
    [owner, shotId],
  );
  const row = rows[0];
  if (!row) return { state: 'absent' };
  const attempts = Number(row['attempts'] ?? 0);
  const lastError =
    typeof row['last_error'] === 'string' && row['last_error'].length > 0
      ? row['last_error']
      : null;
  if (row['repair_reason'] != null) {
    return { state: 'needs_repair', attempts, lastError };
  }
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    return { state: 'exhausted', attempts, lastError };
  }
  if (attempts > 0) return { state: 'rejected', attempts, lastError };
  return { state: 'queued', attempts, lastError };
}

/** Explicitly retry a held read and its parent, without changing saved evidence.
 * The caller retains the owner generation from the screen that offered retry. */
export async function retryShotSync(
  db: LocalDb,
  shotId: string,
  context: DataOwnerContext,
): Promise<boolean> {
  return withTransaction(forDataOwner(db, context), async transaction => {
    const { rows } = await transaction.execute(
      `SELECT id, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.sessionId') END AS session_id FROM outbox
       WHERE owner_key = ? AND kind = 'shot.sync' AND repair_reason IS NOT NULL
         AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?`,
      [context.ownerKey, shotId],
    );
    for (const row of rows) {
      await transaction.execute(
        `UPDATE outbox SET repair_reason = NULL, last_error = NULL,
         attempts = 0, last_attempt_order = 0 WHERE owner_key = ? AND id = ?`,
        [context.ownerKey, row['id']],
      );
      if (typeof row['session_id'] === 'string') {
        await transaction.execute(
          `UPDATE outbox SET repair_reason = NULL, last_error = NULL,
           attempts = 0, last_attempt_order = 0
           WHERE owner_key = ? AND kind IN ('session.create', 'session.finalize')
             AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?`,
          [context.ownerKey, row['session_id']],
        );
      }
    }
    return rows.length > 0;
  });
}

export async function getKv(
  db: LocalDb,
  key: string,
  options: { preserveEmpty?: boolean } = {},
): Promise<string | null> {
  const { rows } = await db.execute(`SELECT value FROM kv WHERE key = ?`, [
    key,
  ]);
  const value = rows[0]?.['value'];
  if (options.preserveEmpty && value === '') return '';
  return value ? String(value) : null;
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
