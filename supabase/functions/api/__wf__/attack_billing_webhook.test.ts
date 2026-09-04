// ADVERSARIAL PASS — edge-billing-webhook (RevenueCat webhook, entitlement
// re-verification, billing_entitlements service-role writes, webhook_events
// audit, idempotency). Black-box through the REAL handler (routesHarness) with
// a STATEFUL PostgREST emulation (attackBillingHarness) so races, FK failures,
// write order and the expires_at predicate are observable.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_billing_webhook.test.ts
//
// Test names carry their classification against 4d812e1a:
//   HELD   — the property under attack survived
//   BROKEN — reproduces a defect (see the finding referenced in the name)
// A BROKEN test asserts the CURRENT (defective) behaviour so the suite is
// green on 4d812e1a and goes red the moment the defect is fixed — flip the
// assertion when fixing.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  activeSubscriber,
  fakeGoogleIdToken,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";
import {
  accessStateRow,
  deferred,
  installAttackDb,
  loadFreshIsolate,
  pgError,
  seededRandom,
} from "./attackBillingHarness.ts";

const SEED = 0x5eed_0004;

const lapsedSubscriber = (): Record<string, unknown> =>
  activeSubscriber(new Date(Date.now() - 60_000).toISOString());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const upserts = (h: { callsTo(f: string): unknown[] }) =>
  h
    .callsTo("/rest/v1/billing_entitlements")
    .filter((c) => (c as { method: string }).method === "POST");

const postgrestCalls = (h: { callsTo(f: string): unknown[] }) => h.callsTo("/rest/v1/");

