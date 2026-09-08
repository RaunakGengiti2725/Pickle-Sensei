/**
 * W02-03 adversarial suite — attacks the candidate process-death harness
 * (8fb2d82d) at boundaries its own twelve kill points do not reach:
 *
 *  A. more kill points inside the shipping commit / drain transactions;
 *  B. a SECOND crash during the relaunch's journal recovery, followed by a
 *     third launch that must still reconcile to exactly one permit;
 *  C. network failures during recovery (429 + Retry-After, 5xx, dropped
 *     socket, hanging response, 409 already-finalized) — permit conservation;
 *  D. corrupt / partial persisted state and clock skew between launches;
 *  E. an account switch between the crash and the relaunch (same file).
 *
 * Every case is a real kill of a real child Node process on a file-backed
 * node:sqlite database; the candidate's harness, child and rating service
 * are reused unchanged (see `__harness__/processDeathAttack/`).
 */
import {
  FIRST_OPERATION_ID,
  RELAUNCH_OPERATION_ID,
  runScenario,
  type LaunchResult,
} from '../__harness__/processDeath/harness';
import {
  killPointById,
  type AsFoundExpectation,
  type KillPoint,
  type KillTrigger,
} from '../__harness__/processDeath/killPoints';
import { CAPTURE_ID, OWNER_ID } from '../__harness__/processDeath/report';
import type {
  ChildReport,
  DurableSnapshot,
} from '../__harness__/processDeath/report';
import type { ServerSnapshot } from '../__harness__/processDeath/ratingService';
import {
  OTHER_OWNER_ID,
  THIRD_OPERATION_ID,
  queryDatabase,
  runSequence,
  type LaunchOutcome,
  type SequenceResult,
} from '../__harness__/processDeathAttack/attackHarness';

const SEALED: AsFoundExpectation = {
  captures: 1,
  operations: 1,
  observationSealed: true,
  attempt: 'none',
  permitRecorded: false,
  analysisRecords: 0,
  shots: 0,
  outbox: 0,
  receipts: 0,
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
};

function sql(
  includes: string[],
  ordinal = 1,
  phase: 'before' | 'after' = 'after',
): KillTrigger {
  return { kind: 'sql', includes, ordinal, phase };
}
function httpKill(
  pathIncludes: string,
  ordinal = 1,
  phase: 'before' | 'after' = 'after',
): KillTrigger {
  return { kind: 'http', pathIncludes, ordinal, phase };
}

function reportOf(launch: LaunchResult): ChildReport {
  expect(launch.signal).toBeNull();
  expect(launch.exitCode === 0 ? '' : launch.stderr).toBe('');
  expect(launch.exitCode).toBe(0);
  expect(launch.report).not.toBeNull();
  return launch.report as ChildReport;
}

function expectKilled(launch: LaunchResult, id: string): void {
  expect(launch.signal).toBe('SIGKILL');
  expect(launch.exitCode).toBeNull();
  expect(launch.report).toBeNull();
  expect(launch.killMarker?.startsWith(`${id} `)).toBe(true);
}

function expectAsFound(
  asFound: DurableSnapshot,
  expectation: AsFoundExpectation,
): void {
  expect(asFound.captures).toHaveLength(expectation.captures);
  expect(asFound.operations).toHaveLength(expectation.operations);
  expect(asFound.operations[0]?.observationSealed ?? false).toBe(
    expectation.observationSealed,
  );
  expect(asFound.attempts.map(attempt => attempt.state)).toEqual(
    expectation.attempt === 'none' ? [] : [expectation.attempt],
  );
  expect(typeof asFound.attempts[0]?.permitId === 'string').toBe(
    expectation.permitRecorded,
  );
  expect(asFound.analysisRecords).toHaveLength(expectation.analysisRecords);
  expect(asFound.shots).toHaveLength(expectation.shots);
  expect(asFound.outbox).toHaveLength(expectation.outbox);
  expect(asFound.receipts).toHaveLength(expectation.receipts);
}

/** One scored result, drained, one consumed permit — the candidate's own
 * "single durable result" contract, applied to any launch's report. */
