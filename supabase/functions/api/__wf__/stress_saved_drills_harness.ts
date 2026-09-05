// stress — route PUT /v1/me/saved-drills/:slug (concurrency lens).
//
// Harness for driving the REAL edge handler (../index.ts, Deno.serve captured)
// through bookmark bursts. Builds on xc_concurrency_harness.ts (stateful fake
// GoTrue: sessions / refresh rotation / logout; seeded upstream latency) and
// adds the one table that harness does not model — public.user_saved_drills —
// with the semantics the route actually relies on:
//
//   primary key (user_id, slug)              → composite conflict target
//   upsert … on_conflict=user_id,slug        → INSERT … ON CONFLICT (user_id, slug) DO NOTHING
//     Prefer: resolution=ignore-duplicates
//   saved_at timestamptz default now()
//   owner-only RLS (auth.uid() = user_id) on select/insert/update/delete
//
// Two backends, chosen by STRESS_PG_URL:
//   * in-memory (default): the model above, seeded latency per upstream call;
//   * Postgres: every PostgREST call on user_saved_drills is translated to the
//     SQL PostgREST would issue and run on a disposable postgres:16 with
//     shim_auth.sql + every migration applied (./xc_pg_up.sh), in its own
//     transaction as role `authenticated` with the bearer's JWT sub — so the
//     real primary key, the real RLS policies and the real grants decide.
//     (The translation is ours, PostgREST itself is not in the loop; it is
//     labelled as such in every report.)
//
// Knobs (all optional):
//   STRESS_ITER        bursts per scenario (default 8 — fast enough for the suite)
//   STRESS_SEED        campaign seed (default 20260905)
//   STRESS_LATENCY_MS  max seeded latency per upstream call (default 8)
//   STRESS_BURST_MAX   max requests per burst (default 16)
//   STRESS_REPLAY_SEED replay only the burst with this seed (any scenario)
//   STRESS_OUT_DIR     where the JSON tables go
//                      (default artifacts/stress-saved-drills/latest/)
//   STRESS_PG_URL      postgres URL → Postgres backend (alias XC_PG_URL)

import postgres from "postgres";
import {
  b64url,
  envInt,
  type FakeSession,
  FakeSupabase,
  isRecord,
  jwtPayload,
  sleep,
  SUPABASE_URL,
  WEBHOOK_SECRET,
} from "./xc_concurrency_harness.ts";

export {
  edgeRequest,
  fakeGoogleIdToken,
  histogram,
  jwtPayload,
  Prng,
  readJson,
} from "./xc_concurrency_harness.ts";

export const TABLE = "user_saved_drills";
const ANON_KEY = "xc-anon-key";
/** Values the translation layer binds as SQL parameters (PostgREST JSON
 * scalars; objects/arrays are passed as JSON text). */
type SqlParam = string | number | boolean | null;
function sqlParam(value: unknown): SqlParam {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  return JSON.stringify(value);
}

const SERVICE_ROLE_KEY = "xc-service-role-key";

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 8);
export const STRESS_LATENCY_MS = Deno.env.get("STRESS_LATENCY_MS") === "0"
  ? 0
  : envInt("STRESS_LATENCY_MS", 8);
export const STRESS_BURST_MAX = Math.max(4, envInt("STRESS_BURST_MAX", 16));
export const STRESS_PG_URL = Deno.env.get("STRESS_PG_URL") ??
  Deno.env.get("XC_PG_URL") ?? "";
