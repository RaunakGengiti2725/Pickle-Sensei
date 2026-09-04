// STRESS · fuzz-boundary — POST /v1/analysis-permits (edge route).
//
// Drives the REAL handler (../index.ts, Deno.serve captured) over the stateful
// fake in xc_concurrency_harness.ts (GoTrue sessions, PostgREST rows, the
// reserve_analysis_permit / access_state RPC model, RevenueCat) with a SEEDED
// stream of generated requests: methods, path shapes, headers (Authorization,
// Content-Length, Content-Type, x-request-id, x-forwarded-for), and bodies
// (valid keys at every boundary, wrong types, malformed JSON, raw bytes,
// oversize streams). Every iteration is replayable from (STRESS_SEED, index).
//
// Contract asserted per request (never an observed defect):
//   1. status ∈ {200, 402} for a well-formed reserve, otherwise ∈
//      {400, 401, 403, 404, 405, 413, 415, 429}; NEVER 5xx;
//   2. a 5xx body — should one ever appear — is the generic shape (no detail,
//      no stack, no SQL/PGRST/file-path fragments); no body of any status
//      carries stack-trace markers;
//   3. `x-request-id` on every response (a well-formed client id is honoured,
//      anything else is replaced by a UUID);
//   4. no write on rejection: the permits table grows by exactly one row for
//      a fresh accepted key and by ZERO rows for anything else (replays,
//      402s, 4xx);
//   5. duplicate delivery: the same (user, key) always answers the same
//      permit id; a free account never holds more than two reserved permits.
//
// Scale: STRESS_ITER generated requests (default 300 so the suite stays fast;
// the campaign runs STRESS_ITER=3000+), STRESS_SEED=20260904,
// STRESS_USERS=200 bootstrapped accounts (~20% premium). Output:
// <STRESS_OUT_DIR>/analysis_permits_fuzz.json (seed → outcome table).
//
//   STRESS_SEED=20260904 STRESS_ITER=3000 deno test -A --no-check --config deno.json \
//     stress_analysis_permits_fuzz.test.ts
//   STRESS_ONLY=<index> replays a single iteration against fresh state.

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  b64url,
  bootstrap,
  envInt,
  fakeGoogleIdToken,
  histogram,
  isRecord,
  loadXcHarness,
  Prng,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 300);
const STRESS_USERS = envInt("STRESS_USERS", 200);
const STRESS_ONLY = Deno.env.get("STRESS_ONLY");
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 1) - 1; // default 0

function stressOutDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress/route-post-v1-analysis-permits/",
    import.meta.url,
  )
    .pathname;
}

const BASE = "http://edge.xc.test/functions/v1/api";
/** Mount prefixes the router must treat alike (it keys on the LAST `/v1/`). */
const BASES = [
  BASE,
  "http://edge.xc.test",
  "http://edge.xc.test/api",
  "http://edge.xc.test/functions/v1/api/",
];
const ROUTE = "/v1/analysis-permits";
const MAX_BODY = 5_000_000;
const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const GOOD_STATUSES = new Set([200, 402]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const STACK_MARKERS = [
  /\n\s+at\s/,
  /\bTypeError\b/,
  /\bRangeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /index\.ts/,
  /\.ts:\d+/,
  /PGRST\d+/,
  /\bpostgres\b/i,
  /\bsupabase\b/i,
  /\bunexpected fetch\b/,
];
const GENERIC_5XX = [
  /^\{"error":\{"message":"[A-Za-z ]+ is temporarily unavailable\. Please try again\."\}\}$/,
  /^\{"error":\{"message":"Something went wrong\. Please try again\."\}\}$/,
];

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ── Users ────────────────────────────────────────────────────────────────────

interface User {
  index: number;
  sub: string;
  accessToken: string;
  providerToken: string;
  premium: boolean;
}

async function mintUsers(
  h: XcHarness,
  prng: Prng,
  count: number,
): Promise<User[]> {
  const users: User[] = [];
  for (let i = 0; i < count; i++) {
    const sub = prng.uuid();
    const ip = `198.51.${(i >> 8) & 0xff}.${i & 0xff}`;
    const boot = await bootstrap(h, sub, ip);
    assertEquals(
      boot.status,
      200,
      `bootstrap of user ${i} (${sub}) failed: ${boot.status}`,
    );
    const premium = prng.next() < 0.2;
    if (premium) {
      h.fake.tables.billing_entitlements.push({
        user_id: sub,
        premium: true,
        expires_at: null,
        product_key: "pickle_sensei_pro_lifetime",
      });
    }
    users.push({
      index: i,
      sub,
      accessToken: boot.accessToken,
      providerToken: fakeGoogleIdToken(sub),
      premium,
    });
  }
  return users;
}

// ── Generators ───────────────────────────────────────────────────────────────

type Category =
  | "valid"
  | "replay"
  | "body"
  | "auth"
  | "route"
  | "headers"
  | "oversize";

interface Spec {
  index: number;
  category: Category;
  method: string;
  base: string;
  path: string;
  headers: Record<string, string>;
  /** string | bytes | stream(byteLength) | none */
  body:
    | { kind: "text"; text: string }
    | { kind: "bytes"; bytes: Uint8Array<ArrayBuffer> }
    | {
      kind: "stream";
      byteLength: number;
    }
    | { kind: "none" };
  user: User | null;
  /** True when the bearer is one the fake GoTrue will accept. */
  authValid: boolean;
  /** Oracle: the idempotencyKey ../index.ts will read, or null → 400. */
  keyAccepted: string | null;
  /** Oracle: declared Content-Length > MAX_BODY → 413 before auth. */
  declaredTooLarge: boolean;
  /** Oracle: streamed body exceeds MAX_BODY → 413 from readBoundedText. */
  streamTooLarge: boolean;
  /** Oracle: route matches exactly POST /v1/analysis-permits. */
  routeHit: boolean;
  /** Oracle: what x-request-id must come back (null → any UUID). */
  requestIdEcho: string | null;
  replayOf?: number;
}

const ASCII =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:";
const UNICODE_BMP = "éüñßæøåДЖЯλπΩשלום日本語한글ไทย";
const ASTRAL = ["😀", "🎾", "🏓", "𝔘", "𐍈", "👩‍🦰"];
const CONTROL = [
  "\u0000",
  "\u0001",
  "\u0007",
  "\b",
  "\t",
  "\n",
  "\r",
  "\u001b",
  "\u007f",
  "\u200b",
  "\u202e",
  "\ufeff",
];
const INJECTION = [
  "' or 1=1 --",
  '"; drop table analysis_permits; --',
  "{{7*7}}",
  "${jndi:ldap://x}",
  "<script>alert(1)</script>",
  "../../etc/passwd",
  "%00",
  "\\u0000",
  "null",
  "undefined",
  "NaN",
  "[object Object]",
];

function pick<T>(prng: Prng, items: readonly T[]): T {
  return items[prng.int(0, items.length - 1)];
}

function randomString(prng: Prng, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[prng.int(0, alphabet.length - 1)];
  }
  return out;
}

