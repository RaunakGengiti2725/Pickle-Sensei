// stress — FAILURE INJECTION for DELETE /v1/me/saved-drills/:slug against the
// REAL handler (../index.ts) with every upstream stubbed
// (stress_saved_drills_harness.ts). Redis is OFF in this file (per-isolate
// memory mode); stress_delete_saved_drill_redis.test.ts covers Upstash.
//
// Each fault case is run STRESS_ITER times (default 1); iteration i of case
// `id` is seeded from (STRESS_SEED, id, i) and derives its own user, bearer,
// slug and client IP, so every row of the JSON table replays with:
//
//   STRESS_SEED=<seed> STRESS_ITER=<n> deno test -A --no-check --config deno.json \
//     stress_delete_saved_drill_failure.test.ts --filter "<case id>"
//
// Contract under test (index.ts unsaveDrill + authenticate + serviceUnavailable,
// AGENTS.md "5xx bodies are generic"):
//   * a healthy DELETE answers 204 and the bookmark is gone; deleting an absent
//     bookmark is 204 too (idempotent);
//   * Supabase Auth REFUSING the bearer (400/401/403) is the ONLY upstream
//     outcome that becomes a 401; Auth down/slow/nonsense is 503 + Retry-After
//     and the same bearer works again once Auth recovers;
//   * PostgREST failing the DELETE is a generic 503 (no PGRST/SQLSTATE detail
//     in the body) and the same request succeeds once PostgREST recovers;
//   * RevenueCat is never consulted; the DELETE filter always carries the
//     authenticated user's id (RLS defence in depth).
//
// Cases whose `expect.class` is "defect" pin OBSERVED behaviour that violates
// the contract on the tree under test (the deviation is spelled out in `note`);
// fixing the route flips them deliberately.

import { assert, assertEquals } from "@std/assert";
import {
  deleteSavedDrillRequest,
  type FakeUser,
  type Fault,
  fnv1a,
  loadStressHarness,
  Prng,
  readBody,
  STRESS_ITER,
  STRESS_SEED,
  type Target,
  withCap,
  writeJson,
} from "./stress_saved_drills_harness.ts";

