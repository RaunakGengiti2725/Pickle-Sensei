// Loads the REAL edge handler (../../index.ts) with Deno.serve captured and the
// stateful FakeSupabase installed at the fetch layer. Also owns artifact
// output: when AUTH_ATTACK_ARTIFACT_DIR is set, every test writes its raw
// JSON table / log there so a failure is replayable from the recorded seed
// and inputs; when unset the tests only assert.
//
// Each test FILE gets its own module graph under `deno test`, so per-file env
// (e.g. Upstash on/off) is honoured and module-level state in index.ts,
// cache.ts and rateLimit.ts starts fresh per file.

import { captureAccessLog } from "../../http.ts";
import {
  FAKE_ANON_KEY,
  FAKE_REDIS_TOKEN,
  FAKE_REDIS_URL,
  FAKE_SUPABASE_URL,
  FakeSupabase,
} from "./fakeSupabase.ts";

export interface AttackHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  accessLog: string[];
  restoreFetch: () => void;
  restoreAccessLog: () => void;
  realServe: typeof Deno.serve;
}

export const EDGE_BASE = "http://edge.attack.test/functions/v1/api";

export const DEFAULT_SEED = 20260904;

export function seedFromEnv(): number {
  const raw = Deno.env.get("AUTH_ATTACK_SEED");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed >>> 0 : DEFAULT_SEED;
}

let loaded: AttackHarness | null = null;

export async function loadAttackHarness(options: { redis?: boolean } = {}): Promise<AttackHarness> {
  if (loaded) return loaded;

  Deno.env.set("SUPABASE_URL", FAKE_SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", FAKE_ANON_KEY);
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-attack-harness-key");
  Deno.env.delete("APPLE_SIGN_IN_CLIENT_ID");
  Deno.env.delete("APPLE_SIGN_IN_TEAM_ID");
  Deno.env.delete("APPLE_SIGN_IN_KEY_ID");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  Deno.env.delete("APPLE_TOKEN_ENCRYPTION_KEY");
  Deno.env.delete("REVENUECAT_SECRET_API_KEY");
  Deno.env.delete("REVENUECAT_PUBLIC_SDK_KEY");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "attack-harness-webhook-secret");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", FAKE_REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", FAKE_REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const fake = await FakeSupabase.create();
  const restoreFetch = fake.install();
  const accessLog: string[] = [];
  const restoreAccessLog = captureAccessLog((line) => accessLog.push(line));

  const realServe = Deno.serve;
  let handler: ((request: Request) => Promise<Response>) | null = null;
  Deno.serve = ((...args: unknown[]) => {
    const found = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!found) throw new Error("Deno.serve called without a handler");
    handler = found;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../../index.ts");
  if (!handler) throw new Error("index.ts did not call Deno.serve");

  loaded = { handler, fake, accessLog, restoreFetch, restoreAccessLog, realServe };
  return loaded;
}

export interface EdgeRequestOptions {
  /** Raw Authorization header value; `token` builds `Bearer <token>`. */
  authorization?: string | null;
  token?: string;
  ip?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export function edgeRequest(method: string, path: string, options: EdgeRequestOptions = {}): Request {
  const headers = new Headers({ "x-forwarded-for": options.ip ?? "198.51.100.1" });
  if (options.authorization !== null) {
    const authorization = options.authorization ?? (options.token !== undefined ? `Bearer ${options.token}` : null);
    if (authorization !== null) headers.set("Authorization", authorization);
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("Content-Type", "application/json");
  }
  return new Request(`${EDGE_BASE}${path}`, { method, headers, body });
}

/** Distinct client IP per attempt so the per-IP auth-failure budget (30 per
 * 5 min) never masks how the edge judged the bearer itself. */
export function ipForIndex(index: number, block = 10): string {
  return `${block}.${(index >>> 16) & 255}.${(index >>> 8) & 255}.${index & 255}`;
}

export interface EdgeOutcome {
  status: number;
  code: string | null;
  error: string | null;
  bodyText: string;
  upstreamCalls: Array<{ method: string; path: string; bearer: string; status: number }>;
  reachedRest: boolean;
  consultedAuth: boolean;
}

export async function callEdge(harness: AttackHarness, request: Request): Promise<EdgeOutcome> {
  const since = harness.fake.calls.length;
  const response = await harness.handler(request);
  const bodyText = await response.text();
  let code: string | null = null;
  let error: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string } };
    code = parsed?.error?.code ?? null;
    error = parsed?.error?.message ?? null;
  } catch {
    // not JSON (204 etc.)
  }
  const upstream = harness.fake.callsSince(since).map((call) => ({
    method: call.method,
    path: call.path,
    bearer: call.bearer,
    status: call.status,
  }));
  return {
    status: response.status,
    code,
    error,
    bodyText,
    upstreamCalls: upstream,
    reachedRest: upstream.some((call) => call.path.startsWith("/rest/v1/")),
    consultedAuth: upstream.some((call) => call.path.startsWith("/auth/v1/")),
  };
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

export function artifactDir(): string | null {
  const dir = Deno.env.get("AUTH_ATTACK_ARTIFACT_DIR");
  return dir && dir.trim() ? dir : null;
}

export async function writeArtifact(name: string, data: unknown): Promise<string | null> {
  const dir = artifactDir();
  if (!dir) return null;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${name}`;
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  await Deno.writeTextFile(path, text);
  return path;
}

export function heapSnapshot(): Record<string, number> {
  const usage = Deno.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
  };
}
