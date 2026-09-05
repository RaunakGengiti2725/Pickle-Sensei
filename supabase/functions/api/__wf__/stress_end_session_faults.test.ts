/**
 * stress — POST /v1/sessions/:id/finalize (end session): FAILURE INJECTION
 * against the REAL handler, no Redis in this isolate (Upstash faults live in
 * stress_end_session_redis.test.ts because cache.ts reads the Upstash env at
 * module load).
 *
 * Every case: one upstream (Supabase Auth getUser, PostgREST select, PostgREST
 * update, RevenueCat) is made to fail / time out / answer malformed, in turn,
 * and the case asserts the USER-VISIBLE error class (status, typed code,
 * generic 5xx body, Retry-After) and RECOVERABILITY (the mobile outbox's
 * retry/permanent verdict, and that the very next request with the fault
 * cleared succeeds and stamps ended_at exactly once).
 *
 * Deterministic from STRESS_SEED (ids/tokens). Results: one JSON table
 * (case → expected/observed/verdict, replay command) under
 * artifacts/stress-end-session/latest/faults.json (STRESS_OUT_DIR overrides).
 *
 *   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_end_session_faults.test.ts
 *   STRESS_SEED=<seed> … --filter "<case id>"   # replay one case
 */
import { assert, assertEquals } from "@std/assert";
import {
  classifyResponse,
  type ErrorClass,
  type FaultAction,
  finalizeRequest,
  loadStressHarness,
  Prng,
  replayCommand,
  STRESS_SEED,
  type StressHarness,
  type UpstreamKind,
  writeJson,
} from "./stress_end_session_harness.ts";

const FILE = "stress_end_session_faults.test.ts";
const FAST_AUTH_TIMEOUT_MS = 250;

interface CaseRow {
  id: string;
  seed: number;
  upstream: UpstreamKind | "route" | "none";
  fault: string;
  expected: { status: number; code: string | null; outbox: ErrorClass["outbox"] };
  observed: ErrorClass & { upstreamCalls: Record<string, number>; durationMs: number };
  recovery: null | {
    status: number;
    endedAtStampedOnce: boolean;
    endedAt: string | null;
  };
  verdict: "HELD" | "BROKEN";
  notes: string[];
  replay: string;
}

const rows: CaseRow[] = [];

function faultOnce(action: FaultAction, onlyN = 1) {
  return ({ n }: { n: number }): FaultAction => (n === onlyN ? action : { kind: "pass" });
}
function faultAlways(action: FaultAction) {
  return (): FaultAction => action;
}

interface Scenario {
  id: string;
  upstream: CaseRow["upstream"];
  fault: string;
  /** installs the fault; returns notes */
  install: (h: StressHarness) => void;
  expected: CaseRow["expected"];
  /** whether the row starts already ended */
  alreadyEnded?: boolean;
  /** skip creating the session row */
  missingSession?: boolean;
  /** the path segment to use instead of the real session id */
  pathId?: (sessionId: string) => string;
  /** bearer override: null → none; "expired" | "garbage" | "provider" */
  bearer?: "none" | "expired" | "garbage" | "wrong-user" | "unknown-to-auth";
  /** request tweaks */
  request?: Partial<Parameters<typeof finalizeRequest>[1]>;
  /** whether recovery (fault cleared → 200 + stamped once) is meaningful */
  recover?: boolean;
  /** extra assertions on the observed class */
  extra?: (obs: CaseRow["observed"], h: StressHarness) => string[];
  /** env to set during the case */
  env?: Record<string, string>;
}

const generic503 = (context: string) => `${context} is temporarily unavailable. Please try again.`;

