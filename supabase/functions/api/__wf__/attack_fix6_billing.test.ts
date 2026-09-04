// ADVERSARIAL suite for fix round 6, area `billing-webhook`.
//
// Attacks the candidate `devin/fix6-billing` @ 34f06999 (stack 1fb0efd7 →
// bcfaf2c2 → 34f06999): the bounded RevenueCat clock window
// (`revenueCatRequestDate`: > +5 min ahead or > 24 h behind the pre-request
// clock → local fallback) and `effectivePremium()` on both sync paths. The two
// ATK5 findings (raw premium flag on the re-read path, unbounded far-future
// request_date_ms) are NOT re-filed here.
//
// Every test states the contract it attacks. A test whose name starts with
// "ATK6-BREAK" is EXPECTED TO FAIL on the candidate and documents a real
// defect (observed vs expected in the assertion message). "ATK6-LIMIT" tests
// pin a behaviour the candidate's contract explicitly accepts (bounded wedge
// windows) so a later change to those bounds is deliberate. Everything else
// held on the candidate and stays as a regression pin.
//
// Result on 34f06999: no ATK6-BREAK — all 20 attacks hold (17 sim + 3 real
// Postgres). POST /v1/billing/sync is budgeted 10/user/min, so every sync
// scenario runs as its own signed-in user (`freshUser()`).
//
// Planes: the real Edge handler (index.ts, never mocked) over webhookSim.ts
// (stateful PostgREST + RevenueCat with faults and the monotonic-verified_at
// trigger), plus a REAL disposable Postgres section (XC_PG_URL, see
// xc_pg_up.sh) for the trigger, the access_state() predicate and the RLS
// matrix — ignored (NOT passed) when XC_PG_URL is unset.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_fix6_billing.test.ts

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  activeSubscriber,
  fakeGoogleIdToken,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  WEBHOOK_SECRET,
  webhookRequest,
} from "./routesHarness.ts";
import {
  dbUnavailable,
  ENTITLEMENTS_URL,
  EVENTS_URL,
  expiredSubscriber,
  type Fault,
  type Row,
  type Sim,
  simulate,
  sleep,
} from "./webhookSim.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AHEAD_MAX_MS = 5 * MINUTE;
const BEHIND_MAX_MS = 24 * HOUR;

const rcFor = (userId: string) => `${RC_URL}${encodeURIComponent(userId)}`;

const drain = async (responses: Response[]) =>
  await Promise.all(
    responses.map(async (r) => ({
      status: r.status,
      retryAfter: r.headers.get("Retry-After"),
      body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    })),
  );

type AccessBody = {
  premium: boolean;
  entitlements: string[];
  freeRatings: {
    limit: number;
    used: number;
    reserved: number;
    remaining: number;
    availableToReserve: number;
  };
  canStartRating: boolean;
  paywallRequired: boolean;
};

type SyncBody = {
  billing: {
    premium: boolean;
    productKey: string | null;
    expiresAt: string | null;
    verifiedAt: string;
  };
  access: AccessBody;
};

/** `public.access_state()`'s premium predicate over a billing_entitlements
 * row: premium AND (expires_at IS NULL OR expires_at > now()). */
const dbPremium = (row: Row | undefined, nowMs = Date.now()): boolean => {
  if (!row) return false;
  const exp = row.expires_at;
  return (
    row.premium === true && (exp === null || exp === undefined || Date.parse(String(exp)) > nowMs)
  );
};

/** Install `access_state` as a LIVE view over the sim's rows — evaluated at
 * RPC time, exactly like SQL reads the row at statement time — with the
 * given ledger counters. */
function liveAccessState(sim: Sim, user: string, counters: { scored: number; reserved: number }) {
  Object.defineProperty(sim.h.rpcs, "access_state", {
    configurable: true,
    enumerable: true,
    get: () => [
      {
        premium: dbPremium(sim.entitlementRows.get(user)),
        scored_count: counters.scored,
        reserved_count: counters.reserved,
      },
    ],
  });
}

/** POST /v1/billing/sync has a per-user budget of 10/min (ROUTE_LIMITS); every
 * sync scenario runs as its own signed-in user so the budget is never the
 * thing under test. */
let userSeq = 0;
const freshUser = (): string => `a6a6a6a6-0000-4000-8000-${String(++userSeq).padStart(12, "0")}`;
const syncAs = (user: string, ip: string) =>
  userRequest("POST", "/v1/billing/sync", { token: fakeGoogleIdToken(user), ip });
const accessAs = (user: string, ip: string) =>
  userRequest("GET", "/v1/me/access", { token: fakeGoogleIdToken(user), ip });

/** A RevenueCat answer for `user`. `requestDateAtArrival` is evaluated when
 * the request REACHES RevenueCat (≥ the handler's pre-request clock), so a
 * boundary can be placed relative to the handler's own `startedAtMs`. */
function rcAnswer(
  user: string,
  subscriber: Record<string, unknown>,
  options: {
    requestDateMs?: number | null;
    requestDateAtArrival?: (arrivalMs: number) => number;
    delayMs?: number;
    times?: number;
  } = {},
): Fault {
  const fault: Fault = {
    match: (m, u) => {
      if (m !== "GET" || u !== rcFor(user)) return false;
      if (options.requestDateAtArrival) {
        fault.requestDateMs = options.requestDateAtArrival(Date.now());
      }
      return true;
    },
    subscriber,
    times: options.times ?? 1,
  };
  if (options.requestDateMs !== undefined) fault.requestDateMs = options.requestDateMs;
  if (options.delayMs) fault.delayMs = options.delayMs;
  return fault;
}

const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) Deno.env.delete(k);
  }
};

/** Run `fn` on an "isolate" whose wall clock is `offsetMs` off ours. Only
 * Date.now() is shifted (that is what the handler's pre-request clock,
 * effectivePremium and the sim's RevenueCat stamp read). */
const onIsolateWithClock = async <T>(offsetMs: number, fn: () => Promise<T>): Promise<T> => {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
};

const genericOnly = (body: Record<string, unknown>, ...forbidden: string[]) => {
  const text = JSON.stringify(body);
  for (const needle of forbidden) {
    assert(!text.includes(needle), `5xx body leaked "${needle}": ${text}`);
  }
  const error = body.error as Record<string, unknown> | undefined;
  assert(error && typeof error.message === "string", `error.message present: ${text}`);
  assertEquals(Object.keys(body), ["error"]);
};

// ── 1. The bounded clock window (what fix 6 introduced) ─────────────────────

