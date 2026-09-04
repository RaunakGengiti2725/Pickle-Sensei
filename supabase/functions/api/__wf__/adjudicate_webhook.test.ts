// ADJUDICATION reproductions for area `edge-billing-webhook` at 4d812e1a.
//
// Independent of the auditors' harnesses: a small stateful fetch wrapper over
// routesHarness (real ../index.ts handler; RevenueCat + PostgREST answered at
// the fetch layer). Every test PINS the behaviour observed on 4d812e1a so a
// fix must consciously flip the assertion.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adjudicate_webhook.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  activeSubscriber,
  type Harness,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const EVENTS_URL = `${SUPABASE_URL}/rest/v1/webhook_events`;
const ENTITLEMENTS_URL = `${SUPABASE_URL}/rest/v1/billing_entitlements`;
const ACCESS_ROW = [{ premium: true, scored_count: 0, reserved_count: 0 }];

interface Fault {
  match: (method: string, url: string) => boolean;
  status?: number;
  body?: unknown;
  delayMs?: number;
  times?: number;
  /** Per-URL RevenueCat subscriber override (by app_user_id fragment). */
  subscriber?: Record<string, unknown>;
}

interface Sim {
  h: Harness;
  auditRows: Map<string, Record<string, unknown>>;
  entitlementRows: Map<string, Record<string, unknown>>;
  faults: Fault[];
  errors: string[];
  restore(): void;
  rcCalls(): number;
  entitlementUpserts(): number;
  auditUpserts(): number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const pgError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Install a stateful PostgREST/RevenueCat simulation over the routesHarness stub. */
async function simulate(): Promise<Sim> {
  const h = await loadHarness();
  const stub = globalThis.fetch;
  const auditRows = new Map<string, Record<string, unknown>>();
  const entitlementRows = new Map<string, Record<string, unknown>>();
  const faults: Fault[] = [];
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  const counts = { rc: 0, ent: 0, audit: 0 };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const { url, method } = request;
    const bodyText = await request.clone().text().catch(() => "");
    let body: unknown = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }
    if (url.startsWith(RC_URL)) counts.rc += 1;
    if (url.startsWith(ENTITLEMENTS_URL) && method === "POST") {
      counts.ent += 1;
    }
    if (url.startsWith(EVENTS_URL) && method === "POST") counts.audit += 1;

