/**
 * stress · failure injection — POST /v1/analysis-permits/:id/finalize
 *
 * Every upstream the route can touch (Supabase Auth, PostgREST select /
 * conditional update / race re-read, the access_state RPC, Upstash Redis,
 * RevenueCat) is made to fail, hang, or answer malformed — one fault per
 * case, ~76 cases — through the REAL handler booted in-process
 * (stress_permit_finalize_harness.ts, Redis configured). For each case the
 * campaign asserts:
 *
 *   1. the user-visible class (status, error code, Retry-After) matches the
 *      contract in index.ts's header (401 sign-out / 4xx coded / generic
 *      retryable 5xx) — cases whose observed class is degraded are
 *      recorded with `flag` and reported as findings, never hidden;
 *   2. the permit row is never finalized with an outcome other than the one
 *      requested (no corruption, no double finalization);
 *   3. RECOVERABILITY: once the fault clears, the very same request (the
 *      client's retry) answers 200 and the permit is finalized as requested
 *      — including when the write had committed but its answer was lost.
 *
 * Seeded: every case derives its user / session / permit / outcome / IP from
 * STRESS_SEED ⊕ fnv1a(caseId). Replay one case:
 *
 *   STRESS_SEED=20260904 STRESS_ONLY=S01 deno test -A --no-check --config deno.json \
 *     stress_permit_finalize_faults.test.ts
 *
 * STRESS_REPEAT=10 re-runs the selected cases N times (flake-rate probe).
 * The JSON table (seed → fault → observed → recovered) is written to
 * STRESS_OUT_DIR (default artifacts/stress-permit-finalize/latest/).
 */
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  envInt,
  type FaultSpec,
  heapSnapshot,
  histogram,
  loadStressHarness,
  RELEASABLE_OUTCOMES,
  type SendResult,
  STRESS_SEED,
  type StressHarness,
  SUPABASE_URL,
  type UpstreamTarget,
  writeArtifact,
} from "./stress_permit_finalize_harness.ts";

type VisibleClass =
  | "ok_200"
  | "signed_out_401"
  | "validation_400"
  | "not_found_404"
  | "conflict_409"
  | "rate_limited_429"
  | "retryable_503"
  | "generic_500";

interface FaultCase {
  id: string;
  target: UpstreamTarget;
  title: string;
  faults: FaultSpec[];
  /** Deno.env overrides while the faulted request runs */
  env?: Record<string, string>;
  /** warm the auth cache (GET /v1/me/access) before the faulted request */
  warmAuth?: boolean;
  expect: {
    class: VisibleClass;
    code?: string | null;
    retryAfter?: string | "any" | null;
    /** permit row after the faulted request */
    permit: "reserved" | "finalized";
    /** GoTrue round trips during the faulted request (exact) */
    gotrue?: number;
    /** PostgREST round trips during the faulted request (exact) */
    postgrest?: number;
    minLatencyMs?: number;
  };
  /** Set when the observed class is a degraded-but-pinned behaviour: the
   * case still runs and its invariants + recoverability are asserted, and
   * the flag is carried into the JSON table for the findings report. */
  flag?: string;
  /** `immediate` (default): the client's retry right after the fault clears
   * answers 200. `l1_lockout`: the fault poisoned the per-isolate L1 for
   * L1_READTHROUGH_TTL_SECONDS (60s) — the retry is pinned as 401 and the
   * permit must be untouched. */
  recovery?: "immediate" | "l1_lockout";
}

const html502 =
  "<html><head><title>502 Bad Gateway</title></head><body>bad gateway</body></html>";
const AUTH_TIMEOUT = { AUTH_UPSTREAM_TIMEOUT_MS: "800" };

const http = (status: number, body: string, headers?: Record<string, string>) =>
  ({ kind: "http", status, body, headers }) as const;

/** Row the PATCH's representation would carry for `permit` (used to forge). */
const permitJson = (id: string, status: string, outcome: string | null) =>
  JSON.stringify([{
    id,
    status,
    outcome,
    created_at: "2026-09-04T00:00:00.000Z",
  }]);

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const auth = (
  id: string,
  title: string,
  answer: FaultSpec["answer"],
  expect: FaultCase["expect"],
  extra: Partial<FaultCase> = {},
): FaultCase => ({
  id,
  target: "auth",
  title,
  faults: [{ target: "auth", answer }],
  env: AUTH_TIMEOUT,
  expect,
  ...extra,
});

const select = (
  id: string,
  title: string,
  answer: FaultSpec["answer"],
  expect: FaultCase["expect"],
  extra: Partial<FaultCase> = {},
): FaultCase => ({
  id,
  target: "rest.select",
  title,
  faults: [{ target: "rest.select", answer }],
  expect,
  ...extra,
});

const update = (
  id: string,
  title: string,
  answer: FaultSpec["answer"],
  expect: FaultCase["expect"],
  extra: Partial<FaultCase> & { applyWrite?: boolean } = {},
): FaultCase => {
  const { applyWrite, ...rest } = extra;
  return {
    id,
    target: "rest.update",
    title,
    faults: [{ target: "rest.update", applyWrite, answer }],
    expect,
    ...rest,
  };
};

/** The update committed but its representation was empty, so the route
 * takes its race re-read — and THAT re-read is what the case faults. */
const reselect = (
  id: string,
  title: string,
  answer: FaultSpec["answer"],
  expect: FaultCase["expect"],
  extra: Partial<FaultCase> = {},
): FaultCase => ({
  id,
  target: "rest.select",
  title,
  faults: [
    { target: "rest.update", applyWrite: true, answer: http(200, "[]") },
    { target: "rest.select", minOccurrence: 2, answer },
  ],
  expect,
  ...extra,
});

