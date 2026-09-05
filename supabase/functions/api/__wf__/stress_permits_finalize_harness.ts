// stress — shared harness for the POST /v1/analysis-permits/:id/finalize
// (release) route stress campaigns (stress_permits_finalize_*.test.ts).
//
// Loads the REAL handler (../index.ts, Deno.serve captured) in-process with
// globalThis.fetch replaced by a stateful fake of the three upstreams the
// route touches: Supabase Auth (GET /auth/v1/user, id-token exchange),
// PostgREST over `analysis_permits` (GET / PATCH with eq filters, RLS by
// bearer, the column-level UPDATE grant from 20260831160000, PostgREST's
// `Prefer: return=representation` + `Accept: application/vnd.pgrst.object+json`
// semantics that supabase-js `.select().maybeSingle()` relies on) and the
// `access_state` RPC. Every upstream call is recorded (method/url/status)
// and the fake can inject one seeded fault per upstream target, so a
// campaign can prove "generic 5xx, no stack trace, request-id present, no
// write on rejection" against the real code paths.
//
// Optional real-PostgREST bridge: when `fake.postgrestUrl` is set (see
// stress_permits_finalize_pg.test.ts), `/rest/v1/*` calls are forwarded to a
// real PostgREST (docker postgrest/postgrest) in front of a migrated
// postgres:16, and the fake signs HS256 session tokens with the PostgREST
// JWT secret so RLS runs as the real `authenticated` role.

import {
  b64url,
  isRecord,
  jwtPayload,
  Prng,
  sleep,
} from "./xc_concurrency_harness.ts";

export { b64url, isRecord, jwtPayload, Prng, sleep };

export const SUPABASE_URL = "http://supabase.stress.test";
export const ANON_KEY = "stress-anon-key";
export const SERVICE_ROLE_KEY = "stress-service-role-key";

export const RELEASABLE_OUTCOMES = [
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
] as const;

export const PERMIT_SELECT_COLUMNS = [
  "id",
  "status",
  "outcome",
  "created_at",
] as const;
/** 20260831160000_defense_in_depth.sql: `grant update (status, outcome)`. */
export const PERMIT_UPDATE_GRANT = new Set(["status", "outcome"]);

export interface StressPermit {
  id: string;
  user_id: string;
  idempotency_key: string;
  status: "reserved" | "finalized" | "released";
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

export interface StressSession {
  sessionId: string;
  userId: string;
  provider: "google" | "apple";
  accessToken: string;
  revoked: boolean;
}

export type FaultTarget =
  | "gotrue_user"
  | "gotrue_token"
  | "pg_select"
  | "pg_update"
  | "rpc_access";
export type FaultMode =
  | "http500_json" // 500 with a JSON error body
  | "http502_html" // 502 with an HTML gateway page
  | "http200_garbage" // 2xx whose body is not JSON
  | "http200_empty" // 2xx with an empty body
  | "throw" // fetch rejects once (socket-level failure; auth retries these)
  | "throw_sticky"; // every fetch to the target rejects until the request ends

export interface Fault {
  target: FaultTarget;
  mode: FaultMode;
}

export const FAULT_TARGETS: readonly FaultTarget[] = [
  "gotrue_user",
  "gotrue_token",
  "pg_select",
  "pg_update",
  "rpc_access",
];
export const FAULT_MODES: readonly FaultMode[] = [
  "http500_json",
  "http502_html",
  "http200_garbage",
  "http200_empty",
  "throw",
  "throw_sticky",
];

export interface UpstreamCall {
  method: string;
  url: string;
  /** "fault:<mode>" when the fake injected a fault instead of answering. */
  status: number | string;
  /** PATCH only: how many rows the fake mutated. */
  mutated?: number;
  /** Forwarded (real PostgREST) calls only: the upstream response body, truncated. */
  upstreamBody?: string;
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Postgres accepts more uuid spellings than the route's regex (case, braces,
 * no hyphens); the route only forwards regex-valid ids, so lowercasing is the
 * whole normalisation PostgREST's `uuid = uuid` comparison needs here. */
const PG_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseFilters(
  params: URLSearchParams,
): Array<{ column: string; value: string }> | Response {
  const filters: Array<{ column: string; value: string }> = [];
  for (const [key, raw] of params) {
    if (key === "select" || key === "on_conflict" || key === "columns") {
      continue;
    }
    if (!raw.startsWith("eq.")) {
      return jsonResponse(400, {
        code: "PGRST100",
        message: `stress fake: unmodelled operator in ${key}=${raw}`,
        details: null,
        hint: null,
      });
    }
    const value = raw.slice(3);
    if ((key === "id" || key === "user_id") && !PG_UUID_RE.test(value)) {
      return jsonResponse(400, {
        code: "22P02",
        message: `invalid input syntax for type uuid: "${value}"`,
        details: null,
        hint: null,
      });
    }
    filters.push({ column: key, value });
  }
  return filters;
}

function matches(
  row: StressPermit,
  filters: Array<{ column: string; value: string }>,
): boolean {
  return filters.every(({ column, value }) => {
    const cell = (row as unknown as Record<string, unknown>)[column];
    if (column === "id" || column === "user_id") {
      return typeof cell === "string" &&
        cell.toLowerCase() === value.toLowerCase();
    }
    return String(cell) === value;
  });
}

function project(
  row: StressPermit,
  select: string | null,
): Record<string, unknown> {
  const columns = select
    ? select
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
    : Object.keys(row);
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[column] = (row as unknown as Record<string, unknown>)[column];
  }
  return out;
}

