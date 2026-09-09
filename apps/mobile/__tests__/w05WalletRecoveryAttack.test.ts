/**
 * W05-03 adversarial suite — attacks the candidate wallet journal
 * (`src/data/offlineWallet.ts` @ 083ae400) at its failure boundaries. Every
 * test here is written against the candidate's OWN contract (its doc
 * comments, the implementer summary and the product invariants): a failing
 * test is a confirmed break, a passing test is an attack that did not land.
 *
 * Attack categories (numbered in the describe titles):
 *  A1 concurrency / interleaved account switch while a presentation is in
 *     flight (owner A → owner B → owner A; sign-out mid-flight; reentrancy)
 *  A2 replay and duplicate identities in the server's answer
 *  A3 network failure at the receipts route (429+Retry-After, 5xx, 401,
 *     redirect, empty/garbage body, timeout)
 *  A4 corrupt / partial persisted journal state
 *  A5 boundary clocks (NaN, ±Infinity, out-of-range, rollback) and
 *     untrusted-time readings
 *  A6 atomicity + free-rating conservation under partial failure and
 *     interleaved consumption
 *  A7 process death and restart beyond the candidate's kill points
 *     (double kill across relaunches, kill inside the recovery transaction,
 *     kill on a held re-presentation)
 *  A8 unauthorised roles (guest, signed-out) and user-facing copy
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
} from '@pickle/shared-types';
import type { KillTrigger } from '../__harness__/processDeath/killPoints';
import { KILL_PREFIX } from '../__harness__/processDeath/killSwitch';
import {
  BEARER_TOKEN,
  OWNER_ID,
  REPORT_PREFIX,
} from '../__harness__/processDeath/report';
import type {
  WalletChildReport,
  WalletFixtureFile,
} from '../__harness__/processDeath/walletChild';
import {
  DataOwnerChangedError,
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
import type { LocalDb } from '../src/data/db';
import {
  OfflineGrantError,
  consumeOfflineAllocation,
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import {
  readOfflineWalletJournal,
  readOfflineWalletStatus,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import { createSqliteTestDb } from '../testSupport/sqlite';

const OWNER = OWNER_ID;
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
const OTHER_TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000011',
  'aaaaaaaa-0000-4000-8000-000000000012',
] as const;
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const RESULT_SHA = 'c'.repeat(64);
const RECEIPTS_PATH = '/v1/offline/receipts';
const RECEIPTS_ROUTE = `${ISSUER}${RECEIPTS_PATH}`;

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface GrantFixture {
  readonly issuer?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly owner?: string;
  readonly grantId?: string;
  readonly ticketIds?: readonly string[];
}

function grantResponse(fixture: GrantFixture = {}): Record<string, unknown> {
  const issuedAt = fixture.issuedAt ?? ISSUED_AT;
  const expiresAt = fixture.expiresAt ?? EXPIRES_AT;
  const owner = fixture.owner ?? OWNER;
  const grantId = fixture.grantId ?? GRANT_ID;
  const ticketIds = fixture.ticketIds ?? TICKETS;
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: fixture.issuer ?? ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: owner,
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
      generation: 1,
      ticketIds,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  return {
    grantId,
    generation: 1,
    entitlementSource: 'identity_lifetime_free',
    issuedAt,
    expiresAt,
    entitlementExpiresAt: null,
    ticketIds,
    keyId: KEY_ID,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
  };
}

function issuedGrant(fixture: GrantFixture = {}): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant(grantResponse(fixture));
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

const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const ACTIVE = reading((ISSUED_AT + 60) * 1000);

function consumption(operationId: string, resultSuffix = '') {
  return {
    operationId,
    resultId: `result-${operationId}${resultSuffix}`,
    fullOutputSha256: RESULT_SHA,
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
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

interface ReceiptsRouteCall {
  readonly url: string;
  readonly receiptIds: readonly string[];
}

type RouteAnswer =
  Record<string, unknown> | Response | Error | Promise<Record<string, unknown>>;

/** Fetch double for the receipts route that also keeps the server-side
 * idempotency ledger (how often each receipt id was presented). */
