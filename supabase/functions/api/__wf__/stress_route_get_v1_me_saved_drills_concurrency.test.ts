// STRESS — concurrency lens for `GET /v1/me/saved-drills` (../index.ts listSavedDrills).
//
// The REAL edge handler (Deno.serve captured by xc_concurrency_harness.ts) is
// driven with seeded Promise.all bursts. Supabase Auth, RevenueCat and Upstash
// are the stateful fakes of that harness; the ONE table this route reads —
// public.user_saved_drills — is modelled here at the PostgREST boundary with
// two interchangeable backends:
//
//   mem  — an in-memory PostgREST model (composite PK (user_id, slug), owner
//          RLS by JWT sub, `order=saved_at.desc`, upsert ignore-duplicates,
//          delete), seeded latency so lanes genuinely interleave;
//   pg   — the SAME PostgREST translation over a disposable postgres:16 with
//          shim_auth.sql + every migration applied (./xc_pg_up.sh), every
//          statement in its own transaction as role `authenticated` with the
//          caller's JWT sub — real RLS, real primary key, real ordering.
//          Enabled by XC_PG_URL (alias PICKLE_AUDIT_PG_URL); ignored = NOT a pass.
//
// Every iteration is one interleaving derived from ONE seed (users, bookmarks,
// lane mix, per-lane start jitter, upstream latency, clock skew) and mixes:
// duplicate GETs · GET while PUT/DELETE mutate the same user's rows · two
// sessions of the same user writing the same row · a second actor on the same
// slugs · logout of a sibling session mid-burst · refresh-token rotation
// mid-burst · a bearer expired by clock skew · a client that aborts its
// request mid-flight · rows whose saved_at is skewed into the future/past.
//
// Invariants (the contract — training/api.ts parseSavedDrill + AGENTS.md):
//   I1  no 5xx, no 429 (the burst sits under every budget)
//   I2  every GET is 200, except: expired bearer → 401 without any upstream
//       auth call; a lane on a logged-out session that STARTED after the
//       logout completed → 401 (no resurrection); overlapping the logout →
//       200 or 401 (either linearization)
//   I3  a 200 body is EXACTLY the rows the table served to that request, in
//       the table's order — no lost row, no duplicate row, no reorder by the
//       catalog fan-out (Promise.all map)
//   I4  the served snapshot is linearizable against the handler boundary:
//       a PUT/DELETE whose response returned before the GET started is
//       reflected; one that started after the GET's response returned is not
//   I5  items are sorted by saved_at descending and each slug appears once
//   I6  a second actor never sees the first actor's rows (disjoint universes)
//   I7  catalog expansion is exact: a published slug carries the catalog
//       entry's id/title/description/coach_name/equipment/difficulty and
//       never `families` / `validation_state`; an unpublished slug is the
//       honest placeholder (title == slug, uuid id)
//   I8  the bearer that logged out is refused on the next request, the
//       sibling session keeps working; the pre-rotation access token stays
//       valid through the burst, the rotated one works too
//   I9  every aborted lane settles; a GET never mutates the table
//   I10 the final table state == initial ∪ PUT − DELETE (no lost update,
//       no duplicate rows), and every burst completes inside a wall-time
//       bound (no deadlock)
//
// Scale: STRESS_ITER iterations (default 24, fast enough for the suite),
// STRESS_LANES_MAX lanes per burst (default 12), STRESS_LATENCY_MS max seeded
// upstream latency (default 8), STRESS_SEED base seed (default 20260904).
// Iteration k uses seed_k = (STRESS_SEED + k·0x9e3779b9) >>> 0, so ANY
// iteration replays alone with `STRESS_SEED=<seed_k> STRESS_ITER=1`.
// Results: <STRESS_OUT_DIR>/stress_saved_drills_<backend>.json — a seed →
// outcome table with lane rows, violations and the exact replay command.
//
//   deno test -A --no-check --config deno.json stress_route_get_v1_me_saved_drills_concurrency.test.ts
//   STRESS_ITER=600 STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json stress_route_*.test.ts
//   XC_PG_URL=$(./xc_pg_up.sh | tail -1 | cut -d= -f2-) STRESS_ITER=200 deno test -A --no-check --config deno.json stress_route_*.test.ts

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  histogram,
  isRecord,
  jwtPayload,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";
import { drillCatalog } from "../drills.ts";

// ── Configuration ────────────────────────────────────────────────────────────

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 24);
const STRESS_LANES_MAX = Math.max(6, envInt("STRESS_LANES_MAX", 12));
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
/** Generous deadlock bound per burst: every lane could serialize behind every
 * upstream hop at max latency and still finish well inside this. */
const BURST_WALL_MS = 5_000 + STRESS_LANES_MAX * STRESS_LATENCY_MS * 12;
const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-saved-drills/latest/",
    import.meta.url,
  ).pathname;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PostgREST renders timestamptz through PG's JSON output: microseconds + offset. */
const PGRST_TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}:\d{2}$/;

function iterationSeed(k: number): number {
  return (STRESS_SEED + Math.imul(k, 0x9e3779b9)) >>> 0;
}

/** PG's JSON rendering of a timestamptz at UTC, from epoch microseconds. */
function pgJsonTimestamp(epochMicros: number): string {
  const ms = Math.floor(epochMicros / 1000);
  const micros = epochMicros - ms * 1000;
  const iso = new Date(ms).toISOString(); // 2026-09-04T22:47:00.123Z
  return `${iso.slice(0, -1)}${String(micros).padStart(3, "0")}+00:00`;
}

// ── PostgREST-boundary table model ───────────────────────────────────────────

interface SavedRow {
  user_id: string;
  slug: string;
  saved_at: string;
}

interface ModelEvent {
  /** performance.now() when the statement took effect / the snapshot was read */
  t: number;
  op: "select" | "insert" | "insert.ignored" | "delete" | "delete.noop";
  userId: string;
  slug?: string;
  /** for select: the rows served, in order (slug list) */
  served?: string[];
}

interface TableBackend {
  readonly name: "mem" | "pg";
  reset(seed: number, latencyMaxMs: number): Promise<void>;
  ensureUser(userId: string): Promise<void>;
  seedRows(rows: SavedRow[]): Promise<void>;
  /** The PostgREST surface the edge fn talks to for /rest/v1/user_saved_drills. */
  handle(
    request: Request,
    rawBody: string,
    who: { role: string; userId: string | null },
  ): Promise<
    Response
  >;
  /** Ground truth as the table owner (no RLS). */
  truth(userId: string): Promise<SavedRow[]>;
  readonly events: ModelEvent[];
  close(): Promise<void>;
}

const json = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

