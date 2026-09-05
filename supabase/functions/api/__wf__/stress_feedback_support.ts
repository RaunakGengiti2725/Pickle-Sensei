// Stress/fuzz support for POST /v1/analyses/:id/feedback (submitAnalysisFeedback
// in ../index.ts). Shared by stress_analyses_feedback_fuzz.test.ts (in-memory
// PostgREST model) and stress_analyses_feedback_pg.test.ts (docker postgres:16
// with every migration applied).
//
// Every generated request is a pure function of one 32-bit iteration seed
// (derived from the campaign seed + index), so any row of the results table
// is replayable with STRESS_REPLAY=<seed>. The REAL handler runs in-process
// via routesHarness.loadHarness(); only the fetch layer below it is modelled.

import { fakeAppleIdToken, fakeGoogleIdToken, loadHarness, SUPABASE_URL } from "./routesHarness.ts";
import type { Harness } from "./routesHarness.ts";

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + per-iteration seed derivation (splitmix-style).
// ---------------------------------------------------------------------------

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += this.int(0, 15).toString(16);
    return out;
  }
  /** Unicode-heavy string: BMP letters, astral plane, control, RTL, NUL. */
  junkString(maxLen: number): string {
    const alphabet = [
      "a",
      "Z",
      "0",
      " ",
      "\t",
      "\n",
      "\u0000",
      "\u200b",
      "\u202e",
      "\ufeff",
      "\u00e9",
      "\ud83c\udfd3",
      "'",
      '"',
      "\\",
      "<",
      ">",
      "&",
      ";",
      "%",
      "{",
      "}",
      "$",
      "`",
      "\ud800", // lone surrogate
    ];
    let out = "";
    const len = this.int(0, maxLen);
    for (let i = 0; i < len; i++) out += this.pick(alphabet);
    return out;
  }
  uuidV4(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${this.pick(["8", "9", "a", "b"])}${this.hex(3)}-${this.hex(12)}`;
  }
}

export function iterSeed(campaignSeed: number, index: number): number {
  let z = (campaignSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// World: deterministic pool of users / owned shots / IPs derived from the
// campaign seed. Both backends are seeded from the same world.
// ---------------------------------------------------------------------------

export interface StressUser {
  id: string;
  /** Google/Apple provider ID token (transitional bearer, exchanged once). */
  providerToken: string;
  /** Supabase-issued access token (the 2026-09-01 contract). */
  sessionToken: string;
  shots: string[];
}

export interface World {
  campaignSeed: number;
  users: StressUser[];
  ips: string[];
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Supabase access token for `sub` (issuer ends in
 * /auth/v1 so authenticate() takes the getUser() branch). Verification is
 * modelled in the fetch layer. */
export function fakeSessionToken(sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      exp,
      role: "authenticated",
      session_id: `sess-${sub.slice(0, 8)}`,
    }),
  );
  return `${header}.${payload}.sig`;
}

export function buildWorld(campaignSeed: number, users = 64, shotsPerUser = 8, ips = 512): World {
  const rng = new Rng(campaignSeed ^ 0x5f3759df);
  const out: StressUser[] = [];
  for (let u = 0; u < users; u++) {
    const id = rng.uuidV4();
    const shots: string[] = [];
    for (let s = 0; s < shotsPerUser; s++) shots.push(rng.uuidV4());
    out.push({
      id,
      providerToken: u % 2 === 0 ? fakeGoogleIdToken(id) : fakeAppleIdToken(id),
      sessionToken: fakeSessionToken(id),
      shots,
    });
  }
  const ipPool: string[] = [];
  for (let i = 0; i < ips; i++) ipPool.push(`10.77.${(i >> 8) & 255}.${i & 255}`);
  return { campaignSeed, users: out, ips: ipPool };
}

// ---------------------------------------------------------------------------
// Backend model: what the fetch layer answers for the three PostgREST calls
// the route makes (shots read, consent read, analysis_feedback insert).
// ---------------------------------------------------------------------------

export type FaultStage = "shots" | "consent" | "insert";

export const FAULT_MARKER = "STRESS_SECRET_MARKER";

export interface BackendCounters {
  /** POST/PATCH/PUT/DELETE reaching PostgREST (any table). */
  writeAttempts: number;
  /** Rows actually persisted (insert accepted). */
  mutations: number;
  reads: number;
}

export interface PostgrestCall {
  method: string;
  table: string;
  params: URLSearchParams;
  headers: Headers;
  bodyText: string;
  /** auth.uid() the request acts as, derived from the user-scoped bearer. */
  actingUser: string | null;
}

export interface FeedbackBackend {
  readonly name: string;
  counters: BackendCounters;
  fault: FaultStage | null;
  /** Answer a PostgREST call (the fetch layer already parsed URL + body). */
  handle(call: PostgrestCall): Promise<Response>;
  /** True when (analysisId, userId) already has a feedback row. */
  hasFeedback(analysisId: string, userId: string): Promise<boolean>;
  countFeedback(analysisId: string, userId: string): Promise<number>;
}

export function resetCounters(backend: FeedbackBackend): void {
  backend.counters = { writeAttempts: 0, mutations: 0, reads: 0 };
}

export const pgrstJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export function faultResponse(stage: FaultStage): Response {
  return pgrstJson(500, {
    code: "XX000",
    message: `${FAULT_MARKER} internal detail for ${stage}: relation "public.analysis_feedback" at line 1`,
    details: `${FAULT_MARKER} Error: boom\n    at file:///var/task/index.ts:1:1`,
    hint: null,
  });
}

export function pgrstError(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
): Response {
  return pgrstJson(status, { code, message, details, hint: null });
}

const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

export function parseSelect(params: URLSearchParams): string[] {
  const raw = params.get("select") ?? "*";
  const cols = raw.split(",").map((c) => c.trim());
  for (const c of cols) if (c !== "*" && !COLUMN_RE.test(c)) throw new Error(`bad select ${raw}`);
  return cols;
}

export interface EqFilter {
  column: string;
  value: string;
}

