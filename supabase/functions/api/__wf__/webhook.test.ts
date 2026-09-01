// POST /webhooks/revenuecat — secret gating, never-trust-body re-verification,
// audit logging, replay handling, and the TRANSFER-event gap.
//
// Run: deno test -A supabase/functions/api/__wf__/

import { assert, assertEquals } from "@std/assert";
import {
  activeSubscriber,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  webhookRequest,
} from "./harness.ts";

Deno.test("webhook: missing or wrong Authorization is rejected (401) before any work", async () => {
  const h = await loadHarness();
  const missing = await h.handler(
    webhookRequest({ id: "evt-1", type: "TEST" }, { authorization: null }),
  );
  assertEquals(missing.status, 401);
  const wrong = await h.handler(
    webhookRequest({ id: "evt-1", type: "TEST" }, { authorization: "nope" }),
  );
  assertEquals(wrong.status, 401);
  // Neither RevenueCat nor the database was touched.
  assertEquals(h.calls.length, 0);
});

Deno.test(
  "webhook: body entitlement claims are never trusted — verdict comes from RevenueCat",
  async () => {
    const h = await loadHarness();
    h.subscriber = { entitlements: {} }; // RevenueCat says: no entitlement
    const res = await h.handler(
      webhookRequest({
        id: "evt-forged",
        type: "INITIAL_PURCHASE",
        app_user_id: TEST_USER_ID,
        entitlement_ids: ["pickle_sensei_pro"],
        expiration_at_ms: Date.now() + 86_400_000,
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });

    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(TEST_USER_ID)));
    assertEquals(rc[0].headers["authorization"], "Bearer sk_test_revenuecat");

    const entitlement = h.callsTo("/rest/v1/billing_entitlements");
    assertEquals(entitlement.length, 1);
    const row = entitlement[0].body as Record<string, unknown>;
    assertEquals(row.user_id, TEST_USER_ID);
    assertEquals(row.premium, false); // body said premium; RevenueCat said no
    assertEquals(entitlement[0].headers["apikey"], "service-role-test-key");
  },
);

Deno.test("webhook: verified active entitlement is persisted via service role", async () => {
  const h = await loadHarness();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  h.subscriber = activeSubscriber(expires);
  const res = await h.handler(
    webhookRequest({
      id: "evt-active",
      type: "RENEWAL",
      app_user_id: TEST_USER_ID,
    }),
  );
  assertEquals(res.status, 200);
  const row = h.callsTo("/rest/v1/billing_entitlements")[0].body as Record<string, unknown>;
  assertEquals(row.premium, true);
  assertEquals(row.product_key, "pickle_sensei_pro_monthly");
  assertEquals(row.expires_at, expires);
});

Deno.test(
  "webhook: audit row is written with event id/type/app_user_id and ignoreDuplicates",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    await h.handler(
      webhookRequest({
        id: "evt-audit",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      }),
    );
    const audit = h.callsTo("/rest/v1/webhook_events");
    assertEquals(audit.length, 1);
    const row = audit[0].body as Record<string, unknown>;
    assertEquals(row.id, "evt-audit");
    assertEquals(row.provider, "revenuecat");
    assertEquals(row.event_type, "RENEWAL");
    assertEquals(row.app_user_id, TEST_USER_ID);
    assert(String(audit[0].headers["prefer"]).includes("resolution=ignore-duplicates"));
  },
);

Deno.test("webhook: RevenueCat outage → 503 so RevenueCat retries; nothing persisted", async () => {
  const h = await loadHarness();
  h.subscriber = null;
  const res = await h.handler(
    webhookRequest({
      id: "evt-outage",
      type: "RENEWAL",
      app_user_id: TEST_USER_ID,
    }),
  );
  assertEquals(res.status, 503);
  assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
});

Deno.test(
  "webhook: non-uuid app_user_id (anonymous RevenueCat id) is acknowledged without verification",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({
        id: "evt-anon",
        type: "INITIAL_PURCHASE",
        app_user_id: "$RCAnonymousID:abc",
        aliases: ["$RCAnonymousID:abc"],
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo(RC_URL).length, 0);
  },
);

Deno.test(
  "REPRO (defect): replayed event id is fully re-processed — no id-dedupe short-circuit",
  async () => {
    // index.ts comments claim "an already-seen event is acknowledged without
    // another RevenueCat round trip", but the upsert result is never inspected.
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const event = {
      id: "evt-replay",
      type: "RENEWAL",
      app_user_id: TEST_USER_ID,
    };
    await h.handler(webhookRequest(event));
    await h.handler(webhookRequest(event));
    await h.handler(webhookRequest(event));
    assertEquals(h.callsTo(RC_URL).length, 3);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 3);
  },
);

Deno.test(
  "REPRO (defect): TRANSFER events carry no app_user_id/aliases → neither side is re-verified",
  async () => {
    // Per RevenueCat docs, TRANSFER uses only Common + Transfer fields
    // (transferred_from / transferred_to); app_user_id and aliases are absent.
    // The source account keeps its stale premium row until expires_at (forever
    // for lifetime products) because the app only re-syncs on explicit user
    // action, never on launch.
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({
        id: "evt-transfer",
        type: "TRANSFER",
        app_id: "app123",
        event_timestamp_ms: Date.now(),
        store: "APP_STORE",
        environment: "PRODUCTION",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo(RC_URL).length, 0, "no RevenueCat re-verification for either account");
    assertEquals(
      h.callsTo("/rest/v1/billing_entitlements").length,
      0,
      "no entitlement row touched",
    );
    const audit = h.callsTo("/rest/v1/webhook_events")[0].body as Record<string, unknown>;
    assertEquals(audit.app_user_id, null, "audit row cannot be correlated to a user either");
  },
);

Deno.test(
  "REPRO (defect): webhook route skips the Content-Length 413 guard and buffers the whole body",
  async () => {
    const h = await loadHarness();
    const huge = "x".repeat(5_000_001);
    const req = webhookRequest(null, {
      rawBody: `{"event":{"id":"big","pad":"${huge}"}}`,
    });
    const res = await h.handler(req);
    // The oversized body is read in full, then silently treated as {} → 400,
    // instead of the 413 every other route returns from the header check.
    assertEquals(res.status, 400);
  },
);
