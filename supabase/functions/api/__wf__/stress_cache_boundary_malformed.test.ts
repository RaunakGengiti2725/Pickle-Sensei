// STRESS — lens `boundary-malformed`, unit `edge-cache` (cache.ts + rateLimit.ts).
//
// A seeded campaign drives every public cache/rate-limit entry point with
// malformed and boundary inputs on BOTH sides of the module:
//
//   inputs   — keys / values / ids: empty, NUL bytes, control chars, NFC/NFD
//              pairs, grapheme clusters, lone surrogates, bidi overrides, path
//              traversal, prototype-pollution names, 64 KiB+ strings (bytes vs
//              code points vs multibyte), 1 MiB strings, "future" versions;
//              TTLs: 0, -0, negatives, NaN, ±Infinity, sub-second, 2^31, 2^53,
//              1e308, MAX_VALUE; clock skew between write and read.
//   L2 side  — a hostile Upstash: HTTP 4xx/5xx, non-JSON / truncated / empty
//              bodies, object / scalar / future-schema bodies, wrong-typed
//              slots, `__proto__` / `constructor` keys, short & long replies,
//              per-command errors, weird TTL replies, 64 KiB+ / non-string
//              GET values, hangs (separate test — each costs the 1.2 s timeout).
//
// Invariants (asserted every iteration; a violation is BROKEN unless it is a
// pinned [defect] below, which is counted as DEFECT:<id> and pinned by its own
// test so the campaign stays green until the fix lands — same convention as
// cache.test.ts):
//   1. no cache/rate-limit call ever throws;
//   2. every result has its declared shape (string|null, boolean|null, finite
//      numbers, {value, revoked} with revoked ⇒ value === null, …);
//   3. Object.prototype / Array.prototype are never polluted by a reply or key;
//   4. a non-positive or non-finite TTL never writes (no SET carrying the value
//      reaches L2, the value is not served afterwards);
//   5. every command sent to Upstash is JSON-serialisable as strings / finite
//      numbers (never `null` — a NaN/Infinity EX serialises to null);
//   6. under a faithful L2: a live revocation marker is always honoured, a
//      value written with TTL t is served before t and gone at/after t.
//
// Replay ONE iteration:   STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json stress_cache_boundary_malformed.test.ts
// Full campaign (slow):   STRESS_ITER=3000 STRESS_OUT_DIR=../../../../artifacts/stress/edge-cache deno test -A --no-check --config deno.json stress_cache_boundary_malformed.test.ts
// Default (suite):        STRESS_ITER unset → 300 iterations, no table written.

import {
  assert,
  assertEquals,
  configureRedis,
  FAKE_REDIS_URL,
  loadIsolate,
} from "./harness.ts";
import {
  abbreviate,
  assertPrototypesClean,
  buildTable,
  campaignConfig,
  codePoints,
  describeNumber,
  genNumber,
  genReplyMode,
  genWeightedString,
  graphemes,
  heapUsedMb,
  iterationSeeds,
  mutateReply,
  type OutcomeRow,
  type PipelineSlot,
  type ReplyMode,
  Rng,
  utf8Bytes,
  writeTable,
} from "./stress_support.ts";

const TEST_FILE = "stress_cache_boundary_malformed.test.ts";
const DEFAULT_ITERATIONS = 300;

// ─── Hostile Upstash ─────────────────────────────────────────────────────────

type Cmd = Array<string | number>;
interface StoreEntry {
  value: string;
  expiresAtMs: number | null;
}
interface RecordedRequest {
  bodyText: string;
  commands: unknown;
  replyStatus: number;
  replyText: string;
}

interface HostileUpstash {
  store: Map<string, StoreEntry>;
  /** Requests since the last reset (one case). */
  requests: RecordedRequest[];
  /** Pipelines served over the fake's lifetime. */
  calls: number;
  mode: ReplyMode;
  rng: Rng;
  hang: boolean;
  restore(): void;
}