const rpc = (
  id: string,
  title: string,
  answer: FaultSpec["answer"],
  expect: FaultCase["expect"],
  extra: Partial<FaultCase> = {},
): FaultCase => ({
  id,
  target: "rpc.access_state",
  title,
  faults: [{ target: "rpc.access_state", answer }],
  expect,
  ...extra,
});

const redis = (
  id: string,
  title: string,
  answer: FaultSpec["answer"],
  expect: FaultCase["expect"],
  extra: Partial<FaultCase> & { occurrence?: number } = {},
): FaultCase => {
  const { occurrence, ...rest } = extra;
  return {
    id,
    target: "redis",
    title,
    faults: [{ target: "redis", occurrence, answer }],
    expect,
    ...rest,
  };
};

const revenuecat = (
  id: string,
  title: string,
  answer: FaultSpec["answer"],
): FaultCase => ({
  id,
  target: "revenuecat",
  title,
  faults: [{ target: "revenuecat", answer }],
  expect: { class: "ok_200", permit: "finalized", gotrue: 1, postgrest: 3 },
});

const ok = (gotrue: number, postgrest: number): FaultCase["expect"] => ({
  class: "ok_200",
  permit: "finalized",
  gotrue,
  postgrest,
});
const unavailable = (
  permit: "reserved" | "finalized",
  extra: Partial<FaultCase["expect"]> = {},
): FaultCase["expect"] => ({
  class: "retryable_503",
  code: null,
  retryAfter: null,
  permit,
  ...extra,
});

