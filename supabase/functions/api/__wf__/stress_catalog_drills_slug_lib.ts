// stress-route-get-v1-catalog-drills-slug / fuzz-boundary — generator + oracle.
//
// Drives the REAL edge handler (../index.ts, `Deno.serve` captured by
// routesHarness.ts) with seeded, replayable requests aimed at
// `GET /v1/catalog/drills/:slug` and checks a fixed set of contract
// invariants on every response:
//
//   status      ∈ {200, 400, 401, 403, 404, 405, 413, 415, 429} for any input,
//               plus 503 ONLY when this harness deliberately broke PostgREST
//   request-id  `x-request-id` on every response; a client id matching
//               `[A-Za-z0-9._-]{8,64}` is echoed, anything else is replaced by a
//               UUID (never echoed back)
//   generic 5xx body is the stable generic sentence — no upstream detail, stack
//               frames, table names or the injected secret marker
//   no write    no POST/PATCH/PUT/DELETE reaches /rest/v1 or /auth/v1 for ANY
//               request (the route is read-only); no /rest/v1 call at all for a
//               rejected (non-2xx, non-503) request
//   scoped read the single PostgREST read is `user_saved_drills` filtered by
//               `user_id=eq.<authenticated user>` and `slug=eq.<slug>`
//   shape       200 → drill/mappings/instructionalMedia contract, 404 →
//               `drill.not_found`, 400 → "Malformed path segment."
//   access log  exactly one structured line per request, same request id,
//               same status, no bearer in any log line
//
// Nothing here modifies production code or existing tests; the harness only
// wraps `globalThis.fetch` AFTER routesHarness.ts installed its stub, to add
// `GET /auth/v1/user` (session bearers) and deliberate PostgREST faults.

import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  SUPABASE_URL,
} from "./routesHarness.ts";
import { type CatalogDrillRecord, drillCatalog } from "../drills.ts";
import { captureAccessLog } from "../http.ts";