function expectSingleDurableResult(
  server: ServerSnapshot,
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
  expect(final.outbox).toEqual([]);
  expect(final.receipts.map(row => [row.kind, row.entityId])).toEqual([
    ['shot.sync', analysisId],
  ]);
  expect(final.captures.map(row => row.status)).toEqual(['analyzed']);
  expect(final.operations).toHaveLength(1);
  expect(final.operations[0]?.operationId).toBe(expectedOperationId);
  expect(final.operations[0]?.finalRecordId).toBe(analysisId);
  expect(final.attempts).toHaveLength(1);
  const attempt = final.attempts[0]!;
  expect(attempt.state).toBe('committed');
  expect(attempt.resultId).toBe(analysisId);
  expect(server.unrouted).toEqual([]);
  expect(server.unauthorized).toEqual([]);
  expect(server.permits).toHaveLength(1);
  expect(server.permits[0]).toMatchObject({
    id: attempt.permitId,
    idempotencyKey: attempt.reservationKey,
    status: 'finalized',
    outcome: 'scored',
  });
  expect(server.shots).toEqual([
    { id: analysisId, permitId: attempt.permitId },
  ]);
}

/** Admitted attempt, no result: held, the ONE permit released `cancelled`
 * under the ONE reservation key, nothing fabricated, nothing consumed. */
function expectHeldCancelled(
  server: ServerSnapshot,
  report: ChildReport,
): void {
  const final = report.final;
  expect(report.outcome.kind).toBe('unavailable');
  expect(report.outcome.cause).toBe('recovery_pending');
  expect(final.analysisRecords).toEqual([]);
  expect(final.shots).toEqual([]);
  expect(final.outbox).toEqual([]);
  expect(final.receipts).toEqual([]);
  expect(final.captures.map(row => row.status)).toEqual(['awaiting_model']);
  expect(final.operations).toHaveLength(1);
  expect(final.operations[0]?.operationId).toBe(FIRST_OPERATION_ID);
  expect(final.operations[0]?.finalRecordId).toBeNull();
  expect(final.attempts).toHaveLength(1);
  const attempt = final.attempts[0]!;
  expect(attempt.state).toBe('released');
  expect(attempt.releaseOutcome).toBe('cancelled');
  expect(attempt.terminalReason).toBeNull();
  expect(typeof attempt.permitId).toBe('string');
  expectPermitConserved(server, attempt.reservationKey);
  expect(server.permits[0]).toMatchObject({
    id: attempt.permitId,
    idempotencyKey: attempt.reservationKey,
    status: 'finalized',
    outcome: 'cancelled',
  });
  expect(server.shots).toEqual([]);
}

/** The server ever issued ONE permit, and every reservation request across
 * every launch reused that one key. */
function expectPermitConserved(
  server: ServerSnapshot,
  reservationKey: string,
): void {
  expect(server.unrouted).toEqual([]);
  expect(server.unauthorized).toEqual([]);
  expect(server.permits).toHaveLength(1);
  for (const request of server.requests) {
    if (request.path !== '/v1/analysis-permits') continue;
    expect(request.body).toEqual({ idempotencyKey: reservationKey });
  }
}

function finalizeRequests(launch: LaunchOutcome): string[] {
  return (launch.proxy?.seen ?? []).filter(line => line.endsWith('/finalize'));
}

function launchesOf(result: SequenceResult): LaunchOutcome[] {
  return [...result.launches];
}

// ---------------------------------------------------------------------------
// A. Additional kill points inside the shipping transactions (launch 1)
// ---------------------------------------------------------------------------

