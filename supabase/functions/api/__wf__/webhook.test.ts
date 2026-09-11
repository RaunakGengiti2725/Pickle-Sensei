// POST /webhooks/revenuecat — secret gating, never-trust-body re-verification,
// insert-first idempotency over webhook_events, retryable failure semantics,
// and TRANSFER handling.
//
// Run: deno test -A supabase/functions/api/__wf__/

import { assert, assertEquals } from "@std/assert";
import {
  activeSubscriber,
  captureConsole,
  fakeSupabaseAccessToken,
  type Harness,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  WEBHOOK_SECRET,
  webhookRequest,
} from "./routesHarness.ts";
import { dbUnavailable, VERDICT_URL, EVENTS_URL, EVENT_CLAIM_URL, simulate } from "./webhookSim.ts";

const PRIVATE_FAILURE_DETAIL = `private-failure-detail ${TEST_USER_ID} user@example.test ${WEBHOOK_SECRET} service-role-test-key https://FAKE-private.test/clip?token=FAKE-provider-token`;

const auditWrites = (h: Harness) => h.callsTo("/rest/v1/rpc/complete_billing_webhook");

function assertPendingWebhook(h: Harness): void {
  const rows = storedRows(h, "webhook_events");
  assertEquals(rows.length, 1, "bound reservation retained");
  assertEquals(rows[0].processed_at, null, "no completion marker");
}

function expireWebhookLease(h: Harness, eventId: string): void {
  const claim = storedRows(h, "billing_webhook_claims").find((row) => row.event_id === eventId);
  assert(claim, "claim exists");
  claim.lease_expires_at_ms = Date.now() - 1;
  const row = storedRows(h, "webhook_events").find((row) => row.id === eventId);
  assert(row, "reservation exists");
  row.claimed_at = new Date(Date.now() - 300_001).toISOString();
}

const storedRows = (h: Harness, table: string): Record<string, unknown>[] =>
  (h.tables[table] ?? []) as Record<string, unknown>[];

function databaseFailure(code = "57014", status = 503): Response {
  return Response.json(
    { code, message: PRIVATE_FAILURE_DETAIL, details: PRIVATE_FAILURE_DETAIL },
    { status },
  );
}

async function withPrivateErrorCheck(run: () => Promise<void>): Promise<void> {
  const { output } = await captureConsole(run);
  for (const value of [
    "private-failure-detail",
    TEST_USER_ID,
    OTHER_USER_ID,
    "user@example.test",
    WEBHOOK_SECRET,
    "service-role-test-key",
    "FAKE-",
  ]) {
    assert(!output.includes(value), "billing failure logs must not contain private detail");
  }
}

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

      const entitlement = h.callsTo("/rest/v1/rpc/persist_billing_verdict");
      assertEquals(entitlement.length, 1);
      const row = entitlement[0].body as { p_user_id: string; p_verdict: Record<string, unknown> };
      assertEquals(row.p_user_id, TEST_USER_ID);
      assertEquals(row.p_verdict.premium, false); // body said premium; RevenueCat said no
      assertEquals(entitlement[0].headers["apikey"], "service-role-test-key");
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false);
    } finally {
      sim.restore();
    }
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
  const row = (
    h.callsTo("/rest/v1/rpc/persist_billing_verdict")[0].body as {
      p_verdict: Record<string, unknown>;
    }
  ).p_verdict;
  assertEquals(row.premium, true);
  assertEquals(row.productKey, "pickle_sensei_pro_monthly");
  assertEquals(row.expiresAt, expires);
  const persisted = storedRows(h, "billing_entitlements")[0];
  assert(persisted, "row persisted");
  assertEquals(persisted.premium, true);
  assertEquals(persisted.product_key, "pickle_sensei_pro_monthly");
  assertEquals(persisted.expires_at, expires);
  assert(typeof persisted.verified_at === "string");
});

Deno.test("webhook: audit completion is atomic and retains event id/type/app_user_id", async () => {
  const h = await loadHarness();
  h.subscriber = activeSubscriber();
  await h.handler(
    webhookRequest({
      id: "evt-audit",
      type: "RENEWAL",
      app_user_id: TEST_USER_ID,
    }),
  );
  const audit = auditWrites(h);
  assertEquals(audit.length, 1);
  const proof = audit[0].body as { p_event_id: string; p_tickets: Record<string, string> };
  assertEquals(proof.p_event_id, "evt-audit");
  assertEquals(Object.keys(proof.p_tickets), [TEST_USER_ID]);
  const row = storedRows(h, "webhook_events")[0];
  assertEquals(row.id, "evt-audit");
  assertEquals(row.provider, "revenuecat");
  assertEquals(row.event_type, "RENEWAL");
  assertEquals(row.app_user_id, TEST_USER_ID);
  assertEquals(audit[0].headers.apikey, "service-role-test-key");
  assertEquals(
    h.callsTo("/rest/v1/webhook_events").filter((call) => call.method === "POST").length,
    0,
  );
});

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
  assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 0);
});

