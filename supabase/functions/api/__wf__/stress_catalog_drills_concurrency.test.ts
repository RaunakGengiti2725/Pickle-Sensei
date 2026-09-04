// stress — GET /v1/catalog/drills under the CONCURRENCY lens.
//
// Drives the REAL edge handler (../index.ts, captured from Deno.serve by
// xc_concurrency_harness.ts) with seeded Promise.all bursts. Every iteration is
// a fresh user (or pair of users) plus a fresh /24, scheduled by a PRNG seeded
// from the iteration's seed, so any row of the JSON table replays by itself:
//
//   STRESS_SEED=<seed> STRESS_ITER=1 STRESS_LATENCY_MS=<n> \
//     deno test -A --no-check --config deno.json stress_catalog_drills_concurrency.test.ts --filter campaign
//
// Scenario families (the seed alone picks the family: kinds[seed % kinds.length]):
//   dup_burst              N identical GETs, same bearer → byte-identical 200s, one DB read each
//   call_during_call       GETs interleaved with PUT/DELETE /v1/me/saved-drills/:slug by the
//                          same user → every GET is a linearizable snapshot of the bookmarks
//   two_actors             two users bookmark the SAME slugs concurrently → no cross-user leak,
//                          no duplicate rows, snapshots still linearizable per user
//   rotation_during_call   /v1/auth/refresh while GETs are in flight → old and new bearer 200
//   logout_during_call     /v1/auth/logout while GETs are in flight → 200 or 401 only, every
//                          GET that started after the logout completed is 401
//   clock_skew             bearers whose exp is in the past / seconds ahead / decades ahead →
//                          401 or 200 by exp, never 5xx, no caching of near-expiry bearers
//   cancel_during_call     Request.signal aborted mid-flight → the handler still answers,
//                          read-only route leaves no state behind
//   filter_fuzz            seeded q/family per lane, all concurrent → each body equals the
//                          sequential oracle (searchDrillCatalog), ids/slugs unique
//   rate_limit_atomic      240+k GETs in one burst → exactly the general budget is admitted
//
// Invariants (every iteration): no 5xx · bounded wall time (STRESS_WALL_MS) ·
// cursor === null · one user_saved_drills read per admitted GET · snapshots
// consistent with some instant inside the request window · bookmark table has
// no duplicate (user_id, slug) · final GET equals the settled truth (no lost
// update).
//
// Output: <STRESS_OUT_DIR>/seeds.json (seed → outcome table), summary.json,
// broken/<seed>.json (full rows + upstream timeline for every BROKEN seed).
// Default scale is small (STRESS_ITER=18) so the suite stays fast; the
// campaign that produced the evidence ran STRESS_ITER=630.
//
// The Postgres half (real user_saved_drills upsert/delete/select contention on
// docker postgres:16 with every migration applied, ./xc_pg_up.sh) lives at the
// bottom and is `ignore`d without XC_PG_URL — an ignored run is NOT a pass.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { drillCatalog, searchDrillCatalog } from "../drills.ts";
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  type FakeSession,
  histogram,
  type Invariant,
  isRecord,
  jwtPayload,
  loadXcHarness,
  Prng,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

// ── Scale (env) ───────────────────────────────────────────────────────────────

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 18);
const STRESS_LATENCY_MS = (() => {
  const raw = Deno.env.get("STRESS_LATENCY_MS");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 8;
})();
const STRESS_WALL_MS = envInt("STRESS_WALL_MS", 10_000);
const STRESS_SCENARIO = Deno.env.get("STRESS_SCENARIO") ?? "";
const STRESS_LANES = envInt("STRESS_LANES", 0); // 0 → seeded 8..32
// STRESS_STRICT=1 also fails the campaign on rows whose only broken invariant
// is the defect already pinned by the dedicated "stress minimized" test below.
const STRESS_STRICT = envInt("STRESS_STRICT", 0) === 1;

const GENERAL_USER_LIMIT = 240; // index.ts GENERAL_USER_LIMIT
const GENERAL_USER_WINDOW_S = 60; // index.ts GENERAL_USER_WINDOW_SECONDS

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-catalog-drills-concurrency/latest/",
    import.meta.url,
  )
    .pathname;
}

