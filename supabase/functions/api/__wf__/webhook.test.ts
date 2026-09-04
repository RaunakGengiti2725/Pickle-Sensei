// POST /webhooks/revenuecat — secret gating, never-trust-body re-verification,
// insert-first idempotency over webhook_events, retryable failure semantics,
// and TRANSFER handling.
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
} from "./routesHarness.ts";
import { dbUnavailable, ENTITLEMENTS_URL, EVENTS_URL, simulate } from "./webhookSim.ts";

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
    const sim = await simulate();
    try {
      const h = sim.h;
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
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false);
    } finally {
      sim.restore();
    }
  },
);

Deno.test("webhook: verified active entitlement is persisted via service role", async () => {
  const sim = await simulate();
  try {
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    sim.h.subscriber = activeSubscriber(expires);
    const res = await sim.h.handler(
      webhookRequest({
        id: "evt-active",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      }),
    );
    assertEquals(res.status, 200);
    await res.json();
    const row = sim.entitlementRows.get(TEST_USER_ID);
    assert(row, "row persisted");
    assertEquals(row.premium, true);
    assertEquals(row.product_key, "pickle_sensei_pro_monthly");
    assertEquals(row.expires_at, expires);
    assert(typeof row.verified_at === "string");
  } finally {
    sim.restore();
  }
});

