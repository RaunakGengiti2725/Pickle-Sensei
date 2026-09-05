// STRESS — lens `boundary-malformed`, unit `edge-cache`, through the REAL
// handler (index.ts booted in-process by sessionHarness.ts with a stateful
// fake GoTrue / PostgREST / Upstash; no network, no credentials).
//
// Every client-controlled input that reaches cache.ts or its callers is
// generated from a seed and fired at the function:
//
//   Authorization  — no scheme, wrong scheme, "Bearer" alone, 1–4 segment
//                    JWTs, invalid base64, non-JSON / scalar / array / null
//                    payloads, prototype-pollution claims, `iss` of every
//                    type, `exp` ∈ {past, -0, 0, 1e400, 2^53, string, object},
//                    `session_id` ∈ every hostile string category (NUL, NFD,
//                    64 KiB+, traversal, …), 16 KiB tokens;
//   bodies         — POST /v1/auth/refresh with truncated / non-object / BOM /
//                    NUL / 20 000-deep / `__proto__` JSON, wrong-typed
//                    refreshToken, empty, 5 MB + 1 (413);
//   paths          — traversal, `%zz`, `%00`, NFC/NFD, 8 KiB segments;
//   client ip      — hostile cf-connecting-ip / x-forwarded-for hops;
//   L2             — a hostile Upstash (same reply mutations as the module
//                    campaign) layered under a VALID session, plus logout.
//
// Invariants per request (violation = BROKEN):
//   1. the handler resolves — no throw reaches Deno.serve (`[api] unhandled
//      error` is never logged), status < 500;
//   2. every non-2xx body is `{error:{message}}` JSON with a generic message
//      (no stack, no upstream URL, no "TypeError"), `x-request-id` is set and
//      exactly one access-log line was emitted for the request;
//   3. a rejected request WRITES NOTHING: no `auth:*` cache row (L1 or L2),
//      no `auth:revoked:*` fence, no GoTrue logout, no PostgREST mutation,
//      no refresh grant unless the client presented a string refreshToken —
//      only `rl:*` counters may appear;
//   4. a valid session is served (200) whatever Upstash answers, and after
//      logout its exact `session_id` (byte-for-byte, however hostile) is
//      fenced: every token of that session is refused from the next request;
//   5. Object.prototype / Array.prototype are never polluted.
//
// A violation that reproduces a KNOWN gap pinned by a [defect] test below is
// counted DEFECT:<id> (in the table's summary.defects) instead of BROKEN.
//
// Replay ONE iteration:   STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json stress_handler_boundary_malformed.test.ts
// Full campaign (slow):   STRESS_ITER=3000 STRESS_OUT_DIR=../../../../artifacts/stress/edge-cache deno test -A --no-check --config deno.json stress_handler_boundary_malformed.test.ts
// Default (suite):        STRESS_ITER unset → 200 iterations.

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  APPLE_USER_ID,
  freshIp,
  GOOGLE_USER_ID,
  loadSessionHarness,
  REDIS_URL,
  type SessionHarness,
  SUPABASE_URL,
} from "./sessionHarness.ts";
import {
  abbreviate,
  assertPrototypesClean,
  buildTable,
  campaignConfig,
  genRawJsonValue,
  genReplyMode,
  genWeightedString,
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

const TEST_FILE = "stress_handler_boundary_malformed.test.ts";

/** cache.ts reads its Upstash env at import, so it must be imported AFTER
 * loadSessionHarness() configured the fake — a static import here would
 * boot the shared module instance with L2 off for the whole isolate. */
type CacheModule = typeof import("../cache.ts");
async function cacheModule(): Promise<CacheModule> {
  return await import("../cache.ts");
}
const DEFAULT_ITERATIONS = 200;
const MAX_JSON_BODY_BYTES = 5_000_000;
/** Gateways cap header blocks around 8–16 KiB; anything larger never
 * reaches the function, so hostile HEADER values stop there. */
const MAX_HEADER_VALUE = 16 * 1024;

// ─── Hostile Upstash layered on the session harness ──────────────────────────

interface HostileLayer {
  mode: ReplyMode;
  rng: Rng;
  pipelines: number;
  /** Replies that carried the parsable-but-bogus auth row (see [defect]). */
  poisonedReplies: number;
  restore(): void;
}

/** `genRawJsonValue` includes a JSON string that PARSES as an auth-cache row
 * (`userId` "poison", `provider` google, `expiresAtMs` +Infinity, no
 * `accessToken`). It is the only reply mutation that survives readAuthCache. */
const POISON_ROW_MARK = '\\"poison\\"';

function layerHostileUpstash(): HostileLayer {
  const base = globalThis.fetch;
  const layer: HostileLayer = {
    mode: "faithful",
    rng: new Rng(0),
    pipelines: 0,
    poisonedReplies: 0,
    restore() {
      globalThis.fetch = base;
    },
  };
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url !== `${REDIS_URL}/pipeline` || layer.mode === "faithful") {
      return base(input, init);
    }
    layer.pipelines += 1;
    let commands: unknown = null;
    try {
      commands = JSON.parse(String(init?.body ?? ""));
    } catch {
      commands = null;
    }
    const truthful = await base(input, init);
    const faithful = (await truthful.json()) as PipelineSlot[];
    const reply = mutateReply(layer.mode, layer.rng, commands, faithful);
    if (reply.text.includes(POISON_ROW_MARK)) layer.poisonedReplies += 1;
    return new Response(reply.text, {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return layer;
}

// ─── Console / access-log capture ────────────────────────────────────────────

interface Captured {
  access: string[];
  errors: string[];
  restore(): void;
}

function capture(): Captured {
  const errors: string[] = [];
  const access: string[] = [];
  const restoreAccess = captureAccessLog((line) => access.push(line));
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    errors.push(
      args.map((
        a,
      ) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(
        " ",
      ),
    );
  };
  console.warn = () => {};
  return {
    access,
    errors,
    restore() {
      restoreAccess();
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** The UTF-8 bytes of `text` as one Latin-1 code unit each (what `btoa`
 * consumes and what `atob` hands back). */
function latin1OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 8_192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8_192));
  }
  return out;
}

const b64url = (text: string): string =>
  btoa(latin1OfUtf8(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );

/** index.ts decodes JWT payloads with `atob` + JSON.parse and never runs the
 * bytes through TextDecoder, so a non-ASCII claim reaches the handler as the
 * Latin-1 reading of its UTF-8 bytes. The revocation key is built from THAT
 * spelling (consistently, on both the read and the fence side). Mirrors the
 * exact pipeline: JSON.stringify → UTF-8 → atob's Latin-1 → JSON.parse. */
const edgeSpelling = (claim: string): string =>
  JSON.parse(latin1OfUtf8(JSON.stringify(claim))) as string;

const JWT_HEADER = b64url('{"alg":"HS256","typ":"JWT"}');

/** Mint a session whose `session_id` may be ANY string (the harness's own
 * mintSession base64-encodes via btoa and refuses non-Latin1). Registered in
 * the fake GoTrue exactly like a bootstrap-issued session. */
function mintHostileSession(
  h: SessionHarness,
  userId: string,
  sessionId: string,
): { accessToken: string } {
  const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  const accessToken = `${JWT_HEADER}.${
    b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sessionId,
        exp: expiresAt,
      }),
    )
  }.${b64url(crypto.randomUUID())}`;
  const refreshToken = `rt-${crypto.randomUUID()}`;
  h.sessions.set(accessToken, {
    userId,
    accessToken,
    refreshToken,
    expiresAt,
    revoked: false,
  });
  h.refreshTokens.set(refreshToken, {
    userId,
    sessionAccessToken: accessToken,
    spent: false,
  });
  return { accessToken };
}

/** Header values are ByteStrings without CR/LF/NUL: fold anything else. */
function headerSafe(value: string, max = MAX_HEADER_VALUE): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? ch : ".";
    if (out.length >= max) break;
  }
  return out;
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}

