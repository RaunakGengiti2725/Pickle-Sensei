// stress / fuzz-boundary — harness for `POST /v1/account/bootstrap`.
//
// Drives the REAL edge handler (../index.ts, `Deno.serve` captured — no
// socket, no project) with SEEDED, generated requests while every upstream the
// route can reach is stubbed at the fetch layer:
//
//   Supabase Auth  POST /auth/v1/token   (signInWithIdToken — the one exchange)
//   PostgREST      GET/PATCH /rest/v1/profiles, POST /rest/v1/account_external_credentials
//   Apple          POST https://appleid.apple.com/auth/token
//
// Upstash is never configured, so rate limits run on the per-isolate memory
// windows; the oracle below re-implements those windows (aligned buckets) so
// a 429 is PREDICTED, not tolerated. RevenueCat is not reachable from this
// route; a call to it — or to anything else — is recorded as a violation.
//
// Every iteration is a pure function of ONE 32-bit seed (`generateCase`), so
// any row of the results table replays with that seed alone. Outcomes that
// depend on limiter state (429s) additionally need the campaign seed +
// iteration index, which the row carries too.
//
// The oracle is INDEPENDENT of the implementation where it matters: a token
// is "valid" because the generator minted it as such (known subject, exact
// issuer, sane exp) — never because index.ts accepted it. Everything the
// generator did not mint as valid must be refused with 401.

import { captureAccessLog } from "../http.ts";
import { Prng } from "./xc_concurrency_harness.ts";

// ── Environment the real module boots with ───────────────────────────────────

export const SUPABASE_URL = "http://supabase.fuzz.test";
const ANON_KEY = "fuzz-anon-key-SECRET-a1b2c3";
const SERVICE_ROLE_KEY = "fuzz-service-role-key-SECRET-d4e5f6";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const MAX_JSON_BODY_BYTES = 5_000_000;
export const APPLE_CODE_MAX_LENGTH = 4_096;

/** Marker embedded in every stubbed upstream *error detail*: it must never
 * reach a client body or an access-log line. */
export const SECRET_MARKER = "SECRET_UPSTREAM_DETAIL_7f3a";
/** Marker embedded in the plaintext Apple refresh token the stub hands back:
 * it must never appear in a PostgREST write (only ciphertext may be stored). */
export const APPLE_RT_PLAINTEXT_MARKER = "apple-rt-PLAINTEXT-9c1e";

/** Subjects the generator draws from (fz-user-0 … fz-user-11). */
export const USERS = 12;
/** Subjects the stubbed Auth accepts — the extra range is for the fixed
 * boundary tests so their budgets never overlap the campaign's. */
export const KNOWN_USERS = 64;
export const IP_POOL = 48;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** UTF-8 safe base64url (btoa alone throws on code points above 0xFF). */
export const b64url = (value: string): string =>
  bytesToBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function b64urlDecode(segment: string): string {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
}

