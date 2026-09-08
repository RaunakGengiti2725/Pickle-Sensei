// W07-02 adversary, round 4 — attacks on the lineage fulfilment rule at commit
// 226bb810 (`subscriptionLineageRow`, `subscriberIdentifiesTransaction`, the
// refund-parity and access-horizon guards added in r4). Every test runs the
// real edge handler through the webhook simulation and encodes what the
// reconciliation contract REQUIRES, not what the implementation happens to
// do: a journaled purchase settles only against provable, unambiguous provider
// evidence; a lineage row is never MORE permissive than an exact-id row; a
// verdict is terminal only when the provider's own clock has reached the
// horizon it settles on; provider/persistence failures never yield a verdict;
// a fulfilment sync never moves the free-rating ledger; the echoed evidence
// binds bit-for-bit to the journaled record. A failing test here is a
// confirmed break of the candidate.
//
// Attack map (each is a distinct attack type from the W07-02 surface):
//   C1  refund parity matrix: refund shape × entitlement × horizon on a lineage row vs the exact-id row
//   C2  contradictory access horizon: lineage ended at / before / 1ms after the journaled purchase
//   C3  duplicate identities: the journaled id attributed anywhere else (string, number, RC own id, other product)
//   C4  corrupt / partial provider state around the lineage row — never a 5xx crash, never a verdict
//   C5  replay across the renewal event: same record before, after one and after two renewals
//   C6  crash between steps: persistence 5xx once, retry of the same evidence settles exactly once
//   C7  network failure: provider timeout (10s abort) with lineage evidence attached
//   C8  trusted-but-skewed provider clock (23h behind / 4min ahead) vs the isolate clock
//   C9  boundary values: year 0001 / 9999 / epoch purchase dates, all three dates equal
//   C10 free-rating conservation for the 'expired' and 'pending' lineage outcomes
//   C11 double submit with distinct attempt ids: each answer binds to its own attempt, one applied
//   C12 upgrade inside the subscription group after a renewal: never a stuck record
//   C13 foreign lineage: a row of another store or not owned by the subscriber never speaks for an Apple purchase (a/b)

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { BILLING_BEGIN_URL, dbUnavailable, simulate, VERDICT_URL } from "./webhookSim.ts";
import { fakeSupabaseAccessToken, RC_URL, userRequest } from "./routesHarness.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const ANNUAL = "pickle_sensei_pro_annual";
const LIFETIME = "pickle_sensei_pro_lifetime";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

const FIRST_ID = "2000000811111111";
const FIRST_AT = at(-120 * DAY);
const JOURNALED_ID = "2000000833333333";
const JOURNALED_AT = at(-35 * DAY);
const RENEWAL_ID = "2000000822222222";
const RENEWAL_AT = at(-5 * DAY);
const SECOND_RENEWAL_ID = "2000000844444444";
const SECOND_RENEWAL_AT = at(-1 * DAY);
const UPGRADE_ID = "2000000855555555";
const UPGRADE_AT = at(-1 * DAY);

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

/** The claimed product's subscription AFTER a renewal replaced the journaled id. */
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
  subscriptions: Record<string, unknown>,
  options: { entitledProduct?: string | null; nonSubscriptions?: unknown } = {},
): Record<string, unknown> {
  const entitledProduct = options.entitledProduct === undefined ? MONTHLY : options.entitledProduct;
  const row = entitledProduct === null ? undefined : subscriptions[entitledProduct];
  const entitledRow = isRecord(row) ? row : undefined;
  return {
    entitlements:
      entitledProduct === null
        ? {}
        : {
            pickle_sensei_pro: {
              expires_date: entitledRow ? entitledRow.expires_date : at(25 * DAY),
              purchase_date: entitledRow ? entitledRow.purchase_date : RENEWAL_AT,
              product_identifier: entitledProduct,
            },
          },
    subscriptions,
    non_subscriptions: options.nonSubscriptions ?? {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  options: { requestDateMs?: number | null } = {},
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
      token: fakeSupabaseAccessToken(owner),
    });
    const startedAt = Date.now();
    const result = await parse(await sim.h.handler(request));
    return {
      ...result,
      startedAt,
      finishedAt: Date.now(),
      writes: sim.entitlementWrites.length,
      rcCalls: sim.rcCalls(),
      errors: sim.errors,
    };
  } finally {
    sim.restore();
  }
}

const outcome = (r: { body: SyncBody }) => r.body.fulfilment?.outcome;