const ISSUERS = [
  `${SUPABASE_URL}/auth/v1`,
  "https://accounts.google.com",
  "accounts.google.com",
  "https://appleid.apple.com",
  "https://evil.example/auth/v1",
  "/auth/v1",
  "auth/v1",
  "https://accounts.google.com.evil.example",
  "",
  " https://accounts.google.com",
];

function genClaimsPayload(rng: Rng, sessionId: string, exp: string): string {
  const issRaw = (() => {
    const r = rng.float();
    if (r < 0.45) return jsonString(`${SUPABASE_URL}/auth/v1`);
    if (r < 0.7) return jsonString(rng.pick(ISSUERS));
    if (r < 0.8) return jsonString(`${genWeightedString(rng).value}/auth/v1`);
    return genRawJsonValue(rng);
  })();
  const pairs: string[] = [];
  if (rng.bool(0.95)) pairs.push(`"iss":${issRaw}`);
  if (rng.bool(0.9)) pairs.push(`"exp":${exp}`);
  if (rng.bool(0.9)) {
    const sid = rng.float();
    pairs.push(
      `"session_id":${
        sid < 0.7
          ? jsonString(sessionId)
          : sid < 0.85
          ? genRawJsonValue(rng)
          : jsonString("")
      }`,
    );
  }
  if (rng.bool(0.5)) {
    pairs.push(
      `"sub":${
        rng.bool(0.7) ? jsonString(GOOGLE_USER_ID) : genRawJsonValue(rng)
      }`,
    );
  }
  if (rng.bool(0.3)) pairs.push(`"__proto__":{"polluted":"via-jwt"}`);
  if (rng.bool(0.2)) {
    pairs.push(`"constructor":{"prototype":{"polluted":"via-jwt"}}`);
  }
  if (rng.bool(0.2)) pairs.push(`"exp":${exp}`); // duplicate key
  if (rng.bool(0.3)) pairs.push(`"aud":${genRawJsonValue(rng)}`);
  if (rng.bool(0.2)) pairs.push(`"role":${genRawJsonValue(rng)}`);
  if (rng.bool(0.1)) pairs.push(`"pad":${jsonString("x".repeat(8_000))}`);
  // shuffle
  for (let i = pairs.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return `{${pairs.join(",")}}`;
}

function genExpRaw(rng: Rng): string {
  const now = Math.floor(Date.now() / 1_000);
  return rng.pick([
    String(now + 3_600),
    String(now + 3_600),
    String(now - 1),
    String(now),
    "0",
    "-0",
    "-1",
    "1e400",
    "-1e400",
    "9007199254740993",
    "1e21",
    String(now * 1_000), // ms instead of s → far future
    `"${now + 3_600}"`,
    "null",
    "true",
    "[]",
    "{}",
    `${now}.5`,
  ]);
}

type BearerKind =
  | "none"
  | "scheme-only"
  | "wrong-scheme"
  | "lowercase-bearer"
  | "garbage"
  | "segments"
  | "bad-base64"
  | "non-json-payload"
  | "scalar-payload"
  | "array-payload"
  | "null-payload"
  | "claims"
  | "huge";

const BEARER_KINDS: readonly BearerKind[] = [
  "none",
  "scheme-only",
  "wrong-scheme",
  "lowercase-bearer",
  "garbage",
  "segments",
  "bad-base64",
  "non-json-payload",
  "scalar-payload",
  "array-payload",
  "null-payload",
  "claims",
  "claims",
  "claims",
  "claims",
  "claims",
  "huge",
];

interface GeneratedBearer {
  kind: BearerKind;
  /** Full Authorization header value, or null for no header. */
  header: string | null;
  /** The token string index.ts will see (for cache-key checks), or null. */
  token: string | null;
  sessionId: string | null;
  /** A well-formed provider ID token for a registered subject: the fake
   * GoTrue verifies it (the real one would check the signature first). */
  providerTrusted: boolean;
}

function genBearer(rng: Rng, hostile: string): GeneratedBearer {
  const kind = rng.pick(BEARER_KINDS);
  const token = (t: string): GeneratedBearer => ({
    kind,
    header: `Bearer ${t}`,
    token: t,
    sessionId: null,
    providerTrusted: false,
  });
  switch (kind) {
    case "none":
      return {
        kind,
        header: null,
        token: null,
        sessionId: null,
        providerTrusted: false,
      };
    case "scheme-only":
      return {
        kind,
        header: rng.pick(["Bearer", "Bearer ", "Bearer  ", "Bearer\t"]),
        token: null,
        sessionId: null,
        providerTrusted: false,
      };
    case "wrong-scheme":
      return {
        kind,
        header: `${
          rng.pick(["Basic", "Token", "bearer", "BEARER", "Bearer:"])
        } ${headerSafe(hostile, 200)}`,
        token: null,
        sessionId: null,
        providerTrusted: false,
      };
    case "lowercase-bearer":
      return {
        kind,
        header: `bearer ${JWT_HEADER}.${b64url("{}")}.sig`,
        token: null,
        sessionId: null,
        providerTrusted: false,
      };
    case "garbage":
      return token(headerSafe(hostile, 4_096) || "x");
    case "segments": {
      const n = rng.pick([1, 2, 4, 5, 0]);
      const parts: string[] = [];
      for (let i = 0; i < n; i += 1) {
        parts.push(rng.bool(0.5) ? b64url("{}") : headerSafe(hostile, 64));
      }
      return token(n === 0 ? "..." : parts.join("."));
    }
    case "bad-base64":
      return token(
        `${JWT_HEADER}.${
          rng.pick(["!!!!", "%%%", "ey.J", "=abc", "a", "\u00e9", "AAAA===="])
        }.sig`,
      );
    case "non-json-payload":
      return token(
        `${JWT_HEADER}.${
          b64url(
            rng.pick(["not json", "{", '{"iss":', "\ufeff{}", "{}}", "\u0000"]),
          )
        }.sig`,
      );
    case "scalar-payload":
      return token(
        `${JWT_HEADER}.${
          b64url(rng.pick(['"x"', "42", "true", "-0", "1e400"]))
        }.sig`,
      );
    case "array-payload":
      return token(
        `${JWT_HEADER}.${
          b64url(rng.pick(["[]", '[{"iss":"x"}]', "[null]"]))
        }.sig`,
      );
    case "null-payload":
      return token(`${JWT_HEADER}.${b64url("null")}.sig`);
    case "claims": {
      const payload = genClaimsPayload(rng, hostile, genExpRaw(rng));
      let sessionId: string | null = null;
      let providerTrusted = false;
      try {
        const parsed = JSON.parse(payload) as {
          session_id?: unknown;
          iss?: unknown;
          sub?: unknown;
          exp?: unknown;
        };
        sessionId = typeof parsed.session_id === "string" && parsed.session_id
          ? parsed.session_id
          : null;
        // The transitional provider-ID-token branch hands the token to the
        // id_token grant; the fake GoTrue (like the real one, after signature
        // verification) accepts a registered subject of the routed provider.
        const iss = typeof parsed.iss === "string"
          ? parsed.iss.replace(/^https:\/\//, "")
          : "";
        const expired = typeof parsed.exp === "number" &&
          parsed.exp * 1_000 <= Date.now();
        providerTrusted = iss === "accounts.google.com" &&
          parsed.sub === GOOGLE_USER_ID && !expired;
      } catch {
        sessionId = null;
      }
      const t = `${JWT_HEADER}.${b64url(payload)}.${
        rng.bool(0.8) ? "c2lnbmF0dXJl" : ""
      }`;
      return {
        kind,
        header: `Bearer ${t}`,
        token: t,
        sessionId,
        providerTrusted,
      };
    }
    case "huge":
      return token(
        `${JWT_HEADER}.${
          b64url(
            `{"iss":"${SUPABASE_URL}/auth/v1","pad":"${"x".repeat(12_000)}"}`,
          )
        }.sig`,
      );
  }
}

function genRefreshBody(
  rng: Rng,
  hostile: string,
): { text: string; kind: string; presentsString: boolean } {
  const r = rng.float();
  const str = (kind: string, text: string, presentsString: boolean) => ({
    kind,
    text,
    presentsString,
  });
  if (r < 0.1) {
    return str(
      "valid-shape-unknown",
      `{"refreshToken":${jsonString(`rt-${hostile}`)}}`,
      true,
    );
  }
  if (r < 0.2) {
    return str(
      "hostile-string",
      `{"refreshToken":${jsonString(hostile)}}`,
      hostile.trim().length > 0,
    );
  }
  if (r < 0.3) {
    const raw = genRawJsonValue(rng);
    let presents = false;
    try {
      const v =
        (JSON.parse(`{"refreshToken":${raw}}`) as { refreshToken?: unknown })
          .refreshToken;
      presents = typeof v === "string" && v.trim().length > 0;
    } catch {
      presents = false;
    }
    return str("wrong-type", `{"refreshToken":${raw}}`, presents);
  }
  if (r < 0.4) {
    return str(
      "truncated",
      `{"refreshToken":"abc`.slice(0, rng.int(0, 19)),
      false,
    );
  }
  if (r < 0.48) {
    return str(
      "non-object",
      rng.pick(["[]", '["rt"]', "null", "42", '"rt"', "true"]),
      false,
    );
  }
  if (r < 0.55) {
    return str("empty", rng.pick(["", " ", "\n", "\ufeff", "\u0000"]), false);
  }
  if (r < 0.62) {
    return str(
      "proto",
      '{"__proto__":{"polluted":"via-body"},"constructor":{"prototype":{"x":1}}}',
      false,
    );
  }
  if (r < 0.68) {
    return str(
      "deep-nesting",
      `${"[".repeat(20_000)}${"]".repeat(20_000)}`,
      false,
    );
  }
  if (r < 0.74) return str("deep-nesting-unclosed", "[".repeat(50_000), false);
  if (r < 0.8) {
    return str(
      "dup-keys",
      `{"refreshToken":1,"refreshToken":${jsonString(hostile)}}`,
      hostile.trim().length > 0,
    );
  }
  // A raw NUL inside a JSON string is malformed JSON (→ {} → 400); the
  // escaped form is a legal string that reaches the upstream grant.
  if (r < 0.83) {
    return str(
      "nul-raw-in-json",
      `{"refreshToken":"a\u0000b","x":"\u0000"}`,
      false,
    );
  }
  if (r < 0.86) {
    return str(
      "nul-escaped-in-json",
      `{"refreshToken":"a\\u0000b","x":"\\u0000"}`,
      true,
    );
  }
  if (r < 0.92) {
    return str("whitespace-token", `{"refreshToken":"   \\t\\n  "}`, false);
  }
  if (r < 0.96) {
    return str(
      "big-array-value",
      `{"refreshToken":[${'"x",'.repeat(50_000)}"x"]}`,
      false,
    );
  }
  return str("oversize", OVERSIZE_BODY, false);
}
const OVERSIZE_BODY = `{"refreshToken":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`;

function genPath(rng: Rng, hostile: string): string {
  const seg = encodeURIComponent(hostile.toWellFormed()).slice(0, 2_000);
  return rng.pick([
    `/v1/me/${seg}`,
    `/v1/catalog/drills/${seg}`,
    `/v1/catalog/drills/%zz`,
    `/v1/catalog/drills/%00`,
    `/v1/catalog/drills/%E0%A4%A`,
    `/v1/catalog/drills/..%2F..%2Fetc%2Fpasswd`,
    `/v1/catalog/drills/../../me`,
    `/v1/me/saved-drills/${seg}`,
    `/v1/sessions/${seg}/finalize`,
    `/v1/analysis-permits/${seg}/finalize`,
    `/v1/analyses/${seg}/feedback`,
    `/v1/${seg}`,
    `/${seg}`,
    `/v1/me/`,
    `/v1//me`,
    `/v1/me%20`,
    `/v1/me?${seg}=${seg}`,
    `/v1/catalog/drills/${"a".repeat(8_000)}`,
  ]);
}

const OPS = [
  "bearer",
  "bearer",
  "refresh",
  "logout-forged",
  "valid-session",
  "valid-session",
  "path",
  "ip",
] as const;
type Op = (typeof OPS)[number];

interface Case {
  seed: number;
  op: Op;
  hostile: ReturnType<typeof genWeightedString>;
  redisMode: ReplyMode;
  bearer: GeneratedBearer;
  refreshBody: ReturnType<typeof genRefreshBody>;
  path: string;
  method: string;
  ipHeader:
    | { name: "cf-connecting-ip" | "x-forwarded-for"; value: string }
    | null;
  logoutAfter: boolean;
  userId: string;
}

function genCase(seed: number): Case {
  const rng = new Rng(seed);
  const op = rng.pick(OPS);
  const hostile = genWeightedString(rng);
  const redisMode = rng.bool(0.35) ? genReplyMode(rng) : "faithful";
  const bearer = genBearer(rng, hostile.value);
  const refreshBody = genRefreshBody(rng, hostile.value);
  const path = genPath(rng, hostile.value);
  const method = rng.pick([
    "GET",
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
  ]);
  const ipValue = (() => {
    const r = rng.float();
    if (r < 0.5) return headerSafe(hostile.value, 8_000);
    if (r < 0.7) return `${headerSafe(hostile.value, 200)}, ${freshIp()}`;
    if (r < 0.8) return ",,, ,";
    if (r < 0.9) return "";
    return `${freshIp()},${" ".repeat(4_000)}`;
  })();
  return {
    seed,
    op,
    hostile,
    redisMode,
    bearer,
    refreshBody,
    path,
    method,
    ipHeader: {
      name: rng.bool(0.5) ? "cf-connecting-ip" : "x-forwarded-for",
      value: ipValue,
    },
    logoutAfter: rng.bool(0.6),
    userId: rng.bool(0.5) ? GOOGLE_USER_ID : APPLE_USER_ID,
  };
}

// ─── Request plumbing / invariants ───────────────────────────────────────────

class Violation extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

function rawRequest(
  method: string,
  path: string,
  options: {
    authorization?: string | null;
    ip?: string;
    headers?: Record<string, string>;
    bodyText?: string;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? freshIp(),
    ...options.headers,
  });
  if (options.authorization) {
    headers.set("Authorization", options.authorization);
  }
  if (options.bodyText !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const canHaveBody = method !== "GET" && method !== "HEAD";
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body: canHaveBody && options.bodyText !== undefined
      ? options.bodyText
      : undefined,
  });
}

