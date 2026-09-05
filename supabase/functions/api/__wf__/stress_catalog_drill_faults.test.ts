// stress-catalog-drill / failure-load lens — FAILURE INJECTION for
// GET /v1/catalog/drills/:slug (real handler, Redis-enabled isolate).
//
// Every upstream the request can touch (Supabase Auth user verification,
// the transitional provider-token exchange, PostgREST, Upstash, RevenueCat as
// a never-called control) is made to fail / time out / answer malformed IN
// TURN, and for every case the test asserts the USER-VISIBLE error class and
// that the next healthy request recovers:
//
//   - no 500 and no upstream detail in any body (5xx bodies stay generic)
//   - every error body is `{ error: { message[, code] } }` + x-request-id
//   - Auth outage → 503 + Retry-After; Auth refusal → 401 (sign-out class)
//   - PostgREST failure → 503 "Drill detail is temporarily unavailable"
//   - Upstash failure of any shape → fail-open 200 (never a user-visible error)
//   - RevenueCat is never called by this route
//   - a healthy request right after the fault answers 200 with the correct
//     `saved` flag and ≤ 3 Supabase round trips
//
// Observations that the test RECORDS but only asserts under STRESS_STRICT=1
// (they are the lens' findings, not the code's documented contract): the
// request stalling past the harness deadline while an upstream hangs or
// postgrest-js retries, and an Auth OUTAGE on the transitional provider-token
// path surfacing as a 401 that charges the per-IP auth-failure budget.
//
// Seeded (mulberry32): iteration i uses seed STRESS_SEED + i; the first pass
// walks every case in order so a default run covers the whole matrix, later
// iterations pick cases at random. Replay one iteration with
// STRESS_SEED=<seed> STRESS_ITER=1 STRESS_CASE=<case id>. Results land in
// artifacts/stress-catalog-drill/latest/faults.json (STRESS_OUT_DIR).
//
// Cases whose cost is inherent to the client libraries (postgrest-js sleeping
// 1s/2s/4s between retries, six Upstash deadlines of 1.2 s in a row) are
// `slow` and only run with STRESS_SLOW=1; STRESS_DEADLINE_MS overrides every
// case deadline so a lens run can record the TRUE latency of a stall.

import { assert, assertEquals } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import {
  envInt,
  type Fault,
  isRecord,
  loadStressHarness,
  Prng,
  type RunResult,
  type Upstream,
  userRequest,
  writeArtifact,
} from "./stress_catalog_drill_harness.ts";

const STRICT = Deno.env.get("STRESS_STRICT") === "1";
const SLOW = Deno.env.get("STRESS_SLOW") === "1";
const DEADLINE_OVERRIDE = envInt("STRESS_DEADLINE_MS", 0);
const LEAK = "SECRET-UPSTREAM-DETAIL-7f3a";
const deadlineOf = (fc: { deadlineMs?: number }) => DEADLINE_OVERRIDE || fc.deadlineMs || 2_000;

interface FaultCase {
  id: string;
  upstream: Upstream;
  fault: Fault;
  bearer: "session" | "provider" | "either";
  /** Auth-cache state before the faulted request. */
  warm: "cold" | "warm" | "either";
  /** Documented user-visible class of the faulted request. */
  status: number[];
  message?: string;
  code?: string;
  retryAfter?: "required" | "absent" | "any";
  /** Faulted-request `saved` flag is not trustworthy for this shape. */
  savedUnreliable?: boolean;
  /** How long to wait for the faulted request before parking it. */
  deadlineMs?: number;
  /** Set when the handler is EXPECTED (by the lens) to stall past the deadline. */
  stalls?: boolean;
  /** Costs seconds by construction (library sleeps) — STRESS_SLOW=1 only. */
  slow?: boolean;
  /** `fresh_token`: the SAME bearer is expected to stay broken for a cache
   * lifetime after the fault clears; only a fresh session must recover. */
  recovery?: "immediate" | "fresh_token";
  note?: string;
}

const authUserOutage = (id: string, fault: Fault, extra: Partial<FaultCase> = {}): FaultCase => ({
  id,
  upstream: "auth_user",
  fault,
  bearer: "session",
  warm: "cold",
  status: [503],
  message: "Session verification is temporarily unavailable. Please try again.",
  retryAfter: "required",
  ...extra,
});

