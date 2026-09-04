// Stress/fuzz harness for POST /v1/me/consent/withdraw (stress_consent_withdraw_fuzz.test.ts).
//
// Boots the REAL ../index.ts with Deno.serve captured (no port), Supabase Auth
// + PostgREST + RevenueCat stubbed at the fetch layer, and a pluggable
// consent_records backend:
//   - MemoryBackend: an in-memory RLS/constraint model of public.consent_records
//   - PgBackend:     a real docker postgres:16 with every migration applied
//                    (./xc_pg_up.sh) — the PostgREST calls the edge makes are
//                    translated to SQL executed as role `authenticated` with
//                    the caller's JWT sub, so RLS, check constraints and the
//                    append-only trigger are the real ones.
// Everything is seeded: `Prng(seed)` reproduces any iteration exactly.

import { sanitizeUserText } from "../http.ts";

export const SUPABASE_URL = "http://stress-supabase.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const ROUTE_PATH = "/v1/me/consent/withdraw";
export const CONSENT_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"] as const;
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
export const MAX_JSON_BODY_BYTES = 5_000_000;

/** Statuses a REJECTED request may carry (lens contract). 200 is the accept path. */
export const ALLOWED_REJECT_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405, 413, 415, 429,
]);

// ─── seeded RNG (same generator as xc_concurrency_harness.ts) ───────────────

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
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  /** A string drawn from a deliberately nasty alphabet (ASCII, controls,
   * zero-width/bidi, astral emoji, lone surrogates, quotes/braces, SQL/HTML). */
  nastyString(maxLen: number): string {
    const len = this.int(0, maxLen);
    let out = "";
    for (let i = 0; i < len; i++) {
      const roll = this.next();
      if (roll < 0.45) out += String.fromCharCode(this.int(0x20, 0x7e));
      else if (roll < 0.55) out += String.fromCharCode(this.int(0x00, 0x1f));
      else if (roll < 0.62)
        out += this.pick(["\u200b", "\u200e", "\u202e", "\u2066", "\ufeff", "\u0085", "\u00a0"]);
      else if (roll < 0.72) out += this.pick(["😀", "🏓", "👨‍👩‍👧", "🇺🇸", "é", "ß", "中", "ع", "𐍈"]);
      else if (roll < 0.76) out += this.pick(["\ud800", "\udc00", "\udbff"]);
      else if (roll < 0.86)
        out += this.pick(["'", '"', "\\", "{", "}", "[", "]", ",", ":", "\n", "\t", "\r"]);
      else
        out += this.pick([
          "' OR 1=1 --",
          "<script>",
          "${x}",
          "%00",
          "%s",
          "\\u0000",
          "../",
          "--",
          ";",
        ]);
    }
    return out;
  }
}

// ─── consent_records backend ────────────────────────────────────────────────

export interface LedgerRow {
  user_id: string;
  scope: string;
  action: "grant" | "withdraw";
  consent_version: string | null;
  source?: string | null;
  device?: unknown;
  capture_mode?: string | null;
  created_at: string;
}

/** A PostgREST-shaped refusal (status + PostgREST/PG error body). */
export class RestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? "rest error"));
  }
}

