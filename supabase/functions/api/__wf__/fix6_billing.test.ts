// Fix round 6 for the billing-webhook cluster — the two defects the adversary
// demonstrated on the round-4 candidate (attack_fix5_billing.test.ts,
// ATK5-BREAK-1/2), pinned at the root:
//
//   FIX6-1  POST /v1/billing/sync answers `billing.premium` and
//           `access.premium` through ONE effective-premium rule — the same
//           predicate `access_state()` (and every other DB decision point)
//           applies to a billing_entitlements row: premium AND (expires_at IS
//           NULL OR expires_at > now()). Pinned for BOTH the fresh-verdict path
//           (the verdict just landed) and the re-read path (the verdict was
//           dropped as stale and the stored row is answered), so the sync
//           response can never disagree with GET /v1/me/access.
//   FIX6-2  RevenueCat's `request_date_ms` is trusted as `verified_at` only
//           within a documented window around the isolate clock read BEFORE
//           the round trip: at most REVENUECAT_CLOCK_MAX_AHEAD_MS (5 min)
//           ahead, at most REVENUECAT_CLOCK_MAX_BEHIND_MS (24 h) behind.
//           Outside it the verdict falls back to that pre-request clock exactly
//           like the absent/NaN/≤0/out-of-range cases, so a bogus provider
//           clock can never become a monotonic key that outranks every later
//           real verdict (the wedge), while plausibly-skewed answers stay on
//           RevenueCat's single clock for cross-isolate ordering.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json fix6_billing.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  activeSubscriber,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";
import { ENTITLEMENTS_URL, expiredSubscriber, type Row, simulate, sleep } from "./webhookSim.ts";

const rcFor = (userId: string) => `${RC_URL}${encodeURIComponent(userId)}`;

/** Mirrors the constants in index.ts; a drift here is a failing test, not a
 * silently widened window. */
const REVENUECAT_CLOCK_MAX_AHEAD_MS = 5 * 60_000;
const REVENUECAT_CLOCK_MAX_BEHIND_MS = 24 * 60 * 60_000;

type SyncBody = {
  billing: {
    premium: boolean;
    productKey: string | null;
    expiresAt: string | null;
    verifiedAt: string;
  };
  access: { premium: boolean; entitlements: string[]; paywallRequired: boolean };
};

/** `public.access_state()` on a billing_entitlements row: premium AND
 * (expires_at IS NULL OR expires_at > now()). */
const dbPremium = (row: Row | undefined): boolean => {
  if (!row) return false;
  const exp = row.expires_at;
  return (
    row.premium === true &&
    (exp === null || exp === undefined || Date.parse(String(exp)) > Date.now())
  );
};

const accessRowFor = (row: Row | undefined) => [
  { premium: dbPremium(row), scored_count: 0, reserved_count: 0 },
];

const isoAt = (ms: number) => new Date(ms).toISOString();

// ── FIX6-1 response == access_state(), fresh-verdict path ───────────────────

Deno.test(
  "FIX6-1: fresh-verdict path — the verdict LANDS (not superseded) but its expires_at has passed by the time the row is answered → billing.premium=false, access.premium=false, == access_state() and GET /v1/me/access, even though the stored flag is premium=true",
  async () => {
    const sim = await simulate();
    try {
      // RevenueCat: active, but the entitlement lapses 80 ms from now. The
      // durable write is slow (200 ms), so the verdict lands — as the ONLY
      // write, on the fresh path — with an expires_at already in the past.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(isoAt(Date.now() + 80)),
        times: 1,
      });
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        delayMs: 200,
        times: 1,
      });
      // What access_state() computes for that row at answer time: the flag is
      // true, expires_at < now() → false.
      sim.h.rpcs["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];

      const res = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.61" }),
      );
      assertEquals(res.status, 200);
      const body = (await res.json()) as SyncBody;

      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assert(stored, "the verdict landed");
      assertEquals(stored.premium, true, "stored flag is the verdict's");
      assert(Date.parse(String(stored.expires_at)) < Date.now(), "…and its expires_at has passed");
      assertEquals(sim.entitlementWrites.length, 1, "exactly the fresh verdict was written");
      assertEquals(
        sim.h.callsTo(ENTITLEMENTS_URL).filter((c) => c.method === "GET").length,
        0,
        "fresh path: the row was answered from RETURNING, never re-read",
      );

      assertEquals(dbPremium(stored), false, "access_state() predicate for the stored row");
      assertEquals(
        body.billing.premium,
        dbPremium(stored),
        `observed billing.premium=${body.billing.premium} for a landed row whose expires_at ` +
          `(${String(stored.expires_at)}) has passed; expected the access_state() predicate → false`,
      );
      assertEquals(body.access.premium, false, "access.premium follows the same rule");
      assertEquals(body.access.entitlements, [], "no entitlement is reported as active");
      assertEquals(body.access.paywallRequired, false, "two free ratings remain; not premium");
      assertEquals(
        body.billing.expiresAt,
        stored.expires_at,
        "the row is still reported faithfully",
      );

      sim.h.rpcs["access_state"] = accessRowFor(stored);
      const me = await sim.h.handler(userRequest("GET", "/v1/me/access", { ip: "198.51.100.62" }));
      assertEquals(me.status, 200);
      const meBody = (await me.json()) as { premium: boolean };
      assertEquals(body.access.premium, meBody.premium, "sync and GET /v1/me/access agree");
    } finally {
      sim.restore();
    }
  },
);

