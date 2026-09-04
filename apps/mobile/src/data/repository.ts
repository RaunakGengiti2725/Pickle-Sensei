import {
  SHOT_TYPES,
  type CheckpointScore,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { LocalDb } from './db';
import { runInTransaction } from './transaction';
import { assertCapturedClip, type CapturedClip } from '../camera/capture';
import {
  getActiveDataOwner,
  notePurgedOwnerData,
  requireWritableDataOwner,
} from './accountScope';
import {
  OUTBOX_MAX_ATTEMPTS,
  enqueueSessionCreate,
  isSessionOrphanedVerdict,
  rearmExhaustedSessionCreate,
} from './sync';
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
}

export interface CaptureHistoryEntry extends PendingCapture {
  /** Durable processing state from local_capture; neither state implies a score. */
  status: 'awaiting_model' | 'analyzed';
}

/** Every owner-partitioned local table. Kept in one place so account
 * deletion can never silently miss a store added later. */
const OWNER_SCOPED_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
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
  await runInTransaction(db, async () => {
    // Fences every drain already in flight for this owner: none of its
    // statements runs again once the bucket is gone (sync.ts).
    notePurgedOwnerData(owner);
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

export interface SessionInput {
  id: string;
  mode: string;
  shotType: string | null;
  focusCheckpoint: string | null;
  startedAt: string;
}

/**
 * Persists a scored rating: the `local_shot` row and its `shot.sync` outbox
 * entry, atomically. When the shot belongs to a practice set, pass the set as
 * `options.session`: a set this device has no `local_session` row for yet
 * gets that row AND its `session.create` outbox entry in the SAME
 * transaction, ahead of the shot — so a kill or a failed follow-up write can
 * never leave a shot whose session no queue entry will ever name. A set the
 * device already knows whose `session.create` spent its budget is re-armed
 * by the new shot: the server is asked for the set once more (one bounded
 * round per shot that joins it), so the set's parked shots can be delivered.
 */
export async function saveAnalysis(
  db: LocalDb,
  analysis: ShotAnalysis,
  analysisPermitId: string,
  options: { session?: SessionInput | null } = {},
): Promise<void> {
  if (analysis.source !== 'real') {
    throw new Error('Only real analyses may be persisted by the app runtime.');
  }
  if (!analysisPermitId.trim()) {
    throw new Error(
      'A server-reserved analysis permit is required before persisting a rating.',
    );
  }
  const session = options.session ?? null;
  if (session !== null && session.id !== analysis.sessionId) {
    throw new Error(
      'The practice set saved with a rating must be the one the rating names.',
    );
  }
  const owner = requireWritableDataOwner();
  await runInTransaction(db, async () => {
    if (session !== null) {
      const { rows } = await db.execute(
        `SELECT 1 FROM local_session WHERE owner_key = ? AND id = ? LIMIT 1`,
        [owner, session.id],
      );
      if (rows.length === 0) {
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
        await enqueueSessionCreate(db, owner, session);
      } else {
        await rearmExhaustedSessionCreate(db, owner, session.id);
      }
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
  const owner = requireWritableDataOwner();
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
  session: SessionInput,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await runInTransaction(db, async () => {
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
    await enqueueSessionCreate(db, owner, session);
  });
}

export async function finishSession(
  db: LocalDb,
  id: string,
  summary: Record<string, unknown>,
): Promise<void> {
  const owner = requireWritableDataOwner();
  await runInTransaction(db, async () => {
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
      state: 'queued' | 'rejected' | 'exhausted' | 'orphaned';
      attempts: number;
      lastError: string | null;
    };

/**
 * Durable state of a shot's outbox row. `rejected` rows were declined by the
 * server at least once but stay inside the retry budget; `exhausted` rows
 * have spent it and are excluded from every future drain (see sync.ts).
 * `orphaned` rows are PARKED, not finished: shots whose practice set the
 * server does not know yet (its session.create row was refused, or none
 * exists on this device); a drain offers them again as soon as a
 * session.create for that set is accepted.
 */
export async function getShotOutboxStatus(
  db: LocalDb,
  shotId: string,
): Promise<ShotOutboxStatus> {
  const owner = getActiveDataOwner();
  // The id is read out of every sibling row's payload, so the extraction is
  // guarded per row: json_extract() raises "malformed JSON" on a corrupt
  // payload, and one such row must not make every healthy shot's lookup
  // throw. CASE evaluates in order, unlike a bare AND.
  const { rows } = await db.execute(
    `SELECT attempts, last_error FROM outbox
     WHERE owner_key = ? AND kind = 'shot.sync'
       AND CASE WHEN json_valid(payload)
                THEN json_extract(payload, '$.id') END = ?
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
  if (isSessionOrphanedVerdict(lastError)) {
    return { state: 'orphaned', attempts, lastError };
  }
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    return { state: 'exhausted', attempts, lastError };
  }
  if (attempts > 0) return { state: 'rejected', attempts, lastError };
  return { state: 'queued', attempts, lastError };
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