Deno.test(
  "webhook: the event id is reserved in webhook_events BEFORE RevenueCat is consulted, through the claim RPC, and marked processed once handled",
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
      const reserveIdx = order.indexOf(`POST ${EVENT_CLAIM_URL}`);
      const rcIdx = order.findIndex((entry) => entry.startsWith(`GET ${RC_URL}`));
      assert(reserveIdx >= 0 && rcIdx >= 0);
      assert(reserveIdx < rcIdx, `reservation precedes verification: ${order.join(" → ")}`);

      const audit = sim.h.callsTo(EVENT_CLAIM_URL).filter((c) => c.method === "POST");
      assertEquals(audit.length, 1);
      const request = audit[0].body as { p_event_id: string; p_payload: unknown };
      assertEquals(request.p_event_id, "evt-audit");
      const row = sim.auditRows.get("evt-audit")!;
      assertEquals(row.id, "evt-audit");
      assertEquals(row.provider, "revenuecat");
      assertEquals(row.event_type, "RENEWAL");
      assertEquals(row.app_user_id, TEST_USER_ID);
      assertEquals(audit[0].headers.apikey, "service-role-test-key");
      assertEquals(
        sim.h.callsTo(EVENTS_URL).filter((call) => call.method !== "GET"),
        [],
      );

      const stored = sim.auditRows.get("evt-audit");
      assert(stored, "audit row present");
      assert(typeof stored.processed_at === "string", "processed_at set on completion");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: a persisted event replay is acknowledged without repeated billing work",
  async () => {
    // A completed audit marker must suppress repeated billing work, even if
    // RevenueCat reports different entitlements by the time it is replayed.
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const event = {
      id: "evt-replay",
      type: "RENEWAL",
      app_user_id: TEST_USER_ID,
    };
    const first = await h.handler(webhookRequest(event));
    assertEquals(first.status, 200);
    await first.json();
    assertEquals(
      storedRows(h, "webhook_events").map((row) => row.id),
      [event.id],
    );
    h.subscriber = { entitlements: {} };
    for (let i = 0; i < 2; i += 1) {
      const replay = await h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
    }
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 1);
    assertEquals(auditWrites(h).length, 1);
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
      assertEquals(sim.auditRows.get("evt-outage")?.processed_at, null);
      assertEquals(sim.h.tables.billing_webhook_claims?.[0]?.lease_token, null);

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
  "webhook: a persisted event replay is acknowledged without repeated billing work",
  async () => {
    // index.ts comments claim "an already-seen event is acknowledged without
    // another RevenueCat round trip", but the upsert result is never inspected.
    const sim = await simulate();
    try {
      const h = sim.h;
      h.subscriber = activeSubscriber();
      const event = {
        id: "evt-persisted-replay",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const first = await h.handler(webhookRequest(event));
      assertEquals(first.status, 200);
      await first.json();
      const persisted = sim.auditRows.get(event.id);
      assert(persisted?.processed_at);
      sim.auditRows.set(event.id, JSON.parse(JSON.stringify(persisted)));
      for (let i = 0; i < 2; i += 1) {
        const replay = await h.handler(webhookRequest(event));
        assertEquals(replay.status, 200);
        assertEquals(await replay.json(), { received: true, duplicate: true });
      }
      assertEquals(h.callsTo(RC_URL).length, 1);
      assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 1);
      assertEquals(sim.auditRows.size, 1);
      assertEquals(sim.auditUpserts(), 1);
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
      const audit = h.callsTo(EVENT_CLAIM_URL).find((c) => c.method === "POST");
      assert(audit, "audit row reserved");
      assertEquals(sim.auditRows.get("evt-transfer")?.app_user_id, TEST_USER_ID);
      assert(typeof sim.auditRows.get("evt-transfer")?.processed_at === "string");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "webhook: TRANSFER whose SECOND subject's billing_entitlements write fails transiently (503 PGRST001) → 503, no completion marker; the redelivery re-verifies and persists BOTH subjects",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) =>
          m === "POST" && u.startsWith(VERDICT_URL) && sim.entitlementUpserts() === 2,
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
      assertEquals(sim.auditRows.get("evt-transfer-fail")?.processed_at, null);
      assertEquals(sim.h.tables.billing_webhook_claims?.[0]?.lease_token, null);

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
  "webhook: FK 23503 plus authoritative Auth absence permits a terminal ack — 200 {verified:false} with the audit row written",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(VERDICT_URL),
        status: 409,
        body: {
          code: "23503",
          message:
            'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
        },
        times: 1,
      });
      sim.h.respond = (call) => {
        if (call.url.endsWith("/auth/v1/admin/users/" + TEST_USER_ID)) {
          sim.h.billingMissingUsers = [TEST_USER_ID];
          return Response.json({ code: "user_not_found" }, { status: 404 });
        }
        return null;
      };
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
        sim.h.callsTo("/auth/v1/admin/users/").length === 1,
        "authoritative Auth absence is checked",
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

Deno.test(
  "webhook: transient upsert failure leaves no marker; retry re-verifies and repairs once",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      h.subscriber = activeSubscriber();
      h.respond = (call) =>
        call.url.includes("/rest/v1/rpc/persist_billing_verdict") ? databaseFailure() : null;
      const event = { id: "evt-persist-repair", type: "RENEWAL", app_user_id: TEST_USER_ID };

      const failed = await h.handler(webhookRequest(event));
      assertEquals(failed.status, 503);
      assert(!JSON.stringify(await failed.json()).includes("private-failure-detail"));
      assertEquals(storedRows(h, "billing_entitlements"), []);
      assertPendingWebhook(h);
      assertEquals(auditWrites(h).length, 0);
      assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);

      h.respond = () => null;
      h.subscriber = { entitlements: {} };
      const repaired = await h.handler(webhookRequest(event));
      assertEquals(repaired.status, 200);
      assertEquals(await repaired.json(), { received: true, verified: true });
      assertEquals(
        storedRows(h, "billing_entitlements").map((row) => row.premium),
        [false],
      );
      assertEquals(
        storedRows(h, "webhook_events").map((row) => row.id),
        [event.id],
      );
      const replay = await h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(h.callsTo(RC_URL).length, 2);
      assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 2);
      assertEquals(auditWrites(h).length, 1);
    });
  },
);

for (const failure of [
  { name: "permission", response: () => databaseFailure("42501", 403) },
  { name: "constraint", response: () => databaseFailure("23514", 400) },
  { name: "unrelated conflict", response: () => databaseFailure("23505", 409) },
  { name: "invalid error code", response: () => databaseFailure(PRIVATE_FAILURE_DETAIL) },
  {
    name: "network",
    response: (): Response => {
      throw new Error(PRIVATE_FAILURE_DETAIL);
    },
  },
]) {
  Deno.test(
    `webhook: ${failure.name} upsert failure is retryable, never proof of a missing user`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.subscriber = activeSubscriber();
        h.respond = (call) =>
          call.url.includes("/rest/v1/rpc/persist_billing_verdict") ? failure.response() : null;
        const response = await h.handler(
          webhookRequest({ id: `evt-persist-${failure.name}`, app_user_id: TEST_USER_ID }),
        );
        assertEquals(response.status, 503);
        assert(!JSON.stringify(await response.json()).includes("private-failure-detail"));
        assertEquals(h.callsTo(RC_URL).length, 1);
        assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
        assertEquals(auditWrites(h).length, 0);
        assertPendingWebhook(h);
      });
    },
  );
}

Deno.test(
  "webhook: a missing profile with an existing Auth user is retryable and repairable",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      h.subscriber = activeSubscriber();
      h.respond = (call) =>
        call.url.includes("/rest/v1/rpc/persist_billing_verdict")
          ? databaseFailure("23503", 409)
          : null;
      const event = { id: "evt-profile-repair", app_user_id: TEST_USER_ID };
      const failed = await h.handler(webhookRequest(event));
      assertEquals(failed.status, 503);
      await failed.json();
      const lookups = h.callsTo("/auth/v1/admin/users/");
      assertEquals(lookups.length, 1);
      assertEquals(lookups[0].method, "GET");
      assert(lookups[0].url.endsWith(TEST_USER_ID));
      assertEquals(lookups[0].headers.apikey, "service-role-test-key");
      assertEquals(lookups[0].headers.authorization, "Bearer service-role-test-key");
      assertEquals(h.callsTo("/rest/v1/profiles").length, 0);
      assertEquals(auditWrites(h).length, 0);

      h.respond = () => null;
      const retry = await h.handler(webhookRequest(event));
      assertEquals(retry.status, 200);
      assertEquals(await retry.json(), { received: true, verified: true });
      assertEquals(storedRows(h, "billing_entitlements").length, 1);
      assertEquals(storedRows(h, "webhook_events").length, 1);
      assertEquals(h.callsTo(RC_URL).length, 2);
    });
  },
);

