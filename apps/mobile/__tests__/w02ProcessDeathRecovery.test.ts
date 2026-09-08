/**
 * W02-03 — process-death recovery for journal / result / outbox.
 *
 * Each case SIGKILLs a real child Node process (the shipping analysis,
 * journal, repository and outbox modules on a file-backed node:sqlite
 * database) at one deterministic step, relaunches it on the same file, and
 * asserts what the shipping recovery path (`configureSyncRuntime` →
 * `triggerOutboxSync` journal recovery → `prepareOriginalCaptureAnalysis` →
 * `runOriginalCaptureAnalysis` → outbox drain) leaves behind:
 *
 *  - kills before any attempt was admitted, or after the result committed,
 *    end with EXACTLY ONE durable scored result, ONE outbox entry that drains
 *    into ONE sync receipt, ONE server shot and ONE server permit — no
 *    duplicate result, shot, outbox row, receipt, operation or permit, and
 *    nothing lost;
 *  - kills after an attempt was admitted but before its result committed end
 *    HELD: the same permit is released `cancelled` under the same reservation
 *    key, zero results / outbox rows / server shots exist, and no second
 *    operation or permit is ever created (no fabricated score, no charge).
 *
 * The harness lives in `__harness__/processDeath/`; nothing under `src/` is
 * modified or reimplemented.
 */
import {
  FIRST_OPERATION_ID,
  RELAUNCH_OPERATION_ID,
  runScenario,
  type LaunchResult,
  type ScenarioResult,
} from '../__harness__/processDeath/harness';
import { KILL_POINTS } from '../__harness__/processDeath/killPoints';
import type {
  ChildReport,
  DurableSnapshot,
} from '../__harness__/processDeath/report';

function reportOf(launch: LaunchResult): ChildReport {
  expect(launch.signal).toBeNull();
  expect(launch.exitCode).toBe(0);
  expect(launch.stderr).toBe('');
  expect(launch.report).not.toBeNull();
  return launch.report as ChildReport;
}

function expectOwnedBy(snapshot: DurableSnapshot, ownerKey: string): void {
  for (const rowsOf of [
    snapshot.captures,
    snapshot.operations,
    snapshot.attempts,
    snapshot.analysisRecords,
    snapshot.shots,
    snapshot.outbox,
    snapshot.receipts,
  ]) {
    for (const row of rowsOf) expect(row.ownerKey).toBe(ownerKey);
  }
  expect(snapshot.legacyJournal).toBe(0);
}

/** Exactly one scored result, drained: one record/shot/receipt, no outbox. */
function expectSingleDurableResult(
  result: ScenarioResult,
  report: ChildReport,
  expectedOperationId: string,
  replayedFromDisk: boolean,
): void {
  const final = report.final;
  expect(report.outcome.kind).toBe('scored');
  expect(report.outcome.replayed).toBe(replayedFromDisk ? true : null);
  const analysisId = report.outcome.analysisId;
  expect(typeof analysisId).toBe('string');

  expect(final.analysisRecords.map(row => row.id)).toEqual([analysisId]);
  expect(final.shots.map(row => row.id)).toEqual([analysisId]);
  expect(final.shots[0]?.resultKind).toBe('scored');
  expect(final.shots[0]?.overallScore).not.toBeNull();
  expect(final.outbox).toEqual([]);
  expect(final.receipts.map(row => [row.kind, row.entityId])).toEqual([
    ['shot.sync', analysisId],
  ]);
  expect(final.captures.map(row => row.status)).toEqual(['analyzed']);

  expect(final.operations).toHaveLength(1);
  const operation = final.operations[0]!;
  expect(operation.operationId).toBe(expectedOperationId);
  expect(operation.observationSealed).toBe(true);
  expect(operation.finalRecordId).toBe(analysisId);
  expect(operation.completionKind).toBe('scored');
  expect(operation.winningAttemptId).toBe(operation.currentAttemptId);

  expect(final.attempts).toHaveLength(1);
  const attempt = final.attempts[0]!;
  expect(attempt.operationId).toBe(operation.currentAttemptId);
  expect(attempt.state).toBe('committed');
  expect(attempt.resultId).toBe(analysisId);
  expect(attempt.apiOrigin).toBe(report.apiOrigin);
  expect(attempt.attemptOrdinal).toBe(1);
  expect(attempt.technicalFailure).toBeNull();
  expect(typeof attempt.permitId).toBe('string');

  // The server saw exactly one permit (consumed by exactly one shot).
  expect(result.server.unrouted).toEqual([]);
  expect(result.server.unauthorized).toEqual([]);
  expect(result.server.permits).toHaveLength(1);
  expect(result.server.permits[0]).toMatchObject({
    id: attempt.permitId,
    idempotencyKey: attempt.reservationKey,
    status: 'finalized',
    outcome: 'scored',
  });
  expect(result.server.shots).toEqual([
    { id: analysisId, permitId: attempt.permitId },
  ]);
}

