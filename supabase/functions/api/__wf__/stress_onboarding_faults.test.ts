/**
 * stress: PUT /v1/me/onboarding — FAILURE INJECTION (Redis ON) + hot-path load.
 *
 * Every upstream the real handler can touch for this route is faulted in turn
 * (fail / time out / hang / malformed), one case per row, and each row asserts
 * (1) the user-visible status + error class, (2) that no internal detail
 * leaks in a 5xx body, (3) recoverability — the very next healthy request for
 * the same user succeeds, (4) the auth-failure budget is charged only for
 * credential refusals, never for outages, and (5) RevenueCat is never called.
 *
 * Rows are written to STRESS_OUT_DIR/onboarding_faults.json (seed → outcome).
 * Two behaviours observed here are pinned as CHARACTERIZATION (the finding is
 * in the coordinator report); `STRESS_STRICT=1` asserts the contract instead:
 *   - legacy provider-ID-token bearer during an Auth outage → 401 (not 503)
 *   - PostgREST hang → no deadline on the profile UPDATE
 *
 *   deno test -A --no-check --config deno.json stress_onboarding_faults.test.ts
 *   STRESS_ITER=1000 STRESS_STRICT=1 deno test -A --no-check --config deno.json stress_onboarding_faults.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { googleIdToken } from "./sessionHarness.ts";
import {
  countRoundTrips,
  type FaultSpec,
  histogram,
  type Invariant,
  ipAt,
  latencyStats,
  stressTest,
  onboardingRequest,
  Prng,
  provisionUser,
  replayCommand,
  round,
  type RunResult,
  runOnce,
  STRESS_ITER,
  STRESS_SEED,
  type StressContext,
  userIdAt,
  validOnboardingBody,
  writeReport,
} from "./stress_onboarding_harness.ts";

const FILE = "stress_onboarding_faults.test.ts";
const STRICT = Deno.env.get("STRESS_STRICT") === "1";

const SESSION_UNAVAILABLE = "Session verification is temporarily unavailable. Please try again.";
const SESSION_INVALID = "The session is no longer valid. Sign in again.";
const PROFILE_UNAVAILABLE = "Your coaching profile is temporarily unavailable. Please try again.";
const IDENTITY_UNVERIFIED = "The identity token could not be verified.";

type Bearer = "session-cold" | "session-warm" | "provider-id-token" | "none";

interface FaultCase {
  id: string;
  upstream: "auth" | "rest" | "redis" | "revenuecat" | "route" | "combo";
  title: string;
  bearer: Bearer;
  faults: FaultSpec[];
  /** Contract: what the user must see. */
  expect: {
    status: number;
    message?: string;
    retryAfter?: string;
    /** auth-failure budget charged for this response? (401 only) */
    authFailCharged: boolean;
    /** the PATCH must not have been sent (validation / auth failed first) */
    noPatch?: boolean;
    /** the handler must answer within this many ms (default 3000) */
    withinMs?: number;
  };
  /** Known deviation pinned as characterization (see file header). */
  characterization?: {
    status: number;
    message?: string;
    timedOut?: boolean;
    /** the next healthy request for the same user (contract: 200) */
    recoveryStatus?: number;
    finding: string;
  };
  /** Body override (default: a valid seeded payload). */
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** Called after the faulted request, before the recovery request. */
  probe?: (result: RunResult, ctx: StressContext) => Invariant[];
}

const gotrueUser = (provider: string, id: string) =>
  JSON.stringify({
    id,
    aud: "authenticated",
    email: `${id}@example.com`,
    app_metadata: { provider, providers: [provider] },
    user_metadata: {},
  });

const auth = (spec: Omit<FaultSpec, "upstream">): FaultSpec => ({ upstream: "auth", ...spec });
const rest = (spec: Omit<FaultSpec, "upstream">): FaultSpec => ({
  upstream: "rest",
  method: "PATCH",
  urlIncludes: "/rest/v1/profiles",
  ...spec,
});
const redis = (spec: Omit<FaultSpec, "upstream">): FaultSpec => ({ upstream: "redis", ...spec });
const rc = (spec: Omit<FaultSpec, "upstream">): FaultSpec => ({ upstream: "revenuecat", ...spec });

const outage503 = {
  status: 503,
  message: SESSION_UNAVAILABLE,
  retryAfter: "2",
  authFailCharged: false,
  noPatch: true,
};
const refused401 = { status: 401, message: SESSION_INVALID, authFailCharged: true, noPatch: true };
const profile503 = { status: 503, message: PROFILE_UNAVAILABLE, authFailCharged: false };
const ok200 = { status: 200, authFailCharged: false };

