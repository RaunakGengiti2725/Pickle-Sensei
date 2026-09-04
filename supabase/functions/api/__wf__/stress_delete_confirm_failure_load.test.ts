/**
 * STRESS — `POST /v1/me/delete-confirm`, lens `failure-load`.
 *
 * Part 1 (always on): a seeded FAULT MATRIX — every upstream the route talks
 * to (Supabase Auth getUser, Supabase Auth admin deleteUser, PostgREST as the
 * user and as the service role, Upstash Redis, RevenueCat, Apple) is made to
 * fail / stall / answer malformed in turn, and for every case the harness
 * asserts (a) the user-visible error class (status, error.code, generic 5xx
 * body, Retry-After), (b) that nothing destructive ran downstream of the
 * fault, and (c) recoverability: the SAME request replayed once the upstream
 * is healthy completes the deletion (or yields the contractually correct
 * verdict). Cases whose contract expectation is known to differ from today's
 * behaviour carry `today` — the assertion pins current behaviour (like the
 * `REPRO:` tests in account_routes.test.ts) and the JSON table marks them
 * BROKEN so the suite stays green while the finding stays visible.
 *
 * Part 2 (scaled by STRESS_ITER, default 150; the report used 1000+): a load
 * campaign through the real handler — distinct seeded users/IPs, bounded
 * concurrency — recording p50/p95/p99 latency and Supabase / Upstash /
 * provider round trips PER REQUEST for the cold-auth and warm-auth paths and
 * for a Redis outage.
 *
 * Replay:  STRESS_SEED=<n> STRESS_ONLY=<case id> deno test -A --no-check \
 *            --config deno.json stress_delete_confirm_failure_load.test.ts
 * Output:  <STRESS_OUT | artifacts/stress-delete-confirm/latest/>/
 *            fault_matrix.json, load.json, duplicates.json
 */
import { assert, assertEquals } from "@std/assert";
import {
  AUTH_TIMEOUT_MS,
  type CallRecord,
  envInt,
  type FakeUser,
  fault,
  type FaultSpec,
  fnv1a,
  type Harness,
  latencySummary,
  loadStressHarness,
  match,
  Prng,
  STRESS_SEED,
  type Upstream,
  writeJson,
} from "./stress_delete_confirm_harness.ts";

const ONLY = Deno.env.get("STRESS_ONLY") ?? "";
const STRESS_ITER = envInt("STRESS_ITER", 150);
/** How long a hanging stub stalls before answering. Raise it (e.g. 6000) to
 * show that the un-deadlined stages track the stall linearly. */
const HANG_MS = envInt("STRESS_HANG_MS", 1_500);

const GENERIC_DELETION_503 = "Account deletion is temporarily unavailable. Please try again.";
const GENERIC_SESSION_503 = "Session verification is temporarily unavailable. Please try again.";
const SESSION_INVALID_401 = "The session is no longer valid. Sign in again.";

interface Expect {
  status: number;
  code?: string;
  message?: string;
  retryAfter?: string;
  /** Expected `appleAuthorizationRevocation` on a 200. */
  apple?: "revoked" | "not_applicable" | "manual_action_required";
}

interface Ctx {
  h: Harness;
  prng: Prng;
  user: FakeUser;
  sessionId: string;
  bearer: string;
  ip: string;
  challenge: string;
}

interface FaultCase {
  id: string;
  upstream: Upstream;
  stage: string;
  provider?: "apple" | "google";
  appleToken?: "valid" | "wrong_key" | "none";
  /** Age of the pending challenge row (ms). Default 5 000 (past the 3 s gate). */
  rowAgeMs?: number;
  rowTtlMs?: number;
  /** Omit the deletion row entirely. */
  noRow?: boolean;
  setup?: (ctx: Ctx) => void | Promise<void>;
  teardown?: (ctx: Ctx) => void;
  faults: (ctx: Ctx) => FaultSpec[];
  /** Contract for the faulted attempt. */
  expect: Expect;
  /** Today's behaviour when it differs from the contract (pinned; → BROKEN). */
  today?: Expect;
  /** Upstreams that must NOT be reached during the faulted attempt. */
  forbid?: Upstream[];
  /** Faulted attempt must complete within this many ms (contract). */
  boundedMs?: number;
  /** Today's bound when the contract bound is known to fail. */
  todayBoundedMs?: number;
  /** The faulted upstream call must carry an AbortSignal (a deadline exists). */
  requireSignal?: boolean;
  /** Replay once the upstream is healthy. Default {status:200}; null = skip. */
  recovery?: Expect | null;
  /** Today's recovery behaviour when it differs from the `recovery` contract
   * (pinned; the contract is recorded as `recovery.contract`). */
  todayRecovery?: Expect;
  /** Extra assertions on the recovery attempt's upstream calls. */
  recoveryCalls?: (calls: CallRecord[], ctx: Ctx) => string | null;
  note?: string;
}

// ─── Selectors ───────────────────────────────────────────────────────────────

const authUser = (i: { url: URL; method: string }) =>
  i.method === "GET" && i.url.pathname === "/auth/v1/user";
const deletionLookup = match.tableMethod("account_deletion_requests", "GET");
const externalLookup = match.tableMethod("account_external_credentials", "GET");
const externalPatch = match.tableMethod("account_external_credentials", "PATCH");
const externalUpsert = match.tableMethod("account_external_credentials", "POST");

const forbidAfterAuth: Upstream[] = ["postgrest", "auth_admin", "revenuecat", "apple"];
const forbidAfterLookup: Upstream[] = ["auth_admin", "revenuecat", "apple"];

// ─── The matrix ─────────────────────────────────────────────────────────────

