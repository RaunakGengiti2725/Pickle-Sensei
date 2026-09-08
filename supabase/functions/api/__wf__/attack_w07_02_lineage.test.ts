// W07-02 adversary — attacks on the subscription-lineage fulfilment rule
// (`subscriptionLineageRow` + the widened `billingFulfilmentOf`) at commit
// 712366f2. Every test encodes what the reconciliation contract REQUIRES
// (ambiguous or contradictory provider evidence => the journaled purchase stays
// `pending`; only an unambiguous lineage may fulfil or terminally settle it) and
// runs the real edge handler through the webhook simulation. A failing test
// here is a confirmed break of the candidate, not a style opinion.
//
// Attack map (see the report for the base-vs-head verdict of each):
//   A1  prototype-named product ids never reach a lineage / never 500
//   A2  a lineage whose expiry predates the journaled purchase is contradictory
//   A3  the journaled id recorded under ANOTHER product is a conflict (a/b/c)
//   A4  the journaled id recorded in ANOTHER product's non_subscriptions is a conflict
//   A5  double submit of the same fulfilment (concurrent syncs) stays consistent
//   A6  a lineage without a renewal (first == latest) with a foreign id is not a renewal
//   A7  RevenueCat clock 23h behind the isolate: a fresh renewal is not yet provable
//   A8  offset-formatted provider dates are normalised before the window check
//   A9  a lapsed lineage with no usable expiry never becomes a terminal verdict
//   A10 anonymous / malformed callers cannot obtain a lineage verdict
//   A11 a sandbox lineage heading production evidence (observed, recorded)
//   A12 evidence AT the verification instant leaves no room for a later renewal

import { assert, assertEquals } from "@std/assert";
import { simulate } from "./webhookSim.ts";
import { fakeSupabaseAccessToken, RC_URL, userRequest } from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const ANNUAL = "pickle_sensei_pro_annual";
const LIFETIME = "pickle_sensei_pro_lifetime";
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

const FIRST_ID = "2000000811111111";
const FIRST_AT = at(-120 * DAY);
const JOURNALED_ID = "2000000833333333";
const JOURNALED_AT = at(-35 * DAY);
const RENEWAL_ID = "2000000822222222";
const RENEWAL_AT = at(-5 * DAY);

type Evidence = { productId: string; transactionId: string; purchasedAt: string };

function evidence(overrides: Partial<Evidence> = {}) {
  return {
    pendingId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    transaction: {
      productId: MONTHLY,
      transactionId: JOURNALED_ID,
      purchasedAt: JOURNALED_AT,
      ...overrides,
    },
  };
}

function lineageRow(
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

function subscriberOf(
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

async function sync(
  subscriberBody: Record<string, unknown>,
  body: unknown,
  options: { requestDateMs?: number; token?: string | null } = {},
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
    const headers: Record<string, string> = {};
    const request = userRequest("POST", "/v1/billing/sync", {
      body,
      token: options.token === undefined ? fakeSupabaseAccessToken(owner) : undefined,
      headers,
    });
    if (options.token === null) request.headers.delete("Authorization");
    else if (options.token !== undefined) request.headers.set("Authorization", options.token);
    const response = await sim.h.handler(request);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return {
      status: response.status,
      body: parsed as Record<string, unknown> & {
        billing?: Record<string, unknown>;
        fulfilment?: Record<string, unknown>;
      },
      writes: sim.entitlementWrites.length,
      rcCalls: sim.rcCalls(),
      errors: sim.errors,
    };
  } finally {
    sim.restore();
  }
}

const outcome = (r: Awaited<ReturnType<typeof sync>>) =>
  (r.body.fulfilment as Record<string, unknown> | undefined)?.outcome;

// ── A1: prototype-named product ids ───────────────────────────────────────────

Deno.test("ATTACK A1: prototype-named product ids never reach a lineage nor crash", async () => {
  for (const productId of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
    const result = await sync(subscriberOf({ [MONTHLY]: lineageRow() }), {
      fulfilment: evidence({ productId }),
    });
    assertEquals(result.status, 200, productId);
    assertEquals(outcome(result), "pending", productId);
    assertEquals(result.body.billing?.premium, true, productId);
  }
});

// ── A2: expiry before the journaled purchase ──────────────────────────────────

Deno.test(
  "ATTACK A2: a lineage that expired BEFORE the journaled purchase cannot settle it as expired",
  async () => {
    // Row says: first purchase D-120, latest renewal D-5, but the subscription
    // ENDED at D-40 — i.e. before the journaled D-35 purchase and before its own
    // latest renewal. A period that ended before the purchase began is not
    // evidence that the purchase's period ended; it is a contradictory record.
    const result = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({}, at(-40 * DAY)) }, { entitledProduct: null }),
      { fulfilment: evidence() },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing?.premium, false);
    assertEquals(outcome(result), "pending");
  },
);

