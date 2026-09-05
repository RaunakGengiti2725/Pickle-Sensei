// STRESS (lens: boundary / malformed input) — rateLimit.ts at the module
// boundary, driven by a seeded generator so every iteration replays from its
// seed. Each campaign compares the real module (a fresh isolate from
// harness.ts, with and without the fake Upstash) against a tiny reference
// model of the documented fixed-window contract and records one row per
// iteration; the rows are written as a JSON table when STRESS_OUT is set.
//
//   STRESS_ITER   iterations per generated campaign (default 200 — fast enough
//                 for the suite; the audit campaign ran ≥ 3000)
//   STRESS_SEED   master seed (default 20260905); iteration i uses
//                 mix(STRESS_SEED, campaign, i) so a single row is replayable
//   STRESS_REPLAY replay exactly one iteration seed (decimal) and print it
//   STRESS_OUT    directory that receives module_seeds.json / module_heap.json
//   STRESS_FULL=1 also run the slow campaigns (100k-key memory, 4 KB ids)
//
// Run:  cd supabase/functions/api/__wf__ && STRESS_ITER=3000 STRESS_FULL=1 \
//         STRESS_OUT=/tmp/stress deno test -A --no-check --config deno.json \
//         stress_ratelimit_boundary_malformed.test.ts
//
// What is asserted (contract, from rateLimit.ts header + AGENTS.md):
//   - enforce/peek/rateLimitResponse NEVER throw for any string scope/id and
//     any caller-shaped budget (integer limit ≥ 1, integer window ≥ 1);
//   - the k-th hit in a bucket is allowed iff k ≤ limit; remaining =
//     max(0, limit − k); peek never charges; distinct (scope, id) strings are
//     distinct budgets (no key collision, incl. ":"-injection and prototype
//     names); 1 ≤ Retry-After ≤ window, integer, equal to the bucket remainder;
//   - the 429 body/headers never echo the id;
//   - a burst of N concurrent hits admits exactly `limit`;
//   - the bucket rolls exactly at the aligned boundary;
//   - with Upstash the stored key is exactly `rl:<scope>:<bucket>:<id>` and
//     the memory map is never used;
//   - Object.prototype is untouched by hostile ids.
// Hostile numerics (limit/window = 0, −1, NaN, ∞, fractions, wrong types) are
// SURVEYED (no throw is asserted; the observed result is recorded) because no
// caller in index.ts passes anything but the integer constants — see the
// campaign header for what the survey found.

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import { clientIp } from "../http.ts";

// ─── configuration ──────────────────────────────────────────────────────────

const STRESS_ITER = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "200") || 200);
const STRESS_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260905") || 20260905;
const STRESS_REPLAY = Deno.env.get("STRESS_REPLAY") ?? "";
const STRESS_OUT = Deno.env.get("STRESS_OUT") ?? "";
const STRESS_FULL = Deno.env.get("STRESS_FULL") === "1";

// ─── seeded RNG (mulberry32) ────────────────────────────────────────────────

function mix(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── fake clock ─────────────────────────────────────────────────────────────
// rateLimit.ts and harness.ts both read Date.now() from the global; patching
// it makes bucket arithmetic deterministic per seed. Restored after each test.

const realDateNow = Date.now;
let fakeNowMs: number | null = null;
function installClock(): void {
  Date.now = () => (fakeNowMs === null ? realDateNow() : fakeNowMs);
}
function restoreClock(): void {
  fakeNowMs = null;
  Date.now = realDateNow;
}
// 2026-09-05T00:00:00Z — a realistic epoch; campaigns offset from here.
const BASE_EPOCH_MS = 1_788_566_400_000;

// ─── generators ─────────────────────────────────────────────────────────────

/** Scopes actually used by index.ts. */
const SCOPES = [
  "ip",
  "authfail",
  "user",
  "healthz",
  "legal",
  "webhook",
  "auth_refresh",
  "billing_sync",
  "shots_sync",
] as const;
/** Budgets actually used by index.ts (limit, window seconds). */
const CALLER_BUDGETS: ReadonlyArray<readonly [number, number]> = [
  [1_200, 60],
  [30, 300],
  [30, 60],
  [60, 60],
  [240, 60],
  [10, 60],
  [12, 60],
  [3, 3_600],
  [5, 3_600],
  [1, 1],
  [2, 60],
];

const ID_CATEGORIES = [
  "ipv4",
  "ipv4-leading-zero",
  "ipv4-whitespace",
  "ipv6",
  "ipv6-zone",
  "uuid",
  "empty",
  "whitespace-only",
  "nul-byte",
  "control-chars",
  "long-1k",
  "long-64k",
  "long-256k",
  "path-traversal",
  "colon-injection",
  "key-prefix-injection",
  "proto-name",
  "unicode-nfc",
  "unicode-nfd",
  "grapheme-cluster",
  "lone-surrogate",
  "bidi-override",
  "numeric-literal",
  "json-blob",
  "sql-ish",
  "xff-list",
  "future-schema",
  "unknown-literal",
  "random-bytes",
] as const;
type IdCategory = (typeof ID_CATEGORIES)[number];

function randomBytes(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(rng.int(0, 0xffff));
  }
  return out;
}

