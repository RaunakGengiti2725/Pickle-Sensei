// ADVERSARIAL TESTER #2 (pass 3) — edge-billing-webhook.
//
// Attacks the RevenueCat webhook + POST /v1/billing/sync through the REAL
// handler (routesHarness.ts: Supabase + RevenueCat stubbed at the fetch layer).
// Every test states the scenario, what was observed on 4d812e1a, and the
// verdict (HELD / BROKEN) in its name; assertions pin the OBSERVED behaviour
// so a change in either direction is visible. Nothing here weakens or
// replaces a committed test.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_billing_webhook_2.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  activeSubscriber,
  type Harness,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const ACCESS_ROW = [{ premium: false, scored_count: 0, reserved_count: 0 }];

type Row = Record<string, unknown>;

/** Collect every console.error line emitted while `fn` runs (restores after). */
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = original;
  }
}

/**
 * Replace the harness's RevenueCat answer for the duration of `fn`: every
 * GET /v1/subscribers/* gets `response()` instead of the harness's 200/500.
 * Everything else still flows through the harness stub (which keeps
 * recording calls), so h.callsTo(RC_URL) stays accurate.
 */
async function withRevenueCat<T>(
  h: Harness,
  response: () => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(RC_URL)) {
      // Record the call exactly like the harness does, then answer ourselves.
      const request = new Request(input, init);
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      h.calls.push({ url, method: request.method, headers, body: null });
      return response();
    }
    return harnessFetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

/**
 * A STATEFUL webhook_events table on top of the harness: POST upserts land in
 * h.tables.webhook_events and GET ?id=eq.X honours the id filter (the stock
 * harness returns rows[0] for ANY GET and never persists writes, which is why
 * the committed "REPRO (defect)" replay test sees three RevenueCat calls).
 */
