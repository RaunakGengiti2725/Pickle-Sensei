// stress-edge-http — FAILURE INJECTION matrix against the REAL edge handler
// (lens `failure-load`). Each case breaks ONE upstream (Supabase Auth,
// PostgREST/DB, RevenueCat) in one way — status / throw / hang-until-abort /
// malformed body / delay — sends one real request, and records:
//
//   • the user-visible class: status, typed error code, generic-body check,
//     Retry-After presence, x-request-id correlation;
//   • upstream round trips made while the fault was active;
//   • RECOVERABILITY: the fault is cleared and the SAME request is replayed —
//     it must succeed, and the per-IP auth-failure budget must not have been
//     charged for an outage (a 503 is never a credential verdict).
//
// Upstash/Redis faults live in stress_faults_redis.test.ts (cache.ts reads
// its endpoint at import, so that matrix needs its own isolate).
//
// Every case is deterministic (no seeded randomness is needed: the fault IS
// the payload); the model behind the fault layer is seeded with STRESS_SEED.
// Results → STRESS_OUT_DIR/fault_matrix.json.
//
// Tests titled `REPRO:` pin behaviour that is OBSERVED today and reported as a
// finding; they are not endorsements.

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { syncShotPayload } from "./xc_concurrency_harness.ts";
import {
  type Answer,
  answer,
  edgeRequest,
  fakeGoogleIdToken,
  type Fault,
  freshIp,
  isRecord,
  jsonResponse,
  loadStressHarness,
  restoreProcessEnv,
  roundTrips,
  snapshotProcessEnv,
  STRESS_SEED,
  type StressHarness,
  type Upstream,
  writeArtifact,
} from "./stress_harness.ts";

// Auth deadline for the hang/throw cases: production default is 6 s; the
// contract (verdict or retryable 503 inside the deadline) is the same.
const AUTH_TIMEOUT_MS = 600;
snapshotProcessEnv();
Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));

const h: StressHarness = await loadStressHarness({
  redis: false,
  seed: STRESS_SEED,
});
const accessLines: string[] = [];
captureAccessLog((line) => accessLines.push(line));

interface Ctx {
  ip: string;
  sub: string;
  accessToken: string;
  refreshToken: string;
  permitId?: string;
}

interface FaultCase {
  id: string;
  upstream: Upstream;
  title: string;
  faults: (ctx: Ctx) => Fault[];
  /** Optional model preparation (e.g. reserve a permit for a sync). */
  prepare?: (ctx: Ctx) => Promise<void>;
  request: (ctx: Ctx) => Request;
  expect: {
    status: number | number[];
    code?: string | null;
    retryAfter?: boolean;
    /** Response must finish inside this many ms (deadline contract). */
    maxMs?: number;
    /** Response cannot finish before this (no deadline → stalls to the cap). */
    minMs?: number;
  };
  /** After the fault clears, the same request must yield this status. */
  recoverStatus?: number | number[];
  /** Extra assertions on the faulted answer / the calls it made. */
  check?: (ctx: Ctx, out: Answer, calls: ReturnType<typeof roundTrips>) => void;
  /** Post-recovery invariant on the model (exactly-once etc.). */
  afterRecovery?: (ctx: Ctx, recovered: Answer) => void;
}

const GENERIC_5XX =
  /temporarily unavailable|Please try again|Try again shortly|could not be reached|Something went wrong/;

const authUser = (_r: Request, op: string) => op === "auth:/user";
const authRefresh = (_r: Request, op: string) =>
  op === "auth:/token?grant_type=refresh_token";
const authIdToken = (_r: Request, op: string) =>
  op === "auth:/token?grant_type=id_token";
const authLogout = (_r: Request, op: string) => op === "auth:/logout";
const rpc = (name: string) => (_r: Request, op: string) =>
  op === `rest:POST rpc/${name}`;
const rest = (method: string, table: string) => (_r: Request, op: string) =>
  op === `rest:${method} ${table}`;

const status = (
  id: string,
  upstream: Upstream,
  match: Fault["match"],
  code: number,
  body = "",
  headers?: Record<string, string>,
): Fault => ({
  id,
  upstream,
  match,
  mode: { kind: "status", status: code, body, headers },
});
const throwFault = (
  id: string,
  upstream: Upstream,
  match: Fault["match"],
  times?: number,
): Fault => ({ id, upstream, match, mode: { kind: "throw" }, times });
const hang = (
  id: string,
  upstream: Upstream,
  match: Fault["match"],
  capMs: number,
): Fault => ({ id, upstream, match, mode: { kind: "hang", capMs } });
const delay = (
  id: string,
  upstream: Upstream,
  match: Fault["match"],
  ms: number,
): Fault => ({ id, upstream, match, mode: { kind: "delay", ms } });
const mutate = (
  id: string,
  upstream: Upstream,
  match: Fault["match"],
  fn: (r: Response) => Response | Promise<Response>,
): Fault => ({
  id,
  upstream,
  match,
  mode: { kind: "mutate", mutate: fn },
});

const me = (ctx: Ctx) =>
  edgeRequest("GET", "/v1/me", { token: ctx.accessToken, ip: ctx.ip });
const access = (ctx: Ctx) =>
  edgeRequest("GET", "/v1/me/access", { token: ctx.accessToken, ip: ctx.ip });
const refresh = (ctx: Ctx) =>
  edgeRequest("POST", "/v1/auth/refresh", {
    ip: ctx.ip,
    body: { refreshToken: ctx.refreshToken },
  });
const bootstrap = (ctx: Ctx) =>
  edgeRequest("POST", "/v1/account/bootstrap", {
    token: fakeGoogleIdToken(ctx.sub),
    ip: ctx.ip,
    body: {},
  });
const logout = (ctx: Ctx) =>
  edgeRequest("POST", "/v1/auth/logout", {
    token: ctx.accessToken,
    ip: ctx.ip,
  });
const permit = (key: string) => (ctx: Ctx) =>
  edgeRequest("POST", "/v1/analysis-permits", {
    token: ctx.accessToken,
    ip: ctx.ip,
    body: { idempotencyKey: key },
  });
const billing = (ctx: Ctx) =>
  edgeRequest("POST", "/v1/billing/sync", {
    token: ctx.accessToken,
    ip: ctx.ip,
    body: {},
  });
const shotId = (ctx: Ctx) =>
  `${ctx.sub.slice(0, 8)}-1111-4111-8111-111111111111`;
