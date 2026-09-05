// stress — DELETE /v1/me/saved-drills/:slug — concurrency lens harness.
//
// Drives the REAL edge handler (../index.ts, Deno.serve captured, fetch
// stubbed) against an in-memory Supabase Auth + PostgREST model whose every
// upstream call is parked at a DETERMINISTIC scheduler gate. A burst of N
// Promise.all requests therefore does not interleave by wall-clock luck: the
// scheduler releases exactly one parked upstream call at a time, chosen by a
// seeded PRNG, and waits until every in-flight request is parked again (or
// finished) before choosing the next. The interleaving of upstream effects is
// a pure function of the seed, so a failing iteration replays from its seed.
//
// The model deliberately mirrors what PostgREST/GoTrue do — and nothing more:
//   - PostgREST verifies the bearer JWT's signature/exp only; a logged-out
//     session's access token still works there until exp (which is why the
//     edge fn calls getUser()).
//   - DELETE … WHERE user_id = $1 AND slug = $2 is one statement: it removes 0
//     or 1 row (PK user_id,slug) and answers 204 either way.
//   - upsert with resolution=ignore-duplicates inserts or no-ops (201).
//
// Faults (seeded per iteration) can be injected on the PostgREST DELETE:
// a thrown network error, or a 5xx body — the handler must map both to a
// generic 503 and never to a 500.
//
// The wall clock the handler sees (Date.now) is frozen for the duration of an
// iteration and can be skewed, so rate-limit windows never straddle a minute
// boundary mid-burst and token-expiry arithmetic is reproducible.
//
// PostgREST passthrough (stress_saved_drill_delete_postgrest.test.ts): with a
// `Passthrough` configured, every /rest/v1/* call the handler makes is
// forwarded to a REAL PostgREST in front of a disposable docker postgres:16
// with every migration applied (./stress_pg_up.sh); GoTrue stays faked. The
// access tokens are real HS256 JWTs signed with STRESS_JWT_SECRET so
// PostgREST accepts them and RLS sees auth.uid(). Forwarded calls are NOT
// parked at scheduler gates (they race for real at the database); the auth
// gates stay deterministic.
//
// Scale knobs: STRESS_ITER (iterations per scenario, default 12),
// STRESS_MAX_BURST (max concurrent requests per iteration, default 24),
// STRESS_SEED (campaign seed), STRESS_ONLY_SEED (replay one iteration seed),
// STRESS_OUT_DIR (JSON reports; default artifacts/stress-route-delete-saved-drills/latest/).

import { createHmac } from "node:crypto";
import { b64url, envInt, isRecord, jwtPayload, Prng } from "./xc_concurrency_harness.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const ANON_KEY = "stress-anon-key";
export const SERVICE_ROLE_KEY = "stress-service-role-key";
export const JWT_SECRET =
  Deno.env.get("STRESS_JWT_SECRET") ?? "stress-local-jwt-secret-at-least-32-characters-long";

