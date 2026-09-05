/**
 * stress_catalog_drills_fuzz.test.ts — FUZZ / BOUNDARY campaign for the edge
 * route `GET /v1/catalog/drills` (unit `route-get-v1-catalog-drills`).
 *
 * Drives the REAL production handler (../index.ts, Deno.serve captured by
 * ./routesHarness.ts) in-process with Supabase Auth, PostgREST and RevenueCat
 * stubbed at the fetch layer. No port is opened, no network is touched, and
 * the hosted project is never contacted.
 *
 * Every iteration is generated from ONE 32-bit seed (mulberry32) and is fully
 * replayable from that seed alone:
 *
 *   cd supabase/functions/api/__wf__
 *   deno task test                                  # suite default: STRESS_ITER=300
 *   STRESS_ITER=4000 deno test -A --no-check --config deno.json stress_catalog_drills_fuzz.test.ts
 *   STRESS_REPLAY=<iterationSeed> deno test -A --no-check --config deno.json stress_catalog_drills_fuzz.test.ts
 *
 * Campaign knobs (all optional):
 *   STRESS_ITER     iterations in the fuzz campaign (default 300; the
 *                   documented at-scale run is >= 3000)
 *   STRESS_SEED     campaign seed (default 20260905); iteration seeds are
 *                   derived from it, so one campaign seed names the whole run
 *   STRESS_REPLAY   comma-separated iteration seeds to replay instead of the
 *                   campaign (prints each outcome; fails on any violation)
 *   STRESS_OUT_DIR  where the JSON tables are written
 *                   (default <repo>/artifacts/stress/route-get-v1-catalog-drills/)
 *   XC_PG_URL / PICKLE_AUDIT_PG_URL
 *                   disposable postgres:16 with shim_auth.sql + every migration
 *                   (./xc_pg_up.sh prints it); enables the Postgres-backed
 *                   test of the `user_saved_drills` read the route depends on.
 *                   Without it that test is `ignore`d — which is NOT a pass.
 *
 * Invariants asserted on EVERY generated request (the fuzz-boundary lens):
 *   I1  status is in the scenario's allowed set — bad input only ever yields
 *       400/401/403/404/405/413/415/429; well-formed input yields 200; an
 *       injected PostgREST fault yields 503 (never 500)
 *   I2  `x-request-id` is present, matches [A-Za-z0-9._-]{8,64}, echoes a
 *       valid client id and NEVER echoes an invalid one
 *   I3  every 5xx body is the generic JSON envelope — no stack trace, no
 *       upstream detail, no table/host names
 *   I4  the route performs NO write: no PostgREST POST/PATCH/PUT/DELETE, no
 *       RPC, no RevenueCat/Apple call — for accepted AND rejected requests
 *   I5  JSON responses carry Content-Type: application/json, nosniff, no-store
 *   I6  a 200 body matches an independent oracle over the static catalog
 *       (family filter, q substring, `saved` hydration from the stubbed rows)
 *   I7  exactly one categorical access-log line per request that carries no
 *       query string, bearer, client IP, or fuzz payload
 *
 * Results: <STRESS_OUT_DIR>/catalog_drills_fuzz.json (one row per iteration:
 * seed → request descriptor → outcome → violations) and
 * <STRESS_OUT_DIR>/catalog_drills_fuzz_5xx.json (every seed that produced a
 * 5xx, expected or not).
 */
import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
} from "./routesHarness.ts";
import { type CatalogDrillRecord, drillCatalog } from "../drills.ts";
import { captureAccessLog } from "../http.ts";

// ── Knobs ───────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const STRESS_ITER = envInt("STRESS_ITER", 300);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const seed = Number(s);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error(`STRESS_REPLAY seeds must be uint32, got ${JSON.stringify(s)}`);
    }
    return seed;
  });
const OUT_DIR =
  Deno.env.get("STRESS_OUT_DIR") ??
  new URL("../../../../artifacts/stress/route-get-v1-catalog-drills/", import.meta.url).pathname;
const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";

const EDGE_ORIGIN = "http://edge.test";
const MOUNT = "/functions/v1/api";
const ROUTE = "/v1/catalog/drills";
const MAX_JSON_BODY_BYTES = 5_000_000;
const GENERAL_USER_LIMIT = 240;
const AUTH_FAILURE_LIMIT = 30;

/** Statuses the lens allows for bad input. */
const BAD_INPUT_STATUSES = [400, 401, 403, 404, 405, 413, 415, 429];
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const GENERIC_500 = "Something went wrong. Please try again.";
const GENERIC_503_RE = /^[A-Za-z][A-Za-z -]* is temporarily unavailable\. Please try again\.$/;
/** Fragments that must never appear in a 5xx body. */
const LEAK_MARKERS = [
  "    at ",
  "\n at ",
  ".ts:",
  "index.ts",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "PGRST",
  "supabase.test",
  "/rest/v1",
  "user_saved_drills",
  "stack",
  "deno",
];

// ── Seeded RNG ──────────────────────────────────────────────────────────────

/** mulberry32 — deterministic, tiny, replayable. */
class Prng {
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
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  ip(): string {
    // TEST-NET-2/3 + a documentation IPv6 block; unique per iteration in practice
    switch (this.int(0, 2)) {
      case 0:
        return `198.51.${this.int(0, 255)}.${this.int(1, 254)}`;
      case 1:
        return `203.0.${this.int(0, 255)}.${this.int(1, 254)}`;
      default:
        return `2001:db8:${this.int(0, 0xffff).toString(16)}:${this.int(0, 0xffff).toString(16)}::${this.int(1, 0xffff).toString(16)}`;
    }
  }
}

/** Iteration seed derived from the campaign seed — stable across runs. */
function iterationSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ── Payload alphabets ───────────────────────────────────────────────────────

const ASCII_PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const CONTROL_CHARS = [
  "\u0000",
  "\u0001",
  "\u0007",
  "\u0008",
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
  "\u001b",
  "\u007f",
  "\u0085",
  "\u00a0",
];
const UNICODE_SAMPLES = [
  "é",
  "ß",
  "ñ",
  "中文",
  "日本語",
  "한국어",
  "العربية",
  "עברית",
  "🥒",
  "🏓",
  "👨‍👩‍👧‍👦",
  "\u200b",
  "\u200e",
  "\u202e",
  "\u2066",
  "\ufeff",
  "\ufffd",
  "\ud800",
  "\udfff",
  "İ",
  "ς",
  "ﬁ",
  "K",
  "Å",
];
const INJECTION_SAMPLES = [
  "' OR 1=1 --",
  '" OR ""="',
  "; drop table user_saved_drills; --",
  "<script>alert(1)</script>",
  "{{7*7}}",
  "${7*7}",
  "%00",
  "%0d%0aSet-Cookie:%20x=y",
  "../../../../etc/passwd",
  "..%2F..%2F",
  "\\..\\..\\",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "[object Object]",
  "NaN",
  "Infinity",
  "-0",
  "null",
  "undefined",
  "true",
  "1e309",
  "0x1f",
  "%",
  "%%",
  "%2",
  "%ZZ",
  "%E0%A4%A",
  "%C0%AF",
  "%FF%FE",
  "+",
  "&",
  "=",
  "#",
  "?",
  "/",
  "//",
  "\\",
  "*",
  ".*",
  "(?:)",
  "\\d+",
  "$where",
  '{"$gt":""}',
  "eq.x",
  "in.(a,b)",
  "user_id=eq.00000000-0000-4000-8000-000000000000",
];
const KNOWN_FAMILIES = ["dink", "volley", "drive", "serve", "return", "drop_reset", "global"];
const FAMILY_NOISE = [
  "DINK",
  "Dink",
  " dink",
  "dink ",
  "\tdink\n",
  "dink,volley",
  "dink volley",
  "drop-reset",
  "dropreset",
  "drop_reset ",
  "family",
  "*",
  "",
  " ",
  "all",
  "none",
];

function randomText(rng: Prng, maxLen: number): string {
  const len = rng.int(0, maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    const roll = rng.next();
    if (roll < 0.55) out += rng.pick(ASCII_PRINTABLE);
    else if (roll < 0.75) out += rng.pick(UNICODE_SAMPLES);
    else if (roll < 0.85) out += rng.pick(CONTROL_CHARS);
    else out += rng.pick(INJECTION_SAMPLES);
  }
  return out;
}

/** A header value the Headers constructor accepts: a ByteString without
 * NUL/CR/LF (the fetch spec's forbidden header bytes). */
function headerSafe(rng: Prng, maxLen: number): string {
  const len = rng.int(0, maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    const roll = rng.next();
    if (roll < 0.7) out += rng.pick(ASCII_PRINTABLE);
    else if (roll < 0.85) out += String.fromCharCode(rng.int(0x80, 0xff));
    else out += rng.pick(["\t", "\u007f", "\u0001", "\u001b", "\u000b", "\u000c"]);
  }
  return out;
}

/** encodeURIComponent that survives lone surrogates: they become the WTF-8
 * bytes a lenient client would send (an invalid UTF-8 sequence on the wire). */
function encodeComponent(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) {
      out += `%ED%${(0xa0 | ((code >> 6) & 0x1f)).toString(16).toUpperCase()}%${(0x80 | (code & 0x3f)).toString(16).toUpperCase()}`;
    } else out += encodeURIComponent(ch);
  }
  return out;
}