/** Keys the handler must ACCEPT (string, trimmed non-empty, ≤ 128 UTF-16 units). */
function validKey(prng: Prng): string {
  switch (prng.int(0, 9)) {
    case 0:
      return randomString(prng, ASCII, 1);
    case 1:
      return randomString(prng, ASCII, 128);
    case 2:
      return randomString(prng, UNICODE_BMP, prng.int(1, 128));
    case 3: {
      // astral: 64 × 2 units = 128 exactly
      const glyph = pick(prng, ASTRAL.slice(0, 5));
      return glyph.repeat(prng.int(1, 64));
    }
    case 4:
      return ` ${randomString(prng, ASCII, prng.int(1, 100))} `; // whitespace padded, still valid
    case 5:
      return pick(prng, INJECTION);
    case 6:
      return prng.uuid();
    case 7:
      return `${pick(prng, CONTROL.slice(1))}${
        randomString(prng, ASCII, prng.int(1, 40))
      }`;
    case 8:
      return randomString(prng, ASCII + UNICODE_BMP, prng.int(2, 127));
    default:
      return `permit-${prng.int(0, 1e9)}`;
  }
}

/** Keys / bodies the handler must REJECT with 400 validation.analysis_permit. */
function invalidBody(prng: Prng): { text: string; contentType: string } {
  const ct = "application/json";
  switch (prng.int(0, 17)) {
    case 0:
      return { text: "{}", contentType: ct };
    case 1:
      return { text: JSON.stringify({ idempotencyKey: "" }), contentType: ct };
    case 2:
      return {
        text: JSON.stringify({ idempotencyKey: " \t\n " }),
        contentType: ct,
      };
    case 3:
      return {
        text: JSON.stringify({
          idempotencyKey: randomString(prng, ASCII, 129),
        }),
        contentType: ct,
      };
    case 4:
      return {
        text: JSON.stringify({
          idempotencyKey: randomString(prng, ASCII, prng.int(129, 5000)),
        }),
        contentType: ct,
      };
    case 5:
      return {
        text: JSON.stringify({
          idempotencyKey: pick(prng, ASTRAL.slice(0, 5)).repeat(65),
        }),
        contentType: ct,
      };
    case 6:
      return {
        text: JSON.stringify({ idempotencyKey: prng.int(0, 1e9) }),
        contentType: ct,
      };
    case 7:
      return {
        text: JSON.stringify({ idempotencyKey: null }),
        contentType: ct,
      };
    case 8:
      return {
        text: JSON.stringify({ idempotencyKey: prng.next() < 0.5 }),
        contentType: ct,
      };
    case 9:
      return {
        text: JSON.stringify({ idempotencyKey: { nested: "x" } }),
        contentType: ct,
      };
    case 10:
      return {
        text: JSON.stringify({ idempotencyKey: ["a"] }),
        contentType: ct,
      };
    case 11:
      return {
        text: JSON.stringify([{ idempotencyKey: "arr" }]),
        contentType: ct,
      };
    case 12:
      return { text: JSON.stringify("just-a-string"), contentType: ct };
    case 13:
      return { text: `{"idempotencyKey": "trunc`, contentType: ct };
    case 14:
      return { text: `{"idempotencyKey": "x"} trailing`, contentType: ct };
    case 15:
      return { text: "", contentType: ct };
    case 16:
      return {
        text: JSON.stringify({ IdempotencyKey: "case" }),
        contentType: ct,
      };
    default:
      return {
        text: `{"a":${"[".repeat(2000)}${"]".repeat(2000)}}`,
        contentType: ct,
      };
  }
}