/** The echo the device binds to: pendingId, attemptId and the transaction, bit for bit. */
function assertBound(r: { body: SyncBody }, journaled: ReturnType<typeof evidence>, label = "") {
  assertEquals(r.body.fulfilment?.pendingId, journaled.pendingId, `${label} pendingId`);
  assertEquals(r.body.fulfilment?.attemptId, journaled.attemptId, `${label} attemptId`);
  assertEquals(r.body.fulfilment?.transaction, journaled.transaction, `${label} transaction`);
}

// ── C1: refund parity matrix ──────────────────────────────────────────────────

Deno.test(
  "ATTACK C1: refund shape × entitlement × horizon — a lineage row is never 'refunded', is pending whenever the exact-id row is pending, and settles 'expired' only on a lapsed lineage with a provable past refund",
  async () => {
    const refundShapes: Array<[string, unknown]> = [
      ["valid past refund", at(-2 * DAY)],
      ["refund dated in the future", at(2 * DAY)],
      ["refund dated before the journaled purchase", at(-40 * DAY)],
      ["refund free text", "yesterday"],
      ["refund epoch number", Date.now() - 2 * DAY],
      ["refund empty string", ""],
      ["refund boolean", true],
      ["refund calendar-invalid month", "2026-13-01T00:00:00Z"],
    ];
    const horizons: Array<[string, string | null, string | null]> = [
      // label, expires_date, entitledProduct
      ["entitlement active", at(25 * DAY), MONTHLY],
      ["lapsed yesterday", at(-DAY), null],
      ["row not expired but entitlement revoked", at(25 * DAY), null],
    ];
    for (const [refundLabel, refundedAt] of refundShapes) {
      for (const [horizonLabel, expiresDate, entitledProduct] of horizons) {
        const label = `${refundLabel} / ${horizonLabel}`;
        const direct = await sync(
          subscriberOf(
            { [MONTHLY]: directRow({ refunded_at: refundedAt }, expiresDate) },
            { entitledProduct },
          ),
          { fulfilment: evidence() },
        );
        const lineage = await sync(
          subscriberOf(
            { [MONTHLY]: lineageRow({ refunded_at: refundedAt }, expiresDate) },
            { entitledProduct },
          ),
          { fulfilment: evidence() },
        );
        assertEquals(direct.status, 200, label);
        assertEquals(lineage.status, 200, label);
        assertEquals(lineage.errors, [], label);
        assertNotEquals(
          outcome(lineage),
          "refunded",
          `${label}: a lineage refund is unattributable`,
        );
        if (outcome(direct) === "pending") {
          assertEquals(outcome(lineage), "pending", `${label}: not looser than the exact-id rule`);
        }
        // Only a lapsed lineage carrying a provable past refund settles — on
        // its access state (expired), never as the refund itself. Every other
        // cell is contradictory or unprovable and stays pending.
        const provableRefund = refundLabel === "valid past refund";
        const expected =
          horizonLabel === "lapsed yesterday" && provableRefund ? "expired" : "pending";
        assertEquals(outcome(lineage), expected, label);
        if (horizonLabel === "entitlement active") {
          assertEquals(
            outcome(direct),
            "pending",
            `${label}: exact-id refund + active is contradictory`,
          );
        } else if (provableRefund) {
          assertEquals(outcome(direct), "refunded", `${label}: exact-id row is refunded`);
        } else {
          assertEquals(outcome(direct), "pending", `${label}: exact-id row is unprovable`);
        }
      }
    }
  },
);

// ── C2: contradictory access horizon on a lineage row ────────────────────────

