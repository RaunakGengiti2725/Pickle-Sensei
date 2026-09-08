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
 *    operation or permit is ever created (no fabricated score, no charge);
 *  - a relaunch whose network answers with transport artifacts (a non-JSON
 *    2xx, an empty 204, a redirect to a captive portal or to a route the API
 *    does not have) settles NOTHING: an interrupted reservation stays
 *    `release_pending` on the same permit id and a committed result keeps
 *    its whole outbox budget, so the next honest launch releases / delivers
 *    exactly once.
 *
 * The harness lives in `__harness__/processDeath/`; nothing under `src/` is
 * modified or reimplemented.
 */
import {
  FIRST_OPERATION_ID,
  RELAUNCH_OPERATION_ID,
  runLaunches,
  runScenario,
  type LaunchOutcome,
  type LaunchResult,
  type LaunchSpec,
} from '../__harness__/processDeath/harness';
import type { Fault, FaultRule } from '../__harness__/processDeath/faultProxy';
import {
  KILL_POINTS,
  type KillPoint,
} from '../__harness__/processDeath/killPoints';
import type { ServerSnapshot } from '../__harness__/processDeath/ratingService';
import type {
  ChildReport,
  DurableSnapshot,
} from '../__harness__/processDeath/report';
import { OUTBOX_MAX_ATTEMPTS } from '../src/data/sync';

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

/** Admitted attempt, no result: released cancelled, nothing fabricated. */
function expectHeldWithoutResult(
  server: ServerSnapshot,
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

  expect(server.unrouted).toEqual([]);
  expect(server.unauthorized).toEqual([]);
  expect(server.permits).toHaveLength(1);
  expect(server.permits[0]).toMatchObject({
    id: attempt.permitId,
    idempotencyKey: attempt.reservationKey,
    status: 'finalized',
    outcome: 'cancelled',
  });
  expect(server.shots).toEqual([]);
  // Every reservation the relaunch made reused the original key.
  for (const request of server.requests) {
    if (request.path !== '/v1/analysis-permits') continue;
    expect(request.body).toEqual({ idempotencyKey: attempt.reservationKey });
  }
}

function killPoint(id: string): KillPoint {
  const point = KILL_POINTS.find(candidate => candidate.id === id);
  if (!point) throw new Error(`Unknown kill point ${id}`);
  return point;
}

function killLaunch(point: KillPoint): LaunchSpec {
  return {
    launch: '1',
    operationId: FIRST_OPERATION_ID,
    kill: { id: point.id, trigger: point.trigger },
  };
}

function relaunch(faults?: readonly FaultRule[]): LaunchSpec {
  return {
    launch: '2',
    operationId: RELAUNCH_OPERATION_ID,
    ...(faults ? { faults } : {}),
  };
}

function expectKilledAt(launch: LaunchOutcome, point: KillPoint): void {
  expect(launch.signal).toBe('SIGKILL');
  expect(launch.exitCode).toBeNull();
  expect(launch.report).toBeNull();
  expect(launch.killMarker?.startsWith(`${point.id} `)).toBe(true);
}

function serverPaths(server: ServerSnapshot, pathIncludes: string): string[] {
  return server.requests
    .map(request => request.path)
    .filter(path => path.includes(pathIncludes));
}

