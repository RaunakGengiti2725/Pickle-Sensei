import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

/**
 * Child-process runner for the adjudication replay of "terminated backend
 * mid-migration": runs `runMigrations` exactly like `src/cli.ts migrate`
 * (one pg.Pool, no extra client listeners).
 *   exit 0  fulfilled      exit 3  rejected cleanly      other  crashed
 * argv: <connectionString> <migrationsDir> <applicationName>
 */
const [connectionString, dir, appName] = process.argv.slice(2);
if (!connectionString || !dir || !appName) {
  console.error("usage: victim.ts <connectionString> <migrationsDir> <applicationName>");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString, application_name: appName });
pool.on("error", () => {});
try {
  const result = await runMigrations(pool, dir);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  await pool.end().catch(() => undefined);
  process.exit(0);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
  await pool.end().catch(() => undefined);
  process.exit(3);
}
