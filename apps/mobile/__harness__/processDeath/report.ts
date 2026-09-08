/**
 * Wire contract between the parent harness and the child process: the child
 * prints exactly one `PD_REPORT <json>` line on stdout; the parent parses it.
 * A launch that dies at its kill point prints a `PD_KILL <id>` line on stderr
 * instead (written synchronously before SIGKILL).
 */
import type { CapturedClip } from '../../src/camera/capture';

export const OWNER_ID = '11111111-1111-4111-8111-111111111111';
export const CAPTURE_ID = '33333333-3333-4333-8333-333333333333';
export const BEARER_TOKEN = 'process-death-harness-bearer';
export const REPORT_PREFIX = 'PD_REPORT ';

/** Environment the parent hands to every child launch. */
export interface ChildEnvironment {
  readonly PD_DB_PATH: string;
  readonly PD_FIXTURE_PATH: string;
  readonly PD_API_BASE_URL: string;
  /** Proposed logical operation id for this launch; `prepare` is idempotent
   * per capture, so a relaunch keeps the original definition instead. */
  readonly PD_OPERATION_ID: string;
  /** '1' seeds the capture (first launch); '2' relaunches on the same file. */
  readonly PD_LAUNCH: '1' | '2';
  /** JSON `KillTrigger`; absent on relaunch and on the control run. The
   * parent never inherits these from its own environment (see harness). */
  readonly PD_KILL?: string;
  readonly PD_KILL_ID?: string;
}

export interface FixtureFile {
  readonly clip: CapturedClip;
  readonly declaredStroke: 'forehand_drive';
}

export interface OperationRow {
  readonly ownerKey: string;
  readonly operationId: string;
  readonly captureId: string;
  readonly observationSealed: boolean;
  readonly currentAttemptId: string | null;
  readonly finalRecordId: string | null;
  readonly winningAttemptId: string | null;
  readonly completionKind: string | null;
}

export interface AttemptRow {
  readonly ownerKey: string;
  readonly operationId: string;
  readonly captureId: string;
  readonly analysisId: string;
  readonly apiOrigin: string;
  readonly reservationKey: string;
  readonly state: string;
  readonly permitId: string | null;
  readonly resultId: string | null;
  readonly releaseOutcome: string | null;
  readonly terminalReason: string | null;
  readonly technicalFailure: string | null;
  readonly attemptOrdinal: number | null;
}

export interface ShotRow {
  readonly ownerKey: string;
  readonly id: string;
  readonly resultKind: string;
  readonly overallScore: number | null;
}

export interface OutboxRow {
  readonly ownerKey: string;
  readonly id: number;
  readonly kind: string;
  readonly shotId: string | null;
  readonly analysisPermitId: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface ReceiptRow {
  readonly ownerKey: string;
  readonly kind: string;
  readonly entityId: string;
}

export interface AnalysisRecordRow {
  readonly ownerKey: string;
  readonly id: string;
  readonly captureId: string;
}

/** Every durable table the objective cares about, read straight from SQLite. */
export interface DurableSnapshot {
  readonly captures: readonly {
    ownerKey: string;
    id: string;
    status: string;
  }[];
  readonly operations: readonly OperationRow[];
  readonly attempts: readonly AttemptRow[];
  readonly legacyJournal: number;
  readonly analysisRecords: readonly AnalysisRecordRow[];
  readonly shots: readonly ShotRow[];
  readonly outbox: readonly OutboxRow[];
  readonly receipts: readonly ReceiptRow[];
}

export interface OutcomeSummary {
  readonly kind: string;
  readonly replayed: boolean | null;
  readonly reason: string | null;
  readonly cause: string | null;
  readonly analysisId: string | null;
}

export interface ChildReport {
  readonly launch: '1' | '2';
  readonly ownerKey: string;
  readonly apiOrigin: string;
  /** Read after the shipping schema open, before any recovery or sync. */
  readonly asFound: DurableSnapshot;
  /** After `configureSyncRuntime` + `triggerOutboxSync` (journal recovery + drain). */
  readonly afterRecovery: DurableSnapshot;
  readonly outcome: OutcomeSummary;
  /** After the saved-analysis run and the final outbox drain. */
  readonly final: DurableSnapshot;
}
