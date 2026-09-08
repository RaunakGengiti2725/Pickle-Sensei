// INT-billing-entitlement adversary (attacked head 30a4065036a917514fb4984fde73f87867f38619).
// Black-box attacks on POST /v1/billing/sync, GET /v1/me/access and
// POST /webhooks/revenuecat through the real Edge handler over the stateful
// ordered-billing simulation. Every test asserts the PRODUCT expectation, so a
// failing test here is a confirmed break of the integration head, not a
// harness artefact.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { fakeSupabaseAccessToken, RC_URL, userRequest, webhookRequest } from "./routesHarness.ts";
import { simulate, type Sim } from "./webhookSim.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const LIFETIME = "pickle_sensei_pro_lifetime";
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
// Each attack runs as a fresh account from a fresh address: the per-user
// billing_sync budget (10/min) and per-IP pre-auth budget are per isolate and
// would otherwise turn later attacks into 429s unrelated to billing truth.
let addressSeq = 0;
const freshIp = () => `198.51.100.${(addressSeq += 1)}`;
const freshOwner = () => crypto.randomUUID();
const entitlement = (expires: string | null, product: string, purchased = at(-86_400_000)) => ({
  expires_date: expires,
  grace_period_expires_date: null,
  product_identifier: product,
  purchase_date: purchased,
});
const evidence = (productId: string, transactionId: string, purchasedAt: string) => ({
  pendingId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  transaction: { productId, transactionId, purchasedAt },
});

interface SyncResult {
  status: number;
  body: Record<string, unknown> & {
    billing?: Record<string, unknown>;
    access?: Record<string, unknown>;
    fulfilment?: Record<string, unknown>;
  };
}

