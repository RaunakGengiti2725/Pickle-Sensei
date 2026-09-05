// Adjudication probes for stress area `edge-infra-3` (edge infrastructure:
// cache, rate limit, http/sanitize, legal, drills media, external accounts).
//
// The only stress-tester report for this area was HARD-BLOCKED (0 scenarios),
// so these probes ARE the executed evidence. They exercise the standalone
// modules directly (no index.ts) with a deterministic seed so every scenario
// replays byte-for-byte. Every test pins the behaviour observed at commit
// 1fb0efd7; tests tagged [characterization] pin a behaviour that is by design
// per AGENTS.md (documented degradation), not a defect.
//
//   cd supabase/functions/api/__wf__ && deno task test adjudicate_edge_infra_3_modules.test.ts
//   ADJ_SEED=<n> to replay another seed (default 0xed6e1f30).

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import { clientIp, constantTimeEqual, resolveRequestId, routeTemplate, sanitizeUserText } from "../http.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";
import { drillCatalog } from "../drills.ts";
import {
  ExternalAccountError,
  type AppleServerConfiguration,
  decryptAppleRefreshToken,
  deleteRevenueCatCustomer,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  isPermanentExternalAccountError,
  revokeAppleRefreshToken,
} from "../externalAccounts.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

const SEED = Number(Deno.env.get("ADJ_SEED") ?? 0xed6e1f30) >>> 0;
let scenarios = 0;
const note = (line: string) => console.log(`[adj:modules] ${line}`);

