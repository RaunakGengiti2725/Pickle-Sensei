// Real Edge handler; provider I/O and ordered-ticket persistence are exercised
// through the existing stateful transport harness. SQL is proved separately.
import { assertEquals } from "@std/assert";
import { TEST_USER_ID, userRequest } from "./routesHarness.ts";
import { simulate } from "./webhookSim.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const LIFETIME = "pickle_sensei_pro_lifetime";
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const entitlement = (expires: string | null, product = MONTHLY, grace: unknown = null) => ({
  expires_date: expires,
  grace_period_expires_date: grace,
  product_identifier: product,
  purchase_date: at(-86_400_000),
});

async function sync(subscriber: Record<string, unknown>) {
  const sim = await simulate();
  try {
    sim.h.subscriber = subscriber;
    sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    const response = await sim.h.handler(userRequest("POST", "/v1/billing/sync"));
    return {
      status: response.status,
      body: await response.json(),
      stored: sim.entitlementRows.get(TEST_USER_ID),
      writes: sim.entitlementWrites.length,
    };
  } finally {
    sim.restore();
  }
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
