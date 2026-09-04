// ADVERSARIAL PASS 3 — edge-billing-webhook (POST /webhooks/revenuecat).
//
// Attacks the REAL handler (index.ts → handleRevenueCatWebhook) through the
// black-box harness: RevenueCat + PostgREST stubbed at the fetch layer, the
// in-memory rate limiter live, every request routed through handleRequest.
// Each test names the scenario it executes and whether the behaviour HELD
// or is BROKEN against 4d812e1a. Database-level confirmations (btree row
// size, uuid normalisation, 4.9 MB jsonb) live in
// attack_billing_webhook_3_pg.sh / .sql against a throwaway postgres:16.
//
// Run: cd supabase/functions/api/__wf__ && deno task test attack_billing_webhook_3.test.ts
//
// Seeds: every random value is derived from SEED below so a failure replays.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  activeSubscriber,
  type Harness,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  type RecordedCall,
  TEST_USER_ID,
  userRequest,
  WEBHOOK_SECRET,
  webhookRequest,
} from "./routesHarness.ts";

const SEED = 0x5eed_0003;

/** Small deterministic PRNG (mulberry32) so ids/IPs are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(SEED);
const hex = (n: number) =>
  Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join(
    "",
  );
/** A fresh RFC-4122-shaped v4 uuid (lowercase) from the seeded PRNG. */
const seededUuid = () =>
  `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(random() * 4)]}${
    hex(3)
  }-${hex(12)}`;
/** Distinct client IP per test so the per-isolate fixed windows never bleed. */
let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter += 1)}`;

/** A uuid that actually contains hex letters (TEST_USER_ID is all digits). */
const CASE_USER_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const UPPER_USER_ID = CASE_USER_ID.toUpperCase();
assertNotEquals(UPPER_USER_ID, CASE_USER_ID);

const entitlementWrites = (h: Harness): RecordedCall[] =>
  h.callsTo("/rest/v1/billing_entitlements").filter((c) => c.method === "POST");
const auditWrites = (h: Harness): RecordedCall[] =>
  h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST");
const auditLookups = (h: Harness): RecordedCall[] =>
  h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "GET");

/** Every string that left the function, for "never touched" assertions. */
function everythingSent(h: Harness): string {
  return h.calls.map((c) => `${c.url}\n${JSON.stringify(c.body ?? null)}`).join(
    "\n",
  );
}

/** Temporarily intercept the harness fetch so a PostgREST write can fail the
 * way the real database would. Restores on exit even when the test throws. */
async function withRestOverride<T>(
  intercept: (request: Request) => Response | null,
  run: () => Promise<T>,
): Promise<T> {
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const custom = intercept(request.clone());
    if (custom) {
      // The harness still records the call (it reads the body itself).
      await stubbed(request.clone());
      return custom;
    }
    return stubbed(request);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = stubbed;
  }
}

/** Collect console.error lines emitted while `run` executes. */
async function captureErrors<T>(
  run: () => Promise<T>,
): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  try {
    return { result: await run(), errors };
  } finally {
    console.error = original;
  }
}

/** PostgREST's rendering of a PostgreSQL error (status 400 for 54000). */
const pgError = (code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

// ─────────────────────────────────────────────────────────────────────────────
// S1 — 30 wrong-secret deliveries then one correct one from the SAME IP.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S1 HELD: 30 wrong-secret webhook deliveries from one IP do not spend the auth-failure budget — the 31st (correct) delivery is 200 and fully processed",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const ip = freshIp();
    for (let i = 0; i < 30; i += 1) {
      const res = await h.handler(
        webhookRequest(
          { id: `s1-bad-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID },
          { authorization: `wrong-${hex(8)}`, ip },
        ),
      );
      assertEquals(res.status, 401, `wrong secret #${i}`);
      await res.text();
    }
    assertEquals(
      h.calls.length,
      0,
      "401s reach neither RevenueCat nor the database",
    );

    const ok = await h.handler(
      webhookRequest({
        id: "s1-good",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      }, { ip }),
    );
    assertEquals(ok.status, 200);
    assertEquals(await ok.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(entitlementWrites(h).length, 1);
    assertEquals(auditWrites(h).length, 1);

    // The same IP is not throttled on the authenticated API either: the
    // webhook 401s were never counted as "authfail" (which trips at 30).
    const probe = await h.handler(userRequest("GET", "/v1/me/access", { ip }));
    assertNotEquals(
      probe.status,
      429,
      "authfail budget untouched by webhook 401s",
    );
    await probe.text();
  },
);