for (const field of ["code", "error_code"]) {
  Deno.test(
    `webhook: explicit Auth admin 404 user_not_found (${field}) is terminal and replayable`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.subscriber = activeSubscriber();
        h.respond = (call) => {
          if (call.url.includes("/rest/v1/rpc/persist_billing_verdict")) {
            return databaseFailure("23503", 409);
          }
          if (call.url.includes("/auth/v1/admin/users/")) {
            h.billingMissingUsers = [TEST_USER_ID];
            return Response.json(
              { [field]: "user_not_found", message: PRIVATE_FAILURE_DETAIL },
              { status: 404, headers: { "X-Supabase-Api-Version": "2024-01-01" } },
            );
          }
          return null;
        };
        const event = { id: `evt-missing-${field}`, app_user_id: TEST_USER_ID };
        const response = await h.handler(webhookRequest(event));
        assertEquals(response.status, 200);
        assertEquals(await response.json(), { received: true, verified: false });
        const lookup = h.callsTo("/auth/v1/admin/users/");
        assertEquals(lookup.length, 1);
        assertEquals(lookup[0].method, "GET");
        assert(lookup[0].url.endsWith(TEST_USER_ID));
        assertEquals(lookup[0].headers.authorization, "Bearer service-role-test-key");
        assertEquals(lookup[0].headers.apikey, "service-role-test-key");
        assertEquals(storedRows(h, "billing_entitlements"), []);
        assertEquals(
          storedRows(h, "webhook_events").map((row) => row.id),
          [event.id],
        );
        const replay = await h.handler(webhookRequest(event));
        assertEquals(replay.status, 200);
        assertEquals(await replay.json(), { received: true, duplicate: true });
        assertEquals(h.callsTo(RC_URL).length, 1);
        assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
        assertEquals(auditWrites(h).length, 1);
      });
    },
  );
}

for (const lookup of [
  { name: "empty success", status: 200, body: {} },
  { name: "null user", status: 200, body: { user: null } },
  { name: "wrong user", status: 200, body: { id: OTHER_USER_ID } },
  { name: "unqualified 404", status: 404, body: { message: "User not found" } },
  { name: "configuration 404", status: 404, body: { code: "not_admin" } },
  { name: "configuration 401", status: 401, body: { code: "user_not_found" } },
  { name: "configuration 403", status: 403, body: { code: "user_not_found" } },
  { name: "rate limited", status: 429, body: { code: "user_not_found" } },
  { name: "outage", status: 503, body: { code: "user_not_found" } },
  { name: "malformed", status: 404, body: null },
  { name: "network", status: 0, body: null },
]) {
  Deno.test(
    `webhook: Auth admin ${lookup.name} does not prove absence and remains retryable`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.respond = (call) => {
          if (call.url.includes("/rest/v1/rpc/persist_billing_verdict")) {
            return databaseFailure("23503", 409);
          }
          if (call.url.includes("/auth/v1/admin/users/")) {
            if (lookup.status === 0) throw new Error(PRIVATE_FAILURE_DETAIL);
            if (lookup.body === null) return new Response("{", { status: lookup.status });
            return Response.json(
              { ...lookup.body, details: PRIVATE_FAILURE_DETAIL },
              { status: lookup.status, headers: { "X-Supabase-Api-Version": "2024-01-01" } },
            );
          }
          return null;
        };
        const response = await h.handler(
          webhookRequest({ id: `evt-lookup-${lookup.name}`, app_user_id: TEST_USER_ID }),
        );
        assertEquals(response.status, 503);
        assert(!JSON.stringify(await response.json()).includes("private-failure-detail"));
        assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
        assertEquals(h.callsTo(RC_URL).length, 1);
        assertEquals(auditWrites(h).length, 0);
        assertPendingWebhook(h);
      });
    },
  );
}

for (const failure of [
  { name: "database", response: () => databaseFailure() },
  { name: "permission", response: () => databaseFailure("42501", 403) },
  {
    name: "network",
    response: (): Response => {
      throw new Error(PRIVATE_FAILURE_DETAIL);
    },
  },
]) {
  Deno.test(
    `webhook: audit lookup ${failure.name} failure stops processing before billing`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.subscriber = activeSubscriber();
        h.respond = (call) =>
          call.url.includes("/rest/v1/webhook_events") && call.method === "GET"
            ? failure.response()
            : null;
        const event = { id: `evt-audit-lookup-${failure.name}`, app_user_id: TEST_USER_ID };
        const failed = await h.handler(webhookRequest(event));
        assertEquals(failed.status, 503);
        assert(!JSON.stringify(await failed.json()).includes("private-failure-detail"));
        assertEquals(h.callsTo(RC_URL).length, 0);
        assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 0);
        assertEquals(auditWrites(h).length, 0);

        h.respond = () => null;
        const retry = await h.handler(webhookRequest(event));
        assertEquals(retry.status, 200);
        assertEquals(await retry.json(), { received: true, verified: true });
        assertEquals(storedRows(h, "webhook_events").length, 1);
        assertEquals(auditWrites(h).length, 1);
      });
    },
  );
}

for (const appUserId of [TEST_USER_ID, "$RCAnonymousID:anonymous"]) {
  Deno.test(
    `webhook: audit insert failure is retryable for ${appUserId === TEST_USER_ID ? "verified" : "anonymous"} subjects`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.subscriber = activeSubscriber();
        h.respond = (call) =>
          call.url.includes("/rest/v1/rpc/complete_billing_webhook")
            ? databaseFailure("42501", 403)
            : null;
        const event = { id: "evt-audit-repair", app_user_id: appUserId };
        const failed = await h.handler(webhookRequest(event));
        assertEquals(failed.status, 503);
        assert(!JSON.stringify(await failed.json()).includes("private-failure-detail"));
        assertPendingWebhook(h);
        assertEquals(
          storedRows(h, "billing_entitlements").length,
          appUserId === TEST_USER_ID ? 1 : 0,
        );

        h.respond = () => null;
        expireWebhookLease(h, event.id);
        const retry = await h.handler(webhookRequest(event));
        assertEquals(retry.status, 200);
        assertEquals(await retry.json(), { received: true, verified: appUserId === TEST_USER_ID });
        assertEquals(
          storedRows(h, "webhook_events").map((row) => row.id),
          [event.id],
        );
        const replay = await h.handler(webhookRequest(event));
        assertEquals(replay.status, 200);
        assertEquals(await replay.json(), { received: true, duplicate: true });
        assertEquals(h.callsTo(RC_URL).length, appUserId === TEST_USER_ID ? 2 : 0);
        assertEquals(auditWrites(h).length, 2);
      });
    },
  );
}