/** Auth deadline for this file (index.ts reads the env on every call). */
const AUTH_TIMEOUT_MS = 300;
// `deno test .` runs every file in ONE process: Deno.env is shared across test
// files, so the deadline override must be undone when this file is finished
// (the refresh/adjudication suites time their retries against the default).
const AUTH_TIMEOUT_ENV_BEFORE = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));
function restoreAuthTimeoutEnv(): void {
  if (AUTH_TIMEOUT_ENV_BEFORE === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", AUTH_TIMEOUT_ENV_BEFORE);
}
globalThis.addEventListener("unload", restoreAuthTimeoutEnv);
/** Wall-clock cap on one handler call; a call that does not settle is "unsettled". */
const HANDLER_CAP_MS = 2_500;

type Expect =
  | { class: "ok" }
  | { class: "retryable"; context: "Session verification" | "Drill unsave"; retryAfter: boolean }
  | { class: "refused" }
  | { class: "client"; status: number }
  | { class: "defect"; status: number | "unsettled"; note: string };

interface FaultCase {
  id: string;
  category: "auth" | "provider" | "db" | "rc" | "request";
  bearer: "session" | "provider" | "none" | "garbage" | "expired" | "unknown_session";
  fault?: Fault;
  /** Transform the seeded slug into the raw path segment (default: as is). */
  rawSlug?: (slug: string) => string;
  headers?: Record<string, string>;
  body?: string;
  /** The row the route is expected to delete when the slug is transformed. */
  effectiveSlug?: (slug: string) => string | null;
  expect: Expect;
}

const http = (
  target: Target,
  status: number,
  body: string,
  headers?: Record<string, string>,
): Fault => ({
  target,
  mode: { kind: "http", status, body, headers },
});

const GATEWAY_HTML = "<html><body><h1>502 Bad Gateway</h1></body></html>";

const CASES: FaultCase[] = [
  // ── Supabase Auth (GET /auth/v1/user) — session bearer ──────────────────
  {
    id: "auth_500_json",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 500, '{"code":500,"msg":"internal"}'),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_502_html",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 502, GATEWAY_HTML),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_503_retry_after",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 503, '{"msg":"maintenance"}', { "Retry-After": "7" }),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_504_empty",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 504, ""),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_429_retry_after",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 429, '{"code":429,"msg":"over_request_rate_limit"}', {
      "Retry-After": "3",
    }),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_404_json",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 404, '{"msg":"not found"}'),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_401_bad_jwt",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 401, '{"code":401,"error_code":"bad_jwt","msg":"invalid JWT"}'),
    expect: { class: "refused" },
  },
  {
    id: "auth_403_session_not_found",
    category: "auth",
    bearer: "session",
    fault: http(
      "auth_user",
      403,
      '{"code":403,"error_code":"session_not_found","msg":"Session from session_id claim in JWT does not exist"}',
    ),
    expect: { class: "refused" },
  },
  {
    id: "auth_403_user_banned",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 403, '{"code":403,"error_code":"user_banned","msg":"User is banned"}'),
    expect: { class: "refused" },
  },
  {
    id: "auth_400_invalid",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 400, '{"code":400,"msg":"bad request"}'),
    expect: { class: "refused" },
  },
  {
    id: "auth_hang_deadline",
    category: "auth",
    bearer: "session",
    fault: { target: "auth_user", mode: { kind: "hang" } },
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_network_throw_persistent",
    category: "auth",
    bearer: "session",
    fault: { target: "auth_user", mode: { kind: "throw" } },
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_network_throw_once_then_ok",
    category: "auth",
    bearer: "session",
    fault: { target: "auth_user", mode: { kind: "throw" }, firstN: 1 },
    expect: { class: "ok" },
  },
  {
    id: "auth_stream_reset_persistent",
    category: "auth",
    bearer: "session",
    fault: { target: "auth_user", mode: { kind: "stream_error", status: 200 } },
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_stream_reset_once_then_ok",
    category: "auth",
    bearer: "session",
    fault: { target: "auth_user", mode: { kind: "stream_error", status: 200 }, firstN: 1 },
    expect: { class: "ok" },
  },
  {
    id: "auth_200_invalid_json",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 200, "{not json"),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_200_empty_body",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 200, ""),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_200_html_page",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 200, GATEWAY_HTML),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_200_missing_id",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 200, '{"email":"x@example.com","app_metadata":{"provider":"google"}}'),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_200_array_body",
    category: "auth",
    bearer: "session",
    fault: http("auth_user", 200, "[]"),
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },
  {
    id: "auth_200_no_provider",
    category: "auth",
    bearer: "session",
    fault: http(
      "auth_user",
      200,
      '{"id":"00000000-0000-4000-8000-000000000001","email":"x@example.com","app_metadata":{"provider":"email"}}',
    ),
    expect: { class: "refused" },
  },
  {
    id: "auth_slow_under_deadline",
    category: "auth",
    bearer: "session",
    fault: { target: "auth_user", mode: { kind: "slow", delayMs: 120 } },
    expect: { class: "ok" },
  },
  {
    id: "auth_slow_over_deadline",
    category: "auth",
    bearer: "session",
    fault: {
      target: "auth_user",
      mode: { kind: "http", status: 200, body: "", delayMs: AUTH_TIMEOUT_MS + 400 },
    },
    expect: { class: "retryable", context: "Session verification", retryAfter: true },
  },

  // ── Supabase Auth (POST /auth/v1/token?grant_type=id_token) — transitional provider bearer ──
  { id: "provider_ok", category: "provider", bearer: "provider", expect: { class: "ok" } },
  {
    id: "provider_400_invalid_grant",
    category: "provider",
    bearer: "provider",
    fault: http("auth_token", 400, '{"error":"invalid_grant","error_description":"bad id token"}'),
    expect: { class: "refused" },
  },
  {
    id: "provider_500",
    category: "provider",
    bearer: "provider",
    fault: http("auth_token", 500, '{"code":500,"msg":"internal"}'),
    expect: {
      class: "defect",
      status: 401,
      note: "Auth 5xx on the transitional signInWithIdToken path is folded into a 401 (refused) instead of a retryable 503 — the app treats 401 as 'server refused your session' and signs the user out during an Auth outage; the auth-failure budget is also charged.",
    },
  },
  {
    id: "provider_503_retry_after",
    category: "provider",
    bearer: "provider",
    fault: http("auth_token", 503, '{"msg":"maintenance"}', { "Retry-After": "7" }),
    expect: {
      class: "defect",
      status: 401,
      note: "Auth 503 + Retry-After on the transitional path becomes a 401 without Retry-After.",
    },
  },
  {
    id: "provider_network_throw",
    category: "provider",
    bearer: "provider",
    fault: { target: "auth_token", mode: { kind: "throw" } },
    expect: {
      class: "defect",
      status: 401,
      note: "Auth unreachable (socket error) on the transitional path becomes a 401 — a network fault signs the user out.",
    },
  },
  {
    id: "provider_200_malformed",
    category: "provider",
    bearer: "provider",
    fault: http("auth_token", 200, "{not json"),
    expect: {
      class: "defect",
      status: 401,
      note: "A 2xx Auth answer the client cannot parse (gateway page, half-written body) becomes a 401 on the transitional path.",
    },
  },
  {
    id: "provider_hang_unbounded",
    category: "provider",
    bearer: "provider",
    fault: { target: "auth_token", mode: { kind: "hang" } },
    expect: {
      class: "defect",
      status: "unsettled",
      note: "signInWithIdToken (supabase-js) carries no deadline: a hung Auth socket hangs the request past the app's 15 s timeout (the session-bearer gateway answers 503 after AUTH_UPSTREAM_TIMEOUT_MS).",
    },
  },

  // ── PostgREST (DELETE /rest/v1/user_saved_drills) ───────────────────────
  {
    id: "db_500_json",
    category: "db",
    bearer: "session",
    fault: http(
      "rest_delete",
      500,
      '{"code":"XX000","message":"internal_error","details":null,"hint":null}',
    ),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_502_html",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 502, GATEWAY_HTML),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_503_schema_cache",
    category: "db",
    bearer: "session",
    fault: http(
      "rest_delete",
      503,
      '{"code":"PGRST002","message":"Could not query the database for the schema cache","details":null,"hint":null}',
      { "Retry-After": "5" },
    ),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_504_empty",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 504, ""),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_520_cloudflare",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 520, ""),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_429_retry_after",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 429, '{"message":"too many connections"}', { "Retry-After": "30" }),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_401_pgrst301_jwt_expired",
    category: "db",
    bearer: "session",
    fault: http(
      "rest_delete",
      401,
      '{"code":"PGRST301","message":"JWT expired","details":null,"hint":null}',
    ),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_403_42501_permission_denied",
    category: "db",
    bearer: "session",
    fault: http(
      "rest_delete",
      403,
      '{"code":"42501","message":"permission denied for table user_saved_drills","details":null,"hint":null}',
    ),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_404_pgrst205_table_missing",
    category: "db",
    bearer: "session",
    fault: http(
      "rest_delete",
      404,
      '{"code":"PGRST205","message":"Could not find the table public.user_saved_drills in the schema cache","details":null,"hint":null}',
    ),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_404_empty_body",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 404, ""),
    expect: {
      class: "defect",
      status: 204,
      note: "postgrest-js 2.112.4 maps a 404 with an EMPTY body to a 204 success (processResponse); the route answers 204 while the bookmark row still exists (a misrouted gateway 404 reads as 'unsaved').",
    },
  },
  {
    id: "db_404_array_body",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 404, "[]"),
    expect: {
      class: "defect",
      status: 204,
      note: "postgrest-js 2.112.4 maps a 404 whose body is a JSON array to a 200 success; the route answers 204 while the bookmark row still exists.",
    },
  },
  {
    id: "db_400_pgrst100_parse",
    category: "db",
    bearer: "session",
    fault: http(
      "rest_delete",
      400,
      '{"code":"PGRST100","message":"unexpected \\"e\\" expecting ...","details":null,"hint":null}',
    ),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_409_23503_fk",
    category: "db",
    bearer: "session",
    fault: http(
      "rest_delete",
      409,
      '{"code":"23503","message":"update or delete on table violates foreign key constraint","details":null,"hint":null}',
    ),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_200_garbage_body",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 200, "<html>ok</html>"),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_401_html_gateway",
    category: "db",
    bearer: "session",
    fault: http("rest_delete", 401, "<html>401 Authorization Required</html>"),
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_500_stream_reset",
    category: "db",
    bearer: "session",
    fault: { target: "rest_delete", mode: { kind: "stream_error", status: 500 } },
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_network_throw",
    category: "db",
    bearer: "session",
    fault: { target: "rest_delete", mode: { kind: "throw" } },
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_stream_reset",
    category: "db",
    bearer: "session",
    fault: { target: "rest_delete", mode: { kind: "stream_error", status: 200 } },
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_slow_600ms",
    category: "db",
    bearer: "session",
    fault: { target: "rest_delete", mode: { kind: "slow", delayMs: 600 } },
    expect: { class: "ok" },
  },
  {
    id: "db_500_after_delay",
    category: "db",
    bearer: "session",
    fault: {
      target: "rest_delete",
      mode: { kind: "http", status: 500, body: '{"message":"timeout"}', delayMs: 400 },
    },
    expect: { class: "retryable", context: "Drill unsave", retryAfter: false },
  },
  {
    id: "db_hang_unbounded",
    category: "db",
    bearer: "session",
    fault: { target: "rest_delete", mode: { kind: "hang" } },
    expect: {
      class: "defect",
      status: "unsettled",
      note: "userScopedClient() passes no fetch timeout/AbortSignal to postgrest-js: a hung PostgREST socket hangs the DELETE indefinitely (no 503, no Retry-After) until the edge runtime's wall-clock limit kills the isolate.",
    },
  },

  // ── RevenueCat — must never be on this path ─────────────────────────────
  {
    id: "rc_500_unreached",
    category: "rc",
    bearer: "session",
    fault: http("rc", 500, "upstream error"),
    expect: { class: "ok" },
  },
  {
    id: "rc_hang_unreached",
    category: "rc",
    bearer: "session",
    fault: { target: "rc", mode: { kind: "hang" } },
    expect: { class: "ok" },
  },

  // ── Request-level malformations (no upstream fault) ─────────────────────
  { id: "req_no_bearer", category: "request", bearer: "none", expect: { class: "refused" } },
  {
    id: "req_garbage_bearer",
    category: "request",
    bearer: "garbage",
    expect: { class: "refused" },
  },
  {
    id: "req_expired_session_bearer",
    category: "request",
    bearer: "expired",
    expect: { class: "refused" },
  },
  {
    id: "req_unknown_session_bearer",
    category: "request",
    bearer: "unknown_session",
    expect: { class: "refused" },
  },
  {
    id: "req_slug_percent_malformed",
    category: "request",
    bearer: "session",
    rawSlug: (s) => `${s}%ZZ`,
    effectiveSlug: () => null,
    expect: { class: "client", status: 400 },
  },
  {
    id: "req_slug_percent_truncated",
    category: "request",
    bearer: "session",
    rawSlug: (s) => `${s}%E0%A4%A`,
    effectiveSlug: () => null,
    expect: { class: "client", status: 400 },
  },
  {
    id: "req_slug_empty",
    category: "request",
    bearer: "session",
    rawSlug: () => "",
    effectiveSlug: () => null,
    expect: { class: "client", status: 404 },
  },
  {
    id: "req_slug_dotdot",
    category: "request",
    bearer: "session",
    rawSlug: () => "..",
    effectiveSlug: () => null,
    expect: { class: "client", status: 404 },
  },
  {
    id: "req_slug_encoded_slash",
    category: "request",
    bearer: "session",
    rawSlug: (s) => `${s}%2Fx`,
    effectiveSlug: (s) => `${s}/x`,
    expect: { class: "ok" },
  },
  {
    id: "req_slug_unicode",
    category: "request",
    bearer: "session",
    rawSlug: (s) => `${s}-${encodeURIComponent("ドリル")}`,
    effectiveSlug: (s) => `${s}-ドリル`,
    expect: { class: "ok" },
  },
  {
    id: "req_slug_sqlish",
    category: "request",
    bearer: "session",
    rawSlug: (s) => encodeURIComponent(`${s}' or 1=1;--`),
    effectiveSlug: (s) => `${s}' or 1=1;--`,
    expect: { class: "ok" },
  },
  {
    id: "req_slug_postgrest_operators",
    category: "request",
    bearer: "session",
    rawSlug: (s) => encodeURIComponent(`${s},eq.x)&user_id=eq.other`),
    effectiveSlug: (s) => `${s},eq.x)&user_id=eq.other`,
    expect: { class: "ok" },
  },
  {
    id: "req_slug_2000_chars",
    category: "request",
    bearer: "session",
    rawSlug: (s) => s + "x".repeat(2000),
    effectiveSlug: (s) => s + "x".repeat(2000),
    expect: { class: "ok" },
  },
  {
    id: "req_slug_uppercase",
    category: "request",
    bearer: "session",
    rawSlug: (s) => s.toUpperCase(),
    effectiveSlug: (s) => s.toUpperCase(),
    expect: { class: "ok" },
  },
  {
    id: "req_body_garbage_ignored",
    category: "request",
    bearer: "session",
    body: "{not json at all",
    headers: { "content-type": "application/json" },
    expect: { class: "ok" },
  },
  {
    id: "req_body_json_ignored",
    category: "request",
    bearer: "session",
    body: '{"slug":"someone-elses"}',
    headers: { "content-type": "application/json" },
    expect: { class: "ok" },
  },
  {
    id: "req_content_length_6mb",
    category: "request",
    bearer: "session",
    headers: { "content-length": String(6_000_000) },
    expect: { class: "client", status: 413 },
  },
  {
    id: "req_absent_bookmark_idempotent",
    category: "request",
    bearer: "session",
    effectiveSlug: () => null,
    expect: { class: "ok" },
  },
];