const authUserRefusal = (id: string, fault: Fault, message?: string): FaultCase => ({
  id,
  upstream: "auth_user",
  fault,
  bearer: "session",
  warm: "cold",
  status: [401],
  message: message ?? "The session is no longer valid. Sign in again.",
  retryAfter: "absent",
});

const providerExchange = (id: string, fault: Fault, extra: Partial<FaultCase> = {}): FaultCase => ({
  id,
  upstream: "auth_token",
  fault,
  bearer: "provider",
  warm: "cold",
  status: [401],
  message: "The identity token could not be verified.",
  retryAfter: "absent",
  note: "transitional provider-token branch folds every exchange failure into a 401",
  ...extra,
});

const restFailure = (id: string, fault: Fault, extra: Partial<FaultCase> = {}): FaultCase => ({
  id,
  upstream: "rest",
  fault,
  bearer: "either",
  warm: "either",
  status: [503],
  message: "Drill detail is temporarily unavailable. Please try again.",
  retryAfter: "absent",
  ...extra,
});

const redisFailOpen = (id: string, fault: Fault, extra: Partial<FaultCase> = {}): FaultCase => ({
  id,
  upstream: "redis",
  fault,
  bearer: "either",
  warm: "either",
  status: [200],
  ...extra,
});

const rcControl = (id: string, fault: Fault): FaultCase => ({
  id,
  upstream: "revenuecat",
  fault,
  bearer: "either",
  warm: "either",
  status: [200],
  note: "RevenueCat is not on this route; the fault must be invisible and the upstream never called",
});

const supabaseUser = (id: string, provider = "google") => ({
  id,
  aud: "authenticated",
  role: "authenticated",
  email: `${id}@example.com`,
  app_metadata: { provider, providers: [provider] },
  user_metadata: {},
});

