/**
 * W02-03 adversarial tests — attacks on candidate d5bb5556 at the boundaries
 * of the process-death harness and of `request()` / `release()` in
 * `src/data/api.ts`.
 *
 * Every case reuses the candidate's harness unchanged: a real child Node
 * process on a file-backed node:sqlite database, a loopback rating service,
 * and the fault proxy in front of it. The expectations are the candidate's
 * own stated invariants (ambiguous acknowledgement ⇒ HOLD on the same permit
 * id; transport artifacts never consume the outbox budget; recovery reuses
 * the same reservation key and permit; exactly one durable result / outbox
 * row / receipt / server shot / server permit).
 *
 * Attacks:
 *  A1  finalize answered 2xx with a JSON object that is NOT a permit verdict
 *      (`{}`, `{ok:true}`, `{permit:{}}`, a 200 carrying an error envelope, a
 *      202 `{}`) — must not be recorded as `released`.
 *  A2  same shapes at the `createAnalysisPermitClient().release()` unit level.
 *  A3  finalize answered with a NON-JSON 4xx (captive portal / gateway HTML
 *      403, 404, 400) — no verdict was given, the attempt must stay
 *      `release_pending` (not `terminal`) and the permit must be released on
 *      the next honest launch.
 *  A4  sync answered with a NON-JSON 4xx — the committed result's outbox
 *      budget must be untouched (attempts stay 0).
 *  A5  the RECOVERY launch itself is SIGKILLed with the server's answer lost
 *      (after finalize / after reserve / after sync) and a third launch runs.
 *  A6  retryable statuses (429 + Retry-After, 503) and a connection reset on
 *      the relaunch — finalize and sync.
 *  A7  301 / 308 redirects (the candidate suite covers 302 / 307 only).
 *  A8  a `reserve_pending` attempt (no permit id) whose relaunch RESERVE is
 *      answered with transport artifacts — no permit may be recorded, no
 *      second reservation key may ever be sent.
 */
