import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { checksumOf, loadMigrations, orderMigrations, runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("migration runner (unit)", () => {
  it("orders migrations numerically and rejects malformed names", () => {
    const ordered = orderMigrations([
      "0002_catalog_scoring.sql",
      "0001_extensions_identity.sql",
      "notes.txt",
      "9999_zz.sql.bak",
    ]);
    expect(ordered).toEqual(["0001_extensions_identity.sql", "0002_catalog_scoring.sql"]);
  });

  it("checksums are stable and content-sensitive", () => {
    expect(checksumOf("CREATE TABLE a ();")).toBe(checksumOf("CREATE TABLE a ();"));
    expect(checksumOf("CREATE TABLE a ();")).not.toBe(checksumOf("CREATE TABLE b ();"));
  });

  it("loads the committed migration set in order", async () => {
    const files = await loadMigrations(migrationsDir);
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files[0]?.name).toBe("0001_extensions_identity.sql");
    for (const f of files) expect(f.checksum).toHaveLength(64);
  });
});

// Integration tests run only when a database is provided (DECISIONS D-009):
// they are SKIPPED — visibly, never green-washed — without DATABASE_URL_TEST.
const testUrl = process.env["DATABASE_URL_TEST"];
describe.skipIf(!testUrl)("migration runner (integration)", () => {
  it("applies all migrations and seeds on a fresh database, idempotently", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      const first = await runMigrations(pool, migrationsDir);
      expect(first.applied.length).toBeGreaterThanOrEqual(6);
      const second = await runMigrations(pool, migrationsDir);
      expect(second.applied).toHaveLength(0);
      await seed(pool);
      await seed(pool); // idempotent
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM shot_type");
      expect(rows[0]?.n).toBe(8);
      const { rows: sm } = await pool.query("SELECT count(*)::int AS n FROM scoring_model");
      expect(sm[0]?.n).toBe(8);
    } finally {
      await pool.end();
    }
  });
});
