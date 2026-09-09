/**
 * W04-05 — the mobile offline capability model consumes SERVER-ISSUED grants.
 *
 * Allocation is not consumption: a held grant's tickets are an allocation the
 * server already counts against the identity's lifetime budget. The device
 * decrements its local remaining allocation only when a ticket pays for one
 * result, and queues the consumption receipt durably in the same transaction.
 * Losing the connection, restarting the process or letting the execution
 * lease expire never gives a ticket back: only the server's explicit
 * settlement of a receipt (or an explicit return) changes what the device
 * reports.
 *
 * Ticket ids are conserved across grant generations (the server restates
 * outstanding tickets in every newer grant), a HELD verdict keeps a receipt
 * reconcilable, a replay with a conflicting result is refused, and the sync
 * runtime drains queued receipts to the server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
} from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';
import {
  ApiError,
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
import {
  OFFLINE_CAPABILITY_MAP_V1,
  OfflineGrantError,
  consumeOfflineAllocation,
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
  reconcileOfflineReceipts,
  requestOfflineGrant,
  settleOfflineReceipt,
} from '../src/data/offlineCapabilities';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import { createSqliteTestDb } from '../testSupport/sqlite';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../src/data/db';

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
];
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const GRANT_ID_2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const RESULT_SHA = 'c'.repeat(64);
const OTHER_RESULT_SHA = 'd'.repeat(64);
const RECEIPTS_ROUTE = `${ISSUER}/v1/offline/receipts`;

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface GrantFixture {
  ownerId?: string;
  grantId?: string;
  generation?: number;
  ticketIds?: readonly string[];
  issuedAt?: number;
  expiresAt?: number;
  installationKeyId?: string;
  pro?: boolean;
  /** Mutates the top-level response after the claims were signed. */
  response?: (raw: Record<string, unknown>) => void;
  /** Mutates the claims before they are encoded. */
  claims?: (claims: Record<string, unknown>) => void;
}

function grantResponse(fixture: GrantFixture = {}): Record<string, unknown> {
  const ownerId = fixture.ownerId ?? OWNER;
  const grantId = fixture.grantId ?? GRANT_ID;
  const generation = fixture.generation ?? 1;
  const ticketIds = fixture.pro ? [] : (fixture.ticketIds ?? TICKETS);
  const issuedAt = fixture.issuedAt ?? ISSUED_AT;
  const expiresAt = fixture.expiresAt ?? EXPIRES_AT;
  const installationKeyId = fixture.installationKeyId ?? INSTALLATION_KEY;
  const entitlementExpiresAt = fixture.pro ? expiresAt + 3600 : null;
  const claims: Record<string, unknown> = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: ownerId,
    jti: grantId,
    installationKeyId,
    iat: issuedAt,
    exp: expiresAt,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    ...(fixture.pro
      ? {
          entitlementSource: 'verified_store',
          lease: {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind: 'subscription',
            verifiedEntitlementExpiresAt: entitlementExpiresAt,
          },
        }
      : {
          entitlementSource: 'identity_lifetime_free',
          allocation: {
            schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
            allocationId: grantId,
            generation,
            ticketIds,
            budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
            financialExpiry: 'reconciliation_only',
          },
        }),
  };
  fixture.claims?.(claims);
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  const raw: Record<string, unknown> = {
    grantId,
    generation,
    entitlementSource: fixture.pro
      ? 'verified_store'
      : 'identity_lifetime_free',
    issuedAt,
    expiresAt,
    entitlementExpiresAt,
    ticketIds,
    keyId: KEY_ID,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
  };
  fixture.response?.(raw);
  return raw;
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
const AFTER_EXPIRY = reading((EXPIRES_AT + 60) * 1000);

async function failure(promise: Promise<unknown>): Promise<OfflineGrantError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OfflineGrantError) return error;
    throw error;
  }
  throw new Error('expected the operation to fail');
}

function consumption(operationId: string, grantId?: string) {
  return {
    operationId,
    resultId: `result-${operationId}`,
    fullOutputSha256: RESULT_SHA,
    ...(grantId ? { grantId } : {}),
  };
}

function restatedGrant(ticketIds: readonly string[]): IssuedOfflineGrant {
  return issuedGrant({
    grantId: GRANT_ID_2,
    generation: 2,
    ticketIds,
    issuedAt: ISSUED_AT + 100,
    expiresAt: EXPIRES_AT + 100,
  });
}

interface ReceiptsRouteCall {
  readonly url: string;
  readonly body: { receipts?: Array<Record<string, unknown>> };
}

/** Serves the receipts route from a verdict table keyed by receipt id; every
 * other route answers 404 so nothing else can be mistaken for settlement. */
