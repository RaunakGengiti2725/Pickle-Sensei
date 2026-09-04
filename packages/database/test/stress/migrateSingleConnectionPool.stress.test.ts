import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate.js";

/**
 * Minimal reproduction extracted from the long-run-leak campaign
 * (`pool_cycle` iterations whose pool drew `max: 1`).
 *
 * `runMigrations` checks out one client to hold `pg_advisory_lock` and then
 * issues further work through `pool.query()` / `pool.connect()`. With a pool
 * whose `max` is 1 the second checkout can never be satisfied, so the call
 * never settles — and the migration advisory lock stays held server-side for
 * as long as the process lives. Same gate as the other integration suites:
 * skipped (visibly) without DATABASE_URL_TEST.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const SETTLE_MS = 10_000;
const APP_NAME = `stress_single_conn_${process.pid}`;

function poolFor(schema: string, max: number): pg.Pool {
  const url = new URL(testUrl ?? "");
  url.searchParams.set("application_name", APP_NAME);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), max });
  pool.on("connect", (client) => client.on("error", () => {}));
  pool.on("error", () => {});
  return pool;
}

interface Probe {
  settled: boolean;
  locksHeld: number;
  terminated: number;
}

/** Runs `runMigrations` on `pool`; if it does not settle, frees the server side and reports. */
async function probe(control: pg.Pool, pool: pg.Pool): Promise<Probe> {
  const migrating = runMigrations(pool, MIGRATIONS_DIR);
  migrating.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    migrating.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), SETTLE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const { rows: lockRows } = await control.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND a.application_name = $1`,
    [APP_NAME],
  );
  let terminated = 0;
  if (settled) {
    await pool.end();
  } else {
    const { rows } = await control.query<{ n: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
       WHERE application_name = $1`,
      [APP_NAME],
    );
    terminated = rows[0]?.n ?? 0;
  }
  return { settled, locksHeld: lockRows[0]?.n ?? -1, terminated };
}

describe.skipIf(!testUrl)("runMigrations with a single-connection pool", () => {
  const schema = `stress_single_conn_${process.pid}`;
  let control: pg.Pool;

  beforeAll(async () => {
    control = new pg.Pool({ connectionString: testUrl, max: 1 });
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
  });

  afterAll(async () => {
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  });

  it("completes with max: 2 (one lock holder + one worker)", async () => {
    const result = await probe(control, poolFor(schema, 2));
    expect(result).toEqual({ settled: true, locksHeld: 0, terminated: 0 });
  });

  it(`settles within ${SETTLE_MS}ms with max: 1 and releases the advisory lock`, async () => {
    const result = await probe(control, poolFor(schema, 1));
    expect(
      result,
      "runMigrations must not deadlock on its own lock client when the pool has a single connection",
    ).toEqual({ settled: true, locksHeld: 0, terminated: 0 });
  });
});
