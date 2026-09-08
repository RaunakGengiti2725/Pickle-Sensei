// W07-02 — a renewal replaces the latest transaction RevenueCat reports for a
// subscription. The subscriber's `subscriptions[product]` row then carries the
// RENEWAL's `store_transaction_id`/`purchase_date`, so the transaction id the
// device has been retrying for its purchase is no longer present anywhere in
// the subscriber. Reconciliation must follow the subscription lineage instead
// of the id, or the pending journal entry stays pending for as long as the
// customer keeps paying.
//
// Apple keeps original_transaction_id / original_purchase_date constant for the
// whole life of a subscription lineage — across renewals, across a lapse
// followed by a resubscription, and across an upgrade/crossgrade inside one
// subscription group — while purchase_date / store_transaction_id name the
// LATEST transaction. The journaled purchase therefore belongs to the lineage
// when it lies within [original_purchase_date, purchase_date) and a later,
// differently identified transaction that has already happened replaced it.
// Post-renewal fixtures cover the first purchase, a resubscription, an upgrade,
// the fulfilled / expired / grace / refund shapes and every mismatch.

import { assertEquals } from "@std/assert";
import { simulate } from "./webhookSim.ts";
import { fakeSupabaseAccessToken, RC_URL, userRequest } from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const ANNUAL = "pickle_sensei_pro_annual";
const LIFETIME = "pickle_sensei_pro_lifetime";
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

// Lineage: first purchase (D1) → lapse → resubscription (D2) → renewal (D3).
// The device journaled the RESUBSCRIPTION; the renewal then replaced it as the
// lineage's latest transaction.
const FIRST_ID = "2000000811111111";
const FIRST_AT = at(-120 * DAY);
const RESUB_ID = "2000000833333333";
const RESUB_AT = at(-35 * DAY);
const RENEWAL_ID = "2000000822222222";
const RENEWAL_AT = at(-5 * DAY);

type Evidence = { productId: string; transactionId: string; purchasedAt: string };

