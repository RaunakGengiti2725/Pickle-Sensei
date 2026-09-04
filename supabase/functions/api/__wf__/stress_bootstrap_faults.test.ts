// stress — POST /v1/account/bootstrap — FAILURE INJECTION.
//
// Every upstream the route can reach (Supabase Auth id_token grant, PostgREST
// profiles GET/PATCH, the service-role credentials upsert, Apple's token
// endpoint, Upstash Redis, RevenueCat) is made to fail / time out / answer
// malformed IN TURN against the REAL handler, plus request-level malformations
// and the three rate-limit budgets. Each case records the user-visible class
// (what apps/mobile/src/account/bootstrap.ts does with the status) and whether
// the same client recovers once the fault clears.
//
// `expected` is the contract (a refused credential is the ONLY 401; upstream
// trouble is a retryable 5xx; a fault must answer inside the app's budget).
// `pinned` is today's behaviour where it differs — those cases are the
// findings (verdict BROKEN in the JSON table) and are asserted AS PINNED so the
// suite stays green and deterministic; fixing the route flips them to HELD.
//
//   deno test -A --no-check --config deno.json stress_bootstrap_faults.test.ts
//   STRESS_SEED=<n> replays every case (a case seed is STRESS_SEED ^ fnv1a(id)).
//
// Output: <STRESS_OUT_DIR>/faults.json (seed → outcome table).

import { assert, assertEquals } from "@std/assert";
import {
  type AppClass,
  bootstrapRequest,
  captureConsole,
  fnv1a,
  freshIp,
  type Harness,
  loadHarness,
  observe,
  type Observed,
  Prng,
  providerIdToken,
  STRESS_SEED,
  withFrozenClock,
  writeReport,
} from "./stress_bootstrap_harness.ts";

/** How long a faulted request may take before it is "pending" (the app's own
 * bootstrap abort is 15 s; refresh's upstream deadline is 6 s). */
const PENDING_AFTER_MS = 2_000;

interface Expectation {
  status: number | "pending";
  appClass: AppClass | "pending";
  code?: string | null;
}

interface FaultCase {
  id: string;
  group: string;
  title: string;
  provider: "google" | "apple";
  /** Provider stamp already on the profile row (mismatch → PATCH path). */
  profileProvider?: string;
  /** Apple request shape (default: protocol header + a valid one-use code). */
  apple?: { code?: unknown; header?: boolean; freshCodeOnRetry?: boolean };
  arm?: (h: Harness, ctx: CaseContext) => void;
  request?: (h: Harness, ctx: CaseContext) => Request;
  expected: Expectation;
  /** Today's behaviour when it differs from the contract. */
  pinned?: Expectation;
  /** A retry after the fault clears (same IP, same identity) must succeed. */
  recoverable: boolean;
  /** Supabase round trips expected on the faulted request (null = not checked). */
  supabaseRoundTrips?: number;
  /** Override of PENDING_AFTER_MS for faults whose legitimate answer is slow. */
  pendingAfterMs?: number;
  /** The faulted request must take at least this long (documents a stall). */
  minDurationMs?: number;
  note?: string;
}

interface CaseContext {
  seed: number;
  sub: string;
  userId: string;
  ip: string;
  token: string;
  appleCode: string | null;
}

const http = (status: number, body?: unknown, contentType?: string | null) => ({
  kind: "http" as const,
  status,
  body: body === undefined
    ? undefined
    : typeof body === "string"
    ? body
    : JSON.stringify(body),
  contentType,
});

const HTML_502 =
  "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>";

const gotrueError = (status: number, error: string, description = "forced") =>
  http(status, {
    error,
    error_description: description,
    error_code: error,
    code: status,
    msg: description,
  });

const pgrstError = (status: number, code: string, message: string) =>
  http(status, { code, message, details: null, hint: null });