/** Encode `value` for a URL component, sometimes leaving raw/malformed
 * escapes in place so the server-side decoder sees hostile input. */
function encodeFuzzy(rng: Prng, value: string): string {
  const roll = rng.next();
  if (roll < 0.6)
    return encodeComponent(value).replace(/%20/g, () => (rng.chance(0.5) ? "+" : "%20"));
  if (roll < 0.8) return value.replace(/[\s#&=?]/g, (c) => encodeURIComponent(c));
  // deliberately malformed percent escapes
  return encodeComponent(value) + rng.pick(["%", "%Z", "%ZZ", "%E0%A4%A", "%C3", "%80", "%00"]);
}

// ── Scenario model ──────────────────────────────────────────────────────────

type Category =
  | "valid-query"
  | "query-fuzz"
  | "path-fuzz"
  | "method-fuzz"
  | "auth-fuzz"
  | "header-fuzz"
  | "body-fuzz"
  | "upstream-fault"
  | "combo";

/** `failFor` = number of PostgREST attempts that see the fault before the
 * stub answers normally; undefined = every attempt fails (persistent). */
type Fault =
  | {
      kind: "http";
      status: number;
      body: string;
      contentType: string;
      detail: string;
      failFor?: number;
    }
  | { kind: "throw"; message: string; failFor?: number }
  | { kind: "malformed-json"; body: string }
  | { kind: "shape"; body: unknown; label: string }
  | { kind: "rows"; rows: unknown[]; label: string };

/** postgrest-js 2.112.4 retries GET on a network error or a 503/520 answer
 * (DEFAULT_MAX_RETRIES=3, backoff 1s/2s/4s) — see
 * postgrest-js/src/PostgrestBuilder.ts executeWithRetry. */
const POSTGREST_RETRYABLE_STATUSES = [503, 520];
const POSTGREST_MAX_RETRIES = 3;

interface Scenario {
  seed: number;
  category: Category;
  note: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Only for non-GET/HEAD methods (the Request constructor forbids a GET body). */
  body?: Uint8Array;
  savedSlugs: string[];
  fault?: Fault;
  /** Allowed statuses (I1). */
  allowed: number[];
  /** When set, a 200 body must match the oracle for these params (I6). */
  oracle?: { q: string | null; family: string | null };
  /** Raw fuzz strings that must not appear in the access log (I7). */
  secrets: string[];
  /** Client-provided x-request-id and whether the server must echo it (I2). */
  requestId?: { value: string; valid: boolean };
}

interface Outcome {
  seed: number;
  category: Category;
  note: string;
  method: string;
  path: string;
  status: number;
  code: string | null;
  message: string | null;
  requestId: string | null;
  ms: number;
  upstream: { gets: number; writes: number; rpcs: number; other: number };
  violations: string[];
}

interface CatalogOracle {
  catalog: CatalogDrillRecord[];
  slugs: string[];
  families: string[];
  qSamples: string[];
}

function fullUrl(path: string, query = ""): string {
  return `${EDGE_ORIGIN}${MOUNT}${path}${query}`;
}

function bearerGoogle(sub: string): string {
  return `Bearer ${fakeGoogleIdToken(sub)}`;
}

/** base64url over the UTF-8 bytes (btoa alone throws past U+00FF). */
function b64url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(payload: unknown, header: unknown = { alg: "RS256", typ: "JWT" }): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
}

/** Supabase-issued session bearer the stub below verifies for `sub`. */
function sessionBearer(sub: string, valid: boolean): string {
  const token = jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: `stress-${sub}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    stress_valid: valid,
  });
  return `Bearer ${token}`;
}

function baseHeaders(rng: Prng, sub: string): Record<string, string> {
  return {
    Authorization: bearerGoogle(sub),
    "x-forwarded-for": rng.ip(),
  };
}

function encodeQuery(rng: Prng, params: Array<[string, string]>): string {
  if (params.length === 0) return rng.chance(0.2) ? "?" : "";
  return `?${params.map(([k, v]) => `${encodeFuzzy(rng, k)}=${encodeFuzzy(rng, v)}`).join(rng.chance(0.1) ? ";" : "&")}`;
}

/** Independent oracle: what the route must return for (q, family) given the
 * saved rows. Mirrors the documented contract (case-insensitive substring
 * over title/description/equipment, exact family, `saved` from the rows). */
function expectedItems(
  oracle: CatalogOracle,
  q: string | null,
  family: string | null,
  savedSlugs: string[],
): Array<{ slug: string; saved: boolean }> {
  const needle = q?.trim().toLowerCase() ?? "";
  const fam = family?.trim().toLowerCase() ?? "";
  const saved = new Set(savedSlugs);
  return oracle.catalog
    .filter((d) => (fam ? d.families.includes(fam) : true))
    .filter((d) =>
      needle
        ? [d.title, d.description, ...d.equipment].join("\n").toLowerCase().includes(needle)
        : true,
    )
    .map((d) => ({ slug: d.slug, saved: saved.has(d.slug) }));
}

// ── Generators ──────────────────────────────────────────────────────────────

function pickSaved(rng: Prng, oracle: CatalogOracle): string[] {
  const n = rng.int(0, 6);
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    out.add(rng.chance(0.8) ? rng.pick(oracle.slugs) : `not-in-catalog-${rng.int(0, 999)}`);
  }
  return [...out];
}

function genValidQuery(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const params: Array<[string, string]> = [];
  let q: string | null = null;
  let family: string | null = null;
  if (rng.chance(0.6)) {
    q = rng.pick(oracle.qSamples);
    if (rng.chance(0.3)) q = q.toUpperCase();
    if (rng.chance(0.2)) q = `  ${q}  `;
    params.push(["q", q]);
  }
  if (rng.chance(0.6)) {
    family = rng.pick(KNOWN_FAMILIES);
    if (rng.chance(0.3)) family = family.toUpperCase();
    params.push(["family", family]);
  }
  const query = params.length
    ? `?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`
    : "";
  return {
    seed,
    category: "valid-query",
    note: `q=${JSON.stringify(q)} family=${JSON.stringify(family)}`,
    method: "GET",
    url: fullUrl(ROUTE, query),
    headers: baseHeaders(rng, sub),
    savedSlugs: pickSaved(rng, oracle),
    allowed: [200],
    oracle: { q, family },
    secrets: [],
  };
}

function genQueryFuzz(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const params: Array<[string, string]> = [];
  const n = rng.int(0, 6);
  const secrets: string[] = [];
  for (let i = 0; i < n; i++) {
    const keyRoll = rng.next();
    const key =
      keyRoll < 0.35
        ? "q"
        : keyRoll < 0.6
          ? "family"
          : keyRoll < 0.7
            ? rng.pick([
                "Q",
                "FAMILY",
                "q[]",
                "family[0]",
                "q.",
                " q",
                "cursor",
                "limit",
                "offset",
                "select",
                "user_id",
                "__proto__",
              ])
            : randomText(rng, 12);
    let value: string;
    const valueRoll = rng.next();
    if (valueRoll < 0.15) value = rng.pick(FAMILY_NOISE);
    else if (valueRoll < 0.3) value = rng.pick(INJECTION_SAMPLES);
    else if (valueRoll < 0.4) value = rng.pick(oracle.qSamples) + randomText(rng, 3);
    else if (valueRoll < 0.5) value = randomText(rng, rng.pick([1_000, 10_000, 65_536]));
    else if (valueRoll < 0.55) value = "";
    else value = randomText(rng, 40);
    params.push([key, value]);
    if (value.length >= 6) secrets.push(value);
  }
  const query = encodeQuery(rng, params);
  const url = fullUrl(ROUTE, query);
  // The oracle reads the SAME URL the handler receives (WHATWG decoding).
  const parsed = new URL(url).searchParams;
  return {
    seed,
    category: "query-fuzz",
    note: `${params.length} params, query ${query.length} chars`,
    method: "GET",
    url,
    headers: baseHeaders(rng, sub),
    savedSlugs: pickSaved(rng, oracle),
    allowed: [200],
    oracle: { q: parsed.get("q"), family: parsed.get("family") },
    secrets,
  };
}

function genPathFuzz(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const headers = baseHeaders(rng, sub);
  const roll = rng.next();
  let path: string;
  let allowed: number[];
  let note: string;
  let oracleParams: Scenario["oracle"];
  const secrets: string[] = [];
  if (roll < 0.2) {
    // exact route through a different gateway mount prefix — must still be 200
    const prefix = rng.pick([
      "",
      "/api",
      "/functions/v1/api",
      "/functions/v1/api/functions/v1/api",
      "/x/v1/y",
      "/v1",
    ]);
    path = `${prefix}${ROUTE}`;
    allowed = [200];
    oracleParams = { q: null, family: null };
    note = `mount prefix ${JSON.stringify(prefix)}`;
    return {
      seed,
      category: "path-fuzz",
      note,
      method: "GET",
      url: `${EDGE_ORIGIN}${path}`,
      headers,
      savedSlugs: pickSaved(rng, oracle),
      allowed,
      oracle: oracleParams,
      secrets,
    };
  }
  if (roll < 0.45) {
    // slug route: known / unknown / malformed
    const slugRoll = rng.next();
    let slug: string;
    let saved: string[] | undefined;
    if (slugRoll < 0.3) {
      slug = rng.pick(oracle.slugs);
      allowed = [200];
      note = `known slug ${slug}`;
      // The detail route reads with maybeSingle(); the routes-harness stub
      // ignores the `.eq("slug")` filter, so seed at most one saved row.
      saved = rng.chance(0.5) ? [slug] : [];
    } else if (slugRoll < 0.45) {
      slug = rng.pick([
        "%E0%A4%A",
        "%ZZ",
        "%",
        "%C0",
        "%80%80",
        "%FF",
        `${rng.pick(oracle.slugs)}%`,
      ]);
      allowed = [400];
      note = `malformed escape ${slug}`;
    } else {
      const raw = rng.chance(0.5)
        ? randomText(rng, rng.pick([8, 64, 4_096]))
        : rng.pick(INJECTION_SAMPLES);
      slug = encodeComponent(raw);
      if (rng.chance(0.3)) slug = slug.replace(/%2F/gi, "%2F").toUpperCase();
      allowed = oracle.slugs.includes(raw) ? [200] : [404];
      note = `unknown slug (${slug.length} chars)`;
      if (raw.length >= 6) secrets.push(raw);
      // Lone surrogates encode to invalid UTF-8 escapes; the route answers 400
      // (index.ts decodePathSegment) instead of looking the slug up.
      try {
        decodeURIComponent(
          new URL(fullUrl(`${ROUTE}/${slug}`)).pathname.slice(`${MOUNT}${ROUTE}/`.length),
        );
      } catch {
        allowed = [400];
        note = `undecodable slug (${slug.length} chars)`;
      }
    }
    path = `${ROUTE}/${slug}`;
    return {
      seed,
      category: "path-fuzz",
      note,
      method: "GET",
      url: fullUrl(path),
      headers,
      savedSlugs: saved ?? pickSaved(rng, oracle),
      allowed,
      secrets,
    };
  } else {
    const variants: Array<[string, number[]]> = [
      [`${ROUTE}/`, [404]],
      [`${ROUTE}//`, [404]],
      [`/v1/catalog//drills`, [404]],
      [`/v1/catalog/Drills`, [404]],
      [`/V1/catalog/drills`, [404]],
      [`/v1/CATALOG/drills`, [404]],
      [`/v1/catalog/drills/${rng.pick(oracle.slugs)}/extra`, [404]],
      [`/v1/catalog/drills/${rng.pick(oracle.slugs)}/`, [404]],
      [`/v1/catalog/drills%2F`, [404]],
      [`/v1/catalog%2Fdrills`, [404]],
      [`/v1/catalog/drills/..`, [404]],
      [`/v1/catalog/drills/../drills`, [200]], // WHATWG URL normalises dot segments
      [`/v1/catalog/./drills`, [200]],
      [`/v1/catalog/drills;jsessionid=1`, [404]],
      [`/v1/catalog/drills.json`, [404]],
      [`/v1/catalog/drills\u0000`, [404]], // trailing C0 is stripped by the URL parser → re-derived below
      [`/v1/catalog/drills${encodeComponent(randomText(rng, 16))}`, [404]],
      [`/v1/${encodeComponent(randomText(rng, 24))}`, [404]],
      [`/v1/catalog`, [404]],
      [`/v1/`, [404]],
      [`/v1`, [404]],
      [`/`, [404]],
      [`/v2/catalog/drills`, [404]],
      [`/v1/catalog/drills/%2e%2e/%2e%2e/me/saved-drills`, [200]], // WHATWG collapses to the sibling read below
      [`/v1/me/saved-drills`, [200]], // sibling read (GET) — same tables, must not write
      [`/v1/catalog/drills/` + "a".repeat(rng.pick([120, 121, 2_048, 16_384])), [404]],
    ];
    const [variantPath, variantAllowed] = rng.pick(variants);
    path = variantPath;
    allowed = variantAllowed;
    note = `variant ${variantPath.length > 80 ? `${variantPath.slice(0, 77)}…` : variantPath}`;
    // What the wire actually carries is the WHATWG-parsed path; if that is
    // the canonical route the server must answer 200.
    if (new URL(fullUrl(path)).pathname === `${MOUNT}${ROUTE}`) {
      allowed = [200];
      oracleParams = { q: null, family: null };
    }
  }
  return {
    seed,
    category: "path-fuzz",
    note,
    method: "GET",
    url: fullUrl(path),
    headers,
    savedSlugs: pickSaved(rng, oracle),
    allowed,
    oracle: oracleParams,
    secrets,
  };
}