export const FAULT_CASES: readonly FaultCase[] = [
  // ── Supabase Auth — session verification (GET /auth/v1/user) ─────────────
  authUserOutage("auth_user_500_json", {
    kind: "json",
    status: 500,
    body: { code: 500, msg: LEAK },
  }),
  authUserOutage("auth_user_502_html", {
    kind: "http",
    status: 502,
    body: `<html><body>bad gateway ${LEAK}</body></html>`,
    contentType: "text/html",
  }),
  authUserOutage(
    "auth_user_503_retry_after_7",
    {
      kind: "json",
      status: 503,
      body: { msg: LEAK },
      headers: { "Retry-After": "7" },
    },
    { note: "upstream Retry-After should reach the client" },
  ),
  authUserOutage("auth_user_504_empty", { kind: "http", status: 504, body: "" }),
  authUserOutage("auth_user_429_rate_limited", {
    kind: "json",
    status: 429,
    body: { msg: "over request rate limit" },
    headers: { "Retry-After": "30" },
  }),
  authUserOutage("auth_user_404_gateway_misroute", {
    kind: "http",
    status: 404,
    body: "not found",
  }),
  authUserOutage("auth_user_network_reset", { kind: "throw", message: `connection reset ${LEAK}` }),
  authUserOutage(
    "auth_user_hang",
    { kind: "hang" },
    {
      deadlineMs: 2_000,
      note: "must be cut by AUTH_UPSTREAM_TIMEOUT_MS, not the harness deadline",
    },
  ),
  authUserOutage(
    "auth_user_slow_beyond_deadline",
    { kind: "delay", ms: 700 },
    { deadlineMs: 2_000 },
  ),
  authUserOutage("auth_user_200_malformed_json", { kind: "malformed_json", status: 200 }),
  authUserOutage("auth_user_200_empty_object", { kind: "json", status: 200, body: {} }),
  authUserOutage("auth_user_200_text_body", {
    kind: "http",
    status: 200,
    body: "ok",
    contentType: "text/plain",
  }),
  authUserOutage("auth_user_200_missing_id", {
    kind: "json",
    status: 200,
    body: { email: "x@example.com", app_metadata: { provider: "google" } },
  }),
  authUserOutage("auth_user_200_array_body", {
    kind: "json",
    status: 200,
    body: [supabaseUser("x")],
  }),
  authUserOutage("auth_user_200_id_not_string", {
    kind: "json",
    status: 200,
    body: { ...supabaseUser("x"), id: 42 },
  }),
  authUserRefusal("auth_user_401_invalid_jwt", {
    kind: "json",
    status: 401,
    body: { code: 401, msg: "invalid JWT" },
  }),
  authUserRefusal("auth_user_403_forbidden", {
    kind: "json",
    status: 403,
    body: { msg: "forbidden" },
  }),
  authUserRefusal("auth_user_400_bad_request", { kind: "json", status: 400, body: { msg: "bad" } }),
  authUserRefusal(
    "auth_user_200_email_provider",
    {
      kind: "json",
      status: 200,
      body: supabaseUser("99999999-9999-4999-8999-999999999999", "email"),
    },
    "The session does not belong to a Google or Apple account.",
  ),
  {
    id: "auth_user_slow_within_deadline",
    upstream: "auth_user",
    fault: { kind: "delay", ms: 150 },
    bearer: "session",
    warm: "cold",
    status: [200],
  },
  {
    id: "auth_user_500_masked_by_warm_cache",
    upstream: "auth_user",
    fault: { kind: "json", status: 500, body: { msg: LEAK } },
    bearer: "session",
    warm: "warm",
    status: [200],
    note: "a verified session in the cache must ride out an Auth outage",
  },
  {
    id: "auth_user_hang_masked_by_warm_cache",
    upstream: "auth_user",
    fault: { kind: "hang" },
    bearer: "session",
    warm: "warm",
    status: [200],
  },

  // ── Supabase Auth — transitional provider-token exchange ─────────────────
  providerExchange("auth_token_500", { kind: "json", status: 500, body: { msg: LEAK } }),
  providerExchange("auth_token_503", { kind: "http", status: 503, body: LEAK }),
  providerExchange("auth_token_network_reset", { kind: "throw" }),
  providerExchange("auth_token_200_malformed_json", { kind: "malformed_json" }),
  providerExchange("auth_token_200_without_session", {
    kind: "json",
    status: 200,
    body: { user: supabaseUser("x") },
  }),
  providerExchange(
    "auth_token_200_session_missing_user_id",
    {
      kind: "json",
      status: 200,
      body: { access_token: "a.b.c", refresh_token: "r", expires_in: 3600, user: { email: "x" } },
    },
    {
      status: [401, 503],
      message: undefined,
      recovery: "fresh_token",
      note: "a 200 without user.id is accepted (id undefined) and CACHED for the token's lifetime",
    },
  ),
  providerExchange(
    "auth_token_400_invalid_grant",
    {
      kind: "json",
      status: 400,
      body: { error: "invalid_grant", error_description: "Bad ID token" },
    },
    { note: "a genuine refusal — 401 is the right class here" },
  ),
  providerExchange(
    "auth_token_hang",
    { kind: "hang" },
    {
      deadlineMs: 1_500,
      stalls: true,
      note: "supabase-js signInWithIdToken has no deadline of its own",
    },
  ),
  {
    id: "auth_token_slow_within_deadline",
    upstream: "auth_token",
    fault: { kind: "delay", ms: 150 },
    bearer: "provider",
    warm: "cold",
    status: [200],
  },

  // ── Supabase PostgREST — the route's one read (user_saved_drills) ─────────
  restFailure("rest_500_pg_error", {
    kind: "json",
    status: 500,
    body: { code: "XX000", message: LEAK, details: LEAK, hint: null },
  }),
  restFailure("rest_502_empty", { kind: "http", status: 502, body: "" }),
  restFailure("rest_504_html", {
    kind: "http",
    status: 504,
    body: `<h1>${LEAK}</h1>`,
    contentType: "text/html",
  }),
  restFailure(
    "rest_401_pgrst301_jwt_expired",
    {
      kind: "json",
      status: 401,
      body: { code: "PGRST301", message: "JWT expired", details: null, hint: null },
    },
    { note: "verified at Auth but refused by PostgREST — surfaces as a retryable 503" },
  ),
  restFailure("rest_403_42501_permission_denied", {
    kind: "json",
    status: 403,
    body: { code: "42501", message: `permission denied for table user_saved_drills ${LEAK}` },
  }),
  restFailure("rest_404_pgrst205_table_missing", {
    kind: "json",
    status: 404,
    body: { code: "PGRST205", message: `Could not find the table ${LEAK}` },
  }),
  restFailure("rest_429_rate_limited", {
    kind: "json",
    status: 429,
    body: { message: "rate limited" },
    headers: { "Retry-After": "9" },
  }),
  restFailure("rest_200_malformed_json", { kind: "malformed_json", status: 200 }),
  restFailure("rest_200_text_body", {
    kind: "http",
    status: 200,
    body: `ok ${LEAK}`,
    contentType: "text/plain",
  }),
  restFailure(
    "rest_503_schema_cache_reloading",
    {
      kind: "json",
      status: 503,
      body: { code: "PGRST002", message: "Could not query the database for the schema cache" },
    },
    {
      deadlineMs: 1_500,
      stalls: true,
      slow: true,
      note: "postgrest-js retries 503 with 1s/2s/4s backoff (no signal) before the route answers",
    },
  ),
  restFailure(
    "rest_520_cloudflare",
    { kind: "http", status: 520, body: "" },
    {
      deadlineMs: 1_500,
      stalls: true,
      slow: true,
      note: "postgrest-js retries 520 with 1s/2s/4s backoff before the route answers",
    },
  ),
  restFailure(
    "rest_network_reset",
    { kind: "throw", message: `connection reset ${LEAK}` },
    {
      deadlineMs: 1_500,
      stalls: true,
      slow: true,
      note: "postgrest-js retries network errors with 1s/2s/4s backoff before the route answers",
    },
  ),
  restFailure(
    "rest_hang",
    { kind: "hang" },
    {
      deadlineMs: 1_500,
      stalls: true,
      note: "no deadline on the PostgREST read — the request waits for the socket",
    },
  ),
  restFailure(
    "rest_503_retry_after_3",
    {
      kind: "json",
      status: 503,
      body: { message: "reloading" },
      headers: { "Retry-After": "3" },
    },
    {
      deadlineMs: 1_500,
      stalls: true,
      slow: true,
      note: "postgrest-js sleeps the upstream Retry-After verbatim (uncapped) before each of 3 retries",
    },
  ),
  {
    id: "rest_200_array_empty",
    upstream: "rest",
    fault: { kind: "json", status: 200, body: [] },
    bearer: "either",
    warm: "either",
    status: [200],
    savedUnreliable: true,
    note: "maybeSingle folds [] to null → saved:false regardless of truth",
  },
  {
    id: "rest_200_unexpected_object_shape",
    upstream: "rest",
    fault: { kind: "json", status: 200, body: { unexpected: true } },
    bearer: "either",
    warm: "either",
    status: [200],
    savedUnreliable: true,
    note: "any truthy object counts as saved:true",
  },
  {
    id: "rest_200_null_body",
    upstream: "rest",
    fault: { kind: "http", status: 200, body: "null", contentType: "application/json" },
    bearer: "either",
    warm: "either",
    status: [200],
    savedUnreliable: true,
  },
  {
    id: "rest_200_multiple_rows",
    upstream: "rest",
    fault: { kind: "json", status: 200, body: [{ slug: "a" }, { slug: "b" }] },
    bearer: "either",
    warm: "either",
    status: [503],
    message: "Drill detail is temporarily unavailable. Please try again.",
    retryAfter: "absent",
    note: "postgrest-js turns >1 row into PGRST116 client-side",
  },
  {
    id: "rest_slow_within_deadline",
    upstream: "rest",
    fault: { kind: "delay", ms: 200 },
    bearer: "either",
    warm: "either",
    status: [200],
  },

  // ── Upstash Redis (L2 auth cache + shared rate-limit counters) ───────────
  redisFailOpen("redis_500", { kind: "json", status: 500, body: { error: LEAK } }),
  redisFailOpen("redis_401_bad_token", {
    kind: "json",
    status: 401,
    body: { error: "Unauthorized" },
  }),
  redisFailOpen("redis_429_quota", {
    kind: "json",
    status: 429,
    body: { error: "quota exceeded" },
  }),
  redisFailOpen("redis_network_reset", { kind: "throw" }),
  redisFailOpen(
    "redis_hang_until_timeout",
    { kind: "hang" },
    {
      deadlineMs: 15_000,
      slow: true,
      note: "each pipeline hits the 1.2 s Redis deadline in turn (no breaker)",
    },
  ),
  redisFailOpen("redis_200_malformed_json", { kind: "malformed_json" }),
  redisFailOpen("redis_200_empty_array", { kind: "json", status: 200, body: [] }),
  redisFailOpen("redis_200_object_not_array", {
    kind: "json",
    status: 200,
    body: { result: "OK" },
  }),
  redisFailOpen("redis_200_error_slots", {
    kind: "json",
    status: 200,
    body: [{ error: "ERR max requests limit exceeded" }, { error: "ERR" }, { error: "ERR" }],
  }),
  redisFailOpen(
    "redis_200_garbage_results",
    {
      kind: "json",
      status: 200,
      body: [{ result: "not-a-number" }, { result: { nested: true } }, { result: -1 }],
    },
    {
      status: [200, 401],
      recovery: "fresh_token",
      note: "any string in the revocation-marker slot is copied into L1 for 60 s → 401 for that session",
    },
  ),
  redisFailOpen(
    "redis_200_huge_counter",
    {
      kind: "json",
      status: 200,
      body: [{ result: 999_999_999 }, { result: 999_999_999 }, { result: 999_999_999 }],
    },
    {
      status: [429],
      note: "a Redis reply claiming the window is exhausted IS the limiter's truth → 429 is correct",
    },
  ),
  redisFailOpen("redis_slow_within_timeout", { kind: "delay", ms: 120 }),

  // ── RevenueCat — control: never on this route ────────────────────────────
  rcControl("revenuecat_500", { kind: "json", status: 500, body: { message: LEAK } }),
  rcControl("revenuecat_hang", { kind: "hang" }),
];