Deno.test("webhook: a committed audit with lost acknowledgement is safe to replay", async () => {
  await withPrivateErrorCheck(async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.respond = (call) => {
      if (call.url.includes("/rest/v1/rpc/complete_billing_webhook")) {
        const body = call.body as { p_event_id: string; p_payload: unknown };
        h.tables.webhook_events = [
          {
            id: body.p_event_id,
            payload: body.p_payload,
            provider: "revenuecat",
            processed_at: new Date().toISOString(),
          },
        ];
        throw new Error(PRIVATE_FAILURE_DETAIL);
      }
      return null;
    };
    const event = { id: "evt-lost-audit-response", app_user_id: TEST_USER_ID };
    const failed = await h.handler(webhookRequest(event));
    assertEquals(failed.status, 503);
    await failed.json();
    assertEquals(
      storedRows(h, "webhook_events").map((row) => row.id),
      [event.id],
    );
    h.respond = () => null;
    const retry = await h.handler(webhookRequest(event));
    assertEquals(retry.status, 200);
    assertEquals(await retry.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 1);
    assertEquals(auditWrites(h).length, 1);
  });
});

for (const failedUser of [TEST_USER_ID, OTHER_USER_ID]) {
  Deno.test(
    `webhook: TRANSFER ${failedUser === TEST_USER_ID ? "source" : "destination"} failure preserves the other side and retries every subject`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.subscriber = activeSubscriber();
        h.tables.billing_entitlements = [
          { user_id: TEST_USER_ID, premium: true },
          { user_id: OTHER_USER_ID, premium: false },
        ];
        let fail = true;
        h.respond = (call) => {
          if (call.url === `${RC_URL}${TEST_USER_ID}`) {
            return Response.json({ subscriber: { entitlements: {} } });
          }
          if (
            fail &&
            call.url.includes("/rest/v1/rpc/persist_billing_verdict") &&
            (call.body as Record<string, unknown>).p_user_id === failedUser
          ) {
            return databaseFailure();
          }
          return null;
        };
        const event = {
          id: "evt-transfer-repair",
          type: "TRANSFER",
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        };
        const failed = await h.handler(webhookRequest(event));
        assertEquals(failed.status, 503);
        await failed.json();
        const first = storedRows(h, "billing_entitlements");
        assertEquals(
          first.find((row) => row.user_id === TEST_USER_ID)?.premium,
          failedUser === TEST_USER_ID,
        );
        assertEquals(
          first.find((row) => row.user_id === OTHER_USER_ID)?.premium,
          failedUser !== OTHER_USER_ID,
        );
        assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 2);
        assertEquals(auditWrites(h).length, 0);

        fail = false;
        const retry = await h.handler(webhookRequest(event));
        assertEquals(retry.status, 200);
        assertEquals(await retry.json(), { received: true, verified: true });
        const repaired = storedRows(h, "billing_entitlements");
        assertEquals(repaired.find((row) => row.user_id === TEST_USER_ID)?.premium, false);
        assertEquals(repaired.find((row) => row.user_id === OTHER_USER_ID)?.premium, true);
        assertEquals(storedRows(h, "webhook_events").length, 1);
        const replay = await h.handler(webhookRequest(event));
        assertEquals(await replay.json(), { received: true, duplicate: true });
        assertEquals(h.callsTo(RC_URL).length, 4);
        assertEquals(auditWrites(h).length, 1);
      });
    },
  );
}

Deno.test(
  "webhook: TRANSFER provider failure does not prevent the healthy side from persisting",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    let fail = true;
    h.respond = (call) =>
      fail && call.url === `${RC_URL}${TEST_USER_ID}`
        ? new Response("provider unavailable", { status: 503 })
        : null;
    const event = {
      id: "evt-transfer-provider-repair",
      type: "TRANSFER",
      transferred_from: [TEST_USER_ID],
      transferred_to: [OTHER_USER_ID],
    };
    const failed = await h.handler(webhookRequest(event));
    assertEquals(failed.status, 503);
    await failed.json();
    assertEquals(
      storedRows(h, "billing_entitlements").map((row) => row.user_id),
      [OTHER_USER_ID],
    );
    assertEquals(auditWrites(h).length, 0);
    fail = false;
    const retry = await h.handler(webhookRequest(event));
    assertEquals(retry.status, 200);
    assertEquals(await retry.json(), { received: true, verified: true });
    assertEquals(storedRows(h, "billing_entitlements").length, 2);
    assertEquals(storedRows(h, "webhook_events").length, 1);
    assertEquals(h.callsTo(RC_URL).length, 4);
  },
);

Deno.test(
  "webhook: confirmed missing TRANSFER source does not lose the destination entitlement",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      h.subscriber = activeSubscriber();
      h.respond = (call) => {
        if (
          call.url.includes("/rest/v1/rpc/persist_billing_verdict") &&
          (call.body as Record<string, unknown>).p_user_id === TEST_USER_ID
        ) {
          return databaseFailure("23503", 409);
        }
        if (call.url.endsWith(`/auth/v1/admin/users/${TEST_USER_ID}`)) {
          h.billingMissingUsers = [TEST_USER_ID];
          return Response.json({ error_code: "user_not_found" }, { status: 404 });
        }
        return null;
      };
      const response = await h.handler(
        webhookRequest({
          id: "evt-transfer-missing-source",
          type: "TRANSFER",
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        }),
      );
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { received: true, verified: false });
      assertEquals(
        storedRows(h, "billing_entitlements").map((row) => row.user_id),
        [OTHER_USER_ID],
      );
      assertEquals(storedRows(h, "billing_entitlements")[0].premium, true);
      assertEquals(storedRows(h, "webhook_events").length, 1);
      assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
      assertEquals(h.callsTo(RC_URL).length, 2);
    });
  },
);