import {
  FIRST_OPERATION_ID,
  RELAUNCH_OPERATION_ID,
  runLaunches,
  type LaunchOutcome,
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
import type { ServerSnapshot } from '../__harness__/processDeath/ratingService';
import type { ChildReport } from '../__harness__/processDeath/report';
import { ApiError, createAnalysisPermitClient } from '../src/data/api';

const FINALIZE_ROUTE = '/finalize';
const RESERVE_ROUTE = '/v1/analysis-permits';
const SYNC_ROUTE = '/v1/shots:sync';

function reportOf(launch: LaunchOutcome): ChildReport {
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

function relaunch(
  faults?: readonly FaultRule[],
  kill?: { readonly id: string; readonly trigger: KillTrigger },
): LaunchSpec {
  return {
    launch: '2',
    operationId: RELAUNCH_OPERATION_ID,
    ...(faults ? { faults } : {}),
    ...(kill ? { kill } : {}),
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
    .filter(path => path.includes(pathIncludes));
}

function expectRedirectNeverFollowed(launch: LaunchOutcome): void {
  expect(
    launch.proxied
      .map(request => request.path)
      .filter(path => path.startsWith(REDIRECT_TARGET_PATH)),
  ).toEqual([]);
}

function faultedRequests(launch: LaunchOutcome, pathIncludes: string) {
  return launch.proxied.filter(request => request.path.includes(pathIncludes));
}

function three(
  launches: readonly LaunchOutcome[],
): [LaunchOutcome, LaunchOutcome, LaunchOutcome] {
  expect(launches).toHaveLength(3);
  return launches as [LaunchOutcome, LaunchOutcome, LaunchOutcome];
}

/** Kill leaves ONE reserved attempt (permit held by the server); the relaunch
 * network swallows every finalize. The attempt must stay `release_pending`
 * on the same permit and the server permit must still be `reserved`. */
function expectFinalizeSwallowedKeepsHold(
  faulted: LaunchOutcome,
  fault: Fault,
): { report: ChildReport; permitId: string } {
  const second = reportOf(faulted);
  expect(second.asFound.attempts.map(row => row.state)).toEqual(['reserved']);
  const permitId = second.asFound.attempts[0]?.permitId;
  expect(typeof permitId).toBe('string');

  const finalizes = faultedRequests(faulted, FINALIZE_ROUTE);
  expect(finalizes.length).toBeGreaterThanOrEqual(1);
  for (const request of finalizes) expect(request.faulted).toEqual(fault);
  expectRedirectNeverFollowed(faulted);
  expect(serverPaths(faulted.serverAfter, FINALIZE_ROUTE)).toEqual([]);
  expect(faulted.serverAfter.permits).toEqual([
    expect.objectContaining({ id: permitId, status: 'reserved' }),
  ]);

  expect(second.outcome.kind).toBe('unavailable');
  expect(second.outcome.cause).toBe('recovery_pending');
  expect(second.final.analysisRecords).toEqual([]);
  expect(second.final.shots).toEqual([]);
  expect(second.final.outbox).toEqual([]);
  expect(second.final.operations.map(row => row.operationId)).toEqual([
    FIRST_OPERATION_ID,
  ]);
  expect(second.final.attempts).toHaveLength(1);
  // The server never settled this permit ⇒ the device must not claim it did,
  // and must not give up on it either.
  expect(second.final.attempts[0]).toMatchObject({
    permitId,
    state: 'release_pending',
    releaseOutcome: 'cancelled',
    terminalReason: null,
    resultId: null,
  });
  return { report: second, permitId: permitId as string };
}

/** The honest launch releases the SAME permit cancelled exactly once. */
function expectHonestReleaseOnce(
  honest: LaunchOutcome,
  server: ServerSnapshot,
  previous: ChildReport,
  permitId: string,
): void {
  const third = reportOf(honest);
  expect(third.asFound).toEqual(previous.final);
  expect(third.outcome.kind).toBe('unavailable');
  expect(third.final.analysisRecords).toEqual([]);
  expect(third.final.shots).toEqual([]);
  expect(third.final.outbox).toEqual([]);
  expect(third.final.attempts).toHaveLength(1);
  expect(third.final.attempts[0]).toMatchObject({
    permitId,
    state: 'released',
    releaseOutcome: 'cancelled',
    terminalReason: null,
  });
  expect(third.final.operations.map(row => row.operationId)).toEqual([
    FIRST_OPERATION_ID,
  ]);
  expect(serverPaths(server, FINALIZE_ROUTE)).toEqual([
    `/v1/analysis-permits/${permitId}/finalize`,
  ]);
  expect(server.permits).toEqual([
    expect.objectContaining({
      id: permitId,
      status: 'finalized',
      outcome: 'cancelled',
    }),
  ]);
  expect(server.shots).toEqual([]);
  expect(server.unrouted).toEqual([]);
  expect(server.unauthorized).toEqual([]);
}

/** Kill leaves ONE committed result + ONE outbox row; the relaunch network
 * swallows every sync. The row must keep its whole budget. */
function expectSyncSwallowedKeepsBudget(
  faulted: LaunchOutcome,
  fault: Fault,
): ChildReport {
  const report = reportOf(faulted);
  const asFound = report.asFound;
  expect(asFound.shots).toHaveLength(1);
  expect(asFound.outbox).toHaveLength(1);
  expect(asFound.attempts.map(row => row.state)).toEqual(['committed']);

  const syncs = faultedRequests(faulted, SYNC_ROUTE);
  expect(syncs.length).toBeGreaterThanOrEqual(1);
  for (const request of syncs) expect(request.faulted).toEqual(fault);
  expectRedirectNeverFollowed(faulted);
  expect(serverPaths(faulted.serverAfter, SYNC_ROUTE)).toEqual([]);
  expect(faulted.serverAfter.shots).toEqual([]);

  expect(report.outcome.kind).toBe('scored');
  expect(report.outcome.replayed).toBe(true);
  expect(report.final.shots).toEqual(asFound.shots);
  expect(report.final.receipts).toEqual([]);
  expect(report.final.outbox).toHaveLength(1);
  expect(report.final.outbox[0]).toMatchObject({
    id: asFound.outbox[0]?.id,
    kind: 'shot.sync',
    shotId: asFound.shots[0]?.id,
    attempts: 0,
  });
  return report;
}

function expectHonestDeliveryOnce(
  honest: LaunchOutcome,
  server: ServerSnapshot,
  previous: ChildReport,
): void {
  const third = reportOf(honest);
  expect(third.asFound).toEqual(previous.final);
  const analysisId = previous.outcome.analysisId;
  expect(third.outcome.kind).toBe('scored');
  expect(third.outcome.analysisId).toBe(analysisId);
  expect(third.final.shots.map(row => row.id)).toEqual([analysisId]);
  expect(third.final.outbox).toEqual([]);
  expect(third.final.receipts.map(row => [row.kind, row.entityId])).toEqual([
    ['shot.sync', analysisId],
  ]);
  expect(third.final.attempts).toHaveLength(1);
  expect(third.final.operations).toHaveLength(1);
  const permitId = third.final.attempts[0]?.permitId;
  expect(serverPaths(server, SYNC_ROUTE)).toEqual([SYNC_ROUTE]);
  expect(server.shots).toEqual([{ id: analysisId, permitId }]);
  expect(server.permits).toEqual([
    expect.objectContaining({
      id: permitId,
      status: 'finalized',
      outcome: 'scored',
    }),
  ]);
  expect(server.unrouted).toEqual([]);
  expect(server.unauthorized).toEqual([]);
}

const RESERVED_POINT = 'commit_shot_inserted_mid_transaction';
const RESERVE_PENDING_POINT = 'attempt_admitted_before_reserve_request';
const COMMITTED_POINT = 'result_committed_before_sync_request';

// ─────────────────────────────────────────────────────────────────────────────
// A1 — 2xx JSON objects that are not a permit verdict
// ─────────────────────────────────────────────────────────────────────────────
const JSON_NON_VERDICTS: readonly {
  readonly name: string;
  readonly fault: Fault;
}[] = [
  { name: '200 {}', fault: { kind: 'status', status: 200, body: {} } },
  {
    name: '200 {ok:true} (generic gateway body)',
    fault: { kind: 'status', status: 200, body: { ok: true } },
  },
  {
    name: '200 {permit:{}} (permit without id/status)',
    fault: { kind: 'status', status: 200, body: { permit: {} } },
  },
  {
    name: '200 {permit:{status:"finalized"}} (no permit id)',
    fault: {
      kind: 'status',
      status: 200,
      body: { permit: { status: 'finalized' } },
    },
  },
  {
    name: '200 carrying an error envelope',
    fault: {
      kind: 'status',
      status: 200,
      body: { error: { code: 'access.permit_not_found', message: 'x' } },
    },
  },
  { name: '202 {}', fault: { kind: 'status', status: 202, body: {} } },
];

describe('A1 — finalize answered 2xx with a JSON object that is not a permit verdict', () => {
  const point = killPoint(RESERVED_POINT);

  it.each(JSON_NON_VERDICTS)(
    '$name → attempt must stay release_pending on the same permit; the server permit is still reserved',
    async ({ fault }) => {
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: FINALIZE_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);
      const { report, permitId } = expectFinalizeSwallowedKeepsHold(
        faulted,
        fault,
      );
      expectHonestReleaseOnce(honest, server, report, permitId);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — unit level: release() acknowledgement validation
// ─────────────────────────────────────────────────────────────────────────────
describe('A2 — createAnalysisPermitClient().release() acknowledgement validation', () => {
  const permitId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
  const requestUrl = `https://api.example.test/v1/analysis-permits/${permitId}/finalize`;

  /** A same-origin, non-redirected JSON answer, as the runtime hands it to
   * `request()` (the fields `request()` reads). */
  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      type: 'basic',
      redirected: false,
      url: requestUrl,
      json: async () => body,
    } as Response;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('control: a permit verdict for this permit id and outcome is accepted', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(200, {
        permit: {
          id: permitId,
          status: 'finalized',
          outcome: 'cancelled',
          accessSource: 'free',
          expiresAt: '2100-01-01T00:00:00.000Z',
        },
        access: null,
      }),
    );
    const client = createAnalysisPermitClient({
      baseUrl: 'https://api.example.test',
      token: 'account-token',
    });
    await expect(
      client.release(permitId, 'cancelled'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['200 {}', 200, {}],
    ['200 {ok:true}', 200, { ok: true }],
    ['200 {permit:{}}', 200, { permit: {} }],
    [
      '200 {permit:{status:"finalized"}}',
      200,
      { permit: { status: 'finalized' } },
    ],
    ['200 {access:null}', 200, { access: null }],
    ['200 error envelope', 200, { error: { code: 'x', message: 'y' } }],
    ['202 {}', 202, {}],
  ] as const)(
    '%s is not a permit verdict → release() must reject with access.permit_release_unconfirmed',
    async (_name, status, body) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => jsonResponse(status, body));
      const client = createAnalysisPermitClient({
        baseUrl: 'https://api.example.test',
        token: 'account-token',
      });
      let caught: unknown = null;
      try {
        await client.release(permitId, 'cancelled');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(502);
      expect((caught as ApiError).code).toBe(
        'access.permit_release_unconfirmed',
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — non-JSON 4xx on finalize
// ─────────────────────────────────────────────────────────────────────────────
const HTML_4XX: readonly { readonly name: string; readonly fault: Fault }[] = [
  {
    name: '403 text/html (captive portal / WAF page)',
    fault: {
      kind: 'text',
      status: 403,
      contentType: 'text/html',
      text: '<html><body>Forbidden</body></html>',
    },
  },
  {
    name: '404 text/html (gateway page)',
    fault: {
      kind: 'text',
      status: 404,
      contentType: 'text/html',
      text: '<html><body>Not Found</body></html>',
    },
  },
  {
    name: '400 text/plain (proxy error)',
    fault: {
      kind: 'text',
      status: 400,
      contentType: 'text/plain',
      text: 'Bad Request',
    },
  },
];

describe('A3 — finalize answered with a non-JSON 4xx is not a verdict on the permit', () => {
  const point = killPoint(RESERVED_POINT);

  it.each(HTML_4XX)(
    '$name → attempt must stay release_pending (not terminal); the next honest launch releases the same permit once',
    async ({ fault }) => {
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: FINALIZE_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);
      const { report, permitId } = expectFinalizeSwallowedKeepsHold(
        faulted,
        fault,
      );
      expectHonestReleaseOnce(honest, server, report, permitId);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 — non-JSON 4xx on sync
// ─────────────────────────────────────────────────────────────────────────────
describe('A4 — sync answered with a non-JSON 4xx never consumes the outbox budget', () => {
  const point = killPoint(COMMITTED_POINT);

  it.each(HTML_4XX)(
    '$name → outbox attempts stay 0; the next honest launch delivers the shot exactly once',
    async ({ fault }) => {
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: SYNC_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);
      const second = expectSyncSwallowedKeepsBudget(faulted, fault);
      expectHonestDeliveryOnce(honest, server, second);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A5 — the recovery launch itself dies with the server's answer lost
// ─────────────────────────────────────────────────────────────────────────────
describe('A5 — recovery launch SIGKILLed after the server answered (acknowledgement lost)', () => {
  it('reserved attempt: relaunch dies after the finalize answer → third launch finds the permit settled and records released; one permit, one finalize outcome', async () => {
    const point = killPoint(RESERVED_POINT);
    const killId = 'recovery_finalize_response_lost';
    const { launches, server } = await runLaunches([
      killLaunch(point),
      relaunch(undefined, {
        id: killId,
        trigger: {
          kind: 'http',
          pathIncludes: FINALIZE_ROUTE,
          ordinal: 1,
          phase: 'after',
        },
      }),
      relaunch(),
    ]);
    const [killed, recoveryKilled, honest] = three(launches);
    expectKilledAt(killed, point.id);
    expectKilledAt(recoveryKilled, killId);
    // The server finalized the permit before the second death.
    expect(recoveryKilled.serverAfter.permits).toHaveLength(1);
    expect(recoveryKilled.serverAfter.permits[0]).toMatchObject({
      status: 'finalized',
      outcome: 'cancelled',
    });
    const permitId = recoveryKilled.serverAfter.permits[0]?.id;

    const third = reportOf(honest);
    expect(third.asFound.attempts).toHaveLength(1);
    expect(third.asFound.attempts[0]).toMatchObject({
      permitId,
      state: 'release_pending',
      releaseOutcome: 'cancelled',
    });
    expect(third.outcome.kind).toBe('unavailable');
    expect(third.final.attempts).toHaveLength(1);
    expect(third.final.attempts[0]).toMatchObject({
      permitId,
      state: 'released',
      releaseOutcome: 'cancelled',
      terminalReason: null,
      resultId: null,
    });
    expect(third.final.operations.map(row => row.operationId)).toEqual([
      FIRST_OPERATION_ID,
    ]);
    expect(third.final.shots).toEqual([]);
    expect(third.final.outbox).toEqual([]);
    expect(third.final.analysisRecords).toEqual([]);
    expect(server.permits).toHaveLength(1);
    expect(server.shots).toEqual([]);
    expect(serverPaths(server, FINALIZE_ROUTE)).toEqual([
      `/v1/analysis-permits/${permitId}/finalize`,
      `/v1/analysis-permits/${permitId}/finalize`,
    ]);
    expect(server.unrouted).toEqual([]);
    expect(server.unauthorized).toEqual([]);
  });

  it('reserve_pending attempt: relaunch dies after the reserve answer → third launch reuses the SAME reservation key and permit; exactly one server permit', async () => {
    const point = killPoint(RESERVE_PENDING_POINT);
    const killId = 'recovery_reserve_response_lost';
    const { launches, server } = await runLaunches([
      killLaunch(point),
      relaunch(undefined, {
        id: killId,
        trigger: {
          kind: 'http',
          pathIncludes: RESERVE_ROUTE,
          ordinal: 1,
          phase: 'after',
        },
      }),
      relaunch(),
    ]);
    const [killed, recoveryKilled, honest] = three(launches);
    expectKilledAt(killed, point.id);
    expectKilledAt(recoveryKilled, killId);
    expect(recoveryKilled.serverAfter.permits).toHaveLength(1);
    expect(recoveryKilled.serverAfter.permits[0]?.status).toBe('reserved');
    const permitId = recoveryKilled.serverAfter.permits[0]?.id;
    const reservationKey =
      recoveryKilled.serverAfter.permits[0]?.idempotencyKey;

    const third = reportOf(honest);
    expect(third.asFound.attempts).toHaveLength(1);
    expect(third.asFound.attempts[0]?.reservationKey).toBe(reservationKey);
    expect(third.asFound.attempts[0]?.permitId).toBeNull();
    expect(third.outcome.kind).toBe('unavailable');
    expect(third.final.attempts).toHaveLength(1);
    expect(third.final.attempts[0]).toMatchObject({
      reservationKey,
      permitId,
      state: 'released',
      releaseOutcome: 'cancelled',
      terminalReason: null,
    });
    expect(third.final.operations.map(row => row.operationId)).toEqual([
      FIRST_OPERATION_ID,
    ]);
    expect(third.final.shots).toEqual([]);
    expect(server.permits).toEqual([
      expect.objectContaining({
        id: permitId,
        idempotencyKey: reservationKey,
        status: 'finalized',
        outcome: 'cancelled',
      }),
    ]);
    for (const request of server.requests) {
      if (request.path !== RESERVE_ROUTE) continue;
      expect(request.body).toEqual({ idempotencyKey: reservationKey });
    }
    expect(server.shots).toEqual([]);
    expect(server.unrouted).toEqual([]);
    expect(server.unauthorized).toEqual([]);
  });

  it('committed result: relaunch dies after the sync answer → third launch ends with one receipt, one server shot, no second sync consume', async () => {
    const point = killPoint(COMMITTED_POINT);
    const killId = 'recovery_sync_response_lost';
    const { launches, server } = await runLaunches([
      killLaunch(point),
      relaunch(undefined, {
        id: killId,
        trigger: {
          kind: 'http',
          pathIncludes: SYNC_ROUTE,
          ordinal: 1,
          phase: 'after',
        },
      }),
      relaunch(),
    ]);
    const [killed, recoveryKilled, honest] = three(launches);
    expectKilledAt(killed, point.id);
    expectKilledAt(recoveryKilled, killId);
    expect(recoveryKilled.serverAfter.shots).toHaveLength(1);

    const third = reportOf(honest);
    expect(third.asFound.outbox).toHaveLength(1);
    expect(third.asFound.receipts).toEqual([]);
    expect(third.outcome.kind).toBe('scored');
    expect(third.outcome.replayed).toBe(true);
    const analysisId = third.outcome.analysisId;
    expect(third.final.shots.map(row => row.id)).toEqual([analysisId]);
    expect(third.final.outbox).toEqual([]);
    expect(third.final.receipts.map(row => [row.kind, row.entityId])).toEqual([
      ['shot.sync', analysisId],
    ]);
    expect(third.final.attempts).toHaveLength(1);
    expect(third.final.operations).toHaveLength(1);
    expect(server.shots).toHaveLength(1);
    expect(server.permits).toHaveLength(1);
    expect(server.permits[0]).toMatchObject({
      status: 'finalized',
      outcome: 'scored',
    });
    expect(serverPaths(server, SYNC_ROUTE)).toEqual([SYNC_ROUTE, SYNC_ROUTE]);
    expect(server.unrouted).toEqual([]);
    expect(server.unauthorized).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A6 — retryable statuses and a connection reset
// ─────────────────────────────────────────────────────────────────────────────
const RETRYABLE: readonly { readonly name: string; readonly fault: Fault }[] = [
  {
    name: '429 + Retry-After',
    fault: {
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '1' },
      body: { error: { code: 'rate_limited', message: 'Slow down.' } },
    },
  },
  {
    name: '503 JSON',
    fault: {
      kind: 'status',
      status: 503,
      body: { error: { code: 'service_unavailable', message: 'Down.' } },
    },
  },
  {
    name: 'connection reset before any byte of the answer',
    fault: { kind: 'stall', ms: 50 },
  },
];

describe('A6 — retryable failures on the relaunch', () => {
  it.each(RETRYABLE)(
    'finalize answered with $name → release_pending on the same permit; honest launch releases once',
    async ({ fault }) => {
      const point = killPoint(RESERVED_POINT);
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: FINALIZE_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);
      const { report, permitId } = expectFinalizeSwallowedKeepsHold(
        faulted,
        fault,
      );
      expectHonestReleaseOnce(honest, server, report, permitId);
    },
  );

  it.each(RETRYABLE)(
    'sync answered with $name → outbox attempts stay 0; honest launch delivers once',
    async ({ fault }) => {
      const point = killPoint(COMMITTED_POINT);
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: SYNC_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);
      const second = expectSyncSwallowedKeepsBudget(faulted, fault);
      expectHonestDeliveryOnce(honest, server, second);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A7 — 301 / 308 redirects
// ─────────────────────────────────────────────────────────────────────────────
const OTHER_REDIRECTS: readonly {
  readonly name: string;
  readonly fault: Fault;
}[] = [
  {
    name: '301 to a captive-portal page',
    fault: { kind: 'redirect', status: 301, target: 'portal_html' },
  },
  {
    name: '308 to a route the API does not have (404)',
    fault: { kind: 'redirect', status: 308, target: 'not_found' },
  },
];

describe('A7 — 301 / 308 redirects are never followed and settle nothing', () => {
  it.each(OTHER_REDIRECTS)(
    'finalize answered with $name → release_pending; honest launch releases once',
    async ({ fault }) => {
      const point = killPoint(RESERVED_POINT);
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: FINALIZE_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);
      const { report, permitId } = expectFinalizeSwallowedKeepsHold(
        faulted,
        fault,
      );
      expectHonestReleaseOnce(honest, server, report, permitId);
    },
  );

  it.each(OTHER_REDIRECTS)(
    'sync answered with $name → attempts stay 0; honest launch delivers once',
    async ({ fault }) => {
      const point = killPoint(COMMITTED_POINT);
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: SYNC_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);
      const second = expectSyncSwallowedKeepsBudget(faulted, fault);
      expectHonestDeliveryOnce(honest, server, second);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A8 — transport artifacts on the recovery RESERVE (no permit id yet)
// ─────────────────────────────────────────────────────────────────────────────
const RESERVE_ARTIFACTS: readonly {
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
  { name: '200 {}', fault: { kind: 'status', status: 200, body: {} } },
  {
    name: '204 with no body',
    fault: { kind: 'text', status: 204, contentType: 'text/plain', text: '' },
  },
  {
    name: '302 to a captive-portal page',
    fault: { kind: 'redirect', status: 302, target: 'portal_html' },
  },
  {
    name: '403 text/html',
    fault: {
      kind: 'text',
      status: 403,
      contentType: 'text/html',
      text: '<html><body>Forbidden</body></html>',
    },
  },
];

describe('A8 — reserve_pending attempt whose recovery reserve is answered with a transport artifact', () => {
  const point = killPoint(RESERVE_PENDING_POINT);

  it.each(RESERVE_ARTIFACTS)(
    'reserve answered with $name → no permit recorded, attempt stays pending; honest launch reserves under the SAME key once and releases it',
    async ({ fault }) => {
      const { launches, server } = await runLaunches(
        [
          killLaunch(point),
          relaunch([{ pathIncludes: RESERVE_ROUTE, ordinal: 'all', fault }]),
          relaunch(),
        ],
        { proxy: true },
      );
      const [killed, faulted, honest] = three(launches);
      expectKilledAt(killed, point.id);

      const second = reportOf(faulted);
      expect(second.asFound.attempts.map(row => row.state)).toEqual([
        'reserve_pending',
      ]);
      const reservationKey = second.asFound.attempts[0]?.reservationKey;
      expect(typeof reservationKey).toBe('string');
      const reserves = faultedRequests(faulted, RESERVE_ROUTE);
      expect(reserves.length).toBeGreaterThanOrEqual(1);
      for (const request of reserves) expect(request.faulted).toEqual(fault);
      expectRedirectNeverFollowed(faulted);
      expect(faulted.serverAfter.permits).toEqual([]);
      expect(faulted.serverAfter.requests).toEqual([]);

      expect(second.outcome.kind).toBe('unavailable');
      expect(second.final.attempts).toHaveLength(1);
      expect(second.final.attempts[0]).toMatchObject({
        reservationKey,
        permitId: null,
        state: 'release_pending',
        terminalReason: null,
        resultId: null,
      });
      expect(second.final.shots).toEqual([]);
      expect(second.final.outbox).toEqual([]);
      expect(second.final.operations.map(row => row.operationId)).toEqual([
        FIRST_OPERATION_ID,
      ]);

      const third = reportOf(honest);
      expect(third.asFound).toEqual(second.final);
      expect(third.outcome.kind).toBe('unavailable');
      expect(third.final.attempts).toHaveLength(1);
      expect(third.final.attempts[0]).toMatchObject({
        reservationKey,
        state: 'released',
        releaseOutcome: 'cancelled',
        terminalReason: null,
      });
      const permitId = third.final.attempts[0]?.permitId;
      expect(typeof permitId).toBe('string');
      expect(server.permits).toEqual([
        expect.objectContaining({
          id: permitId,
          idempotencyKey: reservationKey,
          status: 'finalized',
          outcome: 'cancelled',
        }),
      ]);
      for (const request of server.requests) {
        if (request.path !== RESERVE_ROUTE) continue;
        expect(request.body).toEqual({ idempotencyKey: reservationKey });
      }
      expect(server.shots).toEqual([]);
      expect(server.unrouted).toEqual([]);
      expect(server.unauthorized).toEqual([]);
    },
  );
});