/** Valid body text variants that still parse to an accepted key. */
function validBodyText(prng: Prng, key: string): string {
  switch (prng.int(0, 5)) {
    case 0:
      return JSON.stringify({
        idempotencyKey: key,
        extra: prng.int(0, 99),
        __proto__: { polluted: true },
      });
    case 1:
      return `  ${JSON.stringify({ idempotencyKey: key })}  \n`;
    case 2:
      return JSON.stringify({ idempotencyKey: key, idempotencyKey2: "dup" });
    case 3:
      return JSON.stringify({
        nested: { deep: { deeper: [1, 2, 3] } },
        idempotencyKey: key,
      });
    case 4:
      // large but under the 5 MB cap: ~1 MB of padding beside the key
      return prng.next() < 0.1
        ? JSON.stringify({
          padding: "x".repeat(1_000_000),
          idempotencyKey: key,
        })
        : JSON.stringify({
          idempotencyKey: key,
          padding: randomString(prng, ASCII, prng.int(1000, 20000)),
        });
    default:
      return JSON.stringify({ idempotencyKey: key });
  }
}

function queryString(prng: Prng): string {
  switch (prng.int(0, 7)) {
    case 0:
      return "?idempotencyKey=from-query";
    case 1:
      return `?${randomString(prng, ASCII, prng.int(1, 60))}=${prng.int(0, 9)}`;
    case 2:
      return `?${"a=1&".repeat(prng.int(1, 500))}`;
    case 3:
      return "?%00=%00&%ff";
    case 4:
      return "?=";
    case 5:
      return `?q=${"%E2%9C%93".repeat(prng.int(1, 50))}`;
    case 6:
      return "?#fragment";
    default:
      return `?${randomString(prng, ASCII, prng.int(500, 4000))}`;
  }
}

function headerSafe(value: string): string {
  // Header values are ByteStrings: strip anything > 0xff and CR/LF/NUL.
  return Array.from(value)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c <= 0xff && c !== 0x0a && c !== 0x0d && c !== 0x00;
    })
    .join("");
}

function badBearer(prng: Prng, users: User[]): string | undefined {
  const hdr = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const tok = (payload: unknown) =>
    `${hdr}.${b64url(JSON.stringify(payload))}.sig`;
  switch (prng.int(0, 15)) {
    case 0:
      return undefined; // missing entirely
    case 1:
      return "Bearer";
    case 2:
      return "Bearer ";
    case 3:
      return `Basic ${btoa("user:pass")}`;
    case 4:
      return "Bearer not-a-jwt";
    case 5:
      return `Bearer ${randomString(prng, ASCII, prng.int(1, 4000))}`;
    case 6:
      return `Bearer a.${b64url("not json")}.c`;
    case 7:
      return `Bearer ${tok(null)}`;
    case 8:
      return `Bearer ${tok([1, 2, 3])}`;
    case 9:
      return `Bearer ${tok("str")}`;
    case 10:
      return `Bearer ${
        tok({
          iss: "https://evil.example",
          sub: prng.uuid(),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      }`;
    case 11:
      // expired provider token
      return `Bearer ${
        tok({
          iss: "https://accounts.google.com",
          sub: prng.uuid(),
          exp: Math.floor(Date.now() / 1000) - 60,
        })
      }`;
    case 12:
      // supabase-issued shape, unknown to GoTrue → refused
      return `Bearer ${
        tok({
          iss: "http://supabase.xc.test/auth/v1",
          sub: prng.uuid(),
          role: "authenticated",
          session_id: prng.uuid(),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      }`;
    case 13:
      // provider token with no sub
      return `Bearer ${
        tok({
          iss: "https://accounts.google.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      }`;
    case 14: {
      // a real user's token with one byte flipped in the signature-less payload
      const t = pick(prng, users).accessToken;
      return `Bearer ${t.slice(0, 10)}${t.slice(10).replace(/[a-z]/, "A")}`;
    }
    default:
      // provider token whose sub is not a string — GoTrue refuses the grant
      return `Bearer ${
        tok({
          iss: "https://accounts.google.com",
          sub: prng.int(1, 1e9),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      }`;
  }
}

/** The fetch spec upper-cases the six well-known methods; others are kept verbatim. */
function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(upper)
    ? upper
    : method;
}

function badPath(prng: Prng): string {
  switch (prng.int(0, 13)) {
    case 0:
      return `${ROUTE}/`;
    case 1:
      return `${ROUTE}//`;
    case 2:
      return "/v1/Analysis-Permits";
    case 3:
      return "/v1/analysis-permits%2F";
    case 4:
      return `${ROUTE}/${prng.uuid()}/finalize`;
    case 5:
      return `${ROUTE}/not-a-uuid/finalize`;
    case 6:
      return `${ROUTE}/%E0%A4%A/finalize`; // malformed escape
    case 7:
      return `${ROUTE}/${randomString(prng, ASCII, prng.int(1, 300))}/finalize`;
    case 8:
      return "/v1/analysis-permits/../analysis-permits";
    case 9:
      return `/v1/${randomString(prng, ASCII, prng.int(1, 40))}`;
    case 10:
      return `${ROUTE};param=1`;
    case 11:
      return `${ROUTE}.json`;
    case 12:
      return `/v1/analysis-permits/${randomString(prng, "😀日本", 3)}/finalize`;
    default:
      return `/v1/analysis-permits\\finalize`;
  }
}