const authCacheKey = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return `auth:${
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

interface Fired {
  status: number;
  body: string;
  requestId: string | null;
}

const LEAK_MARKERS = [
  "TypeError",
  "RangeError",
  "SyntaxError",
  "    at ",
  "index.ts",
  "cache.ts",
  SUPABASE_URL,
  REDIS_URL,
  "stack",
];

async function fire(
  h: SessionHarness,
  cap: Captured,
  request: Request,
): Promise<Fired> {
  const accessBefore = cap.access.length;
  const errorsBefore = cap.errors.length;
  let response: Response;
  try {
    response = await h.handler(request);
  } catch (error) {
    throw new Violation(
      "handler-threw",
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
  }
  const body = await response.text();
  const requestId = response.headers.get("x-request-id");
  const unhandled = cap.errors.slice(errorsBefore).filter((line) =>
    line.includes("unhandled error")
  );
  if (unhandled.length > 0) {
    throw new Violation("unhandled-error-logged", unhandled[0].slice(0, 300));
  }
  if (response.status >= 500) {
    throw new Violation(
      "status-5xx",
      `${response.status} ${body.slice(0, 200)}`,
    );
  }
  if (!requestId) {
    throw new Violation("no-request-id", `status ${response.status}`);
  }
  const lines = cap.access.slice(accessBefore);
  if (lines.length !== 1) {
    throw new Violation("access-log", `${lines.length} lines for one request`);
  }
  const entry = JSON.parse(lines[0]) as { status: number; requestId: string };
  if (entry.status !== response.status || entry.requestId !== requestId) {
    throw new Violation(
      "access-log",
      `logged ${entry.status}/${entry.requestId} vs ${response.status}/${requestId}`,
    );
  }
  if (response.status >= 400) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Violation(
        "error-body-not-json",
        `${response.status} ${body.slice(0, 120)}`,
      );
    }
    const message = (parsed as { error?: { message?: unknown } })?.error
      ?.message;
    if (typeof message !== "string" || !message) {
      throw new Violation("error-body-shape", body.slice(0, 200));
    }
    for (const marker of LEAK_MARKERS) {
      if (message.includes(marker)) {
        throw new Violation(
          "error-detail-leak",
          `${response.status} ${message.slice(0, 200)}`,
        );
      }
    }
  }
  return { status: response.status, body, requestId };
}

function mutationCalls(h: SessionHarness): string[] {
  return h.calls
    .filter((call) => {
      if (call.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) return true;
      if (
        call.url.startsWith(`${SUPABASE_URL}/rest/v1/`) &&
        call.method !== "GET" && call.method !== "HEAD"
      ) return true;
      if (call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) return true;
      return false;
    })
    .map((call) => `${call.method} ${call.url.replace(SUPABASE_URL, "")}`);
}

function nonCounterRedisKeys(h: SessionHarness): string[] {
  return [...h.redis.keys()].filter((key) => !key.startsWith("rl:"));
}

/** Violations that reproduce a KNOWN gap pinned by a [defect] test below. */
function knownDefect(
  error: Violation,
  c: Case,
  layer: HostileLayer,
  detail: Record<string, unknown>,
): string | null {
  if (
    error.code === "status-5xx" && c.redisMode !== "faithful" &&
    layer.poisonedReplies > 0 && error.message.includes(" 503 ")
  ) {
    detail.poisonedReplies = layer.poisonedReplies;
    return "l2-row-shape-unchecked";
  }
  return null;
}

/** Modes whose INCR reply can be an arbitrary finite number: the fixed-window
 * limiter trusts the count it is handed, so an absurd value fails CLOSED (429).
 * That is the documented trade-off, never a 5xx; the case stays HELD. */
function lyingL2(c: Case): boolean {
  return c.redisMode === "slots-wrong-types" || c.redisMode === "slots-proto";
}

function expectStatus(
  status: number,
  allowed: number[],
  context: string,
): void {
  if (!allowed.includes(status)) {
    throw new Violation(
      "unexpected-status",
      `${context} → ${status} (allowed ${allowed.join("/")})`,
    );
  }
}

async function runCase(
  c: Case,
  h: SessionHarness,
  cache: CacheModule,
  layer: HostileLayer,
  cap: Captured,
  detail: Record<string, unknown>,
): Promise<void> {
  h.reset();
  layer.mode = c.redisMode;
  layer.rng = new Rng(c.seed ^ 0x5a5a5a5a);
  layer.poisonedReplies = 0;
  const ip = freshIp();

  switch (c.op) {
    case "bearer":
    case "logout-forged": {
      const isLogout = c.op === "logout-forged";
      const request = rawRequest(
        isLogout ? "POST" : "GET",
        isLogout ? "/v1/auth/logout" : "/v1/me",
        {
          authorization: c.bearer.header,
          ip,
          bodyText: isLogout ? "{}" : undefined,
        },
      );
      // L1 outlives h.reset(): a provider-verified logout in an EARLIER
      // iteration may legitimately have fenced this same hostile session_id,
      // so only a fence that appears during THIS request is a violation.
      const fenceSpellings = c.bearer.sessionId
        ? [...new Set([c.bearer.sessionId, edgeSpelling(c.bearer.sessionId)])]
        : [];
      const fencedBefore = new Set<string>();
      for (const spelling of fenceSpellings) {
        if ((await cache.cacheIsRevoked(`auth:revoked:${spelling}`)) === true) {
          fencedBefore.add(spelling);
        }
      }
      const out = await fire(h, cap, request);
      detail.bearerKind = c.bearer.kind;
      detail.status = out.status;
      const okStatuses = c.bearer.providerTrusted
        ? (isLogout ? [204, 401] : [200, 401])
        : [401];
      expectStatus(
        out.status,
        lyingL2(c) ? [...okStatuses, 429] : okStatuses,
        `${c.bearer.kind} bearer`,
      );
      if (out.status < 400) {
        detail.providerVerified = true;
        break;
      }
      const mutations = mutationCalls(h);
      // The transitional provider-ID-token branch verifies through the
      // id_token grant: that call IS the verification, not a write.
      const allowedMutation = (call: string) =>
        call.includes("grant_type=id_token");
      const bad = mutations.filter((m) => !allowedMutation(m));
      if (bad.length > 0) {
        throw new Violation(
          "rejected-request-wrote",
          `upstream ${bad.join(", ")}`,
        );
      }
      layer.mode = "faithful";
      const leaked = nonCounterRedisKeys(h);
      if (leaked.length > 0) {
        throw new Violation(
          "rejected-request-wrote",
          `redis keys ${leaked.map(abbreviate).join(", ")}`,
        );
      }
      // Under a lying L2 the fake's reply string is read through into L1 by
      // design (L2 is the authority), so L1 is only inspected against a
      // faithful L2; h.redis above already proves no real SET landed.
      if (c.bearer.token && c.redisMode === "faithful") {
        const cached = await cache.cacheGet(await authCacheKey(c.bearer.token));
        if (cached !== null) {
          throw new Violation(
            "rejected-request-wrote",
            "auth cache row exists (L1/L2)",
          );
        }
      }
      for (const spelling of fenceSpellings) {
        const fenced = await cache.cacheIsRevoked(`auth:revoked:${spelling}`);
        if (fenced === true && !fencedBefore.has(spelling)) {
          throw new Violation(
            "rejected-request-wrote",
            "forged session_id was fenced",
          );
        }
      }
      break;
    }
    case "refresh": {
      const request = rawRequest("POST", "/v1/auth/refresh", {
        ip,
        bodyText: c.refreshBody.text,
        headers: c.refreshBody.kind === "oversize" ? {} : {},
      });
      const out = await fire(h, cap, request);
      detail.bodyKind = c.refreshBody.kind;
      detail.bodyBytes = utf8Bytes(c.refreshBody.text);
      detail.status = out.status;
      const maybe429 = lyingL2(c) ? [429] : [];
      if (c.refreshBody.kind === "oversize") {
        expectStatus(out.status, [413], "oversize refresh body");
      } else if (c.refreshBody.presentsString) {
        expectStatus(
          out.status,
          [401, ...maybe429],
          `refresh ${c.refreshBody.kind}`,
        );
      } else {
        expectStatus(
          out.status,
          [400, ...maybe429],
          `refresh ${c.refreshBody.kind}`,
        );
      }
      const grants = mutationCalls(h);
      if (out.status === 429) {
        if (grants.length > 0) {
          throw new Violation(
            "rejected-request-wrote",
            `429 yet upstream ${grants.join(", ")}`,
          );
        }
      } else if (c.refreshBody.presentsString) {
        if (
          grants.length !== 1 || !grants[0].includes("grant_type=refresh_token")
        ) {
          throw new Violation(
            "refresh-upstream",
            `expected one refresh grant, saw ${grants.join(", ") || "none"}`,
          );
        }
      } else if (grants.length > 0) {
        throw new Violation(
          "rejected-request-wrote",
          `upstream ${grants.join(", ")}`,
        );
      }
      layer.mode = "faithful";
      const leaked = nonCounterRedisKeys(h);
      if (leaked.length > 0) {
        throw new Violation(
          "rejected-request-wrote",
          `redis keys ${leaked.map(abbreviate).join(", ")}`,
        );
      }
      break;
    }
    case "valid-session": {
      // A real session whose GoTrue session_id is the hostile string; the
      // seed suffix keeps sessions distinct across iterations.
      const sessionId = `${c.hostile.value}#${c.seed.toString(16)}`;
      const minted = mintHostileSession(h, c.userId, sessionId);
      const sibling = mintHostileSession(h, c.userId, sessionId);
      detail.sessionIdBytes = utf8Bytes(sessionId);
      const first = await fire(
        h,
        cap,
        rawRequest("GET", "/v1/me", {
          authorization: `Bearer ${minted.accessToken}`,
          ip,
        }),
      );
      detail.firstStatus = first.status;
      if (c.redisMode === "faithful") {
        expectStatus(first.status, [200], "valid session, faithful L2");
      } else {
        // A protocol-violating L2 may present a phantom revocation marker
        // (a string where GET returned nothing) — the fail-safe answer is
        // 401 — or an absurd INCR count (→ 429); never 5xx, and it must
        // never be *served* from garbage.
        expectStatus(
          first.status,
          lyingL2(c) ? [200, 401, 429] : [200, 401],
          `valid session, L2 ${c.redisMode}`,
        );
      }
      if (first.status === 200) {
        const body = JSON.parse(first.body) as { user?: { id?: unknown } };
        if (body.user?.id !== c.userId) {
          throw new Violation("wrong-user", `served ${String(body.user?.id)}`);
        }
      }
      layer.mode = "faithful";
      if (first.status === 200 && c.redisMode === "faithful") {
        const rows = nonCounterRedisKeys(h).filter((k) =>
          k.startsWith("auth:") && !k.startsWith("auth:revoked:")
        );
        if (rows.length !== 1) {
          throw new Violation(
            "auth-cache-rows",
            `${rows.length} auth rows after one verification`,
          );
        }
        const ttl = (h.redis.get(rows[0])!.expiresAtMs - Date.now()) / 1_000;
        if (!(ttl > 0 && ttl <= 600)) {
          throw new Violation("auth-cache-ttl", `${ttl}s`);
        }
      }
      if (c.logoutAfter && first.status === 200) {
        layer.mode = c.redisMode;
        const logout = await fire(
          h,
          cap,
          rawRequest("POST", "/v1/auth/logout", {
            authorization: `Bearer ${minted.accessToken}`,
            ip,
            bodyText: "{}",
          }),
        );
        detail.logoutStatus = logout.status;
        expectStatus(
          logout.status,
          lyingL2(c) ? [204, 429] : [204],
          "logout of a verified session",
        );
        if (logout.status === 429) {
          if (h.callsTo("/auth/v1/logout").length !== 0) {
            throw new Violation(
              "logout-upstream",
              "429 yet upstream logout was called",
            );
          }
          break;
        }
        if (h.callsTo("/auth/v1/logout").length !== 1) {
          throw new Violation(
            "logout-upstream",
            "expected exactly one upstream logout",
          );
        }
        layer.mode = "faithful";
        const fenceKey = `auth:revoked:${edgeSpelling(sessionId)}`;
        const fenced = await cache.cacheIsRevoked(fenceKey);
        if (fenced !== true) {
          throw new Violation(
            "logout-not-fenced",
            `marker for hostile session_id missing (${String(fenced)})`,
          );
        }
        const marker = h.redis.get(fenceKey);
        if (c.redisMode === "faithful") {
          if (!marker) {
            throw new Violation(
              "logout-not-fenced",
              "marker missing from L2 under a faithful L2",
            );
          }
          const ttl = (marker.expiresAtMs - Date.now()) / 1_000;
          if (!(ttl > 600 && ttl <= 660)) {
            throw new Violation("fence-ttl", `${ttl}s`);
          }
        }
        const again = await fire(
          h,
          cap,
          rawRequest("GET", "/v1/me", {
            authorization: `Bearer ${minted.accessToken}`,
            ip,
          }),
        );
        detail.afterLogoutStatus = again.status;
        expectStatus(again.status, [401], "logged-out bearer");
        const sib = await fire(
          h,
          cap,
          rawRequest("GET", "/v1/me", {
            authorization: `Bearer ${sibling.accessToken}`,
            ip,
          }),
        );
        detail.siblingStatus = sib.status;
        expectStatus(
          sib.status,
          [401],
          "sibling token of a logged-out session",
        );
      }
      break;
    }
    case "path": {
      const minted = h.mintSession(c.userId, 3_600);
      const withToken = c.seed % 2 === 0;
      const request = rawRequest(c.method, c.path, {
        authorization: withToken
          ? `Bearer ${minted.accessToken}`
          : c.bearer.header,
        ip,
        bodyText: c.method === "GET" || c.method === "HEAD" ? undefined : "{}",
      });
      // Dot segments never reach the handler: the WHATWG URL parser inside
      // Request resolves them, so "/v1/catalog/drills/../../me" IS /v1/me.
      const seen = new URL(request.url).pathname.slice(
        "/functions/v1/api".length,
      );
      const normalisedToRealRoute = seen !== c.path && seen === "/v1/me" &&
        c.method === "GET";
      const out = await fire(h, cap, request);
      detail.method = c.method;
      detail.path = abbreviate(c.path);
      if (seen !== c.path) detail.pathSeenByHandler = abbreviate(seen);
      detail.withToken = withToken;
      detail.status = out.status;
      if (!withToken && !c.bearer.providerTrusted) {
        expectStatus(
          out.status,
          lyingL2(c) ? [401, 429] : [401],
          "hostile path without a session",
        );
      } else if (out.status >= 500) {
        throw new Violation(
          "unexpected-status",
          `${c.method} ${abbreviate(c.path)} → ${out.status}`,
        );
      } else if (out.status < 400 && normalisedToRealRoute) {
        if (!withToken) detail.providerVerified = true;
        if (out.status !== 200) {
          throw new Violation(
            "unexpected-status",
            `GET /v1/me (via dot segments) → ${out.status}`,
          );
        }
      } else if (out.status < 400) {
        // The only routes that take a free-form id are the saved-drill
        // toggles; DELETE of a never-saved slug is idempotent (204). PUT must
        // still refuse a slug the catalogue regex rejects.
        const unsave = c.method === "DELETE" &&
          c.path.startsWith("/v1/me/saved-drills/");
        if (!unsave) {
          throw new Violation(
            "unexpected-status",
            `${c.method} ${abbreviate(c.path)} → ${out.status}`,
          );
        }
        const writes = h.calls.filter((call) =>
          call.url.includes("/rest/v1/") && call.method !== "GET" &&
          call.method !== "DELETE"
        );
        if (writes.length > 0) {
          throw new Violation(
            "rejected-request-wrote",
            `unsave wrote ${writes.map((w) => w.method).join(",")}`,
          );
        }
      }
      break;
    }
    case "ip": {
      const request = rawRequest("GET", "/v1/me", {
        authorization: c.bearer.header,
        ip: c.ipHeader!.name === "x-forwarded-for" ? c.ipHeader!.value : ip,
        headers: c.ipHeader!.name === "cf-connecting-ip"
          ? { "cf-connecting-ip": c.ipHeader!.value }
          : {},
      });
      const out = await fire(h, cap, request);
      detail.ipHeader = c.ipHeader!.name;
      detail.ipBytes = c.ipHeader!.value.length;
      detail.status = out.status;
      // Hostile ips repeat across iterations, so the per-IP auth-failure
      // budget may legitimately answer 429 (as may a lying L2 count).
      expectStatus(
        out.status,
        c.bearer.providerTrusted ? [200, 401, 429] : [401, 429],
        "hostile client ip",
      );
      if (out.status === 200) {
        detail.providerVerified = true;
        break;
      }
      layer.mode = "faithful";
      const leaked = nonCounterRedisKeys(h);
      if (leaked.length > 0) {
        throw new Violation(
          "rejected-request-wrote",
          `redis keys ${leaked.map(abbreviate).join(", ")}`,
        );
      }
      break;
    }
  }
  assertPrototypesClean();
}

