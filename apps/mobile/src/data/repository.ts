import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from './db';

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

export async function saveAnalysis(
  db: LocalDb,
  analysis: ShotAnalysis,
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO local_shot (id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    `INSERT INTO outbox (kind, payload) VALUES ('shot.sync', ?)`,
    [JSON.stringify(analysis)],
  );
}

export async function listShots(
  db: LocalDb,
  limit = 50,
): Promise<LocalShotRow[]> {
  const { rows } = await db.execute(
    `SELECT id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite
     FROM local_shot ORDER BY captured_at DESC LIMIT ?`,
    [limit],
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
  const { rows } = await db.execute(
    `SELECT payload FROM local_shot WHERE id = ?`,
    [id],
  );
  const payload = rows[0]?.['payload'];
  return payload ? (JSON.parse(String(payload)) as ShotAnalysis) : null;
}

export async function recentScores(
  db: LocalDb,
  shotType: string | null,
  limit = 30,
): Promise<number[]> {
  const { rows } = await db.execute(
    `SELECT overall_score FROM local_shot
     WHERE result_kind = 'scored' AND (? IS NULL OR shot_type = ?)
     ORDER BY captured_at DESC LIMIT ?`,
    [shotType, shotType, limit],
  );
  return rows
    .map(r => (r['overall_score'] === null ? null : Number(r['overall_score'])))
    .filter((v): v is number => v !== null)
    .reverse();
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
  await db.execute(
    `INSERT OR REPLACE INTO local_session (id, mode, shot_type, focus_checkpoint, started_at) VALUES (?, ?, ?, ?, ?)`,
    [
      session.id,
      session.mode,
      session.shotType,
      session.focusCheckpoint,
      session.startedAt,
    ],
  );
  await db.execute(
    `INSERT INTO outbox (kind, payload) VALUES ('session.create', ?)`,
    [JSON.stringify(session)],
  );
}

export async function finishSession(
  db: LocalDb,
  id: string,
  summary: Record<string, unknown>,
): Promise<void> {
  await db.execute(
    `UPDATE local_session SET ended_at = datetime('now'), completed = 1, summary = ? WHERE id = ?`,
    [JSON.stringify(summary), id],
  );
  await db.execute(
    `INSERT INTO outbox (kind, payload) VALUES ('session.finalize', ?)`,
    [JSON.stringify({ id })],
  );
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