// ── A3: the journaled id is a different product's transaction ─────────────────

Deno.test(
  "ATTACK A3: the journaled id recorded under another product's subscription is a conflict",
  async () => {
    // RevenueCat attributes JOURNALED_ID to an ANNUAL purchase made at D-50.
    // Store transaction ids are unique across products, so the device's claim
    // "JOURNALED_ID is a MONTHLY purchase at D-35" is contradicted by the
    // provider — the MONTHLY lineage must not speak for it.
    const conflicting = subscriberOf({
      [MONTHLY]: lineageRow(),
      [ANNUAL]: lineageRow(
        {
          store_transaction_id: JOURNALED_ID,
          purchase_date: at(-50 * DAY),
          original_purchase_date: at(-50 * DAY),
        },
        at(-20 * DAY),
      ),
    });
    const result = await sync(conflicting, { fulfilment: evidence() });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing?.premium, true);
    assertEquals(outcome(result), "pending");
  },
);

Deno.test(
  "ATTACK A3b: the cross-product conflict is also a conflict when the other product's id is numeric",
  async () => {
    const numeric = subscriberOf({
      [MONTHLY]: lineageRow(),
      [ANNUAL]: lineageRow(
        {
          store_transaction_id: Number(JOURNALED_ID),
          purchase_date: at(-50 * DAY),
          original_purchase_date: at(-50 * DAY),
        },
        at(-20 * DAY),
      ),
    });
    const numericResult = await sync(numeric, { fulfilment: evidence() });
    assertEquals(outcome(numericResult), "pending");
  },
);

Deno.test(
  "ATTACK A3c: a lapsed lineage never settles as expired a transaction the provider attributes to an ACTIVE product",
  async () => {
    // The MONTHLY lineage lapsed; ANNUAL owns the journaled id and is the
    // active product. A terminal "expired" for a transaction the provider
    // says belongs to an ACTIVE product is fabricated.
    const lapsed = subscriberOf(
      {
        [MONTHLY]: lineageRow({}, at(-2 * DAY)),
        [ANNUAL]: lineageRow(
          {
            store_transaction_id: JOURNALED_ID,
            purchase_date: at(-50 * DAY),
            original_purchase_date: at(-50 * DAY),
          },
          at(300 * DAY),
        ),
      },
      { entitledProduct: ANNUAL },
    );
    const lapsedResult = await sync(lapsed, { fulfilment: evidence() });
    assertEquals(lapsedResult.status, 200);
    assertEquals(lapsedResult.body.billing?.premium, true);
    assertEquals(outcome(lapsedResult), "pending");
  },
);

// ── A4: the journaled id is another product's lifetime purchase ───────────────

Deno.test(
  "ATTACK A4: the journaled id recorded as another product's non-subscription purchase is a conflict",
  async () => {
    const result = await sync(
      subscriberOf(
        { [MONTHLY]: lineageRow() },
        {
          nonSubscriptions: {
            [LIFETIME]: [
              {
                id: "rc_lifetime_conflict",
                store_transaction_id: JOURNALED_ID,
                purchase_date: at(-50 * DAY),
                store: "app_store",
                is_sandbox: false,
              },
            ],
          },
        },
      ),
      { fulfilment: evidence() },
    );
    assertEquals(result.status, 200);
    assertEquals(outcome(result), "pending");
  },
);

