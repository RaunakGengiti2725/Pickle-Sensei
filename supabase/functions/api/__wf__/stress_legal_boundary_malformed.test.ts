// Stress lens `boundary-malformed` for the public legal text routes
// (GET/HEAD …/support | …/privacy | …/terms → legal.ts) served by the REAL
// edge handler in supabase/functions/api/index.ts.
//
// Two planes drive the same in-process handler (routesHarness.ts stubs
// Supabase Auth/PostgREST, RevenueCat and Apple; Upstash is unset so the
// per-isolate memory rate limiter is exercised):
//
//   inproc — `new Request(...)` → `h.handler(request)`; everything the WHATWG
//            Request/URL/Headers constructors accept: path traversal, %00,
//            homoglyph / compatibility / NFC-vs-NFD doc names, 64 KiB+
//            segments, prototype-pollution query keys and header names,
//            wrong types in content-length, boundary x-request-id lengths,
//            malformed JSON bodies on non-read methods, per-IP bursts.
//   raw    — the ORIGINAL Deno.serve (captured by the harness) listens on an
//            ephemeral loopback port with the same handler; hand-written HTTP/1.x
//            bytes go over Deno.connect: NUL / 0xFF in the request target,
//            absent Host, bodies + chunked framing on GET, CONNECT/TRACE/TRACK,
//            HTTP/0.9–9.9, LF-only line endings, pipelining, HEAD body drop.
//
// Every iteration is replayable from `<family>:<seed>`; the base seed and
// iteration count come from the environment so the default run stays fast
// enough to live in the suite while the campaign scales to thousands.
//
//   STRESS_ITER    iterations (default 300; campaign ≥ 3000)
//   STRESS_SEED    base seed (default 20260905)
//   STRESS_OUT     write the seed → outcome JSON table to this path
//   STRESS_REPLAY  comma-separated `<family>:<seed>` ids to run alone
//
//   cd supabase/functions/api/__wf__ && \
//     STRESS_ITER=3200 STRESS_OUT=/tmp/legal_stress.json \
//     deno test -A --no-check --config deno.json stress_legal_boundary_malformed.test.ts
//
// Invariants (a violation = BROKEN row + failed test):
//   I1  the handler never throws / never answers 5xx / never logs an unhandled error
//   I2  a request that matches a legal route (method GET|HEAD, pathname ends with
//       /support|/privacy|/terms) gets 200 text/plain (exact document bytes on GET,
//       nosniff, public cache) or a well-formed 429 (rate_limited JSON, Retry-After)
//   I3  anything else on those paths is a 4xx whose body carries no internal detail
//       (no stack frames, file paths, exception class names, stub hostnames)
//   I4  x-request-id is echoed only when it matches [A-Za-z0-9._-]{8,64}; otherwise a
//       fresh UUID is minted and the client value is never reflected
//   I5  no write ever leaves the handler (no non-GET call to Supabase/RevenueCat/Apple)
//   I6  exactly one categorical access-log line per in-process request; it names the
//       response id/status and never carries the query string, bearer or client IP
//   I7  raw plane: a well-formed request always gets an HTTP response; HEAD returns no
//       body bytes; GET 200 body is byte-identical to the document; garbage gets a 4xx
//       from hyper/the handler or a clean close — never a 5xx, never a hang
//   I8  Object.prototype / Array.prototype are unchanged after the campaign and the
//       handler still serves the documents afterwards

import { assert, assertEquals } from "@std/assert";
import { loadHarness } from "./routesHarness.ts";
import { captureAccessLog } from "../http.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

// ─── configuration ────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "300") || 300);
const BASE_SEED =
  (Number(Deno.env.get("STRESS_SEED") ?? "20260905") || 20260905) >>> 0;
const OUT_PATH = Deno.env.get("STRESS_OUT") ?? "";
const REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BURST_EVERY = 250;
const RAW_TIMEOUT_MS = 5_000;
// An incomplete request is *supposed* to leave the server waiting for the rest;
// bound how long we watch it do that.
const RAW_INCOMPLETE_TIMEOUT_MS = 600;
// Hard ceiling per iteration: a hung handler/socket becomes a BROKEN row
// instead of stalling the campaign.
const ITERATION_TIMEOUT_MS = 20_000;
const PROGRESS_EVERY = Math.max(
  1,
  Number(Deno.env.get("STRESS_PROGRESS") ?? "0") || 0,
);
// Deno's HTTP/1 server (hyper) refuses request heads ≥ 64 KiB or > 100 header
// lines with its own bodiless 400 before the handler runs — a transport-level
// graceful rejection, distinguishable from handler responses by the absence of
// x-request-id. Measured in this campaign (see probe rows); the hosted gateway
// applies its own, tighter, limits in front of the function.
const SERVER_HEAD_LIMIT_BYTES = 64 * 1024;
const SERVER_HEADER_COUNT_LIMIT = 100;

const MOUNT = "/functions/v1/api";
const DOCS: Record<string, string> = {
  support: SUPPORT_TEXT,
  privacy: PRIVACY_POLICY_TEXT,
  terms: TERMS_TEXT,
};
const DOC_NAMES = Object.keys(DOCS);
const LEGAL_RE = /\/(support|privacy|terms)$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const DETAIL_LEAK_RE =
  /\bat\s+\S+:\d+:\d+|index\.ts|supabase\.test|TypeError|RangeError|SyntaxError|ReferenceError|Unexpected token|\/home\/|file:\/\/|deno:|node_modules|PGRST\d+|stack/i;

// ─── seeded RNG ───────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Printable ASCII token chars (RFC 7230 tchar). */
  token(len: number): string {
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    let out = "";
    for (let i = 0; i < len; i += 1) out += alphabet[this.int(alphabet.length)];
    return out;
  }
  ip(): string {
    return `${10 + this.int(200)}.${this.int(256)}.${this.int(256)}.${
      1 + this.int(254)
    }`;
  }
}

