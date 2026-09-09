import type { LocalDb } from '../data/db';
import {
  DELETION_FOUNDATION_LIMITS,
  DELETION_ISSUES,
  DELETION_PHASES,
  DeletionFoundationError,
  deletionMember,
  deletionRecord,
  deletionUuid,
  parseDeletionJournalEntry,
  sameDeletionReceipt,
  type DeletionJournalEntry,
  type DeletionPhase,
} from './deletionOperationContracts';

const TABLE = 'device_account_deletion_journal';
const COLUMNS = [
  'job_id',
  'owner_id',
  'api_origin',
  'operation_id',
  'revision',
  'phase',
  'document',
];
const DDL = `CREATE TABLE ${TABLE} (
  job_id TEXT NOT NULL PRIMARY KEY CHECK (length(job_id) = 36),
  owner_id TEXT NOT NULL CHECK (length(owner_id) = 36),
  api_origin TEXT NOT NULL CHECK (length(api_origin) BETWEEN 8 AND 512),
  operation_id TEXT UNIQUE CHECK (operation_id IS NULL OR length(operation_id) = 36),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  phase TEXT NOT NULL CHECK (phase IN (${DELETION_PHASES.map(phase => `'${phase}'`).join(',')})),
  document TEXT NOT NULL CHECK (length(CAST(document AS BLOB)) <= ${DELETION_FOUNDATION_LIMITS.journalBytes} AND json_valid(document))
)`;

const TRANSITIONS: Readonly<Record<DeletionPhase, readonly DeletionPhase[]>> = {
  request_pending: ['request_pending', 'request_unknown', 'securing'],
  request_unknown: ['request_pending'],
  securing: ['ready'],
  ready: ['ready', 'observing', 'confirm_pending', 'receipt_pending'],
  confirm_pending: ['confirm_pending', 'ready', 'observing', 'receipt_pending'],
  observing: ['ready', 'observing', 'receipt_pending'],
  receipt_pending: ['receipt_pending', 'receipt_verified'],
  receipt_verified: ['cleanup_pending'],
  cleanup_pending: ['cleanup_pending', 'cleanup_complete'],
  cleanup_complete: ['cleanup_complete'],
};

function sanitized(error: unknown): DeletionFoundationError {
  if (
    error instanceof DeletionFoundationError &&
    deletionMember(error.code, DELETION_ISSUES)
  ) {
    return new DeletionFoundationError(error.code);
  }
  return new DeletionFoundationError('journal_unavailable');
}

/** The indexed columns of a row whose document cannot be read as an
 * entry. They say which owner and operation the row belongs to and the
 * last phase that was committed for it — nothing more. */
export interface DeletionJournalRowStub {
  readonly jobId: string;
  readonly ownerId: string;
  readonly apiOrigin: string;
  readonly operationId: string | null;
  readonly phase: DeletionPhase;
}

export interface DeletionJournalListing {
  readonly entries: readonly DeletionJournalEntry[];
  readonly unreadable: readonly DeletionJournalRowStub[];
}

function parseRowStub(row: Record<string, unknown>): DeletionJournalRowStub {
  if (
    Object.keys(row).length !== COLUMNS.length ||
    !COLUMNS.every(key => Object.hasOwn(row, key)) ||
    typeof row.document !== 'string' ||
    row.document.length > DELETION_FOUNDATION_LIMITS.journalBytes ||
    !deletionUuid(row.job_id) ||
    !deletionUuid(row.owner_id) ||
    typeof row.api_origin !== 'string' ||
    (row.operation_id !== null && !deletionUuid(row.operation_id)) ||
    !deletionMember(row.phase, DELETION_PHASES)
  ) {
    throw new DeletionFoundationError('journal_invalid');
  }
  return Object.freeze({
    jobId: row.job_id,
    ownerId: row.owner_id,
    apiOrigin: row.api_origin,
    operationId: row.operation_id,
    phase: row.phase,
  });
}

