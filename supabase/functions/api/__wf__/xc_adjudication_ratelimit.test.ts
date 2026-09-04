// Adjudication reproduction for xc-security::XC-SEC-3 — the per-isolate
// rate-limit memory fallback (no Upstash configured).
//
// Defect (baseline 4d812e1a): memoryIncr() called `windows.clear()` once the
// map held MEMORY_WINDOW_MAX live entries, so 20 000 distinct identities
// released EVERY in-flight budget on the isolate — including the auth-failure
// lockout of an unrelated victim. Identities were also stored verbatim (an
// 8 KB `cf-connecting-ip` became an 8 KB map key) and clientIp() returned any
// header bytes unvalidated.
//
// Each test asserts the CORRECT behaviour, so the file fails on the unfixed
// code and passes once rateLimit.ts / http.ts are fixed.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json xc_adjudication_ratelimit.test.ts

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import { clientIp } from "../http.ts";

const AUTHFAIL = { limit: 3, windowSeconds: 300 };
const IP = { limit: 300, windowSeconds: 60 };
const FLOOD = 20_000;
const HEAP_BUDGET_BYTES = 20 * 1024 * 1024;

function heapUsed(): number {
  return Deno.memoryUsage().heapUsed;
}

Deno.test(
  "REPRO (defect): 20 000 distinct identities must not wipe a locked auth-failure window",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      for (let i = 0; i < AUTHFAIL.limit; i += 1) {
        await iso.rateLimit.enforceRateLimit(
          "authfail",
          "victim-ip",
          AUTHFAIL.limit,
          AUTHFAIL.windowSeconds,
        );
      }
      const locked = await iso.rateLimit.peekRateLimit(
        "authfail",
        "victim-ip",
        AUTHFAIL.limit,
        AUTHFAIL.windowSeconds,
      );
      assertEquals(locked.allowed, false, "precondition: victim is locked out (3/3)");

      for (let i = 0; i < FLOOD; i += 1) {
        await iso.rateLimit.enforceRateLimit("ip", `flood-${i}`, IP.limit, IP.windowSeconds);
      }

      const after = await iso.rateLimit.peekRateLimit(
        "authfail",
        "victim-ip",
        AUTHFAIL.limit,
        AUTHFAIL.windowSeconds,
      );
      assertEquals(after.allowed, false, "[defect] victim's auth-failure lockout vanished");
      assertEquals(after.remaining, 0, "[defect] victim's counter restarted");
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "memory fallback bounds identity bytes: 20 000 × 8 KB identities grow the heap by < 20 MB and never exceed the entry cap",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const before = heapUsed();
      for (let i = 0; i < FLOOD; i += 1) {
        const id = `${"x".repeat(8_000)}-${i}`;
        await iso.rateLimit.enforceRateLimit("ip", id, IP.limit, IP.windowSeconds);
      }
      const growth = heapUsed() - before;
      assert(
        growth < HEAP_BUDGET_BYTES,
        `heap grew by ${(growth / 1024 / 1024).toFixed(1)} MB (cap ${HEAP_BUDGET_BYTES / 1024 / 1024} MB)`,
      );
      assert(
        iso.rateLimit.memoryWindowCount() <= iso.rateLimit.MEMORY_WINDOW_MAX,
        `windows.size ${iso.rateLimit.memoryWindowCount()} exceeds MEMORY_WINDOW_MAX`,
      );
      // A long identity is still counted consistently against itself.
      const long = "y".repeat(8_000);
      await iso.rateLimit.enforceRateLimit("user", long, 2, 60);
      await iso.rateLimit.enforceRateLimit("user", long, 2, 60);
      assertEquals((await iso.rateLimit.enforceRateLimit("user", long, 2, 60)).allowed, false);
      assertEquals((await iso.rateLimit.enforceRateLimit("user", `${long}z`, 2, 60)).allowed, true);
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "characterization: 20 000 requests with an 8 KB cf-connecting-ip grow the heap by < 20 MB through clientIp() + enforceRateLimit()",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const before = heapUsed();
      for (let i = 0; i < FLOOD; i += 1) {
        const request = new Request("https://example.test/v1/me", {
          headers: { "cf-connecting-ip": `${"x".repeat(8_000)}-${i}` },
        });
        const ip = clientIp(request);
        assert(ip.length <= 64, `identity is bounded, got ${ip.length} chars`);
        await iso.rateLimit.enforceRateLimit("ip", ip, IP.limit, IP.windowSeconds);
      }
      const growth = heapUsed() - before;
      assert(
        growth < HEAP_BUDGET_BYTES,
        `heap grew by ${(growth / 1024 / 1024).toFixed(1)} MB (cap ${HEAP_BUDGET_BYTES / 1024 / 1024} MB)`,
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test("clientIp() never returns unvalidated header bytes as the identity", () => {
  const raw8k = "x".repeat(8_000);
  const oversized = clientIp(
    new Request("https://example.test/", { headers: { "cf-connecting-ip": raw8k } }),
  );
  assert(oversized !== raw8k, "8 KB header must not be the identity");
  assert(oversized.length <= 64, `bounded identity, got ${oversized.length}`);

  const junk = clientIp(
    new Request("https://example.test/", { headers: { "cf-connecting-ip": "not an ip" } }),
  );
  assert(junk !== "not an ip", "free text must not be the identity");
  assert(junk !== "unknown", "junk must not collapse into the shared 'unknown' bucket");

  // An invalid edge header falls through to the trusted last x-forwarded-for hop.
  assertEquals(
    clientIp(
      new Request("https://example.test/", {
        headers: { "cf-connecting-ip": "not an ip", "x-forwarded-for": "9.9.9.9, 203.0.113.9" },
      }),
    ),
    "203.0.113.9",
  );
  assertEquals(
    clientIp(
      new Request("https://example.test/", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
    ),
    "203.0.113.7",
  );
  assertEquals(
    clientIp(
      new Request("https://example.test/", {
        headers: { "cf-connecting-ip": "2001:DB8::1" },
      }),
    ),
    "2001:db8::1",
  );
});
