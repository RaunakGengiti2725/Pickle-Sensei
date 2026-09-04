// Structural audit probes for POST /webhooks/revenuecat (edge-billing-webhook,
// structural auditor #2). Every test here encodes the behaviour the code SHOULD
// have; a failing test is a reproduced finding, a passing test is a verified
// invariant. Nothing in this file modifies production code or existing tests.
//
// The shared routesHarness never persists PostgREST writes, so the replay /
// idempotency paths (index.ts handleRevenueCatWebhook: seen-lookup → RC →
// upsert → audit) cannot be observed with it. `withStatefulRest` layers an
// in-memory webhook_events table (GET by id, POST with ignore-duplicates) and
// configurable PostgREST / RevenueCat failures on top of the harness fetch.
//
// Run: deno test -A --no-check --config deno.json webhook_structural2.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  activeSubscriber,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
  WEBHOOK_SECRET,
  webhookRequest,
} from "./routesHarness.ts";

type Json = Record<string, unknown>;

interface StatefulOptions {
  /** HTTP status returned for EVERY billing_entitlements upsert (default 201). */
  billingUpsertStatus?: number | ((row: Json) => number);
  /** Delay (ms) applied to billing_entitlements upserts, per row. */
  billingUpsertDelayMs?: (row: Json) => number;
  /** HTTP status returned for every webhook_events request (default: stateful 200/201). */
  webhookEventsStatus?: number;
  /** Retry-After header on failed webhook_events responses (postgrest-js honours it;
   * omit to observe its built-in 1s/2s/4s backoff). */
  webhookEventsRetryAfter?: string;
  /** RevenueCat HTTP status override (default: harness behaviour). */
  rcStatus?: number | ((url: string, nth: number) => number);
  /** Delay (ms) applied to the nth RevenueCat call (0-based). */
  rcDelayMs?: (nth: number) => number;
  /** Subscriber returned for the nth RevenueCat call (default: harness subscriber). */
  rcSubscriber?: (nth: number) => Json | null;
}

interface StatefulState {
  webhookEvents: Map<string, Json>;
  billingRows: Map<string, Json>;
  billingWriteOrder: Json[];
  rcCalls: number;
}

const restJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wrap the harness fetch with a stateful PostgREST + RevenueCat fake. Restores
 * the harness fetch when the returned disposer is called. */
