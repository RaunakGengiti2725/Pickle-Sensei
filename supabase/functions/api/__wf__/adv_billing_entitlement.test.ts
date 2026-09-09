// INT-billing-entitlement adversary (attacked head 2994371e). Black-box attacks
// on /v1/billing/sync and /webhooks/revenuecat through the stateful webhookSim:
// provider identity shapes the existing suites do not pin, provider clock
// values of the wrong type, ambiguous refund/expiry data, replay with a mutated
// body, alias entitlements, precision mismatches, a provider answer that
// straddles expiry, entitlement-mapping gaps and cross-account evidence.
// Every assertion states the behaviour the billing contract promises
// (AGENTS.md "Billing"); a failing case here is a confirmed break, a passing
// one is evidence that the boundary holds.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { simulate } from "./webhookSim.ts";
import {
  activeSubscriber,
  fakeSupabaseAccessToken,
  RC_URL,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const ANNUAL = "pickle_sensei_pro_annual";
const LIFETIME = "pickle_sensei_pro_lifetime";
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

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

function subscriptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store: "app_store",
    is_sandbox: false,
    period_type: "normal",
    ownership_type: "PURCHASED",
    store_transaction_id: RENEWAL_ID,
    purchase_date: RENEWAL_AT,
    original_purchase_date: FIRST_AT,
    expires_date: at(25 * DAY),
    grace_period_expires_date: null,
    unsubscribe_detected_at: null,
    billing_issues_detected_at: null,
    refunded_at: null,
    ...overrides,
  };
}

function subscriber(
  subscriptions: Record<string, Record<string, unknown>>,
  options: {
    entitledProduct?: string | null;
    entitlementKey?: string;
    nonSubscriptions?: Record<string, unknown[]>;
  } = {},
): Record<string, unknown> {
  const entitledProduct = options.entitledProduct === undefined ? MONTHLY : options.entitledProduct;
  const row = entitledProduct === null ? undefined : subscriptions[entitledProduct];
  return {
    entitlements:
      row === undefined
        ? {}
        : {
            [options.entitlementKey ?? "pickle_sensei_pro"]: {
              expires_date: row.expires_date,
              purchase_date: row.purchase_date,
              product_identifier: entitledProduct,
            },
          },
    subscriptions,
    non_subscriptions: options.nonSubscriptions ?? {},
  };
}

interface SyncOptions {
  requestDateMs?: number | null;
  /** Raw RevenueCat body (bypasses the harness' request_date_ms typing). */
  rawProviderBody?: Record<string, unknown>;
  delayMs?: number;
  owner?: string;
  providerFor?: (userId: string) => Record<string, unknown> | undefined;
}

async function sync(
  subscriberBody: Record<string, unknown>,
  body: unknown,
  options: SyncOptions = {},
) {
  const sim = await simulate();
  const owner = options.owner ?? crypto.randomUUID();
  const startedAt = Date.now();
  try {
    sim.h.subscriber = subscriberBody;
    sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    if (options.rawProviderBody) {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        status: 200,
        body: options.rawProviderBody,
      });
    } else if (options.requestDateMs !== undefined || options.delayMs !== undefined) {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        subscriber: subscriberBody,
        requestDateMs: options.requestDateMs,
        delayMs: options.delayMs,
      });
    }
    if (options.providerFor) {
      const chosen = options.providerFor(owner);
      if (chosen) {
        sim.faults.push({
          match: (method, url) => method === "GET" && url.startsWith(`${RC_URL}${owner}`),
          subscriber: chosen,
        });
      }
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
      writes: sim.entitlementWrites,
      rcCalls: sim.rcCalls(),
      startedAt,
      finishedAt: Date.now(),
      owner,
    };
  } finally {
    sim.restore();
  }
}

// ── ADV-BE-01 numeric renewal identity ────────────────────────────────────────

