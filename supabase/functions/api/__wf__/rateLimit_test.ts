// Fixed-window semantics for the auth-failure budget: peeking never charges
// a hit, the gate closes exactly when `limit` failures have been recorded,
// Retry-After is the time left in the CURRENT aligned bucket (never a full
// extra window), and a Redis-less deployment still enforces in memory.
//
//   deno test --no-lock --allow-env supabase/functions/api/__wf__/rateLimit_test.ts

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enforceRateLimit, peekRateLimit, rateLimitResponse } from "../rateLimit.ts";
import { redisConfigured, redisWindowGet } from "../cache.ts";
import { loadHarness, SUPABASE_URL, userRequest } from "./routesHarness.ts";

const WINDOW = 300;

function freshId(): string {
  return `test-${crypto.randomUUID()}`;
}

Deno.test("no Redis configured in this test process", () => {
  assertStrictEquals(redisConfigured(), false);
});

Deno.test(
  "redisWindowGet reports unavailable (null) without Redis so the caller falls back",
  async () => {
    assertStrictEquals(await redisWindowGet("rl:authfail:0:nobody"), null);
  },
);

Deno.test("peek never charges a hit", async () => {
  const id = freshId();
  for (let i = 0; i < 50; i += 1) {
    const peeked = await peekRateLimit("authfail", id, 3, WINDOW);
    assertStrictEquals(peeked.allowed, true);
    assertEquals(peeked.remaining, 3);
  }
});

Deno.test("gate closes after exactly `limit` recorded failures", async () => {
  const id = freshId();
  const limit = 3;
  for (let recorded = 0; recorded < limit; recorded += 1) {
    const before = await peekRateLimit("authfail", id, limit, WINDOW);
    assertStrictEquals(before.allowed, true, `peek after ${recorded} failures`);
    assertEquals(before.remaining, limit - recorded);
    const charged = await enforceRateLimit("authfail", id, limit, WINDOW);
    assertStrictEquals(charged.allowed, true);
  }
  const closed = await peekRateLimit("authfail", id, limit, WINDOW);
  assertStrictEquals(closed.allowed, false);
  assertEquals(closed.remaining, 0);
  assertEquals(closed.limit, limit);
});

Deno.test("Retry-After counts down within the aligned bucket", async () => {
  const id = freshId();
  const limit = 1;
  await enforceRateLimit("authfail", id, limit, WINDOW);
  const closed = await peekRateLimit("authfail", id, limit, WINDOW);
  assertStrictEquals(closed.allowed, false);
  const secondsIntoBucket = (Date.now() / 1_000) % WINDOW;
  const expectedMax = Math.ceil(WINDOW - secondsIntoBucket) + 1;
  assert(closed.retryAfterSeconds >= 1);
  assert(
    closed.retryAfterSeconds <= expectedMax,
    `retryAfter ${closed.retryAfterSeconds} exceeds bucket remainder ${expectedMax}`,
  );
  assert(closed.retryAfterSeconds <= WINDOW);

  const response = rateLimitResponse(closed);
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), String(closed.retryAfterSeconds));
  const body = await response.json();
  assertEquals(body.error.code, "rate_limited");
});

Deno.test("scopes and ids are isolated", async () => {
  const id = freshId();
  await enforceRateLimit("authfail", id, 1, WINDOW);
  assertStrictEquals((await peekRateLimit("authfail", id, 1, WINDOW)).allowed, false);
  assertStrictEquals((await peekRateLimit("authfail", freshId(), 1, WINDOW)).allowed, true);
  assertStrictEquals((await peekRateLimit("ip", id, 1, WINDOW)).allowed, true);
});

// End to end through the real handler: a DEFINITIVE credential refusal (Auth
// answers 401 for the bearer) is charged to the per-IP auth-failure budget, so
// a brute-force source is locked out on the 31st attempt (AUTH_FAILURE_LIMIT
// 30/300s). Pins the lockout that the outage fix must not loosen.
Deno.test(
  "31 requests with a genuinely invalid bearer from one IP: 30 × 401 then 429 on the 31st",
  async () => {
    const h = await loadHarness();
    const ip = "10.5.0.31";
    const b64url = (value: string): string =>
      btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forgedBearer = (): string =>
      `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
        b64url(
          JSON.stringify({
            iss: `${SUPABASE_URL}/auth/v1`,
            sub: crypto.randomUUID(),
            role: "authenticated",
            exp: Math.floor(Date.now() / 1000) + 3600,
            jti: crypto.randomUUID(),
          }),
        )
      }.forged-signature`;

    const harnessFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
        return new Response(
          JSON.stringify({
            code: 401,
            error_code: "bad_jwt",
            msg: "invalid JWT: unable to parse or verify signature",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return await harnessFetch(input, init);
    }) as typeof fetch;
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 31; attempt += 1) {
        const response = await h.handler(
          userRequest("GET", "/v1/me", { token: forgedBearer(), ip }),
        );
        statuses.push(response.status);
        if (attempt === 30) {
          assertEquals(response.headers.has("Retry-After"), true);
          const body = await response.json();
          assertEquals(body.error.code, "rate_limited");
        } else {
          await response.body?.cancel();
        }
      }
      assertEquals(statuses.slice(0, 30), Array(30).fill(401), JSON.stringify(statuses));
      assertEquals(statuses[30], 429, JSON.stringify(statuses));
    } finally {
      globalThis.fetch = harnessFetch;
    }
  },
);
