// Real-handler campaigns for the rateLimit.ts concurrency stress: index.ts is
// imported in-process (Deno.serve captured), Supabase/RevenueCat are the xc
// FakeSupabase model, Redis (when the loader enables it) is SeededUpstash.
// Shared by stress_ratelimit_handler.test.ts (memory path) and
// stress_ratelimit_handler_redis.test.ts (Upstash path with fault injection).
//
// H1 public_burst_xff   — /healthz + legal pages: same-IP burst with seeded
//                          X-Forwarded-For / cf-connecting-ip permutations
//                          (leading spoofed hops, whitespace, casing, cancelled
//                          requests) → exactly PUBLIC_PAGE_LIMIT admitted, 429
//                          headers well-formed. Also measures identity spoofing
//                          via distinct cf-connecting-ip values (observation).
// H2 authfail_burst     — N concurrent bad Supabase-shaped bearers from one IP:
//                          every 401 reached GoTrue exactly once, every 429 did
//                          not; after the burst the IP is refused pre-auth.
// H3 user_budget        — bootstrap a user, burst a per-user route budget with
//                          duplicate/cancelled calls while a SECOND user on the
//                          same IP works; rotate the refresh token mid-way →
//                          the new bearer inherits the exhausted budget; logout
//                          → the bearer is refused (401), never admitted.
// H4 refresh_burst      — N concurrent /v1/auth/refresh with junk tokens from
//                          one IP: exactly AUTH_REFRESH_LIMIT reach GoTrue; the
//                          401s trip the auth-failure budget for the IP.
// H5 webhook_burst      — N concurrent RevenueCat webhooks with a bad secret:
//                          exactly WEBHOOK_LIMIT are answered 401, rest 429.

import {
  FakeSupabase,
  SUPABASE_URL,
  WEBHOOK_SECRET,
  b64url,
  fakeGoogleIdToken,
  readJson,
  type Prng,
} from "./xc_concurrency_harness.ts";
import { FAKE_REDIS_TOKEN, FAKE_REDIS_URL } from "./harness.ts";
import { captureAccessLog } from "../http.ts";
import {
  HEALTHY,
  type Invariant,
  type UpstashFaults,
  freshIp,
  histogram,
  inv,
  pickWeighted,
  runCampaign,
  seededUpstash,
  sleep,
  type CampaignTable,
} from "./stress_ratelimit_harness.ts";

// Must equal the (unexported) constants FakeSupabase.principal() compares
// against, or service-role writes would be classified as a user.
const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";

// Budgets mirrored from index.ts (ROUTE_LIMITS, *_LIMIT constants).
export const PUBLIC_PAGE_LIMIT = 60;
export const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
export const AUTH_REFRESH_LIMIT = 30;
export const WEBHOOK_LIMIT = 240;
export const GENERAL_USER_LIMIT = 240;
// `spentByBootstrap`: POST /v1/account/bootstrap itself counts one unit of the
// GENERAL user budget (index.ts enforces GENERAL_USER_LIMIT on the exchanged
// user before minting the session), and POST /v1/auth/logout is not in
// ROUTE_LIMITS so it shares that same budget.
export const ROUTE_BUDGETS: Array<{
  name: string;
  method: string;
  path: string;
  limit: number;
  weight: number;
  body: unknown;
  spentByBootstrap: number;
}> = [
  {
    name: "permits",
    method: "POST",
    path: "/v1/analysis-permits",
    limit: 30,
    weight: 6,
    body: "permit",
    spentByBootstrap: 0,
  },
  {
    name: "shots_sync",
    method: "POST",
    path: "/v1/shots:sync",
    limit: 30,
    weight: 3,
    body: {},
    spentByBootstrap: 0,
  },
  {
    name: "trials",
    method: "POST",
    path: "/v1/me/evaluation/trials",
    limit: 12,
    weight: 3,
    body: {},
    spentByBootstrap: 0,
  },
  {
    name: "consent",
    method: "POST",
    path: "/v1/me/consent/grant",
    limit: 30,
    weight: 2,
    body: {},
    spentByBootstrap: 0,
  },
  {
    name: "billing_sync",
    method: "POST",
    path: "/v1/billing/sync",
    limit: 10,
    weight: 3,
    body: {},
    spentByBootstrap: 0,
  },
  {
    name: "delete_request",
    method: "POST",
    path: "/v1/me/delete-request",
    limit: 3,
    weight: 3,
    body: {},
    spentByBootstrap: 0,
  },
  {
    name: "user_general",
    method: "GET",
    path: "/v1/me/access",
    limit: GENERAL_USER_LIMIT,
    weight: 3,
    body: undefined,
    spentByBootstrap: 1,
  },
];

export type HandlerMode = "memory" | "redis" | "redis-flaky" | "redis-hang";

