/**
 * stress-edge-http — shared support for the `edge-http` stress harness
 * (stress_edge_http_concurrency.test.ts, stress_edge_http_pg.test.ts).
 *
 * Everything here is seeded and replayable:
 *   STRESS_SEED        base seed (default 20260905)
 *   STRESS_ITER        scale knob — rounds per scenario (default 4; the
 *                      campaign runs with STRESS_ITER=24+)
 *   STRESS_BURST       lanes per round (default 32)
 *   STRESS_LATENCY_MS  max modelled upstream latency per hop (default 6)
 *   STRESS_ROUND       replay ONE round of a scenario (its seed is
 *                      STRESS_SEED + round; every table row carries it)
 *   STRESS_OUT_DIR     where the JSON seed→outcome tables land
 *                      (default artifacts/stress-edge-http-concurrency/latest/)
 *
 * The real handler is loaded through xc_concurrency_harness.loadXcHarness()
 * (captures Deno.serve, stubs fetch with the modelled GoTrue/PostgREST/
 * RevenueCat). This module layers ONE more fetch interceptor on top that
 * models the two tables the modelled PostgREST lacks and the free-text
 * routes write through — `consent_records` (append-only ledger) and the
 * `PATCH … Prefer: return=representation` shape of `profiles` — and can
 * optionally BRIDGE those writes to a real postgres:16 (XC_PG_URL) so the
 * real column CHECK constraints answer instead of the model.
 */