async function syncAs(sim: Sim, owner: string, body: unknown): Promise<SyncResult> {
  sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  const response = await sim.h.handler(
    userRequest("POST", "/v1/billing/sync", {
      body,
      token: fakeSupabaseAccessToken(owner),
      ip: freshIp(),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function withSim<T>(subscriber: Record<string, unknown>, run: (sim: Sim) => Promise<T>) {
  const sim = await simulate();
  try {
    sim.h.subscriber = subscriber;
    return await run(sim);
  } finally {
    sim.restore();
  }
}

// ── ADV-1 lifetime: same Apple transaction, provider purchase_date without the
// sub-second part the evidence carries. The head compares normalised dates
// exactly, so this stays pending; the safe direction (never fulfilling or
// terminating on a non-exact match) is the product guarantee asserted here.
// RevenueCat's SDK formats purchaseDate with ISO8601DateFormatter (whole
// seconds) and the v1 REST purchase_date is whole seconds too, so a
// sub-second disagreement is a provider-format risk, not a shipping path.

Deno.test(
  "ADV-1 lifetime: a matching store_transaction_id whose provider purchase_date differs only in sub-second precision never fulfils and never terminates (pending, premium stays true)",
  async () => {
    const owner = freshOwner();
    const lifetime = evidence(LIFETIME, "1000000652379790", "2026-08-01T12:34:56.417Z");
    const result = await withSim(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME, "2026-08-01T12:34:56Z") },
        non_subscriptions: {
          [LIFETIME]: [
            {
              id: "cadba0c81b",
              store_transaction_id: "1000000652379790",
              purchase_date: "2026-08-01T12:34:56Z",
              store: "app_store",
              is_sandbox: false,
            },
          ],
        },
      },
      (sim) => syncAs(sim, owner, { fulfilment: lifetime }),
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing?.premium, true, "the entitlement is active");
    assertEquals(result.body.access?.premium, true);
    assertEquals(
      result.body.fulfilment?.outcome,
      "pending",
      "a purchase_date that is not byte-equal after normalisation is not proven to be this purchase",
    );
  },
);

Deno.test(
  "ADV-2 lifetime: provider purchase_date expressed with a +00:00 offset still matches the Z-normalised evidence",
  async () => {
    const owner = freshOwner();
    const lifetime = evidence(LIFETIME, "1000000652379790", "2026-08-01T12:34:56.000Z");
    const result = await withSim(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
        non_subscriptions: {
          [LIFETIME]: [
            {
              id: "cadba0c81b",
              store_transaction_id: "1000000652379790",
              purchase_date: "2026-08-01T14:34:56+02:00",
              store: "app_store",
              is_sandbox: false,
            },
          ],
        },
      },
      (sim) => syncAs(sim, owner, { fulfilment: lifetime }),
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
  },
);

// ── ADV-3/4 renewal replaced the latest transaction ─────────────────────────
// RevenueCat's v1 subscriber model keeps ONE record per subscription product
// whose `purchase_date` is the latest purchase/renewal (its documented example
// shows original_purchase_date 2019-02-21 next to purchase_date 2019-07-14),
// and the repo's own readiness note records that a renewal also replaces the
// latest transaction id. The evidence the device durably holds is the ORIGINAL
// transaction (id + purchase date). After the first renewal — a trial→paid
// conversion, a 5-minute sandbox renewal during App Review, or a month in
// production — no provider record can equal that evidence any more.

const lapsedAfterRenewal = (storeTransactionId: string) => ({
  entitlements: {},
  subscriptions: {
    [MONTHLY]: {
      store_transaction_id: storeTransactionId,
      original_purchase_date: "2026-06-01T00:00:00Z",
      purchase_date: "2026-07-01T00:00:00Z",
      expires_date: at(-3_600_000),
      grace_period_expires_date: null,
      refunded_at: null,
      unsubscribe_detected_at: at(-7_200_000),
    },
  },
});

Deno.test(
  "ADV-3a renewal: same store_transaction_id, purchase_date moved to the renewal, subscription lapsed → the purchase must reach a terminal disposition, not pending forever",
  async () => {
    const owner = freshOwner();
    const original = evidence(MONTHLY, "1000000652379790", "2026-06-01T00:00:00.000Z");
    const result = await withSim(lapsedAfterRenewal("1000000652379790"), (sim) =>
      syncAs(sim, owner, { fulfilment: original }),
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing?.premium, false);
    assertEquals(
      result.body.fulfilment?.outcome,
      "expired",
      "the very transaction the evidence names is reported by the provider as lapsed; a pending verdict here locks Continue AND Restore on the device for good",
    );
  },
);

Deno.test(
  "ADV-3b renewal: store_transaction_id AND purchase_date replaced by the renewal, subscription lapsed → the purchase must reach a terminal disposition, not pending forever",
  async () => {
    const owner = freshOwner();
    const original = evidence(MONTHLY, "1000000652379790", "2026-06-01T00:00:00.000Z");
    const result = await withSim(lapsedAfterRenewal("1000000699999999"), (sim) =>
      syncAs(sim, owner, { fulfilment: original }),
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.billing?.premium, false);
    assertEquals(
      result.body.fulfilment?.outcome,
      "expired",
      "the only lineage for this product (original_purchase_date = the evidence's purchase) is lapsed; pending forever blocks re-subscribing on the device",
    );
  },
);

Deno.test(
  "ADV-4 renewal: while the renewed subscription is active the account is premium and the purchase is never reported refunded/expired",
  async () => {
    const owner = freshOwner();
    const original = evidence(MONTHLY, "1000000652379790", "2026-06-01T00:00:00.000Z");
    const result = await withSim(
      {
        entitlements: {
          pickle_sensei_pro: entitlement(at(2_592_000_000), MONTHLY, "2026-08-01T00:00:00Z"),
        },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: "1000000699999999",
            original_purchase_date: "2026-06-01T00:00:00Z",
            purchase_date: "2026-08-01T00:00:00Z",
            expires_date: at(2_592_000_000),
            grace_period_expires_date: null,
            refunded_at: null,
          },
        },
      },
      async (sim) => {
        const sync = await syncAs(sim, owner, { fulfilment: original });
        return { sync, row: sim.entitlementRows.get(owner) };
      },
    );
    assertEquals(result.sync.status, 200);
    assertEquals(result.sync.body.billing?.premium, true);
    assertEquals(result.sync.body.access?.premium, true);
    assertEquals(result.row?.premium, true, "the durable row carries the renewed entitlement");
    assert(
      result.sync.body.fulfilment?.outcome === "fulfilled" ||
        result.sync.body.fulfilment?.outcome === "pending",
      `an active lineage must never be terminal, got ${String(result.sync.body.fulfilment?.outcome)}`,
    );
  },
);

// ── ADV-5 numeric transaction ids ───────────────────────────────────────────