// ─── The campaign ────────────────────────────────────────────────────────────

Deno.test(`[stress] boundary/malformed campaign through the real handler (${TEST_FILE})`, async () => {
  const config = campaignConfig(DEFAULT_ITERATIONS);
  const seeds = iterationSeeds(config);
  const h = await loadSessionHarness({ redis: true });
  const cache = await cacheModule();
  const layer = layerHostileUpstash();
  const cap = capture();
  const startedAt = new Date();
  const rows: OutcomeRow[] = [];
  const heapStart = heapUsedMb();
  let requests = 0;
  try {
    for (let i = 0; i < seeds.length; i += 1) {
      const seed = seeds[i];
      const c = genCase(seed);
      const accessBefore = cap.access.length;
      const errorsBefore = cap.errors.length;
      let outcome: OutcomeRow["outcome"] = "HELD";
      let violation: string | undefined;
      const detail: Record<string, unknown> = {};
      try {
        await runCase(c, h, cache, layer, cap, detail);
      } catch (error) {
        if (error instanceof Violation) {
          violation = error.message;
          const known = knownDefect(error, c, layer, detail);
          outcome = known ? `DEFECT:${known}` : "BROKEN";
        } else {
          outcome = "BROKEN";
          violation = `THROW ${
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error)
          }`;
        }
        detail.serverErrors = cap.errors.slice(errorsBefore).map(abbreviate);
        detail.upstreamCalls = h.calls.map((call) =>
          abbreviate(`${call.method} ${call.url}`)
        );
      }
      requests += cap.access.length - accessBefore;
      rows.push({
        i,
        seed,
        outcome,
        op: c.op,
        detail: {
          redisMode: c.redisMode,
          hostileCategory: c.hostile.category,
          hostile: abbreviate(c.hostile.value),
          hostileBytes: utf8Bytes(c.hostile.value),
          ...detail,
        },
        violation,
      });
    }
  } finally {
    cap.restore();
    layer.restore();
  }
  const table = await buildTable(
    "handler-boundary-malformed",
    config,
    rows,
    startedAt,
    TEST_FILE,
    {
      requests,
      hostilePipelines: layer.pipelines,
      heapUsedMbStart: heapStart,
      heapUsedMbEnd: heapUsedMb(),
      consoleErrors: cap.errors.length,
    },
  );
  const path = await writeTable(table, config);
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  console.log(
    `[stress] ${TEST_FILE}: ${rows.length} iterations / ${requests} requests, held=${table.summary.held} broken=${broken.length} defects=${
      JSON.stringify(table.summary.defects)
    }${path ? ` table=${path}` : ""}`,
  );
  assertEquals(
    broken.map((r) => ({ seed: r.seed, op: r.op, violation: r.violation })),
    [],
    "invariant violations — replay each seed with STRESS_REPLAY=<seed>",
  );
});