function fulfilment(overrides: Partial<Evidence> = {}) {
  return {
    pendingId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    transaction: {
      productId: MONTHLY,
      transactionId: RESUB_ID,
      purchasedAt: RESUB_AT,
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
    original_purchase_date: FIRST_AT,
    expires_date: expiresDate,
    grace_period_expires_date: null,
    unsubscribe_detected_at: null,
    billing_issues_detected_at: null,
    refunded_at: null,
    ...overrides,
  };
}

function subscriber(
  subscriptions: Record<string, Record<string, unknown>>,
  options: { entitledProduct?: string | null; nonSubscriptions?: Record<string, unknown[]> } = {},
): Record<string, unknown> {
  const entitledProduct = options.entitledProduct === undefined ? MONTHLY : options.entitledProduct;
  const row = entitledProduct === null ? undefined : subscriptions[entitledProduct];
  return {
    entitlements:
      row === undefined
        ? {}
        : {
            pickle_sensei_pro: {
              expires_date: row.expires_date,
              purchase_date: row.purchase_date,
              product_identifier: entitledProduct,
            },
          },
    subscriptions,
    non_subscriptions: options.nonSubscriptions ?? {},
  };
}

const monthly = (
  overrides: Record<string, unknown> = {},
  expiresDate: string | null = at(25 * DAY),
  options: { entitledProduct?: string | null; nonSubscriptions?: Record<string, unknown[]> } = {},
) => subscriber({ [MONTHLY]: renewedSubscription(overrides, expiresDate) }, options);

async function sync(
  subscriberBody: Record<string, unknown>,
  body: unknown,
  options: { requestDateMs?: number } = {},
) {
  const sim = await simulate();
  const owner = crypto.randomUUID();
  try {
    sim.h.subscriber = subscriberBody;
    sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    if (options.requestDateMs !== undefined) {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        subscriber: subscriberBody,
        requestDateMs: options.requestDateMs,
      });
    }
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

// ── the lineage fulfils what the id no longer can ─────────────────────────────

Deno.test(
  "post-renewal: the lineage's first purchase is fulfilled once a renewal replaced it",
  async () => {
    const request = fulfilment({ transactionId: FIRST_ID, purchasedAt: FIRST_AT });
    const result = await sync(monthly(), { fulfilment: request });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
    assertEquals(result.body.fulfilment.pendingId, request.pendingId);
    assertEquals(result.body.fulfilment.attemptId, request.attemptId);
    // The verdict is about the transaction the device journaled, not the
    // renewal that now heads the lineage.
    assertEquals(result.body.fulfilment.transaction, request.transaction);
    assertEquals(result.writes, 1);
  },
);

Deno.test(
  "post-renewal: a resubscription replaced by a renewal is fulfilled against its active lineage",
  async () => {
    const request = fulfilment();
    const result = await sync(monthly(), { fulfilment: request });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
    assertEquals(result.body.fulfilment.transaction, request.transaction);
    assertEquals(result.writes, 1);
  },
);

Deno.test(
  "post-renewal: a resubscription whose lineage lapsed with no grace is expired",
  async () => {
    const result = await sync(monthly({}, at(-DAY), { entitledProduct: null }), {
      fulfilment: fulfilment(),
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, false);
    assertEquals(result.body.fulfilment.outcome, "expired");
  },
);

Deno.test(
  "post-renewal: an upgrade transaction replaced by the upgraded product's renewal is fulfilled",
  async () => {
    // MONTHLY bought at D1, upgraded to ANNUAL at D2 (the group keeps D1 as its
    // original purchase), ANNUAL renewed at D3. The device journaled the ANNUAL
    // upgrade transaction.
    const result = await sync(
      subscriber(
        {
          [MONTHLY]: renewedSubscription(
            { store_transaction_id: FIRST_ID, purchase_date: FIRST_AT },
            RESUB_AT,
          ),
          [ANNUAL]: renewedSubscription({}, at(330 * DAY)),
        },
        { entitledProduct: ANNUAL },
      ),
      { fulfilment: fulfilment({ productId: ANNUAL }) },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.billing.productKey, ANNUAL);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
  },
);

Deno.test(
  "post-renewal: a sibling product sharing the group's original date never fulfils this product",
  async () => {
    // Evidence for MONTHLY resolves only through the MONTHLY row: its latest
    // transaction is not later than the journaled one, so nothing replaced it.
    const result = await sync(
      subscriber(
        {
          [MONTHLY]: renewedSubscription(
            { store_transaction_id: FIRST_ID, purchase_date: FIRST_AT },
            RESUB_AT,
          ),
          [ANNUAL]: renewedSubscription({}, at(330 * DAY)),
        },
        { entitledProduct: ANNUAL },
      ),
      { fulfilment: fulfilment({ transactionId: "2000000899999999", purchasedAt: FIRST_AT }) },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: a numeric renewal store_transaction_id still identifies the lineage",
  async () => {
    const result = await sync(monthly({ store_transaction_id: Number(RENEWAL_ID) }), {
      fulfilment: fulfilment(),
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
  },
);

Deno.test("post-renewal: the lineage is product-specific (annual fixture)", async () => {
  const result = await sync(
    subscriber({ [ANNUAL]: renewedSubscription({}, at(300 * DAY)) }, { entitledProduct: ANNUAL }),
    { fulfilment: fulfilment({ productId: ANNUAL }) },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "fulfilled");
});

// ── lapsed lineages ───────────────────────────────────────────────────────────

Deno.test("post-renewal: a lapsed lineage inside its grace period stays pending", async () => {
  const result = await sync(
    monthly({ grace_period_expires_date: at(3 * DAY) }, at(-DAY), { entitledProduct: null }),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "pending");
});

Deno.test("post-renewal: a lapsed lineage whose grace period also passed is expired", async () => {
  const result = await sync(
    monthly({ grace_period_expires_date: at(-DAY) }, at(-3 * DAY), { entitledProduct: null }),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "expired");
});

Deno.test("post-renewal: a lapsed lineage with a malformed grace date stays pending", async () => {
  const result = await sync(
    monthly({ grace_period_expires_date: "later" }, at(-DAY), { entitledProduct: null }),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "pending");
});

Deno.test(
  "post-renewal: a lapsed lineage with a malformed expiry never becomes a terminal verdict",
  async () => {
    const result = await sync(monthly({}, "soon", { entitledProduct: null }), {
      fulfilment: fulfilment(),
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, false);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: a refund recorded on the lineage is not attributed to the journaled transaction",
  async () => {
    // Refund while RevenueCat still reports the entitlement active: contradictory
    // for the journaled purchase, so nothing terminal is claimed about it.
    const active = await sync(monthly({ refunded_at: at(-2 * DAY) }), {
      fulfilment: fulfilment(),
    });
    assertEquals(active.status, 200);
    assertEquals(active.body.fulfilment.outcome, "fulfilled");
    // Refund of the (renewal-headed) lineage with access gone: the journaled
    // purchase's period ended, but the refund belongs to whichever transaction
    // RevenueCat refunded, never provably to the journaled one — "expired", not
    // "refunded".
    const revoked = await sync(
      monthly({ refunded_at: at(-2 * DAY) }, at(-2 * DAY), { entitledProduct: null }),
      { fulfilment: fulfilment() },
    );
    assertEquals(revoked.status, 200);
    assertEquals(revoked.body.fulfilment.outcome, "expired");
    // Access revoked but the row's expiry still ahead: contradictory provider
    // state stays unresolved.
    const contradictory = await sync(
      monthly({ refunded_at: at(-2 * DAY) }, at(25 * DAY), { entitledProduct: null }),
      { fulfilment: fulfilment() },
    );
    assertEquals(contradictory.status, 200);
    assertEquals(contradictory.body.billing.premium, false);
    assertEquals(contradictory.body.fulfilment.outcome, "pending");
    // Refund with no usable expiry stays unresolved.
    const unresolved = await sync(
      monthly({ refunded_at: at(-2 * DAY) }, null, { entitledProduct: null }),
      { fulfilment: fulfilment() },
    );
    assertEquals(unresolved.status, 200);
    assertEquals(unresolved.body.fulfilment.outcome, "pending");
  },
);

// ── the lineage window: original_purchase_date <= journaled < latest ──────────

Deno.test(
  "post-renewal: an original purchase after the journaled one is a different lineage",
  async () => {
    const later = await sync(monthly({ original_purchase_date: at(-30 * DAY) }), {
      fulfilment: fulfilment(),
    });
    assertEquals(later.status, 200);
    assertEquals(later.body.billing.premium, true);
    assertEquals(later.body.fulfilment.outcome, "pending");
    assertEquals(later.body.fulfilment.transaction.transactionId, RESUB_ID);
    // Millisecond boundaries: the lineage's first purchase may coincide with
    // the journaled one, never follow it.
    const same = await sync(monthly({ original_purchase_date: RESUB_AT }), {
      fulfilment: fulfilment(),
    });
    assertEquals(same.body.fulfilment.outcome, "fulfilled");
    const drift = await sync(monthly({ original_purchase_date: plus(RESUB_AT, 1) }), {
      fulfilment: fulfilment(),
    });
    assertEquals(drift.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: second-precision provider dates still bound the device's normalised evidence",
  async () => {
    const whole = new Date(Math.floor(Date.parse(RESUB_AT) / 1000) * 1000).toISOString();
    const rcStyle = whole.replace(/\.000Z$/, "Z");
    const result = await sync(monthly({ original_purchase_date: rcStyle }), {
      fulfilment: fulfilment({ purchasedAt: whole }),
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
  },
);

Deno.test(
  "post-renewal: a missing or malformed original_purchase_date never proves the lineage",
  async () => {
    for (const original_purchase_date of [undefined, null, "", "2026-08-01", 1_754_006_400_000]) {
      const row = renewedSubscription({ original_purchase_date });
      if (original_purchase_date === undefined) delete row.original_purchase_date;
      const result = await sync(subscriber({ [MONTHLY]: row }), { fulfilment: fulfilment() });
      assertEquals(result.status, 200);
      assertEquals(result.body.fulfilment.outcome, "pending", String(original_purchase_date));
    }
  },
);

Deno.test(
  "post-renewal: a latest transaction that is not later than the journaled one is not a renewal",
  async () => {
    // Same-dated different id: conflicting records for one purchase, not a lineage.
    const same = await sync(monthly({ purchase_date: RESUB_AT }), { fulfilment: fulfilment() });
    assertEquals(same.status, 200);
    assertEquals(same.body.fulfilment.outcome, "pending");
    // Latest purchase before the journaled one: nothing replaced it.
    const earlier = await sync(monthly({ purchase_date: at(-36 * DAY) }), {
      fulfilment: fulfilment(),
    });
    assertEquals(earlier.status, 200);
    assertEquals(earlier.body.fulfilment.outcome, "pending");
    // Malformed latest purchase date.
    const malformed = await sync(monthly({ purchase_date: "yesterday" }), {
      fulfilment: fulfilment(),
    });
    assertEquals(malformed.status, 200);
    assertEquals(malformed.body.fulfilment.outcome, "pending");
    // One millisecond later is a renewal.
    const later = await sync(monthly({ purchase_date: plus(RESUB_AT, 1) }), {
      fulfilment: fulfilment(),
    });
    assertEquals(later.body.fulfilment.outcome, "fulfilled");
  },
);

Deno.test(
  "post-renewal: a latest transaction dated after verification has not happened yet",
  async () => {
    const future = await sync(monthly({ purchase_date: at(400 * DAY) }, at(430 * DAY)), {
      fulfilment: fulfilment(),
    });
    assertEquals(future.status, 200);
    assertEquals(future.body.billing.premium, true);
    assertEquals(future.body.fulfilment.outcome, "pending");
    // The same bound as the direct match: a latest transaction AT the
    // verification instant counts, one millisecond after it does not.
    const verifiedAtMs = Date.now() - 60_000;
    const verifiedAt = new Date(verifiedAtMs).toISOString();
    const exact = await sync(
      monthly({ purchase_date: verifiedAt }),
      { fulfilment: fulfilment() },
      { requestDateMs: verifiedAtMs },
    );
    assertEquals(exact.body.fulfilment.verifiedAt, verifiedAt);
    assertEquals(exact.body.fulfilment.outcome, "fulfilled");
    const ahead = await sync(
      monthly({ purchase_date: plus(verifiedAt, 1) }),
      { fulfilment: fulfilment() },
      { requestDateMs: verifiedAtMs },
    );
    assertEquals(ahead.body.fulfilment.verifiedAt, verifiedAt);
    assertEquals(ahead.body.fulfilment.outcome, "pending");
  },
);

// ── the journaled id seen elsewhere is a conflict, never a renewal ────────────

Deno.test(
  "post-renewal: the journaled id beside a later purchase date is a conflict, not a renewal",
  async () => {
    for (const store_transaction_id of [RESUB_ID, Number(RESUB_ID)]) {
      const result = await sync(monthly({ store_transaction_id }), { fulfilment: fulfilment() });
      assertEquals(result.status, 200);
      assertEquals(result.body.fulfilment.outcome, "pending", typeof store_transaction_id);
    }
  },
);

Deno.test(
  "post-renewal: the journaled id recorded at another date in non_subscriptions is a conflict",
  async () => {
    const result = await sync(
      monthly({}, at(25 * DAY), {
        nonSubscriptions: {
          [MONTHLY]: [
            {
              id: "rc_conflict_1",
              store_transaction_id: RESUB_ID,
              purchase_date: at(-50 * DAY),
              store: "app_store",
              is_sandbox: false,
            },
          ],
        },
      }),
      { fulfilment: fulfilment() },
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
      const result = await sync(subscriber({ [MONTHLY]: row }), { fulfilment: fulfilment() });
      assertEquals(result.status, 200);
      assertEquals(result.body.fulfilment.outcome, "pending", String(store_transaction_id));
    }
  },
);

// ── product and entitlement scoping ───────────────────────────────────────────

Deno.test(
  "post-renewal: the lineage under another product never fulfils this product's purchase",
  async () => {
    const result = await sync(
      subscriber({ [ANNUAL]: renewedSubscription({}, at(300 * DAY)) }, { entitledProduct: ANNUAL }),
      { fulfilment: fulfilment() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: an active lineage whose entitlement names another product stays pending",
  async () => {
    const body = monthly();
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
              original_purchase_date: FIRST_AT,
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

// ── the direct match is untouched ─────────────────────────────────────────────

Deno.test(
  "post-renewal: a direct latest-transaction match still wins and a renewal cannot add a second verdict",
  async () => {
    // No renewal yet: latest == journaled, direct match fulfils as before.
    const direct = await sync(
      monthly({ store_transaction_id: RESUB_ID, purchase_date: RESUB_AT }),
      { fulfilment: fulfilment() },
    );
    assertEquals(direct.status, 200);
    assertEquals(direct.body.fulfilment.outcome, "fulfilled");
    // Evidence for the RENEWAL itself (the device journaled the renewal
    // transaction) matches directly; lineage rules do not interfere.
    const renewal = await sync(monthly(), {
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
      monthly({ original_purchase_date: future, purchase_date: at(2 * DAY) }, at(30 * DAY)),
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
