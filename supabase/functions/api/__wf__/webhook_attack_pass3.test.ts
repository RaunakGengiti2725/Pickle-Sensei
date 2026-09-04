// Adversarial pass 3 — RevenueCat webhook (POST /webhooks/revenuecat).
//
// Every test drives the REAL handler from index.ts through routesHarness with
// the fault-injection layer in webhookAttackHarness.ts. Each test is labelled
// with the scenario it executes and whether the observed behaviour is the
// assignment's expectation (HELD) or a defect pinned as a REPRO (BROKEN): the
// REPRO tests assert what the code DOES today so the defect is executable
// evidence, not a claim — fix the handler and they fail, which is the signal
// to turn them into the correct-behaviour assertions.
//
// Wall-clock experiments (scenario 8 at a real 9 s RevenueCat delay) run only
// with WEBHOOK_ATTACK_REALTIME=1; the default run uses a scaled delay and
// extrapolates, so `deno task test` stays fast.

import { assert, assertEquals, assertExists, assertNotEquals, assertThrows } from "@std/assert";
import {
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  WEBHOOK_SECRET,
  webhookRequest,
} from "./routesHarness.ts";
import {
  expiredSubscriber,
  loadAttackHarness,
  matchAuditLookup,
  matchAuditUpsert,
  matchEntitlementUpsert,
  matchEntitlementUpsertFor,
  matchRc,
  matchRcFor,
  noEntitlements,
  postgrestError,
  premiumSubscriber,
  rcSubscriber,
  rcUserFromUrl,
  readJson,
  seededUuids,
} from "./webhookAttackHarness.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REALTIME = Deno.env.get("WEBHOOK_ATTACK_REALTIME") === "1";
// Budgets the handler must fit inside (VERIFIED from vendor docs, see the
// artifact notes): RevenueCat disconnects after 60 s and retries at most 5
// times; the Supabase gateway answers 504 after 150 s without a response.
const RC_DISCONNECT_MS = 60_000;
const EDGE_IDLE_TIMEOUT_MS = 150_000;
const RC_LOOKUP_TIMEOUT_MS = 10_000; // AbortSignal.timeout in verifyRevenueCatSubscriber

let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

const errorMessage = async (res: Response) => {
  const body = await readJson(res);
  const error = body.error as Record<string, unknown> | undefined;
  return error?.message;
};

const event = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  type: "RENEWAL",
  app_user_id: TEST_USER_ID,
  event_timestamp_ms: 1_756_600_000_000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Scenario 1 — numeric event.id ×3 → 3 RC calls, 3 audit rows, distinct UUIDs