// ─── Pinned specifics ────────────────────────────────────────────────────────

Deno.test("[defect] readAuthCache trusts the SHAPE of an L2 row: a parsable row with no accessToken and expiresAtMs=Infinity is served as an identity (no re-verification) and the request ends 503 instead of a cache miss", async () => {
  const h = await loadSessionHarness({ redis: true });
  const cap = capture();
  try {
    const minted = h.mintSession(GOOGLE_USER_ID, 3_600);
    // A never-seen bearer on this isolate: L1 is cold, so the row below is
    // read through from L2 exactly as a row another isolate (or a corrupted
    // Redis) left there.
    h.redis.set(await authCacheKey(minted.accessToken), {
      value: '{"userId":"poison","provider":"google","expiresAtMs":9e999}',
      expiresAtMs: Date.now() + 600_000,
    });
    // Straight through the handler (fire() would flag the 5xx itself).
    const out = await h.handler(
      rawRequest("GET", "/v1/me", {
        authorization: `Bearer ${minted.accessToken}`,
      }),
    );
    const body = await out.text();
    // The defect: the bogus row is not a miss. Supabase Auth is never
    // consulted and the profile read runs as "poison" with an undefined
    // bearer, so the client sees a (generic) 503 for a perfectly valid
    // session until the row expires.
    assertEquals(out.status, 503);
    assertEquals(
      JSON.parse(body),
      {
        error: {
          message: "Your account is temporarily unavailable. Please try again.",
        },
      },
    );
    assertEquals(h.callsTo("/auth/v1/user").length, 0, "not re-verified");
    assertEquals(
      h.calls.filter((call) => call.url.includes("/rest/v1/profiles")).length,
      2,
      "profile read (and its one retry) ran as the bogus identity",
    );
    // Contrast: a row that fails JSON.parse IS a miss and the session is
    // re-verified and served.
    h.reset();
    const sane = h.mintSession(GOOGLE_USER_ID, 3_600);
    h.redis.set(await authCacheKey(sane.accessToken), {
      value: "{not json",
      expiresAtMs: Date.now() + 600_000,
    });
    const served = await fire(
      h,
      cap,
      rawRequest("GET", "/v1/me", {
        authorization: `Bearer ${sane.accessToken}`,
      }),
    );
    assertEquals(served.status, 200);
    assertEquals(h.callsTo("/auth/v1/user").length, 1);
  } finally {
    cap.restore();
  }
});

