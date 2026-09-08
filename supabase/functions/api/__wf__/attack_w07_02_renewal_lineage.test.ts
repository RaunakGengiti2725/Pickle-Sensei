// W07-02 ADVERSARY — attacks on subscriptionLineageRow() / billingFulfilmentOf()
// (candidate d0552ac2, "reconciliation follows the subscription, not the id").
//
// Every attack drives the real handler (POST /v1/billing/sync) through the
// webhookSim/routesHarness stubs exactly like the candidate's own fixtures.
// Assertions state the behaviour the product invariants require; a failing
// assertion on HEAD is a confirmed break, a passing one is an attack that held.
//
// Fixture vocabulary (Apple receipt semantics, App Store receipt docs):
//   original_transaction_id / original_purchase_date are constant for the whole
//   life of a subscription lineage — across renewals, across a lapse followed by
//   a resubscription, and across an upgrade/crossgrade inside one subscription
//   group. purchase_date / store_transaction_id name the LATEST transaction.

import { assertEquals } from "@std/assert";
import { simulate } from "./webhookSim.ts";
import { fakeSupabaseAccessToken, userRequest } from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const ANNUAL = "pickle_sensei_pro_annual";
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// Lineage: first purchase (D1) → lapse → resubscribe (D2) → renewal (D3).
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