export interface ConsentBackend {
  /** Rows visible to `bearerUserId` under RLS for `where user_id = eq.<filterUserId>`. */
  select(bearerUserId: string, filterUserId: string): Promise<LedgerRow[]>;
  /** Insert as role authenticated with sub = bearerUserId. Throws RestError. */
  insert(bearerUserId: string, row: Record<string, unknown>): Promise<void>;
  /** Owner-role setup: make `userId` exist and pre-fill its ledger (not a client path). */
  seed(userId: string, rows: LedgerRow[]): Promise<void>;
  /** Owner-role read of the whole ledger of a user (verification). */
  ledgerOf(userId: string): Promise<LedgerRow[]>;
  close(): Promise<void>;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Mirrors the constraints the migrations put on public.consent_records:
 * RLS (owner-only select/insert), action check, consent_records_bounds,
 * consent_records_device_size, user_id NOT NULL, FK to profiles (users known
 * to the backend), append-only (no update/delete route exists). */
export class MemoryBackend implements ConsentBackend {
  readonly rows: LedgerRow[] = [];
  readonly knownUsers = new Set<string>();
  private clock = 0;
  nextCreatedAt(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1) + this.clock * 1000).toISOString();
  }
  select(bearerUserId: string, filterUserId: string): Promise<LedgerRow[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.user_id === bearerUserId && r.user_id === filterUserId),
    );
  }
  insert(bearerUserId: string, row: Record<string, unknown>): Promise<void> {
    const userId = row.user_id;
    if (typeof userId !== "string" || !userId) {
      throw new RestError(400, { code: "23502", message: 'null value in column "user_id"' });
    }
    if (userId !== bearerUserId) {
      throw new RestError(403, {
        code: "42501",
        message: 'new row violates row-level security policy for table "consent_records"',
      });
    }
    if (!this.knownUsers.has(userId)) {
      throw new RestError(409, {
        code: "23503",
        message: 'insert or update on table "consent_records" violates foreign key constraint',
      });
    }
    const action = row.action;
    if (action !== "grant" && action !== "withdraw") {
      throw new RestError(400, { code: "23514", message: "consent_records_action_check" });
    }
    const scope = row.scope;
    if (typeof scope !== "string") {
      throw new RestError(400, { code: "23502", message: 'null value in column "scope"' });
    }
    const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
    const consentVersion = str(row.consent_version);
    const source = str(row.source);
    const captureMode = str(row.capture_mode);
    const device = row.device ?? null;
    const deviceBytes = device === null ? 0 : utf8Bytes(JSON.stringify(device)) + 8;
    if (
      scope.length > 50 ||
      (consentVersion?.length ?? 0) > 50 ||
      (source?.length ?? 0) > 100 ||
      (captureMode?.length ?? 0) > 50 ||
      deviceBytes > 4096
    ) {
      throw new RestError(400, {
        code: "23514",
        message:
          'new row for relation "consent_records" violates check constraint "consent_records_bounds"',
      });
    }
    this.rows.push({
      user_id: userId,
      scope,
      action,
      consent_version: consentVersion,
      source,
      device,
      capture_mode: captureMode,
      created_at: this.nextCreatedAt(),
    });
    return Promise.resolve();
  }
  seed(userId: string, rows: LedgerRow[]): Promise<void> {
    this.knownUsers.add(userId);
    for (const row of rows) {
      this.knownUsers.add(row.user_id);
      this.rows.push({ ...row, created_at: row.created_at || this.nextCreatedAt() });
    }
    return Promise.resolve();
  }
  ledgerOf(userId: string): Promise<LedgerRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.user_id === userId));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ─── fault injection ────────────────────────────────────────────────────────

export type Fault =
  | { at: "select" | "insert"; kind: "rest_error"; status: number; canary: string }
  | { at: "select" | "insert"; kind: "throw"; canary: string }
  | { at: "select" | "insert"; kind: "garbage"; canary: string }
  | { at: "auth"; kind: "status"; status: number; canary: string }
  | { at: "auth"; kind: "throw"; canary: string }
  | { at: "auth"; kind: "garbage"; canary: string };

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  backend: ConsentBackend;
  calls: RecordedCall[];
  /** Set per iteration; applies to EVERY matching upstream call until reset()
   * (so a connect failure stays failed across the handler's own retries). */
  fault: Fault | null;
  /** Fetches the stub did not recognise (must stay empty). */
  unexpected: string[];
  /** Sessions the auth stub refuses (sub → reason). */
  refusedSubs: Set<string>;
  /** Subs whose Supabase user carries no google/apple provider. */
  providerlessSubs: Set<string>;
  setBackend(backend: ConsentBackend): void;
  reset(): void;
  restCalls(method?: string): RecordedCall[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string =>
  btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function decodeJwtClaim(token: string, claim: string): string | null {
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const payload = JSON.parse(decodeURIComponent(escape(atob(padded))));
    return isRecord(payload) && typeof payload[claim] === "string"
      ? (payload[claim] as string)
      : null;
  } catch {
    return null;
  }
}
export const decodeJwtSub = (token: string): string | null => decodeJwtClaim(token, "sub");
export const decodeJwtIss = (token: string): string | null => decodeJwtClaim(token, "iss");

export function jwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  return `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...header }))}.${b64url(
    JSON.stringify(payload),
  )}.sig`;
}

export const googleIdToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwt({ iss: "https://accounts.google.com", sub, exp });
export const appleIdToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwt({ iss: "https://appleid.apple.com", sub, exp });
export const sessionToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    exp,
    session_id: `sess-${sub}`,
    role: "authenticated",
  });

/** The user a PostgREST bearer acts as: the stub's minted `session-for-<sub>`
 * access token (provider-token path) or the JWT sub (session-token path). */
function bearerUserOf(headers: Record<string, string>): string | null {
  const auth = headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token.startsWith("session-for-")) return token.slice("session-for-".length);
  return decodeJwtSub(token);
}

let harness: StressHarness | null = null;

/** `index.ts` reads AUTH_UPSTREAM_TIMEOUT_MS per Auth call. Injected Auth
 * socket faults ride its retry backoff up to that deadline (6 s default), so
 * the campaign shortens it — but ONLY while a stress request is in flight:
 * Deno.env is process-wide and shared by every test file `deno task test`
 * runs after this one, and the network-auth matrix needs the real default. */