// ── FIX6-1 response == access_state(), re-read path ─────────────────────────

Deno.test(
  "FIX6-1: re-read path — the sync's verdict is dropped as stale and the stored row (premium=true, expires_at in the past, verified on a RevenueCat clock 60 s ahead — inside the trusted skew) is answered with the access_state() predicate → false, == GET /v1/me/access",
  async () => {
    const sim = await simulate();
    try {
      // A RENEWAL webhook lands a premium row whose entitlement expires 100 ms
      // from now, stamped by RevenueCat 60 s ahead of our clock (a real skew
      // the window tolerates — the timestamp is trusted as-is).
      const rcAhead = Date.now() + 60_000;
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(isoAt(Date.now() + 100)),
        requestDateMs: rcAhead,
        times: 1,
      });
      const hook = await sim.h.handler(
        webhookRequest({ id: "fix6-reread-seed", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await hook.json(), { received: true, verified: true });
      const seeded = sim.entitlementRows.get(TEST_USER_ID);
      assert(seeded);
      assertEquals(Date.parse(String(seeded.verified_at)), rcAhead, "60 s ahead is trusted");
      await sleep(120);

      // The user's sync is evaluated NOW (older than the stored key) with the
      // same still-premium subscriber → dropped by the monotonic trigger, row
      // re-read: premium=true, expires_at in the past.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        times: 1,
      });
      sim.h.rpcs["access_state"] = accessRowFor(seeded);
      const res = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.63" }),
      );
      assertEquals(res.status, 200);
      const body = (await res.json()) as SyncBody;

      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assert(stored);
      assertEquals(sim.entitlementWrites.length, 1, "the sync's verdict was dropped as stale");
      assertEquals(stored.premium, true);
      assert(Date.parse(String(stored.expires_at)) < Date.now());
      assertEquals(
        sim.h.callsTo(ENTITLEMENTS_URL).filter((c) => c.method === "GET").length,
        1,
        "re-read path: the stored row was fetched once",
      );

      assertEquals(dbPremium(stored), false);
      assertEquals(body.billing.premium, false, "re-read row answered with the DB predicate");
      assertEquals(body.access.premium, false);
      assertEquals(body.access.entitlements, []);
      assertEquals(body.billing.verifiedAt, isoAt(rcAhead), "the stored row is what is reported");

      const me = await sim.h.handler(userRequest("GET", "/v1/me/access", { ip: "198.51.100.64" }));
      const meBody = (await me.json()) as { premium: boolean };
      assertEquals(body.access.premium, meBody.premium, "sync and GET /v1/me/access agree");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "FIX6-1: the effective-premium rule keeps a lifetime row (expires_at NULL) and an unexpired row premium on both paths — the fix narrows nothing that access_state() grants",
  async () => {
    const sim = await simulate();
    try {
      // Fresh path, lifetime entitlement.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(null, "pickle_sensei_pro_lifetime"),
        times: 1,
      });
      sim.h.rpcs["access_state"] = [{ premium: true, scored_count: 0, reserved_count: 0 }];
      const fresh = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.65" }),
      );
      assertEquals(fresh.status, 200);
      const freshBody = (await fresh.json()) as SyncBody;
      assertEquals(freshBody.billing.premium, true);
      assertEquals(freshBody.billing.expiresAt, null);
      assertEquals(freshBody.access.premium, true);
      assertEquals(freshBody.access.entitlements, ["premium", "pickle_sensei_pro"]);

      // Re-read path: a newer unexpired verdict is already stored; the sync
      // evaluated earlier is dropped and the stored (premium, unexpired) row
      // is answered premium.
      const later = Date.now() + 30_000;
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: later,
        times: 1,
      });
      const hook = await sim.h.handler(
        webhookRequest({ id: "fix6-lifetime-newer", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await hook.json(), { received: true, verified: true });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        times: 1,
      });
      const reread = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.66" }),
      );
      assertEquals(reread.status, 200);
      const rereadBody = (await reread.json()) as SyncBody;
      assertEquals(sim.entitlementWrites.length, 2, "the older expired verdict was dropped");
      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(dbPremium(stored), true);
      assertEquals(rereadBody.billing.premium, true);
      assertEquals(rereadBody.access.premium, true);
      assertEquals(rereadBody.billing.verifiedAt, isoAt(later));
    } finally {
      sim.restore();
    }
  },
);