const CASES: FaultCase[] = [
  // ── A. Supabase Auth — the id_token grant ─────────────────────────────────
  {
    id: "gotrue-400-invalid-grant",
    group: "gotrue",
    title: "GoTrue refuses the ID token (400 invalid_grant)",
    provider: "google",
    arm: (h) =>
      h.arm(
        "gotrue.id_token",
        gotrueError(400, "invalid_grant", "Bad ID token"),
      ),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-400-validation-failed",
    group: "gotrue",
    title: "GoTrue 400 validation_failed (unsupported provider/nonce)",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", gotrueError(400, "validation_failed")),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-401",
    group: "gotrue",
    title: "GoTrue 401",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", gotrueError(401, "bad_jwt")),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-403-provider-disabled",
    group: "gotrue",
    title: "GoTrue 403 provider disabled",
    provider: "apple",
    apple: { header: false, code: undefined },
    arm: (h) => h.arm("gotrue.id_token", gotrueError(403, "provider_disabled")),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-422",
    group: "gotrue",
    title: "GoTrue 422 (identity conflict)",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", gotrueError(422, "identity_already_exists")),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-404-html",
    group: "gotrue",
    title: "GoTrue 404 with an HTML body (misrouted gateway)",
    provider: "google",
    arm: (h) =>
      h.arm(
        "gotrue.id_token",
        http(404, "<html>not found</html>", "text/html"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    note:
      "an upstream that never saw the credential is reported as a refused credential",
  },
  {
    id: "gotrue-429",
    group: "gotrue",
    title: "GoTrue 429 over_request_rate_limit with Retry-After",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        ...gotrueError(429, "over_request_rate_limit"),
        headers: { "Retry-After": "7" },
      }),
    expected: { status: 429, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    note:
      "GoTrue throttling is reported as a refused credential; the app will not retry",
  },
  {
    id: "gotrue-500",
    group: "gotrue",
    title: "GoTrue 500 unexpected_failure",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", gotrueError(500, "unexpected_failure")),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-502-html",
    group: "gotrue",
    title: "GoTrue 502 HTML (edge proxy)",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", http(502, HTML_502, "text/html")),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-503",
    group: "gotrue",
    title: "GoTrue 503",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", gotrueError(503, "service_unavailable")),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-504-empty",
    group: "gotrue",
    title: "GoTrue 504 with an empty body",
    provider: "apple",
    arm: (h) => h.arm("gotrue.id_token", http(504, "", null)),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-connection-refused",
    group: "gotrue",
    title: "GoTrue unreachable (fetch rejects)",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", { kind: "throw" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-slow-1500ms",
    group: "gotrue",
    title: "GoTrue answers after 1.5 s",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", { kind: "delay", ms: 1_500 }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "gotrue-hang",
    group: "gotrue",
    title: "GoTrue never answers (socket hang)",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", { kind: "hang" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: "pending", appClass: "pending" },
    recoverable: true,
    note: "no upstream deadline on the bootstrap exchange (refresh has 6 s)",
  },
  {
    id: "gotrue-200-not-json",
    group: "gotrue",
    title: "GoTrue 200 with a non-JSON body",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", http(200, "<html>ok</html>", "text/html")),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-200-empty",
    group: "gotrue",
    title: "GoTrue 200 with an empty body",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", http(200, "", null)),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-200-empty-object",
    group: "gotrue",
    title: "GoTrue 200 {} (no session, no user)",
    provider: "google",
    arm: (h) => h.arm("gotrue.id_token", http(200, {})),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-200-missing-refresh-token",
    group: "gotrue",
    title: "GoTrue 200 session without refresh_token",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        kind: "custom",
        respond: async (_call, real) => {
          const body = (await (await real()).json()) as Record<string, unknown>;
          delete body.refresh_token;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-200-missing-expires-in",
    group: "gotrue",
    title: "GoTrue 200 session without expires_in",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        kind: "custom",
        respond: async (_call, real) => {
          const body = (await (await real()).json()) as Record<string, unknown>;
          delete body.expires_in;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    note: "supabase-js treats a session without expires_in as no session",
  },
  {
    id: "gotrue-200-empty-access-token",
    group: "gotrue",
    title: "GoTrue 200 with access_token ''",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        kind: "custom",
        respond: async (_call, real) => {
          const body = (await (await real()).json()) as Record<string, unknown>;
          body.access_token = "";
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
  },
  {
    id: "gotrue-200-user-without-id",
    group: "gotrue",
    title: "GoTrue 200 whose user carries no id",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        kind: "custom",
        respond: async (_call, real) => {
          const body = (await (await real()).json()) as Record<string, unknown>;
          delete (body.user as Record<string, unknown>).id;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
    note:
      "profile lookup for id=undefined finds no row → 503 after the 400 ms trigger-lag retry",
  },
  {
    id: "gotrue-200-no-app-metadata",
    group: "gotrue",
    title: "GoTrue 200 whose user has no app_metadata",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        kind: "custom",
        respond: async (_call, real) => {
          const body = (await (await real()).json()) as Record<string, unknown>;
          delete (body.user as Record<string, unknown>).app_metadata;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "gotrue-200-null-email",
    group: "gotrue",
    title: "GoTrue 200 with email null (Apple private relay withheld)",
    provider: "apple",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        kind: "custom",
        respond: async (_call, real) => {
          const body = (await (await real()).json()) as Record<string, unknown>;
          (body.user as Record<string, unknown>).email = null;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "gotrue-200-expires-at-string",
    group: "gotrue",
    title: "GoTrue 200 with expires_at as a string",
    provider: "google",
    arm: (h) =>
      h.arm("gotrue.id_token", {
        kind: "custom",
        respond: async (_call, real) => {
          const body = (await (await real()).json()) as Record<string, unknown>;
          body.expires_at = String(body.expires_at);
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    expected: { status: 200, appClass: "ok" },
    pinned: { status: 200, appClass: "invalid_response(retryable)" },
    recoverable: true,
    note:
      "expiresAt is passed through untyped; the app then drops the session tokens and bears the provider token for this run (nothing persisted)",
  },

  // ── B. PostgREST — profiles GET ───────────────────────────────────────────
  {
    id: "pgrst-get-401-jwt",
    group: "postgrest.get",
    title: "PostgREST 401 PGRST301 (JWT rejected)",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        pgrstError(401, "PGRST301", "JWT expired"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "pgrst-get-403-42501",
    group: "postgrest.get",
    title: "PostgREST 403 42501 permission denied",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        pgrstError(403, "42501", "permission denied for table profiles"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "pgrst-get-404",
    group: "postgrest.get",
    title: "PostgREST 404 (schema cache stale / table missing)",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        pgrstError(404, "PGRST205", "Could not find the table"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "pgrst-get-0-rows-persistent",
    group: "postgrest.get",
    title: "profile row never appears (signup trigger did not run)",
    provider: "google",
    arm: (h, ctx) => h.profileLag.set(ctx.userId, 99),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
    supabaseRoundTrips: 3,
    note: "one 400 ms retry then 503",
  },
  {
    id: "pgrst-get-trigger-lag-1",
    group: "postgrest.get",
    title: "profile row appears on the second read (trigger lag)",
    provider: "google",
    arm: (h, ctx) => h.profileLag.set(ctx.userId, 1),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    supabaseRoundTrips: 3,
  },
  {
    id: "pgrst-get-500",
    group: "postgrest.get",
    title: "PostgREST 500",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        pgrstError(500, "XX000", "internal error"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "pgrst-get-502-html",
    group: "postgrest.get",
    title: "PostgREST 502 HTML",
    provider: "google",
    arm: (h) =>
      h.arm("postgrest.profiles.get", http(502, HTML_502, "text/html")),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "pgrst-get-503",
    group: "postgrest.get",
    title: "PostgREST 503 (connection pool exhausted) on every attempt",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        pgrstError(503, "PGRST001", "Could not query the database"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
    supabaseRoundTrips: 5,
    pendingAfterMs: 9_000,
    minDurationMs: 6_900,
    note:
      "postgrest-js 2.112.4 retries GET on 503/520/network errors 3× with 1 s, 2 s, 4 s backoff → the 503 reaches the app after ~7 s",
  },
  {
    id: "pgrst-get-503-retry-after-3",
    group: "postgrest.get",
    title: "PostgREST 503 with Retry-After: 3 (once)",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        {
          ...pgrstError(503, "PGRST001", "Could not query the database"),
          headers: { "Retry-After": "3" },
        },
        1,
      ),
    expected: { status: 200, appClass: "ok" },
    pinned: { status: "pending", appClass: "pending" },
    recoverable: true,
    note:
      "postgrest-js sleeps the upstream's Retry-After verbatim (no cap; the profile read carries no abort signal) — a Retry-After of 30 holds the bootstrap 30 s, past the app's 15 s budget",
  },
  {
    id: "pgrst-get-503-once",
    group: "postgrest.get",
    title: "PostgREST 503 once, healthy on the library's retry",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        pgrstError(503, "PGRST001", "Could not query the database"),
        1,
      ),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    supabaseRoundTrips: 3,
    minDurationMs: 950,
  },
  {
    id: "pgrst-get-connection-refused",
    group: "postgrest.get",
    title: "PostgREST unreachable (fetch rejects) on every attempt",
    provider: "google",
    arm: (h) => h.arm("postgrest.profiles.get", { kind: "throw" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
    supabaseRoundTrips: 5,
    pendingAfterMs: 9_000,
    minDurationMs: 6_900,
  },
  {
    id: "pgrst-get-hang",
    group: "postgrest.get",
    title: "PostgREST never answers",
    provider: "google",
    arm: (h) => h.arm("postgrest.profiles.get", { kind: "hang" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: "pending", appClass: "pending" },
    recoverable: true,
    note: "no deadline on the profile read",
  },
  {
    id: "pgrst-get-slow-1500ms",
    group: "postgrest.get",
    title: "PostgREST answers after 1.5 s",
    provider: "google",
    arm: (h) => h.arm("postgrest.profiles.get", { kind: "delay", ms: 1_500 }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "pgrst-get-200-not-json",
    group: "postgrest.get",
    title: "PostgREST 200 with a non-JSON body",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        http(200, "<html>ok</html>", "text/html"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "pgrst-get-200-array",
    group: "postgrest.get",
    title: "PostgREST 200 with an array where one object was requested",
    provider: "google",
    arm: (h, ctx) =>
      h.arm("postgrest.profiles.get", http(200, [h.profiles.get(ctx.userId)])),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    note: "postgrest-js unwraps a one-element array for maybeSingle()",
  },
  {
    id: "pgrst-get-200-row-missing-fields",
    group: "postgrest.get",
    title: "PostgREST 200 row with onboarding_state garbage and no email",
    provider: "google",
    arm: (h, ctx) =>
      h.arm(
        "postgrest.profiles.get",
        http(200, { id: ctx.userId, onboarding_state: "???" }),
      ),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    note: "onboardingState falls back to pending; email null",
  },
  {
    id: "pgrst-get-200-foreign-row",
    group: "postgrest.get",
    title: "PostgREST 200 with ANOTHER user's row (RLS bypassed upstream)",
    provider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.get",
        http(200, {
          id: "99999999-9999-4999-8999-999999999999",
          email: "someone-else@example.com",
          onboarding_state: "complete",
          provider: "google",
        }),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: 200, appClass: "ok" },
    recoverable: true,
    note:
      "the returned account id is the row's id, not the verified user's — no cross-check against authed.id",
  },

  // ── C. PostgREST — the provider stamp PATCH ───────────────────────────────
  {
    id: "pgrst-patch-ok",
    group: "postgrest.patch",
    title: "provider mismatch → PATCH profiles succeeds",
    provider: "google",
    profileProvider: "unknown",
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    supabaseRoundTrips: 3,
  },
  {
    id: "pgrst-patch-500",
    group: "postgrest.patch",
    title: "provider stamp PATCH fails 500",
    provider: "google",
    profileProvider: "unknown",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.patch",
        pgrstError(500, "XX000", "internal error"),
      ),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    supabaseRoundTrips: 3,
    note:
      "the PATCH result is not checked: bootstrap succeeds, the stamp stays stale",
  },
  {
    id: "pgrst-patch-403-42501",
    group: "postgrest.patch",
    title: "provider stamp PATCH refused 42501",
    provider: "apple",
    profileProvider: "google",
    arm: (h) =>
      h.arm(
        "postgrest.profiles.patch",
        pgrstError(403, "42501", "permission denied"),
      ),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    supabaseRoundTrips: 4,
  },
  {
    id: "pgrst-patch-connection-refused",
    group: "postgrest.patch",
    title: "provider stamp PATCH fetch rejects",
    provider: "google",
    profileProvider: "unknown",
    arm: (h) => h.arm("postgrest.profiles.patch", { kind: "throw" }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "pgrst-patch-hang",
    group: "postgrest.patch",
    title: "provider stamp PATCH never answers",
    provider: "google",
    profileProvider: "unknown",
    arm: (h) => h.arm("postgrest.profiles.patch", { kind: "hang" }),
    expected: { status: 200, appClass: "ok" },
    pinned: { status: "pending", appClass: "pending" },
    recoverable: true,
    note:
      "a best-effort write is awaited without a deadline and blocks the response",
  },

  // ── D. Apple — authorization-code exchange ────────────────────────────────
  {
    id: "apple-ok",
    group: "apple",
    title: "Apple exchange succeeds, refresh token stored encrypted",
    provider: "apple",
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    supabaseRoundTrips: 3,
  },
  {
    id: "apple-400-invalid-grant",
    group: "apple",
    title: "Apple 400 invalid_grant",
    provider: "apple",
    arm: (h) => h.arm("apple.token", http(400, { error: "invalid_grant" })),
    expected: {
      status: 401,
      appClass: "rejected(non-retryable)",
      code: "auth.apple_authorization_invalid",
    },
    recoverable: true,
  },
  {
    id: "apple-400-invalid-client",
    group: "apple",
    title: "Apple 400 invalid_client (our client secret)",
    provider: "apple",
    arm: (h) => h.arm("apple.token", http(400, { error: "invalid_client" })),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-400-empty",
    group: "apple",
    title: "Apple 400 with an empty body",
    provider: "apple",
    arm: (h) => h.arm("apple.token", http(400, "", null)),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-401",
    group: "apple",
    title: "Apple 401",
    provider: "apple",
    arm: (h) =>
      h.arm("apple.token", http(401, { error: "unauthorized_client" })),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-429",
    group: "apple",
    title: "Apple 429",
    provider: "apple",
    arm: (h) => h.arm("apple.token", http(429, "", null)),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-500",
    group: "apple",
    title: "Apple 500",
    provider: "apple",
    arm: (h) => h.arm("apple.token", http(500, { error: "server_error" })),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-503-html",
    group: "apple",
    title: "Apple 503 HTML",
    provider: "apple",
    arm: (h) => h.arm("apple.token", http(503, HTML_502, "text/html")),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-connection-refused",
    group: "apple",
    title: "Apple unreachable (fetch rejects)",
    provider: "apple",
    arm: (h) => h.arm("apple.token", { kind: "throw" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-hang",
    group: "apple",
    title:
      "Apple never answers (15 s provider deadline in externalAccounts.ts)",
    provider: "apple",
    arm: (h) => h.arm("apple.token", { kind: "hang" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: "pending", appClass: "pending" },
    recoverable: true,
    note:
      "REQUEST_TIMEOUT_MS is 15 s — equal to the app's whole bootstrap budget, so the app times out first",
  },
  {
    id: "apple-200-not-json",
    group: "apple",
    title: "Apple 200 non-JSON",
    provider: "apple",
    arm: (h) => h.arm("apple.token", http(200, "<html>ok</html>", "text/html")),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-200-missing-refresh-token",
    group: "apple",
    title: "Apple 200 without refresh_token",
    provider: "apple",
    arm: (h, ctx) =>
      h.arm(
        "apple.token",
        http(200, {
          id_token: providerIdToken("apple", ctx.sub),
          token_type: "Bearer",
        }),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-200-other-subject",
    group: "apple",
    title: "Apple 200 whose id_token names another subject",
    provider: "apple",
    arm: (h) =>
      h.arm(
        "apple.token",
        http(200, {
          refresh_token: "rt-x",
          id_token: providerIdToken("apple", "someone.else"),
        }),
      ),
    expected: {
      status: 401,
      appClass: "rejected(non-retryable)",
      code: "auth.apple_authorization_mismatch",
    },
    recoverable: true,
  },
  {
    id: "apple-200-garbage-id-token",
    group: "apple",
    title: "Apple 200 with an unparseable id_token",
    provider: "apple",
    arm: (h) =>
      h.arm(
        "apple.token",
        http(200, { refresh_token: "rt-x", id_token: "nope" }),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "apple-code-reused",
    group: "apple",
    title: "authorization code already spent (replayed bootstrap)",
    provider: "apple",
    arm: (h, ctx) => {
      const grant = h.appleCodes.get(ctx.appleCode!);
      if (grant) grant.spent = true;
    },
    expected: {
      status: 401,
      appClass: "rejected(non-retryable)",
      code: "auth.apple_authorization_invalid",
    },
    recoverable: true,
  },
  {
    id: "apple-code-missing-with-protocol",
    group: "apple",
    title: "protocol header but no authorization code",
    provider: "apple",
    apple: { code: undefined, header: true },
    expected: {
      status: 400,
      appClass: "unavailable(non-retryable)",
      code: "auth.apple_authorization_code_required",
    },
    recoverable: true,
  },
  {
    id: "apple-legacy-no-code",
    group: "apple",
    title: "legacy app: no code, no protocol header",
    provider: "apple",
    apple: { code: undefined, header: false },
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    supabaseRoundTrips: 2,
  },
  {
    id: "apple-code-too-long",
    group: "apple",
    title: "authorization code of 4097 chars",
    provider: "apple",
    apple: { code: "x".repeat(4_097), header: true },
    expected: {
      status: 400,
      appClass: "unavailable(non-retryable)",
      code: "auth.apple_authorization_code_required",
    },
    recoverable: true,
  },
  {
    id: "apple-code-whitespace",
    group: "apple",
    title: "authorization code of whitespace",
    provider: "apple",
    apple: { code: "   ", header: true },
    expected: {
      status: 400,
      appClass: "unavailable(non-retryable)",
      code: "auth.apple_authorization_code_required",
    },
    recoverable: true,
  },
  {
    id: "apple-code-number",
    group: "apple",
    title: "authorization code is a number",
    provider: "apple",
    apple: { code: 12345, header: true },
    expected: {
      status: 400,
      appClass: "unavailable(non-retryable)",
      code: "auth.apple_authorization_code_required",
    },
    recoverable: true,
  },

  // ── E. Service-role credentials upsert ────────────────────────────────────
  {
    id: "creds-500",
    group: "postgrest.credentials",
    title: "credentials upsert 500",
    provider: "apple",
    arm: (h) =>
      h.arm(
        "postgrest.credentials.upsert",
        pgrstError(500, "XX000", "internal error"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
    note:
      "the Apple code was spent; the retry needs a fresh Sign in with Apple",
  },
  {
    id: "creds-403-42501",
    group: "postgrest.credentials",
    title: "credentials upsert 42501 (grant missing)",
    provider: "apple",
    arm: (h) =>
      h.arm(
        "postgrest.credentials.upsert",
        pgrstError(403, "42501", "permission denied"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "creds-409",
    group: "postgrest.credentials",
    title: "credentials upsert 409 (constraint)",
    provider: "apple",
    arm: (h) =>
      h.arm(
        "postgrest.credentials.upsert",
        pgrstError(409, "23505", "duplicate key"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "creds-connection-refused",
    group: "postgrest.credentials",
    title: "credentials upsert fetch rejects",
    provider: "apple",
    arm: (h) => h.arm("postgrest.credentials.upsert", { kind: "throw" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
  },
  {
    id: "creds-hang",
    group: "postgrest.credentials",
    title: "credentials upsert never answers",
    provider: "apple",
    arm: (h) => h.arm("postgrest.credentials.upsert", { kind: "hang" }),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    pinned: { status: "pending", appClass: "pending" },
    recoverable: true,
  },
  {
    id: "creds-200-not-json",
    group: "postgrest.credentials",
    title: "credentials upsert 200 with a non-JSON body",
    provider: "apple",
    arm: (h) =>
      h.arm(
        "postgrest.credentials.upsert",
        http(200, "<html>ok</html>", "text/html"),
      ),
    expected: { status: 503, appClass: "unavailable(retryable)" },
    recoverable: true,
    note:
      "an unconfirmable write is refused (the Apple code is spent; the retry needs a fresh code)",
  },

  // ── F. Upstash Redis (shared cache + rate limits) ─────────────────────────
  {
    id: "redis-401",
    group: "redis",
    title: "Redis 401 (token rotated)",
    provider: "google",
    arm: (h) => h.arm("redis", http(401, { error: "Unauthorized" })),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-500",
    group: "redis",
    title: "Redis 500",
    provider: "google",
    arm: (h) => h.arm("redis", http(500, { error: "ERR" })),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-connection-refused",
    group: "redis",
    title: "Redis unreachable",
    provider: "google",
    arm: (h) => h.arm("redis", { kind: "throw" }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-timeout-1300ms",
    group: "redis",
    title: "Redis stalls past REDIS_TIMEOUT_MS (1.2 s) on every pipeline",
    provider: "google",
    arm: (h) => h.arm("redis", { kind: "delay", ms: 1_300 }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    pendingAfterMs: 6_000,
    minDurationMs: 3_500,
    note: "three sequential pipelines × 1.2 s abort → ~3.6 s bootstrap",
  },
  {
    id: "redis-200-not-array",
    group: "redis",
    title: "Redis 200 with a non-array body",
    provider: "google",
    arm: (h) => h.arm("redis", http(200, { result: "OK" })),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-200-not-json",
    group: "redis",
    title: "Redis 200 non-JSON",
    provider: "google",
    arm: (h) => h.arm("redis", http(200, "<html>ok</html>", "text/html")),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-200-command-error",
    group: "redis",
    title: "Redis 200 with a per-command error (WRONGTYPE)",
    provider: "google",
    arm: (h) =>
      h.arm(
        "redis",
        http(200, [{ error: "WRONGTYPE" }, { error: "WRONGTYPE" }]),
      ),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-200-null-results",
    group: "redis",
    title: "Redis 200 with null results (INCR lost)",
    provider: "google",
    arm: (h) => h.arm("redis", http(200, [{ result: null }, { result: null }])),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-200-nan-count",
    group: "redis",
    title: "Redis 200 with a non-numeric counter",
    provider: "google",
    arm: (h) => h.arm("redis", http(200, [{ result: "lots" }, { result: 1 }])),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "redis-200-huge-count",
    group: "redis",
    title: "Redis 200 reporting the IP window at 10^9 hits",
    provider: "google",
    arm: (h) =>
      h.arm("redis", http(200, [{ result: 1_000_000_000 }, { result: 1 }])),
    expected: {
      status: 429,
      appClass: "unavailable(retryable)",
      code: "rate_limited",
    },
    recoverable: true,
    note:
      "a reachable Redis is trusted for counts (by design: the shared limit)",
  },
  {
    id: "redis-flap-first-pipeline",
    group: "redis",
    title: "Redis fails the first pipeline only, recovers mid-request",
    provider: "google",
    arm: (h) => h.arm("redis", { kind: "throw" }, 1),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },

  // ── G. RevenueCat (never on this route) ───────────────────────────────────
  {
    id: "revenuecat-500",
    group: "revenuecat",
    title: "RevenueCat 500 — bootstrap must not depend on it",
    provider: "google",
    arm: (h) => h.arm("revenuecat", http(500, "")),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "revenuecat-unreachable",
    group: "revenuecat",
    title: "RevenueCat unreachable — bootstrap must not depend on it",
    provider: "apple",
    arm: (h) => h.arm("revenuecat", { kind: "throw" }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },

  // ── H. Request-level malformations ────────────────────────────────────────
  {
    id: "req-no-authorization",
    group: "request",
    title: "no Authorization header",
    provider: "google",
    request: (_h, ctx) => bootstrapRequest({ token: null, ip: ctx.ip }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-basic-authorization",
    group: "request",
    title: "Authorization: Basic",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({ authorization: "Basic dXNlcjpwdw==", ip: ctx.ip }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-bearer-opaque",
    group: "request",
    title: "Bearer that is not a JWT",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: "ya29.opaque-google-access-token",
        ip: ctx.ip,
      }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-bearer-two-segments",
    group: "request",
    title: "JWT with two segments",
    provider: "google",
    request: (_h, ctx) => bootstrapRequest({ token: "aaa.bbb", ip: ctx.ip }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-bearer-bad-base64",
    group: "request",
    title: "JWT payload is not base64",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({ token: "aaa.!!!!.ccc", ip: ctx.ip }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-bearer-payload-array",
    group: "request",
    title: "JWT payload is a JSON array",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({ token: `aaa.${btoa("[1,2]")}.ccc`, ip: ctx.ip }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-bearer-payload-null",
    group: "request",
    title: "JWT payload is null",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({ token: `aaa.${btoa("null")}.ccc`, ip: ctx.ip }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-iss-unknown",
    group: "request",
    title: "issuer is neither Google nor Apple",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, {
          extra: { iss: "https://login.microsoftonline.com/x" },
        }),
        ip: ctx.ip,
      }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-iss-trailing-slash",
    group: "request",
    title: "issuer with a trailing slash",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, {
          extra: { iss: "https://accounts.google.com/" },
        }),
        ip: ctx.ip,
      }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-iss-no-scheme",
    group: "request",
    title: "Google issuer without scheme (accounts.google.com)",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, {
          extra: { iss: "accounts.google.com" },
        }),
        ip: ctx.ip,
      }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "req-exp-past",
    group: "request",
    title: "ID token expired (exp in the past)",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, { ttlSeconds: -5 }),
        ip: ctx.ip,
      }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-exp-string",
    group: "request",
    title: "exp claim is a string (not checked locally; GoTrue decides)",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, { extra: { exp: "1" } }),
        ip: ctx.ip,
      }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "req-sub-missing",
    group: "request",
    title: "no sub claim",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, {
          extra: { sub: undefined },
        }),
        ip: ctx.ip,
      }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-sub-empty",
    group: "request",
    title: "empty sub claim",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, { extra: { sub: "" } }),
        ip: ctx.ip,
      }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-sub-number",
    group: "request",
    title: "numeric sub claim",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", ctx.sub, { extra: { sub: 12345 } }),
        ip: ctx.ip,
      }),
    expected: { status: 401, appClass: "rejected(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-sub-64kb",
    group: "request",
    title: "64 KiB sub claim (oversized bearer)",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: providerIdToken("google", "s".repeat(65_536)),
        ip: ctx.ip,
      }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
    note: "forwarded to GoTrue as-is; no bearer size cap on this route",
  },
  {
    id: "req-body-not-json-apple",
    group: "request",
    title: "Apple bootstrap with a non-JSON body",
    provider: "apple",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: ctx.token,
        ip: ctx.ip,
        rawBody: "{not json",
        headers: {
          "Content-Type": "application/json",
          "X-Apple-Revocation-Protocol": "1",
        },
      }),
    expected: {
      status: 400,
      appClass: "unavailable(non-retryable)",
      code: "auth.apple_authorization_code_required",
    },
    recoverable: true,
  },
  {
    id: "req-body-garbage-google",
    group: "request",
    title: "Google bootstrap with a garbage body (ignored)",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: ctx.token,
        ip: ctx.ip,
        rawBody: "\u0000\u0001garbage",
      }),
    expected: { status: 200, appClass: "ok" },
    recoverable: true,
  },
  {
    id: "req-content-length-too-large",
    group: "request",
    title: "Content-Length above the 5 MB cap",
    provider: "google",
    request: (_h, ctx) =>
      bootstrapRequest({
        token: ctx.token,
        ip: ctx.ip,
        body: {},
        headers: { "Content-Length": "5000001" },
      }),
    expected: { status: 413, appClass: "unavailable(non-retryable)" },
    recoverable: true,
    supabaseRoundTrips: 0,
  },
  {
    id: "req-apple-body-5mb-plus-1",
    group: "request",
    title: "Apple bootstrap streaming a 5 MB + 1 body without Content-Length",
    provider: "apple",
    request: (_h, ctx) => {
      const chunk = new TextEncoder().encode("x".repeat(1_000_001));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"appleAuthorizationCode":"'),
          );
          for (let i = 0; i < 5; i++) controller.enqueue(chunk);
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      });
      return bootstrapRequest({
        token: ctx.token,
        ip: ctx.ip,
        rawBody: stream,
        headers: {
          "Content-Type": "application/json",
          "X-Apple-Revocation-Protocol": "1",
        },
      });
    },
    expected: { status: 413, appClass: "unavailable(non-retryable)" },
    recoverable: true,
  },

  // ── I. Rate-limit budgets ─────────────────────────────────────────────────
  {
    id: "rl-user-241st",
    group: "ratelimit",
    title: "241st bootstrap of one user inside a minute",
    provider: "google",
    arm: (h, ctx) => {
      // 240 successful bootstraps first (same identity, same IP).
      preload.push(async () => {
        for (let i = 0; i < 240; i++) {
          const res = await h.handler(
            bootstrapRequest({ token: ctx.token, ip: ctx.ip }),
          );
          await res.body?.cancel();
          if (res.status !== 200) {
            throw new Error(`preload ${i} → ${res.status}`);
          }
        }
      });
    },
    expected: {
      status: 429,
      appClass: "unavailable(retryable)",
      code: "rate_limited",
    },
    recoverable: false,
    supabaseRoundTrips: 1,
    note:
      "the exchange still happens (a session is minted) before the user budget is checked",
  },
  {
    id: "rl-authfail-30-bad-tokens",
    group: "ratelimit",
    title: "30 refused tokens from one IP lock the IP out",
    provider: "google",
    arm: (h, ctx) => {
      preload.push(async () => {
        for (let i = 0; i < 30; i++) {
          const res = await h.handler(
            bootstrapRequest({ token: "not-a-jwt", ip: ctx.ip }),
          );
          await res.body?.cancel();
          if (res.status !== 401) {
            throw new Error(`preload ${i} → ${res.status}`);
          }
        }
      });
    },
    expected: {
      status: 429,
      appClass: "unavailable(retryable)",
      code: "rate_limited",
    },
    recoverable: false,
    supabaseRoundTrips: 0,
  },
  {
    id: "rl-authfail-charged-by-gotrue-outage",
    group: "ratelimit",
    title: "30 GoTrue 503s from one IP lock the IP out AFTER GoTrue recovers",
    provider: "google",
    arm: (h, ctx) => {
      h.arm("gotrue.id_token", gotrueError(503, "service_unavailable"), 30);
      preload.push(async () => {
        for (let i = 0; i < 30; i++) {
          const res = await h.handler(
            bootstrapRequest({ token: ctx.token, ip: ctx.ip }),
          );
          await res.body?.cancel();
        }
      });
    },
    expected: { status: 200, appClass: "ok" },
    pinned: {
      status: 429,
      appClass: "unavailable(retryable)",
      code: "rate_limited",
    },
    recoverable: false,
    note:
      "an Auth outage charges the auth-failure budget; a shared NAT stays locked out 5 min after recovery",
  },
  {
    id: "rl-ip-1201st",
    group: "ratelimit",
    title: "1201st request from one IP inside a minute",
    provider: "google",
    arm: (h, ctx) => {
      preload.push(async () => {
        for (let i = 0; i < 1_200; i++) {
          const res = await h.handler(
            bootstrapRequest({ token: null, ip: ctx.ip }),
          );
          await res.body?.cancel();
        }
      });
    },
    expected: {
      status: 429,
      appClass: "unavailable(retryable)",
      code: "rate_limited",
    },
    recoverable: false,
    supabaseRoundTrips: 0,
    note:
      "the 1200 bearer-less requests also exhaust the auth-failure budget; either way the IP is refused",
  },
];

/** Work a case queues to run BEFORE its measured request (same frozen clock). */
const preload: Array<() => Promise<void>> = [];

interface CaseResult {
  id: string;
  group: string;
  title: string;
  seed: number;
  sub: string;
  ip: string;
  expected: Expectation;
  pinned: Expectation | null;
  observed:
    | (Observed & {
      durationMs: number;
      pendingAfterMs?: number;
      afterRelease?: Observed;
    })
    | null;
  supabaseRoundTrips: number;
  redisRoundTrips: number;
  revenuecatCalls: number;
  faultHits: number;
  retry: (Observed & { durationMs: number }) | null;
  verdict: "HELD" | "BROKEN" | "FAILED";
  note?: string;
  logLines: number;
}

function matches(
  observed: Observed | "pending",
  expectation: Expectation,
): boolean {
  if (observed === "pending") return expectation.status === "pending";
  if (expectation.status === "pending") return false;
  if (observed.status !== expectation.status) return false;
  if (observed.appClass !== expectation.appClass) return false;
  if (expectation.code !== undefined && observed.code !== expectation.code) {
    return false;
  }
  return true;
}

async function runCase(h: Harness, c: FaultCase): Promise<CaseResult> {
  const seed = (STRESS_SEED ^ fnv1a(c.id)) >>> 0;
  h.reset(seed);
  const prng = new Prng(seed);
  const sub = `${c.provider}.${prng.uuid()}`;
  const user = h.provision(sub, c.provider);
  if (c.profileProvider) h.profiles.get(user.id)!.provider = c.profileProvider;
  const ip = freshIp();
  const token = providerIdToken(c.provider, sub);
  const appleOpts = c.apple ?? {};
  const wantsCode = c.provider === "apple" && !("code" in appleOpts);
  const appleCode = wantsCode ? h.mintAppleCode(sub) : null;
  const ctx: CaseContext = { seed, sub, userId: user.id, ip, token, appleCode };

  const buildRequest = (code: unknown, header: boolean) =>
    c.request ? c.request(h, ctx) : bootstrapRequest({
      token,
      ip,
      body: c.provider === "apple"
        ? (code === undefined ? {} : { appleAuthorizationCode: code })
        : undefined,
      headers: header ? { "X-Apple-Revocation-Protocol": "1" } : {},
    });

  const console_ = captureConsole();
  let result: CaseResult;
  try {
    result = await withFrozenClock(async () => {
      c.arm?.(h, ctx);
      for (const step of preload.splice(0)) await step();
      const fromSeq = h.nextSeq();
      const pendingAfterMs = c.pendingAfterMs ?? PENDING_AFTER_MS;
      const started = performance.now();
      const header = c.provider === "apple"
        ? (appleOpts.header ?? true)
        : false;
      const code = wantsCode ? appleCode : appleOpts.code;
      const pending = h.handler(buildRequest(code, header));
      let timer: number | undefined;
      const raced = await Promise.race([
        pending.then((r) => ({ kind: "answered" as const, response: r })),
        new Promise<{ kind: "pending" }>((resolve) => {
          timer = setTimeout(
            () => resolve({ kind: "pending" }),
            pendingAfterMs,
          );
        }),
      ]);
      clearTimeout(timer);
      let observed: CaseResult["observed"] = null;
      let verdictObserved: Observed | "pending";
      if (raced.kind === "answered") {
        const obs = await observe(raced.response);
        observed = {
          ...obs,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        };
        verdictObserved = obs;
      } else {
        h.release();
        h.disarm();
        const late = await observe(await pending);
        observed = {
          ...late,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
          pendingAfterMs,
          afterRelease: late,
        };
        verdictObserved = "pending";
      }
      const supabaseRoundTrips = h.supabaseRoundTrips(fromSeq);
      const redisRoundTrips = h.redisRoundTrips(fromSeq);
      const revenuecatCalls = h.callsTo("revenuecat").filter((x) =>
        x.seq >= fromSeq
      ).length;
      const faultHits = (Object.keys(h.counters) as string[])
        .filter((k) => k.startsWith("faults."))
        .reduce((n, k) => n + h.counters[k], 0);

      // Recoverability: fault cleared (and a malformed request corrected), the
      // same identity on the same IP tries again with a well-formed request.
      h.disarm();
      h.release();
      h.profileLag.clear();
      let retry: CaseResult["retry"] = null;
      if (c.recoverable) {
        const retryStarted = performance.now();
        const retryRequest = bootstrapRequest({
          token,
          ip,
          body: c.provider === "apple"
            ? { appleAuthorizationCode: h.mintAppleCode(sub) }
            : undefined,
          headers: c.provider === "apple"
            ? { "X-Apple-Revocation-Protocol": "1" }
            : {},
        });
        const retryObs = await observe(await h.handler(retryRequest));
        retry = {
          ...retryObs,
          durationMs: Math.round((performance.now() - retryStarted) * 100) /
            100,
        };
      }

      const target = c.pinned ?? c.expected;
      const held = matches(verdictObserved, target);
      const contract = matches(verdictObserved, c.expected);
      const verdict: CaseResult["verdict"] = !held
        ? "FAILED"
        : contract
        ? "HELD"
        : "BROKEN";
      return {
        id: c.id,
        group: c.group,
        title: c.title,
        seed,
        sub,
        ip,
        expected: c.expected,
        pinned: c.pinned ?? null,
        observed,
        supabaseRoundTrips,
        redisRoundTrips,
        revenuecatCalls,
        faultHits,
        retry,
        verdict,
        note: c.note,
        logLines: console_.lines.length,
      };
    });
  } finally {
    console_.restore();
    h.disarm();
    h.release();
  }
  return result;
}

const results: CaseResult[] = [];

Deno.test({
  name:
    "stress/bootstrap faults: every injected upstream fault has a pinned user-visible class and clears",
  // Injected hangs/delays and cache.ts' AbortSignal.timeout leave timers that
  // outlive a step by design.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const h = await loadHarness({ redis: true, apple: true });
    const ids = new Set<string>();
    for (const c of CASES) {
      assert(!ids.has(c.id), `duplicate case id ${c.id}`);
      ids.add(c.id);
    }
    for (const c of CASES) {
      await t.step(`${c.group}: ${c.title}`, async () => {
        const r = await runCase(h, c);
        results.push(r);
        const target = c.pinned ?? c.expected;
        const shown = r.observed
          ? r.observed.pendingAfterMs
            ? `pending@${r.observed.pendingAfterMs}ms (after release: ${r.observed.afterRelease?.status})`
            : `${r.observed.status} ${r.observed.appClass} code=${r.observed.code}`
          : "no observation";
        assert(
          r.verdict !== "FAILED",
          `[seed ${r.seed}] ${c.id}: observed ${shown}; pinned/expected ${
            JSON.stringify(target)
          }`,
        );
        if (c.supabaseRoundTrips !== undefined) {
          assertEquals(
            r.supabaseRoundTrips,
            c.supabaseRoundTrips,
            `${c.id}: Supabase round trips`,
          );
        }
        // A route that never calls RevenueCat.
        assertEquals(
          r.revenuecatCalls,
          0,
          `${c.id}: RevenueCat must not be called by bootstrap`,
        );
        // Every answer carries a request id.
        if (r.observed && !r.observed.pendingAfterMs) {
          assert(r.observed.requestId, `${c.id}: x-request-id`);
        }
        if (c.minDurationMs !== undefined) {
          assert(
            r.observed!.durationMs >= c.minDurationMs,
            `${c.id}: took ${
              r.observed!.durationMs
            } ms; the documented stall is ≥ ${c.minDurationMs} ms`,
          );
        }
        // Recoverability — unless the case is itself a budget exhaustion.
        if (c.recoverable) {
          assert(r.retry, `${c.id}: retry missing`);
          assertEquals(
            r.retry!.status,
            200,
            `${c.id}: retry after the fault cleared → ${r.retry!.status}`,
          );
        }
      });
    }

    const broken = results.filter((r) => r.verdict === "BROKEN");
    const held = results.filter((r) => r.verdict === "HELD");
    const path = await writeReport("faults", {
      unit: "POST /v1/account/bootstrap",
      lens: "failure-load/faults",
      seed: STRESS_SEED,
      replay:
        "STRESS_SEED=<seed> deno test -A --no-check --config deno.json stress_bootstrap_faults.test.ts",
      cases: results.length,
      held: held.length,
      broken: broken.length,
      brokenIds: broken.map((r) => r.id),
      results,
    });
    console.log(
      `[stress] faults: ${results.length} cases, HELD ${held.length}, BROKEN ${broken.length} → ${path}`,
    );
    assert(results.length >= 40, "the lens requires ≥ 40 fault cases");
  },
});
