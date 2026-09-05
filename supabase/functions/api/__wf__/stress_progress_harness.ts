// Stress harness for GET /v1/progress (concurrency lens).
//
// Boots the REAL edge handler in-process (Deno.serve captured, no port) on top
// of the seeded FakeSupabase from xc_concurrency_harness.ts, and adds what
// that fake does not model:
//
//   - the `progress_daily` and `practice_days` views the route reads (derived
//     from the fake's committed `shots` rows + a sidecar of the shot details
//     the client sent, and a static per-user practice-day list — in
//     production nothing client-side writes public.captures, so practice
//     days only change out of band);
//   - PostgREST paging (`offset`/`limit` from `.range()`), so readAllRows sees
//     real pages;
//   - seeded read latency, hold gates and fault injection on the view reads;
//   - an optional fake Upstash REST endpoint (redis: true) with seeded latency
//     and fault injection, so the L2 / fenced-write / DEL paths of cache.ts run.
//
// Everything is deterministic from a seed: the fake's scheduler PRNG, the view
// latency PRNG and the campaign's own PRNG are all reseeded per iteration.
//
// Rate-limit note: the edge fn's in-memory rate-limit windows and its L1 cache
// outlive any reset (module state), so every iteration uses a fresh user and
// a fresh client IP derived from its seed.

import {
  edgeRequest,
  fakeGoogleIdToken,
  FakeSupabase,
  type Invariant,
  isRecord,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  syncShotPayload,
  VERSION_VECTOR,
  WEBHOOK_SECRET,
} from "./xc_concurrency_harness.ts";

export { edgeRequest, isRecord, Prng, readJson, sleep, syncShotPayload };
export type { Invariant };

// These must equal the (unexported) constants FakeSupabase.principal() compares
// bearers against, or every PostgREST call would be classified `anon`.
const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";
export const STRESS_REDIS_URL = "http://upstash.stress.test";

// ── Shot details sidecar (what the view would compute from shot columns) ─────

export interface ShotDetail {
  id: string;
  userId: string;
  shotType: string;
  /** ISO instant */
  capturedAt: string;
  overallScore: number | null;
  scoringModelVersion: string;
  resultKind: "scored" | "low_confidence";
}

export type ViewTable = "progress_daily" | "practice_days";

export interface ViewFaults {
  /** Answer this read with a PostgREST 500 (→ route 503). */
  fail?: (table: ViewTable, userId: string | null, offset: number) => boolean;
  /** Park this read until the returned promise resolves. */
  hold?: (
    table: ViewTable,
    userId: string | null,
    offset: number,
  ) => Promise<void> | null;
}

export interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

export type RedisFault = "http500" | "throw" | null;

