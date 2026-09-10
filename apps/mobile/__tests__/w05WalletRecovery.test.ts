/**
 * W05-03 — wallet crash recovery: receipts survive process death and are
 * never double-submitted.
 *
 * The JS-side wallet store keeps a write-ahead journal for every receipt
 * presentation: the batch of receipt ids is committed as `in_flight` BEFORE
 * the request leaves the device, and the server's verdicts are applied to the
 * receipts and to that journal entry in ONE transaction. Whatever the process
 * death leaves behind, the relaunch re-presents exactly the same receipt ids
 * (never a new receipt, never a second ticket) and an unanswered presentation
 * is reported as a HOLD until the server's verdict arrives. Submission is
 * serialized per owner so two concurrent drains cannot present one receipt
 * twice, verdicts are applied atomically per batch, unreadable journal state
 * is a typed failure (never an empty wallet), and another owner's journal is
 * invisible.
 *
 * Process-death evidence runs through the shared harness (a real SQLite file
 * across SIGKILL + relaunch, `__harness__/processDeath`); the wallet child
 * drives the SHIPPING sync runtime, so the journal is exercised exactly where
 * the app exercises it.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
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
  settleOfflineReceipt,
} from '../src/data/offlineCapabilities';
import {
  OFFLINE_WALLET_JOURNAL_DDL,
  readOfflineWalletJournal,
  readOfflineWalletStatus,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import { createSqliteTestDb } from '../testSupport/sqlite';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../src/data/db';

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
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
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
}

/** A free-allocation grant response exactly as the API restates it; the
 * signature is opaque to the device (verified server-side on settlement). */
function grantResponse(fixture: GrantFixture = {}): Record<string, unknown> {
  const issuedAt = fixture.issuedAt ?? ISSUED_AT;
  const expiresAt = fixture.expiresAt ?? EXPIRES_AT;
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: fixture.issuer ?? ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: GRANT_ID,
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
      allocationId: GRANT_ID,
      generation: 1,
      ticketIds: TICKETS,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  return {
    grantId: GRANT_ID,
    generation: 1,
    entitlementSource: 'identity_lifetime_free',
    issuedAt,
    expiresAt,
    entitlementExpiresAt: null,
    ticketIds: TICKETS,
    keyId: KEY_ID,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
  };
}

function issuedGrant(): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant(grantResponse());
  if (!parsed) throw new Error('fixture grant response must parse');
  return parsed;
}

function reading(nowMs: number): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
  };
}

const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const ACTIVE = reading((ISSUED_AT + 60) * 1000);