const sync = (ctx: Ctx) =>
  edgeRequest("POST", "/v1/shots:sync", {
    token: ctx.accessToken,
    ip: ctx.ip,
    body: { shots: [syncShotPayload(shotId(ctx), ctx.permitId ?? "")] },
  });

async function reservePermit(ctx: Ctx): Promise<void> {
  const out = await answer(h, permit(`prep-${ctx.sub}`)(ctx));
  assertEquals(out.status, 200, `prepare permit: ${out.text}`);
  ctx.permitId = String(
    (isRecord(out.body) && isRecord(out.body.permit) ? out.body.permit : {})
      .id ?? "",
  );
}

function acceptedIds(out: Answer): unknown[] {
  return isRecord(out.body) && Array.isArray(out.body.acceptedIds)
    ? out.body.acceptedIds
    : [];
}

function userShots(ctx: Ctx) {
  return h.fake.tables.shots.filter((row) => row.user_id === ctx.sub);
}
function userPermits(ctx: Ctx) {
  return h.fake.tables.analysis_permits.filter((row) =>
    row.user_id === ctx.sub
  );
}

const CASES: FaultCase[] = [
  // ── Supabase Auth: GET /auth/v1/user (bearer verification) ───────────────
  {
    id: "auth.user.500",
    upstream: "auth",
    title: "GoTrue 500 on bearer verification",
    faults: () => [
      status("auth.user.500", "auth", authUser, 500, '{"msg":"internal"}'),
    ],
    request: me,
    expect: { status: 503, retryAfter: true, maxMs: 2_000 },
    recoverStatus: 200,
  },
  {
    id: "auth.user.502-html",
    upstream: "auth",
    title: "GoTrue 502 gateway HTML page",
    faults: () => [
      status(
        "auth.user.502-html",
        "auth",
        authUser,
        502,
        "<html>bad gateway</html>",
        { "Content-Type": "text/html" },
      ),
    ],
    request: me,
    expect: { status: 503, retryAfter: true },
    recoverStatus: 200,
  },
  {
    id: "auth.user.503-retry-after",
    upstream: "auth",
    title: "GoTrue 503 with Retry-After: 7 propagates the hint",
    faults: () => [
      status("auth.user.503-retry-after", "auth", authUser, 503, "{}", {
        "Content-Type": "application/json",
        "Retry-After": "7",
      }),
    ],
    request: me,
    expect: { status: 503, retryAfter: true },
    recoverStatus: 200,
    check: (_ctx, out) => assertEquals(out.retryAfter, "7"),
  },
  {
    id: "auth.user.429",
    upstream: "auth",
    title:
      "GoTrue 429 (Auth rate limit) is an outage, not a credential verdict",
    faults: () => [
      status(
        "auth.user.429",
        "auth",
        authUser,
        429,
        '{"msg":"over_request_rate_limit"}',
      ),
    ],
    request: me,
    expect: { status: 503, retryAfter: true },
    recoverStatus: 200,
  },
  {
    id: "auth.user.401",
    upstream: "auth",
    title: "GoTrue 401 (bad JWT) → 401 refused",
    faults: () => [
      status(
        "auth.user.401",
        "auth",
        authUser,
        401,
        '{"code":401,"error_code":"bad_jwt","msg":"invalid JWT"}',
      ),
    ],
    request: me,
    expect: { status: 401, retryAfter: false },
    recoverStatus: 200,
  },
  {
    id: "auth.user.403",
    upstream: "auth",
    title: "GoTrue 403 (session_not_found) → 401 refused",
    faults: () => [
      status(
        "auth.user.403",
        "auth",
        authUser,
        403,
        '{"code":403,"error_code":"session_not_found","msg":"gone"}',
      ),
    ],
    request: me,
    expect: { status: 401 },
    recoverStatus: 200,
  },
  {
    id: "auth.user.400",
    upstream: "auth",
    title: "GoTrue 400 → 401 refused",
    faults: () => [
      status(
        "auth.user.400",
        "auth",
        authUser,
        400,
        '{"error":"invalid_request"}',
      ),
    ],
    request: me,
    expect: { status: 401 },
    recoverStatus: 200,
  },
  {
    id: "auth.user.throw",
    upstream: "auth",
    title:
      "GoTrue socket failure on every attempt → retries inside the deadline, then 503",
    faults: () => [throwFault("auth.user.throw", "auth", authUser)],
    request: me,
    expect: { status: 503, retryAfter: true, maxMs: AUTH_TIMEOUT_MS + 400 },
    recoverStatus: 200,
    check: (_ctx, _out, calls) =>
      assert(
        calls.auth >= 2 && calls.auth <= 4,
        `expected 2-4 auth attempts, got ${calls.auth}`,
      ),
  },
  {
    id: "auth.user.throw-once",
    upstream: "auth",
    title: "GoTrue socket failure once → transparent retry → 200",
    faults: () => [throwFault("auth.user.throw-once", "auth", authUser, 1)],
    request: me,
    expect: { status: 200, maxMs: 1_000 },
    recoverStatus: 200,
    check: (_ctx, _out, calls) => assertEquals(calls.auth, 2),
  },
  {
    id: "auth.user.hang",
    upstream: "auth",
    title: "GoTrue never answers → aborted at the deadline → 503",
    faults: () => [hang("auth.user.hang", "auth", authUser, 10_000)],
    request: me,
    expect: {
      status: 503,
      retryAfter: true,
      minMs: AUTH_TIMEOUT_MS - 50,
      maxMs: AUTH_TIMEOUT_MS + 400,
    },
    recoverStatus: 200,
    check: (_ctx, _out, calls) => assertEquals(calls.auth, 1),
  },
  {
    id: "auth.user.200-nonjson",
    upstream: "auth",
    title: "GoTrue 200 with a non-JSON body → 503 (not a verdict)",
    faults: () => [
      status(
        "auth.user.200-nonjson",
        "auth",
        authUser,
        200,
        "<html>ok</html>",
        { "Content-Type": "text/html" },
      ),
    ],
    request: me,
    expect: { status: 503, retryAfter: true },
    recoverStatus: 200,
  },
  {
    id: "auth.user.200-no-id",
    upstream: "auth",
    title: "GoTrue 200 with a user lacking id → 503",
    faults: () => [
      status(
        "auth.user.200-no-id",
        "auth",
        authUser,
        200,
        '{"email":"x@example.com"}',
      ),
    ],
    request: me,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "auth.user.200-null",
    upstream: "auth",
    title: "GoTrue 200 `null` → 503",
    faults: () => [status("auth.user.200-null", "auth", authUser, 200, "null")],
    request: me,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "auth.user.200-array",
    upstream: "auth",
    title: "GoTrue 200 with an array → 503",
    faults: () => [
      status("auth.user.200-array", "auth", authUser, 200, '[{"id":"x"}]'),
    ],
    request: me,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "auth.user.200-other-user",
    upstream: "auth",
    title:
      "GoTrue 200 naming a different user → the route acts as THAT user (trust boundary is GoTrue)",
    faults: (ctx) => [
      mutate(
        "auth.user.200-other-user",
        "auth",
        authUser,
        () =>
          jsonResponse(200, {
            id: "ffffffff-0000-4000-8000-00000000f00d",
            email: null,
            app_metadata: { provider: "google", providers: ["google"] },
          }),
      ),
    ],
    request: access,
    expect: { status: [200, 503] },
    recoverStatus: 200,
    check: (ctx, out) => {
      // Documented, not asserted as a bug: the edge cannot cross-check the
      // sub against GoTrue — it IS the verdict. The user-scoped PostgREST
      // client still bears the ORIGINAL token, so RLS decides what is read.
      assert(out.status === 200 || out.status === 503, `got ${out.status}`);
      void ctx;
    },
  },
  {
    id: "auth.user.slow-within-deadline",
    upstream: "auth",
    title: "GoTrue answers after 300 ms (inside the deadline) → 200",
    faults: () => [delay("auth.user.slow", "auth", authUser, 300)],
    request: me,
    expect: { status: 200, minMs: 290 },
    recoverStatus: 200,
  },

  // ── Supabase Auth: POST /token?grant_type=refresh_token ──────────────────
  {
    id: "auth.refresh.500",
    upstream: "auth",
    title: "refresh: GoTrue 500 → 503 + Retry-After (token still valid)",
    faults: () => [status("auth.refresh.500", "auth", authRefresh, 500, "{}")],
    request: refresh,
    expect: { status: 503, retryAfter: true },
    recoverStatus: 200,
  },
  {
    id: "auth.refresh.400-invalid-grant",
    upstream: "auth",
    title: "refresh: GoTrue 400 invalid_grant → 401 (sign in again)",
    faults: () => [
      status(
        "auth.refresh.400",
        "auth",
        authRefresh,
        400,
        '{"error":"invalid_grant","error_code":"refresh_token_not_found"}',
      ),
    ],
    request: refresh,
    expect: { status: 401 },
    recoverStatus: 200,
  },
  {
    id: "auth.refresh.200-dead-session",
    upstream: "auth",
    title:
      "REPRO refresh: GoTrue ROTATED but answered a dead session → 503; the retry finds the old token burned → 401",
    // GoTrue committed the rotation before the malformed answer reached the
    // edge. The app retries the 503 with the refresh token it still holds;
    // under strict rotation (the model default, and GoTrue outside its reuse
    // interval) that token is already used → 401 → implicit sign-out. The
    // reuse-window variant is measured in the dedicated test below.
    faults: () => [
      mutate("auth.refresh.200-dead", "auth", authRefresh, async (r) => {
        const body = (await r.json()) as Record<string, unknown>;
        return jsonResponse(200, {
          ...body,
          expires_in: 0,
          expires_at: Math.floor(Date.now() / 1000) - 5,
        });
      }),
    ],
    request: refresh,
    expect: { status: 503, retryAfter: true },
    recoverStatus: 401,
  },
  {
    id: "auth.refresh.200-missing-refresh-token",
    upstream: "auth",
    title:
      "REPRO refresh: GoTrue ROTATED but the answer lacks refresh_token → 503; retry → 401",
    faults: () => [
      mutate("auth.refresh.200-norefresh", "auth", authRefresh, async (r) => {
        const body = (await r.json()) as Record<string, unknown>;
        delete body.refresh_token;
        return jsonResponse(200, body);
      }),
    ],
    request: refresh,
    expect: { status: 503 },
    recoverStatus: 401,
  },
  {
    id: "auth.refresh.200-truncated-json",
    upstream: "auth",
    title: "refresh: GoTrue 200 with truncated JSON → 503",
    faults: () => [
      status(
        "auth.refresh.200-trunc",
        "auth",
        authRefresh,
        200,
        '{"access_token":"abc","refresh_to',
      ),
    ],
    request: refresh,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "auth.refresh.throw",
    upstream: "auth",
    title: "refresh: socket failure on every attempt → 503",
    faults: () => [throwFault("auth.refresh.throw", "auth", authRefresh)],
    request: refresh,
    expect: { status: 503, retryAfter: true, maxMs: AUTH_TIMEOUT_MS + 400 },
    recoverStatus: 200,
  },
  {
    id: "auth.refresh.hang",
    upstream: "auth",
    title: "refresh: GoTrue never answers → 503 at the deadline",
    faults: () => [hang("auth.refresh.hang", "auth", authRefresh, 10_000)],
    request: refresh,
    expect: {
      status: 503,
      retryAfter: true,
      minMs: AUTH_TIMEOUT_MS - 50,
      maxMs: AUTH_TIMEOUT_MS + 400,
    },
    recoverStatus: 200,
  },

  // ── Supabase Auth: bootstrap (signInWithIdToken via supabase-js) ─────────
  {
    id: "auth.bootstrap.500",
    upstream: "auth",
    title:
      "REPRO bootstrap: GoTrue 500 on id_token grant is reported as 401 (credential class)",
    faults: () => [
      status(
        "auth.bootstrap.500",
        "auth",
        authIdToken,
        500,
        '{"msg":"internal"}',
      ),
    ],
    request: bootstrap,
    // Observed today (pinned in account_routes.test.ts too): 401, no
    // Retry-After. Expected for an outage: 503 + Retry-After.
    expect: { status: 401, retryAfter: false },
    recoverStatus: 200,
  },
  {
    id: "auth.bootstrap.throw",
    upstream: "auth",
    title: "REPRO bootstrap: GoTrue socket failure on id_token grant → 401",
    faults: () => [throwFault("auth.bootstrap.throw", "auth", authIdToken)],
    request: bootstrap,
    expect: { status: 401, maxMs: 5_000 },
    recoverStatus: 200,
  },
  {
    id: "auth.bootstrap.hang",
    upstream: "auth",
    title:
      "bootstrap: GoTrue never answers the id_token grant — how long does the client wait?",
    faults: () => [hang("auth.bootstrap.hang", "auth", authIdToken, 1_500)],
    request: bootstrap,
    // supabase-js passes no AbortSignal → the request stalls until the fake's
    // cap (1.5 s here; unbounded in production) and then reads as 401.
    expect: { status: 401, minMs: 1_400 },
    recoverStatus: 200,
  },
  {
    id: "auth.bootstrap.400",
    upstream: "auth",
    title: "bootstrap: GoTrue 400 invalid id token → 401",
    faults: () => [
      status(
        "auth.bootstrap.400",
        "auth",
        authIdToken,
        400,
        '{"error":"invalid_grant","error_description":"bad id token"}',
      ),
    ],
    request: bootstrap,
    expect: { status: 401 },
    recoverStatus: 200,
  },
  {
    id: "auth.bootstrap.200-nonjson",
    upstream: "auth",
    title: "bootstrap: GoTrue 200 with non-JSON → 401",
    faults: () => [
      status(
        "auth.bootstrap.200-nonjson",
        "auth",
        authIdToken,
        200,
        "<html>",
      ),
    ],
    request: bootstrap,
    expect: { status: [401, 503] },
    recoverStatus: 200,
  },

  // ── Supabase Auth: logout ────────────────────────────────────────────────
  {
    id: "auth.logout.500",
    upstream: "auth",
    title:
      "logout: GoTrue 500 → 503 (no Retry-After on this path), and the bearer keeps working (nothing half-revoked)",
    faults: () => [status("auth.logout.500", "auth", authLogout, 500, "{}")],
    request: logout,
    expect: { status: 503 },
    recoverStatus: 204,
  },
  {
    id: "auth.logout.throw",
    upstream: "auth",
    title: "logout: socket failure → 503",
    faults: () => [throwFault("auth.logout.throw", "auth", authLogout)],
    request: logout,
    expect: { status: 503, maxMs: AUTH_TIMEOUT_MS + 400 },
    recoverStatus: 204,
  },
  {
    id: "auth.logout.404",
    upstream: "auth",
    title: "logout: GoTrue 404 (session already gone) → 204 idempotent",
    faults: () => [
      status(
        "auth.logout.404",
        "auth",
        authLogout,
        404,
        '{"msg":"not found"}',
      ),
    ],
    request: logout,
    expect: { status: [204, 401, 503] },
    recoverStatus: [204, 401],
  },

  // ── PostgREST / DB ───────────────────────────────────────────────────────
  {
    id: "rest.access_state.500",
    upstream: "rest",
    title: "access_state RPC 500 → 503 generic",
    faults: () => [
      status(
        "rest.access_state.500",
        "rest",
        rpc("access_state"),
        500,
        '{"code":"XX000","message":"internal db error: secret detail"}',
      ),
    ],
    request: access,
    expect: { status: 503 },
    recoverStatus: 200,
    check: (_ctx, out) =>
      assert(
        !out.text.includes("secret detail"),
        "5xx body leaked upstream detail",
      ),
  },
  {
    id: "rest.access_state.401-jwt-expired",
    upstream: "rest",
    title: "access_state PostgREST 401 PGRST301 (JWT expired mid-request)",
    faults: () => [
      status(
        "rest.access_state.401",
        "rest",
        rpc("access_state"),
        401,
        '{"code":"PGRST301","message":"JWT expired"}',
      ),
    ],
    request: access,
    expect: { status: [401, 503] },
    recoverStatus: 200,
  },
  {
    id: "rest.access_state.200-empty",
    upstream: "rest",
    title: "access_state 200 `[]` (no row) → 503",
    faults: () => [
      status(
        "rest.access_state.200-empty",
        "rest",
        rpc("access_state"),
        200,
        "[]",
      ),
    ],
    request: access,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rest.access_state.200-null",
    upstream: "rest",
    title: "access_state 200 `null` → 503",
    faults: () => [
      status(
        "rest.access_state.200-null",
        "rest",
        rpc("access_state"),
        200,
        "null",
      ),
    ],
    request: access,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rest.access_state.200-nonjson",
    upstream: "rest",
    title: "access_state 200 non-JSON → 503",
    faults: () => [
      status(
        "rest.access_state.200-nonjson",
        "rest",
        rpc("access_state"),
        200,
        "<html>",
        { "Content-Type": "text/html" },
      ),
    ],
    request: access,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rest.access_state.200-wrong-shape",
    upstream: "rest",
    title:
      "access_state 200 with strings instead of numbers → still a 200 (coerced) or 503, never 500",
    faults: () => [
      status(
        "rest.access_state.200-shape",
        "rest",
        rpc("access_state"),
        200,
        '[{"premium":"yes","scored_count":"two","reserved_count":null}]',
      ),
    ],
    request: access,
    expect: { status: [200, 503] },
    recoverStatus: 200,
  },
  {
    id: "rest.access_state.throw",
    upstream: "rest",
    title: "PostgREST socket failure → 503",
    faults: () => [
      throwFault("rest.access_state.throw", "rest", rpc("access_state")),
    ],
    request: access,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rest.access_state.hang",
    upstream: "rest",
    title:
      "PostgREST never answers — the route has no deadline (stalls to the cap)",
    faults: () => [
      hang("rest.access_state.hang", "rest", rpc("access_state"), 1_500),
    ],
    request: access,
    expect: { status: 503, minMs: 1_400 },
    recoverStatus: 200,
  },
  {
    id: "rest.profiles.500",
    upstream: "rest",
    title: "GET /v1/me: profiles 500 → 503",
    faults: () => [
      status(
        "rest.profiles.500",
        "rest",
        rest("GET", "profiles"),
        500,
        '{"message":"boom"}',
      ),
    ],
    request: me,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rest.profiles.200-empty",
    upstream: "rest",
    title:
      "GET /v1/me: profiles 200 `[]` (row not yet visible) → bounded re-read then 503",
    faults: () => [
      status(
        "rest.profiles.200-empty",
        "rest",
        rest("GET", "profiles"),
        200,
        "[]",
      ),
    ],
    request: me,
    expect: { status: [200, 503] },
    recoverStatus: 200,
  },
  {
    id: "rest.profiles.200-html",
    upstream: "rest",
    title: "GET /v1/me: profiles 200 HTML → 503",
    faults: () => [
      status(
        "rest.profiles.200-html",
        "rest",
        rest("GET", "profiles"),
        200,
        "<html>",
        { "Content-Type": "text/html" },
      ),
    ],
    request: me,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rest.reserve.500",
    upstream: "rest",
    title:
      "reserve_analysis_permit 500 → 503; replay with the same key reserves exactly once",
    faults: () => [
      status(
        "rest.reserve.500",
        "rest",
        rpc("reserve_analysis_permit"),
        500,
        '{"code":"40P01","message":"deadlock detected"}',
      ),
    ],
    request: permit("k-reserve-500"),
    expect: { status: 503 },
    recoverStatus: 200,
    afterRecovery: (ctx) =>
      assertEquals(
        userPermits(ctx).length,
        1,
        "exactly one permit after recovery",
      ),
  },
  {
    id: "rest.reserve.200-empty",
    upstream: "rest",
    title: "reserve_analysis_permit 200 `[]` → 503",
    faults: () => [
      status(
        "rest.reserve.200-empty",
        "rest",
        rpc("reserve_analysis_permit"),
        200,
        "[]",
      ),
    ],
    request: permit("k-reserve-empty"),
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rest.reserve.200-garbage-outcome",
    upstream: "rest",
    title:
      "reserve_analysis_permit 200 with an unknown outcome string → 503, never 500",
    faults: () => [
      mutate(
        "rest.reserve.200-garbage",
        "rest",
        rpc("reserve_analysis_permit"),
        async (r) => {
          const body = (await r.json()) as
            | Array<Record<string, unknown>>
            | Record<string, unknown>;
          const row = Array.isArray(body) ? body[0] : body;
          return jsonResponse(
            200,
            Array.isArray(body)
              ? [{ ...row, outcome: "weird", permit_status: 42 }]
              : { ...row, outcome: "weird", permit_status: 42 },
          );
        },
      ),
    ],
    request: permit("k-reserve-garbage"),
    expect: { status: [200, 503] },
    recoverStatus: 200,
  },
  {
    id: "rest.reserve.then-access-500",
    upstream: "rest",
    title:
      "reserve succeeds but the follow-up access_state 500s → 503; same key replays to the SAME permit",
    faults: () => [
      status(
        "rest.reserve.access.500",
        "rest",
        rpc("access_state"),
        500,
        "{}",
      ),
    ],
    request: permit("k-reserve-access-500"),
    expect: { status: 503 },
    recoverStatus: 200,
    afterRecovery: (ctx, recovered) => {
      assertEquals(
        userPermits(ctx).length,
        1,
        "the reservation was not duplicated by the replay",
      );
      const permitBody =
        isRecord(recovered.body) && isRecord(recovered.body.permit)
          ? recovered.body.permit
          : {};
      assertEquals(permitBody.id, userPermits(ctx)[0].id);
    },
  },
  {
    id: "rest.shots.replay-lookup.500",
    upstream: "rest",
    title:
      "shots:sync — replay lookup 500 → 503 whole batch; replay writes exactly once",
    prepare: reservePermit,
    faults: () => [
      status(
        "rest.shots.lookup.500",
        "rest",
        rest("GET", "shots"),
        500,
        '{"message":"boom"}',
      ),
    ],
    request: sync,
    expect: { status: 503 },
    recoverStatus: 200,
    afterRecovery: (ctx) => assertEquals(userShots(ctx).length, 1),
  },
  {
    id: "rest.apply_synced_shot.500",
    upstream: "rest",
    title:
      "apply_synced_shot 500 → per-shot rejection (write_failed), nothing written; replay accepts once",
    prepare: reservePermit,
    faults: () => [
      status(
        "rest.apply.500",
        "rest",
        rpc("apply_synced_shot"),
        500,
        '{"code":"XX000","message":"boom"}',
      ),
    ],
    request: sync,
    expect: { status: [200, 503] },
    recoverStatus: 200,
    check: (ctx, out) => {
      assertEquals(
        userShots(ctx).length,
        0,
        "nothing persisted while the RPC failed",
      );
      if (out.status === 200) {
        const rejected = isRecord(out.body) && Array.isArray(out.body.rejected)
          ? out.body.rejected
          : [];
        assertEquals(
          rejected.length,
          1,
          `expected the shot rejected: ${out.text.slice(0, 200)}`,
        );
      }
    },
    afterRecovery: (ctx, recovered) => {
      assertEquals(userShots(ctx).length, 1, "exactly one shot after recovery");
      assertEquals(
        acceptedIds(recovered),
        [shotId(ctx)],
        recovered.text.slice(0, 200),
      );
    },
  },
  {
    id: "rest.apply_synced_shot.200-unknown-status",
    upstream: "rest",
    title: "apply_synced_shot 200 with an unknown status → rejected, not 500",
    prepare: reservePermit,
    faults: () => [
      status(
        "rest.apply.200-unknown",
        "rest",
        rpc("apply_synced_shot"),
        200,
        '[{"status":"???"}]',
      ),
    ],
    request: sync,
    expect: { status: [200, 503] },
    recoverStatus: 200,
  },
  {
    id: "rest.apply_synced_shot.200-html",
    upstream: "rest",
    title: "apply_synced_shot 200 HTML → rejected/503, not 500",
    prepare: reservePermit,
    faults: () => [
      status(
        "rest.apply.200-html",
        "rest",
        rpc("apply_synced_shot"),
        200,
        "<html>",
        { "Content-Type": "text/html" },
      ),
    ],
    request: sync,
    expect: { status: [200, 503] },
    recoverStatus: 200,
  },
  {
    id: "rest.apply_synced_shot.throw",
    upstream: "rest",
    title:
      "apply_synced_shot socket failure → rejected/503; replay writes exactly once",
    prepare: reservePermit,
    faults:
      () => [throwFault("rest.apply.throw", "rest", rpc("apply_synced_shot"))],
    request: sync,
    expect: { status: [200, 503] },
    recoverStatus: 200,
    afterRecovery: (ctx) => assertEquals(userShots(ctx).length, 1),
  },
  {
    id: "rest.apply_synced_shot.accepted-then-network-lost",
    upstream: "rest",
    title:
      "apply_synced_shot COMMITS but the answer is lost (throw after write) → client retries → exactly one shot",
    prepare: reservePermit,
    faults: () => [
      mutate("rest.apply.commit-lost", "rest", rpc("apply_synced_shot"), () => {
        throw new TypeError("stress: connection reset after commit");
      }),
    ],
    request: sync,
    expect: { status: [200, 503] },
    recoverStatus: 200,
    afterRecovery: (ctx, recovered) => {
      assertEquals(
        userShots(ctx).length,
        1,
        "duplicate delivery must not double-write",
      );
      assertEquals(
        acceptedIds(recovered),
        [shotId(ctx)],
        `replay must be accepted (idempotent): ${recovered.text.slice(0, 200)}`,
      );
    },
  },

  // ── RevenueCat ───────────────────────────────────────────────────────────
  {
    id: "rc.500",
    upstream: "rc",
    title: "RevenueCat 500 → 502 billing_unavailable",
    faults:
      () => [status("rc.500", "rc", undefined, 500, '{"message":"internal"}')],
    request: billing,
    expect: { status: 502, code: "billing_unavailable" },
    recoverStatus: 200,
  },
  {
    id: "rc.429",
    upstream: "rc",
    title: "RevenueCat 429 → 502 billing_unavailable",
    faults: () => [status("rc.429", "rc", undefined, 429, "{}")],
    request: billing,
    expect: { status: 502, code: "billing_unavailable" },
    recoverStatus: 200,
  },
  {
    id: "rc.throw",
    upstream: "rc",
    title: "RevenueCat socket failure → 502",
    faults: () => [throwFault("rc.throw", "rc", undefined)],
    request: billing,
    expect: { status: 502, code: "billing_unavailable" },
    recoverStatus: 200,
  },
  {
    id: "rc.hang",
    upstream: "rc",
    title:
      "RevenueCat never answers — 10 s AbortSignal.timeout is the only bound (stalls to the cap)",
    faults: () => [hang("rc.hang", "rc", undefined, 1_500)],
    request: billing,
    expect: { status: 502, code: "billing_unavailable", minMs: 1_400 },
    recoverStatus: 200,
  },
  {
    id: "rc.200-nonjson",
    upstream: "rc",
    title: "RevenueCat 200 non-JSON → 502",
    faults: () => [
      status("rc.200-nonjson", "rc", undefined, 200, "<html>", {
        "Content-Type": "text/html",
      }),
    ],
    request: billing,
    expect: { status: 502, code: "billing_unavailable" },
    recoverStatus: 200,
  },
  {
    id: "rc.200-null-subscriber",
    upstream: "rc",
    title: "RevenueCat 200 {subscriber:null} → 502",
    faults: () => [
      status("rc.200-null", "rc", undefined, 200, '{"subscriber":null}'),
    ],
    request: billing,
    expect: { status: 502, code: "billing_unavailable" },
    recoverStatus: 200,
  },
  {
    id: "rc.200-entitlements-not-object",
    upstream: "rc",
    title:
      'RevenueCat 200 entitlements:"nope" → 200 premium:false (never grants)',
    faults: () => [
      status(
        "rc.200-ent-string",
        "rc",
        undefined,
        200,
        '{"subscriber":{"entitlements":"nope"}}',
      ),
    ],
    request: billing,
    expect: { status: 200 },
    recoverStatus: 200,
    check: (_ctx, out) =>
      assertEquals(
        (isRecord(out.body) && isRecord(out.body.billing)
          ? out.body.billing
          : {}).premium,
        false,
      ),
  },
  {
    id: "rc.200-garbage-expiry",
    upstream: "rc",
    title:
      "RevenueCat 200 pickle_sensei_pro with expires_date garbage → premium:false",
    faults: () => [
      status(
        "rc.200-garbage-expiry",
        "rc",
        undefined,
        200,
        '{"subscriber":{"entitlements":{"pickle_sensei_pro":{"expires_date":"not-a-date","product_identifier":"pickle_sensei_pro_monthly"}}}}',
      ),
    ],
    request: billing,
    expect: { status: 200 },
    recoverStatus: 200,
    check: (_ctx, out) =>
      assertEquals(
        (isRecord(out.body) && isRecord(out.body.billing)
          ? out.body.billing
          : {}).premium,
        false,
      ),
  },
  {
    id: "rc.200-expired",
    upstream: "rc",
    title: "RevenueCat 200 entitlement expired yesterday → premium:false",
    faults: () => [
      status(
        "rc.200-expired",
        "rc",
        undefined,
        200,
        `{"subscriber":{"entitlements":{"pickle_sensei_pro":{"expires_date":"${
          new Date(Date.now() - 86_400_000).toISOString()
        }"}}}}`,
      ),
    ],
    request: billing,
    expect: { status: 200 },
    recoverStatus: 200,
    check: (_ctx, out) =>
      assertEquals(
        (isRecord(out.body) && isRecord(out.body.billing)
          ? out.body.billing
          : {}).premium,
        false,
      ),
  },
  {
    id: "rc.200-then-persist-500",
    upstream: "rest",
    title:
      "RevenueCat OK but billing_entitlements upsert 500 → 503 (verdict not half-applied)",
    faults: () => [
      status(
        "rc.persist.500",
        "rest",
        rest("POST", "billing_entitlements"),
        500,
        '{"message":"boom"}',
      ),
    ],
    request: billing,
    expect: { status: 503 },
    recoverStatus: 200,
  },
  {
    id: "rc.200-huge-body",
    upstream: "rc",
    title: "RevenueCat 200 with a 2 MB entitlement map → 200, bounded time",
    faults: () => [
      status(
        "rc.200-huge",
        "rc",
        undefined,
        200,
        `{"subscriber":{"entitlements":{${
          Array.from(
            { length: 20_000 },
            (_, i) => `"e${i}":{"expires_date":null}`,
          ).join(",")
        }}}}`,
      ),
    ],
    request: billing,
    expect: { status: 200, maxMs: 2_000 },
    recoverStatus: 200,
    check: (_ctx, out) =>
      assertEquals(
        (isRecord(out.body) && isRecord(out.body.billing)
          ? out.body.billing
          : {}).premium,
        false,
      ),
  },
];

