import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import pg from "pg";
import { loadMigrations, runMigrations } from "../../src/migrate.js";
import { seed } from "../../src/seed.js";

/**
 * Long-run leak harness for @pickle/database (lens: long-run-leak).
 *
 * Invokes the package's public surface — `runMigrations` + `seed` through a
 * `pg.Pool`, exactly the way `src/cli.ts` does — hundreds of times in ONE
 * process, samples the V8 heap and libuv handle table every `sampleEvery`
 * iterations, and checks that timers/sockets/advisory locks/server
 * connections return to their pre-campaign baseline.
 *
 * Every iteration derives its operation mix from a seeded PRNG (mulberry32 of
 * `masterSeed` + index), so any single iteration can be replayed on its own
 * with `replayIteration(...)`. Nothing here fabricates data: the only rows
 * written are the committed migrations and the deterministic catalog seed.
 */

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

export const ITERATION_MODES = [
  "seed_idempotent",
  "migrate_noop_then_seed",
  "pool_cycle",
  "fresh_schema_migrate",
  "tampered_dir_rejects",
  "cancel_mid_seed",
  "concurrent_noop_pair",
] as const;
export type IterationMode = (typeof ITERATION_MODES)[number];

/** Relative weights used when picking a mode from the per-iteration PRNG. */
const MIXED_WEIGHTS: Record<IterationMode, number> = {
  seed_idempotent: 30,
  migrate_noop_then_seed: 20,
  pool_cycle: 20,
  fresh_schema_migrate: 6,
  tampered_dir_rejects: 8,
  cancel_mid_seed: 8,
  concurrent_noop_pair: 8,
};

export type Profile = "mixed" | IterationMode;

export interface CampaignOptions {
  databaseUrl: string;
  iterations: number;
  masterSeed: number;
  profile: Profile;
  sampleEvery: number;
  /** Heap growth per 100 iterations (fraction of first post-warmup sample) treated as a leak. */
  heapSlopeLimitPer100: number;
  log?: (line: string) => void;
}

export interface IterationRow {
  i: number;
  seed: number;
  mode: IterationMode;
  outcome: "ok" | "fail";
  ms: number;
  /** Deterministic fingerprint of what the iteration observed (for same-seed replay checks). */
  fingerprint: string;
  detail: string;
}

export interface Sample {
  i: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  resources: Record<string, number>;
  processListeners: number;
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
  serverConnections: number;
  advisoryLocks: number;
  meanMsSinceLastSample: number;
}

export interface CampaignResult {
  config: Omit<CampaignOptions, "log" | "databaseUrl">;
  node: string;
  gcExposed: boolean;
  schema: string;
  startedAt: string;
  finishedAt: string;
  iterationsExecuted: number;
  rows: IterationRow[];
  samples: Sample[];
  baseline: Sample;
  final: Sample;
  analysis: {
    heapSlopePer100Fraction: number | null;
    heapSlopePer100Bytes: number | null;
    heapFirstPostWarmup: number | null;
    heapLast: number | null;
    resourceDelta: Record<string, number>;
    processListenerDelta: number;
    serverConnectionDelta: number;
    advisoryLocksAtEnd: number;
    meanMsFirstWindow: number | null;
    meanMsLastWindow: number | null;
    timeDriftRatio: number | null;
    failures: number;
  };
  verdicts: {
    allIterationsOk: boolean;
    heapSlopeWithinLimit: boolean;
    handlesReturnedToBaseline: boolean;
    noAdvisoryLockLeak: boolean;
    serverConnectionsReturned: boolean;
    fingerprintsFinite: boolean;
  };
}

// ─── Deterministic PRNG (mulberry32) — same construction as swing-lab ────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function iterationSeed(masterSeed: number, i: number): number {
  // splitmix-style hash so consecutive iterations get uncorrelated seeds.
  let x = (masterSeed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export function pickMode(rng: () => number, profile: Profile): IterationMode {
  if (profile !== "mixed") return profile;
  const total = Object.values(MIXED_WEIGHTS).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const mode of ITERATION_MODES) {
    r -= MIXED_WEIGHTS[mode];
    if (r < 0) return mode;
  }
  return ITERATION_MODES[0];
}

