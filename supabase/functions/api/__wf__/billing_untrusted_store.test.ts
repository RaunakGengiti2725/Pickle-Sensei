// An entitlement is only as trustworthy as the store that sold its product.
// RevenueCat's Test Store simulates purchases without payment, and its public
// `test_` SDK key ships in the Android build — so a subscriber whose
// pickle_sensei_pro entitlement rests on a Test Store purchase must read
// premium:false on /v1/billing/sync (and therefore through the webhook, which
// re-verifies with the same fold). Real App Store, Play Store and dashboard
// promotional grants keep working; records that name no store are unchanged.

import { assertEquals } from "@std/assert";
import { simulate } from "./webhookSim.ts";
import {
  fakeSupabaseAccessToken,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const LIFETIME = "pickle_sensei_pro_lifetime";
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function subscription(store: unknown, expiresDate: string | null = at(25 * DAY)) {
  return {
    store,
    is_sandbox: false,
    period_type: "normal",
    store_transaction_id: "2000000811111111",
    purchase_date: at(-5 * DAY),
    original_purchase_date: at(-5 * DAY),
    expires_date: expiresDate,
    grace_period_expires_date: null,
  };
}

function entitled(product: string, expiresDate: string | null) {
  return {
    pickle_sensei_pro: {
      expires_date: expiresDate,
      purchase_date: at(-5 * DAY),
      product_identifier: product,
    },
  };
}

async function sync(subscriber: Record<string, unknown>) {
  const sim = await simulate();
  try {
    sim.h.subscriber = subscriber;
    sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    const response = await sim.h.handler(
      userRequest("POST", "/v1/billing/sync", {
        body: {},
        token: fakeSupabaseAccessToken(crypto.randomUUID()),
      }),
    );
    return { status: response.status, body: await response.json() };
  } finally {
    sim.restore();
  }
}

Deno.test("billing/sync: a Test Store subscription never grants Pro", async () => {
  const result = await sync({
    entitlements: entitled(MONTHLY, at(25 * DAY)),
    subscriptions: { [MONTHLY]: subscription("test_store") },
    non_subscriptions: {},
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, false);
  assertEquals(result.body.billing.productKey, null);
});

Deno.test("billing/sync: store identifiers are matched case-insensitively", async () => {
  const result = await sync({
    entitlements: entitled(MONTHLY, at(25 * DAY)),
    subscriptions: { [MONTHLY]: subscription("TEST_STORE") },
    non_subscriptions: {},
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, false);
});

Deno.test("billing/sync: a Test Store lifetime purchase never grants Pro", async () => {
  const result = await sync({
    entitlements: entitled(LIFETIME, null),
    subscriptions: {},
    non_subscriptions: {
      [LIFETIME]: [
        { id: "rc-non-sub-1", store: "test_store", purchase_date: at(-5 * DAY), is_sandbox: false },
      ],
    },
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, false);
});

Deno.test("billing/sync: an unrecognised store is denied, not trusted by default", async () => {
  const result = await sync({
    entitlements: entitled(MONTHLY, at(25 * DAY)),
    subscriptions: { [MONTHLY]: subscription("some_future_store") },
    non_subscriptions: {},
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, false);
});

Deno.test("billing/sync: a lineage mixing a real and a Test Store purchase is denied", async () => {
  const result = await sync({
    entitlements: entitled(LIFETIME, null),
    subscriptions: {},
    non_subscriptions: {
      [LIFETIME]: [
        { id: "rc-non-sub-1", store: "app_store", purchase_date: at(-40 * DAY) },
        { id: "rc-non-sub-2", store: "test_store", purchase_date: at(-5 * DAY) },
      ],
    },
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, false);
});

for (const store of ["app_store", "mac_app_store", "play_store", "promotional"]) {
  Deno.test(`billing/sync: a ${store} subscription still grants Pro`, async () => {
    const result = await sync({
      entitlements: entitled(MONTHLY, at(25 * DAY)),
      subscriptions: { [MONTHLY]: subscription(store) },
      non_subscriptions: {},
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.billing.premium, true);
    assertEquals(result.body.billing.productKey, MONTHLY);
  });
}

Deno.test("billing/sync: an App Store lifetime purchase still grants Pro", async () => {
  const result = await sync({
    entitlements: entitled(LIFETIME, null),
    subscriptions: {},
    non_subscriptions: {
      [LIFETIME]: [{ id: "rc-non-sub-1", store: "app_store", purchase_date: at(-5 * DAY) }],
    },
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, true);
  assertEquals(result.body.billing.productKey, LIFETIME);
});

Deno.test("billing/sync: records that name no store keep today's verdict", async () => {
  const result = await sync({
    entitlements: entitled(MONTHLY, at(25 * DAY)),
    subscriptions: { [MONTHLY]: subscription(undefined) },
    non_subscriptions: {},
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.billing.premium, true);
});

Deno.test(
  "billing/sync: a malformed store makes the verdict unavailable, never negative",
  async () => {
    const result = await sync({
      entitlements: entitled(MONTHLY, at(25 * DAY)),
      subscriptions: { [MONTHLY]: subscription(42) },
      non_subscriptions: {},
    });
    assertEquals(result.status, 502);
    assertEquals(result.body.error.code, "billing_unavailable");
  },
);

// ── the webhook re-verifies with the same fold ──────────────────────────────

Deno.test(
  "webhook: an INITIAL_PURCHASE backed by a Test Store subscription is acked but persists premium:false",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = {
        entitlements: entitled(MONTHLY, at(25 * DAY)),
        subscriptions: { [MONTHLY]: subscription("test_store") },
        non_subscriptions: {},
      };
      const res = await sim.h.handler(
        webhookRequest({
          id: "untrusted-store-initial",
          type: "INITIAL_PURCHASE",
          app_user_id: TEST_USER_ID,
          entitlement_ids: ["pickle_sensei_pro"],
          product_id: MONTHLY,
          store: "TEST_STORE",
          expiration_at_ms: Date.now() + 25 * DAY,
        }),
      );
      assertEquals(await res.json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, false);
      assertEquals(row?.product_key, null);
      assertEquals(sim.auditRows.get("untrusted-store-initial")?.event_type, "INITIAL_PURCHASE");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: an INITIAL_PURCHASE backed by an App Store subscription still persists premium:true",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = {
        entitlements: entitled(MONTHLY, at(25 * DAY)),
        subscriptions: { [MONTHLY]: subscription("app_store") },
        non_subscriptions: {},
      };
      const res = await sim.h.handler(
        webhookRequest({
          id: "trusted-store-initial",
          type: "INITIAL_PURCHASE",
          app_user_id: TEST_USER_ID,
          entitlement_ids: ["pickle_sensei_pro"],
          product_id: MONTHLY,
          store: "APP_STORE",
          expiration_at_ms: Date.now() + 25 * DAY,
        }),
      );
      assertEquals(await res.json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, true);
      assertEquals(row?.product_key, MONTHLY);
    } finally {
      sim.restore();
    }
  },
);