/** PostgREST answer shape for a row set, honouring the headers supabase-js
 * sends for `.maybeSingle()` (GET: plain JSON array; PATCH: object accept,
 * 406 PGRST116 when the set is not exactly one row). */
function rowsResponse(
  request: Request,
  rows: Array<Record<string, unknown>>,
  status: number,
): Response {
  const accept = request.headers.get("accept") ?? "";
  const prefer = request.headers.get("prefer") ?? "";
  if (request.method !== "GET" && !prefer.includes("return=representation")) {
    return new Response(null, { status: 204 });
  }
  if (accept.includes("application/vnd.pgrst.object+json")) {
    if (rows.length !== 1) {
      return jsonResponse(406, {
        code: "PGRST116",
        details: `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      });
    }
    return jsonResponse(status, rows[0]);
  }
  return jsonResponse(status, rows);
}

/** Rows a real PostgREST PATCH (Prefer: return=representation) touched: the
 * representation is a JSON array (PostgREST >= 10 answers 200 `[]` for zero
 * rows; <= 9 answered 404 `[]`). Anything unparsable counts as no mutation. */
function patchedRows(status: number, body: string): number {
  if (status < 200 || status >= 300) return 0;
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed.length;
    return parsed && typeof parsed === "object" ? 1 : 0;
  } catch {
    return 0;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export class FinalizeFake {
  prng: Prng;
  latencyMaxMs: number;
  users = new Map<
    string,
    { id: string; email: string; provider: "google" | "apple" }
  >();
  sessions = new Map<string, StressSession>();
  permits: StressPermit[] = [];
  /** `{user_id, result_kind}` — only what access_state's scored count needs. */
  shots: Array<{ user_id: string; result_kind: string }> = [];
  premiumUsers = new Set<string>();
  /** Faults consumed FIFO by the first upstream call whose target matches. */
  faults: Fault[] = [];
  calls: UpstreamCall[] = [];
  counters: Record<string, number> = {};
  /** When set, `/rest/v1/*` is forwarded to this real PostgREST base URL. */
  postgrestUrl: string | null = null;
  /** Status a PATCH that matched zero rows answers with. PostgREST >= 10 says
   * 200 `[]`; PostgREST <= 9 said 404 `[]` (PostgREST#2343), which
   * postgrest-js turns into `data: []` without the maybeSingle collapse. */
  zeroRowPatchStatus: 200 | 404 = 200;
  /** One-shot hook run right before the next PATCH is applied — models a
   * concurrent writer (e.g. apply_synced_shot consuming the permit) that
   * commits between the route's SELECT and its guarded UPDATE. */
  beforePatch: (() => void) | null = null;
  private jwtKey: CryptoKey | null = null;
  private realFetch: typeof fetch;
  private mint = 0;
  private epoch = 0;

  constructor(seed: number, latencyMaxMs: number, realFetch: typeof fetch) {
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
    this.realFetch = realFetch;
  }

  reset(seed: number, latencyMaxMs = this.latencyMaxMs): void {
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
    this.users.clear();
    this.sessions.clear();
    this.permits = [];
    this.shots = [];
    this.premiumUsers.clear();
    this.faults = [];
    this.calls = [];
    this.counters = {};
    this.zeroRowPatchStatus = 200;
    this.beforePatch = null;
    this.mint = 0;
    this.epoch += 1;
  }

  /** Sign session tokens (real PostgREST bridge). */
  async useJwtSecret(secret: string): Promise<void> {
    this.jwtKey = await hmacKey(secret);
  }

  count(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  ensureUser(userId: string, provider: "google" | "apple" = "google"): void {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        provider,
      });
    }
  }

  /** Mint a Supabase-shaped access token. `exp` in unix seconds (default +1h). */
  async mintSession(
    userId: string,
    provider: "google" | "apple" = "google",
    options: { exp?: number; role?: string; sub?: string; iss?: string } = {},
  ): Promise<StressSession> {
    this.ensureUser(userId, provider);
    this.mint += 1;
    const sessionId = `stress-${this.epoch}.${this.mint}-${this.prng.uuid()}`;
    const payload = {
      iss: options.iss ?? `${SUPABASE_URL}/auth/v1`,
      sub: options.sub ?? userId,
      aud: "authenticated",
      role: options.role ?? "authenticated",
      session_id: sessionId,
      exp: options.exp ?? Math.floor(Date.now() / 1000) + 3600,
      jti: `${this.epoch}.${this.mint}-${this.prng.uuid()}`,
    };
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(payload));
    let signature = "sig";
    if (this.jwtKey) {
      const mac = await crypto.subtle.sign(
        "HMAC",
        this.jwtKey,
        new TextEncoder().encode(`${header}.${body}`),
      );
      signature = b64url(String.fromCharCode(...new Uint8Array(mac)));
    }
    const accessToken = `${header}.${body}.${signature}`;
    const session: StressSession = {
      sessionId,
      userId,
      provider,
      accessToken,
      revoked: false,
    };
    this.sessions.set(accessToken, session);
    return session;
  }

  addPermit(
    userId: string,
    status: StressPermit["status"] = "reserved",
    outcome: string | null = null,
    options: { ageMs?: number; id?: string; idempotencyKey?: string } = {},
  ): StressPermit {
    this.ensureUser(userId);
    const createdAt = new Date(Date.now() - (options.ageMs ?? 0)).toISOString();
    const row: StressPermit = {
      id: options.id ?? this.prng.uuid(),
      user_id: userId,
      idempotency_key: options.idempotencyKey ?? `key-${this.prng.uuid()}`,
      status,
      outcome,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.permits.push(row);
    return row;
  }

  snapshot(): string {
    return JSON.stringify(this.permits);
  }

  private principal(
    headers: Headers,
  ): { role: "service" | "user" | "anon"; userId: string | null } {
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === SERVICE_ROLE_KEY) return { role: "service", userId: null };
    if (!token || token === ANON_KEY) return { role: "anon", userId: null };
    const payload = jwtPayload(token);
    const sub = typeof payload?.sub === "string" ? payload.sub : null;
    return { role: "user", userId: sub };
  }

  private takeFault(target: FaultTarget): Fault | null {
    const index = this.faults.findIndex((f) => f.target === target);
    if (index < 0) return null;
    if (this.faults[index].mode === "throw_sticky") return this.faults[index];
    const [fault] = this.faults.splice(index, 1);
    return fault;
  }

  private faultResponse(fault: Fault): Response {
    switch (fault.mode) {
      case "http500_json":
        return jsonResponse(500, {
          code: "XX000",
          message: "stress fault: internal error",
          details: "at fakeUpstream (stress_permits_finalize_harness.ts:1:1)",
          hint: null,
        });
      case "http502_html":
        return new Response(
          "<html><body><h1>502 Bad Gateway</h1><pre>stack: at gw.js:1</pre></body></html>",
          {
            status: 502,
            headers: { "content-type": "text/html" },
          },
        );
      case "http200_garbage":
        return new Response("<<<not json>>> at stress_fault.ts:42", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      case "http200_empty":
        return new Response("", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      case "throw":
      case "throw_sticky":
        throw new TypeError("stress fault: connection reset (simulated)");
    }
  }

  private accessState(userId: string) {
    const scored =
      this.shots.filter((s) =>
        s.user_id === userId && s.result_kind === "scored"
      )
        .length;
    const cutoff = Date.now() - 24 * 3_600_000;
    const reserved = this.permits.filter(
      (p) =>
        p.user_id === userId && p.status === "reserved" &&
        Date.parse(p.created_at) > cutoff,
    ).length;
    return [{
      premium: this.premiumUsers.has(userId),
      scored_count: scored,
      reserved_count: reserved,
    }];
  }

  async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    const record = (
      status: number | string,
      extra: Partial<UpstreamCall> = {},
    ) => {
      this.calls.push({
        method: request.method,
        url: request.url,
        status,
        ...extra,
      });
    };
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        body = isRecord(parsed) ? parsed : {};
      } catch {
        body = {};
      }
    }

    if (url.origin !== SUPABASE_URL) {
      record(599);
      return new Response(
        `stress fake: unexpected upstream ${request.method} ${request.url}`,
        {
          status: 599,
        },
      );
    }

    // ── GoTrue ──
    if (url.pathname.startsWith("/auth/v1/")) {
      const path = url.pathname.slice("/auth/v1/".length);
      await this.latency();
      if (path === "user" && request.method === "GET") {
        this.count("gotrue.get_user");
        const fault = this.takeFault("gotrue_user");
        if (fault) {
          record(`fault:${fault.mode}`);
          return this.faultResponse(fault);
        }
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const session = this.sessions.get(bearer);
        if (!session || session.revoked) {
          record(403);
          return jsonResponse(403, {
            code: 403,
            error_code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          });
        }
        const user = this.users.get(session.userId)!;
        record(200);
        return jsonResponse(200, {
          id: user.id,
          aud: "authenticated",
          role: "authenticated",
          email: user.email,
          app_metadata: { provider: user.provider, providers: [user.provider] },
          user_metadata: {},
          created_at: new Date(0).toISOString(),
        });
      }
      if (path === "token" && request.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        this.count(`gotrue.token.${grant}`);
        const fault = this.takeFault("gotrue_token");
        if (fault) {
          record(`fault:${fault.mode}`);
          return this.faultResponse(fault);
        }
        if (grant === "id_token") {
          const idToken = typeof body.id_token === "string"
            ? body.id_token
            : "";
          const payload = jwtPayload(idToken);
          const sub = typeof payload?.sub === "string" ? payload.sub : "";
          const provider = body.provider === "apple" ? "apple" : "google";
          if (!sub || !this.users.has(sub)) {
            // Only subjects the scenario registered verify; anything else is
            // an unknown identity, refused exactly like a forged token.
            record(400);
            return jsonResponse(400, {
              error: "invalid_grant",
              error_description: "bad id token",
            });
          }
          const session = await this.mintSession(sub, provider);
          const user = this.users.get(sub)!;
          record(200);
          return jsonResponse(200, {
            access_token: session.accessToken,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: jwtPayload(session.accessToken)?.exp,
            refresh_token: `rt-${session.sessionId}`,
            user: {
              id: user.id,
              aud: "authenticated",
              role: "authenticated",
              email: user.email,
              app_metadata: {
                provider: user.provider,
                providers: [user.provider],
              },
              user_metadata: {},
              created_at: new Date(0).toISOString(),
            },
          });
        }
        record(400);
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      record(404);
      return jsonResponse(404, {
        msg: `stress fake: unmodelled auth path ${path}`,
      });
    }

    // ── PostgREST ──
    if (url.pathname.startsWith("/rest/v1/")) {
      if (this.postgrestUrl) {
        const target = `${this.postgrestUrl}${
          url.pathname.slice("/rest/v1".length)
        }${url.search}`;
        const forwarded = new Request(target, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD"
            ? undefined
            : rawBody,
        });
        const isRpc = url.pathname.startsWith("/rest/v1/rpc/");
        const faultTarget: FaultTarget = isRpc
          ? "rpc_access"
          : request.method === "PATCH"
          ? "pg_update"
          : "pg_select";
        const fault = this.takeFault(faultTarget);
        if (fault) {
          record(`fault:${fault.mode}`);
          return this.faultResponse(fault);
        }
        const response = await this.realFetch(forwarded);
        const upstreamBody = (await response.clone().text()).slice(0, 400);
        record(response.status, {
          upstreamBody,
          ...(request.method === "PATCH"
            ? { mutated: patchedRows(response.status, upstreamBody) }
            : {}),
        });
        return response;
      }
      const target = url.pathname.slice("/rest/v1/".length);
      const who = this.principal(request.headers);
      await this.latency();
      if (target.startsWith("rpc/")) {
        const fn = target.slice(4);
        if (fn === "access_state") {
          this.count("rpc.access_state");
          const fault = this.takeFault("rpc_access");
          if (fault) {
            record(`fault:${fault.mode}`);
            return this.faultResponse(fault);
          }
          if (!who.userId) {
            record(401);
            return jsonResponse(401, { message: "auth.required" });
          }
          record(200);
          return jsonResponse(200, this.accessState(who.userId));
        }
        record(404);
        return jsonResponse(404, {
          code: "PGRST202",
          message: `rpc ${fn} not modelled`,
        });
      }
      if (target !== "analysis_permits") {
        record(404);
        return jsonResponse(404, {
          code: "PGRST205",
          message: `table ${target} not modelled`,
        });
      }
      const filters = parseFilters(url.searchParams);
      if (filters instanceof Response) {
        record(filters.status);
        return filters;
      }
      // RLS: owner-only policies; anon has no grants at all.
      const visible = who.role === "service"
        ? this.permits
        : who.role === "user"
        ? this.permits.filter((p) => p.user_id === who.userId)
        : [];
      if (who.role === "anon") {
        record(401);
        return jsonResponse(401, {
          code: "42501",
          message: "permission denied for table analysis_permits",
          details: null,
          hint: null,
        });
      }
      if (request.method === "GET") {
        this.count("rest.get.analysis_permits");
        const fault = this.takeFault("pg_select");
        if (fault) {
          record(`fault:${fault.mode}`);
          return this.faultResponse(fault);
        }
        const rows = visible.filter((row) => matches(row, filters));
        record(200);
        return rowsResponse(
          request,
          rows.map((row) => project(row, url.searchParams.get("select"))),
          200,
        );
      }
      if (request.method === "PATCH") {
        this.count("rest.patch.analysis_permits");
        const fault = this.takeFault("pg_update");
        if (fault) {
          record(`fault:${fault.mode}`);
          return this.faultResponse(fault);
        }
        if (who.role === "user") {
          const ungranted = Object.keys(body).filter((k) =>
            !PERMIT_UPDATE_GRANT.has(k)
          );
          if (ungranted.length > 0) {
            record(403);
            return jsonResponse(403, {
              code: "42501",
              message: `permission denied for table analysis_permits`,
              details: null,
              hint: null,
            });
          }
        }
        if (this.beforePatch) {
          const hook = this.beforePatch;
          this.beforePatch = null;
          hook();
        }
        const rows = visible.filter((row) => matches(row, filters));
        const now = new Date().toISOString();
        for (const row of rows) {
          if (typeof body.status === "string") {
            row.status = body.status as StressPermit["status"];
          }
          if (body.outcome === null || typeof body.outcome === "string") {
            row.outcome = body.outcome as string | null;
          }
          row.updated_at = now;
        }
        const status = rows.length === 0 && this.zeroRowPatchStatus === 404
          ? 404
          : 200;
        record(status, { mutated: rows.length });
        return rowsResponse(
          request,
          rows.map((row) => project(row, url.searchParams.get("select"))),
          status,
        );
      }
      record(405);
      return jsonResponse(405, {
        message: `stress fake: ${request.method} not modelled`,
      });
    }
    record(404);
    return jsonResponse(404, {
      message: `stress fake: unmodelled path ${url.pathname}`,
    });
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FinalizeFake;
  realFetch: typeof fetch;
  /** The fake upstream, installable as `globalThis.fetch` for a test's duration. */
  fakeFetch: typeof fetch;
}

let loaded: StressHarness | null = null;

const AUTH_TIMEOUT_ENV = "AUTH_UPSTREAM_TIMEOUT_MS";
/** A socket-level auth fault would otherwise ride the route's 6 s deadline. */
const STRESS_AUTH_TIMEOUT_MS = "250";

/** Runs `fn` with the fake upstream installed as `globalThis.fetch` and the
 * shortened auth deadline in place, restoring BOTH afterwards — the suite
 * shares one process, and sibling tests time their own auth retries against
 * the default deadline. */
export async function withStressHarness<T>(
  fn: (h: StressHarness) => Promise<T>,
): Promise<T> {
  const h = await loadStressHarness();
  const previousFetch = globalThis.fetch;
  const previousTimeout = Deno.env.get(AUTH_TIMEOUT_ENV);
  globalThis.fetch = h.fakeFetch;
  Deno.env.set(AUTH_TIMEOUT_ENV, STRESS_AUTH_TIMEOUT_MS);
  try {
    return await fn(h);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTimeout === undefined) Deno.env.delete(AUTH_TIMEOUT_ENV);
    else Deno.env.set(AUTH_TIMEOUT_ENV, previousTimeout);
  }
}

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const realFetch = globalThis.fetch;
  const fake = new FinalizeFake(1, 0, realFetch);
  const fakeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.text().catch(() => "");
    return fake.handleFetch(request, rawBody);
  }) as typeof fetch;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | StressHarness["handler"]
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  loaded = { handler, fake, realFetch, fakeFetch };
  return loaded;
}