function replayCommand(seed: number, filter: string): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_LATENCY_MS=${STRESS_LATENCY_MS} STRESS_WALL_MS=${STRESS_WALL_MS}${
    STRESS_LANES ? ` STRESS_LANES=${STRESS_LANES}` : ""
  } deno test -A --no-check --config deno.json stress_catalog_drills_concurrency.test.ts --filter "${filter}"`;
}

// ── Bookmark model: PostgREST semantics for public.user_saved_drills ─────────
//
// The xc fake does not model this table (its generic upsert keys on a single
// on_conflict column; the route conflicts on `user_id,slug`), so the fetch
// stub is wrapped here with a faithful model: RLS owner scoping, `eq.` filters,
// `select=` projection, object-mode Accept (PGRST116 on ≠1 rows), upsert with
// `on_conflict=user_id,slug` + `resolution=ignore-duplicates`, delete by
// filter. Every commit is timestamped so a GET's snapshot can be checked
// against the write history for linearizability.

interface SavedRow {
  user_id: string;
  slug: string;
  saved_at: string;
}

interface Commit {
  t: number;
  saved: boolean;
}

class BookmarkModel {
  rows: SavedRow[] = [];
  /** `${user}|${slug}` → commits in order (t = performance.now() at commit). */
  history = new Map<string, Commit[]>();
  reads = 0;
  writes = 0;
  latencyMaxMs = 0;
  prng = new Prng(1);
  /** Runs once per row-scoped select (slug=eq.*) before the snapshot is taken —
   * lets a test pin an interleaving instead of hoping the scheduler finds it. */
  beforeRowSelect:
    | ((who: string | null, slug: string) => Promise<void>)
    | null = null;

  reset(prng: Prng, latencyMaxMs: number): void {
    this.rows = [];
    this.history.clear();
    this.reads = 0;
    this.writes = 0;
    this.prng = prng;
    this.latencyMaxMs = latencyMaxMs;
    this.beforeRowSelect = null;
  }

  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  private commit(user: string, slug: string, saved: boolean): void {
    const key = `${user}|${slug}`;
    const list = this.history.get(key) ?? [];
    list.push({ t: performance.now(), saved });
    this.history.set(key, list);
  }

  /** Bookmark state of (user, slug) at instant t (false before any commit). */
  stateAt(user: string, slug: string, t: number): boolean {
    const list = this.history.get(`${user}|${slug}`) ?? [];
    let state = false;
    for (const c of list) {
      if (c.t <= t) state = c.saved;
      else break;
    }
    return state;
  }

  /** Every slug this user ever wrote (the domain the snapshot check ranges over). */
  slugsOf(user: string): string[] {
    const out: string[] = [];
    for (const key of this.history.keys()) {
      if (key.startsWith(`${user}|`)) out.push(key.slice(user.length + 1));
    }
    return out;
  }

  /** Commit instants of this user falling inside [start, end]. */
  commitsWithin(user: string, start: number, end: number): number[] {
    const out: number[] = [];
    for (const [key, list] of this.history) {
      if (!key.startsWith(`${user}|`)) continue;
      for (const c of list) if (c.t >= start && c.t <= end) out.push(c.t);
    }
    return out.sort((a, b) => a - b);
  }

  private filter(rows: SavedRow[], params: URLSearchParams): SavedRow[] {
    let out = rows;
    for (const [col, raw] of params.entries()) {
      if (
        ["select", "order", "limit", "offset", "on_conflict", "columns"]
          .includes(col)
      ) continue;
      if (!raw.startsWith("eq.")) {
        throw new Error(
          `stress bookmark model: unsupported PostgREST filter ${col}=${raw}`,
        );
      }
      const v = raw.slice(3);
      out = out.filter((r) =>
        String((r as unknown as Record<string, unknown>)[col]) === v
      );
    }
    return out;
  }

  async handle(
    request: Request,
    rawBody: string,
    who: { role: "service" | "user" | "anon"; userId: string | null },
  ): Promise<Response> {
    const url = new URL(request.url);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    await this.latency();
    const slugEq = url.searchParams.get("slug");
    if (
      request.method === "GET" && slugEq?.startsWith("eq.") &&
      this.beforeRowSelect
    ) {
      await this.beforeRowSelect(who.userId, slugEq.slice(3));
    }
    // RLS scoping and the snapshot happen here, synchronously — one instant.
    const scoped = who.role === "service"
      ? this.rows
      : who.role === "user" && who.userId
      ? this.rows.filter((r) => r.user_id === who.userId)
      : [];

    if (request.method === "GET") {
      this.reads += 1;
      const matched = this.filter(scoped, url.searchParams);
      const select = (url.searchParams.get("select") ?? "*")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const project = (r: SavedRow): Record<string, unknown> => {
        if (select.includes("*")) return { ...r };
        const out: Record<string, unknown> = {};
        for (const col of select) {
          out[col] = (r as unknown as Record<string, unknown>)[col];
        }
        return out;
      };
      const projected = matched.map(project);
      await this.latency(); // response bytes in flight
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (projected.length !== 1) {
          return json(406, {
            code: "PGRST116",
            message: `${projected.length} rows`,
            details: null,
            hint: null,
          });
        }
        return json(200, projected[0]);
      }
      return json(200, projected);
    }

    if (request.method === "POST") {
      this.writes += 1;
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return json(400, { code: "PGRST102", message: "bad body" });
      }
      const incoming = (Array.isArray(parsed) ? parsed : [parsed]).filter(
        isRecord,
      );
      const prefer = request.headers.get("prefer") ?? "";
      const conflict = (url.searchParams.get("on_conflict") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const row of incoming) {
        const user = String(row.user_id ?? "");
        const slug = String(row.slug ?? "");
        if (who.role === "user" && user !== who.userId) {
          return json(403, {
            code: "42501",
            message: "new row violates row-level security policy",
          });
        }
        const existing = this.rows.find((r) =>
          conflict.length > 0
            ? conflict.every((c) =>
              String((r as unknown as Record<string, unknown>)[c]) ===
                String(row[c])
            )
            : r.user_id === user && r.slug === slug
        );
        if (existing) {
          if (prefer.includes("resolution=ignore-duplicates")) continue;
          if (prefer.includes("resolution=merge-duplicates")) {
            Object.assign(existing, row);
            continue;
          }
          return json(409, {
            code: "23505",
            message: "duplicate key value violates unique constraint",
          });
        }
        this.rows.push({
          user_id: user,
          slug,
          saved_at: new Date().toISOString(),
        });
        this.commit(user, slug, true);
      }
      return prefer.includes("return=representation")
        ? json(201, incoming)
        : new Response(null, { status: 201 });
    }

    if (request.method === "DELETE") {
      this.writes += 1;
      const doomed = new Set(this.filter(scoped, url.searchParams));
      if (doomed.size > 0) {
        this.rows = this.rows.filter((r) => !doomed.has(r));
        for (const r of doomed) this.commit(r.user_id, r.slug, false);
      }
      return new Response(null, { status: 204 });
    }

    return json(405, {
      message: `stress bookmark model: ${request.method} not modelled`,
    });
  }

  duplicatePairs(): number {
    const seen = new Set<string>();
    let dups = 0;
    for (const r of this.rows) {
      const k = `${r.user_id}|${r.slug}`;
      if (seen.has(k)) dups += 1;
      seen.add(k);
    }
    return dups;
  }
}

const bookmarks = new BookmarkModel();
let wrapped = false;

async function harness(): Promise<XcHarness> {
  const h = await loadXcHarness();
  if (!wrapped) {
    wrapped = true;
    const original = h.fake.handleFetch.bind(h.fake);
    h.fake.handleFetch = (
      request: Request,
      rawBody: string,
    ): Promise<Response> => {
      const url = new URL(request.url);
      if (
        url.origin === SUPABASE_URL &&
        url.pathname === "/rest/v1/user_saved_drills"
      ) {
        h.fake.count(`rest.${request.method.toLowerCase()}.user_saved_drills`);
        return bookmarks.handle(
          request,
          rawBody,
          h.fake.principal(request.headers),
        );
      }
      return original(request, rawBody);
    };
  }
  return h;
}

// ── Per-iteration bookkeeping ────────────────────────────────────────────────

interface LaneRow {
  lane: number;
  op: string;
  status: number;
  code?: string;
  slug?: string;
  /** JWT `sub` of the bearer (writes only) so same-user races are attributable. */
  user?: string;
  startedAt: number;
  endedAt: number;
  detail?: string;
}

interface Ctx {
  h: XcHarness;
  seed: number;
  prng: Prng;
  rows: LaneRow[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  ip: (lane: number) => string;
}

function inv(ctx: Ctx, name: string, holds: boolean, detail: string): void {
  ctx.invariants.push({ name, holds, detail });
}

async function timed(
  ctx: Ctx,
  lane: number,
  op: string,
  fn: () => Promise<Response>,
): Promise<
  {
    status: number;
    body: Record<string, unknown>;
    text: string;
    row: LaneRow;
    headers: Headers;
  }
> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fn();
  } catch (error) {
    const row: LaneRow = {
      lane,
      op,
      status: -1,
      code: "handler_threw",
      detail: error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
      startedAt,
      endedAt: performance.now(),
    };
    ctx.rows.push(row);
    return { status: -1, body: {}, text: "", row, headers: new Headers() };
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text);
      body = isRecord(parsed) ? parsed : { _value: parsed };
    } catch {
      body = { _raw: text };
    }
  }
  const err = body.error;
  const code = isRecord(err) && typeof err.code === "string"
    ? err.code
    : typeof body.code === "string"
    ? body.code
    : undefined;
  const row: LaneRow = {
    lane,
    op,
    status: response.status,
    code,
    startedAt,
    endedAt: performance.now(),
  };
  ctx.rows.push(row);
  return {
    status: response.status,
    body,
    text,
    row,
    headers: response.headers,
  };
}

/** Reject after `ms` — the timer is cleared either way so Deno's op sanitizer
 * never sees it dangling. */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const catalogPath = (q?: string, family?: string): string => {
  const params = new URLSearchParams();
  if (q !== undefined) params.set("q", q);
  if (family !== undefined) params.set("family", family);
  const qs = params.toString();
  return `/v1/catalog/drills${qs ? `?${qs}` : ""}`;
};

interface CatalogItem {
  id: string;
  slug: string;
  saved: boolean;
}

function itemsOf(body: Record<string, unknown>): CatalogItem[] | null {
  if (!Array.isArray(body.items)) return null;
  const out: CatalogItem[] = [];
  for (const raw of body.items) {
    if (
      !isRecord(raw) || typeof raw.slug !== "string" ||
      typeof raw.id !== "string"
    ) return null;
    out.push({ id: raw.id, slug: raw.slug, saved: raw.saved === true });
  }
  return out;
}

/** Linearizability of one GET: some instant inside [start, end] explains the
 * saved flags of EVERY slug the user ever wrote. Candidates are the request
 * start and each of the user's commits inside the window. */
function snapshotConsistent(
  user: string,
  items: CatalogItem[],
  start: number,
  end: number,
): { ok: boolean; detail: string } {
  const slugs = bookmarks.slugsOf(user);
  if (slugs.length === 0) {
    const stray = items.filter((i) => i.saved).map((i) => i.slug);
    return {
      ok: stray.length === 0,
      detail: stray.length
        ? `saved without any write: ${stray.join(",")}`
        : "no writes",
    };
  }
  const observed = new Map(items.map((i) => [i.slug, i.saved] as const));
  const candidates = [start, ...bookmarks.commitsWithin(user, start, end)];
  for (const t of candidates) {
    if (
      slugs.every((slug) =>
        (observed.get(slug) ?? false) === bookmarks.stateAt(user, slug, t)
      )
    ) {
      return { ok: true, detail: `explained by t=${t.toFixed(2)}` };
    }
  }
  // Slugs written by this user but not in the response (filtered out) read as false.
  const truthAtStart = slugs.map((s) =>
    `${s}=${bookmarks.stateAt(user, s, start)}`
  ).join(",");
  const truthAtEnd = slugs.map((s) => `${s}=${bookmarks.stateAt(user, s, end)}`)
    .join(",");
  const seen = slugs.map((s) => `${s}=${observed.get(s) ?? false}`).join(",");
  return {
    ok: false,
    detail: `no instant in [${start.toFixed(2)},${
      end.toFixed(2)
    }] explains ${seen}; start=${truthAtStart} end=${truthAtEnd}`,
  };
}

/** Mint an access token for an existing fake session with an arbitrary exp
 * (clock-skew probes). Registered with the fake so GET /auth/v1/user honours it
 * exactly like a token GoTrue issued. */
function skewedToken(
  h: XcHarness,
  session: FakeSession,
  expSeconds: number,
  tag: string,
): string {
  const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
    b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: session.userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: session.sessionId,
        exp: expSeconds,
        jti: `skew-${tag}-${session.sessionId}`,
      }),
    )
  }.sig`;
  h.fake.accessIndex.set(token, session.sessionId);
  return token;
}

// drills.ts families plus case/whitespace variants and an unknown one.
const FAMILIES = [
  "dink",
  "drive",
  "serve",
  "return",
  "volley",
  "drop_reset",
  "global",
  "DINK",
  " serve ",
  "unknown-family",
];

async function seededQuery(
  prng: Prng,
): Promise<{ q?: string; family?: string }> {
  const catalog = await drillCatalog();
  const pick = prng.int(0, 11);
  let q: string | undefined;
  switch (pick) {
    case 0:
      q = undefined;
      break;
    case 1:
      q = "";
      break;
    case 2:
      q = "   ";
      break;
    case 3: {
      const drill = catalog[prng.int(0, catalog.length - 1)];
      const words = drill.title.split(/\s+/);
      q = words[prng.int(0, words.length - 1)];
      break;
    }
    case 4: {
      const drill = catalog[prng.int(0, catalog.length - 1)];
      q = drill.title.toUpperCase().slice(0, prng.int(2, drill.title.length));
      break;
    }
    case 5: {
      const drill = catalog[prng.int(0, catalog.length - 1)];
      q =
        drill.equipment[prng.int(0, Math.max(0, drill.equipment.length - 1))] ??
          "paddle";
      break;
    }
    case 6:
      q = "zzz-no-such-drill-" + prng.uuid().slice(0, 8);
      break;
    case 7:
      q = "%' or 1=1 --";
      break;
    case 8:
      q = "ünïcödé 🏓";
      break;
    case 9:
      q = "a".repeat(prng.int(200, 2_000));
      break;
    case 10:
      q = "dink";
      break;
    default:
      q = "paddle & ball";
  }
  const family = prng.int(0, 3) === 0
    ? undefined
    : FAMILIES[prng.int(0, FAMILIES.length - 1)];
  return { q, family };
}

/** Sequential oracle for one query: the same catalog code, run alone. */
async function oracle(q?: string, family?: string): Promise<string[]> {
  return (await searchDrillCatalog({ q, family })).map((d) => d.slug);
}

// ── Scenario families ────────────────────────────────────────────────────────

type Scenario = (ctx: Ctx, lanes: number) => Promise<void>;

async function newUser(ctx: Ctx, tag: string, lane: number) {
  const sub = `${tag}-${ctx.prng.uuid()}`;
  const session = await bootstrap(ctx.h, sub, ctx.ip(lane));
  ctx.rows.push({
    lane,
    op: `bootstrap.${tag}`,
    status: session.status,
    startedAt: performance.now(),
    endedAt: performance.now(),
  });
  const payload = jwtPayload(session.accessToken);
  const userId = typeof payload?.sub === "string" ? payload.sub : "";
  const sid = typeof payload?.session_id === "string" ? payload.session_id : "";
  return { ...session, userId, sessionId: sid };
}