export interface UpstreamCall {
  t: number;
  method: string;
  url: string;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  redisEnabled: boolean;
  /** Seeded scheduler for view-read latency (reseeded per iteration). */
  viewPrng: Prng;
  viewLatencyMaxMs: number;
  details: Map<string, ShotDetail>;
  practiceDays: Map<string, string[]>;
  faults: ViewFaults;
  /** First-page reads per view = builds started. */
  reads: Record<ViewTable, number>;
  readsByUser: Map<string, Record<ViewTable, number>>;
  /** Every page request per view (offset > 0 included). */
  pageReads: Record<ViewTable, number>;
  /** Every view page served: `issued` = request arrived at the fake
   * PostgREST, `t` = rows returned, `rows` = page size (a short page ends the
   * readAllRows loop, so a build's last short page marks its DB read done). */
  viewReadLog: Array<{
    issued: number;
    t: number;
    table: ViewTable;
    userId: string | null;
    offset: number;
    rows: number;
  }>;
  /** Fake Upstash store + command log (redis: true only). */
  redis: Map<string, RedisEntry>;
  redisCommands: Array<Array<string>>;
  redisPipelines: number;
  redisFaults: number;
  /** Every pipeline that was failed, as `CMD key…` per command.
   * `issued` = when the isolate sent the pipeline (after any L1 mutation it
   * did first), `t` = when the fake Upstash applied it atomically. */
  redisFaultLog: Array<{ t: number; issued: number; commands: string[] }>;
  /** Every pipeline that was applied (same shape). */
  redisPipelineLog: Array<{ t: number; issued: number; commands: string[] }>;
  redisLatencyMaxMs: number;
  redisFault: (commands: Array<Array<string>>) => RedisFault;
  /** Park a pipeline (after its latency) until the returned promise resolves. */
  redisHold: (commands: Array<Array<string>>) => Promise<void> | null;
  upstreamCalls: UpstreamCall[];
  /** Reseed every PRNG and clear all per-iteration state. */
  resetIteration(seed: number, latencyMaxMs: number): void;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const utcDay = (iso: string): string =>
  new Date(iso).toISOString().slice(0, 10);

export interface ProgressSeriesRow {
  day: string;
  shot_type: string;
  scoring_model_version: string;
  shot_count: number;
  avg_score: number;
  best_score: number;
}

/** progress_daily rows (view shape, 0-10 scores) for a set of shot details. */
export function progressDailyRows(
  details: Iterable<ShotDetail>,
): ProgressSeriesRow[] {
  const groups = new Map<
    string,
    { scores: number[]; row: ProgressSeriesRow }
  >();
  for (const d of details) {
    if (d.resultKind !== "scored" || d.overallScore === null) continue;
    const day = utcDay(d.capturedAt);
    const key = `${day}|${d.shotType}|${d.scoringModelVersion}`;
    const g = groups.get(key) ?? {
      scores: [],
      row: {
        day,
        shot_type: d.shotType,
        scoring_model_version: d.scoringModelVersion,
        shot_count: 0,
        avg_score: 0,
        best_score: 0,
      },
    };
    g.scores.push(d.overallScore);
    groups.set(key, g);
  }
  const rows: ProgressSeriesRow[] = [];
  for (const g of groups.values()) {
    const sum = g.scores.reduce((a, b) => a + b, 0);
    rows.push({
      ...g.row,
      shot_count: g.scores.length,
      avg_score: round2(sum / g.scores.length),
      best_score: Math.max(...g.scores),
    });
  }
  return rows;
}

// ── Oracle: the contract GET /v1/progress must return ────────────────────────

const DAY_MS = 86_400_000;

/** Test-side port of index.ts computePracticeStreak (UTC days). */
export function oracleStreak(days: string[], today: string) {
  const toDay = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed) ? Math.floor(parsed / DAY_MS) : null;
  };
  const todayDay = toDay(today)!;
  const uniqueDays = [
    ...new Set(days.map(toDay).filter((d): d is number => d !== null)),
  ]
    .filter((d) => d <= todayDay)
    .sort((a, b) => a - b);
  if (uniqueDays.length === 0) {
    return {
      currentDays: 0,
      longestDays: 0,
      practicedToday: false,
      lastPracticeDate: null,
    };
  }
  let longestDays = 1;
  let run = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    if (uniqueDays[i] === uniqueDays[i - 1] + 1) {
      run += 1;
      longestDays = Math.max(longestDays, run);
    } else {
      run = 1;
    }
  }
  const latestDay = uniqueDays[uniqueDays.length - 1];
  let currentDays = 0;
  if (latestDay === todayDay || latestDay === todayDay - 1) {
    currentDays = 1;
    for (let i = uniqueDays.length - 2; i >= 0; i -= 1) {
      if (uniqueDays[i] !== uniqueDays[i + 1] - 1) break;
      currentDays += 1;
    }
  }
  return {
    currentDays,
    longestDays,
    practicedToday: latestDay === todayDay,
    lastPracticeDate: new Date(latestDay * DAY_MS).toISOString().slice(0, 10),
  };
}

export interface ProgressPayload {
  series: ProgressSeriesRow[];
  improving: unknown[];
  needsAttention: unknown[];
  streak: ReturnType<typeof oracleStreak>;
}

