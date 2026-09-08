// W07-02 — a renewal replaces the latest transaction RevenueCat reports for a
// subscription. The subscriber's `subscriptions[product]` row then carries the
// RENEWAL's `store_transaction_id`/`purchase_date`, so the transaction id the
// device has been retrying for the ORIGINAL purchase is no longer present
// anywhere in the subscriber. Reconciliation must follow the subscription
// lineage (`original_purchase_date` + a later, differently identified latest
// transaction) instead of the id, or the pending journal entry stays pending for
// as long as the customer keeps paying. Post-renewal fixtures cover the
// fulfilled, expired, grace, refund, mismatch and malformed shapes.

import { assertEquals } from "@std/assert";
import { simulate } from "./webhookSim.ts";
import { fakeSupabaseAccessToken, userRequest } from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const ANNUAL = "pickle_sensei_pro_annual";
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// The original purchase (what the device journaled) and the renewal that
// replaced it as RevenueCat's latest transaction.
const ORIGINAL_ID = "2000000811111111";
const ORIGINAL_AT = at(-35 * DAY);
const RENEWAL_ID = "2000000822222222";
const RENEWAL_AT = at(-5 * DAY);

function fulfilment(
  overrides: Partial<{ productId: string; transactionId: string; purchasedAt: string }> = {},
) {
  return {
    pendingId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    transaction: {
      productId: MONTHLY,
      transactionId: ORIGINAL_ID,
      purchasedAt: ORIGINAL_AT,
      ...overrides,
    },
  };
}

/** RevenueCat's subscription row AFTER a renewal: latest transaction fields
 * point at the renewal, `original_purchase_date` still names the lineage's
 * first purchase. */
function renewedSubscription(
  overrides: Record<string, unknown> = {},
  expiresDate: string | null = at(25 * DAY),
): Record<string, unknown> {
  return {
    store: "app_store",
    is_sandbox: false,
    period_type: "normal",
    ownership_type: "PURCHASED",
    store_transaction_id: RENEWAL_ID,
    purchase_date: RENEWAL_AT,
    original_purchase_date: ORIGINAL_AT,
    expires_date: expiresDate,
    grace_period_expires_date: null,
    unsubscribe_detected_at: null,
    billing_issues_detected_at: null,
    refunded_at: null,
    ...overrides,
  };
}

function subscriber(
  subscription: Record<string, unknown>,
  options: { productId?: string; entitled?: boolean } = {},
): Record<string, unknown> {
  const productId = options.productId ?? MONTHLY;
  const entitled = options.entitled ?? true;
  return {
    entitlements: entitled
      ? {
          pickle_sensei_pro: {
            expires_date: subscription.expires_date,
            purchase_date: subscription.purchase_date,
            product_identifier: productId,
          },
        }
      : {},
    subscriptions: { [productId]: subscription },
    non_subscriptions: {},
  };
}