interface Row {
  i: number;
  seed: number;
  case: string;
  upstream: Upstream;
  bearer: "session" | "provider";
  warm: boolean;
  slug: string;
  savedTruth: boolean;
  ip: string;
  faulted: Summary;
  recovery: Summary;
  authFailCharged: number;
  verdict: "HELD" | "BROKEN";
  violations: string[];
  observations: string[];
  replay: string;
}

interface Summary {
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: string | null;
  latencyMs: number;
  timedOut: boolean;
  roundTrips: RunResult["roundTrips"];
  saved: boolean | null;
}

const summarize = (r: RunResult): Summary => ({
  status: r.status,
  code: r.code,
  message: r.message,
  retryAfter: r.retryAfter,
  latencyMs: Math.round(r.latencyMs * 100) / 100,
  timedOut: r.timedOut,
  roundTrips: r.roundTrips,
  saved:
    isRecord(r.body) && isRecord(r.body.drill) && typeof r.body.drill.saved === "boolean"
      ? r.body.drill.saved
      : null,
});

Deno.test({
  name: "stress/catalog-drill: failure injection across every upstream (seeded)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: true });
    try {
      const slugs = (await drillCatalog()).map((d) => d.slug);
      assert(slugs.length > 10, "catalog must have slugs");

      const baseSeed = envInt("STRESS_SEED", 20260905);
      const only = Deno.env.get("STRESS_CASE");
      const cases = only
        ? FAULT_CASES.filter((c) => c.id === only)
        : FAULT_CASES.filter((c) => SLOW || !c.slow);
      assert(cases.length > 0, `unknown STRESS_CASE ${only}`);
      const iterations = Math.max(envInt("STRESS_ITER", cases.length), only ? 1 : cases.length);

      const rows: Row[] = [];
      const startedAt = performance.now();

      for (let i = 0; i < iterations; i += 1) {
        const seed = baseSeed + i;
        const rng = new Prng(seed);
        const fc = i < cases.length ? cases[i] : rng.pick(cases);
        const userId = rng.uuid();
        const ip = rng.ip();
        const bearerKind =
          fc.bearer === "either" ? (rng.chance(0.7) ? "session" : "provider") : fc.bearer;
        const token =
          bearerKind === "session"
            ? h.mintSession(userId)
            : h.providerToken(userId, rng.pick(["google", "apple"] as const));
        const slug = rng.pick(slugs);
        const savedTruth = rng.chance(0.5);
        if (savedTruth) h.saved.add(`${userId}|${slug}`);
        const warm = fc.warm === "either" ? rng.chance(0.5) : fc.warm === "warm";
        const request = () =>
          userRequest(`/v1/catalog/drills/${encodeURIComponent(slug)}`, { token, ip });

        const violations: string[] = [];
        const observations: string[] = [];

        if (warm) {
          const pre = await h.run(request());
          if (pre.status !== 200)
            violations.push(`warm-up answered ${pre.status}: ${pre.bodyText}`);
        }

        h.faults = { [fc.upstream]: fc.fault };
        const faulted = await h.run(request(), deadlineOf(fc));
        h.faults = {};
        const released = h.releaseHung();
        if (fc.fault.kind === "delay") {
          await new Promise((resolve) => setTimeout(resolve, fc.fault.ms + 20));
        }
        let recovery = await h.run(request());
        if (fc.recovery === "fresh_token") {
          observations.push(
            `same bearer after the fault cleared → ${recovery.timedOut ? "stalled" : recovery.status} (${fc.note ?? ""})`,
          );
          if (STRICT && recovery.status !== 200)
            violations.push("strict: same bearer did not recover");
          const fresh = bearerKind === "session" ? h.mintSession(userId) : h.providerToken(userId);
          recovery = await h.run(
            userRequest(`/v1/catalog/drills/${encodeURIComponent(slug)}`, { token: fresh, ip }),
          );
        }

        let authFailCharged = 0;
        for (const [key, entry] of h.redis) {
          if (key.startsWith("rl:authfail:") && key.endsWith(`:${ip}`))
            authFailCharged += Number(entry.value);
        }

        // ── user-visible class of the faulted request ─────────────────────────
        if (faulted.timedOut) {
          if (fc.stalls) {
            observations.push(`stalled past ${deadlineOf(fc)}ms deadline (${fc.note ?? ""})`);
            if (STRICT) violations.push("strict: handler stalled past the harness deadline");
          } else {
            violations.push(`handler did not answer within ${deadlineOf(fc)}ms`);
          }
        } else {
          if (fc.stalls) {
            observations.push(
              `answered after ${Math.round(faulted.latencyMs)}ms with ${faulted.roundTrips.supabase} Supabase round trips (${fc.note ?? ""})`,
            );
            if (STRICT && faulted.latencyMs > 1_500)
              violations.push("strict: faulted request took longer than 1.5 s");
          }
          if (!fc.status.includes(faulted.status)) {
            violations.push(
              `status ${faulted.status} not in [${fc.status}] body=${faulted.bodyText.slice(0, 200)}`,
            );
          }
          if (faulted.status === 500) violations.push("500 (unhandled error) leaked to the user");
          if (faulted.bodyText.includes(LEAK))
            violations.push("upstream detail leaked into the body");
          if (!faulted.requestId) violations.push("x-request-id missing");
          if (faulted.status >= 400) {
            if (
              !isRecord(faulted.body) ||
              !isRecord(faulted.body.error) ||
              typeof faulted.body.error.message !== "string"
            ) {
              violations.push(
                `error body is not {error:{message}}: ${faulted.bodyText.slice(0, 120)}`,
              );
            }
            if (fc.message && faulted.message !== fc.message) {
              violations.push(`message "${faulted.message}" ≠ "${fc.message}"`);
            }
            if (fc.code && faulted.code !== fc.code)
              violations.push(`code ${faulted.code} ≠ ${fc.code}`);
            if (fc.retryAfter === "required" && faulted.retryAfter === null)
              violations.push("Retry-After missing on 503");
            if (fc.retryAfter === "absent" && faulted.retryAfter !== null) {
              observations.push(`Retry-After ${faulted.retryAfter} on a ${faulted.status}`);
            }
          }
          if (faulted.status === 200) {
            const body = faulted.body;
            const drill = isRecord(body) && isRecord(body.drill) ? body.drill : null;
            if (!drill || drill.slug !== slug)
              violations.push("200 body is not the requested drill");
            if (drill && "families" in drill) violations.push("catalog-internal `families` leaked");
            if (drill && "validation_state" in drill)
              violations.push("catalog-internal `validation_state` leaked");
            if (!fc.savedUnreliable && drill && drill.saved !== savedTruth) {
              violations.push(`saved=${String(drill.saved)} but truth=${savedTruth}`);
            }
            if (fc.savedUnreliable && drill && drill.saved !== savedTruth) {
              observations.push(
                `malformed PostgREST body produced saved=${String(drill.saved)} (truth ${savedTruth})`,
              );
            }
          }
          if (fc.upstream === "revenuecat" && faulted.roundTrips.revenuecat > 0) {
            violations.push("RevenueCat was called on the catalog route");
          }
          if (
            fc.upstream === "redis" &&
            faulted.status === 200 &&
            faulted.roundTrips.supabase > 3
          ) {
            violations.push(
              `${faulted.roundTrips.supabase} Supabase round trips while Redis was failing`,
            );
          }
          if (fc.id === "auth_user_hang" && faulted.latencyMs > 1_800) {
            violations.push(
              `hang was cut by the harness deadline, not AUTH_UPSTREAM_TIMEOUT_MS (${faulted.latencyMs}ms)`,
            );
          }
          if (fc.id === "auth_user_503_retry_after_7" && faulted.retryAfter !== "7") {
            observations.push(`upstream Retry-After 7 became ${faulted.retryAfter}`);
          }
        }
        if (fc.upstream === "auth_token" && faulted.status === 401 && fc.fault.kind !== "json") {
          observations.push(
            `Auth OUTAGE on provider-token path → 401; authfail charged=${authFailCharged}`,
          );
          if (STRICT && authFailCharged > 0)
            violations.push("strict: outage charged the auth-failure budget");
        } else if (
          fc.upstream === "auth_token" &&
          fc.fault.kind === "json" &&
          (fc.fault.status ?? 0) >= 500 &&
          faulted.status === 401
        ) {
          observations.push(
            `Auth OUTAGE (HTTP ${fc.fault.status}) on provider-token path → 401; authfail charged=${authFailCharged}`,
          );
          if (STRICT && authFailCharged > 0)
            violations.push("strict: outage charged the auth-failure budget");
        }
        if (fc.upstream === "auth_user" && fc.status.includes(503) && authFailCharged > 0) {
          violations.push(`Auth outage charged the auth-failure budget (${authFailCharged})`);
        }
        if (released > 0) observations.push(`released ${released} hung upstream call(s)`);

        // ── recovery: the very next healthy request must succeed ─────────────
        if (recovery.timedOut) violations.push("recovery request stalled");
        else {
          if (recovery.status !== 200)
            violations.push(
              `recovery answered ${recovery.status}: ${recovery.bodyText.slice(0, 160)}`,
            );
          const drill =
            isRecord(recovery.body) && isRecord(recovery.body.drill) ? recovery.body.drill : null;
          if (drill && drill.saved !== savedTruth)
            violations.push(`recovery saved=${String(drill.saved)} truth=${savedTruth}`);
          if (recovery.roundTrips.supabase > 3)
            violations.push(`recovery used ${recovery.roundTrips.supabase} Supabase round trips`);
          if (recovery.roundTrips.revenuecat > 0) violations.push("recovery called RevenueCat");
        }

        rows.push({
          i,
          seed,
          case: fc.id,
          upstream: fc.upstream,
          bearer: bearerKind,
          warm,
          slug,
          savedTruth,
          ip,
          faulted: summarize(faulted),
          recovery: summarize(recovery),
          authFailCharged,
          verdict: violations.length === 0 ? "HELD" : "BROKEN",
          violations,
          observations,
          replay: `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_CASE=${fc.id} deno test -A --no-check --config deno.json stress_catalog_drill_faults.test.ts`,
        });
      }

      const parked = await h.drain();
      const byCase: Record<
        string,
        { runs: number; held: number; statuses: Record<string, number> }
      > = {};
      for (const row of rows) {
        const entry = (byCase[row.case] ??= { runs: 0, held: 0, statuses: {} });
        entry.runs += 1;
        if (row.verdict === "HELD") entry.held += 1;
        const key = row.faulted.timedOut ? "stalled" : String(row.faulted.status);
        entry.statuses[key] = (entry.statuses[key] ?? 0) + 1;
      }
      const report = {
        lens: "failure-load/faults",
        route: "GET /v1/catalog/drills/:slug",
        strict: STRICT,
        slow: SLOW,
        deadlineOverrideMs: DEADLINE_OVERRIDE,
        baseSeed,
        iterations,
        distinctCases: Object.keys(byCase).length,
        held: rows.filter((r) => r.verdict === "HELD").length,
        broken: rows.filter((r) => r.verdict === "BROKEN").length,
        parkedRequestsDrained: parked,
        wallMs: Math.round(performance.now() - startedAt),
        byCase,
        observations: rows
          .filter((r) => r.observations.length > 0)
          .map((r) => ({
            seed: r.seed,
            case: r.case,
            faulted: r.faulted,
            observations: r.observations,
          })),
        rows,
        logsSample: h.logs.slice(0, 50),
      };
      const path = await writeArtifact("faults.json", report);
      const broken = rows.filter((r) => r.verdict === "BROKEN");
      assertEquals(
        broken.map((r) => `${r.case}@${r.seed}: ${r.violations.join("; ")}`),
        [],
        `${broken.length}/${rows.length} iterations BROKEN — see ${path}`,
      );
      assert(
        report.distinctCases >= (only ? 1 : 40),
        `only ${report.distinctCases} distinct fault cases`,
      );
    } finally {
      h.restore();
    }
  },
});