Deno.test(
  "ATK6-1: window edges — RC exactly 24 h behind and exactly 5 min ahead of the pre-request clock are TRUSTED (verified_at == request_date_ms); 24 h + 1 s behind and 5 min + 1 ms ahead FALL BACK to the pre-request clock",
  async () => {
    const sim = await simulate();
    try {
      const cases: Array<{
        id: string;
        trusted: boolean;
        fault: Fault;
      }> = [
        {
          id: "atk6-behind-24h-exact",
          trusted: true,
          // arrival ≥ startedAtMs ⇒ raw ≥ startedAtMs − 24 h: inside the window
          fault: rcAnswer(TEST_USER_ID, activeSubscriber(), {
            requestDateAtArrival: (arrival) => arrival - BEHIND_MAX_MS,
          }),
        },
        {
          id: "atk6-behind-24h-plus-1s",
          trusted: false,
          fault: rcAnswer(TEST_USER_ID, activeSubscriber(), {
            requestDateMs: Date.now() - BEHIND_MAX_MS - 1_000,
          }),
        },
        {
          id: "atk6-ahead-5m-exact",
          trusted: true,
          // pre-handler clock ≤ startedAtMs ⇒ raw ≤ startedAtMs + 5 min: inside
          fault: rcAnswer(TEST_USER_ID, activeSubscriber(), {
            requestDateMs: Date.now() + AHEAD_MAX_MS,
          }),
        },
        {
          id: "atk6-ahead-5m-plus-1ms",
          trusted: false,
          // arrival ≥ startedAtMs ⇒ raw ≥ startedAtMs + 5 min + 1 ms: outside
          fault: rcAnswer(TEST_USER_ID, activeSubscriber(), {
            requestDateAtArrival: (arrival) => arrival + AHEAD_MAX_MS + 1,
          }),
        },
      ];
      for (const c of cases) {
        // fresh row per case so the monotonic trigger never masks the stamp
        sim.entitlementRows.delete(TEST_USER_ID);
        sim.faults.push(c.fault);
        const before = Date.now();
        const res = await sim.h.handler(
          webhookRequest({ id: c.id, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        const after = Date.now();
        assertEquals(await res.json(), { received: true, verified: true }, c.id);
        const row = sim.entitlementRows.get(TEST_USER_ID);
        assert(row, `${c.id}: row landed`);
        const stamped = Date.parse(String(row.verified_at));
        const raw = c.fault.requestDateMs as number;
        if (c.trusted) {
          assertEquals(stamped, raw, `${c.id}: trusted RC clock is the key`);
        } else {
          assertNotEquals(stamped, raw, `${c.id}: out-of-window RC clock must not be the key`);
          assert(
            stamped >= before && stamped <= after,
            `${c.id}: fallback ∈ [${before}, ${after}], got ${stamped}`,
          );
        }
      }
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-2: RC 24 h + 1 s behind on W1 (fallback) vs a correctly stamped W2 — the fallback key never outranks a verdict evaluated after W1 began, and a W1 that began AFTER W2's evaluation legitimately supersedes it",
  async () => {
    const sim = await simulate();
    try {
      // (a) W1 EXPIRATION begins first, RC answers slowly with a bogus
      // 24 h + 1 s-behind stamp; W2 RENEWAL begins 30 ms later with a correct
      // stamp, evaluated and landed while W1 is still in flight. W1's
      // fallback (its pre-request clock) predates W2's evaluation → dropped.
      const bogusBehind = Date.now() - BEHIND_MAX_MS - 1_000;
      sim.faults.push(
        rcAnswer(TEST_USER_ID, expiredSubscriber(), {
          requestDateMs: bogusBehind,
          delayMs: 200,
        }),
      );
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber()));
      const w1 = sim.h.handler(
        webhookRequest({
          id: "atk6-w1-bogus-behind",
          type: "EXPIRATION",
          app_user_id: TEST_USER_ID,
        }),
      );
      await sleep(30);
      const w2 = sim.h.handler(
        webhookRequest({ id: "atk6-w2-correct", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      const [r1, r2] = await drain([await w1, await w2]);
      assertEquals(r1.body, { received: true, verified: true });
      assertEquals(r2.body, { received: true, verified: true });
      let row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      assertEquals(row.premium, true, "W2 (evaluated after W1 began) is the row");
      assertEquals(sim.entitlementWrites.length, 1, "W1's fallback verdict dropped");

      // (b) W1' EXPIRATION begins 1 s after W2 landed, again with the bogus
      // stamp → fallback = its own pre-request clock, which is genuinely
      // later than W2's evaluation → it supersedes W2 (RevenueCat DID
      // evaluate it later; only its clock is broken).
      await sleep(1_000);
      sim.faults.push(
        rcAnswer(TEST_USER_ID, expiredSubscriber(), {
          requestDateMs: Date.now() - BEHIND_MAX_MS - 1_000,
        }),
      );
      const before = Date.now();
      const w1b = await sim.h.handler(
        webhookRequest({
          id: "atk6-w1b-bogus-behind",
          type: "EXPIRATION",
          app_user_id: TEST_USER_ID,
        }),
      );
      const after = Date.now();
      assertEquals(await w1b.json(), { received: true, verified: true });
      row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      assertEquals(row.premium, false, "later evaluation with a broken RC clock still lands");
      const stamped = Date.parse(String(row.verified_at));
      assert(stamped >= before && stamped <= after, `fallback ∈ [${before}, ${after}]`);
      assertEquals(sim.entitlementWrites.length, 2);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-LIMIT-3: mixed clocks — a verdict keyed by a TRUSTED RC clock 5 min ahead fences a later EXPIRATION whose RC answer carries no request_date_ms (local fallback) for up to the 5-min tolerance; the contract accepts this bounded wedge, and a stamped EXPIRATION at/after the key lands",
  async () => {
    const sim = await simulate();
    try {
      // RENEWAL: RC clock exactly +5 min (trusted, contract) → key = now + 5 min.
      const preHandler = Date.now();
      const aheadKey = preHandler + AHEAD_MAX_MS;
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber(), { requestDateMs: aheadKey }));
      const renewal = await sim.h.handler(
        webhookRequest({ id: "atk6-mixed-renewal", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await renewal.json(), { received: true, verified: true });
      assertEquals(
        Date.parse(String(sim.entitlementRows.get(TEST_USER_ID)?.verified_at)),
        aheadKey,
      );

      // EXPIRATION 20 ms later: RC answer without request_date_ms → fallback
      // = now, which is 5 min BEHIND the stored key → dropped (documented).
      await sleep(20);
      sim.faults.push(rcAnswer(TEST_USER_ID, expiredSubscriber(), { requestDateMs: null }));
      const expiration = await sim.h.handler(
        webhookRequest({
          id: "atk6-mixed-expiration",
          type: "EXPIRATION",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(await expiration.json(), { received: true, verified: true });
      const wedged = sim.entitlementRows.get(TEST_USER_ID);
      assert(wedged);
      assertEquals(
        wedged.premium,
        true,
        "LIMIT: a newer EXPIRATION that fell back to the local clock is fenced by a trusted +5 min key (bounded by REVENUECAT_CLOCK_MAX_AHEAD_MS)",
      );
      assertEquals(sim.entitlementWrites.length, 1);

      // The same EXPIRATION stamped by RC at the stored key (equal passes) lands.
      sim.faults.push(rcAnswer(TEST_USER_ID, expiredSubscriber(), { requestDateMs: aheadKey }));
      const stamped = await sim.h.handler(
        webhookRequest({
          id: "atk6-mixed-expiration-2",
          type: "EXPIRATION",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(await stamped.json(), { received: true, verified: true });
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false);
      assertEquals(sim.entitlementWrites.length, 2);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-LIMIT-4: two isolates whose local clocks are 30 s apart, both falling back (RC omits request_date_ms) — the isolate whose clock runs ahead keys its OLDER verdict above the other's newer one (contract: fallback = pre-request local clock); with RC stamps present the ordering is exact regardless of local clocks",
  async () => {
    const sim = await simulate();
    try {
      // Isolate A (clock +30 s) handles EXPIRATION first; isolate B (true
      // clock) handles RENEWAL 50 ms later. Both RC answers lack a stamp.
      sim.faults.push(rcAnswer(TEST_USER_ID, expiredSubscriber(), { requestDateMs: null }));
      const a = await onIsolateWithClock(30_000, () =>
        sim.h.handler(
          webhookRequest({ id: "atk6-iso-a", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
        ),
      );
      assertEquals(await a.json(), { received: true, verified: true });
      await sleep(50);
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber(), { requestDateMs: null }));
      const b = await sim.h.handler(
        webhookRequest({ id: "atk6-iso-b", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await b.json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      assertEquals(
        row.premium,
        false,
        "LIMIT: without RC stamps, cross-isolate ordering is only as good as the isolates' clocks (B's newer RENEWAL lost to A's +30 s key)",
      );
      assertEquals(sim.entitlementWrites.length, 1);

      // With RC stamps the local clocks are irrelevant: A (+30 s) EXPIRATION
      // stamped t, B RENEWAL stamped t + 1 → RENEWAL wins even though A's
      // local clock says its verdict is 30 s newer.
      sim.entitlementRows.delete(TEST_USER_ID);
      const t = Date.now() + 40_000; // above the wedge left by the first half
      sim.faults.push(rcAnswer(TEST_USER_ID, expiredSubscriber(), { requestDateMs: t }));
      const a2 = await onIsolateWithClock(30_000, () =>
        sim.h.handler(
          webhookRequest({ id: "atk6-iso-a2", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
        ),
      );
      assertEquals(await a2.json(), { received: true, verified: true });
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber(), { requestDateMs: t + 1 }));
      const b2 = await sim.h.handler(
        webhookRequest({ id: "atk6-iso-b2", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await b2.json(), { received: true, verified: true });
      const final = sim.entitlementRows.get(TEST_USER_ID);
      assert(final);
      assertEquals(final.premium, true);
      assertEquals(Date.parse(String(final.verified_at)), t + 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-5: EXPIRATION then RENEWAL evaluated 1 ms apart, BOTH falling back to local clocks, EXPIRATION answer landing last → RENEWAL (later pre-request clock) is the row, both 200",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push(
        rcAnswer(TEST_USER_ID, expiredSubscriber(), { requestDateMs: null, delayMs: 150 }),
      );
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber(), { requestDateMs: null }));
      const expiration = sim.h.handler(
        webhookRequest({ id: "atk6-fb-exp", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      await sleep(5);
      const renewal = sim.h.handler(
        webhookRequest({ id: "atk6-fb-ren", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      const [e, r] = await drain([await expiration, await renewal]);
      assertEquals(e.body, { received: true, verified: true });
      assertEquals(r.body, { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      assertEquals(row.premium, true, "RENEWAL began later → later fallback key → wins");
      assertEquals(sim.entitlementWrites.length, 1, "EXPIRATION's older fallback dropped");
    } finally {
      sim.restore();
    }
  },
);

// ── 2. effectivePremium boundaries (fresh + re-read paths) ──────────────────

/** A billing_entitlements row as PostgREST serialises it (µs timestamptz). */
const pgRow = (
  premium: boolean,
  expiresAt: string | null,
  verifiedAt: string,
  userId = TEST_USER_ID,
): Row => ({
  user_id: userId,
  premium,
  product_key: "pickle_sensei_pro_monthly",
  expires_at: expiresAt,
  verified_at: verifiedAt,
});

const pgTimestamp = (ms: number, micros = 0): string => {
  const iso = new Date(ms).toISOString(); // 2026-…T…:SS.mmmZ
  return `${iso.slice(0, -1)}${String(micros).padStart(3, "0")}+00:00`;
};

Deno.test(
  "ATK6-6: re-read path over PostgREST-shaped rows — expires_at exactly now (µs), 1 ms past, 1 h ahead, NULL+premium, NULL+not-premium: sync billing.premium == access.premium == access_state() predicate == GET /v1/me/access, and the row is reported verbatim",
  async () => {
    const sim = await simulate();
    try {
      const farFuture = pgTimestamp(Date.now() + HOUR, 250); // outranks every sync verdict
      const cases: Array<{ label: string; row: Row; premium: boolean }> = [
        {
          label: "expires_at = now (+500 µs, truncated to now by JS)",
          row: pgRow(true, pgTimestamp(Date.now(), 500), farFuture),
          premium: false,
        },
        {
          label: "expires_at 1 ms in the past",
          row: pgRow(true, pgTimestamp(Date.now() - 1), farFuture),
          premium: false,
        },
        {
          label: "expires_at 1 h ahead",
          row: pgRow(true, pgTimestamp(Date.now() + HOUR, 999), farFuture),
          premium: true,
        },
        { label: "lifetime: premium + NULL", row: pgRow(true, null, farFuture), premium: true },
        { label: "not premium + NULL", row: pgRow(false, null, farFuture), premium: false },
        {
          label: "not premium + future expires_at",
          row: pgRow(false, pgTimestamp(Date.now() + HOUR), farFuture),
          premium: false,
        },
      ];
      for (const c of cases) {
        const user = freshUser();
        c.row.user_id = user;
        liveAccessState(sim, user, { scored: 2, reserved: 0 });
        sim.entitlementRows.set(user, { ...c.row });
        // The sync's own RC verdict says ACTIVE (a fresh purchase) but is stamped
        // now, i.e. older than the stored row → dropped → re-read path.
        sim.faults.push(rcAnswer(user, activeSubscriber()));
        const res = await sim.h.handler(syncAs(user, "198.51.100.71"));
        assertEquals(res.status, 200, c.label);
        const body = (await res.json()) as SyncBody;
        assertEquals(body.billing.premium, c.premium, `${c.label}: billing.premium`);
        assertEquals(body.access.premium, c.premium, `${c.label}: access.premium`);
        assertEquals(
          body.billing.verifiedAt,
          new Date(Date.parse(farFuture)).toISOString(),
          c.label,
        );
        assertEquals(
          body.billing.expiresAt,
          c.row.expires_at === null
            ? null
            : new Date(Date.parse(String(c.row.expires_at))).toISOString(),
          `${c.label}: expiresAt reported from the stored row`,
        );
        const me = await sim.h.handler(accessAs(user, "198.51.100.72"));
        const meBody = (await me.json()) as AccessBody;
        assertEquals(meBody, body.access, `${c.label}: GET /v1/me/access == sync.access`);
        assertEquals(sim.entitlementRows.get(user), c.row, `${c.label}: stored row untouched`);
      }
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-7: fresh path with one free rating left — RC verdict ACTIVE, the durable write is slow and the entitlement lapses before the row is answered: billing.premium=false, entitlements=[], freeRatings/canStart/paywall computed as NOT premium, GET /v1/me/access identical field by field",
  async () => {
    const sim = await simulate();
    try {
      const user = freshUser();
      liveAccessState(sim, user, { scored: 1, reserved: 0 });
      // active for 60 ms after evaluation; the durable write takes 120 ms
      sim.faults.push(rcAnswer(user, activeSubscriber(new Date(Date.now() + 60).toISOString())));
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        delayMs: 120,
      });
      const res = await sim.h.handler(syncAs(user, "198.51.100.73"));
      assertEquals(res.status, 200);
      const body = (await res.json()) as SyncBody;
      const row = sim.entitlementRows.get(user);
      assert(row);
      assertEquals(row.premium, true, "RC's verdict at evaluation time is what is stored");
      assertEquals(body.billing.premium, false);
      assertEquals(body.access.premium, false);
      assertEquals(body.access.entitlements, []);
      assertEquals(body.billing.productKey, "pickle_sensei_pro_monthly");
      assertEquals(body.billing.expiresAt, row.expires_at);
      assertEquals(body.access.freeRatings, {
        limit: 2,
        used: 1,
        reserved: 0,
        remaining: 1,
        availableToReserve: 1,
      });
      assertEquals(body.access.canStartRating, true);
      assertEquals(body.access.paywallRequired, false);
      const me = await sim.h.handler(accessAs(user, "198.51.100.74"));
      assertEquals((await me.json()) as AccessBody, body.access);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-8: lifetime + a later EXPIRATION for a DIFFERENT product — RC still lists the lifetime entitlement (expires_date null) beside the expired monthly one → premium stays true with expiresAt null; legacy alias `premium` lifetime beside an expired pickle_sensei_pro also grants",
  async () => {
    const sim = await simulate();
    try {
      const user = freshUser();
      // sync lands lifetime
      sim.faults.push(rcAnswer(user, activeSubscriber(null, "pickle_sensei_pro_lifetime")));
      liveAccessState(sim, user, { scored: 5, reserved: 3 });
      const sync = await sim.h.handler(syncAs(user, "198.51.100.75"));
      const synced = (await sync.json()) as SyncBody;
      assertEquals(synced.billing, {
        premium: true,
        productKey: "pickle_sensei_pro_lifetime",
        expiresAt: null,
        verifiedAt: synced.billing.verifiedAt,
      });
      assertEquals(synced.access.freeRatings, {
        limit: 2,
        used: 2,
        reserved: 0,
        remaining: 0,
        availableToReserve: 0,
      });
      assertEquals(synced.access.canStartRating, true);
      assertEquals(synced.access.paywallRequired, false);

      // EXPIRATION webhook for the (older) monthly product: RC's subscriber
      // keeps the lifetime entitlement active — RC folds entitlements, the
      // event's product is irrelevant.
      await sleep(2);
      sim.faults.push(
        rcAnswer(user, {
          entitlements: {
            pickle_sensei_pro: {
              expires_date: null,
              product_identifier: "pickle_sensei_pro_lifetime",
            },
          },
          subscriptions: {
            pickle_sensei_pro_monthly: { expires_date: new Date(Date.now() - 1000).toISOString() },
          },
        }),
      );
      const hook = await sim.h.handler(
        webhookRequest({
          id: "atk6-lifetime-expiration",
          type: "EXPIRATION",
          app_user_id: user,
          product_id: "pickle_sensei_pro_monthly",
          entitlement_ids: ["pickle_sensei_pro"],
        }),
      );
      assertEquals(await hook.json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(user);
      assert(row);
      assertEquals(row.premium, true);
      assertEquals(row.expires_at, null);
      assertEquals(row.product_key, "pickle_sensei_pro_lifetime");

      // legacy alias: pickle_sensei_pro expired, `premium` lifetime → premium
      await sleep(2);
      sim.faults.push(
        rcAnswer(user, {
          entitlements: {
            pickle_sensei_pro: {
              expires_date: new Date(Date.now() - 1000).toISOString(),
              product_identifier: "pickle_sensei_pro_monthly",
            },
            premium: { expires_date: null, product_identifier: "legacy_lifetime" },
          },
        }),
      );
      const sync2 = await sim.h.handler(syncAs(user, "198.51.100.76"));
      const body2 = (await sync2.json()) as SyncBody;
      assertEquals(body2.billing.premium, true);
      assertEquals(body2.billing.expiresAt, null);
      assertEquals(body2.billing.productKey, "legacy_lifetime");
      assertEquals(body2.access.entitlements, ["premium"]);
      const me = await sim.h.handler(accessAs(user, "198.51.100.77"));
      assertEquals((await me.json()) as AccessBody, body2.access);
    } finally {
      sim.restore();
    }
  },
);

// ── 3. access section vs GET /v1/me/access — every field ────────────────────

Deno.test(
  "ATK6-9: field-by-field parity of sync.access with GET /v1/me/access for expired+exhausted, expired+1 left, expired+reserved, active+ledger 5 (+reserved 4), superseded-by-active, superseded-by-expired",
  async () => {
    const sim = await simulate();
    try {
      const scenarios: Array<{
        label: string;
        seed?: Row;
        subscriber: Record<string, unknown>;
        counters: { scored: number; reserved: number };
        expect: Omit<AccessBody, "entitlements">;
      }> = [
        {
          label: "expired + free exhausted",
          subscriber: expiredSubscriber(),
          counters: { scored: 2, reserved: 0 },
          expect: {
            premium: false,
            freeRatings: { limit: 2, used: 2, reserved: 0, remaining: 0, availableToReserve: 0 },
            canStartRating: false,
            paywallRequired: true,
          },
        },
        {
          label: "expired + 1 free left",
          subscriber: expiredSubscriber(),
          counters: { scored: 1, reserved: 0 },
          expect: {
            premium: false,
            freeRatings: { limit: 2, used: 1, reserved: 0, remaining: 1, availableToReserve: 1 },
            canStartRating: true,
            paywallRequired: false,
          },
        },
        {
          label: "expired + 1 free left but reserved",
          subscriber: expiredSubscriber(),
          counters: { scored: 1, reserved: 1 },
          expect: {
            premium: false,
            freeRatings: { limit: 2, used: 1, reserved: 1, remaining: 1, availableToReserve: 0 },
            canStartRating: false,
            paywallRequired: true,
          },
        },
        {
          label: "active + ledger 5 + reserved 4 (clamped)",
          subscriber: activeSubscriber(),
          counters: { scored: 5, reserved: 4 },
          expect: {
            premium: true,
            freeRatings: { limit: 2, used: 2, reserved: 0, remaining: 0, availableToReserve: 0 },
            canStartRating: true,
            paywallRequired: false,
          },
        },
        {
          label: "superseded by a newer ACTIVE row (sync says expired)",
          seed: pgRow(true, pgTimestamp(Date.now() + HOUR), pgTimestamp(Date.now() + HOUR)),
          subscriber: expiredSubscriber(),
          counters: { scored: 2, reserved: 0 },
          expect: {
            premium: true,
            freeRatings: { limit: 2, used: 2, reserved: 0, remaining: 0, availableToReserve: 0 },
            canStartRating: true,
            paywallRequired: false,
          },
        },
        {
          label: "superseded by a newer EXPIRED row (sync says active)",
          seed: pgRow(true, pgTimestamp(Date.now() - 1), pgTimestamp(Date.now() + HOUR)),
          subscriber: activeSubscriber(),
          counters: { scored: 0, reserved: 0 },
          expect: {
            premium: false,
            freeRatings: { limit: 2, used: 0, reserved: 0, remaining: 2, availableToReserve: 2 },
            canStartRating: true,
            paywallRequired: false,
          },
        },
      ];
      for (const s of scenarios) {
        const user = freshUser();
        if (s.seed) sim.entitlementRows.set(user, { ...s.seed, user_id: user });
        liveAccessState(sim, user, s.counters);
        sim.faults.push(rcAnswer(user, s.subscriber));
        const sync = await sim.h.handler(syncAs(user, "198.51.100.78"));
        assertEquals(sync.status, 200, s.label);
        const body = (await sync.json()) as SyncBody;
        const { entitlements, ...rest } = body.access;
        assertEquals(rest, s.expect, `${s.label}: sync.access`);
        assertEquals(body.billing.premium, body.access.premium, `${s.label}: billing == access`);
        assertEquals(
          entitlements.includes("premium"),
          s.expect.premium,
          `${s.label}: entitlements`,
        );
        assertEquals(
          dbPremium(sim.entitlementRows.get(user)),
          s.expect.premium,
          `${s.label}: DB predicate`,
        );

        const me = await sim.h.handler(accessAs(user, "198.51.100.79"));
        assertEquals(me.status, 200, s.label);
        const meBody = (await me.json()) as AccessBody;
        const { entitlements: meEntitlements, ...meRest } = meBody;
        assertEquals(
          meRest,
          rest,
          `${s.label}: GET /v1/me/access == sync.access (all fields but entitlements)`,
        );
        assertEquals(meEntitlements.includes("premium"), entitlements.includes("premium"), s.label);
        // entitlements: the fresh sync path names the verified identifiers
        // (informational); GET /v1/me/access and the superseded path report
        // the stored row → ["premium"] only. Pinned so a drift is deliberate.
        assertEquals(meEntitlements, s.expect.premium ? ["premium"] : []);
      }
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-10: account deleted mid-sync — (a) row gone between the dropped upsert and the re-read → 503 generic (no user id, no table name), (b) profiles row gone before the upsert (FK 23503) → 503 generic; webhook: (a) → released + 503, (b) → 200 verified:false, audit row processed; never a 500",
  async () => {
    const sim = await simulate();
    try {
      const pgFk = (user: string) => ({
        status: 409,
        body: {
          code: "23503",
          message:
            'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
          details: `Key (user_id)=(${user}) is not present in table "profiles".`,
          hint: null,
        },
      });
      // (a) sync: stored newer row → verdict dropped → re-read finds nothing
      const userA = freshUser();
      sim.entitlementRows.set(
        userA,
        pgRow(true, pgTimestamp(Date.now() + HOUR), pgTimestamp(Date.now() + HOUR), userA),
      );
      liveAccessState(sim, userA, { scored: 0, reserved: 0 });
      sim.faults.push(rcAnswer(userA, activeSubscriber()));
      sim.faults.push({
        match: (m, u) => m === "GET" && u.startsWith(ENTITLEMENTS_URL),
        status: 200,
        body: [],
      });
      const syncA = await sim.h.handler(syncAs(userA, "198.51.100.80"));
      assertEquals(syncA.status, 503);
      genericOnly(
        (await syncA.json()) as Record<string, unknown>,
        userA,
        "billing_entitlements",
        "superseding",
      );

      // (b) sync: FK violation on the upsert
      const userB = freshUser();
      sim.faults.push(rcAnswer(userB, activeSubscriber()));
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        ...pgFk(userB),
      });
      const syncB = await sim.h.handler(syncAs(userB, "198.51.100.81"));
      assertEquals(syncB.status, 503);
      genericOnly(
        (await syncB.json()) as Record<string, unknown>,
        userB,
        "profiles",
        "23503",
        "foreign key",
      );

      // webhook (a): released reservation + 503 (redelivery re-processes)
      sim.entitlementRows.set(
        TEST_USER_ID,
        pgRow(true, pgTimestamp(Date.now() + HOUR), pgTimestamp(Date.now() + HOUR)),
      );
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber()));
      sim.faults.push({
        match: (m, u) => m === "GET" && u.startsWith(ENTITLEMENTS_URL),
        status: 200,
        body: [],
      });
      const hookA = await sim.h.handler(
        webhookRequest({ id: "atk6-del-a", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(hookA.status, 503);
      genericOnly((await hookA.json()) as Record<string, unknown>, TEST_USER_ID, "superseding");
      assertEquals(sim.auditRows.has("atk6-del-a"), false, "reservation released");

      // webhook (b): FK → acknowledged, audit processed
      sim.entitlementRows.delete(TEST_USER_ID);
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber()));
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        ...pgFk(TEST_USER_ID),
      });
      const hookB = await sim.h.handler(
        webhookRequest({ id: "atk6-del-b", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await hookB.json(), { received: true, verified: false });
      assert(sim.auditRows.get("atk6-del-b")?.processed_at, "processed");
      assertEquals(sim.entitlementRows.has(TEST_USER_ID), false);
    } finally {
      sim.restore();
    }
  },
);

// ── 4. Webhook idempotency regressions ──────────────────────────────────────

Deno.test(
  "ATK6-11: 12 concurrent identical deliveries → exactly 1 RC call, 1 audit row, 1 entitlement write, one verified:true and eleven duplicate:true (all 200); a 13th after the fact → duplicate:true with no RC call",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber(), { delayMs: 120 }));
      const event = { id: "atk6-burst", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID };
      const burst = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          sim.h.handler(webhookRequest(event, { ip: `203.0.113.${100 + i}` })),
        ),
      );
      const results = await drain(burst);
      assertEquals(
        results.map((r) => r.status),
        Array(12).fill(200),
      );
      assertEquals(results.filter((r) => r.body.verified === true).length, 1);
      assertEquals(results.filter((r) => r.body.duplicate === true).length, 11);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.auditRows.size, 1);
      assertEquals(sim.entitlementWrites.length, 1);
      const late = await sim.h.handler(webhookRequest(event));
      assertEquals(await late.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-12: owner stalls past the duplicate wait → losers 503 + Retry-After, zero extra RC calls; once the owner finalizes a redelivery is duplicate:true",
  async () => {
    const sim = await simulate();
    try {
      await withEnv(
        { WEBHOOK_DUPLICATE_WAIT_MS: "120", WEBHOOK_DUPLICATE_POLL_MS: "10" },
        async () => {
          sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber(), { delayMs: 400 }));
          const event = { id: "atk6-stall", type: "RENEWAL", app_user_id: TEST_USER_ID };
          const owner = sim.h.handler(webhookRequest(event));
          await sleep(10);
          const losers = await drain(
            await Promise.all([1, 2, 3].map(() => sim.h.handler(webhookRequest(event)))),
          );
          for (const l of losers) {
            assertEquals(l.status, 503);
            assertEquals(l.retryAfter, "30");
            genericOnly(l.body, "atk6-stall", "in flight");
          }
          assertEquals(sim.rcCalls(), 1);
          const [o] = await drain([await owner]);
          assertEquals(o.body, { received: true, verified: true });
          const redelivery = await sim.h.handler(webhookRequest(event));
          assertEquals(await redelivery.json(), { received: true, duplicate: true });
          assertEquals(sim.rcCalls(), 1);
          assertEquals(sim.auditRows.size, 1);
        },
      );
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-13: TRANSFER — source loses, destination gains, both re-verified against RC (2 calls), one audit row; redelivery → duplicate:true with no RC call; the event body's own entitlement claims for the source are ignored",
  async () => {
    const sim = await simulate();
    try {
      sim.entitlementRows.set(TEST_USER_ID, pgRow(true, null, pgTimestamp(Date.now() - HOUR)));
      sim.faults.push(rcAnswer(TEST_USER_ID, { entitlements: {} }));
      sim.faults.push(
        rcAnswer(OTHER_USER_ID, activeSubscriber(null, "pickle_sensei_pro_lifetime")),
      );
      const event = {
        id: "atk6-transfer",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID, "$RCAnonymousID:abc"],
        transferred_to: [OTHER_USER_ID],
        // forged: claims the SOURCE keeps premium
        entitlement_ids: ["pickle_sensei_pro"],
        app_user_id: TEST_USER_ID,
        expiration_at_ms: Date.now() + 10 * HOUR,
      };
      const res = await sim.h.handler(webhookRequest(event));
      assertEquals(await res.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.auditRows.size, 1);
      const from = sim.entitlementRows.get(TEST_USER_ID);
      const to = sim.entitlementRows.get(OTHER_USER_ID);
      assert(from && to);
      assertEquals(from.premium, false, "source lost premium per RC, not per the event body");
      assertEquals(to.premium, true);
      assertEquals(to.expires_at, null);
      const again = await sim.h.handler(webhookRequest(event));
      assertEquals(await again.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 2);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-14: an EMPTY-STRING event id is accepted as an idempotency key — a second, different event with id '' is answered duplicate:true and never verified (pinned: RevenueCat never emits an empty id; a forged one needs the secret)",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber()));
      const first = await sim.h.handler(
        webhookRequest({ id: "", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await first.json(), { received: true, verified: true });
      const second = await sim.h.handler(
        webhookRequest({ id: "", type: "EXPIRATION", app_user_id: OTHER_USER_ID }),
      );
      assertEquals(await second.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.auditRows.size, 1);
      assert(sim.auditRows.has(""));
    } finally {
      sim.restore();
    }
  },
);

// ── 5. Security surface ─────────────────────────────────────────────────────

Deno.test(
  "ATK6-15: wrong / missing / 'Bearer '-prefixed secret → 401 with ZERO upstream traffic (no DB, no RC); the 401 body is generic",
  async () => {
    const sim = await simulate();
    try {
      const event = { id: "atk6-unauth", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const variants: Array<string | null> = [
        "wrong",
        null,
        `Bearer ${WEBHOOK_SECRET}`,
        `${WEBHOOK_SECRET}x`,
        WEBHOOK_SECRET.slice(0, -1),
        WEBHOOK_SECRET.toUpperCase(),
        "",
      ];
      let i = 0;
      for (const authorization of variants) {
        const res = await sim.h.handler(
          webhookRequest(event, { authorization, ip: `203.0.113.${130 + i++}` }),
        );
        assertEquals(res.status, 401, String(authorization));
        assertEquals(await res.json(), { error: { message: "Invalid webhook credentials." } });
      }
      assertEquals(sim.h.calls.length, 0);
      assertEquals(sim.rcCalls(), 0);
      assertEquals(sim.auditRows.size, 0);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-16: forged EVENT BODY (entitlements, expiration_at_ms, request_date_ms far in the future, subscriber block, premium:true) is never trusted — RC says free → row premium=false, verified_at from the local clock, and no forged key fences the next real verdict",
  async () => {
    const sim = await simulate();
    try {
      sim.entitlementRows.delete(TEST_USER_ID);
      sim.faults.push(rcAnswer(TEST_USER_ID, { entitlements: {} }, { requestDateMs: null }));
      const forgedFuture = Date.now() + 365 * 24 * HOUR;
      const before = Date.now();
      const res = await sim.h.handler(
        webhookRequest({
          id: "atk6-forged",
          type: "INITIAL_PURCHASE",
          app_user_id: TEST_USER_ID,
          request_date_ms: forgedFuture,
          event_timestamp_ms: forgedFuture,
          expiration_at_ms: forgedFuture,
          entitlement_ids: ["pickle_sensei_pro", "premium"],
          entitlements: { pickle_sensei_pro: { expires_date: null } },
          subscriber: { entitlements: { pickle_sensei_pro: { expires_date: null } } },
          premium: true,
          verified_at: new Date(forgedFuture).toISOString(),
        }),
      );
      const after = Date.now();
      assertEquals(await res.json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row);
      assertEquals(row.premium, false);
      assertEquals(row.expires_at, null);
      const stamped = Date.parse(String(row.verified_at));
      assert(
        stamped >= before && stamped <= after,
        "verified_at from the local clock, not the body",
      );
      // the next real verdict lands (nothing forged became a fence)
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber()));
      const real = await sim.h.handler(
        webhookRequest({
          id: "atk6-real-after-forged",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(await real.json(), { received: true, verified: true });
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, true);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK6-17: every 5xx body is generic — reservation 503, lookup 503, RC 500 (webhook 503 / sync 502), persist 503, completion 503, access_state failure — none leaks a PostgREST code/message, table name, user id or event id",
  async () => {
    const sim = await simulate();
    try {
      const user = freshUser();
      const forbidden = [
        "PGRST",
        "could not connect",
        "webhook_events",
        "billing_entitlements",
        TEST_USER_ID,
        user,
        "atk6-5xx",
      ];
      const event = { id: "atk6-5xx", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const check = async (res: Response, status: number, label: string) => {
        assertEquals(res.status, status, label);
        genericOnly((await res.json()) as Record<string, unknown>, ...forbidden);
      };
      // reservation fails
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(EVENTS_URL),
        ...dbUnavailable,
      });
      await check(await sim.h.handler(webhookRequest(event)), 503, "reservation");
      // RC 500 → 503 (released)
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        status: 500,
        body: { error: "boom" },
      });
      await check(await sim.h.handler(webhookRequest(event)), 503, "rc 500");
      assertEquals(sim.auditRows.size, 0, "released");
      // persist fails
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber()));
      sim.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        ...dbUnavailable,
      });
      await check(await sim.h.handler(webhookRequest(event)), 503, "persist");
      assertEquals(sim.auditRows.size, 0, "released");
      // completion fails (verdict persisted)
      sim.faults.push(rcAnswer(TEST_USER_ID, activeSubscriber()));
      sim.faults.push({
        match: (m, u) => m === "PATCH" && u.startsWith(EVENTS_URL),
        ...dbUnavailable,
      });
      const completion = await sim.h.handler(webhookRequest(event));
      assertEquals(completion.headers.get("Retry-After"), "30");
      await check(completion, 503, "completion");
      // lookup fails for a loser
      sim.faults.push({
        match: (m, u) => m === "GET" && u.startsWith(EVENTS_URL),
        ...dbUnavailable,
      });
      await check(await sim.h.handler(webhookRequest(event)), 503, "lookup");
      // sync: RC 500 → 502 coded, generic
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(user),
        status: 500,
        body: { error: "boom" },
      });
      const sync502 = await sim.h.handler(syncAs(user, "198.51.100.82"));
      assertEquals(sync502.status, 502);
      const b502 = (await sync502.json()) as { error: Record<string, unknown> };
      assertEquals(b502.error.code, "billing_unavailable");
      assert(!JSON.stringify(b502).includes("boom"));
      // sync: access_state RPC fails after the verdict landed
      sim.faults.push(rcAnswer(user, activeSubscriber()));
      sim.faults.push({
        match: (m, u) => m === "POST" && u.includes("/rpc/access_state"),
        ...dbUnavailable,
      });
      await check(await sim.h.handler(syncAs(user, "198.51.100.83")), 503, "access_state");
      assertEquals(
        sim.entitlementRows.get(user)?.premium,
        true,
        "the verdict landed before the RPC failed",
      );
    } finally {
      sim.restore();
    }
  },
);

// ── 6. Real Postgres: trigger, predicate, RLS (XC_PG_URL) ───────────────────

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const pgIgnore = PG_URL === "";
const PG_USER = "a6a6a6a6-0000-4000-8000-000000000601";
const PG_OTHER = "a6a6a6a6-0000-4000-8000-000000000602";

type Sql = ReturnType<typeof postgres>;

async function pgSetup(sql: Sql) {
  for (const id of [PG_USER, PG_OTHER]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
  }
}

/** The statement PostgREST issues for `.upsert(row, { onConflict: "user_id" }).select(...)`. */
const upsertSql = `
  insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values ($1, $2, $3, $4, $5)
  on conflict (user_id) do update set
    premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at
  returning premium, product_key, expires_at, verified_at`;

Deno.test({
  name: "ATK6-PG-1: billing_entitlements_keep_newest_verdict on real Postgres via the PostgREST upsert shape — older (−1 ms) → 0 rows returned + row unchanged; equal → returned + content updated; newer by 1 µs → returned",
  ignore: pgIgnore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await pgSetup(sql);
      const t = new Date(Date.now() - 1_000);
      const tIso = t.toISOString();
      const older = new Date(t.getTime() - 1).toISOString();
      const later = new Date(Date.now() + HOUR).toISOString();
      const first = await sql.unsafe(upsertSql, [PG_USER, true, "monthly", later, tIso]);
      assertEquals(first.length, 1);
      const stale = await sql.unsafe(upsertSql, [PG_USER, false, "monthly", null, older]);
      assertEquals(stale.length, 0, "PostgREST RETURNING carries nothing for the dropped update");
      const [row] = await sql.unsafe(
        `select premium, product_key from public.billing_entitlements where user_id = $1`,
        [PG_USER],
      );
      assertEquals(row, { premium: true, product_key: "monthly" });
      const equal = await sql.unsafe(upsertSql, [PG_USER, false, "monthly-equal", null, tIso]);
      assertEquals(equal.length, 1, "equal verified_at passes (idempotent replay)");
      assertEquals(equal[0].premium, false);
      const micro = await sql.unsafe(
        upsertSql.replace("$5)", "($5::timestamptz + interval '1 microsecond'))"),
        [PG_USER, true, "monthly-micro", later, tIso],
      );
      assertEquals(micro.length, 1, "1 µs newer is newer");
      const dropAgain = await sql.unsafe(upsertSql, [PG_USER, false, "monthly", null, tIso]);
      assertEquals(dropAgain.length, 0, "a JS-precision (ms) replay of t now loses to t + 1 µs");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK6-PG-2: access_state() predicate on real rows — premium+NULL → true; premium+now() → false; premium+now()+1 µs (next statement) → false-or-true consistently with expires_at > now(); not-premium+NULL/future → false; edge fn's effectivePremium agrees for every row",
  ignore: pgIgnore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await pgSetup(sql);
      const asUser = async <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${PG_USER}'`);
          return await fn(tx);
        });
      const cases: Array<{ label: string; premium: boolean; expires: string; expect: boolean }> = [
        { label: "lifetime", premium: true, expires: "null", expect: true },
        { label: "not premium + null", premium: false, expires: "null", expect: false },
        {
          label: "not premium + future",
          premium: false,
          expires: "now() + interval '1 hour'",
          expect: false,
        },
        {
          label: "premium + future",
          premium: true,
          expires: "now() + interval '1 hour'",
          expect: true,
        },
        {
          label: "premium + 1 µs ago",
          premium: true,
          expires: "now() - interval '1 microsecond'",
          expect: false,
        },
        {
          label: "premium + exactly the insert's now()",
          premium: true,
          expires: "now()",
          expect: false,
        },
      ];
      for (const c of cases) {
        await sql.unsafe(`delete from public.billing_entitlements where user_id = '${PG_USER}'`);
        await sql.unsafe(
          `insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
           values ('${PG_USER}', ${c.premium}, ${c.expires}, now())`,
        );
        const [state] = await asUser((tx) => tx.unsafe(`select * from public.access_state()`));
        assertEquals(state.premium, c.expect, `${c.label}: access_state().premium`);
        const [raw] = await sql.unsafe(
          // to_jsonb renders timestamptz exactly as PostgREST does (…T….ffffff+00:00)
          `select premium, to_jsonb(expires_at) #>> '{}' as expires_at from public.billing_entitlements where user_id = '${PG_USER}'`,
        );
        // the edge fn's rule over the PostgREST-shaped row
        const expiresMs = raw.expires_at === null ? null : Date.parse(String(raw.expires_at));
        if (raw.expires_at !== null)
          assert(Number.isFinite(expiresMs), `${c.label}: parseable ${raw.expires_at}`);
        const effective =
          raw.premium === true &&
          (expiresMs === null || (Number.isFinite(expiresMs) && expiresMs > Date.now()));
        assertEquals(effective, c.expect, `${c.label}: effectivePremium rule == access_state()`);
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK6-PG-3: RLS matrix — authenticated cannot INSERT/UPDATE/DELETE billing_entitlements (own or other's), reads only its own row; anon reads nothing; webhook_events is invisible to both",
  ignore: pgIgnore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await pgSetup(sql);
      await sql.unsafe(
        `delete from public.billing_entitlements where user_id in ('${PG_USER}', '${PG_OTHER}')`,
      );
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
         values ('${PG_USER}', false, null, now()), ('${PG_OTHER}', true, null, now())`,
      );
      await sql.unsafe(
        `insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
         values ('atk6-pg-evt', 'revenuecat', 'RENEWAL', '${PG_USER}', '{}'::jsonb)
         on conflict (id) do nothing`,
      );
      const as = async (role: "authenticated" | "anon", sub: string | null, statement: string) =>
        await sql
          .begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            if (sub) await tx.unsafe(`set local request.jwt.claim.sub = '${sub}'`);
            const rows = await tx.unsafe(statement);
            return { ok: true as const, count: rows.count ?? rows.length, rows };
          })
          .catch((error: { code?: string; message?: string }) => ({
            ok: false as const,
            code: error.code ?? "",
            message: error.message ?? "",
          }));
      const denied = (r: Awaited<ReturnType<typeof as>>, label: string) => {
        if (r.ok) assertEquals(r.count, 0, `${label}: must touch 0 rows`);
        else assertEquals(r.code, "42501", `${label}: permission denied (${r.message})`);
      };
      denied(
        await as(
          "authenticated",
          PG_USER,
          `update public.billing_entitlements set premium = true where user_id = '${PG_USER}'`,
        ),
        "own UPDATE",
      );
      denied(
        await as(
          "authenticated",
          PG_USER,
          `update public.billing_entitlements set premium = false where user_id = '${PG_OTHER}'`,
        ),
        "other's UPDATE",
      );
      denied(
        await as(
          "authenticated",
          PG_USER,
          `delete from public.billing_entitlements where user_id = '${PG_USER}'`,
        ),
        "own DELETE",
      );
      denied(
        await as(
          "authenticated",
          PG_USER,
          `insert into public.billing_entitlements (user_id, premium) values ('${PG_USER}', true) on conflict (user_id) do update set premium = true`,
        ),
        "own upsert",
      );
      const own = await as(
        "authenticated",
        PG_USER,
        `select user_id, premium from public.billing_entitlements`,
      );
      assert(own.ok);
      assertEquals(
        own.rows.map((r) => r.user_id),
        [PG_USER],
        "reads only its own row",
      );
      const anon = await as("anon", null, `select user_id from public.billing_entitlements`);
      if (anon.ok) assertEquals(anon.count, 0, "anon sees nothing");
      else assertEquals(anon.code, "42501");
      const events = await as("authenticated", PG_USER, `select id from public.webhook_events`);
      if (events.ok) assertEquals(events.count, 0, "webhook_events invisible");
      else assertEquals(events.code, "42501");
      const [still] = await sql.unsafe(
        `select premium from public.billing_entitlements where user_id = '${PG_USER}'`,
      );
      assertEquals(still.premium, false, "no client write landed");
      const [other] = await sql.unsafe(
        `select premium from public.billing_entitlements where user_id = '${PG_OTHER}'`,
      );
      assertEquals(other.premium, true);
    } finally {
      await sql.end();
    }
  },
});