function randomBody(rng: Prng): Uint8Array {
  const roll = rng.next();
  if (roll < 0.3)
    return new TextEncoder().encode(
      JSON.stringify({ q: randomText(rng, 30), family: rng.pick(FAMILY_NOISE) }),
    );
  if (roll < 0.5) return new TextEncoder().encode(randomText(rng, rng.pick([16, 512, 8_192])));
  if (roll < 0.7)
    return new TextEncoder().encode(
      rng.pick(["{", "[", "null", '"', '{"a":', "}", "\ufeff{}", '{"__proto__":{"x":1}}']),
    );
  const bytes = new Uint8Array(rng.int(0, 4_096));
  for (let i = 0; i < bytes.length; i++) bytes[i] = rng.int(0, 255);
  return bytes;
}

function genMethodFuzz(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const method = rng.pick([
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "PROPFIND",
    "PURGE",
    "get",
    "Get",
    "GETS",
    "G3T",
    "QUERY",
    "SEARCH",
    "LINK",
  ]);
  const normalized = method.toUpperCase() === "GET" ? "GET" : method; // fetch normalises known verbs
  const withBody = normalized !== "GET" && normalized !== "HEAD" && rng.chance(0.6);
  const headers = baseHeaders(rng, sub);
  if (withBody) {
    headers["content-type"] = rng.pick([
      "application/json",
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/octet-stream",
      headerSafe(rng, 20),
    ]);
  }
  const trailingSlug = rng.chance(0.3) ? rng.pick(oracle.slugs) : "";
  const trailing = trailingSlug ? `/${trailingSlug}` : "";
  const allowed = normalized === "GET" ? [200] : [404, 405];
  // Detail route reads with maybeSingle() and the stub ignores `.eq("slug")`:
  // at most one saved row when the path names a drill.
  const savedSlugs = trailingSlug
    ? rng.chance(0.5)
      ? [trailingSlug]
      : []
    : pickSaved(rng, oracle);
  return {
    seed,
    category: "method-fuzz",
    note: `${method}${withBody ? " +body" : ""}${trailing}`,
    method,
    url: fullUrl(`${ROUTE}${trailing}`),
    headers,
    body: withBody ? randomBody(rng) : undefined,
    savedSlugs,
    allowed,
    oracle: normalized === "GET" && !trailing ? { q: null, family: null } : undefined,
    secrets: [],
  };
}