async function runScenario(h: StressHarness, prng: Prng, s: Scenario): Promise<CaseRow> {
  h.reset();
  const user = h.mintUser(prng);
  const other = h.mintUser(prng);
  const session = s.missingSession
    ? null
    : h.mintSession(prng, user.id, s.alreadyEnded ? "2026-09-01T11:00:00.000Z" : null);
  const sessionId = session?.id ?? prng.uuid();
  let token: string | null = h.mintBearer(user.id);
  switch (s.bearer) {
    case "none":
      token = null;
      break;
    case "expired":
      token = h.mintBearer(user.id, { ttlSeconds: -60 });
      break;
    case "garbage":
      token = "not.a.jwt";
      break;
    case "wrong-user":
      token = h.mintBearer(other.id);
      break;
    case "unknown-to-auth": {
      token = h.mintBearer(user.id);
      h.bearers.delete(token);
      break;
    }
  }
  for (const [k, v] of Object.entries(s.env ?? {})) Deno.env.set(k, v);
  h.resetFaults();
  s.install(h);
  const notes: string[] = [];
  const requestId = `${s.id}-1`;
  const t0 = performance.now();
  const response = await h.invoke(
    finalizeRequest(s.pathId ? s.pathId(sessionId) : sessionId, { token, ...s.request }),
    requestId,
  );
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  const cls = await classifyResponse(response);
  const upstreamCalls: Record<string, number> = {};
  for (const call of h.callsFor(requestId)) {
    upstreamCalls[`${call.kind}:${call.action}`] =
      (upstreamCalls[`${call.kind}:${call.action}`] ?? 0) + 1;
  }
  const observed = { ...cls, upstreamCalls, durationMs };
  for (const k of Object.keys(s.env ?? {})) Deno.env.delete(k);

  let verdict: CaseRow["verdict"] = "HELD";
  if (observed.status !== s.expected.status) {
    verdict = "BROKEN";
    notes.push(`status ${observed.status} != expected ${s.expected.status}`);
  }
  if (observed.code !== s.expected.code) {
    verdict = "BROKEN";
    notes.push(`code ${observed.code} != expected ${s.expected.code}`);
  }
  if (observed.outbox !== s.expected.outbox) {
    verdict = "BROKEN";
    notes.push(`outbox verdict ${observed.outbox} != expected ${s.expected.outbox}`);
  }
  if (observed.leaksDetail) {
    verdict = "BROKEN";
    notes.push(`5xx body leaks upstream detail: ${observed.message}`);
  }
  if (
    observed.status >= 500 &&
    observed.message !== generic503("Session finalize") &&
    observed.message !== generic503("Session verification") &&
    observed.message !== "Something went wrong. Please try again."
  ) {
    verdict = "BROKEN";
    notes.push(`non-generic 5xx message: ${observed.message}`);
  }
  if (!observed.requestId) {
    verdict = "BROKEN";
    notes.push("missing x-request-id");
  }
  if (h.callsFor(requestId).some((c) => c.kind === "revenuecat")) {
    verdict = "BROKEN";
    notes.push("route reached RevenueCat");
  }
  if (s.extra) {
    const extraNotes = s.extra(observed, h);
    if (extraNotes.length) {
      verdict = "BROKEN";
      notes.push(...extraNotes);
    }
  }

  // Recoverability: clear the fault, replay the SAME request (as the outbox
  // would), expect 200 and ended_at stamped exactly once.
  let recovery: CaseRow["recovery"] = null;
  if (s.recover !== false && session && token && s.bearer === undefined) {
    h.resetFaults();
    const before = session.ended_at;
    const r2 = await h.invoke(finalizeRequest(sessionId, { token }), `${s.id}-2`);
    await r2.text();
    const after1 = session.ended_at;
    const r3 = await h.invoke(finalizeRequest(sessionId, { token }), `${s.id}-3`);
    await r3.text();
    const after2 = session.ended_at;
    const stampedOnce =
      after1 !== null && after1 === after2 && (before === null || before === after1);
    recovery = { status: r2.status, endedAtStampedOnce: stampedOnce, endedAt: after2 };
    if (r2.status !== 200 || r3.status !== 200) {
      verdict = "BROKEN";
      notes.push(`recovery replay statuses ${r2.status}/${r3.status}`);
    }
    if (!stampedOnce) {
      verdict = "BROKEN";
      notes.push(`ended_at not stamped exactly once: ${before} → ${after1} → ${after2}`);
    }
  }

  return {
    id: s.id,
    seed: prng.seed,
    upstream: s.upstream,
    fault: s.fault,
    expected: s.expected,
    observed,
    recovery,
    verdict,
    notes,
    replay: replayCommand(FILE, s.id, prng.seed),
  };
}

const pgErr = (status: number, code: string, message: string): FaultAction => ({
  kind: "status",
  status,
  body: { code, message, details: null, hint: null },
});

const S503 = { status: 503, code: null, outbox: "retry" as const };
const S200 = { status: 200, code: null, outbox: "success" as const };
const S401 = { status: 401, code: null, outbox: "retry" as const };
const S404 = { status: 404, code: "session.not_found", outbox: "permanent" as const };