interface Row {
  case: string;
  category: string;
  iteration: number;
  seed: number;
  user: string;
  slug: string;
  ip: string;
  status: number | "unsettled";
  errorMessage: string | null;
  retryAfter: string | null;
  durationMs: number;
  upstream: Record<string, number>;
  faultedCalls: number;
  deleteFilterUserMatchesAuthed: boolean | null;
  rowDeleted: boolean | null;
  recovered: number | "n/a" | "unsettled";
  verdict: "HELD" | "BROKEN";
  expected: string;
  note?: string;
}

const rows: Row[] = [];

function caseSeed(id: string, iteration: number): number {
  return (STRESS_SEED ^ fnv1a(id) ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0;
}

function bearerFor(
  kind: FaultCase["bearer"],
  user: FakeUser,
  prng: Prng,
  fake: Awaited<ReturnType<typeof loadStressHarness>>["fake"],
): string | null {
  switch (kind) {
    case "session":
      return fake.sessionToken(user, prng);
    case "provider":
      return fake.providerToken(user, prng);
    case "none":
      return null;
    case "garbage":
      return "not-a-jwt-at-all";
    case "expired":
      return fake.sessionToken(user, prng, -120);
    case "unknown_session": {
      // Well-formed session JWT Supabase Auth does not know (logged out / deleted).
      const token = fake.sessionToken(user, prng);
      fake.sessions.delete(token);
      return token;
    }
  }
}

function assertGenericBody(text: string, caseId: string): void {
  for (const leak of [
    "PGRST",
    "42501",
    "23503",
    "XX000",
    "schema cache",
    "permission denied",
    "supabase.stress.test",
    "    at ",
    "TypeError",
    "connection reset",
  ]) {
    assert(!text.includes(leak), `${caseId}: 5xx body leaks internal detail "${leak}": ${text}`);
  }
}

async function runCase(fc: FaultCase, iteration: number): Promise<Row> {
  const h = await loadStressHarness({ redis: false });
  const { fake } = h;
  const seed = caseSeed(fc.id, iteration);
  const prng = new Prng(seed);
  const user = fake.newUser(prng);
  const slug = prng.slug();
  const ip = prng.ip();
  const token = bearerFor(fc.bearer, user, prng, fake);
  const effective = fc.effectiveSlug ? fc.effectiveSlug(slug) : slug;
  if (effective !== null) fake.seedSavedDrill(user.id, effective);
  const rawSlug = fc.rawSlug ? fc.rawSlug(slug) : slug;

  fake.reset();
  fake.arm(fc.fault ?? null);
  const request = deleteSavedDrillRequest({
    token,
    ip,
    rawSlug,
    body: fc.body ?? null,
    headers: fc.headers,
  });
  const started = performance.now();
  const response = await withCap(h.handler(request), HANDLER_CAP_MS);
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const upstream: Record<string, number> = {};
  for (const c of fake.calls) upstream[c.target] = (upstream[c.target] ?? 0) + 1;
  const faultedCalls = fake.calls.filter((c) => c.faulted).length;
  const filters = fake.deleteFilters;
  const row: Row = {
    case: fc.id,
    category: fc.category,
    iteration,
    seed,
    user: user.id,
    slug,
    ip,
    status: response ? response.status : "unsettled",
    errorMessage: null,
    retryAfter: response?.headers.get("Retry-After") ?? null,
    durationMs,
    upstream,
    faultedCalls,
    deleteFilterUserMatchesAuthed: filters.length
      ? filters.every((f) => f.user_id === user.id && f.bearerSub === user.id)
      : null,
    rowDeleted: effective === null ? null : !fake.hasSavedDrill(user.id, effective),
    recovered: "n/a",
    verdict: "HELD",
    expected:
      fc.expect.class === "defect"
        ? `defect:${fc.expect.status}`
        : fc.expect.class === "client"
          ? `client:${fc.expect.status}`
          : fc.expect.class,
  };
  const body = response ? await readBody(response) : { text: "", json: null };
  const err = body.json?.error;
  row.errorMessage =
    err && typeof err === "object"
      ? String((err as Record<string, unknown>).message ?? "")
      : body.text || null;

  // Invariants that hold for EVERY case.
  assertEquals(
    upstream.rc ?? 0,
    0,
    `${fc.id}: RevenueCat must never be consulted by DELETE saved-drills`,
  );
  assertEquals(upstream.rest_other ?? 0, 0, `${fc.id}: only user_saved_drills may be touched`);
  if (filters.length) {
    assert(
      row.deleteFilterUserMatchesAuthed,
      `${fc.id}: DELETE filter must be scoped to the authenticated user: ${JSON.stringify(filters)}`,
    );
    if (effective !== null) {
      assert(
        filters.every((f) => f.slug === effective),
        `${fc.id}: DELETE slug filter mismatch: ${JSON.stringify(filters)} vs ${effective}`,
      );
    }
  }

  const exp = fc.expect;
  fake.arm(null);
  switch (exp.class) {
    case "ok": {
      assertEquals(row.status, 204, `${fc.id}: expected 204, got ${row.status} ${body.text}`);
      assertEquals(body.text, "", `${fc.id}: 204 must have an empty body`);
      if (effective !== null)
        assert(row.rowDeleted, `${fc.id}: bookmark row must be gone after 204`);
      assertEquals(upstream.rest_delete ?? 0, 1, `${fc.id}: exactly one DELETE round trip`);
      break;
    }
    case "retryable": {
      assertEquals(row.status, 503, `${fc.id}: expected 503, got ${row.status} ${body.text}`);
      assertEquals(
        row.errorMessage,
        `${exp.context} is temporarily unavailable. Please try again.`,
      );
      assertGenericBody(body.text, fc.id);
      if (exp.retryAfter)
        assert(row.retryAfter !== null, `${fc.id}: 503 from Auth must carry Retry-After`);
      if (effective !== null)
        assertEquals(
          row.rowDeleted,
          false,
          `${fc.id}: a failed DELETE must not have removed the row`,
        );
      // Recoverability: the SAME request succeeds once the upstream is healthy.
      fake.reset();
      const again = await withCap(
        h.handler(
          deleteSavedDrillRequest({
            token,
            ip,
            rawSlug,
            body: fc.body ?? null,
            headers: fc.headers,
          }),
        ),
        HANDLER_CAP_MS,
      );
      row.recovered = again ? again.status : "unsettled";
      assertEquals(row.recovered, 204, `${fc.id}: same bearer + slug must succeed after recovery`);
      if (effective !== null)
        assert(!fake.hasSavedDrill(user.id, effective), `${fc.id}: row gone after recovery`);
      break;
    }
    case "refused": {
      assertEquals(row.status, 401, `${fc.id}: expected 401, got ${row.status} ${body.text}`);
      assertGenericBody(body.text, fc.id);
      assertEquals(
        upstream.rest_delete ?? 0,
        0,
        `${fc.id}: a refused bearer must never reach PostgREST`,
      );
      if (effective !== null) assertEquals(row.rowDeleted, false);
      // Recoverability: a FRESH valid session for the same user works.
      fake.reset();
      const fresh = fake.sessionToken(user, prng);
      const again = await withCap(
        h.handler(deleteSavedDrillRequest({ token: fresh, ip, rawSlug })),
        HANDLER_CAP_MS,
      );
      row.recovered = again ? again.status : "unsettled";
      assertEquals(row.recovered, 204, `${fc.id}: a fresh session for the same user must succeed`);
      break;
    }
    case "client": {
      assertEquals(
        row.status,
        exp.status,
        `${fc.id}: expected ${exp.status}, got ${row.status} ${body.text}`,
      );
      assertEquals(
        upstream.rest_delete ?? 0,
        0,
        `${fc.id}: a malformed request must not reach PostgREST`,
      );
      break;
    }
    case "defect": {
      row.verdict = "BROKEN";
      row.note = exp.note;
      assertEquals(
        row.status,
        exp.status,
        `${fc.id}: pinned defect changed shape — got ${row.status} ${body.text}; if the route was fixed, promote this case to its contract class`,
      );
      if (exp.status === 204 && effective !== null) {
        assertEquals(
          row.rowDeleted,
          false,
          `${fc.id}: the defect is a 204 WITHOUT the row being deleted`,
        );
      }
      if (exp.status === 401) {
        fake.reset();
        const fresh = fake.sessionToken(user, prng);
        const again = await withCap(
          h.handler(deleteSavedDrillRequest({ token: fresh, ip, rawSlug })),
          HANDLER_CAP_MS,
        );
        row.recovered = again ? again.status : "unsettled";
      }
      break;
    }
  }
  return row;
}

for (const fc of CASES) {
  Deno.test({
    name: `stress fault ${fc.id}`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      for (let i = 0; i < STRESS_ITER; i++) {
        rows.push(await runCase(fc, i));
      }
    },
  });
}

