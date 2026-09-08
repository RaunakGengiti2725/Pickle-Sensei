/**
 * W02-03 adversarial suite — attacks on the process-death recovery boundary
 * that the candidate suite (`w02ProcessDeathRecovery.test.ts`) does not
 * exercise. Every case drives the SHIPPING modules through the candidate's
 * own harness (`__harness__/processDeath/`); nothing under `src/` is mocked
 * except where the transport is probed directly through `fetch`.
 *
 * Attack categories:
 *  A. crash during recovery — a second SIGKILL inside the relaunch's own
 *     recovery step (finalize ack lost, re-reserve ack lost, released-write
 *     lost, sync ack lost, receipt lost) followed by a third launch;
 *  B. network failure at every recovery step with real status boundaries —
 *     429 + Retry-After, a JSON 503, a non-JSON 500, an empty 502, a JSON
 *     499 — at finalize, at the recovery reservation and at the sync;
 *  C. network failure on the FIRST admission (no kill): a 429 / 503 /
 *     403-HTML reserve, a 429 sync — the attempt must settle under the same
 *     reservation key on the next launch, never as a second permit;
 *  D. corrupt / partial persisted state between launches (a non-UUID
 *     permit_id, an unparsable outbox payload, an orphaned operation, an
 *     illegal state/outcome pair);
 *  E. replay / duplicate identity — extra launches on a settled database
 *     must be pure replays that send nothing;
 *  F. 301 / 308 redirects (the candidate covers 302 / 307 only);
 *  G. transport boundary values probed directly on `request()` — status 0,
 *     299, 300, 399, `redirected` on the same URL, a final URL differing
 *     only in default port / host case (must NOT be a false positive), an
 *     opaque redirect, and a missing `url`;
 *  H. free-rating conservation is asserted throughout: a hold never becomes
 *     a scored permit, a second permit or a server shot.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FIRST_OPERATION_ID,
  RELAUNCH_OPERATION_ID,
  launchChild,
  runLaunches,
  writeFixture,
  type LaunchOutcome,
  type LaunchResult,
  type LaunchSpec,
} from '../__harness__/processDeath/harness';
import {
  REDIRECT_TARGET_PATH,
  type Fault,
  type FaultRule,
} from '../__harness__/processDeath/faultProxy';
import {
  KILL_POINTS,
  type KillPoint,
  type KillTrigger,
} from '../__harness__/processDeath/killPoints';
import {
  startRatingService,
  type ServerSnapshot,
} from '../__harness__/processDeath/ratingService';
import type { ChildReport } from '../__harness__/processDeath/report';
import {
  ApiError,
  createAnalysisPermitClient,
  createTransport,
} from '../src/data/api';
import { isPermanentSyncFailure } from '../src/data/sync';

const RESERVE_ROUTE = '/v1/analysis-permits';
const FINALIZE_ROUTE = '/finalize';
const SYNC_ROUTE = '/v1/shots:sync';

function reportOf(launch: LaunchResult): ChildReport {
  expect(launch.signal).toBeNull();
  expect(launch.exitCode).toBe(0);
  expect(launch.stderr).toBe('');
  expect(launch.report).not.toBeNull();
  return launch.report as ChildReport;
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

function killedRelaunch(id: string, trigger: KillTrigger): LaunchSpec {
  return {
    launch: '2',
    operationId: RELAUNCH_OPERATION_ID,
    kill: { id, trigger },
  };
}

function expectKilledAt(launch: LaunchOutcome, id: string): void {
  expect(launch.signal).toBe('SIGKILL');
  expect(launch.exitCode).toBeNull();
  expect(launch.report).toBeNull();
  expect(launch.killMarker?.startsWith(`${id} `)).toBe(true);
}

function serverPaths(server: ServerSnapshot, pathIncludes: string): string[] {
  return server.requests
    .map(request => request.path)
    .filter(route => route.includes(pathIncludes));
}

/** Reservation requests only (the finalize path shares the prefix). */
function reservePaths(server: ServerSnapshot): string[] {
  return server.requests
    .map(request => request.path)
    .filter(route => route === RESERVE_ROUTE);
}

function expectRedirectNeverFollowed(launch: LaunchOutcome): void {
  expect(
    launch.proxied
      .map(request => request.path)
      .filter(route => route.startsWith(REDIRECT_TARGET_PATH)),
  ).toEqual([]);
}

/** Exactly one scored result on disk and on the server, drained once. */
function expectSingleDurableResult(
  server: ServerSnapshot,
  report: ChildReport,
): string {
  const final = report.final;
  expect(report.outcome.kind).toBe('scored');
  const analysisId = report.outcome.analysisId;
  expect(typeof analysisId).toBe('string');
  expect(final.analysisRecords.map(row => row.id)).toEqual([analysisId]);
  expect(final.shots.map(row => row.id)).toEqual([analysisId]);
  expect(final.shots[0]?.resultKind).toBe('scored');
  expect(final.outbox).toEqual([]);
  expect(final.receipts.map(row => [row.kind, row.entityId])).toEqual([
    ['shot.sync', analysisId],
  ]);
  expect(final.operations.map(row => row.operationId)).toEqual([
    FIRST_OPERATION_ID,
  ]);
  expect(final.operations[0]?.completionKind).toBe('scored');
  expect(final.attempts).toHaveLength(1);
  const attempt = final.attempts[0];
  expect(attempt?.state).toBe('committed');
  expect(attempt?.resultId).toBe(analysisId);
  expect(server.unrouted).toEqual([]);
  expect(server.unauthorized).toEqual([]);
  expect(server.permits).toHaveLength(1);
  expect(server.permits[0]).toMatchObject({
    id: attempt?.permitId,
    idempotencyKey: attempt?.reservationKey,
    status: 'finalized',
    outcome: 'scored',
  });
  expect(server.shots).toEqual([
    { id: analysisId, permitId: attempt?.permitId },
  ]);
  return analysisId as string;
}

