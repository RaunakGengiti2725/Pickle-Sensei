// ADVERSARIAL suite for fix round 3, area `billing-webhook` (ADJ-1/2/3).
//
// Attacks the candidate `devin/fix2-billing-webhook-adj-1-2-3` merged onto
// the integration branch (3bd08da5). Each test states the contract it
// attacks; tests whose name starts with "ATK-BREAK" are EXPECTED TO FAIL on
// the candidate and expose a real defect (observed vs expected in the
// assertion message). Every other ATK test held on the candidate and is kept
// as a regression pin.
//
// The PostgREST/RevenueCat plane is webhookSim.ts (stateful rows, faults).
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_fix3_billing.test.ts

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
  simulate,
  sleep,
} from "./webhookSim.ts";

const ACCESS_ROW = [{ premium: true, scored_count: 0, reserved_count: 0 }];

const rcFor = (userId: string) => `${RC_URL}${encodeURIComponent(userId)}`;

const drain = async (responses: Response[]) =>
  await Promise.all(
    responses.map(async (r) => ({
      status: r.status,
      retryAfter: r.headers.get("Retry-After"),
      body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    })),
  );

// ── 0. migration ordering (hosted `supabase db push` applies by name) ───────

Deno.test(
  "ATK-BREAK-0: the candidate's new migration must sort AFTER every migration already on the integration branch (remote history is name-ordered)",
  () => {
    const dir = new URL("../../../migrations/", import.meta.url);
    const names = [...Deno.readDirSync(dir)]
      .filter((e) => e.isFile && e.name.endsWith(".sql"))
      .map((e) => e.name)
      .sort();
    const candidate = names.find((n) =>
      n.includes("webhook_reservation_and_monotonic_verified_at"),
    );
    assert(candidate, "candidate migration present");
    const later = names.filter((n) => n > candidate);
    assertEquals(
      later,
      [],
      `observed: ${candidate} sorts BEFORE ${later.join(", ")} which already exist on 3bd08da5; ` +
        `expected: a migration introduced on top of the integration branch is timestamped after its newest migration ` +
        `(hosted db push applies in filename order and refuses out-of-order local files without --include-all)`,
    );
  },
);

// ── 1. concurrency ≥ 50 ──────────────────────────────────────────────────────

Deno.test(
  "ATK-1: 50 concurrent deliveries of one id → exactly 1 RC call, 1 upsert, 1 audit row, 1×200 verified and 49×200 duplicate:true (losers wait for the owner, no 5xx); replay is a duplicate ack",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        delayMs: 40,
        subscriber: activeSubscriber(),
        times: 50,
      });
      const event = { id: "atk-conc-50", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const results = await drain(
        await Promise.all(Array.from({ length: 50 }, () => sim.h.handler(webhookRequest(event)))),
      );
      assert(
        results.every((r) => r.status === 200),
        `no 5xx in a burst: ${JSON.stringify(results.map((r) => r.status))}`,
      );
      const owners = results.filter((r) => r.body.verified === true);
      const duplicates = results.filter((r) => r.body.duplicate === true);
      assertEquals(owners.length, 1, "exactly one owner");
      assertEquals(owners[0].body, { received: true, verified: true });
      assertEquals(duplicates.length, 49, "every loser acked only once the owner finalized");
      assert(duplicates.every((r) => r.body.verified === undefined));
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      assertEquals(sim.auditRows.size, 1);
      assertEquals(sim.auditPatches(), 1, "one completion PATCH: losers never write the audit row");
      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(await replay.json(), { received: true, duplicate: true });
      assertEquals(sim.rcCalls(), 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-2: 50 concurrent deliveries while RevenueCat is 5xx → every copy 503, 0 upserts, reservation released; the redelivery processes exactly once",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        delayMs: 30,
        status: 503,
        body: { message: "upstream down" },
        times: 1,
      });
      const event = { id: "atk-conc-rc-down", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const results = await drain(
        await Promise.all(Array.from({ length: 50 }, () => sim.h.handler(webhookRequest(event)))),
      );
      assert(
        results.every((r) => r.status === 503),
        `all 503: ${JSON.stringify(results.map((r) => r.status))}`,
      );
      assertEquals(sim.rcCalls(), 1, "only the owner reached RevenueCat");
      assertEquals(sim.entitlementUpserts(), 0);
      assertEquals(sim.auditRows.has("atk-conc-rc-down"), false, "reservation released");

      sim.h.subscriber = activeSubscriber();
      const redelivery = await sim.h.handler(webhookRequest(event));
      assertEquals(await redelivery.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.entitlementUpserts(), 1);
      assert(typeof sim.auditRows.get("atk-conc-rc-down")?.processed_at === "string");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-3: owner fails AND its release DELETE fails → nobody acks 200; the row stays reserved so the in-lease redelivery is refused (never re-verified twice, never a false duplicate)",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        status: 502,
        times: 1,
      });
      sim.faults.push({
        match: (m, u) => m === "DELETE" && u.startsWith(EVENTS_URL),
        ...dbUnavailable,
        times: 1,
      });
      const event = { id: "atk-release-fails", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 503);
      await first.text();
      const row = sim.auditRows.get("atk-release-fails");
      assert(row && row.processed_at === null, "row stays in flight");

      sim.h.subscriber = activeSubscriber();
      const redelivery = await sim.h.handler(webhookRequest(event));
      assertEquals(redelivery.status, 503);
      assertEquals(redelivery.headers.get("Retry-After"), "30");
      const body = (await redelivery.json()) as Record<string, unknown>;
      assertEquals(body.duplicate, undefined, "an unprocessed row is never a duplicate ack");
      assertEquals(sim.rcCalls(), 1, "no second verification inside the lease");
      assertEquals(sim.entitlementUpserts(), 0);
    } finally {
      sim.restore();
    }
  },
);

