/**
 * stress — concurrency harness for `GET /v1/catalog/drills/:slug`.
 *
 * Shared by stress_catalog_drill_concurrency.test.ts (modelled database) and
 * stress_catalog_drill_pg.test.ts (real postgres:16 behind the PostgREST
 * shim). Runs the REAL edge handler in-process through the xc harness
 * (loadXcHarness: Deno.serve captured, globalThis.fetch → FakeSupabase for
 * GoTrue/RevenueCat/PostgREST) and adds the one table the route reads —
 * `user_saved_drills` — as a swappable `SavedDrillsStore`, so the same
 * scenarios run against an in-memory model and against a real database.
 *
 * Determinism: every iteration is `seed = STRESS_SEED + i`; the seed drives
 * the fake's upstream latency (FakeSupabase.prng), the scheduler (lane start
 * offsets, actor assignment, save/unsave interleaving) and every generated id.
 * A failing iteration replays with the command in its JSON row.
 *
 * Scale knobs (defaults small enough for the suite; the campaign raises them):
 *   STRESS_ITER        iterations per scenario        (default 4)
 *   STRESS_SEED        first seed                      (default 20260904)
 *   STRESS_BURST       lanes per burst                 (default 16)
 *   STRESS_LATENCY_MS  max seeded upstream latency     (default 8)
 *   STRESS_TIMEOUT_MS  per-iteration wall-time bound   (default 15000)
 *   STRESS_OUT_DIR     where <scenario>.json + seeds.json are written
 */
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  type FakeSession,
  histogram,
  type Invariant,
  jwtPayload,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  type TimelineEntry,
  type XcHarness,
} from "./xc_concurrency_harness.ts";
import { drillCatalog } from "../drills.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";

export const STRESS_ITER = envInt("STRESS_ITER", 4);
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_BURST = envInt("STRESS_BURST", 16);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
export const STRESS_TIMEOUT_MS = envInt("STRESS_TIMEOUT_MS", 15_000);

/** index.ts GENERAL_USER_LIMIT — the per-user budget every GET shares. */
export const GENERAL_USER_LIMIT = { limit: 240, windowSeconds: 60 };

// ── The one table the route reads ────────────────────────────────────────────

export interface SavedDrillRow {
  user_id: string;
  slug: string;
  saved_at: string;
}

/** `user_saved_drills` as PostgREST sees it. `principal` is the JWT `sub` of
 * the bearer PostgREST would run the statement as (RLS scope); `userId` /
 * `slug` are the request's `eq.` filters. */
export interface SavedDrillsStore {
  reset(): Promise<void>;
  /** A user minted by the fake GoTrue now exists (the real table has an FK
   * to profiles; the model has no such need). */
  ensureUser(userId: string): Promise<void>;
  /** `select slug from user_saved_drills where user_id = eq and slug = eq` under RLS. */
  select(principal: string | null, userId: string, slug: string): Promise<SavedDrillRow[]>;
  /** `insert … on conflict (user_id, slug) do nothing` under RLS (42501 → false). */
  upsertIgnore(principal: string | null, row: { user_id: string; slug: string }): Promise<boolean>;
  /** `delete … where user_id = eq and slug = eq` under RLS. */
  del(principal: string | null, userId: string, slug: string): Promise<void>;
  /** Every row (owner view) — for duplicate/lost-update checks. */
  all(): Promise<SavedDrillRow[]>;
  /** Owner-role fixture write (seed a bookmark before a scenario). */
  seed(row: { user_id: string; slug: string }): Promise<void>;
}

export class MemorySavedDrills implements SavedDrillsStore {
  rows: SavedDrillRow[] = [];
  reset(): Promise<void> {
    this.rows = [];
    return Promise.resolve();
  }
  ensureUser(_userId: string): Promise<void> {
    return Promise.resolve();
  }
  select(principal: string | null, userId: string, slug: string): Promise<SavedDrillRow[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) => r.user_id === principal && r.user_id === userId && r.slug === slug,
      ),
    );
  }
  upsertIgnore(principal: string | null, row: { user_id: string; slug: string }): Promise<boolean> {
    if (!principal || row.user_id !== principal) return Promise.resolve(false);
    if (!this.rows.some((r) => r.user_id === row.user_id && r.slug === row.slug)) {
      this.rows.push({ ...row, saved_at: new Date().toISOString() });
    }
    return Promise.resolve(true);
  }
  del(principal: string | null, userId: string, slug: string): Promise<void> {
    this.rows = this.rows.filter(
      (r) => !(r.user_id === principal && r.user_id === userId && r.slug === slug),
    );
    return Promise.resolve();
  }
  all(): Promise<SavedDrillRow[]> {
    return Promise.resolve([...this.rows]);
  }
  seed(row: { user_id: string; slug: string }): Promise<void> {
    if (!this.rows.some((r) => r.user_id === row.user_id && r.slug === row.slug)) {
      this.rows.push({ ...row, saved_at: new Date().toISOString() });
    }
    return Promise.resolve();
  }
}