interface CaseResult {
  id: string;
  upstream: Upstream;
  title: string;
  faulted: {
    status: number;
    code: string | null;
    retryAfter: string | null;
    requestId: string | null;
    durationMs: number;
    roundTrips: ReturnType<typeof roundTrips>;
    genericBody: boolean;
    message: string | null;
  };
  recovered: {
    status: number;
    durationMs: number;
    roundTrips: ReturnType<typeof roundTrips>;
  } | null;
  verdict: "HELD" | "REPRO" | "FAILED";
  error?: string;
}

async function runCase(fc: FaultCase, index: number): Promise<CaseResult> {
  const ip = freshIp();
  const sub = `${
    (0x10000000 + index).toString(16)
  }-0000-4000-8000-0000000000aa`;
  h.clearFaults();
  const bootRequest = edgeRequest("POST", "/v1/account/bootstrap", {
    token: fakeGoogleIdToken(sub),
    ip,
    body: {},
  });
  const boot = await answer(h, bootRequest);
  assertEquals(
    boot.status,
    200,
    `bootstrap for ${fc.id}: ${boot.text.slice(0, 200)}`,
  );
  const session = isRecord(boot.body) && isRecord(boot.body.session)
    ? boot.body.session
    : {};
  const ctx: Ctx = {
    ip,
    sub,
    accessToken: String(session.accessToken),
    refreshToken: String(session.refreshToken),
  };
  if (fc.prepare) await fc.prepare(ctx);
  // Warm the auth cache for the bearer so PostgREST/RC cases isolate their
  // upstream (auth cases bypass this by using a fresh bearer below).
  if (fc.upstream !== "auth") {
    const warm = await answer(
      h,
      edgeRequest("GET", "/v1/me/consent/status", {
        token: ctx.accessToken,
        ip,
      }),
    );
    assertEquals(
      warm.status,
      200,
      `warm-up for ${fc.id}: ${warm.text.slice(0, 200)}`,
    );
  } else if (
    !fc.id.startsWith("auth.refresh") && !fc.id.startsWith("auth.bootstrap")
  ) {
    // A bearer the cache has never seen: rotate so verification MUST hit GoTrue.
    const rotated = await answer(h, refresh(ctx));
    assertEquals(
      rotated.status,
      200,
      `rotate for ${fc.id}: ${rotated.text.slice(0, 200)}`,
    );
    const s = isRecord(rotated.body) && isRecord(rotated.body.session)
      ? rotated.body.session
      : {};
    ctx.accessToken = String(s.accessToken);
    ctx.refreshToken = String(s.refreshToken);
  }

  h.setFaults(fc.faults(ctx));
  const mark = h.mark();
  const out = await answer(h, fc.request(ctx));
  const calls = roundTrips(h.since(mark));
  h.clearFaults();

  const result: CaseResult = {
    id: fc.id,
    upstream: fc.upstream,
    title: fc.title,
    faulted: {
      status: out.status,
      code: out.code,
      retryAfter: out.retryAfter,
      requestId: out.requestId,
      durationMs: out.durationMs,
      roundTrips: calls,
      genericBody: out.status < 500 || GENERIC_5XX.test(out.message ?? ""),
      message: out.message,
    },
    recovered: null,
    verdict: fc.title.startsWith("REPRO") ? "REPRO" : "HELD",
  };
  try {
    const wanted = Array.isArray(fc.expect.status)
      ? fc.expect.status
      : [fc.expect.status];
    assert(
      wanted.includes(out.status),
      `${fc.id}: status ${out.status} not in ${wanted} — ${
        out.text.slice(0, 200)
      }`,
    );
    if (fc.expect.code !== undefined) {
      assertEquals(out.code, fc.expect.code, `${fc.id}: code`);
    }
    if (fc.expect.retryAfter === true) {
      assert(out.retryAfter !== null, `${fc.id}: Retry-After missing`);
    }
    if (fc.expect.retryAfter === false) {
      assertEquals(out.retryAfter, null, `${fc.id}: unexpected Retry-After`);
    }
    if (fc.expect.maxMs !== undefined) {
      assert(
        out.durationMs <= fc.expect.maxMs,
        `${fc.id}: took ${out.durationMs} ms > ${fc.expect.maxMs}`,
      );
    }
    if (fc.expect.minMs !== undefined) {
      assert(
        out.durationMs >= fc.expect.minMs,
        `${fc.id}: took ${out.durationMs} ms < ${fc.expect.minMs}`,
      );
    }
    assert(
      out.requestId && /^[A-Za-z0-9._-]{8,64}$/.test(out.requestId),
      `${fc.id}: x-request-id missing`,
    );
    if (out.status >= 500) {
      assert(
        result.faulted.genericBody,
        `${fc.id}: 5xx body not generic: ${out.text.slice(0, 200)}`,
      );
      assert(
        out.contentType?.includes("application/json"),
        `${fc.id}: 5xx not JSON`,
      );
    }
    fc.check?.(ctx, out, calls);

    if (fc.recoverStatus !== undefined) {
      const mark2 = h.mark();
      const recovered = await answer(h, fc.request(ctx));
      result.recovered = {
        status: recovered.status,
        durationMs: recovered.durationMs,
        roundTrips: roundTrips(h.since(mark2)),
      };
      const wantedR = Array.isArray(fc.recoverStatus)
        ? fc.recoverStatus
        : [fc.recoverStatus];
      assert(
        wantedR.includes(recovered.status),
        `${fc.id}: recovery status ${recovered.status} not in ${wantedR} — ${
          recovered.text.slice(0, 200)
        }`,
      );
      fc.afterRecovery?.(ctx, recovered);
    }
  } catch (error) {
    result.verdict = "FAILED";
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

Deno.test("stress/faults: ≥40 upstream fault cases — user-visible class + recoverability (real handler)", async () => {
  const results: CaseResult[] = [];
  for (const [index, fc] of CASES.entries()) {
    results.push(await runCase(fc, index + 1));
  }
  const failed = results.filter((r) => r.verdict === "FAILED");
  const table = {
    campaign: "fault_matrix",
    seed: STRESS_SEED,
    authTimeoutMs: AUTH_TIMEOUT_MS,
    cases: results.length,
    byUpstream: results.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.upstream]: (acc[r.upstream] ?? 0) + 1 }),
      {},
    ),
    held: results.filter((r) => r.verdict === "HELD").length,
    repro: results.filter((r) => r.verdict === "REPRO").map((r) => r.id),
    failed: failed.map((r) => ({ id: r.id, error: r.error })),
    results,
  };
  const path = await writeArtifact("fault_matrix.json", table);
  await writeArtifact("fault_matrix_access_log.jsonl", accessLines.join("\n"));
  console.log(
    `[stress/faults] ${results.length} cases, ${failed.length} failed → ${path}`,
  );
  assert(results.length >= 40, `only ${results.length} fault cases`);
  assertEquals(failed.map((r) => `${r.id}: ${r.error}`), []);
});