const CASES: FaultCase[] = [
  // ── Supabase Auth: GET /auth/v1/user (session bearer, cold cache) ──────────
  {
    id: "A01",
    upstream: "auth",
    title: "Auth 500",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 500 })],
    expect: outage503,
  },
  {
    id: "A02",
    upstream: "auth",
    title: "Auth 502",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 502 })],
    expect: outage503,
  },
  {
    id: "A03",
    upstream: "auth",
    title: "Auth 503 with Retry-After: 7",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 503, headers: { "Retry-After": "7" } })],
    expect: { ...outage503, retryAfter: "7" },
  },
  {
    id: "A04",
    upstream: "auth",
    title: "Auth 504",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 504 })],
    expect: outage503,
  },
  {
    id: "A05",
    upstream: "auth",
    title: "Auth 429 (GoTrue rate-limits the edge) Retry-After: 30",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 429, headers: { "Retry-After": "30" } })],
    expect: { ...outage503, retryAfter: "30" },
  },
  {
    id: "A06",
    upstream: "auth",
    title: "Auth 401 bad_jwt → refusal",
    bearer: "session-cold",
    faults: [
      auth({
        kind: "http",
        status: 401,
        body: JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }),
      }),
    ],
    expect: refused401,
  },
  {
    id: "A07",
    upstream: "auth",
    title: "Auth 403 (user banned / session gone) → refusal",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 403 })],
    expect: refused401,
  },
  {
    id: "A08",
    upstream: "auth",
    title: "Auth 400 → refusal",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 400 })],
    expect: refused401,
  },
  {
    id: "A09",
    upstream: "auth",
    title: "Auth 404 (gateway misroute) → outage, not refusal",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 404 })],
    expect: outage503,
  },
  {
    id: "A10",
    upstream: "auth",
    title: "Auth 301 redirect w/o body → outage",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 301, body: "" })],
    expect: outage503,
  },
  {
    id: "A11",
    upstream: "auth",
    title: "Auth connection reset on every attempt",
    bearer: "session-cold",
    faults: [auth({ kind: "throw" })],
    expect: { ...outage503, withinMs: 1500 },
    probe: (r) => [
      {
        name: "connect-retry bounded by deadline",
        holds: r.roundTrips.auth >= 2 && r.roundTrips.auth <= 4,
        detail: `auth attempts=${r.roundTrips.auth}`,
      },
    ],
  },
  {
    id: "A12",
    upstream: "auth",
    title: "Auth connection reset once, then healthy → transparent retry",
    bearer: "session-cold",
    faults: [auth({ kind: "throw", times: 1 })],
    expect: ok200,
    probe: (r) => [
      {
        name: "exactly one retry",
        holds: r.roundTrips.auth === 2,
        detail: `auth attempts=${r.roundTrips.auth}`,
      },
    ],
  },
  {
    id: "A13",
    upstream: "auth",
    title: "Auth hangs (no answer) → deadline → 503",
    bearer: "session-cold",
    faults: [auth({ kind: "hang" })],
    expect: { ...outage503, withinMs: 1500 },
    probe: (r, ctx) => [
      {
        name: "hung socket abandoned via AbortSignal",
        holds: ctx.faults.hungCount() === 0,
        detail: `parked=${ctx.faults.hungCount()} durationMs=${round(r.durationMs)}`,
      },
    ],
  },
  {
    id: "A14",
    upstream: "auth",
    title: "Auth slow (300ms) but inside deadline → 200",
    bearer: "session-cold",
    faults: [auth({ kind: "delay", delayMs: 300 })],
    expect: ok200,
  },
  {
    id: "A15",
    upstream: "auth",
    title: "Auth slower than deadline (900ms) → 503",
    bearer: "session-cold",
    faults: [auth({ kind: "delay", delayMs: 900 })],
    expect: { ...outage503, withinMs: 1500 },
  },
  {
    id: "A16",
    upstream: "auth",
    title: "Auth 200 HTML gateway page",
    bearer: "session-cold",
    faults: [auth({ kind: "malformed", body: "<html><body>502 Bad Gateway</body></html>" })],
    expect: outage503,
  },
  {
    id: "A17",
    upstream: "auth",
    title: "Auth 200 empty body",
    bearer: "session-cold",
    faults: [auth({ kind: "malformed", body: "" })],
    expect: outage503,
  },
  {
    id: "A18",
    upstream: "auth",
    title: "Auth 200 `{}` (no id)",
    bearer: "session-cold",
    faults: [
      auth({ kind: "malformed", body: "{}", headers: { "Content-Type": "application/json" } }),
    ],
    expect: outage503,
  },
  {
    id: "A19",
    upstream: "auth",
    title: 'Auth 200 `{"id":123}` (wrong type)',
    bearer: "session-cold",
    faults: [
      auth({
        kind: "malformed",
        body: '{"id":123}',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: outage503,
  },
  {
    id: "A20",
    upstream: "auth",
    title: "Auth 200 truncated JSON",
    bearer: "session-cold",
    faults: [
      auth({
        kind: "malformed",
        body: '{"id":"abc',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: outage503,
  },
  {
    id: "A21",
    upstream: "auth",
    title: "Auth 200 `null`",
    bearer: "session-cold",
    faults: [
      auth({ kind: "malformed", body: "null", headers: { "Content-Type": "application/json" } }),
    ],
    expect: outage503,
  },
  {
    id: "A22",
    upstream: "auth",
    title: "Auth 200 `[]`",
    bearer: "session-cold",
    faults: [
      auth({ kind: "malformed", body: "[]", headers: { "Content-Type": "application/json" } }),
    ],
    expect: outage503,
  },
  {
    id: "A23",
    upstream: "auth",
    title: "Auth 200 user with provider=email → not a Google/Apple account",
    bearer: "session-cold",
    faults: [
      auth({
        kind: "malformed",
        body: gotrueUser("email", "e0000000-0000-4000-8000-000000000001"),
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: {
      status: 401,
      message: "The session does not belong to a Google or Apple account.",
      authFailCharged: true,
      noPatch: true,
    },
  },
  {
    id: "A24",
    upstream: "auth",
    title: "Auth 200 user without app_metadata",
    bearer: "session-cold",
    faults: [
      auth({
        kind: "malformed",
        body: '{"id":"e0000000-0000-4000-8000-000000000002"}',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: {
      status: 401,
      message: "The session does not belong to a Google or Apple account.",
      authFailCharged: true,
      noPatch: true,
    },
  },
  {
    id: "A25",
    upstream: "auth",
    title: "Auth 500 with 1 MiB body",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 500, body: "x".repeat(1 << 20) })],
    expect: outage503,
  },
  {
    id: "A26",
    upstream: "auth",
    title: "Auth 500 once, healthy after → cold retry by the client succeeds",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 500, times: 1 })],
    expect: outage503,
  },

  // ── Supabase Auth: transitional provider-ID-token bearer ─────────────────
  {
    id: "L01",
    upstream: "auth",
    title: "Legacy Google ID-token bearer: Auth 503 on id_token grant",
    bearer: "provider-id-token",
    faults: [auth({ kind: "http", status: 503, urlIncludes: "grant_type=id_token" })],
    expect: { status: 503, retryAfter: "2", authFailCharged: false, noPatch: true },
    characterization: {
      status: 401,
      message: IDENTITY_UNVERIFIED,
      finding:
        "legacy provider-token path reports an Auth outage as a credential refusal (401) and charges the auth-failure budget",
    },
  },
  {
    id: "L02",
    upstream: "auth",
    title: "Legacy Google ID-token bearer: Auth connection reset",
    bearer: "provider-id-token",
    faults: [auth({ kind: "throw", urlIncludes: "grant_type=id_token" })],
    expect: { status: 503, authFailCharged: false, noPatch: true },
    characterization: {
      status: 401,
      message: IDENTITY_UNVERIFIED,
      finding: "legacy provider-token path: socket error → 401",
    },
  },
  {
    id: "L03",
    upstream: "auth",
    title: "Legacy Google ID-token bearer: Auth hangs",
    bearer: "provider-id-token",
    faults: [auth({ kind: "hang", urlIncludes: "grant_type=id_token" })],
    expect: { status: 503, authFailCharged: false, noPatch: true, withinMs: 1500 },
    characterization: {
      status: 0,
      timedOut: true,
      finding:
        "legacy provider-token path has no upstream deadline (AUTH_UPSTREAM_TIMEOUT_MS not applied): the request hangs as long as GoTrue does",
    },
  },
  {
    id: "L04",
    upstream: "auth",
    title: "Legacy Google ID-token bearer: Auth 200 HTML",
    bearer: "provider-id-token",
    faults: [
      auth({
        kind: "malformed",
        urlIncludes: "grant_type=id_token",
        body: "<html>bad gateway</html>",
      }),
    ],
    expect: { status: 503, authFailCharged: false, noPatch: true },
    characterization: {
      status: 401,
      message: IDENTITY_UNVERIFIED,
      finding: "legacy provider-token path: malformed 200 → 401",
    },
  },
  {
    id: "L05",
    upstream: "auth",
    title: "Legacy Google ID-token bearer: Auth 400 invalid_grant → refusal",
    bearer: "provider-id-token",
    faults: [
      auth({
        kind: "http",
        status: 400,
        urlIncludes: "grant_type=id_token",
        body: JSON.stringify({ error: "invalid_grant", error_description: "Bad ID token" }),
      }),
    ],
    expect: { status: 401, message: IDENTITY_UNVERIFIED, authFailCharged: true, noPatch: true },
  },
  {
    id: "L06",
    upstream: "auth",
    title: "Legacy Google ID-token bearer: healthy → 200 (control)",
    bearer: "provider-id-token",
    faults: [],
    expect: ok200,
  },

  // ── PostgREST: PATCH /rest/v1/profiles (warm auth cache: 0 auth trips) ───
  {
    id: "R01",
    upstream: "rest",
    title: "PostgREST 500",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "http",
        status: 500,
        body: JSON.stringify({
          code: "XX000",
          message: "internal error: relation public.profiles",
          details: null,
          hint: null,
        }),
      }),
    ],
    expect: profile503,
  },
  {
    id: "R02",
    upstream: "rest",
    title: "PostgREST 502",
    bearer: "session-warm",
    faults: [rest({ kind: "http", status: 502 })],
    expect: profile503,
  },
  {
    id: "R03",
    upstream: "rest",
    title: "PostgREST 503 (schema cache reload) — PATCH must not be retried",
    bearer: "session-warm",
    faults: [rest({ kind: "http", status: 503, headers: { "Retry-After": "1" } })],
    expect: { ...profile503, withinMs: 800 },
    probe: (r) => [
      {
        name: "no client-side retry storm on a non-idempotent PATCH",
        holds: r.roundTrips.rest === 1,
        detail: `rest attempts=${r.roundTrips.rest}`,
      },
    ],
  },
  {
    id: "R04",
    upstream: "rest",
    title: "PostgREST 504",
    bearer: "session-warm",
    faults: [rest({ kind: "http", status: 504 })],
    expect: profile503,
  },
  {
    id: "R05",
    upstream: "rest",
    title: "PostgREST 401 (JWT rejected downstream)",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "http",
        status: 401,
        body: JSON.stringify({ code: "PGRST301", message: "JWT expired" }),
      }),
    ],
    expect: profile503,
  },
  {
    id: "R06",
    upstream: "rest",
    title: "PostgREST 403 42501 (column grant missing)",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "http",
        status: 403,
        body: JSON.stringify({
          code: "42501",
          message: "permission denied for table profiles",
          details: null,
          hint: null,
        }),
      }),
    ],
    expect: profile503,
  },
  {
    id: "R07",
    upstream: "rest",
    title: "PostgREST 404 (table missing)",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "http",
        status: 404,
        body: JSON.stringify({
          code: "PGRST205",
          message: "Could not find the table 'public.profiles'",
        }),
      }),
    ],
    expect: profile503,
  },
  {
    id: "R08",
    upstream: "rest",
    title: "PostgREST 400 23514 check_violation (constraint text must not leak)",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "http",
        status: 400,
        body: JSON.stringify({
          code: "23514",
          message:
            'new row for relation "profiles" violates check constraint "profiles_text_bounds"',
          details: "Failing row contains (...)",
          hint: null,
        }),
      }),
    ],
    expect: profile503,
  },
  {
    id: "R09",
    upstream: "rest",
    title: "PostgREST 409 conflict",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "http",
        status: 409,
        body: JSON.stringify({
          code: "23505",
          message: "duplicate key value violates unique constraint",
        }),
      }),
    ],
    expect: profile503,
  },
  {
    id: "R10",
    upstream: "rest",
    title: "PostgREST 429",
    bearer: "session-warm",
    faults: [rest({ kind: "http", status: 429, headers: { "Retry-After": "3" } })],
    expect: profile503,
  },
  {
    id: "R11",
    upstream: "rest",
    title: "PostgREST connection reset",
    bearer: "session-warm",
    faults: [rest({ kind: "throw" })],
    expect: { ...profile503, withinMs: 800 },
  },
  {
    id: "R12",
    upstream: "rest",
    title: "PostgREST hangs (no answer)",
    bearer: "session-warm",
    faults: [rest({ kind: "hang" })],
    expect: { ...profile503, withinMs: 2500 },
    characterization: {
      status: 0,
      timedOut: true,
      finding:
        "the profile UPDATE has no upstream deadline: a hung PostgREST socket hangs the request until the platform kills it",
    },
  },
  {
    id: "R13",
    upstream: "rest",
    title: "PostgREST slow (400ms) → 200",
    bearer: "session-warm",
    faults: [rest({ kind: "delay", delayMs: 400 })],
    expect: ok200,
  },
  {
    id: "R14",
    upstream: "rest",
    title: "PostgREST 200 HTML gateway page",
    bearer: "session-warm",
    faults: [rest({ kind: "malformed", body: "<html>bad gateway</html>" })],
    expect: profile503,
  },
  {
    id: "R15",
    upstream: "rest",
    title: "PostgREST 200 empty body",
    bearer: "session-warm",
    faults: [
      rest({ kind: "malformed", body: "", headers: { "Content-Type": "application/json" } }),
    ],
    expect: profile503,
  },
  {
    id: "R16",
    upstream: "rest",
    title: "PostgREST 200 `null`",
    bearer: "session-warm",
    faults: [
      rest({ kind: "malformed", body: "null", headers: { "Content-Type": "application/json" } }),
    ],
    expect: profile503,
  },
  {
    id: "R17",
    upstream: "rest",
    title: "PostgREST 200 truncated JSON",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "malformed",
        body: '{"skill_level":"3.0"',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: profile503,
  },
  {
    id: "R18",
    upstream: "rest",
    title: "PostgREST 406 PGRST116 (0 rows: RLS hid the row / no profile)",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "malformed",
        status: 406,
        body: JSON.stringify({
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: "The result contains 0 rows",
          hint: null,
        }),
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: profile503,
  },
  {
    id: "R19",
    upstream: "rest",
    title: "PostgREST 200 two rows for a single-object request",
    bearer: "session-warm",
    faults: [
      rest({ kind: "malformed", body: "[{},{}]", headers: { "Content-Type": "application/json" } }),
    ],
    expect: profile503,
  },
  {
    id: "R20",
    upstream: "rest",
    title: "PostgREST 200 object missing selected columns → nulls echoed, 200",
    bearer: "session-warm",
    faults: [
      rest({
        kind: "malformed",
        body: '{"skill_level":"3.0"}',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: ok200,
    probe: (r) => {
      const profile = (r.body as { profile?: Record<string, unknown> }).profile ?? {};
      return [
        {
          name: "missing columns are echoed absent/null (never a crash)",
          holds:
            (profile.handedness === null || !("handedness" in profile)) &&
            profile.skill_level === "3.0",
          detail: JSON.stringify(profile),
        },
      ];
    },
  },
  {
    id: "R21",
    upstream: "rest",
    title: "PostgREST 500 once, healthy after",
    bearer: "session-warm",
    faults: [rest({ kind: "http", status: 500, times: 1 })],
    expect: profile503,
  },
  {
    id: "R22",
    upstream: "rest",
    title: "PostgREST 500 with 1 MiB body",
    bearer: "session-warm",
    faults: [rest({ kind: "http", status: 500, body: "x".repeat(1 << 20) })],
    expect: profile503,
  },

  // ── Upstash Redis: POST /pipeline (fail-open to per-isolate memory) ──────
  {
    id: "U01",
    upstream: "redis",
    title: "Redis 500 on every pipeline",
    bearer: "session-cold",
    faults: [redis({ kind: "http", status: 500 })],
    expect: ok200,
  },
  {
    id: "U02",
    upstream: "redis",
    title: "Redis 401 (token rotated)",
    bearer: "session-cold",
    faults: [redis({ kind: "http", status: 401, body: JSON.stringify({ error: "Unauthorized" }) })],
    expect: ok200,
  },
  {
    id: "U03",
    upstream: "redis",
    title: "Redis 429 (Upstash quota)",
    bearer: "session-cold",
    faults: [redis({ kind: "http", status: 429 })],
    expect: ok200,
  },
  {
    id: "U04",
    upstream: "redis",
    title: "Redis connection reset",
    bearer: "session-cold",
    faults: [redis({ kind: "throw" })],
    expect: ok200,
  },
  {
    id: "U05",
    upstream: "redis",
    title: "Redis hangs on every pipeline (REDIS_TIMEOUT_MS=1200 each)",
    bearer: "session-cold",
    faults: [redis({ kind: "hang" })],
    expect: { ...ok200, withinMs: 15_000 },
    probe: (r) => [
      {
        name: "serial Redis timeouts stack per request",
        holds: true,
        detail: `redis pipelines=${r.roundTrips.redis} durationMs=${round(r.durationMs)} (each waits the full 1200ms deadline — see coordinator report)`,
      },
    ],
  },
  {
    id: "U06",
    upstream: "redis",
    title: "Redis slow (150ms per pipeline)",
    bearer: "session-cold",
    faults: [redis({ kind: "delay", delayMs: 150 })],
    expect: ok200,
  },
  {
    id: "U07",
    upstream: "redis",
    title: "Redis 200 HTML",
    bearer: "session-cold",
    faults: [redis({ kind: "malformed", body: "<html>upstash</html>" })],
    expect: ok200,
  },
  {
    id: "U08",
    upstream: "redis",
    title: 'Redis 200 non-array `{"result":"OK"}`',
    bearer: "session-cold",
    faults: [
      redis({
        kind: "malformed",
        body: '{"result":"OK"}',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: ok200,
  },
  {
    id: "U09",
    upstream: "redis",
    title: "Redis 200 per-command errors",
    bearer: "session-cold",
    faults: [
      redis({
        kind: "malformed",
        body: '[{"error":"ERR wrong number of arguments"}]',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: ok200,
  },
  {
    id: "U10",
    upstream: "redis",
    title: "Redis 200 cached auth row is not JSON (poisoned L2 value slot) → re-verify",
    bearer: "session-cold",
    faults: [
      redis({
        kind: "malformed",
        body: '[{"result":null},{"result":"not-json"},{"result":100}]',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: ok200,
    probe: (r) => [
      {
        name: "corrupt cache row falls through to Auth",
        holds: r.roundTrips.auth === 1,
        detail: `auth=${r.roundTrips.auth}`,
      },
    ],
  },
  {
    id: "U14",
    upstream: "redis",
    title: "Redis 200 returns a string in the revocation-marker slot for a live session",
    bearer: "session-cold",
    faults: [
      redis({
        kind: "malformed",
        body: '[{"result":"1"},{"result":null},{"result":-2}]',
        headers: { "Content-Type": "application/json" },
      }),
    ],
    expect: { ...ok200, noPatch: false },
    characterization: {
      status: 401,
      message: SESSION_INVALID,
      recoveryStatus: 401,
      finding:
        "any non-null string answered for GET auth:revoked:<sid> is trusted as a revocation and pinned in L1 for 60s: the user is signed out (401) and the next healthy request still fails (recovery 401)",
    },
  },
  {
    id: "U11",
    upstream: "redis",
    title: "Redis 500 on the first pipeline only (IP limit) then healthy",
    bearer: "session-cold",
    faults: [redis({ kind: "http", status: 500, times: 1 })],
    expect: ok200,
  },
  {
    id: "U12",
    upstream: "redis",
    title: "Redis 200 `[]` (empty pipeline result)",
    bearer: "session-cold",
    faults: [
      redis({ kind: "malformed", body: "[]", headers: { "Content-Type": "application/json" } }),
    ],
    expect: ok200,
  },
  {
    id: "U13",
    upstream: "redis",
    title: "Redis fails during the L2 auth-cache write (warm path)",
    bearer: "session-warm",
    faults: [redis({ kind: "http", status: 500 })],
    expect: ok200,
  },

  // ── RevenueCat: never on this route ──────────────────────────────────────
  {
    id: "V01",
    upstream: "revenuecat",
    title: "RevenueCat connection reset armed → route unaffected (0 calls)",
    bearer: "session-cold",
    faults: [rc({ kind: "throw" })],
    expect: ok200,
  },
  {
    id: "V02",
    upstream: "revenuecat",
    title: "RevenueCat hang armed → route unaffected (0 calls)",
    bearer: "session-cold",
    faults: [rc({ kind: "hang" })],
    expect: ok200,
  },

  // ── Combinations + route-level inputs ────────────────────────────────────
  {
    id: "C01",
    upstream: "combo",
    title: "Auth 503 AND PostgREST 500 → auth verdict first",
    bearer: "session-cold",
    faults: [auth({ kind: "http", status: 503 }), rest({ kind: "http", status: 500 })],
    expect: outage503,
  },
  {
    id: "C02",
    upstream: "combo",
    title: "Redis 500 AND PostgREST 500 → profile 503 (Redis silent)",
    bearer: "session-cold",
    faults: [redis({ kind: "http", status: 500 }), rest({ kind: "http", status: 500 })],
    expect: profile503,
  },
  {
    id: "C03",
    upstream: "combo",
    title: "Redis reset AND Auth reset → 503 session (memory fallback intact)",
    bearer: "session-cold",
    faults: [redis({ kind: "throw" }), auth({ kind: "throw" })],
    expect: { ...outage503, withinMs: 1500 },
  },
  {
    id: "C04",
    upstream: "combo",
    title: "Every upstream 500 at once",
    bearer: "session-cold",
    faults: [
      redis({ kind: "http", status: 500 }),
      auth({ kind: "http", status: 500 }),
      rest({ kind: "http", status: 500 }),
      rc({ kind: "http", status: 500 }),
    ],
    expect: outage503,
  },
  {
    id: "C05",
    upstream: "route",
    title: "Malformed JSON body (healthy upstreams) → 400, no PATCH",
    bearer: "session-warm",
    faults: [],
    rawBody: "{not json",
    expect: {
      status: 400,
      message: "Invalid onboarding payload.",
      authFailCharged: false,
      noPatch: true,
    },
  },
  {
    id: "C06",
    upstream: "route",
    title: "Content-Length above the JSON cap → 413 before any upstream",
    bearer: "session-warm",
    faults: [],
    headers: { "content-length": String(64 * 1024 * 1024) },
    expect: {
      status: 413,
      message: "Request body is too large.",
      authFailCharged: false,
      noPatch: true,
    },
    probe: (r) => [
      {
        name: "413 costs zero upstream calls",
        holds: r.calls.length === 0,
        detail: `calls=${r.calls.length}`,
      },
    ],
  },
  {
    id: "C07",
    upstream: "route",
    title: "No bearer → 401 (charged), no upstream",
    bearer: "none",
    faults: [],
    expect: { status: 401, message: "Missing bearer token.", authFailCharged: true, noPatch: true },
  },
  {
    id: "C08",
    upstream: "route",
    title: "Valid payload, all healthy (control)",
    bearer: "session-cold",
    faults: [],
    expect: ok200,
  },
];

interface CaseRow {
  id: string;
  seed: number;
  upstream: string;
  title: string;
  bearer: Bearer;
  expected: FaultCase["expect"];
  observed: {
    status: number;
    message: string;
    retryAfter: string | null;
    requestId: string | null;
    durationMs: number;
    timedOut: boolean;
    roundTrips: RunResult["roundTrips"];
    authFailCharged: boolean;
    patchSent: boolean;
  };
  recovery: { status: number; durationMs: number; roundTrips: RunResult["roundTrips"] };
  /** `[api] …` operator lines emitted by the faulted request (server side only). */
  operatorLog: string[];
  invariants: Invariant[];
  outcome: "HELD" | "BROKEN" | "CHARACTERIZED";
  finding?: string;
}

function authFailChargedFor(ctx: StressContext, ip: string): boolean {
  for (const key of ctx.h.redis.keys()) {
    if (key.startsWith("rl:authfail:") && key.endsWith(`:${ip}`)) return true;
  }
  return false;
}

async function runCase(ctx: StressContext, c: FaultCase, index: number): Promise<CaseRow> {
  const seed = (STRESS_SEED ^ (index * 0x9e3779b1)) >>> 0;
  const rng = new Prng(seed);
  const userId = userIdAt(100_000 + index);
  const ip = ipAt(50_000 + index);
  const session = provisionUser(ctx, userId);
  const bearer =
    c.bearer === "none"
      ? null
      : c.bearer === "provider-id-token"
        ? googleIdToken(userId)
        : session.accessToken;
  const body = c.body ?? validOnboardingBody(rng);
  const makeRequest = () =>
    onboardingRequest(bearer, body, ip, { rawBody: c.rawBody, headers: c.headers });

  if (c.bearer === "session-warm") {
    const warm = await runOnce(ctx, onboardingRequest(bearer, body, ip));
    assertEquals(warm.status, 200, `${c.id} warm-up must succeed: ${warm.status} ${warm.message}`);
  }
  ctx.faults.clear();
  ctx.faults.resetCalls();
  ctx.logs.reset();
  const patchesBefore = ctx.profiles.patches.length;
  for (const spec of c.faults) ctx.faults.arm(spec);

  const result = await runOnce(ctx, makeRequest(), c.expect.withinMs ?? 3_000);
  const patchSent = ctx.profiles.patches.length > patchesBefore;
  const charged = authFailChargedFor(ctx, ip);
  ctx.faults.clear();
  const operatorLog = ctx.logs.errors.map((line) => line.slice(0, 240));

  const invariants: Invariant[] = [];
  const observed = result.status;
  const characterized = c.characterization;
  const contractStatus = c.expect.status;
  const target =
    STRICT || !characterized
      ? c.expect
      : { ...c.expect, status: characterized.status, message: characterized.message };

  invariants.push({
    name: "status class",
    holds:
      characterized && !STRICT
        ? characterized.timedOut
          ? result.timedOut
          : observed === characterized.status
        : observed === contractStatus,
    detail: `expected ${STRICT || !characterized ? contractStatus : characterized.status}${characterized?.timedOut && !STRICT ? " (timed out)" : ""}, got ${observed}${result.timedOut ? " (timed out)" : ""} in ${round(result.durationMs)}ms`,
  });
  if (target.message !== undefined && !result.timedOut) {
    invariants.push({
      name: "user-visible message",
      holds: result.message === target.message,
      detail: `"${result.message}"`,
    });
  }
  if (c.expect.retryAfter !== undefined && observed === 503) {
    invariants.push({
      name: "Retry-After",
      holds: result.retryAfter === c.expect.retryAfter,
      detail: `Retry-After=${result.retryAfter}`,
    });
  }
  if (observed >= 500) {
    const text = JSON.stringify(result.body);
    const leaked =
      /profiles|PGRST|42501|23514|relation|constraint|Failing row|bad_jwt|GoTrue|upstash|<html/i.test(
        text,
      );
    invariants.push({
      name: "5xx body is generic (no internal detail)",
      holds: !leaked,
      detail: text.slice(0, 160),
    });
    invariants.push({
      name: "5xx detail is logged for operators",
      holds: operatorLog.length >= 1,
      detail: operatorLog[0]?.slice(0, 120) ?? "(nothing logged)",
    });
  }
  if (observed !== 0) {
    invariants.push({
      name: "x-request-id present",
      holds: Boolean(result.requestId),
      detail: String(result.requestId),
    });
  }
  if (c.expect.withinMs !== undefined && !(characterized?.timedOut && !STRICT)) {
    invariants.push({
      name: `answered within ${c.expect.withinMs}ms`,
      holds: !result.timedOut && result.durationMs <= c.expect.withinMs,
      detail: `${round(result.durationMs)}ms`,
    });
  }
  if (c.expect.noPatch) {
    invariants.push({
      name: "no profile write on a refused/failed request",
      holds: !patchSent,
      detail: `patchSent=${patchSent}`,
    });
  }
  const redisFaulted = c.faults.some((f) => f.upstream === "redis");
  if (!redisFaulted && !(characterized && !STRICT)) {
    invariants.push({
      name: "auth-failure budget charged only for refusals",
      holds: charged === c.expect.authFailCharged,
      detail: `charged=${charged}`,
    });
  } else if (!redisFaulted && characterized && !STRICT) {
    invariants.push({
      name: "auth-failure budget (characterized)",
      holds: true,
      detail: `charged=${charged} — contract says ${c.expect.authFailCharged}`,
    });
  }
  invariants.push({
    name: "RevenueCat never called",
    holds: result.roundTrips.revenuecat === 0,
    detail: `revenuecat=${result.roundTrips.revenuecat}`,
  });
  invariants.push({
    name: "≤3 Supabase round trips",
    holds: result.roundTrips.auth + result.roundTrips.rest <= 4,
    detail: `auth=${result.roundTrips.auth} rest=${result.roundTrips.rest} (auth connect-retries count individually)`,
  });
  if (c.probe) invariants.push(...c.probe(result, ctx));

  // Recoverability: the same user, healthy upstreams, must succeed now — and
  // a 401-charged case must not have exhausted anything for one failure.
  ctx.faults.resetCalls();
  const recoveryBearer = c.bearer === "none" ? session.accessToken : bearer;
  const recovery = await runOnce(
    ctx,
    onboardingRequest(recoveryBearer, validOnboardingBody(rng), ip),
  );
  const recoveryTarget =
    characterized?.recoveryStatus !== undefined && !STRICT ? characterized.recoveryStatus : 200;
  invariants.push({
    name:
      recoveryTarget === 200
        ? "recovers on the next healthy request"
        : `recovery pinned at ${recoveryTarget} (characterized)`,
    holds: recovery.status === recoveryTarget,
    detail: `recovery status=${recovery.status} ${recovery.message}`,
  });
  invariants.push({
    name: "recovery hot path ≤3 Supabase round trips",
    holds: recovery.roundTrips.auth + recovery.roundTrips.rest <= 3,
    detail: `auth=${recovery.roundTrips.auth} rest=${recovery.roundTrips.rest}`,
  });
  if (
    c.bearer !== "provider-id-token" &&
    recovery.status === 200 &&
    (observed === 200 || c.bearer === "session-warm")
  ) {
    invariants.push({
      name: "recovery reuses the cached verification (0 auth trips)",
      holds: recovery.roundTrips.auth === 0,
      detail: `auth=${recovery.roundTrips.auth}`,
    });
  }

  const broken = invariants.some((i) => !i.holds);
  return {
    id: c.id,
    seed,
    upstream: c.upstream,
    title: c.title,
    bearer: c.bearer,
    expected: c.expect,
    observed: {
      status: result.status,
      message: result.message,
      retryAfter: result.retryAfter,
      requestId: result.requestId,
      durationMs: round(result.durationMs),
      timedOut: result.timedOut,
      roundTrips: result.roundTrips,
      authFailCharged: charged,
      patchSent,
    },
    recovery: {
      status: recovery.status,
      durationMs: round(recovery.durationMs),
      roundTrips: recovery.roundTrips,
    },
    operatorLog,
    invariants,
    outcome: broken ? "BROKEN" : characterized && !STRICT ? "CHARACTERIZED" : "HELD",
    finding: characterized?.finding,
  };
}

stressTest(
  "stress/onboarding faults: every upstream fails, times out and lies in turn",
  { redis: true },
  async (ctx) => {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const rows: CaseRow[] = [];
    for (const [index, c] of CASES.entries()) rows.push(await runCase(ctx, c, index));
    ctx.faults.clear();
    const broken = rows.filter((r) => r.outcome === "BROKEN");
    await writeReport({
      campaign: "onboarding_faults",
      seed: STRESS_SEED,
      scale: {
        cases: rows.length,
        requests: rows.length * 2 + rows.filter((r) => r.bearer === "session-warm").length,
      },
      replay: replayCommand(FILE, "faults"),
      redis: true,
      rows,
      aggregates: {
        byOutcome: histogram(rows.map((r) => r.outcome)),
        byUpstream: histogram(rows.map((r) => r.upstream)),
        byStatus: histogram(rows.map((r) => r.observed.status)),
        strict: STRICT,
        characterized: rows
          .filter((r) => r.outcome === "CHARACTERIZED")
          .map((r) => ({ id: r.id, finding: r.finding, observed: r.observed })),
      },
      invariants: [
        {
          name: "no BROKEN rows",
          holds: broken.length === 0,
          detail: broken.map((r) => r.id).join(",") || "none",
        },
      ],
      broken: broken.map((r) => ({
        id: r.id,
        seed: r.seed,
        failed: r.invariants.filter((i) => !i.holds),
      })),
      startedAt,
      durationMs: round(performance.now() - t0),
    });
    assert(rows.length >= 40, `need ≥40 fault cases, have ${rows.length}`);
    assertEquals(
      broken.map(
        (r) =>
          `${r.id}: ${r.invariants
            .filter((i) => !i.holds)
            .map((i) => `${i.name} [${i.detail}]`)
            .join("; ")}`,
      ),
      [],
    );
  },
);

// ── Hot-path load with Redis ON ──────────────────────────────────────────────

interface LoadRow {
  i: number;
  seed: number;
  user: number;
  status: number;
  ms: number;
  auth: number;
  rest: number;
  redis: number;
}

stressTest(
  "stress/onboarding load (Redis on): p50/p95 + round trips per request",
  { redis: true },
  async (ctx) => {
    ctx.faults.clear();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const rng = new Prng(STRESS_SEED ^ 0x10ad);
    const USERS = 8; // 240/min general budget per user: keep every user well under it
    const iterations = Math.max(STRESS_ITER, 8);
    const sessions = Array.from({ length: USERS }, (_, u) =>
      provisionUser(ctx, userIdAt(200_000 + u)),
    );
    const rows: LoadRow[] = [];
    for (let i = 0; i < iterations; i++) {
      const u = i % USERS;
      const seed = (STRESS_SEED ^ (i * 0x85ebca6b)) >>> 0;
      ctx.faults.resetCalls();
      const r = await runOnce(
        ctx,
        onboardingRequest(
          sessions[u].accessToken,
          validOnboardingBody(new Prng(seed)),
          ipAt(60_000 + u),
        ),
      );
      rows.push({
        i,
        seed,
        user: u,
        status: r.status,
        ms: round(r.durationMs),
        auth: r.roundTrips.auth,
        rest: r.roundTrips.rest,
        redis: r.roundTrips.redis,
      });
      if (ctx.h.calls.length > 2_000) ctx.h.calls.length = 0;
    }
    // Concurrent burst: every user at once, warm cache, 4 waves.
    const burst: LoadRow[] = [];
    for (let wave = 0; wave < 4; wave++) {
      ctx.faults.resetCalls();
      const started = performance.now();
      const responses = await Promise.all(
        sessions.map((s, u) =>
          ctx.h.handler(
            onboardingRequest(s.accessToken, validOnboardingBody(rng), ipAt(60_000 + u)),
          ),
        ),
      );
      const ms = round(performance.now() - started);
      const trips = countRoundTrips(ctx.faults.calls);
      for (const [u, res] of responses.entries()) {
        await res.body?.cancel();
        burst.push({
          i: wave * USERS + u,
          seed: 0,
          user: u,
          status: res.status,
          ms,
          auth: trips.auth,
          rest: trips.rest,
          redis: trips.redis,
        });
      }
    }
    const warm = rows.filter((r) => r.i >= USERS);
    const stats = latencyStats(warm.map((r) => r.ms));
    const hotPathMax = Math.max(...warm.map((r) => r.auth + r.rest));
    const invariants: Invariant[] = [
      {
        name: "every request 200",
        holds: rows.every((r) => r.status === 200) && burst.every((r) => r.status === 200),
        detail: JSON.stringify(histogram([...rows, ...burst].map((r) => r.status))),
      },
      {
        name: "warm hot path: exactly 1 Supabase round trip (PATCH) and 0 auth",
        holds: warm.every((r) => r.rest === 1 && r.auth === 0),
        detail: `max auth+rest=${hotPathMax}`,
      },
      {
        name: "cold first request per user: 1 auth + 1 rest",
        holds: rows.slice(0, USERS).every((r) => r.auth === 1 && r.rest === 1),
        detail: JSON.stringify(rows.slice(0, USERS).map((r) => [r.auth, r.rest])),
      },
      {
        name: "≤3 Supabase round trips on every request",
        holds: rows.every((r) => r.auth + r.rest <= 3),
        detail: `max=${Math.max(...rows.map((r) => r.auth + r.rest))}`,
      },
      {
        name: "Redis pipelines per warm request are constant",
        holds: new Set(warm.map((r) => r.redis)).size === 1,
        detail: JSON.stringify(histogram(warm.map((r) => r.redis))),
      },
    ];
    const broken = invariants.filter((i) => !i.holds);
    await writeReport({
      campaign: "onboarding_load_redis_on",
      seed: STRESS_SEED,
      scale: { sequential: rows.length, burst: burst.length, users: USERS },
      replay: replayCommand(FILE, "load"),
      redis: true,
      rows: [...rows, ...burst.map((b) => ({ ...b, burst: true }))],
      aggregates: {
        latencyMsWarm: stats,
        latencyMsCold: latencyStats(rows.slice(0, USERS).map((r) => r.ms)),
        burstWaveMs: latencyStats(burst.filter((_, k) => k % USERS === 0).map((r) => r.ms)),
        roundTripsPerWarmRequest: {
          auth: histogram(warm.map((r) => r.auth)),
          rest: histogram(warm.map((r) => r.rest)),
          redis: histogram(warm.map((r) => r.redis)),
        },
        supabaseRoundTripsPerRequestMax: Math.max(...rows.map((r) => r.auth + r.rest)),
      },
      invariants,
      broken,
      startedAt,
      durationMs: round(performance.now() - t0),
    });
    assertEquals(
      broken.map((i) => `${i.name} [${i.detail}]`),
      [],
    );
  },
);