Deno.test(
  "ATTACK C2: a lapsed lineage whose access horizon ended at or before the journaled purchase never settles it; one that ended after it is expired, at millisecond resolution, through expires_date and grace alike",
  async () => {
    const cases: Array<[string, string, string | null, "pending" | "expired"]> = [
      ["expires == journaled purchase", JOURNALED_AT, null, "pending"],
      ["expires 1ms before journaled purchase", plus(JOURNALED_AT, -1), null, "pending"],
      ["expires 1ms after journaled purchase", plus(JOURNALED_AT, 1), null, "expired"],
      [
        "expires a day before, grace == journaled purchase",
        plus(JOURNALED_AT, -DAY),
        JOURNALED_AT,
        "pending",
      ],
      [
        "expires a day before, grace 1ms after",
        plus(JOURNALED_AT, -DAY),
        plus(JOURNALED_AT, 1),
        "expired",
      ],
      [
        "expires far before, grace far before",
        plus(JOURNALED_AT, -30 * DAY),
        plus(JOURNALED_AT, -20 * DAY),
        "pending",
      ],
    ];
    for (const [label, expiresDate, grace, expected] of cases) {
      const result = await sync(
        subscriberOf(
          { [MONTHLY]: lineageRow({ grace_period_expires_date: grace }, expiresDate) },
          { entitledProduct: null },
        ),
        { fulfilment: evidence() },
      );
      assertEquals(result.status, 200, label);
      assertEquals(result.body.billing?.premium, false, label);
      assertEquals(outcome(result), expected, label);
      assertEquals(result.errors, [], label);
    }
    // The lineage lapsed at the journaled instant but a grace period the
    // provider still honours keeps the entitlement active: fulfilled, since the
    // account has the access it bought.
    const graced = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({ grace_period_expires_date: at(3 * DAY) }, JOURNALED_AT),
      }),
      { fulfilment: evidence() },
    );
    assertEquals(graced.status, 200);
    assertEquals(graced.body.billing?.premium, true);
    assertEquals(outcome(graced), "fulfilled");
  },
);

// ── C3: duplicate identities ──────────────────────────────────────────────────

Deno.test(
  "ATTACK C3: the journaled id attributed to ANY other record — as string or number, as a store id or RevenueCat's own id, under another product or an unknown key — is a conflict, never a renewal; unidentifiable look-alikes do not block",
  async () => {
    const monthlyLineage = lineageRow();
    const conflicts: Array<[string, Record<string, unknown>, unknown]> = [
      [
        "annual store id (string)",
        { [ANNUAL]: lineageRow({ store_transaction_id: JOURNALED_ID }) },
        {},
      ],
      [
        "annual store id (number)",
        { [ANNUAL]: lineageRow({ store_transaction_id: Number(JOURNALED_ID) }) },
        {},
      ],
      [
        "unknown product key",
        {
          "com.other.product": lineageRow({ store_transaction_id: JOURNALED_ID }),
        },
        {},
      ],
      [
        "lifetime purchase store id",
        {},
        {
          [LIFETIME]: [
            {
              id: "rc-own-id",
              store_transaction_id: JOURNALED_ID,
              purchase_date: at(-3 * DAY),
            },
          ],
        },
      ],
      [
        "lifetime purchase RevenueCat id without a store id",
        {},
        { [LIFETIME]: [{ id: JOURNALED_ID, purchase_date: at(-3 * DAY) }] },
      ],
      [
        "non-subscription row under the claimed product",
        {},
        { [MONTHLY]: [{ id: JOURNALED_ID, purchase_date: at(-3 * DAY) }] },
      ],
      [
        "lifetime purchase store id (number)",
        {},
        {
          [LIFETIME]: [
            {
              id: "x",
              store_transaction_id: Number(JOURNALED_ID),
              purchase_date: at(-3 * DAY),
            },
          ],
        },
      ],
    ];
    for (const [label, extraSubscriptions, nonSubscriptions] of conflicts) {
      const result = await sync(
        subscriberOf({ [MONTHLY]: monthlyLineage, ...extraSubscriptions }, { nonSubscriptions }),
        { fulfilment: evidence() },
      );
      assertEquals(result.status, 200, label);
      assertEquals(result.body.billing?.premium, true, label);
      assertEquals(outcome(result), "pending", label);
    }
    // The claimed product's own row carries the journaled id at ANOTHER date:
    // a conflict on the id, not a renewal.
    const dateConflict = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ store_transaction_id: JOURNALED_ID }) }),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(dateConflict), "pending", "same id, different purchase_date");

    // Look-alikes that identify nothing must not block a genuine lineage.
    const harmless: Array<[string, Record<string, unknown>, unknown]> = [
      [
        "annual store id is fractional",
        { [ANNUAL]: lineageRow({ store_transaction_id: 1.5 }) },
        {},
      ],
      [
        "lifetime row: store id authoritative, RC own id coincides",
        {},
        {
          [LIFETIME]: [
            {
              id: JOURNALED_ID,
              store_transaction_id: "9",
              purchase_date: at(-3 * DAY),
            },
          ],
        },
      ],
      ["non_subscriptions is not an object", {}, "garbage"],
      ["non_subscriptions product value is not an array", {}, { [LIFETIME]: { id: JOURNALED_ID } }],
      ["subscription row is not an object", { [ANNUAL]: JOURNALED_ID }, {}],
    ];
    for (const [label, extraSubscriptions, nonSubscriptions] of harmless) {
      const result = await sync(
        subscriberOf({ [MONTHLY]: monthlyLineage, ...extraSubscriptions }, { nonSubscriptions }),
        { fulfilment: evidence() },
      );
      assertEquals(result.status, 200, label);
      assertEquals(outcome(result), "fulfilled", label);
      assertEquals(result.errors, [], label);
    }
  },
);

