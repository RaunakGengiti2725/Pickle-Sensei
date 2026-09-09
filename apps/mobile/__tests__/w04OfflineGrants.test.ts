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
  requestOfflineGrant,
  settleOfflineReceipt,
} from '../src/data/offlineCapabilities';
import type { LocalDb } from '../src/data/db';
import { setActiveDataOwner } from '../src/data/accountScope';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import { createSqliteTestDb } from '../testSupport/sqlite';

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
const RESULT_SHA = 'c'.repeat(64);

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
    handle.native
      .prepare(
        `UPDATE offline_grant SET remaining_ticket_ids = ? WHERE owner_key = ?`,
      )
      .run('{not json', OWNER);
    const read = await failure(readOfflineAllocation(db, ACTIVE));
    expect(read.code).toBe('offline.wallet_corrupt');
    const consume = await failure(
      consumeOfflineAllocation(db, consumption('op-2'), ACTIVE),
    );
    expect(consume.code).toBe('offline.wallet_corrupt');
    expect(handle.count('offline_receipt', OWNER)).toBe(1);

    // A remaining list that is not a subset of the signed allocation is
    // tampering, not authorization.
    handle.native
      .prepare(
        `UPDATE offline_grant SET remaining_ticket_ids = ? WHERE owner_key = ?`,
      )
      .run(JSON.stringify([TICKETS[1], 'forged-ticket']), OWNER);
    const forged = await failure(readOfflineAllocation(db, ACTIVE));
    expect(forged.code).toBe('offline.wallet_corrupt');
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