// ── Refresh rotation committed upstream, answer lost ────────────────────────

Deno.test("REPRO: refresh answer lost after GoTrue rotated — strict rotation signs the user out on retry; a reuse window recovers", async () => {
  const runs: Array<Record<string, unknown>> = [];
  for (
    const policy of ["rotate-reject-reuse", "rotate-reuse-window"] as const
  ) {
    const ip = freshIp();
    const sub = policy === "rotate-reject-reuse"
      ? "0000abcd-0000-4000-8000-0000000000e1"
      : "0000abcd-0000-4000-8000-0000000000e2";
    h.clearFaults();
    h.fake.refreshPolicy = policy;
    const boot = await answer(
      h,
      edgeRequest("POST", "/v1/account/bootstrap", {
        token: fakeGoogleIdToken(sub),
        ip,
        body: {},
      }),
    );
    assertEquals(boot.status, 200);
    const refreshToken = String(
      (boot.body as { session: { refreshToken: string } }).session.refreshToken,
    );
    // GoTrue rotates, but the bytes never arrive intact (reset mid-body).
    h.setFaults([
      mutate("refresh.answer-lost", "auth", authRefresh, () => {
        throw new TypeError("stress: connection reset after GoTrue rotated");
      }),
    ]);
    const lost = await answer(
      h,
      edgeRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken } }),
    );
    h.clearFaults();
    const retry = await answer(
      h,
      edgeRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken } }),
    );
    runs.push({
      policy,
      lost: lost.status,
      lostRetryAfter: lost.retryAfter,
      retry: retry.status,
      retryMessage: retry.message,
    });
    assertEquals(
      lost.status,
      503,
      `${policy}: lost answer must read as retryable`,
    );
    assertEquals(
      retry.status,
      policy === "rotate-reject-reuse" ? 401 : 200,
      `${policy}: retry`,
    );
  }
  h.fake.refreshPolicy = "rotate-reject-reuse";
  await writeArtifact("fault_refresh_answer_lost.json", runs);
});