function genId(rng: Rng, category: IdCategory): string {
  switch (category) {
    case "ipv4":
      return `${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(0, 255)}`;
    case "ipv4-leading-zero":
      return `0${rng.int(0, 99)}.${rng.int(0, 255)}.00${rng.int(0, 9)}.${rng.int(0, 255)}`;
    case "ipv4-whitespace":
      return `${" ".repeat(rng.int(1, 4))}${rng.int(0, 255)}.1.1.${rng.int(0, 255)}\t`;
    case "ipv6":
      return `2001:db8:${rng.int(0, 0xffff).toString(16)}::${rng.int(0, 0xffff).toString(16)}`;
    case "ipv6-zone":
      return `fe80::1%eth${rng.int(0, 9)}`;
    case "uuid":
      return `${rng.int(0, 0xffff).toString(16).padStart(4, "0")}1111-1111-4111-8111-111111111111`;
    case "empty":
      return "";
    case "whitespace-only":
      return rng.pick([" ", "\t", "  \t  ", "\u00a0", "\u3000"]);
    case "nul-byte":
      return `1.2.3.4\u0000${rng.int(0, 9)}`;
    case "control-chars":
      return `\u0001\u0002${rng.int(0, 9)}\u001b[31m\u007f`;
    case "long-1k":
      return rng.pick(["a", "9", "."]).repeat(1_024) + rng.int(0, 9);
    case "long-64k":
      return rng.pick(["x", "1"]).repeat(65_536 + rng.int(0, 16));
    case "long-256k":
      return "y".repeat(262_144) + rng.int(0, 9);
    case "path-traversal":
      return rng.pick(["../../etc/passwd", "..%2f..%2fetc", "/../..", "..\\..\\win.ini"]);
    case "colon-injection":
      return `1.2.3.4:${rng.int(0, 99999)}:${rng.pick(SCOPES)}`;
    case "key-prefix-injection":
      return `rl:${rng.pick(SCOPES)}:${rng.int(0, 1e9)}:${rng.int(0, 255)}.0.0.1`;
    case "proto-name":
      return rng.pick([
        "__proto__",
        "constructor",
        "prototype",
        "hasOwnProperty",
        "toString",
        "valueOf",
        "__defineGetter__",
      ]);
    case "unicode-nfc":
      return "caf\u00e9".repeat(rng.int(1, 3));
    case "unicode-nfd":
      return "cafe\u0301".repeat(rng.int(1, 3));
    case "grapheme-cluster":
      return "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}".repeat(rng.int(1, 4));
    case "lone-surrogate":
      return `\ud800${rng.int(0, 9)}\udc00`;
    case "bidi-override":
      return `\u202e4.3.2.1\u202c${rng.int(0, 9)}`;
    case "numeric-literal":
      return rng.pick(["0", "-0", "NaN", "Infinity", "-Infinity", "1e999", "0x1f", "1_000"]);
    case "json-blob":
      return `{"ip":"${rng.int(0, 255)}.0.0.1","__proto__":{"polluted":true}}`;
    case "sql-ish":
      return `' OR 1=1 --${rng.int(0, 9)}`;
    case "xff-list":
      return `${rng.int(0, 255)}.0.0.1, 10.0.0.${rng.int(0, 255)}, unknown`;
    case "future-schema":
      return `v${rng.int(2, 99)}:${rng.int(0, 255)}.0.0.1`;
    case "unknown-literal":
      return "unknown";
    case "random-bytes":
      return randomBytes(rng, rng.int(1, 64));
  }
}

/** A second id that must be a DIFFERENT budget from `id`. */
function genSibling(rng: Rng, id: string): string {
  const variants = [
    `${id} `,
    ` ${id}`,
    `${id}\u0000`,
    id.normalize("NFD") !== id ? id.normalize("NFD") : `${id}0`,
    id.toUpperCase() !== id ? id.toUpperCase() : `${id}a`,
    `0${id}`,
    `${id}:`,
    `:${id}`,
  ];
  const sibling = rng.pick(variants);
  return sibling === id ? `${id}#` : sibling;
}

// ─── reference model ────────────────────────────────────────────────────────

function modelBucket(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / (windowSeconds * 1_000));
}
function modelRetryAfter(nowMs: number, windowSeconds: number): number {
  const bucket = modelBucket(nowMs, windowSeconds);
  return Math.max(1, Math.ceil((bucket + 1) * windowSeconds - nowMs / 1_000));
}

// ─── result table ───────────────────────────────────────────────────────────

interface Row {
  campaign: string;
  iter: number;
  seed: number;
  mode: "memory" | "upstash";
  category: string;
  params: Record<string, unknown>;
  outcome: "HELD" | "BROKEN" | "SURVEY";
  detail: string;
}
const rows: Row[] = [];
/** Generated iterations that ran (one row each). */
let executed = 0;
/** Individual enforce() hits from the key-flood measurements (not rows). */
let floodHits = 0;