function mockReceiptsRoute(
  verdicts: (
    submitted: Array<Record<string, unknown>>,
  ) => Record<string, unknown> | Response,
) {
  const calls: ReceiptsRouteCall[] = [];
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });
      if (url !== RECEIPTS_ROUTE) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const answer = verdicts(body.receipts ?? []);
      if (answer instanceof Response) return answer;
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  return { calls, spy };
}

function recorded(
  submitted: Array<Record<string, unknown>>,
  status: (receiptId: string) => string,
): Record<string, unknown> {
  return {
    receipts: submitted.map(receipt => ({
      receiptId: receipt['receiptId'],
      status: status(String(receipt['receiptId'])),
    })),
    rejected: [],
  };
}

describe('W04-05 offline grants: allocation ≠ consumption', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => {
    handle.close();
  });

  it('classifies offline scoring authorization as a hybrid capability', () => {
    const entry = OFFLINE_CAPABILITY_MAP_V1['analysis.offlineGrant'];
    expect(entry.dependency).toBe('hybrid');
    expect(entry.degradation).toBe('reads_local_state');
  });

  it('holds a server-issued grant and reports its allocation without consuming it', async () => {
    const issued = issuedGrant();
    const held = await holdOfflineGrant(db, issued, BINDING);
    expect(held.grantId).toBe(GRANT_ID);
    expect(held.generation).toBe(1);
    expect(held.allocated).toBe(2);
    expect(held.remaining).toBe(2);
    expect(held.consumed).toBe(0);
    expect(held.grantJwsSha256).toBe(sha256Hex(issued.grant.compactJws));

    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants).toHaveLength(1);
    expect(snapshot.grants[0]).toMatchObject({
      grantId: GRANT_ID,
      remaining: 2,
      consumed: 0,
      execution: { kind: 'active' },
    });
    expect(snapshot.pendingReceipts).toBe(0);
    expect(await pendingOfflineReceipts(db)).toEqual([]);
  });

  it('holding the same grant twice (a replayed response) never refills the allocation', async () => {
    const issued = issuedGrant();
    await holdOfflineGrant(db, issued, BINDING);
    await consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);
    const again = await holdOfflineGrant(db, issued, BINDING);
    expect(again.remaining).toBe(1);
    expect(again.consumed).toBe(1);
    expect(handle.count('offline_grant', OWNER)).toBe(1);
  });

  it('refuses a grant whose signed claims disagree with the response, the owner or the device', async () => {
    const cases: Array<[string, GrantFixture]> = [
      [
        'jti differs from grantId',
        { response: raw => (raw['grantId'] = TICKETS[0]) },
      ],
      ['issued to another owner', { ownerId: OTHER_OWNER }],
      ['bound to another installation key', { installationKeyId: 'other' }],
      [
        'ticket list differs from the signed allocation',
        { response: raw => (raw['ticketIds'] = [TICKETS[0]]) },
      ],
      [
        'expiry differs from the signed exp',
        { response: raw => (raw['expiresAt'] = EXPIRES_AT + 1) },
      ],
      [
        'signed by an unexpected key',
        { response: raw => (raw['keyId'] = 'rogue-key') },
      ],
      [
        'issuer is not the API',
        { claims: claims => (claims['iss'] = 'https://evil.example.test') },
      ],
      [
        'lease longer than the seven-day bound',
        { expiresAt: ISSUED_AT + 8 * 24 * 60 * 60 },
      ],
    ];
    for (const [label, fixture] of cases) {
      const parsed = parseIssuedOfflineGrant(grantResponse(fixture));
      if (parsed === null) continue;
      const error = await failure(holdOfflineGrant(db, parsed, BINDING));
      expect([label, error.code]).toEqual([label, 'offline.grant_invalid']);
    }
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    expect((await readOfflineAllocation(db, ACTIVE)).grants).toEqual([]);
  });

  it('a malformed grant response is not a grant', () => {
    expect(parseIssuedOfflineGrant(null)).toBeNull();
    expect(parseIssuedOfflineGrant({})).toBeNull();
    expect(
      parseIssuedOfflineGrant(
        grantResponse({ response: raw => (raw['grant'] = 'not-a-jws') }),
      ),
    ).toBeNull();
    expect(
      parseIssuedOfflineGrant(
        grantResponse({ response: raw => (raw['ticketIds'] = 'two') }),
      ),
    ).toBeNull();
    expect(
      parseIssuedOfflineGrant(
        grantResponse({ response: raw => delete raw['keyId'] }),
      ),
    ).toBeNull();
  });

  it('consumes one ticket per operation and queues the receipt in the same transaction', async () => {
    const issued = issuedGrant();
    await holdOfflineGrant(db, issued, BINDING);

    const first = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    expect(first.replayed).toBe(false);
    expect(first.grant.remaining).toBe(1);
    expect(first.grant.consumed).toBe(1);
    expect(first.receipt).toMatchObject({
      ownerId: OWNER,
      installationKeyId: INSTALLATION_KEY,
      grantId: GRANT_ID,
      grantJwsSha256: sha256Hex(issued.grant.compactJws),
      lifecycleSequence: 1,
      ticket: { allocationId: GRANT_ID, generation: 1, ticketId: TICKETS[0] },
      operationId: 'op-1',
      resultId: 'result-op-1',
      fullOutputSha256: RESULT_SHA,
      billingDisposition: 'joint_verification_required',
      settlement: null,
    });

    const second = await consumeOfflineAllocation(
      db,
      consumption('op-2'),
      ACTIVE,
    );
    expect(second.grant.remaining).toBe(0);
    expect(second.receipt.lifecycleSequence).toBe(2);
    expect(second.receipt.ticket?.ticketId).toBe(TICKETS[1]);
    expect(second.receipt.receiptId).not.toBe(first.receipt.receiptId);

    const exhausted = await failure(
      consumeOfflineAllocation(db, consumption('op-3'), ACTIVE),
    );
    expect(exhausted.code).toBe('offline.allocation_exhausted');

    const pending = await pendingOfflineReceipts(db);
    expect(pending.map(receipt => receipt.operationId)).toEqual([
      'op-1',
      'op-2',
    ]);
    expect(handle.count('offline_receipt', OWNER)).toBe(2);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 0, consumed: 2 });
    expect(snapshot.pendingReceipts).toBe(2);
  });

  it('replaying an operation returns its receipt without a second decrement', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const first = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    const replay = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.grant.remaining).toBe(1);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
  });

  it('the decrement and the receipt commit or fail together', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    handle.failStatementOnce('INSERT INTO offline_receipt');
    await expect(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    ).rejects.toThrow('SQLite write failed');
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 2, consumed: 0 });
    expect(handle.count('offline_receipt', OWNER)).toBe(0);
  });

  it('a Pro lease consumes without a ticket and expires at its lease bound', async () => {
    const issued = issuedGrant({ pro: true, grantId: TICKETS[1] });
    const held = await holdOfflineGrant(db, issued, BINDING);
    expect(held.entitlementSource).toBe('verified_store');
    expect(held.allocated).toBe(0);
    expect(held.entitlementExpiresAt).toBe(EXPIRES_AT + 3600);
    const consumed = await consumeOfflineAllocation(
      db,
      consumption('op-pro'),
      ACTIVE,
    );
    expect(consumed.receipt.ticket).toBeNull();
    expect(consumed.receipt.billingDisposition).toBe(
      'joint_verification_required',
    );
    const expired = await failure(
      consumeOfflineAllocation(db, consumption('op-late'), AFTER_EXPIRY),
    );
    expect(expired.code).toBe('offline.grant_expired');
  });

  it('refuses to execute without trusted time, leaving the allocation untouched', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const untrusted = reading((ISSUED_AT + 60) * 1000, {
      authority: 'none',
      continuity: 'none',
      storage: 'empty',
    });
    const error = await failure(
      consumeOfflineAllocation(db, consumption('op-1'), untrusted),
    );
    expect(error.code).toBe('offline.time_reconcile_required');
    const snapshot = await readOfflineAllocation(db, untrusted);
    expect(snapshot.grants[0]).toMatchObject({
      remaining: 2,
      consumed: 0,
      execution: { kind: 'reconcile_required', reason: 'no_trusted_time' },
    });
  });

  describe('disconnect does not reclaim allocation', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'w04-offline-'));
      path = join(dir, 'wallet.db');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('a disconnected device keeps its allocation and receipts across process death and lease expiry', async () => {
      handle.close();
      handle = createSqliteTestDb(path);
      const issued = issuedGrant();
      await holdOfflineGrant(handle.db, issued, BINDING);
      const consumed = await consumeOfflineAllocation(
        handle.db,
        consumption('op-1'),
        ACTIVE,
      );
      expect(consumed.grant.remaining).toBe(1);

      // The device goes dark: nothing here may reach the network, and the
      // process dies before any reconciliation. The wallet is reopened from
      // disk by a fresh process.
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new TypeError('Network request failed'));
      try {
        handle.close();
        handle = createSqliteTestDb(path);
        const reopened = await readOfflineAllocation(handle.db, ACTIVE);
        expect(reopened.grants[0]).toMatchObject({
          grantId: GRANT_ID,
          allocated: 2,
          remaining: 1,
          consumed: 1,
          execution: { kind: 'active' },
        });
        expect(reopened.pendingReceipts).toBe(1);
        const pending = await pendingOfflineReceipts(handle.db);
        expect(pending).toEqual([consumed.receipt]);

        // The execution lease runs out while still offline: the grant can no
        // longer execute, but the unconsumed ticket stays allocated (it is
        // still held against the identity's budget server-side) and the
        // receipt stays queued. Nothing is reclaimed, nothing is invented.
        const expired = await readOfflineAllocation(handle.db, AFTER_EXPIRY);
        expect(expired.grants[0]).toMatchObject({
          remaining: 1,
          consumed: 1,
          execution: { kind: 'expired' },
        });
        const refused = await failure(
          consumeOfflineAllocation(
            handle.db,
            consumption('op-2'),
            AFTER_EXPIRY,
          ),
        );
        expect(refused.code).toBe('offline.grant_expired');
        expect(handle.count('offline_receipt', OWNER)).toBe(1);

        // A later process reopening the wallet after expiry sees the same.
        handle.close();
        handle = createSqliteTestDb(path);
        const afterRestart = await readOfflineAllocation(
          handle.db,
          AFTER_EXPIRY,
        );
        expect(afterRestart.grants[0]).toMatchObject({
          remaining: 1,
          consumed: 1,
        });
        expect(afterRestart.pendingReceipts).toBe(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('a newer grant generation does not release the older generation locally', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      await consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);
      const newer = issuedGrant({
        grantId: 'bbbbbbbb-0000-4000-8000-000000000002',
        generation: 2,
        ticketIds: ['aaaaaaaa-0000-4000-8000-000000000003'],
        issuedAt: ISSUED_AT + 100,
        expiresAt: EXPIRES_AT + 100,
      });
      await holdOfflineGrant(db, newer, BINDING);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(
        snapshot.grants.map(grant => [
          grant.generation,
          grant.remaining,
          grant.consumed,
        ]),
      ).toEqual([
        [2, 1, 0],
        [1, 1, 1],
      ]);
      // Consumption defaults to the newest executable grant.
      const consumed = await consumeOfflineAllocation(
        db,
        consumption('op-2'),
        ACTIVE,
      );
      expect(consumed.receipt.grantId).toBe(newer.grantId);
      expect(consumed.receipt.lifecycleSequence).toBe(1);
      // An explicit grant id still spends the older allocation.
      const older = await consumeOfflineAllocation(
        db,
        consumption('op-3', GRANT_ID),
        ACTIVE,
      );
      expect(older.receipt.ticket?.ticketId).toBe(TICKETS[1]);
      expect(older.receipt.lifecycleSequence).toBe(2);
    });
  });

  it('receipts stay queued until the server settles each one explicitly', async () => {
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
    await settleOfflineReceipt(db, first.receipt.receiptId, 'accepted', ACTIVE);
    const pending = await pendingOfflineReceipts(db);
    expect(pending.map(receipt => receipt.receiptId)).toEqual([
      second.receipt.receiptId,
    ]);
    // Settled receipts are history, never deleted; the allocation is unchanged.
    expect(handle.count('offline_receipt', OWNER)).toBe(2);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 0, consumed: 2 });
    expect(snapshot.pendingReceipts).toBe(1);

    const unknown = await failure(
      settleOfflineReceipt(db, 'no-such-receipt', 'accepted', ACTIVE),
    );
    expect(unknown.code).toBe('offline.receipt_unknown');
    const twice = await failure(
      settleOfflineReceipt(db, first.receipt.receiptId, 'refused', ACTIVE),
    );
    expect(twice.code).toBe('offline.receipt_settled');
  });

  it('isolates grants and receipts per owner and never hands one owner another owner grant', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    await consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);

    setActiveDataOwner(OTHER_OWNER);
    expect((await readOfflineAllocation(db, ACTIVE)).grants).toEqual([]);
    expect(await pendingOfflineReceipts(db)).toEqual([]);
    const notHeld = await failure(
      consumeOfflineAllocation(db, consumption('op-2'), ACTIVE),
    );
    expect(notHeld.code).toBe('offline.grant_not_held');
    const foreign = await failure(holdOfflineGrant(db, issuedGrant(), BINDING));
    expect(foreign.code).toBe('offline.grant_invalid');
    expect(handle.count('offline_grant', OTHER_OWNER)).toBe(0);

    setActiveDataOwner(OWNER);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 1, consumed: 1 });
    expect(snapshot.pendingReceipts).toBe(1);
  });

  it('a guest or signed-out owner cannot hold a grant', async () => {
    setActiveDataOwner('device-guest');
    const error = await failure(holdOfflineGrant(db, issuedGrant(), BINDING));
    expect(error.code).toBe('offline.owner_unsigned');
    setActiveDataOwner(OWNER);
  });

  it('a corrupt wallet row is an error, never an empty or refilled allocation', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    await consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);
    const intact = handle.native
      .prepare(
        `SELECT allocated_ticket_ids FROM offline_grant WHERE owner_key = ?`,
      )
      .get(OWNER)?.allocated_ticket_ids;
    handle.native
      .prepare(
        `UPDATE offline_grant SET allocated_ticket_ids = ? WHERE owner_key = ?`,
      )
      .run('{not json', OWNER);
    const read = await failure(readOfflineAllocation(db, ACTIVE));
    expect(read.code).toBe('offline.wallet_corrupt');
    const consume = await failure(
      consumeOfflineAllocation(db, consumption('op-2'), ACTIVE),
    );
    expect(consume.code).toBe('offline.wallet_corrupt');
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    handle.native
      .prepare(
        `UPDATE offline_grant SET allocated_ticket_ids = ? WHERE owner_key = ?`,
      )
      .run(intact, OWNER);

    // A remaining ticket that the signed allocation never listed is
    // tampering, not authorization.
    handle.native
      .prepare(
        `INSERT INTO offline_ticket
           (owner_key, ticket_id, grant_id, allocation_id, generation, state, receipt_id, held_at)
         VALUES (?, 'forged-ticket', ?, ?, 1, 'remaining', NULL, ?)`,
      )
      .run(
        OWNER,
        GRANT_ID,
        GRANT_ID,
        new Date(ACTIVE.wallClockMs).toISOString(),
      );
    const forged = await failure(readOfflineAllocation(db, ACTIVE));
    expect(forged.code).toBe('offline.wallet_corrupt');
    const forgedConsume = await failure(
      consumeOfflineAllocation(db, consumption('op-3'), ACTIVE),
    );
    expect(forgedConsume.code).toBe('offline.wallet_corrupt');
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
  });

  describe('ticket ids are conserved across grant generations', () => {
    it('a newer generation restating an unsettled consumed ticket never makes it spendable again', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const first = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      expect(first.receipt.ticket?.ticketId).toBe(TICKETS[0]);

      // issue_offline_grant restates every outstanding ticket: T1's receipt
      // has not settled, so the server lists T1 beside T2 again.
      const restated = await holdOfflineGrant(
        db,
        restatedGrant(TICKETS),
        BINDING,
      );
      expect(restated.allocated).toBe(2);
      expect(restated.remaining).toBe(1);
      expect(restated.consumed).toBe(0);

      const snapshot = await readOfflineAllocation(db, ACTIVE);
      const spendable = snapshot.grants.reduce(
        (sum, grant) => sum + grant.remaining,
        0,
      );
      expect(spendable).toBe(1);
      expect(snapshot.grants.map(grant => grant.consumed)).toEqual([0, 1]);

      const second = await consumeOfflineAllocation(
        db,
        consumption('op-2'),
        ACTIVE,
      );
      expect(second.receipt.grantId).toBe(GRANT_ID_2);
      expect(second.receipt.ticket?.ticketId).toBe(TICKETS[1]);

      for (const operation of ['op-3', 'op-4']) {
        const exhausted = await failure(
          consumeOfflineAllocation(db, consumption(operation), ACTIVE),
        );
        expect(exhausted.code).toBe('offline.allocation_exhausted');
      }
      const olderExhausted = await failure(
        consumeOfflineAllocation(db, consumption('op-5', GRANT_ID), ACTIVE),
      );
      expect(olderExhausted.code).toBe('offline.allocation_exhausted');

      const pending = await pendingOfflineReceipts(db);
      const spent = pending.map(receipt => receipt.ticket?.ticketId);
      expect(spent).toHaveLength(2);
      expect(new Set(spent).size).toBe(2);
      expect(handle.count('offline_receipt', OWNER)).toBe(2);
    });

    it('a newer generation restating an unspent ticket after the older receipt settled never doubles it', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const first = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      await settleOfflineReceipt(
        db,
        first.receipt.receiptId,
        'accepted',
        ACTIVE,
      );
      await holdOfflineGrant(db, restatedGrant([TICKETS[1]]), BINDING);

      const second = await consumeOfflineAllocation(
        db,
        consumption('op-2'),
        ACTIVE,
      );
      expect(second.receipt.ticket?.ticketId).toBe(TICKETS[1]);
      const third = await failure(
        consumeOfflineAllocation(db, consumption('op-3'), ACTIVE),
      );
      expect(third.code).toBe('offline.allocation_exhausted');
      const olderThird = await failure(
        consumeOfflineAllocation(db, consumption('op-4', GRANT_ID), ACTIVE),
      );
      expect(olderThird.code).toBe('offline.allocation_exhausted');
      expect(handle.count('offline_receipt', OWNER)).toBe(2);
    });

    it('the snapshot never reports more spendable tickets than distinct unconsumed ticket ids', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      await consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);
      await holdOfflineGrant(db, restatedGrant(TICKETS), BINDING);
      // Holding the same restatement again is a replay, not a refill.
      await holdOfflineGrant(db, restatedGrant(TICKETS), BINDING);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.grants).toHaveLength(2);
      const spendable = snapshot.grants.reduce(
        (sum, grant) => sum + grant.remaining,
        0,
      );
      expect(spendable).toBeLessThanOrEqual(1);
      expect(snapshot.spendableTickets).toBe(1);
      expect(snapshot.consumedTickets).toBe(1);
      expect(handle.count('offline_ticket', OWNER)).toBe(2);
    });

    it('holding a restated ticket and the consumption that spends it agree under process death', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'w04-offline-gen-'));
      const path = join(dir, 'wallet.db');
      try {
        handle.close();
        handle = createSqliteTestDb(path);
        await holdOfflineGrant(handle.db, issuedGrant(), BINDING);
        await consumeOfflineAllocation(handle.db, consumption('op-1'), ACTIVE);
        await holdOfflineGrant(handle.db, restatedGrant(TICKETS), BINDING);
        handle.close();
        handle = createSqliteTestDb(path);
        const reopened = await readOfflineAllocation(handle.db, ACTIVE);
        expect(reopened.spendableTickets).toBe(1);
        const consumed = await consumeOfflineAllocation(
          handle.db,
          consumption('op-2'),
          ACTIVE,
        );
        expect(consumed.receipt.ticket?.ticketId).toBe(TICKETS[1]);
        const exhausted = await failure(
          consumeOfflineAllocation(handle.db, consumption('op-3'), ACTIVE),
        );
        expect(exhausted.code).toBe('offline.allocation_exhausted');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('a HELD verdict is not terminal', () => {
    it('keeps the receipt reconcilable and still accepts a later terminal verdict', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const consumed = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      const receiptId = consumed.receipt.receiptId;
      const held = await settleOfflineReceipt(db, receiptId, 'held', ACTIVE);
      expect(held.settlement).toBe('held');
      expect(held.settledAt).toBeNull();

      const pending = await pendingOfflineReceipts(db);
      expect(pending.map(receipt => receipt.receiptId)).toEqual([receiptId]);
      expect(pending[0]?.settlement).toBe('held');
      expect((await readOfflineAllocation(db, ACTIVE)).pendingReceipts).toBe(1);

      // Re-presenting an ambiguous receipt may leave it held again.
      const heldAgain = await settleOfflineReceipt(
        db,
        receiptId,
        'held',
        ACTIVE,
      );
      expect(heldAgain.settledAt).toBeNull();

      const accepted = await settleOfflineReceipt(
        db,
        receiptId,
        'accepted',
        ACTIVE,
      );
      expect(accepted.settlement).toBe('accepted');
      expect(accepted.settledAt).toBe(
        new Date(ACTIVE.wallClockMs).toISOString(),
      );
      expect(await pendingOfflineReceipts(db)).toEqual([]);
      const twice = await failure(
        settleOfflineReceipt(db, receiptId, 'held', ACTIVE),
      );
      expect(twice.code).toBe('offline.receipt_settled');
      // The held → refused path is equally open.
      const second = await consumeOfflineAllocation(
        db,
        consumption('op-2'),
        ACTIVE,
      );
      await settleOfflineReceipt(db, second.receipt.receiptId, 'held', ACTIVE);
      const refused = await settleOfflineReceipt(
        db,
        second.receipt.receiptId,
        'refused',
        ACTIVE,
      );
      expect(refused.settlement).toBe('refused');
      expect(refused.settledAt).not.toBeNull();
      // The consumed tickets stay consumed whatever the verdict.
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.grants[0]).toMatchObject({ remaining: 0, consumed: 2 });
    });
  });

  describe('a replay with a conflicting result is refused', () => {
    it('never acknowledges a different result under the original operation id', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const first = await consumeOfflineAllocation(
        db,
        {
          operationId: 'op-1',
          resultId: 'result-A',
          fullOutputSha256: RESULT_SHA,
        },
        ACTIVE,
      );
      const conflicting = [
        { resultId: 'result-B', fullOutputSha256: OTHER_RESULT_SHA },
        { resultId: 'result-B', fullOutputSha256: RESULT_SHA },
        { resultId: 'result-A', fullOutputSha256: OTHER_RESULT_SHA },
        {
          resultId: 'result-A',
          fullOutputSha256: RESULT_SHA,
          grantId: GRANT_ID_2,
        },
      ];
      for (const binding of conflicting) {
        const error = await failure(
          consumeOfflineAllocation(
            db,
            { operationId: 'op-1', ...binding },
            ACTIVE,
          ),
        );
        expect(error.code).toBe('offline.receipt_conflict');
      }
      // Nothing was spent for the conflicting results and the original
      // receipt is untouched.
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.grants[0]).toMatchObject({ remaining: 1, consumed: 1 });
      expect(await pendingOfflineReceipts(db)).toEqual([first.receipt]);

      // The faithful replay is still idempotent.
      const replay = await consumeOfflineAllocation(
        db,
        {
          operationId: 'op-1',
          resultId: 'result-A',
          fullOutputSha256: RESULT_SHA,
          grantId: GRANT_ID,
        },
        ACTIVE,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.receipt).toEqual(first.receipt);
    });
  });

  describe('queued receipts are reconciled with the server', () => {
    let route: ReturnType<typeof mockReceiptsRoute> | null = null;

    afterEach(() => {
      route?.spy.mockRestore();
      route = null;
    });

    function client() {
      return createOfflineGrantClient({
        baseUrl: ISSUER,
        token: 'access-token',
      });
    }

    it('submits every pending receipt and applies each verdict exactly as the server states it', async () => {
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
      route = mockReceiptsRoute(submitted =>
        recorded(submitted, receiptId =>
          receiptId === first.receipt.receiptId
            ? 'result_recorded'
            : 'reconciliation_required',
        ),
      );
      const outcome = await reconcileOfflineReceipts(db, client(), ACTIVE);
      expect(outcome).toEqual({
        submitted: 2,
        accepted: 1,
        held: 1,
        refused: 0,
        pending: 1,
      });
      expect(route.calls.map(call => call.url)).toEqual([RECEIPTS_ROUTE]);
      const submitted = route.calls[0]!.body.receipts!;
      expect(submitted.map(receipt => receipt['receiptId'])).toEqual([
        first.receipt.receiptId,
        second.receipt.receiptId,
      ]);
      expect(submitted[0]).toMatchObject({
        ownerId: OWNER,
        grantId: GRANT_ID,
        operationId: 'op-1',
        resultId: 'result-op-1',
        fullOutputSha256: RESULT_SHA,
        ticket: { ticketId: TICKETS[0] },
      });

      // The held receipt is re-presented on the next drain and settles then.
      const pending = await pendingOfflineReceipts(db);
      expect(pending.map(receipt => receipt.receiptId)).toEqual([
        second.receipt.receiptId,
      ]);
      expect(pending[0]?.settlement).toBe('held');
      route.spy.mockRestore();
      route = mockReceiptsRoute(submitted => ({
        receipts: [],
        rejected: submitted.map(receipt => ({
          receiptId: receipt['receiptId'],
          code: 'offline.ticket_consumed',
        })),
      }));
      const again = await reconcileOfflineReceipts(db, client(), ACTIVE);
      expect(again).toEqual({
        submitted: 1,
        accepted: 0,
        held: 0,
        refused: 1,
        pending: 0,
      });
      expect(await pendingOfflineReceipts(db)).toEqual([]);
      // Settlement never touches the allocation: both tickets stay consumed.
      const snapshot = await readOfflineAllocation(db, ACTIVE);
      expect(snapshot.grants[0]).toMatchObject({ remaining: 0, consumed: 2 });
      expect(handle.count('offline_receipt', OWNER)).toBe(2);
    });

    it('does not call the server when nothing is pending', async () => {
      route = mockReceiptsRoute(() => ({ receipts: [], rejected: [] }));
      const outcome = await reconcileOfflineReceipts(db, client(), ACTIVE);
      expect(outcome).toEqual({
        submitted: 0,
        accepted: 0,
        held: 0,
        refused: 0,
        pending: 0,
      });
      expect(route.calls).toEqual([]);
    });

    it('a lost connection or an unreadable answer settles nothing and keeps every receipt queued', async () => {
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const consumed = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      const offline = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new TypeError('Network request failed'));
      await expect(
        reconcileOfflineReceipts(db, client(), ACTIVE),
      ).rejects.toThrow('Network request failed');
      offline.mockRestore();
      expect(await pendingOfflineReceipts(db)).toEqual([consumed.receipt]);

      // An answer that does not name every submitted receipt exactly once
      // is unreadable: no receipt may be settled from it.
      route = mockReceiptsRoute(() => ({
        receipts: [{ receiptId: 'someone-else', status: 'result_recorded' }],
        rejected: [],
      }));
      const unreadable = await reconcileOfflineReceipts(
        db,
        client(),
        ACTIVE,
      ).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(unreadable).toBeInstanceOf(ApiError);
      expect((unreadable as ApiError).code).toBe('network.invalid_response');
      expect(await pendingOfflineReceipts(db)).toEqual([consumed.receipt]);

      // A route the server does not serve yet is a typed failure, not a
      // verdict.
      route.spy.mockRestore();
      route = mockReceiptsRoute(
        () =>
          new Response(JSON.stringify({ error: 'not_found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const missing = await reconcileOfflineReceipts(db, client(), ACTIVE).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(missing).toBeInstanceOf(ApiError);
      expect((missing as ApiError).status).toBe(404);
      expect(await pendingOfflineReceipts(db)).toEqual([consumed.receipt]);
      expect((await readOfflineAllocation(db, ACTIVE)).grants[0]).toMatchObject(
        { remaining: 1, consumed: 1 },
      );
    });

    it('the sync runtime drains queued receipts for the signed-in owner', async () => {
      const session = {
        apiBaseUrl: ISSUER,
        bearerToken: 'access-token',
        canonicalAppUserId: OWNER,
        provider: 'apple' as const,
      };
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      const consumed = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      route = mockReceiptsRoute(submitted =>
        recorded(submitted, () => 'result_recorded'),
      );
      (getDb as jest.Mock).mockReturnValue(db);
      establishApiSession(session);
      try {
        configureSyncRuntime(session);
        await triggerOutboxSync();
        const receiptCalls = route.calls.filter(
          call => call.url === RECEIPTS_ROUTE,
        );
        expect(receiptCalls).toHaveLength(1);
        expect(
          receiptCalls[0]!.body.receipts!.map(receipt => receipt['receiptId']),
        ).toEqual([consumed.receipt.receiptId]);
        expect(await pendingOfflineReceipts(db)).toEqual([]);

        // Nothing pending: the next drain does not call the receipts route.
        await triggerOutboxSync();
        expect(
          route.calls.filter(call => call.url === RECEIPTS_ROUTE),
        ).toHaveLength(1);

        // A different owner's runtime never presents this owner's receipts.
        const second = await consumeOfflineAllocation(
          db,
          consumption('op-2'),
          ACTIVE,
        );
        clearSyncRuntime();
        setActiveDataOwner(OTHER_OWNER);
        establishApiSession({ ...session, canonicalAppUserId: OTHER_OWNER });
        configureSyncRuntime({ ...session, canonicalAppUserId: OTHER_OWNER });
        await triggerOutboxSync();
        expect(
          route.calls.filter(call => call.url === RECEIPTS_ROUTE),
        ).toHaveLength(1);
        setActiveDataOwner(OWNER);
        expect(await pendingOfflineReceipts(db)).toEqual([second.receipt]);
      } finally {
        clearSyncRuntime();
        clearApiSession();
        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        (getDb as jest.Mock).mockReset();
      }
    });
  });

  it('requests a grant from the API and holds it in one step', async () => {
    const response = grantResponse();
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer access-token',
        );
        const body = url.endsWith('/v1/devices/register')
          ? {
              device: {
                deviceId: 'dddddddd-0000-4000-8000-000000000001',
                installationKeyId: INSTALLATION_KEY,
                attestationEnvironment: 'production',
                attestationState: 'unattested',
              },
            }
          : response;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
    try {
      const client = createOfflineGrantClient({
        baseUrl: ISSUER,
        token: 'access-token',
      });
      const device = await client.registerDevice({
        installationKeyId: INSTALLATION_KEY,
        attestationEnvironment: 'production',
      });
      expect(device.attestationState).toBe('unattested');
      const held = await requestOfflineGrant(db, client, {
        installationKeyId: INSTALLATION_KEY,
        requestedTickets: 2,
      });
      expect(held.grantId).toBe(GRANT_ID);
      expect(held.remaining).toBe(2);
      expect(calls.map(call => call.url)).toEqual([
        `${ISSUER}/v1/devices/register`,
        `${ISSUER}/v1/offline/grants`,
      ]);
      expect(calls[1]?.body).toEqual({
        installationKeyId: INSTALLATION_KEY,
        requestedTickets: 2,
      });
      expect(handle.count('offline_grant', OWNER)).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a malformed grant response from the API is an unreadable answer, not a grant', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ grantId: GRANT_ID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const client = createOfflineGrantClient({
        baseUrl: ISSUER,
        token: 'access-token',
      });
      const error = await client
        .issueGrant({
          installationKeyId: INSTALLATION_KEY,
          requestedTickets: 2,
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('network.invalid_response');
      expect(handle.count('offline_grant', OWNER)).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
