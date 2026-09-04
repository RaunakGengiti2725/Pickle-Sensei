// Adversarial reproductions against the XCF-02 fix in e84127cc (session
// revocation markers consulted on every auth-cache read).
//
// Each test states the contract the fix claims (index.ts logoutRoute /
// readAuthCache / writeAuthCache comments, cache.ts header: "a Redis outage
// can slow the cache down, never break a request") and FAILS on e84127cc.
// Like the sibling repros they are deliberately not auto-discovered:
//
//   cd supabase/functions/api/__wf__
//   deno test -A --no-check --config deno.json xc_rsm_c/repros/attack_e84127cc_repro.ts
//
// Everything is in-process: the REAL index.ts + cache.ts are loaded as edge
// isolates over the fake GoTrue/PostgREST/Upstash from ../fakeSupabase.ts.
// A Redis outage is injected by wrapping fetch for the Upstash URL only.

import { assert, assertEquals } from "@std/assert";
import { type EdgeIsolate, loadEdgeIsolate } from "../edgeIsolates.ts";
import { FakeSupabase, REDIS_URL } from "../fakeSupabase.ts";
import { fakeIdToken } from "../tokens.ts";

const IP = "10.99.1.1";
const USER = {
  id: "0000c0de-0000-4000-8000-0000000000a1",
  provider: "google" as const,
  subject: "attack-sub",
  email: "attack@example.test",
};

