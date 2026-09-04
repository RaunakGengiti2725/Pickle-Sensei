// ADJUDICATION suite for area `edge-billing-webhook`.
//
// Originally (at 4d812e1a) every test here PINNED an observed defect. The
// A/B tests are now rewritten to assert the fixed contract — the ADJ ids are
// kept so the audit trail (adjudicate_run1.log) lines up:
//
//   ADJ-A1  transient billing_entitlements failure → 503, no audit row,
//           redelivery re-verifies and lands the verdict.
//   ADJ-A2  the same fault on POST /v1/billing/sync is a 503 (unchanged).
//   ADJ-A3  the documented FK 23503 "never bootstrapped" path keeps its 200
//           {verified:false} ack and its audit row.
//   ADJ-B1  audit-plane lookup/reservation error → 503, no RC/billing traffic.
//   ADJ-B2  audit-plane write error → 503; redelivery processes exactly once.
//   ADJ-B3  N concurrent deliveries of one id → exactly one verification and
//           persist; the rest are retryable 503s (in-flight) — never N× verified.
//   ADJ-B4  verified_at is monotonic: a slower, staler RC verdict is dropped.
//   ADJ-B5  an orphaned reservation (isolate died mid-flight) is reclaimed
//           once its lease lapses; a live one is left alone.
//   ADJ-C1  RevenueCat 4xx → 503, nothing persisted, reservation released
//           (operability of the log line is a separate cluster).
//   ADJ-C2  TRANSFER subjects are verified serially (separate cluster).
//   ADJ-D1  healthy store: redelivery of a processed id is a duplicate ack.
//
// The PostgREST/RevenueCat plane is webhookSim.ts (stateful rows, faults).
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adjudicate_webhook.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  activeSubscriber,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";
import {
  dbUnavailable,
  ENTITLEMENTS_URL,
  EVENTS_URL,
  expiredSubscriber,
  simulate,
  sleep,
} from "./webhookSim.ts";

const ACCESS_ROW = [{ premium: true, scored_count: 0, reserved_count: 0 }];

const genericBody = async (res: Response): Promise<void> => {
  const text = await res.text();
  assert(!/could not connect|PGRST|internal/i.test(text), `5xx body stays generic: ${text}`);
};

// ── A. entitlement persistence failures ─────────────────────────────────────

Deno.test(
  "ADJ-A1: EXPIRATION whose billing_entitlements write fails (503) is a retryable 503 with NO audit row; the redelivery re-verifies and lands premium:false",
  async () => {
    const sim = await simulate();
    try {
      // The user is premium in the DB and RevenueCat now says expired.
      sim.entitlementRows.set(TEST_USER_ID, {
        user_id: TEST_USER_ID,
        premium: true,
        verified_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      sim.h.subscriber = expiredSubscriber();
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        ...dbUnavailable,
        times: 1,
      });
      const event = {
        id: "adj-exp-1",
        type: "EXPIRATION",
        app_user_id: TEST_USER_ID,
      };

      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 503);
      await genericBody(first);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      assert(
        sim.errors.some((e) => /webhook verdict persist/i.test(e)),
        `persist failure is logged: ${JSON.stringify(sim.errors)}`,
      );
      assertEquals(sim.auditRows.has("adj-exp-1"), false, "no audit row for a failed delivery");
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, true, "DB untouched so far");

      // RevenueCat retries on 5xx: the redelivery is fully re-processed.
      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2, "re-verified against RevenueCat");
      assertEquals(sim.entitlementUpserts(), 2);
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false, "downgrade landed");
      const audit = sim.auditRows.get("adj-exp-1");
      assert(audit, "audit row written once handled to completion");
      assert(typeof audit.processed_at === "string", "and marked processed");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-A2: the same transient DB failure on POST /v1/billing/sync is a retryable 503 with a generic body",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = expiredSubscriber();
      sim.h.rpcs["access_state"] = ACCESS_ROW;
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        ...dbUnavailable,
        times: 1,
      });
      const res = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.71" }),
      );
      assertEquals(res.status, 503);
      await genericBody(res);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-A3: TRANSFER whose destination has no profiles row (FK 23503) keeps the documented 200 {verified:false} ack, the source revoke, and the audit row",
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
      // Destination has never bootstrapped → FK violation on ITS upsert only.
      sim.faults.push({
        match: (m, u) =>
          m === "POST" && u.startsWith(ENTITLEMENTS_URL) && sim.entitlementUpserts() === 2,
        status: 409,
        body: { code: "23503", message: "violates foreign key constraint" },
        times: 1,
      });
      const event = {
        id: "adj-transfer-1",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      };

      const res = await sim.h.handler(webhookRequest(event));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.entitlementUpserts(), 2);
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false, "source revoked");
      assertEquals(sim.entitlementRows.has(OTHER_USER_ID), false, "destination never written");
      assert(
        sim.errors.some((e) => /webhook verdict persist/i.test(e)),
        "23503 is logged",
      );
      const audit = sim.auditRows.get("adj-transfer-1");
      assert(audit && typeof audit.processed_at === "string", "audit row written and processed");

      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 2, "no re-verification of a processed id");
      assertEquals(sim.entitlementRows.has(OTHER_USER_ID), false);
    } finally {
      sim.restore();
    }
  },
);

