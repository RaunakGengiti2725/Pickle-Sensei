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
} from "./routesHarness.ts";

/** RevenueCat app_user_ids are case-sensitive; Postgres uuid folds case. */
const LOWER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UPPER_UUID = LOWER_UUID.toUpperCase();

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
    const audit = h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST");
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
  "webhook: a PROCESSED event id is acknowledged as a duplicate with zero RevenueCat calls",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const event = { id: "evt-replay", type: "RENEWAL", app_user_id: TEST_USER_ID };
    const first = await h.handler(webhookRequest(event));
    assertEquals(first.status, 200);
    assertEquals(await first.json(), { received: true, verified: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const replay = await h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
    }
    // Exactly one round of work for three deliveries of the same id.
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 1);
    assertEquals(h.webhookEvents.size, 1);
  },
);

Deno.test(
  "webhook: a FAILED delivery is not deduped — the retry re-verifies and persists once",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    // 57P03 (database starting up) clears by itself: the delivery must be
    // retryable and must leave no idempotency row behind.
    h.failEntitlementUpsert = (n) =>
      n === 0
        ? { status: 503, code: "57P03", message: "the database system is starting up" }
        : null;
    const event = { id: "evt-transient", type: "RENEWAL", app_user_id: TEST_USER_ID };

    const failed = await h.handler(webhookRequest(event));
    assert(
      failed.status >= 500 && failed.status <= 599,
      `transient persist failure must be retryable, got ${failed.status}`,
    );
    await failed.body?.cancel();
    assertEquals(h.webhookEvents.size, 0, "a failed delivery writes no idempotency row");
    assertEquals(h.entitlements.size, 0);

    const before = h.callsTo(RC_URL).length;
    const upsertsBefore = h.callsTo("/rest/v1/billing_entitlements").length;
    const redelivered = await h.handler(webhookRequest(event));
    assertEquals(redelivered.status, 200);
    assertEquals(await redelivered.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length - before, 1, "one RevenueCat GET on redelivery");
    assertEquals(
      h.callsTo("/rest/v1/billing_entitlements").length - upsertsBefore,
      1,
      "one entitlement upsert on redelivery",
    );
    assertEquals(h.entitlements.get(TEST_USER_ID)?.premium, true, "the verdict finally lands");
    assertEquals(h.webhookEvents.size, 1);
  },
);

