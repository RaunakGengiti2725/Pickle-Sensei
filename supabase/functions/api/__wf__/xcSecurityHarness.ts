// Cross-cutting security harness (injection & sanitization) — shared helpers.
//
// Builds on edgeHarness.ts (real edge function on :8000, fake Supabase Auth +
// PostgREST). Adds what an adversarial run needs and the router tests do not:
//
//   * a console + access-log tap so every log line the function emits during
//     a scenario can be searched for user-controlled canaries;
//   * an outbound-fetch tap that records every non-loopback URL the function
//     tries to reach and answers it locally (no egress) — the SSRF matrix;
//   * a seeded PRNG + hostile-value generators so every failure is replayable
//     from (seed, index);
//   * a JSON artifact writer (XC_SEC_ARTIFACT_DIR) so raw scenario tables,
//     heap numbers and log captures land on disk for upload.
//
// Nothing here touches production code, existing tests, or the hosted project.

import { captureAccessLog } from "../http.ts";
import {
  API_BASE,
  authedInit,
  recorded,
  type RecordedRequest,
  restJson,
  setRestResponder,
  USER_ID,
  wantsSingleObject,
} from "./edgeHarness.ts";

export const CANARY_PREFIX = "XCSEC_CANARY_";

/** Strict mode turns every documented-contract expectation that the current
 * revision does NOT meet into a hard assertion (the regression test a fix
 * should make green). Default mode records those as `observations` in the
 * artifacts and only asserts the hard containment properties, so the harness
 * can sit in the suite before the findings are addressed. */
export const STRICT = Deno.env.get("XC_SEC_STRICT") === "1";
export const observations: Array<{ test: string; expectation: string; detail: unknown }> = [];
export function expectContract(
  test: string,
  holds: boolean,
  expectation: string,
  detail: unknown = null,
): void {
  if (holds) return;
  observations.push({ test, expectation, detail });
  if (STRICT) throw new Error(`[XC_SEC_STRICT] ${test}: ${expectation} — ${safeJson(detail)}`);
}

// ─── virtual clock ──────────────────────────────────────────────────────────
//
// The function's rate limiter (rateLimit.ts) buckets on Date.now(). The
// per-user shots:sync budget is 30/min and the general budget 240/min — a
// 5000-shot adversarial run would trip them in a single wall-clock minute
// without saying anything about injection handling. Advancing Date.now()
// between requests moves every limiter into a fresh bucket while leaving the
// function's logic untouched (tokens are minted per request from the same
// clock, so nothing expires unexpectedly).

const realNow = Date.now.bind(Date);
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;

export function advanceClock(ms = 61_000): void {
  clockOffsetMs += ms;
}

export function clockOffset(): number {
  return clockOffsetMs;
}

// ─── seeded PRNG (mulberry32; same family as be-edge-routes-shots-rank) ─────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

// ─── hostile value corpora ─────────────────────────────────────────────────

/** Strings that must never be interpreted by SQL, JSON, a log parser, or a
 * shell when they arrive inside a jsonb payload or a text column. */
export const SQL_META_STRINGS: readonly string[] = [
  "'; drop table public.shots; --",
  '" or 1=1 --',
  "') ; select pg_sleep(5); --",
  "$$ ; do $$ begin raise exception 'x'; end $$",
  "dink'||(select current_user)||'",
  "dink\\'; --",
  '{"a":1}',
  "[1,2,3]",
  "null",
  "true",
  "1e309",
  "-0",
  "0x41",
  "%00",
  "\\u0000",
  "\u0000",
  "dink\u0000x",
  "\u202eknid",
  "\u200bdink\u200b",
  "\ud800", // lone surrogate
  'dink\r\n{"evt":"api_request","status":500}',
  "dink\n[api] forged log line",
  "\x1b[31mred\x1b[0m",
  "../../etc/passwd",
  "..%2f..%2fetc%2fpasswd",
  "http://169.254.169.254/latest/meta-data/",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "a".repeat(64),
  "a".repeat(65),
  "💥".repeat(32), // 64 UTF-16 units, 32 code points
  "💥".repeat(33), // 66 UTF-16 units
  "é".repeat(64),
  "e\u0301".repeat(32), // combining marks
  " ",
  "\t\n",
  "",
];