function gen(prng: Prng, index: number, users: User[], previous: Spec[]): Spec {
  const roll = prng.next();
  const category: Category = roll < 0.3
    ? "valid"
    : roll < 0.4 && previous.length > 0
    ? "replay"
    : roll < 0.6
    ? "body"
    : roll < 0.75
    ? "auth"
    : roll < 0.85
    ? "route"
    : roll < 0.99
    ? "headers"
    : "oversize";

  if (category === "replay") {
    const candidates = previous.filter((p) =>
      p.category === "valid" && p.keyAccepted !== null
    );
    if (candidates.length > 0) {
      const source = pick(prng, candidates);
      return {
        ...source,
        index,
        category: "replay",
        replayOf: source.index,
        headers: {
          ...source.headers,
          "x-forwarded-for": `203.0.${(index >> 8) & 0xff}.${index & 0xff}`,
        },
      };
    }
  }

  const user = pick(prng, users);
  const useSession = prng.next() < 0.6;
  const ip = `203.0.${(index >> 8) & 0xff}.${index & 0xff}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${
      useSession ? user.accessToken : user.providerToken
    }`,
    "x-forwarded-for": ip,
    "Content-Type": "application/json",
  };
  const spec: Spec = {
    index,
    category,
    method: "POST",
    base: prng.next() < 0.15 ? pick(prng, BASES) : BASE,
    path: prng.next() < 0.2 ? ROUTE + queryString(prng) : ROUTE,
    headers,
    body: { kind: "none" },
    user,
    authValid: true,
    keyAccepted: null,
    declaredTooLarge: false,
    streamTooLarge: false,
    routeHit: true,
    requestIdEcho: null,
  };

  const key = validKey(prng);
  const setValidBody = () => {
    spec.body = { kind: "text", text: validBodyText(prng, key) };
    spec.keyAccepted = key;
  };

  switch (category) {
    case "valid":
    case "replay":
      setValidBody();
      break;
    case "body": {
      const roll2 = prng.int(0, 9);
      if (roll2 <= 5) {
        const bad = invalidBody(prng);
        spec.body = { kind: "text", text: bad.text };
        headers["Content-Type"] = bad.contentType;
      } else if (roll2 === 6) {
        spec.body = { kind: "none" }; // POST with no body at all
      } else if (roll2 === 7) {
        // raw non-UTF8 bytes
        const bytes = new Uint8Array(prng.int(1, 512));
        for (let i = 0; i < bytes.length; i++) bytes[i] = prng.int(0, 255);
        spec.body = { kind: "bytes", bytes };
      } else if (roll2 === 8) {
        // JSON text with a lone surrogate / null escape in the key — parses
        // in V8 to a string the handler accepts (length ≥ 1, ≤ 128).
        const esc = pick(prng, [
          '"\\ud800"',
          '"\\udfff-x"',
          '"\\u0000"',
          '"a\\u0000b"',
        ]);
        spec.body = { kind: "text", text: `{"idempotencyKey":${esc}}` };
        spec.keyAccepted = JSON.parse(esc) as string;
      } else {
        // valid key, non-JSON content type: the handler parses regardless
        setValidBody();
        headers["Content-Type"] = pick(prng, [
          "text/plain",
          "application/x-www-form-urlencoded",
          "multipart/form-data; boundary=x",
          "application/json; charset=utf-16",
          "",
        ]);
      }
      break;
    }
    case "auth": {
      const bearer = badBearer(prng, users);
      if (bearer === undefined) delete headers.Authorization;
      else headers.Authorization = headerSafe(bearer);
      spec.authValid = false;
      setValidBody();
      break;
    }
    case "route": {
      if (prng.next() < 0.5) {
        spec.method = pick(prng, [
          "GET",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
          "post",
          "PROPFIND",
          "PURGE",
        ]);
      } else {
        spec.path = badPath(prng);
      }
      if (prng.next() < 0.3) spec.path += queryString(prng);
      const normalized = normalizeMethod(spec.method);
      spec.routeHit = normalized === "POST" &&
        new URL(spec.base + spec.path).pathname.endsWith(ROUTE);
      if (normalized !== "GET" && normalized !== "HEAD") setValidBody();
      else spec.body = { kind: "none" };
      break;
    }
    case "headers": {
      setValidBody();
      const roll3 = prng.int(0, 7);
      if (roll3 === 0) {
        const cl = pick(prng, [
          "5000001",
          "99999999999",
          "1e7",
          "Infinity",
          "-1",
          "abc",
          "0",
          "5000000",
          " 6000000 ",
        ]);
        headers["Content-Length"] = cl;
        const n = Number(cl);
        spec.declaredTooLarge = Number.isFinite(n) && n > MAX_BODY;
      } else if (roll3 === 1) {
        const rid = pick(prng, [
          randomString(
            prng,
            "abcdefghijklmnopqrstuvwxyz0123456789._-",
            prng.int(8, 64),
          ),
          randomString(prng, ASCII, 7),
          randomString(prng, ASCII, 65),
          "has space in it",
          "<script>x</script>",
          "  padded-id-1234  ",
          prng.uuid(),
          randomString(prng, "\u00e9\u00fc\u00f1", 12),
        ]);
        headers["x-request-id"] = headerSafe(rid);
        const trimmed = headers["x-request-id"].trim();
        spec.requestIdEcho = REQUEST_ID_RE.test(trimmed) ? trimmed : null;
      } else if (roll3 === 2) {
        headers["x-forwarded-for"] = pick(prng, [
          "",
          ",,,",
          "1.1.1.1, 2.2.2.2, 3.3.3.3",
          randomString(prng, ASCII, 500),
          "::1",
          "unknown",
          "127.0.0.1",
        ]);
      } else if (roll3 === 3) {
        headers["cf-connecting-ip"] = pick(prng, [
          "",
          "  ",
          "9.9.9.9",
          randomString(prng, ASCII, 80),
        ]);
      } else if (roll3 === 4) {
        headers["Content-Type"] = pick(prng, [
          "",
          "application/json;;;",
          "APPLICATION/JSON",
          "text/html",
        ]);
      } else if (roll3 === 5) {
        headers["Accept"] = pick(prng, [
          "text/html",
          "*/*",
          "application/xml",
          "",
        ]);
        headers["Origin"] = "https://evil.example";
      } else if (roll3 === 6) {
        headers["Transfer-Encoding"] = "chunked";
      } else {
        headers["Authorization"] = `Bearer ${user.accessToken} `; // trailing space is trimmed by bearerOf
        headers["X-Forwarded-Host"] = "evil.example";
      }
      break;
    }
    case "oversize": {
      spec.body = { kind: "stream", byteLength: MAX_BODY + prng.int(1, 4096) };
      delete headers["Content-Type"];
      spec.streamTooLarge = true;
      break;
    }
  }
  return spec;
}

