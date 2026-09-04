/**
 * stress — POST /v1/me/delete-request — FAILURE INJECTION + LOAD (memory-only
 * mode: no Upstash configured, so cache.ts / rateLimit.ts run their
 * per-isolate L1 paths; the Redis-configured twin is
 * stress_delete_request_redis.test.ts).
 *
 * Runs the REAL handler in-process over the fake upstreams of
 * stress_delete_request_harness.ts and asserts, for every injected fault, the
 * status + Retry-After the route answers, the class the mobile client
 * (apps/mobile/src/account/deletion.ts) derives from it, how many upstream
 * round trips were spent, and that the same user recovers on the next
 * healthy request.
 *
 *   cd supabase/functions/api/__wf__ && deno task test          # fast defaults
 *   STRESS_ITER=1000 STRESS_USERS=20000 STRESS_SLOW=1 STRESS_OUT_DIR=/tmp/stress \
 *     deno test -A --no-check --config deno.json stress_delete_request_failure_load.test.ts
 *
 * Knobs: STRESS_SEED (base seed), STRESS_ITER (random fault iterations and
 * concurrency seeds), STRESS_LOAD_N (load requests, default 1000),
 * STRESS_USERS (distinct users for the L1 memory campaign, default 2000),
 * STRESS_SLOW=1 (enables the cases that must wait out postgrest-js' own
 * 1+2+4 s GET retry ladder), STRESS_OUT_DIR (JSON tables).
 */
import { assert, assertEquals } from "@std/assert";
import {
  type ClientClass,
  drive,
  envInt,
  type Fault,
  freshIp,
  googleIdToken,
  type Harness,
  latencyStats,
  loadStressHarness,
  type Outcome,
  Prng,
  STRESS_ITER,
  STRESS_SEED,
  type Target,
  VALID_SURVEY,
  writeReport,
} from "./stress_delete_request_harness.ts";

const SLOW = Deno.env.get("STRESS_SLOW") === "1";
const LOAD_N = envInt("STRESS_LOAD_N", 1000);
const USERS_N = envInt("STRESS_USERS", 2000);

const h: Harness = await loadStressHarness();

