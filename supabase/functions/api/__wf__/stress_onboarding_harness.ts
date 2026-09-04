// stress-route-put-v1-me-onboarding — concurrency lens harness.
//
// Loads the REAL edge handler (../index.ts, Deno.serve captured) over a small
// stateful fake of exactly the upstreams PUT /v1/me/onboarding can reach:
// GoTrue (getUser / refresh / logout / id_token sign-in) and PostgREST on
// public.profiles (PATCH … RETURNING, GET). Every other upstream call is
// recorded as "unmodelled" and answered 599 so the tests can prove the route
// never fans out to permits / shots / RPCs / RevenueCat (no spend surface).
//
// The PostgREST model mirrors what the live schema enforces on the row:
//   - RLS profiles_update_own (only id = auth.uid() matches)
//   - column-level UPDATE grant from 20260831160000_defense_in_depth.sql
//   - CHECK constraints (handedness, gender, onboarding_state, text bounds,
//     first_name ≤ 80) → 23514 → HTTP 400
//   - row lock: concurrent PATCHes on one row serialize; each applies its
//     whole SET atomically and RETURNING reflects that statement's write
//   - the JWT exp check PostgREST performs (PGRST301 → HTTP 401)
// Every upstream call is delayed by a SEEDED latency so Promise.all bursts
// genuinely interleave, and every interleaving is replayable from its seed.
//
// Scale: STRESS_ITER (rounds per scenario, default 2 — fast enough for the
// suite), STRESS_BURST (lanes per burst, default 16), STRESS_LATENCY_MS
// (max seeded upstream latency, default 6), STRESS_SEED (default 20260904).
// Replay any scenario with the `replay` command in its JSON report, or a
// single round with the `replay` command on that round (STRESS_ROUND_SEED).

import { captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const ANON_KEY = "stress-anon-key";
export const SERVICE_ROLE_KEY = "stress-service-role-key";

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────────

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
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(items: T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  hex(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += this.int(0, 15).toString(16);
    return s;
  }
  uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-a${this.hex(3)}-${this.hex(12)}`;
  }
}

/** Collision-free-in-practice short id for a bearer (a bare 10-char suffix
 * of a JWT collides across tokens whose payloads differ only in the middle). */
export function bearerTail(token: string): string {
  const raw = token.startsWith("Bearer ") ? token.slice(7) : token;
  return `${fnv1a(raw).toString(16).padStart(8, "0")}:${raw.slice(-6)}`;
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── JWT helpers (routing-only tokens; the fake never verifies signatures) ───

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function fakeGoogleIdToken(sub: string, nonce = "", expSeconds?: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: expSeconds ?? Math.floor(Date.now() / 1000) + 3600,
      ...(nonce ? { nonce } : {}),
    }),
  );
  return `${header}.${payload}.sig`;
}

// ── Model ────────────────────────────────────────────────────────────────────

export interface FakeSession {
  sessionId: string;
  userId: string;
  provider: "google" | "apple";
  /** every access token ever minted for the session (old ones stay valid until exp) */
  accessTokens: Set<string>;
  refreshToken: string;
  usedRefreshTokens: Set<string>;
  revoked: boolean;
  revokedAtMs: number | null;
}

export interface ProfileRow {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  provider: string;
  onboarding_state: string;
  skill_level: string | null;
  handedness: string | null;
  primary_goal: string | null;
  biggest_problem: string | null;
  focus_checkpoint: string | null;
  first_name: string | null;
  gender: string | null;
  created_at: string;
  updated_at: string;
  /** committed write count for the row (stands in for xmin) */
  version: number;
}

export interface CommittedWrite {
  seq: number;
  userId: string;
  patch: Record<string, unknown>;
  bearerTail: string;
  atMs: number;
  /** the row exactly as this statement left it (what RETURNING saw) */
  rowAfter: ProfileRow;
}

export interface TimelineEntry {
  t: number;
  kind: string;
  detail: string;
}

/** Columns role `authenticated` may UPDATE (20260831160000_defense_in_depth.sql). */
export const PROFILE_UPDATE_GRANT = new Set([
  "provider",
  "onboarding_state",
  "skill_level",
  "focus_checkpoint",
  "handedness",
  "primary_goal",
  "biggest_problem",
  "first_name",
  "gender",
]);

const GENDERS = new Set(["female", "male", "nonbinary", "prefer_not_to_say"]);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function pgError(status: number, code: string, message: string, details = "", hint = "") {
  return jsonResponse(status, { code, message, details, hint });
}

/** CHECK constraints the live schema puts on public.profiles, as SQLSTATE 23514. */
export function checkProfileRow(row: ProfileRow): string | null {
  if (row.onboarding_state !== "pending" && row.onboarding_state !== "complete") {
    return "profiles_onboarding_state_check";
  }
  if (row.handedness !== null && row.handedness !== "right" && row.handedness !== "left") {
    return "profiles_handedness_check";
  }
  if (row.gender !== null && !GENDERS.has(row.gender)) return "profiles_gender_check";
  if (row.first_name !== null && row.first_name.length > 80) return "profiles_first_name_length";
  const len = (v: string | null) => (v === null ? 0 : v.length);
  if (
    len(row.email) > 320 ||
    len(row.display_name) > 200 ||
    len(row.avatar_url) > 2048 ||
    row.provider.length > 50 ||
    len(row.skill_level) > 100 ||
    len(row.focus_checkpoint) > 100 ||
    len(row.primary_goal) > 200 ||
    len(row.biggest_problem) > 500
  ) {
    return "profiles_text_bounds";
  }
  return null;
}

export class FakeSupabase {
  prng: Prng;
  latencyMs: number;
  users = new Map<string, { id: string; email: string; provider: "google" | "apple" }>();
  sessions = new Map<string, FakeSession>();
  accessIndex = new Map<string, string>();
  refreshIndex = new Map<string, string>();
  profiles = new Map<string, ProfileRow>();
  counters: Record<string, number> = {};
  timeline: TimelineEntry[] = [];
  writes: CommittedWrite[] = [];
  unmodelled: string[] = [];
  /** PostgREST-level statement failures (grant / constraint / jwt) in order. */
  pgFailures: Array<{ code: string; detail: string; bearerTail: string }> = [];
  /** provider ID token → the session access token GoTrue minted for it */
  exchanged = new Map<string, string>();
  private rowLocks = new Map<string, Promise<void>>();
  private t0 = performance.now();
  private mint = 0;
  private seq = 0;
  /** Extra response-path delay for GET /auth/v1/user of a given bearer. */
  getUserDelayMs: ((bearer: string) => number) | null = null;
  /** Extra delay inside the PATCH row lock (statement execution time). */
  patchHoldMs: ((userId: string) => number) | null = null;
  /** Force GoTrue getUser to fail with a given status for a bearer (0 = normal). */
  getUserForce: ((bearer: string) => number) | null = null;

  constructor(seed: number, latencyMs: number) {
    this.prng = new Prng(seed);
    this.latencyMs = latencyMs;
  }

  reset(seed: number, latencyMs: number): void {
    this.prng = new Prng(seed);
    this.latencyMs = latencyMs;
    this.users.clear();
    this.sessions.clear();
    this.accessIndex.clear();
    this.refreshIndex.clear();
    this.profiles.clear();
    this.counters = {};
    this.timeline = [];
    this.writes = [];
    this.unmodelled = [];
    this.pgFailures = [];
    this.exchanged.clear();
    this.rowLocks.clear();
    this.t0 = performance.now();
    this.mint = 0;
    this.seq = 0;
    this.getUserDelayMs = null;
    this.patchHoldMs = null;
    this.getUserForce = null;
  }

  count(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  log(kind: string, detail: string): void {
    this.timeline.push({
      t: Math.round((performance.now() - this.t0) * 100) / 100,
      kind,
      detail,
    });
  }

  private latency(): Promise<void> {
    return this.latencyMs > 0 ? sleep(this.prng.int(0, this.latencyMs)) : Promise.resolve();
  }

  /** auth.users row + the signup trigger's profiles row (handle_new_user). */
  createUser(userId: string, provider: "google" | "apple" = "google"): ProfileRow {
    const email = `${userId.slice(0, 8)}@stress.test`;
    this.users.set(userId, { id: userId, email, provider });
    const now = new Date().toISOString();
    const row: ProfileRow = {
      id: userId,
      email,
      display_name: null,
      avatar_url: null,
      provider,
      onboarding_state: "pending",
      skill_level: null,
      handedness: null,
      primary_goal: null,
      biggest_problem: null,
      focus_checkpoint: null,
      first_name: null,
      gender: null,
      created_at: now,
      updated_at: now,
      version: 0,
    };
    this.profiles.set(userId, row);
    return row;
  }

  accessTokenFor(session: FakeSession, expSeconds: number): string {
    this.mint += 1;
    const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: session.userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: session.sessionId,
          exp: expSeconds,
          jti: `${this.mint}-${this.prng.uuid()}`,
        }),
      )
    }.sig`;
    session.accessTokens.add(token);
    this.accessIndex.set(token, session.sessionId);
    return token;
  }

  mintSession(
    userId: string,
    sessionId?: string,
    expSeconds = Math.floor(Date.now() / 1000) + 3600,
  ): { session: FakeSession; accessToken: string } {
    const user = this.users.get(userId);
    if (!user) throw new Error(`stress: mintSession for unknown user ${userId}`);
    const sid = sessionId ?? `sess-${this.prng.uuid()}`;
    let session = this.sessions.get(sid);
    if (!session) {
      session = {
        sessionId: sid,
        userId,
        provider: user.provider,
        accessTokens: new Set(),
        refreshToken: "",
        usedRefreshTokens: new Set(),
        revoked: false,
        revokedAtMs: null,
      };
      this.sessions.set(sid, session);
    } else {
      session.usedRefreshTokens.add(session.refreshToken);
    }
    const accessToken = this.accessTokenFor(session, expSeconds);
    session.refreshToken = `rt-${this.prng.uuid()}`;
    this.refreshIndex.set(session.refreshToken, sid);
    return { session, accessToken };
  }

  userJson(userId: string) {
    const user = this.users.get(userId)!;
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    };
  }

  sessionJson(session: FakeSession, accessToken: string) {
    const payload = jwtPayload(accessToken)!;
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: payload.exp,
      refresh_token: session.refreshToken,
      user: this.userJson(session.userId),
    };
  }

  private async withRowLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.rowLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.rowLocks.set(
      userId,
      prev.then(() => mine),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** PostgREST's own bearer handling: role from the JWT, exp enforced. */
  private principal(headers: Headers): { userId: string | null; response: Response | null } {
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || token === ANON_KEY || token === SERVICE_ROLE_KEY) {
      return { userId: null, response: null };
    }
    const payload = jwtPayload(token);
    if (!payload || typeof payload.sub !== "string") {
      return { userId: null, response: pgError(401, "PGRST301", "JWT is malformed") };
    }
    if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
      this.count("postgrest.jwt_expired");
      this.pgFailures.push({ code: "PGRST301", detail: "JWT expired", bearerTail: bearerTail(token) });
      return { userId: null, response: pgError(401, "PGRST301", "JWT expired") };
    }
    return { userId: payload.sub, response: null };
  }

  project(row: ProfileRow, select: string | null): Record<string, unknown> {
    if (!select || select === "*") {
      const { version: _v, ...rest } = row;
      return rest;
    }
    const out: Record<string, unknown> = {};
    for (const raw of select.split(",")) {
      const col = raw.trim();
      if (!col) continue;
      if (!(col in row) || col === "version") {
        throw new Error(`stress: select of unknown profiles column ${col}`);
      }
      out[col] = (row as unknown as Record<string, unknown>)[col];
    }
    return out;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rawBody = await request.text().catch(() => "");
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON
    }

    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      return await this.handleAuth(url, request, body);
    }
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      return await this.handleRest(url, request, body);
    }
    this.count("unmodelled");
    this.unmodelled.push(`${request.method} ${url.origin}${url.pathname}`);
    this.log("unmodelled", `${request.method} ${url.href}`);
    return jsonResponse(599, { message: `stress harness: unmodelled upstream ${url.href}` });
  }

  private async handleAuth(url: URL, request: Request, body: Record<string, unknown>) {
    const path = url.pathname.slice("/auth/v1/".length);
    const auth = request.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (path === "token" && request.method === "POST") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "id_token") {
        this.count("gotrue.token.id_token");
        await this.latency();
        const payload = jwtPayload(typeof body.id_token === "string" ? body.id_token : "");
        const sub = typeof payload?.sub === "string" ? payload.sub : "";
        if (!sub) {
          return jsonResponse(400, { error: "invalid_grant", error_description: "bad id token" });
        }
        if (!this.users.has(sub)) this.createUser(sub, body.provider === "apple" ? "apple" : "google");
        const minted = this.mintSession(sub);
        if (typeof body.id_token === "string") this.exchanged.set(body.id_token, minted.accessToken);
        this.log(
          "gotrue.id_token",
          `bearer=${bearerTail(String(body.id_token))} user=${sub} session=${minted.session.sessionId}`,
        );
        return jsonResponse(200, this.sessionJson(minted.session, minted.accessToken));
      }
      if (grant === "refresh_token") {
        this.count("gotrue.token.refresh");
        await this.latency();
        const rt = typeof body.refresh_token === "string" ? body.refresh_token : "";
        const sid = this.refreshIndex.get(rt);
        const session = sid ? this.sessions.get(sid) : undefined;
        if (!session || session.revoked || session.usedRefreshTokens.has(rt)) {
          this.log("gotrue.refresh", `rt=${rt.slice(0, 12)} → 400 invalid_grant`);
          return jsonResponse(400, {
            error: "invalid_grant",
            error_code: session && !session.revoked ? "refresh_token_already_used" : "refresh_token_not_found",
            error_description: "Invalid Refresh Token",
          });
        }
        const rotated = this.mintSession(session.userId, session.sessionId);
        this.log("gotrue.refresh", `session=${session.sessionId} rotated`);
        return jsonResponse(200, this.sessionJson(rotated.session, rotated.accessToken));
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }
    if (path === "user" && request.method === "GET") {
      this.count("gotrue.get_user");
      await this.latency();
      const forced = this.getUserForce?.(bearer) ?? 0;
      if (forced) {
        this.log("gotrue.get_user", `bearer=${bearerTail(bearer)} → forced ${forced}`);
        return jsonResponse(forced, { code: forced, msg: "stress: forced" });
      }
      const sid = this.accessIndex.get(bearer);
      const session = sid ? this.sessions.get(sid) : undefined;
      const extra = this.getUserDelayMs?.(bearer) ?? 0;
      if (!session || session.revoked) {
        this.log("gotrue.get_user", `bearer=${bearerTail(bearer)} → 403 session_not_found`);
        if (extra > 0) await sleep(extra);
        return jsonResponse(403, {
          code: 403,
          error_code: "session_not_found",
          msg: "Session from session_id claim in JWT does not exist",
        });
      }
      this.log("gotrue.get_user", `bearer=${bearerTail(bearer)} → 200 user=${session.userId}`);
      if (extra > 0) await sleep(extra);
      return jsonResponse(200, this.userJson(session.userId));
    }
    if (path === "logout" && request.method === "POST") {
      this.count("gotrue.logout");
      await this.latency();
      const sid = this.accessIndex.get(bearer);
      const session = sid ? this.sessions.get(sid) : undefined;
      if (session) {
        session.revoked = true;
        session.revokedAtMs = performance.now();
        this.log("gotrue.logout", `session=${session.sessionId} revoked`);
      } else {
        this.log("gotrue.logout", `bearer=${bearerTail(bearer)} unknown`);
      }
      return new Response(null, { status: 204 });
    }
    this.count("unmodelled");
    this.unmodelled.push(`${request.method} ${url.pathname}`);
    return jsonResponse(404, { msg: `stress harness: unmodelled auth path ${path}` });
  }

  private async handleRest(url: URL, request: Request, body: Record<string, unknown>) {
    const target = url.pathname.slice("/rest/v1/".length);
    if (target !== "profiles") {
      this.count("unmodelled");
      this.unmodelled.push(`${request.method} /rest/v1/${target}`);
      this.log("unmodelled", `${request.method} /rest/v1/${target}`);
      return pgError(404, "PGRST205", `stress harness: unmodelled relation ${target}`);
    }
    await this.latency();
    const who = this.principal(request.headers);
    if (who.response) return who.response;
    const filter = url.searchParams.get("id");
    if (!filter || !filter.startsWith("eq.")) {
      return pgError(400, "PGRST100", `stress harness: unsupported profiles filter ${url.search}`);
    }
    const targetId = filter.slice(3);
    const select = url.searchParams.get("select");
    // RLS: authenticated sees/updates only its own row; anon sees nothing.
    const visible = who.userId !== null && who.userId === targetId ? this.profiles.get(targetId) : undefined;

    if (request.method === "GET") {
      this.count("postgrest.profiles.get");
      const rows = visible ? [this.project(visible, select)] : [];
      this.log("pg.select", `uid=${who.userId?.slice(0, 8)} → ${rows.length} row`);
      return jsonResponse(200, rows);
    }
    if (request.method === "PATCH") {
      this.count("postgrest.profiles.patch");
      const tail = bearerTail(request.headers.get("authorization") ?? "");
      for (const col of Object.keys(body)) {
        if (!PROFILE_UPDATE_GRANT.has(col)) {
          this.count("postgrest.grant_denied");
          this.pgFailures.push({ code: "42501", detail: `column ${col}`, bearerTail: tail });
          return pgError(403, "42501", `permission denied for table profiles`);
        }
      }
      if (!visible) {
        // RLS filtered every row: PostgREST answers 200 [] (no lock taken).
        this.log("pg.update", `uid=${who.userId?.slice(0, 8)} target=${targetId.slice(0, 8)} → 0 rows`);
        return jsonResponse(200, []);
      }
      return await this.withRowLock(targetId, async () => {
        const hold = this.patchHoldMs?.(targetId) ?? 0;
        if (hold > 0) await sleep(hold);
        const row = this.profiles.get(targetId)!;
        const candidate: ProfileRow = { ...row, ...(body as Partial<ProfileRow>) };
        const violated = checkProfileRow(candidate);
        if (violated) {
          this.count("postgrest.check_violation");
          this.pgFailures.push({ code: "23514", detail: violated, bearerTail: tail });
          this.log("pg.update", `uid=${targetId.slice(0, 8)} → 23514 ${violated}`);
          return pgError(
            400,
            "23514",
            `new row for relation "profiles" violates check constraint "${violated}"`,
          );
        }
        candidate.updated_at = new Date().toISOString();
        candidate.version = row.version + 1;
        this.profiles.set(targetId, candidate);
        this.seq += 1;
        this.writes.push({
          seq: this.seq,
          userId: targetId,
          patch: { ...body },
          bearerTail: tail,
          atMs: performance.now(),
          rowAfter: { ...candidate },
        });
        this.log("pg.update", `uid=${targetId.slice(0, 8)} v${candidate.version} seq=${this.seq}`);
        const wantsRepresentation = (request.headers.get("prefer") ?? "").includes("return=representation");
        if (!wantsRepresentation) return new Response(null, { status: 204 });
        return jsonResponse(200, [this.project(candidate, select)]);
      });
    }
    this.count("unmodelled");
    this.unmodelled.push(`${request.method} /rest/v1/profiles`);
    return pgError(405, "PGRST", `stress harness: unmodelled ${request.method} on profiles`);
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  upstreamCalls: Array<{ t: number; method: string; url: string }>;
  /** access-log lines the handler emitted (captured, not printed) */
  accessLog: string[];
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

  const fake = new FakeSupabase(1, 0);
  const upstreamCalls: StressHarness["upstreamCalls"] = [];
  const accessLog: string[] = [];
  captureAccessLog((line) => {
    accessLog.push(line);
    if (accessLog.length > 5_000) accessLog.splice(0, accessLog.length - 5_000);
  });
  const t0 = performance.now();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    upstreamCalls.push({
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      url: request.url,
    });
    return await fake.handle(request);
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
  loaded = { handler, fake, upstreamCalls, accessLog };
  return loaded;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    rawBody?: BodyInit;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.7",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const init: RequestInit = {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal,
  };
  if (options.rawBody instanceof ReadableStream) {
    (init as RequestInit & { duplex: string }).duplex = "half";
  }
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, init);
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw: text };
  }
}