Deno.test(
  "S1b HELD (reverse): an IP whose auth-failure budget IS exhausted (30 bad bearers → 429 on /v1) still delivers a correct webhook with 200",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const ip = freshIp();
    // Fake Supabase Auth rejects nothing, so trip the budget with tokens the
    // router itself refuses (unknown issuer → 401 → recordAuthFailure).
    const badBearer = "not.a.jwt";
    for (let i = 0; i < 30; i += 1) {
      const res = await h.handler(
        userRequest("GET", "/v1/me/access", { ip, token: badBearer }),
      );
      assertEquals(res.status, 401, `bad bearer #${i}`);
      await res.text();
    }
    const tripped = await h.handler(
      userRequest("GET", "/v1/me/access", { ip, token: badBearer }),
    );
    assertEquals(
      tripped.status,
      429,
      "authfail budget is now exhausted for this IP",
    );
    await tripped.text();

    h.reset();
    h.subscriber = activeSubscriber();
    const ok = await h.handler(
      webhookRequest({
        id: "s1b-good",
        type: "RENEWAL",
        app_user_id: TEST_USER_ID,
      }, { ip }),
    );
    assertEquals(
      ok.status,
      200,
      "webhook path is matched before the authfail peek",
    );
    assertEquals(await ok.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 1);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S2 — Authorization: Bearer <secret> (RevenueCat's own API example stores
// the header as "Bearer 123456"). Exact-match contract → 401.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S2 HELD-as-coded / P3 operability: 'Bearer <secret>' (and every other framing of the right secret) is 401 with no distinguishing log — a dashboard mismatch is a silent 401 storm",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const ip = freshIp();
    const accessLines: string[] = [];
    const restore = captureAccessLog((line) => accessLines.push(line));
    let errors: string[] = [];
    try {
      const framings = [
        `Bearer ${WEBHOOK_SECRET}`,
        `bearer ${WEBHOOK_SECRET}`,
        `Basic ${btoa(WEBHOOK_SECRET)}`,
        `Authorization: ${WEBHOOK_SECRET}`,
        `"${WEBHOOK_SECRET}"`,
      ];
      const captured = await captureErrors(async () => {
        for (const authorization of framings) {
          const res = await h.handler(
            webhookRequest(
              {
                id: `s2-${hex(6)}`,
                type: "RENEWAL",
                app_user_id: TEST_USER_ID,
              },
              { authorization, ip },
            ),
          );
          assertEquals(res.status, 401, JSON.stringify(authorization));
          assertEquals(await res.json(), {
            error: { message: "Invalid webhook credentials." },
          });
        }
      });
      errors = captured.errors;
    } finally {
      restore();
    }
    assertEquals(
      h.calls.length,
      0,
      "no RevenueCat / database traffic on any framing",
    );
    assertEquals(
      errors,
      [],
      "no operator-facing error line names the rejected header shape",
    );
    assertEquals(accessLines.length, 5);
    for (const line of accessLines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      assertEquals(entry.status, 401);
      assertEquals(
        entry.code,
        undefined,
        "401 carries no error.code → indistinguishable from any other 401",
      );
    }
    // Sanity: the bare secret IS accepted from the same IP right after, and so
    // is the secret wrapped in leading/trailing SP / HTAB — RFC 9110 OWS is
    // stripped by the Headers parser before the constant-time compare, which
    // is HTTP semantics, not a bypass (the secret itself is intact).
    for (
      const authorization of [
        WEBHOOK_SECRET,
        `${WEBHOOK_SECRET} `,
        `\t ${WEBHOOK_SECRET}\t`,
      ]
    ) {
      const ok = await h.handler(
        webhookRequest({
          id: `s2-ok-${hex(6)}`,
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }, {
          authorization,
          ip,
        }),
      );
      assertEquals(ok.status, 200, JSON.stringify(authorization));
      await ok.text();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S3 — 4.9 MB body with the correct secret: accepted and audited verbatim.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_BODY_BYTES = 4_900_000;

function hugeWebhookBody(
  id: string,
  extra: Record<string, unknown> = {},
): string {
  const skeleton = JSON.stringify({
    api_version: "1.0",
    event: { id, type: "TEST", ...extra, pad: "" },
  });
  const pad = "x".repeat(TARGET_BODY_BYTES - skeleton.length);
  const raw = JSON.stringify({
    api_version: "1.0",
    event: { id, type: "TEST", ...extra, pad },
  });
  assertEquals(new TextEncoder().encode(raw).byteLength, TARGET_BODY_BYTES);
  return raw;
}

Deno.test(
  "S3 BROKEN (P2 storage amplification): a 4.9 MB event with the correct secret and NO subscriber is 200 in one DB round trip and the whole 4.9 MB lands in webhook_events.payload",
  async () => {
    const h = await loadHarness();
    const ip = freshIp();
    const raw = hugeWebhookBody("s3-huge");
    const started = performance.now();
    const res = await h.handler(webhookRequest(null, { rawBody: raw, ip }));
    const elapsedMs = performance.now() - started;
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(
      h.callsTo(RC_URL).length,
      0,
      "anonymous path: no RevenueCat call gates the write",
    );
    const audit = auditWrites(h);
    assertEquals(audit.length, 1);
    const row = audit[0].body as Record<string, unknown>;
    assertEquals(row.id, "s3-huge");
    const persisted = JSON.stringify(row.payload);
    assertEquals(
      persisted,
      raw,
      "payload column receives the entire request body verbatim",
    );
    assertEquals(
      new TextEncoder().encode(persisted).byteLength,
      TARGET_BODY_BYTES,
    );
    console.log(
      `[attack-3 S3] 4.9 MB delivery handled in ${
        Math.round(elapsedMs)
      } ms; persisted payload bytes=${TARGET_BODY_BYTES}`,
    );
  },
);

Deno.test(
  "S3b BROKEN (P2): 5 distinct 4.9 MB events in a row from one IP are all 200 — the per-IP window (240/min) is the ONLY brake, i.e. ≈1.1 GB/min/IP of jsonb with a leaked secret",
  async () => {
    const h = await loadHarness();
    const ip = freshIp();
    let bytes = 0;
    for (let i = 0; i < 5; i += 1) {
      const raw = hugeWebhookBody(`s3b-${i}-${hex(8)}`);
      const res = await h.handler(webhookRequest(null, { rawBody: raw, ip }));
      assertEquals(res.status, 200, `delivery #${i}`);
      await res.text();
      bytes += raw.length;
    }
    assertEquals(auditWrites(h).length, 5);
    assertEquals(bytes, 5 * TARGET_BODY_BYTES);
    // Same payload with a real subject: the RC round trip does not shrink
    // what is audited either.
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest(null, {
        rawBody: hugeWebhookBody("s3b-subject", { app_user_id: TEST_USER_ID }),
        ip,
      }),
    );
    assertEquals(res.status, 200);
    await res.text();
    const last = auditWrites(h).at(-1)!.body as Record<string, unknown>;
    assertEquals(JSON.stringify(last.payload).length, TARGET_BODY_BYTES);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S4 — event.id of 4000 bytes: the audit upsert fails on the btree row-size
// limit (54000) and that failure is ONLY logged; the event is still 200.
// attack_billing_webhook_3_pg.sql pins the real PG behaviour: an
// INCOMPRESSIBLE 4000-byte id is rejected (54000 "index row size 4016 exceeds
// btree version 4 maximum 2704"), while repeat('a', 3997) compresses inside
// the index tuple and IS stored. The PostgREST error below is the exact
// message the live insert produced.
// ─────────────────────────────────────────────────────────────────────────────

const BTREE_ERROR =
  'index row size 4016 exceeds btree version 4 maximum 2704 for index "webhook_events_pkey"';

Deno.test(
  "S4 BROKEN (P2 audit gap): an incompressible 4000-byte event.id is processed (RC verified, entitlement written) and 200 verified:true even though the audit upsert fails with 54000 — the error is only console.error'd; the replay is re-processed",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const ip = freshIp();
    const longId = `s4-${hex(3997)}`; // seeded, incompressible
    assertEquals(new TextEncoder().encode(longId).byteLength, 4000);
    const event = { id: longId, type: "RENEWAL", app_user_id: TEST_USER_ID };

    const { result, errors } = await captureErrors(() =>
      withRestOverride(
        (req) =>
          req.method === "POST" &&
            new URL(req.url).pathname.endsWith("/rest/v1/webhook_events")
            ? pgError("54000", BTREE_ERROR)
            : null,
        async () => {
          const first = await h.handler(webhookRequest(event, { ip }));
          const firstBody = await first.json();
          const second = await h.handler(webhookRequest(event, { ip }));
          const secondBody = await second.json();
          return { first, firstBody, second, secondBody };
        },
      )
    );
    assertEquals(result.first.status, 200);
    assertEquals(result.firstBody, { received: true, verified: true });
    assertEquals(result.second.status, 200);
    assertEquals(
      result.secondBody,
      { received: true, verified: true },
      "not deduped: no row exists",
    );

    assertEquals(
      h.callsTo(RC_URL).length,
      2,
      "both deliveries re-verify against RevenueCat",
    );
    assertEquals(
      entitlementWrites(h).length,
      2,
      "both deliveries write billing_entitlements",
    );
    assertEquals(
      auditWrites(h).length,
      2,
      "both audit upserts were attempted…",
    );
    assertEquals(
      errors.filter((e) =>
        e.includes("webhook event log failed") && e.includes(BTREE_ERROR)
      ).length,
      2,
      "…and both failures were only logged",
    );
    // The dedupe lookup also carries the 4000-byte id in the PostgREST URL.
    const lookups = auditLookups(h);
    assertEquals(lookups.length, 2);
    assert(
      lookups[0].url.length > 4000,
      `lookup URL is ${lookups[0].url.length} bytes`,
    );
    assertStringIncludes(lookups[0].url, `id=eq.${longId}`);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S5 — uppercase UUID as app_user_id.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S5 BROKEN (P2 case-mismatch revocation): an UPPERCASE uuid passes isUuid, is sent to RevenueCat verbatim (a DIFFERENT, auto-created subscriber) and its premium:false verdict is upserted with the uppercase user_id — which PG folds onto the victim's real row",
  async () => {
    const h = await loadHarness();
    // RevenueCat has never seen the uppercase spelling → fresh subscriber,
    // no entitlements (GET auto-creates, per index.ts comment).
    h.subscriber = { entitlements: {} };
    const ip = freshIp();
    const res = await h.handler(
      webhookRequest({
        id: "s5-upper",
        type: "RENEWAL",
        app_user_id: UPPER_USER_ID,
      }, { ip }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });

    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(UPPER_USER_ID)), rc[0].url);
    assert(
      !rc[0].url.endsWith(CASE_USER_ID),
      "the lowercase (real) subscriber was NOT the one queried",
    );

    const writes = entitlementWrites(h);
    assertEquals(writes.length, 1);
    const row = writes[0].body as Record<string, unknown>;
    assertEquals(
      row.user_id,
      UPPER_USER_ID,
      "user_id is sent uppercase (PG normalises → same row)",
    );
    assertEquals(
      row.premium,
      false,
      "verdict from the wrong subscriber: not premium",
    );
    assertStringIncludes(
      String(writes[0].headers["prefer"]),
      "resolution=merge-duplicates",
    );
    const audit = auditWrites(h)[0].body as Record<string, unknown>;
    assertEquals(audit.app_user_id, UPPER_USER_ID);
  },
);

Deno.test(
  "S5b HELD (control): the SAME event with the lowercase uuid queries the real subscriber and writes premium:true — only the spelling differs",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({
        id: "s5-lower",
        type: "RENEWAL",
        app_user_id: CASE_USER_ID,
      }, { ip: freshIp() }),
    );
    assertEquals(res.status, 200);
    await res.text();
    assert(h.callsTo(RC_URL)[0].url.endsWith(encodeURIComponent(CASE_USER_ID)));
    const row = entitlementWrites(h)[0].body as Record<string, unknown>;
    assertEquals(row.user_id, CASE_USER_ID);
    assertEquals(row.premium, true);
  },
);

