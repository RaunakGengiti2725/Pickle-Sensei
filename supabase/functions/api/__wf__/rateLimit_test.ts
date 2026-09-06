// Fixed-window semantics for the auth-failure budget: peeking never charges
// a hit, the gate closes exactly when `limit` failures have been recorded,
// Retry-After is the time left in the CURRENT aligned bucket (never a full
// extra window), and a Redis-less deployment still enforces in memory.
//
//   deno test --no-lock --allow-env supabase/functions/api/__wf__/rateLimit_test.ts

import { assert, assertEquals } from "./harness.ts";
import { enforceRateLimit, peekRateLimit, rateLimitResponse } from "../rateLimit.ts";
import { redisConfigured, redisWindowGet } from "../cache.ts";

const WINDOW = 300;

function freshId(): string {
  return `test-${crypto.randomUUID()}`;
}

Deno.test("no Redis configured in this test process", () => {
  assertEquals(redisConfigured(), false);
});

Deno.test(
  "redisWindowGet reports unavailable (null) without Redis so the caller falls back",
  async () => {
    assertEquals(await redisWindowGet("rl:authfail:0:nobody"), null);
  },
);

Deno.test("peek never charges a hit", async () => {
  const id = freshId();
  for (let i = 0; i < 50; i += 1) {
    const peeked = await peekRateLimit("authfail", id, 3, WINDOW);
    assertEquals(peeked.allowed, true);
    assertEquals(peeked.remaining, 3);
  }
});

Deno.test("gate closes after exactly `limit` recorded failures", async () => {
  const id = freshId();
  const limit = 3;
  for (let recorded = 0; recorded < limit; recorded += 1) {
    const before = await peekRateLimit("authfail", id, limit, WINDOW);
    assertEquals(before.allowed, true, `peek after ${recorded} failures`);
    assertEquals(before.remaining, limit - recorded);
    const charged = await enforceRateLimit("authfail", id, limit, WINDOW);
    assertEquals(charged.allowed, true);
  }
  const closed = await peekRateLimit("authfail", id, limit, WINDOW);
  assertEquals(closed.allowed, false);
  assertEquals(closed.remaining, 0);
  assertEquals(closed.limit, limit);
});

Deno.test("Retry-After counts down within the aligned bucket", async () => {
  const id = freshId();
  const limit = 1;
  await enforceRateLimit("authfail", id, limit, WINDOW);
  const closed = await peekRateLimit("authfail", id, limit, WINDOW);
  assertEquals(closed.allowed, false);
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
  assertEquals((await peekRateLimit("authfail", id, 1, WINDOW)).allowed, false);
  assertEquals((await peekRateLimit("authfail", freshId(), 1, WINDOW)).allowed, true);
  assertEquals((await peekRateLimit("ip", id, 1, WINDOW)).allowed, true);
});

Deno.test(
  "peek and enforce reset together at the aligned boundary without extending the window",
  async () => {
    const id = freshId();
    const originalNow = Date.now;
    let now = 60_250;
    Date.now = () => now;
    try {
      assertEquals((await enforceRateLimit("authfail", id, 2, WINDOW)).remaining, 1);
      now = 299_999;
      const lastAllowed = await enforceRateLimit("authfail", id, 2, WINDOW);
      assertEquals(lastAllowed.allowed, true);
      assertEquals(lastAllowed.remaining, 0);
      assertEquals(lastAllowed.retryAfterSeconds, 1);
      const closed = await peekRateLimit("authfail", id, 2, WINDOW);
      assertEquals(closed.allowed, false);
      assertEquals(closed.remaining, 0);
      assertEquals(closed.retryAfterSeconds, 1);
      assertEquals(await enforceRateLimit("authfail", id, 2, WINDOW), closed);

      now = 300_000;
      for (let i = 0; i < 50; i += 1) {
        assertEquals(await peekRateLimit("authfail", id, 2, WINDOW), {
          allowed: true,
          limit: 2,
          remaining: 2,
          retryAfterSeconds: WINDOW,
        });
      }
      assertEquals((await enforceRateLimit("authfail", id, 2, WINDOW)).remaining, 1);
      now = 599_999;
      assertEquals((await peekRateLimit("authfail", id, 2, WINDOW)).remaining, 1);
    } finally {
      Date.now = originalNow;
    }
  },
);