// ── FIX6-2 request_date_ms window: ahead ────────────────────────────────────

Deno.test(
  "FIX6-2: request_date_ms up to REVENUECAT_CLOCK_MAX_AHEAD_MS ahead of the pre-request clock is trusted as verified_at; one beyond it falls back to the pre-request clock",
  async () => {
    const sim = await simulate();
    try {
      // 4 min ahead of a clock read BEFORE the handler ran: inside the window
      // whatever the handler's own pre-request read was (it is ≥ ours).
      const inside = Date.now() + REVENUECAT_CLOCK_MAX_AHEAD_MS - 60_000;
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: inside,
        times: 1,
      });
      const a = await sim.h.handler(
        webhookRequest({ id: "fix6-ahead-inside", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await a.json(), { received: true, verified: true });
      assertEquals(
        Date.parse(String(sim.entitlementRows.get(TEST_USER_ID)?.verified_at)),
        inside,
        "a plausibly skewed RevenueCat clock stays the monotonic key",
      );

      // 6 min ahead of a clock read AFTER the previous round trip: outside the
      // window whatever the handler's pre-request read is (it is ≤ ours + ε).
      const before = Date.now();
      const outside = before + REVENUECAT_CLOCK_MAX_AHEAD_MS + 60_000;
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        requestDateMs: outside,
        times: 1,
      });
      const b = await sim.h.handler(
        webhookRequest({ id: "fix6-ahead-outside", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      const after = Date.now();
      assertEquals(await b.json(), { received: true, verified: true });
      // The fallback (now) is OLDER than the trusted 4-min-ahead key already
      // stored, so this verdict is dropped as stale — the row is unchanged and
      // no far-future key was written.
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      assertEquals(
        Date.parse(String(row.verified_at)),
        inside,
        "the 6-min-ahead value never landed",
      );
      assertEquals(sim.entitlementWrites.length, 1);
      assert(before <= after);

      // Direct pin of the fallback: a fresh user, far-future clock → verified_at
      // is the pre-request local clock, inside [before, after].
      const OTHER = "22222222-2222-4222-8222-222222222222";
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(OTHER),
        subscriber: activeSubscriber(),
        requestDateMs: Date.now() + 365 * 86_400_000,
        delayMs: 60,
        times: 1,
      });
      const t0 = Date.now();
      const c = await sim.h.handler(
        webhookRequest({ id: "fix6-ahead-fresh", type: "RENEWAL", app_user_id: OTHER }),
      );
      const t1 = Date.now();
      assertEquals(await c.json(), { received: true, verified: true });
      const other = sim.entitlementRows.get(OTHER);
      assert(other);
      const stamped = Date.parse(String(other.verified_at));
      assert(stamped >= t0, `not earlier than the request (${stamped} < ${t0})`);
      assert(
        stamped < t1 - 50,
        `read BEFORE the 60 ms round trip, exactly like the absent-field fallback (${stamped} vs ${t1})`,
      );
    } finally {
      sim.restore();
    }
  },
);

// ── FIX6-2 request_date_ms window: behind ───────────────────────────────────