// ── A5: double submit ─────────────────────────────────────────────────────────

Deno.test(
  "ATTACK A5: two concurrent syncs carrying the same fulfilment agree and never fabricate",
  async () => {
    const sim = await simulate();
    const owner = crypto.randomUUID();
    try {
      sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      const request = evidence();
      const token = fakeSupabaseAccessToken(owner);
      const responses = await Promise.all(
        [0, 1].map(() =>
          sim.h.handler(
            userRequest("POST", "/v1/billing/sync", { body: { fulfilment: request }, token }),
          ),
        ),
      );
      const bodies = await Promise.all(responses.map((r) => r.json()));
      for (const [index, body] of bodies.entries()) {
        assertEquals(responses[index].status, 200);
        assertEquals(body.billing.premium, true);
        assertEquals(body.fulfilment.pendingId, request.pendingId);
        assertEquals(body.fulfilment.attemptId, request.attemptId);
        assertEquals(body.fulfilment.transaction, request.transaction);
        assert(
          body.fulfilment.outcome === "fulfilled" || body.fulfilment.outcome === "pending",
          `outcome ${body.fulfilment.outcome}`,
        );
        // A non-pending verdict must be stamped no earlier than the purchase.
        assert(Date.parse(body.fulfilment.verifiedAt) >= Date.parse(JOURNALED_AT));
      }
      // Whatever landed, the persisted entitlement is the same active truth.
      assert(sim.entitlementWrites.length >= 1);
      for (const row of sim.entitlementWrites) assertEquals(row.premium, true);
      assertEquals(sim.errors, []);
    } finally {
      sim.restore();
    }
  },
);

// ── A6: no renewal happened ───────────────────────────────────────────────────

Deno.test(
  "ATTACK A6: a lineage whose first purchase IS its latest (no renewal) with a foreign id never fulfils",
  async () => {
    // original == purchase_date == D-5 with a different id: a single, later,
    // unrelated purchase — the journaled D-35 purchase is not inside it.
    const result = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ original_purchase_date: RENEWAL_AT }) }),
      { fulfilment: evidence() },
    );
    assertEquals(result.status, 200);
    assertEquals(outcome(result), "pending");
    // original == journaled date, latest == journaled date, different id: a
    // conflicting record for the same instant, not a renewal.
    const sameInstant = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({
          original_purchase_date: JOURNALED_AT,
          purchase_date: JOURNALED_AT,
        }),
      }),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(sameInstant), "pending");
  },
);

// ── A7: provider clock far behind ─────────────────────────────────────────────

Deno.test(
  "ATTACK A7: with RevenueCat's clock 23h behind, a renewal dated after that clock is not yet provable",
  async () => {
    const verifiedAtMs = Date.now() - 23 * 60 * 60_000;
    const result = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ purchase_date: at(-60 * 60_000) }) }),
      { fulfilment: evidence() },
      { requestDateMs: verifiedAtMs },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.verifiedAt, new Date(verifiedAtMs).toISOString());
    assertEquals(outcome(result), "pending");
    // A renewal dated before that older clock IS provable.
    const provable = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ purchase_date: at(-25 * 60 * 60_000) }) }),
      { fulfilment: evidence() },
      { requestDateMs: verifiedAtMs },
    );
    assertEquals(outcome(provable), "fulfilled");
  },
);

// ── A8: offset-formatted provider dates ───────────────────────────────────────

