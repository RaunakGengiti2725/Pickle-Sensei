// W07-02 adversary, round 3 — attacks on the lineage fulfilment rule at commit
// 1ded56a3 (`subscriptionLineageRow`, `subscriberIdentifiesTransaction`, the
// widened `billingFulfilmentOf`). Every test runs the real edge handler through
// the webhook simulation and encodes what the reconciliation contract REQUIRES:
// a journaled purchase settles only against provable, unambiguous provider
// evidence; a lineage row may never be MORE permissive than an exact-id row;
// provider/persistence failures never yield a verdict; another account's
// session never settles the evidence; a fulfilment sync never touches the
// free-rating ledger. A failing test here is a confirmed break of the
// candidate, not a style opinion.
//
// Attack map:
//   B1  refunded lineage row + still-active entitlement: parity with the exact-id rule
//   B2  interleaved account switch: A's lineage never settles B's replay; service/anon refused
//   B3  verdict superseded between provider verification and persistence
//   B4  provider 429 / 5xx / malformed 200 and persistence 5xx with evidence attached
//   B5  unidentifiable latest transaction ids (negative, fractional, > 2^53, bool, object, "")
//   B6  provider clocks far ahead / far behind, future-dated renewals, clock rollback
//   B7  evidence boundary: 256/257-char ids, path characters, calendar-invalid dates
//   B8  free-rating conservation: a fulfilment sync never charges or reserves
//   B9  replay: identical evidence replayed is idempotent, lapse settles once, terminally
//   B10 second-precision provider dates against millisecond device evidence
//   B11 grace horizon on a lineage row (garbage, live grace, ended grace)

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { simulate } from "./webhookSim.ts";
import { fakeSupabaseAccessToken, RC_URL, userRequest } from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const ANNUAL = "pickle_sensei_pro_annual";
const DAY = 86_400_000;
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const seconds = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");

const FIRST_ID = "2000000811111111";
const FIRST_AT = at(-120 * DAY);
const JOURNALED_ID = "2000000833333333";
const JOURNALED_AT = at(-35 * DAY);
const RENEWAL_ID = "2000000822222222";
const RENEWAL_AT = at(-5 * DAY);

type Evidence = { productId: string; transactionId: string; purchasedAt: string };

function evidence(overrides: Partial<Evidence> = {}) {
  return {
    pendingId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    transaction: {
      productId: MONTHLY,
      transactionId: JOURNALED_ID,
      purchasedAt: JOURNALED_AT,
      ...overrides,
    },
  };
}

function lineageRow(
  overrides: Record<string, unknown> = {},
  expiresDate: string | null = at(25 * DAY),
): Record<string, unknown> {
  return {
    store: "app_store",
    is_sandbox: false,
    period_type: "normal",
    ownership_type: "PURCHASED",
    store_transaction_id: RENEWAL_ID,
    purchase_date: RENEWAL_AT,
    original_purchase_date: FIRST_AT,
    expires_date: expiresDate,
    grace_period_expires_date: null,
    unsubscribe_detected_at: null,
    billing_issues_detected_at: null,
    refunded_at: null,
    ...overrides,
  };
}

/** The same subscription BEFORE the renewal: the journaled id IS the latest id. */
function directRow(
  overrides: Record<string, unknown> = {},
  expiresDate: string | null = at(25 * DAY),
): Record<string, unknown> {
  return lineageRow(
    { store_transaction_id: JOURNALED_ID, purchase_date: JOURNALED_AT, ...overrides },
    expiresDate,
  );
}

function subscriberOf(
  subscriptions: Record<string, Record<string, unknown>>,
  options: { entitledProduct?: string | null; nonSubscriptions?: Record<string, unknown[]> } = {},
): Record<string, unknown> {
  const entitledProduct = options.entitledProduct === undefined ? MONTHLY : options.entitledProduct;
  const row = entitledProduct === null ? undefined : subscriptions[entitledProduct];
  return {
    entitlements:
      row === undefined
        ? {}
        : {
            pickle_sensei_pro: {
              expires_date: row.expires_date,
              purchase_date: row.purchase_date,
              product_identifier: entitledProduct,
            },
          },
    subscriptions,
    non_subscriptions: options.nonSubscriptions ?? {},
  };
}