/** The exact body GET /v1/progress must produce for `shotIds` committed and
 * `today` as the server's UTC date. */
export function expectedProgress(
  h: StressHarness,
  userId: string,
  shotIds: Iterable<string>,
  today: string,
): ProgressPayload {
  const details: ShotDetail[] = [];
  for (const id of shotIds) {
    const d = h.details.get(id);
    if (d && d.userId === userId) details.push(d);
  }
  const series = progressDailyRows(details)
    .map((row) => ({
      ...row,
      avg_score: Math.round(Number(row.avg_score) * 100) / 10,
      best_score: Math.round(Number(row.best_score) * 100) / 10,
    }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.shot_type.localeCompare(b.shot_type) ||
        a.scoring_model_version.localeCompare(b.scoring_model_version),
    );
  return {
    series,
    improving: [],
    needsAttention: [],
    streak: oracleStreak(h.practiceDays.get(userId) ?? [], today),
  };
}

/** Canonical string of a progress body (order-insensitive keys). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${
      Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

// ── Fake Upstash ─────────────────────────────────────────────────────────────

/** Upstash keeps its own clock: a skewed isolate clock (setClockOffset) must
 * not move L2 expiry, exactly as in production. */
const redisNow = (): number => RealDate.now();

function redisLive(h: StressHarness, key: string): RedisEntry | null {
  const entry = h.redis.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= redisNow()) {
    h.redis.delete(key);
    return null;
  }
  return entry;
}