function withStatefulRest(options: StatefulOptions = {}): {
  state: StatefulState;
  restore: () => void;
} {
  const inner = globalThis.fetch;
  const state: StatefulState = {
    webhookEvents: new Map(),
    billingRows: new Map(),
    billingWriteOrder: [],
    rcCalls: 0,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;

    if (url.startsWith(RC_URL)) {
      const nth = state.rcCalls;
      state.rcCalls += 1;
      const delay = options.rcDelayMs?.(nth) ?? 0;
      if (delay > 0) await sleep(delay);
      const status =
        typeof options.rcStatus === "function"
          ? options.rcStatus(url, nth)
          : (options.rcStatus ?? 200);
      if (options.rcSubscriber || status !== 200) {
        // Record like the harness does, then answer ourselves.
        await inner(request.clone()).then((r) => r.body?.cancel());
        if (status !== 200) return new Response("rc error", { status });
        const subscriber = options.rcSubscriber!(nth);
        if (!subscriber) {
          return new Response("upstream error", { status: 500 });
        }
        return restJson(200, { request_date_ms: Date.now(), subscriber });
      }
      return inner(request);
    }

    if (url.startsWith(`${SUPABASE_URL}/rest/v1/webhook_events`)) {
      // Let the harness record the call, discard its default answer.
      await inner(request.clone()).then((r) => r.body?.cancel());
      if (options.webhookEventsStatus && options.webhookEventsStatus >= 400) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (options.webhookEventsRetryAfter !== undefined) {
          headers["Retry-After"] = options.webhookEventsRetryAfter;
        }
        return new Response(JSON.stringify({ message: "postgrest unavailable" }), {
          status: options.webhookEventsStatus,
          headers,
        });
      }
      const parsed = new URL(url);
      if (request.method === "GET") {
        const idFilter = parsed.searchParams.get("id") ?? "";
        const id = idFilter.startsWith("eq.") ? idFilter.slice(3) : null;
        const rows = id && state.webhookEvents.has(id) ? [state.webhookEvents.get(id)!] : [];
        const wantsObject = (request.headers.get("accept") ?? "").includes("pgrst.object");
        if (wantsObject) {
          if (rows.length === 0) {
            return restJson(406, {
              code: "PGRST116",
              message: "0 rows",
              details: null,
              hint: null,
            });
          }
          return restJson(200, rows[0]);
        }
        return restJson(200, rows);
      }
      if (request.method === "POST") {
        const body = JSON.parse(await request.text()) as Json | Json[];
        for (const row of Array.isArray(body) ? body : [body]) {
          const id = String(row.id);
          if (!state.webhookEvents.has(id)) state.webhookEvents.set(id, row);
        }
        return new Response(null, { status: 201 });
      }
    }

    if (url.startsWith(`${SUPABASE_URL}/rest/v1/billing_entitlements`)) {
      await inner(request.clone()).then((r) => r.body?.cancel());
      const body = JSON.parse(await request.text()) as Json;
      const delay = options.billingUpsertDelayMs?.(body) ?? 0;
      if (delay > 0) await sleep(delay);
      const status =
        typeof options.billingUpsertStatus === "function"
          ? options.billingUpsertStatus(body)
          : (options.billingUpsertStatus ?? 201);
      if (status >= 400) {
        return restJson(status, { message: "postgrest unavailable" });
      }
      state.billingRows.set(String(body.user_id), body);
      state.billingWriteOrder.push(body);
      return new Response(null, { status });
    }

    return inner(request);
  }) as typeof fetch;
  return { state, restore: () => (globalThis.fetch = inner) };
}

/** Capture console.error / console.warn lines emitted while `fn` runs. */
async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
  return lines;
}

const renewal = (id: string, appUserId = TEST_USER_ID): Json => ({
  id,
  type: "RENEWAL",
  app_user_id: appUserId,
});

// ── I13: replay dedupe (claimed by index.ts:2270-2279, no committed test) ────

Deno.test(
  "structural2: an already-audited event id is acknowledged {duplicate:true} with no RevenueCat call and no write",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest();
    try {
      const first = await h.handler(webhookRequest(renewal("s2-replay")));
      assertEquals(first.status, 200);
      assertEquals(await first.json(), { received: true, verified: true });
      assertEquals(h.callsTo(RC_URL).length, 1);
      assertEquals(fake.state.webhookEvents.has("s2-replay"), true);

      const replay = await h.handler(webhookRequest(renewal("s2-replay")));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(h.callsTo(RC_URL).length, 1, "replay must not re-verify");
      assertEquals(
        h.callsTo("/rest/v1/billing_entitlements").length,
        1,
        "replay must not re-write the verdict",
      );
      // Contrast with webhook.test.ts:135 "REPRO (defect): replayed event id is
      // fully re-processed": that assertion only holds because the shared
      // harness never persists the audit row.
    } finally {
      fake.restore();
    }
  },
);

// ── Persist failure is acknowledged (index.ts:2314-2324) ─────────────────────

Deno.test(
  "structural2: a TRANSIENT billing_entitlements failure must be retryable (5xx, no audit row) — observed: 200 ack + audit row, replay suppressed",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest({ billingUpsertStatus: 503 });
    try {
      const res = await h.handler(webhookRequest(renewal("s2-persist-503")));
      const body = await res.json();
      // What the code should do: surface a retryable status so RevenueCat
      // re-delivers, and leave NO audit row so the retry is fully processed.
      assert(
        res.status >= 500,
        `transient DB failure must not be acknowledged; got ${res.status} ${JSON.stringify(body)}`,
      );
      assertEquals(fake.state.webhookEvents.has("s2-persist-503"), false);
    } finally {
      fake.restore();
    }
  },
);