export function parseFilters(params: URLSearchParams): EqFilter[] {
  const out: EqFilter[] = [];
  for (const [key, value] of params) {
    if (key === "select" || key === "order" || key === "on_conflict" || key === "columns") continue;
    if (!COLUMN_RE.test(key)) throw new Error(`bad filter column ${key}`);
    if (!value.startsWith("eq.")) throw new Error(`unsupported operator ${key}=${value}`);
    out.push({ column: key, value: value.slice(3) });
  }
  return out;
}

export function parseOrder(params: URLSearchParams): Array<{ column: string; asc: boolean }> {
  const raw = params.get("order");
  if (!raw) return [];
  return raw.split(",").map((part) => {
    const [column, dir] = part.split(".");
    if (!COLUMN_RE.test(column)) throw new Error(`bad order column ${column}`);
    return { column, asc: dir !== "desc" };
  });
}

/** In-memory PostgREST model: exact-row ownership, RLS-shaped filters, the
 * (analysis_id, user_id) unique constraint as 23505, fault injection. */
export class MemoryBackend implements FeedbackBackend {
  readonly name = "memory";
  counters: BackendCounters = { writeAttempts: 0, mutations: 0, reads: 0 };
  fault: FaultStage | null = null;
  private readonly shots = new Map<string, string>(); // shotId(lower) → userId
  private readonly consent = new Map<string, Array<Record<string, unknown>>>();
  private readonly feedback = new Map<string, { id: string; created_at: string }>();

  constructor(world: World) {
    for (const user of world.users) {
      for (const shot of user.shots) this.shots.set(shot.toLowerCase(), user.id);
    }
  }

  grantConsent(userId: string, scope: string): void {
    const rows = this.consent.get(userId) ?? [];
    rows.push({
      scope,
      action: "grant",
      consent_version: "2026-09-01",
      created_at: new Date().toISOString(),
    });
    this.consent.set(userId, rows);
  }

  private key(analysisId: string, userId: string): string {
    return `${analysisId.toLowerCase()}|${userId.toLowerCase()}`;
  }

  hasFeedback(analysisId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.feedback.has(this.key(analysisId, userId)));
  }

  countFeedback(analysisId: string, userId: string): Promise<number> {
    return Promise.resolve(this.feedback.has(this.key(analysisId, userId)) ? 1 : 0);
  }

  handle(call: PostgrestCall): Promise<Response> {
    return Promise.resolve(this.handleSync(call));
  }

  private handleSync(call: PostgrestCall): Response {
    const { method, table, params, actingUser } = call;
    if (method === "GET") {
      this.counters.reads += 1;
      const filters = parseFilters(params);
      if (table === "shots") {
        if (this.fault === "shots") return faultResponse("shots");
        const id = filters.find((f) => f.column === "id")?.value ?? "";
        const userId = filters.find((f) => f.column === "user_id")?.value ?? "";
        if (!UUID_RE.test(id) || !UUID_RE.test(userId)) {
          return pgrstError(400, "22P02", `invalid input syntax for type uuid: "${id}"`);
        }
        const owner = this.shots.get(id.toLowerCase());
        // RLS: only rows whose user_id = auth.uid() are visible at all.
        const visible =
          owner !== undefined &&
          owner.toLowerCase() === userId.toLowerCase() &&
          actingUser !== null &&
          owner.toLowerCase() === actingUser.toLowerCase();
        return pgrstJson(200, visible ? [{ id: id.toLowerCase() }] : []);
      }
      if (table === "consent_records") {
        if (this.fault === "consent") return faultResponse("consent");
        const userId = filters.find((f) => f.column === "user_id")?.value ?? "";
        const rows =
          actingUser !== null && userId.toLowerCase() === actingUser.toLowerCase()
            ? (this.consent.get(actingUser) ?? [])
            : [];
        return pgrstJson(200, rows);
      }
      return pgrstError(404, "PGRST205", `Could not find the table 'public.${table}'`);
    }
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      this.counters.writeAttempts += 1;
      if (table !== "analysis_feedback" || method !== "POST") {
        return pgrstError(404, "PGRST205", `Could not find the table 'public.${table}'`);
      }
      if (this.fault === "insert") return faultResponse("insert");
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(call.bodyText) as Record<string, unknown>;
      } catch {
        return pgrstError(400, "PGRST102", "Empty or invalid json request body");
      }
      const userId = String(row.user_id ?? "");
      const analysisId = String(row.analysis_id ?? "");
      if (actingUser === null || userId.toLowerCase() !== actingUser.toLowerCase()) {
        return pgrstError(
          403,
          "42501",
          'new row violates row-level security policy for table "analysis_feedback"',
        );
      }
      if (!UUID_RE.test(analysisId)) {
        return pgrstError(400, "22P02", `invalid input syntax for type uuid: "${analysisId}"`);
      }
      const key = this.key(analysisId, userId);
      if (this.feedback.has(key)) {
        return pgrstError(
          409,
          "23505",
          'duplicate key value violates unique constraint "analysis_feedback_analysis_id_user_id_key"',
          `Key (analysis_id, user_id)=(${analysisId}, ${userId}) already exists.`,
        );
      }
      const stored = { id: crypto.randomUUID(), created_at: new Date().toISOString() };
      this.feedback.set(key, stored);
      this.counters.mutations += 1;
      const accept = call.headers.get("accept") ?? "";
      return pgrstJson(201, accept.includes("vnd.pgrst.object+json") ? stored : [stored]);
    }
    return pgrstError(405, "PGRST105", `Method ${method} not allowed`);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mirrors http.ts REQUEST_ID_RE (client ids the function may honour). */
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

// ---------------------------------------------------------------------------
// Fetch layer: sits ABOVE the routesHarness stub. Models Supabase Auth's
// getUser() for session bearers (the harness only models signInWithIdToken)
// and routes PostgREST table calls into the backend. Everything else falls
// through to the harness stub.
// ---------------------------------------------------------------------------

export interface StressEnv {
  harness: Harness;
  world: World;
  backend: FeedbackBackend;
  /** Users whose session tokens getUser() must reject (revoked/deleted). */
  revokedSessions: Set<string>;
  /** Users the fake Auth knows (getUser 200). Everyone else → 401. */
  knownUsers: Set<string>;
  install(): void;
  uninstall(): void;
}