export interface EdgeHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  redis: boolean;
  upstreamCalls: Array<{ method: string; url: string }>;
  accessLog: { lines: number };
}

/** Imports the REAL index.ts once per test file (fresh module graph per file
 * under `deno test`), with or without Upstash configured. Fetch is routed to
 * FakeSupabase; when `redis` is on the campaigns layer SeededUpstash on top. */
export async function loadEdgeHandler(redis: boolean): Promise<EdgeHarness> {
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  if (redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", FAKE_REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", FAKE_REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }
  const fake = new FakeSupabase(1, 0);
  // Not modelled by the xc fake; a plain user-owned upsert target is enough
  // for POST /v1/me/delete-request to mint its challenge. reset() keeps keys.
  fake.tables.account_deletion_requests = [];
  const upstreamCalls: EdgeHarness["upstreamCalls"] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    upstreamCalls.push({ method: request.method, url: request.url });
    return fake.handleFetch(request, rawBody);
  }) as typeof fetch;

  // One access-log line per request would drown the campaign summaries;
  // count them instead (same http.ts module instance as index.ts imports).
  const accessLog = { lines: 0 };
  captureAccessLog(() => {
    accessLog.lines += 1;
  });

  let handler: EdgeHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as EdgeHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  return { handler, fake, redis, upstreamCalls, accessLog };
}

// ── Request builders ─────────────────────────────────────────────────────────

const BASE = "http://edge.stress.test/functions/v1/api";

export type IpStyle =
  "xff" | "xff-multihop" | "xff-whitespace" | "xff-upper" | "cf" | "cf-plus-junk-xff";

export function ipHeaders(prng: Prng, ip: string, style: IpStyle): Record<string, string> {
  const junk = () =>
    `${prng.int(1, 223)}.${prng.int(0, 255)}.${prng.int(0, 255)}.${prng.int(1, 254)}`;
  switch (style) {
    case "xff":
      return { "x-forwarded-for": ip };
    case "xff-multihop":
      return {
        "x-forwarded-for": `${Array.from({ length: prng.int(1, 4) }, junk).join(", ")}, ${ip}`,
      };
    case "xff-whitespace":
      return { "x-forwarded-for": `  ${junk()} ,, ${ip}  , ` };
    case "xff-upper":
      return { "X-Forwarded-For": `${junk()},${ip}` };
    case "cf":
      return { "cf-connecting-ip": ip };
    case "cf-plus-junk-xff":
      return { "cf-connecting-ip": ip, "x-forwarded-for": `${junk()}, ${junk()}` };
  }
}