// ── 2. ordering ─────────────────────────────────────────────────────────────

Deno.test(
  "ATK-4: 20 concurrent deliveries of DISTINCT ids for one user with shuffled RC latencies/verdicts → all 200, stored row is the LAST-STARTED delivery's verdict",
  async () => {
    const sim = await simulate();
    try {
      const n = 20;
      const verdicts: Array<Record<string, unknown>> = [];
      const starts: Promise<Response>[] = [];
      for (let i = 0; i < n; i++) {
        // latency decreases with i: the earliest-started delivery answers last
        const premium = i % 3 !== 0;
        const sub = premium ? activeSubscriber() : expiredSubscriber();
        verdicts.push(sub);
        sim.faults.push({
          match: (_m, u) => u.startsWith(RC_URL),
          delayMs: 20 + (n - i) * 10,
          subscriber: sub,
          times: 1,
        });
        starts.push(
          sim.h.handler(
            webhookRequest({
              id: `atk-order-${i}`,
              type: premium ? "RENEWAL" : "EXPIRATION",
              app_user_id: TEST_USER_ID,
            }),
          ),
        );
        await sleep(5);
      }
      const results = await drain(await Promise.all(starts));
      assert(
        results.every((r) => r.status === 200),
        JSON.stringify(results.map((r) => r.status)),
      );
      assertEquals(sim.rcCalls(), n);
      assertEquals(sim.entitlementUpserts(), n);
      const last = verdicts[n - 1];
      const lastPremium =
        (last.entitlements as Record<string, Record<string, unknown>>).pickle_sensei_pro
          .expires_date !== null &&
        Date.parse(
          String(
            (last.entitlements as Record<string, Record<string, unknown>>).pickle_sensei_pro
              .expires_date,
          ),
        ) > Date.now();
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, lastPremium, "newest verified_at wins regardless of arrival");
      const verifiedAts = sim.h
        .callsTo(ENTITLEMENTS_URL)
        .filter((c) => c.method === "POST")
        .map((c) => Date.parse(String((c.body as Record<string, unknown>).verified_at)));
      assertEquals(Date.parse(String(row?.verified_at)), Math.max(...verifiedAts));
      assertEquals(sim.auditRows.size, n);
      assert([...sim.auditRows.values()].every((r) => typeof r.processed_at === "string"));
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-BREAK-5: POST /v1/billing/sync whose verdict is superseded by a newer webhook verdict tells the client the DROPPED verdict (billing.premium=true) while billing_entitlements says premium=false",
  async () => {
    const sim = await simulate();
    try {
      sim.h.rpcs["access_state"] = ACCESS_ROW;
      // sync starts first, RevenueCat answers it slowly with premium
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        delayMs: 300,
        subscriber: activeSubscriber(),
        times: 1,
      });
      // a webhook for the same user starts later and is answered first: expired
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        times: 1,
      });
      const sync = sim.h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.5" }));
      await sleep(20);
      const hook = await sim.h.handler(
        webhookRequest({ id: "atk-sync-race", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      assertEquals(hook.status, 200);
      assertEquals(await hook.json(), { received: true, verified: true });
      const syncRes = await sync;
      assertEquals(syncRes.status, 200);
      const body = (await syncRes.json()) as {
        billing: { premium: boolean; verifiedAt: string };
        access: { premium: boolean };
      };
      const stored = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(stored?.premium, false, "DB keeps the newer (expired) verdict — by design");
      assertEquals(
        sim.entitlementWrites.length,
        1,
        "the sync's stale write was dropped — by design",
      );
      // The fix's own rationale: "A dropped write is not an error — the stored
      // row is the more recent truth." The response must then not contradict it.
      assertEquals(
        body.billing.premium,
        stored?.premium,
        `observed: sync answers billing.premium=${body.billing.premium} access.premium=${body.access.premium} ` +
          `after its verdict was dropped as stale; expected: the response reflects the persisted verdict ` +
          `(premium=${stored?.premium}) or re-reads it — the client now shows premium until the next access read flips it`,
      );
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-6: two deliveries whose verified_at fall in the same millisecond — the row ends on ONE of the two verdicts and both are acked (no crash, no drop of both)",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        subscriber: activeSubscriber(),
        times: 1,
      });
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        subscriber: expiredSubscriber(),
        times: 1,
      });
      const results = await drain(
        await Promise.all([
          sim.h.handler(
            webhookRequest({ id: "atk-same-ms-a", type: "RENEWAL", app_user_id: TEST_USER_ID }),
          ),
          sim.h.handler(
            webhookRequest({ id: "atk-same-ms-b", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
          ),
        ]),
      );
      assertEquals(
        results.map((r) => r.status),
        [200, 200],
      );
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assert(row, "a row exists");
      assertEquals(sim.entitlementUpserts(), 2);
      assert(sim.entitlementWrites.length >= 1);
    } finally {
      sim.restore();
    }
  },
);