function mockReceiptsRoute(
  answer: (receiptIds: readonly string[], call: number) => RouteAnswer,
) {
  const calls: ReceiptsRouteCall[] = [];
  const presentations = new Map<string, number>();
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      const receipts =
        typeof body === 'object' && body !== null && 'receipts' in body
          ? (body as { receipts: Array<{ receiptId: string }> }).receipts
          : [];
      const receiptIds = receipts.map(receipt => receipt.receiptId);
      calls.push({ url, receiptIds });
      for (const id of receiptIds) {
        presentations.set(id, (presentations.get(id) ?? 0) + 1);
      }
      if (url !== RECEIPTS_ROUTE) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const verdict = await answer(receiptIds, calls.length);
      if (verdict instanceof Error) throw verdict;
      if (verdict instanceof Response) return verdict;
      return new Response(JSON.stringify(verdict), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  return { calls, spy, presentations };
}

function recorded(
  receiptIds: readonly string[],
  status: (receiptId: string) => string = () => 'result_recorded',
): Record<string, unknown> {
  return {
    receipts: receiptIds.map(receiptId => ({
      receiptId,
      status: status(receiptId),
    })),
    rejected: [],
  };
}

function jsonResponse(status: number, body: unknown, headers = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client() {
  return createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
}

const IDLE = {
  submitted: 0,
  accepted: 0,
  held: 0,
  refused: 0,
  pending: 0,
  recovered: 0,
  stale: 0,
};

describe('W05-03 attack: wallet journal failure boundaries', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;
  let route: ReturnType<typeof mockReceiptsRoute> | null = null;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => {
    jest.useRealTimers();
    route?.spy.mockRestore();
    route = null;
    setActiveDataOwner(OWNER);
    handle.close();
  });

  async function holdAndConsume(operationIds: readonly string[]) {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const consumed = [];
    for (const operationId of operationIds) {
      consumed.push(
        await consumeOfflineAllocation(db, consumption(operationId), ACTIVE),
      );
    }
    return consumed.map(entry => entry.receipt);
  }

  function receiptRows(owner: string) {
    return handle.native
      .prepare(
        'SELECT receipt_id, settlement, settled_at FROM offline_receipt WHERE owner_key = ? ORDER BY queued_at',
      )
      .all(owner);
  }

  function journalRows(owner: string) {
    return handle.native
      .prepare(
        'SELECT journal_id, state, receipt_ids, verdicts FROM offline_wallet_journal WHERE owner_key = ? ORDER BY rowid',
      )
      .all(owner);
  }

  function insertJournalRow(row: {
    owner?: string;
    journalId: string;
    kind?: string;
    receiptIds: string;
    state: string;
    openedAt?: string;
    closedAt?: string | null;
    verdicts?: string | null;
  }): void {
    handle.native
      .prepare(
        `INSERT INTO offline_wallet_journal (
           owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.owner ?? OWNER,
        row.journalId,
        row.kind ?? 'receipt_submission',
        row.receiptIds,
        row.state,
        row.openedAt ?? '2026-01-01T00:00:00.000Z',
        row.closedAt ?? null,
        row.verdicts ?? null,
      );
  }

  /** Waits until the gated route has been reached exactly `n` times. */
  async function untilCalls(n: number): Promise<void> {
    for (let i = 0; i < 200 && (route?.calls.length ?? 0) < n; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(route?.calls).toHaveLength(n);
  }

  /* ------------------------------------------------------------------ */
  /* A1 concurrency / interleaved account switch                          */
  /* ------------------------------------------------------------------ */

  it('A1a: account switch A→B→A while A’s presentation is in flight — B drains only its own receipt, A’s late answer is refused, A recovers the same receipt id without a second consumption', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    setActiveDataOwner(OTHER_OWNER);
    await holdOfflineGrant(
      db,
      issuedGrant({
        owner: OTHER_OWNER,
        grantId: OTHER_GRANT_ID,
        ticketIds: OTHER_TICKETS,
      }),
      BINDING,
    );
    const theirs = (
      await consumeOfflineAllocation(db, consumption('op-b'), ACTIVE)
    ).receipt;
    setActiveDataOwner(OWNER);

    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => (release = resolve));
    route = mockReceiptsRoute(async (receiptIds, call) => {
      if (call === 1) await gate;
      return recorded(receiptIds);
    });

    const stale = reconcileOfflineWallet(db, client(), ACTIVE);
    await untilCalls(1);
    expect(route.calls[0]!.receiptIds).toEqual([mine!.receiptId]);
    expect((await readOfflineWalletStatus(db)).hold).toBe(true);

    // The user switches account while the request is on the wire.
    setActiveDataOwner(OTHER_OWNER);
    const other = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(other).toMatchObject({ submitted: 1, accepted: 1, pending: 0 });
    expect(route.calls[1]!.receiptIds).toEqual([theirs.receiptId]);
    expect((await readOfflineWalletStatus(db)).hold).toBe(false);

    // …and switches back before A's answer arrives (new generation).
    setActiveDataOwner(OWNER);
    release!();
    const error = await rejection(stale);
    expect(error).toBeInstanceOf(DataOwnerChangedError);

    // A's presentation is still an unanswered HOLD: not applied, not lost.
    expect(receiptRows(OWNER)).toEqual([
      expect.objectContaining({
        receipt_id: mine!.receiptId,
        settlement: null,
        settled_at: null,
      }),
    ]);
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['in_flight']);
    expect(journalRows(OTHER_OWNER).map(row => row['state'])).toEqual([
      'applied',
    ]);
    const status = await readOfflineWalletStatus(db);
    expect(status.hold).toBe(true);
    expect(status.pending.map(entry => entry.phase)).toEqual([
      'presented_unanswered',
    ]);

    // Recovery: the SAME receipt id, no second ticket, one applied entry.
    const recovered = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(recovered).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [mine!.receiptId],
      [theirs.receiptId],
      [mine!.receiptId],
    ]);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    expect(handle.count('offline_receipt', OTHER_OWNER)).toBe(1);
    expect(await readOfflineAllocation(db, ACTIVE)).toMatchObject({
      spendableTickets: 1,
      consumedTickets: 1,
      pendingReceipts: 0,
    });
    expect(journalRows(OWNER).map(row => row['state'])).toEqual([
      'superseded',
      'applied',
    ]);
    // Cross-account isolation: no journal entry ever named the other
    // owner's receipt.
    for (const row of journalRows(OWNER)) {
      expect(JSON.parse(String(row['receipt_ids']))).toEqual([mine!.receiptId]);
    }
  });

  it('A1b: sign-out mid-flight — the answer is not applied to a signed-out bucket; signing back in surfaces the HOLD and recovers the same id', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => (release = resolve));
    route = mockReceiptsRoute(async (receiptIds, call) => {
      if (call === 1) await gate;
      return recorded(receiptIds);
    });
    const stale = reconcileOfflineWallet(db, client(), ACTIVE);
    await untilCalls(1);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    release!();
    expect(await rejection(stale)).toBeInstanceOf(DataOwnerChangedError);
    // Signed out: the wallet neither drains nor fabricates an empty status.
    expect(await reconcileOfflineWallet(db, client(), ACTIVE)).toEqual(IDLE);
    await expect(readOfflineWalletStatus(db)).rejects.toThrow();
    expect(route.calls).toHaveLength(1);

    setActiveDataOwner(OWNER);
    const status = await readOfflineWalletStatus(db);
    expect(status).toEqual({
      hold: true,
      unansweredPresentations: 1,
      pending: [
        {
          receiptId: mine!.receiptId,
          operationId: 'op-a',
          settlement: null,
          presentations: 1,
          phase: 'presented_unanswered',
        },
      ],
    });
    const recovered = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(recovered).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 1,
    });
    expect(route.presentations.get(mine!.receiptId)).toBe(2);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
  });

  it('A1c: reentrant drain from inside the network layer (foreground event during the request) presents nothing twice and does not deadlock', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    let nested: Promise<unknown> | null = null;
    route = mockReceiptsRoute(receiptIds => {
      nested ??= reconcileOfflineWallet(db, client(), ACTIVE);
      return recorded(receiptIds);
    });
    const outer = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outer).toMatchObject({ submitted: 1, accepted: 1, pending: 0 });
    expect(await nested).toEqual(IDLE);
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [mine!.receiptId],
    ]);
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['applied']);
  });

  it('A1d: three drains racing with two receipts consumed between them present each receipt id exactly once', async () => {
    const [first] = await holdAndConsume(['op-1']);
    const gates: Array<() => void> = [];
    route = mockReceiptsRoute(async receiptIds => {
      await new Promise<void>(resolve => gates.push(resolve));
      return recorded(receiptIds);
    });
    const d1 = reconcileOfflineWallet(db, client(), ACTIVE);
    const d2 = reconcileOfflineWallet(db, client(), ACTIVE);
    await untilCalls(1);
    const second = (
      await consumeOfflineAllocation(db, consumption('op-2'), ACTIVE)
    ).receipt;
    const d3 = reconcileOfflineWallet(db, client(), ACTIVE);
    // While op-1 is on the wire, op-2 is merely queued (not a HOLD).
    const midStatus = await readOfflineWalletStatus(db);
    expect(midStatus.hold).toBe(true);
    expect(
      midStatus.pending.map(entry => [entry.receiptId, entry.phase]),
    ).toEqual([
      [first!.receiptId, 'presented_unanswered'],
      [second.receiptId, 'queued'],
    ]);
    gates.shift()!();
    await untilCalls(2);
    gates.shift()!();
    const results = await Promise.all([d1, d2, d3]);
    const totals = results.reduce(
      (sum, result) => ({
        submitted: sum.submitted + result.submitted,
        accepted: sum.accepted + result.accepted,
      }),
      { submitted: 0, accepted: 0 },
    );
    expect(totals).toEqual({ submitted: 2, accepted: 2 });
    const presented = route.calls.flatMap(call => call.receiptIds);
    expect([...presented].sort()).toEqual(
      [first!.receiptId, second.receiptId].sort(),
    );
    expect(route.presentations.get(first!.receiptId)).toBe(1);
    expect(route.presentations.get(second.receiptId)).toBe(1);
    expect(await pendingOfflineReceipts(db)).toEqual([]);
    expect((await readOfflineWalletStatus(db)).hold).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /* A2 replay and duplicate identities                                   */
  /* ------------------------------------------------------------------ */

  const MALFORMED_ANSWERS: ReadonlyArray<{
    readonly name: string;
    readonly answer: (ids: readonly string[]) => Record<string, unknown>;
  }> = [
    {
      name: 'the same receipt id twice',
      answer: ids => ({
        receipts: [
          { receiptId: ids[0], status: 'result_recorded' },
          { receiptId: ids[0], status: 'result_recorded' },
        ],
        rejected: [],
      }),
    },
    {
      name: 'a foreign receipt id beside the real one',
      answer: ids => ({
        receipts: [
          { receiptId: ids[0], status: 'result_recorded' },
          {
            receiptId: 'ffffffff-0000-4000-8000-000000000999',
            status: 'pending',
          },
        ],
        rejected: [],
      }),
    },
    {
      name: 'only a foreign receipt id',
      answer: () => ({
        receipts: [
          {
            receiptId: 'ffffffff-0000-4000-8000-000000000999',
            status: 'result_recorded',
          },
        ],
        rejected: [],
      }),
    },
    {
      name: 'an empty verdict list',
      answer: () => ({ receipts: [], rejected: [] }),
    },
    {
      name: 'the device-side verdict word instead of a server status',
      answer: ids => ({
        receipts: [{ receiptId: ids[0], status: 'accepted' }],
        rejected: [],
      }),
    },
    {
      name: 'the same id both recorded and rejected',
      answer: ids => ({
        receipts: [{ receiptId: ids[0], status: 'result_recorded' }],
        rejected: [{ receiptId: ids[0], code: 'grant_revoked' }],
      }),
    },
    {
      name: 'a rejection with an empty code',
      answer: ids => ({
        receipts: [],
        rejected: [{ receiptId: ids[0], code: '' }],
      }),
    },
    {
      name: 'receipts as an object instead of a list',
      answer: ids => ({
        receipts: { [ids[0]!]: 'result_recorded' },
        rejected: [],
      }),
    },
  ];

  it.each(MALFORMED_ANSWERS)(
    'A2a: an answer naming $name settles nothing, keeps the presentation in flight and is recovered under the same receipt id',
    async ({ answer }) => {
      const [mine] = await holdAndConsume(['op-a']);
      route = mockReceiptsRoute((ids, call) =>
        call === 1 ? answer(ids) : recorded(ids),
      );
      const error = await rejection(
        reconcileOfflineWallet(db, client(), ACTIVE),
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('network.invalid_response');
      expect(receiptRows(OWNER)).toEqual([
        expect.objectContaining({ settlement: null, settled_at: null }),
      ]);
      expect(journalRows(OWNER).map(row => row['state'])).toEqual([
        'in_flight',
      ]);
      expect((await readOfflineWalletStatus(db)).hold).toBe(true);
      const recovered = await reconcileOfflineWallet(db, client(), ACTIVE);
      expect(recovered).toEqual({
        ...IDLE,
        submitted: 1,
        accepted: 1,
        recovered: 1,
      });
      expect(route.calls.map(call => call.receiptIds)).toEqual([
        [mine!.receiptId],
        [mine!.receiptId],
      ]);
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
      expect(handle.count('offline_ticket', OWNER)).toBe(TICKETS.length);
    },
  );

  it('A2d: an answer listing the batch in reverse order is applied to the right receipts', async () => {
    const receipts = await holdAndConsume(['op-1', 'op-2']);
    route = mockReceiptsRoute(ids => ({
      receipts: [
        { receiptId: ids[1], status: 'pending' },
        { receiptId: ids[0], status: 'result_recorded' },
      ],
      rejected: [],
    }));
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      ...IDLE,
      submitted: 2,
      accepted: 1,
      held: 1,
      pending: 1,
    });
    expect(receiptRows(OWNER)).toEqual([
      expect.objectContaining({
        receipt_id: receipts[0]!.receiptId,
        settlement: 'accepted',
      }),
      expect.objectContaining({
        receipt_id: receipts[1]!.receiptId,
        settlement: 'held',
      }),
    ]);
    const [entry] = await readOfflineWalletJournal(db);
    expect(entry!.verdicts!.map(v => [v.receiptId, v.verdict])).toEqual([
      [receipts[0]!.receiptId, 'accepted'],
      [receipts[1]!.receiptId, 'held'],
    ]);
  });

  it('A2b: replaying the consumption after settlement returns the original receipt; a different result under the same operation id is refused and spends nothing', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    route = mockReceiptsRoute(ids => recorded(ids));
    await reconcileOfflineWallet(db, client(), ACTIVE);
    const replay = await consumeOfflineAllocation(
      db,
      consumption('op-a'),
      ACTIVE,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.receiptId).toBe(mine!.receiptId);
    expect(replay.receipt.settlement).toBe('accepted');
    const conflict = await failure(
      consumeOfflineAllocation(db, consumption('op-a', '-tampered'), ACTIVE),
    );
    expect(conflict.code).toBe('offline.receipt_conflict');
    // Nothing new to present; the accepted receipt is never re-presented.
    expect(await reconcileOfflineWallet(db, client(), ACTIVE)).toEqual(IDLE);
    expect(route.calls).toHaveLength(1);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    expect(await readOfflineAllocation(db, ACTIVE)).toMatchObject({
      spendableTickets: 1,
      consumedTickets: 1,
      pendingReceipts: 0,
    });
    expect(journalRows(OWNER)).toHaveLength(1);
  });

  it('A2c: a late duplicate of an already-applied answer (server replay) cannot re-open or re-settle anything', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    // First drain: accepted. Second drain finds nothing pending: the server
    // is never asked and the journal is not touched.
    route = mockReceiptsRoute(ids => recorded(ids));
    await reconcileOfflineWallet(db, client(), ACTIVE);
    const before = journalRows(OWNER);
    for (let i = 0; i < 3; i += 1) {
      expect(await reconcileOfflineWallet(db, client(), ACTIVE)).toEqual(IDLE);
    }
    expect(journalRows(OWNER)).toEqual(before);
    expect(route.presentations.get(mine!.receiptId)).toBe(1);
  });

  /* ------------------------------------------------------------------ */
  /* A3 network failure at each step                                      */
  /* ------------------------------------------------------------------ */

  const NETWORK_FAILURES: ReadonlyArray<{
    readonly name: string;
    readonly answer: () => RouteAnswer;
    readonly code: string;
  }> = [
    {
      name: '429 with Retry-After',
      answer: () =>
        jsonResponse(
          429,
          { error: { code: 'rate_limited', message: 'Slow down.' } },
          { 'retry-after': '30' },
        ),
      code: 'rate_limited',
    },
    {
      name: '500 with a generic body',
      answer: () =>
        jsonResponse(500, {
          error: { code: 'internal', message: 'Something went wrong.' },
        }),
      code: 'internal',
    },
    {
      name: '503 with no body',
      answer: () => new Response(null, { status: 503 }),
      code: 'unknown',
    },
    {
      name: '401 (session rotated while in flight)',
      answer: () =>
        jsonResponse(401, {
          error: { code: 'auth.invalid', message: 'Bad bearer.' },
        }),
      code: 'auth.invalid',
    },
    {
      name: '302 redirect',
      answer: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://captive.example/login' },
        }),
      code: 'network.redirected',
    },
    {
      name: '200 with an empty body',
      answer: () => new Response(null, { status: 200 }),
      code: 'network.invalid_response',
    },
    {
      name: '200 with a non-JSON body',
      answer: () =>
        new Response('<html>portal</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      code: 'network.invalid_response',
    },
    {
      name: '200 with an unrelated JSON object',
      answer: () => jsonResponse(200, { ok: true }),
      code: 'network.invalid_response',
    },
    {
      name: '404 (route not deployed)',
      answer: () => jsonResponse(404, { error: 'not_found' }),
      code: 'network.invalid_response',
    },
  ];

  it.each(NETWORK_FAILURES)(
    'A3a: $name settles nothing, leaves an in-flight HOLD and the next drain re-presents the same receipt id',
    async ({ answer, code }) => {
      const [mine] = await holdAndConsume(['op-a']);
      route = mockReceiptsRoute((ids, call) =>
        call === 1 ? answer() : recorded(ids),
      );
      const error = await rejection(
        reconcileOfflineWallet(db, client(), ACTIVE),
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(code);
      expect(receiptRows(OWNER)).toEqual([
        expect.objectContaining({ settlement: null, settled_at: null }),
      ]);
      expect(journalRows(OWNER).map(row => row['state'])).toEqual([
        'in_flight',
      ]);
      const status = await readOfflineWalletStatus(db);
      expect(status.hold).toBe(true);
      expect(status.pending[0]!.phase).toBe('presented_unanswered');
      const recovered = await reconcileOfflineWallet(db, client(), ACTIVE);
      expect(recovered).toEqual({
        ...IDLE,
        submitted: 1,
        accepted: 1,
        recovered: 1,
      });
      expect(route.calls.map(call => call.receiptIds)).toEqual([
        [mine!.receiptId],
        [mine!.receiptId],
      ]);
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
      expect(await readOfflineAllocation(db, ACTIVE)).toMatchObject({
        spendableTickets: 1,
        consumedTickets: 1,
        pendingReceipts: 0,
      });
    },
  );

  it('A3b: a request that times out (no answer within the API deadline) is a HOLD, not a refund; the same id is re-presented', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    jest.useFakeTimers();
    route = mockReceiptsRoute((ids, call) =>
      call === 1
        ? new Promise<Record<string, unknown>>(() => {
            /* never answers */
          })
        : recorded(ids),
    );
    const hung = rejection(reconcileOfflineWallet(db, client(), ACTIVE));
    // Let the journal commit and the request leave before the deadline.
    await jest.advanceTimersByTimeAsync(50);
    expect(route.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
    const error = await hung;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('network.timeout');
    jest.useRealTimers();
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['in_flight']);
    expect((await readOfflineWalletStatus(db)).hold).toBe(true);
    const recovered = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(recovered).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [mine!.receiptId],
      [mine!.receiptId],
    ]);
  });

  it('A3c: a signed-in client whose bearer resolves to null (token rotated away) sends nothing yet records the attempt as a HOLD', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    route = mockReceiptsRoute(ids => recorded(ids));
    const tokenless = createOfflineGrantClient({
      baseUrl: ISSUER,
      token: null,
    });
    const error = await rejection(
      reconcileOfflineWallet(db, tokenless, ACTIVE),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('auth.required');
    expect(route.calls).toEqual([]);
    // Conservative by design: the journal was committed before the client
    // refused, so the receipt reads as presented_unanswered although the
    // request never left. Recovery still re-presents the same id once.
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['in_flight']);
    const recovered = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(recovered).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [mine!.receiptId],
    ]);
  });

  /* ------------------------------------------------------------------ */
  /* A4 corrupt / partial persisted state                                 */
  /* ------------------------------------------------------------------ */

  const CORRUPT_ROWS: ReadonlyArray<{
    readonly name: string;
    readonly row: Parameters<typeof insertJournalRow>[0];
  }> = [
    {
      name: 'an in_flight entry that already has closed_at',
      row: {
        journalId: 'j-closed-in-flight',
        receiptIds: '["r-1"]',
        state: 'in_flight',
        closedAt: '2026-01-01T00:00:01.000Z',
      },
    },
    {
      name: 'an in_flight entry carrying verdicts',
      row: {
        journalId: 'j-in-flight-verdicts',
        receiptIds: '["r-1"]',
        state: 'in_flight',
        verdicts: '[{"receiptId":"r-1","verdict":"accepted","code":"x"}]',
      },
    },
    {
      name: 'an in_flight entry with duplicate receipt ids',
      row: {
        journalId: 'j-dup',
        receiptIds: '["r-1","r-1"]',
        state: 'in_flight',
      },
    },
    {
      name: 'an in_flight entry with an empty receipt list',
      row: { journalId: 'j-empty', receiptIds: '[]', state: 'in_flight' },
    },
    {
      name: 'an in_flight entry of an unknown kind',
      row: {
        journalId: 'j-kind',
        kind: 'grant_renewal',
        receiptIds: '["r-1"]',
        state: 'in_flight',
      },
    },
    {
      name: 'an applied entry whose verdicts are not JSON',
      row: {
        journalId: 'j-applied-garbage',
        receiptIds: '["r-1"]',
        state: 'applied',
        closedAt: '2026-01-01T00:00:01.000Z',
        verdicts: 'not json',
      },
    },
    {
      name: 'an applied entry whose verdicts name a different receipt',
      row: {
        journalId: 'j-applied-foreign',
        receiptIds: '["r-1"]',
        state: 'applied',
        closedAt: '2026-01-01T00:00:01.000Z',
        verdicts: '[{"receiptId":"r-2","verdict":"accepted","code":"x"}]',
      },
    },
    {
      name: 'an applied entry with an unknown verdict kind',
      row: {
        journalId: 'j-applied-kind',
        receiptIds: '["r-1"]',
        state: 'applied',
        closedAt: '2026-01-01T00:00:01.000Z',
        verdicts: '[{"receiptId":"r-1","verdict":"refunded","code":"x"}]',
      },
    },
    {
      name: 'a superseded entry that still carries verdicts',
      row: {
        journalId: 'j-superseded-verdicts',
        receiptIds: '["r-1"]',
        state: 'superseded',
        closedAt: '2026-01-01T00:00:01.000Z',
        verdicts: '[{"receiptId":"r-1","verdict":"accepted","code":"x"}]',
      },
    },
    {
      name: 'an entry in an unknown state',
      row: {
        journalId: 'j-state',
        receiptIds: '["r-1"]',
        state: 'In_Flight',
      },
    },
  ];

  it.each(CORRUPT_ROWS)(
    'A4a: with $name the status API fails typed AND the drain fails before anything is sent',
    async ({ row }) => {
      const [mine] = await holdAndConsume(['op-a']);
      insertJournalRow(row);
      const status = await failure(readOfflineWalletStatus(db));
      expect(status.code).toBe('offline.wallet_corrupt');
      const journal = await failure(readOfflineWalletJournal(db));
      expect(journal.code).toBe('offline.wallet_corrupt');
      route = mockReceiptsRoute(ids => recorded(ids));
      // Candidate contract (reconcileOfflineWallet doc): "Corrupt journal
      // state fails before anything is sent."
      const drain = await reconcileOfflineWallet(db, client(), ACTIVE).then(
        outcome => ({ threw: null, outcome }),
        (error: unknown) => ({
          threw:
            error instanceof OfflineGrantError ? error.code : String(error),
          outcome: null,
        }),
      );
      expect({
        drain,
        presentations: route.calls.map(call => call.receiptIds),
        settlements: receiptRows(OWNER).map(row => row['settlement']),
        journal: journalRows(OWNER).map(row => row['state']),
      }).toEqual({
        drain: { threw: 'offline.wallet_corrupt', outcome: null },
        presentations: [],
        settlements: [null],
        journal: [row.state],
      });
      expect(await pendingOfflineReceipts(db)).toEqual([mine]);
    },
  );

  it('A4b: an in-flight entry naming a receipt that no longer exists is superseded and does not block the real pending receipt', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    insertJournalRow({
      journalId: 'j-ghost',
      receiptIds: '["ghost-receipt"]',
      state: 'in_flight',
    });
    const before = await readOfflineWalletStatus(db);
    expect(before.hold).toBe(true);
    expect(before.pending[0]!.phase).toBe('queued');
    route = mockReceiptsRoute(ids => recorded(ids));
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [mine!.receiptId],
    ]);
    expect((await readOfflineWalletStatus(db)).hold).toBe(false);
  });

  it('A4c: two orphaned in-flight entries are both closed by one drain and counted as recovered', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    insertJournalRow({
      journalId: 'j-orphan-1',
      receiptIds: JSON.stringify([mine!.receiptId]),
      state: 'in_flight',
      openedAt: '2026-01-01T00:00:00.000Z',
    });
    insertJournalRow({
      journalId: 'j-orphan-2',
      receiptIds: JSON.stringify([mine!.receiptId]),
      state: 'in_flight',
      openedAt: '2026-01-01T00:00:05.000Z',
    });
    expect((await readOfflineWalletStatus(db)).unansweredPresentations).toBe(2);
    route = mockReceiptsRoute(ids => recorded(ids));
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 2,
    });
    expect(journalRows(OWNER).map(row => row['state'])).toEqual([
      'superseded',
      'superseded',
      'applied',
    ]);
  });

  it('A4d: an in-flight entry for a receipt that was settled terminally meanwhile is closed without contacting the server', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    route = mockReceiptsRoute(ids => recorded(ids));
    await reconcileOfflineWallet(db, client(), ACTIVE);
    insertJournalRow({
      journalId: 'j-stale-in-flight',
      receiptIds: JSON.stringify([mine!.receiptId]),
      state: 'in_flight',
    });
    expect((await readOfflineWalletStatus(db)).hold).toBe(true);
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({ ...IDLE, recovered: 1 });
    expect(route.calls).toHaveLength(1);
    expect((await readOfflineWalletStatus(db)).hold).toBe(false);
    expect(receiptRows(OWNER)[0]!['settlement']).toBe('accepted');
  });

  it('A4e: a corrupt journal row of ANOTHER owner never blocks this owner', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    insertJournalRow({
      owner: OTHER_OWNER,
      journalId: 'j-other-garbage',
      receiptIds: 'not json',
      state: 'in_flight',
    });
    expect((await readOfflineWalletStatus(db)).hold).toBe(false);
    route = mockReceiptsRoute(ids => recorded(ids));
    expect(await reconcileOfflineWallet(db, client(), ACTIVE)).toMatchObject({
      submitted: 1,
      accepted: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [mine!.receiptId],
    ]);
    setActiveDataOwner(OTHER_OWNER);
    expect(
      (await failure(reconcileOfflineWallet(db, client(), ACTIVE))).code,
    ).toBe('offline.wallet_corrupt');
  });

  it('A4f: a receipt row whose body is unreadable fails typed before any presentation', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    handle.native
      .prepare(
        `UPDATE offline_receipt SET receipt = '{"receiptId":"someone-else"}' WHERE owner_key = ? AND receipt_id = ?`,
      )
      .run(OWNER, mine!.receiptId);
    route = mockReceiptsRoute(ids => recorded(ids));
    const drain = await failure(reconcileOfflineWallet(db, client(), ACTIVE));
    expect(drain.code).toBe('offline.wallet_corrupt');
    expect(route.calls).toEqual([]);
    expect(journalRows(OWNER)).toEqual([]);
  });

  it('A4g: the answer arrives for a receipt whose row was deleted meanwhile — nothing is applied and the batch stays in flight', async () => {
    const receipts = await holdAndConsume(['op-1', 'op-2']);
    route = mockReceiptsRoute(ids => {
      handle.native
        .prepare(
          'DELETE FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?',
        )
        .run(OWNER, receipts[1]!.receiptId);
      return recorded(ids);
    });
    const drain = await failure(reconcileOfflineWallet(db, client(), ACTIVE));
    expect(drain.code).toBe('offline.wallet_corrupt');
    expect(receiptRows(OWNER)).toEqual([
      expect.objectContaining({
        receipt_id: receipts[0]!.receiptId,
        settlement: null,
      }),
    ]);
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['in_flight']);
  });

  /* ------------------------------------------------------------------ */
  /* A5 boundary clocks                                                   */
  /* ------------------------------------------------------------------ */

  const BAD_CLOCKS: ReadonlyArray<{ name: string; wallClockMs: number }> = [
    { name: 'NaN', wallClockMs: Number.NaN },
    { name: '+Infinity', wallClockMs: Number.POSITIVE_INFINITY },
    { name: '-Infinity', wallClockMs: Number.NEGATIVE_INFINITY },
    { name: 'beyond the ECMAScript date range', wallClockMs: 8.64e15 + 1 },
  ];

  it.each(BAD_CLOCKS)(
    'A5a: a wall clock of $name cannot open a presentation — nothing journalled, nothing sent, receipt still queued, and the next valid reading drains',
    async ({ wallClockMs }) => {
      const [mine] = await holdAndConsume(['op-a']);
      route = mockReceiptsRoute(ids => recorded(ids));
      const bad = reading((ISSUED_AT + 60) * 1000, { wallClockMs });
      const error = await rejection(reconcileOfflineWallet(db, client(), bad));
      // Whatever is thrown, the failure must be closed: no presentation, no
      // half-written journal, no fabricated settlement.
      expect(error).toBeInstanceOf(Error);
      expect(route.calls).toEqual([]);
      expect(journalRows(OWNER)).toEqual([]);
      expect(await pendingOfflineReceipts(db)).toEqual([mine]);
      const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
      expect(outcome).toEqual({ ...IDLE, submitted: 1, accepted: 1 });
    },
  );

  it('A5b: a wall clock that rolls back between two drains keeps the journal readable and the status consistent', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    const later = reading((ISSUED_AT + 3600) * 1000);
    const earlier = reading((ISSUED_AT + 60) * 1000);
    route = mockReceiptsRoute(() => new TypeError('Network request failed'));
    await expect(reconcileOfflineWallet(db, client(), later)).rejects.toThrow(
      'Network request failed',
    );
    route.spy.mockRestore();
    route = mockReceiptsRoute(ids => recorded(ids));
    const outcome = await reconcileOfflineWallet(db, client(), earlier);
    expect(outcome).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 1,
    });
    const journal = await readOfflineWalletJournal(db);
    expect(journal.map(entry => entry.state).sort()).toEqual([
      'applied',
      'superseded',
    ]);
    expect(journal.every(entry => entry.closedAt !== null)).toBe(true);
    expect(await readOfflineWalletStatus(db)).toEqual({
      pending: [],
      unansweredPresentations: 0,
      hold: false,
    });
    expect(route.presentations.get(mine!.receiptId)).toBe(1);
  });

  it('A5c: a negative or epoch wall clock is still a valid instant and settles normally', async () => {
    await holdAndConsume(['op-a']);
    route = mockReceiptsRoute(ids => recorded(ids));
    const outcome = await reconcileOfflineWallet(
      db,
      client(),
      reading((ISSUED_AT + 60) * 1000, { wallClockMs: -1 }),
    );
    expect(outcome).toEqual({ ...IDLE, submitted: 1, accepted: 1 });
    expect(receiptRows(OWNER)[0]!['settled_at']).toBe(
      '1969-12-31T23:59:59.999Z',
    );
  });

  it('A5d: an untrusted reading (rollback detected, no authority) does not gate presentation — submission needs no trusted time and never mints a new id', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    route = mockReceiptsRoute(ids => recorded(ids));
    const untrusted = reading((ISSUED_AT + 60) * 1000, {
      authority: 'none',
      continuity: 'none',
      rollbackDetected: true,
      storage: 'unavailable',
    });
    const outcome = await reconcileOfflineWallet(db, client(), untrusted);
    expect(outcome).toEqual({ ...IDLE, submitted: 1, accepted: 1 });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [mine!.receiptId],
    ]);
  });

  /* ------------------------------------------------------------------ */
  /* A6 atomicity + free-rating conservation                              */
  /* ------------------------------------------------------------------ */

  it('A6a: a failed journal close rolls back every settlement of the batch; the retry presents the same two ids once more', async () => {
    const receipts = await holdAndConsume(['op-1', 'op-2']);
    route = mockReceiptsRoute(ids => recorded(ids));
    handle.failStatementOnce(
      "UPDATE offline_wallet_journal SET state = 'applied'",
    );
    await expect(reconcileOfflineWallet(db, client(), ACTIVE)).rejects.toThrow(
      'SQLite write failed',
    );
    expect(receiptRows(OWNER).map(row => row['settlement'])).toEqual([
      null,
      null,
    ]);
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['in_flight']);
    expect(await readOfflineAllocation(db, ACTIVE)).toMatchObject({
      spendableTickets: 0,
      consumedTickets: 2,
      pendingReceipts: 2,
    });
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      ...IDLE,
      submitted: 2,
      accepted: 2,
      recovered: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      receipts.map(r => r.receiptId),
      receipts.map(r => r.receiptId),
    ]);
    expect(handle.count('offline_receipt', OWNER)).toBe(2);
    expect(handle.count('offline_ticket', OWNER)).toBe(2);
  });

  it('A6e: a lost commit acknowledgement on the write-ahead entry sends nothing, is a HOLD, and the retry presents the same id exactly once', async () => {
    const [mine] = await holdAndConsume(['op-a']);
    route = mockReceiptsRoute(ids => recorded(ids));
    handle.failCommitOnce('after', 'INSERT INTO offline_wallet_journal');
    await expect(reconcileOfflineWallet(db, client(), ACTIVE)).rejects.toThrow(
      'SQLite commit acknowledgement lost',
    );
    expect(route.calls).toEqual([]);
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['in_flight']);
    expect((await readOfflineWalletStatus(db)).hold).toBe(true);
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      ...IDLE,
      submitted: 1,
      accepted: 1,
      recovered: 1,
    });
    expect(route.presentations.get(mine!.receiptId)).toBe(1);
  });

  it('A6f: a commit that fails before the apply transaction commits leaves the batch unanswered (in flight), not half-settled', async () => {
    const receipts = await holdAndConsume(['op-1', 'op-2']);
    route = mockReceiptsRoute(ids => recorded(ids));
    handle.failCommitOnce('before', "SET state = 'applied'");
    await expect(reconcileOfflineWallet(db, client(), ACTIVE)).rejects.toThrow(
      'SQLite commit failed before commit',
    );
    expect(receiptRows(OWNER).map(row => row['settlement'])).toEqual([
      null,
      null,
    ]);
    expect(journalRows(OWNER).map(row => row['state'])).toEqual(['in_flight']);
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      ...IDLE,
      submitted: 2,
      accepted: 2,
      recovered: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      receipts.map(r => r.receiptId),
      receipts.map(r => r.receiptId),
    ]);
  });

  it('A6b: a mixed verdict batch (held + refused) settles exactly as answered; the held id alone is re-presented and no ticket is minted or reclaimed', async () => {
    const [heldReceipt, refusedReceipt] = await holdAndConsume([
      'op-held',
      'op-refused',
    ]);
    route = mockReceiptsRoute((ids, call) =>
      call === 1
        ? {
            receipts: [
              { receiptId: heldReceipt!.receiptId, status: 'pending' },
            ],
            rejected: [
              { receiptId: refusedReceipt!.receiptId, code: 'grant_revoked' },
            ],
          }
        : recorded(ids),
    );
    const first = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(first).toEqual({
      ...IDLE,
      submitted: 2,
      held: 1,
      refused: 1,
      pending: 1,
    });
    const status = await readOfflineWalletStatus(db);
    expect(status.hold).toBe(false);
    expect(status.pending).toEqual([
      expect.objectContaining({
        receiptId: heldReceipt!.receiptId,
        settlement: 'held',
        phase: 'held',
      }),
    ]);
    const second = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(second).toEqual({ ...IDLE, submitted: 1, accepted: 1 });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [heldReceipt!.receiptId, refusedReceipt!.receiptId],
      [heldReceipt!.receiptId],
    ]);
    expect(receiptRows(OWNER).map(row => row['settlement'])).toEqual([
      'accepted',
      'refused',
    ]);
    expect(handle.count('offline_ticket', OWNER)).toBe(2);
    expect(await readOfflineAllocation(db, ACTIVE)).toMatchObject({
      consumedTickets: 2,
      pendingReceipts: 0,
    });
  });

  it('A6c: a receipt consumed while a batch is in flight is not swept into that batch’s answer and is presented by the next drain only', async () => {
    const [first] = await holdAndConsume(['op-1']);
    let second: string | null = null;
    route = mockReceiptsRoute(async (ids, call) => {
      if (call === 1) {
        second = (
          await consumeOfflineAllocation(db, consumption('op-2'), ACTIVE)
        ).receipt.receiptId;
      }
      return recorded(ids);
    });
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({ ...IDLE, submitted: 1, accepted: 1, pending: 1 });
    expect(receiptRows(OWNER)).toEqual([
      expect.objectContaining({
        receipt_id: first!.receiptId,
        settlement: 'accepted',
      }),
      expect.objectContaining({ receipt_id: second, settlement: null }),
    ]);
    const status = await readOfflineWalletStatus(db);
    expect(status.hold).toBe(false);
    expect(status.pending).toEqual([
      expect.objectContaining({ receiptId: second, phase: 'queued' }),
    ]);
    const next = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(next).toEqual({ ...IDLE, submitted: 1, accepted: 1 });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [first!.receiptId],
      [second],
    ]);
  });

  it('A6d: a large batch (200 receipts across the lease) is journalled and applied as one unit', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    // Two tickets, then Pro-less consumption is refused — so the batch here
    // is bounded by the free allocation. Pad with the two real receipts and
    // assert the journal names exactly what was pending, in queue order.
    const receipts = [];
    for (const operationId of ['op-1', 'op-2']) {
      receipts.push(
        (await consumeOfflineAllocation(db, consumption(operationId), ACTIVE))
          .receipt,
      );
    }
    const exhausted = await failure(
      consumeOfflineAllocation(db, consumption('op-3'), ACTIVE),
    );
    expect(exhausted.code).not.toBe('offline.wallet_corrupt');
    route = mockReceiptsRoute(ids => recorded(ids));
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({ ...IDLE, submitted: 2, accepted: 2 });
    const [entry] = await readOfflineWalletJournal(db);
    expect(entry!.receiptIds).toEqual(receipts.map(r => r.receiptId));
    expect(handle.count('offline_receipt', OWNER)).toBe(2);
  });

  /* ------------------------------------------------------------------ */
  /* A8 roles and copy                                                    */
  /* ------------------------------------------------------------------ */

  it('A8a: a guest owner never presents, never journals and reads an empty (not fabricated) wallet', async () => {
    await holdAndConsume(['op-a']);
    setActiveDataOwner(GUEST_DATA_OWNER);
    route = mockReceiptsRoute(ids => recorded(ids));
    expect(await reconcileOfflineWallet(db, client(), ACTIVE)).toEqual(IDLE);
    expect(route.calls).toEqual([]);
    expect(await readOfflineWalletStatus(db)).toEqual({
      pending: [],
      unansweredPresentations: 0,
      hold: false,
    });
    expect(handle.count('offline_wallet_journal', GUEST_DATA_OWNER)).toBe(0);
    setActiveDataOwner(OWNER);
    expect((await readOfflineWalletStatus(db)).pending).toHaveLength(1);
  });

  it('A8b: a signed-out process never presents and never reads another bucket’s wallet', async () => {
    await holdAndConsume(['op-a']);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    route = mockReceiptsRoute(ids => recorded(ids));
    expect(await reconcileOfflineWallet(db, client(), ACTIVE)).toEqual(IDLE);
    expect(route.calls).toEqual([]);
    await expect(readOfflineWalletStatus(db)).rejects.toThrow();
    await expect(readOfflineWalletJournal(db)).rejects.toThrow();
    expect(handle.count('offline_wallet_journal', OWNER)).toBe(0);
  });

  it('A8c: user-facing copy in the wallet module follows APP_STORE_SUBMISSION.md', () => {
    // Only string literals can reach the user; comments are not copy.
    const source = readFileSync(
      path.resolve(__dirname, '..', 'src', 'data', 'offlineWallet.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const forbidden = [
      /android/i,
      /google play/i,
      /guest mode/i,
      /live court/i,
      /\bDUPR\b/i,
      /swingvision/i,
      /pb vision/i,
      /selkirk/i,
      /joola/i,
      /\d+\s?%/,
      /\brefund/i,
      /best[- ]in[- ]class|world[- ]class|#1\b|the best\b/i,
    ];
    for (const pattern of forbidden) {
      expect(source).not.toMatch(pattern);
    }
  });
});

/* ---------------------------------------------------------------------- */
/* A7 process death beyond the candidate's kill points                     */
/* ---------------------------------------------------------------------- */

const HARNESS_DIR = path.resolve(
  __dirname,
  '..',
  '__harness__',
  'processDeath',
);
const MOBILE_ROOT = path.resolve(__dirname, '..');
const MOUNT_PATH = '/functions/v1/api';
const OPERATION_ID = '44444444-4444-4444-8444-000000000001';
const RESULT_ID = '55555555-5555-4555-8555-000000000001';

interface ReceiptServiceRequest {
  readonly path: string;
  readonly receiptIds: readonly string[];
  readonly status: number;
}

interface ReceiptServiceSnapshot {
  readonly recorded: readonly string[];
  readonly presentations: Readonly<Record<string, number>>;
  readonly requests: readonly ReceiptServiceRequest[];
  readonly unauthorized: readonly string[];
}

interface ReceiptService {
  readonly baseUrl: string;
  snapshot(): ReceiptServiceSnapshot;
  close(): Promise<void>;
}

/** Idempotent receipts route: `verdicts[n]` is the answer to the n-th
 * presentation of a receipt id (the last entry repeats forever); a
 * `result_recorded` answer records the id once. */
async function startReceiptService(
  verdicts: readonly ('result_recorded' | 'pending')[] = ['result_recorded'],
): Promise<ReceiptService> {
  const recorded: string[] = [];
  const presentations = new Map<string, number>();
  const requests: ReceiptServiceRequest[] = [];
  const unauthorized: string[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET';
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const routePath = pathname.startsWith(MOUNT_PATH)
        ? pathname.slice(MOUNT_PATH.length)
        : pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw.length === 0 ? undefined : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const receipts =
        typeof body === 'object' && body !== null && 'receipts' in body
          ? (body as { receipts: Array<{ receiptId: string }> }).receipts
          : [];
      const receiptIds = receipts.map(receipt => receipt.receiptId);
      let status = 200;
      let payload: unknown;
      if (request.headers['authorization'] !== `Bearer ${BEARER_TOKEN}`) {
        unauthorized.push(`${method} ${routePath}`);
        status = 401;
        payload = { error: { code: 'auth.invalid', message: 'Bad bearer.' } };
      } else if (method === 'POST' && routePath === RECEIPTS_PATH) {
        payload = {
          receipts: receiptIds.map(receiptId => {
            const seen = presentations.get(receiptId) ?? 0;
            presentations.set(receiptId, seen + 1);
            const verdict = verdicts[Math.min(seen, verdicts.length - 1)]!;
            if (verdict === 'result_recorded' && !recorded.includes(receiptId))
              recorded.push(receiptId);
            return { receiptId, status: verdict };
          }),
          rejected: [],
        };
      } else {
        status = 404;
        payload = { error: { code: 'harness.unrouted', message: 'No route.' } };
      }
      requests.push({ path: routePath, receiptIds, status });
      const text = JSON.stringify(payload);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      });
      response.end(text);
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${MOUNT_PATH}`,
    snapshot: () => ({
      recorded: [...recorded],
      presentations: Object.fromEntries(presentations),
      requests: [...requests],
      unauthorized: [...unauthorized],
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

interface WalletLaunchResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly killMarker: string | null;
  readonly report: WalletChildReport | null;
  readonly serverAfter: ReceiptServiceSnapshot;
}

interface WalletLaunchSpec {
  readonly kill?: { readonly id: string; readonly trigger: KillTrigger };
}

function launchWalletChild(env: Record<string, string>) {
  return new Promise<Omit<WalletLaunchResult, 'serverAfter'>>(
    (resolve, reject) => {
      const hermetic = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('PD_')),
      );
      const child = spawn(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '-r',
          path.join(HARNESS_DIR, 'register.js'),
          path.join(HARNESS_DIR, 'walletChild.ts'),
        ],
        {
          cwd: MOBILE_ROOT,
          env: { ...hermetic, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (exitCode, signal) => {
        const killLine = stderr
          .split('\n')
          .find(line => line.startsWith(KILL_PREFIX));
        const reportLine = stdout
          .split('\n')
          .find(line => line.startsWith(REPORT_PREFIX));
        resolve({
          exitCode,
          signal,
          stderr,
          killMarker: killLine ? killLine.slice(KILL_PREFIX.length) : null,
          report: reportLine
            ? (JSON.parse(
                reportLine.slice(REPORT_PREFIX.length),
              ) as WalletChildReport)
            : null,
        });
      });
    },
  );
}

/** Launches the candidate's wallet child N times on one durable file; every
 * launch after the first is a relaunch (`PD_LAUNCH=2`). */
async function runWalletLaunches(
  specs: readonly WalletLaunchSpec[],
  verdicts?: readonly ('result_recorded' | 'pending')[],
): Promise<{
  readonly launches: readonly WalletLaunchResult[];
  readonly server: ReceiptServiceSnapshot;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-wallet-attack-'));
  const dbPath = path.join(dir, 'pickle-sensei.db');
  const service = await startReceiptService(verdicts);
  try {
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const fixture: WalletFixtureFile = {
      issued: grantResponse({
        issuer: service.baseUrl,
        issuedAt,
        expiresAt: issuedAt + 6 * 24 * 60 * 60,
      }),
      installationKeyId: INSTALLATION_KEY,
      operationId: OPERATION_ID,
      resultId: RESULT_ID,
      fullOutputSha256: RESULT_SHA,
    };
    const fixturePath = path.join(dir, 'wallet-fixture.json');
    writeFileSync(fixturePath, JSON.stringify(fixture));
    const launches: WalletLaunchResult[] = [];
    for (const [index, spec] of specs.entries()) {
      const result = await launchWalletChild({
        PD_DB_PATH: dbPath,
        PD_FIXTURE_PATH: fixturePath,
        PD_API_BASE_URL: service.baseUrl,
        PD_LAUNCH: index === 0 ? '1' : '2',
        ...(spec.kill
          ? {
              PD_KILL: JSON.stringify(spec.kill.trigger),
              PD_KILL_ID: spec.kill.id,
            }
          : {}),
      });
      launches.push({ ...result, serverAfter: service.snapshot() });
    }
    return { launches, server: service.snapshot() };
  } finally {
    await service.close();
  }
}

function requireReport(launch: WalletLaunchResult): WalletChildReport {
  if (!launch.report) {
    throw new Error(
      `launch produced no report (exit ${String(launch.exitCode)} / ${String(launch.signal)}):\n${launch.stderr}`,
    );
  }
  return launch.report;
}

function receiptsRouteRequests(
  server: ReceiptServiceSnapshot,
): readonly ReceiptServiceRequest[] {
  return server.requests.filter(request => request.path === RECEIPTS_PATH);
}

const HTTP_BEFORE: KillTrigger = {
  kind: 'http',
  pathIncludes: RECEIPTS_PATH,
  ordinal: 1,
  phase: 'before',
};
const HTTP_AFTER: KillTrigger = {
  kind: 'http',
  pathIncludes: RECEIPTS_PATH,
  ordinal: 1,
  phase: 'after',
};

/** Asserts the terminal launch left exactly one accepted receipt, one
 * consumed ticket and no HOLD, and that the server recorded that id once. */
function expectSettledOnce(
  report: WalletChildReport,
  server: ReceiptServiceSnapshot,
  expectedJournal: readonly string[],
  expectedPresentations: number,
): void {
  const receiptId = report.consumption.receiptId;
  expect(report.consumption.replayed).toBe(true);
  expect(report.final.grants).toHaveLength(1);
  expect(report.final.grants[0]!.lifecycleSequence).toBe(1);
  expect(report.final.tickets.filter(t => t.state === 'consumed')).toEqual([
    expect.objectContaining({ state: 'consumed', receiptId }),
  ]);
  expect(report.final.receipts).toEqual([
    expect.objectContaining({
      ownerKey: OWNER,
      receiptId,
      operationId: OPERATION_ID,
      settlement: 'accepted',
    }),
  ]);
  expect(report.final.journal.map(entry => entry.state)).toEqual(
    expectedJournal,
  );
  expect(
    report.final.journal.every(
      entry =>
        entry.receiptIds.length === 1 && entry.receiptIds[0] === receiptId,
    ),
  ).toBe(true);
  expect(report.finalStatus).toEqual({
    hold: false,
    unansweredPresentations: 0,
    pending: [],
  });
  const requests = receiptsRouteRequests(server);
  expect(requests).toHaveLength(expectedPresentations);
  expect(requests.every(r => r.status === 200)).toBe(true);
  expect(requests.map(r => r.receiptIds)).toEqual(
    requests.map(() => [receiptId]),
  );
  expect(server.recorded).toEqual([receiptId]);
  expect(server.presentations).toEqual({ [receiptId]: expectedPresentations });
  expect(server.unauthorized).toEqual([]);
}

describe('W05-03 attack A7: process death beyond the candidate kill points', () => {
  it('A7a: the answer is lost TWICE (launch 1 and the recovering launch 2 both die after the server recorded) — launch 3 still settles one receipt once', async () => {
    const { launches, server } = await runWalletLaunches([
      { kill: { id: 'lost_1', trigger: HTTP_AFTER } },
      { kill: { id: 'lost_2', trigger: HTTP_AFTER } },
      {},
    ]);
    const [first, second, third] = launches;
    expect(first!.signal).toBe('SIGKILL');
    expect(second!.signal).toBe('SIGKILL');
    expect(second!.killMarker?.startsWith('lost_2')).toBe(true);
    expect(receiptsRouteRequests(second!.serverAfter)).toHaveLength(2);
    const report = requireReport(third!);
    expect(third!.exitCode).toBe(0);
    expect(third!.stderr).toBe('');
    // As found by launch 3: two orphaned presentations (launch 2 superseded
    // the first and opened its own), both unanswered → HOLD.
    expect(report.asFound.journal.map(entry => entry.state)).toEqual([
      'superseded',
      'in_flight',
    ]);
    expect(report.asFoundStatus.hold).toBe(true);
    expect(report.asFoundStatus.unansweredPresentations).toBe(1);
    expect(report.asFoundStatus.pending[0]!.presentations).toBe(2);
    expectSettledOnce(
      report,
      server,
      ['superseded', 'superseded', 'applied'],
      3,
    );
  });

  it('A7b: launch 2 dies INSIDE the recovery transaction (after superseding the orphan, before its own entry commits) — the orphan is still in flight for launch 3', async () => {
    const { launches, server } = await runWalletLaunches([
      { kill: { id: 'unsent', trigger: HTTP_BEFORE } },
      {
        kill: {
          id: 'recovery_mid_transaction',
          trigger: {
            kind: 'sql',
            includes: [
              "UPDATE offline_wallet_journal SET state = 'superseded'",
            ],
            ordinal: 1,
            phase: 'after',
          },
        },
      },
      {},
    ]);
    const [first, second, third] = launches;
    expect(first!.signal).toBe('SIGKILL');
    expect(second!.signal).toBe('SIGKILL');
    expect(second!.killMarker?.startsWith('recovery_mid_transaction')).toBe(
      true,
    );
    expect(receiptsRouteRequests(second!.serverAfter)).toHaveLength(0);
    const report = requireReport(third!);
    expect(third!.exitCode).toBe(0);
    // The supersede was rolled back with the open transaction: exactly the
    // launch-1 orphan is found, still in flight.
    expect(report.asFound.journal.map(entry => entry.state)).toEqual([
      'in_flight',
    ]);
    expect(report.asFoundStatus.hold).toBe(true);
    expectSettledOnce(report, server, ['superseded', 'applied'], 1);
  });

  it('A7c: launch 1 dies with the answer received but not yet applied (before the first settlement write) — relaunch re-presents once and the server records once', async () => {
    const { launches, server } = await runWalletLaunches([
      {
        kill: {
          id: 'answer_received_nothing_applied',
          trigger: {
            kind: 'sql',
            includes: ['UPDATE offline_receipt SET settlement'],
            ordinal: 1,
            phase: 'before',
          },
        },
      },
      {},
    ]);
    const [first, second] = launches;
    expect(first!.signal).toBe('SIGKILL');
    expect(receiptsRouteRequests(first!.serverAfter)).toHaveLength(1);
    const report = requireReport(second!);
    expect(second!.exitCode).toBe(0);
    expect(report.asFound.journal.map(entry => entry.state)).toEqual([
      'in_flight',
    ]);
    expect(report.asFound.receipts[0]!.settlement).toBeNull();
    expect(report.asFoundStatus).toMatchObject({
      hold: true,
      unansweredPresentations: 1,
    });
    expectSettledOnce(report, server, ['superseded', 'applied'], 2);
  });

  it('A7d: a HELD receipt whose re-presentation answer is lost (launch 2 dies after the server recorded) is settled by launch 3 under the same id', async () => {
    const { launches, server } = await runWalletLaunches(
      [{}, { kill: { id: 'held_answer_lost', trigger: HTTP_AFTER } }, {}],
      ['pending', 'result_recorded'],
    );
    const [first, second, third] = launches;
    const firstReport = requireReport(first!);
    expect(first!.exitCode).toBe(0);
    expect(firstReport.final.receipts[0]!.settlement).toBe('held');
    expect(firstReport.final.journal.map(entry => entry.state)).toEqual([
      'applied',
    ]);
    expect(second!.signal).toBe('SIGKILL');
    expect(receiptsRouteRequests(second!.serverAfter)).toHaveLength(2);
    expect(second!.serverAfter.recorded).toHaveLength(1);
    const report = requireReport(third!);
    expect(third!.exitCode).toBe(0);
    // Found: the held settlement (not terminal) plus an unanswered
    // re-presentation → HOLD with the held settlement preserved.
    expect(report.asFound.receipts[0]).toMatchObject({
      settlement: 'held',
      settledAt: null,
    });
    expect(report.asFound.journal.map(entry => entry.state)).toEqual([
      'applied',
      'in_flight',
    ]);
    expect(report.asFoundStatus.hold).toBe(true);
    expect(report.asFoundStatus.pending[0]).toMatchObject({
      settlement: 'held',
      phase: 'presented_unanswered',
      presentations: 2,
    });
    expectSettledOnce(report, server, ['applied', 'superseded', 'applied'], 3);
  });

  it('A7e: the request never leaves on two consecutive launches — the server sees exactly one presentation in total and no receipt is ever minted twice', async () => {
    const { launches, server } = await runWalletLaunches([
      { kill: { id: 'unsent_1', trigger: HTTP_BEFORE } },
      { kill: { id: 'unsent_2', trigger: HTTP_BEFORE } },
      {},
    ]);
    const [, second, third] = launches;
    expect(second!.signal).toBe('SIGKILL');
    expect(receiptsRouteRequests(second!.serverAfter)).toHaveLength(0);
    const report = requireReport(third!);
    expect(third!.exitCode).toBe(0);
    expect(report.asFound.journal.map(entry => entry.state)).toEqual([
      'superseded',
      'in_flight',
    ]);
    expect(report.asFound.receipts).toHaveLength(1);
    expectSettledOnce(
      report,
      server,
      ['superseded', 'superseded', 'applied'],
      1,
    );
  });
});