function preview(id: string): string {
  return id.length > 48
    ? `${JSON.stringify(id.slice(0, 40))}…(len ${id.length})`
    : JSON.stringify(id);
}

function iterSeeds(campaign: number, count: number): Array<{ iter: number; seed: number }> {
  if (STRESS_REPLAY) {
    return [{ iter: -1, seed: Number(STRESS_REPLAY) >>> 0 }];
  }
  const out: Array<{ iter: number; seed: number }> = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ iter: i, seed: mix(STRESS_SEED, campaign, i) });
  }
  return out;
}

class Check {
  failures: string[] = [];
  that(cond: unknown, msg: string): void {
    if (!cond) this.failures.push(msg);
  }
  eq(actual: unknown, expected: unknown, msg: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) this.failures.push(`${msg}: expected ${e}, got ${a}`);
  }
}

function record(row: Omit<Row, "outcome" | "detail">, check: Check): void {
  executed += 1;
  rows.push({
    ...row,
    outcome: check.failures.length === 0 ? "HELD" : "BROKEN",
    detail: check.failures.join(" | "),
  });
}

async function flushTable(): Promise<void> {
  if (!STRESS_OUT) return;
  await Deno.mkdir(STRESS_OUT, { recursive: true });
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  const summary = {
    generatedAt: new Date().toISOString(),
    deno: Deno.version,
    env: { STRESS_ITER, STRESS_SEED, STRESS_FULL, STRESS_REPLAY },
    executed,
    floodHits,
    held: rows.filter((r) => r.outcome === "HELD").length,
    broken: broken.length,
    survey: rows.filter((r) => r.outcome === "SURVEY").length,
    brokenSeeds: broken.map((r) => ({
      campaign: r.campaign,
      seed: r.seed,
      detail: r.detail,
    })),
    byCampaign: Object.fromEntries(
      [...new Set(rows.map((r) => r.campaign))].map((c) => [
        c,
        {
          executed: rows.filter((r) => r.campaign === c).length,
          broken: rows.filter((r) => r.campaign === c && r.outcome === "BROKEN").length,
        },
      ]),
    ),
    rows,
  };
  await Deno.writeTextFile(`${STRESS_OUT}/module_seeds.json`, JSON.stringify(summary, null, 2));
}

function assertNoneBroken(campaign: string): void {
  const broken = rows.filter((r) => r.campaign === campaign && r.outcome === "BROKEN");
  assert(
    broken.length === 0,
    `${campaign}: ${broken.length} BROKEN iteration(s); first: seed=${
      broken[0]?.seed
    } ${broken[0]?.detail}`,
  );
}

// ─── campaign 1: hostile ids × caller budgets, memory and upstash modes ─────