function parseRow(row: Record<string, unknown>): DeletionJournalEntry {
  if (
    Object.keys(row).length !== COLUMNS.length ||
    !COLUMNS.every(key => Object.hasOwn(row, key)) ||
    typeof row.document !== 'string' ||
    row.document.length > DELETION_FOUNDATION_LIMITS.journalBytes
  ) {
    throw new DeletionFoundationError('journal_invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(row.document);
  } catch {
    throw new DeletionFoundationError('journal_invalid');
  }
  if (
    deletionRecord(value) &&
    typeof value.version === 'number' &&
    value.version !== 1
  ) {
    throw new DeletionFoundationError('journal_unsupported');
  }
  const entry = parseDeletionJournalEntry(value);
  if (
    !entry ||
    entry.jobId !== row.job_id ||
    entry.ownerId !== row.owner_id ||
    entry.apiOrigin !== row.api_origin ||
    entry.operationId !== row.operation_id ||
    entry.revision !== row.revision ||
    entry.phase !== row.phase
  ) {
    throw new DeletionFoundationError('journal_invalid');
  }
  return entry;
}

function validateTransition(
  before: DeletionJournalEntry,
  after: DeletionJournalEntry,
): void {
  if (
    before.jobId !== after.jobId ||
    before.ownerId !== after.ownerId ||
    before.apiOrigin !== after.apiOrigin ||
    before.createdAtMs !== after.createdAtMs ||
    after.revision !== before.revision + 1 ||
    !TRANSITIONS[before.phase].includes(after.phase) ||
    JSON.stringify(before.ownership) !== JSON.stringify(after.ownership) ||
    (before.operationId !== null &&
      (before.operationId !== after.operationId ||
        before.expiresAt !== after.expiresAt ||
        before.statusExpiresAt !== after.statusExpiresAt ||
        before.reviewAfterMs !== after.reviewAfterMs)) ||
    (before.operationId === null &&
      after.operationId !== null &&
      after.phase !== 'securing') ||
    (before.receipt !== null &&
      !sameDeletionReceipt(before.receipt, after.receipt)) ||
    before.cleanup.completed.length > after.cleanup.completed.length ||
    !before.cleanup.completed.every(
      (step, index) => step === after.cleanup.completed[index],
    )
  ) {
    throw new DeletionFoundationError('journal_conflict');
  }
}

export function createDeletionOperationJournal(db: LocalDb) {
  let initialization: Promise<void> | null = null;

  async function transaction<T>(
    operation: (tx: LocalDb) => Promise<T>,
  ): Promise<T> {
    if (db.ownerContext !== undefined || !db.transaction)
      throw new DeletionFoundationError('raw_transactional_db_required');
    try {
      return await db.transaction(operation);
    } catch (error) {
      throw sanitized(error);
    }
  }

  async function initialize(): Promise<void> {
    if (!initialization) {
      initialization = transaction(async tx => {
        const info = await tx.execute(`PRAGMA table_info(${TABLE})`);
        if (info.rows.length === 0) await tx.execute(DDL);
        else if (
          info.rows.length !== COLUMNS.length ||
          info.rows.some((row, index) => row.name !== COLUMNS[index])
        ) {
          throw new DeletionFoundationError('journal_schema_invalid');
        }
        const schema = await tx.execute(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
          [TABLE],
        );
        const sql = schema.rows[0]?.sql;
        if (
          typeof sql !== 'string' ||
          sql.replace(/\s+/g, ' ').trim() !== DDL.replace(/\s+/g, ' ').trim()
        ) {
          throw new DeletionFoundationError('journal_schema_invalid');
        }
      });
    }
    try {
      await initialization;
    } catch (error) {
      initialization = null;
      throw sanitized(error);
    }
  }

  async function readIn(
    tx: LocalDb,
    jobId: string,
  ): Promise<DeletionJournalEntry | null> {
    const { rows } = await tx.execute(
      `SELECT * FROM ${TABLE} WHERE job_id = ?`,
      [jobId],
    );
    if (rows.length > 1) throw new DeletionFoundationError('journal_invalid');
    return rows[0] ? parseRow(rows[0]) : null;
  }

  return Object.freeze({
    initialize,
    async read(jobId: string): Promise<DeletionJournalEntry | null> {
      if (!deletionUuid(jobId))
        throw new DeletionFoundationError('invalid_binding');
      await initialize();
      return transaction(tx => readIn(tx, jobId));
    },
    /** Every row, each on its own: a document that cannot be read as an
     * entry is reported by its columns and never hides the other rows. */
    async list(): Promise<DeletionJournalListing> {
      await initialize();
      return transaction(async tx => {
        const { rows } = await tx.execute(
          `SELECT * FROM ${TABLE} ORDER BY job_id LIMIT ?`,
          [DELETION_FOUNDATION_LIMITS.journalEntries + 1],
        );
        if (rows.length > DELETION_FOUNDATION_LIMITS.journalEntries)
          throw new DeletionFoundationError('journal_capacity');
        const entries: DeletionJournalEntry[] = [];
        const unreadable: DeletionJournalRowStub[] = [];
        for (const row of rows) {
          const stub = parseRowStub(row);
          try {
            entries.push(parseRow(row));
          } catch (error) {
            if (!(error instanceof DeletionFoundationError)) throw error;
            unreadable.push(stub);
          }
        }
        return Object.freeze({
          entries: Object.freeze(entries),
          unreadable: Object.freeze(unreadable),
        });
      });
    },
    async create(value: DeletionJournalEntry): Promise<DeletionJournalEntry> {
      const entry = parseDeletionJournalEntry(value);
      if (!entry || entry.revision !== 0 || entry.phase !== 'request_pending')
        throw new DeletionFoundationError('journal_invalid');
      await initialize();
      return transaction(async tx => {
        if (await readIn(tx, entry.jobId))
          throw new DeletionFoundationError('journal_conflict');
        const count = await tx.execute(
          `SELECT count(*) AS count FROM ${TABLE}`,
        );
        const size = count.rows[0]?.count;
        if (
          typeof size !== 'number' ||
          size >= DELETION_FOUNDATION_LIMITS.journalEntries
        )
          throw new DeletionFoundationError('journal_capacity');
        await tx.execute(
          `INSERT INTO ${TABLE} (job_id, owner_id, api_origin, operation_id, revision, phase, document) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.jobId,
            entry.ownerId,
            entry.apiOrigin,
            entry.operationId,
            entry.revision,
            entry.phase,
            JSON.stringify(entry),
          ],
        );
        return entry;
      });
    },
    async update(
      previous: DeletionJournalEntry,
      value: DeletionJournalEntry,
    ): Promise<DeletionJournalEntry> {
      const before = parseDeletionJournalEntry(previous);
      const after = parseDeletionJournalEntry(value);
      if (!before || !after)
        throw new DeletionFoundationError('journal_invalid');
      validateTransition(before, after);
      await initialize();
      return transaction(async tx => {
        const current = await readIn(tx, before.jobId);
        if (!current || JSON.stringify(current) !== JSON.stringify(before))
          throw new DeletionFoundationError('stale_handler');
        if (before.operationId === null && after.operationId !== null) {
          const duplicate = await tx.execute(
            `SELECT job_id FROM ${TABLE} WHERE operation_id = ?`,
            [after.operationId],
          );
          if (duplicate.rows.length !== 0)
            throw new DeletionFoundationError('journal_conflict');
        }
        const result = await tx.execute(
          `UPDATE ${TABLE} SET operation_id = ?, revision = ?, phase = '${after.phase}', document = ? WHERE job_id = ? AND revision = ?`,
          [
            after.operationId,
            after.revision,
            JSON.stringify(after),
            after.jobId,
            before.revision,
          ],
        );
        if (result.rowsAffected !== 1)
          throw new DeletionFoundationError('stale_handler');
        return after;
      });
    },
    /** Deletes exactly the row `value` describes (same revision and
     * document); a sealed receipt is never removed. */
    async remove(value: DeletionJournalEntry): Promise<boolean> {
      const entry = parseDeletionJournalEntry(value);
      if (!entry) throw new DeletionFoundationError('journal_invalid');
      if (entry.receipt !== null)
        throw new DeletionFoundationError('journal_conflict');
      await initialize();
      return transaction(async tx => {
        const current = await readIn(tx, entry.jobId);
        if (!current) return false;
        if (JSON.stringify(current) !== JSON.stringify(entry))
          throw new DeletionFoundationError('stale_handler');
        const result = await tx.execute(
          `DELETE FROM ${TABLE} WHERE job_id = ? AND revision = ?`,
          [entry.jobId, entry.revision],
        );
        if (result.rowsAffected !== 1)
          throw new DeletionFoundationError('stale_handler');
        return true;
      });
    },
  });
}