function subscriptionRow(
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
  const row = entitledProduct === null ? null : subscriptions[entitledProduct];
  return {
    entitlements: row === null || row === undefined ? {} : {
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

async function sync(
  subscriberBody: Record<string, unknown>,
  body: unknown,
  options: { token?: string; userStatus?: number } = {},
) {
  const sim = await simulate();
  const owner = crypto.randomUUID();
  try {
    sim.h.subscriber = subscriberBody;
    sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    if (options.userStatus !== undefined) sim.h.userStatus = options.userStatus;
    const response = await sim.h.handler(
      userRequest("POST", "/v1/billing/sync", {
        body,
        token: options.token ?? fakeSupabaseAccessToken(owner),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      writes: sim.entitlementWrites.length,
      rcCalls: sim.rcCalls(),
    };
  } finally {
    sim.restore();
  }
}

// ---------------------------------------------------------------------------
// ATTACK 1 — the journaled purchase is a RESUBSCRIPTION, not the lineage's
// first transaction. Apple keeps original_purchase_date = D1 across the lapse,
// the resubscription (D2, RESUB_ID) is then replaced by a renewal (D3). The
// device's pending purchase for RESUB_ID is present nowhere in the subscriber
// and its purchasedAt is NOT the original_purchase_date. This is exactly the
// stuck shape the package set out to fix, one transaction further down the
// same lineage.
Deno.test(
  "attack: a resubscription replaced by a renewal is fulfilled against its active lineage",
  async () => {
    const request = fulfilment();
    const result = await sync(subscriber({ [MONTHLY]: subscriptionRow() }), {
      fulfilment: request,
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.transaction, request.transaction);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
  },
);

Deno.test(
  "attack: a resubscription replaced by a renewal whose lineage lapsed (no grace) is expired",
  async () => {
    const result = await sync(
      subscriber({ [MONTHLY]: subscriptionRow({}, at(-DAY)) }, { entitledProduct: null }),
      { fulfilment: fulfilment() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, false);
    assertEquals(result.body.fulfilment.outcome, "expired");
  },
);

// ATTACK 2 — upgrade inside the subscription group. MONTHLY bought at D1, then
// upgraded to ANNUAL at D2 (ANNUAL's original_purchase_date is the GROUP's
// first purchase, D1). ANNUAL later renews (D3). The device's pending ANNUAL
// purchase (RESUB_ID @ D2, the upgrade transaction) stays stuck.
Deno.test(
  "attack: an upgrade transaction replaced by the upgraded product's renewal is fulfilled",
  async () => {
    const result = await sync(
      subscriber(
        {
          [MONTHLY]: subscriptionRow(
            { store_transaction_id: FIRST_ID, purchase_date: FIRST_AT },
            RESUB_AT,
          ),
          [ANNUAL]: subscriptionRow({}, at(330 * DAY)),
        },
        { entitledProduct: ANNUAL },
      ),
      { fulfilment: fulfilment({ productId: ANNUAL }) },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.fulfilment.outcome, "fulfilled");
  },
);

// Control for attacks 1–2: the candidate's own shape (journaled purchase IS
// the lineage's first transaction) must keep working while the above fail.
Deno.test("control: the lineage's first transaction is fulfilled after a renewal", async () => {
  const result = await sync(subscriber({ [MONTHLY]: subscriptionRow() }), {
    fulfilment: fulfilment({ transactionId: FIRST_ID, purchasedAt: FIRST_AT }),
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "fulfilled");
});

// ATTACK 3 — conflicting record beside a matching lineage. The candidate's
// contract says "the evidence's own id beside another date is a conflict, not
// a renewal", but only the subscription row is examined: a non_subscriptions
// record for the same product carrying the journaled id at ANOTHER date is
// ignored once `matching` is empty, and the lineage fulfils anyway (base:
// pending).
Deno.test(
  "attack: the journaled id recorded at another date in non_subscriptions is a conflict, not a renewal",
  async () => {
    const result = await sync(
      subscriber(
        { [MONTHLY]: subscriptionRow({ original_purchase_date: RESUB_AT }) },
        {
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
        },
      ),
      { fulfilment: fulfilment() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

// ATTACK 4 — future-dated renewal. The direct path refuses evidence dated after
// the verification instant ("cannot be verified yet"); the lineage path
// accepts a latest transaction dated 400 days AFTER verifiedAt and fulfils the
// original on the strength of a renewal that has not happened.
Deno.test(
  "attack: a lineage whose latest transaction is dated far after verification does not fulfil",
  async () => {
    const result = await sync(
      subscriber({
        [MONTHLY]: subscriptionRow(
          { original_purchase_date: RESUB_AT, purchase_date: at(400 * DAY) },
          at(430 * DAY),
        ),
      }),
      { fulfilment: fulfilment() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment.outcome, "pending");
  },
);

// ATTACK 5 — replay / double submit. The same pendingId retried with two
// attemptIds (sequentially and concurrently) must yield one consistent verdict
// each bound to its own attemptId, never a verdict for another attempt.
Deno.test("attack: replayed and concurrent fulfilment attempts stay bound to their attempt", async () => {
  const pendingId = crypto.randomUUID();
  const transaction = { productId: MONTHLY, transactionId: FIRST_ID, purchasedAt: FIRST_AT };
  const body = subscriber({ [MONTHLY]: subscriptionRow() });
  const first = { pendingId, attemptId: crypto.randomUUID(), transaction };
  const second = { pendingId, attemptId: crypto.randomUUID(), transaction };
  const a = await sync(body, { fulfilment: first });
  const b = await sync(body, { fulfilment: second });
  assertEquals(a.body.fulfilment.attemptId, first.attemptId);
  assertEquals(b.body.fulfilment.attemptId, second.attemptId);
  assertEquals(a.body.fulfilment.outcome, "fulfilled");
  assertEquals(b.body.fulfilment.outcome, "fulfilled");
  assertEquals(a.writes, 1);
  assertEquals(b.writes, 1);
  const third = { pendingId, attemptId: crypto.randomUUID(), transaction };
  const fourth = { pendingId, attemptId: crypto.randomUUID(), transaction };
  const [c, d] = await Promise.all([
    sync(body, { fulfilment: third }),
    sync(body, { fulfilment: fourth }),
  ]);
  assertEquals(c.body.fulfilment.attemptId, third.attemptId);
  assertEquals(d.body.fulfilment.attemptId, fourth.attemptId);
  assertEquals(c.body.fulfilment.outcome, "fulfilled");
  assertEquals(d.body.fulfilment.outcome, "fulfilled");
});

// ATTACK 6 — unauthorised caller with lineage-shaped evidence: Supabase Auth
// rejects the bearer → 401 and RevenueCat is never consulted.
Deno.test("attack: an unauthenticated fulfilment request never reaches RevenueCat", async () => {
  const result = await sync(
    subscriber({ [MONTHLY]: subscriptionRow() }),
    { fulfilment: fulfilment({ transactionId: FIRST_ID, purchasedAt: FIRST_AT }) },
    { userStatus: 401 },
  );
  assertEquals(result.status, 401);
  assertEquals(result.rcCalls, 0);
  assertEquals(result.writes, 0);
});

// ATTACK 7 — type confusion on the latest id: RevenueCat reports the journaled
// id as a JSON number beside the renewal date. Must be a conflict (pending).
Deno.test("attack: a numeric latest id equal to the journaled id beside another date is a conflict", async () => {
  const result = await sync(
    subscriber({
      [MONTHLY]: subscriptionRow({
        original_purchase_date: RESUB_AT,
        store_transaction_id: Number(RESUB_ID),
      }),
    }),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "pending");
});

// ATTACK 8 — refund on a renewal-headed lineage with access revoked but the
// row's expires_date still in the future (contradictory provider state). Must
// not fabricate a terminal verdict for the journaled original.
Deno.test("attack: refunded lineage with access revoked but a future expiry stays unresolved", async () => {
  const result = await sync(
    subscriber(
      {
        [MONTHLY]: subscriptionRow({
          original_purchase_date: RESUB_AT,
          refunded_at: at(-2 * DAY),
        }),
      },
      { entitledProduct: null },
    ),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, false);
  assertEquals(result.body.fulfilment.outcome, "pending");
});

// ATTACK 9 — grace horizon already passed on the lapsed lineage: terminal.
Deno.test("attack: a lapsed lineage whose grace period also passed is expired", async () => {
  const result = await sync(
    subscriber(
      {
        [MONTHLY]: subscriptionRow(
          { original_purchase_date: RESUB_AT, grace_period_expires_date: at(-DAY) },
          at(-3 * DAY),
        ),
      },
      { entitledProduct: null },
    ),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "expired");
});

// ATTACK 10 — millisecond boundaries around the lineage proof.
Deno.test("attack: lineage boundaries — 1 ms later renewal accepted, 1 ms original drift rejected", async () => {
  const later = await sync(
    subscriber({
      [MONTHLY]: subscriptionRow({
        original_purchase_date: RESUB_AT,
        purchase_date: new Date(Date.parse(RESUB_AT) + 1).toISOString(),
      }),
    }),
    { fulfilment: fulfilment() },
  );
  assertEquals(later.body.fulfilment.outcome, "fulfilled");
  const drift = await sync(
    subscriber({
      [MONTHLY]: subscriptionRow({
        original_purchase_date: new Date(Date.parse(RESUB_AT) + 1).toISOString(),
      }),
    }),
    { fulfilment: fulfilment() },
  );
  assertEquals(drift.body.fulfilment.outcome, "pending");
});

// ATTACK 11 — representation drift: RevenueCat's REST v1 dates carry second
// precision ("…:41Z") while the device normalises to "…:41.000Z". Equal instants
// must match; a sub-second instant RevenueCat cannot represent must not.
Deno.test("attack: second-precision provider dates match the device's normalised evidence", async () => {
  const whole = new Date(Math.floor(Date.parse(RESUB_AT) / 1000) * 1000);
  const rcStyle = whole.toISOString().replace(/\.000Z$/, "Z");
  const matched = await sync(
    subscriber({ [MONTHLY]: subscriptionRow({ original_purchase_date: rcStyle }) }),
    { fulfilment: fulfilment({ purchasedAt: whole.toISOString() }) },
  );
  assertEquals(matched.body.fulfilment.outcome, "fulfilled");
  const subSecond = await sync(
    subscriber({ [MONTHLY]: subscriptionRow({ original_purchase_date: rcStyle }) }),
    { fulfilment: fulfilment({ purchasedAt: new Date(whole.getTime() + 500).toISOString() }) },
  );
  assertEquals(subSecond.body.fulfilment.outcome, "pending");
});

// ATTACK 12 — cross-product misattribution inside one subscription group. Both
// rows share the GROUP's original_purchase_date (Apple semantics). Evidence for
// MONTHLY must resolve only through the MONTHLY row, never the ANNUAL lineage.
Deno.test("attack: a sibling product sharing the group's original date never fulfils this product", async () => {
  const result = await sync(
    subscriber(
      {
        [MONTHLY]: subscriptionRow(
          { store_transaction_id: FIRST_ID, purchase_date: FIRST_AT },
          RESUB_AT,
        ),
        [ANNUAL]: subscriptionRow({}, at(330 * DAY)),
      },
      { entitledProduct: ANNUAL },
    ),
    { fulfilment: fulfilment({ transactionId: "2000000899999999", purchasedAt: FIRST_AT }) },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, true);
  assertEquals(result.body.fulfilment.outcome, "pending");
});

// ATTACK 13 — lineage with an unparseable expires_date while the entitlement is
// active: fulfilment must still require the verdict's active entitlement for
// THIS product, and a lapsed lineage with garbage expiry stays pending.
Deno.test("attack: malformed expiry on the lineage never becomes a terminal verdict", async () => {
  const result = await sync(
    subscriber(
      { [MONTHLY]: subscriptionRow({ original_purchase_date: RESUB_AT }, "soon") },
      { entitledProduct: null },
    ),
    { fulfilment: fulfilment() },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment.outcome, "pending");
});