const B64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function jwtSegment(
  token: string,
  index: number,
): Record<string, unknown> | null {
  const seg = token.split(".")[index];
  if (!seg || !B64URL_SEGMENT.test(seg)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(seg)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What a real verifier requires of the compact serialization before it even
 * looks at claims: three base64url segments, a JOSE header naming a real
 * algorithm, a non-empty signature. */
function jwtWellFormed(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  if (!parts.every((p) => p.length > 0 && B64URL_SEGMENT.test(p))) return false;
  const header = jwtSegment(token, 0);
  return header !== null && typeof header.alg === "string" &&
    header.alg !== "none";
}

async function testApplePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    [
      "sign",
      "verify",
    ],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const encoded = bytesToBase64(pkcs8)
    .match(/.{1,64}/g)
    ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

// ── Deterministic identities ─────────────────────────────────────────────────

export const fuzzSub = (n: number): string => `fz-user-${n}`;
export const fuzzUserId = (n: number): string =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
export const fuzzEmail = (n: number): string => `fz-user-${n}@example.test`;
const subIndex = (sub: unknown): number | null => {
  if (typeof sub !== "string") return null;
  const m = /^fz-user-(\d{1,4})$/.exec(sub);
  if (!m) return null;
  const n = Number(m[1]);
  return n < KNOWN_USERS ? n : null;
};

/** The provider the profile row currently carries. Users 0,4,8 are stamped
 * `unknown` (signup trigger saw no provider), the others alternate, so the
 * route's provider-correcting PATCH is exercised on a known subset. */
export const profileProvider = (n: number): "unknown" | "google" | "apple" =>
  n % 4 === 0 ? "unknown" : n % 4 === 2 ? "apple" : "google";
export const profileOnboarding = (n: number): "complete" | "pending" =>
  n % 2 === 0 ? "complete" : "pending";

/** A valid Apple authorization code for subject n. `#` padding is accepted by
 * the stubbed Apple endpoint so codes of an exact length (4096) can succeed. */
export const validAppleCode = (n: number, totalLength?: number): string => {
  const base = `apple-code-for:${fuzzSub(n)}`;
  if (totalLength === undefined || totalLength <= base.length) return base;
  return base + "#".repeat(totalLength - base.length);
};
const APPLE_CODE_RE = /^apple-code-for:(fz-user-\d{1,4})#*$/;

export function mintIdToken(
  provider: "google" | "apple",
  claims: Record<string, unknown>,
  headerSegment?: string,
  signature = "sig",
): string {
  const header = headerSegment ??
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const payload = b64url(
    JSON.stringify({
      iss: provider === "google"
        ? "https://accounts.google.com"
        : "https://appleid.apple.com",
      aud: "com.picklesensei",
      ...claims,
    }),
  );
  return `${header}.${payload}.${signature}`;
}

// ── Faults the stubbed upstreams can be told to produce ──────────────────────

export const FAULTS = [
  "none",
  "gotrue_500",
  "gotrue_throw",
  "gotrue_garbage",
  "gotrue_html_502",
  "profile_missing",
  "profile_500",
  "profile_42501",
  "profile_throw",
  "profile_garbage",
  "patch_500",
  "upsert_500",
  "upsert_throw",
  "apple_500",
  "apple_invalid_grant",
  "apple_throw",
  "apple_incomplete",
  "apple_garbage",
] as const;
export type Fault = (typeof FAULTS)[number];

export interface UpstreamCall {
  method: string;
  url: string;
  table: string | null;
  authorization: string | null;
  body: string;
  /** false when the stub refused/failed the call (an attempted, not committed, write) */
  committed: boolean;
}

// ── The stubbed upstreams ────────────────────────────────────────────────────

export class FuzzUpstream {
  fault: Fault = "none";
  calls: UpstreamCall[] = [];
  sessionsMinted = 0;
  appleExchanges = 0;
  unexpected: UpstreamCall[] = [];

  reset(fault: Fault = "none"): void {
    this.fault = fault;
    this.calls = [];
    this.sessionsMinted = 0;
    this.appleExchanges = 0;
    this.unexpected = [];
  }

  /** Writes the stubbed PostgREST accepted. Attempts it refused (injected
   * upsert/patch faults) are still in `calls` for inspection. */
  writes(): UpstreamCall[] {
    return this.calls.filter(
      (c) =>
        c.table !== null && c.committed &&
        (c.method === "POST" || c.method === "PATCH" || c.method === "DELETE"),
    );
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.text().catch(() => "");
    const table = url.pathname.startsWith("/rest/v1/")
      ? url.pathname.slice("/rest/v1/".length)
      : null;
    const call: UpstreamCall = {
      method: request.method,
      url: request.url,
      table,
      authorization: request.headers.get("authorization"),
      body,
      committed: true,
    };
    this.calls.push(call);

    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
      return this.gotrue(url, body);
    }
    if (
      url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user" &&
      request.method === "GET"
    ) {
      // A Supabase-issued-looking bearer reaching getUser(): no session in
      // this harness ever exists, so Auth refuses it.
      return this.json(401, {
        code: 401,
        error_code: "bad_jwt",
        msg: `${SECRET_MARKER} invalid JWT`,
      });
    }
    if (
      url.origin === SUPABASE_URL && table === "profiles" &&
      request.method === "GET"
    ) {
      return this.selectProfile(url, request);
    }
    if (
      url.origin === SUPABASE_URL && table === "profiles" &&
      request.method === "PATCH"
    ) {
      if (this.fault === "patch_500") {
        call.committed = false;
        return this.json(500, {
          code: "XX000",
          message: `${SECRET_MARKER} patch failed`,
        });
      }
      return new Response(null, { status: 204 });
    }
    if (
      url.origin === SUPABASE_URL &&
      table === "account_external_credentials" &&
      request.method === "POST"
    ) {
      if (this.fault === "upsert_500") {
        call.committed = false;
        return this.json(500, {
          code: "XX000",
          message: `${SECRET_MARKER} upsert failed`,
        });
      }
      if (this.fault === "upsert_throw") {
        call.committed = false;
        throw new TypeError(`${SECRET_MARKER} connection reset`);
      }
      return new Response(null, { status: 201 });
    }
    if (request.url === APPLE_TOKEN_URL) {
      return this.apple(body);
    }
    this.unexpected.push(call);
    return new Response(
      `fuzz harness: unexpected upstream ${request.method} ${request.url}`,
      {
        status: 599,
      },
    );
  }

  private gotrue(url: URL, body: string): Response {
    if (url.searchParams.get("grant_type") !== "id_token") {
      return this.json(400, {
        code: 400,
        error_code: "bad_grant",
        msg: `${SECRET_MARKER} grant`,
      });
    }
    switch (this.fault) {
      case "gotrue_500":
        return this.json(500, {
          code: 500,
          error_code: "unexpected_failure",
          msg: `${SECRET_MARKER} gotrue`,
        });
      case "gotrue_throw":
        throw new TypeError(`${SECRET_MARKER} gotrue connection refused`);
      case "gotrue_garbage":
        return new Response(`<<${SECRET_MARKER} not json>>`, { status: 200 });
      case "gotrue_html_502":
        return new Response(`<html>${SECRET_MARKER} bad gateway</html>`, {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const payload = isRecord(parsed) ? parsed : {};
    const token = typeof payload.id_token === "string" ? payload.id_token : "";
    const provider = payload.provider;
    const claims = jwtSegment(token, 1);
    const now = Math.floor(Date.now() / 1000);
    const issuerProvider = claims?.iss === "https://accounts.google.com"
      ? "google"
      : claims?.iss === "https://appleid.apple.com"
      ? "apple"
      : null;
    const n = subIndex(claims?.sub);
    const exp = claims?.exp;
    const validExp = typeof exp === "number" && exp > now &&
      exp <= now + 86_400;
    const signed = jwtWellFormed(token) && token.endsWith(".sig");
    if (
      !signed ||
      issuerProvider === null ||
      issuerProvider !== provider ||
      n === null ||
      !validExp ||
      typeof claims?.jti !== "string"
    ) {
      return this.json(400, {
        code: 400,
        error_code: "bad_jwt",
        msg: `${SECRET_MARKER} id token rejected`,
      });
    }
    this.sessionsMinted += 1;
    const userId = fuzzUserId(n);
    return this.json(200, {
      access_token: `session-for-${userId}.${this.sessionsMinted}`,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: `refresh-${userId}.${this.sessionsMinted}`,
      user: {
        id: userId,
        aud: "authenticated",
        role: "authenticated",
        email: fuzzEmail(n),
        app_metadata: { provider: issuerProvider, providers: [issuerProvider] },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });
  }

  private selectProfile(url: URL, request: Request): Response {
    switch (this.fault) {
      case "profile_500":
        return this.json(500, {
          code: "XX000",
          message: `${SECRET_MARKER} relation exploded`,
          details: null,
          hint: null,
        });
      case "profile_42501":
        return this.json(401, {
          code: "42501",
          message: `${SECRET_MARKER} permission denied for table profiles`,
          details: null,
          hint: null,
        });
      case "profile_throw":
        throw new TypeError(`${SECRET_MARKER} postgrest connection refused`);
      case "profile_garbage":
        return new Response(`{${SECRET_MARKER} truncated`, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
    }
    const single = (request.headers.get("accept") ?? "").includes(
      "vnd.pgrst.object+json",
    );
    // RLS emulation: the row is visible only to the session that owns it.
    const bearer = request.headers.get("authorization") ?? "";
    const owner = /^Bearer session-for-([0-9a-f-]{36})\./.exec(bearer)?.[1] ??
      null;
    const filtered = url.searchParams.get("id");
    const wanted = filtered?.startsWith("eq.") ? filtered.slice(3) : null;
    const n = owner ? parseInt(owner.slice(0, 8), 16) : NaN;
    const rows =
      this.fault !== "profile_missing" && owner && wanted === owner &&
        Number.isInteger(n)
        ? [
          {
            id: owner,
            email: fuzzEmail(n),
            onboarding_state: profileOnboarding(n),
            provider: profileProvider(n),
            skill_level: null,
            handedness: null,
            primary_goal: null,
            biggest_problem: null,
            focus_checkpoint: null,
            first_name: null,
            gender: null,
          },
        ]
        : [];
    if (single) {
      if (rows.length === 0) {
        return this.json(406, {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: "The result contains 0 rows",
          hint: null,
        });
      }
      return this.json(200, rows[0]);
    }
    return this.json(200, rows);
  }

  private apple(body: string): Response {
    this.appleExchanges += 1;
    switch (this.fault) {
      case "apple_500":
        return this.json(500, {
          error: "server_error",
          detail: `${SECRET_MARKER} apple`,
        });
      case "apple_invalid_grant":
        return this.json(400, {
          error: "invalid_grant",
          error_description: SECRET_MARKER,
        });
      case "apple_throw":
        throw new TypeError(`${SECRET_MARKER} apple connection refused`);
      case "apple_incomplete":
        return this.json(200, { access_token: "x", token_type: "Bearer" });
      case "apple_garbage":
        return new Response(`${SECRET_MARKER} <garbage>`, { status: 200 });
    }
    const form = new URLSearchParams(body);
    const code = form.get("code") ?? "";
    const m = APPLE_CODE_RE.exec(code);
    if (!m || form.get("grant_type") !== "authorization_code") {
      return this.json(400, {
        error: "invalid_grant",
        error_description: SECRET_MARKER,
      });
    }
    const sub = m[1];
    return this.json(200, {
      access_token: "apple-access",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token:
        `${APPLE_RT_PLAINTEXT_MARKER}-${sub}-${this.appleExchanges}`,
      id_token: mintIdToken("apple", {
        sub,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    });
  }
}

// ── Boot the real handler once per isolate ───────────────────────────────────

export type Handler = (request: Request) => Response | Promise<Response>;

export interface BootedHandler {
  handler: Handler;
  upstream: FuzzUpstream;
  /** access-log lines captured since the last drain */
  drainAccessLog: () => string[];
  /** console.error/warn lines captured since the last drain */
  drainConsole: () => string[];
}

let booted: BootedHandler | null = null;

export async function bootHandler(): Promise<BootedHandler> {
  if (booted) return booted;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "fuzz-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_fuzz");
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await testApplePrivateKeyPem());
  Deno.env.set(
    "APPLE_TOKEN_ENCRYPTION_KEY",
    bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
  );
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const upstream = new FuzzUpstream();
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      upstream.handle(new Request(input, init))) as typeof fetch;

  let captured: Handler | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (
    ...args: unknown[]
  ): unknown => {
    captured = args.find((a) => typeof a === "function") as Handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!captured) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }

  let accessLines: string[] = [];
  captureAccessLog((line) => accessLines.push(line));
  let consoleLines: string[] = [];
  const format = (args: unknown[]) =>
    args.map((
      a,
    ) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(
      " ",
    );
  console.error = (...args: unknown[]) =>
    consoleLines.push(`error ${format(args)}`);
  console.warn = (...args: unknown[]) =>
    consoleLines.push(`warn ${format(args)}`);

  booted = {
    handler: captured,
    upstream,
    drainAccessLog: () => {
      const out = accessLines;
      accessLines = [];
      return out;
    },
    drainConsole: () => {
      const out = consoleLines;
      consoleLines = [];
      return out;
    },
  };
  return booted;
}

// ── Oracle: the memory rate limiter, re-implemented ──────────────────────────

const IP_LIMIT = { limit: 1_200, windowSeconds: 60 };
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const USER_LIMIT = { limit: 240, windowSeconds: 60 };

export class LimiterModel {
  private windows = new Map<string, { count: number; resetAtMs: number }>();
  private key(scope: string, id: string, windowSeconds: number): string {
    return `rl:${scope}:${
      Math.floor(Date.now() / (windowSeconds * 1_000))
    }:${id}`;
  }
  incr(scope: string, id: string, windowSeconds: number): number {
    const key = this.key(scope, id, windowSeconds);
    const now = Date.now();
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > now) {
      existing.count += 1;
      return existing.count;
    }
    this.windows.set(key, { count: 1, resetAtMs: now + windowSeconds * 1_000 });
    return 1;
  }
  peek(scope: string, id: string, windowSeconds: number): number {
    const existing = this.windows.get(this.key(scope, id, windowSeconds));
    return existing && existing.resetAtMs > Date.now() ? existing.count : 0;
  }
}

/** The handler and the oracle both bucket on Date.now(); keep each iteration
 * clear of a bucket edge so the two cannot disagree by a clock tick. */
export async function awayFromWindowEdges(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const toMinute = 60_000 - (now % 60_000);
    const toFiveMinutes = 300_000 - (now % 300_000);
    if (toMinute > 60 && toFiveMinutes > 60) return;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
}

// ── Case generation ──────────────────────────────────────────────────────────

export type BodySpec =
  | { kind: "none" }
  | { kind: "text"; text: string; label: string }
  | { kind: "bytes"; bytes: Uint8Array; label: string }
  | {
    kind: "stream";
    prefix: string;
    suffix: string;
    fillBytes: number;
    failAfterBytes?: number;
    label: string;
  };

export interface TokenSpec {
  kind: string;
  /** authorization header value, or null for none */
  header: string | null;
  /** minted as a valid credential for this provider+subject */
  valid: boolean;
  provider: "google" | "apple" | null;
  user: number | null;
  /** append a second Authorization header with this value */
  duplicate?: string;
}

export interface FuzzCase {
  seed: number;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  token: TokenSpec;
  body: BodySpec;
  fault: Fault;
  requestId: { kind: string; value: string | null; wellFormed: boolean };
  appleProtocol: string | null;
  /** substrings ≥ 12 chars the client controls; an error body must not reflect them */
  clientStrings: string[];
  /** path-derived client strings: reflected by the 404 body by design (noted, not a violation) */
  pathStrings: string[];
  labels: string[];
}

const pick = <T>(rng: Prng, items: readonly T[]): T =>
  items[rng.int(0, items.length - 1)];
const chance = (rng: Prng, p: number): boolean => rng.next() < p;
const randomAscii = (rng: Prng, length: number): string => {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~!*'();:@&=+$,/?%#[]";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[rng.int(0, alphabet.length - 1)];
  }
  return out;
};
const randomHeaderSafe = (rng: Prng, length: number): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_.:;,/=+ \t";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[rng.int(0, alphabet.length - 1)];
  }
  return out;
};

const UNICODE_SAMPLES = [
  "日本語のテキスト",
  "🥒🎾🥒🎾",
  "\u202eevil\u202c",
  "\u0000nul",
  "a\u200bb\u200cc",
  "Ω≈ç√∫˜µ≤≥÷",
  "\ud83d\ude00",
  "\ufeffbom",
];

const now = () => Math.floor(Date.now() / 1000);

function genToken(rng: Prng, seed: number): TokenSpec {
  const provider = pick(rng, ["google", "apple"] as const);
  const user = rng.int(0, USERS - 1);
  const sub = fuzzSub(user);
  const jti = `jti-${seed.toString(16)}-${rng.int(0, 0xffff).toString(16)}`;
  const valid = (claims: Record<string, unknown> = {}) =>
    mintIdToken(provider, {
      sub,
      exp: now() + 3600,
      iat: now(),
      jti,
      ...claims,
    });
  const r = rng.next();
  // ~45% valid tokens so the deep (post-auth) paths get real coverage.
  if (r < 0.45) {
    const variant = rng.int(0, 6);
    if (variant === 0) {
      return {
        kind: "valid_padded",
        header: `Bearer    ${valid()}   `,
        valid: true,
        provider,
        user,
      };
    }
    if (variant === 2) {
      return {
        kind: "valid_huge_200kb",
        header: `Bearer ${valid({ pad: "p".repeat(200 * 1024) })}`,
        valid: true,
        provider,
        user,
      };
    }
    if (variant === 1) {
      return {
        kind: "valid_extra_claims",
        header: `Bearer ${
          valid({
            email: fuzzEmail(user),
            nonce: randomAscii(rng, 16),
            extra: { deep: [1, 2, { x: null }] },
          })
        }`,
        valid: true,
        provider,
        user,
      };
    }
    return {
      kind: "valid",
      header: `Bearer ${valid()}`,
      valid: true,
      provider,
      user,
    };
  }
  const invalid = (
    kind: string,
    header: string | null,
    duplicate?: string,
  ): TokenSpec => ({
    kind,
    header,
    valid: false,
    provider: null,
    user,
    duplicate,
  });
  const variants: Array<() => TokenSpec> = [
    () => invalid("absent", null),
    () => invalid("empty_bearer", "Bearer "),
    () => invalid("bearer_word_only", "Bearer"),
    () => invalid("lowercase_scheme", `bearer ${valid()}`),
    () => invalid("basic_scheme", `Basic ${btoa("user:pass")}`),
    () => invalid("no_scheme", valid()),
    () => invalid("no_space", `Bearer${valid()}`),
    () => invalid("expired", `Bearer ${valid({ exp: now() - 60 })}`),
    () => invalid("exp_zero", `Bearer ${valid({ exp: 0 })}`),
    () => invalid("exp_negative", `Bearer ${valid({ exp: -1 })}`),
    () =>
      invalid("exp_string", `Bearer ${valid({ exp: String(now() + 3600) })}`),
    () => invalid("exp_float_past", `Bearer ${valid({ exp: now() - 0.5 })}`),
    () => invalid("exp_huge", `Bearer ${valid({ exp: 1e18 })}`),
    () => invalid("exp_missing", `Bearer ${valid({ exp: undefined })}`),
    () => invalid("exp_null", `Bearer ${valid({ exp: null })}`),
    () => invalid("no_sub", `Bearer ${valid({ sub: undefined })}`),
    () => invalid("sub_empty", `Bearer ${valid({ sub: "" })}`),
    () => invalid("sub_number", `Bearer ${valid({ sub: 12345 })}`),
    () => invalid("sub_object", `Bearer ${valid({ sub: { id: sub } })}`),
    () => invalid("sub_unknown", `Bearer ${valid({ sub: "fz-user-99999" })}`),
    () =>
      invalid(
        "sub_other_user_format",
        `Bearer ${valid({ sub: fuzzUserId(user) })}`,
      ),
    () =>
      invalid("sub_huge", `Bearer ${valid({ sub: "s".repeat(64 * 1024) })}`),
    () =>
      invalid(
        "sub_unicode",
        `Bearer ${valid({ sub: pick(rng, UNICODE_SAMPLES) })}`,
      ),
    () => invalid("no_jti", `Bearer ${valid({ jti: undefined })}`),
    () =>
      invalid(
        "iss_http",
        `Bearer ${valid({ iss: "http://accounts.google.com" })}`,
      ),
    () =>
      invalid(
        "iss_no_scheme",
        `Bearer ${valid({ iss: "accounts.google.com" })}`,
      ),
    () =>
      invalid(
        "iss_trailing_slash",
        `Bearer ${valid({ iss: "https://accounts.google.com/" })}`,
      ),
    () =>
      invalid(
        "iss_uppercase",
        `Bearer ${valid({ iss: "https://ACCOUNTS.GOOGLE.COM" })}`,
      ),
    () =>
      invalid(
        "iss_subdomain_attack",
        `Bearer ${valid({ iss: "https://accounts.google.com.evil.test" })}`,
      ),
    () =>
      invalid(
        "iss_path_attack",
        `Bearer ${valid({ iss: "https://evil.test/accounts.google.com" })}`,
      ),
    () =>
      invalid(
        "iss_double_scheme",
        `Bearer ${valid({ iss: "https://https://accounts.google.com" })}`,
      ),
    () =>
      invalid(
        "iss_homoglyph",
        `Bearer ${valid({ iss: "https://accounts.g\u043eogle.com" })}`,
      ),
    () => invalid("iss_number", `Bearer ${valid({ iss: 42 })}`),
    () => invalid("iss_null", `Bearer ${valid({ iss: null })}`),
    () =>
      invalid(
        "iss_array",
        `Bearer ${valid({ iss: ["https://accounts.google.com"] })}`,
      ),
    () => invalid("iss_missing", `Bearer ${valid({ iss: undefined })}`),
    () =>
      invalid(
        "iss_supabase",
        `Bearer ${
          valid({ iss: `${SUPABASE_URL}/auth/v1`, role: "authenticated" })
        }`,
      ),
    () =>
      invalid(
        "two_segments",
        `Bearer ${valid().split(".").slice(0, 2).join(".")}`,
      ),
    () => invalid("four_segments", `Bearer ${valid()}.extra`),
    () => invalid("empty_payload", `Bearer ${valid().split(".")[0]}..sig`),
    () => invalid("empty_segments", "Bearer .."),
    () => invalid("dots_only", "Bearer ........"),
    () =>
      invalid(
        "payload_not_base64",
        `Bearer ${valid().split(".")[0]}.!!!not-base64!!!.sig`,
      ),
    () =>
      invalid(
        "payload_array",
        `Bearer h.${
          b64url(JSON.stringify(["https://accounts.google.com"]))
        }.sig`,
      ),
    () =>
      invalid(
        "payload_string",
        `Bearer h.${b64url(JSON.stringify("https://accounts.google.com"))}.sig`,
      ),
    () => invalid("payload_number", `Bearer h.${b64url("12345")}.sig`),
    () => invalid("payload_null", `Bearer h.${b64url("null")}.sig`),
    () => invalid("payload_true", `Bearer h.${b64url("true")}.sig`),
    () =>
      invalid(
        "payload_truncated_json",
        `Bearer h.${b64url('{"iss":"https://accounts.google.com"')}.sig`,
      ),
    () =>
      invalid(
        "payload_proto",
        `Bearer h.${
          b64url(
            `{"__proto__":{"iss":"https://accounts.google.com","exp":9999999999},"sub":"${sub}"}`,
          )
        }.sig`,
      ),
    () =>
      invalid("payload_utf8_bytes", `Bearer h.${b64url("\u00ff\u00fe{}")}.sig`),
    () =>
      invalid(
        "unsigned_alg_none",
        `Bearer ${
          mintIdToken(
            provider,
            { sub, exp: now() + 3600, jti },
            b64url(JSON.stringify({ alg: "none" })),
            "",
          )
        }`,
      ),
    () =>
      invalid(
        "wrong_signature_marker",
        `Bearer ${
          mintIdToken(
            provider,
            { sub, exp: now() + 3600, jti },
            undefined,
            "forged",
          )
        }`,
      ),
    () =>
      invalid("random_ascii", `Bearer ${randomAscii(rng, rng.int(1, 300))}`),
    () => invalid("tab_inside", `Bearer ${valid().replace(".", "\t.")}`),
    () => invalid("duplicate_header", `Bearer ${valid()}`, `Bearer ${valid()}`),
    () => invalid("valid_then_junk", `Bearer ${valid()} junk`),
    () =>
      invalid(
        "supabase_session_token",
        `Bearer session-for-${fuzzUserId(user)}.1`,
      ),
    () => invalid("service_role_key", `Bearer ${SERVICE_ROLE_KEY}`),
    () => invalid("anon_key", `Bearer ${ANON_KEY}`),
  ];
  return pick(rng, variants)();
}

function genRequestId(rng: Prng): FuzzCase["requestId"] {
  const r = rng.next();
  if (r < 0.35) return { kind: "absent", value: null, wellFormed: false };
  const variants: Array<() => FuzzCase["requestId"]> = [
    () => ({ kind: "uuid", value: rng.uuid(), wellFormed: true }),
    () => ({
      kind: "len8",
      value: randomAscii(rng, 8).replace(/[^A-Za-z0-9._-]/g, "a"),
      wellFormed: true,
    }),
    () => ({ kind: "len64", value: "x".repeat(64), wellFormed: true }),
    () => ({ kind: "len7", value: "abcdefg", wellFormed: false }),
    () => ({ kind: "len65", value: "x".repeat(65), wellFormed: false }),
    () => ({ kind: "len4096", value: "y".repeat(4096), wellFormed: false }),
    () => ({ kind: "space_inside", value: "abcd efgh", wellFormed: false }),
    () => ({ kind: "padded", value: "  padded-id-12  ", wellFormed: true }),
    () => ({ kind: "unicode", value: "идентификатор", wellFormed: false }),
    () => ({ kind: "slash", value: "a/b/c/d/e/f/g/h", wellFormed: false }),
    () => ({
      kind: "json_injection",
      value: '{"evt":"x"}12345',
      wellFormed: false,
    }),
    () => ({ kind: "quote", value: 'abc"def"ghi', wellFormed: false }),
    () => ({ kind: "empty", value: "", wellFormed: false }),
    () => ({ kind: "dots_dashes", value: "._-._-._-", wellFormed: true }),
  ];
  return pick(rng, variants)();
}

function genPath(
  rng: Prng,
  method: string,
): { path: string; bootstrap: boolean; label: string } {
  const r = rng.next();
  if (r < 0.7) {
    const mount = pick(rng, [
      "/functions/v1/api",
      "/api",
      "",
      "/v1",
      "/x/v1/y",
    ]);
    return {
      path: `${mount}/v1/account/bootstrap`,
      bootstrap: method === "POST",
      label: `mount${mount || "/"}`,
    };
  }
  if (r < 0.74) {
    return {
      path: "/functions/v1/api/v1/account/./bootstrap",
      bootstrap: method === "POST",
      label: "dot_segment",
    };
  }
  const variants: Array<[string, string]> = [
    ["/functions/v1/api/v1/account/bootstrap/", "trailing_slash"],
    ["/functions/v1/api/v1/account/Bootstrap", "uppercase"],
    ["/functions/v1/api/v1/account/%62ootstrap", "percent_encoded"],
    ["/functions/v1/api/v1/account/bootstrap%00", "encoded_nul"],
    ["/functions/v1/api/v1/account/bootstrap%2F", "encoded_slash"],
    ["/functions/v1/api/v1/account//bootstrap", "double_slash"],
    ["/functions/v1/api/v1/account/bootstrap/..", "dotdot"],
    ["/functions/v1/api/v1/account/bootstrap/extra", "extra_segment"],
    ["/functions/v1/api/v1/account/bootstrap;jsessionid=1", "semicolon"],
    ["/functions/v1/api/v1/account/bootstrap%20", "encoded_space"],
    ["/functions/v1/api/account/bootstrap", "no_v1"],
    ["/functions/v1/api/v2/account/bootstrap", "v2"],
    [
      "/functions/v1/api/v1/account/bootstrap" + "/" +
      randomAscii(rng, 8192).replace(/[?#%]/g, "z"),
      "long_suffix",
    ],
    [
      "/functions/v1/api/v1/account/bootstrap/" +
      encodeURIComponent(pick(rng, UNICODE_SAMPLES)),
      "unicode_suffix",
    ],
    ["/functions/v1/api/v1/account/bootstrap/%E2%80%AE", "encoded_bidi"],
    ["/functions/v1/api/v1/account/bootstrap/%ZZ", "bad_percent"],
    ["/functions/v1/api/v1/account/bootstrapx", "suffix_char"],
    ["/functions/v1/api/v1/account/bootstrap?", "bare_question_mark"],
  ];
  const [path, label] = pick(rng, variants);
  return { path, bootstrap: false, label };
}

function genQuery(rng: Prng): string {
  const r = rng.next();
  if (r < 0.6) return "";
  const variants: Array<() => string> = [
    () => `?${randomAscii(rng, rng.int(1, 40)).replace(/[#?]/g, "x")}`,
    () => `?appleAuthorizationCode=${validAppleCode(rng.int(0, USERS - 1))}`,
    () => `?q=${"a".repeat(16 * 1024)}`,
    () => "?a=1&a=2&a=3&a=4&a=5",
    () => `?u=${encodeURIComponent(pick(rng, UNICODE_SAMPLES))}`,
    () => "?%00=%00",
    () => "?",
    () => "?select=*&id=eq.00000000-0000-4000-8000-000000000000",
  ];
  return pick(rng, variants)();
}

function genBody(
  rng: Prng,
  token: TokenSpec,
  allowBody: boolean,
): { body: BodySpec; appleCode: string | null } {
  if (!allowBody) return { body: { kind: "none" }, appleCode: null };
  const user = token.user ?? rng.int(0, USERS - 1);
  const r = rng.next();
  if (r < 0.08) return { body: { kind: "none" }, appleCode: null };
  const text = (label: string, value: string): BodySpec => ({
    kind: "text",
    text: value,
    label,
  });
  const withCode = (
    label: string,
    code: unknown,
    extra: Record<string, unknown> = {},
  ): { body: BodySpec; appleCode: string | null } => ({
    body: text(
      label,
      JSON.stringify({ appleAuthorizationCode: code, ...extra }),
    ),
    appleCode: typeof code === "string" ? code : null,
  });
  const variants: Array<() => { body: BodySpec; appleCode: string | null }> = [
    () => withCode("code_matching", validAppleCode(user)),
    () => withCode("code_matching", validAppleCode(user)),
    () => withCode("code_matching", validAppleCode(user)),
    () => withCode("code_matching_padded_ws", `  ${validAppleCode(user)}\n`),
    () =>
      withCode(
        "code_matching_len4096",
        validAppleCode(user, APPLE_CODE_MAX_LENGTH),
      ),
    () =>
      withCode(
        "code_matching_len4095",
        validAppleCode(user, APPLE_CODE_MAX_LENGTH - 1),
      ),
    () =>
      withCode(
        "code_matching_len4097",
        validAppleCode(user, APPLE_CODE_MAX_LENGTH + 1),
      ),
    () =>
      withCode(
        "code_matching_len4096_plus_space",
        `${validAppleCode(user, APPLE_CODE_MAX_LENGTH)} `,
      ),
    () =>
      withCode(
        "code_other_user",
        validAppleCode((user + 1 + rng.int(0, USERS - 2)) % USERS),
      ),
    () => withCode("code_unknown", randomAscii(rng, rng.int(1, 200))),
    () => withCode("code_empty", ""),
    () => withCode("code_whitespace", pick(rng, [" ", "\t", "\n", "   \t\n"])),
    () => withCode("code_one_char", "x"),
    () => withCode("code_len4096_junk", "j".repeat(APPLE_CODE_MAX_LENGTH)),
    () => withCode("code_len4097_junk", "j".repeat(APPLE_CODE_MAX_LENGTH + 1)),
    () => withCode("code_len100k", "k".repeat(100_000)),
    () => withCode("code_emoji_2048", "😀".repeat(2048)),
    () => withCode("code_emoji_2049", "😀".repeat(2049)),
    () => withCode("code_unicode", pick(rng, UNICODE_SAMPLES)),
    () => withCode("code_nul_inside", `apple-code-for:${fuzzSub(user)}\u0000`),
    () =>
      withCode(
        "code_newline_inside",
        `apple-code-for:${fuzzSub(user)}\r\nX-Injected: 1`,
      ),
    () =>
      withCode(
        "code_form_injection",
        `${validAppleCode(user)}&grant_type=refresh_token&client_secret=x`,
      ),
    () => withCode("code_lone_surrogate", "\ud800abc"),
    () => withCode("code_number", 12345),
    () => withCode("code_null", null),
    () => withCode("code_true", true),
    () => withCode("code_array", [validAppleCode(user)]),
    () => withCode("code_object", { code: validAppleCode(user) }),
    () =>
      withCode("code_with_extras", validAppleCode(user), {
        extra: "x".repeat(1000),
        nested: { a: [1, 2, 3] },
      }),
    () => ({
      body: text(
        "key_case_upper",
        JSON.stringify({ AppleAuthorizationCode: validAppleCode(user) }),
      ),
      appleCode: null,
    }),
    () => ({
      body: text(
        "key_trailing_space",
        JSON.stringify({ "appleAuthorizationCode ": validAppleCode(user) }),
      ),
      appleCode: null,
    }),
    () => ({
      body: text(
        "key_proto",
        `{"__proto__":{"appleAuthorizationCode":"${validAppleCode(user)}"}}`,
      ),
      appleCode: null,
    }),
    () => ({
      body: text(
        "key_constructor",
        `{"constructor":{"prototype":{"appleAuthorizationCode":"x"}}}`,
      ),
      appleCode: null,
    }),
    () => ({
      body: text(
        "duplicate_keys",
        `{"appleAuthorizationCode":"first","appleAuthorizationCode":"${
          validAppleCode(user)
        }"}`,
      ),
      appleCode: validAppleCode(user),
    }),
    () => ({ body: text("empty_object", "{}"), appleCode: null }),
    () => ({ body: text("empty_string", ""), appleCode: null }),
    () => ({ body: text("whitespace", "   \n\t "), appleCode: null }),
    () => ({ body: text("json_null", "null"), appleCode: null }),
    () => ({
      body: text("json_array", `["${validAppleCode(user)}"]`),
      appleCode: null,
    }),
    () => ({
      body: text("json_string", `"${validAppleCode(user)}"`),
      appleCode: null,
    }),
    () => ({ body: text("json_number", "1e309"), appleCode: null }),
    () => ({ body: text("json_true", "true"), appleCode: null }),
    () => ({ body: text("malformed_open", "{"), appleCode: null }),
    () => ({
      body: text("malformed_trailing_comma", '{"appleAuthorizationCode":"x",}'),
      appleCode: null,
    }),
    () => ({
      body: text("malformed_single_quotes", "{'appleAuthorizationCode':'x'}"),
      appleCode: null,
    }),
    () => ({
      body: text("malformed_nan", '{"appleAuthorizationCode":NaN}'),
      appleCode: null,
    }),
    () => ({
      body: text(
        "malformed_trailing_garbage",
        '{"appleAuthorizationCode":"x"} trailing',
      ),
      appleCode: null,
    }),
    () => ({
      body: text(
        "bom_prefix",
        `\ufeff${
          JSON.stringify({ appleAuthorizationCode: validAppleCode(user) })
        }`,
      ),
      appleCode: null,
    }),
    () => ({
      body: text(
        "form_encoded",
        `appleAuthorizationCode=${validAppleCode(user)}`,
      ),
      appleCode: null,
    }),
    () => ({
      body: text("html", "<html><script>alert(1)</script></html>"),
      appleCode: null,
    }),
    () => ({
      body: text(
        "many_keys_10k",
        `{${
          Array.from({ length: 10_000 }, (_, i) => `"k${i}":${i}`).join(",")
        }}`,
      ),
      appleCode: null,
    }),
    () => ({
      body: text("deep_nesting_5k", `${"[".repeat(5_000)}${"]".repeat(5_000)}`),
      appleCode: null,
    }),
    () => ({
      body: text(
        "deep_nesting_100k",
        `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`,
      ),
      appleCode: null,
    }),
    () => ({
      body: text(
        "long_string_1mb",
        JSON.stringify({ pad: "p".repeat(1_000_000) }),
      ),
      appleCode: null,
    }),
    () => ({
      body: {
        kind: "bytes",
        bytes: Uint8Array.from(
          { length: rng.int(1, 4096) },
          () => rng.int(0, 255),
        ),
        label: "random_bytes",
      },
      appleCode: null,
    }),
    () => ({
      body: {
        kind: "bytes",
        bytes: new Uint8Array([
          0xff,
          0xfe,
          0x7b,
          0x22,
          0x61,
          0x22,
          0x3a,
          0x31,
          0x7d,
        ]),
        label: "invalid_utf8_then_json",
      },
      appleCode: null,
    }),
    () => {
      // Streamed (no Content-Length) body of exactly the cap: still valid JSON.
      const code = validAppleCode(user);
      const prefix = `{"appleAuthorizationCode":"${code}","pad":"`;
      const suffix = `"}`;
      return {
        body: {
          kind: "stream",
          prefix,
          suffix,
          fillBytes: MAX_JSON_BODY_BYTES - prefix.length - suffix.length,
          label: "stream_exactly_cap",
        },
        appleCode: code,
      };
    },
    () => {
      const code = validAppleCode(user);
      const prefix = `{"appleAuthorizationCode":"${code}","pad":"`;
      const suffix = `"}`;
      return {
        body: {
          kind: "stream",
          prefix,
          suffix,
          fillBytes: MAX_JSON_BODY_BYTES - prefix.length - suffix.length + 1,
          label: "stream_cap_plus_one",
        },
        appleCode: code,
      };
    },
    () => ({
      body: {
        kind: "stream",
        prefix: "{",
        suffix: "}",
        fillBytes: 8 * 1024 * 1024,
        label: "stream_8mb",
      },
      appleCode: null,
    }),
    () => ({
      body: {
        kind: "stream",
        prefix: `{"appleAuthorizationCode":"${validAppleCode(user)}"`,
        suffix: "}",
        fillBytes: 200_000,
        failAfterBytes: 100_000,
        label: "stream_errors_midway",
      },
      appleCode: null,
    }),
  ];
  return pick(rng, variants)();
}

/** Deterministically build the case for `seed`. */
export function generateCase(seed: number): FuzzCase {
  const rng = new Prng(seed);
  const labels: string[] = [];
  const clientStrings: string[] = [];
  const pathStrings: string[] = [];

  const methodRoll = rng.next();
  const method = methodRoll < 0.8
    ? "POST"
    : methodRoll < 0.84
    ? "post"
    : pick(rng, [
      "GET",
      "HEAD",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "PROPFIND",
      "patch",
      "Post",
    ]);
  const normalizedMethod = /^(post|get|head|put|delete|options)$/i.test(method)
    ? method.toUpperCase()
    : method;
  const bodyAllowed = normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
  labels.push(`method:${method}`);

  const pathInfo = genPath(rng, normalizedMethod);
  labels.push(`path:${pathInfo.label}`);
  const query = genQuery(rng);
  if (query.length > 12) clientStrings.push(query.slice(1));
  if (pathInfo.label === "long_suffix" || pathInfo.label === "unicode_suffix") {
    pathStrings.push(pathInfo.path.slice(pathInfo.path.lastIndexOf("/") + 1));
  }
  const url = `https://edge.fuzz.test${pathInfo.path}${query}`;

  const token = genToken(rng, seed);
  labels.push(`token:${token.kind}`);

  const fault: Fault = chance(rng, 0.14) ? pick(rng, FAULTS.slice(1)) : "none";
  labels.push(`fault:${fault}`);

  const { body, appleCode } = genBody(rng, token, bodyAllowed);
  labels.push(`body:${body.kind === "none" ? "none" : body.label}`);
  if (appleCode && appleCode.length >= 12) clientStrings.push(appleCode);

  const headers: Array<[string, string]> = [];
  if (token.header !== null) headers.push(["Authorization", token.header]);
  if (token.duplicate) headers.push(["Authorization", token.duplicate]);

  const requestId = genRequestId(rng);
  labels.push(`rid:${requestId.kind}`);
  if (requestId.value !== null) headers.push(["x-request-id", requestId.value]);
  if (requestId.value && requestId.value.length >= 12) {
    clientStrings.push(requestId.value.trim());
  }

  // Client IP: a small pool (so the per-IP budgets are genuinely reached),
  // sometimes multi-hop, sometimes cf-connecting-ip, sometimes nothing.
  const ipRoll = rng.next();
  const poolIp = `10.77.${rng.int(0, 1)}.${rng.int(1, IP_POOL)}`;
  if (ipRoll < 0.7) headers.push(["x-forwarded-for", poolIp]);
  else if (ipRoll < 0.8) {
    headers.push([
      "x-forwarded-for",
      `${
        randomAscii(rng, 12).replace(/[^a-z0-9]/g, "1")
      }, 203.0.113.9, ${poolIp}`,
    ]);
  } else if (ipRoll < 0.88) {
    headers.push(["cf-connecting-ip", poolIp], [
      "x-forwarded-for",
      "198.51.100.1",
    ]);
  } else if (ipRoll < 0.93) {
    headers.push(["x-forwarded-for", pick(rng, ["", " , , ", ",", "   "])]);
  } else if (ipRoll < 0.97) {
    /* no ip header at all → "unknown" */
  } else {headers.push([
      "x-forwarded-for",
      `2001:db8::${rng.int(0, 0xffff).toString(16)}`,
    ]);}

  // Apple revocation-protocol header.
  const protoRoll = rng.next();
  const appleProtocol = protoRoll < 0.45
    ? null
    : protoRoll < 0.8
    ? "1"
    : pick(rng, ["0", "true", "01", "1 ", " 1", "2", "yes", "1,1", ""]);
  if (appleProtocol !== null) {
    headers.push(["X-Apple-Revocation-Protocol", appleProtocol]);
  }
  labels.push(
    `proto:${
      appleProtocol === null ? "absent" : JSON.stringify(appleProtocol)
    }`,
  );

  // Content-Type / Content-Length / assorted junk.
  const ctRoll = rng.next();
  if (ctRoll < 0.5) headers.push(["content-type", "application/json"]);
  else if (ctRoll < 0.6) {
    headers.push([
      "content-type",
      pick(rng, [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
        "application/json; charset=utf-16",
        "image/png",
        "",
      ]),
    ]);
  }
  const clRoll = rng.next();
  let declaredLength: string | null = null;
  if (clRoll < 0.06) declaredLength = String(MAX_JSON_BODY_BYTES + 1);
  else if (clRoll < 0.09) declaredLength = String(MAX_JSON_BODY_BYTES);
  else if (clRoll < 0.14) {
    declaredLength = pick(rng, [
      "1e7",
      "0x4C4B41",
      " 5000001",
      "-1",
      "abc",
      "Infinity",
      "NaN",
      "5000000.5",
      "1,000",
      "٥٠٠٠٠٠١",
    ]);
  }
  if (declaredLength !== null) {
    headers.push(["content-length", declaredLength]);
    labels.push(`cl:${JSON.stringify(declaredLength)}`);
  }
  if (chance(rng, 0.2)) {
    const junkName = pick(rng, [
      "X-Fuzz",
      "Cookie",
      "Origin",
      "Referer",
      "Transfer-Encoding",
      "Host",
      "Accept",
      "apikey",
      "X-Client-Info",
      "Forwarded",
      "Via",
    ]);
    const junkValue = randomHeaderSafe(rng, rng.int(0, 300)).trim() || "x";
    headers.push([junkName, junkValue]);
    if (junkValue.length >= 12) clientStrings.push(junkValue);
  }

  return {
    seed,
    method,
    url,
    headers,
    token,
    body,
    fault,
    requestId,
    appleProtocol,
    clientStrings,
    pathStrings,
    labels,
  };
}

/** Case seed for iteration `i` of a campaign — a fixed mix so the whole
 * campaign is a function of one number. */
export function caseSeed(campaignSeed: number, iteration: number): number {
  let x = (campaignSeed ^ Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function streamBody(
  spec: Extract<BodySpec, { kind: "stream" }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunk = new Uint8Array(64 * 1024).fill(0x78);
  let sent = 0;
  let started = false;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(spec.prefix));
        return;
      }
      if (spec.failAfterBytes !== undefined && sent >= spec.failAfterBytes) {
        controller.error(new Error("fuzz: simulated body read failure"));
        return;
      }
      if (sent < spec.fillBytes) {
        const remaining = spec.fillBytes - sent;
        const piece = remaining >= chunk.length
          ? chunk
          : chunk.subarray(0, remaining);
        controller.enqueue(piece);
        sent += piece.length;
        return;
      }
      if (!finished) {
        finished = true;
        controller.enqueue(encoder.encode(spec.suffix));
        controller.close();
      }
    },
  });
}