let userCounter = 0;
function newUser(h: Harness, extra: Partial<Parameters<Harness["registerUser"]>[0]> = {}) {
  userCounter += 1;
  const id = `aaaaaaaa-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
  const user = h.registerUser({ id, ...extra });
  const token = h.mintSession(id);
  return { user, token, ip: freshIp() };
}

const pgError = (status: number, code: string, message: string): Fault => ({
  kind: "http",
  status,
  body: JSON.stringify({ code, message, details: null, hint: null }),
});

interface FaultCase {
  id: string;
  title: string;
  survey?: unknown;
  /** Applied before the request; may queue faults / set latency. */
  arrange: (h: Harness) => void;
  /** Warm the auth cache with a healthy request first (so the fault lands on
   * a cache HIT path, i.e. no auth round trip). Costs one budget hit. */
  warmAuth?: boolean;
  expect: {
    status: number;
    client: ClientClass;
    retryAfter?: "present" | "absent";
    calls?: Partial<Record<Target, number>>;
    maxLatencyMs?: number;
    minLatencyMs?: number;
    feedbackRows?: number;
    challengeStored?: boolean;
    check?: (o: Outcome, h: Harness) => string | null;
  };
  /** Expected status of the follow-up healthy request by the same user. */
  recover?: number;
  slow?: boolean;
}

const AUTH_UNAVAILABLE = {
  status: 503,
  client: "rejected_retryable" as const,
  retryAfter: "present" as const,
  calls: { "rest.deletion_upsert": 0 } as Partial<Record<Target, number>>,
};
const AUTH_REFUSED = {
  status: 401,
  client: "session_expired" as const,
  calls: { "rest.deletion_upsert": 0 } as Partial<Record<Target, number>>,
};
const UPSERT_FAILED = {
  status: 503,
  client: "rejected_retryable" as const,
  retryAfter: "absent" as const,
  calls: { "rest.deletion_upsert": 1, "rest.feedback_insert": 0 } as Partial<
    Record<Target, number>
  >,
  challengeStored: false,
};
const OK = { status: 200, client: "challenge" as const, challengeStored: true };

const FAULT_CASES: FaultCase[] = [
  // ── Supabase Auth (GoTrue) — GET /auth/v1/user on a cache miss ─────────────
  {
    id: "A01",
    title: "auth 500",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 500, body: "{}" }),
    expect: AUTH_UNAVAILABLE,
  },
  {
    id: "A02",
    title: "auth 502 html gateway page",
    arrange: (h) =>
      h.inject("auth.user", { kind: "http", status: 502, body: "<html>bad gateway</html>" }),
    expect: AUTH_UNAVAILABLE,
  },
  {
    id: "A03",
    title: "auth 429 with Retry-After 7 is propagated",
    arrange: (h) =>
      h.inject("auth.user", {
        kind: "http",
        status: 429,
        body: "{}",
        headers: { "Retry-After": "7" },
      }),
    expect: {
      ...AUTH_UNAVAILABLE,
      check: (o) => (o.retryAfter === "7" ? null : `Retry-After ${o.retryAfter} != 7`),
    },
  },
  {
    id: "A04",
    title: "auth 503 with garbage Retry-After falls back to 2",
    arrange: (h) =>
      h.inject("auth.user", {
        kind: "http",
        status: 503,
        body: "{}",
        headers: { "Retry-After": "soon" },
      }),
    expect: {
      ...AUTH_UNAVAILABLE,
      check: (o) => (o.retryAfter === "2" ? null : `Retry-After ${o.retryAfter} != 2`),
    },
  },
  {
    id: "A05",
    title: "auth socket failure on every attempt (retry ladder inside the deadline)",
    arrange: (h) => {
      Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "1500");
      h.injectSticky("auth.user", { kind: "throw" });
    },
    expect: {
      ...AUTH_UNAVAILABLE,
      minLatencyMs: 600,
      maxLatencyMs: 3000,
      check: (o) =>
        (o.calls["auth.user"] ?? 0) >= 2
          ? null
          : `expected ≥2 auth attempts, got ${o.calls["auth.user"]}`,
    },
  },
  {
    id: "A06",
    title: "auth socket failure once, then healthy — transparent retry",
    arrange: (h) => h.inject("auth.user", { kind: "throw" }),
    expect: { ...OK, calls: { "auth.user": 2, "rest.deletion_upsert": 1 } },
  },
  {
    id: "A07",
    title: "auth hangs past the 6 s deadline (default AUTH_UPSTREAM_TIMEOUT_MS)",
    arrange: (h) => h.injectSticky("auth.user", { kind: "hang" }),
    expect: { ...AUTH_UNAVAILABLE, minLatencyMs: 5900, maxLatencyMs: 8000 },
    slow: true,
  },
  {
    id: "A08",
    title: "auth hangs past a 1.5 s deadline",
    arrange: (h) => {
      Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "1500");
      h.injectSticky("auth.user", { kind: "hang" });
    },
    expect: { ...AUTH_UNAVAILABLE, minLatencyMs: 1400, maxLatencyMs: 3000 },
  },
  {
    id: "A09",
    title: "auth 200 with non-JSON body",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 200, body: "<html>ok</html>" }),
    expect: AUTH_UNAVAILABLE,
  },
  {
    id: "A10",
    title: "auth 200 with JSON lacking id",
    arrange: (h) =>
      h.inject("auth.user", { kind: "http", status: 200, body: JSON.stringify({ email: "x@y" }) }),
    expect: AUTH_UNAVAILABLE,
  },
  {
    id: "A11",
    title: "auth 200 with an array body",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 200, body: "[]" }),
    expect: AUTH_UNAVAILABLE,
  },
  {
    id: "A12",
    title: "auth 200 with null body",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 200, body: "null" }),
    expect: AUTH_UNAVAILABLE,
  },
  {
    id: "A13",
    title: "auth 200 for an email-provider user (not Google/Apple)",
    arrange: (h) =>
      h.inject("auth.user", {
        kind: "http",
        status: 200,
        body: JSON.stringify({
          id: "99999999-9999-4999-8999-999999999999",
          app_metadata: { provider: "email", providers: ["email"] },
        }),
      }),
    expect: { status: 401, client: "session_expired", calls: { "rest.deletion_upsert": 0 } },
  },
  {
    id: "A14",
    title: "auth 401 (session revoked upstream)",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 401, body: "{}" }),
    expect: AUTH_REFUSED,
  },
  {
    id: "A15",
    title: "auth 403 (user banned)",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 403, body: "{}" }),
    expect: AUTH_REFUSED,
  },
  {
    id: "A16",
    title: "auth 400 (bad jwt)",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 400, body: "not json" }),
    expect: AUTH_REFUSED,
  },
  {
    id: "A17",
    title: "auth 5xx then healthy on the next request (no poisoned cache)",
    arrange: (h) => h.inject("auth.user", { kind: "http", status: 500, body: "{}" }),
    expect: AUTH_UNAVAILABLE,
    recover: 200,
  },
  {
    id: "A18",
    title: "legacy provider id_token bearer: token grant 500 folds to 401",
    arrange: (h) => h.inject("auth.token", { kind: "http", status: 500, body: "{}" }),
    expect: { status: 401, client: "session_expired", calls: { "rest.deletion_upsert": 0 } },
    recover: 200,
  },
  {
    id: "A19",
    title: "legacy provider id_token bearer: token grant 200 with garbage body",
    arrange: (h) => h.inject("auth.token", { kind: "http", status: 200, body: "<html>" }),
    expect: { status: 401, client: "session_expired", calls: { "rest.deletion_upsert": 0 } },
    recover: 200,
  },

  // ── PostgREST — the deletion-challenge upsert ──────────────────────────────
  {
    id: "D01",
    title: "upsert 500",
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(500, "XX000", "internal error")),
    expect: UPSERT_FAILED,
  },
  {
    id: "D02",
    title: "upsert 503 (pool exhausted) — POST is not retried by postgrest-js",
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(503, "PGRST001", "no connection")),
    expect: { ...UPSERT_FAILED, maxLatencyMs: 500 },
  },
  {
    id: "D03",
    title: "upsert 401 PGRST301 (JWT expired mid-cache) surfaces as retryable 503, not sign-in",
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(401, "PGRST301", "JWT expired")),
    expect: UPSERT_FAILED,
  },
  {
    id: "D04",
    title: "upsert 403 42501 (grant/RLS refusal)",
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(403, "42501", "permission denied")),
    expect: UPSERT_FAILED,
  },
  {
    id: "D05",
    title: "upsert 409 23505 (unique violation)",
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(409, "23505", "duplicate key")),
    expect: UPSERT_FAILED,
  },
  {
    id: "D06",
    title: "upsert 400 PGRST102 (malformed request)",
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(400, "PGRST102", "bad request")),
    expect: UPSERT_FAILED,
  },
  {
    id: "D07",
    title: "upsert 429 from PostgREST",
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(429, "PGRST429", "slow down")),
    expect: UPSERT_FAILED,
  },
  {
    id: "D08",
    title: "upsert socket failure — exactly one attempt",
    arrange: (h) => h.inject("rest.deletion_upsert", { kind: "throw" }),
    expect: UPSERT_FAILED,
  },
  {
    id: "D09",
    title: "upsert 200 with non-JSON body",
    arrange: (h) =>
      h.inject("rest.deletion_upsert", { kind: "http", status: 200, body: "<html>gateway</html>" }),
    expect: { ...UPSERT_FAILED, challengeStored: undefined },
  },
  {
    id: "D10",
    title: "upsert 200 with an empty JSON array body (accepted)",
    arrange: (h) => h.inject("rest.deletion_upsert", { kind: "http", status: 200, body: "[]" }),
    expect: { status: 200, client: "challenge" },
  },
  {
    id: "D11",
    title: "upsert 5xx on a cache-HIT path (no auth round trip)",
    warmAuth: true,
    arrange: (h) => h.inject("rest.deletion_upsert", pgError(500, "XX000", "internal error")),
    expect: { ...UPSERT_FAILED, calls: { ...UPSERT_FAILED.calls, "auth.user": 0 } },
  },
  {
    id: "D12",
    title: "upsert slow (400 ms) — answered, no deadline hit",
    arrange: (h) => h.inject("rest.deletion_upsert", { kind: "delay", ms: 400 }),
    expect: { ...OK, minLatencyMs: 390 },
  },

  // ── PostgREST — exit-survey context and insert (best effort) ──────────────
  {
    id: "S01",
    title: "access_state RPC 500 → survey still recorded with null churn context",
    survey: VALID_SURVEY,
    arrange: (h) => h.inject("rest.access_state", pgError(500, "XX000", "boom")),
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) => (h.feedback[0]?.was_premium === null ? null : "was_premium should be null"),
    },
  },
  {
    id: "S02",
    title: "profiles GET 500 (not retried) → account_age_days null",
    survey: VALID_SURVEY,
    arrange: (h) => h.inject("rest.profiles", pgError(500, "XX000", "boom")),
    expect: {
      ...OK,
      feedbackRows: 1,
      calls: { "rest.profiles": 1 },
      check: (_o, h) =>
        h.feedback[0]?.account_age_days === null ? null : "account_age_days should be null",
    },
  },
  {
    id: "S03",
    title: "profiles GET 503 → postgrest-js retries 1+2+4 s before the 200 is answered",
    survey: VALID_SURVEY,
    arrange: (h) => h.injectSticky("rest.profiles", pgError(503, "PGRST001", "no connection")),
    expect: { ...OK, feedbackRows: 1, calls: { "rest.profiles": 4 }, minLatencyMs: 6900 },
    slow: true,
  },
  {
    id: "S04",
    title: "profiles GET socket failure → postgrest-js retries 1+2+4 s before the 200 is answered",
    survey: VALID_SURVEY,
    arrange: (h) => h.injectSticky("rest.profiles", { kind: "throw" }),
    expect: { ...OK, feedbackRows: 1, calls: { "rest.profiles": 4 }, minLatencyMs: 6900 },
    slow: true,
  },
  {
    id: "S05",
    title: "access_state socket failure → not retried (POST)",
    survey: VALID_SURVEY,
    arrange: (h) => h.injectSticky("rest.access_state", { kind: "throw" }),
    expect: { ...OK, feedbackRows: 1, calls: { "rest.access_state": 1 }, maxLatencyMs: 500 },
  },
  {
    id: "S06",
    title: "feedback insert 500 → swallowed",
    survey: VALID_SURVEY,
    arrange: (h) => h.inject("rest.feedback_insert", pgError(500, "XX000", "boom")),
    expect: { ...OK, feedbackRows: 0, calls: { "rest.feedback_insert": 1 } },
  },
  {
    id: "S07",
    title: "feedback insert 403 42501 (RLS) → swallowed",
    survey: VALID_SURVEY,
    arrange: (h) => h.inject("rest.feedback_insert", pgError(403, "42501", "rls")),
    expect: { ...OK, feedbackRows: 0 },
  },
  {
    id: "S08",
    title: "feedback insert 503 → not retried (POST), swallowed",
    survey: VALID_SURVEY,
    arrange: (h) => h.injectSticky("rest.feedback_insert", pgError(503, "PGRST001", "pool")),
    expect: { ...OK, feedbackRows: 0, calls: { "rest.feedback_insert": 1 }, maxLatencyMs: 500 },
  },
  {
    id: "S09",
    title: "feedback insert socket failure → swallowed",
    survey: VALID_SURVEY,
    arrange: (h) => h.inject("rest.feedback_insert", { kind: "throw" }),
    expect: { ...OK, feedbackRows: 0 },
  },
  {
    id: "S10",
    title: "access_state 200 with an object instead of a row array",
    survey: VALID_SURVEY,
    arrange: (h) =>
      h.inject("rest.access_state", {
        kind: "http",
        status: 200,
        body: JSON.stringify({ premium: true, scored_count: 3 }),
      }),
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) =>
        h.feedback[0]?.was_premium === null && h.feedback[0]?.scored_count === null
          ? null
          : "malformed access_state must stamp null churn context",
    },
  },
  {
    id: "S11",
    title: "access_state 200 with a non-JSON body",
    survey: VALID_SURVEY,
    arrange: (h) => h.inject("rest.access_state", { kind: "http", status: 200, body: "garbage" }),
    expect: { ...OK, feedbackRows: 1 },
  },
  {
    id: "S12",
    title: "access_state 200 with a string row array",
    survey: VALID_SURVEY,
    arrange: (h) =>
      h.inject("rest.access_state", { kind: "http", status: 200, body: JSON.stringify(["x"]) }),
    expect: { ...OK, feedbackRows: 1 },
  },
  {
    id: "S13",
    title: "access_state 200 with wrong-typed fields",
    survey: VALID_SURVEY,
    arrange: (h) =>
      h.inject("rest.access_state", {
        kind: "http",
        status: 200,
        body: JSON.stringify([{ premium: "yes", scored_count: "7" }]),
      }),
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) =>
        h.feedback[0]?.scored_count === null ? null : "string scored_count must not be stamped",
    },
  },
  {
    id: "S14",
    title: "profiles 200 with an unparseable created_at",
    survey: VALID_SURVEY,
    arrange: (h) =>
      h.inject("rest.profiles", {
        kind: "http",
        status: 200,
        body: JSON.stringify({ created_at: "not-a-date" }),
      }),
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) => (h.feedback[0]?.account_age_days === null ? null : "age must be null"),
    },
  },
  {
    id: "S15",
    title: "profiles 200 with created_at in the future → age clamps to 0",
    survey: VALID_SURVEY,
    arrange: (h) =>
      h.inject("rest.profiles", {
        kind: "http",
        status: 200,
        body: JSON.stringify({ created_at: "2999-01-01T00:00:00Z" }),
      }),
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) => (h.feedback[0]?.account_age_days === 0 ? null : "age must clamp to 0"),
    },
  },
  {
    id: "S16",
    title: "profiles 406 PGRST116 (0 rows)",
    survey: VALID_SURVEY,
    arrange: (h) => h.inject("rest.profiles", pgError(406, "PGRST116", "0 rows")),
    expect: { ...OK, feedbackRows: 1 },
  },
  {
    id: "S17",
    title: "profiles 200 with an array body where an object was requested (2 rows)",
    survey: VALID_SURVEY,
    arrange: (h) =>
      h.inject("rest.profiles", {
        kind: "http",
        status: 200,
        body: JSON.stringify([{ created_at: "2026-01-01T00:00:00Z" }, { created_at: "x" }]),
      }),
    expect: { ...OK, feedbackRows: 1 },
  },
  {
    id: "S18",
    title: "all three survey upstreams 500 at once",
    survey: VALID_SURVEY,
    arrange: (h) => {
      h.inject("rest.access_state", pgError(500, "XX000", "a"));
      h.inject("rest.profiles", pgError(500, "XX000", "b"));
      h.inject("rest.feedback_insert", pgError(500, "XX000", "c"));
    },
    expect: { ...OK, feedbackRows: 0 },
  },

  // ── Request body faults (client side) ──────────────────────────────────────
  {
    id: "B01",
    title: "invalid JSON body → treated as no survey",
    arrange: () => {},
    expect: { ...OK, calls: { "rest.feedback_insert": 0 } },
  },
  {
    id: "B02",
    title: "survey with an unknown reason → dropped, deletion proceeds",
    survey: { ...VALID_SURVEY, reason: "because" },
    arrange: () => {},
    expect: { ...OK, calls: { "rest.feedback_insert": 0, "rest.access_state": 0 } },
  },
  {
    id: "B03",
    title: "survey details of 100k chars → capped at 500 code points",
    survey: { ...VALID_SURVEY, details: "x".repeat(100_000) },
    arrange: () => {},
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) =>
        (h.feedback[0]?.details?.length ?? 0) <= 500 ? null : "details not capped",
    },
  },
  {
    id: "B04",
    title: "survey with __proto__ / constructor keys",
    survey: JSON.parse(
      '{"reason":"other","__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"wanted":{"toString":1}}',
    ),
    arrange: () => {},
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) => (h.feedback[0]?.wanted === null ? null : "wanted must be null"),
    },
  },
  {
    id: "B05",
    title: "survey with control / bidi characters in details",
    survey: { ...VALID_SURVEY, details: "a\u0000b\u202Ec\u200Bd  e" },
    arrange: () => {},
    expect: {
      ...OK,
      feedbackRows: 1,
      check: (_o, h) =>
        h.feedback[0]?.details === "abcd e" ? null : `details=${h.feedback[0]?.details}`,
    },
  },
];

interface FaultRow {
  id: string;
  title: string;
  ran: boolean;
  held: boolean;
  status: number | null;
  client: ClientClass | null;
  retryAfter: string | null;
  latencyMs: number | null;
  calls: Record<string, number> | null;
  recoverStatus: number | null;
  problems: string[];
}

function checkExpectations(c: FaultCase, o: Outcome, h: Harness): string[] {
  const problems: string[] = [];
  const e = c.expect;
  if (o.status !== e.status) problems.push(`status ${o.status} != ${e.status}`);
  if (o.client !== e.client) problems.push(`client ${o.client} != ${e.client}`);
  if (e.retryAfter === "present" && o.retryAfter === null) problems.push("Retry-After missing");
  if (e.retryAfter === "absent" && o.retryAfter !== null) problems.push("Retry-After unexpected");
  for (const [target, n] of Object.entries(e.calls ?? {})) {
    if ((o.calls[target] ?? 0) !== n)
      problems.push(`${target} calls ${o.calls[target] ?? 0} != ${n}`);
  }
  if ((o.calls["rest.other"] ?? 0) + (o.calls["unknown"] ?? 0) + (o.calls["revenuecat"] ?? 0) > 0) {
    problems.push("route reached an upstream it must not touch");
  }
  if (e.maxLatencyMs !== undefined && o.latencyMs > e.maxLatencyMs) {
    problems.push(`latency ${o.latencyMs}ms > ${e.maxLatencyMs}ms`);
  }
  if (e.minLatencyMs !== undefined && o.latencyMs < e.minLatencyMs) {
    problems.push(`latency ${o.latencyMs}ms < ${e.minLatencyMs}ms`);
  }
  if (e.feedbackRows !== undefined && h.feedback.length !== e.feedbackRows) {
    problems.push(`feedback rows ${h.feedback.length} != ${e.feedbackRows}`);
  }
  if (o.status >= 500 && o.status !== 503) problems.push(`unexpected ${o.status} (handler crash?)`);
  const body = o.body as Record<string, unknown> | null;
  if (o.status === 200) {
    const ttl = Date.parse(String(body?.expiresAt)) - Date.now();
    if (!(ttl > 14 * 60_000 && ttl <= 15 * 60_000)) problems.push(`expiresAt ttl ${ttl}ms`);
  }
  if (o.status >= 500 && body && typeof body === "object") {
    const msg = String((body.error as Record<string, unknown> | undefined)?.message ?? "");
    if (/XX000|PGRST|42501|23505|boom|internal error|stack/i.test(msg)) {
      problems.push(`5xx body leaks upstream detail: ${msg}`);
    }
  }
  const custom = e.check?.(o, h);
  if (custom) problems.push(custom);
  return problems;
}

Deno.test(
  "STRESS delete-request: fault matrix (auth / PostgREST / body) → error class + recoverability",
  async () => {
    const rows: FaultRow[] = [];
    for (const c of FAULT_CASES) {
      h.reset();
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      const row: FaultRow = {
        id: c.id,
        title: c.title,
        ran: false,
        held: false,
        status: null,
        client: null,
        retryAfter: null,
        latencyMs: null,
        calls: null,
        recoverStatus: null,
        problems: [],
      };
      rows.push(row);
      if (c.slow && !SLOW) {
        row.problems.push("not run (STRESS_SLOW!=1)");
        continue;
      }
      const legacy = c.id === "A18" || c.id === "A19";
      const { user, token: sessionToken, ip } = newUser(h);
      const token = legacy ? googleIdToken(user.id) : sessionToken;
      if (c.warmAuth) {
        const warm = await drive(h, h.request({ token, ip, body: {} }));
        assertEquals(warm.status, 200, `${c.id} warm-up`);
        h.calls = [];
        h.feedback = [];
        h.deletionRequests.clear();
      }
      c.arrange(h);
      const request =
        c.id === "B01"
          ? h.request({
              token,
              ip,
              rawBody: "{not json",
              headers: { "Content-Type": "application/json" },
            })
          : h.request({ token, ip, body: c.survey === undefined ? {} : { survey: c.survey } });
      const o = await drive(h, request);
      row.ran = true;
      row.status = o.status;
      row.client = o.client;
      row.retryAfter = o.retryAfter;
      row.latencyMs = o.latencyMs;
      row.calls = o.calls;
      const problems = checkExpectations(c, o, h);
      const stored = h.deletionRequests.get(user.id);
      if (c.expect.challengeStored === true) {
        const challenge = (o.body as Record<string, unknown>)?.challenge;
        if (!stored || stored.challenge !== challenge)
          problems.push("response challenge ≠ stored challenge");
      } else if (c.expect.challengeStored === false && stored) {
        problems.push("a challenge was stored although the route answered failure");
      }
      // Recoverability: the same user, healthy upstreams.
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      h.releaseHangs();
      h.reset();
      h.registerUser(user);
      if (!legacy) h.sessions.set(token, user.id);
      const again = await drive(h, h.request({ token, ip, body: {} }));
      row.recoverStatus = again.status;
      const wantRecover = c.recover ?? 200;
      if (again.status !== wantRecover)
        problems.push(`recovery status ${again.status} != ${wantRecover}`);
      row.problems = problems;
      row.held = problems.length === 0;
    }
    const path = await writeReport("delete_request_fault_matrix", {
      seed: STRESS_SEED,
      slow: SLOW,
      ran: rows.filter((r) => r.ran).length,
      held: rows.filter((r) => r.held).length,
      rows,
    });
    const failed = rows.filter((r) => r.ran && !r.held);
    console.log(
      `[stress] fault matrix: ${rows.filter((r) => r.ran).length}/${rows.length} ran, ${failed.length} broken${path ? ` → ${path}` : ""}`,
    );
    for (const f of failed)
      console.log(`[stress]   BROKEN ${f.id} ${f.title}: ${f.problems.join("; ")}`);
    assertEquals(
      failed.map((f) => `${f.id}: ${f.problems.join("; ")}`),
      [],
    );
    assert(rows.filter((r) => r.ran).length >= 40, "≥40 fault cases must actually run");
  },
);

// ── Hung PostgREST: no deadline on the write path ────────────────────────────

Deno.test(
  "STRESS delete-request: a hung PostgREST upsert / survey insert holds the response open (no route-side deadline)",
  async () => {
    const report: Record<string, unknown> = {};
    const WAIT_MS = 2_500;
    for (const target of ["rest.deletion_upsert", "rest.feedback_insert"] as const) {
      h.reset();
      const { user, token, ip } = newUser(h);
      h.injectSticky(target, { kind: "hang" });
      const survey = target === "rest.feedback_insert" ? VALID_SURVEY : undefined;
      const started = performance.now();
      let settled: Outcome | null = null;
      const pending = drive(h, h.request({ token, ip, body: survey ? { survey } : {} })).then(
        (o) => {
          settled = o;
          return o;
        },
      );
      await new Promise((r) => setTimeout(r, WAIT_MS));
      const answeredWithinWait = settled !== null;
      const hungCalls = h.hungCount();
      h.releaseHangs();
      const o = await pending;
      report[target] = {
        answeredWithinWaitMs: answeredWithinWait,
        waitMs: WAIT_MS,
        hungUpstreamCalls: hungCalls,
        statusAfterRelease: o.status,
        totalLatencyMs: Math.round(performance.now() - started),
        challengeStoredAfterRelease: h.deletionRequests.has(user.id),
      };
      // Contract under test: the route has no deadline of its own here — the
      // response is held for as long as PostgREST holds the socket (the app
      // gives up at 15 s). Both the observation and the eventual recovery are
      // recorded; a change to either is a behaviour change worth noticing.
      assertEquals(answeredWithinWait, false, `${target}: route answered while upstream hung`);
      assertEquals(hungCalls, 1);
      assertEquals(o.status, 200);
    }
    const path = await writeReport("delete_request_hung_postgrest", report);
    console.log(`[stress] hung PostgREST: ${JSON.stringify(report)}${path ? ` → ${path}` : ""}`);
  },
);

// ── Budget consumed by failed attempts ──────────────────────────────────────

Deno.test(
  "STRESS delete-request: three upstream 503s spend the whole 3/hour budget → 4th healthy request is 429",
  async () => {
    h.reset();
    const { token, ip } = newUser(h);
    const statuses: number[] = [];
    const retryAfter: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      h.inject("rest.deletion_upsert", pgError(503, "PGRST001", "no connection"));
      const o = await drive(h, h.request({ token, ip, body: {} }));
      statuses.push(o.status);
      retryAfter.push(o.retryAfter);
    }
    const healthy = await drive(h, h.request({ token, ip, body: {} }));
    statuses.push(healthy.status);
    retryAfter.push(healthy.retryAfter);
    const path = await writeReport("delete_request_budget_after_failures", {
      statuses,
      retryAfter,
      upsertCallsOnFourth: healthy.calls["rest.deletion_upsert"] ?? 0,
    });
    console.log(
      `[stress] budget after failures: ${JSON.stringify({ statuses, retryAfter })}${path ? ` → ${path}` : ""}`,
    );
    assertEquals(statuses, [503, 503, 503, 429]);
    assert(Number(healthy.retryAfter) >= 1 && Number(healthy.retryAfter) <= 3600);
    assertEquals(healthy.calls["rest.deletion_upsert"] ?? 0, 0);
  },
);

// ── Randomized fault campaign (seeded, replayable) ──────────────────────────

type RandomFault = { target: Target; fault: Fault; label: string };

const FAST_FAULT_POOL: RandomFault[] = [
  { target: "auth.user", fault: { kind: "http", status: 500, body: "{}" }, label: "auth:500" },
  { target: "auth.user", fault: { kind: "http", status: 401, body: "{}" }, label: "auth:401" },
  {
    target: "auth.user",
    fault: { kind: "http", status: 200, body: "<html>" },
    label: "auth:200-garbage",
  },
  { target: "auth.user", fault: { kind: "throw" }, label: "auth:throw-once" },
  { target: "rest.deletion_upsert", fault: pgError(500, "XX000", "x"), label: "upsert:500" },
  { target: "rest.deletion_upsert", fault: pgError(503, "PGRST001", "x"), label: "upsert:503" },
  { target: "rest.deletion_upsert", fault: pgError(403, "42501", "x"), label: "upsert:403" },
  { target: "rest.deletion_upsert", fault: { kind: "throw" }, label: "upsert:throw" },
  {
    target: "rest.deletion_upsert",
    fault: { kind: "http", status: 200, body: "garbage" },
    label: "upsert:200-garbage",
  },
  { target: "rest.access_state", fault: pgError(500, "XX000", "x"), label: "rpc:500" },
  { target: "rest.access_state", fault: { kind: "throw" }, label: "rpc:throw" },
  {
    target: "rest.access_state",
    fault: { kind: "http", status: 200, body: "{}" },
    label: "rpc:200-object",
  },
  {
    target: "rest.access_state",
    fault: { kind: "http", status: 200, body: "nope" },
    label: "rpc:200-garbage",
  },
  { target: "rest.profiles", fault: pgError(500, "XX000", "x"), label: "profiles:500" },
  { target: "rest.profiles", fault: pgError(406, "PGRST116", "x"), label: "profiles:406" },
  {
    target: "rest.profiles",
    fault: { kind: "http", status: 200, body: "[]" },
    label: "profiles:200-empty",
  },
  { target: "rest.feedback_insert", fault: pgError(500, "XX000", "x"), label: "feedback:500" },
  { target: "rest.feedback_insert", fault: pgError(403, "42501", "x"), label: "feedback:403" },
  { target: "rest.feedback_insert", fault: { kind: "throw" }, label: "feedback:throw" },
  { target: "revenuecat", fault: { kind: "http", status: 500, body: "{}" }, label: "rc:500" },
  { target: "revenuecat", fault: { kind: "throw" }, label: "rc:throw" },
];

const SURVEY_POOL: Array<{ label: string; survey: unknown }> = [
  { label: "none", survey: undefined },
  { label: "valid", survey: VALID_SURVEY },
  { label: "valid-min", survey: { reason: "other" } },
  { label: "unknown-reason", survey: { reason: "nope" } },
  { label: "not-object", survey: "reason=other" },
  { label: "long-details", survey: { reason: "privacy", details: "y".repeat(5_000) } },
];

Deno.test(
  `STRESS delete-request: randomized fault campaign (${STRESS_ITER} seeded iterations)`,
  async () => {
    const rows: Array<Record<string, unknown>> = [];
    let broken = 0;
    for (let i = 0; i < STRESS_ITER; i++) {
      const seed = STRESS_SEED + i;
      const rng = new Prng(seed);
      h.reset();
      const { user, token, ip } = newUser(h, {
        premium: rng.next() < 0.3,
        scoredCount: rng.int(0, 5),
      });
      const surveyPick = rng.pick(SURVEY_POOL);
      const faultCount = rng.int(0, 3);
      const faults: RandomFault[] = [];
      for (let f = 0; f < faultCount; f++) faults.push(rng.pick(FAST_FAULT_POOL));
      for (const f of faults) h.inject(f.target, f.fault);
      h.latency = () => rng.int(0, 3);

      const o = await drive(
        h,
        h.request({
          token,
          ip,
          body: surveyPick.survey === undefined ? {} : { survey: surveyPick.survey },
        }),
      );
      // Oracle: the first queued fault per target is what the route saw — except
      // on the auth gateway, whose socket-failure retry consumes the next one.
      const first = (t: Target) => faults.find((f) => f.target === t);
      const authFault = faults
        .filter((f) => f.target === "auth.user")
        .find((f) => f.label !== "auth:throw-once");
      const upsertFault = first("rest.deletion_upsert");
      const surveyValid =
        surveyPick.label === "valid" ||
        surveyPick.label === "valid-min" ||
        surveyPick.label === "long-details";
      let expectStatus: number;
      if (authFault?.label === "auth:401") expectStatus = 401;
      else if (authFault) expectStatus = 503;
      else if (upsertFault) expectStatus = 503;
      else expectStatus = 200;
      const problems: string[] = [];
      if (o.status !== expectStatus) problems.push(`status ${o.status} != ${expectStatus}`);
      if (o.status >= 500 && o.status !== 503) problems.push(`crash ${o.status}`);
      if (
        (o.calls["revenuecat"] ?? 0) + (o.calls["rest.other"] ?? 0) + (o.calls["unknown"] ?? 0) >
        0
      ) {
        problems.push("unexpected upstream touched");
      }
      if (expectStatus === 200) {
        const stored = h.deletionRequests.get(user.id);
        const challenge = (o.body as Record<string, unknown>)?.challenge;
        if (!stored || stored.challenge !== challenge) problems.push("challenge not stored");
        const expectFeedback = surveyValid && !first("rest.feedback_insert");
        if (h.feedback.length !== (expectFeedback ? 1 : 0)) {
          problems.push(`feedback rows ${h.feedback.length}`);
        }
        const expectRest = 1 + (surveyValid ? 3 : 0);
        const restCalls =
          (o.calls["rest.deletion_upsert"] ?? 0) +
          (o.calls["rest.access_state"] ?? 0) +
          (o.calls["rest.profiles"] ?? 0) +
          (o.calls["rest.feedback_insert"] ?? 0);
        if (restCalls !== expectRest) problems.push(`rest calls ${restCalls} != ${expectRest}`);
      } else {
        if (h.feedback.length !== 0) problems.push("feedback written on a failed request");
        if (expectStatus !== 200 && upsertFault && h.deletionRequests.has(user.id)) {
          problems.push("challenge stored on a failed upsert");
        }
      }
      // Recovery: same user, healthy upstreams (leftover queued faults dropped).
      h.latency = null;
      h.clearFaults();
      const again = await drive(h, h.request({ token, ip, body: {} }));
      if (again.status !== 200) problems.push(`recovery ${again.status}`);
      if (problems.length > 0) broken += 1;
      rows.push({
        seed,
        survey: surveyPick.label,
        faults: faults.map((f) => f.label),
        status: o.status,
        client: o.client,
        latencyMs: o.latencyMs,
        supabaseRoundTrips: o.supabaseRoundTrips,
        recovery: again.status,
        outcome: problems.length === 0 ? "HELD" : "BROKEN",
        problems,
      });
    }
    const path = await writeReport("delete_request_random_faults", {
      baseSeed: STRESS_SEED,
      iterations: STRESS_ITER,
      broken,
      replay:
        "STRESS_SEED=<seed> STRESS_ITER=1 deno test -A --no-check --config deno.json stress_delete_request_failure_load.test.ts",
      rows,
    });
    console.log(
      `[stress] random faults: ${STRESS_ITER} iterations, ${broken} broken${path ? ` → ${path}` : ""}`,
    );
    assertEquals(
      rows
        .filter((r) => r.outcome === "BROKEN")
        .map((r) => `${r.seed}: ${(r.problems as string[]).join("; ")}`),
      [],
    );
  },
);

// ── Load: latency + Supabase round trips per request ────────────────────────

Deno.test(
  `STRESS delete-request: load ${LOAD_N} requests — p50/p95 latency and Supabase round trips per request`,
  async () => {
    h.reset();
    const rng = new Prng(STRESS_SEED ^ 0x10ad);
    const users = Math.ceil(LOAD_N / 2);
    const sessions: Array<{ token: string; ip: string; survey: boolean }> = [];
    for (let i = 0; i < users; i++) {
      const { token, ip } = newUser(h);
      sessions.push({ token, ip, survey: rng.next() < 0.5 });
    }
    const buckets: Record<string, { latency: number[]; roundTrips: number[] }> = {};
    const statusCounts: Record<string, number> = {};
    let executed = 0;
    const started = performance.now();
    for (let pass = 0; pass < 2 && executed < LOAD_N; pass++) {
      for (const s of sessions) {
        if (executed >= LOAD_N) break;
        const o = await drive(
          h,
          h.request({ token: s.token, ip: s.ip, body: s.survey ? { survey: VALID_SURVEY } : {} }),
        );
        executed += 1;
        statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
        const cacheHit = (o.calls["auth.user"] ?? 0) === 0;
        const key = `${cacheHit ? "auth-cache-hit" : "auth-cache-miss"}/${s.survey ? "survey" : "no-survey"}`;
        const b = buckets[key] ?? (buckets[key] = { latency: [], roundTrips: [] });
        b.latency.push(o.latencyMs);
        b.roundTrips.push(o.supabaseRoundTrips);
      }
    }
    const wallMs = Math.round(performance.now() - started);
    const summary = Object.fromEntries(
      Object.entries(buckets).map(([k, b]) => [
        k,
        {
          requests: b.latency.length,
          latency: latencyStats(b.latency),
          supabaseRoundTrips: {
            min: Math.min(...b.roundTrips),
            max: Math.max(...b.roundTrips),
            mean:
              Math.round((b.roundTrips.reduce((a, c) => a + c, 0) / b.roundTrips.length) * 100) /
              100,
          },
        },
      ]),
    );
    const all = Object.values(buckets).flatMap((b) => b.latency);
    const report = {
      requests: executed,
      wallMs,
      throughputPerSec: Math.round((executed / wallMs) * 1000),
      statusCounts,
      overall: latencyStats(all),
      byPath: summary,
      heapUsedMb: Math.round((Deno.memoryUsage().heapUsed / 1048576) * 10) / 10,
    };
    const path = await writeReport("delete_request_load", report);
    console.log(`[stress] load: ${JSON.stringify(report)}${path ? ` → ${path}` : ""}`);
    assertEquals(statusCounts, { "200": executed });
    // Round-trip contract: no-survey = 1 PostgREST write (+1 auth on a miss);
    // survey = 4 (+1 on a miss). Anything else is an unplanned upstream call.
    for (const [key, b] of Object.entries(buckets)) {
      const [cache, survey] = key.split("/");
      const expected = (survey === "survey" ? 4 : 1) + (cache === "auth-cache-miss" ? 1 : 0);
      assertEquals(Math.min(...b.roundTrips), expected, `${key} min round trips`);
      assertEquals(Math.max(...b.roundTrips), expected, `${key} max round trips`);
    }
  },
);

// ── Memory: L1 caches under N distinct users ────────────────────────────────

Deno.test(
  `STRESS delete-request: L1 memory under ${USERS_N} distinct users + in-memory rate-limit window behaviour`,
  async () => {
    h.reset();
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heapBefore = Deno.memoryUsage().heapUsed;

    // A user who has spent the whole delete-request budget before the flood.
    const spent = newUser(h);
    const spentStatuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      spentStatuses.push(
        (await drive(h, h.request({ token: spent.token, ip: spent.ip, body: {} }))).status,
      );
    }
    assertEquals(spentStatuses, [200, 200, 200, 429]);

    const latencies: number[] = [];
    const statusCounts: Record<string, number> = {};
    let heapPeak = heapBefore;
    const started = performance.now();
    for (let i = 0; i < USERS_N; i++) {
      const { user, token, ip } = newUser(h);
      const o = await drive(h, h.request({ token, ip, body: {} }));
      latencies.push(o.latencyMs);
      statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
      if (i % 1000 === 0) heapPeak = Math.max(heapPeak, Deno.memoryUsage().heapUsed);
      // The fake's own tables would dominate the heap; keep only the isolate's
      // L1 state (auth cache + rate-limit windows) under measurement.
      h.sessions.delete(token);
      h.users.delete(user.id);
      h.deletionRequests.delete(user.id);
      h.calls = [];
    }
    const wallMs = Math.round(performance.now() - started);
    gc?.();
    const heapAfter = Deno.memoryUsage().heapUsed;

    // After the flood: is the spent user's budget still enforced?
    const afterFlood = await drive(h, h.request({ token: spent.token, ip: spent.ip, body: {} }));
    const report = {
      distinctUsers: USERS_N,
      wallMs,
      statusCounts,
      latency: latencyStats(latencies),
      heapUsedBeforeMb: Math.round((heapBefore / 1048576) * 10) / 10,
      heapUsedPeakMb: Math.round((heapPeak / 1048576) * 10) / 10,
      heapUsedAfterMb: Math.round((heapAfter / 1048576) * 10) / 10,
      heapDeltaMb: Math.round(((heapAfter - heapBefore) / 1048576) * 10) / 10,
      gcExposed: typeof gc === "function",
      spentUserBeforeFlood: spentStatuses,
      spentUserAfterFlood: afterFlood.status,
      rateLimitWindowsResetByFlood: afterFlood.status === 200,
    };
    const path = await writeReport("delete_request_l1_memory", report);
    console.log(`[stress] L1 memory: ${JSON.stringify(report)}${path ? ` → ${path}` : ""}`);
    assertEquals(statusCounts, { "200": USERS_N });
    // Bounded L1: MEMORY_MAX_ENTRIES=5000 auth rows + MEMORY_WINDOW_MAX=20000
    // windows — a few hundred bytes each; a growth past 64 MB would mean a leak.
    assert(heapAfter - heapBefore < 64 * 1048576, `heap grew ${report.heapDeltaMb} MB`);
    // Documented behaviour of rateLimit.ts memoryIncr: once the window map holds
    // MEMORY_WINDOW_MAX live keys it is CLEARED, so every in-flight budget (this
    // user's 3/hour) resets. With ≥10k distinct users in one isolate (2 keys
    // each: ip + delete_request) the reset is expected; below that it must not.
    const keysCreated = 2 * (USERS_N + 1);
    if (keysCreated <= 20_000) {
      assertEquals(afterFlood.status, 429, "budget must survive a flood below the window cap");
    }
  },
);

Deno.test(
  "STRESS delete-request: 10 001 unauthenticated requests from distinct IPs reset every in-memory rate-limit window (MEMORY_WINDOW_MAX clear)",
  async () => {
    h.reset();
    const spent = newUser(h);
    const before: number[] = [];
    for (let i = 0; i < 4; i++) {
      before.push(
        (await drive(h, h.request({ token: spent.token, ip: spent.ip, body: {} }))).status,
      );
    }
    assertEquals(before, [200, 200, 200, 429]);
    // Each anonymous request creates two live windows (rl:ip:… and, after the
    // 401, rl:authfail:…); 10 001 of them push the map past MEMORY_WINDOW_MAX.
    const FLOOD = 10_001;
    const started = performance.now();
    const anonStatuses: Record<string, number> = {};
    for (let i = 0; i < FLOOD; i++) {
      const o = await drive(h, h.request({ token: null, body: {} }));
      anonStatuses[o.status] = (anonStatuses[o.status] ?? 0) + 1;
    }
    const floodMs = Math.round(performance.now() - started);
    const after = await drive(h, h.request({ token: spent.token, ip: spent.ip, body: {} }));
    const report = {
      spentUserBefore: before,
      anonymousFlood: FLOOD,
      anonStatuses,
      floodMs,
      spentUserAfter: after.status,
      budgetResetByFlood: after.status === 200,
    };
    const path = await writeReport("delete_request_window_reset", report);
    console.log(`[stress] window reset: ${JSON.stringify(report)}${path ? ` → ${path}` : ""}`);
    assertEquals(anonStatuses, { "401": FLOOD });
    assert(
      floodMs < 60_000,
      "flood must fit inside one ip window for the clear() to be observable",
    );
    // Documented current behaviour (rateLimit.ts memoryIncr → windows.clear()):
    // the spent user's 3/hour budget is gone. If this starts answering 429 the
    // window map no longer resets wholesale — update the finding, not the code.
    assertEquals(after.status, 200);
  },
);

// ── Concurrency / idempotency: two overlapping requests for one user ────────

Deno.test(
  `STRESS delete-request: overlapping requests for one user — last upsert wins, earlier challenge is silently invalidated (${STRESS_ITER} seeds)`,
  async () => {
    const rows: Array<Record<string, unknown>> = [];
    let firstResponderInvalidated = 0;
    for (let i = 0; i < STRESS_ITER; i++) {
      const seed = STRESS_SEED + 7_000 + i;
      const rng = new Prng(seed);
      h.reset();
      const { user, token, ip } = newUser(h);
      const delays = [rng.int(0, 20), rng.int(0, 20)];
      let n = 0;
      h.latency = (t) => (t === "rest.deletion_upsert" ? delays[n++ % 2] : 0);
      const [a, b] = await Promise.all([
        drive(h, h.request({ token, ip, body: {} })),
        drive(h, h.request({ token, ip, body: {} })),
      ]);
      const stored = h.deletionRequests.get(user.id)?.challenge ?? null;
      const ca = (a.body as Record<string, unknown>)?.challenge;
      const cb = (b.body as Record<string, unknown>)?.challenge;
      const first = a.latencyMs <= b.latencyMs ? ca : cb;
      const invalidated = stored !== first;
      if (invalidated) firstResponderInvalidated += 1;
      rows.push({
        seed,
        upsertDelaysMs: delays,
        statuses: [a.status, b.status],
        distinctChallenges: ca !== cb,
        storedIsOneOfThem: stored === ca || stored === cb,
        firstResponderChallengeStillValid: !invalidated,
        rowsForUser: [...h.deletionRequests.values()].filter((r) => r.user_id === user.id).length,
      });
      assertEquals([a.status, b.status], [200, 200], `seed ${seed}`);
      assert(ca !== cb, `seed ${seed}: challenges must be distinct`);
      assert(stored === ca || stored === cb, `seed ${seed}: stored challenge is neither`);
    }
    const path = await writeReport("delete_request_overlap", {
      iterations: STRESS_ITER,
      firstResponderInvalidated,
      rows,
    });
    console.log(
      `[stress] overlap: ${STRESS_ITER} seeds, first responder's challenge invalidated in ${firstResponderInvalidated}${path ? ` → ${path}` : ""}`,
    );
  },
);