// ---------------------------------------------------------------------------
Deno.test(
  "S1 HELD: numeric event.id is replaced by a fresh random UUID on every delivery (no dedupe possible)",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      const ip = freshIp();
      for (let i = 0; i < 3; i++) {
        const res = await a.h.handler(webhookRequest(event({ id: 1234567890 }), { ip }));
        assertEquals(res.status, 200);
        assertEquals(await readJson(res), { received: true, verified: true });
      }
      assertEquals(a.rcCalls().length, 3, "each delivery re-verifies with RevenueCat");
      const audit = a.auditUpserts();
      assertEquals(audit.length, 3, "each delivery writes its own audit row");
      const ids = audit.map((c) => (c.body as Record<string, unknown>).id as string);
      assertEquals(new Set(ids).size, 3, `ids must be distinct: ${ids.join(",")}`);
      for (const id of ids) assert(UUID_RE.test(id), `generated id must be a v4 UUID: ${id}`);
      // The dedupe lookup ran against the random id, never against the numeric one.
      for (const lookup of a.auditLookups()) {
        assert(!lookup.url.includes("eq.1234567890"), lookup.url);
      }
      // The original numeric id survives only inside payload.
      for (const c of audit) {
        const body = c.body as Record<string, unknown>;
        const payload = body.payload as Record<string, unknown>;
        assertEquals((payload.event as Record<string, unknown>).id, 1234567890);
      }
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 2 — event:[] / event:'string' / event:{} → 400 / 400 / 200 verified:false + audit 'unknown'
// ---------------------------------------------------------------------------
Deno.test(
  "S2 HELD: malformed event containers → 400/400, empty object → 200 verified:false with an 'unknown' audit row",
  async () => {
    const a = await loadAttackHarness();
    try {
      const ip = freshIp();
      const send = (rawBody: string) => a.h.handler(webhookRequest(null, { ip, rawBody }));

      const arr = await send(JSON.stringify({ api_version: "1.0", event: [] }));
      assertEquals(arr.status, 400);
      assertEquals(await errorMessage(arr), "Missing event payload.");

      const str = await send(JSON.stringify({ api_version: "1.0", event: "string" }));
      assertEquals(str.status, 400);
      assertEquals(await errorMessage(str), "Missing event payload.");

      assertEquals(a.trace.length, 0, "rejected shapes never touch the DB or RevenueCat");

      const empty = await send(JSON.stringify({ api_version: "1.0", event: {} }));
      assertEquals(empty.status, 200);
      assertEquals(await readJson(empty), { received: true, verified: false });
      assertEquals(a.rcCalls().length, 0);
      assertEquals(a.entitlementUpserts().length, 0);
      const audit = a.auditUpserts();
      assertEquals(audit.length, 1);
      const row = audit[0].body as Record<string, unknown>;
      assertEquals(row.event_type, "unknown");
      assertEquals(row.app_user_id, null);
      assertEquals(row.provider, "revenuecat");
      assert(UUID_RE.test(String(row.id)), `id must be a generated UUID: ${row.id}`);

      // Extra shapes in the same family.
      for (const body of ["null", "[]", '"x"', "42", "not json at all", ""]) {
        const res = await send(body);
        assertEquals(res.status, 400, `raw body ${JSON.stringify(body)} must be 400`);
      }
      const nested = await send(
        JSON.stringify({
          event: { event: { id: "inner", type: "RENEWAL", app_user_id: TEST_USER_ID } },
        }),
      );
      assertEquals(nested.status, 200);
      assertEquals(await readJson(nested), { received: true, verified: false });
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 3 — dashboard TEST event with a non-UUID id → 200 verified:false, 1 audit row, 0 RC calls
// ---------------------------------------------------------------------------
Deno.test(
  "S3 HELD: RevenueCat dashboard TEST event (non-UUID app_user_id) is audited once and never verified",
  async () => {
    const a = await loadAttackHarness();
    try {
      const ip = freshIp();
      const testEvent = {
        id: "3F7D8E2A-5A9B-4F0C-B2E1-000000000001",
        type: "TEST",
        app_id: "app1234",
        app_user_id: "$RCAnonymousID:test_user",
        original_app_user_id: "$RCAnonymousID:test_user",
        aliases: ["$RCAnonymousID:test_user"],
        environment: "SANDBOX",
        event_timestamp_ms: 1_756_600_000_000,
      };
      const res = await a.h.handler(webhookRequest(testEvent, { ip }));
      assertEquals(res.status, 200);
      assertEquals(await readJson(res), { received: true, verified: false });
      assertEquals(a.rcCalls().length, 0, "no RevenueCat lookup for a non-UUID subject");
      assertEquals(a.entitlementUpserts().length, 0);
      assertEquals(a.auditUpserts().length, 1);
      const row = a.auditUpserts()[0].body as Record<string, unknown>;
      assertEquals(row.id, testEvent.id);
      assertEquals(row.event_type, "TEST");
      assertEquals(row.app_user_id, null);
      assertEquals(a.auditRows.size, 1);

      // Pressing the dashboard button twice re-sends the same id → duplicate.
      const again = await a.h.handler(webhookRequest(testEvent, { ip }));
      assertEquals(await readJson(again), { received: true, duplicate: true });
      assertEquals(a.auditUpserts().length, 1);
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 4 — REVENUECAT_WEBHOOK_AUTH with trailing newline → every real header is 401
// ---------------------------------------------------------------------------
Deno.test(
  "S4 HELD (operational foot-gun): a secret stored with a trailing newline rejects every sendable header with 401",
  async () => {
    const a = await loadAttackHarness();
    const original = Deno.env.get("REVENUECAT_WEBHOOK_AUTH") ?? "";
    try {
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", `${WEBHOOK_SECRET}\n`);
      const ip = freshIp();
      const candidates = [
        WEBHOOK_SECRET,
        `${WEBHOOK_SECRET} `,
        ` ${WEBHOOK_SECRET}`,
        `Bearer ${WEBHOOK_SECRET}`,
        WEBHOOK_SECRET.toUpperCase(),
        `${WEBHOOK_SECRET}\t`,
        // HTTP header values are whitespace-trimmed on the wire, so a sender
        // that copies the secret WITH the newline still transmits the bare value.
        `${WEBHOOK_SECRET}\n`,
        `${WEBHOOK_SECRET}\r\n`,
      ];
      for (const value of candidates) {
        const res = await a.h.handler(
          webhookRequest(event({ id: "s4" }), { ip, authorization: value }),
        );
        assertEquals(res.status, 401, `header ${JSON.stringify(value)} must be rejected`);
        assertEquals(await errorMessage(res), "Invalid webhook credentials.");
      }
      const trimmed = new Headers();
      trimmed.set("Authorization", `${WEBHOOK_SECRET}\n`);
      assertEquals(trimmed.get("Authorization"), WEBHOOK_SECRET, "Fetch strips the trailing LF");
      // …and an embedded newline is not a legal header value at all.
      assertThrows(() => new Headers().set("Authorization", `${WEBHOOK_SECRET}\nx`), TypeError);
      assertEquals(a.trace.length, 0, "401 short-circuits before any DB / RevenueCat traffic");

      // Empty secret fails closed (503), never open.
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "");
      const closed = await a.h.handler(webhookRequest(event({ id: "s4-empty" }), { ip }));
      assertEquals(closed.status, 503);

      // Sanity: the correctly stored secret accepts the same header.
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
      const ok = await a.h.handler(webhookRequest(event({ id: "s4-ok" }), { ip }));
      assertEquals(ok.status, 200);
    } finally {
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", original);
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 5 — GET webhook_events → 500, same id ×5 → fail-open: 5 RC calls, 5 upserts
// ---------------------------------------------------------------------------
Deno.test(
  "S5 REPRO: dedupe lookup failure fails OPEN — the same event id is fully re-processed 5 times",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      a.addFault({
        label: "webhook_events GET → 500",
        match: matchAuditLookup,
        respond: () => postgrestError(500, "XX000", "internal error"),
      });
      const ip = freshIp();
      const ev = event({ id: "evt-s5-degraded", type: "RENEWAL" });
      for (let i = 0; i < 5; i++) {
        const res = await a.h.handler(webhookRequest(ev, { ip }));
        assertEquals(res.status, 200);
        assertEquals(await readJson(res), { received: true, verified: true }, `delivery ${i + 1}`);
      }
      assertEquals(a.auditLookups().length, 5);
      assertEquals(a.rcCalls().length, 5, "fail-open: every replay re-verifies against RevenueCat");
      assertEquals(
        a.entitlementUpserts().length,
        5,
        "fail-open: every replay re-writes billing_entitlements",
      );
      assertEquals(
        a.auditUpserts().length,
        5,
        "the audit upsert (ignoreDuplicates) is attempted every time",
      );
      assertEquals(a.auditRows.size, 1, "…but only one audit row can exist for the id");
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "S5b REPRO: dedupe lookup 503 is retried by postgrest-js (1+2+4 s) before failing open — 7 s of the 60 s RevenueCat budget per delivery",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      a.addFault({
        label: "webhook_events GET → 503",
        match: matchAuditLookup,
        respond: () => postgrestError(503, "PGRST000", "connection pool exhausted"),
      });
      const started = performance.now();
      const res = await a.h.handler(webhookRequest(event({ id: "evt-s5b" }), { ip: freshIp() }));
      const elapsed = performance.now() - started;
      assertEquals(res.status, 200);
      assertEquals(await readJson(res), { received: true, verified: true });
      assertEquals(a.auditLookups().length, 4, "1 attempt + 3 retries");
      assert(elapsed >= 6_500, `expected ≥ 6.5 s of backoff, got ${elapsed.toFixed(0)} ms`);
      console.log(
        `S5b: lookup 503 → ${a.auditLookups().length} attempts, ${elapsed.toFixed(0)} ms wall`,
      );
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 6 — billing_entitlements POST → 500 on EXPIRATION, replay with DB healthy → duplicate (downgrade lost)
// ---------------------------------------------------------------------------
Deno.test(
  "S6 REPRO (defect): failed entitlement write still records the audit row → healthy replay is skipped as duplicate and the downgrade is lost",
  async () => {
    const a = await loadAttackHarness();
    try {
      // Premium user's row exists before the EXPIRATION arrives.
      a.entitlementRows.set(TEST_USER_ID, { user_id: TEST_USER_ID, premium: true });
      a.h.subscriber = expiredSubscriber();
      a.addFault({
        label: "billing_entitlements POST → 500 (once)",
        match: matchEntitlementUpsert,
        respond: () => postgrestError(500, "XX000", "could not write row"),
        times: 1,
      });
      const ip = freshIp();
      const ev = event({ id: "evt-s6-expiration", type: "EXPIRATION" });

      const first = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(first.status, 200);
      assertEquals(await readJson(first), { received: true, verified: false });
      assertEquals(a.rcCalls().length, 1);
      assertEquals(a.entitlementUpserts().length, 1);
      assertEquals(
        (a.entitlementRows.get(TEST_USER_ID) as Record<string, unknown>).premium,
        true,
        "downgrade NOT persisted",
      );
      assertEquals(
        a.auditUpserts().length,
        1,
        "audit row written although the verdict was not persisted",
      );
      assert(a.auditRows.has(ev.id));

      // RevenueCat got a 200 so it will never retry; a manual dashboard Retry
      // (or any replay) with the DB healthy is now short-circuited.
      a.clearFaults();
      const replay = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(replay.status, 200);
      assertEquals(await readJson(replay), { received: true, duplicate: true });
      assertEquals(a.rcCalls().length, 1, "no re-verification on replay");
      assertEquals(a.entitlementUpserts().length, 1, "no write on replay");
      assertEquals(
        (a.entitlementRows.get(TEST_USER_ID) as Record<string, unknown>).premium,
        true,
        "user stays premium after EXPIRATION",
      );
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 7 — webhook_events POST → 500 → 200 verified:true, id never recorded
// ---------------------------------------------------------------------------
Deno.test(
  "S7 REPRO: audit write failure is swallowed — 200 verified:true, id never recorded, replay re-processes silently",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      a.addFault({
        label: "webhook_events POST → 500",
        match: matchAuditUpsert,
        respond: () => postgrestError(500, "XX000", "disk full"),
      });
      const ip = freshIp();
      const ev = event({ id: "evt-s7-audit-gap" });
      const res = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(res.status, 200);
      assertEquals(await readJson(res), { received: true, verified: true });
      assertEquals(a.auditUpserts().length, 1, "write attempted");
      assertEquals(a.auditRows.size, 0, "…and lost");
      assertEquals(a.entitlementUpserts().length, 1, "entitlement WAS persisted (correct)");

      // Audit gap is invisible to RevenueCat and to the idempotency guard.
      a.clearFaults();
      const replay = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(await readJson(replay), { received: true, verified: true });
      assertEquals(a.rcCalls().length, 2, "replay re-verifies because the id was never recorded");
      assertEquals(a.entitlementUpserts().length, 2);
      assertEquals(a.auditRows.size, 1, "second attempt records the row");
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 8 — TRANSFER with 40 transferred_from UUIDs and a 9 s RC delay
// ---------------------------------------------------------------------------
const TRANSFER_SEED = 0x5eed_0004;
const TRANSFER_SUBJECTS = 40;

async function runWideTransfer(delayMs: number) {
  const a = await loadAttackHarness();
  try {
    a.h.subscriber = noEntitlements();
    const from = seededUuids(TRANSFER_SEED, TRANSFER_SUBJECTS);
    assertEquals(new Set(from).size, TRANSFER_SUBJECTS);
    a.addFault({ label: `RC delay ${delayMs} ms`, match: matchRc, delayMs });
    const started = performance.now();
    const res = await a.h.handler(
      webhookRequest(
        {
          id: `evt-s8-transfer-${delayMs}`,
          type: "TRANSFER",
          app_user_id: "$RCAnonymousID:transfer",
          transferred_from: from,
          transferred_to: [OTHER_USER_ID],
          event_timestamp_ms: 1_756_600_000_000,
        },
        { ip: freshIp() },
      ),
    );
    const wallMs = performance.now() - started;
    const rc = a.rcCalls();
    const upserts = a.entitlementUpserts();
    // Every RC call happened before the first entitlement write: no partial
    // persist while verification is still in flight.
    for (const c of rc)
      assertEquals(c.entitlementUpsertsBefore, 0, `RC call #${c.ordinal} after a persist`);
    const lastRc = rc[rc.length - 1];
    for (const u of upserts)
      assert(u.ordinal > lastRc.ordinal, "persist must follow the last RC lookup");
    // Sequential: each RC call starts only after the previous one answered.
    for (let i = 1; i < rc.length; i++) {
      assert(rc[i].startedAt - rc[i - 1].startedAt >= delayMs * 0.9, `RC calls overlap at #${i}`);
    }
    return { a, res, wallMs, rc, upserts, from };
  } catch (error) {
    a.restore();
    throw error;
  }
}

Deno.test(
  "S8 REPRO: 40-subject TRANSFER verifies subjects SERIALLY — at 9 s per RevenueCat lookup the request needs ~369 s, past the 60 s RevenueCat disconnect and the 150 s edge idle timeout",
  async () => {
    const delayMs = 100;
    const { a, res, wallMs, rc, upserts } = await runWideTransfer(delayMs);
    try {
      assertEquals(res.status, 200);
      assertEquals(await readJson(res), { received: true, verified: true });
      assertEquals(rc.length, TRANSFER_SUBJECTS + 1, "40 sources + 1 destination");
      assertEquals(upserts.length, TRANSFER_SUBJECTS + 1);
      assertEquals(a.auditUpserts().length, 1);
      assert(wallMs >= (TRANSFER_SUBJECTS + 1) * delayMs, `serial floor: ${wallMs.toFixed(0)} ms`);
      const perLookupMs = wallMs / rc.length;
      const projectedAt9s = rc.length * 9_000;
      console.log(
        `S8: ${rc.length} RC lookups, ${wallMs.toFixed(0)} ms wall at ${delayMs} ms stub delay ` +
          `(${perLookupMs.toFixed(1)} ms/lookup); projected at 9 s/lookup = ${projectedAt9s} ms ` +
          `vs RevenueCat disconnect ${RC_DISCONNECT_MS} ms, edge idle timeout ${EDGE_IDLE_TIMEOUT_MS} ms`,
      );
      assert(projectedAt9s > RC_DISCONNECT_MS, "RevenueCat gives up before the handler answers");
      assert(projectedAt9s > EDGE_IDLE_TIMEOUT_MS, "edge gateway 504s before the handler answers");
      // Smallest TRANSFER that can exceed RevenueCat's budget at the per-lookup cap.
      const subjectsToBlowBudget = Math.ceil(RC_DISCONNECT_MS / RC_LOOKUP_TIMEOUT_MS) + 1;
      console.log(
        `S8: ${subjectsToBlowBudget} slow subjects (${RC_LOOKUP_TIMEOUT_MS} ms each) already exceed the ${RC_DISCONNECT_MS} ms RevenueCat budget`,
      );
      assertEquals(subjectsToBlowBudget, 7);
    } finally {
      a.restore();
    }
  },
);

Deno.test({
  name: "S8-realtime: 40-subject TRANSFER with a real 9 s RevenueCat delay — measured wall time vs budgets (WEBHOOK_ATTACK_REALTIME=1)",
  ignore: !REALTIME,
  async fn() {
    const delayMs = 9_000;
    const { a, res, wallMs, rc, upserts } = await runWideTransfer(delayMs);
    try {
      assertEquals(res.status, 200);
      assertEquals(rc.length, TRANSFER_SUBJECTS + 1);
      assertEquals(upserts.length, TRANSFER_SUBJECTS + 1);
      const firstPersistAt = upserts[0].startedAt - rc[0].startedAt;
      console.log(
        JSON.stringify({
          scenario: "S8-realtime",
          seed: TRANSFER_SEED,
          subjects: TRANSFER_SUBJECTS,
          rcLookups: rc.length,
          rcDelayMs: delayMs,
          wallMs: Math.round(wallMs),
          firstPersistAfterMs: Math.round(firstPersistAt),
          rcDisconnectMs: RC_DISCONNECT_MS,
          edgeIdleTimeoutMs: EDGE_IDLE_TIMEOUT_MS,
          exceedsRcDisconnect: wallMs > RC_DISCONNECT_MS,
          exceedsEdgeIdleTimeout: wallMs > EDGE_IDLE_TIMEOUT_MS,
          persistedBeforeRcDisconnect: firstPersistAt < RC_DISCONNECT_MS,
        }),
      );
      assert(wallMs > EDGE_IDLE_TIMEOUT_MS);
      assert(firstPersistAt > RC_DISCONNECT_MS, "nothing persisted before RevenueCat disconnects");
    } finally {
      a.restore();
    }
  },
});

Deno.test(
  "S8b HELD: a RevenueCat lookup slower than 10 s aborts → 503, nothing persisted, nothing audited (RevenueCat will retry)",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      a.addFault({ label: "RC hang 12 s (aborted at 10 s)", match: matchRc, delayMs: 12_000 });
      const started = performance.now();
      const res = await a.h.handler(
        webhookRequest(event({ id: "evt-s8b-slow" }), { ip: freshIp() }),
      );
      const wallMs = performance.now() - started;
      assertEquals(res.status, 503);
      assertEquals(await errorMessage(res), "Verification is temporarily unavailable.");
      assert(wallMs >= 9_500 && wallMs < 11_500, `abort at 10 s, got ${wallMs.toFixed(0)} ms`);
      assertEquals(a.entitlementUpserts().length, 0);
      assertEquals(a.auditUpserts().length, 0);
      assertEquals(a.auditRows.size, 0, "id stays unrecorded so the retry is processed");
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 9 — TRANSFER A→B with B's upsert failing 409/23503 → A downgraded, B unwritten, 200 verified:false
// ---------------------------------------------------------------------------
Deno.test(
  "S9 REPRO: TRANSFER persists per subject with no rollback — A downgraded, B's 23503 swallowed as 200 verified:false, replay is a duplicate",
  async () => {
    const a = await loadAttackHarness();
    try {
      const A = TEST_USER_ID;
      const B = OTHER_USER_ID;
      a.entitlementRows.set(A, { user_id: A, premium: true });
      a.addFault({
        label: "RC A → no entitlements",
        match: matchRcFor(A),
        respond: () => rcSubscriber(noEntitlements()),
      });
      a.addFault({
        label: "RC B → premium",
        match: matchRcFor(B),
        respond: () => rcSubscriber(premiumSubscriber()),
      });
      a.addFault({
        label: "billing_entitlements(B) → 409/23503",
        match: matchEntitlementUpsertFor(B),
        respond: () =>
          postgrestError(
            409,
            "23503",
            'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
            `Key (user_id)=(${B}) is not present in table "profiles".`,
          ),
      });
      const ip = freshIp();
      const ev = {
        id: "evt-s9-transfer",
        type: "TRANSFER",
        app_user_id: "$RCAnonymousID:transfer",
        transferred_from: [A],
        transferred_to: [B],
        event_timestamp_ms: 1_756_600_000_000,
      };
      const res = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(res.status, 200);
      assertEquals(await readJson(res), { received: true, verified: false });
      assertEquals(
        a.rcCalls().map((c) => rcUserFromUrl(c.url)),
        [A, B],
      );
      const upserts = a.entitlementUpserts();
      assertEquals(upserts.length, 2);
      assertEquals(
        (a.entitlementRows.get(A) as Record<string, unknown>).premium,
        false,
        "A already downgraded",
      );
      assertEquals(a.entitlementRows.has(B), false, "B unwritten");
      assertEquals(a.auditUpserts().length, 1, "audit row written despite the partial persist");

      // The transfer can never be completed by RevenueCat: replay → duplicate.
      a.clearFaults();
      const replay = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(await readJson(replay), { received: true, duplicate: true });
      assertEquals(a.entitlementRows.has(B), false, "B still has no entitlement row");
    } finally {
      a.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Extras
// ---------------------------------------------------------------------------
Deno.test(
  "X1 REPRO: 5 concurrent deliveries of the same id all pass the check-then-act dedupe → 5 RC calls, 5 upserts",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      // All five dedupe lookups complete (no row yet) before any of the five
      // RevenueCat verifications returns — the classic check-then-act window.
      a.addFault({ label: "RC latency 50 ms", match: matchRc, delayMs: 50 });
      const ip = freshIp();
      const ev = event({ id: "evt-x1-concurrent" });
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => a.h.handler(webhookRequest(ev, { ip }))),
      );
      for (const res of responses) {
        assertEquals(res.status, 200);
        assertEquals(await readJson(res), { received: true, verified: true });
      }
      assertEquals(a.rcCalls().length, 5);
      assertEquals(a.entitlementUpserts().length, 5);
      assertEquals(a.auditRows.size, 1);
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X2 REPRO (defect): out-of-order RevenueCat answers → an older premium verdict overwrites a newer expired one (no verified_at guard)",
  async () => {
    const a = await loadAttackHarness();
    try {
      let rcOrdinal = 0;
      a.addFault({
        label: "RC: first lookup slow+premium, second fast+expired",
        match: matchRc,
        respond: () =>
          rcOrdinal++ === 0 ? rcSubscriber(premiumSubscriber()) : rcSubscriber(expiredSubscriber()),
      });
      a.addFault({
        label: "delay only the first RC lookup",
        match: matchRc,
        delayMs: 300,
        times: 1,
      });
      const ip = freshIp();
      const renewal = a.h.handler(
        webhookRequest(event({ id: "evt-x2-renewal", type: "RENEWAL" }), { ip }),
      );
      await new Promise((r) => setTimeout(r, 20));
      const expiration = a.h.handler(
        webhookRequest(event({ id: "evt-x2-expiration", type: "EXPIRATION" }), { ip }),
      );
      const [r1, r2] = await Promise.all([renewal, expiration]);
      assertEquals(await readJson(r1), { received: true, verified: true });
      assertEquals(await readJson(r2), { received: true, verified: true });
      const upserts = a.entitlementUpserts().map((c) => c.body as Record<string, unknown>);
      assertEquals(upserts.length, 2);
      assertEquals(upserts[0].premium, false, "EXPIRATION verdict lands first");
      assertEquals(upserts[1].premium, true, "stale RENEWAL verdict lands last");
      const stale = new Date(String(upserts[1].verified_at)).getTime();
      const fresh = new Date(String(upserts[0].verified_at)).getTime();
      assert(stale >= fresh, "the stale verdict even carries the newer verified_at");
      assertEquals(
        (a.entitlementRows.get(TEST_USER_ID) as Record<string, unknown>).premium,
        true,
        "final row: premium (wrong)",
      );
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X3 REPRO: empty-string event.id is a valid key → the second distinct event with id '' is dropped as a duplicate",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      const ip = freshIp();
      const first = await a.h.handler(
        webhookRequest(event({ id: "", type: "INITIAL_PURCHASE" }), { ip }),
      );
      assertEquals(await readJson(first), { received: true, verified: true });
      a.h.subscriber = expiredSubscriber();
      const second = await a.h.handler(
        webhookRequest(event({ id: "", type: "EXPIRATION", app_user_id: OTHER_USER_ID }), { ip }),
      );
      assertEquals(await readJson(second), { received: true, duplicate: true });
      assertEquals(a.rcCalls().length, 1, "OTHER_USER_ID's EXPIRATION never verified");
      assertEquals(a.entitlementRows.has(OTHER_USER_ID), false);
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X4 HELD: RevenueCat 5xx / network failure → 503 with nothing persisted and the id left unrecorded",
  async () => {
    const a = await loadAttackHarness();
    try {
      const ip = freshIp();
      a.h.subscriber = null; // stub answers 500
      const res = await a.h.handler(webhookRequest(event({ id: "evt-x4" }), { ip }));
      assertEquals(res.status, 503);
      assertEquals(a.entitlementUpserts().length, 0);
      assertEquals(a.auditUpserts().length, 0);

      a.addFault({
        label: "RC throws",
        match: matchRc,
        respond: () => {
          throw new TypeError("connection reset");
        },
      });
      const thrown = await a.h.handler(webhookRequest(event({ id: "evt-x4-throw" }), { ip }));
      assertEquals(thrown.status, 503);
      assertEquals(a.auditRows.size, 0);
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X5 HELD: TRANSFER where source and destination repeat the same UUID verifies it once; a case-variant spelling counts as another subject",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      const same = await a.h.handler(
        webhookRequest(
          {
            id: "evt-x5-same",
            type: "TRANSFER",
            transferred_from: [TEST_USER_ID],
            transferred_to: [TEST_USER_ID, TEST_USER_ID],
          },
          { ip: freshIp() },
        ),
      );
      assertEquals(await readJson(same), { received: true, verified: true });
      assertEquals(a.rcCalls().length, 1);
      assertEquals(a.entitlementUpserts().length, 1);

      // Case-variant UUID is a distinct string → second RC lookup and second
      // upsert (Postgres would collapse both writes onto one uuid row).
      const mixed = seededUuids(0xca5e, 1)[0];
      assertNotEquals(mixed, mixed.toUpperCase());
      const variant = await a.h.handler(
        webhookRequest(
          {
            id: "evt-x5-case",
            type: "TRANSFER",
            transferred_from: [mixed],
            transferred_to: [mixed.toUpperCase()],
          },
          { ip: freshIp() },
        ),
      );
      assertEquals(await readJson(variant), { received: true, verified: true });
      assertEquals(a.rcCalls().length, 3);
      assertEquals(
        a
          .rcCalls()
          .slice(1)
          .map((c) => rcUserFromUrl(c.url)),
        [mixed, mixed.toUpperCase()],
      );
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X6 HELD: unicode / oversized / hostile event ids never reach RevenueCat and are forwarded verbatim (URL-encoded) to PostgREST as the audit key",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      const ip = freshIp();
      const hostileIds = [
        "evt-\u0000-nul",
        "evt-😀-emoji",
        "evt-' or 1=1 --",
        "evt-" + "x".repeat(8_192),
        "evt-\u202e-rtl",
      ];
      for (const id of hostileIds) {
        const res = await a.h.handler(webhookRequest(event({ id }), { ip }));
        assertEquals(res.status, 200, `id ${JSON.stringify(id.slice(0, 20))}`);
        const lookup = a.auditLookups().at(-1)!;
        assertEquals(
          new URL(lookup.url).searchParams.get("id"),
          `eq.${id}`,
          "filter is URL-encoded, not interpolated",
        );
        assertEquals((a.auditUpserts().at(-1)!.body as Record<string, unknown>).id, id);
      }
      assertEquals(a.rcCalls().length, hostileIds.length);
      for (const c of a.rcCalls()) assertEquals(rcUserFromUrl(c.url), TEST_USER_ID);
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X9 REPRO: a \\u0000 anywhere in the payload makes the real jsonb audit column reject the row (22P05) — 200 verified:true, no audit trail, replay re-processes",
  async () => {
    // wf-webhook-events-attack-db.sql A1 proves postgres rejects \u0000 inside
    // jsonb with 22P05; PostgREST surfaces that as HTTP 400. This wires the
    // real error into the edge path: the entitlement is written, the audit
    // upsert fails, the handler still answers 200 verified:true.
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      a.addFault({
        label: "webhook_events POST with \\u0000 → 400 22P05",
        match: (call) => matchAuditUpsert(call) && JSON.stringify(call.body).includes("\\u0000"),
        respond: () =>
          postgrestError(
            400,
            "22P05",
            "unsupported Unicode escape sequence",
            "\\u0000 cannot be converted to text.",
          ),
      });
      const ip = freshIp();
      const ev = event({ id: "evt-x9-nul", presented_offering_id: "pro\u0000" });
      const first = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(first.status, 200);
      assertEquals(await readJson(first), { received: true, verified: true });
      assertEquals(a.entitlementUpserts().length, 1);
      assertEquals(a.auditUpserts().length, 1);
      assertEquals(a.auditRows.has("evt-x9-nul"), false, "audit row never lands");

      const replay = await a.h.handler(webhookRequest(ev, { ip }));
      assertEquals(
        await readJson(replay),
        { received: true, verified: true },
        "not detected as duplicate",
      );
      assertEquals(a.rcCalls().length, 2);
      assertEquals(a.entitlementUpserts().length, 2);
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X7 HELD: per-IP pre-auth limit (240/min) turns the 241st delivery into 429 — RevenueCat retries later",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = premiumSubscriber();
      const ip = "198.51.100.254";
      let first429 = -1;
      for (let i = 0; i < 241; i++) {
        const res = await a.h.handler(webhookRequest(event({ id: `evt-x7-${i}` }), { ip }));
        if (res.status === 429) {
          first429 = i + 1;
          assertExists(res.headers.get("Retry-After"));
          break;
        }
        assertEquals(res.status, 200);
      }
      assertEquals(first429, 241);
      assertEquals(a.rcCalls().length, 240);
    } finally {
      a.restore();
    }
  },
);

Deno.test(
  "X8 HELD: payload entitlement claims are ignored; only the first UUID alias is verified (documented subject rule)",
  async () => {
    const a = await loadAttackHarness();
    try {
      a.h.subscriber = noEntitlements();
      const third = seededUuids(7, 1)[0];
      const res = await a.h.handler(
        webhookRequest(
          event({
            id: "evt-x8",
            type: "INITIAL_PURCHASE",
            app_user_id: "$RCAnonymousID:abc",
            aliases: [TEST_USER_ID, OTHER_USER_ID, third],
            entitlement_ids: ["pickle_sensei_pro"],
            expiration_at_ms: 4_102_444_800_000,
          }),
          { ip: freshIp() },
        ),
      );
      assertEquals(await readJson(res), { received: true, verified: true });
      assertEquals(
        a.rcCalls().map((c) => rcUserFromUrl(c.url)),
        [TEST_USER_ID],
        "only the first alias is verified",
      );
      const row = a.entitlementRows.get(TEST_USER_ID) as Record<string, unknown>;
      assertEquals(row.premium, false, "body claim ignored; RevenueCat verdict wins");
      assertEquals(a.auditUpserts().length, 1);
      assert(
        !a.trace.some(
          (c) => c.url.startsWith(RC_URL) && c.url.includes(encodeURIComponent("$RCAnonymousID")),
        ),
      );
      assertNotEquals(a.entitlementRows.has(OTHER_USER_ID), true, "second alias never written");
    } finally {
      a.restore();
    }
  },
);