    const fault = faults.find((f) =>
      f.match(method, url) && (f.times ?? 1) > 0
    );
    if (fault) {
      if (fault.times !== undefined) fault.times -= 1;
      if (fault.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, fault.delayMs);
          request.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      if (fault.status !== undefined) {
        return new Response(
          fault.body === undefined ? "" : JSON.stringify(fault.body),
          {
            status: fault.status,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (fault.subscriber) {
        return new Response(
          JSON.stringify({ subscriber: fault.subscriber }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (url.startsWith(EVENTS_URL)) {
      if (method === "GET") {
        const id = new URL(url).searchParams.get("id") ?? "";
        const key = id.startsWith("eq.") ? id.slice(3) : id;
        const row = auditRows.get(key);
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          return row
            ? new Response(JSON.stringify(row), { status: 200 })
            : pgError(406, "PGRST116", "0 rows");
        }
        return new Response(JSON.stringify(row ? [row] : []), {
          status: 200,
        });
      }
      if (
        method === "POST" && isRecord(body) && typeof body.id === "string"
      ) {
        if (!auditRows.has(body.id)) auditRows.set(body.id, body);
        return stub(input, init);
      }
    }
    if (
      url.startsWith(ENTITLEMENTS_URL) && method === "POST" && isRecord(body)
    ) {
      if (typeof body.user_id === "string") {
        entitlementRows.set(body.user_id, body);
      }
      return stub(input, init);
    }
    return stub(input, init);
  }) as typeof fetch;

  return {
    h,
    auditRows,
    entitlementRows,
    faults,
    errors,
    restore() {
      globalThis.fetch = stub;
      console.error = realError;
    },
    rcCalls: () => counts.rc,
    entitlementUpserts: () => counts.ent,
    auditUpserts: () => counts.audit,
  };
}

const expiredSubscriber = () =>
  activeSubscriber(new Date(Date.now() - 60_000).toISOString());

// ── A. persist failure → 200 ack + audit row → verdict lost forever ──────────

Deno.test(
  "ADJ-A1 REPRO: EXPIRATION whose billing_entitlements write fails (503) is acked 200 and deduped; healthy redelivery is dropped, premium row survives",
  async () => {
    const sim = await simulate();
    try {
      // The user is premium in the DB (simulated prior state) and RevenueCat now says expired.
      sim.entitlementRows.set(TEST_USER_ID, {
        user_id: TEST_USER_ID,
        premium: true,
      });
      sim.h.subscriber = expiredSubscriber();
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        status: 503,
        body: { code: "PGRST001", message: "could not connect to database" },
        times: 1,
      });
      const event = {
        id: "adj-exp-1",
        type: "EXPIRATION",
        app_user_id: TEST_USER_ID,
      };

      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 200);
      assertEquals(await first.json(), { received: true, verified: false });
      assertEquals(sim.rcCalls(), 1);
      assert(
        sim.errors.some((e) => e.includes("webhook verdict persist failed")),
      );
      assertEquals(
        sim.auditUpserts(),
        1,
        "audit row written despite the failed persist",
      );
      assert(sim.auditRows.has("adj-exp-1"));
      assertEquals(
        sim.entitlementRows.get(TEST_USER_ID)?.premium,
        true,
        "still premium",
      );

      // RevenueCat would retry only on 5xx; a 200 means it never will. Even if
      // the SAME id were redelivered, it is now a duplicate:
      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1, "no re-verification");
      assertEquals(sim.entitlementUpserts(), 1, "no second write attempt");
      assertEquals(
        sim.entitlementRows.get(TEST_USER_ID)?.premium,
        true,
        "downgrade lost",
      );
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-A2 REPRO: same transient DB failure on POST /v1/billing/sync is a retryable 503 (inconsistent with the webhook's 200)",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = expiredSubscriber();
      sim.h.rpcs["access_state"] = ACCESS_ROW;
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        status: 503,
        body: { code: "PGRST001", message: "could not connect to database" },
        times: 1,
      });
      const res = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.71" }),
      );
      assertEquals(res.status, 503);
      const body = await res.json();
      assert(
        !JSON.stringify(body).includes("could not connect"),
        "5xx body stays generic",
      );
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-A3 REPRO: TRANSFER persists per subject with no rollback — source revoked, destination 23503 swallowed, 200 verified:false, id deduped",
  async () => {
    const sim = await simulate();
    try {
      // RevenueCat after the transfer: source has nothing, destination is active.
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL) && u.includes(TEST_USER_ID),
        subscriber: { entitlements: {} },
        times: 10,
      });
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL) && u.includes(OTHER_USER_ID),
        subscriber: activeSubscriber(),
        times: 10,
      });
      sim.entitlementRows.set(TEST_USER_ID, {
        user_id: TEST_USER_ID,
        premium: true,
      });

      const event = {
        id: "adj-transfer-1",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      };
      // Destination has no profiles row yet → FK violation on ITS upsert only
      // (the second billing_entitlements write of this delivery).
      let upserts = 0;
      sim.faults.push({
        match: (m, u) => {
          if (m === "POST" && u.startsWith(ENTITLEMENTS_URL)) {
            upserts += 1;
            return upserts === 2;
          }
          return false;
        },
        status: 409,
        body: { code: "23503", message: "violates foreign key constraint" },
        times: 1,
      });

      const res = await sim.h.handler(webhookRequest(event));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(
        sim.entitlementRows.get(TEST_USER_ID)?.premium,
        false,
        "source revoked",
      );
      assertEquals(
        sim.entitlementRows.has(OTHER_USER_ID),
        false,
        "destination never written",
      );
      assert(
        sim.auditRows.has("adj-transfer-1"),
        "audit row written → id deduped",
      );

      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.entitlementRows.has(OTHER_USER_ID), false);
    } finally {
      sim.restore();
    }
  },
);

// ── B. idempotency store degradation ────────────────────────────────────────

