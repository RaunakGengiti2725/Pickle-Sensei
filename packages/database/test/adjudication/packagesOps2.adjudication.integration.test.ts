import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate.js";

/**
 * Independent adjudication replays for stress area packages-ops-2 (database).
 * Each `it` asserts the DESIRED behaviour, so it is red while the defect is
 * present and turns green once fixed. Run with
 * `DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
 *    pnpm --filter @pickle/database test -- test/adjudication`.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const HERE = dirname(fileURLToPath(import.meta.url));
const VICTIM = join(HERE, "victim.ts");

function schemaPool(schema: string, max?: number): pg.Pool {
  const url = new URL(testUrl ?? "");
  url.searchParams.set("options", `-c search_path=${schema}`);
  url.searchParams.set("application_name", `adj_${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), ...(max ? { max } : {}) });
  pool.on("error", () => {});
  return pool;
}

describe.skipIf(!testUrl)("packages-ops-2 database adjudication", () => {
  let admin: pg.Pool;
  const schemas = ["adj_d1", "adj_d3", "adj_d5"];

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl, max: 2 });
    for (const s of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE; CREATE SCHEMA ${s};`);
    }
  });

  afterAll(async () => {
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
  });

  it("ADJ-D1: terminating the lock-holding backend mid-run rejects instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adj-d1-"));
    try {
      await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE adj_d1_a (id int);\n");
      await writeFile(
        join(dir, "0002_slow.sql"),
        "SELECT pg_sleep(4);\nCREATE TABLE adj_d1_b (id int);\n",
      );
      const url = new URL(testUrl ?? "");
      url.searchParams.set("options", "-c search_path=adj_d1");
      const appName = "adj_d1_victim";
      let stdout = "";
      let stderr = "";
      const done = new Promise<number | null>((resolve) => {
        execFile(
          process.execPath,
          ["--import", "tsx", VICTIM, url.toString(), dir, appName],
          { cwd: join(HERE, "..", "..") },
          (error, out, err) => {
            stdout = out;
            stderr = err;
            resolve(error === null ? 0 : typeof error.code === "number" ? error.code : null);
          },
        );
      });

      // Wait until 0001 is recorded (0002's pg_sleep is in flight), then kill
      // ONLY the idle backend holding the advisory lock.
      let lockPid: number | undefined;
      const deadline = Date.now() + 20_000;
      while (lockPid === undefined && Date.now() < deadline) {
        const applied = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'adj_d1' AND tablename = 'schema_migrations'",
        );
        if (applied.rows[0]?.n === 1) {
          const recorded = await admin.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM adj_d1.schema_migrations",
          );
          if (recorded.rows[0]?.n === 1) {
            const { rows } = await admin.query<{ pid: number; query: string; state: string }>(
              "SELECT pid, query, state FROM pg_stat_activity WHERE application_name = $1",
              [appName],
            );
            lockPid = rows.find((r) => r.state === "idle" && /pg_advisory_lock/.test(r.query))?.pid;
          }
        }
        if (lockPid === undefined) await new Promise((r) => setTimeout(r, 25));
      }
      expect(lockPid, "lock-holding backend found mid-run").toBeDefined();
      await admin.query("SELECT pg_terminate_backend($1)", [lockPid]);
      const code = await done;
      const ledger = await admin.query<{ name: string }>(
        "SELECT name FROM adj_d1.schema_migrations ORDER BY name",
      );
      expect(ledger.rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
      expect(stderr, `victim stderr:\n${stderr}\nstdout:\n${stdout}`).not.toContain(
        "Unhandled 'error' event",
      );
      expect(code, `victim exit code (stdout: ${stdout})`).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("ADJ-D3: a failed migration containing an explicit COMMIT leaves no DDL behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adj-d3-"));
    const pool = schemaPool("adj_d3");
    try {
      await writeFile(
        join(dir, "0001_escape.sql"),
        "CREATE TABLE adj_d3_before (id integer);\nCOMMIT;\nCREATE TABLE adj_d3_after (id integer);\nINSERT INTO adj_d3_after VALUES ('not an int');\n",
      );
      await expect(runMigrations(pool, dir)).rejects.toThrow(/Migration 0001_escape.sql failed/);
      const { rows } = await admin.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'adj_d3' ORDER BY tablename",
      );
      const ledger = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM adj_d3.schema_migrations",
      );
      expect(ledger.rows[0]?.n).toBe(0);
      expect(rows.map((r) => r.tablename)).toEqual(["schema_migrations"]);
    } finally {
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ADJ-D5: runMigrations settles with a single-connection pool and releases the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adj-d5-"));
    const pool = schemaPool("adj_d5", 1);
    try {
      await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE adj_d5_a (id int);\n");
      const migrating = runMigrations(pool, dir);
      migrating.catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        migrating.then(() => "settled" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
      const locks = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND a.application_name = 'adj_adj_d5'`,
      );
      if (settled === "timeout") {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'adj_adj_d5'",
        );
      }
      expect({ settled, advisoryLocksHeld: locks.rows[0]?.n }).toEqual({
        settled: "settled",
        advisoryLocksHeld: 0,
      });
    } finally {
      // pool.end() never resolves while a checkout is still queued against a
      // saturated pool, so give it a bounded grace period.
      await Promise.race([
        pool.end().catch(() => undefined),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