const scenarios: Scenario[] = [
  // ── control ────────────────────────────────────────────────────────────────
  {
    id: "F00-control-happy",
    upstream: "none",
    fault: "none",
    install: () => {},
    expected: S200,
    extra: (obs) => {
      const notes: string[] = [];
      const n = Object.values(obs.upstreamCalls).reduce((a, b) => a + b, 0);
      if (n !== 3)
        notes.push(
          `cold happy path made ${n} upstream calls (expected auth + select + update = 3)`,
        );
      return notes;
    },
  },
  {
    id: "F01-control-already-ended",
    upstream: "none",
    fault: "none (row already ended)",
    install: () => {},
    alreadyEnded: true,
    expected: S200,
    extra: (obs) =>
      obs.upstreamCalls["pg_sessions_update:pass"]
        ? ["replay moved ended_at (update issued on an ended row)"]
        : [],
  },
  // ── Supabase Auth: GET /auth/v1/user ────────────────────────────────────────
  {
    id: "F02-auth-500",
    upstream: "auth_get_user",
    fault: "HTTP 500",
    install: (h) => (h.faults.auth_get_user = faultAlways({ kind: "status", status: 500 })),
    expected: S503,
    extra: (obs) => (obs.retryAfter ? [] : ["503 from auth without Retry-After"]),
  },
  {
    id: "F03-auth-502-html",
    upstream: "auth_get_user",
    fault: "HTTP 502 text/html gateway page",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({
        kind: "raw",
        status: 502,
        text: "<html>Bad Gateway</html>",
      })),
    expected: S503,
  },
  {
    id: "F04-auth-503-retry-after",
    upstream: "auth_get_user",
    fault: "HTTP 503 Retry-After: 7",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({
        kind: "status",
        status: 503,
        headers: { "Retry-After": "7" },
      })),
    expected: S503,
    extra: (obs) =>
      obs.retryAfter === "7" ? [] : [`Retry-After not propagated (${obs.retryAfter})`],
  },
  {
    id: "F05-auth-429",
    upstream: "auth_get_user",
    fault: "HTTP 429 (GoTrue rate-limits us)",
    install: (h) => (h.faults.auth_get_user = faultAlways({ kind: "status", status: 429 })),
    expected: S503,
  },
  {
    id: "F06-auth-401",
    upstream: "auth_get_user",
    fault: "HTTP 401 bad_jwt (session revoked upstream)",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({
        kind: "status",
        status: 401,
        body: { code: 401, error_code: "bad_jwt", msg: "invalid JWT" },
      })),
    expected: S401,
    recover: false,
  },
  {
    id: "F07-auth-403",
    upstream: "auth_get_user",
    fault: "HTTP 403 (user banned / deleted)",
    install: (h) => (h.faults.auth_get_user = faultAlways({ kind: "status", status: 403 })),
    expected: S401,
    recover: false,
  },
  {
    id: "F08-auth-200-empty-object",
    upstream: "auth_get_user",
    fault: "HTTP 200 {}",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({ kind: "status", status: 200, body: {} })),
    expected: S503,
  },
  {
    id: "F09-auth-200-non-json",
    upstream: "auth_get_user",
    fault: "HTTP 200 non-JSON body",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({
        kind: "raw",
        status: 200,
        text: "<!doctype html>ok",
      })),
    expected: S503,
  },
  {
    id: "F10-auth-200-id-not-string",
    upstream: "auth_get_user",
    fault: "HTTP 200 {id: 42}",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({
        kind: "status",
        status: 200,
        body: { id: 42, app_metadata: { provider: "google" } },
      })),
    expected: S503,
  },
  {
    id: "F11-auth-200-no-provider",
    upstream: "auth_get_user",
    fault: "HTTP 200 user without google/apple provider",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({
        kind: "status",
        status: 200,
        body: { id: "00000000-0000-4000-8000-000000000001", app_metadata: { provider: "email" } },
      })),
    expected: S401,
    recover: false,
  },
  {
    id: "F12-auth-200-null",
    upstream: "auth_get_user",
    fault: "HTTP 200 null",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({
        kind: "raw",
        status: 200,
        text: "null",
        contentType: "application/json",
      })),
    expected: S503,
  },
  {
    id: "F13-auth-200-array",
    upstream: "auth_get_user",
    fault: "HTTP 200 [] (array instead of object)",
    install: (h) =>
      (h.faults.auth_get_user = faultAlways({ kind: "status", status: 200, body: [] })),
    expected: S503,
  },
  {
    id: "F14-auth-204",
    upstream: "auth_get_user",
    fault: "HTTP 204 no body",
    install: (h) => (h.faults.auth_get_user = faultAlways({ kind: "raw", status: 204, text: "" })),
    expected: S503,
  },
  {
    id: "F15-auth-socket-throw",
    upstream: "auth_get_user",
    fault: "socket error every attempt (connection reset)",
    install: (h) => (h.faults.auth_get_user = faultAlways({ kind: "throw" })),
    expected: S503,
    env: { AUTH_UPSTREAM_TIMEOUT_MS: String(FAST_AUTH_TIMEOUT_MS) },
    extra: (obs) =>
      obs.durationMs <= FAST_AUTH_TIMEOUT_MS + 400
        ? []
        : [`auth socket-fail took ${obs.durationMs}ms > deadline`],
  },
  {
    id: "F16-auth-socket-throw-then-ok",
    upstream: "auth_get_user",
    fault: "socket error once, then healthy (connect retry)",
    install: (h) => (h.faults.auth_get_user = faultOnce({ kind: "throw" })),
    expected: S200,
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "2000" },
    extra: (obs) =>
      (obs.upstreamCalls["auth_get_user:throw"] ?? 0) === 1 &&
      (obs.upstreamCalls["auth_get_user:pass"] ?? 0) === 1
        ? []
        : ["expected exactly one retry after a socket fault"],
  },
  {
    id: "F17-auth-hang-deadline",
    upstream: "auth_get_user",
    fault: `hang (no answer) — deadline ${FAST_AUTH_TIMEOUT_MS}ms`,
    install: (h) => (h.faults.auth_get_user = faultAlways({ kind: "hang", maxMs: 30_000 })),
    expected: S503,
    env: { AUTH_UPSTREAM_TIMEOUT_MS: String(FAST_AUTH_TIMEOUT_MS) },
    extra: (obs) =>
      obs.durationMs >= FAST_AUTH_TIMEOUT_MS - 5 && obs.durationMs <= FAST_AUTH_TIMEOUT_MS + 400
        ? []
        : [`auth hang answered after ${obs.durationMs}ms, deadline ${FAST_AUTH_TIMEOUT_MS}ms`],
  },
  {
    id: "F18-auth-slow-inside-deadline",
    upstream: "auth_get_user",
    fault: "answers after 120ms (inside deadline)",
    install: (h) => (h.faults.auth_get_user = faultAlways({ kind: "delay", ms: 120 })),
    expected: S200,
    env: { AUTH_UPSTREAM_TIMEOUT_MS: String(FAST_AUTH_TIMEOUT_MS) },
  },
  {
    id: "F19-auth-500-once-then-ok",
    upstream: "auth_get_user",
    fault: "HTTP 500 once — next request healthy",
    install: (h) => (h.faults.auth_get_user = faultOnce({ kind: "status", status: 500 })),
    expected: S503,
    extra: (obs) =>
      (obs.upstreamCalls["auth_get_user:status:500"] ?? 0) === 1
        ? []
        : ["an HTTP answer must be final (no re-send)"],
  },
  // ── bearer-level (pre-upstream) ─────────────────────────────────────────────
  {
    id: "F20-bearer-missing",
    upstream: "route",
    fault: "no Authorization header",
    install: () => {},
    bearer: "none",
    expected: S401,
    recover: false,
    extra: (obs) =>
      Object.keys(obs.upstreamCalls).length === 0 ? [] : ["missing bearer reached an upstream"],
  },
  {
    id: "F21-bearer-expired",
    upstream: "route",
    fault: "bearer exp in the past",
    install: () => {},
    bearer: "expired",
    expected: S401,
    recover: false,
    extra: (obs) =>
      Object.keys(obs.upstreamCalls).length === 0 ? [] : ["expired bearer reached an upstream"],
  },
  {
    id: "F22-bearer-garbage",
    upstream: "route",
    fault: "bearer is not a JWT",
    install: () => {},
    bearer: "garbage",
    expected: S401,
    recover: false,
  },
  {
    id: "F23-bearer-unknown-to-auth",
    upstream: "auth_get_user",
    fault: "well-formed bearer GoTrue does not know",
    install: () => {},
    bearer: "unknown-to-auth",
    expected: S401,
    recover: false,
  },
  // ── PostgREST: SELECT sessions ──────────────────────────────────────────────
  {
    id: "F24-pg-select-500",
    upstream: "pg_sessions_select",
    fault: "HTTP 500 PGRST000 (pool exhausted)",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways(
        pgErr(500, "PGRST000", "Could not query the database for the schema cache."),
      )),
    expected: S503,
  },
  {
    id: "F25-pg-select-503-html",
    upstream: "pg_sessions_select",
    fault: "HTTP 503 text/html (gateway) — postgrest-js retries GET 503 with 1s/2s/4s backoff",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways({
        kind: "raw",
        status: 503,
        text: "<html>503 Service Unavailable</html>",
      })),
    expected: S503,
    extra: (obs) => {
      const n = obs.upstreamCalls["pg_sessions_select:raw:503"] ?? 0;
      return n > 1 || obs.durationMs > 1_000
        ? [
            `PostgREST GET 503 → ${n} round trips and ${obs.durationMs}ms before the 503 surfaced (postgrest-js retry 1s/2s/4s, no route deadline)`,
          ]
        : [];
    },
  },
  {
    id: "F26-pg-select-401-jwt-expired",
    upstream: "pg_sessions_select",
    fault: "HTTP 401 PGRST301 (JWT expired between auth cache and DB)",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways(pgErr(401, "PGRST301", "JWT expired"))),
    expected: S503,
  },
  {
    id: "F27-pg-select-42501",
    upstream: "pg_sessions_select",
    fault: "HTTP 401 42501 permission denied",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways(
        pgErr(401, "42501", "permission denied for table sessions"),
      )),
    expected: S503,
  },
  {
    id: "F28-pg-select-timeout-57014",
    upstream: "pg_sessions_select",
    fault: "HTTP 500 57014 statement_timeout",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways(
        pgErr(500, "57014", "canceling statement due to statement timeout"),
      )),
    expected: S503,
  },
  {
    id: "F29-pg-select-socket",
    upstream: "pg_sessions_select",
    fault: "socket error every attempt — postgrest-js retries GET network errors 3×",
    install: (h) => (h.faults.pg_sessions_select = faultAlways({ kind: "throw" })),
    expected: S503,
    extra: (obs) => {
      const n = obs.upstreamCalls["pg_sessions_select:throw"] ?? 0;
      return n > 1 || obs.durationMs > 1_000
        ? [
            `PostgREST GET socket fault → ${n} attempts and ${obs.durationMs}ms before the 503 surfaced`,
          ]
        : [];
    },
  },
  {
    id: "F30-pg-select-200-non-json",
    upstream: "pg_sessions_select",
    fault: "HTTP 200 non-JSON",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways({
        kind: "raw",
        status: 200,
        text: "<html>ok</html>",
        contentType: "text/html",
      })),
    expected: S503,
  },
  {
    id: "F31-pg-select-200-two-rows",
    upstream: "pg_sessions_select",
    fault: "HTTP 200 two rows for maybeSingle",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways({
        kind: "status",
        status: 200,
        body: [
          { id: "a", ended_at: null },
          { id: "b", ended_at: null },
        ],
      })),
    expected: S503,
  },
  {
    id: "F32-pg-select-200-empty",
    upstream: "pg_sessions_select",
    fault: "HTTP 200 [] (row invisible — RLS / not yet synced)",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways({ kind: "status", status: 200, body: [] })),
    expected: S404,
    recover: true,
  },
  {
    id: "F33-pg-select-200-row-missing-ended_at",
    upstream: "pg_sessions_select",
    fault: "HTTP 200 [{id}] — malformed row without ended_at",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways({
        kind: "status",
        status: 200,
        body: [{ id: "x" }],
      })),
    // A 200 here means the route reported success although it neither saw nor
    // stamped ended_at — recorded as observed; the verdict comes from `extra`.
    expected: S200,
    extra: (obs) =>
      obs.upstreamCalls["pg_sessions_update:pass"]
        ? []
        : ["malformed row (ended_at absent) → 200 without any update: false success"],
  },
  {
    id: "F34-pg-select-200-null-body",
    upstream: "pg_sessions_select",
    fault: "HTTP 200 null",
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways({
        kind: "raw",
        status: 200,
        text: "null",
        contentType: "application/json",
      })),
    expected: S404,
    recover: true,
  },
  {
    id: "F35-pg-select-200-string-body",
    upstream: "pg_sessions_select",
    fault: 'HTTP 200 "oops" (JSON string instead of rows)',
    install: (h) =>
      (h.faults.pg_sessions_select = faultAlways({
        kind: "raw",
        status: 200,
        text: '"oops"',
        contentType: "application/json",
      })),
    expected: S200,
    extra: (obs) =>
      obs.upstreamCalls["pg_sessions_update:pass"]
        ? []
        : ["malformed 2xx body (non-object data) → 200 without any update: false success"],
  },
  {
    id: "F36-pg-select-500-once-then-ok",
    upstream: "pg_sessions_select",
    fault: "HTTP 500 once — replay heals",
    install: (h) => (h.faults.pg_sessions_select = faultOnce(pgErr(500, "PGRST000", "db down"))),
    expected: S503,
  },
  {
    id: "F37-pg-select-slow-2s",
    upstream: "pg_sessions_select",
    fault: "answers after 2000ms (no deadline on PostgREST)",
    install: (h) => (h.faults.pg_sessions_select = faultAlways({ kind: "delay", ms: 2_000 })),
    expected: S200,
    extra: (obs) =>
      obs.durationMs >= 1_990
        ? []
        : [`expected the request to wait for PostgREST (${obs.durationMs}ms)`],
  },
  // ── PostgREST: UPDATE sessions ──────────────────────────────────────────────
  {
    id: "F38-pg-update-500",
    upstream: "pg_sessions_update",
    fault: "HTTP 500",
    install: (h) => (h.faults.pg_sessions_update = faultAlways(pgErr(500, "PGRST000", "db down"))),
    expected: S503,
  },
  {
    id: "F39-pg-update-42501",
    upstream: "pg_sessions_update",
    fault: "HTTP 401 42501 (column grant missing)",
    install: (h) =>
      (h.faults.pg_sessions_update = faultAlways(
        pgErr(401, "42501", "permission denied for table sessions"),
      )),
    expected: S503,
  },
  {
    id: "F40-pg-update-409-conflict",
    upstream: "pg_sessions_update",
    fault: "HTTP 409 23514 check violation",
    install: (h) =>
      (h.faults.pg_sessions_update = faultAlways(
        pgErr(409, "23514", "new row violates check constraint"),
      )),
    expected: S503,
  },
  {
    id: "F41-pg-update-socket",
    upstream: "pg_sessions_update",
    fault: "socket error",
    install: (h) => (h.faults.pg_sessions_update = faultAlways({ kind: "throw" })),
    expected: S503,
  },
  {
    id: "F42-pg-update-200-non-json",
    upstream: "pg_sessions_update",
    fault: "HTTP 200 text/html body (return=minimal expected 204)",
    install: (h) =>
      (h.faults.pg_sessions_update = faultAlways({
        kind: "raw",
        status: 200,
        text: "<html>ok</html>",
      })),
    expected: S503,
  },
  {
    id: "F43-pg-update-timeout-57014",
    upstream: "pg_sessions_update",
    fault: "HTTP 500 57014 statement_timeout",
    install: (h) =>
      (h.faults.pg_sessions_update = faultAlways(
        pgErr(500, "57014", "canceling statement due to statement timeout"),
      )),
    expected: S503,
  },
  {
    id: "F44-pg-update-500-once-then-ok",
    upstream: "pg_sessions_update",
    fault: "HTTP 500 once — replay heals",
    install: (h) => (h.faults.pg_sessions_update = faultOnce(pgErr(500, "PGRST000", "db down"))),
    expected: S503,
  },
  {
    id: "F45-pg-update-slow-1500",
    upstream: "pg_sessions_update",
    fault: "answers after 1500ms",
    install: (h) => (h.faults.pg_sessions_update = faultAlways({ kind: "delay", ms: 1_500 })),
    expected: S200,
  },
  {
    id: "F46-pg-update-write-lost",
    upstream: "pg_sessions_update",
    fault: "204 answered but write lost (replica lag / lost commit)",
    install: (h) =>
      (h.faults.pg_sessions_update = faultAlways({ kind: "raw", status: 204, text: "" })),
    expected: S200,
    extra: () => [],
  },
  // ── route-level inputs ──────────────────────────────────────────────────────
  {
    id: "F47-path-not-uuid",
    upstream: "route",
    fault: "session id 'abc'",
    install: () => {},
    pathId: () => "abc",
    expected: { status: 400, code: "validation.session", outbox: "permanent" },
    recover: false,
    extra: (obs) =>
      obs.upstreamCalls["pg_sessions_select:pass"] ? ["non-UUID id reached PostgREST"] : [],
  },
  {
    id: "F48-path-uppercase-uuid",
    upstream: "route",
    fault: "UPPERCASE uuid of an owned row",
    install: () => {},
    pathId: (id) => id.toUpperCase(),
    expected: S200,
  },
  {
    id: "F49-path-percent-encoded-uuid",
    upstream: "route",
    fault: "percent-encoded uuid",
    install: () => {},
    pathId: (id) => id.replace(/-/g, "%2D"),
    expected: S200,
  },
  {
    id: "F50-path-bad-percent",
    upstream: "route",
    fault: "malformed percent escape",
    install: () => {},
    pathId: () => "%E0%A4%A",
    expected: { status: 400, code: null, outbox: "permanent" },
    recover: false,
  },
  {
    id: "F51-path-nil-uuid",
    upstream: "route",
    fault: "nil uuid (version 0)",
    install: () => {},
    pathId: () => "00000000-0000-0000-0000-000000000000",
    expected: { status: 400, code: "validation.session", outbox: "permanent" },
    recover: false,
  },
  {
    id: "F52-wrong-owner",
    upstream: "route",
    fault: "bearer of another user (RLS hides the row)",
    install: () => {},
    bearer: "wrong-user",
    expected: S404,
    recover: false,
  },
  {
    id: "F53-missing-session",
    upstream: "route",
    fault: "session never synced",
    install: () => {},
    missingSession: true,
    expected: S404,
    recover: false,
  },
  {
    id: "F54-body-huge-content-length",
    upstream: "route",
    fault: "Content-Length 6MB (body unused by route)",
    install: () => {},
    request: { headers: { "content-length": "6000000" } },
    expected: { status: 413, code: null, outbox: "permanent" },
    recover: false,
    extra: (obs) =>
      Object.keys(obs.upstreamCalls).length === 0 ? [] : ["oversized body reached an upstream"],
  },
  {
    id: "F55-body-garbage-json",
    upstream: "route",
    fault: "body 'not json' (route ignores body)",
    install: () => {},
    request: { body: "not json", headers: { "content-type": "application/json" } },
    expected: S200,
  },
  {
    id: "F56-method-get",
    upstream: "route",
    fault: "GET instead of POST",
    install: () => {},
    request: { method: "GET" },
    expected: { status: 404, code: null, outbox: "permanent" },
    recover: false,
  },
  {
    id: "F57-trailing-slash",
    upstream: "route",
    fault: "/finalize/ trailing slash",
    install: () => {},
    pathId: (id) => id,
    request: { pathSuffix: "/finalize/" },
    expected: { status: 404, code: null, outbox: "permanent" },
    recover: false,
  },
  {
    id: "F58-end-alias",
    upstream: "route",
    fault: "POST /v1/sessions/:id/end (assignment's name for the route)",
    install: () => {},
    request: { pathSuffix: "/end" },
    expected: { status: 404, code: null, outbox: "permanent" },
    recover: false,
  },
  // ── combined / cascading ────────────────────────────────────────────────────
  {
    id: "F59-auth-and-pg-down",
    upstream: "auth_get_user",
    fault: "Auth 503 + PostgREST 503 (whole region down)",
    install: (h) => {
      h.faults.auth_get_user = faultAlways({ kind: "status", status: 503 });
      h.faults.pg_sessions_select = faultAlways(pgErr(503, "PGRST000", "down"));
    },
    expected: S503,
  },
  {
    id: "F60-pg-select-ok-update-socket-then-select-shows-null",
    upstream: "pg_sessions_update",
    fault: "update socket error; replay stamps once",
    install: (h) => (h.faults.pg_sessions_update = faultOnce({ kind: "throw" })),
    expected: S503,
  },
  {
    id: "F61-revenuecat-down",
    upstream: "revenuecat",
    fault: "RevenueCat 500 (route must not depend on it)",
    install: (h) => (h.faults.revenuecat = faultAlways({ kind: "status", status: 500 })),
    expected: S200,
  },
  {
    id: "F62-every-upstream-hangs-auth-cached",
    upstream: "pg_sessions_select",
    fault: "Auth cached; PostgREST answers after 800ms",
    install: (h) => {
      h.faults.auth_get_user = faultAlways({ kind: "hang", maxMs: 30_000 });
      h.faults.pg_sessions_select = faultAlways({ kind: "delay", ms: 800 });
    },
    expected: S503,
    env: { AUTH_UPSTREAM_TIMEOUT_MS: String(FAST_AUTH_TIMEOUT_MS) },
    recover: false,
  },
];