function buildRequest(spec: Spec): Request {
  let body: BodyInit | null = null;
  if (spec.body.kind === "text") body = spec.body.text;
  else if (spec.body.kind === "bytes") body = spec.body.bytes;
  else if (spec.body.kind === "stream") {
    const total = spec.body.byteLength;
    const chunk = new Uint8Array(65536).fill(0x20);
    let sent = 0;
    body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const n = Math.min(chunk.byteLength, total - sent);
        controller.enqueue(n === chunk.byteLength ? chunk : chunk.slice(0, n));
        sent += n;
      },
    });
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(spec.headers)) headers.set(k, v);
  const method = spec.method;
  const normalized = normalizeMethod(method);
  const bodyAllowed = normalized !== "GET" && normalized !== "HEAD";
  return new Request(spec.base + spec.path, {
    method,
    headers,
    body: bodyAllowed ? body : null,
    ...(spec.body.kind === "stream" ? { duplex: "half" } : {}),
  } as RequestInit);
}

// ── Outcome table ────────────────────────────────────────────────────────────

interface Outcome {
  index: number;
  seed: number;
  category: Category;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyPreview: string;
  bodyBytes: number;
  status: number;
  code: string | null;
  requestId: string | null;
  permitId: string | null;
  rowsDelta: number;
  latencyMs: number;
  violations: string[];
  replayOf?: number;
}

function preview(spec: Spec): { text: string; bytes: number } {
  if (spec.body.kind === "text") {
    return {
      text: JSON.stringify(spec.body.text.slice(0, 160)),
      bytes: new TextEncoder().encode(spec.body.text).byteLength,
    };
  }
  if (spec.body.kind === "bytes") {
    return {
      text: `<bytes ${
        Array.from(spec.body.bytes.slice(0, 24)).map((b) =>
          b.toString(16).padStart(2, "0")
        ).join(" ")
      }…>`,
      bytes: spec.body.bytes.byteLength,
    };
  }
  if (spec.body.kind === "stream") {
    return {
      text: `<stream ${spec.body.byteLength} bytes>`,
      bytes: spec.body.byteLength,
    };
  }
  return { text: "", bytes: 0 };
}

function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === "authorization"
      ? `${v.slice(0, 12)}…(${v.length})`
      : v.slice(0, 120);
  }
  return out;
}

function totalRows(h: XcHarness): number {
  return Object.values(h.fake.tables).reduce((n, rows) => n + rows.length, 0);
}