function runRedisCommand(
  h: StressHarness,
  command: string[],
): { result?: unknown; error?: string } {
  h.redisCommands.push(command);
  const [op, ...args] = command;
  switch (op) {
    case "GET":
      return { result: redisLive(h, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(h, args[0]);
      if (!entry) return { result: -2 };
      if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
      return {
        result: Math.max(1, Math.ceil((entry.expiresAtMs - redisNow()) / 1000)),
      };
    }
    case "SET": {
      const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
      h.redis.set(args[0], {
        value: args[1],
        expiresAtMs: Number.isFinite(ttl) ? redisNow() + ttl * 1000 : Infinity,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let removed = 0;
      for (const key of args) if (h.redis.delete(key)) removed += 1;
      return { result: removed };
    }
    case "INCR": {
      const entry = redisLive(h, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      h.redis.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? Infinity,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = redisLive(h, args[0]);
      if (!entry) return { result: 0 };
      if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) {
        return { result: 0 };
      }
      entry.expiresAtMs = redisNow() + Number(args[1]) * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${op}'` };
  }
}

// ── PostgREST view emulation ─────────────────────────────────────────────────

function parseOrder(
  params: URLSearchParams,
): Array<{ col: string; desc: boolean }> {
  const out: Array<{ col: string; desc: boolean }> = [];
  for (const raw of params.getAll("order")) {
    for (const part of raw.split(",")) {
      const [col, dir] = part.split(".");
      if (col) out.push({ col, desc: dir === "desc" });
    }
  }
  return out;
}

function pageOf(
  rows: Array<Record<string, unknown>>,
  params: URLSearchParams,
  headers: Headers,
): Array<Record<string, unknown>> {
  const order = parseOrder(params);
  const sorted = [...rows].sort((a, b) => {
    for (const { col, desc } of order) {
      const av = String(a[col]);
      const bv = String(b[col]);
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
  let offset = Number(params.get("offset") ?? NaN);
  let limit = Number(params.get("limit") ?? NaN);
  const range = headers.get("range");
  if ((!Number.isFinite(offset) || !Number.isFinite(limit)) && range) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (m) {
      offset = Number(m[1]);
      limit = Number(m[2]) - Number(m[1]) + 1;
    }
  }
  if (!Number.isFinite(offset)) offset = 0;
  if (!Number.isFinite(limit)) limit = sorted.length;
  return sorted.slice(offset, offset + limit);
}

// ── Loading the real handler ─────────────────────────────────────────────────

let loaded: StressHarness | null = null;

export async function loadStressHarness(
  options: { redis?: boolean } = {},
): Promise<StressHarness> {
  if (loaded) {
    if (Boolean(options.redis) !== loaded.redisEnabled) {
      throw new Error(
        "stress harness: redis mode is fixed at first load (cache.ts reads UPSTASH_* at import)",
      );
    }
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", STRESS_REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "upstash-stress-token");
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const fake = new FakeSupabase(1, 0);
  const t0 = performance.now();
  const h: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    fake,
    redisEnabled: Boolean(options.redis),
    viewPrng: new Prng(1),
    viewLatencyMaxMs: 0,
    details: new Map(),
    practiceDays: new Map(),
    faults: {},
    reads: { progress_daily: 0, practice_days: 0 },
    readsByUser: new Map(),
    pageReads: { progress_daily: 0, practice_days: 0 },
    viewReadLog: [],
    redis: new Map(),
    redisCommands: [],
    redisPipelines: 0,
    redisFaults: 0,
    redisFaultLog: [],
    redisPipelineLog: [],
    redisLatencyMaxMs: 0,
    redisFault: () => null,
    redisHold: () => null,
    upstreamCalls: [],
    resetIteration(seed: number, latencyMaxMs: number) {
      fake.reset(seed, latencyMaxMs);
      h.viewPrng = new Prng((seed ^ 0x9e3779b9) >>> 0);
      h.viewLatencyMaxMs = latencyMaxMs * 3;
      h.details.clear();
      h.practiceDays.clear();
      h.faults = {};
      h.reads = { progress_daily: 0, practice_days: 0 };
      h.readsByUser.clear();
      h.pageReads = { progress_daily: 0, practice_days: 0 };
      h.viewReadLog = [];
      h.redis.clear();
      h.redisCommands = [];
      h.redisPipelines = 0;
      h.redisFaults = 0;
      h.redisFaultLog = [];
      h.redisPipelineLog = [];
      h.redisLatencyMaxMs = latencyMaxMs;
      h.redisFault = () => null;
      h.redisHold = () => null;
      h.upstreamCalls = [];
    },
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const viewRows = (
    table: ViewTable,
    userId: string | null,
  ): Array<Record<string, unknown>> => {
    if (!userId) return [];
    if (table === "practice_days") {
      return [...new Set(h.practiceDays.get(userId) ?? [])].map((day) => ({
        user_id: userId,
        day,
      }));
    }
    const committed: ShotDetail[] = [];
    for (const row of fake.tables.shots) {
      if (row.user_id !== userId || row.result_kind !== "scored") continue;
      const detail = h.details.get(String(row.id));
      if (detail) committed.push(detail);
    }
    return progressDailyRows(committed).map((row) => ({
      user_id: userId,
      ...row,
    }));
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    const url = new URL(request.url);
    h.upstreamCalls.push({
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      url: request.url,
    });

    if (request.url.startsWith(STRESS_REDIS_URL)) {
      h.redisPipelines += 1;
      const issued = performance.now();
      let commands: Array<Array<string>> = [];
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        commands = Array.isArray(parsed)
          ? parsed.map((
            c,
          ) => (Array.isArray(c) ? c.map((p) => String(p)) : []))
          : [];
      } catch {
        commands = [];
      }
      if (h.redisLatencyMaxMs > 0) {
        await sleep(h.viewPrng.int(0, h.redisLatencyMaxMs));
      }
      const hold = h.redisHold(commands);
      if (hold) await hold;
      const fault = h.redisFault(commands);
      const logged = {
        t: performance.now(),
        issued,
        commands: commands.map((c) =>
          `${String(c[0]).toUpperCase()} ${c.slice(1).join(" ")}`
        ),
      };
      if (fault !== null) {
        h.redisFaults += 1;
        h.redisFaultLog.push(logged);
      } else {
        h.redisPipelineLog.push(logged);
      }
      if (fault === "throw") {
        throw new TypeError("stress: simulated Upstash network failure");
      }
      if (fault === "http500") {
        return new Response("upstash unavailable", { status: 500 });
      }
      // Whole pipeline is atomic w.r.t. other pipelines (single JS turn).
      return jsonResponse(200, commands.map((c) => runRedisCommand(h, c)));
    }

    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length);
      if (
        (table === "progress_daily" || table === "practice_days") &&
        request.method === "GET"
      ) {
        const who = fake.principal(request.headers);
        const userId = who.role === "user" ? who.userId : null;
        const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
        const issued = performance.now();
        h.pageReads[table] += 1;
        if (offset === 0) {
          h.reads[table] += 1;
          if (userId) {
            const per = h.readsByUser.get(userId) ??
              { progress_daily: 0, practice_days: 0 };
            per[table] += 1;
            h.readsByUser.set(userId, per);
          }
        }
        if (h.viewLatencyMaxMs > 0) {
          await sleep(h.viewPrng.int(0, h.viewLatencyMaxMs));
        }
        const hold = h.faults.hold?.(table, userId, offset);
        if (hold) await hold;
        if (h.faults.fail?.(table, userId, offset)) {
          return jsonResponse(500, {
            code: "XX000",
            message: "stress: simulated database failure",
            details: null,
            hint: null,
          });
        }
        // Views are security_invoker: RLS scopes rows to the caller.
        const rows = pageOf(
          viewRows(table, userId),
          url.searchParams,
          request.headers,
        );
        h.viewReadLog.push({
          issued,
          t: performance.now(),
          table,
          userId,
          offset,
          rows: rows.length,
        });
        const select = url.searchParams.get("select");
        if (select && select !== "*") {
          const cols = select.split(",").map((c) => c.trim());
          return jsonResponse(
            200,
            rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c]]))),
          );
        }
        return jsonResponse(200, rows);
      }
    }
    return fake.handleFetch(request, rawBody);
  }) as typeof fetch;

  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | StressHarness["handler"]
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    h.handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  loaded = h;
  return h;
}