type SyncBody = Record<string, unknown> & {
  billing?: Record<string, unknown>;
  fulfilment?: Record<string, unknown>;
  access?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

async function parse(response: Response): Promise<{ status: number; body: SyncBody }> {
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as SyncBody };
}

const ACCESS_STATE = [{ premium: false, scored_count: 0, reserved_count: 0 }];

async function sync(
  subscriberBody: Record<string, unknown>,
  body: unknown,
  options: { requestDateMs?: number | null; token?: string | null } = {},
) {
  const sim = await simulate();
  const owner = crypto.randomUUID();
  try {
    sim.h.subscriber = subscriberBody;
    sim.h.rpcs.access_state = ACCESS_STATE;
    if (options.requestDateMs !== undefined) {
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        subscriber: subscriberBody,
        requestDateMs: options.requestDateMs,
      });
    }
    const request = userRequest("POST", "/v1/billing/sync", {
      body,
      token: options.token === undefined ? fakeSupabaseAccessToken(owner) : undefined,
    });
    if (options.token === null) request.headers.delete("Authorization");
    else if (options.token !== undefined) request.headers.set("Authorization", options.token);
    const startedAt = Date.now();
    const result = await parse(await sim.h.handler(request));
    return {
      ...result,
      startedAt,
      finishedAt: Date.now(),
      writes: sim.entitlementWrites.length,
      rcCalls: sim.rcCalls(),
      errors: sim.errors,
      calls: sim.h.calls.map((call) => `${call.method} ${call.url}`),
    };
  } finally {
    sim.restore();
  }
}

const outcome = (r: { body: SyncBody }) => r.body.fulfilment?.outcome;

// ── B1: lineage parity with the exact-id rule ─────────────────────────────────

Deno.test(
  "ATTACK B1: a refunded row whose entitlement is still active is contradictory — the lineage rule must not be more permissive than the exact-id rule",
  async () => {
    // Exact-id contract (unchanged by the candidate): a row carrying
    // refunded_at while the entitlement is still active is contradictory
    // evidence and the purchase stays pending. The same row reached through
    // the lineage fallback must settle no differently — the lineage rule may
    // only be STRICTER than the direct rule, never looser.
    const refundedAt = at(-2 * DAY);
    const direct = await sync(subscriberOf({ [MONTHLY]: directRow({ refunded_at: refundedAt }) }), {
      fulfilment: evidence(),
    });
    assertEquals(direct.status, 200);
    assertEquals(outcome(direct), "pending", "exact-id row: refund + active entitlement");

    const lineage = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ refunded_at: refundedAt }) }),
      { fulfilment: evidence() },
    );
    assertEquals(lineage.status, 200);
    assertEquals(
      outcome(lineage),
      outcome(direct),
      "lineage row with refunded_at + active entitlement must settle exactly like the exact-id row",
    );
  },
);

// ── B2: interleaved account switch ────────────────────────────────────────────

