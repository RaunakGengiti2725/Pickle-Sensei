// ADVERSARIAL PASS 3 — edge-auth-cache-ratelimit (#2).
//
// Hostile / degraded Upstash pipeline responses against rateLimit.ts +
// cache.ts (fresh isolate per test via harness.loadIsolate). The stock
// fakeUpstash() only knows global `failStatus` / `hang`; this file layers a
// per-command shim on top of it (test-only, no harness edits) that can
//   - drop a command from the forwarded pipeline and splice in an error
//     result (emulates "EXPIRE failed → no TTL was ever set"), or
//   - rewrite the JSON body the limiter sees while the fake store still
//     applies the real command (emulates a proxy / protocol drift).
//
//   S5  EXPIRE (2nd pipeline command) errors → enforceRateLimit must still
//       return a bounded result AND must not leave a TTL-less counter key.
//   S6  INCR result is {} / [] / [{result:'abc'}] / [{error}] → limiter must
//       fall back to memory (bounded), never to "unlimited".
//   S10 (own) INCR result is null / "" / false / [] (JSON-valid but not a
//       count) — Number() coerces these to 0, which the limiter must not read
//       as "0 hits so far".
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack2_upstash_malformed_test.ts

import {
  FAKE_REDIS_URL,
  assert,
  assertEquals,
  configureRedis,
  fakeUpstash,
  loadIsolate,
} from "./harness.ts";

type Cmd = (string | number)[];
type PipelineResult = { result?: unknown; error?: string }[];

interface Shim {
  /** Called once per forwarded pipeline; return the body the limiter sees. */
  rewrite: (commands: Cmd[], results: PipelineResult) => unknown;
  /** Commands (by name) that are NOT forwarded to the fake store. */
  drop: Set<string>;
  seen: Cmd[][];
  restore: () => void;
}