// ─── GC access without requiring the process to be started with --expose-gc ──
type GcFn = () => void;
export function obtainGc(): { gc: GcFn; exposed: boolean } {
  const existing = (globalThis as { gc?: GcFn }).gc;
  if (typeof existing === "function") return { gc: existing, exposed: true };
  setFlagsFromString("--expose_gc");
  const fromVm = runInNewContext("gc") as GcFn | undefined;
  if (typeof fromVm === "function") return { gc: fromVm, exposed: true };
  return { gc: () => {}, exposed: false };
}

const WATCHED_PROCESS_EVENTS = [
  "exit",
  "beforeExit",
  "uncaughtException",
  "unhandledRejection",
  "warning",
  "SIGINT",
  "SIGTERM",
] as const;

function countProcessListeners(): number {
  return WATCHED_PROCESS_EVENTS.reduce((n, ev) => n + process.listenerCount(ev), 0);
}

function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * Every backend a campaign opens carries the campaign schema as its
 * `application_name`, so the server-side lock/connection probes see only this
 * campaign even when other suites share the database.
 */
function controlUrl(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", schema);
  return url.toString();
}

function schemaUrl(databaseUrl: string, schema: string): string {
  const url = new URL(controlUrl(databaseUrl, schema));
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Catalog fingerprint: seed output must be identical on every iteration ───
const FINITE_CHECK_SQL = `
  SELECT count(*)::int AS n FROM scoring_target
  WHERE lower_bound::text IN ('NaN','Infinity','-Infinity')
     OR upper_bound::text IN ('NaN','Infinity','-Infinity')
     OR sigma::text IN ('NaN','Infinity','-Infinity')
     OR metric_weight::text = 'NaN'`;

const FINGERPRINT_SQL = `
  SELECT md5(string_agg(line, E'\\n' ORDER BY line)) AS fp, count(*)::int AS n FROM (
    SELECT 'shot_type:' || slug || ':' || name || ':' || display_order || ':' || enabled AS line FROM shot_type
    UNION ALL
    SELECT 'checkpoint:' || slug || ':' || name || ':' || display_order FROM checkpoint_definition
    UNION ALL
    SELECT 'model:' || st.slug || ':' || sm.version || ':' || sm.status || ':' || sm.min_analysis_confidence
      || ':' || sm.lower_confidence_threshold || ':' || md5(sm.config::text)
      FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id
    UNION ALL
    SELECT 'target:' || st.slug || ':' || sm.version || ':' || cd.slug || ':' || t.metric_key || ':'
      || coalesce(t.lower_bound::text,'null') || ':' || coalesce(t.upper_bound::text,'null') || ':'
      || coalesce(t.sigma::text,'null') || ':' || t.metric_weight || ':' || t.direction_below || ':' || t.direction_above
      FROM scoring_target t
      JOIN scoring_model sm ON sm.id = t.scoring_model_id
      JOIN shot_type st ON st.id = sm.shot_type_id
      JOIN checkpoint_definition cd ON cd.id = t.checkpoint_definition_id
    UNION ALL
    SELECT 'offering:' || product_key || ':' || price_usd_cents || ':' || period || ':' || active || ':' || display_order
      FROM billing_offering
    UNION ALL
    SELECT 'flag:' || key || ':' || enabled || ':' || rollout_percent FROM feature_flag
    UNION ALL
    SELECT 'achievement:' || slug || ':' || points FROM achievement
  ) lines`;

async function catalogFingerprint(pool: pg.Pool): Promise<{ fp: string; n: number }> {
  const { rows } = await pool.query<{ fp: string | null; n: number }>(FINGERPRINT_SQL);
  const row = rows[0];
  if (!row || row.fp === null) throw new Error("catalog fingerprint query returned no rows");
  const finite = await pool.query<{ n: number }>(FINITE_CHECK_SQL);
  if ((finite.rows[0]?.n ?? 1) !== 0) {
    throw new Error(`non-finite numeric values in scoring_target: ${finite.rows[0]?.n}`);
  }
  return { fp: row.fp, n: row.n };
}

// ─── Per-iteration operations ────────────────────────────────────────────────
interface IterationContext {
  databaseUrl: string;
  schema: string;
  sharedPool: pg.Pool;
  control: pg.Pool;
  migrationCount: number;
}

interface OpResult {
  fingerprint: string;
  detail: string;
}

async function opSeedIdempotent(ctx: IterationContext, rng: () => number): Promise<OpResult> {
  const passes = 1 + Math.floor(rng() * 2);
  for (let p = 0; p < passes; p++) await seed(ctx.sharedPool);
  const { fp, n } = await catalogFingerprint(ctx.sharedPool);
  return { fingerprint: fp, detail: `passes=${passes} rows=${n}` };
}

async function opMigrateNoopThenSeed(ctx: IterationContext): Promise<OpResult> {
  const result = await runMigrations(ctx.sharedPool, MIGRATIONS_DIR);
  if (result.applied.length !== 0 || result.skipped.length !== ctx.migrationCount) {
    throw new Error(
      `expected 0 applied / ${ctx.migrationCount} skipped, got ${result.applied.length}/${result.skipped.length}`,
    );
  }
  await seed(ctx.sharedPool);
  const { fp } = await catalogFingerprint(ctx.sharedPool);
  return { fingerprint: fp, detail: `skipped=${result.skipped.length}` };
}

/** Upper bound for one migrate+seed pass on a warm schema; a no-op migrate takes ~50ms. */
export const POOL_CYCLE_WATCHDOG_MS = 10_000;

class WatchdogTimeout extends Error {}

async function withWatchdog<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WatchdogTimeout(`${label} did not settle within ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Breaks a wedged migration from the server side: terminates this campaign's
 * backends that hold an advisory lock (the wedged pool's single client), then
 * waits briefly so the socket close is visible to the handle accounting. The
 * pool object itself is abandoned (its checked-out client can never be returned).
 */
async function terminateAdvisoryLockHolders(ctx: IterationContext): Promise<number> {
  const { rows } = await ctx.control.query<{ n: number }>(
    `SELECT count(pg_terminate_backend(a.pid))::int AS n
     FROM pg_stat_activity a
     WHERE a.datname = current_database() AND a.backend_type = 'client backend'
       AND a.application_name = current_setting('application_name')
       AND a.pid <> pg_backend_pid()
       AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'advisory')`,
  );
  await sleep(50);
  return rows[0]?.n ?? 0;
}

async function opPoolCycle(ctx: IterationContext, rng: () => number): Promise<OpResult> {
  const max = 1 + Math.floor(rng() * 4);
  const pool = new pg.Pool({ connectionString: schemaUrl(ctx.databaseUrl, ctx.schema), max });
  // A terminated backend surfaces as an 'error' on the (checked-out) client;
  // without a listener that would crash the process instead of failing the row.
  pool.on("connect", (client) => client.on("error", () => {}));
  pool.on("error", () => {});
  const label = `runMigrations(pool max=${max})`;
  const before = { ...activeResources() };
  const migrating = runMigrations(pool, MIGRATIONS_DIR);
  migrating.catch(() => {});
  let result: Awaited<typeof migrating>;
  try {
    result = await withWatchdog(migrating, POOL_CYCLE_WATCHDOG_MS, label);
  } catch (error) {
    if (!(error instanceof WatchdogTimeout)) {
      await pool.end();
      throw error;
    }
    const heldBefore = await advisoryLockCount(ctx.control);
    const terminated = await terminateAdvisoryLockHolders(ctx);
    const heldAfter = await advisoryLockCount(ctx.control);
    const socketsBefore = before["TCPSocketWrap"] ?? 0;
    const socketsAfter = activeResources()["TCPSocketWrap"] ?? 0;
    throw new Error(
      `${label} hung >${POOL_CYCLE_WATCHDOG_MS}ms holding the migration advisory lock ` +
        `(advisory locks held=${heldBefore}, pool total=${pool.totalCount} idle=${pool.idleCount} ` +
        `waiting=${pool.waitingCount}); recovered by pg_terminate_backend x${terminated} ` +
        `(locks after=${heldAfter}, sockets ${socketsBefore}->${socketsAfter})`,
    );
  }
  let out: OpResult;
  try {
    if (result.applied.length !== 0) throw new Error(`pool_cycle applied ${result.applied.length}`);
    await seed(pool);
    const { fp } = await catalogFingerprint(pool);
    out = { fingerprint: fp, detail: `max=${max} total=${pool.totalCount}` };
  } finally {
    await pool.end();
  }
  if (pool.totalCount !== 0) throw new Error(`pool.end left totalCount=${pool.totalCount}`);
  return out;
}

async function opFreshSchemaMigrate(ctx: IterationContext): Promise<OpResult> {
  await ctx.control.query(`DROP SCHEMA ${ctx.schema} CASCADE; CREATE SCHEMA ${ctx.schema};`);
  const result = await runMigrations(ctx.sharedPool, MIGRATIONS_DIR);
  if (result.applied.length !== ctx.migrationCount) {
    throw new Error(`fresh migrate applied ${result.applied.length}/${ctx.migrationCount}`);
  }
  await seed(ctx.sharedPool);
  const { fp } = await catalogFingerprint(ctx.sharedPool);
  return { fingerprint: fp, detail: `applied=${result.applied.length}` };
}

async function opTamperedDirRejects(ctx: IterationContext, rng: () => number): Promise<OpResult> {
  const dir = await mkdtemp(join(tmpdir(), "pickle-stress-tamper-"));
  const table = `stress_tamper_${Math.floor(rng() * 1e9)}`;
  try {
    await writeFile(join(dir, "0001_a.sql"), `CREATE TABLE ${table} (id int);`);
    await runMigrations(ctx.sharedPool, dir);
    await writeFile(join(dir, "0001_a.sql"), `CREATE TABLE ${table} (id bigint);`);
    let rejected = false;
    try {
      await runMigrations(ctx.sharedPool, dir);
    } catch (error) {
      rejected = /checksum mismatch/.test(String(error));
    }
    if (!rejected) throw new Error("tampered migration was not rejected with checksum mismatch");
    await ctx.sharedPool.query(`DROP TABLE ${table}`);
    await ctx.sharedPool.query("DELETE FROM schema_migrations WHERE name = '0001_a.sql'");
    return { fingerprint: "rejected:checksum", detail: table };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function opCancelMidSeed(ctx: IterationContext, rng: () => number): Promise<OpResult> {
  const delayMs = Math.floor(rng() * 40);
  const pool = new pg.Pool({ connectionString: schemaUrl(ctx.databaseUrl, ctx.schema), max: 2 });
  const seeding = seed(pool);
  await sleep(delayMs);
  const ending = pool.end();
  let outcome: string;
  try {
    await seeding;
    outcome = "completed";
  } catch (error) {
    if (!/after calling end/.test(String(error))) throw error;
    outcome = "rejected";
  }
  await ending;
  if (pool.totalCount !== 0) throw new Error(`cancelled pool left totalCount=${pool.totalCount}`);
  // Whatever happened mid-way, a following seed must converge to the canonical catalog.
  await seed(ctx.sharedPool);
  const { fp } = await catalogFingerprint(ctx.sharedPool);
  return { fingerprint: fp, detail: `delay=${delayMs}ms seed=${outcome}` };
}

async function opConcurrentNoopPair(ctx: IterationContext): Promise<OpResult> {
  const a = new pg.Pool({ connectionString: schemaUrl(ctx.databaseUrl, ctx.schema), max: 2 });
  const b = new pg.Pool({ connectionString: schemaUrl(ctx.databaseUrl, ctx.schema), max: 2 });
  try {
    const [ra, rb] = await Promise.all([
      runMigrations(a, MIGRATIONS_DIR),
      runMigrations(b, MIGRATIONS_DIR),
    ]);
    if (ra.applied.length + rb.applied.length !== 0) {
      throw new Error(`concurrent noop pair applied ${ra.applied.length + rb.applied.length}`);
    }
    return {
      fingerprint: `skipped:${ra.skipped.length}:${rb.skipped.length}`,
      detail: `skipped=${ra.skipped.length}+${rb.skipped.length}`,
    };
  } finally {
    await Promise.all([a.end(), b.end()]);
  }
}

/**
 * `rng` is the iteration stream positioned just past the mode draw, so an
 * operation's parameters vary independently of which mode was selected.
 */
async function runOne(ctx: IterationContext, mode: IterationMode, rng: () => number) {
  switch (mode) {
    case "seed_idempotent":
      return opSeedIdempotent(ctx, rng);
    case "migrate_noop_then_seed":
      return opMigrateNoopThenSeed(ctx);
    case "pool_cycle":
      return opPoolCycle(ctx, rng);
    case "fresh_schema_migrate":
      return opFreshSchemaMigrate(ctx);
    case "tampered_dir_rejects":
      return opTamperedDirRejects(ctx, rng);
    case "cancel_mid_seed":
      return opCancelMidSeed(ctx, rng);
    case "concurrent_noop_pair":
      return opConcurrentNoopPair(ctx);
  }
}

// ─── Post-iteration invariants (server side) ─────────────────────────────────
async function advisoryLockCount(control: pg.Pool): Promise<number> {
  const { rows } = await control.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks l
     JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND a.datname = current_database()
       AND a.application_name = current_setting('application_name')`,
  );
  return rows[0]?.n ?? -1;
}

