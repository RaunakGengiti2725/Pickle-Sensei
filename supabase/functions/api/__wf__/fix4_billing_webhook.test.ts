// Fix round 4 for the billing-webhook cluster (ADJ-1 / ADJ-2 / ADJ-3) — the
// regressions the reviewer and the adversary surfaced on the candidate:
//
//   FIX4-2  xc_concurrency_harness fidelity: PostgREST's
//           `INSERT … ON CONFLICT DO NOTHING RETURNING` (Prefer:
//           resolution=ignore-duplicates,return=representation) returns ONLY
//           the rows the statement inserted; merge-duplicates returns the
//           merged rows. The harness used to echo every incoming row, which
//           made every concurrent copy believe it owned the reservation.
//   FIX4-4  POST /v1/billing/sync whose verdict the BEFORE UPDATE trigger
//           dropped as stale must answer BOTH `billing` and `access` from the
//           persisted row (response == DB), not from the dropped verdict.
//   FIX4-5  verified_at comes from RevenueCat's `request_date_ms` (one server
//           clock across isolates); the isolate clock is only the fallback
//           when the field is absent — so a 30 s clock skew cannot misorder
//           verdicts.
//
// Run: deno test -A --no-check --config deno.json fix4_billing_webhook.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  activeSubscriber,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";
import { ENTITLEMENTS_URL, expiredSubscriber, simulate, sleep } from "./webhookSim.ts";
import {
  FakeSupabase,
  SERVICE_ROLE_KEY,
  SUPABASE_URL as XC_SUPABASE_URL,
} from "./xc_concurrency_harness.ts";

const ACCESS_ROW = [{ premium: true, scored_count: 0, reserved_count: 0 }];
const rcFor = (userId: string) => `${RC_URL}${encodeURIComponent(userId)}`;

// ── FIX4-2 harness fidelity ─────────────────────────────────────────────────

