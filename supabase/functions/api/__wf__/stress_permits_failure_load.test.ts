/**
 * stress: POST /v1/analysis-permits — FAILURE INJECTION + LOAD (lens `failure-load`).
 *
 * Real handler in-process (stress_permits_harness.ts), every upstream faked
 * and fault-injectable. This module boots WITHOUT Upstash (per-isolate L1
 * only); stress_permits_redis_faults.test.ts boots the Redis-configured
 * isolate, stress_permits_pg.test.ts drives the real RPCs on postgres:16.
 *
 *   cd supabase/functions/api/__wf__ && deno task test stress_permits_failure_load.test.ts
 *   STRESS_ITER=1000 STRESS_USERS=20000 STRESS_FAULT_ITER=400 STRESS_OUT_DIR=/tmp/stress \
 *     deno test -A --no-check --config deno.json stress_permits_failure_load.test.ts
 *
 * Replay: STRESS_SEED=<seed> selects the whole campaign; every table row in
 * the JSON report carries the per-case seed and the fault id.
 *
 * Sections
 *   1. FAULT MATRIX — one deterministic case per upstream fault (>= 40),
 *      asserting the user-visible error class (status + error.code +
 *      Retry-After + generic body, no upstream detail) AND recoverability
 *      (fault cleared → the same request, same idempotency key → success,
 *      same permit id when one was already reserved, never a second row).
 *   2. RANDOMIZED FAULT CAMPAIGN — STRESS_FAULT_ITER iterations: seeded
 *      fault × random pre-state (premium / scored / prior reservations /
 *      warm or cold auth), outcome checked against an oracle.
 *   3. LOAD — STRESS_ITER sequential requests: p50/p95 latency and upstream
 *      round trips PER REQUEST (>3 Supabase round trips on the hot path is a
 *      finding), plus a concurrent burst (same-key idempotency, free-limit).
 *   4. L1 MEMORY — STRESS_USERS distinct users through the route: heap
 *      before/after, cache cap observed via eviction of the first user.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  deriveSeed,
  type Fault,
  heapSnapshot,
  loadStressHarness,
  observe,
  type Observed,
  percentile,
  Prng,
  raceHandler,
  STRESS_FAULT_ITER,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_USERS,
  type StressHarness,
  UPSTREAM_DETAIL_MARKER,
  type Upstream,
  writeReport,
} from "./stress_permits_harness.ts";

// The Auth deadline is read per call (AUTH_UPSTREAM_TIMEOUT_MS override):
// shortened so black-hole cases take 0.4 s instead of the production 6 s.
// The connect-retry backoff is unchanged (100/200/400 ms), so a socket fault
// still gets its retries inside the deadline.
const AUTH_TIMEOUT_MS = 400;
Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));

/** How long a hung PostgREST call is given before we call the route "pending". */
const HANG_PROBE_MS = 1_500;

type Klass =
  | { status: 200 }
  | { status: 400; code: "validation.analysis_permit" }
  | { status: 401 }
  | { status: 402; code: "access.paywall_required" }
  | { status: 413 }
  | { status: 429 }
  | { status: 503; retryAfter?: boolean }
  /** Not answered within HANG_PROBE_MS — documented as such, then released. */
  | { status: "pending" };

interface FaultCase {
  id: string;
  upstream: Upstream | "request";
  /** Cold: the bearer is not in the auth cache (GoTrue will be called). */
  auth: "cold" | "warm" | "provider";
  fault?: Fault;
  times?: number;
  request?: {
    body?: unknown;
    rawBody?: string;
    token?: string | null | "expired" | "garbage";
    headers?: Record<string, string>;
  };
  expect: Klass;
  /** After the fault clears, the same request must succeed (default true). */
  recovers?: boolean;
  note?: string;
}

const PGRST = (status: number, code: string, message: string) => ({
  kind: "status" as const,
  status,
  body: { message: `${UPSTREAM_DETAIL_MARKER} ${message}`, details: null, hint: null, code },
});
const GOTRUE = (status: number, headers?: Record<string, string>) => ({
  kind: "status" as const,
  status,
  headers,
});
const HTML = (status: number) => ({
  kind: "text" as const,
  status,
  text: `<html><body>${UPSTREAM_DETAIL_MARKER} gateway ${status}</body></html>`,
});
const acceptedRow = (overrides: Record<string, unknown> = {}) => ({
  result: "accepted",
  permit_id: "11111111-1111-4111-8111-111111111111",
  permit_status: "reserved",
  permit_outcome: null,
  permit_created_at: "2026-09-04T12:00:00.000Z",
  ...overrides,
});

const S503 = { status: 503 } as const;
const S503RA = { status: 503, retryAfter: true } as const;
const S401 = { status: 401 } as const;
const S400 = { status: 400, code: "validation.analysis_permit" } as const;