Deno.test(
  "ADV-BE-01a a renewal whose store_transaction_id RevenueCat reports as a NUMBER still proves the lineage",
  async () => {
    const numericRenewal = Number(RENEWAL_ID);
    assert(Number.isSafeInteger(numericRenewal));
    const r = await sync(
      subscriber({ [MONTHLY]: subscriptionRow({ store_transaction_id: numericRenewal }) }),
      { fulfilment: fulfilment() },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "fulfilled");
    assertEquals(r.body.billing.premium, true);
    assertEquals(r.body.access.premium, true);
    assertEquals(r.writes.length, 1);
  },
);

Deno.test(
  "ADV-BE-01b an unsafe-integer renewal id is an unknown identity: the journal stays pending, premium is still granted",
  async () => {
    const r = await sync(
      subscriber({ [MONTHLY]: subscriptionRow({ store_transaction_id: 2 ** 53 + 1 }) }),
      { fulfilment: fulfilment() },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "pending");
    assertEquals(r.body.billing.premium, true);
    assertEquals(r.writes.length, 1);
  },
);

// ── ADV-BE-02 journaled id present on another product ────────────────────────

Deno.test(
  "ADV-BE-02 the journaled id living (as a number) on ANOTHER product's row is a conflict, not a lineage proof",
  async () => {
    const r = await sync(
      subscriber({
        [MONTHLY]: subscriptionRow(),
        [ANNUAL]: subscriptionRow({
          store_transaction_id: Number(RESUB_ID),
          purchase_date: at(-40 * DAY),
          original_purchase_date: at(-40 * DAY),
          expires_date: at(-10 * DAY),
        }),
      }),
      { fulfilment: fulfilment() },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "pending");
    assertEquals(r.body.billing.premium, true);
  },
);

// ── ADV-BE-03 provider clock of the wrong type ───────────────────────────────

Deno.test(
  "ADV-BE-03a request_date_ms sent as a numeric STRING (far future) falls back to the pre-request clock",
  async () => {
    const farFuture = Date.now() + 400 * DAY;
    const r = await sync(
      activeSubscriber(),
      {},
      {
        rawProviderBody: { request_date_ms: String(farFuture), subscriber: activeSubscriber() },
      },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.billing.premium, true);
    const verifiedMs = Date.parse(r.body.billing.verifiedAt);
    assert(
      verifiedMs >= r.startedAt - 1_000 && verifiedMs <= r.finishedAt + 1_000,
      r.body.billing.verifiedAt,
    );
    assertEquals(r.writes.length, 1);
    assertEquals(Date.parse(String(r.writes[0].verified_at)), verifiedMs);
  },
);

Deno.test(
  "ADV-BE-03b request_date_ms as an ISO string / boolean / nested object never becomes the verdict key",
  async () => {
    for (const raw of [
      new Date(Date.now() + 400 * DAY).toISOString(),
      true,
      { ms: Date.now() + 400 * DAY },
    ]) {
      const r = await sync(
        activeSubscriber(),
        {},
        {
          rawProviderBody: { request_date_ms: raw, subscriber: activeSubscriber() },
        },
      );
      assertEquals(r.status, 200, JSON.stringify(raw));
      const verifiedMs = Date.parse(r.body.billing.verifiedAt);
      assert(
        verifiedMs >= r.startedAt - 1_000 && verifiedMs <= r.finishedAt + 1_000,
        JSON.stringify(raw),
      );
    }
  },
);

Deno.test(
  "ADV-BE-03c skew boundaries: +5min+1ms and -24h-1ms fall back, -24h exactly is accepted",
  async () => {
    const ahead = await sync(
      activeSubscriber(),
      {},
      { requestDateMs: Date.now() + 5 * 60_000 + 1_500 },
    );
    assertEquals(ahead.status, 200);
    assert(Date.parse(ahead.body.billing.verifiedAt) <= ahead.finishedAt + 1_000);

    const behind = await sync(activeSubscriber(), {}, { requestDateMs: Date.now() - DAY - 1_500 });
    assertEquals(behind.status, 200);
    assert(Date.parse(behind.body.billing.verifiedAt) >= behind.startedAt - 1_000);

    const edge = Date.now() - DAY + 2_000;
    const accepted = await sync(activeSubscriber(), {}, { requestDateMs: edge });
    assertEquals(accepted.status, 200);
    assertEquals(Date.parse(accepted.body.billing.verifiedAt), edge);
  },
);

