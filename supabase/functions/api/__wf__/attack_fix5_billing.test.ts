// ADVERSARIAL suite for fix round 5, area `billing-webhook` (ADJ-1/2/3).
//
// Attacks the candidate `devin/fix4-billing-webhook` @ bcfaf2c2 (based on the
// integration HEAD 1fb0efd7). Each test states the contract it attacks; tests
// whose name starts with "ATK5-BREAK" are EXPECTED TO FAIL on the candidate
// and expose a real defect (observed vs expected in the assertion message).
// Every other ATK5 test held on the candidate and is kept as a regression pin
// of the behaviour that was probed (lease/poll races, request_date_ms edge
// values, sync/webhook interleavings, security surface).
//
// The PostgREST/RevenueCat plane is webhookSim.ts (stateful rows, faults, the
// BEFORE UPDATE monotonic-verified_at trigger, PostgREST RETURNING fidelity).
// The code under test is the real Edge handler (index.ts) — never mocked.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_fix5_billing.test.ts

import { assert, assertEquals } from "@std/assert";
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
  type Row,
  simulate,
  sleep,
} from "./webhookSim.ts";

const rcFor = (userId: string) => `${RC_URL}${encodeURIComponent(userId)}`;

const drain = async (responses: Response[]) =>
  await Promise.all(
    responses.map(async (r) => ({
      status: r.status,
      retryAfter: r.headers.get("Retry-After"),
      body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    })),
  );

type SyncBody = {
  billing: {
    premium: boolean;
    productKey: string | null;
    expiresAt: string | null;
    verifiedAt: string;
  };
  access: { premium: boolean; entitlements: string[]; paywallRequired: boolean };
};

/** What `public.access_state()` (and therefore GET /v1/me/access) derives
 * from a billing_entitlements row: premium AND (expires_at IS NULL OR
 * expires_at > now()). Every DB decision point uses this predicate. */
const dbPremium = (row: Row | undefined): boolean => {
  if (!row) return false;
  const exp = row.expires_at;
  return (
    row.premium === true && (exp === null || exp === undefined || Date.parse(String(exp)) > Date.now())
  );
};

/** The `access_state` RPC stub mirrors what SQL computes from the sim's rows. */
const accessRowFor = (row: Row | undefined) => [
  { premium: dbPremium(row), scored_count: 0, reserved_count: 0 },
];

const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) Deno.env.delete(k);
  }
};

// ── 1. /v1/billing/sync: response == DB must mean the DB's PREDICATE ────────

