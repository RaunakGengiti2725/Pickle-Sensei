/**
 * W02-03 adversarial suite — attacks the candidate process-death harness and
 * the shipping recovery path it exercises, at their failure boundaries:
 *
 *  A1 fixed point: a THIRD clean launch after every kill/relaunch pair must be
 *     a no-op (same durable state, no new server permit/shot/request);
 *  A2 crash INSIDE recovery: the relaunch itself is SIGKILLed mid-recovery /
 *     mid-drain and a further relaunch must still converge to one outcome;
 *  A3 network faults on the relaunch (5xx, 429 + Retry-After, redirect,
 *     timeout) at the release and at the sync step: no duplicate permit, no
 *     lost result, retry budget not burned by transient failures;
 *  A4 corrupt / partial persisted state between launches (clip bytes
 *     tampered or deleted, corrupt outbox payload, corrupt database file):
 *     never a fabricated score, never a second permit, never fresh history;
 *  A5 interleaved account switch across the crash: another account's
 *     relaunch must neither recover nor drain the crashed owner's rows;
 *  A6 clock rollback / far-future clock on the relaunch;
 *  A7 harness hermeticity: ambient PD_* variables in the parent environment
 *     must not leak into the relaunch.
 *
 * Nothing under `src/` or `__harness__/processDeath/` is modified; the
 * attack driver lives in `__harness__/processDeathAttack/`.
 */
import { readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { OUTBOX_MAX_ATTEMPTS } from '../src/data/sync';
import { API_REQUEST_TIMEOUT_MS } from '../src/data/api';
import {
  FIRST_OPERATION_ID,
  RELAUNCH_OPERATION_ID,
  runScenario,
} from '../__harness__/processDeath/harness';
import {
  KILL_POINTS,
  killPointById,
  type KillTrigger,
} from '../__harness__/processDeath/killPoints';
import type { ServerSnapshot } from '../__harness__/processDeath/ratingService';
import {
  OWNER_ID,
  type DurableSnapshot,
} from '../__harness__/processDeath/report';
import type { FaultRule } from '../__harness__/processDeathAttack/faultProxy';
import {
  runAttackScenario,
  type AnyChildReport,
  type AttackLaunchResult,
  type LaunchSpec,
} from '../__harness__/processDeathAttack/scenario';

const THIRD_OPERATION_ID = '44444444-4444-4444-8444-000000000003';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BEARER = 'attack-other-account-bearer';
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function kill(id: string): { id: string; trigger: KillTrigger } {
  return killPointById(id);
}

function reportOf(launch: AttackLaunchResult): AnyChildReport {
  expect(launch.signal).toBeNull();
  expect(launch.exitCode).toBe(0);
  expect(launch.stderr).toBe('');
  expect(launch.report).not.toBeNull();
  return launch.report as AnyChildReport;
}

function expectKilled(launch: AttackLaunchResult, id: string): void {
  expect(launch.signal).toBe('SIGKILL');
  expect(launch.exitCode).toBeNull();
  expect(launch.report).toBeNull();
  expect(launch.killMarker?.startsWith(`${id} `)).toBe(true);
}

/**
 * Structural invariants that must hold after ANY launch, whatever the
 * outcome: at most one operation/attempt/result/permit/server shot; a
 * server shot exists iff its permit was consumed `scored`; a local scored
 * result has exactly one of {outbox row, receipt}; nothing is owned by a
 * foreign account; the legacy journal stays empty.
 */
function expectConsistent(
  snapshot: DurableSnapshot,
  server: ServerSnapshot,
  ownerKey: string = OWNER_ID,
): void {
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
  expect(snapshot.captures.length).toBeLessThanOrEqual(1);
  expect(snapshot.operations.length).toBeLessThanOrEqual(1);
  expect(snapshot.attempts.length).toBeLessThanOrEqual(1);
  expect(snapshot.analysisRecords.length).toBe(snapshot.shots.length);
  expect(snapshot.shots.length).toBeLessThanOrEqual(1);
  expect(snapshot.outbox.length + snapshot.receipts.length).toBe(
    snapshot.shots.length,
  );
  expect(server.unauthorized).toEqual([]);
  expect(server.permits.length).toBeLessThanOrEqual(1);
  expect(server.shots.length).toBeLessThanOrEqual(1);
  const scoredPermits = server.permits.filter(
    permit => permit.status === 'finalized' && permit.outcome === 'scored',
  );
  expect(scoredPermits.length).toBe(server.shots.length);
  if (server.shots.length === 1) {
    expect(server.shots[0]?.permitId).toBe(scoredPermits[0]?.id);
    expect(snapshot.shots.map(shot => shot.id)).toEqual([server.shots[0]?.id]);
  }
  if (snapshot.attempts.length === 1 && server.permits.length === 1) {
    const attempt = snapshot.attempts[0]!;
    expect(server.permits[0]?.idempotencyKey).toBe(attempt.reservationKey);
    if (attempt.permitId !== null)
      expect(attempt.permitId).toBe(server.permits[0]?.id);
  }
  for (const request of server.requests) {
    if (request.path !== '/v1/analysis-permits') continue;
    expect(request.body).toEqual({
      idempotencyKey: snapshot.attempts[0]?.reservationKey,
    });
  }
}

function expectScored(
  snapshot: DurableSnapshot,
  server: ServerSnapshot,
  operationId: string,
): void {
  expectConsistent(snapshot, server);
  expect(snapshot.shots).toHaveLength(1);
  expect(snapshot.shots[0]?.resultKind).toBe('scored');
  expect(snapshot.outbox).toEqual([]);
  expect(snapshot.receipts).toHaveLength(1);
  expect(snapshot.captures.map(row => row.status)).toEqual(['analyzed']);
  expect(snapshot.operations[0]).toMatchObject({
    operationId,
    completionKind: 'scored',
    finalRecordId: snapshot.shots[0]?.id,
  });
  expect(snapshot.attempts[0]).toMatchObject({
    state: 'committed',
    resultId: snapshot.shots[0]?.id,
  });
  expect(server.unrouted).toEqual([]);
  expect(server.permits).toHaveLength(1);
  expect(server.shots).toHaveLength(1);
}

function expectHeld(snapshot: DurableSnapshot, server: ServerSnapshot): void {
  expectConsistent(snapshot, server);
  expect(snapshot.shots).toEqual([]);
  expect(snapshot.outbox).toEqual([]);
  expect(snapshot.receipts).toEqual([]);
  expect(snapshot.captures.map(row => row.status)).toEqual(['awaiting_model']);
  expect(snapshot.operations[0]).toMatchObject({
    operationId: FIRST_OPERATION_ID,
    completionKind: null,
    finalRecordId: null,
  });
  expect(snapshot.attempts[0]).toMatchObject({
    state: 'released',
    releaseOutcome: 'cancelled',
    terminalReason: null,
  });
  expect(server.unrouted).toEqual([]);
  expect(server.permits).toHaveLength(1);
  expect(server.permits[0]).toMatchObject({
    id: snapshot.attempts[0]?.permitId,
    status: 'finalized',
    outcome: 'cancelled',
  });
  expect(server.shots).toEqual([]);
}

function pathsOf(server: ServerSnapshot, from: number): string[] {
  return server.requests.slice(from).map(request => request.path);
}

const first = (id: string): LaunchSpec => ({
  launch: '1',
  operationId: FIRST_OPERATION_ID,
  kill: kill(id),
});
const relaunch = (
  overrides: Partial<LaunchSpec> = {},
  operationId = RELAUNCH_OPERATION_ID,
): LaunchSpec => ({ launch: '2', operationId, ...overrides });

describe('A1 fixed point — a third clean launch changes nothing', () => {
  it.each(KILL_POINTS)(
    'kill at $id → relaunch → second relaunch is a durable no-op',
    async point => {
      const { launches, server } = await runAttackScenario([
        first(point.id),
        relaunch(),
        relaunch({}, THIRD_OPERATION_ID),
      ]);
      expectKilled(launches[0]!, point.id);
      const second = reportOf(launches[1]!);
      const third = reportOf(launches[2]!);
      expectConsistent(second.final, launches[1]!.serverAfter);

      expect(third.asFound).toEqual(second.final);
      expect(third.afterRecovery).toEqual(second.final);
      expect(third.final).toEqual(second.final);
      expect(third.outcome?.kind).toBe(second.outcome?.kind);
      expect(third.outcome?.analysisId).toBe(second.outcome?.analysisId);
      // The third launch created nothing on the server.
      expect(server.permits).toEqual(launches[1]!.serverAfter.permits);
      expect(server.shots).toEqual(launches[1]!.serverAfter.shots);
      expect(pathsOf(server, launches[1]!.serverAfter.requests.length)).toEqual(
        [],
      );
      if (point.relaunch === 'scored') {
        expectScored(
          third.final,
          server,
          point.asFound.operations === 1
            ? FIRST_OPERATION_ID
            : RELAUNCH_OPERATION_ID,
        );
        expect(third.outcome?.replayed).toBe(true);
      } else {
        expectHeld(third.final, server);
      }
    },
  );

  it('control → relaunch proposing the SAME operation id replays without a request', async () => {
    const { launches, server } = await runAttackScenario([
      { launch: '1', operationId: FIRST_OPERATION_ID },
      relaunch({}, FIRST_OPERATION_ID),
    ]);
    const one = reportOf(launches[0]!);
    const two = reportOf(launches[1]!);
    expect(two.final).toEqual(one.final);
    expect(two.outcome?.replayed).toBe(true);
    expectScored(two.final, server, FIRST_OPERATION_ID);
    expect(pathsOf(server, 0)).toEqual([
      '/v1/analysis-permits',
      '/v1/shots:sync',
    ]);
  });
});

describe('A2 crash inside recovery — the relaunch itself dies mid-recovery', () => {
  const recoveryKills: ReadonlyArray<{
    readonly from: string;
    readonly id: string;
    readonly trigger: KillTrigger;
    readonly expect: 'scored' | 'held';
  }> = [
    {
      from: 'permit_reserved_response_lost',
      id: 'recovery_reserve_response_lost',
      trigger: {
        kind: 'http',
        pathIncludes: '/v1/analysis-permits',
        ordinal: 1,
        phase: 'after',
      },
      expect: 'held',
    },
    {
      from: 'commit_shot_inserted_mid_transaction',
      id: 'recovery_release_pending_marked',
      trigger: {
        kind: 'sql',
        includes: ["SET state = 'release_pending'"],
        ordinal: 1,
        phase: 'after',
      },
      expect: 'held',
    },
    {
      from: 'commit_shot_inserted_mid_transaction',
      id: 'recovery_finalize_before_request',
      trigger: {
        kind: 'http',
        pathIncludes: '/finalize',
        ordinal: 1,
        phase: 'before',
      },
      expect: 'held',
    },
    {
      from: 'commit_shot_inserted_mid_transaction',
      id: 'recovery_finalize_response_lost',
      trigger: {
        kind: 'http',
        pathIncludes: '/finalize',
        ordinal: 1,
        phase: 'after',
      },
      expect: 'held',
    },
    {
      from: 'commit_outbox_inserted_mid_transaction',
      id: 'recovery_released_update_before',
      trigger: {
        kind: 'sql',
        includes: ["SET state = 'released'"],
        ordinal: 1,
        phase: 'before',
      },
      expect: 'held',
    },
    {
      from: 'result_committed_before_sync_request',
      id: 'recovery_sync_response_lost',
      trigger: {
        kind: 'http',
        pathIncludes: '/v1/shots:sync',
        ordinal: 1,
        phase: 'after',
      },
      expect: 'scored',
    },
    {
      from: 'sync_accepted_response_lost',
      id: 'recovery_receipt_mid_transaction',
      trigger: {
        kind: 'sql',
        includes: ['INSERT OR REPLACE INTO sync_receipt'],
        ordinal: 1,
        phase: 'after',
      },
      expect: 'scored',
    },
  ];

  it.each(recoveryKills)(
    'kill at $from, then kill the relaunch at $id → third launch converges',
    async recoveryKill => {
      const { launches, server } = await runAttackScenario([
        first(recoveryKill.from),
        relaunch({
          kill: { id: recoveryKill.id, trigger: recoveryKill.trigger },
        }),
        relaunch({}, THIRD_OPERATION_ID),
      ]);
      expectKilled(launches[0]!, recoveryKill.from);
      expectKilled(launches[1]!, recoveryKill.id);
      const third = reportOf(launches[2]!);
      expectConsistent(third.asFound, launches[1]!.serverAfter);
      if (recoveryKill.expect === 'scored') {
        expectScored(third.final, server, FIRST_OPERATION_ID);
        expect(third.outcome?.replayed).toBe(true);
        expect(third.final.shots[0]?.id).toBe(third.asFound.shots[0]?.id);
      } else {
        expectHeld(third.final, server);
        expect(third.outcome?.cause).toBe('recovery_pending');
      }
      expect(third.final.attempts[0]?.permitId).toBe(server.permits[0]?.id);
    },
  );
});

describe('A3 network faults on the relaunch', () => {
  const retryAfter = { 'retry-after': '1' };
  const releaseFaults: ReadonlyArray<{
    readonly name: string;
    readonly faults: readonly FaultRule[];
  }> = [
    {
      name: '503 on every finalize',
      faults: [
        {
          pathIncludes: '/finalize',
          ordinal: 'all',
          fault: { kind: 'status', status: 503 },
        },
      ],
    },
    {
      name: '429 + Retry-After on every finalize',
      faults: [
        {
          pathIncludes: '/finalize',
          ordinal: 'all',
          fault: { kind: 'status', status: 429, headers: retryAfter },
        },
      ],
    },
    {
      name: '500 on every finalize',
      faults: [
        {
          pathIncludes: '/finalize',
          ordinal: 'all',
          fault: { kind: 'status', status: 500 },
        },
      ],
    },
  ];

  it.each(releaseFaults)(
    'RESERVED attempt, relaunch sees $name → stays HELD on the same permit, then releases once',
    async ({ faults }) => {
      const { launches, server } = await runAttackScenario(
        [
          first('commit_shot_inserted_mid_transaction'),
          relaunch({ faults }),
          relaunch({}, THIRD_OPERATION_ID),
        ],
        { proxy: true },
      );
      const second = reportOf(launches[1]!);
      const permitId = second.asFound.attempts[0]?.permitId;
      expect(typeof permitId).toBe('string');
      // Faulted relaunch: nothing fabricated, same permit, still pending.
      expectConsistent(second.final, launches[1]!.serverAfter);
      expect(second.outcome?.kind).toBe('unavailable');
      expect(second.final.shots).toEqual([]);
      expect(second.final.attempts[0]).toMatchObject({
        permitId,
        state: 'release_pending',
        releaseOutcome: 'cancelled',
        terminalReason: null,
      });
      expect(launches[1]!.serverAfter.permits).toEqual([
        expect.objectContaining({ id: permitId, status: 'reserved' }),
      ]);
      expect(
        launches[1]!.proxied.filter(request => request.faulted !== null).length,
      ).toBeGreaterThan(0);
      // Healthy relaunch: released cancelled exactly once.
      const third = reportOf(launches[2]!);
      expectHeld(third.final, server);
      expect(third.final.attempts[0]?.permitId).toBe(permitId);
      expect(
        server.requests.filter(request => request.path.endsWith('/finalize')),
      ).toHaveLength(1);
    },
  );

  const redirects: ReadonlyArray<{
    readonly name: string;
    readonly fault: FaultRule['fault'];
  }> = [
    {
      name: '302 to a captive-portal HTML page',
      fault: { kind: 'redirect', status: 302, target: 'portal_html' },
    },
    {
      name: '302 to a route the API does not have',
      fault: { kind: 'redirect', status: 302, target: 'not_found' },
    },
    {
      name: '307 to a route the API does not have',
      fault: { kind: 'redirect', status: 307, target: 'not_found' },
    },
  ];

  it.each(redirects)(
    'RESERVED attempt, relaunch finalize answered with a $name → the redirect is not a permit verdict',
    async ({ fault }) => {
      const { launches, server } = await runAttackScenario(
        [
          first('commit_shot_inserted_mid_transaction'),
          relaunch({
            faults: [{ pathIncludes: '/finalize', ordinal: 'all', fault }],
          }),
          relaunch({}, THIRD_OPERATION_ID),
        ],
        { proxy: true },
      );
      const second = reportOf(launches[1]!);
      const permitId = second.asFound.attempts[0]?.permitId;
      expect(second.final.shots).toEqual([]);
      expect(second.final.outbox).toEqual([]);
      // A redirect is transport noise, not the server's verdict on the
      // permit: the attempt must remain recoverable, not terminal.
      expect(second.final.attempts[0]).toMatchObject({
        permitId,
        state: 'release_pending',
        terminalReason: null,
      });
      const third = reportOf(launches[2]!);
      expectHeld(third.final, server);
      expect(third.final.attempts[0]?.permitId).toBe(permitId);
    },
  );

  const unverifiableAcks: ReadonlyArray<{
    readonly name: string;
    readonly fault: FaultRule['fault'];
  }> = [
    {
      name: '200 text/html page',
      fault: {
        kind: 'text',
        status: 200,
        contentType: 'text/html',
        text: '<html><body>Sign in to the network</body></html>',
      },
    },
    {
      name: '204 with no body',
      fault: { kind: 'text', status: 204, contentType: 'text/plain', text: '' },
    },
  ];

  it.each(unverifiableAcks)(
    'RESERVED attempt, relaunch finalize answered with a $name (server never finalized) → still recoverable, not released',
    async ({ fault }) => {
      const { launches, server } = await runAttackScenario(
        [
          first('commit_shot_inserted_mid_transaction'),
          relaunch({
            faults: [{ pathIncludes: '/finalize', ordinal: 'all', fault }],
          }),
          relaunch({}, THIRD_OPERATION_ID),
        ],
        { proxy: true },
      );
      const second = reportOf(launches[1]!);
      const permitId = second.asFound.attempts[0]?.permitId;
      // The upstream never saw a finalize: the permit is still reserved.
      expect(launches[1]!.serverAfter.permits).toEqual([
        expect.objectContaining({ id: permitId, status: 'reserved' }),
      ]);
      // ...so the local attempt must not claim the release happened.
      expect(second.final.attempts[0]).toMatchObject({
        permitId,
        state: 'release_pending',
        terminalReason: null,
      });
      const third = reportOf(launches[2]!);
      expectHeld(third.final, server);
    },
  );

  it(
    'RESERVED attempt, first finalize stalls past the request timeout → released once, no second permit',
    async () => {
      const { launches, server } = await runAttackScenario(
        [
          first('commit_shot_inserted_mid_transaction'),
          relaunch({
            faults: [
              {
                pathIncludes: '/finalize',
                ordinal: 1,
                fault: { kind: 'stall', ms: API_REQUEST_TIMEOUT_MS + 5_000 },
              },
            ],
          }),
        ],
        { proxy: true },
      );
      const second = reportOf(launches[1]!);
      expect(
        launches[1]!.proxied.filter(
          request => request.faulted?.kind === 'stall',
        ),
      ).toHaveLength(1);
      expectHeld(second.final, server);
      expect(second.final.attempts[0]?.permitId).toBe(
        second.asFound.attempts[0]?.permitId,
      );
    },
    // Wall clock: the shipping client waits API_REQUEST_TIMEOUT_MS (20s) for
    // the stalled finalize before it can retry; plus two child launches.
    API_REQUEST_TIMEOUT_MS + 40_000,
  );

  const syncFaults: ReadonlyArray<{
    readonly name: string;
    readonly fault: FaultRule['fault'];
  }> = [
    { name: '503', fault: { kind: 'status', status: 503 } },
    {
      name: '429 + Retry-After',
      fault: { kind: 'status', status: 429, headers: retryAfter },
    },
    { name: '502', fault: { kind: 'status', status: 502 } },
    ...redirects,
  ];

  it.each(syncFaults)(
    'COMMITTED result, relaunch sync answered $name → outbox row kept with its retry budget, then drains once',
    async ({ fault }) => {
      const { launches, server } = await runAttackScenario(
        [
          first('result_committed_before_sync_request'),
          relaunch({
            faults: [{ pathIncludes: '/v1/shots:sync', ordinal: 'all', fault }],
          }),
          relaunch({}, THIRD_OPERATION_ID),
        ],
        { proxy: true },
      );
      const second = reportOf(launches[1]!);
      expectConsistent(second.final, launches[1]!.serverAfter);
      expect(second.outcome?.kind).toBe('scored');
      expect(second.outcome?.replayed).toBe(true);
      expect(second.final.shots).toHaveLength(1);
      expect(second.final.receipts).toEqual([]);
      expect(second.final.outbox).toHaveLength(1);
      expect(second.final.outbox[0]?.shotId).toBe(second.final.shots[0]?.id);
      // Not a server verdict on the shot → the bounded budget is untouched.
      expect(second.final.outbox[0]?.attempts).toBe(0);
      expect(launches[1]!.serverAfter.shots).toEqual([]);
      expect(launches[1]!.serverAfter.permits[0]?.status).toBe('reserved');

      const third = reportOf(launches[2]!);
      expectScored(third.final, server, FIRST_OPERATION_ID);
      expect(third.final.shots[0]?.id).toBe(second.final.shots[0]?.id);
      expect(third.final.attempts[0]?.permitId).toBe(
        second.final.attempts[0]?.permitId,
      );
    },
  );

  it(
    'COMMITTED result, every relaunch sync redirected → the result is still delivered once the network is honest',
    async () => {
      const redirected = relaunch({
        faults: [
          {
            pathIncludes: '/v1/shots:sync',
            ordinal: 'all',
            fault: { kind: 'redirect', status: 302, target: 'not_found' },
          },
        ],
      });
      const { launches, server } = await runAttackScenario(
        [
          first('result_committed_before_sync_request'),
          ...Array.from({ length: OUTBOX_MAX_ATTEMPTS }, () => redirected),
          relaunch({}, THIRD_OPERATION_ID),
        ],
        { proxy: true },
      );
      for (const launch of launches.slice(1, -1)) {
        const report = reportOf(launch);
        expect(report.final.shots).toHaveLength(1);
        expect(report.final.outbox).toHaveLength(1);
        expect(launch.serverAfter.shots).toEqual([]);
      }
      const last = reportOf(launches[launches.length - 1]!);
      // The durable local result must reach the server: one shot, one
      // receipt, empty outbox — never a stranded row.
      expectScored(last.final, server, FIRST_OPERATION_ID);
    },
    // Wall clock: OUTBOX_MAX_ATTEMPTS + 2 sequential child launches.
    (OUTBOX_MAX_ATTEMPTS + 2) * 8_000,
  );
});

describe('A4 corrupt / partial persisted state between launches', () => {
  function tamperClip(moviePath: string): void {
    const bytes = readFileSync(moviePath);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(moviePath, bytes);
  }

  it('SEALED operation, clip bytes tampered before relaunch → no permit, no score, no second operation', async () => {
    const { launches, server } = await runAttackScenario([
      first('attempt_insert_mid_transaction'),
      relaunch({ before: ({ moviePath }) => tamperClip(moviePath) }),
      relaunch({}, THIRD_OPERATION_ID),
    ]);
    const second = reportOf(launches[1]!);
    expect(second.asFound.operations).toHaveLength(1);
    expect(second.asFound.attempts).toEqual([]);
    expectConsistent(second.final, launches[1]!.serverAfter);
    expect(second.outcome?.kind).not.toBe('scored');
    expect(second.final.shots).toEqual([]);
    expect(second.final.outbox).toEqual([]);
    expect(second.final.operations.map(row => row.operationId)).toEqual([
      FIRST_OPERATION_ID,
    ]);
    // Bytes that no longer match the sealed observation never reach the
    // rating service: no reservation, no charge path opened.
    expect(launches[1]!.serverAfter.permits).toEqual([]);
    expect(launches[1]!.serverAfter.requests).toEqual([]);
    const third = reportOf(launches[2]!);
    expectConsistent(third.final, server);
    expect(third.final.operations.map(row => row.operationId)).toEqual([
      FIRST_OPERATION_ID,
    ]);
    expect(server.permits).toEqual([]);
    expect(server.shots).toEqual([]);
  });

  it('COMMITTED result, clip file deleted before relaunch → the committed result still replays and drains once', async () => {
    const { launches, server } = await runAttackScenario([
      first('result_committed_before_sync_request'),
      relaunch({ before: ({ moviePath }) => unlinkSync(moviePath) }),
    ]);
    const second = reportOf(launches[1]!);
    expectScored(second.final, server, FIRST_OPERATION_ID);
    expect(second.outcome?.replayed).toBe(true);
    expect(second.final.shots[0]?.id).toBe(second.asFound.shots[0]?.id);
  });

  it('COMMITTED result, outbox payload corrupted before relaunch → no crash, no fabricated sync, no second row', async () => {
    const { launches, server } = await runAttackScenario([
      first('result_committed_before_sync_request'),
      relaunch({
        before: ({ dbPath }) => {
          const db = new DatabaseSync(dbPath);
          db.exec(`UPDATE outbox SET payload = '[]' WHERE kind = 'shot.sync'`);
          db.close();
        },
      }),
      relaunch({}, THIRD_OPERATION_ID),
    ]);
    const second = reportOf(launches[1]!);
    expect(second.asFound.outbox).toHaveLength(1);
    expect(second.asFound.outbox[0]?.shotId).toBeNull();
    expect(second.outcome?.kind).toBe('scored');
    expect(second.outcome?.replayed).toBe(true);
    expect(second.final.shots).toHaveLength(1);
    expect(second.final.outbox).toHaveLength(1);
    expect(second.final.receipts).toEqual([]);
    expect(launches[1]!.serverAfter.shots).toEqual([]);
    expect(pathsOf(launches[1]!.serverAfter, 1)).toEqual([]);
    const third = reportOf(launches[2]!);
    expect({ ...third.final, outbox: [] }).toEqual({
      ...second.final,
      outbox: [],
    });
    expect(third.final.outbox).toHaveLength(1);
    expect(pathsOf(server, 1)).toEqual([]);
    expect(server.shots).toEqual([]);
    expect(server.permits).toHaveLength(1);
    expect(server.permits[0]?.status).toBe('reserved');
  });

  it('COMMITTED result, database file overwritten with garbage → the relaunch never treats it as fresh history', async () => {
    const { launches, server } = await runAttackScenario([
      first('result_committed_before_sync_request'),
      relaunch({
        before: ({ dbPath }) => {
          const size = statSync(dbPath).size;
          writeFileSync(dbPath, Buffer.alloc(size, 0x41));
        },
      }),
    ]);
    const second = launches[1]!;
    // Either outcome is acceptable EXCEPT scoring again: an unreadable store
    // must never become an empty history that re-rates the capture.
    expect(second.report?.outcome?.kind ?? 'none').not.toBe('scored');
    expect(second.serverAfter.permits).toHaveLength(1);
    expect(second.serverAfter.permits[0]?.status).toBe('reserved');
    expect(second.serverAfter.shots).toEqual([]);
    expect(second.serverAfter.requests).toHaveLength(1);
    expect(server.requests.map(request => request.path)).toEqual([
      '/v1/analysis-permits',
    ]);
  });
});

describe('A5 interleaved account switch across the crash', () => {
  const otherAccount = {
    child: 'attack' as const,
    owner: { id: OTHER_OWNER_ID, bearer: OTHER_BEARER },
    mode: 'recover_only' as const,
  };

  it('RESERVED attempt of account A; account B relaunches → B touches nothing, A later releases the same permit', async () => {
    const { launches, server } = await runAttackScenario([
      first('commit_shot_inserted_mid_transaction'),
      relaunch(otherAccount),
      relaunch({}, THIRD_OPERATION_ID),
    ]);
    const asB = reportOf(launches[1]!);
    expect(asB.ownerKey).toBe(OTHER_OWNER_ID);
    expect(asB.final).toEqual(asB.asFound);
    expect(asB.final.attempts[0]).toMatchObject({
      ownerKey: OWNER_ID,
      state: 'reserved',
    });
    expect(launches[1]!.serverAfter.requests).toHaveLength(
      launches[0]!.serverAfter.requests.length,
    );
    expect(launches[1]!.serverAfter.unauthorized).toEqual([]);
    const asA = reportOf(launches[2]!);
    expectHeld(asA.final, server);
    expect(asA.final.attempts[0]?.permitId).toBe(
      asB.asFound.attempts[0]?.permitId,
    );
  });

  it('COMMITTED result of account A; account B relaunches → A’s outbox is not drained under B, then drains once as A', async () => {
    const { launches, server } = await runAttackScenario([
      first('result_committed_before_sync_request'),
      relaunch(otherAccount),
      relaunch({}, THIRD_OPERATION_ID),
    ]);
    const asB = reportOf(launches[1]!);
    expect(asB.final).toEqual(asB.asFound);
    expect(asB.final.outbox).toHaveLength(1);
    expect(asB.final.outbox[0]?.attempts).toBe(0);
    expect(launches[1]!.serverAfter.requests).toHaveLength(
      launches[0]!.serverAfter.requests.length,
    );
    expect(launches[1]!.serverAfter.unauthorized).toEqual([]);
    const asA = reportOf(launches[2]!);
    expectScored(asA.final, server, FIRST_OPERATION_ID);
    expect(asA.final.shots[0]?.id).toBe(asB.asFound.shots[0]?.id);
  });

  it('account B signed in with A’s rows on disk never scores A’s capture under B', async () => {
    const { launches, server } = await runAttackScenario([
      first('commit_shot_inserted_mid_transaction'),
      relaunch({ ...otherAccount, mode: 'full' }),
    ]);
    const asB = launches[1]!;
    // B has no capture with that id: the run must fail closed for B, not
    // score or recover A's attempt.
    expect(asB.report?.outcome?.kind ?? 'none').not.toBe('scored');
    expect(asB.serverAfter.requests).toHaveLength(
      launches[0]!.serverAfter.requests.length,
    );
    expect(server.unauthorized).toEqual([]);
    expect(server.permits).toHaveLength(1);
    expect(server.permits[0]?.status).toBe('reserved');
    expect(server.shots).toEqual([]);
  });
});

describe('A6 clock rollback / far-future clock on the relaunch', () => {
  const skews = [
    { name: 'rolled back ten years', offset: -TEN_YEARS_MS },
    { name: 'advanced ten years', offset: TEN_YEARS_MS },
    {
      name: 'advanced eighty years (past the permit expiry)',
      offset: 8 * TEN_YEARS_MS,
    },
  ];

  it.each(skews)(
    'RESERVED attempt, relaunch clock $name → HELD on the same permit',
    async ({ offset }) => {
      const { launches, server } = await runAttackScenario([
        first('commit_shot_inserted_mid_transaction'),
        relaunch({ child: 'attack', clockOffsetMs: offset }),
      ]);
      const second = reportOf(launches[1]!);
      expectHeld(second.final, server);
      expect(second.final.attempts[0]?.permitId).toBe(
        second.asFound.attempts[0]?.permitId,
      );
    },
  );

  it.each(skews)(
    'COMMITTED result, relaunch clock $name → one shot delivered',
    async ({ offset }) => {
      const { launches, server } = await runAttackScenario([
        first('result_committed_before_sync_request'),
        relaunch({ child: 'attack', clockOffsetMs: offset }),
      ]);
      const second = reportOf(launches[1]!);
      expectScored(second.final, server, FIRST_OPERATION_ID);
    },
  );

  it.each(skews)(
    'capture saved only, relaunch clock $name → scored once',
    async ({ offset }) => {
      const { launches, server } = await runAttackScenario([
        first('capture_saved'),
        relaunch({ child: 'attack', clockOffsetMs: offset }),
      ]);
      const second = reportOf(launches[1]!);
      expectScored(second.final, server, RELAUNCH_OPERATION_ID);
    },
  );
});

describe('A7 harness hermeticity', () => {
  it('ambient PD_KILL in the parent environment must not kill the relaunch', async () => {
    const point = killPointById('capture_saved');
    const previous = {
      PD_KILL: process.env['PD_KILL'],
      PD_KILL_ID: process.env['PD_KILL_ID'],
    };
    process.env['PD_KILL'] = JSON.stringify(point.trigger);
    process.env['PD_KILL_ID'] = 'ambient_environment';
    try {
      const result = await runScenario(null);
      expect(result.first.killMarker).toBeNull();
      expect(result.first.exitCode).toBe(0);
      expect(result.second.killMarker).toBeNull();
      expect(result.second.exitCode).toBe(0);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