export const FAULT_CASES: FaultCase[] = [
  // ── Supabase Auth (GoTrue) — session bearer verification, cold cache ──────
  { id: "G01-gotrue-500", upstream: "gotrue", auth: "cold", fault: GOTRUE(500), expect: S503RA },
  { id: "G02-gotrue-502", upstream: "gotrue", auth: "cold", fault: GOTRUE(502), expect: S503RA },
  {
    id: "G03-gotrue-503-retry-after",
    upstream: "gotrue",
    auth: "cold",
    fault: GOTRUE(503, { "Retry-After": "7" }),
    expect: S503RA,
  },
  { id: "G04-gotrue-504", upstream: "gotrue", auth: "cold", fault: GOTRUE(504), expect: S503RA },
  {
    id: "G05-gotrue-429-retry-after",
    upstream: "gotrue",
    auth: "cold",
    fault: GOTRUE(429, { "Retry-After": "30" }),
    expect: S503RA,
  },
  { id: "G06-gotrue-404", upstream: "gotrue", auth: "cold", fault: GOTRUE(404), expect: S503RA },
  { id: "G07-gotrue-200-html", upstream: "gotrue", auth: "cold", fault: HTML(200), expect: S503RA },
  {
    id: "G08-gotrue-200-empty-object",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "status", status: 200, body: {} },
    expect: S503RA,
  },
  {
    id: "G09-gotrue-200-null",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "status", status: 200, body: null },
    expect: S503RA,
  },
  {
    id: "G10-gotrue-200-array",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "status", status: 200, body: [] },
    expect: S503RA,
  },
  {
    id: "G11-gotrue-200-no-provider",
    upstream: "gotrue",
    auth: "cold",
    fault: {
      kind: "status",
      status: 200,
      body: { id: "99999999-9999-4999-8999-999999999999", app_metadata: { provider: "email" } },
    },
    expect: S401,
    recovers: true,
    note: "a verified user that is not Google/Apple is refused (401), not an outage",
  },
  { id: "G12-gotrue-401", upstream: "gotrue", auth: "cold", fault: GOTRUE(401), expect: S401 },
  { id: "G13-gotrue-403", upstream: "gotrue", auth: "cold", fault: GOTRUE(403), expect: S401 },
  { id: "G14-gotrue-400", upstream: "gotrue", auth: "cold", fault: GOTRUE(400), expect: S401 },
  {
    id: "G15-gotrue-socket-sticky",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "throw" },
    times: Infinity,
    expect: S503RA,
  },
  {
    id: "G16-gotrue-socket-once-then-ok",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "throw" },
    times: 1,
    expect: { status: 200 },
    note: "connect retry inside the deadline",
  },
  {
    id: "G17-gotrue-socket-twice-then-ok",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "throw" },
    times: 2,
    expect: { status: 200 },
  },
  {
    id: "G18-gotrue-hang",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "hang" },
    times: Infinity,
    expect: S503RA,
    note: "AUTH_UPSTREAM_TIMEOUT_MS deadline",
  },
  {
    id: "G19-gotrue-slow-inside-deadline",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "delay", ms: 150 },
    expect: { status: 200 },
  },
  {
    id: "G20-gotrue-slow-500",
    upstream: "gotrue",
    auth: "cold",
    fault: { kind: "delay_status", ms: 100, status: 500 },
    expect: S503RA,
  },
  // ── Supabase Auth — transitional provider ID-token bearer (signInWithIdToken) ──
  {
    id: "P01-idtoken-grant-500",
    upstream: "gotrue",
    auth: "provider",
    fault: GOTRUE(500),
    expect: S503,
    note: "outage on the transitional path",
  },
  {
    id: "P02-idtoken-grant-socket",
    upstream: "gotrue",
    auth: "provider",
    fault: { kind: "throw" },
    times: Infinity,
    expect: S503,
  },
  {
    id: "P03-idtoken-grant-200-malformed",
    upstream: "gotrue",
    auth: "provider",
    fault: { kind: "status", status: 200, body: { user: null } },
    expect: S503,
  },
  {
    id: "P04-idtoken-grant-400",
    upstream: "gotrue",
    auth: "provider",
    fault: GOTRUE(400),
    expect: S401,
  },
  // ── PostgREST rpc/reserve_analysis_permit (auth warm) ──────────────────────
  {
    id: "R01-reserve-500",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(500, "XX000", "internal error"),
    expect: S503,
  },
  { id: "R02-reserve-502-html", upstream: "reserve", auth: "warm", fault: HTML(502), expect: S503 },
  {
    id: "R03-reserve-503",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(503, "PGRST001", "connection pool exhausted"),
    expect: S503,
  },
  { id: "R04-reserve-504", upstream: "reserve", auth: "warm", fault: HTML(504), expect: S503 },
  {
    id: "R05-reserve-429",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(429, "PGRST429", "too many requests"),
    expect: S503,
  },
  {
    id: "R06-reserve-404-function-missing",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(404, "PGRST202", "Could not find the function"),
    expect: S503,
  },
  {
    id: "R07-reserve-401-jwt-expired",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(401, "PGRST301", "JWT expired"),
    expect: S503,
  },
  {
    id: "R08-reserve-403-permission",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(403, "42501", "permission denied"),
    expect: S503,
  },
  {
    id: "R09-reserve-400-bad-input",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(400, "22P02", "invalid input syntax"),
    expect: S503,
  },
  {
    id: "R10-reserve-500-statement-timeout",
    upstream: "reserve",
    auth: "warm",
    fault: PGRST(500, "57014", "canceling statement due to statement timeout"),
    expect: S503,
  },
  {
    id: "R11-reserve-socket",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "throw" },
    times: Infinity,
    expect: S503,
  },
  {
    id: "R12-reserve-hang",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "hang" },
    times: Infinity,
    expect: { status: "pending" },
    note: "no deadline on PostgREST calls",
  },
  {
    id: "R13-reserve-slow-300ms",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "delay", ms: 300 },
    expect: { status: 200 },
  },
  {
    id: "R14-reserve-200-empty-array",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [] },
    expect: S503,
  },
  {
    id: "R15-reserve-200-null",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: null },
    expect: S503,
  },
  {
    id: "R16-reserve-200-object-not-array",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: {} },
    expect: S503,
  },
  {
    id: "R17-reserve-200-accepted-no-permit-id",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [acceptedRow({ permit_id: null })] },
    expect: S503,
  },
  {
    id: "R18-reserve-200-unknown-result",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [{ result: "something.new" }] },
    expect: S503,
  },
  {
    id: "R19-reserve-200-auth-required",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [{ result: "auth.required" }] },
    expect: S503,
  },
  {
    id: "R20-reserve-200-non-json",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "text", status: 200, text: "not json", contentType: "application/json" },
    expect: S503,
  },
  {
    id: "R21-reserve-200-created-at-garbage",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [acceptedRow({ permit_created_at: "yesterday" })] },
    expect: S503,
    note: "malformed timestamp in an accepted row",
  },
  {
    id: "R22-reserve-200-created-at-null",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [acceptedRow({ permit_created_at: null })] },
    expect: S503,
  },
  {
    id: "R23-reserve-200-paywall-row",
    upstream: "reserve",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [{ result: "access.paywall_required" }] },
    expect: { status: 402, code: "access.paywall_required" },
  },
  {
    id: "R24-reserve-200-two-rows",
    upstream: "reserve",
    auth: "warm",
    fault: {
      kind: "status",
      status: 200,
      body: [acceptedRow(), acceptedRow({ permit_id: "22222222-2222-4222-8222-222222222222" })],
    },
    expect: { status: 200 },
  },
  // ── PostgREST rpc/access_state — AFTER the permit row was written ──────────
  {
    id: "A01-access-500",
    upstream: "access",
    auth: "warm",
    fault: PGRST(500, "XX000", "internal error"),
    expect: S503,
    note: "permit already reserved; replay must return the same permit",
  },
  {
    id: "A02-access-socket",
    upstream: "access",
    auth: "warm",
    fault: { kind: "throw" },
    times: Infinity,
    expect: S503,
  },
  {
    id: "A03-access-hang",
    upstream: "access",
    auth: "warm",
    fault: { kind: "hang" },
    times: Infinity,
    expect: { status: "pending" },
  },
  {
    id: "A04-access-200-empty-array",
    upstream: "access",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [] },
    expect: S503,
  },
  {
    id: "A05-access-200-null",
    upstream: "access",
    auth: "warm",
    fault: { kind: "status", status: 200, body: null },
    expect: S503,
  },
  {
    id: "A06-access-200-empty-row",
    upstream: "access",
    auth: "warm",
    fault: { kind: "status", status: 200, body: [{}] },
    expect: { status: 200 },
    note: "lenient: counters default to 0",
  },
  {
    id: "A07-access-200-non-json",
    upstream: "access",
    auth: "warm",
    fault: { kind: "text", status: 200, text: "<partial", contentType: "application/json" },
    expect: S503,
  },
  {
    id: "A08-access-404",
    upstream: "access",
    auth: "warm",
    fault: PGRST(404, "PGRST202", "Could not find the function"),
    expect: S503,
  },
  {
    id: "A09-access-503",
    upstream: "access",
    auth: "warm",
    fault: PGRST(503, "PGRST001", "pool exhausted"),
    expect: S503,
  },
  {
    id: "A10-access-slow-200ms",
    upstream: "access",
    auth: "warm",
    fault: { kind: "delay", ms: 200 },
    expect: { status: 200 },
  },
  // ── RevenueCat — must never be on this route's path ───────────────────────
  {
    id: "V01-revenuecat-500-sticky",
    upstream: "revenuecat",
    auth: "warm",
    fault: GOTRUE(500),
    times: Infinity,
    expect: { status: 200 },
  },
  {
    id: "V02-revenuecat-hang-sticky",
    upstream: "revenuecat",
    auth: "warm",
    fault: { kind: "hang" },
    times: Infinity,
    expect: { status: 200 },
  },
  // ── Request shape (client-side faults) ────────────────────────────────────
  {
    id: "Q01-body-malformed-json",
    upstream: "request",
    auth: "warm",
    request: { rawBody: "{ not json" },
    expect: S400,
    recovers: false,
  },
  {
    id: "Q02-body-array",
    upstream: "request",
    auth: "warm",
    request: { body: ["k"] },
    expect: S400,
    recovers: false,
  },
  {
    id: "Q03-key-129-chars",
    upstream: "request",
    auth: "warm",
    request: { body: { idempotencyKey: "k".repeat(129) } },
    expect: S400,
    recovers: false,
  },
  {
    id: "Q04-key-whitespace",
    upstream: "request",
    auth: "warm",
    request: { body: { idempotencyKey: "   " } },
    expect: S400,
    recovers: false,
  },
  {
    id: "Q05-key-number",
    upstream: "request",
    auth: "warm",
    request: { body: { idempotencyKey: 42 } },
    expect: S400,
    recovers: false,
  },
  {
    id: "Q06-body-empty",
    upstream: "request",
    auth: "warm",
    request: { rawBody: "" },
    expect: S400,
    recovers: false,
  },
  {
    id: "Q07-content-length-oversized",
    upstream: "request",
    auth: "warm",
    request: { headers: { "content-length": "5000001" } },
    expect: { status: 413 },
    recovers: false,
  },
  {
    id: "Q08-no-bearer",
    upstream: "request",
    auth: "warm",
    request: { token: null },
    expect: S401,
    recovers: false,
  },
  {
    id: "Q09-expired-session-bearer",
    upstream: "request",
    auth: "cold",
    request: { token: "expired" },
    expect: S401,
    recovers: false,
    note: "refused before any upstream call",
  },
  {
    id: "Q10-garbage-bearer",
    upstream: "request",
    auth: "cold",
    request: { token: "garbage" },
    expect: S401,
    recovers: false,
  },
  {
    id: "Q11-key-128-chars",
    upstream: "request",
    auth: "warm",
    request: { body: { idempotencyKey: "k".repeat(128) } },
    expect: { status: 200 },
  },
  {
    id: "Q12-body-non-json-content-type",
    upstream: "request",
    auth: "warm",
    request: { headers: { "content-type": "text/plain" } },
    expect: { status: 200 },
    note: "readBody ignores Content-Type",
  },
];