Deno.test(
  "ADJ-B1 REPRO: webhook_events lookup error fails OPEN — same id ×3 → 3 RC calls, 3 upserts, 3× verified:true",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "GET" && u.startsWith(EVENTS_URL),
        status: 500,
        body: { code: "XX000", message: "internal" },
        times: 3,
      });
      const event = {
        id: "adj-lookup-1",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      for (let i = 0; i < 3; i += 1) {
        const res = await sim.h.handler(webhookRequest(event));
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { received: true, verified: true });
      }
      assertEquals(sim.rcCalls(), 3);
      assertEquals(sim.entitlementUpserts(), 3);
      assertEquals(
        sim.errors.filter((e) => e.includes("webhook event lookup failed"))
          .length,
        3,
      );
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B2 REPRO: webhook_events write failure is swallowed — 200 verified:true, no audit row, redelivery re-processes",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(EVENTS_URL),
        status: 500,
        body: { code: "XX000", message: "internal" },
        times: 1,
      });
      const event = {
        id: "adj-audit-1",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(await first.json(), { received: true, verified: true });
      assert(sim.errors.some((e) => e.includes("webhook event log failed")));
      assertEquals(sim.auditRows.has("adj-audit-1"), false);
      const second = await sim.h.handler(webhookRequest(event));
      assertEquals(await second.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.entitlementUpserts(), 2);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B3 REPRO: 5 concurrent deliveries of one id all pass the check-then-act dedupe (5 RC calls, 5 upserts)",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        delayMs: 50,
        subscriber: activeSubscriber(),
        times: 5,
      });
      const event = {
        id: "adj-concurrent-1",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => sim.h.handler(webhookRequest(event))),
      );
      const bodies = await Promise.all(responses.map((r) => r.json()));
      assertEquals(bodies.filter((b) => b.duplicate).length, 0);
      assertEquals(sim.rcCalls(), 5);
      assertEquals(sim.entitlementUpserts(), 5);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B4 REPRO: no verified_at guard — slower stale RC verdict (premium) overwrites the newer one (expired)",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        delayMs: 300,
        subscriber: activeSubscriber(),
        times: 1,
      });
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        subscriber: expiredSubscriber(),
        times: 1,
      });
      const slow = sim.h.handler(
        webhookRequest({
          id: "adj-order-1",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      await sleep(20);
      const fast = sim.h.handler(
        webhookRequest({
          id: "adj-order-2",
          type: "EXPIRATION",
          app_user_id: TEST_USER_ID,
        }),
      );
      const [a, b] = await Promise.all([slow, fast]);
      await a.json();
      await b.json();
      assertEquals(sim.entitlementUpserts(), 2);
      assertEquals(
        sim.entitlementRows.get(TEST_USER_ID)?.premium,
        true,
        "stale verdict won",
      );
    } finally {
      sim.restore();
    }
  },
);

// ── C. operability ──────────────────────────────────────────────────────────

Deno.test(
  "ADJ-C1 REPRO: RevenueCat 401 'Invalid API key' → 503 with NO log line naming the upstream status",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        status: 401,
        body: { code: 7225, message: "Invalid API key." },
        times: 2,
      });
      const res = await sim.h.handler(
        webhookRequest({
          id: "adj-rc401",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(res.status, 503);
      await res.text();
      assertEquals(sim.auditUpserts(), 0);
      assertEquals(sim.entitlementUpserts(), 0);
      const upstream = sim.errors.filter((e) =>
        /revenuecat|401|api key/i.test(e)
      );
      assertEquals(
        upstream,
        [],
        "observed: nothing is logged for the RevenueCat 4xx",
      );
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-C2 REPRO: TRANSFER subjects are verified serially — 6 subjects × 300 ms RC latency ≥ 1.8 s wall",
  async () => {
    const sim = await simulate();
    try {
      const ids = Array.from(
        { length: 6 },
        (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa0${i}`,
      );
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        delayMs: 300,
        subscriber: activeSubscriber(),
        times: 6,
      });
      const started = performance.now();
      const res = await sim.h.handler(
        webhookRequest({
          id: "adj-wide-transfer",
          type: "TRANSFER",
          transferred_from: ids.slice(0, 5),
          transferred_to: ids.slice(5),
        }),
      );
      const wallMs = performance.now() - started;
      assertEquals(res.status, 200);
      await res.json();
      assertEquals(sim.rcCalls(), 6);
      assert(wallMs >= 1800, `serial: ${wallMs.toFixed(0)} ms`);
      console.log(`ADJ-C2 wallMs=${wallMs.toFixed(0)}`);
    } finally {
      sim.restore();
    }
  },
);

// ── D. dedupe works when the audit store is healthy (spec path) ─────────────

Deno.test(
  "ADJ-D1 HELD: with a stateful webhook_events store, redelivery of a processed id is a duplicate ack with zero RC/billing traffic",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      const event = {
        id: "adj-ok-1",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(await first.json(), { received: true, verified: true });
      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      assertStringIncludes(
        String(
          sim.h.callsTo(EVENTS_URL).find((c) => c.method === "POST")
            ?.headers["prefer"],
        ),
        "resolution=ignore-duplicates",
      );
    } finally {
      sim.restore();
    }
  },
);