async function runOne(
  h: XcHarness,
  spec: Spec,
  request: Request,
  ledger: Map<string, Map<string, string>>,
  accessLog: string[],
): Promise<Outcome> {
  const table = h.fake.tables.analysis_permits;
  const accessLinesBefore = accessLog.length;
  const rowsBefore = table.length;
  const allRowsBefore = totalRows(h);
  const reserveCallsBefore = h.fake.counters["rpc.reserve_analysis_permit"] ??
    0;
  const reservedBefore = spec.user
    ? table.filter((p) =>
      p.user_id === spec.user!.sub && p.status === "reserved"
    ).length
    : 0;
  const knownBefore = spec.user && spec.keyAccepted !== null
    ? ledger.get(spec.user.sub)?.get(spec.keyAccepted)
    : undefined;
  const t0 = performance.now();
  const response = await h.handler(request);
  const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
  const text = await response.text();
  const rowsDelta = table.length - rowsBefore;
  const otherRowsDelta = totalRows(h) - allRowsBefore - rowsDelta;
  const reserveCallsDelta =
    (h.fake.counters["rpc.reserve_analysis_permit"] ?? 0) - reserveCallsBefore;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const errorObj = isRecord(parsed) && isRecord(parsed.error)
    ? parsed.error
    : null;
  const code = errorObj && typeof errorObj.code === "string"
    ? errorObj.code
    : null;
  const permit = isRecord(parsed) && isRecord(parsed.permit)
    ? parsed.permit
    : null;
  const permitId = permit && typeof permit.id === "string" ? permit.id : null;
  const requestId = response.headers.get("x-request-id");
  const violations: string[] = [];
  const status = response.status;

  // 1. status class
  if (status >= 500) violations.push(`5xx: ${status}`);
  const wellFormed = spec.authValid && spec.routeHit &&
    spec.keyAccepted !== null && !spec.declaredTooLarge && !spec.streamTooLarge;
  if (wellFormed) {
    if (!GOOD_STATUSES.has(status) && status !== 429) {
      violations.push(`well-formed reserve answered ${status}`);
    }
    if (status !== 429 && spec.user) {
      const expected = knownBefore || spec.user.premium || reservedBefore < 2
        ? 200
        : 402;
      if (status !== expected) {
        violations.push(
          `expected ${expected} (premium=${spec.user.premium} reservedBefore=${reservedBefore} known=${
            Boolean(knownBefore)
          }), got ${status}`,
        );
      }
    }
  } else if (!BAD_INPUT_STATUSES.has(status)) {
    violations.push(
      `bad input answered ${status} (allowed 400/401/403/404/405/413/415/429)`,
    );
  }
  // Oracle refinements (only when nothing upstream short-circuited).
  if (status !== 429) {
    if (spec.declaredTooLarge && status !== 413) {
      violations.push(
        `declared Content-Length > cap → expected 413, got ${status}`,
      );
    }
    if (!spec.declaredTooLarge && !spec.authValid && status !== 401) {
      violations.push(`invalid bearer → expected 401, got ${status}`);
    }
    if (
      !spec.declaredTooLarge && spec.authValid && spec.streamTooLarge &&
      spec.routeHit && status !== 413
    ) {
      violations.push(`oversize stream → expected 413, got ${status}`);
    }
    if (
      !spec.declaredTooLarge && spec.authValid && spec.routeHit &&
      !spec.streamTooLarge
    ) {
      if (
        spec.keyAccepted === null &&
        !(status === 400 && code === "validation.analysis_permit")
      ) {
        violations.push(
          `invalid body → expected 400 validation.analysis_permit, got ${status} ${
            code ?? "(no code)"
          }`,
        );
      }
      if (spec.keyAccepted !== null && status === 400) {
        violations.push(`valid key rejected with 400 ${code ?? ""}`);
      }
    }
  }
  // 2. body hygiene
  for (const marker of STACK_MARKERS) {
    if (marker.test(text)) {
      violations.push(`body carries diagnostic marker ${marker}`);
    }
  }
  if (status >= 500 && !GENERIC_5XX.some((re) => re.test(text))) {
    violations.push("5xx body is not the generic shape");
  }
  if (status === 404 && spec.method !== "HEAD" && !text) {
    violations.push("404 without a body");
  }
  // 3. request id (+ exactly one access-log line carrying it)
  if (!requestId) violations.push("missing x-request-id");
  const newAccessLines = accessLog.slice(accessLinesBefore);
  if (newAccessLines.length !== 1) {
    violations.push(`${newAccessLines.length} access-log lines (expected 1)`);
  } else if (
    requestId &&
    !newAccessLines[0].includes(`"requestId":${JSON.stringify(requestId)}`)
  ) {
    violations.push("access-log line does not carry the response x-request-id");
  } else if (/\n\s+at\s|TypeError|index\.ts/.test(newAccessLines[0])) {
    violations.push("access-log line carries a stack fragment");
  } else if (spec.requestIdEcho !== null && requestId !== spec.requestIdEcho) {
    violations.push(
      `x-request-id not honoured: sent ${spec.requestIdEcho}, got ${requestId}`,
    );
  } else if (
    spec.requestIdEcho === null && requestId && !UUID_RE.test(requestId) &&
    !(spec.headers["x-request-id"] &&
      REQUEST_ID_RE.test(spec.headers["x-request-id"].trim()))
  ) {
    violations.push(
      `x-request-id is neither an honoured client id nor a UUID: ${requestId}`,
    );
  }
  // 4/5. write discipline & idempotency
  if (status !== 200 && rowsDelta !== 0) {
    violations.push(
      `write on rejection: ${rowsDelta} row(s) for status ${status}`,
    );
  }
  if (otherRowsDelta !== 0) {
    violations.push(
      `unexpected write outside analysis_permits: ${otherRowsDelta} row(s)`,
    );
  }
  if (!GOOD_STATUSES.has(status) && reserveCallsDelta !== 0) {
    violations.push(
      `reserve_analysis_permit RPC called ${reserveCallsDelta}× on a ${status} response`,
    );
  }
  if (GOOD_STATUSES.has(status) && reserveCallsDelta !== 1) {
    violations.push(
      `reserve_analysis_permit RPC called ${reserveCallsDelta}× on a ${status} response (expected exactly 1)`,
    );
  }
  if (status === 200) {
    if (!spec.user || spec.keyAccepted === null) {
      violations.push("200 without an accepted key/user in the spec");
    } else {
      const perUser = ledger.get(spec.user.sub) ?? new Map<string, string>();
      const known = perUser.get(spec.keyAccepted);
      if (known) {
        if (rowsDelta !== 0) {
          violations.push(`replayed key inserted ${rowsDelta} row(s)`);
        }
        if (permitId !== known) {
          violations.push(
            `replayed key answered permit ${permitId}, first answer was ${known}`,
          );
        }
      } else {
        if (rowsDelta !== 1) {
          violations.push(
            `fresh key inserted ${rowsDelta} row(s) (expected 1)`,
          );
        }
        if (!permitId) violations.push("200 without permit.id");
        else perUser.set(spec.keyAccepted, permitId);
        ledger.set(spec.user.sub, perUser);
      }
      if (!spec.user.premium) {
        const reserved = table.filter((p) =>
          p.user_id === spec.user!.sub && p.status === "reserved"
        ).length;
        if (reserved > 2) {
          violations.push(`free account holds ${reserved} reserved permits`);
        }
      }
      if (
        !permit || permit.accessSource !== "free" ||
        typeof permit.expiresAt !== "string"
      ) {
        violations.push("200 permit view malformed");
      }
    }
  }
  if (status === 402) {
    if (code !== "access.paywall_required") {
      violations.push(`402 without access.paywall_required (${code})`);
    }
    if (spec.user?.premium) violations.push("premium user paywalled");
  }
  if (status === 429) {
    if (!response.headers.get("retry-after")) {
      violations.push("429 without Retry-After");
    }
    if (code !== "rate_limited") {
      violations.push(`429 without rate_limited code (${code})`);
    }
  }

  const p = preview(spec);
  return {
    index: spec.index,
    seed: STRESS_SEED,
    category: spec.category,
    method: spec.method,
    url: (spec.base + spec.path).slice(0, 300),
    headers: redactHeaders(spec.headers),
    bodyPreview: p.text,
    bodyBytes: p.bytes,
    status,
    code,
    requestId,
    permitId,
    rowsDelta,
    latencyMs,
    violations,
    ...(spec.replayOf !== undefined ? { replayOf: spec.replayOf } : {}),
  };
}