export function signHs256(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export const STRESS_ITER = envInt("STRESS_ITER", 12);
export const STRESS_MAX_BURST = envInt("STRESS_MAX_BURST", 24);
export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER_DEADLINE_MS = envInt("STRESS_ITER_DEADLINE_MS", 20_000);
export const STRESS_ONLY_SEED: number | null = (() => {
  const raw = Deno.env.get("STRESS_ONLY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
})();

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Iteration seed: a pure function of the campaign seed, scenario and index. */
export function iterationSeed(scenario: string, index: number): number {
  return fnv1a(`${STRESS_SEED}:${scenario}:${index}`);
}

// ── Frozen / skewed wall clock ───────────────────────────────────────────────

const realDateNow = Date.now.bind(Date);
export const clock = { frozenMs: null as number | null, skewMs: 0 };
Date.now = () => (clock.frozenMs ?? realDateNow()) + clock.skewMs;
export const realNow = (): number => realDateNow();

// ── Deterministic scheduler ──────────────────────────────────────────────────

interface Parked {
  label: string;
  seq: number;
  resume: () => void;
}

export class Scheduler {
  private parked: Parked[] = [];
  private seq = 0;
  inflight = 0;
  /** Tasks currently inside a real (passthrough) upstream call: they count as
   * parked so the scheduler keeps releasing others and the calls overlap. */
  busy = 0;
  /** Linearization: the order in which upstream effects were released. */
  steps: string[] = [];
  constructor(readonly prng: Prng) {}

  /** Park the caller until the scheduler releases it. */
  gate(label: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.parked.push({ label, seq: this.seq++, resume: resolve });
    });
  }

  /** Record a step without parking (passthrough calls). */
  note(label: string): void {
    this.steps.push(label);
  }

  /**
   * Run `tasks` concurrently, releasing exactly one parked upstream call at a
   * time whenever every in-flight task is parked. Throws when the burst does
   * not complete within `deadlineMs` (a deadlock or a hung upstream).
   */
  async run<T>(tasks: Array<() => Promise<T>>, deadlineMs: number): Promise<T[]> {
    const started = performance.now();
    const settled: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = [];
    const promises = tasks.map((task, i) => {
      this.inflight += 1;
      return task()
        .then(
          (value) => {
            settled[i] = { ok: true, value };
          },
          (error) => {
            settled[i] = { ok: false, error };
          },
        )
        .finally(() => {
          this.inflight -= 1;
        });
    });
    while (this.inflight > 0) {
      if (performance.now() - started > deadlineMs) {
        const parkedLabels = this.parked.map((p) => p.label);
        throw new Error(
          `stress: burst exceeded ${deadlineMs}ms (inflight=${this.inflight}, parked=${this.parked.length}: ${parkedLabels.join(" | ")})`,
        );
      }
      if (this.parked.length > 0 && this.parked.length + this.busy === this.inflight) {
        // Everyone is parked: pick one. Sort by label first so two parked
        // calls that are indistinguishable (same method/path/bearer) do not
        // make the schedule depend on which microtask happened to run first.
        this.parked.sort((a, b) =>
          a.label < b.label ? -1 : a.label > b.label ? 1 : a.seq - b.seq,
        );
        const pick = this.prng.int(0, this.parked.length - 1);
        const [next] = this.parked.splice(pick, 1);
        this.steps.push(next.label);
        next.resume();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(promises);
    return settled.map((s) => {
      if (s.ok) return s.value;
      throw s.error;
    });
  }
}

// ── Fake Supabase (Auth + PostgREST for user_saved_drills) ───────────────────

export interface StressSession {
  sessionId: string;
  userId: string;
  provider: "google" | "apple";
  accessToken: string;
  refreshToken: string;
  usedRefreshTokens: Set<string>;
  revoked: boolean;
}

export interface SavedDrillRow {
  user_id: string;
  slug: string;
  saved_at: string;
}

export type DeleteFault = "throw" | 500 | 502 | 503 | null;

export interface Faults {
  /** Called for every PostgREST DELETE in arrival order; non-null → fail it. */
  restDelete?: (n: number) => DeleteFault;
}

export interface Passthrough {
  /** Real PostgREST base URL, e.g. http://127.0.0.1:3001 */
  postgrestUrl: string;
  /** The real fetch (captured before the harness replaced globalThis.fetch). */
  fetch: typeof fetch;
}

/** Rows affected, from PostgREST's Content-Range under `Prefer: count=exact`
 * (`*\/N` for writes; `a-b/N` for reads). */
export function affectedFromContentRange(range: string | null): number | null {
  if (!range) return null;
  const star = /^\*\/(\d+|\*)$/.exec(range);
  if (star) return star[1] === "*" ? null : Number(star[1]);
  const span = /^(\d+)-(\d+)\/(\d+|\*)$/.exec(range);
  if (span) return Number(span[2]) - Number(span[1]) + 1;
  return null;
}

export class StressFake {
  sessions = new Map<string, StressSession>();
  accessIndex = new Map<string, string>();
  refreshIndex = new Map<string, string>();
  users = new Map<string, { id: string; provider: "google" | "apple" }>();
  rows: SavedDrillRow[] = [];
  counters: Record<string, number> = {};
  /** Applied PostgREST effects in order (what the DB actually did). */
  effects: string[] = [];
  faults: Faults = {};
  /** When set, /rest/v1/* is forwarded to a real PostgREST (see file header). */
  passthrough: Passthrough | null = null;
  /** Stable per-run alias of each minted access token (`t<epoch>.<mint>`), so
   * schedule labels replay byte-identically even though `exp` tracks the
   * wall clock and changes the signature between runs. */
  private tokenAlias = new Map<string, string>();
  private mint = 0;
  private epoch = 0;
  private deleteCalls = 0;
  prng = new Prng(1);

  reset(seed: number): void {
    this.prng = new Prng(seed);
    this.sessions.clear();
    this.accessIndex.clear();
    this.refreshIndex.clear();
    this.users.clear();
    this.rows = [];
    this.counters = {};
    this.effects = [];
    this.faults = {};
    this.mint = 0;
    this.deleteCalls = 0;
    this.epoch += 1;
  }

  count(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  newUser(provider: "google" | "apple" = "apple"): string {
    const id = this.prng.uuid();
    this.users.set(id, { id, provider });
    return id;
  }

  /** Mint (or rotate, when sessionId is given) a session. `expSeconds` is the
   * access token's exp claim (issuer clock = the frozen Date.now()). */
  mintSession(
    userId: string,
    sessionId?: string,
    expSeconds = Math.floor(Date.now() / 1000) + 3600,
  ): StressSession {
    this.mint += 1;
    const provider = this.users.get(userId)?.provider ?? "apple";
    const sid = sessionId ?? `sess-${this.epoch}.${this.mint}-${this.prng.uuid()}`;
    const accessToken = signHs256({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: sid,
      exp: expSeconds,
      jti: `${this.epoch}.${this.mint}-${this.prng.uuid()}`,
    });
    const refreshToken = `rt-${this.epoch}.${this.mint}-${this.prng.uuid()}`;
    const existing = this.sessions.get(sid);
    const session: StressSession = existing ?? {
      sessionId: sid,
      userId,
      provider,
      accessToken,
      refreshToken,
      usedRefreshTokens: new Set(),
      revoked: false,
    };
    if (existing) {
      existing.usedRefreshTokens.add(existing.refreshToken);
      existing.accessToken = accessToken;
      existing.refreshToken = refreshToken;
    }
    this.sessions.set(sid, session);
    this.tokenAlias.set(accessToken, `t${this.epoch}.${this.mint}`);
    this.accessIndex.set(accessToken, sid);
    this.refreshIndex.set(refreshToken, sid);
    return session;
  }

  save(userId: string, slug: string): void {
    if (!this.rows.some((r) => r.user_id === userId && r.slug === slug)) {
      this.rows.push({ user_id: userId, slug, saved_at: new Date(Date.now()).toISOString() });
    }
  }

  has(userId: string, slug: string): boolean {
    return this.rows.some((r) => r.user_id === userId && r.slug === slug);
  }

  duplicates(): string[] {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const r of this.rows) {
      const key = `${r.user_id}/${r.slug}`;
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    return dups;
  }

  private userJson(userId: string) {
    const user = this.users.get(userId)!;
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: `${user.id.slice(0, 8)}@example.com`,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    };
  }

  private sessionJson(session: StressSession) {
    const payload = jwtPayload(session.accessToken)!;
    return {
      access_token: session.accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: payload.exp,
      refresh_token: session.refreshToken,
      user: this.userJson(session.userId),
    };
  }

  /** PostgREST's view of the bearer: signature + exp only, no revocation. */
  private principal(headers: Headers): {
    role: "service" | "user" | "anon" | "expired";
    userId: string | null;
  } {
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === SERVICE_ROLE_KEY) return { role: "service", userId: null };
    if (!token || token === ANON_KEY) return { role: "anon", userId: null };
    const payload = jwtPayload(token);
    if (typeof payload?.exp === "number" && payload.exp * 1000 <= Date.now()) {
      return { role: "expired", userId: null };
    }
    const sub = typeof payload?.sub === "string" ? payload.sub : null;
    return { role: "user", userId: sub };
  }

  private filter(rows: SavedDrillRow[], params: URLSearchParams): SavedDrillRow[] {
    let out = rows;
    for (const [col, raw] of params.entries()) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(col)) continue;
      if (!raw.startsWith("eq.")) {
        throw new Error(`stress fake: unsupported PostgREST filter ${col}=${raw}`);
      }
      const v = raw.slice(3);
      out = out.filter((r) => String((r as unknown as Record<string, unknown>)[col]) === v);
    }
    return out;
  }

  async handle(request: Request, rawBody: string, sched: Scheduler): Promise<Response> {
    const url = new URL(request.url);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const auth = request.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const tail = this.tokenAlias.get(bearer) ?? bearer.slice(-8);

    if (url.origin !== SUPABASE_URL) {
      return new Response(`stress fake: unexpected fetch ${request.method} ${request.url}`, {
        status: 599,
      });
    }

    // ── GoTrue ──
    if (url.pathname.startsWith("/auth/v1/")) {
      const path = url.pathname.slice("/auth/v1/".length);
      if (path === "user" && request.method === "GET") {
        this.count("gotrue.get_user");
        await sched.gate(`gotrue.get_user[${tail}].arrive`);
        const sid = this.accessIndex.get(bearer);
        const session = sid ? this.sessions.get(sid) : undefined;
        const refused = !session || session.revoked;
        await sched.gate(`gotrue.get_user[${tail}].respond`);
        if (refused) {
          this.count("gotrue.get_user.refused");
          return json(403, {
            code: 403,
            error_code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          });
        }
        return json(200, this.userJson(session.userId));
      }
      if (path === "logout" && request.method === "POST") {
        this.count("gotrue.logout");
        await sched.gate(`gotrue.logout[${tail}].arrive`);
        const sid = this.accessIndex.get(bearer);
        const session = sid ? this.sessions.get(sid) : undefined;
        if (session) {
          session.revoked = true;
          this.effects.push(`logout ${session.sessionId}`);
        }
        await sched.gate(`gotrue.logout[${tail}].respond`);
        return new Response(null, { status: 204 });
      }
      if (path === "token" && request.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        if (grant !== "refresh_token") return json(400, { error: "unsupported_grant_type" });
        this.count("gotrue.refresh");
        let body: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(rawBody);
          body = isRecord(parsed) ? parsed : {};
        } catch {
          body = {};
        }
        const rt = typeof body.refresh_token === "string" ? body.refresh_token : "";
        await sched.gate(`gotrue.refresh[${rt.slice(-8)}].arrive`);
        const sid = this.refreshIndex.get(rt);
        const session = sid ? this.sessions.get(sid) : undefined;
        let response: Response;
        if (!session || session.revoked) {
          response = json(400, {
            error: "invalid_grant",
            error_code: "refresh_token_not_found",
            error_description: "Invalid Refresh Token: Refresh Token Not Found",
          });
        } else if (session.usedRefreshTokens.has(rt)) {
          response = json(400, {
            error: "invalid_grant",
            error_code: "refresh_token_already_used",
            error_description: "Invalid Refresh Token: Already Used",
          });
        } else {
          const rotated = this.mintSession(session.userId, session.sessionId);
          this.effects.push(`rotate ${session.sessionId}`);
          response = json(200, this.sessionJson(rotated));
        }
        await sched.gate(`gotrue.refresh[${rt.slice(-8)}].respond`);
        return response;
      }
      return json(404, { msg: `stress fake: unmodelled auth path ${path}` });
    }

    // ── PostgREST ──
    if (url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length);
      const filters = [...url.searchParams.entries()]
        .filter(([k]) => !["select", "order", "on_conflict", "columns"].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      const label = `rest.${request.method.toLowerCase()}[${tail}]{${filters}}`;
      if (this.passthrough) {
        return await this.forward(request, rawBody, url, table, label, sched);
      }
      if (table !== "user_saved_drills") {
        return json(404, { message: `stress fake: unmodelled table ${table}` });
      }
      const who = this.principal(request.headers);
      await sched.gate(`${label}.arrive`);
      if (who.role === "expired") {
        this.count("rest.jwt_expired");
        await sched.gate(`${label}.respond`);
        return json(401, { code: "PGRST301", message: "JWT expired", details: null, hint: null });
      }
      const scoped =
        who.role === "service"
          ? this.rows
          : who.userId
            ? this.rows.filter((r) => r.user_id === who.userId)
            : [];

      if (request.method === "GET") {
        this.count("rest.select");
        const rows = this.filter(scoped, url.searchParams);
        await sched.gate(`${label}.respond`);
        return json(
          200,
          rows.map((r) => ({ slug: r.slug, saved_at: r.saved_at })),
        );
      }
      if (request.method === "POST") {
        this.count("rest.upsert");
        const prefer = request.headers.get("prefer") ?? "";
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = {};
        }
        const incoming = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRecord);
        for (const row of incoming) {
          const rowUser = String(row.user_id ?? "");
          const slug = String(row.slug ?? "");
          if (who.role === "user" && rowUser !== who.userId) {
            await sched.gate(`${label}.respond`);
            return json(403, {
              code: "42501",
              message: "new row violates row-level security policy",
            });
          }
          const existing = this.rows.find((r) => r.user_id === rowUser && r.slug === slug);
          if (existing) {
            if (prefer.includes("resolution=ignore-duplicates")) {
              this.effects.push(`upsert ${rowUser.slice(0, 8)}/${slug} → duplicate`);
              continue;
            }
            await sched.gate(`${label}.respond`);
            return json(409, { code: "23505", message: "duplicate key value" });
          }
          this.rows.push({ user_id: rowUser, slug, saved_at: new Date(Date.now()).toISOString() });
          this.effects.push(`upsert ${rowUser.slice(0, 8)}/${slug} → inserted`);
        }
        await sched.gate(`${label}.respond`);
        return new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        this.count("rest.delete");
        const n = ++this.deleteCalls;
        const fault = this.faults.restDelete?.(n) ?? null;
        if (fault !== null) {
          this.count(`rest.delete.fault.${fault}`);
          this.effects.push(`delete#${n} → fault ${fault}`);
          await sched.gate(`${label}.respond`);
          if (fault === "throw") throw new TypeError("stress: simulated network failure");
          return json(fault, { code: "PGRST000", message: "simulated upstream failure" });
        }
        const victims = new Set(this.filter(scoped, url.searchParams));
        this.rows = this.rows.filter((r) => !victims.has(r));
        this.effects.push(`delete#${n} {${filters}} → ${victims.size} row(s)`);
        this.count(victims.size > 0 ? "rest.delete.removed" : "rest.delete.noop");
        await sched.gate(`${label}.respond`);
        return new Response(null, { status: 204 });
      }
      return json(405, { message: "stress fake: unsupported method" });
    }
    return new Response(`stress fake: unexpected fetch ${request.method} ${request.url}`, {
      status: 599,
    });
  }

  /** Forward a PostgREST call verbatim (plus `Prefer: count=exact` so the
   * Content-Range tells how many rows the statement touched). */
  private async forward(
    request: Request,
    rawBody: string,
    url: URL,
    table: string,
    label: string,
    sched: Scheduler,
  ): Promise<Response> {
    const pt = this.passthrough!;
    const target = new URL(
      `${url.pathname.slice("/rest/v1".length)}${url.search}`,
      pt.postgrestUrl,
    );
    const headers = new Headers(request.headers);
    headers.delete("host");
    const prefer = headers.get("prefer");
    headers.set("prefer", prefer ? `${prefer},count=exact` : "count=exact");
    const method = request.method;
    const key =
      method === "GET"
        ? "rest.select"
        : method === "POST"
          ? "rest.upsert"
          : `rest.${method.toLowerCase()}`;
    this.count(key);
    const n = method === "DELETE" ? ++this.deleteCalls : 0;
    sched.note(`${label}.forward`);
    sched.busy += 1;
    let response: Response;
    try {
      response = await pt.fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : rawBody,
      });
    } finally {
      sched.busy -= 1;
    }
    const affected = affectedFromContentRange(response.headers.get("content-range"));
    sched.note(`${label}.returned(${response.status},${affected ?? "?"})`);
    if (response.status === 401) this.count("rest.jwt_expired");
    if (method === "DELETE" && response.status < 300) {
      this.effects.push(`delete#${n} {${url.searchParams.toString()}} → ${affected ?? "?"} row(s)`);
      this.count(affected && affected > 0 ? "rest.delete.removed" : "rest.delete.noop");
    } else if (method === "POST" && response.status < 300) {
      let slug = "?";
      let owner = "?";
      try {
        const parsed = JSON.parse(rawBody);
        const first = (Array.isArray(parsed) ? parsed[0] : parsed) as unknown;
        if (isRecord(first)) {
          slug = String(first.slug ?? "?");
          owner = String(first.user_id ?? "?").slice(0, 8);
        }
      } catch {
        // keep placeholders
      }
      this.effects.push(`upsert ${owner}/${slug} → ${affected === 0 ? "duplicate" : "inserted"}`);
    } else if (response.status >= 400) {
      this.effects.push(`${method.toLowerCase()} ${table} → ${response.status}`);
    }
    return response;
  }
}