interface CaseOutcome {
  id: string;
  seed: number;
  userId: string;
  fault: Klass;
  observed: Omit<Partial<Observed>, "status"> & { status: number | "pending"; lateStatus?: number };
  recovered: Partial<Observed> | null;
  upstreamCalls: Record<string, number>;
  permitsAfter: number;
  samePermitOnReplay: boolean | null;
  verdict: "HELD" | "BROKEN";
  detail?: string;
}

function klassMatches(expect: Klass, observed: Observed): string | null {
  if (expect.status === "pending") return "expected pending but the handler answered";
  if (observed.status !== expect.status) return `status ${observed.status} != ${expect.status}`;
  if ("code" in expect && expect.code && observed.code !== expect.code)
    return `code ${observed.code} != ${expect.code}`;
  if (expect.status === 503 && expect.retryAfter && !observed.retryAfter)
    return "503 without Retry-After";
  if (observed.status >= 500 && observed.text.includes(UPSTREAM_DETAIL_MARKER))
    return "5xx body leaked upstream detail";
  if (observed.status >= 500 && observed.code !== null) return "5xx carried an error.code";
  return null;
}

function seedUser(
  h: StressHarness,
  prng: Prng,
  options: { premium?: boolean; scored?: number } = {},
) {
  const userId = prng.uuid();
  h.upstream.addUser({
    id: userId,
    premium: options.premium ?? false,
    scored: options.scored ?? 0,
  });
  return userId;
}