/** Must be installed AFTER fakeUpstash() so it sits in front of it. */
function installShim(): Shim {
  const inner = globalThis.fetch;
  const shim: Shim = {
    rewrite: (_commands, results) => results,
    drop: new Set(),
    seen: [],
    restore() {
      globalThis.fetch = inner;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FAKE_REDIS_URL)) return inner(input, init);
    const commands = JSON.parse(String(init?.body ?? "[]")) as Cmd[];
    shim.seen.push(commands);
    const forwarded = commands.filter((c) => !shim.drop.has(String(c[0]).toUpperCase()));
    const innerRes = await inner(input, { ...init, body: JSON.stringify(forwarded) });
    const innerResults = (await innerRes.json()) as PipelineResult;
    // Re-align results with the original command list; dropped commands get
    // a Redis-style per-command error.
    const results: PipelineResult = [];
    let j = 0;
    for (const c of commands) {
      if (shim.drop.has(String(c[0]).toUpperCase())) {
        results.push({ error: `ERR unknown command '${String(c[0]).toUpperCase()}'` });
      } else {
        results.push(innerResults[j++]);
      }
    }
    return new Response(JSON.stringify(shim.rewrite(commands, results)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return shim;
}

function pinClock(): () => void {
  const realNow = Date.now;
  const pinned = Math.floor(realNow() / 60_000) * 60_000 + 5_000;
  Date.now = () => pinned;
  return () => {
    Date.now = realNow;
  };
}

// ─── S5 ──────────────────────────────────────────────────────────────────────

Deno.test(
  "[S5] EXPIRE errors in the pipeline → enforceRateLimit stays bounded and leaves no TTL-less key",
  async () => {
    const unpin = pinClock();
    configureRedis(true);
    const redis = fakeUpstash();
    const shim = installShim();
    shim.drop.add("EXPIRE");
    try {
      const { rateLimit } = await loadIsolate();
      const results = [];
      for (let i = 0; i < 6; i += 1) {
        results.push(await rateLimit.enforceRateLimit("auth_refresh", "203.0.113.5", 3, 60));
      }
      const allowed = results.map((r) => r.allowed);
      const keys = [...redis.store.entries()].filter(([k]) => k.startsWith("rl:auth_refresh:"));
      const ttlLess = keys.filter(([, v]) => v.expiresAtMs === null).map(([k]) => k);
      const expireErrors = shim.seen.filter((cmds) => cmds.some((c) => c[0] === "EXPIRE")).length;
      console.warn(
        `[S5] observed: allowed=${allowed} remaining=${results.map((r) => r.remaining)} ` +
          `redisCalls=${redis.calls} pipelinesWithEXPIRE=${expireErrors} keys=${keys.length} ttlLess=${JSON.stringify(ttlLess)} values=${keys.map(([, v]) => v.value)}`,
      );
      assertEquals(allowed, [true, true, true, false, false, false], "result must stay bounded");
      assert(results.every((r) => r.limit === 3 && r.remaining >= 0 && r.remaining <= 3));
      assert(results.every((r) => Number.isFinite(r.resetAtMs) && r.resetAtMs > Date.now()));
      assert(
        ttlLess.length === 0,
        `counter key(s) without a TTL leaked into Redis after EXPIRE failed: ${ttlLess}`,
      );
    } finally {
      shim.restore();
      redis.restore();
      configureRedis(false);
      unpin();
    }
  },
);

// ─── S6 ──────────────────────────────────────────────────────────────────────

const MALFORMED_INCR: { label: string; body: (results: PipelineResult) => unknown }[] = [
  { label: "{}", body: () => ({}) },
  { label: "[]", body: () => [] },
  { label: "[{result:'abc'}]", body: (r) => [{ result: "abc" }, r[1]] },
  { label: "[{error:'OOM'}]", body: (r) => [{ error: "OOM command not allowed" }, r[1]] },
  { label: "[{result:'1e999'}]", body: (r) => [{ result: "1e999" }, r[1]] },
  { label: "[{result:{}}]", body: (r) => [{ result: {} }, r[1]] },
  { label: "'not json array'", body: () => "not json array" },
  { label: "null", body: () => null },
  { label: "42", body: () => 42 },
];

for (const shape of MALFORMED_INCR) {
  Deno.test(
    `[S6] INCR result ${shape.label} → limiter falls back to memory instead of allowing unlimited traffic`,
    async () => {
      const unpin = pinClock();
      configureRedis(true);
      const redis = fakeUpstash();
      const shim = installShim();
      shim.rewrite = (commands, results) =>
        commands[0]?.[0] === "INCR" ? shape.body(results) : results;
      try {
        const { rateLimit } = await loadIsolate();
        const limit = 3;
        const allowed: boolean[] = [];
        for (let i = 0; i < 50; i += 1) {
          allowed.push((await rateLimit.enforceRateLimit("ip", "203.0.113.6", limit, 60)).allowed);
        }
        const passed = allowed.filter(Boolean).length;
        const peek = await rateLimit.peekRateLimit("ip", "203.0.113.6", limit, 60);
        console.warn(
          `[S6 ${shape.label}] observed: allowed=${passed}/50 first=${allowed.slice(0, 5)} peek.allowed=${peek.allowed} peek.remaining=${peek.remaining} redisCalls=${redis.calls}`,
        );
        assertEquals(
          passed,
          limit,
          `expected exactly ${limit} allowed via memory fallback, got ${passed}/50`,
        );
        assertEquals(allowed.slice(0, limit), [true, true, true]);
        assertEquals(peek.allowed, false);
      } finally {
        shim.restore();
        redis.restore();
        configureRedis(false);
        unpin();
      }
    },
  );
}

// ─── S10 (own) ───────────────────────────────────────────────────────────────

const ZERO_COERCED: { label: string; value: unknown }[] = [
  { label: "null", value: null },
  { label: "''", value: "" },
  { label: "false", value: false },
  { label: "[]", value: [] },
  { label: "'  '", value: "  " },
];

for (const shape of ZERO_COERCED) {
  Deno.test(
    `[S10] INCR result ${shape.label} (Number() → 0) must not be read as a fresh window`,
    async () => {
      const unpin = pinClock();
      configureRedis(true);
      const redis = fakeUpstash();
      const shim = installShim();
      shim.rewrite = (commands, results) =>
        commands[0]?.[0] === "INCR" ? [{ result: shape.value }, results[1]] : results;
      try {
        const { rateLimit } = await loadIsolate();
        const limit = 3;
        let passed = 0;
        for (let i = 0; i < 50; i += 1) {
          if ((await rateLimit.enforceRateLimit("ip", "203.0.113.7", limit, 60)).allowed)
            passed += 1;
        }
        console.warn(
          `[S10 ${shape.label}] observed: allowed=${passed}/50 redisCalls=${redis.calls}`,
        );
        assert(
          passed <= limit,
          `INCR result ${shape.label} let ${passed}/50 requests through a limit of ${limit} (unlimited traffic)`,
        );
      } finally {
        shim.restore();
        redis.restore();
        configureRedis(false);
        unpin();
      }
    },
  );
}
