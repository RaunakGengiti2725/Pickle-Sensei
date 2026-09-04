// Module isolation of the Upstash configuration between edge test modules.
//
// `deno test` runs every module in the directory in one process, in file
// order. Deno.env is process-wide, so a harness that sets
// UPSTASH_REDIS_REST_URL/_TOKEN at load time and never clears them hands a
// live Redis configuration to whichever module runs next. cache.ts reads
// those variables at import time; the next module then talks to a host that
// does not exist instead of exercising the in-memory fallback it was written
// for, and the "no network" edge suite makes real outbound requests.
//
// This module is named to run directly after auth_cache_redis_test.ts. It
// imports cache.ts exactly like auth_session_cache_test.ts does and pins the
// invariant rateLimit_test.ts already asserts for its own position:
// a module that did not configure Redis must not see one.
//
//   cd supabase/functions/api/__wf__ && deno task test

import { assertEquals, assertStrictEquals } from "@std/assert";
import { cacheGet, cacheSet, redisConfigured } from "../cache.ts";

Deno.test(
  "a module that did not configure Redis sees no Upstash configuration inherited from an earlier module",
  () => {
    assertStrictEquals(
      Deno.env.get("UPSTASH_REDIS_REST_URL"),
      undefined,
      "UPSTASH_REDIS_REST_URL leaked from a previous test module",
    );
    assertStrictEquals(
      Deno.env.get("UPSTASH_REDIS_REST_TOKEN"),
      undefined,
      "UPSTASH_REDIS_REST_TOKEN leaked from a previous test module",
    );
    assertStrictEquals(redisConfigured(), false);
  },
);

Deno.test(
  "cache primitives in an unconfigured module never leave the process (no outbound fetch)",
  async () => {
    const outbound: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const key = `isolation:${crypto.randomUUID()}`;
      await cacheSet(key, "value", 120);
      assertEquals(await cacheGet(key), "value");
      assertEquals(await cacheGet(`${key}:miss`), null);
    } finally {
      globalThis.fetch = realFetch;
    }
    assertEquals(outbound, [], "cache.ts issued real network requests from the test process");
  },
);