/** Warm the auth cache with one successful reservation (spends 1 free rating). */
async function warmAuth(h: StressHarness, token: string, key: string): Promise<Observed> {
  const warm = await observe(h.handler, h.permitRequest({ token, body: { idempotencyKey: key } }));
  assertEquals(warm.status, 200, `warm-up must succeed: ${warm.text}`);
  return warm;
}

function bearerFor(h: StressHarness, c: FaultCase, userId: string): string | null {
  if (c.request && c.request.token === null) return null;
  if (c.request?.token === "expired") return h.upstream.mintSession(userId, -60);
  if (c.request?.token === "garbage") return "not.a.jwt";
  if (c.auth === "provider") return h.upstream.providerIdToken(userId);
  return h.upstream.mintSession(userId);
}

async function runCase(h: StressHarness, c: FaultCase, seed: number): Promise<CaseOutcome> {
  const prng = new Prng(seed);
  const userId = seedUser(h, prng);
  const token = bearerFor(h, c, userId);
  const key = `stress-${c.id}-${prng.hex(8)}`;
  if (c.auth === "warm" && token) await warmAuth(h, token, `warm-${prng.hex(8)}`);
  const permitsBefore = h.upstream.permitsOf(userId).length;
  const callsBefore = h.upstream.calls.length;

  if (c.fault) h.upstream.inject(c.upstream as Upstream, c.fault, c.times ?? 1);
  const request = h.permitRequest({
    token,
    body:
      c.request?.rawBody !== undefined ? undefined : (c.request?.body ?? { idempotencyKey: key }),
    rawBody: c.request?.rawBody,
    headers: c.request?.headers,
  });

  let observed: Observed | { status: "pending"; latencyMs: number };
  const t0 = performance.now();
  const inFlight = h.handler(request);
  const raced = await raceHandler(inFlight, c.expect.status === "pending" ? HANG_PROBE_MS : 30_000);
  if (raced.pending) {
    observed = { status: "pending", latencyMs: performance.now() - t0 };
  } else {
    const text = await raced.response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const err =
      body && typeof body === "object" && "error" in body
        ? (body as { error: Record<string, unknown> }).error
        : null;
    const permit =
      body && typeof body === "object" && "permit" in body
        ? (body as { permit: Record<string, unknown> }).permit
        : null;
    observed = {
      status: raced.response.status,
      code: err && typeof err.code === "string" ? err.code : null,
      message: err && typeof err.message === "string" ? err.message : null,
      retryAfter: raced.response.headers.get("Retry-After"),
      permitId: permit && typeof permit.id === "string" ? permit.id : null,
      body,
      text,
      latencyMs: performance.now() - t0,
    };
  }
  const upstreamCalls: Record<string, number> = {};
  for (const call of h.upstream.calls.slice(callsBefore)) {
    upstreamCalls[call.upstream] = (upstreamCalls[call.upstream] ?? 0) + 1;
  }

  let detail: string | null = null;
  if (observed.status === "pending") {
    if (c.expect.status !== "pending") detail = `handler still pending after ${HANG_PROBE_MS}ms`;
  } else {
    detail = klassMatches(c.expect, observed);
  }
  if (c.upstream === "revenuecat" && (upstreamCalls.revenuecat ?? 0) > 0)
    detail = "route called RevenueCat";
  if (c.id === "Q09-expired-session-bearer" && (upstreamCalls.gotrue ?? 0) > 0)
    detail = "expired bearer reached GoTrue";

  // Recoverability: clear the fault (release hangs), replay the SAME request.
  h.upstream.clearFaults();
  const released = h.upstream.releaseHangs();
  let recovered: Observed | null = null;
  let samePermitOnReplay: boolean | null = null;
  let lateStatus: number | null = null;
  if (raced.pending) {
    // The hung call now completes; the original request must finish with the
    // right answer once upstream answers (nothing is lost, nothing doubled).
    const late = await inFlight;
    lateStatus = late.status;
    await late.body?.cancel();
    if (lateStatus !== 200) detail ??= `released hang answered ${lateStatus}`;
  }
  if (c.recovers !== false && token) {
    recovered = await observe(
      h.handler,
      h.permitRequest({
        token,
        body: c.request?.body ?? { idempotencyKey: key },
        headers: c.request?.headers,
      }),
    );
    if (recovered.status !== 200)
      detail ??= `no recovery: replay answered ${recovered.status} ${recovered.text}`;
    const rows = h.upstream.permitsOf(userId).filter((p) => p.idempotency_key === key);
    if (rows.length > 1) detail ??= `idempotency key has ${rows.length} rows`;
    if (c.upstream === "access" && rows.length === 1) {
      samePermitOnReplay = recovered.permitId === rows[0].id;
      if (!samePermitOnReplay)
        detail ??= "replay returned a different permit than the one reserved before the fault";
    }
  }
  const permitsAfter = h.upstream.permitsOf(userId).length;
  const spent = permitsAfter - permitsBefore;
  if (spent > 1) detail ??= `one request+replay reserved ${spent} permits (double spend)`;
  if (released > 0 && h.upstream.pendingHangs > 0) detail ??= "hung upstream calls still pending";

  return {
    id: c.id,
    seed,
    userId,
    fault: c.expect,
    observed:
      observed.status === "pending"
        ? {
            status: "pending" as const,
            latencyMs: observed.latencyMs,
            ...(lateStatus !== null ? { lateStatus } : {}),
          }
        : {
            status: observed.status,
            code: observed.code,
            message: observed.message,
            retryAfter: observed.retryAfter,
            permitId: observed.permitId,
            latencyMs: Math.round(observed.latencyMs * 100) / 100,
          },
    recovered: recovered
      ? { status: recovered.status, code: recovered.code, permitId: recovered.permitId }
      : null,
    upstreamCalls,
    permitsAfter,
    samePermitOnReplay,
    verdict: detail ? "BROKEN" : "HELD",
    ...(detail ? { detail } : {}),
  };
}