function iterSeed(base: number, i: number): number {
  let h = Math.imul(base ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = (h + Math.imul(i + 1, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ─── result table ─────────────────────────────────────────────────────────────

type Outcome = "HELD" | "BROKEN" | "UNCONSTRUCTIBLE";

interface Row {
  id: string;
  family: string;
  plane: "inproc" | "raw";
  seed: number;
  method: string;
  target: string;
  status: number | null;
  outcome: Outcome;
  detail: string;
  requests: number;
  ms?: number;
}

const truncate = (value: string, max = 160): string =>
  value.length <= max
    ? value
    : `${value.slice(0, max)}…(+${value.length - max})`;

// ─── shared payload pools ─────────────────────────────────────────────────────

const HUGE = 64 * 1024;
const SIZES = [
  0,
  1,
  7,
  8,
  63,
  64,
  65,
  255,
  256,
  1023,
  4096,
  8191,
  8192,
  HUGE,
  HUGE + 1,
  70_000,
];

const JSON_PAYLOADS: readonly string[] = [
  "",
  "{",
  "}",
  "[",
  "]",
  "{}",
  "[]",
  "null",
  "true",
  "0",
  "-0",
  "NaN",
  "Infinity",
  "-Infinity",
  "1e309",
  "-1e309",
  "9007199254740993",
  "18446744073709551616",
  "1e-400",
  '{"a":1,',
  '{"a":1}}',
  '{"a":1}garbage',
  '{"__proto__":{"polluted":"yes"}}',
  '{"constructor":{"prototype":{"polluted":"yes"}}}',
  '{"prototype":{"polluted":"yes"}}',
  '{"schemaVersion":99,"payload":{}}',
  '{"schemaVersion":-1}',
  '{"schemaVersion":"999.0.0"}',
  '{"a":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]}',
  '"\\u0000"',
  '"\u0000"',
  '{"a":"\\ud800"}',
  '{"a":"\ufeff"}',
  '{"a":"e\\u0301","b":"\\u00e9"}',
  '{"a":"\u202e"}',
  "\ufeff{}",
  '{"a":1}\u0000',
  '{"a":"' + "x".repeat(HUGE) + '"}',
  "[" + "1,".repeat(20_000) + "1]",
  "{" + '"k":1,'.repeat(10_000) + '"z":1}',
  "[".repeat(5_000) + "]".repeat(5_000),
  "<xml/>",
  "a=b&c=d",
  "--boundary\r\nContent-Disposition: form-data\r\n\r\nx\r\n--boundary--",
];

const IP_HEADER_VALUES: readonly string[] = [
  "",
  " ",
  ",",
  ",,,",
  " , , ",
  "203.0.113.7",
  "203.0.113.7, 10.0.0.1",
  "evil, 203.0.113.7",
  "::1",
  "::ffff:203.0.113.7",
  "2001:db8::1, 2001:db8::2",
  "999.999.999.999",
  "-1",
  "NaN",
  "0x7f000001",
  "127.0.0.1\t",
  "\u00ff\u00fe",
  "__proto__",
  "constructor",
  "a".repeat(255),
  "a".repeat(4096),
  "1.1.1.1,".repeat(2000),
  "b".repeat(HUGE),
];

const REQUEST_ID_VALUES: readonly string[] = [
  "",
  "a",
  "a".repeat(7),
  "a".repeat(8),
  "a".repeat(63),
  "a".repeat(64),
  "a".repeat(65),
  "a".repeat(HUGE),
  "__proto__",
  "constructor",
  "has space in it",
  "under_score.dot-dash",
  "<script>alert(1)</script>",
  "../../../etc/passwd",
  "%00%00%00%00",
  "\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9",
  "\u00ff".repeat(16),
  " leading-space-abc ",
  "12345678",
  "550e8400-e29b-41d4-a716-446655440000",
];

const CONTENT_LENGTH_VALUES: readonly string[] = [
  "0",
  "-1",
  "NaN",
  "Infinity",
  "1e309",
  "9007199254740993",
  "18446744073709551616",
  "1048577",
  "0x10",
  "1,2",
  "9".repeat(HUGE),
];

// Homoglyph / compatibility / normalization variants of the doc names — none of
// them may match the route (the handler normalizes nothing).
function unicodeDocVariant(rng: Rng, doc: string): string {
  const kind = rng.int(6);
  switch (kind) {
    case 0: // Cyrillic homoglyphs
      return doc.replace(
        /[aceopsy]/g,
        (ch) =>
          ({
            a: "\u0430",
            c: "\u0441",
            e: "\u0435",
            o: "\u043e",
            p: "\u0440",
            s: "\u0455",
            y: "\u0443",
          })[ch] ?? ch,
      );
    case 1: // fullwidth (NFKC-folds back to ASCII)
      return Array.from(doc)
        .map((ch) => String.fromCharCode(ch.charCodeAt(0) - 0x61 + 0xff41))
        .join("");
    case 2: // zero-width joiner inside
      return doc.slice(0, 3) + "\u200d" + doc.slice(3);
    case 3: // combining acute on the last letter (NFD-shaped)
      return doc + "\u0301";
    case 4: // RTL override prefix
      return "\u202e" + doc;
    default: // precomposed vs decomposed pair in a leading segment
      return (rng.chance(0.5) ? "\u00e9" : "e\u0301") + "/" + doc;
  }
}

// ─── in-process spec generators ──────────────────────────────────────────────

interface InprocSpec {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string | Uint8Array<ArrayBuffer> | null;
  ip: string;
  clientRequestId: string | null;
}

function pathMutation(rng: Rng, doc: string): string {
  const seg = rng.token(1 + rng.int(12));
  const variants: Array<() => string> = [
    () => `/${doc}`,
    () => `/${doc}/`,
    () => `//${doc}`,
    () => `/${doc}//`,
    () => `/${doc.toUpperCase()}`,
    () => `/${doc[0].toUpperCase()}${doc.slice(1)}`,
    () => `/${encodeURIComponent(doc[0])}${doc.slice(1)}`,
    () => `/%${doc.charCodeAt(0).toString(16)}${doc.slice(1)}`,
    () => `/${doc}%00`,
    () => `/%00${doc}`,
    () => `/${doc}\u0000`,
    () => `/\u0000${doc}`,
    () => `/../${doc}`,
    () => `/${seg}/../${doc}`,
    () => `/${doc}/..`,
    () => `/${doc}/../${rng.pick(DOC_NAMES)}`,
    () => `/%2e%2e/${doc}`,
    () => `/..%2f${doc}`,
    () => `/${doc}%2f`,
    () => `/${doc}%2F..%2F${doc}`,
    () => `/\\${doc}`,
    () => `\\${doc}`,
    () => `/${doc}\\`,
    () => `/./${doc}`,
    () => `/${doc}/.`,
    () => `/${".".repeat(1 + rng.int(6))}/${doc}`,
    () => `/${doc};jsessionid=${seg}`,
    () => `/${doc};`,
    () => `/${doc}.txt`,
    () => `/${doc}.html`,
    () => `/${doc}.`,
    () => `/x${doc}`,
    () => `/${doc}x`,
    () => `/${doc}/${doc}`,
    () => `/${doc}/`.repeat(1 + rng.int(200)),
    () => `/${unicodeDocVariant(rng, doc)}`,
    () => `/${seg}\t/${doc}`,
    () => `/${seg}\n/${doc}`,
    () => `/${seg}\r/${doc}`,
    () => `/${seg} /${doc}`,
    () => `/${doc}%ZZ`,
    () => `/%c0%ae%c0%ae/${doc}`,
    () => `/${doc}%`,
    () => `/${doc}%2`,
    () => `/${"a".repeat(rng.pick(SIZES))}/${doc}`,
    () => `/${doc}/${"a".repeat(rng.pick(SIZES))}`,
    () => `/${"/".repeat(1 + rng.int(500))}${doc}`,
    () => `/${doc}?${rng.token(1 + rng.int(20))}=${rng.token(rng.int(40))}`,
    () => `/${doc}?${"q=".repeat(1)}${"a".repeat(rng.pick(SIZES))}`,
    () => `/${doc}#${seg}`,
    () => `/${doc}?#`,
    () => `/${doc}?%00`,
    () => `/${doc}?__proto__[polluted]=1`,
    () => `/${doc}?constructor[prototype][polluted]=1`,
    () => `/${doc}?__proto__=1&constructor=2&prototype=3`,
    () => `/${doc}?${doc}=${doc}`,
    () => `/${seg}?redirect=/${doc}`,
    () => `/${doc}?${"&".repeat(rng.pick(SIZES))}`,
    () => `/v1/${doc}`,
    () => `/v1/me/${doc}`,
    () => `/v1/${seg}/${doc}`,
    () => `/v1/shots/11111111-1111-4111-8111-111111111111/${doc}`,
    () => `/v1/sessions/123456/${doc}`,
    () => `/webhooks/${doc}`,
    () => `/healthz/${doc}`,
    () => `/${doc}/healthz`,
    () => `/${doc}/webhooks/revenuecat`,
    () => `/${seg}`,
    () => `/`,
    () => ``,
  ];
  return rng.pick(variants)();
}

function pathSpec(rng: Rng): InprocSpec {
  const doc = rng.pick(DOC_NAMES);
  const mount = rng.pick([
    MOUNT,
    MOUNT,
    MOUNT,
    "",
    "/api",
    `${MOUNT}/v1/me`,
    "/x",
  ]);
  const method = rng.pick(["GET", "GET", "GET", "HEAD"]);
  return {
    method,
    url: `http://edge.test${mount}${pathMutation(rng, doc)}`,
    headers: [],
    body: null,
    ip: rng.ip(),
    clientRequestId: null,
  };
}

function querySpec(rng: Rng): InprocSpec {
  const doc = rng.pick(DOC_NAMES);
  const keys = [
    "__proto__",
    "constructor",
    "prototype",
    "__proto__[polluted]",
    "constructor[prototype][polluted]",
    "toString",
    "hasOwnProperty",
    "%00",
    "",
    "a".repeat(rng.pick(SIZES)),
    rng.token(1 + rng.int(8)),
  ];
  const values = [
    "1",
    "",
    "%00",
    "NaN",
    "-0",
    "1e309",
    "[]",
    "{}",
    "\u202e",
    "a".repeat(rng.pick(SIZES)),
    encodeURIComponent('{"__proto__":{"polluted":1}}'),
  ];
  const n = rng.int(6);
  const pairs: string[] = [];
  for (let i = 0; i < n; i += 1) {
    pairs.push(`${rng.pick(keys)}=${rng.pick(values)}`);
  }
  const sep = rng.pick(["&", ";", "&&", "&amp;"]);
  return {
    method: rng.pick(["GET", "HEAD"]),
    url: `http://edge.test${MOUNT}/${doc}?${pairs.join(sep)}${
      rng.chance(0.2) ? "#frag" : ""
    }`,
    headers: [],
    body: null,
    ip: rng.ip(),
    clientRequestId: null,
  };
}

function headerSpec(rng: Rng): InprocSpec {
  const doc = rng.pick(DOC_NAMES);
  const headers: Array<[string, string]> = [];
  let clientRequestId: string | null = null;
  let ip = rng.ip();
  const n = 1 + rng.int(4);
  for (let i = 0; i < n; i += 1) {
    switch (rng.int(12)) {
      case 0: {
        const v = rng.pick(IP_HEADER_VALUES);
        headers.push(["x-forwarded-for", v]);
        ip = "";
        break;
      }
      case 1: {
        const v = rng.pick(IP_HEADER_VALUES);
        headers.push(["cf-connecting-ip", v]);
        break;
      }
      case 2: {
        clientRequestId = rng.pick(REQUEST_ID_VALUES);
        headers.push(["x-request-id", clientRequestId]);
        break;
      }
      case 3:
        headers.push(["content-length", rng.pick(CONTENT_LENGTH_VALUES)]);
        break;
      case 4:
        headers.push([
          "content-type",
          rng.pick([
            "",
            "application/json",
            "text/html",
            "\u00ff",
            "a".repeat(HUGE),
            "multipart/form-data; boundary=",
          ]),
        ]);
        break;
      case 5:
        headers.push([
          "authorization",
          rng.pick([
            "",
            "Bearer",
            "Bearer ",
            "Bearer \u00ff\u00fe",
            "Basic Og==",
            `Bearer ${"a".repeat(HUGE)}`,
            "Bearer __proto__",
            "Bearer eyJhbGciOiJub25lIn0.e30.",
            "Bearer a.b",
          ]),
        ]);
        break;
      case 6:
        headers.push([
          rng.pick([
            "accept",
            "accept-encoding",
            "accept-language",
            "range",
            "if-none-match",
            "if-modified-since",
            "origin",
            "referer",
          ]),
          rng.pick([
            "",
            "*/*",
            "\u00ff",
            "bytes=-1",
            "bytes=0-99999999999",
            'W/"x"',
            "not a date",
            "a".repeat(HUGE),
            "null",
            "__proto__",
          ]),
        ]);
        break;
      case 7:
        headers.push([
          rng.pick(["__proto__", "constructor", "prototype", "toString"]),
          rng.pick(["1", "", "__proto__", "a".repeat(255)]),
        ]);
        break;
      case 8:
        headers.push([
          `x-${rng.token(1 + rng.int(60))}`,
          rng.token(rng.int(200)),
        ]);
        break;
      case 9:
        headers.push([
          "transfer-encoding",
          rng.pick(["chunked", "gzip", "identity", "chunked, chunked"]),
        ]);
        break;
      case 10:
        headers.push([
          "host",
          rng.pick([
            "",
            "evil.example",
            "localhost:0",
            "a".repeat(255),
            "\u00ff",
          ]),
        ]);
        break;
      default:
        headers.push([
          "cookie",
          rng.pick(["", "a=b", "a".repeat(HUGE), "__proto__=1", "%00"]),
        ]);
    }
  }
  if (rng.chance(0.1)) {
    for (let i = 0; i < 200; i += 1) headers.push([`x-many-${i}`, String(i)]);
  }
  return {
    method: rng.pick(["GET", "GET", "HEAD"]),
    url: `http://edge.test${MOUNT}/${doc}`,
    headers,
    body: null,
    ip,
    clientRequestId,
  };
}

function methodSpec(rng: Rng): InprocSpec {
  const doc = rng.pick(DOC_NAMES);
  const method = rng.pick([
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "get",
    "Get",
    "hEaD",
    "FOO",
    "GETX",
    "PROPFIND",
    "PURGE",
    "M-SEARCH",
    "!#$%&'*+-.^_`|~",
    rng.token(1 + rng.int(64)),
    "a".repeat(HUGE),
  ]);
  const upper = method.toUpperCase();
  const withBody = !(upper === "GET" || upper === "HEAD") && rng.chance(0.7);
  const headers: Array<[string, string]> = [];
  if (withBody && rng.chance(0.7)) {
    headers.push(["content-type", "application/json"]);
  }
  return {
    method,
    url: `http://edge.test${MOUNT}/${doc}`,
    headers,
    body: withBody ? rng.pick(JSON_PAYLOADS) : null,
    ip: rng.ip(),
    clientRequestId: null,
  };
}

function bodySpec(rng: Rng): InprocSpec {
  const doc = rng.pick(DOC_NAMES);
  const headers: Array<[string, string]> = [[
    "content-type",
    rng.pick([
      "application/json",
      "application/json; charset=utf-8",
      "text/plain",
      "",
    ]),
  ]];
  if (rng.chance(0.3)) {
    headers.push([
      "authorization",
      rng.pick([
        "Bearer nope",
        "Bearer " + "x".repeat(HUGE),
        "Bearer __proto__",
      ]),
    ]);
  }
  const payload = rng.pick(JSON_PAYLOADS);
  const body = rng.chance(0.15)
    ? new Uint8Array([0xff, 0xfe, 0x00, 0x7b, 0x7d])
    : payload;
  return {
    method: rng.pick(["POST", "PUT", "PATCH", "DELETE"]),
    url: `http://edge.test${MOUNT}/${doc}${
      rng.chance(0.3) ? "/" + rng.token(4) : ""
    }`,
    headers,
    body,
    ip: rng.ip(),
    clientRequestId: null,
  };
}

// ─── raw HTTP spec generators ────────────────────────────────────────────────

interface RawSpec {
  bytes: Uint8Array;
  requests: number;
  /** Request bytes form a complete, RFC-valid HTTP/1.x message → a response is owed. */
  wellFormed: boolean;
  /** Complete message (even if invalid) → the server must answer or close, never hang. */
  complete: boolean;
  /** Request legitimately asks for a persistent connection (no `Connection: close`). */
  keepAlive?: boolean;
  heads: boolean[];
  expectLegal: boolean[];
  docs: string[];
  label: string;
}

const utf8 = new TextEncoder();
function latin1(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function rawRequest(
  method: string,
  target: string,
  version: string,
  headers: string[],
  body: string,
  eol = "\r\n",
): Uint8Array {
  const head = `${method} ${target} ${version}${eol}${
    headers.map((h) => h + eol).join("")
  }${eol}`;
  return concat([latin1(head), latin1(body)]);
}

function rawTargetSpec(rng: Rng): RawSpec {
  const doc = rng.pick(DOC_NAMES);
  const head = rng.chance(0.25);
  const method = head ? "HEAD" : "GET";
  const seg = rng.token(1 + rng.int(12));
  type V = {
    target: string;
    wellFormed: boolean;
    legal: boolean | null;
    label: string;
  };
  const variants: Array<() => V> = [
    () => ({
      target: `${MOUNT}/${doc}`,
      wellFormed: true,
      legal: true,
      label: "exact",
    }),
    () => ({
      target: `${MOUNT}//${doc}`,
      wellFormed: true,
      legal: true,
      label: "double-slash",
    }),
    () => ({
      target: `${MOUNT}/./${doc}`,
      wellFormed: true,
      legal: true,
      label: "dot-segment",
    }),
    () => ({
      target: `${MOUNT}/${seg}/../${doc}`,
      wellFormed: true,
      legal: true,
      label: "dotdot-normalized",
    }),
    () => ({
      target: `${MOUNT}/%2e%2e/${doc}`,
      wellFormed: true,
      legal: null,
      label: "encoded-dotdot",
    }),
    () => ({
      target: `${MOUNT}/${doc}%00`,
      wellFormed: true,
      legal: false,
      label: "encoded-nul-suffix",
    }),
    () => ({
      target: `${MOUNT}/%00${doc}`,
      wellFormed: true,
      legal: false,
      label: "encoded-nul-prefix",
    }),
    () => ({
      target: `${MOUNT}/${doc}\u0000`,
      wellFormed: false,
      legal: null,
      label: "raw-nul",
    }),
    () => ({
      target: `${MOUNT}/${doc}\u00ff`,
      wellFormed: false,
      legal: null,
      label: "raw-0xff",
    }),
    () => ({
      target: `${MOUNT}/\u00ff\u00fe/${doc}`,
      wellFormed: false,
      legal: null,
      label: "raw-highbytes-segment",
    }),
    () => ({
      target: `${MOUNT}/priv acy`,
      wellFormed: false,
      legal: null,
      label: "space-in-target",
    }),
    () => ({
      target: `${MOUNT}/${doc}\t`,
      wellFormed: false,
      legal: null,
      label: "tab-in-target",
    }),
    () => ({
      target: `http://edge.test${MOUNT}/${doc}`,
      wellFormed: true,
      legal: true,
      label: "absolute-form",
    }),
    () => ({
      target: `http://evil.example${MOUNT}/${doc}`,
      wellFormed: true,
      legal: true,
      label: "absolute-form-foreign-host",
    }),
    () => ({
      target: `*`,
      wellFormed: false,
      legal: null,
      label: "asterisk-form",
    }),
    () => ({
      target: `${doc}`,
      wellFormed: false,
      legal: null,
      label: "no-leading-slash",
    }),
    () => ({
      target: `\\${doc}`,
      wellFormed: false,
      legal: null,
      label: "backslash-form",
    }),
    () => ({
      target: `${MOUNT}\\${doc}`,
      wellFormed: true,
      legal: null,
      label: "backslash-separator",
    }),
    () => ({
      target: `${MOUNT}/${doc}#frag`,
      wellFormed: false,
      legal: null,
      label: "fragment",
    }),
    () => ({
      target: `${MOUNT}/${doc}?`,
      wellFormed: true,
      legal: true,
      label: "empty-query",
    }),
    () => ({
      target: `${MOUNT}/${doc}?__proto__[polluted]=1&constructor=2`,
      wellFormed: true,
      legal: true,
      label: "proto-query",
    }),
    () => ({
      target: `${MOUNT}/${doc}?${"q".repeat(HUGE)}`,
      wellFormed: true,
      legal: true,
      label: "64k-query",
    }),
    () => ({
      target: `${MOUNT}/${"a".repeat(HUGE)}/${doc}`,
      wellFormed: true,
      legal: true,
      label: "64k-segment",
    }),
    () => ({
      target: `${MOUNT}/${"a".repeat(HUGE * 4)}/${doc}`,
      wellFormed: true,
      legal: true,
      label: "256k-segment",
    }),
    () => ({
      target: `${MOUNT}/${"a".repeat(HUGE * 16)}/${doc}`,
      wellFormed: true,
      legal: true,
      label: "1m-segment",
    }),
    () => ({
      target: `${MOUNT}${`/${doc}`.repeat(1 + rng.int(500))}`,
      wellFormed: true,
      legal: true,
      label: "repeated-doc",
    }),
    () => ({
      target: `${MOUNT}/${doc}%`,
      wellFormed: true,
      legal: null,
      label: "dangling-percent",
    }),
    () => ({
      target: `${MOUNT}/${doc}%ZZ`,
      wellFormed: true,
      legal: null,
      label: "bad-percent",
    }),
    () => ({
      target: `${MOUNT}/%c0%ae%c0%ae/${doc}`,
      wellFormed: true,
      legal: null,
      label: "overlong-utf8-dotdot",
    }),
    () => ({
      target: `${MOUNT}/${doc.toUpperCase()}`,
      wellFormed: true,
      legal: false,
      label: "uppercase",
    }),
    () => ({
      target: `${MOUNT}/${doc}/`,
      wellFormed: true,
      legal: false,
      label: "trailing-slash",
    }),
    () => ({
      target: `${MOUNT}/${doc}/../${rng.pick(DOC_NAMES)}`,
      wellFormed: true,
      legal: true,
      label: "traverse-to-other-doc",
    }),
    () => ({
      target: `${MOUNT}/v1/shots/11111111-1111-4111-8111-111111111111/${doc}`,
      wellFormed: true,
      legal: true,
      label: "suffix-under-uuid-route",
    }),
    () => ({
      target: ``,
      wellFormed: false,
      legal: null,
      label: "empty-target",
    }),
    () => ({ target: `/`, wellFormed: true, legal: false, label: "root" }),
  ];
  const v = rng.pick(variants)();
  const headers = [
    `Host: edge.test`,
    `X-Forwarded-For: ${rng.ip()}`,
    `Connection: close`,
  ];
  // The URL parser normalizes dot-segments, so `/terms/../privacy` serves privacy.
  const normalizedDoc = LEGAL_RE.exec(safePathname(v.target))?.[1] ?? doc;
  return {
    bytes: rawRequest(method, v.target, "HTTP/1.1", headers, ""),
    requests: 1,
    wellFormed: v.wellFormed,
    complete: true,
    heads: [head],
    expectLegal: [v.legal ?? LEGAL_RE.test(safePathname(v.target))],
    docs: [normalizedDoc],
    label: `${method} ${v.label}`,
  };
}

function safePathname(target: string): string {
  try {
    return new URL(target, "http://edge.test").pathname;
  } catch {
    return "";
  }
}

function rawMethodSpec(rng: Rng): RawSpec {
  const doc = rng.pick(DOC_NAMES);
  type V = {
    method: string;
    wellFormed: boolean;
    legal: boolean;
    label: string;
    body?: string;
    extra?: string[];
  };
  const variants: Array<() => V> = [
    () => ({ method: "GET", wellFormed: true, legal: true, label: "GET" }),
    () => ({ method: "HEAD", wellFormed: true, legal: true, label: "HEAD" }),
    () => ({
      method: "POST",
      wellFormed: true,
      legal: false,
      label: "POST-json",
      body: rng.pick(JSON_PAYLOADS),
    }),
    () => ({
      method: "PUT",
      wellFormed: true,
      legal: false,
      label: "PUT-empty",
    }),
    () => ({
      method: "DELETE",
      wellFormed: true,
      legal: false,
      label: "DELETE",
    }),
    () => ({
      method: "OPTIONS",
      wellFormed: true,
      legal: false,
      label: "OPTIONS",
    }),
    () => ({ method: "PATCH", wellFormed: true, legal: false, label: "PATCH" }),
    () => ({ method: "TRACE", wellFormed: true, legal: false, label: "TRACE" }),
    () => ({ method: "TRACK", wellFormed: true, legal: false, label: "TRACK" }),
    () => ({
      method: "CONNECT",
      wellFormed: false,
      legal: false,
      label: "CONNECT",
    }),
    () => ({
      method: "get",
      wellFormed: true,
      legal: false,
      label: "lowercase-get",
    }),
    () => ({
      method: "hEaD",
      wellFormed: true,
      legal: false,
      label: "mixed-head",
    }),
    () => ({ method: "G3T", wellFormed: true, legal: false, label: "G3T" }),
    () => ({
      method: "GET\u0000",
      wellFormed: false,
      legal: false,
      label: "GET-nul",
    }),
    () => ({
      method: "GET\u00ff",
      wellFormed: false,
      legal: false,
      label: "GET-0xff",
    }),
    () => ({
      method: "",
      wellFormed: false,
      legal: false,
      label: "empty-method",
    }),
    () => ({
      method: "!#$%&'*+-.^_`|~",
      wellFormed: true,
      legal: false,
      label: "tchar-soup",
    }),
    () => ({
      method: rng.token(1 + rng.int(64)),
      wellFormed: true,
      legal: false,
      label: "random-token",
    }),
    () => ({
      method: "A".repeat(8192),
      wellFormed: true,
      legal: false,
      label: "8k-method",
    }),
    () => ({
      method: "A".repeat(HUGE),
      wellFormed: true,
      legal: false,
      label: "64k-method",
    }),
  ];
  const v = rng.pick(variants)();
  const headers = [
    `Host: edge.test`,
    `X-Forwarded-For: ${rng.ip()}`,
    `Connection: close`,
    ...(v.extra ?? []),
  ];
  const body = v.body ?? "";
  if (body) {
    headers.push(
      `Content-Type: application/json`,
      `Content-Length: ${latin1(body).length}`,
    );
  }
  return {
    bytes: rawRequest(v.method, `${MOUNT}/${doc}`, "HTTP/1.1", headers, body),
    requests: 1,
    wellFormed: v.wellFormed,
    complete: true,
    heads: [v.method === "HEAD"],
    expectLegal: [v.legal],
    docs: [doc],
    label: v.label,
  };
}

function rawHeaderSpec(rng: Rng): RawSpec {
  const doc = rng.pick(DOC_NAMES);
  const head = rng.chance(0.2);
  const method = head ? "HEAD" : "GET";
  type V = {
    headers: string[];
    body?: string;
    wellFormed: boolean;
    complete: boolean;
    label: string;
    legal?: boolean;
    keepAlive?: boolean;
  };
  const ip = rng.ip();
  const variants: Array<() => V> = [
    () => ({
      headers: [`X-Forwarded-For: ${ip}`, "Connection: close"],
      wellFormed: false,
      complete: true,
      label: "no-host",
    }),
    () => ({
      headers: [
        "Host: a",
        "Host: b",
        `X-Forwarded-For: ${ip}`,
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "duplicate-host",
    }),
    () => ({
      headers: [
        `Host: ${"h".repeat(HUGE)}`,
        `X-Forwarded-For: ${ip}`,
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "64k-host",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: \u00ff\u00fe\u0000`,
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "xff-highbytes-nul",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${"1.1.1.1,".repeat(8000)}`,
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "xff-64k",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "X-Request-Id: abc\u0000def12345",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "request-id-nul",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        `X-Request-Id: ${"r".repeat(HUGE)}`,
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "request-id-64k",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "X-Request-Id: \u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9",
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "request-id-latin1",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Content-Length: -1",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "negative-content-length",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Content-Length: NaN",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "nan-content-length",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Content-Length: 99999999999999999999",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "overflow-content-length",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Content-Length: 5",
        "Connection: close",
      ],
      body: "hello",
      wellFormed: true,
      complete: true,
      label: "get-with-body",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Content-Length: 1048577",
        "Connection: close",
      ],
      body: "",
      wellFormed: true,
      complete: false,
      label: "get-declares-1mb-sends-none",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Content-Length: 5",
        "Content-Length: 6",
        "Connection: close",
      ],
      body: "hello",
      wellFormed: false,
      complete: true,
      label: "conflicting-content-length",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Transfer-Encoding: chunked",
        "Connection: close",
      ],
      body: "5\r\nhello\r\n0\r\n\r\n",
      wellFormed: true,
      complete: true,
      label: "get-chunked-body",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Transfer-Encoding: chunked",
        "Connection: close",
      ],
      body: "zz\r\nhello\r\n0\r\n\r\n",
      wellFormed: false,
      complete: true,
      label: "get-bad-chunk-size",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Transfer-Encoding: chunked",
        "Content-Length: 5",
        "Connection: close",
      ],
      body: "hello",
      wellFormed: false,
      complete: true,
      label: "te-and-cl",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Transfer-Encoding: gzip",
        "Connection: close",
      ],
      body: "",
      wellFormed: false,
      complete: true,
      label: "te-gzip",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Expect: 100-continue",
        "Content-Length: 0",
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "expect-100",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "X-Folded: a",
        " b",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "obs-fold",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Bad Name: x",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "space-in-header-name",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "NoColon",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "header-without-colon",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        ": empty-name",
        "Connection: close",
      ],
      wellFormed: false,
      complete: true,
      label: "empty-header-name",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "__proto__: 1",
        "constructor: 2",
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "proto-header-names",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        ...Array.from({ length: 1000 }, (_, i) => `X-H${i}: ${i}`),
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "1000-headers",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        `X-Big: ${"v".repeat(HUGE * 4)}`,
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "256k-header-value",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        `Authorization: Bearer ${"t".repeat(HUGE)}`,
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "64k-bearer",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Authorization: Bearer \u00ff\u00fe",
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "bearer-highbytes",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "CF-Connecting-IP: ",
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "empty-cf-ip",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        `CF-Connecting-IP: ${"9".repeat(HUGE)}`,
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "64k-cf-ip",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Range: bytes=0-1",
        "Connection: close",
      ],
      wellFormed: true,
      complete: true,
      label: "range",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: x",
        "Sec-WebSocket-Version: 13",
      ],
      wellFormed: true,
      complete: true,
      keepAlive: true,
      label: "websocket-upgrade",
    }),
    () => ({
      headers: [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Upgrade: h2c",
        "HTTP2-Settings: AAMAAABkAAQCAAAAAAIAAAAA",
        "Connection: Upgrade, HTTP2-Settings, close",
      ],
      wellFormed: true,
      complete: true,
      label: "h2c-upgrade",
    }),
    () => ({
      headers: ["Host: edge.test", `X-Forwarded-For: ${ip}`],
      wellFormed: true,
      complete: true,
      label: "keep-alive-no-close",
    }),
  ];
  const v = rng.pick(variants)();
  return {
    bytes: rawRequest(
      method,
      `${MOUNT}/${doc}`,
      "HTTP/1.1",
      v.headers,
      v.body ?? "",
    ),
    requests: 1,
    wellFormed: v.wellFormed,
    complete: v.complete,
    keepAlive: v.keepAlive,
    heads: [head],
    expectLegal: [v.legal ?? true],
    docs: [doc],
    label: `${method} ${v.label}`,
  };
}