Deno.test(
  "structural2 (evidence): after an acknowledged persist failure the SAME id replays as duplicate — verdict is never written",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest({ billingUpsertStatus: 503 });
    try {
      const res = await h.handler(webhookRequest(renewal("s2-lost")));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(fake.state.webhookEvents.has("s2-lost"), true, "audit row written anyway");
      assertEquals(fake.state.billingRows.size, 0, "verdict never persisted");
    } finally {
      fake.restore();
    }
    // DB recovers; RevenueCat (or an operator) redelivers the same event.
    const recovered = withStatefulRest();
    try {
      recovered.state.webhookEvents.set("s2-lost", { id: "s2-lost" });
      const replay = await h.handler(webhookRequest(renewal("s2-lost")));
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(recovered.state.billingRows.size, 0, "still never persisted");
    } finally {
      recovered.restore();
    }
  },
);

Deno.test(
  "structural2: PostgREST fully down must yield a retryable 5xx — observed: 200 {verified:false} after a RevenueCat round trip",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest({
      billingUpsertStatus: 503,
      webhookEventsStatus: 503,
      webhookEventsRetryAfter: "0",
    });
    try {
      const lines = await captureConsole(async () => {
        const res = await h.handler(webhookRequest(renewal("s2-db-down")));
        const body = await res.json();
        assertEquals(h.callsTo(RC_URL).length, 1, "seen-lookup failure falls open into RC");
        assert(
          res.status >= 500,
          `DB outage must not be acknowledged; got ${res.status} ${JSON.stringify(body)}`,
        );
      });
      assert(lines.some((l) => l.includes("webhook event lookup failed")));
    } finally {
      fake.restore();
    }
  },
);

Deno.test(
  "structural2: TRANSFER with one side failing to persist must not be acknowledged — observed: 200 {verified:false}, from-side written, to-side lost",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest({
      billingUpsertStatus: (row) => (row.user_id === OTHER_USER_ID ? 503 : 201),
    });
    try {
      const res = await h.handler(
        webhookRequest({
          id: "s2-transfer-partial",
          type: "TRANSFER",
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        }),
      );
      const body = await res.json();
      assertEquals(fake.state.billingRows.has(TEST_USER_ID), true);
      assertEquals(fake.state.billingRows.has(OTHER_USER_ID), false);
      assert(
        res.status >= 500,
        `partial persist must be retryable; got ${res.status} ${JSON.stringify(body)}`,
      );
    } finally {
      fake.restore();
    }
  },
);

Deno.test(
  "structural2 (verified behaviour): PostgREST 503 on the seen-lookup is retried 3× by postgrest-js (~7s) before the webhook falls open",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest({ webhookEventsStatus: 503 });
    try {
      const started = performance.now();
      const res = await h.handler(webhookRequest(renewal("s2-db-retry")));
      const elapsedMs = performance.now() - started;
      assertEquals(res.status, 200);
      await res.text();
      const lookups = h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "GET");
      assertEquals(lookups.length, 4, "1 attempt + 3 retries");
      assert(elapsedMs >= 6_000, `expected ≥6s of backoff, took ${elapsedMs.toFixed(0)}ms`);
      assertEquals(h.callsTo(RC_URL).length, 1, "then falls open into RevenueCat");
    } finally {
      fake.restore();
    }
  },
);

// ── Concurrency: check-then-act dedupe (index.ts:2274-2294) ─────────────────