// ── ADV-BE-04 refund earlier than the purchase ───────────────────────────────

Deno.test(
  "ADV-BE-04 a refunded_at BEFORE the purchase it claims to refund is ambiguous: pending, never 'refunded'",
  async () => {
    const r = await sync(
      subscriber(
        {
          [MONTHLY]: subscriptionRow({
            store_transaction_id: RESUB_ID,
            purchase_date: RESUB_AT,
            refunded_at: at(-36 * DAY),
            expires_date: at(-5 * DAY),
          }),
        },
        { entitledProduct: null },
      ),
      { fulfilment: fulfilment() },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "pending");
    assertEquals(r.body.billing.premium, false);
    assertEquals(r.body.access.premium, false);
  },
);

// ── ADV-BE-05 missing / malformed expiry ─────────────────────────────────────

Deno.test(
  "ADV-BE-05 a matched subscription without a usable expiry never becomes 'expired'",
  async () => {
    const matched = (extra: Record<string, unknown>) =>
      subscriber(
        {
          [MONTHLY]: subscriptionRow({
            store_transaction_id: RESUB_ID,
            purchase_date: RESUB_AT,
            ...extra,
          }),
        },
        { entitledProduct: null },
      );
    const noExpiry = await sync(matched({ expires_date: null }), { fulfilment: fulfilment() });
    assertEquals(noExpiry.body.fulfilment.outcome, "pending");
    assertEquals(noExpiry.body.billing.premium, false);

    const malformedGrace = await sync(
      matched({ expires_date: at(-5 * DAY), grace_period_expires_date: "" }),
      { fulfilment: fulfilment() },
    );
    assertEquals(malformedGrace.body.fulfilment.outcome, "pending");

    const garbageExpiry = await sync(matched({ expires_date: "not-a-date" }), {
      fulfilment: fulfilment(),
    });
    assertEquals(garbageExpiry.body.fulfilment.outcome, "pending");

    const control = await sync(matched({ expires_date: at(-5 * DAY) }), {
      fulfilment: fulfilment(),
    });
    assertEquals(control.body.fulfilment.outcome, "expired");
  },
);

// ── ADV-BE-06 replay with a mutated nested body ──────────────────────────────

Deno.test(
  "ADV-BE-06 a replay of a PROCESSED event id with a mutated body is refused without re-verification or writes",
  async () => {
    const sim = await simulate();
    try {
      const userId = crypto.randomUUID();
      sim.h.subscriber = activeSubscriber();
      const event = {
        id: crypto.randomUUID(),
        type: "RENEWAL",
        app_user_id: userId,
        product_id: MONTHLY,
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 200);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementWrites.length, 1);

      const forged = await sim.h.handler(
        webhookRequest({ ...event, app_user_id: crypto.randomUUID(), forged: { nested: true } }),
      );
      const forgedBody = await forged.json();
      assertNotEquals(forged.status, 200);
      assertNotEquals(forgedBody.duplicate, true);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementWrites.length, 1);

      const exact = await sim.h.handler(webhookRequest(event));
      assertEquals(exact.status, 200);
      assertEquals((await exact.json()).duplicate, true);
      assertEquals(sim.rcCalls(), 1);
    } finally {
      sim.restore();
    }
  },
);

// ── ADV-BE-07 lifetime under the legacy alias, numeric provider id ───────────

