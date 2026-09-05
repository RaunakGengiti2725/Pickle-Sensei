// STRESS · failure injection for GET /v1/me/saved-drills (Redis unconfigured —
// the per-isolate memory fallback; Upstash faults live in
// stress_saved_drills_redis.test.ts because cache.ts fixes the mode at import).
//
// Each case is its own Deno.test so a seed replays alone:
//   STRESS_SEED=20260904 deno test -A --no-check --config deno.json \
//     stress_saved_drills_faults.test.ts --filter "A06"
// The JSON seed → outcome table lands in artifacts/stress-saved-drills/latest/
// (STRESS_OUT_DIR overrides).
//
// Expected values are the CURRENT behaviour. `BROKEN` cases are findings (see
// `shouldBe`); they are pinned so that a fix surfaces as a test to update, the
// way the existing orphan-bookmark test pins its defect.

import { assert, assertEquals } from "@std/assert";
import {
  type CaseOutcome,
  type FaultCase,
  runFaultCase,
  summarize,
} from "./stress_saved_drills_cases.ts";
import {
  faults,
  LEAK_MARKER,
  loadStressHarness,
  STRESS_AUTH_TIMEOUT_MS,
  STRESS_HANG_MS,
  STRESS_SEED,
  withAuthTimeout,
  writeJson,
} from "./stress_saved_drills_harness.ts";

const FILE = "stress_saved_drills_faults.test.ts";
const AUTH_TIMEOUT_MS = STRESS_AUTH_TIMEOUT_MS;

const html = (status: number) =>
  faults.raw(
    status,
    `<html><body>${status} ${LEAK_MARKER}</body></html>`,
    "text/html",
  );
const gotrueUserBody = (overrides: Record<string, unknown>) => ({
  id: "33333333-3333-4333-8333-333333333333",
  aud: "authenticated",
  role: "authenticated",
  email: "x@example.com",
  app_metadata: { provider: "google", providers: ["google"] },
  ...overrides,
});

