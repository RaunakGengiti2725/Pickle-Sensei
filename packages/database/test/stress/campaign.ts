import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import {
  createDbContext,
  dbTraceKey,
  generateDbSequence,
  runDbSequence,
  type DbActionSpec,
  type DbContext,
  type DbSequenceResult,
} from "./dbLens.js";
import {
  generatePureSequence,
  pureTraceKey,
  runPureSequence,
  type PureActionSpec,
  type PureSequenceResult,
} from "./pureLens.js";

/**
 * Seeded randomized long-run campaign for @pickle/database.
 *
 *   STRESS_ITER=2000 STRESS_WORKERS=6 DATABASE_URL_TEST=postgres://... \
 *     pnpm --filter @pickle/database exec tsx test/stress/campaign.ts
 *
 * Every worker owns a throwaway database (`<db>_stress_w<k>`) created from the
 * DATABASE_URL_TEST connection (which must be allowed to CREATE DATABASE; the
 * docker `pickle` user is superuser). Each seed runs the pure lens and the db
 * lens, then is replayed once more to prove determinism (D1). Failing seeds are
 * minimized (prefix cut at the failing step, then greedy action removal) and
 * re-run STRESS_FLAKE_RUNS times to measure the failure rate.
 */

export interface SeedRow {
  seed: number;
  lens: "pure" | "db";
  status: "HELD" | "BROKEN";
  length: number;
  executedSteps: number;
  durationMs: number;
  replayIdentical: boolean | null;
  failures: Array<{ step: number; kind: string; invariant: string; detail: string }>;
  observations: Record<string, number>;
  /** Executed action kinds → count (what the sequence actually exercised). */
  kinds: Record<string, number>;
  minimized?: Minimized;
  flakeRate?: { runs: number; failed: number };
}

export interface Minimized {
  actions: Array<{ kind: string; r: [number, number, number] }>;
  failure: { step: number; kind: string; invariant: string; detail: string } | null;
  originalLength: number;
}

export interface CampaignReport {
  meta: {
    startedAt: string;
    finishedAt: string;
    seedBase: number;
    iterations: number;
    workers: number;
    node: string;
    minLen: number;
    maxLen: number;
  };
  totals: {
    sequences: number;
    steps: number;
    held: number;
    broken: number;
    replayMismatches: number;
    perLens: Record<string, { sequences: number; steps: number; broken: number }>;
    perKind: Record<string, number>;
    observations: Record<string, number>;
    invariantsBroken: Record<string, number>;
  };
  rows: SeedRow[];
}

function countKinds(trace: ReadonlyArray<{ kind: string }>): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const step of trace) kinds[step.kind] = (kinds[step.kind] ?? 0) + 1;
  return kinds;
}

function rowFromDb(r: DbSequenceResult, replayIdentical: boolean | null): SeedRow {
  return {
    seed: r.seed,
    lens: "db",
    status: r.status,
    length: r.length,
    executedSteps: r.executedSteps,
    durationMs: r.durationMs,
    replayIdentical,
    failures: r.failures,
    observations: r.observations,
    kinds: countKinds(r.trace),
  };
}

function rowFromPure(r: PureSequenceResult, replayIdentical: boolean | null): SeedRow {
  return {
    seed: r.seed,
    lens: "pure",
    status: r.status,
    length: r.length,
    executedSteps: r.executedSteps,
    durationMs: r.durationMs,
    replayIdentical,
    failures: r.failures,
    observations: r.observations,
    kinds: countKinds(r.trace),
  };
}

function sameFailure(
  a: { invariant: string; kind: string } | undefined,
  b: { invariant: string; kind: string } | undefined,
): boolean {
  return !!a && !!b && a.invariant === b.invariant && a.kind === b.kind;
}