Deno.test(
  "FIX6-2: request_date_ms up to REVENUECAT_CLOCK_MAX_BEHIND_MS behind the pre-request clock is trusted (so a genuinely older verdict still loses to the newer stored truth); one older than that falls back to the pre-request clock and the fresh truth lands",
  async () => {
    const sim = await simulate();
    try {
      // Stored truth: premium, verified 10 min ago on RevenueCat's clock.
      const storedAt = Date.now() - 10 * 60_000;
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: storedAt,
        times: 1,
      });
      const seed = await sim.h.handler(
        webhookRequest({ id: "fix6-behind-seed", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await seed.json(), { received: true, verified: true });
      assertEquals(
        Date.parse(String(sim.entitlementRows.get(TEST_USER_ID)?.verified_at)),
        storedAt,
      );

      // (a) 1 h behind — inside the window: RevenueCat's clock is trusted, so
      // this EXPIRATION is correctly ordered BEFORE the stored 10-min-old
      // verdict and dropped as stale. Falling back here would have let an
      // older verdict overwrite newer truth.
      const oneHourAgo = Date.now() - 60 * 60_000;
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        requestDateMs: oneHourAgo,
        times: 1,
      });
      const a = await sim.h.handler(
        webhookRequest({ id: "fix6-behind-inside", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await a.json(), { received: true, verified: true });
      let row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, true, "the genuinely older verdict lost to the stored newer one");
      assertEquals(Date.parse(String(row?.verified_at)), storedAt);
      assertEquals(sim.entitlementWrites.length, 1);

      // (b) 25 h behind — outside the window: no live clock produced this for
      // the evaluation RevenueCat just performed. The verdict falls back to
      // the pre-request clock (now, newer than the stored key) and the
      // freshly fetched truth lands instead of being dropped.
      const before = Date.now();
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        requestDateMs: before - REVENUECAT_CLOCK_MAX_BEHIND_MS - 60 * 60_000,
        times: 1,
      });
      const b = await sim.h.handler(
        webhookRequest({
          id: "fix6-behind-outside",
          type: "EXPIRATION",
          app_user_id: TEST_USER_ID,
        }),
      );
      const after = Date.now();
      assertEquals(await b.json(), { received: true, verified: true });
      row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      assertEquals(row.premium, false, "the expiration landed");
      const stamped = Date.parse(String(row.verified_at));
      assert(
        stamped >= before && stamped <= after,
        `verified_at fell back to the pre-request clock (${stamped} ∉ [${before}, ${after}])`,
      );
      assertEquals(sim.entitlementWrites.length, 2);

      // Why the fallback cannot make a stale verdict win: it is the clock read
      // BEFORE the round trip, so a verdict evaluated after this request began
      // (here: a RENEWAL with a sane request_date_ms) still outranks it.
      const renewedAt = Date.now() + 1;
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: renewedAt,
        times: 1,
      });
      const c = await sim.h.handler(
        webhookRequest({ id: "fix6-behind-then-sane", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await c.json(), { received: true, verified: true });
      row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, true);
      assertEquals(Date.parse(String(row?.verified_at)), renewedAt);
      assertEquals(sim.entitlementWrites.length, 3);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "FIX6-2: the absent / NaN / ≤0 / > MAX_EPOCH_MS fallbacks are unchanged and land on the pre-request clock, and POST /v1/billing/sync reports that clock as verifiedAt",
  async () => {
    const sim = await simulate();
    try {
      const cases: Array<number | null> = [
        null,
        Number.NaN,
        0,
        -1,
        8.64e15 + 1,
        Number.POSITIVE_INFINITY,
      ];
      for (const [i, requestDateMs] of cases.entries()) {
        const user = `3333333${i}-3333-4333-8333-333333333333`;
        sim.faults.push({
          match: (m, u) => m === "GET" && u === rcFor(user),
          subscriber: activeSubscriber(),
          requestDateMs,
          times: 1,
        });
        const before = Date.now();
        const res = await sim.h.handler(
          webhookRequest({ id: `fix6-fallback-${i}`, type: "RENEWAL", app_user_id: user }),
        );
        const after = Date.now();
        assertEquals(await res.json(), { received: true, verified: true });
        const row = sim.entitlementRows.get(user);
        assert(row, `case ${String(requestDateMs)}: row landed`);
        const stamped = Date.parse(String(row.verified_at));
        assert(
          stamped >= before && stamped <= after,
          `case ${String(requestDateMs)}: verified_at=${stamped} ∉ [${before}, ${after}]`,
        );
      }

      // The sync route surfaces the same fallback in its body.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: Date.now() + 10 * 365 * 86_400_000,
        times: 1,
      });
      sim.h.rpcs["access_state"] = [{ premium: true, scored_count: 0, reserved_count: 0 }];
      const before = Date.now();
      const sync = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.67" }),
      );
      const after = Date.now();
      assertEquals(sync.status, 200);
      const body = (await sync.json()) as SyncBody;
      const stamped = Date.parse(body.billing.verifiedAt);
      assert(stamped >= before && stamped <= after, `sync verifiedAt=${body.billing.verifiedAt}`);
      assertEquals(body.billing.premium, true);
      assertEquals(
        body.billing.verifiedAt,
        String(sim.entitlementRows.get(TEST_USER_ID)?.verified_at),
        "response == stored row",
      );
    } finally {
      sim.restore();
    }
  },
);