// ─────────────────────────────────────────────────────────────────────────────
// S1 — account-deletion race: profiles row gone, EXPIRATION delivered.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S1 HELD: EXPIRATION for a user whose profiles row is gone → 200 {verified:false}; replay of the same id → duplicate:true with no RC call",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [OTHER_USER_ID]); // TEST_USER_ID has NO profiles row
    try {
      h.subscriber = lapsedSubscriber();
      const event = { id: "evt-s1-deleted-profile", type: "EXPIRATION", app_user_id: TEST_USER_ID };

      const first = await h.handler(webhookRequest(event));
      assertEquals(first.status, 200);
      assertEquals(await first.json(), { received: true, verified: false });
      assertEquals(h.callsTo(RC_URL).length, 1, "verdict was fetched from RevenueCat");
      assertEquals(upserts(h).length, 1, "the upsert was attempted");
      assertEquals(db.entitlements.size, 0, "FK 23503 → nothing persisted");
      assert(db.webhookEvents.has(event.id), "audit row written despite the FK failure");

      h.calls = [];
      const replay = await h.handler(webhookRequest(event, { ip: "198.51.100.77" }));
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(h.callsTo(RC_URL).length, 0, "replay must not re-verify");
      assertEquals(upserts(h).length, 0, "replay must not re-upsert");
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "S1b HELD: after the deleted user re-bootstraps (profiles row back), a NEW event id is processed normally — the earlier acked event is not resurrected",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, []);
    try {
      h.subscriber = lapsedSubscriber();
      const dead = { id: "evt-s1b-while-deleted", type: "EXPIRATION", app_user_id: TEST_USER_ID };
      assertEquals((await (await h.handler(webhookRequest(dead))).json()).verified, false);

      db.profiles.add(TEST_USER_ID); // account re-created
      h.subscriber = activeSubscriber();
      const fresh = {
        id: "evt-s1b-after-rebootstrap",
        type: "INITIAL_PURCHASE",
        app_user_id: TEST_USER_ID,
      };
      const res = await h.handler(webhookRequest(fresh));
      assertEquals(await res.json(), { received: true, verified: true });
      assertEquals(db.entitlements.get(TEST_USER_ID)?.premium, true);
      // the old id stays a duplicate forever — the FK failure was a terminal ack
      const replay = await h.handler(webhookRequest(dead));
      assertEquals(await replay.json(), { received: true, duplicate: true });
    } finally {
      db.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S2 — service role key missing.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S2 HELD: SUPABASE_SERVICE_ROLE_KEY absent on a cold isolate → 503 'Webhook processing is not configured.' with no RC call and no PostgREST call",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    assert(key, "precondition: harness set the key");
    try {
      Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
      const cold = await loadFreshIsolate(h);
      h.subscriber = activeSubscriber();
      const res = await cold(
        webhookRequest({
          id: "evt-s2-no-service-role",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(res.status, 503);
      assertEquals(await res.json(), {
        error: { message: "Webhook processing is not configured." },
      });
      assertEquals(h.callsTo(RC_URL).length, 0, "no RevenueCat call");
      assertEquals(postgrestCalls(h).length, 0, "no PostgREST call");
      assertEquals(db.webhookEvents.size, 0, "no audit row → RevenueCat retries after redeploy");

      // ordering: a bad secret is still refused BEFORE the misconfiguration
      // leaks (an unauthenticated probe cannot learn the key is missing)
      const probe = await cold(
        webhookRequest(
          { id: "evt-s2-probe", type: "RENEWAL", app_user_id: TEST_USER_ID },
          {
            authorization: "wrong-secret",
          },
        ),
      );
      assertEquals(probe.status, 401);
    } finally {
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", key);
      db.restore();
    }
  },
);

Deno.test(
  "S2b HELD (documented): a WARM isolate keeps its cached service-role client after the env var disappears — the event is still processed (client caching, not a leak)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    assert(key);
    try {
      h.subscriber = activeSubscriber();
      // warm the cache
      await h.handler(
        webhookRequest({ id: "evt-s2b-warm", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
      const res = await h.handler(
        webhookRequest({ id: "evt-s2b-after-delete", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: true });
    } finally {
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", key);
      db.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S3 — 60 concurrent deliveries of ONE event id from 60 IPs.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S3 BROKEN (F1): 60 concurrent deliveries of one event id from 60 IPs → 60 RevenueCat calls + 60 upserts, zero duplicate acks (check-then-act window)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      db.latencyMs = 5; // a realistic PostgREST round trip keeps the window open
      h.subscriber = activeSubscriber();
      const event = { id: "evt-s3-storm", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const rng = seededRandom(SEED);
      const ips = Array.from(
        { length: 60 },
        (_, i) => `198.51.${100 + (i % 50)}.${1 + Math.floor(rng() * 250)}`,
      );
      const responses = await Promise.all(
        ips.map((ip) => h.handler(webhookRequest(event, { ip }))),
      );
      const bodies = await Promise.all(responses.map((r) => r.json()));
      assertEquals(
        responses.map((r) => r.status),
        Array(60).fill(200),
      );
      const duplicates = bodies.filter((b) => b.duplicate === true).length;
      const verified = bodies.filter((b) => b.verified === true).length;

      // ── current (defective) behaviour pinned; expected: 1 RC call, 1 upsert, 59 duplicate acks
      assertEquals(h.callsTo(RC_URL).length, 60, "RevenueCat hit once per duplicate delivery");
      assertEquals(
        upserts(h).length,
        60,
        "billing_entitlements upserted once per duplicate delivery",
      );
      assertEquals(duplicates, 0, "no delivery was recognised as a duplicate");
      assertEquals(verified, 60);
      assertEquals(db.webhookEvents.size, 1, "the PK still collapses the audit rows to one");
      console.log(
        `S3 seed=${SEED.toString(16)} rc_calls=${h.callsTo(RC_URL).length} upserts=${upserts(h).length} duplicate_acks=${duplicates}`,
      );
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "S3b HELD: pre-seeded webhook_events row (stock harness h.tables AND stateful db) → 60 concurrent deliveries make 0 RC calls and 0 upserts",
  async () => {
    const h = await loadHarness();
    // stock stateless harness, as the coordinator specified
    h.subscriber = activeSubscriber();
    h.tables.webhook_events = [{ id: "evt-s3b-seeded" }];
    const event = { id: "evt-s3b-seeded", type: "RENEWAL", app_user_id: TEST_USER_ID };
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        h.handler(webhookRequest(event, { ip: `203.0.113.${1 + i}` })),
      ),
    );
    for (const r of responses) assertEquals(await r.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(upserts(h).length, 0);

    // stateful emulation
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      db.latencyMs = 5;
      db.webhookEvents.set("evt-s3b-seeded", {
        id: "evt-s3b-seeded",
        provider: "revenuecat",
        event_type: "RENEWAL",
        app_user_id: TEST_USER_ID,
        payload: {},
      });
      h.calls = [];
      const again = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          h.handler(webhookRequest(event, { ip: `203.0.114.${1 + i}` })),
        ),
      );
      for (const r of again) assertEquals(await r.json(), { received: true, duplicate: true });
      assertEquals(h.callsTo(RC_URL).length, 0);
      assertEquals(upserts(h).length, 0);
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "S3c HELD: SEQUENTIAL replay of one event id is deduped after the first delivery (1 RC call, 1 upsert, then duplicate:true)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const event = { id: "evt-s3c-sequential", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const bodies = [];
      for (let i = 0; i < 3; i += 1)
        bodies.push(await (await h.handler(webhookRequest(event))).json());
      assertEquals(bodies, [
        { received: true, verified: true },
        { received: true, duplicate: true },
        { received: true, duplicate: true },
      ]);
      assertEquals(h.callsTo(RC_URL).length, 1);
      assertEquals(upserts(h).length, 1);
    } finally {
      db.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S4 — webhook (lapsed) interleaved with POST /v1/billing/sync (active).
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S4 BROKEN (F2): slow webhook verdict (lapsed) lands after a fresher billing/sync verdict (active) → billing_entitlements.premium=false and GET /v1/me/access paywalls a user RevenueCat considers active",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      db.accessCounts.set(TEST_USER_ID, { scored_count: 2, reserved_count: 0 });
      const webhookGate = deferred<void>();
      let webhookRcAt = 0;
      let syncRcAt = 0;
      db.rcHook = async (_appUserId, index) => {
        if (index === 0) {
          // The webhook's RevenueCat read was issued FIRST (older truth) but
          // its response is delayed on the wire until the sync has persisted.
          webhookRcAt = performance.now();
          await webhookGate.promise;
          return lapsedSubscriber();
        }
        syncRcAt = performance.now();
        return activeSubscriber();
      };

      const webhook = h.handler(
        webhookRequest(
          { id: "evt-s4-expiration", type: "EXPIRATION", app_user_id: TEST_USER_ID },
          {
            ip: "198.51.100.40",
          },
        ),
      );
      // let the webhook reach RevenueCat before the app syncs
      while (webhookRcAt === 0) await sleep(1);
      const sync = await h.handler(userRequest("POST", "/v1/billing/sync"));
      assertEquals(sync.status, 200);
      const syncBody = await sync.json();
      assertEquals(syncBody.billing.premium, true);
      assertEquals(syncBody.access.premium, true);
      assertEquals(db.entitlements.get(TEST_USER_ID)?.premium, true, "sync persisted active");
      assert(syncRcAt > webhookRcAt);

      webhookGate.resolve();
      const webhookRes = await webhook;
      assertEquals(await webhookRes.json(), { received: true, verified: true });

      // ── the stale verdict overwrote the fresher one
      const row = db.entitlements.get(TEST_USER_ID);
      assertEquals(row?.premium, false, "lapsed verdict won by landing last");
      const order = db.writeLog
        .filter((w) => w.table === "billing_entitlements")
        .map((w) => (w.row as { premium: boolean }).premium);
      assertEquals(order, [true, false]);
      // verified_at is stamped AFTER the response arrives, so even a
      // verified_at-guarded upsert would not have protected this row
      assert(
        Date.parse(row!.verified_at) >= Date.parse(syncBody.billing.verifiedAt),
        "stale verdict carries the NEWER verified_at",
      );

      const access = await h.handler(userRequest("GET", "/v1/me/access"));
      const accessBody = await access.json();
      assertEquals(accessBody.premium, false);
      assertEquals(
        accessBody.paywallRequired,
        true,
        "paying user (2 free ratings used) is paywalled",
      );
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "S4b BROKEN (F2, mirror): slow billing/sync (lapsed, older) landing after a fresher webhook INITIAL_PURCHASE (active) also clobbers → premium=false",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      const gate = deferred<void>();
      let firstIssued = false;
      db.rcHook = async (_id, index) => {
        if (index === 0) {
          firstIssued = true;
          await gate.promise;
          return lapsedSubscriber(); // sync's stale read
        }
        return activeSubscriber(); // webhook's fresh read
      };
      const sync = h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.41" }));
      while (!firstIssued) await sleep(1);
      const webhook = await h.handler(
        webhookRequest({
          id: "evt-s4b-purchase",
          type: "INITIAL_PURCHASE",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(await webhook.json(), { received: true, verified: true });
      assertEquals(db.entitlements.get(TEST_USER_ID)?.premium, true);
      gate.resolve();
      const syncRes = await sync;
      assertEquals(syncRes.status, 200);
      assertEquals((await syncRes.json()).billing.premium, false);
      assertEquals(
        db.entitlements.get(TEST_USER_ID)?.premium,
        false,
        "older lapsed read overwrote the purchase",
      );
    } finally {
      db.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S6 — nested path /v1/me/webhooks/revenuecat with a USER bearer.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S6 HELD: POST /v1/me/webhooks/revenuecat with a valid user bearer → 401 webhook body (route suffix match wins), no PostgREST and no Auth call",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      userRequest("POST", "/v1/me/webhooks/revenuecat", {
        body: { event: { id: "evt-s6", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID } },
      }),
    );
    assertEquals(res.status, 401);
    assertEquals(await res.json(), { error: { message: "Invalid webhook credentials." } });
    assertEquals(postgrestCalls(h).length, 0);
    assertEquals(h.callsTo("/auth/v1/").length, 0, "the bearer was never exchanged");
    assertEquals(h.callsTo(RC_URL).length, 0);
  },
);

Deno.test(
  "S6b HELD: the suffix match takes ANY prefix (…/v1/shots/../webhooks/revenuecat, unicode, %2F) but the shared-secret gate holds on each; correct secret on a nested path processes normally",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const prefixes = [
        "/v1/shots/x/webhooks/revenuecat",
        "/v1/\u{1F3D3}/webhooks/revenuecat",
        "/webhooks/revenuecat/../webhooks/revenuecat",
      ];
      for (const path of prefixes) {
        const res = await h.handler(
          new Request(`http://edge.test/functions/v1/api${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${fakeGoogleIdToken()}`,
              "x-forwarded-for": "198.51.100.60",
            },
            body: JSON.stringify({
              event: { id: `evt-${path}`, type: "RENEWAL", app_user_id: TEST_USER_ID },
            }),
          }),
        );
        assertEquals(res.status, 401, path);
      }
      assertEquals(postgrestCalls(h).length, 0);
      // with the secret, the nested path is a fully working webhook endpoint
      const req = new Request("http://edge.test/functions/v1/api/v1/me/webhooks/revenuecat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "wf-test-webhook-secret",
          "x-forwarded-for": "198.51.100.61",
        },
        body: JSON.stringify({
          event: { id: "evt-s6b-nested-ok", type: "RENEWAL", app_user_id: TEST_USER_ID },
        }),
      });
      const ok = await h.handler(req);
      assertEquals(await ok.json(), { received: true, verified: true });
    } finally {
      db.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S7 — expires_date 500 ms in the future.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S7 HELD: billing/sync with expires_date +500ms returns billing.premium=true/access.premium=true; 600ms later access_state() reports premium=false (predicate is time-true, sync payload was truthful at issue time)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      const expiresAt = new Date(Date.now() + 500).toISOString();
      h.subscriber = activeSubscriber(expiresAt);
      const sync = await h.handler(
        userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.70" }),
      );
      assertEquals(sync.status, 200);
      const body = await sync.json();
      assertEquals(body.billing.premium, true);
      assertEquals(body.billing.expiresAt, expiresAt);
      assertEquals(body.access.premium, true);
      assertEquals(db.entitlements.get(TEST_USER_ID)?.expires_at, expiresAt);

      await sleep(600);
      assertEquals(accessStateRow(db, TEST_USER_ID).premium, false, "emulated access_state()");
      const access = await h.handler(userRequest("GET", "/v1/me/access", { ip: "198.51.100.70" }));
      const accessBody = await access.json();
      assertEquals(accessBody.premium, false);
      assertEquals(accessBody.entitlements, []);
      assertEquals(accessBody.canStartRating, true, "free ratings remain (0 used)");
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "S7b HELD: expires_date exactly now / 1ms in the past / malformed / numeric → not premium at verification time; null → lifetime premium",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      const cases: Array<[unknown, boolean]> = [
        [new Date(Date.now() - 1).toISOString(), false],
        ["not-a-date", false],
        [Date.now() + 86_400_000, false], // number, not a string
        ["", false],
        [null, true],
      ];
      for (const [expiresDate, premium] of cases) {
        h.calls = [];
        h.subscriber = {
          entitlements: {
            pickle_sensei_pro: {
              expires_date: expiresDate,
              product_identifier: "pickle_sensei_pro_monthly",
            },
          },
        };
        const res = await h.handler(
          webhookRequest({
            id: `evt-s7b-${String(expiresDate)}`,
            type: "RENEWAL",
            app_user_id: TEST_USER_ID,
          }),
        );
        assertEquals(res.status, 200, JSON.stringify(expiresDate));
        assertEquals(
          db.entitlements.get(TEST_USER_ID)?.premium,
          premium,
          JSON.stringify(expiresDate),
        );
      }
    } finally {
      db.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Extra adversarial cases.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "X1 BROKEN (F3): a TRANSIENT persist failure (PostgREST 503/timeout) on the verdict upsert is acknowledged 200 and audit-logged → the event is never retried and the entitlement change is lost",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID, OTHER_USER_ID]);
    try {
      // OTHER_USER_ID currently premium (transfer source), TEST_USER_ID free.
      db.entitlements.set(OTHER_USER_ID, {
        user_id: OTHER_USER_ID,
        premium: true,
        product_key: "pickle_sensei_pro_annual",
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        verified_at: new Date().toISOString(),
      });
      // RevenueCat truth after the transfer: entitlement now belongs to TEST_USER_ID
      db.rcHook = (appUserId) =>
        Promise.resolve(appUserId === TEST_USER_ID ? activeSubscriber() : { entitlements: {} });
      // the DB is briefly unavailable for exactly the source-account upsert
      db.failNextUpserts = {
        remaining: 1,
        status: 503,
        body: pgError("57014", "canceling statement due to statement timeout"),
      };

      const event = {
        id: "evt-x1-transfer",
        type: "TRANSFER",
        transferred_from: [OTHER_USER_ID],
        transferred_to: [TEST_USER_ID],
      };
      const res = await h.handler(webhookRequest(event));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(
        db.entitlements.get(OTHER_USER_ID)?.premium,
        true,
        "source account still premium",
      );
      assertEquals(db.entitlements.get(TEST_USER_ID)?.premium, true, "destination written");
      assert(db.webhookEvents.has(event.id), "audit row written → RevenueCat sees success");

      // RevenueCat's own retry (same id) is now a no-op forever
      h.calls = [];
      const retry = await h.handler(webhookRequest(event));
      assertEquals(await retry.json(), { received: true, duplicate: true });
      assertEquals(h.callsTo(RC_URL).length, 0);
      assertEquals(
        db.entitlements.get(OTHER_USER_ID)?.premium,
        true,
        "source keeps premium until expires_at (30d)",
      );
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X2 HELD: TRANSFER where RevenueCat fails for the SECOND subject → 503, nothing persisted for either side, no audit row (full retry)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID, OTHER_USER_ID]);
    try {
      db.rcHook = (_id, index) => Promise.resolve(index === 0 ? { entitlements: {} } : null);
      const res = await h.handler(
        webhookRequest({
          id: "evt-x2",
          type: "TRANSFER",
          transferred_from: [OTHER_USER_ID],
          transferred_to: [TEST_USER_ID],
        }),
      );
      assertEquals(res.status, 503);
      assertEquals(await res.json(), {
        error: { message: "Verification is temporarily unavailable." },
      });
      assertEquals(upserts(h).length, 0);
      assertEquals(db.webhookEvents.size, 0);
      assertEquals(h.callsTo(RC_URL).length, 2);
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X3 HELD: webhook_events lookup failing (PostgREST 500) fails OPEN to processing (never drops the event) and the audit row is still written",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const original = globalThis.fetch;
      let failedLookups = 0;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/rest/v1/webhook_events") && (init?.method ?? "GET") === "GET") {
          failedLookups += 1;
          return Promise.resolve(
            new Response(JSON.stringify(pgError("XX000", "connection reset")), { status: 500 }),
          );
        }
        return original(input, init);
      }) as typeof fetch;
      try {
        const res = await h.handler(
          webhookRequest({ id: "evt-x3", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(await res.json(), { received: true, verified: true });
        assertEquals(failedLookups, 1);
        assertEquals(db.entitlements.get(TEST_USER_ID)?.premium, true);
        assert(db.webhookEvents.has("evt-x3"));
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X4 BROKEN (F4, low): a non-string event id (number) gets a fresh random id per delivery → replays are never deduped (3 deliveries = 3 RC calls, 3 upserts, 3 audit rows)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const event = { id: 1234567890, type: "RENEWAL", app_user_id: TEST_USER_ID };
      for (let i = 0; i < 3; i += 1) {
        const res = await h.handler(webhookRequest(event));
        assertEquals(await res.json(), { received: true, verified: true });
      }
      assertEquals(h.callsTo(RC_URL).length, 3);
      assertEquals(upserts(h).length, 3);
      assertEquals(db.webhookEvents.size, 3, "three audit rows for one logical event");
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X5 HELD: unicode / control / PostgREST-operator characters and a 4 KiB event id round-trip the lookup + audit unchanged and dedupe correctly",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const ids = [
        "evt-\u{1F3D3}\u0000nul\u202Ertl",
        "evt,in.(1,2)*&=?#%/\\\"'",
        "evt-" + "\u00e9".repeat(4096),
        " evt-leading-and-trailing-spaces ",
      ];
      for (const id of ids) {
        h.calls = [];
        const first = await h.handler(
          webhookRequest({ id, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(
          await first.json(),
          { received: true, verified: true },
          JSON.stringify(id).slice(0, 60),
        );
        assert(
          db.webhookEvents.has(id),
          `audit row keyed by the exact id ${JSON.stringify(id).slice(0, 60)}`,
        );
        const replay = await h.handler(
          webhookRequest({ id, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(
          await replay.json(),
          { received: true, duplicate: true },
          JSON.stringify(id).slice(0, 60),
        );
        assertEquals(h.callsTo(RC_URL).length, 1);
      }
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X6 HELD: app_user_id that is not our uuid (unicode, SQL-ish, 64 KiB) never reaches RevenueCat; aliases fallback picks only a canonical uuid; an alias list of 10k junk entries is handled",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const junk = [
        "$RCAnonymousID:\u{1F3D3}",
        "' or 1=1 --",
        "x".repeat(65_536),
        TEST_USER_ID.toUpperCase() + "0",
      ];
      for (const appUserId of junk) {
        h.calls = [];
        const res = await h.handler(
          webhookRequest({
            id: `evt-x6-${appUserId.length}`,
            type: "RENEWAL",
            app_user_id: appUserId,
          }),
        );
        assertEquals(await res.json(), { received: true, verified: false });
        assertEquals(h.callsTo(RC_URL).length, 0, "junk id never sent to RevenueCat");
        assertEquals(upserts(h).length, 0);
      }
      const rng = seededRandom(SEED + 1);
      const aliases = Array.from({ length: 10_000 }, () => `alias-${Math.floor(rng() * 1e9)}`);
      aliases.splice(7_777, 0, TEST_USER_ID);
      h.calls = [];
      const res = await h.handler(
        webhookRequest({
          id: "evt-x6-aliases",
          type: "RENEWAL",
          app_user_id: "$RCAnonymousID:abc",
          aliases,
        }),
      );
      assertEquals(await res.json(), { received: true, verified: true });
      assertEquals(h.callsTo(RC_URL).length, 1);
      assertStringIncludes(h.callsTo(RC_URL)[0].url, TEST_USER_ID);
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X7 HELD (documented): an UPPERCASE uuid app_user_id passes the uuid check and is forwarded VERBATIM to RevenueCat (ids are case-sensitive there) and upserted verbatim (Postgres uuid folds case → same row) — only reachable with the webhook secret",
  async () => {
    const h = await loadHarness();
    const lower = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const upper = lower.toUpperCase();
    const db = installAttackDb(h, [lower, upper]);
    try {
      h.subscriber = activeSubscriber();
      const res = await h.handler(
        webhookRequest({ id: "evt-x7-upper", type: "RENEWAL", app_user_id: upper }),
      );
      assertEquals(await res.json(), { received: true, verified: true });
      assertStringIncludes(h.callsTo(RC_URL)[0].url, upper);
      assertNotEquals(h.callsTo(RC_URL)[0].url.includes(lower), true);
      assertEquals(upserts(h).length, 1);
      assertEquals((upserts(h)[0].body as { user_id: string }).user_id, upper);
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X8 HELD: 240 deliveries/min per IP; the 241st is 429 with Retry-After and leaves NO audit row (RevenueCat's retry is processed); a second IP is unaffected",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const ip = "198.51.100.240";
      let last: Response | null = null;
      for (let i = 0; i < 241; i += 1) {
        last = await h.handler(
          webhookRequest({ id: `evt-x8-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID }, { ip }),
        );
        if (i < 240) assertEquals(last.status, 200, `delivery ${i}`);
      }
      assertEquals(last!.status, 429);
      assert(last!.headers.get("Retry-After"));
      assertEquals(
        db.webhookEvents.has("evt-x8-240"),
        false,
        "throttled delivery leaves no audit row",
      );
      const other = await h.handler(
        webhookRequest(
          { id: "evt-x8-240", type: "RENEWAL", app_user_id: TEST_USER_ID },
          { ip: "198.51.100.241" },
        ),
      );
      assertEquals(await other.json(), { received: true, verified: true });
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X9 HELD: corrupt payloads (event: [], event: 'str', deeply nested, body 'null', truncated JSON) → 400 'Missing event payload.' with no RC/PostgREST side effects; BOM-prefixed JSON is accepted",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = activeSubscriber();
      const bodies = [
        JSON.stringify({ event: [] }),
        JSON.stringify({ event: "INITIAL_PURCHASE" }),
        JSON.stringify({ event: null }),
        "null",
        "{" + '"a":'.repeat(2000) + "1" + "}".repeat(2000),
        '{"event":{"id":"evt-trunc","app_user_id":',
      ];
      for (const rawBody of bodies) {
        h.calls = [];
        const res = await h.handler(webhookRequest(null, { rawBody }));
        assertEquals(res.status, 400, rawBody.slice(0, 40));
        assertEquals(
          await res.json(),
          { error: { message: "Missing event payload." } },
          rawBody.slice(0, 40),
        );
        assertEquals(h.callsTo(RC_URL).length, 0);
        assertEquals(postgrestCalls(h).length, 0);
      }
      // A UTF-8 BOM is stripped by Request.json() (WHATWG) → processed as a normal event.
      h.calls = [];
      const bom = await h.handler(
        webhookRequest(null, {
          rawBody:
            "\uFEFF" +
            JSON.stringify({
              event: { id: "evt-x9-bom", type: "RENEWAL", app_user_id: TEST_USER_ID },
            }),
        }),
      );
      assertEquals(await bom.json(), { received: true, verified: true });
      assert(db.webhookEvents.has("evt-x9-bom"));
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X10 HELD: the webhook body's entitlement claims are ignored even for a user with NO row — only RevenueCat's verdict is persisted (body says lifetime, RC says lapsed → premium=false)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      h.subscriber = lapsedSubscriber();
      const res = await h.handler(
        webhookRequest({
          id: "evt-x10",
          type: "NON_RENEWING_PURCHASE",
          app_user_id: TEST_USER_ID,
          entitlement_ids: ["pickle_sensei_pro", "premium"],
          product_id: "pickle_sensei_pro_lifetime",
          expiration_at_ms: null,
          store: "APP_STORE",
        }),
      );
      assertEquals(await res.json(), { received: true, verified: true });
      const row = db.entitlements.get(TEST_USER_ID);
      assertEquals(row?.premium, false);
      assertEquals(row?.product_key, null);
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X11 HELD: cancellation mid-flight — aborting the inbound request signal after the body was read does not stop processing or leave a half-written state (upsert + audit both land)",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      const gate = deferred<void>();
      db.rcHook = async () => {
        await gate.promise;
        return activeSubscriber();
      };
      const controller = new AbortController();
      const base = webhookRequest({
        id: "evt-x11-abort",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      });
      const req = new Request(base, { signal: controller.signal });
      const pending = h.handler(req);
      await sleep(10);
      controller.abort(); // RevenueCat gives up on the delivery while we verify
      gate.resolve();
      const res = await pending;
      assertEquals(await res.json(), { received: true, verified: true });
      assertEquals(db.entitlements.get(TEST_USER_ID)?.premium, true);
      assert(db.webhookEvents.has("evt-x11-abort"));
      // RevenueCat's retry (it saw a dropped connection) is acknowledged as a duplicate
      const retry = await h.handler(
        webhookRequest({ id: "evt-x11-abort", type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(await retry.json(), { received: true, duplicate: true });
    } finally {
      db.restore();
    }
  },
);

Deno.test(
  "X12 HELD: same user, two DIFFERENT event ids racing (EXPIRATION then INITIAL_PURCHASE, RC consistent=active) → both persist active; audit has both rows",
  async () => {
    const h = await loadHarness();
    const db = installAttackDb(h, [TEST_USER_ID]);
    try {
      db.latencyMs = 3;
      h.subscriber = activeSubscriber();
      const rng = seededRandom(SEED + 2);
      const ids = Array.from({ length: 20 }, (_, i) => `evt-x12-${i}`).sort(() => rng() - 0.5);
      const responses = await Promise.all(
        ids.map((id, i) =>
          h.handler(
            webhookRequest(
              { id, type: i % 2 ? "EXPIRATION" : "RENEWAL", app_user_id: TEST_USER_ID },
              { ip: `198.51.101.${i + 1}` },
            ),
          ),
        ),
      );
      for (const r of responses) assertEquals(await r.json(), { received: true, verified: true });
      assertEquals(db.webhookEvents.size, 20);
      assertEquals(db.entitlements.get(TEST_USER_ID)?.premium, true);
    } finally {
      db.restore();
    }
  },
);