// ── Duplicate delivery / idempotency under concurrency ──────────────────────

Deno.test({
  name: "stress fault burst_duplicate_delete_same_slug",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    const { fake } = h;
    const lanes = 24;
    for (let i = 0; i < STRESS_ITER; i++) {
      const seed = caseSeed("burst_duplicate_delete_same_slug", i);
      const prng = new Prng(seed);
      const user = fake.newUser(prng);
      const token = fake.sessionToken(user, prng);
      const slug = prng.slug();
      const ip = prng.ip();
      fake.seedSavedDrill(user.id, slug);
      fake.reset();
      const started = performance.now();
      const responses = await Promise.all(
        Array.from({ length: lanes }, () =>
          h.handler(deleteSavedDrillRequest({ token, ip, rawSlug: slug })),
        ),
      );
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      const statuses = responses.map((r) => r.status);
      const authCalls = fake.callsTo("auth_user").length;
      const deletes = fake.callsTo("rest_delete").length;
      rows.push({
        case: "burst_duplicate_delete_same_slug",
        category: "request",
        iteration: i,
        seed,
        user: user.id,
        slug,
        ip,
        status: statuses.every((s) => s === 204)
          ? 204
          : (statuses.find((s) => s !== 204) as number),
        errorMessage: null,
        retryAfter: null,
        durationMs,
        upstream: { auth_user: authCalls, rest_delete: deletes, rc: fake.callsTo("rc").length },
        faultedCalls: 0,
        deleteFilterUserMatchesAuthed: fake.deleteFilters.every((f) => f.user_id === user.id),
        rowDeleted: !fake.hasSavedDrill(user.id, slug),
        recovered: "n/a",
        verdict: "HELD",
        expected: "ok",
        note: `${lanes} concurrent DELETEs of one slug: cold auth cache verified upstream ${authCalls}× (no in-flight coalescing), ${deletes} DELETE round trips`,
      });
      assert(
        statuses.every((s) => s === 204),
        `burst: every duplicate must be 204, got ${JSON.stringify(statuses)}`,
      );
      assert(!fake.hasSavedDrill(user.id, slug), "burst: row gone");
      assertEquals(deletes, lanes, "burst: one DELETE round trip per request");
      assertEquals(fake.callsTo("rc").length, 0);
    }
  },
});