export const FAULT_CASES: FaultCase[] = [
  // ── Supabase Auth (GoTrue GET /auth/v1/user) ───────────────────────────────
  auth("A01", "GoTrue connection refused on every attempt", {
    kind: "network_error",
  }, {
    ...unavailable("reserved", { retryAfter: "2", postgrest: 0 }),
  }),
  auth("A02", "GoTrue never answers (deadline 800ms)", {
    kind: "hang",
    ms: 30_000,
  }, {
    ...unavailable("reserved", {
      retryAfter: "2",
      gotrue: 1,
      postgrest: 0,
      minLatencyMs: 750,
    }),
  }),
  auth(
    "A03",
    "GoTrue HTTP 500",
    http(500, JSON.stringify({ code: 500, msg: "internal" })),
    {
      ...unavailable("reserved", { retryAfter: "2", gotrue: 1, postgrest: 0 }),
    },
  ),
  auth(
    "A04",
    "GoTrue HTTP 502 gateway HTML",
    http(502, html502, { "Content-Type": "text/html" }),
    {
      ...unavailable("reserved", { retryAfter: "2", gotrue: 1, postgrest: 0 }),
    },
  ),
  auth(
    "A05",
    "GoTrue HTTP 503 with Retry-After: 9 (hint passes through)",
    http(503, JSON.stringify({ code: 503, msg: "maintenance" }), {
      "Retry-After": "9",
    }),
    {
      ...unavailable("reserved", { retryAfter: "9", gotrue: 1, postgrest: 0 }),
    },
  ),
  auth(
    "A06",
    "GoTrue HTTP 429",
    http(429, JSON.stringify({ code: 429, msg: "over_request_rate_limit" })),
    {
      ...unavailable("reserved", { retryAfter: "2", gotrue: 1, postgrest: 0 }),
    },
  ),
  auth(
    "A07",
    "GoTrue HTTP 401 (bad_jwt) → sign-out class, never cached",
    http(
      401,
      JSON.stringify({ code: 401, msg: "invalid JWT", error_code: "bad_jwt" }),
    ),
    {
      class: "signed_out_401",
      code: null,
      permit: "reserved",
      gotrue: 1,
      postgrest: 0,
    },
  ),
  auth(
    "A08",
    "GoTrue HTTP 403 (user banned / session gone)",
    http(
      403,
      JSON.stringify({
        code: 403,
        msg: "forbidden",
        error_code: "user_banned",
      }),
    ),
    {
      class: "signed_out_401",
      code: null,
      permit: "reserved",
      gotrue: 1,
      postgrest: 0,
    },
  ),
  auth(
    "A09",
    "GoTrue 200 with truncated JSON",
    http(200, '{"id":"abc","email":'),
    {
      ...unavailable("reserved", { retryAfter: "2", gotrue: 1, postgrest: 0 }),
    },
  ),
  auth("A10", "GoTrue 200 with an empty object (no id)", http(200, "{}"), {
    ...unavailable("reserved", { retryAfter: "2", gotrue: 1, postgrest: 0 }),
  }),
  auth("A11", "GoTrue 200 with body null", http(200, "null"), {
    ...unavailable("reserved", { retryAfter: "2", gotrue: 1, postgrest: 0 }),
  }),
  auth(
    "A12",
    "GoTrue 200 for a user without a Google/Apple identity",
    http(
      200,
      JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        email: "e@example.com",
        app_metadata: { provider: "email", providers: ["email"] },
      }),
    ),
    {
      class: "signed_out_401",
      code: null,
      permit: "reserved",
      gotrue: 1,
      postgrest: 0,
    },
  ),
  auth("A13", "GoTrue answers 300ms late", { kind: "slow", ms: 300 }, {
    ...ok(1, 3),
    minLatencyMs: 300,
  }),
  {
    id: "A14",
    target: "auth",
    title:
      "GoTrue connection reset once, then healthy (in-deadline connect retry)",
    faults: [{
      target: "auth",
      occurrence: 1,
      answer: { kind: "network_error" },
    }],
    env: AUTH_TIMEOUT,
    expect: { ...ok(2, 3), minLatencyMs: 100 },
  },

  // ── PostgREST: the permit lookup (GET analysis_permits) ────────────────────
  select(
    "S01",
    "PostgREST connection refused on the lookup (supabase-js retries GET 3× with 1s/2s/4s backoff)",
    { kind: "network_error" },
    {
      ...unavailable("reserved", {
        gotrue: 1,
        postgrest: 4,
        minLatencyMs: 7_000,
      }),
    },
    {
      flag:
        "outage on the permit GET stalls the request ≥7s (4 PostgREST round trips) before the 503: postgrest-js@2.112.4 retries idempotent methods with 1s/2s/4s backoff and no per-call deadline",
    },
  ),
  select(
    "S02",
    "PostgREST lookup hangs 300ms per attempt then resets (no signal on PostgREST calls)",
    { kind: "hang", ms: 300 },
    {
      ...unavailable("reserved", {
        gotrue: 1,
        postgrest: 4,
        minLatencyMs: 8_000,
      }),
    },
    {
      flag:
        "no server-side deadline on PostgREST calls: a hanging lookup is bounded only by the socket + the 3 client retries",
    },
  ),
  select(
    "S03",
    "PostgREST HTTP 500 on the lookup",
    http(
      500,
      JSON.stringify({
        code: "XX000",
        message: "internal_error",
        details: null,
        hint: null,
      }),
    ),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 1 }),
    },
  ),
  select(
    "S04",
    "PostgREST HTTP 502 gateway HTML on the lookup",
    http(502, html502, { "Content-Type": "text/html" }),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 1 }),
    },
  ),
  select(
    "S05",
    "PostgREST HTTP 503 + Retry-After: 1 on the lookup (schema cache reload)",
    http(
      503,
      JSON.stringify({
        code: "PGRST002",
        message: "Could not query the database for the schema cache",
        details: null,
        hint: null,
      }),
      { "Retry-After": "1" },
    ),
    {
      ...unavailable("reserved", {
        gotrue: 1,
        postgrest: 4,
        minLatencyMs: 2_900,
      }),
    },
    {
      flag:
        "a PostgREST 503 Retry-After is honoured by postgrest-js on each of 3 retries with no cap (Retry-After: N → ≥3·N s inside one edge request)",
    },
  ),
  select(
    "S06",
    "PostgREST HTTP 520 (Cloudflare) on the lookup",
    http(520, "", { "Content-Type": "text/plain" }),
    {
      ...unavailable("reserved", {
        gotrue: 1,
        postgrest: 4,
        minLatencyMs: 7_000,
      }),
    },
  ),
  select(
    "S07",
    "PostgREST HTTP 429 on the lookup",
    http(429, JSON.stringify({ message: "rate limited" })),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 1 }),
    },
  ),
  select(
    "S08",
    "PostgREST HTTP 401 PGRST301 (JWT expired between GoTrue and PostgREST)",
    http(
      401,
      JSON.stringify({
        code: "PGRST301",
        message: "JWT expired",
        details: null,
        hint: null,
      }),
    ),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 1 }),
    },
  ),
  select(
    "S09",
    "PostgREST HTTP 403 42501 (grant missing) on the lookup",
    http(
      403,
      JSON.stringify({
        code: "42501",
        message: "permission denied for table analysis_permits",
        details: null,
        hint: null,
      }),
    ),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 1 }),
    },
  ),
  select(
    "S10",
    "PostgREST 200 with truncated JSON on the lookup",
    http(200, '[{"id":"x", "status": tru'),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 1 }),
    },
  ),
  select(
    "S11",
    "PostgREST 200 [] although the row exists (lagging replica / RLS mismatch)",
    http(200, "[]"),
    {
      class: "not_found_404",
      code: "access.permit_not_found",
      permit: "reserved",
      gotrue: 1,
      postgrest: 1,
    },
    {
      flag:
        "an empty lookup is a terminal 404 for the client (release abandoned; permit swept after 24h) — correct for a truly missing row, indistinguishable from a stale read",
    },
  ),
  select(
    "S12",
    "PostgREST 200 with an object instead of a row array",
    http(200, JSON.stringify({ id: "x" })),
    {
      class: "conflict_409",
      code: "access.permit_already_finalized",
      permit: "reserved",
      gotrue: 1,
      postgrest: 1,
    },
    {
      flag:
        "a non-array 2xx lookup body is read as a permit row with status undefined and answered 409 permit_already_finalized (should be a retryable 503)",
    },
  ),
  select(
    "S13",
    "PostgREST 200 with two rows for one id",
    http(
      200,
      permitJson("a", "reserved", null).slice(0, -1) + "," +
        permitJson("b", "reserved", null).slice(1),
    ),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 1 }),
    },
  ),
  select(
    "S14",
    "PostgREST 200 with body null on the lookup",
    http(200, "null"),
    {
      class: "not_found_404",
      code: "access.permit_not_found",
      permit: "reserved",
      gotrue: 1,
      postgrest: 1,
    },
    {
      flag:
        "a `null` 2xx body is answered as a terminal 404 (row missing) rather than a retryable 503",
    },
  ),
  select("S15", "PostgREST lookup answers 200ms late", {
    kind: "slow",
    ms: 200,
  }, {
    ...ok(1, 3),
    minLatencyMs: 200,
  }),
  select(
    "S16",
    "PostgREST connection reset once on the lookup, then healthy (client retry)",
    { kind: "network_error" },
    {
      ...ok(1, 4),
      minLatencyMs: 950,
    },
    {
      faults: [{
        target: "rest.select",
        occurrence: 1,
        answer: { kind: "network_error" },
      }],
    },
  ),

  // ── PostgREST: the conditional update (PATCH … status=eq.reserved) ─────────
  update(
    "U01",
    "PostgREST connection refused on the update (PATCH is never retried)",
    { kind: "network_error" },
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update("U02", "PostgREST update hangs 400ms then resets", {
    kind: "hang",
    ms: 400,
  }, {
    ...unavailable("reserved", { gotrue: 1, postgrest: 2, minLatencyMs: 400 }),
  }),
  update(
    "U03",
    "PostgREST HTTP 500 on the update",
    http(500, JSON.stringify({ code: "XX000", message: "internal_error" })),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update(
    "U04",
    "PostgREST HTTP 503 + Retry-After on the update (not retried: non-idempotent)",
    http(503, JSON.stringify({ code: "PGRST002", message: "schema cache" }), {
      "Retry-After": "5",
    }),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update(
    "U05",
    "PostgREST HTTP 429 on the update",
    http(429, JSON.stringify({ message: "rate limited" })),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update(
    "U06",
    "PostgREST HTTP 401 PGRST301 on the update",
    http(401, JSON.stringify({ code: "PGRST301", message: "JWT expired" })),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update(
    "U07",
    "PostgREST HTTP 403 42501 (column grant missing) on the update",
    http(
      403,
      JSON.stringify({
        code: "42501",
        message: "permission denied for table analysis_permits",
      }),
    ),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update(
    "U08",
    "PostgREST 200 with truncated JSON on the update",
    http(200, '[{"id":'),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update(
    "U09",
    "PostgREST 200 [] on the update while the row was NOT written",
    http(200, "[]"),
    {
      class: "conflict_409",
      code: "access.permit_already_finalized",
      permit: "reserved",
      gotrue: 1,
      postgrest: 3,
    },
    {
      flag:
        "an update that matched nothing is re-read; a row still `reserved` (outcome null) is answered 409 'already finalized as reserved' — a terminal class for a permit that is still open (needs a 2xx-without-write from PostgREST; not reachable with real PostgREST semantics)",
    },
  ),
  update(
    "U10",
    "PostgREST 204 without representation (Prefer: return=representation ignored)",
    http(204, ""),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),
  update(
    "U11",
    "update COMMITTED, answer lost (connection reset after the write)",
    { kind: "network_error" },
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 2 }),
    },
    { applyWrite: true },
  ),
  update(
    "U12",
    "update COMMITTED, representation empty → race re-read finds the same outcome",
    http(200, "[]"),
    {
      ...ok(1, 4),
    },
    { applyWrite: true },
  ),
  update(
    "U13",
    "PostgREST 200 with two rows from the update",
    http(
      200,
      permitJson("a", "finalized", "cancelled").slice(0, -1) + "," +
        permitJson("b", "finalized", "cancelled").slice(1),
    ),
    {
      ...unavailable("reserved", { gotrue: 1, postgrest: 2 }),
    },
  ),

  // ── PostgREST: the race re-read after an empty update ──────────────────────
  reselect("R01", "race re-read: connection refused (GET retried 3×)", {
    kind: "network_error",
  }, {
    class: "conflict_409",
    code: "access.permit_already_finalized",
    permit: "finalized",
    gotrue: 1,
    postgrest: 6,
    minLatencyMs: 7_000,
  }, {
    flag:
      "index.ts finalizeAnalysisPermitRoute: `settled.error` is never checked — a failed race re-read is answered 409 'already finalized as unknown' instead of a retryable 503",
  }),
  reselect(
    "R02",
    "race re-read: HTTP 500",
    http(500, JSON.stringify({ code: "XX000", message: "internal_error" })),
    {
      class: "conflict_409",
      code: "access.permit_already_finalized",
      permit: "finalized",
      gotrue: 1,
      postgrest: 3,
    },
    {
      flag:
        "same as R01 (settled.error unchecked) — 1 round trip, no retry for a 500",
    },
  ),
  reselect(
    "R03",
    "race re-read: 200 [] (row vanished between the update and the re-read)",
    http(200, "[]"),
    {
      class: "conflict_409",
      code: "access.permit_already_finalized",
      permit: "finalized",
      gotrue: 1,
      postgrest: 3,
    },
  ),

  // ── PostgREST RPC access_state (POST, after the write) ─────────────────────
  rpc(
    "P01",
    "access_state connection refused (POST: no client retry) — permit already finalized",
    { kind: "network_error" },
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
    },
  ),
  rpc(
    "P02",
    "access_state hangs 400ms then resets",
    { kind: "hang", ms: 400 },
    {
      ...unavailable("finalized", {
        gotrue: 1,
        postgrest: 3,
        minLatencyMs: 400,
      }),
    },
  ),
  rpc(
    "P03",
    "access_state HTTP 500",
    http(500, JSON.stringify({ code: "XX000", message: "internal_error" })),
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
    },
  ),
  rpc(
    "P04",
    "access_state HTTP 503 + Retry-After",
    http(503, JSON.stringify({ code: "PGRST002", message: "schema cache" }), {
      "Retry-After": "3",
    }),
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
    },
  ),
  rpc(
    "P05",
    "access_state HTTP 429",
    http(429, JSON.stringify({ message: "rate limited" })),
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
    },
  ),
  rpc(
    "P06",
    "access_state HTTP 401 PGRST301",
    http(401, JSON.stringify({ code: "PGRST301", message: "JWT expired" })),
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
    },
  ),
  rpc(
    "P07",
    "access_state HTTP 403 42501 (EXECUTE revoked)",
    http(
      403,
      JSON.stringify({
        code: "42501",
        message: "permission denied for function access_state",
      }),
    ),
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
    },
  ),
  rpc(
    "P08",
    "access_state 200 with truncated JSON",
    http(200, '[{"premium":fal'),
    {
      ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
    },
  ),
  rpc("P09", "access_state 200 {} (object, no row)", http(200, "{}"), {
    ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
  }),
  rpc("P10", "access_state 200 [] (no row)", http(200, "[]"), {
    ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
  }),
  rpc("P11", "access_state 200 [null]", http(200, "[null]"), {
    ...unavailable("finalized", { gotrue: 1, postgrest: 3 }),
  }),
  rpc("P12", "access_state 200 with a JSON string body", http(200, '"abc"'), {
    ...ok(1, 3),
  }, {
    flag:
      "a JSON *string* 2xx from the RPC indexes as a row ('a') and is answered 200 with a default access payload (used 0, remaining 2) — permit correctly finalized; the client ignores `access` on this route",
  }),
  rpc(
    "P13",
    "access_state 200 with stringly-typed counters and null reserved_count",
    http(
      200,
      JSON.stringify([{
        premium: "yes",
        scored_count: "2",
        reserved_count: null,
      }]),
    ),
    {
      ...ok(1, 3),
    },
  ),
  rpc("P14", "access_state answers 200ms late", { kind: "slow", ms: 200 }, {
    ...ok(1, 3),
    minLatencyMs: 200,
  }),

  // ── Upstash Redis REST (/pipeline) ─────────────────────────────────────────
  redis("D01", "Upstash connection refused on every pipeline (cold auth)", {
    kind: "network_error",
  }, {
    ...ok(1, 3),
  }),
  redis(
    "D02",
    "Upstash connection refused on every pipeline (warm auth → L1 serves the session)",
    { kind: "network_error" },
    {
      ...ok(0, 3),
    },
    { warmAuth: true },
  ),
  redis(
    "D03",
    "Upstash never answers (1.2s per-call timeout × every pipeline in the request)",
    { kind: "hang", ms: 30_000 },
    {
      ...ok(1, 3),
      minLatencyMs: 6 * 1_150,
    },
    {
      flag:
        "a hanging Upstash adds ~1.2s per pipeline: 6 sequential pipelines on a cold-auth finalize (~7.2s), 4 when auth is warm (~4.8s) — still inside the app's 20s budget, but every request pays it until Redis recovers",
    },
  ),
  redis(
    "D04",
    "Upstash HTTP 500",
    http(500, JSON.stringify({ error: "internal" })),
    { ...ok(1, 3) },
  ),
  redis(
    "D05",
    "Upstash HTTP 401 (token rotated)",
    http(401, JSON.stringify({ error: "Unauthorized" })),
    { ...ok(1, 3) },
  ),
  redis(
    "D06",
    "Upstash HTTP 429",
    http(429, JSON.stringify({ error: "max requests exceeded" })),
    { ...ok(1, 3) },
  ),
  redis("D07", "Upstash 200 with truncated JSON", http(200, '[{"result":'), {
    ...ok(1, 3),
  }),
  redis(
    "D08",
    "Upstash 200 with an object instead of the results array",
    http(200, JSON.stringify({ result: "x" })),
    { ...ok(1, 3) },
  ),
  redis(
    "D09",
    "Upstash 200 [] short reply (reached but not answering) — warm L1 copy is NOT trusted, session re-verified",
    http(200, "[]"),
    {
      ...ok(1, 3),
    },
    { warmAuth: true },
  ),
  redis(
    "D10",
    "Upstash 200 per-command errors on every slot",
    http(
      200,
      JSON.stringify([{ error: "ERR" }, { error: "ERR" }, { error: "ERR" }]),
    ),
    {
      ...ok(1, 3),
    },
    { warmAuth: true },
  ),
  redis(
    "D11",
    "Upstash answers a STRING for the session's revocation marker (3rd pipeline of a warm request)",
    http(200, JSON.stringify([{ result: "1" }, { result: -2 }])),
    {
      class: "signed_out_401",
      code: null,
      permit: "reserved",
      gotrue: 0,
      postgrest: 0,
    },
    {
      warmAuth: true,
      occurrence: 3,
      recovery: "l1_lockout",
      flag:
        "the revocation marker is trusted as-is (revocation must win): one corrupt GET revoked:* reply from Redis signs the session out (401) AND is copied into L1 for 60s, so the retry after Redis recovers is still 401 on that isolate until L1_READTHROUGH_TTL_SECONDS elapse",
    },
  ),
  redis(
    "D12",
    "Upstash INCR answers 10^6 for the per-IP window (bogus counter)",
    http(200, JSON.stringify([{ result: 1_000_000 }, { result: 1 }])),
    {
      class: "rate_limited_429",
      code: "rate_limited",
      retryAfter: "any",
      permit: "reserved",
      gotrue: 0,
      postgrest: 0,
    },
    {
      occurrence: 1,
      flag:
        "rate-limit counters from Redis are trusted without a sanity bound: a corrupt INCR reply rate-limits the IP (429 + Retry-After ≤ window) until Redis recovers",
    },
  ),
  redis("D13", "Upstash answers 150ms late on every pipeline", {
    kind: "slow",
    ms: 150,
  }, {
    ...ok(1, 3),
    minLatencyMs: 6 * 150,
  }),
  redis(
    "D14",
    "Upstash connection refused for the first pipeline only (per-IP window falls back to memory)",
    { kind: "network_error" },
    {
      ...ok(1, 3),
    },
    { occurrence: 1 },
  ),

  // ── RevenueCat (not on this route's path — must stay 0 calls) ──────────────
  revenuecat(
    "C01",
    "RevenueCat connection refused — finalize must not consult it",
    { kind: "network_error" },
  ),
  revenuecat("C02", "RevenueCat hangs — finalize must not consult it", {
    kind: "hang",
    ms: 30_000,
  }),
  revenuecat(
    "C03",
    "RevenueCat HTTP 500 — finalize must not consult it",
    http(500, "{}"),
  ),
];