Deno.test(
  "ATTACK A8: offset-formatted provider dates are normalised before the lineage window is judged",
  async () => {
    const withOffset = (iso: string, hours: number) => {
      const shifted = new Date(Date.parse(iso) + hours * 3_600_000);
      const sign = hours >= 0 ? "+" : "-";
      const hh = String(Math.abs(hours)).padStart(2, "0");
      return shifted.toISOString().replace("Z", `${sign}${hh}:00`);
    };
    // Same instants written in +02:00 / -05:00: the window still holds.
    const inside = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({
          original_purchase_date: withOffset(FIRST_AT, 2),
          purchase_date: withOffset(RENEWAL_AT, -5),
        }),
      }),
      { fulfilment: evidence() },
    );
    assertEquals(inside.status, 200);
    assertEquals(outcome(inside), "fulfilled");
    // An original purchase written with an offset that places it 1ms AFTER the
    // journaled purchase must still be rejected (no naive string comparison).
    const after = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({ original_purchase_date: withOffset(plus(JOURNALED_AT, 1), 3) }),
      }),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(after), "pending");
  },
);

// ── A9: lapsed lineage with no usable expiry ──────────────────────────────────

Deno.test(
  "ATTACK A9: a lapsed lineage with a null or missing expiry never becomes a terminal verdict",
  async () => {
    for (const expires of [null, undefined]) {
      const row = lineageRow({}, null);
      if (expires === undefined) delete row.expires_date;
      const result = await sync(subscriberOf({ [MONTHLY]: row }, { entitledProduct: null }), {
        fulfilment: evidence(),
      });
      assertEquals(result.status, 200, String(expires));
      assertEquals(result.body.billing?.premium, false, String(expires));
      assertEquals(outcome(result), "pending", String(expires));
    }
  },
);

// ── A10: unauthorised callers ─────────────────────────────────────────────────

Deno.test(
  "ATTACK A10: an anonymous caller obtains no lineage verdict and triggers no provider call",
  async () => {
    const anon = await sync(
      subscriberOf({ [MONTHLY]: lineageRow() }),
      { fulfilment: evidence() },
      {
        token: null,
      },
    );
    assertEquals(anon.status, 401);
    assertEquals(anon.body.fulfilment, undefined);
    assertEquals(anon.rcCalls, 0);
    const garbage = await sync(
      subscriberOf({ [MONTHLY]: lineageRow() }),
      { fulfilment: evidence() },
      { token: "Bearer not-a-token" },
    );
    assertEquals(garbage.status, 401);
    assertEquals(garbage.rcCalls, 0);
  },
);

// ── A11: sandbox lineage heading production evidence ──────────────────────────

Deno.test(
  "ATTACK A11: a sandbox lineage is judged exactly like a direct sandbox match (no new trust)",
  async () => {
    // The direct-match path never inspected is_sandbox; the lineage path must
    // not be MORE permissive than it, and the two must agree.
    const direct = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({
          is_sandbox: true,
          store_transaction_id: JOURNALED_ID,
          purchase_date: JOURNALED_AT,
        }),
      }),
      { fulfilment: evidence() },
    );
    const lineage = await sync(subscriberOf({ [MONTHLY]: lineageRow({ is_sandbox: true }) }), {
      fulfilment: evidence(),
    });
    assertEquals(direct.status, 200);
    assertEquals(lineage.status, 200);
    assertEquals(outcome(lineage), outcome(direct));
  },
);

// ── A12: evidence at the verification instant ─────────────────────────────────

Deno.test(
  "ATTACK A12: evidence dated AT the verification instant leaves no room for a later renewal",
  async () => {
    const verifiedAtMs = Date.now() - 60_000;
    const verifiedAt = new Date(verifiedAtMs).toISOString();
    const result = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({ purchase_date: verifiedAt, original_purchase_date: verifiedAt }),
      }),
      { fulfilment: evidence({ purchasedAt: verifiedAt }) },
      { requestDateMs: verifiedAtMs },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.verifiedAt, verifiedAt);
    assertEquals(outcome(result), "pending");
    // One millisecond earlier evidence with the renewal exactly at the
    // instant is the boundary that fulfils.
    const boundary = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({ purchase_date: verifiedAt, original_purchase_date: FIRST_AT }),
      }),
      { fulfilment: evidence({ purchasedAt: plus(verifiedAt, -1) }) },
      { requestDateMs: verifiedAtMs },
    );
    assertEquals(outcome(boundary), "fulfilled");
  },
);
