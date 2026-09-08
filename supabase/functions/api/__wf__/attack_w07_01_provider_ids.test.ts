// W07-01 adversarial tests: provider transaction identity at its failure
// boundaries. Every test drives the real POST /v1/billing/sync handler through
// webhookSim/routesHarness against the candidate at 4defd4dd. Invariants under
// attack: a numeric iOS store_transaction_id or a RevenueCat-only lifetime id
// fulfils only on an exact, unambiguous match; absence, ambiguity, malformed
// values, provider outages, superseded verdicts and foreign evidence stay
// pending (or fail retryably) and are never refunded/expired from absence.
import { assert, assertEquals } from "@std/assert";
import { RC_URL, fakeSupabaseAccessToken, userRequest } from "./routesHarness.ts";
import { type Fault, simulate, VERDICT_URL, dbUnavailable, type Sim } from "./webhookSim.ts";

const MONTHLY = "pickle_sensei_pro_monthly";
const LIFETIME = "pickle_sensei_pro_lifetime";
const NUMERIC_ID = 1000000652379790;
const PURCHASED_AT = "2026-08-01T00:00:00.000Z";
const RC_PURCHASE_ID = "cadba0c81b";
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const entitlement = (expires: string | null, product: string) => ({
  expires_date: expires,
  grace_period_expires_date: null,
  product_identifier: product,
  purchase_date: at(-86_400_000),
});
const evidence = (
  productId: string,
  transactionId: string,
  purchasedAt = PURCHASED_AT,
  ids: { pendingId?: string; attemptId?: string } = {},
) => ({
  pendingId: ids.pendingId ?? "11111111-1111-4111-8111-111111111111",
  attemptId: ids.attemptId ?? "22222222-2222-4222-8222-222222222222",
  transaction: { productId, transactionId, purchasedAt },
});
const monthlyEvidence = evidence(MONTHLY, String(NUMERIC_ID));
const lifetimeEvidence = evidence(LIFETIME, RC_PURCHASE_ID);

type Outcome = "pending" | "fulfilled" | "expired" | "refunded";
const TERMINAL: Outcome[] = ["expired", "refunded"];

interface SyncResult {
  status: number;
  body: Record<string, unknown> & {
    fulfilment?: { outcome: Outcome; transaction: Record<string, unknown> };
    billing?: { premium: boolean; productKey: string | null };
    access?: { premium: boolean; freeRatings: { used: number; reserved: number } };
    error?: { code: string };
  };
  writes: number;
  rcCalls: number;
}

async function request(sim: Sim, owner: string, body: unknown, token?: string | null) {
  const req =
    token === null
      ? new Request("http://edge.test/functions/v1/api/v1/billing/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.20" },
          body: JSON.stringify(body),
        })
      : userRequest("POST", "/v1/billing/sync", {
          body,
          token: token ?? fakeSupabaseAccessToken(owner),
        });
  const response = await sim.h.handler(req);
  return {
    status: response.status,
    body: await response.json(),
    writes: sim.entitlementWrites.length,
    rcCalls: sim.rcCalls(),
  } as SyncResult;
}

interface SyncOptions {
  /** Serve this exact text as the RevenueCat 200 body (wire-level shapes). */
  rawRc?: string;
  /** Serve this Response for the RevenueCat call (status/headers attacks). */
  rcResponse?: () => Response;
  faults?: readonly Fault[];
  token?: string | null;
  accessState?: Record<string, unknown>;
}