/** Admitted attempt, no result: released cancelled, nothing fabricated. */
function expectHeldWithoutResult(
  result: ScenarioResult,
  report: ChildReport,
): void {
  const final = report.final;
  expect(report.outcome.kind).toBe('unavailable');
  expect(report.outcome.cause).toBe('recovery_pending');
  expect(report.outcome.analysisId).toBeNull();

  expect(final.analysisRecords).toEqual([]);
  expect(final.shots).toEqual([]);
  expect(final.outbox).toEqual([]);
  expect(final.receipts).toEqual([]);
  expect(final.captures.map(row => row.status)).toEqual(['awaiting_model']);

  expect(final.operations).toHaveLength(1);
  const operation = final.operations[0]!;
  expect(operation.operationId).toBe(FIRST_OPERATION_ID);
  expect(operation.finalRecordId).toBeNull();
  expect(operation.winningAttemptId).toBeNull();
  expect(operation.completionKind).toBeNull();

  expect(final.attempts).toHaveLength(1);
  const attempt = final.attempts[0]!;
  expect(attempt.operationId).toBe(operation.currentAttemptId);
  expect(attempt.state).toBe('released');
  expect(attempt.releaseOutcome).toBe('cancelled');
  expect(attempt.resultId).toBeNull();
  expect(attempt.terminalReason).toBeNull();
  expect(typeof attempt.permitId).toBe('string');

  expect(result.server.unrouted).toEqual([]);
  expect(result.server.unauthorized).toEqual([]);
  expect(result.server.permits).toHaveLength(1);
  expect(result.server.permits[0]).toMatchObject({
    id: attempt.permitId,
    idempotencyKey: attempt.reservationKey,
    status: 'finalized',
    outcome: 'cancelled',
  });
  expect(result.server.shots).toEqual([]);
  // Every reservation the relaunch made reused the original key.
  for (const request of result.server.requests) {
    if (request.path !== '/v1/analysis-permits') continue;
    expect(request.body).toEqual({ idempotencyKey: attempt.reservationKey });
  }
}

describe('W02-03 process-death recovery (child Node process, node:sqlite)', () => {
  it('exercises at least eight deterministic kill points', () => {
    expect(KILL_POINTS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(KILL_POINTS.map(point => point.id)).size).toBe(
      KILL_POINTS.length,
    );
  });

  it('control: an uninterrupted launch scores once and a relaunch replays it without re-rating', async () => {
    const result = await runScenario(null);
    const first = reportOf(result.first);
    const second = reportOf(result.second);
    expect(result.first.killMarker).toBeNull();
    expect(result.second.killMarker).toBeNull();

    expect(first.asFound.captures).toEqual([]);
    expect(first.asFound.operations).toEqual([]);
    expectOwnedBy(first.final, first.ownerKey);
    expectSingleDurableResult(result, first, FIRST_OPERATION_ID, false);

    expect(second.asFound).toEqual(first.final);
    expect(second.afterRecovery).toEqual(first.final);
    expectOwnedBy(second.final, second.ownerKey);
    expectSingleDurableResult(result, second, FIRST_OPERATION_ID, true);
    expect(second.outcome.analysisId).toBe(first.outcome.analysisId);
    expect(second.final).toEqual(first.final);
    // The relaunch issued no further request: replay is served from disk.
    expect(result.server.requests.map(request => request.path)).toEqual([
      '/v1/analysis-permits',
      '/v1/shots:sync',
    ]);
  });

  it.each(KILL_POINTS)(
    'kill at $id → relaunch recovers to exactly one durable outcome',
    async point => {
      const result = await runScenario(point);

      // Launch 1 died by SIGKILL at the configured step and reported nothing.
      expect(result.first.signal).toBe('SIGKILL');
      expect(result.first.exitCode).toBeNull();
      expect(result.first.report).toBeNull();
      expect(result.first.killMarker?.startsWith(`${point.id} `)).toBe(true);

      // Launch 2 observed the durable state BEFORE any recovery ran.
      const second = reportOf(result.second);
      const asFound = second.asFound;
      expectOwnedBy(asFound, second.ownerKey);
      expect(asFound.captures).toHaveLength(point.asFound.captures);
      expect(asFound.operations).toHaveLength(point.asFound.operations);
      expect(asFound.operations[0]?.observationSealed ?? false).toBe(
        point.asFound.observationSealed,
      );
      expect(asFound.attempts.map(attempt => attempt.state)).toEqual(
        point.asFound.attempt === 'none' ? [] : [point.asFound.attempt],
      );
      expect(typeof asFound.attempts[0]?.permitId === 'string').toBe(
        point.asFound.permitRecorded,
      );
      expect(asFound.analysisRecords).toHaveLength(
        point.asFound.analysisRecords,
      );
      expect(asFound.shots).toHaveLength(point.asFound.shots);
      expect(asFound.outbox).toHaveLength(point.asFound.outbox);
      expect(asFound.receipts).toHaveLength(point.asFound.receipts);
      if (point.asFound.outbox === 1) {
        expect(asFound.outbox[0]?.kind).toBe('shot.sync');
        expect(asFound.outbox[0]?.shotId).toBe(asFound.shots[0]?.id);
        expect(asFound.outbox[0]?.analysisPermitId).toBe(
          asFound.attempts[0]?.permitId,
        );
      }
      if (asFound.operations.length === 1) {
        expect(asFound.operations[0]?.operationId).toBe(FIRST_OPERATION_ID);
      }

      expectOwnedBy(second.final, second.ownerKey);
      if (point.relaunch === 'scored') {
        // An operation that survived the kill is continued, never re-created.
        const expectedOperationId =
          point.asFound.operations === 1
            ? FIRST_OPERATION_ID
            : RELAUNCH_OPERATION_ID;
        expectSingleDurableResult(
          result,
          second,
          expectedOperationId,
          point.asFound.shots === 1,
        );
        if (point.asFound.shots === 1) {
          // The committed result is the one the kill left behind.
          expect(second.outcome.analysisId).toBe(asFound.shots[0]?.id);
          expect(second.final.attempts[0]?.permitId).toBe(
            asFound.attempts[0]?.permitId,
          );
        }
      } else {
        expectHeldWithoutResult(result, second);
        if (point.asFound.permitRecorded) {
          expect(second.final.attempts[0]?.permitId).toBe(
            asFound.attempts[0]?.permitId,
          );
        }
      }
    },
  );
});
