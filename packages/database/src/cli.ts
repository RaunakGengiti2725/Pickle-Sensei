import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations } from "./migrate.js";
import { seed } from "./seed.js";

const command = process.argv[2];
const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  console.error("DATABASE_URL is not set. See docs/LOCAL_DEVELOPMENT.md.");
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  if (command === "migrate") {
    const { applied, skipped } = await runMigrations(pool, migrationsDir, console.log);
    console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`);
  } else if (command === "seed") {
    await seed(pool, console.log);
    console.log("seed complete");
  } else {
    console.error(`Unknown command: ${command ?? "(none)"}. Use migrate | seed.`);
    process.exit(1);
  }
} finally {
  await pool.end();
}