// The route's cold-auth success path issues exactly these round trips.
const COLD_SUCCESS_GOTRUE = 1;
const COLD_SUCCESS_POSTGREST = 3;

interface CaseRow {
  id: string;
  target: UpstreamTarget;
  title: string;
  seed: number;
  fault: string;
  outcome: string;
  observed: {
    status: number;
    code: string | null;
    message: string | null;
    retryAfter: string | null;
    latencyMs: number;
    gotrue: number;
    postgrest: number;
    redis: number;
    revenuecat: number;
    permitAfter: string;
    outcomeAfter: string | null;
  };
  expected: FaultCase["expect"];
  recovered: {
    status: number;
    permitAfter: string;
    outcomeAfter: string | null;
    gotrue: number;
    postgrest: number;
    latencyMs: number;
  };
  classMatched: boolean;
  invariantsHeld: boolean;
  recoveredOk: boolean;
  flag: string | null;
  replay: string;
  failures: string[];
}

function classOf(result: SendResult): VisibleClass {
  switch (result.status) {
    case 200:
      return "ok_200";
    case 400:
      return "validation_400";
    case 401:
      return "signed_out_401";
    case 404:
      return "not_found_404";
    case 409:
      return "conflict_409";
    case 429:
      return "rate_limited_429";
    case 503:
      return "retryable_503";
    case 500:
      return "generic_500";
    default:
      return `unexpected_${result.status}` as VisibleClass;
  }
}