/** Build the Request. Returns the TypeError when the platform refuses the
 * shape (header injection, body on GET, forbidden method). */
export function buildRequest(c: FuzzCase): Request | TypeError {
  try {
    const headers = new Headers();
    for (const [name, value] of c.headers) headers.append(name, value);
    let body: BodyInit | null = null;
    if (c.body.kind === "text") body = c.body.text;
    else if (c.body.kind === "bytes") body = new Uint8Array(c.body.bytes);
    else if (c.body.kind === "stream") body = streamBody(c.body);
    return new Request(c.url, { method: c.method, headers, body });
  } catch (error) {
    if (error instanceof TypeError) return error;
    throw error;
  }
}

// ── Oracle ───────────────────────────────────────────────────────────────────

export type ExpectedWrites =
  | "none"
  | "provider_patch"
  | "credentials"
  | "provider_patch+credentials";

export interface Prediction {
  status: number;
  code: string | null;
  /** writes the route is expected to perform on this path */
  writes: ExpectedWrites;
  /** the request authenticates: a Supabase session is minted */
  mintsSession: boolean;
  isBootstrap: boolean;
  userId: string | null;
  reason: string;
}

function routeOf(request: Request): { route: string; isBootstrap: boolean } {
  const pathname = new URL(request.url).pathname;
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  const route = `${request.method} ${path}`;
  return { route, isBootstrap: route === "POST /v1/account/bootstrap" };
}