// ── C4: corrupt / partial provider state ──────────────────────────────────────

Deno.test(
  "ATTACK C4: corrupt or partial provider state around the lineage row never crashes (no 5xx other than the retryable 502), never settles terminally, and never writes more than the one verdict",
  async () => {
    // (a) The entitled product's subscription row is not an object: the
    // provider state is unusable — retryable unavailability, no verdict.
    for (const broken of [[], "row", 42, null, true, [lineageRow()]]) {
      const result = await sync(subscriberOf({ [MONTHLY]: broken }), { fulfilment: evidence() });
      assertEquals(result.status, 502, `entitled row ${JSON.stringify(broken)}`);
      assertEquals(result.body.error?.code, "billing_unavailable");
      assertEquals(result.body.fulfilment, undefined);
      assertEquals(result.writes, 0);
      assertEquals(result.errors, []);
    }
    // (b) No entitlement, claimed row is not an object: nothing to settle on.
    for (const broken of [[], "row", 42, null, true, [lineageRow()]]) {
      const result = await sync(subscriberOf({ [MONTHLY]: broken }, { entitledProduct: null }), {
        fulfilment: evidence(),
      });
      assertEquals(result.status, 200, `lapsed row ${JSON.stringify(broken)}`);
      assertEquals(outcome(result), "pending", `lapsed row ${JSON.stringify(broken)}`);
      assertEquals(result.writes, 1);
      assertEquals(result.errors, []);
    }
    // (c) Lineage anchors that are not timestamps: no lineage is proved.
    const badDates: unknown[] = [
      Date.now() - 120 * DAY,
      "",
      "not-a-date",
      null,
      "2026-13-01T00:00:00Z",
      0,
      true,
    ];
    for (const bad of badDates) {
      for (const field of ["original_purchase_date", "purchase_date"]) {
        const label = `${field}=${JSON.stringify(bad)}`;
        const result = await sync(subscriberOf({ [MONTHLY]: lineageRow({ [field]: bad }) }), {
          fulfilment: evidence(),
        });
        assertEquals(result.status, 200, label);
        assertEquals(outcome(result), "pending", label);
        assertEquals(result.writes, 1, label);
        assertEquals(result.errors, [], label);
      }
    }
    for (const field of ["original_purchase_date", "purchase_date"]) {
      const row = lineageRow();
      delete row[field];
      const result = await sync(subscriberOf({ [MONTHLY]: row }), { fulfilment: evidence() });
      assertEquals(outcome(result), "pending", `${field} absent`);
    }
    // (d) A lapsed lineage whose expiry is garbage settles nothing.
    for (const bad of [Date.now() - DAY, "", "not-a-date", "2026-13-01T00:00:00Z", 0, true, {}]) {
      const result = await sync(
        subscriberOf({ [MONTHLY]: lineageRow({ expires_date: bad }) }, { entitledProduct: null }),
        { fulfilment: evidence() },
      );
      assertEquals(result.status, 200, `expires_date=${JSON.stringify(bad)}`);
      assertEquals(outcome(result), "pending", `expires_date=${JSON.stringify(bad)}`);
      assertEquals(result.errors, []);
    }
    // (e) Evidence whose claimed product has no row at all, while the lineage
    // exists under another product: nothing speaks for the claim.
    const wrongProduct = await sync(subscriberOf({ [MONTHLY]: lineageRow() }), {
      fulfilment: evidence({ productId: ANNUAL }),
    });
    assertEquals(outcome(wrongProduct), "pending", "lineage under a different product");
  },
);

// ── C5: replay across the renewal event ───────────────────────────────────────