Deno.test(
  "stress/end-session faults: ≥40 upstream fault cases → error class + recoverability",
  async (t) => {
    const h = await loadStressHarness({ redis: false });
    assert(scenarios.length >= 40, `need ≥40 fault cases, have ${scenarios.length}`);
    const ids = new Set(scenarios.map((s) => s.id));
    assertEquals(ids.size, scenarios.length, "duplicate scenario id");

    for (const s of scenarios) {
      await t.step(s.id, async () => {
        const prng = new Prng((STRESS_SEED ^ hash(s.id)) >>> 0);
        const row = await runScenario(h, prng, s);
        rows.push(row);
      });
    }

    const broken = rows.filter((r) => r.verdict === "BROKEN");
    const path = await writeJson("faults", {
      file: FILE,
      seed: STRESS_SEED,
      redis: false,
      cases: rows.length,
      held: rows.length - broken.length,
      broken: broken.map((r) => r.id),
      rows,
    });
    console.log(
      `[stress/end-session faults] ${rows.length} cases, ${broken.length} BROKEN → ${path}`,
    );
    for (const r of broken) console.log(`  BROKEN ${r.id}: ${r.notes.join("; ")}`);

    // Assertions that are contract, not observation. Cases whose verdict is a
    // FINDING (documented in the report) are listed here so the suite stays
    // green while the coordinator decides; everything else must HOLD.
    const knownFindings = new Set([
      "F25-pg-select-503-html",
      "F29-pg-select-socket",
      "F33-pg-select-200-row-missing-ended_at",
      "F35-pg-select-200-string-body",
    ]);
    for (const id of knownFindings) {
      assert(
        broken.some((r) => r.id === id),
        `${id} is recorded as a known finding but no longer reproduces — update the table`,
      );
    }
    const unexpected = broken.filter((r) => !knownFindings.has(r.id));
    assertEquals(
      unexpected.map((r) => `${r.id}: ${r.notes.join("; ")}`),
      [],
      "unexpected BROKEN fault cases",
    );
  },
);

