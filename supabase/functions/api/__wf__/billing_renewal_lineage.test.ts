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

// A refund recorded on the lineage row is examined under EXACTLY the rule the
// exact-id row is held to — a lineage may only ever be stricter than the direct
// match, never looser — and is never attributed to the journaled transaction:
// RevenueCat refunded whichever transaction it refunded, so the journaled
// purchase can settle as "expired" through the lineage's access state, never as
// "refunded".

Deno.test(
  "post-renewal: a refunded lineage row whose entitlement is still active is contradictory and stays pending, exactly like the exact-id row",
  async () => {
    const refundedAt = at(-2 * DAY);
    const direct = await sync(
      monthly({ store_transaction_id: RESUB_ID, purchase_date: RESUB_AT, refunded_at: refundedAt }),
      { fulfilment: fulfilment() },
    );
    assertEquals(direct.status, 200);
    assertEquals(direct.body.billing.premium, true);
    assertEquals(direct.body.fulfilment.outcome, "pending");
    const lineage = await sync(monthly({ refunded_at: refundedAt }), { fulfilment: fulfilment() });
    assertEquals(lineage.status, 200);
    assertEquals(lineage.body.billing.premium, true);
    assertEquals(lineage.body.fulfilment.outcome, direct.body.fulfilment.outcome);
    assertEquals(lineage.writes, 1);
  },
);

Deno.test(
  "post-renewal: a malformed, future-dated or pre-purchase refund on the lineage row settles nothing",
  async () => {
    // The exact-id rule holds each of these as contradictory (pending); the
    // lineage rule must hold them no more permissively — access gone or not.
    for (const refunded_at of ["yesterday", "", 1_754_006_400_000, at(DAY), at(-40 * DAY)]) {
      const label = String(refunded_at);
      const direct = await sync(
        monthly(
          { store_transaction_id: RESUB_ID, purchase_date: RESUB_AT, refunded_at },
          at(-2 * DAY),
          { entitledProduct: null },
        ),
        { fulfilment: fulfilment() },
      );
      assertEquals(direct.status, 200, label);
      assertEquals(direct.body.fulfilment.outcome, "pending", label);
      const lapsed = await sync(monthly({ refunded_at }, at(-2 * DAY), { entitledProduct: null }), {
        fulfilment: fulfilment(),
      });
      assertEquals(lapsed.status, 200, label);
      assertEquals(lapsed.body.billing.premium, false, label);
      assertEquals(lapsed.body.fulfilment.outcome, "pending", label);
      const active = await sync(monthly({ refunded_at }), { fulfilment: fulfilment() });
      assertEquals(active.status, 200, label);
      assertEquals(active.body.fulfilment.outcome, "pending", label);
    }
    // Boundaries mirror the exact-id rule: a refund at the journaled purchase
    // instant or at the verification instant is examined, one millisecond
    // before the purchase or after verification is not.
    const verifiedAtMs = Date.now() - 60_000;
    const verifiedAt = new Date(verifiedAtMs).toISOString();
    for (const [refunded_at, expected] of [
      [RESUB_AT, "expired"],
      [plus(RESUB_AT, -1), "pending"],
      [verifiedAt, "expired"],
      [plus(verifiedAt, 1), "pending"],
    ] as const) {
      const result = await sync(
        monthly({ refunded_at }, at(-2 * DAY), { entitledProduct: null }),
        { fulfilment: fulfilment() },
        { requestDateMs: verifiedAtMs },
      );
      assertEquals(result.body.fulfilment.verifiedAt, verifiedAt, refunded_at);
      assertEquals(result.body.fulfilment.outcome, expected, refunded_at);
    }
  },
);