function commonGetChecks(
  ctx: Ctx,
  gets: Array<
    {
      status: number;
      body: Record<string, unknown>;
      row: LaneRow;
      headers: Headers;
    }
  >,
  label: string,
): void {
  const ok = gets.filter((g) => g.status === 200);
  inv(
    ctx,
    `${label}: cursor is null on every 200`,
    ok.every((g) => g.body.cursor === null),
    `${
      ok.filter((g) => g.body.cursor !== null).length
    } of ${ok.length} carried a non-null cursor`,
  );
  inv(
    ctx,
    `${label}: every 200 has unique ids and slugs`,
    ok.every((g) => {
      const items = itemsOf(g.body);
      if (!items) return false;
      return new Set(items.map((i) => i.id)).size === items.length &&
        new Set(items.map((i) => i.slug)).size === items.length;
    }),
    `${ok.length} bodies checked`,
  );
  inv(
    ctx,
    `${label}: 200 bodies are no-store`,
    ok.every((g) =>
      (g.headers.get("cache-control") ?? "").includes("no-store")
    ),
    `${ok.length} bodies checked`,
  );
}

const dupBurst: Scenario = async (ctx, lanes) => {
  const user = await newUser(ctx, "dup", 0);
  const { q, family } = await seededQuery(ctx.prng);
  ctx.observations.query = { q, family };
  const expected = await oracle(q, family);
  const readsBefore = bookmarks.reads;
  const getUserBefore = ctx.h.fake.counters["gotrue.get_user"] ?? 0;
  const gets = await Promise.all(
    Array.from(
      { length: lanes },
      (_, lane) =>
        timed(ctx, lane, "catalog.get", () =>
          ctx.h.handler(
            edgeRequest("GET", catalogPath(q, family), {
              token: user.accessToken,
              ip: ctx.ip(lane),
            }),
          )),
    ),
  );
  const statuses = gets.map((g) => g.status);
  inv(
    ctx,
    "dup_burst: every duplicate GET is 200",
    statuses.every((s) => s === 200),
    JSON.stringify(histogram(statuses)),
  );
  const bodies = new Set(gets.map((g) => g.text));
  inv(
    ctx,
    "dup_burst: all bodies byte-identical",
    bodies.size === 1,
    `${bodies.size} distinct bodies`,
  );
  const first = itemsOf(gets[0].body);
  inv(
    ctx,
    "dup_burst: body equals sequential oracle",
    first !== null && first.map((i) => i.slug).join(",") === expected.join(","),
    `got ${first?.length ?? "n/a"} items, oracle ${expected.length}`,
  );
  inv(
    ctx,
    "dup_burst: exactly one bookmark read per GET",
    bookmarks.reads - readsBefore === lanes,
    `${bookmarks.reads - readsBefore} reads for ${lanes} GETs`,
  );
  ctx.observations.getUserCallsForColdBurst =
    (ctx.h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
  // Warm burst: the bearer is now cached — Supabase Auth must not be consulted again.
  const warmBefore = ctx.h.fake.counters["gotrue.get_user"] ?? 0;
  const warm = await Promise.all(
    Array.from(
      { length: Math.min(lanes, 8) },
      (_, lane) =>
        timed(ctx, lane, "catalog.get.warm", () =>
          ctx.h.handler(
            edgeRequest("GET", catalogPath(q, family), {
              token: user.accessToken,
              ip: ctx.ip(lane),
            }),
          )),
    ),
  );
  inv(
    ctx,
    "dup_burst: warm burst never re-verifies the bearer upstream",
    (ctx.h.fake.counters["gotrue.get_user"] ?? 0) - warmBefore === 0 &&
      warm.every((g) => g.status === 200),
    `${
      (ctx.h.fake.counters["gotrue.get_user"] ?? 0) - warmBefore
    } getUser calls during warm burst`,
  );
  commonGetChecks(ctx, [...gets, ...warm], "dup_burst");
};

const SLUG_POOL_SIZE = 6;

async function slugPool(prng: Prng): Promise<string[]> {
  const catalog = await drillCatalog();
  return prng.shuffle(catalog.map((d) => d.slug)).slice(0, SLUG_POOL_SIZE);
}

async function writeOp(
  ctx: Ctx,
  lane: number,
  token: string,
  slug: string,
  save: boolean,
  delayMs: number,
) {
  if (delayMs > 0) await sleep(delayMs);
  const res = await timed(
    ctx,
    lane,
    save ? "saved.put" : "saved.delete",
    () =>
      ctx.h.handler(
        edgeRequest(save ? "PUT" : "DELETE", `/v1/me/saved-drills/${slug}`, {
          token,
          ip: ctx.ip(lane),
          body: save ? {} : undefined,
        }),
      ),
  );
  res.row.slug = slug;
  const sub = jwtPayload(token)?.sub;
  res.row.user = typeof sub === "string" ? sub : undefined;
  return res;
}

/** Writes by the SAME user on the same slug whose server-side window overlapped `r`. */
function sameUserOverlaps(rows: LaneRow[], r: LaneRow): LaneRow[] {
  return rows.filter((o) =>
    o !== r && o.slug === r.slug && o.user === r.user &&
    o.op.startsWith("saved.") &&
    o.startedAt < r.endedAt && r.startedAt < o.endedAt
  );
}

/** The one defect this campaign has reproduced so far, pinned deterministically
 * by the "stress minimized" test below: saveDrill's upsert→select is not
 * atomic, so a PUT whose own user's DELETE of the same slug lands in between
 * answers 503. A 503 PUT is attributed to it iff such a DELETE overlapped. */
const PINNED_PUT_DELETE_RACE =
  "pinned defect: saveDrill PUT↔same-user DELETE race answers 503 (see 'stress minimized' test)";

function attributedToPinnedRace(rows: LaneRow[]): Set<LaneRow> {
  const out = new Set<LaneRow>();
  for (const r of rows) {
    if (r.op !== "saved.put" || r.status !== 503) continue;
    if (sameUserOverlaps(rows, r).some((o) => o.op === "saved.delete")) {
      out.add(r);
    }
  }
  return out;
}

/** For every 5xx write, name the overlapping same-user write on the same slug
 * (if any) so a BROKEN row carries its own causal explanation. */
function explainWriteFailures(rows: LaneRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.status < 500 || !r.op.startsWith("saved.")) continue;
    const overlapping = sameUserOverlaps(rows, r);
    out.push(
      `lane ${r.lane} ${r.op} ${r.slug} → ${r.status}${
        r.code ? ` ${r.code}` : ""
      }` +
        (overlapping.length
          ? ` while the same user's ${
            overlapping.map((o) => `lane ${o.lane} ${o.op}`).join(", ")
          } overlapped the same slug`
          : " with no overlapping same-user write on that slug"),
    );
  }
  return out;
}

/** A write is acceptable iff it is 200 (PUT) / 204 (DELETE), or a 503 PUT
 * attributed to the pinned race (which is then reported by its own invariant). */
function writeOk(rows: LaneRow[], r: LaneRow): boolean {
  if (r.op === "saved.put") {
    return r.status === 200 || attributedToPinnedRace(rows).has(r);
  }
  return r.status === 204;
}

async function readOp(
  ctx: Ctx,
  lane: number,
  token: string,
  delayMs: number,
  q?: string,
  family?: string,
) {
  if (delayMs > 0) await sleep(delayMs);
  return timed(
    ctx,
    lane,
    "catalog.get",
    () =>
      ctx.h.handler(
        edgeRequest("GET", catalogPath(q, family), { token, ip: ctx.ip(lane) }),
      ),
  );
}

async function settledTruthCheck(
  ctx: Ctx,
  label: string,
  user: { accessToken: string; userId: string },
) {
  const final = await readOp(ctx, 0, user.accessToken, 0);
  const items = itemsOf(final.body) ?? [];
  const truth = new Set(
    bookmarks.rows.filter((r) => r.user_id === user.userId).map((r) => r.slug),
  );
  const observed = new Set(items.filter((i) => i.saved).map((i) => i.slug));
  const same = truth.size === observed.size &&
    [...truth].every((s) => observed.has(s));
  inv(
    ctx,
    `${label}: settled GET equals the bookmark table (no lost update)`,
    final.status === 200 && same,
    `status=${final.status} table=[${[...truth].sort().join(",")}] observed=[${
      [...observed].sort().join(",")
    }]`,
  );
  const expectedFromHistory = bookmarks.slugsOf(user.userId).filter((s) =>
    bookmarks.stateAt(user.userId, s, Number.MAX_SAFE_INTEGER)
  );
  inv(
    ctx,
    `${label}: bookmark table equals the commit history`,
    expectedFromHistory.length === truth.size &&
      expectedFromHistory.every((s) => truth.has(s)),
    `history=[${expectedFromHistory.sort().join(",")}] table=[${
      [...truth].sort().join(",")
    }]`,
  );
}

const callDuringCall: Scenario = async (ctx, lanes) => {
  const user = await newUser(ctx, "cdc", 0);
  const pool = await slugPool(ctx.prng);
  ctx.observations.slugPool = pool;
  const plan = Array.from({ length: lanes }, (_, lane) => {
    const kind = ctx.prng.int(0, 2); // 0 read, 1 save, 2 delete
    return {
      lane,
      kind,
      slug: pool[ctx.prng.int(0, pool.length - 1)],
      delay: ctx.prng.int(0, STRESS_LATENCY_MS * 2),
    };
  });
  // Guarantee the interleaving has both reads and writes.
  plan[0].kind = 1;
  plan[plan.length - 1].kind = 0;
  ctx.observations.plan = plan.map((p) =>
    `${p.lane}:${["get", "put", "del"][p.kind]}:${p.slug}@${p.delay}`
  );
  const results = await Promise.all(
    plan.map((p) =>
      p.kind === 0
        ? readOp(ctx, p.lane, user.accessToken, p.delay)
        : writeOp(ctx, p.lane, user.accessToken, p.slug, p.kind === 1, p.delay)
    ),
  );
  const gets = results.filter((r) => r.row.op === "catalog.get");
  const writes = results.filter((r) => r.row.op !== "catalog.get");
  inv(
    ctx,
    "call_during_call: every GET is 200",
    gets.every((g) => g.status === 200),
    JSON.stringify(histogram(gets.map((g) => g.status))),
  );
  inv(
    ctx,
    "call_during_call: every PUT is 200 and every DELETE is 204 (503 PUTs attributed to the pinned race excepted)",
    writes.every((w) => writeOk(ctx.rows, w.row)),
    JSON.stringify(histogram(writes.map((w) => `${w.row.op}:${w.status}`))),
  );
  const broken: string[] = [];
  for (const g of gets) {
    if (g.status !== 200) continue;
    const items = itemsOf(g.body);
    if (!items) {
      broken.push(`lane ${g.row.lane}: unparsable items`);
      continue;
    }
    const verdict = snapshotConsistent(
      user.userId,
      items,
      g.row.startedAt,
      g.row.endedAt,
    );
    if (!verdict.ok) broken.push(`lane ${g.row.lane}: ${verdict.detail}`);
  }
  inv(
    ctx,
    "call_during_call: every GET is a linearizable snapshot of the bookmarks",
    broken.length === 0,
    broken.length
      ? broken.slice(0, 3).join(" | ")
      : `${gets.length} GETs explained by an instant in their window`,
  );
  inv(
    ctx,
    "call_during_call: no duplicate (user_id, slug) rows",
    bookmarks.duplicatePairs() === 0,
    `${bookmarks.duplicatePairs()} duplicates among ${bookmarks.rows.length} rows`,
  );
  await settledTruthCheck(ctx, "call_during_call", user);
  commonGetChecks(ctx, gets, "call_during_call");
};