function decodeJwtSub(token: string): string | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64)) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The user-scoped PostgREST client bears either the harness-minted
 * `session-for-<sub>` (provider exchange) or the session JWT itself. */
function actingUserOf(headers: Headers): string | null {
  const auth = headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token.startsWith("session-for-")) return token.slice("session-for-".length);
  return decodeJwtSub(token);
}

export async function createStressEnv(world: World, backend: FeedbackBackend): Promise<StressEnv> {
  const harness = await loadHarness();
  const knownUsers = new Set(world.users.map((u) => u.id));
  const revokedSessions = new Set<string>();
  let previous: typeof fetch | null = null;

  const layered = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (request.method === "GET" && url.href === `${SUPABASE_URL}/auth/v1/user`) {
      const sub = actingUserOf(request.headers);
      if (sub === null || !knownUsers.has(sub) || revokedSessions.has(sub)) {
        return pgrstJson(401, {
          code: 401,
          msg: "invalid JWT: unable to parse or verify signature",
        });
      }
      const provider = world.users.find((u) => u.id === sub)?.providerToken.includes("apple")
        ? "apple"
        : "google";
      return pgrstJson(200, {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: `${sub}@example.com`,
        app_metadata: { provider, providers: [provider] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      });
    }

    if (
      url.href.startsWith(`${SUPABASE_URL}/rest/v1/`) &&
      !url.pathname.startsWith("/rest/v1/rpc/")
    ) {
      const table = url.pathname.slice("/rest/v1/".length);
      const bodyText = await request.text().catch(() => "");
      return backend.handle({
        method: request.method,
        table,
        params: url.searchParams,
        headers: request.headers,
        bodyText,
        actingUser: actingUserOf(request.headers),
      });
    }

    if (!previous) throw new Error("stress fetch layer not installed");
    return previous(request);
  }) as typeof fetch;

  return {
    harness,
    world,
    backend,
    revokedSessions,
    knownUsers,
    install() {
      if (previous) return;
      previous = globalThis.fetch;
      globalThis.fetch = layered;
    },
    uninstall() {
      if (!previous) return;
      globalThis.fetch = previous;
      previous = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Request generator: one iteration seed → one fully described request.
// ---------------------------------------------------------------------------

export type ScenarioKind =
  | "valid"
  | "duplicate"
  | "not_owned"
  | "bad_id"
  | "bad_body"
  | "bad_auth"
  | "bad_method"
  | "bad_path"
  | "oversize"
  | "fault"
  | "noise";

export interface Scenario {
  seed: number;
  kind: ScenarioKind;
  method: string;
  /** Full request URL (edge.test host, gateway-shaped path). */
  url: string;
  headers: Record<string, string>;
  /** Body sent verbatim (string) or undefined; streamed bodies are described. */
  body: string | Uint8Array | undefined;
  streamedBytes?: number;
  fault: FaultStage | null;
  /** The user whose credentials the request bears (null = anonymous/bad). */
  userIndex: number | null;
  /** Analysis id the oracle treats as targeted (lowercased canonical). */
  analysisId: string | null;
  /** Statuses the contract allows for this request. */
  allowed: number[];
  /** Whether a successful write (201) is legitimate for this request. */
  mayWrite: boolean;
  note: string;
}

const VALID_RATINGS = ["accurate", "not_quite"] as const;
const VALID_CATEGORIES = [
  "wrong_stroke",
  "wrong_player",
  "contact_looks_wrong",
  "feedback_mismatch",
  "other",
] as const;

const BAD_INPUT_STATUSES = [400, 401, 403, 404, 405, 413, 415, 429];

const KIND_WEIGHTS: Array<[ScenarioKind, number]> = [
  ["valid", 22],
  ["duplicate", 6],
  ["not_owned", 8],
  ["bad_id", 11],
  ["bad_body", 16],
  ["bad_auth", 10],
  ["bad_method", 5],
  ["bad_path", 6],
  ["oversize", 1],
  ["fault", 5],
  ["noise", 10],
];

function pickKind(rng: Rng): ScenarioKind {
  const total = KIND_WEIGHTS.reduce((acc, [, w]) => acc + w, 0);
  let roll = rng.next() * total;
  for (const [kind, weight] of KIND_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return "valid";
}

function validBody(rng: Rng): Record<string, unknown> {
  const rating = rng.pick(VALID_RATINGS);
  if (rating === "not_quite") return { rating, category: rng.pick(VALID_CATEGORIES) };
  return rng.chance(0.3) ? { rating, category: null } : { rating };
}

function badBodyVariant(rng: Rng): { body: string; note: string; contentType?: string } {
  const variants: Array<() => { body: string; note: string; contentType?: string }> = [
    () => ({ body: "", note: "empty body" }),
    () => ({ body: "{", note: "truncated json" }),
    () => ({ body: "null", note: "json null" }),
    () => ({ body: "[]", note: "json array" }),
    () => ({ body: '"accurate"', note: "json string" }),
    () => ({ body: "42", note: "json number" }),
    () => ({ body: "{}", note: "empty object" }),
    () => ({ body: JSON.stringify({ rating: "Accurate" }), note: "rating wrong case" }),
    () => ({ body: JSON.stringify({ rating: " accurate" }), note: "rating leading space" }),
    () => ({ body: JSON.stringify({ rating: "accurate\u0000" }), note: "rating NUL" }),
    () => ({ body: JSON.stringify({ rating: ["accurate"] }), note: "rating array" }),
    () => ({ body: JSON.stringify({ rating: { accurate: true } }), note: "rating object" }),
    () => ({ body: JSON.stringify({ rating: 1 }), note: "rating number" }),
    () => ({ body: JSON.stringify({ rating: null }), note: "rating null" }),
    () => ({ body: JSON.stringify({ rating: true }), note: "rating boolean" }),
    () => ({ body: JSON.stringify({ rating: "not_quite" }), note: "not_quite without category" }),
    () => ({
      body: JSON.stringify({ rating: "not_quite", category: null }),
      note: "not_quite null category",
    }),
    () => ({
      body: JSON.stringify({ rating: "not_quite", category: "WRONG_STROKE" }),
      note: "category wrong case",
    }),
    () => ({
      body: JSON.stringify({ rating: "not_quite", category: rng.junkString(40) }),
      note: "category junk",
    }),
    () => ({
      body: JSON.stringify({ rating: "not_quite", category: ["other"] }),
      note: "category array",
    }),
    () => ({
      body: JSON.stringify({ rating: "not_quite", category: 7 }),
      note: "category number",
    }),
    () => ({
      body: JSON.stringify({ rating: "accurate", category: rng.pick(VALID_CATEGORIES) }),
      note: "accurate with category",
    }),
    () => ({
      body: JSON.stringify({ rating: "accurate", category: "" }),
      note: "accurate with empty category (lenient: accepted, stored null → may write)",
    }),
    () => ({
      body: JSON.stringify({ rating: "accurate", category: rng.junkString(20) || "junk" }),
      note: "accurate with junk category (lenient: accepted, stored null → may write)",
    }),
    () => ({ body: JSON.stringify({ rating: rng.junkString(64) }), note: "rating junk" }),
    () => ({
      body: JSON.stringify({ rating: "a".repeat(rng.int(1000, 200_000)) }),
      note: "rating very long",
    }),
    () => ({
      body: JSON.stringify({ Rating: "accurate" }),
      note: "key wrong case",
    }),
    () => ({
      body: JSON.stringify({ rating: "not_quite", category: "other", __proto__: { x: 1 } }),
      note: "__proto__ key (literal)",
    }),
    () => ({
      body: '{"rating":"accurate","rating":"bogus"}',
      note: "duplicate key last wins → bogus",
    }),
    () => ({
      body: `{"rating":"accurate"}${rng.pick(["x", "}", "]", ",", "{}", "\u0000", "//"])}${rng.junkString(8)}`,
      note: "trailing garbage",
    }),
    () => ({
      body: "rating=accurate",
      note: "form-encoded",
      contentType: "application/x-www-form-urlencoded",
    }),
    () => ({ body: "<rating>accurate</rating>", note: "xml", contentType: "application/xml" }),
    () => ({
      body: JSON.stringify({ rating: "accurate" }).replace("accurate", "accurat\u00e9"),
      note: "rating unicode",
    }),
    () => ({
      body: "\ufeff" + JSON.stringify({ rating: "accurate" }),
      note: "BOM prefix (TextDecoder strips it → valid → may write)",
    }),
    () => {
      let nested: unknown = { rating: "accurate" };
      for (let i = 0; i < rng.int(50, 5000); i++) nested = [nested];
      return { body: JSON.stringify(nested), note: "deeply nested array" };
    },
    () => ({
      body: JSON.stringify({ rating: "accurate", extra: "x".repeat(rng.int(0, 100_000)) }),
      note: "accurate + big extra field (valid → may write)",
    }),
  ];
  return rng.pick(variants)();
}

function badIdVariant(rng: Rng, real: string): { id: string; note: string; expect: number[] } {
  const variants: Array<() => { id: string; note: string; expect: number[] }> = [
    () => ({ id: "", note: "empty segment", expect: [404] }), // //feedback → regex fails
    () => ({ id: "not-a-uuid", note: "plain text", expect: [400] }),
    () => ({ id: real.slice(0, -1), note: "uuid minus one char", expect: [400] }),
    () => ({ id: `${real}0`, note: "uuid plus one char", expect: [400] }),
    () => ({ id: real.replace(/-/g, ""), note: "uuid without dashes", expect: [400] }),
    () => ({ id: "00000000-0000-0000-0000-000000000000", note: "nil uuid (v0)", expect: [400] }),
    () => ({ id: "ffffffff-ffff-ffff-ffff-ffffffffffff", note: "max uuid (v15)", expect: [400] }),
    () => ({ id: `${real.slice(0, 14)}9${real.slice(15)}`, note: "uuid version 9", expect: [400] }),
    () => ({ id: `${real.slice(0, 19)}c${real.slice(20)}`, note: "uuid variant c", expect: [400] }),
    () => ({ id: `{${real}}`, note: "braced uuid", expect: [400] }),
    () => ({ id: `urn:uuid:${real}`, note: "urn uuid", expect: [400] }),
    () => ({ id: `${real}%00`, note: "trailing encoded NUL", expect: [400] }),
    () => ({ id: `${real}%2F..`, note: "encoded slash traversal", expect: [400] }),
    () => ({ id: "%E0%A4%A", note: "malformed percent (URIError)", expect: [400] }),
    () => ({ id: "%", note: "lone percent", expect: [400] }),
    () => ({ id: "..", note: "dot dot (URL normalizes to /v1/feedback)", expect: [404] }),
    () => ({ id: "a".repeat(rng.int(300, 20_000)), note: "very long segment", expect: [400] }),
    () => ({ id: safeEncode(rng.junkString(30)) || "x", note: "junk", expect: [400] }),
    () => ({ id: rng.uuidV4().replace(/[0-9a-f]/, "g"), note: "non-hex char", expect: [400] }),
    () => ({
      id: `${real}\u0000`.replace("\u0000", "%00"),
      note: "encoded NUL suffix",
      expect: [400],
    }),
    () => ({ id: "1", note: "numeric", expect: [400] }),
    () => ({ id: "null", note: "null literal", expect: [400] }),
    () => ({
      id: safeEncode(`${real}?x=1`),
      note: "query inside segment (encoded ?)",
      expect: [400],
    }),
  ];
  const chosen = rng.pick(variants)();
  return chosen;
}

const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** encodeURIComponent that cannot throw (lone surrogates are dropped). */
export function safeEncode(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE_RE, ""));
}

const JUNK_HEADERS: Array<[string, (rng: Rng) => string]> = [
  ["x-forwarded-for", () => "1.1.1.1, 2.2.2.2, ".repeat(50) + "3.3.3.3"],
  ["x-forwarded-for", () => ""],
  ["x-forwarded-for", () => ",,,"],
  ["x-forwarded-for", () => "\u200b"],
  ["x-forwarded-for", () => "a".repeat(8000)],
  ["cf-connecting-ip", () => "not an ip at all"],
  ["cf-connecting-ip", () => " "],
  ["x-http-method-override", () => "DELETE"],
  ["x-original-url", () => "/v1/account"],
  ["x-rewrite-url", () => "/v1/account"],
  ["accept", () => "text/html"],
  ["accept", () => "*/*;q=0"],
  ["accept-encoding", () => "br, gzip, deflate, zstd"],
  ["content-type", () => "text/plain"],
  ["content-type", () => "application/json; charset=utf-16"],
  ["content-type", () => "multipart/form-data; boundary=----x"],
  ["content-type", () => ""],
  ["content-length", () => "-1"],
  ["content-length", () => "abc"],
  ["content-length", () => "999999999999"],
  ["content-length", () => "0"],
  ["transfer-encoding", () => "chunked"],
  ["expect", () => "100-continue"],
  ["range", () => "bytes=0-1"],
  ["origin", () => "https://evil.example"],
  ["referer", () => "javascript:alert(1)"],
  ["cookie", () => "sb-access-token=x; ".repeat(20)],
  ["x-request-id", (rng) => `client-supplied-${rng.hex(16)}`],
  ["x-request-id", () => "\u0000\u0001"],
  ["x-request-id", () => "z".repeat(4096)],
  ["apikey", () => "service-role-test-key"],
  ["prefer", () => "return=minimal"],
  ["if-none-match", () => "*"],
  ["user-agent", () => ""],
  ["host", () => "evil.example"],
];

function randomQuery(rng: Rng): string {
  const parts: string[] = [];
  const n = rng.int(0, 6);
  for (let i = 0; i < n; i++) {
    const key = rng.pick([
      "select",
      "user_id",
      "id",
      "rating",
      "category",
      "apikey",
      "token",
      "__proto__",
      "x",
      safeEncode(rng.junkString(10)),
    ]);
    const value = rng.pick([
      "*",
      "eq.x",
      "'; drop table shots;--",
      safeEncode(rng.junkString(20)),
      rng.uuidV4(),
      "a".repeat(rng.int(0, 2000)),
    ]);
    parts.push(`${key}=${value}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function pathFor(analysisSegment: string, shape: number): string {
  const tail = `analyses/${analysisSegment}/feedback`;
  switch (shape) {
    case 0:
      return `/functions/v1/api/v1/${tail}`;
    case 1:
      return `/api/v1/${tail}`;
    case 2:
      return `/v1/${tail}`;
    default:
      return `/functions/v1/api/v1/${tail}`;
  }
}

function badPathVariant(rng: Rng, id: string): { path: string; note: string; expect: number[] } {
  const variants: Array<() => { path: string; note: string; expect: number[] }> = [
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback/`,
      note: "trailing slash",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedbacks`,
      note: "wrong suffix",
      expect: [404],
    }),
    () => ({ path: `/functions/v1/api/v1/analyses/${id}`, note: "no /feedback", expect: [404] }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback/extra`,
      note: "extra segment",
      expect: [404],
    }),
    () => ({ path: `/functions/v1/api/v1/analyses//feedback`, note: "empty id", expect: [404] }),
    () => ({
      path: `/functions/v1/api/v1/Analyses/${id}/feedback`,
      note: "case in route",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/FEEDBACK`,
      note: "case in suffix",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v2/analyses/${id}/feedback`,
      note: "v2 prefix",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1//analyses/${id}/feedback`,
      note: "double slash",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback/../feedback`,
      note: "dot segment (URL normalizes)",
      expect: [201, 409],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback%2F`,
      note: "encoded slash suffix",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}%2Ffeedback/feedback`,
      note: "encoded slash in id (decodes to non-uuid)",
      expect: [400],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}%2Ffeedback`,
      note: "encoded slash, no suffix",
      expect: [404],
    }),
    () => ({
      path: `/v1/analyses/${id}/feedback/v1/analyses/${id}/feedback`,
      note: "path repeated (last /v1/ wins)",
      expect: [201, 409],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback#frag`,
      note: "fragment",
      expect: [201, 409],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback%00`,
      note: "encoded NUL suffix",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback;jsessionid=x`,
      note: "path param",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback\t`,
      note: "tab (URL strips)",
      expect: [201, 409],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${encodeURIComponent(id)}/feedback`,
      note: "encoded uuid (identity)",
      expect: [201, 409],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id.replace(/-/g, "%2D")}/feedback`,
      note: "dashes percent-encoded (decoded → valid)",
      expect: [201, 409],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id.toUpperCase()}/feedback`,
      note: "uppercase uuid",
      expect: [201, 409],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback/..`,
      note: "trailing dot-dot (URL → /analyses/id)",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/${"analyses/".repeat(3)}${id}/feedback`,
      note: "repeated analyses segments",
      expect: [404],
    }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/feedback?`,
      note: "empty query",
      expect: [201, 409],
    }),
    () => ({ path: `/analyses/${id}/feedback`, note: "no /v1/ at all", expect: [404] }),
    () => ({
      path: `/functions/v1/api/v1/analyses/${id}/../${id}/feedback`,
      note: "dot-dot through id (normalized)",
      expect: [201, 409],
    }),
  ];
  return rng.pick(variants)();
}

function badAuthVariant(
  rng: Rng,
  user: StressUser,
): { authorization: string | null; note: string; expect: number[] } {
  const variants: Array<() => { authorization: string | null; note: string; expect: number[] }> = [
    () => ({ authorization: null, note: "no authorization header", expect: [401] }),
    () => ({ authorization: "", note: "empty authorization", expect: [401] }),
    () => ({ authorization: "Bearer", note: "Bearer without token", expect: [401] }),
    () => ({ authorization: "Bearer ", note: "Bearer with empty token", expect: [401] }),
    () => ({
      authorization: `bearer ${user.providerToken}`,
      note: "lowercase scheme",
      expect: [401],
    }),
    () => ({ authorization: `Basic ${btoa("a:b")}`, note: "basic scheme", expect: [401] }),
    () => ({
      authorization: `Bearer ${user.providerToken.split(".").slice(0, 2).join(".")}`,
      note: "2-segment jwt",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer ${user.providerToken}.extra`,
      note: "4-segment jwt",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer ${user.providerToken.replace(/^[^.]+/, "!!!")}`,
      note: "bad header segment (payload intact)",
      expect: [201, 409],
    }),
    () => ({
      authorization: `Bearer ${user.providerToken.replace(/\.[^.]+\./, ".!!!.")}`,
      note: "non-base64 payload",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer a.${b64url('"just a string"')}.c`,
      note: "payload is json string",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer a.${b64url("null")}.c`,
      note: "payload is json null",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer a.${b64url("[1,2]")}.c`,
      note: "payload is json array",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer a.${b64url(JSON.stringify({ iss: "https://evil.example", sub: user.id, exp: 9e9 }))}.c`,
      note: "unknown issuer",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer a.${b64url(JSON.stringify({ iss: "https://accounts.google.com", sub: user.id, exp: 1 }))}.c`,
      note: "expired provider token",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer ${fakeSessionToken(user.id, 1)}`,
      note: "expired session token",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer a.${b64url(JSON.stringify({ iss: "https://accounts.google.com", exp: 9e9 }))}.c`,
      note: "provider token without sub (stub resolves TEST_USER_ID → owns nothing)",
      expect: [404],
    }),
    () => ({
      authorization: `Bearer ${fakeSessionToken(rng.uuidV4())}`,
      note: "session token for unknown user",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer ${fakeSessionToken(user.id).replace(/sig$/, "x".repeat(rng.int(1, 5000)))}`,
      note: "session token with huge signature",
      expect: [201, 409],
    }),
    () => ({
      authorization: `Bearer ${"A".repeat(rng.int(10_000, 200_000))}`,
      note: "giant opaque token",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer ${user.providerToken} ${user.providerToken}`,
      note: "two tokens",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer\t${user.providerToken}`,
      note: "tab separator",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer ${user.providerToken}\u0000`,
      note: "NUL suffix",
      expect: [401],
    }),
    () => ({
      authorization: `Bearer a.${b64url(JSON.stringify({ iss: `${SUPABASE_URL}/auth/v1`, sub: user.id }))}.c`,
      note: "session token without exp",
      expect: [201, 409],
    }),
    () => ({
      authorization: `Bearer a.${b64url(JSON.stringify({ iss: "x/auth/v1", sub: "not-a-uuid", exp: 9e9 }))}.c`,
      note: "session token non-uuid sub",
      expect: [401],
    }),
  ];
  return rng.pick(variants)();
}

