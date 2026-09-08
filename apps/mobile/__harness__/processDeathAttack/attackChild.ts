/**
 * Adversarial variant of the candidate's process-death child. It runs the
 * SAME shipping saved-analysis path (`savePendingCapture` →
 * `configureSyncRuntime`/`triggerOutboxSync` → `prepareOriginalCaptureAnalysis`
 * → `runOriginalCaptureAnalysis` → drain) against the same durable database,
 * but lets the parent vary what the candidate hard-codes:
 *
 * - `PD_OWNER_ID` / `PD_BEARER_TOKEN`: relaunch as a DIFFERENT signed-in
 *   account (interleaved account switch across a crash);
 * - `PD_MODE=recover_only`: only the launch-time recovery/drain runs — what
 *   the app does when the relaunched user never re-opens the capture;
 * - `PD_CLOCK_OFFSET_MS`: skews `Date.now()` for the whole relaunch (clock
 *   rollback / far-future clock between crash and relaunch).
 *
 * As in the candidate child, nothing here decides recovery: observations are
 * plain SELECTs and every transition is made by `src/` modules.
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
import {
  dieAtKillPoint,
  killTriggerFromEnvironment,
} from '../processDeath/killSwitch';
import {
  BEARER_TOKEN,
  CAPTURE_ID,
  OWNER_ID,
  REPORT_PREFIX,
  type AnalysisRecordRow,
  type AttemptRow,
  type DurableSnapshot,
  type FixtureFile,
  type OperationRow,
  type OutboxRow,
  type OutcomeSummary,
  type ReceiptRow,
  type ShotRow,
} from '../processDeath/report';
import type { AttackChildReport } from './attackReport';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the attack child`);
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

function installClockSkew(): number {
  const raw = process.env['PD_CLOCK_OFFSET_MS'];
  if (!raw) return 0;
  const offset = Number(raw);
  if (!Number.isFinite(offset))
    throw new Error(`PD_CLOCK_OFFSET_MS must be finite, got ${raw}`);
  const realNow = Date.now;
  Date.now = () => realNow() + offset;
  return offset;
}

async function main(): Promise<void> {
  const launch = requireEnv('PD_LAUNCH');
  if (launch !== '1' && launch !== '2')
    throw new Error(`PD_LAUNCH must be 1 or 2, got ${launch}`);
  const mode = process.env['PD_MODE'] ?? 'full';
  if (mode !== 'full' && mode !== 'recover_only')
    throw new Error(`PD_MODE must be full or recover_only, got ${mode}`);
  const apiBaseUrl = requireEnv('PD_API_BASE_URL');
  const proposedOperationId = requireEnv('PD_OPERATION_ID');
  const ownerId = process.env['PD_OWNER_ID'] ?? OWNER_ID;
  const bearerToken = process.env['PD_BEARER_TOKEN'] ?? BEARER_TOKEN;
  const fixture = JSON.parse(
    readFileSync(requireEnv('PD_FIXTURE_PATH'), 'utf8'),
  ) as FixtureFile;

  const clockOffsetMs = installClockSkew();
  installFetch();
  setActiveDataOwner(ownerId);
  const session = {
    canonicalAppUserId: ownerId,
    apiBaseUrl,
    bearerToken,
    provider: 'apple' as const,
  };
  establishApiSession(session);

  const db = getDb();
  const asFound = await snapshot(db);
  const ownerContext = captureDataOwnerContext();

  if (launch === '1' && mode === 'full') {
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
  let outcome: OutcomeSummary | null = null;
  if (mode === 'full') {
    const request: RunCaptureAnalysisRequest = {
      db,
      ownerContext,
      captureId: CAPTURE_ID,
      clip: fixture.clip,
      declaredStroke: fixture.declaredStroke,
      declaredCanonical: 'FOREHAND_DRIVE',
      handedness: 'right',
      cameraView: 'side',
      apiConfig: { baseUrl: apiBaseUrl, token: bearerToken },
      appVersion: '0.1.0',
    };
    const operation = await prepareOriginalCaptureAnalysis(
      request,
      execution,
      proposedOperationId,
    );
    outcome = summarize(
      await runOriginalCaptureAnalysis({
        db,
        execution,
        operationId: operation.operationId,
      }),
    );
    await triggerOutboxSync();
  }
  clearSyncRuntime();
  const final = await snapshot(db);

  const report: AttackChildReport = {
    launch,
    mode,
    clockOffsetMs,
    ownerKey: ownerContext.ownerKey,
    apiOrigin: execution.scope.apiOrigin,
    asFound,
    afterRecovery,
    outcome,
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