/** Greedy delta-debugging over the action list, keeping the failure class. */
async function minimizeActions<A>(
  actions: A[],
  failing: (actions: A[]) => Promise<{ step: number; kind: string; invariant: string } | undefined>,
  target: { step: number; kind: string; invariant: string },
): Promise<A[]> {
  let current = actions.slice(0, target.step + 1);
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = current.length - 1; i >= 0; i--) {
      if (current.length <= 1) break;
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      const f = await failing(candidate);
      if (sameFailure(f, target)) {
        current = candidate;
        progress = true;
      }
    }
  }
  return current;
}

export async function minimizeDbSeed(ctx: DbContext, seed: number): Promise<Minimized> {
  const original = generateDbSequence(seed).actions;
  const first = await runDbSequence(ctx, seed, original);
  const target = first.failures[0];
  if (!target) return { actions: [], failure: null, originalLength: original.length };
  const minimized = await minimizeActions<DbActionSpec>(
    original,
    async (a) => (await runDbSequence(ctx, seed, a)).failures[0],
    target,
  );
  const final = await runDbSequence(ctx, seed, minimized);
  return {
    actions: minimized,
    failure: final.failures[0] ?? null,
    originalLength: original.length,
  };
}

export async function minimizePureSeed(seed: number): Promise<Minimized> {
  const original = generatePureSequence(seed).actions;
  const first = await runPureSequence(seed, original);
  const target = first.failures[0];
  if (!target) return { actions: [], failure: null, originalLength: original.length };
  const minimized = await minimizeActions<PureActionSpec>(
    original,
    async (a) => (await runPureSequence(seed, a)).failures[0],
    target,
  );
  const final = await runPureSequence(seed, minimized);
  return {
    actions: minimized,
    failure: final.failures[0] ?? null,
    originalLength: original.length,
  };
}

