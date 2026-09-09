/**
 * INT-billing-entitlement adversary — client-side entitlement truth.
 *
 * Attacks the mobile billing trust boundary at HEAD without touching the
 * store SDK: forged / malformed `/v1/billing/sync` and `/v1/me/access`
 * bodies, numeric / non-canonical transaction identity, tampered pending
 * journals, and membership-state derivation from stale or contradictory
 * server snapshots. Every case asserts that the client either rejects the
 * body (`billing.backend_invalid_response`) or derives a state that never
 * grants, revokes or "settles" access the server did not state.
 */
import {
  BillingError,
  createCanonicalAccessClient,
  parseBillingTransaction,
  type BillingFulfilmentRequest,
  type CanonicalAccessState,
  type CanonicalBillingState,
} from '../../src/billing';
import {
  billingSnapshotAfterAccess,
  describeMembershipState,
  type MembershipStateInput,
} from '../../src/billing/membershipState';
import {
  PENDING_FULFILMENT_MAX_BACKOFF_MS,
  createPendingFulfilment,
  parsePendingFulfilment,
  pendingFulfilmentRetryAtMs,
  pendingFulfilmentRetryDue,
} from '../../src/billing/pendingFulfilment';

const OWNER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const OWNER_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const premiumAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['premium', 'pickle_sensei_pro'],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: true,
  paywallRequired: false,
};

const premiumBilling: CanonicalBillingState = {
  premium: true,
  productKey: 'pickle_sensei_pro_annual',
  expiresAt: '2027-01-01T00:00:00.000Z',
  verifiedAt: '2026-09-01T00:00:00.000Z',
};

const freeBilling: CanonicalBillingState = {
  premium: false,
  productKey: null,
  expiresAt: null,
  verifiedAt: '2026-09-01T00:00:00.000Z',
};

const request: BillingFulfilmentRequest = {
  pendingId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
  transaction: {
    productId: 'pickle_sensei_pro_lifetime',
    transactionId: '2000000833333333',
    purchasedAt: '2026-09-01T00:00:00.000Z',
  },
};

function clientAnswering(body: unknown) {
  const fetchFn = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as jest.MockedFunction<typeof fetch>;
  return {
    fetchFn,
    client: createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'access-token',
      fetchFn,
    }),
  };
}

async function expectInvalidResponse(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(BillingError);
  await expect(promise).rejects.toMatchObject({
    code: 'billing.backend_invalid_response',
    retryable: true,
  });
}