async function sync(
  subscriber: Record<string, unknown> | null,
  body: unknown,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const sim = await simulate();
  const owner = crypto.randomUUID();
  try {
    if (subscriber) sim.h.subscriber = subscriber;
    sim.h.rpcs.access_state = [
      options.accessState ?? { premium: false, scored_count: 0, reserved_count: 0 },
    ];
    if (options.rawRc !== undefined || options.rcResponse) {
      sim.h.respond = (call) => {
        if (!call.url.startsWith(RC_URL)) return null;
        if (options.rcResponse) return options.rcResponse();
        return new Response(options.rawRc, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
    }
    for (const fault of options.faults ?? []) sim.faults.push(fault);
    return await request(sim, owner, body, options.token);
  } finally {
    sim.restore();
  }
}

const rcBody = (subscriberJson: string, requestDateMs = Date.now()) =>
  `{"request_date_ms":${requestDateMs},"subscriber":${subscriberJson}}`;

const activeMonthlyJson = (storeTransactionIdLiteral: string) =>
  `{"entitlements":{"pickle_sensei_pro":{"expires_date":"${at(60_000)}","grace_period_expires_date":null,"product_identifier":"${MONTHLY}","purchase_date":"${at(-86_400_000)}"}},` +
  `"subscriptions":{"${MONTHLY}":{"store_transaction_id":${storeTransactionIdLiteral},"purchase_date":"2026-08-01T00:00:00Z","expires_date":"${at(60_000)}","refunded_at":null}}}`;

// ── ATTACK 1: boundary numerics on the wire ──────────────────────────────────
// The RevenueCat body is served as raw JSON text so the literal reaches the
// handler exactly as JSON.parse would deliver it in production (-0, 2^53,
// exponent notation, fractions, strings with whitespace).

for (const [label, literal, transactionId, expected] of [
  ["control: safe integer", "1000000652379790", "1000000652379790", "fulfilled"],
  ["MAX_SAFE_INTEGER", "9007199254740991", "9007199254740991", "fulfilled"],
  ["2^53 (first unsafe)", "9007199254740992", "9007199254740992", "pending"],
  ["2^53+1 (rounds to 2^53)", "9007199254740993", "9007199254740993", "pending"],
  ["exponent literal 1e15 vs decimal evidence", "1e15", "1000000000000000", "fulfilled"],
  ["exponent literal 1e15 vs literal evidence", "1e15", "1e15", "pending"],
  ["negative zero vs '0'", "-0", "0", "fulfilled"],
  ["negative id", "-1000000652379790", "-1000000652379790", "pending"],
  ["fraction .5", "1000000652379790.5", "1000000652379790", "pending"],
  ["fraction below double resolution", "1000000652379790.0000001", "1000000652379790", "fulfilled"],
  ["integer vs zero-padded evidence", "100", "0100", "pending"],
  ["string with leading space", '" 1000000652379790"', "1000000652379790", "pending"],
  ["string with trailing newline", '"1000000652379790\\n"', "1000000652379790", "pending"],
  ["boolean true", "true", "true", "pending"],
  ["array wrapper", "[1000000652379790]", "1000000652379790", "pending"],
  ["object wrapper", '{"$numberLong":"1000000652379790"}', "1000000652379790", "pending"],
  ["huge literal 1e400 (Infinity)", "1e400", "Infinity", "pending"],
] as const) {
  Deno.test(`ATK1 numeric wire boundary: ${label} → ${expected}, never terminal`, async () => {
    const result = await sync(
      null,
      { fulfilment: evidence(MONTHLY, transactionId) },
      {
        rawRc: rcBody(activeMonthlyJson(literal)),
      },
    );
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.fulfilment?.outcome, expected);
    assert(!TERMINAL.includes(result.body.fulfilment!.outcome));
    // The entitlement is active regardless of whether the receipt matched.
    assertEquals(result.body.billing?.premium, true);
    assertEquals(result.body.access?.premium, true);
  });
}

// ── ATTACK 2: clock boundaries around numeric-id terminal outcomes ───────────

const expiredMonthly = (expires: string, grace: unknown = null, refundedAt: unknown = null) => ({
  entitlements: {},
  subscriptions: {
    [MONTHLY]: {
      store_transaction_id: NUMERIC_ID,
      purchase_date: PURCHASED_AT,
      expires_date: expires,
      grace_period_expires_date: grace,
      refunded_at: refundedAt,
    },
  },
});

Deno.test(
  "ATK2 clock: expiry exactly at the provider clock is expired; 1ms later is pending",
  async () => {
    const rcNow = Date.now() - 1_000;
    const exact = await sync(
      expiredMonthly(new Date(rcNow).toISOString()),
      { fulfilment: monthlyEvidence },
      {
        faults: [
          {
            match: (_m, url) => url.startsWith(RC_URL),
            subscriber: expiredMonthly(new Date(rcNow).toISOString()),
            requestDateMs: rcNow,
          },
        ],
      },
    );
    assertEquals(exact.status, 200);
    assertEquals(exact.body.fulfilment?.outcome, "expired");
    const later = await sync(
      null,
      { fulfilment: monthlyEvidence },
      {
        faults: [
          {
            match: (_m, url) => url.startsWith(RC_URL),
            subscriber: expiredMonthly(new Date(rcNow + 1).toISOString()),
            requestDateMs: rcNow,
          },
        ],
      },
    );
    assertEquals(later.status, 200);
    assertEquals(later.body.fulfilment?.outcome, "pending");
  },
);

Deno.test("ATK2 clock: a far-future provider clock cannot expire a live subscription", async () => {
  // RC claims it is 6 minutes in the future; the subscription expires in 3
  // minutes. Trusting the bogus clock would report `expired`.
  const result = await sync(
    null,
    { fulfilment: monthlyEvidence },
    {
      faults: [
        {
          match: (_m, url) => url.startsWith(RC_URL),
          subscriber: expiredMonthly(at(3 * 60_000)),
          requestDateMs: Date.now() + 6 * 60_000,
        },
      ],
    },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.fulfilment?.outcome, "pending");
});

Deno.test(
  "ATK2 clock: a provider clock 25h behind falls back to the isolate clock (still expired)",
  async () => {
    const result = await sync(
      null,
      { fulfilment: evidence(MONTHLY, String(NUMERIC_ID), at(-3_600_000)) },
      {
        faults: [
          {
            match: (_m, url) => url.startsWith(RC_URL),
            subscriber: {
              entitlements: {},
              subscriptions: {
                [MONTHLY]: {
                  store_transaction_id: NUMERIC_ID,
                  purchase_date: at(-3_600_000),
                  expires_date: at(-1_800_000),
                  grace_period_expires_date: null,
                  refunded_at: null,
                },
              },
            },
            requestDateMs: Date.now() - 25 * 3_600_000,
          },
        ],
      },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "expired");
  },
);

Deno.test(
  "ATK2 clock: purchase evidence dated after verification stays pending even with a matching numeric row",
  async () => {
    const future = at(120_000);
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: future,
            expires_date: at(60_000),
            refunded_at: at(-1),
          },
        },
      },
      { fulfilment: evidence(MONTHLY, String(NUMERIC_ID), future) },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  },
);

