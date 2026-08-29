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

const LATEST_TRAINING_CONSENT_WITH_VERSION = `
  SELECT DISTINCT ON (cs.user_id) cs.user_id, cr.action, cr.consent_version AS grant_consent_version
  FROM consent_subject cs
  JOIN consent_record cr ON cr.subject_pseudonym = cs.pseudonym
  WHERE cr.scope = 'model_training'
  ORDER BY cs.user_id, cr.seq DESC`;

export interface TrainingEligibleItem {
  id: string;
  source_user_id: string;
  /** Consent version stamped on the dataset item at ingest time. */
  consent_version: string;
  /** Consent version of the ledger grant currently authorizing the item. */
  grant_consent_version: string;
}

interface TrainingEligibleSelection {
  items: TrainingEligibleItem[];
  /**
   * Highest consent_record.seq visible when the selection was taken. A
   * selection is a snapshot: consent withdrawn after this watermark is NOT
   * reflected in `items`. Consumers MUST call verifyTrainingEligibility on
   * a fresh connection immediately before training use.
   */
  consentWatermark: number;
}

/** The only sanctioned selector for user-sourced training data. */
export async function selectTrainingEligibleItems(
  pool: pg.Pool | pg.PoolClient,
): Promise<TrainingEligibleItem[]> {
  const { rows } = await pool.query(
    `SELECT i.id, i.source_user_id, i.consent_version, latest.grant_consent_version
     FROM ml_dataset_item i
     JOIN (${LATEST_TRAINING_CONSENT_WITH_VERSION}) latest
       ON latest.user_id = i.source_user_id AND latest.action = 'granted'
     WHERE i.removed_at IS NULL AND i.source_user_id IS NOT NULL`,
  );
  return rows as TrainingEligibleItem[];
}

/** Selection plus the ledger watermark it was taken at. */
export async function selectTrainingEligibleItemsWithWatermark(
  pool: pg.Pool | pg.PoolClient,
): Promise<TrainingEligibleSelection> {
  const items = await selectTrainingEligibleItems(pool);
  const { rows } = await pool.query(
    "SELECT COALESCE(max(seq), 0)::bigint AS watermark FROM consent_record",
  );
  return { items, consentWatermark: Number(rows[0].watermark) };
}

/**
 * Re-validate a previously selected batch against the CURRENT ledger state.
 * Closes the select-then-train race: a withdrawal committed after selection
 * (even mid-transaction of the selector) drops the affected items here.
 * Must run on a fresh pool connection, never inside the selecting snapshot.
 */
export async function verifyTrainingEligibility(
  pool: pg.Pool,
  items: readonly TrainingEligibleItem[],
): Promise<TrainingEligibleItem[]> {
  if (items.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT i.id
     FROM ml_dataset_item i
     JOIN (${LATEST_TRAINING_CONSENT}) latest
       ON latest.user_id = i.source_user_id AND latest.action = 'granted'
     WHERE i.removed_at IS NULL AND i.source_user_id IS NOT NULL AND i.id = ANY($1::uuid[])`,
    [items.map((i) => i.id)],
  );
  const stillEligible = new Set(rows.map((r) => (r as { id: string }).id));
  return items.filter((i) => stillEligible.has(i.id));
}