import {
  isRecord,
  loadXcHarness,
  Prng,
  sleep,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

// ── Knobs ────────────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 4);
export const STRESS_BURST = envInt("STRESS_BURST", 32);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
const ONLY_ROUND = Deno.env.get("STRESS_ROUND");
export const STRESS_ROUND: number | null =
  ONLY_ROUND !== undefined && ONLY_ROUND !== "" ? Number(ONLY_ROUND) : null;

/** Rounds to run for a scenario: all of them, or exactly the replayed one. */
export function rounds(): number[] {
  if (STRESS_ROUND !== null) return [STRESS_ROUND];
  return Array.from({ length: STRESS_ITER }, (_, i) => i);
}

export function roundSeed(round: number): number {
  return (STRESS_SEED + round) >>> 0;
}

/** Per-lane seed: a murmur3-style mix so neighbouring (seed, lane) pairs
 * do not share early PRNG outputs. */
export function laneSeed(seed: number, lane: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = (h + Math.imul(lane + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function replayCommand(
  file: string,
  filter: string,
  round: number,
): string {
  return (
    `STRESS_SEED=${STRESS_SEED} STRESS_ROUND=${round} STRESS_BURST=${STRESS_BURST} ` +
    `STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ` +
    `${file} --filter "${filter}"`
  );
}

// ── Seed → outcome table ─────────────────────────────────────────────────────

export interface OutcomeRow {
  scenario: string;
  round: number;
  seed: number;
  lane: number;
  action: string;
  status: number | null;
  requestId?: string | null;
  ms: number;
  outcome: "HELD" | "BROKEN";
  violations: string[];
  note?: string;
}

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface ScenarioReport {
  scenario: string;
  file: string;
  label: string;
  baseSeed: number;
  scale: Record<string, number>;
  rows: OutcomeRow[];
  executed: number;
  held: number;
  broken: number;
  statusHistogram: Record<string, number>;
  actionHistogram: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  durationMs: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  replay: Record<string, string>;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-http-concurrency/latest/",
    import.meta.url,
  )
    .pathname;
}

export async function writeReport(report: ScenarioReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function finishReport(
  partial: Omit<
    ScenarioReport,
    "executed" | "held" | "broken" | "statusHistogram" | "actionHistogram"
  >,
): ScenarioReport {
  const rows = partial.rows;
  return {
    ...partial,
    executed: rows.length,
    held: rows.filter((r) => r.outcome === "HELD").length,
    broken: rows.filter((r) => r.outcome === "BROKEN").length,
    statusHistogram: histogram(rows.map((r) => r.status ?? "none")),
    actionHistogram: histogram(rows.map((r) => r.action)),
  };
}

export function printInvariants(
  scenario: string,
  invariants: Invariant[],
): void {
  for (const inv of invariants) {
    console.log(
      `[stress] ${
        inv.holds ? "HOLDS " : "BROKEN"
      } ${scenario}: ${inv.name} — ${inv.detail}`,
    );
  }
}

// ── Hostile text generator (seeded) ──────────────────────────────────────────

/** Atoms chosen to hit every branch of sanitizeUserText plus the things it
 * must NOT touch: C0/C1 controls, DEL, zero-width + bidi + BOM, lone
 * surrogates, whitespace of every Unicode class, header/log injection
 * fragments, combining marks, ZWJ emoji sequences, RTL scripts, and the
 * ordinary letters that must survive verbatim. */
export const HOSTILE_ATOMS: readonly string[] = [
  "a",
  "b",
  "Z",
  "0",
  "9",
  ".",
  "-",
  "_",
  "pickle",
  "sensei",
  " ",
  "  ",
  "\t",
  "\n",
  "\r",
  "\r\n",
  "\v",
  "\f",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2028",
  "\u2029",
  "\u3000",
  "\u0000",
  "\u0001",
  "\u0007",
  "\u0008",
  "\u000e",
  "\u001b",
  "\u001b[31m",
  "\u001f",
  "\u007f",
  "\u0080",
  "\u0085",
  "\u009f",
  "\u200b",
  "\u200c",
  "\u200d",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202d",
  "\u202e",
  "\u2066",
  "\u2067",
  "\u2069",
  "\ufeff",
  "\ud83d",
  "\ude00",
  "\udbff",
  "\udc00",
  "😀",
  "🏓",
  "👨‍👩‍👧",
  "🇺🇸",
  "é",
  "e\u0301",
  "ñ",
  "中文",
  "日本語",
  "العربية",
  "עברית",
  "Ω",
  "ß",
  "İ",
  "Set-Cookie: x=1",
  "X-Injected: 1",
  "%0d%0a",
  "\\r\\n",
  "<script>",
  "'; drop table shots;--",
  "${env}",
  "{{7*7}}",
  "\u0000\u0000",
  "\r\n\r\n",
  "\u202e\u202e",
  "😀".repeat(8),
] as const;

export function hostileText(prng: Prng, maxAtoms: number): string {
  const n = prng.int(0, maxAtoms);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += HOSTILE_ATOMS[prng.int(0, HOSTILE_ATOMS.length - 1)];
  }
  return s;
}

/** Long runs that cross a size cap: `min..max` copies of one atom class. */
export function longRun(
  prng: Prng,
  minCodePoints: number,
  maxCodePoints: number,
): string {
  const kinds = [
    "a",
    "😀",
    "中",
    "e\u0301",
    "a ",
    "\u200ba",
    "ab\u0000",
  ] as const;
  const kind = kinds[prng.int(0, kinds.length - 1)];
  const reps = prng.int(minCodePoints, maxCodePoints);
  return kind.repeat(reps);
}

// ── Property checks shared by both files ─────────────────────────────────────

/** Code-point ranges (inclusive) sanitizeUserText must strip: C0 (minus the
 * whitespace it collapses), DEL + C1, zero-width, bidi overrides/isolates, BOM. */
export const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const classOf = (ranges: ReadonlyArray<readonly [number, number]>) =>
  ranges.map(([lo, hi]) => `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`)
    .join("");
export const CONTROL_AND_SPOOFING = new RegExp(
  `[${classOf(STRIP_RANGES)}]`,
  "u",
);
/** Characters `Headers` accepts as a value (ByteString minus CR/LF). */
export const HEADER_UNSAFE = new RegExp(
  `[^${classOf([[0x0001, 0x00ff]])}]|[\\r\\n]`,
  "gu",
);
export const LATIN1_ONLY = new RegExp(
  `^[${classOf([[0x0000, 0x00ff]])}]*$`,
  "u",
);
const NUL = String.fromCharCode(0);
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Every property a sanitized string must satisfy, as violation strings. */
export function sanitizedTextViolations(
  out: string,
  maxCodePoints: number,
): string[] {
  const v: string[] = [];
  if (!out.isWellFormed()) v.push("not well-formed UTF-16 (lone surrogate)");
  if (CONTROL_AND_SPOOFING.test(out)) {
    v.push("control/zero-width/bidi/BOM survived");
  }
  if (/[\r\n\t\v\f\u2028\u2029\u0085]/.test(out)) {
    v.push("line/format control survived");
  }
  if (out.includes(NUL)) v.push("NUL survived (Postgres text rejects it)");
  if (/\s\s/.test(out)) v.push("double whitespace survived");
  if (out !== out.trim()) v.push("leading/trailing whitespace survived");
  if (Array.from(out).length > maxCodePoints) {
    v.push(`code points ${Array.from(out).length} > cap ${maxCodePoints}`);
  }
  try {
    if (JSON.parse(JSON.stringify(out)) !== out) {
      v.push("JSON round-trip changed the value");
    }
  } catch {
    v.push("JSON round-trip threw");
  }
  const bytes = new TextEncoder().encode(out);
  if (new TextDecoder().decode(bytes) !== out) {
    v.push("UTF-8 round-trip changed the value");
  }
  if (bytes.length > 4 * maxCodePoints) {
    v.push(`utf-8 bytes ${bytes.length} > 4×cap`);
  }
  return v;
}

export function headerValuesViolations(headers: Headers): string[] {
  const v: string[] = [];
  headers.forEach((value, key) => {
    if (/[\r\n\0]/.test(value)) v.push(`header ${key} contains CR/LF/NUL`);
    if (/[\r\n\0]/.test(key)) v.push(`header name contains CR/LF/NUL`);
  });
  return v;
}

// ── Layered fetch model: consent_records + profiles representation ──────────

export interface ConsentRecordRow {
  id: string;
  user_id: string;
  scope: string;
  consent_version: string | null;
  action: string;
  source: string | null;
  device: unknown;
  capture_mode: string | null;
  created_at: string;
}

/** A PostgREST-shaped error a real Postgres CHECK/RLS violation produces. */
export interface PgLikeError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

export type ConsentBridge = (
  who: { role: "service" | "user" | "anon"; userId: string | null },
  row: Record<string, unknown>,
) => Promise<PgLikeError | null>;

export interface StressHarness extends XcHarness {
  consentRecords: ConsentRecordRow[];
  /** Set to route consent_records INSERTs through a real Postgres. */
  consentBridge: ConsentBridge | null;
  /** Requests the layered model refused to model (should stay empty). */
  unmodelled: string[];
  resetLayer(): void;
}

let layered: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (layered) return layered;
  const base = await loadXcHarness();
  const inner = globalThis.fetch;
  const consentRecords: ConsentRecordRow[] = [];
  let seq = 0;
  const state: StressHarness = {
    ...base,
    consentRecords,
    consentBridge: null,
    unmodelled: [],
    resetLayer() {
      consentRecords.length = 0;
      state.unmodelled.length = 0;
      seq = 0;
    },
  };
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const restPrefix = "/rest/v1/";
    if (!url.pathname.startsWith(restPrefix)) return inner(request);
    const table = url.pathname.slice(restPrefix.length);
    const who = base.fake.principal(request.headers);

    if (table === "consent_records") {
      base.upstreamCalls.push({
        t: 0,
        method: request.method,
        url: request.url,
      });
      const rawBody = request.method === "POST"
        ? await request.text().catch(() => "")
        : "";
      await sleep(layerLatency());
      if (who.role === "anon" || !who.userId) {
        return jsonResponse(401, {
          code: "PGRST301",
          message: "JWT required",
        });
      }
      if (request.method === "GET") {
        const userEq = url.searchParams.get("user_id") ?? "";
        const rows = consentRecords
          .filter((r) => r.user_id === who.userId)
          .filter((r) =>
            !userEq.startsWith("eq.") || r.user_id === userEq.slice(3)
          )
          .sort((
            a,
            b,
          ) => (a.created_at < b.created_at
            ? -1
            : a.created_at > b.created_at
            ? 1
            : a.id < b.id
            ? -1
            : 1)
          )
          .map((r) => ({
            scope: r.scope,
            action: r.action,
            consent_version: r.consent_version,
            created_at: r.created_at,
          }));
        return jsonResponse(200, rows);
      }
      if (request.method === "POST") {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = {};
        }
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of incoming) {
          if (!isRecord(row)) continue;
          if (row.user_id !== who.userId) {
            return jsonResponse(403, {
              code: "42501",
              message:
                'new row violates row-level security policy for table "consent_records"',
            });
          }
          if (state.consentBridge) {
            const err = await state.consentBridge(who, row);
            if (err) return jsonResponse(400, err);
          }
          // Modelled CHECK constraints (20260831160000_defense_in_depth.sql
          // consent_records_text_bounds) are NOT applied here on purpose: the
          // in-process scenario asserts the EDGE contract; the DB contract is
          // asserted by the bridge / stress_edge_http_pg.test.ts.
          seq += 1;
          consentRecords.push({
            id: `${String(seq).padStart(8, "0")}-0000-4000-8000-000000000000`,
            user_id: String(row.user_id),
            scope: String(row.scope),
            consent_version: typeof row.consent_version === "string"
              ? row.consent_version
              : null,
            action: String(row.action),
            source: typeof row.source === "string" ? row.source : null,
            device: row.device ?? null,
            capture_mode: typeof row.capture_mode === "string"
              ? row.capture_mode
              : null,
            created_at: new Date(Date.now()).toISOString(),
          });
        }
        return new Response(null, { status: 201 });
      }
      state.unmodelled.push(`${request.method} ${request.url}`);
      return jsonResponse(405, {
        code: "PGRST",
        message: "unmodelled consent_records verb",
      });
    }

    if (table === "profiles" && request.method === "PATCH") {
      const prefer = request.headers.get("prefer") ?? "";
      const rawBody = await request.text().catch(() => "");
      let patch: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(rawBody);
        patch = isRecord(parsed) ? parsed : {};
      } catch {
        patch = {};
      }
      base.upstreamCalls.push({
        t: 0,
        method: request.method,
        url: request.url,
      });
      await sleep(layerLatency());
      if (who.role === "anon" || !who.userId) {
        return jsonResponse(401, {
          code: "PGRST301",
          message: "JWT required",
        });
      }
      const idEq = url.searchParams.get("id") ?? "";
      const targetId = idEq.startsWith("eq.") ? idEq.slice(3) : null;
      const rows = base.fake.tables.profiles.filter(
        (r) =>
          (who.role === "service" || r.id === who.userId) &&
          (targetId === null || r.id === targetId),
      );
      // One synchronous assignment per row = one row-level UPDATE: never torn.
      for (const r of rows) Object.assign(r, patch);
      if (!prefer.includes("return=representation")) {
        return new Response(null, { status: 204 });
      }
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (rows.length > 1) {
          return jsonResponse(406, {
            code: "PGRST116",
            message: `${rows.length} rows`,
            details: null,
            hint: null,
          });
        }
        return rows.length === 1
          ? jsonResponse(200, rows[0])
          : jsonResponse(200, null);
      }
      return jsonResponse(200, rows);
    }

    return inner(request);
  }) as typeof fetch;

  layered = state;
  return state;
}