function encodeBody(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

/** Build the scenario for one iteration seed. Pure: same seed → same request. */
export function generateScenario(world: World, seed: number, forcedKind?: ScenarioKind): Scenario {
  const rng = new Rng(seed);
  const kind = forcedKind ?? pickKind(rng);
  const userIndex = rng.int(0, world.users.length - 1);
  const user = world.users[userIndex];
  const otherUser =
    world.users[(userIndex + 1 + rng.int(0, world.users.length - 2)) % world.users.length];
  const shot = rng.pick(user.shots);
  const ip = rng.pick(world.ips);
  const bearer = rng.chance(0.5) ? user.providerToken : user.sessionToken;
  const shape = rng.int(0, 2);

  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer}`,
    "x-forwarded-for": ip,
    "content-type": "application/json",
  };
  let method = "POST";
  let path = pathFor(shot, shape);
  let body: string | Uint8Array | undefined = JSON.stringify(validBody(rng));
  let allowed: number[] = [201, 409];
  let mayWrite = true;
  let analysisId: string | null = shot.toLowerCase();
  let fault: FaultStage | null = null;
  let note = "";
  let streamedBytes: number | undefined;

  switch (kind) {
    case "valid":
      note = "owned shot, valid body";
      break;
    case "duplicate":
      // Same shot as "valid"; the runner submits it twice (second must 409).
      note = "owned shot submitted twice in a row";
      break;
    case "not_owned": {
      const foreign = rng.chance(0.5) ? rng.pick(otherUser.shots) : rng.uuidV4();
      path = pathFor(foreign, shape);
      analysisId = foreign.toLowerCase();
      allowed = [404];
      mayWrite = false;
      note = "shot owned by another user or nonexistent";
      break;
    }
    case "bad_id": {
      const v = badIdVariant(rng, shot);
      path = pathFor(v.id, shape);
      analysisId = null;
      allowed = v.expect;
      mayWrite = false;
      note = `bad id: ${v.note}`;
      break;
    }
    case "bad_body": {
      const v = badBodyVariant(rng);
      body = v.body;
      if (v.contentType) headers["content-type"] = v.contentType;
      if (v.note.includes("may write")) {
        allowed = [201, 409];
        mayWrite = true;
      } else if (v.note === "__proto__ key (literal)") {
        // {"rating":"not_quite","category":"other","__proto__":{...}} is a valid
        // not_quite submission; the proto key must be ignored, not crash.
        allowed = [201, 409];
        mayWrite = true;
      } else {
        allowed = [400];
        mayWrite = false;
      }
      note = `bad body: ${v.note}`;
      break;
    }
    case "bad_auth": {
      const v = badAuthVariant(rng, user);
      if (v.authorization === null) delete headers.authorization;
      else headers.authorization = v.authorization;
      allowed = v.expect;
      mayWrite = v.expect.includes(201);
      note = `bad auth: ${v.note}`;
      break;
    }
    case "bad_method":
      method = rng.pick(["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "PROPFIND"]);
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") body = undefined;
      allowed = [404, 405];
      mayWrite = false;
      note = `method ${method}`;
      break;
    case "bad_path": {
      const v = badPathVariant(rng, shot);
      path = v.path;
      allowed = v.expect;
      mayWrite = v.expect.includes(201);
      note = `bad path: ${v.note}`;
      break;
    }
    case "oversize": {
      const mode = rng.int(0, 2);
      if (mode === 0) {
        headers["content-length"] = String(5_000_001 + rng.int(0, 1_000_000));
        body = JSON.stringify(validBody(rng));
        note = "content-length header claims > 5MB (body small)";
      } else if (mode === 1) {
        const bytes = 5_000_001 + rng.int(0, 500_000);
        const padding = "x".repeat(bytes - 40);
        body = JSON.stringify({ rating: "accurate", pad: padding });
        streamedBytes = body.length;
        note = "actual body > 5MB without content-length";
      } else {
        const bytes = 5_000_001 + rng.int(0, 500_000);
        body = encodeBody("[".repeat(bytes));
        streamedBytes = bytes;
        note = "actual body > 5MB of '[' (parser bomb)";
      }
      allowed = [413];
      mayWrite = false;
      break;
    }
    case "fault":
      fault = rng.pick(["shots", "consent", "insert"] as const);
      allowed = [503];
      mayWrite = false;
      note = `db fault injected at ${fault}`;
      break;
    case "noise": {
      const n = rng.int(1, 4);
      for (let i = 0; i < n; i++) {
        const [name, make] = rng.pick(JUNK_HEADERS);
        headers[name] = make(rng);
      }
      path = pathFor(rng.chance(0.3) ? shot.toUpperCase() : shot, shape) + randomQuery(rng);
      if (headers["content-length"] !== undefined) {
        const declared = Number(headers["content-length"]);
        if (Number.isFinite(declared) && declared > 5_000_000) {
          allowed = [413];
          mayWrite = false;
        }
      }
      note = `noise headers/query: ${Object.keys(headers)
        .filter((h) => !["authorization", "x-forwarded-for", "content-type"].includes(h))
        .join(",")}`;
      break;
    }
  }

  return {
    seed,
    kind,
    method,
    url: `http://edge.test${path}`,
    headers,
    body,
    streamedBytes,
    fault,
    userIndex,
    analysisId,
    allowed,
    mayWrite,
    note,
  };
}