Deno.test(
  "ATK5-BREAK-1: a sync verdict dropped as stale answers the persisted row's RAW premium flag, ignoring expires_at — billing.premium/access.premium=true for a row access_state() already reports as NOT premium (GET /v1/me/access disagrees)",
  async () => {
    const sim = await simulate();
    try {
      // The sync is evaluated by RevenueCat first (request_date_ms = t_s) but
      // its answer is slow. A webhook for the same user is evaluated 20 ms
      // later while the subscription is still active — but only for another
      // 120 ms — and lands first. By the time the sync's (older) verdict
      // arrives it is dropped by the monotonic trigger and the route re-reads
      // the row: premium=true, expires_at in the PAST.
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        delayMs: 300,
        subscriber: expiredSubscriber(),
        times: 1,
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(new Date(Date.now() + 140).toISOString()),
        times: 1,
      });
      sim.h.rpcs["access_state"] = accessRowFor(undefined);
      const sync = sim.h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.51" }));
      await sleep(20);
      const hook = await sim.h.handler(
        webhookRequest({ id: "atk5-sync-near-expiry", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(hook.status, 200);
      assertEquals(await hook.json(), { received: true, verified: true });

      const res = await sync;
      assertEquals(res.status, 200);
      const body = (await res.json()) as SyncBody;
      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assert(stored, "durable row exists");
      assertEquals(stored.premium, true, "row flag is the webhook's (stale verdict dropped)");
      assert(Date.parse(String(stored.expires_at)) < Date.now(), "…but the row's expires_at has passed");
      assertEquals(sim.entitlementWrites.length, 1, "the sync's older verdict was dropped");

      // What GET /v1/me/access says right now for the same persisted row.
      sim.h.rpcs["access_state"] = accessRowFor(stored);
      const me = await sim.h.handler(userRequest("GET", "/v1/me/access", { ip: "198.51.100.52" }));
      assertEquals(me.status, 200);
      const meBody = (await me.json()) as { premium: boolean };
      assertEquals(meBody.premium, false, "access_state(): premium AND expires_at > now() → false");

      assertEquals(
        body.billing.premium,
        dbPremium(stored),
        `observed: sync answered billing.premium=${body.billing.premium} from the row's raw flag ` +
          `(expires_at=${String(stored.expires_at)} is in the past); expected: the same predicate the DB uses ` +
          `everywhere else (premium AND (expires_at IS NULL OR expires_at > now())) → false. ` +
          `repro: sync evaluated by RC at t, RC answer delayed 300 ms; webhook evaluated at t+20 ms with an ` +
          `entitlement expiring at t+140 ms lands first; the sync's verdict is dropped as stale and the route ` +
          `echoes row.premium without applying expires_at`,
      );
      assertEquals(
        body.access.premium,
        meBody.premium,
        `observed: POST /v1/billing/sync access.premium=${body.access.premium} while GET /v1/me/access ` +
          `immediately after says premium=${meBody.premium} for the same row; expected: identical`,
      );
    } finally {
      sim.restore();
    }
  },
);

// ── 2. request_date_ms far in the future wedges the row forever ─────────────

Deno.test(
  "ATK5-BREAK-2: one RevenueCat answer with a far-future request_date_ms becomes the row's verified_at; every later real verdict (EXPIRATION webhook, every sync) is dropped as stale — the user keeps premium indefinitely with no self-heal",
  async () => {
    const sim = await simulate();
    try {
      const farFuture = Date.now() + 100 * 365 * 86_400_000; // ~2126, well under MAX_EPOCH_MS
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: farFuture,
        times: 1,
      });
      const first = await sim.h.handler(
        webhookRequest({ id: "atk5-far-future", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(first.status, 200);
      const wedged = sim.entitlementRows.get(TEST_USER_ID);
      assert(wedged);
      assertEquals(Date.parse(String(wedged.verified_at)), farFuture, "candidate stores RC's clock as-is");

      // Reality moves on: the subscription lapses and RevenueCat says so with
      // a sane request_date_ms (now).
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        times: 2,
      });
      const expiration = await sim.h.handler(
        webhookRequest({ id: "atk5-far-future-expiration", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      assertEquals(expiration.status, 200, "the webhook is acked as processed");
      sim.h.rpcs["access_state"] = accessRowFor(sim.entitlementRows.get(TEST_USER_ID));
      const sync = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.53" }),
      );
      assertEquals(sync.status, 200);
      const body = (await sync.json()) as SyncBody;

      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assert(stored);
      assertEquals(
        stored.premium,
        false,
        `observed: after an EXPIRATION webhook AND a sync both verified by RevenueCat as expired, ` +
          `billing_entitlements still says premium=${stored.premium} verified_at=${String(stored.verified_at)} ` +
          `(the far-future timestamp outranks every real verdict forever); expected: the newest RevenueCat ` +
          `truth lands — a request_date_ms implausibly ahead of the server clock must not become the monotonic ` +
          `key (clamp/fallback to the pre-request local clock). repro: RC answers request_date_ms=now+100y once, ` +
          `then EXPIRATION webhook + POST /v1/billing/sync with request_date_ms=now`,
      );
      assertEquals(body.billing.premium, false, "sync must not keep granting premium from the wedged row");
    } finally {
      sim.restore();
    }
  },
);

// ── 3. same id, different body ──────────────────────────────────────────────

Deno.test(
  "ATK5-3: a redelivery with the SAME id but a DIFFERENT body (other user, forged entitlements) — in flight or after completion — is a duplicate ack: 1 RC call for the original subject, no write for the forged subject, audit row keeps the first body",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        delayMs: 150,
        subscriber: activeSubscriber(),
        times: 1,
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(OTHER_USER_ID),
        subscriber: activeSubscriber(),
        times: 5,
      });
      const original = { id: "atk5-same-id", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const forged = {
        id: "atk5-same-id",
        type: "INITIAL_PURCHASE",
        app_user_id: OTHER_USER_ID,
        entitlements: { pickle_sensei_pro: { expires_date: null } },
      };
      const owner = sim.h.handler(webhookRequest(original));
      await sleep(20);
      const inFlight = sim.h.handler(webhookRequest(forged));
      const [o, f] = await drain([await owner, await inFlight]);
      assertEquals(o.body, { received: true, verified: true });
      assertEquals(f.status, 200);
      assertEquals(f.body, { received: true, duplicate: true });
      const later = await drain([await sim.h.handler(webhookRequest(forged))]);
      assertEquals(later[0].body, { received: true, duplicate: true });

      assertEquals(sim.rcCalls(), 1, "only the original subject was verified");
      assertEquals(sim.h.callsTo(rcFor(OTHER_USER_ID)).length, 0, "the forged subject never reached RC");
      assertEquals(sim.entitlementRows.has(OTHER_USER_ID), false, "no row for the forged subject");
      assertEquals(sim.auditRows.size, 1);
      const audit = sim.auditRows.get("atk5-same-id");
      assert(audit);
      assertEquals(audit.app_user_id, TEST_USER_ID, "audit row keeps the FIRST body's subject");
      assertEquals(
        (audit.payload as { event: { type: string } }).event.type,
        "RENEWAL",
        "audit payload is the first delivery's",
      );
    } finally {
      sim.restore();
    }
  },
);