/** capturedAt candidates: things the edge accepts (Date.parse) that Postgres
 * timestamptz may not, plus outright garbage and boundary values. */
export const DATE_STRINGS: readonly string[] = [
  "2026-09-04T00:00:00.000Z",
  "Thu Jan 01 2026 00:00:00 GMT+0000 (XCSEC_CANARY_DATE_COMMENT)",
  "9/4/2026",
  "Sep 4 2026",
  "2026-09-04 12:00:00 (XCSEC_CANARY_PAREN)",
  "(XCSEC_CANARY_LEAD) Jan 1 2026",
  "0000-01-01T00:00:00Z",
  "-000001-01-01T00:00:00Z",
  "+275760-09-13T00:00:00.000Z",
  "-271821-04-20T00:00:00.000Z",
  "2026-02-30",
  "1",
  "2026",
  "infinity",
  "-infinity",
  "epoch",
  "now",
  "tomorrow",
  "Jan 1 2026 \n\r\t",
  '2026-09-04T00:00:00Z\n{"evt":"api_request"}',
  "",
  "not a date",
  "2026-13-01",
  "Jan 1 2026 (" + "x".repeat(2000) + ")",
];

export const PROTO_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

// ─── console + access-log tap ───────────────────────────────────────────────

export interface LogTap {
  console: Array<{ level: string; line: string }>;
  access: string[];
  stop: () => void;
}

/** Wraps console.{log,info,warn,error} and captures every access-log entry
 * until stop(). Lines are stringified the way Deno would print them. */