for (const [label, grace, expected] of [
  ["grace in the future", at(60_000), "pending"],
  ["grace in the past", at(-500), "expired"],
  ["grace malformed", "not-a-date", "pending"],
  ["grace numeric epoch", Date.now() - 500, "pending"],
  ["grace empty string", "", "pending"],
] as const) {
  Deno.test(`ATK2 clock: expired numeric row with ${label} → ${expected}`, async () => {
    const result = await sync(expiredMonthly(at(-1_000), grace), { fulfilment: monthlyEvidence });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, expected);
  });
}

for (const [label, refundedAt, expected] of [
  ["refund 1ms in the future", at(60_000), "pending"],
  ["refund before the purchase", "2026-07-31T23:59:59.999Z", "pending"],
  ["refund exactly at the purchase", PURCHASED_AT, "refunded"],
  ["refund malformed", "yesterday", "pending"],
  ["refund numeric epoch", Date.now() - 5_000, "pending"],
  ["refund boolean", true, "pending"],
] as const) {
  Deno.test(`ATK2 clock: numeric row with ${label} → ${expected}`, async () => {
    const result = await sync(expiredMonthly(at(-1_000), null, refundedAt), {
      fulfilment: monthlyEvidence,
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, expected);
  });
}

// ── ATTACK 3: duplicate / colliding identities across record types ───────────

Deno.test(
  "ATK3 duplicates: the same id as a numeric subscription row and a string lifetime row under one product is ambiguous",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: PURCHASED_AT,
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
        non_subscriptions: {
          [MONTHLY]: [
            { id: "x", store_transaction_id: String(NUMERIC_ID), purchase_date: PURCHASED_AT },
          ],
        },
      },
      { fulfilment: monthlyEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  },
);

Deno.test(
  "ATK3 duplicates: a lifetime row's Apple id colliding with another lifetime row's RevenueCat id is ambiguous",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
        non_subscriptions: {
          [LIFETIME]: [
            { id: "other", store_transaction_id: RC_PURCHASE_ID, purchase_date: PURCHASED_AT },
            { id: RC_PURCHASE_ID, purchase_date: PURCHASED_AT },
          ],
        },
      },
      { fulfilment: lifetimeEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
    assertEquals(result.body.billing?.premium, true);
  },
);

Deno.test(
  "ATK3 duplicates: a numeric id filed under a different product never fulfils the evidence product",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          pickle_sensei_pro_yearly: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: PURCHASED_AT,
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
      },
      { fulfilment: monthlyEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  },
);

