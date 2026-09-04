// stress — POST /v1/me/consent/withdraw — FAILURE INJECTION (no Redis).
//
// Every upstream the route reaches in a Redis-less isolate (Supabase Auth
// GET /auth/v1/user, PostgREST GET/POST consent_records) is made to fail,
// time out, hang or answer malformed — one fault per case, on the exact nth
// call — and the user-visible error class (status, error.code, generic body,
// Retry-After), the upstream round-trip count and recoverability (clear the
// fault, retry with the same bearer → 200 with the scope withdrawn) are
// recorded. RevenueCat is faulted globally to prove it is not on this path.
// Client-side malformed input and the per-user route budget are included so
// the JSON table is the route's complete error-class map.
//
// Contract under test (index.ts):
//   * 400 validation.consent_withdraw for an unknown scope
//   * 401 generic for a refused bearer, 429 rate_limited + Retry-After for
//     the consent family budget (30/60s), 413 for an oversized body
//   * 503 "<context> is temporarily unavailable. Please try again." for ANY
//     upstream failure — never a 500 (500 = unhandled exception) and never a
//     body that leaks upstream detail
//   * a withdraw is idempotent: retrying after a fault or delivering it twice
//     leaves the scope withdrawn (append-only ledger, latest row wins)
//
// Seeded: case i uses caseSeed(STRESS_SEED, i) for user id, device/source
// text, garbage bodies and delays. Replay one row of the table with
//   STRESS_SEED=<base> STRESS_SLOW=1 deno test -A --no-check --config deno.json \
//     stress_consent_withdraw_faults.test.ts --filter "<case id>"
// Cases that exercise postgrest-js's built-in GET retry (1s+2s+4s backoff)
// take ~7s each and only run with STRESS_SLOW=1.
//
// Known-broken cases are pinned via `knownBroken` so the suite stays green
// while the finding is open: the pin asserts the broken behaviour STILL
// reproduces (fixing it flips the pin → remove it).

import { assert, assertEquals } from "@std/assert";
import {
  caseSeed,
  CONSENT_SCOPES,
  type ConsentScope,
  type Fault,
  type FaultContext,
  type FaultHook,
  histogram,
  leaksInternalDetail,
  loadStressHarness,
  observe,
  type Observed,
  observeWithin,
  Prng,
  scopesOf,
  STRESS_SEED,
  type StressHarness,
  withdrawRequest,
  writeJson,
} from "./stress_consent_withdraw_harness.ts";

const SLOW = Deno.env.get("STRESS_SLOW") === "1";
/** Auth upstream deadline used by the auth timeout/hang cases (env is read
 * per call by index.ts, so the default 6s can be tightened for the suite). */
const AUTH_DEADLINE_MS = 900;
/** Wall-clock budget a request must answer within to count as "bounded". */
const HANG_BUDGET_MS = 2_500;

interface Expectation {
  status: number | number[];
  code?: string | null;
  /** body must be one of the generic 5xx/4xx sentences (no upstream detail) */
  generic?: boolean;
  retryAfter?: boolean;
  /** exact number of fetches to a given upstream/method during the faulted request */
  calls?: Partial<
    Record<"auth" | "pgGet" | "pgPost" | "redis" | "revenuecat", number>
  >;
  /** rows persisted for the user after the faulted request */
  rowsAfter?: number;
  /** the faulted request's fold must already report the scope withdrawn */
  withdrawn?: boolean;
  /** the response must land within this many ms */
  maxDurationMs?: number;
  minDurationMs?: number;
  /** after clearing the fault a retry with the same bearer must 200+withdrawn */
  recovers?: boolean;
}

interface FaultCase {
  id: string;
  upstream: "auth" | "postgrest" | "revenuecat" | "client" | "route";
  title: string;
  slow?: boolean;
  /** a hang case races the handler against HANG_BUDGET_MS */
  hang?: boolean;
  /** the fake keeps a timer alive past the response (deadline cases) */
  leaky?: boolean;
  /** build the fault hook from the case PRNG (null = no upstream fault) */
  hook: (prng: Prng, ctx: CaseContext) => FaultHook | null;
  /** override the request (client-side malformed input) */
  request?: (prng: Prng, ctx: CaseContext) => Request;
  /** run before the faulted request (seed rows, exhaust budgets…) */
  before?: (h: StressHarness, prng: Prng, ctx: CaseContext) => void | Promise<void>;
  expect: Expectation;
  /** open finding this case reproduces: the pin asserts it still reproduces */
  knownBroken?: { finding: string; observedStatus: number | "hung" };
}

interface CaseContext {
  userId: string;
  token: string;
  scope: ConsentScope;
  device: string;
  source: string;
}

const onNth = (
  upstream: FaultContext["upstream"],
  method: string,
  nth: number,
  fault: Fault,
): FaultHook =>
(ctx) =>
  ctx.upstream === upstream && ctx.method === method &&
    ctx.nthOfMethod === nth
    ? fault
    : null;

const onAll = (upstream: FaultContext["upstream"], fault: Fault): FaultHook =>
(
  ctx,
) => (ctx.upstream === upstream ? fault : null);

const pgError = (code: string, message: string) => ({
  code,
  message,
  details: null,
  hint: null,
});

const authGet = (fault: Fault) => onNth("auth", "GET", 1, fault);
const pgGet1 = (fault: Fault) => onNth("postgrest", "GET", 1, fault);
const pgGet2 = (fault: Fault) => onNth("postgrest", "GET", 2, fault);
const pgPost = (fault: Fault) => onNth("postgrest", "POST", 1, fault);

const UNAVAILABLE_503: Expectation = {
  status: 503,
  code: null,
  generic: true,
  rowsAfter: 0,
  recovers: true,
};