Deno.test(
  "ATTACK B2: evidence journaled by account A, replayed under account B's session, never settles against A's lineage; service and anonymous callers get no verdict",
  async () => {
    const sim = await simulate();
    try {
      const ownerA = crypto.randomUUID();
      const ownerB = crypto.randomUUID();
      sim.h.subscriber = { entitlements: {}, subscriptions: {}, non_subscriptions: {} };
      sim.h.rpcs.access_state = ACCESS_STATE;
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL) && url.includes(ownerA),
        subscriber: subscriberOf({ [MONTHLY]: lineageRow() }),
        times: 10,
      });
      const journaled = evidence();
      const [a, b] = await Promise.all([
        sim.h
          .handler(
            userRequest("POST", "/v1/billing/sync", {
              body: { fulfilment: journaled },
              token: fakeSupabaseAccessToken(ownerA),
            }),
          )
          .then(parse),
        sim.h
          .handler(
            userRequest("POST", "/v1/billing/sync", {
              body: { fulfilment: journaled },
              token: fakeSupabaseAccessToken(ownerB),
            }),
          )
          .then(parse),
      ]);
      assertEquals(a.status, 200);
      assertEquals(outcome(a), "fulfilled");
      assertEquals(a.body.billing?.premium, true);
      assertEquals(b.status, 200);
      assertEquals(outcome(b), "pending", "B does not own the lineage");
      assertEquals(b.body.billing?.premium, false);
      assertEquals(b.body.fulfilment?.pendingId, journaled.pendingId);
      assertEquals(sim.entitlementRows.get(ownerA)?.premium, true);
      assertEquals(sim.entitlementRows.get(ownerB)?.premium, false);
      const rcSubjects = sim.h
        .callsTo(RC_URL)
        .map((call) => decodeURIComponent(call.url.slice(RC_URL.length)));
      assertEquals(rcSubjects.sort(), [ownerA, ownerB].sort(), "each session verifies itself");

      const before = sim.rcCalls();
      for (const token of ["Bearer service-role-test-key", "Bearer anon-test-key", null]) {
        const request = userRequest("POST", "/v1/billing/sync", {
          body: { fulfilment: journaled },
          token: fakeSupabaseAccessToken(ownerA),
        });
        if (token === null) request.headers.delete("Authorization");
        else request.headers.set("Authorization", token);
        const refused = await parse(await sim.h.handler(request));
        assertEquals(refused.status, 401, String(token));
        assertEquals(refused.body.fulfilment, undefined, String(token));
      }
      assertEquals(sim.rcCalls(), before, "no provider call for an unauthenticated caller");
      assertEquals(sim.errors, []);
    } finally {
      sim.restore();
    }
  },
);

// ── B3: verdict superseded between verification and persistence ──────────────

Deno.test(
  "ATTACK B3: a fulfilment verdict superseded between provider verification and persistence never reports 'fulfilled' for a verdict that was dropped",
  async () => {
    const sim = await simulate();
    try {
      const owner = crypto.randomUUID();
      sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
      sim.h.rpcs.access_state = ACCESS_STATE;
      // The FIRST provider round trip is slow; a second sync for the same
      // purchase completes and persists first. The first verdict is then stale
      // (persist_billing_verdict keeps the newest verified_at) and must not be
      // reported as if it had been applied.
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        delayMs: 400,
        times: 1,
      });
      const journaled = evidence();
      const token = fakeSupabaseAccessToken(owner);
      const first = sim.h
        .handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        )
        .then(parse);
      for (let i = 0; i < 50 && sim.rcCalls() < 1; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(sim.rcCalls(), 1, "first request is parked at the provider");
      const second = await sim.h
        .handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        )
        .then(parse);
      const slow = await first;

      assertEquals(second.status, 200);
      assertEquals(outcome(second), "fulfilled");
      assertEquals(second.body.billing?.premium, true);

      assertEquals(slow.status, 200);
      assertEquals(sim.verdictResults.length, 2);
      const applied = sim.verdictResults.filter((row) => row.applied === true);
      assertEquals(applied.length, 1, "exactly one verdict was applied");
      assertEquals(sim.entitlementWrites.length, 1, "the dropped verdict wrote nothing");
      // A response may claim 'fulfilled' only when its own verdict was applied.
      assertEquals(
        outcome(slow),
        "pending",
        "the superseded verdict must not be reported as fulfilled",
      );
      assertEquals(slow.body.billing?.premium, true, "but the stored truth is still served");
      assertEquals(slow.body.fulfilment?.pendingId, journaled.pendingId);
      assertEquals(sim.errors, []);
    } finally {
      sim.restore();
    }
  },
);

// ── B4: provider / persistence failures with evidence attached ────────────────