// ── Budget: an Auth outage must not trip the per-IP auth-failure limiter ─────

Deno.test("stress/faults: 35 requests during a GoTrue outage do not trip the auth-failure budget (503s are not 401s)", async () => {
  const ip = freshIp();
  const sub = "0000feed-0000-4000-8000-0000000000bb";
  h.clearFaults();
  const boot = await answer(
    h,
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(sub),
      ip,
      body: {},
    }),
  );
  assertEquals(boot.status, 200);
  const rotated = await answer(
    h,
    edgeRequest("POST", "/v1/auth/refresh", {
      ip,
      body: {
        refreshToken: String(
          (boot.body as { session: { refreshToken: string } }).session
            .refreshToken,
        ),
      },
    }),
  );
  const token = String(
    (rotated.body as { session: { accessToken: string } }).session.accessToken,
  );
  h.setFaults([status("outage", "auth", authUser, 503, "{}")]);
  const statuses: number[] = [];
  for (let i = 0; i < 35; i += 1) {
    statuses.push(
      (await answer(h, edgeRequest("GET", "/v1/me", { token, ip }))).status,
    );
  }
  h.clearFaults();
  const after = await answer(h, edgeRequest("GET", "/v1/me", { token, ip }));
  await writeArtifact("fault_outage_budget.json", {
    statuses,
    afterOutage: after.status,
  });
  assertEquals(new Set(statuses), new Set([503]));
  assertEquals(
    after.status,
    200,
    `IP locked out after an outage: ${after.status} ${
      after.text.slice(0, 120)
    }`,
  );
});

