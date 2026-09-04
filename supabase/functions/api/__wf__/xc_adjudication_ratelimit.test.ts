// xc-security adjudication — rate-limit memory-fallback candidates, run
// directly against rateLimit.ts with Upstash unconfigured (the fallback the
// function uses whenever UPSTASH_* secrets are unset or Redis is unreachable).
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json xc_adjudication_ratelimit.test.ts

Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

const { enforceRateLimit, peekRateLimit } = await import("../rateLimit.ts");
const { clientIp } = await import("../http.ts");

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test(
  "REPRO (defect): memory fallback — 20 000 distinct identities wipe EVERY live window, releasing a locked-out client",
  async () => {
    const limit = 3;
    for (let i = 0; i < limit; i += 1) await enforceRateLimit("authfail", "victim-ip", limit, 300);
    assertEquals(
      (await peekRateLimit("authfail", "victim-ip", limit, 300)).allowed,
      false,
      "victim is locked out",
    );

    // Any traffic that creates 20 000 live windows (distinct ip/user ids across
    // the scopes) trips `windows.clear()` in memoryIncr.
    for (let i = 0; i < 20_000; i += 1) await enforceRateLimit("ip", `flood-${i}`, 1_200, 60);

    const after = await peekRateLimit("authfail", "victim-ip", limit, 300);
    // DEFECT: expected still locked out; observed the window is gone.
    assertEquals(after.allowed, true, "[defect] victim's auth-failure lockout vanished");
    assertEquals(after.remaining, limit, "[defect] counter reset to zero");
  },
);

Deno.test(
  "characterization: memory fallback is bounded by ENTRY COUNT only — identity strings of arbitrary length are stored verbatim",
  async () => {
    const before = Deno.memoryUsage().heapUsed;
    const longId = "x".repeat(8_000); // an 8 KB header value survives typical gateway limits
    for (let i = 0; i < 20_000; i += 1) await enforceRateLimit("ip", `${longId}${i}`, 1_200, 60);
    const after = Deno.memoryUsage().heapUsed;
    const growthMb = (after - before) / (1024 * 1024);
    console.log(`heap growth for 20 000 × 8 KB identities: ${growthMb.toFixed(1)} MB`);
    // Informational: the cap is 20 000 entries, not bytes. The identity is only
    // client-controlled if the gateway lets `cf-connecting-ip` / the last
    // `x-forwarded-for` hop through unmodified (not verifiable on Linux).
    if (growthMb < 100)
      throw new Error(
        `expected > 100 MB growth to demonstrate byte-unbounded keys, saw ${growthMb.toFixed(1)} MB`,
      );
  },
);

Deno.test(
  "characterization: clientIp trusts cf-connecting-ip unconditionally and falls back to the LAST x-forwarded-for hop, else 'unknown'",
  () => {
    const cf = new Request("http://e/x", {
      headers: { "cf-connecting-ip": "anything-at-all", "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
    });
    assertEquals(
      clientIp(cf),
      "anything-at-all",
      "cf-connecting-ip wins verbatim (no format validation)",
    );
    const xff = new Request("http://e/x", { headers: { "x-forwarded-for": "9.9.9.9, 2.2.2.2" } });
    assertEquals(clientIp(xff), "2.2.2.2", "last hop is used, leftmost (client-supplied) ignored");
    assertEquals(clientIp(new Request("http://e/x")), "unknown", "no header → one shared identity");
  },
);