/** Answers the network can give that are not a verdict from the API. */
const TRANSPORT_ARTIFACTS: readonly {
  readonly name: string;
  readonly fault: Fault;
}[] = [
  {
    name: '200 text/html page',
    fault: {
      kind: 'text',
      status: 200,
      contentType: 'text/html',
      text: '<html><body>Welcome</body></html>',
    },
  },
  {
    name: '204 with no body',
    fault: { kind: 'text', status: 204, contentType: 'text/plain', text: '' },
  },
  {
    name: '302 to a captive-portal page',
    fault: { kind: 'redirect', status: 302, target: 'portal_html' },
  },
  {
    name: '307 to a captive-portal page',
    fault: { kind: 'redirect', status: 307, target: 'portal_html' },
  },
  {
    name: '302 to a route the API does not have (404)',
    fault: { kind: 'redirect', status: 302, target: 'not_found' },
  },
  {
    name: '307 to a route the API does not have (404)',
    fault: { kind: 'redirect', status: 307, target: 'not_found' },
  },
];

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
    expectSingleDurableResult(result.server, first, FIRST_OPERATION_ID, false);

    expect(second.asFound).toEqual(first.final);
    expect(second.afterRecovery).toEqual(first.final);
    expectOwnedBy(second.final, second.ownerKey);
    expectSingleDurableResult(result.server, second, FIRST_OPERATION_ID, true);
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
          result.server,
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
        expectHeldWithoutResult(result.server, second);
        if (point.asFound.permitRecorded) {
          expect(second.final.attempts[0]?.permitId).toBe(
            asFound.attempts[0]?.permitId,
          );
        }
      }
    },
  );

  it('is hermetic: ambient PD_KILL / PD_KILL_ID in the parent environment never arm a launch', async () => {
    const ambient = killPoint('capture_saved');
    const previous = { kill: process.env.PD_KILL, id: process.env.PD_KILL_ID };
    process.env.PD_KILL = JSON.stringify(ambient.trigger);
    process.env.PD_KILL_ID = 'ambient_environment';
    try {
      const result = await runScenario(null);
      expect(result.first.killMarker).toBeNull();
      expect(result.second.killMarker).toBeNull();
      const first = reportOf(result.first);
      const second = reportOf(result.second);
      expectSingleDurableResult(
        result.server,
        first,
        FIRST_OPERATION_ID,
        false,
      );
      expectSingleDurableResult(
        result.server,
        second,
        FIRST_OPERATION_ID,
        true,
      );
    } finally {
      for (const [name, value] of [
        ['PD_KILL', previous.kill],
        ['PD_KILL_ID', previous.id],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  describe('a finalize acknowledgement that is not a permit verdict leaves the reservation recoverable', () => {
    const point = killPoint('commit_shot_inserted_mid_transaction');

    it.each(TRANSPORT_ARTIFACTS)(
      'finalize answered with a $name → attempt stays release_pending on the same permit; the next honest launch releases it once',
      async ({ fault }) => {
        const { launches, server } = await runLaunches(
          [
            killLaunch(point),
            relaunch([{ pathIncludes: '/finalize', ordinal: 'all', fault }]),
            relaunch(),
          ],
          { proxy: true },
        );
        const [killed, faulted, honest] = launches as [
          LaunchOutcome,
          LaunchOutcome,
          LaunchOutcome,
        ];
        expectKilledAt(killed, point);

        // The kill left one RESERVED attempt whose permit the server holds.
        const second = reportOf(faulted);
        expect(second.asFound.attempts.map(row => row.state)).toEqual([
          'reserved',
        ]);
        const permitId = second.asFound.attempts[0]?.permitId;
        expect(typeof permitId).toBe('string');

        // Every finalize the relaunch sent was swallowed by the transport.
        const finalizes = faulted.proxied.filter(request =>
          request.path.includes('/finalize'),
        );
        expect(finalizes.length).toBeGreaterThanOrEqual(1);
        for (const request of finalizes) expect(request.faulted).toEqual(fault);
        expect(serverPaths(faulted.serverAfter, '/finalize')).toEqual([]);
        expect(faulted.serverAfter.permits).toEqual([
          expect.objectContaining({ id: permitId, status: 'reserved' }),
        ]);

        // Ambiguous acknowledgement ⇒ HOLD: nothing settled, nothing fabricated.
        expect(second.outcome.kind).toBe('unavailable');
        expect(second.outcome.cause).toBe('recovery_pending');
        expect(second.final.attempts).toHaveLength(1);
        expect(second.final.attempts[0]).toMatchObject({
          operationId: second.asFound.attempts[0]?.operationId,
          permitId,
          state: 'release_pending',
          releaseOutcome: 'cancelled',
          terminalReason: null,
          resultId: null,
        });
        expect(second.final.analysisRecords).toEqual([]);
        expect(second.final.shots).toEqual([]);
        expect(second.final.outbox).toEqual([]);
        expect(second.final.operations.map(row => row.operationId)).toEqual([
          FIRST_OPERATION_ID,
        ]);

        // Honest network: the SAME permit is released cancelled exactly once.
        const third = reportOf(honest);
        expect(third.asFound).toEqual(second.final);
        expectOwnedBy(third.final, third.ownerKey);
        expectHeldWithoutResult(server, third);
        expect(third.final.attempts[0]?.permitId).toBe(permitId);
        expect(serverPaths(server, '/finalize')).toEqual([
          `/v1/analysis-permits/${permitId}/finalize`,
        ]);
        expect(server.permits).toHaveLength(1);
      },
    );
  });

  describe('transport artifacts on the relaunch sync never consume the outbox budget', () => {
    const point = killPoint('result_committed_before_sync_request');
    const SYNC_ROUTE = '/v1/shots:sync';

    function expectCommittedResultStillQueued(
      launch: LaunchOutcome,
      fault: Fault,
    ): ChildReport {
      const report = reportOf(launch);
      const asFound = report.asFound;
      expect(asFound.shots).toHaveLength(1);
      expect(asFound.outbox).toHaveLength(1);
      expect(asFound.attempts.map(row => row.state)).toEqual(['committed']);

      const syncs = launch.proxied.filter(request =>
        request.path.includes(SYNC_ROUTE),
      );
      expect(syncs.length).toBeGreaterThanOrEqual(1);
      for (const request of syncs) expect(request.faulted).toEqual(fault);
      expect(serverPaths(launch.serverAfter, SYNC_ROUTE)).toEqual([]);
      expect(launch.serverAfter.shots).toEqual([]);
      expect(launch.serverAfter.permits).toEqual([
        expect.objectContaining({
          id: asFound.attempts[0]?.permitId,
          status: 'reserved',
        }),
      ]);

      // The validated result replays from disk; its outbox row records the
      // failure but keeps its whole budget.
      expect(report.outcome.kind).toBe('scored');
      expect(report.outcome.replayed).toBe(true);
      expect(report.outcome.analysisId).toBe(asFound.shots[0]?.id);
      expect(report.final.shots).toEqual(asFound.shots);
      expect(report.final.receipts).toEqual([]);
      expect(report.final.outbox).toHaveLength(1);
      expect(report.final.outbox[0]).toMatchObject({
        id: asFound.outbox[0]?.id,
        kind: 'shot.sync',
        shotId: asFound.shots[0]?.id,
        attempts: 0,
      });
      expect(report.final.outbox[0]?.lastError).not.toBeNull();
      return report;
    }

    it.each(TRANSPORT_ARTIFACTS)(
      'relaunch sync answered with a $name → outbox attempts stay 0; the next honest launch delivers the shot exactly once',
      async ({ fault }) => {
        const { launches, server } = await runLaunches(
          [
            killLaunch(point),
            relaunch([{ pathIncludes: SYNC_ROUTE, ordinal: 'all', fault }]),
            relaunch(),
          ],
          { proxy: true },
        );
        const [killed, faulted, honest] = launches as [
          LaunchOutcome,
          LaunchOutcome,
          LaunchOutcome,
        ];
        expectKilledAt(killed, point);
        const second = expectCommittedResultStillQueued(faulted, fault);

        const third = reportOf(honest);
        expect(third.asFound).toEqual(second.final);
        expectOwnedBy(third.final, third.ownerKey);
        expectSingleDurableResult(server, third, FIRST_OPERATION_ID, true);
        expect(third.outcome.analysisId).toBe(second.outcome.analysisId);
        expect(serverPaths(server, SYNC_ROUTE)).toEqual([SYNC_ROUTE]);
      },
    );

    it('a committed result outlives OUTBOX_MAX_ATTEMPTS redirected sync passes and drains once when the network is honest', async () => {
      const fault: Fault = {
        kind: 'redirect',
        status: 302,
        target: 'not_found',
      };
      // Each relaunch drains the outbox twice (after journal recovery and
      // after the saved-analysis run), so this many faulted relaunches send at
      // least OUTBOX_MAX_ATTEMPTS redirected sync requests.
      const SYNC_PASSES_PER_LAUNCH = 2;
      const faultedLaunches = Math.ceil(
        OUTBOX_MAX_ATTEMPTS / SYNC_PASSES_PER_LAUNCH,
      );
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          ...Array.from({ length: faultedLaunches }, () =>
            relaunch([{ pathIncludes: SYNC_ROUTE, ordinal: 'all', fault }]),
          ),
          relaunch(),
        ],
        { proxy: true },
      );
      expectKilledAt(launches[0] as LaunchOutcome, point);
      const faulted = launches.slice(1, 1 + faultedLaunches);
      const honest = launches[1 + faultedLaunches] as LaunchOutcome;

      let redirectedSyncs = 0;
      let previous: DurableSnapshot | null = null;
      for (const launch of faulted) {
        const report = expectCommittedResultStillQueued(launch, fault);
        if (previous) expect(report.asFound).toEqual(previous);
        previous = report.final;
        redirectedSyncs += launch.proxied.filter(
          request => request.path.includes(SYNC_ROUTE) && request.faulted,
        ).length;
      }
      expect(redirectedSyncs).toBeGreaterThanOrEqual(OUTBOX_MAX_ATTEMPTS);

      const third = reportOf(honest);
      expect(third.asFound).toEqual(previous);
      expectOwnedBy(third.final, third.ownerKey);
      expectSingleDurableResult(server, third, FIRST_OPERATION_ID, true);
      expect(serverPaths(server, SYNC_ROUTE)).toEqual([SYNC_ROUTE]);
    });
  });
});