export async function runSeedBoth(
  ctx: DbContext | null,
  seed: number,
  opts: { replay: boolean; flakeRuns: number },
): Promise<SeedRow[]> {
  const rows: SeedRow[] = [];
  const pure = await runPureSequence(seed);
  let pureReplay: boolean | null = null;
  if (opts.replay) pureReplay = pureTraceKey(await runPureSequence(seed)) === pureTraceKey(pure);
  const pureRow = rowFromPure(pure, pureReplay);
  if (pure.status === "BROKEN") {
    pureRow.minimized = await minimizePureSeed(seed);
    let failed = 0;
    for (let k = 0; k < opts.flakeRuns; k++)
      if ((await runPureSequence(seed)).status === "BROKEN") failed++;
    pureRow.flakeRate = { runs: opts.flakeRuns, failed };
  }
  rows.push(pureRow);

  if (ctx) {
    let db: DbSequenceResult;
    try {
      db = await runDbSequence(ctx, seed);
    } catch (error) {
      // An exception escaping the sequence runner is itself a finding: record
      // it as a BROKEN row instead of aborting the campaign.
      const { length } = generateDbSequence(seed);
      rows.push({
        seed,
        lens: "db",
        status: "BROKEN",
        length,
        executedSteps: 0,
        durationMs: 0,
        replayIdentical: null,
        failures: [
          {
            step: -1,
            kind: "harness",
            invariant: "HARNESS",
            detail: (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(
              0,
              600,
            ),
          },
        ],
        observations: {},
        kinds: {},
      });
      return rows;
    }
    let dbReplay: boolean | null = null;
    if (opts.replay) dbReplay = dbTraceKey(await runDbSequence(ctx, seed)) === dbTraceKey(db);
    const dbRow = rowFromDb(db, dbReplay);
    if (db.status === "BROKEN") {
      dbRow.minimized = await minimizeDbSeed(ctx, seed);
      let failed = 0;
      for (let k = 0; k < opts.flakeRuns; k++)
        if ((await runDbSequence(ctx, seed)).status === "BROKEN") failed++;
      dbRow.flakeRate = { runs: opts.flakeRuns, failed };
    }
    rows.push(dbRow);
  }
  return rows;
}

export function summarize(rows: SeedRow[]): CampaignReport["totals"] {
  const totals: CampaignReport["totals"] = {
    sequences: rows.length,
    steps: 0,
    held: 0,
    broken: 0,
    replayMismatches: 0,
    perLens: {},
    perKind: {},
    observations: {},
    invariantsBroken: {},
  };
  for (const row of rows) {
    totals.steps += row.executedSteps;
    if (row.status === "HELD") totals.held++;
    else totals.broken++;
    if (row.replayIdentical === false) totals.replayMismatches++;
    const lens = (totals.perLens[row.lens] ??= { sequences: 0, steps: 0, broken: 0 });
    lens.sequences++;
    lens.steps += row.executedSteps;
    if (row.status === "BROKEN") lens.broken++;
    for (const [k, v] of Object.entries(row.observations))
      totals.observations[k] = (totals.observations[k] ?? 0) + v;
    for (const [k, v] of Object.entries(row.kinds))
      totals.perKind[`${row.lens}:${k}`] = (totals.perKind[`${row.lens}:${k}`] ?? 0) + v;
    for (const f of row.failures)
      totals.invariantsBroken[f.invariant] = (totals.invariantsBroken[f.invariant] ?? 0) + 1;
  }
  return totals;
}

function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function ensureDatabases(connectionString: string, workers: number): Promise<string[]> {
  const base = new URL(connectionString).pathname.replace(/^\//, "");
  const admin = new pg.Pool({ connectionString, max: 1 });
  const urls: string[] = [];
  try {
    for (let k = 0; k < workers; k++) {
      const name = `${base}_stress_w${k}`;
      const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (rows.length === 0) await admin.query(`CREATE DATABASE "${name}"`);
      urls.push(withDatabase(connectionString, name));
    }
  } finally {
    await admin.end();
  }
  return urls;
}

async function main(): Promise<void> {
  const iterations = Number(process.env["STRESS_ITER"] ?? "2000");
  const seedBase = Number(process.env["STRESS_SEED_BASE"] ?? "1");
  const workers = Math.max(1, Number(process.env["STRESS_WORKERS"] ?? "6"));
  const flakeRuns = Number(process.env["STRESS_FLAKE_RUNS"] ?? "10");
  const out = process.env["STRESS_OUT"] ?? "artifacts/stress/pkg-database-randomized-seeded.json";
  const connectionString = process.env["DATABASE_URL_TEST"];
  if (!connectionString) {
    console.error("DATABASE_URL_TEST is required for the db lens");
    process.exit(2);
  }
  const startedAt = new Date().toISOString();
  const urls = await ensureDatabases(connectionString, workers);
  const contexts = await Promise.all(urls.map((u) => createDbContext(u)));
  const rows: SeedRow[] = [];
  let next = 0;
  let done = 0;
  const worker = async (ctx: DbContext) => {
    for (;;) {
      const k = next++;
      if (k >= iterations) return;
      const seed = seedBase + k;
      const seedRows = await runSeedBoth(ctx, seed, { replay: true, flakeRuns });
      rows.push(...seedRows);
      done++;
      if (done % 50 === 0 || seedRows.some((r) => r.status === "BROKEN")) {
        const broken = rows.filter((r) => r.status === "BROKEN").length;
        console.error(`[stress] ${done}/${iterations} seeds, broken rows so far: ${broken}`);
      }
    }
  };
  try {
    await Promise.all(contexts.map((ctx) => worker(ctx)));
  } finally {
    for (const ctx of contexts) await ctx.pool.end();
  }
  rows.sort((a, b) => a.seed - b.seed || a.lens.localeCompare(b.lens));
  const report: CampaignReport = {
    meta: {
      startedAt,
      finishedAt: new Date().toISOString(),
      seedBase,
      iterations,
      workers,
      node: process.version,
      minLen: 5,
      maxLen: 60,
    },
    totals: summarize(rows),
    rows,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 1));
  console.error(
    `[stress] done: ${report.totals.sequences} sequences, ${report.totals.steps} steps, ` +
      `${report.totals.broken} broken, ${report.totals.replayMismatches} replay mismatches -> ${out}`,
  );
  process.exit(report.totals.broken === 0 && report.totals.replayMismatches === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("campaign.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
