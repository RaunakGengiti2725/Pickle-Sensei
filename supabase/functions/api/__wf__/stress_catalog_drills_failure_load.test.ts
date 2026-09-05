/**
 * stress · route-get-v1-catalog-drills · lens failure-load (Upstash CONFIGURED)
 *
 * Runs the REAL handler (../index.ts) in-process over stress_catalog_harness.ts
 * and, for GET /v1/catalog/drills:
 *
 *  1. FAULT MATRIX — every upstream the route can reach (Supabase Auth,
 *     Supabase PostgREST, Upstash Redis, RevenueCat) is made to fail / time
 *     out / hang / answer malformed bytes IN TURN, plus request-level abuse.
 *     Each case asserts the user-visible error class (status, generic body,
 *     Retry-After, x-request-id, no upstream detail leaked) and RECOVERABILITY
 *     (the very next request after the fault heals is a correct 200 for the
 *     same bearer — no poisoned cache, no stuck budget).
 *  2. LOAD — STRESS_LOAD sequential requests (p50/p95/p99) with the upstream
 *     round-trip count per request (Supabase and Upstash separately), then
 *     concurrent bursts; every 200 body is checked against the user it is for.
 *  3. MEMORY — STRESS_USERS distinct users through the cold auth path; heap
 *     checkpoints prove the per-isolate L1 caches stay bounded and that an
 *     evicted user is re-verified correctly (never served another user's rows).
 *
 * Every case is seeded: seed = STRESS_SEED ^ fnv1a(case id) ^ iteration, and
 * derives the user id, session id and client IP. Replay one case:
 *
 *   STRESS_SEED=20260905 deno test -A --no-check --config deno.json \
 *     stress_catalog_drills_failure_load.test.ts --filter "gotrue.http500"
 *
 * Flake check: STRESS_ITER=10 repeats the matrix with iteration-varied seeds.
 * Full campaign (what the report was produced with):
 *   STRESS_LOAD=2000 STRESS_USERS=20000 STRESS_BURST=64 deno test -A --no-check \
 *     --config deno.json stress_catalog_drills_failure_load.test.ts
 *
 * Reports (seed → outcome tables) land under STRESS_OUT_DIR (default
 * artifacts/stress-route-get-v1-catalog-drills/latest/).
 *
 * Contract asserted (AGENTS.md "Scale & security", ../index.ts authRequest /
 * serviceUnavailable, ../cache.ts, ../rateLimit.ts): 5xx bodies are generic
 * and retryable; an Auth OUTAGE is 503 (never 401); an Auth REFUSAL is 401 and
 * is never cached; a Redis outage never breaks a request; rate limits fail
 * open; the route never calls RevenueCat or an RPC. Where the code documents
 * no contract (PostgREST has no deadline; a legacy provider-token bearer folds
 * an Auth outage into 401) the case RECORDS the observation (`observe: true`)
 * instead of inventing one — those rows are findings material, not passes.
 */
import { assert, assertEquals } from "@std/assert";
import {
  catalogRequest,
  envInt,
  fnv1a,
  googleIdToken,
  histogram,
  isRecord,
  latencyStats,
  LEAK_MARKER,
  loadStressHarness,
  outDir,
  Prng,
  readJson,
  sameList,
  savedSlugsOf,
  sessionToken,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_LOAD,
  STRESS_SEED,
  STRESS_USERS,
  type StressHarness,
  type UpstreamClass,
  writeJson,
} from "./stress_catalog_harness.ts";

/** STRESS_REDIS=0 runs the whole file with Upstash unconfigured (pure per-isolate L1). */
const REDIS = (Deno.env.get("STRESS_REDIS") ?? "1").trim() !== "0";
const REPORT_PREFIX = REDIS ? "redis_" : "noredis_";
const THIS_FILE = "stress_catalog_drills_failure_load.test.ts";
const ENV_PREFIX = `STRESS_SEED=${STRESS_SEED}${
  REDIS ? "" : " STRESS_REDIS=0"
}`;
/** Present when Deno runs with `--v8-flags=--expose-gc`; lets the memory test measure RETAINED heap. */
const forceGc = (globalThis as { gc?: () => void }).gc;

// ── Case model ───────────────────────────────────────────────────────────────

type Bearer =
  | "session"
  | "provider"
  | "none"
  | "malformed"
  | "expired"
  | "wrong-issuer"
  | "basic";

interface Expect {
  /** Accepted user-visible outcomes; "hung" = no answer within `withinMs` (observe-only cases). */
  status: Array<number | "hung">;
  /** Retry-After must be present (and equal this value when given). */
  retryAfter?: true | string;
  /** error.message must contain this text. */
  message?: string;
  /** error.code must equal this. */
  code?: string;
  /** Response must arrive within this many ms (bounded deadline). */
  withinMs?: number;
  /** Upstream call deltas that must hold for the faulted request. */
  calls?: Partial<Record<UpstreamClass, number | ((n: number) => boolean)>>;
  /** For a 200: the saved set must be exactly the user's seeded set (default true). */
  savedExact?: boolean;
  /** For a 200: expected item count (default: the catalog size). */
  items?: number | ((n: number) => boolean);
}

interface FaultCase {
  id: string;
  upstream: UpstreamClass | "request" | "combo";
  bearer?: Bearer;
  /** Send one healthy request first so the auth cache is warm for this bearer. */
  warm?: boolean;
  env?: Record<string, string>;
  arm?: (h: StressHarness, ctx: CaseContext) => void;
  /** Override the request (query, path, method, headers). */
  request?: Partial<Parameters<typeof catalogRequest>[0]>;
  /** Run instead of a single request; returns the response to classify. */
  drive?: (h: StressHarness, ctx: CaseContext) => Promise<Response>;
  expect: Expect;
  /** Whether the same bearer must get a correct 200 right after the fault heals (default true). */
  recover?: boolean;
  /** Documented contract absent: record, do not judge. */
  observe?: string;
}

interface CaseContext {
  seed: number;
  prng: Prng;
  userId: string;
  sessionId: string;
  ip: string;
  token: string;
}

interface Row {
  iteration: number;
  id: string;
  upstream: string;
  seed: number;
  userId: string;
  ip: string;
  status: number | "hung";
  code: string | null;
  message: string | null;
  retryAfter: string | null;
  requestId: boolean;
  latencyMs: number;
  calls: Record<UpstreamClass, number>;
  leaked: boolean;
  recovered: boolean | null;
  recoverStatus: number | null;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  outcome: "HELD" | "BROKEN" | "OBSERVED";
  observe?: string;
  replay: string;
}

const rows: Row[] = [];
const catalogSize = (h: StressHarness) => h.catalogSlugs.length;

const leakBody = (marker = LEAK_MARKER) =>
  JSON.stringify({
    code: "PGRST000",
    message: `boom ${marker}`,
    details: "stack",
    hint: null,
  });

// ── The matrix ───────────────────────────────────────────────────────────────

const AUTH_503 = {
  status: [503],
  retryAfter: true as const,
  message: "Session verification is temporarily unavailable",
};
const AUTH_401 = { status: [401], message: "no longer valid" };
const CATALOG_503 = {
  status: [503],
  message: "Drill catalog is temporarily unavailable",
};
const OK = { status: [200] };