// ── Seeded RNG (mulberry32; `iterationSeed` makes every iteration standalone) ─

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
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][0];
  }
  string(alphabet: string, length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Per-iteration seed: replay iteration `iter` of campaign `campaignSeed`
 * without replaying its predecessors. */
export const iterationSeed = (campaignSeed: number, iter: number): number =>
  (fnv1a(`${campaignSeed}:${iter}`) ^ (campaignSeed >>> 0)) >>> 0;

// ── Token construction (UTF-8 safe base64url; the harness's b64url is Latin-1) ─

const utf8b64url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const rawJwt = (headerJson: string, payloadJson: string, signature = "sig"): string =>
  `${utf8b64url(headerJson)}.${utf8b64url(payloadJson)}.${signature}`;

const jwt = (payload: unknown): string =>
  rawJwt(JSON.stringify({ alg: "RS256", typ: "JWT" }), JSON.stringify(payload));

const nowSeconds = () => Math.floor(Date.now() / 1000);

export type TokenKind =
  | "google"
  | "apple"
  | "session"
  | "session-unknown"
  | "session-expired"
  | "none"
  | "empty-bearer"
  | "lowercase-bearer"
  | "basic"
  | "garbage"
  | "jwt-2seg"
  | "jwt-4seg"
  | "jwt-bad-b64"
  | "jwt-payload-array"
  | "jwt-payload-string"
  | "jwt-payload-null"
  | "jwt-payload-number"
  | "jwt-iss-number"
  | "jwt-iss-lookalike"
  | "jwt-iss-http-google"
  | "jwt-iss-suffix-auth-v1-only"
  | "jwt-expired-google"
  | "jwt-exp-string"
  | "jwt-exp-huge"
  | "jwt-huge-claims"
  | "jwt-unicode-claims"
  | "jwt-no-sub";

export interface TokenSpec {
  kind: TokenKind;
  /** Provider subject / Supabase user id the token claims (when it claims one). */
  sub: string;
}

/** Kinds the real handler must accept (with the harness's fake Supabase Auth). */
export const AUTHENTICATED_KINDS: ReadonlySet<TokenKind> = new Set([
  "google",
  "apple",
  "session",
  "jwt-exp-string",
  "jwt-exp-huge",
  "jwt-huge-claims",
  "jwt-unicode-claims",
  "jwt-iss-http-google",
  "jwt-no-sub",
]);

/** Kinds that MUST be refused without any upstream auth call (bad syntax /
 * wrong issuer / expired — decided locally). */
export const LOCALLY_REFUSED_KINDS: ReadonlySet<TokenKind> = new Set([
  "none",
  "empty-bearer",
  "lowercase-bearer",
  "basic",
  "garbage",
  "jwt-2seg",
  "jwt-4seg",
  "jwt-bad-b64",
  "jwt-payload-array",
  "jwt-payload-string",
  "jwt-payload-null",
  "jwt-payload-number",
  "jwt-iss-number",
  "jwt-iss-lookalike",
  "jwt-expired-google",
  "session-expired",
]);

/** Kinds the handler must forward to Supabase Auth exactly once and then refuse
 * (well-formed session bearers Auth does not recognise). */
export const UPSTREAM_REFUSED_KINDS: ReadonlySet<TokenKind> = new Set([
  "session-unknown",
  "jwt-iss-suffix-auth-v1-only",
]);

export const ALL_TOKEN_KINDS: readonly TokenKind[] = [
  ...AUTHENTICATED_KINDS,
  ...LOCALLY_REFUSED_KINDS,
  ...UPSTREAM_REFUSED_KINDS,
];

const SESSION_ISS = `${SUPABASE_URL}/auth/v1`;

/** Session bearers the fake `GET /auth/v1/user` recognises (token → user id). */
export const knownSessions = new Map<string, string>();

export function buildAuthorization(spec: TokenSpec, rng: Prng): string | null {
  const { kind, sub } = spec;
  const google = (extra: Record<string, unknown> = {}) =>
    jwt({ iss: "https://accounts.google.com", sub, exp: nowSeconds() + 3600, ...extra });
  const bearer = (token: string) => `Bearer ${token}`;
  switch (kind) {
    case "google":
      return bearer(fakeGoogleIdToken(sub));
    case "apple":
      return bearer(fakeAppleIdToken(sub));
    case "session": {
      const token = jwt({
        iss: SESSION_ISS,
        sub,
        role: "authenticated",
        session_id: rng.uuid(),
        exp: nowSeconds() + 3600,
      });
      knownSessions.set(token, sub);
      return bearer(token);
    }
    case "session-unknown":
      return bearer(
        jwt({
          iss: SESSION_ISS,
          sub,
          role: "authenticated",
          session_id: rng.uuid(),
          exp: nowSeconds() + 3600,
        }),
      );
    case "session-expired":
      return bearer(jwt({ iss: SESSION_ISS, sub, session_id: rng.uuid(), exp: nowSeconds() - 5 }));
    case "none":
      return null;
    case "empty-bearer":
      return "Bearer ";
    case "lowercase-bearer":
      return `bearer ${fakeGoogleIdToken(sub)}`;
    case "basic":
      return `Basic ${utf8b64url(`${sub}:password`)}`;
    case "garbage":
      return bearer(
        rng.string(
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~*'()",
          rng.int(1, 200),
        ),
      );
    case "jwt-2seg":
      return bearer(fakeGoogleIdToken(sub).split(".").slice(0, 2).join("."));
    case "jwt-4seg":
      return bearer(`${fakeGoogleIdToken(sub)}.extra`);
    case "jwt-bad-b64": {
      const [h, , s] = fakeGoogleIdToken(sub).split(".");
      return bearer(`${h}.${rng.string("!@#$%^&*()=+[]{};:'\",<>/?\\|`", rng.int(1, 40))}.${s}`);
    }
    case "jwt-payload-array":
      return bearer(rawJwt("{}", JSON.stringify([1, 2, 3])));
    case "jwt-payload-string":
      return bearer(rawJwt("{}", JSON.stringify("accounts.google.com")));
    case "jwt-payload-null":
      return bearer(rawJwt("{}", "null"));
    case "jwt-payload-number":
      return bearer(rawJwt("{}", "1e308"));
    case "jwt-iss-number":
      return bearer(jwt({ iss: 12345, sub, exp: nowSeconds() + 3600 }));
    case "jwt-iss-lookalike":
      return bearer(
        jwt({
          iss: rng.pick([
            "https://accounts.google.com.evil.example",
            "https://evil.example/accounts.google.com",
            "accounts.google.com/",
            "https://accounts.google.com ",
            "https://appleid.apple.com.attacker.example",
            "https://accounts.googIe.com",
            "http://evil.example/auth/v1x",
            "https://supabase.test/auth/v1/",
          ]),
          sub,
          exp: nowSeconds() + 3600,
        }),
      );
    case "jwt-iss-http-google":
      // `providerForIssuer` strips only `https://`; a bare host is accepted too.
      return bearer(jwt({ iss: "accounts.google.com", sub, exp: nowSeconds() + 3600 }));
    case "jwt-iss-suffix-auth-v1-only":
      // Ends with /auth/v1 but is not our project: the handler still treats it as
      // a session bearer and asks Supabase Auth, which refuses it → 401.
      return bearer(
        jwt({ iss: "https://attacker.example/auth/v1", sub, exp: nowSeconds() + 3600 }),
      );
    case "jwt-expired-google":
      return bearer(google({ exp: nowSeconds() - rng.int(1, 100_000) }));
    case "jwt-exp-string":
      return bearer(google({ exp: "never" }));
    case "jwt-exp-huge":
      return bearer(google({ exp: Number.MAX_SAFE_INTEGER }));
    case "jwt-huge-claims":
      return bearer(google({ pad: rng.string("x", rng.int(20_000, 60_000)) }));
    case "jwt-unicode-claims":
      return bearer(
        google({ name: rng.pick(["🥒 Sensei", "Ünïcødé", "\u0000null", "中文", "\u202eRTL"]) }),
      );
    case "jwt-no-sub":
      // authenticate() does not require `sub`; the fake exchange falls back to
      // TEST_USER_ID (production Supabase Auth would refuse an unsigned token).
      return bearer(jwt({ iss: "https://accounts.google.com", exp: nowSeconds() + 3600 }));
  }
}

// ── Path / slug generation ─────────────────────────────────────────────────

export type SlugKind =
  | "catalog"
  | "catalog-case"
  | "catalog-padded"
  | "unknown-shaped"
  | "malformed-percent"
  | "encoded-catalog"
  | "unicode"
  | "control"
  | "long"
  | "proto"
  | "dots"
  | "injection"
  | "empty";

export interface SlugChoice {
  kind: SlugKind;
  /** Raw segment as it appears in the request URL (already percent-encoded where intended). */
  segment: string;
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-";
const PRINTABLE =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

export function chooseSlug(rng: Prng, catalog: readonly CatalogDrillRecord[]): SlugChoice {
  const kind = rng.weighted<SlugKind>([
    ["catalog", 30],
    ["catalog-case", 4],
    ["catalog-padded", 4],
    ["unknown-shaped", 12],
    ["malformed-percent", 10],
    ["encoded-catalog", 6],
    ["unicode", 8],
    ["control", 6],
    ["long", 5],
    ["proto", 3],
    ["dots", 4],
    ["injection", 6],
    ["empty", 2],
  ]);
  const real = rng.pick(catalog).slug;
  switch (kind) {
    case "catalog":
      return { kind, segment: real };
    case "catalog-case": {
      const flipped = real
        .split("")
        .map((c) => (rng.chance(0.5) ? c.toUpperCase() : c))
        .join("");
      return { kind, segment: flipped === real ? real.toUpperCase() : flipped };
    }
    case "catalog-padded":
      return {
        kind,
        segment: rng.pick([
          `%20${real}`,
          `${real}%20`,
          `${real}%09`,
          `${real}%0A`,
          `${real}.`,
          `${real}%00`,
        ]),
      };
    case "unknown-shaped":
      return { kind, segment: rng.string(SLUG_ALPHABET, rng.int(1, 120)) };
    case "malformed-percent":
      return {
        kind,
        segment: rng.pick([
          "%",
          "%2",
          "%zz",
          "%G0",
          `${real}%`,
          `${real}%2`,
          `%E0%A4%A`,
          "%C3%28",
          "%ED%A0%80", // lone surrogate → URIError
          "%FF",
          "%80",
          `%${rng.string("0123456789abcdefABCDEF", 1)}`,
          `${rng.string(SLUG_ALPHABET, rng.int(0, 10))}%${rng.string("ghijklmnopqrstuvwxyz", 2)}`,
        ]),
      };
    case "encoded-catalog": {
      // Fully/partially percent-encoded real slug (decodes to the real slug).
      const encoded = real
        .split("")
        .map((c) =>
          rng.chance(0.6) ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : c,
        )
        .join("");
      return { kind, segment: encoded };
    }
    case "unicode":
      return {
        kind,
        segment: rng.pick([
          encodeURIComponent("🥒"),
          encodeURIComponent("ünïcødé-drill"),
          encodeURIComponent("中文-drill"),
          encodeURIComponent("\u202e" + real),
          encodeURIComponent("\ufeff" + real),
          encodeURIComponent(real.normalize("NFD")),
          encodeURIComponent("ｗall-dink-rally"),
          "%EF%BC%8F", // fullwidth solidus
          `${encodeURIComponent("\u200b")}${real}`,
        ]),
      };
    case "control":
      return {
        kind,
        segment: rng.pick([
          "%00",
          `${real.slice(0, 4)}%00${real.slice(4)}`,
          "%0D%0A",
          `${real}%0D%0AX-Injected:%201`,
          "%7F",
          "%1B%5B31m",
          encodeURIComponent(String.fromCharCode(rng.int(1, 31))),
        ]),
      };
    case "long":
      return {
        kind,
        segment: rng.string(SLUG_ALPHABET, rng.pick([121, 256, 1024, 4096, 16384, 65536])),
      };
    case "proto":
      return {
        kind,
        segment: rng.pick([
          "__proto__",
          "constructor",
          "prototype",
          "toString",
          "hasOwnProperty",
          "valueOf",
          "__defineGetter__",
        ]),
      };
    case "dots":
      return {
        kind,
        segment: rng.pick([
          ".",
          "..",
          "...",
          "%2e",
          "%2e%2e",
          "..%2f..%2fetc%2fpasswd",
          `${real}%2f..`,
          "%2f",
        ]),
      };
    case "injection":
      return {
        kind,
        segment: rng.pick([
          encodeURIComponent("' OR 1=1 --"),
          encodeURIComponent(`${real}' or slug is not null--`),
          encodeURIComponent("slug=eq.x&user_id=eq.22222222-2222-4222-8222-222222222222"),
          encodeURIComponent(`${real}&select=*`),
          encodeURIComponent("$ne"),
          encodeURIComponent('{"$gt":""}'),
          encodeURIComponent("<script>alert(1)</script>"),
          encodeURIComponent("{{7*7}}"),
          encodeURIComponent("%s%s%s%n"),
          encodeURIComponent(rng.string(PRINTABLE, rng.int(1, 64))),
        ]),
      };
    case "empty":
      return { kind, segment: "" };
  }
}

export type PathShape =
  | "canonical"
  | "trailing-slash"
  | "double-slash"
  | "extra-segment"
  | "query"
  | "fragment"
  | "mount-variant"
  | "dot-segment-normalised"
  | "list-neighbour";

export function buildUrl(rng: Prng, slug: SlugChoice): { url: string; shape: PathShape } {
  const shape = rng.weighted<PathShape>([
    ["canonical", 55],
    ["trailing-slash", 5],
    ["double-slash", 4],
    ["extra-segment", 5],
    ["query", 12],
    ["fragment", 3],
    ["mount-variant", 8],
    ["dot-segment-normalised", 4],
    ["list-neighbour", 4],
  ]);
  const mount =
    shape === "mount-variant"
      ? rng.pick([
          "http://edge.test/api",
          "http://edge.test",
          "http://edge.test/functions/v1/api/v1/other",
          "https://ucqnaiwqwjtgvlduiuib.functions.supabase.co/api",
        ])
      : "http://edge.test/functions/v1/api";
  let path = `/v1/catalog/drills/${slug.segment}`;
  switch (shape) {
    case "trailing-slash":
      path += "/";
      break;
    case "double-slash":
      path = rng.pick([
        `/v1/catalog/drills//${slug.segment}`,
        `/v1//catalog/drills/${slug.segment}`,
        `//v1/catalog/drills/${slug.segment}`,
      ]);
      break;
    case "extra-segment":
      path += `/${rng.string(SLUG_ALPHABET, rng.int(1, 12))}`;
      break;
    case "dot-segment-normalised":
      path = `/v1/catalog/./drills/x/../${slug.segment}`;
      break;
    case "list-neighbour":
      path = rng.pick([
        "/v1/catalog/drills",
        "/v1/catalog/drills?family=dinks",
        `/v1/catalog/drills?q=${slug.segment}`,
      ]);
      break;
  }
  let suffix = "";
  if (shape === "query") {
    const pairs = Array.from({ length: rng.int(1, 6) }, () => {
      const key = rng.pick([
        "slug",
        "user_id",
        "select",
        "q",
        "family",
        "limit",
        "offset",
        "apikey",
        "__proto__",
        rng.string(SLUG_ALPHABET, rng.int(1, 8)),
      ]);
      const value = rng.chance(0.2)
        ? rng.string("x", rng.int(1000, 20_000))
        : encodeURIComponent(rng.string(PRINTABLE, rng.int(0, 24)));
      return `${key}=${value}`;
    });
    suffix = `?${pairs.join("&")}`;
  } else if (shape === "fragment") {
    suffix = `#${rng.string(SLUG_ALPHABET, rng.int(1, 12))}`;
  }
  return { url: `${mount}${path}${suffix}`, shape };
}

// ── Header / method / fault generation ────────────────────────────────────

export type MethodChoice =
  "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "get" | "PROPFIND";

export type RequestIdKind =
  | "absent"
  | "valid"
  | "too-short"
  | "too-long"
  | "bad-chars"
  | "boundary-8"
  | "boundary-64"
  | "whitespace-padded"
  | "huge";

export type IpKind = "xff-single" | "xff-multi" | "cf" | "cf-and-xff" | "xff-garbage" | "absent";

export type FaultKind =
  | "http500-detail"
  | "rls-42501"
  | "network-throw"
  | "html-200"
  | "timeout-like-504"
  | "malformed-json-200";

export const FAULT_KINDS: readonly FaultKind[] = [
  "http500-detail",
  "rls-42501",
  "network-throw",
  "html-200",
  "timeout-like-504",
  "malformed-json-200",
];

export const SECRET_MARKER = "SECRET_UPSTREAM_DETAIL_7f3a";

export interface RequestSpec {
  iter: number;
  seed: number;
  method: MethodChoice;
  url: string;
  slug: SlugChoice;
  shape: PathShape;
  token: TokenSpec;
  requestId: { kind: RequestIdKind; value: string | null };
  ip: { kind: IpKind; headers: Record<string, string> };
  extraHeaders: Record<string, string>;
  /** Request body for non-GET/HEAD methods (never reaches the route; 404 first). */
  body: string | null;
  /** Whether the user's row exists in the stubbed `user_saved_drills`. */
  saved: boolean;
  fault: FaultKind | null;
}

const REQUEST_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";

export function buildRequestId(rng: Prng): { kind: RequestIdKind; value: string | null } {
  const kind = rng.weighted<RequestIdKind>([
    ["absent", 40],
    ["valid", 25],
    ["too-short", 6],
    ["too-long", 6],
    ["bad-chars", 10],
    ["boundary-8", 4],
    ["boundary-64", 4],
    ["whitespace-padded", 3],
    ["huge", 2],
  ]);
  switch (kind) {
    case "absent":
      return { kind, value: null };
    case "valid":
      return { kind, value: rng.string(REQUEST_ID_ALPHABET, rng.int(8, 64)) };
    case "too-short":
      return { kind, value: rng.string(REQUEST_ID_ALPHABET, rng.int(0, 7)) };
    case "too-long":
      return { kind, value: rng.string(REQUEST_ID_ALPHABET, rng.int(65, 200)) };
    case "bad-chars":
      return {
        kind,
        value: rng.pick([
          `req ${rng.string(REQUEST_ID_ALPHABET, 10)}`,
          "réq-id-ünïcode",
          "abc/def/ghi",
          "id;DROP TABLE",
          "%0d%0aInjected",
          '"quoted-id"',
          "<b>bold</b>",
          `${rng.string(REQUEST_ID_ALPHABET, 10)}\t`,
        ]),
      };
    case "boundary-8":
      return { kind, value: rng.string(REQUEST_ID_ALPHABET, 8) };
    case "boundary-64":
      return { kind, value: rng.string(REQUEST_ID_ALPHABET, 64) };
    case "whitespace-padded":
      return { kind, value: `  ${rng.string(REQUEST_ID_ALPHABET, 12)}  ` };
    case "huge":
      return { kind, value: rng.string(REQUEST_ID_ALPHABET, rng.int(4_000, 16_000)) };
  }
}

export function buildIp(
  rng: Prng,
  iter: number,
): { kind: IpKind; headers: Record<string, string> } {
  // Distinct per iteration so the per-IP and auth-failure budgets never trip by accident.
  const ip = `10.${(iter >> 16) & 255}.${(iter >> 8) & 255}.${iter & 255}`;
  const kind = rng.weighted<IpKind>([
    ["xff-single", 45],
    ["xff-multi", 20],
    ["cf", 20],
    ["cf-and-xff", 8],
    ["xff-garbage", 5],
    ["absent", 2],
  ]);
  switch (kind) {
    case "xff-single":
      return { kind, headers: { "x-forwarded-for": ip } };
    case "xff-multi":
      return {
        kind,
        headers: {
          "x-forwarded-for": `${rng.pick(["1.1.1.1", "unknown", "::1", "spoofed"])}, 203.0.113.${rng.int(0, 255)}, ${ip}`,
        },
      };
    case "cf":
      return { kind, headers: { "cf-connecting-ip": ip } };
    case "cf-and-xff":
      return { kind, headers: { "cf-connecting-ip": ip, "x-forwarded-for": "9.9.9.9" } };
    case "xff-garbage":
      return {
        kind,
        headers: {
          "x-forwarded-for": `${rng.string(PRINTABLE.replace(/[,\r\n]/g, ""), rng.int(1, 40))}, ${ip}`,
        },
      };
    case "absent":
      return { kind, headers: {} };
  }
}

export function buildExtraHeaders(rng: Prng): Record<string, string> {
  const headers: Record<string, string> = {};
  if (rng.chance(0.15)) {
    headers["content-length"] = rng.pick([
      "0",
      "1",
      "5000000",
      "5000001",
      "6000000",
      "1e7",
      "-1",
      "abc",
      " 6000000 ",
      "0x4C4B40",
      "99999999999999999999",
      "Infinity",
      "NaN",
    ]);
  }
  if (rng.chance(0.2))
    headers["content-type"] = rng.pick([
      "application/json",
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "ä/ö",
      "application/json; charset=utf-16",
    ]);
  if (rng.chance(0.2))
    headers["accept"] = rng.pick([
      "*/*",
      "application/json",
      "text/html",
      "application/xml",
      "image/*",
      "application/vnd.pgrst.object+json",
    ]);
  if (rng.chance(0.1)) headers["range"] = rng.pick(["bytes=0-1", "bytes=-1", "items=0-9"]);
  if (rng.chance(0.1)) headers["if-none-match"] = rng.pick(['"abc"', "*", 'W/"x"']);
  if (rng.chance(0.1))
    headers["cache-control"] = rng.pick(["no-cache", "max-age=0", "only-if-cached"]);
  if (rng.chance(0.1)) headers["x-http-method-override"] = rng.pick(["DELETE", "PUT", "POST"]);
  if (rng.chance(0.1)) headers["x-forwarded-host"] = rng.pick(["evil.example", "localhost"]);
  if (rng.chance(0.1)) headers["x-forwarded-proto"] = rng.pick(["http", "gopher"]);
  if (rng.chance(0.1)) headers["origin"] = rng.pick(["https://evil.example", "null"]);
  if (rng.chance(0.08)) headers["accept-encoding"] = rng.pick(["gzip", "br", "identity;q=0", "*"]);
  if (rng.chance(0.08)) headers["apikey"] = rng.string(REQUEST_ID_ALPHABET, rng.int(1, 100));
  if (rng.chance(0.08))
    headers["prefer"] = rng.pick([
      "return=representation",
      "count=exact",
      "resolution=merge-duplicates",
    ]);
  if (rng.chance(0.05)) headers["user-agent"] = rng.string(PRINTABLE, rng.int(0, 400));
  if (rng.chance(0.05))
    headers["cookie"] = `sb-access-token=${rng.string(REQUEST_ID_ALPHABET, 40)}`;
  if (rng.chance(0.05))
    headers[`x-${rng.string(SLUG_ALPHABET.replace("-", ""), rng.int(1, 12))}`] = rng.string(
      PRINTABLE,
      rng.int(0, 200),
    );
  return headers;
}

export function buildBody(rng: Prng, method: MethodChoice): string | null {
  if (method === "GET" || method === "HEAD" || method === "get") return null;
  if (rng.chance(0.3)) return null;
  return rng.pick([
    "{}",
    "[]",
    "null",
    '{"slug":"wall-dink-rally"}',
    '{"__proto__":{"admin":true}}',
    rng.string(PRINTABLE, rng.int(1, 2000)),
    "{" + '"a":'.repeat(500),
    rng.string("x", rng.int(100_000, 300_000)),
  ]);
}

export function generateSpec(
  campaignSeed: number,
  iter: number,
  catalog: readonly CatalogDrillRecord[],
): RequestSpec {
  const seed = iterationSeed(campaignSeed, iter);
  const rng = new Prng(seed);
  const method = rng.weighted<MethodChoice>([
    ["GET", 84],
    ["HEAD", 3],
    ["POST", 3],
    ["PUT", 2],
    ["PATCH", 2],
    ["DELETE", 2],
    ["OPTIONS", 2],
    ["get", 1],
    ["PROPFIND", 1],
  ]);
  const slug = chooseSlug(rng, catalog);
  const { url, shape } = buildUrl(rng, slug);
  const tokenKind = rng.weighted<TokenKind>([
    ["google", 30],
    ["apple", 10],
    ["session", 18],
    ["session-unknown", 3],
    ["session-expired", 2],
    ["none", 5],
    ["empty-bearer", 2],
    ["lowercase-bearer", 2],
    ["basic", 1],
    ["garbage", 3],
    ["jwt-2seg", 1],
    ["jwt-4seg", 1],
    ["jwt-bad-b64", 2],
    ["jwt-payload-array", 1],
    ["jwt-payload-string", 1],
    ["jwt-payload-null", 1],
    ["jwt-payload-number", 1],
    ["jwt-iss-number", 1],
    ["jwt-iss-lookalike", 3],
    ["jwt-iss-http-google", 1],
    ["jwt-iss-suffix-auth-v1-only", 1],
    ["jwt-expired-google", 3],
    ["jwt-exp-string", 1],
    ["jwt-exp-huge", 1],
    ["jwt-huge-claims", 1],
    ["jwt-unicode-claims", 1],
    ["jwt-no-sub", 1],
  ]);
  // Mostly distinct users so the 240/min per-user budget is never reached by
  // accident; a small share reuses two fixed ids to exercise the auth cache.
  const sub = rng.chance(0.9)
    ? rng.uuid()
    : rng.pick(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  const token: TokenSpec = { kind: tokenKind, sub };
  const requestId = buildRequestId(rng);
  const ip = buildIp(rng, iter);
  const extraHeaders = buildExtraHeaders(rng);
  const body = buildBody(rng, method);
  const saved = rng.chance(0.5);
  const fault = rng.chance(0.08) ? rng.pick(FAULT_KINDS) : null;
  return {
    iter,
    seed,
    method,
    url,
    slug,
    shape,
    token,
    requestId,
    ip,
    extraHeaders,
    body,
    saved,
    fault,
  };
}

// ── Oracle: what the contract says this request must produce ──────────────

export const CATALOG_DETAIL_RE = /^\/v1\/catalog\/drills\/([^/]+)$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 5_000_000;

export interface Expectation {
  status: number;
  /** Route-level reason (for the JSON table). */
  reason: string;
  /** Decoded slug when the request reaches the catalog lookup. */
  decodedSlug: string | null;
  inCatalog: boolean;
}

export function routePath(url: string): string {
  const pathname = new URL(url).pathname;
  const marker = pathname.lastIndexOf("/v1/");
  return marker >= 0 ? pathname.slice(marker) : pathname;
}

export function expectationFor(spec: RequestSpec, catalogSlugs: ReadonlySet<string>): Expectation {
  const declaredLength = Number(spec.extraHeaders["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return {
      status: 413,
      reason: "declared body too large (pre-auth)",
      decodedSlug: null,
      inCatalog: false,
    };
  }
  if (!AUTHENTICATED_KINDS.has(spec.token.kind)) {
    return {
      status: 401,
      reason: `bearer refused (${spec.token.kind})`,
      decodedSlug: null,
      inCatalog: false,
    };
  }
  const path = routePath(spec.url);
  // The Request constructor normalises the standard methods case-insensitively.
  if (spec.method.toUpperCase() !== "GET") {
    return {
      status: 404,
      reason: `method ${spec.method} has no route`,
      decodedSlug: null,
      inCatalog: false,
    };
  }
  if (path === "/v1/catalog/drills") {
    // The list route reads user_saved_drills too, so an injected fault surfaces there as well.
    if (spec.fault)
      return {
        status: 503,
        reason: `list neighbour, PostgREST fault ${spec.fault}`,
        decodedSlug: null,
        inCatalog: false,
      };
    return { status: 200, reason: "list neighbour", decodedSlug: null, inCatalog: false };
  }
  const match = CATALOG_DETAIL_RE.exec(path);
  if (!match) {
    return { status: 404, reason: "no route", decodedSlug: null, inCatalog: false };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return {
      status: 400,
      reason: "malformed percent-encoding",
      decodedSlug: null,
      inCatalog: false,
    };
  }
  if (!catalogSlugs.has(decoded)) {
    return { status: 404, reason: "slug not in catalog", decodedSlug: decoded, inCatalog: false };
  }
  if (spec.fault) {
    return {
      status: 503,
      reason: `PostgREST fault ${spec.fault}`,
      decodedSlug: decoded,
      inCatalog: true,
    };
  }
  return { status: 200, reason: "catalog detail", decodedSlug: decoded, inCatalog: true };
}

// ── Execution ────────────────────────────────────────────────────────────

export interface UpstreamCall {
  method: string;
  url: string;
  authorization: string | null;
}

export interface IterationResult {
  iter: number;
  seed: number;
  category: string;
  method: string;
  url: string;
  tokenKind: TokenKind;
  sub: string;
  requestIdKind: RequestIdKind;
  ipKind: IpKind;
  extraHeaders: Record<string, string>;
  fault: FaultKind | null;
  saved: boolean;
  expected: number;
  reason: string;
  status: number;
  responseRequestId: string | null;
  bodyBytes: number;
  durationMs: number;
  upstream: UpstreamCall[];
  logLines: number;
  violations: string[];
  /** Behaviour worth reporting that is not a contract violation. */
  observations: string[];
  /** Populated only for violations / 5xx so the table stays small. */
  bodySnippet?: string;
}

export interface StressContext {
  harness: Harness;
  catalog: readonly CatalogDrillRecord[];
  catalogSlugs: ReadonlySet<string>;
  upstream: UpstreamCall[];
  fault: { current: FaultKind | null };
  consoleLines: string[];
  restore: () => void;
}

let sharedContext: StressContext | null = null;

/** Load the real handler once and install the fetch/console wrappers. Idempotent. */
export async function stressContext(): Promise<StressContext> {
  if (sharedContext) {
    sharedContext.harness.reset();
    sharedContext.upstream.length = 0;
    sharedContext.consoleLines.length = 0;
    sharedContext.fault.current = null;
    return sharedContext;
  }
  const harness = await loadHarness();
  const catalog = await drillCatalog();
  const catalogSlugs = new Set(catalog.map((drill) => drill.slug));
  const upstream: UpstreamCall[] = [];
  const fault = { current: null as FaultKind | null };
  const consoleLines: string[] = [];

  const stubFetch = globalThis.fetch;
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    upstream.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    if (request.method === "GET" && request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const userId = knownSessions.get(bearer);
      if (!userId)
        return jsonResponse(401, {
          code: 401,
          msg: "invalid JWT: unable to parse or verify signature",
        });
      return jsonResponse(200, {
        id: userId,
        aud: "authenticated",
        role: "authenticated",
        email: "user@example.com",
        app_metadata: { provider: "google", providers: ["google"] },
      });
    }
    if (fault.current && request.url.startsWith(`${SUPABASE_URL}/rest/v1/user_saved_drills`)) {
      const kind = fault.current;
      switch (kind) {
        case "http500-detail":
          return jsonResponse(500, {
            message: `internal error ${SECRET_MARKER}`,
            details: `at pg_catalog.fn (${SECRET_MARKER}.sql:12)`,
            hint: SECRET_MARKER,
            code: "XX000",
          });
        case "rls-42501":
          return jsonResponse(401, {
            code: "42501",
            message: `permission denied for table user_saved_drills ${SECRET_MARKER}`,
            details: null,
            hint: null,
          });
        case "network-throw":
          throw new TypeError(`error sending request for url (${request.url}) ${SECRET_MARKER}`);
        case "html-200":
          return new Response(`<html><body>Bad gateway ${SECRET_MARKER}</body></html>`, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        case "timeout-like-504":
          return new Response(`upstream request timeout ${SECRET_MARKER}`, { status: 504 });
        case "malformed-json-200":
          return new Response(`{"slug": "wall-dink-rally", ${SECRET_MARKER}`, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
      }
    }
    return await stubFetch(request);
  }) as typeof fetch;

  const realError = console.error;
  const realWarn = console.warn;
  const capture = (...args: unknown[]) => {
    consoleLines.push(
      args.map((arg) => (typeof arg === "string" ? arg : safeStringify(arg))).join(" "),
    );
  };
  console.error = capture;
  console.warn = capture;

  sharedContext = {
    harness,
    catalog,
    catalogSlugs,
    upstream,
    fault,
    consoleLines,
    restore() {
      globalThis.fetch = stubFetch;
      console.error = realError;
      console.warn = realWarn;
      sharedContext = null;
    },
  };
  return sharedContext;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const STACK_MARKERS = [
  SECRET_MARKER,
  "\n    at ",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "PGRST",
  "42501",
  "user_saved_drills",
  "supabase.test",
  "pg_catalog",
  "at async",
];
const GENERIC_503 = new Set([
  "Drill detail is temporarily unavailable. Please try again.",
  "Drill catalog is temporarily unavailable. Please try again.",
]);
/** postgrest-js 2.112.4 re-sends idempotent reads on network faults
 * (DEFAULT_MAX_RETRIES = 3, backoff 1s/2s/4s) — one logical read may be up to
 * four upstream calls. */
const MAX_DB_ATTEMPTS_PER_READ = 4;
const GENERIC_500 = "Something went wrong. Please try again.";
const ALLOWED_STATUSES = new Set([200, 400, 401, 403, 404, 405, 413, 415, 429]);

export function buildRequest(spec: RequestSpec, rng: Prng): Request {
  const headers = new Headers();
  const authorization = buildAuthorization(spec.token, rng);
  if (authorization !== null) headers.set("Authorization", authorization);
  if (spec.requestId.value !== null) headers.set("x-request-id", spec.requestId.value);
  for (const [key, value] of Object.entries(spec.ip.headers)) headers.set(key, value);
  for (const [key, value] of Object.entries(spec.extraHeaders)) headers.set(key, value);
  return new Request(spec.url, { method: spec.method, headers, body: spec.body });
}

export async function runIteration(
  ctx: StressContext,
  spec: RequestSpec,
): Promise<IterationResult> {
  const { harness } = ctx;
  harness.reset();
  ctx.upstream.length = 0;
  ctx.consoleLines.length = 0;
  ctx.fault.current = spec.fault;
  harness.tables.user_saved_drills =
    spec.saved && spec.slug.kind !== "empty" ? [{ slug: decodeSafely(spec.slug.segment) }] : [];

  const rng = new Prng(spec.seed ^ 0x9e3779b9);
  const expectation = expectationFor(spec, ctx.catalogSlugs);
  const violations: string[] = [];
  const observations: string[] = [];
  const base: Omit<
    IterationResult,
    | "status"
    | "responseRequestId"
    | "bodyBytes"
    | "durationMs"
    | "upstream"
    | "logLines"
    | "violations"
    | "observations"
  > = {
    iter: spec.iter,
    seed: spec.seed,
    category: `${spec.slug.kind}/${spec.shape}/${spec.token.kind}`,
    method: spec.method,
    url: spec.url,
    tokenKind: spec.token.kind,
    sub: spec.token.sub,
    requestIdKind: spec.requestId.kind,
    ipKind: spec.ip.kind,
    extraHeaders: spec.extraHeaders,
    fault: spec.fault,
    saved: spec.saved,
    expected: expectation.status,
    reason: expectation.reason,
  };

  let request: Request;
  try {
    request = buildRequest(spec, rng);
  } catch (error) {
    // The CLIENT could not even form this request (e.g. a header value Deno's
    // Headers refuses). Not a handler outcome — surfaced so the count is honest.
    return {
      ...base,
      status: -1,
      responseRequestId: null,
      bodyBytes: 0,
      durationMs: 0,
      upstream: [],
      logLines: 0,
      violations: [],
      observations: [
        `request-not-constructible: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";

  const logs: string[] = [];
  const startedAt = performance.now();
  let response: Response;
  let bodyText = "";
  const stopCapture = captureAccessLog((line) => logs.push(line));
  try {
    response = await harness.handler(request);
    bodyText = await response.text();
  } catch (error) {
    stopCapture();
    return {
      ...base,
      status: -2,
      responseRequestId: null,
      bodyBytes: 0,
      durationMs: performance.now() - startedAt,
      upstream: [...ctx.upstream],
      logLines: logs.length,
      violations: [`handler-threw: ${error instanceof Error ? error.message : String(error)}`],
      observations: [],
      bodySnippet:
        error instanceof Error ? (error.stack ?? error.message).slice(0, 400) : String(error),
    };
  }
  stopCapture();
  const durationMs = performance.now() - startedAt;
  ctx.fault.current = null;
  if (durationMs > 1000) observations.push(`slow-response:${Math.round(durationMs / 1000)}s`);

  const status = response.status;
  const responseRequestId = response.headers.get("x-request-id");
  const upstream = [...ctx.upstream];

  // 1. status set
  const allowed = ALLOWED_STATUSES.has(status) || (status === 503 && spec.fault !== null);
  if (!allowed) violations.push(`status-not-allowed:${status}`);
  // 429 is only tolerated when the request could not carry a distinct IP.
  if (status === 429 && spec.ip.kind !== "absent") violations.push("unexpected-429");
  if (status !== expectation.status && !(status === 429 && spec.ip.kind === "absent")) {
    violations.push(`status-mismatch:expected=${expectation.status}:got=${status}`);
  }

  // 2. request id
  if (!responseRequestId) violations.push("request-id-missing");
  else {
    const clientId = spec.requestId.value;
    if (clientId !== null && REQUEST_ID_RE.test(clientId.trim())) {
      if (responseRequestId !== clientId.trim()) violations.push("request-id-not-echoed");
    } else {
      if (!UUID_RE.test(responseRequestId)) violations.push("request-id-not-uuid");
      if (clientId !== null && responseRequestId === clientId)
        violations.push("invalid-request-id-echoed");
    }
  }

  // 3. body / headers
  const contentType = response.headers.get("content-type") ?? "";
  let parsed: unknown = undefined;
  if (spec.method !== "HEAD") {
    if (!contentType.includes("application/json"))
      violations.push(`content-type:${contentType || "(none)"}`);
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      violations.push("body-not-json");
    }
  }
  if (response.headers.get("x-content-type-options") !== "nosniff")
    violations.push("missing-nosniff");
  if (response.headers.get("cache-control") !== "no-store") violations.push("missing-no-store");
  for (const marker of STACK_MARKERS) {
    if (bodyText.includes(marker)) violations.push(`body-leak:${marker.trim()}`);
  }
  // Short garbage bearers ("k") occur in any English sentence; only a
  // credential-length token appearing in the body is a leak.
  if (bearer.length >= 16 && bodyText.includes(bearer)) violations.push("body-leak:bearer");
  if (status >= 500) {
    const message = errorMessageOf(parsed);
    const generic = status === 503 ? GENERIC_503.has(message ?? "") : message === GENERIC_500;
    if (!generic) violations.push(`5xx-not-generic:${JSON.stringify(message).slice(0, 120)}`);
    if (
      status === 503 &&
      response.headers.get("retry-after") !== null &&
      !/^\d+$/.test(response.headers.get("retry-after") ?? "")
    ) {
      violations.push("retry-after-not-integer");
    }
  }
  if (status === 429) {
    for (const header of ["retry-after", "ratelimit-limit", "ratelimit-remaining"]) {
      if (!response.headers.has(header)) violations.push(`429-missing-${header}`);
    }
  }
  if (bodyText.length > 16_384) observations.push(`large-body:${bodyText.length}`);

  // 4. upstream discipline
  const writes = upstream.filter(
    (call) =>
      /^(POST|PATCH|PUT|DELETE)$/.test(call.method) &&
      (call.url.includes("/rest/v1/") || call.url.includes("/auth/v1/admin")),
  );
  if (writes.length > 0)
    violations.push(
      `upstream-write:${writes.map((w) => `${w.method} ${new URL(w.url).pathname}`).join("|")}`,
    );
  const dbReads = upstream.filter((call) => call.url.includes("/rest/v1/"));
  const authCalls = upstream.filter((call) => call.url.includes("/auth/v1/"));
  const otherCalls = upstream.filter(
    (call) => !call.url.includes("/rest/v1/") && !call.url.includes("/auth/v1/"),
  );
  if (otherCalls.length > 0)
    violations.push(`unexpected-upstream:${otherCalls.map((c) => c.url).join("|")}`);
  if (status !== 200 && status !== 503 && dbReads.length > 0)
    violations.push(`db-call-on-rejection:${status}`);
  if (LOCALLY_REFUSED_KINDS.has(spec.token.kind) && authCalls.length > 0)
    violations.push("auth-upstream-called-for-locally-refusable-bearer");
  if (UPSTREAM_REFUSED_KINDS.has(spec.token.kind) && status === 401 && authCalls.length !== 1)
    violations.push(`upstream-refusal-auth-calls:${authCalls.length}`);
  if (status === 413 && (authCalls.length > 0 || dbReads.length > 0))
    violations.push("work-after-413");
  if (authCalls.length > 1) violations.push(`auth-calls:${authCalls.length}`);
  if (dbReads.length > 1) {
    if (spec.fault === "network-throw" && dbReads.length <= MAX_DB_ATTEMPTS_PER_READ)
      observations.push(`db-read-retried:${dbReads.length}`);
    else violations.push(`db-reads:${dbReads.length}`);
  }
  for (const read of dbReads) {
    const url = new URL(read.url);
    if (url.pathname !== "/rest/v1/user_saved_drills")
      violations.push(`db-read-wrong-table:${url.pathname}`);
    const userFilter = url.searchParams.get("user_id");
    const slugFilter = url.searchParams.get("slug");
    if (expectation.decodedSlug !== null && slugFilter !== `eq.${expectation.decodedSlug}`)
      violations.push(`db-read-slug-filter:${slugFilter}`);
    if (!userFilter || !userFilter.startsWith("eq.")) violations.push("db-read-unscoped-user");
    if (!read.authorization?.startsWith("Bearer ")) violations.push("db-read-no-bearer");
  }

  // 5. shape per status
  if (status === 200 && expectation.inCatalog && parsed !== undefined) {
    const body = parsed as Record<string, unknown>;
    const drill = body.drill as Record<string, unknown> | undefined;
    const entry = ctx.catalog.find((d) => d.slug === expectation.decodedSlug)!;
    if (!drill || drill.slug !== entry.slug) violations.push("200-drill-slug");
    else {
      if (drill.id !== entry.id) violations.push("200-drill-id");
      if (drill.title !== entry.title) violations.push("200-drill-title");
      if (drill.saved !== spec.saved)
        violations.push(`200-saved-flag:expected=${spec.saved}:got=${String(drill.saved)}`);
      if ("families" in drill || "validation_state" in drill)
        violations.push("200-leaks-internal-fields");
      if (!Array.isArray(drill.equipment)) violations.push("200-equipment-not-array");
    }
    if (!Array.isArray(body.mappings) || body.mappings.length !== 0)
      violations.push("200-mappings");
    if (!Array.isArray(body.instructionalMedia)) violations.push("200-media-not-array");
    else {
      for (const media of body.instructionalMedia as Record<string, unknown>[]) {
        if (
          typeof media.embedUrl !== "string" ||
          !media.embedUrl.startsWith("https://www.youtube-nocookie.com/embed/")
        )
          violations.push("200-media-embed-url");
      }
    }
    if (dbReads.length !== 1) violations.push(`200-db-reads:${dbReads.length}`);
    // The db read must act as the authenticated user (harness mints `session-for-<sub>`
    // for provider tokens; session bearers act as themselves).
    const userFilter = dbReads[0] ? new URL(dbReads[0].url).searchParams.get("user_id") : null;
    const expectedUser = expectedUserId(spec);
    if (expectedUser !== null && userFilter !== `eq.${expectedUser}`)
      violations.push(`db-read-user-filter:${userFilter}`);
  }
  if (status === 404 && expectation.reason === "slug not in catalog") {
    if (errorCodeOf(parsed) !== "drill.not_found") violations.push("404-not-coded");
    if (dbReads.length !== 0) violations.push("404-hit-db");
  }
  if (status === 400) {
    if (errorMessageOf(parsed) !== "Malformed path segment.")
      violations.push(`400-message:${errorMessageOf(parsed)}`);
    if (dbReads.length !== 0) violations.push("400-hit-db");
  }
  if (status === 404 && expectation.reason !== "slug not in catalog") {
    const message = errorMessageOf(parsed) ?? "";
    if (message.startsWith("Unknown endpoint: "))
      observations.push(`path-reflected-in-404:${message.length}`);
  }
  if (spec.method === "HEAD" && status !== 200 && status !== 405)
    observations.push(`head-status:${status}`);

  // 6. access log
  if (logs.length !== 1) violations.push(`access-log-lines:${logs.length}`);
  else {
    let line: Record<string, unknown> = {};
    try {
      line = JSON.parse(logs[0]) as Record<string, unknown>;
    } catch {
      violations.push("access-log-not-json");
    }
    if (line.requestId !== responseRequestId) violations.push("access-log-request-id");
    if (line.status !== status) violations.push(`access-log-status:${String(line.status)}`);
    if (line.evt !== "api_request") violations.push("access-log-event");
    if (typeof line.route === "string" && line.route.length > 512)
      observations.push(`access-log-route-length:${line.route.length}`);
    for (const key of ["ip", "userId", "bearer", "query", "body"]) {
      if (key in line) violations.push(`access-log-field:${key}`);
    }
  }
  const joinedLogs = [...logs, ...ctx.consoleLines].join("\n");
  if (bearer && bearer.length >= 16 && joinedLogs.includes(bearer))
    violations.push("log-leak:bearer");
  if (status >= 500 && ctx.consoleLines.length === 0) observations.push("5xx-without-operator-log");
  if (status < 500 && ctx.consoleLines.some((l) => l.includes("unhandled")))
    violations.push("unhandled-error-logged-on-4xx");

  const result: IterationResult = {
    ...base,
    status,
    responseRequestId,
    bodyBytes: bodyText.length,
    durationMs,
    upstream,
    logLines: logs.length,
    violations,
    observations,
  };
  if (violations.length > 0 || status >= 500) result.bodySnippet = bodyText.slice(0, 400);
  return result;
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function errorMessageOf(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const error = (parsed as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}

function errorCodeOf(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const error = (parsed as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

/** The user id the handler must scope the read to, or null when the stub
 * decides it (jwt-no-sub → TEST_USER_ID fallback is a stub detail). */
function expectedUserId(spec: RequestSpec): string | null {
  switch (spec.token.kind) {
    case "google":
    case "apple":
    case "session":
    case "jwt-exp-string":
    case "jwt-exp-huge":
    case "jwt-huge-claims":
    case "jwt-unicode-claims":
    case "jwt-iss-http-google":
      return spec.token.sub;
    default:
      return null;
  }
}

// ── Campaign ─────────────────────────────────────────────────────────────

export interface CampaignReport {
  unit: string;
  lens: string;
  campaignSeed: number;
  iterationsRequested: number;
  iterationsExecuted: number;
  notConstructible: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  statusHistogram: Record<string, number>;
  tokenKindHistogram: Record<string, number>;
  slugKindHistogram: Record<string, number>;
  violationHistogram: Record<string, number>;
  observationHistogram: Record<string, number>;
  failingSeeds: { iter: number; seed: number; replay: string; violations: string[] }[];
  fiveXx: {
    iter: number;
    seed: number;
    status: number;
    fault: FaultKind | null;
    deliberate: boolean;
  }[];
  heap: { iter: number; heapUsed: number; rss: number }[];
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  rows: IterationResult[];
}

export const UNIT = "route-get-v1-catalog-drills-slug";
export const LENS = "fuzz-boundary";

export function replayCommand(campaignSeed: number, iter: number): string {
  return `STRESS_SEED=${campaignSeed} STRESS_REPLAY=${iter} deno test -A --no-check --config deno.json stress_catalog_drills_slug_fuzz.test.ts`;
}

export async function runCampaign(
  ctx: StressContext,
  campaignSeed: number,
  iterations: number,
  options: { only?: number[]; onProgress?: (done: number) => void } = {},
): Promise<CampaignReport> {
  const startedAt = new Date();
  const rows: IterationResult[] = [];
  const heap: CampaignReport["heap"] = [];
  const iters = options.only ?? Array.from({ length: iterations }, (_, i) => i);
  const sample = () => {
    const usage = Deno.memoryUsage();
    heap.push({ iter: rows.length, heapUsed: usage.heapUsed, rss: usage.rss });
  };
  sample();
  for (const iter of iters) {
    const spec = generateSpec(campaignSeed, iter, ctx.catalog);
    rows.push(await runIteration(ctx, spec));
    if (rows.length % 500 === 0) {
      sample();
      options.onProgress?.(rows.length);
    }
  }
  sample();
  const finishedAt = new Date();
  const count = (pick: (row: IterationResult) => string[]) => {
    const histogram: Record<string, number> = {};
    for (const row of rows) for (const key of pick(row)) histogram[key] = (histogram[key] ?? 0) + 1;
    return Object.fromEntries(Object.entries(histogram).sort(([a], [b]) => a.localeCompare(b)));
  };
  const executed = rows.filter((row) => row.status >= 0);
  const durations = executed.map((row) => row.durationMs).sort((a, b) => a - b);
  const quantile = (q: number) =>
    durations.length
      ? durations[Math.min(durations.length - 1, Math.floor(q * durations.length))]
      : 0;
  return {
    unit: UNIT,
    lens: LENS,
    campaignSeed,
    iterationsRequested: iters.length,
    iterationsExecuted: executed.length,
    notConstructible: rows.length - executed.length,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    statusHistogram: count((row) => [String(row.status)]),
    tokenKindHistogram: count((row) => [row.tokenKind]),
    slugKindHistogram: count((row) => [row.category.split("/")[0]]),
    violationHistogram: count((row) => row.violations.map((v) => v.split(":")[0])),
    observationHistogram: count((row) => row.observations.map((o) => o.split(":")[0])),
    failingSeeds: rows
      .filter((row) => row.violations.length > 0)
      .map((row) => ({
        iter: row.iter,
        seed: row.seed,
        replay: replayCommand(campaignSeed, row.iter),
        violations: row.violations,
      })),
    fiveXx: rows
      .filter((row) => row.status >= 500)
      .map((row) => ({
        iter: row.iter,
        seed: row.seed,
        status: row.status,
        fault: row.fault,
        deliberate: row.fault !== null,
      })),
    heap,
    latencyMs: {
      p50: quantile(0.5),
      p95: quantile(0.95),
      p99: quantile(0.99),
      max: durations[durations.length - 1] ?? 0,
    },
    rows,
  };
}

export function outDir(): string {
  const configured = Deno.env.get("STRESS_OUT_DIR");
  if (configured) return configured;
  return new URL("../../../../artifacts/stress/route-get-v1-catalog-drills-slug/", import.meta.url)
    .pathname;
}

export async function writeReport(name: string, report: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir.endsWith("/") ? dir : `${dir}/`}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 1));
  return path;
}