function live(store: Map<string, StoreEntry>, key: string): StoreEntry | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

function runFaithful(
  store: Map<string, StoreEntry>,
  cmd: unknown,
): PipelineSlot {
  if (!Array.isArray(cmd)) return { error: "ERR malformed command" };
  const [name, ...args] = cmd.map(String);
  switch ((name ?? "").toUpperCase()) {
    case "GET":
      return { result: live(store, args[0])?.value ?? null };
    case "TTL": {
      const entry = live(store, args[0]);
      if (!entry) return { result: -2 };
      if (entry.expiresAtMs === null) return { result: -1 };
      return {
        result: Math.max(
          1,
          Math.ceil((entry.expiresAtMs - Date.now()) / 1_000),
        ),
      };
    }
    case "SET": {
      const [key, value, ex, seconds] = args;
      if (ex && ex.toUpperCase() !== "EX") return { error: "ERR syntax error" };
      if (ex) {
        // Real Redis: EX must be a positive integer.
        if (!/^\d+$/.test(seconds) || Number(seconds) <= 0) {
          return { error: "ERR value is not an integer or out of range" };
        }
        if (Number(seconds) > REDIS_MAX_EX_SECONDS) {
          return { error: "ERR invalid expire time in 'set' command" };
        }
      }
      store.set(key, {
        value,
        expiresAtMs: ex ? Date.now() + Number(seconds) * 1_000 : null,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let n = 0;
      for (const key of args) if (store.delete(key)) n += 1;
      return { result: n };
    }
    case "INCR": {
      const entry = live(store, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      store.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? null,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const [key, seconds, flag] = args;
      const entry = live(store, key);
      if (!entry) return { result: 0 };
      if (!/^-?\d+$/.test(seconds)) {
        return { error: "ERR value is not an integer or out of range" };
      }
      if (flag && flag.toUpperCase() === "NX" && entry.expiresAtMs !== null) {
        return { result: 0 };
      }
      entry.expiresAtMs = Date.now() + Number(seconds) * 1_000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${name}'` };
  }
}

/** Redis keeps expiries as int64 unix-ms: `EX` above ~(LLONG_MAX - now)/1000
 * seconds is refused with "invalid expire time". */
const REDIS_MAX_EX_SECONDS = 9_223_372_035_000_000;

function hostileUpstash(rng: Rng): HostileUpstash {
  const original = globalThis.fetch;
  const fake: HostileUpstash = {
    store: new Map(),
    requests: [],
    calls: 0,
    mode: "faithful",
    rng,
    hang: false,
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      if (!url.startsWith(FAKE_REDIS_URL)) return original(input, init);
      if (fake.hang) {
        await new Promise<void>((_, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      fake.calls += 1;
      const bodyText = String(init?.body ?? "");
      let commands: unknown = null;
      try {
        commands = JSON.parse(bodyText);
      } catch {
        commands = null;
      }
      const faithful = Array.isArray(commands)
        ? commands.map((cmd) => runFaithful(fake.store, cmd))
        : [];
      const reply = mutateReply(fake.mode, fake.rng, commands, faithful);
      fake.requests.push({
        bodyText,
        commands,
        replyStatus: reply.status,
        replyText: reply.text,
      });
      return new Response(reply.text, {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  return fake;
}

// ─── Case generation ─────────────────────────────────────────────────────────

const OPS = [
  "get",
  "getUnlessRevoked",
  "isRevoked",
  "set",
  "setFenced",
  "del",
  "windowIncr",
  "windowGet",
  "enforceRateLimit",
  "peekRateLimit",
  "setThenSkewGet",
] as const;
type Op = (typeof OPS)[number];

const SKEWS_MS = [
  0,
  1,
  -1,
  999,
  1_000,
  1_001,
  -1_000,
  59_000,
  60_000,
  61_000,
  -60_000,
  599_000,
  600_000,
  601_000,
  660_000,
  900_000,
  -900_000,
  86_400_000,
  -86_400_000,
  365 * 86_400_000,
  2 ** 40,
  -(2 ** 40),
  0.5,
];

interface Case {
  seed: number;
  op: Op;
  key: ReturnType<typeof genWeightedString>;
  revokedKey: ReturnType<typeof genWeightedString>;
  value: string;
  valueCategory: string;
  ttl: number;
  delKeys: string[];
  mode: ReplyMode;
  skewMs: number;
  delBetweenFence: boolean;
  markerPreset: boolean;
}

function genValue(rng: Rng, seed: number): { value: string; category: string } {
  const r = rng.float();
  const tag = `#${seed.toString(16)}`;
  if (r < 0.3) {
    return {
      value: JSON.stringify({
        userId: "u",
        provider: "google",
        expiresAtMs: Date.now() + 500_000,
        tag,
      }),
      category: "session-json",
    };
  }
  if (r < 0.4) {
    return {
      value: `{"userId":"u","provider":"goo${tag}`,
      category: "truncated-json",
    };
  }
  if (r < 0.5) {
    return {
      value: `{"__proto__":{"polluted":"via-value"},"tag":"${tag}"}`,
      category: "proto-json",
    };
  }
  if (r < 0.55) {
    return { value: `${"[".repeat(20_000)}${tag}`, category: "deep-nesting" };
  }
  if (r < 0.6) return { value: `null${tag}`, category: "null-literal" };
  const s = genWeightedString(rng);
  return { value: `${s.value}${tag}`, category: s.category };
}

function genCase(seed: number): Case {
  const rng = new Rng(seed);
  const op = rng.pick(OPS);
  const key = genWeightedString(rng);
  const revokedKey = rng.bool(0.5)
    ? { category: key.category, value: `auth:revoked:${key.value}` }
    : genWeightedString(rng);
  const value = genValue(rng, seed);
  const ttl = op === "setThenSkewGet"
    ? rng.pick([1, 2, 60, 600])
    : genNumber(rng);
  const delKeys: string[] = [];
  const delCount = rng.float() < 0.05
    ? rng.pick([0, 200, 1_000])
    : rng.int(0, 5);
  for (let i = 0; i < delCount; i += 1) {
    delKeys.push(genWeightedString(rng).value);
  }
  const mode = op === "setThenSkewGet" ? "faithful" : genReplyMode(rng);
  const skewMs = rng.bool(0.3) || op === "setThenSkewGet"
    ? rng.pick(SKEWS_MS)
    : 0;
  return {
    seed,
    op,
    key,
    revokedKey,
    value: value.value,
    valueCategory: value.category,
    ttl,
    delKeys,
    mode,
    skewMs,
    delBetweenFence: rng.bool(0.3),
    markerPreset: rng.bool(0.3),
  };
}

// ─── Invariants ──────────────────────────────────────────────────────────────

class Violation extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** Violations that reproduce a KNOWN gap pinned by a [defect] test below. */
function knownDefect(code: string, c: Case): string | null {
  const unboundedTtl = Number.isNaN(c.ttl) ||
    c.ttl === Number.POSITIVE_INFINITY || c.ttl > REDIS_MAX_EX_SECONDS;
  if (
    (c.op === "set" || c.op === "setFenced") &&
    unboundedTtl &&
    (code === "ttl-invalid-wrote" || code === "command-not-serialisable" ||
      code === "set-ex-not-integer")
  ) {
    return "ttl-unbounded-l1-only";
  }
  return null;
}

const validTtl = (ttl: number): boolean => Number.isFinite(ttl) && ttl > 0;

function assertCommandsSerialisable(requests: RecordedRequest[]): void {
  for (const request of requests) {
    const commands = request.commands;
    if (!Array.isArray(commands)) {
      throw new Violation(
        "command-not-serialisable",
        "pipeline body is not a JSON array",
      );
    }
    for (const cmd of commands) {
      if (!Array.isArray(cmd) || cmd.length === 0) {
        throw new Violation("command-not-serialisable", "empty command");
      }
      for (const part of cmd) {
        if (typeof part === "string") continue;
        if (typeof part === "number" && Number.isFinite(part)) continue;
        throw new Violation(
          "command-not-serialisable",
          `command ${String(cmd[0])} carries ${
            JSON.stringify(part)
          } (${typeof part})`,
        );
      }
      if (String(cmd[0]).toUpperCase() === "SET") {
        const ex = cmd[4];
        if (
          !(typeof ex === "number" && Number.isInteger(ex) && ex > 0 &&
            ex <= REDIS_MAX_EX_SECONDS)
        ) {
          throw new Violation(
            "set-ex-not-integer",
            `SET … EX ${JSON.stringify(ex)} is not an expiry Redis accepts`,
          );
        }
      }
    }
  }
}

function setsCarrying(requests: RecordedRequest[], value: string): number {
  let n = 0;
  for (const request of requests) {
    if (!Array.isArray(request.commands)) continue;
    for (const cmd of request.commands) {
      if (
        Array.isArray(cmd) && String(cmd[0]).toUpperCase() === "SET" &&
        cmd[2] === value
      ) n += 1;
    }
  }
  return n;
}

type Isolate = Awaited<ReturnType<typeof loadIsolate>>;

async function withSkew<T>(skewMs: number, fn: () => Promise<T>): Promise<T> {
  if (skewMs === 0) return fn();
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + skewMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

async function runCase(
  c: Case,
  iso: Isolate,
  fake: HostileUpstash,
): Promise<Record<string, unknown>> {
  const { cache, rateLimit } = iso;
  fake.mode = c.mode;
  fake.rng = new Rng(c.seed ^ 0xa5a5a5a5);
  fake.requests = [];
  const key = c.key.value;
  const revokedKey = c.revokedKey.value;
  const detail: Record<string, unknown> = {};

  if (c.markerPreset) {
    fake.store.set(revokedKey, {
      value: "1",
      expiresAtMs: Date.now() + 600_000,
    });
  }

  await withSkew(c.skewMs, async () => {
    switch (c.op) {
      case "get": {
        const out = await cache.cacheGet(key);
        detail.result = out === null ? null : `string(len=${out.length})`;
        if (!(out === null || typeof out === "string")) {
          throw new Violation("shape", `cacheGet → ${typeof out}`);
        }
        break;
      }
      case "getUnlessRevoked": {
        const out = await cache.cacheGetUnlessRevoked(key, revokedKey);
        detail.result = {
          value: out.value === null ? null : `string(len=${out.value.length})`,
          revoked: out.revoked,
        };
        if (typeof out !== "object" || out === null) {
          throw new Violation("shape", "not an object");
        }
        if (!(out.value === null || typeof out.value === "string")) {
          throw new Violation("shape", "value type");
        }
        if (typeof out.revoked !== "boolean") {
          throw new Violation("shape", "revoked type");
        }
        if (out.revoked && out.value !== null) {
          throw new Violation(
            "revoked-with-value",
            "revoked hit carried a value",
          );
        }
        if (
          c.mode === "faithful" && live(fake.store, revokedKey) && !out.revoked
        ) {
          throw new Violation(
            "marker-ignored",
            "live L2 revocation marker not honoured",
          );
        }
        break;
      }
      case "isRevoked": {
        const out = await cache.cacheIsRevoked(revokedKey);
        detail.result = out;
        if (!(out === null || typeof out === "boolean")) {
          throw new Violation("shape", `cacheIsRevoked → ${typeof out}`);
        }
        if (
          c.mode === "faithful" && live(fake.store, revokedKey) && out !== true
        ) {
          throw new Violation(
            "marker-ignored",
            "live L2 revocation marker not reported",
          );
        }
        break;
      }
      case "set": {
        const out = await cache.cacheSet(key, c.value, c.ttl);
        detail.result = out;
        if (typeof out !== "boolean") {
          throw new Violation("shape", `cacheSet → ${typeof out}`);
        }
        assertCommandsSerialisable(fake.requests);
        if (!validTtl(c.ttl)) {
          if (out) {
            throw new Violation(
              "ttl-invalid-wrote",
              "cacheSet resolved true for an invalid TTL",
            );
          }
          if (setsCarrying(fake.requests, c.value) > 0) {
            throw new Violation("ttl-invalid-wrote", "SET sent to L2");
          }
          fake.mode = "faithful";
          const after = await cache.cacheGet(key);
          if (after === c.value) {
            throw new Violation(
              "ttl-invalid-wrote",
              "value served after invalid-TTL set",
            );
          }
        } else if (c.ttl >= 1) {
          fake.mode = "faithful";
          const after = await cache.cacheGet(key);
          if (after !== c.value) {
            throw new Violation(
              "write-lost",
              "valid write not served back from L1",
            );
          }
          if (c.mode === "faithful" && !out) {
            throw new Violation(
              "l2-write-refused",
              "faithful L2 refused a valid SET",
            );
          }
        }
        break;
      }
      case "setFenced": {
        const fence = await cache.cacheFence(key);
        detail.fence = { local: fence.local, shared: fence.shared };
        if (
          typeof fence.local !== "string" ||
          !(fence.shared === null || typeof fence.shared === "string")
        ) {
          throw new Violation("shape", "fence shape");
        }
        if (c.delBetweenFence) await cache.cacheDel(key);
        const out = await cache.cacheSetFenced(fence, c.value, c.ttl);
        detail.result = out;
        if (typeof out !== "boolean") {
          throw new Violation("shape", `cacheSetFenced → ${typeof out}`);
        }
        assertCommandsSerialisable(fake.requests);
        if (!validTtl(c.ttl)) {
          if (out) {
            throw new Violation(
              "ttl-invalid-wrote",
              "cacheSetFenced resolved true for an invalid TTL",
            );
          }
          if (setsCarrying(fake.requests, c.value) > 0) {
            throw new Violation("ttl-invalid-wrote", "SET sent to L2");
          }
          fake.mode = "faithful";
          if ((await cache.cacheGet(key)) === c.value) {
            throw new Violation("ttl-invalid-wrote", "value served");
          }
        } else if (c.delBetweenFence) {
          if (out) {
            throw new Violation(
              "fence-ignored",
              "write landed although the key was invalidated in between",
            );
          }
          fake.mode = "faithful";
          if ((await cache.cacheGet(key)) === c.value) {
            throw new Violation("fence-ignored", "stale value served");
          }
        } else if (c.mode === "faithful" && c.ttl >= 1) {
          if (!out) {
            throw new Violation(
              "write-lost",
              "faithful fenced write dropped without invalidation",
            );
          }
          if ((await cache.cacheGet(key)) !== c.value) {
            throw new Violation("write-lost", "fenced value not served");
          }
        }
        break;
      }
      case "del": {
        const out = await cache.cacheDel(...c.delKeys);
        detail.result = out;
        detail.keys = c.delKeys.length;
        if (out !== undefined) {
          throw new Violation("shape", "cacheDel resolved a value");
        }
        assertCommandsSerialisable(fake.requests);
        if (c.delKeys.length === 0 && fake.requests.length !== 0) {
          throw new Violation("empty-del-hit-l2", "");
        }
        break;
      }
      case "windowIncr": {
        const out = await cache.redisWindowIncr(key, 60);
        detail.result = out;
        if (
          !(out === null || (typeof out === "number" && Number.isFinite(out)))
        ) {
          throw new Violation("shape", `redisWindowIncr → ${String(out)}`);
        }
        break;
      }
      case "windowGet": {
        const out = await cache.redisWindowGet(key);
        detail.result = out;
        if (
          !(out === null || (typeof out === "number" && Number.isFinite(out)))
        ) {
          throw new Violation("shape", `redisWindowGet → ${String(out)}`);
        }
        break;
      }
      case "enforceRateLimit":
      case "peekRateLimit": {
        const fn = c.op === "enforceRateLimit"
          ? rateLimit.enforceRateLimit
          : rateLimit.peekRateLimit;
        const out = await fn("ip", key, 30, 300);
        detail.result = out;
        if (typeof out.allowed !== "boolean") {
          throw new Violation("shape", "allowed");
        }
        if (!(Number.isFinite(out.remaining) && out.remaining >= 0)) {
          throw new Violation("shape", "remaining");
        }
        if (
          !(Number.isFinite(out.retryAfterSeconds) &&
            out.retryAfterSeconds >= 1)
        ) {
          throw new Violation(
            "shape",
            `retryAfterSeconds=${String(out.retryAfterSeconds)}`,
          );
        }
        if (out.limit !== 30) {
          throw new Violation("shape", "limit echoed wrong");
        }
        const response = rateLimit.rateLimitResponse(out);
        if (
          response.status !== 429 ||
          !/^\d+$/.test(response.headers.get("Retry-After") ?? "")
        ) {
          throw new Violation("shape", "rateLimitResponse headers");
        }
        await response.body?.cancel();
        break;
      }
      case "setThenSkewGet": {
        // Write at "now", read at now + skew under a faithful L2.
        const realNow = Date.now;
        const base = realNow();
        Date.now = () => base;
        try {
          const landed = await cache.cacheSet(key, c.value, c.ttl);
          if (!landed) {
            throw new Violation(
              "l2-write-refused",
              "faithful L2 refused a valid SET",
            );
          }
        } finally {
          Date.now = realNow;
        }
        // Under skew, Date.now() = realNow() + skew; the write happened at `base`.
        const readStart = realNow() + c.skewMs;
        const out = await withSkew(c.skewMs, () => cache.cacheGet(key));
        const readEnd = realNow() + c.skewMs;
        const expiresAt = base + c.ttl * 1_000;
        detail.result = out === c.value
          ? "value"
          : out === null
          ? null
          : "other";
        if (readStart >= expiresAt && out === c.value) {
          throw new Violation(
            "ttl-skew-stale",
            `served ${readStart - expiresAt} ms past expiry`,
          );
        }
        if (readEnd < expiresAt - 5 && out !== c.value) {
          throw new Violation(
            "ttl-skew-early-miss",
            `missed ${expiresAt - readEnd} ms before expiry`,
          );
        }
        break;
      }
    }
  });

  assertPrototypesClean();
  // Keep the campaign's L1 footprint bounded: drop oversized rows again.
  if (key.length > 4_096 || c.value.length > 4_096) {
    fake.mode = "faithful";
    await cache.cacheDel(key);
  }
  return detail;
}

function caseSummary(c: Case): Record<string, unknown> {
  return {
    mode: c.mode,
    keyCategory: c.key.category,
    key: abbreviate(c.key.value),
    keyBytes: utf8Bytes(c.key.value),
    keyCodePoints: codePoints(c.key.value),
    keyGraphemes: c.key.value.length > 100_000 ? null : graphemes(c.key.value),
    revokedKeyCategory: c.revokedKey.category,
    valueCategory: c.valueCategory,
    valueLength: c.value.length,
    ttl: describeNumber(c.ttl),
    skewMs: c.skewMs,
    delKeys: c.delKeys.length,
    delBetweenFence: c.delBetweenFence,
    markerPreset: c.markerPreset,
  };
}

// ─── The campaign ────────────────────────────────────────────────────────────

Deno.test(`[stress] boundary/malformed campaign against cache.ts + rateLimit.ts (${TEST_FILE})`, async () => {
  const config = campaignConfig(DEFAULT_ITERATIONS);
  const seeds = iterationSeeds(config);
  configureRedis(true);
  const fake = hostileUpstash(new Rng(config.seed));
  const startedAt = new Date();
  const rows: OutcomeRow[] = [];
  const heapStart = heapUsedMb();
  let iso = await loadIsolate();
  try {
    for (let i = 0; i < seeds.length; i += 1) {
      if (i > 0 && i % 500 === 0) iso = await loadIsolate();
      const seed = seeds[i];
      const c = genCase(seed);
      let outcome: OutcomeRow["outcome"] = "HELD";
      let violation: string | undefined;
      let detail: Record<string, unknown> = {};
      try {
        detail = await runCase(c, iso, fake);
      } catch (error) {
        if (error instanceof Violation) {
          violation = error.message;
          const known = knownDefect(error.code, c);
          outcome = known ? `DEFECT:${known}` : "BROKEN";
        } else {
          violation = `THROW ${
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error)
          }`;
          outcome = "BROKEN";
        }
      }
      rows.push({
        i,
        seed,
        outcome,
        op: c.op,
        detail: { ...caseSummary(c), ...detail },
        violation,
      });
    }
  } finally {
    fake.restore();
  }
  const table = await buildTable(
    "cache-boundary-malformed",
    config,
    rows,
    startedAt,
    TEST_FILE,
    {
      heapUsedMbStart: heapStart,
      heapUsedMbEnd: heapUsedMb(),
      redisPipelines: fake.calls,
      redisKeysLeft: fake.store.size,
    },
  );
  const path = await writeTable(table, config);
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  console.log(
    `[stress] ${TEST_FILE}: ${rows.length} iterations, held=${table.summary.held} broken=${broken.length} defects=${
      JSON.stringify(table.summary.defects)
    }${path ? ` table=${path}` : ""}`,
  );
  assertEquals(
    broken.map((r) => ({ seed: r.seed, op: r.op, violation: r.violation })),
    [],
    "unpinned invariant violations — replay each seed with STRESS_REPLAY=<seed>",
  );
});

// ─── Pinned defects (minimised from campaign seeds) ──────────────────────────

Deno.test(
  "[defect] cacheSet with a NaN, +Infinity or > 9.2e15 s TTL stores an L1 row that (practically) never expires while L2 refuses the SET (EX null / 1e+16 / 1e+308)",
  async () => {
    configureRedis(true);
    const fake = hostileUpstash(new Rng(1));
    try {
      const { cache } = await loadIsolate();
      for (const ttl of [Number.NaN, Number.POSITIVE_INFINITY, 1e16, 1e308]) {
        fake.requests = [];
        const landed = await cache.cacheSet(
          `k:${describeNumber(ttl)}`,
          "v",
          ttl,
        );
        assertEquals(
          landed,
          false,
          "L2 refuses the malformed EX, so the write is reported as not landed",
        );
        const sent = fake.requests[0]?.commands as unknown[][];
        assert(Array.isArray(sent) && sent[0][0] === "SET", "a SET reached L2");
        const ex = sent[0][4];
        assert(
          ex === null || (typeof ex === "number" && ex > REDIS_MAX_EX_SECONDS),
          `EX serialised as ${
            JSON.stringify(ex)
          } (null for NaN/Infinity, beyond int64 ms otherwise)`,
        );
        // Current behaviour: the row is in L1 with expiresAtMs = NaN/Infinity and
        // is served indefinitely (until eviction); it should have been refused
        // like ttl <= 0 (cacheSet returns false, nothing stored).
        const realNow = Date.now;
        const base = realNow();
        Date.now = () => base + 365 * 86_400_000;
        try {
          assertEquals(
            await cache.cacheGet(`k:${describeNumber(ttl)}`),
            "v",
            "served a year later from L1",
          );
        } finally {
          Date.now = realNow;
        }
      }
    } finally {
      fake.restore();
    }
  },
);

// ─── Upstash down: timeouts (each costs REDIS_TIMEOUT_MS = 1.2 s) ────────────

Deno.test("[stress] Upstash hanging: every entry point resolves after the 1.2 s timeout with its degraded answer, nothing throws", async () => {
  configureRedis(true);
  const fake = hostileUpstash(new Rng(2));
  try {
    const { cache, rateLimit } = await loadIsolate();
    await cache.cacheSet("hang:k", "v", 60);
    fake.hang = true;
    const started = performance.now();
    const [guarded, revoked, limit] = await Promise.all([
      cache.cacheGetUnlessRevoked("hang:k", "auth:revoked:hang"),
      cache.cacheIsRevoked("auth:revoked:hang"),
      rateLimit.enforceRateLimit("ip", "\u0000hang", 30, 300),
    ]);
    const elapsed = performance.now() - started;
    assert(
      elapsed >= 1_000 && elapsed < 5_000,
      `timeout honoured (${Math.round(elapsed)} ms)`,
    );
    assertEquals(
      guarded,
      { value: "v", revoked: false },
      "unreachable L2 degrades to the L1 copy",
    );
    assertEquals(revoked, null, "unknown, not false");
    assertEquals(limit.allowed, true, "limits fail open on outage");
    assertPrototypesClean();
  } finally {
    fake.restore();
  }
});

// ─── Key flood: L1 stays bounded under hostile keys ──────────────────────────

Deno.test("[stress] key flood: 20 000 distinct hostile keys (NUL, 64 KiB, NFD, traversal) keep L1 at its 5 000 cap and evict oldest-first", async () => {
  configureRedis(false);
  const { cache } = await loadIsolate();
  const rng = new Rng(3);
  const heapBefore = heapUsedMb();
  const first = "auth:revoked:first\u0000";
  await cache.cacheSet(first, "1", 660);
  const keys: string[] = [];
  for (let i = 0; i < 20_000; i += 1) {
    const s = rng.bool(0.02) ? genWeightedString(rng) : {
      category: "ascii",
      value: `auth:revoked:${i}:${rng.next().toString(16)}`,
    };
    const key = `${s.value}#${i}`;
    keys.push(key);
    await cache.cacheSet(key, "1", 660);
  }
  const heapAfter = heapUsedMb();
  assertEquals(
    await cache.cacheGet(first),
    null,
    "the oldest row was evicted by the cap",
  );
  let alive = 0;
  for (const key of keys.slice(-3_000)) {
    if ((await cache.cacheGet(key)) !== null) alive += 1;
  }
  assertEquals(alive, 3_000, "the newest rows survive");
  let evicted = 0;
  for (const key of keys.slice(0, 3_000)) {
    if ((await cache.cacheGet(key)) === null) evicted += 1;
  }
  assertEquals(evicted, 3_000, "the oldest rows are gone");
  console.log(
    `[stress] key flood heap: before=${heapBefore} MiB after=${heapAfter} MiB`,
  );
  assertPrototypesClean();
});

// ─── Unicode normalisation: keys are byte-exact, never normalised ────────────

Deno.test("[stress] NFC and NFD spellings of the same id are distinct keys in L1 and L2 (no accidental normalisation either way)", async () => {
  configureRedis(true);
  const fake = hostileUpstash(new Rng(4));
  try {
    const { cache } = await loadIsolate();
    const nfc = "auth:revoked:café".normalize("NFC");
    const nfd = "auth:revoked:café".normalize("NFD");
    assert(nfc !== nfd);
    await cache.cacheSet(nfc, "1", 660);
    assertEquals(
      await cache.cacheIsRevoked(nfd),
      false,
      "NFD spelling is not fenced by the NFC marker",
    );
    assertEquals(await cache.cacheIsRevoked(nfc), true);
    assertEquals(fake.store.has(nfc), true);
    assertEquals(fake.store.has(nfd), false);
    const other = await loadIsolate();
    assertEquals(
      await other.cache.cacheIsRevoked(nfd),
      false,
      "cold isolate: L2 lookup is byte-exact too",
    );
    assertEquals(await other.cache.cacheIsRevoked(nfc), true);
  } finally {
    fake.restore();
  }
});