Deno.test(
  "ADV-5 numeric id: a JSON exponent literal is the same integer as the mobile decimal string; a zero-padded string is not",
  async () => {
    const owner = freshOwner();
    const exact = evidence(MONTHLY, "1000000000000000", "2026-08-01T00:00:00.000Z");
    const subscriber = (id: unknown) => ({
      entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
      subscriptions: {
        [MONTHLY]: {
          store_transaction_id: id,
          purchase_date: "2026-08-01T00:00:00Z",
          expires_date: at(60_000),
          refunded_at: null,
        },
      },
    });
    const exponent = await withSim(subscriber(1e15), (sim) =>
      syncAs(sim, owner, { fulfilment: exact }),
    );
    assertEquals(exponent.status, 200);
    assertEquals(exponent.body.fulfilment?.outcome, "fulfilled");

    const padded = await withSim(subscriber("01000000000000000"), (sim) =>
      syncAs(sim, owner, { fulfilment: exact }),
    );
    assertEquals(padded.status, 200);
    assertEquals(padded.body.fulfilment?.outcome, "pending", "string ids are compared verbatim");
    assertEquals(padded.body.billing?.premium, true);
  },
);

// ── ADV-6/7 missing data must never read as refund or expiry ─────────────────

Deno.test(
  "ADV-6 missing data: a subscriber object without any subscriptions/non_subscriptions map leaves the purchase pending and premium false, never expired/refunded",
  async () => {
    const owner = freshOwner();
    const monthly = evidence(MONTHLY, "1000000652379790", "2026-08-01T00:00:00.000Z");
    const result = await withSim({ entitlements: {} }, (sim) =>
      syncAs(sim, owner, { fulfilment: monthly }),
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
    assertEquals(result.body.billing?.premium, false);
  },
);

Deno.test(
  "ADV-7 missing data: a provider answer that has NEVER seen the account (201 Created, empty subscriber) after a verified premium state is never read as a refund/expiry of the device's purchase, and billing/access agree",
  async () => {
    const owner = freshOwner();
    const result = await withSim({ entitlements: {} }, async (sim) => {
      sim.h.subscriber = {
        entitlements: { pickle_sensei_pro: entitlement(at(2_592_000_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: "1000000652379790",
            purchase_date: "2026-08-01T00:00:00Z",
            expires_date: at(2_592_000_000),
            refunded_at: null,
          },
        },
      };
      const monthly = evidence(MONTHLY, "1000000652379790", "2026-08-01T00:00:00.000Z");
      const first = await syncAs(sim, owner, { fulfilment: monthly });
      assertEquals(first.body.billing?.premium, true);
      assertEquals(first.body.fulfilment?.outcome, "fulfilled");
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        status: 201,
        body: { request_date_ms: Date.now(), subscriber: { entitlements: {}, subscriptions: {} } },
      });
      const second = await syncAs(sim, owner, { fulfilment: monthly });
      return { first, second, row: sim.entitlementRows.get(owner), rc: sim.rcCalls() };
    });
    assertEquals(result.rc, 2);
    assertEquals(result.second.status, 200);
    // The head treats RevenueCat as the entitlement authority: an empty
    // subscriber revokes premium (recorded as an observation, not a break).
    // What must never happen is reading that absence as a terminal verdict on
    // the device's purchase, or letting billing and access disagree.
    assertEquals(result.second.body.fulfilment?.outcome, "pending");
    assertEquals(result.second.body.billing?.premium, result.second.body.access?.premium);
    assertEquals(result.row?.premium, result.second.body.billing?.premium);
  },
);

// ── ADV-8 provider clock skew ───────────────────────────────────────────────

Deno.test(
  "ADV-8 clock skew: a provider request_date far in the future is not trusted as verifiedAt, and billing/fulfilment verifiedAt agree",
  async () => {
    const owner = freshOwner();
    const monthly = evidence(MONTHLY, "1000000652379790", "2026-08-01T00:00:00.000Z");
    const before = Date.now();
    const result = await withSim({ entitlements: {} }, async (sim) => {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        subscriber: {
          entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
          subscriptions: {
            [MONTHLY]: {
              store_transaction_id: "1000000652379790",
              purchase_date: "2026-08-01T00:00:00Z",
              expires_date: at(60_000),
              refunded_at: null,
            },
          },
        },
        requestDateMs: Date.now() + 6 * 60_000,
      });
      return await syncAs(sim, owner, { fulfilment: monthly });
    });
    assertEquals(result.status, 200);
    const billingVerifiedAt = Date.parse(String(result.body.billing?.verifiedAt));
    const fulfilmentVerifiedAt = Date.parse(String(result.body.fulfilment?.verifiedAt));
    assert(billingVerifiedAt >= before && billingVerifiedAt <= Date.now() + 1_000);
    assertEquals(fulfilmentVerifiedAt, billingVerifiedAt);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
  },
);