// The per-IP auth-failure budget (30 / 5 min) exists to slow credential
// guessing. A session bearer meeting an Auth OUTAGE gets a 503 and charges
// nothing (contract). The transitional provider-token branch turns the same
// outage into a 401, which DOES charge — 30 outage responses from one IP lock
// that IP out of every authenticated route for the rest of the window.
// Recorded as an observation; asserted only under STRESS_STRICT=1.
Deno.test({
  name: "stress/catalog-drill: an Auth outage must not exhaust the per-IP auth-failure budget",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: true });
    try {
      const slug = (await drillCatalog())[0].slug;
      const rng = new Prng(envInt("STRESS_SEED", 20260905) + 777);
      const outcomes: Record<string, unknown> = {};

      for (const path of ["session", "provider"] as const) {
        h.reset();
        const ip = rng.ip();
        const statuses: Record<string, number> = {};
        for (let n = 0; n < 30; n += 1) {
          const userId = rng.uuid();
          const token = path === "session" ? h.mintSession(userId) : h.providerToken(userId);
          h.faults =
            path === "session"
              ? { auth_user: { kind: "json", status: 503, body: { msg: "down" } } }
              : { auth_token: { kind: "json", status: 503, body: { msg: "down" } } };
          const res = await h.run(userRequest(`/v1/catalog/drills/${slug}`, { token, ip }));
          statuses[String(res.status)] = (statuses[String(res.status)] ?? 0) + 1;
        }
        h.faults = {};
        const healthyUser = rng.uuid();
        const afterOutage = await h.run(
          userRequest(`/v1/catalog/drills/${slug}`, { token: h.mintSession(healthyUser), ip }),
        );
        let charged = 0;
        for (const [key, entry] of h.redis) {
          if (key.startsWith("rl:authfail:") && key.endsWith(`:${ip}`))
            charged += Number(entry.value);
        }
        outcomes[path] = {
          ip,
          outageStatuses: statuses,
          authFailCharged: charged,
          healthyRequestAfterOutage: {
            status: afterOutage.status,
            retryAfter: afterOutage.retryAfter,
            message: afterOutage.message,
          },
        };
        if (path === "session") {
          assertEquals(statuses, { "503": 30 }, "session bearer: outage is a 503");
          assertEquals(charged, 0, "session bearer: outage charges nothing");
          assertEquals(
            afterOutage.status,
            200,
            "session bearer: IP is not locked out after the outage",
          );
        } else if (STRICT) {
          assertEquals(charged, 0, "strict: provider-token outage charged the auth-failure budget");
          assertEquals(
            afterOutage.status,
            200,
            "strict: IP locked out after a provider-token outage",
          );
        }
      }
      const artifact = await writeArtifact("authfail_outage.json", outcomes);
      console.log(`stress/catalog-drill authfail report → ${artifact}`);
    } finally {
      h.restore();
    }
  },
});