Deno.test(
  "webhook: simultaneous deliveries verify once but retain one completion marker",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    let lookups = 0;
    let release!: () => void;
    const bothLookups = new Promise<void>((resolve) => (release = resolve));
    h.respond = async (call) => {
      if (call.url.includes("/rest/v1/webhook_events") && call.method === "GET") {
        lookups += 1;
        if (lookups === 2) release();
        await bothLookups;
        return Response.json([]);
      }
      return null;
    };
    const event = { id: "evt-concurrent", app_user_id: TEST_USER_ID };
    const responses = await Promise.all([
      h.handler(webhookRequest(event)),
      h.handler(webhookRequest(event)),
    ]);
    for (const response of responses) {
      assertEquals(response.status, 200);
      const payload = await response.json();
      assertEquals(payload.received, true);
      assert(payload.verified === true || payload.duplicate === true);
    }
    assertEquals(
      storedRows(h, "webhook_events").map((row) => row.id),
      [event.id],
    );
    assertEquals(storedRows(h, "billing_entitlements").length, 1);
    assertEquals(h.callsTo(RC_URL).length, 1);
    h.respond = () => null;
    const replay = await h.handler(webhookRequest(event));
    assertEquals(await replay.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
  },
);

Deno.test(
  "billing sync: failed persistence never returns an unpersisted verified entitlement",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      h.subscriber = activeSubscriber();
      h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      h.respond = (call) =>
        call.url.includes("/rest/v1/rpc/persist_billing_verdict")
          ? databaseFailure("42501", 403)
          : null;
      const request = () =>
        userRequest("POST", "/v1/billing/sync", { token: fakeSupabaseAccessToken() });
      const failed = await h.handler(request());
      assertEquals(failed.status, 503);
      assert(!JSON.stringify(await failed.json()).includes("private-failure-detail"));
      assertEquals(h.callsTo("/rest/v1/rpc/access_state").length, 0);
      assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
      h.respond = () => null;
      const retry = await h.handler(request());
      assertEquals(retry.status, 200);
      const payload = await retry.json();
      assertEquals(payload.billing.premium, true);
      assertEquals(payload.access.premium, true);
      assertEquals(storedRows(h, "billing_entitlements")[0].premium, true);
      assertEquals(h.callsTo(RC_URL).length, 2);
    });
  },
);

Deno.test(
  "billing sync: an authoritatively missing user still cannot receive an unpersisted verdict",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      h.subscriber = activeSubscriber();
      h.respond = (call) => {
        if (call.url.includes("/rest/v1/rpc/persist_billing_verdict")) {
          return databaseFailure("23503", 409);
        }
        if (call.url.includes("/auth/v1/admin/users/")) {
          return Response.json({ code: "user_not_found" }, { status: 404 });
        }
        return null;
      };
      const response = await h.handler(
        userRequest("POST", "/v1/billing/sync", { token: fakeSupabaseAccessToken() }),
      );
      assertEquals(response.status, 503);
      await response.json();
      assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
      assertEquals(h.callsTo("/rest/v1/rpc/access_state").length, 0);
      assertEquals(storedRows(h, "billing_entitlements"), []);
      assertEquals(auditWrites(h).length, 0);
    });
  },
);

for (const olderRoute of ["webhook", "sync"] as const) {
  for (const newerRoute of ["webhook", "sync"] as const) {
    Deno.test(
      `billing ordering: delayed old active ${olderRoute} cannot restore premium after newer refund ${newerRoute}`,
      async () => {
        const h = await loadHarness();
        const userId = crypto.randomUUID();
        h.rpcs.access_state = [{ premium: false, scored_count: 2, reserved_count: 0 }];
        let releaseOld!: () => void;
        let oldStarted!: () => void;
        const started = new Promise<void>((resolve) => (oldStarted = resolve));
        const delayed = new Promise<void>((resolve) => (releaseOld = resolve));
        let fetches = 0;
        h.respond = async (call) => {
          if (call.url !== `${RC_URL}${userId}`) return null;
          fetches += 1;
          if (fetches === 1) {
            oldStarted();
            await delayed;
            return Response.json({ subscriber: activeSubscriber(null) });
          }
          return Response.json({ subscriber: { entitlements: {} } });
        };
        const request = (route: "webhook" | "sync", id: string) =>
          route === "webhook"
            ? webhookRequest({ id, type: "REFUND", app_user_id: userId })
            : userRequest("POST", "/v1/billing/sync", {
                token: fakeSupabaseAccessToken(userId),
                body: {
                  premium: true,
                  verifiedAt: "2999-01-01T00:00:00.000Z",
                  verificationOrder: 9999,
                },
              });
        const older = h.handler(request(olderRoute, `evt-old-${userId}`));
        try {
          await started;
          const newer = await h.handler(request(newerRoute, `evt-new-${userId}`));
          assertEquals(newer.status, 200);
          await newer.json();
          assertEquals(storedRows(h, "billing_entitlements")[0].premium, false);
        } finally {
          releaseOld();
        }
        const response = await older;
        assertEquals(response.status, 200);
        const payload = await response.json();
        const row = storedRows(h, "billing_entitlements")[0];
        assertEquals(row.premium, false, "late old-active work must not undo a refund");
        assertEquals(row.expires_at, null);
        if (olderRoute === "sync") {
          assertEquals(payload.billing.premium, false);
          assertEquals(payload.access.premium, false);
          assertEquals(payload.access.canStartRating, false);
          assertEquals(Object.keys(payload.billing).sort(), [
            "expiresAt",
            "premium",
            "productKey",
            "verifiedAt",
          ]);
        }
        const starts = h.callsTo("/rest/v1/rpc/begin_billing_verification");
        assertEquals(starts.length, 2);
        const providerCalls = h.callsTo(RC_URL);
        assert(h.calls.indexOf(starts[0]) < h.calls.indexOf(providerCalls[0]));
        assert(h.calls.indexOf(starts[1]) < h.calls.indexOf(providerCalls[1]));
        assertEquals(
          h.callsTo("/rest/v1/billing_entitlements").filter((call) => call.method === "POST")
            .length,
          0,
        );
      },
    );
  }
}