// ── Budgets: per-user general limit and per-IP auth-failure limit ───────────

Deno.test({
  name: "stress fault user_budget_241st_delete_is_429",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    const { fake } = h;
    const seed = caseSeed("user_budget_241st_delete_is_429", 0);
    const prng = new Prng(seed);
    const user = fake.newUser(prng);
    const token = fake.sessionToken(user, prng);
    const ip = prng.ip();
    fake.reset();
    const statuses: number[] = [];
    for (let i = 0; i < 241; i++) {
      const r = await h.handler(deleteSavedDrillRequest({ token, ip, rawSlug: prng.slug() }));
      statuses.push(r.status);
      if (r.status === 429) {
        assert(r.headers.get("Retry-After"), "429 carries Retry-After");
        assertEquals(r.headers.get("RateLimit-Limit"), "240");
        await r.text();
      } else await r.text();
    }
    const first429 = statuses.indexOf(429);
    rows.push({
      case: "user_budget_241st_delete_is_429",
      category: "request",
      iteration: 0,
      seed,
      user: user.id,
      slug: "-",
      ip,
      status: statuses[240],
      errorMessage: null,
      retryAfter: null,
      durationMs: 0,
      upstream: {
        auth_user: fake.callsTo("auth_user").length,
        rest_delete: fake.callsTo("rest_delete").length,
      },
      faultedCalls: 0,
      deleteFilterUserMatchesAuthed: null,
      rowDeleted: null,
      recovered: "n/a",
      verdict: "HELD",
      expected: "client:429",
      note: `first 429 at request #${first429 + 1}; auth verified upstream ${fake.callsTo("auth_user").length}× across 241 requests (cache)`,
    });
    assertEquals(first429, 240, `241st request must be the first 429 (got index ${first429})`);
    assertEquals(fake.callsTo("rest_delete").length, 240, "the 429 must not reach PostgREST");
    assertEquals(
      fake.callsTo("auth_user").length,
      1,
      "one Auth verification per bearer per window",
    );
  },
});