Deno.test(
  "ADV-BE-07 a lifetime purchase entitled under the legacy 'premium' alias with a numeric provider id fulfils once",
  async () => {
    const purchasedAt = at(-2 * DAY);
    const numericId = 2000000844444444;
    const body = {
      entitlements: {
        premium: { expires_date: null, purchase_date: purchasedAt, product_identifier: LIFETIME },
      },
      subscriptions: {},
      non_subscriptions: {
        [LIFETIME]: [
          { id: numericId, purchase_date: purchasedAt, store: "app_store", is_sandbox: false },
        ],
      },
    };
    const r = await sync(body, {
      fulfilment: fulfilment({
        productId: LIFETIME,
        transactionId: String(numericId),
        purchasedAt,
      }),
    });
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "fulfilled");
    assertEquals(r.body.billing.premium, true);
    assertEquals(r.body.billing.expiresAt, null);
    assertEquals(r.body.billing.productKey, LIFETIME);
    assertEquals(r.body.access.entitlements, ["premium"]);
  },
);

// ── ADV-BE-08 timestamp precision mismatch ───────────────────────────────────

Deno.test(
  "ADV-BE-08 device ms-precision purchasedAt matches RevenueCat's second-precision purchase_date and echoes byte-for-byte",
  async () => {
    const seconds = new Date(Date.now() - 3 * DAY);
    seconds.setUTCMilliseconds(0);
    const deviceIso = seconds.toISOString();
    const providerIso = deviceIso.replace(".000Z", "Z");
    assertNotEquals(deviceIso, providerIso);
    const request = fulfilment({ purchasedAt: deviceIso, transactionId: RENEWAL_ID });
    const r = await sync(
      subscriber({
        [MONTHLY]: subscriptionRow({
          purchase_date: providerIso,
          original_purchase_date: providerIso,
        }),
      }),
      { fulfilment: request },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "fulfilled");
    assertEquals(
      JSON.stringify(r.body.fulfilment.transaction),
      JSON.stringify(request.transaction),
    );
    assertEquals(r.body.fulfilment.pendingId, request.pendingId);
    assertEquals(r.body.fulfilment.attemptId, request.attemptId);
  },
);

// ── ADV-BE-09 slow provider straddling expiry ────────────────────────────────

Deno.test(
  "ADV-BE-09 a slow provider answer whose entitlement expires mid-flight yields a coherent non-premium response",
  async () => {
    const expiresAt = at(500);
    const body = subscriber({
      [MONTHLY]: subscriptionRow({
        store_transaction_id: RESUB_ID,
        purchase_date: RESUB_AT,
        expires_date: expiresAt,
      }),
    });
    const r = await sync(body, { fulfilment: fulfilment() }, { delayMs: 1_100 });
    assertEquals(r.status, 200);
    assertEquals(
      r.body.billing.premium,
      false,
      "stored row is past expires_at by the time it is answered",
    );
    assertEquals(r.body.access.premium, false);
    assertEquals(r.body.access.entitlements, []);
    assert(r.body.billing.expiresAt === null || r.body.billing.expiresAt === expiresAt);
    // A purchase whose access is not granted must not be reported as fulfilled:
    // the client would otherwise see fulfilled+non-premium and cannot settle.
    assertNotEquals(r.body.fulfilment.outcome, "fulfilled");
  },
);

// ── ADV-BE-10 entitlement mapping gap ────────────────────────────────────────

Deno.test(
  "ADV-BE-10 a matched, unexpired subscription with NO entitlement mapping stays pending and never grants premium",
  async () => {
    const r = await sync(
      subscriber(
        { [MONTHLY]: subscriptionRow({ store_transaction_id: RESUB_ID, purchase_date: RESUB_AT }) },
        { entitledProduct: null },
      ),
      { fulfilment: fulfilment() },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "pending");
    assertEquals(r.body.billing.premium, false);
    assertEquals(r.body.access.premium, false);
    assertEquals(r.writes.length, 1);
    assertEquals(r.writes[0].premium, false);
  },
);