// ── Onboarding payload space ─────────────────────────────────────────────────

/** Mirrors GOAL_FOCUS in ../index.ts (contract: focus_checkpoint = GOAL_FOCUS[goal]). */
export const GOAL_FOCUS: Record<string, string> = {
  dinks: "contact_position",
  drives: "preparation",
  drops: "paddle_set",
  serve: "sequencing",
  return: "athletic_base",
  volleys: "face_wrist_stability",
  footwork: "athletic_base",
  "all-around": "contact_position",
};
export const GOALS = Object.keys(GOAL_FOCUS);
export const SKILL_LEVELS = ["2.0", "2.5", "3.0", "3.5", "4.0", "4.5", "5.0", "beginner", "intermediate", "advanced"];
export const PROBLEMS = [
  "popping up dinks",
  "late contact on drives",
  "third shot drops sail long",
  "serve toss inconsistent",
  "footwork at the kitchen line",
  "paddle face opens on volleys",
];
export const GENDER_OPTIONS = ["female", "male", "nonbinary", "prefer_not_to_say"];
export const FIRST_NAMES = ["Ava", "Noah", "Mia", "Liam", "Zoë", "Émile", "Sofía", "Kai"];

export interface OnboardingPayload {
  skillLevel: string;
  handedness: "right" | "left";
  goal: string;
  biggestProblem: string;
  firstName?: string;
  gender?: string;
}