Deno.test(
  "ATTACK C5: the same journaled record replayed before, after one and after two renewals binds identically each time, settles 'fulfilled' each time, and every sync lands exactly one verdict with a non-decreasing verifiedAt",
  async () => {
    const sim = await simulate();
    try {
      const owner = crypto.randomUUID();
      const token = fakeSupabaseAccessToken(owner);
      const journaled = evidence();
      sim.h.rpcs.access_state = ACCESS_STATE;
      const states: Array<[string, Record<string, unknown>]> = [
        ["before renewal (exact id)", subscriberOf({ [MONTHLY]: directRow() })],
        ["after first renewal", subscriberOf({ [MONTHLY]: lineageRow() })],
        [
          "after second renewal",
          subscriberOf({
            [MONTHLY]: lineageRow({
              store_transaction_id: SECOND_RENEWAL_ID,
              purchase_date: SECOND_RENEWAL_AT,
            }),
          }),
        ],
        [
          "replay after second renewal",
          subscriberOf({
            [MONTHLY]: lineageRow({
              store_transaction_id: SECOND_RENEWAL_ID,
              purchase_date: SECOND_RENEWAL_AT,
            }),
          }),
        ],
      ];
      let lastVerifiedAt = 0;
      let syncs = 0;
      for (const [label, subscriber] of states) {
        sim.h.subscriber = subscriber;
        const result = await parse(
          await sim.h.handler(
            userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
          ),
        );
        syncs += 1;
        assertEquals(result.status, 200, label);
        assertEquals(outcome(result), "fulfilled", label);
        assertBound(result, journaled, label);
        assertEquals(result.body.billing?.premium, true, label);
        const verifiedAt = Date.parse(String(result.body.fulfilment?.verifiedAt));
        assert(verifiedAt >= lastVerifiedAt, `${label}: verifiedAt never goes backwards`);
        assert(verifiedAt >= Date.parse(JOURNALED_AT), `${label}: verified after the purchase`);
        lastVerifiedAt = verifiedAt;
        assertEquals(sim.entitlementWrites.length, syncs, `${label}: one verdict per sync`);
      }
      assertEquals(sim.entitlementRows.get(owner)?.premium, true);
      assertEquals(sim.errors, []);
    } finally {
      sim.restore();
    }
  },
);

// ── C6: crash between steps ───────────────────────────────────────────────────

Deno.test(
  "ATTACK C6: a persistence failure after the provider verified a lineage settles nothing and writes nothing; the retried identical evidence then settles exactly once — and a failed verification ticket never reaches the provider",
  async () => {
    const sim = await simulate();
    try {
      const owner = crypto.randomUUID();
      const token = fakeSupabaseAccessToken(owner);
      const journaled = evidence();
      sim.h.rpcs.access_state = ACCESS_STATE;
      sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });

      sim.faults.push({
        match: (method, url) => method === "POST" && url.startsWith(BILLING_BEGIN_URL),
        ...dbUnavailable,
        times: 1,
      });
      const noTicket = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        ),
      );
      assertEquals(noTicket.status, 503);
      assertEquals(noTicket.body.fulfilment, undefined);
      assertEquals(sim.rcCalls(), 0, "no provider call without a ticket");
      assertEquals(sim.entitlementWrites.length, 0);

      sim.faults.push({
        match: (method, url) => method === "POST" && url.startsWith(VERDICT_URL),
        ...dbUnavailable,
        times: 1,
      });
      const crashed = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        ),
      );
      assertEquals(crashed.status, 503);
      assertEquals(crashed.body.fulfilment, undefined, "no verdict without durable persistence");
      assertEquals(sim.rcCalls(), 1, "the provider was consulted once");
      assertEquals(sim.entitlementWrites.length, 0, "nothing landed");
      assertEquals(sim.entitlementRows.get(owner), undefined);

      const retried = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        ),
      );
      assertEquals(retried.status, 200);
      assertEquals(outcome(retried), "fulfilled");
      assertBound(retried, journaled);
      assertEquals(sim.entitlementWrites.length, 1, "the retry landed exactly one verdict");
      assertEquals(sim.entitlementRows.get(owner)?.premium, true);
      assertEquals(sim.errors.length, 2, "both persistence failures were logged, nothing else");
    } finally {
      sim.restore();
    }
  },
);

// ── C7: provider timeout ──────────────────────────────────────────────────────

Deno.test(
  "ATTACK C7: a provider that never answers within the 10s budget yields a retryable 502, no fulfilment verdict, no entitlement write — and the next answer settles the same evidence",
  async () => {
    const sim = await simulate();
    try {
      const owner = crypto.randomUUID();
      const token = fakeSupabaseAccessToken(owner);
      const journaled = evidence();
      sim.h.rpcs.access_state = ACCESS_STATE;
      sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        delayMs: 60_000,
        times: 1,
      });
      const startedAt = Date.now();
      const timedOut = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        ),
      );
      const elapsed = Date.now() - startedAt;
      assert(elapsed >= 9_000 && elapsed < 20_000, `aborted by the 10s budget (took ${elapsed}ms)`);
      assertEquals(timedOut.status, 502);
      assertEquals(timedOut.body.error?.code, "billing_unavailable");
      assertEquals(timedOut.body.fulfilment, undefined);
      assertEquals(sim.entitlementWrites.length, 0);

      const settled = await parse(
        await sim.h.handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: journaled }, token }),
        ),
      );
      assertEquals(settled.status, 200);
      assertEquals(outcome(settled), "fulfilled");
      assertBound(settled, journaled);
      assertEquals(sim.entitlementWrites.length, 1);
      assertEquals(sim.errors, []);
    } finally {
      sim.restore();
    }
  },
);