Deno.test(
  "ATTACK B4: provider 429 / 5xx / malformed 200 and persistence 5xx with evidence attached never yield a fulfilment verdict nor an entitlement write",
  async () => {
    const providerFaults: Array<{ label: string; status: number; body: unknown }> = [
      { label: "429", status: 429, body: { code: 7000, message: "rate limited" } },
      { label: "500", status: 500, body: { message: "upstream" } },
      { label: "503", status: 503, body: "" },
      {
        label: "200 subscriber is an array",
        status: 200,
        body: { request_date_ms: Date.now(), subscriber: [] },
      },
      {
        label: "200 subscriptions is an array",
        status: 200,
        body: {
          request_date_ms: Date.now(),
          subscriber: { entitlements: {}, subscriptions: [lineageRow()], non_subscriptions: {} },
        },
      },
      {
        label: "200 without entitlements",
        status: 200,
        body: {
          request_date_ms: Date.now(),
          subscriber: { subscriptions: { [MONTHLY]: lineageRow() }, non_subscriptions: {} },
        },
      },
      { label: "200 non-JSON body", status: 200, body: "<html>maintenance</html>" },
    ];
    for (const fault of providerFaults) {
      const sim = await simulate();
      try {
        sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
        sim.h.rpcs.access_state = ACCESS_STATE;
        sim.faults.push({
          match: (method, url) => method === "GET" && url.startsWith(RC_URL),
          status: fault.status,
          body: fault.body,
          times: 10,
        });
        const result = await parse(
          await sim.h.handler(
            userRequest("POST", "/v1/billing/sync", {
              body: { fulfilment: evidence() },
              token: fakeSupabaseAccessToken(crypto.randomUUID()),
            }),
          ),
        );
        assertEquals(result.status, 502, fault.label);
        assertEquals(result.body.error?.code, "billing_unavailable", fault.label);
        assertEquals(result.body.fulfilment, undefined, fault.label);
        assertEquals(sim.entitlementWrites.length, 0, fault.label);
      } finally {
        sim.restore();
      }
    }

    for (const rpc of ["begin_billing_verification", "persist_billing_verdict"]) {
      const sim = await simulate();
      try {
        sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
        sim.h.rpcs.access_state = ACCESS_STATE;
        sim.h.rpcErrors[rpc] = 503;
        const result = await parse(
          await sim.h.handler(
            userRequest("POST", "/v1/billing/sync", {
              body: { fulfilment: evidence() },
              token: fakeSupabaseAccessToken(crypto.randomUUID()),
            }),
          ),
        );
        assertEquals(result.status, 503, rpc);
        assertEquals(result.body.fulfilment, undefined, rpc);
        assertEquals(sim.entitlementWrites.length, 0, rpc);
        if (rpc === "begin_billing_verification") {
          assertEquals(sim.rcCalls(), 0, "no provider call without a verification ticket");
        }
      } finally {
        sim.restore();
      }
    }
  },
);

// ── B5: unidentifiable latest transaction ids ─────────────────────────────────

Deno.test(
  "ATTACK B5: a renewal row whose latest transaction id is unidentifiable or equals the journaled id never heads a lineage",
  async () => {
    const latestIds: Array<[string, unknown]> = [
      ["negative", -1],
      ["fractional", 1.5],
      ["beyond safe integer", 2 ** 53],
      ["boolean", true],
      ["object", { id: RENEWAL_ID }],
      ["array", [RENEWAL_ID]],
      ["empty string", ""],
      ["null", null],
      ["NaN", Number.NaN],
      ["numeric journaled id", Number(JOURNALED_ID)],
      ["journaled id", JOURNALED_ID],
    ];
    for (const [label, latestId] of latestIds) {
      const result = await sync(
        subscriberOf({ [MONTHLY]: lineageRow({ store_transaction_id: latestId }) }),
        { fulfilment: evidence() },
      );
      assertEquals(result.status, 200, label);
      assertEquals(result.body.billing?.premium, true, label);
      assertEquals(outcome(result), "pending", label);
    }
    const missing = lineageRow();
    delete missing.store_transaction_id;
    const result = await sync(subscriberOf({ [MONTHLY]: missing }), { fulfilment: evidence() });
    assertEquals(result.status, 200);
    assertEquals(outcome(result), "pending", "absent store_transaction_id");
  },
);

// ── B6: clocks ────────────────────────────────────────────────────────────────

