// Adversarial pass #4 (pass 3/3) — edge-auth-cache-ratelimit.
//
// Every scenario runs against the REAL handler (index.ts re-materialised per
// "isolate" by attack4_isolateHarness.ts) or the real cache.ts / rateLimit.ts
// modules, with Supabase Auth/PostgREST and Upstash Redis faked at the fetch
// layer. Tests tagged [defect] pin the CURRENT behaviour the pass found and
// state the expected behaviour in their comment — invert them when the fix
// lands. Untagged tests pin behaviour that HELD under attack.
//
// Measurements are printed as `ATTACK4 {...}` JSON lines for the report.
//
// Run: cd supabase/functions/api/__wf__ && deno task test
//   or: deno test -A --no-check --config deno.json attack4_edge_auth_cache_ratelimit_test.ts

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { captureAccessLog, clientIp, resolveRequestId, routeTemplate } from "../http.ts";
import { FAKE_REDIS_URL, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import {
  edgeRequest,
  googleIdToken,
  installFakeSupabase,
  loadEdgeIsolate,
  seededRandom,
  seededUuid,
  stubClock,
  supabaseAccessToken,
} from "./attack4_isolateHarness.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEED = Number(Deno.env.get("ATTACK4_SEED") ?? "20260904");

function report(scenario: string, data: Record<string, unknown>): void {
  console.log(`ATTACK4 ${JSON.stringify({ scenario, seed: SEED, ...data })}`);
}

function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const restore = captureAccessLog((line) => lines.push(line));
  return fn()
    .then((result) => ({ result, lines }))
    .finally(restore);
}

/** Records the Redis pipeline bodies that reach the fake (even when it hangs). */
function spyRedisBodies(): { bodies: Array<Array<Array<string | number>>>; restore(): void } {
  const inner = globalThis.fetch;
  const bodies: Array<Array<Array<string | number>>> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(FAKE_REDIS_URL)) {
      bodies.push(JSON.parse(String(init?.body ?? "[]")));
    }
    return inner(input, init);
  }) as typeof fetch;
  return {
    bodies,
    restore() {
      globalThis.fetch = inner;
    },
  };
}

// ─── Scenario 1: 1 201 clients with no IP headers share the "unknown" bucket ──

Deno.test("S1: 1 201 header-less clients share ONE 'unknown' per-IP bucket (1200/60s)", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const iso = await loadEdgeIsolate();
    const rand = seededRandom(SEED);
    const statuses = new Map<number, number>();
    let firstLimited = -1;
    let limitedResponse: Response | null = null;
    for (let i = 1; i <= 1201; i += 1) {
      // Each "client" is a distinct verified user (distinct bearer + user id):
      // the only thing they have in common is the missing IP headers.
      const token = supabaseAccessToken(seededUuid(rand));
      const response = await iso.handler(edgeRequest("GET", "/v1/me", { token, headers: {} }));
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      if (response.status === 429 && firstLimited < 0) {
        firstLimited = i;
        limitedResponse = response;
      } else {
        await response.body?.cancel();
      }
    }
    assertEquals(statuses.get(200), 1200, "the first 1 200 header-less clients all get through");
    assertEquals(firstLimited, 1201, "the 1 201st header-less client is the first one limited");
    assert(limitedResponse);
    assertEquals(limitedResponse.headers.get("RateLimit-Limit"), "1200", "the IP limit tripped");
    assertEquals((await limitedResponse.json()).error.code, "rate_limited");
    assertEquals(sb.getUserCalls, 1200, "the 1 201st never reached Supabase Auth");

    // White-box: the bucket everybody landed in is literally "unknown".
    const peek = await iso.rateLimit.peekRateLimit("ip", "unknown", 1200, 60);
    assertEquals(peek.allowed, false);
    assertEquals(peek.remaining, 0);

    // Header shapes that ALSO collapse to "unknown" (empty / whitespace hops).
    for (const headers of [
      { "x-forwarded-for": "" },
      { "x-forwarded-for": " , , " },
      { "cf-connecting-ip": "   " },
      { "cf-connecting-ip": "", "x-forwarded-for": "," },
    ]) {
      const req = edgeRequest("GET", "/v1/me", { headers });
      assertEquals(clientIp(req), "unknown", JSON.stringify(headers));
      const response = await iso.handler(req);
      assertEquals(response.status, 429, `${JSON.stringify(headers)} shares the exhausted bucket`);
      await response.body?.cancel();
    }
    // …while a client that DOES present an address is unaffected.
    const withIp = await iso.handler(
      edgeRequest("GET", "/v1/me", {
        token: supabaseAccessToken(seededUuid(rand)),
        headers: { "x-forwarded-for": "203.0.113.77" },
      }),
    );
    assertEquals(withIp.status, 200);
    await withIp.body?.cancel();
    report("S1", { statuses: Object.fromEntries(statuses), firstLimited, getUserCalls: sb.getUserCalls });
  } finally {
    sb.restore();
  }
});

Deno.test("S1b: 30 bad bearers with no IP headers lock EVERY header-less client out for 300 s", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const iso = await loadEdgeIsolate();
    for (let i = 0; i < 30; i += 1) {
      const response = await iso.handler(
        edgeRequest("GET", "/v1/me", { token: `garbage-${i}`, headers: {} }),
      );
      assertEquals(response.status, 401);
      await response.body?.cancel();
    }
    // A perfectly valid, never-seen user with no IP headers is now refused up
    // front (auth-failure budget peek) — one shared identity, one shared fate.
    const victim = await iso.handler(
      edgeRequest("GET", "/v1/me", { token: supabaseAccessToken(seededUuid(seededRandom(SEED + 1))) }),
    );
    assertEquals(victim.status, 429);
    assertEquals(victim.headers.get("RateLimit-Limit"), "30");
    const retryAfter = Number(victim.headers.get("Retry-After"));
    assert(retryAfter >= 1 && retryAfter <= 300, `Retry-After ${retryAfter}`);
    await victim.body?.cancel();
    assertEquals(sb.getUserCalls, 0, "the victim never reached Supabase Auth");
    report("S1b", { victimStatus: victim.status, retryAfter });
  } finally {
    sb.restore();
  }
});

// ─── Scenario 2: transitional provider-token branch mints one session per isolate ──