// ── C8: trusted-but-skewed provider clock ─────────────────────────────────────

Deno.test(
  "ATTACK C8: a provider clock trusted 23h behind never proves a renewal or an expiry it has not reached; a clock trusted 4min ahead settles a renewal from 2min ago; verifiedAt is always the clock the verdict is ordered by",
  async () => {
    const behind = Date.now() - 23 * HOUR;
    // Renewal an hour ago, provider clock 23h behind (within the trusted
    // window): from the provider's instant the renewal has not happened yet.
    const notYet = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ purchase_date: at(-HOUR) }) }),
      { fulfilment: evidence() },
      { requestDateMs: behind },
    );
    assertEquals(notYet.status, 200);
    assertEquals(outcome(notYet), "pending", "renewal after the provider's instant");
    assertEquals(notYet.body.fulfilment?.verifiedAt, new Date(behind).toISOString());

    // Renewal at D-5, provider 23h behind: provable.
    const provable = await sync(
      subscriberOf({ [MONTHLY]: lineageRow() }),
      { fulfilment: evidence() },
      { requestDateMs: behind },
    );
    assertEquals(outcome(provable), "fulfilled");
    assertEquals(provable.body.fulfilment?.verifiedAt, new Date(behind).toISOString());

    // Lapsed an hour ago (isolate clock), provider 23h behind: the provider's
    // instant precedes the horizon, so the expiry is not yet provable — never
    // 'expired' before the verifying clock reaches it.
    const lapsed = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({}, at(-HOUR)) }, { entitledProduct: null }),
      { fulfilment: evidence() },
      { requestDateMs: behind },
    );
    assertEquals(lapsed.status, 200);
    assertEquals(lapsed.body.billing?.premium, false);
    assertEquals(outcome(lapsed), "pending", "expiry after the provider's instant");

    // Provider 4min ahead (trusted), renewal 2min ago: provable, and the
    // verdict is stamped with the provider's clock.
    const ahead = Date.now() + 4 * MINUTE;
    const recent = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ purchase_date: at(-2 * MINUTE) }) }),
      { fulfilment: evidence() },
      { requestDateMs: ahead },
    );
    assertEquals(outcome(recent), "fulfilled");
    assertEquals(recent.body.fulfilment?.verifiedAt, new Date(ahead).toISOString());

    // Provider 4min ahead, renewal stamped 6min in the future: not yet, even
    // though the provider's own clock is ahead.
    const future = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ purchase_date: at(6 * MINUTE) }) }),
      { fulfilment: evidence() },
      { requestDateMs: ahead },
    );
    assertEquals(outcome(future), "pending");
  },
);

// ── C9: boundary values ───────────────────────────────────────────────────────

Deno.test(
  "ATTACK C9: extreme purchase instants (year 0001, year 9999, the epoch) and a lineage whose three dates coincide never crash, never settle, and are echoed bit for bit",
  async () => {
    for (const purchasedAt of [
      "0001-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      const journaled = evidence({ purchasedAt });
      const result = await sync(subscriberOf({ [MONTHLY]: lineageRow() }), {
        fulfilment: journaled,
      });
      assertEquals(result.status, 200, purchasedAt);
      assertEquals(outcome(result), "pending", purchasedAt);
      assertBound(result, journaled, purchasedAt);
      assertEquals(result.errors, [], purchasedAt);
    }
    for (const purchasedAt of ["0000-00-00T00:00:00Z", "+275760-09-13T00:00:00Z", "NaN"]) {
      const result = await sync(subscriberOf({ [MONTHLY]: lineageRow() }), {
        fulfilment: evidence({ purchasedAt }),
      });
      assertEquals(result.status, 400, purchasedAt);
      assertEquals(result.rcCalls, 0, purchasedAt);
      assertEquals(result.writes, 0, purchasedAt);
    }
    // original == journaled == latest: the latest transaction is not later.
    const coincident = await sync(
      subscriberOf({
        [MONTHLY]: lineageRow({
          original_purchase_date: JOURNALED_AT,
          purchase_date: JOURNALED_AT,
        }),
      }),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(coincident), "pending", "three coincident dates");
    // original == journaled < latest: the first purchase of the lineage.
    const first = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ original_purchase_date: JOURNALED_AT }) }),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(first), "fulfilled", "journaled purchase is the lineage's first");
    // original 1ms after the journaled purchase: not this lineage.
    const later = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ original_purchase_date: plus(JOURNALED_AT, 1) }) }),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(later), "pending", "first purchase after the journaled one");
  },
);