/** One PostgREST call against user_saved_drills, as observed by the shim. */
export interface DbCall {
  t: number;
  method: string;
  principal: string | null;
  userId: string | null;
  slug: string | null;
  /** GET: the number of rows the statement returned (0/1). */
  rows?: number;
  status: number;
}

export interface StressHarness extends XcHarness {
  store: SavedDrillsStore;
  dbCalls: DbCall[];
  /** Reset the fake + store + counters for a fresh seeded iteration. */
  begin(seed: number): Promise<void>;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let loaded: StressHarness | null = null;

/** Load the real handler once and route `user_saved_drills` PostgREST calls
 * to `store` (everything else stays with FakeSupabase). */
export async function loadStressHarness(store: SavedDrillsStore): Promise<StressHarness> {
  if (loaded) {
    if (loaded.store !== store) {
      throw new Error("stress harness already loaded with a different store");
    }
    return loaded;
  }
  const h = await loadXcHarness();
  const inner = globalThis.fetch;
  const dbCalls: DbCall[] = [];
  const prefix = `${SUPABASE_URL}/rest/v1/user_saved_drills`;
  let t0 = performance.now();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (!request.url.startsWith(prefix)) return inner(request);
    const url = new URL(request.url);
    const rawBody = await request.text().catch(() => "");
    const auth = request.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = jwtPayload(bearer);
    const principal = typeof payload?.sub === "string" ? payload.sub : null;
    const eq = (col: string): string | null => {
      const raw = url.searchParams.get(col);
      return raw?.startsWith("eq.") ? raw.slice(3) : null;
    };
    const userId = eq("user_id");
    const slug = eq("slug");
    h.fake.count(`rest.${request.method.toLowerCase()}.user_saved_drills`);
    // Seeded upstream latency, like every other PostgREST call in the fake.
    if (h.fake.latencyMaxMs > 0) await sleep(h.fake.prng.int(0, h.fake.latencyMaxMs));
    const call: DbCall = {
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      principal,
      userId,
      slug,
      status: 0,
    };
    dbCalls.push(call);
    if (request.method === "GET") {
      if (userId === null || slug === null) {
        call.status = 400;
        return jsonResponse(400, { code: "PGRST100", message: "stress shim: unmodelled filter" });
      }
      const rows = await store.select(principal, userId, slug);
      call.rows = rows.length;
      h.fake.log(
        "rest.get.user_saved_drills",
        `principal=${principal?.slice(0, 8)} user=${
          userId.slice(0, 8)
        } slug=${slug} → ${rows.length} row(s)`,
      );
      const accept = request.headers.get("accept") ?? "";
      const selected = rows.map((r) => ({ slug: r.slug, saved_at: r.saved_at }));
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (selected.length !== 1) {
          call.status = 406;
          return jsonResponse(406, {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
            details: `The result contains ${selected.length} rows`,
            hint: null,
          });
        }
        call.status = 200;
        return jsonResponse(200, selected[0]);
      }
      call.status = 200;
      return jsonResponse(200, selected);
    }
    if (request.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(rawBody);
        body = Array.isArray(parsed) ? parsed[0] ?? {} : parsed;
      } catch {
        // malformed — PostgREST would 400; the route never sends that
      }
      const row = { user_id: String(body.user_id ?? ""), slug: String(body.slug ?? "") };
      const ok = await store.upsertIgnore(principal, row);
      if (!ok) {
        call.status = 403;
        return jsonResponse(403, {
          code: "42501",
          message: 'new row violates row-level security policy for table "user_saved_drills"',
        });
      }
      h.fake.log(
        "rest.upsert.user_saved_drills",
        `user=${row.user_id.slice(0, 8)} slug=${row.slug}`,
      );
      call.status = 201;
      return new Response(null, { status: 201 });
    }
    if (request.method === "DELETE") {
      if (userId === null || slug === null) {
        call.status = 400;
        return jsonResponse(400, { code: "PGRST100", message: "stress shim: unmodelled filter" });
      }
      await store.del(principal, userId, slug);
      h.fake.log("rest.delete.user_saved_drills", `user=${userId.slice(0, 8)} slug=${slug}`);
      call.status = 204;
      return new Response(null, { status: 204 });
    }
    call.status = 405;
    return jsonResponse(405, { message: `stress shim: ${request.method} not modelled` });
  }) as typeof fetch;

  loaded = {
    ...h,
    store,
    dbCalls,
    async begin(seed: number) {
      h.fake.reset(seed, STRESS_LATENCY_MS);
      await store.reset();
      dbCalls.length = 0;
      t0 = performance.now();
    },
  };
  return loaded;
}