Deno.test(
  "ADV-9 clock skew: a provider clock behind ours (inside tolerance) is the verdict clock and fulfils; a provider clock behind the PURCHASE never settles the purchase in either direction",
  async () => {
    const purchasedAt = at(-30 * 60_000);
    const monthly = () => evidence(MONTHLY, "1000000652379790", purchasedAt);
    const subscriber = {
      entitlements: { pickle_sensei_pro: entitlement(at(2_592_000_000), MONTHLY, purchasedAt) },
      subscriptions: {
        [MONTHLY]: {
          store_transaction_id: "1000000652379790",
          purchase_date: purchasedAt,
          expires_date: at(2_592_000_000),
          refunded_at: null,
        },
      },
    };
    const behindOurs = Date.now() - 10 * 60_000;
    const inTolerance = await withSim({ entitlements: {} }, async (sim) => {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        subscriber,
        requestDateMs: behindOurs,
      });
      return await syncAs(sim, freshOwner(), { fulfilment: monthly() });
    });
    assertEquals(inTolerance.status, 200);
    assertEquals(inTolerance.body.billing?.premium, true);
    assertEquals(inTolerance.body.fulfilment?.outcome, "fulfilled");
    assertEquals(Date.parse(String(inTolerance.body.fulfilment?.verifiedAt)), behindOurs);
    assertEquals(inTolerance.body.billing?.verifiedAt, inTolerance.body.fulfilment?.verifiedAt);

    const beforePurchase = await withSim({ entitlements: {} }, async (sim) => {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        subscriber,
        requestDateMs: Date.now() - 60 * 60_000,
      });
      return await syncAs(sim, freshOwner(), { fulfilment: monthly() });
    });
    assertEquals(beforePurchase.status, 200);
    assertEquals(beforePurchase.body.billing?.premium, true, "the entitlement itself is active");
    assertEquals(
      beforePurchase.body.fulfilment?.outcome,
      "pending",
      "a verdict older than the purchase can neither fulfil nor terminate it",
    );
    assertNotEquals(beforePurchase.body.fulfilment?.outcome, "expired");
    assertNotEquals(beforePurchase.body.fulfilment?.outcome, "refunded");
  },
);

// ── ADV-10 expired premium row ──────────────────────────────────────────────

Deno.test(
  "ADV-10 expired row: a stored premium row past expires_at is not premium for sync-without-provider, access, or the persisted response",
  async () => {
    const owner = freshOwner();
    const result = await withSim({ entitlements: {} }, async (sim) => {
      sim.entitlementRows.set(owner, {
        user_id: owner,
        premium: true,
        product_key: MONTHLY,
        expires_at: at(-1_000),
        active_entitlements: ["pickle_sensei_pro"],
        verified_at: at(-3_600_000),
        verification_order: 1,
      });
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        status: 503,
        body: { message: "provider down" },
      });
      const sync = await sim.h.handler(
        userRequest("POST", "/v1/billing/sync", {
          body: {},
          token: fakeSupabaseAccessToken(owner),
          ip: freshIp(),
        }),
      );
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      const access = await sim.h.handler(
        userRequest("GET", "/v1/me/access", {
          token: fakeSupabaseAccessToken(owner),
          ip: freshIp(),
        }),
      );
      return {
        syncStatus: sync.status,
        syncBody: (await sync.json()) as Record<string, unknown>,
        accessStatus: access.status,
        accessBody: (await access.json()) as Record<string, unknown>,
      };
    });
    assertEquals(result.accessStatus, 200);
    assertEquals(result.accessBody.premium, false);
    assertEquals(result.accessBody.entitlement ?? null, null);
    if (result.syncStatus === 200) {
      const billing = result.syncBody.billing as Record<string, unknown>;
      assertEquals(billing.premium, false, "an expired stored row must not read as premium");
    } else {
      assert(result.syncStatus >= 500, `unexpected sync status ${result.syncStatus}`);
    }
  },
);