Deno.test(
  "webhook: the event id is reserved in webhook_events BEFORE RevenueCat is consulted, with ignoreDuplicates, and marked processed once handled",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      await sim.h.handler(
        webhookRequest({
          id: "evt-audit",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      const order = sim.h.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`);
      const reserveIdx = order.indexOf(`POST ${EVENTS_URL}`);
      const rcIdx = order.findIndex((entry) => entry.startsWith(`GET ${RC_URL}`));
      assert(reserveIdx >= 0 && rcIdx >= 0);
      assert(reserveIdx < rcIdx, `reservation precedes verification: ${order.join(" → ")}`);

      const audit = sim.h.callsTo(EVENTS_URL).filter((c) => c.method === "POST");
      assertEquals(audit.length, 1);
      const row = audit[0].body as Record<string, unknown>;
      assertEquals(row.id, "evt-audit");
      assertEquals(row.provider, "revenuecat");
      assertEquals(row.event_type, "RENEWAL");
      assertEquals(row.app_user_id, TEST_USER_ID);
      assert(String(audit[0].headers["prefer"]).includes("resolution=ignore-duplicates"));

      const stored = sim.auditRows.get("evt-audit");
      assert(stored, "audit row present");
      assert(typeof stored.processed_at === "string", "processed_at set on completion");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: RevenueCat outage → 503 so RevenueCat retries; nothing persisted and the reservation is released for the redelivery",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = null;
      const event = {
        id: "evt-outage",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const res = await sim.h.handler(webhookRequest(event));
      assertEquals(res.status, 503);
      await res.text();
      assertEquals(sim.entitlementUpserts(), 0);
      assertEquals(sim.auditRows.has("evt-outage"), false, "no row survives a failed delivery");

      sim.h.subscriber = activeSubscriber();
      const redelivery = await sim.h.handler(webhookRequest(event));
      assertEquals(redelivery.status, 200);
      assertEquals(await redelivery.json(), { received: true, verified: true });
      assertEquals(sim.entitlementUpserts(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: non-uuid app_user_id (anonymous RevenueCat id) is acknowledged without verification and still audited",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      const res = await sim.h.handler(
        webhookRequest({
          id: "evt-anon",
          type: "INITIAL_PURCHASE",
          app_user_id: "$RCAnonymousID:abc",
          aliases: ["$RCAnonymousID:abc"],
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(sim.rcCalls(), 0);
      const row = sim.auditRows.get("evt-anon");
      assert(row && typeof row.processed_at === "string", "audited and processed");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: a replayed event id is verified and persisted exactly once — later deliveries are duplicate acks",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      const event = {
        id: "evt-replay",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(await first.json(), { received: true, verified: true });
      for (let i = 0; i < 2; i += 1) {
        const replay = await sim.h.handler(webhookRequest(event));
        assertEquals(replay.status, 200);
        assertEquals(await replay.json(), { received: true, duplicate: true });
      }
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: TRANSFER events (no app_user_id/aliases) re-verify BOTH transferred_from and transferred_to",
  async () => {
    // Per RevenueCat docs, TRANSFER uses only Common + Transfer fields
    // (transferred_from / transferred_to); app_user_id and aliases are absent.
    // Both sides must be re-verified so the source account does not keep a
    // stale premium row until expires_at.
    const sim = await simulate();
    try {
      const h = sim.h;
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
      assertEquals(await res.json(), { received: true, verified: true });
      const rc = h.callsTo(RC_URL);
      assertEquals(rc.length, 2, "both accounts are re-verified against RevenueCat");
      assert(rc.some((c) => c.url.endsWith(encodeURIComponent(TEST_USER_ID))));
      assert(rc.some((c) => c.url.endsWith(encodeURIComponent(OTHER_USER_ID))));
      assertEquals(sim.entitlementRows.size, 2, "one entitlement row per account");
      assert(sim.entitlementRows.has(TEST_USER_ID) && sim.entitlementRows.has(OTHER_USER_ID));
      const audit = h.callsTo(EVENTS_URL).find((c) => c.method === "POST");
      assert(audit, "audit row reserved");
      assertEquals((audit.body as Record<string, unknown>).app_user_id, TEST_USER_ID);
      assert(typeof sim.auditRows.get("evt-transfer")?.processed_at === "string");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: billing_entitlements upsert failing with a non-FK SQLSTATE (57P03) → 5xx with ZERO webhook_events rows; the redelivery performs exactly one RevenueCat GET and one upsert",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        status: 503,
        body: { code: "57P03", message: "the database system is starting up" },
        times: 1,
      });
      const event = {
        id: "evt-persist-57p03",
        type: "INITIAL_PURCHASE",
        app_user_id: TEST_USER_ID,
      };
      const first = await sim.h.handler(webhookRequest(event));
      assert(
        first.status >= 500 && first.status < 600,
        `retryable 5xx expected, got ${first.status}`,
      );
      const text = await first.text();
      assert(!/starting up|57P03/.test(text), `generic 5xx body: ${text}`);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      assertEquals(sim.entitlementRows.has(TEST_USER_ID), false, "nothing persisted");
      assertEquals(sim.auditRows.size, 0, "zero webhook_events rows after the failed delivery");

      const redelivery = await sim.h.handler(webhookRequest(event));
      assertEquals(redelivery.status, 200);
      assertEquals(await redelivery.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2, "redelivery re-verifies once");
      assertEquals(sim.entitlementUpserts(), 2, "redelivery upserts once");
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, true);
      assert(typeof sim.auditRows.get("evt-persist-57p03")?.processed_at === "string");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: TRANSFER whose SECOND subject's billing_entitlements write fails transiently (503 PGRST001) → 503, no audit row; the redelivery re-verifies and persists BOTH subjects",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) =>
          m === "POST" && u.startsWith(ENTITLEMENTS_URL) && sim.entitlementUpserts() === 2,
        ...dbUnavailable,
        times: 1,
      });
      const event = {
        id: "evt-transfer-fail",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 503);
      const text = await first.text();
      assert(!/could not connect|PGRST/i.test(text), `generic 5xx body: ${text}`);
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.entitlementUpserts(), 2);
      assertEquals(sim.auditRows.has("evt-transfer-fail"), false, "no audit row");

      const redelivery = await sim.h.handler(webhookRequest(event));
      assertEquals(redelivery.status, 200);
      assertEquals(await redelivery.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 4, "both subjects re-verified");
      assertEquals(sim.entitlementUpserts(), 4, "both subjects re-written");
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, true);
      assertEquals(sim.entitlementRows.get(OTHER_USER_ID)?.premium, true);
      assert(typeof sim.auditRows.get("evt-transfer-fail")?.processed_at === "string");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: FK 23503 for a never-bootstrapped user (no profiles row) is the documented by-design ack — 200 {verified:false} with the audit row written",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        status: 409,
        body: {
          code: "23503",
          message:
            'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
        },
        times: 1,
      });
      const event = {
        id: "evt-no-profile",
        type: "INITIAL_PURCHASE",
        app_user_id: TEST_USER_ID,
      };
      const res = await sim.h.handler(webhookRequest(event));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      assertEquals(sim.entitlementRows.has(TEST_USER_ID), false);
      const row = sim.auditRows.get("evt-no-profile");
      assert(row && typeof row.processed_at === "string", "audit row written and processed");
      assert(
        sim.errors.some((e) => /webhook verdict persist/i.test(e)),
        "23503 is logged",
      );

      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test("webhook: oversized body is refused with 413 like every other route", async () => {
  const h = await loadHarness();
  const huge = "x".repeat(5_000_001);
  const req = webhookRequest(null, {
    rawBody: `{"event":{"id":"big","pad":"${huge}"}}`,
  });
  const res = await h.handler(req);
  assertEquals(res.status, 413);
  await res.text();
});