/** Parse the PostgREST query the supabase-js client emits for this table. */
function parseQuery(url: URL): {
  select: string[];
  eq: Record<string, string>;
  order: { col: string; asc: boolean } | null;
  onConflict: string[] | null;
} {
  const select = (url.searchParams.get("select") ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const eq: Record<string, string> = {};
  let order: { col: string; asc: boolean } | null = null;
  for (const [key, raw] of url.searchParams.entries()) {
    if (key === "order") {
      const [col, dir] = raw.split(".");
      order = { col, asc: dir !== "desc" };
      continue;
    }
    if (["select", "on_conflict", "columns", "limit", "offset"].includes(key)) {
      continue;
    }
    if (raw.startsWith("eq.")) {
      eq[key] = raw.slice(3);
      continue;
    }
    throw new Error(`stress model: unsupported PostgREST filter ${key}=${raw}`);
  }
  const onConflictRaw = url.searchParams.get("on_conflict");
  return {
    select,
    eq,
    order,
    onConflict: onConflictRaw
      ? onConflictRaw.split(",").map((s) => s.trim())
      : null,
  };
}

function project(
  rows: SavedRow[],
  select: string[],
): Array<Record<string, unknown>> {
  if (select.includes("*")) return rows.map((r) => ({ ...r }));
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const col of select) {
      out[col] = (r as unknown as Record<string, unknown>)[col];
    }
    return out;
  });
}

function wantsSingleObject(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes(
    "application/vnd.pgrst.object+json",
  );
}

function singleOrList(
  request: Request,
  rows: Array<Record<string, unknown>>,
): Response {
  if (wantsSingleObject(request)) {
    if (rows.length !== 1) {
      return json(406, {
        code: "PGRST116",
        message: `JSON object requested, multiple (or no) rows returned`,
        details: `The result contains ${rows.length} rows`,
        hint: null,
      });
    }
    return json(200, rows[0]);
  }
  return json(200, rows);
}

/** In-memory PostgREST over public.user_saved_drills. Statements are atomic
 * (synchronous) after a seeded latency, exactly one commit point each. */
class MemBackend implements TableBackend {
  readonly name = "mem" as const;
  readonly events: ModelEvent[] = [];
  private rows: SavedRow[] = [];
  private prng = new Prng(1);
  private latencyMaxMs = 0;
  /** Seeded, skewed DB clock for default saved_at (microseconds). */
  private clockSkewMicros = 0;
  private lastMicros = 0;