// ── Real handler capture ─────────────────────────────────────────────────────

export type EdgeHandler = (request: Request) => Promise<Response>;

export interface StressHarness {
  handler: EdgeHandler;
  fake: StressFake;
  /** The scheduler the fake parks on; swapped per iteration. */
  current: { sched: Scheduler };
  /** The real fetch, for passthrough and for direct PostgREST probes. */
  realFetch: typeof fetch;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) return loaded;
  const realFetch = globalThis.fetch.bind(globalThis);
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new StressFake();
  const current = { sched: new Scheduler(new Prng(1)) };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    return fake.handle(request, rawBody, current.sched);
  }) as typeof fetch;

  let handler: EdgeHandler | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as EdgeHandler | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  loaded = { handler, fake, current, realFetch };
  return loaded;
}

export interface EdgeCallOptions {
  bearer?: string;
  ip: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function edgeRequest(method: string, path: string, options: EdgeCallOptions): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip,
    ...(options.headers ?? {}),
  });
  if (options.bearer !== undefined) headers.set("Authorization", `Bearer ${options.bearer}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, {
    method,
    headers,
    body,
    signal: options.signal,
  });
}

// ── Per-request rows & reports ───────────────────────────────────────────────

export interface RequestRow {
  lane: number;
  op: string;
  status: number;
  code: string | null;
  startedAt: number;
  endedAt: number;
  note?: string;
}

export async function callEdge(
  harness: StressHarness,
  lane: number,
  op: string,
  request: Request,
  t0: number,
): Promise<RequestRow> {
  const startedAt = Math.round((performance.now() - t0) * 100) / 100;
  const response = await harness.handler(request);
  let code: string | null = null;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string") {
        code = parsed.error.code;
      } else if (isRecord(parsed) && typeof parsed.error === "string") {
        code = parsed.error;
      }
    } catch {
      code = null;
    }
  }
  return {
    lane,
    op,
    status: response.status,
    code,
    startedAt,
    endedAt: Math.round((performance.now() - t0) * 100) / 100,
  };
}

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface IterationResult {
  index: number;
  seed: number;
  outcome: "HELD" | "BROKEN" | "ERROR";
  burst: number;
  inputs: Record<string, unknown>;
  statusHistogram: Record<string, number>;
  counters: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  effects: string[];
  schedule: string[];
  requests: RequestRow[];
  durationMs: number;
  error?: string;
  replay: string;
}

export interface ScenarioReport {
  scenario: string;
  label: string;
  campaignSeed: number;
  scale: Record<string, number>;
  iterations: IterationResult[];
  executed: number;
  held: number;
  broken: number;
  errored: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  durationMs: number;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-delete-saved-drills/latest/", import.meta.url)
    .pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function replayCommand(file: string, scenarioFilter: string, seed: number): string {
  return `STRESS_ONLY_SEED=${seed} STRESS_SEED=${STRESS_SEED} STRESS_MAX_BURST=${STRESS_MAX_BURST} deno test -A --no-check --config deno.json ${file} --filter "${scenarioFilter}"`;
}

/** Distinct client IP per iteration so per-IP budgets never bleed across
 * iterations or scenarios (the rate limiter is per-isolate memory). */
export function ipFor(seed: number, lane = 0): string {
  const h = fnv1a(`${seed}:${lane}`);
  return `10.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`;
}

export interface IterationContext {
  seed: number;
  prng: Prng;
  fake: StressFake;
  sched: Scheduler;
  harness: StressHarness;
  ip: string;
  t0: number;
  /** Run a burst of edge calls under the deterministic scheduler. */
  burst: (tasks: Array<() => Promise<RequestRow>>) => Promise<RequestRow[]>;
  /** Run a single edge call to completion (still through the scheduler). */
  one: (task: () => Promise<RequestRow>) => Promise<RequestRow>;
}

export interface IterationOutcome {
  burst: number;
  inputs: Record<string, unknown>;
  requests: RequestRow[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
}

export interface ScenarioOptions {
  iterations?: number;
  /** Forward /rest/v1/* to a real PostgREST for the whole scenario. */
  passthrough?: { postgrestUrl: string } | null;
}

/**
 * Run `iterations` seeded iterations of a scenario, each on a fresh fake and a
 * fresh scheduler, with the wall clock frozen for its duration. Returns the
 * report (and writes it as JSON). The caller asserts on `report.broken`.
 */
export async function runScenario(
  file: string,
  scenario: string,
  label: string,
  body: (ctx: IterationContext) => Promise<IterationOutcome>,
  options: number | ScenarioOptions = {},
): Promise<ScenarioReport> {
  const opts: ScenarioOptions = typeof options === "number" ? { iterations: options } : options;
  const iterations = opts.iterations ?? STRESS_ITER;
  const harness = await loadStressHarness();
  harness.fake.passthrough = opts.passthrough
    ? { postgrestUrl: opts.passthrough.postgrestUrl, fetch: harness.realFetch }
    : null;
  const heapBefore = Deno.memoryUsage();
  const started = performance.now();
  const results: IterationResult[] = [];
  const seeds: Array<{ index: number; seed: number }> = [];
  for (let i = 0; i < iterations; i++) {
    const seed = iterationSeed(scenario, i);
    if (STRESS_ONLY_SEED !== null && seed !== STRESS_ONLY_SEED) continue;
    seeds.push({ index: i, seed });
  }
  if (STRESS_ONLY_SEED !== null && seeds.length === 0) {
    // Replaying a seed that belongs to another scenario: nothing to run here.
    seeds.push({ index: -1, seed: STRESS_ONLY_SEED });
  }
  for (const { index, seed } of seeds) {
    const prng = new Prng(seed);
    const fake = harness.fake;
    fake.reset(seed ^ 0x5bd1e995);
    const sched = new Scheduler(new Prng(seed ^ 0x9e3779b9));
    harness.current.sched = sched;
    clock.frozenMs = realNow();
    clock.skewMs = 0;
    const t0 = performance.now();
    const iterationStarted = performance.now();
    const ctx: IterationContext = {
      seed,
      prng,
      fake,
      sched,
      harness,
      ip: ipFor(seed),
      t0,
      burst: (tasks) => sched.run(tasks, STRESS_ITER_DEADLINE_MS),
      one: async (task) => (await sched.run([task], STRESS_ITER_DEADLINE_MS))[0],
    };
    let result: IterationResult;
    try {
      const outcome = await body(ctx);
      const broken = outcome.invariants.some((inv) => !inv.holds);
      result = {
        index,
        seed,
        outcome: broken ? "BROKEN" : "HELD",
        burst: outcome.burst,
        inputs: outcome.inputs,
        statusHistogram: histogram(outcome.requests.map((r) => r.status)),
        counters: { ...fake.counters },
        invariants: outcome.invariants,
        observations: outcome.observations,
        effects: [...fake.effects],
        schedule: [...sched.steps],
        requests: outcome.requests,
        durationMs: Math.round((performance.now() - iterationStarted) * 100) / 100,
        replay: replayCommand(file, scenario, seed),
      };
    } catch (error) {
      result = {
        index,
        seed,
        outcome: "ERROR",
        burst: 0,
        inputs: {},
        statusHistogram: {},
        counters: { ...fake.counters },
        invariants: [],
        observations: {},
        effects: [...fake.effects],
        schedule: [...sched.steps],
        requests: [],
        durationMs: Math.round((performance.now() - iterationStarted) * 100) / 100,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        replay: replayCommand(file, scenario, seed),
      };
    } finally {
      clock.frozenMs = null;
      clock.skewMs = 0;
    }
    results.push(result);
  }
  harness.fake.passthrough = null;
  const report: ScenarioReport = {
    scenario,
    label,
    campaignSeed: STRESS_SEED,
    scale: {
      iterations: results.length,
      maxBurst: STRESS_MAX_BURST,
      passthrough: opts.passthrough ? 1 : 0,
    },
    iterations: results,
    executed: results.length,
    held: results.filter((r) => r.outcome === "HELD").length,
    broken: results.filter((r) => r.outcome === "BROKEN").length,
    errored: results.filter((r) => r.outcome === "ERROR").length,
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  };
  const path = await writeJson(scenario, report);
  const failing = results.filter((r) => r.outcome !== "HELD");
  console.warn(
    `[stress] ${scenario}: executed=${report.executed} held=${report.held} broken=${report.broken} errored=${report.errored} in ${report.durationMs}ms → ${path}`,
  );
  for (const r of failing) {
    console.warn(
      `[stress]   ${r.outcome} seed=${r.seed} ${
        r.error ??
        r.invariants
          .filter((i) => !i.holds)
          .map((i) => `${i.name}: ${i.detail}`)
          .join("; ")
      }\n[stress]   replay: ${r.replay}`,
    );
  }
  return report;
}

export function inv(name: string, holds: boolean, detail: string): Invariant {
  return { name, holds, detail };
}
