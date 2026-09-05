// STRESS — POST /v1/auth/logout — failure injection + load (no Redis isolate).
//
// Runs the REAL edge handler in-process (stress_logout_harness.ts →
// sessionHarness.ts) and, per seeded iteration:
//
//   1. a fault MATRIX: each upstream the route touches (GoTrue GET /user during
//      authenticate(), GoTrue POST /logout) answers 5xx / 4xx / malformed 2xx /
//      socket error / hang in turn, plus request-shape and lifecycle
//      (idempotency, sibling tokens, races) cases — every case asserts the
//      user-visible error class AND recoverability (is the session still
//      usable / correctly dead afterwards?);
//   2. a seeded CHAOS campaign: random fault combinations checked against an
//      oracle of the documented contract;
//   3. LOAD: N logouts → p50/p95 handler latency + GoTrue round trips per request;
//   4. MEMORY: M distinct users verify+logout → heap samples (L1 cache bound).
//
// Results are written as JSON (seed → outcome) under
// artifacts/stress-route-post-v1-auth-logout/latest/. Every row carries a replay
// command. Default scale is small so the suite stays fast; campaign scale:
//
//   STRESS_ITER=25 STRESS_CHAOS=40 STRESS_LOAD=1000 STRESS_USERS=20000 \
//     deno test -A --no-check --config deno.json stress_logout_failure_load.test.ts
//
// AUTH_UPSTREAM_TIMEOUT_MS is set to 400 for the duration of each test so
// hang/timeout cases finish quickly (the function reads it per call; production
// default 6000) and restored after, because `deno test .` runs every module in
// one process and later modules' index.ts would otherwise inherit the override.

import { assert, assertEquals } from "@std/assert";
import {
  always,
  bounded,
  check,
  drain,
  emptyAnswer,
  envInt,
  firstN,
  gotrueError,
  histogram,
  jsonAnswer,
  loadStressHarness,
  logoutRequest,
  meRequest,
  mintUser,
  percentile,
  Prng,
  replayCommand,
  sessionTokenLike,
  siblingToken,
  sleep,
  STRESS_ITER,
  STRESS_LOAD,
  STRESS_SEED,
  STRESS_USERS,
  textAnswer,
  verdict,
  writeReport,
  type CaseOutcome,
  type Check,
  type Fault,
  type StressHarness,
  type UpstreamCall,
  withAuthUpstreamTimeout,
} from "./stress_logout_harness.ts";
import {
  apiRequest,
  freshIp,
  googleIdToken,
  withClockOffset,
  type FakeSession,
} from "./sessionHarness.ts";

const FILE = "stress_logout_failure_load.test.ts";
const AUTH_TIMEOUT_MS = 400;
const stressTest = (name: string, body: () => Promise<void>) =>
  Deno.test(name, () => withAuthUpstreamTimeout(AUTH_TIMEOUT_MS, body));
const STRESS_CHAOS = envInt("STRESS_CHAOS", 40);

// ── Shared helpers ───────────────────────────────────────────────────────────

interface Ctx {
  s: StressHarness;
  prng: Prng;
  seed: number;
}

const gotrue = (calls: UpstreamCall[]) =>
  calls.filter((c) => c.target === "user" || c.target === "logout");
const logoutCalls = (calls: UpstreamCall[]) => calls.filter((c) => c.target === "logout");
const userCalls = (calls: UpstreamCall[]) => calls.filter((c) => c.target === "user");

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await drain(response);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _raw: text };
  }
}

function errorMessageOf(body: Record<string, unknown>): string {
  const error = body.error;
  return error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "";
}

/** Generic, retryable 503 for `context` with nothing internal leaked. */
function generic503(context: string, response: Response, body: Record<string, unknown>): Check[] {
  const message = errorMessageOf(body);
  const raw = JSON.stringify(body);
  return [
    check("status 503", response.status === 503, response.status),
    check(
      "generic message",
      message === `${context} is temporarily unavailable. Please try again.`,
      message,
    ),
    check(
      "no internal detail leaked",
      !/injected|status 5|HTTP|supabase|stack/i.test(raw),
      raw.slice(0, 120),
    ),
    check(
      "json content-type",
      (response.headers.get("content-type") ?? "").includes("application/json"),
    ),
    check("no-store", response.headers.get("cache-control") === "no-store"),
  ];
}

function is401(response: Response, body: Record<string, unknown>, fragment: string): Check[] {
  return [
    check("status 401", response.status === 401, response.status),
    check(
      `message mentions "${fragment}"`,
      errorMessageOf(body).includes(fragment),
      errorMessageOf(body),
    ),
  ];
}

interface Subject {
  userId: string;
  token: string;
  sibling: string;
  other: string;
  session: FakeSession;
  siblingSession: FakeSession;
  otherSession: FakeSession;
}

/** A user with: the logging-out token, a sibling token of the SAME session
 * (a refresh rotation), and a token of ANOTHER session (another device). */
function subject(ctx: Ctx, provider: "google" | "apple" | "email" = "google"): Subject {
  const { userId, session } = mintUser(ctx.s, ctx.prng, { provider });
  const sib = siblingToken(ctx.s, session);
  const other = ctx.s.h.mintSession(userId, 3600);
  return {
    userId,
    token: session.accessToken,
    sibling: sib.accessToken,
    other: other.accessToken,
    session,
    siblingSession: sib,
    otherSession: other,
  };
}

async function warmUp(ctx: Ctx, token: string): Promise<Check> {
  const res = await ctx.s.h.handler(meRequest(token));
  await drain(res);
  return check("warm-up GET /v1/me is 200", res.status === 200, res.status);
}

async function status(ctx: Ctx, token: string): Promise<number> {
  const res = await ctx.s.h.handler(meRequest(token));
  await drain(res);
  return res.status;
}

/** Recoverability after a FAILED sign-out: the bearer keeps working (upstream
 * session intact, cache not evicted), sibling/other tokens too. */
async function stillSignedIn(ctx: Ctx, sub: Subject): Promise<Check[]> {
  ctx.s.faults.length = 0;
  return [
    check("upstream session NOT revoked", sub.session.revoked === false),
    check("bearer still works after failed sign-out", (await status(ctx, sub.token)) === 200),
    check("sibling still works", (await status(ctx, sub.sibling)) === 200),
    check("other device still works", (await status(ctx, sub.other)) === 200),
  ];
}

/** Recoverability after a SUCCESSFUL sign-out: this session is dead at the
 * edge (bearer and sibling refused without consulting GoTrue), other
 * device untouched. `upstreamRevoked` false when the upstream answer was
 * injected (the fake never saw the call), in which case only edge state is asserted. */
async function signedOut(ctx: Ctx, sub: Subject, upstreamRevoked = true): Promise<Check[]> {
  ctx.s.faults.length = 0;
  const bearer = await ctx.s.roundTrips(() => ctx.s.h.handler(meRequest(sub.token)));
  await drain(bearer.value);
  const sib = await ctx.s.roundTrips(() => ctx.s.h.handler(meRequest(sub.sibling)));
  await drain(sib.value);
  const checks = [
    check("bearer refused after sign-out", bearer.value.status === 401, bearer.value.status),
    check(
      "bearer refusal needs no GoTrue call (fenced at edge)",
      gotrue(bearer.calls).length === 0,
      gotrue(bearer.calls).length,
    ),
    check("sibling token of the same session refused", sib.value.status === 401, sib.value.status),
    check(
      "sibling refusal needs no GoTrue call (session fence)",
      gotrue(sib.calls).length === 0,
      gotrue(sib.calls).length,
    ),
    check("other device still signed in (scope=local)", (await status(ctx, sub.other)) === 200),
  ];
  if (upstreamRevoked) checks.push(check("upstream session revoked", sub.session.revoked === true));
  return checks;
}

interface CaseResult {
  status: number;
  checks: Check[];
  roundTrips: number;
  upstream: string[];
}

interface FaultCase {
  id: string;
  upstream: "gotrue.user" | "gotrue.logout" | "request" | "lifecycle";
  title: string;
  run(ctx: Ctx): Promise<CaseResult>;
}