Deno.test(
  "ATK3 duplicates: 5000 lifetime rows with exactly one numeric match still fulfil; 5000 identical ids stay pending",
  async () => {
    const noise = Array.from({ length: 4_999 }, (_, i) => ({
      id: `n${i}`,
      store_transaction_id: 2000000000000000 + i,
      purchase_date: PURCHASED_AT,
    }));
    const one = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
        non_subscriptions: {
          [LIFETIME]: [
            ...noise,
            { id: RC_PURCHASE_ID, store_transaction_id: NUMERIC_ID, purchase_date: PURCHASED_AT },
          ],
        },
      },
      { fulfilment: evidence(LIFETIME, String(NUMERIC_ID)) },
    );
    assertEquals(one.status, 200);
    assertEquals(one.body.fulfilment?.outcome, "fulfilled");
    const many = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(null, LIFETIME) },
        non_subscriptions: {
          [LIFETIME]: Array.from({ length: 5_000 }, (_, i) => ({
            id: `d${i}`,
            store_transaction_id: NUMERIC_ID,
            purchase_date: PURCHASED_AT,
          })),
        },
      },
      { fulfilment: evidence(LIFETIME, String(NUMERIC_ID)) },
    );
    assertEquals(many.status, 200);
    assertEquals(many.body.fulfilment?.outcome, "pending");
  },
);

// ── ATTACK 4: lifetime RevenueCat-id fallback boundaries ─────────────────────

const lifetimeRow = (overrides: Record<string, unknown> = {}) => ({
  id: RC_PURCHASE_ID,
  purchase_date: PURCHASED_AT,
  store: "app_store",
  is_sandbox: false,
  ...overrides,
});
const lifetimeSubscriber = (row: Record<string, unknown>, active = true) => ({
  entitlements: active ? { pickle_sensei_pro: entitlement(null, LIFETIME) } : {},
  non_subscriptions: { [LIFETIME]: [row] },
});

for (const [label, row, expected] of [
  [
    "store_transaction_id present but empty string blocks the fallback",
    lifetimeRow({ store_transaction_id: "" }),
    "pending",
  ],
  [
    "store_transaction_id false blocks the fallback",
    lifetimeRow({ store_transaction_id: false }),
    "pending",
  ],
  [
    "store_transaction_id 0 is an identity (not absence)",
    lifetimeRow({ store_transaction_id: 0 }),
    "pending",
  ],
  [
    "store_transaction_id NaN-in-JSON (null) falls back",
    lifetimeRow({ store_transaction_id: NaN }),
    "fulfilled",
  ],
  ["RevenueCat id empty string identifies nothing", lifetimeRow({ id: "" }), "pending"],
  ["RevenueCat id missing identifies nothing", lifetimeRow({ id: undefined }), "pending"],
  [
    "RevenueCat id as object identifies nothing",
    lifetimeRow({ id: { value: RC_PURCHASE_ID } }),
    "pending",
  ],
  [
    "RevenueCat id differing only by case",
    lifetimeRow({ id: RC_PURCHASE_ID.toUpperCase() }),
    "pending",
  ],
  [
    "RevenueCat id with a different purchase second",
    lifetimeRow({ purchase_date: "2026-08-01T00:00:01Z" }),
    "pending",
  ],
  [
    "RevenueCat id with an offset-equal purchase date",
    lifetimeRow({ purchase_date: "2026-08-01T02:00:00+02:00" }),
    "fulfilled",
  ],
  [
    "RevenueCat id with a fractional-second purchase date",
    lifetimeRow({ purchase_date: "2026-08-01T00:00:00.000000Z" }),
    "fulfilled",
  ],
] as const) {
  Deno.test(`ATK4 lifetime fallback: ${label} → ${expected}`, async () => {
    const result = await sync(lifetimeSubscriber(row), { fulfilment: lifetimeEvidence });
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.fulfilment?.outcome, expected);
    assert(!TERMINAL.includes(result.body.fulfilment!.outcome));
    assertEquals(result.body.billing?.premium, true);
  });
}

