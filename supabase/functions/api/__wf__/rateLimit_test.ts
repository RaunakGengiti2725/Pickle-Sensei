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