export function randomPayload(prng: Prng): OnboardingPayload {
  const p: OnboardingPayload = {
    skillLevel: prng.pick(SKILL_LEVELS),
    handedness: prng.chance(0.5) ? "right" : "left",
    goal: prng.pick(GOALS),
    biggestProblem: prng.pick(PROBLEMS),
  };
  if (prng.chance(0.5)) p.firstName = prng.pick(FIRST_NAMES);
  if (prng.chance(0.5)) p.gender = prng.pick(GENDER_OPTIONS);
  return p;
}

/** The columns the 200 body's `profile` must echo for `payload` (the route
 * selects these seven; onboarding_state is not part of the response). */
export function expectedProfileEcho(payload: OnboardingPayload): Record<string, unknown> {
  const { onboarding_state: _state, ...echo } = expectedColumns(payload);
  return echo;
}

/** The profile columns a 200 for `payload` must have written (contract). */
export function expectedColumns(payload: OnboardingPayload): Record<string, unknown> {
  const cols: Record<string, unknown> = {
    skill_level: payload.skillLevel,
    handedness: payload.handedness,
    primary_goal: payload.goal,
    biggest_problem: payload.biggestProblem,
    focus_checkpoint: GOAL_FOCUS[payload.goal] ?? "contact_position",
    onboarding_state: "complete",
  };
  if (payload.firstName !== undefined) cols.first_name = payload.firstName;
  if (payload.gender !== undefined) cols.gender = payload.gender;
  return cols;
}