Deno.test(
  "ATK4 lifetime fallback: a numeric RevenueCat id normalises like a store id",
  async () => {
    const result = await sync(lifetimeSubscriber(lifetimeRow({ id: 424242 })), {
      fulfilment: evidence(LIFETIME, "424242"),
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
  },
);

Deno.test(
  "ATK4 lifetime fallback: identified lifetime with no entitlement and no refund is pending, never expired",
  async () => {
    const result = await sync(lifetimeSubscriber(lifetimeRow(), false), {
      fulfilment: lifetimeEvidence,
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
    assertEquals(result.body.billing?.premium, false);
  },
);

Deno.test(
  "ATK4 lifetime fallback: an explicit refund is honoured only when the product is not active (legacy alias too)",
  async () => {
    const refunded = lifetimeRow({ refunded_at: at(-1_000) });
    const inactive = await sync(lifetimeSubscriber(refunded, false), {
      fulfilment: lifetimeEvidence,
    });
    assertEquals(inactive.body.fulfilment?.outcome, "refunded");
    const alias = await sync(
      {
        entitlements: { premium: entitlement(null, LIFETIME) },
        non_subscriptions: { [LIFETIME]: [refunded] },
      },
      { fulfilment: lifetimeEvidence },
    );
    assertEquals(alias.status, 200);
    assertEquals(alias.body.fulfilment?.outcome, "pending");
    assertEquals(alias.body.billing?.premium, true);
    const otherProduct = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        non_subscriptions: { [LIFETIME]: [refunded] },
      },
      { fulfilment: lifetimeEvidence },
    );
    assertEquals(otherProduct.body.fulfilment?.outcome, "refunded");
    assertEquals(otherProduct.body.billing?.premium, true);
  },
);

for (const [label, subscription] of [
  ["store_transaction_id null with an id", { id: RC_PURCHASE_ID, store_transaction_id: null }],
  ["store_transaction_id absent with an id", { id: RC_PURCHASE_ID }],
  ["store_transaction_id empty with an id", { id: RC_PURCHASE_ID, store_transaction_id: "" }],
  ["original_transaction_id only", { original_transaction_id: RC_PURCHASE_ID }],
  ["transaction_id only", { transaction_id: RC_PURCHASE_ID }],
] as const) {
  Deno.test(`ATK4 subscription never resolves via RevenueCat id: ${label}`, async () => {
    const result = await sync(
      {
        entitlements: {},
        subscriptions: {
          [MONTHLY]: {
            ...subscription,
            purchase_date: PURCHASED_AT,
            expires_date: at(-1_000),
            refunded_at: at(-2_000),
          },
        },
      },
      { fulfilment: evidence(MONTHLY, RC_PURCHASE_ID) },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  });
}

// ── ATTACK 5: evidence-side boundaries and hostile keys ──────────────────────

for (const productId of [
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "toString",
  "valueOf",
  "prototype",
]) {
  Deno.test(
    `ATK5 hostile productId '${productId}' is a plain miss (200 pending, no crash)`,
    async () => {
      const result = await sync(
        {
          entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
          subscriptions: {},
          non_subscriptions: {},
        },
        { fulfilment: evidence(productId, String(NUMERIC_ID)) },
      );
      assertEquals(result.status, 200, JSON.stringify(result.body));
      assertEquals(result.body.fulfilment?.outcome, "pending");
    },
  );
}

Deno.test(
  "ATK5 hostile provider keys: '__proto__' subscription bucket never matches ordinary evidence",
  async () => {
    const result = await sync(
      null,
      { fulfilment: monthlyEvidence },
      {
        rawRc: rcBody(
          `{"entitlements":{"pickle_sensei_pro":{"expires_date":"${at(60_000)}","grace_period_expires_date":null,"product_identifier":"${MONTHLY}","purchase_date":"${at(-86_400_000)}"}},` +
            `"subscriptions":{"__proto__":{"store_transaction_id":${NUMERIC_ID},"purchase_date":"${PURCHASED_AT}","expires_date":"${at(60_000)}","refunded_at":null}}}`,
        ),
      },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
  },
);

for (const [label, transactionId, status] of [
  ["256-char id is accepted", "9".repeat(256), 200],
  ["257-char id is rejected", "9".repeat(257), 400],
  ["empty id is rejected", "", 400],
  ["id with whitespace is rejected", "1000000652379790 ", 400],
  ["id with plus sign is rejected", "+1000000652379790", 400],
  ["unicode digits are rejected", "１０００", 400],
] as const) {
  Deno.test(`ATK5 evidence id boundary: ${label}`, async () => {
    const result = await sync(
      { entitlements: {}, subscriptions: {}, non_subscriptions: {} },
      { fulfilment: evidence(MONTHLY, transactionId) },
    );
    assertEquals(result.status, status, JSON.stringify(result.body));
    if (status === 400) assertEquals(result.body.error?.code, "invalid_billing_fulfilment");
    else assertEquals(result.body.fulfilment?.outcome, "pending");
  });
}

Deno.test(
  "ATK5 evidence purchase date with an offset normalises and matches the provider's Z date",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: "2026-08-01T00:00:00Z",
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
      },
      { fulfilment: evidence(MONTHLY, String(NUMERIC_ID), "2026-07-31T19:00:00-05:00") },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "fulfilled");
    assertEquals(result.body.fulfilment?.transaction.purchasedAt, PURCHASED_AT);
  },
);

// ── ATTACK 6: provider/network failure at each step ──────────────────────────

const rcFault = (fault: Omit<Fault, "match">): Fault => ({
  match: (_m, url) => url.startsWith(RC_URL),
  ...fault,
});

for (const [label, options] of [
  ["RevenueCat 500", { faults: [rcFault({ status: 500, body: { message: "boom" } })] }],
  [
    "RevenueCat 429 + Retry-After",
    {
      rcResponse: () =>
        new Response(JSON.stringify({ code: 7000, message: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        }),
    },
  ],
  [
    "RevenueCat 302 redirect",
    {
      rcResponse: () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://api.revenuecat.com/v2/elsewhere" },
        }),
    },
  ],
  ["RevenueCat 200 with malformed JSON", { rawRc: '{"subscriber": {"entitlements": {' }],
  [
    "RevenueCat 200 with subscriptions as an array",
    {
      rawRc: rcBody(`{"entitlements":{},"subscriptions":[{"store_transaction_id":${NUMERIC_ID}}]}`),
    },
  ],
  [
    "RevenueCat 200 without entitlements",
    {
      rawRc: rcBody(
        `{"subscriptions":{"${MONTHLY}":{"store_transaction_id":${NUMERIC_ID},"purchase_date":"${PURCHASED_AT}","expires_date":"${at(-1_000)}","refunded_at":"${at(-2_000)}"}}}`,
      ),
    },
  ],
  ["RevenueCat 200 with a string body", { rawRc: '"ok"' }],
  ["RevenueCat 200 with an empty body", { rawRc: "" }],
] as const) {
  Deno.test(
    `ATK6 provider failure: ${label} → 502 billing_unavailable, no verdict written, no terminal`,
    async () => {
      const result = await sync(
        expiredMonthly(at(-1_000), null, at(-2_000)),
        { fulfilment: monthlyEvidence },
        options,
      );
      assertEquals(result.status, 502, JSON.stringify(result.body));
      assertEquals(result.body.error?.code, "billing_unavailable");
      assertEquals(result.body.fulfilment, undefined);
      assertEquals(result.writes, 0);
    },
  );
}

