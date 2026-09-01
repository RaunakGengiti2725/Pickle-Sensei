// Test harness for cache.ts / rateLimit.ts audits.
//
//   fakeUpstash()  — an in-memory emulation of the Upstash REST `/pipeline`
//                    endpoint (GET, TTL, SET … EX, DEL, INCR, EXPIRE … NX)
//                    installed over globalThis.fetch. Failure modes can be
//                    injected (HTTP 500, hang until the caller's timeout).
//   loadIsolate()  — imports cache.ts / rateLimit.ts under a UNIQUE module
//                    specifier (query string) so each call gets its own
//                    module instance = its own L1 maps, exactly like a
//                    separate edge isolate. All isolates share the fake
//                    Redis, so cross-isolate behaviour is observable.
//
// Env is read at module load in cache.ts, so `configureRedis` must run before
// `loadIsolate`. Both helpers are process-global; test files run serially.

type Cmd = Array<string | number>;
type PipelineResult = Array<{ result?: unknown; error?: string }>;

export interface FakeUpstash {
  store: Map<string, { value: string; expiresAtMs: number | null }>;
  commands: Cmd[];
  /** When set, every pipeline call responds with this HTTP status. */
  failStatus: number | null;
  /** When true, every pipeline call hangs until the caller's AbortSignal fires. */
  hang: boolean;
  calls: number;
  restore(): void;
}

export const FAKE_REDIS_URL = "https://fake-upstash.test";
export const FAKE_REDIS_TOKEN = "fake-token";

export function configureRedis(enabled: boolean): void {
  if (enabled) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", FAKE_REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", FAKE_REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }
}

function live(
  store: FakeUpstash["store"],
  key: string,
): { value: string; expiresAtMs: number | null } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

function runCommand(store: FakeUpstash["store"], cmd: Cmd): { result?: unknown; error?: string } {
  const [name, ...args] = cmd.map(String);
  switch (name.toUpperCase()) {
    case "GET": {
      return { result: live(store, args[0])?.value ?? null };
    }
    case "TTL": {
      const entry = live(store, args[0]);
      if (!entry) return { result: -2 };
      if (entry.expiresAtMs === null) return { result: -1 };
      return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1_000)) };
    }
    case "SET": {
      const [key, value, ex, seconds] = args;
      if (ex && ex.toUpperCase() !== "EX") return { error: "ERR syntax error" };
      const ttl = ex ? Number(seconds) : NaN;
      store.set(key, {
        value,
        expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1_000 : null,
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
      store.set(args[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
      return { result: next };
    }
    case "EXPIRE": {
      const [key, seconds, flag] = args;
      const entry = live(store, key);
      if (!entry) return { result: 0 };
      if (flag && flag.toUpperCase() === "NX" && entry.expiresAtMs !== null) return { result: 0 };
      entry.expiresAtMs = Date.now() + Number(seconds) * 1_000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${name}'` };
  }
}

export function fakeUpstash(): FakeUpstash {
  const original = globalThis.fetch;
  const fake: FakeUpstash = {
    store: new Map(),
    commands: [],
    failStatus: null,
    hang: false,
    calls: 0,
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FAKE_REDIS_URL)) return original(input, init);
    fake.calls += 1;
    if (fake.hang) {
      await new Promise<void>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (fake.failStatus !== null) {
      return new Response("upstream error", { status: fake.failStatus });
    }
    const commands = JSON.parse(String(init?.body ?? "[]")) as Cmd[];
    const results: PipelineResult = [];
    for (const cmd of commands) {
      fake.commands.push(cmd);
      results.push(runCommand(fake.store, cmd));
    }
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return fake;
}

let isolateCounter = 0;

export type CacheModule = typeof import("../cache.ts");
export type RateLimitModule = typeof import("../rateLimit.ts");

/** A fresh module instance of cache.ts + rateLimit.ts (own L1 maps). */
export async function loadIsolate(): Promise<{ cache: CacheModule; rateLimit: RateLimitModule }> {
  isolateCounter += 1;
  const tag = `${Date.now()}-${isolateCounter}`;
  // rateLimit.ts imports "./cache.ts" statically, which Deno resolves to the
  // canonical specifier — so a rateLimit instance loaded via query string
  // would share ONE cache.ts instance across isolates. To keep each isolate
  // self-contained, the rateLimit module is re-materialised from source
  // with its cache import pointed at this isolate's cache specifier.
  const cacheSpecifier = new URL(`../cache.ts?iso=${tag}`, import.meta.url).href;
  const cache = (await import(cacheSpecifier)) as CacheModule;
  const rateLimitSource = await Deno.readTextFile(new URL("../rateLimit.ts", import.meta.url));
  const patched = rateLimitSource.replace('from "./cache.ts"', `from "${cacheSpecifier}"`);
  const blob = new Blob([patched], { type: "application/typescript" });
  const blobUrl = URL.createObjectURL(blob);
  const rateLimit = (await import(blobUrl)) as RateLimitModule;
  URL.revokeObjectURL(blobUrl);
  return { cache, rateLimit };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Dependency-free assertions (keeps the repo deno.lock untouched).
export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ? `${msg}: ` : ""}expected ${e}, got ${a}`);
  }
}