const twoActors: Scenario = async (ctx, lanes) => {
  const a = await newUser(ctx, "actorA", 0);
  const b = await newUser(ctx, "actorB", 1);
  const pool = (await slugPool(ctx.prng)).slice(0, 3); // same 3 slugs for both actors
  ctx.observations.slugPool = pool;
  const plan = Array.from({ length: lanes }, (_, lane) => ({
    lane,
    actor: lane % 2 === 0 ? "A" : "B",
    kind: ctx.prng.int(0, 2),
    slug: pool[ctx.prng.int(0, pool.length - 1)],
    delay: ctx.prng.int(0, STRESS_LATENCY_MS * 2),
  }));
  // Both actors save the SAME slug at (nearly) the same instant at least once.
  plan[0] = { lane: 0, actor: "A", kind: 1, slug: pool[0], delay: 0 };
  plan[1] = { lane: 1, actor: "B", kind: 1, slug: pool[0], delay: 0 };
  if (plan.length > 2) plan[2].kind = 0;
  if (plan.length > 3) plan[3].kind = 0;
  ctx.observations.plan = plan.map((p) =>
    `${p.lane}:${p.actor}:${["get", "put", "del"][p.kind]}:${p.slug}@${p.delay}`
  );
  const tokenOf = (
    actor: string,
  ) => (actor === "A" ? a.accessToken : b.accessToken);
  const results = await Promise.all(
    plan.map((p) =>
      p.kind === 0
        ? readOp(ctx, p.lane, tokenOf(p.actor), p.delay)
        : writeOp(ctx, p.lane, tokenOf(p.actor), p.slug, p.kind === 1, p.delay)
    ),
  );
  const gets = results.filter((r) => r.row.op === "catalog.get");
  inv(
    ctx,
    "two_actors: every GET is 200",
    gets.every((g) => g.status === 200),
    JSON.stringify(histogram(gets.map((g) => g.status))),
  );
  inv(
    ctx,
    "two_actors: every write succeeds (503 PUTs attributed to the pinned race excepted)",
    results.filter((r) => r.row.op !== "catalog.get").every((w) =>
      writeOk(ctx.rows, w.row)
    ),
    JSON.stringify(histogram(results.map((r) => `${r.row.op}:${r.status}`))),
  );
  const leaks: string[] = [];
  const nonlinear: string[] = [];
  for (const g of gets) {
    if (g.status !== 200) continue;
    const p = plan[g.row.lane];
    const me = p.actor === "A" ? a : b;
    const items = itemsOf(g.body) ?? [];
    const mine = new Set(bookmarks.slugsOf(me.userId));
    for (const item of items) {
      if (item.saved && !mine.has(item.slug)) {
        leaks.push(
          `lane ${g.row.lane} (${p.actor}) saw ${item.slug} saved without ever writing it`,
        );
      }
    }
    const verdict = snapshotConsistent(
      me.userId,
      items,
      g.row.startedAt,
      g.row.endedAt,
    );
    if (!verdict.ok) {
      nonlinear.push(`lane ${g.row.lane} (${p.actor}): ${verdict.detail}`);
    }
  }
  inv(
    ctx,
    "two_actors: no cross-user bookmark leak",
    leaks.length === 0,
    leaks.length
      ? leaks.slice(0, 3).join(" | ")
      : `${gets.length} GETs isolated`,
  );
  inv(
    ctx,
    "two_actors: per-user snapshots linearizable",
    nonlinear.length === 0,
    nonlinear.length ? nonlinear.slice(0, 3).join(" | ") : "ok",
  );
  const dup = bookmarks.duplicatePairs();
  inv(
    ctx,
    "two_actors: no duplicate (user_id, slug) rows",
    dup === 0,
    `${dup} duplicates among ${bookmarks.rows.length} rows`,
  );
  const sharedRows = bookmarks.rows.filter((r) => r.slug === pool[0]);
  inv(
    ctx,
    "two_actors: the same slug saved by both actors is two rows, one per user",
    sharedRows.length === new Set(sharedRows.map((r) => r.user_id)).size,
    `${sharedRows.length} rows for ${pool[0]} across ${
      new Set(sharedRows.map((r) => r.user_id)).size
    } users`,
  );
  await settledTruthCheck(ctx, "two_actors(A)", a);
  await settledTruthCheck(ctx, "two_actors(B)", b);
  commonGetChecks(ctx, gets, "two_actors");
};

const rotationDuringCall: Scenario = async (ctx, lanes) => {
  const user = await newUser(ctx, "rot", 0);
  const refreshAfter = ctx.prng.int(0, STRESS_LATENCY_MS * 2);
  ctx.observations.refreshAfterMs = refreshAfter;
  let rotated: { accessToken: string; refreshToken: string } | null = null;
  const half = Math.max(1, Math.floor(lanes / 2));
  const oldBurst = Promise.all(
    Array.from(
      { length: half },
      (_, lane) =>
        readOp(
          ctx,
          lane,
          user.accessToken,
          ctx.prng.int(0, STRESS_LATENCY_MS * 3),
        ),
    ),
  );
  const refresh = (async () => {
    await sleep(refreshAfter);
    const res = await timed(ctx, half, "auth.refresh", () =>
      ctx.h.handler(
        edgeRequest("POST", "/v1/auth/refresh", {
          ip: ctx.ip(half),
          body: { refreshToken: user.refreshToken },
        }),
      ));
    const session = isRecord(res.body.session) ? res.body.session : {};
    if (res.status === 200) {
      rotated = {
        accessToken: String(session.accessToken ?? ""),
        refreshToken: String(session.refreshToken ?? ""),
      };
    }
    return res;
  })();
  const [olds, refreshed] = await Promise.all([oldBurst, refresh]);
  inv(
    ctx,
    "rotation: refresh during the burst is 200",
    refreshed.status === 200,
    `refresh=${refreshed.status}`,
  );
  inv(
    ctx,
    "rotation: GETs bearing the pre-rotation access token stay 200 (rotation is not revocation)",
    olds.every((g) => g.status === 200),
    JSON.stringify(histogram(olds.map((g) => g.status))),
  );
  const newToken = rotated
    ? (rotated as { accessToken: string }).accessToken
    : user.accessToken;
  const mixed = await Promise.all(
    Array.from({ length: lanes - half }, (_, i) => {
      const lane = half + 1 + i;
      const token = i % 2 === 0 ? newToken : user.accessToken;
      return readOp(ctx, lane, token, ctx.prng.int(0, STRESS_LATENCY_MS));
    }),
  );
  inv(
    ctx,
    "rotation: post-rotation burst mixing old and new bearer is all 200",
    mixed.every((g) => g.status === 200),
    JSON.stringify(histogram(mixed.map((g) => g.status))),
  );
  const bodies = new Set(
    [...olds, ...mixed].filter((g) => g.status === 200).map((g) => g.text),
  );
  inv(
    ctx,
    "rotation: old and new bearer see the same catalog body",
    bodies.size === 1,
    `${bodies.size} distinct bodies`,
  );
  commonGetChecks(ctx, [...olds, ...mixed], "rotation");
};

const logoutDuringCall: Scenario = async (ctx, lanes) => {
  const user = await newUser(ctx, "out", 0);
  // Warm the auth cache with one GET so the burst races a CACHED bearer too.
  const warm = await readOp(ctx, 0, user.accessToken, 0);
  inv(
    ctx,
    "logout: warm-up GET is 200",
    warm.status === 200,
    `status=${warm.status}`,
  );
  const logoutAfter = ctx.prng.int(0, STRESS_LATENCY_MS * 2);
  ctx.observations.logoutAfterMs = logoutAfter;
  let logoutDoneAt = Infinity;
  const burst = Promise.all(
    Array.from(
      { length: lanes },
      (_, lane) =>
        readOp(
          ctx,
          lane,
          user.accessToken,
          ctx.prng.int(0, STRESS_LATENCY_MS * 3),
        ),
    ),
  );
  const logout = (async () => {
    await sleep(logoutAfter);
    const res = await timed(
      ctx,
      lanes,
      "auth.logout",
      () =>
        ctx.h.handler(
          edgeRequest("POST", "/v1/auth/logout", {
            token: user.accessToken,
            ip: ctx.ip(lanes),
            body: {},
          }),
        ),
    );
    logoutDoneAt = res.row.endedAt;
    return res;
  })();
  const [gets, out] = await Promise.all([burst, logout]);
  inv(ctx, "logout: logout is 204", out.status === 204, `logout=${out.status}`);
  inv(
    ctx,
    "logout: every racing GET is 200 or 401 (never 5xx)",
    gets.every((g) => g.status === 200 || g.status === 401),
    JSON.stringify(histogram(gets.map((g) => g.status))),
  );
  const startedAfter = gets.filter((g) => g.row.startedAt > logoutDoneAt);
  inv(
    ctx,
    "logout: every GET that started after the logout completed is 401",
    startedAfter.every((g) => g.status === 401),
    `${startedAfter.length} GETs started after logout; statuses ${
      JSON.stringify(histogram(startedAfter.map((g) => g.status)))
    }`,
  );
  const post = await Promise.all(
    Array.from(
      { length: 4 },
      (_, i) => readOp(ctx, lanes + 1 + i, user.accessToken, 0),
    ),
  );
  inv(
    ctx,
    "logout: a fresh burst after logout is refused (401) — the fence outlives the cache",
    post.every((g) => g.status === 401),
    JSON.stringify(histogram(post.map((g) => g.status))),
  );
  inv(
    ctx,
    "logout: refused GETs never touched the bookmark table",
    bookmarks.reads === gets.filter((g) => g.status === 200).length + 1,
    `${bookmarks.reads} reads for ${
      gets.filter((g) => g.status === 200).length
    } admitted GETs (+1 warm-up)`,
  );
  commonGetChecks(ctx, gets, "logout");
};