// ─── 1. Fault matrix ─────────────────────────────────────────────────────────

Deno.test(
  "stress/permits fault matrix: every upstream fault maps to its user-visible class and recovers",
  async () => {
    const h = await loadStressHarness({ seed: STRESS_SEED });
    assert(FAULT_CASES.length >= 40, `matrix has ${FAULT_CASES.length} cases (< 40)`);
    const ids = new Set(FAULT_CASES.map((c) => c.id));
    assertEquals(ids.size, FAULT_CASES.length, "case ids are unique");

    const outcomes: CaseOutcome[] = [];
    for (const c of FAULT_CASES) {
      const seed = deriveSeed(STRESS_SEED, c.id);
      outcomes.push(await runCase(h, c, seed));
      h.upstream.clearFaults();
      h.upstream.releaseHangs();
    }
    const broken = outcomes.filter((o) => o.verdict === "BROKEN");
    const table = outcomes.map(
      (o) =>
        `${o.verdict.padEnd(6)} ${o.id.padEnd(40)} expect=${JSON.stringify(o.fault)} observed=${o.observed.status}${o.observed.status !== "pending" && "code" in o.observed && o.observed.code ? `/${o.observed.code}` : ""} ra=${o.observed.status !== "pending" && "retryAfter" in o.observed ? o.observed.retryAfter : "-"} calls=${JSON.stringify(o.upstreamCalls)} replay=${o.recovered?.status ?? "-"}${o.detail ? `  ← ${o.detail}` : ""}`,
    );
    console.log(
      `[stress] fault matrix (${outcomes.length} cases, seed ${STRESS_SEED}):\n  ${table.join("\n  ")}`,
    );
    await writeReport("permits_fault_matrix", {
      seed: STRESS_SEED,
      cases: outcomes.length,
      held: outcomes.length - broken.length,
      broken: broken.map((o) => o.id),
      replay: `STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json stress_permits_failure_load.test.ts --filter "fault matrix"`,
      outcomes,
    });
    // Documented deviations (findings) are asserted individually below so the
    // matrix stays green while still pinning today's exact behaviour.
    const KNOWN: Record<string, (o: CaseOutcome) => boolean> = {
      // Transitional provider-token bearer: supabase-js folds every
      // signInWithIdToken failure into `error`, and the route answers 401.
      "P01-idtoken-grant-500": (o) => o.observed.status === 401 && o.recovered?.status === 200,
      "P02-idtoken-grant-socket": (o) => o.observed.status === 401 && o.recovered?.status === 200,
      "P03-idtoken-grant-200-malformed": (o) =>
        o.observed.status === 401 && o.recovered?.status === 200,
      // An accepted row whose created_at does not parse throws inside
      // permitView (RangeError) → generic 500 instead of 503.
      "R21-reserve-200-created-at-garbage": (o) =>
        o.observed.status === 500 && o.recovered?.status === 200,
      "R22-reserve-200-created-at-null": (o) =>
        o.observed.status === 500 && o.recovered?.status === 200,
    };
    const unexpected = broken.filter((o) => !(KNOWN[o.id]?.(o) ?? false));
    assertEquals(
      unexpected.map((o) => `${o.id}: ${o.detail}`),
      [],
      "every fault case outside the documented findings HELD",
    );
    for (const [id, check] of Object.entries(KNOWN)) {
      const o = outcomes.find((x) => x.id === id)!;
      assert(
        check(o),
        `documented finding ${id} reproduces exactly as recorded: ${JSON.stringify(o.observed)}`,
      );
    }
  },
);

// ─── 2. Randomized fault campaign ────────────────────────────────────────────

interface PreState {
  premium: boolean;
  scored: number;
  priorReserved: number;
  auth: "warm" | "cold";
}

/** What the route should answer for `c` given the user's pre-state. */
function oracle(c: FaultCase, pre: PreState): Klass {
  const available = pre.premium || 2 - Math.min(2, pre.scored) - pre.priorReserved > 0;
  const noFault: Klass = available
    ? { status: 200 }
    : { status: 402, code: "access.paywall_required" };
  if (c.upstream === "gotrue" && c.auth === "cold" && pre.auth === "warm") return noFault; // cache hit: GoTrue never asked
  if (c.upstream === "access" && !available) return noFault; // paywall before access_state
  if (c.upstream === "revenuecat") return noFault;
  if (c.expect.status === 200) return noFault; // the fault is survivable: outcome is the allowance's
  return c.expect;
}