// ── Actors ───────────────────────────────────────────────────────────────────

export interface Actor {
  userId: string;
  ip: string;
  accessToken: string;
  refreshToken: string;
}

/** A client IP unique to this seed (per-IP budgets never bleed across iterations). */
export function ipFor(seed: number, lane = 0): string {
  const n = (seed * 7 + lane) >>> 0;
  return `10.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/** Bootstrap a fresh user through the real route; optionally premium. */
export async function bootstrapActor(
  h: StressHarness,
  prng: Prng,
  ip: string,
  options: { premium?: boolean } = {},
): Promise<Actor> {
  const sub = prng.uuid();
  const response = await h.handler(
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(sub),
      ip,
      body: {},
    }),
  );
  const body = await readJson(response);
  if (response.status !== 200) {
    throw new Error(
      `bootstrap failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  const session = isRecord(body.session) ? body.session : {};
  const account = isRecord(body.account) ? body.account : {};
  const userId = String(account.id ?? sub);
  if (options.premium) {
    // Server-owned row (billing sync writes it with the service role).
    h.fake.tables.billing_entitlements.push({
      user_id: userId,
      premium: true,
      product_key: "pickle_sensei_pro_lifetime",
      expires_at: null,
      verified_at: new Date().toISOString(),
    });
  }
  return {
    userId,
    ip,
    accessToken: String(session.accessToken ?? ""),
    refreshToken: String(session.refreshToken ?? ""),
  };
}

/** A reserved permit row (what POST /v1/analysis-permits leaves behind). */
export function reservePermit(
  h: StressHarness,
  prng: Prng,
  userId: string,
): string {
  const id = prng.uuid();
  h.fake.tables.analysis_permits.push({
    id,
    user_id: userId,
    idempotency_key: `key-${prng.uuid()}`,
    status: "reserved",
    outcome: null,
    created_at: new Date().toISOString(),
  });
  return id;
}