const clockSkew: Scenario = async (ctx, lanes) => {
  const user = await newUser(ctx, "skew", 0);
  const session = ctx.h.fake.sessions.get(user.sessionId);
  assert(session, "fake session must exist after bootstrap");
  const nowS = Math.floor(Date.now() / 1000);
  const kinds = [
    { tag: "past", exp: nowS - ctx.prng.int(1, 86_400), expect: 401 },
    { tag: "boundary", exp: nowS, expect: 401 },
    { tag: "near", exp: nowS + 2, expect: 200 }, // inside the 5 s no-cache band
    { tag: "soon", exp: nowS + ctx.prng.int(6, 59), expect: 200 }, // cacheable read, sub-minute → not written
    {
      tag: "far",
      exp: nowS + 3600 * 24 * 365 * ctx.prng.int(1, 50),
      expect: 200,
    },
    { tag: "float", exp: nowS + 120.75, expect: 200 },
  ];
  const tokens = kinds.map((k) => ({
    ...k,
    token: skewedToken(ctx.h, session, k.exp, k.tag),
  }));
  const plan = Array.from(
    { length: lanes },
    (_, lane) => tokens[lane % tokens.length],
  );
  const getUserBefore = ctx.h.fake.counters["gotrue.get_user"] ?? 0;
  const gets = await Promise.all(
    plan.map((p, lane) =>
      timed(
        ctx,
        lane,
        `catalog.get.${p.tag}`,
        () =>
          ctx.h.handler(
            edgeRequest("GET", catalogPath(), {
              token: p.token,
              ip: ctx.ip(lane),
            }),
          ),
      )
    ),
  );
  const mismatches = gets.filter((g, i) => g.status !== plan[i].expect).map((
    g,
    i,
  ) => `${plan[i]?.tag ?? i}→${g.status}`);
  inv(
    ctx,
    "clock_skew: status follows the bearer's exp (past/boundary 401, future 200), never 5xx",
    mismatches.length === 0,
    mismatches.length
      ? mismatches.slice(0, 6).join(",")
      : JSON.stringify(histogram(gets.map((g) => `${g.row.op}:${g.status}`))),
  );
  inv(
    ctx,
    "clock_skew: expired bearers are refused before Supabase Auth is consulted",
    (ctx.h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore <=
      plan.filter((p) => p.expect === 200).length,
    `${
      (ctx.h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore
    } getUser calls for ${
      plan.filter((p) => p.expect === 200).length
    } live bearers`,
  );
  // Second wave on the near-expiry bearer only: it may not be cached (its
  // remaining life is under the cache floor), so each request must re-verify.
  const near = tokens.find((t) => t.tag === "near")!;
  const before = ctx.h.fake.counters["gotrue.get_user"] ?? 0;
  const wave = await Promise.all(
    Array.from(
      { length: 4 },
      (_, i) =>
        timed(ctx, lanes + i, "catalog.get.near.again", () =>
          ctx.h.handler(
            edgeRequest("GET", catalogPath(), {
              token: near.token,
              ip: ctx.ip(lanes + i),
            }),
          )),
    ),
  );
  const stillLive = near.exp * 1000 > Date.now();
  inv(
    ctx,
    "clock_skew: a bearer inside the no-cache band is re-verified on every request (or refused once expired)",
    stillLive
      ? wave.every((g) => g.status === 200) &&
        (ctx.h.fake.counters["gotrue.get_user"] ?? 0) - before === wave.length
      : wave.every((g) => g.status === 401 || g.status === 200),
    `live=${stillLive} statuses=${
      JSON.stringify(histogram(wave.map((g) => g.status)))
    } getUser=${(ctx.h.fake.counters["gotrue.get_user"] ?? 0) - before}`,
  );
  // Let the boundary bearer age past exp and confirm the refusal is stable.
  const boundary = tokens.find((t) => t.tag === "boundary")!;
  const late = await timed(
    ctx,
    lanes + 4,
    "catalog.get.boundary.late",
    () =>
      ctx.h.handler(
        edgeRequest("GET", catalogPath(), {
          token: boundary.token,
          ip: ctx.ip(lanes + 4),
        }),
      ),
  );
  inv(
    ctx,
    "clock_skew: exp == now stays 401",
    late.status === 401,
    `status=${late.status}`,
  );
  commonGetChecks(ctx, [...gets, ...wave], "clock_skew");
};

const cancelDuringCall: Scenario = async (ctx, lanes) => {
  const user = await newUser(ctx, "cancel", 0);
  const readsBefore = bookmarks.reads;
  const plan = Array.from({ length: lanes }, (_, lane) => ({
    lane,
    abortAt: ctx.prng.int(0, 3) === 0
      ? -1
      : ctx.prng.int(0, STRESS_LATENCY_MS * 2), // -1 = already aborted
  }));
  ctx.observations.plan = plan.map((p) => `${p.lane}@${p.abortAt}`);
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled += 1;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const results = await Promise.all(
      plan.map((p) => {
        const controller = new AbortController();
        if (p.abortAt < 0) {
          controller.abort(new DOMException("client gone", "AbortError"));
        } else {sleep(p.abortAt).then(() =>
            controller.abort(new DOMException("client gone", "AbortError"))
          );}
        const request = new Request(
          `http://edge.xc.test/functions/v1/api${catalogPath()}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${user.accessToken}`,
              "x-forwarded-for": ctx.ip(p.lane),
            },
            signal: controller.signal,
          },
        );
        return timed(
          ctx,
          p.lane,
          "catalog.get.cancel",
          () => ctx.h.handler(request),
        );
      }),
    );
    inv(
      ctx,
      "cancel: the handler answers every aborted request (200) instead of throwing or hanging",
      results.every((r) => r.status === 200),
      JSON.stringify(
        histogram(
          results.map((r) =>
            `${r.status}${r.row.code ? `:${r.row.code}` : ""}`
          ),
        ),
      ),
    );
    inv(
      ctx,
      "cancel: exactly one bookmark read per request, cancelled or not",
      bookmarks.reads - readsBefore === lanes,
      `${bookmarks.reads - readsBefore} reads for ${lanes} requests`,
    );
    inv(
      ctx,
      "cancel: read-only route left no bookmark rows behind",
      bookmarks.rows.length === 0,
      `${bookmarks.rows.length} rows`,
    );
    await sleep(STRESS_LATENCY_MS * 3 + 5);
    inv(
      ctx,
      "cancel: no unhandled rejection escaped",
      unhandled === 0,
      `${unhandled} unhandled rejections`,
    );
    const after = await readOp(ctx, lanes, user.accessToken, 0);
    inv(
      ctx,
      "cancel: a plain GET after the cancelled burst is 200",
      after.status === 200,
      `status=${after.status}`,
    );
    commonGetChecks(ctx, results, "cancel");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
};

const filterFuzz: Scenario = async (ctx, lanes) => {
  const user = await newUser(ctx, "fuzz", 0);
  const pool = await slugPool(ctx.prng);
  // Pre-save a seeded subset so `saved` merging is exercised under filters.
  const saved = pool.slice(0, ctx.prng.int(0, pool.length));
  for (const slug of saved) {
    const put = await writeOp(ctx, 0, user.accessToken, slug, true, 0);
    inv(
      ctx,
      `filter_fuzz: pre-save ${slug} is 200`,
      put.status === 200,
      `status=${put.status}`,
    );
  }
  const queries: Array<{ q?: string; family?: string }> = [];
  for (let i = 0; i < lanes; i++) queries.push(await seededQuery(ctx.prng));
  ctx.observations.queries = queries;
  const expected = await Promise.all(
    queries.map((qf) => oracle(qf.q, qf.family)),
  );
  const gets = await Promise.all(
    queries.map((qf, lane) =>
      readOp(
        ctx,
        lane,
        user.accessToken,
        ctx.prng.int(0, STRESS_LATENCY_MS),
        qf.q,
        qf.family,
      )
    ),
  );
  inv(
    ctx,
    "filter_fuzz: every filtered GET is 200",
    gets.every((g) => g.status === 200),
    JSON.stringify(histogram(gets.map((g) => g.status))),
  );
  const wrong: string[] = [];
  gets.forEach((g, i) => {
    if (g.status !== 200) return;
    const items = itemsOf(g.body);
    if (!items) {
      wrong.push(`lane ${i}: unparsable`);
      return;
    }
    if (items.map((x) => x.slug).join(",") !== expected[i].join(",")) {
      wrong.push(
        `lane ${i}: q=${JSON.stringify(queries[i].q)} family=${
          JSON.stringify(queries[i].family)
        } got ${items.length} want ${expected[i].length}`,
      );
    }
    const savedSet = new Set(saved);
    for (const item of items) {
      if (item.saved !== savedSet.has(item.slug)) {
        wrong.push(`lane ${i}: saved flag wrong for ${item.slug}`);
      }
    }
  });
  inv(
    ctx,
    "filter_fuzz: every concurrent body equals its sequential oracle, saved flags merged",
    wrong.length === 0,
    wrong.length
      ? wrong.slice(0, 4).join(" | ")
      : `${gets.length} bodies matched`,
  );
  const ids = new Map<string, string>();
  let idDrift = 0;
  for (const g of gets) {
    for (const item of itemsOf(g.body) ?? []) {
      const prev = ids.get(item.slug);
      if (prev && prev !== item.id) idDrift += 1;
      ids.set(item.slug, item.id);
    }
  }
  inv(
    ctx,
    "filter_fuzz: catalog ids are stable across concurrent responses",
    idDrift === 0,
    `${idDrift} drifting ids across ${ids.size} slugs`,
  );
  commonGetChecks(ctx, gets, "filter_fuzz");
};

