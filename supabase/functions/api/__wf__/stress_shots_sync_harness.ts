// stress-route-post-v1-shots — harness for fuzz/boundary campaigns against
// POST /v1/shots:sync.
//
// The REAL edge handler (../index.ts, Deno.serve captured) runs in-process.
// Every upstream call goes through a fetch stub that models Supabase Auth
// (id_token grant + GET /user) and hands PostgREST traffic to a pluggable
// backend:
//
//   MemoryBackend    — in-memory `shots` rows + a programmable
//                      apply_synced_shot responder (default: "accepted").
//   PostgresBackend  — bridges the two PostgREST calls the route makes
//                      (SELECT id FROM shots … and rpc/apply_synced_shot) to a
//                      real Postgres (docker postgres:16 + every migration),
//                      executed as role `authenticated` with the JWT sub the
//                      shim's auth.uid() reads — one transaction per call so
//                      concurrent copies of a request genuinely contend on the
//                      RPC's advisory lock. PostgREST itself is NOT in the
//                      loop: its JSON re-serialisation / error rendering is
//                      emulated, so anything that depends on PostgREST proper
//                      is labelled as such in the tests.
//
// Every upstream call is recorded (method, url, body, status) so a test can
// prove "no write happened" rather than infer it. Nothing here reaches a
// network. New file only — production code and existing tests are untouched.