function genAuthFuzz(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const headers: Record<string, string> = { "x-forwarded-for": rng.ip() };
  const roll = rng.next();
  let allowed: number[];
  let note: string;
  const secrets: string[] = [];
  if (roll < 0.06) {
    note = "no Authorization header";
    allowed = [401];
  } else if (roll < 0.12) {
    headers.Authorization = rng.pick([
      "",
      "Bearer",
      "Bearer ",
      "bearer x.y.z",
      "Basic dXNlcjpwYXNz",
      "Token abc",
      "Bearer  ",
      "BEARER x.y.z",
    ]);
    note = `Authorization=${JSON.stringify(headers.Authorization)}`;
    allowed = [401];
  } else if (roll < 0.2) {
    const junk = headerSafe(rng, rng.pick([8, 64, 4_096, 65_536]));
    headers.Authorization = `Bearer ${junk}`;
    note = `bearer junk (${junk.length} chars)`;
    allowed = [401];
    if (junk.length >= 6) secrets.push(junk);
  } else if (roll < 0.28) {
    const segs = rng.int(0, 6);
    headers.Authorization = `Bearer ${Array.from({ length: segs }, () => b64url(randomText(rng, 12))).join(".")}`;
    note = `bearer with ${segs} segments`;
    allowed = [401];
  } else if (roll < 0.36) {
    const payload = rng.pick<unknown>([
      null,
      [],
      "string",
      42,
      { iss: "https://accounts.google.com" }, // no exp/sub
      {
        iss: "https://accounts.google.com",
        sub,
        exp: Math.floor(Date.now() / 1000) - rng.int(1, 100_000),
      },
      { iss: "https://appleid.apple.com", sub, exp: 0 },
      { iss: "https://accounts.google.com", sub, exp: "soon" },
      { iss: "https://accounts.google.com", sub, exp: Number.MAX_SAFE_INTEGER },
      { iss: "https://accounts.google.com", sub, exp: -1 },
      { iss: "https://accounts.google.com", sub, exp: 1e300 },
      { iss: "https://evil.example/auth/v1", sub, exp: Math.floor(Date.now() / 1000) + 60 },
      {
        iss: "https://accounts.google.com.evil.example",
        sub,
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      { iss: `${SUPABASE_URL}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 60 }, // session token without sub
      { iss: 12345, sub, exp: Math.floor(Date.now() / 1000) + 60 },
      { iss: randomText(rng, 40), sub, exp: Math.floor(Date.now() / 1000) + 60 },
    ]);
    const token = jwt(payload);
    headers.Authorization = `Bearer ${token}`;
    note = `jwt payload ${JSON.stringify(payload)?.slice(0, 60)}`;
    // An issuer we do not recognise, or an expired token, is 401. A Supabase
    // issuer without a usable sub reaches GoTrue (stubbed → 401).
    allowed = [401];
    const p = payload as Record<string, unknown> | null;
    if (
      p &&
      typeof p === "object" &&
      !Array.isArray(p) &&
      (p.iss === "https://accounts.google.com" || p.iss === "https://appleid.apple.com") &&
      !(typeof p.exp === "number" && p.exp * 1000 <= Date.now())
    ) {
      // A provider token the edge cannot prove dead (index.ts bearerExpired:
      // only a NUMERIC past `exp` is refused locally) is handed to the
      // stubbed signInWithIdToken exchange, which accepts it → 200. Real
      // verification of `sub`/`exp`/signature is Supabase Auth's, not the
      // edge's, so a sub-less token is 200 here and 401 in production.
      allowed = typeof p.sub === "string" ? [200] : [200, 401];
    }
  } else if (roll < 0.44) {
    // payload segment that is not base64url / not JSON
    headers.Authorization = `Bearer ${b64url("{}")}.${rng.pick(["!!!", "%%%", "e30", "bnVsbA", "W10", b64url('{"iss":'), "", "."])}.sig`;
    note = "unparseable payload segment";
    allowed = [401];
  } else if (roll < 0.52) {
    // Apple provider token
    headers.Authorization = `Bearer ${fakeAppleIdToken(sub)}`;
    note = "apple id token";
    allowed = [200];
  } else if (roll < 0.62) {
    // Supabase session bearer the GoTrue stub accepts
    headers.Authorization = sessionBearer(sub, true);
    note = "valid session bearer";
    allowed = [200];
  } else if (roll < 0.72) {
    // Supabase session bearer GoTrue refuses (revoked / unknown)
    headers.Authorization = sessionBearer(sub, false);
    note = "refused session bearer";
    allowed = [401];
  } else if (roll < 0.8) {
    headers.Authorization = `Bearer ${fakeGoogleIdToken(sub)}`;
    headers["authorization"] = headers.Authorization; // duplicate header name (case)
    note = "duplicate authorization header";
    allowed = [200, 401];
  } else if (roll < 0.9) {
    // valid token but hostile sub values the stub echoes as the user id
    const hostileSub = rng.pick([
      "",
      " ",
      "null",
      "undefined",
      "0",
      "-1",
      "admin",
      "*",
      "'; drop table profiles; --",
      randomText(rng, 24),
      "a".repeat(4_096),
      OTHER_UUID,
    ]);
    headers.Authorization = `Bearer ${jwt({ iss: "https://accounts.google.com", sub: hostileSub, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
    note = `provider token sub=${JSON.stringify(hostileSub).slice(0, 40)}`;
    // Auth exchange succeeds for any sub in the stub; the route must still
    // behave (200 with `saved` scoped to that id) and never 5xx.
    allowed = [200, 401];
  } else {
    headers.Authorization = bearerGoogle(sub);
    headers["apikey"] = headerSafe(rng, 40);
    headers["x-supabase-auth"] = headerSafe(rng, 40);
    headers["x-client-info"] = headerSafe(rng, 40);
    note = "valid bearer + spoofed supabase headers";
    allowed = [200];
  }
  return {
    seed,
    category: "auth-fuzz",
    note,
    method: "GET",
    url: fullUrl(ROUTE),
    headers,
    savedSlugs: pickSaved(rng, oracle),
    allowed,
    oracle: allowed.length === 1 && allowed[0] === 200 ? { q: null, family: null } : undefined,
    secrets,
  };
}

const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

function genHeaderFuzz(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const headers = baseHeaders(rng, sub);
  const notes: string[] = [];
  let allowed = [200];
  let requestId: Scenario["requestId"];
  const secrets: string[] = [];
  const n = rng.int(1, 5);
  for (let i = 0; i < n; i++) {
    const which = rng.int(0, 9);
    switch (which) {
      case 0: {
        const valid = rng.chance(0.5);
        const value = valid
          ? Array.from({ length: rng.int(8, 64) }, () =>
              rng.pick([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"]),
            ).join("")
          : rng.pick([
              "",
              " ",
              "short",
              "1234567", // 7 chars
              "a".repeat(65),
              "a".repeat(4_096),
              "has space in it",
              "tab\tinside",
              "semi;colon-1234",
              "slash/1234567",
              'quote"12345678',
              "back\\slash1234",
              "  padded-with-spaces-1234  ", // trimmed → valid
              "\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9",
              headerSafe(rng, 40),
            ]);
        headers["x-request-id"] = value;
        requestId = { value, valid: REQUEST_ID_RE.test(value.trim()) };
        notes.push(
          `x-request-id=${JSON.stringify(value.length > 24 ? `${value.slice(0, 21)}…` : value)}`,
        );
        break;
      }
      case 1: {
        const value = rng.pick([
          "",
          "unknown",
          "1.2.3.4, 5.6.7.8",
          ", , ,",
          "::1",
          "0.0.0.0",
          "255.255.255.255",
          "999.999.999.999",
          "1.2.3.4:8080",
          "[2001:db8::1]",
          "a".repeat(8_192),
          headerSafe(rng, 60),
          `${rng.ip()}, ${rng.ip()}, ${rng.ip()}`,
        ]);
        headers["x-forwarded-for"] = value;
        notes.push(`xff=${JSON.stringify(value.length > 24 ? `${value.slice(0, 21)}…` : value)}`);
        break;
      }
      case 2: {
        const value = rng.pick([
          "",
          " ",
          rng.ip(),
          "not-an-ip",
          "a".repeat(2_048),
          headerSafe(rng, 30),
        ]);
        headers["cf-connecting-ip"] = value;
        notes.push(
          `cf-connecting-ip=${JSON.stringify(value.length > 24 ? `${value.slice(0, 21)}…` : value)}`,
        );
        break;
      }
      case 3: {
        // content-length on a GET (no body is actually sent)
        const value = rng.pick([
          "0",
          "-1",
          "NaN",
          "Infinity",
          "1e9",
          "0x10",
          String(MAX_JSON_BODY_BYTES),
          String(MAX_JSON_BODY_BYTES + 1),
          "99999999999999999999",
          "abc",
          "",
          " 5000001",
          "5000001 ",
          "5,000,001",
        ]);
        headers["content-length"] = value; // a later pick overwrites; decided below
        notes.push(`content-length=${JSON.stringify(value)}`);
        break;
      }
      case 4:
        headers["content-type"] = rng.pick([
          "application/json",
          "text/html",
          "",
          "application/json; charset=utf-16",
          "*/*",
          headerSafe(rng, 30),
        ]);
        notes.push("content-type");
        break;
      case 5:
        headers["accept"] = rng.pick([
          "",
          "*/*",
          "text/html",
          "application/xml",
          "application/vnd.pgrst.object+json",
          headerSafe(rng, 30),
        ]);
        notes.push("accept");
        break;
      case 6: {
        const name = rng.pick([
          "origin",
          "referer",
          "host",
          "range",
          "if-none-match",
          "if-modified-since",
          "x-http-method-override",
          "x-original-url",
          "x-rewrite-url",
          "prefer",
          "accept-profile",
          "content-profile",
          "x-forwarded-host",
          "x-forwarded-proto",
          "cookie",
          "transfer-encoding",
          "expect",
          "upgrade",
          "te",
          "via",
        ]);
        const value = headerSafe(rng, rng.pick([0, 16, 256, 8_192]));
        headers[name] = value;
        if (value.length >= 6) secrets.push(value);
        notes.push(name);
        break;
      }
      case 7: {
        // many junk headers
        const count = rng.int(20, 120);
        for (let j = 0; j < count; j++) headers[`x-fuzz-${j}`] = headerSafe(rng, 32);
        notes.push(`${count} junk headers`);
        break;
      }
      case 8:
        headers["x-http-method-override"] = rng.pick(["DELETE", "PUT", "POST", "PATCH"]);
        notes.push("method override");
        break;
      default:
        headers["authorization"] = headers.Authorization; // same bearer via lowercase name
        notes.push("lowercase authorization");
    }
  }
  // Only the FINAL content-length value travels (same header name); a
  // numeric value past the cap must be refused before auth (413). Header
  // values are whitespace-trimmed by the Fetch Headers constructor.
  if (headers["content-length"] !== undefined) {
    const declared = Number(headers["content-length"].trim());
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) allowed = [413];
  }
  return {
    seed,
    category: "header-fuzz",
    note: notes.join(" | "),
    method: "GET",
    url: fullUrl(ROUTE),
    headers,
    savedSlugs: pickSaved(rng, oracle),
    allowed,
    oracle: allowed[0] === 200 ? { q: null, family: null } : undefined,
    secrets,
    requestId,
  };
}

function genBodyFuzz(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const method = rng.pick(["POST", "PUT", "PATCH", "DELETE"]);
  const headers = baseHeaders(rng, sub);
  headers["content-type"] = rng.pick([
    "application/json",
    "text/plain",
    "application/octet-stream",
  ]);
  const roll = rng.next();
  let body: Uint8Array;
  let allowed: number[];
  let note: string;
  if (roll < 0.15) {
    // declared oversize — refused before auth, before any read
    body = new Uint8Array(0);
    headers["content-length"] = String(MAX_JSON_BODY_BYTES + rng.int(1, 1_000_000));
    allowed = [413];
    note = `declared content-length ${headers["content-length"]}`;
  } else if (roll < 0.25) {
    body = new Uint8Array(0);
    headers["content-length"] = String(MAX_JSON_BODY_BYTES);
    allowed = [404, 405];
    note = "declared content-length exactly at the cap";
  } else if (roll < 0.4) {
    const size = rng.pick([64 * 1024, 512 * 1024, 1_048_576]);
    body = new Uint8Array(size).fill(0x41);
    allowed = [404, 405];
    note = `${size}-byte body to an unmatched ${method}`;
  } else {
    body = randomBody(rng);
    allowed = [404, 405];
    note = `${body.byteLength}-byte fuzz body via ${method}`;
  }
  return {
    seed,
    category: "body-fuzz",
    note,
    method,
    url: fullUrl(ROUTE),
    headers,
    body,
    savedSlugs: pickSaved(rng, oracle),
    allowed,
    secrets: [],
  };
}

function genFault(
  rng: Prng,
  oracle: CatalogOracle,
): { fault: Fault; allowed: number[]; label: string } {
  const roll = rng.next();
  if (roll < 0.35) {
    // Non-retryable PostgREST answers: the route sees the error on the first
    // attempt and must answer a generic 503 (no retry stall).
    const status = rng.pick([400, 401, 403, 404, 406, 409, 416, 429, 500, 502, 504, 599]);
    const detail = `stress-detail-${rng.int(100_000, 999_999)} relation "public.user_saved_drills" permission denied`;
    const bodies = [
      JSON.stringify({
        code: rng.pick(["42501", "PGRST301", "PGRST116", "57014", "53300", "08006"]),
        message: detail,
        details: null,
        hint: null,
      }),
      `<html><body><h1>${status}</h1>${detail}</body></html>`,
      detail,
      "",
    ];
    const body = rng.pick(bodies);
    // postgrest-js maps a 404 with an EMPTY body to `data: null, error: null`
    // (issues/295 workaround) — the route then answers 200 with saved=false.
    const swallowed = status === 404 && body === "";
    return {
      fault: {
        kind: "http",
        status,
        body,
        contentType: body.startsWith("{") ? "application/json" : "text/plain",
        detail,
      },
      allowed: swallowed ? [200] : [503],
      label: `postgrest http ${status} ${body.startsWith("{") ? "json" : body ? "text" : "empty"}${swallowed ? " (swallowed by postgrest-js)" : ""}`,
    };
  }
  if (roll < 0.5) {
    // Retryable faults (network error, 503, 520). Each failing attempt costs
    // the library's real backoff (1s, 2s, 4s), so the persistent variant —
    // 3 retries then a 503, ~7s — is kept rare; most are transient and must
    // recover to a correct 200.
    const persistent = rng.chance(0.2);
    const failFor = persistent ? undefined : rng.pick([1, 1, 1, 2]);
    const allowed = persistent ? [503] : [200];
    const suffix = persistent
      ? ` persistent (${POSTGREST_MAX_RETRIES} retries)`
      : ` transient x${failFor}`;
    if (rng.chance(0.5)) {
      const message = `stress-network-${rng.int(100_000, 999_999)}: connection reset by peer`;
      return {
        fault: { kind: "throw", message, failFor },
        allowed,
        label: `postgrest fetch rejects${suffix}`,
      };
    }
    const status = rng.pick(POSTGREST_RETRYABLE_STATUSES);
    const detail = `stress-detail-${rng.int(100_000, 999_999)} upstream unavailable`;
    const body = rng.pick([
      JSON.stringify({ code: "PGRST001", message: detail, details: null, hint: null }),
      `<html>${detail}</html>`,
      "",
    ]);
    return {
      fault: {
        kind: "http",
        status,
        body,
        contentType: body.startsWith("{") ? "application/json" : "text/plain",
        detail,
        failFor,
      },
      allowed,
      label: `postgrest http ${status}${suffix}`,
    };
  }
  if (roll < 0.62) {
    const body = rng.pick([
      "{",
      '[{"slug":',
      "not json",
      "\ufeff[]",
      "[]]",
      '{"slug":"x"}garbage',
      "\u0000",
    ]);
    return {
      fault: { kind: "malformed-json", body },
      allowed: [503],
      label: `postgrest 200 malformed json ${JSON.stringify(body)}`,
    };
  }
  if (roll < 0.78) {
    const shapes: Array<[unknown, string]> = [
      [null, "null"],
      [{}, "object"],
      [{ slug: "x" }, "single object"],
      ["string", "string"],
      [42, "number"],
      [true, "boolean"],
      [[null], "[null]"],
      [[1, 2, 3], "[numbers]"],
      [["a", "b"], "[strings]"],
      [[[]], "[[]]"],
    ];
    const [body, label] = rng.pick(shapes);
    // A non-array 200 is a PostgREST contract violation. The lens permits any
    // generic 5xx here; whether the route reaches the uncaught-exception 500
    // (index.ts listCatalogDrills `.map((row) => row.slug)`) is recorded per
    // seed in the JSON table (`status`) and reported separately.
    return {
      fault: { kind: "shape", body, label },
      allowed: [200, 500, 503],
      label: `postgrest 200 ${label}`,
    };
  }
  // hostile row contents
  const rowsRoll = rng.next();
  let rows: unknown[];
  let label: string;
  if (rowsRoll < 0.3) {
    const count = rng.pick([1_000, 10_000, 50_000]);
    rows = Array.from({ length: count }, (_, i) => ({
      slug: i % 7 === 0 ? rng.pick(oracle.slugs) : `junk-${i}`,
    }));
    label = `${count} rows`;
  } else if (rowsRoll < 0.6) {
    rows = [
      { slug: null },
      { slug: 42 },
      { slug: { nested: true } },
      { slug: [rng.pick(oracle.slugs)] },
      { slug: rng.pick(oracle.slugs).toUpperCase() },
      { slug: ` ${rng.pick(oracle.slugs)}` },
      { slug: randomText(rng, 200) },
      { notslug: rng.pick(oracle.slugs) },
      {},
      { slug: rng.pick(oracle.slugs), user_id: OTHER_UUID },
      { slug: "__proto__" },
      { slug: "constructor" },
    ];
    label = "hostile row values";
  } else {
    rows = [{ slug: "a".repeat(rng.pick([1_000, 100_000, 1_000_000])) }];
    label = `one row with a ${(rows[0] as { slug: string }).slug.length}-char slug`;
  }
  return { fault: { kind: "rows", rows, label }, allowed: [200], label: `postgrest 200 ${label}` };
}

function genUpstreamFault(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  const sub = rng.uuid();
  const { fault, allowed, label } = genFault(rng, oracle);
  const params: Array<[string, string]> = [];
  let q: string | null = null;
  let family: string | null = null;
  if (rng.chance(0.4)) {
    q = rng.pick(oracle.qSamples);
    params.push(["q", q]);
  }
  if (rng.chance(0.4)) {
    family = rng.pick(KNOWN_FAMILIES);
    params.push(["family", family]);
  }
  const query = params.length
    ? `?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`
    : "";
  const savedSlugs =
    fault.kind === "rows"
      ? fault.rows
          .map((r) =>
            r && typeof r === "object" && "slug" in r ? (r as { slug: unknown }).slug : undefined,
          )
          .filter((s): s is string => typeof s === "string")
      : fault.kind === "shape" || (fault.kind === "http" && fault.failFor === undefined)
        ? [] // the stub never serves rows for these
        : pickSaved(rng, oracle);
  // Rows the stub serves (after a transient fault recovers) drive the oracle.
  const oracleApplies = fault.kind === "rows" || allowed[0] === 200;
  return {
    seed,
    category: "upstream-fault",
    note: label,
    method: "GET",
    url: fullUrl(ROUTE, query),
    headers: baseHeaders(rng, sub),
    savedSlugs,
    fault,
    allowed,
    oracle: oracleApplies && fault.kind !== "shape" ? { q, family } : undefined,
    secrets: [],
  };
}

function genCombo(rng: Prng, oracle: CatalogOracle, seed: number): Scenario {
  // query fuzz + header fuzz + (sometimes) an upstream fault, all at once
  const q = genQueryFuzz(rng, oracle, seed);
  const h = genHeaderFuzz(rng, oracle, seed);
  const headers = { ...q.headers, ...h.headers };
  let allowed = h.allowed[0] === 413 ? [413] : [200];
  let fault: Fault | undefined;
  let note = `combo: ${q.note} | ${h.note}`;
  let oracleParams = allowed[0] === 200 ? q.oracle : undefined;
  let savedSlugs = q.savedSlugs;
  if (allowed[0] === 200 && rng.chance(0.3)) {
    const f = genFault(rng, oracle);
    fault = f.fault;
    allowed = f.allowed;
    note += ` | ${f.label}`;
    if (fault.kind === "rows") {
      savedSlugs = fault.rows
        .map((r) =>
          r && typeof r === "object" && "slug" in r ? (r as { slug: unknown }).slug : undefined,
        )
        .filter((s): s is string => typeof s === "string");
    } else if (fault.kind === "http" && fault.failFor === undefined) {
      savedSlugs = [];
    } else if (!(allowed[0] === 200 && allowed.length === 1 && fault.kind !== "shape")) {
      oracleParams = undefined;
    }
  }
  return {
    seed,
    category: "combo",
    note,
    method: "GET",
    url: q.url,
    headers,
    savedSlugs,
    fault,
    allowed,
    oracle: oracleParams,
    secrets: [...q.secrets, ...h.secrets],
    requestId: h.requestId,
  };
}

const GENERATORS: Array<[number, (rng: Prng, oracle: CatalogOracle, seed: number) => Scenario]> = [
  [10, genValidQuery],
  [18, genQueryFuzz],
  [14, genPathFuzz],
  [8, genMethodFuzz],
  [12, genAuthFuzz],
  [12, genHeaderFuzz],
  [6, genBodyFuzz],
  [12, genUpstreamFault],
  [8, genCombo],
];
const GENERATOR_TOTAL = GENERATORS.reduce((sum, [w]) => sum + w, 0);

function generate(seed: number, oracle: CatalogOracle): Scenario {
  const rng = new Prng(seed);
  let roll = rng.int(1, GENERATOR_TOTAL);
  for (const [weight, gen] of GENERATORS) {
    roll -= weight;
    if (roll <= 0) return gen(rng, oracle, seed);
  }
  return genValidQuery(rng, oracle, seed);
}

// ── Upstream interception (GoTrue /user + PostgREST faults) ─────────────────

interface Interceptor {
  fault: Fault | undefined;
  /** PostgREST attempts seen for the current scenario (retries included). */
  attempts: number;
  restore(): void;
}

function installInterceptor(h: Harness): Interceptor {
  const stubFetch = globalThis.fetch;
  const state: Interceptor = {
    fault: undefined,
    attempts: 0,
    restore() {
      globalThis.fetch = stubFetch;
    },
  };
  const record = (request: Request): RecordedCall => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const call: RecordedCall = { url: request.url, method: request.method, headers, body: null };
    h.calls.push(call);
    return call;
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    // GoTrue session verification (routesHarness does not stub GET /auth/v1/user)
    if (url === `${SUPABASE_URL}/auth/v1/user` && request.method === "GET") {
      record(request);
      const bearer = request.headers.get("authorization") ?? "";
      const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
      let payload: Record<string, unknown> | null = null;
      try {
        const seg = token.split(".")[1] ?? "";
        const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
        payload = JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)));
      } catch {
        payload = null;
      }
      if (payload && payload.stress_valid === true && typeof payload.sub === "string") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: payload.sub,
              aud: "authenticated",
              role: "authenticated",
              email: "stress@example.com",
              app_metadata: { provider: "google", providers: ["google"] },
              user_metadata: {},
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    const fault = state.fault;
    if (
      fault &&
      request.method === "GET" &&
      url.startsWith(`${SUPABASE_URL}/rest/v1/user_saved_drills`)
    ) {
      const attempt = state.attempts++;
      if (
        (fault.kind === "http" || fault.kind === "throw") &&
        fault.failFor !== undefined &&
        attempt >= fault.failFor
      ) {
        return stubFetch(request); // transient fault has cleared
      }
      record(request);
      const jsonOk = (body: string) =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      switch (fault.kind) {
        case "http":
          return Promise.resolve(
            new Response(fault.body, {
              status: fault.status,
              headers: { "Content-Type": fault.contentType },
            }),
          );
        case "throw":
          return Promise.reject(new TypeError(fault.message));
        case "malformed-json":
          return jsonOk(fault.body);
        case "shape":
          return jsonOk(JSON.stringify(fault.body));
        case "rows":
          return jsonOk(JSON.stringify(fault.rows));
      }
    }
    return stubFetch(request);
  }) as typeof fetch;
  return state;
}

// ── Execution + invariants ──────────────────────────────────────────────────

function buildRequest(s: Scenario): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(s.headers)) headers.set(name, value);
  const init: RequestInit = { method: s.method, headers };
  if (s.body !== undefined) init.body = s.body;
  return new Request(s.url, init);
}

function classifyCalls(calls: RecordedCall[]): Outcome["upstream"] {
  const upstream = { gets: 0, writes: 0, rpcs: 0, other: 0 };
  for (const call of calls) {
    if (call.url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) upstream.rpcs += 1;
    else if (call.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      if (call.method === "GET" || call.method === "HEAD") upstream.gets += 1;
      else upstream.writes += 1;
    } else if (
      call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) ||
      call.url === `${SUPABASE_URL}/auth/v1/user`
    ) {
      // authentication round trips are expected
    } else upstream.other += 1;
  }
  return upstream;
}

async function runScenario(
  h: Harness,
  interceptor: Interceptor,
  oracle: CatalogOracle,
  s: Scenario,
): Promise<Outcome> {
  h.calls = [];
  h.tables["user_saved_drills"] = s.savedSlugs.map((slug) => ({ slug }));
  interceptor.fault = s.fault;
  const logLines: string[] = [];
  const restoreLog = captureAccessLog((line) => logLines.push(line));
  const violations: string[] = [];
  const started = performance.now();
  let response: Response;
  try {
    let request: Request;
    try {
      request = buildRequest(s);
    } catch (error) {
      // A generator bug, not a route outcome: surface it with the seed
      // instead of aborting the campaign.
      throw new Error(
        `seed=${s.seed} [${s.category}] produced an unconstructible request: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    response = await h.handler(request);
  } finally {
    restoreLog();
    interceptor.fault = undefined;
    interceptor.attempts = 0;
  }
  const ms = Math.round((performance.now() - started) * 100) / 100;
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = undefined;
  if (contentType.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch {
      violations.push(`json-body-unparseable: ${text.slice(0, 80)}`);
    }
  }
  const err =
    body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null;
  const code =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  const message =
    err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : null;
  const status = response.status;

  // I1 — allowed status
  if (!s.allowed.includes(status)) {
    violations.push(`status ${status} not in allowed [${s.allowed.join(",")}]`);
  }
  if (status >= 400 && status < 500 && !BAD_INPUT_STATUSES.includes(status)) {
    violations.push(`4xx ${status} outside the lens allow-list`);
  }
  // I2 — request id
  const requestId = response.headers.get("x-request-id");
  if (!requestId) violations.push("x-request-id missing");
  else if (!REQUEST_ID_RE.test(requestId))
    violations.push(`x-request-id malformed: ${JSON.stringify(requestId.slice(0, 80))}`);
  if (s.requestId && requestId) {
    const trimmed = s.requestId.value.trim();
    if (s.requestId.valid && requestId !== trimmed)
      violations.push("valid client x-request-id not echoed");
    if (!s.requestId.valid && requestId === trimmed)
      violations.push("invalid client x-request-id echoed");
  }
  // I3 — generic 5xx
  if (status >= 500) {
    if (!contentType.includes("application/json"))
      violations.push(`5xx without JSON content-type (${contentType})`);
    if (message === null) violations.push("5xx body lacks error.message");
    else if (message !== GENERIC_500 && !GENERIC_503_RE.test(message))
      violations.push(`5xx message not generic: ${JSON.stringify(message.slice(0, 120))}`);
    const lowered = text.toLowerCase();
    for (const marker of LEAK_MARKERS) {
      if (lowered.includes(marker.toLowerCase()))
        violations.push(`5xx body contains ${JSON.stringify(marker)}`);
    }
    if (s.fault && "detail" in s.fault && text.includes(s.fault.detail))
      violations.push("5xx body echoes upstream detail");
    if (s.fault && s.fault.kind === "throw" && text.includes(s.fault.message))
      violations.push("5xx body echoes network error");
  }
  // I4 — no writes, no RPC, no third-party call
  const upstream = classifyCalls(h.calls);
  if (upstream.writes > 0) violations.push(`${upstream.writes} PostgREST write(s) on a GET route`);
  if (upstream.rpcs > 0) violations.push(`${upstream.rpcs} RPC call(s) on a static-catalog route`);
  if (upstream.other > 0)
    violations.push(
      `${upstream.other} unexpected upstream call(s): ${h.calls
        .filter((c) => !c.url.startsWith(SUPABASE_URL))
        .map((c) => `${c.method} ${c.url}`)
        .join("; ")
        .slice(0, 200)}`,
    );
  if (status !== 200 && status !== 503 && upstream.gets > 0 && s.method.toUpperCase() !== "GET") {
    violations.push(`rejected non-GET still queried PostgREST (${upstream.gets})`);
  }
  // I5 — security headers on JSON
  if (contentType.includes("application/json")) {
    if ((response.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff")
      violations.push("nosniff missing");
    if (!(response.headers.get("cache-control") ?? "").includes("no-store"))
      violations.push("cache-control no-store missing");
  }
  // I6 — oracle
  if (status === 200 && s.oracle) {
    const parsed = body as { items?: unknown; cursor?: unknown } | undefined;
    if (!parsed || !Array.isArray(parsed.items)) violations.push("200 body lacks items[]");
    else if (parsed.cursor !== null)
      violations.push(`cursor is ${JSON.stringify(parsed.cursor)}, expected null`);
    else {
      const expected = expectedItems(oracle, s.oracle.q, s.oracle.family, s.savedSlugs);
      const got = parsed.items.map((item) => {
        const row = item as { slug?: unknown; saved?: unknown; validation_state?: unknown };
        return { slug: String(row.slug), saved: row.saved === true, state: row.validation_state };
      });
      if (
        got.length !== expected.length ||
        got.some((g, i) => g.slug !== expected[i].slug || g.saved !== expected[i].saved)
      ) {
        violations.push(
          `oracle mismatch: expected ${expected.length} items [${expected
            .slice(0, 3)
            .map((e) => `${e.slug}${e.saved ? "*" : ""}`)
            .join(",")}…], got ${got.length} [${got
            .slice(0, 3)
            .map((g) => `${g.slug}${g.saved ? "*" : ""}`)
            .join(",")}…]`,
        );
      }
      if (got.some((g) => g.state !== "PUBLISHED")) violations.push("unpublished drill served");
      if (parsed.items.some((item) => typeof (item as { saved?: unknown }).saved !== "boolean"))
        violations.push("saved is not boolean");
    }
  }
  if (status === 200 && s.method.toUpperCase() !== "GET")
    violations.push(`${s.method} was accepted with 200`);
  // I7 — access log
  if (logLines.length !== 1) violations.push(`${logLines.length} access-log lines (expected 1)`);
  else {
    let entry: Record<string, unknown> | null = null;
    try {
      entry = JSON.parse(logLines[0]);
    } catch {
      violations.push("access log line is not JSON");
    }
    if (entry) {
      if (entry.evt !== "api_request") violations.push("access log evt != api_request");
      if (entry.requestId !== requestId) violations.push("access log requestId != response header");
      if (entry.status !== status) violations.push("access log status != response status");
      if (typeof entry.route !== "string" || entry.route.includes("?"))
        violations.push("access log route carries a query string");
      const line = logLines[0];
      const bearer = s.headers.Authorization ?? s.headers.authorization ?? "";
      const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
      if (token.length >= 8 && line.includes(token))
        violations.push("access log contains the bearer");
      const ip =
        s.headers["cf-connecting-ip"]?.trim() ||
        (s.headers["x-forwarded-for"] ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .pop() ||
        "";
      if (ip.length >= 7 && line.includes(ip)) violations.push("access log contains the client IP");
      const rawPath = new URL(s.url).pathname;
      let decodedPath = rawPath;
      try {
        decodedPath = decodeURIComponent(rawPath.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
      } catch {
        // invalid UTF-8 escapes: compare against the raw path only
      }
      for (const secret of s.secrets) {
        // fuzz payloads that travelled in a path segment legitimately appear in
        // the route template; only query/header payloads are checked
        if (!rawPath.includes(secret) && !decodedPath.includes(secret) && line.includes(secret)) {
          violations.push("access log contains a fuzz payload");
          break;
        }
      }
    }
  }
  const path = new URL(s.url).pathname + new URL(s.url).search;
  return {
    seed: s.seed,
    category: s.category,
    note: s.note.length > 160 ? `${s.note.slice(0, 157)}…` : s.note,
    method: s.method,
    path: path.length > 200 ? `${path.slice(0, 197)}…` : path,
    status,
    code,
    message: message && message.length > 160 ? `${message.slice(0, 157)}…` : message,
    requestId,
    ms,
    upstream,
    violations,
  };
}

async function loadOracle(): Promise<CatalogOracle> {
  const catalog = await drillCatalog();
  const rng = new Prng(0xc0ffee);
  const qSamples = new Set<string>();
  for (const drill of catalog) {
    const words = `${drill.title} ${drill.description} ${drill.equipment.join(" ")}`
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    for (let i = 0; i < 3 && words.length; i++)
      qSamples.add(rng.pick(words).replace(/[^\p{L}\p{N}_-]/gu, ""));
    qSamples.add(drill.title.slice(0, rng.int(2, drill.title.length)));
  }
  qSamples.add("paddle");
  qSamples.add("kitchen");
  qSamples.add("zzz-no-such-drill");
  qSamples.delete("");
  return {
    catalog,
    slugs: catalog.map((d) => d.slug),
    families: [...new Set(catalog.flatMap((d) => d.families))].sort(),
    qSamples: [...qSamples].sort(),
  };
}

async function writeJson(name: string, value: unknown): Promise<string> {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR.endsWith("/") ? OUT_DIR : `${OUT_DIR}/`}${name}`;
  await Deno.writeTextFile(file, JSON.stringify(value, null, 2));
  return file;
}

function summarize(outcomes: Outcome[]) {
  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byCategoryStatus: Record<string, Record<string, number>> = {};
  let violating = 0;
  for (const o of outcomes) {
    byCategory[o.category] = (byCategory[o.category] ?? 0) + 1;
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    byCategoryStatus[o.category] ??= {};
    byCategoryStatus[o.category][o.status] = (byCategoryStatus[o.category][o.status] ?? 0) + 1;
    if (o.violations.length) violating += 1;
  }
  const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return {
    executed: outcomes.length,
    violating,
    byCategory,
    byStatus,
    byCategoryStatus,
    latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1] ?? 0 },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
  name: `STRESS fuzz-boundary GET /v1/catalog/drills — ${STRESS_REPLAY.length ? `replay ${STRESS_REPLAY.length} seed(s)` : `${STRESS_ITER} seeded requests (STRESS_SEED=${STRESS_SEED})`}`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const oracle = await loadOracle();
    const interceptor = installInterceptor(h);
    const outcomes: Outcome[] = [];
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    try {
      const seeds = STRESS_REPLAY.length
        ? STRESS_REPLAY
        : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
      for (const seed of seeds) {
        const scenario = generate(seed, oracle);
        outcomes.push(await runScenario(h, interceptor, oracle, scenario));
        // keep the per-isolate rate-limit map from ever hitting its 20k cap
        // (which would fail open and hide a real 429 regression)
        if (outcomes.length % 5_000 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      interceptor.restore();
      h.reset();
    }
    const durationMs = Math.round(performance.now() - t0);
    const summary = summarize(outcomes);
    const fivexx = outcomes.filter((o) => o.status >= 500);
    const failing = outcomes.filter((o) => o.violations.length > 0);
    const replayCmd = (seed: number) =>
      `STRESS_REPLAY=${seed} deno test -A --no-check --config deno.json stress_catalog_drills_fuzz.test.ts`;
    const table = {
      unit: "route-get-v1-catalog-drills",
      lens: "fuzz-boundary",
      handler: "supabase/functions/api/index.ts (real, in-process via __wf__/routesHarness.ts)",
      campaign: {
        seed: STRESS_SEED,
        iterations: STRESS_ITER,
        replay: STRESS_REPLAY,
        startedAt,
        durationMs,
        deno: Deno.version.deno,
      },
      generators: Object.fromEntries(GENERATORS.map(([w, g]) => [g.name, w])),
      invariants: [
        "I1 allowed status",
        "I2 x-request-id",
        "I3 generic 5xx",
        "I4 no write/RPC/third-party",
        "I5 nosniff+no-store",
        "I6 catalog oracle",
        "I7 categorical access log",
      ],
      summary,
      fivexxSeeds: fivexx.map((o) => ({
        seed: o.seed,
        status: o.status,
        category: o.category,
        note: o.note,
        expected: !o.violations.length,
        replay: replayCmd(o.seed),
      })),
      failingSeeds: failing.map((o) => ({
        seed: o.seed,
        violations: o.violations,
        replay: replayCmd(o.seed),
      })),
      rows: outcomes,
    };
    const suffix = STRESS_REPLAY.length ? `_replay_${STRESS_REPLAY[0]}` : "";
    const file = await writeJson(`catalog_drills_fuzz${suffix}.json`, table);
    await writeJson(`catalog_drills_fuzz_5xx${suffix}.json`, table.fivexxSeeds);
    const report = [
      `[stress] executed=${summary.executed} violating=${summary.violating} 5xx=${fivexx.length} in ${durationMs}ms → ${file}`,
      `[stress] byStatus=${JSON.stringify(summary.byStatus)}`,
      `[stress] byCategory=${JSON.stringify(summary.byCategory)}`,
    ];
    if (STRESS_REPLAY.length) {
      for (const o of outcomes)
        report.push(
          `[stress] seed=${o.seed} ${o.category} ${o.method} ${o.path} → ${o.status} ${o.code ?? ""} ${JSON.stringify(o.message)} violations=${JSON.stringify(o.violations)} note=${o.note}`,
        );
    }
    Deno.stdout.writeSync(new TextEncoder().encode(`${report.join("\n")}\n`));
    assertEquals(
      failing.map(
        (o) => `seed=${o.seed} [${o.category}] ${o.note} → ${o.status}: ${o.violations.join("; ")}`,
      ),
      [],
      `${failing.length} of ${outcomes.length} generated requests violated an invariant; replay each with ${replayCmd(failing[0]?.seed ?? 0)}`,
    );
    assert(
      outcomes.length === (STRESS_REPLAY.length || STRESS_ITER),
      "every scheduled iteration must have executed",
    );
  },
});

// Deterministic boundary probes — always run, cheap, complement the campaign.

Deno.test({
  name: "STRESS boundary: content-length cap is exact (5_000_000 accepted, 5_000_001 → 413) and still carries x-request-id",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const interceptor = installInterceptor(h);
    try {
      for (const [declared, expected] of [
        [MAX_JSON_BODY_BYTES, 200],
        [MAX_JSON_BODY_BYTES + 1, 413],
        [Number.MAX_SAFE_INTEGER, 413],
      ] as const) {
        h.calls = [];
        const res = await h.handler(
          new Request(fullUrl(ROUTE), {
            method: "GET",
            headers: {
              Authorization: bearerGoogle("33333333-3333-4333-8333-333333333333"),
              "x-forwarded-for": "198.51.100.250",
              "content-length": String(declared),
              "x-request-id": "boundary-content-length",
            },
          }),
        );
        const body = await res.json();
        assertEquals(res.status, expected, `content-length ${declared}`);
        assertEquals(res.headers.get("x-request-id"), "boundary-content-length");
        if (expected === 413) {
          assertEquals(body.error.message, "Request body is too large.");
          assertEquals(
            classifyCalls(h.calls).gets,
            0,
            "an oversize declaration must be refused before any upstream call",
          );
          assertEquals(h.calls.length, 0, "refused before authentication");
        }
      }
    } finally {
      interceptor.restore();
      h.reset();
    }
  },
});

Deno.test({
  name: `STRESS boundary: per-user budget (${GENERAL_USER_LIMIT}/min) — request ${GENERAL_USER_LIMIT + 1} is 429 with Retry-After, another user is unaffected, no write on rejection`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const interceptor = installInterceptor(h);
    try {
      const user = "44444444-4444-4444-8444-444444444444";
      const other = "55555555-5555-4555-8555-555555555555";
      const statuses: number[] = [];
      for (let i = 0; i < GENERAL_USER_LIMIT + 3; i++) {
        h.calls = [];
        const res = await h.handler(
          new Request(fullUrl(ROUTE, i % 2 ? "?family=dink" : ""), {
            method: "GET",
            headers: {
              Authorization: bearerGoogle(user),
              "x-forwarded-for": `198.51.101.${1 + (i % 200)}`,
            },
          }),
        );
        await res.body?.cancel();
        statuses.push(res.status);
        assert(res.headers.get("x-request-id"), `request ${i + 1} lacks x-request-id`);
        if (res.status === 429) {
          assert(Number(res.headers.get("retry-after")) >= 1, "429 carries Retry-After");
          assertEquals(res.headers.get("ratelimit-limit"), String(GENERAL_USER_LIMIT));
          assertEquals(classifyCalls(h.calls).gets, 0, "a 429 must not reach PostgREST");
          assertEquals(classifyCalls(h.calls).writes, 0);
        }
      }
      assertEquals(
        statuses.slice(0, GENERAL_USER_LIMIT).every((s) => s === 200),
        true,
        `first ${GENERAL_USER_LIMIT} are 200: ${JSON.stringify(statuses.slice(0, 5))}…`,
      );
      assertEquals(statuses.slice(GENERAL_USER_LIMIT), [429, 429, 429]);
      const otherRes = await h.handler(
        new Request(fullUrl(ROUTE), {
          method: "GET",
          headers: { Authorization: bearerGoogle(other), "x-forwarded-for": "198.51.101.1" },
        }),
      );
      await otherRes.body?.cancel();
      assertEquals(otherRes.status, 200, "budget is per user, not per IP");
    } finally {
      interceptor.restore();
      h.reset();
    }
  },
});

Deno.test({
  name: `STRESS boundary: auth-failure budget (${AUTH_FAILURE_LIMIT}/5min per IP) — bad bearers are 401 until the budget trips, then 429 even for a valid bearer`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const interceptor = installInterceptor(h);
    try {
      const ip = "203.0.113.199";
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
        h.calls = [];
        const res = await h.handler(
          new Request(fullUrl(ROUTE), {
            method: "GET",
            headers: {
              Authorization: `Bearer ${jwt({ iss: "https://accounts.google.com", sub: "x", exp: 1 })}`,
              "x-forwarded-for": ip,
            },
          }),
        );
        await res.body?.cancel();
        statuses.push(res.status);
        assertEquals(
          h.calls.length,
          0,
          "an expired provider token is refused without any upstream call",
        );
      }
      assertEquals(
        statuses,
        Array.from({ length: AUTH_FAILURE_LIMIT }, () => 401),
      );
      const tripped = await h.handler(
        new Request(fullUrl(ROUTE), {
          method: "GET",
          headers: {
            Authorization: bearerGoogle("66666666-6666-4666-8666-666666666666"),
            "x-forwarded-for": ip,
          },
        }),
      );
      await tripped.body?.cancel();
      assertEquals(tripped.status, 429, "valid bearer from the tripped IP is throttled");
      const elsewhere = await h.handler(
        new Request(fullUrl(ROUTE), {
          method: "GET",
          headers: {
            Authorization: bearerGoogle("66666666-6666-4666-8666-666666666666"),
            "x-forwarded-for": "203.0.113.198",
          },
        }),
      );
      await elsewhere.body?.cancel();
      assertEquals(elsewhere.status, 200, "the same user from another IP is served");
    } finally {
      interceptor.restore();
      h.reset();
    }
  },
});