for (const olderPremium of [false, true]) {
  Deno.test(
    `billing ordering: older ${olderPremium ? "active" : "inactive"} completion first still yields the newer verified state`,
    async () => {
      const h = await loadHarness();
      const userId = crypto.randomUUID();
      let releaseOld!: () => void;
      let releaseNew!: () => void;
      let oldStarted!: () => void;
      let newStarted!: () => void;
      const oldReady = new Promise<void>((resolve) => (oldStarted = resolve));
      const newReady = new Promise<void>((resolve) => (newStarted = resolve));
      const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
      const newGate = new Promise<void>((resolve) => (releaseNew = resolve));
      let fetches = 0;
      h.respond = async (call) => {
        if (call.url !== `${RC_URL}${userId}`) return null;
        const first = ++fetches === 1;
        if (first) oldStarted();
        else newStarted();
        await (first ? oldGate : newGate);
        return Response.json({
          subscriber: (first ? olderPremium : !olderPremium)
            ? activeSubscriber(null)
            : { entitlements: {} },
        });
      };
      const older = h.handler(webhookRequest({ id: `old-first-${userId}`, app_user_id: userId }));
      await oldReady;
      const newer = h.handler(webhookRequest({ id: `new-last-${userId}`, app_user_id: userId }));
      await newReady;
      releaseOld();
      try {
        assertEquals((await older).status, 200);
      } finally {
        releaseNew();
      }
      assertEquals((await newer).status, 200);
      assertEquals(storedRows(h, "billing_entitlements")[0].premium, !olderPremium);
      assertEquals(h.callsTo("/rest/v1/rpc/begin_billing_verification").length, 2);
    },
  );
}

Deno.test(
  "billing ordering: an unavailable newer verification is not a negative entitlement",
  async () => {
    const h = await loadHarness();
    const userId = crypto.randomUUID();
    h.subscriber = activeSubscriber(null);
    const active = await h.handler(webhookRequest({ id: `active-${userId}`, app_user_id: userId }));
    assertEquals(active.status, 200);
    const prior = structuredClone(storedRows(h, "billing_entitlements"));
    h.subscriber = null;
    const failed = await h.handler(webhookRequest({ id: `outage-${userId}`, app_user_id: userId }));
    assertEquals(failed.status, 503);
    assertEquals(storedRows(h, "billing_entitlements"), prior);
    assertEquals(storedRows(h, "webhook_events").length, 2);
    assertEquals(
      storedRows(h, "webhook_events").filter((row) => row.processed_at !== null).length,
      1,
    );
    assertEquals(h.callsTo("/rest/v1/rpc/begin_billing_verification").length, 2);
  },
);

Deno.test(
  "billing ordering: tickets for every transfer subject precede all provider work",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const response = await h.handler(
      webhookRequest({
        id: "transfer-tickets-before-fetch",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      }),
    );
    assertEquals(response.status, 200);
    const starts = h.callsTo("/rest/v1/rpc/begin_billing_verification");
    assertEquals(starts.length, 1);
    assertEquals(
      new Set((starts[0].body as { p_user_ids: string[] }).p_user_ids),
      new Set([TEST_USER_ID, OTHER_USER_ID]),
    );
    assert(h.calls.indexOf(starts[0]) < h.calls.indexOf(h.callsTo(RC_URL)[0]));
    assertEquals(h.callsTo("/rest/v1/rpc/complete_billing_webhook").length, 1);
  },
);

Deno.test(
  "billing ordering: ticket issuance failure stops before provider or audit writes",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      h.subscriber = activeSubscriber();
      h.rpcErrors.begin_billing_verification = 503;
      const response = await h.handler(
        webhookRequest({ id: "ticket-issuance-outage", app_user_id: TEST_USER_ID }),
      );
      assertEquals(response.status, 503);
      assertEquals(h.callsTo(RC_URL).length, 0);
      assertEquals(storedRows(h, "billing_entitlements"), []);
      assertPendingWebhook(h);
    });
  },
);

for (const subscriber of [
  {},
  { entitlements: null },
  { entitlements: [] },
  { entitlements: { pickle_sensei_pro: null } },
  { entitlements: { pickle_sensei_pro: {} } },
  { entitlements: { pickle_sensei_pro: { expires_date: "invalid" } } },
]) {
  Deno.test(
    `billing ordering: malformed provider snapshot ${JSON.stringify(subscriber)} is not a revocation`,
    async () => {
      const h = await loadHarness();
      h.tables.billing_entitlements = [{ user_id: TEST_USER_ID, premium: true, expires_at: null }];
      const prior = structuredClone(h.tables.billing_entitlements);
      h.subscriber = subscriber;
      const response = await h.handler(
        webhookRequest({ id: "malformed-billing-snapshot", app_user_id: TEST_USER_ID }),
      );
      assertEquals(response.status, 503);
      assertEquals(h.tables.billing_entitlements, prior);
      assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 0);
      assertEquals(auditWrites(h).length, 0);
    },
  );
}

for (const result of [
  null,
  [],
  { outcome: "duplicate", event_id: "another-event" },
  [{ outcome: "issued", user_id: OTHER_USER_ID, ticket_id: crypto.randomUUID() }],
  [{ outcome: "issued", user_id: TEST_USER_ID, ticket_id: "not-a-ticket" }],
  [{ outcome: "unknown", user_id: TEST_USER_ID, ticket_id: crypto.randomUUID() }],
]) {
  Deno.test(
    `billing ordering: invalid DB ticket allocation ${JSON.stringify(result)} fails before provider work`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.rpcs.begin_billing_verification = result;
        const response = await h.handler(
          webhookRequest({ id: "bad-allocation", app_user_id: TEST_USER_ID }),
        );
        assertEquals(response.status, 503);
        assertEquals(h.callsTo(RC_URL).length, 0);
        assertEquals(auditWrites(h).length, 0);
      });
    },
  );
}

for (const repeated of ["subject", "ticket"]) {
  Deno.test(
    `billing ordering: duplicate ${repeated} bindings in a transfer allocation fail closed`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        const ticket = crypto.randomUUID();
        h.rpcs.begin_billing_verification = [
          { outcome: "issued", user_id: TEST_USER_ID, ticket_id: ticket },
          {
            outcome: "issued",
            user_id: repeated === "subject" ? TEST_USER_ID : OTHER_USER_ID,
            ticket_id: repeated === "ticket" ? ticket : crypto.randomUUID(),
          },
        ];
        const response = await h.handler(
          webhookRequest({
            id: "duplicate-transfer-ticket",
            type: "TRANSFER",
            transferred_from: [TEST_USER_ID],
            transferred_to: [OTHER_USER_ID],
          }),
        );
        assertEquals(response.status, 503);
        assertEquals(h.callsTo(RC_URL).length, 0);
        assertEquals(auditWrites(h).length, 0);
      });
    },
  );
}