// ── Campaign ─────────────────────────────────────────────────────────────────

Deno.test(`stress fuzz-boundary: POST /v1/analysis-permits × ${STRESS_ITER} generated requests (seed ${STRESS_SEED})`, async () => {
  const h = await loadXcHarness();
  h.fake.reset(STRESS_SEED, STRESS_LATENCY_MS);
  const setupPrng = new Prng(STRESS_SEED);
  const users = await mintUsers(h, setupPrng, STRESS_USERS);

  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  const logged: string[] = [];
  const accessLog: string[] = [];
  const restoreAccessLog = captureAccessLog((line) => accessLog.push(line));
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) =>
    logged.push(args.map(String).join(" ").slice(0, 300));
  console.warn = (...args: unknown[]) =>
    logged.push(args.map(String).join(" ").slice(0, 300));

  const specs: Spec[] = [];
  const outcomes: Outcome[] = [];
  const unconstructible: Array<{ index: number; error: string }> = [];
  const ledger = new Map<string, Map<string, string>>();
  const only = STRESS_ONLY ? Number(STRESS_ONLY) : null;
  try {
    for (let i = 0; i < STRESS_ITER; i++) {
      const prng = new Prng((STRESS_SEED ^ fnv1a(`iter:${i}`)) >>> 0);
      const spec = gen(prng, i, users, specs);
      specs.push(spec);
      if (only !== null && i !== only) continue;
      let request: Request;
      try {
        request = buildRequest(spec);
      } catch (error) {
        // Not representable as a fetch Request (forbidden method, invalid
        // header byte, …) — a real client could not send it either.
        unconstructible.push({
          index: i,
          error: error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
        });
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await runOne(h, spec, request, ledger, accessLog);
      } catch (error) {
        const message = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
        // The handler itself threw past Deno.serve's catch — that is a defect.
        const p = preview(spec);
        outcome = {
          index: i,
          seed: STRESS_SEED,
          category: spec.category,
          method: spec.method,
          url: (spec.base + spec.path).slice(0, 300),
          headers: redactHeaders(spec.headers),
          bodyPreview: p.text,
          bodyBytes: p.bytes,
          status: 0,
          code: null,
          requestId: null,
          permitId: null,
          rowsDelta: 0,
          latencyMs: 0,
          violations: [`handler threw: ${message}`],
        };
      }
      outcomes.push(outcome);
    }
  } finally {
    console.error = realError;
    console.warn = realWarn;
    restoreAccessLog();
  }
  const heapAfter = Deno.memoryUsage();

  const failing = outcomes.filter((o) => o.violations.length > 0);
  const report = {
    unit: "route-post-v1-analysis-permits",
    lens: "fuzz-boundary",
    seed: STRESS_SEED,
    iterations: STRESS_ITER,
    executed: outcomes.length,
    unconstructible,
    users: {
      total: users.length,
      premium: users.filter((u) => u.premium).length,
    },
    durationMs: Math.round(performance.now() - t0),
    heap: {
      before: heapBefore,
      after: heapAfter,
      rssDeltaMb: Math.round((heapAfter.rss - heapBefore.rss) / 1048576),
    },
    statusHistogram: histogram(outcomes.map((o) => o.status)),
    categoryHistogram: histogram(outcomes.map((o) => o.category)),
    statusByCategory: Object.fromEntries(
      ([
        "valid",
        "replay",
        "body",
        "auth",
        "route",
        "headers",
        "oversize",
      ] as Category[]).map((c) => [
        c,
        histogram(
          outcomes.filter((o) => o.category === c).map((o) => o.status),
        ),
      ]),
    ),
    fiveXx: outcomes.filter((o) => o.status >= 500 || o.status === 0).map((o) =>
      o.index
    ),
    failing: failing.map((o) => o.index),
    handlerLogLines: logged.length,
    handlerLogSample: logged.slice(0, 20),
    accessLogLines: accessLog.length,
    permitsRows: h.fake.tables.analysis_permits.length,
    rpcCounters: h.fake.counters,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_USERS=${STRESS_USERS} deno test -A --no-check --config deno.json stress_analysis_permits_fuzz.test.ts`,
    replayOne:
      `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_USERS=${STRESS_USERS} STRESS_ONLY=<index> deno test -A --no-check --config deno.json stress_analysis_permits_fuzz.test.ts`,
    outcomes,
  };
  const dir = stressOutDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}analysis_permits_fuzz.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  console.log(
    `[stress] fuzz-boundary POST /v1/analysis-permits: ${outcomes.length} executed, ${failing.length} violating, ` +
      `statuses=${
        JSON.stringify(report.statusHistogram)
      } rssΔ=${report.heap.rssDeltaMb}MB → ${path}`,
  );
  for (const f of failing.slice(0, 25)) {
    console.log(
      `[stress]   #${f.index} ${f.category} ${f.method} ${f.url} → ${f.status}: ${
        f.violations.join(" | ")
      }`,
    );
  }
  assert(outcomes.length > 0, "no iteration executed");
  assertEquals(
    failing.length,
    0,
    `${failing.length} request(s) violated the contract; see ${path}`,
  );
});

// ── Deterministic boundary pins (fast, always on) ────────────────────────────

Deno.test("stress fuzz-boundary: idempotencyKey length boundary — 128 accepted, 129 rejected, 64 astral glyphs (128 units) accepted, 65 rejected", async () => {
  const h = await loadXcHarness();
  h.fake.reset(STRESS_SEED + 1, 0);
  const prng = new Prng(STRESS_SEED + 1);
  const [user] = await mintUsers(h, prng, 1);
  const post = async (key: string) => {
    const response = await h.handler(
      new Request(BASE + ROUTE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
          "x-forwarded-for": "198.51.200.1",
        },
        body: JSON.stringify({ idempotencyKey: key }),
      }),
    );
    const body = await response.json();
    return { status: response.status, code: body?.error?.code ?? null };
  };
  // premium so the free limit never interferes with the length oracle
  h.fake.tables.billing_entitlements.push({
    user_id: user.sub,
    premium: true,
    expires_at: null,
  });
  assertEquals((await post("a".repeat(128))).status, 200);
  assertEquals(await post("a".repeat(129)), {
    status: 400,
    code: "validation.analysis_permit",
  });
  assertEquals((await post("😀".repeat(64))).status, 200);
  assertEquals(await post("😀".repeat(65)), {
    status: 400,
    code: "validation.analysis_permit",
  });
  assertEquals((await post("é".repeat(128))).status, 200);
  assertEquals(await post("   "), {
    status: 400,
    code: "validation.analysis_permit",
  });
  assertEquals((await post(" x ")).status, 200);
  assertEquals(
    h.fake.tables.analysis_permits.filter((p) => p.user_id === user.sub).length,
    4,
  );
});

Deno.test("stress fuzz-boundary: per-user permits budget — 31st reserve in the window is 429 with Retry-After and writes nothing", async () => {
  const h = await loadXcHarness();
  h.fake.reset(STRESS_SEED + 2, 0);
  const prng = new Prng(STRESS_SEED + 2);
  const [user] = await mintUsers(h, prng, 1);
  h.fake.tables.billing_entitlements.push({
    user_id: user.sub,
    premium: true,
    expires_at: null,
  });
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) {
    const response = await h.handler(
      new Request(BASE + ROUTE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
          "x-forwarded-for": `198.51.201.${i + 1}`,
        },
        body: JSON.stringify({ idempotencyKey: `budget-${i}` }),
      }),
    );
    statuses.push(response.status);
    if (i === 30) {
      assertEquals(response.status, 429);
      assert(response.headers.get("retry-after"), "429 without Retry-After");
      assertEquals((await response.json()).error.code, "rate_limited");
    } else {
      await response.body?.cancel();
    }
  }
  assertEquals(
    statuses.slice(0, 30).every((s) => s === 200),
    true,
    JSON.stringify(histogram(statuses)),
  );
  assertEquals(
    h.fake.tables.analysis_permits.filter((p) => p.user_id === user.sub).length,
    30,
  );
});