// ── Catalog fixtures ─────────────────────────────────────────────────────────

export interface CatalogFixture {
  /** A published slug that has instructional media. */
  withMedia: string;
  /** A published slug with no media. */
  withoutMedia: string;
  /** Every published slug. */
  all: string[];
}

let fixture: CatalogFixture | null = null;

export async function catalogFixture(): Promise<CatalogFixture> {
  if (fixture) return fixture;
  const catalog = await drillCatalog();
  const media = await Promise.all(catalog.map((d) => drillInstructionalMedia(d.slug)));
  const withMedia = catalog.find((_, i) => media[i].length > 0);
  const withoutMedia = catalog.find((_, i) => media[i].length === 0);
  if (!withMedia || !withoutMedia) {
    throw new Error("catalog fixture needs one slug with media and one without");
  }
  fixture = {
    withMedia: withMedia.slug,
    withoutMedia: withoutMedia.slug,
    all: catalog.map((d) => d.slug),
  };
  return fixture;
}

// ── Sessions with a chosen exp (clock-skew lanes) ────────────────────────────

/** A second access token for `session` whose `exp` is `expSeconds`, known to
 * the fake GoTrue (GoTrue validates the signature/exp of a real token; the
 * fake indexes tokens by value, so the edge fn's own `exp` handling is what
 * is under test). */