for (const result of [
  null,
  { outcome: "persisted", user_id: TEST_USER_ID },
  { outcome: "user_missing", user_id: OTHER_USER_ID },
  {
    outcome: "persisted",
    user_id: OTHER_USER_ID,
    applied: true,
    billing: {
      premium: true,
      productKey: null,
      expiresAt: null,
      verifiedAt: "2026-01-01T00:00:00Z",
      activeEntitlements: ["pickle_sensei_pro"],
    },
  },
  {
    outcome: "persisted",
    user_id: TEST_USER_ID,
    applied: true,
    billing: {
      premium: true,
      productKey: null,
      expiresAt: null,
      verifiedAt: "invalid",
      activeEntitlements: ["pickle_sensei_pro"],
    },
  },
  ...[
    { productKey: "stale-product", expiresAt: null },
    { productKey: null, expiresAt: "2099-01-01T00:00:00Z" },
  ].map((stale) => ({
    outcome: "persisted",
    user_id: TEST_USER_ID,
    applied: true,
    billing: {
      premium: false,
      ...stale,
      verifiedAt: "2026-01-01T00:00:00Z",
      activeEntitlements: [],
    },
  })),
]) {
  Deno.test(
    `billing ordering: invalid persistence acknowledgement ${JSON.stringify(result)} never completes an event`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        h.subscriber = activeSubscriber();
        h.rpcs.persist_billing_verdict = result;
        const response = await h.handler(
          webhookRequest({ id: "invalid-persist-result", app_user_id: TEST_USER_ID }),
        );
        assertEquals(response.status, 503);
        assertEquals(auditWrites(h).length, 0);
      });
    },
  );
}

Deno.test(
  "billing ordering: an overlapping transfer retry cannot be undone by either late original subject",
  async () => {
    const h = await loadHarness();
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => (oldStarted = resolve));
    const delayed = new Promise<void>((resolve) => (releaseOld = resolve));
    let sourceFetches = 0;
    let destinationFetches = 0;
    h.respond = async (call) => {
      if (call.url === `${RC_URL}${TEST_USER_ID}`) {
        if (++sourceFetches === 1) {
          oldStarted();
          await delayed;
          return Response.json({ subscriber: activeSubscriber(null) });
        }
        return Response.json({ subscriber: { entitlements: {} } });
      }
      if (call.url === `${RC_URL}${OTHER_USER_ID}`) {
        return Response.json({
          subscriber: ++destinationFetches === 1 ? activeSubscriber(null) : { entitlements: {} },
        });
      }
      return null;
    };
    const event = {
      id: "overlapping-transfer-retry",
      type: "TRANSFER",
      transferred_from: [TEST_USER_ID],
      transferred_to: [OTHER_USER_ID],
    };
    const older = h.handler(webhookRequest(event));
    try {
      await started;
      expireWebhookLease(h, event.id);
      const newer = await h.handler(webhookRequest(event));
      assertEquals(newer.status, 200);
      assertEquals(await newer.json(), { received: true, verified: true });
    } finally {
      releaseOld();
    }
    const response = await older;
    assertEquals(response.status, 503);
    await response.json();
    const rows = storedRows(h, "billing_entitlements");
    assertEquals(rows.find((row) => row.user_id === TEST_USER_ID)?.premium, false);
    assertEquals(rows.find((row) => row.user_id === OTHER_USER_ID)?.premium, true);
    assertEquals(storedRows(h, "webhook_events").length, 1);
    assert(
      rows.every((row) => row.verification_order === 2),
      "neither stale subject overwrites the newer transfer",
    );
    assertEquals(h.callsTo(RC_URL).length, 4);
    const tickets = storedRows(h, "billing_verification_tickets");
    assertEquals(
      tickets.map((row) => row.verification_order),
      [1, 1, 2, 2],
    );
  },
);

Deno.test(
  "billing ordering: DB-confirmed absence at issuance preserves the healthy transfer side",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.billingMissingUsers = [TEST_USER_ID];
    const response = await h.handler(
      webhookRequest({
        id: "absent-before-issuance",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { received: true, verified: false });
    assertEquals(
      h.callsTo(RC_URL).map((call) => call.url),
      [`${RC_URL}${OTHER_USER_ID}`],
    );
    assertEquals(
      storedRows(h, "billing_entitlements").map((row) => row.user_id),
      [OTHER_USER_ID],
    );
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

Deno.test(
  "billing ordering: deletion during provider fetch is terminal only after DB confirmation",
  async () => {
    const h = await loadHarness();
    h.respond = (call) => {
      if (call.url === `${RC_URL}${TEST_USER_ID}`) {
        h.billingMissingUsers = [TEST_USER_ID];
        return Response.json({ subscriber: activeSubscriber(null) });
      }
      return null;
    };
    const response = await h.handler(
      webhookRequest({ id: "deleted-during-fetch", app_user_id: TEST_USER_ID }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { received: true, verified: false });
    assertEquals(storedRows(h, "billing_entitlements"), []);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

Deno.test(
  "billing ordering: a subject appearing after a missing allocation cannot get an unverified completion marker",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      h.rpcs.begin_billing_verification = [{ outcome: "user_missing", user_id: TEST_USER_ID }];
      const response = await h.handler(
        webhookRequest({ id: "appeared-before-audit", app_user_id: TEST_USER_ID }),
      );
      assertEquals(response.status, 503);
      assertPendingWebhook(h);
      assertEquals(h.callsTo(RC_URL).length, 0);
    });
  },
);

Deno.test(
  "billing ordering: old audit markers remain untouched and conflicts never authorize new subjects",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      const payload = {
        api_version: "1.0",
        event: { id: "historical-marker", app_user_id: TEST_USER_ID },
      };
      const historical = {
        id: "historical-marker",
        payload,
        provider: "revenuecat",
        received_at: "2026-01-01T00:00:00Z",
        processed_at: "2026-01-01T00:00:00Z",
      };
      h.tables.webhook_events = [historical];
      const replay = await h.handler(webhookRequest(payload.event));
      assertEquals(await replay.json(), { received: true, duplicate: true });
      const conflict = await h.handler(
        webhookRequest({ ...payload.event, app_user_id: OTHER_USER_ID }),
      );
      assertEquals(conflict.status, 503);
      assertEquals(h.callsTo(RC_URL).length, 0);
      assertEquals(h.callsTo("/rest/v1/rpc/begin_billing_verification").length, 0);
      assertEquals(h.tables.webhook_events, [historical]);
      assertEquals(auditWrites(h).length, 0);
    });
  },
);