import { type AccessLogEntry, captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const EDGE_ORIGIN = "http://edge.stress.test";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(segment: string): string {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
}

export function jwtPayload(token: string): unknown {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(segments[1]));
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

/** mulberry32 — deterministic, replayable from its 32-bit seed. */
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
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [item, w] of items) {
      roll -= w;
      if (roll < 0) return item;
    }
    return items[items.length - 1][0];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  ip(): string {
    return `${this.int(1, 223)}.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
  /** Printable ASCII of the given length. */
  ascii(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.int(0x21, 0x7e));
    return out;
  }
}

/** Derive an independent 32-bit seed for iteration `index` of `masterSeed`. */
export function iterationSeed(masterSeed: number, index: number): number {
  let x = (masterSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Google ID token accepted by the fake Auth (issuer routing only). */
export function fakeGoogleIdToken(sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string {
  return buildJwt({ iss: "https://accounts.google.com", sub, exp });
}

export function buildJwt(payload: unknown, header: unknown = { alg: "RS256", typ: "JWT" }): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
}

/** A Supabase session bearer the fake GET /auth/v1/user accepts. */
export function fakeSessionToken(sub: string, sessionId = crypto.randomUUID()): string {
  return buildJwt(
    {
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      // Only bearers this fake Auth minted verify; a hand-built session JWT
      // is `session_not_found`, like a real GoTrue would answer.
      minted_by: "stress-harness",
    },
    { alg: "HS256", typ: "JWT" },
  );
}

// ── Upstream model ───────────────────────────────────────────────────────────

export interface Principal {
  role: "service" | "user" | "anon";
  userId: string | null;
}

export interface RestCall {
  method: string;
  url: URL;
  /** `rpc/<fn>` → fn; otherwise null. */
  rpc: string | null;
  table: string;
  body: unknown;
  rawBody: string;
  headers: Headers;
  who: Principal;
}

export interface RestBackend {
  handle(call: RestCall): Promise<Response>;
}

export interface UpstreamCall {
  seq: number;
  method: string;
  url: string;
  kind: "auth" | "rest-read" | "rest-write" | "rpc" | "unexpected";
  body: unknown;
  status: number;
}

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function parseInList(raw: string): Set<string> {
  // PostgREST `in.(a,b,"c,d")`
  const inner = raw.slice(4, -1);
  const out = new Set<string>();
  let current = "";
  let quoted = false;
  for (const ch of inner) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.add(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0 || inner.length > 0) out.add(current);
  return out;
}

/** Filters the route uses on `shots`: user_id=eq.<uuid> and id=in.(…). */
export function shotsLookupFilter(url: URL): { userId: string | null; ids: string[] | null } {
  let userId: string | null = null;
  let ids: string[] | null = null;
  for (const [col, raw] of url.searchParams.entries()) {
    if (col === "select") continue;
    if (col === "user_id" && raw.startsWith("eq.")) {
      userId = raw.slice(3);
      continue;
    }
    if (col === "id" && raw.startsWith("in.(") && raw.endsWith(")")) {
      ids = [...parseInList(raw)];
      continue;
    }
    throw new Error(`stress harness: unsupported PostgREST filter ${col}=${raw}`);
  }
  return { userId, ids };
}

/** Thrown by a backend to make the upstream fetch itself reject (connection
 * refused / reset), as opposed to answering with an HTTP status. */
export class StressNetworkFault extends Error {
  constructor(message = "connection refused") {
    super(message);
    this.name = "StressNetworkFault";
  }
}

export type RpcResponder = (call: RestCall) => Response | unknown;

/** In-memory PostgREST: `shots` rows (id, user_id) + programmable RPCs. */
export class MemoryBackend implements RestBackend {
  shots: Array<{ id: string; user_id: string }> = [];
  /** Override: returns a Response (sent verbatim) or a JSON value (200). */
  rpcResponder: RpcResponder | null = null;
  private defaultRpc(call: RestCall): Response | unknown {
    if (call.rpc !== "apply_synced_shot") {
      return jsonResponse(404, { code: "PGRST202", message: `rpc ${call.rpc} not stubbed` });
    }
    const shot = isRecord(call.body) && isRecord(call.body.shot) ? call.body.shot : {};
    if (typeof shot.id === "string" && call.who.userId) {
      if (!this.shots.some((row) => row.id === shot.id && row.user_id === call.who.userId)) {
        this.shots.push({ id: shot.id, user_id: call.who.userId });
      }
    }
    return "accepted";
  }
  /** When set, answers the `shots` lookup instead of the table model. */
  lookupResponder: ((call: RestCall) => Response) | null = null;

  reset(): void {
    this.shots = [];
    this.lookupResponder = null;
    this.rpcResponder = null;
  }

  handle(call: RestCall): Promise<Response> {
    if (call.rpc !== null) {
      const answer = this.rpcResponder ? this.rpcResponder(call) : this.defaultRpc(call);
      return Promise.resolve(answer instanceof Response ? answer : jsonResponse(200, answer));
    }
    if (call.table === "shots" && call.method === "GET") {
      if (this.lookupResponder) return Promise.resolve(this.lookupResponder(call));
      const filter = shotsLookupFilter(call.url);
      const idSet = filter.ids ? new Set(filter.ids) : null;
      const rows = this.shots
        .filter((row) => call.who.role === "service" || row.user_id === call.who.userId)
        .filter((row) => filter.userId === null || row.user_id === filter.userId)
        .filter((row) => idSet === null || idSet.has(row.id))
        .map((row) => ({ id: row.id }));
      return Promise.resolve(jsonResponse(200, rows));
    }
    return Promise.resolve(
      new Response(`stress harness: unmodelled PostgREST call ${call.method} ${call.url}`, {
        status: 599,
      }),
    );
  }
}

// ── The handler ──────────────────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  memory: MemoryBackend;
  /** Swap the PostgREST layer (e.g. PostgresBackend). */
  setBackend(backend: RestBackend): void;
  /** Every upstream call in order since the last `drain()`. */
  calls: UpstreamCall[];
  drain(): UpstreamCall[];
  /** Fault injection for the fake Auth: return a Response to override. */
  authFault: ((request: Request) => Response | null) | null;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const memory = new MemoryBackend();
  let backend: RestBackend = memory;
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    memory,
    setBackend(next) {
      backend = next;
    },
    calls: [],
    drain() {
      const out = state.calls;
      state.calls = [];
      return out;
    },
    authFault: null,
  };
  let seq = 0;

  const principal = (headers: Headers): Principal => {
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === SERVICE_ROLE_KEY) return { role: "service", userId: null };
    if (!token || token === ANON_KEY) return { role: "anon", userId: null };
    const payload = jwtPayload(token);
    const sub = isRecord(payload) && typeof payload.sub === "string" ? payload.sub : null;
    return { role: "user", userId: sub };
  };

  const userJson = (id: string) => ({
    id,
    aud: "authenticated",
    role: "authenticated",
    email: `${id.slice(0, 8)}@example.com`,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  });

  const handleAuth = (request: Request, url: URL, body: unknown): Response => {
    const forced = state.authFault?.(request);
    if (forced) return forced;
    const path = url.pathname.slice("/auth/v1/".length);
    if (path === "token" && request.method === "POST") {
      if (url.searchParams.get("grant_type") !== "id_token") {
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      const idToken = isRecord(body) && typeof body.id_token === "string" ? body.id_token : "";
      const payload = jwtPayload(idToken);
      const sub = isRecord(payload) && typeof payload.sub === "string" ? payload.sub : "";
      if (!sub) {
        return jsonResponse(400, { error: "invalid_grant", error_description: "bad id token" });
      }
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return jsonResponse(200, {
        access_token: fakeSessionToken(sub),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: exp,
        refresh_token: `rt-${sub}`,
        user: userJson(sub),
      });
    }
    if (path === "user" && request.method === "GET") {
      const who = principal(request.headers);
      const auth = request.headers.get("authorization") ?? "";
      const payload = jwtPayload(auth.startsWith("Bearer ") ? auth.slice(7) : "");
      const iss = isRecord(payload) && typeof payload.iss === "string" ? payload.iss : "";
      const minted = isRecord(payload) && payload.minted_by === "stress-harness";
      if (who.role === "user" && who.userId && iss.endsWith("/auth/v1") && minted) {
        return jsonResponse(200, userJson(who.userId));
      }
      return jsonResponse(403, {
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      });
    }
    return jsonResponse(404, { msg: `stress harness: unmodelled auth path ${path}` });
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const url = new URL(request.url);
    const record: UpstreamCall = {
      seq: seq++,
      method: request.method,
      url: request.url,
      kind: "unexpected",
      body,
      status: 0,
    };
    state.calls.push(record);
    let response: Response;
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      record.kind = "auth";
      response = handleAuth(request, url, body);
    } else if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const target = url.pathname.slice("/rest/v1/".length);
      const rpc = target.startsWith("rpc/") ? target.slice(4) : null;
      record.kind = rpc !== null ? "rpc" : request.method === "GET" ? "rest-read" : "rest-write";
      try {
        response = await backend.handle({
          method: request.method,
          url,
          rpc,
          table: target,
          body,
          rawBody,
          headers: request.headers,
          who: principal(request.headers),
        });
      } catch (error) {
        if (error instanceof StressNetworkFault) {
          record.status = -1;
          throw new TypeError(`error sending request: ${error.message}`);
        }
        response = new Response(`stress harness backend threw: ${String(error)}`, {
          status: 599,
        });
      }
    } else {
      response = new Response(`stress harness: unexpected fetch ${request.method} ${request.url}`, {
        status: 599,
      });
    }
    record.status = response.status;
    return response;
  }) as typeof fetch;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  state.handler = handler;
  loaded = state;
  return state;
}

// ── Request builders ─────────────────────────────────────────────────────────

export interface RawRequestOptions {
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** Absolute URL override (path variants, other mount prefixes). */
  url?: string;
}

export function rawRequest(method: string, path: string, options: RawRequestOptions = {}): Request {
  const url = options.url ?? `${EDGE_ORIGIN}/functions/v1/api${path}`;
  return new Request(url, {
    method,
    headers: options.headers ?? {},
    body: options.body ?? undefined,
  });
}

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

/** A shot in the wire shape POST /v1/shots:sync validates (parseSyncShot). */
export function canonicalShot(
  id: string,
  analysisPermitId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    source: "real",
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

// ── Observation helpers ──────────────────────────────────────────────────────

export interface ConsoleCapture {
  lines: Array<{ level: "log" | "warn" | "error"; text: string }>;
  restore(): void;
}

/** Capture console output (the handler logs RPC failures and unhandled
 * errors) so a campaign stays readable AND the lines can be asserted on. */
export function captureConsole(): ConsoleCapture {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines: ConsoleCapture["lines"] = [];
  const render = (args: unknown[]) =>
    args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  console.log = (...args: unknown[]) => lines.push({ level: "log", text: render(args) });
  console.warn = (...args: unknown[]) => lines.push({ level: "warn", text: render(args) });
  console.error = (...args: unknown[]) => lines.push({ level: "error", text: render(args) });
  return {
    lines,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

export interface AccessLogCapture {
  entries: AccessLogEntry[];
  restore(): void;
}

export function captureAccess(): AccessLogCapture {
  const entries: AccessLogEntry[] = [];
  const restore = captureAccessLog((line) => {
    try {
      entries.push(JSON.parse(line) as AccessLogEntry);
    } catch {
      entries.push({
        evt: "api_request",
        requestId: `UNPARSEABLE:${line}`,
        method: "",
        route: "",
        status: -1,
        durationMs: 0,
      });
    }
  });
  return { entries, restore };
}

export async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return `<<unreadable body: ${String(error)}>>`;
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Token patterns a 4xx/5xx body must never carry (stack frames, file
 * paths, runtime or database internals). */
export const LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["stack-frame", /\n\s+at\s|\bat\s+\S+\s\(/],
  ["source-path", /\.ts:\d+|file:\/\/|\/functions\/api\//],
  ["runtime-error-name", /\b(TypeError|RangeError|SyntaxError|ReferenceError|URIError)\b/],
  ["postgres-internal", /PGRST\d+|\bSQLSTATE\b|\bpg_\w+|\bpublic\.\w+\(|\brelation\b.*\bdoes not exist/],
  ["supabase-internal", /supabase\.stress\.test|service_role|\bJWSError\b/],
];

export function leakFindings(text: string): string[] {
  const out: string[] = [];
  for (const [name, re] of LEAK_PATTERNS) if (re.test(text)) out.push(name);
  return out;
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-post-v1-shots/latest/", import.meta.url)
    .pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

/** FNV-1a 32-bit — a short, stable digest for payload rows in the table. */
export function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