Deno.test("REPRO: 30 bootstraps during a GoTrue outage lock the IP out for 5 min (401s charge the auth-failure budget)", async () => {
  // Observed today: bootstrap maps an id_token-grant 5xx to 401, and every
  // 401 charges the per-IP auth-failure budget (AUTH_FAILURE_LIMIT 30/300 s).
  // A club Wi-Fi NAT with 30 sign-in attempts during a 30-second GoTrue blip
  // is then refused with 429 for five minutes AFTER GoTrue recovers.
  const ip = freshIp();
  h.clearFaults();
  h.setFaults([status("outage", "auth", authIdToken, 503, "{}")]);
  const statuses: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    const sub = `0000f${
      String(i).padStart(3, "0")
    }-0000-4000-8000-0000000000cc`;
    statuses.push(
      (await answer(
        h,
        edgeRequest("POST", "/v1/account/bootstrap", {
          token: fakeGoogleIdToken(sub),
          ip,
          body: {},
        }),
      )).status,
    );
  }
  h.clearFaults();
  const after = await answer(
    h,
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken("0000ffff-0000-4000-8000-0000000000cc"),
      ip,
      body: {},
    }),
  );
  await writeArtifact("fault_bootstrap_outage_lockout.json", {
    statuses,
    afterOutage: { status: after.status, retryAfter: after.retryAfter },
  });
  assertEquals(new Set(statuses), new Set([401]));
  assertEquals(after.status, 429);
  assert(after.retryAfter !== null);
});