export function request(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    token?: string;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Request {
  const headers = new Headers(options.headers ?? {});
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
}

/** A syntactically valid Supabase-issued session bearer that no session backs. */
export function junkSessionBearer(prng: Prng): string {
  const payload = {
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: prng.uuid(),
    aud: "authenticated",
    role: "authenticated",
    session_id: prng.uuid(),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.${prng.uuid()}`;
}

export function check429Headers(
  response: Response,
  limit: number,
  windowSeconds: number,
): string[] {
  const problems: string[] = [];
  const retry = Number(response.headers.get("Retry-After"));
  if (!(Number.isInteger(retry) && retry >= 1 && retry <= windowSeconds))
    problems.push(`Retry-After=${response.headers.get("Retry-After")}`);
  if (response.headers.get("RateLimit-Limit") !== String(limit))
    problems.push(`RateLimit-Limit=${response.headers.get("RateLimit-Limit")}`);
  if (response.headers.get("RateLimit-Remaining") !== "0")
    problems.push(`RateLimit-Remaining=${response.headers.get("RateLimit-Remaining")}`);
  if (response.headers.get("Cache-Control") !== "no-store")
    problems.push(`Cache-Control=${response.headers.get("Cache-Control")}`);
  if (!(response.headers.get("Content-Type") ?? "").includes("application/json"))
    problems.push(`Content-Type=${response.headers.get("Content-Type")}`);
  return problems;
}

async function read429Body(response: Response): Promise<string[]> {
  const body = await readJson(response.clone());
  const error = body.error as Record<string, unknown> | undefined;
  return error?.code === "rate_limited" ? [] : [`body.error.code=${String(error?.code)}`];
}

function faultsFor(mode: HandlerMode, prng: Prng): UpstashFaults {
  const latency = prng.int(0, 4);
  const base = { ...HEALTHY, requestLatencyMaxMs: latency, responseLatencyMaxMs: latency };
  if (mode === "redis-flaky") return { ...base, httpFailP: 0.1 + prng.next() * 0.3 };
  if (mode === "redis-hang") return { ...base, hangP: 1 };
  return base;
}

/** Fires `factories` concurrently (seeded pre-delay each) and returns responses in dispatch order. */
async function burst(
  prng: Prng,
  jitterMax: number,
  factories: Array<() => Promise<Response>>,
): Promise<{ responses: Response[]; wallMs: number; rejected: string[] }> {
  const t0 = performance.now();
  const settled = await Promise.allSettled(
    factories.map(async (f) => {
      const d = jitterMax > 0 ? prng.int(0, jitterMax) : 0;
      if (d > 0) await sleep(d);
      return f();
    }),
  );
  const rejected = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason)] : []));
  const responses = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  return { responses, wallMs: performance.now() - t0, rejected };
}

export interface CampaignOptions {
  file: string;
  iterations: number;
  modes: Array<[HandlerMode, number]>;
}

function statusCount(responses: Response[], status: number): number {
  return responses.filter((r) => r.status === status).length;
}

/** Envelope for "requests that got past the limiter": exact under memory/
 * healthy Redis/hang (deterministic fallback); [limit, 2×limit] when Redis
 * flaps (documented fail-open: Redis budget + this isolate's memory budget). */
function admissionInvariant(
  invariants: Invariant[],
  mode: HandlerMode,
  label: string,
  admitted: number,
  refused: number,
  n: number,
  limit: number,
  alreadySpent = 0,
): void {
  const expectedAdmitted = Math.min(n, limit - alreadySpent);
  inv(
    invariants,
    `${label}: every request answered (admitted+429 == N)`,
    admitted + refused === n,
    `admitted=${admitted} 429=${refused} N=${n}`,
  );
  if (mode === "redis-flaky") {
    inv(
      invariants,
      `${label}: admitted within [${expectedAdmitted}, ${Math.min(n, 2 * limit)}] (flaky Redis fail-open envelope)`,
      admitted >= expectedAdmitted && admitted <= Math.min(n, 2 * limit),
      `admitted=${admitted}`,
    );
  } else {
    inv(
      invariants,
      `${label}: exactly ${expectedAdmitted} admitted, ${n - expectedAdmitted} refused with 429`,
      admitted === expectedAdmitted,
      `admitted=${admitted} 429=${refused}`,
    );
  }
}

// ── Campaigns ────────────────────────────────────────────────────────────────

export function campaignPublicBurst(h: EdgeHarness, o: CampaignOptions): Promise<CampaignTable> {
  return runCampaign(
    o.file,
    `${h.redis ? "r" : "m"}_h1_public_burst_xff`,
    "stress H1",
    o.iterations,
    async ({ prng, params, observations, invariants }) => {
      const mode: HandlerMode = h.redis ? pickWeighted(prng, o.modes) : "memory";
      const routes = pickWeighted(prng, [
        [["/healthz"], 3],
        [["/privacy", "/terms", "/support"], 2], // one shared "legal" budget
      ]);
      const method = prng.next() < 0.2 ? "HEAD" : "GET";
      const n = prng.int(PUBLIC_PAGE_LIMIT + 1, PUBLIC_PAGE_LIMIT + 50);
      const jitterMax = prng.int(0, 6);
      const cancelEvery = prng.int(0, 7);
      const ip = freshIp();
      const styles: IpStyle[] = [
        "xff",
        "xff-multihop",
        "xff-whitespace",
        "xff-upper",
        "cf",
        "cf-plus-junk-xff",
      ];
      Object.assign(params, { mode, routes, method, n, jitterMax, cancelEvery, ip });
      const fake = seededUpstash(prng, faultsFor(mode, prng));
      h.fake.reset(prng.int(1, 1 << 30), 0);
      try {
        const styleUse: string[] = [];
        let cancelled = 0;
        const { responses, wallMs, rejected } = await burst(
          prng,
          jitterMax,
          Array.from({ length: n }, (_, i) => () => {
            const style = styles[prng.int(0, styles.length - 1)];
            styleUse.push(style);
            const path = routes[prng.int(0, routes.length - 1)];
            const ac =
              cancelEvery > 0 && i % cancelEvery === cancelEvery - 1 ? new AbortController() : null;
            const p = h.handler(
              request(method, path, { headers: ipHeaders(prng, ip, style), signal: ac?.signal }),
            );
            if (ac) {
              cancelled += 1;
              ac.abort(new DOMException("client went away", "AbortError"));
            }
            return p;
          }),
        );
        observations.styles = histogram(styleUse);
        observations.statusHistogram = histogram(responses.map((r) => r.status));
        observations.cancelled = cancelled;
        observations.wallMs = Math.round(wallMs);
        observations.redis = {
          calls: fake.calls,
          httpFailures: fake.httpFailures,
          hangs: fake.hangs,
        };
        inv(
          invariants,
          "no handler rejection",
          rejected.length === 0,
          rejected.slice(0, 2).join(" | "),
        );
        const refused = statusCount(responses, 429);
        const admitted = statusCount(responses, 200);
        inv(
          invariants,
          "no 5xx",
          responses.every((r) => r.status < 500),
          JSON.stringify(observations.statusHistogram),
        );
        admissionInvariant(
          invariants,
          mode,
          "same last-hop identity across every header style (spoofed leading hops ignored)",
          admitted,
          refused,
          n,
          PUBLIC_PAGE_LIMIT,
        );
        const headerProblems: string[] = [];
        for (const r of responses) {
          if (r.status !== 429) continue;
          headerProblems.push(...check429Headers(r, PUBLIC_PAGE_LIMIT, 60));
          if (method === "GET") headerProblems.push(...(await read429Body(r)));
        }
        inv(
          invariants,
          "every 429 carries Retry-After∈[1,60], RateLimit-Limit=60, RateLimit-Remaining=0, Cache-Control=no-store, JSON rate_limited body",
          headerProblems.length === 0,
          headerProblems.slice(0, 4).join(","),
        );
        inv(invariants, "bounded wall time", wallMs < 8_000, `${Math.round(wallMs)}ms`);

        // Observation: identity is whatever cf-connecting-ip says. With a
        // DISTINCT value per request nothing is ever limited in-process.
        const spoofN = prng.int(PUBLIC_PAGE_LIMIT + 1, PUBLIC_PAGE_LIMIT + 20);
        const spoof = await burst(
          prng,
          0,
          Array.from(
            { length: spoofN },
            () => () =>
              h.handler(
                request("GET", routes[0], {
                  headers: { "cf-connecting-ip": freshIp(), "x-forwarded-for": ip },
                }),
              ),
          ),
        );
        observations.cfSpoof = {
          requests: spoofN,
          refused: statusCount(spoof.responses, 429),
          note: "each request carried a distinct cf-connecting-ip and the SAME x-forwarded-for; in-process the header wins (http.ts clientIp) — whether the platform gateway overwrites a client-supplied cf-connecting-ip is UNKNOWN from Linux",
        };
      } finally {
        fake.restore();
      }
    },
    {
      deadlineMs: 20_000,
      totalsFrom: (row) => ({
        requests:
          Number(row.params.n) +
          Number((row.observations.cfSpoof as { requests?: number } | undefined)?.requests ?? 0),
      }),
    },
  );
}

export function campaignAuthFailBurst(h: EdgeHarness, o: CampaignOptions): Promise<CampaignTable> {
  return runCampaign(
    o.file,
    `${h.redis ? "r" : "m"}_h2_authfail_burst`,
    "stress H2",
    o.iterations,
    async ({ prng, params, observations, invariants }) => {
      const mode: HandlerMode = h.redis
        ? pickWeighted(
            prng,
            o.modes.filter(([m]) => m !== "redis-hang"),
          )
        : "memory";
      const n = prng.int(AUTH_FAILURE_LIMIT.limit + 1, AUTH_FAILURE_LIMIT.limit + 40);
      const followUps = prng.int(1, 5);
      const jitterMax = prng.int(0, 6);
      const latency = prng.int(0, 5);
      const ip = freshIp();
      const path = pickWeighted(prng, [
        ["/v1/me/access", 3],
        ["/v1/me", 2],
        ["/v1/analysis-permits", 1],
      ]);
      const method = path === "/v1/analysis-permits" ? "POST" : "GET";
      Object.assign(params, { mode, n, followUps, jitterMax, latency, ip, path });
      const fake = seededUpstash(prng, faultsFor(mode, prng));
      h.fake.reset(prng.int(1, 1 << 30), latency);
      try {
        const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
        const { responses, wallMs, rejected } = await burst(
          prng,
          jitterMax,
          Array.from(
            { length: n },
            () => () =>
              h.handler(
                request(method, path, {
                  headers: ipHeaders(prng, ip, "xff-multihop"),
                  token: junkSessionBearer(prng),
                  body: method === "POST" ? { idempotencyKey: prng.uuid() } : undefined,
                }),
              ),
          ),
        );
        const getUserBurst = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
        observations.statusHistogram = histogram(responses.map((r) => r.status));
        observations.getUserCalls = getUserBurst;
        observations.wallMs = Math.round(wallMs);
        inv(
          invariants,
          "no handler rejection",
          rejected.length === 0,
          rejected.slice(0, 2).join(" | "),
        );
        const n401 = statusCount(responses, 401);
        const n429 = statusCount(responses, 429);
        inv(
          invariants,
          "every bad bearer is 401 or 429 (never 5xx, never 2xx)",
          n401 + n429 === n,
          JSON.stringify(observations.statusHistogram),
        );
        if (mode !== "redis-flaky") {
          inv(
            invariants,
            "each 401 reached GoTrue exactly once; no 429 reached it (peek-before-auth gate)",
            getUserBurst === n401,
            `getUser=${getUserBurst} 401s=${n401}`,
          );
        } else {
          inv(
            invariants,
            "GoTrue calls ≤ 401s (flaky Redis may serve auth cache misses twice)",
            getUserBurst <= n401 + n,
            `getUser=${getUserBurst} 401s=${n401}`,
          );
        }
        inv(
          invariants,
          `≥ ${AUTH_FAILURE_LIMIT.limit} concurrent probes admitted past the peek (budget is charged AFTER the failure — documented)`,
          n401 >= Math.min(n, AUTH_FAILURE_LIMIT.limit) || mode === "redis-flaky",
          `401s=${n401}`,
        );
        for (const r of responses)
          if (r.status === 429)
            inv(
              invariants,
              "429 headers well-formed",
              check429Headers(r, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds)
                .length === 0,
              check429Headers(r, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds).join(
                ",",
              ),
            );

        // After the burst: the IP is refused before any upstream call.
        const before = h.fake.counters["gotrue.get_user"] ?? 0;
        const after = await burst(
          prng,
          0,
          Array.from(
            { length: followUps },
            () => () =>
              h.handler(
                request("GET", "/v1/me/access", {
                  headers: ipHeaders(prng, ip, "xff"),
                  token: junkSessionBearer(prng),
                }),
              ),
          ),
        );
        const afterGetUser = (h.fake.counters["gotrue.get_user"] ?? 0) - before;
        observations.followUpStatuses = histogram(after.responses.map((r) => r.status));
        if (mode !== "redis-flaky") {
          inv(
            invariants,
            "follow-up requests from the tripped IP are 429 with zero GoTrue calls",
            after.responses.every((r) => r.status === 429) && afterGetUser === 0,
            `${JSON.stringify(observations.followUpStatuses)} getUser=${afterGetUser}`,
          );
          const retry = after.responses.map((r) => Number(r.headers.get("Retry-After")));
          inv(
            invariants,
            "follow-up Retry-After ∈ [1, 300]",
            retry.every((v) => v >= 1 && v <= 300),
            retry.join(","),
          );
        } else {
          inv(
            invariants,
            "follow-ups are 401 or 429 (fail-open allowed while Redis flaps)",
            after.responses.every((r) => r.status === 401 || r.status === 429),
            JSON.stringify(observations.followUpStatuses),
          );
        }
        inv(
          invariants,
          "bounded wall time",
          wallMs + after.wallMs < 10_000,
          `${Math.round(wallMs + after.wallMs)}ms`,
        );
      } finally {
        fake.restore();
      }
    },
    {
      deadlineMs: 20_000,
      totalsFrom: (row) => ({ requests: Number(row.params.n) + Number(row.params.followUps) }),
    },
  );
}

async function bootstrapUser(
  h: EdgeHarness,
  sub: string,
  ip: string,
): Promise<{ status: number; accessToken: string; refreshToken: string }> {
  const response = await h.handler(
    request("POST", "/v1/account/bootstrap", {
      headers: { "x-forwarded-for": ip },
      token: fakeGoogleIdToken(sub),
      body: {},
    }),
  );
  const body = await readJson(response);
  const session = (body.session ?? {}) as Record<string, unknown>;
  return {
    status: response.status,
    accessToken: String(session.accessToken ?? ""),
    refreshToken: String(session.refreshToken ?? ""),
  };
}

export function campaignUserBudget(h: EdgeHarness, o: CampaignOptions): Promise<CampaignTable> {
  return runCampaign(
    o.file,
    `${h.redis ? "r" : "m"}_h3_user_budget_rotation`,
    "stress H3",
    o.iterations,
    async ({ prng, params, observations, invariants }) => {
      const mode: HandlerMode = h.redis
        ? pickWeighted(
            prng,
            o.modes.filter(([m]) => m !== "redis-hang"),
          )
        : "memory";
      const route = pickWeighted(
        prng,
        ROUTE_BUDGETS.map((r) => [r, r.weight] as [typeof r, number]),
      );
      const budgetLeft = route.limit - route.spentByBootstrap;
      const n = prng.int(budgetLeft + 1, budgetLeft + 15);
      const bystanderN = prng.int(1, Math.min(8, route.limit));
      const afterRotation = prng.int(1, 4);
      const afterLogout = prng.int(1, 3);
      const cancelEvery = prng.int(0, 5);
      const jitterMax = prng.int(0, 6);
      const latency = prng.int(0, 4);
      const ip = freshIp();
      const subA = `stress-a-${prng.uuid()}`;
      const subB = `stress-b-${prng.uuid()}`;
      Object.assign(params, {
        mode,
        route: route.name,
        n,
        bystanderN,
        afterRotation,
        afterLogout,
        cancelEvery,
        jitterMax,
        latency,
        ip,
      });
      const fake = seededUpstash(prng, faultsFor(mode, prng));
      h.fake.reset(prng.int(1, 1 << 30), latency);
      try {
        const a = await bootstrapUser(h, subA, ip);
        const b = await bootstrapUser(h, subB, ip);
        inv(
          invariants,
          "precondition: both users bootstrap (200)",
          a.status === 200 && b.status === 200 && a.accessToken !== "" && b.accessToken !== "",
          `a=${a.status} b=${b.status}`,
        );
        if (a.status !== 200 || b.status !== 200) return;

        const bodyFor = () =>
          route.body === "permit" ? { idempotencyKey: prng.uuid() } : route.body;
        const make = (token: string, signal?: AbortSignal) =>
          h.handler(
            request(route.method, route.path, {
              headers: ipHeaders(prng, ip, prng.next() < 0.5 ? "xff" : "xff-multihop"),
              token,
              body: bodyFor(),
              signal,
            }),
          );

        let cancelled = 0;
        const tagged: Array<{ who: "a" | "b"; f: () => Promise<Response> }> = [
          ...Array.from({ length: n }, (_, i) => ({
            who: "a" as const,
            f: () => {
              const ac =
                cancelEvery > 0 && i % cancelEvery === cancelEvery - 1
                  ? new AbortController()
                  : null;
              const p = make(a.accessToken, ac?.signal);
              if (ac) {
                cancelled += 1;
                ac.abort(new DOMException("client went away", "AbortError"));
              }
              return p;
            },
          })),
          ...Array.from({ length: bystanderN }, () => ({
            who: "b" as const,
            f: () => make(b.accessToken),
          })),
        ];
        const order = prng.shuffle(tagged);
        const { responses, wallMs, rejected } = await burst(
          prng,
          jitterMax,
          order.map((t) => t.f),
        );
        const aResponses = responses.filter((_, i) => order[i].who === "a");
        const bResponses = responses.filter((_, i) => order[i].who === "b");
        observations.aStatuses = histogram(aResponses.map((r) => r.status));
        observations.bStatuses = histogram(bResponses.map((r) => r.status));
        observations.cancelled = cancelled;
        observations.wallMs = Math.round(wallMs);
        inv(
          invariants,
          "no handler rejection",
          rejected.length === 0,
          rejected.slice(0, 2).join(" | "),
        );
        inv(
          invariants,
          "no 5xx on either actor",
          responses.every((r) => r.status < 500),
          `${JSON.stringify(observations.aStatuses)} b=${JSON.stringify(observations.bStatuses)}`,
        );
        inv(
          invariants,
          "no 401 for a valid bearer under load",
          responses.every((r) => r.status !== 401),
          JSON.stringify(observations.aStatuses),
        );
        const aRefused = statusCount(aResponses, 429);
        const aAdmitted = aResponses.length - aRefused;
        admissionInvariant(
          invariants,
          mode,
          `user A ${route.name} budget ${route.limit}${route.spentByBootstrap ? ` (−${route.spentByBootstrap} spent by bootstrap)` : ""} (duplicates + ${cancelled} cancelled-in-flight)`,
          aAdmitted,
          aRefused,
          n,
          route.limit,
          route.spentByBootstrap,
        );
        inv(
          invariants,
          "bystander user B on the SAME IP is never 429 (per-user budgets independent)",
          bResponses.every((r) => r.status !== 429),
          JSON.stringify(observations.bStatuses),
        );
        for (const r of aResponses) {
          if (r.status !== 429) continue;
          const problems = check429Headers(
            r,
            route.limit,
            route.name === "delete_request" ? 3600 : 60,
          );
          if (problems.length) {
            inv(invariants, "429 headers well-formed", false, problems.join(","));
            break;
          }
        }

        // Rotation: the new bearer is the same user → same exhausted budget.
        const refreshed = await h.handler(
          request("POST", "/v1/auth/refresh", {
            headers: { "x-forwarded-for": ip },
            body: { refreshToken: a.refreshToken },
          }),
        );
        const session = ((await readJson(refreshed)).session ?? {}) as Record<string, unknown>;
        const rotatedToken = String(session.accessToken ?? "");
        inv(
          invariants,
          "refresh rotates (200 + new access token)",
          refreshed.status === 200 && rotatedToken !== "" && rotatedToken !== a.accessToken,
          `status=${refreshed.status}`,
        );
        if (rotatedToken) {
          const rot = await burst(
            prng,
            jitterMax,
            Array.from({ length: afterRotation }, () => () => make(rotatedToken)),
          );
          observations.afterRotationStatuses = histogram(rot.responses.map((r) => r.status));
          if (mode !== "redis-flaky") {
            inv(
              invariants,
              "after rotation the new bearer is still refused (budget keyed by user id, not token)",
              rot.responses.every((r) => r.status === 429),
              JSON.stringify(observations.afterRotationStatuses),
            );
          } else {
            inv(
              invariants,
              "after rotation: 429 or fail-open admission, never 401/5xx",
              rot.responses.every((r) => r.status === 429 || (r.status < 500 && r.status !== 401)),
              JSON.stringify(observations.afterRotationStatuses),
            );
          }

          // Logout during load. Logout shares the GENERAL user budget, so when
          // THAT budget is the exhausted one (user_general route) the contract
          // is a well-formed 429 (revocation deferred ≤ window) and the bearer
          // stays valid; otherwise 204 and the revoked bearer is 401 after.
          const logout = await h.handler(
            request("POST", "/v1/auth/logout", {
              headers: { "x-forwarded-for": ip },
              token: rotatedToken,
            }),
          );
          observations.logoutStatus = logout.status;
          const generalExhausted = route.spentByBootstrap > 0 && mode !== "redis-flaky";
          const post = await burst(
            prng,
            jitterMax,
            Array.from({ length: afterLogout }, () => () => make(rotatedToken)),
          );
          observations.afterLogoutStatuses = histogram(post.responses.map((r) => r.status));
          if (generalExhausted) {
            observations.logoutStarvedByGeneralBudget = logout.status === 429;
            const problems = logout.status === 429 ? check429Headers(logout, route.limit, 60) : [];
            inv(
              invariants,
              "logout under an exhausted GENERAL budget is a well-formed 429 (shares GENERAL_USER_LIMIT; revocation deferred ≤60s), never 5xx/2xx",
              logout.status === 429 && problems.length === 0,
              `status=${logout.status} ${problems.join(",")}`,
            );
            inv(
              invariants,
              "bearer stays valid while logout is refused: follow-ups are 429, never 401 nor 2xx",
              post.responses.every((r) => r.status === 429),
              JSON.stringify(observations.afterLogoutStatuses),
            );
          } else if (mode === "redis-flaky") {
            inv(
              invariants,
              "logout under flaky Redis: 204 or 429, never 5xx",
              logout.status === 204 || logout.status === 429,
              `status=${logout.status}`,
            );
            inv(
              invariants,
              "after logout: 401 once revoked, else 429/fail-open — never 5xx, never 2xx after a 204",
              post.responses.every(
                (r) => r.status < 500 && (logout.status !== 204 || r.status === 401),
              ),
              JSON.stringify(observations.afterLogoutStatuses),
            );
          } else {
            inv(
              invariants,
              "logout succeeds (204)",
              logout.status === 204,
              `status=${logout.status}`,
            );
            inv(
              invariants,
              "after logout every request with the revoked bearer is 401 (never 2xx, never 429-masked)",
              post.responses.every((r) => r.status === 401),
              JSON.stringify(observations.afterLogoutStatuses),
            );
          }
        }
        inv(invariants, "bounded wall time", wallMs < 10_000, `${Math.round(wallMs)}ms`);
      } finally {
        fake.restore();
      }
    },
    {
      deadlineMs: 25_000,
      totalsFrom: (row) => ({
        requests:
          Number(row.params.n) +
          Number(row.params.bystanderN) +
          Number(row.params.afterRotation) +
          Number(row.params.afterLogout) +
          4,
      }),
    },
  );
}

export function campaignRefreshBurst(h: EdgeHarness, o: CampaignOptions): Promise<CampaignTable> {
  return runCampaign(
    o.file,
    `${h.redis ? "r" : "m"}_h4_refresh_burst`,
    "stress H4",
    o.iterations,
    async ({ prng, params, observations, invariants }) => {
      const mode: HandlerMode = h.redis
        ? pickWeighted(
            prng,
            o.modes.filter(([m]) => m !== "redis-hang"),
          )
        : "memory";
      const n = prng.int(AUTH_REFRESH_LIMIT + 1, AUTH_REFRESH_LIMIT + 30);
      const followUps = prng.int(1, 4);
      const jitterMax = prng.int(0, 6);
      const latency = prng.int(0, 4);
      const ip = freshIp();
      Object.assign(params, { mode, n, followUps, jitterMax, latency, ip });
      const fake = seededUpstash(prng, faultsFor(mode, prng));
      h.fake.reset(prng.int(1, 1 << 30), latency);
      try {
        const before = h.fake.counters["gotrue.token.refresh"] ?? 0;
        const { responses, wallMs, rejected } = await burst(
          prng,
          jitterMax,
          Array.from(
            { length: n },
            () => () =>
              h.handler(
                request("POST", "/v1/auth/refresh", {
                  headers: ipHeaders(prng, ip, "xff-multihop"),
                  body: { refreshToken: `rt-junk-${prng.uuid()}` },
                }),
              ),
          ),
        );
        const gotrue = (h.fake.counters["gotrue.token.refresh"] ?? 0) - before;
        observations.statusHistogram = histogram(responses.map((r) => r.status));
        observations.gotrueRefreshCalls = gotrue;
        observations.wallMs = Math.round(wallMs);
        inv(
          invariants,
          "no handler rejection",
          rejected.length === 0,
          rejected.slice(0, 2).join(" | "),
        );
        const n401 = statusCount(responses, 401);
        const n429 = statusCount(responses, 429);
        inv(
          invariants,
          "every junk refresh is 401 or 429",
          n401 + n429 === n,
          JSON.stringify(observations.statusHistogram),
        );
        admissionInvariant(
          invariants,
          mode,
          `auth_refresh budget ${AUTH_REFRESH_LIMIT}/min per IP`,
          n401,
          n429,
          n,
          AUTH_REFRESH_LIMIT,
        );
        if (mode !== "redis-flaky")
          inv(
            invariants,
            "GoTrue refresh called exactly once per admitted request",
            gotrue === n401,
            `gotrue=${gotrue} 401s=${n401}`,
          );

        // 30 refused refreshes == AUTH_FAILURE_LIMIT → the IP is now refused pre-auth everywhere.
        const after = await burst(
          prng,
          0,
          Array.from(
            { length: followUps },
            () => () =>
              h.handler(
                request("GET", "/v1/me/access", {
                  headers: ipHeaders(prng, ip, "xff"),
                  token: junkSessionBearer(prng),
                }),
              ),
          ),
        );
        observations.followUpStatuses = histogram(after.responses.map((r) => r.status));
        if (mode !== "redis-flaky") {
          inv(
            invariants,
            "the 401s charged the auth-failure budget: follow-ups from the IP are 429 (Retry-After ≤ 300)",
            after.responses.every(
              (r) =>
                r.status === 429 &&
                Number(r.headers.get("Retry-After")) >= 1 &&
                Number(r.headers.get("Retry-After")) <= 300,
            ),
            JSON.stringify(observations.followUpStatuses),
          );
        } else {
          inv(
            invariants,
            "follow-ups are 401 or 429",
            after.responses.every((r) => r.status === 401 || r.status === 429),
            JSON.stringify(observations.followUpStatuses),
          );
        }
        inv(
          invariants,
          "bounded wall time",
          wallMs + after.wallMs < 10_000,
          `${Math.round(wallMs + after.wallMs)}ms`,
        );
      } finally {
        fake.restore();
      }
    },
    {
      deadlineMs: 20_000,
      totalsFrom: (row) => ({ requests: Number(row.params.n) + Number(row.params.followUps) }),
    },
  );
}

export function campaignWebhookBurst(h: EdgeHarness, o: CampaignOptions): Promise<CampaignTable> {
  return runCampaign(
    o.file,
    `${h.redis ? "r" : "m"}_h5_webhook_burst`,
    "stress H5",
    o.iterations,
    async ({ prng, params, observations, invariants }) => {
      const mode: HandlerMode = h.redis ? pickWeighted(prng, o.modes) : "memory";
      const n = prng.int(WEBHOOK_LIMIT + 1, WEBHOOK_LIMIT + 30);
      const jitterMax = prng.int(0, 4);
      const ip = freshIp();
      Object.assign(params, { mode, n, jitterMax, ip });
      const fake = seededUpstash(prng, faultsFor(mode, prng));
      try {
        const rcBefore = h.fake.counters["rc.get_subscriber"] ?? 0;
        const { responses, wallMs, rejected } = await burst(
          prng,
          jitterMax,
          Array.from(
            { length: n },
            () => () =>
              h.handler(
                request("POST", "/webhooks/revenuecat", {
                  headers: {
                    ...ipHeaders(prng, ip, "xff-multihop"),
                    Authorization: `wrong-${prng.uuid()}`,
                  },
                  body: { event: { type: "TEST", app_user_id: prng.uuid() } },
                }),
              ),
          ),
        );
        observations.statusHistogram = histogram(responses.map((r) => r.status));
        observations.wallMs = Math.round(wallMs);
        observations.rcCalls = (h.fake.counters["rc.get_subscriber"] ?? 0) - rcBefore;
        inv(
          invariants,
          "no handler rejection",
          rejected.length === 0,
          rejected.slice(0, 2).join(" | "),
        );
        const n401 = statusCount(responses, 401);
        const n429 = statusCount(responses, 429);
        inv(
          invariants,
          "bad-secret webhooks are 401 or 429 only",
          n401 + n429 === n,
          JSON.stringify(observations.statusHistogram),
        );
        admissionInvariant(
          invariants,
          mode,
          `webhook budget ${WEBHOOK_LIMIT}/min per IP`,
          n401,
          n429,
          n,
          WEBHOOK_LIMIT,
        );
        inv(
          invariants,
          "no RevenueCat call for a bad secret",
          observations.rcCalls === 0,
          `rc=${observations.rcCalls}`,
        );
        inv(invariants, "bounded wall time", wallMs < 8_000, `${Math.round(wallMs)}ms`);
      } finally {
        fake.restore();
      }
    },
    { deadlineMs: 20_000, totalsFrom: (row) => ({ requests: Number(row.params.n) }) },
  );
}