Deno.test(
  "structural2: N concurrent deliveries of ONE event id must verify at most once — observed: N RevenueCat calls, N upserts",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest({
      rcDelayMs: () => 20,
      rcSubscriber: () => activeSubscriber(),
    });
    try {
      const n = 8;
      const responses = await Promise.all(
        Array.from({ length: n }, () => h.handler(webhookRequest(renewal("s2-parallel")))),
      );
      for (const r of responses) {
        assertEquals(r.status, 200);
        await r.text();
      }
      assertEquals(fake.state.webhookEvents.size, 1);
      assert(
        fake.state.rcCalls <= 1,
        `expected ≤1 RevenueCat verification for one event id, got ${fake.state.rcCalls}`,
      );
    } finally {
      fake.restore();
    }
  },
);

// ── Ignored errors: RevenueCat 4xx is indistinguishable from an outage ───────

Deno.test(
  "structural2: RevenueCat 401/403 (misconfigured key) must be logged distinctly — observed: silent, same 503 as an outage",
  async () => {
    const h = await loadHarness();
    const fake = withStatefulRest({
      rcStatus: 401,
      rcSubscriber: () => activeSubscriber(),
    });
    try {
      const lines = await captureConsole(async () => {
        const res = await h.handler(webhookRequest(renewal("s2-rc-401")));
        assertEquals(res.status, 503);
        assertEquals(await res.json(), {
          error: { message: "Verification is temporarily unavailable." },
        });
        assertEquals(fake.state.webhookEvents.size, 0);
      });
      assert(
        lines.some((l) => /revenuecat|401|unauthori[sz]ed/i.test(l)),
        `expected an operator-visible log for RC 401; console output: ${JSON.stringify(lines)}`,
      );
    } finally {
      fake.restore();
    }
  },
);

Deno.test(
  "structural2: POST /v1/billing/sync on RevenueCat 401 must log distinctly — observed: silent 502 billing_unavailable",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = [
      {
        premium: false,
        scored_count: 0,
        reserved_count: 0,
      },
    ];
    const fake = withStatefulRest({
      rcStatus: 401,
      rcSubscriber: () => activeSubscriber(),
    });
    try {
      const lines = await captureConsole(async () => {
        const res = await h.handler(
          userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.77" }),
        );
        assertEquals(res.status, 502);
        assertEquals((await res.json()).error.code, "billing_unavailable");
      });
      assert(
        lines.some((l) => /revenuecat|401|unauthori[sz]ed/i.test(l)),
        `expected an operator-visible log for RC 401; console output: ${JSON.stringify(lines)}`,
      );
    } finally {
      fake.restore();
    }
  },
);

Deno.test(
  "structural2 (verified): RevenueCat 429 and 500 both map to 503 with no audit row (RC retries)",
  async () => {
    const h = await loadHarness();
    for (const status of [429, 500]) {
      const fake = withStatefulRest({
        rcStatus: status,
        rcSubscriber: () => activeSubscriber(),
      });
      try {
        const res = await h.handler(webhookRequest(renewal(`s2-rc-${status}`)));
        assertEquals(res.status, 503);
        await res.text();
        assertEquals(fake.state.webhookEvents.size, 0);
        assertEquals(fake.state.billingRows.size, 0);
      } finally {
        fake.restore();
      }
    }
  },
);

// ── Stale-verdict race: last-writer-wins upsert, no verified_at guard ───────