export const STRESS_REPLAY_SEED = (() => {
  const raw = Deno.env.get("STRESS_REPLAY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
})();
/** Per-burst wall-time bound; a burst that does not settle within it is a
 * deadlock/hang finding, never a retry. */
export const STRESS_BURST_TIMEOUT_MS = envInt(
  "STRESS_BURST_TIMEOUT_MS",
  15_000,
);

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Burst seed: stable per (scenario, campaign seed, iteration) so any single
 * burst replays with STRESS_REPLAY_SEED=<seed>. */
export function burstSeed(scenario: string, iteration: number): number {
  return fnv1a(`${scenario}|${STRESS_SEED}|${iteration}`);
}

const jsonResponse = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

const pgrstError = (status: number, code: string, message: string) =>
  jsonResponse(status, { code, message, details: null, hint: null });

type Principal = { role: "service" | "user" | "anon"; userId: string | null };

interface EqFilter {
  col: string;
  value: string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function parseFilters(params: URLSearchParams): EqFilter[] | Response {
  const out: EqFilter[] = [];
  for (const [col, raw] of params.entries()) {
    if (
      ["select", "order", "limit", "offset", "on_conflict", "columns"].includes(
        col,
      )
    ) continue;
    if (!IDENT_RE.test(col)) {
      return pgrstError(400, "PGRST100", `bad column ${col}`);
    }
    if (!raw.startsWith("eq.")) {
      return pgrstError(
        400,
        "PGRST100",
        `stress harness: unmodelled operator in ${col}=${raw}`,
      );
    }
    out.push({ col, value: raw.slice(3) });
  }
  return out;
}

function parseSelect(params: URLSearchParams): string[] | Response {
  const raw = params.get("select") ?? "*";
  if (raw === "*") return ["*"];
  const cols = raw.split(",").map((c) => c.trim());
  for (const c of cols) {
    if (!IDENT_RE.test(c)) {
      return pgrstError(400, "PGRST100", `bad select ${c}`);
    }
  }
  return cols;
}

function parseOrder(
  params: URLSearchParams,
): { col: string; desc: boolean } | null | Response {
  const raw = params.get("order");
  if (!raw) return null;
  const [col, dir] = raw.split(".");
  if (!IDENT_RE.test(col)) {
    return pgrstError(400, "PGRST100", `bad order ${raw}`);
  }
  return { col, desc: dir === "desc" };
}

// ── Postgres backend ─────────────────────────────────────────────────────────

type Sql = ReturnType<typeof postgres>;

/** SQLSTATE → the HTTP status PostgREST reports for it (subset). */
function pgStatus(code: string): number {
  if (code === "42501") return 403;
  if (code === "23505" || code === "23503") return 409;
  if (code.startsWith("23") || code.startsWith("22")) return 400;
  return 500;
}

export class PgBackend {
  readonly sql: Sql;
  /** server-side statement count, for the report */
  statements = 0;
  constructor(url: string, max = 24) {
    this.sql = postgres(url, { max, onnotice: () => {} });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  /** Owner-role setup: a fresh auth.users row (handle_new_user() creates the
   * profile the saved-drills FK points at). Seeded ids repeat across runs on
   * the same disposable DB, so the previous incarnation is cascaded away. */
  async createUser(userId: string): Promise<void> {
    await this.sql`delete from auth.users where id = ${userId}::uuid`;
    await this.sql`insert into auth.users (id, email, raw_app_meta_data)
      values (${userId}::uuid, ${`${userId}@example.com`}, '{"provider":"google"}'::jsonb)`;
  }

  async rowsFor(
    userId: string,
  ): Promise<Array<{ slug: string; saved_at: string }>> {
    const rows = await this.sql<Array<{ slug: string; saved_at: string }>>`
      select slug, to_json(saved_at) #>> '{}' as saved_at
        from public.user_saved_drills where user_id = ${userId}::uuid order by slug`;
    return rows.map((r) => ({ slug: r.slug, saved_at: r.saved_at }));
  }

  /** Duplicate (user_id, slug) pairs — impossible under the primary key, but
   * the invariant is asserted from the data, not from the DDL. */
  async duplicatePairs(): Promise<number> {
    const [row] = await this.sql<Array<{ n: string }>>`
      select count(*)::text as n from (
        select user_id, slug from public.user_saved_drills group by 1, 2 having count(*) > 1
      ) d`;
    return Number(row.n);
  }

  /** One PostgREST request = one transaction as the bearer's role/sub. */
  private async asPrincipal<T>(
    who: Principal,
    body: (tx: Sql) => Promise<T>,
  ): Promise<T> {
    return await this.sql.begin(async (tx) => {
      const role = who.role === "service"
        ? "service_role"
        : who.role === "user"
        ? "authenticated"
        : "anon";
      await tx.unsafe(`set local role ${role}`);
      if (who.userId) {
        await tx`select set_config('request.jwt.claim.sub', ${who.userId}, true)`;
      }
      return await body(tx as unknown as Sql);
    }) as T;
  }

  async handle(
    request: Request,
    url: URL,
    who: Principal,
    body: unknown,
  ): Promise<Response> {
    const filters = parseFilters(url.searchParams);
    if (filters instanceof Response) return filters;
    const where = filters.length
      ? `where ${filters.map((f, i) => `"${f.col}" = $${i + 1}`).join(" and ")}`
      : "";
    const args = filters.map((f) => f.value);
    try {
      if (request.method === "GET") {
        const select = parseSelect(url.searchParams);
        if (select instanceof Response) return select;
        const order = parseOrder(url.searchParams);
        if (order instanceof Response) return order;
        const cols = select[0] === "*"
          ? `user_id, slug, to_json(saved_at) #>> '{}' as saved_at`
          : select.map((
            c,
          ) => (c === "saved_at"
            ? `to_json(saved_at) #>> '{}' as saved_at`
            : `"${c}"`)
          ).join(", ");
        const orderSql = order
          ? ` order by "${order.col}" ${order.desc ? "desc" : "asc"}`
          : "";
        const rows = await this.asPrincipal(who, async (tx) => {
          this.statements += 1;
          return await tx.unsafe(
            `select ${cols} from public.${TABLE} ${where}${orderSql}`,
            args,
          );
        });
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length !== 1) {
            return pgrstError(406, "PGRST116", `${rows.length} rows`);
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (request.method === "POST") {
        const prefer = request.headers.get("prefer") ?? "";
        const incoming: Array<Record<string, unknown>> = Array.isArray(body)
          ? (body as Array<Record<string, unknown>>)
          : isRecord(body)
          ? [body]
          : [];
        if (incoming.length === 0) {
          return pgrstError(400, "PGRST102", "empty body");
        }
        const cols = Object.keys(incoming[0]);
        if (!cols.every((c) => IDENT_RE.test(c))) {
          return pgrstError(400, "PGRST100", "bad column");
        }
        const conflict = (url.searchParams.get("on_conflict") ?? "").split(",")
          .filter(Boolean);
        if (!conflict.every((c) => IDENT_RE.test(c))) {
          return pgrstError(400, "PGRST100", "bad on_conflict");
        }
        let onConflict = "";
        if (prefer.includes("resolution=ignore-duplicates")) {
          onConflict = ` on conflict ${
            conflict.length
              ? `(${conflict.map((c) => `"${c}"`).join(", ")})`
              : ""
          } do nothing`;
        } else if (prefer.includes("resolution=merge-duplicates")) {
          onConflict = ` on conflict (${
            conflict.map((c) => `"${c}"`).join(", ")
          }) do update set ${
            cols.map((c) => `"${c}" = excluded."${c}"`).join(", ")
          }`;
        }
        const values: SqlParam[] = [];
        const tuples = incoming.map((row) =>
          `(${
            cols.map((c) => {
              values.push(sqlParam(row[c]));
              return `$${values.length}`;
            }).join(", ")
          })`
        );
        const returning = prefer.includes("return=representation")
          ? ` returning user_id, slug, to_json(saved_at) #>> '{}' as saved_at`
          : "";
        const rows = await this.asPrincipal(who, async (tx) => {
          this.statements += 1;
          return await tx.unsafe(
            `insert into public.${TABLE} (${
              cols.map((c) => `"${c}"`).join(", ")
            }) values ${tuples.join(", ")}${onConflict}${returning}`,
            values,
          );
        });
        return returning
          ? jsonResponse(201, rows)
          : new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        await this.asPrincipal(who, async (tx) => {
          this.statements += 1;
          return await tx.unsafe(`delete from public.${TABLE} ${where}`, args);
        });
        return new Response(null, { status: 204 });
      }
      if (request.method === "PATCH") {
        if (!isRecord(body)) return pgrstError(400, "PGRST102", "bad body");
        const cols = Object.keys(body);
        if (!cols.every((c) => IDENT_RE.test(c))) {
          return pgrstError(400, "PGRST100", "bad column");
        }
        const values: SqlParam[] = [...args];
        const sets = cols.map((c) => {
          values.push(sqlParam(body[c]));
          return `"${c}" = $${values.length}`;
        });
        await this.asPrincipal(who, async (tx) => {
          this.statements += 1;
          return await tx.unsafe(
            `update public.${TABLE} set ${sets.join(", ")} ${where}`,
            values,
          );
        });
        return new Response(null, { status: 204 });
      }
      return pgrstError(405, "PGRST105", "method");
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string"
        ? error.code
        : "XX000";
      const message = error instanceof Error ? error.message : String(error);
      return pgrstError(pgStatus(code), code, message);
    }
  }
}

// ── Fake Supabase with the saved-drills table ────────────────────────────────

export class SavedDrillsFake extends FakeSupabase {
  pg: PgBackend | null = null;
  /** Extra seeded latency (ms) injected before each table call — models the
   * PostgREST hop even when Postgres is the backend. */
  tableLatencyMaxMs = 0;
  /** Test hook: run before a DELETE on the table is applied (e.g. to force a
   * DELETE to land between a PUT's upsert and its read-back). */
  beforeDelete: (() => Promise<void>) | null = null;
  /** Test hook: run after a POST (upsert) on the table is applied. */
  afterUpsert: (() => Promise<void>) | null = null;
  /** Test hook: run when a table request reaches the PostgREST hop, before
   * its JWT check (e.g. to park the request until the bearer's exp passes). */
  beforeTable: (() => Promise<void>) | null = null;
  /** Sub-millisecond suffix so two rows inserted in the same ms never share a
   * saved_at (Postgres carries microseconds; PostgREST renders them). */
  private savedAtSeq = 0;

  private nowSavedAt(): string {
    this.savedAtSeq = (this.savedAtSeq + 1) % 1000;
    return new Date().toISOString().replace(
      "Z",
      `${String(this.savedAtSeq).padStart(3, "0")}+00:00`,
    );
  }

  constructor(seed: number, latencyMaxMs: number) {
    super(seed, latencyMaxMs);
    this.tables[TABLE] = [];
  }

  override reset(seed: number, latencyMaxMs = this.latencyMaxMs): void {
    super.reset(seed, latencyMaxMs);
    this.beforeDelete = null;
    this.afterUpsert = null;
    this.beforeTable = null;
  }

  /** A bearer for `session` whose `exp` is shifted by `skewSeconds` relative
   * to the edge's clock (negative → already expired at the edge). GoTrue
   * knows the token (accessIndex), so only the edge's own exp check can
   * refuse it — that is exactly the clock-skew surface. */
  mintSkewedToken(session: FakeSession, skewSeconds: number): string {
    const base = jwtPayload(session.accessToken)!;
    const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
      b64url(
        JSON.stringify({
          ...base,
          exp: Math.floor(Date.now() / 1000) + skewSeconds,
          jti: `${base.jti}-skew${skewSeconds}`,
        }),
      )
    }.sig`;
    this.accessIndex.set(token, session.sessionId);
    return token;
  }

  savedRows(userId: string): Array<{ slug: string; saved_at: string }> {
    return this.tables[TABLE]
      .filter((r) => r.user_id === userId)
      .map((r) => ({ slug: String(r.slug), saved_at: String(r.saved_at) }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  duplicatePairsInMemory(): number {
    const seen = new Map<string, number>();
    for (const r of this.tables[TABLE]) {
      const key = `${String(r.user_id)}|${String(r.slug)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    let dups = 0;
    for (const n of seen.values()) if (n > 1) dups += 1;
    return dups;
  }

  private ownerRows(who: Principal): Array<Record<string, unknown>> {
    if (who.role === "service") return this.tables[TABLE];
    if (who.role === "anon" || !who.userId) return [];
    return this.tables[TABLE].filter((r) => r.user_id === who.userId);
  }

  private async handleTable(
    request: Request,
    url: URL,
    body: unknown,
  ): Promise<Response> {
    const who = this.principal(request.headers);
    this.count(`rest.${request.method.toLowerCase()}.${TABLE}`);
    if (this.tableLatencyMaxMs > 0) {
      await sleep(this.prng.int(0, this.tableLatencyMaxMs));
    }
    if (this.beforeTable) await this.beforeTable();
    // PostgREST verifies the JWT itself (signature + exp) before touching the
    // database: a bearer that expired between the edge's own exp check and
    // this hop is refused with 401 PGRST301 ("JWT expired").
    if (who.role === "user") {
      const auth = request.headers.get("authorization") ?? "";
      const payload = jwtPayload(
        auth.startsWith("Bearer ") ? auth.slice(7) : "",
      );
      if (
        typeof payload?.exp === "number" && payload.exp * 1_000 <= Date.now()
      ) {
        this.count(`rest.jwt_expired.${TABLE}`);
        return pgrstError(401, "PGRST301", "JWT expired");
      }
    }
    if (request.method === "DELETE" && this.beforeDelete) {
      await this.beforeDelete();
    }
    if (this.pg) {
      const response = await this.pg.handle(request, url, who, body);
      if (request.method === "POST" && this.afterUpsert) {
        await this.afterUpsert();
      }
      return response;
    }
    // in-memory model — seeded latency like every other upstream call
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
    const filters = parseFilters(url.searchParams);
    if (filters instanceof Response) return filters;
    const matches = (rows: Array<Record<string, unknown>>) =>
      rows.filter((r) => filters.every((f) => String(r[f.col]) === f.value));
    if (request.method === "GET") {
      const select = parseSelect(url.searchParams);
      if (select instanceof Response) return select;
      const order = parseOrder(url.searchParams);
      if (order instanceof Response) return order;
      let rows = matches(this.ownerRows(who)).map((r) => ({ ...r }));
      if (order) {
        rows.sort((a, b) => {
          const x = String(a[order.col]);
          const y = String(b[order.col]);
          return (x < y ? -1 : x > y ? 1 : 0) * (order.desc ? -1 : 1);
        });
      }
      if (select[0] !== "*") {
        rows = rows.map((r) =>
          Object.fromEntries(select.map((c) => [c, r[c]]))
        );
      }
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (rows.length !== 1) {
          return pgrstError(406, "PGRST116", `${rows.length} rows`);
        }
        return jsonResponse(200, rows[0]);
      }
      return jsonResponse(200, rows);
    }
    if (request.method === "POST") {
      const prefer = request.headers.get("prefer") ?? "";
      const incoming: Array<Record<string, unknown>> = Array.isArray(body)
        ? (body as Array<Record<string, unknown>>)
        : isRecord(body)
        ? [body]
        : [];
      const conflict = (url.searchParams.get("on_conflict") ?? "").split(",")
        .filter(Boolean);
      const inserted: Array<Record<string, unknown>> = [];
      for (const row of incoming) {
        if (who.role !== "service" && row.user_id !== who.userId) {
          return pgrstError(
            403,
            "42501",
            "new row violates row-level security policy",
          );
        }
        const key = conflict.length ? conflict : ["user_id", "slug"];
        const existing = this.tables[TABLE].find((r) =>
          key.every((c) => r[c] === row[c])
        );
        if (existing) {
          if (prefer.includes("resolution=ignore-duplicates")) {
            this.log(
              `rest.upsert.${TABLE}`,
              `ignored duplicate ${String(row.user_id)}/${String(row.slug)}`,
            );
            continue;
          }
          if (prefer.includes("resolution=merge-duplicates")) {
            Object.assign(existing, row);
            continue;
          }
          return pgrstError(
            409,
            "23505",
            "duplicate key value violates unique constraint",
          );
        }
        const full = { saved_at: this.nowSavedAt(), ...row };
        this.tables[TABLE].push(full);
        inserted.push(full);
        this.log(
          `rest.insert.${TABLE}`,
          `${String(row.user_id)}/${String(row.slug)}`,
        );
      }
      if (this.afterUpsert) await this.afterUpsert();
      return prefer.includes("return=representation")
        ? jsonResponse(201, inserted)
        : new Response(null, { status: 201 });
    }
    if (request.method === "DELETE") {
      const doomed = new Set(matches(this.ownerRows(who)));
      this.tables[TABLE] = this.tables[TABLE].filter((r) => !doomed.has(r));
      this.log(`rest.delete.${TABLE}`, `${doomed.size} row(s)`);
      return new Response(null, { status: 204 });
    }
    if (request.method === "PATCH") {
      for (const r of matches(this.ownerRows(who))) {
        if (isRecord(body)) Object.assign(r, body);
      }
      return new Response(null, { status: 204 });
    }
    return pgrstError(405, "PGRST105", "method");
  }

  override async handleFetch(
    request: Request,
    rawBody: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname === `/rest/v1/${TABLE}`) {
      let body: unknown = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null;
        }
      }
      return await this.handleTable(request, url, body);
    }
    return await super.handleFetch(request, rawBody);
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: SavedDrillsFake;
  pg: PgBackend | null;
  backend: "in-memory" | "postgres";
  upstreamCalls: Array<{ t: number; method: string; url: string }>;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new SavedDrillsFake(1, 0);
  const pg = STRESS_PG_URL ? new PgBackend(STRESS_PG_URL) : null;
  fake.pg = pg;
  const upstreamCalls: StressHarness["upstreamCalls"] = [];
  const t0 = performance.now();
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    upstreamCalls.push({
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      url: request.url,
    });
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
  loaded = {
    handler,
    fake,
    pg,
    backend: pg ? "postgres" : "in-memory",
    upstreamCalls,
  };
  return loaded;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface RequestRow {
  lane: number;
  op: string;
  actor: string;
  startMs: number;
  endMs: number;
  status: number;
  savedAt?: string;
  note?: string;
}

export interface BurstOutcome {
  iteration: number;
  seed: number;
  k: number;
  outcome: "HELD" | "BROKEN" | "TIMEOUT";
  statusHistogram: Record<string, number>;
  failed: string[];
  durationMs: number;
  inputs: Record<string, unknown>;
  requests: RequestRow[];
  observations: Record<string, unknown>;
}

export interface CampaignReport {
  scenario: string;
  label: string;
  backend: "in-memory" | "postgres";
  backendNote: string;
  campaignSeed: number;
  knobs: Record<string, number | string>;
  bursts: number;
  requests: number;
  held: number;
  broken: number;
  timeouts: number;
  failingSeeds: number[];
  maxBurstMs: number;
  totalMs: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  replay: string;
  table: BurstOutcome[];
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-saved-drills/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeCampaign(report: CampaignReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.scenario}.${report.backend}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function replayCommand(scenarioFilter: string, seed: number): string {
  const pg = STRESS_PG_URL ? `STRESS_PG_URL=${STRESS_PG_URL} ` : "";
  return `${pg}STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} STRESS_BURST_MAX=${STRESS_BURST_MAX} STRESS_REPLAY_SEED=${seed} deno test -A --no-check --config deno.json stress_saved_drills_concurrency.test.ts --filter "${scenarioFilter}"`;
}

/** Promise.all with a wall-time bound. A timeout resolves to `null` — the
 * scenario records it as TIMEOUT (deadlock/hang), never as a pass. */
export async function bounded<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const backendNote = (backend: "in-memory" | "postgres"): string =>
  backend === "postgres"
    ? "REAL handler (../index.ts) in-process; fake GoTrue; user_saved_drills PostgREST calls translated by the harness to SQL and run on the disposable postgres:16 (shim_auth.sql + every migration) as role authenticated with the bearer's sub — real primary key, RLS and grants; PostgREST itself is not in the loop."
    : "REAL handler (../index.ts) in-process; fake GoTrue + in-memory model of user_saved_drills (composite key, ignore-duplicates upsert, owner-only RLS) with seeded latency per upstream call.";