/** Admitted attempt, no result: one permit released with a non-scored
 * outcome under the original reservation key; nothing fabricated. */
function expectHeldWithoutResult(
  server: ServerSnapshot,
  report: ChildReport,
  releaseOutcome: 'cancelled' | 'failed',
): void {
  const final = report.final;
  expect(report.outcome.kind).toBe('unavailable');
  expect(report.outcome.analysisId).toBeNull();
  expect(final.analysisRecords).toEqual([]);
  expect(final.shots).toEqual([]);
  expect(final.outbox).toEqual([]);
  expect(final.receipts).toEqual([]);
  expect(final.operations.map(row => row.operationId)).toEqual([
    FIRST_OPERATION_ID,
  ]);
  expect(final.operations[0]?.finalRecordId).toBeNull();
  expect(final.operations[0]?.completionKind).toBeNull();
  expect(final.attempts).toHaveLength(1);
  const attempt = final.attempts[0];
  expect(attempt?.state).toBe('released');
  expect(attempt?.releaseOutcome).toBe(releaseOutcome);
  expect(attempt?.resultId).toBeNull();
  expect(attempt?.terminalReason).toBeNull();
  expect(typeof attempt?.permitId).toBe('string');
  expect(server.unrouted).toEqual([]);
  expect(server.unauthorized).toEqual([]);
  expect(server.permits).toHaveLength(1);
  expect(server.permits[0]).toMatchObject({
    id: attempt?.permitId,
    idempotencyKey: attempt?.reservationKey,
    status: 'finalized',
    outcome: releaseOutcome,
  });
  expect(server.shots).toEqual([]);
  for (const request of server.requests) {
    if (request.path !== RESERVE_ROUTE) continue;
    expect(request.body).toEqual({ idempotencyKey: attempt?.reservationKey });
  }
}

/** No permit ever became a scored one without exactly one matching shot. */
function expectNoFreeRatingConsumedWithoutShot(server: ServerSnapshot): void {
  const scored = server.permits.filter(permit => permit.outcome === 'scored');
  expect(scored.map(permit => permit.id).sort()).toEqual(
    server.shots.map(shot => shot.permitId).sort(),
  );
}

const RETRY_AFTER_429: Fault = {
  kind: 'status',
  status: 429,
  headers: { 'retry-after': '30' },
  body: { error: { code: 'rate.limited', message: 'Slow down.' } },
};
const JSON_503: Fault = {
  kind: 'status',
  status: 503,
  body: { error: { code: 'unavailable', message: 'Try again later.' } },
};
const HTML_500: Fault = {
  kind: 'text',
  status: 500,
  contentType: 'text/html',
  text: '<html><body>Internal Server Error</body></html>',
};
const EMPTY_502: Fault = {
  kind: 'text',
  status: 502,
  contentType: 'text/plain',
  text: '',
};
const JSON_499_NO_ENVELOPE: Fault = {
  kind: 'status',
  status: 499,
  body: { closed: true },
};
const HTML_403: Fault = {
  kind: 'text',
  status: 403,
  contentType: 'text/html',
  text: '<html><body>Forbidden</body></html>',
};

const RECOVERY_FAULTS: readonly {
  readonly name: string;
  readonly fault: Fault;
}[] = [
  { name: '429 + Retry-After', fault: RETRY_AFTER_429 },
  { name: 'JSON 503', fault: JSON_503 },
  { name: 'non-JSON 500', fault: HTML_500 },
  { name: 'empty 502', fault: EMPTY_502 },
  { name: 'JSON 499 without an envelope', fault: JSON_499_NO_ENVELOPE },
];

const LEGACY_REDIRECTS: readonly {
  readonly name: string;
  readonly fault: Fault;
}[] = [
  {
    name: '301 to a captive portal',
    fault: { kind: 'redirect', status: 301, target: 'portal_html' },
  },
  {
    name: '308 to a route the API does not have',
    fault: { kind: 'redirect', status: 308, target: 'not_found' },
  },
];

