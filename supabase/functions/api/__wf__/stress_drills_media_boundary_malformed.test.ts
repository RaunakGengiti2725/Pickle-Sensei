// Seeded boundary / malformed-input stress campaign for the drill catalog +
// drill media unit (drills.ts, drillMedia.ts and the routes in index.ts that
// serve them: GET /v1/catalog/drills, GET /v1/catalog/drills/:slug,
// GET /v1/me/saved-drills, PUT|DELETE /v1/me/saved-drills/:slug).
//
// The REAL handler runs in-process through routesHarness.ts (fake Supabase
// Auth + PostgREST recording every outbound call). Every generated scenario
// is derived from a 32-bit seed, so any row of the results table replays
// with STRESS_REPLAY. Invariants asserted on every request:
//
//   * the handler never throws (a rejected promise is BROKEN);
//   * never a 5xx (and no 5xx may carry the hostile input);
//   * exactly one categorical access-log line with the response status;
//   * the response matches the routing/validation model for that input
//     (status, error.code, body shape as the mobile client parses it);
//   * no PostgREST write unless the model says exactly one (PUT with a
//     shape-valid slug → one upsert of {user_id, slug}; DELETE → one delete
//     filtered on user_id AND slug), never any write on a rejection.
//
// Knobs (all optional):
//   STRESS_ITER=<n>        generated HTTP scenarios (default 250; campaign 3200)
//   STRESS_MODULE_ITER=<n> direct drills.ts / drillMedia.ts fuzz (default 300)
//   STRESS_SEED=<n>        base seed (default 20260904)
//   STRESS_REPLAY=<ids>    comma list of row ids (`gen:<seed>` / `corpus:<n>`)
//   STRESS_OUT=<path>      write the JSON results table (seed → outcome)
//   STRESS_PG_URL=<url>    ALSO cross-check the slug validator against the real
//                          user_saved_drills CHECK constraint on a throwaway
//                          postgres:16 with every migration applied
//                          (`__wf__/xc_pg_up.sh` prints the URL). Never a
//                          hosted project.
//
// Campaign run (the numbers reported in the stress report):
//   STRESS_ITER=3200 STRESS_OUT=/tmp/stress.json \
//     deno test -A --no-check --config deno.json stress_drills_media_boundary_malformed.test.ts

import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { captureAccessLog } from "../http.ts";
import {
  deterministicUuid,
  drillCatalog,
  drillCatalogEntry,
  searchDrillCatalog,
  type CatalogDrillRecord,
} from "../drills.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";
import {
  fakeGoogleIdToken,
  loadHarness,
  type Harness,
  type RecordedCall,
} from "./routesHarness.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Knobs
// ─────────────────────────────────────────────────────────────────────────────

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

const STRESS_ITER = envInt("STRESS_ITER", 250);
const STRESS_MODULE_ITER = envInt("STRESS_MODULE_ITER", 300);
const STRESS_SEED = envInt("STRESS_SEED", 20260904) >>> 0;
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STRESS_OUT = Deno.env.get("STRESS_OUT") ?? "";
const STRESS_PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// Seeded RNG (mulberry32) + per-iteration seed derivation
// ─────────────────────────────────────────────────────────────────────────────

type Rng = {
  next(): number; // [0, 1)
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
};

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => (max <= 0 ? 0 : Math.floor(next() * max)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}

function iterationSeed(base: number, i: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (i + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation model (mirrors index.ts — the oracle the responses are held to)
// ─────────────────────────────────────────────────────────────────────────────

/** index.ts DRILL_SLUG_RE — the edge's saved-drill slug gate. */
const EDGE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
/** 20260831160000_defense_in_depth.sql user_saved_drills_slug_bounds. */
const DB_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_JSON_BODY_BYTES = 5_000_000;
const API_BASE = "http://edge.test/functions/v1/api";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(nonEmptyString);
const isIso = (v: unknown): v is string => nonEmptyString(v) && !Number.isNaN(Date.parse(v));
const isHttps = (v: unknown): v is string => nonEmptyString(v) && v.startsWith("https://");

/** apps/mobile/src/training/api.ts parseCatalogDrill (client contract). */
function catalogItemViolations(item: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(item)) return ["item not an object"];
  if (typeof item.saved !== "boolean") out.push("saved not boolean");
  if (!(typeof item.id === "string" && UUID_RE.test(item.id))) out.push("id not uuid");
  for (const k of ["slug", "title", "description", "coach_name", "validation_state"]) {
    if (!nonEmptyString(item[k])) out.push(`${k} not non-empty string`);
  }
  if (!stringArray(item.equipment)) out.push("equipment not string[]");
  if (!stringArray(item.families)) out.push("families not string[]");
  if (!nullableString(item.difficulty_min)) out.push("difficulty_min");
  if (!nullableString(item.difficulty_max)) out.push("difficulty_max");
  return out;
}

/** apps/mobile/src/training/api.ts parseInstructionalMedia (client contract). */
function mediaViolations(item: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(item)) return ["media not an object"];
  if (!isHttps(item.sourceUrl)) out.push("sourceUrl not https");
  if (!(typeof item.id === "string" && UUID_RE.test(item.id))) out.push("media id not uuid");
  for (const k of ["creatorName", "licenseName", "attribution"]) {
    if (!nonEmptyString(item[k])) out.push(`${k} not non-empty string`);
  }
  if (!nullableString(item.licenseUrl)) out.push("licenseUrl");
  else if (item.licenseUrl !== null && !isHttps(item.licenseUrl)) out.push("licenseUrl not https");
  if (item.kind !== "embed") out.push(`kind ${String(item.kind)} (expected embed)`);
  if (item.provider !== "youtube") out.push("provider not youtube");
  if (!(typeof item.videoId === "string" && YOUTUBE_ID_RE.test(item.videoId))) {
    out.push("videoId not an 11-char YouTube id");
  }
  if (item.embedUrl !== `https://www.youtube-nocookie.com/embed/${String(item.videoId)}`) {
    out.push("embedUrl does not match provider/videoId");
  }
  return out;
}

