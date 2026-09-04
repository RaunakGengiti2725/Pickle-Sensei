import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { MIGRATION_LOCK_KEY, loadMigrations, runMigrations } from "../src/migrate.js";

/**
 * ATTACK S2 — two `runMigrations()` calls race against the SAME `pickle_test`
 * schema (fresh `public`). The runner takes `pg_advisory_lock(0x7069636b)` on
 * a dedicated session before touching `schema_migrations`; the attack checks
 * that this actually serialises the two runners (one is OBSERVED waiting on
 * the advisory lock in `pg_locks`), that both finish, and that every
 * migration name lands in `schema_migrations` exactly once.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const artifactDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "artifacts",
  "attack4",
);
const testUrl = process.env["DATABASE_URL_TEST"];

interface LockRow {
  pid: number;
  granted: boolean;
  objid: number;
}

async function advisoryLocks(pool: pg.Pool): Promise<LockRow[]> {
  const { rows } = await pool.query<LockRow>(
    `SELECT pid, granted, objid::int AS objid FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 0 AND objid = $1`,
    [MIGRATION_LOCK_KEY],
  );
  return rows;
}

describe.skipIf(!testUrl)("ATTACK S2: concurrent runMigrations() on one schema", () => {
  it("serialises on advisory lock 0x7069636b, both finish, each migration name appears once", async () => {
    expect(MIGRATION_LOCK_KEY).toBe(0x7069636b);
    const observer = new pg.Pool({ connectionString: testUrl, max: 1 });
    const runnerA = new pg.Pool({ connectionString: testUrl, max: 3 });
    const runnerB = new pg.Pool({ connectionString: testUrl, max: 3 });
    const timeline: Array<{ t: number; who: string; line: string }> = [];
    const t0 = Date.now();
    const log = (who: string) => (line: string) => timeline.push({ t: Date.now() - t0, who, line });
    const lockSamples: Array<{ t: number; locks: LockRow[] }> = [];
    let sawWaiter = false;
    let sawTwoHolders = false;
    try {
      await observer.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

      // Sample pg_locks every 10ms while the two runners race.
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const locks = await advisoryLocks(observer);
          lockSamples.push({ t: Date.now() - t0, locks });
          if (locks.some((l) => !l.granted)) sawWaiter = true;
          if (locks.filter((l) => l.granted).length > 1) sawTwoHolders = true;
          await new Promise((r) => setTimeout(r, 10));
        }
      })();

      const [a, b] = await Promise.all([
        runMigrations(runnerA, migrationsDir, log("A")),
        runMigrations(runnerB, migrationsDir, log("B")),
      ]);
      sampling = false;
      await sampler;

      const files = await loadMigrations(migrationsDir);
      const { rows: counts } = await observer.query<{ total: number; distinct: number }>(
        "SELECT count(*)::int AS total, count(DISTINCT name)::int AS distinct FROM schema_migrations",
      );
      const { rows: names } = await observer.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      const afterLocks = await advisoryLocks(observer);

      mkdirSync(artifactDir, { recursive: true });
      const artifact = join(artifactDir, "s2-migrate-concurrency.json");
      writeFileSync(
        artifact,
        JSON.stringify(
          {
            scenario: "S2 two concurrent runMigrations() against one pickle_test schema",
            lockKeyHex: "0x" + MIGRATION_LOCK_KEY.toString(16),
            resultA: { applied: a.applied.length, skipped: a.skipped.length },
            resultB: { applied: b.applied.length, skipped: b.skipped.length },
            migrationFiles: files.length,
            schemaMigrations: counts[0],
            sawWaiterOnAdvisoryLock: sawWaiter,
            sawTwoGrantedHolders: sawTwoHolders,
            lockSamplesTaken: lockSamples.length,
            lockSamplesWithWaiter: lockSamples.filter((s) => s.locks.some((l) => !l.granted))
              .length,
            advisoryLocksAfter: afterLocks,
            timeline,
          },
          null,
          2,
        ) + "\n",
      );

      // Both finished; exactly one of them did the work, the other skipped everything.
      const appliedTotal = a.applied.length + b.applied.length;
      expect(appliedTotal, `applied by A+B; evidence ${artifact}`).toBe(files.length);
      expect([a.skipped.length, b.skipped.length].sort(), "one runner skipped ALL").toEqual([
        0,
        files.length,
      ]);
      // Serialisation was observed, not assumed: a waiter showed up in pg_locks
      // and the lock was never granted to two sessions at once.
      expect(sawWaiter, `a runner blocked on the advisory lock; evidence ${artifact}`).toBe(true);
      expect(sawTwoHolders, "advisory lock granted to two sessions").toBe(false);
      // Every migration name once.
      expect(counts[0]).toEqual({ total: files.length, distinct: files.length });
      expect(names.map((r) => r.name)).toEqual(files.map((f) => f.name));
      // Lock released once both runners are done.
      expect(afterLocks).toEqual([]);
    } finally {
      await Promise.all([observer.end(), runnerA.end(), runnerB.end()]);
    }
  }, 120_000);

  it("a late-joining runner (starts mid-flight) also waits and applies nothing twice", async () => {
    const observer = new pg.Pool({ connectionString: testUrl, max: 1 });
    const runnerA = new pg.Pool({ connectionString: testUrl, max: 3 });
    const runnerB = new pg.Pool({ connectionString: testUrl, max: 3 });
    try {
      await observer.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      const first = runMigrations(runnerA, migrationsDir);
      await new Promise((r) => setTimeout(r, 40));
      let waiterSeen = false;
      const probe = (async () => {
        for (let i = 0; i < 400 && !waiterSeen; i++) {
          waiterSeen = (await advisoryLocks(observer)).some((l) => !l.granted);
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      const second = runMigrations(runnerB, migrationsDir);
      const [a, b] = await Promise.all([first, second]);
      await probe;
      const files = await loadMigrations(migrationsDir);
      const { rows } = await observer.query<{ total: number; distinct: number }>(
        "SELECT count(*)::int AS total, count(DISTINCT name)::int AS distinct FROM schema_migrations",
      );
      mkdirSync(artifactDir, { recursive: true });
      const artifact = join(artifactDir, "s2-migrate-late-joiner.json");
      writeFileSync(
        artifact,
        JSON.stringify({ a, b, waiterSeen, schemaMigrations: rows[0] }, null, 2) + "\n",
      );
      expect(a.applied.length + b.applied.length, artifact).toBe(files.length);
      expect(waiterSeen, `late joiner blocked on advisory lock; evidence ${artifact}`).toBe(true);
      expect(rows[0]).toEqual({ total: files.length, distinct: files.length });
    } finally {
      await Promise.all([observer.end(), runnerA.end(), runnerB.end()]);
    }
  }, 120_000);
});