// Postgres-backed half: the ONE database read this route performs
// (`select slug from user_saved_drills where user_id = auth.uid()` under RLS
// as role `authenticated`) on a disposable postgres:16 with every migration.

Deno.test({
  name: "STRESS pg: user_saved_drills read under RLS — owner-only rows, slug bounds, seeded fuzz slugs round-trip (XC_PG_URL)",
  ignore: PG_URL === "",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => undefined });
    const rng = new Prng(STRESS_SEED ^ 0x5a5a5a5a);
    const catalog = await drillCatalog();
    const rows: Array<Record<string, unknown>> = [];
    try {
      const users = [rng.uuid(), rng.uuid(), rng.uuid()];
      for (const id of users) {
        await sql.unsafe(`delete from auth.users where id = '${id}'`);
        await sql.unsafe(
          `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
        );
        const profile = await sql.unsafe(`select 1 from public.profiles where id = '${id}'`);
        if (profile.length === 0) {
          await sql.unsafe(
            `insert into public.profiles (id, email) values ('${id}', '${id}@example.com')`,
          );
        }
      }
      const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
      const validSlug = () => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
        const len = rng.int(1, 120);
        let out = rng.pick([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"]);
        for (let i = 1; i < len; i++) out += rng.pick([...alphabet]);
        return out;
      };
      const invalidSlug = () =>
        rng.pick([
          "",
          " ",
          "-leading",
          "_leading",
          "a".repeat(121),
          "has space",
          "uni\u00e9",
          "semi;colon",
          "slash/x",
          "quote'x",
          "nul\u0000x".replace("\u0000", ""),
          "中文",
          "🥒",
          "a\tb",
        ]);
      const owned: Record<string, Set<string>> = Object.fromEntries(
        users.map((u) => [u, new Set<string>()]),
      );
      let inserted = 0;
      let rejected = 0;
      for (let i = 0; i < 300; i++) {
        const user = rng.pick(users);
        const useCatalog = rng.chance(0.4);
        const slug = useCatalog
          ? rng.pick(catalog).slug
          : rng.chance(0.7)
            ? validSlug()
            : invalidSlug();
        const expectOk = SLUG_RE.test(slug);
        let ok = true;
        let error = "";
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`set local role authenticated`);
            await tx.unsafe(`set local request.jwt.claim.sub = '${user}'`);
            await tx`insert into public.user_saved_drills (user_id, slug) values (${user}, ${slug}) on conflict do nothing`;
          });
        } catch (e) {
          ok = false;
          error = e instanceof Error ? e.message : String(e);
        }
        if (ok) {
          inserted += 1;
          owned[user].add(slug);
        } else rejected += 1;
        rows.push({
          i,
          user,
          slug: slug.length > 60 ? `${slug.slice(0, 57)}…` : slug,
          expectOk,
          ok,
          error: error.slice(0, 120),
        });
        assertEquals(
          ok,
          expectOk,
          `slug ${JSON.stringify(slug.slice(0, 60))} for ${user}: ${error}`,
        );
      }
      // Cross-user insert must be refused by RLS (WITH CHECK auth.uid() = user_id)
      let crossOk = true;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${users[0]}'`);
          await tx`insert into public.user_saved_drills (user_id, slug) values (${users[1]}, ${catalog[0].slug})`;
        });
      } catch {
        crossOk = false;
      }
      assertEquals(
        crossOk,
        false,
        "inserting a saved drill for another user must be refused by RLS",
      );
      // The route's read, as each user: exactly their own rows, nothing else
      for (const user of users) {
        const seen = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${user}'`);
          const own = await tx<
            Array<{ slug: string }>
          >`select slug from public.user_saved_drills where user_id = ${user}`;
          const all = await tx<Array<{ slug: string }>>`select slug from public.user_saved_drills`;
          return { own: own.map((r) => r.slug).sort(), all: all.map((r) => r.slug).sort() };
        });
        assertEquals(seen.own, [...owned[user]].sort(), `own rows for ${user}`);
        assertEquals(
          seen.all,
          seen.own,
          `RLS: unfiltered select as ${user} returns only their rows`,
        );
        const savedInCatalog = catalog.filter((d) => owned[user].has(d.slug)).map((d) => d.slug);
        assert(
          savedInCatalog.every((s) => seen.own.includes(s)),
          "every catalog slug the user saved is visible to the route's read",
        );
      }
      // anon sees nothing (revoked)
      let anonOk = true;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role anon`);
          await tx`select slug from public.user_saved_drills`;
        });
      } catch {
        anonOk = false;
      }
      assertEquals(anonOk, false, "anon has no SELECT on user_saved_drills");
      const file = await writeJson("catalog_drills_pg_saved_drills.json", {
        pgUrlHost: new URL(PG_URL).host,
        seed: STRESS_SEED ^ 0x5a5a5a5a,
        users,
        inserted,
        rejected,
        rows,
      });
      Deno.stdout.writeSync(
        new TextEncoder().encode(
          `[stress-pg] inserted=${inserted} rejected=${rejected} → ${file}\n`,
        ),
      );
      for (const id of users) await sql.unsafe(`delete from auth.users where id = '${id}'`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