const CASES: FaultCase[] = [
  // ── Supabase Auth (GET /auth/v1/user) ───────────────────────────────────
  {
    id: "A01-auth-500",
    upstream: "auth",
    title: "GoTrue 500 → 503 + Retry-After, nothing written",
    hook: () =>
      authGet({ kind: "status", status: 500, body: { msg: "internal" } }),
    expect: {
      ...UNAVAILABLE_503,
      retryAfter: true,
      calls: { auth: 1, pgGet: 0, pgPost: 0 },
    },
  },
  {
    id: "A02-auth-502-html",
    upstream: "auth",
    title: "GoTrue 502 HTML gateway page → 503",
    hook: () =>
      authGet({
        kind: "raw",
        status: 502,
        text: "<html>502 Bad Gateway</html>",
        contentType: "text/html",
      }),
    expect: {
      ...UNAVAILABLE_503,
      retryAfter: true,
      calls: { auth: 1, pgGet: 0 },
    },
  },
  {
    id: "A03-auth-503",
    upstream: "auth",
    title: "GoTrue 503 → 503",
    hook: () =>
      authGet({ kind: "status", status: 503, body: { msg: "maintenance" } }),
    expect: { ...UNAVAILABLE_503, retryAfter: true, calls: { auth: 1 } },
  },
  {
    id: "A04-auth-429-retry-after",
    upstream: "auth",
    title: "GoTrue 429 with Retry-After: 7 → 503 carrying a Retry-After",
    hook: () =>
      authGet({
        kind: "status",
        status: 429,
        body: { msg: "over" },
        headers: { "Retry-After": "7" },
      }),
    expect: { ...UNAVAILABLE_503, retryAfter: true, calls: { auth: 1 } },
  },
  {
    id: "A05-auth-401",
    upstream: "auth",
    title: "GoTrue refuses the bearer (401) → generic 401, no DB call",
    hook: () =>
      authGet({
        kind: "status",
        status: 401,
        body: { code: 401, msg: "invalid JWT" },
      }),
    expect: {
      status: 401,
      code: null,
      generic: true,
      calls: { auth: 1, pgGet: 0 },
      rowsAfter: 0,
      recovers: true,
    },
  },
  {
    id: "A06-auth-403",
    upstream: "auth",
    title: "GoTrue 403 → generic 401",
    hook: () =>
      authGet({
        kind: "status",
        status: 403,
        body: { code: 403, msg: "forbidden" },
      }),
    expect: {
      status: 401,
      code: null,
      generic: true,
      calls: { auth: 1, pgGet: 0 },
      recovers: true,
    },
  },
  {
    id: "A07-auth-200-nonjson",
    upstream: "auth",
    title: "GoTrue 200 with a non-JSON body → 503 (no usable body)",
    hook: (prng) =>
      authGet({ kind: "raw", status: 200, text: prng.garbage(64) }),
    expect: {
      ...UNAVAILABLE_503,
      retryAfter: true,
      calls: { auth: 1, pgGet: 0 },
    },
  },
  {
    id: "A08-auth-200-missing-id",
    upstream: "auth",
    title: "GoTrue 200 user without id → 503",
    hook: () =>
      authGet({
        kind: "status",
        status: 200,
        body: { email: "x@example.com", app_metadata: { provider: "google" } },
      }),
    expect: { ...UNAVAILABLE_503, calls: { auth: 1, pgGet: 0 } },
  },
  {
    id: "A09-auth-200-id-wrong-type",
    upstream: "auth",
    title: "GoTrue 200 with numeric id → 503",
    hook: (prng) =>
      authGet({
        kind: "status",
        status: 200,
        body: { id: prng.int(1, 9999), app_metadata: { provider: "google" } },
      }),
    expect: { ...UNAVAILABLE_503, calls: { auth: 1, pgGet: 0 } },
  },
  {
    id: "A10-auth-200-array",
    upstream: "auth",
    title: "GoTrue 200 with an array body → 503",
    hook: () => authGet({ kind: "status", status: 200, body: [] }),
    expect: { ...UNAVAILABLE_503, calls: { auth: 1, pgGet: 0 } },
  },
  {
    id: "A11-auth-204-empty",
    upstream: "auth",
    title: "GoTrue 204 empty → 503",
    hook: () => authGet({ kind: "raw", status: 204, text: "" }),
    expect: { ...UNAVAILABLE_503, calls: { auth: 1, pgGet: 0 } },
  },
  {
    id: "A12-auth-200-email-provider",
    upstream: "auth",
    title: "GoTrue 200 for an email/password account → 401 (Apple/Google only)",
    hook: (_prng, ctx) =>
      authGet({
        kind: "status",
        status: 200,
        body: {
          id: ctx.userId,
          email: "e@example.com",
          app_metadata: { provider: "email", providers: ["email"] },
        },
      }),
    expect: {
      status: 401,
      code: null,
      generic: true,
      calls: { auth: 1, pgGet: 0 },
      recovers: true,
    },
  },
  {
    id: "A13-auth-network-throw",
    upstream: "auth",
    title:
      "GoTrue connection reset on every attempt → bounded 503 after the retry ladder",
    hook: () =>
      onAll("auth", {
        kind: "throw",
        message: "error sending request: connection reset by peer",
      }),
    expect: {
      ...UNAVAILABLE_503,
      retryAfter: true,
      maxDurationMs: AUTH_DEADLINE_MS + 600,
      calls: { pgGet: 0 },
    },
  },
  {
    id: "A14-auth-hang",
    upstream: "auth",
    title: "GoTrue never answers → 503 at the auth deadline",
    hang: true,
    hook: () => authGet({ kind: "hang" }),
    expect: {
      ...UNAVAILABLE_503,
      retryAfter: true,
      minDurationMs: AUTH_DEADLINE_MS - 50,
      maxDurationMs: AUTH_DEADLINE_MS + 600,
      calls: { auth: 1, pgGet: 0 },
    },
  },
  {
    id: "A15-auth-slow-then-ok",
    upstream: "auth",
    title: "GoTrue answers after 300ms → 200 (slow, not failed)",
    hook: () => authGet({ kind: "delay", ms: 300 }),
    expect: {
      status: 200,
      withdrawn: true,
      minDurationMs: 300,
      calls: { auth: 1, pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "A16-auth-throw-once-then-ok",
    upstream: "auth",
    title:
      "GoTrue resets once, second attempt succeeds → 200 inside the same request",
    hook: () =>
      onNth("auth", "GET", 1, { kind: "throw", message: "connection reset" }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { auth: 2, pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "A17-auth-delay-past-deadline",
    upstream: "auth",
    title:
      "GoTrue answers 200 but only after the deadline → 503, nothing written",
    leaky: true,
    hook: () => authGet({ kind: "delay", ms: AUTH_DEADLINE_MS + 400 }),
    expect: {
      ...UNAVAILABLE_503,
      retryAfter: true,
      maxDurationMs: AUTH_DEADLINE_MS + 600,
      calls: { pgGet: 0 },
    },
  },

  // ── PostgREST: first read (fold before insert) ─────────────────────────
  {
    id: "P01-read1-500",
    upstream: "postgrest",
    title:
      "PostgREST 500 on the pre-insert read → 503 'Consent status', no row",
    hook: () =>
      pgGet1({
        kind: "status",
        status: 500,
        body: pgError("XX000", "internal_error"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { auth: 1, pgGet: 1, pgPost: 0 } },
  },
  {
    id: "P02-read1-503-retried",
    upstream: "postgrest",
    title:
      "PostgREST 503 on the read → postgrest-js retries 3× (1+2+4s) then 503",
    slow: true,
    hook: () =>
      onAll("postgrest", {
        kind: "status",
        status: 503,
        body: pgError("PGRST001", "db unavailable"),
      }),
    expect: {
      ...UNAVAILABLE_503,
      calls: { pgGet: 4, pgPost: 0 },
      minDurationMs: 6_900,
    },
  },
  {
    id: "P03-read1-network-throw-retried",
    upstream: "postgrest",
    title: "PostgREST connection reset on the read → 4 attempts (~7s) then 503",
    slow: true,
    hook: () =>
      onAll("postgrest", { kind: "throw", message: "error sending request" }),
    expect: {
      ...UNAVAILABLE_503,
      calls: { pgGet: 4, pgPost: 0 },
      minDurationMs: 6_900,
    },
  },
  {
    id: "P04-read1-520-retried",
    upstream: "postgrest",
    title: "PostgREST 520 (Cloudflare) on the read → retried then 503",
    slow: true,
    hook: () =>
      onAll("postgrest", {
        kind: "raw",
        status: 520,
        text: "<html>520</html>",
        contentType: "text/html",
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 4 }, minDurationMs: 6_900 },
  },
  {
    id: "P05-read1-401-pgrst301",
    upstream: "postgrest",
    title: "PostgREST 401 PGRST301 (JWT expired at the DB) → 503 generic",
    hook: () =>
      pgGet1({
        kind: "status",
        status: 401,
        body: pgError("PGRST301", "JWT expired"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 1, pgPost: 0 } },
  },
  {
    id: "P06-read1-404-json-error",
    upstream: "postgrest",
    title: "PostgREST 404 relation missing → 503",
    hook: () =>
      pgGet1({
        kind: "status",
        status: 404,
        body: pgError("PGRST205", "Could not find the table"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 1, pgPost: 0 } },
  },
  {
    id: "P07-read1-404-array",
    upstream: "postgrest",
    title:
      "PostgREST 404 with an array body → postgrest-js treats it as empty → 200 (quirk)",
    hook: () => pgGet1({ kind: "status", status: 404, body: [] }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "P08-read1-200-nonjson",
    upstream: "postgrest",
    title: "PostgREST 200 with a non-JSON body → 503",
    hook: (prng) =>
      pgGet1({ kind: "raw", status: 200, text: prng.garbage(120) }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 1, pgPost: 0 } },
  },
  {
    id: "P09-read1-200-object",
    upstream: "postgrest",
    title:
      "PostgREST 200 with an object instead of an array → must be 503, is 500 (unhandled TypeError)",
    hook: () =>
      pgGet1({ kind: "status", status: 200, body: { unexpected: true } }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 1, pgPost: 0 } },
    knownBroken: {
      finding: "F1 malformed PostgREST row set → 500",
      observedStatus: 500,
    },
  },
  {
    id: "P10-read1-200-null",
    upstream: "postgrest",
    title: "PostgREST 200 with a JSON null → treated as no rows → 200",
    hook: () => pgGet1({ kind: "raw", status: 200, text: "null" }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "P11-read1-200-null-element",
    upstream: "postgrest",
    title:
      "PostgREST 200 with a null element in the row set → must be 503, is 500",
    hook: (_p, ctx) =>
      pgGet1({
        kind: "status",
        status: 200,
        body: [{
          scope: ctx.scope,
          action: "grant",
          consent_version: "v1",
          created_at: "2026-01-01T00:00:00Z",
        }, null],
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 1, pgPost: 0 } },
    knownBroken: {
      finding: "F1 malformed PostgREST row set → 500",
      observedStatus: 500,
    },
  },
  {
    id: "P12-read1-200-wrong-types",
    upstream: "postgrest",
    title:
      "PostgREST 200 with rows of the wrong types → 200 and a well-typed fold",
    hook: (prng, ctx) =>
      pgGet1({
        kind: "status",
        status: 200,
        body: [
          {
            scope: prng.int(0, 99),
            action: "GRANT",
            consent_version: 7,
            created_at: 1,
          },
          {
            scope: ctx.scope,
            action: "unknown",
            consent_version: null,
            created_at: "not-a-date",
          },
        ],
      }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "P13-read1-200-huge",
    upstream: "postgrest",
    title: "PostgREST 200 with 5000 rows → 200 (fold cost bounded)",
    hook: (prng, ctx) =>
      pgGet1({
        kind: "status",
        status: 200,
        body: Array.from({ length: 5000 }, (_, i) => ({
          scope: prng.pick(CONSENT_SCOPES),
          action: prng.pick(["grant", "withdraw"]),
          consent_version: `v${prng.int(1, 9)}`,
          created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
          ...(i === 4999
            ? { scope: ctx.scope, action: "grant", consent_version: "v-latest" }
            : {}),
        })),
      }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
      maxDurationMs: 1_500,
    },
  },
  {
    id: "P14-read1-hang",
    upstream: "postgrest",
    title:
      "PostgREST never answers the read → request must fail within a deadline, hangs forever (no DB timeout)",
    hang: true,
    hook: () => pgGet1({ kind: "hang" }),
    expect: {
      ...UNAVAILABLE_503,
      maxDurationMs: HANG_BUDGET_MS,
      calls: { pgGet: 1, pgPost: 0 },
    },
    knownBroken: {
      finding: "F2 no deadline on PostgREST calls",
      observedStatus: "hung",
    },
  },
  {
    id: "P15-read1-slow",
    upstream: "postgrest",
    title: "PostgREST read answers after 250ms → 200",
    hook: () => pgGet1({ kind: "delay", ms: 250 }),
    expect: {
      status: 200,
      withdrawn: true,
      minDurationMs: 250,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "P16-read1-429",
    upstream: "postgrest",
    title:
      "PostgREST 429 on the read → 503 generic (no retry: 429 is not retryable)",
    hook: () =>
      pgGet1({
        kind: "status",
        status: 429,
        body: pgError("PGRST", "too many"),
        headers: { "Retry-After": "3" },
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 1, pgPost: 0 } },
  },

  // ── PostgREST: the insert ──────────────────────────────────────────────
  {
    id: "I01-insert-500",
    upstream: "postgrest",
    title:
      "PostgREST 500 on the insert → 503 'Consent update', no row, retry recovers",
    hook: () =>
      pgPost({
        kind: "status",
        status: 500,
        body: pgError("XX000", "internal"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgGet: 1, pgPost: 1 } },
  },
  {
    id: "I02-insert-503-not-retried",
    upstream: "postgrest",
    title:
      "PostgREST 503 on the insert → immediate 503 (POST is never retried)",
    hook: () =>
      pgPost({
        kind: "status",
        status: 503,
        body: pgError("PGRST001", "db unavailable"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 }, maxDurationMs: 900 },
  },
  {
    id: "I03-insert-network-throw",
    upstream: "postgrest",
    title: "connection reset on the insert → immediate 503, one attempt",
    hook: () => pgPost({ kind: "throw", message: "error sending request" }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 }, maxDurationMs: 900 },
  },
  {
    id: "I04-insert-409-unique",
    upstream: "postgrest",
    title: "PostgREST 409 23505 → 503",
    hook: () =>
      pgPost({
        kind: "status",
        status: 409,
        body: pgError("23505", "duplicate key value"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 } },
  },
  {
    id: "I05-insert-403-rls",
    upstream: "postgrest",
    title:
      "PostgREST 403 42501 (RLS) → 503, body does not leak the policy text",
    hook: () =>
      pgPost({
        kind: "status",
        status: 403,
        body: pgError(
          "42501",
          'new row violates row-level security policy for table "consent_records"',
        ),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 } },
  },
  {
    id: "I06-insert-400-check",
    upstream: "postgrest",
    title: "PostgREST 400 23514 (check constraint) → 503",
    hook: () =>
      pgPost({
        kind: "status",
        status: 400,
        body: pgError(
          "23514",
          'new row for relation "consent_records" violates check constraint "consent_records_bounds"',
        ),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 } },
  },
  {
    id: "I07-insert-401-pgrst301",
    upstream: "postgrest",
    title: "PostgREST 401 on the insert → 503",
    hook: () =>
      pgPost({
        kind: "status",
        status: 401,
        body: pgError("PGRST301", "JWT expired"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 } },
  },
  {
    id: "I08-insert-201-junk-body",
    upstream: "postgrest",
    title:
      "insert lands but PostgREST answers 201 with junk → 503 while the row exists; retry is idempotent",
    hook: (prng) =>
      pgPost({
        kind: "afterReal",
        then: { kind: "raw", status: 201, text: prng.garbage(40) },
      }),
    expect: {
      status: 503,
      code: null,
      generic: true,
      calls: { pgGet: 1, pgPost: 1 },
      rowsAfter: 1,
      recovers: true,
    },
  },
  {
    id: "I09-insert-201-object-body",
    upstream: "postgrest",
    title:
      "insert answers 201 with an unexpected JSON object → 200 (no error surfaced)",
    hook: () =>
      pgPost({
        kind: "afterReal",
        then: { kind: "status", status: 201, body: { odd: true } },
      }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "I10-insert-hang",
    upstream: "postgrest",
    title: "PostgREST never answers the insert → request hangs (no DB timeout)",
    hang: true,
    hook: () => pgPost({ kind: "hang" }),
    expect: {
      ...UNAVAILABLE_503,
      maxDurationMs: HANG_BUDGET_MS,
      calls: { pgPost: 1 },
    },
    knownBroken: {
      finding: "F2 no deadline on PostgREST calls",
      observedStatus: "hung",
    },
  },
  {
    id: "I11-insert-slow",
    upstream: "postgrest",
    title: "insert answers after 300ms → 200",
    hook: () => pgPost({ kind: "delay", ms: 300 }),
    expect: { status: 200, withdrawn: true, minDurationMs: 300, rowsAfter: 1 },
  },
  {
    id: "I12-insert-429",
    upstream: "postgrest",
    title: "PostgREST 429 on the insert → 503 generic",
    hook: () =>
      pgPost({
        kind: "status",
        status: 429,
        body: pgError("PGRST", "too many"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 } },
  },
  {
    id: "I13-insert-502-html",
    upstream: "postgrest",
    title: "PostgREST 502 HTML on the insert → 503",
    hook: () =>
      pgPost({
        kind: "raw",
        status: 502,
        text: "<html>502</html>",
        contentType: "text/html",
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 } },
  },
  {
    id: "I14-insert-413",
    upstream: "postgrest",
    title: "PostgREST 413 on the insert → 503",
    hook: () =>
      pgPost({
        kind: "status",
        status: 413,
        body: pgError("PGRST", "payload too large"),
      }),
    expect: { ...UNAVAILABLE_503, calls: { pgPost: 1 } },
  },

  // ── PostgREST: the post-insert read ────────────────────────────────────
  {
    id: "R01-read2-500",
    upstream: "postgrest",
    title:
      "500 on the read AFTER the insert → 503 although the withdraw persisted; retry → 200 withdrawn",
    hook: () =>
      pgGet2({
        kind: "status",
        status: 500,
        body: pgError("XX000", "internal"),
      }),
    expect: {
      status: 503,
      code: null,
      generic: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
      recovers: true,
    },
  },
  {
    id: "R02-read2-nonjson",
    upstream: "postgrest",
    title: "non-JSON 200 on the read after the insert → 503, row persisted",
    hook: (prng) =>
      pgGet2({ kind: "raw", status: 200, text: prng.garbage(30) }),
    expect: {
      status: 503,
      code: null,
      generic: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
      recovers: true,
    },
  },
  {
    id: "R03-read2-object",
    upstream: "postgrest",
    title:
      "object instead of array on the read after the insert → must be 503, is 500",
    hook: () => pgGet2({ kind: "status", status: 200, body: { odd: 1 } }),
    expect: {
      status: 503,
      code: null,
      generic: true,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
      recovers: true,
    },
    knownBroken: {
      finding: "F1 malformed PostgREST row set → 500",
      observedStatus: 500,
    },
  },
  {
    id: "R04-read2-hang",
    upstream: "postgrest",
    title:
      "read after the insert never answers → hangs with the row already written",
    hang: true,
    hook: () => pgGet2({ kind: "hang" }),
    expect: {
      status: 503,
      generic: true,
      maxDurationMs: HANG_BUDGET_MS,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
    knownBroken: {
      finding: "F2 no deadline on PostgREST calls",
      observedStatus: "hung",
    },
  },
  {
    id: "R05-read2-stale-empty",
    upstream: "postgrest",
    title:
      "read after the insert returns a stale empty set → 200 that does NOT show the withdraw",
    hook: () => pgGet2({ kind: "status", status: 200, body: [] }),
    expect: {
      status: 200,
      withdrawn: false,
      calls: { pgGet: 2, pgPost: 1 },
      rowsAfter: 1,
    },
  },
  {
    id: "R06-read2-503-retried",
    upstream: "postgrest",
    title:
      "503 on the read after the insert → 3 retries (~7s) then 503, row persisted",
    slow: true,
    hook: () => (ctx) =>
      ctx.upstream === "postgrest" && ctx.method === "GET" &&
        ctx.nthOfMethod >= 2
        ? {
          kind: "status",
          status: 503,
          body: pgError("PGRST001", "db unavailable"),
        }
        : null,
    expect: {
      status: 503,
      code: null,
      generic: true,
      calls: { pgGet: 5, pgPost: 1 },
      rowsAfter: 1,
      minDurationMs: 6_900,
      recovers: true,
    },
  },

  // ── RevenueCat: not on this path ───────────────────────────────────────
  {
    id: "V01-revenuecat-500-global",
    upstream: "revenuecat",
    title:
      "RevenueCat 500 for everything → withdraw unaffected, zero RevenueCat calls",
    hook: () =>
      onAll("revenuecat", {
        kind: "status",
        status: 500,
        body: { message: "down" },
      }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { revenuecat: 0 },
      rowsAfter: 1,
    },
  },
  {
    id: "V02-revenuecat-hang-global",
    upstream: "revenuecat",
    title: "RevenueCat hangs → withdraw unaffected, zero RevenueCat calls",
    hook: () => onAll("revenuecat", { kind: "hang" }),
    expect: {
      status: 200,
      withdrawn: true,
      calls: { revenuecat: 0 },
      rowsAfter: 1,
      maxDurationMs: 900,
    },
  },

  // ── Client-side malformed input (the route's own 4xx map) ──────────────
  {
    id: "C01-unknown-scope",
    upstream: "client",
    title: "unknown scope → 400 validation.consent_withdraw before any DB call",
    hook: () => null,
    request: (prng, ctx) =>
      withdrawRequest(ctx.token, { scope: prng.text(12), device: ctx.device }),
    expect: {
      status: 400,
      code: "validation.consent_withdraw",
      calls: { pgGet: 0, pgPost: 0 },
      rowsAfter: 0,
    },
  },
  {
    id: "C02-nonjson-body",
    upstream: "client",
    title: "non-JSON body → 400 validation.consent_withdraw",
    hook: () => null,
    request: (prng, ctx) =>
      withdrawRequest(ctx.token, undefined, { rawBody: prng.garbage(40) }),
    expect: {
      status: 400,
      code: "validation.consent_withdraw",
      calls: { pgGet: 0, pgPost: 0 },
    },
  },
  {
    id: "C03-empty-body",
    upstream: "client",
    title: "no body → 400",
    hook: () => null,
    request: (_p, ctx) => withdrawRequest(ctx.token, undefined),
    expect: {
      status: 400,
      code: "validation.consent_withdraw",
      calls: { pgGet: 0 },
    },
  },
  {
    id: "C04-array-body",
    upstream: "client",
    title: "JSON array body → 400",
    hook: () => null,
    request: (_p, ctx) => withdrawRequest(ctx.token, [{ scope: ctx.scope }]),
    expect: {
      status: 400,
      code: "validation.consent_withdraw",
      calls: { pgGet: 0 },
    },
  },
  {
    id: "C05-scope-wrong-type",
    upstream: "client",
    title: "scope as an object → 400",
    hook: () => null,
    request: (_p, ctx) => withdrawRequest(ctx.token, { scope: { $ne: null } }),
    expect: {
      status: 400,
      code: "validation.consent_withdraw",
      calls: { pgGet: 0 },
    },
  },
  {
    id: "C06-huge-device",
    upstream: "client",
    title: "100KB device string → 200, stored device capped at 512 chars",
    hook: () => null,
    request: (prng, ctx) =>
      withdrawRequest(ctx.token, {
        scope: ctx.scope,
        device: prng.text(100_000),
        source: prng.text(5_000),
      }),
    expect: { status: 200, withdrawn: true, rowsAfter: 1 },
  },
  {
    id: "C07-oversized-body",
    upstream: "client",
    title: "> 5MB body → 413 before auth",
    hook: () => null,
    request: (_p, ctx) =>
      withdrawRequest(ctx.token, undefined, {
        rawBody: `{"scope":"model_training","device":"${
          "x".repeat(5_000_001)
        }"}`,
      }),
    expect: { status: 413, calls: { pgGet: 0, pgPost: 0 } },
  },
  {
    id: "C08-no-bearer",
    upstream: "client",
    title: "no bearer → 401, zero upstream calls",
    hook: () => null,
    request: (_p, ctx) => withdrawRequest(null, { scope: ctx.scope }),
    expect: {
      status: 401,
      code: null,
      generic: true,
      calls: { auth: 0, pgGet: 0 },
    },
  },
  {
    id: "C09-expired-bearer",
    upstream: "client",
    title: "expired session token → 401 without consulting GoTrue",
    hook: () => null,
    before: (h, _p, ctx) => {
      const expired = h.mintSession(ctx.userId, -120);
      ctx.token = expired.accessToken;
    },
    expect: {
      status: 401,
      code: null,
      generic: true,
      calls: { auth: 0, pgGet: 0 },
    },
  },
  {
    id: "C10-garbage-bearer",
    upstream: "client",
    title: "random bearer → 401 without consulting GoTrue",
    hook: () => null,
    request: (prng, ctx) =>
      withdrawRequest(prng.text(40), { scope: ctx.scope }),
    expect: {
      status: 401,
      code: null,
      generic: true,
      calls: { auth: 0, pgGet: 0 },
    },
  },

  // ── Route semantics under load-ish conditions ──────────────────────────
  {
    id: "S01-duplicate-delivery",
    upstream: "route",
    title:
      "the same withdraw delivered twice → both 200, two ledger rows, scope withdrawn (idempotent)",
    hook: () => null,
    before: async (h, _p, ctx) => {
      const first = await observe(
        h.handler,
        withdrawRequest(ctx.token, { scope: ctx.scope, device: ctx.device }),
      );
      assertEquals(first.status, 200);
    },
    expect: { status: 200, withdrawn: true, rowsAfter: 2 },
  },
  {
    id: "S02-withdraw-after-grant",
    upstream: "route",
    title: "withdraw after a grant carries the granted consentVersion forward",
    hook: () => null,
    before: (h, _p, ctx) => {
      h.consentRecords.push({
        id: "00000000-0000-4000-8000-00000000aaaa",
        user_id: ctx.userId,
        scope: ctx.scope,
        consent_version: "2026-08-01",
        action: "grant",
        source: "mobile_settings",
        device: ctx.device,
        capture_mode: "all_captures",
        created_at: "2026-08-01T00:00:00.000Z",
      });
    },
    expect: { status: 200, withdrawn: true, rowsAfter: 2 },
  },
  {
    id: "S03-consent-budget-exhausted",
    upstream: "route",
    title:
      "31st consent call inside the minute → 429 rate_limited + Retry-After, no DB call",
    hook: () => null,
    before: async (h, _p, ctx) => {
      for (let i = 0; i < 30; i++) {
        const r = await observe(
          h.handler,
          withdrawRequest(ctx.token, { scope: ctx.scope }),
        );
        assertEquals(r.status, 200, `warm-up ${i}: ${JSON.stringify(r.body)}`);
      }
      h.calls.length = 0;
    },
    expect: {
      status: 429,
      code: "rate_limited",
      retryAfter: true,
      calls: { pgGet: 0, pgPost: 0 },
      rowsAfter: 30,
    },
  },
  {
    id: "S04-concurrent-same-user",
    upstream: "route",
    title:
      "8 concurrent withdraws for one user with a slow insert → all 200, 8 rows, withdrawn",
    hook: () => onAll("postgrest", { kind: "delay", ms: 40 }),
    before: async (h, _p, ctx) => {
      const burst = await Promise.all(
        Array.from(
          { length: 7 },
          () =>
            observe(
              h.handler,
              withdrawRequest(ctx.token, { scope: ctx.scope }),
            ),
        ),
      );
      for (const r of burst) assertEquals(r.status, 200);
    },
    expect: { status: 200, withdrawn: true, rowsAfter: 8 },
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

interface CaseRow {
  index: number;
  id: string;
  seed: number;
  upstream: string;
  title: string;
  userId: string;
  scope: string;
  observed: Observed | "hung";
  calls: Record<string, number>;
  faults: string[];
  rowsAfter: number;
  recovery:
    | { status: number; withdrawn: boolean | null; rowsAfter: number }
    | null;
  expected: Expectation;
  violations: string[];
  verdict: "HELD" | "BROKEN" | "BROKEN(known)" | "SKIPPED(slow)";
  replay: string;
}

const rows: CaseRow[] = [];

function foldWithdrawn(observed: Observed, scope: string): boolean | null {
  const scopes = scopesOf(observed.body);
  if (!scopes) return null;
  const entry = scopes.find((s) => s.scope === scope);
  if (!entry) return null;
  return entry.active === false && entry.lastAction === "withdrawn";
}

function wellTypedFold(observed: Observed): string | null {
  const scopes = scopesOf(observed.body);
  if (!scopes) return "body has no scopes[]";
  if (scopes.length !== CONSENT_SCOPES.length) {
    return `scopes has ${scopes.length} entries`;
  }
  for (const s of scopes) {
    if (!(CONSENT_SCOPES as readonly string[]).includes(s.scope)) {
      return `unknown scope ${s.scope}`;
    }
    if (typeof s.active !== "boolean") {
      return `active not boolean for ${s.scope}`;
    }
    if (![null, "granted", "withdrawn"].includes(s.lastAction)) {
      return `lastAction ${String(s.lastAction)}`;
    }
    if (s.consentVersion !== null && typeof s.consentVersion !== "string") {
      return `consentVersion type`;
    }
    if (s.lastActionAt !== null && typeof s.lastActionAt !== "string") {
      return `lastActionAt type`;
    }
  }
  return null;
}

const GENERIC_BODY =
  /^(.+ is temporarily unavailable\. Please try again\.|Something went wrong\. Please try again\.|Missing bearer token\.|The session (token )?(is no longer valid|has expired)\..*|The session does not belong to a Google or Apple account\.|Bearer token is not a session token or a Google\/Apple ID token\.|Request body is too large\.)$/;

function judge(
  row: Omit<CaseRow, "violations" | "verdict" | "replay">,
  expect: Expectation,
  bodyText: string,
): string[] {
  const v: string[] = [];
  const o = row.observed;
  if (o === "hung") {
    v.push(`request did not answer within ${HANG_BUDGET_MS}ms`);
  } else {
    const wanted = Array.isArray(expect.status)
      ? expect.status
      : [expect.status];
    if (!wanted.includes(o.status)) {
      v.push(`status ${o.status} ∉ ${wanted.join("|")}`);
    }
    if (expect.code !== undefined && o.code !== expect.code) {
      v.push(`code ${o.code} ≠ ${expect.code}`);
    }
    if (expect.generic) {
      if (!o.message || !GENERIC_BODY.test(o.message)) {
        v.push(`non-generic message: ${o.message}`);
      }
      if (leaksInternalDetail(bodyText)) {
        v.push(`body leaks upstream detail: ${bodyText.slice(0, 120)}`);
      }
    }
    if (expect.retryAfter && !o.retryAfter) v.push("missing Retry-After");
    if (expect.withdrawn !== undefined) {
      const w = foldWithdrawn(o, row.scope);
      if (w !== expect.withdrawn) {
        v.push(`fold withdrawn=${w} ≠ ${expect.withdrawn}`);
      }
    }
    if (o.status === 200) {
      const typed = wellTypedFold(o);
      if (typed) v.push(`fold not well-typed: ${typed}`);
    }
    if (
      expect.maxDurationMs !== undefined && o.durationMs > expect.maxDurationMs
    ) {
      v.push(`took ${o.durationMs}ms > ${expect.maxDurationMs}ms`);
    }
    if (
      expect.minDurationMs !== undefined && o.durationMs < expect.minDurationMs
    ) {
      v.push(`took ${o.durationMs}ms < ${expect.minDurationMs}ms`);
    }
    if (!o.requestId) v.push("missing x-request-id");
  }
  for (const [k, n] of Object.entries(expect.calls ?? {})) {
    if (row.calls[k] !== n) v.push(`${k} calls ${row.calls[k]} ≠ ${n}`);
  }
  if (expect.rowsAfter !== undefined && row.rowsAfter !== expect.rowsAfter) {
    v.push(`rows after ${row.rowsAfter} ≠ ${expect.rowsAfter}`);
  }
  if (expect.recovers) {
    if (!row.recovery) v.push("no recovery attempt recorded");
    else if (row.recovery.status !== 200 || row.recovery.withdrawn !== true) {
      v.push(
        `recovery ${row.recovery.status} withdrawn=${row.recovery.withdrawn}`,
      );
    }
  }
  return v;
}


const replayFor = (id: string) =>
  `STRESS_SEED=${STRESS_SEED} STRESS_SLOW=1 deno test -A --no-check --config deno.json stress_consent_withdraw_faults.test.ts --filter "${id}"`;

for (const [index, c] of CASES.entries()) {
  const seed = caseSeed(STRESS_SEED, index);
  const skip = Boolean(c.slow) && !SLOW;
  Deno.test({
    name: `stress-faults ${c.id} [seed ${seed}]: ${c.title}`,
    ignore: skip,
    sanitizeOps: !(c.hang || c.leaky),
    sanitizeResources: !(c.hang || c.leaky),
    async fn() {
      const h = await loadStressHarness();
      Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_DEADLINE_MS));
      try {
        const prng = new Prng(seed);
        const ctx: CaseContext = {
          userId: prng.uuid(),
          token: "",
          scope: prng.pick(CONSENT_SCOPES),
          device: `iPhone${prng.int(12, 18)},${prng.int(1, 4)} iOS ${
            prng.int(17, 26)
          }.${prng.int(0, 4)} ${prng.text(8)}`,
          source: prng.pick([
            "mobile_settings",
            "mobile_onboarding",
            prng.text(10),
          ]),
        };
        ctx.token = h.mintSession(ctx.userId).accessToken;
        h.fault = c.hook(prng, ctx);
        if (c.before) await c.before(h, prng, ctx);
        const callsBefore = h.calls.length;
        const request = c.request
          ? c.request(prng, ctx)
          : withdrawRequest(ctx.token, {
            scope: ctx.scope,
            source: ctx.source,
            device: ctx.device,
          });
        const observed = c.hang
          ? await observeWithin(h.handler, request, HANG_BUDGET_MS)
          : await observe(h.handler, request);
        const during = h.calls.slice(callsBefore);
        const calls = {
          auth: during.filter((x) => x.upstream === "auth").length,
          pgGet: during.filter((x) =>
            x.upstream === "postgrest" && x.method === "GET"
          ).length,
          pgPost: during.filter((x) =>
            x.upstream === "postgrest" && x.method === "POST"
          ).length,
          redis: during.filter((x) =>
            x.upstream === "redis"
          ).length,
          revenuecat: during.filter((x) => x.upstream === "revenuecat").length,
          other: during.filter((x) => x.upstream === "other").length,
        };
        const faults = during.filter((x) => x.fault).map((x) =>
          `${x.upstream}:${x.method}#${x.seq}=${x.fault}`
        );
        const rowsAfter = h.rowsFor(ctx.userId).length;

        // Recoverability: clear the fault, retry with the same bearer.
        h.fault = null;
        let recovery: CaseRow["recovery"] = null;
        if (c.expect.recovers) {
          const again = await observe(
            h.handler,
            withdrawRequest(ctx.token, {
              scope: ctx.scope,
              source: ctx.source,
              device: ctx.device,
            }),
          );
          recovery = {
            status: again.status,
            withdrawn: foldWithdrawn(again, ctx.scope),
            rowsAfter: h.rowsFor(ctx.userId).length,
          };
        }

        const partial = {
          index,
          id: c.id,
          seed,
          upstream: c.upstream,
          title: c.title,
          userId: ctx.userId,
          scope: ctx.scope,
          observed,
          calls,
          faults,
          rowsAfter,
          recovery,
          expected: c.expect,
        };
        const bodyText = observed === "hung"
          ? ""
          : JSON.stringify(observed.body ?? "");
        const violations = judge(partial, c.expect, bodyText);
        let verdict: CaseRow["verdict"] = violations.length === 0
          ? "HELD"
          : "BROKEN";
        if (c.knownBroken) {
          const stillBroken = observed === "hung"
            ? c.knownBroken.observedStatus === "hung"
            : observed.status === c.knownBroken.observedStatus;
          assert(
            stillBroken,
            `${c.id}: pinned finding "${c.knownBroken.finding}" no longer reproduces (observed ${
              observed === "hung" ? "hung" : observed.status
            }) — remove the knownBroken pin`,
          );
          verdict = "BROKEN(known)";
        }
        const row: CaseRow = {
          ...partial,
          violations,
          verdict,
          replay: replayFor(c.id),
        };
        rows.push(row);
        console.log(
          `[stress-faults] ${verdict.padEnd(13)} ${c.id} → ${
            observed === "hung" ? "hung" : observed.status
          } ${violations.join("; ")}`,
        );
        if (!c.knownBroken) {
          assertEquals(
            violations,
            [],
            `${c.id} violated the contract (replay: ${row.replay})\n${
              JSON.stringify(row, null, 2)
            }`,
          );
        }
        // Extra invariant for C06: the stored device/source honour the route's caps.
        if (c.id === "C06-huge-device") {
          const stored = h.rowsFor(ctx.userId)[0];
          assert(
            typeof stored.device === "string" && stored.device.length <= 512,
            "device capped at 512",
          );
          assert(
            typeof stored.source === "string" && stored.source.length <= 64,
            "source capped at 64",
          );
        }
        if (c.id === "S02-withdraw-after-grant") {
          const withdrawRow = h.rowsFor(ctx.userId).at(-1)!;
          assertEquals(
            withdrawRow.consent_version,
            "2026-08-01",
            "withdraw row carries the granted version",
          );
          const scopes = scopesOf(observed === "hung" ? null : observed.body)!;
          assertEquals(
            scopes.find((s) => s.scope === ctx.scope)!.consentVersion,
            "2026-08-01",
          );
        }
      } finally {
        Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
        h.fault = null;
      }
    },
  });
}

Deno.test("stress-faults: report (seed → outcome table)", async () => {
  const executed = rows.length;
  const skipped = CASES.filter((c) => c.slow && !SLOW).map((c) => c.id);
  const table = {
    unit: "route-post-v1-me-consent-withdraw",
    lens: "failure-load/faults",
    baseSeed: STRESS_SEED,
    slowIncluded: SLOW,
    casesDefined: CASES.length,
    casesExecuted: executed,
    skippedSlow: skipped,
    verdicts: histogram(rows.map((r) => r.verdict)),
    upstreamFaultCases:
      rows.filter((r) =>
        ["auth", "postgrest", "revenuecat"].includes(r.upstream)
      ).length,
    findings: [
      ...new Set(
        CASES.filter((c) => c.knownBroken && rows.some((r) => r.id === c.id))
          .map((c) => c.knownBroken!.finding),
      ),
    ],
    rows,
  };
  const path = await writeJson("faults.json", table);
  console.log(
    `[stress-faults] wrote ${path}: ${executed} executed, ${
      JSON.stringify(table.verdicts)
    }`,
  );
  const wanted = CASES.length - skipped.length;
  assertEquals(executed, wanted, "every non-skipped case produced a row");
  assert(
    !rows.some((r) => r.verdict === "BROKEN"),
    "an unpinned case broke — see the rows above",
  );
});