Deno.test(
  "ATTACK B6: a far-future or far-past provider clock never widens the lineage window, a future-dated renewal is not yet evidence, and a rolled-back clock cannot settle a later purchase",
  async () => {
    // Provider clock in 2200: rejected, the isolate clock bounds the window, so
    // a renewal stamped tomorrow is not yet provable.
    const farFuture = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ purchase_date: at(DAY) }) }),
      { fulfilment: evidence() },
      { requestDateMs: Date.UTC(2200, 0, 1) },
    );
    assertEquals(farFuture.status, 200);
    assertEquals(outcome(farFuture), "pending", "renewal dated tomorrow under a year-2200 clock");
    assert(Date.parse(String(farFuture.body.fulfilment?.verifiedAt)) <= farFuture.finishedAt);

    // Provider clock 400 days behind: rejected, the isolate clock is used and a
    // real renewal from D-5 is provable.
    const farPast = await sync(
      subscriberOf({ [MONTHLY]: lineageRow() }),
      { fulfilment: evidence() },
      { requestDateMs: Date.now() - 400 * DAY },
    );
    assertEquals(farPast.status, 200);
    assertEquals(outcome(farPast), "fulfilled");
    const verifiedAt = Date.parse(String(farPast.body.fulfilment?.verifiedAt));
    assert(verifiedAt >= farPast.startedAt && verifiedAt <= farPast.finishedAt, "isolate clock");

    // Missing request_date_ms: same fallback, same verdict.
    const absent = await sync(
      subscriberOf({ [MONTHLY]: lineageRow() }),
      { fulfilment: evidence() },
      {
        requestDateMs: null,
      },
    );
    assertEquals(outcome(absent), "fulfilled");

    // Renewal ONE millisecond after the (trusted) verification instant.
    const instant = Date.now() - 10 * MINUTE;
    const oneMsLater = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({ purchase_date: new Date(instant + 1).toISOString() }),
      }),
      { fulfilment: evidence() },
      { requestDateMs: instant },
    );
    assertEquals(outcome(oneMsLater), "pending", "renewal 1ms after the verification instant");

    // Clock rollback: the (trusted) verification instant precedes the journaled
    // purchase itself — nothing about a later purchase can be verified yet.
    const rolledBack = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ purchase_date: at(-7 * MINUTE) }) }),
      { fulfilment: evidence({ purchasedAt: at(-5 * MINUTE) }) },
      { requestDateMs: Date.now() - 10 * MINUTE },
    );
    assertEquals(rolledBack.status, 200);
    assertEquals(outcome(rolledBack), "pending", "verification instant before the purchase");
    const direct = await sync(
      subscriberOf({ [MONTHLY]: directRow({ purchase_date: at(-5 * MINUTE) }) }),
      { fulfilment: evidence({ purchasedAt: at(-5 * MINUTE) }) },
      { requestDateMs: Date.now() - 10 * MINUTE },
    );
    assertEquals(outcome(direct), "pending", "exact-id row verified before the purchase");
  },
);

// ── B7: evidence boundaries ───────────────────────────────────────────────────

Deno.test(
  "ATTACK B7a: identifier length and character boundaries — 256 chars accepted, 257 refused, path characters refused, and nothing crashes",
  async () => {
    const max = "x".repeat(256);
    const accepted = await sync(subscriberOf({ [MONTHLY]: lineageRow() }), {
      fulfilment: evidence({ transactionId: max }),
    });
    assertEquals(accepted.status, 200);
    assertEquals(accepted.body.fulfilment?.transaction, {
      productId: MONTHLY,
      transactionId: max,
      purchasedAt: JOURNALED_AT,
    });

    for (const [label, overrides] of [
      ["257-char id", { transactionId: "x".repeat(257) }],
      ["empty id", { transactionId: "" }],
      ["path id", { transactionId: "../" + RENEWAL_ID }],
      ["whitespace id", { transactionId: " " + JOURNALED_ID }],
      ["path product", { productId: "a/b" }],
      ["empty product", { productId: "" }],
      ["unix seconds", { purchasedAt: String(Math.floor(Date.parse(JOURNALED_AT) / 1000)) }],
      ["date only", { purchasedAt: JOURNALED_AT.slice(0, 10) }],
      ["negative year", { purchasedAt: "-000001-01-01T00:00:00Z" }],
    ] as Array<[string, Partial<Evidence>]>) {
      const refused = await sync(subscriberOf({ [MONTHLY]: lineageRow() }), {
        fulfilment: evidence(overrides),
      });
      assertEquals(refused.status, 400, label);
      assertEquals(refused.body.fulfilment, undefined, label);
      assertEquals(refused.rcCalls, 0, `${label}: refused before the provider is called`);
      assertEquals(refused.writes, 0, label);
      assertEquals(refused.errors, [], label);
    }
  },
);

