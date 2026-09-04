// POST /webhooks/revenuecat — secret gating, never-trust-body re-verification,
// audit logging, replay handling (stateful idempotency row), retryable
// persistence failures, RevenueCat upstream diagnostics, canonical subject
// ids, and TRANSFER events.
//
// Run: deno test -A supabase/functions/api/__wf__/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  activeSubscriber,
  captureConsole,
  loadHarness,
  OTHER_USER_ID,
  type PostgrestFailure,
  RC_URL,
  TEST_USER_ID,
  webhookRequest,
} from "./routesHarness.ts";

/** Postgres "the database system is starting up" — a transient failure that
 * must make RevenueCat redeliver. */
const TRANSIENT_DB: PostgrestFailure = {
  status: 503,
  code: "57P03",
  message: "the database system is starting up",
};

/** FK violation: the subject never bootstrapped, so there is no profiles row
 * to reference — the one non-retryable persist failure. */
const FK_VIOLATION: PostgrestFailure = {
  status: 409,
  code: "23503",
  message:
    'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
};

const HEX_USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HEX_USER_ID_UPPER = HEX_USER_ID.toUpperCase();

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
  "webhook: a processed event id is acknowledged as duplicate with zero RevenueCat calls; a failed id is NOT deduped",
  async () => {
    const h = await loadHarness();
    const store = h.useBillingStore();
    h.subscriber = activeSubscriber();
    const event = {
      id: "evt-replay",
      type: "RENEWAL",
      app_user_id: TEST_USER_ID,
    };
    const first = await h.handler(webhookRequest(event));
    assertEquals(first.status, 200);
    assertEquals(await first.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(store.webhookEvents.has("evt-replay"), true);

    for (let i = 0; i < 2; i += 1) {
      const replay = await h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
    }
    assertEquals(h.callsTo(RC_URL).length, 1, "replays never re-verify");
    assertEquals(store.entitlementUpserts.length, 1, "replays never re-persist");

    // A delivery that failed (RevenueCat unreachable) leaves no audit row, so
    // the redelivery is processed in full.
    h.subscriber = null;
    const failed = await h.handler(
      webhookRequest({ id: "evt-failed", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(failed.status, 503);
    await failed.text();
    assertEquals(store.webhookEvents.has("evt-failed"), false);
    h.subscriber = activeSubscriber();
    const redelivered = await h.handler(
      webhookRequest({ id: "evt-failed", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(redelivered.status, 200);
    assertEquals(await redelivered.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 3);
    assertEquals(store.entitlementUpserts.length, 2);
    assertEquals(store.webhookEvents.has("evt-failed"), true);
  },
);

Deno.test(
  "webhook: transient billing_entitlements failure (57P03) → 5xx, no audit row; the redelivery re-verifies once and persists",
  async () => {
    const h = await loadHarness();
    const store = h.useBillingStore();
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber();
      store.failEntitlementUpsert = (n) => (n === 0 ? TRANSIENT_DB : null);
      const event = { id: "evt-transient", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID };

      const first = await h.handler(webhookRequest(event));
      assert(
        first.status >= 500 && first.status < 600,
        `retryable 5xx expected, got ${first.status}`,
      );
      const body = (await first.json()) as { error: { message: string } };
      assertEquals(
        body.error.message.includes(TRANSIENT_DB.message),
        false,
        "5xx bodies stay generic",
      );
      assertEquals(store.entitlements.size, 0);
      assertEquals(store.webhookEvents.size, 0, "a failed delivery leaves no idempotency row");
      assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);
      assert(
        log.lines.some((line) => line.includes(TRANSIENT_DB.message)),
        "operators get the database detail in the function log",
      );

      // Database healthy again; RevenueCat redelivers the same event id.
      const redelivered = await h.handler(webhookRequest(event));
      assertEquals(redelivered.status, 200);
      assertEquals(await redelivered.json(), { received: true, verified: true });
      assertEquals(h.callsTo(RC_URL).length, 2, "one RevenueCat GET per delivery");
      assertEquals(store.entitlementUpserts.length, 2, "one upsert per delivery");
      assertEquals(store.entitlements.get(TEST_USER_ID)?.premium, true);
      assertEquals(store.webhookEvents.has("evt-transient"), true);
    } finally {
      log.restore();
    }
  },
);

Deno.test(
  "webhook: FK violation (23503, subject never bootstrapped) keeps the acknowledge contract — 200 verified:false and an audit row",
  async () => {
    const h = await loadHarness();
    const store = h.useBillingStore();
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber();
      store.failEntitlementUpsert = () => FK_VIOLATION;
      const res = await h.handler(
        webhookRequest({ id: "evt-fk", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(store.entitlements.size, 0);
      assertEquals(store.webhookEvents.has("evt-fk"), true, "audit row preserves the event");
      assert(log.lines.some((line) => line.includes("23503") || line.includes(FK_VIOLATION.message)));

      // The audit row means the replay is a duplicate: no second RevenueCat read.
      const replay = await h.handler(
        webhookRequest({ id: "evt-fk", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(h.callsTo(RC_URL).length, 1);
    } finally {
      log.restore();
    }
  },
);

Deno.test(
  "webhook: TRANSFER whose transferred_to upsert fails with a non-23503 error → 5xx and no audit row",
  async () => {
    const h = await loadHarness();
    const store = h.useBillingStore();
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber();
      // Subject order is transferred_from first, transferred_to second.
      store.failEntitlementUpsert = (n) => (n === 1 ? TRANSIENT_DB : null);
      const res = await h.handler(
        webhookRequest({
          id: "evt-transfer-partial",
          type: "TRANSFER",
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        }),
      );
      assert(res.status >= 500 && res.status < 600, `retryable 5xx expected, got ${res.status}`);
      await res.text();
      assertEquals(store.entitlementUpserts.length, 2, "both sides were attempted");
      assertEquals(store.entitlements.has(OTHER_USER_ID), false);
      assertEquals(store.webhookEvents.size, 0, "partial persistence is never sealed as processed");

      // Redelivery persists both sides and seals the event.
      const redelivered = await h.handler(
        webhookRequest({
          id: "evt-transfer-partial",
          type: "TRANSFER",
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        }),
      );
      assertEquals(redelivered.status, 200);
      assertEquals(await redelivered.json(), { received: true, verified: true });
      assertEquals(store.entitlements.has(TEST_USER_ID), true);
      assertEquals(store.entitlements.has(OTHER_USER_ID), true);
      assertEquals(store.webhookEvents.has("evt-transfer-partial"), true);
    } finally {
      log.restore();
    }
  },
);

// ── RevenueCat upstream failures leave a diagnostic naming the status ───────

/** The key the harness installs; read after loadHarness() so the assertion
 * checks the value the handler actually sent. */
const rcKey = (): string => {
  const key = Deno.env.get("REVENUECAT_SECRET_API_KEY");
  assert(key, "harness must install REVENUECAT_SECRET_API_KEY");
  return key;
};

for (const status of [401, 403, 429, 500]) {
  Deno.test(
    `webhook: RevenueCat ${status} → 503 (retryable) with a console.error naming RevenueCat and ${status}; the API key never appears in the log`,
    async () => {
      const h = await loadHarness();
      const log = captureConsole();
      try {
        h.rcStatus = status;
        const res = await h.handler(
          webhookRequest({ id: `evt-rc-${status}`, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(res.status, 503);
        await res.text();
        assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
        const diagnostic = log.lines.find(
          (line) => /revenuecat/i.test(line) && line.includes(String(status)),
        );
        assert(diagnostic, `expected a RevenueCat ${status} diagnostic, got ${JSON.stringify(log.lines)}`);
        assertStringIncludes(diagnostic, "7225", "RevenueCat's own error code is included");
        for (const line of log.lines) {
          assertEquals(line.includes(rcKey()), false, `secret leaked into log: ${line}`);
        }
      } finally {
        log.restore();
      }
    },
  );
}

Deno.test(
  "webhook: RevenueCat fetch exception (timeout) → 503 with a console.error naming RevenueCat and the error name",
  async () => {
    const h = await loadHarness();
    const log = captureConsole();
    try {
      h.rcError = new DOMException("Signal timed out.", "TimeoutError");
      const res = await h.handler(
        webhookRequest({ id: "evt-rc-timeout", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 503);
      await res.text();
      const diagnostic = log.lines.find((line) => /revenuecat/i.test(line));
      assert(diagnostic, `expected a RevenueCat diagnostic, got ${JSON.stringify(log.lines)}`);
      assertStringIncludes(diagnostic, "TimeoutError");
      for (const line of log.lines) assertEquals(line.includes(rcKey()), false);
    } finally {
      log.restore();
    }
  },
);

// ── Subject ids are canonical (lowercase) before RevenueCat AND the upsert ────
//
// RevenueCat app user ids are case-sensitive while Postgres folds uuid text,
// so an uppercase subject would query a DIFFERENT RevenueCat subscriber and
// write its (empty) verdict onto the real user's row.

Deno.test(
  "webhook: uppercase-hex app_user_id is canonicalised — RevenueCat URL and billing_entitlements.user_id are both lowercase",
  async () => {
    const h = await loadHarness();
    const store = h.useBillingStore();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({ id: "evt-upper", type: "CANCELLATION", app_user_id: HEX_USER_ID_UPPER }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assertEquals(rc[0].url, `${RC_URL}${HEX_USER_ID}`);
    assertEquals(store.entitlementUpserts.length, 1);
    assertEquals(store.entitlementUpserts[0].user_id, HEX_USER_ID);
    assertEquals(store.webhookEvents.get("evt-upper")?.app_user_id, HEX_USER_ID);
  },
);

Deno.test(
  "webhook: uppercase-hex ids inside aliases[], transferred_from[] and transferred_to[] are canonicalised the same way",
  async () => {
    const h = await loadHarness();
    const store = h.useBillingStore();
    h.subscriber = activeSubscriber();

    const viaAlias = await h.handler(
      webhookRequest({
        id: "evt-upper-alias",
        type: "RENEWAL",
        app_user_id: "$RCAnonymousID:abc",
        aliases: ["$RCAnonymousID:abc", HEX_USER_ID_UPPER],
      }),
    );
    assertEquals(viaAlias.status, 200);
    assertEquals(await viaAlias.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).map((c) => c.url), [`${RC_URL}${HEX_USER_ID}`]);
    assertEquals(store.entitlementUpserts.map((r) => r.user_id), [HEX_USER_ID]);

    const other = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const viaTransfer = await h.handler(
      webhookRequest({
        id: "evt-upper-transfer",
        type: "TRANSFER",
        transferred_from: [HEX_USER_ID_UPPER],
        transferred_to: [other.toUpperCase()],
      }),
    );
    assertEquals(viaTransfer.status, 200);
    assertEquals(await viaTransfer.json(), { received: true, verified: true });
    const urls = h.callsTo(RC_URL).map((c) => c.url);
    assertEquals(urls.length, 3);
    assert(urls.includes(`${RC_URL}${HEX_USER_ID}`) && urls.includes(`${RC_URL}${other}`));
    for (const url of urls) assertEquals(url, url.toLowerCase());
    const rows = store.entitlementUpserts.map((r) => r.user_id);
    assertEquals(rows.length, 3);
    assert(rows.includes(other));
    for (const row of rows) assertEquals(row, String(row).toLowerCase());
    assertEquals(store.webhookEvents.get("evt-upper-transfer")?.app_user_id, HEX_USER_ID);
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