Deno.test({
  name: "stress fault authfail_budget_31st_bad_bearer_is_429_pre_auth",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    const { fake } = h;
    const seed = caseSeed("authfail_budget", 0);
    const prng = new Prng(seed);
    const ip = prng.ip();
    fake.reset();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const ghost = fake.newUser(prng);
      const token = fake.sessionToken(ghost, prng);
      fake.sessions.delete(token); // Auth refuses it (403 session_not_found)
      const r = await h.handler(deleteSavedDrillRequest({ token, ip, rawSlug: prng.slug() }));
      statuses.push(r.status);
      await r.text();
    }
    rows.push({
      case: "authfail_budget_31st_bad_bearer_is_429_pre_auth",
      category: "request",
      iteration: 0,
      seed,
      user: "-",
      slug: "-",
      ip,
      status: statuses[30],
      errorMessage: null,
      retryAfter: null,
      durationMs: 0,
      upstream: {
        auth_user: fake.callsTo("auth_user").length,
        rest_delete: fake.callsTo("rest_delete").length,
      },
      faultedCalls: 0,
      deleteFilterUserMatchesAuthed: null,
      rowDeleted: null,
      recovered: "n/a",
      verdict: "HELD",
      expected: "client:429",
    });
    assert(
      statuses.slice(0, 30).every((s) => s === 401),
      `first 30 bad bearers are 401: ${JSON.stringify(statuses)}`,
    );
    assertEquals(statuses[30], 429, "31st bad bearer from the same IP is throttled");
    assertEquals(
      fake.callsTo("auth_user").length,
      30,
      "the throttled request never reaches Supabase Auth",
    );
    assertEquals(fake.callsTo("rest_delete").length, 0);
  },
});

Deno.test("stress fault: write JSON table (seed → outcome)", async () => {
  const held = rows.filter((r) => r.verdict === "HELD").length;
  const broken = rows.filter((r) => r.verdict === "BROKEN");
  const path = await writeJson("failure_injection", {
    unit: "route-delete-v1-me-saved-drills-slug",
    lens: "failure-load",
    seed: STRESS_SEED,
    iterationsPerCase: STRESS_ITER,
    faultCases: CASES.length,
    rows: rows.length,
    held,
    broken: broken.length,
    brokenCases: [...new Set(broken.map((r) => r.case))],
    replay: `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json stress_delete_saved_drill_failure.test.ts --filter "<case id>"`,
    table: rows,
  });
  console.log(
    `[stress] failure injection: ${rows.length} rows (${CASES.length} fault cases × ${STRESS_ITER} + budgets/burst), HELD=${held} BROKEN=${broken.length} → ${path}`,
  );
  assert(CASES.length >= 40, `lens requires ≥40 fault cases, have ${CASES.length}`);
});