function rawVersionSpec(rng: Rng): RawSpec {
  const doc = rng.pick(DOC_NAMES);
  const ip = rng.ip();
  type V = {
    bytes: Uint8Array;
    requests: number;
    wellFormed: boolean;
    complete: boolean;
    heads: boolean[];
    legal: boolean[];
    docs: string[];
    label: string;
  };
  const variants: Array<() => V> = [
    () => ({
      bytes: rawRequest("GET", `${MOUNT}/${doc}`, "HTTP/1.0", [
        `X-Forwarded-For: ${ip}`,
      ], ""),
      requests: 1,
      wellFormed: true,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "http/1.0-no-host",
    }),
    () => ({
      bytes: latin1(`GET ${MOUNT}/${doc}\r\n`),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "http/0.9",
    }),
    () => ({
      bytes: rawRequest("GET", `${MOUNT}/${doc}`, "HTTP/2.0", [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Connection: close",
      ], ""),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "http/2.0-text",
    }),
    () => ({
      bytes: rawRequest("GET", `${MOUNT}/${doc}`, "HTTP/1.2", [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Connection: close",
      ], ""),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "http/1.2",
    }),
    () => ({
      bytes: rawRequest("GET", `${MOUNT}/${doc}`, "HTTP/9.9", [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Connection: close",
      ], ""),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "http/9.9",
    }),
    () => ({
      bytes: rawRequest("GET", `${MOUNT}/${doc}`, "http/1.1", [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Connection: close",
      ], ""),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "lowercase-version",
    }),
    () => ({
      bytes: rawRequest("GET", `${MOUNT}/${doc}`, "HTTP/1.1 ", [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
        "Connection: close",
      ], ""),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "trailing-space-version",
    }),
    () => ({
      bytes: rawRequest(
        "GET",
        `${MOUNT}/${doc}`,
        "HTTP/1.1",
        ["Host: edge.test", `X-Forwarded-For: ${ip}`, "Connection: close"],
        "",
        "\n",
      ),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "lf-only",
    }),
    () => ({
      bytes: latin1(
        `GET  ${MOUNT}/${doc}  HTTP/1.1\r\nHost: edge.test\r\nConnection: close\r\n\r\n`,
      ),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "double-spaces",
    }),
    () => ({
      bytes: latin1(
        `GET\t${MOUNT}/${doc}\tHTTP/1.1\r\nHost: edge.test\r\nConnection: close\r\n\r\n`,
      ),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "tab-separators",
    }),
    () => ({
      bytes: latin1(
        `\r\n\r\nGET ${MOUNT}/${doc} HTTP/1.1\r\nHost: edge.test\r\nX-Forwarded-For: ${ip}\r\nConnection: close\r\n\r\n`,
      ),
      requests: 1,
      wellFormed: true,
      complete: true,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "leading-crlf",
    }),
    () => ({
      bytes: latin1(`GET ${MOUNT}/${doc} HTTP/1.1\r\nHost: edge.test\r\n`),
      requests: 1,
      wellFormed: false,
      complete: false,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "truncated-headers",
    }),
    () => ({
      bytes: latin1(`GET ${MOUNT}/${doc} HTTP/1.1\r\nHost: edge.te`),
      requests: 1,
      wellFormed: false,
      complete: false,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "truncated-mid-header",
    }),
    () => ({
      bytes: latin1(`GET ${MOUNT}/${doc}`),
      requests: 1,
      wellFormed: false,
      complete: false,
      heads: [false],
      legal: [true],
      docs: [doc],
      label: "truncated-request-line",
    }),
    () => ({
      bytes: new Uint8Array([
        0x16,
        0x03,
        0x01,
        0x00,
        0xa5,
        0x01,
        0x00,
        0x00,
        0xa1,
        0x03,
        0x03,
      ]),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [false],
      docs: [doc],
      label: "tls-client-hello",
    }),
    () => ({
      bytes: latin1("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [false],
      docs: [doc],
      label: "h2-preface",
    }),
    () => ({
      bytes: new Uint8Array(
        Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff),
      ),
      requests: 1,
      wellFormed: false,
      complete: true,
      heads: [false],
      legal: [false],
      docs: [doc],
      label: "binary-noise",
    }),
    () => {
      const docs = [doc, rng.pick(DOC_NAMES), rng.pick(DOC_NAMES)];
      const heads = docs.map(() => rng.chance(0.3));
      const parts = docs.map((d, i) =>
        rawRequest(heads[i] ? "HEAD" : "GET", `${MOUNT}/${d}`, "HTTP/1.1", [
          "Host: edge.test",
          `X-Forwarded-For: ${ip}`,
          ...(i === docs.length - 1 ? ["Connection: close"] : []),
        ], "")
      );
      return {
        bytes: concat(parts),
        requests: docs.length,
        wellFormed: true,
        complete: true,
        heads,
        legal: docs.map(() => true),
        docs,
        label: "pipelined-3",
      };
    },
    () => {
      const first = rawRequest("GET", `${MOUNT}/${doc}`, "HTTP/1.1", [
        "Host: edge.test",
        `X-Forwarded-For: ${ip}`,
      ], "");
      const garbage = latin1(
        `GET ${MOUNT}/${doc}\u0000 HTTP/1.1\r\nHost: edge.test\r\nConnection: close\r\n\r\n`,
      );
      return {
        bytes: concat([first, garbage]),
        requests: 2,
        wellFormed: false,
        complete: true,
        heads: [false, false],
        legal: [true, false],
        docs: [doc, doc],
        label: "pipelined-good-then-garbage",
      };
    },
  ];
  const v = rng.pick(variants)();
  return {
    bytes: v.bytes,
    requests: v.requests,
    wellFormed: v.wellFormed,
    complete: v.complete,
    heads: v.heads,
    expectLegal: v.legal,
    docs: v.docs,
    label: v.label,
  };
}