describe('ADV-M-01 forged /v1/billing/sync bodies cannot grant or mis-state entitlement', () => {
  it.each<[string, unknown]>([
    [
      'billing premium while access is free',
      { billing: premiumBilling, access: freeAccess },
    ],
    [
      'access premium while billing is free',
      { billing: freeBilling, access: premiumAccess },
    ],
    [
      'premium access whose entitlements omit the premium alias',
      {
        billing: premiumBilling,
        access: { ...premiumAccess, entitlements: ['pickle_sensei_pro'] },
      },
    ],
    [
      'free access that still lists the premium alias',
      {
        billing: freeBilling,
        access: { ...freeAccess, entitlements: ['premium'] },
      },
    ],
    [
      'premium access with paywallRequired true',
      {
        billing: premiumBilling,
        access: { ...premiumAccess, paywallRequired: true },
      },
    ],
    [
      'premium billing with a numeric expiry',
      {
        billing: { ...premiumBilling, expiresAt: 1798761600000 },
        access: premiumAccess,
      },
    ],
    [
      'billing without verifiedAt',
      {
        billing: { ...premiumBilling, verifiedAt: undefined },
        access: premiumAccess,
      },
    ],
    [
      'billing premium as the string "true"',
      {
        billing: { ...premiumBilling, premium: 'true' },
        access: premiumAccess,
      },
    ],
    [
      'access with a free-rating limit other than two',
      {
        billing: freeBilling,
        access: {
          ...freeAccess,
          freeRatings: { ...freeAccess.freeRatings, limit: 3 },
        },
      },
    ],
    [
      'access whose remaining count exceeds the ledger',
      {
        billing: freeBilling,
        access: {
          ...freeAccess,
          freeRatings: {
            ...freeAccess.freeRatings,
            remaining: 2,
            availableToReserve: 2,
          },
        },
      },
    ],
    ['an array body', [premiumBilling, premiumAccess]],
    ['a null body', null],
    ['a bare access body without billing', premiumAccess],
  ])('%s is rejected', async (_title, body) => {
    const { client } = clientAnswering(body);
    await expectInvalidResponse(client.syncBilling());
  });

  it('ADV-M-01x (CONFIRMED P3, fails on 2994371e): a non-ISO expiry string is rejected', async () => {
    // Asserts the documented contract (`CanonicalBillingState.expiresAt` is
    // ISO 8601). On HEAD `isIsoDate` only requires `Date.parse` to succeed,
    // so a free-form `expiresAt` such as 'Aug 1 2027' is accepted verbatim
    // and flows into the membership horizon; this test is kept failing as
    // the reproduction.
    const { client } = clientAnswering({
      billing: { ...premiumBilling, expiresAt: 'Aug 1 2027' },
      access: premiumAccess,
    });
    await expectInvalidResponse(client.syncBilling());
  });

  it('a fulfilment verdict the client never requested is rejected even beside a coherent premium answer', async () => {
    const { client } = clientAnswering({
      billing: premiumBilling,
      access: premiumAccess,
      fulfilment: {
        ...request,
        outcome: 'fulfilled',
        verifiedAt: '2026-09-02T00:00:00.000Z',
      },
    });
    await expectInvalidResponse(client.syncBilling());
  });
});

describe('ADV-M-02 fulfilment verdicts stay bound to the exact requested transaction identity', () => {
  const verdict = (overrides: Record<string, unknown>) => ({
    billing: premiumBilling,
    access: premiumAccess,
    fulfilment: {
      ...request,
      outcome: 'fulfilled',
      verifiedAt: '2026-09-02T00:00:00.000Z',
      ...overrides,
    },
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'numeric transaction id echoing the requested digits',
      {
        transaction: {
          ...request.transaction,
          transactionId: 2000000833333333,
        },
      },
    ],
    [
      'transaction id padded with whitespace',
      {
        transaction: {
          ...request.transaction,
          transactionId: ' 2000000833333333',
        },
      },
    ],
    [
      'transaction on a different product',
      {
        transaction: {
          ...request.transaction,
          productId: 'pickle_sensei_pro_annual',
        },
      },
    ],
    [
      'transaction purchased one second later',
      {
        transaction: {
          ...request.transaction,
          purchasedAt: '2026-09-01T00:00:01.000Z',
        },
      },
    ],
    ['a different pending id', { pendingId: OWNER_B }],
    ['a numeric attempt id', { attemptId: 4 }],
    [
      'a fulfilled verdict verified before the purchase',
      { verifiedAt: '2026-08-31T23:59:59.000Z' },
    ],
    ['a fulfilled verdict without verifiedAt', { verifiedAt: undefined }],
    [
      'a fulfilled verdict with a numeric verifiedAt',
      { verifiedAt: 1756771200000 },
    ],
    ['an outcome outside the contract', { outcome: 'granted' }],
    ['an outcome of null', { outcome: null }],
    ['a transaction of null', { transaction: null }],
  ])('%s is rejected', async (_title, overrides) => {
    const { client } = clientAnswering(verdict(overrides));
    await expectInvalidResponse(client.syncBilling(request));
  });

  it('a transaction echoed with an equivalent but non-canonical purchase timestamp is accepted only because the client canonicalizes both sides', async () => {
    const { client } = clientAnswering(
      verdict({
        transaction: {
          ...request.transaction,
          purchasedAt: '2026-09-01T05:30:00.000+05:30',
        },
      }),
    );
    await expect(client.syncBilling(request)).resolves.toMatchObject({
      fulfilment: {
        outcome: 'fulfilled',
        transaction: request.transaction,
      },
    });
  });

  it('a pending verdict may carry a verifiedAt before the purchase, but never a terminal one', async () => {
    const pending = clientAnswering({
      billing: freeBilling,
      access: freeAccess,
      fulfilment: {
        ...request,
        outcome: 'pending',
        verifiedAt: '2026-08-31T00:00:00.000Z',
      },
    });
    await expect(pending.client.syncBilling(request)).resolves.toMatchObject({
      fulfilment: { outcome: 'pending' },
    });
    for (const outcome of ['fulfilled', 'expired', 'refunded']) {
      const terminal = clientAnswering({
        billing: freeBilling,
        access: freeAccess,
        fulfilment: {
          ...request,
          outcome,
          verifiedAt: '2026-08-31T00:00:00.000Z',
        },
      });
      await expectInvalidResponse(terminal.client.syncBilling(request));
    }
  });

  it('a refunded verdict beside a premium answer is accepted as the server said it — the client never reconciles the two', async () => {
    const { client } = clientAnswering(verdict({ outcome: 'refunded' }));
    await expect(client.syncBilling(request)).resolves.toMatchObject({
      billing: { premium: true },
      access: { premium: true },
      fulfilment: { outcome: 'refunded' },
    });
  });
});

