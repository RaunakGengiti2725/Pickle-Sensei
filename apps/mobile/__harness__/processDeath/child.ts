/**
 * One "app launch" of the shipping saved-analysis flow, run in a plain Node
 * process against a durable on-disk database (see register.js). The parent
 * spawns it twice per kill point: launch 1 dies at the configured step,
 * launch 2 relaunches on the same file and runs the exact code the app runs
 * after a restart — `configureSyncRuntime` + `triggerOutboxSync` (journal
 * recovery, then the outbox drain), `prepareOriginalCaptureAnalysis` (which
 * is idempotent per capture and keeps the ORIGINAL logical operation),
 * `runOriginalCaptureAnalysis` for the same operation, and a final drain.
 *
 * Nothing here decides recovery: the durable state observations are plain
 * SELECTs, and every state transition is made by `src/` modules.
 */
import { readFileSync } from 'node:fs';
import { establishApiSession } from '../../src/account/apiSession';
import { OriginalAnalysisExecution } from '../../src/analysis/originalAnalysisOperations';
import {
  prepareOriginalCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../../src/analysis/runCaptureAnalysis';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb, type LocalDb } from '../../src/data/db';
import { savePendingCapture } from '../../src/data/repository';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import { forDataOwner } from '../../src/data/transactions';
import { dieAtKillPoint, killTriggerFromEnvironment } from './killSwitch';
import {
  BEARER_TOKEN,
  CAPTURE_ID,
  OWNER_ID,
  REPORT_PREFIX,
  type AnalysisRecordRow,
  type AttemptRow,
  type ChildReport,
  type DurableSnapshot,
  type FixtureFile,
  type OperationRow,
  type OutboxRow,
  type OutcomeSummary,
  type ReceiptRow,
  type ShotRow,
} from './report';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the process-death child`);
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected text, got ${value}`);
  return value;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Expected integer: ${value}`);
  return value;
}

function integerOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function payloadField(payload: unknown, key: string): string | null {
  const parsed: unknown = JSON.parse(text(payload));
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

async function rows(
  db: LocalDb,
  sql: string,
): Promise<readonly Record<string, unknown>[]> {
  return (await db.execute(sql)).rows;
}

async function snapshot(db: LocalDb): Promise<DurableSnapshot> {
  const captures = (
    await rows(
      db,
      'SELECT owner_key, id, status FROM local_capture ORDER BY id',
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    id: text(row['id']),
    status: text(row['status']),
  }));
  const operations: OperationRow[] = (
    await rows(
      db,
      `SELECT owner_key, operation_id, capture_id, observation_seal, current_attempt_id,
              final_record_id, winning_attempt_id, completion_kind
       FROM analysis_logical_operations ORDER BY operation_id`,
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    operationId: text(row['operation_id']),
    captureId: text(row['capture_id']),
    observationSealed: row['observation_seal'] !== null,
    currentAttemptId: textOrNull(row['current_attempt_id']),
    finalRecordId: textOrNull(row['final_record_id']),
    winningAttemptId: textOrNull(row['winning_attempt_id']),
    completionKind: textOrNull(row['completion_kind']),
  }));
  const attempts: AttemptRow[] = (
    await rows(
      db,
      `SELECT owner_key, operation_id, capture_id, analysis_id, api_origin, reservation_key,
              state, permit_id, result_id, release_outcome, terminal_reason, technical_failure,
              attempt_ordinal
       FROM analysis_execution_attempts ORDER BY created_at_ms, operation_id`,
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    operationId: text(row['operation_id']),
    captureId: text(row['capture_id']),
    analysisId: text(row['analysis_id']),
    apiOrigin: text(row['api_origin']),
    reservationKey: text(row['reservation_key']),
    state: text(row['state']),
    permitId: textOrNull(row['permit_id']),
    resultId: textOrNull(row['result_id']),
    releaseOutcome: textOrNull(row['release_outcome']),
    terminalReason: textOrNull(row['terminal_reason']),
    technicalFailure: textOrNull(row['technical_failure']),
    attemptOrdinal: integerOrNull(row['attempt_ordinal']),
  }));
  const legacyJournal = integer(
    (await rows(db, 'SELECT count(*) AS n FROM analysis_run_journal'))[0]?.[
      'n'
    ],
  );
  const analysisRecords: AnalysisRecordRow[] = (
    await rows(
      db,
      'SELECT owner_key, id, capture_id FROM local_analysis_record ORDER BY id',
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    id: text(row['id']),
    captureId: text(row['capture_id']),
  }));
  const shots: ShotRow[] = (
    await rows(
      db,
      'SELECT owner_key, id, result_kind, overall_score FROM local_shot ORDER BY id',
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    id: text(row['id']),
    resultKind: text(row['result_kind']),
    overallScore: integerOrNull(row['overall_score']),
  }));
  const outbox: OutboxRow[] = (
    await rows(
      db,
      'SELECT owner_key, id, kind, payload, attempts FROM outbox ORDER BY id',
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    id: integer(row['id']),
    kind: text(row['kind']),
    shotId: payloadField(row['payload'], 'id'),
    analysisPermitId: payloadField(row['payload'], 'analysisPermitId'),
    attempts: integer(row['attempts']),
  }));
  const receipts: ReceiptRow[] = (
    await rows(
      db,
      'SELECT owner_key, kind, entity_id FROM sync_receipt ORDER BY entity_id',
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    kind: text(row['kind']),
    entityId: text(row['entity_id']),
  }));
  return {
    captures,
    operations,
    attempts,
    legacyJournal,
    analysisRecords,
    shots,
    outbox,
    receipts,
  };
}

function summarize(outcome: RunCaptureAnalysisOutcome): OutcomeSummary {
  return {
    kind: outcome.kind,
    replayed: 'replayed' in outcome ? outcome.replayed === true : null,
    reason: 'reason' in outcome ? outcome.reason : null,
    cause: 'cause' in outcome ? (outcome.cause ?? null) : null,
    analysisId: 'analysisId' in outcome ? outcome.analysisId : null,
  };
}

/**
 * Routes the shipping clients' fetch to the parent's rating service and
 * applies an `http` kill trigger: `before` dies with the request unsent,
 * `after` dies once the server has answered (body fully received) but before
 * the shipping client can observe the response — the lost-acknowledgement
 * case.
 */
function installFetch(): void {
  const trigger = killTriggerFromEnvironment();
  if (trigger === null || trigger.kind !== 'http') return;
  const realFetch = globalThis.fetch;
  let seen = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : new URL(String(input)).href;
    const armed =
      url.includes(trigger.pathIncludes) && ++seen === trigger.ordinal;
    if (armed && trigger.phase === 'before') dieAtKillPoint(`http ${url}`);
    const response = await realFetch(input, init);
    if (armed && trigger.phase === 'after') {
      await response.clone().arrayBuffer();
      dieAtKillPoint(`http response ${url}`);
    }
    return response;
  };
}

async function main(): Promise<void> {
  const launch = requireEnv('PD_LAUNCH');
  if (launch !== '1' && launch !== '2')
    throw new Error(`PD_LAUNCH must be 1 or 2, got ${launch}`);
  const apiBaseUrl = requireEnv('PD_API_BASE_URL');
  const proposedOperationId = requireEnv('PD_OPERATION_ID');
  const fixture = JSON.parse(
    readFileSync(requireEnv('PD_FIXTURE_PATH'), 'utf8'),
  ) as FixtureFile;

  installFetch();
  setActiveDataOwner(OWNER_ID);
  const session = {
    canonicalAppUserId: OWNER_ID,
    apiBaseUrl,
    bearerToken: BEARER_TOKEN,
    provider: 'apple' as const,
  };
  establishApiSession(session);

  const db = getDb();
  const asFound = await snapshot(db);
  const ownerContext = captureDataOwnerContext();

  if (launch === '1') {
    await savePendingCapture(
      forDataOwner(db, ownerContext),
      CAPTURE_ID,
      fixture.declaredStroke,
      fixture.clip,
      fixture.declaredStroke,
    );
  }

  configureSyncRuntime(session);
  await triggerOutboxSync();
  const afterRecovery = await snapshot(db);

  const execution = new OriginalAnalysisExecution(ownerContext, apiBaseUrl);
  const request: RunCaptureAnalysisRequest = {
    db,
    ownerContext,
    captureId: CAPTURE_ID,
    clip: fixture.clip,
    declaredStroke: fixture.declaredStroke,
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: apiBaseUrl, token: BEARER_TOKEN },
    appVersion: '0.1.0',
  };
  const operation = await prepareOriginalCaptureAnalysis(
    request,
    execution,
    proposedOperationId,
  );
  const outcome = await runOriginalCaptureAnalysis({
    db,
    execution,
    operationId: operation.operationId,
  });
  await triggerOutboxSync();
  clearSyncRuntime();
  const final = await snapshot(db);

  const report: ChildReport = {
    launch,
    ownerKey: ownerContext.ownerKey,
    apiOrigin: execution.scope.apiOrigin,
    asFound,
    afterRecovery,
    outcome: summarize(outcome),
    final,
  };
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