Deno.test(
  "post-renewal: a refund recorded on the lineage is never attributed to the journaled transaction",
  async () => {
    // Refund of the (renewal-headed) lineage with access gone: the journaled
    // purchase's period ended, but the refund belongs to whichever transaction
    // RevenueCat refunded, never provably to the journaled one — "expired", not
    // "refunded". The exact-id row for the same evidence IS the refunded
    // transaction and settles as "refunded".
    const direct = await sync(
      monthly(
        { store_transaction_id: RESUB_ID, purchase_date: RESUB_AT, refunded_at: at(-2 * DAY) },
        at(-2 * DAY),
        { entitledProduct: null },
      ),
      { fulfilment: fulfilment() },
    );
    assertEquals(direct.status, 200);
    assertEquals(direct.body.fulfilment.outcome, "refunded");
    const revoked = await sync(
      monthly({ refunded_at: at(-2 * DAY) }, at(-2 * DAY), { entitledProduct: null }),
      { fulfilment: fulfilment() },
    );
    assertEquals(revoked.status, 200);
    assertEquals(revoked.body.billing.premium, false);
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
    // A refunded lineage whose access ended no later than the journaled
    // purchase began never covered it: contradictory, not expired.
    const before = await sync(
      monthly({ refunded_at: at(-2 * DAY) }, at(-40 * DAY), { entitledProduct: null }),
      { fulfilment: fulfilment() },
    );
    assertEquals(before.body.fulfilment.outcome, "pending");
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

// Store transaction ids are unique across a subscriber's products, so the
// device's claim "this id is a MONTHLY purchase" is contradicted the moment
// RevenueCat attributes the same id to ANY other product or record. The
// device-claimed product's lineage must then never speak for it.

Deno.test(
  "post-renewal: the journaled id attributed to another subscription product is a conflict",
  async () => {
    for (const store_transaction_id of [RESUB_ID, Number(RESUB_ID)]) {
      const result = await sync(
        subscriber({
          [MONTHLY]: renewedSubscription(),
          [ANNUAL]: renewedSubscription(
            {
              store_transaction_id,
              purchase_date: at(-50 * DAY),
              original_purchase_date: at(-50 * DAY),
            },
            at(-20 * DAY),
          ),
        }),
        { fulfilment: fulfilment() },
      );
      assertEquals(result.status, 200, typeof store_transaction_id);
      assertEquals(result.body.billing.premium, true, typeof store_transaction_id);
      assertEquals(result.body.fulfilment.outcome, "pending", typeof store_transaction_id);
    }
  },
);

Deno.test(
  "post-renewal: a lapsed lineage never expires a transaction the provider attributes to an active product",
  async () => {
    // MONTHLY lapsed two days ago; ANNUAL owns the journaled id and carries the
    // live entitlement. "expired" is terminal on the device, so settling the
    // journaled purchase through the lapsed lineage would discard a purchase
    // the provider itself records as belonging to an active product.
    const result = await sync(
      subscriber(
        {
          [MONTHLY]: renewedSubscription({}, at(-2 * DAY)),
          [ANNUAL]: renewedSubscription(
            {
              store_transaction_id: RESUB_ID,
              purchase_date: at(-50 * DAY),
              original_purchase_date: at(-50 * DAY),
            },
            at(300 * DAY),
          ),
        },
        { entitledProduct: ANNUAL },
      ),
      { fulfilment: fulfilment() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

Deno.test(
  "post-renewal: the journaled id recorded as another product's non-subscription purchase is a conflict",
  async () => {
    for (const identity of [
      { id: "rc_lifetime_conflict", store_transaction_id: RESUB_ID },
      { id: "rc_lifetime_conflict", store_transaction_id: Number(RESUB_ID) },
      // RevenueCat's own purchase id is the identity of a lifetime record that
      // carries no store transaction id.
      { id: RESUB_ID },
    ]) {
      const result = await sync(
        monthly({}, at(25 * DAY), {
          nonSubscriptions: {
            [LIFETIME]: [
              { ...identity, purchase_date: at(-50 * DAY), store: "app_store", is_sandbox: false },
            ],
          },
        }),
        { fulfilment: fulfilment() },
      );
      assertEquals(result.status, 200, JSON.stringify(identity));
      assertEquals(result.body.fulfilment.outcome, "pending", JSON.stringify(identity));
    }
  },
);

Deno.test(
  "post-renewal: a lineage that ended before the journaled purchase cannot settle it",
  async () => {
    // First purchase D-120, latest renewal D-5, yet the subscription ended at
    // D-40 — before the journaled D-35 purchase began. A period that ended
    // before the purchase says nothing about the purchase's own period; it is
    // a contradictory record, not an expiry.
    const expiry = await sync(monthly({}, at(-40 * DAY), { entitledProduct: null }), {
      fulfilment: fulfilment(),
    });
    assertEquals(expiry.status, 200);
    assertEquals(expiry.body.billing.premium, false);
    assertEquals(expiry.body.fulfilment.outcome, "pending");
    // A grace period that also ended before the purchase does not rescue it.
    const grace = await sync(
      monthly({ grace_period_expires_date: at(-38 * DAY) }, at(-40 * DAY), {
        entitledProduct: null,
      }),
      { fulfilment: fulfilment() },
    );
    assertEquals(grace.body.fulfilment.outcome, "pending");
    // Boundaries: a horizon exactly at the journaled purchase is contradictory
    // too (the purchase's period cannot end the instant it began); one
    // millisecond later the purchase's period plausibly ran and ended.
    const atPurchase = await sync(monthly({}, RESUB_AT, { entitledProduct: null }), {
      fulfilment: fulfilment(),
    });
    assertEquals(atPurchase.body.fulfilment.outcome, "pending");
    const after = await sync(monthly({}, plus(RESUB_AT, 1), { entitledProduct: null }), {
      fulfilment: fulfilment(),
    });
    assertEquals(after.body.fulfilment.outcome, "expired");
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