async function withPersistentWebhookEvents<T>(h: Harness, fn: () => Promise<T>): Promise<T> {
  const harnessFetch = globalThis.fetch;
  const table = () => (h.tables["webhook_events"] ??= []);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/rest/v1/webhook_events") {
      if (request.method === "GET") {
        const filter = url.searchParams.get("id") ?? "";
        const wanted = filter.startsWith("eq.") ? filter.slice(3) : null;
        const rows = table().filter((r) => wanted === null || (r as Row).id === wanted);
        // Let the harness record the call; then answer with the filtered rows.
        await harnessFetch(request.clone());
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("vnd.pgrst.object+json")) {
          if (rows.length === 0) {
            return new Response(JSON.stringify({ code: "PGRST116", message: "0 rows" }), {
              status: 406,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(rows[0]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (request.method === "POST") {
        const body = (await request
          .clone()
          .json()
          .catch(() => null)) as Row | Row[] | null;
        const incoming = Array.isArray(body) ? body : body ? [body] : [];
        for (const row of incoming) {
          if (!table().some((r) => (r as Row).id === row.id)) table().push(row);
        }
        return harnessFetch(request);
      }
    }
    return harnessFetch(request);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

const entitlementRows = (h: Harness): Row[] =>
  h.callsTo("/rest/v1/billing_entitlements").map((c) => c.body as Row);

// ── S1 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "S1 HELD-with-caveat: expires_date 'Dec 31 2099 00:00:00 GMT' grants premium and is persisted VERBATIM (not normalised to ISO)",
  async () => {
    const h = await loadHarness();
    const legacy = "Dec 31 2099 00:00:00 GMT";
    h.subscriber = activeSubscriber(legacy, "pickle_sensei_pro_lifetime");
    const res = await h.handler(
      webhookRequest({ id: "evt-s1", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    const rows = entitlementRows(h);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].premium, true);
    // Persisted as the raw RevenueCat string — PostgREST/PG16 must parse it.
    // (PG16 acceptance is checked separately in attack_billing_webhook_2_pg.sql.)
    assertEquals(rows[0].expires_at, legacy);
    assert(Number.isFinite(Date.parse(legacy)), "V8 accepts the legacy format");
  },
);

Deno.test(
  "S1b BROKEN-ish: a V8-parseable expires_date PG cannot cast is persisted verbatim → billing sync = 503 for a PAYING user (persist error), webhook = 200 verified:false",
  async () => {
    // Battery of strings Date.parse() accepts (all future) that the server
    // forwards verbatim to a timestamptz column. Which of them PG16 accepts
    // is measured in attack_billing_webhook_2_pg.sql; here we pin that the
    // server does no normalisation and that a persist error on the sync path
    // surfaces as a 503 to a user RevenueCat says is premium.
    const h = await loadHarness();
    const weird = "Sun Dec 31 2099 00:00:00 GMT+0000 (Coordinated Universal Time)"; // Date#toString()
    assert(Number.isFinite(Date.parse(weird)));
    h.subscriber = activeSubscriber(weird);
    h.rpcs["access_state"] = ACCESS_ROW;

    // Simulate PostgREST refusing the cast (22007 invalid_datetime_format).
    const harnessFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.includes("/rest/v1/billing_entitlements") && request.method === "POST") {
        await harnessFetch(request.clone());
        return new Response(
          JSON.stringify({
            code: "22007",
            message: `invalid input syntax for type timestamp with time zone: "${weird}"`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return harnessFetch(request);
    }) as typeof fetch;
    try {
      const { result: sync, lines } = await captureErrors(() =>
        h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.201" })),
      );
      assertEquals(sync.status, 503, "paying user gets a 503 from sync");
      assertStringIncludes((await sync.json()).error.message, "Billing verification");
      assert(
        lines.some(
          (l) => l.includes("[api] Billing verification:") && l.includes("invalid input syntax"),
        ),
        "detail is logged server-side (message only — the SQLSTATE is dropped)",
      );
      assertEquals(entitlementRows(h)[0].expires_at, weird, "sent verbatim, unnormalised");

      h.calls = [];
      const hook = await h.handler(
        webhookRequest({ id: "evt-s1b", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(hook.status, 200);
      assertEquals(await hook.json(), { received: true, verified: false });
      // The audit row is still written → this event is deduped on replay even
      // though the verdict was never persisted.
      assertEquals(
        h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length,
        1,
      );
    } finally {
      globalThis.fetch = harnessFetch;
    }
  },
);

// ── S2 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "S2 HELD (by design, lockout risk): RC 200 {subscriber:{}} with NO entitlements key → premium:false persisted, webhook 200 verified:true, sync 200 premium:false",
  async () => {
    const h = await loadHarness();
    h.subscriber = {}; // entitlements key absent entirely
    h.rpcs["access_state"] = [{ premium: true, scored_count: 9, reserved_count: 0 }];
    const hook = await h.handler(
      webhookRequest({ id: "evt-s2", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(hook.status, 200);
    assertEquals(await hook.json(), { received: true, verified: true });
    let rows = entitlementRows(h);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].premium, false);
    assertEquals(rows[0].product_key, null);
    assertEquals(rows[0].expires_at, null);

    h.calls = [];
    const sync = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.202" }));
    assertEquals(sync.status, 200);
    const body = await sync.json();
    assertEquals(body.billing.premium, false);
    assertEquals(body.access.premium, false, "verdict overrides the DB premium:true");
    rows = entitlementRows(h);
    assertEquals(rows[0].premium, false, "the previously-premium row is overwritten to false");
    // Nothing distinguishes "RevenueCat schema changed" from "never purchased".
  },
);

// ── S3 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "S3 BROKEN (operability): RC 401 'Invalid API key' on every call → webhook 503 + sync 502 with NO log line naming the RevenueCat status",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = ACCESS_ROW;
    const accessLines: string[] = [];
    const restoreAccess = captureAccessLog((line) => accessLines.push(line));
    try {
      const { result, lines } = await captureErrors(() =>
        withRevenueCat(
          h,
          () =>
            new Response(JSON.stringify({ code: 7225, message: "Invalid API key." }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
          async () => {
            const hooks: Response[] = [];
            for (let i = 0; i < 3; i += 1) {
              hooks.push(
                await h.handler(
                  webhookRequest(
                    { id: `evt-s3-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID },
                    { ip: "203.0.113.31" },
                  ),
                ),
              );
            }
            const sync = await h.handler(
              userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.203" }),
            );
            return { hooks, sync };
          },
        ),
      );
      for (const hook of result.hooks) {
        assertEquals(hook.status, 503);
        assertEquals((await hook.json()).error.message, "Verification is temporarily unavailable.");
      }
      assertEquals(result.sync.status, 502);
      assertEquals((await result.sync.json()).error.code, "billing_unavailable");
      assertEquals(h.callsTo(RC_URL).length, 4);
      assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0, "nothing persisted");
      assertEquals(
        h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length,
        0,
        "no audit row → RevenueCat will retry forever",
      );
      // The defect: zero console.error lines mention RevenueCat or the 401.
      const rcLines = lines.filter((l) => /revenuecat|401|api key/i.test(l));
      assertEquals(
        rcLines,
        [],
        "OBSERVED on 4d812e1a: a misconfigured key is logged nowhere (indistinguishable from an outage)",
      );
      // Only the generic access-log line exists, carrying the status but no cause.
      assert(accessLines.some((l) => l.includes('"status":503')));
      assert(accessLines.some((l) => l.includes('"status":502')));
      // (the route name contains "revenuecat"; nothing carries the upstream 401)
      assert(!accessLines.some((l) => /"upstream|401|api key/i.test(l)));
    } finally {
      restoreAccess();
    }
  },
);

// ── S4 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "S4 HELD/P3: RC 429 Retry-After:30 → webhook 503 WITHOUT Retry-After, sync 502; upstream backoff hint is dropped",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = ACCESS_ROW;
    const { hook, sync } = await withRevenueCat(
      h,
      () =>
        new Response(JSON.stringify({ code: 7000, message: "Rate limit exceeded." }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        }),
      async () => ({
        hook: await h.handler(
          webhookRequest(
            { id: "evt-s4", type: "RENEWAL", app_user_id: TEST_USER_ID },
            { ip: "203.0.113.41" },
          ),
        ),
        sync: await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.204" })),
      }),
    );
    assertEquals(hook.status, 503);
    assertEquals(hook.headers.get("retry-after"), null, "OBSERVED: no Retry-After propagated");
    await hook.text();
    assertEquals(sync.status, 502);
    assertEquals(sync.headers.get("retry-after"), null);
    await sync.text();
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
  },
);

// ── S5 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "S5 HELD: pickle_sensei_pro.expires_date='2030-13-45T00:00:00Z' (unparseable) + premium.expires_date=null → premium granted from the LEGACY alias, product_key from 'premium'",
  async () => {
    const h = await loadHarness();
    assert(Number.isNaN(Date.parse("2030-13-45T00:00:00Z")), "V8 rejects month 13");
    h.subscriber = {
      entitlements: {
        pickle_sensei_pro: {
          expires_date: "2030-13-45T00:00:00Z",
          product_identifier: "pickle_sensei_pro_yearly",
        },
        premium: { expires_date: null, product_identifier: "legacy_premium_lifetime" },
      },
    };
    const res = await h.handler(
      webhookRequest({ id: "evt-s5", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    const row = entitlementRows(h)[0];
    assertEquals(row.premium, true);
    assertEquals(row.product_key, "legacy_premium_lifetime");
    assertEquals(row.expires_at, null, "lifetime via the alias");

    // Same subscriber through sync: activeEntitlements names ONLY the alias.
    h.calls = [];
    h.rpcs["access_state"] = ACCESS_ROW;
    const sync = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.205" }));
    assertEquals(sync.status, 200);
    const body = await sync.json();
    assertEquals(body.billing.premium, true);
    assertEquals(body.billing.productKey, "legacy_premium_lifetime");
    assertEquals(body.access.entitlements, ["premium"], "pickle_sensei_pro is NOT reported active");
  },
);

Deno.test(
  "S5b HELD: unparseable expires_date on the ONLY entitlement → premium:false persisted silently (a paying user is locked out if RevenueCat ever emits a non-ISO date)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber("2030-13-45T00:00:00Z");
    const res = await h.handler(
      webhookRequest({ id: "evt-s5b", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    assertEquals(entitlementRows(h)[0].premium, false);
  },
);

// ── S6 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "S6 HELD: seeded webhook_events row for 'evt-replay' → {received:true,duplicate:true}, 0 RevenueCat calls, 0 entitlement writes, no second audit row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.tables["webhook_events"] = [{ id: "evt-replay" }];
    const res = await h.handler(
      webhookRequest({ id: "evt-replay", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
    const lookups = h.callsTo("/rest/v1/webhook_events");
    assertEquals(lookups.length, 1);
    assertEquals(lookups[0].method, "GET");
    assert(lookups[0].url.includes("id=eq.evt-replay"));
  },
);

Deno.test(
  "S6b SPEC DECISION: with a webhook_events table that actually persists, the 'REPRO (defect)' sequence is 1 RC call + 1 entitlement write + 2 duplicate acks — the committed test pins a harness artifact, not production behaviour",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const event = { id: "evt-replay", type: "RENEWAL", app_user_id: TEST_USER_ID };
    const bodies = await withPersistentWebhookEvents(h, async () => {
      const out: unknown[] = [];
      for (let i = 0; i < 3; i += 1)
        out.push(await (await h.handler(webhookRequest(event))).json());
      return out;
    });
    assertEquals(bodies, [
      { received: true, verified: true },
      { received: true, duplicate: true },
      { received: true, duplicate: true },
    ]);
    assertEquals(
      h.callsTo(RC_URL).length,
      1,
      "index.ts dedupes by audit row (contradicts the committed REPRO test)",
    );
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 1);
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 1);
  },
);

Deno.test(
  "S6c HELD (fail-open): webhook_events lookup error → event is fully re-processed (RC called, verdict written), error logged",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const harnessFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.includes("/rest/v1/webhook_events") && request.method === "GET") {
        await harnessFetch(request.clone());
        return new Response(JSON.stringify({ code: "57014", message: "statement timeout" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return harnessFetch(request);
    }) as typeof fetch;
    try {
      const { result, lines } = await captureErrors(() =>
        h.handler(webhookRequest({ id: "evt-s6c", type: "RENEWAL", app_user_id: TEST_USER_ID })),
      );
      assertEquals(result.status, 200);
      assertEquals(await result.json(), { received: true, verified: true });
      assertEquals(h.callsTo(RC_URL).length, 1);
      assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 1);
      assert(lines.some((l) => l.includes("webhook event lookup failed")));
    } finally {
      globalThis.fetch = harnessFetch;
    }
  },
);

Deno.test(
  "S6d P3: two CONCURRENT deliveries of one event id both pass the seen-check → 2 RC calls, 2 entitlement writes (idempotent upsert, so harmless), 1 audit row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const event = { id: "evt-race", type: "RENEWAL", app_user_id: TEST_USER_ID };
    await withPersistentWebhookEvents(h, async () => {
      const [a, b] = await Promise.all([
        h.handler(webhookRequest(event)),
        h.handler(webhookRequest(event)),
      ]);
      assertEquals([a.status, b.status], [200, 200]);
      assertEquals(await a.json(), { received: true, verified: true });
      assertEquals(await b.json(), { received: true, verified: true });
    });
    assertEquals(h.callsTo(RC_URL).length, 2);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 2);
    assertEquals((h.tables["webhook_events"] ?? []).length, 1, "ignoreDuplicates keeps one row");
  },
);

Deno.test(
  "S6e P2: persist fails (user never bootstrapped → FK) but the audit row IS written → every replay of that event is deduped, so the webhook can never deliver this user's verdict",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const harnessFetch = globalThis.fetch;
    let failPersist = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        failPersist &&
        request.url.includes("/rest/v1/billing_entitlements") &&
        request.method === "POST"
      ) {
        await harnessFetch(request.clone());
        return new Response(
          JSON.stringify({
            code: "23503",
            message:
              'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return harnessFetch(request);
    }) as typeof fetch;
    try {
      await withPersistentWebhookEvents(h, async () => {
        const event = { id: "evt-orphan", type: "INITIAL_PURCHASE", app_user_id: OTHER_USER_ID };
        const first = await h.handler(webhookRequest(event));
        assertEquals(first.status, 200);
        assertEquals(await first.json(), { received: true, verified: false });
        assertEquals((h.tables["webhook_events"] ?? []).length, 1, "audit row written anyway");
        // The user bootstraps (profiles row now exists) and RevenueCat
        // redelivers / operator replays the SAME event id:
        failPersist = false;
        const replay = await h.handler(webhookRequest(event));
        assertEquals(await replay.json(), { received: true, duplicate: true });
      });
      assertEquals(h.callsTo(RC_URL).length, 1, "replay never re-verifies");
      assertEquals(
        h.callsTo("/rest/v1/billing_entitlements").length,
        1,
        "OBSERVED: the failed write is the only write; the verdict is never persisted by the webhook",
      );
    } finally {
      globalThis.fetch = harnessFetch;
    }
  },
);

// ── S7 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "S7 HELD-as-coded / P2 risk: 241 correctly-authenticated webhook events from ONE IP inside a minute → the 241st is 429 (RevenueCat's own egress is throttled)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const ip = "203.0.113.77";
    let last: Response | null = null;
    const statuses = new Map<number, number>();
    for (let i = 0; i < 241; i += 1) {
      last = await h.handler(
        webhookRequest(
          { id: `evt-burst-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID },
          { ip },
        ),
      );
      statuses.set(last.status, (statuses.get(last.status) ?? 0) + 1);
      await last.text();
    }
    assertEquals(statuses.get(200), 240);
    assertEquals(statuses.get(429), 1);
    assertEquals(last!.status, 429);
    assert(Number(last!.headers.get("retry-after")) > 0);
    assertEquals(last!.headers.get("ratelimit-limit"), "240");
    assertEquals(h.callsTo(RC_URL).length, 240, "the 241st never reached RevenueCat");
    // The 429'd event leaves no audit row: RevenueCat must redeliver it.
    assertEquals(
      h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length,
      240,
    );
  },
);

Deno.test(
  "S7b HELD: the webhook IP budget is separate from the general IP budget and from the secret check — 429 happens BEFORE the Authorization check (unauthenticated floods from one IP are also capped at 240)",
  async () => {
    const h = await loadHarness();
    const ip = "203.0.113.78";
    for (let i = 0; i < 240; i += 1) {
      const res = await h.handler(webhookRequest({ id: `x${i}` }, { ip, authorization: "wrong" }));
      assertEquals(res.status, 401);
      await res.text();
    }
    const legit = await h.handler(
      webhookRequest({ id: "evt-legit", type: "RENEWAL", app_user_id: TEST_USER_ID }, { ip }),
    );
    assertEquals(legit.status, 429, "a forger sharing the IP starves the real sender");
    await legit.text();
    assertEquals(h.calls.length, 0, "no DB or RC traffic from any of the 241 requests");
  },
);

// ── Extras ───────────────────────────────────────────────────────────────────

Deno.test(
  "X1 HELD: event id with U+0000 / 8 KB id / non-string id — handler never 500s; huge id goes into the PostgREST filter URL verbatim",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const nul = await h.handler(
      webhookRequest({ id: "evt-\u0000-nul", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(nul.status, 200);
    await nul.text();
    const audit = h.callsTo("/rest/v1/webhook_events").find((c) => c.method === "POST");
    assertEquals((audit!.body as Row).id, "evt-\u0000-nul", "NUL forwarded to PG jsonb/text");

    h.calls = [];
    const hugeId = "e".repeat(8_192);
    const huge = await h.handler(
      webhookRequest({ id: hugeId, type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(huge.status, 200);
    await huge.text();
    const lookup = h.callsTo("/rest/v1/webhook_events").find((c) => c.method === "GET");
    assert(lookup!.url.length > 8_192, "8 KB primary key travels in the query string");

    h.calls = [];
    const numeric = await h.handler(
      webhookRequest({ id: 12345, type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(numeric.status, 200);
    await numeric.text();
    const row = h.callsTo("/rest/v1/webhook_events").find((c) => c.method === "POST")!.body as Row;
    assert(/^[0-9a-f-]{36}$/.test(String(row.id)), "non-string id → random uuid → never dedupable");
  },
);

Deno.test(
  "X2 HELD: RC 200 with subscriber:null / non-JSON body / entitlement expires_date as a number → 503 (outage) or premium:false, never premium",
  async () => {
    const h = await loadHarness();
    const nullSub = await withRevenueCat(
      h,
      () =>
        new Response(JSON.stringify({ request_date_ms: 1, subscriber: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () =>
        h.handler(webhookRequest({ id: "evt-x2a", type: "RENEWAL", app_user_id: TEST_USER_ID })),
    );
    assertEquals(nullSub.status, 503);
    await nullSub.text();

    const html = await withRevenueCat(
      h,
      () => new Response("<html>gateway</html>", { status: 200 }),
      () =>
        h.handler(webhookRequest({ id: "evt-x2b", type: "RENEWAL", app_user_id: TEST_USER_ID })),
    );
    assertEquals(html.status, 503);
    await html.text();

    h.calls = [];
    h.subscriber = {
      entitlements: { pickle_sensei_pro: { expires_date: Date.now() + 86_400_000 } },
    };
    const numeric = await h.handler(
      webhookRequest({ id: "evt-x2c", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(numeric.status, 200);
    await numeric.text();
    assertEquals(entitlementRows(h)[0].premium, false);
  },
);

Deno.test(
  "X3 P3: interleaved sync + webhook for one user — last writer wins with NO verified_at ordering guard (an older RC read can overwrite a newer verdict)",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = ACCESS_ROW;
    // Webhook (RC says lapsed) starts first but RC answers slowly; sync (RC
    // now says active, purchase just completed) starts later and lands first.
    const harnessFetch = globalThis.fetch;
    let rcCall = 0;
    const order: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith(RC_URL)) {
        rcCall += 1;
        const mine = rcCall;
        await harnessFetch(request.clone());
        if (mine === 1) await new Promise((r) => setTimeout(r, 40)); // slow, stale answer
        const expires =
          mine === 1 ? new Date(Date.now() - 1000) : new Date(Date.now() + 86_400_000);
        return new Response(
          JSON.stringify({ subscriber: activeSubscriber(expires.toISOString()) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (request.url.includes("/rest/v1/billing_entitlements") && request.method === "POST") {
        const body = (await request.clone().json()) as Row;
        order.push(`premium=${body.premium}`);
      }
      return harnessFetch(request);
    }) as typeof fetch;
    try {
      const hookP = h.handler(
        webhookRequest({ id: "evt-x3", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const sync = await h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.230" }),
      );
      assertEquals(sync.status, 200);
      assertEquals((await sync.json()).billing.premium, true);
      const hook = await hookP;
      assertEquals(hook.status, 200);
      await hook.text();
      assertEquals(order, ["premium=true", "premium=false"], "the stale read is the final row");
    } finally {
      globalThis.fetch = harnessFetch;
    }
  },
);

Deno.test(
  "X4 HELD: TRANSFER with 3 subjects where RC fails on the 3rd → 503, but the first two verdicts were NOT written (all-or-nothing before persist)",
  async () => {
    const h = await loadHarness();
    const third = "33333333-3333-4333-8333-333333333333";
    const res = await withRevenueCat(
      h,
      () => new Response("upstream error", { status: 500 }),
      async () => {
        // First two RC answers come from the harness (200 active); make only
        // the third fail by swapping the responder after two calls.
        let n = 0;
        const inner = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.startsWith(RC_URL)) {
            n += 1;
            if (n < 3) {
              h.calls.push({ url, method: "GET", headers: {}, body: null });
              return new Response(JSON.stringify({ subscriber: activeSubscriber() }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
          }
          return inner(input, init);
        }) as typeof fetch;
        try {
          return await h.handler(
            webhookRequest({
              id: "evt-x4",
              type: "TRANSFER",
              transferred_from: [TEST_USER_ID, OTHER_USER_ID],
              transferred_to: [third],
            }),
          );
        } finally {
          globalThis.fetch = inner;
        }
      },
    );
    assertEquals(res.status, 503);
    await res.text();
    assertEquals(h.callsTo(RC_URL).length, 3);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);
  },
);

Deno.test(
  "X5 HELD: uppercase / mixed-case app_user_id passes isUuid and is forwarded to RevenueCat UNCHANGED (RC ids are case-sensitive → a different subscriber)",
  async () => {
    const h = await loadHarness();
    h.subscriber = { entitlements: {} };
    const upper = TEST_USER_ID.toUpperCase().replace(/1/g, "A");
    const res = await h.handler(
      webhookRequest({ id: "evt-x5", type: "RENEWAL", app_user_id: upper }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    assert(h.callsTo(RC_URL)[0].url.endsWith(encodeURIComponent(upper)));
    assertEquals(entitlementRows(h)[0].user_id, upper, "PG will lowercase the uuid on insert");
  },
);

Deno.test(
  "X6 HELD: body-level attacks — event:[] / event:'str' / invalid JSON / empty body → 400, no RC or DB traffic",
  async () => {
    const h = await loadHarness();
    for (const raw of ['{"event":[]}', '{"event":"x"}', "not json", "", "[]", "null"]) {
      const res = await h.handler(webhookRequest(null, { rawBody: raw }));
      assertEquals(res.status, 400, `raw=${JSON.stringify(raw)}`);
      await res.text();
    }
    assertEquals(h.calls.length, 0);
  },
);

Deno.test(
  "X7 HELD: Authorization with the secret as 'Bearer <secret>' is REJECTED (exact-match contract) and a unicode-confusable secret is rejected",
  async () => {
    const h = await loadHarness();
    const bearer = await h.handler(
      webhookRequest({ id: "e" }, { authorization: "Bearer wf-test-webhook-secret" }),
    );
    assertEquals(bearer.status, 401);
    await bearer.text();
    for (const bad of [
      "wf-test-webhook-secret\u00a0", // NBSP appended (latin-1, so Headers accepts it)
      // (a trailing ASCII space is stripped by Headers per the Fetch spec before
      // the server ever sees it — not a server property, so not asserted here)
      "WF-TEST-WEBHOOK-SECRET", // case
      "wf-test-webhook-secre", // one byte short
    ]) {
      const res = await h.handler(webhookRequest({ id: "e" }, { authorization: bad }));
      assertEquals(res.status, 401, JSON.stringify(bad));
      await res.text();
    }
    assertEquals(h.calls.length, 0);
  },
);