Deno.test(
  "ATK6 provider failure: RevenueCat timeout (abort) → 502, no verdict written",
  async () => {
    const result = await sync(
      expiredMonthly(at(-1_000), null, at(-2_000)),
      { fulfilment: monthlyEvidence },
      {
        rcResponse: () => {
          throw new DOMException("aborted", "AbortError");
        },
      },
    );
    assertEquals(result.status, 502, JSON.stringify(result.body));
    assertEquals(result.body.error?.code, "billing_unavailable");
    assertEquals(result.writes, 0);
  },
);

Deno.test(
  "ATK6 crash between steps: persistence fails after RevenueCat proves a refund → 503, nothing terminal; the retry then reports it",
  async () => {
    const sim = await simulate();
    const owner = crypto.randomUUID();
    try {
      sim.h.subscriber = expiredMonthly(at(-1_000), null, at(-2_000));
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      sim.faults.push({
        match: (m, url) => m === "POST" && url.startsWith(VERDICT_URL),
        ...dbUnavailable,
      });
      const first = await request(sim, owner, { fulfilment: monthlyEvidence });
      assertEquals(first.status, 503, JSON.stringify(first.body));
      assertEquals(first.body.fulfilment, undefined);
      assertEquals(sim.entitlementWrites.length, 0);
      const retry = await request(sim, owner, { fulfilment: monthlyEvidence });
      assertEquals(retry.status, 200);
      assertEquals(retry.body.fulfilment?.outcome, "refunded");
      assertEquals(sim.entitlementWrites.length, 1);
    } finally {
      sim.restore();
    }
  },
);

Deno.test("ATK6 begin-verification failure → 503 before RevenueCat is consulted", async () => {
  const sim = await simulate();
  try {
    sim.h.subscriber = expiredMonthly(at(-1_000), null, at(-2_000));
    sim.h.rpcErrors.begin_billing_verification = 503;
    const result = await request(sim, crypto.randomUUID(), { fulfilment: monthlyEvidence });
    assertEquals(result.status, 503, JSON.stringify(result.body));
    assertEquals(result.body.fulfilment, undefined);
    assertEquals(sim.rcCalls(), 0);
  } finally {
    sim.restore();
  }
});