Deno.test(
  "S5c BROKEN (P3): mixed-case spellings of ONE uuid in a TRANSFER are treated as distinct subjects — 3 RevenueCat calls and 3 upserts that all collapse onto one PG row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const mixed = CASE_USER_ID.replace(
      /[a-f]/g,
      (c, i) => (i % 2 ? c.toUpperCase() : c),
    );
    assertNotEquals(mixed, CASE_USER_ID);
    assertNotEquals(mixed, UPPER_USER_ID);
    const res = await h.handler(
      webhookRequest(
        {
          id: "s5c-transfer",
          type: "TRANSFER",
          transferred_from: [CASE_USER_ID, UPPER_USER_ID],
          transferred_to: [mixed],
        },
        { ip: freshIp() },
      ),
    );
    assertEquals(res.status, 200);
    await res.text();
    assertEquals(h.callsTo(RC_URL).length, 3);
    const ids = entitlementWrites(h).map((c) =>
      (c.body as Record<string, unknown>).user_id
    );
    assertEquals(ids, [CASE_USER_ID, UPPER_USER_ID, mixed]);
    assertEquals(new Set(ids.map((id) => String(id).toLowerCase())).size, 1);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S6 — anonymous app_user_id with two uuid aliases: only the FIRST is used.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S6 HELD: app_user_id='$RCAnonymousID:abc' + aliases=[A, B] → only A is verified and persisted; B never appears in any outbound request",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest(
        {
          id: "s6-anon-aliases",
          type: "INITIAL_PURCHASE",
          app_user_id: "$RCAnonymousID:abc",
          aliases: ["$RCAnonymousID:abc", TEST_USER_ID, OTHER_USER_ID],
        },
        { ip: freshIp() },
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(TEST_USER_ID)));
    const writes = entitlementWrites(h);
    assertEquals(writes.length, 1);
    assertEquals(
      (writes[0].body as Record<string, unknown>).user_id,
      TEST_USER_ID,
    );
    const audit = auditWrites(h)[0].body as Record<string, unknown>;
    assertEquals(
      audit.app_user_id,
      TEST_USER_ID,
      "audit subject is the alias that was verified",
    );
    // B is present ONLY inside the audited raw payload (event.aliases), never
    // as a subject: not in any URL, not in any billing_entitlements body.
    const outsideAudit = h.calls
      .filter((c) => !c.url.includes("/rest/v1/webhook_events"))
      .map((c) => `${c.url}\n${JSON.stringify(c.body ?? null)}`)
      .join("\n");
    assert(!outsideAudit.includes(OTHER_USER_ID), "UUID_B never touched");
    assert(!outsideAudit.toLowerCase().includes(OTHER_USER_ID.toLowerCase()));
  },
);