const EXTRA_KILL_POINTS: readonly KillPoint[] = [
  {
    id: 'attack_record_inserted_mid_transaction',
    step: 'commit(): local_analysis_record inserted, transaction still open',
    trigger: sql(['INSERT INTO local_analysis_record']),
    asFound: RESERVED,
    relaunch: 'held',
  },
  {
    id: 'attack_capture_marked_analyzed_mid_transaction',
    step: 'commit(): local_capture marked analyzed, transaction still open',
    trigger: sql(["UPDATE local_capture SET status = 'analyzed'"]),
    asFound: RESERVED,
    relaunch: 'held',
  },
  {
    id: 'attack_attempt_committed_mid_transaction',
    step: 'commit(): attempt row moved to committed, transaction still open',
    trigger: sql(["SET state = 'committed'"]),
    asFound: RESERVED,
    relaunch: 'held',
  },
  {
    id: 'attack_operation_finalized_mid_transaction',
    step: 'commit(): final_record_id written, transaction still open',
    trigger: sql(['SET final_record_id = ?']),
    asFound: RESERVED,
    relaunch: 'held',
  },
  {
    id: 'attack_current_attempt_pointer_mid_transaction',
    step: 'admit(): current_attempt_id pointed at the new attempt, transaction still open',
    trigger: sql(['SET current_attempt_id = ?']),
    asFound: SEALED,
    relaunch: 'scored',
  },
  {
    id: 'attack_outbox_deleted_mid_transaction',
    step: 'drainOutbox(): accepted row deleted, receipt transaction still open',
    trigger: sql(['DELETE FROM outbox WHERE owner_key = ? AND id = ?']),
    asFound: COMMITTED_UNSYNCED,
    relaunch: 'scored',
  },
];