// ── ATTACK 7: replay, double submit, interleaved verification order ──────────

Deno.test(
  "ATK7 replay: identical evidence submitted twice is idempotent (fulfilled both times, one verdict per attempt)",
  async () => {
    const sim = await simulate();
    const owner = crypto.randomUUID();
    try {
      sim.h.subscriber = {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: PURCHASED_AT,
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
      };
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 1, reserved_count: 0 }];
      const first = await request(sim, owner, { fulfilment: monthlyEvidence });
      const second = await request(sim, owner, { fulfilment: monthlyEvidence });
      for (const result of [first, second]) {
        assertEquals(result.status, 200);
        assertEquals(result.body.fulfilment?.outcome, "fulfilled");
        assertEquals(result.body.billing?.premium, true);
        // Free-rating conservation: a billing sync never consumes or reserves.
        assertEquals(result.body.access?.freeRatings.used, 1);
        assertEquals(result.body.access?.freeRatings.reserved, 0);
      }
      assertEquals(sim.entitlementWrites.length, 2);
      assertEquals(sim.h.callsTo("reserve_analysis_permit").length, 0);
      assertEquals(sim.h.callsTo("apply_synced_shot").length, 0);
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK7 replay: a refunded numeric row answers refunded on every replay, never fulfilled",
  async () => {
    const sim = await simulate();
    const owner = crypto.randomUUID();
    try {
      sim.h.subscriber = expiredMonthly(at(-1_000), null, at(-2_000));
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      for (let i = 0; i < 3; i += 1) {
        const result = await request(sim, owner, {
          fulfilment: evidence(MONTHLY, String(NUMERIC_ID), PURCHASED_AT, {
            attemptId: crypto.randomUUID(),
          }),
        });
        assertEquals(result.status, 200);
        assertEquals(result.body.fulfilment?.outcome, "refunded");
        assertEquals(result.body.billing?.premium, false);
      }
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK7 double submit: two concurrent syncs with the same evidence both succeed and never disagree with the stored row",
  async () => {
    const sim = await simulate();
    const owner = crypto.randomUUID();
    try {
      sim.h.subscriber = {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: PURCHASED_AT,
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
      };
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      const [a, b] = await Promise.all([
        request(sim, owner, { fulfilment: monthlyEvidence }),
        request(sim, owner, { fulfilment: monthlyEvidence }),
      ]);
      for (const result of [a, b]) {
        assertEquals(result.status, 200, JSON.stringify(result.body));
        assert(["fulfilled", "pending"].includes(result.body.fulfilment!.outcome));
        assertEquals(result.body.billing?.premium, true);
        assertEquals(result.body.access?.premium, true);
      }
      assert([a, b].some((r) => r.body.fulfilment?.outcome === "fulfilled"));
    } finally {
      sim.restore();
    }
  },
);

Deno.test(
  "ATK7 interleaved: a slow, superseded verification reports pending even when its provider row proves refunded",
  async () => {
    // Request A begins first (lower verification order) but RevenueCat answers
    // it slowly with a refund; request B begins later, is answered at once and
    // lands first. A's verdict is stale (applied=false) and must not surface a
    // terminal outcome from a superseded verdict.
    const sim = await simulate();
    const owner = crypto.randomUUID();
    try {
      sim.h.subscriber = {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: PURCHASED_AT,
            expires_date: at(60_000),
            refunded_at: null,
          },
        },
      };
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      sim.faults.push(
        rcFault({ delayMs: 300, subscriber: expiredMonthly(at(-1_000), null, at(-2_000)) }),
      );
      const slow = request(sim, owner, { fulfilment: monthlyEvidence });
      await new Promise((r) => setTimeout(r, 50));
      const fast = await request(sim, owner, { fulfilment: monthlyEvidence });
      const stale = await slow;
      assertEquals(fast.status, 200);
      assertEquals(fast.body.fulfilment?.outcome, "fulfilled");
      assertEquals(stale.status, 200, JSON.stringify(stale.body));
      assertEquals(stale.body.fulfilment?.outcome, "pending");
      assertEquals(stale.body.billing?.premium, true);
      assertEquals(sim.entitlementWrites.length, 1);
    } finally {
      sim.restore();
    }
  },
);

// ── ATTACK 8: unauthorised callers and foreign evidence ──────────────────────

