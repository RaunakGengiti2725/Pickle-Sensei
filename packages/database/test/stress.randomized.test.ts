import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbContext,
  dbTraceKey,
  generateDbSequence,
  runDbSequence,
  spawnVictim,
  type DbContext,
  type DbFailure,
} from "./stress/dbLens.js";
import { generatePureSequence, pureTraceKey, runPureSequence } from "./stress/pureLens.js";
import { summarize, runSeedBoth } from "./stress/campaign.js";

/**
 * Seeded randomized long-run lens for @pickle/database (see
 * test/stress/dbLens.ts for the invariant list). The suite default keeps this
 * fast; the full campaign (>= 2000 seeds, per-seed replay, minimization) runs
 * out of band via test/stress/campaign.ts with STRESS_ITER.
 *
 *   STRESS_ITER=40 STRESS_SEED_BASE=1000 DATABASE_URL_TEST=... pnpm --filter @pickle/database test
 *
 * C1 (a runner whose backends are terminated mid-run must reject instead of
 * crashing the process) is a KNOWN DEFECT of runMigrations: its checked-out
 * clients carry no 'error' listener, so a terminated backend raises an
 * unhandled 'error' event (see the dedicated `it.fails` case below and the
 * stress campaign report). The randomized cases therefore assert every other
 * invariant strictly and only report C1.
 */

const hardFailures = <F extends Pick<DbFailure, "invariant">>(failures: F[]): F[] =>
  failures.filter((f) => f.invariant !== "C1");

const testUrl = process.env["DATABASE_URL_TEST"];
const iterations = Number(process.env["STRESS_ITER"] ?? "6");
const seedBase = Number(process.env["STRESS_SEED_BASE"] ?? "1");
const pureIterations = Math.max(iterations * 25, 150);

describe("randomized-seeded: pure migration-file API", () => {
  it(`holds P1-P4 over ${pureIterations} seeded sequences and replays identically`, async () => {
    const rows = [];
    for (let k = 0; k < pureIterations; k++) {
      const seed = seedBase + k;
      const { length } = generatePureSequence(seed);
      expect(length).toBeGreaterThanOrEqual(5);
      expect(length).toBeLessThanOrEqual(60);
      const a = await runPureSequence(seed);
      expect(a.failures, `seed ${seed}`).toEqual([]);
      expect(a.executedSteps).toBe(length);
      const b = await runPureSequence(seed);
      expect(pureTraceKey(b), `seed ${seed} replay`).toBe(pureTraceKey(a));
      rows.push(a);
    }
    const steps = rows.reduce((n, r) => n + r.executedSteps, 0);
    expect(steps).toBeGreaterThan(pureIterations * 5);
  });
});

describe.skipIf(!testUrl)("randomized-seeded: migrate/seed against PostgreSQL", () => {
  let ctx: DbContext;

  beforeAll(async () => {
    ctx = await createDbContext(testUrl ?? "");
  });

  afterAll(async () => {
    await ctx.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await ctx.pool.end();
  });

  it(`holds M1-M6/S1-S3/N1 over ${iterations} seeded sequences`, async () => {
    const results = [];
    for (let k = 0; k < iterations; k++) {
      const seed = seedBase + k;
      const { length } = generateDbSequence(seed);
      expect(length).toBeGreaterThanOrEqual(5);
      expect(length).toBeLessThanOrEqual(60);
      const result = await runDbSequence(ctx, seed);
      expect(hardFailures(result.failures), `seed ${seed}`).toEqual([]);
      expect(result.executedSteps).toBe(length);
      results.push(result);
    }
    const kinds = new Set(results.flatMap((r) => r.trace.map((s) => s.kind)));
    expect(kinds.size).toBeGreaterThan(5);
  });

  it("D1: the same seed replays to an identical trace", async () => {
    for (let k = 0; k < Math.min(iterations, 3); k++) {
      const seed = seedBase + 500 + k;
      const a = await runDbSequence(ctx, seed);
      const b = await runDbSequence(ctx, seed);
      expect(hardFailures(a.failures), `seed ${seed}`).toEqual([]);
      expect(dbTraceKey(b), `seed ${seed} replay`).toBe(dbTraceKey(a));
    }
  });

  // Known defect pinned as an expected failure: flip to a plain `it` once
  // runMigrations survives a terminated backend with a rejected promise.
  it.fails(
    "C1: terminating the lock-holding backend mid-run rejects instead of crashing the process",
    async () => {
      await ctx.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      const dir = await mkdtemp(join(tmpdir(), "pickle-stress-c1-"));
      try {
        await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE stress_c1_a (id int);\n");
        await writeFile(
          join(dir, "0002_slow.sql"),
          "SELECT pg_sleep(3);\nCREATE TABLE stress_c1_b (id int);\n",
        );
        const appName = "stress-c1-victim";
        const victim = spawnVictim(ctx.connectionString, dir, appName);
        // Wait until 0001 is recorded and 0002 (pg_sleep) is in flight, then
        // terminate only the idle backend that holds the advisory lock.
        let lockPid: number | undefined;
        const deadline = Date.now() + 20_000;
        while (lockPid === undefined && Date.now() < deadline && !victim.exited()) {
          const { rows } = await ctx.pool.query<{ pid: number; query: string; state: string }>(
            "SELECT pid, query, state FROM pg_stat_activity WHERE application_name = $1",
            [appName],
          );
          const applied = await ctx.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'schema_migrations'",
          );
          const recorded =
            applied.rows[0]?.n === 1
              ? (
                  await ctx.pool.query<{ n: number }>(
                    "SELECT count(*)::int AS n FROM schema_migrations",
                  )
                ).rows[0]?.n
              : 0;
          if (recorded === 1)
            lockPid = rows.find((r) => r.state === "idle" && /pg_advisory_lock/.test(r.query))?.pid;
          if (lockPid === undefined) await new Promise((r) => setTimeout(r, 25));
        }
        expect(lockPid, "lock-holding backend found mid-run").toBeDefined();
        await ctx.pool.query("SELECT pg_terminate_backend($1)", [lockPid]);
        const exit = await victim.done;
        // Server side stays consistent regardless (M6)...
        const { rows } = await ctx.pool.query<{ name: string }>(
          "SELECT name FROM schema_migrations ORDER BY name",
        );
        expect(rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
        // ...but the runner must settle as a rejection, not an unhandled 'error' event.
        expect(exit.stderr).not.toContain("Unhandled 'error' event");
        expect(exit.code).toBe(3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("campaign runner reports HELD rows with replay evidence", async () => {
    const rows = await runSeedBoth(ctx, seedBase + 900, { replay: true, flakeRuns: 0 });
    const totals = summarize(rows);
    expect(totals.sequences).toBe(2);
    expect(rows.flatMap((r) => hardFailures(r.failures))).toEqual([]);
    expect(totals.replayMismatches).toBe(0);
    for (const row of rows) expect(row.replayIdentical).toBe(true);
  }, 120_000);
});