function cases(): FaultCase[] {
  const list: FaultCase[] = [];
  const gotrue = (
    id: string,
    fault: Parameters<typeof armGotrue>[1],
    expect: Expect,
    extra: Partial<FaultCase> = {},
  ) =>
    list.push({
      id: `gotrue.${id}`,
      upstream: "gotrue",
      arm: (h) => armGotrue(h, fault),
      expect,
      ...extra,
    });
  const postgrest = (
    id: string,
    fault: Parameters<typeof armPostgrest>[1],
    expect: Expect,
    extra: Partial<FaultCase> = {},
  ) =>
    list.push({
      id: `postgrest.${id}`,
      upstream: "postgrest",
      warm: true,
      arm: (h) => armPostgrest(h, fault),
      expect,
      ...extra,
    });
  const upstash = (
    id: string,
    fault: Parameters<typeof armUpstash>[1],
    expect: Expect,
    extra: Partial<FaultCase> = {},
  ) =>
    list.push({
      id: `upstash.${id}`,
      upstream: "upstash",
      arm: (h) => armUpstash(h, fault),
      expect,
      ...extra,
    });

  // ── Supabase Auth (GoTrue GET /auth/v1/user) — cold session bearer ──
  gotrue("http500", { kind: "http", status: 500 }, {
    ...AUTH_503,
    calls: { gotrue: 1, postgrest: 0 },
  });
  gotrue("http502", { kind: "http", status: 502 }, AUTH_503);
  gotrue("http503.retryAfter7", {
    kind: "http",
    status: 503,
    headers: { "Retry-After": "7" },
  }, { ...AUTH_503, retryAfter: "7" });
  gotrue("http504", { kind: "http", status: 504 }, AUTH_503);
  gotrue("http429.retryAfter3", {
    kind: "http",
    status: 429,
    headers: { "Retry-After": "3" },
  }, { ...AUTH_503, retryAfter: "3" });
  gotrue("http404", { kind: "http", status: 404 }, AUTH_503);
  gotrue("http401.refused", { kind: "http", status: 401 }, {
    ...AUTH_401,
    calls: { postgrest: 0 },
  });
  gotrue("http403.sessionGone", {
    kind: "http",
    status: 403,
    body: JSON.stringify({
      code: 403,
      error_code: "session_not_found",
      msg: "Session from session_id claim in JWT does not exist",
    }),
  }, AUTH_401);
  gotrue("http400.refused", { kind: "http", status: 400 }, AUTH_401);
  gotrue("http401.nonjson", {
    kind: "body",
    status: 401,
    body: `<html>${LEAK_MARKER}</html>`,
    contentType: "text/html",
  }, AUTH_401);
  gotrue("http500.hugeBody", {
    kind: "http",
    status: 500,
    body: "x".repeat(1_000_000),
  }, { ...AUTH_503, withinMs: 1_500 });
  gotrue("throw.once.retried", { kind: "throw" }, {
    ...OK,
    calls: { gotrue: 2 },
  }, { arm: (h) => armGotrue(h, { kind: "throw" }, 1) });
  gotrue("throw.always", { kind: "throw" }, { ...AUTH_503, withinMs: 1_500 }, {
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "400" },
  });
  gotrue("hang.deadline", { kind: "hang" }, { ...AUTH_503, withinMs: 1_200 }, {
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "300" },
  });
  gotrue("delay.withinDeadline", { kind: "delay", ms: 150 }, OK);
  gotrue("delay.pastDeadline", { kind: "delay", ms: 700 }, {
    ...AUTH_503,
    withinMs: 1_200,
  }, { env: { AUTH_UPSTREAM_TIMEOUT_MS: "200" } });
  gotrue("200.nonjson", {
    kind: "body",
    body: `<html>gateway ${LEAK_MARKER}</html>`,
    contentType: "text/html",
  }, AUTH_503);
  gotrue("200.emptyBody", { kind: "body", body: "" }, AUTH_503);
  gotrue("200.missingId", {
    kind: "body",
    body: JSON.stringify({
      email: "x@example.com",
      app_metadata: { provider: "google" },
    }),
  }, AUTH_503);
  gotrue("200.idNotString", {
    kind: "body",
    body: JSON.stringify({ id: 123, app_metadata: { provider: "google" } }),
  }, AUTH_503);
  gotrue("200.arrayBody", { kind: "body", body: "[]" }, AUTH_503);
  gotrue("200.nullBody", { kind: "body", body: "null" }, AUTH_503);
  list.push({
    id: "gotrue.200.providerEmail",
    upstream: "gotrue",
    arm: (h, ctx) =>
      armGotrue(h, {
        kind: "custom",
        respond: () => userWithProvider(ctx.userId, "email"),
      }),
    expect: { status: [401], message: "does not belong" },
  });
  list.push({
    id: "gotrue.200.noAppMetadata",
    upstream: "gotrue",
    arm: (h, ctx) =>
      armGotrue(h, {
        kind: "custom",
        respond: () => userWithProvider(ctx.userId, null),
      }),
    expect: { status: [401], message: "does not belong" },
  });
  list.push({
    id: "gotrue.200.providersListApple",
    upstream: "gotrue",
    arm: (h, ctx) =>
      armGotrue(h, {
        kind: "custom",
        respond: () =>
          userWithProvider(ctx.userId, "email", ["email", "apple"]),
      }),
    expect: { ...OK, calls: { gotrue: 1 } },
  });
  list.push({
    id: "gotrue.200.otherUsersId",
    upstream: "gotrue",
    arm: (h, ctx) =>
      armGotrue(h, {
        kind: "custom",
        respond: () => userWithProvider(ctx.prng.uuid(), "google"),
      }),
    expect: { ...OK, savedExact: false },
    recover: false,
    observe:
      "Auth vouches for a DIFFERENT user id than the token's sub: the route trusts Auth's id (saved flags follow Auth's id, not the JWT sub)",
  });

  // ── Supabase Auth via the TRANSITIONAL provider-ID-token bearer (supabase-js signInWithIdToken) ──
  list.push({
    id: "provider.gotrue.http500",
    upstream: "gotrue",
    bearer: "provider",
    arm: (h) => armGotrue(h, { kind: "http", status: 500 }),
    expect: { status: [401, 503] },
    observe:
      "legacy provider-token bearer: an Auth OUTAGE is reported as 401 'could not be verified' (contract for session bearers is 503)",
  });
  list.push({
    id: "provider.gotrue.throw",
    upstream: "gotrue",
    bearer: "provider",
    arm: (h) => armGotrue(h, { kind: "throw" }),
    expect: { status: [401, 503], withinMs: 5_000 },
    observe:
      "legacy provider-token bearer: a socket failure to Auth is reported as 401",
  });
  list.push({
    id: "provider.gotrue.200.noSession",
    upstream: "gotrue",
    bearer: "provider",
    arm: (h) =>
      armGotrue(h, {
        kind: "body",
        body: JSON.stringify({ user: { id: "x" } }),
      }),
    expect: { status: [401] },
  });
  list.push({
    id: "provider.gotrue.400.badIdToken",
    upstream: "gotrue",
    bearer: "provider",
    arm: (h) =>
      armGotrue(h, {
        kind: "http",
        status: 400,
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: `bad ${LEAK_MARKER}`,
        }),
      }),
    expect: { status: [401] },
  });
  list.push({
    id: "provider.healthy",
    upstream: "gotrue",
    bearer: "provider",
    expect: { ...OK, calls: { gotrue: 1 } },
  });
  list.push({
    id: "provider.gotrue.http500.burnsAuthFailureBudget",
    upstream: "gotrue",
    bearer: "provider",
    drive: async (h, ctx) => {
      // An Auth OUTAGE during which one IP (a NAT'd office, a carrier CGNAT) sends 30
      // legacy-bearer requests: each 401 is charged to the auth-failure budget...
      armGotrue(h, { kind: "http", status: 500 }, 30);
      const legacyBearer = googleIdToken(ctx.userId);
      for (let i = 0; i < 30; i++) {
        const r = await h.handler(
          catalogRequest({ token: legacyBearer, ip: ctx.ip }),
        );
        await r.body?.cancel();
        if (r.status !== 401) {
          throw new Error(
            `outage request #${i} → ${r.status}, want 401 (observed contract)`,
          );
        }
      }
      // ...so after Auth HEALS, the very next request from that IP with a VALID
      // session bearer is refused with 429 for the rest of the 5-minute window.
      h.faults.gotrue = undefined;
      return h.handler(
        catalogRequest({
          token: sessionToken(ctx.userId, { sessionId: ctx.sessionId }),
          ip: ctx.ip,
        }),
      );
    },
    expect: { status: [200, 429] },
    recover: false,
    observe:
      "legacy provider-token bearer: Auth-outage 401s are charged to the per-IP auth-failure budget (30/300 s), locking the IP out after Auth recovers",
  });

  // ── Supabase PostgREST (GET /rest/v1/user_saved_drills) — warm auth ──
  postgrest("http500", { kind: "http", status: 500 }, {
    ...CATALOG_503,
    calls: { gotrue: 0, postgrest: 1 },
  });
  postgrest("http502", { kind: "http", status: 502 }, CATALOG_503);
  postgrest("http503", { kind: "http", status: 503 }, {
    ...CATALOG_503,
    calls: { postgrest: (n) => n >= 1 },
  }, {
    observe:
      "PostgREST 503 (schema-cache reload / restart): supabase-js retries GET 3x with 1s/2s/4s backoff — 4 round trips and a ~7 s stall before the user sees the 503",
  });
  postgrest(
    "http503.retryAfter1",
    { kind: "http", status: 503, headers: { "Retry-After": "1" } },
    {
      ...CATALOG_503,
      calls: { postgrest: (n) => n >= 1 },
    },
    {
      observe:
        "PostgREST 503 with Retry-After: 1 — supabase-js honours the header for each of its 3 retries (4 round trips, ~3 s stall)",
    },
  );
  postgrest("http401.jwtExpired", {
    kind: "http",
    status: 401,
    body: JSON.stringify({
      code: "PGRST301",
      message: `JWT expired ${LEAK_MARKER}`,
    }),
  }, CATALOG_503);
  postgrest("http403.rls", {
    kind: "http",
    status: 403,
    body: JSON.stringify({
      code: "42501",
      message: `permission denied ${LEAK_MARKER}`,
    }),
  }, CATALOG_503);
  postgrest("http404.tableMissing", {
    kind: "http",
    status: 404,
    body: JSON.stringify({
      code: "PGRST205",
      message: `relation missing ${LEAK_MARKER}`,
    }),
  }, CATALOG_503);
  postgrest("http429", {
    kind: "http",
    status: 429,
    headers: { "Retry-After": "5" },
  }, CATALOG_503);
  postgrest("throw", { kind: "throw" }, {
    ...CATALOG_503,
    calls: { postgrest: (n) => n >= 1 },
  }, {
    observe:
      "PostgREST socket failure: supabase-js retries GET 3x (1s/2s/4s) — 4 connection attempts and a ~7 s stall before the 503",
  });
  postgrest("delay.800ms", { kind: "delay", ms: 800 }, OK);
  postgrest("200.nonjson", {
    kind: "body",
    body: `<html>${LEAK_MARKER}</html>`,
    contentType: "text/html",
  }, { status: [500, 503] });
  postgrest("200.object", { kind: "body", body: "{}" }, {
    status: [200, 500, 503],
    savedExact: false,
  }, {
    observe:
      "PostgREST 200 with a JSON object instead of an array: the route dereferences .map on it",
  });
  postgrest("200.null", { kind: "body", body: "null" }, {
    ...OK,
    savedExact: false,
  });
  postgrest("200.emptyString", { kind: "body", body: "" }, {
    ...OK,
    savedExact: false,
  });
  postgrest("200.rowsMissingSlug", {
    kind: "body",
    body: JSON.stringify([{}, { slug: null }, { slug: 5 }, { slugg: "x" }]),
  }, { ...OK, savedExact: false });
  postgrest("200.foreignSlugs", {
    kind: "body",
    body: JSON.stringify([{ slug: "not-in-catalog" }, { slug: "" }]),
  }, { ...OK, savedExact: false });
  postgrest("200.protoPollution", {
    kind: "body",
    body:
      `[{"__proto__":{"saved":true,"polluted":1},"slug":"x"},{"constructor":{"prototype":{"p":1}},"slug":"y"}]`,
  }, { ...OK, savedExact: false });
  postgrest("200.hugeRows.50k", {
    kind: "custom",
    respond: () => hugeRows(50_000),
  }, { ...OK, savedExact: false, withinMs: 5_000 });
  postgrest(
    "200.scalarArray",
    { kind: "body", body: JSON.stringify(["a", 1, null, true]) },
    { status: [200, 500, 503], savedExact: false },
    {
      observe:
        "PostgREST 200 with an array of scalars: row.slug on a primitive",
    },
  );
  list.push({
    id: "postgrest.hang.noDeadline",
    upstream: "postgrest",
    warm: true,
    expect: { status: [503, "hung"], withinMs: 3_000 },
    observe:
      "PostgREST socket that never answers: the route has no deadline of its own (no AbortSignal on the query) — the client waits on the platform wall-clock limit",
    arm: (h, ctx) => {
      // The hang is released after the case so the handler promise settles.
      let release!: () => void;
      const gate = new Promise<Response>((
        resolve,
      ) => (release = () =>
        resolve(new Response(leakBody(), { status: 503 })))
      );
      (ctx as CaseContext & { release?: () => void }).release = release;
      h.faults.postgrest = {
        fault: { kind: "custom", respond: () => gate },
        times: 1,
      };
    },
  });

  // ── Upstash Redis (REST /pipeline) — L2 cache + shared rate limits ──
  upstash("http500.cold", { kind: "http", status: 500 }, {
    ...OK,
    calls: { gotrue: 1, postgrest: 1 },
  });
  upstash("http500.warm", { kind: "http", status: 500 }, {
    ...OK,
    calls: { postgrest: 1 },
  }, { warm: true });
  upstash("http401", { kind: "http", status: 401 }, OK);
  upstash("http429", { kind: "http", status: 429 }, OK);
  upstash("throw.cold", { kind: "throw" }, { ...OK, calls: { gotrue: 1 } });
  upstash("throw.warm", { kind: "throw" }, OK, { warm: true });
  upstash("hang.cold", { kind: "hang" }, { ...OK, withinMs: 9_000 });
  upstash("hang.warm", { kind: "hang" }, { ...OK, withinMs: 7_000 }, {
    warm: true,
  });
  upstash("delay.300ms", { kind: "delay", ms: 300 }, OK, { warm: true });
  upstash("200.nonjson", {
    kind: "body",
    body: "<html>upstash</html>",
    contentType: "text/html",
  }, OK);
  upstash("200.object", { kind: "body", body: `{"result":"OK"}` }, OK);
  upstash("200.emptyArray", { kind: "body", body: "[]" }, OK, { warm: true });
  upstash(
    "200.errorSlots",
    {
      kind: "body",
      body: JSON.stringify([{ error: "ERR WRONGTYPE" }, { error: "ERR" }, {
        error: "ERR",
      }]),
    },
    OK,
    { warm: true },
  );
  upstash(
    "200.nullSlots",
    { kind: "body", body: JSON.stringify([null, null, null]) },
    OK,
    { warm: true },
  );
  upstash("200.stringCounts", {
    kind: "custom",
    respond: (_r, body) =>
      pipelineAnswer(
        body,
        (cmd) => (cmd[0] === "INCR" || cmd[0] === "TTL"
          ? { result: "not-a-number" }
          : { result: null }),
      ),
  }, OK);
  upstash("200.hugeCount.limits", {
    kind: "custom",
    respond: (_r, body) =>
      pipelineAnswer(
        body,
        (
          cmd,
        ) => (cmd[0] === "INCR" ? { result: 1_000_000_000 } : { result: null }),
      ),
  }, {
    status: [429],
    retryAfter: true,
    code: "rate_limited",
    calls: { gotrue: 0, postgrest: 0 },
  });
  upstash("200.negativeCount", {
    kind: "custom",
    respond: (_r, body) =>
      pipelineAnswer(
        body,
        (cmd) => (cmd[0] === "INCR" ? { result: -5 } : { result: null }),
      ),
  }, OK);
  upstash(
    "200.markerString.warm",
    {
      kind: "custom",
      respond: (_r, body) =>
        pipelineAnswer(
          body,
          (cmd) => (cmd[0] === "GET" ? { result: "1" } : { result: null }),
        ),
    },
    { status: [401, 200] },
    {
      warm: true,
      observe:
        "Upstash answers a string for EVERY GET (including the revocation marker): the bearer is refused and the marker is copied into L1 for 60 s",
    },
  );
  upstash("200.garbageAuthRow", {
    kind: "custom",
    respond: (_r, body) =>
      pipelineAnswer(
        body,
        (
          cmd,
        ) => (cmd[0] === "GET" && String(cmd[1]).startsWith("auth:") &&
            !String(cmd[1]).startsWith("auth:revoked:")
          ? { result: "{not json" }
          : cmd[0] === "TTL"
          ? { result: 500 }
          : { result: null }),
      ),
  }, { ...OK, calls: { gotrue: 1 } });
  upstash("200.foreignUserRow.malformed", {
    kind: "custom",
    respond: (_r, body) =>
      pipelineAnswer(
        body,
        (
          cmd,
        ) => (cmd[0] === "GET" && String(cmd[1]).startsWith("auth:") &&
            !String(cmd[1]).startsWith("auth:revoked:")
          ? {
            result: JSON.stringify({
              id: "99999999-9999-4999-8999-999999999999",
              provider: "google",
              email: null,
            }),
          }
          : cmd[0] === "TTL"
          ? { result: 500 }
          : { result: null }),
      ),
  }, { ...OK, calls: { gotrue: 1 } });
  list.push({
    id: "upstash.200.foreignUserRow.wellFormed",
    upstream: "upstash",
    arm: (h) =>
      armUpstash(h, {
        kind: "custom",
        respond: (_r, body) =>
          pipelineAnswer(
            body,
            (
              cmd,
            ) => (cmd[0] === "GET" && String(cmd[1]).startsWith("auth:") &&
                !String(cmd[1]).startsWith("auth:revoked:")
              ? {
                result: JSON.stringify({
                  userId: "99999999-9999-4999-8999-999999999999",
                  email: null,
                  provider: "google",
                  accessToken: sessionToken(
                    "99999999-9999-4999-8999-999999999999",
                  ),
                  expiresAtMs: Date.now() + 300_000,
                }),
              }
              : cmd[0] === "TTL"
              ? { result: 500 }
              : { result: null }),
          ),
      }),
    expect: { ...OK, savedExact: false, calls: { gotrue: 0 } },
    recover: false,
    observe:
      "a WELL-FORMED L2 row under this bearer's key naming ANOTHER user is trusted without re-verification (by design: the key is sha256(bearer); only a compromised Redis can plant it)",
  });
  upstash("500.onlyFirstPipeline", { kind: "http", status: 500 }, OK, {
    arm: (h) => armUpstash(h, { kind: "http", status: 500 }, 1),
  });

  // ── RevenueCat — must never be on this route's path ──
  list.push({
    id: "revenuecat.http500",
    upstream: "revenuecat",
    arm: (
      h,
    ) => (h.faults.revenuecat = { fault: { kind: "http", status: 500 } }),
    expect: { ...OK, calls: { revenuecat: 0 } },
  });
  list.push({
    id: "revenuecat.throw",
    upstream: "revenuecat",
    arm: (h) => (h.faults.revenuecat = { fault: { kind: "throw" } }),
    expect: { ...OK, calls: { revenuecat: 0 } },
  });
  list.push({
    id: "revenuecat.hang",
    upstream: "revenuecat",
    arm: (h) => (h.faults.revenuecat = { fault: { kind: "hang" } }),
    expect: { ...OK, calls: { revenuecat: 0 }, withinMs: 2_000 },
  });

  // ── Combined outages ──
  list.push({
    id: "combo.upstash500+gotrue500",
    upstream: "combo",
    arm: (h) => {
      armUpstash(h, { kind: "http", status: 500 });
      armGotrue(h, { kind: "http", status: 500 });
    },
    expect: AUTH_503,
  });
  list.push({
    id: "combo.upstashThrow+postgrest500",
    upstream: "combo",
    warm: true,
    arm: (h) => {
      armUpstash(h, { kind: "throw" });
      armPostgrest(h, { kind: "http", status: 500 });
    },
    expect: CATALOG_503,
  });
  list.push({
    id: "combo.allThrow.cold",
    upstream: "combo",
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "400" },
    arm: (h) => {
      armUpstash(h, { kind: "throw" });
      armGotrue(h, { kind: "throw" });
      armPostgrest(h, { kind: "throw" });
    },
    expect: { ...AUTH_503, withinMs: 1_500 },
  });
  list.push({
    id: "combo.upstashHang+postgrest500.warm",
    upstream: "combo",
    warm: true,
    arm: (h) => {
      armUpstash(h, { kind: "hang" });
      armPostgrest(h, { kind: "http", status: 500 });
    },
    expect: { ...CATALOG_503, withinMs: 7_000 },
  });
  list.push({
    id: "combo.gotrueHang+upstashHang",
    upstream: "combo",
    env: { AUTH_UPSTREAM_TIMEOUT_MS: "300" },
    arm: (h) => {
      armUpstash(h, { kind: "hang" });
      armGotrue(h, { kind: "hang" });
    },
    expect: { ...AUTH_503, withinMs: 6_000 },
  });

  // ── Request-level (no upstream fault) ──
  list.push({
    id: "request.noBearer",
    upstream: "request",
    bearer: "none",
    expect: {
      status: [401],
      message: "Missing bearer token",
      calls: { gotrue: 0, postgrest: 0 },
    },
    recover: false,
  });
  list.push({
    id: "request.malformedBearer",
    upstream: "request",
    bearer: "malformed",
    expect: { status: [401], calls: { gotrue: 0, postgrest: 0 } },
    recover: false,
  });
  list.push({
    id: "request.expiredSession",
    upstream: "request",
    bearer: "expired",
    expect: {
      status: [401],
      message: "expired",
      calls: { gotrue: 0, postgrest: 0 },
    },
    recover: false,
  });
  list.push({
    id: "request.wrongIssuer",
    upstream: "request",
    bearer: "wrong-issuer",
    expect: { status: [401], calls: { gotrue: 0, postgrest: 0 } },
    recover: false,
  });
  list.push({
    id: "request.basicAuth",
    upstream: "request",
    bearer: "basic",
    expect: { status: [401], calls: { gotrue: 0 } },
    recover: false,
  });
  list.push({
    id: "request.hugeQuery.200KB",
    upstream: "request",
    request: { query: `q=${"a".repeat(200_000)}` },
    expect: { ...OK, items: 0, savedExact: false },
  });
  list.push({
    id: "request.unicodeQuery",
    upstream: "request",
    request: {
      query: "q=%F0%9F%8F%93%20dink&family=%EF%BC%B6%EF%BC%AF%EF%BC%AC",
    },
    expect: { ...OK, items: 0, savedExact: false },
  });
  list.push({
    id: "request.badPercentEncoding",
    upstream: "request",
    request: { query: "q=%E0%A4%A&family=%" },
    expect: { ...OK, items: (n) => n >= 0, savedExact: false },
  });
  list.push({
    id: "request.regexChars",
    upstream: "request",
    request: { query: "q=.*[)(%5C%5C%2B%3F" },
    expect: { ...OK, items: 0, savedExact: false },
  });
  list.push({
    id: "request.familyUnknown",
    upstream: "request",
    request: { query: "family=nope" },
    expect: { ...OK, items: 0, savedExact: false },
  });
  list.push({
    id: "request.familyCaseInsensitive",
    upstream: "request",
    request: { query: "family=VOLLEY" },
    expect: { ...OK, items: (n) => n > 0, savedExact: false },
  });
  list.push({
    id: "request.queryEmptyValues",
    upstream: "request",
    request: { query: "q=&family=&q=&x=1" },
    expect: OK,
  });
  list.push({
    id: "request.mountPrefixVariant",
    upstream: "request",
    request: { path: "/v1/catalog/drills" },
    drive: (h, ctx) =>
      h.handler(
        new Request(`http://edge.stress.test/api/v1/catalog/drills`, {
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            "x-forwarded-for": ctx.ip,
          },
        }),
      ),
    expect: OK,
  });
  list.push({
    id: "request.headMethod",
    upstream: "request",
    request: { method: "HEAD" },
    expect: { status: [404, 405] },
    recover: true,
  });
  list.push({
    id: "request.postMethod",
    upstream: "request",
    request: { method: "POST" },
    expect: { status: [404, 405] },
  });
  list.push({
    id: "request.trailingSlash",
    upstream: "request",
    request: { path: "/v1/catalog/drills/" },
    expect: { status: [404] },
  });
  list.push({
    id: "request.slugTraversal",
    upstream: "request",
    request: { path: "/v1/catalog/drills/..%2F..%2Fetc" },
    expect: { status: [400, 404] },
  });
  list.push({
    id: "request.slugBadEscape",
    upstream: "request",
    request: { path: "/v1/catalog/drills/%E0%A4%A" },
    expect: { status: [400, 404] },
  });
  list.push({
    id: "request.cfConnectingIpSpoof",
    upstream: "request",
    request: {
      headers: {
        "cf-connecting-ip": "203.0.113.5",
        "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      },
    },
    expect: OK,
  });
  list.push({
    id: "request.authFailureBudget.30",
    upstream: "request",
    drive: async (h, ctx) => {
      // 30 bad bearers from this IP exhaust the auth-failure budget; the 31st
      // request — even with a VALID bearer — is 429 and never reaches Auth.
      for (let i = 0; i < 30; i++) {
        const r = await h.handler(
          catalogRequest({ token: `bad.${i}.sig`, ip: ctx.ip }),
        );
        await r.body?.cancel();
        if (r.status !== 401) {
          throw new Error(`bad bearer #${i} → ${r.status}, want 401`);
        }
      }
      return h.handler(catalogRequest({ token: ctx.token, ip: ctx.ip }));
    },
    expect: { status: [429], retryAfter: true, code: "rate_limited" },
    recover: false,
  });
  list.push({
    id: "request.userBudget.240",
    upstream: "request",
    drive: async (h, ctx) => {
      for (let i = 0; i < 240; i++) {
        const r = await h.handler(
          catalogRequest({ token: ctx.token, ip: ctx.prng.ip() }),
        );
        await r.body?.cancel();
        if (r.status !== 200) {
          throw new Error(`request #${i} → ${r.status}, want 200`);
        }
      }
      return h.handler(catalogRequest({ token: ctx.token, ip: ctx.prng.ip() }));
    },
    expect: { status: [429], retryAfter: true, code: "rate_limited" },
    recover: false,
  });
  list.push({
    id: "request.concurrentIdentical.16",
    upstream: "request",
    drive: async (h, ctx) => {
      const responses = await Promise.all(
        Array.from(
          { length: 16 },
          () => h.handler(catalogRequest({ token: ctx.token, ip: ctx.ip })),
        ),
      );
      const bodies = await Promise.all(responses.map((r) => r.clone().text()));
      if (new Set(bodies).size !== 1) {
        throw new Error("concurrent identical GETs returned different bodies");
      }
      if (responses.some((r) => r.status !== 200)) {
        throw new Error(`statuses ${responses.map((r) => r.status)}`);
      }
      return responses[0];
    },
    expect: {
      ...OK,
      calls: { postgrest: 16, gotrue: (n) => n >= 1 && n <= 16 },
    },
  });
  list.push({
    id: "request.rpcNeverCalled",
    upstream: "request",
    drive: async (h, ctx) => {
      const r = await h.handler(
        catalogRequest({ token: ctx.token, ip: ctx.ip }),
      );
      const rpc = h.calls.filter((c) => c.url.includes("/rest/v1/rpc/"));
      if (rpc.length) {
        throw new Error(`route called RPC ${rpc.map((c) => c.url)}`);
      }
      return r;
    },
    expect: OK,
  });
  return list;
}