describe('A. extra kill points inside shipping transactions', () => {
  it.each(EXTRA_KILL_POINTS)(
    'kill at $id → relaunch reconciles to one outcome',
    async point => {
      const result = await runScenario(point);
      expectKilled(result.first, point.id);
      const second = reportOf(result.second);
      expectAsFound(second.asFound, point.asFound);
      if (point.relaunch === 'scored') {
        expectSingleDurableResult(
          result.server,
          second,
          FIRST_OPERATION_ID,
          point.asFound.shots === 1,
        );
        if (point.asFound.shots === 1) {
          expect(second.outcome.analysisId).toBe(second.asFound.shots[0]?.id);
        }
      } else {
        expectHeldCancelled(result.server, second);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// B. Second crash DURING journal recovery, third launch must reconcile
// ---------------------------------------------------------------------------

interface RecoveryKill {
  readonly id: string;
  readonly seed: string;
  readonly trigger: KillTrigger;
}

const RECOVERY_KILLS: readonly RecoveryKill[] = [
  {
    id: 'attack_recovery_release_pending_written',
    seed: 'permit_reserved_response_lost',
    trigger: sql(["SET state = 'release_pending', release_outcome = ?"]),
  },
  {
    id: 'attack_recovery_attempt_count_bumped',
    seed: 'permit_reserved_response_lost',
    trigger: sql(['SET attempt_count = MIN(attempt_count + 1']),
  },
  {
    id: 'attack_recovery_reserve_replay_response_lost',
    seed: 'permit_reserved_response_lost',
    trigger: httpKill('/v1/analysis-permits', 1, 'after'),
  },
  {
    id: 'attack_recovery_permit_recorded_mid_transaction',
    seed: 'permit_reserved_response_lost',
    trigger: sql(["THEN 'reserved'"]),
  },
  {
    id: 'attack_recovery_finalize_request_unsent',
    seed: 'permit_reserved_response_lost',
    trigger: httpKill('/finalize', 1, 'before'),
  },
  {
    id: 'attack_recovery_finalize_response_lost',
    seed: 'permit_reserved_response_lost',
    trigger: httpKill('/finalize', 1, 'after'),
  },
  {
    id: 'attack_recovery_released_written_mid_transaction',
    seed: 'permit_reserved_response_lost',
    trigger: sql(["SET state = 'released'"]),
  },
  {
    id: 'attack_recovery_finalize_response_lost_from_reserved',
    seed: 'commit_shot_inserted_mid_transaction',
    trigger: httpKill('/finalize', 1, 'after'),
  },
  {
    id: 'attack_recovery_released_written_from_reserved',
    seed: 'commit_shot_inserted_mid_transaction',
    trigger: sql(["SET state = 'released'"]),
  },
];

describe('B. second crash during journal recovery', () => {
  it.each(RECOVERY_KILLS)(
    '$seed, then kill at $id during relaunch → third launch holds with one permit',
    async ({ id, seed, trigger }) => {
      const point = killPointById(seed);
      const result = await runSequence([
        { launch: '1', operationId: FIRST_OPERATION_ID, kill: point },
        {
          launch: '2',
          operationId: RELAUNCH_OPERATION_ID,
          kill: { id, trigger },
        },
        { launch: '2', operationId: THIRD_OPERATION_ID },
      ]);
      const [first, second, third] = launchesOf(result);
      expectKilled(first!, seed);
      expectKilled(second!, id);
      const report = reportOf(third!);
      expect(report.asFound.operations).toHaveLength(1);
      expect(report.asFound.attempts).toHaveLength(1);
      expectHeldCancelled(result.server, report);
      // No launch ever created a second operation or attempt.
      expect(
        queryDatabase(
          result.dbPath,
          'SELECT count(*) AS n FROM analysis_execution_attempts',
        ),
      ).toEqual([{ n: 1 }]);
    },
  );
});

// ---------------------------------------------------------------------------
// C. Network failures during recovery — permit conservation
// ---------------------------------------------------------------------------

describe('C. network failures during recovery', () => {
  it('429 + Retry-After on the recovery finalize: the same permit is released on the next pass, never re-reserved', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        faults: [
          {
            pathIncludes: '/finalize',
            ordinal: 1,
            fault: {
              kind: 'status',
              status: 429,
              headers: { 'retry-after': '30' },
              body: { error: { code: 'rate_limited', message: 'Slow down.' } },
            },
          },
        ],
      },
      { launch: '2', operationId: THIRD_OPERATION_ID },
    ]);
    const [, second, third] = launchesOf(result);
    expect(second!.proxy?.injected).toHaveLength(1);
    const throttled = reportOf(second!);
    // The launch's second recovery pass (after the run) re-sends the same
    // finalize; only that one reaches the service.
    expect(finalizeRequests(second!)).toHaveLength(2);
    expect(
      result.server.requests.filter(r => r.path.endsWith('/finalize')),
    ).toHaveLength(1);
    expectHeldCancelled(result.server, throttled);
    expectHeldCancelled(result.server, reportOf(third!));
  });

  it('500 on the recovery reserve replay is retried under the SAME reservation key, yielding the same permit', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        faults: [
          {
            method: 'POST',
            pathIncludes: '/v1/analysis-permits',
            ordinal: 1,
            fault: { kind: 'status', status: 500 },
          },
        ],
      },
      { launch: '2', operationId: THIRD_OPERATION_ID },
    ]);
    const [, second, third] = launchesOf(result);
    expect(second!.proxy?.injected).toEqual([
      'POST /functions/v1/api/v1/analysis-permits',
    ]);
    const failed = reportOf(second!);
    expect(
      second!.proxy?.seen.filter(
        line => line === 'POST /functions/v1/api/v1/analysis-permits',
      ),
    ).toHaveLength(2);
    expectHeldCancelled(result.server, failed);
    expectHeldCancelled(result.server, reportOf(third!));
  });

  it('a dropped socket on the recovery finalize is retried against the same permit, not consumed', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        faults: [
          { pathIncludes: '/finalize', ordinal: 1, fault: { kind: 'drop' } },
        ],
      },
      { launch: '2', operationId: THIRD_OPERATION_ID },
    ]);
    const [, second, third] = launchesOf(result);
    expect(second!.proxy?.injected).toHaveLength(1);
    const dropped = reportOf(second!);
    expect(finalizeRequests(second!)).toHaveLength(2);
    expectHeldCancelled(result.server, dropped);
    expectHeldCancelled(result.server, reportOf(third!));
  });

  it('a finalize that never answers blocks the launch (no request deadline) but consumes nothing; the next launch reconciles', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        faults: [
          { pathIncludes: '/finalize', ordinal: 1, fault: { kind: 'hang' } },
        ],
        timeoutMs: 15_000,
      },
      { launch: '2', operationId: THIRD_OPERATION_ID },
    ]);
    const [, second, third] = launchesOf(result);
    expect(second!.proxy?.injected).toHaveLength(1);
    // The shipping recovery has no request deadline: the launch is still
    // waiting on the hung finalize when the 15s harness guard fires.
    expect(second!.timedOut).toBe(true);
    expect(second!.signal).toBe('SIGKILL');
    expect(second!.report).toBeNull();
    expectHeldCancelled(result.server, reportOf(third!));
  });

  it('409 permit_already_finalized (server-side sweep) on the recovery finalize ends terminal without a new permit', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        faults: [
          {
            pathIncludes: '/finalize',
            ordinal: 1,
            fault: {
              kind: 'status',
              status: 409,
              body: {
                error: {
                  code: 'access.permit_already_finalized',
                  message: 'Analysis permit was already finalized as expired.',
                },
              },
            },
          },
        ],
      },
      { launch: '2', operationId: THIRD_OPERATION_ID },
    ]);
    const [, second, third] = launchesOf(result);
    const swept = reportOf(second!);
    expect(swept.outcome.kind).not.toBe('scored');
    expect(swept.final.attempts).toHaveLength(1);
    expect(swept.final.attempts[0]).toMatchObject({
      state: 'terminal',
      terminalReason: 'permit_already_finalized',
    });
    const after = reportOf(third!);
    expect(after.outcome.kind).not.toBe('scored');
    expect(after.final.attempts).toHaveLength(1);
    expect(after.final.shots).toEqual([]);
    expect(after.final.analysisRecords).toEqual([]);
    expectPermitConserved(
      result.server,
      swept.final.attempts[0]!.reservationKey,
    );
    expect(result.server.shots).toEqual([]);
  });

  it('503 on the post-commit shots:sync keeps the single outbox row; the next launch delivers it exactly once', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('result_committed_before_sync_request'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        faults: [
          {
            pathIncludes: '/v1/shots:sync',
            ordinal: 'all',
            fault: {
              kind: 'status',
              status: 503,
              headers: { 'retry-after': '5' },
            },
          },
        ],
      },
      { launch: '2', operationId: THIRD_OPERATION_ID },
    ]);
    const [, second, third] = launchesOf(result);
    const unsynced = reportOf(second!);
    expect(second!.proxy?.injected.length).toBeGreaterThanOrEqual(1);
    expect(unsynced.outcome.kind).toBe('scored');
    expect(unsynced.outcome.replayed).toBe(true);
    expect(unsynced.final.outbox).toHaveLength(1);
    expect(unsynced.final.receipts).toEqual([]);
    expect(unsynced.final.shots).toHaveLength(1);
    const delivered = reportOf(third!);
    expectSingleDurableResult(
      result.server,
      delivered,
      FIRST_OPERATION_ID,
      true,
    );
    expect(delivered.outcome.analysisId).toBe(unsynced.outcome.analysisId);
  });
});

