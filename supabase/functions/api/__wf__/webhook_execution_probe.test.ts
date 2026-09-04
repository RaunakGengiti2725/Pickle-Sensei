// Execution probe (audit pass 2) for POST /webhooks/revenuecat — exercises the
// paths the shipped suite leaves dark: the webhook_events dedupe short-circuit,
// audit-lookup / persist / audit-write failures, missing env, malformed
// bodies, RevenueCat non-OK responses, alias fallback, TRANSFER atomicity,
// the per-IP webhook budget and concurrent same-id deliveries.
//
// Uses the real handler through routesHarness (fetch-layer stubs). Where the
// stateless harness cannot express a state (PostgREST errors, a seen audit
// row), a thin fetch interceptor wraps the harness fetch for one request.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json webhook_execution_probe.test.ts

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  activeSubscriber,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEBHOOK_EVENTS = `${SUPABASE_URL}/rest/v1/webhook_events`;
const BILLING = `${SUPABASE_URL}/rest/v1/billing_entitlements`;

type Override = (request: Request) => Response | null;

/** Run `fn` with `override` consulted AFTER the harness fetch (so the call is
 * still recorded) — a non-null Response replaces the stubbed one. */
async function withFetchOverride<T>(override: Override, fn: () => Promise<T>): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const probe = new Request(input, init);
    const forOverride = probe.clone();
    const stubbed = await inner(probe);
    const replaced = override(forOverride);
    return replaced ?? stubbed;
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = inner;
  }
}

/** Capture console.error lines emitted while `fn` runs. */
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

/** Pin the clock to the middle of a rate-limit minute: the limiter uses
 * clock-aligned fixed windows (rateLimit.ts windowKey), so a real minute
 * boundary crossed mid-loop would legitimately reset the count. */
async function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const frozen = Math.floor(realNow() / 60_000) * 60_000 + 30_000;
  Date.now = () => frozen;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

