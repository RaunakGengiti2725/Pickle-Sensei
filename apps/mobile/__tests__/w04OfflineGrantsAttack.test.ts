/**
 * W04-05 adversarial suite against candidate 7ec8d097 (offline grants).
 *
 * Each test states the invariant the wallet must hold at a failure boundary
 * and asserts it directly. A test that fails against the candidate is a
 * reproduced break; a test that passes is an attack the candidate survived.
 * Nothing here touches the candidate's own suite or production code.
 */
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
} from '@pickle/shared-types';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
import {
  OfflineGrantError,
  consumeOfflineAllocation,
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
  reconcileOfflineReceipts,
  settleOfflineReceipt,
} from '../src/data/offlineCapabilities';
import type { LocalDb } from '../src/data/db';
import {
  DataOwnerChangedError,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import { createSqliteTestDb } from '../testSupport/sqlite';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const INSTALLATION_KEY = 'ios-install-key-1';
const ISSUER = 'https://api.example.test/functions/v1/api';
const KEY_ID = 'offline-grant-key-1';
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };
const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = ISSUED_AT + 6 * 24 * 60 * 60;
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
] as const;
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const GRANT_ID_2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const RESULT_SHA = 'c'.repeat(64);
const RECEIPTS_ROUTE = `${ISSUER}/v1/offline/receipts`;
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface GrantFixture {
  grantId?: string;
  generation?: number;
  ticketIds?: readonly string[];
  issuedAt?: number;
  expiresAt?: number;
}

function issuedGrant(fixture: GrantFixture = {}): IssuedOfflineGrant {
  const grantId = fixture.grantId ?? GRANT_ID;
  const generation = fixture.generation ?? 1;
  const ticketIds = fixture.ticketIds ?? TICKETS;
  const issuedAt = fixture.issuedAt ?? ISSUED_AT;
  const expiresAt = fixture.expiresAt ?? EXPIRES_AT;
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: grantId,
    installationKeyId: INSTALLATION_KEY,
    iat: issuedAt,
    exp: expiresAt,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    entitlementSource: 'identity_lifetime_free',
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: grantId,
      generation,
      ticketIds,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  const parsed = parseIssuedOfflineGrant({
    grantId,
    generation,
    entitlementSource: 'identity_lifetime_free',
    issuedAt,
    expiresAt,
    entitlementExpiresAt: null,
    ticketIds,
    keyId: KEY_ID,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
  });
  if (!parsed) throw new Error('fixture grant response must parse');
  return parsed;
}

function reading(
  nowMs: number,
  overrides: Partial<TrustedTimeReading> = {},
): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
    ...overrides,
  };
}

const ACTIVE = reading((ISSUED_AT + 60) * 1000);

function consumption(operationId: string, grantId?: string) {
  return {
    operationId,
    resultId: `result-${operationId}`,
    fullOutputSha256: RESULT_SHA,
    ...(grantId ? { grantId } : {}),
  };
}

async function failure(promise: Promise<unknown>): Promise<OfflineGrantError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OfflineGrantError) return error;
    throw error;
  }
  throw new Error('expected the operation to fail');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the operation to fail');
    },
    (error: unknown) => error,
  );
}

