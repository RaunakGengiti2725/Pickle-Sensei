// Real Edge handler; provider I/O and ordered-ticket persistence are exercised
// through the existing stateful transport harness. SQL is proved separately.
import { assertEquals } from "@std/assert";
import { fakeSupabaseAccessToken, userRequest } from "./routesHarness.ts";
import { simulate, VERDICT_URL } from "./webhookSim.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const LIFETIME = "pickle_sensei_pro_lifetime";
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const entitlement = (expires: string | null, product = MONTHLY, grace: unknown = null) => ({
  expires_date: expires,
  grace_period_expires_date: grace,
  product_identifier: product,
  purchase_date: at(-86_400_000),
});

async function sync(subscriber: Record<string, unknown>, body?: unknown) {
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
      stored: sim.entitlementRows.get(owner),
      writes: sim.entitlementWrites.length,
    };
  } finally {
    sim.restore();
  }
}

const purchaseEvidence = {
  pendingId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  transaction: {
    productId: MONTHLY,
    transactionId: "1000000123456789",
    purchasedAt: "2026-08-01T00:00:00.000Z",
  },
};

Deno.test(
  "W07 pending purchase: only a matching active entitlement fulfils a transaction",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000)) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: purchaseEvidence.transaction.transactionId,
            purchase_date: purchaseEvidence.transaction.purchasedAt,
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
      },
      { fulfilment: purchaseEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
    assertEquals(result.body.billing.premium, true);
  },
);

Deno.test(
  "W07 pending purchase: a superseded ticket cannot return a terminal verdict",
  async () => {
    const sim = await simulate();
    try {
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      sim.h.subscriber = {
        entitlements: {},
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: purchaseEvidence.transaction.transactionId,
            purchase_date: purchaseEvidence.transaction.purchasedAt,
            expires_date: at(-1_000),
          },
        },
      };
      const owner = crypto.randomUUID();
      sim.faults.push({
        match: (method, url) => method === "POST" && url === VERDICT_URL,
        status: 200,
        body: {
          outcome: "persisted",
          user_id: owner,
          applied: false,
          billing: {
            premium: false,
            productKey: null,
            expiresAt: null,
            verifiedAt: at(0),
            activeEntitlements: [],
          },
        },
      });
      const response = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", {
          token: fakeSupabaseAccessToken(owner),
          body: { fulfilment: purchaseEvidence },
        }),
      );
      assertEquals(response.status, 200);
      assertEquals((await response.json()).fulfilment.outcome, "pending");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "W07 pending purchase: malformed evidence fails before provider verification",
  async () => {
    const result = await sync(
      { entitlements: {} },
      {
        fulfilment: {
          ...purchaseEvidence,
          transaction: { ...purchaseEvidence.transaction, transactionId: "x".repeat(257) },
        },
      },
    );
    assertEquals(result.status, 400);
    assertEquals(result.writes, 0);
  },
);

for (const outcome of ["expired", "refunded"]) {
  Deno.test(`W07 pending purchase: fresh matched subscription proves ${outcome}`, async () => {
    const result = await sync(
      {
        entitlements: {},
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: purchaseEvidence.transaction.transactionId,
            purchase_date: purchaseEvidence.transaction.purchasedAt,
            expires_date: at(-1_000),
            grace_period_expires_date: null,
            refunded_at: outcome === "refunded" ? at(-2_000) : null,
          },
        },
      },
      { fulfilment: purchaseEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, outcome);
    assertEquals(result.body.fulfilment?.pendingId, purchaseEvidence.pendingId);
    assertEquals(result.body.fulfilment?.attemptId, purchaseEvidence.attemptId);
    assertEquals(result.body.fulfilment?.transaction, purchaseEvidence.transaction);
    assertEquals(result.body.billing.premium, false);
  });
}