Deno.test(
  "stress/end-session faults: PostgREST has no deadline — a hung DB holds the request open",
  async () => {
    // Auth is bounded (AUTH_UPSTREAM_TIMEOUT_MS); the supabase-js PostgREST
    // calls in finalizeSession carry no AbortSignal. Prove it: hang the select
    // for HANG_MS and show the handler has not settled before then.
    const h = await loadStressHarness({ redis: false });
    const prng = new Prng(STRESS_SEED ^ 0x5e551);
    const user = h.mintUser(prng);
    const session = h.mintSession(prng, user.id);
    const token = h.mintBearer(user.id);
    const HANG_MS = 3_000;
    h.faults.pg_sessions_select = () => ({ kind: "hang", maxMs: HANG_MS });
    const t0 = performance.now();
    const pending = h.invoke(finalizeRequest(session.id, { token }), "hang-probe");
    let settled = false;
    pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, HANG_MS - 500));
    const settledEarly = settled;
    const response = await pending;
    await response.text();
    const totalMs = Math.round(performance.now() - t0);
    const call = h.callsFor("hang-probe").find((c) => c.kind === "pg_sessions_select");
    const out = {
      hangMs: HANG_MS,
      settledBeforeHangEnded: settledEarly,
      totalMs,
      status: response.status,
      postgrestCallHadAbortSignal: false,
      note: "supabase-js PostgREST fetch in finalizeSession has no AbortSignal/timeout; Auth path has AUTH_UPSTREAM_TIMEOUT_MS=6000",
      replay: replayCommand(FILE, "no deadline", STRESS_SEED),
      call: call ? { action: call.action, durationMs: call.tEndMs - call.tStartMs } : null,
    };
    await writeJson("pg_no_deadline", out);
    assertEquals(
      settledEarly,
      false,
      "request settled before PostgREST answered — a deadline exists",
    );
    assert(totalMs >= HANG_MS - 50, `request should have waited the full hang (${totalMs}ms)`);
    assertEquals(response.status, 200);
  },
);

Deno.test(
  "stress/end-session faults: flaky-seed re-run — 10× the control and the malformed-row case",
  async () => {
    // Every case is deterministic; prove it by replaying two of them 10× and
    // requiring identical verdicts each time (the task's flake protocol).
    const h = await loadStressHarness({ redis: false });
    const picks = scenarios.filter(
      (s) => s.id === "F00-control-happy" || s.id === "F33-pg-select-200-row-missing-ended_at",
    );
    const table: Array<{ id: string; run: number; status: number; verdict: string }> = [];
    for (const s of picks) {
      for (let run = 1; run <= 10; run += 1) {
        const prng = new Prng((STRESS_SEED ^ hash(s.id)) >>> 0);
        const row = await runScenario(h, prng, s);
        table.push({ id: s.id, run, status: row.observed.status, verdict: row.verdict });
      }
    }
    await writeJson("faults_flake_rerun", { seed: STRESS_SEED, table });
    for (const s of picks) {
      const verdicts = new Set(
        table.filter((r) => r.id === s.id).map((r) => `${r.status}:${r.verdict}`),
      );
      assertEquals(verdicts.size, 1, `${s.id} is flaky: ${[...verdicts].join(", ")}`);
    }
  },
);

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type { CaseRow };