const rateLimitAtomic: Scenario = async (ctx, _lanes) => {
  const user = await newUser(ctx, "rl", 0);
  const over = ctx.prng.int(5, 40);
  const burst = GENERAL_USER_LIMIT + over; // bootstrap already spent 1 of the budget
  ctx.observations.burst = burst;
  const readsBefore = bookmarks.reads;
  // rateLimit.ts uses ALIGNED fixed windows (floor(now / windowSeconds)), so a
  // burst that crosses a bucket boundary legitimately gets a fresh budget.
  const bucketAt = () =>
    Math.floor(Date.now() / (GENERAL_USER_WINDOW_S * 1000));
  const startBucket = bucketAt();
  const gets = await Promise.all(
    Array.from(
      { length: burst },
      (_, lane) =>
        timed(ctx, lane, "catalog.get", () =>
          ctx.h.handler(
            edgeRequest("GET", catalogPath(), {
              token: user.accessToken,
              ip: ctx.ip(0),
            }),
          )),
    ),
  );
  const endBucket = bucketAt();
  const rolled = endBucket !== startBucket;
  ctx.observations.windowRollover = rolled;
  const ok = gets.filter((g) => g.status === 200).length;
  const limited = gets.filter((g) => g.status === 429);
  const expectedOk = GENERAL_USER_LIMIT - 1;
  // Exact when the burst stayed inside one aligned window; across a boundary
  // at most one extra full window may be granted, and nothing may go uncounted.
  const admissionOk = rolled
    ? ok >= expectedOk && ok <= expectedOk + GENERAL_USER_LIMIT &&
      ok + limited.length === burst
    : ok === expectedOk && limited.length === burst - expectedOk;
  inv(
    ctx,
    "rate_limit: exactly the remaining general budget is admitted, the rest 429 (one extra aligned window allowed if the burst crosses a boundary)",
    admissionOk,
    `200=${ok} 429=${limited.length} other=${
      burst - ok - limited.length
    } (budget ${GENERAL_USER_LIMIT}, 1 spent by bootstrap, window rollover=${rolled})`,
  );
  inv(
    ctx,
    "rate_limit: every 429 carries Retry-After and RateLimit-Limit",
    limited.every((g) =>
      Number(g.headers.get("retry-after")) >= 1 &&
      g.headers.get("ratelimit-limit") === String(GENERAL_USER_LIMIT)
    ),
    `${limited.length} refusals checked`,
  );
  inv(
    ctx,
    "rate_limit: refused requests never reach the bookmark table",
    bookmarks.reads - readsBefore === ok,
    `${bookmarks.reads - readsBefore} reads for ${ok} admitted GETs`,
  );
  commonGetChecks(ctx, gets, "rate_limit");
};

const SCENARIOS: Array<{ name: string; run: Scenario }> = [
  { name: "dup_burst", run: dupBurst },
  { name: "call_during_call", run: callDuringCall },
  { name: "two_actors", run: twoActors },
  { name: "rotation_during_call", run: rotationDuringCall },
  { name: "logout_during_call", run: logoutDuringCall },
  { name: "clock_skew", run: clockSkew },
  { name: "cancel_during_call", run: cancelDuringCall },
  { name: "filter_fuzz", run: filterFuzz },
  { name: "rate_limit_atomic", run: rateLimitAtomic },
];

function scenarioFor(seed: number): { name: string; run: Scenario } {
  if (STRESS_SCENARIO) {
    const forced = SCENARIOS.find((s) => s.name === STRESS_SCENARIO);
    if (!forced) {
      throw new Error(
        `STRESS_SCENARIO=${STRESS_SCENARIO} is not one of ${
          SCENARIOS.map((s) => s.name).join(",")
        }`,
      );
    }
    return forced;
  }
  return SCENARIOS[seed % SCENARIOS.length];
}

// ── One iteration ────────────────────────────────────────────────────────────

interface SeedRow {
  seed: number;
  i: number;
  scenario: string;
  lanes: number;
  outcome: "HELD" | "BROKEN";
  durationMs: number;
  requests: number;
  statuses: Record<string, number>;
  broken: string[];
  /** Set when every broken invariant is the defect pinned by "stress minimized". */
  defect?: string;
  observations: Record<string, unknown>;
  replay: string;
}

