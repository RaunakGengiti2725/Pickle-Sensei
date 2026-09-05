// stress-route-post-v1-analyses-id / failure-load — FAULT INJECTION campaign
// against the REAL `POST /v1/analyses/:id/feedback` handler (in-process; see
// stress_feedback_harness.ts). Upstash is NOT configured in this isolate —
// the Redis fault cases live in stress_feedback_redis.test.ts.
//
// Every fault case is run for STRESS_ITER seeds (default 1; hang/retry cases
// need STRESS_SLOW=1 or STRESS_ITER>1). Each seed mints a
// fresh user, session bearer, analysis (synced shot) and IP so the auth cache
// is cold and no per-user/IP budget bleeds between iterations. Per iteration:
//
//   1. the request is sent while the fault is active   → status/code/Retry-After
//      are asserted against the CONTRACT below and the wall time is bounded;
//   2. the fault is cleared and the SAME request is re-sent → the recovery
//      class is asserted (retry succeeds / duplicate is 409 / re-auth / fixed
//      request);
//   3. no client-visible body ever carries the injected upstream detail (CANARY).
//
// Contract (../index.ts + AGENTS.md "Scale & security"): Supabase Auth
// unavailable → 503 with Retry-After (never a 401); Auth REFUSES the bearer →
// 401; PostgREST failing/malformed → generic 503, detail only in function
// logs; duplicate insert (23505) → 409 analysis.feedback_exists; validation →
// 400 validation.analysis_feedback; unknown analysis → 404 analysis.not_found;
// RevenueCat is never consulted on this route.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_feedback_faults.test.ts
//   STRESS_ITER=25 STRESS_SEED=1 STRESS_OUT_DIR=/tmp/stress deno test -A --no-check --config deno.json stress_feedback_faults.test.ts
//
// Results: <STRESS_OUT_DIR>/faults.json — one row per (case, seed) with the
// replay seed, observed outcome, expectation and verdict.

import { assert, assertEquals } from "@std/assert";
import {
  CANARY,
  drive,
  fakeGoogleIdToken,
  type FaultMode,
  type FaultPlan,
  feedbackRequest,
  loadStressHarness,
  type Outcome,
  seededCase,
  STRESS_ITER,
  STRESS_SEED,
  type StressHarness,
  writeJson,
} from "./stress_feedback_harness.ts";

/** Short GoTrue deadline so hang cases resolve quickly (index.ts reads it per call). */
const AUTH_TIMEOUT_MS = 400;
/** How long a PostgREST hang lasts (longer than the hot-path budget on purpose). */
const DB_HANG_MS = 7_000;
/**
 * Hot-path answer budget. index.ts gives GoTrue a 6 s deadline so the edge
 * answers "well inside" the app's launch wait; the same budget is applied to
 * every upstream here. Breaches are reported as SLO_BREACH rows (and fail the
 * test only under STRESS_STRICT_SLO=1) so the campaign can live in the suite
 * while still documenting stalls.
 */
const HOT_PATH_SLO_MS = 6_000;
const TRACE = Deno.env.get("STRESS_TRACE") === "1";
const STRICT_SLO = Deno.env.get("STRESS_STRICT_SLO") === "1";
/**
 * Hang/retry cases each take DB_HANG_MS+ of wall time (nine of them ≈ 70 s).
 * They run in a full campaign (STRESS_ITER > 1) or on STRESS_SLOW=1; the
 * default suite run skips them and lists them under `skippedSlowIds` — a skip
 * is reported, never counted as HELD.
 */
const RUN_SLOW = Deno.env.get("STRESS_SLOW") === "1" || STRESS_ITER > 1;

type Recovery =
  /** the identical request succeeds once the upstream is healthy */
  | "retry_succeeds"
  /** the first attempt landed; the retry is the idempotent 409 */
  | "retry_is_duplicate"
  /** the app must sign in again (the bearer was refused) — the request itself is fine */
  | "reauth"
  /** the client must change the request */
  | "fix_request"
  /** nothing to recover: first attempt succeeded */
  | "none";

interface Expect {
  status: number | number[];
  code?: string | null;
  /** Retry-After header must be present (true) / absent (false) / either (undefined). */
  retryAfter?: boolean;
  recovery: Recovery;
  /** Upstream call-count constraints for the FAULTED attempt. */
  authCalls?: number | ((n: number) => boolean);
  rcCalls?: number;
  maxMs?: number;
  /** Row count in analysis_feedback after the faulted attempt. */
  rowsAfterFault?: number;
  /** Calls to the faulted PostgREST table on the faulted attempt (1 = no client-side retry). */
  targetCalls?: number;
  /** feedback.reviewEligible in a 201 body. */
  reviewEligible?: boolean;
  /** Whether a 201 body must carry feedback.id + feedback.createdAt (default true). */
  bodyComplete?: boolean;
}

