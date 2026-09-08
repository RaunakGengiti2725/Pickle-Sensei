/**
 * Deterministic process-death points along the shipping saved-analysis path
 * (`savePendingCapture` → `prepareOriginalCaptureAnalysis` →
 * `runOriginalCaptureAnalysis` → `drainOutbox`). Each point names the step it
 * interrupts and the state the child must leave on disk when SIGKILLed there
 * (a statement applied inside a still-open transaction is rolled back by
 * SQLite on the next open — the `asFound` expectation says what survives),
 * plus what the shipping relaunch (journal recovery → same operation → outbox
 * drain) must produce.
 *
 * Triggers fire inside the harness's node:sqlite adapter (`durableSqlite.ts`)
 * and its fetch wrapper (`child.ts`); the shipping modules are untouched.
 */
export type KillTrigger =
  | {
      readonly kind: 'sql';
      /** Every fragment must appear in the statement text. */
      readonly includes: readonly string[];
      /** 1-based occurrence of a matching statement within the launch. */
      readonly ordinal: number;
      /** `after`: the statement has been applied to the database file (or the
       * open transaction) when the process dies. `before`: it never ran. */
      readonly phase: 'before' | 'after';
    }
  | {
      readonly kind: 'http';
      readonly pathIncludes: string;
      readonly ordinal: number;
      /** `after`: the server has committed and answered; the response never
       * reaches the shipping client. `before`: the request is never sent. */
      readonly phase: 'before' | 'after';
    };

export type AttemptStateOnDisk =
  'none' | 'reserve_pending' | 'reserved' | 'committed';

/** Durable state the kill must leave behind, read before any recovery runs. */
export interface AsFoundExpectation {
  readonly captures: 0 | 1;
  readonly operations: 0 | 1;
  readonly observationSealed: boolean;
  readonly attempt: AttemptStateOnDisk;
  readonly permitRecorded: boolean;
  readonly analysisRecords: 0 | 1;
  readonly shots: 0 | 1;
  readonly outbox: 0 | 1;
  readonly receipts: 0 | 1;
}

/**
 * `scored`: relaunch ends with exactly one durable scored result, one outbox
 * entry that drains into exactly one sync receipt, and one server shot.
 * `held`: an attempt was admitted (a permit was, or may have been, reserved)
 * but no result was committed; the shipping journal recovers by releasing
 * that permit as `cancelled` under the SAME reservation key and the
 * operation stays reconcile-only — zero results, zero outbox rows, zero
 * server shots, no second operation and no second permit. A score is never
 * fabricated for an interrupted attempt.
 */
export type RelaunchExpectation = 'scored' | 'held';

export interface KillPoint {
  readonly id: string;
  readonly step: string;
  readonly trigger: KillTrigger;
  readonly asFound: AsFoundExpectation;
  readonly relaunch: RelaunchExpectation;
}

const CAPTURE_ONLY: AsFoundExpectation = {
  captures: 1,
  operations: 0,
  observationSealed: false,
  attempt: 'none',
  permitRecorded: false,
  analysisRecords: 0,
  shots: 0,
  outbox: 0,
  receipts: 0,
};

const PREPARED: AsFoundExpectation = { ...CAPTURE_ONLY, operations: 1 };
const SEALED: AsFoundExpectation = { ...PREPARED, observationSealed: true };
const RESERVE_PENDING: AsFoundExpectation = {
  ...SEALED,
  attempt: 'reserve_pending',
};
const RESERVED: AsFoundExpectation = {
  ...SEALED,
  attempt: 'reserved',
  permitRecorded: true,
};
const COMMITTED_UNSYNCED: AsFoundExpectation = {
  ...SEALED,
  attempt: 'committed',
  permitRecorded: true,
  analysisRecords: 1,
  shots: 1,
  outbox: 1,
  receipts: 0,
};