Deno.test("[stress] a forged session bearer cannot fence a victim's session_id through /v1/auth/logout (verification precedes the fence)", async () => {
  const h = await loadSessionHarness({ redis: true });
  const cache = await cacheModule();
  const cap = capture();
  try {
    const victim = h.mintSession(GOOGLE_USER_ID, 3_600);
    const victimSessionId = h.sessionIdOf(victim.accessToken);
    const forged = `${JWT_HEADER}.${
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: GOOGLE_USER_ID,
          session_id: victimSessionId,
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        }),
      )
    }.forged`;
    const out = await fire(
      h,
      cap,
      rawRequest("POST", "/v1/auth/logout", {
        authorization: `Bearer ${forged}`,
        bodyText: "{}",
      }),
    );
    assertEquals(out.status, 401);
    assertEquals(
      h.callsTo("/auth/v1/logout").length,
      0,
      "no upstream logout for an unverified bearer",
    );
    assertEquals(
      await cache.cacheIsRevoked(`auth:revoked:${victimSessionId}`),
      false,
      "victim not fenced",
    );
    const victimCall = await fire(
      h,
      cap,
      rawRequest("GET", "/v1/me", {
        authorization: `Bearer ${victim.accessToken}`,
      }),
    );
    assertEquals(victimCall.status, 200, "victim still served");
  } finally {
    cap.restore();
  }
});

