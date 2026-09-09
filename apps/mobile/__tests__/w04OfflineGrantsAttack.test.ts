/**
 * W04-05 adversarial suite (attack branch devin/pp/w04-05/attack-5e07095a).
 *
 * Every test asserts the behaviour the work package promises — allocation is
 * not consumption, one allocated ticket pays for at most one result, receipts
 * are durable and reconcilable, unknown state is a typed error — at a failure
 * boundary the candidate's own suite does not exercise. A failing test here
 * is a confirmed break of the candidate, not of this file.
 */
import { createHash } from 'node:crypto';
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
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
} from '@pickle/shared-types';
import {
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
  type OfflineGrantClient,
} from '../src/data/api';
import {
  OfflineGrantError,
  consumeOfflineAllocation,
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
  requestOfflineGrant,
  settleOfflineReceipt,
  type OfflineConsumption,
} from '../src/data/offlineCapabilities';
import type { LocalDb } from '../src/data/db';
import {
  DataOwnerChangedError,
  setActiveDataOwner,
} from '../src/data/accountScope';
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
const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const TICKETS = [T1, T2];
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const GRANT_ID_2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const RESULT_SHA = 'c'.repeat(64);
const OTHER_RESULT_SHA = 'd'.repeat(64);

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
  /** Pro lease kind; `lifetime` carries a null entitlement expiry. */
  lease?: 'subscription' | 'lifetime';
  entitlementExpiresAt?: number | null;
  response?: (raw: Record<string, unknown>) => void;
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
  const leaseKind = fixture.lease ?? 'subscription';
  const entitlementExpiresAt = fixture.pro
    ? leaseKind === 'lifetime'
      ? null
      : (fixture.entitlementExpiresAt ?? expiresAt + 3600)
    : null;
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
            kind: leaseKind,
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

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorCode(outcome: Settled<unknown>): string | null {
  if (outcome.ok) return null;
  return outcome.error instanceof OfflineGrantError
    ? outcome.error.code
    : `unexpected:${String(outcome.error)}`;
}

async function failure(promise: Promise<unknown>): Promise<OfflineGrantError> {
  const outcome = await settle(promise);
  if (outcome.ok) throw new Error('expected the operation to fail');
  if (outcome.error instanceof OfflineGrantError) return outcome.error;
  throw outcome.error;
}

function consumption(
  operationId: string,
  overrides: Partial<{
    resultId: string;
    fullOutputSha256: string;
    grantId: string;
  }> = {},
) {
  return {
    operationId,
    resultId: `result-${operationId}`,
    fullOutputSha256: RESULT_SHA,
    ...overrides,
  };
}

function ticketIdsOf(receipts: ReadonlyArray<OfflineConsumption['receipt']>) {
  return receipts.map(receipt => receipt.ticket?.ticketId ?? null);
}