export function accessTokenWithExp(
  h: StressHarness,
  session: FakeSession,
  expSeconds: number,
  tag: string,
): string {
  const original = jwtPayload(session.accessToken) ?? {};
  const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
    b64url(
      JSON.stringify({ ...original, exp: expSeconds, jti: `${String(original.jti)}-${tag}` }),
    )
  }.sig`;
  h.fake.accessIndex.set(token, session.sessionId);
  return token;
}

export function sessionOf(h: StressHarness, accessToken: string): FakeSession {
  const sid = h.fake.accessIndex.get(accessToken);
  const session = sid ? h.fake.sessions.get(sid) : undefined;
  if (!session) throw new Error("no fake session for bearer");
  return session;
}

// ── Timed requests ───────────────────────────────────────────────────────────

export interface RequestRow {
  lane: number;
  op: string;
  actor: string;
  status: number;
  code: string | null;
  startedAt: number;
  endedAt: number;
  /** Wall clock (Date.now()) — what the handler's own exp checks compare against. */
  wallStart: number;
  wallEnd: number;
  /** `drill.saved` of a 200 detail response. */
  saved?: boolean;
  /** Canonical JSON of the 200 body with `saved` removed — identity check. */
  bodyKey?: string;
  slug?: string;
}

const clock = (): number => Math.round(performance.now() * 100) / 100;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/** Run one request through the real handler, recording its window and the
 * detail-response fields the invariants look at. */
export async function timed(
  rows: RequestRow[],
  lane: number,
  op: string,
  actor: string,
  make: () => Request,
  options: { slug?: string; abandon?: boolean } = {},
): Promise<{ row: RequestRow; body: Record<string, unknown> }> {
  const wallStart = Date.now();
  const startedAt = clock();
  const response = await loaded!.handler(make());
  const endedAt = clock();
  const wallEnd = Date.now();
  const row: RequestRow = {
    lane,
    op,
    actor,
    status: response.status,
    code: null,
    startedAt,
    endedAt,
    wallStart,
    wallEnd,
    slug: options.slug,
  };
  let body: Record<string, unknown> = {};
  if (options.abandon) {
    // The client went away: the body is never read. Nothing else to record.
    await response.body?.cancel().catch(() => undefined);
    rows.push(row);
    return { row, body };
  }
  body = await readJson(response);
  const error = body.error;
  if (
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
  ) {
    row.code = (error as { code: string }).code;
  }
  const drill = body.drill;
  if (response.status === 200 && drill && typeof drill === "object") {
    const { saved, ...rest } = drill as Record<string, unknown>;
    row.saved = Boolean(saved);
    row.bodyKey = canonical({ ...body, drill: rest });
  }
  rows.push(row);
  return { row, body };
}

export function detailRequest(token: string | null, slug: string, ip: string): Request {
  return edgeRequest("GET", `/v1/catalog/drills/${slug}`, { token, ip });
}

/** A per-iteration client IP: the pre-auth IP budget (1 200/min) and the
 * auth-failure budget (30 failed bearers / 5 min) are keyed by IP, so every
 * iteration gets its own address and no scenario's 401s throttle another. */
export function iterationIp(scenarioIndex: number, seed: number, lane = 0): string {
  const a = 10 + (scenarioIndex % 200);
  const b = (seed >>> 8) & 255;
  const c = seed & 255;
  return `${a}.${b}.${c}.${lane % 256}`;
}

export async function newUser(
  h: StressHarness,
  prng: Prng,
  ip: string,
): Promise<{ id: string; accessToken: string; refreshToken: string }> {
  const sub = prng.uuid();
  const boot = await bootstrap(h, sub, ip);
  if (boot.status !== 200) {
    throw new Error(`bootstrap → ${boot.status} ${JSON.stringify(boot.body)}`);
  }
  // The fake GoTrue mints the Supabase user with the provider subject as id.
  await h.store.ensureUser(sub);
  return {
    id: sub,
    accessToken: boot.accessToken,
    refreshToken: boot.refreshToken,
  };
}

// ── Scenario runner ──────────────────────────────────────────────────────────

export interface IterationContext {
  seed: number;
  iter: number;
  prng: Prng;
  rows: RequestRow[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  ip: (lane?: number) => string;
}

export interface IterationRow {
  scenario: string;
  seed: number;
  iter: number;
  outcome: "HELD" | "BROKEN" | "TIMEOUT";
  failed: string[];
  statuses: Record<string, number>;
  requests: number;
  durationMs: number;
  replay: string;
}

export interface ScenarioResult {
  scenario: string;
  label: string;
  iterations: IterationRow[];
  /** Full detail for every iteration that did not HOLD (rows, timeline, db calls). */
  failures: Array<{
    seed: number;
    invariants: Invariant[];
    observations: Record<string, unknown>;
    requests: RequestRow[];
    dbCalls: DbCall[];
    timeline: TimelineEntry[];
    counters: Record<string, number>;
  }>;
  observations: Array<{ seed: number; observations: Record<string, unknown> }>;
  scale: Record<string, number>;
  durationMs: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
}

export function inv(invariants: Invariant[], name: string, holds: boolean, detail: string): void {
  invariants.push({ name, holds, detail });
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-get-v1-catalog-drills-slug-concurrency/latest/",
    import.meta.url,
  ).pathname;
}

export function replayCommand(testFile: string, filter: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${testFile} --filter "${filter}"`;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The scheduler PRNG for (scenario, seed). Mixed with the scenario name so
 * two scenarios sharing a seed never mint the same actor ids — the handler's
 * per-user budgets and auth cache are process-global and would otherwise
 * carry one scenario's spend into the next. */
export function scenarioPrng(scenario: string, seed: number): Prng {
  return new Prng((seed ^ fnv1a(scenario) ^ 0x9e3779b9) >>> 0);
}

const results: ScenarioResult[] = [];

/** Run `fn` STRESS_ITER times from consecutive seeds, each bounded by
 * STRESS_TIMEOUT_MS (a hang is a TIMEOUT outcome, never a stuck suite), and
 * write <outDir>/<scenario>.json. Returns the result; the caller asserts. */
