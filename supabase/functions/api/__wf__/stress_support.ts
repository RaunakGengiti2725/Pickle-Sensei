// Shared support for the stress_*.test.ts campaigns (edge-cache / failure-load).
//
//   Prng            — mulberry32; every campaign iteration is replayable from
//                     its seed (STRESS_SEED) and iteration index.
//   installFaultLayer — wraps whatever fake `fetch` a harness installed and
//                     lets a test fail / hang / malform ONE upstream at a time
//                     (Upstash, Supabase Auth user/token/logout, PostgREST,
//                     RevenueCat) while every other upstream keeps answering
//                     from the harness fake. Nothing here opens a socket.
//   writeArtifact   — JSON reports under STRESS_OUT_DIR
//                     (default artifacts/stress-edge-cache/latest/).
//
// New files only: no existing test or production module is modified.

export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  /** Weighted pick: `[[item, weight], ...]`. */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1][0];
  }
  hex(length: number): string {
    return Array.from({ length }, () => this.int(0, 15).toString(16)).join("");
  }
  uuid(): string {
    const h = (n: number) => this.hex(n);
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function latencySummary(samples: number[]): {
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    n: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? NaN),
    meanMs: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
  };
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-edge-cache/latest/", import.meta.url).pathname;
}

export async function writeArtifact(name: string, payload: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}

/** Capture console.error / console.warn while `fn` runs (the handler's 5xx
 * detail only ever goes there); returns the lines so a test can assert what
 * was logged and that the response body never carried it. */
export async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => lines.push(`error: ${args.map(String).join(" ")}`);
  console.warn = (...args: unknown[]) => lines.push(`warn: ${args.map(String).join(" ")}`);
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

// ─── Fault layer ─────────────────────────────────────────────────────────────

export type Upstream = "redis" | "auth_user" | "auth_token" | "auth_logout" | "rest" | "rc";

export const UPSTREAMS: readonly Upstream[] = [
  "redis",
  "auth_user",
  "auth_token",
  "auth_logout",
  "rest",
  "rc",
];

/** Failure modes. `http_*` answer that status with an upstream-shaped error
 * body; `hang` never answers (rejects with the caller's AbortSignal reason
 * when it has one, otherwise waits until `releaseHangs()`); `throw` fails at
 * the socket; `body_*` answer HTTP 200 with a body the caller cannot use;
 * `redis_*` answer a well-formed Upstash pipeline whose slots are wrong;
 * `auth_*` / `rc_*` are semantically malformed 2xx answers. */
export const FAULT_MODES = {
  generic: [
    "http_500",
    "http_502",
    "http_503_retry_after",
    "http_429",
    "http_404",
    "hang",
    "throw",
    "body_text",
    "body_empty_object",
    "body_empty_array",
    "body_null",
    "body_truncated_json",
  ],
  refusal: ["http_400", "http_401", "http_403"],
  redis: [
    "redis_cmd_error",
    "redis_short_reply",
    "redis_null_slots",
    "redis_number_slots",
    "redis_string_slots",
    "redis_http_401",
  ],
  auth_user: ["auth_user_no_provider", "auth_user_no_id"],
  auth_token: ["auth_token_expires_in_zero", "auth_token_expired_at", "auth_token_no_refresh"],
  rc: ["rc_subscriber_null", "rc_entitlements_garbage", "rc_expires_garbage"],
} as const;

export interface FaultSpec {
  upstream: Upstream;
  mode: string;
  /** Number of matching upstream calls to affect (Infinity = until cleared). */
  remaining?: number;
}

export interface FaultHit {
  upstream: Upstream;
  mode: string;
  url: string;
  method: string;
  /** Whether the caller passed an AbortSignal (so a hang is bounded by it). */
  boundedBySignal: boolean;
}

export interface FaultLayer {
  set(fault: FaultSpec): void;
  clear(): void;
  /** Resolve every pending unbounded hang with an HTTP 500 so the request
   * finishes and nothing leaks into the next case. Returns how many. */
  releaseHangs(): number;
  hits: FaultHit[];
  classify(url: string, method: string): Upstream | null;
  restore(): void;
}

export function classifyUpstream(
  urls: { redis: string; supabase: string },
  url: string,
  method: string,
): Upstream | null {
  if (url.startsWith(`${urls.redis}/pipeline`)) return "redis";
  if (url.startsWith("https://api.revenuecat.com/")) return "rc";
  if (url.startsWith(`${urls.supabase}/auth/v1/user`) && method === "GET") return "auth_user";
  if (url.startsWith(`${urls.supabase}/auth/v1/token`)) return "auth_token";
  if (url.startsWith(`${urls.supabase}/auth/v1/logout`)) return "auth_logout";
  if (url.startsWith(`${urls.supabase}/rest/v1/`)) return "rest";
  return null;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function upstreamErrorBody(upstream: Upstream, status: number): unknown {
  switch (upstream) {
    case "redis":
      return { error: `forced-upstash-${status}` };
    case "auth_user":
    case "auth_token":
    case "auth_logout":
      return { code: status, error_code: "forced_failure", msg: `forced-gotrue-${status}` };
    case "rest":
      return {
        code: "PGRST000",
        message: `forced-postgrest-${status}`,
        details: "forced detail",
        hint: null,
      };
    case "rc":
      return { code: 7000, message: `forced-revenuecat-${status}` };
  }
}

function redisSlots(body: string, slot: (command: unknown[]) => unknown): Response {
  let commands: unknown[][] = [];
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) commands = parsed as unknown[][];
  } catch {
    commands = [];
  }
  return jsonResponse(200, commands.map(slot));
}