/** apps/mobile/src/training/api.ts parseDrillDetail (client contract). */
function detailViolations(body: unknown, slug: string): string[] {
  const out: string[] = [];
  if (!isRecord(body)) return ["detail not an object"];
  const drill = body.drill;
  if (!isRecord(drill)) return ["drill missing"];
  if (drill.slug !== slug) out.push("drill.slug != requested slug");
  if (typeof drill.saved !== "boolean") out.push("drill.saved not boolean");
  if (!(typeof drill.id === "string" && UUID_RE.test(drill.id))) out.push("drill.id not uuid");
  for (const k of ["title", "description", "coach_name"]) {
    if (!nonEmptyString(drill[k])) out.push(`drill.${k}`);
  }
  if (!stringArray(drill.equipment)) out.push("drill.equipment");
  if (!Array.isArray(body.mappings)) out.push("mappings not array");
  if (!Array.isArray(body.instructionalMedia)) out.push("instructionalMedia not array");
  else {
    for (const m of body.instructionalMedia) out.push(...mediaViolations(m));
    const ids = new Set(body.instructionalMedia.map((m) => (isRecord(m) ? m.id : "")));
    if (ids.size !== body.instructionalMedia.length) out.push("duplicate media ids");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hostile string generator (shared by paths, query values, headers, bodies)
// ─────────────────────────────────────────────────────────────────────────────

interface Hostile {
  s: string;
  tags: string[];
}

const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
  "isPrototypeOf",
  "toLocaleString",
  "propertyIsEnumerable",
];
const NUMERIC_STRINGS = [
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
  "0",
  "1e400",
  "-1e400",
  "9007199254740993",
  "18446744073709551616",
  "0x1F",
  "1_000",
  "٠١٢٣",
  "1e-400",
  "0.1e1",
  "-9223372036854775809",
];
const TRAVERSAL = [
  "..",
  "../..",
  "..%2f..",
  "%2e%2e",
  "%2e%2e%2f%2e%2e",
  "....//....//etc/passwd",
  "..\\..\\windows",
  "%252e%252e%252f",
  "/etc/passwd",
  "wall-dink-rally/../wall-dink-rally",
  "..%c0%af..",
  "..%5c..",
  "%2e%2e%5c",
];
const MALFORMED_PCT = [
  "%",
  "%2",
  "%zz",
  "%e2%82",
  "%c0%af",
  "%ff%fe",
  "abc%",
  "%ed%a0%80",
  "%E0%80%AF",
  "%%",
];
const NUL_STRINGS = [
  "\u0000",
  "wall\u0000dink",
  "%00",
  "\u0000wall-dink-rally",
  "wall-dink-rally\u0000",
  "%00%00%00",
];
const UNICODE_PAIRS: Array<[string, string]> = [
  ["caf\u00e9", "cafe\u0301"],
  ["\u00c5", "A\u030a"],
  ["\u212b", "\u00c5"], // Angstrom sign vs Å
  ["\ufb01", "fi"],
  ["\uff57\uff41\uff4c\uff4c", "wall"],
  ["\u212a", "k"], // Kelvin sign lowercases to k
  ["\u0130", "i"], // Turkish dotted I
  ["\u017f", "s"], // long s
  ["stra\u00dfe", "strasse"],
  ["\u1e9e", "ss"],
];
const CONTROL_STRINGS = [
  "\r\n",
  "%0d%0a",
  "a\r\nX-Injected: 1",
  "\t",
  "\n",
  "\u001b[31m",
  "\u007f",
  "\u200b",
  "\ufeff",
  "\u202e",
];
const JSON_ISH = ["{}", "[]", "null", "true", '{"__proto__":{}}', '{"slug":', '"', "'", "{", "]"];
const QUERY_GRAMMAR = [
  "eq.x",
  "slug=eq.a",
  "a,b",
  "a*",
  "(a)",
  "'; drop table user_saved_drills;--",
  "in.(a,b)",
  "not.eq.a",
  "a&b=c",
  "a=b",
  "?",
  "#",
  "a?b",
  "a#b",
];
const WHITESPACE = ["", " ", "%20", "  ", ".", "..", "%2e", "\u00a0", "\u3000"];

function randomCodePoints(rng: Rng, n: number): string {
  let out = "";
  for (let i = 0; i < n; i += 1) {
    const r = rng.next();
    let cp: number;
    if (r < 0.3)
      cp = 0x20 + rng.int(0x5f); // printable ASCII
    else if (r < 0.5)
      cp = rng.int(0x20); // C0 controls
    else if (r < 0.7)
      cp = 0x80 + rng.int(0x780); // Latin/Greek/Cyrillic
    else if (r < 0.85)
      cp = 0x1f300 + rng.int(0x2ff); // emoji
    else if (r < 0.92)
      cp = 0xd800 + rng.int(0x800); // lone surrogates
    else cp = 0x10000 + rng.int(0xffff);
    out += cp >= 0xd800 && cp <= 0xdfff ? String.fromCharCode(cp) : String.fromCodePoint(cp);
  }
  return out;
}

function longString(rng: Rng): Hostile {
  const lengths = [119, 120, 121, 255, 256, 1024, 4096, 8192, 16384, 65535, 65536, 65537, 70000];
  const n = rng.pick(lengths);
  const kind = rng.int(6);
  switch (kind) {
    case 0:
      return { s: "a".repeat(n), tags: ["long", `len=${n}`, "ascii"] };
    case 1:
      return { s: "\u00e9".repeat(n), tags: ["long", `codepoints=${n}`, "2-byte"] };
    case 2:
      return { s: "\ud83d\ude00".repeat(n), tags: ["long", `codepoints=${n}`, "4-byte"] };
    case 3:
      // ONE grapheme cluster of n+1 code points (base + combining marks).
      return { s: "a" + "\u0301".repeat(n), tags: ["long", `combining=${n}`, "single-grapheme"] };
    case 4:
      return {
        s: "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66".repeat(
          Math.ceil(n / 7),
        ),
        tags: ["long", `zwj-family≈${n}`, "graphemes"],
      };
    default:
      return {
        s: "wall-dink-rally" + "-".repeat(n),
        tags: ["long", `len=${n + 15}`, "slug-prefixed"],
      };
  }
}

function knownSlugVariant(rng: Rng, known: readonly string[]): Hostile {
  const slug = rng.pick(known);
  const kind = rng.int(8);
  switch (kind) {
    case 0:
      return { s: slug, tags: ["known-slug"] };
    case 1:
      return { s: slug.toUpperCase(), tags: ["known-slug", "upper"] };
    case 2: {
      const chars = [...slug];
      const i = rng.int(chars.length);
      chars[i] = rng.chance(0.5) ? chars[i].toUpperCase() : chars[i].toLowerCase();
      return { s: chars.join(""), tags: ["known-slug", "case-flip"] };
    }
    case 3:
      return { s: slug + rng.pick(["-", "_", "x", " ", ".", "/"]), tags: ["known-slug", "suffix"] };
    case 4:
      return { s: rng.pick(["-", "_", " ", "/", "."]) + slug, tags: ["known-slug", "prefix"] };
    case 5:
      return {
        s: slug.slice(0, Math.max(1, rng.int(slug.length))),
        tags: ["known-slug", "truncated"],
      };
    case 6:
      return { s: slug.replace(/-/g, "_"), tags: ["known-slug", "underscore"] };
    default:
      return { s: slug.replace(/-/g, "\u2010"), tags: ["known-slug", "unicode-hyphen"] };
  }
}

function hostile(rng: Rng, known: readonly string[]): Hostile {
  const r = rng.next();
  if (r < 0.14) return knownSlugVariant(rng, known);
  if (r < 0.22) return { s: rng.pick(TRAVERSAL), tags: ["traversal"] };
  if (r < 0.29) return { s: rng.pick(MALFORMED_PCT), tags: ["malformed-percent"] };
  if (r < 0.35) return { s: rng.pick(NUL_STRINGS), tags: ["nul"] };
  if (r < 0.45) return longString(rng);
  if (r < 0.53) {
    const pair = rng.pick(UNICODE_PAIRS);
    return { s: rng.chance(0.5) ? pair[0] : pair[1], tags: ["unicode-normalization"] };
  }
  if (r < 0.6) return { s: rng.pick(NUMERIC_STRINGS), tags: ["numeric"] };
  if (r < 0.67) return { s: rng.pick(PROTO_KEYS), tags: ["prototype-key"] };
  if (r < 0.72) return { s: rng.pick(WHITESPACE), tags: ["empty-or-whitespace"] };
  if (r < 0.77) return { s: rng.pick(JSON_ISH), tags: ["json-ish"] };
  if (r < 0.82) return { s: rng.pick(CONTROL_STRINGS), tags: ["control-chars"] };
  if (r < 0.87) return { s: rng.pick(QUERY_GRAMMAR), tags: ["query-grammar"] };
  if (r < 0.93) return { s: randomCodePoints(rng, 1 + rng.int(40)), tags: ["random-codepoints"] };
  // Combination of two generators.
  const a = hostile(rng, known);
  const b = hostile(rng, known);
  return { s: a.s + b.s, tags: ["combo", ...a.tags, ...b.tags] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bodies + headers
// ─────────────────────────────────────────────────────────────────────────────

const BODY_STRINGS = [
  "",
  "{",
  '{"slug":',
  '{"slug": "wall-dink-rally"',
  "[]",
  "{}",
  "null",
  "true",
  '"just a string"',
  "NaN",
  "-0",
  "1e400",
  "Infinity",
  '{"__proto__":{"admin":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  '{"prototype":{"x":1}}',
  '{"schemaVersion":99,"slug":"wall-dink-rally","saved":true}',
  '{"schema_version":"2030-01-01","payload":{"nested":{"deep":[[[]]]}}}',
  '{"slug":"' + "a".repeat(70_000) + '"}',
  '{"slug":null,"saved":"yes"}',
  '{"slug":123,"saved":1}',
  '{"slug":["wall-dink-rally"],"saved":[]}',
  '{"slug":{},"saved":{}}',
  '{"slug":"wall\\u0000dink"}',
  '{"a":1,"a":2}',
  "\ufeff{}",
  "{}garbage",
];

type BodyChoice = {
  body: string | Uint8Array<ArrayBuffer> | undefined;
  tag: string;
  contentType?: string;
};

function chooseBody(rng: Rng): BodyChoice {
  const r = rng.next();
  if (r < 0.35) return { body: undefined, tag: "no-body" };
  if (r < 0.85) {
    const text = rng.pick(BODY_STRINGS);
    return {
      body: text,
      tag: `body:${text.length > 40 ? text.slice(0, 37) + "..." : text}`,
      contentType: rng.pick([
        "application/json",
        "application/json",
        "text/plain",
        "application/octet-stream",
        "multipart/form-data; boundary=x",
      ]),
    };
  }
  if (r < 0.95) {
    // Invalid UTF-8 / truncated multibyte bytes.
    const bytes = rng.pick([
      new Uint8Array([0x7b, 0x22, 0xc3]), // {"<truncated é>
      new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
      new Uint8Array([0xc0, 0xaf]),
      new Uint8Array([0xed, 0xa0, 0x80]),
      new Uint8Array([0x00, 0x00, 0x00]),
    ]);
    return {
      body: bytes,
      tag: `body-bytes:${Array.from(bytes)
        .map((b) => b.toString(16))
        .join("")}`,
      contentType: "application/json",
    };
  }
  return {
    body: JSON.stringify({ v: 1 }).repeat(2000),
    tag: "body:repeated-json",
    contentType: "application/json",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario model
// ─────────────────────────────────────────────────────────────────────────────

type WriteExpectation =
  | { kind: "none" }
  | { kind: "upsert"; slug: string; userId: string }
  | { kind: "delete"; slug: string; userId: string };

interface Expectation {
  statuses: number[];
  code?: string;
  message?: string;
  writes: WriteExpectation;
  /** When false, no PostgREST call at all may happen (rejected pre-DB). */
  restAllowed: boolean;
  /** Body validator for 2xx responses. */
  ok?: (body: unknown) => string[];
  /** Model note carried into the results table. */
  note: string;
}

interface Scenario {
  id: string;
  seed: number;
  category: string;
  tags: string[];
  request: Request;
  hostileInput: string;
  userId: string;
  tablesBefore?: Record<string, unknown[]>;
  expectation: Expectation;
}

interface Outcome {
  id: string;
  seed: number;
  category: string;
  tags: string[];
  method: string;
  url: string;
  urlLength: number;
  status: number | null;
  code: string | null;
  writes: number;
  restCalls: number;
  reflected: boolean;
  outcome: "HELD" | "BROKEN" | "KNOWN_DEFECT";
  violations: string[];
  note: string;
  ms: number;
}

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** The path index.ts routes on: everything from the LAST "/v1/" onward. */
const routedPath = (url: URL): string => {
  const v1 = url.pathname.lastIndexOf("/v1/");
  return v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
};

function contentLengthRejects(request: Request): boolean {
  const declared = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES;
}

/**
 * The oracle. Given the request the handler will actually see (after WHATWG
 * URL normalisation), predict the contract response: statuses, error code,
 * and — critically — whether ANY PostgREST write is legitimate.
 */
function modelFor(
  request: Request,
  known: ReadonlySet<string>,
  userId: string,
  authOk: boolean,
  savedRows: number,
): Expectation {
  if (contentLengthRejects(request)) {
    return {
      statuses: [413],
      message: "Request body is too large.",
      writes: { kind: "none" },
      restAllowed: false,
      note: "declared content-length above the 5 MB cap → 413 before auth",
    };
  }
  if (!authOk) {
    return {
      statuses: [401],
      writes: { kind: "none" },
      restAllowed: false,
      note: "unauthenticated → 401, nothing reaches PostgREST",
    };
  }
  const url = new URL(request.url);
  const path = routedPath(url);
  const method = request.method;

  if (method === "GET" && path === "/v1/catalog/drills") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const family = (url.searchParams.get("family") ?? "").trim().toLowerCase();
    return {
      statuses: [200],
      writes: { kind: "none" },
      restAllowed: true,
      note: `catalog list q=${JSON.stringify(q.slice(0, 20))} family=${JSON.stringify(family.slice(0, 20))}`,
      ok: (body) => {
        const out: string[] = [];
        if (!isRecord(body) || !Array.isArray(body.items)) return ["items missing"];
        if (body.cursor !== null) out.push("cursor not null");
        if (body.items.length > known.size) out.push("more items than catalog");
        if (!q && !family && body.items.length !== known.size)
          out.push("unfiltered list != catalog size");
        for (const item of body.items) out.push(...catalogItemViolations(item));
        const slugs = new Set(body.items.map((i) => (isRecord(i) ? i.slug : "")));
        if (slugs.size !== body.items.length) out.push("duplicate slugs in list");
        return out;
      },
    };
  }
  let m = method === "GET" ? /^\/v1\/catalog\/drills\/([^/]+)$/.exec(path) : null;
  if (m) {
    const slug = decodeSegment(m[1]);
    if (slug === null) {
      return {
        statuses: [400],
        message: "Malformed path segment.",
        writes: { kind: "none" },
        restAllowed: false,
        note: "undecodable %-escape → 400",
      };
    }
    if (!known.has(slug)) {
      return {
        statuses: [404],
        code: "drill.not_found",
        writes: { kind: "none" },
        restAllowed: false,
        note: "slug not in catalog → coded 404, no DB call",
      };
    }
    return {
      statuses: [200],
      writes: { kind: "none" },
      restAllowed: true,
      note: "known slug → detail + media",
      ok: (body) => detailViolations(body, slug),
    };
  }
  if (method === "GET" && path === "/v1/me/saved-drills") {
    return {
      statuses: [200],
      writes: { kind: "none" },
      restAllowed: true,
      note: `saved list hydrated from ${savedRows} stored rows`,
      ok: (body) => {
        const out: string[] = [];
        if (!isRecord(body) || !Array.isArray(body.items)) return ["items missing"];
        if (body.items.length !== savedRows)
          out.push(`items=${body.items.length} rows=${savedRows}`);
        for (const item of body.items) {
          if (!isRecord(item)) {
            out.push("saved item not object");
            continue;
          }
          if (!(typeof item.id === "string" && UUID_RE.test(item.id)))
            out.push("saved id not uuid");
          for (const k of ["slug", "title", "description", "coach_name"]) {
            if (typeof item[k] !== "string") out.push(`saved ${k} not string`);
          }
          if (!isIso(item.saved_at)) out.push("saved_at not ISO");
          if (!Array.isArray(item.equipment)) out.push("equipment not array");
        }
        return out;
      },
    };
  }
  m =
    method === "PUT" || method === "DELETE" ? /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(path) : null;
  if (m) {
    const slug = decodeSegment(m[1]);
    if (slug === null) {
      return {
        statuses: [400],
        message: "Malformed path segment.",
        writes: { kind: "none" },
        restAllowed: false,
        note: "undecodable %-escape → 400 before any DB call",
      };
    }
    if (method === "PUT") {
      if (!EDGE_SLUG_RE.test(slug)) {
        return {
          statuses: [400],
          code: "validation.saved_drill",
          writes: { kind: "none" },
          restAllowed: false,
          note: "slug fails DRILL_SLUG_RE → coded 400, no write",
        };
      }
      return {
        statuses: [200],
        writes: { kind: "upsert", slug, userId },
        restAllowed: true,
        note: known.has(slug)
          ? "shape-valid catalog slug → one upsert"
          : "KNOWN DEFECT (drills_billing_healthz.test.ts): shape-valid NON-catalog slug is persisted",
        ok: (body) => {
          const out: string[] = [];
          if (!isRecord(body)) return ["body not object"];
          if (body.slug !== slug) out.push("echoed slug differs");
          if (body.saved !== true) out.push("saved !== true");
          if (!isIso(body.savedAt)) out.push("savedAt not ISO");
          return out;
        },
      };
    }
    return {
      statuses: [204],
      writes: { kind: "delete", slug, userId },
      restAllowed: true,
      note: "DELETE is idempotent: one delete filtered on user_id + slug, no shape gate",
    };
  }
  return {
    statuses: [404],
    writes: { kind: "none" },
    restAllowed: false,
    note: "no route matched → generic 404 (route echoed in message)",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario generation
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_TITLE_FRAGMENTS = [
  "dink",
  "Reset",
  "WALL",
  "drop",
  "serve",
  "third",
  "kitchen",
  "volley",
];

type EncodeMode = "raw" | "encoded" | "double";

function encodeSegment(s: string, mode: EncodeMode): string {
  if (mode === "raw") return s;
  // Lone surrogates cannot be percent-encoded (URIError client-side); the URL
  // parser would turn them into U+FFFD anyway, so do the same here.
  const once = encodeURIComponent(s.toWellFormed());
  return mode === "encoded" ? once : encodeURIComponent(once);
}

interface GenContext {
  known: readonly string[];
  knownSet: ReadonlySet<string>;
  userBuckets: number;
}

function ipFor(seed: number): string {
  return `10.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${seed & 255}`;
}

function buildRequest(
  method: string,
  pathAndQuery: string,
  opts: {
    token: string | null;
    ip: string;
    body?: string | Uint8Array<ArrayBuffer>;
    headers?: Record<string, string>;
  },
): Request {
  const headers = new Headers();
  if (opts.token !== null) headers.set("Authorization", opts.token);
  headers.set("x-forwarded-for", opts.ip);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") init.body = opts.body;
  return new Request(`${API_BASE}${pathAndQuery}`, init);
}

/** HTTP field values are ByteStrings without CR/LF/NUL; anything else is a
 * client-side TypeError at Request construction, not a server input. Keep
 * the rest of the hostile string intact. */
function headerSafe(value: string): string {
  let out = "";
  for (const ch of value.toWellFormed()) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x08 || (cp >= 0x0a && cp <= 0x1f) || cp === 0x7f) continue;
    out += cp <= 0xff ? ch : encodeURIComponent(ch);
  }
  return out;
}

const b64url = (v: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(v)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Replica of index.ts bearerOf → decodeJwtPayload → providerForIssuer →
 * bearerExpired: does this Authorization header reach the (stubbed) provider
 * exchange? Supabase-issued session bearers are never generated here (the
 * routes harness has no getUser stub), so provider tokens are the only
 * accepted class.
 */
function authAccepted(authorization: string | null): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return false;
  const segments = token.split(".");
  if (segments.length !== 3) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(atob(segments[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return false;
  }
  const rec =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const issuer = rec?.iss;
  if (typeof issuer !== "string") return false;
  const iss = issuer.replace(/^https:\/\//, "");
  if (iss !== "accounts.google.com" && iss !== "appleid.apple.com") return false;
  const exp = rec?.exp;
  if (typeof exp === "number" && exp * 1_000 <= Date.now()) return false;
  return true;
}

/** Hostile Authorization headers. Validity is decided by `authAccepted` on
 * the header the Request actually carries (Headers trims values). */
function hostileAuth(
  rng: Rng,
  userId: string,
  known: readonly string[],
): { header: string | null; tag: string } {
  const jwt = (payloadJson: string, header: unknown = { alg: "none" }, sig = "sig") =>
    `${b64url(JSON.stringify(header))}.${b64url(payloadJson)}.${b64url(sig)}`;
  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: "https://accounts.google.com",
    sub: userId,
    aud: "test",
    exp: now + 3600,
    iat: now,
  };
  const withClaims = (patch: Record<string, unknown>) => JSON.stringify({ ...base, ...patch });
  const r = rng.int(23);
  switch (r) {
    case 0:
      return { header: null, tag: "auth:missing" };
    case 1:
      return { header: "Bearer", tag: "auth:bare-Bearer" };
    case 2:
      return { header: "Bearer ", tag: "auth:Bearer-space(trimmed)" };
    case 3:
      return { header: `bearer ${fakeGoogleIdToken(userId)}`, tag: "auth:lowercase-scheme" };
    case 4:
      return { header: `Basic ${b64url("user:pass")}`, tag: "auth:basic" };
    case 5:
      return { header: `Bearer ${headerSafe(hostile(rng, known).s)}`, tag: "auth:hostile-token" };
    case 6:
      return { header: `Bearer ${"a".repeat(70_000)}`, tag: "auth:64KB-token" };
    case 7:
      return { header: `Bearer a.b`, tag: "auth:2-segments" };
    case 8:
      return { header: `Bearer a.b.c.d`, tag: "auth:4-segments" };
    case 9:
      return { header: `Bearer x.!!!.y`, tag: "auth:non-base64-payload" };
    case 10:
      return { header: `Bearer x.${b64url("null")}.y`, tag: "auth:payload-null" };
    case 11:
      return { header: `Bearer x.${b64url("[]")}.y`, tag: "auth:payload-array" };
    case 12:
      return { header: `Bearer x.${b64url('"str"')}.y`, tag: "auth:payload-string" };
    case 13:
      return { header: `Bearer x.${b64url("123")}.y`, tag: "auth:payload-number" };
    case 14:
      return {
        header: `Bearer ${jwt(withClaims({ iss: "accounts.google.com.evil.com" }))}`,
        tag: "auth:iss-suffix-spoof",
      };
    case 15:
      return {
        header: `Bearer ${jwt(withClaims({ iss: "https://accounts.google.com/" }))}`,
        tag: "auth:iss-trailing-slash",
      };
    case 16:
      return {
        header: `Bearer ${jwt(withClaims({ iss: "https://accounts.google.com/v99" }))}`,
        tag: "auth:iss-future-version",
      };
    case 17:
      return { header: `Bearer ${jwt(withClaims({ exp: now - 1 }))}`, tag: "auth:expired" };
    case 18:
      return {
        header: `Bearer ${jwt(withClaims({ exp: String(now - 1) }))}`,
        tag: "auth:exp-string",
      };
    case 19:
      return {
        header: `Bearer ${jwt(withClaims({ iss: "accounts.google.com" }))}`,
        tag: "auth:iss-without-scheme",
      };
    case 20:
      return {
        header: `Bearer ${jwt(`${withClaims({}).slice(0, -1)},"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}`)}`,
        tag: "auth:proto-claims",
      };
    case 21:
      return { header: `Bearer ${jwt(withClaims({ exp: 1e308 }))}`, tag: "auth:exp-1e308" };
    default:
      return {
        header: `Bearer ${jwt(withClaims({ exp: null, iat: "NaN", aud: [] }))}`,
        tag: "auth:exp-null",
      };
  }
}

function generate(seed: number, ctx: GenContext): Scenario {
  const rng = mulberry32(seed);
  const userId = `stress-u-${seed % ctx.userBuckets}`;
  const ip = ipFor(seed);
  const token = `Bearer ${fakeGoogleIdToken(userId)}`;
  const r = rng.next();
  const tags: string[] = [];
  let category: string;
  let request: Request;
  let hostileInput = "";
  let authOk = true;
  let tablesBefore: Record<string, unknown[]> | undefined;
  let savedRows = 0;

  const mode: EncodeMode = rng.pick(["raw", "encoded", "encoded", "double"]);
  tags.push(`enc=${mode}`);

  if (r < 0.25) {
    category = "detail_slug";
    const h = hostile(rng, ctx.known);
    hostileInput = h.s;
    tags.push(...h.tags);
    request = buildRequest("GET", `/v1/catalog/drills/${encodeSegment(h.s, mode)}`, { token, ip });
  } else if (r < 0.4) {
    category = "list_query";
    const params = new URLSearchParams();
    const qh = rng.chance(0.3)
      ? { s: rng.pick(KNOWN_TITLE_FRAGMENTS), tags: ["known-fragment"] }
      : hostile(rng, ctx.known);
    hostileInput = qh.s;
    tags.push(...qh.tags);
    if (rng.chance(0.85)) params.append("q", qh.s);
    if (rng.chance(0.5))
      params.append(
        "family",
        rng.chance(0.5) ? hostile(rng, ctx.known).s : rng.pick(["dink", "reset", "drop", ""]),
      );
    if (rng.chance(0.2)) params.append("q", "second-q-value");
    if (rng.chance(0.2)) params.append("__proto__", "polluted");
    if (rng.chance(0.2)) params.append("q[]", "array-style");
    if (rng.chance(0.1)) params.append("schemaVersion", "99");
    const qs = params.toString();
    request = buildRequest("GET", `/v1/catalog/drills${qs ? `?${qs}` : ""}`, { token, ip });
  } else if (r < 0.6) {
    category = "put_slug";
    const h = hostile(rng, ctx.known);
    hostileInput = h.s;
    tags.push(...h.tags);
    const body = chooseBody(rng);
    tags.push(body.tag);
    const headers: Record<string, string> = {};
    if (body.contentType) headers["content-type"] = body.contentType;
    if (rng.chance(0.15)) {
      const cl = rng.pick([
        "5000001",
        "5000000",
        "NaN",
        "Infinity",
        "-0",
        "-1",
        "1e400",
        "0x10",
        "",
        " 42 ",
        "9".repeat(400),
        "4999999",
      ]);
      headers["content-length"] = cl;
      tags.push(`content-length=${cl.length > 12 ? cl.slice(0, 9) + "..." : cl}`);
    }
    request = buildRequest("PUT", `/v1/me/saved-drills/${encodeSegment(h.s, mode)}`, {
      token,
      ip,
      body: body.body,
      headers,
    });
    tablesBefore = { user_saved_drills: [{ slug: "row", saved_at: "2026-09-04T00:00:00.000Z" }] };
  } else if (r < 0.75) {
    category = "delete_slug";
    const h = hostile(rng, ctx.known);
    hostileInput = h.s;
    tags.push(...h.tags);
    const body = chooseBody(rng);
    tags.push(body.tag);
    const headers: Record<string, string> = {};
    if (body.contentType) headers["content-type"] = body.contentType;
    request = buildRequest("DELETE", `/v1/me/saved-drills/${encodeSegment(h.s, mode)}`, {
      token,
      ip,
      body: body.body,
      headers,
    });
  } else if (r < 0.85) {
    category = "auth_fuzz";
    const auth = hostileAuth(rng, userId, ctx.known);
    tags.push(auth.tag);
    hostileInput = auth.header ?? "";
    const target = rng.pick([
      { method: "GET", path: "/v1/catalog/drills" },
      { method: "GET", path: `/v1/catalog/drills/${encodeURIComponent(rng.pick(ctx.known))}` },
      { method: "PUT", path: `/v1/me/saved-drills/${encodeURIComponent(rng.pick(ctx.known))}` },
      { method: "DELETE", path: `/v1/me/saved-drills/${encodeURIComponent(rng.pick(ctx.known))}` },
    ]);
    tags.push(`${target.method} ${target.path.slice(0, 40)}`);
    request = buildRequest(target.method, target.path, { token: auth.header, ip });
    authOk = authAccepted(request.headers.get("Authorization"));
    tablesBefore = { user_saved_drills: [{ slug: "row", saved_at: "2026-09-04T00:00:00.000Z" }] };
  } else if (r < 0.92) {
    category = "saved_list_rows";
    const n = rng.int(6);
    const rows: unknown[] = [];
    for (let i = 0; i < n; i += 1) {
      const pickKind = rng.int(5);
      const slug =
        pickKind === 0
          ? rng.pick(ctx.known)
          : pickKind === 1
            ? hostile(rng, ctx.known).s
            : pickKind === 2
              ? rng.pick(PROTO_KEYS)
              : pickKind === 3
                ? rng.pick([
                    null,
                    0,
                    -0,
                    NaN,
                    1e400,
                    true,
                    [],
                    {},
                    ["a"],
                    { slug: "x" },
                  ] as unknown[])
                : hostile(rng, ctx.known).s;
      rows.push({ slug, saved_at: "2026-09-04T12:00:00.000Z" });
    }
    savedRows = n;
    hostileInput = JSON.stringify(rows.map((row) => (isRecord(row) ? row.slug : row))).slice(
      0,
      200,
    );
    tags.push(`rows=${n}`);
    tablesBefore = { user_saved_drills: rows };
    request = buildRequest("GET", "/v1/me/saved-drills", { token, ip });
  } else {
    category = "header_fuzz";
    const h = hostile(rng, ctx.known);
    hostileInput = h.s;
    const headerName = rng.pick([
      "x-forwarded-for",
      "x-request-id",
      "accept",
      "content-type",
      "cf-connecting-ip",
      "x-schema-version",
      "accept-encoding",
      "user-agent",
    ]);
    tags.push(...h.tags, `header=${headerName}`);
    const headers: Record<string, string> = {};
    const value = headerSafe(h.s);
    if (value.length > 0) headers[headerName] = value;
    const target = rng.pick([
      { method: "GET", path: "/v1/catalog/drills" },
      { method: "GET", path: `/v1/catalog/drills/${encodeURIComponent(rng.pick(ctx.known))}` },
    ]);
    // A hostile x-forwarded-for / cf-connecting-ip changes the rate-limit key
    // only; the request stays authenticated. Keep the seeded ip as a fallback
    // hop so the "unknown" bucket is never shared across iterations.
    request = buildRequest(target.method, target.path, {
      token,
      ip: headerName === "x-forwarded-for" ? `${value}, ${ip}` : ip,
      headers: headerName === "x-forwarded-for" ? {} : headers,
    });
  }

  const expectation = modelFor(request, ctx.knownSet, userId, authOk, savedRows);
  return {
    id: `gen:${seed}`,
    seed,
    category,
    tags,
    request,
    hostileInput,
    userId,
    tablesBefore,
    expectation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand-written corpus (minimal, named reproductions; always run)
// ─────────────────────────────────────────────────────────────────────────────

interface CorpusEntry {
  name: string;
  method: string;
  path: string;
  body?: string | Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  auth?: string | null; // undefined → valid token
  hostile: string;
  tables?: Record<string, unknown[]>;
}

const A64K = "a".repeat(65_536);
const SLUG120 = "s" + "a".repeat(119);
const SLUG121 = "s" + "a".repeat(120);

function corpus(known: readonly string[]): CorpusEntry[] {
  const k0 = known[0];
  const savedRow = { user_saved_drills: [{ slug: "row", saved_at: "2026-09-04T00:00:00.000Z" }] };
  return [
    { name: "detail known slug", method: "GET", path: `/v1/catalog/drills/${k0}`, hostile: k0 },
    {
      name: "detail upper-cased known slug",
      method: "GET",
      path: `/v1/catalog/drills/${k0.toUpperCase()}`,
      hostile: k0.toUpperCase(),
    },
    {
      name: "detail overlong UTF-8 %c0%af",
      method: "GET",
      path: "/v1/catalog/drills/%c0%af",
      hostile: "%c0%af",
    },
    {
      name: "detail lone surrogate %ed%a0%80",
      method: "GET",
      path: "/v1/catalog/drills/%ed%a0%80",
      hostile: "%ed%a0%80",
    },
    { name: "detail bare percent", method: "GET", path: "/v1/catalog/drills/%", hostile: "%" },
    { name: "detail NUL", method: "GET", path: "/v1/catalog/drills/%00", hostile: "%00" },
    {
      name: "detail NUL inside known slug",
      method: "GET",
      path: `/v1/catalog/drills/${k0}%00`,
      hostile: `${k0}%00`,
    },
    {
      name: "detail traversal encoded",
      method: "GET",
      path: "/v1/catalog/drills/..%2f..%2fetc%2fpasswd",
      hostile: "..%2f..%2fetc%2fpasswd",
    },
    {
      name: "detail traversal raw (URL-normalised)",
      method: "GET",
      path: "/v1/catalog/drills/../../etc/passwd",
      hostile: "../../etc/passwd",
    },
    {
      name: "detail double-encoded traversal",
      method: "GET",
      path: "/v1/catalog/drills/%252e%252e%252f",
      hostile: "%252e%252e%252f",
    },
    { name: "detail 64KB slug", method: "GET", path: `/v1/catalog/drills/${A64K}`, hostile: A64K },
    {
      name: "detail 64KB slug + extra segment (unknown endpoint echo)",
      method: "GET",
      path: `/v1/catalog/drills/${A64K}/x`,
      hostile: A64K,
    },
    {
      name: "detail __proto__",
      method: "GET",
      path: "/v1/catalog/drills/__proto__",
      hostile: "__proto__",
    },
    {
      name: "detail constructor",
      method: "GET",
      path: "/v1/catalog/drills/constructor",
      hostile: "constructor",
    },
    {
      name: "detail NFC é",
      method: "GET",
      path: `/v1/catalog/drills/${encodeURIComponent("caf\u00e9")}`,
      hostile: "caf\u00e9",
    },
    {
      name: "detail NFD é",
      method: "GET",
      path: `/v1/catalog/drills/${encodeURIComponent("cafe\u0301")}`,
      hostile: "cafe\u0301",
    },
    {
      name: "detail Kelvin sign",
      method: "GET",
      path: `/v1/catalog/drills/${encodeURIComponent("\u212a")}`,
      hostile: "\u212a",
    },
    {
      name: "detail numeric 1e400",
      method: "GET",
      path: "/v1/catalog/drills/1e400",
      hostile: "1e400",
    },
    {
      name: "detail empty segment (trailing slash)",
      method: "GET",
      path: "/v1/catalog/drills/",
      hostile: "",
    },
    { name: "detail dot segment", method: "GET", path: "/v1/catalog/drills/.", hostile: "." },
    { name: "list empty q", method: "GET", path: "/v1/catalog/drills?q=", hostile: "" },
    { name: "list 64KB q", method: "GET", path: `/v1/catalog/drills?q=${A64K}`, hostile: A64K },
    { name: "list q NUL", method: "GET", path: "/v1/catalog/drills?q=%00", hostile: "%00" },
    {
      name: "list q malformed percent",
      method: "GET",
      path: "/v1/catalog/drills?q=%zz&family=%",
      hostile: "%zz",
    },
    {
      name: "list q Kelvin sign (lowercases to k)",
      method: "GET",
      path: `/v1/catalog/drills?q=${encodeURIComponent("\u212a")}`,
      hostile: "\u212a",
    },
    {
      name: "list q Turkish İ",
      method: "GET",
      path: `/v1/catalog/drills?q=${encodeURIComponent("D\u0130NK")}`,
      hostile: "D\u0130NK",
    },
    {
      name: "list q known fragment upper",
      method: "GET",
      path: "/v1/catalog/drills?q=DINK",
      hostile: "DINK",
    },
    {
      name: "list repeated q + __proto__ param",
      method: "GET",
      path: "/v1/catalog/drills?q=dink&q=zzz&__proto__=1&constructor=2",
      hostile: "dink",
    },
    {
      name: "list q[] array-style",
      method: "GET",
      path: "/v1/catalog/drills?q[]=dink",
      hostile: "dink",
    },
    {
      name: "list family only",
      method: "GET",
      path: "/v1/catalog/drills?family=RESET",
      hostile: "RESET",
    },
    {
      name: "put 120-char slug (boundary ok)",
      method: "PUT",
      path: `/v1/me/saved-drills/${SLUG120}`,
      hostile: SLUG120,
      tables: savedRow,
    },
    {
      name: "put 121-char slug (boundary reject)",
      method: "PUT",
      path: `/v1/me/saved-drills/${SLUG121}`,
      hostile: SLUG121,
      tables: savedRow,
    },
    {
      name: "put 64KB slug",
      method: "PUT",
      path: `/v1/me/saved-drills/${A64K}`,
      hostile: A64K,
      tables: savedRow,
    },
    {
      name: "put NUL",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}%00`,
      hostile: `${k0}%00`,
      tables: savedRow,
    },
    {
      name: "put overlong UTF-8",
      method: "PUT",
      path: "/v1/me/saved-drills/%c0%af",
      hostile: "%c0%af",
      tables: savedRow,
    },
    {
      name: "put traversal encoded",
      method: "PUT",
      path: "/v1/me/saved-drills/..%2f..%2fetc",
      hostile: "..%2f..%2fetc",
      tables: savedRow,
    },
    {
      name: "put __proto__",
      method: "PUT",
      path: "/v1/me/saved-drills/__proto__",
      hostile: "__proto__",
      tables: savedRow,
    },
    {
      name: "put constructor",
      method: "PUT",
      path: "/v1/me/saved-drills/constructor",
      hostile: "constructor",
      tables: savedRow,
    },
    {
      name: "put upper-cased known slug (KNOWN DEFECT: persisted)",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0.toUpperCase()}`,
      hostile: k0.toUpperCase(),
      tables: savedRow,
    },
    {
      name: "put Kelvin sign",
      method: "PUT",
      path: `/v1/me/saved-drills/${encodeURIComponent("\u212a")}`,
      hostile: "\u212a",
      tables: savedRow,
    },
    {
      name: "put long s ſ",
      method: "PUT",
      path: `/v1/me/saved-drills/${encodeURIComponent("\u017f")}`,
      hostile: "\u017f",
      tables: savedRow,
    },
    {
      name: "put NFD slug",
      method: "PUT",
      path: `/v1/me/saved-drills/${encodeURIComponent("cafe\u0301")}`,
      hostile: "cafe\u0301",
      tables: savedRow,
    },
    {
      name: "put slug with trailing newline",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}%0a`,
      hostile: `${k0}\n`,
      tables: savedRow,
    },
    {
      name: "put -0",
      method: "PUT",
      path: "/v1/me/saved-drills/-0",
      hostile: "-0",
      tables: savedRow,
    },
    {
      name: "put NaN",
      method: "PUT",
      path: "/v1/me/saved-drills/NaN",
      hostile: "NaN",
      tables: savedRow,
    },
    {
      name: "put empty (trailing slash)",
      method: "PUT",
      path: "/v1/me/saved-drills/",
      hostile: "",
      tables: savedRow,
    },
    {
      name: "put body truncated JSON",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: '{"slug":',
      headers: { "content-type": "application/json" },
      hostile: '{"slug":',
      tables: savedRow,
    },
    {
      name: "put body __proto__ pollution",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}',
      headers: { "content-type": "application/json" },
      hostile: "__proto__",
      tables: savedRow,
    },
    {
      name: "put body invalid UTF-8",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: new Uint8Array([0xff, 0xfe, 0xc0, 0xaf]),
      headers: { "content-type": "application/json" },
      hostile: "fffec0af",
      tables: savedRow,
    },
    {
      name: "put body future schema",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: '{"schemaVersion":99,"slug":"other","saved":false}',
      headers: { "content-type": "application/json" },
      hostile: "schemaVersion=99",
      tables: savedRow,
    },
    {
      name: "put body 70KB",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: `{"x":"${"b".repeat(70_000)}"}`,
      headers: { "content-type": "application/json" },
      hostile: "70KB body",
      tables: savedRow,
    },
    {
      name: "put content-length 5000001",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: "{}",
      headers: { "content-length": "5000001" },
      hostile: "5000001",
      tables: savedRow,
    },
    {
      name: "put content-length 5000000 (boundary ok)",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: "{}",
      headers: { "content-length": "5000000" },
      hostile: "5000000",
      tables: savedRow,
    },
    {
      name: "put content-length NaN",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: "{}",
      headers: { "content-length": "NaN" },
      hostile: "NaN",
      tables: savedRow,
    },
    {
      name: "put content-length Infinity",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: "{}",
      headers: { "content-length": "Infinity" },
      hostile: "Infinity",
      tables: savedRow,
    },
    {
      name: "put content-length -0",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: "{}",
      headers: { "content-length": "-0" },
      hostile: "-0",
      tables: savedRow,
    },
    {
      name: "put content-length 1e400",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      body: "{}",
      headers: { "content-length": "1e400" },
      hostile: "1e400",
      tables: savedRow,
    },
    { name: "delete known slug", method: "DELETE", path: `/v1/me/saved-drills/${k0}`, hostile: k0 },
    {
      name: "delete 64KB slug (no shape gate)",
      method: "DELETE",
      path: `/v1/me/saved-drills/${A64K}`,
      hostile: A64K,
    },
    {
      name: "delete NUL slug (no shape gate)",
      method: "DELETE",
      path: "/v1/me/saved-drills/%00",
      hostile: "%00",
    },
    {
      name: "delete overlong UTF-8",
      method: "DELETE",
      path: "/v1/me/saved-drills/%c0%af",
      hostile: "%c0%af",
    },
    {
      name: "delete __proto__",
      method: "DELETE",
      path: "/v1/me/saved-drills/__proto__",
      hostile: "__proto__",
    },
    {
      name: "delete PostgREST grammar in slug",
      method: "DELETE",
      path: `/v1/me/saved-drills/${encodeURIComponent("a,b)*")}`,
      hostile: "a,b)*",
    },
    {
      name: "delete with body",
      method: "DELETE",
      path: `/v1/me/saved-drills/${k0}`,
      body: '{"__proto__":{}}',
      headers: { "content-type": "application/json" },
      hostile: "__proto__",
    },
    { name: "auth missing", method: "GET", path: "/v1/catalog/drills", auth: null, hostile: "" },
    {
      name: "auth 64KB bearer",
      method: "GET",
      path: "/v1/catalog/drills",
      auth: `Bearer ${A64K}`,
      hostile: A64K,
    },
    {
      name: "auth non-base64 payload",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      auth: "Bearer x.!!!.y",
      hostile: "x.!!!.y",
      tables: savedRow,
    },
    {
      name: "auth payload null",
      method: "DELETE",
      path: `/v1/me/saved-drills/${k0}`,
      auth: `Bearer x.${btoa("null")}.y`,
      hostile: "null",
    },
    {
      name: "auth issuer suffix spoof",
      method: "PUT",
      path: `/v1/me/saved-drills/${k0}`,
      auth: `Bearer x.${btoa(JSON.stringify({ iss: "https://accounts.google.com.evil.com", sub: "x", exp: 4102444800 }))}.y`,
      hostile: "accounts.google.com.evil.com",
      tables: savedRow,
    },
    {
      name: "saved list with prototype-key + non-string slugs from storage",
      method: "GET",
      path: "/v1/me/saved-drills",
      hostile: "__proto__",
      tables: {
        user_saved_drills: [
          { slug: "__proto__", saved_at: "2026-09-04T12:00:00.000Z" },
          { slug: "constructor", saved_at: "2026-09-04T12:00:00.000Z" },
          { slug: null, saved_at: "2026-09-04T12:00:00.000Z" },
          { slug: 1e400, saved_at: "2026-09-04T12:00:00.000Z" },
          { slug: k0, saved_at: "2026-09-04T12:00:00.000Z" },
        ],
      },
    },
    {
      name: "unknown endpoint echoes route",
      method: "GET",
      path: `/v1/catalog/drills/x/${encodeURIComponent("<script>alert(1)</script>")}`,
      hostile: "<script>alert(1)</script>",
    },
  ];
}

function corpusScenario(entry: CorpusEntry, index: number, ctx: GenContext): Scenario {
  const seed = 0x40000000 + index;
  const userId = `stress-corpus-${index}`;
  const token = entry.auth === undefined ? `Bearer ${fakeGoogleIdToken(userId)}` : entry.auth;
  const request = buildRequest(entry.method, entry.path, {
    token,
    ip: ipFor(seed),
    body: entry.body,
    headers: entry.headers,
  });
  const authOk = authAccepted(request.headers.get("Authorization"));
  const savedRows = entry.tables?.user_saved_drills?.length ?? 0;
  const expectation = modelFor(
    request,
    ctx.knownSet,
    userId,
    authOk,
    entry.method === "GET" && entry.path === "/v1/me/saved-drills" ? savedRows : 0,
  );
  return {
    id: `corpus:${index}`,
    seed,
    category: `corpus`,
    tags: [entry.name],
    request,
    hostileInput: entry.hostile,
    userId,
    tablesBefore: entry.tables,
    expectation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution + verdict
// ─────────────────────────────────────────────────────────────────────────────

const isRestWrite = (c: RecordedCall) =>
  c.url.includes("/rest/v1/") &&
  (c.method === "POST" || c.method === "PATCH" || c.method === "DELETE" || c.method === "PUT");
const isRest = (c: RecordedCall) => c.url.includes("/rest/v1/");

async function runScenario(h: Harness, sc: Scenario): Promise<Outcome> {
  h.reset();
  if (sc.tablesBefore) h.tables = { ...sc.tablesBefore };
  const logs: string[] = [];
  const restore = captureAccessLog((line) => logs.push(line));
  const started = performance.now();
  let response: Response | null = null;
  let thrown: unknown = null;
  try {
    response = await h.handler(sc.request);
  } catch (error) {
    thrown = error;
  } finally {
    restore();
  }
  const ms = performance.now() - started;
  const violations: string[] = [];
  let status: number | null = null;
  let code: string | null = null;
  let reflected = false;
  const writes = h.calls.filter(isRestWrite);
  const rest = h.calls.filter(isRest);

  if (thrown !== null) {
    violations.push(
      `handler threw: ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`,
    );
  } else if (response) {
    status = response.status;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let body: unknown = undefined;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        violations.push("JSON content-type with unparsable body");
      }
    } else if (status !== 204 && status !== 201) {
      violations.push(`non-JSON content-type ${JSON.stringify(contentType)} for status ${status}`);
    }
    if (!response.headers.get("x-request-id")) violations.push("missing x-request-id");
    if (status >= 500) violations.push(`5xx ${status}: ${text.slice(0, 120)}`);
    if (status >= 400) {
      if (!isRecord(body) || !isRecord(body.error) || typeof body.error.message !== "string") {
        violations.push("error body lacks error.message");
      } else {
        code = typeof body.error.code === "string" ? body.error.code : null;
        const extraKeys = Object.keys(body.error).filter((k) => k !== "code" && k !== "message");
        if (extraKeys.length) violations.push(`error carries extra keys ${extraKeys.join(",")}`);
        if (sc.hostileInput.length >= 8 && text.includes(sc.hostileInput)) reflected = true;
        if (status >= 500 && reflected) violations.push("5xx reflects hostile input");
        if (/PGRST|postgres|syntax error|at .*\.ts:\d+|TypeError|ReferenceError/i.test(text)) {
          violations.push("error body carries internal detail");
        }
      }
    }
    if (!sc.expectation.statuses.includes(status)) {
      violations.push(
        `status ${status} not in ${JSON.stringify(sc.expectation.statuses)} (${text.slice(0, 100)})`,
      );
    } else {
      if (sc.expectation.code !== undefined && code !== sc.expectation.code) {
        violations.push(`error.code ${code} != ${sc.expectation.code}`);
      }
      if (
        sc.expectation.message !== undefined &&
        (!isRecord(body) || !isRecord(body.error) || body.error.message !== sc.expectation.message)
      ) {
        violations.push(`error.message != ${JSON.stringify(sc.expectation.message)}`);
      }
      if (status < 300 && sc.expectation.ok) violations.push(...sc.expectation.ok(body));
    }
    if (logs.length !== 1) violations.push(`access log lines = ${logs.length} (expected 1)`);
    else {
      try {
        const entry = JSON.parse(logs[0]) as Record<string, unknown>;
        if (entry.evt !== "api_request") violations.push("access log evt");
        if (entry.status !== status)
          violations.push(`access log status ${String(entry.status)} != ${status}`);
        if (entry.method !== sc.request.method) violations.push("access log method");
        if (code && entry.code !== code) violations.push("access log code mismatch");
      } catch {
        violations.push("access log line not JSON");
      }
    }
  }

  // Write discipline — the heart of the lens.
  const exp = sc.expectation.writes;
  if (exp.kind === "none") {
    if (writes.length)
      violations.push(
        `unexpected write(s): ${writes.map((w) => `${w.method} ${w.url.slice(0, 80)}`).join(" | ")}`,
      );
    if (!sc.expectation.restAllowed && rest.length)
      violations.push(
        `unexpected PostgREST call(s): ${rest.map((c) => `${c.method} ${c.url.slice(0, 80)}`).join(" | ")}`,
      );
  } else if (thrown === null && status !== null && sc.expectation.statuses.includes(status)) {
    if (exp.kind === "upsert") {
      const posts = writes.filter(
        (w) => w.method === "POST" && w.url.includes("/rest/v1/user_saved_drills"),
      );
      const others = writes.filter((w) => !posts.includes(w));
      if (posts.length !== 1) violations.push(`expected exactly 1 upsert, saw ${posts.length}`);
      if (others.length)
        violations.push(`unexpected extra write(s): ${others.map((w) => w.method).join(",")}`);
      const post = posts[0];
      if (post) {
        const row = Array.isArray(post.body) ? post.body[0] : post.body;
        if (!isRecord(row) || row.slug !== exp.slug || row.user_id !== exp.userId) {
          violations.push(
            `upsert body ${JSON.stringify(post.body).slice(0, 120)} != {user_id:${exp.userId}, slug}`,
          );
        } else if (Object.keys(row).length !== 2) violations.push("upsert writes extra columns");
        if (!(post.headers.prefer ?? "").includes("resolution=ignore-duplicates"))
          violations.push("upsert not ignore-duplicates");
        if (!DB_SLUG_RE.test(exp.slug))
          violations.push("edge accepted a slug the DB CHECK constraint refuses (would 503)");
      }
    } else {
      const dels = writes.filter(
        (w) => w.method === "DELETE" && w.url.includes("/rest/v1/user_saved_drills"),
      );
      const others = writes.filter((w) => !dels.includes(w));
      if (dels.length !== 1) violations.push(`expected exactly 1 delete, saw ${dels.length}`);
      if (others.length)
        violations.push(`unexpected extra write(s): ${others.map((w) => w.method).join(",")}`);
      const del = dels[0];
      if (del) {
        const params = new URL(del.url).searchParams;
        if (params.get("user_id") !== `eq.${exp.userId}`)
          violations.push("delete not filtered on the authenticated user");
        if (params.get("slug") !== `eq.${exp.slug}`)
          violations.push("delete slug filter != decoded slug");
      }
    }
  }

  const knownDefect = violations.length === 0 && sc.expectation.note.startsWith("KNOWN DEFECT");
  return {
    id: sc.id,
    seed: sc.seed,
    category: sc.category,
    tags: sc.tags,
    method: sc.request.method,
    url: sc.request.url.length > 300 ? `${sc.request.url.slice(0, 297)}...` : sc.request.url,
    urlLength: sc.request.url.length,
    status,
    code,
    writes: writes.length,
    restCalls: rest.length,
    reflected,
    outcome: violations.length ? "BROKEN" : knownDefect ? "KNOWN_DEFECT" : "HELD",
    violations,
    note: sc.expectation.note,
    ms: Math.round(ms * 100) / 100,
  };
}

async function context(): Promise<GenContext & { catalog: CatalogDrillRecord[] }> {
  const catalog = await drillCatalog();
  const known = catalog.map((d) => d.slug);
  const total = STRESS_ITER + 100;
  return {
    catalog,
    known,
    knownSet: new Set(known),
    userBuckets: Math.max(64, Math.ceil(total / 100)),
  };
}

interface CampaignSummary {
  baseSeed: number;
  generated: number;
  corpus: number;
  executed: number;
  held: number;
  broken: number;
  knownDefect: number;
  byCategory: Record<string, { executed: number; broken: number; knownDefect: number }>;
  byStatus: Record<string, number>;
  reflected4xx: number;
  writes: number;
  brokenIds: string[];
  wallMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress[boundary-malformed]: static catalog + media invariants (client contract, ids, slugs)",
  async () => {
    const catalog = await drillCatalog();
    assert(catalog.length > 0);
    const slugs = new Set<string>();
    const ids = new Set<string>();
    const allMediaIds = new Set<string>();
    const problems: string[] = [];
    for (const drill of catalog) {
      if (slugs.has(drill.slug)) problems.push(`duplicate slug ${drill.slug}`);
      slugs.add(drill.slug);
      if (!EDGE_SLUG_RE.test(drill.slug)) problems.push(`slug fails edge gate: ${drill.slug}`);
      if (!DB_SLUG_RE.test(drill.slug)) problems.push(`slug fails DB CHECK: ${drill.slug}`);
      if (drill.slug !== drill.slug.toLowerCase())
        problems.push(`slug not lowercase (detail lookup is exact): ${drill.slug}`);
      if (ids.has(drill.id)) problems.push(`duplicate id ${drill.id}`);
      ids.add(drill.id);
      if (!UUID_V5_RE.test(drill.id)) problems.push(`id not a v5-shaped uuid: ${drill.id}`);
      assertEquals(
        drill.id,
        await deterministicUuid(`pickle-sensei.drill-catalog:${drill.slug}`),
        `id derivation drifted for ${drill.slug}`,
      );
      problems.push(
        ...catalogItemViolations({ ...drill, saved: false }).map((v) => `${drill.slug}: ${v}`),
      );
      const media = await drillInstructionalMedia(drill.slug);
      for (const item of media) {
        problems.push(...mediaViolations(item).map((v) => `${drill.slug} media: ${v}`));
        if (allMediaIds.has(item.id)) problems.push(`duplicate media id across drills: ${item.id}`);
        allMediaIds.add(item.id);
        if (ids.has(item.id)) problems.push(`media id collides with a drill id: ${item.id}`);
      }
    }
    // Every MEDIA_BY_SLUG key must be a catalog slug (a stale key would be dead
    // content). The map is module-private, so audit the source text.
    const source = await Deno.readTextFile(new URL("../drillMedia.ts", import.meta.url));
    const block = source.slice(
      source.indexOf("MEDIA_BY_SLUG"),
      source.indexOf("};", source.indexOf("MEDIA_BY_SLUG")),
    );
    const keys = [...block.matchAll(/^\s+"?([a-z0-9_-]+)"?:\s*\[/gm)].map((m) => m[1]);
    assert(keys.length > 0, "could not locate MEDIA_BY_SLUG keys");
    for (const key of keys)
      if (!slugs.has(key)) problems.push(`MEDIA_BY_SLUG key not in catalog: ${key}`);
    assertEquals(problems, []);
  },
);

/**
 * Served copy is user-facing (the app renders title/description and, per
 * APP_STORE_SUBMISSION.md §Third-party content, the verbatim YouTube
 * attribution). AGENTS.md / the dossier forbid competitor names and
 * superlatives in user-facing copy. This is a RATCHET: the offending strings
 * that exist today are pinned below (reported as finding
 * "attribution copy carries competitor name + superlatives" — a human must
 * decide whether verbatim third-party attribution is exempt); any NEW
 * violation fails. Shrink the pinned list when the copy changes.
 */
const FORBIDDEN_COPY =
  /\b(android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|best|greatest)\b|#1\b|\d+\s?%/i;
const PINNED_COPY_VIOLATIONS = new Set<string>([
  'creatorName: "Selkirk TV"',
  'attribution: "\\"How to Reset From Mid-Court and Still Win the Point\\" by Selkirk TV on YouTube"',
  'attribution: "\\"Reset Game of Death [BEST PICKLEBALL DRILLS]\\" by Cori Elliott on YouTube"',
  'attribution: "\\"The Greatest PICKLEBALL Drill You Can Do With Two People!\\" by Nspired Pickleball on YouTube"',
]);

Deno.test(
  "stress[boundary-malformed]: user-facing copy policy ratchet over served catalog + attribution",
  async () => {
    const catalog = await drillCatalog();
    const found = new Set<string>();
    for (const drill of catalog) {
      for (const [field, value] of [
        ["title", drill.title],
        ["description", drill.description],
        ["coach_name", drill.coach_name],
      ] as const) {
        const m = FORBIDDEN_COPY.exec(value);
        // "best of 3 games" is a scoring format, not a superlative claim.
        if (m && !(field === "description" && /^best$/i.test(m[0]) && /best of \d/i.test(value))) {
          found.add(`${drill.slug}.${field}: ${JSON.stringify(m[0])}`);
        }
      }
      for (const item of await drillInstructionalMedia(drill.slug)) {
        for (const [field, value] of [
          ["creatorName", item.creatorName],
          ["attribution", item.attribution],
        ] as const) {
          if (FORBIDDEN_COPY.test(value)) found.add(`${field}: ${JSON.stringify(value)}`);
        }
      }
    }
    const unexpected = [...found].filter((f) => !PINNED_COPY_VIOLATIONS.has(f));
    const fixed = [...PINNED_COPY_VIOLATIONS].filter((p) => !found.has(p));
    assertEquals(unexpected, [], "NEW forbidden copy in served drill content");
    assertEquals(
      fixed,
      [],
      "pinned copy finding no longer reproduces — remove it from PINNED_COPY_VIOLATIONS",
    );
  },
);

Deno.test(
  `stress[boundary-malformed]: direct drills.ts / drillMedia.ts fuzz never throws (${STRESS_MODULE_ITER} seeded inputs)`,
  async () => {
    const ctx = await context();
    const outcomes: Array<{ seed: number; input: string; fn: string; error: string }> = [];
    let executed = 0;
    for (let i = 0; i < STRESS_MODULE_ITER; i += 1) {
      const seed = iterationSeed(STRESS_SEED ^ 0x5eed, i);
      const rng = mulberry32(seed);
      const h = hostile(rng, ctx.known);
      executed += 1;
      const record = (fn: string, error: unknown) =>
        outcomes.push({
          seed,
          input: h.s.length > 60 ? `${h.s.slice(0, 57)}...` : h.s,
          fn,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      try {
        const entry = await drillCatalogEntry(h.s);
        if (entry !== null && entry.slug !== h.s)
          record("drillCatalogEntry", `returned ${entry.slug} for a different input`);
      } catch (e) {
        record("drillCatalogEntry", e);
      }
      try {
        const a = await searchDrillCatalog({ q: h.s });
        const b = await searchDrillCatalog({ q: h.s });
        if (a.length > ctx.known.length) record("searchDrillCatalog", "more results than catalog");
        assertEquals(a, b);
        const fam = await searchDrillCatalog({ family: h.s, q: rng.chance(0.5) ? h.s : undefined });
        if (fam.length > ctx.known.length)
          record("searchDrillCatalog(family)", "more results than catalog");
      } catch (e) {
        record("searchDrillCatalog", e);
      }
      try {
        const u1 = await deterministicUuid(h.s);
        const u2 = await deterministicUuid(h.s);
        if (u1 !== u2) record("deterministicUuid", "not stable");
        if (!UUID_V5_RE.test(u1)) record("deterministicUuid", `bad shape ${u1}`);
        if (
          h.s.normalize("NFC") !== h.s.normalize("NFD") &&
          (await deterministicUuid(h.s.normalize("NFC"))) ===
            (await deterministicUuid(h.s.normalize("NFD")))
        ) {
          record("deterministicUuid", "NFC/NFD collide");
        }
      } catch (e) {
        record("deterministicUuid", e);
      }
      try {
        const media = await drillInstructionalMedia(h.s);
        if (!Array.isArray(media)) record("drillInstructionalMedia", "non-array");
        else if (!ctx.knownSet.has(h.s) && media.length !== 0)
          record("drillInstructionalMedia", "media for unknown slug");
      } catch (e) {
        record("drillInstructionalMedia", e);
      }
    }
    // FINDING (pinned in the test below): drillInstructionalMedia rejects on
    // Object.prototype keys. Everything else must hold.
    const unexplained = outcomes.filter(
      (o) =>
        !(
          o.fn === "drillInstructionalMedia" &&
          PROTO_KEYS.some((k) => o.input.includes(k)) &&
          o.error.startsWith("TypeError")
        ),
    );
    if (STRESS_OUT) {
      await Deno.writeTextFile(
        STRESS_OUT.replace(/\.json$/, "") + ".module.json",
        JSON.stringify({ executed, outcomes }, null, 1),
      );
    }
    assertEquals(unexplained, []);
    assert(executed === STRESS_MODULE_ITER);
  },
);

Deno.test(
  "stress[boundary-malformed] FINDING P3: drillInstructionalMedia throws TypeError for Object.prototype member-name slugs (pinned until fixed)",
  async () => {
    // drillMedia.ts: `MEDIA_BY_SLUG[slug] ?? []` — a plain object literal, so
    // "constructor"/"toString"/"valueOf"/"hasOwnProperty" resolve to inherited
    // members and `.map` is not a function. ("__proto__" is inert only because
    // the Deno runtime deletes Object.prototype.__proto__.) Not reachable over
    // HTTP today only because getCatalogDrill() 404s before calling it; a
    // direct caller (or a future route that trusts a stored slug) would crash.
    // Flip to assertEquals([]) once the lookup uses Object.hasOwn / a Map.
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
      await assertRejects(() => drillInstructionalMedia(key), TypeError);
    }
    assertEquals(await drillInstructionalMedia("__proto__"), []);
    assertEquals(await drillInstructionalMedia("no-such-slug"), []);
  },
);

Deno.test(
  `stress[boundary-malformed]: seeded HTTP campaign against the real handler (${STRESS_ITER} generated + corpus)`,
  async () => {
    const h = await loadHarness();
    const ctx = await context();
    const started = performance.now();
    const scenarios: Scenario[] = [];
    const corpusEntries = corpus(ctx.known);
    const replaySet = new Set(STRESS_REPLAY);
    const wanted = (id: string) => replaySet.size === 0 || replaySet.has(id);

    corpusEntries.forEach((entry, index) => {
      const sc = corpusScenario(entry, index, ctx);
      if (wanted(sc.id)) scenarios.push(sc);
    });
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = iterationSeed(STRESS_SEED, i);
      if (!wanted(`gen:${seed}`)) continue;
      scenarios.push(generate(seed, ctx));
    }
    // Replaying an id that is not in this base seed's sequence: build it from the seed directly.
    for (const id of replaySet) {
      if (id.startsWith("gen:") && !scenarios.some((s) => s.id === id)) {
        scenarios.push(generate(Number(id.slice(4)) >>> 0, ctx));
      }
    }

    const outcomes: Outcome[] = [];
    for (const sc of scenarios) outcomes.push(await runScenario(h, sc));
    h.reset();

    const summary: CampaignSummary = {
      baseSeed: STRESS_SEED,
      generated: outcomes.filter((o) => o.id.startsWith("gen:")).length,
      corpus: outcomes.filter((o) => o.id.startsWith("corpus:")).length,
      executed: outcomes.length,
      held: outcomes.filter((o) => o.outcome === "HELD").length,
      broken: outcomes.filter((o) => o.outcome === "BROKEN").length,
      knownDefect: outcomes.filter((o) => o.outcome === "KNOWN_DEFECT").length,
      byCategory: {},
      byStatus: {},
      reflected4xx: outcomes.filter((o) => o.reflected && (o.status ?? 0) < 500).length,
      writes: outcomes.reduce((n, o) => n + o.writes, 0),
      brokenIds: outcomes.filter((o) => o.outcome === "BROKEN").map((o) => o.id),
      wallMs: Math.round(performance.now() - started),
    };
    for (const o of outcomes) {
      const cat = (summary.byCategory[o.category] ??= { executed: 0, broken: 0, knownDefect: 0 });
      cat.executed += 1;
      if (o.outcome === "BROKEN") cat.broken += 1;
      if (o.outcome === "KNOWN_DEFECT") cat.knownDefect += 1;
      const key = o.status === null ? "throw" : String(o.status);
      summary.byStatus[key] = (summary.byStatus[key] ?? 0) + 1;
    }
    if (STRESS_OUT) {
      await Deno.writeTextFile(STRESS_OUT, JSON.stringify({ summary, rows: outcomes }, null, 1));
    }
    const broken = outcomes.filter((o) => o.outcome === "BROKEN");
    assertEquals(
      broken.map(
        (o) =>
          `${o.id} [${o.category}] ${o.method} ${o.url.slice(0, 120)} → ${o.status}: ${o.violations.join("; ")}`,
      ),
      [],
      `${broken.length}/${outcomes.length} scenarios BROKEN (replay with STRESS_REPLAY=<id>)`,
    );
    assertEquals(summary.executed, scenarios.length);
    assert(summary.executed > 0, "no scenario executed");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Postgres-backed cross-check (throwaway postgres:16 + every migration)
// ─────────────────────────────────────────────────────────────────────────────

class RollbackMarker extends Error {
  constructor() {
    super("rollback");
  }
}

Deno.test({
  name: "stress[boundary-malformed] pg: edge slug gate ⊆ user_saved_drills CHECK; upsert idempotent; NUL rejected by Postgres",
  ignore: STRESS_PG_URL === "",
  async fn() {
    assert(
      !/supabase\.co|ucqnaiwqwjtgvlduiuib/.test(STRESS_PG_URL),
      "refusing to run against a hosted project",
    );
    const sql = postgres(STRESS_PG_URL, { max: 1, onnotice: () => undefined });
    const userId = "33333333-3333-4333-8333-333333333333";
    const ctx = await context();
    const results: Array<{ input: string; length: number; edge: boolean; db: "ok" | string }> = [];
    try {
      await sql.unsafe(
        `insert into auth.users (id, email) values ('${userId}', 'stress@example.com') on conflict do nothing`,
      );
      await sql.unsafe(
        `insert into public.profiles (id, email, provider) values ('${userId}', 'stress@example.com', 'google') on conflict do nothing`,
      );

      // Candidate slugs: the corpus boundaries + seeded hostile strings.
      const candidates = new Set<string>([
        SLUG120,
        SLUG121,
        "a",
        "-a",
        "_a",
        "a_",
        "A-Z_0-9",
        "\u212a",
        "\u017f",
        "caf\u00e9",
        "cafe\u0301",
        "a b",
        "a/b",
        "a\nb",
        "a\tb",
        "\u0130",
        "a\u0000b",
        ...ctx.known,
      ]);
      const rng = mulberry32(STRESS_SEED ^ 0x9d);
      for (let i = 0; i < 400; i += 1) candidates.add(hostile(rng, ctx.known).s);

      for (const input of candidates) {
        const edge = EDGE_SLUG_RE.test(input);
        let db: "ok" | string = "ok";
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`set local role authenticated`);
            await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
            await tx`insert into public.user_saved_drills (user_id, slug) values (${userId}::uuid, ${input}) on conflict (user_id, slug) do nothing`;
            const rows =
              await tx`select slug from public.user_saved_drills where user_id = ${userId}::uuid and slug = ${input}`;
            if (rows.length !== 1) throw new Error(`row count ${rows.length}`);
            if (rows[0].slug !== input) throw new Error("slug round-trip differs");
            throw new RollbackMarker();
          });
        } catch (error) {
          if (!(error instanceof RollbackMarker)) {
            const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
            db = code || (error instanceof Error ? error.message : String(error));
          }
        }
        results.push({
          input: input.length > 60 ? `${input.slice(0, 57)}...` : input,
          length: input.length,
          edge,
          db,
        });
      }
      // Idempotency of the PUT upsert shape (ON CONFLICT DO NOTHING → exactly one row).
      await sql
        .begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
          for (let i = 0; i < 3; i += 1) {
            await tx`insert into public.user_saved_drills (user_id, slug) values (${userId}::uuid, ${ctx.known[0]}) on conflict (user_id, slug) do nothing`;
          }
          const rows =
            await tx`select count(*)::int as n from public.user_saved_drills where user_id = ${userId}::uuid and slug = ${ctx.known[0]}`;
          assertEquals(rows[0].n, 1);
          throw new RollbackMarker();
        })
        .catch((e) => {
          if (!(e instanceof RollbackMarker)) throw e;
        });
    } finally {
      await sql.end();
    }
    if (STRESS_OUT) {
      await Deno.writeTextFile(
        STRESS_OUT.replace(/\.json$/, "") + ".pg.json",
        JSON.stringify(results, null, 1),
      );
    }
    // (1) Anything the edge accepts, the DB accepts — otherwise a shape-valid
    //     PUT becomes a 503 instead of a 400.
    const edgeOkDbRefused = results.filter((r) => r.edge && r.db !== "ok");
    assertEquals(edgeOkDbRefused, []);
    // (2) Anything the edge rejects that the DB would ALSO reject is only a
    //     concern for DELETE (no gate) — record the SQLSTATEs the DB raises
    //     for those inputs so the finding is evidence-backed.
    const nul = results.find((r) => r.input === "a\u0000b");
    assert(nul, "corpus must include a NUL slug");
    assertEquals(nul.db, "22021", "Postgres refuses NUL in text with SQLSTATE 22021");
    const tooLong = results.find(
      (r) => r.input.startsWith(SLUG121.slice(0, 57)) && r.length === 121,
    );
    assert(
      tooLong && tooLong.db === "23514" && !tooLong.edge,
      "121-char slug must violate user_saved_drills_slug_bounds (23514)",
    );
    const boundary = results.find(
      (r) => r.input.startsWith(SLUG120.slice(0, 57)) && r.length === 120,
    );
    assert(
      boundary && boundary.db === "ok" && boundary.edge,
      "120-char slug is accepted by both layers",
    );
  },
});