// ── Fault arming helpers ─────────────────────────────────────────────────────

type FaultOf = NonNullable<StressHarness["faults"]["gotrue"]>["fault"];

function armGotrue(h: StressHarness, fault: FaultOf, times?: number): void {
  h.faults.gotrue = { fault, times };
}
function armPostgrest(h: StressHarness, fault: FaultOf, times?: number): void {
  h.faults.postgrest = { fault, times };
}
function armUpstash(h: StressHarness, fault: FaultOf, times?: number): void {
  h.faults.upstash = { fault, times };
}

function userWithProvider(
  id: string,
  provider: string | null,
  providers?: string[],
): Response {
  const meta = provider === null
    ? undefined
    : { provider, providers: providers ?? [provider] };
  return new Response(
    JSON.stringify({
      id,
      email: "p@example.com",
      ...(meta ? { app_metadata: meta } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function hugeRows(n: number): Response {
  const rows: Array<{ slug: string }> = [];
  for (let i = 0; i < n; i++) rows.push({ slug: `row-${i}` });
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pipelineAnswer(
  body: unknown,
  slot: (cmd: Array<string | number>) => { result?: unknown; error?: string },
): Response {
  const commands = Array.isArray(body)
    ? (body as Array<Array<string | number>>)
    : [];
  return new Response(JSON.stringify(commands.map(slot)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────

function contextFor(id: string, iteration: number): CaseContext {
  const seed = (STRESS_SEED ^ fnv1a(id) ^ Math.imul(iteration, 0x9e3779b9)) >>>
    0;
  const prng = new Prng(seed);
  const userId = prng.uuid();
  const sessionId = prng.uuid();
  const ip = prng.ip();
  return {
    seed,
    prng,
    userId,
    sessionId,
    ip,
    token: sessionToken(userId, { sessionId }),
  };
}

function bearerFor(kind: Bearer, ctx: CaseContext): string | null {
  switch (kind) {
    case "session":
      return ctx.token;
    case "provider":
      return googleIdToken(ctx.userId);
    case "none":
      return null;
    case "malformed":
      return "not.a.jwt";
    case "expired":
      return sessionToken(ctx.userId, {
        sessionId: ctx.sessionId,
        expSeconds: Math.floor(Date.now() / 1000) - 60,
      });
    case "wrong-issuer":
      return `${sessionToken(ctx.userId).split(".")[0]}.${
        btoa(
          JSON.stringify({
            iss: "https://evil.example",
            sub: ctx.userId,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).replace(/=+$/, "")
      }.sig`;
    case "basic":
      return null;
  }
}

function replayCommand(id: string): string {
  return `${ENV_PREFIX} deno test -A --no-check --config deno.json ${THIS_FILE} --filter "${id}"`;
}

async function runCase(
  h: StressHarness,
  c: FaultCase,
  iteration: number,
): Promise<Row> {
  h.reset();
  h.captureConsole = true;
  const ctx = contextFor(c.id, iteration);
  const bearerKind = c.bearer ?? "session";
  const token = bearerFor(bearerKind, ctx);
  const expectedSaved = h.savedFor(ctx.userId);
  const checks: Row["checks"] = [];
  const check = (name: string, ok: boolean, detail = "") =>
    checks.push({ name, ok, detail });

  if (c.warm) {
    const warm = await h.handler(catalogRequest({ token, ip: ctx.ip }));
    const body = await readJson(warm);
    check("warm-up 200", warm.status === 200, `status ${warm.status}`);
    check(
      "warm-up saved set",
      sameList(savedSlugsOf(body.json) ?? [], expectedSaved),
      body.text.slice(0, 120),
    );
  }

  for (const [k, v] of Object.entries(c.env ?? {})) Deno.env.set(k, v);
  h.calls = [];
  c.arm?.(h, ctx);
  const before = h.snapshot();
  const t0 = performance.now();
  const headers = { ...(c.request?.headers ?? {}) };
  if (bearerKind === "basic") headers.Authorization = "Basic dXNlcjpwYXNz";
  const request = catalogRequest({ token, ip: ctx.ip, ...c.request, headers });
  const drive = c.drive ? c.drive(h, ctx) : h.handler(request);
  let response: Response | null = null;
  let hung = false;
  if (c.expect.withinMs !== undefined && c.observe) {
    // Observation cases with a deadline: do not let a never-answering route wedge the suite.
    const timer = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), c.expect.withinMs)
    );
    response = await Promise.race([drive, timer]);
    if (response === null) hung = true;
  } else {
    response = await drive;
  }
  const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
  const calls = h.since(before);
  const release = (ctx as CaseContext & { release?: () => void }).release;
  if (release) release();
  if (hung) {
    // Let the released handler settle so nothing dangles into the next case.
    await drive.then((r) => r.body?.cancel()).catch(() => undefined);
  }
  for (const k of Object.keys(c.env ?? {})) Deno.env.delete(k);
  h.faults = {};

  let status: number | "hung" = "hung";
  let code: string | null = null;
  let message: string | null = null;
  let retryAfter: string | null = null;
  let requestId = false;
  let leaked = false;
  if (response) {
    status = response.status;
    retryAfter = response.headers.get("Retry-After");
    requestId = Boolean(response.headers.get("x-request-id"));
    const body = await readJson(response);
    leaked = body.text.includes(LEAK_MARKER);
    const err = isRecord(body.json) && isRecord(body.json.error)
      ? body.json.error
      : null;
    code = typeof err?.code === "string" ? err.code : null;
    message = typeof err?.message === "string" ? err.message : null;

    check(
      "status in expected set",
      c.expect.status.includes(status),
      `got ${status}, want one of ${c.expect.status}`,
    );
    check("x-request-id present", requestId, "");
    check(
      "no upstream detail leaked to client",
      !leaked,
      leaked ? body.text.slice(0, 200) : "",
    );
    check(
      "cache-control no-store",
      response.headers.get("cache-control") === "no-store",
      response.headers.get("cache-control") ?? "(none)",
    );
    if (status >= 400 || status === 429) {
      check(
        "error body has message",
        typeof message === "string" && message.length > 0,
        body.text.slice(0, 200),
      );
    }
    if (status >= 500) {
      check(
        "5xx message is generic + retryable",
        /temporarily unavailable\. Please try again\.$|Something went wrong\. Please try again\.$/
          .test(message ?? ""),
        message ?? "",
      );
      check(
        "5xx detail logged server-side",
        h.serverLog.some((l) => /\[api\]/.test(l)),
        h.serverLog.slice(0, 3).join(" | ").slice(0, 300),
      );
    }
    if (c.expect.message) {
      check(
        `message contains "${c.expect.message}"`,
        (message ?? "").includes(c.expect.message),
        message ?? "",
      );
    }
    if (c.expect.code) {
      check(
        `code = ${c.expect.code}`,
        code === c.expect.code,
        code ?? "(none)",
      );
    }
    if (c.expect.retryAfter !== undefined) {
      check(
        "Retry-After present",
        retryAfter !== null && Number(retryAfter) > 0,
        retryAfter ?? "(none)",
      );
      if (typeof c.expect.retryAfter === "string") {
        check(
          `Retry-After = ${c.expect.retryAfter}`,
          retryAfter === c.expect.retryAfter,
          retryAfter ?? "(none)",
        );
      }
    }
    if (status === 200) {
      const items = isRecord(body.json) && Array.isArray(body.json.items)
        ? body.json.items
        : null;
      check(
        "200 body shape {items[], cursor:null}",
        items !== null && isRecord(body.json) && body.json.cursor === null,
        body.text.slice(0, 120),
      );
      const wantItems = c.expect.items ?? catalogSize(h);
      if (items) {
        check(
          "item count",
          typeof wantItems === "function"
            ? wantItems(items.length)
            : items.length === wantItems,
          `${items.length}`,
        );
        check(
          "every item has saved:boolean",
          items.every((i) => isRecord(i) && typeof i.saved === "boolean"),
          "",
        );
      }
      if (c.expect.savedExact !== false) {
        check(
          "saved flags = this user's seeded set",
          sameList(savedSlugsOf(body.json) ?? ["<bad>"], expectedSaved),
          `got ${savedSlugsOf(body.json)} want ${expectedSaved}`,
        );
      }
    }
  } else {
    check(
      "status in expected set",
      c.expect.status.includes("hung"),
      `no answer within ${c.expect.withinMs}ms, want one of ${c.expect.status}`,
    );
  }
  if (c.expect.withinMs !== undefined && !c.observe) {
    check(
      `answered within ${c.expect.withinMs}ms`,
      latencyMs <= c.expect.withinMs,
      `${latencyMs}ms`,
    );
  }
  for (
    const [cls, want] of Object.entries(c.expect.calls ?? {}) as Array<
      [UpstreamClass, number | ((n: number) => boolean)]
    >
  ) {
    const got = calls[cls];
    check(
      `${cls} calls`,
      typeof want === "function" ? want(got) : got === want,
      `${got}`,
    );
  }

  // Recoverability: the fault is gone; the SAME bearer must be served correctly now.
  let recovered: boolean | null = null;
  let recoverStatus: number | null = null;
  if (c.recover !== false && bearerKind !== "none" && bearerKind !== "basic") {
    h.calls = [];
    const again = await h.handler(catalogRequest({ token, ip: ctx.ip }));
    recoverStatus = again.status;
    const body = await readJson(again);
    const saved = savedSlugsOf(body.json);
    recovered = again.status === 200 && saved !== null &&
      sameList(saved, expectedSaved);
    if (c.observe && c.id === "upstash.200.markerString.warm") {
      // Recorded, not judged: the copied marker is honoured for L1_READTHROUGH_TTL_SECONDS.
      check("recovery (observed)", true, `status ${again.status}`);
    } else {
      check(
        "recovers: next request is a correct 200",
        recovered,
        `status ${again.status} saved=${saved} want=${expectedSaved} body=${
          body.text.slice(0, 120)
        }`,
      );
    }
  }

  const broken = checks.some((k) => !k.ok);
  const row: Row = {
    iteration,
    id: c.id,
    upstream: c.upstream,
    seed: ctx.seed,
    userId: ctx.userId,
    ip: ctx.ip,
    status,
    code,
    message,
    retryAfter,
    requestId,
    latencyMs,
    calls,
    leaked,
    recovered,
    recoverStatus,
    checks,
    outcome: broken ? "BROKEN" : c.observe ? "OBSERVED" : "HELD",
    observe: c.observe,
    replay: replayCommand(c.id),
  };
  rows.push(row);
  h.captureConsole = false;
  console.log(
    `[stress] ${row.outcome.padEnd(8)} ${c.id.padEnd(40)} status=${
      String(status).padEnd(4)
    } ${latencyMs}ms calls=${JSON.stringify(calls)}${
      row.recovered === null ? "" : ` recovered=${row.recovered}`
    }`,
  );
  return row;
}

// ── Tests: fault matrix ──────────────────────────────────────────────────────

// Without Upstash configured there is no Redis path to fault: those cases are
// meaningless (not skipped-as-passing — they are absent from the noredis report).
const MATRIX = cases().filter((c) =>
  REDIS || (c.upstream !== "upstash" && !/upstash/i.test(c.id))
);
if (MATRIX.length < 40) {
  throw new Error(
    `fault matrix has ${MATRIX.length} cases, lens requires ≥ 40`,
  );
}

for (let iteration = 0; iteration < STRESS_ITER; iteration++) {
  for (const c of MATRIX) {
    Deno.test({
      name: `stress-catalog ${c.id}${STRESS_ITER > 1 ? ` #${iteration}` : ""}`,
      // Hang cases leave the faulted upstream's promise settling after the
      // deadline; the harness releases it, but the op sanitizer would still
      // flag the in-flight timer of AbortSignal.timeout on Redis hangs.
      sanitizeOps: false,
      sanitizeResources: false,
      async fn() {
        const h = await loadStressHarness({ redis: REDIS });
        const row = await runCase(h, c, iteration);
        const failed = row.checks.filter((k) => !k.ok);
        assert(
          failed.length === 0,
          `${c.id} (seed ${row.seed}) BROKEN:\n${
            failed.map((k) => `  - ${k.name}: ${k.detail}`).join("\n")
          }\nreplay: ${row.replay}`,
        );
      },
    });
  }
}

Deno.test("stress-catalog: write fault matrix report", async () => {
  const path = await writeJson(`${REPORT_PREFIX}fault_matrix.json`, {
    unit: "route-get-v1-catalog-drills",
    lens: "failure-load",
    redisConfigured: REDIS,
    seed: STRESS_SEED,
    iterations: STRESS_ITER,
    cases: MATRIX.length,
    executed: rows.length,
    outcomes: histogram(rows.map((r) => r.outcome)),
    byUpstream: histogram(rows.map((r) => `${r.upstream}:${r.outcome}`)),
    rows,
  });
  console.log(`[stress] fault matrix → ${path} (${rows.length} rows)`);
  assertEquals(rows.length, MATRIX.length * STRESS_ITER);
});

// ── Tests: load ──────────────────────────────────────────────────────────────

interface LoadSample {
  i: number;
  user: number;
  status: number;
  latencyMs: number;
  gotrue: number;
  postgrest: number;
  upstash: number;
  ok: boolean;
}

Deno.test({
  name:
    "stress-catalog load: sequential p50/p95 + upstream round trips per request",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: REDIS });
    h.reset();
    h.recordCalls = false;
    const seed = (STRESS_SEED ^ fnv1a("load.sequential")) >>> 0;
    const prng = new Prng(seed);
    // Per-user general budget is 240/min: spread the load so the limiter is never the thing measured.
    const userCount = Math.max(10, Math.ceil(STRESS_LOAD / 150));
    const users = Array.from({ length: userCount }, () => {
      const id = prng.uuid();
      return {
        id,
        token: sessionToken(id, { sessionId: prng.uuid() }),
        ip: prng.ip(),
        saved: h.savedFor(id),
      };
    });
    const cold: LoadSample[] = [];
    const warm: LoadSample[] = [];
    const one = async (i: number, u: number, sink: LoadSample[]) => {
      const user = users[u];
      const before = h.snapshot();
      const t0 = performance.now();
      const res = await h.handler(
        catalogRequest({ token: user.token, ip: user.ip }),
      );
      const body = await readJson(res);
      const latencyMs = performance.now() - t0;
      const d = h.since(before);
      const saved = savedSlugsOf(body.json);
      sink.push({
        i,
        user: u,
        status: res.status,
        latencyMs,
        gotrue: d.gotrue,
        postgrest: d.postgrest,
        upstash: d.upstash,
        ok: res.status === 200 && saved !== null && sameList(saved, user.saved),
      });
    };
    for (let u = 0; u < users.length; u++) await one(u, u, cold);
    for (let i = 0; i < STRESS_LOAD; i++) {
      await one(i, prng.int(0, users.length - 1), warm);
    }

    const supabaseTrips = (s: LoadSample) => s.gotrue + s.postgrest;
    const report = {
      seed,
      users: users.length,
      cold: {
        ...latencyStats(cold.map((s) => s.latencyMs)),
        supabaseRoundTrips: histogram(cold.map(supabaseTrips)),
        upstashRoundTrips: histogram(cold.map((s) => s.upstash)),
        statuses: histogram(cold.map((s) => s.status)),
        bodiesCorrect: cold.filter((s) => s.ok).length,
      },
      warm: {
        ...latencyStats(warm.map((s) => s.latencyMs)),
        supabaseRoundTrips: histogram(warm.map(supabaseTrips)),
        upstashRoundTrips: histogram(warm.map((s) => s.upstash)),
        statuses: histogram(warm.map((s) => s.status)),
        bodiesCorrect: warm.filter((s) => s.ok).length,
      },
      note:
        "latency is in-process handler time over zero-latency fakes (no network); round trips are exact fetch() counts",
      samples: warm.slice(0, 50),
      replay:
        `STRESS_SEED=${STRESS_SEED} STRESS_LOAD=${STRESS_LOAD} deno test -A --no-check --config deno.json stress_catalog_drills_failure_load.test.ts --filter "load: sequential"`,
    };
    const path = await writeJson(
      `${REPORT_PREFIX}load_sequential.json`,
      report,
    );
    console.log(`[stress] load sequential → ${path}`);
    console.log(
      `[stress]   warm p50=${report.warm.p50Ms}ms p95=${report.warm.p95Ms}ms p99=${report.warm.p99Ms}ms supabase=${
        JSON.stringify(report.warm.supabaseRoundTrips)
      } upstash=${JSON.stringify(report.warm.upstashRoundTrips)}`,
    );
    console.log(
      `[stress]   cold p50=${report.cold.p50Ms}ms p95=${report.cold.p95Ms}ms supabase=${
        JSON.stringify(report.cold.supabaseRoundTrips)
      } upstash=${JSON.stringify(report.cold.upstashRoundTrips)}`,
    );

    assertEquals(warm.length, STRESS_LOAD);
    assertEquals(
      report.warm.bodiesCorrect,
      STRESS_LOAD,
      "every warm 200 carries this user's saved flags",
    );
    assertEquals(report.cold.bodiesCorrect, users.length);
    // Lens threshold: a hot path doing > 3 Supabase round trips is a finding.
    assert(
      warm.every((s) => supabaseTrips(s) <= 3),
      `warm request with > 3 Supabase round trips: ${
        JSON.stringify(warm.find((s) => supabaseTrips(s) > 3))
      }`,
    );
    // Warm = auth cached: PostgREST once, Auth never.
    assert(
      warm.every((s) => s.gotrue === 0 && s.postgrest === 1),
      `warm request re-verified auth or re-queried: ${
        JSON.stringify(warm.find((s) => !(s.gotrue === 0 && s.postgrest === 1)))
      }`,
    );
  },
});

Deno.test({
  name:
    "stress-catalog load: concurrent bursts keep every body on its own user",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: REDIS });
    h.reset();
    h.recordCalls = false;
    const seed = (STRESS_SEED ^ fnv1a("load.burst")) >>> 0;
    const prng = new Prng(seed);
    const rounds = Math.max(3, Math.ceil(STRESS_LOAD / STRESS_BURST));
    const users = Array.from({
      length: Math.max(8, Math.ceil(STRESS_BURST / 2)),
    }, () => {
      const id = prng.uuid();
      return {
        id,
        token: sessionToken(id, { sessionId: prng.uuid() }),
        ip: prng.ip(),
        saved: h.savedFor(id),
      };
    });
    const results: Array<
      { round: number; status: number; ok: boolean; latencyMs: number }
    > = [];
    const roundLatency: number[] = [];
    const before = h.snapshot();
    for (let round = 0; round < rounds; round++) {
      const lanes = Array.from(
        { length: STRESS_BURST },
        () => users[prng.int(0, users.length - 1)],
      );
      const t0 = performance.now();
      const responses = await Promise.all(
        lanes.map(async (user) => {
          const t = performance.now();
          const res = await h.handler(
            catalogRequest({ token: user.token, ip: user.ip }),
          );
          const body = await readJson(res);
          const saved = savedSlugsOf(body.json);
          return {
            round,
            status: res.status,
            ok: res.status === 200 && saved !== null &&
              sameList(saved, user.saved),
            latencyMs: performance.now() - t,
          };
        }),
      );
      roundLatency.push(performance.now() - t0);
      results.push(...responses);
    }
    const calls = h.since(before);
    const report = {
      seed,
      rounds,
      burst: STRESS_BURST,
      users: users.length,
      requests: results.length,
      statuses: histogram(results.map((r) => r.status)),
      bodiesCorrect: results.filter((r) => r.ok).length,
      perRequest: latencyStats(results.map((r) => r.latencyMs)),
      perRound: latencyStats(roundLatency),
      upstreamCalls: calls,
      coldVerifications: calls.gotrue,
      replay:
        `STRESS_SEED=${STRESS_SEED} STRESS_LOAD=${STRESS_LOAD} STRESS_BURST=${STRESS_BURST} deno test -A --no-check --config deno.json stress_catalog_drills_failure_load.test.ts --filter "load: concurrent"`,
    };
    const path = await writeJson(`${REPORT_PREFIX}load_burst.json`, report);
    console.log(
      `[stress] load burst → ${path}: ${results.length} requests, statuses=${
        JSON.stringify(report.statuses)
      }, p95=${report.perRequest.p95Ms}ms, gotrue=${calls.gotrue} postgrest=${calls.postgrest} upstash=${calls.upstash}`,
    );
    assertEquals(
      report.bodiesCorrect,
      results.length,
      "every concurrent response carries its own user's saved flags",
    );
    assertEquals(
      calls.postgrest,
      results.length,
      "exactly one PostgREST query per request",
    );
  },
});