describe('ADV-M-03 transaction evidence identity', () => {
  it.each<[string, unknown]>([
    [
      'numeric transaction id',
      {
        productId: 'p',
        transactionId: 2000000833333333,
        purchasedAt: '2026-09-01T00:00:00Z',
      },
    ],
    [
      'empty transaction id',
      {
        productId: 'p',
        transactionId: '',
        purchasedAt: '2026-09-01T00:00:00Z',
      },
    ],
    [
      'transaction id longer than 256',
      {
        productId: 'p',
        transactionId: '1'.repeat(257),
        purchasedAt: '2026-09-01T00:00:00Z',
      },
    ],
    [
      'transaction id with a space',
      {
        productId: 'p',
        transactionId: '2000000 833333333',
        purchasedAt: '2026-09-01T00:00:00Z',
      },
    ],
    [
      'transaction id with a slash',
      {
        productId: 'p',
        transactionId: 'a/b',
        purchasedAt: '2026-09-01T00:00:00Z',
      },
    ],
    [
      'product id with unicode',
      {
        productId: 'prö',
        transactionId: '1',
        purchasedAt: '2026-09-01T00:00:00Z',
      },
    ],
    [
      'purchase timestamp without a zone',
      {
        productId: 'p',
        transactionId: '1',
        purchasedAt: '2026-09-01T00:00:00',
      },
    ],
    [
      'purchase timestamp as epoch millis',
      { productId: 'p', transactionId: '1', purchasedAt: 1756684800000 },
    ],
    [
      'purchase timestamp as a date only',
      { productId: 'p', transactionId: '1', purchasedAt: '2026-09-01' },
    ],
    [
      'purchase timestamp with an impossible month',
      {
        productId: 'p',
        transactionId: '1',
        purchasedAt: '2026-13-01T00:00:00Z',
      },
    ],
    [
      'purchase timestamp with ten fractional digits',
      {
        productId: 'p',
        transactionId: '1',
        purchasedAt: '2026-09-01T00:00:00.0000000000Z',
      },
    ],
    [
      'an array',
      [
        {
          productId: 'p',
          transactionId: '1',
          purchasedAt: '2026-09-01T00:00:00Z',
        },
      ],
    ],
    ['a string', 'p:1:2026-09-01T00:00:00Z'],
  ])('%s is not evidence', (_title, value) => {
    expect(parseBillingTransaction(value)).toBeNull();
  });

  it('canonicalizes an offset timestamp and strips every non-identifier field', () => {
    expect(
      parseBillingTransaction({
        productId: 'pickle_sensei_pro_lifetime',
        transactionId: '2000000833333333',
        purchasedAt: '2026-09-01T05:30:00.5+05:30',
        receipt: 'MIIT...',
        purchaseToken: 'tok',
        signature: 'sig',
      }),
    ).toEqual({
      productId: 'pickle_sensei_pro_lifetime',
      transactionId: '2000000833333333',
      purchasedAt: '2026-09-01T00:00:00.500Z',
    });
  });

  it('a numeric-looking id that exceeds the safe-integer range survives as a string, byte for byte', () => {
    const id = '92233720368547758070';
    expect(
      parseBillingTransaction({
        productId: 'p',
        transactionId: id,
        purchasedAt: '2026-09-01T00:00:00Z',
      })?.transactionId,
    ).toBe(id);
  });
});