function clientIpOf(request: Request): string {
  const edgeIp = request.headers.get("cf-connecting-ip")?.trim();
  if (edgeIp) return edgeIp;
  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}

function bodyTextOf(c: FuzzCase): string | "too_large" | "unreadable" {
  switch (c.body.kind) {
    case "none":
      return "";
    case "text":
      return c.body.text;
    case "bytes":
      return new TextDecoder().decode(c.body.bytes);
    case "stream": {
      if (c.body.failAfterBytes !== undefined) return "unreadable";
      const total = c.body.prefix.length + c.body.fillBytes +
        c.body.suffix.length;
      if (total > MAX_JSON_BODY_BYTES) return "too_large";
      return `${c.body.prefix}${"x".repeat(c.body.fillBytes)}${c.body.suffix}`;
    }
  }
}

/** What the SPEC says must happen, given the generated case and the limiter
 * model. Mutates the model exactly as the handler would. */
export function predict(
  c: FuzzCase,
  request: Request,
  model: LimiterModel,
): Prediction {
  const ip = clientIpOf(request);
  const { isBootstrap } = routeOf(request);
  const base = {
    isBootstrap,
    userId: null as string | null,
    mintsSession: false,
    writes: "none" as ExpectedWrites,
  };

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    return {
      ...base,
      status: 413,
      code: null,
      reason: "declared content-length over cap",
    };
  }
  if (model.incr("ip", ip, IP_LIMIT.windowSeconds) > IP_LIMIT.limit) {
    return {
      ...base,
      status: 429,
      code: "rate_limited",
      reason: "per-ip budget",
    };
  }
  if (
    model.peek("authfail", ip, AUTH_FAILURE_LIMIT.windowSeconds) >=
      AUTH_FAILURE_LIMIT.limit
  ) {
    return {
      ...base,
      status: 429,
      code: "rate_limited",
      reason: "auth-failure budget",
    };
  }

  const gotrueDown = c.fault.startsWith("gotrue_");
  if (!c.token.valid || gotrueDown) {
    model.incr("authfail", ip, AUTH_FAILURE_LIMIT.windowSeconds);
    return {
      ...base,
      status: 401,
      code: null,
      reason: gotrueDown
        ? "auth upstream failed → 401"
        : `token ${c.token.kind}`,
    };
  }
  const userId = fuzzUserId(c.token.user!);
  const authed = { ...base, userId, mintsSession: true };
  if (model.incr("user", userId, USER_LIMIT.windowSeconds) > USER_LIMIT.limit) {
    return {
      ...authed,
      status: 429,
      code: "rate_limited",
      reason: "per-user budget",
    };
  }
  if (!isBootstrap) {
    return {
      ...authed,
      status: 404,
      code: null,
      reason: "authenticated, unknown route",
    };
  }
  if (c.fault.startsWith("profile_")) {
    return {
      ...authed,
      status: 503,
      code: null,
      reason: `profile read fault ${c.fault}`,
    };
  }
  const patch = profileProvider(c.token.user!) !== c.token.provider;
  const writesSoFar: ExpectedWrites = patch ? "provider_patch" : "none";
  const withPatch = (w: "credentials" | "none"): ExpectedWrites =>
    patch
      ? (w === "credentials" ? "provider_patch+credentials" : "provider_patch")
      : w;

  if (c.token.provider === "google") {
    return {
      ...authed,
      status: 200,
      code: null,
      writes: writesSoFar,
      reason: "google bootstrap",
    };
  }

  const text = bodyTextOf(c);
  if (text === "too_large") {
    return {
      ...authed,
      status: 413,
      code: null,
      writes: writesSoFar,
      reason: "streamed body over cap",
    };
  }
  let parsed: unknown = {};
  if (text !== "unreadable") {
    try {
      // readBody() decodes with TextDecoder (BOM stripped) then JSON.parse.
      const value = JSON.parse(text.replace(/^\ufeff/, "")) as unknown;
      parsed = isRecord(value) ? value : {};
    } catch {
      parsed = {};
    }
  }
  const code = (parsed as Record<string, unknown>).appleAuthorizationCode;
  const usable = typeof code === "string" && Boolean(code.trim()) &&
    code.length <= APPLE_CODE_MAX_LENGTH;
  if (!usable) {
    if (request.headers.get("X-Apple-Revocation-Protocol") === "1") {
      return {
        ...authed,
        status: 400,
        code: "auth.apple_authorization_code_required",
        writes: writesSoFar,
        reason: "protocol client without usable code",
      };
    }
    return {
      ...authed,
      status: 200,
      code: null,
      writes: writesSoFar,
      reason: "legacy apple bootstrap (no code)",
    };
  }
  const trimmed = (code as string).trim();
  switch (c.fault) {
    case "apple_500":
    case "apple_throw":
    case "apple_incomplete":
    case "apple_garbage":
      return {
        ...authed,
        status: 503,
        code: null,
        writes: writesSoFar,
        reason: `apple fault ${c.fault}`,
      };
    case "apple_invalid_grant":
      return {
        ...authed,
        status: 401,
        code: "auth.apple_authorization_invalid",
        writes: writesSoFar,
        reason: "apple invalid_grant",
      };
  }
  const m = APPLE_CODE_RE.exec(trimmed);
  if (!m) {
    return {
      ...authed,
      status: 401,
      code: "auth.apple_authorization_invalid",
      writes: writesSoFar,
      reason: "unknown apple code",
    };
  }
  if (m[1] !== fuzzSub(c.token.user!)) {
    return {
      ...authed,
      status: 401,
      code: "auth.apple_authorization_mismatch",
      writes: writesSoFar,
      reason: "apple code for another subject",
    };
  }
  if (c.fault === "upsert_500" || c.fault === "upsert_throw") {
    return {
      ...authed,
      status: 503,
      code: null,
      writes: writesSoFar,
      reason: `credential store fault ${c.fault}`,
    };
  }
  return {
    ...authed,
    status: 200,
    code: null,
    writes: withPatch("credentials"),
    reason: "apple bootstrap with revocation credential",
  };
}