// ---------------------------------------------------------------------------
// D. Corrupt / partial persisted state and clock skew between launches
// ---------------------------------------------------------------------------

describe('D. corrupt or partial persisted state between launches', () => {
  it('a committed result whose local_shot row vanished is never re-rated: no second permit, no fabricated score', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('result_committed_before_sync_request'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        mutate: ['DELETE FROM local_shot'],
      },
    ]);
    const [, second] = launchesOf(result);
    const report = reportOf(second!);
    expect(report.asFound.shots).toEqual([]);
    expect(report.asFound.attempts[0]?.state).toBe('committed');
    expect(report.outcome.kind).not.toBe('scored');
    expect(report.final.operations).toHaveLength(1);
    expect(report.final.attempts).toHaveLength(1);
    expect(report.final.shots).toEqual([]);
    expectPermitConserved(
      result.server,
      report.final.attempts[0]!.reservationKey,
    );
    expect(result.server.shots.length).toBeLessThanOrEqual(1);
  });

  it('a committed result whose record is not JSON is held, not re-rated', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('result_committed_before_sync_request'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        mutate: ["UPDATE local_analysis_record SET record = '{not json'"],
      },
    ]);
    const [, second] = launchesOf(result);
    const report = reportOf(second!);
    expect(report.outcome.kind).not.toBe('scored');
    expect(report.final.operations).toHaveLength(1);
    expect(report.final.attempts).toHaveLength(1);
    expect(report.final.analysisRecords).toHaveLength(1);
    expectPermitConserved(
      result.server,
      report.final.attempts[0]!.reservationKey,
    );
  });

  it('an outbox payload of the wrong shape never consumes the permit and never produces a receipt', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('result_committed_before_sync_request'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        mutate: [`UPDATE outbox SET payload = '{"garbage":true}'`],
      },
    ]);
    const [, second] = launchesOf(result);
    const report = reportOf(second!);
    expect(report.final.receipts).toEqual([]);
    expect(report.final.operations).toHaveLength(1);
    expect(report.final.attempts).toHaveLength(1);
    expect(result.server.shots).toEqual([]);
    expectPermitConserved(
      result.server,
      report.final.attempts[0]!.reservationKey,
    );
    expect(result.server.permits[0]).toMatchObject({ status: 'reserved' });
  });

  it('a reserved attempt pointing at a permit the server never issued goes terminal; no new reservation key is ever used', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('commit_shot_inserted_mid_transaction'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        // The shipping triggers refuse this write; the schema open recreates
        // them, so the relaunch runs with every guard back in place.
        mutate: [
          'DROP TRIGGER analysis_execution_attempts_monotonic',
          "UPDATE analysis_execution_attempts SET permit_id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099'",
        ],
      },
      { launch: '2', operationId: THIRD_OPERATION_ID },
    ]);
    const [, second, third] = launchesOf(result);
    const report = reportOf(second!);
    expect(report.outcome.kind).not.toBe('scored');
    expect(report.final.attempts).toHaveLength(1);
    expect(report.final.attempts[0]).toMatchObject({
      state: 'terminal',
      terminalReason: 'permit_not_found',
    });
    const after = reportOf(third!);
    expect(after.outcome.kind).not.toBe('scored');
    expect(after.final.attempts).toHaveLength(1);
    expect(after.final.shots).toEqual([]);
    expectPermitConserved(
      result.server,
      report.final.attempts[0]!.reservationKey,
    );
    expect(result.server.shots).toEqual([]);
  });

  it('far-future journal clocks (created 10 years ahead) still recover to one released permit', async () => {
    const ahead = 10 * 365 * 24 * 60 * 60 * 1000;
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        mutate: [
          'DROP TRIGGER analysis_execution_attempts_monotonic',
          'DROP TRIGGER analysis_logical_operations_immutable',
          `UPDATE analysis_execution_attempts SET created_at_ms = created_at_ms + ${ahead}, updated_at_ms = updated_at_ms + ${ahead}`,
          `UPDATE analysis_logical_operations SET created_at_ms = created_at_ms + ${ahead}, updated_at_ms = updated_at_ms + ${ahead}`,
        ],
      },
    ]);
    const [, second] = launchesOf(result);
    expectHeldCancelled(result.server, reportOf(second!));
  });

  it('an operation whose capture row vanished is not re-created under a new id and reserves nothing', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        mutate: ['DELETE FROM local_capture'],
        timeoutMs: 20_000,
      },
    ]);
    const [, second] = launchesOf(result);
    expect(second!.timedOut).toBe(false);
    expect(second!.signal).toBeNull();
    // Whatever the launch did (report or clean failure), the server saw one
    // permit and it was not consumed.
    expect(result.server.permits).toHaveLength(1);
    expect(result.server.shots).toEqual([]);
    expect(
      queryDatabase(
        result.dbPath,
        'SELECT count(*) AS n FROM analysis_logical_operations',
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      queryDatabase(
        result.dbPath,
        'SELECT count(*) AS n FROM analysis_execution_attempts',
      ),
    ).toEqual([{ n: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// F. Harness robustness / runtime
// ---------------------------------------------------------------------------

describe('F. candidate harness robustness', () => {
  it('a non-JSON outbox payload on disk makes the candidate child crash in its own snapshot (exit 1) before any recovery is observed', async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('result_committed_before_sync_request'),
      },
      {
        launch: '2',
        operationId: RELAUNCH_OPERATION_ID,
        mutate: ["UPDATE outbox SET payload = '{'"],
      },
    ]);
    const [, second] = launchesOf(result);
    // Break in the candidate harness: the state is on disk, the shipping
    // drain never ran, and nothing about it can be asserted.
    expect(second!.signal).toBeNull();
    expect(second!.exitCode).toBe(1);
    expect(second!.report).toBeNull();
    expect(second!.stderr).toContain('SyntaxError');
    expect(second!.stderr).toContain('payloadField');
    expect(result.server.shots).toEqual([]);
    expect(result.server.permits[0]).toMatchObject({ status: 'reserved' });
  });

  it('a control launch writes nothing to stderr on the CI runtime (the candidate suite asserts stderr === "")', async () => {
    const result = await runScenario(null);
    expect(result.first.exitCode).toBe(0);
    expect(result.first.stderr).toBe('');
    expect(result.second.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// E. Account switch between the crash and the relaunch (same file)
// ---------------------------------------------------------------------------

describe('E. account switch on the same durable file', () => {
  it("another owner relaunching on the same file cannot continue, release or consume the crashed owner's attempt", async () => {
    const result = await runSequence([
      {
        launch: '1',
        operationId: FIRST_OPERATION_ID,
        kill: killPointById('permit_reserved_response_lost'),
      },
      // Owner B signs in on the same device and analyses their own capture
      // (same capture id — ids are only unique per owner).
      { launch: '1', operationId: THIRD_OPERATION_ID, ownerId: OTHER_OWNER_ID },
      // Owner A signs back in.
      { launch: '2', operationId: RELAUNCH_OPERATION_ID, ownerId: OWNER_ID },
    ]);
    const [first, other, back] = launchesOf(result);
    expectKilled(first!, 'permit_reserved_response_lost');

    const otherReport = reportOf(other!);
    expect(otherReport.ownerKey).not.toBe(first!.report?.ownerKey ?? OWNER_ID);
    // B saw A's pending attempt on disk and left it exactly as found.
    const pendingBefore = otherReport.asFound.attempts.filter(
      attempt => attempt.ownerKey !== otherReport.ownerKey,
    );
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0]?.state).toBe('reserve_pending');
    const pendingAfter = otherReport.final.attempts.filter(
      attempt => attempt.ownerKey !== otherReport.ownerKey,
    );
    expect(pendingAfter).toEqual(pendingBefore);
    // B's own analysis completed under B's rows only.
    expect(otherReport.outcome.kind).toBe('scored');
    const ownRows = otherReport.final.attempts.filter(
      attempt => attempt.ownerKey === otherReport.ownerKey,
    );
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]?.state).toBe('committed');
    expect(
      otherReport.final.operations.map(operation => operation.ownerKey).sort(),
    ).toHaveLength(2);
    expect(
      otherReport.final.captures.filter(capture => capture.id === CAPTURE_ID),
    ).toHaveLength(2);

    // A relaunches: A's attempt is reconciled (released cancelled) under A's
    // key; B's result is untouched.
    const backReport = reportOf(back!);
    expect(backReport.outcome.kind).toBe('unavailable');
    expect(backReport.outcome.cause).toBe('recovery_pending');
    const ownAttempts = backReport.final.attempts.filter(
      attempt => attempt.ownerKey === backReport.ownerKey,
    );
    expect(ownAttempts).toHaveLength(1);
    expect(ownAttempts[0]).toMatchObject({
      state: 'released',
      releaseOutcome: 'cancelled',
    });
    const otherAttempts = backReport.final.attempts.filter(
      attempt => attempt.ownerKey === otherReport.ownerKey,
    );
    expect(otherAttempts).toEqual(ownRows);
    expect(
      backReport.final.shots.filter(
        shot => shot.ownerKey === backReport.ownerKey,
      ),
    ).toEqual([]);

    // Server: exactly two permits (A cancelled, B scored) and one shot (B's).
    expect(result.server.unrouted).toEqual([]);
    expect(result.server.unauthorized).toEqual([]);
    expect(result.server.permits).toHaveLength(2);
    expect(
      result.server.permits
        .map(permit => [permit.status, permit.outcome])
        .sort(),
    ).toEqual([
      ['finalized', 'cancelled'],
      ['finalized', 'scored'],
    ]);
    expect(result.server.shots).toHaveLength(1);
    expect(result.server.shots[0]?.id).toBe(otherReport.outcome.analysisId);
    const keys = new Set(
      result.server.requests
        .filter(request => request.path === '/v1/analysis-permits')
        .map(request => JSON.stringify(request.body)),
    );
    expect(keys.size).toBe(2);
  });
});