// ── Body size caps through the real handler ──────────────────────────────────

Deno.test("stress/faults: request body caps — declared and streamed oversize bodies are 413, 5 MB minus one byte is parsed", async () => {
  const ip = freshIp();
  const sub = "0000cafe-0000-4000-8000-0000000000dd";
  h.clearFaults();
  const boot = await answer(
    h,
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(sub),
      ip,
      body: {},
    }),
  );
  const token = String(
    (boot.body as { session: { accessToken: string } }).session.accessToken,
  );
  const declared = await answer(
    h,
    edgeRequest("POST", "/v1/shots:sync", {
      token,
      ip,
      rawBody: "{}",
      headers: { "content-length": "5000001" },
    }),
  );
  assertEquals(declared.status, 413);
  const big = `{"shots":[],"pad":"${"x".repeat(5_000_000)}"}`;
  const streamed = await answer(
    h,
    edgeRequest("POST", "/v1/shots:sync", { token, ip, rawBody: big }),
  );
  assertEquals(streamed.status, 413);
  const justUnder = `{"shots":[],"pad":"${"x".repeat(5_000_000 - 22)}"}`;
  assert(new TextEncoder().encode(justUnder).byteLength < 5_000_000);
  const under = await answer(
    h,
    edgeRequest("POST", "/v1/shots:sync", { token, ip, rawBody: justUnder }),
  );
  assert(
    under.status === 200 || under.status === 400,
    `${under.status} ${under.text.slice(0, 120)}`,
  );
  const unicodeBody = `{"shots":[],"pad":"${"😀".repeat(1_250_001)}"}`; // 5,000,004 bytes, 2.5M UTF-16 units
  const unicode = await answer(
    h,
    edgeRequest("POST", "/v1/shots:sync", { token, ip, rawBody: unicodeBody }),
  );
  assertEquals(
    unicode.status,
    413,
    "byte cap must count UTF-8 bytes, not UTF-16 units",
  );
  await writeArtifact("fault_body_caps.json", {
    declared: declared.status,
    streamed: { status: streamed.status, ms: streamed.durationMs },
    justUnder: { status: under.status, ms: under.durationMs },
    unicodeOver: { status: unicode.status, ms: unicode.durationMs },
  });
});

Deno.test("stress: restore the process environment for the suites that run after this module", () => {
  restoreProcessEnv();
});