export function scenarioRequest(scenario: Scenario): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(scenario.headers)) {
    try {
      headers.set(k, v);
    } catch {
      // Header value rejected by the platform (e.g. control chars) — the
      // request is still sent without it; the generator note records it.
    }
  }
  const init: RequestInit = { method: scenario.method, headers };
  if (scenario.body !== undefined && scenario.method !== "GET" && scenario.method !== "HEAD") {
    if (scenario.streamedBytes !== undefined) {
      const bytes = typeof scenario.body === "string" ? encodeBody(scenario.body) : scenario.body;
      const chunk = 256 * 1024;
      let offset = 0;
      init.body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, Math.min(offset + chunk, bytes.byteLength)));
          offset += chunk;
        },
      });
    } else {
      init.body = scenario.body as BodyInit;
    }
  }
  return new Request(scenario.url, init);
}

// ---------------------------------------------------------------------------
// Oracle + runner.
// ---------------------------------------------------------------------------

export interface Outcome {
  i: number;
  seed: number;
  kind: ScenarioKind;
  note: string;
  method: string;
  path: string;
  status: number;
  expected: number[];
  ok: boolean;
  reasons: string[];
  writeAttempts: number;
  mutations: number;
  requestId: string | null;
  ms: number;
  bodyPreview: string;
  errorCode: string | null;
}