describe('W04-05 attack: concurrency and reentrancy', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => {
    handle.observeStatements(null);
    handle.close();
    setActiveDataOwner(OWNER);
  });

  it('A1 double submit: two concurrent consumptions of the last ticket spend it exactly once', async () => {
    await holdOfflineGrant(db, issuedGrant({ ticketIds: [T1] }), BINDING);
    const [first, second] = await Promise.all([
      settle(consumeOfflineAllocation(db, consumption('op-a'), ACTIVE)),
      settle(consumeOfflineAllocation(db, consumption('op-b'), ACTIVE)),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(
      outcomes
        .filter(outcome => !outcome.ok)
        .map(outcome => errorCode(outcome)),
    ).toEqual(['offline.allocation_exhausted']);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({
      remaining: 0,
      consumed: 1,
      lifecycleSequence: 1,
    });
  });

  it('A2 concurrent replay: the same operation id submitted twice at once yields one receipt and one decrement', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const outcomes = await Promise.all([
      settle(consumeOfflineAllocation(db, consumption('op-1'), ACTIVE)),
      settle(consumeOfflineAllocation(db, consumption('op-1'), ACTIVE)),
      settle(consumeOfflineAllocation(db, consumption('op-1'), ACTIVE)),
    ]);
    const fulfilled = outcomes.flatMap(outcome =>
      outcome.ok ? [outcome.value] : [],
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.filter(value => !value.replayed)).toHaveLength(1);
    expect(new Set(fulfilled.map(value => value.receipt.receiptId)).size).toBe(
      1,
    );
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 1, consumed: 1 });
  });

  it('A3 conflicting replay: an operation id resubmitted with a different result is not acknowledged as paid', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const original = await consumeOfflineAllocation(
      db,
      consumption('op-1', { resultId: 'result-A' }),
      ACTIVE,
    );
    expect(original.replayed).toBe(false);
    const conflicting = await settle(
      consumeOfflineAllocation(
        db,
        consumption('op-1', {
          resultId: 'result-B',
          fullOutputSha256: OTHER_RESULT_SHA,
        }),
        ACTIVE,
      ),
    );
    // Either outcome is acceptable: a typed refusal, or a receipt that pays
    // for the result actually submitted. A receipt for result-A returned as
    // the settlement of result-B is an ambiguous commitment reported as paid.
    if (conflicting.ok) {
      expect(conflicting.value.receipt.resultId).toBe('result-B');
      expect(conflicting.value.receipt.fullOutputSha256).toBe(OTHER_RESULT_SHA);
    } else {
      expect(conflicting.error).toBeInstanceOf(OfflineGrantError);
    }
    // Whatever the answer, nothing was spent twice.
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 1, consumed: 1 });
  });

  it('A4 interleaved account switch between the decrement and the receipt insert rolls the spend back', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    handle.observeStatements(call => {
      if (call.sql.includes('UPDATE offline_grant')) {
        setActiveDataOwner(OTHER_OWNER);
      }
    });
    const outcome = await settle(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    handle.observeStatements(null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(DataOwnerChangedError);
    }
    // The new owner inherits nothing.
    expect((await readOfflineAllocation(db, ACTIVE)).grants).toEqual([]);
    expect(await pendingOfflineReceipts(db)).toEqual([]);
    // The original owner's allocation is untouched: no orphan decrement, no
    // half-written receipt.
    setActiveDataOwner(OWNER);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({
      remaining: 2,
      consumed: 0,
      lifecycleSequence: 0,
    });
    expect(handle.count('offline_receipt', OWNER)).toBe(0);
    expect(handle.count('offline_receipt', OTHER_OWNER)).toBe(0);
  });

  it('A5 account switch between issuance and hold: the grant is refused and persisted for nobody', async () => {
    const client: OfflineGrantClient = {
      issuer: ISSUER,
      registerDevice: () => Promise.reject(new Error('not exercised')),
      issueGrant: async () => {
        setActiveDataOwner(OTHER_OWNER);
        return issuedGrant();
      },
    };
    const error = await failure(
      requestOfflineGrant(db, client, {
        installationKeyId: INSTALLATION_KEY,
        requestedTickets: 2,
      }),
    );
    expect(error.code).toBe('offline.grant_invalid');
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    expect(handle.count('offline_grant', OTHER_OWNER)).toBe(0);
  });

  it('A6 crash after commit (acknowledgement lost): the spend is durable and the retry replays it', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    handle.failCommitOnce('after', 'INSERT INTO offline_receipt');
    const crashed = await settle(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    expect(crashed.ok).toBe(false);
    const afterCrash = await readOfflineAllocation(db, ACTIVE);
    expect(afterCrash.grants[0]).toMatchObject({ remaining: 1, consumed: 1 });
    expect(afterCrash.pendingReceipts).toBe(1);
    const retry = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    expect(retry.replayed).toBe(true);
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
    expect(retry.grant).toMatchObject({ remaining: 1, consumed: 1 });
  });

  it('A7 crash before commit: nothing is spent and the retry is a fresh single spend', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    handle.failCommitOnce('before', 'INSERT INTO offline_receipt');
    const crashed = await settle(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    expect(crashed.ok).toBe(false);
    const afterCrash = await readOfflineAllocation(db, ACTIVE);
    expect(afterCrash.grants[0]).toMatchObject({ remaining: 2, consumed: 0 });
    expect(afterCrash.pendingReceipts).toBe(0);
    const retry = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    expect(retry.replayed).toBe(false);
    expect(retry.grant).toMatchObject({ remaining: 1, consumed: 1 });
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
  });

  it('A8 concurrent settlement of one receipt records exactly one verdict', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const { receipt } = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    const outcomes = await Promise.all([
      settle(settleOfflineReceipt(db, receipt.receiptId, 'accepted', ACTIVE)),
      settle(settleOfflineReceipt(db, receipt.receiptId, 'refused', ACTIVE)),
    ]);
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(
      outcomes
        .filter(outcome => !outcome.ok)
        .map(outcome => errorCode(outcome)),
    ).toEqual(['offline.receipt_settled']);
    const row = handle.native
      .prepare(
        `SELECT settlement FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      )
      .get(OWNER, receipt.receiptId);
    const winner = outcomes.find(outcome => outcome.ok);
    expect(winner && winner.ok ? winner.value.settlement : null).toBe(
      row?.['settlement'],
    );
  });
});

describe('W04-05 attack: settlement lifecycle', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => handle.close());

  it('B1 a HELD verdict is not terminal: the receipt stays reconcilable and can still be accepted or refused', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const { receipt } = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    const held = await settleOfflineReceipt(
      db,
      receipt.receiptId,
      'held',
      ACTIVE,
    );
    expect(held.settlement).toBe('held');
    // Ambiguous commitment => HOLD/recover. A held receipt is still owed a
    // final server verdict, so the device must keep presenting it for
    // reconciliation and must accept the final verdict when it arrives.
    const stillPending = await pendingOfflineReceipts(db);
    expect(stillPending.map(pending => pending.receiptId)).toEqual([
      receipt.receiptId,
    ]);
    const finalVerdict = await settle(
      settleOfflineReceipt(db, receipt.receiptId, 'accepted', ACTIVE),
    );
    expect(errorCode(finalVerdict)).toBeNull();
    // The allocation is never touched by any verdict.
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 1, consumed: 1 });
  });
});

describe('W04-05 attack: generations and free-rating conservation', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => handle.close());

  /** issue_offline_grant() (20260908160000_offline_device_grants.sql) answers
   * a new generation with `ticket_ids := v_outstanding || v_new`: every
   * ticket already allocated to this installation and not yet consumed or
   * released on the server is restated in the newer grant. A receipt the
   * device has not yet synced leaves its ticket outstanding server-side. */
  it('C1 a newer generation restating an unsettled ticket never makes that ticket spendable twice', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const first = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    expect(first.receipt.ticket?.ticketId).toBe(T1);
    // Device reconnects before op-1's receipt settles and asks for a fresh
    // 7-day grant: the server restates the outstanding tickets T1 and T2.
    await holdOfflineGrant(
      db,
      issuedGrant({
        grantId: GRANT_ID_2,
        generation: 2,
        ticketIds: [T1, T2],
        issuedAt: ISSUED_AT + 100,
        expiresAt: EXPIRES_AT + 100,
      }),
      BINDING,
    );
    // The identity's lifetime budget is two tickets; one is already spent.
    // Exactly one more result may be paid for on this device.
    const second = await settle(
      consumeOfflineAllocation(db, consumption('op-2'), ACTIVE),
    );
    const third = await settle(
      consumeOfflineAllocation(db, consumption('op-3'), ACTIVE),
    );
    const fourth = await settle(
      consumeOfflineAllocation(db, consumption('op-4'), ACTIVE),
    );
    const receipts = await pendingOfflineReceipts(db);
    const spentTickets = ticketIdsOf(receipts);
    expect(new Set(spentTickets).size).toBe(spentTickets.length);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.receipt.ticket?.ticketId).toBe(T2);
    expect(errorCode(third)).toBe('offline.allocation_exhausted');
    expect(errorCode(fourth)).toBe('offline.allocation_exhausted');
    expect(receipts).toHaveLength(2);
  });

  it('C2 a newer generation restating an unspent ticket after the older receipt settled never doubles it', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const first = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    await settleOfflineReceipt(db, first.receipt.receiptId, 'accepted', ACTIVE);
    // T1 is consumed server-side; T2 is still outstanding and is restated.
    await holdOfflineGrant(
      db,
      issuedGrant({
        grantId: GRANT_ID_2,
        generation: 2,
        ticketIds: [T2],
        issuedAt: ISSUED_AT + 100,
        expiresAt: EXPIRES_AT + 100,
      }),
      BINDING,
    );
    const second = await settle(
      consumeOfflineAllocation(db, consumption('op-2'), ACTIVE),
    );
    const third = await settle(
      consumeOfflineAllocation(db, consumption('op-3'), ACTIVE),
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.receipt.ticket?.ticketId).toBe(T2);
    expect(errorCode(third)).toBe('offline.allocation_exhausted');
    const allReceipts = handle.native
      .prepare(`SELECT receipt FROM offline_receipt WHERE owner_key = ?`)
      .all(OWNER)
      .map(row => JSON.parse(String(row['receipt'])) as { ticket: unknown });
    const tickets = allReceipts.map(
      receipt => (receipt.ticket as { ticketId: string }).ticketId,
    );
    expect(tickets.sort()).toEqual([T1, T2]);
  });

  it('C3 the allocation snapshot never reports more spendable tickets than the identity holds', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    await consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);
    await holdOfflineGrant(
      db,
      issuedGrant({
        grantId: GRANT_ID_2,
        generation: 2,
        ticketIds: [T1, T2],
        issuedAt: ISSUED_AT + 100,
        expiresAt: EXPIRES_AT + 100,
      }),
      BINDING,
    );
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    const spendable = snapshot.grants
      .filter(grant => grant.execution.kind === 'active')
      .reduce((total, grant) => total + grant.remaining, 0);
    // Two lifetime tickets, one already spent: at most one is spendable.
    expect(spendable).toBeLessThanOrEqual(1);
  });
});

describe('W04-05 attack: boundary values and clocks', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => handle.close());

  async function expectUnspent(): Promise<void> {
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 2, consumed: 0 });
    expect(handle.count('offline_receipt', OWNER)).toBe(0);
  }

  it('D1 a non-finite trusted-time reading is refused, never treated as an active lease', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const clocks: Array<[string, TrustedTimeReading]> = [
      ['NaN nowMs', reading(Number.NaN, { wallClockMs: ACTIVE.wallClockMs })],
      [
        '-Infinity nowMs',
        reading(Number.NEGATIVE_INFINITY, { wallClockMs: ACTIVE.wallClockMs }),
      ],
      [
        '+Infinity nowMs',
        reading(Number.POSITIVE_INFINITY, { wallClockMs: ACTIVE.wallClockMs }),
      ],
      ['NaN wallClockMs', reading(ACTIVE.nowMs, { wallClockMs: Number.NaN })],
    ];
    const observed: Array<[string, string]> = [];
    for (const [index, [label, clock]] of clocks.entries()) {
      const outcome = await settle(
        consumeOfflineAllocation(db, consumption(`op-${index}`), clock),
      );
      observed.push([
        label,
        outcome.ok
          ? `consumed ticket ${outcome.value.receipt.ticket?.ticketId ?? 'none'}`
          : (errorCode(outcome) ?? 'unknown'),
      ]);
    }
    expect(observed).toEqual(
      clocks.map(([label]) => [label, 'offline.time_reconcile_required']),
    );
    await expectUnspent();
  });

  it('D2 the lease is exclusive at exp and inclusive just before it', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const atExpiry = await failure(
      consumeOfflineAllocation(
        db,
        consumption('op-at-exp'),
        reading(EXPIRES_AT * 1000),
      ),
    );
    expect(atExpiry.code).toBe('offline.grant_expired');
    await expectUnspent();
    const justBefore = await consumeOfflineAllocation(
      db,
      consumption('op-before-exp'),
      reading(EXPIRES_AT * 1000 - 1),
    );
    expect(justBefore.grant.remaining).toBe(1);
  });

  it('D3 far-past, far-future, rolled-back, floor-only and unmeasured clocks never spend', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const cases: Array<[string, TrustedTimeReading, string]> = [
      ['epoch zero', reading(0), 'offline.time_reconcile_required'],
      ['negative clock', reading(-1), 'offline.time_reconcile_required'],
      ['year 9999', reading(253_402_300_799_000), 'offline.grant_expired'],
      [
        'rollback',
        reading(ACTIVE.nowMs, { rollbackDetected: true }),
        'offline.time_reconcile_required',
      ],
      [
        'floor only',
        reading(ACTIVE.nowMs, { authority: 'floor' }),
        'offline.time_reconcile_required',
      ],
      [
        'unmeasured elapsed',
        reading(ACTIVE.nowMs, {
          authority: 'floor',
          continuity: 'unmeasured',
        }),
        'offline.time_reconcile_required',
      ],
      [
        'no authority, invalid storage',
        reading(ACTIVE.nowMs, { authority: 'none', storage: 'invalid' }),
        'offline.time_reconcile_required',
      ],
    ];
    for (const [index, [label, clock, code]] of cases.entries()) {
      const error = await failure(
        consumeOfflineAllocation(db, consumption(`op-${index}`), clock),
      );
      expect([label, error.code]).toEqual([label, code]);
    }
    await expectUnspent();
  });

  it('D4 malformed consumption inputs are refused before any read or write', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const inputs = [
      consumption(''),
      consumption(' op-1'),
      consumption('a'.repeat(129)),
      consumption('op-1', { resultId: '' }),
      consumption('op-1', { fullOutputSha256: RESULT_SHA.toUpperCase() }),
      consumption('op-1', { fullOutputSha256: RESULT_SHA.slice(0, 63) }),
      consumption('op-1', { fullOutputSha256: `${RESULT_SHA}0` }),
      consumption('op-1', { grantId: '' }),
      consumption('op-1', { grantId: 'grant id with spaces' }),
    ];
    for (const input of inputs) {
      const error = await failure(consumeOfflineAllocation(db, input, ACTIVE));
      expect(error.code).toBe('offline.result_invalid');
    }
    await expectUnspent();
  });

  it('D5 grant lease bounds: exactly seven days holds, one second more is refused', async () => {
    const sevenDays = issuedGrant({
      expiresAt: ISSUED_AT + OFFLINE_PRO_LEASE_MAX_SECONDS,
    });
    const held = await holdOfflineGrant(db, sevenDays, BINDING);
    expect(held.expiresAt - held.issuedAt).toBe(OFFLINE_PRO_LEASE_MAX_SECONDS);
    const tooLong = await failure(
      holdOfflineGrant(
        db,
        issuedGrant({
          grantId: GRANT_ID_2,
          expiresAt: ISSUED_AT + OFFLINE_PRO_LEASE_MAX_SECONDS + 1,
        }),
        BINDING,
      ),
    );
    expect(tooLong.code).toBe('offline.grant_invalid');
    expect(handle.count('offline_grant', OWNER)).toBe(1);
  });

  it('D6 a Pro lease may end exactly at the verified entitlement expiry but not after it', async () => {
    const exact = issuedGrant({
      pro: true,
      entitlementExpiresAt: EXPIRES_AT,
    });
    const held = await holdOfflineGrant(db, exact, BINDING);
    expect(held.entitlementExpiresAt).toBe(EXPIRES_AT);
    const past = parseIssuedOfflineGrant(
      grantResponse({
        pro: true,
        grantId: GRANT_ID_2,
        entitlementExpiresAt: EXPIRES_AT - 1,
      }),
    );
    if (!past) throw new Error('fixture must parse');
    const error = await failure(holdOfflineGrant(db, past, BINDING));
    expect(error.code).toBe('offline.grant_invalid');
  });

  it('D7 response fields that are not integers or are out of range are not a grant', () => {
    const mutations: Array<(raw: Record<string, unknown>) => void> = [
      raw => (raw['generation'] = 0),
      raw => (raw['generation'] = -1),
      raw => (raw['generation'] = 1.5),
      raw => (raw['generation'] = Number.NaN),
      raw => (raw['issuedAt'] = -1),
      raw => (raw['expiresAt'] = Number.POSITIVE_INFINITY),
      raw => (raw['issuedAt'] = String(ISSUED_AT)),
      raw => (raw['ticketIds'] = [T1, '']),
      raw => (raw['ticketIds'] = 'not-a-list'),
      raw => (raw['keyId'] = ''),
      raw => (raw['grant'] = null),
    ];
    for (const mutate of mutations) {
      expect(parseIssuedOfflineGrant(grantResponse({ response: mutate }))).toBe(
        null,
      );
    }
  });
});

describe('W04-05 attack: corrupt and partial persisted state', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => handle.close());

  async function spendOne(): Promise<OfflineConsumption> {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    return consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);
  }

  it('E1 a receipt with a verdict but no settlement time is corrupt, not pending and not settled', async () => {
    const { receipt } = await spendOne();
    handle.native
      .prepare(
        `UPDATE offline_receipt SET settlement = 'accepted' WHERE receipt_id = ?`,
      )
      .run(receipt.receiptId);
    const pending = await failure(pendingOfflineReceipts(db));
    expect(pending.code).toBe('offline.wallet_corrupt');
    const resettle = await failure(
      settleOfflineReceipt(db, receipt.receiptId, 'accepted', ACTIVE),
    );
    expect(resettle.code).toBe('offline.wallet_corrupt');
  });

  it('E2 a receipt whose indexed columns disagree with its serialized body is corrupt on replay', async () => {
    const { receipt } = await spendOne();
    handle.native
      .prepare(
        `UPDATE offline_receipt SET operation_id = 'op-2' WHERE receipt_id = ?`,
      )
      .run(receipt.receiptId);
    const replay = await failure(
      consumeOfflineAllocation(db, consumption('op-2'), ACTIVE),
    );
    expect(replay.code).toBe('offline.wallet_corrupt');
    // No second decrement happened while refusing.
    const row = handle.native
      .prepare(
        `SELECT remaining_ticket_ids, lifecycle_sequence FROM offline_grant WHERE owner_key = ?`,
      )
      .get(OWNER);
    expect(row).toEqual({
      remaining_ticket_ids: JSON.stringify([T2]),
      lifecycle_sequence: 1,
    });
  });

  it('E3 a receipt whose grant row vanished is corrupt on replay and never a fresh spend', async () => {
    await spendOne();
    handle.native
      .prepare(`DELETE FROM offline_grant WHERE owner_key = ?`)
      .run(OWNER);
    const replay = await failure(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    expect(replay.code).toBe('offline.wallet_corrupt');
    const fresh = await failure(
      consumeOfflineAllocation(db, consumption('op-2'), ACTIVE),
    );
    expect(fresh.code).toBe('offline.grant_not_held');
    // The orphan receipt is still owed to the server.
    expect((await readOfflineAllocation(db, ACTIVE)).pendingReceipts).toBe(1);
    expect(await pendingOfflineReceipts(db)).toHaveLength(1);
  });

  it('E4 duplicated, refilled or resequenced ticket ledgers are corrupt, never authorization', async () => {
    await spendOne();
    const tamper = (sql: string, ...params: unknown[]) =>
      handle.native.prepare(sql).run(...(params as never[]));
    const cases: Array<[string, () => void]> = [
      [
        'duplicate remaining ticket',
        () =>
          tamper(
            `UPDATE offline_grant SET remaining_ticket_ids = ? WHERE owner_key = ?`,
            JSON.stringify([T2, T2]),
            OWNER,
          ),
      ],
      [
        'refilled without a lifecycle event',
        () =>
          tamper(
            `UPDATE offline_grant SET remaining_ticket_ids = ? WHERE owner_key = ?`,
            JSON.stringify([T1, T2]),
            OWNER,
          ),
      ],
      [
        'lifecycle sequence rewound',
        () =>
          tamper(
            `UPDATE offline_grant SET lifecycle_sequence = 0 WHERE owner_key = ?`,
            OWNER,
          ),
      ],
      [
        'grant hash mismatch',
        () =>
          tamper(
            `UPDATE offline_grant SET grant_jws_sha256 = ? WHERE owner_key = ?`,
            'e'.repeat(64),
            OWNER,
          ),
      ],
      [
        'allocation id dropped from a free grant',
        () =>
          tamper(
            `UPDATE offline_grant SET allocation_id = NULL WHERE owner_key = ?`,
            OWNER,
          ),
      ],
      [
        'generation zero',
        () =>
          tamper(
            `UPDATE offline_grant SET generation = 0 WHERE owner_key = ?`,
            OWNER,
          ),
      ],
      [
        'expiry not after issuance',
        () =>
          tamper(
            `UPDATE offline_grant SET expires_at = issued_at WHERE owner_key = ?`,
            OWNER,
          ),
      ],
    ];
    for (const [index, [label, apply]] of cases.entries()) {
      apply();
      const read = await failure(readOfflineAllocation(db, ACTIVE));
      expect([label, read.code]).toEqual([label, 'offline.wallet_corrupt']);
      const spend = await failure(
        consumeOfflineAllocation(db, consumption(`op-${index + 2}`), ACTIVE),
      );
      expect([label, spend.code]).toEqual([label, 'offline.wallet_corrupt']);
      // Restore the legitimate state for the next case.
      tamper(
        `UPDATE offline_grant SET remaining_ticket_ids = ?, lifecycle_sequence = 1,
           grant_jws_sha256 = ?, allocation_id = ?, generation = 1, expires_at = ?
         WHERE owner_key = ?`,
        JSON.stringify([T2]),
        sha256HexOfStored(handle, OWNER),
        GRANT_ID,
        EXPIRES_AT,
        OWNER,
      );
    }
    expect(handle.count('offline_receipt', OWNER)).toBe(1);
  });

  it('E5 a Pro lease row carrying tickets is corrupt', async () => {
    await holdOfflineGrant(db, issuedGrant({ pro: true }), BINDING);
    handle.native
      .prepare(
        `UPDATE offline_grant SET allocated_ticket_ids = ?, remaining_ticket_ids = ? WHERE owner_key = ?`,
      )
      .run(JSON.stringify([T1]), JSON.stringify([T1]), OWNER);
    const read = await failure(readOfflineAllocation(db, ACTIVE));
    expect(read.code).toBe('offline.wallet_corrupt');
    const spend = await failure(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    expect(spend.code).toBe('offline.wallet_corrupt');
    expect(handle.count('offline_receipt', OWNER)).toBe(0);
  });

  it('E6 a corrupt receipt row blocks the pending count rather than under-reporting it', async () => {
    const { receipt } = await spendOne();
    handle.native
      .prepare(`UPDATE offline_receipt SET receipt = '{}' WHERE receipt_id = ?`)
      .run(receipt.receiptId);
    // The count itself is still honest (one row, unsettled) …
    expect((await readOfflineAllocation(db, ACTIVE)).pendingReceipts).toBe(1);
    // … and reading the receipts is a typed error, not an empty queue.
    const pending = await failure(pendingOfflineReceipts(db));
    expect(pending.code).toBe('offline.wallet_corrupt');
  });
});

function sha256HexOfStored(
  handle: ReturnType<typeof createSqliteTestDb>,
  owner: string,
): string {
  const row = handle.native
    .prepare(`SELECT compact_jws FROM offline_grant WHERE owner_key = ?`)
    .get(owner);
  return createHash('sha256')
    .update(String(row?.['compact_jws']), 'utf8')
    .digest('hex');
}

describe('W04-05 attack: owners, roles and isolation', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => {
    handle.close();
    setActiveDataOwner(OWNER);
  });

  it('F1 another signed-in owner cannot spend, replay or settle the first owner wallet by naming its ids', async () => {
    await holdOfflineGrant(db, issuedGrant(), BINDING);
    const { receipt } = await consumeOfflineAllocation(
      db,
      consumption('op-1'),
      ACTIVE,
    );
    setActiveDataOwner(OTHER_OWNER);
    const byGrantId = await failure(
      consumeOfflineAllocation(
        db,
        consumption('op-2', { grantId: GRANT_ID }),
        ACTIVE,
      ),
    );
    expect(byGrantId.code).toBe('offline.grant_not_held');
    const replayLeak = await failure(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    expect(replayLeak.code).toBe('offline.grant_not_held');
    const settleLeak = await failure(
      settleOfflineReceipt(db, receipt.receiptId, 'refused', ACTIVE),
    );
    expect(settleLeak.code).toBe('offline.receipt_unknown');
    // The other owner may hold a grant that reuses the same grant id: its
    // row is its own and never merges with the first owner's ledger.
    await holdOfflineGrant(db, issuedGrant({ ownerId: OTHER_OWNER }), BINDING);
    expect(handle.count('offline_grant', OTHER_OWNER)).toBe(1);
    setActiveDataOwner(OWNER);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants).toHaveLength(1);
    expect(snapshot.grants[0]).toMatchObject({ remaining: 1, consumed: 1 });
    expect(snapshot.pendingReceipts).toBe(1);
    const pending = await pendingOfflineReceipts(db);
    expect(pending.map(item => item.receiptId)).toEqual([receipt.receiptId]);
    expect(pending[0]?.settlement).toBeNull();
  });

  it('F2 the guest bucket can neither hold nor spend and sees an empty, unsettleable wallet', async () => {
    setActiveDataOwner('device-guest');
    const hold = await failure(holdOfflineGrant(db, issuedGrant(), BINDING));
    expect(hold.code).toBe('offline.owner_unsigned');
    const spend = await failure(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    expect(spend.code).toBe('offline.owner_unsigned');
    expect((await readOfflineAllocation(db, ACTIVE)).grants).toEqual([]);
    const settleUnknown = await failure(
      settleOfflineReceipt(db, 'receipt-1', 'accepted', ACTIVE),
    );
    expect(settleUnknown.code).toBe('offline.receipt_unknown');
    expect(handle.count('offline_grant', 'device-guest')).toBe(0);
  });

  it('F3 a signed-out process has no readable or writable wallet', async () => {
    setActiveDataOwner('signed-out');
    const hold = await failure(holdOfflineGrant(db, issuedGrant(), BINDING));
    expect(hold.code).toBe('offline.owner_unsigned');
    const spend = await failure(
      consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
    );
    expect(spend.code).toBe('offline.owner_unsigned');
    await expect(readOfflineAllocation(db, ACTIVE)).rejects.toThrow();
    await expect(pendingOfflineReceipts(db)).rejects.toThrow();
    await expect(
      settleOfflineReceipt(db, 'receipt-1', 'accepted', ACTIVE),
    ).rejects.toThrow();
  });

  it('F4 a grant signed for another issuer or key never binds to this device', async () => {
    const wrongIssuer = await failure(
      holdOfflineGrant(db, issuedGrant(), {
        ...BINDING,
        issuer: 'https://evil.example.test/functions/v1/api',
      }),
    );
    expect(wrongIssuer.code).toBe('offline.grant_invalid');
    const wrongKey = await failure(
      holdOfflineGrant(
        db,
        issuedGrant({ response: raw => (raw['keyId'] = 'other-key') }),
        BINDING,
      ),
    );
    expect(wrongKey.code).toBe('offline.grant_invalid');
    const tamperedHeader = await failure(
      holdOfflineGrant(
        db,
        issuedGrant({
          response: raw => {
            const grant = raw['grant'] as { compactJws: string };
            const [, payload, signature] = grant.compactJws.split('.');
            const header = base64Url(
              JSON.stringify({
                alg: 'none',
                typ: OFFLINE_GRANT_JWS_TYPE,
                kid: KEY_ID,
              }),
            );
            grant.compactJws = `${header}.${payload}.${signature}`;
          },
        }),
        BINDING,
      ),
    );
    expect(tamperedHeader.code).toBe('offline.grant_invalid');
    expect(handle.count('offline_grant', OWNER)).toBe(0);
  });
});

describe('W04-05 attack: Pro lease kinds and restart', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => handle.close());

  it('G1 a lifetime Pro lease (null entitlement expiry) holds, executes without tickets and never exhausts', async () => {
    const lifetime = issuedGrant({ pro: true, lease: 'lifetime' });
    const held = await holdOfflineGrant(db, lifetime, BINDING);
    expect(held).toMatchObject({
      entitlementSource: 'verified_store',
      entitlementExpiresAt: null,
      allocated: 0,
      remaining: 0,
    });
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(
        await consumeOfflineAllocation(db, consumption(`op-${index}`), ACTIVE),
      );
    }
    expect(results.map(result => result.receipt.ticket)).toEqual([
      null,
      null,
      null,
    ]);
    expect(results.map(result => result.receipt.lifecycleSequence)).toEqual([
      1, 2, 3,
    ]);
    const snapshot = await readOfflineAllocation(db, ACTIVE);
    expect(snapshot.grants[0]).toMatchObject({
      lifecycleSequence: 3,
      execution: { kind: 'active' },
    });
    expect(snapshot.pendingReceipts).toBe(3);
  });

  it('G2 a lifetime lease restated with a non-null entitlement expiry is refused', async () => {
    const mismatched = parseIssuedOfflineGrant(
      grantResponse({
        pro: true,
        lease: 'lifetime',
        response: raw => (raw['entitlementExpiresAt'] = EXPIRES_AT + 3600),
      }),
    );
    if (!mismatched) throw new Error('fixture must parse');
    const error = await failure(holdOfflineGrant(db, mismatched, BINDING));
    expect(error.code).toBe('offline.grant_invalid');
  });

  it('G3 process death right after a lost commit acknowledgement leaves exactly one durable spend', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'w04-attack-'));
    const path = join(directory, 'wallet.sqlite');
    handle.close();
    try {
      handle = createSqliteTestDb(path);
      db = handle.db;
      await holdOfflineGrant(db, issuedGrant(), BINDING);
      handle.failCommitOnce('after', 'INSERT INTO offline_receipt');
      const crashed = await settle(
        consumeOfflineAllocation(db, consumption('op-1'), ACTIVE),
      );
      expect(crashed.ok).toBe(false);
      handle.close();

      handle = createSqliteTestDb(path);
      db = handle.db;
      const restarted = await readOfflineAllocation(db, ACTIVE);
      expect(restarted.grants[0]).toMatchObject({
        remaining: 1,
        consumed: 1,
        lifecycleSequence: 1,
      });
      expect(restarted.pendingReceipts).toBe(1);
      const replay = await consumeOfflineAllocation(
        db,
        consumption('op-1'),
        ACTIVE,
      );
      expect(replay.replayed).toBe(true);
      // After a cold start trusted time is floor-only: no new spend.
      const floorOnly = await failure(
        consumeOfflineAllocation(
          db,
          consumption('op-2'),
          reading(ACTIVE.nowMs, {
            authority: 'floor',
            continuity: 'persisted',
          }),
        ),
      );
      expect(floorOnly.code).toBe('offline.time_reconcile_required');
      expect(handle.count('offline_receipt', OWNER)).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('W04-05 attack: user-facing copy', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
  });

  afterEach(() => {
    handle.close();
    setActiveDataOwner(OWNER);
  });

  it('H1 every wallet error message avoids prohibited store-copy terms', async () => {
    const prohibited =
      /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|best|most accurate|ai coach/i;
    const messages: string[] = [];
    await holdOfflineGrant(db, issuedGrant({ ticketIds: [T1] }), BINDING);
    await consumeOfflineAllocation(db, consumption('op-1'), ACTIVE);
    messages.push(
      (await failure(consumeOfflineAllocation(db, consumption('op-2'), ACTIVE)))
        .message,
      (
        await failure(
          consumeOfflineAllocation(
            db,
            consumption('op-3'),
            reading((EXPIRES_AT + 1) * 1000),
          ),
        )
      ).message,
      (
        await failure(
          consumeOfflineAllocation(
            db,
            consumption('op-4'),
            reading(ACTIVE.nowMs, { authority: 'floor' }),
          ),
        )
      ).message,
      (await failure(consumeOfflineAllocation(db, consumption(''), ACTIVE)))
        .message,
      (await failure(settleOfflineReceipt(db, 'nope', 'accepted', ACTIVE)))
        .message,
      (
        await failure(
          holdOfflineGrant(db, issuedGrant({ ownerId: OTHER_OWNER }), BINDING),
        )
      ).message,
    );
    setActiveDataOwner('device-guest');
    messages.push(
      (await failure(consumeOfflineAllocation(db, consumption('op-5'), ACTIVE)))
        .message,
    );
    for (const message of messages) {
      expect(message).not.toMatch(prohibited);
      expect(message.trim().length).toBeGreaterThan(0);
    }
  });
});
