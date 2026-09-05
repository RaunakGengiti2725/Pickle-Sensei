// STRESS (lens: boundary / malformed input) — the REAL edge handler
// (index.ts via routesHarness, Supabase/RevenueCat stubbed, no Upstash so the
// rate limiter runs in memory-fallback mode, exactly like a deployment without
// UPSTASH_* secrets) fed seeded hostile requests on the pre-auth surface that
// rateLimit.ts guards: X-Forwarded-For / CF-Connecting-IP, Authorization,
// Content-Length, X-Request-Id, request paths, and JSON bodies of the two
// public-body routes (/v1/auth/refresh and /webhooks/revenuecat).
//
// Every iteration replays from its seed (mix(STRESS_SEED, campaign, i)) and
// owns a distinct client IP so iterations never share a budget. The rows are
// written to $STRESS_OUT/handler_seeds.json.
//
//   STRESS_ITER   iterations for the generated campaign (default 200)
//   STRESS_SEED   master seed (default 20260905)
//   STRESS_REPLAY replay one iteration seed (decimal)
//   STRESS_OUT    directory for handler_seeds.json
//
// Invariants (asserted on every row):
//   - the handler never throws and never answers 5xx for malformed input
//     (a 503 is allowed ONLY for a well-formed bearer whose upstream
//     verification the stub does not implement — recorded, not counted as
//     malformed-input failure — and it must be the generic retryable body);
//   - every non-2xx JSON body is the typed envelope {"error":{"message":..}}
//     (plus "code" where the route emits one) without the input echoed;
//   - a 429 carries Retry-After (integer, 1..window), RateLimit-Limit,
//     RateLimit-Remaining: 0, Cache-Control: no-store;
//   - a rejected request performs NO upstream write (no POST/PATCH/DELETE
//     to the stubbed PostgREST) and, for garbage bearers / bad webhook
//     secrets / non-string refresh tokens, no upstream call at all;
//   - one access-log line per request, status matching, no request input;
//   - per-IP auth-failure budget: definitive 401s are charged, transient
//     503s are not; 31st garbage bearer from one IP → 429;
//   - public budget: the (limit+1)-th /healthz from one derived IP → 429,
//     a spoofed leading XFF hop shares that budget, a different last hop
//     does not.
//
// Known-defect reproduction (outcome REPRO, never BROKEN; ~0.5 s): a
// client presenting >= 20 000 distinct last XFF hops through the real handler
// fills rateLimit.ts' memory map and `windows.clear()` un-blocks EVERY limited
// client on the isolate — the same defect rateLimit.test.ts pins at module
// level, observed here end to end (429 → 200 for a victim IP).

import { assert, assertEquals } from "./harness.ts";
import { loadHarness, WEBHOOK_SECRET } from "./routesHarness.ts";
import { type AccessLogEntry, captureAccessLog } from "../http.ts";

const STRESS_ITER = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "200") || 200);
const STRESS_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260905") || 20260905;
const STRESS_REPLAY = Deno.env.get("STRESS_REPLAY") ?? "";
const STRESS_OUT = Deno.env.get("STRESS_OUT") ?? "";

// ─── seeded RNG (same mulberry32 as the module-level file) ─────────────────