/** parseAccess invariants (apps/mobile/src/billing/accessApi.ts). */
function accessInvariants(access: unknown): string[] {
  const problems: string[] = [];
  if (!access || typeof access !== "object") return ["access payload missing"];
  const a = access as Record<string, unknown>;
  const free = a.freeRatings as Record<string, unknown> | undefined;
  if (!free) return ["freeRatings missing"];
  const used = Number(free.used);
  const remaining = Number(free.remaining);
  const reserved = Number(free.reserved);
  const available = Number(free.availableToReserve);
  if (!(used >= 0 && used <= 2)) problems.push(`used=${free.used}`);
  if (remaining !== 2 - used) problems.push(`remaining=${free.remaining}`);
  if (!(reserved >= 0 && reserved <= remaining)) {
    problems.push(`reserved=${free.reserved}`);
  }
  if (available !== remaining - reserved) {
    problems.push(`availableToReserve=${free.availableToReserve}`);
  }
  const entitlements = Array.isArray(a.entitlements) ? a.entitlements : null;
  if (!entitlements) problems.push("entitlements not an array");
  else if (a.premium !== entitlements.includes("premium")) {
    problems.push("premium ≠ entitlements.includes('premium')");
  }
  if (a.canStartRating !== (a.premium === true || available > 0)) {
    problems.push("canStartRating inconsistent");
  }
  if (a.paywallRequired !== !a.canStartRating) {
    problems.push("paywallRequired inconsistent");
  }
  return problems;
}

