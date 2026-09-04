import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { checksumOf, loadMigrations, runMigrations } from "../../src/migrate.js";

/**
 * Adversarial pass 3 — S5: history tampering.
 *
 * A TEMP COPY of packages/database/migrations is applied to a fresh schema,
 * then one byte of an already-applied migration is flipped in the copy and a
 * brand-new migration is appended. runMigrations must throw the
 * checksum-mismatch error and apply NOTHING new (the appended migration must
 * not run, schema_migrations must be byte-for-byte unchanged).
 *
 * The repository's committed migrations are never touched. Skipped visibly
 * without DATABASE_URL_TEST.
 */
const testUrl = process.env["DATABASE_URL_TEST"];
const realMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

describe.skipIf(!testUrl)("attack pass 3: modified applied migration", () => {
  let pool: pg.Pool;
  let tmpDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    tmpDir = mkdtempSync(join(tmpdir(), "attack3-migrations-"));
    cpSync(realMigrationsDir, tmpDir, { recursive: true });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  });

  afterAll(async () => {
    await pool?.end();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function appliedRows(): Promise<Array<{ name: string; checksum: string }>> {
    const { rows } = await pool.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    return rows;
  }

  async function publicTableNames(): Promise<string[]> {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    return rows.map((r) => r.table_name);
  }

  it("applies the pristine copy, then refuses after a one-byte edit and applies nothing new", async () => {
    const first = await runMigrations(pool, tmpDir);
    expect(first.applied.length).toBeGreaterThanOrEqual(6);
    const appliedBefore = await appliedRows();
    const tablesBefore = await publicTableNames();
    expect(appliedBefore.map((r) => r.name)).toEqual(first.applied);

    // Pick a deterministic already-applied file (the middle one) and flip ONE
    // byte inside a SQL comment-safe position: replace the first ';' with ' '.
    // (Changing whitespace is exactly the "harmless-looking" edit a human makes.)
    const names = readdirSync(tmpDir)
      .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
      .sort();
    const victim = names[Math.floor(names.length / 2)]!;
    const victimPath = join(tmpDir, victim);
    const original = readFileSync(victimPath, "utf8");
    const idx = original.indexOf(";");
    expect(idx).toBeGreaterThan(-1);
    const tampered = `${original.slice(0, idx)} ${original.slice(idx + 1)}`;
    expect(tampered.length).toBe(original.length);
    expect(checksumOf(tampered)).not.toBe(checksumOf(original));
    writeFileSync(victimPath, tampered);

    // Append a NEW migration that would leave a visible mark if it ran.
    const newName = "9998_attack3_should_not_apply.sql";
    writeFileSync(join(tmpDir, newName), "CREATE TABLE attack3_marker (id int PRIMARY KEY);\n");
    const files = await loadMigrations(tmpDir);
    expect(files.at(-1)?.name).toBe(newName);

    await expect(runMigrations(pool, tmpDir)).rejects.toThrow(
      `Migration ${victim} was modified after being applied (checksum mismatch). ` +
        "Write a new migration instead of editing history.",
    );

    // Nothing new applied: ledger identical, no marker table, table set identical.
    expect(await appliedRows()).toEqual(appliedBefore);
    expect(await publicTableNames()).toEqual(tablesBefore);
    expect((await publicTableNames()).includes("attack3_marker")).toBe(false);

    // Rapid repeat: the refusal is stable, not a one-shot.
    for (let i = 0; i < 5; i++) {
      await expect(runMigrations(pool, tmpDir)).rejects.toThrow(/checksum mismatch/);
    }
    expect(await appliedRows()).toEqual(appliedBefore);

    // Restoring the byte heals the ledger check and lets the new migration apply.
    writeFileSync(victimPath, original);
    const healed = await runMigrations(pool, tmpDir);
    expect(healed.applied).toEqual([newName]);
    expect((await publicTableNames()).includes("attack3_marker")).toBe(true);
  }, 120_000);

  it("a tampered LAST applied migration is also refused (not only middle files)", async () => {
    const names = readdirSync(tmpDir)
      .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
      .sort();
    const last = names.at(-1)!;
    const path = join(tmpDir, last);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}\n-- 1 extra byte\n`);
    try {
      await expect(runMigrations(pool, tmpDir)).rejects.toThrow(
        `Migration ${last} was modified after being applied (checksum mismatch)`,
      );
    } finally {
      writeFileSync(path, original);
    }
    expect((await runMigrations(pool, tmpDir)).applied).toEqual([]);
  }, 60_000);

  it("a malformed filename dropped into the directory is ignored, not executed", async () => {
    const rogue = join(tmpDir, "9999_Rogue-Upper.SQL");
    writeFileSync(rogue, "CREATE TABLE attack3_rogue (id int);\n");
    try {
      const result = await runMigrations(pool, tmpDir);
      expect(result.applied).toEqual([]);
      expect((await publicTableNames()).includes("attack3_rogue")).toBe(false);
    } finally {
      rmSync(rogue, { force: true });
    }
  });
});