// ── Request building ─────────────────────────────────────────────────────────

export interface EdgeRequestSpec {
  method: string;
  /** Full pathname as the gateway would present it (e.g. /functions/v1/api/v1/...). */
  pathname: string;
  query?: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

export function buildRequest(spec: EdgeRequestSpec): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(spec.headers)) {
    headers.set(name, value);
  }
  const url = `http://edge.stress.test${spec.pathname}${spec.query ?? ""}`;
  const hasBody = spec.body !== undefined && spec.method !== "GET" &&
    spec.method !== "HEAD";
  return new Request(url, {
    method: spec.method,
    headers,
    body: hasBody ? (spec.body as BodyInit) : undefined,
  });
}

// ── Response assertions ──────────────────────────────────────────────────────

export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The two generic 5xx bodies index.ts is allowed to emit. */
export const GENERIC_5XX_RE =
  /^(?:[A-Za-z][A-Za-z -]* is temporarily unavailable\. Please try again\.|Something went wrong\. Please try again\.)$/;

/** Anything that would betray an implementation detail in a response body. */
export const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "stack frame", re: /\n\s+at\s+\S+|\bat\s+\S+\s+\(.+:\d+:\d+\)/ },
  { name: "source file", re: /\.(?:ts|js|mjs)(?::\d+)?\b/ },
  { name: "postgrest code", re: /\bPGRST\d+\b/ },
  { name: "sqlstate", re: /\b(?:42501|22P02|23505|XX000)\b/ },
  {
    name: "postgres wording",
    re: /\b(?:postgres|postgrest|supabase-js|permission denied|relation\b)/i,
  },
  {
    name: "error class",
    re: /\b(?:TypeError|RangeError|SyntaxError|ReferenceError)\b/,
  },
  { name: "fault marker", re: /stress fault/i },
  { name: "upstream host", re: /supabase\.stress\.test/ },
];