// ─── execution: in-process plane ─────────────────────────────────────────────

interface Ctx {
  handler: (request: Request) => Promise<Response>;
  calls: () => number;
  callAt: (i: number) => { method: string; url: string };
  logLines: string[];
  errorLines: string[];
}

function checkErrorBody(
  status: number,
  contentType: string,
  text: string,
  problems: string[],
): void {
  if (DETAIL_LEAK_RE.test(text)) {
    problems.push(`I3 detail leak in ${status} body: ${truncate(text, 80)}`);
  }
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(text);
      const code = parsed?.error?.code;
      const message = parsed?.error?.message;
      // errorJson shape: { error: { message, code? } } — message always, code when typed.
      if (
        typeof message !== "string" ||
        (code !== undefined && typeof code !== "string")
      ) {
        problems.push(
          `I3 ${status} JSON body is not {error:{message,code?}}: ${
            truncate(text, 80)
          }`,
        );
      }
      const keys = Object.keys(parsed?.error ?? {}).filter((k) =>
        k !== "code" && k !== "message"
      );
      if (keys.length) {
        problems.push(
          `I3 ${status} error object carries extra fields: ${keys.join(",")}`,
        );
      }
    } catch {
      problems.push(
        `I3 ${status} declared JSON but body does not parse: ${
          truncate(text, 80)
        }`,
      );
    }
  } else if (text.length > 0 && status !== 404 && status !== 405) {
    problems.push(`I3 ${status} non-JSON error body: ${truncate(text, 80)}`);
  }
}

