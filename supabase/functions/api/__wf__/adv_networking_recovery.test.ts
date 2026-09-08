// INT-networking-recovery adversarial probe — edge function side.
//
// Attacks the CURRENT integration head (not a candidate) with the hostile
// upstreams a production edge really meets: Supabase Auth answering 503/429
// with strange Retry-After values, Auth hanging past its budget, an RPC
// blowing up under an authenticated route, oversized / truncated request
// bodies, and a degraded Upstash (hanging, HTTP 5xx). Each Deno.test is one
// attack; a failing test is a confirmed break on HEAD.
//
// Run (repo root):
//   (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adv_networking_recovery.test.ts)

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import {
  captureConsole,
  fakeSupabaseAccessToken,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

/** Longest Retry-After a well-behaved client could reasonably honour; the
 * edge's own budgets never exceed one hour (rate-limit windows, webhook
 * in-flight guard, auth default 2 s). Anything above is an upstream relay
 * the app would either ignore or sleep on for days. */
const RETRY_AFTER_SANE_MAX_SECONDS = 3_600;

const AUTH_UPSTREAM_TIMEOUT_MS_DEFAULT = 6_000;

function isAuthUserCall(call: RecordedCall): boolean {
  return call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
}

function upstream(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error_code: "injected", msg: "upstream degraded" }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

let nextIp = 10;
function freshIp(): string {
  nextIp += 1;
  return `198.51.100.${nextIp}`;
}

// ─── Attack 1: Retry-After relay is unbounded ────────────────────────────────

for (const [label, header] of [
  ["max int32", "2147483647"],
  ["exponent notation", "1e9"],
  ["unix-epoch-sized", "1780000000"],
] as const) {
  Deno.test(
    `ADV auth upstream 503 with Retry-After '${header}' (${label}) → the relayed Retry-After stays within a sane bound`,
    async () => {
      const h = await loadHarness();
      h.respond = (call) =>
        isAuthUserCall(call) ? upstream(503, { "Retry-After": header }) : null;
      const { result: res } = await captureConsole(() =>
        h.handler(
          userRequest("GET", "/v1/me/consent/status", {
            token: fakeSupabaseAccessToken(),
            ip: freshIp(),
          }),
        ),
      );
      await res.text();
      assertEquals(res.status, 503, "upstream outage is a retryable 503, never a 401");
      const relayed = res.headers.get("Retry-After");
      assert(relayed !== null, "a retryable 503 names a Retry-After");
      const seconds = Number(relayed);
      assert(
        Number.isInteger(seconds) && seconds > 0,
        `Retry-After is a positive integer: ${relayed}`,
      );
      assert(
        seconds <= RETRY_AFTER_SANE_MAX_SECONDS,
        `Retry-After ${relayed} exceeds ${RETRY_AFTER_SANE_MAX_SECONDS}s — upstream value relayed unbounded`,
      );
    },
  );
}

Deno.test(
  "ADV control: auth upstream 503 with an HTTP-date / fractional / negative Retry-After falls back to the 2s default",
  async () => {
    const h = await loadHarness();
    for (const header of ["Wed, 21 Oct 2026 07:28:00 GMT", "1.5", "-30", "0", "abc"]) {
      h.reset();
      h.respond = (call) =>
        isAuthUserCall(call) ? upstream(503, { "Retry-After": header }) : null;
      const { result: res } = await captureConsole(() =>
        h.handler(
          userRequest("GET", "/v1/me/consent/status", {
            token: fakeSupabaseAccessToken(),
            ip: freshIp(),
          }),
        ),
      );
      await res.text();
      assertEquals(res.status, 503);
      assertEquals(res.headers.get("Retry-After"), "2", `header '${header}'`);
    }
  },
);

// ─── Attack 2: auth upstream 429 must not become a credential verdict ────────

Deno.test(
  "ADV auth upstream 429 → client sees a retryable 503 + Retry-After, the bearer is not treated as invalid",
  async () => {
    const h = await loadHarness();
    h.respond = (call) => (isAuthUserCall(call) ? upstream(429, { "Retry-After": "7" }) : null);
    const token = fakeSupabaseAccessToken();
    const ip = freshIp();
    const { result: limited } = await captureConsole(() =>
      h.handler(userRequest("GET", "/v1/me/consent/status", { token, ip })),
    );
    await limited.text();
    assertEquals(limited.status, 503);
    assertEquals(limited.headers.get("Retry-After"), "7");

    // Upstream recovers: the SAME bearer must be accepted (no negative cache).
    h.respond = () => null;
    h.tables.profiles = [];
    const { result: recovered } = await captureConsole(() =>
      h.handler(userRequest("GET", "/v1/me/consent/status", { token, ip })),
    );
    await recovered.text();
    assertEquals(recovered.status, 200, "a transient upstream 429 must not poison the bearer");
  },
);

// ─── Attack 3: auth upstream hangs ───────────────────────────────────────────

Deno.test(
  "ADV auth upstream never answers → edge replies 503 + Retry-After inside its own auth deadline (6s + 1.5s slack)",
  async () => {
    const h = await loadHarness();
    h.respond = (call) => (isAuthUserCall(call) ? new Promise<Response | null>(() => {}) : null);
    const startedAt = performance.now();
    const { result: res } = await captureConsole(() =>
      h.handler(
        userRequest("GET", "/v1/me/consent/status", {
          token: fakeSupabaseAccessToken(),
          ip: freshIp(),
        }),
      ),
    );
    const elapsedMs = performance.now() - startedAt;
    await res.text();
    assertEquals(res.status, 503);
    assert(res.headers.get("Retry-After") !== null, "hung auth is retryable");
    assert(
      elapsedMs <= AUTH_UPSTREAM_TIMEOUT_MS_DEFAULT + 1_500,
      `edge answered after ${Math.round(
        elapsedMs,
      )}ms; auth deadline is ${AUTH_UPSTREAM_TIMEOUT_MS_DEFAULT}ms`,
    );
  },
);

// ─── Attack 4: generic 5xx body under an authenticated route ─────────────────

Deno.test(
  "ADV RPC failure under GET /v1/me/access → generic 5xx body, no internal detail, no-store",
  async () => {
    const h = await loadHarness();
    h.rpcErrors.access_state = 500;
    const { result: res, logs } = await captureConsole(() =>
      h.handler(
        userRequest("GET", "/v1/me/access", {
          token: fakeSupabaseAccessToken(),
          ip: freshIp(),
        }),
      ),
    );
    const text = await res.text();
    assert(res.status >= 500 && res.status <= 599, `expected 5xx, got ${res.status}`);
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    assertEquals(typeof body.error?.message, "string");
    for (const secret of ["access_state", "PGRST", "stack", "at ", "postgres", "rpc/"]) {
      assert(!text.includes(secret), `5xx body leaks '${secret}': ${text}`);
    }
    assertEquals(res.headers.get("Cache-Control"), "no-store");
    assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert(res.headers.get("x-request-id"), "5xx carries a request id for support correlation");
    assert(logs.length > 0, "the detail went to the function log, not the client");
  },
);

// ─── Attack 5: malformed / oversized input on the sync route ─────────────────

Deno.test(
  "ADV POST /v1/shots:sync with a 5 MB + 1 byte body → 413, not a 500 or a stall",
  async () => {
    const h = await loadHarness();
    const oversized = `{"shots":[{"pad":"${"x".repeat(5_000_000)}"}]}`;
    const headers = new Headers({
      Authorization: `Bearer ${fakeSupabaseAccessToken()}`,
      "x-forwarded-for": freshIp(),
      "Content-Type": "application/json",
    });
    const startedAt = performance.now();
    const { result: res } = await captureConsole(() =>
      h.handler(
        new Request("http://edge.test/functions/v1/api/v1/shots:sync", {
          method: "POST",
          headers,
          body: oversized,
        }),
      ),
    );
    const elapsedMs = performance.now() - startedAt;
    await res.text();
    assertEquals(res.status, 413);
    assert(elapsedMs < 5_000, `oversized body took ${Math.round(elapsedMs)}ms to refuse`);
  },
);

Deno.test(
  "ADV POST /v1/shots:sync with truncated JSON / non-object bodies → 400 with a generic message",
  async () => {
    const h = await loadHarness();
    for (const raw of ['{"shots":[', "null", "[]", '"shots"', "\u0000"]) {
      h.reset();
      const headers = new Headers({
        Authorization: `Bearer ${fakeSupabaseAccessToken()}`,
        "x-forwarded-for": freshIp(),
        "Content-Type": "application/json",
      });
      const { result: res } = await captureConsole(() =>
        h.handler(
          new Request("http://edge.test/functions/v1/api/v1/shots:sync", {
            method: "POST",
            headers,
            body: raw,
          }),
        ),
      );
      const text = await res.text();
      assertEquals(res.status, 400, `body ${JSON.stringify(raw)} → ${res.status}: ${text}`);
      assert(!text.includes("SyntaxError"), `parser detail leaked: ${text}`);
    }
  },
);

// ─── Attack 6: degraded Redis (module level — env is read at cache.ts load) ──

Deno.test(
  "ADV Upstash hangs → every limiter call settles within its 1.2s timeout and the memory fallback still stops a runaway client",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    redis.hang = true;
    try {
      const iso = await loadIsolate();
      const startedAt = performance.now();
      const first = await iso.rateLimit.enforceRateLimit("ip", "hang-client", 3, 60);
      const elapsedMs = performance.now() - startedAt;
      assert(elapsedMs < 1_700, `limiter took ${Math.round(elapsedMs)}ms with a hung Redis`);
      assertEquals(first.allowed, true, "fails open on Redis outage");
      assertEquals(first.remaining, 2);
      await iso.rateLimit.enforceRateLimit("ip", "hang-client", 3, 60);
      await iso.rateLimit.enforceRateLimit("ip", "hang-client", 3, 60);
      const fourth = await iso.rateLimit.enforceRateLimit("ip", "hang-client", 3, 60);
      assertEquals(fourth.allowed, false, "per-isolate memory window still enforces the limit");
      assert(fourth.retryAfterSeconds >= 1 && fourth.retryAfterSeconds <= 60);
      assert(redis.calls >= 4, "each call did try Redis first");
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

Deno.test(
  "ADV Upstash answers HTTP 500 → auth session cache reads/writes degrade to L1 without throwing",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    redis.failStatus = 500;
    try {
      const iso = await loadIsolate();
      await iso.cache.cacheSet("auth:tok", '{"id":"u1"}', 60);
      assertEquals(
        await iso.cache.cacheGet("auth:tok"),
        '{"id":"u1"}',
        "L1 serves while L2 is down",
      );
      const cold = await loadIsolate();
      assertEquals(
        await cold.cache.cacheGet("auth:tok"),
        null,
        "a cold isolate reports a miss, not garbage",
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);