function consumption(operationId: string) {
  return {
    operationId,
    resultId: `result-${operationId}`,
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

interface ReceiptsRouteCall {
  readonly url: string;
  readonly receiptIds: readonly string[];
}

type RouteAnswer =
  Record<string, unknown> | Response | Error | Promise<Record<string, unknown>>;

/** Serves the receipts route from a verdict function; every other route
 * answers 404 so nothing else can be mistaken for settlement. */
function mockReceiptsRoute(
  answer: (receiptIds: readonly string[], call: number) => RouteAnswer,
) {
  const calls: ReceiptsRouteCall[] = [];
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
  return { calls, spy };
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

function client() {
  return createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
}

describe('W05-03 wallet crash recovery', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;
  let route: ReturnType<typeof mockReceiptsRoute> | null = null;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => {
    route?.spy.mockRestore();
    route = null;
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

  it('installs the wallet journal in the shipping schema beside the wallet tables', () => {
    expect(OFFLINE_WALLET_JOURNAL_DDL.length).toBeGreaterThan(0);
    const tables = handle.native
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
         ('offline_grant', 'offline_ticket', 'offline_receipt', 'offline_wallet_journal')
         ORDER BY name`,
      )
      .all()
      .map(row => row['name']);
    expect(tables).toEqual([
      'offline_grant',
      'offline_receipt',
      'offline_ticket',
      'offline_wallet_journal',
    ]);
  });

  it('journals a presentation before the request and closes it with the verdicts in one transaction', async () => {
    const [receipt] = await holdAndConsume(['op-1']);
    const journalBeforeRequest: string[] = [];
    route = mockReceiptsRoute(receiptIds => {
      journalBeforeRequest.push(
        ...handle.native
          .prepare(
            `SELECT state FROM offline_wallet_journal WHERE owner_key = ? ORDER BY opened_at`,
          )
          .all(OWNER)
          .map(row => String(row['state'])),
      );
      return recorded(receiptIds);
    });
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      submitted: 1,
      accepted: 1,
      held: 0,
      refused: 0,
      pending: 0,
      recovered: 0,
      stale: 0,
      unreadable: 0,
    });
    // The journal entry was durable (committed) while the request was in
    // flight: that is the write-ahead property a SIGKILL relies on.
    expect(journalBeforeRequest).toEqual(['in_flight']);
    const journal = await readOfflineWalletJournal(db);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      ownerId: OWNER,
      receiptIds: [receipt!.receiptId],
      state: 'applied',
      verdicts: [
        {
          receiptId: receipt!.receiptId,
          verdict: 'accepted',
          code: 'result_recorded',
        },
      ],
    });
    expect(journal[0]!.closedAt).not.toBeNull();
    expect(await pendingOfflineReceipts(db)).toEqual([]);
    const status = await readOfflineWalletStatus(db);
    expect(status).toEqual({
      pending: [],
      unansweredPresentations: 0,
      hold: false,
    });
  });

  it('serializes concurrent drains so one receipt is never presented twice', async () => {
    const [receipt] = await holdAndConsume(['op-1']);
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => (release = resolve));
    route = mockReceiptsRoute(async receiptIds => {
      await gate;
      return recorded(receiptIds);
    });
    const first = reconcileOfflineWallet(db, client(), ACTIVE);
    const second = reconcileOfflineWallet(db, client(), ACTIVE);
    // Let the first presentation reach the (gated) server before releasing.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(route.calls).toHaveLength(1);
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ submitted: 1, accepted: 1, pending: 0 });
    expect(b).toMatchObject({ submitted: 0, accepted: 0, pending: 0 });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [receipt!.receiptId],
    ]);
    expect((await readOfflineWalletJournal(db)).map(e => e.state)).toEqual([
      'applied',
    ]);
  });

  it('a presentation whose answer never arrives stays in flight and is reported as a HOLD', async () => {
    const [receipt] = await holdAndConsume(['op-1']);
    route = mockReceiptsRoute(() => new TypeError('Network request failed'));
    await expect(reconcileOfflineWallet(db, client(), ACTIVE)).rejects.toThrow(
      'Network request failed',
    );
    expect(await pendingOfflineReceipts(db)).toEqual([receipt]);
    const status = await readOfflineWalletStatus(db);
    expect(status.hold).toBe(true);
    expect(status.unansweredPresentations).toBe(1);
    expect(status.pending).toEqual([
      {
        receiptId: receipt!.receiptId,
        operationId: 'op-1',
        settlement: null,
        presentations: 1,
        phase: 'presented_unanswered',
      },
    ]);
    // Nothing was refunded or retried under another id: the same receipt is
    // re-presented once the connection is back, and the abandoned entry is
    // superseded (recovered) by the new presentation — never silently dropped.
    route.spy.mockRestore();
    route = mockReceiptsRoute(receiptIds => recorded(receiptIds));
    const again = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(again).toEqual({
      submitted: 1,
      accepted: 1,
      held: 0,
      refused: 0,
      pending: 0,
      recovered: 1,
      stale: 0,
      unreadable: 0,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [receipt!.receiptId],
    ]);
    const journal = await readOfflineWalletJournal(db);
    expect(journal.map(entry => entry.state)).toEqual([
      'superseded',
      'applied',
    ]);
    expect(journal.every(entry => entry.closedAt !== null)).toBe(true);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    const allocation = await readOfflineAllocation(db, ACTIVE);
    expect(allocation).toMatchObject({
      spendableTickets: 1,
      consumedTickets: 1,
      pendingReceipts: 0,
    });
  });

  it('a verdict the device could not record leaves the presentation in flight, and the replay settles it without a second consumption', async () => {
    const [receipt] = await holdAndConsume(['op-1']);
    route = mockReceiptsRoute(receiptIds => recorded(receiptIds));
    // The server answered; the local settlement write dies (a crash between
    // the answer and the commit looks exactly like this to the next launch).
    handle.failStatementOnce('UPDATE offline_receipt SET settlement');
    await expect(reconcileOfflineWallet(db, client(), ACTIVE)).rejects.toThrow(
      'SQLite write failed',
    );
    expect(route.calls).toHaveLength(1);
    const pending = await pendingOfflineReceipts(db);
    expect(pending.map(entry => entry.receiptId)).toEqual([receipt!.receiptId]);
    expect((await readOfflineWalletStatus(db)).hold).toBe(true);
    expect((await readOfflineWalletJournal(db)).map(e => e.state)).toEqual([
      'in_flight',
    ]);

    // Relaunch behaviour: the SAME receipt id is presented again; the server
    // answers idempotently; the wallet records it and nothing else changes.
    const replay = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.receiptId).toBe(receipt!.receiptId);
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toMatchObject({
      submitted: 1,
      accepted: 1,
      pending: 0,
      recovered: 1,
    });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [receipt!.receiptId],
      [receipt!.receiptId],
    ]);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    expect(await readOfflineAllocation(db, ACTIVE)).toMatchObject({
      spendableTickets: 1,
      consumedTickets: 1,
      pendingReceipts: 0,
    });
  });

  it('applies a batch of verdicts atomically: a failed write settles none of them', async () => {
    const receipts = await holdAndConsume(['op-1', 'op-2']);
    route = mockReceiptsRoute(receiptIds => recorded(receiptIds));
    let settlements = 0;
    handle.observeStatements(call => {
      if (
        call.sql.includes('UPDATE offline_receipt SET settlement') &&
        ++settlements === 2
      ) {
        throw new Error('disk full');
      }
    });
    await expect(reconcileOfflineWallet(db, client(), ACTIVE)).rejects.toThrow(
      'disk full',
    );
    handle.observeStatements(null);
    expect(settlements).toBe(2);
    // The first receipt's settlement was written inside the same transaction
    // and rolled back with it: both receipts are still pending.
    expect((await pendingOfflineReceipts(db)).map(r => r.receiptId)).toEqual(
      receipts.map(r => r.receiptId),
    );
    expect((await readOfflineWalletJournal(db)).map(e => e.state)).toEqual([
      'in_flight',
    ]);
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toMatchObject({
      submitted: 2,
      accepted: 2,
      pending: 0,
      recovered: 1,
    });
    expect(route.calls).toHaveLength(2);
    expect(route.calls[1]!.receiptIds).toEqual(receipts.map(r => r.receiptId));
  });

  it('keeps a held verdict pending and re-presents the same receipt id later', async () => {
    const [receipt] = await holdAndConsume(['op-1']);
    route = mockReceiptsRoute((receiptIds, call) =>
      recorded(receiptIds, () =>
        call === 1 ? 'reconciliation_required' : 'result_recorded',
      ),
    );
    const held = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(held).toMatchObject({ submitted: 1, held: 1, pending: 1 });
    const status = await readOfflineWalletStatus(db);
    expect(status.hold).toBe(false);
    expect(status.pending).toEqual([
      {
        receiptId: receipt!.receiptId,
        operationId: 'op-1',
        settlement: 'held',
        presentations: 1,
        phase: 'held',
      },
    ]);
    const accepted = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(accepted).toMatchObject({ submitted: 1, accepted: 1, pending: 0 });
    expect(route.calls.map(call => call.receiptIds)).toEqual([
      [receipt!.receiptId],
      [receipt!.receiptId],
    ]);
    expect((await readOfflineWalletJournal(db)).map(e => e.state)).toEqual([
      'applied',
      'applied',
    ]);
  });

  it('never overwrites a terminal settlement with a later verdict for the same receipt', async () => {
    const [receipt] = await holdAndConsume(['op-1']);
    route = mockReceiptsRoute(async receiptIds => {
      // A terminal verdict lands through another path while this
      // presentation is in flight; the late answer must not flip it.
      await settleOfflineReceipt(db, receipt!.receiptId, 'refused', ACTIVE);
      return recorded(receiptIds);
    });
    const outcome = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(outcome).toEqual({
      submitted: 1,
      accepted: 0,
      held: 0,
      refused: 0,
      pending: 0,
      recovered: 0,
      stale: 1,
      unreadable: 0,
    });
    const row = handle.native
      .prepare(
        'SELECT settlement FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?',
      )
      .get(OWNER, receipt!.receiptId);
    expect(row?.['settlement']).toBe('refused');
    expect((await readOfflineWalletJournal(db)).map(e => e.state)).toEqual([
      'applied',
    ]);
  });

  it('unreadable journal state is a typed failure, never an empty wallet', async () => {
    const [receipt] = await holdAndConsume(['op-1']);
    handle.native
      .prepare(
        `INSERT INTO offline_wallet_journal (
           owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts
         ) VALUES (?, 'j-corrupt', 'receipt_submission', 'not json', 'in_flight', '2026-01-01T00:00:00.000Z', NULL, NULL)`,
      )
      .run(OWNER);
    const status = await failure(readOfflineWalletStatus(db));
    expect(status.code).toBe('offline.wallet_corrupt');
    const journal = await failure(readOfflineWalletJournal(db));
    expect(journal.code).toBe('offline.wallet_corrupt');
    route = mockReceiptsRoute(receiptIds => recorded(receiptIds));
    const drain = await failure(reconcileOfflineWallet(db, client(), ACTIVE));
    expect(drain.code).toBe('offline.wallet_corrupt');
    // Nothing was presented and the receipt is untouched.
    expect(route.calls).toEqual([]);
    expect(await pendingOfflineReceipts(db)).toEqual([receipt]);
  });

  it('reports and supersedes only the signed-in owner’s journal', async () => {
    const [mine] = await holdAndConsume(['op-1']);
    route = mockReceiptsRoute(() => new TypeError('Network request failed'));
    await expect(reconcileOfflineWallet(db, client(), ACTIVE)).rejects.toThrow(
      'Network request failed',
    );
    route.spy.mockRestore();
    route = mockReceiptsRoute(receiptIds => recorded(receiptIds));

    setActiveDataOwner(OTHER_OWNER);
    expect(await readOfflineWalletStatus(db)).toEqual({
      pending: [],
      unansweredPresentations: 0,
      hold: false,
    });
    expect(await readOfflineWalletJournal(db)).toEqual([]);
    const other = await reconcileOfflineWallet(db, client(), ACTIVE);
    expect(other).toEqual({
      submitted: 0,
      accepted: 0,
      held: 0,
      refused: 0,
      pending: 0,
      recovered: 0,
      stale: 0,
      unreadable: 0,
    });
    expect(route.calls).toEqual([]);

    setActiveDataOwner(OWNER);
    const status = await readOfflineWalletStatus(db);
    expect(status.hold).toBe(true);
    expect(status.pending.map(entry => entry.receiptId)).toEqual([
      mine!.receiptId,
    ]);
    expect((await readOfflineWalletJournal(db)).map(e => e.state)).toEqual([
      'in_flight',
    ]);
  });

  it('the sync runtime drains receipts through the wallet journal for the signed-in owner', async () => {
    const session = {
      apiBaseUrl: ISSUER,
      bearerToken: 'access-token',
      canonicalAppUserId: OWNER,
      provider: 'apple' as const,
    };
    const [receipt] = await holdAndConsume(['op-1']);
    route = mockReceiptsRoute(receiptIds => recorded(receiptIds));
    (getDb as jest.Mock).mockReturnValue(db);
    establishApiSession(session);
    try {
      configureSyncRuntime(session);
      await triggerOutboxSync();
      const receiptCalls = route.calls.filter(
        call => call.url === RECEIPTS_ROUTE,
      );
      expect(receiptCalls.map(call => call.receiptIds)).toEqual([
        [receipt!.receiptId],
      ]);
      expect(await pendingOfflineReceipts(db)).toEqual([]);
      const journal = await readOfflineWalletJournal(db);
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        receiptIds: [receipt!.receiptId],
        state: 'applied',
      });
      // Nothing pending: the next drain neither calls the route nor journals.
      await triggerOutboxSync();
      expect(
        route.calls.filter(call => call.url === RECEIPTS_ROUTE),
      ).toHaveLength(1);
      expect(await readOfflineWalletJournal(db)).toHaveLength(1);
    } finally {
      clearSyncRuntime();
      clearApiSession();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      (getDb as jest.Mock).mockReset();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Process death: a real SQLite file, SIGKILL at each step, relaunch.        */
/* ------------------------------------------------------------------------ */

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
  /** Receipt ids the server has durably recorded, in first-seen order. */
  readonly recorded: readonly string[];
  /** Presentations per receipt id (a replay increments, never re-records). */
  readonly presentations: Readonly<Record<string, number>>;
  readonly requests: readonly ReceiptServiceRequest[];
  readonly unrouted: readonly string[];
  readonly unauthorized: readonly string[];
}

interface ReceiptService {
  readonly baseUrl: string;
  snapshot(): ReceiptServiceSnapshot;
  close(): Promise<void>;
}

/** Loopback stand-in for `POST /v1/offline/receipts` with the server-side
 * idempotency the real route implements: a receipt id is recorded once and
 * every later presentation replays the same verdict. `firstVerdict` lets a
 * scenario hold the first presentation (`pending`) so the relaunch has to
 * re-present the same id to get `result_recorded`. */
async function startReceiptService(
  options: { readonly firstVerdict?: 'result_recorded' | 'pending' } = {},
): Promise<ReceiptService> {
  const recorded: string[] = [];
  const presentations = new Map<string, number>();
  const requests: ReceiptServiceRequest[] = [];
  const unrouted: string[] = [];
  const unauthorized: string[] = [];
  const firstVerdict = options.firstVerdict ?? 'result_recorded';

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
            if (seen === 0 && firstVerdict === 'pending') {
              return { receiptId, status: 'pending' };
            }
            if (!recorded.includes(receiptId)) recorded.push(receiptId);
            return { receiptId, status: 'result_recorded' };
          }),
          rejected: [],
        };
      } else {
        unrouted.push(`${method} ${routePath}`);
        status = 404;
        payload = {
          error: { code: 'harness.unrouted', message: 'No route.' },
        };
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
      unrouted: [...unrouted],
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
  readonly launch: '1' | '2';
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

async function runWalletLaunches(
  specs: readonly WalletLaunchSpec[],
  options: { readonly firstVerdict?: 'result_recorded' | 'pending' } = {},
): Promise<{
  readonly launches: readonly WalletLaunchResult[];
  readonly server: ReceiptServiceSnapshot;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-wallet-death-'));
  const dbPath = path.join(dir, 'pickle-sensei.db');
  const service = await startReceiptService(options);
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
    for (const spec of specs) {
      const result = await launchWalletChild({
        PD_DB_PATH: dbPath,
        PD_FIXTURE_PATH: fixturePath,
        PD_API_BASE_URL: service.baseUrl,
        PD_LAUNCH: spec.launch,
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

interface WalletAsFound {
  readonly grants: 0 | 1;
  readonly consumedTickets: 0 | 1;
  readonly receipts: 0 | 1;
  readonly journal: readonly ('in_flight' | 'applied' | 'superseded')[];
  /** Requests the server saw during the killed launch. */
  readonly presentations: 0 | 1;
}

interface WalletKillPoint {
  readonly id: string;
  readonly step: string;
  readonly trigger: KillTrigger;
  readonly asFound: WalletAsFound;
}

const HELD_GRANT: WalletAsFound = {
  grants: 1,
  consumedTickets: 0,
  receipts: 0,
  journal: [],
  presentations: 0,
};
const QUEUED_RECEIPT: WalletAsFound = {
  grants: 1,
  consumedTickets: 1,
  receipts: 1,
  journal: [],
  presentations: 0,
};
const UNSENT_PRESENTATION: WalletAsFound = {
  ...QUEUED_RECEIPT,
  journal: ['in_flight'],
};
const UNANSWERED_PRESENTATION: WalletAsFound = {
  ...UNSENT_PRESENTATION,
  presentations: 1,
};

/** Kill points along `holdOfflineGrant` → `consumeOfflineAllocation` →
 * (sync runtime) `reconcileOfflineWallet`. Statement fragments must match the
 * shipping SQL text; `before`/`after` semantics as in `killPoints.ts`. */
const WALLET_KILL_POINTS: readonly WalletKillPoint[] = [
  {
    id: 'grant_row_written_mid_transaction',
    step: 'holdOfflineGrant: grant row inserted, tickets not yet',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO offline_grant'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: {
      grants: 0,
      consumedTickets: 0,
      receipts: 0,
      journal: [],
      presentations: 0,
    },
  },
  {
    id: 'ticket_spent_mid_transaction',
    step: 'consumeOfflineAllocation: ticket consumed, receipt not yet queued',
    trigger: {
      kind: 'sql',
      includes: ["UPDATE offline_ticket SET state = 'consumed'"],
      ordinal: 1,
      phase: 'after',
    },
    asFound: HELD_GRANT,
  },
  {
    id: 'receipt_queued_mid_transaction',
    step: 'consumeOfflineAllocation: receipt inserted, transaction open',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO offline_receipt'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: HELD_GRANT,
  },
  {
    id: 'consumption_committed_before_presentation',
    step: 'receipt durable; the wallet has not journalled a presentation',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO offline_wallet_journal'],
      ordinal: 1,
      phase: 'before',
    },
    asFound: QUEUED_RECEIPT,
  },
  {
    id: 'presentation_journalled_mid_transaction',
    step: 'journal row inserted, transaction open (request never sent)',
    trigger: {
      kind: 'sql',
      includes: ['INSERT INTO offline_wallet_journal'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: QUEUED_RECEIPT,
  },
  {
    id: 'presentation_journalled_request_unsent',
    step: 'journal committed; the request never left the device',
    trigger: {
      kind: 'http',
      pathIncludes: RECEIPTS_PATH,
      ordinal: 1,
      phase: 'before',
    },
    asFound: UNSENT_PRESENTATION,
  },
  {
    id: 'verdict_lost_after_server_recorded',
    step: 'server recorded the receipt; the answer never reached the wallet',
    trigger: {
      kind: 'http',
      pathIncludes: RECEIPTS_PATH,
      ordinal: 1,
      phase: 'after',
    },
    asFound: UNANSWERED_PRESENTATION,
  },
  {
    id: 'settlement_written_mid_transaction',
    step: 'verdict applied to the receipt, transaction open',
    trigger: {
      kind: 'sql',
      includes: ['UPDATE offline_receipt SET settlement'],
      ordinal: 1,
      phase: 'after',
    },
    asFound: UNANSWERED_PRESENTATION,
  },
  {
    id: 'journal_applied_mid_transaction',
    step: 'journal entry marked applied, transaction open',
    trigger: {
      kind: 'sql',
      includes: ["UPDATE offline_wallet_journal SET state = 'applied'"],
      ordinal: 1,
      phase: 'after',
    },
    asFound: UNANSWERED_PRESENTATION,
  },
];

function requireReport(launch: WalletLaunchResult): WalletChildReport {
  if (!launch.report) {
    throw new Error(
      `relaunch produced no report (exit ${String(launch.exitCode)} / ${String(launch.signal)}):\n${launch.stderr}`,
    );
  }
  return launch.report;
}

function receiptsRouteRequests(
  server: ReceiptServiceSnapshot,
): readonly ReceiptServiceRequest[] {
  return server.requests.filter(request => request.path === RECEIPTS_PATH);
}

describe('W05-03 process death: receipts survive SIGKILL and are never double-submitted', () => {
  it('control: a normal launch settles its receipt once; the relaunch replays the consumption and presents nothing', async () => {
    const { launches, server } = await runWalletLaunches([
      { launch: '1' },
      { launch: '2' },
    ]);
    const [first, second] = launches;
    const firstReport = requireReport(first!);
    expect(first!.exitCode).toBe(0);
    expect(firstReport.consumption.replayed).toBe(false);
    expect(firstReport.final.receipts).toHaveLength(1);
    expect(firstReport.final.receipts[0]).toMatchObject({
      receiptId: firstReport.consumption.receiptId,
      operationId: OPERATION_ID,
      settlement: 'accepted',
    });
    expect(firstReport.final.journal.map(entry => entry.state)).toEqual([
      'applied',
    ]);
    expect(firstReport.finalStatus).toEqual({
      hold: false,
      unansweredPresentations: 0,
      pending: [],
    });

    const secondReport = requireReport(second!);
    expect(second!.exitCode).toBe(0);
    expect(secondReport.asFound).toEqual(firstReport.final);
    expect(secondReport.asFoundStatus.hold).toBe(false);
    expect(secondReport.consumption).toEqual({
      ...firstReport.consumption,
      replayed: true,
    });
    expect(secondReport.final).toEqual(firstReport.final);

    expect(receiptsRouteRequests(server).map(r => r.receiptIds)).toEqual([
      [firstReport.consumption.receiptId],
    ]);
    expect(server.recorded).toEqual([firstReport.consumption.receiptId]);
    expect(server.unrouted).toEqual([]);
    expect(server.unauthorized).toEqual([]);
  });

  it.each(WALLET_KILL_POINTS)('SIGKILL at $id: $step', async point => {
    const { launches, server } = await runWalletLaunches([
      { launch: '1', kill: { id: point.id, trigger: point.trigger } },
      { launch: '2' },
    ]);
    const [first, second] = launches;

    // The first launch died exactly where intended, by SIGKILL.
    expect(first!.signal).toBe('SIGKILL');
    expect(first!.killMarker?.startsWith(point.id)).toBe(true);
    expect(first!.report).toBeNull();
    expect(receiptsRouteRequests(first!.serverAfter)).toHaveLength(
      point.asFound.presentations,
    );

    // What the relaunch found on disk before any recovery ran.
    const report = requireReport(second!);
    expect(second!.exitCode).toBe(0);
    expect(second!.stderr).toBe('');
    const asFound = report.asFound;
    expect(asFound.grants).toHaveLength(point.asFound.grants);
    expect(
      asFound.tickets.filter(ticket => ticket.state === 'consumed'),
    ).toHaveLength(point.asFound.consumedTickets);
    expect(asFound.receipts).toHaveLength(point.asFound.receipts);
    expect(asFound.receipts.every(r => r.settlement === null)).toBe(true);
    expect(asFound.journal.map(entry => entry.state)).toEqual(
      point.asFound.journal,
    );
    // An in-flight presentation with no recorded answer is a HOLD, never a
    // refund and never a fresh receipt: the wallet says so before draining.
    const unanswered = point.asFound.journal.filter(
      state => state === 'in_flight',
    ).length;
    expect(report.asFoundStatus.hold).toBe(unanswered > 0);
    expect(report.asFoundStatus.unansweredPresentations).toBe(unanswered);
    if (point.asFound.receipts === 1) {
      expect(report.asFoundStatus.pending).toEqual([
        {
          receiptId: asFound.receipts[0]!.receiptId,
          operationId: OPERATION_ID,
          settlement: null,
          presentations: unanswered,
          phase: unanswered > 0 ? 'presented_unanswered' : 'queued',
        },
      ]);
    }

    // The relaunch keeps the ORIGINAL receipt when one survived, and
    // consumes exactly one ticket in total either way.
    expect(report.consumption.replayed).toBe(point.asFound.receipts === 1);
    if (point.asFound.receipts === 1) {
      expect(report.consumption.receiptId).toBe(asFound.receipts[0]!.receiptId);
    }
    const receiptId = report.consumption.receiptId;
    const final = report.final;
    expect(final.grants).toHaveLength(1);
    expect(final.grants[0]!.lifecycleSequence).toBe(1);
    expect(final.tickets).toHaveLength(TICKETS.length);
    expect(final.tickets.filter(t => t.state === 'consumed')).toEqual([
      expect.objectContaining({ state: 'consumed', receiptId }),
    ]);
    expect(final.receipts).toEqual([
      expect.objectContaining({
        ownerKey: OWNER,
        receiptId,
        operationId: OPERATION_ID,
        settlement: 'accepted',
      }),
    ]);
    expect(final.receipts[0]!.settledAt).not.toBeNull();
    // Every journalled presentation names the same single receipt; the
    // orphaned entry (if any) is closed as superseded, the new one applied.
    expect(final.journal.map(entry => entry.state)).toEqual([
      ...point.asFound.journal.map(() => 'superseded' as const),
      'applied',
    ]);
    expect(
      final.journal.every(
        entry =>
          entry.ownerKey === OWNER &&
          entry.receiptIds.length === 1 &&
          entry.receiptIds[0] === receiptId,
      ),
    ).toBe(true);
    expect(report.finalStatus).toEqual({
      hold: false,
      unansweredPresentations: 0,
      pending: [],
    });

    // Server view: the relaunch presented exactly once, always the same
    // receipt id, and the server holds exactly one recorded receipt.
    const requests = receiptsRouteRequests(server);
    expect(requests).toHaveLength(point.asFound.presentations + 1);
    expect(requests.every(r => r.status === 200)).toBe(true);
    expect(requests.map(r => r.receiptIds)).toEqual(
      requests.map(() => [receiptId]),
    );
    expect(server.recorded).toEqual([receiptId]);
    expect(server.presentations).toEqual({
      [receiptId]: point.asFound.presentations + 1,
    });
    expect(server.unrouted).toEqual([]);
    expect(server.unauthorized).toEqual([]);
  });

  it('a HELD verdict survives the relaunch and the same receipt id is re-presented until accepted', async () => {
    const { launches, server } = await runWalletLaunches(
      [{ launch: '1' }, { launch: '2' }],
      { firstVerdict: 'pending' },
    );
    const [first, second] = launches;
    const firstReport = requireReport(first!);
    expect(first!.exitCode).toBe(0);
    const receiptId = firstReport.consumption.receiptId;
    expect(firstReport.final.receipts).toEqual([
      expect.objectContaining({
        receiptId,
        settlement: 'held',
        settledAt: null,
      }),
    ]);
    expect(firstReport.final.journal.map(entry => entry.state)).toEqual([
      'applied',
    ]);
    expect(firstReport.finalStatus).toEqual({
      hold: false,
      unansweredPresentations: 0,
      pending: [
        {
          receiptId,
          operationId: OPERATION_ID,
          settlement: 'held',
          presentations: 1,
          phase: 'held',
        },
      ],
    });

    const secondReport = requireReport(second!);
    expect(second!.exitCode).toBe(0);
    expect(secondReport.asFound).toEqual(firstReport.final);
    expect(secondReport.asFoundStatus).toEqual(firstReport.finalStatus);
    expect(secondReport.consumption).toEqual({
      ...firstReport.consumption,
      replayed: true,
    });
    expect(secondReport.final.receipts).toEqual([
      expect.objectContaining({ receiptId, settlement: 'accepted' }),
    ]);
    expect(secondReport.final.journal.map(entry => entry.state)).toEqual([
      'applied',
      'applied',
    ]);
    expect(
      secondReport.final.tickets.filter(t => t.state === 'consumed'),
    ).toHaveLength(1);
    expect(secondReport.finalStatus.pending).toEqual([]);

    expect(receiptsRouteRequests(server).map(r => r.receiptIds)).toEqual([
      [receiptId],
      [receiptId],
    ]);
    expect(server.recorded).toEqual([receiptId]);
    expect(server.presentations).toEqual({ [receiptId]: 2 });
  });
});
