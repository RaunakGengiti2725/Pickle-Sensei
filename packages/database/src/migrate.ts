import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

/**
 * Minimal, deterministic migration runner (DECISIONS D-006):
 * ordered NNNN_name.sql files, one transaction per file, checksum verification
 * so an already-applied file can never silently change.
 */

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function orderMigrations(names: string[]): string[] {
  const valid = names.filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n));
  return [...valid].sort();
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const names = orderMigrations(await readdir(dir));
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), "utf8");
    files.push({ name, sql, checksum: checksumOf(sql) });
  }
  return files;
}

/**
 * Advisory lock key serializing concurrent migration runners against the same
 * database: statements like CREATE EXTENSION IF NOT EXISTS are not safe to run
 * from two sessions at once (both can pass the IF NOT EXISTS check and one
 * then fails with a duplicate-key error on pg_extension).
 */
export const MIGRATION_LOCK_KEY = 0x7069636b; // "pick"

export async function runMigrations(
  pool: Pool,
  dir: string,
  log: (line: string) => void = () => {},
): Promise<{ applied: string[]; skipped: string[] }> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    return await runMigrationsLocked(pool, dir, log);
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      lockClient.release();
    }
  }
}

async function runMigrationsLocked(
  pool: Pool,
  dir: string,
  log: (line: string) => void,
): Promise<{ applied: string[]; skipped: string[] }> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = await loadMigrations(dir);
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const appliedByName = new Map(rows.map((r) => [r.name, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const existing = appliedByName.get(file.name);
    if (existing !== undefined) {
      if (existing !== file.checksum) {
        throw new Error(
          `Migration ${file.name} was modified after being applied (checksum mismatch). ` +
            "Write a new migration instead of editing history.",
        );
      }
      skipped.push(file.name);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(file.sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        file.name,
        file.checksum,
      ]);
      await client.query("COMMIT");
      applied.push(file.name);
      log(`applied ${file.name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file.name} failed: ${String(error)}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}