Deno.test(
  "ATTACK B7b: a calendar-invalid purchase date is refused, never silently rewritten into a different instant",
  async () => {
    // "2026-02-30" is not a date. If the server accepts it, it must echo the
    // evidence it verified — the app binds the answer to its journaled record
    // by exact transaction equality, so a rewritten instant can never bind and
    // the purchase would stay pending forever.
    const purchasedAt = "2026-02-30T12:00:00.000Z";
    const result = await sync(subscriberOf({ [MONTHLY]: lineageRow() }), {
      fulfilment: evidence({ purchasedAt }),
    });
    if (result.status === 200) {
      assertEquals(
        result.body.fulfilment?.transaction,
        { productId: MONTHLY, transactionId: JOURNALED_ID, purchasedAt },
        "accepted evidence must be echoed unchanged",
      );
    } else {
      assertEquals(result.status, 400);
      assertEquals(result.rcCalls, 0);
    }
  },
);

// ── B8: free-rating conservation ──────────────────────────────────────────────

Deno.test(
  "ATTACK B8: a fulfilment sync never reserves, charges or releases a free rating — the ledger snapshot is echoed, not moved",
  async () => {
    const sim = await simulate();
    try {
      sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 1, reserved_count: 0 }];
      const result = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", {
            body: { fulfilment: evidence() },
            token: fakeSupabaseAccessToken(crypto.randomUUID()),
          }),
        ),
      );
      assertEquals(result.status, 200);
      assertEquals(outcome(result), "fulfilled");
      assertEquals(result.body.access?.freeRatings, {
        limit: 2,
        used: 1,
        reserved: 0,
        remaining: 1,
        availableToReserve: 1,
      });
      const touched = sim.h.calls
        .map((call) => `${call.method} ${new URL(call.url).pathname}`)
        .filter(
          (call) =>
            /permit|shot|free_rating|ledger|consume|reserve|release/i.test(call) &&
            !call.includes("access_state"),
        );
      assertEquals(touched, [], "no ledger, permit or shot surface is touched by a billing sync");
      const writes = sim.h.calls.filter(
        (call) =>
          call.method !== "GET" &&
          !call.url.includes("/rpc/") &&
          !call.url.startsWith(RC_URL) &&
          !call.url.includes("/auth/v1/"),
      );
      assertEquals(writes, [], "the only writes go through the ordered billing RPCs");
    } finally {
      sim.restore();
    }
  },
);

// ── B9: replay ────────────────────────────────────────────────────────────────

Deno.test(
  "ATTACK B9: identical evidence replayed is idempotent; once the lineage lapses the same evidence settles terminally and never re-fulfils by replay alone",
  async () => {
    const sim = await simulate();
    try {
      const owner = crypto.randomUUID();
      const token = fakeSupabaseAccessToken(owner);
      const journaled = evidence();
      sim.h.rpcs.access_state = ACCESS_STATE;
      sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
      const outcomes: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await parse(
          await sim.h.handler(
            userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
          ),
        );
        assertEquals(result.status, 200);
        assertEquals(result.body.fulfilment?.pendingId, journaled.pendingId);
        assertEquals(result.body.fulfilment?.attemptId, journaled.attemptId);
        outcomes.push(outcome(result));
      }
      assertEquals(outcomes, ["fulfilled", "fulfilled", "fulfilled"]);
      assertEquals(sim.entitlementRows.get(owner)?.premium, true);

      // The subscription lapses (renewal period ended yesterday, no entitlement).
      sim.h.subscriber = subscriberOf(
        { [MONTHLY]: lineageRow({}, at(-DAY)) },
        { entitledProduct: null },
      );
      const lapsed = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        ),
      );
      assertEquals(lapsed.status, 200);
      assertEquals(outcome(lapsed), "expired");
      assertEquals(lapsed.body.billing?.premium, false);
      const replayed = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        ),
      );
      assertEquals(outcome(replayed), "expired", "a terminal verdict is stable under replay");
      assertEquals(sim.entitlementRows.get(owner)?.premium, false);
      assertEquals(sim.errors, []);
    } finally {
      sim.restore();
    }
  },
);