Deno.test(
  "stress/permits randomized fault campaign: seeded fault × pre-state matches the oracle",
  async () => {
    const h = await loadStressHarness({ seed: STRESS_SEED });
    const campaign = new Prng(deriveSeed(STRESS_SEED, "fault-campaign"));
    // Excluded: provider bearers / bad bearers / hangs / documented deviations
    // (P*, R21, R22 — pinned in the matrix) and R24, whose injected accepted
    // rows carry synthetic permit ids the replay cannot match.
    const eligible = FAULT_CASES.filter(
      (c) =>
        c.auth !== "provider" &&
        !c.request?.token &&
        c.expect.status !== "pending" &&
        c.expect.status !== 413 &&
        c.recovers !== false &&
        !/^(R21|R22|R24)-/.test(c.id),
    );
    const rows: Array<Record<string, unknown>> = [];
    let held = 0;
    for (let i = 0; i < STRESS_FAULT_ITER; i++) {
      const seed = campaign.int(2 ** 31);
      const prng = new Prng(seed);
      const c = prng.pick(eligible);
      const pre: PreState = {
        premium: prng.chance(0.25),
        scored: prng.int(3),
        priorReserved: prng.int(2),
        auth: c.upstream === "gotrue" ? prng.pick(["warm", "cold"] as const) : "warm",
      };
      const userId = seedUser(h, prng, { premium: pre.premium, scored: pre.scored });
      const token = h.upstream.mintSession(userId);
      // Pre-state: prior reservations exist only when the allowance permits them.
      let priorReserved = 0;
      if (pre.auth === "warm" || pre.priorReserved > 0) {
        const warm = await observe(
          h.handler,
          h.permitRequest({ token, body: { idempotencyKey: `pre-${prng.hex(8)}` } }),
        );
        if (warm.status === 200) priorReserved = 1;
        else if (warm.status !== 402)
          throw new Error(`pre-state request failed: ${warm.status} ${warm.text}`);
      }
      // Cold auth: a second session of the same user (different token → different
      // cache key → GoTrue is consulted), warm: the bearer the pre-state request cached.
      const bearer = pre.auth === "cold" ? h.upstream.mintSession(userId) : token;
      const effectivePre: PreState = { ...pre, priorReserved };
      const expect = oracle(c, effectivePre);
      const key = `camp-${prng.hex(10)}`;
      if (c.fault) h.upstream.inject(c.upstream as Upstream, c.fault, c.times ?? 1);
      const permitsBefore = h.upstream.permitsOf(userId).length;
      const observed = await observe(
        h.handler,
        h.permitRequest({
          token: bearer,
          body: c.request?.body ?? { idempotencyKey: key },
          rawBody: c.request?.rawBody,
          headers: c.request?.headers,
        }),
      );
      h.upstream.clearFaults();
      h.upstream.releaseHangs();
      let detail = klassMatches(expect, observed);
      // Recovery replay (same key) — allowed outcome: 200, or 402 when the allowance is gone.
      const replay = await observe(
        h.handler,
        h.permitRequest({
          token: bearer,
          body: c.request?.body ?? { idempotencyKey: key },
          headers: c.request?.headers,
        }),
      );
      const available =
        effectivePre.premium ||
        2 - Math.min(2, effectivePre.scored) - effectivePre.priorReserved > 0;
      const replayOk =
        c.expect.status === 400
          ? replay.status === 400
          : available
            ? replay.status === 200
            : replay.status === 402;
      if (!replayOk) detail ??= `replay answered ${replay.status} (available=${available})`;
      const spent = h.upstream.permitsOf(userId).length - permitsBefore;
      if (spent > 1) detail ??= `double spend: ${spent} permits for one key`;
      if (
        !effectivePre.premium &&
        h.upstream.permitsOf(userId).length > 2 - Math.min(2, effectivePre.scored)
      )
        detail ??= "free allowance exceeded";
      if (observed.status === 200 && replay.status === 200 && observed.permitId !== replay.permitId)
        detail ??= "same key, two permit ids";
      if (!detail) held += 1;
      rows.push({
        i,
        seed,
        case: c.id,
        pre: effectivePre,
        expect,
        observed: { status: observed.status, code: observed.code, retryAfter: observed.retryAfter },
        replay: { status: replay.status, permitId: replay.permitId },
        verdict: detail ? "BROKEN" : "HELD",
        ...(detail ? { detail } : {}),
      });
    }
    const broken = rows.filter((r) => r.verdict === "BROKEN");
    console.log(
      `[stress] randomized fault campaign: ${held}/${rows.length} HELD (seed ${STRESS_SEED}); broken seeds: ${broken.map((r) => r.seed).join(",") || "none"}`,
    );
    await writeReport("permits_fault_campaign", {
      seed: STRESS_SEED,
      iterations: rows.length,
      held,
      broken: broken.length,
      rows,
    });
    assertEquals(
      broken.map((r) => `${r.seed}/${r.case}: ${r.detail}`),
      [],
      "every randomized fault iteration HELD",
    );
  },
);

// ─── 3. Load: latency + round trips per request ──────────────────────────────

Deno.test(
  "stress/permits load: p50/p95 latency and Supabase round trips per request (hot path <= 3)",
  async () => {
    const h = await loadStressHarness({ seed: STRESS_SEED });
    const prng = new Prng(deriveSeed(STRESS_SEED, "load"));
    // Pool sized so no user exceeds the 30/min route budget (warm-up + ≤ 25 hits).
    const POOL = Math.max(50, Math.ceil(STRESS_ITER / 25));
    const users = Array.from({ length: POOL }, () => {
      const id = prng.uuid();
      h.upstream.addUser({ id, premium: true }); // premium: never paywalled, so every request reaches access_state
      return { id, token: h.upstream.mintSession(id), ip: h.freshIp() };
    });
    // Warm every bearer (one GoTrue verification each).
    for (const u of users) {
      const warm = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `warm-${prng.hex(8)}` },
        }),
      );
      assertEquals(warm.status, 200, warm.text);
    }
    const latencies: number[] = [];
    const perRequest: Array<{
      i: number;
      user: number;
      status: number;
      ms: number;
      supabase: number;
      gotrue: number;
      rest: number;
      other: number;
    }> = [];
    let maxRoundTrips = 0;
    const statuses: Record<number, number> = {};
    for (let i = 0; i < STRESS_ITER; i++) {
      // Round-robin so the 30/min per-user permit budget is never the thing measured.
      const u = i % POOL;
      const user = users[u];
      const before = h.upstream.calls.length;
      const o = await observe(
        h.handler,
        h.permitRequest({
          token: user.token,
          ip: user.ip,
          body: { idempotencyKey: `load-${i}-${prng.hex(6)}` },
        }),
      );
      const calls = h.upstream.calls.slice(before);
      const gotrue = calls.filter((c) => c.upstream === "gotrue").length;
      const rest = calls.filter(
        (c) => c.upstream === "reserve" || c.upstream === "access" || c.upstream === "rest_other",
      ).length;
      const other = calls.length - gotrue - rest;
      const supabase = gotrue + rest;
      maxRoundTrips = Math.max(maxRoundTrips, supabase);
      statuses[o.status] = (statuses[o.status] ?? 0) + 1;
      latencies.push(o.latencyMs);
      perRequest.push({
        i,
        user: u,
        status: o.status,
        ms: Math.round(o.latencyMs * 1000) / 1000,
        supabase,
        gotrue,
        rest,
        other,
      });
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const summary = {
      seed: STRESS_SEED,
      requests: STRESS_ITER,
      pool: POOL,
      statuses,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted[sorted.length - 1],
      meanMs: latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length),
      supabaseRoundTripsPerRequest: {
        max: maxRoundTrips,
        histogram: perRequest.reduce<Record<number, number>>(
          (acc, r) => ((acc[r.supabase] = (acc[r.supabase] ?? 0) + 1), acc),
          {},
        ),
      },
      heap: heapSnapshot(),
    };
    console.log(`[stress] load: ${JSON.stringify(summary)}`);
    await writeReport("permits_load", { ...summary, perRequest });
    // 429s would mean the per-user permit budget (30/min) was hit — the pool is sized to avoid it.
    assertEquals(
      Object.keys(statuses),
      ["200"],
      `every load request answered 200: ${JSON.stringify(statuses)}`,
    );
    assert(maxRoundTrips <= 3, `hot path did ${maxRoundTrips} Supabase round trips (> 3)`);
    assertEquals(
      summary.supabaseRoundTripsPerRequest.histogram,
      { 2: STRESS_ITER },
      "warm requests do exactly 2 Supabase round trips (reserve RPC + access_state RPC), 0 GoTrue",
    );
  },
);