// ── Tests: memory under many distinct users ──────────────────────────────────

Deno.test({
  name:
    "stress-catalog memory: distinct users through the cold path keep L1 bounded and correct",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: REDIS });
    h.reset();
    h.recordCalls = false;
    const seed = (STRESS_SEED ^ fnv1a("memory.users")) >>> 0;
    const prng = new Prng(seed);
    const total = STRESS_USERS;
    const checkpointEvery = Math.max(1, Math.floor(total / 10));
    const checkpoints: Array<
      {
        users: number;
        heapUsed: number;
        heapUsedAfterGc: number | null;
        rss: number;
        external: number;
        elapsedMs: number;
        fakeRedisKeys: number;
      }
    > = [];
    const gcNow = () => {
      if (!forceGc) return null;
      forceGc();
      return Deno.memoryUsage().heapUsed;
    };
    const statuses: Record<string, number> = {};
    let wrongBody = 0;
    const sampleEvery = Math.max(1, Math.floor(total / 200));
    const first = { id: "", token: "", saved: [] as string[] };
    let last = { id: "", token: "", saved: [] as string[] };
    const before = h.snapshot();
    const t0 = performance.now();
    const heap0Gc = gcNow();
    const heap0 = Deno.memoryUsage();
    for (let i = 0; i < total; i++) {
      const id = prng.uuid();
      const token = sessionToken(id, { sessionId: prng.uuid() });
      const ip = prng.ip();
      const res = await h.handler(catalogRequest({ token, ip }));
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (i === 0) Object.assign(first, { id, token, saved: h.savedFor(id) });
      if (i % sampleEvery === 0 || i === total - 1) {
        const body = await readJson(res);
        const saved = savedSlugsOf(body.json);
        if (!(res.status === 200 && saved && sameList(saved, h.savedFor(id)))) {
          wrongBody += 1;
        }
      } else {
        await res.body?.cancel();
      }
      last = { id, token, saved: h.savedFor(id) };
      if ((i + 1) % checkpointEvery === 0 || i === total - 1) {
        const m = Deno.memoryUsage();
        checkpoints.push({
          users: i + 1,
          heapUsed: m.heapUsed,
          heapUsedAfterGc: gcNow(),
          rss: m.rss,
          external: m.external,
          elapsedMs: Math.round(performance.now() - t0),
          fakeRedisKeys: h.redis.size,
        });
      }
    }
    const calls = h.since(before);

    // After the flood: the FIRST user (evicted from L1 by the cap of 5 000)
    // must be re-verified and served ITS rows; the LAST user is served warm.
    const b1 = h.snapshot();
    const r1 = await h.handler(
      catalogRequest({ token: first.token, ip: prng.ip() }),
    );
    const j1 = await readJson(r1);
    const d1 = h.since(b1);
    const b2 = h.snapshot();
    const r2 = await h.handler(
      catalogRequest({ token: last.token, ip: prng.ip() }),
    );
    const j2 = await readJson(r2);
    const d2 = h.since(b2);
    const heap1 = Deno.memoryUsage();
    const heap1Gc = gcNow();

    const report = {
      seed,
      distinctUsers: total,
      statuses,
      sampledBodies: Math.ceil(total / sampleEvery),
      wrongBody,
      upstreamCalls: calls,
      elapsedMs: Math.round(performance.now() - t0),
      requestsPerSecond: Math.round(
        (total / Math.max(1, performance.now() - t0)) * 1000,
      ),
      heapBefore: heap0,
      heapAfter: heap1,
      heapUsedDeltaMB:
        Math.round(((heap1.heapUsed - heap0.heapUsed) / 1_048_576) * 100) / 100,
      rssDeltaMB: Math.round(((heap1.rss - heap0.rss) / 1_048_576) * 100) / 100,
      gcExposed: Boolean(forceGc),
      retainedHeapMB: heap0Gc !== null && heap1Gc !== null
        ? Math.round(((heap1Gc - heap0Gc) / 1_048_576) * 100) / 100
        : null,
      retainedBytesPerUser: heap0Gc !== null && heap1Gc !== null
        ? Math.round((heap1Gc - heap0Gc) / total)
        : null,
      checkpoints,
      caps: {
        cacheL1MaxEntries: 5_000,
        rateLimitWindowsMax: 20_000,
        note:
          "from ../cache.ts MEMORY_MAX_ENTRIES and ../rateLimit.ts MEMORY_WINDOW_MAX (read, not instrumented)",
      },
      fakeRedisKeysAtEnd: h.redis.size,
      afterFlood: {
        firstUser: {
          status: r1.status,
          gotrueCalls: d1.gotrue,
          postgrestCalls: d1.postgrest,
          correct: r1.status === 200 &&
            sameList(savedSlugsOf(j1.json) ?? [], first.saved),
        },
        lastUser: {
          status: r2.status,
          gotrueCalls: d2.gotrue,
          postgrestCalls: d2.postgrest,
          correct: r2.status === 200 &&
            sameList(savedSlugsOf(j2.json) ?? [], last.saved),
        },
      },
      note: REDIS
        ? "Redis configured: heap includes the FAKE Upstash store (fakeRedisKeysAtEnd) which lives in this isolate; see the noredis report for the pure-L1 number"
        : "no Redis: heap delta is the function's own L1 (auth cache + rate-limit windows) plus test bookkeeping",
      replay:
        `${ENV_PREFIX} STRESS_USERS=${STRESS_USERS} deno test -A --no-check --config deno.json --v8-flags=--expose-gc ${THIS_FILE} --filter "memory:"`,
    };
    const path = await writeJson(`${REPORT_PREFIX}memory_users.json`, report);
    console.log(
      `[stress] memory → ${path}: ${total} users in ${report.elapsedMs}ms (${report.requestsPerSecond} req/s) heapUsed Δ=${report.heapUsedDeltaMB}MB rss Δ=${report.rssDeltaMB}MB retained(after gc)=${
        report.retainedHeapMB ?? "n/a (run with --v8-flags=--expose-gc)"
      }MB statuses=${JSON.stringify(statuses)}`,
    );
    for (const c of checkpoints) {
      console.log(
        `[stress]   users=${c.users} heapUsed=${
          (c.heapUsed / 1_048_576).toFixed(1)
        }MB afterGc=${
          c.heapUsedAfterGc === null
            ? "n/a"
            : (c.heapUsedAfterGc / 1_048_576).toFixed(1) + "MB"
        } rss=${
          (c.rss / 1_048_576).toFixed(1)
        }MB fakeRedisKeys=${c.fakeRedisKeys}`,
      );
    }

    assertEquals(
      statuses["200"],
      total,
      `every distinct user got a 200: ${JSON.stringify(statuses)}`,
    );
    assertEquals(
      wrongBody,
      0,
      "no sampled response carried another user's saved flags",
    );
    assertEquals(
      calls.gotrue,
      total,
      "exactly one Auth verification per distinct user",
    );
    assertEquals(
      calls.postgrest,
      total,
      "exactly one PostgREST query per request",
    );
    assertEquals(calls.revenuecat, 0);
    assert(
      report.afterFlood.firstUser.correct,
      `first user after flood: ${JSON.stringify(report.afterFlood.firstUser)}`,
    );
    assert(
      report.afterFlood.lastUser.correct,
      `last user after flood: ${JSON.stringify(report.afterFlood.lastUser)}`,
    );
    assertEquals(
      report.afterFlood.lastUser.gotrueCalls,
      0,
      "the most recent user is still cached (no re-verification)",
    );
    // Bounded growth: with STRESS_USERS ≥ 2× the L1 cap the second half of the
    // flood must not grow the heap by more than the first half did (+50 % slack
    // for GC timing). The fake Redis store grows linearly on purpose — it is
    // subtracted by comparing against the noredis run, not asserted here.
    if (!REDIS && total >= 10_000 && checkpoints.length >= 10) {
      const at = (i: number) =>
        checkpoints[i].heapUsedAfterGc ?? checkpoints[i].heapUsed;
      const firstHalf = at(4) - (heap0Gc ?? heap0.heapUsed);
      const secondHalf = at(9) - at(4);
      assert(
        secondHalf <= Math.max(firstHalf * 1.5, 8 * 1_048_576),
        `L1 keeps growing: first half +${
          (firstHalf / 1_048_576).toFixed(1)
        }MB, second half +${(secondHalf / 1_048_576).toFixed(1)}MB`,
      );
      if (forceGc) {
        // 5 000 auth entries (~1 KB each) + 20 000 rate-limit windows: well under 64 MB retained.
        assert(
          (report.retainedHeapMB ?? 0) <= 64,
          `retained heap after ${total} distinct users: ${report.retainedHeapMB}MB`,
        );
      }
    }
  },
});