export function installFaultLayer(urls: { redis: string; supabase: string }): FaultLayer {
  const inner = globalThis.fetch;
  let active: (FaultSpec & { remaining: number }) | null = null;
  const pendingHangs: Array<(response: Response) => void> = [];
  const layer: FaultLayer = {
    hits: [],
    set(fault) {
      active = { ...fault, remaining: fault.remaining ?? Infinity };
    },
    clear() {
      active = null;
    },
    releaseHangs() {
      const n = pendingHangs.length;
      for (const release of pendingHangs.splice(0)) {
        release(new Response("released hang", { status: 500 }));
      }
      return n;
    },
    classify: (url, method) => classifyUpstream(urls, url, method),
    restore() {
      globalThis.fetch = inner;
    },
  };

  const answer = async (
    fault: FaultSpec,
    upstream: Upstream,
    request: Request,
    signal: AbortSignal | null | undefined,
    rawBody: string,
  ): Promise<Response> => {
    const mode = fault.mode;
    const httpMatch = /^(?:redis_)?http_(\d{3})(_retry_after)?$/.exec(mode);
    if (httpMatch) {
      const status = Number(httpMatch[1]);
      const headers: Record<string, string> = httpMatch[2] ? { "Retry-After": "7" } : {};
      return jsonResponse(status, upstreamErrorBody(upstream, status), headers);
    }
    switch (mode) {
      case "hang":
        if (signal) {
          await new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return await new Promise<Response>((resolve) => pendingHangs.push(resolve));
      case "throw":
        throw new TypeError(
          `error sending request for url (${request.url}): client error (Connect): connection reset`,
        );
      case "body_text":
        return new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      case "body_empty_object":
        return jsonResponse(200, {});
      case "body_empty_array":
        return jsonResponse(200, []);
      case "body_null":
        return jsonResponse(200, null);
      case "body_truncated_json":
        return new Response('{"id":"11111111-1111-4111-8111-1111', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      // Upstash: HTTP 200, per-slot trouble.
      case "redis_cmd_error":
        return redisSlots(rawBody, () => ({ error: "ERR max requests limit exceeded" }));
      case "redis_short_reply":
        return jsonResponse(200, []);
      case "redis_null_slots":
        return redisSlots(rawBody, () => ({ result: null }));
      case "redis_number_slots":
        return redisSlots(rawBody, () => ({ result: 42 }));
      case "redis_string_slots":
        return redisSlots(rawBody, () => ({ result: "garbage" }));
      // GoTrue: 2xx with an unusable or unexpected user / session.
      case "auth_user_no_provider":
        return jsonResponse(200, {
          id: "66666666-6666-4666-8666-666666666666",
          aud: "authenticated",
          role: "authenticated",
          email: "noprovider@example.com",
          app_metadata: {},
          user_metadata: {},
        });
      case "auth_user_no_id":
        return jsonResponse(200, { aud: "authenticated", email: "noid@example.com" });
      case "auth_token_expires_in_zero":
        return jsonResponse(200, {
          access_token: "dead.on.arrival",
          token_type: "bearer",
          expires_in: 0,
          refresh_token: "rt-dead",
          user: { id: "66666666-6666-4666-8666-666666666666", app_metadata: {} },
        });
      case "auth_token_expired_at":
        return jsonResponse(200, {
          access_token: "dead.on.arrival",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) - 60,
          refresh_token: "rt-dead",
          user: { id: "66666666-6666-4666-8666-666666666666", app_metadata: {} },
        });
      case "auth_token_no_refresh":
        return jsonResponse(200, {
          access_token: "half.written.session",
          token_type: "bearer",
          expires_in: 3600,
          user: { id: "66666666-6666-4666-8666-666666666666", app_metadata: {} },
        });
      // RevenueCat: 2xx that grants nothing or cannot be read.
      case "rc_subscriber_null":
        return jsonResponse(200, { request_date_ms: Date.now(), subscriber: null });
      case "rc_entitlements_garbage":
        return jsonResponse(200, {
          request_date_ms: Date.now(),
          subscriber: { entitlements: "not-an-object" },
        });
      case "rc_expires_garbage":
        return jsonResponse(200, {
          request_date_ms: Date.now(),
          subscriber: {
            entitlements: {
              pickle_sensei_pro: { expires_date: "not-a-date", product_identifier: 12 },
            },
          },
        });
      default:
        throw new Error(`stress_support: unknown fault mode ${mode}`);
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const upstream = classifyUpstream(urls, url, method);
    const fault = active;
    if (upstream && fault && fault.upstream === upstream && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) active = null;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      layer.hits.push({
        upstream,
        mode: fault.mode,
        url,
        method,
        boundedBySignal: Boolean(signal),
      });
      const probe = new Request(input, init);
      const rawBody = await probe.text().catch(() => "");
      return answer(fault, upstream, probe, signal, rawBody);
    }
    return inner(input, init);
  }) as typeof fetch;

  return layer;
}

/** Read a JSON error body without consuming the caller's Response. */
export async function readError(
  response: Response,
): Promise<{ code: string | null; message: string | null; raw: string }> {
  const raw = await response.clone().text();
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
    const error = parsed && typeof parsed === "object" ? parsed.error : undefined;
    return {
      code: typeof error?.code === "string" ? error.code : null,
      message: typeof error?.message === "string" ? error.message : null,
      raw,
    };
  } catch {
    return { code: null, message: null, raw };
  }
}

/** Strings that would prove upstream detail leaked into a client body. */
export const LEAK_MARKERS = [
  "forced-",
  "PGRST",
  "ERR ",
  "connection reset",
  "supabase.session.test",
  "upstash",
  "released hang",
  "revenuecat.com",
];

export function leaks(body: string): string[] {
  const lower = body.toLowerCase();
  return LEAK_MARKERS.filter((marker) => lower.includes(marker.toLowerCase()));
}