Deno.test(
  "billing claims: a stale audit lookup cannot allocate new verification after completion",
  async () => {
    const h = await loadHarness();
    const event = { id: "completed-before-ticket-issuance", app_user_id: TEST_USER_ID };
    h.subscriber = { entitlements: {} };
    assertEquals((await h.handler(webhookRequest(event))).status, 200);
    const prior = structuredClone(storedRows(h, "billing_entitlements"));
    h.subscriber = activeSubscriber(null);
    h.respond = (call) =>
      call.url.includes("/rest/v1/webhook_events") && call.method === "GET"
        ? Response.json([])
        : null;
    const replay = await h.handler(webhookRequest(event));
    assertEquals(replay.status, 200);
    assertEquals(await replay.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(storedRows(h, "billing_verification_tickets").length, 1);
    assertEquals(storedRows(h, "billing_entitlements"), prior);
    assertEquals(auditWrites(h).length, 1);
  },
);

Deno.test(
  "billing claims: conflicting in-flight subjects are rejected before provider verification",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      const event = { id: "inflight-subject-conflict", app_user_id: TEST_USER_ID };
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const providerStarted = new Promise<void>((resolve) => (ready = resolve));
      h.respond = async (call) => {
        if (call.url === `${RC_URL}${TEST_USER_ID}`) {
          ready();
          await gate;
          return Response.json({ subscriber: { entitlements: {} } });
        }
        return null;
      };
      const first = h.handler(webhookRequest(event));
      try {
        await providerStarted;
        const conflicting = await h.handler(
          webhookRequest({ ...event, app_user_id: OTHER_USER_ID }),
        );
        assertEquals(conflicting.status, 503);
        await conflicting.json();
        assertEquals(h.callsTo(RC_URL).length, 1);
        assertEquals(storedRows(h, "billing_verification_tickets").length, 1);
        assertEquals(storedRows(h, "billing_entitlements"), []);
        assertPendingWebhook(h);
      } finally {
        release();
        await first;
      }
      assertEquals((await first).status, 200);
      assertEquals(storedRows(h, "webhook_events").length, 1);
    });
  },
);

Deno.test(
  "billing claims: anonymous audit failure still binds the event before a changed-scope retry",
  async () => {
    await withPrivateErrorCheck(async () => {
      const h = await loadHarness();
      const event = { id: "anonymous-claim-conflict", app_user_id: "$RCAnonymousID:claim" };
      h.respond = (call) =>
        call.url.includes("/rest/v1/rpc/complete_billing_webhook") ? databaseFailure() : null;
      assertEquals((await h.handler(webhookRequest(event))).status, 503);
      h.respond = () => null;
      const conflicting = await h.handler(webhookRequest({ ...event, app_user_id: TEST_USER_ID }));
      assertEquals(conflicting.status, 503);
      assertEquals(h.callsTo(RC_URL).length, 0);
      assertEquals(storedRows(h, "billing_entitlements"), []);
      assertPendingWebhook(h);
      expireWebhookLease(h, event.id);
      const replay = await h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, verified: false });
      assertEquals(storedRows(h, "webhook_events").length, 1);
    });
  },
);

Deno.test(
  "billing claims: replay equality is jsonb equality, not JSON object key order",
  async () => {
    const h = await loadHarness();
    const event = {
      id: "reordered-claim-payload",
      app_user_id: TEST_USER_ID,
      context: { b: "value", a: 1 },
    };
    assertEquals((await h.handler(webhookRequest(event))).status, 200);
    const original = structuredClone(storedRows(h, "webhook_events"));
    h.respond = (call) =>
      call.url.includes("/rest/v1/webhook_events") && call.method === "GET"
        ? Response.json([])
        : null;
    const replay = await h.handler(
      webhookRequest(null, {
        rawBody: JSON.stringify({
          event: { context: { a: 1, b: "value" }, app_user_id: TEST_USER_ID, id: event.id },
          api_version: "1.0",
        }),
      }),
    );
    assertEquals(replay.status, 200);
    assertEquals(await replay.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(storedRows(h, "webhook_events"), original);
  },
);

for (const [route, unavailable] of [
  ["webhook", "missing RPC"],
  ["sync", "missing RPC"],
  ["sync", "unexpected duplicate"],
] as const) {
  Deno.test(
    `billing rollout: ${route} with ${unavailable} fails before provider work`,
    async () => {
      await withPrivateErrorCheck(async () => {
        const h = await loadHarness();
        const userId = crypto.randomUUID();
        const existing = { user_id: userId, premium: true, verification_order: 0 };
        h.tables.billing_entitlements = [existing];
        h.respond = (call) => {
          if (!call.url.includes("/rest/v1/rpc/begin_billing_verification")) return null;
          return unavailable === "missing RPC"
            ? databaseFailure("PGRST202", 404)
            : Response.json({ outcome: "duplicate", event_id: "not-a-sync-event" });
        };
        const request =
          route === "webhook"
            ? webhookRequest({ id: `rollout-${userId}`, app_user_id: userId })
            : userRequest("POST", "/v1/billing/sync", { token: fakeSupabaseAccessToken(userId) });
        const response = await h.handler(request);
        assertEquals(response.status, 503);
        await response.json();
        assertEquals(h.callsTo(RC_URL).length, 0);
        assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 0);
        assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
        assertEquals(auditWrites(h).length, 0);
        assertEquals(storedRows(h, "billing_entitlements"), [existing]);
      });
    },
  );
}

Deno.test(
  "billing verification: provider 404, 429 and 503 are unavailable, never negative snapshots on either route",
  async () => {
    const h = await loadHarness();
    for (const route of ["webhook", "sync"] as const) {
      for (const status of [404, 429, 503]) {
        h.reset();
        const userId = crypto.randomUUID();
        h.subscriber = activeSubscriber(null);
        h.rpcs.access_state = [{ premium: false, scored_count: 2, reserved_count: 0 }];
        const request = (id: string) =>
          route === "webhook"
            ? webhookRequest({ id, app_user_id: userId })
            : userRequest("POST", "/v1/billing/sync", { token: fakeSupabaseAccessToken(userId) });
        assertEquals((await h.handler(request(`active-${userId}`))).status, 200);
        const original = structuredClone(storedRows(h, "billing_entitlements"));
        const markers = structuredClone(storedRows(h, "webhook_events"));
        h.respond = (call) =>
          call.url.startsWith(RC_URL) ? Response.json({ error: "unavailable" }, { status }) : null;
        const response = await h.handler(request(`unavailable-${userId}`));
        assertEquals(response.status, route === "webhook" ? 503 : 502);
        await response.json();
        assertEquals(storedRows(h, "billing_entitlements"), original);
        assertEquals(
          storedRows(h, "webhook_events").filter((row) => row.processed_at !== null),
          markers,
        );
        assertEquals(
          storedRows(h, "webhook_events").filter((row) => row.processed_at === null).length,
          route === "webhook" ? 1 : 0,
        );
        assertEquals(h.callsTo("/rest/v1/rpc/persist_billing_verdict").length, 1);
      }
    }
  },
);