Deno.test("stress-catalog: write summary", async () => {
  const path = await writeJson(`${REPORT_PREFIX}summary.json`, {
    unit: "route-get-v1-catalog-drills",
    lens: "failure-load",
    redisConfigured: REDIS,
    seed: STRESS_SEED,
    scale: { STRESS_ITER, STRESS_LOAD, STRESS_USERS, STRESS_BURST },
    faultCases: MATRIX.length,
    faultRowsExecuted: rows.length,
    outcomes: histogram(rows.map((r) => r.outcome)),
    broken: rows.filter((r) => r.outcome === "BROKEN").map((r) => ({
      id: r.id,
      seed: r.seed,
      replay: r.replay,
      failed: r.checks.filter((k) => !k.ok),
    })),
    observed: rows.filter((r) => r.outcome === "OBSERVED").map((r) => ({
      id: r.id,
      seed: r.seed,
      status: r.status,
      latencyMs: r.latencyMs,
      recovered: r.recovered,
      note: r.observe,
    })),
    reports: [
      `${REPORT_PREFIX}fault_matrix.json`,
      `${REPORT_PREFIX}load_sequential.json`,
      `${REPORT_PREFIX}load_burst.json`,
      `${REPORT_PREFIX}memory_users.json`,
    ].map((f) => `${outDir()}${f}`),
  });
  console.log(`[stress] summary → ${path}`);
  assert(envInt("STRESS_ITER", 1) >= 1);
});