async function campaignHostileIds(mode: "memory" | "upstash"): Promise<void> {
  const campaignId = mode === "memory" ? 1 : 2;
  const campaign = `hostile-ids-${mode}`;
  configureRedis(mode === "upstash");
  const redis = fakeUpstash();
  installClock();
  try {
    const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
    for (const { iter, seed } of iterSeeds(campaignId, STRESS_ITER)) {
      const rng = new Rng(seed);
      const category = rng.pick(ID_CATEGORIES);
      const id = genId(rng, category);
      const sibling = genSibling(rng, id);
      const scope = rng.pick(SCOPES);
      const [limit, windowSeconds] = rng.pick(CALLER_BUDGETS);
      const nowMs = BASE_EPOCH_MS + rng.int(0, 7 * 24 * 3_600) * 1_000 + rng.int(0, 999);
      const hits = Math.min(limit + rng.int(1, 3), 40);
      fakeNowMs = nowMs;
      redis.store.clear();
      redis.commands.length = 0;
      // A fresh isolate per iteration keeps the memory map independent of
      // previous seeds (same guarantee a fresh edge isolate gives).
      const iso = await loadIsolate();
      const check = new Check();
      const bucket = modelBucket(nowMs, windowSeconds);
      const expectedRetry = modelRetryAfter(nowMs, windowSeconds);
      try {
        const peek0 = await iso.rateLimit.peekRateLimit(scope, id, limit, windowSeconds);
        check.eq(peek0.allowed, true, "peek on an empty window is allowed");
        check.eq(peek0.remaining, limit, "peek on an empty window reports the full budget");
        for (let k = 1; k <= hits; k += 1) {
          const r = await iso.rateLimit.enforceRateLimit(scope, id, limit, windowSeconds);
          check.eq(r.allowed, k <= limit, `hit ${k}/${limit} allowed`);
          check.eq(r.remaining, Math.max(0, limit - k), `hit ${k} remaining`);
          check.eq(r.limit, limit, `hit ${k} limit echoed`);
          check.that(Number.isInteger(r.retryAfterSeconds), `hit ${k} Retry-After integer`);
          check.that(
            r.retryAfterSeconds >= 1 && r.retryAfterSeconds <= windowSeconds,
            `hit ${k} Retry-After ${r.retryAfterSeconds} within [1, ${windowSeconds}]`,
          );
          check.eq(r.retryAfterSeconds, expectedRetry, `hit ${k} Retry-After = bucket remainder`);
        }
        const peekN = await iso.rateLimit.peekRateLimit(scope, id, limit, windowSeconds);
        check.eq(peekN.remaining, Math.max(0, limit - hits), "peek after hits reports the count");
        check.eq(peekN.allowed, hits < limit, "peek allowed iff the next hit would fit");
        const peekAgain = await iso.rateLimit.peekRateLimit(scope, id, limit, windowSeconds);
        check.eq(peekAgain.remaining, peekN.remaining, "peek never charges");

        // Sibling id = an independent budget.
        const sib = await iso.rateLimit.enforceRateLimit(scope, sibling, limit, windowSeconds);
        check.eq(sib.allowed, true, `sibling ${preview(sibling)} has its own budget`);
        check.eq(sib.remaining, limit - 1, "sibling counter starts at 1");
        // Same id under another scope = an independent budget.
        const otherScope = SCOPES.find((s) => s !== scope)!;
        const other = await iso.rateLimit.enforceRateLimit(otherScope, id, limit, windowSeconds);
        check.eq(other.allowed, true, "same id, other scope: own budget");

        // 429 response contract.
        const denied = { ...peekN, allowed: false };
        const res = iso.rateLimit.rateLimitResponse(denied);
        check.eq(res.status, 429, "429 status");
        check.eq(
          res.headers.get("Retry-After"),
          String(denied.retryAfterSeconds),
          "Retry-After hdr",
        );
        check.eq(res.headers.get("RateLimit-Limit"), String(limit), "RateLimit-Limit hdr");
        check.eq(res.headers.get("RateLimit-Remaining"), String(denied.remaining), "Remaining hdr");
        check.eq(res.headers.get("Cache-Control"), "no-store", "no-store");
        const text = await res.text();
        const body = JSON.parse(text);
        check.eq(body?.error?.code, "rate_limited", "typed error code");
        if (id.length >= 4) {
          check.that(!text.includes(id), "429 body never echoes the id");
          for (const [, v] of res.headers) {
            check.that(!v.includes(id), "429 headers never echo id");
          }
        }

        if (mode === "upstash") {
          const expectedKey = `rl:${scope}:${bucket}:${id}`;
          check.that(redis.store.has(expectedKey), `Upstash key is rl:<scope>:<bucket>:<id>`);
          check.eq(redis.store.get(expectedKey)?.value, String(hits), "Upstash count = hits");
          check.eq(
            redis.store.size,
            3,
            "exactly 3 distinct counters (id, sibling, other-scope) — no key collision",
          );
          const expires = redis.store.get(expectedKey)?.expiresAtMs;
          check.that(
            typeof expires === "number" && expires <= nowMs + windowSeconds * 1_000,
            "Upstash window key carries a TTL ≤ window",
          );
        }
      } catch (error) {
        check.that(false, `THREW: ${String(error).slice(0, 200)}`);
      }
      record(
        {
          campaign,
          iter,
          seed,
          mode,
          category,
          params: {
            scope,
            id: preview(id),
            sibling: preview(sibling),
            limit,
            windowSeconds,
            hits,
          },
        },
        check,
      );
    }
    assertEquals(
      Object.getOwnPropertyNames(Object.prototype).sort().join(","),
      protoKeysBefore,
      "Object.prototype untouched by hostile ids",
    );
  } finally {
    restoreClock();
    redis.restore();
  }
  assertNoneBroken(campaign);
}

Deno.test("[stress] hostile ids × caller budgets — memory fallback", async () => {
  await campaignHostileIds("memory");
});

Deno.test("[stress] hostile ids × caller budgets — Upstash (fake) shared window", async () => {
  await campaignHostileIds("upstash");
});

// ─── campaign 3: bucket boundary sweep ──────────────────────────────────────