  reset(seed: number, latencyMaxMs: number): Promise<void> {
    this.rows = [];
    this.events.length = 0;
    this.prng = new Prng((seed ^ 0x5a17ed) >>> 0);
    this.latencyMaxMs = latencyMaxMs;
    // the DB clock may run up to ±90 s from the edge isolate's clock
    this.clockSkewMicros = this.prng.int(-90_000, 90_000) * 1000;
    this.lastMicros = 0;
    return Promise.resolve();
  }
  ensureUser(_userId: string): Promise<void> {
    return Promise.resolve();
  }
  seedRows(rows: SavedRow[]): Promise<void> {
    for (const r of rows) {
      if (
        !this.rows.some((x) => x.user_id === r.user_id && x.slug === r.slug)
      ) {
        this.rows.push({ ...r });
      }
    }
    return Promise.resolve();
  }
  private now(): string {
    // strictly monotonic like a single PG backend's clock_timestamp() sequence
    let micros = Date.now() * 1000 + this.prng.int(0, 999) +
      this.clockSkewMicros;
    if (micros <= this.lastMicros) micros = this.lastMicros + 1;
    this.lastMicros = micros;
    return pgJsonTimestamp(micros);
  }
  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }
  private visible(who: { role: string; userId: string | null }): SavedRow[] {
    if (who.role === "service") return this.rows;
    if (!who.userId) return [];
    return this.rows.filter((r) => r.user_id === who.userId);
  }
  async handle(
    request: Request,
    rawBody: string,
    who: { role: string; userId: string | null },
  ): Promise<Response> {
    const url = new URL(request.url);
    const q = parseQuery(url);
    await this.latency();
    const applyEq = (rows: SavedRow[]) =>
      rows.filter((r) =>
        Object.entries(q.eq).every(
          ([col, v]) =>
            String((r as unknown as Record<string, unknown>)[col]) === v,
        )
      );
    if (request.method === "GET") {
      let rows = applyEq(this.visible(who));
      if (q.order) {
        const { col, asc } = q.order;
        rows = [...rows].sort((a, b) => {
          const av = String((a as unknown as Record<string, unknown>)[col]);
          const bv = String((b as unknown as Record<string, unknown>)[col]);
          return (av < bv ? -1 : av > bv ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      this.events.push({
        t: performance.now(),
        op: "select",
        userId: who.userId ?? "",
        served: rows.map((r) => r.slug),
      });
      return singleOrList(request, project(rows, q.select));
    }
    if (request.method === "POST") {
      const parsed = rawBody ? JSON.parse(rawBody) : {};
      const incoming: Array<Record<string, unknown>> = Array.isArray(parsed)
        ? parsed
        : [parsed];
      const prefer = request.headers.get("prefer") ?? "";
      for (const row of incoming) {
        const userId = String(row.user_id ?? "");
        const slug = String(row.slug ?? "");
        if (who.role !== "service" && userId !== who.userId) {
          return json(403, {
            code: "42501",
            message:
              'new row violates row-level security policy for table "user_saved_drills"',
          });
        }
        const conflict = this.rows.find((r) =>
          r.user_id === userId && r.slug === slug
        );
        if (conflict) {
          if (prefer.includes("resolution=ignore-duplicates")) {
            this.events.push({
              t: performance.now(),
              op: "insert.ignored",
              userId,
              slug,
            });
            continue;
          }
          if (prefer.includes("resolution=merge-duplicates")) {
            Object.assign(conflict, row);
            continue;
          }
          return json(409, {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "user_saved_drills_pkey"',
          });
        }
        this.rows.push({ user_id: userId, slug, saved_at: this.now() });
        this.events.push({ t: performance.now(), op: "insert", userId, slug });
      }
      return prefer.includes("return=representation")
        ? json(201, incoming)
        : new Response(null, { status: 201 });
    }
    if (request.method === "DELETE") {
      const doomed = new Set(applyEq(this.visible(who)));
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !doomed.has(r));
      this.events.push({
        t: performance.now(),
        op: before === this.rows.length ? "delete.noop" : "delete",
        userId: who.userId ?? "",
        slug: q.eq.slug,
      });
      return new Response(null, { status: 204 });
    }
    return json(405, {
      message: `stress model: ${request.method} not modelled`,
    });
  }
  truth(userId: string): Promise<SavedRow[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.user_id === userId).map((r) => ({ ...r })),
    );
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The same PostgREST translation over a real postgres:16 (every migration
 * applied). Each request = one transaction as role `authenticated` with the
 * caller's JWT sub, on its own pooled connection, so lanes truly run
 * concurrently in the database. */
class PgBackend implements TableBackend {
  readonly name = "pg" as const;
  readonly events: ModelEvent[] = [];
  private sql: ReturnType<typeof postgres>;
  constructor(url: string, poolMax: number) {
    this.sql = postgres(url, { max: poolMax });
  }
  reset(_seed: number, _latencyMaxMs: number): Promise<void> {
    this.events.length = 0;
    return Promise.resolve();
  }
  async ensureUser(userId: string): Promise<void> {
    assert(UUID_RE.test(userId), "user id must be a uuid");
    // seeded ids repeat across runs against the same disposable DB
    await this.sql.unsafe(`delete from auth.users where id = '${userId}'`);
    await this.sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${
        userId.slice(0, 8)
      }@example.com', '{"provider":"google"}')`,
    );
  }
  async seedRows(rows: SavedRow[]): Promise<void> {
    for (const r of rows) {
      assert(UUID_RE.test(r.user_id));
      await this.sql.unsafe(
        `insert into public.user_saved_drills (user_id, slug, saved_at) values ($1, $2, $3::timestamptz) on conflict (user_id, slug) do nothing`,
        [r.user_id, r.slug, r.saved_at],
      );
    }
  }
  private async asUser<T>(
    who: { role: string; userId: string | null },
    fn: (tx: ReturnType<typeof postgres>) => Promise<T>,
  ): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      if (who.role !== "service") {
        await tx.unsafe(`set local role authenticated`);
        if (who.userId) {
          assert(UUID_RE.test(who.userId), "jwt sub must be a uuid");
          await tx.unsafe(`set local request.jwt.claim.sub = '${who.userId}'`);
        }
      }
      return await fn(tx as unknown as ReturnType<typeof postgres>);
    })) as T;
  }
  async handle(
    request: Request,
    rawBody: string,
    who: { role: string; userId: string | null },
  ): Promise<Response> {
    const url = new URL(request.url);
    const q = parseQuery(url);
    const where: string[] = [];
    const params: string[] = [];
    for (const [col, v] of Object.entries(q.eq)) {
      assert(
        ["user_id", "slug", "saved_at"].includes(col),
        `unknown column ${col}`,
      );
      params.push(v);
      where.push(
        `${col} = $${params.length}${col === "user_id" ? "::uuid" : ""}`,
      );
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    try {
      if (request.method === "GET") {
        const orderSql = q.order
          ? `order by ${
            q.order.col === "saved_at" || q.order.col === "slug"
              ? q.order.col
              : "saved_at"
          } ${q.order.asc ? "asc" : "desc"}`
          : "";
        const rows = await this.asUser(who, (tx) =>
          tx.unsafe(
            `select user_id::text as user_id, slug, to_json(saved_at) #>> '{}' as saved_at from public.user_saved_drills ${whereSql} ${orderSql}`,
            params,
          ));
        const typed: SavedRow[] = rows.map((r: Record<string, unknown>) => ({
          user_id: String(r.user_id),
          slug: String(r.slug),
          saved_at: String(r.saved_at),
        }));
        this.events.push({
          t: performance.now(),
          op: "select",
          userId: who.userId ?? "",
          served: typed.map((r) => r.slug),
        });
        return singleOrList(request, project(typed, q.select));
      }
      if (request.method === "POST") {
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        const incoming: Array<Record<string, unknown>> = Array.isArray(parsed)
          ? parsed
          : [parsed];
        const prefer = request.headers.get("prefer") ?? "";
        const conflictClause = q.onConflict
          ? prefer.includes("resolution=ignore-duplicates")
            ? `on conflict (${
              q.onConflict.map((
                c,
              ) => (["user_id", "slug"].includes(c) ? c : "slug")).join(", ")
            }) do nothing`
            : prefer.includes("resolution=merge-duplicates")
            ? `on conflict (${
              q.onConflict.map((
                c,
              ) => (["user_id", "slug"].includes(c) ? c : "slug")).join(", ")
            }) do update set slug = excluded.slug`
            : ""
          : "";
        for (const row of incoming) {
          const userId = String(row.user_id ?? "");
          const slug = String(row.slug ?? "");
          assert(UUID_RE.test(userId), "payload user_id must be a uuid");
          const inserted = await this.asUser(who, (tx) =>
            tx.unsafe(
              `insert into public.user_saved_drills (user_id, slug) values ($1::uuid, $2) ${conflictClause} returning slug`,
              [userId, slug],
            ));
          this.events.push({
            t: performance.now(),
            op: inserted.length ? "insert" : "insert.ignored",
            userId,
            slug,
          });
        }
        return prefer.includes("return=representation")
          ? json(201, incoming)
          : new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        const deleted = await this.asUser(who, (tx) =>
          tx.unsafe(
            `delete from public.user_saved_drills ${whereSql} returning slug`,
            params,
          ));
        this.events.push({
          t: performance.now(),
          op: deleted.length ? "delete" : "delete.noop",
          userId: who.userId ?? "",
          slug: q.eq.slug,
        });
        return new Response(null, { status: 204 });
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? "XX000";
      const message = error instanceof Error ? error.message : String(error);
      // PostgREST maps SQLSTATE classes to HTTP: 42501 → 403, 23505 → 409, else 400
      const status = code === "42501" ? 403 : code === "23505" ? 409 : 400;
      return json(status, { code, message, details: null, hint: null });
    }
    return json(405, {
      message: `stress model: ${request.method} not modelled`,
    });
  }
  async truth(userId: string): Promise<SavedRow[]> {
    const rows = await this.sql.unsafe(
      `select user_id::text as user_id, slug, to_json(saved_at) #>> '{}' as saved_at from public.user_saved_drills where user_id = $1::uuid order by saved_at desc`,
      [userId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      user_id: String(r.user_id),
      slug: String(r.slug),
      saved_at: String(r.saved_at),
    }));
  }
  async close(): Promise<void> {
    await this.sql.end();
  }
}

// ── Wiring the model under the real handler ──────────────────────────────────

let installed: { h: XcHarness; backend: TableBackend | null } | null = null;

/** Route /rest/v1/user_saved_drills to the active backend; everything else
 * (GoTrue, profiles, RevenueCat…) stays with the xc fake. Installed once on the
 * fake INSTANCE — no existing harness file is modified. */