async function postgrest(
  fake: FakeSupabase,
  method: string,
  path: string,
  prefer: string,
  body?: unknown,
): Promise<{ status: number; rows: unknown }> {
  const request = new Request(`${XC_SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rawBody = await request.clone().text();
  const response = await fake.handleFetch(request, rawBody);
  const text = await response.text();
  return { status: response.status, rows: text ? JSON.parse(text) : null };
}

const auditRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: "revenuecat",
  event_type: "RENEWAL",
  app_user_id: TEST_USER_ID,
  payload: {},
  claimed_at: "2026-09-04T12:00:00.000Z",
  processed_at: null,
  ...extra,
});

Deno.test(
  "FIX4-2: harness ignore-duplicates + return=representation returns ONLY the rows actually inserted (PostgREST `ON CONFLICT DO NOTHING RETURNING`)",
  async () => {
    const fake = new FakeSupabase(1, 0);
    const prefer = "resolution=ignore-duplicates,return=representation";

    const first = await postgrest(fake, "POST", "webhook_events?on_conflict=id", prefer, [
      auditRow("evt-a"),
    ]);
    assertEquals(first.status, 201);
    assertEquals(first.rows, [auditRow("evt-a")], "a fresh id is inserted and returned");

    const replay = await postgrest(fake, "POST", "webhook_events?on_conflict=id", prefer, [
      auditRow("evt-a", { claimed_at: "2026-09-04T12:00:05.000Z" }),
    ]);
    assertEquals(replay.status, 201);
    assertEquals(replay.rows, [], "an existing id is NOT returned (nothing was inserted)");
    assertEquals(fake.tables.webhook_events.length, 1);
    assertEquals(
      fake.tables.webhook_events[0].claimed_at,
      "2026-09-04T12:00:00.000Z",
      "DO NOTHING leaves the stored row untouched",
    );

    const mixed = await postgrest(fake, "POST", "webhook_events?on_conflict=id", prefer, [
      auditRow("evt-a"),
      auditRow("evt-b"),
    ]);
    assertEquals(mixed.status, 201);
    assertEquals(mixed.rows, [auditRow("evt-b")], "only the new row of a mixed batch comes back");
    assertEquals(fake.tables.webhook_events.length, 2);

    const silent = await postgrest(
      fake,
      "POST",
      "webhook_events?on_conflict=id",
      "resolution=ignore-duplicates",
      [auditRow("evt-a")],
    );
    assertEquals(silent.status, 201);
    assertEquals(silent.rows, null, "no representation requested → empty body");
  },
);

Deno.test(
  "FIX4-2: harness merge-duplicates + return=representation still returns the merged rows (behaviour unchanged)",
  async () => {
    const fake = new FakeSupabase(1, 0);
    const prefer = "resolution=merge-duplicates,return=representation";
    const seeded = await postgrest(
      fake,
      "POST",
      "billing_entitlements?on_conflict=user_id",
      prefer,
      [{ user_id: TEST_USER_ID, premium: false, verified_at: "2026-09-04T12:00:00.000Z" }],
    );
    assertEquals(seeded.status, 201);
    assertEquals(seeded.rows, [
      { user_id: TEST_USER_ID, premium: false, verified_at: "2026-09-04T12:00:00.000Z" },
    ]);

    const merged = await postgrest(
      fake,
      "POST",
      "billing_entitlements?on_conflict=user_id",
      prefer,
      [{ user_id: TEST_USER_ID, premium: true, verified_at: "2026-09-04T12:00:01.000Z" }],
    );
    assertEquals(merged.status, 201);
    assertEquals(
      merged.rows,
      [{ user_id: TEST_USER_ID, premium: true, verified_at: "2026-09-04T12:00:01.000Z" }],
      "the merged (updated) row is returned",
    );
    assertEquals(fake.tables.billing_entitlements.length, 1, "merged in place, not duplicated");
    assertEquals(fake.tables.billing_entitlements[0].premium, true);
  },
);

// ── FIX4-4 response == DB after a dropped stale verdict ─────────────────────

Deno.test(
  "FIX4-4: POST /v1/billing/sync whose verdict is dropped as stale re-reads billing_entitlements and answers billing AND access from the persisted row (response == DB)",
  async () => {
    const sim = await simulate();
    try {
      sim.h.rpcs["access_state"] = ACCESS_ROW;
      // sync starts first; RevenueCat evaluates it (premium) and answers slowly
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        delayMs: 300,
        subscriber: activeSubscriber(),
        times: 1,
      });
      // a webhook for the same user starts later, is evaluated later (expired)
      // and its answer lands first
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        times: 1,
      });
      const sync = sim.h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.5" }));
      await sleep(20);
      const hook = await sim.h.handler(
        webhookRequest({ id: "fix4-sync-race", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      assertEquals(hook.status, 200);
      assertEquals(await hook.json(), { received: true, verified: true });

      const syncRes = await sync;
      assertEquals(syncRes.status, 200);
      const body = (await syncRes.json()) as {
        billing: {
          premium: boolean;
          productKey: string | null;
          expiresAt: string | null;
          verifiedAt: string;
        };
        access: { premium: boolean; entitlements: string[]; paywallRequired: boolean };
      };
      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assert(stored, "a durable row exists");
      assertEquals(stored.premium, false, "DB keeps the newer (expired) verdict");
      assertEquals(sim.entitlementWrites.length, 1, "the sync's stale write was dropped");
      assertEquals(sim.entitlementUpserts(), 2, "both verdicts were attempted");

      // billing: every field mirrors the persisted row
      assertEquals(body.billing.premium, stored.premium);
      assertEquals(body.billing.productKey, stored.product_key);
      assertEquals(
        Date.parse(body.billing.expiresAt ?? ""),
        Date.parse(String(stored.expires_at)),
        "expiresAt is the persisted one",
      );
      assertEquals(
        Date.parse(body.billing.verifiedAt),
        Date.parse(String(stored.verified_at)),
        "verifiedAt is the persisted verdict's, not the dropped one's",
      );
      // access: built from the same persisted state, never from the RPC's
      // stale premium=true nor from the dropped verdict
      assertEquals(body.access.premium, stored.premium);
      assertEquals(body.access.entitlements, []);
      assertEquals(body.access.paywallRequired, false, "free ratings remain (scored_count 0)");

      const reads = sim.h.callsTo(ENTITLEMENTS_URL).filter((c) => c.method === "GET");
      assertEquals(reads.length, 1, "exactly one re-read of the durable row");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "FIX4-4: a verdict that lands (non-empty RETURNING) answers from itself — no re-read, response == DB",
  async () => {
    const sim = await simulate();
    try {
      sim.h.rpcs["access_state"] = [{ premium: false, scored_count: 2, reserved_count: 0 }];
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        times: 1,
      });
      const res = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.6" }),
      );
      assertEquals(res.status, 200);
      const body = (await res.json()) as {
        billing: { premium: boolean; verifiedAt: string };
        access: { premium: boolean; entitlements: string[] };
      };
      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assert(stored);
      assertEquals(body.billing.premium, true);
      assertEquals(body.billing.premium, stored.premium);
      assertEquals(Date.parse(body.billing.verifiedAt), Date.parse(String(stored.verified_at)));
      assertEquals(body.access.premium, true);
      assertEquals(body.access.entitlements, ["premium", "pickle_sensei_pro"]);
      assertEquals(sim.h.callsTo(ENTITLEMENTS_URL).filter((c) => c.method === "GET").length, 0);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "FIX4-4: the re-read after a dropped verdict fails → generic 503 (never a made-up billing state)",
  async () => {
    const sim = await simulate();
    try {
      sim.h.rpcs["access_state"] = ACCESS_ROW;
      // an already-newer row is stored, so the sync's verdict is dropped
      const newer = new Date(Date.now() + 60_000).toISOString();
      sim.entitlementRows.set(TEST_USER_ID, {
        user_id: TEST_USER_ID,
        premium: false,
        product_key: null,
        expires_at: null,
        verified_at: newer,
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        times: 1,
      });
      // 500 rather than 503: postgrest-js transparently retries idempotent
      // 503s (1 s / 2 s / 4 s backoff), which this test is not about.
      sim.faults.push({
        match: (m, u) => m === "GET" && u.startsWith(ENTITLEMENTS_URL),
        status: 500,
        body: { code: "XX000", message: "could not connect to database" },
        times: 1,
      });
      const res = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.7" }),
      );
      assertEquals(res.status, 503);
      const text = await res.text();
      assert(!text.includes("XX000") && !text.includes("connect to database"), text);
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false, "DB untouched");
    } finally {
      sim.restore();
    }
  },
);

// ── FIX4-5 clock skew ───────────────────────────────────────────────────────

/** Run `fn` with this isolate's clock skewed by `skewMs` (Date.now and the
 * no-argument Date constructor — everything the edge function reads). */
async function withClockSkew<T>(skewMs: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SkewedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        super(RealDate.now() + skewMs);
      } else {
        super(...args);
      }
    }
    static override now(): number {
      return RealDate.now() + skewMs;
    }
  }
  globalThis.Date = SkewedDate as unknown as typeof Date;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

Deno.test(
  "FIX4-5: isolate A's clock is 30 s AHEAD — RevenueCat's request_date_ms still orders the verdicts, so the later (expired) verdict from isolate B wins",
  async () => {
    const sim = await simulate();
    try {
      const rcClock = Date.now();
      // Isolate A (skewed +30 s) verifies first: RevenueCat evaluated at rcClock.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: rcClock,
        times: 1,
      });
      const a = await withClockSkew(30_000, () =>
        sim.h.handler(
          webhookRequest({ id: "fix4-skew-a", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        ),
      );
      assertEquals(await a.json(), { received: true, verified: true });
      const afterA = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(afterA?.premium, true);
      assertEquals(
        Date.parse(String(afterA?.verified_at)),
        rcClock,
        "verified_at is RevenueCat's request_date_ms, not the skewed isolate clock",
      );

      // Isolate B (true clock) verifies 1 s later on RevenueCat's clock: expired.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        requestDateMs: rcClock + 1_000,
        times: 1,
      });
      const b = await sim.h.handler(
        webhookRequest({ id: "fix4-skew-b", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await b.json(), { received: true, verified: true });
      const afterB = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(afterB?.premium, false, "the newer verdict (by RevenueCat's clock) wins");
      assertEquals(Date.parse(String(afterB?.verified_at)), rcClock + 1_000);
      assertEquals(sim.entitlementWrites.length, 2, "neither write was dropped as stale");
      assertEquals(sim.rcCalls(), 2);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "FIX4-5: a stale RevenueCat answer (older request_date_ms) that ARRIVES after a newer one is dropped, whatever the isolate clocks say",
  async () => {
    const sim = await simulate();
    try {
      const rcClock = Date.now();
      // Isolate A: RevenueCat evaluated at rcClock (premium) but the answer
      // arrives 250 ms late; A's clock is 30 s ahead.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: rcClock,
        delayMs: 250,
        times: 1,
      });
      // Isolate B: evaluated 500 ms later (expired), answered immediately.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        requestDateMs: rcClock + 500,
        times: 1,
      });
      const a = withClockSkew(30_000, () =>
        sim.h.handler(
          webhookRequest({ id: "fix4-skew-late-a", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        ),
      );
      await sleep(20);
      const b = await sim.h.handler(
        webhookRequest({ id: "fix4-skew-late-b", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await b.json(), { received: true, verified: true });
      assertEquals(await (await a).json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, false, "the expired verdict is the newer truth and stays");
      assertEquals(Date.parse(String(row?.verified_at)), rcClock + 500);
      assertEquals(sim.entitlementWrites.length, 1, "A's stale verdict was dropped");
      assertEquals(sim.entitlementUpserts(), 2);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "FIX4-5: without request_date_ms the verdict falls back to the isolate clock read BEFORE the RevenueCat round trip",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: null,
        delayMs: 120,
        times: 1,
      });
      const before = Date.now();
      const res = await sim.h.handler(
        webhookRequest({ id: "fix4-no-request-date", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      const afterRoundTrip = Date.now();
      assertEquals(await res.json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      const verifiedAt = Date.parse(String(row.verified_at));
      assert(verifiedAt >= before, "not earlier than the request");
      assert(
        verifiedAt < afterRoundTrip - 100,
        `stamped before the 120 ms round trip, not after it (verifiedAt=${verifiedAt} end=${afterRoundTrip})`,
      );
    } finally {
      sim.restore();
    }
  },
);