describe('ADV-M-04 tampered pending journals never become fulfilment evidence', () => {
  const record = createPendingFulfilment(
    OWNER_A,
    'purchase',
    request.transaction,
  );

  it('a schema-2 purchase record round-trips with its canonical transaction only', () => {
    expect(record.schemaVersion).toBe(2);
    expect(parsePendingFulfilment(JSON.stringify(record), OWNER_A)).toEqual(
      record,
    );
  });

  it.each<[string, unknown]>([
    ['schema 2 restore record', { ...record, source: 'restore' }],
    ['schema 2 without transaction', { ...record, transaction: undefined }],
    [
      'schema 2 with a numeric transaction id',
      {
        ...record,
        transaction: {
          ...request.transaction,
          transactionId: 2000000833333333,
        },
      },
    ],
    [
      'schema 2 with a zone-less purchase time',
      {
        ...record,
        transaction: {
          ...request.transaction,
          purchasedAt: '2026-09-01T00:00:00',
        },
      },
    ],
    ['schema 3', { ...record, schemaVersion: 3 }],
    ['schema as a string', { ...record, schemaVersion: '2' }],
    [
      "another owner's record under this owner's key",
      { ...record, owner: OWNER_B },
    ],
    ['upper-cased owner', { ...record, owner: OWNER_A.toUpperCase() }],
    ['upper-cased id', { ...record, id: record.id.toUpperCase() }],
    ['state already fulfilled', { ...record, state: 'fulfilled' }],
    ['fractional attempts', { ...record, attempts: 1.5, lastAttemptAtMs: 1 }],
    [
      'negative lastAttemptAtMs',
      { ...record, attempts: 1, lastAttemptAtMs: -1 },
    ],
    ['fractional completedAtMs', { ...record, completedAtMs: 1.5 }],
    [
      'completedAtMs as a string',
      { ...record, completedAtMs: String(record.completedAtMs) },
    ],
  ])(
    '%s is unreadable and reported as verification pending, never as free or fulfilled',
    (_title, raw) => {
      let caught: unknown = null;
      try {
        parsePendingFulfilment(JSON.stringify(raw), OWNER_A);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BillingError);
      expect(caught).toMatchObject({
        code: 'billing.backend_verification_pending',
        retryable: true,
      });
    },
  );

  it('a schema-1 record read for the same owner drops any smuggled transaction', () => {
    const legacy = createPendingFulfilment(OWNER_A, 'restore');
    expect(legacy.schemaVersion).toBe(1);
    const parsed = parsePendingFulfilment(
      JSON.stringify({ ...legacy, transaction: request.transaction }),
      OWNER_A,
    );
    expect(parsed).toEqual(legacy);
    expect(parsed?.transaction).toBeUndefined();
  });

  it('a record is unreadable under any other owner, even one differing only in case or whitespace of the key', () => {
    expect(() =>
      parsePendingFulfilment(JSON.stringify(record), OWNER_B),
    ).toThrow(BillingError);
    expect(
      parsePendingFulfilment(
        JSON.stringify(record),
        ` ${OWNER_A.toUpperCase()} `,
      ),
    ).toEqual(record);
  });

  it('automatic retry backoff is monotonic, capped at five minutes and due again after a clock rollback', () => {
    let previous = 0;
    for (let attempts = 1; attempts <= 31; attempts += 1) {
      const at = pendingFulfilmentRetryAtMs({
        ...record,
        attempts,
        lastAttemptAtMs: 1_000_000,
      });
      expect(at).toBeGreaterThanOrEqual(previous);
      expect(at - 1_000_000).toBeLessThanOrEqual(
        PENDING_FULFILMENT_MAX_BACKOFF_MS,
      );
      previous = at;
    }
    expect(
      pendingFulfilmentRetryAtMs({
        ...record,
        attempts: 1,
        lastAttemptAtMs: 1_000_000,
      }),
    ).toBe(1_005_000);
    expect(
      pendingFulfilmentRetryAtMs({
        ...record,
        attempts: 31,
        lastAttemptAtMs: 1_000_000,
      }),
    ).toBe(1_000_000 + PENDING_FULFILMENT_MAX_BACKOFF_MS);
    const late = { ...record, attempts: 7, lastAttemptAtMs: 1_000_000 };
    expect(
      pendingFulfilmentRetryDue(
        late,
        1_000_000 + PENDING_FULFILMENT_MAX_BACKOFF_MS - 1,
      ),
    ).toBe(false);
    expect(
      pendingFulfilmentRetryDue(
        late,
        1_000_000 + PENDING_FULFILMENT_MAX_BACKOFF_MS,
      ),
    ).toBe(true);
    expect(pendingFulfilmentRetryDue(late, 999_999)).toBe(true);
  });
});

