import type pg from "pg";
import { one } from "../../lib/db.js";

/**
 * Analysis run ledger (spec pp. 22, 44). One row per scoring pass over a
 * shot. The table is append-only (database triggers reject UPDATE/DELETE):
 * reprocessing a shot under a newer scoring model inserts a NEW run that
 * references the run it supersedes, so the old score, its model version, and
 * its timestamps all survive verbatim.
 */

export class AnalysisRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisRunError";
  }
}

export interface AnalysisRunRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  shot_id: string;
  scoring_model_id: string;
  scoring_model_version: string;
  overall_score: string | null;
  result_kind: "scored" | "low_confidence";
  supersedes_run_id: string | null;
  produced_at: string;
  created_at: string;
}

export async function recordInitialAnalysisRun(
  db: pg.Pool | pg.PoolClient,
  input: {
    userId: string;
    shotId: string;
    scoringModelId: string;
    scoringModelVersion: string;
    overallScore: number | null;
    resultKind: "scored" | "low_confidence";
    producedAt: string;
  },
): Promise<AnalysisRunRow> {
  const row = await one<AnalysisRunRow>(
    db,
    `INSERT INTO analysis_run (user_id, shot_id, scoring_model_id, scoring_model_version,
       overall_score, result_kind, supersedes_run_id, produced_at)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)
     RETURNING *`,
    [
      input.userId,
      input.shotId,
      input.scoringModelId,
      input.scoringModelVersion,
      input.overallScore,
      input.resultKind,
      input.producedAt,
    ],
  );
  return row!;
}

/**
 * Reprocess a shot under a different scoring model version. Inserts a new
 * run superseding the given one; the superseded run is never modified.
 */
export async function recordReprocessedAnalysisRun(
  db: pg.Pool | pg.PoolClient,
  input: {
    supersededRunId: string;
    scoringModelId: string;
    scoringModelVersion: string;
    overallScore: number | null;
    resultKind: "scored" | "low_confidence";
    producedAt: string;
  },
): Promise<AnalysisRunRow> {
  const superseded = await one<AnalysisRunRow>(db, "SELECT * FROM analysis_run WHERE id = $1", [
    input.supersededRunId,
  ]);
  if (!superseded) {
    throw new AnalysisRunError("run.not_found", "Cannot reprocess an unknown analysis run.");
  }
  if (superseded.scoring_model_version === input.scoringModelVersion) {
    throw new AnalysisRunError(
      "run.same_version_reprocess",
      "Reprocessing under the same scoring model version would duplicate, not supersede.",
    );
  }
  const row = await one<AnalysisRunRow>(
    db,
    `INSERT INTO analysis_run (user_id, shot_id, scoring_model_id, scoring_model_version,
       overall_score, result_kind, supersedes_run_id, produced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      superseded.user_id,
      superseded.shot_id,
      input.scoringModelId,
      input.scoringModelVersion,
      input.overallScore,
      input.resultKind,
      input.supersededRunId,
      input.producedAt,
    ],
  );
  return row!;
}

export async function runsForShot(
  db: pg.Pool | pg.PoolClient,
  shotId: string,
): Promise<AnalysisRunRow[]> {
  const { rows } = await db.query(
    "SELECT * FROM analysis_run WHERE shot_id = $1 ORDER BY created_at, id",
    [shotId],
  );
  return rows as AnalysisRunRow[];
}
