import type pg from "pg";

/**
 * Training-consent gate. Any path that selects data for model training MUST
 * come through here: an item is training-eligible only when its source user's
 * latest model_training ledger action is an explicit grant. No record means
 * NO consent — absence is never treated as opt-in. Items without a source
 * user (e.g. licensed footage) are outside this gate and carry their own
 * rights provenance.
 */

const LATEST_TRAINING_CONSENT = `
  SELECT DISTINCT ON (cs.user_id) cs.user_id, cr.action
  FROM consent_subject cs
  JOIN consent_record cr ON cr.subject_pseudonym = cs.pseudonym
  WHERE cr.scope = 'model_training'
  ORDER BY cs.user_id, cr.seq DESC`;

export async function hasActiveModelTrainingConsent(
  pool: pg.Pool | pg.PoolClient,
  userId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT action FROM (${LATEST_TRAINING_CONSENT}) latest WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.action === "granted";
}

export interface TrainingEligibleItem {
  id: string;
  source_user_id: string;
  consent_version: string;
}

/** The only sanctioned selector for user-sourced training data. */
export async function selectTrainingEligibleItems(
  pool: pg.Pool | pg.PoolClient,
): Promise<TrainingEligibleItem[]> {
  const { rows } = await pool.query(
    `SELECT i.id, i.source_user_id, i.consent_version
     FROM ml_dataset_item i
     JOIN (${LATEST_TRAINING_CONSENT}) latest
       ON latest.user_id = i.source_user_id AND latest.action = 'granted'
     WHERE i.removed_at IS NULL AND i.source_user_id IS NOT NULL`,
  );
  return rows as TrainingEligibleItem[];
}