function trace(calls: UpstreamCall[]): string[] {
  return calls.map(
    (c) => `${c.target}:${c.outcome}${c.status !== undefined ? `:${c.status}` : ""}`,
  );
}

/** Cold or warm logout with `faults` installed for the logout request only. */
async function logoutUnder(
  ctx: Ctx,
  faults: Fault[],
  options: {
    warm?: boolean;
    provider?: "google" | "apple" | "email";
    headers?: Record<string, string>;
  } = {},
): Promise<{
  sub: Subject;
  res: Response;
  body: Record<string, unknown>;
  calls: UpstreamCall[];
  pre: Check[];
}> {
  const sub = subject(ctx, options.provider);
  const pre: Check[] = [];
  if (options.warm) pre.push(await warmUp(ctx, sub.token));
  ctx.s.faults.push(...faults);
  const { value: res, calls } = await ctx.s.roundTrips(() =>
    ctx.s.h.handler(logoutRequest(sub.token, undefined, options.headers)),
  );
  const body = res.status === 204 ? {} : await jsonBody(res);
  ctx.s.faults.length = 0;
  return { sub, res, body, calls, pre };
}

const roundTripBudget = (calls: UpstreamCall[]) =>
  check(
    "≤ 3 upstream round trips on the logout request",
    gotrue(calls).length <= 3,
    gotrue(calls).length,
  );

// ── Fault matrix ─────────────────────────────────────────────────────────────

const healthyUser = (id: string, provider = "google") => ({
  id,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider, providers: [provider] },
  user_metadata: {},
});