export function tapLogs(): LogTap {
  const lines: Array<{ level: string; line: string }> = [];
  const access: string[] = [];
  const con: Console = globalThis.console;
  const original = {
    log: con.log,
    info: con.info,
    warn: con.warn,
    error: con.error,
  };
  const wrap =
    (level: keyof typeof original) =>
    (...args: unknown[]) => {
      const line = args
        .map((a) =>
          typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : safeJson(a),
        )
        .join(" ");
      lines.push({ level, line });
    };
  con.log = wrap("log");
  con.info = wrap("info");
  con.warn = wrap("warn");
  con.error = wrap("error");
  const stopAccess = captureAccessLog((line) => {
    access.push(line);
  });
  return {
    console: lines,
    access,
    stop: () => {
      con.log = original.log;
      con.info = original.info;
      con.warn = original.warn;
      con.error = original.error;
      stopAccess();
    },
  };
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ─── outbound fetch tap (SSRF matrix; never leaves the box) ─────────────────

export interface OutboundCall {
  url: string;
  method: string;
  body: string | null;
  at: number;
}

export const outbound: OutboundCall[] = [];
let fetchTapped = false;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Install once: every fetch to a non-loopback host is recorded and answered
 * locally with a benign 200 `{}` (RevenueCat/Apple shapes are permissive).
 * Loopback traffic (the fake Supabase, the function itself) passes through. */
export function tapOutboundFetch(): void {
  if (fetchTapped) return;
  fetchTapped = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    if (host && !LOOPBACK_HOSTS.has(host)) {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const rawBody = init?.body;
      const body =
        typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof URLSearchParams
            ? rawBody.toString()
            : rawBody == null
              ? null
              : `<${rawBody.constructor?.name ?? typeof rawBody}>`;
      outbound.push({ url, method, body, at: Date.now() });
      return Promise.resolve(
        new Response(JSON.stringify({ subscriber: { entitlements: {} } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// ─── prototype snapshot ─────────────────────────────────────────────────────

export interface ProtoSnapshot {
  object: string[];
  array: string[];
  fn: string[];
}

export function protoSnapshot(): ProtoSnapshot {
  return {
    object: Object.getOwnPropertyNames(Object.prototype).sort(),
    array: Object.getOwnPropertyNames(Array.prototype).sort(),
    fn: Object.getOwnPropertyNames(Function.prototype).sort(),
  };
}

export function protoDiff(before: ProtoSnapshot, after: ProtoSnapshot): string[] {
  const diffs: string[] = [];
  for (const k of ["object", "array", "fn"] as const) {
    const b = new Set(before[k]);
    for (const name of after[k]) if (!b.has(name)) diffs.push(`${k}.${name}`);
  }
  const probe: Record<string, unknown> = {};
  for (const key of ["polluted", "xcsec", "isAdmin", "premium"]) {
    if (probe[key] !== undefined) diffs.push(`object.${key}=${String(probe[key])}`);
  }
  return diffs;
}

// ─── request helpers ────────────────────────────────────────────────────────

export interface Outcome {
  status: number;
  requestId: string | null;
  body: unknown;
  text: string;
  ms: number;
}

export async function send(
  method: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<Outcome> {
  const started = performance.now();
  const res = await fetch(`${API_BASE}${path}`, {
    ...(token === undefined ? authedInit(init) : authedInit(init, token)),
    method,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: res.status,
    requestId: res.headers.get("x-request-id"),
    body,
    text,
    ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

export async function sendPublic(
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Outcome> {
  const started = performance.now();
  const res = await fetch(`${API_BASE}${path}`, { ...init, method });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: res.status,
    requestId: res.headers.get("x-request-id"),
    body,
    text,
    ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

export function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** Raw HTTP/1.1 over TCP — for header-injection payloads a fetch() client
 * would refuse to serialize (CR/LF, NUL, invalid header names). */
export async function rawHttp(
  requestText: string,
  timeoutMs = 3000,
): Promise<{ status: number | null; head: string; body: string; error: string | null }> {
  let conn: Deno.TcpConn | null = null;
  try {
    conn = await Deno.connect({ hostname: "127.0.0.1", port: 8000 });
    await conn.write(new TextEncoder().encode(requestText));
    const chunks: Uint8Array[] = [];
    const deadline = Date.now() + timeoutMs;
    const buf = new Uint8Array(65536);
    while (Date.now() < deadline) {
      const readP = conn.read(buf);
      const timer = new Promise<null>((r) =>
        setTimeout(() => r(null), Math.max(1, deadline - Date.now())),
      );
      const n = await Promise.race([readP, timer]);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
      const soFar = new TextDecoder().decode(concat(chunks));
      const headEnd = soFar.indexOf("\r\n\r\n");
      if (headEnd >= 0) {
        const head = soFar.slice(0, headEnd);
        const m = /content-length:\s*(\d+)/i.exec(head);
        if (m && soFar.length - headEnd - 4 >= Number(m[1])) break;
        if (!m && /connection:\s*close/i.test(head)) continue;
        if (!m) break;
      }
    }
    const text = new TextDecoder().decode(concat(chunks));
    const headEnd = text.indexOf("\r\n\r\n");
    const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
    const body = headEnd >= 0 ? text.slice(headEnd + 4) : "";
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
    return { status: status ? Number(status[1]) : null, head, body, error: null };
  } catch (error) {
    return {
      status: null,
      head: "",
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      conn?.close();
    } catch {
      // already closed by the peer
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ─── recorded PostgREST helpers ─────────────────────────────────────────────

export function recordedSince(mark: number): RecordedRequest[] {
  return recorded.slice(mark);
}

export function rpcBodies(reqs: RecordedRequest[], rpc: string): Record<string, unknown>[] {
  return reqs
    .filter((r) => r.path === `rpc/${rpc}`)
    .map((r) => {
      try {
        return JSON.parse(r.body) as Record<string, unknown>;
      } catch {
        return { __unparseable__: r.body };
      }
    });
}

export function serializeRecorded(reqs: RecordedRequest[]) {
  return reqs.map((r) => ({
    method: r.method,
    path: r.path,
    query: r.query.toString(),
    body:
      r.body.length > 4000 ? `${r.body.slice(0, 4000)}…(+${r.body.length - 4000} bytes)` : r.body,
    bodyBytes: r.body.length,
  }));
}

// ─── fake PostgREST defaults ────────────────────────────────────────────────

export const PROFILE_ROW = {
  id: USER_ID,
  email: "xcsec@example.com",
  onboarding_state: "complete",
  provider: "google",
  skill_level: "beginner",
  handedness: "right",
  primary_goal: "dinks",
  biggest_problem: null,
  focus_checkpoint: null,
  first_name: null,
  gender: null,
};

/** Enough of a database for the routes under attack to reach their write
 * path: a profile row, an empty replay lookup, and an `accepted` verdict from
 * apply_synced_shot (override `rpcStatus` to replay any status string the
 * real RPC can return). Everything else keeps edgeHarness's `[]`/`{}` default. */
export function installDefaultResponder(rpcStatus = "accepted"): void {
  setRestResponder((req) => {
    if (req.path === "profiles" && req.method === "GET") {
      return restJson(200, wantsSingleObject(req) ? PROFILE_ROW : [PROFILE_ROW]);
    }
    if (req.path === "profiles" && req.method === "PATCH") {
      let patch: Record<string, unknown> = {};
      try {
        patch = JSON.parse(req.body) as Record<string, unknown>;
      } catch {
        patch = {};
      }
      const row = { ...PROFILE_ROW, ...patch };
      return restJson(200, wantsSingleObject(req) ? row : [row]);
    }
    if (req.path === "rpc/apply_synced_shot") return restJson(200, rpcStatus);
    if (req.path === "user_saved_drills" && req.method === "GET") {
      const slug = req.query.get("slug")?.replace(/^eq\./, "");
      if (slug === undefined) return restJson(200, []);
      const row = { slug, saved_at: "2026-09-04T00:00:00.000Z" };
      return restJson(200, wantsSingleObject(req) ? row : [row]);
    }
    return null;
  });
}

// ─── canonical shot payload ─────────────────────────────────────────────────

export const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

export function validShot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [{ key: "ready", startMs: 0, representativeMs: 10, endMs: 20, confidence: 0.9 }],
    checkpoints: [
      {
        key: "contact_position",
        score: 70,
        confidence: 0.9,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: { ...VERSION_VECTOR },
    ...overrides,
  };
}

// ─── artifacts ──────────────────────────────────────────────────────────────

export const ARTIFACT_DIR = Deno.env.get("XC_SEC_ARTIFACT_DIR") ?? "";

export async function writeArtifact(name: string, data: unknown): Promise<string | null> {
  if (!ARTIFACT_DIR) return null;
  await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
  const path = `${ARTIFACT_DIR}/${name}`;
  await Deno.writeTextFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return path;
}

export function heap(): Record<string, number> {
  const m = Deno.memoryUsage();
  return { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external };
}

/** Control (Cc), format (Cf), and lone-surrogate code points a sanitized
 * string must not contain. */
export function hasForbiddenChars(value: string): boolean {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return true;
  return !value.isWellFormed();
}

/** Every canary token present in `text`. */
export function canariesIn(text: string): string[] {
  return [...new Set(text.match(/XCSEC_CANARY_[A-Za-z0-9_]+/g) ?? [])];
}

export interface CanaryReport {
  /** console.* lines carrying a canary — never acceptable. */
  console: Array<{ level: string; line: string }>;
  /** access-log `requestId` echoing a client id that passed the
   * [A-Za-z0-9._-]{8,64} filter — bounded, structure-safe, by design. */
  accessRequestId: string[];
  /** access-log `route` carrying a non-templated user path segment. */
  accessRoute: string[];
  /** any other access-log field carrying a canary. */
  accessOther: string[];
}

export function classifyCanaries(tap: LogTap): CanaryReport {
  const report: CanaryReport = {
    console: [],
    accessRequestId: [],
    accessRoute: [],
    accessOther: [],
  };
  for (const l of tap.console) if (canariesIn(l.line).length > 0) report.console.push(l);
  for (const line of tap.access) {
    if (canariesIn(line).length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      report.accessOther.push(line);
      continue;
    }
    const rest = { ...entry };
    let placed = false;
    if (typeof entry.requestId === "string" && canariesIn(entry.requestId).length > 0) {
      report.accessRequestId.push(line);
      delete rest.requestId;
      placed = true;
    }
    if (typeof entry.route === "string" && canariesIn(entry.route).length > 0) {
      report.accessRoute.push(line);
      delete rest.route;
      placed = true;
    }
    if (canariesIn(JSON.stringify(rest)).length > 0 || !placed) report.accessOther.push(line);
  }
  return report;
}