// ── B. idempotency plane ────────────────────────────────────────────────────

Deno.test(
  "ADJ-B1: webhook_events reservation error fails CLOSED — same id ×3 → 3× 503, 0 RC calls, 0 billing upserts, no audit row",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(EVENTS_URL),
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
        assertEquals(res.status, 503, `delivery ${i + 1}`);
        await genericBody(res);
      }
      assertEquals(sim.rcCalls(), 0);
      assertEquals(sim.entitlementUpserts(), 0);
      assertEquals(sim.auditRows.size, 0);
      assertEquals(sim.errors.filter((e) => /webhook event reservation/i.test(e)).length, 3);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B1b: webhook_events lookup error on a redelivered id fails CLOSED — 503, 0 RC calls; the next healthy redelivery is a duplicate ack",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      const event = {
        id: "adj-lookup-2",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(await first.json(), { received: true, verified: true });

      sim.faults.push({
        match: (m, u) => m === "GET" && u.startsWith(EVENTS_URL),
        status: 500,
        body: { code: "XX000", message: "internal" },
        times: 1,
      });
      const degraded = await sim.h.handler(webhookRequest(event));
      assertEquals(degraded.status, 503);
      await genericBody(degraded);
      assert(sim.errors.some((e) => /webhook event lookup/i.test(e)));

      const healthy = await sim.h.handler(webhookRequest(event));
      assertEquals(healthy.status, 200);
      assertEquals(await healthy.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B2: webhook_events write failure → 503 with no billing traffic; redelivery processes exactly once, then duplicate:true",
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
      assertEquals(first.status, 503);
      await genericBody(first);
      assertEquals(sim.auditRows.has("adj-audit-1"), false);
      assertEquals(sim.rcCalls(), 0, "no verification without a reservation");
      assertEquals(sim.entitlementUpserts(), 0);

      const second = await sim.h.handler(webhookRequest(event));
      assertEquals(second.status, 200);
      assertEquals(await second.json(), { received: true, verified: true });
      const third = await sim.h.handler(webhookRequest(event));
      assertEquals(third.status, 200);
      assertEquals(await third.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B2b: completion marker (PATCH) failure after a persisted verdict → 503; the row stays reserved so the in-lease redelivery is retryable, not re-verified",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "PATCH" && u.startsWith(EVENTS_URL),
        status: 500,
        body: { code: "XX000", message: "internal" },
        times: 1,
      });
      const event = {
        id: "adj-audit-2",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 503);
      await genericBody(first);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, true, "verdict persisted");
      const row = sim.auditRows.get("adj-audit-2");
      assert(row, "reservation kept (the verdict IS persisted)");
      assertEquals(row.processed_at, null);
      assert(sim.errors.some((e) => /webhook event completion/i.test(e)));

      const retry = await sim.h.handler(webhookRequest(event));
      assertEquals(
        retry.status,
        503,
        "in-flight reservation is retryable, never a false duplicate",
      );
      assertEquals(sim.rcCalls(), 1, "no second verification while the lease is live");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B3: 5 concurrent deliveries of one id → exactly 1 RC call, 1 billing upsert, 1× verified:true and 4 retryable 503s (never 5× verified:true)",
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
      const statuses = responses.map((r) => r.status).sort();
      assertEquals(statuses, [200, 503, 503, 503, 503]);
      assertEquals(bodies.filter((b) => b.verified === true).length, 1);
      assertEquals(bodies.filter((b) => b.duplicate === true).length, 0);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      const row = sim.auditRows.get("adj-concurrent-1");
      assert(row && typeof row.processed_at === "string", "single processed row");

      // Once processed, the retries RevenueCat issues for the 503s are duplicates.
      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B4: verified_at is monotonic — a slower, staler RC verdict (premium) does NOT overwrite the newer one (expired)",
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
      assertEquals(a.status, 200);
      assertEquals(b.status, 200);
      await a.json();
      await b.json();
      assertEquals(sim.entitlementUpserts(), 2, "both deliveries attempt their write");
      assertEquals(sim.entitlementWrites.length, 1, "only the newer verdict is accepted");
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, false, "the newer (expired) verdict stands");
      const fastWrite = sim.h
        .callsTo(ENTITLEMENTS_URL)
        .map((c) => c.body as Record<string, unknown>)
        .find((body) => body.premium === false);
      assert(fastWrite, "fast delivery wrote premium:false");
      assertEquals(row?.verified_at, fastWrite.verified_at, "verified_at is the fast delivery's");
      const slowWrite = sim.h
        .callsTo(ENTITLEMENTS_URL)
        .map((c) => c.body as Record<string, unknown>)
        .find((body) => body.premium === true);
      assert(slowWrite, "slow delivery attempted premium:true");
      assert(
        Date.parse(String(slowWrite.verified_at)) < Date.parse(String(fastWrite.verified_at)),
        "verified_at is taken BEFORE the RevenueCat round trip, so the slow verdict is older",
      );
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ADJ-B5: an orphaned reservation past its lease is reclaimed and processed; a live one is left alone (503, no RC traffic)",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      sim.auditRows.set("adj-orphan-1", {
        id: "adj-orphan-1",
        provider: "revenuecat",
        event_type: "RENEWAL",
        app_user_id: TEST_USER_ID,
        payload: {},
        received_at: stale,
        claimed_at: stale,
        processed_at: null,
      });
      const orphan = await sim.h.handler(
        webhookRequest({
          id: "adj-orphan-1",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(orphan.status, 200);
      assertEquals(await orphan.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      const row = sim.auditRows.get("adj-orphan-1");
      assert(row && typeof row.processed_at === "string", "reclaimed row is marked processed");
      assert(Date.parse(String(row.claimed_at)) > Date.parse(stale), "lease renewed on reclaim");

      const live = new Date().toISOString();
      sim.auditRows.set("adj-orphan-2", {
        id: "adj-orphan-2",
        provider: "revenuecat",
        event_type: "RENEWAL",
        app_user_id: TEST_USER_ID,
        payload: {},
        received_at: live,
        claimed_at: live,
        processed_at: null,
      });
      const inFlight = await sim.h.handler(
        webhookRequest({
          id: "adj-orphan-2",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(inFlight.status, 503);
      await genericBody(inFlight);
      assertEquals(sim.rcCalls(), 1, "a live reservation is not re-verified");
      assertEquals(sim.auditRows.get("adj-orphan-2")?.processed_at, null);
    } finally {
      sim.restore();
    }
  },
);

// ── C. operability (owned by another cluster; contract pinned here) ─────────

Deno.test(
  "ADJ-C1: RevenueCat 401 'Invalid API key' → 503 with nothing persisted and the reservation released; NO log line names the upstream status (separate cluster)",
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
      assertEquals(sim.entitlementUpserts(), 0);
      assertEquals(sim.auditRows.has("adj-rc401"), false, "reservation released");
      const upstream = sim.errors.filter((e) => /revenuecat|401|api key/i.test(e));
      assertEquals(upstream, [], "observed: nothing is logged for the RevenueCat 4xx");
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
      const ids = Array.from({ length: 6 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa0${i}`);
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
        String(sim.h.callsTo(EVENTS_URL).find((c) => c.method === "POST")?.headers["prefer"]),
        "resolution=ignore-duplicates",
      );
    } finally {
      sim.restore();
    }
  },
);