// ── B10: second-precision provider dates ──────────────────────────────────────

Deno.test(
  "ATTACK B10: provider dates truncated to whole seconds against millisecond device evidence — the lineage window still holds, and a same-second truncation never flips the verdict",
  async () => {
    const firstAt = FIRST_AT.replace(/\.\d{3}Z$/, ".732Z");
    const truncated = seconds(firstAt);
    assertNotEquals(firstAt, truncated);
    // Device journaled the FIRST purchase with milliseconds; the provider
    // reports the same instant truncated to seconds (i.e. up to 999ms EARLIER).
    const first = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({
          original_purchase_date: truncated,
          purchase_date: seconds(RENEWAL_AT),
        }),
      }),
      { fulfilment: evidence({ transactionId: FIRST_ID, purchasedAt: firstAt }) },
    );
    assertEquals(first.status, 200);
    assertEquals(outcome(first), "fulfilled", "truncated original_purchase_date <= device ms");

    // Provider reports the first purchase with milliseconds LATER than the
    // device's second-precision journal of the same instant: the lineage
    // cannot claim the journaled purchase preceded its own first purchase.
    const laterMs = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ original_purchase_date: firstAt }) }),
      { fulfilment: evidence({ transactionId: FIRST_ID, purchasedAt: truncated }) },
    );
    assertEquals(laterMs.status, 200);
    assertEquals(
      outcome(laterMs),
      "pending",
      "original_purchase_date later than the journaled purchase is not this lineage",
    );

    // Renewal truncated to the SAME second as the journaled purchase: not later.
    const sameSecond = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({ purchase_date: seconds(plus(JOURNALED_AT, 0)) }),
      }),
      { fulfilment: evidence({ purchasedAt: JOURNALED_AT.replace(/\.\d{3}Z$/, ".500Z") }) },
    );
    assertEquals(outcome(sameSecond), "pending", "a renewal not strictly later is not a renewal");
  },
);

// ── B11: grace horizon on a lineage row ───────────────────────────────────────

Deno.test(
  "ATTACK B11: a lapsed lineage in a live grace period is not expired, a garbage grace date settles nothing, and an ended grace period settles exactly once as expired",
  async () => {
    const liveGrace = await sync(
      subscriberOf(
        { [MONTHLY]: lineageRow({ grace_period_expires_date: at(3 * DAY) }, at(-DAY)) },
        { entitledProduct: null },
      ),
      { fulfilment: evidence() },
    );
    assertEquals(liveGrace.status, 200);
    assertEquals(liveGrace.body.billing?.premium, false);
    assertEquals(outcome(liveGrace), "pending", "grace still running");

    for (const garbage of ["yesterday", 0, -1, true, {}, "2026-13-45T00:00:00Z"]) {
      const result = await sync(
        subscriberOf(
          { [MONTHLY]: lineageRow({ grace_period_expires_date: garbage }, at(-DAY)) },
          { entitledProduct: null },
        ),
        { fulfilment: evidence() },
      );
      assertEquals(result.status, 200, String(garbage));
      assertEquals(outcome(result), "pending", `garbage grace ${String(garbage)}`);
    }

    const ended = await sync(
      subscriberOf(
        { [MONTHLY]: lineageRow({ grace_period_expires_date: at(-1 * MINUTE) }, at(-DAY)) },
        { entitledProduct: null },
      ),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(ended), "expired");

    // Grace ended AFTER the verification instant the provider stamped: not yet.
    const instant = Date.now() - 10 * MINUTE;
    const afterInstant = await sync(
      subscriberOf(
        {
          [MONTHLY]: lineageRow(
            { grace_period_expires_date: new Date(instant + 1).toISOString() },
            at(-DAY),
          ),
        },
        { entitledProduct: null },
      ),
      { fulfilment: evidence() },
      { requestDateMs: instant },
    );
    assertEquals(outcome(afterInstant), "pending", "grace ends 1ms after the verification instant");
  },
);