describe('W02-03 attack: process-death recovery boundaries', () => {
  describe('A. a second process death INSIDE the relaunch recovery step', () => {
    const chains: readonly {
      readonly name: string;
      readonly first: string;
      readonly relaunchKill: KillTrigger;
      readonly expectation: 'held' | 'scored';
    }[] = [
      {
        name: 'reserved attempt → relaunch dies after the finalize answered (ack lost)',
        first: 'commit_shot_inserted_mid_transaction',
        relaunchKill: {
          kind: 'http',
          pathIncludes: FINALIZE_ROUTE,
          ordinal: 1,
          phase: 'after',
        },
        expectation: 'held',
      },
      {
        name: 'reserved attempt → relaunch dies before writing state=released',
        first: 'commit_shot_inserted_mid_transaction',
        relaunchKill: {
          kind: 'sql',
          includes: [
            "UPDATE analysis_execution_attempts SET state = 'released'",
          ],
          ordinal: 1,
          phase: 'before',
        },
        expectation: 'held',
      },
      {
        name: 'unsent reservation → relaunch dies after the re-reserve answered (ack lost)',
        first: 'attempt_admitted_before_reserve_request',
        relaunchKill: {
          kind: 'http',
          pathIncludes: RESERVE_ROUTE,
          ordinal: 1,
          phase: 'after',
        },
        expectation: 'held',
      },
      {
        name: 'lost reserve ack → relaunch re-reserves then dies before finalize is sent',
        first: 'permit_reserved_response_lost',
        relaunchKill: {
          kind: 'http',
          pathIncludes: FINALIZE_ROUTE,
          ordinal: 1,
          phase: 'before',
        },
        expectation: 'held',
      },
      {
        name: 'committed result → relaunch dies after the sync answered (ack lost)',
        first: 'result_committed_before_sync_request',
        relaunchKill: {
          kind: 'http',
          pathIncludes: SYNC_ROUTE,
          ordinal: 1,
          phase: 'after',
        },
        expectation: 'scored',
      },
      {
        name: 'lost sync ack → relaunch dies before the receipt is written',
        first: 'sync_accepted_response_lost',
        relaunchKill: {
          kind: 'sql',
          includes: ['INSERT OR REPLACE INTO sync_receipt'],
          ordinal: 1,
          phase: 'before',
        },
        expectation: 'scored',
      },
    ];

    it.each(chains)(
      '$name → the third launch settles exactly once',
      async ({ first, relaunchKill, expectation }) => {
        const point = killPoint(first);
        const { launches, server } = await runLaunches([
          killLaunch(point),
          killedRelaunch('relaunch_kill', relaunchKill),
          relaunch(),
        ]);
        const [killed, killedAgain, honest] = launches as [
          LaunchOutcome,
          LaunchOutcome,
          LaunchOutcome,
        ];
        expectKilledAt(killed, point.id);
        expectKilledAt(killedAgain, 'relaunch_kill');

        const third = reportOf(honest);
        expect(third.asFound.operations.map(row => row.operationId)).toEqual([
          FIRST_OPERATION_ID,
        ]);
        expect(third.asFound.attempts).toHaveLength(1);
        if (expectation === 'held') {
          expectHeldWithoutResult(server, third, 'cancelled');
        } else {
          expectSingleDurableResult(server, third);
          expect(server.shots).toHaveLength(1);
        }
        expectNoFreeRatingConsumedWithoutShot(server);
        expect(server.permits).toHaveLength(1);
        // Whatever was replayed, the server saw ONE reservation key.
        expect(
          new Set(
            server.requests
              .filter(request => request.path === RESERVE_ROUTE)
              .map(request => JSON.stringify(request.body)),
          ).size,
        ).toBeLessThanOrEqual(1);
      },
    );
  });

  describe('B. real status boundaries at every recovery step', () => {
    describe('finalize of a reserved attempt', () => {
      const point = killPoint('commit_shot_inserted_mid_transaction');
      it.each(RECOVERY_FAULTS)(
        '$name → stays release_pending on the same permit; honest launch releases once',
        async ({ fault }) => {
          const { launches, server } = await runLaunches(
            [
              killLaunch(point),
              relaunch([
                { pathIncludes: FINALIZE_ROUTE, ordinal: 'all', fault },
              ]),
              relaunch(),
            ],
            { proxy: true },
          );
          const [killed, faulted, honest] = launches as [
            LaunchOutcome,
            LaunchOutcome,
            LaunchOutcome,
          ];
          expectKilledAt(killed, point.id);
          const second = reportOf(faulted);
          const permitId = second.asFound.attempts[0]?.permitId;
          expect(typeof permitId).toBe('string');
          expect(second.outcome.kind).toBe('unavailable');
          expect(second.final.attempts).toHaveLength(1);
          expect(second.final.attempts[0]).toMatchObject({
            permitId,
            state: 'release_pending',
            releaseOutcome: 'cancelled',
            terminalReason: null,
          });
          expect(serverPaths(faulted.serverAfter, FINALIZE_ROUTE)).toEqual([]);
          expect(faulted.serverAfter.permits).toEqual([
            expect.objectContaining({ id: permitId, status: 'reserved' }),
          ]);

          const third = reportOf(honest);
          expect(third.asFound).toEqual(second.final);
          expectHeldWithoutResult(server, third, 'cancelled');
          expect(third.final.attempts[0]?.permitId).toBe(permitId);
          expect(serverPaths(server, FINALIZE_ROUTE)).toEqual([
            `/v1/analysis-permits/${permitId}/finalize`,
          ]);
        },
      );
    });

    describe('the recovery reservation of an unsent attempt', () => {
      const point = killPoint('attempt_admitted_before_reserve_request');
      it.each(RECOVERY_FAULTS)(
        '$name → stays pending under the same reservation key; honest launch reserves + releases once',
        async ({ fault }) => {
          const { launches, server } = await runLaunches(
            [
              killLaunch(point),
              relaunch([
                { pathIncludes: RESERVE_ROUTE, ordinal: 'all', fault },
              ]),
              relaunch(),
            ],
            { proxy: true },
          );
          const [killed, faulted, honest] = launches as [
            LaunchOutcome,
            LaunchOutcome,
            LaunchOutcome,
          ];
          expectKilledAt(killed, point.id);
          const second = reportOf(faulted);
          const reservationKey = second.asFound.attempts[0]?.reservationKey;
          expect(typeof reservationKey).toBe('string');
          expect(second.outcome.kind).toBe('unavailable');
          expect(second.final.attempts).toHaveLength(1);
          expect(second.final.attempts[0]).toMatchObject({
            reservationKey,
            permitId: null,
            state: 'release_pending',
            terminalReason: null,
          });
          expect(faulted.serverAfter.permits).toEqual([]);

          const third = reportOf(honest);
          expect(third.asFound).toEqual(second.final);
          expectHeldWithoutResult(server, third, 'cancelled');
          expect(third.final.attempts[0]?.reservationKey).toBe(reservationKey);
          expect(reservePaths(server)).toEqual([RESERVE_ROUTE]);
        },
      );
    });

    describe('the relaunch sync of a committed result', () => {
      const point = killPoint('result_committed_before_sync_request');
      it.each(RECOVERY_FAULTS)(
        '$name → outbox row keeps its budget; honest launch delivers once',
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
          expectKilledAt(killed, point.id);
          const second = reportOf(faulted);
          expect(second.outcome.kind).toBe('scored');
          expect(second.final.outbox).toHaveLength(1);
          expect(second.final.outbox[0]?.attempts).toBe(0);
          expect(second.final.receipts).toEqual([]);
          expect(serverPaths(faulted.serverAfter, SYNC_ROUTE)).toEqual([]);
          expect(faulted.serverAfter.shots).toEqual([]);

          const third = reportOf(honest);
          expect(third.asFound).toEqual(second.final);
          expectSingleDurableResult(server, third);
          expect(serverPaths(server, SYNC_ROUTE)).toEqual([SYNC_ROUTE]);
        },
      );
    });
  });

  describe('C. network failure on the FIRST admission (no process death)', () => {
    function faultedFirstLaunch(faults: readonly FaultRule[]): LaunchSpec {
      return { launch: '1', operationId: FIRST_OPERATION_ID, faults };
    }

    it.each([
      { name: '429 + Retry-After', fault: RETRY_AFTER_429 },
      { name: 'JSON 503', fault: JSON_503 },
      { name: '403 HTML (captive portal)', fault: HTML_403 },
      { name: 'empty 502', fault: EMPTY_502 },
    ])(
      'reserve answered $name → no permit; the next launch settles the attempt under the same key with ONE permit',
      async ({ fault }) => {
        const { launches, server } = await runLaunches(
          [
            faultedFirstLaunch([
              { pathIncludes: RESERVE_ROUTE, ordinal: 'all', fault },
            ]),
            relaunch(),
          ],
          { proxy: true },
        );
        const [faulted, honest] = launches as [LaunchOutcome, LaunchOutcome];
        const first = reportOf(faulted);
        expect(first.outcome.kind).not.toBe('scored');
        expect(first.final.shots).toEqual([]);
        expect(first.final.outbox).toEqual([]);
        expect(first.final.attempts).toHaveLength(1);
        expect(first.final.attempts[0]?.permitId).toBeNull();
        expect(first.final.attempts[0]?.state).not.toBe('terminal');
        expect(first.final.attempts[0]?.terminalReason).toBeNull();
        expect(faulted.serverAfter.permits).toEqual([]);
        const reservationKey = first.final.attempts[0]?.reservationKey;

        const second = reportOf(honest);
        expect(second.asFound).toEqual(first.final);
        const attempt = second.final.attempts[0];
        expect(attempt?.reservationKey).toBe(reservationKey);
        expect(attempt?.state).toBe('released');
        expect(attempt?.resultId).toBeNull();
        expect(second.final.shots).toEqual([]);
        expect(second.final.operations.map(row => row.operationId)).toEqual([
          FIRST_OPERATION_ID,
        ]);
        expect(server.permits).toHaveLength(1);
        expect(server.permits[0]).toMatchObject({
          id: attempt?.permitId,
          idempotencyKey: reservationKey,
          status: 'finalized',
          outcome: attempt?.releaseOutcome,
        });
        expect(server.permits[0]?.outcome).not.toBe('scored');
        expect(server.shots).toEqual([]);
        expect(reservePaths(server)).toEqual([RESERVE_ROUTE]);
        expectNoFreeRatingConsumedWithoutShot(server);
      },
    );

    it.each([
      { name: '429 + Retry-After', fault: RETRY_AFTER_429 },
      { name: 'non-JSON 500', fault: HTML_500 },
    ])(
      'sync answered $name on the first launch → committed result keeps its budget and drains once on relaunch',
      async ({ fault }) => {
        const { launches, server } = await runLaunches(
          [
            faultedFirstLaunch([
              { pathIncludes: SYNC_ROUTE, ordinal: 'all', fault },
            ]),
            relaunch(),
          ],
          { proxy: true },
        );
        const [faulted, honest] = launches as [LaunchOutcome, LaunchOutcome];
        const first = reportOf(faulted);
        expect(first.outcome.kind).toBe('scored');
        expect(first.final.outbox).toHaveLength(1);
        expect(first.final.outbox[0]?.attempts).toBe(0);
        expect(first.final.receipts).toEqual([]);
        expect(faulted.serverAfter.shots).toEqual([]);
        expect(faulted.serverAfter.permits[0]?.status).toBe('reserved');

        const second = reportOf(honest);
        expect(second.asFound).toEqual(first.final);
        const analysisId = expectSingleDurableResult(server, second);
        expect(analysisId).toBe(first.outcome.analysisId);
        expect(serverPaths(server, SYNC_ROUTE)).toEqual([SYNC_ROUTE]);
      },
    );
  });

  describe('D. corrupt or partial persisted state between launches', () => {
    interface TamperedRun {
      readonly first: LaunchResult;
      readonly second: LaunchResult;
      readonly server: ServerSnapshot;
      readonly serverAfterFirst: ServerSnapshot;
      readonly rowsAfter: (sql: string) => Record<string, unknown>[];
    }

    async function runTampered(
      point: KillPoint,
      tamper: (db: DatabaseSync) => void,
    ): Promise<TamperedRun> {
      const dir = mkdtempSync(path.join(tmpdir(), 'pickle-attack-'));
      const fixturePath = writeFixture(dir);
      const dbPath = path.join(dir, 'pickle-sensei.db');
      const service = await startRatingService();
      try {
        const base = {
          PD_DB_PATH: dbPath,
          PD_FIXTURE_PATH: fixturePath,
          PD_API_BASE_URL: service.baseUrl,
        };
        const first = await launchChild({
          ...base,
          PD_LAUNCH: '1',
          PD_OPERATION_ID: FIRST_OPERATION_ID,
          PD_KILL: JSON.stringify(point.trigger),
          PD_KILL_ID: point.id,
        });
        const serverAfterFirst = service.snapshot();
        // Out-of-band corruption does not run the schema's guards: the
        // tampering connection drops every trigger, skips FK enforcement and
        // re-creates the triggers verbatim before the relaunch opens the file.
        const db = new DatabaseSync(dbPath, {
          enableForeignKeyConstraints: false,
        });
        try {
          const triggers = db
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
            )
            .all() as { name: string; sql: string }[];
          for (const trigger of triggers)
            db.exec(`DROP TRIGGER "${trigger.name}"`);
          tamper(db);
          for (const trigger of triggers) db.exec(trigger.sql);
        } finally {
          db.close();
        }
        const second = await launchChild({
          ...base,
          PD_LAUNCH: '2',
          PD_OPERATION_ID: RELAUNCH_OPERATION_ID,
        });
        return {
          first,
          second,
          server: service.snapshot(),
          serverAfterFirst,
          rowsAfter: sql => {
            const reader = new DatabaseSync(dbPath, { readOnly: true });
            try {
              return reader.prepare(sql).all() as Record<string, unknown>[];
            } finally {
              reader.close();
            }
          },
        };
      } finally {
        await service.close();
      }
    }

    function expectKilled(first: LaunchResult, point: KillPoint): void {
      expect(first.signal).toBe('SIGKILL');
      expect(first.killMarker?.startsWith(`${point.id} `)).toBe(true);
    }

    it('a reserved attempt whose permit_id is not a UUID → hold: no crash, no second permit, no score', async () => {
      const point = killPoint('commit_shot_inserted_mid_transaction');
      const run = await runTampered(point, db => {
        db.prepare(
          "UPDATE analysis_execution_attempts SET permit_id = 'not-a-permit'",
        ).run();
      });
      expectKilled(run.first, point);
      expect(run.serverAfterFirst.permits).toHaveLength(1);
      const second = reportOf(run.second);
      expect(second.asFound.attempts[0]?.permitId).toBe('not-a-permit');
      expect(second.outcome.kind).not.toBe('scored');
      expect(second.final.shots).toEqual([]);
      expect(second.final.outbox).toEqual([]);
      expect(second.final.analysisRecords).toEqual([]);
      expect(second.final.operations.map(row => row.operationId)).toEqual([
        FIRST_OPERATION_ID,
      ]);
      expect(second.final.attempts).toHaveLength(1);
      expect(second.final.attempts[0]?.state).not.toBe('released');
      expect(second.final.attempts[0]?.state).not.toBe('committed');
      // The unreadable row must not be "repaired" into a fresh reservation.
      expect(run.server.permits).toHaveLength(1);
      expect(serverPaths(run.server, RESERVE_ROUTE)).toEqual([RESERVE_ROUTE]);
      expect(serverPaths(run.server, FINALIZE_ROUTE)).toEqual([]);
      expect(run.server.shots).toEqual([]);
      expectNoFreeRatingConsumedWithoutShot(run.server);
    });

    it('a committed result whose outbox payload lost its permit id → the row fails alone: never sent, never deleted, never a second permit', async () => {
      const point = killPoint('result_committed_before_sync_request');
      const run = await runTampered(point, db => {
        db.prepare(
          "UPDATE outbox SET payload = json_remove(payload, '$.analysisPermitId')",
        ).run();
      });
      expectKilled(run.first, point);
      const second = reportOf(run.second);
      expect(second.asFound.outbox).toHaveLength(1);
      expect(second.asFound.outbox[0]?.analysisPermitId).toBeNull();
      expect(second.outcome.kind).toBe('scored');
      expect(second.outcome.replayed).toBe(true);
      expect(second.final.shots).toHaveLength(1);
      expect(second.final.receipts).toEqual([]);
      expect(second.final.outbox).toHaveLength(1);
      expect(second.final.outbox[0]?.shotId).toBe(second.outcome.analysisId);
      expect(second.final.outbox[0]?.lastError).not.toBeNull();
      expect(run.server.shots).toEqual([]);
      expect(serverPaths(run.server, SYNC_ROUTE)).toEqual([]);
      expect(run.server.permits).toHaveLength(1);
      expect(run.server.permits[0]?.status).toBe('reserved');
      expect(reservePaths(run.server)).toEqual([RESERVE_ROUTE]);
      expectNoFreeRatingConsumedWithoutShot(run.server);
    });

    it('an operation whose current attempt row vanished → no fresh reservation under a new key, no fabricated score', async () => {
      const point = killPoint('commit_shot_inserted_mid_transaction');
      const run = await runTampered(point, db => {
        db.prepare('DELETE FROM analysis_execution_attempts').run();
      });
      expectKilled(run.first, point);
      expect(run.serverAfterFirst.permits).toHaveLength(1);
      const second = reportOf(run.second);
      expect(second.asFound.attempts).toEqual([]);
      expect(second.asFound.operations).toHaveLength(1);
      expect(second.outcome.kind).not.toBe('scored');
      expect(second.final.shots).toEqual([]);
      expect(second.final.outbox).toEqual([]);
      expect(second.final.analysisRecords).toEqual([]);
      expect(second.final.operations.map(row => row.operationId)).toEqual([
        FIRST_OPERATION_ID,
      ]);
      expect(run.server.shots).toEqual([]);
      // The server permit the lost attempt held must not be joined by another.
      expect(run.server.permits).toHaveLength(1);
      expect(reservePaths(run.server)).toEqual([RESERVE_ROUTE]);
      expectNoFreeRatingConsumedWithoutShot(run.server);
    });

    it('boundary values on a reserved attempt (attempt_count at INT32 max, far-future updated_at, created_at rolled back to 0) → released exactly once', async () => {
      const point = killPoint('commit_shot_inserted_mid_transaction');
      const run = await runTampered(point, db => {
        db.prepare(
          `UPDATE analysis_execution_attempts
             SET attempt_count = 2147483647, updated_at_ms = 9007199254740991, created_at_ms = 0`,
        ).run();
      });
      expectKilled(run.first, point);
      expect(run.serverAfterFirst.permits).toHaveLength(1);
      const second = reportOf(run.second);
      expectHeldWithoutResult(run.server, second, 'cancelled');
      expect(
        run.rowsAfter(
          'SELECT attempt_count, created_at_ms FROM analysis_execution_attempts',
        ),
      ).toEqual([{ attempt_count: 2147483647, created_at_ms: 0 }]);
      expect(second.final.attempts[0]?.permitId).toBe(
        run.serverAfterFirst.permits[0]?.id,
      );
      expect(serverPaths(run.server, FINALIZE_ROUTE)).toHaveLength(1);
    });
  });

  describe('E. replay / duplicate identity across extra launches', () => {
    it('two more launches on a settled database are pure replays: no request, no new row, same result', async () => {
      const { launches, server } = await runLaunches([
        { launch: '1', operationId: FIRST_OPERATION_ID },
        relaunch(),
        { launch: '2', operationId: '44444444-4444-4444-8444-000000000003' },
      ]);
      const [first, second, third] = launches.map(reportOf) as [
        ChildReport,
        ChildReport,
        ChildReport,
      ];
      const analysisId = expectSingleDurableResult(server, first);
      expect(second.asFound).toEqual(first.final);
      expect(second.final).toEqual(first.final);
      expect(second.outcome.replayed).toBe(true);
      expect(second.outcome.analysisId).toBe(analysisId);
      expect(third.asFound).toEqual(first.final);
      expect(third.final).toEqual(first.final);
      expect(third.outcome.replayed).toBe(true);
      expect(third.outcome.analysisId).toBe(analysisId);
      expect(server.requests.map(request => request.path)).toEqual([
        RESERVE_ROUTE,
        SYNC_ROUTE,
      ]);
      expect(server.permits).toHaveLength(1);
      expect(server.shots).toHaveLength(1);
    });

    it('a held attempt stays held across further launches: the cancelled permit is never re-reserved or re-finalized', async () => {
      const point = killPoint('commit_shot_inserted_mid_transaction');
      const { launches, server } = await runLaunches([
        killLaunch(point),
        relaunch(),
        relaunch(),
        { launch: '2', operationId: '44444444-4444-4444-8444-000000000003' },
      ]);
      expectKilledAt(launches[0] as LaunchOutcome, point.id);
      const second = reportOf(launches[1] as LaunchOutcome);
      expectHeldWithoutResult(server, second, 'cancelled');
      for (const later of launches.slice(2)) {
        const report = reportOf(later);
        expect(report.asFound).toEqual(second.final);
        expect(report.final).toEqual(second.final);
        expect(report.outcome.kind).toBe('unavailable');
      }
      expect(reservePaths(server)).toEqual([RESERVE_ROUTE]);
      expect(serverPaths(server, FINALIZE_ROUTE)).toHaveLength(1);
      expect(server.permits).toHaveLength(1);
      expect(server.shots).toEqual([]);
    });
  });

  describe('F. 301 / 308 redirects are never followed and never a verdict', () => {
    const point = killPoint('commit_shot_inserted_mid_transaction');
    it.each(LEGACY_REDIRECTS)(
      'finalize answered $name → release_pending on the same permit; honest launch releases once',
      async ({ fault }) => {
        const { launches, server } = await runLaunches(
          [
            killLaunch(point),
            relaunch([{ pathIncludes: FINALIZE_ROUTE, ordinal: 'all', fault }]),
            relaunch(),
          ],
          { proxy: true },
        );
        const [killed, faulted, honest] = launches as [
          LaunchOutcome,
          LaunchOutcome,
          LaunchOutcome,
        ];
        expectKilledAt(killed, point.id);
        const second = reportOf(faulted);
        expectRedirectNeverFollowed(faulted);
        const permitId = second.asFound.attempts[0]?.permitId;
        expect(second.final.attempts[0]).toMatchObject({
          permitId,
          state: 'release_pending',
          terminalReason: null,
        });
        expect(faulted.serverAfter.permits[0]?.status).toBe('reserved');
        const third = reportOf(honest);
        expectHeldWithoutResult(server, third, 'cancelled');
        expect(serverPaths(server, FINALIZE_ROUTE)).toHaveLength(1);
      },
    );

    it.each(LEGACY_REDIRECTS)(
      'recovery reserve answered $name → pending under the same key; honest launch reserves once',
      async ({ fault }) => {
        const unsent = killPoint('attempt_admitted_before_reserve_request');
        const { launches, server } = await runLaunches(
          [
            killLaunch(unsent),
            relaunch([{ pathIncludes: RESERVE_ROUTE, ordinal: 'all', fault }]),
            relaunch(),
          ],
          { proxy: true },
        );
        const [killed, faulted, honest] = launches as [
          LaunchOutcome,
          LaunchOutcome,
          LaunchOutcome,
        ];
        expectKilledAt(killed, unsent.id);
        const second = reportOf(faulted);
        expectRedirectNeverFollowed(faulted);
        expect(second.final.attempts[0]).toMatchObject({
          permitId: null,
          state: 'release_pending',
          terminalReason: null,
        });
        expect(faulted.serverAfter.permits).toEqual([]);
        const third = reportOf(honest);
        expectHeldWithoutResult(server, third, 'cancelled');
        expect(reservePaths(server)).toEqual([RESERVE_ROUTE]);
      },
    );
  });

  describe('G. transport boundary values on request()', () => {
    const baseUrl = 'https://api.example.test';
    const PERMIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
    const finalizeUrl = `${baseUrl}/v1/analysis-permits/${PERMIT_ID}/finalize`;
    const reserveUrl = `${baseUrl}${RESERVE_ROUTE}`;
    const syncUrl = `${baseUrl}${SYNC_ROUTE}`;
    const verdict = {
      permit: {
        id: PERMIT_ID,
        accessSource: 'free',
        status: 'finalized',
        outcome: 'cancelled',
        reservedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      },
      access: null,
    };

    function answer(
      status: number,
      body: unknown | SyntaxError,
      overrides: Partial<{
        url: string | undefined;
        redirected: boolean;
        type: Response['type'];
      }> = {},
    ): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        type: overrides.type ?? 'basic',
        redirected: overrides.redirected ?? false,
        url: 'url' in overrides ? overrides.url : finalizeUrl,
        json: async () => {
          if (body instanceof SyntaxError) throw body;
          return body;
        },
      } as Response;
    }

    async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
      let caught: unknown = null;
      try {
        await run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      return caught as ApiError;
    }

    const client = () =>
      createAnalysisPermitClient({ baseUrl, token: 'account-token' });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([
      ['300 Multiple Choices', 300],
      ['399 (upper 3xx bound)', 399],
    ] as const)(
      '%s carrying a perfect verdict body is still a redirect → 502 network.redirected',
      async (_name, status) => {
        jest
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(answer(status, verdict));
        const error = await rejection(() =>
          client().release(PERMIT_ID, 'cancelled'),
        );
        expect(error.status).toBe(502);
        expect(error.code).toBe('network.redirected');
        expect(isPermanentSyncFailure(error)).toBe(false);
      },
    );

    it('a runtime that followed a redirect back to the SAME url (redirected=true) is still not a verdict', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(answer(200, verdict, { redirected: true }));
      const error = await rejection(() =>
        client().release(PERMIT_ID, 'cancelled'),
      );
      expect(error.code).toBe('network.redirected');
    });

    it('an opaque redirect (status 0, type opaqueredirect) is not a verdict and is retryable', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          answer(0, new SyntaxError('empty'), { type: 'opaqueredirect' }),
        );
      const error = await rejection(() =>
        client().release(PERMIT_ID, 'cancelled'),
      );
      expect(error.status).toBe(502);
      expect(error.code).toBe('network.redirected');
      expect(isPermanentSyncFailure(error)).toBe(false);
    });

    it('a status-0 network error response (type error) is never a verdict and never permanent', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          answer(0, new SyntaxError('empty'), { type: 'error', url: '' }),
        );
      const error = await rejection(() =>
        client().release(PERMIT_ID, 'cancelled'),
      );
      expect(error.status).not.toBeGreaterThanOrEqual(400);
      expect(isPermanentSyncFailure(error)).toBe(false);
    });

    it.each([
      [
        'default port made explicit',
        `https://api.example.test:443/v1/analysis-permits/${PERMIT_ID}/finalize`,
      ],
      [
        'host in upper case',
        `https://API.EXAMPLE.TEST/v1/analysis-permits/${PERMIT_ID}/finalize`,
      ],
      ['url omitted by the runtime', undefined],
    ] as const)(
      'a final url that is the same origin spelled differently (%s) is NOT a false redirect',
      async (_name, url) => {
        jest
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(answer(200, verdict, { url }));
        await expect(
          client().release(PERMIT_ID, 'cancelled'),
        ).resolves.toBeUndefined();
      },
    );

    it('a final url on another origin with a perfect verdict body is a redirect artifact', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        answer(200, verdict, {
          url: `https://portal.example.net/v1/analysis-permits/${PERMIT_ID}/finalize`,
        }),
      );
      const error = await rejection(() =>
        client().release(PERMIT_ID, 'cancelled'),
      );
      expect(error.code).toBe('network.redirected');
    });

    it('299 with the route’s verdict is accepted; 299 with a non-object body is not', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer(299, verdict));
      await expect(
        client().release(PERMIT_ID, 'cancelled'),
      ).resolves.toBeUndefined();
      jest.restoreAllMocks();
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer(299, 'ok'));
      const error = await rejection(() =>
        client().release(PERMIT_ID, 'cancelled'),
      );
      expect(error.code).toBe('network.invalid_response');
    });

    it.each([
      ['499 (client-closed, unassigned)', 499],
      ['451 (unavailable for legal reasons)', 451],
    ] as const)(
      'an unreadable %s is a transport artifact (502, retryable), not a terminal verdict',
      async (_name, status) => {
        jest
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(answer(status, new SyntaxError('html')));
        const error = await rejection(() =>
          client().release(PERMIT_ID, 'cancelled'),
        );
        expect(error.status).toBe(502);
        expect(error.code).toBe('network.invalid_response');
        expect(isPermanentSyncFailure(error)).toBe(false);
      },
    );

    it('a 4xx envelope whose code is not a string (number / empty) is unreadable, not a verdict', async () => {
      for (const code of [42, '', null, { nested: true }]) {
        jest.restoreAllMocks();
        jest
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(answer(409, { error: { code, message: 'x' } }));
        const error = await rejection(() =>
          client().release(PERMIT_ID, 'cancelled'),
        );
        expect(error.status).toBe(502);
        expect(error.code).toBe('network.invalid_response');
      }
    });

    it('a 200 finalize verdict whose permit id differs only by case is not accepted as THIS permit', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        answer(200, {
          ...verdict,
          permit: { ...verdict.permit, id: PERMIT_ID.toUpperCase() },
        }),
      );
      const error = await rejection(() =>
        client().release(PERMIT_ID, 'cancelled'),
      );
      expect(error.code).toBe('access.permit_release_unconfirmed');
    });

    it('the sync transport rejects a 2xx acknowledgement that is an array or that names an unknown shot', async () => {
      const transport = createTransport({ baseUrl, token: 'account-token' });
      const shots = [{ id: 'shot-1', analysisPermitId: PERMIT_ID }];
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(answer(200, [], { url: syncUrl }));
      let error = await rejection(() => transport.syncShots(shots));
      expect(error.status).toBe(502);
      expect(isPermanentSyncFailure(error)).toBe(false);
      jest.restoreAllMocks();
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          answer(
            200,
            { acceptedIds: ['shot-2'], rejected: [] },
            { url: syncUrl },
          ),
        );
      error = await rejection(() => transport.syncShots(shots));
      expect(error.code).toBe('sync.invalid_acknowledgement');
      expect(isPermanentSyncFailure(error)).toBe(false);
    });

    it('a reserve acknowledgement whose permit id is blank or whose status is unknown is never a reserved permit', async () => {
      const reserved = (overrides: Record<string, unknown>) => ({
        permit: {
          id: PERMIT_ID,
          accessSource: 'free',
          status: 'reserved',
          outcome: null,
          reservedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          ...overrides,
        },
        access: null,
      });
      for (const overrides of [
        { id: '   ' },
        { id: 7 },
        { expiresAt: 1_700_000_000 },
      ]) {
        jest.restoreAllMocks();
        jest
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(
            answer(200, reserved(overrides), { url: reserveUrl }),
          );
        const error = await rejection(() => client().reserve('key-1'));
        expect(error.status).toBe(502);
        expect(error.code).toBe('access.permit_invalid');
      }
    });

    it.each([
      ['status missing', { status: undefined }],
      ['status empty string', { status: '' }],
      ['status not a string', { status: 7 }],
      ['status outside the contract', { status: 'pending' }],
    ] as const)(
      'a reserve body naming a permit whose %s is not a server verdict: it must stay retryable, not become the terminal 409 access.permit_not_reserved',
      async (_name, overrides) => {
        jest.spyOn(globalThis, 'fetch').mockResolvedValue(
          answer(
            200,
            {
              permit: {
                id: PERMIT_ID,
                accessSource: 'free',
                outcome: null,
                reservedAt: '2026-01-01T00:00:00.000Z',
                expiresAt: '2026-01-02T00:00:00.000Z',
                ...overrides,
              },
              access: null,
            },
            { url: reserveUrl },
          ),
        );
        const error = await rejection(() => client().reserve('key-1'));
        // runJournal failure() turns 409 + access.permit_not_reserved into the
        // terminal reason 'permit_not_reserved' — a verdict the server never
        // issued for a body that carries no recognised status at all.
        expect(error.code).not.toBe('access.permit_not_reserved');
        expect(error.status).toBe(502);
      },
    );

    it('control: an idempotent replay answering with a settled permit IS the 409 access.permit_not_reserved verdict', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        answer(
          200,
          {
            permit: {
              id: PERMIT_ID,
              accessSource: 'free',
              status: 'finalized',
              outcome: 'cancelled',
              reservedAt: '2026-01-01T00:00:00.000Z',
              expiresAt: '2026-01-02T00:00:00.000Z',
            },
            access: null,
          },
          { url: reserveUrl },
        ),
      );
      const error = await rejection(() => client().reserve('key-1'));
      expect(error.status).toBe(409);
      expect(error.code).toBe('access.permit_not_reserved');
    });
  });
});