// ── ADV-BE-11 cross-account evidence ─────────────────────────────────────────

Deno.test(
  "ADV-BE-11 evidence of ANOTHER account's purchase presented by a signed-in user grants nothing and writes only the caller's row",
  async () => {
    const r = await sync(
      subscriber({
        [MONTHLY]: subscriptionRow({ store_transaction_id: RESUB_ID, purchase_date: RESUB_AT }),
      }),
      { fulfilment: fulfilment() },
      { providerFor: () => ({ entitlements: {}, subscriptions: {}, non_subscriptions: {} }) },
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.fulfilment.outcome, "pending");
    assertEquals(r.body.billing.premium, false);
    assertEquals(r.body.access.premium, false);
    assertEquals(r.writes.length, 1);
    assertEquals(r.writes[0].user_id, r.owner);
    assertEquals(r.writes[0].premium, false);
    assertEquals(r.rcCalls, 1);
  },
);

// ── ADV-BE-12 forged expiration webhook vs provider truth ────────────────────

Deno.test(
  "ADV-BE-12 a forged EXPIRATION/CANCELLATION body cannot revoke a member RevenueCat still reports active",
  async () => {
    const sim = await simulate();
    try {
      const userId = crypto.randomUUID();
      sim.h.subscriber = activeSubscriber();
      for (const type of ["EXPIRATION", "CANCELLATION", "BILLING_ISSUE"]) {
        const response = await sim.h.handler(
          webhookRequest({
            id: crypto.randomUUID(),
            type,
            app_user_id: userId,
            product_id: MONTHLY,
            expiration_at_ms: Date.now() - DAY,
            entitlement_ids: [],
          }),
        );
        assertEquals(response.status, 200, type);
      }
      assertEquals(sim.rcCalls(), 3);
      const stored = sim.entitlementRows.get(userId);
      assert(stored);
      assertEquals(stored.premium, true);
      for (const write of sim.entitlementWrites) assertEquals(write.premium, true);
    } finally {
      sim.restore();
    }
  },
);

// ── ADV-BE-13 malformed fulfilment evidence ──────────────────────────────────

Deno.test(
  "ADV-BE-13 malformed fulfilment evidence is rejected before any provider call or write",
  async () => {
    const cases: unknown[] = [
      {
        ...fulfilment(),
        transaction: { ...fulfilment().transaction, transactionId: 2000000833333333 },
      },
      { ...fulfilment(), transaction: { ...fulfilment().transaction, purchasedAt: "Aug 1 2026" } },
      { ...fulfilment(), transaction: { ...fulfilment().transaction, productId: "" } },
      { ...fulfilment(), pendingId: "not-a-uuid" },
      { ...fulfilment(), transaction: [] },
      null,
      "evidence",
    ];
    for (const bad of cases) {
      const r = await sync(activeSubscriber(), { fulfilment: bad });
      assertEquals(r.status, 400, JSON.stringify(bad));
      assertEquals(r.body.error?.code, "invalid_billing_fulfilment", JSON.stringify(bad));
      assertEquals(r.rcCalls, 0, JSON.stringify(bad));
      assertEquals(r.writes.length, 0, JSON.stringify(bad));
    }

    // An offset timestamp is not what the client sends (parseBillingTransaction
    // canonicalises to `Z`), but the server accepts it and echoes the canonical
    // instant, so the response can never bind to such a request byte-for-byte.
    const offset = await sync(activeSubscriber(), {
      fulfilment: {
        ...fulfilment(),
        transaction: { ...fulfilment().transaction, purchasedAt: "2026-08-01T00:00:00+05:30" },
      },
    });
    assertEquals(offset.status, 200);
    assertEquals(offset.body.fulfilment.transaction.purchasedAt, "2026-07-31T18:30:00.000Z");
    assertEquals(offset.body.fulfilment.outcome, "pending");
  },
);