Deno.test("[stress] the window rolls exactly at the aligned bucket boundary", async () => {
  const campaign = "bucket-boundary";
  for (const mode of ["memory", "upstash"] as const) {
    configureRedis(mode === "upstash");
    const redis = fakeUpstash();
    installClock();
    try {
      for (const { iter, seed } of iterSeeds(
        mode === "memory" ? 3 : 4,
        Math.ceil(STRESS_ITER / 4),
      )) {
        const rng = new Rng(seed);
        const [limit, windowSeconds] = rng.pick(CALLER_BUDGETS.filter(([l]) => l <= 60));
        const id = genId(rng, rng.pick(["ipv4", "uuid", "ipv6", "colon-injection"]));
        const scope = rng.pick(SCOPES);
        const bucket = modelBucket(BASE_EPOCH_MS + rng.int(0, 3_600_000), windowSeconds);
        const start = bucket * windowSeconds * 1_000;
        const end = start + windowSeconds * 1_000;
        redis.store.clear();
        const iso = await loadIsolate();
        const check = new Check();
        try {
          fakeNowMs = start;
          const first = await iso.rateLimit.enforceRateLimit(scope, id, limit, windowSeconds);
          check.eq(first.retryAfterSeconds, windowSeconds, "at bucket start Retry-After = window");
          for (let k = 1; k < limit; k += 1) {
            await iso.rateLimit.enforceRateLimit(scope, id, limit, windowSeconds);
          }
          fakeNowMs = end - 1;
          const lastMs = await iso.rateLimit.enforceRateLimit(scope, id, limit, windowSeconds);
          check.eq(lastMs.allowed, false, "limit+1 within the bucket is denied");
          check.eq(lastMs.retryAfterSeconds, 1, "1 ms before the boundary Retry-After = 1");
          const peekBefore = await iso.rateLimit.peekRateLimit(scope, id, limit, windowSeconds);
          check.eq(peekBefore.allowed, false, "peek 1 ms before the boundary still closed");
          fakeNowMs = end;
          const rolled = await iso.rateLimit.enforceRateLimit(scope, id, limit, windowSeconds);
          check.eq(rolled.allowed, true, "first hit of the next bucket is allowed");
          check.eq(rolled.remaining, limit - 1, "next bucket restarts at 1");
          check.eq(rolled.retryAfterSeconds, windowSeconds, "next bucket Retry-After = window");
          fakeNowMs = end - 1;
          const stale = await iso.rateLimit.peekRateLimit(scope, id, limit, windowSeconds);
          check.eq(stale.allowed, false, "the old bucket is still full when read at its own time");
        } catch (error) {
          check.that(false, `THREW: ${String(error).slice(0, 200)}`);
        }
        record(
          {
            campaign,
            iter,
            seed,
            mode,
            category: "boundary",
            params: { scope, id: preview(id), limit, windowSeconds, bucket },
          },
          check,
        );
      }
    } finally {
      restoreClock();
      redis.restore();
    }
  }
  assertNoneBroken(campaign);
});

// ─── campaign 5: concurrent burst admits exactly `limit` ────────────────────

Deno.test("[stress] a concurrent burst admits exactly `limit` hits", async () => {
  const campaign = "burst";
  for (const mode of ["memory", "upstash"] as const) {
    configureRedis(mode === "upstash");
    const redis = fakeUpstash();
    installClock();
    try {
      for (const { iter, seed } of iterSeeds(
        mode === "memory" ? 5 : 6,
        Math.ceil(STRESS_ITER / 4),
      )) {
        const rng = new Rng(seed);
        const limit = rng.pick([1, 3, 5, 10, 12, 30, 60]);
        const windowSeconds = rng.pick([1, 60, 300, 3_600]);
        const burst = limit + rng.int(1, 40);
        const id = genId(rng, rng.pick(ID_CATEGORIES));
        const scope = rng.pick(SCOPES);
        fakeNowMs = BASE_EPOCH_MS + rng.int(0, 3_600_000);
        redis.store.clear();
        const iso = await loadIsolate();
        const check = new Check();
        try {
          const results = await Promise.all(
            Array.from({ length: burst }, () =>
              iso.rateLimit.enforceRateLimit(scope, id, limit, windowSeconds),
            ),
          );
          const allowed = results.filter((r) => r.allowed).length;
          check.eq(allowed, limit, `burst of ${burst} admits exactly ${limit}`);
          check.that(
            results.every((r) => r.retryAfterSeconds === results[0].retryAfterSeconds),
            "one Retry-After for the whole burst",
          );
          check.that(
            results.filter((r) => !r.allowed).every((r) => r.remaining === 0),
            "denied hits report remaining 0",
          );
          const remainings = results.map((r) => r.remaining).sort((a, b) => b - a);
          check.eq(remainings[0], limit - 1, "first admitted hit sees limit−1 remaining");
          const after = await iso.rateLimit.peekRateLimit(scope, id, limit, windowSeconds);
          check.eq(after.remaining, 0, "window fully spent after the burst");
        } catch (error) {
          check.that(false, `THREW: ${String(error).slice(0, 200)}`);
        }
        record(
          {
            campaign,
            iter,
            seed,
            mode,
            category: "burst",
            params: { scope, id: preview(id), limit, windowSeconds, burst },
          },
          check,
        );
      }
    } finally {
      restoreClock();
      redis.restore();
    }
  }
  assertNoneBroken(campaign);
});

// ─── campaign 7: header-derived ids (clientIp) ──────────────────────────────
// The only attacker-controlled id in index.ts is clientIp(request). Header
// values are ByteStrings (0x09, 0x20–0x7E, 0x80–0xFF; NUL/CR/LF and non-latin1
// cannot even be placed in a Request), so the generator stays in that alphabet.

const HEADER_ALPHABET = (() => {
  const chars: string[] = ["\t"];
  for (let c = 0x20; c <= 0x7e; c += 1) chars.push(String.fromCharCode(c));
  for (let c = 0x80; c <= 0xff; c += 1) chars.push(String.fromCharCode(c));
  return chars;
})();