describe('ADV-M-05 membership truth is derived from the server, never from stale or contradictory snapshots', () => {
  const now = Date.parse('2026-09-09T00:00:00.000Z');
  const base: MembershipStateInput = {
    access: freeAccess,
    billing: null,
    pendingFulfilment: null,
    fulfilmentStatus: 'clear',
    reconciliationStatus: 'verified',
    fulfilmentVerdict: null,
    error: null,
    nowMs: now,
  };

  it('a premium snapshot beside a non-premium access answer is free, never expired, and offers purchase', () => {
    const state = describeMembershipState({ ...base, billing: premiumBilling });
    expect(state.kind).toBe('free');
    expect(state.horizon).toBeNull();
    expect(state.purchaseAllowed).toBe(true);
    expect(state.manageSubscription).toBe(false);
  });

  it('an expired premium snapshot beside a non-premium access answer is free — the client never announces a lapse the server did not settle', () => {
    const state = describeMembershipState({
      ...base,
      billing: { ...premiumBilling, expiresAt: '2026-09-01T00:00:00.000Z' },
    });
    expect(state.kind).toBe('free');
    expect(state.label).not.toMatch(/expired|refunded/i);
  });

  it('a non-premium billing snapshot beside premium access is fulfilled without a horizon and without subscription management', () => {
    const state = describeMembershipState({
      ...base,
      access: premiumAccess,
      billing: freeBilling,
    });
    expect(state.kind).toBe('fulfilled');
    expect(state.horizon).toBeNull();
    expect(state.manageSubscription).toBe(false);
    expect(state.purchaseAllowed).toBe(false);
  });

  it('a premium snapshot with a malformed expiry beside premium access is fulfilled without a horizon, not grace', () => {
    const state = describeMembershipState({
      ...base,
      access: premiumAccess,
      billing: { ...premiumBilling, expiresAt: 'not-a-date' },
    });
    expect(state.kind).toBe('fulfilled');
    expect(state.horizon).toBeNull();
    expect(state.manageSubscription).toBe(false);
  });

  it('premium access exactly at the stored horizon is grace, one millisecond before it is fulfilled', () => {
    const horizon = '2026-09-09T00:00:00.000Z';
    const billing = { ...premiumBilling, expiresAt: horizon };
    expect(
      describeMembershipState({
        ...base,
        access: premiumAccess,
        billing,
        nowMs: now,
      }).kind,
    ).toBe('grace');
    expect(
      describeMembershipState({
        ...base,
        access: premiumAccess,
        billing,
        nowMs: now - 1,
      }).kind,
    ).toBe('fulfilled');
  });

  it('a pending journal outranks a refunded verdict and a premium answer: no new purchase, retry only', () => {
    const pending = createPendingFulfilment(
      OWNER_A,
      'purchase',
      request.transaction,
    );
    const state = describeMembershipState({
      ...base,
      access: premiumAccess,
      billing: premiumBilling,
      pendingFulfilment: pending,
      fulfilmentVerdict: {
        ...request,
        outcome: 'refunded',
        verifiedAt: '2026-09-02T00:00:00.000Z',
      },
    });
    expect(state.kind).toBe('pending');
    expect(state.purchaseAllowed).toBe(false);
    expect(state.retryAllowed).toBe(true);
    expect(state.manageSubscription).toBe(false);
  });

  it('an unreadable journal is HOLD even when the server currently grants premium', () => {
    const state = describeMembershipState({
      ...base,
      access: premiumAccess,
      billing: premiumBilling,
      fulfilmentStatus: 'unavailable',
    });
    expect(state.kind).toBe('hold');
    expect(state.purchaseAllowed).toBe(false);
    expect(state.horizon).toBeNull();
  });

  it('a pending record with the server unreachable is HOLD, not pending, and never offers a store request', () => {
    const state = describeMembershipState({
      ...base,
      pendingFulfilment: createPendingFulfilment(OWNER_A, 'restore'),
      reconciliationStatus: 'unavailable',
    });
    expect(state.kind).toBe('hold');
    expect(state.purchaseAllowed).toBe(false);
  });

  it('a refunded verdict bound to this purchase beside non-premium access is expired/refunded and re-opens purchase', () => {
    const state = describeMembershipState({
      ...base,
      fulfilmentVerdict: {
        ...request,
        outcome: 'refunded',
        verifiedAt: '2026-09-02T00:00:00.000Z',
      },
    });
    expect(state.kind).toBe('expired');
    expect(state.eyebrow).toBe('PURCHASE REFUNDED');
    expect(state.purchaseAllowed).toBe(true);
    expect(state.retryAllowed).toBe(false);
  });

  it('a pending verdict from the server keeps the account pending even with no local journal', () => {
    const state = describeMembershipState({
      ...base,
      fulfilmentVerdict: {
        ...request,
        outcome: 'pending',
        verifiedAt: '2026-09-02T00:00:00.000Z',
      },
    });
    expect(state.kind).toBe('pending');
    expect(state.purchaseAllowed).toBe(false);
  });

  it('no access answer is unverified even when a premium billing snapshot is present', () => {
    const state = describeMembershipState({
      ...base,
      access: null,
      billing: premiumBilling,
    });
    expect(state.kind).toBe('unverified');
    expect(state.purchaseAllowed).toBe(false);
  });

  it.each<
    [
      string,
      CanonicalAccessState,
      CanonicalBillingState | null,
      number,
      boolean,
    ]
  >([
    [
      'non-premium access drops a premium snapshot',
      freeAccess,
      premiumBilling,
      now,
      false,
    ],
    [
      'premium access drops a non-premium snapshot',
      premiumAccess,
      freeBilling,
      now,
      false,
    ],
    [
      'premium access keeps a lifetime snapshot',
      premiumAccess,
      { ...premiumBilling, expiresAt: null },
      now,
      true,
    ],
    [
      'premium access keeps a snapshot before its horizon',
      premiumAccess,
      premiumBilling,
      now,
      true,
    ],
    [
      'premium access drops a snapshot exactly at its horizon',
      premiumAccess,
      { ...premiumBilling, expiresAt: '2026-09-09T00:00:00.000Z' },
      now,
      false,
    ],
    [
      'premium access drops a snapshot with a malformed horizon',
      premiumAccess,
      { ...premiumBilling, expiresAt: 'soon' },
      now,
      false,
    ],
    [
      'premium access with no snapshot stays empty',
      premiumAccess,
      null,
      now,
      false,
    ],
  ])(
    'billingSnapshotAfterAccess: %s',
    (_title, access, billing, receivedAt, kept) => {
      expect(billingSnapshotAfterAccess(access, billing, receivedAt)).toBe(
        kept ? billing : null,
      );
    },
  );
});