const CASES: FaultCase[] = [
  // ── Supabase Auth: GET /auth/v1/user (session verification) ───────────────
  {
    id: "auth_500",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.http("auth_500", "auth", 500, { msg: "internal" }, { match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503, retryAfter: "2" },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_502_html",
    upstream: "auth",
    stage: "verify",
    faults: () => [
      fault.raw("auth_502_html", "auth", 502, "<html>bad gateway</html>", {
        contentType: "text/html",
        match: authUser,
      }),
    ],
    expect: { status: 503, message: GENERIC_SESSION_503, retryAfter: "2" },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_503_retry_after_7",
    upstream: "auth",
    stage: "verify",
    faults: () => [
      fault.http("auth_503", "auth", 503, { msg: "maintenance" }, {
        headers: { "Retry-After": "7" },
        match: authUser,
      }),
    ],
    expect: { status: 503, message: GENERIC_SESSION_503, retryAfter: "7" },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_504",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.raw("auth_504", "auth", 504, "", { match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_429_retry_after_30",
    upstream: "auth",
    stage: "verify",
    faults: () => [
      fault.http("auth_429", "auth", 429, { msg: "over_request_rate_limit" }, {
        headers: { "Retry-After": "30" },
        match: authUser,
      }),
    ],
    expect: { status: 503, message: GENERIC_SESSION_503, retryAfter: "30" },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_401_bad_jwt",
    upstream: "auth",
    stage: "verify",
    faults: () => [
      fault.http("auth_401", "auth", 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, {
        match: authUser,
      }),
    ],
    expect: { status: 401, message: SESSION_INVALID_401 },
    forbid: forbidAfterAuth,
    note: "credential verdict; the refusal is not cached (healthy replay succeeds)",
  },
  {
    id: "auth_403_user_not_found",
    upstream: "auth",
    stage: "verify",
    faults: () => [
      fault.http(
        "auth_403",
        "auth",
        403,
        { code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" },
        { match: authUser },
      ),
    ],
    expect: { status: 401, message: SESSION_INVALID_401 },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_404_not_a_verdict",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.http("auth_404", "auth", 404, { msg: "not found" }, { match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_200_non_json",
    upstream: "auth",
    stage: "verify",
    faults: () => [
      fault.raw("auth_200_html", "auth", 200, "<html>gateway page</html>", {
        contentType: "text/html",
        match: authUser,
      }),
    ],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_200_empty_object",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.http("auth_200_empty", "auth", 200, {}, { match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_200_array",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.http("auth_200_array", "auth", 200, [], { match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_200_truncated_json",
    upstream: "auth",
    stage: "verify",
    faults: (ctx) => [
      fault.raw("auth_200_trunc", "auth", 200, `{"id":"${ctx.user.id}","email":"u@e`, {
        match: authUser,
      }),
    ],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_200_provider_email",
    upstream: "auth",
    stage: "verify",
    faults: (ctx) => [
      fault.http(
        "auth_200_email",
        "auth",
        200,
        { id: ctx.user.id, email: ctx.user.email, app_metadata: { provider: "email" } },
        { match: authUser },
      ),
    ],
    expect: { status: 401, message: "The session does not belong to a Google or Apple account." },
    forbid: forbidAfterAuth,
  },
  {
    id: "auth_reject_persistent",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.reject("auth_reject", "auth", { match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503, retryAfter: "2" },
    forbid: forbidAfterAuth,
    boundedMs: AUTH_TIMEOUT_MS + 400,
    note: "connection retries with backoff inside the single deadline (≥2 attempts expected)",
  },
  {
    id: "auth_reject_once_then_ok",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.reject("auth_reject_once", "auth", { match: authUser, nth: 1 })],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
    note: "HELD: a single socket failure is ridden out inside the request",
  },
  {
    id: "auth_hang_honors_abort",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.hang("auth_hang", "auth", 30_000, { honorAbort: true, match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
    boundedMs: AUTH_TIMEOUT_MS + 400,
    requireSignal: true,
  },
  {
    id: "auth_hang_ignores_abort",
    upstream: "auth",
    stage: "verify",
    faults: () => [fault.hang("auth_hang_na", "auth", 2_500, { honorAbort: false, match: authUser })],
    expect: { status: 503, message: GENERIC_SESSION_503 },
    forbid: forbidAfterAuth,
    boundedMs: AUTH_TIMEOUT_MS + 400,
    note: "the deadline races the socket even when the socket never honours abort",
  },

  // ── PostgREST as the user: pending-challenge lookup ────────────────────────
  {
    id: "pg_lookup_500",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [fault.http("pg_500", "postgrest", 500, { message: "boom" }, { match: deletionLookup })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_503_html",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [
      fault.raw("pg_503_html", "postgrest", 503, "<html>unavailable</html>", {
        contentType: "text/html",
        match: deletionLookup,
      }),
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_401_jwt_expired",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [
      fault.http("pg_401", "postgrest", 401, { code: "PGRST301", message: "JWT expired" }, {
        match: deletionLookup,
      }),
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_403_permission_denied",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [
      fault.http("pg_403", "postgrest", 403, { code: "42501", message: "permission denied" }, {
        match: deletionLookup,
      }),
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_200_non_json",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [
      fault.raw("pg_200_html", "postgrest", 200, "<html>gateway</html>", {
        contentType: "text/html",
        match: deletionLookup,
      }),
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_200_two_rows",
    upstream: "postgrest",
    stage: "lookup",
    faults: (ctx) => [
      fault.http(
        "pg_two_rows",
        "postgrest",
        200,
        [
          { challenge: ctx.challenge, created_at: new Date(Date.now() - 5_000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
          { challenge: ctx.prng.uuid(), created_at: new Date(Date.now() - 5_000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
        ],
        { match: deletionLookup },
      ),
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
    note: "maybeSingle() over two rows is PGRST116 → generic 503",
  },
  {
    id: "pg_lookup_200_object_not_array",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [fault.http("pg_obj", "postgrest", 200, {}, { match: deletionLookup })],
    expect: { status: 403, code: "account.deletion_challenge_invalid" },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_200_empty",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [fault.http("pg_empty", "postgrest", 200, [], { match: deletionLookup })],
    expect: { status: 403, code: "account.deletion_challenge_invalid" },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_challenge_mismatch",
    upstream: "postgrest",
    stage: "lookup",
    faults: (ctx) => [
      fault.http(
        "pg_mismatch",
        "postgrest",
        200,
        [{ challenge: ctx.prng.uuid(), created_at: new Date(Date.now() - 5_000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }],
        { match: deletionLookup },
      ),
    ],
    expect: { status: 403, code: "account.deletion_challenge_invalid" },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_expired",
    upstream: "postgrest",
    stage: "lookup",
    rowAgeMs: 16 * 60_000,
    faults: () => [],
    expect: { status: 403, code: "account.deletion_challenge_expired" },
    forbid: forbidAfterLookup,
    recovery: { status: 403, code: "account.deletion_challenge_expired" },
    note: "not a fault: expiry verdict (the user must start again)",
  },
  {
    id: "pg_lookup_too_fast",
    upstream: "postgrest",
    stage: "lookup",
    rowAgeMs: 800,
    faults: () => [],
    expect: { status: 429, code: "account.deletion_too_fast" },
    forbid: forbidAfterLookup,
    recovery: null,
    note: "not a fault: 3 s review gate (no Retry-After on this coded 429)",
  },
  {
    id: "pg_lookup_garbage_timestamps",
    upstream: "postgrest",
    stage: "lookup",
    faults: (ctx) => [
      fault.http(
        "pg_garbage_ts",
        "postgrest",
        200,
        [{ challenge: ctx.challenge, created_at: "not-a-date", expires_at: "also-not-a-date" }],
        { match: deletionLookup },
      ),
    ],
    expect: { status: 403, code: "account.deletion_challenge_expired" },
    today: { status: 200, apple: "not_applicable" },
    recovery: null,
    note:
      "Date.parse(NaN) makes BOTH guards (expiry, 3 s review) fail OPEN: an unparsable row deletes the account. Reachable only if PostgREST returns a non-timestamptz value (schema forbids) — recorded as P3.",
  },
  {
    id: "pg_lookup_reject",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [fault.reject("pg_reject", "postgrest", { match: deletionLookup })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_lookup_hang",
    upstream: "postgrest",
    stage: "lookup",
    faults: () => [fault.hang("pg_hang", "postgrest", HANG_MS, { honorAbort: true, match: deletionLookup })],
    expect: { status: 200, apple: "not_applicable" },
    boundedMs: HANG_MS - 100,
    todayBoundedMs: HANG_MS + 1_000,
    recovery: null,
    note:
      "supabase-js PostgREST calls carry no AbortSignal/deadline: a stalled PostgREST stalls delete-confirm until the platform wall-clock limit. Stub answers after HANG_MS; the handler waits the whole time.",
  },

  // ── PostgREST as the service role: external-credential row ───────────────
  {
    id: "pg_ext_500",
    upstream: "postgrest",
    stage: "external_lookup",
    faults: () => [fault.http("pg_ext_500", "postgrest", 500, { message: "boom" }, { match: externalLookup })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_ext_200_malformed",
    upstream: "postgrest",
    stage: "external_lookup",
    faults: () => [fault.raw("pg_ext_trunc", "postgrest", 200, '[{"apple_revoked_at":', { match: externalLookup })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_ext_200_two_rows",
    upstream: "postgrest",
    stage: "external_lookup",
    faults: () => [
      fault.http(
        "pg_ext_two",
        "postgrest",
        200,
        [
          { apple_refresh_token_encrypted: null, apple_revoked_at: null, revenuecat_deleted_at: null },
          { apple_refresh_token_encrypted: null, apple_revoked_at: null, revenuecat_deleted_at: null },
        ],
        { match: externalLookup },
      ),
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_ext_reject",
    upstream: "postgrest",
    stage: "external_lookup",
    faults: () => [fault.reject("pg_ext_reject", "postgrest", { match: externalLookup })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: forbidAfterLookup,
  },
  {
    id: "pg_ext_hang",
    upstream: "postgrest",
    stage: "external_lookup",
    faults: () => [fault.hang("pg_ext_hang", "postgrest", HANG_MS, { honorAbort: true, match: externalLookup })],
    expect: { status: 200, apple: "not_applicable" },
    boundedMs: HANG_MS - 100,
    todayBoundedMs: HANG_MS + 1_000,
    recovery: null,
    note: "same missing deadline on the service-role client",
  },
  {
    id: "pg_apple_checkpoint_patch_500",
    upstream: "postgrest",
    stage: "apple_checkpoint",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.http("pg_patch_500", "postgrest", 500, { message: "boom" }, { match: externalPatch })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["revenuecat", "auth_admin"],
    recovery: { status: 200, apple: "revoked" },
    recoveryCalls: (calls) =>
      calls.filter((c) => c.upstream === "apple").length === 1
        ? null
        : "expected the healthy replay to revoke at Apple again (checkpoint was lost)",
    note: "Apple revoke succeeded but its checkpoint failed → replay revokes again (Apple answers 200 here)",
  },
  {
    id: "pg_rc_checkpoint_upsert_500",
    upstream: "postgrest",
    stage: "rc_checkpoint",
    faults: () => [fault.http("pg_upsert_500", "postgrest", 500, { message: "boom" }, { match: externalUpsert })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
    recoveryCalls: (calls) =>
      calls.filter((c) => c.upstream === "revenuecat").length === 1 &&
      calls.find((c) => c.upstream === "revenuecat")?.status === 404
        ? null
        : "expected the replay to call RevenueCat once and accept its 404 as already deleted",
  },
  {
    id: "pg_rc_checkpoint_upsert_409",
    upstream: "postgrest",
    stage: "rc_checkpoint",
    faults: () => [
      fault.http("pg_upsert_409", "postgrest", 409, { code: "23505", message: "duplicate key" }, {
        match: externalUpsert,
      }),
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
  },
  {
    id: "pg_rc_checkpoint_upsert_hang",
    upstream: "postgrest",
    stage: "rc_checkpoint",
    faults: () => [fault.hang("pg_upsert_hang", "postgrest", HANG_MS, { honorAbort: true, match: externalUpsert })],
    expect: { status: 200, apple: "not_applicable" },
    boundedMs: HANG_MS - 100,
    todayBoundedMs: HANG_MS + 1_000,
    recovery: null,
  },

  // ── Apple token revocation (provider=apple with a stored refresh token) ───
  {
    id: "apple_revoke_500",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.http("apple_500", "apple", 500, {})],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["revenuecat", "auth_admin"],
    recovery: { status: 200, apple: "revoked" },
  },
  {
    id: "apple_revoke_429",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.http("apple_429", "apple", 429, {})],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["revenuecat", "auth_admin"],
    recovery: { status: 200, apple: "revoked" },
  },
  {
    id: "apple_revoke_400_invalid_grant",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.http("apple_invalid_grant", "apple", 400, { error: "invalid_grant" })],
    expect: { status: 200, apple: "manual_action_required" },
    recovery: null,
    note: "permanent: token dropped, deletion fulfilled, client directs the user to Apple's controls",
  },
  {
    id: "apple_revoke_400_invalid_client",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.http("apple_invalid_client", "apple", 400, { error: "invalid_client" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["revenuecat", "auth_admin"],
    recovery: { status: 200, apple: "revoked" },
    note: "OUR client secret is wrong → retryable, credential preserved",
  },
  {
    id: "apple_revoke_400_no_body",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.raw("apple_400_empty", "apple", 400, "")],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["revenuecat", "auth_admin"],
    recovery: { status: 200, apple: "revoked" },
  },
  {
    id: "apple_revoke_reject",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.reject("apple_reject", "apple")],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["revenuecat", "auth_admin"],
    recovery: { status: 200, apple: "revoked" },
  },
  {
    id: "apple_revoke_hang",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    faults: () => [fault.hang("apple_hang", "apple", HANG_MS, { honorAbort: true })],
    expect: { status: 200, apple: "revoked" },
    requireSignal: true,
    recovery: null,
    note: "externalAccounts.ts carries a 15 s AbortController deadline (stub answers before it)",
  },
  {
    id: "apple_secrets_missing",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "valid",
    setup: () => Deno.env.delete("APPLE_SIGN_IN_TEAM_ID"),
    teardown: () => Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234"),
    faults: () => [],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["apple", "revenuecat", "auth_admin"],
    recovery: { status: 200, apple: "revoked" },
  },
  {
    id: "apple_ciphertext_wrong_key",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "wrong_key",
    faults: () => [],
    expect: { status: 200, apple: "manual_action_required" },
    forbid: ["apple"],
    recovery: null,
    note: "undecryptable credential is permanent: dropped, deletion continues",
  },
  {
    id: "apple_legacy_no_token",
    upstream: "apple",
    stage: "apple_revoke",
    provider: "apple",
    appleToken: "none",
    faults: () => [],
    expect: { status: 200, apple: "manual_action_required" },
    forbid: ["apple"],
    recovery: null,
  },

  // ── RevenueCat customer deletion ─────────────────────────────────────────
  {
    id: "rc_500",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.http("rc_500", "revenuecat", 500, { message: "internal" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
  },
  {
    id: "rc_502_html",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.raw("rc_502", "revenuecat", 502, "<html>", { contentType: "text/html" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
  },
  {
    id: "rc_429",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.http("rc_429", "revenuecat", 429, { message: "rate limited" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
  },
  {
    id: "rc_401_bad_key",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.http("rc_401", "revenuecat", 401, { code: 7225, message: "Invalid API key" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
  },
  {
    id: "rc_403",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.http("rc_403", "revenuecat", 403, { message: "forbidden" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
  },
  {
    id: "rc_404_already_deleted",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.http("rc_404", "revenuecat", 404, { code: 7259, message: "Couldn't find subscriber" })],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
  {
    id: "rc_200_non_json",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.raw("rc_200_text", "revenuecat", 200, "ok", { contentType: "text/plain" })],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
  {
    id: "rc_reject",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.reject("rc_reject", "revenuecat")],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["auth_admin"],
  },
  {
    id: "rc_hang",
    upstream: "revenuecat",
    stage: "revenuecat",
    faults: () => [fault.hang("rc_hang", "revenuecat", HANG_MS, { honorAbort: true })],
    expect: { status: 200, apple: "not_applicable" },
    requireSignal: true,
    recovery: null,
    note: "15 s provider deadline exists (stub answers before it)",
  },
  {
    id: "rc_secret_missing",
    upstream: "revenuecat",
    stage: "revenuecat",
    setup: () => Deno.env.delete("REVENUECAT_SECRET_API_KEY"),
    teardown: () => Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_stress_revenuecat"),
    faults: () => [],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    forbid: ["revenuecat", "auth_admin"],
  },
  {
    id: "rc_checkpoint_honoured_on_replay",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [fault.http("admin_500_once", "auth_admin", 500, { msg: "boom" }, { nth: 1 })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    recoveryCalls: (calls) =>
      calls.some((c) => c.upstream === "revenuecat")
        ? "RevenueCat was called again although revenuecat_deleted_at was checkpointed"
        : null,
    note: "RC deleted + checkpointed, then Auth fails → replay skips RevenueCat",
  },

  // ── Supabase Auth admin: DELETE /auth/v1/admin/users/:id ─────────────────
  {
    id: "admin_500",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [fault.http("admin_500", "auth_admin", 500, { msg: "boom" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
  },
  {
    id: "admin_503_html",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [fault.raw("admin_503", "auth_admin", 503, "<html>", { contentType: "text/html" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
  },
  {
    id: "admin_404_already_deleted",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [
      {
        id: "admin_404",
        upstream: "auth_admin",
        // The user was deleted by a concurrent delivery: perform the fake
        // deletion, then answer the way GoTrue does for a missing user.
        respond: async (_info, pass) => {
          await (await pass()).body?.cancel();
          return new Response(JSON.stringify({ code: 404, error_code: "user_not_found", msg: "User not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    ],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
  {
    id: "admin_403_bad_service_key",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [fault.http("admin_403", "auth_admin", 403, { code: 403, error_code: "bad_jwt", msg: "not admin" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
  },
  {
    id: "admin_422",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [fault.http("admin_422", "auth_admin", 422, { code: 422, msg: "unprocessable" })],
    expect: { status: 503, message: GENERIC_DELETION_503 },
  },
  {
    id: "admin_200_non_json",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [
      {
        id: "admin_200_text",
        upstream: "auth_admin",
        respond: async (_info, pass) => {
          await (await pass()).body?.cancel();
          return new Response("deleted", { status: 200, headers: { "Content-Type": "text/plain" } });
        },
      },
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    recovery: { status: 200, apple: "not_applicable" },
    todayRecovery: { status: 403, code: "account.deletion_challenge_invalid" },
    note:
      "Auth deleted the user but the 2xx body is unreadable: generic retryable 503 (no crash), but the replay finds no challenge row (cascaded with auth.users) and tells a deleted user to 'start again from Settings' while their cached session keeps serving.",
  },
  {
    id: "admin_reject_after_commit",
    upstream: "auth_admin",
    stage: "admin_delete",
    faults: () => [
      {
        id: "admin_reset_after_commit",
        upstream: "auth_admin",
        // The connection drops after GoTrue committed the deletion (response
        // lost): the realistic shape of the unreadable-2xx case above.
        respond: async (_info, pass) => {
          await (await pass()).body?.cancel();
          throw new TypeError("error sending request: connection reset by peer");
        },
      },
    ],
    expect: { status: 503, message: GENERIC_DELETION_503 },
    recovery: { status: 200, apple: "not_applicable" },
    todayRecovery: { status: 403, code: "account.deletion_challenge_invalid" },
    note:
      "Deletion committed at Auth but the reply was lost: retry → 403 'not requested' (row cascaded), the bearer stays cached ~10 min, and delete-request cannot re-arm for a user that no longer exists.",
  },
  {
    id: "admin_reject",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [fault.reject("admin_reject", "auth_admin")],
    expect: { status: 503, message: GENERIC_DELETION_503 },
  },
  {
    id: "admin_hang",
    upstream: "auth_admin",
    stage: "auth_delete",
    faults: () => [fault.hang("admin_hang", "auth_admin", HANG_MS, { honorAbort: true })],
    expect: { status: 200, apple: "not_applicable" },
    boundedMs: HANG_MS - 100,
    todayBoundedMs: HANG_MS + 1_000,
    recovery: null,
    note: "gotrue-js admin call carries no deadline either",
  },

  // ── Upstash Redis (L2 cache + shared rate limits) ────────────────────────
  {
    id: "redis_500_all",
    upstream: "upstash",
    stage: "cache",
    faults: () => [fault.http("redis_500", "upstash", 500, "upstream error")],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
    note: "L2 outage degrades to L1 + source of truth; the deletion still completes",
  },
  {
    id: "redis_reject_all",
    upstream: "upstash",
    stage: "cache",
    faults: () => [fault.reject("redis_reject", "upstash")],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
  {
    id: "redis_200_non_array",
    upstream: "upstash",
    stage: "cache",
    faults: () => [fault.http("redis_obj", "upstash", 200, { error: "unexpected" })],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
  {
    id: "redis_200_html",
    upstream: "upstash",
    stage: "cache",
    faults: () => [fault.raw("redis_html", "upstash", 200, "<html>", { contentType: "text/html" })],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
  {
    id: "redis_command_error_all",
    upstream: "upstash",
    stage: "cache",
    faults: () => [
      {
        id: "redis_cmd_err",
        upstream: "upstash",
        respond: async (info) => {
          const cmds = JSON.parse(await info.request.clone().text()) as unknown[];
          return new Response(JSON.stringify(cmds.map(() => ({ error: "ERR max requests limit exceeded" }))), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    ],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
    note: "Redis reached but refusing every command: rate limits fall back to memory, cache reads are 'unknown' → re-verify",
  },
  {
    id: "redis_truncated_replies",
    upstream: "upstash",
    stage: "cache",
    faults: () => [fault.http("redis_short", "upstash", 200, [])],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
  {
    id: "redis_hang_all",
    upstream: "upstash",
    stage: "cache",
    faults: () => [fault.hang("redis_hang", "upstash", 30_000, { honorAbort: true })],
    expect: { status: 200, apple: "not_applicable" },
    boundedMs: 3_000,
    todayBoundedMs: 15_000,
    requireSignal: true,
    recovery: null,
    note:
      "every pipeline has its own 1 200 ms deadline but the route issues them SEQUENTIALLY (≈8 per request) → one stalled Redis costs ≈ 8 × 1.2 s per request; no circuit breaker",
  },
  {
    id: "redis_revoked_marker_present",
    upstream: "upstash",
    stage: "cache",
    setup: (ctx) => {
      ctx.h.redis.set(`auth:revoked:${ctx.sessionId}`, { value: "1", expiresAtMs: Date.now() + 600_000 });
    },
    faults: () => [],
    expect: { status: 401, message: SESSION_INVALID_401 },
    forbid: ["auth", "postgrest", "auth_admin", "revenuecat", "apple"],
    recovery: { status: 401, message: SESSION_INVALID_401 },
    note: "a session fenced elsewhere is refused here without consulting Auth",
  },
  {
    id: "redis_auth_cache_corrupt",
    upstream: "upstash",
    stage: "cache",
    setup: async (ctx) => {
      const { sha256Hex } = await import("../cache.ts");
      ctx.h.redis.set(`auth:${await sha256Hex(ctx.bearer)}`, { value: "{not json", expiresAtMs: Date.now() + 600_000 });
    },
    faults: () => [],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
    note: "a corrupt L2 auth row falls through to a real verification",
  },
  {
    id: "redis_fence_set_refused",
    upstream: "upstash",
    stage: "cache",
    faults: () => [
      {
        ...fault.http("redis_set_refused", "upstash", 200, [{ error: "OOM command not allowed" }]),
        match: match.redisCommand("SET", "auth:revoked:"),
      },
    ],
    expect: { status: 200, apple: "not_applicable" },
    recovery: { status: 401, message: SESSION_INVALID_401 },
    note: "fence not shared (warned) but the local marker + cacheDel still refuse the replayed bearer on this isolate",
  },
  {
    id: "redis_cachedel_500",
    upstream: "upstash",
    stage: "cache",
    faults: () => [{ ...fault.http("redis_del_500", "upstash", 500, "err"), match: match.redisCommand("DEL") }],
    expect: { status: 200, apple: "not_applicable" },
    recovery: null,
  },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface CaseResult {
  id: string;
  seed: number;
  upstream: Upstream;
  stage: string;
  user: string;
  ip: string;
  challenge: string;
  attempt: {
    status: number;
    body: unknown;
    retryAfter: string | null;
    latencyMs: number;
    calls: Record<Upstream, number>;
    faultedCalls: number;
    signalOnFaulted: boolean | null;
  };
  recovery: {
    status: number;
    body: unknown;
    latencyMs: number;
    calls: Record<Upstream, number>;
  } | null;
  checks: Check[];
  verdict: "HELD" | "BROKEN";
  note?: string;
  replay: string;
}

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function checkExpect(prefix: string, expected: Expect, status: number, body: unknown, retryAfter: string | null): Check[] {
  const checks: Check[] = [];
  const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
  checks.push({ name: `${prefix}.status`, ok: status === expected.status, detail: `expected ${expected.status}, got ${status}` });
  if (expected.code !== undefined) {
    checks.push({ name: `${prefix}.code`, ok: err?.code === expected.code, detail: `expected ${expected.code}, got ${err?.code}` });
  }
  if (expected.message !== undefined) {
    checks.push({ name: `${prefix}.message`, ok: err?.message === expected.message, detail: `got ${JSON.stringify(err?.message)}` });
  }
  if (expected.retryAfter !== undefined) {
    checks.push({ name: `${prefix}.retryAfter`, ok: retryAfter === expected.retryAfter, detail: `expected ${expected.retryAfter}, got ${retryAfter}` });
  }
  if (expected.status >= 500) {
    // Generic 5xx contract: no upstream detail leaks into the body.
    const text = JSON.stringify(body);
    const leaks = /PGRST|42501|stack|boom|internal|supabase|revenuecat|apple/i.test(text.replace(/temporarily unavailable/i, ""));
    checks.push({ name: `${prefix}.generic5xx`, ok: !leaks && typeof err?.message === "string" && !err.code, detail: text.slice(0, 200) });
  }
  if (expected.status === 200 && expected.apple !== undefined) {
    const b = body as { deleted?: boolean; appleAuthorizationRevocation?: string } | null;
    checks.push({
      name: `${prefix}.body`,
      ok: b?.deleted === true && b?.appleAuthorizationRevocation === expected.apple,
      detail: JSON.stringify(body),
    });
  }
  return checks;
}

async function runCase(h: Harness, fc: FaultCase): Promise<CaseResult> {
  h.resetFaults();
  const seed = fnv1a(`${STRESS_SEED}:${fc.id}`);
  const prng = new Prng(seed);
  const provider = fc.provider ?? "google";
  const user: FakeUser = { id: prng.uuid(), email: `${prng.hex(8)}@example.com`, provider };
  const sessionId = prng.uuid();
  const challenge = prng.uuid();
  const ip = prng.ip();
  const ctx: Ctx = { h, prng, user, sessionId, bearer: h.bearer(user.id, sessionId), ip, challenge };
  h.addUser(user);
  if (!fc.noRow) h.addDeletionRow(user.id, challenge, fc.rowAgeMs ?? 5_000, fc.rowTtlMs);
  if (provider === "apple" && (fc.appleToken ?? "none") !== "none") {
    const wrongKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    h.addExternalRow({
      user_id: user.id,
      apple_refresh_token_encrypted: await h.appleCiphertext(user.id, fc.appleToken === "wrong_key" ? wrongKey : undefined),
      apple_token_captured_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
  }
  await fc.setup?.(ctx);
  const faults = fc.faults(ctx);
  h.faults.push(...faults);

  const send = () => h.handler(h.request("/v1/me/delete-confirm", { bearer: ctx.bearer, ip, body: { challenge } }));

  const seq0 = h.calls.length ? h.calls[h.calls.length - 1].seq : 0;
  const t0 = performance.now();
  const res = await send();
  const latencyMs = performance.now() - t0;
  const body = await bodyOf(res);
  const calls = h.callsSince(seq0);
  const faulted = calls.filter((c) => c.faulted !== null);

  const checks: Check[] = [];
  const contract = fc.expect;
  const pinned = fc.today ?? fc.expect;
  const contractChecks = checkExpect("attempt", contract, res.status, body, res.headers.get("Retry-After"));
  const pinnedChecks = fc.today ? checkExpect("attempt(today)", pinned, res.status, body, res.headers.get("Retry-After")) : contractChecks;
  checks.push(...pinnedChecks);
  if (fc.today) {
    checks.push({
      name: "attempt.contract",
      ok: contractChecks.every((c) => c.ok),
      detail: contractChecks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ") || "contract holds",
    });
  }
  if (faults.length > 0) {
    checks.push({ name: "attempt.faultInjected", ok: faulted.length > 0, detail: `${faulted.length} faulted upstream call(s)` });
  }
  for (const forbidden of fc.forbid ?? []) {
    const n = calls.filter((c) => c.upstream === forbidden).length;
    checks.push({ name: `attempt.noDownstream.${forbidden}`, ok: n === 0, detail: `${n} call(s)` });
  }
  if (fc.boundedMs !== undefined) {
    checks.push({
      name: "attempt.bounded",
      ok: latencyMs <= (fc.todayBoundedMs ?? fc.boundedMs),
      detail: `${latencyMs.toFixed(0)} ms vs contract ${fc.boundedMs} ms${fc.todayBoundedMs ? ` (today ≤ ${fc.todayBoundedMs})` : ""}`,
    });
    if (fc.todayBoundedMs !== undefined) {
      checks.push({ name: "attempt.bounded.contract", ok: latencyMs <= fc.boundedMs, detail: `${latencyMs.toFixed(0)} ms > ${fc.boundedMs} ms` });
    }
  }
  const signalOnFaulted = faulted.length ? faulted.every((c) => c.hadSignal) : null;
  if (fc.requireSignal) {
    checks.push({ name: "attempt.deadlineSignal", ok: signalOnFaulted === true, detail: `faulted calls carried AbortSignal: ${signalOnFaulted}` });
  }
  if (fc.id === "auth_reject_persistent") {
    const n = calls.filter((c) => c.upstream === "auth").length;
    checks.push({ name: "attempt.connectRetries", ok: n >= 2, detail: `${n} Auth attempt(s) inside ${AUTH_TIMEOUT_MS} ms` });
  }

  // Recovery: upstream healthy again, same bearer + challenge.
  h.resetFaults();
  fc.teardown?.(ctx);
  let recovery: CaseResult["recovery"] = null;
  if (fc.recovery !== null) {
    const expectR = fc.recovery ?? { status: 200, apple: "not_applicable" };
    const seq1 = h.calls[h.calls.length - 1]?.seq ?? 0;
    const t1 = performance.now();
    const res2 = await send();
    const lat2 = performance.now() - t1;
    const body2 = await bodyOf(res2);
    const calls2 = h.callsSince(seq1);
    recovery = { status: res2.status, body: body2, latencyMs: Math.round(lat2 * 100) / 100, calls: h.countBy(calls2) };
    const contractR = checkExpect("recovery", expectR, res2.status, body2, res2.headers.get("Retry-After"));
    if (fc.todayRecovery) {
      checks.push(...checkExpect("recovery(today)", fc.todayRecovery, res2.status, body2, res2.headers.get("Retry-After")));
      checks.push({
        name: "recovery.contract",
        ok: contractR.every((c) => c.ok),
        detail: contractR.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ") || "contract holds",
      });
    } else {
      checks.push(...contractR);
    }
    if ((fc.todayRecovery ?? expectR).status === 200) {
      checks.push({ name: "recovery.userGone", ok: !h.users.has(user.id), detail: `auth user present: ${h.users.has(user.id)}` });
      checks.push({ name: "recovery.rcGone", ok: !h.revenueCatSubscribers.has(user.id), detail: `RC subscriber present: ${h.revenueCatSubscribers.has(user.id)}` });
    }
    const extra = fc.recoveryCalls?.(calls2, ctx) ?? null;
    if (fc.recoveryCalls) checks.push({ name: "recovery.calls", ok: extra === null, detail: extra ?? "ok" });
  } else if (pinned.status === 200) {
    checks.push({ name: "attempt.userGone", ok: !h.users.has(user.id), detail: `auth user present: ${h.users.has(user.id)}` });
  }

  // `.contract` checks carry the lens contract where today's behaviour is
  // pinned separately; any failing check (pinned or contract) is BROKEN.
  const contractHeld = checks.every((c) => c.ok);
  return {
    id: fc.id,
    seed,
    upstream: fc.upstream,
    stage: fc.stage,
    user: user.id,
    ip,
    challenge,
    attempt: {
      status: res.status,
      body,
      retryAfter: res.headers.get("Retry-After"),
      latencyMs: Math.round(latencyMs * 100) / 100,
      calls: h.countBy(calls),
      faultedCalls: faulted.length,
      signalOnFaulted,
    },
    recovery,
    checks,
    verdict: contractHeld ? "HELD" : "BROKEN",
    note: fc.note,
    replay: `STRESS_SEED=${STRESS_SEED} STRESS_ONLY=${fc.id} deno test -A --no-check --config deno.json stress_delete_confirm_failure_load.test.ts`,
  };
}

const selected = ONLY ? CASES.filter((c) => c.id === ONLY) : CASES;

Deno.test("stress delete-confirm: fault matrix (≥40 seeded upstream faults → error class + recoverability)", async (t) => {
  const h = await loadStressHarness({ redis: true });
  try {
    assert(selected.length > 0, `STRESS_ONLY=${ONLY} matched no case`);
    const results: CaseResult[] = [];
    for (const fc of selected) {
      await t.step(fc.id, async () => {
        const r = await runCase(h, fc);
        results.push(r);
        const failed = r.checks.filter((c) => !c.ok && !c.name.endsWith(".contract"));
        assertEquals(failed, [], `${fc.id}: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}\nreplay: ${r.replay}`);
      });
    }
    const broken = results.filter((r) => r.verdict === "BROKEN");
    const path = await writeJson("fault_matrix.json", {
      seed: STRESS_SEED,
      authTimeoutMs: AUTH_TIMEOUT_MS,
      hangMs: HANG_MS,
      cases: results.length,
      held: results.length - broken.length,
      broken: broken.map((r) => r.id),
      byUpstream: results.reduce<Record<string, number>>((acc, r) => ((acc[r.upstream] = (acc[r.upstream] ?? 0) + 1), acc), {}),
      results,
    });
    console.log(`[stress] fault matrix: ${results.length} cases, ${broken.length} BROKEN (${broken.map((r) => r.id).join(", ") || "none"}) → ${path}`);
    if (!ONLY) assert(results.length >= 40, `expected ≥40 fault cases, ran ${results.length}`);
  } finally {
    h.detach();
  }
});

// ─── Duplicate delivery / idempotency ────────────────────────────────────────

interface DupResult {
  id: string;
  seed: number;
  statuses: number[];
  bodies: unknown[];
  calls: Record<Upstream, number>;
  checks: Check[];
  verdict: "HELD" | "BROKEN";
}

async function dupScenario(
  h: Harness,
  id: string,
  fanout: number,
  configure: (ctx: Ctx) => void,
  judge: (statuses: number[], bodies: unknown[], calls: CallRecord[], ctx: Ctx) => Check[],
): Promise<DupResult> {
  h.resetFaults();
  const seed = fnv1a(`${STRESS_SEED}:dup:${id}`);
  const prng = new Prng(seed);
  const user: FakeUser = { id: prng.uuid(), email: `${prng.hex(8)}@example.com`, provider: "google" };
  const sessionId = prng.uuid();
  const challenge = prng.uuid();
  const ip = prng.ip();
  const ctx: Ctx = { h, prng, user, sessionId, bearer: h.bearer(user.id, sessionId), ip, challenge };
  h.addUser(user);
  h.addDeletionRow(user.id, challenge, 5_000);
  configure(ctx);
  const seq0 = h.calls[h.calls.length - 1]?.seq ?? 0;
  const responses = await Promise.all(
    Array.from({ length: fanout }, () =>
      h.handler(h.request("/v1/me/delete-confirm", { bearer: ctx.bearer, ip, body: { challenge } })),
    ),
  );
  const statuses = responses.map((r) => r.status);
  const bodies = await Promise.all(responses.map(bodyOf));
  const calls = h.callsSince(seq0);
  const checks = judge(statuses, bodies, calls, ctx);
  h.resetFaults();
  return { id, seed, statuses, bodies, calls: h.countBy(calls), checks, verdict: checks.every((c) => c.ok) ? "HELD" : "BROKEN" };
}

/** Concurrent twins of one confirm. Contract: each delivery ends in 200
 * deleted (idempotent — Auth answered 404 for the twin) or 401 fenced (the
 * twin finished first and revoked this session); never a 5xx, never a second
 * real deletion. Today a twin that reaches PostgREST after the winner's
 * auth.users cascade committed sees either 0 challenge rows (403
 * deletion_challenge_invalid, "Start again from Settings" — for a user who
 * no longer exists) or FK 23503 on its RevenueCat-checkpoint upsert
 * (PostgREST 409 → generic 503). Both are pinned as allowed outcomes and
 * flagged by the `.contract` check; the FK path is verified on postgres:16 by
 * stress_delete_confirm_pg.test.ts PGD2. */
function judgeConcurrentTwins(statuses: number[], bodies: unknown[], calls: CallRecord[], ctx: Ctx): Check[] {
  const is200 = (i: number) => statuses[i] === 200 && (bodies[i] as { deleted?: boolean }).deleted === true;
  const is401 = (i: number) =>
    statuses[i] === 401 && (bodies[i] as { error?: { message?: string } }).error?.message === SESSION_INVALID_401;
  const is503 = (i: number) =>
    statuses[i] === 503 && (bodies[i] as { error?: { message?: string } }).error?.message === GENERIC_DELETION_503;
  const is403 = (i: number) =>
    statuses[i] === 403 && (bodies[i] as { error?: { code?: string } }).error?.code === "account.deletion_challenge_invalid";
  const fkRace = calls.filter((c) => c.upstream === "postgrest" && c.method === "POST" && c.status === 409).length;
  return [
    { name: "atLeastOne200", ok: statuses.includes(200), detail: statuses.join(",") },
    {
      name: "each200OrFenced401OrGeneric503OrChallenge403",
      ok: statuses.every((_, i) => is200(i) || is401(i) || is503(i) || is403(i)),
      detail: JSON.stringify(bodies),
    },
    {
      name: "each200OrFenced401.contract",
      ok: statuses.every((_, i) => is200(i) || is401(i)),
      detail: `statuses=${statuses.join(",")} 503(FK 23503 on checkpoint upsert)=${fkRace} 403(challenge row cascaded)=${statuses.filter((_, i) => is403(i)).length}`,
    },
    { name: "exactlyOneAdmin200", ok: calls.filter((c) => c.upstream === "auth_admin" && c.status === 200).length === 1, detail: calls.filter((c) => c.upstream === "auth_admin").map((c) => c.status).join() },
    { name: "exactlyOneRc200", ok: calls.filter((c) => c.upstream === "revenuecat" && c.status === 200).length === 1, detail: calls.filter((c) => c.upstream === "revenuecat").map((c) => c.status).join() },
    { name: "userGone", ok: !ctx.h.users.has(ctx.user.id), detail: "" },
  ];
}

Deno.test("stress delete-confirm: duplicate delivery — concurrent and replayed confirms are idempotent", async (t) => {
  const h = await loadStressHarness({ redis: true });
  try {
    const results: DupResult[] = [];
    const record = (r: DupResult) => {
      results.push(r);
      const failed = r.checks.filter((c) => !c.ok && !c.name.endsWith(".contract"));
      assertEquals(failed, [], `${r.id}: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")} seed=${r.seed}`);
    };

    await t.step("dup_concurrent_2", async () => record(await dupScenario(h, "dup_concurrent_2", 2, () => {}, judgeConcurrentTwins)));
    await t.step("dup_concurrent_5_at_rate_limit", async () => record(await dupScenario(h, "dup_concurrent_5", 5, () => {}, judgeConcurrentTwins)));
    await t.step("dup_concurrent_5_slow_admin", async () =>
      // Auth admin answers slowly (real deleteUser cascades ~100 ms): twins pile
      // up between the winner's commit and its session fence, the window in
      // which their checkpoint upsert hits the FK race.
      record(
        await dupScenario(h, "dup_concurrent_5_slow_admin", 5, (ctx) => {
          ctx.h.faults.push({
            id: "admin_slow",
            upstream: "auth_admin",
            respond: async (_info, pass) => {
              await new Promise((r) => setTimeout(r, 40));
              return await pass();
            },
          });
        }, judgeConcurrentTwins),
      ));

    await t.step("dup_sixth_request_rate_limited", async () => {
      // Five wrong-challenge attempts (403, the session stays valid) exhaust
      // the 5/hour per-user budget; the sixth — even with the right challenge
      // — must be a coded 429 with Retry-After and must not reach Auth admin.
      h.resetFaults();
      const seed = fnv1a(`${STRESS_SEED}:dup:sixth`);
      const prng = new Prng(seed);
      const user: FakeUser = { id: prng.uuid(), email: "s@example.com", provider: "google" };
      const challenge = prng.uuid();
      const ip = prng.ip();
      const bearer = h.bearer(user.id, prng.uuid());
      h.addUser(user);
      h.addDeletionRow(user.id, challenge, 5_000);
      const seq0 = h.calls[h.calls.length - 1]?.seq ?? 0;
      const statuses: number[] = [];
      const bodies: unknown[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < 6; i++) {
        const r = await h.handler(
          h.request("/v1/me/delete-confirm", { bearer, ip, body: { challenge: i < 5 ? prng.uuid() : challenge } }),
        );
        statuses.push(r.status);
        bodies.push(await bodyOf(r));
        if (i === 5) retryAfter = r.headers.get("Retry-After");
      }
      const calls = h.callsSince(seq0);
      const sixth = bodies[5] as { error?: { code?: string } };
      const checks: Check[] = [
        { name: "fiveRefused403", ok: statuses.slice(0, 5).every((s) => s === 403), detail: statuses.join(",") },
        { name: "sixth429Coded", ok: statuses[5] === 429 && sixth.error?.code === "rate_limited", detail: JSON.stringify(sixth) },
        { name: "sixthRetryAfter", ok: retryAfter !== null && Number(retryAfter) > 0, detail: String(retryAfter) },
        { name: "noAdminDelete", ok: calls.every((c) => c.upstream !== "auth_admin"), detail: calls.filter((c) => c.upstream === "auth_admin").length.toString() },
        { name: "userStillPresent", ok: h.users.has(user.id), detail: "" },
      ];
      await record({ id: "dup_sixth", seed, statuses, bodies, calls: h.countBy(calls), checks, verdict: checks.every((c) => c.ok) ? "HELD" : "BROKEN" });
    });

    await t.step("dup_replay_after_success_is_refused_without_auth_call", async () => {
      h.resetFaults();
      const seed = fnv1a(`${STRESS_SEED}:dup:replay`);
      const prng = new Prng(seed);
      const user: FakeUser = { id: prng.uuid(), email: "r@example.com", provider: "google" };
      const sessionId = prng.uuid();
      const challenge = prng.uuid();
      const ip = prng.ip();
      const bearer = h.bearer(user.id, sessionId);
      h.addUser(user);
      h.addDeletionRow(user.id, challenge, 5_000);
      const first = await h.handler(h.request("/v1/me/delete-confirm", { bearer, ip, body: { challenge } }));
      assertEquals(first.status, 200);
      const seq = h.calls[h.calls.length - 1].seq;
      const replay = await h.handler(h.request("/v1/me/delete-confirm", { bearer, ip, body: { challenge } }));
      const body = (await replay.json()) as { error?: { message?: string } };
      const calls = h.callsSince(seq);
      const checks: Check[] = [
        { name: "replay401", ok: replay.status === 401 && body.error?.message === SESSION_INVALID_401, detail: `${replay.status} ${JSON.stringify(body)}` },
        { name: "noAuthCall", ok: calls.every((c) => c.upstream === "upstash"), detail: calls.map((c) => c.upstream).join(",") },
      ];
      await record({ id: "dup_replay_after_success", seed, statuses: [first.status, replay.status], bodies: [body], calls: h.countBy(calls), checks, verdict: checks.every((c) => c.ok) ? "HELD" : "BROKEN" });
    });

    await t.step("dup_concurrent_admin_500_on_first", async () =>
      record(
        await dupScenario(
          h,
          "dup_admin_500_first",
          2,
          (ctx) => ctx.h.faults.push(fault.http("admin_500_first", "auth_admin", 500, { msg: "boom" }, { nth: 1 })),
          (statuses, _bodies, _calls, ctx) => [
            { name: "one503one200", ok: [...statuses].sort().join() === "200,503", detail: statuses.join(",") },
            { name: "userGone", ok: !ctx.h.users.has(ctx.user.id), detail: "" },
          ],
        ),
      ));

    await t.step("dup_other_device_bearer_after_deletion", async () => {
      h.resetFaults();
      const seed = fnv1a(`${STRESS_SEED}:dup:otherdevice`);
      const prng = new Prng(seed);
      const user: FakeUser = { id: prng.uuid(), email: "o@example.com", provider: "google" };
      const challenge = prng.uuid();
      const ip = prng.ip();
      const bearerA = h.bearer(user.id, prng.uuid());
      const bearerB = h.bearer(user.id, prng.uuid());
      h.addUser(user);
      h.addDeletionRow(user.id, challenge, 5_000);
      // Device B was active moments ago (its verification is cached).
      const warm = await h.handler(h.request("/v1/me/access", { bearer: bearerB, ip, method: "GET" }));
      const first = await h.handler(h.request("/v1/me/delete-confirm", { bearer: bearerA, ip, body: { challenge } }));
      assertEquals(first.status, 200);
      const seq = h.calls[h.calls.length - 1].seq;
      const other = await h.handler(h.request("/v1/me/delete-confirm", { bearer: bearerB, ip, body: { challenge } }));
      const body = await bodyOf(other);
      const calls = h.callsSince(seq);
      const checks: Check[] = [
        {
          name: "otherDeviceNotServedFromCache",
          ok: other.status === 401 || other.status === 403,
          detail: `warm=${warm.status} other=${other.status} ${JSON.stringify(body)} calls=${calls.map((c) => `${c.upstream}:${c.status}`).join(",")}`,
        },
      ];
      await record({ id: "dup_other_device_bearer", seed, statuses: [warm.status, first.status, other.status], bodies: [body], calls: h.countBy(calls), checks, verdict: checks.every((c) => c.ok) ? "HELD" : "BROKEN" });
    });

    const path = await writeJson("duplicates.json", { seed: STRESS_SEED, results });
    console.log(`[stress] duplicates: ${results.length} scenarios → ${path}`);
  } finally {
    h.detach();
  }
});

// ─── Load: latency + round trips per request ────────────────────────────────

interface LoadSample {
  i: number;
  seed: number;
  kind: "google" | "apple_token" | "apple_legacy";
  status: number;
  latencyMs: number;
  calls: Record<Upstream, number>;
  supabaseRoundTrips: number;
}

async function loadCampaign(
  h: Harness,
  label: string,
  n: number,
  concurrency: number,
  opts: { warmAuth: boolean; faults?: FaultSpec[] },
) {
  h.resetFaults();
  h.resetState();
  const samples: LoadSample[] = [];
  const statusHistogram: Record<string, number> = {};
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();

  const one = async (i: number) => {
    const seed = fnv1a(`${STRESS_SEED}:load:${label}:${i}`);
    const p = new Prng(seed);
    const kind = p.pick(["google", "google", "google", "google", "google", "google", "google", "apple_token", "apple_token", "apple_legacy"] as const);
    const user: FakeUser = { id: p.uuid(), email: `${p.hex(6)}@example.com`, provider: kind === "google" ? "google" : "apple" };
    const bearer = h.bearer(user.id, p.uuid());
    const ip = p.ip();
    h.addUser(user);
    if (kind === "apple_token") {
      h.addExternalRow({
        user_id: user.id,
        apple_refresh_token_encrypted: await h.appleCiphertext(user.id),
        apple_token_captured_at: new Date(Date.now() - 86_400_000).toISOString(),
      });
    }
    let challenge: string;
    if (opts.warmAuth) {
      // The real flow: delete-request (verifies + caches the bearer, mints the
      // challenge) then, ≥3 s later, delete-confirm. The 3 s wait is skipped by
      // ageing the stored row (test-side clock), not by touching the handler.
      const req = await h.handler(h.request("/v1/me/delete-request", { bearer, ip, body: {} }));
      if (req.status !== 200) {
        statusHistogram[`delete-request:${req.status}`] = (statusHistogram[`delete-request:${req.status}`] ?? 0) + 1;
        await req.body?.cancel();
        return;
      }
      challenge = ((await req.json()) as { challenge: string }).challenge;
      const row = h.deletionRows.get(user.id)!;
      row.created_at = new Date(Date.now() - 5_000).toISOString();
    } else {
      challenge = p.uuid();
      h.addDeletionRow(user.id, challenge, 5_000);
    }
    const seq0 = h.calls[h.calls.length - 1]?.seq ?? 0;
    const t = performance.now();
    const res = await h.handler(h.request("/v1/me/delete-confirm", { bearer, ip, body: { challenge } }));
    const latencyMs = performance.now() - t;
    await res.body?.cancel();
    const calls = h.callsSince(seq0);
    const counts = h.countBy(calls);
    statusHistogram[String(res.status)] = (statusHistogram[String(res.status)] ?? 0) + 1;
    samples.push({
      i,
      seed,
      kind,
      status: res.status,
      latencyMs: Math.round(latencyMs * 100) / 100,
      calls: counts,
      supabaseRoundTrips: counts.auth + counts.auth_admin + counts.postgrest,
    });
  };

  // Recorded calls are shared across concurrent requests; attribute per
  // request only when concurrency is 1, otherwise keep aggregate counts.
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < n) {
      const i = next++;
      h.faults.length = 0;
      if (opts.faults) h.faults.push(...opts.faults);
      await one(i);
    }
  });
  await Promise.all(workers);
  const wallMs = performance.now() - t0;
  const heapAfter = Deno.memoryUsage();
  h.resetFaults();

  const ok = samples.filter((s) => s.status === 200);
  const perKind: Record<string, unknown> = {};
  for (const kind of ["google", "apple_token", "apple_legacy"]) {
    const ks = ok.filter((s) => s.kind === kind);
    if (ks.length === 0) continue;
    perKind[kind] = {
      n: ks.length,
      latency: latencySummary(ks.map((s) => s.latencyMs)),
      supabaseRoundTrips: concurrency === 1 ? latencySummary(ks.map((s) => s.supabaseRoundTrips)) : "aggregate only (concurrent)",
    };
  }
  const total = h.countBy(h.calls);
  return {
    label,
    requests: n,
    concurrency,
    warmAuth: opts.warmAuth,
    faults: (opts.faults ?? []).map((f) => f.id),
    statuses: statusHistogram,
    wallMs: Math.round(wallMs),
    throughputRps: Math.round((n / wallMs) * 1000 * 10) / 10,
    latency: latencySummary(ok.map((s) => s.latencyMs)),
    perKind,
    upstreamCallsPerRequest: Object.fromEntries(
      (Object.keys(total) as Upstream[]).map((u) => [u, Math.round((total[u] / n) * 100) / 100]),
    ),
    supabaseRoundTripsPerRequest: concurrency === 1
      ? latencySummary(ok.map((s) => s.supabaseRoundTrips))
      : Math.round(((total.auth + total.auth_admin + total.postgrest) / n) * 100) / 100,
    heap: { before: heapBefore, after: heapAfter, heapUsedDeltaMB: Math.round(((heapAfter.heapUsed - heapBefore.heapUsed) / 1_048_576) * 100) / 100 },
    samples,
  };
}

Deno.test(`stress delete-confirm: load — ${STRESS_ITER} requests p50/p95 + Supabase round trips per request`, async () => {
  const h = await loadStressHarness({ redis: true });
  try {
    const n = STRESS_ITER;
    const cold = await loadCampaign(h, "cold_auth_sequential", Math.max(50, Math.floor(n / 5)), 1, { warmAuth: false });
    const warm = await loadCampaign(h, "warm_auth_sequential", Math.max(50, Math.floor(n / 5)), 1, { warmAuth: true });
    const concurrent = await loadCampaign(h, "cold_auth_concurrent_20", n, 20, { warmAuth: false });
    const redisDown = await loadCampaign(h, "cold_auth_redis_500", Math.max(50, Math.floor(n / 5)), 10, {
      warmAuth: false,
      faults: [fault.http("load_redis_500", "upstash", 500, "down")],
    });
    const campaigns = [cold, warm, concurrent, redisDown];
    const path = await writeJson("load.json", { seed: STRESS_SEED, iter: n, campaigns });
    for (const c of campaigns) {
      console.log(
        `[stress] load ${c.label}: n=${c.requests} conc=${c.concurrency} statuses=${JSON.stringify(c.statuses)} p50=${c.latency.p50}ms p95=${c.latency.p95}ms p99=${c.latency.p99}ms supabaseRT/req=${JSON.stringify(c.supabaseRoundTripsPerRequest)} upstream/req=${JSON.stringify(c.upstreamCallsPerRequest)} heapΔ=${c.heap.heapUsedDeltaMB}MB`,
      );
    }
    console.log(`[stress] load → ${path}`);
    for (const c of campaigns) {
      assertEquals(c.statuses, { "200": c.requests }, `${c.label}: every seeded request must delete (statuses ${JSON.stringify(c.statuses)})`);
    }
    // Hot-path budget from the lens: a request that needs >3 Supabase round
    // trips is a finding. delete-confirm needs 5 cold / 4 warm (google) — pinned
    // here as today's behaviour and reported as P3 in the campaign report.
    const coldGoogle = (cold.perKind.google as { supabaseRoundTrips: { p50: number } }).supabaseRoundTrips;
    const warmGoogle = (warm.perKind.google as { supabaseRoundTrips: { p50: number } }).supabaseRoundTrips;
    assertEquals(coldGoogle.p50, 5, "cold google path: getUser + lookup + external lookup + RC checkpoint + admin delete");
    assertEquals(warmGoogle.p50, 4, "warm google path: lookup + external lookup + RC checkpoint + admin delete");
  } finally {
    h.detach();
  }
});