Deno.test(
  "S6b HELD (order-dependent by design): aliases=[B, A] verifies B instead — the FIRST uuid alias wins, RevenueCat's ordering decides which account is refreshed",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest(
        {
          id: "s6b-anon-aliases-reversed",
          type: "INITIAL_PURCHASE",
          app_user_id: "$RCAnonymousID:abc",
          aliases: [OTHER_USER_ID, TEST_USER_ID],
        },
        { ip: freshIp() },
      ),
    );
    assertEquals(res.status, 200);
    await res.text();
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(OTHER_USER_ID)));
    assertEquals(entitlementWrites(h).length, 1);
    assertEquals(
      (entitlementWrites(h)[0].body as Record<string, unknown>).user_id,
      OTHER_USER_ID,
    );
    // A remains only inside the audited raw payload — never a subject.
    const nonAudit = h.calls.filter((c) =>
      !c.url.includes("/rest/v1/webhook_events")
    );
    assert(
      !nonAudit.some((c) =>
        `${c.url}${JSON.stringify(c.body)}`.includes(TEST_USER_ID)
      ),
    );
    assertStringIncludes(
      everythingSent(h),
      TEST_USER_ID,
      "…but it IS preserved in the audit payload",
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S7 — uuid app_user_id with a uuid alias: the alias is ignored.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S7 HELD: app_user_id=A + aliases=[B] → only A is re-verified; B is ignored (not in the RC URL, not in billing_entitlements, not the audit subject)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest(
        {
          id: "s7-primary-with-alias",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
          aliases: [OTHER_USER_ID, "$RCAnonymousID:zzz"],
        },
        { ip: freshIp() },
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(TEST_USER_ID)));
    const writes = entitlementWrites(h);
    assertEquals(writes.length, 1);
    assertEquals(
      (writes[0].body as Record<string, unknown>).user_id,
      TEST_USER_ID,
    );
    assertEquals(
      (auditWrites(h)[0].body as Record<string, unknown>).app_user_id,
      TEST_USER_ID,
    );
    const nonAudit = h.calls.filter((c) =>
      !c.url.includes("/rest/v1/webhook_events")
    );
    assert(
      !nonAudit.some((c) =>
        `${c.url}${JSON.stringify(c.body)}`.includes(OTHER_USER_ID)
      ),
    );
  },
);

