import type pg from "pg";
import { one } from "../../lib/db.js";

/**
 * Canonical session summary computation (spec p. 25). It is derived only from
 * persisted shots, so any write that changes a session's shots must be able to
 * recompute it — a summary that disagrees with the session's shots is a lie
 * about the user's practice, not a stale cache.
 */

export interface SessionSummaryStats {
  validCount: number;
  avg: number | null;
  best: number | null;
  first: number | null;
  last: number | null;
  bestShotId: string | null;
  focusDelta: number | null;
}

export async function computeSessionSummaryStats(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  sessionId: string,
  focusCheckpointId: string | null,
): Promise<SessionSummaryStats> {
  const stats = await one<{
    valid_count: string;
    avg_score: string | null;
    best_score: string | null;
    first_score: string | null;
    last_score: string | null;
    best_shot_id: string | null;
  }>(
    db,
    `WITH scored AS (
       SELECT id, overall_score, captured_at FROM shot
       WHERE session_id = $1 AND user_id = $2
         AND source = 'real' AND result_kind = 'scored'
     )
     SELECT count(*)::text AS valid_count,
            avg(overall_score)::text AS avg_score,
            max(overall_score)::text AS best_score,
            (SELECT overall_score::text FROM scored ORDER BY captured_at ASC LIMIT 1) AS first_score,
            (SELECT overall_score::text FROM scored ORDER BY captured_at DESC LIMIT 1) AS last_score,
            (SELECT id::text FROM scored ORDER BY overall_score DESC, captured_at ASC LIMIT 1) AS best_shot_id
     FROM scored`,
    [sessionId, userId],
  );

  let focusDelta: number | null = null;
  if (focusCheckpointId) {
    const focus = await one<{ first_avg: string | null; last_avg: string | null }>(
      db,
      `WITH cp AS (
         SELECT scs.score_0_100, s.captured_at,
                ntile(2) OVER (ORDER BY s.captured_at) AS half
         FROM shot_checkpoint_score scs
         JOIN shot s ON s.id = scs.shot_id
         WHERE s.session_id = $1 AND s.user_id = $2 AND s.source = 'real'
           AND scs.checkpoint_definition_id = $3 AND scs.score_0_100 IS NOT NULL
       )
       SELECT avg(score_0_100) FILTER (WHERE half = 1)::text AS first_avg,
              avg(score_0_100) FILTER (WHERE half = 2)::text AS last_avg
       FROM cp`,
      [sessionId, userId, focusCheckpointId],
    );
    if (focus?.first_avg && focus.last_avg) {
      focusDelta = Math.round((Number(focus.last_avg) - Number(focus.first_avg)) * 10) / 10;
    }
  }

  return {
    validCount: Number(stats?.valid_count ?? 0),
    avg: stats?.avg_score ? Number(stats.avg_score) : null,
    best: stats?.best_score ? Number(stats.best_score) : null,
    first: stats?.first_score ? Number(stats.first_score) : null,
    last: stats?.last_score ? Number(stats.last_score) : null,
    bestShotId: stats?.best_shot_id ?? null,
    focusDelta,
  };
}

export async function writeSessionSummary(
  db: pg.Pool | pg.PoolClient,
  sessionId: string,
  focusCheckpointId: string | null,
  stats: SessionSummaryStats,
): Promise<void> {
  await db.query(
    `INSERT INTO session_summary (session_id, valid_shot_count, start_score, end_score, average_score, best_score, focus_checkpoint_id, focus_delta, best_shot_id, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (session_id) DO UPDATE SET
       valid_shot_count = EXCLUDED.valid_shot_count, start_score = EXCLUDED.start_score,
       end_score = EXCLUDED.end_score, average_score = EXCLUDED.average_score,
       best_score = EXCLUDED.best_score, focus_delta = EXCLUDED.focus_delta,
       best_shot_id = EXCLUDED.best_shot_id, summary = EXCLUDED.summary, generated_at = now()`,
    [
      sessionId,
      stats.validCount,
      stats.first,
      stats.last,
      stats.avg,
      stats.best,
      focusCheckpointId,
      stats.focusDelta,
      stats.bestShotId,
      JSON.stringify({ generatedBy: "api", version: 1 }),
    ],
  );
}

/**
 * Recomputes an already-generated summary after a late shot lands in the
 * session (offline outbox flushing after the user finalized on device). The
 * session's completed flag is left alone: the practice really did end, but its
 * numbers must include every shot that belongs to it.
 */
export async function refreshSummaryIfPresent(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const session = await one<{ focus_checkpoint_id: string | null; has_summary: boolean }>(
    db,
    `SELECT ps.focus_checkpoint_id,
            EXISTS (SELECT 1 FROM session_summary ss WHERE ss.session_id = ps.id) AS has_summary
     FROM practice_session ps
     WHERE ps.id = $1 AND ps.user_id = $2`,
    [sessionId, userId],
  );
  if (!session || !session.has_summary) return false;
  const stats = await computeSessionSummaryStats(
    db,
    userId,
    sessionId,
    session.focus_checkpoint_id,
  );
  await writeSessionSummary(db, sessionId, session.focus_checkpoint_id, stats);
  await db.query("UPDATE practice_session SET avg_score = $2 WHERE id = $1", [
    sessionId,
    stats.avg,
  ]);
  return true;
}