const STRESS_AUTH_DEADLINE_MS = "2000";
const AUTH_DEADLINE_ENV = "AUTH_UPSTREAM_TIMEOUT_MS";
let inFlight = 0;
let previousAuthDeadline: string | undefined;

async function withShortAuthDeadline<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight === 0) {
    previousAuthDeadline = Deno.env.get(AUTH_DEADLINE_ENV);
    Deno.env.set(AUTH_DEADLINE_ENV, STRESS_AUTH_DEADLINE_MS);
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    if (inFlight === 0) {
      if (previousAuthDeadline === undefined) Deno.env.delete(AUTH_DEADLINE_ENV);
      else Deno.env.set(AUTH_DEADLINE_ENV, previousAuthDeadline);
    }
  }
}

export async function loadStressHarness(backend: ConsentBackend): Promise<StressHarness> {
  if (harness) {
    harness.setBackend(backend);
    harness.reset();
    return harness;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-test-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    backend,
    calls: [],
    fault: null,
    unexpected: [],
    refusedSubs: new Set(),
    providerlessSubs: new Set(),
    setBackend(next) {
      state.backend = next;
    },
    reset() {
      state.calls = [];
      state.fault = null;
      state.unexpected = [];
    },
    restCalls(method) {
      return state.calls.filter(
        (c) => c.url.startsWith(`${SUPABASE_URL}/rest/v1/`) && (!method || c.method === method),
      );
    },
  };

  const jsonResponse = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...extra },
    });

  const takeFault = (at: Fault["at"]): Fault | null =>
    state.fault && state.fault.at === at ? state.fault : null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    state.calls.push({ url, method: request.method, headers, body });

    if (url.startsWith(RC_URL)) {
      return jsonResponse(200, { request_date_ms: Date.now(), subscriber: {} });
    }

    // ── Supabase Auth
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      const fault = takeFault("auth");
      if (fault?.kind === "throw") throw new TypeError(`connection refused ${fault.canary}`);
      if (fault?.kind === "garbage")
        return new Response(`<html>${fault.canary}</html>`, { status: 200 });
      if (fault?.kind === "status") {
        return jsonResponse(fault.status, { error: "upstream", error_description: fault.canary });
      }
      const payload = isRecord(body) ? body : {};
      const token = typeof payload.id_token === "string" ? payload.id_token : "";
      const sub = decodeJwtSub(token);
      if (!sub || state.refusedSubs.has(sub)) {
        return jsonResponse(400, { error: "invalid_grant", error_description: "Bad ID token" });
      }
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      return jsonResponse(200, {
        access_token: `session-for-${sub}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: `refresh-${sub}`,
        user: {
          id: sub,
          aud: "authenticated",
          role: "authenticated",
          email: `${sub}@example.com`,
          app_metadata: { provider: payload.provider, providers: [payload.provider] },
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      });
    }
    if (url === `${SUPABASE_URL}/auth/v1/user`) {
      const fault = takeFault("auth");
      if (fault?.kind === "throw") throw new TypeError(`connection refused ${fault.canary}`);
      if (fault?.kind === "garbage")
        return new Response(`<html>${fault.canary}</html>`, { status: 200 });
      if (fault?.kind === "status") {
        return jsonResponse(fault.status, { message: fault.canary });
      }
      // Real GoTrue verifies the signature: only tokens IT issued pass. The
      // stub cannot check signatures, so it insists on its own issuer and a
      // sub it knows — anything else is refused exactly like a forged JWT.
      const token = (headers["authorization"] ?? "").replace(/^Bearer\s+/, "");
      const sub = decodeJwtSub(token);
      if (!sub || decodeJwtIss(token) !== `${SUPABASE_URL}/auth/v1` || state.refusedSubs.has(sub)) {
        return jsonResponse(401, { message: "invalid JWT: unable to parse or verify signature" });
      }
      const providerless = state.providerlessSubs.has(sub);
      return jsonResponse(200, {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: `${sub}@example.com`,
        app_metadata: providerless ? {} : { provider: "google", providers: ["google"] },
      });
    }

    // ── PostgREST: only consent_records is legal for this route.
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const parsed = new URL(url);
      const table = parsed.pathname.slice("/rest/v1/".length);
      const bearerUser = bearerUserOf(headers);
      if (table !== "consent_records" || !bearerUser) {
        state.unexpected.push(`${request.method} ${url}`);
        return jsonResponse(404, { code: "PGRST205", message: `table ${table} not stubbed` });
      }
      if (request.method === "GET") {
        const fault = takeFault("select");
        if (fault?.kind === "throw") throw new TypeError(`connection reset ${fault.canary}`);
        if (fault?.kind === "garbage")
          return new Response(`<html>${fault.canary}</html>`, { status: 200 });
        if (fault?.kind === "rest_error") {
          return jsonResponse(fault.status, {
            code: "XX000",
            message: fault.canary,
            details: `stack: at ${fault.canary}`,
            hint: null,
          });
        }
        const filter = parsed.searchParams.get("user_id") ?? "";
        const filterUser = filter.startsWith("eq.") ? filter.slice(3) : "";
        const select = (parsed.searchParams.get("select") ?? "*").replace(/\s+/g, "");
        const columns = select === "*" ? null : select.split(",");
        try {
          const rows = await state.backend.select(bearerUser, filterUser);
          const projected = rows.map((row) => {
            if (!columns) return row;
            const out: Record<string, unknown> = {};
            for (const c of columns)
              out[c] = (row as unknown as Record<string, unknown>)[c] ?? null;
            return out;
          });
          return jsonResponse(200, projected);
        } catch (error) {
          if (error instanceof RestError) return jsonResponse(error.status, error.body);
          throw error;
        }
      }
      if (request.method === "POST") {
        const fault = takeFault("insert");
        if (fault?.kind === "throw") throw new TypeError(`connection reset ${fault.canary}`);
        if (fault?.kind === "garbage")
          return new Response(`<html>${fault.canary}</html>`, { status: 201 });
        if (fault?.kind === "rest_error") {
          return jsonResponse(fault.status, {
            code: "XX000",
            message: fault.canary,
            details: `stack: at ${fault.canary}`,
            hint: null,
          });
        }
        const rows = Array.isArray(body) ? body : [body];
        try {
          for (const row of rows) {
            if (!isRecord(row)) throw new RestError(400, { code: "PGRST102", message: "bad body" });
            await state.backend.insert(bearerUser, row);
          }
          return new Response(null, { status: 201 });
        } catch (error) {
          if (error instanceof RestError) return jsonResponse(error.status, error.body);
          throw error;
        }
      }
      // consent_records is append-only: PATCH/DELETE are never expected.
      state.unexpected.push(`${request.method} ${url}`);
      return jsonResponse(405, { code: "42501", message: "permission denied" });
    }

    state.unexpected.push(`${request.method} ${url}`);
    return new Response(`unexpected fetch in stress test: ${request.method} ${url}`, {
      status: 599,
    });
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = (request) => withShortAuthDeadline(() => handler(request));
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../index.ts");
  harness = state;
  return state;
}

// ─── oracle helpers ─────────────────────────────────────────────────────────

export interface FoldedScope {
  scope: string;
  active: boolean;
  consentVersion: string | null;
  lastAction: "granted" | "withdrawn" | null;
  lastActionAt: string | null;
}

/** The production fold (index.ts foldConsentStatus) re-stated independently. */
export function expectedFold(rows: LedgerRow[]): FoldedScope[] {
  return CONSENT_SCOPES.map((scope) => {
    const last = rows.filter((r) => r.scope === scope).at(-1) ?? null;
    return {
      scope,
      active: last?.action === "grant",
      consentVersion: last?.consent_version ?? null,
      lastAction: last === null ? null : last.action === "grant" ? "granted" : "withdrawn",
      lastActionAt: last?.created_at ?? null,
    };
  });
}

/** The row withdrawConsent must send for a valid body over ledger `before`. */
export function expectedInsertRow(
  userId: string,
  before: LedgerRow[],
  body: Record<string, unknown>,
): Record<string, unknown> {
  const scope = body.scope as string;
  const latest = before.filter((r) => r.scope === scope).at(-1) ?? null;
  return {
    user_id: userId,
    scope,
    consent_version: latest?.consent_version ?? null,
    action: "withdraw",
    source: typeof body.source === "string" ? sanitizeUserText(body.source, 64) : null,
    device: typeof body.device === "string" ? sanitizeUserText(body.device, 512) : null,
  };
}

/** Tokens that must never reach a client: internal detail, stack frames,
 * table/host names, PostgREST/PG codes, the per-iteration canary. */
export const LEAK_PATTERNS: readonly RegExp[] = [
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/, // stack frame
  /\n\s+at\s/, // stack frame
  /PGRST\d+/,
  /\b42501\b|\b23514\b|\b23503\b|\b23502\b|\bXX000\b/,
  /consent_records/,
  /row-level security/i,
  /check constraint/i,
  /stress-supabase\.test/,
  /supabase-js|postgrest|node_modules|file:\/\//,
  /TypeError|RangeError|SyntaxError|ReferenceError/,
  /\.ts:\d+/,
];

export function leaks(text: string, canary?: string): string | null {
  if (canary && text.includes(canary)) return `canary ${canary}`;
  for (const re of LEAK_PATTERNS) if (re.test(text)) return re.source;
  return null;
}

/** C0 controls except \t \n \r, plus DEL and the C1 range. */
export function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

export function headersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => (out[k] = v));
  return out;
}