/** mulberry32 — tiny deterministic PRNG so every payload replays. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTROL_AND_SPOOFING =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// ─── http.ts: sanitizeUserText fuzz ──────────────────────────────────────────

Deno.test(`sanitizeUserText: 3000 seeded hostile strings (seed ${SEED}) always yield bounded, clean, idempotent, JSON-safe text`, () => {
  const rand = prng(SEED);
  const pool: string[] = [
    "\u0000", "\u0007", "\u0008", "\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u001b", "\u001f",
    "\u007f", "\u0085", "\u009f", "\u00a0", "\u00ad", "\u034f", "\u061c", "\u180e", "\u200b", "\u200c",
    "\u200d", "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u202e", "\u2060", "\u2066", "\u2069",
    "\u3000", "\ufeff", "\ufff9", "\ufffe", "\uffff", "\ud83d", "\udc00", "😀", "👨‍👩‍👧‍👦", "🇺🇸",
    "e\u0301", "\u0f00", "a", "Z", "0", " ", ".", "'", "\"", "<", ">", "&", "\\", "{", "}", "\u{e0041}",
    "\u{1f3d3}", "ﬁ", "\u1680",
  ];
  let stripped = 0;
  for (let i = 0; i < 3000; i += 1) {
    const length = 1 + Math.floor(rand() * 80);
    let input = "";
    for (let j = 0; j < length; j += 1) input += pool[Math.floor(rand() * pool.length)];
    const maxLength = 1 + Math.floor(rand() * 64);
    const out = sanitizeUserText(input, maxLength);
    if (out.length < input.length) stripped += 1;
    assert(!CONTROL_AND_SPOOFING.test(out), `case ${i}: control/bidi char survived: ${JSON.stringify(out)}`);
    assert(!LONE_SURROGATE.test(out), `case ${i}: lone surrogate survived: ${JSON.stringify(out)}`);
    assert(Array.from(out).length <= maxLength, `case ${i}: ${Array.from(out).length} code points > ${maxLength}`);
    assertEquals(out, out.trim(), `case ${i}: not trimmed`);
    assert(!/\s{2}/.test(out), `case ${i}: double whitespace survived`);
    assert(!/[\r\n\t]/.test(out), `case ${i}: line break / tab survived`);
    assertEquals(sanitizeUserText(out, maxLength), out, `case ${i}: not idempotent`);
    // Valid UTF-16 → encodeURIComponent and JSON round trip never throw.
    encodeURIComponent(out);
    assertEquals(JSON.parse(JSON.stringify(out)), out);
    scenarios += 1;
  }
  note(`sanitize fuzz: 3000 cases, ${stripped} shortened, seed=${SEED}`);
});

Deno.test("[characterization] sanitizeUserText keeps Unicode format characters outside its bidi/zero-width list (U+061C ALM, U+2060 WJ, U+00AD SHY, U+034F CGJ, tag characters)", () => {
  // Unicode Bidi_Control includes U+061C; Default_Ignorable_Code_Point covers
  // U+2060, U+00AD, U+034F, U+E0001/U+E0020–E007F. None are stripped today.
  const survivors = ["\u061c", "\u2060", "\u00ad", "\u034f", "\u{e0041}"].filter(
    (ch) => sanitizeUserText(`a${ch}b`, 16) === `a${ch}b`,
  );
  assertEquals(survivors.length, 5, `expected all five to survive today; survivors=${JSON.stringify(survivors)}`);
  scenarios += 5;
  note("sanitize gap (P3): U+061C, U+2060, U+00AD, U+034F, U+E0041 pass through unchanged");
});

Deno.test("sanitizeUserText: pathological sizes (1 MiB control soup, 100k emoji) finish fast and cap in code points", () => {
  const start = performance.now();
  const soup = "\u0000\u200b\u202e😀 \n".repeat(1024 * 64);
  const out = sanitizeUserText(soup, 512);
  const outLength = Array.from(out).length;
  assert(outLength <= 512 && outLength >= 511, `soup capped at ${outLength} (trailing space trimmed after the cap)`);
  const emoji = sanitizeUserText("😀".repeat(100_000), 2048);
  assertEquals(Array.from(emoji).length, 2048);
  assert(!LONE_SURROGATE.test(emoji));
  const elapsed = performance.now() - start;
  assert(elapsed < 2_000, `took ${elapsed.toFixed(0)}ms`);
  scenarios += 2;
  note(`sanitize pathological sizes: ${elapsed.toFixed(0)}ms`);
});

// ─── http.ts: clientIp / constantTimeEqual / request id ──────────────────────

Deno.test("clientIp: seeded spoofing matrix — client-prepended XFF hops never win; blank edge header is ignored", () => {
  const rand = prng(SEED ^ 0x1);
  for (let i = 0; i < 200; i += 1) {
    const hops = Array.from({ length: 1 + Math.floor(rand() * 6) }, () =>
      `${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`,
    );
    const spoofPrefix = rand() < 0.5 ? "127.0.0.1, ::1, unknown, " : "";
    const junk = rand() < 0.3 ? ",  ,," : "";
    const headers: Record<string, string> = { "x-forwarded-for": `${spoofPrefix}${hops.join(" , ")}${junk}` };
    const withEdge = rand() < 0.3;
    if (withEdge) headers["cf-connecting-ip"] = "  203.0.113.9  ";
    if (rand() < 0.1) headers["cf-connecting-ip"] = "   ";
    const ip = clientIp(new Request("https://edge.test/v1/me", { headers }));
    if (headers["cf-connecting-ip"]?.trim()) assertEquals(ip, "203.0.113.9");
    else assertEquals(ip, hops[hops.length - 1], `case ${i}`);
    scenarios += 1;
  }
  assertEquals(clientIp(new Request("https://edge.test/", { headers: { "x-forwarded-for": " , , " } })), "unknown");
  scenarios += 1;
});

Deno.test("constantTimeEqual: seeded pairs agree with === (equal, prefix, one-bit flips, length mismatch, empty)", () => {
  const rand = prng(SEED ^ 0x2);
  for (let i = 0; i < 500; i += 1) {
    const length = Math.floor(rand() * 64);
    const a = Array.from({ length }, () => String.fromCharCode(32 + Math.floor(rand() * 95))).join("");
    const mode = Math.floor(rand() * 4);
    let b = a;
    if (mode === 1 && a.length) {
      const idx = Math.floor(rand() * a.length);
      b = a.slice(0, idx) + String.fromCharCode(a.charCodeAt(idx) ^ 1) + a.slice(idx + 1);
    } else if (mode === 2) b = a + "x";
    else if (mode === 3) b = a.slice(0, Math.max(0, a.length - 1));
    assertEquals(constantTimeEqual(a, b), a === b, `case ${i} mode ${mode}`);
    scenarios += 1;
  }
  assertEquals(constantTimeEqual("", ""), true);
  assertEquals(constantTimeEqual("", "a"), false);
  // Non-ASCII compares by UTF-8 bytes, so a NFC/NFD pair is NOT equal.
  assertEquals(constantTimeEqual("e\u0301", "\u00e9"), false);
  scenarios += 3;
});

Deno.test("resolveRequestId / routeTemplate: hostile ids are replaced, templates never echo raw ids", () => {
  // CR/LF cannot even enter a Headers object (pinned in http_test.ts), so the
  // hostile set is what a gateway can actually forward.
  const hostile = ["x".repeat(200), "ünïcode", "", " ", "id with space", "<script>", "../../etc", "a;b", "%0d%0a"];
  for (const id of hostile) {
    const minted = resolveRequestId(new Request("http://x/", { headers: { "x-request-id": id } }));
    assert(minted !== id, `hostile id echoed: ${JSON.stringify(id)}`);
    assert(/^[A-Za-z0-9._-]{1,128}$/.test(minted), `minted id not well-formed: ${minted}`);
    scenarios += 1;
  }
  const t = routeTemplate("/v1/analysis-permits/0b3f0d5e-8f5e-4e9d-9d2c-1c1c1c1c1c1c/finalize");
  assert(!t.includes("0b3f0d5e"), t);
  assert(!routeTemplate("/v1/shots/1234567890123").includes("1234567890123"));
  scenarios += 2;
});

// ─── rateLimit.ts: boundaries, rollover, concurrency, Redis faults ────────────

async function boundaryProbe(mode: "redis" | "memory") {
  configureRedis(mode === "redis");
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    const rand = prng(SEED ^ 0x3);
    for (let round = 0; round < 12; round += 1) {
      const limit = 1 + Math.floor(rand() * 40);
      const windowSeconds = [1, 5, 60, 300][Math.floor(rand() * 4)];
      const id = `probe-${mode}-${round}`;
      // Freeze the clock inside one aligned bucket so the burst cannot roll over.
      const realNow = Date.now;
      const frozen = realNow();
      Date.now = () => frozen;
      try {
        for (let n = 1; n <= limit; n += 1) {
          const r = await iso.rateLimit.enforceRateLimit("adj", id, limit, windowSeconds);
          assertEquals(r.allowed, true, `${mode} round ${round}: hit ${n}/${limit} denied`);
          assertEquals(r.remaining, limit - n);
          const peek = await iso.rateLimit.peekRateLimit("adj", id, limit, windowSeconds);
          assertEquals(peek.allowed, n < limit, `${mode} round ${round}: peek after ${n}`);
          assertEquals(peek.remaining, limit - n);
        }
        const denied = await iso.rateLimit.enforceRateLimit("adj", id, limit, windowSeconds);
        assertEquals(denied.allowed, false, `${mode} round ${round}: hit ${limit + 1} allowed`);
        assertEquals(denied.remaining, 0);
        assert(denied.retryAfterSeconds >= 1 && denied.retryAfterSeconds <= windowSeconds, `retryAfter ${denied.retryAfterSeconds}`);
        const res = iso.rateLimit.rateLimitResponse(denied);
        assertEquals(res.status, 429);
        assertEquals(res.headers.get("Retry-After"), String(denied.retryAfterSeconds));
        assertEquals(res.headers.get("Cache-Control"), "no-store");
        // Peek never charges: 50 peeks leave the count untouched.
        for (let p = 0; p < 50; p += 1) await iso.rateLimit.peekRateLimit("adj", id, limit, windowSeconds);
        const stillDenied = await iso.rateLimit.peekRateLimit("adj", id, limit + 51, windowSeconds);
        assertEquals(stillDenied.remaining, 50, "peeks were charged");
        // Next aligned window: budget is fresh, Retry-After was honest.
        Date.now = () => frozen + denied.retryAfterSeconds * 1_000;
        const fresh = await iso.rateLimit.enforceRateLimit("adj", id, limit, windowSeconds);
        assertEquals(fresh.allowed, true, `${mode} round ${round}: window did not roll over after Retry-After`);
        assertEquals(fresh.remaining, limit - 1);
        // A second before Retry-After the budget is still spent.
        Date.now = () => frozen + Math.max(0, denied.retryAfterSeconds - 1) * 1_000;
        const early = await iso.rateLimit.peekRateLimit("adj", id, limit, windowSeconds);
        assertEquals(early.allowed, false, `${mode} round ${round}: budget reset before Retry-After`);
      } finally {
        Date.now = realNow;
      }
      scenarios += 1;
    }
    if (mode === "redis") {
      for (const key of redis.store.keys()) {
        assert(key.startsWith("rl:adj:"), key);
        assert(redis.store.get(key)!.expiresAtMs !== null, `window key without TTL: ${key}`);
      }
    }
  } finally {
    redis.restore();
  }
}

Deno.test("rateLimit (Redis): 12 seeded limit/window combos — exact boundary, peek never charges, Retry-After is honest", async () => {
  await boundaryProbe("redis");
});

Deno.test("rateLimit (memory fallback): 12 seeded limit/window combos — exact boundary, peek never charges, Retry-After is honest", async () => {
  await boundaryProbe("memory");
});

Deno.test("rateLimit (Redis): 300 concurrent hits across 3 isolates admit EXACTLY the limit (atomic INCR, no under-count)", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const isolates = [await loadIsolate(), await loadIsolate(), await loadIsolate()];
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      const results = await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          isolates[i % 3].rateLimit.enforceRateLimit("authfail", "198.51.100.77", 30, 300),
        ),
      );
      assertEquals(results.filter((r) => r.allowed).length, 30);
      assertEquals(results.filter((r) => !r.allowed).length, 270);
      const key = [...redis.store.keys()].find((k) => k.startsWith("rl:authfail:"))!;
      assertEquals(redis.store.get(key)!.value, "300");
      for (const iso of isolates) {
        const peek = await iso.rateLimit.peekRateLimit("authfail", "198.51.100.77", 30, 300);
        assertEquals(peek.allowed, false, "every isolate sees the tripped budget");
      }
    } finally {
      Date.now = realNow;
    }
    scenarios += 1;
  } finally {
    redis.restore();
  }
});

Deno.test("rateLimit (Redis HTTP 5xx / unreachable): enforce AND peek degrade to the same isolate memory window, so the auth-failure gate still closes", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      for (const status of [500, 502, 503, 429, 401]) {
        redis.failStatus = status;
        const id = `fault-http-${status}`;
        for (let n = 1; n <= 5; n += 1) {
          const r = await iso.rateLimit.enforceRateLimit("authfail", id, 5, 300);
          assertEquals(r.allowed, true, `${status}: hit ${n} denied`);
        }
        const denied = await iso.rateLimit.enforceRateLimit("authfail", id, 5, 300);
        assertEquals(denied.allowed, false, `${status}: 6th hit allowed`);
        const peek = await iso.rateLimit.peekRateLimit("authfail", id, 5, 300);
        assertEquals(peek.allowed, false, `${status}: peek does not see the memory window`);
        assertEquals(peek.remaining, 0);
        scenarios += 1;
      }
      redis.failStatus = null;
    } finally {
      Date.now = realNow;
    }
  } finally {
    redis.restore();
  }
});

Deno.test("[defect] rateLimit (Redis per-command error / short reply): enforce falls back to memory but peek reads the errored GET as 0 — the auth-failure gate never closes", async () => {
  // cache.ts redisWindowGet: `raw === null || raw === undefined → 0`. A
  // pipeline reply of [{ error: "ERR max requests limit exceeded" }] (Upstash
  // quota / OOM / NOPERM answer this way with HTTP 200) or a short reply has
  // no `result`, so the window is reported EMPTY instead of UNKNOWN (null).
  // redisWindowIncr treats the same reply as unknown (NaN → null → memory),
  // so the two halves of the gate in index.ts (peek before routing, enforce
  // after a 401) read different stores while the fault lasts.
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      const faults: Array<[string, () => void]> = [
        ["command-error", () => { redis.commandError = () => "ERR max requests limit exceeded"; }],
        ["short-reply", () => { redis.commandError = null; redis.truncateRepliesTo = 0; }],
      ];
      for (const [name, arm] of faults) {
        arm();
        const id = `fault-${name}`;
        for (let n = 1; n <= 30; n += 1) {
          assertEquals((await iso.rateLimit.enforceRateLimit("authfail", id, 30, 300)).allowed, true, `${name}: hit ${n}`);
        }
        const denied = await iso.rateLimit.enforceRateLimit("authfail", id, 30, 300);
        assertEquals(denied.allowed, false, `${name}: enforce (memory fallback) is tripped`);
        const peek = await iso.rateLimit.peekRateLimit("authfail", id, 30, 300);
        // Observed at 1fb0efd7 — invert these two assertions when the fix lands
        // (expected: allowed === false, remaining === 0).
        assertEquals(peek.allowed, true, `${name}: peek reports the tripped window as open`);
        assertEquals(peek.remaining, 30, `${name}: peek reports a full budget`);
        const bucket = Math.floor(frozen / 300_000);
        assertEquals(await iso.cache.redisWindowGet(`rl:authfail:${bucket}:${id}`), 0, `${name}: redisWindowGet answers 0 for an errored GET`);
        note(`DEFECT ${name}: enforce=denied(31/30 in memory) peek=allowed(remaining ${peek.remaining}) — authfail gate open during Upstash command-level faults`);
        scenarios += 1;
      }
      redis.truncateRepliesTo = null;
    } finally {
      Date.now = realNow;
    }
  } finally {
    redis.restore();
  }
});

Deno.test("[characterization] rateLimit memory fallback: the 20 000-window cap resets ALL windows (fail-open by design, bounded memory)", async () => {
  configureRedis(false);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      for (let n = 0; n < 3; n += 1) await iso.rateLimit.enforceRateLimit("adj", "victim", 3, 60);
      assertEquals((await iso.rateLimit.peekRateLimit("adj", "victim", 3, 60)).allowed, false);
      for (let i = 0; i < 20_000; i += 1) await iso.rateLimit.enforceRateLimit("adj", `flood-${i}`, 3, 60);
      const after = await iso.rateLimit.peekRateLimit("adj", "victim", 3, 60);
      assertEquals(after.allowed, true, "documented: cap clears every window incl. the tripped one");
      note("memory fallback cap: 20 000 distinct ids from one isolate reset a tripped window (design, needs Redis for shared enforcement)");
    } finally {
      Date.now = realNow;
    }
    scenarios += 1;
  } finally {
    redis.restore();
  }
});

// ─── cache.ts: revocation fence + generation fence under seeded interleavings ─

Deno.test("cache: 40 seeded logout/verify interleavings across 2 isolates never serve a fenced session", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const a = await loadIsolate();
    const b = await loadIsolate();
    const rand = prng(SEED ^ 0x4);
    for (let round = 0; round < 40; round += 1) {
      const key = `auth:row-${round}`;
      const revoked = `auth:revoked:s-${round}`;
      // Both isolates hold a warm L1 copy of the verified row.
      await a.cache.cacheSet(key, "row", 600);
      assertEquals((await b.cache.cacheGetUnlessRevoked(key, revoked)).value, "row");
      // Logout handled by a random isolate: fence + delete, in the production order.
      const revoker = rand() < 0.5 ? a : b;
      const other = revoker === a ? b : a;
      await revoker.cache.cacheSet(revoked, "1", 660);
      await revoker.cache.cacheDel(key);
      // A racing verification on the other isolate re-caches the row (fenced write).
      if (rand() < 0.5) {
        const fence = await other.cache.cacheFence(key);
        await other.cache.cacheSetFenced(fence, "row", 600);
      } else {
        await other.cache.cacheSet(key, "row", 600);
      }
      const fromOther = await other.cache.cacheGetUnlessRevoked(key, revoked);
      const fromRevoker = await revoker.cache.cacheGetUnlessRevoked(key, revoked);
      assertEquals(fromOther.revoked, true, `round ${round}: other isolate served a fenced session`);
      assertEquals(fromRevoker.revoked, true, `round ${round}: revoker served a fenced session`);
      assertEquals(fromOther.value, null);
      scenarios += 1;
    }
  } finally {
    redis.restore();
  }
});

Deno.test("cache: fenced write loses to a cacheDel from another isolate in every one of 20 seeded orderings", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const a = await loadIsolate();
    const b = await loadIsolate();
    for (let round = 0; round < 20; round += 1) {
      const key = `auth:gen-${round}`;
      await a.cache.cacheSet(key, "old", 600);
      const fence = await b.cache.cacheFence(key);
      await a.cache.cacheDel(key);
      const wrote = await b.cache.cacheSetFenced(fence, "stale-reverify", 600);
      assertEquals(wrote, false, `round ${round}: stale write landed`);
      assertEquals(await a.cache.cacheGet(key), null);
      assertEquals(await b.cache.cacheGet(key), null);
      assertEquals(redis.store.has(key), false);
      scenarios += 1;
    }
  } finally {
    redis.restore();
  }
});

Deno.test("cache: hostile Redis payloads (non-string GET, negative/NaN TTL, huge values) never throw and never warm L1 without a TTL", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    // Value without TTL in L2 (as if written by another tool).
    redis.store.set("auth:no-ttl", { value: "x", expiresAtMs: null });
    assertEquals(await iso.cache.cacheGet("auth:no-ttl"), "x");
    redis.store.delete("auth:no-ttl");
    assertEquals(await iso.cache.cacheGet("auth:no-ttl"), null, "L1 warmed from a TTL-less L2 row");
    // Fake replies with a number where a string is expected.
    redis.commandError = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ result: 42 }, { result: "not-a-number" }]), { status: 200 })) as typeof fetch;
    try {
      assertEquals(await iso.cache.cacheGet("auth:weird"), null);
      assertEquals(await iso.cache.redisWindowIncr("rl:weird", 60), 42);
      globalThis.fetch = (async () => new Response("null", { status: 200 })) as typeof fetch;
      assertEquals(await iso.cache.cacheGet("auth:null-reply"), null);
      assertEquals(await iso.cache.redisWindowIncr("rl:null-reply", 60), null);
      globalThis.fetch = (async () => new Response("{not json", { status: 200 })) as typeof fetch;
      assertEquals(await iso.cache.cacheGet("auth:bad-json"), null);
    } finally {
      globalThis.fetch = original;
    }
    const big = "v".repeat(1024 * 1024);
    assertEquals(await iso.cache.cacheSet("auth:big", big, 0.4), true);
    assertEquals(await iso.cache.cacheGet("auth:big"), big);
    scenarios += 3;
  } finally {
    redis.restore();
  }
});

// ─── drillMedia.ts ───────────────────────────────────────────────────────────

Deno.test("drillMedia: every catalog slug yields deterministic ids, youtube-nocookie embeds, verified creator attribution; hostile slugs yield []", async () => {
  const catalog = await drillCatalog();
  assert(catalog.length >= 40, `catalog has ${catalog.length} drills`);
  let withMedia = 0;
  const seenIds = new Set<string>();
  for (const drill of catalog) {
    const first = await drillInstructionalMedia(drill.slug);
    const second = await drillInstructionalMedia(drill.slug);
    assertEquals(JSON.stringify(first), JSON.stringify(second), `${drill.slug}: not deterministic`);
    if (first.length) withMedia += 1;
    for (const item of first) {
      assert(/^[0-9a-f-]{36}$/.test(item.id), `${drill.slug}: id ${item.id}`);
      assert(!seenIds.has(`${drill.slug}:${item.id}`));
      seenIds.add(`${drill.slug}:${item.id}`);
      assertEquals(item.kind, "embed");
      assertEquals(item.provider, "youtube");
      assert(/^[A-Za-z0-9_-]{11}$/.test(item.videoId), item.videoId);
      assertEquals(item.embedUrl, `https://www.youtube-nocookie.com/embed/${item.videoId}`);
      assertEquals(item.sourceUrl, `https://www.youtube.com/watch?v=${item.videoId}`);
      assert(item.creatorName.trim().length > 0 && item.attribution.includes(item.creatorName));
      assertEquals(item.licenseUrl, "https://www.youtube.com/t/terms");
      assertEquals(sanitizeUserText(item.attribution, 512), item.attribution.replace(/\s+/g, " ").trim(), `${drill.slug}: attribution carries control chars`);
    }
    scenarios += 1;
  }
  for (const hostile of ["__proto__", "", "../", "🏓", "x".repeat(10_000), "midcourt-reset-blocks/../x"]) {
    assertEquals(await drillInstructionalMedia(hostile), [], `hostile slug ${JSON.stringify(hostile.slice(0, 20))}`);
    scenarios += 1;
  }
  note(`drillMedia: ${catalog.length} slugs, ${withMedia} with media, ${seenIds.size} media rows`);
});

Deno.test("[characterization → P3] drillMedia: Object.prototype keys as slugs throw TypeError inside drillInstructionalMedia (unreachable over HTTP — getCatalogDrill 404s first via drillCatalogEntry.find)", async () => {
  const thrown: string[] = [];
  for (const slug of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    try {
      await drillInstructionalMedia(slug);
    } catch (error) {
      thrown.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // `MEDIA_BY_SLUG[slug] ?? []` sees Object.prototype members (functions), not
  // undefined, so `.map` is called on a function. Observed at 1fb0efd7.
  assertEquals(thrown.length, 4, JSON.stringify(thrown));
  note(`drillMedia prototype-key slugs: ${JSON.stringify(thrown)}`);
  scenarios += 4;
});

// ─── legal.ts: copy policy (docs/APP_STORE_SUBMISSION.md) ────────────────────

Deno.test("legal + drillMedia copy: no Android/Google Play/guest mode/Live Court/DUPR mentions, no accuracy-% or AI-coach-equivalence claims in first-party text", async () => {
  const banned = [/android/i, /google play/i, /guest mode/i, /live court/i, /\bDUPR\b/, /swingvision/i, /pb vision/i, /\bjoola\b/i, /\d+(\.\d+)?\s?%\s*(accura|precis)/i, /as (good|accurate) as a (human |real )?coach/i, /replaces? (a|your) coach/i];
  for (const [name, text] of [["privacy", PRIVACY_POLICY_TEXT], ["terms", TERMS_TEXT], ["support", SUPPORT_TEXT]] as const) {
    for (const re of banned) assert(!re.test(text), `${name} matches ${re}`);
    assert(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text), `${name}: no support mailbox`);
    scenarios += 1;
  }
  // Third-party attribution is verbatim oEmbed data (creator names are shown
  // by design per docs/APP_STORE_SUBMISSION.md §3.2 / §11); only OUR strings
  // are held to the first-party copy rules.
  const catalog = await drillCatalog();
  const creators = new Set<string>();
  for (const drill of catalog) for (const m of await drillInstructionalMedia(drill.slug)) creators.add(m.creatorName);
  note(`third-party creators attributed verbatim: ${[...creators].sort().join(" | ")}`);
  scenarios += 1;
});

// ─── externalAccounts.ts ─────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function appleConfig(): Promise<AppleServerConfiguration> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    clientId: "com.picklesensei",
    teamId: "TEAMID1234",
    keyId: "KEYID12345",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`,
    tokenEncryptionKey: b64(crypto.getRandomValues(new Uint8Array(32))),
  };
}

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

Deno.test("externalAccounts crypto: 60 seeded tokens — AAD binds to the user, any bit flip or key swap is a permanent invalid_response, never a plaintext", async () => {
  const rand = prng(SEED ^ 0x5);
  const key = b64(crypto.getRandomValues(new Uint8Array(32)));
  const otherKey = b64(crypto.getRandomValues(new Uint8Array(32)));
  for (let i = 0; i < 60; i += 1) {
    const token = Array.from({ length: 1 + Math.floor(rand() * 200) }, () => String.fromCharCode(33 + Math.floor(rand() * 94))).join("");
    const enc = await encryptAppleRefreshToken(token, USER_A, key);
    assert(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(enc), enc);
    assertEquals(await decryptAppleRefreshToken(enc, USER_A, key), token);
    for (const [label, tampered, user, k] of [
      ["other-user", enc, USER_B, key],
      ["other-key", enc, USER_A, otherKey],
      ["flip-ct", (() => { const [v, iv, ct] = enc.split("."); const idx = Math.floor(rand() * ct.length); const ch = ct[idx] === "A" ? "B" : "A"; return `${v}.${iv}.${ct.slice(0, idx)}${ch}${ct.slice(idx + 1)}`; })(), USER_A, key],
      ["flip-iv", (() => { const [v, iv, ct] = enc.split("."); const ch = iv[0] === "A" ? "B" : "A"; return `${v}.${ch}${iv.slice(1)}.${ct}`; })(), USER_A, key],
      ["truncated-4", (() => { const [v, iv, ct] = enc.split("."); return `${v}.${iv}.${ct.slice(0, ct.length - (ct.length % 4 || 4))}`; })(), USER_A, key],
    ] as const) {
      let caught: unknown = null;
      try { await decryptAppleRefreshToken(tampered, user, k); } catch (e) { caught = e; }
      assert(caught instanceof ExternalAccountError, `${label} case ${i}: no ExternalAccountError`);
      assertEquals(caught.kind, "invalid_response", `${label} case ${i}: kind ${caught.kind}`);
      assert(isPermanentExternalAccountError(caught), `${label}: not permanent`);
    }
    scenarios += 1;
  }
});

Deno.test("[characterization → P3] externalAccounts: a stored credential whose iv/ciphertext segment is not base64 is misclassified as a 'configuration' (retryable) error, blaming APPLE_TOKEN_ENCRYPTION_KEY", async () => {
  const key = b64(crypto.getRandomValues(new Uint8Array(32)));
  const outcomes: Record<string, string> = {};
  const key2 = b64(crypto.getRandomValues(new Uint8Array(32)));
  const genuine = await encryptAppleRefreshToken("rt-genuine", USER_A, key2);
  const [v, iv, ct] = genuine.split(".");
  // A ciphertext that lost 1 char (length % 4 === 1 after padding) is the
  // realistic corruption shape: atob refuses it → misclassified.
  const truncatedByOne = `${v}.${iv}.${ct.slice(0, ct.length - ((ct.length - 1) % 4))}`;
  assertEquals(ct.slice(0, ct.length - ((ct.length - 1) % 4)).length % 4, 1);
  for (const corrupt of ["v1.a.b", "v1.!!!!.@@@@", "v1.AAAA.é", `v1.${"A".repeat(16)}.=`, truncatedByOne]) {
    let caught: unknown = null;
    try { await decryptAppleRefreshToken(corrupt, USER_A, key); } catch (e) { caught = e; }
    assert(caught instanceof ExternalAccountError);
    outcomes[corrupt] = `${caught.kind}: ${caught.message}`;
  }
  note(`corrupt-row classification: ${JSON.stringify(outcomes)}`);
  // Today: decodeBase64() throws the configuration error for ANY segment.
  const kinds = new Set(Object.values(outcomes).map((o) => o.split(":")[0]));
  assert(kinds.has("configuration"), `expected the misclassification to be live; got ${JSON.stringify(outcomes)}`);
  assertEquals(isPermanentExternalAccountError(new ExternalAccountError("configuration", "apple", "x")), false);
  scenarios += 4;
});

Deno.test("externalAccounts: Apple/RevenueCat error classification matrix (status × body) — only invalid_grant is permanent; 429/5xx/network/timeout are retryable", async () => {
  const config = await appleConfig();
  const matrix: Array<[number, unknown, "invalid_grant" | "unavailable"]> = [
    [400, { error: "invalid_grant" }, "invalid_grant"],
    [400, { error: "invalid_client" }, "unavailable"],
    [400, { error: "invalid_request" }, "unavailable"],
    [400, "not json", "unavailable"],
    [400, null, "unavailable"],
    [401, { error: "invalid_client" }, "unavailable"],
    [429, {}, "unavailable"],
    [500, { error: "invalid_grant" }, "invalid_grant"],
    [502, "", "unavailable"],
    [503, [], "unavailable"],
  ];
  for (const [status, body, expected] of matrix) {
    const fetchFn = async () => new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
    for (const call of [
      () => revokeAppleRefreshToken("rt", config, fetchFn),
      () => exchangeAppleAuthorizationCode("code", config, fetchFn),
    ]) {
      let caught: unknown = null;
      try { await call(); } catch (e) { caught = e; }
      assert(caught instanceof ExternalAccountError, `${status} ${JSON.stringify(body)}: no ExternalAccountError`);
      assertEquals(caught.kind, expected, `${status} ${JSON.stringify(body)}`);
      assertEquals(caught.provider, "apple");
    }
    scenarios += 1;
  }
  // Network failure and a request-body-less 200 with garbage grant.
  const dead = async () => { throw new TypeError("connection refused"); };
  for (const call of [
    () => revokeAppleRefreshToken("rt", config, dead),
    () => exchangeAppleAuthorizationCode("code", config, dead),
    () => deleteRevenueCatCustomer("app-user", "sk_test", dead),
  ]) {
    let caught: unknown = null;
    try { await call(); } catch (e) { caught = e; }
    assert(caught instanceof ExternalAccountError);
    assertEquals(caught.kind, "unavailable");
    scenarios += 1;
  }
  for (const grant of [{}, { refresh_token: "" }, { refresh_token: "rt" }, { refresh_token: "rt", id_token: "x.y" }, { refresh_token: "rt", id_token: `a.${b64url("[]")}.c` }, { refresh_token: "rt", id_token: `a.${b64url(JSON.stringify({ sub: "" }))}.c` }, "garbage", [1]]) {
    let caught: unknown = null;
    try {
      await exchangeAppleAuthorizationCode("code", config, async () => new Response(typeof grant === "string" ? grant : JSON.stringify(grant), { status: 200 }));
    } catch (e) { caught = e; }
    assert(caught instanceof ExternalAccountError, `grant ${JSON.stringify(grant)}`);
    assertEquals(caught.kind, "invalid_response");
    scenarios += 1;
  }
  // RevenueCat: 404 is success, 401/429/500 retryable, empty key is configuration, id is URL-encoded.
  let seenUrl = "";
  await deleteRevenueCatCustomer("user/with spaces?x=1", "sk", async (input) => { seenUrl = String(input); return new Response(null, { status: 404 }); });
  assert(seenUrl.endsWith(encodeURIComponent("user/with spaces?x=1")), seenUrl);
  for (const status of [401, 429, 500]) {
    let caught: unknown = null;
    try { await deleteRevenueCatCustomer("u", "sk", async () => new Response(null, { status })); } catch (e) { caught = e; }
    assert(caught instanceof ExternalAccountError && caught.kind === "unavailable" && caught.provider === "revenuecat", `rc ${status}`);
  }
  let caught: unknown = null;
  try { await deleteRevenueCatCustomer("u", "   "); } catch (e) { caught = e; }
  assert(caught instanceof ExternalAccountError && caught.kind === "configuration");
  scenarios += 5;
});

Deno.test("externalAccounts: bad PEM / bad encryption key are configuration errors before any network call", async () => {
  const config = await appleConfig();
  let calls = 0;
  const fetchFn = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  for (const pem of ["", "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----"]) {
    let caught: unknown = null;
    try { await revokeAppleRefreshToken("rt", { ...config, privateKeyPem: pem }, fetchFn); } catch (e) { caught = e; }
    assert(caught instanceof ExternalAccountError && caught.kind === "configuration", `pem ${JSON.stringify(pem.slice(0, 20))}`);
    scenarios += 1;
  }
  assertEquals(calls, 0, "network was reached with a broken signer");
  for (const key of ["", "short", b64(new Uint8Array(16)), b64(new Uint8Array(33)), "not*base64"]) {
    let caught: unknown = null;
    try { await encryptAppleRefreshToken("rt", USER_A, key); } catch (e) { caught = e; }
    assert(caught instanceof ExternalAccountError && caught.kind === "configuration", `key ${JSON.stringify(key)}`);
    scenarios += 1;
  }
});

Deno.test("adjudication summary (modules)", () => {
  note(`scenarios executed in this module: ${scenarios} (seed ${SEED})`);
  assert(scenarios > 0);
});
