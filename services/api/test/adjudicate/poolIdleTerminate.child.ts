import { Writable } from "node:stream";
import pg from "pg";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";

/**
 * ADJ-04 attack, run as a REAL process (not inside a test runner): warm the
 * pool so it holds one idle backend, terminate that backend from a second
 * connection with `pg_terminate_backend`, then prove the API process is
 * still alive 2s later, that the next /v1/health request is served, and that
 * the pool error went through the Fastify logger.
 *
 *   cd services/api && DATABASE_URL_TEST=… node --import tsx test/adjudicate/poolIdleTerminate.child.ts
 *
 * Exit 0 with `survived:true` on stdout is the only pass. Exit 1 with
 * `survived:false uncaughtException:<message>` is the crash the defect
 * describes; exit 2 means the attack could not be staged (no database).
 */

const ADMIN_TERMINATE_MESSAGE = "terminating connection due to administrator command";
const SURVIVE_WINDOW_MS = 2000;

const databaseUrl = process.env["DATABASE_URL_TEST"];
if (!databaseUrl) {
  process.stdout.write("staged:false reason:DATABASE_URL_TEST_unset\n");
  process.exit(2);
}

const logLines: string[] = [];
const captureLog = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    const text = chunk.toString();
    logLines.push(text);
    process.stderr.write(text);
    callback();
  },
});

process.on("uncaughtException", (error) => {
  process.stdout.write(`survived:false uncaughtException:${error.message}\n`);
  process.exit(1);
});

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-adjudicate",
  databaseUrl,
  devAuthSecret: "adjudicate-pool-secret-0123456789",
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
};

const app = buildApp(config, {
  queue: new InMemoryJobQueue(),
  logger: { level: "info", stream: captureLog },
});
const pool = app.appContext.pool;
if (!pool) throw new Error("buildApp produced no pool although databaseUrl was set");

const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

const warm = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
const pid = warm.rows[0]?.pid;
if (pid === undefined) throw new Error("pg_backend_pid() returned no row");
process.stdout.write(`warm:${pid} pool=${pool.totalCount}/${pool.idleCount}\n`);

const attacker = new pg.Client({ connectionString: databaseUrl });
await attacker.connect();
const state = await attacker.query<{ state: string | null }>(
  "SELECT state FROM pg_stat_activity WHERE pid = $1",
  [pid],
);
process.stdout.write(`backend state:${state.rows[0]?.state ?? "gone"}\n`);
const terminated = await attacker.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [
  pid,
]);
process.stdout.write(`pg_terminate_backend:${terminated.rows[0]?.ok ?? false}\n`);
await attacker.end();

await new Promise((resolve) => setTimeout(resolve, SURVIVE_WINDOW_MS));

const health = await fetch(`${baseUrl}/v1/health`);
const healthStatus = health.status;
const logged = logLines.some((line) => line.includes(ADMIN_TERMINATE_MESSAGE));

process.stdout.write(
  `after:${SURVIVE_WINDOW_MS}ms pool=${pool.totalCount}/${pool.idleCount} health:${healthStatus} logged:${logged}\n`,
);

await app.close();

const survived = (healthStatus === 200 || healthStatus === 503) && logged;
process.stdout.write(`survived:${survived}\n`);
process.exit(survived ? 0 : 1);