Deno.test(
  "structural2: a webhook verdict read BEFORE a fresher billing/sync verdict must not overwrite it — observed: older verdict lands last and wins",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = [
      {
        premium: false,
        scored_count: 0,
        reserved_count: 0,
      },
    ];
    // RC call 0 (webhook) says NOT premium; call 1 (billing sync) says premium.
    // The webhook's upsert is delayed so it lands after the sync's.
    const fake = withStatefulRest({
      rcSubscriber: (nth) => (nth === 0 ? { entitlements: {} } : activeSubscriber()),
      billingUpsertDelayMs: (row) => (row.premium === false ? 60 : 0),
    });
    try {
      const webhook = h.handler(webhookRequest(renewal("s2-stale-race")));
      await sleep(10);
      const sync = h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.78" }));
      const [w, s] = await Promise.all([webhook, sync]);
      assertEquals(w.status, 200);
      assertEquals(s.status, 200);
      await w.text();
      assertEquals((await s.json()).billing.premium, true);

      const order = fake.state.billingWriteOrder;
      assertEquals(order.length, 2);
      assertEquals(order[0].premium, true, "sync verdict persisted first");
      assertEquals(order[1].premium, false, "older webhook verdict persisted last");
      assert(
        String(order[1].verified_at) < String(order[0].verified_at),
        "the later write carries the OLDER verified_at",
      );
      const finalRow = fake.state.billingRows.get(TEST_USER_ID)!;
      assertEquals(
        finalRow.premium,
        true,
        "final row must reflect the freshest RevenueCat verdict (premium:true)",
      );
    } finally {
      fake.restore();
    }
  },
);

// ── Unbounded subjects (index.ts:2252-2262) ─────────────────────────────────

Deno.test(
  "structural2 (verified behaviour): TRANSFER subjects are unbounded — 40 uuids → 40 sequential RevenueCat calls",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const ids = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const res = await h.handler(
      webhookRequest({
        id: "s2-many",
        type: "TRANSFER",
        transferred_from: ids.slice(0, 20),
        transferred_to: ids.slice(20),
      }),
    );
    assertEquals(res.status, 200);
    await res.text();
    assertEquals(h.callsTo(RC_URL).length, 40);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 40);
  },
);

Deno.test(
  "structural2 (verified behaviour): extra uuid aliases are ignored when app_user_id is a uuid; only the FIRST uuid alias is used otherwise",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const withApp = await h.handler(
      webhookRequest({
        id: "s2-alias-1",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
        aliases: [TEST_USER_ID, OTHER_USER_ID],
      }),
    );
    await withApp.text();
    assertEquals(h.callsTo(RC_URL).length, 1);
    assert(h.callsTo(RC_URL)[0].url.endsWith(encodeURIComponent(TEST_USER_ID)));

    h.reset();
    h.subscriber = activeSubscriber();
    const anon = await h.handler(
      webhookRequest({
        id: "s2-alias-2",
        type: "RENEWAL",
        app_user_id: "$RCAnonymousID:zzz",
        aliases: ["$RCAnonymousID:zzz", OTHER_USER_ID, TEST_USER_ID],
      }),
    );
    await anon.text();
    assertEquals(h.callsTo(RC_URL).length, 1);
    assert(h.callsTo(RC_URL)[0].url.endsWith(encodeURIComponent(OTHER_USER_ID)));
  },
);

// ── Route matching: endsWith("/webhooks/revenuecat") (index.ts:2872) ────────

Deno.test(
  "structural2 (verified behaviour): any path ending in /webhooks/revenuecat is handled pre-auth as the webhook",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const shadowed = new Request("http://edge.test/functions/v1/api/v1/me/webhooks/revenuecat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: WEBHOOK_SECRET,
        "x-forwarded-for": "203.0.113.55",
      },
      body: JSON.stringify({
        api_version: "1.0",
        event: renewal("s2-shadow"),
      }),
    });
    const res = await h.handler(shadowed);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    // Bearer-shaped auth on that path is answered by the WEBHOOK (401 webhook
    // body), never by authenticate().
    const bearer = await h.handler(
      userRequest("POST", "/v1/me/webhooks/revenuecat", {
        ip: "203.0.113.56",
        body: { api_version: "1.0", event: renewal("s2-shadow-2") },
      }),
    );
    assertEquals(bearer.status, 401);
    assertEquals(await bearer.json(), {
      error: { message: "Invalid webhook credentials." },
    });
    assertEquals(h.callsTo("/auth/v1/").length, 0, "authenticate() never ran");
  },
);

// ── Null/undefined assumptions ──────────────────────────────────────────────