async function iteration(
  i: number,
  seed: number,
): Promise<{ row: SeedRow; detail: Record<string, unknown> }> {
  const h = await harness();
  const scenario = scenarioFor(seed);
  h.fake.reset(seed, STRESS_LATENCY_MS);
  bookmarks.reset(new Prng((seed ^ 0x5bd1e995) >>> 0), STRESS_LATENCY_MS);
  h.upstreamCalls.length = 0;
  const prng = new Prng((Math.imul(seed, 0x9e3779b1) ^ 0x7f4a7c15) >>> 0);
  const lanes = STRESS_LANES || prng.int(8, 32);
  // Each seed owns a /24 (10.S.S.x) so the edge fn's per-isolate IP windows
  // never bleed between iterations; lanes beyond 250 share the last host.
  const ip = (lane: number) =>
    `10.${(seed >>> 8) & 255}.${seed & 255}.${1 + Math.min(lane, 250)}`;
  const ctx: Ctx = {
    h,
    seed,
    prng,
    rows: [],
    invariants: [],
    observations: {},
    ip,
  };
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  let threw: string | null = null;
  try {
    await withDeadline(
      scenario.run(ctx, lanes),
      STRESS_WALL_MS,
      "scenario (deadlock/hang suspected)",
    );
  } catch (error) {
    threw = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
  const durationMs = Math.round(performance.now() - t0);
  inv(
    ctx,
    "scenario completed without throwing",
    threw === null,
    threw ?? "ok",
  );
  inv(
    ctx,
    `bounded wall time (< ${STRESS_WALL_MS}ms)`,
    durationMs < STRESS_WALL_MS,
    `${durationMs}ms`,
  );
  const attributed = attributedToPinnedRace(ctx.rows);
  const fivexx = ctx.rows.filter((r) =>
    (r.status >= 500 || r.status < 0) && !attributed.has(r)
  );
  const explained = explainWriteFailures(ctx.rows);
  inv(
    ctx,
    "no 5xx / thrown handler anywhere (other than the pinned race)",
    fivexx.length === 0,
    fivexx.length
      ? `${
        JSON.stringify(histogram(fivexx.map((r) => `${r.op}:${r.status}`)))
      }${explained.length ? ` — ${explained.join("; ")}` : ""}`
      : `${ctx.rows.length} responses`,
  );
  inv(
    ctx,
    PINNED_PUT_DELETE_RACE,
    attributed.size === 0,
    attributed.size
      ? [...attributed].map((r) =>
        `lane ${r.lane} PUT ${r.slug} → 503 while the same user's ${
          sameUserOverlaps(ctx.rows, r).filter((o) => o.op === "saved.delete")
            .map((o) => `lane ${o.lane} DELETE`).join(", ")
        } overlapped`
      ).join("; ")
      : "no attributed 503",
  );
  ctx.observations.writeFailures = explained;
  ctx.observations.pinnedRaceHits = attributed.size;
  const broken = ctx.invariants.filter((x) => !x.holds).map((x) =>
    `${x.name} — ${x.detail}`
  );
  const onlyPinned = broken.length > 0 &&
    ctx.invariants.filter((x) => !x.holds).every((x) =>
      x.name === PINNED_PUT_DELETE_RACE
    );
  const after = Deno.memoryUsage();
  const row: SeedRow = {
    seed,
    i,
    scenario: scenario.name,
    lanes,
    outcome: broken.length === 0 ? "HELD" : "BROKEN",
    durationMs,
    requests: ctx.rows.length,
    statuses: histogram(
      ctx.rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`),
    ),
    broken,
    defect: onlyPinned ? "saveDrill_put_delete_race" : undefined,
    observations: ctx.observations,
    replay: replayCommand(seed, "campaign"),
  };
  const detail = {
    ...row,
    invariants: ctx.invariants,
    rows: ctx.rows,
    upstreamTimeline: h.fake.timeline,
    upstreamCalls: h.upstreamCalls.length,
    counters: h.fake.counters,
    bookmarkRows: bookmarks.rows,
    heap: { before, after },
  };
  return { row, detail };
}

// ── The campaign ─────────────────────────────────────────────────────────────

Deno.test(`stress GET /v1/catalog/drills — concurrency campaign (${STRESS_ITER} seeded iterations from ${STRESS_SEED}, latency ≤ ${STRESS_LATENCY_MS}ms)`, async () => {
  const dir = outDir();
  await Deno.mkdir(`${dir}broken/`, { recursive: true });
  const table: SeedRow[] = [];
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  for (let i = 0; i < STRESS_ITER; i++) {
    const seed = (STRESS_SEED + i) >>> 0;
    const { row, detail } = await iteration(i, seed);
    table.push(row);
    if (row.outcome === "BROKEN") {
      await Deno.writeTextFile(
        `${dir}broken/${seed}.json`,
        JSON.stringify(detail, null, 2),
      );
      console.log(
        `[stress] seed=${seed} ${row.scenario} BROKEN: ${
          row.broken.join(" | ")
        }`,
      );
    }
  }
  const heapAfter = Deno.memoryUsage();
  const byScenario: Record<
    string,
    {
      iterations: number;
      held: number;
      broken: number;
      requests: number;
      maxMs: number;
    }
  > = {};
  for (const r of table) {
    const s = byScenario[r.scenario] ??
      { iterations: 0, held: 0, broken: 0, requests: 0, maxMs: 0 };
    s.iterations += 1;
    s.held += r.outcome === "HELD" ? 1 : 0;
    s.broken += r.outcome === "BROKEN" ? 1 : 0;
    s.requests += r.requests;
    s.maxMs = Math.max(s.maxMs, r.durationMs);
    byScenario[r.scenario] = s;
  }
  const summary = {
    unit: "route-get-v1-catalog-drills",
    lens: "concurrency",
    handler:
      "supabase/functions/api/index.ts listCatalogDrills (real handler in-process via Deno.serve capture)",
    config: {
      STRESS_SEED,
      STRESS_ITER,
      STRESS_LATENCY_MS,
      STRESS_WALL_MS,
      STRESS_LANES,
      STRESS_SCENARIO,
      STRESS_STRICT,
    },
    iterations: table.length,
    held: table.filter((r) => r.outcome === "HELD").length,
    broken: table.filter((r) => r.outcome === "BROKEN").length,
    brokenSeeds: table.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
    brokenOnlyByPinnedRace: table.filter((r) => r.defect !== undefined).map((
      r,
    ) => r.seed),
    brokenUnattributed: table.filter((r) =>
      r.outcome === "BROKEN" && r.defect === undefined
    ).map((r) => r.seed),
    pinnedRaceHits: table.reduce(
      (n, r) => n + Number(r.observations.pinnedRaceHits ?? 0),
      0,
    ),
    requests: table.reduce((n, r) => n + r.requests, 0),
    durationMs: Math.round(performance.now() - t0),
    maxIterationMs: Math.max(0, ...table.map((r) => r.durationMs)),
    byScenario,
    heap: { before: heapBefore, after: heapAfter },
    coldBurstGetUserCalls: table.filter((r) => r.scenario === "dup_burst").map((
      r,
    ) => ({
      seed: r.seed,
      lanes: r.lanes,
      getUser: r.observations.getUserCallsForColdBurst,
    })),
    generatedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(`${dir}seeds.json`, JSON.stringify(table, null, 2));
  await Deno.writeTextFile(
    `${dir}summary.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(
    `[stress] ${summary.iterations} iterations, ${summary.requests} requests, held=${summary.held} broken=${summary.broken} (pinned-race-only=${summary.brokenOnlyByPinnedRace.length}, unattributed=${summary.brokenUnattributed.length}), ${summary.durationMs}ms → ${dir}`,
  );
  for (const [name, s] of Object.entries(byScenario)) {
    console.log(
      `[stress]   ${name}: ${s.iterations} iterations, ${s.requests} requests, broken=${s.broken}, max ${s.maxMs}ms`,
    );
  }
  assert(
    table.length === STRESS_ITER,
    `ran ${table.length} of ${STRESS_ITER} iterations`,
  );
  const failing = STRESS_STRICT
    ? summary.brokenSeeds
    : summary.brokenUnattributed;
  assertEquals(
    failing,
    [],
    `BROKEN seeds: ${
      failing.join(",")
    } — see ${dir}broken/<seed>.json; replay with STRESS_SEED=<seed> STRESS_ITER=1${
      STRESS_STRICT
        ? ""
        : ` (seeds broken only by the pinned saveDrill race: ${
          summary.brokenOnlyByPinnedRace.join(",") || "none"
        } — that defect fails the 'stress minimized' test)`
    }`,
  );
});

// ── Minimized interleaving found by the campaign (seed 20260909, call_during_call)
//
// saveDrill (index.ts) is two statements: `upsert … ignoreDuplicates` then
// `select slug, saved_at … maybeSingle()`. When the SAME user's DELETE of that
// slug lands between them (second device, double-tap of save→unsave, retry of
// a timed-out unsave), the select finds no row and the route answers 503
// "Drill save" — a generic server-fault status for a client-visible race the
// database resolved correctly (the settled state IS "unsaved"). Pinned here
// with a zero-latency deterministic interleaving so the row does not depend on
// the scheduler. Read-only GET /v1/catalog/drills itself is unaffected.

Deno.test("stress minimized: PUT /v1/me/saved-drills/:slug racing the same user's DELETE answers 503 (saveDrill upsert→select is not atomic)", async () => {
  const h = await harness();
  const seed = 20260909;
  h.fake.reset(seed, 0);
  bookmarks.reset(new Prng(seed), 0);
  const prng = new Prng(seed);
  const ip = (lane: number) => `10.250.${seed & 255}.${1 + lane}`;
  const ctx: Ctx = {
    h,
    seed,
    prng,
    rows: [],
    invariants: [],
    observations: {},
    ip,
  };
  const user = await newUser(ctx, "min", 0);
  const slug = (await slugPool(prng))[0];
  let deleteStatus = -1;
  let fired = 0;
  bookmarks.beforeRowSelect = async (_who, s) => {
    if (s !== slug || fired > 0) return;
    fired += 1;
    const res = await writeOp(ctx, 1, user.accessToken, slug, false, 0);
    deleteStatus = res.status;
  };
  const put = await writeOp(ctx, 0, user.accessToken, slug, true, 0);
  const settled = await readOp(ctx, 2, user.accessToken, 0);
  const settledSaved = (itemsOf(settled.body) ?? []).find((i) =>
    i.slug === slug
  )?.saved;
  const outcome = {
    seed,
    slug,
    interleaving:
      "PUT.upsert → DELETE (commits) → PUT.select(maybeSingle) → 0 rows",
    put: { status: put.status, body: put.body },
    delete: { status: deleteStatus },
    settledCatalogSaved: settledSaved,
    bookmarkRows: bookmarks.rows.length,
    expected:
      "PUT answers a non-5xx, coherent status (e.g. 200 {saved:true} reflecting its own write, or a 409/…) — the DB state is consistent and no server fault occurred",
    observed: `PUT ${put.status} ${JSON.stringify(put.body)}`,
    replay:
      `deno test -A --no-check --config deno.json stress_catalog_drills_concurrency.test.ts --filter "stress minimized"`,
  };
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}minimized_put_delete_race.json`,
    JSON.stringify(outcome, null, 2),
  );
  assertEquals(
    fired,
    1,
    "the pinned DELETE must have run between upsert and select",
  );
  assertEquals(deleteStatus, 204);
  assertEquals(settled.status, 200);
  assertEquals(
    settledSaved,
    false,
    "settled state is unsaved (DELETE was the last write) — the database is consistent",
  );
  assertEquals(bookmarks.rows.length, 0);
  assert(
    put.status < 500,
    `PUT /v1/me/saved-drills/${slug} answered ${put.status} ${
      JSON.stringify(put.body)
    } for a client race the database resolved cleanly → ${dir}minimized_put_delete_race.json`,
  );
});

// ── Postgres half: the real user_saved_drills table under contention ─────────
//
// The route's only database dependency is `select slug from user_saved_drills
// where user_id = auth.uid()` (PostgREST, RLS) racing the bookmark writes
// (`insert … on conflict (user_id, slug) do nothing`, `delete … where user_id
// and slug`). This drives exactly those statements as role `authenticated`
// from N independent autocommit connections released by a barrier on docker
// postgres:16 with shim_auth.sql + every migration (./xc_pg_up.sh).
//
// Oracle: each statement is an interval [serverStartMs, serverEndMs] measured
// on the server (clock_timestamp) around the autocommitted statement. A read
// value is legal iff SOME linearization that respects real-time order (an op
// that ends before another starts must precede it) produces it — the standard
// register check, applied per (user, slug) key. The settled table is checked
// the same way against a virtual read at +∞.

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const PG_ROUNDS = envInt("STRESS_PG_ROUNDS", 4);
const PG_LANES = envInt("STRESS_PG_LANES", 16);

type Sql = ReturnType<typeof postgres>;
type Reserved = Awaited<ReturnType<Sql["reserve"]>>;

interface PgLane {
  round: number;
  lane: number;
  user: "A" | "B";
  kind: "select" | "upsert" | "delete";
  slug: string;
  result: string;
  /** For selects: `${user}|${slug}` keys visible (RLS-filtered, no WHERE). */
  rows?: string[];
  serverStartMs: number;
  serverEndMs: number;
}

interface Interval {
  start: number;
  end: number;
}

/** Can a read over `window` legally observe `value` for one key, given the
 * writes (upsert=true / delete=false) on that key? A write W can precede the
 * read iff W.start < window.end; a write X is "stuck strictly between" W and
 * the read iff X.start >= W.end && X.end <= window.start. */
function couldRead(
  value: boolean,
  window: Interval,
  writes: Array<Interval & { saved: boolean }>,
): boolean {
  // Initial state (false) is legal when every upsert can be ordered after the read.
  if (
    !value && writes.filter((w) => w.saved).every((w) => w.end > window.start)
  ) return true;
  const candidates = writes.filter((w) =>
    w.saved === value && w.start < window.end
  );
  return candidates.some((w) =>
    !writes.some((x) =>
      x.saved !== value && x.start >= w.end && x.end <= window.start
    )
  );
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function serverNowMs(c: Reserved): Promise<number> {
  const r = await c.unsafe(
    `select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`,
  );
  return Number(r[0].t);
}

Deno.test({
  name:
    `stress PG: user_saved_drills — ${PG_ROUNDS} rounds × ${PG_LANES} lanes of concurrent upsert/delete/select as two authenticated users (seed ${STRESS_SEED})`,
  ignore: PG_URL === "",
  async fn() {
    const sql = postgres(PG_URL, { max: PG_LANES + 4, onnotice: () => {} });
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const report: Array<Record<string, unknown>> = [];
    const brokenRounds: string[] = [];
    try {
      const catalog = await drillCatalog();
      for (let round = 0; round < PG_ROUNDS; round++) {
        const seed = (STRESS_SEED + round) >>> 0;
        const prng = new Prng((Math.imul(seed, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0);
        const users = { A: prng.uuid(), B: prng.uuid() };
        for (const id of Object.values(users)) {
          await sql.unsafe(`delete from auth.users where id = '${id}'`);
          await sql.unsafe(
            `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
          );
        }
        const slugs = prng.shuffle(catalog.map((d) => d.slug)).slice(0, 3);
        const KINDS = ["select", "upsert", "delete"] as const;
        const plan = Array.from({ length: PG_LANES }, (_, lane) => ({
          lane,
          user: (lane % 2 === 0 ? "A" : "B") as "A" | "B",
          kind: KINDS[prng.int(0, 2)],
          slug: slugs[prng.int(0, slugs.length - 1)],
        }));
        plan[0] = { lane: 0, user: "A", kind: "upsert", slug: slugs[0] };
        plan[1] = { lane: 1, user: "B", kind: "upsert", slug: slugs[0] };
        if (plan.length > 2) {
          plan[2] = { lane: 2, user: "A", kind: "upsert", slug: slugs[0] }; // duplicate upsert, same row
        }
        if (plan.length > 3) plan[3].kind = "select";
        if (plan.length > 4) {
          plan[4] = { lane: 4, user: "A", kind: "delete", slug: slugs[0] };
        }

        const b = barrier();
        let ready = 0;
        const lanes: PgLane[] = [];
        const all = Promise.all(
          plan.map(async (p) => {
            const c = await sql.reserve();
            try {
              await c.unsafe(`set role authenticated`);
              await c.unsafe(
                `select set_config('request.jwt.claim.sub', $1, false)`,
                [users[p.user]],
              );
              ready += 1;
              await b.gate;
              const t0 = await serverNowMs(c);
              let result = "ok";
              let rows: string[] | undefined;
              try {
                if (p.kind === "select") {
                  const r = await c.unsafe(
                    `select user_id::text as user_id, slug from public.user_saved_drills`,
                  );
                  rows = r.map((x) =>
                    `${
                      x.user_id === users.A
                        ? "A"
                        : x.user_id === users.B
                        ? "B"
                        : x.user_id
                    }|${x.slug}`
                  ).sort();
                } else if (p.kind === "upsert") {
                  await c.unsafe(
                    `insert into public.user_saved_drills (user_id, slug) values ($1, $2) on conflict (user_id, slug) do nothing`,
                    [users[p.user], p.slug],
                  );
                } else {
                  await c.unsafe(
                    `delete from public.user_saved_drills where user_id = $1 and slug = $2`,
                    [users[p.user], p.slug],
                  );
                }
              } catch (error) {
                const code = isRecord(error) && typeof error.code === "string"
                  ? error.code
                  : "";
                result = `error:${
                  code ||
                  (error instanceof Error ? error.message : String(error))
                }`;
              }
              const t1 = await serverNowMs(c);
              lanes.push({
                round,
                lane: p.lane,
                user: p.user,
                kind: p.kind,
                slug: p.slug,
                result,
                rows,
                serverStartMs: t0,
                serverEndMs: t1,
              });
            } finally {
              await c.unsafe(`reset role`).catch(() => {});
              await c.unsafe(
                `select set_config('request.jwt.claim.sub', '', false)`,
              ).catch(() => {});
              c.release();
            }
          }),
        );
        const waitStart = performance.now();
        while (ready < plan.length) {
          if (performance.now() - waitStart > STRESS_WALL_MS) {
            throw new Error("PG lanes never reached the barrier");
          }
          await sleep(1);
        }
        b.open();
        const t0 = performance.now();
        await withDeadline(
          all,
          STRESS_WALL_MS,
          "PG burst (deadlock suspected)",
        );
        const durationMs = Math.round(performance.now() - t0);
        lanes.sort((x, y) => x.lane - y.lane);

        const invariants: Invariant[] = [];
        const errors = lanes.filter((l) => l.result !== "ok");
        invariants.push({
          name:
            "no statement failed (no 23505 duplicate key, no 40P01 deadlock, no 42501 RLS refusal)",
          holds: errors.length === 0,
          detail: errors.length
            ? errors.map((e) => `${e.lane}:${e.kind}:${e.slug}:${e.result}`)
              .join(",")
            : `${lanes.length} lanes ok`,
        });
        const overlap = lanes.filter((a) =>
          lanes.some((c) =>
            c !== a && a.serverStartMs < c.serverEndMs &&
            c.serverStartMs < a.serverEndMs
          )
        ).length;
        invariants.push({
          name: "lanes genuinely overlapped on the server",
          holds: overlap >= 2,
          detail: `${overlap} of ${lanes.length} lanes overlapped another`,
        });
        const dupRows = await sql.unsafe(
          `select user_id, slug, count(*)::int as n from public.user_saved_drills where user_id in ($1, $2) group by 1,2 having count(*) > 1`,
          [users.A, users.B],
        );
        invariants.push({
          name: "no duplicate (user_id, slug) rows",
          holds: dupRows.length === 0,
          detail: `${dupRows.length} duplicated pairs`,
        });

        const writesOf = (key: string) =>
          lanes
            .filter((l) =>
              l.kind !== "select" && l.result === "ok" &&
              `${l.user}|${l.slug}` === key
            )
            .map((l) => ({
              start: l.serverStartMs,
              end: l.serverEndMs,
              saved: l.kind === "upsert",
            }));
        const keys = [
          ...new Set(
            lanes.filter((l) =>
              l.kind !== "select"
            ).map((l) => `${l.user}|${l.slug}`),
          ),
        ];

        const leaks: string[] = [];
        const nonlinear: string[] = [];
        for (const l of lanes) {
          if (!l.rows) {
            continue;
          }
          const foreign = l.rows.filter((k) =>
            !k.startsWith(`${l.user}|`)
          );
          if (foreign.length) {
            leaks.push(`lane ${l.lane} (${l.user}) saw ${foreign.join(",")}`);
          }
          const seen = new Set(l.rows);
          for (const key of keys) {
            if (!key.startsWith(`${l.user}|`)) continue;
            const value = seen.has(key);
            if (
              !couldRead(
                value,
                { start: l.serverStartMs, end: l.serverEndMs },
                writesOf(key),
              )
            ) {
              nonlinear.push(
                `lane ${l.lane} read ${key}=${value} but no real-time-respecting order explains it`,
              );
            }
          }
        }
        invariants.push({
          name: "RLS: every concurrent select saw only its own user's rows",
          holds: leaks.length === 0,
          detail: leaks.length
            ? leaks.join(" | ")
            : `${lanes.filter((l) => l.rows).length} selects isolated`,
        });
        invariants.push({
          name: "every concurrent select is linearizable per (user, slug)",
          holds: nonlinear.length === 0,
          detail: nonlinear.length
            ? nonlinear.join(" | ")
            : `${lanes.filter((l) => l.rows).length} selects explained`,
        });

        // RLS isolation after the burst, directly as each user.
        for (const who of ["A", "B"] as const) {
          const c = await sql.reserve();
          let seen: string[] = [];
          try {
            await c.unsafe(`set role authenticated`);
            await c.unsafe(
              `select set_config('request.jwt.claim.sub', $1, false)`,
              [users[who]],
            );
            const r = await c.unsafe(
              `select user_id::text as user_id, slug from public.user_saved_drills`,
            );
            seen = r.map((x) => `${x.user_id}|${x.slug}`);
          } finally {
            await c.unsafe(`reset role`).catch(() => {});
            await c.unsafe(
              `select set_config('request.jwt.claim.sub', '', false)`,
            ).catch(() => {});
            c.release();
          }
          const foreign = seen.filter((s) => !s.startsWith(`${users[who]}|`));
          invariants.push({
            name: `RLS: user ${who} sees only own bookmarks after the burst`,
            holds: foreign.length === 0,
            detail: `${seen.length} rows visible, ${foreign.length} foreign`,
          });
        }

        // Settled table: a virtual read at +∞ must be explainable per key (no lost update).
        const settled = await sql.unsafe(
          `select user_id::text as user_id, slug from public.user_saved_drills where user_id in ($1, $2) order by 1,2`,
          [users.A, users.B],
        );
        const settledSet = new Set(
          settled.map((x) => `${x.user_id === users.A ? "A" : "B"}|${x.slug}`),
        );
        const unexplained: string[] = [];
        for (const key of keys) {
          const value = settledSet.has(key);
          if (
            !couldRead(value, { start: Infinity, end: Infinity }, writesOf(key))
          ) {
            unexplained.push(`${key}=${value}`);
          }
        }
        const strayKeys = [...settledSet].filter((k) => !keys.includes(k));
        invariants.push({
          name:
            "settled table is explained by a real-time-respecting order of the writes (no lost update, no phantom row)",
          holds: unexplained.length === 0 && strayKeys.length === 0,
          detail: `table=[${[...settledSet].sort().join(",")}]${
            unexplained.length ? ` unexplained=[${unexplained.join(",")}]` : ""
          }${strayKeys.length ? ` stray=[${strayKeys.join(",")}]` : ""}`,
        });
        invariants.push({
          name: `bounded wall time (< ${STRESS_WALL_MS}ms)`,
          holds: durationMs < STRESS_WALL_MS,
          detail: `${durationMs}ms`,
        });
        const broken = invariants.filter((x) => !x.holds);
        if (broken.length) {
          brokenRounds.push(`round ${round} seed ${seed}: ${
            broken.map((x) => `${x.name} — ${x.detail}`).join(" | ")
          }`);
        }
        report.push({
          round,
          seed,
          users,
          slugs,
          plan: plan.map((p) =>
            `${p.lane}:${p.user}:${p.kind}:${p.slug}`
          ),
          lanes,
          invariants,
          durationMs,
          outcome: broken.length ? "BROKEN" : "HELD",
          replay:
            `XC_PG_URL=<url> STRESS_SEED=${seed} STRESS_PG_ROUNDS=1 STRESS_PG_LANES=${PG_LANES} deno test -A --no-check --config deno.json stress_catalog_drills_concurrency.test.ts --filter "stress PG"`,
        });
        console.log(
          `[stress-pg] round ${round} seed ${seed}: ${
            broken.length ? "BROKEN" : "HELD"
          } (${durationMs}ms, overlap ${overlap}/${lanes.length})`,
        );
      }
    } finally {
      await Deno.writeTextFile(
        `${dir}pg_user_saved_drills.json`,
        JSON.stringify(
          { config: { PG_ROUNDS, PG_LANES, STRESS_SEED }, rounds: report },
          null,
          2,
        ),
      );
      await sql.end({ timeout: 5 });
    }
    assertEquals(brokenRounds, [], brokenRounds.join("\n"));
  },
});