async function harnessWith(backend: TableBackend): Promise<XcHarness> {
  const h = await loadXcHarness();
  if (!installed) {
    installed = { h, backend: null };
    const fake = h.fake;
    const inner = fake.handleFetch.bind(fake);
    fake.handleFetch = async (
      request: Request,
      rawBody: string,
    ): Promise<Response> => {
      const url = new URL(request.url);
      if (
        url.origin === SUPABASE_URL &&
        url.pathname === "/rest/v1/user_saved_drills" &&
        installed?.backend
      ) {
        fake.count(`rest.${request.method.toLowerCase()}.user_saved_drills`);
        const who = fake.principal(request.headers);
        return await installed.backend.handle(request, rawBody, who);
      }
      return await inner(request, rawBody);
    };
  }
  installed.backend = backend;
  return h;
}

// ── Lane plan ────────────────────────────────────────────────────────────────

type LaneKind =
  | "get.A1" // GET as A, session 1 (the "device" under test)
  | "get.A2" // GET as A, session 2 (sibling device)
  | "get.B" // GET as the second actor
  | "put.A1" // PUT /v1/me/saved-drills/:slug as A (session 1)
  | "put.A1A2.same" // both of A's sessions PUT the same slug (same row, two actors)
  | "del.A1" // DELETE /v1/me/saved-drills/:slug as A
  | "put.B.sameSlug" // B saves a slug A also has (same slug, other owner)
  | "get.A1.expired" // GET with a bearer expired by clock skew → 401, no upstream
  | "get.A1.abort" // GET whose client aborts mid-flight
  | "logout.A2" // POST /v1/auth/logout on session 2 while get.A2 lanes race
  | "refresh.A1"; // POST /v1/auth/refresh rotates session 1 mid-burst

interface Lane {
  i: number;
  kind: LaneKind;
  startAfterMs: number;
  slug?: string;
  expiredBySeconds?: number;
  abortAfterMs?: number;
}

interface LaneRow {
  i: number;
  kind: LaneKind;
  slug?: string;
  status: number | "aborted";
  startedAt: number;
  endedAt: number;
  itemsSlugs?: string[];
  /** put.A1A2.same: [session-1 status, session-2 status] */
  pair?: [number, number];
  violations: string[];
}

interface IterationOutcome {
  k: number;
  seed: number;
  backend: "mem" | "pg";
  outcome: "HELD" | "BROKEN";
  lanes: number;
  statusHistogram: Record<string, number>;
  violations: string[];
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
  rows: LaneRow[];
}

function replayCommand(seed: number, backend: "mem" | "pg"): string {
  const pg = backend === "pg" ? `XC_PG_URL=${PG_URL} ` : "";
  return `${pg}STRESS_SEED=${seed} STRESS_ITER=1 STRESS_LANES_MAX=${STRESS_LANES_MAX} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json stress_route_get_v1_me_saved_drills_concurrency.test.ts --filter "${backend}"`;
}

/** A Supabase-issued-looking access token for `sub` whose exp is already in
 * the past by `skewSeconds` (the device clock ran ahead, or the token is stale).
 * The signature segment is a unique marker so the fake's GoTrue log (which
 * keys entries by the bearer's last 10 chars) can never confuse it with a
 * minted token, whose segment is always `.sig`. */
function skewedSessionToken(
  sub: string,
  sessionId: string,
  skewSeconds: number,
  marker: string,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) - skewSeconds,
      jti: `skew-${skewSeconds}`,
    }),
  );
  return `${header}.${payload}.${marker}`;
}