async function sync(subscriberBody: Record<string, unknown>, body: unknown) {
  const sim = await simulate();
  const owner = crypto.randomUUID();
  try {
    sim.h.subscriber = subscriberBody;
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

Deno.test(
  "post-renewal: the original pending purchase is fulfilled against the active lineage",
  async () => {
    const request = fulfilment();
    const result = await sync(subscriber(renewedSubscription()), { fulfilment: request });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
    assertEquals(result.body.fulfilment.pendingId, request.pendingId);
    assertEquals(result.body.fulfilment.attemptId, request.attemptId);
    // The verdict is about the ORIGINAL transaction the device journaled, not
    // the renewal that now heads the lineage.
    assertEquals(result.body.fulfilment.transaction, request.transaction);
    assertEquals(result.writes, 1);
  },
);

Deno.test(
  "post-renewal: a numeric renewal store_transaction_id still identifies the lineage",
  async () => {
    const result = await sync(
      subscriber(renewedSubscription({ store_transaction_id: Number(RENEWAL_ID) })),
      { fulfilment: fulfilment() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
  },
);

Deno.test("post-renewal: the lineage is product-specific (annual fixture)", async () => {
  const result = await sync(
    subscriber(renewedSubscription({ expires_date: at(300 * DAY) }), { productId: ANNUAL }),
    { fulfilment: fulfilment({ productId: ANNUAL }) },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "fulfilled");
});

Deno.test(
  "post-renewal: a lineage whose latest transaction has lapsed with no grace is expired",
  async () => {
    const result = await sync(subscriber(renewedSubscription({}, at(-DAY)), { entitled: false }), {
      fulfilment: fulfilment(),
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, false);
    assertEquals(result.body.fulfilment.outcome, "expired");
  },
);

Deno.test("post-renewal: a lapsed lineage inside its grace period stays pending", async () => {
  const result = await sync(
    subscriber(renewedSubscription({ grace_period_expires_date: at(3 * DAY) }, at(-DAY)), {
      entitled: false,
    }),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "pending");
});

Deno.test("post-renewal: a lapsed lineage with a malformed grace date stays pending", async () => {
  const result = await sync(
    subscriber(renewedSubscription({ grace_period_expires_date: "later" }, at(-DAY)), {
      entitled: false,
    }),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "pending");
});

Deno.test(
  "post-renewal: a refund recorded on the lineage is not attributed to the original transaction",
  async () => {
    // Refund while RevenueCat still reports the entitlement active: contradictory
    // for the ORIGINAL purchase, so nothing terminal is claimed about it.
    const active = await sync(subscriber(renewedSubscription({ refunded_at: at(-2 * DAY) })), {
      fulfilment: fulfilment(),
    });
    assertEquals(active.status, 200);
    assertEquals(active.body.fulfilment.outcome, "fulfilled");
    // Refund of the (renewal-headed) lineage with access gone: the original
    // period ended, but the refund belongs to whichever transaction RC refunded,
    // never to the journaled one — it is "expired", not "refunded".
    const revoked = await sync(
      subscriber(renewedSubscription({ refunded_at: at(-2 * DAY) }, at(-2 * DAY)), {
        entitled: false,
      }),
      { fulfilment: fulfilment() },
    );
    assertEquals(revoked.status, 200);
    assertEquals(revoked.body.fulfilment.outcome, "expired");
    // Refund with no usable expiry stays unresolved.
    const unresolved = await sync(
      subscriber(renewedSubscription({ refunded_at: at(-2 * DAY) }, null), { entitled: false }),
      { fulfilment: fulfilment() },
    );
    assertEquals(unresolved.status, 200);
    assertEquals(unresolved.body.fulfilment.outcome, "pending");
  },
);

Deno.test("post-renewal: a different original_purchase_date is a different lineage", async () => {
  const result = await sync(
    subscriber(renewedSubscription({ original_purchase_date: at(-40 * DAY) })),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, true);
  assertEquals(result.body.fulfilment.outcome, "pending");
  assertEquals(result.body.fulfilment.transaction.transactionId, ORIGINAL_ID);
});

Deno.test(
  "post-renewal: a missing or malformed original_purchase_date never proves the lineage",
  async () => {
    for (const original_purchase_date of [undefined, null, "", "2026-08-01", 1_754_006_400_000]) {
      const row = renewedSubscription({ original_purchase_date });
      if (original_purchase_date === undefined) delete row.original_purchase_date;
      const result = await sync(subscriber(row), { fulfilment: fulfilment() });
      assertEquals(result.status, 200);
      assertEquals(result.body.fulfilment.outcome, "pending", String(original_purchase_date));
    }
  },
);

Deno.test(
  "post-renewal: the original date on the lineage must be exact, not merely the same instant of a different day",
  async () => {
    const result = await sync(
      subscriber(renewedSubscription({ original_purchase_date: at(-35 * DAY + 1_000) })),
      { fulfilment: fulfilment() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: a latest transaction that is not later than the original is not a renewal",
  async () => {
    // Same-dated different id: conflicting records for one purchase, not a lineage.
    const same = await sync(subscriber(renewedSubscription({ purchase_date: ORIGINAL_AT })), {
      fulfilment: fulfilment(),
    });
    assertEquals(same.status, 200);
    assertEquals(same.body.fulfilment.outcome, "pending");
    // Latest purchase before the journaled original: the journaled purchase
    // cannot be this lineage's first transaction.
    const earlier = await sync(subscriber(renewedSubscription({ purchase_date: at(-36 * DAY) })), {
      fulfilment: fulfilment(),
    });
    assertEquals(earlier.status, 200);
    assertEquals(earlier.body.fulfilment.outcome, "pending");
    // Malformed latest purchase date.
    const malformed = await sync(subscriber(renewedSubscription({ purchase_date: "yesterday" })), {
      fulfilment: fulfilment(),
    });
    assertEquals(malformed.status, 200);
    assertEquals(malformed.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: the journaled id beside a later purchase date is a conflict, not a renewal",
  async () => {
    const result = await sync(
      subscriber(renewedSubscription({ store_transaction_id: ORIGINAL_ID })),
      {
        fulfilment: fulfilment(),
      },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: a latest transaction without a store transaction id cannot head a lineage",
  async () => {
    for (const store_transaction_id of [undefined, null, "", -1, 1.5]) {
      const row = renewedSubscription({ store_transaction_id, id: RENEWAL_ID });
      if (store_transaction_id === undefined) delete row.store_transaction_id;
      const result = await sync(subscriber(row), { fulfilment: fulfilment() });
      assertEquals(result.status, 200);
      assertEquals(result.body.fulfilment.outcome, "pending", String(store_transaction_id));
    }
  },
);

Deno.test(
  "post-renewal: the lineage under another product never fulfils this product's purchase",
  async () => {
    const result = await sync(
      subscriber(renewedSubscription({ expires_date: at(300 * DAY) }), { productId: ANNUAL }),
      {
        fulfilment: fulfilment(),
      },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: an active lineage whose entitlement names another product stays pending",
  async () => {
    const body = subscriber(renewedSubscription());
    (
      body.entitlements as Record<string, Record<string, unknown>>
    ).pickle_sensei_pro.product_identifier = ANNUAL;
    const result = await sync(body, { fulfilment: fulfilment() });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: lifetime records have no lineage — a different id is never the same purchase",
  async () => {
    const LIFETIME = "pickle_sensei_pro_lifetime";
    const result = await sync(
      {
        entitlements: {
          pickle_sensei_pro: { expires_date: null, product_identifier: LIFETIME },
        },
        subscriptions: {},
        non_subscriptions: {
          [LIFETIME]: [
            {
              id: "rc_lifetime_1",
              store_transaction_id: RENEWAL_ID,
              purchase_date: RENEWAL_AT,
              original_purchase_date: ORIGINAL_AT,
              store: "app_store",
              is_sandbox: false,
            },
          ],
        },
      },
      { fulfilment: fulfilment({ productId: LIFETIME }) },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: a direct latest-transaction match still wins and a renewal cannot add a second verdict",
  async () => {
    // No renewal yet: latest == original, direct match fulfils as before.
    const direct = await sync(
      subscriber(
        renewedSubscription({ store_transaction_id: ORIGINAL_ID, purchase_date: ORIGINAL_AT }),
      ),
      { fulfilment: fulfilment() },
    );
    assertEquals(direct.status, 200);
    assertEquals(direct.body.fulfilment.outcome, "fulfilled");
    // Evidence for the RENEWAL itself (the device journaled the renewal
    // transaction) matches directly; lineage rules do not interfere.
    const renewal = await sync(subscriber(renewedSubscription()), {
      fulfilment: fulfilment({ transactionId: RENEWAL_ID, purchasedAt: RENEWAL_AT }),
    });
    assertEquals(renewal.status, 200);
    assertEquals(renewal.body.fulfilment.outcome, "fulfilled");
  },
);

Deno.test(
  "post-renewal: evidence dated after verification stays pending even with a matching lineage",
  async () => {
    const future = at(DAY);
    const result = await sync(
      subscriber(
        renewedSubscription({ original_purchase_date: future, purchase_date: at(2 * DAY) }),
      ),
      { fulfilment: fulfilment({ purchasedAt: future }) },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test("post-renewal: a subscriber with no row for the product stays pending", async () => {
  const result = await sync(
    { entitlements: {}, subscriptions: {}, non_subscriptions: {} },
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, false);
  assertEquals(result.body.fulfilment.outcome, "pending");
});