Deno.test(
  "ATK8 anonymous caller → 401 before RevenueCat or the ticket RPC is touched",
  async () => {
    const result = await sync(
      expiredMonthly(at(-1_000), null, at(-2_000)),
      { fulfilment: monthlyEvidence },
      {
        token: null,
      },
    );
    assertEquals(result.status, 401, JSON.stringify(result.body));
    assertEquals(result.rcCalls, 0);
    assertEquals(result.writes, 0);
  },
);

Deno.test("ATK8 garbage bearer → 401 before RevenueCat is touched", async () => {
  const result = await sync(
    expiredMonthly(at(-1_000), null, at(-2_000)),
    { fulfilment: monthlyEvidence },
    {
      token: "not.a.jwt",
    },
  );
  assertEquals(result.status, 401, JSON.stringify(result.body));
  assertEquals(result.rcCalls, 0);
});

Deno.test(
  "ATK8 foreign evidence: another account replaying a victim's numeric receipt is verified against ITS OWN subscriber",
  async () => {
    const sim = await simulate();
    const victim = crypto.randomUUID();
    const attacker = crypto.randomUUID();
    try {
      sim.h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      // RevenueCat knows the victim's purchase only under the victim's id.
      sim.h.respond = (call) => {
        if (!call.url.startsWith(RC_URL)) return null;
        const id = decodeURIComponent(call.url.slice(RC_URL.length));
        const subscriber =
          id === victim
            ? {
                entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
                subscriptions: {
                  [MONTHLY]: {
                    store_transaction_id: NUMERIC_ID,
                    purchase_date: PURCHASED_AT,
                    expires_date: at(60_000),
                    refunded_at: null,
                  },
                },
              }
            : { entitlements: {} };
        return new Response(JSON.stringify({ request_date_ms: Date.now(), subscriber }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      const stolen = await request(sim, attacker, { fulfilment: monthlyEvidence });
      assertEquals(stolen.status, 200);
      assertEquals(stolen.body.fulfilment?.outcome, "pending");
      assertEquals(stolen.body.billing?.premium, false);
      assertEquals(stolen.body.access?.premium, false);
      const rc = sim.h.callsTo(RC_URL);
      assertEquals(rc.length, 1);
      assert(rc[0].url.endsWith(encodeURIComponent(attacker)));
      const own = await request(sim, victim, { fulfilment: monthlyEvidence });
      assertEquals(own.body.fulfilment?.outcome, "fulfilled");
    } finally {
      sim.restore();
    }
  },
);

// ── ATTACK 9: exact purchase_date matching (pre-existing key, kept by W07-01) ─
// Sub-second skew or a renewal that moved the subscription row's ids away
// from the original receipt leaves the receipt unidentified. The invariant
// under attack is conservation: unidentified is pending, never terminal, and
// the active entitlement still grants access.

Deno.test(
  "ATK9 purchase_date: sub-second skew between receipt and provider row stays pending, never terminal",
  async () => {
    const result = await sync(
      {
        entitlements: { pickle_sensei_pro: entitlement(at(60_000), MONTHLY) },
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID,
            purchase_date: "2026-08-01T00:00:00Z",
            expires_date: at(60_000),
            refunded_at: at(-1),
          },
        },
      },
      { fulfilment: evidence(MONTHLY, String(NUMERIC_ID), "2026-08-01T00:00:00.437Z") },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
    assertEquals(result.body.billing?.premium, true);
  },
);

Deno.test(
  "ATK9 purchase_date: a renewal that replaced the row's id and date leaves the original receipt pending, never expired",
  async () => {
    const result = await sync(
      {
        entitlements: {},
        subscriptions: {
          [MONTHLY]: {
            store_transaction_id: NUMERIC_ID + 1,
            original_purchase_date: PURCHASED_AT,
            purchase_date: "2026-09-01T00:00:00Z",
            expires_date: at(-1_000),
            grace_period_expires_date: null,
            refunded_at: null,
          },
        },
      },
      { fulfilment: monthlyEvidence },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.fulfilment?.outcome, "pending");
    assertEquals(result.body.billing?.premium, false);
  },
);

Deno.test("ATK8 evidence body cannot smuggle an app_user_id or a verdict", async () => {
  const result = await sync(
    { entitlements: {}, subscriptions: {}, non_subscriptions: {} },
    {
      fulfilment: { ...monthlyEvidence, outcome: "fulfilled", appUserId: crypto.randomUUID() },
      billing: { premium: true },
      app_user_id: crypto.randomUUID(),
    },
  );
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assertEquals(result.body.fulfilment?.outcome, "pending");
  assertEquals(result.body.billing?.premium, false);
});