function mix(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── generators ─────────────────────────────────────────────────────────────

/** Header values are ByteStrings: 0x09, 0x20–0x7E, 0x80–0xFF. */
const HEADER_ALPHABET = (() => {
  const chars: string[] = ["\t"];
  for (let c = 0x20; c <= 0x7e; c += 1) chars.push(String.fromCharCode(c));
  for (let c = 0x80; c <= 0xff; c += 1) chars.push(String.fromCharCode(c));
  return chars;
})();

function headerNoise(rng: Rng, length: number, noComma = true): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += rng.pick(HEADER_ALPHABET);
  return noComma ? out.replace(/,/g, ";") : out;
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** XFF shapes whose LAST non-empty hop is `ip` (so the budget is `ip`). */
function xffFor(rng: Rng, ip: string): { value: string; kind: string } {
  const kind = rng.pick([
    "plain",
    "spoofed-leading-hops",
    "trailing-commas",
    "empty-hops",
    "whitespace-padded",
    "garbage-hop-then-ip",
    "huge-leading-hop-64k",
    "many-hops-2k",
  ]);
  switch (kind) {
    case "plain":
      return { value: ip, kind };
    case "spoofed-leading-hops":
      return {
        value: `${rng.int(1, 255)}.${rng.int(0, 255)}.0.1, 10.0.0.${rng.int(0, 255)}, ${ip}`,
        kind,
      };
    case "trailing-commas":
      return { value: `${ip},,,`, kind };
    case "empty-hops":
      return { value: `, , ${ip}, ,`, kind };
    case "whitespace-padded":
      return { value: `\t  ${ip}  \t`, kind };
    case "garbage-hop-then-ip":
      return { value: `${headerNoise(rng, rng.int(1, 40))}, ${ip}`, kind };
    case "huge-leading-hop-64k":
      return { value: `${"z".repeat(65_536)}, ${ip}`, kind };
    case "many-hops-2k":
      return {
        value: `${Array.from({ length: 2_000 }, (_, i) => `10.1.${i % 256}.1`).join(",")},${ip}`,
        kind,
      };
    default:
      return { value: ip, kind };
  }
}

interface BearerCase {
  value: string;
  kind: string;
  /** What authenticate() must do with it, from index.ts: */
  expect: "401-no-upstream" | "401-or-503" | "survive";
}

function genBearer(rng: Rng): BearerCase {
  const kind = rng.pick([
    "empty",
    "no-bearer-prefix",
    "bearer-only",
    "bearer-garbage",
    "bearer-64k",
    "two-segments",
    "four-segments",
    "payload-not-base64",
    "payload-not-json",
    "payload-array",
    "payload-null",
    "payload-iss-number",
    "payload-iss-unknown",
    "payload-iss-lookalike-supabase",
    "payload-iss-empty",
    "payload-exp-string",
    "payload-exp-nan-literal",
    "payload-exp-negative",
    "payload-exp-huge",
    "payload-exp-past-google",
    "payload-exp-past-supabase",
    "payload-proto-pollution",
    "payload-supabase-iss-no-sub",
    "payload-supabase-iss-huge-sub",
    "lowercase-bearer",
    "basic-auth",
  ]);
  const jwt = (payload: unknown, header = { alg: "RS256", typ: "JWT" }): string =>
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
  const past = Math.floor(Date.now() / 1000) - 60;
  const future = Math.floor(Date.now() / 1000) + 3600;
  const supabaseIss = "http://supabase.test/auth/v1";
  switch (kind) {
    case "empty":
      return { value: "", kind, expect: "401-no-upstream" };
    case "no-bearer-prefix":
      return {
        value: headerNoise(rng, rng.int(1, 64)),
        kind,
        expect: "401-no-upstream",
      };
    case "bearer-only":
      return {
        value: rng.pick(["Bearer", "Bearer ", "Bearer   "]),
        kind,
        expect: "401-no-upstream",
      };
    case "bearer-garbage":
      return {
        value: `Bearer ${headerNoise(rng, rng.int(1, 200))}`,
        kind,
        expect: "401-no-upstream",
      };
    case "bearer-64k":
      return {
        value: `Bearer ${"A".repeat(65_536 + rng.int(0, 64))}`,
        kind,
        expect: "401-no-upstream",
      };
    case "two-segments":
      return {
        value: `Bearer ${b64url("{}")}.${b64url("{}")}`,
        kind,
        expect: "401-no-upstream",
      };
    case "four-segments":
      return {
        value: `Bearer a.${b64url('{"iss":"https://accounts.google.com"}')}.c.d`,
        kind,
        expect: "401-or-503",
      };
    case "payload-not-base64":
      return {
        value: `Bearer aaa.!!!not-base64!!!.sig`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-not-json":
      return {
        value: `Bearer aaa.${b64url("{not json")}.sig`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-array":
      return {
        value: `Bearer aaa.${b64url("[1,2,3]")}.sig`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-null":
      return {
        value: `Bearer aaa.${b64url("null")}.sig`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-iss-number":
      return {
        value: `Bearer ${jwt({ iss: 12345, exp: future })}`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-iss-unknown":
      return {
        value: `Bearer ${jwt({
          iss: rng.pick([
            "https://evil.example",
            "accounts.google.com.evil",
            "https://appleid.apple.com.evil/",
            "https://accounts.google.com/",
            "",
          ]),
          exp: future,
        })}`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-iss-lookalike-supabase":
      // authenticate() routes ANY iss ending in "/auth/v1" to getUser(); the
      // stub has no /auth/v1/user, so this is the transient-outage (503) path.
      return {
        value: `Bearer ${jwt({
          iss: rng.pick(["../../auth/v1", "http://evil.example/auth/v1", "/auth/v1"]),
          exp: future,
        })}`,
        kind,
        expect: "401-or-503",
      };
    case "payload-iss-empty":
      return {
        value: `Bearer ${jwt({ iss: "", exp: future })}`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-exp-string":
      // A non-numeric exp skips the local expiry pre-check; the stubbed
      // Supabase Auth then accepts the token, so the request proceeds into a
      // route whose DB stub is empty — only the common invariants apply.
      return {
        value: `Bearer ${jwt({ iss: "https://accounts.google.com", exp: "never" })}`,
        kind,
        expect: "survive",
      };
    case "payload-exp-nan-literal":
      return {
        value: `Bearer aaa.${b64url('{"iss":"https://accounts.google.com","exp":NaN}')}.sig`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-exp-negative":
      return {
        value: `Bearer ${jwt({ iss: "https://accounts.google.com", exp: -1 })}`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-exp-huge":
      return {
        value: `Bearer ${jwt({ iss: supabaseIss, exp: 1e308 })}`,
        kind,
        expect: "401-or-503",
      };
    case "payload-exp-past-google":
      return {
        value: `Bearer ${jwt({ iss: "https://accounts.google.com", exp: past })}`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-exp-past-supabase":
      return {
        value: `Bearer ${jwt({ iss: supabaseIss, exp: past, sub: "x" })}`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-proto-pollution":
      return {
        value: `Bearer aaa.${b64url(
          '{"__proto__":{"iss":"https://accounts.google.com"},"constructor":{"prototype":{"exp":1}}}',
        )}.sig`,
        kind,
        expect: "401-no-upstream",
      };
    case "payload-supabase-iss-no-sub":
      return {
        value: `Bearer ${jwt({ iss: supabaseIss, exp: future })}`,
        kind,
        expect: "401-or-503",
      };
    case "payload-supabase-iss-huge-sub":
      return {
        value: `Bearer ${jwt({
          iss: supabaseIss,
          exp: future,
          sub: "s".repeat(4_096),
          session_id: "\u0000",
        })}`,
        kind,
        expect: "401-or-503",
      };
    case "lowercase-bearer":
      return {
        value: `bearer ${jwt({ iss: "https://accounts.google.com", exp: future })}`,
        kind,
        expect: "401-no-upstream",
      };
    case "basic-auth":
      return {
        value: `Basic ${b64url("user:pass")}`,
        kind,
        expect: "401-no-upstream",
      };
    default:
      return { value: "", kind, expect: "401-no-upstream" };
  }
}

interface BodyCase {
  raw: string;
  kind: string;
  /** true when index.ts must treat it as "refreshToken is a non-empty string". */
  validRefresh: boolean;
}

function genBody(rng: Rng): BodyCase {
  const kind = rng.pick([
    "empty",
    "truncated-object",
    "truncated-string",
    "trailing-garbage",
    "not-json",
    "json-null",
    "json-number",
    "json-string",
    "json-array",
    "json-empty-object",
    "json-empty-array",
    "refresh-number",
    "refresh-null",
    "refresh-bool",
    "refresh-array",
    "refresh-object",
    "refresh-empty-string",
    "refresh-whitespace",
    "refresh-nan-literal",
    "refresh-infinity-literal",
    "refresh-neg-zero",
    "refresh-overflow-number",
    "proto-pollution-refresh",
    "constructor-pollution",
    "future-schema-version",
    "duplicate-keys",
    "deep-nesting-100k",
    "refresh-64k",
    "refresh-nul-byte",
    "refresh-unicode-pairs",
    "refresh-valid",
    "bom-prefixed",
  ]);
  switch (kind) {
    case "empty":
      return { raw: "", kind, validRefresh: false };
    case "truncated-object":
      return { raw: '{"refreshToken":"abc', kind, validRefresh: false };
    case "truncated-string":
      return { raw: '{"refreshToken', kind, validRefresh: false };
    case "trailing-garbage":
      return { raw: '{"refreshToken":"abc"}}}}', kind, validRefresh: false };
    case "not-json":
      return {
        raw: headerNoise(rng, rng.int(1, 200), false),
        kind,
        validRefresh: false,
      };
    case "json-null":
      return { raw: "null", kind, validRefresh: false };
    case "json-number":
      return {
        raw: rng.pick(["0", "-0", "1e999", "9007199254740993"]),
        kind,
        validRefresh: false,
      };
    case "json-string":
      return { raw: '"just a string"', kind, validRefresh: false };
    case "json-array":
      return { raw: '[{"refreshToken":"abc"}]', kind, validRefresh: false };
    case "json-empty-object":
      return { raw: "{}", kind, validRefresh: false };
    case "json-empty-array":
      return { raw: "[]", kind, validRefresh: false };
    case "refresh-number":
      return {
        raw: `{"refreshToken":${rng.int(0, 1e9)}}`,
        kind,
        validRefresh: false,
      };
    case "refresh-null":
      return { raw: '{"refreshToken":null}', kind, validRefresh: false };
    case "refresh-bool":
      return { raw: '{"refreshToken":true}', kind, validRefresh: false };
    case "refresh-array":
      return { raw: '{"refreshToken":["abc"]}', kind, validRefresh: false };
    case "refresh-object":
      return {
        raw: '{"refreshToken":{"toString":"abc"}}',
        kind,
        validRefresh: false,
      };
    case "refresh-empty-string":
      return { raw: '{"refreshToken":""}', kind, validRefresh: false };
    case "refresh-whitespace":
      return { raw: '{"refreshToken":" \\t\\n "}', kind, validRefresh: false };
    case "refresh-nan-literal":
      return { raw: '{"refreshToken":NaN}', kind, validRefresh: false };
    case "refresh-infinity-literal":
      return { raw: '{"refreshToken":-Infinity}', kind, validRefresh: false };
    case "refresh-neg-zero":
      return { raw: '{"refreshToken":-0}', kind, validRefresh: false };
    case "refresh-overflow-number":
      return { raw: '{"refreshToken":1e999999}', kind, validRefresh: false };
    case "proto-pollution-refresh":
      return {
        raw: '{"__proto__":{"refreshToken":"abc"}}',
        kind,
        validRefresh: false,
      };
    case "constructor-pollution":
      return {
        raw: '{"constructor":{"prototype":{"refreshToken":"abc"}}}',
        kind,
        validRefresh: false,
      };
    case "future-schema-version":
      return {
        raw: `{"schemaVersion":${rng.int(2, 99)},"session":{"refreshToken":"abc"}}`,
        kind,
        validRefresh: false,
      };
    case "duplicate-keys":
      return {
        raw: '{"refreshToken":"first","refreshToken":""}',
        kind,
        validRefresh: false,
      };
    case "deep-nesting-100k":
      return { raw: "[".repeat(100_000), kind, validRefresh: false };
    case "refresh-64k":
      return {
        raw: JSON.stringify({
          refreshToken: "r".repeat(65_536 + rng.int(0, 64)),
        }),
        kind,
        validRefresh: true,
      };
    case "refresh-nul-byte":
      return {
        raw: '{"refreshToken":"abc\\u0000def"}',
        kind,
        validRefresh: true,
      };
    case "refresh-unicode-pairs":
      return {
        raw: JSON.stringify({
          refreshToken: rng.pick(["caf\u00e9", "cafe\u0301", "\u{1F468}\u200D\u{1F469}"]),
        }),
        kind,
        validRefresh: true,
      };
    case "refresh-valid":
      return {
        raw: JSON.stringify({ refreshToken: `tok-${rng.int(0, 1e9)}` }),
        kind,
        validRefresh: true,
      };
    case "bom-prefixed":
      // request.text() decodes UTF-8 with BOM stripping, so this IS valid JSON.
      return { raw: '\ufeff{"refreshToken":"abc"}', kind, validRefresh: true };
    default:
      return { raw: "", kind, validRefresh: false };
  }
}

function genPath(rng: Rng): { path: string; kind: string } {
  const kind = rng.pick([
    "traversal-dotdot",
    "traversal-encoded",
    "traversal-backslash",
    "double-v1",
    "nul-encoded",
    "unicode-encoded",
    "malformed-percent",
    "long-4k",
    "long-64k",
    "empty-segments",
    "query-only",
    "fragment",
    "known-route-case",
    "trailing-slash",
    "id-nan",
    "id-overflow",
    "id-neg-zero",
    "id-proto",
  ]);
  switch (kind) {
    case "traversal-dotdot":
      return { path: "/v1/../../etc/passwd", kind };
    case "traversal-encoded":
      return { path: "/v1/%2e%2e/%2e%2e/me", kind };
    case "traversal-backslash":
      return { path: "/v1/..\\..\\me", kind };
    case "double-v1":
      return { path: "/v1/me/v1/me", kind };
    case "nul-encoded":
      return { path: "/v1/me%00", kind };
    case "unicode-encoded":
      return { path: "/v1/%E2%80%AEme", kind };
    case "malformed-percent":
      return { path: `/v1/shots/%ff%${rng.int(0, 9)}`, kind };
    case "long-4k":
      return { path: `/v1/${"a".repeat(4_096)}`, kind };
    case "long-64k":
      return { path: `/v1/${"b".repeat(65_536)}`, kind };
    case "empty-segments":
      return { path: "/v1//me//", kind };
    case "query-only":
      return { path: "/v1/me?__proto__[x]=1&a=%00", kind };
    case "fragment":
      return { path: "/v1/me#../../", kind };
    case "known-route-case":
      return { path: "/V1/ME", kind };
    case "trailing-slash":
      return { path: "/v1/me/", kind };
    case "id-nan":
      return { path: "/v1/shots/NaN", kind };
    case "id-overflow":
      return { path: "/v1/shots/99999999999999999999999", kind };
    case "id-neg-zero":
      return { path: "/v1/sessions/-0/end", kind };
    case "id-proto":
      return { path: "/v1/shots/__proto__", kind };
    default:
      return { path: "/v1/me", kind };
  }
}

function genContentLength(rng: Rng): { value: string; expect413: boolean } {
  const kind = rng.pick([
    "nan-text",
    "negative",
    "float",
    "exp-notation-huge",
    "exactly-max",
    "max-plus-one",
    "hex",
    "empty",
    "spaces",
    "huge-digits",
  ]);
  switch (kind) {
    case "nan-text":
      return { value: "abc", expect413: false };
    case "negative":
      return { value: "-1", expect413: false };
    case "float":
      return { value: "12.5", expect413: false };
    case "exp-notation-huge":
      return { value: "1e999", expect413: false }; // Infinity → not finite → not 413 at the header check
    case "exactly-max":
      return { value: "5000000", expect413: false };
    case "max-plus-one":
      return { value: "5000001", expect413: true };
    case "hex":
      return { value: "0x10", expect413: false };
    case "empty":
      return { value: "", expect413: false };
    case "spaces":
      return { value: "  42  ", expect413: false };
    case "huge-digits":
      // Number("999…") is Infinity → the header check is skipped and the
      // byte counter in readBoundedText guards the actual (small) body.
      return { value: "9".repeat(400), expect413: false };
    default:
      return { value: "0", expect413: false };
  }
}

// ─── recording ──────────────────────────────────────────────────────────────

interface Row {
  campaign: string;
  iter: number;
  seed: number;
  kind: string;
  params: Record<string, unknown>;
  status: number | null;
  code: string | null;
  outcome: "HELD" | "BROKEN" | "REPRO";
  detail: string;
}
const rows: Row[] = [];
let executed = 0;

class Check {
  failures: string[] = [];
  that(cond: unknown, msg: string): void {
    if (!cond) this.failures.push(msg);
  }
  eq(actual: unknown, expected: unknown, msg: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) this.failures.push(`${msg}: expected ${e}, got ${a}`);
  }
}

function preview(value: string): string {
  return value.length > 60
    ? `${JSON.stringify(value.slice(0, 48))}…(len ${value.length})`
    : JSON.stringify(value);
}

function iterSeeds(campaign: number, count: number): Array<{ iter: number; seed: number }> {
  if (STRESS_REPLAY) return [{ iter: -1, seed: Number(STRESS_REPLAY) >>> 0 }];
  const out: Array<{ iter: number; seed: number }> = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ iter: i, seed: mix(STRESS_SEED, campaign, i) });
  }
  return out;
}

const logLines: AccessLogEntry[] = [];
let restoreLog: (() => void) | null = null;
const errors: string[] = [];
const realConsoleError = console.error;
function hookLogging(): void {
  logLines.length = 0;
  errors.length = 0;
  restoreLog = captureAccessLog((line) => logLines.push(JSON.parse(line) as AccessLogEntry));
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
}
function unhookLogging(): void {
  restoreLog?.();
  restoreLog = null;
  console.error = realConsoleError;
}

interface Observed {
  status: number;
  code: string | null;
  message: string | null;
  bodyText: string;
  headers: Record<string, string>;
  threw: string | null;
  upstreamCalls: Array<{ method: string; url: string }>;
  writes: number;
  logged: AccessLogEntry | undefined;
  errorLines: number;
}

async function fire(
  harness: Awaited<ReturnType<typeof loadHarness>>,
  request: Request,
): Promise<Observed> {
  const callsBefore = harness.calls.length;
  const logsBefore = logLines.length;
  const errorsBefore = errors.length;
  let response: Response | null = null;
  let threw: string | null = null;
  try {
    response = await harness.handler(request);
  } catch (error) {
    threw = String(error).slice(0, 300);
  }
  const bodyText = response ? await response.text().catch(() => "<unreadable>") : "";
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(bodyText);
    code = typeof parsed?.error?.code === "string" ? parsed.error.code : null;
    message = typeof parsed?.error?.message === "string" ? parsed.error.message : null;
  } catch {
    // non-JSON body (legal text) or empty
  }
  const headers: Record<string, string> = {};
  response?.headers.forEach((v, k) => (headers[k] = v));
  const upstream = harness.calls.slice(callsBefore).map((c) => ({
    method: c.method,
    url: c.url,
  }));
  const writes = upstream.filter(
    (c) => c.url.includes("/rest/v1/") && ["POST", "PATCH", "PUT", "DELETE"].includes(c.method),
  ).length;
  executed += 1;
  return {
    status: response?.status ?? 0,
    code,
    message,
    bodyText,
    headers,
    threw,
    upstreamCalls: upstream,
    writes,
    logged: logLines.slice(logsBefore).find((l) => l.evt === "api_request"),
    errorLines: errors.length - errorsBefore,
  };
}

function commonInvariants(check: Check, o: Observed, inputs: string[]): void {
  check.that(o.threw === null, `handler threw: ${o.threw}`);
  check.that(o.status !== 0, "a Response was returned");
  check.that(o.status !== 500, `500 for malformed input: ${o.bodyText.slice(0, 120)}`);
  check.that(o.status < 500 || o.status === 503, `unexpected ${o.status}`);
  if (o.status === 503) {
    check.that(
      !/stack|Error:|\n {4}at |TypeError|SyntaxError/.test(o.bodyText),
      "503 body is generic",
    );
    check.that(
      o.message !== null && o.message.includes("temporarily unavailable"),
      "503 is the retryable envelope",
    );
  }
  if (o.status >= 400 && o.headers["content-type"]?.includes("json")) {
    check.that(o.message !== null, `typed error envelope: ${o.bodyText.slice(0, 120)}`);
    check.eq(o.headers["cache-control"], "no-store", "error responses are no-store");
  }
  check.that(o.logged !== undefined, "one access-log line per request");
  if (o.logged) {
    check.eq(o.logged.status, o.status, "access log status matches");
    for (const input of inputs) {
      if (input.length >= 8) {
        check.that(!JSON.stringify(o.logged).includes(input), "log never carries input");
      }
    }
  }
  check.that(Boolean(o.headers["x-request-id"]), "x-request-id present");
  for (const input of inputs) {
    if (input.length >= 8 && o.status !== 404) {
      check.that(!o.bodyText.includes(input), `body echoes input ${preview(input)}`);
    }
  }
  if (o.status >= 400 && o.status !== 503) {
    check.eq(o.writes, 0, "rejected request performed a write");
  }
  if (o.status === 429) {
    const retry = Number(o.headers["retry-after"]);
    check.that(
      Number.isInteger(retry) && retry >= 1 && retry <= 3_600,
      `Retry-After ${o.headers["retry-after"]}`,
    );
    check.that(Boolean(o.headers["ratelimit-limit"]), "RateLimit-Limit on 429");
    check.eq(o.headers["ratelimit-remaining"], "0", "RateLimit-Remaining 0 on 429");
    check.eq(o.code, "rate_limited", "429 code");
  }
}

function record(
  campaign: string,
  iter: number,
  seed: number,
  kind: string,
  params: Record<string, unknown>,
  o: Observed | null,
  check: Check,
): void {
  rows.push({
    campaign,
    iter,
    seed,
    kind,
    params,
    status: o?.status ?? null,
    code: o?.code ?? null,
    outcome: check.failures.length ? "BROKEN" : "HELD",
    detail: check.failures.join(" | "),
  });
}

function assertNoneBroken(campaign: string): void {
  const broken = rows.filter((r) => r.campaign === campaign && r.outcome === "BROKEN");
  assert(
    broken.length === 0,
    `${campaign}: ${broken.length} BROKEN; first seed=${broken[0]?.seed} kind=${
      broken[0]?.kind
    } ${broken[0]?.detail}`,
  );
}

const BASE = "http://edge.test/functions/v1/api";

function build(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Request | string {
  try {
    return new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : body,
    });
  } catch (error) {
    return String(error).slice(0, 200);
  }
}

// ─── campaign 1: mixed hostile requests, one distinct IP per iteration ──────

Deno.test("[stress] real handler: hostile pre-auth inputs are rejected gracefully", async () => {
  const campaign = "handler-hostile-inputs";
  const harness = await loadHarness();
  hookLogging();
  try {
    for (const { iter, seed } of iterSeeds(11, STRESS_ITER)) {
      const rng = new Rng(seed);
      const ip =
        iter >= 0
          ? `198.51.${(iter >> 8) & 255}.${iter & 255}`
          : `198.52.${(seed >> 8) & 255}.${seed & 255}`;
      const xff = xffFor(rng, ip);
      const family = rng.pick([
        "bearer",
        "refresh-body",
        "path",
        "content-length",
        "webhook",
        "request-id",
      ] as const);
      const check = new Check();
      const headers: Record<string, string> = { "x-forwarded-for": xff.value };
      if (rng.chance(0.2)) headers["cf-connecting-ip"] = `${ip}`;
      let params: Record<string, unknown> = { ip, xff: xff.kind };
      let kind = family;
      let observed: Observed | null = null;
      switch (family) {
        case "bearer": {
          const bearer = genBearer(rng);
          kind = `bearer:${bearer.kind}`;
          params = {
            ...params,
            authorization: preview(bearer.value),
            expect: bearer.expect,
          };
          headers.Authorization = bearer.value;
          const req = build("GET", "/v1/me", headers);
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          observed = await fire(harness, req);
          commonInvariants(check, observed, [bearer.value]);
          if (bearer.expect === "401-no-upstream") {
            check.eq(observed.status, 401, "garbage bearer → 401");
            check.eq(observed.upstreamCalls.length, 0, "garbage bearer never reaches upstream");
          } else if (bearer.expect === "401-or-503") {
            check.that(
              [401, 503].includes(observed.status),
              `well-formed-but-unverifiable bearer → 401/503, got ${observed.status}`,
            );
          }
          break;
        }
        case "refresh-body": {
          const body = genBody(rng);
          kind = `refresh:${body.kind}`;
          params = {
            ...params,
            body: preview(body.raw),
            validRefresh: body.validRefresh,
          };
          headers["Content-Type"] = rng.pick([
            "application/json",
            "text/plain",
            "application/x-www-form-urlencoded",
            "application/json; charset=utf-16",
          ]);
          const req = build("POST", "/v1/auth/refresh", headers, body.raw);
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          observed = await fire(harness, req);
          commonInvariants(check, observed, [body.raw]);
          if (body.validRefresh) {
            check.that(
              [200, 401, 503].includes(observed.status),
              `string refreshToken → 200/401/503, got ${observed.status}`,
            );
          } else {
            check.eq(observed.status, 400, "malformed refresh body → 400");
            check.eq(observed.code, "validation.refresh", "typed validation code");
            check.eq(
              observed.upstreamCalls.length,
              0,
              "malformed body never reaches Supabase Auth",
            );
          }
          break;
        }
        case "path": {
          const p = genPath(rng);
          kind = `path:${p.kind}`;
          params = { ...params, path: preview(p.path) };
          headers.Authorization = `Bearer ${headerNoise(rng, 12)}`;
          const req = build(
            rng.pick(["GET", "POST", "DELETE", "OPTIONS", "PATCH", "PUT"]),
            p.path,
            headers,
            undefined,
          );
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          observed = await fire(harness, req);
          commonInvariants(check, observed, []);
          check.that(
            [400, 401, 404, 405].includes(observed.status),
            `hostile path pre-auth → 4xx, got ${observed.status}`,
          );
          check.eq(observed.upstreamCalls.length, 0, "hostile path never reaches upstream");
          break;
        }
        case "content-length": {
          const cl = genContentLength(rng);
          kind = `content-length:${JSON.stringify(cl.value).slice(0, 20)}`;
          params = {
            ...params,
            contentLength: preview(cl.value),
            expect413: cl.expect413,
          };
          headers["content-length"] = cl.value;
          headers.Authorization = "Bearer nope";
          const req = build("POST", "/v1/auth/refresh", headers, '{"refreshToken":"abc"}');
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          observed = await fire(harness, req);
          commonInvariants(check, observed, []);
          if (cl.expect413) {
            check.eq(observed.status, 413, "declared oversize → 413 before any work");
            check.eq(observed.upstreamCalls.length, 0, "413 never reaches upstream");
          } else {
            check.that(
              [200, 400, 401, 413, 503].includes(observed.status),
              `non-numeric Content-Length → handled, got ${observed.status}`,
            );
          }
          break;
        }
        case "webhook": {
          const badSecret = rng.chance(0.6);
          const body = genBody(rng);
          kind = `webhook:${badSecret ? "bad-secret" : "good-secret"}:${body.kind}`;
          const secret = badSecret
            ? rng.pick([
                "",
                "Bearer x",
                WEBHOOK_SECRET.slice(0, -1),
                `${WEBHOOK_SECRET}\u00a0`,
                `Bearer ${WEBHOOK_SECRET}`,
                WEBHOOK_SECRET.toUpperCase(),
                headerNoise(rng, WEBHOOK_SECRET.length),
              ])
            : WEBHOOK_SECRET;
          params = {
            ...params,
            secret: badSecret ? preview(secret) : "<correct>",
            body: preview(body.raw),
          };
          headers.Authorization = secret;
          headers["Content-Type"] = "application/json";
          const req = build("POST", "/webhooks/revenuecat", headers, body.raw);
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          observed = await fire(harness, req);
          commonInvariants(check, observed, [body.raw]);
          if (badSecret) {
            check.eq(observed.status, 401, "wrong webhook secret → 401");
            check.eq(observed.upstreamCalls.length, 0, "wrong secret never reaches upstream");
          } else {
            // None of the generated bodies carries a record `event`, so the
            // handler must stop at validation without touching Postgres.
            check.eq(observed.status, 400, "well-authenticated malformed webhook → 400");
            check.eq(
              observed.upstreamCalls.length,
              0,
              "malformed webhook body never reaches Postgres/RevenueCat",
            );
          }
          break;
        }
        case "request-id": {
          const rid = rng.pick([
            headerNoise(rng, rng.int(1, 200)),
            "a".repeat(65),
            "short",
            "../../etc",
            "ok-request-id-1234",
            "\t\t",
            "%00%00%00%00%00%00%00%00",
          ]);
          kind = `request-id:${preview(rid).slice(0, 24)}`;
          params = { ...params, requestId: preview(rid) };
          headers["x-request-id"] = rid;
          headers.Authorization = "Bearer nope";
          const req = build("GET", "/v1/me", headers);
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          observed = await fire(harness, req);
          commonInvariants(check, observed, []);
          const echoed = observed.headers["x-request-id"] ?? "";
          const wellFormed = /^[A-Za-z0-9._-]{8,64}$/.test(rid.trim());
          if (wellFormed) {
            check.eq(echoed, rid.trim(), "well-formed request id honoured");
          } else {
            check.that(
              echoed !== rid && /^[A-Za-z0-9._-]{8,64}$/.test(echoed),
              "malformed request id replaced by a minted one",
            );
          }
          break;
        }
      }
      record(campaign, iter, seed, kind, params, observed, check);
    }
  } finally {
    unhookLogging();
  }
  assertNoneBroken(campaign);
});

// ─── campaign 2: auth-failure accounting through the real handler ───────────

Deno.test(
  "[stress] real handler: 30 garbage bearers are charged, the 31st is 429; 503s are free",
  async () => {
    const campaign = "handler-authfail-accounting";
    const harness = await loadHarness();
    hookLogging();
    try {
      const count = Math.max(2, Math.min(30, Math.ceil(STRESS_ITER / 20)));
      for (const { iter, seed } of iterSeeds(12, count)) {
        const rng = new Rng(seed);
        const ip = `198.53.${(iter >> 8) & 255}.${iter & 255}`;
        const check = new Check();
        let last: Observed | null = null;
        for (let k = 1; k <= 31; k += 1) {
          const bearer = (() => {
            for (;;) {
              const b = genBearer(rng);
              if (b.expect === "401-no-upstream" && b.kind !== "empty" && b.kind !== "bearer-64k")
                return b;
            }
          })();
          const xff = xffFor(rng, ip);
          const req = build("GET", "/v1/me", {
            "x-forwarded-for": xff.value,
            Authorization: bearer.value,
          });
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          last = await fire(harness, req);
          commonInvariants(check, last, [bearer.value]);
          if (k <= 30) {
            check.eq(last.status, 401, `garbage bearer #${k} → 401 (${bearer.kind})`);
          } else {
            check.eq(last.status, 429, `garbage bearer #${k} → 429`);
            check.eq(last.headers["ratelimit-limit"], "30", "auth-failure limit advertised");
            const retry = Number(last.headers["retry-after"]);
            check.that(retry >= 1 && retry <= 300, `Retry-After ${retry} within the 300 s window`);
            check.eq(last.upstreamCalls.length, 0, "tripped IP never reaches upstream");
          }
        }
        // A spoofed leading hop does not escape the tripped budget.
        const spoofed = build("GET", "/v1/me", {
          "x-forwarded-for": `${rng.int(1, 255)}.2.3.4, ${ip}`,
          Authorization: "Bearer still-garbage",
        });
        if (typeof spoofed !== "string") {
          const o = await fire(harness, spoofed);
          commonInvariants(check, o, []);
          check.eq(o.status, 429, "spoofed leading hop still 429");
        }
        // A different last hop is a fresh budget.
        const other = build("GET", "/v1/me", {
          "x-forwarded-for": `${ip}, 198.54.0.${iter & 255}`,
          Authorization: "Bearer still-garbage",
        });
        if (typeof other !== "string") {
          const o = await fire(harness, other);
          commonInvariants(check, o, []);
          check.eq(o.status, 401, "different last hop → own budget (401, not 429)");
        }
        record(campaign, iter, seed, "authfail-31", { ip }, last, check);
      }
    } finally {
      unhookLogging();
    }
    assertNoneBroken(campaign);
  },
);

// ─── campaign 3: public-page budget with hostile XFF shapes ──────────────────

Deno.test(
  "[stress] real handler: /healthz budget follows the last XFF hop under hostile header shapes",
  async () => {
    const campaign = "handler-healthz-budget";
    const harness = await loadHarness();
    hookLogging();
    try {
      const count = Math.max(2, Math.min(30, Math.ceil(STRESS_ITER / 20)));
      for (const { iter, seed } of iterSeeds(13, count)) {
        const rng = new Rng(seed);
        const ip = `198.55.${(iter >> 8) & 255}.${iter & 255}`;
        const check = new Check();
        let last: Observed | null = null;
        const startedAt = Date.now();
        for (let k = 1; k <= 61; k += 1) {
          const xff = xffFor(rng, ip);
          const req = build(rng.chance(0.1) ? "HEAD" : "GET", "/healthz", {
            "x-forwarded-for": xff.value,
          });
          if (typeof req === "string") {
            check.that(false, `Request construction failed: ${req}`);
            break;
          }
          last = await fire(harness, req);
          commonInvariants(check, last, []);
          if (k <= 60) {
            check.eq(last.status, 200, `healthz #${k} → 200 (xff ${xff.kind})`);
          } else {
            check.eq(last.status, 429, "healthz #61 → 429");
            check.eq(last.headers["ratelimit-limit"], "60", "public limit advertised");
            const retry = Number(last.headers["retry-after"]);
            const elapsedS = (Date.now() - startedAt) / 1000;
            const expectedRetry = Math.max(
              1,
              Math.ceil((Math.floor(Date.now() / 60_000) + 1) * 60 - Date.now() / 1000),
            );
            check.that(
              Math.abs(retry - expectedRetry) <= 1 + Math.ceil(elapsedS),
              `Retry-After ${retry} ≈ bucket remainder ${expectedRetry}`,
            );
          }
        }
        const other = build("GET", "/healthz", {
          "x-forwarded-for": `${ip}, 198.56.0.${iter & 255}`,
        });
        if (typeof other !== "string") {
          const o = await fire(harness, other);
          commonInvariants(check, o, []);
          check.eq(o.status, 200, "different last hop → own budget");
        }
        record(campaign, iter, seed, "healthz-61", { ip }, last, check);
      }
    } finally {
      unhookLogging();
    }
    assertNoneBroken(campaign);
  },
);

// ─── campaign 4: 20k distinct XFF hops wipe a limited client's window ───────

Deno.test(
  "[stress][defect] real handler: 20 000 distinct XFF hops un-block a 429'd client (memory fallback)",
  async () => {
    const campaign = "handler-xff-wipe";
    const harness = await loadHarness();
    hookLogging();
    try {
      for (const { iter, seed } of iterSeeds(17, 1)) {
        const rng = new Rng(seed);
        const victim = `198.57.${rng.int(0, 255)}.${rng.int(1, 254)}`;
        const check = new Check();
        const hit = async (xff: string): Promise<Observed> => {
          const req = build("GET", "/healthz", { "x-forwarded-for": xff });
          if (typeof req === "string") throw new Error(req);
          const o = await fire(harness, req);
          commonInvariants(check, o, []);
          return o;
        };
        let last: Observed | null = null;
        for (let k = 1; k <= 61; k += 1) last = await hit(victim);
        check.eq(last?.status, 429, "victim exhausted its /healthz budget");
        const before = await hit(victim);
        check.eq(before.status, 429, "victim still 429 before the flood");

        // 20 000 distinct last hops: each lands one "ip" window and one
        // "public" window in the isolate map (>= MEMORY_WINDOW_MAX after 10k).
        const base = rng.int(0, 0x00ff_ffff);
        const floodStatuses = { ok: 0, limited: 0, other: 0 };
        for (let i = 0; i < 20_000; i += 1) {
          const n = (base + i) & 0x00ff_ffff;
          const hop = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
          const spoofed = rng.chance(0.5) ? `${victim}, ${hop}` : hop;
          const o = await hit(spoofed);
          if (o.status === 200) floodStatuses.ok += 1;
          else if (o.status === 429) floodStatuses.limited += 1;
          else floodStatuses.other += 1;
        }
        const after = await hit(victim);
        const reproduced = after.status === 200;
        // The defect is EXPECTED here (pinned by rateLimit.test.ts); a 429 would
        // mean the fallback stopped wiping and this row should be revisited.
        check.eq(reproduced, true, "KNOWN DEFECT: victim is un-blocked by the flood (429 -> 200)");
        const remaining = after.headers["ratelimit-remaining"];
        rows.push({
          campaign,
          iter,
          seed,
          kind: "xff-wipe-20000",
          params: {
            victim,
            floodStatuses,
            victimAfterStatus: after.status,
            victimAfterRemaining: remaining ?? null,
          },
          status: after.status,
          code: after.code,
          outcome: check.failures.length ? "BROKEN" : "REPRO",
          detail: check.failures.length
            ? check.failures.join(" | ")
            : `victim ${victim}: 429 before flood, ${after.status} after 20000 distinct hops (memory map cleared)`,
        });
        console.log(
          `[stress] ${campaign}: seed=${seed} victim=${victim} before=429 after=${after.status} flood=${JSON.stringify(
            floodStatuses,
          )}`,
        );
      }
    } finally {
      unhookLogging();
    }
    assertNoneBroken(campaign);
  },
);

Deno.test("[stress] write handler table", async () => {
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  if (STRESS_OUT) {
    await Deno.mkdir(STRESS_OUT, { recursive: true });
    await Deno.writeTextFile(
      `${STRESS_OUT}/handler_seeds.json`,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          deno: Deno.version,
          env: { STRESS_ITER, STRESS_SEED, STRESS_REPLAY },
          requestsExecuted: executed,
          rows: rows.length,
          held: rows.filter((r) => r.outcome === "HELD").length,
          repro: rows.filter((r) => r.outcome === "REPRO").length,
          broken: broken.length,
          brokenSeeds: broken.map((r) => ({
            campaign: r.campaign,
            seed: r.seed,
            kind: r.kind,
            detail: r.detail,
          })),
          statusHistogram: Object.fromEntries(
            [...new Set(rows.map((r) => String(r.status)))]
              .sort()
              .map((s) => [s, rows.filter((r) => String(r.status) === s).length]),
          ),
          kinds: Object.fromEntries(
            [...new Set(rows.map((r) => r.kind))]
              .sort()
              .map((k) => [k, rows.filter((r) => r.kind === k).length]),
          ),
          table: rows,
        },
        null,
        2,
      ),
    );
  }
  console.log(
    `[stress] handler campaigns: requests=${executed} rows=${rows.length} held=${
      rows.filter((r) => r.outcome === "HELD").length
    } repro=${rows.filter((r) => r.outcome === "REPRO").length} broken=${broken.length}`,
  );
  assertEquals(broken.length, 0);
});