interface Actor {
  sub: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

async function bootstrapActor(
  h: XcHarness,
  sub: string,
  ip: string,
): Promise<Actor> {
  const boot = await bootstrap(h, sub, ip);
  assertEquals(
    boot.status,
    200,
    `bootstrap ${sub} → ${boot.status} ${JSON.stringify(boot.body)}`,
  );
  const payload = jwtPayload(boot.accessToken);
  return {
    sub,
    accessToken: boot.accessToken,
    refreshToken: boot.refreshToken,
    sessionId: String(payload?.session_id ?? ""),
  };
}

// ── One iteration = one seeded interleaving ──────────────────────────────────

async function runIteration(
  k: number,
  seed: number,
  backend: TableBackend,
): Promise<IterationOutcome> {
  const h = await harnessWith(backend);
  const prng = new Prng(seed);
  h.fake.reset(seed, STRESS_LATENCY_MS);
  h.upstreamCalls.length = 0;
  await backend.reset(seed, STRESS_LATENCY_MS);

  const catalog = await drillCatalog();
  const violations: string[] = [];
  const observations: Record<string, unknown> = {};
  const v = (msg: string) => violations.push(msg);

  // A distinct /24 per iteration keeps the per-IP and auth-failure budgets
  // (which live in the isolate beyond fake.reset()) from bleeding across.
  const ipBase = `10.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}`;
  const ip = (lane: number) => `${ipBase}.${1 + (lane % 250)}`;

  // Two actors with DISJOINT slug universes: A gets a seeded slice of the
  // published catalog plus 0-2 unpublished ("orphan") slugs; B gets others.
  const shuffled = prng.shuffle(catalog.map((d) => d.slug));
  const half = Math.floor(shuffled.length / 2);
  const universeA = shuffled.slice(0, half);
  const universeB = shuffled.slice(half);
  const orphanCount = prng.int(0, 2);
  const orphansA = Array.from(
    { length: orphanCount },
    (_, i) => `retired-drill-${seed}-${i}`,
  );
  universeA.push(...orphansA);

  const subA = prng.uuid();
  const subB = prng.uuid();
  await backend.ensureUser(subA);
  await backend.ensureUser(subB);
  const A1 = await bootstrapActor(h, subA, ip(251));
  const A2 = await bootstrapActor(h, subA, ip(252));
  const B = await bootstrapActor(h, subB, ip(253));
  assert(
    A1.sessionId && A2.sessionId && A1.sessionId !== A2.sessionId,
    "two sessions for A",
  );

  // Initial bookmarks, saved_at skewed up to ±1 day around now (past AND
  // future — clock skew between writers) with microsecond distinctness.
  const initialA = prng.shuffle(universeA).slice(
    0,
    prng.int(1, Math.min(8, universeA.length)),
  );
  const initialB = prng.shuffle(universeB).slice(
    0,
    prng.int(0, Math.min(5, universeB.length)),
  );
  const nowMicros = Date.now() * 1000;
  const usedMicros = new Set<number>();
  const skewedStamp = (): string => {
    let micros = nowMicros + prng.int(-86_400_000, 86_400_000) * 1000 +
      prng.int(0, 999);
    while (usedMicros.has(micros)) micros += 1;
    usedMicros.add(micros);
    return pgJsonTimestamp(micros);
  };
  await backend.seedRows(
    initialA.map((slug) => ({ user_id: subA, slug, saved_at: skewedStamp() })),
  );
  await backend.seedRows(
    initialB.map((slug) => ({ user_id: subB, slug, saved_at: skewedStamp() })),
  );

  // Mutation slugs: PUTs come from A's universe minus the initial set (so a
  // PUT is a real insert unless duplicated in-burst); DELETEs from the
  // initial set. PUT and DELETE never share a slug inside one burst, which
  // keeps the expected final state exact (I10).
  const putPool = prng.shuffle(universeA.filter((s) => !initialA.includes(s)));
  const delPool = prng.shuffle([...initialA]);

  const laneCount = prng.int(6, STRESS_LANES_MAX);
  const lanes: Lane[] = [];
  const puts = new Set<string>();
  const dels = new Set<string>();
  const jitter = () => prng.int(0, STRESS_LATENCY_MS * 3);
  const pick = (): LaneKind => {
    const r = prng.next();
    if (r < 0.34) return "get.A1";
    if (r < 0.44) return "get.A2";
    if (r < 0.58) return "get.B";
    if (r < 0.7) return "put.A1";
    if (r < 0.78) return "del.A1";
    if (r < 0.83) return "put.A1A2.same";
    if (r < 0.88) return "put.B.sameSlug";
    if (r < 0.94) return "get.A1.expired";
    return "get.A1.abort";
  };
  for (let i = 0; i < laneCount; i++) {
    let kind = pick();
    let slug: string | undefined;
    if (kind === "put.A1" || kind === "put.A1A2.same") {
      slug = putPool.find((s) => !puts.has(s) && !dels.has(s)) ?? undefined;
      if (!slug) kind = "get.A1";
      else puts.add(slug);
    } else if (kind === "del.A1") {
      slug = delPool.find((s) => !dels.has(s) && !puts.has(s)) ?? undefined;
      if (!slug) kind = "get.A1";
      else dels.add(slug);
    } else if (kind === "put.B.sameSlug") {
      // B saves a slug that A holds — same slug, different owner. It joins
      // B's expected set below; every other A slug stays foreign to B (I6).
      slug = initialA[prng.int(0, initialA.length - 1)];
    }
    const lane: Lane = { i, kind, startAfterMs: jitter(), slug };
    if (kind === "get.A1.expired") lane.expiredBySeconds = prng.int(2, 7_200);
    if (kind === "get.A1.abort") {
      lane.abortAfterMs = prng.int(0, STRESS_LATENCY_MS * 2);
    }
    lanes.push(lane);
  }
  // Session events: at most one logout (session 2) and one rotation (session 1).
  const withLogout = prng.next() < 0.5;
  const withRefresh = prng.next() < 0.5;
  if (withLogout) {
    lanes.push({ i: lanes.length, kind: "logout.A2", startAfterMs: jitter() });
  }
  if (withRefresh) {
    lanes.push({ i: lanes.length, kind: "refresh.A1", startAfterMs: jitter() });
  }
  const bSlugsExpected = new Set(initialB);
  for (const l of lanes) {
    if (l.kind === "put.B.sameSlug" && l.slug) bSlugsExpected.add(l.slug);
  }

  // ── fire the burst ──
  const rows: LaneRow[] = [];
  let logoutDoneAt = Infinity;
  let logoutStartedAt = Infinity;
  let rotatedToken: string | null = null;
  const t0 = performance.now();

  const run = async (lane: Lane): Promise<void> => {
    await sleep(lane.startAfterMs);
    const row: LaneRow = {
      i: lane.i,
      kind: lane.kind,
      slug: lane.slug,
      status: 0,
      startedAt: 0,
      endedAt: 0,
      violations: [],
    };
    const call = async (request: Request): Promise<Record<string, unknown>> => {
      row.startedAt = performance.now();
      const response = await h.handler(request);
      const body = await readJson(response);
      row.endedAt = performance.now();
      row.status = response.status;
      return body;
    };
    switch (lane.kind) {
      case "get.A1":
      case "get.A2":
      case "get.B": {
        const actor = lane.kind === "get.A1"
          ? A1
          : lane.kind === "get.A2"
          ? A2
          : B;
        const body = await call(
          edgeRequest("GET", "/v1/me/saved-drills", {
            token: actor.accessToken,
            ip: ip(lane.i),
          }),
        );
        if (row.status === 200) {
          const items = Array.isArray(body.items)
            ? (body.items as unknown[])
            : null;
          if (!items) {
            row.violations.push(
              `I3 body has no items[]: ${JSON.stringify(body).slice(0, 200)}`,
            );
            break;
          }
          row.itemsSlugs = items.map((it) =>
            String(isRecord(it) ? it.slug : "")
          );
        }
        break;
      }
      case "put.A1": {
        await call(
          edgeRequest("PUT", `/v1/me/saved-drills/${lane.slug}`, {
            token: A1.accessToken,
            ip: ip(lane.i),
          }),
        );
        break;
      }
      case "put.A1A2.same": {
        // both devices save the same drill at once — one row must result
        row.startedAt = performance.now();
        const [r1, r2] = await Promise.all([
          h.handler(
            edgeRequest("PUT", `/v1/me/saved-drills/${lane.slug}`, {
              token: A1.accessToken,
              ip: ip(lane.i),
            }),
          ),
          h.handler(
            edgeRequest("PUT", `/v1/me/saved-drills/${lane.slug}`, {
              token: A2.accessToken,
              ip: ip(lane.i),
            }),
          ),
        ]);
        await r1.text();
        await r2.text();
        row.endedAt = performance.now();
        row.pair = [r1.status, r2.status];
        row.status = r1.status === r2.status
          ? r1.status
          : Math.max(r1.status, r2.status);
        break;
      }
      case "del.A1": {
        await call(
          edgeRequest("DELETE", `/v1/me/saved-drills/${lane.slug}`, {
            token: A1.accessToken,
            ip: ip(lane.i),
          }),
        );
        break;
      }
      case "put.B.sameSlug": {
        await call(
          edgeRequest("PUT", `/v1/me/saved-drills/${lane.slug}`, {
            token: B.accessToken,
            ip: ip(lane.i),
          }),
        );
        break;
      }
      case "get.A1.expired": {
        const token = skewedSessionToken(
          subA,
          A1.sessionId,
          lane.expiredBySeconds ?? 60,
          `xskew${String(lane.i).padStart(5, "0")}`,
        );
        const getUserBefore =
          h.fake.timeline.filter((e) => e.op === "gotrue.get_user").length;
        await call(
          edgeRequest("GET", "/v1/me/saved-drills", { token, ip: ip(lane.i) }),
        );
        const suffix = token.slice(-10);
        const touched = h.fake.timeline
          .slice(getUserBefore)
          .some((e) =>
            e.op === "gotrue.get_user" && e.detail.includes(`bearer=${suffix}`)
          );
        if (row.status !== 401) {
          row.violations.push(`I2 expired bearer → ${row.status}, want 401`);
        }
        if (touched) {
          row.violations.push(`I2 expired bearer reached GoTrue getUser`);
        }
        break;
      }
      case "get.A1.abort": {
        // The client walks away mid-flight. The handler never observes the
        // signal (it has no streaming body), so the contract is: the lane
        // settles (a response or an AbortError), inside the wall bound, and
        // no other lane is disturbed.
        const controller = new AbortController();
        const request = new Request(
          `http://edge.xc.test/functions/v1/api/v1/me/saved-drills`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${A1.accessToken}`,
              "x-forwarded-for": ip(lane.i),
            },
            signal: controller.signal,
          },
        );
        row.startedAt = performance.now();
        const pending: Promise<number | string> = h.handler(request).then(
          async (response) => {
            await response.text();
            return response.status;
          },
          (error: unknown) =>
            `aborted:${error instanceof Error ? error.name : String(error)}`,
        );
        await sleep(lane.abortAfterMs ?? 0);
        controller.abort();
        const settled = await Promise.race([
          pending,
          sleep(BURST_WALL_MS).then(() => "hung" as const),
        ]);
        row.endedAt = performance.now();
        if (settled === "hung") {
          row.status = "aborted";
          row.violations.push("I9 aborted lane never settled");
        } else if (typeof settled === "number") {
          row.status = settled;
          if (settled >= 500) {
            row.violations.push(`I1 aborted lane → ${settled}`);
          }
          if (settled !== 200) {
            row.violations.push(`I2 aborted GET → ${settled}, want 200`);
          }
        } else {
          row.status = "aborted";
        }
        break;
      }
      case "logout.A2": {
        logoutStartedAt = performance.now();
        await call(
          edgeRequest("POST", "/v1/auth/logout", {
            token: A2.accessToken,
            ip: ip(lane.i),
          }),
        );
        logoutDoneAt = row.endedAt;
        if (row.status !== 204) {
          row.violations.push(`I8 logout → ${row.status}, want 204`);
        }
        break;
      }
      case "refresh.A1": {
        const body = await call(
          edgeRequest("POST", "/v1/auth/refresh", {
            ip: ip(lane.i),
            body: { refreshToken: A1.refreshToken },
          }),
        );
        if (row.status !== 200) {
          row.violations.push(`I8 refresh → ${row.status}, want 200`);
        }
        const session = isRecord(body.session) ? body.session : {};
        rotatedToken = typeof session.accessToken === "string"
          ? session.accessToken
          : null;
        break;
      }
    }
    rows.push(row);
  };

  await Promise.all(lanes.map(run));
  const burstMs = performance.now() - t0;
  if (burstMs > BURST_WALL_MS) {
    v(`I10 burst took ${Math.round(burstMs)}ms > ${BURST_WALL_MS}ms`);
  }

  // ── post-burst probes (I8) ──
  const probe = async (token: string, laneIp: string) => {
    const response = await h.handler(
      edgeRequest("GET", "/v1/me/saved-drills", { token, ip: laneIp }),
    );
    const body = await readJson(response);
    return { status: response.status, body };
  };
  if (withLogout) {
    const after = await probe(A2.accessToken, ip(254));
    if (after.status !== 401) {
      v(`I8 logged-out session 2 bearer → ${after.status}, want 401`);
    }
    const sibling = await probe(A1.accessToken, ip(254));
    if (sibling.status !== 200) {
      v(`I8 sibling session 1 after logout → ${sibling.status}, want 200`);
    }
  }
  if (withRefresh) {
    const old = await probe(A1.accessToken, ip(249));
    if (old.status !== 200) {
      v(`I8 pre-rotation access token → ${old.status}, want 200`);
    }
    if (rotatedToken) {
      const fresh = await probe(rotatedToken, ip(249));
      if (fresh.status !== 200) {
        v(`I8 rotated access token → ${fresh.status}, want 200`);
      }
    }
  }

  // ── evaluate the burst rows ──
  const mutationRows = rows.filter((r) =>
    ["put.A1", "put.A1A2.same", "del.A1"].includes(r.kind)
  );
  const selects = backend.events.filter((e) => e.op === "select");
  const getRows = rows
    .filter((r) =>
      r.kind === "get.A1" || r.kind === "get.A2" || r.kind === "get.B"
    )
    .sort((a, b) => a.endedAt - b.endedAt);
  for (const row of rows) {
    if (typeof row.status === "number" && row.status >= 500) {
      row.violations.push(`I1 ${row.kind} → ${row.status}`);
    }
    if (row.status === 429) {
      row.violations.push(`I1 ${row.kind} → 429 (budget tripped)`);
    }
    if (row.pair) {
      const [s1, s2] = row.pair;
      // session 2 may have been logged out by a racing/preceding logout lane
      const s2MayBe401 = row.endedAt >= logoutStartedAt;
      if (s1 !== 200) {
        row.violations.push(
          `I1 same-row PUT pair: session 1 → ${s1}, want 200`,
        );
      }
      if (s2 !== 200 && !(s2 === 401 && s2MayBe401)) {
        row.violations.push(
          `I1 same-row PUT pair: session 2 → ${s2}, want 200`,
        );
      }
      if (s2 === 200 && row.startedAt > logoutDoneAt) {
        row.violations.push(
          `I2 same-row PUT on logged-out session 2 was served 200`,
        );
      }
    }
    if (
      (row.kind === "put.A1" || row.kind === "del.A1" ||
        row.kind === "put.B.sameSlug") &&
      row.status !== 200 && row.status !== 204
    ) {
      row.violations.push(`I1 ${row.kind} → ${row.status}`);
    }
  }
  // Each 200 GET must correspond to exactly one served snapshot (I3). The
  // model tags snapshots by user; match by user and order of completion.
  const servedByUser = new Map<string, ModelEvent[]>();
  for (const e of selects) {
    const list = servedByUser.get(e.userId) ?? [];
    list.push(e);
    servedByUser.set(e.userId, list);
  }
  for (const row of getRows) {
    const actor = row.kind === "get.B" ? B : row.kind === "get.A2" ? A2 : A1;
    const startedAfterLogout = row.kind === "get.A2" &&
      row.startedAt > logoutDoneAt;
    const overlapsLogout = row.kind === "get.A2" &&
      row.endedAt >= logoutStartedAt && row.startedAt <= logoutDoneAt;
    if (row.status === 401) {
      if (row.kind !== "get.A2" || !(startedAfterLogout || overlapsLogout)) {
        row.violations.push(
          `I2 ${row.kind} → 401 without a logout to explain it`,
        );
      }
      continue;
    }
    if (row.status !== 200) {
      row.violations.push(`I2 ${row.kind} → ${row.status}, want 200`);
      continue;
    }
    if (startedAfterLogout) {
      row.violations.push(
        `I2 ${row.kind} started ${
          Math.round(row.startedAt - logoutDoneAt)
        }ms after logout completed but was served 200 (resurrected session)`,
      );
    }
    const slugs = row.itemsSlugs ?? [];
    // I5 — unique slugs
    if (new Set(slugs).size !== slugs.length) {
      row.violations.push(`I5 duplicate slug in response: ${slugs.join(",")}`);
    }
    // I6 — isolation
    const universe = row.kind === "get.B" ? bSlugsExpected : new Set(universeA);
    const foreign = slugs.filter((s) => !universe.has(s));
    if (foreign.length) {
      row.violations.push(
        `I6 ${row.kind} saw foreign slugs ${foreign.join(",")}`,
      );
    }
    // I3 — the response equals ONE snapshot the table served for this user
    // between the request's start and end
    const candidates = (servedByUser.get(actor.sub) ?? []).filter(
      (e) => e.t >= row.startedAt - 1 && e.t <= row.endedAt + 1,
    );
    const matches = candidates.some(
      (e) =>
        e.served!.length === slugs.length &&
        e.served!.every((s, idx) => s === slugs[idx]),
    );
    if (!matches) {
      row.violations.push(
        `I3 response ${
          JSON.stringify(slugs)
        } matches none of ${candidates.length} snapshots served in-window: ${
          JSON.stringify(candidates.map((c) => c.served))
        }`,
      );
    }
    // I4 — linearizable against completed / not-yet-started mutations
    if (row.kind !== "get.B") {
      for (const m of mutationRows) {
        if (typeof m.status !== "number" || m.status >= 400 || !m.slug) {
          continue;
        }
        const isPut = m.kind !== "del.A1";
        if (m.endedAt < row.startedAt) {
          const present = slugs.includes(m.slug);
          if (isPut && !present) {
            row.violations.push(
              `I4 PUT ${m.slug} completed before GET started but is missing`,
            );
          }
          if (!isPut && present) {
            row.violations.push(
              `I4 DELETE ${m.slug} completed before GET started but is present`,
            );
          }
        }
        if (m.startedAt > row.endedAt) {
          const present = slugs.includes(m.slug);
          if (isPut && present) {
            row.violations.push(
              `I4 PUT ${m.slug} started after GET returned but is present`,
            );
          }
          if (!isPut && !present && initialA.includes(m.slug)) {
            row.violations.push(
              `I4 DELETE ${m.slug} started after GET returned but is absent`,
            );
          }
        }
      }
    }
  }
  // I5 ordering and I7 expansion are checked per item as each 200 body
  // leaves the handler (runIterationWithShapes → checkItems).

  const finalA = await backend.truth(subA);
  const finalB = await backend.truth(subB);
  const expectedA = new Set(initialA.filter((s) => !dels.has(s)));
  for (const s of puts) expectedA.add(s);
  const finalASlugs = finalA.map((r) => r.slug);
  if (new Set(finalASlugs).size !== finalASlugs.length) {
    v(`I10 duplicate rows for A: ${finalASlugs}`);
  }
  const missing = [...expectedA].filter((s) => !finalASlugs.includes(s));
  const extra = finalASlugs.filter((s) => !expectedA.has(s));
  if (missing.length || extra.length) {
    v(`I10 final A rows ≠ initial ∪ PUT − DELETE: missing=${missing} extra=${extra}`);
  }
  const finalBSlugs = finalB.map((r) => r.slug);
  const missingB = [...bSlugsExpected].filter((s) => !finalBSlugs.includes(s));
  const extraB = finalBSlugs.filter((s) => !bSlugsExpected.has(s));
  if (missingB.length || extraB.length) {
    v(`I10 final B rows drifted: missing=${missingB} extra=${extraB}`);
  }
  // I9 — a GET never mutates: the model saw exactly as many writes as
  // successful PUT/DELETE requests could have issued
  const writes = backend.events.filter((e) => e.op !== "select");
  const maxWrites = rows.filter((r) =>
    r.kind.startsWith("put.") || r.kind.startsWith("del.")
  )
    .reduce((n, r) => n + (r.kind === "put.A1A2.same" ? 2 : 1), 0);
  if (writes.length > maxWrites) {
    v(`I9 table saw ${writes.length} writes but only ${maxWrites} write requests were issued`);
  }

  for (const row of rows) violations.push(...row.violations);
  observations.orphanSlugs = orphansA;
  observations.initialA = initialA;
  observations.initialB = initialB;
  observations.puts = [...puts];
  observations.deletes = [...dels];
  observations.withLogout = withLogout;
  observations.withRefresh = withRefresh;
  observations.burstMs = Math.round(burstMs);
  observations.counters = { ...h.fake.counters };
  observations.catalogSize = catalog.length;

  return {
    k,
    seed,
    backend: backend.name,
    outcome: violations.length === 0 ? "HELD" : "BROKEN",
    lanes: lanes.length,
    statusHistogram: histogram(rows.map((r) => `${r.kind}:${r.status}`)),
    violations,
    observations,
    durationMs: Math.round(performance.now() - t0),
    replay: replayCommand(seed, backend.name),
    rows,
  };
}

// ── Item shape checks (I5 ordering, I7 expansion) ────────────────────────────
//
// The lanes above keep only slugs; the shape of every item is verified by
// wrapping the handler's response body ONCE per GET here. To keep one source
// of truth, checkItems is applied inside readItems, used by the GET lanes.

interface ItemShapeResult {
  slugs: string[];
  violations: string[];
  orphanIds: Array<{ slug: string; id: string }>;
}

function checkItems(
  items: unknown[],
  bySlug: Map<string, Awaited<ReturnType<typeof drillCatalog>>[number]>,
): ItemShapeResult {
  const out: ItemShapeResult = { slugs: [], violations: [], orphanIds: [] };
  let prevSavedAt: string | null = null;
  for (const raw of items) {
    if (!isRecord(raw)) {
      out.violations.push(`I7 item is not an object`);
      continue;
    }
    const slug = String(raw.slug);
    out.slugs.push(slug);
    const savedAt = typeof raw.saved_at === "string" ? raw.saved_at : "";
    if (!PGRST_TS_RE.test(savedAt) || Number.isNaN(Date.parse(savedAt))) {
      out.violations.push(
        `I7 ${slug} saved_at not a PostgREST timestamptz: ${savedAt}`,
      );
    }
    if (prevSavedAt !== null && savedAt > prevSavedAt) {
      out.violations.push(
        `I5 saved_at not descending: ${prevSavedAt} then ${savedAt}`,
      );
    }
    prevSavedAt = savedAt;
    if (!UUID_RE.test(String(raw.id))) {
      out.violations.push(`I7 ${slug} id not a uuid: ${raw.id}`);
    }
    if ("families" in raw || "validation_state" in raw) {
      out.violations.push(`I7 ${slug} leaks catalog-only keys`);
    }
    if (!Array.isArray(raw.equipment)) {
      out.violations.push(`I7 ${slug} equipment not an array`);
    }
    const entry = bySlug.get(slug);
    if (entry) {
      const mismatch: string[] = (
        [
          "id",
          "title",
          "description",
          "coach_name",
          "difficulty_min",
          "difficulty_max",
        ] as const
      ).filter((key) => raw[key] !== entry[key]);
      if (JSON.stringify(raw.equipment) !== JSON.stringify(entry.equipment)) {
        mismatch.push("equipment");
      }
      if (mismatch.length) {
        out.violations.push(
          `I7 ${slug} differs from catalog on ${mismatch.join(",")}`,
        );
      }
    } else {
      if (raw.title !== slug) {
        out.violations.push(`I7 orphan ${slug} title is ${raw.title}`);
      }
      if (raw.difficulty_min !== null || raw.difficulty_max !== null) {
        out.violations.push(`I7 orphan ${slug} carries a difficulty`);
      }
      out.orphanIds.push({ slug, id: String(raw.id) });
    }
  }
  return out;
}

// ── Campaign runner ──────────────────────────────────────────────────────────

interface Campaign {
  backend: "mem" | "pg";
  baseSeed: number;
  iterations: number;
  lanesMax: number;
  latencyMs: number;
  executed: number;
  held: number;
  broken: number;
  requests: number;
  failingSeeds: number[];
  durationMs: number;
  results: Record<string, IterationOutcome>;
}

async function campaign(backend: TableBackend): Promise<Campaign> {
  const started = performance.now();
  const results: Record<string, IterationOutcome> = {};
  const failingSeeds: number[] = [];
  let requests = 0;
  for (let k = 0; k < STRESS_ITER; k++) {
    const seed = iterationSeed(k);
    const outcome = await runIterationWithShapes(k, seed, backend);
    results[String(seed)] = outcome;
    requests += outcome.rows.reduce(
      (n, r) => n + (r.kind === "put.A1A2.same" ? 2 : 1),
      0,
    );
    if (outcome.outcome === "BROKEN") failingSeeds.push(seed);
  }
  const summary: Campaign = {
    backend: backend.name,
    baseSeed: STRESS_SEED,
    iterations: STRESS_ITER,
    lanesMax: STRESS_LANES_MAX,
    latencyMs: STRESS_LATENCY_MS,
    executed: Object.keys(results).length,
    held: Object.values(results).filter((r) => r.outcome === "HELD").length,
    broken: failingSeeds.length,
    requests,
    failingSeeds,
    durationMs: Math.round(performance.now() - started),
    results,
  };
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}stress_saved_drills_${backend.name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
  console.log(
    `[stress:${backend.name}] ${summary.executed} iterations, ${requests} requests, held=${summary.held} broken=${summary.broken} in ${summary.durationMs}ms → ${path}`,
  );
  for (const seed of failingSeeds) {
    const r = results[String(seed)];
    console.log(
      `[stress:${backend.name}]   BROKEN seed=${seed}: ${
        r.violations.join(" | ")
      }`,
    );
    console.log(`[stress:${backend.name}]   replay: ${r.replay}`);
  }
  return summary;
}

/** runIteration plus the per-item shape checks: the model's served snapshots
 * only carry slugs, so for I5/I7 the handler is wrapped for the duration of
 * the iteration and every 200 GET /v1/me/saved-drills body is checked as it
 * leaves the handler. */
async function runIterationWithShapes(
  k: number,
  seed: number,
  backend: TableBackend,
): Promise<IterationOutcome> {
  const h = await harnessWith(backend);
  const catalog = await drillCatalog();
  const bySlug = new Map(catalog.map((d) => [d.slug, d]));
  const realHandler = h.handler;
  const shapeViolations: string[] = [];
  const orphanIds = new Map<string, Set<string>>();
  let getBodies = 0;
  h.handler = async (request: Request): Promise<Response> => {
    const response = await realHandler(request);
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname.endsWith("/v1/me/saved-drills") &&
      response.status === 200
    ) {
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        shapeViolations.push("I3 200 body is not JSON");
      }
      if (isRecord(parsed) && Array.isArray(parsed.items)) {
        getBodies += 1;
        const shape = checkItems(parsed.items, bySlug);
        shapeViolations.push(...shape.violations);
        for (const o of shape.orphanIds) {
          const set = orphanIds.get(o.slug) ?? new Set<string>();
          set.add(o.id);
          orphanIds.set(o.slug, set);
        }
      }
      return new Response(text, {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
  try {
    const outcome = await runIteration(k, seed, backend);
    outcome.violations.push(...shapeViolations);
    if (shapeViolations.length) outcome.outcome = "BROKEN";
    // Known, pinned defect (drills_billing_healthz.test.ts "REPRO (defect):
    // orphaned bookmark gets a NEW random id on every list call"): recorded
    // as an observation, not an invariant, so the campaign measures the
    // concurrency contract rather than re-failing on a documented issue.
    const churn = [...orphanIds.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([slug, ids]) => ({ slug, distinctIds: ids.size }));
    outcome.observations.orphanIdChurn = churn;
    outcome.observations.getBodiesChecked = getBodies;
    return outcome;
  } finally {
    h.handler = realHandler;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test(
  `stress mem: GET /v1/me/saved-drills — ${STRESS_ITER} seeded interleavings over the in-memory PostgREST model (I1–I10)`,
  async () => {
    const backend = new MemBackend();
    try {
      const summary = await campaign(backend);
      assertEquals(summary.executed, STRESS_ITER, "every iteration ran");
      assert(
        summary.broken === 0,
        `${summary.broken} BROKEN seed(s): ${
          summary.failingSeeds.join(", ")
        } — see ${outDir()}stress_saved_drills_mem.json`,
      );
    } finally {
      await backend.close();
    }
  },
);

Deno.test({
  name:
    `stress pg: GET /v1/me/saved-drills — ${STRESS_ITER} seeded interleavings over postgres:16 with every migration (real RLS + PK)`,
  ignore: PG_URL === "",
  async fn() {
    const backend = new PgBackend(PG_URL, STRESS_LANES_MAX + 6);
    try {
      const summary = await campaign(backend);
      assertEquals(summary.executed, STRESS_ITER, "every iteration ran");
      assert(
        summary.broken === 0,
        `${summary.broken} BROKEN seed(s): ${
          summary.failingSeeds.join(", ")
        } — see ${outDir()}stress_saved_drills_pg.json`,
      );
    } finally {
      await backend.close();
    }
  },
});