interface Case {
  id: string;
  /** Takes ≳ DB_HANG_MS of wall time; gated by RUN_SLOW. */
  slow?: true;
  upstream: keyof FaultPlan | "client" | "none";
  title: string;
  fault?: FaultMode;
  /** Request mutation for client-side faults. */
  request?: (
    ctx: ReturnType<typeof seededCase> & { token: string; h: StressHarness },
  ) => Request;
  /** Model mutation before the faulted attempt. */
  setup?: (
    ctx: ReturnType<typeof seededCase> & { token: string; h: StressHarness },
  ) => void;
  expect: Expect;
}

const s503 = (
  recovery: Recovery = "retry_succeeds",
  extra: Partial<Expect> = {},
): Expect => ({
  status: 503,
  code: null,
  recovery,
  ...extra,
});

const CASES: Case[] = [
  // ── Supabase Auth (GET /auth/v1/user, session bearer, cold cache) ──
  {
    id: "A01",
    upstream: "auth",
    title: "GoTrue 500",
    fault: { kind: "http", status: 500 },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A02",
    upstream: "auth",
    title: "GoTrue 502",
    fault: { kind: "http", status: 502 },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A03",
    upstream: "auth",
    title: "GoTrue 503 + Retry-After 7",
    fault: { kind: "http", status: 503, headers: { "Retry-After": "7" } },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A04",
    upstream: "auth",
    title: "GoTrue 429",
    fault: { kind: "http", status: 429 },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A05",
    upstream: "auth",
    title: "GoTrue 404 (not a verdict status)",
    fault: { kind: "http", status: 404 },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A06",
    upstream: "auth",
    title: "GoTrue hangs past the deadline",
    fault: { kind: "hang", ms: AUTH_TIMEOUT_MS * 4 },
    expect: s503("retry_succeeds", {
      retryAfter: true,
      maxMs: AUTH_TIMEOUT_MS * 3,
    }),
  },
  {
    id: "A07",
    upstream: "auth",
    title: "GoTrue socket fails on every attempt",
    fault: { kind: "throw" },
    expect: s503("retry_succeeds", {
      retryAfter: true,
      authCalls: (n) => n >= 2,
      maxMs: AUTH_TIMEOUT_MS * 3,
    }),
  },
  {
    id: "A08",
    upstream: "auth",
    title: "GoTrue socket fails once, then answers",
    fault: { kind: "throw", times: 1 },
    expect: { status: 201, recovery: "retry_is_duplicate", authCalls: 2 },
  },
  {
    id: "A09",
    upstream: "auth",
    title: "GoTrue 200 non-JSON body",
    fault: { kind: "malformed" },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A10",
    upstream: "auth",
    title: "GoTrue 200 empty body",
    fault: { kind: "empty" },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A11",
    upstream: "auth",
    title: "GoTrue 200 JSON without user id",
    fault: { kind: "shape", body: { aud: "authenticated" } },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A12",
    upstream: "auth",
    title: "GoTrue 200 user without Google/Apple provider",
    fault: {
      kind: "shape",
      body: {
        id: "11111111-1111-4111-8111-111111111111",
        app_metadata: { provider: "email" },
      },
    },
    expect: { status: 401, code: null, recovery: "reauth" },
  },
  {
    id: "A13",
    upstream: "auth",
    title: "GoTrue 401 (bad JWT)",
    fault: { kind: "http", status: 401 },
    expect: { status: 401, code: null, recovery: "reauth", retryAfter: false },
  },
  {
    id: "A14",
    upstream: "auth",
    title: "GoTrue 403 session_not_found",
    fault: { kind: "http", status: 403 },
    expect: { status: 401, code: null, recovery: "reauth", retryAfter: false },
  },
  {
    id: "A15",
    upstream: "auth",
    title: "GoTrue 400",
    fault: { kind: "http", status: 400 },
    expect: { status: 401, code: null, recovery: "reauth", retryAfter: false },
  },
  {
    id: "A16",
    upstream: "auth",
    title: "GoTrue 200 array body",
    fault: { kind: "shape", body: [] },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  {
    id: "A17",
    upstream: "auth",
    title: "GoTrue 5xx with 20 KB body",
    fault: { kind: "http", status: 500, body: "x".repeat(20_000) },
    expect: s503("retry_succeeds", { retryAfter: true }),
  },
  // ── Supabase Auth (POST token?grant_type=id_token, transitional provider bearer) ──
  {
    id: "A18",
    upstream: "auth",
    title: "provider bearer: signInWithIdToken 500",
    fault: { kind: "http", status: 500 },
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: fakeGoogleIdToken(ctx.userId),
        ip: ctx.ip,
        body: ctx.body,
      }),
    expect: { status: [401, 503], recovery: "retry_succeeds" },
  },
  {
    id: "A19",
    slow: true,
    upstream: "auth",
    title:
      "provider bearer: signInWithIdToken hangs 7s (transitional path has no AUTH_UPSTREAM_TIMEOUT_MS deadline)",
    fault: { kind: "hang", ms: DB_HANG_MS },
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: fakeGoogleIdToken(ctx.userId),
        ip: ctx.ip,
        body: ctx.body,
      }),
    expect: { status: [201, 401, 503], recovery: "retry_is_duplicate" },
  },
  {
    id: "A20",
    upstream: "auth",
    title: "provider bearer: signInWithIdToken malformed",
    fault: { kind: "malformed" },
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: fakeGoogleIdToken(ctx.userId),
        ip: ctx.ip,
        body: ctx.body,
      }),
    expect: { status: [401, 503], recovery: "retry_succeeds" },
  },
  // ── Bearer faults decided at the edge (no upstream call) ──
  {
    id: "A21",
    upstream: "client",
    title: "expired session bearer",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.h.upstream.mintSession(ctx.userId, -60),
        ip: ctx.ip,
        body: ctx.body,
      }),
    expect: { status: 401, code: null, recovery: "reauth", authCalls: 0 },
  },
  {
    id: "A22",
    upstream: "client",
    title: "bearer is not a JWT",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: "not-a-jwt",
        ip: ctx.ip,
        body: ctx.body,
      }),
    expect: { status: 401, code: null, recovery: "reauth", authCalls: 0 },
  },
  {
    id: "A23",
    upstream: "client",
    title: "missing bearer",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, { ip: ctx.ip, body: ctx.body }),
    expect: { status: 401, code: null, recovery: "reauth", authCalls: 0 },
  },
  {
    id: "A24",
    upstream: "client",
    title: "bearer for a session GoTrue does not know",
    request: (ctx) => {
      const token = ctx.h.upstream.mintSession(ctx.userId);
      ctx.h.upstream.sessions.delete(token);
      return feedbackRequest(ctx.analysisId, {
        token,
        ip: ctx.ip,
        body: ctx.body,
      });
    },
    expect: { status: 401, code: null, recovery: "reauth", authCalls: 1 },
  },
  // ── PostgREST: shots ownership read ──
  {
    id: "D01",
    upstream: "shots",
    title: "shots GET 500",
    fault: { kind: "http", status: 500 },
    expect: s503(),
  },
  {
    id: "D02",
    slow: true,
    upstream: "shots",
    title: "shots GET 503 (postgrest-js retries GETs 3× with 1/2/4 s backoff)",
    fault: { kind: "http", status: 503 },
    expect: s503(),
  },
  {
    id: "D03",
    upstream: "shots",
    title: "shots GET 401 PGRST301",
    fault: { kind: "http", status: 401 },
    expect: s503(),
  },
  {
    id: "D04",
    upstream: "shots",
    title: "shots GET 403 42501",
    fault: { kind: "http", status: 403 },
    expect: s503(),
  },
  {
    id: "D05",
    slow: true,
    upstream: "shots",
    title: "shots GET socket failure",
    fault: { kind: "throw" },
    expect: s503(),
  },
  {
    id: "D06",
    upstream: "shots",
    title: "shots GET 200 non-JSON",
    fault: { kind: "malformed" },
    expect: s503(),
  },
  {
    id: "D07",
    upstream: "shots",
    title: "shots GET 200 empty body",
    fault: { kind: "empty" },
    expect: {
      status: [404, 503],
      recovery: "retry_succeeds",
      rowsAfterFault: 0,
    },
  },
  {
    id: "D08",
    upstream: "shots",
    title: "shots GET 200 two rows",
    fault: { kind: "shape", body: [{ id: "a" }, { id: "b" }] },
    expect: s503(),
  },
  {
    id: "D09",
    upstream: "shots",
    title: "shots GET 200 `null`",
    fault: { kind: "shape", body: null },
    expect: {
      status: [404, 503],
      recovery: "retry_succeeds",
      rowsAfterFault: 0,
    },
  },
  {
    id: "D10",
    slow: true,
    upstream: "shots",
    title: "shots GET hangs 7s (no client deadline on PostgREST)",
    fault: { kind: "hang", ms: DB_HANG_MS },
    expect: { status: [201, 503], recovery: "retry_is_duplicate" },
  },
  {
    id: "D12",
    slow: true,
    upstream: "shots",
    title: "shots GET 503 + Retry-After: 3 (honoured uncapped by postgrest-js)",
    fault: { kind: "http", status: 503, headers: { "Retry-After": "3" } },
    expect: s503(),
  },
  {
    id: "D13",
    slow: true,
    upstream: "shots",
    title: "shots GET 520",
    fault: { kind: "http", status: 520 },
    expect: s503(),
  },
  {
    id: "D14",
    upstream: "shots",
    title: "shots GET socket fails once, then answers",
    fault: { kind: "throw", times: 1 },
    expect: { status: 201, recovery: "retry_is_duplicate", targetCalls: 2 },
  },
  {
    id: "D11",
    upstream: "none",
    title: "analysis belongs to another user",
    setup: (ctx) => {
      ctx.h.upstream.shots = ctx.h.upstream.shots.filter((s) =>
        s.id !== ctx.analysisId
      );
      ctx.h.upstream.addShot(ctx.prng.uuid(), ctx.analysisId);
    },
    expect: {
      status: 404,
      code: "analysis.not_found",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  // ── PostgREST: consent ledger read ──
  {
    id: "C01",
    upstream: "consent",
    title: "consent GET 500",
    fault: { kind: "http", status: 500 },
    expect: s503(),
  },
  {
    id: "C02",
    upstream: "consent",
    title: "consent GET 403 42501",
    fault: { kind: "http", status: 403 },
    expect: s503(),
  },
  {
    id: "C03",
    slow: true,
    upstream: "consent",
    title: "consent GET socket failure",
    fault: { kind: "throw" },
    expect: s503(),
  },
  {
    id: "C04",
    upstream: "consent",
    title: "consent GET 200 non-JSON",
    fault: { kind: "malformed" },
    expect: s503(),
  },
  {
    id: "C05",
    upstream: "consent",
    title: "consent GET 200 object instead of array",
    fault: { kind: "shape", body: { scope: "model_training" } },
    expect: { status: [201, 500, 503], recovery: "retry_is_duplicate" },
  },
  {
    id: "C06",
    slow: true,
    upstream: "consent",
    title: "consent GET hangs 7s",
    fault: { kind: "hang", ms: DB_HANG_MS },
    expect: { status: [201, 503], recovery: "retry_is_duplicate" },
  },
  {
    id: "C07",
    upstream: "consent",
    title: "consent GET 200 empty body",
    fault: { kind: "empty" },
    expect: { status: [201, 500, 503], recovery: "retry_is_duplicate" },
  },
  // ── PostgREST: analysis_feedback insert ──
  {
    id: "I01",
    upstream: "none",
    title: "duplicate delivery: row already exists",
    setup: (ctx) => {
      ctx.h.upstream.feedback.push({
        id: crypto.randomUUID(),
        user_id: ctx.userId,
        analysis_id: ctx.analysisId,
        rating: "accurate",
        category: null,
        created_at: new Date().toISOString(),
      });
    },
    expect: {
      status: 409,
      code: "analysis.feedback_exists",
      recovery: "retry_is_duplicate",
      rowsAfterFault: 1,
    },
  },
  {
    id: "I02",
    upstream: "insert",
    title: "insert 500",
    fault: { kind: "http", status: 500 },
    expect: s503(),
  },
  {
    id: "I03",
    upstream: "insert",
    title: "insert 403 42501 (RLS/grant)",
    fault: {
      kind: "http",
      status: 403,
      body: JSON.stringify({
        code: "42501",
        message: CANARY,
        details: null,
        hint: null,
      }),
    },
    expect: s503(),
  },
  {
    id: "I04",
    upstream: "insert",
    title: "insert 400 23514 (check constraint)",
    fault: {
      kind: "http",
      status: 400,
      body: JSON.stringify({
        code: "23514",
        message: CANARY,
        details: null,
        hint: null,
      }),
    },
    expect: s503(),
  },
  {
    id: "I05",
    upstream: "insert",
    title: "insert 409 23503 (FK: profile missing)",
    fault: {
      kind: "http",
      status: 409,
      body: JSON.stringify({
        code: "23503",
        message: CANARY,
        details: null,
        hint: null,
      }),
    },
    expect: s503(),
  },
  {
    id: "I06",
    upstream: "insert",
    title: "insert 409 without SQLSTATE",
    fault: {
      kind: "http",
      status: 409,
      body: JSON.stringify({ message: CANARY }),
    },
    expect: s503(),
  },
  {
    id: "I07",
    upstream: "insert",
    title: "insert 409 23505 (unique) from PostgREST",
    fault: {
      kind: "http",
      status: 409,
      body: JSON.stringify({
        code: "23505",
        message: `duplicate key value ${CANARY}`,
        details: CANARY,
        hint: null,
      }),
    },
    expect: {
      status: 409,
      code: "analysis.feedback_exists",
      recovery: "retry_succeeds",
      rowsAfterFault: 0,
    },
  },
  {
    id: "I08",
    upstream: "insert",
    title: "insert socket failure",
    fault: { kind: "throw" },
    expect: s503(),
  },
  {
    id: "I09",
    upstream: "insert",
    title: "insert 201 non-JSON body",
    fault: { kind: "malformed" },
    expect: s503(),
  },
  {
    id: "I10",
    upstream: "insert",
    title: "insert 201 empty body",
    fault: { kind: "empty" },
    expect: { status: [201, 500, 503], recovery: "retry_succeeds" },
  },
  // PostgREST honours `Accept: application/vnd.pgrst.object+json`, so an array here is out of contract;
  // the route answers 201 without id/createdAt (the app reads only reviewEligible).
  {
    id: "I11",
    upstream: "insert",
    title: "insert 201 array instead of object",
    fault: { kind: "shape", status: 201, body: [{ id: "x", created_at: "y" }] },
    expect: {
      status: [201, 500, 503],
      recovery: "retry_is_duplicate",
      bodyComplete: false,
    },
  },
  {
    id: "I12",
    slow: true,
    upstream: "insert",
    title: "insert hangs 7s",
    fault: { kind: "hang", ms: DB_HANG_MS },
    expect: { status: [201, 503], recovery: "retry_is_duplicate" },
  },
  {
    id: "I14",
    upstream: "insert",
    title: "insert socket failure (POST must not be retried by the client)",
    fault: { kind: "throw" },
    expect: s503("retry_succeeds", { targetCalls: 1 }),
  },
  {
    id: "I15",
    upstream: "insert",
    title: "insert 503 (POST must not be retried by the client)",
    fault: { kind: "http", status: 503 },
    expect: s503("retry_succeeds", { targetCalls: 1 }),
  },
  {
    id: "I13",
    upstream: "insert",
    title: "insert 500 with 100 KB body",
    fault: {
      kind: "http",
      status: 500,
      body: `{"message":"${"y".repeat(100_000)}${CANARY}"}`,
    },
    expect: s503(),
  },
  // ── RevenueCat: never on this route ──
  {
    id: "R01",
    upstream: "rc",
    title: "RevenueCat 500 while submitting feedback",
    fault: { kind: "http", status: 500 },
    expect: { status: 201, recovery: "retry_is_duplicate", rcCalls: 0 },
  },
  {
    id: "R02",
    upstream: "rc",
    title: "RevenueCat hangs while submitting feedback",
    fault: { kind: "hang", ms: 5_000 },
    expect: {
      status: 201,
      recovery: "retry_is_duplicate",
      rcCalls: 0,
      maxMs: 1_000,
    },
  },
  // ── Client payload / path faults ──
  {
    id: "V01",
    upstream: "client",
    title: "body is not JSON",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        rawBody: "{rating:",
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V02",
    upstream: "client",
    title: "body is a JSON array",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        body: ["accurate"],
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V03",
    upstream: "client",
    title: "rating outside the vocabulary",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        body: { rating: "great" },
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V04",
    upstream: "client",
    title: "not_quite without category",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        body: { rating: "not_quite" },
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V05",
    upstream: "client",
    title: "accurate with a category",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        body: { rating: "accurate", category: "other" },
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V06",
    upstream: "client",
    title: "category outside the vocabulary",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        body: { rating: "not_quite", category: "meh" },
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V07",
    upstream: "client",
    title: "analysis id is not a UUID",
    request: (ctx) =>
      feedbackRequest("not-a-uuid", {
        token: ctx.token,
        ip: ctx.ip,
        body: ctx.body,
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V08",
    upstream: "client",
    title: "analysis id is a malformed percent-escape",
    request: (ctx) =>
      feedbackRequest("%E0%A4%A", {
        token: ctx.token,
        ip: ctx.ip,
        body: ctx.body,
      }),
    expect: { status: 400, recovery: "fix_request", rowsAfterFault: 0 },
  },
  {
    id: "V09",
    upstream: "client",
    title: "body over the 5 MB cap (Content-Length)",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        rawBody: `{"rating":"accurate","pad":"${"p".repeat(5_000_100)}"}`,
      }),
    expect: {
      status: 413,
      code: null,
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V10",
    upstream: "client",
    title: "rating is a number",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        body: { rating: 1 },
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  {
    id: "V11",
    upstream: "client",
    title: "POST /v1/analyses/:id (no /feedback) is not a route",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        body: ctx.body,
        suffix: "",
      }),
    expect: { status: 404, recovery: "fix_request", rowsAfterFault: 0 },
  },
  {
    id: "V12",
    upstream: "client",
    title: "GET /v1/analyses/:id/feedback is not a route",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        method: "GET",
      }),
    expect: { status: [404, 405], recovery: "fix_request", rowsAfterFault: 0 },
  },
  {
    id: "V13",
    upstream: "client",
    title: "empty body",
    request: (ctx) =>
      feedbackRequest(ctx.analysisId, {
        token: ctx.token,
        ip: ctx.ip,
        rawBody: "",
      }),
    expect: {
      status: 400,
      code: "validation.analysis_feedback",
      recovery: "fix_request",
      rowsAfterFault: 0,
    },
  },
  // ── Combined ──
  {
    id: "X01",
    upstream: "none",
    title: "control: healthy upstreams",
    expect: {
      status: 201,
      recovery: "retry_is_duplicate",
      rowsAfterFault: 1,
      rcCalls: 0,
    },
  },
  {
    id: "X02",
    upstream: "shots",
    title: "shots 500 for a user with several synced shots",
    setup: (ctx) => {
      ctx.h.upstream.shots.push({ id: ctx.prng.uuid(), user_id: ctx.userId });
    },
    fault: { kind: "http", status: 500 },
    expect: s503(),
  },
  {
    id: "X03",
    upstream: "none",
    title: "consent grant present → reviewEligible true",
    setup: (ctx) => {
      ctx.h.upstream.consent = [];
      ctx.h.upstream.grantConsent(ctx.userId, "model_training");
    },
    expect: {
      status: 201,
      recovery: "retry_is_duplicate",
      rowsAfterFault: 1,
      reviewEligible: true,
    },
  },
  {
    id: "X04",
    upstream: "none",
    title: "consent grant then revoke → reviewEligible false",
    setup: (ctx) => {
      ctx.h.upstream.consent = [];
      ctx.h.upstream.grantConsent(ctx.userId, "model_training");
      ctx.h.upstream.consent.push({
        ...ctx.h.upstream.consent[0],
        id: crypto.randomUUID(),
        action: "revoke",
        created_at: new Date(Date.now() + 1000).toISOString(),
      });
    },
    expect: {
      status: 201,
      recovery: "retry_is_duplicate",
      rowsAfterFault: 1,
      reviewEligible: false,
    },
  },
];