function userFailsCase(
  id: string,
  title: string,
  answer: () => Response | "throw" | "hang",
  extra: (res: Response, calls: UpstreamCall[]) => Check[] = () => [],
): FaultCase {
  return {
    id,
    upstream: "gotrue.user",
    title,
    async run(ctx) {
      const { sub, res, body, calls } = await logoutUnder(ctx, [always("user", answer)]);
      const checks = [
        ...generic503("Session verification", res, body),
        check(
          "Retry-After present",
          res.headers.get("retry-after") !== null,
          res.headers.get("retry-after"),
        ),
        check(
          "GoTrue logout NOT attempted",
          logoutCalls(calls).length === 0,
          logoutCalls(calls).length,
        ),
        ...extra(res, calls),
        ...(await stillSignedIn(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  };
}

function userRefusesCase(
  id: string,
  title: string,
  answer: () => Response,
  fragment: string,
): FaultCase {
  return {
    id,
    upstream: "gotrue.user",
    title,
    async run(ctx) {
      const { sub, res, body, calls } = await logoutUnder(ctx, [always("user", answer)]);
      const checks = [
        ...is401(res, body, fragment),
        check(
          "GoTrue logout NOT attempted",
          logoutCalls(calls).length === 0,
          logoutCalls(calls).length,
        ),
        check(
          "exactly one GoTrue verification",
          userCalls(calls).length === 1,
          userCalls(calls).length,
        ),
        ...(await stillSignedIn(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  };
}

function logoutFailsCase(id: string, title: string, answer: () => Response | "throw"): FaultCase {
  return {
    id,
    upstream: "gotrue.logout",
    title,
    async run(ctx) {
      const warm = ctx.prng.chance(0.5);
      const { sub, res, body, calls, pre } = await logoutUnder(ctx, [always("logout", answer)], {
        warm,
      });
      const checks = [
        ...pre,
        ...generic503("Sign-out", res, body),
        check(
          "exactly one GoTrue logout attempt",
          logoutCalls(calls).length === 1,
          logoutCalls(calls).length,
        ),
        roundTripBudget(calls),
        ...(await stillSignedIn(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  };
}

/** Upstream answers something the route treats as "already gone" (or a
 * success): the edge must fence the session and answer 204. `contractExpects503`
 * marks answers the documented contract says are NOT a completed sign-out. */
function logoutDoneCase(
  id: string,
  title: string,
  answer: () => Response,
  options: { contractExpects503?: boolean } = {},
): FaultCase {
  return {
    id,
    upstream: "gotrue.logout",
    title,
    async run(ctx) {
      const warm = ctx.prng.chance(0.5);
      const { sub, res, body, calls, pre } = await logoutUnder(ctx, [always("logout", answer)], {
        warm,
      });
      const checks: Check[] = [...pre, roundTripBudget(calls)];
      if (options.contractExpects503) {
        // Contract (auth_logout_test.ts / AGENTS.md): a sign-out Supabase Auth
        // could not PERFORM is a retryable 503 with nothing evicted.
        checks.push(...generic503("Sign-out", res, body));
        checks.push(
          check(
            "upstream session NOT revoked (answer was not a revocation)",
            sub.session.revoked === false,
          ),
        );
        ctx.s.faults.length = 0;
        checks.push(
          check(
            "bearer not fenced (sign-out did not happen upstream)",
            (await status(ctx, sub.token)) === 200,
          ),
        );
      } else {
        checks.push(check("status 204", res.status === 204, res.status));
        checks.push(check("empty body", (await drain(res)) === ""));
        checks.push(...(await signedOut(ctx, sub, false)));
      }
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  };
}

function requestCase(
  id: string,
  title: string,
  run: (ctx: Ctx) => Promise<CaseResult>,
  upstream: FaultCase["upstream"] = "request",
): FaultCase {
  return { id, upstream, title, run };
}

async function bareRequest(
  ctx: Ctx,
  request: Request,
): Promise<{ res: Response; body: Record<string, unknown>; calls: UpstreamCall[] }> {
  const { value: res, calls } = await ctx.s.roundTrips(() => ctx.s.h.handler(request));
  const body = res.status === 204 ? {} : await jsonBody(res);
  return { res, body, calls };
}

const bigHtml = () =>
  textAnswer(502, "<html><body><h1>502 Bad Gateway</h1>cloudflare</body></html>");

export const CASES: FaultCase[] = [
  // ── GoTrue GET /auth/v1/user (session verification, cold cache) ──────────
  userFailsCase("U01", "getUser 500 unexpected_failure", () =>
    gotrueError(500, "unexpected_failure", "boom"),
  ),
  userFailsCase("U02", "getUser 502 HTML gateway page", bigHtml),
  userFailsCase(
    "U03",
    "getUser 503 with Retry-After: 7 is relayed",
    () => jsonAnswer(503, { msg: "maintenance" }, { "Retry-After": "7" }),
    (res) => [
      check(
        "Retry-After relayed as 7",
        res.headers.get("retry-after") === "7",
        res.headers.get("retry-after"),
      ),
    ],
  ),
  userFailsCase("U04", "getUser 504 empty body", () => emptyAnswer(504)),
  userFailsCase(
    "U05",
    "getUser socket error on every attempt",
    () => "throw",
    (_res, calls) => [
      check(
        "connection retried ≥ 2 times inside the deadline",
        userCalls(calls).length >= 2,
        userCalls(calls).length,
      ),
    ],
  ),
  userFailsCase(
    "U06",
    "getUser hangs past AUTH_UPSTREAM_TIMEOUT_MS",
    () => "hang",
    (_res, calls) => [
      check(
        "single attempt aborted by deadline",
        userCalls(calls).length === 1 && calls.some((c) => c.outcome === "hung"),
      ),
    ],
  ),
  userFailsCase("U07", "getUser 200 non-JSON body", () => textAnswer(200, "<html>ok</html>")),
  userFailsCase("U08", "getUser 200 {} (no id)", () => jsonAnswer(200, {})),
  userFailsCase("U09", "getUser 200 [] (array)", () => jsonAnswer(200, [])),
  userFailsCase("U10", "getUser 204 empty", () => emptyAnswer(204)),
  userFailsCase(
    "U11",
    "getUser 429 rate limited (Retry-After: 30)",
    () => jsonAnswer(429, { msg: "over_request_rate_limit" }, { "Retry-After": "30" }),
    (res) => [
      check(
        "Retry-After relayed as 30",
        res.headers.get("retry-after") === "30",
        res.headers.get("retry-after"),
      ),
    ],
  ),
  userFailsCase("U12", "getUser 200 with id: 42 (non-string)", () => jsonAnswer(200, { id: 42 })),
  userFailsCase("U13", "getUser 200 with id: '' (empty)", () => jsonAnswer(200, { id: "" })),
  userRefusesCase(
    "U14",
    "getUser 401 bad_jwt → 401 no longer valid",
    () => gotrueError(401, "bad_jwt", "invalid JWT"),
    "no longer valid",
  ),
  userRefusesCase(
    "U15",
    "getUser 403 session_not_found → 401",
    () =>
      gotrueError(403, "session_not_found", "Session from session_id claim in JWT does not exist"),
    "no longer valid",
  ),
  userRefusesCase(
    "U16",
    "getUser 400 → 401",
    () => gotrueError(400, "bad_request", "bad"),
    "no longer valid",
  ),
  userRefusesCase(
    "U17",
    "getUser 200 for an email-provider user → 401 (not Google/Apple)",
    () => jsonAnswer(200, healthyUser(crypto.randomUUID(), "email")),
    "Google or Apple",
  ),
  {
    id: "U18",
    upstream: "gotrue.user",
    title: "getUser socket error ONCE then healthy → sign-out completes (retry inside deadline)",
    async run(ctx) {
      const { sub, res, calls } = await logoutUnder(ctx, [firstN("user", 1, () => "throw")]);
      const checks = [
        check("status 204", res.status === 204, res.status),
        check(
          "verification retried exactly once",
          userCalls(calls).length === 2,
          userCalls(calls).length,
        ),
        roundTripBudget(calls),
        ...(await signedOut(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  },
  {
    id: "U19",
    upstream: "gotrue.user",
    title: "getUser slow (150 ms, inside the deadline) → sign-out completes",
    async run(ctx) {
      const { sub, res, calls } = await logoutUnder(ctx, [
        { target: "user", answer: () => null, delayMs: 150 },
      ]);
      const checks = [
        check("status 204", res.status === 204, res.status),
        roundTripBudget(calls),
        ...(await signedOut(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  },
  {
    id: "U20",
    upstream: "gotrue.user",
    title: "getUser 200 with email: null and no user_metadata → sign-out completes",
    async run(ctx) {
      const sub = subject(ctx);
      ctx.s.faults.push(
        always("user", () =>
          jsonAnswer(200, { id: sub.userId, email: null, app_metadata: { provider: "google" } }),
        ),
      );
      const { value: res, calls } = await ctx.s.roundTrips(() =>
        ctx.s.h.handler(logoutRequest(sub.token)),
      );
      await drain(res);
      const checks = [
        check("status 204", res.status === 204, res.status),
        ...(await signedOut(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  },

  // ── GoTrue POST /auth/v1/logout ────────────────────────────────────────────
  logoutDoneCase("L01", "logout 204", () => emptyAnswer(204)),
  logoutDoneCase("L02", "logout 200 with JSON body", () => jsonAnswer(200, { ok: true })),
  logoutDoneCase("L03", "logout 401 (token already invalid) → treated as signed out", () =>
    gotrueError(401, "bad_jwt", "invalid JWT"),
  ),
  logoutDoneCase("L04", "logout 403 session_not_found → treated as signed out", () =>
    gotrueError(403, "session_not_found", "gone"),
  ),
  logoutDoneCase("L05", "logout 404 → treated as signed out", () =>
    gotrueError(404, "not_found", "gone"),
  ),
  logoutFailsCase("L06", "logout 500", () => gotrueError(500, "unexpected_failure", "boom")),
  logoutFailsCase("L07", "logout 502 HTML gateway page", bigHtml),
  logoutFailsCase("L08", "logout 503", () =>
    jsonAnswer(503, { msg: "maintenance" }, { "Retry-After": "5" }),
  ),
  logoutFailsCase("L09", "logout 504 empty", () => emptyAnswer(504)),
  logoutFailsCase("L10", "logout socket error", () => "throw"),
  {
    id: "L11",
    upstream: "gotrue.logout",
    title: "logout upstream HANGS → the route must still answer within a bounded time",
    async run(ctx) {
      const sub = subject(ctx);
      ctx.s.faults.push(always("logout", () => "hang"));
      const bound = AUTH_TIMEOUT_MS * 5;
      const from = ctx.s.upstream.length;
      const started = performance.now();
      const outcome = await bounded(ctx.s.h.handler(logoutRequest(sub.token)), bound);
      const elapsed = Math.round(performance.now() - started);
      const calls = ctx.s.upstream.slice(from);
      ctx.s.faults.length = 0;
      const checks: Check[] = [
        check(
          `answers within ${bound} ms (5× AUTH_UPSTREAM_TIMEOUT_MS)`,
          outcome.kind === "value",
          `${outcome.kind} after ${elapsed} ms`,
        ),
      ];
      let code = 0;
      if (outcome.kind === "value") {
        code = outcome.value.status;
        const body = code === 204 ? {} : await jsonBody(outcome.value);
        checks.push(...generic503("Sign-out", outcome.value, body));
      }
      checks.push(...(await stillSignedIn(ctx, sub)));
      return { status: code, checks, roundTrips: gotrue(calls).length, upstream: trace(calls) };
    },
  },
  logoutDoneCase(
    "L12",
    "logout 429 rate limited → contract: retryable 503, nothing evicted",
    () => jsonAnswer(429, { msg: "over_request_rate_limit" }),
    { contractExpects503: true },
  ),
  logoutDoneCase(
    "L13",
    "logout 400 → contract: retryable 503",
    () => gotrueError(400, "bad_request", "bad"),
    { contractExpects503: true },
  ),
  logoutDoneCase("L14", "logout 408 → contract: retryable 503", () => emptyAnswer(408), {
    contractExpects503: true,
  }),
  logoutDoneCase(
    "L15",
    "logout 422 → contract: retryable 503",
    () => gotrueError(422, "validation_failed", "scope"),
    { contractExpects503: true },
  ),
  logoutDoneCase(
    "L16",
    "logout 302 (gateway redirect page) → contract: retryable 503",
    () => textAnswer(302, "", "text/plain"),
    { contractExpects503: true },
  ),
  logoutDoneCase(
    "L17",
    "logout 204 whose body stream errors → still 204 (body cancel tolerated)",
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("stream reset (injected)"));
          },
        }),
        { status: 200 },
      ),
  ),
  logoutDoneCase("L18", "logout 200 with a 1 MiB body → 204 (body discarded)", () =>
    textAnswer(200, "x".repeat(1024 * 1024), "text/plain"),
  ),
  {
    id: "L19",
    upstream: "gotrue.logout",
    title: "logout slow (200 ms) but healthy → 204",
    async run(ctx) {
      const { sub, res, calls } = await logoutUnder(ctx, [
        { target: "logout", answer: () => null, delayMs: 200 },
      ]);
      const checks = [
        check("status 204", res.status === 204, res.status),
        roundTripBudget(calls),
        ...(await signedOut(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  },
  {
    id: "L20",
    upstream: "gotrue.logout",
    title:
      "logout 500 then client retries → first 503 leaves the bearer usable, retry 204 signs out",
    async run(ctx) {
      const sub = subject(ctx);
      ctx.s.faults.push(firstN("logout", 1, () => gotrueError(500, "unexpected_failure", "boom")));
      const first = await bareRequest(ctx, logoutRequest(sub.token));
      const between = await status(ctx, sub.token);
      const second = await bareRequest(ctx, logoutRequest(sub.token));
      ctx.s.faults.length = 0;
      const checks = [
        ...generic503("Sign-out", first.res, first.body),
        check("bearer usable between attempts", between === 200, between),
        check("retry is 204", second.res.status === 204, second.res.status),
        check(
          "retry needed no re-verification (cache row survived the 503)",
          userCalls(second.calls).length === 0,
          userCalls(second.calls).length,
        ),
        ...(await signedOut(ctx, sub)),
      ];
      return {
        status: second.res.status,
        checks,
        roundTrips: gotrue(second.calls).length,
        upstream: trace([...first.calls, ...second.calls]),
      };
    },
  },
  {
    id: "L21",
    upstream: "gotrue.logout",
    title: "logout socket error then client retries → 503 then 204",
    async run(ctx) {
      const sub = subject(ctx);
      ctx.s.faults.push(firstN("logout", 1, () => "throw"));
      const first = await bareRequest(ctx, logoutRequest(sub.token));
      const second = await bareRequest(ctx, logoutRequest(sub.token));
      ctx.s.faults.length = 0;
      const checks = [
        ...generic503("Sign-out", first.res, first.body),
        check("retry is 204", second.res.status === 204, second.res.status),
        ...(await signedOut(ctx, sub)),
      ];
      return {
        status: second.res.status,
        checks,
        roundTrips: gotrue(second.calls).length,
        upstream: trace([...first.calls, ...second.calls]),
      };
    },
  },
  {
    id: "L22",
    upstream: "gotrue.logout",
    title: "logout 5xx with a WARM cache: cached verification survives (no re-verify afterwards)",
    async run(ctx) {
      const { sub, res, body, calls, pre } = await logoutUnder(
        ctx,
        [always("logout", () => gotrueError(503, "x", "x"))],
        { warm: true },
      );
      const after = await ctx.s.roundTrips(() => ctx.s.h.handler(meRequest(sub.token)));
      await drain(after.value);
      const checks = [
        ...pre,
        ...generic503("Sign-out", res, body),
        check(
          "logout request itself needed 1 GoTrue call (cache hit)",
          gotrue(calls).length === 1,
          gotrue(calls).length,
        ),
        check("bearer works afterwards", after.value.status === 200, after.value.status),
        check(
          "… from cache (no GoTrue call)",
          gotrue(after.calls).length === 0,
          gotrue(after.calls).length,
        ),
        ...(await stillSignedIn(ctx, sub)),
      ];
      return {
        status: res.status,
        checks,
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  },

  // ── Request shape (no upstream fault) ─────────────────────────────────────
  requestCase("R01", "no Authorization header → 401 Missing bearer, no upstream", async (ctx) => {
    const { res, body, calls } = await bareRequest(ctx, logoutRequest(null));
    return {
      status: res.status,
      checks: [
        ...is401(res, body, "Missing bearer"),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R02", "'Bearer ' with nothing after it → 401", async (ctx) => {
    const { res, body, calls } = await bareRequest(
      ctx,
      logoutRequest(null, undefined, { Authorization: "Bearer " }),
    );
    return {
      status: res.status,
      checks: [
        ...is401(res, body, "Missing bearer"),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R03", "Basic auth scheme → 401", async (ctx) => {
    const { res, body, calls } = await bareRequest(
      ctx,
      logoutRequest(null, undefined, { Authorization: "Basic dXNlcjpwYXNz" }),
    );
    return {
      status: res.status,
      checks: [
        ...is401(res, body, "Missing bearer"),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase(
    "R04",
    "lowercase 'bearer' prefix → 401 (scheme is case-sensitive here)",
    async (ctx) => {
      const sub = subject(ctx);
      const { res, body, calls } = await bareRequest(
        ctx,
        logoutRequest(null, undefined, { Authorization: `bearer ${sub.token}` }),
      );
      return {
        status: res.status,
        checks: [
          ...is401(res, body, "Missing bearer"),
          check("no upstream", gotrue(calls).length === 0),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  ),
  requestCase("R05", "opaque non-JWT bearer → 401, no upstream", async (ctx) => {
    const { res, body, calls } = await bareRequest(
      ctx,
      logoutRequest("not-a-jwt-" + ctx.prng.hex(24)),
    );
    return {
      status: res.status,
      checks: [
        ...is401(res, body, "not a session token"),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R06", "two-segment JWT → 401", async (ctx) => {
    const [h, p] = sessionTokenLike({}).split(".");
    const { res, body, calls } = await bareRequest(ctx, logoutRequest(`${h}.${p}`));
    // decodeJwtPayload reads segment [1]; a 2-segment token still decodes: expect a
    // refusal from upstream (unknown session) or from shape — either way 401.
    return {
      status: res.status,
      checks: [
        check("status 401", res.status === 401, res.status),
        check("no logout upstream", logoutCalls(calls).length === 0),
        check("message present", errorMessageOf(body).length > 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R07", "JWT whose payload is not JSON → 401, no upstream", async (ctx) => {
    const { res, body, calls } = await bareRequest(
      ctx,
      logoutRequest("eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.sig"),
    );
    return {
      status: res.status,
      checks: [
        ...is401(res, body, "not a session token"),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R08", "expired session token → 401 expired, no upstream", async (ctx) => {
    const { res, body, calls } = await bareRequest(
      ctx,
      logoutRequest(sessionTokenLike({ exp: Math.floor(Date.now() / 1000) - 5 })),
    );
    return {
      status: res.status,
      checks: [...is401(res, body, "expired"), check("no upstream", gotrue(calls).length === 0)],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R09", "foreign issuer → 401, no upstream", async (ctx) => {
    const { res, body, calls } = await bareRequest(
      ctx,
      logoutRequest(sessionTokenLike({ iss: "https://evil.example/auth/v2" })),
    );
    return {
      status: res.status,
      checks: [
        ...is401(res, body, "not a session token"),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase(
    "R10",
    "session token WITHOUT session_id claim: 204, own bearer dropped, upstream revoked",
    async (ctx) => {
      // GoTrue always stamps session_id; the route must still work if it is absent.
      const { userId } = mintUser(ctx.s, ctx.prng);
      const token = sessionTokenLike({ session_id: undefined }, userId);
      const session = {
        userId,
        accessToken: token,
        refreshToken: "rt-x",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        revoked: false,
      };
      ctx.s.h.sessions.set(token, session);
      const warm = await warmUp(ctx, token);
      const { res, calls } = await bareRequest(ctx, logoutRequest(token));
      const after = await status(ctx, token);
      return {
        status: res.status,
        checks: [
          warm,
          check("status 204", res.status === 204, res.status),
          check("upstream revoked", session.revoked),
          check("bearer refused afterwards", after === 401, after),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  ),
  requestCase("R11", "garbage JSON body is ignored → 204", async (ctx) => {
    const sub = subject(ctx);
    const req = new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sub.token}`,
        "Content-Type": "application/json",
        "x-forwarded-for": freshIp(),
      },
      body: "{not json",
    });
    const { res, calls } = await bareRequest(ctx, req);
    return {
      status: res.status,
      checks: [check("status 204", res.status === 204, res.status), ...(await signedOut(ctx, sub))],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R12", "Content-Length above the 5 MB cap → 413 before any upstream", async (ctx) => {
    const sub = subject(ctx);
    const req = new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sub.token}`,
        "Content-Length": "6000000",
        "x-forwarded-for": freshIp(),
      },
    });
    const declared = req.headers.get("content-length");
    const { res, calls } = await bareRequest(ctx, req);
    return {
      status: res.status,
      checks: [
        check("Content-Length header reached the handler", declared === "6000000", declared),
        check("status 413", res.status === 413, res.status),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase(
    "R13",
    "GET /v1/auth/logout with a valid bearer → 404 (method not routed), session intact",
    async (ctx) => {
      const sub = subject(ctx);
      const { res, calls } = await bareRequest(
        ctx,
        apiRequest("GET", "/v1/auth/logout", { token: sub.token }),
      );
      return {
        status: res.status,
        checks: [
          check("status 404", res.status === 404, res.status),
          check("no logout upstream", logoutCalls(calls).length === 0),
          ...(await stillSignedIn(ctx, sub)),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  ),
  requestCase("R14", "64 KiB bearer → 401 promptly, no upstream", async (ctx) => {
    const started = performance.now();
    const { res, calls } = await bareRequest(ctx, logoutRequest("A".repeat(64 * 1024)));
    const ms = performance.now() - started;
    return {
      status: res.status,
      checks: [
        check("status 401", res.status === 401, res.status),
        check("answered < 200 ms", ms < 200, Math.round(ms)),
        check("no upstream", gotrue(calls).length === 0),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase(
    "R15",
    "exp claim as a string is not 'expired' → verified upstream → unknown session → 401",
    async (ctx) => {
      const { res, calls } = await bareRequest(
        ctx,
        logoutRequest(sessionTokenLike({ exp: String(Math.floor(Date.now() / 1000) - 5) })),
      );
      return {
        status: res.status,
        checks: [
          check("status 401", res.status === 401, res.status),
          check("no logout upstream", logoutCalls(calls).length === 0),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  ),
  requestCase(
    "R16",
    "transitional Google ID-token bearer: 204, and the ID token remains a valid credential",
    async (ctx) => {
      const idToken = googleIdToken();
      const warm = await warmUp(ctx, idToken);
      const { res, calls } = await bareRequest(ctx, logoutRequest(idToken));
      const after = await ctx.s.roundTrips(() => ctx.s.h.handler(meRequest(idToken)));
      await drain(after.value);
      return {
        status: res.status,
        checks: [
          warm,
          check("status 204", res.status === 204, res.status),
          check(
            "upstream logout attempted with the ID token (answers 401 = gone)",
            logoutCalls(calls).length === 1,
          ),
          // By design (authenticate() comment): a provider token's session lives only in
          // the cache row, so logout drops that row and the token re-exchanges on next use.
          check(
            "ID token still authenticates afterwards (re-exchanged)",
            after.value.status === 200,
            after.value.status,
          ),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  ),
  requestCase("R17", "x-request-id is echoed on the 204", async (ctx) => {
    const sub = subject(ctx);
    const rid = `stress-${ctx.prng.hex(16)}`;
    const { res, calls } = await bareRequest(
      ctx,
      logoutRequest(sub.token, undefined, { "x-request-id": rid }),
    );
    return {
      status: res.status,
      checks: [
        check("status 204", res.status === 204, res.status),
        check(
          "request id echoed",
          res.headers.get("x-request-id") === rid,
          res.headers.get("x-request-id"),
        ),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase("R18", "Apple-provider session → 204 and fenced", async (ctx) => {
    const { sub, res, calls } = await logoutUnder(ctx, [], {
      provider: "apple",
      warm: ctx.prng.chance(0.5),
    });
    return {
      status: res.status,
      checks: [
        check("status 204", res.status === 204, res.status),
        roundTripBudget(calls),
        ...(await signedOut(ctx, sub)),
      ],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),
  requestCase(
    "R19",
    "email-provider session (not Google/Apple) → 401, no logout upstream",
    async (ctx) => {
      const { sub, res, body, calls } = await logoutUnder(ctx, [], { provider: "email" });
      return {
        status: res.status,
        checks: [
          ...is401(res, body, "Google or Apple"),
          check("no logout upstream", logoutCalls(calls).length === 0),
          check("upstream not revoked", !sub.session.revoked),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
  ),
  requestCase("R20", "bearer with trailing whitespace is trimmed → 204", async (ctx) => {
    const sub = subject(ctx);
    const { res, calls } = await bareRequest(
      ctx,
      logoutRequest(null, undefined, { Authorization: `Bearer ${sub.token}   ` }),
    );
    return {
      status: res.status,
      checks: [check("status 204", res.status === 204, res.status), ...(await signedOut(ctx, sub))],
      roundTrips: gotrue(calls).length,
      upstream: trace(calls),
    };
  }),

  // ── Lifecycle / idempotency ───────────────────────────────────────────────
  requestCase(
    "I01",
    "duplicate logout: 204 then 401, second delivery never reaches GoTrue",
    async (ctx) => {
      const sub = subject(ctx);
      const first = await bareRequest(ctx, logoutRequest(sub.token));
      const second = await bareRequest(ctx, logoutRequest(sub.token));
      return {
        status: second.res.status,
        checks: [
          check("first 204", first.res.status === 204, first.res.status),
          check("second 401", second.res.status === 401, second.res.status),
          check(
            "second: no GoTrue call (edge fence)",
            gotrue(second.calls).length === 0,
            gotrue(second.calls).length,
          ),
          ...(await signedOut(ctx, sub)),
        ],
        roundTrips: gotrue(first.calls).length,
        upstream: trace([...first.calls, ...second.calls]),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I02",
    "N concurrent logouts of one bearer: all 204/401, never 5xx, ≤ N GoTrue logouts, dead afterwards",
    async (ctx) => {
      const sub = subject(ctx);
      const n = ctx.prng.int(3, 8);
      if (ctx.prng.chance(0.5)) await warmUp(ctx, sub.token);
      const from = ctx.s.upstream.length;
      const responses = await Promise.all(
        Array.from({ length: n }, () => ctx.s.h.handler(logoutRequest(sub.token))),
      );
      const calls = ctx.s.upstream.slice(from);
      const statuses = responses.map((r) => r.status);
      await Promise.all(responses.map(drain));
      return {
        status: Math.max(...statuses),
        checks: [
          check(
            "every answer ∈ {204, 401}",
            statuses.every((c) => c === 204 || c === 401),
            statuses,
          ),
          check("at least one 204", statuses.includes(204), statuses),
          check(
            `≤ ${n} GoTrue logout calls`,
            logoutCalls(calls).length <= n,
            logoutCalls(calls).length,
          ),
          check(
            "≤ n GoTrue verifications (concurrent misses are not coalesced)",
            userCalls(calls).length <= n,
            userCalls(calls).length,
          ),
          ...(await signedOut(ctx, sub)),
        ],
        roundTrips: Math.ceil(gotrue(calls).length / n),
        upstream: trace(calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I03",
    "WARM sibling token: cached verification does not survive the session fence",
    async (ctx) => {
      const sub = subject(ctx);
      const w1 = await warmUp(ctx, sub.sibling);
      const w2 = await warmUp(ctx, sub.token);
      const { res, calls } = await bareRequest(ctx, logoutRequest(sub.token));
      return {
        status: res.status,
        checks: [
          w1,
          w2,
          check("status 204", res.status === 204, res.status),
          check(
            "logout needed exactly 1 GoTrue call",
            gotrue(calls).length === 1,
            gotrue(calls).length,
          ),
          ...(await signedOut(ctx, sub)),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I04",
    "logout lands while the sibling's verification is in flight (GoTrue said 200 pre-logout) → sibling refused, never cached",
    async (ctx) => {
      const sub = subject(ctx);
      // The sibling's getUser answers 200 (session alive when GoTrue looked) but the
      // bytes arrive 60 ms later — after the logout completed.
      ctx.s.faults.push({
        target: "user",
        when: ({ request }) => request.headers.get("authorization") === `Bearer ${sub.sibling}`,
        answer: () => jsonAnswer(200, healthyUser(sub.userId)),
        delayMs: 60,
      });
      const inflight = ctx.s.h.handler(meRequest(sub.sibling));
      await sleep(5);
      const logout = await bareRequest(ctx, logoutRequest(sub.token));
      const raced = await inflight;
      await drain(raced);
      ctx.s.faults.length = 0;
      const again = await ctx.s.roundTrips(() => ctx.s.h.handler(meRequest(sub.sibling)));
      await drain(again.value);
      return {
        status: logout.res.status,
        checks: [
          check("logout 204", logout.res.status === 204, logout.res.status),
          check("raced sibling verification refused (401)", raced.status === 401, raced.status),
          check(
            "sibling refused again without GoTrue (not re-cached)",
            again.value.status === 401 && gotrue(again.calls).length === 0,
            `${again.value.status}/${gotrue(again.calls).length}`,
          ),
          check("other device untouched", (await status(ctx, sub.other)) === 200),
        ],
        roundTrips: gotrue(logout.calls).length,
        upstream: trace(logout.calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I05",
    "refresh token of the logged-out session is refused (401) afterwards",
    async (ctx) => {
      const sub = subject(ctx);
      const rt = sub.session.refreshToken;
      const { res, calls } = await bareRequest(ctx, logoutRequest(sub.token));
      const refresh = await ctx.s.h.handler(
        apiRequest("POST", "/v1/auth/refresh", { token: null, body: { refreshToken: rt } }),
      );
      await drain(refresh);
      return {
        status: res.status,
        checks: [
          check("logout 204", res.status === 204, res.status),
          check("refresh refused 401", refresh.status === 401, refresh.status),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I06",
    "logout after the bearer's own exp passed → 401 expired, GoTrue never consulted",
    async (ctx) => {
      const sub = subject(ctx);
      const out = await withClockOffset(2 * 3600 * 1000, () =>
        bareRequest(ctx, logoutRequest(sub.token)),
      );
      return {
        status: out.res.status,
        checks: [
          ...is401(out.res, out.body, "expired"),
          check("no upstream", gotrue(out.calls).length === 0),
        ],
        roundTrips: gotrue(out.calls).length,
        upstream: trace(out.calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I07",
    "logout of user A never affects user B (cold and warm)",
    async (ctx) => {
      const a = subject(ctx);
      const b = subject(ctx);
      if (ctx.prng.chance(0.5)) await warmUp(ctx, b.token);
      const { res, calls } = await bareRequest(ctx, logoutRequest(a.token));
      return {
        status: res.status,
        checks: [
          check("A 204", res.status === 204, res.status),
          check("B still 200", (await status(ctx, b.token)) === 200),
          check("B sibling still 200", (await status(ctx, b.sibling)) === 200),
          ...(await signedOut(ctx, a)),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I08",
    "30 duplicate logouts of a dead bearer from one IP trip the auth-failure budget (429) for that IP",
    async (ctx) => {
      const sub = subject(ctx);
      const ip = freshIp();
      const first = await bareRequest(ctx, logoutRequest(sub.token, ip));
      const statuses: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const r = await ctx.s.h.handler(logoutRequest(sub.token, ip));
        await drain(r);
        statuses.push(r.status);
      }
      const fresh = subject(ctx);
      const blocked = await ctx.s.h.handler(logoutRequest(fresh.token, ip));
      await drain(blocked);
      const elsewhere = await status(ctx, fresh.token);
      return {
        status: blocked.status,
        checks: [
          check("first 204", first.res.status === 204, first.res.status),
          check(
            "duplicates all 401 (never 5xx)",
            statuses.every((c) => c === 401),
            histogram(statuses),
          ),
          // Documented budget: 30 auth failures / 5 min per IP. This pins that
          // duplicate deliveries COUNT (they are 401s) — a proxy replaying a
          // sign-out 30× locks every user behind that IP out for 5 minutes.
          check(
            "31st request from that IP is 429 (auth-failure budget)",
            blocked.status === 429,
            blocked.status,
          ),
          check("same user from another IP unaffected", elsewhere === 200, elsewhere),
        ],
        roundTrips: gotrue(first.calls).length,
        upstream: trace(first.calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I09",
    "logout then bootstrap-shaped reuse: a NEW session of the same user is unaffected by the old fence",
    async (ctx) => {
      const sub = subject(ctx);
      const { res, calls } = await bareRequest(ctx, logoutRequest(sub.token));
      const fresh = ctx.s.h.mintSession(sub.userId, 3600);
      const after = await status(ctx, fresh.accessToken);
      return {
        status: res.status,
        checks: [
          check("204", res.status === 204, res.status),
          check("new session 200", after === 200, after),
        ],
        roundTrips: gotrue(calls).length,
        upstream: trace(calls),
      };
    },
    "lifecycle",
  ),
  requestCase(
    "I10",
    "concurrent logout + sibling GET burst: no 5xx, sibling is 200 only BEFORE the logout completed",
    async (ctx) => {
      const sub = subject(ctx);
      await warmUp(ctx, sub.sibling);
      const n = ctx.prng.int(4, 10);
      let logoutDoneAt = Infinity;
      const lanes: Array<
        Promise<{ kind: string; status: number; endedAt: number; startedAt: number }>
      > = [];
      for (let i = 0; i < n; i += 1) {
        lanes.push(
          (async () => {
            await sleep(ctx.prng.int(0, 8));
            const startedAt = performance.now();
            const r = await ctx.s.h.handler(meRequest(sub.sibling));
            await drain(r);
            return { kind: "sibling", status: r.status, startedAt, endedAt: performance.now() };
          })(),
        );
      }
      lanes.push(
        (async () => {
          await sleep(ctx.prng.int(0, 4));
          const startedAt = performance.now();
          const r = await ctx.s.h.handler(logoutRequest(sub.token));
          await drain(r);
          logoutDoneAt = performance.now();
          return { kind: "logout", status: r.status, startedAt, endedAt: logoutDoneAt };
        })(),
      );
      const rows = await Promise.all(lanes);
      const siblings = rows.filter((r) => r.kind === "sibling");
      const late200 = siblings.filter((r) => r.startedAt > logoutDoneAt && r.status === 200).length;
      return {
        status: rows.find((r) => r.kind === "logout")!.status,
        checks: [
          check("logout 204", rows.find((r) => r.kind === "logout")!.status === 204),
          check(
            "no 5xx",
            rows.every((r) => r.status < 500),
            histogram(rows.map((r) => r.status)),
          ),
          check("no sibling 200 after the logout completed", late200 === 0, late200),
          ...(await signedOut(ctx, sub)),
        ],
        roundTrips: 0,
        upstream: [],
      };
    },
    "lifecycle",
  ),
];

// ── Runner ───────────────────────────────────────────────────────────────────

async function runMatrix(iteration: number): Promise<CaseOutcome[]> {
  const seed = STRESS_SEED + iteration;
  const s = await loadStressHarness();
  const prng = new Prng(seed);
  const rows: CaseOutcome[] = [];
  for (const c of prng.shuffle(CASES)) {
    s.faults.length = 0;
    const ctx: Ctx = {
      s,
      prng: new Prng(
        (seed * 1000 + Number.parseInt(c.id.slice(1), 10) * 7 + c.id.charCodeAt(0)) >>> 0,
      ),
      seed,
    };
    let result: CaseResult;
    try {
      result = await c.run(ctx);
    } catch (error) {
      result = {
        status: 0,
        checks: [
          check("case threw", false, error instanceof Error ? error.message : String(error)),
        ],
        roundTrips: 0,
        upstream: [],
      };
    }
    s.faults.length = 0;
    const v = verdict(result.checks);
    rows.push({
      seed,
      case: c.id,
      verdict: v.held ? "HELD" : "BROKEN",
      status: result.status,
      roundTrips: result.roundTrips,
      detail: `${c.title} — ${v.detail}`,
      replay: replayCommand(FILE, "stress matrix", seed),
    });
  }
  return rows;
}

stressTest(
  `stress matrix: ${CASES.length} fault cases × STRESS_ITER=${STRESS_ITER} seeded iterations`,
  async () => {
    assert(CASES.length >= 40, `matrix has ${CASES.length} cases (need ≥ 40)`);
    const rows: CaseOutcome[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) rows.push(...(await runMatrix(i)));
    const broken = rows.filter((r) => r.verdict === "BROKEN");
    const byCase: Record<string, { held: number; broken: number }> = {};
    for (const r of rows) {
      byCase[r.case] ??= { held: 0, broken: 0 };
      byCase[r.case][r.verdict === "HELD" ? "held" : "broken"] += 1;
    }
    const path = await writeReport("matrix", {
      file: FILE,
      seedBase: STRESS_SEED,
      iterations: STRESS_ITER,
      cases: CASES.length,
      executed: rows.length,
      held: rows.length - broken.length,
      broken: broken.length,
      byCase,
      maxRoundTrips: Math.max(...rows.map((r) => r.roundTrips)),
      rows,
    });
    console.log(`[stress] matrix: ${rows.length} executed, ${broken.length} BROKEN → ${path}`);
    for (const r of broken)
      console.log(`[stress]   BROKEN seed=${r.seed} case=${r.case}: ${r.detail}`);
    // Known contract gaps are reported as findings (see the JSON table), not as
    // suite failures: the suite fails only on cases the route is EXPECTED to pass.
    const KNOWN_GAPS = new Set(["L11", "L12", "L13", "L14", "L15", "L16"]);
    const unexpected = broken.filter((r) => !KNOWN_GAPS.has(r.case));
    assertEquals(
      unexpected.map((r) => `${r.seed}/${r.case}: ${r.detail}`),
      [],
      "unexpected BROKEN cases",
    );
  },
);

// ── Chaos: random fault combinations vs the contract oracle ──────────────────

type UserFault = "none" | "5xx" | "throw" | "hang" | "malformed" | "refused";
type LogoutFault = "none" | "2xx" | "gone4xx" | "5xx" | "throw" | "other4xx";

function userFaultAnswer(kind: UserFault, prng: Prng): Fault | null {
  switch (kind) {
    case "none":
      return null;
    case "5xx":
      return always("user", () =>
        gotrueError(prng.pick([500, 502, 503, 504]), "unexpected_failure", "x"),
      );
    case "throw":
      return always("user", () => "throw");
    case "hang":
      return always("user", () => "hang");
    case "malformed":
      return always("user", () =>
        prng.pick([
          () => textAnswer(200, "<html/>"),
          () => jsonAnswer(200, {}),
          () => emptyAnswer(204),
          () => jsonAnswer(200, [1]),
        ])(),
      );
    case "refused":
      return always("user", () => gotrueError(prng.pick([400, 401, 403]), "bad_jwt", "x"));
  }
}

function logoutFaultAnswer(kind: LogoutFault, prng: Prng): Fault | null {
  switch (kind) {
    case "none":
      return null;
    case "2xx":
      return always("logout", () =>
        prng.pick([
          () => emptyAnswer(204),
          () => jsonAnswer(200, {}),
          () => textAnswer(200, "ok", "text/plain"),
        ])(),
      );
    case "gone4xx":
      return always("logout", () =>
        gotrueError(prng.pick([401, 403, 404]), "session_not_found", "x"),
      );
    case "5xx":
      return always("logout", () =>
        gotrueError(prng.pick([500, 502, 503, 504]), "unexpected_failure", "x"),
      );
    case "throw":
      return always("logout", () => "throw");
    case "other4xx":
      return always("logout", () => gotrueError(prng.pick([400, 408, 409, 422, 429]), "x", "x"));
  }
}

stressTest(
  `stress chaos: STRESS_CHAOS=${STRESS_CHAOS} × STRESS_ITER=${STRESS_ITER} random fault combinations vs contract oracle`,
  async () => {
    const s = await loadStressHarness();
    const rows: Array<
      CaseOutcome & { userFault: UserFault; logoutFault: LogoutFault; warm: boolean }
    > = [];
    const userFaults: UserFault[] = [
      "none",
      "none",
      "5xx",
      "throw",
      "hang",
      "malformed",
      "refused",
    ];
    const logoutFaults: LogoutFault[] = [
      "none",
      "none",
      "2xx",
      "gone4xx",
      "5xx",
      "throw",
      "other4xx",
    ];
    for (let it = 0; it < STRESS_ITER; it += 1) {
      for (let k = 0; k < STRESS_CHAOS; k += 1) {
        const seed = (STRESS_SEED + it) * 100_000 + k;
        const prng = new Prng(seed);
        const ctx: Ctx = { s, prng, seed };
        const warm = prng.chance(0.5);
        const userFault = prng.pick(userFaults);
        const logoutFault = prng.pick(logoutFaults);
        const sub = subject(ctx);
        const checks: Check[] = [];
        if (warm) checks.push(await warmUp(ctx, sub.token));
        s.faults.length = 0;
        const uf = userFaultAnswer(userFault, prng);
        const lf = logoutFaultAnswer(logoutFault, prng);
        if (uf) s.faults.push(uf);
        if (lf) s.faults.push(lf);
        const { value: res, calls } = await s.roundTrips(() =>
          s.h.handler(logoutRequest(sub.token)),
        );
        const body = res.status === 204 ? {} : await jsonBody(res);
        s.faults.length = 0;
        checks.push(roundTripBudget(calls));
        const verificationFaulted = !warm && userFault !== "none";
        if (verificationFaulted) {
          checks.push(
            check(
              "logout not attempted upstream",
              logoutCalls(calls).length === 0,
              logoutCalls(calls).length,
            ),
          );
          if (userFault === "refused") checks.push(...is401(res, body, "no longer valid"));
          else checks.push(...generic503("Session verification", res, body));
          checks.push(...(await stillSignedIn(ctx, sub)));
        } else if (logoutFault === "none" || logoutFault === "2xx" || logoutFault === "gone4xx") {
          checks.push(check("status 204", res.status === 204, res.status));
          checks.push(...(await signedOut(ctx, sub, logoutFault === "none")));
        } else {
          checks.push(...generic503("Sign-out", res, body));
          checks.push(...(await stillSignedIn(ctx, sub)));
        }
        const v = verdict(checks);
        rows.push({
          seed,
          case: `chaos(${userFault}/${logoutFault}/${warm ? "warm" : "cold"})`,
          userFault,
          logoutFault,
          warm,
          verdict: v.held ? "HELD" : "BROKEN",
          status: res.status,
          roundTrips: gotrue(calls).length,
          detail: v.detail,
          replay: `STRESS_SEED=${STRESS_SEED + it} STRESS_CHAOS=${STRESS_CHAOS} STRESS_ITER=1 deno test -A --no-check --config deno.json ${FILE} --filter "stress chaos"  # row k=${k}`,
        });
      }
    }
    const broken = rows.filter((r) => r.verdict === "BROKEN");
    const path = await writeReport("chaos", {
      file: FILE,
      executed: rows.length,
      held: rows.length - broken.length,
      broken: broken.length,
      brokenByCombination: histogram(broken.map((r) => `${r.userFault}/${r.logoutFault}`)),
      statusHistogram: histogram(rows.map((r) => r.status)),
      roundTripHistogram: histogram(rows.map((r) => r.roundTrips)),
      rows,
    });
    console.log(`[stress] chaos: ${rows.length} executed, ${broken.length} BROKEN → ${path}`);
    // The one known contract gap (see matrix L12–L16): a non-revocation 4xx from
    // GoTrue's logout is treated as a completed sign-out.
    const unexpected = broken.filter(
      (r) => !(r.logoutFault === "other4xx" && !(r.userFault !== "none" && !r.warm)),
    );
    assertEquals(
      unexpected.map((r) => `${r.seed}: ${r.case} ${r.detail}`),
      [],
      "unexpected BROKEN chaos rows",
    );
  },
);

// ── Load: N logouts, p50/p95 latency, GoTrue round trips per request ─────────

stressTest(
  `stress load: STRESS_LOAD=${STRESS_LOAD} sequential logouts + concurrent bursts`,
  async () => {
    const s = await loadStressHarness();
    const prng = new Prng(STRESS_SEED ^ 0x10ad);
    const ctx: Ctx = { s, prng, seed: STRESS_SEED };
    const rows: Array<{
      i: number;
      warm: boolean;
      status: number;
      ms: number;
      gotrue: number;
      user: number;
      logout: number;
    }> = [];
    for (let i = 0; i < STRESS_LOAD; i += 1) {
      const { session } = mintUser(s, prng);
      const warm = prng.chance(0.5);
      if (warm) {
        const r = await s.h.handler(meRequest(session.accessToken));
        await drain(r);
      }
      const started = performance.now();
      const { value: res, calls } = await s.roundTrips(() =>
        s.h.handler(logoutRequest(session.accessToken)),
      );
      const ms = performance.now() - started;
      await drain(res);
      rows.push({
        i,
        warm,
        status: res.status,
        ms: Math.round(ms * 1000) / 1000,
        gotrue: gotrue(calls).length,
        user: userCalls(calls).length,
        logout: logoutCalls(calls).length,
      });
      if (i % 200 === 199) {
        s.h.calls.length = 0;
        s.resetUpstream();
      }
    }
    const lat = (subset: typeof rows) => {
      const sorted = subset.map((r) => r.ms).sort((a, b) => a - b);
      return {
        n: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted.at(-1) ?? NaN,
      };
    };
    const cold = rows.filter((r) => !r.warm);
    const warm = rows.filter((r) => r.warm);

    // Concurrent bursts: B in flight at once (distinct users), latency per request.
    const burstSize = Math.min(50, STRESS_LOAD);
    const bursts = Math.max(1, Math.floor(STRESS_LOAD / burstSize / 4));
    const burstRows: Array<{ status: number; ms: number }> = [];
    let burstCalls = 0;
    for (let b = 0; b < bursts; b += 1) {
      const sessions = Array.from({ length: burstSize }, () => mintUser(s, prng).session);
      const from = s.upstream.length;
      const results = await Promise.all(
        sessions.map(async (session) => {
          const started = performance.now();
          const r = await s.h.handler(logoutRequest(session.accessToken));
          await drain(r);
          return { status: r.status, ms: performance.now() - started };
        }),
      );
      burstCalls += gotrue(s.upstream.slice(from)).length;
      burstRows.push(...results);
    }
    const burstSorted = burstRows.map((r) => r.ms).sort((a, b) => a - b);

    const report = {
      file: FILE,
      seed: STRESS_SEED,
      note: "In-process handler latency with zero-latency upstream fakes (no network): measures the function's own work per sign-out, not production wire time.",
      sequential: {
        executed: rows.length,
        statusHistogram: histogram(rows.map((r) => r.status)),
        roundTripsPerRequest: histogram(rows.map((r) => r.gotrue)),
        cold: { ...lat(cold), roundTrips: histogram(cold.map((r) => r.gotrue)) },
        warm: { ...lat(warm), roundTrips: histogram(warm.map((r) => r.gotrue)) },
        all: lat(rows),
      },
      concurrent: {
        bursts,
        burstSize,
        executed: burstRows.length,
        statusHistogram: histogram(burstRows.map((r) => r.status)),
        p50: percentile(burstSorted, 50),
        p95: percentile(burstSorted, 95),
        max: burstSorted.at(-1),
        gotrueCallsPerRequest: burstRows.length ? burstCalls / burstRows.length : NaN,
      },
      heap: Deno.memoryUsage(),
    };
    const path = await writeReport("load", report);
    console.log(
      `[stress] load: ${rows.length}+${burstRows.length} logouts; cold p50=${report.sequential.cold.p50}ms p95=${report.sequential.cold.p95}ms; warm p50=${report.sequential.warm.p50}ms p95=${report.sequential.warm.p95}ms; concurrent p95=${report.concurrent.p95}ms → ${path}`,
    );
    assert(
      rows.every((r) => r.status === 204),
      `every sequential logout is 204: ${JSON.stringify(report.sequential.statusHistogram)}`,
    );
    assert(
      burstRows.every((r) => r.status === 204),
      `every concurrent logout is 204: ${JSON.stringify(report.concurrent.statusHistogram)}`,
    );
    assert(
      cold.every((r) => r.gotrue === 2 && r.user === 1 && r.logout === 1),
      "cold sign-out = exactly 2 GoTrue round trips (verify + logout)",
    );
    assert(
      warm.every((r) => r.gotrue === 1 && r.user === 0 && r.logout === 1),
      "warm sign-out = exactly 1 GoTrue round trip (logout only)",
    );
    assert(Math.max(...rows.map((r) => r.gotrue)) <= 3, "hot path never exceeds 3 round trips");
    void ctx;
  },
);

// ── Memory: M distinct users verify + sign out; L1 cache must stay bounded ───

stressTest(
  `stress memory: STRESS_USERS=${STRESS_USERS} distinct users verify+logout (L1 cache bound, rate-limit windows)`,
  async () => {
    const s = await loadStressHarness();
    const prng = new Prng(STRESS_SEED ^ 0x3e3);
    const gc = (globalThis as { gc?: () => void }).gc;
    const sample = (label: string) => {
      gc?.();
      const m = Deno.memoryUsage();
      return {
        label,
        heapUsedMB: Math.round((m.heapUsed / 1048576) * 100) / 100,
        rssMB: Math.round((m.rss / 1048576) * 100) / 100,
        fakeSessions: s.h.sessions.size,
      };
    };
    const samples = [sample("start")];

    // A heavy user at the general budget: 240 GET /v1/me → 241st is 429.
    const heavy = mintUser(s, prng).session.accessToken;
    const heavyIp = freshIp();
    let heavyBefore = 0;
    for (let i = 0; i < 241; i += 1) {
      const r = await s.h.handler(meRequest(heavy, heavyIp));
      await drain(r);
      heavyBefore = r.status;
    }

    const first = mintUser(s, prng).session;
    const firstSibling = siblingToken(s, first);
    const statuses: number[] = [];
    const step = Math.max(1, Math.floor(STRESS_USERS / 4));
    const started = performance.now();
    for (let i = 0; i < STRESS_USERS; i += 1) {
      const session = i === 0 ? first : mintUser(s, prng).session;
      const me = await s.h.handler(meRequest(session.accessToken));
      await drain(me);
      const out = await s.h.handler(logoutRequest(session.accessToken));
      await drain(out);
      statuses.push(me.status, out.status);
      if ((i + 1) % step === 0) {
        s.h.calls.length = 0;
        s.resetUpstream();
        samples.push(sample(`${i + 1} users`));
      }
    }
    const elapsedMs = Math.round(performance.now() - started);
    s.h.calls.length = 0;
    s.resetUpstream();
    samples.push(sample("end (fake sessions retained)"));

    // Edge-side state only: drop the fake's own bookkeeping and measure again.
    const retainedFake = s.h.sessions.size;
    const keepTokens = new Set([heavy, first.accessToken, firstSibling.accessToken]);
    for (const key of [...s.h.sessions.keys()]) if (!keepTokens.has(key)) s.h.sessions.delete(key);
    for (const key of [...s.h.refreshTokens.keys()]) {
      const entry = s.h.refreshTokens.get(key);
      if (entry && !keepTokens.has(entry.sessionAccessToken)) s.h.refreshTokens.delete(key);
    }
    samples.push(sample("end (fake sessions dropped → edge L1 + rate windows only)"));

    const heavyAfter = await s.h.handler(meRequest(heavy, heavyIp));
    await drain(heavyAfter);
    const firstSiblingAfter = await s.roundTrips(() =>
      s.h.handler(meRequest(firstSibling.accessToken)),
    );
    await drain(firstSiblingAfter.value);

    const report = {
      file: FILE,
      seed: STRESS_SEED,
      users: STRESS_USERS,
      requests: statuses.length,
      elapsedMs,
      statusHistogram: histogram(statuses),
      gcExposed: Boolean(gc),
      samples,
      retainedFakeSessionsBeforeDrop: retainedFake,
      heavyUser: {
        note: "GENERAL_USER_LIMIT 240/60s; per-isolate windows map is cleared when it reaches 20 000 keys (rateLimit.ts MEMORY_WINDOW_MAX), which forgets every in-window count.",
        statusAt241Before: heavyBefore,
        statusAfterCampaign: heavyAfter.status,
        windowForgotten: heavyBefore === 429 && heavyAfter.status === 200,
      },
      firstUserSiblingAfterCampaign: {
        status: firstSiblingAfter.value.status,
        gotrueCalls: gotrue(firstSiblingAfter.calls).length,
        note: "401 via the L1 marker needs 0 GoTrue calls; once the marker was evicted (L1 cap 5 000) the refusal comes from GoTrue (1 call).",
      },
    };
    const path = await writeReport("memory", report);
    console.log(
      `[stress] memory: ${STRESS_USERS} users / ${statuses.length} requests in ${elapsedMs} ms; heap ${samples[0].heapUsedMB}→${samples.at(-1)?.heapUsedMB} MB (edge-only); heavy user after: ${heavyAfter.status} → ${path}`,
    );
    assertEquals(
      report.statusHistogram,
      { "200": STRESS_USERS, "204": STRESS_USERS },
      "every verify is 200 and every sign-out 204",
    );
    assertEquals(heavyBefore, 429, "heavy user hit the general budget before the campaign");
    assertEquals(
      firstSiblingAfter.value.status,
      401,
      "first user's sibling token is refused after the campaign",
    );
  },
);