Deno.test("S2: same Google ID token on 3 isolates (no Redis) → signInWithIdToken ×3, 3 sessions", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const token = googleIdToken("11111111-1111-4111-8111-111111111111");
    const isolates = [await loadEdgeIsolate(), await loadEdgeIsolate(), await loadEdgeIsolate()];
    for (const iso of isolates) {
      const response = await iso.handler(
        edgeRequest("GET", "/v1/me", { token, headers: { "x-forwarded-for": "203.0.113.2" } }),
      );
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }
    assertEquals(sb.signInCalls, 3, "one exchange per isolate");
    assertEquals(new Set(sb.mintedSessions).size, 3, "three distinct Supabase sessions minted");
    // Warm repeats on each isolate are served from L1: no further exchanges.
    for (const iso of isolates) {
      const response = await iso.handler(
        edgeRequest("GET", "/v1/me", { token, headers: { "x-forwarded-for": "203.0.113.2" } }),
      );
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }
    assertEquals(sb.signInCalls, 3);
    report("S2-noredis", { isolates: 3, signInCalls: sb.signInCalls, sessions: sb.mintedSessions.length });
  } finally {
    sb.restore();
  }
});

Deno.test("S2b: same Google ID token on 3 isolates WITH Redis → one exchange (L2 shared)", async () => {
  configureRedis(true);
  const sb = installFakeSupabase();
  const redis = fakeUpstash();
  try {
    const token = googleIdToken("11111111-1111-4111-8111-111111111111");
    const isolates = [await loadEdgeIsolate(), await loadEdgeIsolate(), await loadEdgeIsolate()];
    for (const iso of isolates) {
      const response = await iso.handler(
        edgeRequest("GET", "/v1/me", { token, headers: { "x-forwarded-for": "203.0.113.2" } }),
      );
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }
    assertEquals(sb.signInCalls, 1, "L2 shares the verified session across isolates");
    report("S2-redis", { isolates: 3, signInCalls: sb.signInCalls });
  } finally {
    redis.restore();
    sb.restore();
  }
});

Deno.test(
  "[defect] S2c: N concurrent cold requests with ONE provider token mint N sessions (no in-flight dedupe)",
  async () => {
    // Expected: a cold isolate should exchange a given ID token at most once
    // even under a concurrent burst (in-flight coalescing). Observed: every
    // concurrent request performs its own signInWithIdToken → N Supabase
    // sessions (auth.sessions + refresh_tokens rows) for one device. The fake
    // Auth answers with 20 ms of latency (a zero-latency fake completes the
    // first exchange inside one microtask checkpoint and hides the herd).
    configureRedis(false);
    const sb = installFakeSupabase({ latencyMs: 20 });
    try {
      const iso = await loadEdgeIsolate();
      const token = googleIdToken("33333333-3333-4333-8333-333333333333");
      const burst = 25;
      const responses = await Promise.all(
        Array.from({ length: burst }, () =>
          iso.handler(
            edgeRequest("GET", "/v1/me", { token, headers: { "x-forwarded-for": "203.0.113.3" } }),
          ),
        ),
      );
      for (const response of responses) {
        assertEquals(response.status, 200);
        await response.body?.cancel();
      }
      assertEquals(sb.signInCalls, burst, "[defect] one exchange per concurrent request");
      assertEquals(new Set(sb.mintedSessions).size, burst);

      // Same shape for Supabase access tokens: N concurrent cold requests → N getUser calls.
      const access = supabaseAccessToken("44444444-4444-4444-8444-444444444444");
      const more = await Promise.all(
        Array.from({ length: burst }, () =>
          iso.handler(
            edgeRequest("GET", "/v1/me", { token: access, headers: { "x-forwarded-for": "203.0.113.3" } }),
          ),
        ),
      );
      for (const response of more) await response.body?.cancel();
      assertEquals(sb.getUserCalls, burst, "[defect] one getUser per concurrent request");
      report("S2c-herd", { burst, signInCalls: sb.signInCalls, getUserCalls: sb.getUserCalls });
    } finally {
      sb.restore();
    }
  },
);

Deno.test(
  "[defect] S2d: logout with a provider ID token bearer never revokes the session the transitional branch minted",
  async () => {
    // Expected: POST /v1/auth/logout ends the calling device's Supabase
    // session. Observed for a pre-contract build (provider token as bearer):
    // the cache entry is dropped and Supabase is asked to log out the
    // PROVIDER token (not a Supabase JWT → "already gone" → 204), while the
    // session signInWithIdToken minted for that request lives on untouched.
    configureRedis(false);
    const sb = installFakeSupabase();
    try {
      const iso = await loadEdgeIsolate();
      const token = googleIdToken("55555555-5555-4555-8555-555555555555");
      const ip = { "x-forwarded-for": "203.0.113.5" };
      const me = await iso.handler(edgeRequest("GET", "/v1/me", { token, headers: ip }));
      assertEquals(me.status, 200);
      await me.body?.cancel();
      assertEquals(sb.mintedSessions.length, 1);
      const minted = sb.mintedSessions[0];

      const logout = await iso.handler(edgeRequest("POST", "/v1/auth/logout", { token, headers: ip }));
      assertEquals(logout.status, 204);
      assertEquals(sb.logoutCalls, 1);
      assertEquals(sb.revoked.has(token), true, "Supabase was asked to log out the PROVIDER token");
      assertEquals(sb.revoked.has(minted), false, "[defect] the minted Supabase session is never revoked");
      report("S2d-logout-provider", { minted: 1, revokedMinted: sb.revoked.has(minted) });
    } finally {
      sb.restore();
    }
  },
);

// ─── Scenario 3: x-request-id echo vs mint; routeTemplate never sees the header ──