async function serverConnectionCount(control: pg.Pool): Promise<number> {
  const { rows } = await control.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend'
       AND application_name = current_setting('application_name')`,
  );
  return rows[0]?.n ?? -1;
}

/** Server-side teardown of an ended pool's sockets can trail the client by a few ms. */
async function waitForConnections(control: pg.Pool, target: number, timeoutMs = 2000) {
  const started = Date.now();
  let n = await serverConnectionCount(control);
  while (n > target && Date.now() - started < timeoutMs) {
    await sleep(20);
    n = await serverConnectionCount(control);
  }
  return n;
}

async function takeSample(
  ctx: IterationContext,
  gc: GcFn,
  i: number,
  meanMs: number,
  expectedConnections: number,
): Promise<Sample> {
  gc();
  await sleep(10);
  gc();
  const mem = process.memoryUsage();
  return {
    i,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    resources: activeResources(),
    processListeners: countProcessListeners(),
    poolTotal: ctx.sharedPool.totalCount,
    poolIdle: ctx.sharedPool.idleCount,
    poolWaiting: ctx.sharedPool.waitingCount,
    serverConnections: await waitForConnections(ctx.control, expectedConnections),
    advisoryLocks: await advisoryLockCount(ctx.control),
    meanMsSinceLastSample: meanMs,
  };
}

function linearSlope(points: Array<{ x: number; y: number }>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  return den === 0 ? null : num / den;
}

function resourceDelta(a: Record<string, number>, b: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[k] ?? 0) - (a[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── Campaign ────────────────────────────────────────────────────────────────
export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const log = options.log ?? (() => {});
  const { gc, exposed } = obtainGc();
  const schema = `stress_leak_${process.pid}_${(options.masterSeed >>> 0).toString(16)}`;
  const control = new pg.Pool({
    connectionString: controlUrl(options.databaseUrl, schema),
    max: 1,
  });
  const startedAt = new Date().toISOString();

  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
  const sharedPool = new pg.Pool({
    connectionString: schemaUrl(options.databaseUrl, schema),
    max: 4,
  });
  const migrationCount = (await loadMigrations(MIGRATIONS_DIR)).length;
  const ctx: IterationContext = {
    databaseUrl: options.databaseUrl,
    schema,
    sharedPool,
    control,
    migrationCount,
  };

  const rows: IterationRow[] = [];
  const samples: Sample[] = [];
  try {
    // Warm the shared pool to its steady state so the baseline reflects it.
    const first = await runMigrations(sharedPool, MIGRATIONS_DIR);
    if (first.applied.length !== migrationCount) {
      throw new Error(`initial migrate applied ${first.applied.length}/${migrationCount}`);
    }
    await seed(sharedPool);
    await Promise.all(Array.from({ length: 4 }, () => sharedPool.query("SELECT 1")));
    const expectedConnections = await serverConnectionCount(control);
    const baseline = await takeSample(ctx, gc, 0, 0, expectedConnections);
    samples.push(baseline);
    log(`baseline heapUsed=${baseline.heapUsed} connections=${baseline.serverConnections}`);

    let windowMs: number[] = [];
    for (let i = 1; i <= options.iterations; i++) {
      const seedValue = iterationSeed(options.masterSeed, i);
      const rng = mulberry32(seedValue);
      const mode = pickMode(rng, options.profile);
      const t0 = performance.now();
      let row: IterationRow;
      try {
        const { fingerprint, detail } = await runOne(ctx, mode, rng);
        const locks = await advisoryLockCount(control);
        if (locks !== 0) throw new Error(`advisory locks still held after iteration: ${locks}`);
        if (sharedPool.waitingCount !== 0) {
          throw new Error(`shared pool has ${sharedPool.waitingCount} waiters after iteration`);
        }
        row = {
          i,
          seed: seedValue,
          mode,
          outcome: "ok",
          ms: performance.now() - t0,
          fingerprint,
          detail,
        };
      } catch (error) {
        row = {
          i,
          seed: seedValue,
          mode,
          outcome: "fail",
          ms: performance.now() - t0,
          fingerprint: "error",
          detail: String(error),
        };
      }
      rows.push(row);
      // Timing drift is measured over successful iterations only; a failed
      // row carries its own duration in the table.
      if (row.outcome === "ok") windowMs.push(row.ms);
      if (i % options.sampleEvery === 0 || i === options.iterations) {
        const sample = await takeSample(ctx, gc, i, mean(windowMs) ?? 0, expectedConnections);
        samples.push(sample);
        windowMs = [];
        log(
          `i=${i} heapUsed=${sample.heapUsed} rss=${sample.rss} conns=${sample.serverConnections} ` +
            `locks=${sample.advisoryLocks} handles=${JSON.stringify(sample.resources)} ` +
            `meanMs=${sample.meanMsSinceLastSample.toFixed(1)}`,
        );
      }
    }

    const final = samples[samples.length - 1] ?? baseline;
    // The baseline and the first sampled window carry JIT/pool warm-up; the
    // slope is fitted over the steady-state samples that follow.
    const postWarmup = samples.slice(2);
    const heapFirst = postWarmup[0]?.heapUsed ?? null;
    const slopeBytes = linearSlope(postWarmup.map((s) => ({ x: s.i, y: s.heapUsed })));
    const slopePer100Bytes = slopeBytes === null ? null : slopeBytes * 100;
    const slopePer100Fraction =
      slopePer100Bytes === null || heapFirst === null || heapFirst === 0
        ? null
        : slopePer100Bytes / heapFirst;
    const failures = rows.filter((r) => r.outcome === "fail").length;
    const firstWindow = samples[1]?.meanMsSinceLastSample ?? null;
    const lastWindow = samples.length > 2 ? final.meanMsSinceLastSample : null;
    const rDelta = resourceDelta(baseline.resources, final.resources);
    const finite = samples.every((s) =>
      [s.heapUsed, s.heapTotal, s.rss, s.external, s.arrayBuffers, s.meanMsSinceLastSample].every(
        Number.isFinite,
      ),
    );

    const analysis: CampaignResult["analysis"] = {
      heapSlopePer100Fraction: slopePer100Fraction,
      heapSlopePer100Bytes: slopePer100Bytes,
      heapFirstPostWarmup: heapFirst,
      heapLast: final.heapUsed,
      resourceDelta: rDelta,
      processListenerDelta: final.processListeners - baseline.processListeners,
      serverConnectionDelta: final.serverConnections - baseline.serverConnections,
      advisoryLocksAtEnd: final.advisoryLocks,
      meanMsFirstWindow: firstWindow,
      meanMsLastWindow: lastWindow,
      timeDriftRatio:
        firstWindow && lastWindow !== null && firstWindow > 0 ? lastWindow / firstWindow : null,
      failures,
    };

    return {
      config: {
        iterations: options.iterations,
        masterSeed: options.masterSeed,
        profile: options.profile,
        sampleEvery: options.sampleEvery,
        heapSlopeLimitPer100: options.heapSlopeLimitPer100,
      },
      node: process.version,
      gcExposed: exposed,
      schema,
      startedAt,
      finishedAt: new Date().toISOString(),
      iterationsExecuted: rows.length,
      rows,
      samples,
      baseline,
      final,
      analysis,
      verdicts: {
        allIterationsOk: failures === 0,
        // Requires >= 4 steady-state samples (baseline + first window excluded);
        // shorter campaigns cannot support a slope verdict and are reported as such.
        heapSlopeWithinLimit:
          postWarmup.length >= 4 &&
          slopePer100Fraction !== null &&
          slopePer100Fraction <= options.heapSlopeLimitPer100,
        // The shared pool keeps pg's default 10s idle reaper, so idle sockets
        // warmed for the baseline may legitimately be fewer at the end; growth
        // in any handle type or in process listeners is what marks a leak.
        handlesReturnedToBaseline:
          Object.values(rDelta).every((d) => d <= 0) && analysis.processListenerDelta <= 0,
        noAdvisoryLockLeak: final.advisoryLocks === 0,
        serverConnectionsReturned: analysis.serverConnectionDelta <= 0,
        fingerprintsFinite: finite,
      },
    };
  } finally {
    await sharedPool.end();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  }
}

/** Replays a single iteration (by master seed + index) in a private schema and returns its row. */
export async function replayIteration(
  databaseUrl: string,
  masterSeed: number,
  index: number,
  profile: Profile,
): Promise<IterationRow> {
  const schema = `stress_replay_${process.pid}_${index}`;
  const control = new pg.Pool({ connectionString: controlUrl(databaseUrl, schema), max: 1 });
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
  const sharedPool = new pg.Pool({ connectionString: schemaUrl(databaseUrl, schema), max: 4 });
  try {
    const migrationCount = (await loadMigrations(MIGRATIONS_DIR)).length;
    await runMigrations(sharedPool, MIGRATIONS_DIR);
    await seed(sharedPool);
    const ctx: IterationContext = { databaseUrl, schema, sharedPool, control, migrationCount };
    const seedValue = iterationSeed(masterSeed, index);
    const rng = mulberry32(seedValue);
    const mode = pickMode(rng, profile);
    const t0 = performance.now();
    try {
      const { fingerprint, detail } = await runOne(ctx, mode, rng);
      return {
        i: index,
        seed: seedValue,
        mode,
        outcome: "ok",
        ms: performance.now() - t0,
        fingerprint,
        detail,
      };
    } catch (error) {
      return {
        i: index,
        seed: seedValue,
        mode,
        outcome: "fail",
        ms: performance.now() - t0,
        fingerprint: "error",
        detail: String(error),
      };
    }
  } finally {
    await sharedPool.end();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  }
}

export function resultDigest(result: CampaignResult): string {
  return createHash("sha256")
    .update(JSON.stringify(result.rows.map((r) => [r.i, r.seed, r.mode, r.outcome, r.fingerprint])))
    .digest("hex");
}