// ── C10: free-rating conservation ─────────────────────────────────────────────

Deno.test(
  "ATTACK C10: 'expired' and 'pending' lineage outcomes echo the free-rating snapshot unchanged and touch no permit, shot or ledger surface — an exhausted allowance stays exhausted, an untouched one untouched",
  async () => {
    const scenarios: Array<[string, Record<string, unknown>, unknown, number]> = [
      [
        "expired",
        subscriberOf({ [MONTHLY]: lineageRow({}, at(-DAY)) }, { entitledProduct: null }),
        "expired",
        2,
      ],
      [
        "pending (contradictory refund)",
        subscriberOf({ [MONTHLY]: lineageRow({ refunded_at: at(2 * DAY) }) }),
        "pending",
        1,
      ],
      [
        "pending (id conflict)",
        subscriberOf({
          [MONTHLY]: lineageRow(),
          [ANNUAL]: lineageRow({ store_transaction_id: JOURNALED_ID }),
        }),
        "pending",
        0,
      ],
    ];
    for (const [label, subscriber, expected, scored] of scenarios) {
      const sim = await simulate();
      try {
        sim.h.subscriber = subscriber;
        sim.h.rpcs.access_state = [{ premium: false, scored_count: scored, reserved_count: 0 }];
        const result = await parse(
          await sim.h.handler(
            userRequest("POST", "/v1/billing/sync", {
              body: { fulfilment: evidence() },
              token: fakeSupabaseAccessToken(crypto.randomUUID()),
            }),
          ),
        );
        assertEquals(result.status, 200, label);
        assertEquals(outcome(result), expected, label);
        assertEquals(
          result.body.access?.freeRatings,
          {
            limit: 2,
            used: scored,
            reserved: 0,
            remaining: 2 - scored,
            availableToReserve: 2 - scored,
          },
          label,
        );
        const touched = sim.h.calls
          .map((call) => `${call.method} ${new URL(call.url).pathname}`)
          .filter(
            (call) =>
              /permit|shot|free_rating|ledger|consume|reserve|release/i.test(call) &&
              !call.includes("access_state"),
          );
        assertEquals(touched, [], `${label}: no ledger surface`);
        const writes = sim.h.calls.filter(
          (call) =>
            call.method !== "GET" &&
            !call.url.includes("/rpc/") &&
            !call.url.startsWith(RC_URL) &&
            !call.url.includes("/auth/v1/"),
        );
        assertEquals(writes, [], `${label}: only the ordered billing RPCs write`);
      } finally {
        sim.restore();
      }
    }
  },
);

// ── C11: double submit with distinct attempt ids ──────────────────────────────

Deno.test(
  "ATTACK C11: two in-flight syncs for the same pending record with different attempt ids each answer bound to their own attempt; exactly one verdict is applied and only that answer may say 'fulfilled'",
  async () => {
    const sim = await simulate();
    try {
      const owner = crypto.randomUUID();
      const token = fakeSupabaseAccessToken(owner);
      sim.h.subscriber = subscriberOf({ [MONTHLY]: lineageRow() });
      sim.h.rpcs.access_state = ACCESS_STATE;
      sim.faults.push({
        match: (method, url) => method === "GET" && url.startsWith(RC_URL),
        delayMs: 400,
        times: 1,
      });
      const firstAttempt = evidence();
      const secondAttempt = { ...firstAttempt, attemptId: crypto.randomUUID() };
      const slow = sim.h
        .handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: firstAttempt }, token }),
        )
        .then(parse);
      for (let i = 0; i < 50 && sim.rcCalls() < 1; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(sim.rcCalls(), 1);
      const fast = await sim.h
        .handler(
          userRequest("POST", "/v1/billing/sync", { body: { fulfilment: secondAttempt }, token }),
        )
        .then(parse);
      const stale = await slow;

      assertEquals(fast.status, 200);
      assertEquals(outcome(fast), "fulfilled");
      assertBound(fast, secondAttempt, "fast");
      assertEquals(stale.status, 200);
      assertBound(stale, firstAttempt, "stale");
      assertEquals(outcome(stale), "pending", "the dropped verdict is not reported as applied");
      assertEquals(stale.body.billing?.premium, true, "but the stored truth is served");
      assertEquals(sim.verdictResults.filter((row) => row.applied === true).length, 1);
      assertEquals(sim.entitlementWrites.length, 1);
      assertEquals(sim.errors, []);
    } finally {
      sim.restore();
    }
  },
);