// ── 4. lease/poll races at the wait bound ───────────────────────────────────

Deno.test(
  "ATK5-4: owner finalizes at exactly the duplicate wait bound → the loser answers 200 duplicate or 503+Retry-After (never a second RC call, never a false ack); the redelivery after completion is duplicate:true",
  async () => {
    const sim = await simulate();
    try {
      await withEnv({ WEBHOOK_DUPLICATE_WAIT_MS: "200", WEBHOOK_DUPLICATE_POLL_MS: "10" }, async () => {
        sim.faults.push({
          match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
          delayMs: 200,
          subscriber: activeSubscriber(),
          times: 1,
        });
        const event = { id: "atk5-exact-bound", type: "RENEWAL", app_user_id: TEST_USER_ID };
        const owner = sim.h.handler(webhookRequest(event));
        await sleep(5);
        const loser = sim.h.handler(webhookRequest(event));
        const [o, l] = await drain([await owner, await loser]);
        assertEquals(o.status, 200);
        assertEquals(o.body, { received: true, verified: true });
        if (l.status === 200) {
          assertEquals(l.body, { received: true, duplicate: true });
        } else {
          assertEquals(l.status, 503, `loser: ${JSON.stringify(l)}`);
          assertEquals(l.retryAfter, "30");
          assertEquals(l.body, {
            error: { message: "Webhook event processing is temporarily unavailable. Please try again." },
          });
        }
        assertEquals(sim.rcCalls(), 1);
        assertEquals(sim.entitlementUpserts(), 1);
        const redelivery = await drain([await sim.h.handler(webhookRequest(event))]);
        assertEquals(redelivery[0].body, { received: true, duplicate: true });
        assertEquals(sim.rcCalls(), 1);
        assertEquals(sim.auditRows.size, 1);
      });
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK5-5: owner verified against RC but the entitlement upsert fails (crash before persist) → owner 503 + reservation released; a loser polling in flight NEVER acks 200; the redelivery re-verifies exactly once and persists",
  async () => {
    const sim = await simulate();
    try {
      await withEnv({ WEBHOOK_DUPLICATE_WAIT_MS: "400", WEBHOOK_DUPLICATE_POLL_MS: "10" }, async () => {
        sim.faults.push({
          match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
          delayMs: 100,
          subscriber: activeSubscriber(),
          times: 2,
        });
        sim.faults.push({
          match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
          ...dbUnavailable,
          times: 1,
        });
        const event = { id: "atk5-crash-before-persist", type: "RENEWAL", app_user_id: TEST_USER_ID };
        const owner = sim.h.handler(webhookRequest(event));
        await sleep(5);
        const loser = sim.h.handler(webhookRequest(event));
        const [o, l] = await drain([await owner, await loser]);
        assertEquals(o.status, 503, `owner: ${JSON.stringify(o)}`);
        assertEquals(l.status, 503, `loser must not ack an unpersisted verdict: ${JSON.stringify(l)}`);
        assert(l.body.duplicate === undefined);
        assertEquals(sim.auditRows.size, 0, "reservation released");
        assertEquals(sim.entitlementWrites.length, 0);

        const redelivery = await drain([await sim.h.handler(webhookRequest(event))]);
        assertEquals(redelivery[0].body, { received: true, verified: true });
        assertEquals(sim.rcCalls(), 2, "one RC call per attempt");
        assertEquals(sim.entitlementWrites.length, 1);
        assertEquals(sim.auditRows.size, 1);
      });
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK5-6: owner persisted the verdict but the completion PATCH fails → owner 503 Retry-After 30, row stays in flight; a redelivery inside the lease waits then 503s WITHOUT a second RC call; once the lease lapses the redelivery reclaims, re-verifies once and completes — 1 audit row throughout",
  async () => {
    const sim = await simulate();
    try {
      await withEnv({ WEBHOOK_DUPLICATE_WAIT_MS: "150", WEBHOOK_DUPLICATE_POLL_MS: "10" }, async () => {
        sim.faults.push({
          match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
          subscriber: activeSubscriber(),
          times: 3,
        });
        sim.faults.push({
          match: (m, u) => m === "PATCH" && u.startsWith(EVENTS_URL),
          ...dbUnavailable,
          times: 1,
        });
        const event = { id: "atk5-crash-before-complete", type: "RENEWAL", app_user_id: TEST_USER_ID };
        const [o] = await drain([await sim.h.handler(webhookRequest(event))]);
        assertEquals(o.status, 503);
        assertEquals(o.retryAfter, "30");
        assertEquals(sim.entitlementWrites.length, 1, "verdict IS durable");
        const row = sim.auditRows.get(event.id);
        assert(row);
        assertEquals(row.processed_at, null, "still in flight");

        const [inLease] = await drain([await sim.h.handler(webhookRequest(event))]);
        assertEquals(inLease.status, 503, `redelivery inside the lease: ${JSON.stringify(inLease)}`);
        assertEquals(inLease.retryAfter, "30");
        assertEquals(sim.rcCalls(), 1, "no re-verification while the lease is honoured");
        assertEquals(sim.auditUpserts(), 2);
        assertEquals(sim.auditRows.size, 1, "no second audit row");

        // lease lapses (isolate that owned it is gone)
        row.claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
        const [afterLease] = await drain([await sim.h.handler(webhookRequest(event))]);
        assertEquals(afterLease.body, { received: true, verified: true });
        assertEquals(sim.rcCalls(), 2, "exactly one re-verification after reclaim");
        assertEquals(sim.entitlementWrites.length, 2, "same truth re-persisted (equal/newer request_date)");
        assertEquals(sim.auditRows.size, 1);
        assert(sim.auditRows.get(event.id)?.processed_at, "finally marked processed");
      });
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK5-7: lease reclaimed (clock skew ≥ lease) while the original owner is still verifying → both copies verify (2 RC calls, 2 upserts), both 200, single audit row, final row = newest request_date_ms; the original owner's late completion cannot un-finalize the row",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        delayMs: 250,
        subscriber: activeSubscriber(),
        times: 1,
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        times: 1,
      });
      const event = { id: "atk5-skewed-reclaim", type: "EXPIRATION", app_user_id: TEST_USER_ID };
      const owner = sim.h.handler(webhookRequest(event));
      await sleep(20);
      // A second isolate whose clock is > 5 min ahead sees the fresh lease as lapsed.
      const row = sim.auditRows.get(event.id);
      assert(row);
      row.claimed_at = new Date(Date.parse(String(row.claimed_at)) - 6 * 60_000).toISOString();
      const reclaimer = await sim.h.handler(webhookRequest(event));
      const [r, o] = await drain([reclaimer, await owner]);
      assertEquals(r.body, { received: true, verified: true });
      assertEquals(o.body, { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.auditRows.size, 1);
      const final = sim.entitlementRows.get(TEST_USER_ID);
      assert(final);
      assertEquals(final.premium, false, "the later RC evaluation (expired) is what persists");
      assert(sim.auditRows.get(event.id)?.processed_at, "processed");
      const replay = await drain([await sim.h.handler(webhookRequest(event))]);
      assertEquals(replay[0].body, { received: true, duplicate: true });
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK5-8: a loser's poll GET hit by a transient PostgREST 503 is retried by postgrest-js (1 s backoff) — the wait stretches past the configured bound but the outcome is still exact: 200 duplicate once the owner finalized, 1 RC call, no reclaim",
  async () => {
    const sim = await simulate();
    try {
      await withEnv({ WEBHOOK_DUPLICATE_WAIT_MS: "150", WEBHOOK_DUPLICATE_POLL_MS: "10" }, async () => {
        sim.faults.push({
          match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
          delayMs: 60,
          subscriber: activeSubscriber(),
          times: 1,
        });
        sim.faults.push({
          match: (m, u) => m === "GET" && u.startsWith(EVENTS_URL),
          ...dbUnavailable,
          times: 1,
        });
        const event = { id: "atk5-poll-retry", type: "RENEWAL", app_user_id: TEST_USER_ID };
        const owner = sim.h.handler(webhookRequest(event));
        await sleep(5);
        const t0 = Date.now();
        const loser = sim.h.handler(webhookRequest(event));
        const [o, l] = await drain([await owner, await loser]);
        const elapsed = Date.now() - t0;
        assertEquals(o.body, { received: true, verified: true });
        assertEquals(l.body, { received: true, duplicate: true });
        assert(elapsed >= 900, `postgrest-js retried the 503 GET after ~1 s (elapsed ${elapsed} ms)`);
        assertEquals(sim.rcCalls(), 1);
        assertEquals(sim.auditPatches(), 1, "no reclaim PATCH");
      });
    } finally {
      sim.restore();
    }
  },
);

// ── 5. request_date_ms edge values ──────────────────────────────────────────

Deno.test(
  "ATK5-9: request_date_ms absent / null / string / negative / 0 / NaN-ish → verified_at falls back to the pre-request local clock (within the request window), and successive fallbacks stay monotonic so every verdict lands",
  async () => {
    const sim = await simulate();
    try {
      const variants: Array<{ id: string; requestDateMs: number | null; raw?: unknown }> = [
        { id: "atk5-rd-absent", requestDateMs: null },
        { id: "atk5-rd-negative", requestDateMs: -1 },
        { id: "atk5-rd-zero", requestDateMs: 0 },
        { id: "atk5-rd-nan", requestDateMs: Number.NaN },
        { id: "atk5-rd-inf", requestDateMs: Number.POSITIVE_INFINITY },
      ];
      let previous = 0;
      for (const v of variants) {
        const before = Date.now();
        sim.faults.push({
          match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
          subscriber: activeSubscriber(),
          requestDateMs: v.requestDateMs,
          times: 1,
        });
        await sleep(2);
        const res = await sim.h.handler(
          webhookRequest({ id: v.id, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(res.status, 200, v.id);
        const after = Date.now();
        const write = sim.entitlementWrites.at(-1);
        assert(write, `${v.id}: verdict landed`);
        const verifiedAt = Date.parse(String(write.verified_at));
        assert(
          verifiedAt >= before && verifiedAt <= after,
          `${v.id}: verified_at ${String(write.verified_at)} within [${before}, ${after}]`,
        );
        assert(verifiedAt >= previous, `${v.id}: monotonic across fallbacks`);
        previous = verifiedAt;
      }
      // a string request_date_ms (JSON-encoded number) is not trusted either
      const before = Date.now();
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        status: 200,
        body: {
          request_date_ms: String(Date.now() + 86_400_000),
          subscriber: activeSubscriber(),
        },
        times: 1,
      });
      await sleep(2);
      const res = await sim.h.handler(
        webhookRequest({ id: "atk5-rd-string", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 200);
      const write = sim.entitlementWrites.at(-1);
      assert(write);
      const verifiedAt = Date.parse(String(write.verified_at));
      assert(verifiedAt >= before && verifiedAt <= Date.now(), "string value ignored → local fallback");
      assertEquals(sim.entitlementWrites.length, variants.length + 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK5-10: EXPIRATION then RENEWAL evaluated 1 ms apart with the EXPIRATION answer landing last → final row is the RENEWAL (newest request_date_ms), both webhooks 200",
  async () => {
    const sim = await simulate();
    try {
      const t = Date.now();
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        delayMs: 150,
        subscriber: expiredSubscriber(),
        requestDateMs: t,
        times: 1,
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: activeSubscriber(),
        requestDateMs: t + 1,
        times: 1,
      });
      const expiration = sim.h.handler(
        webhookRequest({ id: "atk5-exp-1ms", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      await sleep(10);
      const renewal = sim.h.handler(
        webhookRequest({ id: "atk5-ren-1ms", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      const [e, r] = await drain([await expiration, await renewal]);
      assertEquals(e.body, { received: true, verified: true });
      assertEquals(r.body, { received: true, verified: true });
      const final = sim.entitlementRows.get(TEST_USER_ID);
      assert(final);
      assertEquals(final.premium, true);
      assertEquals(Date.parse(String(final.verified_at)), t + 1);
      assertEquals(sim.entitlementWrites.length, 1, "the older EXPIRATION verdict was dropped");
    } finally {
      sim.restore();
    }
  },
);

// ── 6. sync/webhook interleavings ───────────────────────────────────────────

Deno.test(
  "ATK5-11: webhook evaluated first (premium) but landing last, sync evaluated later (expired) landing first → webhook's stale verdict dropped, webhook still 200, sync answers expired == DB == GET /v1/me/access",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        delayMs: 250,
        subscriber: activeSubscriber(),
        times: 1,
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        times: 1,
      });
      sim.h.rpcs["access_state"] = accessRowFor(undefined);
      const hook = sim.h.handler(
        webhookRequest({ id: "atk5-hook-first-lands-last", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      await sleep(20);
      const syncRes = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.54" }),
      );
      assertEquals(syncRes.status, 200);
      const body = (await syncRes.json()) as SyncBody;
      assertEquals(body.billing.premium, false);
      assertEquals(body.access.premium, false);
      const [h] = await drain([await hook]);
      assertEquals(h.body, { received: true, verified: true });
      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assert(stored);
      assertEquals(stored.premium, false, "newest evaluation persists");
      assertEquals(sim.entitlementWrites.length, 1);
      assertEquals(dbPremium(stored), body.billing.premium);
      sim.h.rpcs["access_state"] = accessRowFor(stored);
      const me = await sim.h.handler(userRequest("GET", "/v1/me/access", { ip: "198.51.100.55" }));
      assertEquals(((await me.json()) as { premium: boolean }).premium, body.access.premium);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK5-12: TRANSFER whose second subject's persist fails transiently → all-or-nothing: 503, reservation released, first subject's write stays (idempotent); redelivery re-verifies both once, final rows = newest request_date_ms for both users",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (m, u) => m === "GET" && u.startsWith(RC_URL),
        subscriber: activeSubscriber(),
        times: 4,
      });
      // fail exactly the SECOND entitlement upsert of the first attempt
      let entitlementPosts = 0;
      sim.faults.push({
        match: (m, u) => {
          if (m !== "POST" || !u.startsWith(ENTITLEMENTS_URL)) return false;
          entitlementPosts += 1;
          return entitlementPosts === 2;
        },
        ...dbUnavailable,
        times: 1,
      });
      const event = {
        id: "atk5-transfer-partial",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      };
      const [first] = await drain([await sim.h.handler(webhookRequest(event))]);
      assertEquals(first.status, 503);
      assertEquals(sim.auditRows.size, 0, "released");
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.entitlementRows.has(TEST_USER_ID), true, "first subject persisted");
      assertEquals(sim.entitlementRows.has(OTHER_USER_ID), false);

      const [second] = await drain([await sim.h.handler(webhookRequest(event))]);
      assertEquals(second.body, { received: true, verified: true });
      assertEquals(sim.rcCalls(), 4, "both subjects re-verified exactly once");
      assert(sim.entitlementRows.has(TEST_USER_ID));
      assert(sim.entitlementRows.has(OTHER_USER_ID));
      assertEquals(sim.auditRows.size, 1);
      const a = sim.entitlementRows.get(TEST_USER_ID)!;
      const b = sim.entitlementRows.get(OTHER_USER_ID)!;
      assert(
        Date.parse(String(a.verified_at)) <= Date.parse(String(b.verified_at)),
        "verified_at follows RC evaluation order",
      );
    } finally {
      sim.restore();
    }
  },
);

// ── 7. security surface ─────────────────────────────────────────────────────

Deno.test(
  "ATK5-13: oversized webhook body (> MAX_JSON_BODY_BYTES) with the correct secret → 413 and ZERO DB/RC traffic; with a wrong secret → 401 before the body is read",
  async () => {
    const sim = await simulate();
    try {
      const huge = `{"api_version":"1.0","event":{"id":"atk5-huge","type":"RENEWAL","app_user_id":"${TEST_USER_ID}","pad":"${"x".repeat(5_000_100)}"}}`;
      const tooLarge = await sim.h.handler(
        webhookRequest(null, { rawBody: huge, ip: "203.0.113.61" }),
      );
      assertEquals(tooLarge.status, 413);
      assertEquals(await tooLarge.json(), { error: { message: "Request body is too large." } });
      assertEquals(sim.h.calls.length, 0, "no upstream call at all");
      assertEquals(sim.auditRows.size, 0);

      const unauthorized = await sim.h.handler(
        webhookRequest(null, { rawBody: huge, authorization: "Bearer nope", ip: "203.0.113.62" }),
      );
      assertEquals(unauthorized.status, 401);
      assertEquals(sim.h.calls.length, 0);
      assertEquals(sim.rcCalls(), 0);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK5-14: the candidate migration adds no grant/policy that lets anon/authenticated touch billing_entitlements or webhook_events, and revokes its trigger function from client roles",
  () => {
    const dir = new URL("../../../migrations/", import.meta.url);
    const name = [...Deno.readDirSync(dir)]
      .map((e) => e.name)
      .find((n) => n.includes("webhook_reservation_and_monotonic_verified_at"));
    assert(name, "candidate migration present");
    const sql = Deno.readTextFileSync(new URL(name, dir)).toLowerCase();
    const grantsToClients = sql
      .split("\n")
      .filter((l) => /^\s*grant\b/.test(l) && /\b(anon|authenticated|public)\b/.test(l));
    assertEquals(grantsToClients, [], "no client-role grants");
    assertEquals(/create\s+policy/.test(sql), false, "no new RLS policies");
    assert(
      /revoke\s+(all|execute)[^;]*billing_entitlements_keep_newest_verdict[^;]*from\s+public,?\s*anon,?\s*authenticated/.test(
        sql.replace(/\s+/g, " "),
      ),
      "trigger function EXECUTE revoked from public/anon/authenticated",
    );
  },
);