export const KILL_POINTS: readonly KillPoint[] = [
  {
    id: 'capture_saved',
    step: 'savePendingCapture committed the local_capture row; the logical operation was never inserted',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO analysis_logical_operations'],
      ordinal: 1,
      phase: 'before',
    },
    asFound: CAPTURE_ONLY,
    relaunch: 'scored',
  },
  {
    id: 'operation_insert_mid_transaction',
    step: 'prepare inserted analysis_logical_operations inside its transaction; the process died before COMMIT, so the row is rolled back',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO analysis_logical_operations'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: CAPTURE_ONLY,
    relaunch: 'scored',
  },
  {
    id: 'seal_update_mid_transaction',
    step: 'operation committed (definition only); the observation_seal/execution_hash UPDATE ran inside its transaction and is rolled back',
    trigger: {
      kind: 'sql',
      includes: ['UPDATE analysis_logical_operations SET observation_seal'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: PREPARED,
    relaunch: 'scored',
  },
  {
    id: 'attempt_insert_mid_transaction',
    step: 'observation sealed durably; analysisAttemptJournal.begin inserted the reserve_pending attempt inside the admission transaction and is rolled back',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO analysis_execution_attempts'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: SEALED,
    relaunch: 'scored',
  },
  {
    id: 'attempt_admitted_before_reserve_request',
    step: 'admission transaction committed (attempt reserve_pending, permit NULL); the reservation request was never sent',
    trigger: {
      kind: 'http',
      pathIncludes: '/v1/analysis-permits',
      ordinal: 1,
      phase: 'before',
    },
    asFound: RESERVE_PENDING,
    relaunch: 'held',
  },
  {
    id: 'permit_reserved_response_lost',
    step: 'server reserved the permit and answered; the response never reached runJournal.reserved',
    trigger: {
      kind: 'http',
      pathIncludes: '/v1/analysis-permits',
      ordinal: 1,
      phase: 'after',
    },
    asFound: RESERVE_PENDING,
    relaunch: 'held',
  },
  {
    id: 'permit_update_mid_transaction',
    step: 'the reserve response arrived; the UPDATE storing permit_id / state=reserved ran inside its transaction and is rolled back (server holds the permit)',
    trigger: {
      kind: 'sql',
      includes: ["THEN 'reserved'"],
      ordinal: 1,
      phase: 'after',
    },
    asFound: RESERVE_PENDING,
    relaunch: 'held',
  },
  {
    id: 'commit_shot_inserted_mid_transaction',
    step: 'attempt durably reserved, inference finished; saveAnalysis inserted local_shot inside the commit transaction (rolled back with the record)',
    trigger: {
      kind: 'sql',
      includes: ['INSERT OR REPLACE INTO local_shot'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: RESERVED,
    relaunch: 'held',
  },
  {
    id: 'commit_outbox_inserted_mid_transaction',
    step: 'saveAnalysis inserted the shot.sync outbox row inside the commit transaction, before analysisAttemptJournal.commit (all rolled back)',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO outbox', "'shot.sync'"],
      ordinal: 1,
      phase: 'after',
    },
    asFound: RESERVED,
    relaunch: 'held',
  },
  {
    id: 'result_committed_before_sync_request',
    step: 'commit transaction durable (record + shot + outbox + committed attempt + final_record_id); the shots:sync request was never sent',
    trigger: {
      kind: 'http',
      pathIncludes: '/v1/shots:sync',
      ordinal: 1,
      phase: 'before',
    },
    asFound: COMMITTED_UNSYNCED,
    relaunch: 'scored',
  },
  {
    id: 'sync_accepted_response_lost',
    step: 'server accepted the shot and consumed the permit; the acknowledgement never reached drainOutbox',
    trigger: {
      kind: 'http',
      pathIncludes: '/v1/shots:sync',
      ordinal: 1,
      phase: 'after',
    },
    asFound: COMMITTED_UNSYNCED,
    relaunch: 'scored',
  },
  {
    id: 'receipt_inserted_mid_transaction',
    step: 'drainOutbox inserted sync_receipt inside the acknowledgement transaction, before the outbox DELETE',
    trigger: {
      kind: 'sql',
      includes: ['INSERT OR REPLACE INTO sync_receipt'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: COMMITTED_UNSYNCED,
    relaunch: 'scored',
  },
];

export function killPointById(id: string): KillPoint {
  const point = KILL_POINTS.find(candidate => candidate.id === id);
  if (!point) throw new Error(`Unknown process-death kill point: ${id}`);
  return point;
}