Deno.test(
  "stress/permits load: concurrent burst — same key collapses to one permit; free limit holds under N parallel keys",
  async () => {
    const h = await loadStressHarness({ seed: STRESS_SEED });
    const prng = new Prng(deriveSeed(STRESS_SEED, "burst"));
    h.upstream.modelLatencyMs = 5; // make the RPCs genuinely asynchronous so requests interleave
    try {
      // (a) same idempotency key, 30 parallel requests (the per-user permit budget is 30/min).
      const a = prng.uuid();
      h.upstream.addUser({ id: a, premium: false });
      const tokenA = h.upstream.mintSession(a);
      const ipA = h.freshIp();
      const key = `burst-same-${prng.hex(8)}`;
      const sameKey = await Promise.all(
        Array.from({ length: 30 }, () =>
          observe(
            h.handler,
            h.permitRequest({ token: tokenA, ip: ipA, body: { idempotencyKey: key } }),
          ),
        ),
      );
      const ids = new Set(sameKey.map((o) => o.permitId));
      assertEquals(
        sameKey.map((o) => o.status),
        Array(30).fill(200),
      );
      assertEquals(ids.size, 1, `30 concurrent same-key requests → ${ids.size} permit ids`);
      assertEquals(h.upstream.permitsOf(a).length, 1);
      // (b) 30 parallel DIFFERENT keys for a fresh free user → exactly 2 accepted, rest 402.
      const b = prng.uuid();
      h.upstream.addUser({ id: b, premium: false });
      const tokenB = h.upstream.mintSession(b);
      const ipB = h.freshIp();
      const diffKeys = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          observe(
            h.handler,
            h.permitRequest({
              token: tokenB,
              ip: ipB,
              body: { idempotencyKey: `burst-diff-${i}-${prng.hex(6)}` },
            }),
          ),
        ),
      );
      const accepted = diffKeys.filter((o) => o.status === 200).length;
      const paywalled = diffKeys.filter(
        (o) => o.status === 402 && o.code === "access.paywall_required",
      ).length;
      const sorted = diffKeys.map((o) => o.latencyMs).sort((x, y) => x - y);
      console.log(
        `[stress] burst: same-key ids=${ids.size}; diff-key accepted=${accepted} paywalled=${paywalled} p50=${percentile(sorted, 50).toFixed(1)}ms p95=${percentile(sorted, 95).toFixed(1)}ms`,
      );
      assertEquals(accepted, 2, "exactly two free ratings reserved under 30 parallel keys");
      assertEquals(paywalled, 28);
      assertEquals(h.upstream.permitsOf(b).length, 2);
      await writeReport("permits_burst", {
        seed: STRESS_SEED,
        sameKeyIds: ids.size,
        accepted,
        paywalled,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
      });
    } finally {
      h.upstream.modelLatencyMs = 0;
    }
  },
);

// ─── 4. L1 memory under distinct users ───────────────────────────────────────

