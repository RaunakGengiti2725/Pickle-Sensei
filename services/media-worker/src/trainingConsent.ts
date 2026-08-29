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
  SELECT DISTINCT ON (cs.user_id) cs.user_id, cr.action, cr.capture_mode
  FROM consent_subject cs
  JOIN consent_record cr ON cr.subject_pseudonym = cs.pseudonym
  WHERE cr.scope = 'model_training'
  ORDER BY cs.user_id, cr.seq DESC`;

/**
 * Capture-mode narrowing is enforced fail-closed: a grant scoped to a single
 * capture mode authorizes only clips of that mode, but ml_dataset_item rows
 * carry no capture-mode provenance, so mode-narrowed (or mode-less) grants
 * cannot be matched to items and authorize none of them. Only an explicit
 * 'all_captures' grant covers items regardless of how they were captured.
 */
const GRANT_COVERS_ALL_ITEMS = "latest.capture_mode = 'all_captures'";

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
  SELECT DISTINCT ON (cs.user_id)
    cs.user_id, cs.pseudonym AS subject_pseudonym, cr.action, cr.capture_mode,
    cr.consent_version AS grant_consent_version, cr.seq AS grant_seq
  FROM consent_subject cs
  JOIN consent_record cr ON cr.subject_pseudonym = cs.pseudonym
  WHERE cr.scope = 'model_training'
  ORDER BY cs.user_id, cr.seq DESC`;

export interface TrainingEligibleItem {
  id: string;
  source_user_id: string;
  /** Pseudonym of the consenting subject (never the user id). */
  subject_pseudonym: string;
  /** Consent version stamped on the dataset item at ingest time. */
  consent_version: string;
  /** Consent version of the ledger grant currently authorizing the item. */
  grant_consent_version: string;
  /** consent_record.seq of the grant currently authorizing the item. */
  grant_seq: string;
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
    `SELECT i.id, i.source_user_id, latest.subject_pseudonym, i.consent_version,
            latest.grant_consent_version, latest.grant_seq
     FROM ml_dataset_item i
     JOIN (${LATEST_TRAINING_CONSENT_WITH_VERSION}) latest
       ON latest.user_id = i.source_user_id AND latest.action = 'granted'
     WHERE i.removed_at IS NULL AND i.source_user_id IS NOT NULL
       AND ${GRANT_COVERS_ALL_ITEMS}`,
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
     WHERE i.removed_at IS NULL AND i.source_user_id IS NOT NULL
       AND ${GRANT_COVERS_ALL_ITEMS} AND i.id = ANY($1::uuid[])`,
    [items.map((i) => i.id)],
  );
  const stillEligible = new Set(rows.map((r) => (r as { id: string }).id));
  return items.filter((i) => stillEligible.has(i.id));
}

/** Analysis/session provenance stamped on eligibility ledger entries. */
export interface EligibilityProvenance {
  analysisId?: string | null;
  sessionId?: string | null;
}

export interface EligibilityLedgerEntry {
  dataset_item_id: string;
  subject_pseudonym: string;
  state: "eligible" | "ineligible" | "withdrawn";
  consent_version: string;
  consent_seq: string;
  analysis_id: string | null;
  session_id: string | null;
  reason: string;
  recorded_at: Date;
}

/**
 * Append 'eligible' entries to the training-eligibility ledger for a
 * verified selection. Each entry is keyed by the authorizing grant's
 * consent_record seq and consent version; the DB scope-guard trigger
 * independently re-checks that the cited record is a model_training grant
 * with capture_mode 'all_captures' for the same subject, so a selection
 * grounded in anything else (e.g. a video_analysis grant) cannot be
 * recorded as eligible even by buggy or malicious callers.
 */
export async function recordTrainingEligibility(
  pool: pg.Pool | pg.PoolClient,
  items: readonly TrainingEligibleItem[],
  provenance: EligibilityProvenance = {},
): Promise<number> {
  let appended = 0;
  for (const item of items) {
    const result = await pool.query(
      `INSERT INTO training_eligibility_ledger
         (subject_pseudonym, dataset_item_id, analysis_id, session_id,
          consent_version, consent_seq, state, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'eligible', 'selection.grant_verified')`,
      [
        item.subject_pseudonym,
        item.id,
        provenance.analysisId ?? null,
        provenance.sessionId ?? null,
        item.grant_consent_version,
        item.grant_seq,
      ],
    );
    appended += result.rowCount ?? 0;
  }
  return appended;
}

/** Latest eligibility ledger entry per dataset item, or absent if none. */
export async function latestEligibilityEntries(
  pool: pg.Pool | pg.PoolClient,
  datasetItemIds: readonly string[],
): Promise<Map<string, EligibilityLedgerEntry>> {
  if (datasetItemIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (dataset_item_id)
       dataset_item_id, subject_pseudonym, state, consent_version, consent_seq,
       analysis_id, session_id, reason, recorded_at
     FROM training_eligibility_ledger
     WHERE dataset_item_id = ANY($1::uuid[])
     ORDER BY dataset_item_id, seq DESC`,
    [datasetItemIds],
  );
  return new Map((rows as EligibilityLedgerEntry[]).map((row) => [row.dataset_item_id, row]));
}

/**
 * Fail-closed point check for one dataset item: it is training-eligible
 * only when its latest ledger entry is 'eligible' AND the subject's latest
 * model_training consent action is still an un-narrowed grant. No ledger
 * entry means NOT eligible; a withdrawal on either axis means NOT eligible.
 */
export async function isDatasetItemTrainingEligible(
  pool: pg.Pool | pg.PoolClient,
  datasetItemId: string,
): Promise<boolean> {
  const latest = (await latestEligibilityEntries(pool, [datasetItemId])).get(datasetItemId);
  if (latest === undefined || latest.state !== "eligible") return false;
  const { rows } = await pool.query(
    `SELECT action, capture_mode FROM consent_record
     WHERE subject_pseudonym = $1 AND scope = 'model_training'
     ORDER BY seq DESC LIMIT 1`,
    [latest.subject_pseudonym],
  );
  const current = rows[0] as { action: string; capture_mode: string | null } | undefined;
  return current?.action === "granted" && current.capture_mode === "all_captures";
}