export interface ResponseAudit {
  status: number;
  requestId: string | null;
  contentType: string | null;
  bodyText: string;
  body: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  leaks: string[];
  generic5xx: boolean | null;
  retryAfter: string | null;
}

export async function auditResponse(
  response: Response,
): Promise<ResponseAudit> {
  const bodyText = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(bodyText);
    body = isRecord(parsed) ? parsed : null;
  } catch {
    body = null;
  }
  const error = body && isRecord(body.error) ? body.error : null;
  const errorMessage = error && typeof error.message === "string"
    ? error.message
    : null;
  const errorCode = error && typeof error.code === "string" ? error.code : null;
  const leaks = LEAK_PATTERNS.filter((p) => p.re.test(bodyText)).map((p) =>
    p.name
  );
  const generic5xx = response.status >= 500
    ? errorMessage !== null && GENERIC_5XX_RE.test(errorMessage) &&
      Object.keys(body ?? {}).length === 1
    : null;
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    bodyText,
    body,
    errorCode,
    errorMessage,
    leaks,
    generic5xx,
    retryAfter: response.headers.get("retry-after"),
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-permits-finalize/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

/** Derive a replayable per-iteration seed from the campaign seed. */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (iteration + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Capture console.error/warn/log emitted while `fn` runs (the handler's
 * `[api] …` error lines and access-log lines) without printing them. */
export async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  const sink = (level: string) => (...args: unknown[]) => {
    lines.push(
      `${level} ${
        args
          .map((a) => (typeof a === "string"
            ? a
            : a instanceof Error
            ? `${a.name}: ${a.message}`
            : JSON.stringify(a))
          )
          .join(" ")
      }`,
    );
  };
  console.log = sink("log");
  console.error = sink("error");
  console.warn = sink("warn");
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
}
