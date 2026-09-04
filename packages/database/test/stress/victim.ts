import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

/**
 * Child-process runner used by the `kill_mid_migration` stress action.
 *
 * It runs `runMigrations(pool, dir)` exactly like `src/cli.ts migrate` does
 * (one pg.Pool, no extra listeners) so that the parent can terminate its
 * backends mid-run and observe how the runner settles WITHOUT the outcome
 * taking down the parent process:
 *
 *   exit 0 + `{"ok":true,...}`    the run fulfilled
 *   exit 3 + `{"ok":false,...}`   the run rejected (a clean, catchable error)
 *   anything else                 the runner crashed (e.g. an unhandled
 *                                 'error' event on a checked-out client)
 *
 * argv: <connectionString> <migrationsDir> <applicationName>
 */
const [connectionString, dir, appName] = process.argv.slice(2);
if (!connectionString || !dir || !appName) {
  console.error("usage: victim.ts <connectionString> <migrationsDir> <applicationName>");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString, max: 4, application_name: appName });
let poolErrors = 0;
pool.on("error", () => {
  poolErrors++;
});

try {
  const result = await runMigrations(pool, dir);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, poolErrors })}\n`);
  await pool.end().catch(() => undefined);
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, poolErrors })}\n`);
  await pool.end().catch(() => undefined);
  process.exit(3);
}