// ── C12: upgrade inside the subscription group ────────────────────────────────

Deno.test(
  "ATTACK C12: after a renewal and an upgrade inside the group, the journaled monthly purchase is never stuck pending while the account is entitled through the annual plan; the upgrade's own transaction settles directly and, after the annual renews, through its lineage",
  async () => {
    const monthlyAfterUpgrade = lineageRow({}, UPGRADE_AT);
    const annualRow = lineageRow({
      store_transaction_id: UPGRADE_ID,
      purchase_date: UPGRADE_AT,
      original_purchase_date: FIRST_AT,
      expires_date: at(364 * DAY),
    });
    const upgraded = subscriberOf(
      { [MONTHLY]: monthlyAfterUpgrade, [ANNUAL]: annualRow },
      { entitledProduct: ANNUAL },
    );
    const monthly = await sync(upgraded, { fulfilment: evidence() });
    assertEquals(monthly.status, 200);
    assertEquals(monthly.body.billing?.premium, true);
    assertNotEquals(outcome(monthly), "pending", "an upgraded customer's record is not stuck");
    assertNotEquals(outcome(monthly), "refunded");

    const upgrade = evidence({
      productId: ANNUAL,
      transactionId: UPGRADE_ID,
      purchasedAt: UPGRADE_AT,
    });
    const direct = await sync(upgraded, { fulfilment: upgrade });
    assertEquals(outcome(direct), "fulfilled", "the upgrade transaction itself");

    const annualRenewed = subscriberOf(
      {
        [MONTHLY]: monthlyAfterUpgrade,
        [ANNUAL]: lineageRow({
          store_transaction_id: SECOND_RENEWAL_ID,
          purchase_date: at(-HOUR),
          original_purchase_date: FIRST_AT,
          expires_date: at(364 * DAY),
        }),
      },
      { entitledProduct: ANNUAL },
    );
    const viaLineage = await sync(annualRenewed, { fulfilment: upgrade });
    assertEquals(outcome(viaLineage), "fulfilled", "the upgrade after the annual renewed");

    // The monthly evidence against the annual lineage is a different product:
    // the annual row never speaks for a monthly purchase.
    const crossProduct = await sync(
      subscriberOf({ [ANNUAL]: annualRow }, { entitledProduct: ANNUAL }),
      { fulfilment: evidence() },
    );
    assertEquals(outcome(crossProduct), "pending", "no monthly row at all");
  },
);

// ── C13: foreign lineage ──────────────────────────────────────────────────────

const FOREIGN_ROWS: Array<[string, Record<string, unknown>]> = [
  ["play_store row", { store: "play_store" }],
  ["stripe row", { store: "stripe" }],
  ["promotional row", { store: "promotional", store_transaction_id: "promo_abc" }],
  ["family-shared row", { ownership_type: "FAMILY_SHARED" }],
];

Deno.test(
  "ATTACK C13a: a same-product row RevenueCat attributes to another store or to a purchase the subscriber does not own (family sharing) is not the lineage of an App Store purchase this device journaled — it stays pending",
  async () => {
    for (const [label, overrides] of FOREIGN_ROWS) {
      const result = await sync(subscriberOf({ [MONTHLY]: lineageRow(overrides) }), {
        fulfilment: evidence(),
      });
      assertEquals(result.status, 200, label);
      assertEquals(result.body.billing?.premium, true, label);
      assertEquals(outcome(result), "pending", `${label}: not this purchase's lineage`);
    }
  },
);

Deno.test(
  "ATTACK C13b: the App Store lineage of exactly the same shape, owned by the subscriber, settles the journaled purchase",
  async () => {
    const appStore = await sync(
      subscriberOf({ [MONTHLY]: lineageRow({ store: "app_store", ownership_type: "PURCHASED" }) }),
      { fulfilment: evidence() },
    );
    assertEquals(appStore.status, 200);
    assertEquals(outcome(appStore), "fulfilled");
  },
);