interface Row {
  id: string;
  title: string;
  seed: number;
  fault: FaultMode | "client" | "none";
  faulted: Outcome & {
    supabaseRoundTrips: number;
    authCalls: number;
    rcCalls: number;
    targetCalls: number;
    rowsAfter: number;
  };
  recovered: (Outcome & { rowsAfter: number }) | null;
  expected: Expect;
  verdict: "HELD" | "BROKEN" | "SLO_BREACH";
  failures: string[];
  sloBreaches: string[];
  replay: string;
}

function statusOk(expected: number | number[], actual: number): boolean {
  return Array.isArray(expected)
    ? expected.includes(actual)
    : expected === actual;
}

Deno.test("stress faults: ≥40 fault cases × STRESS_ITER seeds against POST /v1/analyses/:id/feedback", async () => {
  // Deno.env is process-wide and shared by every test module in a `deno test`
  // run — restore it (like adjudicate_xc_ci_release_static.test.ts does) so the
  // short deadline does not leak into later auth-outage tests.
  const previousAuthTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));
  try {
    await runFaultCampaign();
  } finally {
    if (previousAuthTimeout === undefined) {
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    } else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousAuthTimeout);
  }
});

async function runFaultCampaign(): Promise<void> {
  const h = await loadStressHarness({ redis: false });
  const rows: Row[] = [];
  let executed = 0;
  const skippedSlow: string[] = [];

  for (const c of CASES) {
    if (c.slow && !RUN_SLOW) {
      skippedSlow.push(c.id);
      continue;
    }
    for (let i = 0; i < STRESS_ITER; i++) {
      const seed = (STRESS_SEED * 1_000 + CASES.indexOf(c) * 100 + i) >>> 0;
      const ctx0 = seededCase(seed);
      const up = h.upstream;
      up.reset();
      const token = up.mintSession(ctx0.userId);
      up.addShot(ctx0.userId, ctx0.analysisId);
      if (ctx0.consentGranted) up.grantConsent(ctx0.userId, "model_training");
      const ctx = { ...ctx0, token, h };
      c.setup?.(ctx);
      const build = () =>
        c.request ? c.request(ctx) : feedbackRequest(ctx.analysisId, {
          token,
          ip: ctx.ip,
          body: ctx.body,
        });

      if (c.fault) up.setFault(c.upstream as keyof FaultPlan, c.fault);
      if (TRACE) console.log(`[stress-faults] ${c.id} seed=${seed} …`);
      const callsBefore = up.calls.length;
      const faulted = await drive(h, build());
      executed++;
      const faultedRow = {
        ...faulted,
        supabaseRoundTrips: up.supabaseRoundTrips(callsBefore),
        authCalls: up.calls.slice(callsBefore).filter((x) =>
          x.target === "auth"
        ).length,
        rcCalls: up.calls.slice(callsBefore).filter((x) =>
          x.target === "rc"
        ).length,
        targetCalls:
          up.calls.slice(callsBefore).filter((x) => x.target === c.upstream)
            .length,
        rowsAfter: up.feedback.length,
      };
      up.setFault(c.upstream as keyof FaultPlan, undefined);
      up.plan = {};

      const failures: string[] = [];
      const e = c.expect;
      if (!statusOk(e.status, faulted.status)) {
        failures.push(`status ${faulted.status} ∉ ${JSON.stringify(e.status)}`);
      }
      if (
        e.code !== undefined && e.code !== null && faulted.code !== e.code
      ) failures.push(`code ${faulted.code} ≠ ${e.code}`);
      if (e.retryAfter === true && !faulted.retryAfter) {
        failures.push("Retry-After missing");
      }
      if (e.retryAfter === false && faulted.retryAfter) {
        failures.push("Retry-After present");
      }
      if (faulted.bodyText.includes(CANARY)) {
        failures.push("upstream detail leaked to the client");
      }
      if (faulted.status >= 500 && faulted.bodyText.includes("PGRST")) {
        failures
          .push("PostgREST code leaked");
      }
      if (
        typeof e.authCalls === "number" && faultedRow.authCalls !== e.authCalls
      ) failures.push(`auth calls ${faultedRow.authCalls} ≠ ${e.authCalls}`);
      if (
        typeof e.authCalls === "function" && !e.authCalls(faultedRow.authCalls)
      ) failures.push(`auth calls ${faultedRow.authCalls} unexpected`);
      if (e.rcCalls !== undefined && faultedRow.rcCalls !== e.rcCalls) {
        failures
          .push(`RevenueCat calls ${faultedRow.rcCalls} ≠ ${e.rcCalls}`);
      }
      if (e.maxMs !== undefined && faulted.ms > e.maxMs) {
        failures.push(`took ${faulted.ms}ms > ${e.maxMs}ms`);
      }
      if (
        e.rowsAfterFault !== undefined &&
        faultedRow.rowsAfter !== e.rowsAfterFault
      ) failures.push(`rows ${faultedRow.rowsAfter} ≠ ${e.rowsAfterFault}`);
      if (
        e.targetCalls !== undefined && faultedRow.targetCalls !== e.targetCalls
      ) {
        failures.push(
          `${c.upstream} calls ${faultedRow.targetCalls} ≠ ${e.targetCalls}`,
        );
      }
      const sloBreaches: string[] = [];
      if (faulted.ms > HOT_PATH_SLO_MS) {
        sloBreaches.push(
          `answered after ${
            Math.round(faulted.ms)
          }ms > ${HOT_PATH_SLO_MS}ms budget (${c.upstream} calls: ${faultedRow.targetCalls})`,
        );
      }
      if (e.reviewEligible !== undefined) {
        const parsed = JSON.parse(faulted.bodyText) as {
          feedback?: { reviewEligible?: boolean };
        };
        if (parsed.feedback?.reviewEligible !== e.reviewEligible) {
          failures.push(
            `reviewEligible ${parsed.feedback?.reviewEligible} ≠ ${e.reviewEligible}`,
          );
        }
      }
      if (faulted.status === 201 && e.bodyComplete !== false) {
        const parsed = JSON.parse(faulted.bodyText) as {
          feedback?: Record<string, unknown>;
        };
        if (
          typeof parsed.feedback?.id !== "string" ||
          typeof parsed.feedback?.createdAt !== "string"
        ) {
          failures.push(
            `201 body incomplete: ${faulted.bodyText.slice(0, 200)}`,
          );
        }
      }
      if (!faulted.requestId) failures.push("x-request-id missing");
      const line = h.accessLog.at(-1);
      if (
        !line || line.status !== faulted.status ||
        line.requestId !== faulted.requestId
      ) failures.push("access log line does not match the response");

      // Recovery: the identical request once every upstream is healthy.
      let recovered: Row["recovered"] = null;
      if (e.recovery !== "none" && e.recovery !== "fix_request") {
        const again = await drive(h, build());
        executed++;
        recovered = { ...again, rowsAfter: up.feedback.length };
        if (again.bodyText.includes(CANARY)) {
          failures.push("recovery leaked upstream detail");
        }
        switch (e.recovery) {
          case "retry_succeeds":
            if (again.status !== 201) {
              failures.push(`recovery status ${again.status} ≠ 201`);
            }
            if (up.feedback.length !== 1) {
              failures.push(`recovery rows ${up.feedback.length} ≠ 1`);
            }
            break;
          case "retry_is_duplicate": {
            const landed = faultedRow.rowsAfter >= 1;
            const want = landed ? 409 : 201;
            if (again.status !== want) {
              failures.push(
                `recovery status ${again.status} ≠ ${want} (row landed: ${landed})`,
              );
            }
            if (landed && again.code !== "analysis.feedback_exists") {
              failures.push(`recovery code ${again.code}`);
            }
            if (up.feedback.length !== 1) {
              failures.push(
                `rows after recovery ${up.feedback.length} ≠ 1 (duplicate delivery)`,
              );
            }
            break;
          }
          case "reauth":
            // The bearer itself is fine once GoTrue answers; a transient 4xx
            // from GoTrue cannot be told from a real refusal by design.
            if (c.upstream === "auth" && again.status !== 201) {
              failures.push(`recovery status ${again.status} ≠ 201`);
            }
            break;
        }
      }
      rows.push({
        id: c.id,
        title: c.title,
        seed,
        fault: c.fault ?? (c.upstream === "client" ? "client" : "none"),
        faulted: faultedRow,
        recovered,
        expected: e,
        verdict: failures.length
          ? "BROKEN"
          : sloBreaches.length
          ? "SLO_BREACH"
          : "HELD",
        failures,
        sloBreaches,
        replay:
          `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json stress_feedback_faults.test.ts  # case ${c.id} seed ${seed}`,
      });
    }
  }

  const broken = rows.filter((r) => r.verdict === "BROKEN");
  const slo = rows.filter((r) => r.verdict === "SLO_BREACH");
  const ranCases = CASES.length - skippedSlow.length;
  const summary = {
    unit: "POST /v1/analyses/:id/feedback",
    cases: CASES.length,
    casesRun: ranCases,
    skippedSlowIds: skippedSlow,
    seedsPerCase: STRESS_ITER,
    executedRequests: executed,
    hotPathSloMs: HOT_PATH_SLO_MS,
    held: rows.length - broken.length - slo.length,
    broken: broken.length,
    sloBreaches: slo.length,
    brokenIds: [...new Set(broken.map((r) => `${r.id}@${r.seed}`))],
    sloBreachIds: [...new Set(slo.map((r) => `${r.id}@${r.seed}`))],
    msByCase: Object.fromEntries(
      CASES.map((c) => [
        c.id,
        rows.filter((r) => r.id === c.id).map((r) => Math.round(r.faulted.ms)),
      ]),
    ),
    statusByCase: Object.fromEntries(
      CASES.map((c) => [c.id, [
        ...new Set(
          rows.filter((r) => r.id === c.id).map((r) => r.faulted.status),
        ),
      ]]),
    ),
    heap: Deno.memoryUsage(),
  };
  const path = await writeJson("faults.json", {
    summary,
    rows,
    serverLogTail: h.serverLog.slice(-20),
  });
  console.log(
    `[stress-faults] ${ranCases}/${CASES.length} cases × ${STRESS_ITER} seeds = ${executed} requests; broken=${broken.length} sloBreaches=${slo.length}${
      skippedSlow.length
        ? ` skippedSlow=${skippedSlow.join(",")} (STRESS_SLOW=1 runs them)`
        : ""
    } → ${path}`,
  );
  for (const r of broken) {
    console.log(
      `[stress-faults]   BROKEN ${r.id} seed=${r.seed}: ${
        r.failures.join("; ")
      }`,
    );
  }
  for (const r of slo) {
    console.log(
      `[stress-faults]   SLO_BREACH ${r.id} seed=${r.seed}: ${
        r.sloBreaches.join("; ")
      }`,
    );
  }
  assert(ranCases >= 40, `fault matrix ran ${ranCases} cases (< 40)`);
  assertEquals(
    broken.map((r) => `${r.id}@${r.seed}: ${r.failures.join("; ")}`),
    [],
  );
  if (STRICT_SLO) {
    assertEquals(
      slo.map((r) => `${r.id}@${r.seed}: ${r.sloBreaches.join("; ")}`),
      [],
    );
  }
}
