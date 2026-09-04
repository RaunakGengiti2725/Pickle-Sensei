// Regression pins for POST /webhooks/revenuecat + POST /v1/billing/sync +
// GET /v1/me/access: the secret gate, never-trust-the-body re-verification,
// idempotency/audit ordering, persistence error handling and access folding.
//
// Each test names the mutants in ./mutation/mutants.ts it kills (bracketed
// ids in the title). This file is part of the permanent suite on purpose:
// mutation/run_mutations.ts `--mode existing` only drops `*_attack.test.ts`
// scratch files, so these pins count towards the score the permanent suite
// earns — a mutant listed here that survives `--mode existing` is a
// regression in this file, not a gap in coverage.
//
// Exercised through the real Deno.serve handler (routesHarness) with fault
// injection layered on top (attackHarness) — no network, no Supabase project.
//
//   cd supabase/functions/api/__wf__ && deno task test          # whole suite
//   deno test -A --no-check --config deno.json webhook_billing_invariants.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadAttackHarness, pgError, withEnvUnset, type AttackHarness } from "./attackHarness.ts";
import {
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  WEBHOOK_SECRET,
  activeSubscriber,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const ENTITLEMENTS = "/rest/v1/billing_entitlements";
const AUDIT = "/rest/v1/webhook_events";

const auditWrites = (h: AttackHarness) => h.callsTo(AUDIT).filter((c) => c.method === "POST");
const auditReads = (h: AttackHarness) => h.callsTo(AUDIT).filter((c) => c.method === "GET");
const row = (h: AttackHarness, index = 0) =>
  h.callsTo(ENTITLEMENTS)[index].body as Record<string, unknown>;

/** A webhook_events table that remembers what the function wrote, so the
 * dedupe lookup sees prior deliveries the way PostgREST would. */
function statefulAuditTable(h: AttackHarness): void {
  h.tables["webhook_events"] = h.tables["webhook_events"] ?? [];
  h.override((request, recorded) => {
    if (!request.url.includes(AUDIT)) return null;
    const rows = h.tables["webhook_events"] as Array<Record<string, unknown>>;
    if (request.method === "POST") {
      const body = recorded.body;
      for (const item of Array.isArray(body) ? body : [body]) {
        const record = item as Record<string, unknown>;
        if (!rows.some((existing) => existing.id === record.id)) rows.push(record);
      }
      return new Response(null, { status: 201 });
    }
    if (request.method === "GET") {
      const wanted = new URL(request.url).searchParams.get("id")?.replace(/^eq\./, "");
      const hits = rows.filter((existing) => existing.id === wanted).map((r) => ({ id: r.id }));
      const single = (recorded.headers["accept"] ?? "").includes("vnd.pgrst.object+json");
      if (single && hits.length === 0) return pgError(406, "PGRST116", "Results contain 0 rows");
      return new Response(JSON.stringify(single ? hits[0] : hits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return null;
  });
}

// ── secret gate ──────────────────────────────────────────────────────────────

Deno.test(
  "webhook invariant[SEC-03,SEC-04,SEC-07]: near-miss secrets (prefix, suffix, case, Bearer, same-length) are 401 with zero downstream calls",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    const flipped = WEBHOOK_SECRET.slice(0, -1) + (WEBHOOK_SECRET.endsWith("t") ? "u" : "t");
    // (Leading/trailing whitespace is not a variant: the Fetch Headers
    // normaliser strips it before the request is built.)
    const variants: Array<string | null> = [
      `${WEBHOOK_SECRET}x`,
      `x${WEBHOOK_SECRET}`,
      `${WEBHOOK_SECRET}\t${WEBHOOK_SECRET}`,
      WEBHOOK_SECRET.toUpperCase(),
      `Bearer ${WEBHOOK_SECRET}`,
      `Basic ${WEBHOOK_SECRET}`,
      flipped,
      WEBHOOK_SECRET.slice(0, -1),
      "",
      null,
    ];
    assert(flipped !== WEBHOOK_SECRET && flipped.length === WEBHOOK_SECRET.length);
    for (const authorization of variants) {
      const res = await h.handler(
        webhookRequest(
          {
            id: `evt-secret-${variants.indexOf(authorization)}`,
            type: "RENEWAL",
            app_user_id: TEST_USER_ID,
          },
          { authorization },
        ),
      );
      assertEquals(res.status, 401, `Authorization=${JSON.stringify(authorization)}`);
      assertEquals(await res.json(), { error: { message: "Invalid webhook credentials." } });
      assertEquals(
        h.calls.length,
        0,
        `downstream call with Authorization=${JSON.stringify(authorization)}`,
      );
    }
    // Sanity: the exact secret still works, so the variants above failed on
    // the comparison and not on something else.
    const ok = await h.handler(
      webhookRequest({ id: "evt-secret-ok", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(ok.status, 200);
    assertEquals(h.callsTo(RC_URL).length, 1);
  },
);

Deno.test(
  "webhook invariant[SEC-02]: unset REVENUECAT_WEBHOOK_AUTH fails closed (503) even when Authorization is absent or empty",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    await withEnvUnset(["REVENUECAT_WEBHOOK_AUTH"], async () => {
      for (const authorization of [null, "", WEBHOOK_SECRET]) {
        const res = await h.handler(
          webhookRequest(
            { id: "evt-unset", type: "RENEWAL", app_user_id: TEST_USER_ID },
            { authorization },
          ),
        );
        assertEquals(res.status, 503, `Authorization=${JSON.stringify(authorization)}`);
        assertEquals(await res.json(), { error: { message: "Webhook is not configured." } });
      }
    });
    assertEquals(h.calls.length, 0);
  },
);

Deno.test(
  "webhook invariant[SEC-08]: webhook per-IP budget — the 241st delivery in a minute is 429 with Retry-After and is not verified",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    const ip = "198.51.100.77";
    let last: Response | null = null;
    for (let i = 0; i < 241; i += 1) {
      last = await h.handler(
        webhookRequest({ id: `evt-rl-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID }, { ip }),
      );
      if (i < 240) assertEquals(last.status, 200, `delivery ${i + 1}`);
      await last.text();
    }
    assertEquals(last!.status, 429);
    assert(Number(last!.headers.get("retry-after")) > 0);
    assertEquals(h.callsTo(RC_URL).length, 240);
    // A different source address is unaffected.
    const other = await h.handler(
      webhookRequest(
        { id: "evt-rl-other", type: "RENEWAL", app_user_id: TEST_USER_ID },
        {
          ip: "198.51.100.78",
        },
      ),
    );
    assertEquals(other.status, 200);
  },
);

// ── idempotency / audit ordering ─────────────────────────────────────────────

Deno.test(
  "webhook invariant[DUP-01]: an event id already in webhook_events is acknowledged as duplicate — no RevenueCat call, no entitlement write, no second audit row",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    h.tables["webhook_events"] = [{ id: "evt-seen" }];
    const res = await h.handler(
      webhookRequest({
        id: "evt-seen",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
        entitlement_ids: ["pickle_sensei_pro"],
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, duplicate: true });
    assertEquals(auditReads(h).length, 1);
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 0);
    assertEquals(auditWrites(h).length, 0);
  },
);

Deno.test(
  "webhook invariant[DUP-01,DUP-05,DUP-14]: replaying a completed delivery is idempotent end to end — one verification and one entitlement write for N deliveries, distinct ids still processed",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    statefulAuditTable(h);
    const event = { id: "evt-e2e", type: "RENEWAL", app_user_id: TEST_USER_ID };
    const bodies: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await h.handler(webhookRequest(event));
      assertEquals(res.status, 200);
      bodies.push(await res.json());
    }
    assertEquals(bodies, [
      { received: true, verified: true },
      { received: true, duplicate: true },
      { received: true, duplicate: true },
    ]);
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 1);
    assertEquals(auditWrites(h).length, 1);
    assertEquals((auditWrites(h)[0].body as Record<string, unknown>).id, "evt-e2e");

    const fresh = await h.handler(webhookRequest({ ...event, id: "evt-e2e-2" }));
    assertEquals(await fresh.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 2);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 2);
    assertEquals(auditWrites(h).length, 2);
    h.override(null);
  },
);

Deno.test(
  "webhook invariant[DUP-03]: a failed webhook_events lookup does not short-circuit — the event is still verified, persisted and audited",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    h.override((request) =>
      request.method === "GET" && request.url.includes(AUDIT)
        ? pgError(500, "XX000", "lookup exploded")
        : null,
    );
    const res = await h.handler(
      webhookRequest({ id: "evt-lookup-fail", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 1);
    assertEquals(row(h).premium, true);
    assertEquals(auditWrites(h).length, 1);
    h.override(null);
  },
);

Deno.test(
  "webhook invariant[DUP-04]: a 503'd delivery (RevenueCat down) leaves NO audit row, so RevenueCat's retry is fully processed instead of deduped",
  async () => {
    const h = await loadAttackHarness();
    statefulAuditTable(h);
    const event = { id: "evt-retry", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID };

    h.subscriber = null;
    const down = await h.handler(webhookRequest(event));
    assertEquals(down.status, 503);
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 0);
    assertEquals(auditWrites(h).length, 0, "audit row must not be written before verification");
    assertEquals(h.tables["webhook_events"], []);

    h.subscriber = activeSubscriber();
    const retry = await h.handler(webhookRequest(event));
    assertEquals(retry.status, 200);
    assertEquals(await retry.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 2);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 1);
    assertEquals(row(h).premium, true);
    assertEquals(auditWrites(h).length, 1);
    h.override(null);
  },
);

Deno.test(
  "webhook invariant[DUP-08,DUP-09]: an entitlement write failure is reported as verified:false, the other TRANSFER side is still written, and the audit row is still logged",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    h.override((request, recorded) => {
      if (request.method !== "POST" || !request.url.includes(ENTITLEMENTS)) return null;
      const body = recorded.body as Record<string, unknown>;
      return body.user_id === TEST_USER_ID
        ? pgError(
            409,
            "23503",
            'insert or update on table "billing_entitlements" violates foreign key',
          )
        : null;
    });
    const res = await h.handler(
      webhookRequest({
        id: "evt-transfer-partial",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo(RC_URL).length, 2);
    const writes = h.callsTo(ENTITLEMENTS);
    assertEquals(writes.length, 2, "both sides attempted");
    assertEquals(
      writes.map((w) => (w.body as Record<string, unknown>).user_id).sort(),
      [TEST_USER_ID, OTHER_USER_ID].sort(),
    );
    assertEquals(auditWrites(h).length, 1);
    h.override(null);
  },
);

Deno.test(
  "webhook invariant[DUP-10]: the entitlement row is an upsert keyed on user_id with merge-duplicates (a second sync must never be a PK violation)",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({ id: "evt-upsert", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    const write = h.callsTo(ENTITLEMENTS)[0];
    assertEquals(write.method, "POST");
    assertEquals(new URL(write.url).searchParams.get("on_conflict"), "user_id");
    assertStringIncludes(write.headers["prefer"] ?? "", "resolution=merge-duplicates");
    assertEquals(write.headers["apikey"], "service-role-test-key");
    assertEquals(row(h).user_id, TEST_USER_ID);
  },
);

Deno.test(
  "webhook invariant[DUP-13]: an anonymous-only event (nothing to verify) still leaves an audit row with app_user_id null",
  async () => {
    const h = await loadAttackHarness();
    const res = await h.handler(
      webhookRequest({ id: "evt-anon-audit", type: "TEST", app_user_id: "$RCAnonymousID:abc" }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 0);
    const audit = auditWrites(h);
    assertEquals(audit.length, 1);
    const logged = audit[0].body as Record<string, unknown>;
    assertEquals(logged.id, "evt-anon-audit");
    assertEquals(logged.app_user_id, null);
    assertEquals(logged.event_type, "TEST");
  },
);

// ── body claims never reach the row ──────────────────────────────────────────

Deno.test(
  "webhook invariant[BODY-03,BODY-04]: expiration_at_ms / product_id from the body never reach expires_at / product_key — RevenueCat's values do",
  async () => {
    const h = await loadAttackHarness();
    const rcExpires = new Date(Date.now() + 86_400_000).toISOString();
    h.subscriber = activeSubscriber(rcExpires, "pickle_sensei_pro_monthly");
    const forged = {
      id: "evt-forged-fields",
      type: "INITIAL_PURCHASE",
      app_user_id: TEST_USER_ID,
      entitlement_ids: ["pickle_sensei_pro"],
      product_id: "pickle_sensei_pro_lifetime",
      expiration_at_ms: Date.now() + 10 * 365 * 86_400_000,
      period_type: "NORMAL",
      store: "APP_STORE",
    };
    const active = await h.handler(webhookRequest(forged));
    assertEquals(active.status, 200);
    assertEquals(row(h, 0).premium, true);
    assertEquals(row(h, 0).expires_at, rcExpires);
    assertEquals(row(h, 0).product_key, "pickle_sensei_pro_monthly");

    const lapsed = new Date(Date.now() - 3_600_000).toISOString();
    h.subscriber = activeSubscriber(lapsed, "pickle_sensei_pro_monthly");
    const revoked = await h.handler(webhookRequest({ ...forged, id: "evt-forged-fields-2" }));
    assertEquals(revoked.status, 200);
    assertEquals(row(h, 1).premium, false);
    assertEquals(row(h, 1).expires_at, null);
    assertEquals(row(h, 1).product_key, null);
    assertEquals(h.callsTo(RC_URL).length, 2);
  },
);

Deno.test(
  "webhook invariant[BODY-05]: EXPIRATION / CANCELLATION / BILLING_ISSUE event types are re-verified too — RevenueCat's active state wins over the event type",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    const types = [
      "EXPIRATION",
      "CANCELLATION",
      "BILLING_ISSUE",
      "UNCANCELLATION",
      "PRODUCT_CHANGE",
    ];
    for (const [i, type] of types.entries()) {
      const res = await h.handler(
        webhookRequest({ id: `evt-type-${type}`, type, app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 200, type);
      assertEquals(
        row(h, i).premium,
        true,
        `${type} must not revoke a RevenueCat-active membership`,
      );
    }
    assertEquals(h.callsTo(RC_URL).length, types.length);

    h.subscriber = activeSubscriber(new Date(Date.now() - 1000).toISOString());
    const purchase = await h.handler(
      webhookRequest({
        id: "evt-type-purchase-lapsed",
        type: "INITIAL_PURCHASE",
        app_user_id: TEST_USER_ID,
        entitlement_ids: ["pickle_sensei_pro"],
      }),
    );
    assertEquals(purchase.status, 200);
    assertEquals(row(h, types.length).premium, false, "INITIAL_PURCHASE type must not grant");
  },
);

Deno.test(
  "webhook invariant[BODY-07,BODY-08]: only pickle_sensei_pro / premium grant; an undefined expires_date or a malformed entitlements map never grants",
  async () => {
    const h = await loadAttackHarness();
    const cases: Array<{
      name: string;
      subscriber: Record<string, unknown>;
      premium: boolean;
      product: string | null;
    }> = [
      {
        name: "unknown entitlement key with lifetime expiry",
        subscriber: {
          entitlements: { some_other_app_pro: { expires_date: null, product_identifier: "other" } },
        },
        premium: false,
        product: null,
      },
      {
        name: "pickle_sensei_pro without expires_date",
        subscriber: {
          entitlements: { pickle_sensei_pro: { product_identifier: "pickle_sensei_pro_monthly" } },
        },
        premium: false,
        product: null,
      },
      {
        name: "expires_date is a number",
        subscriber: {
          entitlements: {
            pickle_sensei_pro: { expires_date: Date.now() + 86_400_000, product_identifier: "x" },
          },
        },
        premium: false,
        product: null,
      },
      {
        name: "expires_date is garbage",
        subscriber: {
          entitlements: { pickle_sensei_pro: { expires_date: "soon", product_identifier: "x" } },
        },
        premium: false,
        product: null,
      },
      {
        name: "entitlements is not an object",
        subscriber: { entitlements: ["pickle_sensei_pro"] },
        premium: false,
        product: null,
      },
      {
        name: "entitlement value is not an object",
        subscriber: { entitlements: { pickle_sensei_pro: "active" } },
        premium: false,
        product: null,
      },
      {
        name: "legacy premium key with lifetime expiry",
        subscriber: {
          entitlements: {
            premium: { expires_date: null, product_identifier: "pickle_sensei_pro_lifetime" },
          },
        },
        premium: true,
        product: "pickle_sensei_pro_lifetime",
      },
    ];
    for (const [i, c] of cases.entries()) {
      h.subscriber = c.subscriber;
      const res = await h.handler(
        webhookRequest({ id: `evt-keys-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 200, c.name);
      assertEquals(row(h, i).premium, c.premium, c.name);
      assertEquals(row(h, i).product_key, c.product, c.name);
    }
  },
);

Deno.test(
  "webhook invariant[BODY-12]: a 2xx RevenueCat response without a subscriber object is 'unavailable' — 503, nothing persisted, no audit row",
  async () => {
    const h = await loadAttackHarness();
    const shapes: Array<[string, Response]> = [
      [
        "empty object",
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      ],
      [
        "non-JSON",
        new Response("<html>maintenance</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ],
      [
        "subscriber is a string",
        new Response(JSON.stringify({ subscriber: "active" }), { status: 201 }),
      ],
      ["subscriber is null", new Response(JSON.stringify({ subscriber: null }), { status: 200 })],
    ];
    for (const [name, response] of shapes) {
      h.override((request) => (request.url.startsWith(RC_URL) ? response : null));
      const res = await h.handler(
        webhookRequest({ id: `evt-rc-shape-${name}`, type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 503, name);
      assertEquals(await res.json(), {
        error: { message: "Verification is temporarily unavailable." },
      });
    }
    assertEquals(h.callsTo(RC_URL).length, shapes.length);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 0);
    assertEquals(auditWrites(h).length, 0);
    h.override(null);
  },
);

Deno.test(
  "webhook invariant[BODY-14]: when app_user_id is the canonical uuid, alias uuids in the body do not select extra accounts to write",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({
        id: "evt-alias-extra",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
        aliases: [OTHER_USER_ID, "$RCAnonymousID:zzz"],
      }),
    );
    assertEquals(res.status, 200);
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(TEST_USER_ID)));
    assertEquals(h.callsTo(ENTITLEMENTS).length, 1);
    assertEquals(row(h).user_id, TEST_USER_ID);
  },
);

// ── POST /v1/billing/sync ────────────────────────────────────────────────────

Deno.test(
  "webhook invariant[SYNC-02]: a failed entitlement write on sync is a generic 503 — the verdict is not returned as if persisted",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    h.override((request) =>
      request.method === "POST" && request.url.includes(ENTITLEMENTS)
        ? pgError(500, "XX000", 'relation "billing_entitlements" does not exist')
        : null,
    );
    const res = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.90" }));
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.billing, undefined);
    assertEquals(body.access, undefined);
    assertEquals(
      body.error.message,
      "Billing verification is temporarily unavailable. Please try again.",
    );
    assert(!JSON.stringify(body).includes("relation"), "raw DB detail must not leak");
    assertEquals(h.callsTo(RC_URL).length, 1);
    h.override(null);
  },
);

Deno.test(
  "webhook invariant[SYNC-05]: sync without any RevenueCat API key is 503 billing_unconfigured and never calls RevenueCat",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    await withEnvUnset(["REVENUECAT_SECRET_API_KEY", "REVENUECAT_PUBLIC_SDK_KEY"], async () => {
      const res = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.91" }));
      assertEquals(res.status, 503);
      assertEquals((await res.json()).error.code, "billing_unconfigured");
    });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 0);
  },
);

// ── GET /v1/me/access ────────────────────────────────────────────────────────

Deno.test(
  "webhook invariant[ACC-02,ACC-03]: GET /v1/me/access honours the verified billing_entitlements row — premium unlocks rating past the free limit; non-premium exposes no entitlements",
  async () => {
    const h = await loadAttackHarness();
    h.rpcs["access_state"] = [{ premium: true, scored_count: 2, reserved_count: 0 }];
    const paid = await h.handler(userRequest("GET", "/v1/me/access", { ip: "198.51.100.92" }));
    assertEquals(paid.status, 200);
    const paidBody = await paid.json();
    assertEquals(paidBody.premium, true);
    assertEquals(paidBody.entitlements, ["premium"]);
    assertEquals(paidBody.canStartRating, true);
    assertEquals(paidBody.paywallRequired, false);
    assertEquals(paidBody.freeRatings.availableToReserve, 0);

    h.rpcs["access_state"] = [{ premium: false, scored_count: 2, reserved_count: 0 }];
    const free = await h.handler(userRequest("GET", "/v1/me/access", { ip: "198.51.100.92" }));
    assertEquals(free.status, 200);
    const freeBody = await free.json();
    assertEquals(freeBody.premium, false);
    assertEquals(freeBody.entitlements, []);
    assertEquals(freeBody.canStartRating, false);
    assertEquals(freeBody.paywallRequired, true);
    assertEquals(h.callsTo(RC_URL).length, 0, "access reads never call RevenueCat");
  },
);