Deno.test("S3: x-request-id 8 digits / 64 / 65 / '../../etc' / 200 chars — echo vs mint per REQUEST_ID_RE", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const iso = await loadEdgeIsolate();
    const cases: Array<{ value: string; echo: boolean }> = [
      { value: "12345678", echo: true },
      { value: "a".repeat(64), echo: true },
      { value: "a".repeat(65), echo: false },
      { value: "../../etc", echo: false },
      { value: "x".repeat(200), echo: false },
      { value: "1234567890123456", echo: true }, // digit run ≥4: must NOT become ":id"
      { value: "11111111-1111-4111-8111-111111111111", echo: true }, // uuid-shaped: must NOT become ":id"
      { value: "réquest-id-1", echo: false }, // Latin-1 but outside the class
      { value: "abcdefg", echo: false }, // 7 chars
      { value: "abcd efgh", echo: false },
    ];
    let n = 0;
    for (const { value, echo } of cases) {
      n += 1;
      const request = edgeRequest("GET", "/healthz", {
        headers: { "x-request-id": value, "x-forwarded-for": `198.51.100.${n}` },
      });
      const { result: response, lines } = await captureLogs(() => iso.handler(request));
      assertEquals(response.status, 200);
      await response.body?.cancel();
      const echoed = response.headers.get("x-request-id") ?? "";
      assertEquals(lines.length, 1, "exactly one access line");
      const entry = JSON.parse(lines[0]);
      if (echo) {
        assertEquals(echoed, value, `echo ${JSON.stringify(value)}`);
        assertEquals(entry.requestId, value, "logged verbatim (routeTemplate never touched it)");
      } else {
        assertMatch(echoed, UUID, `mint for ${JSON.stringify(value.slice(0, 20))}`);
        assertEquals(entry.requestId, echoed);
        assert(!lines[0].includes(value), "a rejected header value never reaches the log");
      }
      assertEquals(entry.route, "/functions/v1/api/healthz", "route is derived from the path only");
      if (echo) assertEquals(resolveRequestId(request), value);
      else assertMatch(resolveRequestId(request), UUID);
    }
    // Duplicate header → Headers joins with ", " → outside the class → minted.
    const dup = new Request("http://edge.test/functions/v1/api/healthz", {
      headers: [
        ["x-request-id", "abcdefgh"],
        ["x-request-id", "ijklmnop"],
        ["x-forwarded-for", "198.51.100.99"],
      ],
    });
    const dupRes = await iso.handler(dup);
    await dupRes.body?.cancel();
    assertMatch(dupRes.headers.get("x-request-id") ?? "", UUID);
    // routeTemplate is a pure function of the pathname; a header-like value in
    // a PATH segment is collapsed, the header itself never is.
    assertEquals(routeTemplate("/v1/x/12345678"), "/v1/x/:id");
    report("S3", { cases: cases.length });
  } finally {
    sb.restore();
  }
});

// ─── Scenario 4: half-configured Redis is "not configured" — zero fetches ──

Deno.test("S4: URL set + empty token (and token set + empty URL) → redisConfigured() false, no fetch", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetches += 1;
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    for (const [url, token] of [
      [FAKE_REDIS_URL, ""],
      ["", "some-token"],
      ["", ""],
    ]) {
      Deno.env.set("UPSTASH_REDIS_REST_URL", url);
      Deno.env.set("UPSTASH_REDIS_REST_TOKEN", token);
      const iso = await loadIsolate();
      assertEquals(iso.cache.redisConfigured(), false, `url=${JSON.stringify(url)} token=${JSON.stringify(token)}`);
      fetches = 0;
      await iso.cache.cacheSet("k", "v", 60);
      assertEquals(await iso.cache.cacheGet("k"), "v");
      assertEquals(await iso.cache.cacheGet("missing"), null);
      await iso.cache.cacheDel("k");
      assertEquals(await iso.cache.redisWindowIncr("rl:x", 60), null);
      assertEquals(await iso.cache.redisWindowGet("rl:x"), null);
      const rl = await iso.rateLimit.enforceRateLimit("s", "id", 3, 60);
      assertEquals(rl.allowed, true);
      assertEquals(fetches, 0, "no Redis fetch attempted");
    }
    report("S4", { fetches });
  } finally {
    globalThis.fetch = realFetch;
    configureRedis(false);
  }
});

Deno.test("S4b: a MALFORMED Redis URL/token is 'configured' and fails open silently (no log line)", async () => {
  // Whitespace-only URL, or a URL whose /pipeline endpoint 404s: every call
  // is attempted, fails, and is swallowed with no console output at all — an
  // operator cannot tell from the function logs that cache + rate limits
  // degraded to per-isolate memory.
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realWarn = console.warn;
  let logged = 0;
  console.error = () => void (logged += 1);
  console.warn = () => void (logged += 1);
  let fetches = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetches += 1;
    if (url.startsWith("https://misconfigured.test")) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    for (const url of [" ", "https://misconfigured.test/"]) {
      Deno.env.set("UPSTASH_REDIS_REST_URL", url);
      Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "tok");
      const iso = await loadIsolate();
      assertEquals(iso.cache.redisConfigured(), true, JSON.stringify(url));
      fetches = 0;
      logged = 0;
      assertEquals(await iso.cache.redisWindowIncr("rl:x", 60), null);
      assertEquals(await iso.cache.cacheGet("nope"), null);
      const rl = await iso.rateLimit.enforceRateLimit("s", "id", 1, 60);
      assertEquals(rl.allowed, true);
      assert(fetches >= 2, `fetch attempted (${fetches})`);
      assertEquals(logged, 0, "nothing logged about the failing Redis backend");
    }
    report("S4b", { fetches, logged });
  } finally {
    console.error = realError;
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    configureRedis(false);
  }
});

// ─── Scenario 5: Redis hang through the real handler ──

Deno.test(
  "[defect] S5: Redis hang → warm request +3×1.2 s, cold request +5×1.2 s (auth L1 hit issues no Redis GET)",
  async () => {
    // Expected: a Redis outage costs at most ONE bounded timeout per request
    // (breaker / shared in-flight probe). Observed: every L2 call on the path
    // (ip INCR, authfail GET, [auth GET], [auth SET], user INCR) pays the full
    // 1 200 ms AbortSignal.timeout sequentially.
    configureRedis(true);
    const sb = installFakeSupabase();
    const redis = fakeUpstash();
    const spy = spyRedisBodies();
    try {
      const iso = await loadEdgeIsolate();
      const ip = { "x-forwarded-for": "203.0.113.50" };
      const warmToken = supabaseAccessToken("66666666-6666-4666-8666-666666666666");
      // Warm the auth L1 with Redis healthy.
      const warm = await iso.handler(edgeRequest("GET", "/v1/me", { token: warmToken, headers: ip }));
      assertEquals(warm.status, 200);
      await warm.body?.cancel();
      assertEquals(sb.getUserCalls, 1);

      redis.hang = true;
      spy.bodies.length = 0;
      const callsBefore = redis.calls;
      let t0 = performance.now();
      const hit = await iso.handler(edgeRequest("GET", "/v1/me", { token: warmToken, headers: ip }));
      const warmMs = performance.now() - t0;
      assertEquals(hit.status, 200, "fail-open: the request still succeeds");
      await hit.body?.cancel();
      assertEquals(sb.getUserCalls, 1, "auth served from L1 — Supabase not consulted");
      const warmCalls = redis.calls - callsBefore;
      const warmCmds = spy.bodies.map((b) => b.map((c) => String(c[0])).join("+"));
      assertEquals(warmCalls, 3, `ip INCR, authfail GET, user INCR — got ${warmCmds.join(",")}`);
      assert(
        !spy.bodies.some((b) => b.some((c) => String(c[1] ?? "").startsWith("auth:"))),
        "an L1 auth hit performs no Redis call for the auth key",
      );
      assert(warmMs >= 3 * 1_150, `[defect] warm request took ${warmMs.toFixed(0)} ms (≥3 timeouts)`);

      spy.bodies.length = 0;
      const coldToken = supabaseAccessToken("77777777-7777-4777-8777-777777777777");
      const before2 = redis.calls;
      t0 = performance.now();
      const cold = await iso.handler(edgeRequest("GET", "/v1/me", { token: coldToken, headers: ip }));
      const coldMs = performance.now() - t0;
      assertEquals(cold.status, 200);
      await cold.body?.cancel();
      assertEquals(sb.getUserCalls, 2);
      const coldCalls = redis.calls - before2;
      const coldCmds = spy.bodies.map((b) => b.map((c) => String(c[0])).join("+"));
      assertEquals(coldCalls, 5, `got ${coldCmds.join(",")}`);
      assert(coldMs >= 5 * 1_150, `[defect] cold request took ${coldMs.toFixed(0)} ms (≥5 timeouts)`);
      report("S5-hang", {
        warmMs: Math.round(warmMs),
        warmRedisCalls: warmCalls,
        warmCmds,
        coldMs: Math.round(coldMs),
        coldRedisCalls: coldCalls,
        coldCmds,
      });
    } finally {
      spy.restore();
      redis.restore();
      sb.restore();
    }
  },
);