const STACK_PATTERNS = [
  /\n\s+at\s+\S+/,
  /file:\/\/\//,
  /\.ts:\d+:\d+/,
  /TypeError|ReferenceError|SyntaxError/,
];

export interface CheckContext {
  backend: FeedbackBackend;
  /** (analysisId|userId) pairs already written before this request. */
  alreadyWritten: boolean;
}

export async function evaluate(
  scenario: Scenario,
  response: Response,
  ctx: CheckContext,
  i: number,
  ms: number,
): Promise<Outcome> {
  const reasons: string[] = [];
  const status = response.status;
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const requestId = response.headers.get("x-request-id");

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (scenario.method !== "HEAD") reasons.push("body_not_json");
  }
  const errorCode =
    parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: { code?: unknown } }).error?.code ?? "")
      : null;

  // 1. Status contract.
  let expected = scenario.allowed;
  if (expected.includes(201) && expected.includes(409)) {
    // 409 is legitimate ONLY when this (analysis, user) pair was already
    // written; a fresh pair must be accepted, never refused as a duplicate.
    expected = expected.filter((s) => (ctx.alreadyWritten ? s !== 201 : s !== 409));
  }
  if (!expected.includes(status)) {
    if (status >= 500) reasons.push(`unexpected_5xx:${status}`);
    else if (status >= 400 && !BAD_INPUT_STATUSES.includes(status))
      reasons.push(`status_not_in_allowlist:${status}`);
    else reasons.push(`unexpected_status:${status}`);
  }

  // 2. Generic error bodies: never a marker, never a stack, always JSON+message.
  if (status >= 400) {
    if (text.includes(FAULT_MARKER)) reasons.push("leaked_db_detail");
    for (const p of STACK_PATTERNS) if (p.test(text)) reasons.push(`stack_like:${p.source}`);
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error: { message?: unknown } }).error?.message
        : undefined;
    if (scenario.method !== "HEAD" && typeof message !== "string")
      reasons.push("error_message_missing");
    if (status >= 500) {
      const genericOk =
        typeof message === "string" &&
        (message === "Something went wrong. Please try again." ||
          /is temporarily unavailable\. Please try again\.$/.test(message));
      if (!genericOk) reasons.push("5xx_body_not_generic");
    }
    if (status === 429) {
      if (!response.headers.get("retry-after")) reasons.push("429_without_retry_after");
    }
  } else if (status === 201) {
    const fb = (parsed as { feedback?: Record<string, unknown> } | null)?.feedback;
    if (!fb || typeof fb.id !== "string" || typeof fb.createdAt !== "string") {
      reasons.push("201_shape");
    }
    if (fb && typeof fb.analysisId === "string" && scenario.analysisId) {
      if (fb.analysisId.toLowerCase() !== scenario.analysisId)
        reasons.push("201_analysis_id_mismatch");
    }
  }

  // 3. Security headers on every JSON response.
  if (scenario.method !== "HEAD" && text.length > 0) {
    if (!contentType.includes("application/json"))
      reasons.push(`content_type:${contentType || "none"}`);
    if (response.headers.get("x-content-type-options") !== "nosniff")
      reasons.push("missing_nosniff");
    if (response.headers.get("cache-control") !== "no-store") reasons.push("missing_no_store");
  }

  // 3b. Request-id contract (http.ts resolveRequestId): every response has one;
  //     a well-formed client id is honoured, anything else is replaced by a
  //     minted UUID — arbitrary client bytes are never echoed.
  const clientRequestId = scenario.headers["x-request-id"];
  if (!requestId) reasons.push("missing_request_id");
  else if (clientRequestId !== undefined) {
    const wellFormed = REQUEST_ID_RE.test(clientRequestId.trim());
    if (wellFormed && requestId !== clientRequestId.trim()) reasons.push("request_id_not_honoured");
    if (!wellFormed && requestId === clientRequestId) reasons.push("request_id_echoed_junk");
    if (!wellFormed && !UUID_RE.test(requestId)) reasons.push("request_id_not_minted");
  } else if (!UUID_RE.test(requestId))
    reasons.push(`request_id_not_uuid:${requestId.slice(0, 40)}`);

  // 4. Writes: nothing persisted unless 201; no PostgREST write attempted for
  //    rejections that happen before the insert (everything but 409/insert-fault).
  const { writeAttempts, mutations } = ctx.backend.counters;
  if (status === 201) {
    if (mutations !== 1) reasons.push(`mutations_on_201:${mutations}`);
  } else {
    if (mutations !== 0) reasons.push(`mutation_on_${status}`);
    const insertFault = scenario.fault === "insert" && status === 503;
    if (status !== 409 && !insertFault && writeAttempts !== 0) {
      reasons.push(`write_attempt_on_${status}`);
    }
  }

  return {
    i,
    seed: scenario.seed,
    kind: scenario.kind,
    note: scenario.note,
    method: scenario.method,
    path: new URL(scenario.url).pathname.slice(0, 200),
    status,
    expected,
    ok: reasons.length === 0,
    reasons,
    writeAttempts,
    mutations,
    requestId,
    ms,
    bodyPreview: text.slice(0, 160),
    errorCode,
  };
}

