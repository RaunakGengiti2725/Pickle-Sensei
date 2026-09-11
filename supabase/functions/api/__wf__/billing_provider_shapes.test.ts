// W07-01: provider transaction identity shapes. RevenueCat's v1 customer info
// carries iOS `store_transaction_id` as a JSON number in places, and a lifetime
// (non-subscription) record may expose only RevenueCat's own purchase `id`
// without any Apple transaction id. Reconciliation must still resolve those
// purchases; anything absent, conflicting or ambiguous stays pending.
import { assertEquals } from "@std/assert";
import { fakeSupabaseAccessToken, userRequest } from "./routesHarness.ts";
import { simulate } from "./webhookSim.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const LIFETIME = "pickle_sensei_pro_lifetime";
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const entitlement = (expires: string | null, product: string) => ({
  expires_date: expires,
  grace_period_expires_date: null,
  product_identifier: product,
  purchase_date: at(-86_400_000),
});

async function sync(subscriber: Record<string, unknown>, body: unknown) {
  const sim = await simulate();
  const owner = crypto.randomUUID();
  try {
    sim.h.subscriber = subscriber;
    sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    const response = await sim.h.handler(
      userRequest("POST", "/v1/billing/sync", {
        body,
        token: fakeSupabaseAccessToken(owner),
      }),
    );
    return {
      status: response.status,
      body: await response.json(),
      writes: sim.entitlementWrites.length,
    };
  } finally {
    sim.restore();
  }
}

const NUMERIC_ID = 1000000652379790;
const PURCHASED_AT = "2026-08-01T00:00:00.000Z";
const RC_PURCHASE_ID = "cadba0c81b";

const evidence = (productId: string, transactionId: string) => ({
  pendingId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  transaction: { productId, transactionId, purchasedAt: PURCHASED_AT },
});
const monthlyEvidence = evidence(MONTHLY, String(NUMERIC_ID));
const lifetimeEvidence = evidence(LIFETIME, RC_PURCHASE_ID);

// ── numeric iOS transaction ids ──────────────────────────────────────────────

Deno.test(
  "W07-01 numeric id: a numeric store_transaction_id matches the mobile string and fulfils",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: "2026-08-01T00:00:00Z",
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
      },
      { fulfilment: monthlyEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
    assertEquals(result.body.fulfilment?.transaction, monthlyEvidence.transaction);
    assertEquals(result.body.billing.premium, true);
  },
);

Deno.test(
  "W07-01 numeric id: a numeric lifetime store_transaction_id fulfils the lifetime purchase",
  async () => {
    const lifetime = evidence(LIFETIME, String(NUMERIC_ID));
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
        non_subscriptions: {
          [LIFETIME]: [
            {
              id: RC_PURCHASE_ID,
              store_transaction_id: NUMERIC_ID,
              purchase_date: PURCHASED_AT,
              store: "app_store",
              is_sandbox: false,
            },
          ],
        },
      },
      { fulfilment: lifetime },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
    assertEquals(result.body.billing.productKey, LIFETIME);
  },
);

for (const outcome of ["expired", "refunded"]) {
  Deno.test(`W07-01 numeric id: an explicit provider record still proves ${outcome}`, async () => {
    const result = await sync(
      {
        entitlements: {},
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: PURCHASED_AT,
            expires_date: at(-1_000),
            grace_period_expires_date: null,
            refunded_at: outcome === "refunded" ? at(-2_000) : null,
          },
        },
      },
      { fulfilment: monthlyEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, outcome);
    assertEquals(result.body.billing.premium, false);
  });
}

Deno.test(
  "W07-01 numeric id: no provider record and no entitlement stays pending, never expired",
  async () => {
    const result = await sync(
      { entitlements: {}, subscriptions: {}, non_subscriptions: {} },
      { fulfilment: monthlyEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
    assertEquals(result.body.billing.premium, false);
  },
);

for (const [reason, storeTransactionId] of [
  ["a different numeric id", 1000000652379791],
  ["a fractional number", NUMERIC_ID + 0.5],
  ["an unsafe integer", 100000000000000000000],
  ["a boolean", true],
  ["null", null],
  ["an object", { id: NUMERIC_ID }],
] as const) {
  Deno.test(`W07-01 numeric id: ${reason} is not the mobile transaction`, async () => {
    const transactionId =
      typeof storeTransactionId === "number" && !Number.isSafeInteger(storeTransactionId)
        ? "100000000000000000000"
        : monthlyEvidence.transaction.transactionId;
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: storeTransactionId,
            purchase_date: PURCHASED_AT,
            expires_date: at(-1_000),
            refunded_at: at(-2_000),
          },
        },
      },
      {
        fulfilment: {
          ...monthlyEvidence,
          transaction: { ...monthlyEvidence.transaction, transactionId },
        },
      },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  });
}