// ── Judge ────────────────────────────────────────────────────────────────────

export const ALLOWED_REJECTION_STATUSES = new Set([
  400,
  401,
  403,
  404,
  405,
  413,
  415,
  429,
]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["secret_marker", new RegExp(SECRET_MARKER)],
  ["stack_frame", /\bat\s+\S+\s+\(?[\w./:-]+:\d+:\d+\)?/],
  [
    "error_class",
    /\b(TypeError|RangeError|SyntaxError|ReferenceError|AuthApiError|PostgrestError)\b/,
  ],
  ["source_path", /(index|http|cache|rateLimit|externalAccounts)\.ts/],
  ["postgrest_code", /PGRST\d+/],
  ["pg_sqlstate", /\b(42501|XX000|23505|22P02)\b/],
  ["supabase_internals", /\b(supabase|postgrest|gotrue|upstash|revenuecat)\b/i],
  ["anon_key", new RegExp(ANON_KEY)],
  ["service_role_key", new RegExp(SERVICE_ROLE_KEY)],
  ["apple_rt_plaintext", new RegExp(APPLE_RT_PLAINTEXT_MARKER)],
  ["private_key", /BEGIN PRIVATE KEY/],
  [
    "internal_url",
    new RegExp(SUPABASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ],
];

export interface Violation {
  code: string;
  detail: string;
}

export interface Outcome {
  iteration: number;
  seed: number;
  labels: string[];
  method: string;
  url: string;
  fault: Fault;
  constructed: boolean;
  constructError?: string;
  expected?: {
    status: number;
    code: string | null;
    writes: ExpectedWrites;
    reason: string;
  };
  status?: number;
  code?: string | null;
  requestId?: string | null;
  writes?: {
    profiles_patch: number;
    account_external_credentials_post: number;
    other: number;
  };
  sessionsMinted?: number;
  appleExchanges?: number;
  upstreamCalls?: number;
  durationMs?: number;
  /** soft observations: spec-conformant but worth reporting */
  notes: string[];
  violations: Violation[];
  replay: string;
}

export interface ExecutedCase {
  outcome: Outcome;
  responseBody: string;
}

export async function executeCase(
  booted: BootedHandler,
  c: FuzzCase,
  iteration: number,
  model: LimiterModel,
): Promise<ExecutedCase> {
  const replay =
    `STRESS_REPLAY_SEED=${c.seed} deno test -A --no-check --config deno.json --filter "replay one seed" stress_route_post_v1_account_bootstrap_fuzz_boundary.test.ts`;
  const outcome: Outcome = {
    iteration,
    seed: c.seed,
    labels: c.labels,
    method: c.method,
    url: c.url.length > 200
      ? `${c.url.slice(0, 200)}…(${c.url.length} chars)`
      : c.url,
    fault: c.fault,
    constructed: false,
    notes: [],
    violations: [],
    replay,
  };
  const built = buildRequest(c);
  if (built instanceof TypeError) {
    outcome.constructError = built.message;
    return { outcome, responseBody: "" };
  }
  outcome.constructed = true;
  const request = built;

  booted.upstream.reset(c.fault);
  booted.drainAccessLog();
  booted.drainConsole();
  await awayFromWindowEdges();
  const expected = predict(c, request, model);
  outcome.expected = {
    status: expected.status,
    code: expected.code,
    writes: expected.writes,
    reason: expected.reason,
  };

  const startedAt = performance.now();
  let response: Response;
  let bodyText = "";
  try {
    response = await booted.handler(request);
    bodyText = await response.text();
  } catch (error) {
    outcome.violations.push({
      code: "HANDLER_THREW",
      detail: error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    });
    outcome.durationMs = Math.round(performance.now() - startedAt);
    return { outcome, responseBody: "" };
  }
  outcome.durationMs = Math.round(performance.now() - startedAt);
  const status = response.status;
  outcome.status = status;
  const v = outcome.violations;
  const upstream = booted.upstream;
  const writes = upstream.writes();
  outcome.writes = {
    profiles_patch:
      writes.filter((w) => w.table === "profiles" && w.method === "PATCH")
        .length,
    account_external_credentials_post: writes.filter(
      (w) => w.table === "account_external_credentials" && w.method === "POST",
    ).length,
    other: writes.filter(
      (w) =>
        !(w.table === "profiles" && w.method === "PATCH") &&
        !(w.table === "account_external_credentials" && w.method === "POST"),
    ).length,
  };
  outcome.sessionsMinted = upstream.sessionsMinted;
  outcome.appleExchanges = upstream.appleExchanges;
  outcome.upstreamCalls = upstream.calls.length;

  // ── status class ──
  const isJson = (response.headers.get("content-type") ?? "").startsWith(
    "application/json",
  );
  let parsed: unknown = null;
  try {
    parsed = bodyText === "" ? null : JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const errorObj = isRecord(parsed) && isRecord(parsed.error)
    ? parsed.error
    : null;
  const code = errorObj && typeof errorObj.code === "string"
    ? errorObj.code
    : null;
  outcome.code = code;

  if (status >= 500) {
    if (c.fault === "none") {
      v.push({
        code: "UNEXPECTED_5XX",
        detail: `${status} without an injected fault`,
      });
    }
    if (status !== 503) v.push({ code: "NON_503_5XX", detail: `${status}` });
  } else if (status !== 200 && !ALLOWED_REJECTION_STATUSES.has(status)) {
    v.push({ code: "STATUS_NOT_ALLOWED", detail: `${status}` });
  }
  if (status !== expected.status) {
    v.push({
      code: "STATUS_MISMATCH",
      detail: `expected ${expected.status} (${expected.reason}), got ${status}`,
    });
  } else if (expected.code !== null && code !== expected.code) {
    v.push({
      code: "CODE_MISMATCH",
      detail: `expected error.code ${expected.code}, got ${code}`,
    });
  }
  if (upstream.unexpected.length > 0) {
    v.push({
      code: "UNEXPECTED_UPSTREAM",
      detail: upstream.unexpected.map((u) => `${u.method} ${u.url}`).join("; "),
    });
  }

  // ── request id ──
  const rid = response.headers.get("x-request-id");
  outcome.requestId = rid;
  if (!rid) {
    v.push({
      code: "MISSING_REQUEST_ID",
      detail: "no x-request-id response header",
    });
  } else {
    const sent = c.requestId.value?.trim() ?? "";
    if (c.requestId.wellFormed) {
      if (rid !== sent) {
        v.push({
          code: "REQUEST_ID_NOT_ECHOED",
          detail: `sent ${JSON.stringify(sent)}, got ${JSON.stringify(rid)}`,
        });
      }
    } else {
      if (!UUID_RE.test(rid)) {
        v.push({ code: "REQUEST_ID_NOT_UUID", detail: rid.slice(0, 80) });
      }
      if (sent && rid === sent) {
        v.push({
          code: "REQUEST_ID_ECHOED_INVALID",
          detail: sent.slice(0, 80),
        });
      }
    }
    if (!REQUEST_ID_RE.test(rid)) {
      v.push({ code: "REQUEST_ID_MALFORMED", detail: rid.slice(0, 80) });
    }
  }

  // ── headers ──
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    v.push({ code: "MISSING_NOSNIFF", detail: "" });
  }
  if (!(response.headers.get("cache-control") ?? "").includes("no-store")) {
    v.push({ code: "MISSING_NO_STORE", detail: "" });
  }
  if (!isJson && request.method !== "HEAD") {
    v.push({
      code: "NOT_JSON",
      detail: response.headers.get("content-type") ?? "<none>",
    });
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (!Number.isInteger(retryAfter) || retryAfter < 1) {
      v.push({
        code: "RATE_LIMIT_HEADERS",
        detail: `Retry-After=${response.headers.get("retry-after")}`,
      });
    }
  }

  // ── body ──
  if (request.method !== "HEAD") {
    if (parsed === undefined) {
      v.push({ code: "BODY_NOT_JSON", detail: bodyText.slice(0, 120) });
    }
    if (status !== 200) {
      if (
        !errorObj || typeof errorObj.message !== "string" || !errorObj.message
      ) {
        v.push({ code: "ERROR_SHAPE", detail: bodyText.slice(0, 120) });
      }
      const reflectedPath = c.pathStrings.find((s) => bodyText.includes(s));
      if (reflectedPath !== undefined) {
        outcome.notes.push(
          `${status} body reflects the request path (${bodyText.length} bytes)`,
        );
      }
      if (bodyText.length > 2_048 && reflectedPath === undefined) {
        v.push({
          code: "ERROR_BODY_TOO_LARGE",
          detail: `${bodyText.length} bytes`,
        });
      }
      for (const s of c.clientStrings) {
        if (s.length >= 12 && bodyText.includes(s)) {
          v.push({ code: "REFLECTED_INPUT", detail: s.slice(0, 60) });
          break;
        }
      }
    }
    for (const [name, re] of LEAK_PATTERNS) {
      if (re.test(bodyText)) {
        v.push({
          code: "LEAK",
          detail: `${name} in body: ${bodyText.slice(0, 160)}`,
        });
      }
    }
    if (
      c.token.header && c.token.header.length > 40 &&
      bodyText.includes(c.token.header.slice(7, 47))
    ) {
      v.push({ code: "LEAK", detail: "bearer token reflected in body" });
    }
  }

  // ── success shape ──
  if (status === 200) {
    if (!isRecord(parsed)) {
      v.push({ code: "SUCCESS_SHAPE", detail: "body not an object" });
    } else {
      const keys = Object.keys(parsed).sort().join(",");
      if (keys !== "onboardingState,session,user") {
        v.push({ code: "SUCCESS_SHAPE", detail: `keys ${keys}` });
      }
      const user = isRecord(parsed.user) ? parsed.user : null;
      const session = isRecord(parsed.session) ? parsed.session : null;
      if (!user || user.id !== expected.userId) {
        v.push({
          code: "SUCCESS_SHAPE",
          detail: `user.id ${String(user?.id)} ≠ ${expected.userId}`,
        });
      }
      if (user && Object.keys(user).sort().join(",") !== "email,id") {
        v.push({
          code: "SUCCESS_SHAPE",
          detail: `user keys ${Object.keys(user).join(",")}`,
        });
      }
      if (
        parsed.onboardingState !== "complete" &&
        parsed.onboardingState !== "pending"
      ) {
        v.push({
          code: "SUCCESS_SHAPE",
          detail: `onboardingState ${String(parsed.onboardingState)}`,
        });
      }
      if (
        !session ||
        typeof session.accessToken !== "string" ||
        typeof session.refreshToken !== "string" ||
        typeof session.expiresAt !== "number" ||
        Object.keys(session).sort().join(",") !==
          "accessToken,expiresAt,refreshToken"
      ) {
        v.push({
          code: "SUCCESS_SHAPE",
          detail: `session ${JSON.stringify(session).slice(0, 120)}`,
        });
      }
    }
  }

  // ── writes ──
  const w = outcome.writes;
  const expectPatch = expected.writes === "provider_patch" ||
    expected.writes === "provider_patch+credentials";
  const expectCreds = expected.writes === "credentials" ||
    expected.writes === "provider_patch+credentials";
  if (w.other > 0) {
    v.push({
      code: "WRITE_UNEXPECTED",
      detail: writes.filter((x) =>
        !(x.table === "profiles" && x.method === "PATCH") &&
        !(x.table === "account_external_credentials")
      ).map((x) => `${x.method} ${x.table}`).join(";"),
    });
  }
  if (status >= 400) {
    if (w.account_external_credentials_post > 0) {
      v.push({
        code: "WRITE_ON_REJECTION",
        detail:
          `${w.account_external_credentials_post} credential upsert(s) on ${status}`,
      });
    }
    if (w.profiles_patch > 0) {
      outcome.notes.push(
        `identity-correcting profiles.provider PATCH executed before a ${status} rejection`,
      );
    }
    if (upstream.sessionsMinted > 0) {
      outcome.notes.push(
        `${upstream.sessionsMinted} Supabase session(s) minted, response ${status} discards them`,
      );
    }
  }
  if (status === expected.status) {
    if (expectCreds && w.account_external_credentials_post !== 1) {
      v.push({
        code: "WRITE_MISSING",
        detail:
          `expected 1 credential upsert, saw ${w.account_external_credentials_post}`,
      });
    }
    if (
      !expectCreds && w.account_external_credentials_post > 0 && status < 400
    ) {
      v.push({
        code: "WRITE_UNEXPECTED",
        detail: "credential upsert not predicted",
      });
    }
    if (c.fault === "patch_500" && expectPatch) {
      // The route ignores the PATCH result: a refused provider correction
      // leaves the row stale and the bootstrap still succeeds.
      outcome.notes.push(
        `profiles.provider PATCH refused (500) and ignored; response ${status}`,
      );
    } else if (
      expectPatch && w.profiles_patch !== 1 && status !== 429 && status !== 413
    ) {
      // 413/429 can precede the read on the streamed path; otherwise the patch precedes every later outcome.
      if (!(expected.reason.startsWith("streamed"))) {
        v.push({
          code: "WRITE_MISSING",
          detail: `expected provider PATCH, saw ${w.profiles_patch}`,
        });
      }
    }
    if (!expectPatch && w.profiles_patch > 0) {
      v.push({
        code: "WRITE_UNEXPECTED",
        detail: "provider PATCH not predicted",
      });
    }
  }
  for (const write of writes) {
    if (write.table === "profiles" && write.method === "PATCH") {
      const u = new URL(write.url);
      if (u.searchParams.get("id") !== `eq.${expected.userId}`) {
        v.push({
          code: "WRITE_UNSCOPED",
          detail: `PATCH profiles filter ${u.search}`,
        });
      }
      if (
        !(write.authorization ?? "").startsWith(
          `Bearer session-for-${expected.userId}.`,
        )
      ) {
        v.push({
          code: "WRITE_UNSCOPED",
          detail: "PATCH profiles not under the user's session",
        });
      }
      let patchBody: unknown = null;
      try {
        patchBody = JSON.parse(write.body);
      } catch {
        patchBody = null;
      }
      if (
        !isRecord(patchBody) || Object.keys(patchBody).join(",") !== "provider"
      ) {
        v.push({
          code: "WRITE_UNSCOPED",
          detail: `PATCH body ${write.body.slice(0, 80)}`,
        });
      }
    }
    if (write.table === "account_external_credentials") {
      const u = new URL(write.url);
      if (write.authorization !== `Bearer ${SERVICE_ROLE_KEY}`) {
        v.push({
          code: "WRITE_UNSCOPED",
          detail: "credential upsert not under service role",
        });
      }
      if (u.searchParams.get("on_conflict") !== "user_id") {
        v.push({
          code: "WRITE_UNSCOPED",
          detail: `upsert on_conflict ${u.searchParams.get("on_conflict")}`,
        });
      }
      if (write.body.includes(APPLE_RT_PLAINTEXT_MARKER)) {
        v.push({
          code: "PLAINTEXT_SECRET_STORED",
          detail: "Apple refresh token stored in plaintext",
        });
      }
      let row: unknown = null;
      try {
        row = JSON.parse(write.body);
      } catch {
        row = null;
      }
      if (!isRecord(row) || row.user_id !== expected.userId) {
        v.push({
          code: "WRITE_UNSCOPED",
          detail: `upsert user_id ${String(isRecord(row) ? row.user_id : row)}`,
        });
      }
      if (
        isRecord(row) &&
        !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          String(row.apple_refresh_token_encrypted),
        )
      ) {
        v.push({
          code: "CIPHERTEXT_FORMAT",
          detail: String(row.apple_refresh_token_encrypted).slice(0, 40),
        });
      }
    }
  }
  if (!expected.mintsSession && upstream.sessionsMinted > 0) {
    v.push({
      code: "SESSION_WITHOUT_AUTH",
      detail:
        `${upstream.sessionsMinted} minted for an unauthenticated request`,
    });
  }
  if (
    !c.token.valid &&
    upstream.calls.some((call) =>
      call.table !== null || call.url === APPLE_TOKEN_URL
    )
  ) {
    v.push({
      code: "UPSTREAM_BEFORE_AUTH",
      detail: "PostgREST/Apple reached without a valid credential",
    });
  }
  if (
    upstream.calls.some((call) =>
      call.url.includes("revenuecat") || call.url.includes("/rpc/")
    )
  ) {
    v.push({
      code: "UNEXPECTED_UPSTREAM",
      detail: "RevenueCat or an RPC reached from bootstrap",
    });
  }

  // ── access log ──
  const lines = booted.drainAccessLog();
  if (lines.length !== 1) {
    v.push({ code: "ACCESS_LOG_COUNT", detail: `${lines.length} lines` });
  } else {
    let entry: unknown = null;
    try {
      entry = JSON.parse(lines[0]);
    } catch {
      entry = null;
    }
    if (!isRecord(entry) || entry.evt !== "api_request") {
      v.push({ code: "ACCESS_LOG_SHAPE", detail: lines[0].slice(0, 120) });
    } else {
      if (entry.requestId !== rid) {
        v.push({
          code: "ACCESS_LOG_REQUEST_ID",
          detail: `${String(entry.requestId)} ≠ ${rid}`,
        });
      }
      if (entry.status !== status) {
        v.push({
          code: "ACCESS_LOG_STATUS",
          detail: `${String(entry.status)} ≠ ${status}`,
        });
      }
      if (code && entry.code !== code) {
        v.push({
          code: "ACCESS_LOG_CODE",
          detail: `${String(entry.code)} ≠ ${code}`,
        });
      }
    }
    const line = lines[0];
    if (
      c.token.header && c.token.header.length > 40 &&
      line.includes(c.token.header.slice(7, 47))
    ) v.push({ code: "ACCESS_LOG_LEAK", detail: "bearer in access log" });
    if (expected.userId && line.includes(expected.userId)) {
      v.push({ code: "ACCESS_LOG_LEAK", detail: "user id in access log" });
    }
    if (
      new URL(request.url).search.length > 1 &&
      line.includes(new URL(request.url).search)
    ) v.push({ code: "ACCESS_LOG_LEAK", detail: "query string in access log" });
    if (new RegExp(SECRET_MARKER).test(line)) {
      v.push({
        code: "ACCESS_LOG_LEAK",
        detail: "upstream detail in access log",
      });
    }
  }
  const consoleLines = booted.drainConsole();
  if (consoleLines.some((l) => l.includes("unhandled error"))) {
    v.push({
      code: "UNHANDLED_ERROR_LOGGED",
      detail: consoleLines.find((l) => l.includes("unhandled error"))!.slice(
        0,
        200,
      ),
    });
  }
  for (const l of consoleLines) {
    if (
      c.token.header && c.token.header.length > 40 &&
      l.includes(c.token.header.slice(7, 47))
    ) {
      v.push({
        code: "CONSOLE_LEAK",
        detail: "bearer token written to console",
      });
    }
    if (l.includes(APPLE_RT_PLAINTEXT_MARKER)) {
      v.push({
        code: "CONSOLE_LEAK",
        detail: "Apple refresh token written to console",
      });
    }
  }

  return { outcome, responseBody: bodyText };
}

