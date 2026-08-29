import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { withTransaction } from "../src/lib/db.js";

/**
 * Wave H h21-backend-cert (Gate 10): connection-pool behavior under
 * exhaustion and transaction-boundary guarantees, against real PostgreSQL.
 * - a fully exhausted pool times out with a typed error instead of hanging
 * - the pool recovers once connections are released (no leak)
 * - a throwing transaction body rolls back and releases its connection
 * - a successful transaction commits atomically
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `db_cert_${process.pid}_${Math.floor(Math.random() * 1e9)}`;

function scopedUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

describe.skipIf(!testUrl)("db reliability certification (real PostgreSQL)", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({
      connectionString: scopedUrl(testUrl!, schemaName),
      max: 2,
      connectionTimeoutMillis: 500,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  it("an exhausted pool times out with an error and recovers after release", async () => {
    const held = await Promise.all([pool.connect(), pool.connect()]);
    await expect(withTransaction(pool, async () => "unreachable")).rejects.toThrow(
      /timeout exceeded when trying to connect/i,
    );
    for (const client of held) client.release();
    // Recovery: the same pool serves transactions again — nothing leaked.
    await expect(
      withTransaction(pool, async (c) => (await c.query("SELECT 1 AS ok")).rows[0]),
    ).resolves.toEqual({ ok: 1 });
    expect(pool.waitingCount).toBe(0);
  });

  it("a throwing transaction body rolls back and releases its connection", async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS tx_cert_probe (id serial PRIMARY KEY, v text NOT NULL)",
    );
    await pool.query("DELETE FROM tx_cert_probe");
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO tx_cert_probe (v) VALUES ('should-roll-back')");
        throw new Error("injected failure");
      }),
    ).rejects.toThrow("injected failure");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM tx_cert_probe");
    expect(rows[0].n).toBe(0); // rolled back — no partial write
    // Connection was released: the 2-connection pool can still serve both.
    const a = await pool.connect();
    const b = await pool.connect();
    a.release();
    b.release();
    await pool.query("DROP TABLE tx_cert_probe");
  });

  it("a successful transaction commits atomically", async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS tx_cert_probe2 (id serial PRIMARY KEY, v text NOT NULL)",
    );
    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO tx_cert_probe2 (v) VALUES ('a')");
      await client.query("INSERT INTO tx_cert_probe2 (v) VALUES ('b')");
    });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM tx_cert_probe2");
    expect(rows[0].n).toBe(2);
    await pool.query("DROP TABLE tx_cert_probe2");
  });
});