// The modelled FakeSupabase keeps its latency PRNG private; the layered
// tables draw from their own seeded stream (reseeded per round).
let latencyPrng = new Prng(1);
export function reseedLatency(seed: number): void {
  latencyPrng = new Prng((seed ^ 0x5a5a5a5a) >>> 0);
}
function layerLatency(): number {
  return STRESS_LATENCY_MS === 0 ? 0 : latencyPrng.int(0, STRESS_LATENCY_MS);
}

// ── Streams for cancel-during-call / oversize-without-content-length ────────

/** A body that yields `chunks` then ERRORS — the client vanished mid-upload. */
export function abortingBody(
  chunks: Uint8Array[],
  error = new Error("client aborted"),
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
        return;
      }
      controller.error(error);
    },
  });
}

/** A body of `totalBytes` streamed in `chunkBytes` pieces with NO
 * content-length (the pre-auth declared-length gate cannot see it). */
export function streamingBody(
  totalBytes: number,
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  let sent = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkBytes, totalBytes - sent);
      controller.enqueue(n === chunkBytes ? chunk : chunk.subarray(0, n));
      sent += n;
    },
  });
}

// ── Clock skew ───────────────────────────────────────────────────────────────

/** Shift Date.now() by `deltaMs` while `fn` runs (the wall clock jumping
 * under a live request — NTP step, timezone glitch, VM migration). */