// ── Campaign ─────────────────────────────────────────────────────────────────

export interface CampaignSummary {
  campaignSeed: number;
  iterations: number;
  executed: number;
  unconstructible: number;
  violations: number;
  failingSeeds: number[];
  statusHistogram: Record<string, number>;
  expectedReasonHistogram: Record<string, number>;
  labelHistogram: Record<string, number>;
  violationHistogram: Record<string, number>;
  noteHistogram: Record<string, number>;
  fiveXxSeeds: Array<
    { seed: number; status: number; fault: Fault; reason: string }
  >;
  durationMs: number;
  heap: Deno.MemoryUsage;
}

export async function runCampaign(
  booted: BootedHandler,
  campaignSeed: number,
  iterations: number,
  onProgress?: (i: number, outcome: Outcome) => void,
): Promise<{ summary: CampaignSummary; outcomes: Outcome[] }> {
  const model = new LimiterModel();
  const outcomes: Outcome[] = [];
  const startedAt = performance.now();
  const bump = (
    h: Record<string, number>,
    k: string,
  ) => (h[k] = (h[k] ?? 0) + 1);
  const statusHistogram: Record<string, number> = {};
  const expectedReasonHistogram: Record<string, number> = {};
  const labelHistogram: Record<string, number> = {};
  const violationHistogram: Record<string, number> = {};
  const noteHistogram: Record<string, number> = {};
  const fiveXxSeeds: CampaignSummary["fiveXxSeeds"] = [];
  let executed = 0;
  let unconstructible = 0;
  for (let i = 0; i < iterations; i++) {
    const c = generateCase(caseSeed(campaignSeed, i));
    const { outcome } = await executeCase(booted, c, i, model);
    outcomes.push(outcome);
    if (outcome.constructed) executed += 1;
    else unconstructible += 1;
    if (outcome.status !== undefined) {
      bump(statusHistogram, String(outcome.status));
    }
    if (outcome.expected) {
      bump(expectedReasonHistogram, outcome.expected.reason);
    }
    for (const l of outcome.labels) bump(labelHistogram, l);
    for (const vv of outcome.violations) bump(violationHistogram, vv.code);
    for (const n of outcome.notes) bump(noteHistogram, n.replace(/\d+/g, "N"));
    if (outcome.status !== undefined && outcome.status >= 500) {
      fiveXxSeeds.push({
        seed: c.seed,
        status: outcome.status,
        fault: c.fault,
        reason: outcome.expected?.reason ?? "",
      });
    }
    onProgress?.(i, outcome);
  }
  const summary: CampaignSummary = {
    campaignSeed,
    iterations,
    executed,
    unconstructible,
    violations: outcomes.reduce((n, o) => n + o.violations.length, 0),
    failingSeeds: outcomes.filter((o) => o.violations.length > 0).map((o) =>
      o.seed
    ),
    statusHistogram,
    expectedReasonHistogram,
    labelHistogram,
    violationHistogram,
    noteHistogram,
    fiveXxSeeds,
    durationMs: Math.round(performance.now() - startedAt),
    heap: Deno.memoryUsage(),
  };
  return { summary, outcomes };
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