export async function runScenario(
  h: StressHarness,
  testFile: string,
  scenarioIndex: number,
  scenario: string,
  label: string,
  fn: (h: StressHarness, ctx: IterationContext) => Promise<void>,
): Promise<ScenarioResult> {
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  const iterations: IterationRow[] = [];
  const failures: ScenarioResult["failures"] = [];
  const observations: ScenarioResult["observations"] = [];
  for (let iter = 0; iter < STRESS_ITER; iter++) {
    const seed = STRESS_SEED + iter;
    await h.begin(seed);
    const ctx: IterationContext = {
      seed,
      iter,
      prng: scenarioPrng(scenario, seed),
      rows: [],
      invariants: [],
      observations: {},
      ip: (lane = 0) => iterationIp(scenarioIndex, seed, lane),
    };
    const started = performance.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), STRESS_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([fn(h, ctx).then(() => "done" as const), bound]);
      timedOut = outcome === "timeout";
    } catch (error) {
      inv(ctx.invariants, "iteration threw", false, String(error));
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      inv(
        ctx.invariants,
        `bounded wall time (${STRESS_TIMEOUT_MS} ms)`,
        false,
        `iteration still running after ${STRESS_TIMEOUT_MS} ms — ${ctx.rows.length} requests settled`,
      );
    }
    const failed = ctx.invariants.filter((i) => !i.holds).map((i) => `${i.name}: ${i.detail}`);
    const row: IterationRow = {
      scenario,
      seed,
      iter,
      outcome: timedOut ? "TIMEOUT" : failed.length === 0 ? "HELD" : "BROKEN",
      failed,
      statuses: histogram(ctx.rows.map((r) => r.status)),
      requests: ctx.rows.length,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      replay: replayCommand(testFile, label, seed),
    };
    iterations.push(row);
    observations.push({ seed, observations: ctx.observations });
    if (row.outcome !== "HELD") {
      failures.push({
        seed,
        invariants: ctx.invariants,
        observations: ctx.observations,
        requests: ctx.rows,
        dbCalls: [...h.dbCalls],
        timeline: [...h.fake.timeline],
        counters: { ...h.fake.counters },
      });
    }
  }
  const result: ScenarioResult = {
    scenario,
    label,
    iterations,
    failures,
    observations,
    scale: {
      iterations: STRESS_ITER,
      burst: STRESS_BURST,
      latencyMaxMs: STRESS_LATENCY_MS,
      timeoutMs: STRESS_TIMEOUT_MS,
      firstSeed: STRESS_SEED,
    },
    durationMs: Math.round((performance.now() - t0) * 100) / 100,
    heap: { before, after: Deno.memoryUsage() },
  };
  results.push(result);
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}${scenario}.json`, JSON.stringify(result, null, 2));
  return result;
}

/** The seed → outcome table across every scenario run in this process. */
export async function writeSeedTable(name: string): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const rows = results.flatMap((r) => r.iterations);
  const table = {
    generatedAt: new Date().toISOString(),
    scale: results[0]?.scale ?? {},
    scenarios: results.map((r) => ({
      scenario: r.scenario,
      label: r.label,
      iterations: r.iterations.length,
      held: r.iterations.filter((i) => i.outcome === "HELD").length,
      broken: r.iterations.filter((i) => i.outcome === "BROKEN").length,
      timeout: r.iterations.filter((i) => i.outcome === "TIMEOUT").length,
      requests: r.iterations.reduce((n, i) => n + i.requests, 0),
      durationMs: r.durationMs,
    })),
    totals: {
      iterations: rows.length,
      held: rows.filter((i) => i.outcome === "HELD").length,
      broken: rows.filter((i) => i.outcome === "BROKEN").length,
      timeout: rows.filter((i) => i.outcome === "TIMEOUT").length,
      requests: rows.reduce((n, i) => n + i.requests, 0),
    },
    rows,
  };
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(table, null, 2));
  return path;
}

export function scenarioResults(): ScenarioResult[] {
  return results;
}

// ── Shared invariant helpers ─────────────────────────────────────────────────

export const no5xx = (rows: RequestRow[]): RequestRow[] => rows.filter((r) => r.status >= 500);

/** Every 200 detail body for one slug is byte-identical apart from `saved`. */
export function identicalBodies(rows: RequestRow[]): { holds: boolean; detail: string } {
  const bySlug = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.status !== 200 || !r.bodyKey || !r.slug) continue;
    const set = bySlug.get(r.slug) ?? new Set();
    set.add(r.bodyKey);
    bySlug.set(r.slug, set);
  }
  const divergent = [...bySlug.entries()].filter(([, set]) => set.size > 1);
  return {
    holds: divergent.length === 0,
    detail: divergent.length === 0
      ? `${bySlug.size} slug(s), one body each`
      : divergent.map(([slug, set]) => `${slug}: ${set.size} distinct bodies`).join("; "),
  };
}

/** Requests that overlapped at least one other request in the set — proof
 * the burst actually interleaved rather than serialized. */
export function overlapCount(rows: RequestRow[]): number {
  let n = 0;
  for (const a of rows) {
    if (rows.some((b) => b !== a && a.startedAt < b.endedAt && b.startedAt < a.endedAt)) n++;
  }
  return n;
}

/** Wait until the aligned rate-limit minute has at least `needMs` left so a
 * budget burst never straddles a window boundary. */
export async function settleInWindow(needMs: number): Promise<void> {
  const windowMs = GENERAL_USER_LIMIT.windowSeconds * 1_000;
  const left = windowMs - (Date.now() % windowMs);
  if (left < needMs) await sleep(left + 5);
}