// ── 3. TRANSFER with two subjects ───────────────────────────────────────────

Deno.test(
  "ATK-7: TRANSFER A→B where B's write is transient → 503, A's already-landed revoke is NOT acked, reservation released; redelivery re-verifies BOTH and lands both",
  async () => {
    const sim = await simulate();
    try {
      sim.entitlementRows.set(TEST_USER_ID, {
        user_id: TEST_USER_ID,
        premium: true,
        product_key: "pickle_sensei_pro_monthly",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        verified_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(TEST_USER_ID),
        subscriber: expiredSubscriber(),
        times: 2,
      });
      sim.faults.push({
        match: (m, u) => m === "GET" && u === rcFor(OTHER_USER_ID),
        subscriber: activeSubscriber(),
        times: 2,
      });
      let entitlementPosts = 0;
      sim.faults.push({
        match: (m, u) => {
          if (m !== "POST" || !u.startsWith(ENTITLEMENTS_URL)) return false;
          entitlementPosts += 1;
          return entitlementPosts === 2; // B's write
        },
        ...dbUnavailable,
        times: 1,
      });
      const event = {
        id: "atk-transfer-partial",
        type: "TRANSFER",
        transferred_from: [TEST_USER_ID],
        transferred_to: [OTHER_USER_ID],
      };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 503);
      await first.text();
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.auditRows.has("atk-transfer-partial"), false, "released");
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false, "A's revoke landed");
      assertEquals(sim.entitlementRows.has(OTHER_USER_ID), false, "B untouched");

      const redelivery = await sim.h.handler(webhookRequest(event));
      assertEquals(await redelivery.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 4, "both subjects re-verified");
      assertEquals(sim.entitlementRows.get(TEST_USER_ID)?.premium, false);
      assertEquals(sim.entitlementRows.get(OTHER_USER_ID)?.premium, true);
      const audit = sim.auditRows.get("atk-transfer-partial");
      assert(audit && typeof audit.processed_at === "string");
      assertEquals(audit.app_user_id, TEST_USER_ID);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-8: TRANSFER with the same uuid on both sides and non-uuid noise → one verification, one write, 200",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      const res = await sim.h.handler(
        webhookRequest({
          id: "atk-transfer-self",
          type: "TRANSFER",
          app_user_id: "$RCAnonymousID:abc",
          aliases: ["not-a-uuid", TEST_USER_ID],
          transferred_from: [TEST_USER_ID, "junk", 42, null],
          transferred_to: [TEST_USER_ID],
        }),
      );
      assertEquals(await res.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
    } finally {
      sim.restore();
    }
  },
);

// ── 4. malformed input / auth ───────────────────────────────────────────────