export const SHOT_TYPES = [
  "dink",
  "drive",
  "third_shot_drop",
  "serve",
  "volley",
];
export const SCORING_VERSIONS = ["scoring-1", "scoring-2"];

/** Seeded shot detail on a day within the last `daySpan` days. */
export function randomShotDetail(
  prng: Prng,
  userId: string,
  options: { lowConfidence?: boolean; daySpan?: number } = {},
): ShotDetail {
  const id = prng.uuid();
  const daysAgo = prng.int(0, options.daySpan ?? 6);
  const capturedAt = new Date(
    Date.now() - daysAgo * DAY_MS - prng.int(0, 23) * 3_600_000 -
      prng.int(0, 59) * 60_000,
  ).toISOString();
  const low = options.lowConfidence ?? false;
  return {
    id,
    userId,
    shotType: SHOT_TYPES[prng.int(0, SHOT_TYPES.length - 1)],
    capturedAt,
    overallScore: low ? null : prng.int(0, 100) / 10,
    scoringModelVersion:
      SCORING_VERSIONS[prng.int(0, SCORING_VERSIONS.length - 1)],
    resultKind: low ? "low_confidence" : "scored",
  };
}

/** Wire payload for POST /v1/shots:sync from a detail + permit. */
export function wireShot(
  detail: ShotDetail,
  permitId: string,
): Record<string, unknown> {
  return syncShotPayload(detail.id, permitId, {
    shotType: detail.shotType,
    capturedAt: detail.capturedAt,
    overallScore: detail.overallScore,
    resultKind: detail.resultKind,
    confidence: detail.resultKind === "scored" ? 0.9 : 0.3,
    versionVector: {
      ...VERSION_VECTOR,
      scoringModelVersion: detail.scoringModelVersion,
    },
  });
}

/** Commit a shot straight into the fake (a sync that landed before the
 * iteration started); registers its detail so the view sees it. */
export function precommitShot(
  h: StressHarness,
  prng: Prng,
  detail: ShotDetail,
): void {
  const permitId = reservePermit(h, prng, detail.userId);
  h.details.set(detail.id, detail);
  const permit = h.fake.tables.analysis_permits.find((p) => p.id === permitId)!;
  permit.status = detail.resultKind === "scored" ? "finalized" : "released";
  permit.outcome = detail.resultKind;
  h.fake.tables.shots.push({
    id: detail.id,
    user_id: detail.userId,
    session_id: null,
    result_kind: detail.resultKind,
    analysis_permit_id: permitId,
    created_at: new Date().toISOString(),
  });
}

/** Seeded practice days: mostly real recent days, plus the edge cases the
 * streak code must tolerate (duplicates, a future day, malformed strings). */
export function seedPracticeDays(
  h: StressHarness,
  prng: Prng,
  userId: string,
): string[] {
  const days: string[] = [];
  const n = prng.int(0, 9);
  const today = Math.floor(Date.now() / DAY_MS);
  for (let i = 0; i < n; i += 1) {
    const d = today - prng.int(0, 10);
    days.push(new Date(d * DAY_MS).toISOString().slice(0, 10));
  }
  if (prng.next() < 0.3 && days.length) days.push(days[0]);
  if (prng.next() < 0.2) {
    days.push(new Date((today + 2) * DAY_MS).toISOString().slice(0, 10));
  }
  h.practiceDays.set(userId, days);
  return days;
}

// ── Timed requests ───────────────────────────────────────────────────────────

export interface TimedResult {
  kind: string;
  label: string;
  tStart: number;
  tEnd: number;
  status: number;
  body: Record<string, unknown> | null;
  /** True when the client dropped the body without reading it. */
  cancelled: boolean;
  timedOut: boolean;
}

export const REQUEST_TIMEOUT_MS = 8_000;

/** Run one request through the real handler, bounded in wall time (a hang is
 * reported as a timed-out row instead of stalling the campaign). */