function client() {
  return createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

type SubmittedReceipt = Record<string, unknown>;

function mockReceiptsRoute(
  answer: (submitted: SubmittedReceipt[]) => Response | Promise<Response>,
) {
  const submissions: SubmittedReceipt[][] = [];
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url !== RECEIPTS_ROUTE) {
        return jsonResponse({ error: 'not_found' }, { status: 404 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const receipts: SubmittedReceipt[] = body.receipts ?? [];
      submissions.push(receipts);
      return answer(receipts);
    });
  return { submissions, spy };
}

function recorded(
  submitted: SubmittedReceipt[],
  status = 'result_recorded',
): Response {
  return jsonResponse({
    receipts: submitted.map(receipt => ({
      receiptId: receipt['receiptId'],
      status,
    })),
    rejected: [],
  });
}

describe('W04-05 attack: offline grants at their failure boundaries', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    setActiveDataOwner(OWNER);
    handle.close();
  });

  describe('concurrency and reentrancy', () => {
    it('A1: three simultaneous consumptions spend at most the two allocated tickets, each once', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const outcomes = await Promise.allSettled([
        consumeOfflineAllocation(db, consumption('op-a'), ACTIVE),
        consumeOfflineAllocation(db, consumption('op-b'), ACTIVE),
        consumeOfflineAllocation(db, consumption('op-c'), ACTIVE),
      ]);
      const fulfilled = outcomes.filter(
        outcome => outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        outcome => outcome.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(2);
      expect(rejected).toHaveLength(1);
      const spent = fulfilled.map(outcome =>
        outcome.status === 'fulfilled'
          ? outcome.value.receipt.ticket?.ticketId
          : null,
      );
      expect(new Set(spent).size).toBe(2);
      expect(spent).toEqual(expect.arrayContaining([...TICKETS]));
      const blocked = rejected[0];
      expect(blocked?.status === 'rejected' && blocked.reason).toBeInstanceOf(
        OfflineGrantError,
      );
      expect(
        blocked?.status === 'rejected' &&
          (blocked.reason as OfflineGrantError).code,
      ).toBe('offline.allocation_exhausted');
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.spendableTickets).toBe(0);
      expect(snapshot.consumedTickets).toBe(2);
      expect(handle.count('offline_receipt', OWNER)).toBe(2);
      expect(handle.count('offline_ticket', OWNER)).toBe(2);
    });

    it('A2: the same operation submitted twice at once yields one receipt and one decrement', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const [first, second] = await Promise.all([
        consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
        consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
      ]);
      expect(first.receipt.receiptId).toBe(second.receipt.receiptId);
      expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.spendableTickets).toBe(1);
      expect(snapshot.consumedTickets).toBe(1);
    });

    it('A3: an account switch between the ticket decrement and the receipt insert rolls the whole spend back', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      let switched = false;
      handle.observeStatements(call => {
        if (!switched && call.sql.includes("SET state = 'consumed'")) {
          switched = true;
          setActiveDataOwner(OTHER_OWNER);
        }
      });
      const error = await rejection(
        consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
      );
      handle.observeStatements(null);
      expect(switched).toBe(true);
      expect(error).toBeInstanceOf(DataOwnerChangedError);
      // The other account sees no wallet at all.
      expect(await readOfflineAllocation(db, ACTIVE)).toMatchObject({
        grants: [],
        spendableTickets: 0,
        pendingReceipts: 0,
      });
      setActiveDataOwner(OWNER);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.spendableTickets).toBe(2);
      expect(snapshot.consumedTickets).toBe(0);
      expect(snapshot.pendingReceipts).toBe(0);
      expect(handle.count('offline_receipt', OWNER)).toBe(0);
      expect(
        handle.native
          .prepare(
            `SELECT count(*) AS n FROM offline_ticket WHERE owner_key = ? AND state = 'consumed'`,
          )
          .get(OWNER)?.n,
      ).toBe(0);
    });

    it('A4: an account switch while the receipts are in flight settles nothing for either account', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const consumed = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      const route = mockReceiptsRoute(submitted => {
        setActiveDataOwner(OTHER_OWNER);
        return recorded(submitted);
      });
      const error = await rejection(
        reconcileOfflineReceipts(db, client(), ACTIVE),
      );
      expect(route.submissions).toHaveLength(1);
      expect(error).toBeInstanceOf(OfflineGrantError);
      expect((error as OfflineGrantError).code).toBe('offline.receipt_unknown');
      expect(await pendingOfflineReceipts(db)).toEqual([]);
      expect(handle.count('offline_receipt', OTHER_OWNER)).toBe(0);
      setActiveDataOwner(OWNER);
      expect(await pendingOfflineReceipts(db)).toEqual([consumed.receipt]);
      expect(
        handle.native
          .prepare(
            `SELECT settlement, settled_at FROM offline_receipt WHERE owner_key = ?`,
          )
          .get(OWNER),
      ).toEqual({ settlement: null, settled_at: null });
    });

    it('A5: a crash between two verdict writes keeps the unsettled receipt queued and re-presents only it', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const first = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      const second = await consumeOfflineAllocation(
        db,
        consumption('op-2'),
        ACTIVE,
      );
      const route = mockReceiptsRoute(submitted => recorded(submitted));
      let settlementWrites = 0;
      handle.observeStatements(call => {
        if (call.sql.includes('UPDATE offline_receipt SET settlement')) {
          settlementWrites += 1;
          if (settlementWrites === 1) {
            handle.failStatementOnce(
              'UPDATE offline_receipt SET settlement',
              new Error('process died'),
            );
          }
        }
      });
      const error = await rejection(
        reconcileOfflineReceipts(db, client(), ACTIVE),
      );
      handle.observeStatements(null);
      expect(error).toEqual(new Error('process died'));
      const pending = await pendingOfflineReceipts(db);
      expect(pending.map(receipt => receipt.receiptId)).toEqual([
        second.receipt.receiptId,
      ]);
      expect(
        handle.native
          .prepare(
            `SELECT settlement FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
          )
          .get(OWNER, first.receipt.receiptId)?.settlement,
      ).toBe('accepted');
      // The next drain presents only what is still open.
      const again = await reconcileOfflineReceipts(db, client(), ACTIVE);
      expect(again).toEqual({
        submitted: 1,
        accepted: 1,
        held: 0,
        refused: 0,
        pending: 0,
      });
      expect(
        route.submissions[1]?.map(receipt => receipt['receiptId']),
      ).toEqual([second.receipt.receiptId]);
      // Tickets are never returned by settlement.
      expect((await readOfflineAllocation(db, ACTIVE)).spendableTickets).toBe(
        0,
      );
    });
  });

  describe('network failure at the receipts route', () => {
    it('A6: 429 + Retry-After, 5xx, a redirect and a timeout each settle nothing and keep every receipt queued', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const consumed = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      const answers: Array<{ name: string; response: () => Response }> = [
        {
          name: '429',
          response: () =>
            jsonResponse(
              { error: { code: 'rate_limited', message: 'slow down' } },
              { status: 429, headers: { 'retry-after': '30' } },
            ),
        },
        {
          name: '503',
          response: () =>
            jsonResponse({ error: { message: 'upstream' } }, { status: 503 }),
        },
        {
          name: '302',
          response: () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://captive.portal.test/login' },
            }),
        },
        {
          name: '401',
          response: () =>
            jsonResponse(
              { error: { code: 'unauthorized', message: 'expired' } },
              { status: 401 },
            ),
        },
      ];
      for (const answer of answers) {
        const route = mockReceiptsRoute(() => answer.response());
        const error = await rejection(
          reconcileOfflineReceipts(db, client(), ACTIVE),
        );
        route.spy.mockRestore();
        expect(error).toBeInstanceOf(ApiError);
        expect(await pendingOfflineReceipts(db)).toEqual([consumed.receipt]);
      }

      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      let requestStarted: () => void = () => undefined;
      const started = new Promise<void>(resolve => {
        requestStarted = resolve;
      });
      const hung = jest.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
            requestStarted();
          }),
      );
      const settled = rejection(reconcileOfflineReceipts(db, client(), ACTIVE));
      await started;
      jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS + 1);
      const timeout = await settled;
      hung.mockRestore();
      jest.useRealTimers();
      expect(timeout).toBeInstanceOf(ApiError);
      expect((timeout as ApiError).code).toBe('network.timeout');
      expect(await pendingOfflineReceipts(db)).toEqual([consumed.receipt]);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot).toMatchObject({
        spendableTickets: 1,
        consumedTickets: 1,
        pendingReceipts: 1,
      });
    });

    it('A15: a verdict batch with a duplicate, a missing, an extra, a double-listed or an unknown entry settles nothing at all', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const first = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      const second = await consumeOfflineAllocation(
        db,
        consumption('op-2'),
        ACTIVE,
      );
      const ids = [first.receipt.receiptId, second.receipt.receiptId];
      const batches: Array<(submitted: SubmittedReceipt[]) => unknown> = [
        // duplicate id, second id missing
        () => ({
          receipts: [
            { receiptId: ids[0], status: 'result_recorded' },
            { receiptId: ids[0], status: 'result_recorded' },
          ],
          rejected: [],
        }),
        // one missing
        () => ({
          receipts: [{ receiptId: ids[0], status: 'result_recorded' }],
          rejected: [],
        }),
        // one extra
        submitted => ({
          receipts: [
            ...submitted.map(receipt => ({
              receiptId: receipt['receiptId'],
              status: 'result_recorded',
            })),
            {
              receiptId: 'ffffffff-0000-4000-8000-000000000001',
              status: 'held',
            },
          ],
          rejected: [],
        }),
        // same receipt both recorded and rejected
        submitted => ({
          receipts: submitted.map(receipt => ({
            receiptId: receipt['receiptId'],
            status: 'result_recorded',
          })),
          rejected: [{ receiptId: ids[1], code: 'unused_ticket_returned' }],
        }),
        // unknown status for one, valid for the other
        () => ({
          receipts: [
            { receiptId: ids[0], status: 'result_recorded' },
            { receiptId: ids[1], status: 'charged' },
          ],
          rejected: [],
        }),
        // status carried as a number / null receipt id
        () => ({
          receipts: [
            { receiptId: ids[0], status: 1 },
            { receiptId: null, status: 'result_recorded' },
          ],
          rejected: [],
        }),
      ];
      for (const batch of batches) {
        const route = mockReceiptsRoute(submitted =>
          jsonResponse(batch(submitted)),
        );
        const error = await rejection(
          reconcileOfflineReceipts(db, client(), ACTIVE),
        );
        route.spy.mockRestore();
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('network.invalid_response');
        expect(
          (await pendingOfflineReceipts(db)).map(receipt => receipt.receiptId),
        ).toEqual(ids);
      }
      expect(
        handle.native
          .prepare(
            `SELECT count(*) AS n FROM offline_receipt WHERE owner_key = ? AND settlement IS NOT NULL`,
          )
          .get(OWNER)?.n,
      ).toBe(0);
    });
  });

  describe('boundary values and clocks', () => {
    it('A7: the seven-day lease bound and the expiry instant are exact', async () => {
      const exactly = issuedGrant({
        expiresAt: ISSUED_AT + OFFLINE_PRO_LEASE_MAX_SECONDS,
      });
      await holdOfflineGrant(db, exactly, BINDING);
      const overlong = await failure(
        holdOfflineGrant(
          db,
          issuedGrant({
            grantId: GRANT_ID_2,
            generation: 2,
            expiresAt: ISSUED_AT + OFFLINE_PRO_LEASE_MAX_SECONDS + 1,
          }),
          BINDING,
        ),
      );
      expect(overlong.code).toBe('offline.grant_invalid');
      expect(handle.count('offline_grant', OWNER)).toBe(1);

      const lastActiveMs = exactly.expiresAt * 1000 - 1;
      const active = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        reading(lastActiveMs),
      );
      expect(active.grant.execution.kind).toBe('active');
      const atExpiry = await failure(
        consumeOfflineAllocation(
          db,
          consumption('op-2'),
          reading(exactly.expiresAt * 1000),
        ),
      );
      expect(atExpiry.code).toBe('offline.grant_expired');
      // Far past, far future and a rolled-back clock all refuse without
      // touching the allocation.
      for (const when of [
        reading(0),
        reading(Number.MAX_SAFE_INTEGER),
        reading(lastActiveMs, { rollbackDetected: true }),
        reading(lastActiveMs, { authority: 'floor', continuity: 'persisted' }),
      ]) {
        const refused = await failure(
          consumeOfflineAllocation(db, consumption('op-3'), when),
        );
        expect([
          'offline.grant_expired',
          'offline.time_reconcile_required',
        ]).toContain(refused.code);
      }
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.spendableTickets).toBe(1);
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
    });

    it('A8: a NaN trusted-time reading is not evidence the lease is active', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const nan = reading(Number.NaN, { wallClockMs: ACTIVE.wallClockMs });
      const outcome = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        nan,
      ).then(
        () => 'consumed' as const,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(OfflineGrantError);
      expect((outcome as OfflineGrantError).code).toBe(
        'offline.time_reconcile_required',
      );
      expect((await readOfflineAllocation(db, ACTIVE)).spendableTickets).toBe(
        2,
      );
      expect(handle.count('offline_receipt', OWNER)).toBe(0);
    });
  });

  describe('generations, replay and settlement', () => {
    it('A9: a ticket the server refused and restates in a newer generation is spendable again', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const first = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      expect(first.receipt.ticket?.ticketId).toBe(TICKETS[0]);
      // Terminal server verdict: the receipt is refused (unused_ticket_returned
      // -> 'refused'); the ticket went back to the identity's budget.
      await settleOfflineReceipt(
        db,
        first.receipt.receiptId,
        'refused',
        ACTIVE,
      );
      // The next grant restates every outstanding ticket, T1 included.
      const restated = await holdOfflineGrant(
        db,
        issuedGrant({
          grantId: GRANT_ID_2,
          generation: 2,
          ticketIds: TICKETS,
          issuedAt: ISSUED_AT + 100,
          expiresAt: EXPIRES_AT + 100,
        }),
        BINDING,
      );
      expect(restated.allocated).toBe(2);
      expect(restated.remaining).toBe(2);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.spendableTickets).toBe(2);
      const spent = new Set<string | undefined>();
      for (const operation of ['op-2', 'op-3']) {
        const consumed = await consumeOfflineAllocation(
          db,
          consumption(operation),
          ACTIVE,
        );
        spent.add(consumed.receipt.ticket?.ticketId);
      }
      expect(spent).toEqual(new Set(TICKETS));
      const exhausted = await failure(
        consumeOfflineAllocation(db, consumption('op-4'), ACTIVE),
      );
      expect(exhausted.code).toBe('offline.allocation_exhausted');
    });

    it('A10: a newer generation that arrives before the older one never double-counts or double-spends', async () => {
      const newer = issuedGrant({
        grantId: GRANT_ID_2,
        generation: 2,
        issuedAt: ISSUED_AT + 100,
        expiresAt: EXPIRES_AT + 100,
      });
      await holdOfflineGrant(db, newer, BINDING);
      const older = await holdOfflineGrant(db, issuedGrant(), BINDING);
      expect(older.remaining).toBe(0);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.spendableTickets).toBe(2);
      expect(
        snapshot.grants.reduce((sum, grant) => sum + grant.remaining, 0),
      ).toBe(2);
      const spent = new Set<string | undefined>();
      for (const operation of ['op-1', 'op-2']) {
        const consumed = await consumeOfflineAllocation(
          db,
          consumption(operation),
          ACTIVE,
        );
        spent.add(consumed.receipt.ticket?.ticketId);
        expect(consumed.receipt.grantId).toBe(GRANT_ID_2);
      }
      expect(spent).toEqual(new Set(TICKETS));
      for (const grantId of [GRANT_ID, GRANT_ID_2, undefined]) {
        const exhausted = await failure(
          consumeOfflineAllocation(db, consumption('op-3', grantId), ACTIVE),
        );
        expect(exhausted.code).toBe('offline.allocation_exhausted');
      }
      expect(handle.count('offline_receipt', OWNER)).toBe(2);
    });

    it('A11: replaying an operation whose receipt was refused returns that refusal and spends nothing', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const first = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      await settleOfflineReceipt(
        db,
        first.receipt.receiptId,
        'refused',
        ACTIVE,
      );
      const replay = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.receipt.receiptId).toBe(first.receipt.receiptId);
      expect(replay.receipt.settlement).toBe('refused');
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
      expect((await readOfflineAllocation(db, ACTIVE)).spendableTickets).toBe(
        1,
      );
    });
  });

  describe('corrupt and tampered persisted state', () => {
    it('A12: stored grant columns that disagree with the signed claims are corruption, not authorization', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const forged = 'aaaaaaaa-0000-4000-8000-00000000f00d';
      handle.native
        .prepare(
          `UPDATE offline_grant SET allocated_ticket_ids = ? WHERE owner_key = ?`,
        )
        .run(JSON.stringify([...TICKETS, forged]), OWNER);
      handle.native
        .prepare(
          `INSERT INTO offline_ticket
             (owner_key, ticket_id, grant_id, allocation_id, generation, state, receipt_id, held_at)
           VALUES (?, ?, ?, ?, 1, 'remaining', NULL, ?)`,
        )
        .run(
          OWNER,
          forged,
          GRANT_ID,
          GRANT_ID,
          new Date(ACTIVE.wallClockMs).toISOString(),
        );
      const read = await failure(readOfflineAllocation(db, ACTIVE));
      expect(read.code).toBe('offline.wallet_corrupt');
      for (const operation of ['op-1', 'op-2', 'op-3']) {
        const consume = await failure(
          consumeOfflineAllocation(db, consumption(operation), ACTIVE),
        );
        expect(consume.code).toBe('offline.wallet_corrupt');
      }
      expect(handle.count('offline_receipt', OWNER)).toBe(0);
    });

    it('A13: a stored expiry later than the signed one does not extend offline execution', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      handle.native
        .prepare(`UPDATE offline_grant SET expires_at = ? WHERE owner_key = ?`)
        .run(EXPIRES_AT + 24 * 60 * 60, OWNER);
      const afterSignedExpiry = reading((EXPIRES_AT + 60) * 1000);
      const consume = await failure(
        consumeOfflineAllocation(db, consumption('op-1'), afterSignedExpiry),
      );
      expect(['offline.wallet_corrupt', 'offline.grant_expired']).toContain(
        consume.code,
      );
      expect(handle.count('offline_receipt', OWNER)).toBe(0);
    });

    it('A14: one unreadable receipt row is typed corruption and never reaches the network', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const consumed = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      handle.native
        .prepare(
          `UPDATE offline_receipt SET receipt = ? WHERE owner_key = ? AND receipt_id = ?`,
        )
        .run('{"receiptId":', OWNER, consumed.receipt.receiptId);
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const pending = await failure(pendingOfflineReceipts(db));
      expect(pending.code).toBe('offline.wallet_corrupt');
      const reconcile = await failure(
        reconcileOfflineReceipts(db, client(), ACTIVE),
      );
      expect(reconcile.code).toBe('offline.wallet_corrupt');
      expect(fetchSpy).not.toHaveBeenCalled();
      // The consumed ticket is not resurrected by the unreadable receipt.
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.consumedTickets).toBe(1);
      expect(snapshot.spendableTickets).toBe(1);
      expect(snapshot.pendingReceipts).toBe(1);
      // Replaying the operation behind the unreadable receipt is refused, not
      // re-spent.
      const replay = await failure(
        consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
      );
      expect(replay.code).toBe('offline.wallet_corrupt');
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
    });
  });
});