Deno.test(
  "stress/permits L1 memory: STRESS_USERS distinct users — heap bounded, auth cache capped (first user evicted)",
  async () => {
    const h = await loadStressHarness({ seed: STRESS_SEED });
    const prng = new Prng(deriveSeed(STRESS_SEED, "memory"));
    const first = prng.uuid();
    h.upstream.addUser({ id: first, premium: true });
    const firstToken = h.upstream.mintSession(first);
    const firstIp = h.freshIp();
    const r0 = await observe(
      h.handler,
      h.permitRequest({
        token: firstToken,
        ip: firstIp,
        body: { idempotencyKey: `mem-first-${prng.hex(6)}` },
      }),
    );
    assertEquals(r0.status, 200);
    const gotrueBefore = h.upstream.callsTo("gotrue").length;
    // Cached: a second request from the first user must not consult GoTrue.
    const r1 = await observe(
      h.handler,
      h.permitRequest({
        token: firstToken,
        ip: firstIp,
        body: { idempotencyKey: `mem-first2-${prng.hex(6)}` },
      }),
    );
    assertEquals(r1.status, 200);
    assertEquals(
      h.upstream.callsTo("gotrue").length,
      gotrueBefore,
      "first user's verification is cached",
    );

    // With `--v8-flags=--expose-gc` the function's OWN retained memory is
    // isolated: harness tables are dropped and a full GC forced before each
    // reading, so growth = auth L1 (≤ 5 000 rows) + rate-limit windows (≤ 20 000).
    const gc = (globalThis as { gc?: () => void }).gc;
    const settle = () => {
      if (!gc) return null;
      gc();
      gc();
      return heapSnapshot();
    };
    const heapStartGc = settle();
    const heapStart = heapSnapshot();
    const statuses: Record<number, number> = {};
    const t0 = performance.now();
    const sample: number[] = [];
    for (let i = 0; i < STRESS_USERS; i++) {
      const id = prng.uuid();
      h.upstream.addUser({ id, premium: i % 2 === 0 });
      const token = h.upstream.mintSession(id);
      const o = await observe(
        h.handler,
        h.permitRequest({ token, body: { idempotencyKey: `mem-${i}` } }),
      );
      statuses[o.status] = (statuses[o.status] ?? 0) + 1;
      if (i % 1000 === 0) sample.push(heapSnapshot().heapUsedMb);
      // Keep the harness's own bookkeeping from dominating the heap measurement.
      if (h.upstream.calls.length > 50_000) h.upstream.calls = [];
    }
    const elapsedMs = performance.now() - t0;
    const heapEnd = heapSnapshot();
    // Drop everything the harness itself retained for the 20k users (except
    // the first user's session, still needed below) and measure what is left:
    // the function's L1 caches and local rate-limit windows.
    const firstSession = h.upstream.sessions.get(firstToken);
    const firstUser = h.upstream.users.get(first);
    h.upstream.calls = [];
    h.upstream.permits = [];
    h.upstream.users.clear();
    h.upstream.sessions.clear();
    if (firstUser) h.upstream.users.set(first, firstUser);
    if (firstSession) h.upstream.sessions.set(firstToken, firstSession);
    const heapEndGc = settle();
    // Cache capped at 5 000 entries (cache.ts MEMORY_MAX_ENTRIES): after
    // > 5 000 fresh bearers the first user's row has been evicted, so its
    // next request consults GoTrue again.
    const gotrueMid = h.upstream.callsTo("gotrue").length;
    const r2 = await observe(
      h.handler,
      h.permitRequest({
        token: firstToken,
        ip: firstIp,
        body: { idempotencyKey: `mem-first3-${prng.hex(6)}` },
      }),
    );
    assertEquals(r2.status, 200);
    const evicted = h.upstream.callsTo("gotrue").length > gotrueMid;
    const report = {
      seed: STRESS_SEED,
      users: STRESS_USERS,
      statuses,
      elapsedMs: Math.round(elapsedMs),
      perRequestMs: Math.round((elapsedMs / Math.max(1, STRESS_USERS)) * 1000) / 1000,
      heapStart,
      heapEnd,
      heapGrowthMb: Math.round((heapEnd.heapUsedMb - heapStart.heapUsedMb) * 10) / 10,
      heapSamplesMb: sample,
      gcExposed: Boolean(gc),
      heapStartGc,
      heapEndGc,
      /** Function-attributable retained growth (null without --expose-gc). */
      retainedGrowthMb:
        heapStartGc && heapEndGc
          ? Math.round((heapEndGc.heapUsedMb - heapStartGc.heapUsedMb) * 10) / 10
          : null,
      firstUserEvictedFromL1: evicted,
    };
    console.log(`[stress] memory: ${JSON.stringify(report)}`);
    await writeReport("permits_memory", report);
    assertEquals(Object.keys(statuses), ["200"], JSON.stringify(statuses));
    if (STRESS_USERS > 5_000)
      assert(
        evicted,
        "L1 auth cache is capped: the first user's row was evicted after > 5000 users",
      );
    else assertFalse(evicted, "under the cap the first user's row survives");
    // Model tables (permits/users/sessions) grow linearly by design; the
    // function's own maps are capped, so total growth stays modest.
    assert(
      report.heapGrowthMb < 400,
      `heap grew ${report.heapGrowthMb} MB across ${STRESS_USERS} users`,
    );
    if (report.retainedGrowthMb !== null) {
      // 5 000 auth rows (~1 KB each) + 20 000 window counters: tens of MB at most.
      assert(
        report.retainedGrowthMb < 64,
        `function retained ${report.retainedGrowthMb} MB after ${STRESS_USERS} users (L1 caps not holding?)`,
      );
    }
  },
);

// A single, explicit pin of the two documented findings' exact behaviour so a
// fix flips this test rather than silently changing the matrix.
Deno.test(
  "stress/permits documented findings pinned: PostgREST hang has no deadline; created_at garbage → 500",
  async () => {
    const h = await loadStressHarness({ seed: STRESS_SEED });
    const prng = new Prng(deriveSeed(STRESS_SEED, "pins"));
    const id = prng.uuid();
    h.upstream.addUser({ id, premium: true });
    const token = h.upstream.mintSession(id);
    await warmAuth(h, token, `pin-warm-${prng.hex(6)}`);

    h.upstream.inject("reserve", { kind: "hang" }, Infinity);
    const t0 = performance.now();
    const pending = h.handler(
      h.permitRequest({ token, body: { idempotencyKey: `pin-hang-${prng.hex(6)}` } }),
    );
    const raced = await raceHandler(pending, HANG_PROBE_MS);
    assert(
      raced.pending,
      "reserve_analysis_permit RPC has no client-side deadline: still pending after 1.5 s",
    );
    h.upstream.clearFaults();
    h.upstream.releaseHangs();
    const late = await pending;
    const waited = performance.now() - t0;
    assertEquals(late.status, 200, "the hung request completes once PostgREST answers");
    await late.body?.cancel();
    console.log(
      `[stress] pin: reserve hang held the request ${waited.toFixed(0)}ms with no deadline (released manually)`,
    );

    h.upstream.inject("reserve", {
      kind: "status",
      status: 200,
      body: [acceptedRow({ permit_created_at: "garbage" })],
    });
    const garbage = await observe(
      h.handler,
      h.permitRequest({ token, body: { idempotencyKey: `pin-garbage-${prng.hex(6)}` } }),
    );
    assertEquals(garbage.status, 500);
    assertStringIncludes(garbage.text, "Something went wrong");
    assertFalse(garbage.text.includes("RangeError"), "500 body stays generic");
  },
);