export async function timed(
  h: StressHarness,
  kind: string,
  label: string,
  request: Request,
  options: { cancelBody?: boolean; abortAfterMs?: number } = {},
): Promise<TimedResult> {
  const tStart = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([h.handler(request), timeout]);
    if (outcome === "timeout") {
      return {
        kind,
        label,
        tStart,
        tEnd: performance.now(),
        status: 0,
        body: null,
        cancelled: false,
        timedOut: true,
      };
    }
    const response = outcome;
    if (options.cancelBody) {
      await response.body?.cancel();
      return {
        kind,
        label,
        tStart,
        tEnd: performance.now(),
        status: response.status,
        body: null,
        cancelled: true,
        timedOut: false,
      };
    }
    const body = await readJson(response);
    return {
      kind,
      label,
      tStart,
      tEnd: performance.now(),
      status: response.status,
      body,
      cancelled: false,
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function progressRequest(
  actor: Actor,
  token = actor.accessToken,
  abort?: AbortSignal,
): Request {
  const request = edgeRequest("GET", "/v1/progress", { token, ip: actor.ip });
  if (!abort) return request;
  return new Request(request, { signal: abort });
}

export function syncRequest(
  actor: Actor,
  shots: Array<Record<string, unknown>>,
): Request {
  return edgeRequest("POST", "/v1/shots:sync", {
    token: actor.accessToken,
    ip: actor.ip,
    body: { shots },
  });
}

// ── Clock control ────────────────────────────────────────────────────────────

const RealDate = Date;
let clockOffsetMs = 0;

/** Shift the handler's clock (Date.now AND `new Date()`) by `offsetMs`.
 * Rate-limit windows, cache TTLs, bearer expiry and the streak's "today" all
 * read the shifted clock. Call with 0 to restore. */
export function setClockOffset(offsetMs: number): void {
  clockOffsetMs = offsetMs;
  if (offsetMs === 0) {
    globalThis.Date = RealDate;
    return;
  }
  const Shifted = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return RealDate();
    if (args.length === 0) return new RealDate(RealDate.now() + clockOffsetMs);
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor & { prototype: Date };
  Object.setPrototypeOf(Shifted, RealDate);
  Object.defineProperty(Shifted, "prototype", {
    value: RealDate.prototype,
    writable: false,
  });
  Shifted.now = () => RealDate.now() + clockOffsetMs;
  Shifted.parse = RealDate.parse;
  Shifted.UTC = RealDate.UTC;
  globalThis.Date = Shifted;
}

export const clockOffset = (): number => clockOffsetMs;

// ── Reporting ────────────────────────────────────────────────────────────────

export interface IterationRow {
  seed: number;
  family: string;
  outcome: "HELD" | "BROKEN";
  /** Set when every failed invariant is attributable to a reproduced,
   * documented defect (see KNOWN_DEFECTS in the campaign). BROKEN stays
   * BROKEN; this only says which defect. */
  knownDefect?: string;
  scale: Record<string, number>;
  statusHistogram: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
}

export interface CampaignReport {
  suite: string;
  redis: boolean;
  redisFaultRate: number;
  seedBase: number;
  iterations: number;
  latencyMs: number;
  startedAt: string;
  durationMs: number;
  scenariosExecuted: number;
  requestsExecuted: number;
  held: number;
  broken: number;
  /** BROKEN rows fully attributed to a known defect id / not attributed. */
  brokenKnown: number;
  brokenUnknown: number;
  knownDefectSeeds: Record<string, number[]>;
  failingSeeds: Array<
    { seed: number; family: string; invariants: string[]; knownDefect?: string }
  >;
  familyCounts: Record<string, number>;
  rows: IterationRow[];
}

export function stressOutDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-progress/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeCampaign(
  name: string,
  report: CampaignReport,
): Promise<string> {
  const dir = stressOutDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function invariant(
  name: string,
  holds: boolean,
  detail = "",
): Invariant {
  return { name, holds, detail };
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function envFloat(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