Deno.test(
  "ATK-9: malformed bodies (bad JSON, array event, string event, empty body, event:null) → 400, zero RC/DB traffic, no reservation",
  async () => {
    const sim = await simulate();
    try {
      const bodies = [
        "{not json",
        '{"event": []}',
        '{"event": "x"}',
        "",
        '{"event": null}',
        "[]",
        "null",
      ];
      for (const rawBody of bodies) {
        const res = await sim.h.handler(webhookRequest(null, { rawBody }));
        assertEquals(res.status, 400, `body ${JSON.stringify(rawBody)}`);
        await res.text();
      }
      assertEquals(sim.rcCalls(), 0);
      assertEquals(sim.auditUpserts(), 0);
      assertEquals(sim.auditRows.size, 0);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-10: wrong/missing/prefix/suffix/case Authorization → 401 with zero reservation traffic even for a well-formed event",
  async () => {
    const sim = await simulate();
    try {
      const event = { id: "atk-auth", type: "RENEWAL", app_user_id: TEST_USER_ID };
      // (leading/trailing whitespace is stripped by the Fetch Headers object
      // itself before the handler sees it, so it is not a distinct variant)
      for (const authorization of [
        null,
        "",
        "WF-TEST-WEBHOOK-SECRET",
        "Bearer wf-test-webhook-secret",
        "wf-test-webhook-secre",
        "wf-test-webhook-secretx",
        "wf-test-webhook-secret, wf-test-webhook-secret",
      ]) {
        const res = await sim.h.handler(webhookRequest(event, { authorization }));
        assertEquals(res.status, 401, `authorization ${JSON.stringify(authorization)}`);
        await res.text();
      }
      assertEquals(sim.rcCalls(), 0);
      assertEquals(sim.auditUpserts(), 0);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-11: unicode / whitespace / 2000-char event ids reserve, process, and dedupe by EXACT id — mutated ids (case, trailing space, zero-width) are distinct events",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      const ids = [
        "评估-😀-\u200b-ид",
        "评估-😀-\u200b-ид ",
        "评估-😀-\u200B-ИД",
        "x".repeat(2000),
        "x".repeat(2000) + "\u200b",
      ];
      for (const id of ids) {
        const res = await sim.h.handler(
          webhookRequest({ id, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(await res.json(), { received: true, verified: true }, JSON.stringify(id));
      }
      assertEquals(sim.rcCalls(), ids.length, "each distinct id is verified once");
      for (const id of ids) {
        const replay = await sim.h.handler(
          webhookRequest({ id, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(await replay.json(), { received: true, duplicate: true }, JSON.stringify(id));
      }
      assertEquals(sim.rcCalls(), ids.length);
      assertEquals(sim.auditRows.size, ids.length);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-12: event ids that are not strings (number/object/missing) are never deduped — each delivery is verified (same as base; RevenueCat always sends a string id)",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = activeSubscriber();
      for (const id of [1, { a: 1 }, undefined, 1]) {
        const res = await sim.h.handler(
          webhookRequest({ id, type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(await res.json(), { received: true, verified: true });
      }
      assertEquals(sim.rcCalls(), 4);
      assertEquals(sim.auditRows.size, 4);
    } finally {
      sim.restore();
    }
  },
);

// ── 5. leases / reclaim ─────────────────────────────────────────────────────

Deno.test(
  "ATK-13: redeliveries racing on an orphaned (lease-lapsed) reservation → exactly one reclaims and verifies; the others wait for it and ack duplicate:true only once the row is processed",
  async () => {
    const sim = await simulate();
    try {
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      sim.auditRows.set("atk-orphan-race", {
        id: "atk-orphan-race",
        provider: "revenuecat",
        event_type: "RENEWAL",
        app_user_id: TEST_USER_ID,
        payload: {},
        received_at: stale,
        claimed_at: stale,
        processed_at: null,
      });
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        delayMs: 40,
        subscriber: activeSubscriber(),
        times: 8,
      });
      const event = { id: "atk-orphan-race", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const results = await drain(
        await Promise.all(Array.from({ length: 8 }, () => sim.h.handler(webhookRequest(event)))),
      );
      const detail = JSON.stringify(results.map((r) => [r.status, r.body]));
      assert(
        results.every((r) => r.status === 200),
        detail,
      );
      const owners = results.filter((r) => r.body.verified === true);
      assertEquals(owners.length, 1, detail);
      assertEquals(owners[0].body, { received: true, verified: true });
      assertEquals(results.filter((r) => r.body.duplicate === true).length, 7, detail);
      assertEquals(sim.rcCalls(), 1);
      assertEquals(sim.entitlementUpserts(), 1);
      assertEquals(sim.auditRows.size, 1);
      const row = sim.auditRows.get("atk-orphan-race");
      assert(row && typeof row.processed_at === "string");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-14: completion PATCH fails → 503; the in-lease redelivery waits out the bound and is refused without RC traffic; once the lease lapses the reclaim re-verifies and marks the row processed",
  async () => {
    const sim = await simulate();
    Deno.env.set("WEBHOOK_DUPLICATE_WAIT_MS", "120");
    Deno.env.set("WEBHOOK_DUPLICATE_POLL_MS", "20");
    try {
      sim.h.subscriber = activeSubscriber();
      sim.faults.push({
        match: (m, u) => m === "PATCH" && u.startsWith(EVENTS_URL),
        ...dbUnavailable,
        times: 1,
      });
      const event = { id: "atk-complete-fails", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 503);
      assertEquals(first.headers.get("Retry-After"), "30");
      await first.text();
      assertEquals(sim.entitlementUpserts(), 1, "verdict persisted");
      const row = sim.auditRows.get("atk-complete-fails");
      assert(row && row.processed_at === null);

      const inLeaseStarted = Date.now();
      const inLease = await sim.h.handler(webhookRequest(event));
      assertEquals(inLease.status, 503);
      assertEquals(inLease.headers.get("Retry-After"), "30");
      await inLease.text();
      assert(Date.now() - inLeaseStarted >= 100, "the duplicate waited out the configured bound");
      assertEquals(sim.rcCalls(), 1);

      // lease lapses (the isolate is assumed dead by now)
      row.claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
      const reclaim = await sim.h.handler(webhookRequest(event));
      assertEquals(await reclaim.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2);
      assertEquals(sim.entitlementUpserts(), 2);
      assertEquals(
        sim.entitlementWrites.length,
        2,
        "the re-verification's newer verified_at is accepted",
      );
      assert(typeof sim.auditRows.get("atk-complete-fails")?.processed_at === "string");
    } finally {
      Deno.env.delete("WEBHOOK_DUPLICATE_WAIT_MS");
      Deno.env.delete("WEBHOOK_DUPLICATE_POLL_MS");
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-15: a duplicate that arrives between the owner's failure and RevenueCat's redelivery becomes the new owner (released id is re-reserved, not refused forever)",
  async () => {
    const sim = await simulate();
    try {
      sim.faults.push({
        match: (_m, u) => u.startsWith(RC_URL),
        status: 500,
        times: 1,
      });
      const event = { id: "atk-released-then-dup", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const first = await sim.h.handler(webhookRequest(event));
      assertEquals(first.status, 503);
      await first.text();
      sim.h.subscriber = activeSubscriber();
      const dup = await sim.h.handler(webhookRequest(event));
      assertEquals(await dup.json(), { received: true, verified: true });
      assertEquals(sim.rcCalls(), 2);
    } finally {
      sim.restore();
    }
  },
);

// ── 6. body never trusted / audit invariants ────────────────────────────────

Deno.test(
  "ATK-16: a forged INITIAL_PURCHASE for a non-subscriber persists premium:false (RevenueCat truth) and the audit row records the lying payload",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = { entitlements: {} };
      const res = await sim.h.handler(
        webhookRequest({
          id: "atk-forged",
          type: "INITIAL_PURCHASE",
          app_user_id: TEST_USER_ID,
          entitlement_ids: ["pickle_sensei_pro"],
          product_id: "pickle_sensei_pro_lifetime",
          expiration_at_ms: null,
        }),
      );
      assertEquals(await res.json(), { received: true, verified: true });
      const row = sim.entitlementRows.get(TEST_USER_ID);
      assertEquals(row?.premium, false);
      assertEquals(row?.product_key, null);
      const audit = sim.auditRows.get("atk-forged");
      assertEquals(audit?.event_type, "INITIAL_PURCHASE");
      assertEquals(
        ((audit?.payload as Record<string, unknown>).event as Record<string, unknown>).product_id,
        "pickle_sensei_pro_lifetime",
      );
      const post = sim.h.callsTo(ENTITLEMENTS_URL)[0];
      assertEquals(post.headers["authorization"], "Bearer service-role-test-key");
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK-17: no-subject event (anonymous app_user_id, no aliases) is acked verified:false with a processed audit row and zero RC traffic; its replay is a duplicate",
  async () => {
    const sim = await simulate();
    try {
      const event = { id: "atk-anon", type: "RENEWAL", app_user_id: "$RCAnonymousID:zzz" };
      const res = await sim.h.handler(webhookRequest(event));
      assertEquals(await res.json(), { received: true, verified: false });
      assertEquals(sim.rcCalls(), 0);
      const row = sim.auditRows.get("atk-anon");
      assert(row && typeof row.processed_at === "string");
      assertEquals(row.app_user_id, null);
      const replay = await sim.h.handler(webhookRequest(event));
      assertEquals(await replay.json(), { received: true, duplicate: true });
    } finally {
      sim.restore();
    }
  },
);