// ─── Supabase Auth · session bearer (the shipping contract) ──────────────────
const AUTH_SESSION: FaultCase[] = [
  {
    id: "A01 auth 500 json → 503 retryable",
    upstream: "auth",
    bearer: "session",
    fault: faults.status(500),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1, db: 0 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A02 auth 502 html gateway page → 503",
    upstream: "auth",
    bearer: "session",
    fault: html(502),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1, db: 0 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A03 auth 503 with Retry-After 7 → 503",
    upstream: "auth",
    bearer: "session",
    fault: faults.status(503, { message: LEAK_MARKER }, { "Retry-After": "7" }),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A04 auth 504 → 503",
    upstream: "auth",
    bearer: "session",
    fault: html(504),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A05 auth 429 rate limited → 503 (not a refusal)",
    upstream: "auth",
    bearer: "session",
    fault: faults.status(429, { message: LEAK_MARKER }, {
      "Retry-After": "30",
    }),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A06 auth connection refused (persistent) → connect retries then 503",
    upstream: "auth",
    bearer: "session",
    fault: faults.network(),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: { min: 2, max: 6 } },
      latencyMs: { max: AUTH_TIMEOUT_MS + 400 },
      recovery: "same_bearer",
      classification: "HELD",
    },
    note: "AUTH_CONNECT_RETRY_BACKOFF_MS re-sends inside the single deadline",
  },
  {
    id: "A07 auth stalls (honours abort) → 503 at the deadline",
    upstream: "auth",
    bearer: "session",
    fault: faults.hang(true),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      latencyMs: { min: AUTH_TIMEOUT_MS - 50, max: AUTH_TIMEOUT_MS + 400 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A08 auth stalls (ignores abort) → 503 at the deadline",
    upstream: "auth",
    bearer: "session",
    fault: faults.hang(false),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      latencyMs: { min: AUTH_TIMEOUT_MS - 50, max: AUTH_TIMEOUT_MS + 400 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A09 auth 200 empty object → 503 malformed",
    upstream: "auth",
    bearer: "session",
    fault: faults.replyWith({}),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1, db: 0 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A10 auth 200 truncated JSON → 503",
    upstream: "auth",
    bearer: "session",
    fault: faults.raw(200, `{"id":"${LEAK_MARKER}`, "application/json"),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A11 auth 200 empty body → 503",
    upstream: "auth",
    bearer: "session",
    fault: faults.raw(200, "", "application/json"),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A12 auth 200 user without provider metadata → 401",
    upstream: "auth",
    bearer: "session",
    fault: faults.replyWith(gotrueUserBody({ app_metadata: {} })),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1, db: 0 },
      recovery: "same_bearer",
      classification: "HELD",
    },
    note:
      "not a Google/Apple account → refused; the harness's healthy user then verifies",
  },
  {
    id: "A13 auth 200 user with numeric id → 503 malformed",
    upstream: "auth",
    bearer: "session",
    fault: faults.replyWith(gotrueUserBody({ id: 12345 })),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A14 auth 200 array body → 503 malformed",
    upstream: "auth",
    bearer: "session",
    fault: faults.replyWith([gotrueUserBody({})]),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A15 auth 401 bad_jwt → 401, fresh sign-in recovers",
    upstream: "auth",
    bearer: "session",
    fault: faults.status(401, {
      code: 401,
      error_code: "bad_jwt",
      msg: LEAK_MARKER,
    }),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1, db: 0 },
      recovery: "new_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A16 auth 403 → 401",
    upstream: "auth",
    bearer: "session",
    fault: faults.status(403, { message: LEAK_MARKER }),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1 },
      recovery: "new_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A17 auth 400 → 401",
    upstream: "auth",
    bearer: "session",
    fault: html(400),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1 },
      recovery: "new_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A18 auth one connection error then healthy → 200 within the request",
    upstream: "auth",
    bearer: "session",
    fault: faults.sequence(faults.network()),
    expect: {
      status: 200,
      calls: { auth: 2, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id:
      "A19 auth one 500 then healthy → 503 (first HTTP answer is final), next request 200",
    upstream: "auth",
    bearer: "session",
    fault: faults.sequence(faults.status(500)),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A20 auth slow 300ms → 200",
    upstream: "auth",
    bearer: "session",
    fault: faults.delay(300),
    expect: {
      status: 200,
      calls: { auth: 1, db: 1 },
      latencyMs: { min: 290 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "A21 auth slower than the deadline → 503, late answer discarded",
    upstream: "auth",
    bearer: "session",
    fault: faults.delay(AUTH_TIMEOUT_MS + 300),
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1 },
      latencyMs: { min: AUTH_TIMEOUT_MS - 50, max: AUTH_TIMEOUT_MS + 400 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "A22 auth 200 with 1 MB of padding → 200",
    upstream: "auth",
    bearer: "session",
    fault: (ctx) =>
      ctx.normal().then(async (healthy) => {
        const user = (await healthy.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            ...user,
            user_metadata: { pad: "x".repeat(1_000_000) },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    expect: {
      status: 200,
      calls: { auth: 1, db: 1 },
      latencyMs: { max: 500 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "A23 warm cache shields a full Auth outage → 200, 0 auth calls",
    upstream: "auth",
    bearer: "session",
    warm: true,
    fault: faults.network(),
    expect: {
      status: 200,
      calls: { auth: 0, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "A24 warm cache + Auth now says 401 → still 200 for the cache window",
    upstream: "auth",
    bearer: "session",
    warm: true,
    fault: faults.status(401, { msg: LEAK_MARKER }),
    expect: {
      status: 200,
      calls: { auth: 0, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
    note:
      "documented: verified sessions are cached ≤10 min; logout revokes explicitly",
  },
];

// ─── Supabase Auth · transitional provider ID-token bearer ───────────────────
const AUTH_PROVIDER: FaultCase[] = [
  {
    id: "P01 provider bearer healthy → 200 (1 auth + 1 db)",
    upstream: "auth",
    bearer: "provider",
    expect: {
      status: 200,
      calls: { auth: 1, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "P02 provider bearer + auth 500 → 401 (outage reported as refusal)",
    upstream: "auth",
    bearer: "provider",
    fault: faults.status(500),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1, db: 0 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "503 + Retry-After (retryable) — Auth being down is not a credential refusal",
    },
  },
  {
    id: "P03 provider bearer + auth connection refused → 401",
    upstream: "auth",
    bearer: "provider",
    fault: faults.network(),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "503 + Retry-After; no connect retry either (session path retries)",
    },
  },
  {
    id: "P04 provider bearer + auth stalls → no deadline, request hangs",
    upstream: "auth",
    bearer: "provider",
    fault: faults.hang(true),
    expect: {
      status: "no_response",
      eventualStatus: 401,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        `503 within AUTH_UPSTREAM_TIMEOUT_MS like the session path (waited ${STRESS_HANG_MS} ms)`,
    },
  },
  {
    id: "P05 provider bearer + auth 200 garbage → 401",
    upstream: "auth",
    bearer: "provider",
    fault: faults.raw(200, "{not json", "application/json"),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "503 retryable (malformed upstream body is not a credential refusal)",
    },
  },
  {
    id: "P06 provider bearer + auth 400 invalid_grant → 401 (true refusal)",
    upstream: "auth",
    bearer: "provider",
    fault: faults.status(400, {
      error: "invalid_grant",
      error_description: LEAK_MARKER,
    }),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "P07 provider bearer + session body without user → 401",
    upstream: "auth",
    bearer: "provider",
    fault: faults.replyWith({
      access_token: "x",
      token_type: "bearer",
      expires_in: 3600,
    }),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
];

// ─── PostgREST (auth cache warm, so only the DB round trip is in play) ───────
const DB: FaultCase[] = [
  {
    id: "D01 db 500 → 503 generic",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.status(500, {
      code: "XX000",
      message: LEAK_MARKER,
      details: LEAK_MARKER,
      hint: LEAK_MARKER,
    }),
    expect: {
      status: 503,
      calls: { auth: 0, db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D02 db 502 html → 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: html(502),
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D03 db 503 Retry-After 0 (persistent) → 4 attempts then 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.status(503, { message: LEAK_MARKER }, { "Retry-After": "0" }),
    expect: {
      status: 503,
      calls: { db: 4 },
      recovery: "same_bearer",
      classification: "HELD",
    },
    note:
      "postgrest-js 2.112.4 retries GET on 503/520 (3 retries, Retry-After honoured)",
  },
  {
    id: "D04 db one 520 then healthy → 200 after ~1 s backoff",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.sequence(html(520)),
    expect: {
      status: 200,
      calls: { db: 2 },
      latencyMs: { min: 950 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id:
      "D05 db connection refused (persistent) → 503 only after ~7 s of retries",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.network(),
    expect: {
      status: "no_response",
      eventualStatus: 503,
      eventualWaitMs: 9000,
      calls: { db: { min: 2, max: 4 } },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        `a 503 within ~1 s; postgrest-js re-sends 3× with 1 s + 2 s + 4 s backoff (4 connection attempts, ~7 s) before the client sees anything (deadline ${STRESS_HANG_MS} ms)`,
    },
  },
  {
    id: "D06 db one connection error then healthy → 200 after ~1 s",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.sequence(faults.network()),
    expect: {
      status: 200,
      calls: { db: 2 },
      latencyMs: { min: 950 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "D07 db stalls → no deadline, request hangs",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.hang(false),
    expect: {
      status: "no_response",
      eventualStatus: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        `503 within a bounded time; the PostgREST call carries no AbortSignal (waited ${STRESS_HANG_MS} ms)`,
    },
  },
  {
    id: "D08 db 401 PGRST301 (JWT expired at PostgREST) → 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.status(401, { code: "PGRST301", message: LEAK_MARKER }),
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D09 db 403 42501 permission denied → 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.status(403, { code: "42501", message: LEAK_MARKER }),
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D10 db 404 PGRST205 table missing → 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.status(404, { code: "PGRST205", message: LEAK_MARKER }),
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D11 db 429 → 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.status(429, { message: LEAK_MARKER }),
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D12 db 200 object instead of rows → 500 (unhandled TypeError)",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.replyWith({ message: LEAK_MARKER }),
    expect: {
      status: 500,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "503 (malformed PostgREST body handled like any other DB fault)",
    },
  },
  {
    id: "D13 db 200 null → 200 empty list",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: (ctx) =>
      ctx.normal().then(() =>
        new Response("null", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "n/a",
      classification: "HELD",
      items: (items) => assertEquals(items, []),
    },
  },
  {
    id: "D14 db 200 truncated JSON → 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.raw(200, `[{"slug":"${LEAK_MARKER}`, "application/json"),
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id:
      "D15 db 200 rows without slug → 200 with placeholder drills titled 'undefined'",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.replyWith([{ saved_at: "2026-01-01T00:00:00+00:00" }, {
      foo: 1,
    }]),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "rows without a string slug dropped (or 503); never a drill named 'undefined'",
      items: (items) =>
        assertEquals(items.map((i) => [i.slug, i.title]), [[
          "undefined",
          "undefined",
        ], ["undefined", "undefined"]]),
    },
  },
  {
    id: "D16 db 200 rows with null saved_at → 200 with saved_at 'null'",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.replyWith([{ slug: "wall-dink-rally", saved_at: null }]),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "a null timestamp must not be stringified to the literal 'null'",
      items: (items) => assertEquals(items.map((i) => i.saved_at), ["null"]),
    },
  },
  {
    id: "D17 db 200 text/plain → 503",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.raw(200, LEAK_MARKER, "text/plain"),
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D18 db slow 300ms → 200",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.delay(300),
    expect: {
      status: 200,
      calls: { db: 1 },
      latencyMs: { min: 290 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "D19 db 200 with 5 000 rows → 200, bounded latency",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: () => {
      const rows = Array.from({ length: 5000 }, (_, i) => ({
        slug: i % 2 === 0 ? "wall-dink-rally" : `orphan-${i}`,
        saved_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()
          .replace("Z", "+00:00"),
      }));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    expect: {
      status: 200,
      calls: { db: 1 },
      latencyMs: { max: 2000 },
      recovery: "n/a",
      classification: "HELD",
      items: (items) => {
        assertEquals(items.length, 5000);
        assertEquals(items[4999].slug, "orphan-4999");
      },
    },
    note:
      "5 000 is far above anything a user can save; proves hydration is linear",
  },
  {
    id:
      "D20 db 200 slug with markup → returned as JSON string, no interpretation",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.replyWith([{
      slug: "<script>alert(1)</script>",
      saved_at: "2026-01-01T00:00:00+00:00",
    }]),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "a slug outside user_saved_drills_slug_bounds should not be echoed as a drill title (the DB constraint makes it unreachable today, so P3)",
      items: (items) =>
        assertEquals(items.map((i) => i.title), ["<script>alert(1)</script>"]),
    },
  },
  {
    id: "D21 db + auth both down, warm cache → 503 from the DB step",
    upstream: "db",
    bearer: "session",
    warm: true,
    fault: faults.status(500),
    also: { auth: faults.network() },
    expect: {
      status: 503,
      calls: { auth: 0, db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "D22 db + auth both down, cold cache → 503 from Auth, DB never called",
    upstream: "auth",
    bearer: "session",
    fault: faults.status(500),
    also: { db: faults.status(500) },
    expect: {
      status: 503,
      retryAfter: true,
      calls: { auth: 1, db: 0 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
];

// ─── RevenueCat: never on this route ─────────────────────────────────────────
const REVENUECAT: FaultCase[] = [
  {
    id: "V01 revenuecat 500 → route unaffected, 0 calls",
    upstream: "revenuecat",
    bearer: "session",
    fault: faults.status(500),
    expect: {
      status: 200,
      calls: { revenuecat: 0, auth: 1, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "V02 revenuecat stalls → route unaffected",
    upstream: "revenuecat",
    bearer: "session",
    fault: faults.hang(false),
    expect: {
      status: 200,
      calls: { revenuecat: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "V03 revenuecat connection refused → route unaffected",
    upstream: "revenuecat",
    bearer: "session",
    fault: faults.network(),
    expect: {
      status: 200,
      calls: { revenuecat: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "V04 revenuecat garbage → route unaffected",
    upstream: "revenuecat",
    bearer: "session",
    fault: faults.raw(200, "{{{", "application/json"),
    expect: {
      status: 200,
      calls: { revenuecat: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
];

// ─── Request-side faults (no upstream reached) ───────────────────────────────
const REQUEST: FaultCase[] = [
  {
    id: "C01 no Authorization → 401, no upstream call",
    upstream: "none",
    bearer: "none",
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 0, db: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "C02 garbage bearer → 401, no upstream call",
    upstream: "none",
    bearer: "garbage",
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 0, db: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "C03 expired session bearer → 401 before any upstream",
    upstream: "none",
    bearer: "expired",
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 0, db: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "C04 expired bearer while every upstream is down → still a clean 401",
    upstream: "none",
    bearer: "expired",
    also: {
      auth: faults.network(),
      db: faults.network(),
      revenuecat: faults.network(),
    },
    expect: {
      status: 401,
      retryAfter: false,
      calls: { auth: 0, db: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
];

export const CASES: FaultCase[] = [
  ...AUTH_SESSION,
  ...AUTH_PROVIDER,
  ...DB,
  ...REVENUECAT,
  ...REQUEST,
];

const outcomes: CaseOutcome[] = [];

for (const c of CASES) {
  Deno.test(`stress saved-drills fault ${c.id}`, async () => {
    const state = await loadStressHarness();
    outcomes.push(
      await withAuthTimeout(() => runFaultCase(state, c, FILE)),
    );
  });
}

Deno.test("stress saved-drills fault table → JSON (no Redis)", async () => {
  const ids = new Set(CASES.map((c) => c.id));
  assertEquals(ids.size, CASES.length, "case ids are unique");
  assert(
    CASES.length >= 40,
    `≥40 fault cases in this module alone (have ${CASES.length})`,
  );
  const path = await writeJson("faults_no_redis.json", {
    route: "GET /v1/me/saved-drills",
    redis: false,
    seed: STRESS_SEED,
    authUpstreamTimeoutMs: AUTH_TIMEOUT_MS,
    hangDeadlineMs: STRESS_HANG_MS,
    summary: summarize(outcomes),
    cases: outcomes,
  });
  console.log(
    `[stress] wrote ${path}: ${outcomes.length}/${CASES.length} cases ran`,
  );
  // The table must reflect what actually ran in this process (a --filter run
  // writes a partial table on purpose).
  for (const o of outcomes) assert(o.passed, o.id);
});