Deno.test(
  "S7b HELD: with app_user_id=A, a hostile aliases list (500 uuids, non-strings, nested arrays) costs nothing — still exactly one RevenueCat call",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const aliases: unknown[] = Array.from({ length: 500 }, seededUuid);
    aliases.push(
      42,
      null,
      { id: OTHER_USER_ID },
      [OTHER_USER_ID],
      "$RCAnonymousID:x",
    );
    const res = await h.handler(
      webhookRequest(
        {
          id: "s7b-hostile-aliases",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
          aliases,
        },
        { ip: freshIp() },
      ),
    );
    assertEquals(res.status, 200);
    await res.text();
    assertEquals(h.callsTo(RC_URL).length, 1);
    assertEquals(entitlementWrites(h).length, 1);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Extra — the TRANSFER lists have no cap: one delivery fans out to N
// RevenueCat calls + N service-role upserts (S7b shows aliases ARE capped).
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "X1 BROKEN (P2 unbounded fan-out): one TRANSFER with 300 distinct uuids in transferred_to → 300 sequential RevenueCat calls and 300 billing_entitlements upserts from a single authenticated request",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const targets = Array.from({ length: 300 }, seededUuid);
    assertEquals(new Set(targets).size, 300, "seeded ids are distinct");
    const res = await h.handler(
      webhookRequest(
        {
          id: "x1-fanout",
          type: "TRANSFER",
          transferred_from: [],
          transferred_to: targets,
        },
        { ip: freshIp() },
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    assertEquals(h.callsTo(RC_URL).length, 300);
    assertEquals(entitlementWrites(h).length, 300);
    assertEquals(auditWrites(h).length, 1);
  },
);

Deno.test(
  "X2 HELD: a TRANSFER whose lists hold ONLY non-uuid strings is acknowledged with verified:false and one audit row — no RevenueCat traffic",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest(
        {
          id: "x2-anon-transfer",
          type: "TRANSFER",
          transferred_from: ["$RCAnonymousID:from"],
          transferred_to: ["$RCAnonymousID:to", "not-a-uuid", 7],
        },
        { ip: freshIp() },
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(entitlementWrites(h).length, 0);
    assertEquals(auditWrites(h).length, 1);
    assertEquals(
      (auditWrites(h)[0].body as Record<string, unknown>).app_user_id,
      null,
    );
  },
);