Deno.test("[stress] 5 MB + 1 refresh body is refused with 413 before any upstream call, and the next request on the isolate is unaffected", async () => {
  const h = await loadSessionHarness({ redis: true });
  const cap = capture();
  try {
    const out = await fire(
      h,
      cap,
      rawRequest("POST", "/v1/auth/refresh", { bodyText: OVERSIZE_BODY }),
    );
    assertEquals(out.status, 413);
    assertEquals(mutationCalls(h), []);
    const minted = h.mintSession(GOOGLE_USER_ID, 3_600);
    const next = await fire(
      h,
      cap,
      rawRequest("GET", "/v1/me", {
        authorization: `Bearer ${minted.accessToken}`,
      }),
    );
    assertEquals(next.status, 200);
    assertPrototypesClean();
  } finally {
    cap.restore();
  }
});

Deno.test("[defect] decodeJwtPayload reads UTF-8 claims as Latin-1 (atob without TextDecoder): a non-ASCII session_id is fenced under its mojibake spelling — consistently, so logout still evicts; NFC/NFD stay distinct", async () => {
  const h = await loadSessionHarness({ redis: true });
  const cap = capture();
  try {
    const nfc = `sess-café-${crypto.randomUUID()}`.normalize("NFC");
    const nfd = nfc.normalize("NFD");
    assert(nfc !== nfd);
    const a = mintHostileSession(h, GOOGLE_USER_ID, nfc);
    const b = mintHostileSession(h, GOOGLE_USER_ID, nfd);
    assertEquals(
      (await fire(
        h,
        cap,
        rawRequest("GET", "/v1/me", {
          authorization: `Bearer ${a.accessToken}`,
        }),
      )).status,
      200,
    );
    assertEquals(
      (await fire(
        h,
        cap,
        rawRequest("GET", "/v1/me", {
          authorization: `Bearer ${b.accessToken}`,
        }),
      )).status,
      200,
    );
    assertEquals(
      (await fire(
        h,
        cap,
        rawRequest("POST", "/v1/auth/logout", {
          authorization: `Bearer ${a.accessToken}`,
          bodyText: "{}",
        }),
      )).status,
      204,
    );
    // The defect: the key carries the Latin-1 reading of the UTF-8 bytes,
    // not the claim the token actually carries.
    assertEquals(
      h.redis.has(`auth:revoked:${nfc}`),
      false,
      "true spelling is NOT the fence key",
    );
    assertEquals(
      h.redis.has(`auth:revoked:${edgeSpelling(nfc)}`),
      true,
      "mojibake spelling is",
    );
    assert(edgeSpelling(nfc) !== nfc);
    assertEquals(h.redis.has(`auth:revoked:${edgeSpelling(nfd)}`), false);
    assertEquals(
      (await fire(
        h,
        cap,
        rawRequest("GET", "/v1/me", {
          authorization: `Bearer ${a.accessToken}`,
        }),
      )).status,
      401,
    );
    assertEquals(
      (await fire(
        h,
        cap,
        rawRequest("GET", "/v1/me", {
          authorization: `Bearer ${b.accessToken}`,
        }),
      )).status,
      200,
      "the other spelling is a different session",
    );
  } finally {
    cap.restore();
  }
});