Deno.test(
  "webhook: FK violation (23503, user never bootstrapped) keeps the 200 verified:false contract",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.failEntitlementUpsert = () => ({
      status: 409,
      code: "23503",
      message: 'insert or update on table "billing_entitlements" violates foreign key constraint',
    });
    const res = await h.handler(
      webhookRequest({ id: "evt-fk", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    // Retrying can never succeed, so the event is closed with an audit row.
    assertEquals(h.webhookEvents.size, 1);
    assert(h.webhookEvents.has("evt-fk"));
    assertEquals(h.entitlements.size, 0);
  },
);

Deno.test(
  "webhook: TRANSFER whose transferred_to upsert fails transiently is retryable with no audit row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    // The source write succeeds, the destination write fails: acknowledging
    // would leave the transfer half-applied forever.
    h.failEntitlementUpsert = (n) =>
      n === 0 ? null : { status: 503, code: "57P03", message: "the database system is starting up" };
    const res = await h.handler(
      webhookRequest({
        id: "evt-transfer-partial",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      }),
    );
    assert(res.status >= 500 && res.status <= 599, `expected 5xx, got ${res.status}`);
    await res.body?.cancel();
    assertEquals(h.webhookEvents.size, 0, "no idempotency row seals a half-applied transfer");
    assertEquals(h.entitlements.has(OTHER_USER_ID), false);
  },
);

Deno.test(
  "webhook: RevenueCat 401 → 503 with a diagnostic naming the upstream status, never the key",
  async () => {
    const h = await loadHarness();
    h.revenueCatStatus = 401;
    const res = await h.handler(
      webhookRequest({ id: "evt-rc-401", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 503);
    await res.body?.cancel();
    const diagnostic = h.logLines.find((line) => /revenuecat/i.test(line) && line.includes("401"));
    assert(diagnostic, `no diagnostic naming HTTP 401: ${JSON.stringify(h.logLines)}`);
    const rcKey = Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "";
    assert(rcKey.length > 0);
    for (const line of h.logLines) assert(!line.includes(rcKey), "a log line leaked the RC key");
    assertEquals(h.webhookEvents.size, 0);
    assertEquals(h.entitlements.size, 0);
  },
);

Deno.test(
  "webhook: uppercase-hex app_user_id is canonicalised for BOTH the RevenueCat read and the write",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({
        id: "evt-upper",
        type: "RENEWAL",
        app_user_id: UPPER_UUID,
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assertEquals(rc[0].url, `${RC_URL}${LOWER_UUID}`);
    const upserts = h.callsTo("/rest/v1/billing_entitlements");
    assertEquals(upserts.length, 1);
    assertEquals((upserts[0].body as Record<string, unknown>).user_id, LOWER_UUID);
  },
);

Deno.test(
  "webhook: uppercase ids in aliases[], transferred_from[] and transferred_to[] are canonicalised",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();

    const aliased = await h.handler(
      webhookRequest({
        id: "evt-upper-alias",
        type: "INITIAL_PURCHASE",
        app_user_id: "$RCAnonymousID:abc",
        aliases: ["$RCAnonymousID:abc", UPPER_UUID],
      }),
    );
    assertEquals(aliased.status, 200);
    await aliased.body?.cancel();
    assertEquals(h.callsTo(RC_URL).map((c) => c.url), [`${RC_URL}${LOWER_UUID}`]);
    assertEquals(
      h.callsTo("/rest/v1/billing_entitlements").map((c) =>
        (c.body as Record<string, unknown>).user_id
      ),
      [LOWER_UUID],
    );

    h.reset();
    h.subscriber = activeSubscriber();
    const transferred = await h.handler(
      webhookRequest({
        id: "evt-upper-transfer",
        type: "TRANSFER",
        transferred_from: [UPPER_UUID],
        transferred_to: [OTHER_USER_ID.toUpperCase()],
      }),
    );
    assertEquals(transferred.status, 200);
    await transferred.body?.cancel();
    assertEquals(h.callsTo(RC_URL).map((c) => c.url).sort(), [
      `${RC_URL}${LOWER_UUID}`,
      `${RC_URL}${OTHER_USER_ID}`,
    ].sort());
    assertEquals([...h.entitlements.keys()].sort(), [LOWER_UUID, OTHER_USER_ID].sort());
  },
);

Deno.test(
  "webhook: TRANSFER events (no app_user_id/aliases) re-verify BOTH transferred_from and transferred_to",
  async () => {
    // Per RevenueCat docs, TRANSFER uses only Common + Transfer fields
    // (transferred_from / transferred_to); app_user_id and aliases are absent.
    // Both sides must be re-verified so the source account does not keep a
    // stale premium row until expires_at.
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
    assertEquals(await res.json(), { received: true, verified: true });
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 2, "both accounts are re-verified against RevenueCat");
    assert(rc.some((c) => c.url.endsWith(encodeURIComponent(TEST_USER_ID))));
    assert(rc.some((c) => c.url.endsWith(encodeURIComponent(OTHER_USER_ID))));
    const rows = h
      .callsTo("/rest/v1/billing_entitlements")
      .map((c) => (c.body as Record<string, unknown>).user_id);
    assertEquals(rows.length, 2, "one entitlement row per account");
    assert(rows.includes(TEST_USER_ID) && rows.includes(OTHER_USER_ID));
    const audit = h.callsTo("/rest/v1/webhook_events").find((c) => c.method === "POST");
    assert(audit, "audit row written once handled to completion");
    assertEquals((audit.body as Record<string, unknown>).app_user_id, TEST_USER_ID);
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