// ── Reports ──────────────────────────────────────────────────────────────────

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface ScenarioReport {
  scenario: string;
  seed: number;
  scale: Record<string, number>;
  /** seed → outcome table, one entry per round (a round is replayable alone) */
  rounds: Array<{ round: number; seed: number; outcome: "HELD" | "BROKEN"; detail: string; replay: string }>;
  statusHistogram: Record<string, number>;
  counters: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  requestsExecuted: number;
  durationMs: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  replay: string;
  timeline?: TimelineEntry[];
}

export function histogram(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = (out[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-put-v1-me-onboarding/latest/", import.meta.url)
    .pathname;
}

export async function writeReport(report: ScenarioReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

function envInt(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 2);
export const STRESS_BURST = envInt("STRESS_BURST", 16);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
/** Replay exactly one round with this round seed (0 = off); see `roundSeeds`. */
export const STRESS_ROUND_SEED = envInt("STRESS_ROUND_SEED", 0);

/** Round seeds for a scenario: STRESS_ITER derived seeds, or the single
 * STRESS_ROUND_SEED when replaying one BROKEN round from a report. */
export function roundSeeds(name: string): number[] {
  if (STRESS_ROUND_SEED > 0) return [STRESS_ROUND_SEED];
  return Array.from(
    { length: STRESS_ITER },
    (_, round) => (STRESS_SEED ^ fnv1a(name) ^ Math.imul(round + 1, 0x9e3779b9)) >>> 0,
  );
}

export function roundReplayCommand(file: string, filter: string, roundSeed: number): string {
  return `STRESS_ROUND_SEED=${roundSeed} STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

export function replayCommand(file: string, filter: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=${STRESS_ITER} STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

/** Deadlock / livelock guard: the burst must settle inside `ms`. */
export async function bounded<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stress: ${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}
