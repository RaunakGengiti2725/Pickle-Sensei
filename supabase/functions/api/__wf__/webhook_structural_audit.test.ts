/**
 * Structural audit probes — POST /webhooks/revenuecat (edge-billing-webhook,
 * pass 1 of 3). Each `Deno.test` is either
 *
 *   HOLDS:  an invariant the mapper/code comments claim; expected to pass on
 *           4d812e1a (listed under verified_ok in the audit report), or
 *   PROBE:  a suspected defect written as the CORRECT expectation; a failure
 *           on 4d812e1a is the reproduction of the finding.
 *
 * Run:  (cd supabase/functions/api/__wf__ && deno test -A --no-check \
 *          --config deno.json webhook_structural_audit.test.ts)
 *
 * The harness persists PostgREST writes (see webhookAuditHarness.ts) so the
 * dedupe short-circuit and the audit-row side effects are observable.
 * Audit-only file: production code and existing tests are untouched.
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  activeSubscriber,
  lapsedSubscriber,
  loadAuditHarness,
  nextIp,
  OTHER_USER_ID,
  RC_URL,
  readJson,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  TEST_USER_ID,
  webhookRequest,
} from "./webhookAuditHarness.ts";

const ENT = `${SUPABASE_URL}/rest/v1/billing_entitlements`;
const EVT = `${SUPABASE_URL}/rest/v1/webhook_events`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pgrst = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ─── HOLDS: configuration fail-closed ───────────────────────────────────────
// Must run before any other webhook request in this module: the service-role
// client is created lazily and cached on first use, so this is the only
// moment the "unset" branch (index.ts:2265-2268) is reachable.

Deno.test(
  "HOLDS: SUPABASE_SERVICE_ROLE_KEY unset → 503, no RevenueCat call, no writes",
  async () => {
    const h = await loadAuditHarness();
    Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    try {
      const res = await h.handler(
        webhookRequest({ id: "evt-no-service-role", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 503);
      await res.body?.cancel();
      assertEquals(h.calls.length, 0);
      assertEquals(h.webhookEvents.size, 0);
    } finally {
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
    }
  },
);

Deno.test(
  "HOLDS: REVENUECAT_WEBHOOK_AUTH unset → 503 even with a body that would otherwise verify",
  async () => {
    const h = await loadAuditHarness();
    const saved = Deno.env.get("REVENUECAT_WEBHOOK_AUTH") ?? "";
    Deno.env.delete("REVENUECAT_WEBHOOK_AUTH");
    try {
      const res = await h.handler(
        webhookRequest(
          { id: "evt-no-secret", type: "RENEWAL", app_user_id: TEST_USER_ID },
          { secret: "" },
        ),
      );
      assertEquals(res.status, 503);
      await res.body?.cancel();
      assertEquals(h.calls.length, 0);
    } finally {
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", saved);
    }
  },
);

// ─── HOLDS: I13 dedupe short-circuit (claimed, previously unpinned) ─────────

Deno.test(
  "HOLDS (I13): replayed event id → 200 {duplicate:true}, ONE RevenueCat call, ONE entitlement write",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    const event = { id: "evt-replay-1", type: "RENEWAL", app_user_id: TEST_USER_ID };

    const first = await readJson(await h.handler(webhookRequest(event)));
    assertEquals(first, { received: true, verified: true });
    const second = await readJson(await h.handler(webhookRequest(event)));
    const third = await readJson(await h.handler(webhookRequest(event)));
    assertEquals(second, { received: true, duplicate: true });
    assertEquals(third, { received: true, duplicate: true });

    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo(ENT).filter((c) => c.method === "POST").length, 1);
    assertEquals(h.webhookEvents.size, 1);
    assertEquals(h.billingEntitlements.get(TEST_USER_ID)?.premium, true);
  },
);

Deno.test(
  "HOLDS: audit row carries id/provider/type/app_user_id/full payload and uses ignore-duplicates + service role",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    const event = {
      id: "evt-audit-shape",
      type: "INITIAL_PURCHASE",
      app_user_id: TEST_USER_ID,
      forged: 1,
    };
    await (await h.handler(webhookRequest(event))).body?.cancel();
    const write = h.callsTo(EVT).find((c) => c.method === "POST");
    assert(write);
    assertEquals(write.headers["apikey"], SERVICE_ROLE_KEY);
    assertMatch(write.headers["prefer"] ?? "", /resolution=ignore-duplicates/);
    const row = h.webhookEvents.get("evt-audit-shape");
    assert(row);
    assertEquals(row.provider, "revenuecat");
    assertEquals(row.event_type, "INITIAL_PURCHASE");
    assertEquals(row.app_user_id, TEST_USER_ID);
    assertEquals((row.payload as Record<string, unknown>).event, event);
    const ent = h.callsTo(ENT).find((c) => c.method === "POST");
    assert(ent);
    assertEquals(ent.headers["apikey"], SERVICE_ROLE_KEY);
    assertEquals(ent.headers["authorization"], `Bearer ${SERVICE_ROLE_KEY}`);
  },
);

// ─── HOLDS: I5 outage → 503, nothing persisted, later replay is processed ──

Deno.test(
  "HOLDS (I5): RevenueCat 500 → 503 with no audit row; the same id is fully processed once RC recovers",
  async () => {
    const h = await loadAuditHarness();
    const event = { id: "evt-outage-then-ok", type: "RENEWAL", app_user_id: TEST_USER_ID };
    h.subscriber = null;
    const down = await h.handler(webhookRequest(event));
    assertEquals(down.status, 503);
    await down.body?.cancel();
    assertEquals(h.webhookEvents.size, 0);
    assertEquals(h.billingEntitlements.size, 0);

    h.subscriber = activeSubscriber();
    const up = await readJson(await h.handler(webhookRequest(event)));
    assertEquals(up, { received: true, verified: true });
    assertEquals(h.webhookEvents.size, 1);
    assertEquals(h.billingEntitlements.get(TEST_USER_ID)?.premium, true);
  },
);

Deno.test(
  "HOLDS: RevenueCat 401 / 403 / 429 / non-JSON 200 / missing subscriber all → 503 and nothing persisted",
  async () => {
    const h = await loadAuditHarness();
    const answers: Array<() => Response> = [
      () =>
        new Response(JSON.stringify({ code: 7225, message: "Invalid API key." }), { status: 401 }),
      () => new Response("forbidden", { status: 403 }),
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }),
      () => new Response("<html>not json</html>", { status: 200 }),
      () => new Response(JSON.stringify({ request_date_ms: 1 }), { status: 200 }),
    ];
    for (const [i, make] of answers.entries()) {
      h.subscriber = () => make();
      const res = await h.handler(
        webhookRequest({ id: `evt-rc-fail-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 503, `answer #${i}`);
      await res.body?.cancel();
    }
    assertEquals(h.webhookEvents.size, 0);
    assertEquals(h.billingEntitlements.size, 0);
  },
);

// ─── HOLDS: I2/I6/I7/I8 contract corners ─────────────────────────────────────

Deno.test(
  "HOLDS (I2): forged body entitlements never reach billing_entitlements; RC verdict (lapsed) wins",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = lapsedSubscriber();
    const res = await readJson(
      await h.handler(
        webhookRequest({
          id: "evt-forged",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
          entitlement_ids: ["pickle_sensei_pro"],
          expiration_at_ms: Date.now() + 10 * 86_400_000,
          premium: true,
        }),
      ),
    );
    assertEquals(res, { received: true, verified: true });
    const row = h.billingEntitlements.get(TEST_USER_ID);
    assert(row);
    assertEquals(row.premium, false);
  },
);

Deno.test(
  "HOLDS (I6): non-UUID app_user_id with no UUID alias → 200 verified:false, audit row with app_user_id null, no RC call",
  async () => {
    const h = await loadAuditHarness();
    const res = await readJson(
      await h.handler(
        webhookRequest({
          id: "evt-anon",
          type: "TEST",
          app_user_id: "$RCAnonymousID:abc123",
          aliases: ["$RCAnonymousID:abc123", "not-a-uuid"],
        }),
      ),
    );
    assertEquals(res, { received: true, verified: false });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.webhookEvents.get("evt-anon")?.app_user_id, null);
    assertEquals(h.billingEntitlements.size, 0);
  },
);

Deno.test(
  "HOLDS (I6b): anonymous app_user_id whose aliases contain a UUID → that UUID is verified",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    const res = await readJson(
      await h.handler(
        webhookRequest({
          id: "evt-anon-alias",
          type: "INITIAL_PURCHASE",
          app_user_id: "$RCAnonymousID:abc123",
          aliases: ["$RCAnonymousID:abc123", TEST_USER_ID],
        }),
      ),
    );
    assertEquals(res, { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(decodeURIComponent(h.callsTo(RC_URL)[0].url.slice(RC_URL.length)), TEST_USER_ID);
    assertEquals(h.billingEntitlements.get(TEST_USER_ID)?.premium, true);
  },
);

Deno.test(
  "HOLDS (I7): TRANSFER re-verifies both sides from RC (from → lapsed, to → active) and audits under the from-id",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = (appUserId) =>
      appUserId === OTHER_USER_ID ? activeSubscriber() : lapsedSubscriber();
    const res = await readJson(
      await h.handler(
        webhookRequest({
          id: "evt-transfer",
          type: "TRANSFER",
          app_user_id: undefined,
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        }),
      ),
    );
    assertEquals(res, { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 2);
    assertEquals(h.billingEntitlements.get(TEST_USER_ID)?.premium, false);
    assertEquals(h.billingEntitlements.get(OTHER_USER_ID)?.premium, true);
    assertEquals(h.webhookEvents.get("evt-transfer")?.app_user_id, TEST_USER_ID);
  },
);

Deno.test(
  "HOLDS (I8): missing event / non-object event / malformed JSON → 400 with no upstream calls",
  async () => {
    const h = await loadAuditHarness();
    for (const raw of ["{}", JSON.stringify({ event: "RENEWAL" }), "{not json", "[]", "null"]) {
      const res = await h.handler(webhookRequest(null, { rawBody: raw }));
      assertEquals(res.status, 400, raw);
      await res.body?.cancel();
    }
    assertEquals(h.calls.length, 0);
  },
);

Deno.test(
  "HOLDS: wrong / empty secret → 401 before the body is read, no upstream calls",
  async () => {
    const h = await loadAuditHarness();
    // (A trailing-space variant is NOT a valid probe: the Fetch Headers layer
    // strips leading/trailing whitespace from header values before the handler
    // ever sees them.)
    for (const secret of [
      "",
      "wf-audit-webhook-secre",
      "Wf-audit-webhook-secret",
      "wf-audit-webhook-secret1",
      "Bearer wf-audit-webhook-secret",
    ]) {
      const res = await h.handler(
        webhookRequest({ id: "evt-401", type: "RENEWAL", app_user_id: TEST_USER_ID }, { secret }),
      );
      assertEquals(res.status, 401, JSON.stringify(secret));
      await res.body?.cancel();
    }
    assertEquals(h.calls.length, 0);
  },
);

// ─── HOLDS: entitlement date semantics (index.ts:2170-2189) ─────────────────

Deno.test(
  "HOLDS: expiry semantics — null=lifetime, past=inactive, 1s future=active, non-string=inactive, unparsable=inactive",
  async () => {
    const h = await loadAuditHarness();
    const cases: Array<[unknown, boolean]> = [
      [null, true],
      [new Date(Date.now() - 1).toISOString(), false],
      [new Date(Date.now() + 1000).toISOString(), true],
      [Date.now() + 86_400_000, false],
      ["not-a-date", false],
      [undefined, false],
    ];
    for (const [i, [expires, expected]] of cases.entries()) {
      h.subscriber = {
        entitlements: { pickle_sensei_pro: { expires_date: expires, product_identifier: "p" } },
      };
      await (
        await h.handler(
          webhookRequest({ id: `evt-exp-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        )
      ).body?.cancel();
      const row = h.billingEntitlements.get(TEST_USER_ID);
      assertEquals(row?.premium, expected, `case ${i}: expires_date=${String(expires)}`);
      assertEquals(
        row?.expires_at,
        typeof expires === "string" && expected ? expires : null,
        `case ${i} expires_at`,
      );
    }
  },
);

Deno.test(
  "HOLDS: legacy 'premium' entitlement grants membership when 'pickle_sensei_pro' is lapsed; both active → pro's product/expiry displayed",
  async () => {
    const h = await loadAuditHarness();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();

    h.subscriber = {
      entitlements: {
        pickle_sensei_pro: { expires_date: past, product_identifier: "pro_monthly" },
        premium: { expires_date: later, product_identifier: "legacy_annual" },
      },
    };
    await (
      await h.handler(
        webhookRequest({ id: "evt-legacy", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      )
    ).body?.cancel();
    let row = h.billingEntitlements.get(TEST_USER_ID);
    assertEquals(row?.premium, true);
    assertEquals(row?.product_key, "legacy_annual");
    assertEquals(row?.expires_at, later);

    h.subscriber = {
      entitlements: {
        pickle_sensei_pro: { expires_date: soon, product_identifier: "pro_monthly" },
        premium: { expires_date: later, product_identifier: "legacy_annual" },
      },
    };
    await (
      await h.handler(
        webhookRequest({ id: "evt-both", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      )
    ).body?.cancel();
    row = h.billingEntitlements.get(TEST_USER_ID);
    assertEquals(row?.premium, true);
    assertEquals(row?.product_key, "pro_monthly");
    // Documented precedence: the FIRST active key (pickle_sensei_pro) carries
    // product/expiry even when the legacy entitlement lasts longer. The DB
    // predicate (expires_at > now()) therefore lapses at `soon`, earlier than
    // RC's truth, until the next sync/webhook re-verifies.
    assertEquals(row?.expires_at, soon);
  },
);

// ─── HOLDS: route matching (index.ts:2872 endsWith) ──────────────────────────

Deno.test(
  "HOLDS: any pathname ending in /webhooks/revenuecat is the webhook (pre-auth) but still secret-gated",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    const noSecret = await h.handler(
      webhookRequest(
        { id: "evt-shadow-401", type: "RENEWAL", app_user_id: TEST_USER_ID },
        {
          path: "/v1/me/webhooks/revenuecat",
          secret: "session-for-someone",
        },
      ),
    );
    assertEquals(noSecret.status, 401);
    await noSecret.body?.cancel();
    assertEquals(h.calls.length, 0);

    const withSecret = await readJson(
      await h.handler(
        webhookRequest(
          { id: "evt-shadow-200", type: "RENEWAL", app_user_id: TEST_USER_ID },
          {
            path: "/v1/me/webhooks/revenuecat",
          },
        ),
      ),
    );
    assertEquals(withSecret, { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
  },
);

// ─── HOLDS: FK 23503 (subject not in profiles) is a legitimate 200 ack ───────

Deno.test(
  "HOLDS: billing_entitlements FK violation (23503, user row gone) → 200 verified:false and the id is audited (RC must not retry)",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    h.intercept = (call, table) =>
      table === "billing_entitlements" && call.method === "POST"
        ? pgrst(
            409,
            "23503",
            'insert or update on table "billing_entitlements" violates foreign key constraint',
          )
        : undefined;
    const res = await readJson(
      await h.handler(webhookRequest({ id: "evt-fk", type: "RENEWAL", app_user_id: TEST_USER_ID })),
    );
    assertEquals(res, { received: true, verified: false });
    assertEquals(h.webhookEvents.has("evt-fk"), true);
    assertMatch(h.logs.join("\n"), /webhook verdict persist failed/);
  },
);

// ─── PROBE A: transient persist failure is acknowledged as success ──────────
// index.ts:2314-2324 — persistBillingVerdict() error (ANY error, including a
// PostgREST 5xx / connection failure) → verified=false, audit row written,
// 200 returned. RevenueCat treats 2xx as delivered and never retries; the id
// is now deduped, so the verdict is lost until the client happens to call
// /v1/billing/sync. Expected: a retryable 5xx and NO audit row (exactly what
// the RC-outage path already does), so the event is redelivered.

Deno.test(
  "PROBE A1: transient billing_entitlements 503 → retryable 5xx, no audit row, replay re-processes",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    let failWrites = true;
    h.intercept = (call, table) =>
      failWrites && table === "billing_entitlements" && call.method === "POST"
        ? pgrst(503, "PGRST001", "could not connect to database")
        : undefined;
    const event = { id: "evt-transient", type: "RENEWAL", app_user_id: TEST_USER_ID };

    const first = await h.handler(webhookRequest(event));
    const firstBody = await readJson(first);
    const observed = `status=${first.status} body=${JSON.stringify(firstBody)} auditRow=${h.webhookEvents.has("evt-transient")}`;
    assert(
      first.status >= 500,
      `expected retryable 5xx on transient persist failure; observed ${observed}`,
    );
    assertEquals(
      h.webhookEvents.has("evt-transient"),
      false,
      `audit row must not be written; observed ${observed}`,
    );

    failWrites = false;
    const replay = await readJson(await h.handler(webhookRequest(event)));
    assertEquals(replay, { received: true, verified: true });
    assertEquals(h.billingEntitlements.get(TEST_USER_ID)?.premium, true);
  },
);

Deno.test(
  "PROBE A2: after a transient persist failure the replayed id must not be swallowed as a duplicate",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    let failWrites = true;
    h.intercept = (call, table) =>
      failWrites && table === "billing_entitlements" && call.method === "POST"
        ? pgrst(503, "PGRST001", "could not connect to database")
        : undefined;
    const event = { id: "evt-transient-2", type: "CANCELLATION", app_user_id: TEST_USER_ID };
    await (await h.handler(webhookRequest(event))).body?.cancel();
    failWrites = false;
    const replay = await readJson(await h.handler(webhookRequest(event)));
    const observed = `replay=${JSON.stringify(replay)} rcCalls=${h.callsTo(RC_URL).length} entitlementRow=${JSON.stringify(h.billingEntitlements.get(TEST_USER_ID) ?? null)}`;
    assertNotEquals(replay.duplicate, true, `replay after failed persist was deduped: ${observed}`);
    assert(h.billingEntitlements.has(TEST_USER_ID), `entitlement never persisted: ${observed}`);
  },
);

Deno.test(
  "PROBE A3: TRANSFER with the second side failing transiently → retryable 5xx, no audit row",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = (id) => (id === OTHER_USER_ID ? activeSubscriber() : lapsedSubscriber());
    h.intercept = (call, table) =>
      table === "billing_entitlements" &&
      call.method === "POST" &&
      (call.body as Record<string, unknown>)?.user_id === OTHER_USER_ID
        ? pgrst(503, "PGRST001", "could not connect to database")
        : undefined;
    const res = await h.handler(
      webhookRequest({
        id: "evt-transfer-partial",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      }),
    );
    const body = await readJson(res);
    const observed = `status=${res.status} body=${JSON.stringify(body)} from=${JSON.stringify(h.billingEntitlements.get(TEST_USER_ID) ?? null)} to=${JSON.stringify(h.billingEntitlements.get(OTHER_USER_ID) ?? null)} auditRow=${h.webhookEvents.has("evt-transfer-partial")}`;
    assert(res.status >= 500, `partial TRANSFER persist acknowledged: ${observed}`);
    assertEquals(h.webhookEvents.has("evt-transfer-partial"), false, observed);
  },
);

// ─── PROBE B: concurrent identical deliveries all pass the check-then-act ───
// index.ts:2274-2279 selects webhook_events by id, then processes, then
// upserts the audit row at the very end. N copies in flight together all see
// "unseen" and each calls RevenueCat and upserts billing_entitlements.

Deno.test(
  "PROBE B: 20 concurrent deliveries of one event id → at most one RevenueCat verification",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    h.restLatencyMs = 5;
    const event = { id: "evt-concurrent", type: "RENEWAL", app_user_id: TEST_USER_ID };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => h.handler(webhookRequest(event, { ip: nextIp() }))),
    );
    const bodies = await Promise.all(responses.map(readJson));
    const processed = bodies.filter((b) => b.verified === true).length;
    const deduped = bodies.filter((b) => b.duplicate === true).length;
    const observed = `rcCalls=${h.callsTo(RC_URL).length} entitlementUpserts=${h.callsTo(ENT).filter((c) => c.method === "POST").length} processed=${processed} deduped=${deduped}`;
    assertEquals(h.callsTo(RC_URL).length, 1, `concurrent duplicates all verified: ${observed}`);
  },
);

// ─── PROBE C: RevenueCat auth/quota failures leave no server-side log ───────
// verifyRevenueCatSubscriber (index.ts:2148-2156) discards the non-OK status
// and returns null; the webhook answers a generic 503 (index.ts:2306). The
// repo contract (AGENTS.md "5xx bodies are generic (detail only in function
// logs)", http.ts access log ↔ `[api] <context>:` error line) requires an
// operator-visible line. A misconfigured/rotated REVENUECAT_SECRET_API_KEY
// (401) is therefore indistinguishable from an outage and silent.

Deno.test(
  "PROBE C: RevenueCat 401 (bad API key) → 503 must be accompanied by an [api] error log line naming RevenueCat/status",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = () =>
      new Response(JSON.stringify({ code: 7225, message: "Invalid API key." }), { status: 401 });
    const res = await h.handler(
      webhookRequest({ id: "evt-rc-401-log", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 503);
    await res.body?.cancel();
    const relevant = h.logs.filter((line) => /revenuecat|401|subscriber/i.test(line));
    assert(
      relevant.length > 0,
      `no diagnostic log for RevenueCat 401; captured logs: ${JSON.stringify(h.logs)}`,
    );
  },
);

// ─── PROBE D: event.id is not validated (index.ts:2243) ─────────────────────

Deno.test("PROBE D1: numeric event.id → dedupe impossible (each replay re-verifies)", async () => {
  const h = await loadAuditHarness();
  h.subscriber = activeSubscriber();
  const event = { id: 4242, type: "RENEWAL", app_user_id: TEST_USER_ID };
  await (await h.handler(webhookRequest(event))).body?.cancel();
  const replay = await readJson(await h.handler(webhookRequest(event)));
  const ids = [...h.webhookEvents.keys()];
  const observed = `replay=${JSON.stringify(replay)} rcCalls=${h.callsTo(RC_URL).length} auditIds=${JSON.stringify(ids)}`;
  assertEquals(replay.duplicate, true, `numeric id never deduplicates: ${observed}`);
});

Deno.test(
  "PROBE D2: empty-string event.id must not be accepted as a dedupe key (second distinct event with id '' silently dropped)",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    await (
      await h.handler(webhookRequest({ id: "", type: "RENEWAL", app_user_id: TEST_USER_ID }))
    ).body?.cancel();
    h.subscriber = lapsedSubscriber();
    const second = await readJson(
      await h.handler(webhookRequest({ id: "", type: "EXPIRATION", app_user_id: OTHER_USER_ID })),
    );
    const observed = `second=${JSON.stringify(second)} rcCalls=${h.callsTo(RC_URL).length} otherUserRow=${JSON.stringify(h.billingEntitlements.get(OTHER_USER_ID) ?? null)}`;
    assertNotEquals(
      second.duplicate,
      true,
      `distinct event with id '' dropped as duplicate: ${observed}`,
    );
    assert(h.billingEntitlements.has(OTHER_USER_ID), observed);
  },
);

// ─── HOLDS (documenting): DB-degradation branches are logged, not fatal ─────

Deno.test(
  "HOLDS: webhook_events lookup error → fail-open (processed, logged), audit upsert error → 200 verified:true (logged)",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    h.intercept = (call, table) =>
      table === "webhook_events" && call.method === "GET"
        ? pgrst(500, "XX000", "lookup exploded")
        : undefined;
    const a = await readJson(
      await h.handler(
        webhookRequest({ id: "evt-lookup-err", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      ),
    );
    assertEquals(a, { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertMatch(h.logs.join("\n"), /webhook event lookup failed/);

    h.reset();
    h.subscriber = activeSubscriber();
    h.intercept = (call, table) =>
      table === "webhook_events" && call.method === "POST"
        ? pgrst(500, "XX000", "audit exploded")
        : undefined;
    const b = await readJson(
      await h.handler(
        webhookRequest({ id: "evt-audit-err", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      ),
    );
    assertEquals(b, { received: true, verified: true });
    assertEquals(h.billingEntitlements.get(TEST_USER_ID)?.premium, true);
    assertEquals(h.webhookEvents.size, 0);
    assertMatch(h.logs.join("\n"), /webhook event log failed/);
  },
);

Deno.test(
  "HOLDS: string event.id is used verbatim as the audit key (no random id minted)",
  async () => {
    const h = await loadAuditHarness();
    h.subscriber = activeSubscriber();
    await (
      await h.handler(
        webhookRequest({ id: "evt-verbatim", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      )
    ).body?.cancel();
    assertEquals([...h.webhookEvents.keys()], ["evt-verbatim"]);
    for (const key of h.webhookEvents.keys()) assert(!UUID_RE.test(key));
  },
);