export interface CampaignSummary {
  backend: string;
  campaignSeed: number;
  iterations: number;
  executed: number;
  failed: number;
  durationMs: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  fiveXx: Array<{ seed: number; status: number; kind: string; note: string }>;
  requestIdPresent: number;
  failures: Outcome[];
  rows: Outcome[];
}

export interface CampaignOptions {
  campaignSeed: number;
  iterations: number;
  /** Replay exactly one iteration seed (STRESS_REPLAY). */
  replaySeed?: number;
  keepRows?: boolean;
  onProgress?: (done: number) => void;
}

export async function runCampaign(
  env: StressEnv,
  options: CampaignOptions,
): Promise<CampaignSummary> {
  const { backend, world } = env;
  const rows: Outcome[] = [];
  const failures: Outcome[] = [];
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const fiveXx: CampaignSummary["fiveXx"] = [];
  let requestIdPresent = 0;
  let executed = 0;
  const started = performance.now();

  const seeds: number[] = [];
  if (options.replaySeed !== undefined) seeds.push(options.replaySeed >>> 0);
  else for (let i = 0; i < options.iterations; i++) seeds.push(iterSeed(options.campaignSeed, i));

  for (let i = 0; i < seeds.length; i++) {
    const scenario = generateScenario(world, seeds[i]);
    const repeats = scenario.kind === "duplicate" ? 2 : 1;
    for (let r = 0; r < repeats; r++) {
      const user = scenario.userIndex === null ? null : world.users[scenario.userIndex];
      const alreadyWritten =
        scenario.analysisId !== null && user !== null
          ? await backend.hasFeedback(scenario.analysisId, user.id)
          : false;
      resetCounters(backend);
      backend.fault = scenario.fault;
      const t0 = performance.now();
      let response: Response;
      try {
        response = await env.harness.handler(scenarioRequest(scenario));
      } catch (error) {
        // The real Deno.serve would turn this into a 500 with no body; a throw
        // escaping the handler is itself a finding.
        response = new Response(`HANDLER_THREW: ${String(error)}`, { status: 599 });
      } finally {
        backend.fault = null;
      }
      const ms = performance.now() - t0;
      const outcome = await evaluate(
        scenario,
        response,
        { backend, alreadyWritten },
        i,
        Math.round(ms * 100) / 100,
      );
      if (r === 1) outcome.note = `${outcome.note} (2nd delivery)`;
      executed += 1;
      byKind[scenario.kind] = (byKind[scenario.kind] ?? 0) + 1;
      byStatus[String(outcome.status)] = (byStatus[String(outcome.status)] ?? 0) + 1;
      if (outcome.requestId) requestIdPresent += 1;
      if (outcome.status >= 500) {
        fiveXx.push({
          seed: scenario.seed,
          status: outcome.status,
          kind: scenario.kind,
          note: outcome.note,
        });
      }
      if (!outcome.ok) failures.push(outcome);
      if (options.keepRows !== false) rows.push(outcome);
    }
    options.onProgress?.(i + 1);
  }

  return {
    backend: backend.name,
    campaignSeed: options.campaignSeed,
    iterations: seeds.length,
    executed,
    failed: failures.length,
    durationMs: Math.round(performance.now() - started),
    byKind,
    byStatus,
    fiveXx,
    requestIdPresent,
    failures,
    rows,
  };
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(n);
}

export async function writeArtifact(
  name: string,
  summary: CampaignSummary | (CampaignSummary & Record<string, unknown>),
): Promise<string | null> {
  const dir = Deno.env.get("STRESS_OUT");
  if (!dir) return null;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 1));
  return path;
}

export function describeFailures(summary: CampaignSummary, max = 25): string {
  return summary.failures
    .slice(0, max)
    .map(
      (f) =>
        `seed=${f.seed} kind=${f.kind} status=${f.status} expected=${f.expected.join("|")} reasons=${f.reasons.join(",")} note=${JSON.stringify(f.note)} body=${JSON.stringify(f.bodyPreview)}`,
    )
    .join("\n");
}