function request(
  isolate: EdgeIsolate,
  method: string,
  path: string,
  bearer: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "x-forwarded-for": IP };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return isolate.handler(
    new Request(`http://edge.test/functions/v1/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function bootstrap(
  fake: FakeSupabase,
  isolate: EdgeIsolate,
  nonce: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  fake.addUser(USER);
  const idToken = fakeIdToken("google", USER.subject, Math.floor(Date.now() / 1000) + 3600, nonce);
  const response = await request(isolate, "POST", "/v1/account/bootstrap", idToken);
  assertEquals(response.status, 200, "bootstrap must mint a session");
  const body = (await response.json()) as {
    session: { accessToken: string; refreshToken: string };
  };
  return body.session;
}

async function drain(response: Response): Promise<number> {
  await response.text();
  return response.status;
}

const getUserCalls = (fake: FakeSupabase): number =>
  fake.calls.filter((c) => c.kind === "getuser").length;

/** Redis outage: Upstash pipeline calls fail. `mode` picks how — an
 * immediate 503 (Upstash returning an error) or a hang until cache.ts's own
 * AbortSignal.timeout(REDIS_TIMEOUT_MS) fires (network black hole). `only`
 * narrows the outage to pipelines whose commands mention that substring so
 * the rate-limit keys (identical on 4d812e1a) can be kept healthy and the
 * cost of the auth-cache path measured on its own. */
function breakRedis(mode: "error" | "hang", only?: string): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(REDIS_URL)) return previous(input, init);
    if (only !== undefined && !String(init?.body ?? "").includes(only)) {
      return previous(input, init);
    }
    if (mode === "error") {
      return Promise.resolve(new Response('{"error":"upstream unavailable"}', { status: 503 }));
    }
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal ?? null;
      if (!signal) return;
      if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

let counter = 0;
async function withIsolates(
  count: number,
  body: (fake: FakeSupabase, isolates: EdgeIsolate[]) => Promise<void>,
): Promise<void> {
  const fake = new FakeSupabase();
  fake.install();
  try {
    const isolates: EdgeIsolate[] = [];
    for (let i = 0; i < count; i += 1) {
      counter += 1;
      isolates.push(await loadEdgeIsolate(`attack-${counter}`, { redis: true }));
    }
    await body(fake, isolates);
  } finally {
    fake.restore();
  }
}

Deno.test({
  name:
    "Redis outage must degrade to per-isolate caching, not disable the auth cache: a bearer verified and held in L1 is re-verified with Supabase Auth on EVERY request (index.ts readAuthCache → cacheRevoked null; regression vs 4d812e1a)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolates(1, async (fake, [solo]) => {
      const { accessToken } = await bootstrap(fake, solo, "redis-outage-l1");
      assertEquals(await drain(await request(solo, "GET", "/v1/me", accessToken)), 200);
      assertEquals(getUserCalls(fake), 1, "first use verifies with Auth and caches");
      assertEquals(await drain(await request(solo, "GET", "/v1/me", accessToken)), 200);
      assertEquals(getUserCalls(fake), 1, "healthy Redis: second request served from cache");

      const restore = breakRedis("error");
      try {
        for (let i = 0; i < 5; i += 1) {
          assertEquals(await drain(await request(solo, "GET", "/v1/me", accessToken)), 200);
        }
      } finally {
        restore();
      }
      // Contract (cache.ts header, 4d812e1a behaviour): the isolate keeps
      // serving its L1 copy while Redis is down. Observed on e84127cc: every
      // request round-trips Supabase Auth (5 more getUser calls) and nothing
      // is cached again until Redis is back.
      assertEquals(
        getUserCalls(fake),
        1,
        "L1 hit must not be re-verified with Auth because Redis is unreachable",
      );
    });
  },
});

Deno.test({
  name:
    "Redis black hole: an L1-cached bearer must not pay cache.ts's Redis timeout twice per request (readAuthCache + writeAuthCache each block on cacheRevoked; regression vs 4d812e1a)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolates(1, async (fake, [solo]) => {
      const { accessToken } = await bootstrap(fake, solo, "redis-outage-latency");
      assertEquals(await drain(await request(solo, "GET", "/v1/me", accessToken)), 200);
      // Only the auth-cache keys (`auth:…`, `auth-revoked:…`) black-hole; the
      // rate-limit keys stay healthy so the measurement isolates the auth path.
      const restore = breakRedis("hang", '"auth');
      try {
        const started = performance.now();
        assertEquals(await drain(await request(solo, "GET", "/v1/me", accessToken)), 200);
        const elapsedMs = performance.now() - started;
        // 4d812e1a: L1 hit → no Redis call on the auth path → milliseconds.
        // e84127cc: readAuthCache's cacheRevoked (1.2 s timeout) → getUser →
        // writeAuthCache's cacheRevoked (another 1.2 s) → ≥ 2.4 s for a
        // request whose bearer was fully cached in this isolate.
        assert(
          elapsedMs < 1_000,
          `a cached bearer took ${
            Math.round(elapsedMs)
          } ms while Redis hung (REDIS_TIMEOUT_MS=1200 paid per cacheRevoked call)`,
        );
      } finally {
        restore();
      }
    });
  },
});

Deno.test({
  name:
    "logout during a Redis blip answers 204 although the revocation marker and the L2 DEL were both lost: the bearer stays authorized on every other isolate for the full cache TTL (index.ts logoutRoute → cache.ts cacheRevoke/cacheDel swallow the failure)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolates(3, async (fake, [a, b, cold]) => {
      const { accessToken } = await bootstrap(fake, a, "logout-redis-blip");
      assertEquals(await drain(await request(a, "GET", "/v1/me", accessToken)), 200);
      assertEquals(await drain(await request(b, "GET", "/v1/me", accessToken)), 200, "B caches");

      const restore = breakRedis("error");
      let logoutStatus: number;
      try {
        logoutStatus = await drain(await request(a, "POST", "/v1/auth/logout", accessToken));
      } finally {
        restore();
      }
      assertEquals(fake.sessionOfToken(accessToken)?.revoked, true, "GoTrue revoked the session");

      // Contract (logoutRoute doc comment): "every bearer of that session —
      // this one on any isolate … stops working at this edge immediately".
      // Either the revocation is durable, or the client must be told the
      // sign-out did not take (5xx → the app retries). Observed: 204 AND the
      // marker is absent from L2, so B (L1) and a cold isolate (L2 entry the
      // failed DEL left behind) both keep answering 200 for up to 570 s.
      const bStatus = await drain(await request(b, "GET", "/v1/me", accessToken));
      const coldStatus = await drain(await request(cold, "GET", "/v1/me", accessToken));
      const markerInL2 = [...fake.redis.store.keys()].some((k) => k.startsWith("auth-revoked:"));
      assert(
        logoutStatus >= 500 || (bStatus === 401 && coldStatus === 401),
        `logout ${logoutStatus}; after it isolate B → ${bStatus}, cold isolate → ${coldStatus}; ` +
          `revocation marker in L2: ${markerInL2}`,
      );
      // The isolate that served the logout does refuse (its own L1 marker).
      assertEquals(await drain(await request(a, "GET", "/v1/me", accessToken)), 401, "A refuses");
    });
  },
});