// ── ADV-11/12 webhook replay & forged body ──────────────────────────────────

Deno.test(
  "ADV-11 forged webhook: a body claiming a premium grant for another user never grants — the provider truth (no entitlement) wins and the victim's row stays non-premium",
  async () => {
    const owner = freshOwner();
    const result = await withSim({ entitlements: {}, subscriptions: {} }, async (sim) => {
      const event = {
        id: "forged-grant-1",
        type: "INITIAL_PURCHASE",
        app_user_id: owner,
        product_id: LIFETIME,
        entitlement_ids: ["pickle_sensei_pro"],
        expiration_at_ms: null,
        store: "APP_STORE",
      };
      const response = await sim.h.handler(webhookRequest(event, { ip: freshIp() }));
      const replay = await sim.h.handler(webhookRequest(event, { ip: freshIp() }));
      return {
        status: response.status,
        replayStatus: replay.status,
        replayBody: (await replay.json()) as Record<string, unknown>,
        row: sim.entitlementRows.get(owner),
        rc: sim.rcCalls(),
        audit: sim.auditRows.size,
      };
    });
    assertEquals(result.status, 200);
    assertEquals(result.row?.premium, false);
    assertEquals(result.replayStatus, 200);
    assertEquals(result.replayBody.duplicate, true);
    assertEquals(
      result.rc,
      1,
      "a replayed delivery is acknowledged from the audit, not re-verified",
    );
    assertEquals(result.audit, 1);
  },
);

Deno.test(
  "ADV-12 replayed webhook id with a different body is refused, and a wrong secret never reaches the provider",
  async () => {
    const owner = freshOwner();
    const result = await withSim({ entitlements: {}, subscriptions: {} }, async (sim) => {
      const event = { id: "replay-conflict-1", type: "RENEWAL", app_user_id: owner };
      const first = await sim.h.handler(webhookRequest(event, { ip: freshIp() }));
      const conflicting = await sim.h.handler(
        webhookRequest({ ...event, type: "CANCELLATION" }, { ip: freshIp() }),
      );
      const unauthorised = await sim.h.handler(
        webhookRequest(
          { id: "replay-conflict-2", type: "RENEWAL", app_user_id: owner },
          { authorization: "wrong", ip: freshIp() },
        ),
      );
      return {
        first: first.status,
        conflicting: conflicting.status,
        unauthorised: unauthorised.status,
        rc: sim.rcCalls(),
        audit: [...sim.auditRows.keys()],
      };
    });
    assertEquals(result.first, 200);
    assert(
      result.conflicting >= 400,
      `conflicting replay must not be acknowledged, got ${result.conflicting}`,
    );
    assertEquals(result.unauthorised, 401);
    assertEquals(result.rc, 1);
    assertEquals(result.audit, ["replay-conflict-1"]);
  },
);

// ── ADV-13 stale verdict ordering: a slow sync answer must not beat a later webhook ──

Deno.test(
  "ADV-13 ordering: a sync whose provider answer arrives after a later EXPIRATION webhook cannot resurrect premium",
  async () => {
    const owner = freshOwner();
    const result = await withSim({ entitlements: {}, subscriptions: {} }, async (sim) => {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        subscriber: {
          entitlements: { pickle_sensei_pro: entitlement(at(2_592_000_000), MONTHLY) },
          subscriptions: {
            [MONTHLY]: {
              store_transaction_id: "1000000652379790",
              purchase_date: "2026-08-01T00:00:00Z",
              expires_date: at(2_592_000_000),
              refunded_at: null,
            },
          },
        },
        delayMs: 400,
      });
      const slowSync = syncAs(sim, owner, {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      const webhook = await sim.h.handler(
        webhookRequest(
          { id: "expiration-after-sync", type: "EXPIRATION", app_user_id: owner },
          { ip: freshIp() },
        ),
      );
      const sync = await slowSync;
      return { webhook: webhook.status, sync, row: sim.entitlementRows.get(owner) };
    });
    assertEquals(result.webhook, 200);
    assertEquals(result.sync.status, 200);
    assertEquals(
      result.row?.premium,
      false,
      "the webhook verified later; the slow sync verdict is stale",
    );
    assertEquals(
      result.sync.body.billing?.premium,
      false,
      "the sync answers with the canonical (newer) state, not its own stale verdict",
    );
    assertEquals(result.sync.body.access?.premium, false);
  },
);