function checkRateLimited(
  res: Response,
  text: string,
  problems: string[],
): void {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    problems.push("I2 429 without JSON content-type");
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.code !== "rate_limited") {
      problems.push(`I2 429 body code=${String(parsed?.error?.code)}`);
    }
  } catch {
    problems.push("I2 429 body is not JSON");
  }
  if (!/^\d+$/.test(res.headers.get("retry-after") ?? "")) {
    problems.push("I2 429 without integer Retry-After");
  }
  if (res.headers.get("cache-control") !== "no-store") {
    problems.push("I2 429 cache-control not no-store");
  }
}

async function runInproc(
  ctx: Ctx,
  family: string,
  seed: number,
  spec: InprocSpec,
): Promise<Row> {
  const row: Row = {
    id: `${family}:${seed}`,
    family,
    plane: "inproc",
    seed,
    method: spec.method,
    target: truncate(spec.url.slice("http://edge.test".length)),
    status: null,
    outcome: "HELD",
    detail: "",
    requests: 0,
  };
  let request: Request;
  let pathname: string;
  try {
    const headers = new Headers();
    if (spec.ip) headers.set("x-forwarded-for", spec.ip);
    for (const [k, v] of spec.headers) headers.append(k, v);
    request = new Request(spec.url, {
      method: spec.method,
      headers,
      body: spec.body === null ? undefined : spec.body,
    });
    pathname = new URL(request.url).pathname;
  } catch (error) {
    row.outcome = "UNCONSTRUCTIBLE";
    row.detail = `Request constructor rejected: ${
      error instanceof Error ? error.constructor.name : "?"
    }`;
    return row;
  }
  const isRead = request.method === "GET" || request.method === "HEAD";
  const expectLegal = isRead && LEGAL_RE.test(pathname);
  // /healthz is the other public read route a mutated legal path can land on.
  const expectHealthz = isRead && pathname.endsWith("/healthz");
  const docName = LEGAL_RE.exec(pathname)?.[1];
  const problems: string[] = [];
  const callsBefore = ctx.calls();
  const logsBefore = ctx.logLines.length;
  const errorsBefore = ctx.errorLines.length;
  row.requests = 1;

  let res: Response;
  try {
    res = await ctx.handler(request);
  } catch (error) {
    row.outcome = "BROKEN";
    row.detail = `I1 handler threw ${
      error instanceof Error
        ? `${error.constructor.name}: ${error.message}`
        : String(error)
    }`;
    return row;
  }
  row.status = res.status;
  let text = "";
  try {
    text = await res.text();
  } catch (error) {
    problems.push(
      `response body unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (res.status >= 500) problems.push(`I1 status ${res.status}`);

  const rid = res.headers.get("x-request-id") ?? "";
  if (!rid) problems.push("I4 missing x-request-id");
  else {
    // What the handler actually sees: repeated x-request-id headers combine
    // into "a, b", which is (correctly) not a well-formed id.
    const client = request.headers.get("x-request-id")?.trim() ?? "";
    if (client && REQUEST_ID_RE.test(client)) {
      if (rid !== client) {
        problems.push(
          `I4 well-formed client id not echoed (${
            truncate(client, 20)
          } → ${rid})`,
        );
      }
    } else {
      if (!UUID_RE.test(rid)) {
        problems.push(`I4 minted id is not a UUID: ${truncate(rid, 40)}`);
      }
      if (client && rid === client) {
        problems.push("I4 malformed client id reflected");
      }
    }
  }
  const clientIdNote = (() => {
    const client = request.headers.get("x-request-id") ?? "";
    if (!client) return "";
    if (REQUEST_ID_RE.test(client.trim())) return " (client request-id echoed)";
    return client.includes(", ")
      ? " (repeated x-request-id → minted)"
      : " (malformed x-request-id → minted)";
  })();

  const contentType = res.headers.get("content-type") ?? "";
  if (expectLegal) {
    if (res.status === 200) {
      if (contentType !== "text/plain; charset=utf-8") {
        problems.push(`I2 content-type ${contentType}`);
      }
      if (res.headers.get("x-content-type-options") !== "nosniff") {
        problems.push("I2 missing nosniff");
      }
      if (res.headers.get("cache-control") !== "public, max-age=3600") {
        problems.push("I2 cache-control");
      }
      if (res.headers.get("referrer-policy") !== "no-referrer") {
        problems.push("I2 referrer-policy");
      }
      if (docName && text !== DOCS[docName]) {
        problems.push(
          `I2 body is not the ${docName} document (len ${text.length})`,
        );
      }
    } else if (res.status === 429) {
      checkRateLimited(res, text, problems);
    } else {
      problems.push(`I2 legal route answered ${res.status}`);
    }
  } else if (expectHealthz) {
    if (res.status === 200) {
      if (!contentType.includes("application/json")) {
        problems.push(`healthz content-type ${contentType}`);
      }
    } else if (res.status === 429) {
      checkRateLimited(res, text, problems);
    } else {
      problems.push(`healthz answered ${res.status}`);
    }
  } else {
    if (res.status < 400 || res.status > 499) {
      if (res.status < 500) {
        problems.push(
          `I3 non-legal request answered ${res.status} (expected 4xx)`,
        );
      }
    } else if (res.status === 429) {
      checkRateLimited(res, text, problems);
    } else {
      checkErrorBody(res.status, contentType, text, problems);
    }
  }

  const callsAfter = ctx.calls();
  for (let i = callsBefore; i < callsAfter; i += 1) {
    const call = ctx.callAt(i);
    if (call.method !== "GET") {
      problems.push(`I5 outbound ${call.method} ${truncate(call.url, 60)}`);
    }
  }
  if (expectLegal && callsAfter !== callsBefore) {
    problems.push(
      `I5 legal route made ${callsAfter - callsBefore} outbound call(s)`,
    );
  }

  const lines = ctx.logLines.slice(logsBefore);
  if (lines.length !== 1) problems.push(`I6 ${lines.length} access-log lines`);
  else {
    try {
      const entry = JSON.parse(lines[0]);
      if (entry.evt !== "api_request") problems.push("I6 evt");
      if (entry.requestId !== rid) problems.push("I6 requestId mismatch");
      if (entry.status !== res.status) problems.push("I6 status mismatch");
      if (entry.method !== request.method) problems.push("I6 method mismatch");
      if (typeof entry.route !== "string") problems.push("I6 route");
      const search = new URL(request.url).search;
      if (search.length > 1 && lines[0].includes(search)) {
        problems.push("I6 query string in access log");
      }
      if (spec.ip && lines[0].includes(spec.ip)) {
        problems.push("I6 client ip in access log");
      }
      const auth = request.headers.get("authorization");
      if (auth && auth.length > 8 && lines[0].includes(auth)) {
        problems.push("I6 bearer in access log");
      }
    } catch {
      problems.push("I6 access-log line is not JSON");
    }
  }
  const unhandled = ctx.errorLines.slice(errorsBefore).filter((l) =>
    l.includes("unhandled error")
  );
  if (unhandled.length) problems.push(`I1 unhandled error logged`);

  if (problems.length) {
    row.outcome = "BROKEN";
    row.detail = problems.join("; ");
  } else {
    row.detail = (expectLegal
      ? (res.status === 200 ? `200 ${docName}` : `${res.status}`)
      : expectHealthz
      ? `${res.status} healthz`
      : `${res.status} rejected`) + clientIdNote;
  }
  return row;
}

// ─── execution: raw socket plane ─────────────────────────────────────────────

interface ParsedResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

function indexOfSeq(buf: Uint8Array, seq: Uint8Array, from: number): number {
  outer: for (let i = from; i <= buf.length - seq.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) {
      if (buf[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);

function parseResponses(
  buf: Uint8Array,
  heads: boolean[],
): {
  responses: ParsedResponse[];
  trailing: number;
  parseError: string | null;
} {
  const responses: ParsedResponse[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const end = indexOfSeq(buf, CRLFCRLF, offset);
    if (end < 0) {
      return {
        responses,
        trailing: buf.length - offset,
        parseError: "incomplete response head",
      };
    }
    const headText = new TextDecoder("latin1").decode(
      buf.subarray(offset, end),
    );
    const [statusLine, ...headerLines] = headText.split("\r\n");
    const m = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
    if (!m) {
      return {
        responses,
        trailing: buf.length - offset,
        parseError: `bad status line: ${truncate(statusLine, 60)}`,
      };
    }
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        headers.set(
          line.slice(0, idx).trim().toLowerCase(),
          line.slice(idx + 1).trim(),
        );
      }
    }
    offset = end + 4;
    const status = Number(m[1]);
    const isHead = heads[responses.length] ?? false;
    let body: Uint8Array = new Uint8Array(0);
    const cl = headers.get("content-length");
    if (!isHead && status !== 204 && status !== 304) {
      if (headers.get("transfer-encoding")?.includes("chunked")) {
        const chunks: Uint8Array[] = [];
        for (;;) {
          const lineEnd = indexOfSeq(buf, new Uint8Array([13, 10]), offset);
          if (lineEnd < 0) {
            return {
              responses,
              trailing: buf.length - offset,
              parseError: "incomplete chunk size",
            };
          }
          const size = parseInt(
            new TextDecoder().decode(buf.subarray(offset, lineEnd)),
            16,
          );
          offset = lineEnd + 2;
          if (size === 0) {
            const trailerEnd = indexOfSeq(
              buf,
              new Uint8Array([13, 10]),
              offset,
            );
            offset = trailerEnd < 0 ? buf.length : trailerEnd + 2;
            break;
          }
          chunks.push(buf.subarray(offset, offset + size));
          offset += size + 2;
        }
        body = concat(chunks);
      } else if (cl !== undefined) {
        const n = Number(cl);
        body = buf.subarray(offset, offset + n);
        offset += n;
      } else {
        body = buf.subarray(offset);
        offset = buf.length;
      }
    }
    responses.push({ status, headers, body });
  }
  return { responses, trailing: 0, parseError: null };
}

async function rawExchange(
  port: number,
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<{ data: Uint8Array; timedOut: boolean; error: string | null }> {
  let conn: Deno.TcpConn | null = null;
  const chunks: Uint8Array[] = [];
  let timedOut = false;
  let error: string | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      conn?.close();
    } catch {
      // already closed
    }
  }, timeoutMs);
  try {
    conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.setNoDelay(true);
    let written = 0;
    while (written < bytes.length) {
      written += await conn.write(bytes.subarray(written));
    }
    const buf = new Uint8Array(64 * 1024);
    for (;;) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
  } catch (e) {
    if (!timedOut) {
      error = e instanceof Error
        ? `${e.constructor.name}: ${e.message}`
        : String(e);
    }
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch {
      // already closed
    }
  }
  return { data: concat(chunks), timedOut, error };
}

async function runRaw(
  ctx: Ctx,
  port: number,
  family: string,
  seed: number,
  spec: RawSpec,
): Promise<Row> {
  const row: Row = {
    id: `${family}:${seed}`,
    family,
    plane: "raw",
    seed,
    method: spec.label,
    target: truncate(
      new TextDecoder("latin1").decode(spec.bytes.subarray(0, 200)).split(
        "\r\n",
      )[0].replace(/[^\x20-\x7e]/g, "?"),
    ),
    status: null,
    outcome: "HELD",
    detail: "",
    requests: spec.requests,
  };
  const problems: string[] = [];
  const errorsBefore = ctx.errorLines.length;
  const logsBefore = ctx.logLines.length;
  const headEnd = indexOfSeq(spec.bytes, CRLFCRLF, 0);
  const headBytes = headEnd < 0 ? spec.bytes.length : headEnd;
  const headerLines =
    new TextDecoder("latin1").decode(spec.bytes.subarray(0, headBytes)).split(
      "\r\n",
    ).length - 1;
  const serverLimit = headBytes >= SERVER_HEAD_LIMIT_BYTES ||
    headerLines > SERVER_HEADER_COUNT_LIMIT;
  const { data, timedOut, error } = await rawExchange(
    port,
    spec.bytes,
    spec.complete && !spec.keepAlive
      ? RAW_TIMEOUT_MS
      : RAW_INCOMPLETE_TIMEOUT_MS,
  );

  if (timedOut && data.length === 0) {
    if (spec.complete) {
      problems.push(`I7 no response / no close within ${RAW_TIMEOUT_MS}ms`);
    } else {row.detail =
        `server waits for the rest of an incomplete request (no bytes sent)`;}
  } else if (data.length === 0) {
    if (spec.wellFormed) {
      problems.push(
        `I7 well-formed request closed without any response${
          error ? ` (${error})` : ""
        }`,
      );
    } else row.detail = `closed without response${error ? ` (${error})` : ""}`;
  } else {
    if (timedOut) {
      row.detail =
        `responded, then held the connection open (${data.length} B received); `;
    }
    const { responses, parseError } = parseResponses(data, spec.heads);
    if (parseError && spec.wellFormed) {
      problems.push(`I7 unparsable response: ${parseError}`);
    }
    if (spec.wellFormed && responses.length !== spec.requests) {
      problems.push(
        `I7 ${responses.length} responses for ${spec.requests} pipelined requests`,
      );
    }
    row.status = responses[0]?.status ?? null;
    responses.forEach((res, i) => {
      if (res.status >= 500) {
        problems.push(`I1 response ${i} status ${res.status}`);
      }
      const isHead = spec.heads[i] ?? false;
      const expectLegal = spec.expectLegal[i] ?? false;
      const docName = spec.docs[i];
      const bodyStr = new TextDecoder().decode(res.body);
      const viaHandler = res.headers.has("x-request-id");
      if (!viaHandler && res.status === 400 && serverLimit) {
        row.detail +=
          `[${i}] 400 from the HTTP server (head ${headBytes} B, ${headerLines} header lines); `;
        return;
      }
      if (res.status === 200) {
        if (!(spec.wellFormed && expectLegal)) {
          // A lenient parser accepted something we tagged malformed; still must be the document.
          row.detail += `[${i}] accepted as legal; `;
        }
        if (res.headers.get("content-type") !== "text/plain; charset=utf-8") {
          problems.push(
            `I2 [${i}] content-type ${res.headers.get("content-type")}`,
          );
        }
        if (isHead) {
          if (res.body.length !== 0) {
            problems.push(
              `I7 [${i}] HEAD returned ${res.body.length} body bytes`,
            );
          }
        } else if (bodyStr !== DOCS[docName]) {
          problems.push(
            `I7 [${i}] GET body (${res.body.length} B) is not the ${docName} document (${
              utf8.encode(DOCS[docName]).length
            } B)`,
          );
        }
        if (!res.headers.get("x-request-id")) {
          problems.push(`I4 [${i}] missing x-request-id`);
        }
      } else if (res.status === 429) {
        if (!bodyStr.includes("rate_limited")) {
          problems.push(`I2 [${i}] 429 without rate_limited code`);
        }
      } else if (res.status >= 400) {
        if (spec.wellFormed && expectLegal) {
          problems.push(
            `I2 [${i}] legal route answered ${res.status}${
              viaHandler ? "" : " (no x-request-id: HTTP-server rejection)"
            }`,
          );
        }
        if (DETAIL_LEAK_RE.test(bodyStr)) {
          problems.push(`I3 [${i}] detail leak: ${truncate(bodyStr, 80)}`);
        }
      } else {
        problems.push(`I7 [${i}] unexpected status ${res.status}`);
      }
    });
    if (spec.heads.some(Boolean) && spec.wellFormed) {
      // The document itself would be several KiB; anything trailing a HEAD response is a leak.
      const lastHead = spec.heads.lastIndexOf(true);
      if (
        lastHead === spec.heads.length - 1 && responses.length === spec.requests
      ) {
        const last = responses[responses.length - 1];
        if (last.body.length) {
          problems.push(`I7 trailing ${last.body.length} bytes after HEAD`);
        }
      }
    }
    if (!row.detail) row.detail = responses.map((r) => r.status).join(",");
    else if (!/\d$/.test(row.detail)) {
      row.detail += responses.map((r) => r.status).join(",");
    }
  }

  const unhandled = ctx.errorLines.slice(errorsBefore).filter((l) =>
    l.includes("unhandled error")
  );
  if (unhandled.length) problems.push("I1 unhandled error logged");
  const lines = ctx.logLines.slice(logsBefore);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.status >= 500) {
        problems.push(`I1 access log status ${entry.status}`);
      }
    } catch {
      problems.push("I6 access-log line is not JSON");
    }
  }

  if (problems.length) {
    row.outcome = "BROKEN";
    row.detail = problems.join("; ");
  }
  return row;
}

// ─── burst family (same IP, fixed 60/min window) ─────────────────────────────

async function runBurst(
  ctx: Ctx,
  family: string,
  seed: number,
  rng: Rng,
): Promise<Row> {
  const doc = rng.pick(DOC_NAMES);
  const ip = rng.ip();
  const limit = 60;
  const total = limit + 5;
  const row: Row = {
    id: `${family}:${seed}`,
    family,
    plane: "inproc",
    seed,
    method: "GET×65",
    target: `${MOUNT}/${doc} from ${ip}`,
    status: null,
    outcome: "HELD",
    detail: "",
    requests: 0,
  };
  const problems: string[] = [];
  const statuses: number[] = [];
  const windowStart = Math.floor(Date.now() / 60_000);
  for (let i = 0; i < total; i += 1) {
    const method = rng.chance(0.2) ? "HEAD" : "GET";
    let res: Response;
    try {
      res = await ctx.handler(
        new Request(`http://edge.test${MOUNT}/${doc}`, {
          method,
          headers: { "x-forwarded-for": ip },
        }),
      );
    } catch (error) {
      problems.push(
        `I1 handler threw on burst request ${i}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      break;
    }
    row.requests += 1;
    const text = await res.text();
    statuses.push(res.status);
    if (res.status >= 500) {
      problems.push(`I1 burst request ${i} → ${res.status}`);
    }
    if (res.status === 429) checkRateLimited(res, text, problems);
    else if (res.status === 200) {
      if (method === "GET" && text !== DOCS[doc]) {
        problems.push(`I2 burst request ${i} body mismatch`);
      }
    } else problems.push(`I2 burst request ${i} → ${res.status}`);
  }
  const windowEnd = Math.floor(Date.now() / 60_000);
  const okCount = statuses.filter((s) => s === 200).length;
  const limited = statuses.filter((s) => s === 429).length;
  row.status = statuses[statuses.length - 1] ?? null;
  if (windowStart === windowEnd) {
    if (okCount !== limit || limited !== total - limit) {
      problems.push(
        `I2 expected ${limit}×200 then ${
          total - limit
        }×429, got ${okCount}×200 ${limited}×429`,
      );
    }
    const firstLimited = statuses.indexOf(429);
    if (
      firstLimited >= 0 && statuses.slice(firstLimited).some((s) => s !== 429)
    ) problems.push("I2 429 was not sticky within the window");
  } else {
    row.detail =
      `window rolled mid-burst (${okCount}×200 ${limited}×429) — shape checks only; `;
  }
  if (problems.length) {
    row.outcome = "BROKEN";
    row.detail += problems.join("; ");
  } else if (!row.detail) row.detail = `${okCount}×200 then ${limited}×429`;
  return row;
}

// ─── campaign ────────────────────────────────────────────────────────────────

const SCHEDULE: Array<{ family: string; plane: "inproc" | "raw" }> = [
  { family: "ip_path", plane: "inproc" },
  { family: "raw_target", plane: "raw" },
  { family: "ip_headers", plane: "inproc" },
  { family: "raw_headers", plane: "raw" },
  { family: "ip_method", plane: "inproc" },
  { family: "raw_method", plane: "raw" },
  { family: "ip_query", plane: "inproc" },
  { family: "raw_version", plane: "raw" },
  { family: "ip_body", plane: "inproc" },
  { family: "ip_path", plane: "inproc" },
  { family: "raw_target", plane: "raw" },
  { family: "ip_headers", plane: "inproc" },
];

const FAMILY_PLANE: Record<string, "inproc" | "raw"> = Object.fromEntries(
  SCHEDULE.map((s) => [s.family, s.plane]),
);
FAMILY_PLANE.ip_burst = "inproc";

function runOne(
  ctx: Ctx,
  port: number,
  family: string,
  seed: number,
): Promise<Row> {
  const rng = new Rng(seed);
  switch (family) {
    case "ip_path":
      return runInproc(ctx, family, seed, pathSpec(rng));
    case "ip_query":
      return runInproc(ctx, family, seed, querySpec(rng));
    case "ip_headers":
      return runInproc(ctx, family, seed, headerSpec(rng));
    case "ip_method":
      return runInproc(ctx, family, seed, methodSpec(rng));
    case "ip_body":
      return runInproc(ctx, family, seed, bodySpec(rng));
    case "ip_burst":
      return runBurst(ctx, family, seed, rng);
    case "raw_target":
      return runRaw(ctx, port, family, seed, rawTargetSpec(rng));
    case "raw_method":
      return runRaw(ctx, port, family, seed, rawMethodSpec(rng));
    case "raw_headers":
      return runRaw(ctx, port, family, seed, rawHeaderSpec(rng));
    case "raw_version":
      return runRaw(ctx, port, family, seed, rawVersionSpec(rng));
    default:
      throw new Error(`unknown family ${family}`);
  }
}

function plan(): Array<{ family: string; seed: number }> {
  if (REPLAY.length) {
    return REPLAY.map((id) => {
      const idx = id.lastIndexOf(":");
      const family = id.slice(0, idx);
      const seed = Number(id.slice(idx + 1)) >>> 0;
      if (!(family in FAMILY_PLANE) || !Number.isFinite(seed)) {
        throw new Error(`bad STRESS_REPLAY id ${id}`);
      }
      return { family, seed };
    });
  }
  const items: Array<{ family: string; seed: number }> = [];
  for (let i = 0; i < ITER; i += 1) {
    const seed = iterSeed(BASE_SEED, i);
    items.push(
      i % BURST_EVERY === 0
        ? { family: "ip_burst", seed }
        : { family: SCHEDULE[i % SCHEDULE.length].family, seed },
    );
  }
  return items;
}

Deno.test({
  name: `stress legal boundary-malformed: ${
    REPLAY.length ? `replay ${REPLAY.length}` : `${ITER} iterations`
  } (seed ${BASE_SEED}) against the real handler, in-process + raw HTTP`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).sort()
      .join(",");
    const arrayKeysBefore = Object.getOwnPropertyNames(Array.prototype).sort()
      .join(",");

    const logLines: string[] = [];
    const errorLines: string[] = [];
    const restoreLog = captureAccessLog((line) => logLines.push(line));
    const realError = console.error;
    console.error = (...args: unknown[]) =>
      errorLines.push(args.map(String).join(" "));

    const server = h.realServe(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request: Request) => h.handler(request),
    );
    const port = (server.addr as Deno.NetAddr).port;

    const ctx: Ctx = {
      handler: h.handler,
      calls: () => h.calls.length,
      callAt: (i) => ({ method: h.calls[i].method, url: h.calls[i].url }),
      logLines,
      errorLines,
    };

    const rows: Row[] = [];
    const memory: Array<
      { at: number; rss: number; heapUsed: number; windows: number }
    > = [];
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const items = plan();
    try {
      for (let i = 0; i < items.length; i += 1) {
        if (i % 500 === 0) {
          const m = Deno.memoryUsage();
          memory.push({
            at: i,
            rss: m.rss,
            heapUsed: m.heapUsed,
            windows: rows.length,
          });
        }
        const { family, seed } = items[i];
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const hung = new Promise<Row>((resolve) => {
          watchdog = setTimeout(() =>
            resolve({
              id: `${family}:${seed}`,
              family,
              plane: FAMILY_PLANE[family],
              seed,
              method: "?",
              target: "?",
              status: null,
              outcome: "BROKEN",
              detail:
                `I7 iteration did not settle within ${ITERATION_TIMEOUT_MS}ms`,
              requests: 0,
            }), ITERATION_TIMEOUT_MS);
        });
        try {
          const started = performance.now();
          const row = await Promise.race([
            runOne(ctx, port, family, seed),
            hung,
          ]);
          row.ms = Math.round(performance.now() - started);
          rows.push(row);
        } finally {
          clearTimeout(watchdog);
        }
        if (PROGRESS_EVERY && (i + 1) % PROGRESS_EVERY === 0) {
          realError(
            `[stress] ${i + 1}/${items.length} ${family}:${seed} → ${
              rows[rows.length - 1].outcome
            }`,
          );
        }
      }
    } finally {
      const m = Deno.memoryUsage();
      memory.push({
        at: items.length,
        rss: m.rss,
        heapUsed: m.heapUsed,
        windows: rows.length,
      });
      await server.shutdown();
    }
    const durationMs = Math.round(performance.now() - t0);

    // I8 — nothing leaked into the global prototypes; the handler still serves.
    const postProblems: string[] = [];
    try {
      if (
        Object.getOwnPropertyNames(Object.prototype).sort().join(",") !==
          protoKeysBefore
      ) postProblems.push("I8 Object.prototype changed");
      if (
        Object.getOwnPropertyNames(Array.prototype).sort().join(",") !==
          arrayKeysBefore
      ) postProblems.push("I8 Array.prototype changed");
      if ((({}) as Record<string, unknown>).polluted !== undefined) {
        postProblems.push("I8 {}.polluted defined");
      }
      for (const doc of DOC_NAMES) {
        const res = await h.handler(
          new Request(`http://edge.test${MOUNT}/${doc}`, {
            headers: { "x-forwarded-for": "198.51.100.250" },
          }),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== DOCS[doc]) {
          postProblems.push(
            `I8 post-campaign GET /${doc} → ${res.status} (${text.length} B)`,
          );
        }
      }
    } finally {
      console.error = realError;
      restoreLog();
    }

    const executed = rows.filter((r) => r.outcome !== "UNCONSTRUCTIBLE").reduce(
      (n, r) => n + r.requests,
      0,
    );
    const broken = rows.filter((r) => r.outcome === "BROKEN");
    const unconstructible = rows.filter((r) => r.outcome === "UNCONSTRUCTIBLE");
    const perFamily: Record<
      string,
      {
        rows: number;
        requests: number;
        held: number;
        broken: number;
        unconstructible: number;
        statuses: Record<string, number>;
      }
    > = {};
    for (const r of rows) {
      const f = (perFamily[r.family] ??= {
        rows: 0,
        requests: 0,
        held: 0,
        broken: 0,
        unconstructible: 0,
        statuses: {},
      });
      f.rows += 1;
      if (r.outcome !== "UNCONSTRUCTIBLE") f.requests += r.requests;
      if (r.outcome === "HELD") f.held += 1;
      if (r.outcome === "BROKEN") f.broken += 1;
      if (r.outcome === "UNCONSTRUCTIBLE") f.unconstructible += 1;
      const key = r.status === null ? "none" : String(r.status);
      f.statuses[key] = (f.statuses[key] ?? 0) + 1;
    }
    const maxRouteLen = logLines.reduce((max, line) => {
      try {
        return Math.max(max, String(JSON.parse(line).route ?? "").length);
      } catch {
        return max;
      }
    }, 0);
    const unhandledLogged = errorLines.filter((l) =>
      l.includes("unhandled error")
    ).length;

    const report = {
      lens: "boundary-malformed",
      unit: "edge-legal",
      handler:
        "supabase/functions/api/index.ts (real, in-process via __wf__/routesHarness.ts)",
      baseSeed: BASE_SEED,
      iterations: items.length,
      replay: REPLAY,
      startedAt,
      durationMs,
      executedRequests: executed,
      rows: rows.length,
      held: rows.filter((r) => r.outcome === "HELD").length,
      broken: broken.length,
      unconstructible: unconstructible.length,
      accessLogLines: logLines.length,
      unhandledErrorsLogged: unhandledLogged,
      maxAccessLogRouteLength: maxRouteLen,
      postCampaign: postProblems.length ? postProblems : "I8 held",
      perFamily,
      memory,
      failures: broken,
      unconstructibleSamples: unconstructible.slice(0, 50),
      table: rows,
    };
    if (OUT_PATH) {
      await Deno.writeTextFile(OUT_PATH, JSON.stringify(report, null, 1));
    }
    const headline =
      `legal boundary-malformed: ${executed} requests over ${rows.length} iterations (${unconstructible.length} unconstructible) in ${durationMs}ms — ${broken.length} BROKEN`;
    console.log(headline);
    console.log(`per family: ${JSON.stringify(perFamily)}`);
    if (OUT_PATH) console.log(`table → ${OUT_PATH}`);

    assertEquals(
      broken.map((r) => `${r.id} ${r.method} ${r.target} → ${r.detail}`),
      [],
      `${broken.length} BROKEN iteration(s); replay with STRESS_REPLAY=${
        broken.slice(0, 5).map((r) => r.id).join(",")
      }`,
    );
    assertEquals(postProblems, []);
    assertEquals(unhandledLogged, 0, "handler logged an unhandled error");
    assert(
      executed >= rows.length - unconstructible.length,
      "every constructible iteration ran",
    );
  },
});