// ─── Scenario 6: corrupt auth cache values ──

Deno.test("S6: corrupt auth:<hash> values fall through to getUser without throwing, then self-heal", async () => {
  configureRedis(true);
  const sb = installFakeSupabase();
  const redis = fakeUpstash();
  try {
    const ip = { "x-forwarded-for": "203.0.113.60" };
    const corrupt: Array<[string, string]> = [
      ["not-json", "{not json"],
      ["null", "null"],
      ["expires-string", JSON.stringify({ expiresAtMs: "soon" })],
      ["string", '"just a string"'],
      ["array", "[]"],
      ["number", "42"],
      ["empty-object", "{}"],
      ["past", JSON.stringify({ userId: "x", provider: "google", accessToken: "t", expiresAtMs: 1 })],
    ];
    const results: Record<string, unknown> = {};
    let n = 0;
    for (const [name, value] of corrupt) {
      n += 1;
      const iso = await loadEdgeIsolate(); // cold L1 every time → the corrupt L2 value is what it reads
      const sub = `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
      for (const [kind, token] of [
        ["access", supabaseAccessToken(sub)],
        ["provider", googleIdToken(sub)],
      ] as Array<[string, string]>) {
        const key = `auth:${await iso.cache.sha256Hex(token)}`;
        redis.store.set(key, { value, expiresAtMs: Date.now() + 300_000 });
        const before = { getUser: sb.getUserCalls, signIn: sb.signInCalls };
        const { result: response, lines } = await captureLogs(() =>
          iso.handler(edgeRequest("GET", "/v1/me", { token, headers: ip })),
        );
        const body = await response.json();
        assertEquals(response.status, 200, `${name}/${kind}: ${JSON.stringify(body)}`);
        assertEquals(body.user.id, sub);
        assertEquals(JSON.parse(lines[0]).status, 200);
        if (kind === "access") assertEquals(sb.getUserCalls, before.getUser + 1, `${name}: fell through to getUser`);
        else assertEquals(sb.signInCalls, before.signIn + 1, `${name}: fell through to signInWithIdToken`);
        const healed = redis.store.get(key)?.value ?? "";
        const parsed = JSON.parse(healed);
        assertEquals(parsed.userId, sub, `${name}/${kind}: L2 entry overwritten with a valid one`);
        results[`${name}/${kind}`] = "fell-through";
      }
    }
    report("S6", results);
  } finally {
    redis.restore();
    sb.restore();
  }
});

Deno.test(
  "[defect] S6b: a parseable auth entry with a future expiresAtMs but MISSING provider/userId is trusted on the access-token path",
  async () => {
    // Expected: readAuthCache validates the shape (userId/accessToken strings,
    // provider ∈ {google, apple}) and falls through to getUser otherwise.
    // Observed: for a Supabase access token (provider === null short-circuits
    // the provider check) any object with expiresAtMs > now+5s is served —
    // provider undefined, and with userId missing the request proceeds as
    // user `undefined` (PostgREST then fails → 503, never 401), and because
    // the entry is ACCEPTED it is never rewritten, so it sticks until its
    // Redis TTL. The provider-token path rejects the same entries.
    configureRedis(true);
    const sb = installFakeSupabase();
    const redis = fakeUpstash();
    try {
      const iso = await loadEdgeIsolate();
      const ip = { "x-forwarded-for": "203.0.113.61" };
      const sub = "88888888-8888-4888-8888-888888888888";
      const token = supabaseAccessToken(sub);
      const key = `auth:${await iso.cache.sha256Hex(token)}`;

      // (a) missing provider — accepted, getUser never called, provider undefined.
      const noProvider = JSON.stringify({
        userId: sub,
        email: null,
        accessToken: token,
        expiresAtMs: Date.now() + 500_000,
      });
      redis.store.set(key, { value: noProvider, expiresAtMs: Date.now() + 300_000 });
      const a = await iso.handler(edgeRequest("GET", "/v1/me", { token, headers: ip }));
      assertEquals(a.status, 200);
      await a.body?.cancel();
      assertEquals(sb.getUserCalls, 0, "[defect] served from the provider-less entry, Supabase never asked");
      assertEquals(redis.store.get(key)?.value, noProvider, "[defect] entry not healed (it was accepted)");

      // (b) only expiresAtMs — accepted as user undefined → downstream 503, sticks.
      const iso2 = await loadEdgeIsolate();
      const only = JSON.stringify({ expiresAtMs: Date.now() + 500_000 });
      redis.store.set(key, { value: only, expiresAtMs: Date.now() + 300_000 });
      const b = await iso2.handler(edgeRequest("GET", "/v1/me", { token, headers: ip }));
      const bBody = await b.json();
      assertEquals(b.status, 503, `[defect] ${JSON.stringify(bBody)}`);
      assertEquals(sb.getUserCalls, 0);
      const bAgain = await iso2.handler(edgeRequest("GET", "/v1/me", { token, headers: ip }));
      assertEquals(bAgain.status, 503, "[defect] sticks: L1 now holds the poisoned entry");
      await bAgain.body?.cancel();

      // Contrast: the SAME entries on the provider-token path fall through.
      const iso3 = await loadEdgeIsolate();
      const gtoken = googleIdToken(sub);
      const gkey = `auth:${await iso3.cache.sha256Hex(gtoken)}`;
      redis.store.set(gkey, { value: noProvider, expiresAtMs: Date.now() + 300_000 });
      const c = await iso3.handler(edgeRequest("GET", "/v1/me", { token: gtoken, headers: ip }));
      assertEquals(c.status, 200);
      await c.body?.cancel();
      assertEquals(sb.signInCalls, 1, "provider path re-verified");
      report("S6b", { accessNoProvider: a.status, accessOnlyExpiry: b.status, getUserCalls: sb.getUserCalls });
    } finally {
      redis.restore();
      sb.restore();
    }
  },
);

// ─── Scenario 7: bucket boundary — fixed-window 2× burst, Retry-After ≥ 1 ──

for (const withRedis of [false, true]) {
  Deno.test(`S7: 3/60s scope at a bucket boundary (redis=${withRedis}) — 3 pass, 3 more pass 2 ms later, Retry-After ≥ 1`, async () => {
    configureRedis(withRedis);
    const redis = withRedis ? fakeUpstash() : null;
    const boundary = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
    const clock = stubClock(boundary - 1);
    try {
      const iso = await loadIsolate();
      const results: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await iso.rateLimit.enforceRateLimit("s7", "client", 3, 60);
        assertEquals(r.allowed, true, `hit ${i + 1} in bucket A`);
        assert(r.retryAfterSeconds >= 1);
        results.push(r.remaining);
      }
      const denied = await iso.rateLimit.enforceRateLimit("s7", "client", 3, 60);
      assertEquals(denied.allowed, false);
      assertEquals(denied.remaining, 0);
      assertEquals(denied.retryAfterSeconds, 1, "1 ms before the boundary rounds UP to 1 s, never 0");
      const rl429 = iso.rateLimit.rateLimitResponse(denied);
      assertEquals(rl429.headers.get("Retry-After"), "1");

      clock.advance(2); // now boundary + 1 ms → next bucket
      for (let i = 0; i < 3; i += 1) {
        const r = await iso.rateLimit.enforceRateLimit("s7", "client", 3, 60);
        assertEquals(r.allowed, true, `hit ${i + 1} in bucket B (fixed window admits a 2× burst)`);
      }
      const denied2 = await iso.rateLimit.enforceRateLimit("s7", "client", 3, 60);
      assertEquals(denied2.allowed, false);
      assertEquals(denied2.retryAfterSeconds, 60, "a full window remains (ceil(59.999))");

      // Exactly ON the boundary and at seeded offsets across the window:
      // Retry-After is always an integer in [1, window].
      const rand = seededRandom(SEED + 7);
      const offsets = [0, 1, 59_999, 30_000, ...Array.from({ length: 50 }, () => Math.floor(rand() * 60_000))];
      let minRetry = Infinity;
      let maxRetry = -Infinity;
      for (const offset of offsets) {
        clock.advance((boundary + 120_000 + offset) - Date.now());
        const probe = await iso.rateLimit.peekRateLimit("s7", `probe-${offset}`, 3, 60);
        assert(Number.isInteger(probe.retryAfterSeconds), `integer at +${offset}ms`);
        assert(probe.retryAfterSeconds >= 1 && probe.retryAfterSeconds <= 60, `at +${offset}ms → ${probe.retryAfterSeconds}`);
        minRetry = Math.min(minRetry, probe.retryAfterSeconds);
        maxRetry = Math.max(maxRetry, probe.retryAfterSeconds);
      }
      report(`S7-redis=${withRedis}`, { remainingA: results, minRetry, maxRetry, probes: offsets.length });
    } finally {
      clock.restore();
      redis?.restore();
      configureRedis(false);
    }
  });
}

Deno.test("S7b: server clock stepping BACKWARDS re-opens an exhausted window (memory + Redis)", async () => {
  // Clock skew between isolates (or an NTP step) maps to different bucket
  // keys, so a limit becomes bucket-per-clock. Documented here as a
  // measurement: only the server's own clock is involved, never a client's.
  configureRedis(true);
  const redis = fakeUpstash();
  const start = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 30_000;
  const clock = stubClock(start);
  try {
    const iso = await loadIsolate();
    for (let i = 0; i < 3; i += 1) assertEquals((await iso.rateLimit.enforceRateLimit("skew", "c", 3, 60)).allowed, true);
    assertEquals((await iso.rateLimit.enforceRateLimit("skew", "c", 3, 60)).allowed, false);
    clock.advance(-60_000); // step back one minute → previous bucket key
    const reopened = await iso.rateLimit.enforceRateLimit("skew", "c", 3, 60);
    assertEquals(reopened.allowed, true, "a 60 s backwards step lands in an untouched bucket");
    report("S7b-skew", { reopenedAfterBackStep: reopened.allowed });
  } finally {
    clock.restore();
    redis.restore();
    configureRedis(false);
  }
});

// ─── Scenario 8: 429 via rateLimitResponse — errorCodeOf logs, body stays readable ──

Deno.test("S8: a real 429 logs code=rate_limited and the client body is still readable (clone semantics)", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const iso = await loadEdgeIsolate();
    const ip = { "x-forwarded-for": "203.0.113.80" };
    for (let i = 0; i < 60; i += 1) {
      const ok = await iso.handler(edgeRequest("GET", "/healthz", { headers: ip }));
      assertEquals(ok.status, 200);
      await ok.body?.cancel();
    }
    const { result: limited, lines } = await captureLogs(() =>
      iso.handler(edgeRequest("GET", "/healthz", { headers: { ...ip, "x-request-id": "attack4-s8-rid" } })),
    );
    assertEquals(limited.status, 429);
    assertEquals(limited.bodyUsed, false, "the outer handler did not consume the client body");
    assertEquals(limited.headers.get("x-request-id"), "attack4-s8-rid");
    assertEquals(limited.headers.get("Content-Type"), "application/json");
    assertEquals(limited.headers.get("Cache-Control"), "no-store");
    assertEquals(limited.headers.get("X-Content-Type-Options"), "nosniff");
    assertEquals(limited.headers.get("RateLimit-Limit"), "60");
    assertEquals(limited.headers.get("RateLimit-Remaining"), "0");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    assert(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
    const body = await limited.json();
    assertEquals(body.error.code, "rate_limited");
    assertEquals(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assertEquals(entry.status, 429);
    assertEquals(entry.code, "rate_limited");
    assertEquals(entry.requestId, "attack4-s8-rid");
    assertEquals(entry.route, "/functions/v1/api/healthz");
    assertEquals(Object.keys(entry).sort(), ["code", "durationMs", "evt", "method", "requestId", "route", "status"]);

    // Same contract for the auth-failure 429 (peek-gated pre-auth path).
    const ip2 = { "x-forwarded-for": "203.0.113.81" };
    for (let i = 0; i < 30; i += 1) {
      const bad = await iso.handler(edgeRequest("GET", "/v1/me", { token: `bad-${i}`, headers: ip2 }));
      assertEquals(bad.status, 401);
      await bad.body?.cancel();
    }
    const { result: authLimited, lines: authLines } = await captureLogs(() =>
      iso.handler(edgeRequest("GET", "/v1/me", { token: "bad-31", headers: ip2 })),
    );
    assertEquals(authLimited.status, 429);
    assertEquals((await authLimited.json()).error.code, "rate_limited");
    assertEquals(JSON.parse(authLines[0]).code, "rate_limited");
    report("S8", { retryAfter, logged: entry });
  } finally {
    sb.restore();
  }
});

// ─── Scenario 9: cross-isolate logout revocation latency ──

Deno.test(
  "[defect] S9: bearer verified in isolate A, warmed in B, logged out in B — A keeps accepting it for ~565 s (not ≤60 s)",
  async () => {
    // Expected: after POST /v1/auth/logout on any isolate, every isolate
    // refuses the bearer within ≤60 s (the L2→L1 warm cap). Observed: the
    // isolate that performed the ORIGINAL verification wrote its L1 copy via
    // cacheSet with the FULL ttl (≈570 s), so only L2-warmed isolates honour
    // the 60 s bound; the verifying isolate serves the revoked session until
    // its own L1 entry expires (~9.4 min).
    configureRedis(true);
    const sb = installFakeSupabase();
    const redis = fakeUpstash();
    const clock = stubClock(Date.now());
    try {
      const a = await loadEdgeIsolate();
      const b = await loadEdgeIsolate();
      const c = await loadEdgeIsolate();
      const ip = { "x-forwarded-for": "203.0.113.90" };
      const token = supabaseAccessToken("99999999-9999-4999-8999-999999999999");
      const me = (iso: typeof a) => iso.handler(edgeRequest("GET", "/v1/me", { token, headers: ip }));

      const ra = await me(a);
      assertEquals(ra.status, 200);
      await ra.body?.cancel();
      assertEquals(sb.getUserCalls, 1, "A verified with Supabase");
      for (const iso of [b, c]) {
        const r = await me(iso);
        assertEquals(r.status, 200);
        await r.body?.cancel();
      }
      assertEquals(sb.getUserCalls, 1, "B and C warmed from Redis");

      const logout = await b.handler(edgeRequest("POST", "/v1/auth/logout", { token, headers: ip }));
      assertEquals(logout.status, 204);
      assertEquals(sb.revoked.has(token), true, "Supabase revoked the session");
      assertEquals([...redis.store.keys()].some((k) => k.startsWith("auth:")), false, "L2 entry deleted");

      // t+0: B refuses (own L1 dropped), A and C still accept (stale L1).
      const rb = await me(b);
      assertEquals(rb.status, 401);
      await rb.body?.cancel();
      const ra0 = await me(a);
      assertEquals(ra0.status, 200, "[defect] A serves the revoked bearer at t+0");
      await ra0.body?.cancel();
      const rc0 = await me(c);
      assertEquals(rc0.status, 200, "C (warmed from L2) still holds its ≤60 s copy at t+0");
      await rc0.body?.cancel();

      // t+61 s: the L2-warmed isolate C now refuses; A still accepts.
      clock.advance(61_000);
      const rc61 = await me(c);
      assertEquals(rc61.status, 401, "C refuses within the 60 s L2→L1 cap");
      await rc61.body?.cancel();
      const ra61 = await me(a);
      assertEquals(ra61.status, 200, "[defect] A STILL serves the revoked bearer at t+61 s");
      await ra61.body?.cancel();

      // Find the moment A finally refuses (≈ ttl 570 s − the 5 s freshness margin ≈ 565 s).
      let refusedAtSeconds = -1;
      let elapsedMs = 61_000;
      for (let t = 90; t <= 600; t += 30) {
        clock.advance(t * 1_000 - elapsedMs);
        elapsedMs = t * 1_000;
        const r = await me(a);
        await r.body?.cancel();
        if (r.status === 401) {
          refusedAtSeconds = t;
          break;
        }
      }
      assert(refusedAtSeconds > 60, `[defect] A refused only at t+${refusedAtSeconds}s`);
      assert(refusedAtSeconds <= 600, `A must refuse once the 10-minute cap passes (t+${refusedAtSeconds}s)`);
      report("S9-redis", { aRefusedAtSeconds: refusedAtSeconds, cRefusedWithinSeconds: 61, bRefusedAt: 0 });
    } finally {
      clock.restore();
      redis.restore();
      sb.restore();
    }
  },
);

Deno.test("[defect] S9b: without Upstash, logout on isolate B never reaches isolate A at all (A accepts ~565 s)", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  const clock = stubClock(Date.now());
  try {
    const a = await loadEdgeIsolate();
    const b = await loadEdgeIsolate();
    const ip = { "x-forwarded-for": "203.0.113.91" };
    const token = supabaseAccessToken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const me = (iso: typeof a) => iso.handler(edgeRequest("GET", "/v1/me", { token, headers: ip }));
    for (const iso of [a, b]) {
      const r = await me(iso);
      assertEquals(r.status, 200);
      await r.body?.cancel();
    }
    assertEquals(sb.getUserCalls, 2, "each isolate verified on its own (no L2)");
    const logout = await b.handler(edgeRequest("POST", "/v1/auth/logout", { token, headers: ip }));
    assertEquals(logout.status, 204);
    clock.advance(61_000);
    const ra = await me(a);
    assertEquals(ra.status, 200, "[defect] A serves the revoked bearer 61 s after logout");
    await ra.body?.cancel();
    clock.advance(600_000 - 61_000);
    const raLate = await me(a);
    assertEquals(raLate.status, 401, "A refuses once its own L1 entry expires");
    await raLate.body?.cancel();
    report("S9b-noredis", { aAt61s: ra.status, aAt600s: raLate.status });
  } finally {
    clock.restore();
    sb.restore();
  }
});

// ─── Extra scenarios ──

Deno.test("X1: clientIp trusts the LAST x-forwarded-for hop and any cf-connecting-ip verbatim (no format check)", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const iso = await loadEdgeIsolate();
    assertEquals(clientIp(edgeRequest("GET", "/", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })), "2.2.2.2");
    assertEquals(clientIp(edgeRequest("GET", "/", { headers: { "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" } })), "9.9.9.9");
    const junk = "not an ip at all; " + "A".repeat(8_000);
    assertEquals(clientIp(edgeRequest("GET", "/", { headers: { "cf-connecting-ip": junk } })), junk.trim());
    // Through the handler: the 8 KB junk becomes the rate-limit identity.
    const res = await iso.handler(edgeRequest("GET", "/healthz", { headers: { "cf-connecting-ip": junk } }));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const peek = await iso.rateLimit.peekRateLimit("healthz", junk.trim(), 60, 60);
    assertEquals(peek.remaining, 59, "a window keyed by the 8 KB header value now exists");
    report("X1", { junkKeyBytes: junk.trim().length });
  } finally {
    sb.restore();
  }
});

Deno.test("X2: memory rate-limit map with 20 000 distinct 8 KB identities — heap growth measured, then wipe", async () => {
  configureRedis(false);
  const iso = await loadIsolate();
  const rand = seededRandom(SEED + 2);
  // A legitimate client exhausts its window first…
  for (let i = 0; i < 3; i += 1) await iso.rateLimit.enforceRateLimit("ip", "203.0.113.200", 3, 60);
  assertEquals((await iso.rateLimit.enforceRateLimit("ip", "203.0.113.200", 3, 60)).allowed, false);
  const before = Deno.memoryUsage().heapUsed;
  const filler = "A".repeat(8_000);
  let idBytes = 0;
  for (let i = 0; i < 19_999; i += 1) {
    const id = `${filler}${Math.floor(rand() * 1e9)}-${i}`;
    idBytes += id.length;
    const r = await iso.rateLimit.enforceRateLimit("ip", id, 1200, 60);
    assertEquals(r.allowed, true);
  }
  const after = Deno.memoryUsage().heapUsed;
  const heapMb = (after - before) / 1_048_576;
  // …the map now holds 20 000 live windows (≈160 MB of keys); still exhausted.
  assertEquals((await iso.rateLimit.enforceRateLimit("ip", "203.0.113.200", 3, 60)).allowed, false);
  // The next DISTINCT identity finds the map full with nothing expired → clear() (known [defect]).
  await iso.rateLimit.enforceRateLimit("ip", `${filler}-overflow`, 1200, 60);
  const reopened = await iso.rateLimit.enforceRateLimit("ip", "203.0.113.200", 3, 60);
  assertEquals(reopened.allowed, true, "[defect] every live window was wiped by the overflow");
  assertEquals(reopened.remaining, 2, "the exhausted client starts a fresh count");
  report("X2", { entries: 20_000, idBytesTotal: idBytes, heapGrowthMb: Math.round(heapMb) });
});

Deno.test("X3: 40 concurrent bad bearers from one cold IP all reach auth (peek gate) but are all counted; 41st is 429", async () => {
  configureRedis(true);
  const sb = installFakeSupabase();
  const redis = fakeUpstash();
  try {
    const iso = await loadEdgeIsolate();
    const ip = { "x-forwarded-for": "203.0.113.120" };
    sb.getUserStatus = 401; // every bearer is refused by Supabase Auth
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        iso.handler(edgeRequest("GET", "/v1/me", { token: supabaseAccessToken(`bad-${i}`), headers: ip })),
      ),
    );
    const statuses = responses.map((r) => r.status);
    for (const r of responses) await r.body?.cancel();
    const first = statuses.filter((s) => s === 401).length;
    const limited = statuses.filter((s) => s === 429).length;
    assertEquals(first + limited, 40);
    const bucket = Math.floor(Date.now() / 300_000);
    const count = Number(redis.store.get(`rl:authfail:${bucket}:203.0.113.120`)?.value ?? "0");
    assertEquals(count, first, "every 401 was counted atomically (INCR)");
    const next = await iso.handler(edgeRequest("GET", "/v1/me", { token: supabaseAccessToken("bad-x"), headers: ip }));
    assertEquals(next.status, 429);
    await next.body?.cancel();
    report("X3", { concurrent: 40, reachedAuth: first, limitedInBurst: limited, counted: count });
  } finally {
    redis.restore();
    sb.restore();
  }
});

Deno.test("X4: 413 (content-length) and unknown-route responses carry x-request-id and one access line", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const iso = await loadEdgeIsolate();
    const big = new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
      method: "PUT",
      headers: { "content-length": "6000000", "x-forwarded-for": "203.0.113.130", "x-request-id": "attack4-x4-413" },
    });
    const { result: r413, lines } = await captureLogs(() => iso.handler(big));
    assertEquals(r413.status, 413);
    assertEquals(r413.headers.get("x-request-id"), "attack4-x4-413");
    assertEquals(JSON.parse(lines[0]).status, 413);
    assertEquals(JSON.parse(lines[0]).code, undefined);
    assertEquals((await r413.json()).error.message, "Request body is too large.");

    const { result: r404, lines: l404 } = await captureLogs(() =>
      iso.handler(
        edgeRequest("GET", "/v1/nope/12345678", {
          token: supabaseAccessToken("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
          headers: { "x-forwarded-for": "203.0.113.130" },
        }),
      ),
    );
    await r404.body?.cancel();
    assertMatch(r404.headers.get("x-request-id") ?? "", UUID);
    assertEquals(JSON.parse(l404[0]).route, "/functions/v1/api/v1/nope/:id");
    assertNotEquals(r404.status, 500);
    report("X4", { status413: r413.status, unknownRoute: r404.status });
  } finally {
    sb.restore();
  }
});

Deno.test("X5: Authorization scheme is case-sensitive ('bearer x' → 401 missing bearer) and counts as an auth failure", async () => {
  configureRedis(false);
  const sb = installFakeSupabase();
  try {
    const iso = await loadEdgeIsolate();
    const token = supabaseAccessToken("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const r = await iso.handler(
      new Request("http://edge.test/functions/v1/api/v1/me", {
        headers: { authorization: `bearer ${token}`, "x-forwarded-for": "203.0.113.140" },
      }),
    );
    assertEquals(r.status, 401);
    assertEquals((await r.json()).error.message, "Missing bearer token.");
    assertEquals(sb.getUserCalls, 0);
    const bucket = Math.floor(Date.now() / 300_000);
    const peek = await iso.rateLimit.peekRateLimit("authfail", "203.0.113.140", 30, 300);
    assertEquals(peek.remaining, 29, `bucket ${bucket}: the lowercase scheme burned one auth-failure credit`);
    report("X5", { status: r.status });
  } finally {
    sb.restore();
  }
});

Deno.test("X6: expired-by-exp bearers are refused before cache or Supabase; cache never resurrects them", async () => {
  configureRedis(true);
  const sb = installFakeSupabase();
  const redis = fakeUpstash();
  try {
    const iso = await loadEdgeIsolate();
    const ip = { "x-forwarded-for": "203.0.113.150" };
    const sub = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const soon = supabaseAccessToken(sub, 100); // exp in 100 s → ttl 70 s → cached
    const r1 = await iso.handler(edgeRequest("GET", "/v1/me", { token: soon, headers: ip }));
    assertEquals(r1.status, 200);
    await r1.body?.cancel();
    assertEquals(sb.getUserCalls, 1);
    const key = `auth:${await iso.cache.sha256Hex(soon)}`;
    assert(redis.store.has(key), "cached (ttl ≥ 60 s)");
    const clock = stubClock(Date.now() + 101_000);
    try {
      const r2 = await iso.handler(edgeRequest("GET", "/v1/me", { token: soon, headers: ip }));
      assertEquals(r2.status, 401);
      assertEquals((await r2.json()).error.message, "The session token has expired.");
      assertEquals(sb.getUserCalls, 1, "no Supabase call for a dead bearer");
    } finally {
      clock.restore();
    }
    // A bearer with <90 s left is verified but NOT cached (sub-minute remainder).
    const shorter = supabaseAccessToken(sub, 80);
    const r3 = await iso.handler(edgeRequest("GET", "/v1/me", { token: shorter, headers: ip }));
    assertEquals(r3.status, 200);
    await r3.body?.cancel();
    assertEquals(redis.store.has(`auth:${await iso.cache.sha256Hex(shorter)}`), false);
    const r4 = await iso.handler(edgeRequest("GET", "/v1/me", { token: shorter, headers: ip }));
    await r4.body?.cancel();
    assertEquals(sb.getUserCalls, 3, "uncached → verified on every request");
    report("X6", { getUserCalls: sb.getUserCalls });
  } finally {
    redis.restore();
    sb.restore();
  }
});

Deno.test("X7: Redis answering garbage (non-array JSON, error results, non-numeric INCR) fails open, never throws", async () => {
  configureRedis(true);
  const realFetch = globalThis.fetch;
  let mode: "object" | "errors" | "nan" | "html" = "object";
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FAKE_REDIS_URL)) return realFetch(input, init);
    const body =
      mode === "object"
        ? '{"result":"nope"}'
        : mode === "errors"
          ? '[{"error":"WRONGTYPE"},{"error":"WRONGTYPE"}]'
          : mode === "nan"
            ? '[{"result":"abc"},{"result":1}]'
            : "<html>upstream</html>";
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  try {
    const iso = await loadIsolate();
    for (const m of ["object", "errors", "nan", "html"] as const) {
      mode = m;
      assertEquals(await iso.cache.redisWindowIncr(`rl:${m}`, 60), null, m);
      // errors → results[0].result undefined → "missing key" 0; everything else → unavailable null
      assertEquals(await iso.cache.redisWindowGet(`rl:${m}`), m === "errors" ? 0 : null, m);
      // cacheGet returns whatever string Redis hands back ("abc" in the nan mode) — callers parse defensively.
      assertEquals(await iso.cache.cacheGet(`k:${m}`), m === "nan" ? "abc" : null, m);
      const r = await iso.rateLimit.enforceRateLimit(m, "id", 1, 60);
      assertEquals(r.allowed, true, `${m}: memory fallback counts 1`);
      const r2 = await iso.rateLimit.enforceRateLimit(m, "id", 1, 60);
      assertEquals(r2.allowed, false, `${m}: memory fallback enforces`);
    }
    report("X7", { modes: 4 });
  } finally {
    globalThis.fetch = realFetch;
    configureRedis(false);
  }
});

Deno.test("X8: logout drops cache + revokes; a repeat with the revoked bearer is 401; upstream 5xx → 503 after the cache drop", async () => {
  configureRedis(true);
  const sb = installFakeSupabase();
  const redis = fakeUpstash();
  try {
    const iso = await loadEdgeIsolate();
    const ip = { "x-forwarded-for": "203.0.113.160" };
    const token = supabaseAccessToken("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const me = await iso.handler(edgeRequest("GET", "/v1/me", { token, headers: ip }));
    assertEquals(me.status, 200);
    await me.body?.cancel();
    const l1 = await iso.handler(edgeRequest("POST", "/v1/auth/logout", { token, headers: ip }));
    assertEquals(l1.status, 204);
    // Second logout with the now-revoked bearer: authenticate() refuses first (401) — counted as auth failure.
    const l2 = await iso.handler(edgeRequest("POST", "/v1/auth/logout", { token, headers: ip }));
    assertEquals(l2.status, 401);
    await l2.body?.cancel();
    assertEquals(sb.logoutCalls, 1);
    // Supabase 5xx on logout → 503 (retryable), and the cache entry is still dropped first.
    const token2 = supabaseAccessToken("ffffffff-ffff-4fff-8fff-ffffffffffff");
    const me2 = await iso.handler(edgeRequest("GET", "/v1/me", { token: token2, headers: ip }));
    assertEquals(me2.status, 200);
    await me2.body?.cancel();
    const key2 = `auth:${await iso.cache.sha256Hex(token2)}`;
    assert(redis.store.has(key2));
    sb.logoutStatus = 503;
    const l3 = await iso.handler(edgeRequest("POST", "/v1/auth/logout", { token: token2, headers: ip }));
    assertEquals(l3.status, 503);
    assertEquals((await l3.json()).error.message, "Sign-out is temporarily unavailable. Please try again.");
    assertEquals(redis.store.has(key2), false, "cache entry dropped before the upstream call");
    report("X8", { firstLogout: l1.status, secondLogout: l2.status, upstream5xx: l3.status });
  } finally {
    redis.restore();
    sb.restore();
  }
});