for (const reason of [
  "absence",
  "other-transaction",
  "other-purchase-date",
  "active-grace",
  "malformed-expiry",
  "future-refund",
]) {
  Deno.test(`W07 pending purchase: ${reason} is not terminal evidence`, async () => {
    const result = await sync(
      {
        entitlements: {},
        subscriptions:
          reason === "absence"
            ? {}
            : {
                [MONTHLY]: {
                  store_transaction_id:
                    reason === "other-transaction"
                      ? "different"
                      : purchaseEvidence.transaction.transactionId,
                  purchase_date:
                    reason === "other-purchase-date"
                      ? at(-60_000)
                      : purchaseEvidence.transaction.purchasedAt,
                  expires_date: reason === "malformed-expiry" ? "invalid" : at(-1_000),
                  grace_period_expires_date: reason === "active-grace" ? at(60_000) : null,
                  refunded_at: reason === "future-refund" ? at(60_000) : null,
                },
              },
      },
      { fulfilment: purchaseEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  });
}

Deno.test(
  "W07 grace: verified entitlement grace preserves access past the paid expiry",
  async () => {
    const grace = at(60_000);
    const result = await sync({
      entitlements: { pickle_sensei_pro: entitlement(at(-1_000), MONTHLY, grace) },
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.access.premium, true);
    assertEquals(result.body.billing.expiresAt, grace);
    assertEquals(result.stored?.expires_at, grace);
  },
);

Deno.test(
  "W07 grace: the matching subscription's verified grace deadline grants access",
  async () => {
    const grace = at(60_000);
    const expired = at(-1_000);
    const result = await sync({
      entitlements: { pickle_sensei_pro: entitlement(expired) },
      subscriptions: {
        [MONTHLY]: {
          expires_date: expired,
          grace_period_expires_date: grace,
          billing_issues_detected_at: expired,
          unsubscribe_detected_at: expired,
          store: "app_store",
        },
      },
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.billing.expiresAt, grace);
  },
);

Deno.test(
  "W07 grace: expiry at the boundary and an unrelated product's grace grant no access",
  async () => {
    const expired = at(0);
    const result = await sync({
      entitlements: { pickle_sensei_pro: entitlement(expired, MONTHLY, expired) },
      subscriptions: { unrelated: { grace_period_expires_date: at(60_000) } },
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, false);
    assertEquals(result.body.access.premium, false);
    assertEquals(result.stored?.premium, false);
  },
);

Deno.test(
  "W07 grace: cancellation keeps the paid horizon even if an old grace horizon is shorter",
  async () => {
    const paid = at(120_000);
    const result = await sync({
      entitlements: { pickle_sensei_pro: entitlement(paid, MONTHLY, at(60_000)) },
      subscriptions: {
        [MONTHLY]: { unsubscribe_detected_at: at(-1_000), grace_period_expires_date: null },
      },
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.billing.expiresAt, paid);
  },
);

for (const lifetime of [false, true]) {
  Deno.test(
    `W07 aliases: retain the longer ${lifetime ? "lifetime" : "subscription"} grant`,
    async () => {
      const longer = lifetime ? null : at(120_000);
      const result = await sync({
        entitlements: {
          pickle_sensei_pro: entitlement(at(60_000)),
          premium: entitlement(longer, lifetime ? LIFETIME : "pickle_sensei_pro_annual"),
        },
      });
      assertEquals(result.status, 200);
      assertEquals(result.body.billing.premium, true);
      assertEquals(result.body.billing.expiresAt, longer);
      assertEquals(
        result.body.billing.productKey,
        lifetime ? LIFETIME : "pickle_sensei_pro_annual",
      );
      assertEquals(result.body.access.entitlements, ["premium", "pickle_sensei_pro"]);
    },
  );
}

for (const subscription of [false, true]) {
  Deno.test(
    `W07 grace: malformed ${subscription ? "subscription" : "entitlement"} grace remains retryable`,
    async () => {
      const result = await sync({
        entitlements: {
          pickle_sensei_pro: entitlement(at(-1_000), MONTHLY, subscription ? null : "invalid"),
        },
        ...(subscription
          ? { subscriptions: { [MONTHLY]: { grace_period_expires_date: "invalid" } } }
          : {}),
      });
      assertEquals(result.status, 502);
      assertEquals(result.body.error.code, "billing_unavailable");
      assertEquals(result.writes, 0, "malformed provider state must not persist a revoke");
    },
  );
}