function genericBodyProblems(result: SendResult, permitId: string): string[] {
  const problems: string[] = [];
  if (!result.requestId) problems.push("no X-Request-Id");
  if (result.status >= 500) {
    const text = JSON.stringify(result.body);
    if (result.code !== null) problems.push("5xx body carries an error code");
    for (
      const leak of [
        "connection",
        "refused",
        "PGRST",
        "42501",
        "socket",
        permitId,
        "stack",
      ]
    ) {
      if (text.includes(leak)) problems.push(`5xx body leaks '${leak}'`);
    }
  }
  return problems;
}

async function warmAuth(
  h: StressHarness,
  token: string,
  ip: string,
): Promise<void> {
  const warm = await h.send(
    new Request(`${SUPABASE_URL}/functions/v1/api/v1/me/access`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": ip },
    }),
  );
  assertEquals(warm.status, 200, `warm-up GET /v1/me/access → ${warm.status}`);
}

function withEnv<T>(
  env: Record<string, string> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env ?? {})) {
    previous.set(k, Deno.env.get(k));
    Deno.env.set(k, v);
  }
  return fn().finally(() => {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

async function runCase(
  h: StressHarness,
  c: FaultCase,
  seed: number,
): Promise<CaseRow> {
  h.reset();
  const rng = new Prng(seed);
  const { user, session, permit } = h.seedCase(rng);
  const outcome =
    RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)];
  const ip = `198.51.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  const failures: string[] = [];

  if (c.warmAuth) await warmAuth(h, session.accessToken, ip);

  h.setFaults(c.faults);
  const faulted = await withEnv(
    c.env,
    () =>
      h.send(
        h.finalizeRequest(permit.id, session.accessToken, {
          outcome,
          ratingId: null,
        }, ip),
      ),
  );
  h.clearFaults();

  const rowAfter = { ...h.permits.get(permit.id)! };
  const observedClass = classOf(faulted);

  // 1. user-visible class
  if (observedClass !== c.expect.class) {
    failures.push(
      `class ${observedClass} ≠ expected ${c.expect.class} (status ${faulted.status})`,
    );
  }
  if (c.expect.code !== undefined && faulted.code !== c.expect.code) {
    failures.push(`code ${faulted.code} ≠ ${c.expect.code}`);
  }
  if (c.expect.retryAfter !== undefined) {
    if (c.expect.retryAfter === "any") {
      if (!faulted.retryAfter) failures.push("Retry-After missing");
    } else if (c.expect.retryAfter === null) {
      // generic 503 without a hint is acceptable; a hint is fine too
    } else if (faulted.retryAfter !== c.expect.retryAfter) {
      failures.push(
        `Retry-After ${faulted.retryAfter} ≠ ${c.expect.retryAfter}`,
      );
    }
  }
  if (
    c.expect.gotrue !== undefined && faulted.trace.gotrue !== c.expect.gotrue
  ) {
    failures.push(
      `gotrue round trips ${faulted.trace.gotrue} ≠ ${c.expect.gotrue}`,
    );
  }
  if (
    c.expect.postgrest !== undefined &&
    faulted.trace.postgrest !== c.expect.postgrest
  ) {
    failures.push(
      `postgrest round trips ${faulted.trace.postgrest} ≠ ${c.expect.postgrest}`,
    );
  }
  if (
    c.expect.minLatencyMs !== undefined &&
    faulted.latencyMs < c.expect.minLatencyMs
  ) {
    failures.push(
      `latency ${faulted.latencyMs.toFixed(0)}ms < ${c.expect.minLatencyMs}ms`,
    );
  }
  if (c.target === "revenuecat" && faulted.trace.revenuecat !== 0) {
    failures.push(`RevenueCat was consulted ${faulted.trace.revenuecat}×`);
  }
  const classMatched = failures.length === 0;

  // 2. invariants: never a foreign outcome, never a double finalization,
  //    generic 5xx bodies, request id on every answer
  const invariantProblems: string[] = [];
  if (rowAfter.outcome !== null && rowAfter.outcome !== outcome) {
    invariantProblems.push(
      `permit outcome ${rowAfter.outcome} ≠ requested ${outcome}`,
    );
  }
  if (rowAfter.status !== "reserved" && rowAfter.status !== "finalized") {
    invariantProblems.push(`permit status ${rowAfter.status}`);
  }
  if (rowAfter.status !== c.expect.permit) {
    invariantProblems.push(
      `permit ${rowAfter.status} ≠ expected ${c.expect.permit}`,
    );
  }
  invariantProblems.push(...genericBodyProblems(faulted, permit.id));
  if (faulted.status === 200) {
    const body = faulted.body as {
      permit?: { outcome?: unknown; status?: unknown };
      access?: unknown;
    };
    if (
      body.permit?.status !== "finalized" || body.permit?.outcome !== outcome
    ) {
      invariantProblems.push(
        `200 view ${JSON.stringify(body.permit)} ≠ finalized/${outcome}`,
      );
    }
    invariantProblems.push(...accessInvariants(body.access));
  }
  const invariantsHeld = invariantProblems.length === 0;
  failures.push(...invariantProblems);

  // 3. recoverability: the client's retry of the same request after the fault clears
  const recovered = await h.send(
    h.finalizeRequest(permit.id, session.accessToken, {
      outcome,
      ratingId: null,
    }, ip),
  );
  const rowRecovered = { ...h.permits.get(permit.id)! };
  const recoveryProblems: string[] = [];
  if (c.recovery === "l1_lockout") {
    if (recovered.status !== 401) {
      recoveryProblems.push(
        `expected pinned 401 lockout, got ${recovered.status}`,
      );
    }
    if (rowRecovered.status !== "reserved" || rowRecovered.outcome !== null) {
      recoveryProblems.push(
        `permit touched during lockout: ${rowRecovered.status}/${rowRecovered.outcome}`,
      );
    }
    if (recovered.trace.gotrue !== 0 || recovered.trace.postgrest !== 0) {
      recoveryProblems.push("lockout request reached GoTrue/PostgREST");
    }
  } else {
    if (recovered.status !== 200) {
      recoveryProblems.push(
        `retry after fault → ${recovered.status} ${recovered.code ?? ""} ${
          recovered.message ?? ""
        }`,
      );
    }
    if (
      rowRecovered.status !== "finalized" || rowRecovered.outcome !== outcome
    ) {
      recoveryProblems.push(
        `permit after retry ${rowRecovered.status}/${rowRecovered.outcome}`,
      );
    }
    if (recovered.status === 200) {
      const body = recovered.body as {
        permit?: { outcome?: unknown };
        access?: unknown;
      };
      if (body.permit?.outcome !== outcome) {
        recoveryProblems.push("retry view outcome mismatch");
      }
      recoveryProblems.push(...accessInvariants(body.access));
      // A finalized permit no longer counts as reserved.
      const free =
        (body.access as { freeRatings?: { reserved?: number } }).freeRatings;
      if (free?.reserved !== 0) {
        recoveryProblems.push(`reserved after release = ${free?.reserved}`);
      }
    }
    if (recovered.trace.revenuecat !== 0) {
      recoveryProblems.push("RevenueCat consulted on retry");
    }
    // A different outcome on the now-finalized permit must be a 409, never a rewrite.
    const other = RELEASABLE_OUTCOMES.find((o) => o !== outcome)!;
    const conflicting = await h.send(
      h.finalizeRequest(permit.id, session.accessToken, {
        outcome: other,
        ratingId: null,
      }, ip),
    );
    if (
      conflicting.status !== 409 ||
      conflicting.code !== "access.permit_already_finalized"
    ) {
      recoveryProblems.push(
        `conflicting outcome after finalization → ${conflicting.status} ${conflicting.code}`,
      );
    }
    if (h.permits.get(permit.id)!.outcome !== outcome) {
      recoveryProblems.push("conflicting outcome rewrote the permit");
    }
  }
  const recoveredOk = recoveryProblems.length === 0;
  failures.push(...recoveryProblems);

  const faultLabel = c.faults
    .map((f) =>
      `${f.target}${f.occurrence ? `#${f.occurrence}` : ""}${
        f.applyWrite ? "(write applied)" : ""
      }:${f.answer.kind}${
        f.answer.kind === "http"
          ? ` ${f.answer.status} ${f.answer.body.slice(0, 40)}`
          : ""
      }${
        f.answer.kind === "hang" || f.answer.kind === "slow"
          ? ` ${f.answer.ms}ms`
          : ""
      }`
    )
    .join(" + ");

  return {
    id: c.id,
    target: c.target,
    title: c.title,
    seed,
    fault: faultLabel,
    outcome,
    observed: {
      status: faulted.status,
      code: faulted.code,
      message: faulted.message,
      retryAfter: faulted.retryAfter,
      latencyMs: Math.round(faulted.latencyMs * 10) / 10,
      gotrue: faulted.trace.gotrue,
      postgrest: faulted.trace.postgrest,
      redis: faulted.trace.redis,
      revenuecat: faulted.trace.revenuecat,
      permitAfter: rowAfter.status,
      outcomeAfter: rowAfter.outcome,
    },
    expected: c.expect,
    recovered: {
      status: recovered.status,
      permitAfter: rowRecovered.status,
      outcomeAfter: rowRecovered.outcome,
      gotrue: recovered.trace.gotrue,
      postgrest: recovered.trace.postgrest,
      latencyMs: Math.round(recovered.latencyMs * 10) / 10,
    },
    classMatched,
    invariantsHeld,
    recoveredOk,
    flag: c.flag ?? null,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_ONLY=${c.id} deno test -A --no-check --config deno.json stress_permit_finalize_faults.test.ts`,
    failures,
  };
}