Deno.test(
  "structural2 (verified behaviour): non-string event.id gets a fresh random audit id per delivery — never deduplicable",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const fake = withStatefulRest();
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await h.handler(
          webhookRequest({
            id: 12345,
            type: "RENEWAL",
            app_user_id: TEST_USER_ID,
          }),
        );
        assertEquals(await res.json(), { received: true, verified: true });
      }
      assertEquals(fake.state.rcCalls, 2);
      assertEquals(fake.state.webhookEvents.size, 2);
      const [a, b] = [...fake.state.webhookEvents.keys()];
      assertNotEquals(a, b);
    } finally {
      fake.restore();
    }
  },
);

Deno.test(
  "structural2 (verified): event body without `event` object → 400; `event` with no verifiable subject → 200 verified:false + audit row",
  async () => {
    const h = await loadHarness();
    const fake = withStatefulRest();
    try {
      const noEvent = await h.handler(
        webhookRequest(null, {
          rawBody: JSON.stringify({ api_version: "1.0" }),
        }),
      );
      assertEquals(noEvent.status, 400);
      await noEvent.text();
      const noSubject = await h.handler(webhookRequest({ id: "s2-nosubject", type: "TEST" }));
      assertEquals(await noSubject.json(), { received: true, verified: false });
      assertEquals(fake.state.webhookEvents.get("s2-nosubject")?.app_user_id, null);
      assertEquals(fake.state.rcCalls, 0);
    } finally {
      fake.restore();
    }
  },
);

// ── Dependencies: supabase-js resolution ────────────────────────────────────

Deno.test(
  "structural2: the edge function's supabase-js import must be pinned or lock-enforced — observed: floating `@2`, lock:false, two divergent lockfiles",
  async () => {
    const here = new URL(".", import.meta.url);
    const indexSource = await Deno.readTextFile(new URL("../index.ts", here));
    const importLine = indexSource
      .split("\n")
      .find((line) => line.includes("npm:@supabase/supabase-js"));
    assert(importLine, "index.ts imports supabase-js");
    const denoJson = JSON.parse(await Deno.readTextFile(new URL("deno.json", here))) as Json;
    const lockEnforced = denoJson.lock !== false;
    const pinned = /npm:@supabase\/supabase-js@2\.\d+\.\d+/.test(importLine);
    assert(
      pinned || lockEnforced,
      `supabase-js resolves to whatever 2.x is latest at deploy/test time: ${importLine.trim()} with deno.json lock=${String(
        denoJson.lock,
      )}`,
    );
  },
);

// ── Entitlement folding (index.ts:2170-2189) ────────────────────────────────

Deno.test(
  "structural2 (verified): expired pickle_sensei_pro + active legacy premium → premium:true with the legacy product; malformed expires_date → not premium",
  async () => {
    const h = await loadHarness();
    h.subscriber = {
      entitlements: {
        pickle_sensei_pro: {
          expires_date: new Date(Date.now() - 1000).toISOString(),
          product_identifier: "pickle_sensei_pro_monthly",
        },
        premium: {
          expires_date: new Date(Date.now() + 3_600_000).toISOString(),
          product_identifier: "legacy_premium",
        },
      },
    };
    const res = await h.handler(webhookRequest(renewal("s2-fold-1")));
    assertEquals(await res.json(), { received: true, verified: true });
    const row = h.callsTo("/rest/v1/billing_entitlements")[0].body as Json;
    assertEquals(row.premium, true);
    assertEquals(row.product_key, "legacy_premium");

    h.reset();
    h.subscriber = {
      entitlements: {
        pickle_sensei_pro: {
          expires_date: "not-a-date",
          product_identifier: "x",
        },
      },
    };
    const bad = await h.handler(webhookRequest(renewal("s2-fold-2")));
    await bad.text();
    const badRow = h.callsTo("/rest/v1/billing_entitlements")[0].body as Json;
    assertEquals(badRow.premium, false);
    assertEquals(badRow.expires_at, null);
  },
);
