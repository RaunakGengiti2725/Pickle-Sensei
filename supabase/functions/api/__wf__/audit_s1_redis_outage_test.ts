// STRUCTURAL AUDIT #1 (edge-auth-cache-ratelimit) — end-to-end latency of the
// REAL handler when Upstash is configured but unreachable (every REST call
// hangs until cache.ts's own 1 200 ms AbortSignal.timeout fires).
//
// cache.ts degrades each call to memory after the timeout and there is no
// circuit breaker, so the cost is paid on EVERY L2 touch of EVERY request.
// This file measures how many sequential L2 touches an ordinary authed
// request performs and what that does to its latency.
//
// Run: (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json audit_s1_redis_outage_test.ts)

import { assert, assertEquals } from "@std/assert";

const SUPABASE_URL = "http://supabase.audit.test";
const REDIS_URL = "http://redis.audit.test";

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", "anon-audit-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-audit-key");
Deno.env.delete("SB_PUBLISHABLE_KEY");
Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "redis-audit-token");

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const nowSeconds = () => Math.floor(Date.now() / 1_000);
const jwt = (payload: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
    b64url(JSON.stringify(payload))
  }.sig`;
const supabaseAccessToken = (userId: string): string =>
  jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    exp: nowSeconds() + 3_600,
  });
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const redisCalls: Array<{ commands: string[]; atMs: number }> = [];
const gotrueCalls: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch =
  ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.url.startsWith(REDIS_URL)) {
      const body = init?.body ? String(init.body) : "[]";
      const commands = (JSON.parse(body) as Array<Array<string | number>>).map((
        c,
      ) => String(c[0]));
      redisCalls.push({ commands, atMs: performance.now() });
      // Upstash is unreachable: never answer; honour the caller's abort signal.
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal ?? request.signal;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
    if (request.url.startsWith(SUPABASE_URL)) {
      gotrueCalls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/auth/v1/user") {
        const token = (request.headers.get("authorization") ?? "").slice(
          "Bearer ".length,
        );
        const segment = token.split(".")[1] ?? "";
        const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
        const sub = String(
          JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))).sub,
        );
        return Promise.resolve(
          jsonResponse(200, {
            id: sub,
            aud: "authenticated",
            role: "authenticated",
            email: "user@example.com",
            app_metadata: { provider: "google", providers: ["google"] },
            user_metadata: {},
            created_at: "2026-01-01T00:00:00Z",
          }),
        );
      }
      if (url.pathname === "/rest/v1/rpc/access_state") {
        return Promise.resolve(
          jsonResponse(200, [{
            premium: false,
            scored_count: 0,
            reserved_count: 0,
          }]),
        );
      }
      return Promise.resolve(
        jsonResponse(404, { message: `audit fake: ${url.pathname}` }),
      );
    }
    return Promise.resolve(
      new Response(`unexpected fetch ${request.url}`, { status: 599 }),
    );
  }) as typeof fetch;

type Handler = (request: Request) => Promise<Response> | Response;
let captured: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
  captured = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;
if (!captured) {
  throw new Error("index.ts did not register a Deno.serve handler");
}
const api: Handler = captured;

const quiet = { sanitizeOps: false, sanitizeResources: false };

async function timed(
  request: Request,
): Promise<{ response: Response; elapsedMs: number; redis: number }> {
  const before = redisCalls.length;
  const t0 = performance.now();
  const response = await api(request);
  return {
    response,
    elapsedMs: performance.now() - t0,
    redis: redisCalls.length - before,
  };
}

Deno.test({
  name:
    "[defect] Upstash unreachable: one authed GET /v1/me/access waits on 5 sequential 1.2 s L2 timeouts (~6 s) before answering",
  ...quiet,
  async fn() {
    const token = supabaseAccessToken(crypto.randomUUID());
    const { response, elapsedMs, redis } = await timed(
      new Request("http://edge.audit.test/functions/v1/api/v1/me/access", {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-forwarded-for": "198.51.100.77",
        },
      }),
    );
    await response.body?.cancel();
    const sequence = redisCalls.slice(-redis).map((c) => c.commands.join("+"));
    console.log(
      `[audit] redis-outage authed request: status=${response.status} l2Touches=${redis} sequence=${
        JSON.stringify(sequence)
      } elapsedMs=${elapsedMs.toFixed(0)}`,
    );
    assertEquals(
      response.status,
      200,
      "memory fallback keeps the request working",
    );
    // Each touch pays the full REDIS_TIMEOUT_MS because there is no breaker.
    assert(
      redis >= 4,
      `expected the ip/authfail/authcache/userlimit touches, saw ${redis}`,
    );
    assert(
      elapsedMs < 2_500,
      `request took ${
        elapsedMs.toFixed(0)
      } ms during an Upstash outage (${redis} × 1 200 ms serial timeouts)`,
    );
  },
});

Deno.test({
  name:
    "[defect] Upstash unreachable: the SAME bearer's next request still pays ≥3 serial L2 timeouts (no breaker, L1 only covers the auth entry)",
  ...quiet,
  async fn() {
    const token = supabaseAccessToken(crypto.randomUUID());
    const first = await timed(
      new Request("http://edge.audit.test/functions/v1/api/v1/me/access", {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-forwarded-for": "198.51.100.78",
        },
      }),
    );
    await first.response.body?.cancel();
    const gotrueBefore = gotrueCalls.filter((c) =>
      c.endsWith("/auth/v1/user")
    ).length;
    const second = await timed(
      new Request("http://edge.audit.test/functions/v1/api/v1/me/access", {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-forwarded-for": "198.51.100.78",
        },
      }),
    );
    await second.response.body?.cancel();
    const gotrueAfter =
      gotrueCalls.filter((c) => c.endsWith("/auth/v1/user")).length;
    console.log(
      `[audit] redis-outage second request: l2Touches=${second.redis} elapsedMs=${
        second.elapsedMs.toFixed(0)
      } getUserCalls=${gotrueAfter - gotrueBefore}`,
    );
    assertEquals(gotrueAfter - gotrueBefore, 0, "auth entry is served from L1");
    assert(
      second.elapsedMs < 2_500,
      `warm request still took ${
        second.elapsedMs.toFixed(0)
      } ms (${second.redis} serial L2 timeouts)`,
    );
  },
});

Deno.test({
  name:
    "Upstash unreachable: GET /healthz still answers 200 (after one 1.2 s public-limit timeout)",
  ...quiet,
  async fn() {
    const { response, elapsedMs, redis } = await timed(
      new Request("http://edge.audit.test/functions/v1/api/healthz", {
        headers: { "x-forwarded-for": "198.51.100.79" },
      }),
    );
    await response.body?.cancel();
    console.log(
      `[audit] redis-outage healthz: status=${response.status} l2Touches=${redis} elapsedMs=${
        elapsedMs.toFixed(0)
      }`,
    );
    assertEquals(response.status, 200);
    assertEquals(redis, 1);
    assert(
      elapsedMs >= 1_100 && elapsedMs < 2_000,
      `elapsed ${elapsedMs.toFixed(0)} ms`,
    );
  },
});

Deno.test({
  name: "teardown",
  ...quiet,
  fn() {
    globalThis.fetch = realFetch;
  },
});