const only = (Deno.env.get("STRESS_ONLY") ?? "").split(",").map((s) => s.trim())
  .filter(Boolean);
const selected = only.length
  ? FAULT_CASES.filter((c) => only.includes(c.id))
  : FAULT_CASES;
const REPEAT = envInt("STRESS_REPEAT", 1);

Deno.test("stress faults: catalogue covers every upstream with ≥40 cases and unique ids", () => {
  const ids = new Set(FAULT_CASES.map((c) => c.id));
  assertEquals(ids.size, FAULT_CASES.length, "case ids are unique");
  assert(FAULT_CASES.length >= 40, `${FAULT_CASES.length} cases`);
  const targets = histogram(FAULT_CASES.map((c) => c.target));
  for (
    const t of [
      "auth",
      "rest.select",
      "rest.update",
      "rpc.access_state",
      "redis",
      "revenuecat",
    ]
  ) {
    assert((targets[t] ?? 0) >= 3, `≥3 cases for ${t}`);
  }
});

Deno.test("stress faults: every upstream fault → asserted user-visible class, no permit corruption, recoverable on retry", async (t) => {
  const h = await loadStressHarness({ redis: true });
  const rows: CaseRow[] = [];
  const heapBefore = heapSnapshot();
  const startedAt = performance.now();

  for (const c of selected) {
    const seed = (STRESS_SEED ^ fnv1a(c.id)) >>> 0;
    await t.step(`${c.id} ${c.title}`, async () => {
      let row: CaseRow | null = null;
      const repeatFailures: number[] = [];
      for (let i = 0; i < REPEAT; i++) {
        row = await runCase(h, c, seed);
        if (row.failures.length) repeatFailures.push(i);
      }
      assert(row);
      if (REPEAT > 1) {
        row.failures.push(
          `repeat: ${repeatFailures.length}/${REPEAT} iterations failed`,
        );
        if (repeatFailures.length === 0) row.failures.length = 0;
      }
      rows.push(row);
      assertEquals(
        row.failures,
        [],
        `${c.id} — ${c.title}\n  fault: ${row.fault}\n  observed: ${
          JSON.stringify(row.observed)
        }\n  replay: ${row.replay}`,
      );
    });
  }

  const passed = rows.filter((r) => r.failures.length === 0).length;
  const report = {
    campaign: "stress_permit_finalize_faults",
    route: "POST /v1/analysis-permits/:id/finalize",
    plane:
      "in-process real handler (index.ts @ Deno) over stubbed GoTrue/PostgREST/Upstash/RevenueCat",
    seed: STRESS_SEED,
    repeat: REPEAT,
    cases: rows.length,
    passed,
    failed: rows.length - passed,
    byTarget: histogram(rows.map((r) => r.target)),
    byObservedStatus: histogram(rows.map((r) => r.observed.status)),
    flagged: rows.filter((r) => r.flag).map((r) => ({
      id: r.id,
      flag: r.flag,
      observed: r.observed,
    })),
    coldSuccessRoundTrips: {
      gotrue: COLD_SUCCESS_GOTRUE,
      postgrest: COLD_SUCCESS_POSTGREST,
    },
    durationMs: Math.round(performance.now() - startedAt),
    heap: { before: heapBefore, after: heapSnapshot() },
    rows,
  };
  const path = await writeArtifact("faults.json", report);
  console.log(
    `[stress faults] ${passed}/${rows.length} cases held · table → ${path}`,
  );
  console.table(
    rows.map((r) => ({
      id: r.id,
      target: r.target,
      status: r.observed.status,
      code: r.observed.code ?? "",
      ms: Math.round(r.observed.latencyMs),
      gotrue: r.observed.gotrue,
      pgrst: r.observed.postgrest,
      redis: r.observed.redis,
      permit: r.observed.permitAfter,
      retry: r.recovered.status,
      flag: r.flag ? "FLAG" : "",
      ok: r.failures.length === 0 ? "PASS" : "FAIL",
    })),
  );
});
