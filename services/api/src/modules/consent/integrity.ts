import type pg from "pg";

/**
 * Ledger attribution integrity. consent_record intentionally has no foreign
 * key to consent_subject (the ledger must outlive the mapping), so a deleted
 * mapping orphans a subject's history: /status and /export report an empty
 * ledger while the rows still exist. The only lawful way a mapping disappears
 * is account deletion, which the consent_subject delete trigger tombstones in
 * consent_subject_erasure. An orphaned ledger subject WITHOUT a tombstone is
 * therefore evidence of an out-of-band deletion and must be surfaced.
 */

export interface OrphanedLedgerSubject {
  pseudonym: string;
  recordCount: number;
}

export async function findOrphanedLedgerSubjects(
  db: pg.Pool | pg.PoolClient,
): Promise<OrphanedLedgerSubject[]> {
  const { rows } = await db.query(
    `SELECT cr.subject_pseudonym AS pseudonym, count(*)::int AS record_count
     FROM consent_record cr
     LEFT JOIN consent_subject cs ON cs.pseudonym = cr.subject_pseudonym
     LEFT JOIN consent_subject_erasure e ON e.pseudonym = cr.subject_pseudonym
     WHERE cs.pseudonym IS NULL AND e.pseudonym IS NULL
     GROUP BY cr.subject_pseudonym`,
  );
  return rows.map((r) => ({
    pseudonym: (r as { pseudonym: string }).pseudonym,
    recordCount: (r as { record_count: number }).record_count,
  }));
}
