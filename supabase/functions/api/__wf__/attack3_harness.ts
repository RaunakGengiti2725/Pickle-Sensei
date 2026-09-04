// Adversarial pass 3 (edge-auth-cache-ratelimit) — test-only extension of
// routesHarness: wraps the harness fetch so a test can (a) see every upstream
// call the REAL handler makes and (b) override individual upstream responses
// (GoTrue 429/5xx on refresh, GET /auth/v1/user verdicts, …). Nothing here
// touches production code; the real `../index.ts` handler is exercised.

import { assertEquals } from "@std/assert";
import { type Harness, loadHarness, SUPABASE_URL } from "./routesHarness.ts";
import { peekRateLimit } from "../rateLimit.ts";

/**
 * REPRO tests pin the behaviour OBSERVED on 4d812e1a (repo convention, see
 * account_routes.test.ts "REPRO:") so `deno task test` stays green while the
 * defect is open, and fail the moment the behaviour changes. Run with
 * `ATTACK3_ASSERT_FIXED=1` to assert the REQUIRED behaviour instead (the
 * fixer's target; on 4d812e1a these tests then fail with the observed values).
 */
export const ASSERT_FIXED = Deno.env.get("ATTACK3_ASSERT_FIXED") === "1";

export function assertRepro<T>(
  actual: T,
  values: { observed: T; required: T },
  label: string,
): void {
  assertEquals(
    actual,
    ASSERT_FIXED ? values.required : values.observed,
    `${label} — observed on 4d812e1a: ${
      JSON.stringify(values.observed)
    }, required: ${JSON.stringify(values.required)}`,
  );
}

export const SUPABASE_ISS = `${SUPABASE_URL}/auth/v1`;
export const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
export const IP_LIMIT = { limit: 1_200, windowSeconds: 60 };

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string;
}

export type UpstreamOverride = (
  request: Request,
  url: URL,
  bodyText: string,
) => Response | null | undefined | Promise<Response | null | undefined>;

export interface Attack3 {
  harness: Harness;
  /** Every upstream fetch the edge handler issued (recorded before dispatch). */
  upstream: UpstreamCall[];
  setOverride(fn: UpstreamOverride | null): void;
  upstreamTo(fragment: string): UpstreamCall[];
  /** GET /auth/v1/user calls (Supabase access-token verification). */
  getUserCalls(): UpstreamCall[];
  reset(): void;
}

/** base64url of the UTF-8 bytes of `value` (btoa alone rejects non-Latin-1). */
const b64url = (value: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
};

const b64urlDecode = (segment: string): string => {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
};

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** A Supabase-issued access token as the edge sees it (signature is never
 * checked by the edge — GoTrue is; here GoTrue is the stub below). */
export function supabaseBearer(
  sub: string,
  options: {
    iss?: string;
    /** `undefined` omits the claim; any other value is JSON-encoded. */
    exp?: unknown;
    /** Verbatim payload JSON (lets a test encode things JSON.stringify cannot, e.g. NaN). */
    rawPayload?: string;
    extra?: Record<string, unknown>;
  } = {},
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = options.rawPayload ??
    JSON.stringify({
      iss: options.iss ?? SUPABASE_ISS,
      sub,
      aud: "authenticated",
      role: "authenticated",
      ...(options.exp === undefined ? {} : { exp: options.exp }),
      ...(options.extra ?? {}),
    });
  return `${header}.${b64url(payload)}.${b64url(`sig-${sub}`)}`;
}

export function decodePayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(segments[1])) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Default GoTrue verdict for GET /auth/v1/user: accept only tokens whose
 * issuer is THIS project's Auth (anything else is "invalid JWT", 401). */
export function defaultGetUserVerdict(request: Request): Response {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const payload = decodePayload(token);
  const sub = typeof payload?.sub === "string" ? payload.sub : "";
  if (!payload || payload.iss !== SUPABASE_ISS || !sub) {
    return jsonResponse(401, {
      code: 401,
      error_code: "bad_jwt",
      msg: "invalid JWT: unable to parse or verify signature",
    });
  }
  return jsonResponse(200, {
    id: sub,
    aud: "authenticated",
    role: "authenticated",
    email: `${sub.slice(0, 8)}@example.com`,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
}

let attack: Attack3 | null = null;

export async function loadAttack3(): Promise<Attack3> {
  const harness = await loadHarness();
  if (attack) {
    attack.reset();
    return attack;
  }
  const harnessFetch = globalThis.fetch;
  let override: UpstreamOverride | null = null;
  const state: Attack3 = {
    harness,
    upstream: [],
    setOverride(fn) {
      override = fn;
    },
    upstreamTo(fragment) {
      return state.upstream.filter((call) => call.url.includes(fragment));
    },
    getUserCalls() {
      return state.upstream.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname === "/auth/v1/user",
      );
    },
    reset() {
      state.upstream = [];
      override = null;
    },
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const bodyText = await request.clone().text().catch(() => "");
    const headers: Record<string, string> = {};
    request.headers.forEach((
      value,
      key,
    ) => (headers[key.toLowerCase()] = value));
    state.upstream.push({
      url: request.url,
      method: request.method,
      headers,
      bodyText,
    });
    const url = new URL(request.url);
    if (override) {
      const overridden = await override(request, url, bodyText);
      if (overridden) return overridden;
    }
    if (request.method === "GET" && url.pathname === "/auth/v1/user") {
      return defaultGetUserVerdict(request);
    }
    return harnessFetch(request);
  }) as typeof fetch;

  attack = state;
  return state;
}

/** Hits recorded against the auth-failure budget for `ip` in the current
 * window (saturates at the limit — peek never reports more than `limit`). */
export async function authFailCount(ip: string): Promise<number> {
  const peek = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return AUTH_FAILURE_LIMIT.limit - peek.remaining;
}

export async function ipHitCount(ip: string): Promise<number> {
  const peek = await peekRateLimit(
    "ip",
    ip,
    IP_LIMIT.limit,
    IP_LIMIT.windowSeconds,
  );
  return IP_LIMIT.limit - peek.remaining;
}

export function edgeRequest(
  method: string,
  path: string,
  options: {
    authorization?: string | null;
    ip?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "203.0.113.77",
  });
  if (options.authorization) {
    headers.set("Authorization", options.authorization);
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers.set(key, value);
  }
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body ?? undefined,
  });
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { raw: text };
  } catch {
    return { raw: text };
  }
}

export function errorMessageOf(body: Record<string, unknown>): string {
  const error = body.error;
  return error && typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "";
}

export function errorCodeOf(body: Record<string, unknown>): string {
  const error = body.error;
  return error && typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
}

/** Runs `fn` with Date.now() pinned to `nowMs` (rate-limit buckets and cache
 * expiry both read Date.now()); always restores the real clock. */
export async function withClock<T>(
  nowMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** A distinct RFC 5737/1918 address per index (no two indices collide). */
export function ipFor(index: number): string {
  return `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
}

/** Streams `totalBytes` of JSON-ish bytes in `chunkBytes` pieces with no Content-Length. */
export function chunkedBody(
  totalBytes: number,
  chunkBytes = 64 * 1024,
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      const chunk = new Uint8Array(size);
      chunk.fill(0x20); // spaces: valid JSON whitespace, never a complete document
      if (sent === 0) chunk[0] = 0x7b; // "{" so a parser would keep reading
      sent += size;
      controller.enqueue(chunk);
    },
  });
}