export async function withClockSkew<T>(
  deltaMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + deltaMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// ── sanitizeUserText call sites vs column CHECKs ───────────────────────────

/** index.ts call site → migration CHECK (chars). Sources:
 *  index.ts grantConsent/withdrawConsent (~L1850), deletion survey (~L2835),
 *  PUT /v1/me/onboarding (~L3505); 20260831160000_defense_in_depth.sql
 *  consent_records_text_bounds / profiles_text_bounds;
 *  20260831000000_scale_and_security.sql first_name ≤ 80;
 *  20260902000000_account_deletion_feedback.sql details ≤ 1000, app_version ≤ 64. */
export const CAP_SITES = [
  {
    site: "consent_records.consent_version",
    edgeCap: 64,
    dbCap: 50,
    routeCap: null,
  },
  { site: "consent_records.source", edgeCap: 64, dbCap: 100, routeCap: null },
  {
    site: "consent_records.capture_mode",
    edgeCap: 64,
    dbCap: 50,
    routeCap: null,
  },
  {
    site: "account_deletion_feedback.details",
    edgeCap: 500,
    dbCap: 1000,
    routeCap: null,
  },
  {
    site: "account_deletion_feedback.app_version",
    edgeCap: 64,
    dbCap: 64,
    routeCap: null,
  },
  { site: "profiles.skill_level", edgeCap: 200, dbCap: 100, routeCap: 64 },
  { site: "profiles.primary_goal", edgeCap: 200, dbCap: 200, routeCap: 64 },
  {
    site: "profiles.biggest_problem",
    edgeCap: 1_000,
    dbCap: 500,
    routeCap: 256,
  },
  { site: "profiles.first_name", edgeCap: 200, dbCap: 80, routeCap: 40 },
] as const;