const pgError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.test(
  "probe: seen webhook_events row short-circuits — duplicate:true, no RC call, no writes",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.tables["webhook_events"] = [{ id: "evt-seen" }];
    const res = await h.handler(
      webhookRequest({ id: "evt-seen", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(RC_URL).length, 0, "no RevenueCat round trip on replay");
    assertEquals(h.callsTo(BILLING).length, 0, "no entitlement write on replay");
    const audit = h.callsTo(WEBHOOK_EVENTS);
    assertEquals(audit.length, 1);
    assertEquals(audit[0].method, "GET");
    assertStringIncludes(audit[0].url, `id=eq.${encodeURIComponent("evt-seen")}`);
  },
);

Deno.test(
  "probe: audit lookup failure fails OPEN — event is processed and the error is logged",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const { result: res, lines } = await captureErrors(() =>
      withFetchOverride(
        (req) =>
          req.method === "GET" && req.url.startsWith(WEBHOOK_EVENTS)
            ? pgError(500, "XX000", "lookup boom")
            : null,
        () =>
          h.handler(
            webhookRequest({ id: "evt-lookup-fail", type: "RENEWAL", app_user_id: TEST_USER_ID }),
          ),
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo(BILLING).length, 1);
    assert(
      lines.some((l) => l.includes("webhook event lookup failed")),
      lines.join("\n"),
    );
  },
);

Deno.test(
  "probe: persist failure is acknowledged 200 verified:false AND the audit row is still written",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const { result: res, lines } = await captureErrors(() =>
      withFetchOverride(
        (req) =>
          req.method === "POST" && req.url.startsWith(BILLING)
            ? pgError(503, "PGRST001", "transient upstream failure")
            : null,
        () =>
          h.handler(
            webhookRequest({
              id: "evt-persist-fail",
              type: "EXPIRATION",
              app_user_id: TEST_USER_ID,
            }),
          ),
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assert(
      lines.some((l) => l.includes("webhook verdict persist failed")),
      lines.join("\n"),
    );
    const auditWrite = h.callsTo(WEBHOOK_EVENTS).filter((c) => c.method === "POST");
    assertEquals(auditWrite.length, 1, "audit row written despite the verdict not landing");
    assertEquals((auditWrite[0].body as Record<string, unknown>).id, "evt-persist-fail");

    // Consequence: a redelivery of the same id is now treated as already
    // processed, so the un-persisted verdict is never retried by the webhook.
    h.calls = [];
    h.tables["webhook_events"] = [{ id: "evt-persist-fail" }];
    const replay = await h.handler(
      webhookRequest({ id: "evt-persist-fail", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
    );
    assertEquals(await replay.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(BILLING).length, 0);
  },
);

Deno.test(
  "probe (contrast): the SAME persist failure on POST /v1/billing/sync is a retryable 503, not a 200",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    const { result: res } = await captureErrors(() =>
      withFetchOverride(
        (req) =>
          req.method === "POST" && req.url.startsWith(BILLING)
            ? pgError(503, "PGRST001", "transient upstream failure")
            : null,
        () => h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.61" })),
      ),
    );
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(JSON.stringify(body).includes("transient upstream failure"), false, "generic 5xx");
  },
);

Deno.test(
  "probe: audit write failure does not fail the delivery (200, verified:true, error logged)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const { result: res, lines } = await captureErrors(() =>
      withFetchOverride(
        (req) =>
          req.method === "POST" && req.url.startsWith(WEBHOOK_EVENTS)
            ? pgError(500, "XX000", "audit boom")
            : null,
        () =>
          h.handler(
            webhookRequest({ id: "evt-audit-fail", type: "RENEWAL", app_user_id: TEST_USER_ID }),
          ),
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    assertEquals(h.callsTo(BILLING).length, 1);
    assert(
      lines.some((l) => l.includes("webhook event log failed")),
      lines.join("\n"),
    );
  },
);

Deno.test(
  "probe: missing REVENUECAT_WEBHOOK_AUTH fails closed with 503 and touches nothing",
  async () => {
    const h = await loadHarness();
    const saved = Deno.env.get("REVENUECAT_WEBHOOK_AUTH") ?? "";
    Deno.env.delete("REVENUECAT_WEBHOOK_AUTH");
    try {
      const res = await h.handler(
        webhookRequest({ id: "evt-nosecret", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 503);
      await res.text();
      assertEquals(h.calls.length, 0);
      // An empty Authorization header must not match an empty secret either.
      const empty = await h.handler(
        webhookRequest(
          { id: "evt-nosecret", type: "RENEWAL", app_user_id: TEST_USER_ID },
          { authorization: "" },
        ),
      );
      assertEquals(empty.status, 503);
      await empty.text();
    } finally {
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", saved);
    }
  },
);

Deno.test(
  "probe: no RevenueCat API key configured → 503, no RC call, no writes, no audit row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const savedSecret = Deno.env.get("REVENUECAT_SECRET_API_KEY");
    const savedPublic = Deno.env.get("REVENUECAT_PUBLIC_SDK_KEY");
    Deno.env.delete("REVENUECAT_SECRET_API_KEY");
    Deno.env.delete("REVENUECAT_PUBLIC_SDK_KEY");
    try {
      const { result: res, lines } = await captureErrors(() =>
        h.handler(webhookRequest({ id: "evt-nokey", type: "RENEWAL", app_user_id: TEST_USER_ID })),
      );
      assertEquals(res.status, 503);
      await res.text();
      assertEquals(h.callsTo(RC_URL).length, 0);
      assertEquals(h.callsTo(BILLING).length, 0);
      assertEquals(h.callsTo(WEBHOOK_EVENTS).filter((c) => c.method === "POST").length, 0);
      // Characterization: the misconfiguration is not logged (see findings).
      assertEquals(lines.length, 0);
    } finally {
      if (savedSecret !== undefined) Deno.env.set("REVENUECAT_SECRET_API_KEY", savedSecret);
      if (savedPublic !== undefined) Deno.env.set("REVENUECAT_PUBLIC_SDK_KEY", savedPublic);
    }
  },
);

Deno.test(
  "probe: REVENUECAT_PUBLIC_SDK_KEY fallback is used when the secret key is absent",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const savedSecret = Deno.env.get("REVENUECAT_SECRET_API_KEY");
    Deno.env.delete("REVENUECAT_SECRET_API_KEY");
    Deno.env.set("REVENUECAT_PUBLIC_SDK_KEY", "appl_public_fallback");
    try {
      const res = await h.handler(
        webhookRequest({ id: "evt-fallback", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 200);
      await res.json();
      assertEquals(h.callsTo(RC_URL)[0].headers["authorization"], "Bearer appl_public_fallback");
    } finally {
      if (savedSecret !== undefined) Deno.env.set("REVENUECAT_SECRET_API_KEY", savedSecret);
      Deno.env.delete("REVENUECAT_PUBLIC_SDK_KEY");
    }
  },
);

Deno.test(
  "probe: malformed / empty / non-object bodies are 400 without any downstream call",
  async () => {
    const h = await loadHarness();
    const cases = [
      { rawBody: "{not json" },
      { rawBody: "" },
      { rawBody: "[]" },
      { rawBody: '"string"' },
      { rawBody: '{"event":"not-an-object"}' },
      { rawBody: '{"event":null}' },
      { rawBody: '{"event":[1,2]}' },
    ];
    for (const c of cases) {
      const res = await h.handler(webhookRequest(null, c));
      assertEquals(res.status, 400, `body ${JSON.stringify(c.rawBody)}`);
      await res.text();
    }
    assertEquals(h.calls.length, 0);
  },
);

Deno.test(
  "probe: non-string event.id is replaced with a uuid audit id (no dedupe possible)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(webhookRequest({ id: 12345, type: 7, app_user_id: TEST_USER_ID }));
    assertEquals(res.status, 200);
    await res.json();
    const lookup = h.callsTo(WEBHOOK_EVENTS).find((c) => c.method === "GET");
    assert(lookup);
    const audit = h.callsTo(WEBHOOK_EVENTS).find((c) => c.method === "POST");
    assert(audit);
    const row = audit.body as Record<string, unknown>;
    assertMatch(String(row.id), UUID_RE);
    assertEquals(row.event_type, "unknown");
    assertEquals(row.provider, "revenuecat");
    assertEquals(row.app_user_id, TEST_USER_ID);
    assertEquals(
      audit.headers["prefer"]?.includes("resolution=ignore-duplicates"),
      true,
      audit.headers["prefer"],
    );
  },
);

Deno.test(
  "probe: RevenueCat non-OK statuses (401/404/429/500) all yield 503 with no persisted verdict",
  async () => {
    const h = await loadHarness();
    for (const status of [401, 404, 429, 500]) {
      h.reset();
      const { result: res, lines } = await captureErrors(() =>
        withFetchOverride(
          (req) => (req.url.startsWith(RC_URL) ? new Response("rc says no", { status }) : null),
          () =>
            h.handler(
              webhookRequest({
                id: `evt-rc-${status}`,
                type: "RENEWAL",
                app_user_id: TEST_USER_ID,
              }),
            ),
        ),
      );
      assertEquals(res.status, 503, `RC ${status}`);
      await res.text();
      assertEquals(h.callsTo(BILLING).length, 0);
      assertEquals(h.callsTo(WEBHOOK_EVENTS).filter((c) => c.method === "POST").length, 0);
      // Characterization: an RC 401 (bad API key) is indistinguishable from an
      // outage in the logs — nothing is logged (see findings).
      assertEquals(lines.length, 0, `RC ${status} logged: ${lines.join(" | ")}`);
    }
  },
);

Deno.test(
  "probe: RevenueCat network failure / timeout (fetch rejects) → 503, nothing persisted, nothing logged",
  async () => {
    const h = await loadHarness();
    const failures: Array<() => never> = [
      () => {
        throw new TypeError("error sending request: connection refused");
      },
      () => {
        throw new DOMException("The signal has been aborted", "TimeoutError");
      },
    ];
    for (const fail of failures) {
      h.reset();
      const { result: res, lines } = await captureErrors(() =>
        withFetchOverride(
          (req) => (req.url.startsWith(RC_URL) ? fail() : null),
          () =>
            h.handler(
              webhookRequest({ id: "evt-rc-throw", type: "RENEWAL", app_user_id: TEST_USER_ID }),
            ),
        ),
      );
      assertEquals(res.status, 503);
      await res.text();
      assertEquals(h.callsTo(BILLING).length, 0);
      assertEquals(h.callsTo(WEBHOOK_EVENTS).filter((c) => c.method === "POST").length, 0);
      assertEquals(lines.length, 0, lines.join(" | "));
    }
  },
);

Deno.test(
  "probe: RevenueCat 200 with unusable JSON → 503; malformed entitlement shapes → honest premium:false",
  async () => {
    const h = await loadHarness();
    // 200 but no subscriber object.
    let res = await withFetchOverride(
      (req) =>
        req.url.startsWith(RC_URL)
          ? new Response(JSON.stringify({ hello: "world" }), { status: 200 })
          : null,
      () =>
        h.handler(
          webhookRequest({ id: "evt-rc-shape", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        ),
    );
    assertEquals(res.status, 503);
    await res.text();
    // 200 but body not JSON.
    res = await withFetchOverride(
      (req) => (req.url.startsWith(RC_URL) ? new Response("<html>", { status: 200 }) : null),
      () =>
        h.handler(
          webhookRequest({ id: "evt-rc-html", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        ),
    );
    assertEquals(res.status, 503);
    await res.text();
    assertEquals(h.callsTo(BILLING).length, 0);

    // Malformed entitlement shapes never grant premium.
    h.reset();
    h.subscriber = {
      entitlements: {
        pickle_sensei_pro: { expires_date: "not-a-date" },
        premium: "yes",
      },
    };
    res = await h.handler(
      webhookRequest({ id: "evt-rc-garbage", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    const row = h.callsTo(BILLING)[0].body as Record<string, unknown>;
    assertEquals(row.premium, false);
    assertEquals(row.product_key, null);
    assertEquals(row.expires_at, null);

    // Missing entitlements map entirely.
    h.reset();
    h.subscriber = { original_app_user_id: TEST_USER_ID };
    res = await h.handler(
      webhookRequest({ id: "evt-rc-empty", type: "RENEWAL", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    await res.json();
    assertEquals((h.callsTo(BILLING)[0].body as Record<string, unknown>).premium, false);
  },
);

Deno.test(
  "probe: legacy 'premium' alias alone grants; lifetime (null expiry) grants; expired revokes",
  async () => {
    const h = await loadHarness();
    h.subscriber = {
      entitlements: {
        premium: { expires_date: null, product_identifier: "pickle_sensei_pro_lifetime" },
      },
    };
    let res = await h.handler(
      webhookRequest({ id: "evt-alias", type: "NON_RENEWING_PURCHASE", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    await res.json();
    let row = h.callsTo(BILLING)[0].body as Record<string, unknown>;
    assertEquals(row.premium, true);
    assertEquals(row.expires_at, null);
    assertEquals(row.product_key, "pickle_sensei_pro_lifetime");

    h.reset();
    h.subscriber = activeSubscriber(new Date(Date.now() - 1_000).toISOString());
    res = await h.handler(
      webhookRequest({ id: "evt-expired", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    await res.json();
    row = h.callsTo(BILLING)[0].body as Record<string, unknown>;
    assertEquals(row.premium, false);
    assertEquals(row.expires_at, null, "a lapsed row carries no expiry");
    assertEquals(row.user_id, TEST_USER_ID);
    assert(typeof row.verified_at === "string" && Number.isFinite(Date.parse(row.verified_at)));
  },
);

Deno.test(
  "probe: anonymous app_user_id falls back to the first uuid alias; uppercase uuid accepted",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    let res = await h.handler(
      webhookRequest({
        id: "evt-alias-fallback",
        type: "INITIAL_PURCHASE",
        app_user_id: "$RCAnonymousID:abc",
        aliases: ["$RCAnonymousID:abc", "not-a-uuid", OTHER_USER_ID, TEST_USER_ID],
      }),
    );
    assertEquals(res.status, 200);
    await res.json();
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(OTHER_USER_ID)), rc[0].url);
    assertEquals((h.callsTo(BILLING)[0].body as Record<string, unknown>).user_id, OTHER_USER_ID);

    h.reset();
    h.subscriber = activeSubscriber();
    const upper = TEST_USER_ID.toUpperCase();
    res = await h.handler(webhookRequest({ id: "evt-upper", type: "RENEWAL", app_user_id: upper }));
    assertEquals(res.status, 200);
    await res.json();
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals((h.callsTo(BILLING)[0].body as Record<string, unknown>).user_id, upper);
  },
);

Deno.test(
  "probe: TRANSFER with one side unverifiable is atomic — 503, zero persists, zero audit",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await withFetchOverride(
      (req) =>
        req.url.startsWith(RC_URL) && req.url.endsWith(encodeURIComponent(OTHER_USER_ID))
          ? new Response("boom", { status: 502 })
          : null,
      () =>
        h.handler(
          webhookRequest({
            id: "evt-transfer-partial",
            type: "TRANSFER",
            transferred_from: [TEST_USER_ID],
            transferred_to: [OTHER_USER_ID],
          }),
        ),
    );
    assertEquals(res.status, 503);
    await res.text();
    assertEquals(h.callsTo(RC_URL).length, 2);
    assertEquals(h.callsTo(BILLING).length, 0);
    assertEquals(h.callsTo(WEBHOOK_EVENTS).filter((c) => c.method === "POST").length, 0);

    // TRANSFER with the same uuid on both sides is verified once, not twice.
    h.reset();
    h.subscriber = activeSubscriber();
    const same = await h.handler(
      webhookRequest({
        id: "evt-transfer-same",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [TEST_USER_ID],
      }),
    );
    assertEquals(same.status, 200);
    await same.json();
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(h.callsTo(BILLING).length, 1);
  },
);

Deno.test(
  "probe: TRANSFER with only non-uuid ids is acknowledged verified:false with an audit row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({
        id: "evt-transfer-anon",
        type: "TRANSFER",
        transferred_from: ["$RCAnonymousID:a"],
        transferred_to: ["$RCAnonymousID:b"],
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo(BILLING).length, 0);
    const audit = h.callsTo(WEBHOOK_EVENTS).find((c) => c.method === "POST");
    assert(audit);
    assertEquals((audit.body as Record<string, unknown>).app_user_id, null);
  },
);

Deno.test(
  "probe: per-IP webhook budget — 240 accepted, 241st is 429 with Retry-After; other IPs unaffected",
  () =>
    withFrozenClock(async () => {
      const h = await loadHarness();
      h.subscriber = activeSubscriber();
      const ip = "198.51.100.77";
      let last: Response | null = null;
      for (let i = 0; i < 240; i++) {
        last = await h.handler(
          webhookRequest({ id: `evt-rl-${i}`, type: "TEST", app_user_id: TEST_USER_ID }, { ip }),
        );
        assertEquals(last.status, 200, `request ${i + 1}`);
        await last.text();
      }
      const limited = await h.handler(
        webhookRequest({ id: "evt-rl-241", type: "TEST", app_user_id: TEST_USER_ID }, { ip }),
      );
      assertEquals(limited.status, 429);
      assert(limited.headers.get("retry-after"), "Retry-After present");
      await limited.text();
      // The budget is enforced BEFORE the secret check: unauthenticated floods
      // from the same IP are also throttled.
      const unauth = await h.handler(
        webhookRequest({ id: "evt-rl-unauth", type: "TEST" }, { ip, authorization: "nope" }),
      );
      assertEquals(unauth.status, 429);
      await unauth.text();
      const other = await h.handler(
        webhookRequest(
          { id: "evt-rl-other", type: "TEST", app_user_id: TEST_USER_ID },
          { ip: "198.51.100.78" },
        ),
      );
      assertEquals(other.status, 200);
      await other.text();
    }),
);

Deno.test(
  "probe: unauthenticated floods count against the same budget (401s consume the 240)",
  () =>
    withFrozenClock(async () => {
      const h = await loadHarness();
      const ip = "198.51.100.90";
      for (let i = 0; i < 240; i++) {
        const res = await h.handler(
          webhookRequest({ id: `evt-x-${i}`, type: "TEST" }, { ip, authorization: "nope" }),
        );
        assertEquals(res.status, 401, `request ${i + 1}`);
        await res.text();
      }
      const res = await h.handler(
        webhookRequest({ id: "evt-x-241", type: "TEST" }, { ip, authorization: "nope" }),
      );
      assertEquals(res.status, 429);
      await res.text();
      assertEquals(h.calls.length, 0);
    }),
);

Deno.test(
  "probe: non-POST methods on /webhooks/revenuecat never reach the webhook handler",
  async () => {
    const h = await loadHarness();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await h.handler(
        new Request("http://edge.test/functions/v1/api/webhooks/revenuecat", {
          method,
          headers: { Authorization: "wf-test-webhook-secret", "x-forwarded-for": "203.0.113.99" },
        }),
      );
      assert(res.status >= 400 && res.status < 500, `${method} → ${res.status}`);
      await res.text();
    }
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo(BILLING).length, 0);
  },
);

Deno.test(
  "probe: declared Content-Length above the cap is refused before the body is read",
  async () => {
    const h = await loadHarness();
    const req = new Request("http://edge.test/functions/v1/api/webhooks/revenuecat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "6000000",
        Authorization: "wf-test-webhook-secret",
        "x-forwarded-for": "203.0.113.11",
      },
      body: JSON.stringify({ event: { id: "evt-cl", type: "TEST", app_user_id: TEST_USER_ID } }),
    });
    const kept = req.headers.get("content-length") === "6000000";
    const res = await h.handler(req);
    await res.text();
    if (kept) {
      assertEquals(res.status, 413);
      assertEquals(h.calls.length, 0);
    } else {
      // The runtime dropped the user-supplied header; the body is processed normally.
      assertEquals(res.status, 200);
    }
  },
);

Deno.test(
  "probe: concurrent deliveries of the same event id all succeed (race window characterized)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const event = { id: "evt-race", type: "RENEWAL", app_user_id: TEST_USER_ID };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => h.handler(webhookRequest(event))),
    );
    for (const res of responses) {
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: true });
    }
    // With no committed audit row yet, every concurrent copy re-verifies and
    // upserts the same verdict (idempotent) and every audit write is
    // ignore-duplicates — no error path is exercised.
    assertEquals(h.callsTo(RC_URL).length, 8);
    assertEquals(h.callsTo(BILLING).length, 8);
    const audits = h.callsTo(WEBHOOK_EVENTS).filter((c) => c.method === "POST");
    assertEquals(audits.length, 8);
    for (const a of audits)
      assertStringIncludes(a.headers["prefer"] ?? "", "resolution=ignore-duplicates");
  },
);

Deno.test(
  "probe: audit payload stores the full body and the service-role key is used for every write",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const event = {
      id: "evt-payload",
      type: "RENEWAL",
      app_user_id: TEST_USER_ID,
      entitlement_ids: ["pickle_sensei_pro"],
      price: 7.99,
    };
    const res = await h.handler(webhookRequest(event));
    assertEquals(res.status, 200);
    await res.json();
    const audit = h.callsTo(WEBHOOK_EVENTS).find((c) => c.method === "POST");
    assert(audit);
    const row = audit.body as Record<string, unknown>;
    assertEquals(row.payload, { api_version: "1.0", event });
    assertEquals(row.event_type, "RENEWAL");
    for (const call of [...h.callsTo(WEBHOOK_EVENTS), ...h.callsTo(BILLING)]) {
      assertEquals(call.headers["apikey"], "service-role-test-key", call.url);
      assertEquals(call.headers["authorization"], "Bearer service-role-test-key", call.url);
    }
    const upsert = h.callsTo(BILLING)[0];
    assertStringIncludes(upsert.url, "on_conflict=user_id");
    assertStringIncludes(upsert.headers["prefer"] ?? "", "resolution=merge-duplicates");
  },
);