// ── lifetime purchases without an Apple transaction id ───────────────────────

const lifetimeRow = (overrides: Record<string, unknown> = {}) => ({
  id: RC_PURCHASE_ID,
  purchase_date: PURCHASED_AT,
  store: "app_store",
  is_sandbox: false,
  ...overrides,
});

Deno.test(
  "W07-01 lifetime: RevenueCat purchase identity fulfils when the Apple id is absent",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
        non_subscriptions: { [LIFETIME]: [lifetimeRow()] },
      },
      { fulfilment: lifetimeEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
    assertEquals(result.body.fulfilment?.transaction, lifetimeEvidence.transaction);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.billing.expiresAt, null);
  },
);

Deno.test(
  "W07-01 lifetime: an explicit null store_transaction_id also falls back to RevenueCat identity",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
        non_subscriptions: { [LIFETIME]: [lifetimeRow({ store_transaction_id: null })] },
      },
      { fulfilment: lifetimeEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
  },
);

Deno.test(
  "W07-01 lifetime: an identified purchase with an explicit provider refund is refunded",
  async () => {
    const result = await sync(
      {
        entitlements: {},
        non_subscriptions: { [LIFETIME]: [lifetimeRow({ refunded_at: at(-2_000) })] },
      },
      { fulfilment: lifetimeEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "refunded");
    assertEquals(result.body.billing.premium, false);
  },
);

Deno.test(
  "W07-01 lifetime: an identified purchase without entitlement or refund stays pending",
  async () => {
    const result = await sync(
      { entitlements: {}, non_subscriptions: { [LIFETIME]: [lifetimeRow()] } },
      { fulfilment: lifetimeEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
    assertEquals(result.body.billing.premium, false);
  },
);

for (const [reason, subscriber] of [
  ["absence", { entitlements: {}, non_subscriptions: {} }],
  [
    "an empty purchase list",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: { [LIFETIME]: [] },
    },
  ],
  [
    "a product-only record without any identity",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: { [LIFETIME]: [lifetimeRow({ id: undefined })] },
    },
  ],
  [
    "a different RevenueCat id",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: { [LIFETIME]: [lifetimeRow({ id: "0123456789" })] },
    },
  ],
  [
    "a RevenueCat id beside a conflicting Apple id",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: {
        [LIFETIME]: [lifetimeRow({ store_transaction_id: "1000000000000001" })],
      },
    },
  ],
  [
    "a RevenueCat id beside a conflicting numeric Apple id",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: { [LIFETIME]: [lifetimeRow({ store_transaction_id: NUMERIC_ID })] },
    },
  ],
  [
    "a RevenueCat id with a different purchase date",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: { [LIFETIME]: [lifetimeRow({ purchase_date: at(-60_000) })] },
    },
  ],
  [
    "a RevenueCat id on another product",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: { pickle_sensei_pro_gift: [lifetimeRow()] },
    },
  ],
  [
    "duplicate RevenueCat ids",
    {
      entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
      non_subscriptions: { [LIFETIME]: [lifetimeRow(), lifetimeRow()] },
    },
  ],
  [
    "a refunded duplicate beside the identified purchase",
    {
      entitlements: {},
      non_subscriptions: { [LIFETIME]: [lifetimeRow(), lifetimeRow({ refunded_at: at(-2_000) })] },
    },
  ],
  [
    "an explicit refund on a product-only record",
    {
      entitlements: {},
      non_subscriptions: { [LIFETIME]: [lifetimeRow({ id: undefined, refunded_at: at(-2_000) })] },
    },
  ],
] as const) {
  Deno.test(`W07-01 lifetime: ${reason} is never terminal and never fulfils`, async () => {
    const result = await sync(subscriber, { fulfilment: lifetimeEvidence });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  });
}

Deno.test(
  "W07-01 lifetime: a recurring subscription never resolves through a RevenueCat-only id",
  async () => {
    const monthly = evidence(MONTHLY, RC_PURCHASE_ID);
    const result = await sync(
      {
        entitlements: {},
        subscriptions: {
          [MONTHLY]: {
            id: RC_PURCHASE_ID,
            purchase_date: PURCHASED_AT,
            expires_date: at(-1_000),
            grace_period_expires_date: null,
            refunded_at: null,
          },
        },
      },
      { fulfilment: monthly },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  },
);
