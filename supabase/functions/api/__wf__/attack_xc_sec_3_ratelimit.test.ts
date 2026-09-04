// Adversarial tests against candidate 26d7663e (cluster xc-security::XC-SEC-3).
// "ATTACK" tests assert behaviour the cluster's expected text demands AND that
// baseline 4d812e1a satisfied under the same inputs — a FAILING one is a
// regression introduced by the fix. "CHARACTERIZATION" tests only log
// behaviour that is identical on baseline (not a break of this candidate).
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_xc_sec_3_ratelimit.test.ts

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

// Mirrors index.ts: IP_LIMIT 1_200/60s, AUTH_FAILURE_LIMIT 30/300s.
const IP = { limit: 1_200, windowSeconds: 60 };
const AUTHFAIL = { limit: 30, windowSeconds: 300 };

Deno.test(
  "CHARACTERIZATION A1 (same on 4d812e1a): a flood of 20 000 count-1 identities evicts an attacker's own 29/30 auth-failure counter (LRU, not lowest-count)",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const rl = iso.rateLimit;
      const attacker = "203.0.113.66";
      // index.ts shape per failed request: enforce("ip") → peek("authfail") → enforce("authfail").
      const failedAuth = async (ip: string) => {
        const ipRes = await rl.enforceRateLimit("ip", ip, IP.limit, IP.windowSeconds);
        if (!ipRes.allowed) return false;
        const peek = await rl.peekRateLimit("authfail", ip, AUTHFAIL.limit, AUTHFAIL.windowSeconds);
        if (!peek.allowed) return false;
        await rl.enforceRateLimit("authfail", ip, AUTHFAIL.limit, AUTHFAIL.windowSeconds);
        return true;
      };
      for (let i = 0; i < AUTHFAIL.limit - 1; i += 1) assert(await failedAuth(attacker));
      const before = await rl.peekRateLimit("authfail", attacker, AUTHFAIL.limit, AUTHFAIL.windowSeconds);
      assertEquals(before.remaining, 1, "precondition: attacker is one failure from lockout");

      // 20 000 spoofed identities, ONE request each (count 1, unlocked).
      for (let i = 0; i < rl.MEMORY_WINDOW_MAX; i += 1) {
        await rl.enforceRateLimit("ip", `198.51.100.${i}`, IP.limit, IP.windowSeconds);
      }

      const after = await rl.peekRateLimit("authfail", attacker, AUTHFAIL.limit, AUTHFAIL.windowSeconds);
      // Candidate evicts by insertion order only ("oldest"), so a not-yet-locked
      // 29/30 window is dropped by 20 000 count-1 windows. Baseline cleared the
      // whole map here, so this is not a regression — logged for the record.
      console.warn(
        `[characterization] attacker's auth-failure remaining before flood: ${before.remaining}, after flood: ${after.remaining}`,
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "ATTACK A2: once the map is full of locked windows every NEW identity is unlimited (fail-open) for the rest of the window",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const rl = iso.rateLimit;
      // Cheapest lock: any scope with limit 1 hit reaches count>=limit at once.
      // (Production: authfail limit 30 → 30 × 20 000 = 600 000 requests, or
      // 20 000 spoofed cf-connecting-ip values × 1 200 hits on the ip scope.)
      for (let i = 0; i < rl.MEMORY_WINDOW_MAX; i += 1) {
        await rl.enforceRateLimit("authfail", `lock-${i}`, 1, AUTHFAIL.windowSeconds);
      }
      assertEquals(rl.memoryWindowCount(), rl.MEMORY_WINDOW_MAX);

      const newcomer = "203.0.113.99";
      let allowed = 0;
      for (let i = 0; i < AUTHFAIL.limit * 4; i += 1) {
        const r = await rl.enforceRateLimit("authfail", newcomer, AUTHFAIL.limit, AUTHFAIL.windowSeconds);
        if (r.allowed) allowed += 1;
      }
      // Expected: the newcomer is limited after 30 failures like any other
      // client (baseline 4d812e1a: windows.clear() then retained it → 30).
      // Observed on 26d7663e: memoryEvict() evicts nothing when every window
      // is locked, memoryIncr() returns 1 without inserting, so the newcomer
      // is never retained and never limited (fail-open for the whole window).
      assertEquals(
        allowed,
        AUTHFAIL.limit,
        `newcomer made ${allowed} auth failures without ever being limited`,
      );
      assertEquals(
        (await rl.peekRateLimit("authfail", newcomer, AUTHFAIL.limit, AUTHFAIL.windowSeconds)).remaining,
        0,
        "newcomer's window must exist and be exhausted",
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "CHARACTERIZATION A3: CPU cost per request once the map is full of locked windows (O(n) sweep every hit)",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const rl = iso.rateLimit;
      const t0 = performance.now();
      for (let i = 0; i < 2_000; i += 1) {
        await rl.enforceRateLimit("ip", `warm-${i}`, 10, 60);
      }
      const perHitBefore = (performance.now() - t0) / 2_000;
      for (let i = 0; i < rl.MEMORY_WINDOW_MAX; i += 1) {
        await rl.enforceRateLimit("authfail", `lock-${i}`, 1, AUTHFAIL.windowSeconds);
      }
      const t1 = performance.now();
      for (let i = 0; i < 2_000; i += 1) {
        await rl.enforceRateLimit("ip", `after-${i}`, 10, 60);
      }
      const perHitAfter = (performance.now() - t1) / 2_000;
      console.warn(
        `[characterization] per-hit cost: normal ${perHitBefore.toFixed(4)} ms, map full of locked windows ${perHitAfter.toFixed(4)} ms (x${(perHitAfter / perHitBefore).toFixed(0)})`,
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "CHARACTERIZATION A4 (same on 4d812e1a): a 29/30 window evicted by a flood restarts at failure #1",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const rl = iso.rateLimit;
      const victim = "203.0.113.10";
      // Victim at limit-1, then the flood, then the victim's final failure.
      for (let i = 0; i < AUTHFAIL.limit - 1; i += 1) {
        await rl.enforceRateLimit("authfail", victim, AUTHFAIL.limit, AUTHFAIL.windowSeconds);
      }
      for (let i = 0; i < rl.MEMORY_WINDOW_MAX; i += 1) {
        await rl.enforceRateLimit("ip", `flood-${i}`, IP.limit, IP.windowSeconds);
      }
      const last = await rl.enforceRateLimit("authfail", victim, AUTHFAIL.limit, AUTHFAIL.windowSeconds);
      // Only windows already at count >= limit are protected from eviction;
      // baseline lost this window too (windows.clear()). Logged, not asserted.
      console.warn(
        `[characterization] victim's 30th auth failure after flood: allowed=${last.allowed}, remaining=${last.remaining}`,
      );
    } finally {
      redis.restore();
    }
  },
);