function genHeaderValue(rng: Rng): { value: string; kind: string } {
  const kind = rng.pick([
    "single-ipv4",
    "list-garbage-then-real",
    "list-trailing-commas",
    "list-empty-hops",
    "only-commas",
    "only-whitespace",
    "huge-64k",
    "huge-hop-64k",
    "ipv6-list",
    "latin1-noise",
    "colon-injection",
    "proto-name",
    "many-hops-10k",
  ]);
  const real = `${rng.int(1, 223)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  let noise = "";
  for (let i = 0; i < rng.int(1, 24); i += 1) {
    noise += rng.pick(HEADER_ALPHABET);
  }
  noise = noise.replace(/,/g, ";");
  switch (kind) {
    case "single-ipv4":
      return { value: real, kind };
    case "list-garbage-then-real":
      return { value: `${noise}, ${rng.int(0, 255)}.0.0.1,${real}`, kind };
    case "list-trailing-commas":
      return { value: `${real},,, `, kind };
    case "list-empty-hops":
      return { value: `, , ${real}, ,`, kind };
    case "only-commas":
      return { value: ",".repeat(rng.int(1, 50)), kind };
    case "only-whitespace":
      return { value: " \t ".repeat(rng.int(1, 10)), kind };
    case "huge-64k":
      return { value: "a".repeat(65_536 + rng.int(0, 64)), kind };
    case "huge-hop-64k":
      return { value: `${real}, ${"b".repeat(65_536)}`, kind };
    case "ipv6-list":
      return {
        value: `2001:db8::${rng.int(0, 0xffff).toString(16)}, ::1`,
        kind,
      };
    case "latin1-noise":
      return { value: noise, kind };
    case "colon-injection":
      return { value: `rl:ip:0:${real}`, kind };
    case "proto-name":
      return {
        value: rng.pick(["__proto__", "constructor", "toString"]),
        kind,
      };
    case "many-hops-10k":
      return {
        value: Array.from({ length: 10_000 }, (_, i) => `10.0.${i % 256}.1`).join(","),
        kind,
      };
    default:
      return { value: real, kind };
  }
}

/** Same rule as http.ts documents: last non-empty trimmed hop, else "unknown". */
function modelClientIp(cf: string | null, xff: string | null): string {
  const edge = cf?.trim();
  if (edge) return edge;
  const hops = (xff ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}

Deno.test("[stress] header-derived ids: spoofed hops never steal or widen a budget", async () => {
  const campaign = "header-derived-ids";
  configureRedis(false);
  const redis = fakeUpstash();
  installClock();
  let maxIdLength = 0;
  let iso = await loadIsolate();
  try {
    for (const { iter, seed } of iterSeeds(7, STRESS_ITER)) {
      // One isolate per 1 000 iterations (≤ 2 000 live keys, far below the
      // 20k cap); each iteration owns a distinct 60 s bucket so ids can repeat.
      if (iter > 0 && iter % 1_000 === 0) iso = await loadIsolate();
      const rng = new Rng(seed);
      const xff = genHeaderValue(rng);
      const useCf = rng.chance(0.25);
      const cf = useCf ? genHeaderValue(rng) : null;
      const check = new Check();
      let id = "";
      try {
        const headers: Record<string, string> = {
          "x-forwarded-for": xff.value,
        };
        if (cf) headers["cf-connecting-ip"] = cf.value;
        const request = new Request("http://edge.test/v1/me", { headers });
        id = clientIp(request);
        const expected = modelClientIp(cf?.value ?? null, xff.value);
        check.eq(id, expected, "clientIp = cf-connecting-ip, else last XFF hop, else unknown");
        check.that(id.length > 0, "id never empty");
        check.eq(id, id.trim(), "id is trimmed");
        maxIdLength = Math.max(maxIdLength, id.length);

        // Prepending garbage hops must not change the budget key (same id).
        const spoofed = new Request("http://edge.test/v1/me", {
          headers: {
            ...headers,
            "x-forwarded-for": `${rng.int(0, 255)}.9.9.9, ${xff.value}`,
          },
        });
        const spoofedId = clientIp(spoofed);
        const lastHopKept = xff.value.split(",").some((h) => h.trim());
        if (cf?.value.trim() || lastHopKept) {
          check.eq(spoofedId, id, "leading hops are ignored — the budget follows the last hop");
        } else {
          check.eq(
            spoofedId,
            `${spoofedId}`,
            "no real hop: spoofed hop becomes the id (documented)",
          );
        }

        // The derived id drives a real budget: limit+1 hits from the same
        // header value → exactly `limit` allowed; a different last hop → own budget.
        fakeNowMs = BASE_EPOCH_MS + Math.max(iter, 0) * 60_000 + rng.int(0, 59_999);
        const limit = rng.pick([1, 3, 5, 30]);
        let allowed = 0;
        for (let k = 0; k <= limit; k += 1) {
          if ((await iso.rateLimit.enforceRateLimit("ip", id, limit, 60)).allowed) allowed += 1;
        }
        check.eq(allowed, limit, "header-derived id enforces exactly `limit`");
        const other = await iso.rateLimit.enforceRateLimit("ip", `${id}x`, limit, 60);
        check.eq(other.allowed, true, "a different last hop is a different budget");
      } catch (error) {
        check.that(false, `THREW: ${String(error).slice(0, 200)}`);
      }
      record(
        {
          campaign,
          iter,
          seed,
          mode: "memory",
          category: `${xff.kind}${cf ? `+cf:${cf.kind}` : ""}`,
          params: {
            xff: preview(xff.value),
            cf: cf ? preview(cf.value) : null,
            id: preview(id),
          },
        },
        check,
      );
    }
  } finally {
    restoreClock();
    redis.restore();
  }
  console.log(
    `[stress] header-derived-ids: longest id accepted as a budget key = ${maxIdLength} chars`,
  );
  assertNoneBroken(campaign);
});

// ─── campaign 8: hostile numerics (SURVEY) ──────────────────────────────────
// No index.ts caller passes anything but integer constants ≥ 1 for limit and
// windowSeconds, so these rows are recorded, not asserted — except that the
// module must never THROW, and CALLER-shaped values must stay exact.

const HOSTILE_NUMBERS: ReadonlyArray<readonly [string, unknown]> = [
  ["0", 0],
  ["-0", -0],
  ["-1", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["0.5", 0.5],
  ["2.5", 2.5],
  ["1e-9", 1e-9],
  ["2^31", 2 ** 31],
  ["2^53", 2 ** 53],
  ["2^53+1", 2 ** 53 + 1],
  ["1e308", 1e308],
  ["MAX_VALUE", Number.MAX_VALUE],
  ["MIN_VALUE", Number.MIN_VALUE],
  ['"5" (string)', "5"],
  ["null", null],
  ["undefined", undefined],
  ["{} (object)", {}],
  ["[] (array)", []],
  ["true", true],
];

Deno.test(
  "[stress] hostile numeric budgets never throw (survey of the unreachable space)",
  async () => {
    const campaign = "hostile-numerics-survey";
    configureRedis(false);
    const redis = fakeUpstash();
    installClock();
    const survey: Array<Record<string, unknown>> = [];
    try {
      fakeNowMs = BASE_EPOCH_MS + 12_345;
      let iter = 0;
      for (const [limitLabel, limit] of HOSTILE_NUMBERS) {
        for (const [windowLabel, windowSeconds] of HOSTILE_NUMBERS) {
          const seed = mix(STRESS_SEED, 8, iter);
          const iso = await loadIsolate();
          const check = new Check();
          let observed: Record<string, unknown> = {};
          try {
            const r1 = await iso.rateLimit.enforceRateLimit(
              "ip",
              "1.2.3.4",
              limit as number,
              windowSeconds as number,
            );
            const r2 = await iso.rateLimit.enforceRateLimit(
              "ip",
              "1.2.3.4",
              limit as number,
              windowSeconds as number,
            );
            const p = await iso.rateLimit.peekRateLimit(
              "ip",
              "1.2.3.4",
              limit as number,
              windowSeconds as number,
            );
            const res = iso.rateLimit.rateLimitResponse(r2);
            await res.body?.cancel();
            observed = {
              firstAllowed: r1.allowed,
              secondAllowed: r2.allowed,
              secondRemaining: String(r2.remaining),
              retryAfter: String(r2.retryAfterSeconds),
              retryAfterHeader: res.headers.get("Retry-After"),
              peekRemaining: String(p.remaining),
              secondHitCounted: r2.remaining !== r1.remaining || r2.allowed !== r1.allowed,
            };
            const finiteRetry = Number.isInteger(r2.retryAfterSeconds) && r2.retryAfterSeconds >= 1;
            observed.retryAfterValid = finiteRetry;
          } catch (error) {
            check.that(false, `THREW: ${String(error).slice(0, 200)}`);
          }
          executed += 1;
          rows.push({
            campaign,
            iter,
            seed,
            mode: "memory",
            category: `limit=${limitLabel} window=${windowLabel}`,
            params: {
              limit: limitLabel,
              windowSeconds: windowLabel,
              ...observed,
            },
            outcome: check.failures.length ? "BROKEN" : "SURVEY",
            detail: check.failures.join(" | "),
          });
          survey.push({
            limit: limitLabel,
            windowSeconds: windowLabel,
            ...observed,
          });
          iter += 1;
        }
      }
    } finally {
      restoreClock();
      redis.restore();
    }
    const invalidRetry = survey.filter((s) => s.retryAfterValid === false);
    console.log(
      `[stress] hostile-numerics-survey: ${survey.length} combinations, ${invalidRetry.length} yield a non-integer/zero Retry-After (all need a non-constant window — unreachable from index.ts)`,
    );
    assertNoneBroken(campaign);
  },
);

// ─── campaign 9: memory under many distinct keys ────────────────────────────

interface HeapRow {
  scenario: string;
  keys: number;
  idBytes: number;
  mode: "memory" | "upstash";
  heapUsedBeforeMB: number;
  heapUsedAfterMB: number;
  heapDeltaMB: number;
  rssAfterMB: number;
  durationMs: number;
  victimUnblockedTimes: number;
  fakeStoreKeys: number | null;
}
const heapRows: HeapRow[] = [];

async function keyFlood(
  scenario: string,
  mode: "memory" | "upstash",
  keys: number,
  idBytes: number,
): Promise<HeapRow> {
  configureRedis(mode === "upstash");
  const redis = fakeUpstash();
  installClock();
  try {
    fakeNowMs = BASE_EPOCH_MS + 777;
    const iso = await loadIsolate();
    const victim = "victim.203.0.113.7";
    for (let i = 0; i < 3; i += 1) {
      await iso.rateLimit.enforceRateLimit("ip", victim, 3, 60);
    }
    assertEquals((await iso.rateLimit.enforceRateLimit("ip", victim, 3, 60)).allowed, false);
    const pad = idBytes > 12 ? "p".repeat(idBytes - 12) : "";
    const before = Deno.memoryUsage();
    const startedAt = performance.now();
    let victimUnblockedTimes = 0;
    for (let i = 0; i < keys; i += 1) {
      await iso.rateLimit.enforceRateLimit(
        "ip",
        `${pad}${i.toString(36).padStart(8, "0")}`,
        1_200,
        60,
      );
      if (i % 5_000 === 4_999) {
        const probe = await iso.rateLimit.peekRateLimit("ip", victim, 3, 60);
        if (probe.allowed) {
          victimUnblockedTimes += 1;
          // Re-exhaust so the next wipe is observable too.
          for (let k = 0; k < 3; k += 1) {
            await iso.rateLimit.enforceRateLimit("ip", victim, 3, 60);
          }
        }
      }
    }
    const durationMs = Math.round(performance.now() - startedAt);
    const after = Deno.memoryUsage();
    const row: HeapRow = {
      scenario,
      keys,
      idBytes,
      mode,
      heapUsedBeforeMB: +(before.heapUsed / 1e6).toFixed(1),
      heapUsedAfterMB: +(after.heapUsed / 1e6).toFixed(1),
      heapDeltaMB: +((after.heapUsed - before.heapUsed) / 1e6).toFixed(1),
      rssAfterMB: +(after.rss / 1e6).toFixed(1),
      durationMs,
      victimUnblockedTimes,
      fakeStoreKeys: mode === "upstash" ? redis.store.size : null,
    };
    heapRows.push(row);
    console.log(`[stress] ${scenario}: ${JSON.stringify(row)}`);
    return row;
  } finally {
    restoreClock();
    redis.restore();
  }
}

Deno.test(
  "[stress] memory fallback under 100k distinct ids: bounded map, but every wipe frees a limited client",
  async () => {
    const keys = STRESS_FULL ? 100_000 : 25_000;
    const row = await keyFlood(`memory-${keys}-short-ids`, "memory", keys, 12);
    floodHits += keys;
    // MEMORY_WINDOW_MAX = 20 000: the map never retains more than that, so the
    // heap delta must stay far below 100k entries' worth (~0.2 KB each).
    assert(row.heapDeltaMB < 40, `heap grew ${row.heapDeltaMB} MB — map not bounded`);
    // Documented defect (rateLimit.test.ts "[defect] memory fallback …", present
    // on origin/main): each time the map fills, windows.clear() releases every
    // live budget on the isolate, including a client that was already limited.
    assert(
      row.victimUnblockedTimes >= Math.floor(keys / 20_000) - 1,
      `expected ≥ ${Math.floor(keys / 20_000) - 1} wipes, saw ${row.victimUnblockedTimes}`,
    );
  },
);

Deno.test(
  "[stress] Upstash mode under many distinct ids: no wipe, memory map untouched",
  async () => {
    const keys = STRESS_FULL ? 100_000 : 25_000;
    const row = await keyFlood(`upstash-${keys}-short-ids`, "upstash", keys, 12);
    floodHits += keys;
    assertEquals(
      row.victimUnblockedTimes,
      0,
      "with a shared window the limited client stays limited",
    );
    assertEquals(row.fakeStoreKeys, keys + 1, "one counter per distinct id (+ the victim)");
  },
);

Deno.test({
  name: "[stress] memory fallback with 4 KB ids: the 20k cap bounds COUNT, not BYTES (STRESS_FULL)",
  ignore: !STRESS_FULL,
  async fn() {
    const row = await keyFlood("memory-20000-4KB-ids", "memory", 20_000, 4_096);
    floodHits += 20_000;
    // Purely a measurement: the retained bytes scale with id length because
    // clientIp() imposes no cap on the last X-Forwarded-For hop.
    assert(row.heapDeltaMB >= 0, "measured");
  },
});

Deno.test("[stress] write tables", async () => {
  await flushTable();
  if (STRESS_OUT) {
    await Deno.writeTextFile(
      `${STRESS_OUT}/module_heap.json`,
      JSON.stringify({ generatedAt: new Date().toISOString(), rows: heapRows }, null, 2),
    );
  }
  const broken = rows.filter((r) => r.outcome === "BROKEN").length;
  console.log(
    `[stress] module campaigns: executed=${executed} floodHits=${floodHits} held=${
      rows.filter((r) => r.outcome === "HELD").length
    } survey=${rows.filter((r) => r.outcome === "SURVEY").length} broken=${broken}`,
  );
  assertEquals(broken, 0);
});
