/**
 * Child process for poolIdleTerminate.integration.test.ts: does the Fastify
 * API survive PostgreSQL terminating an IDLE pooled connection (what a server
 * restart, failover, or server-side idle timeout does to every idle client)?
 *
 * Mirrors src/server.ts (buildApp + listen, no extra process-level handlers).
 * Runs with env "development" so the Fastify/pino logger writes JSON lines to
 * stdout; the parent asserts the pg error is logged there. A crash (unhandled
 * 'error' event on the idle pg.Client) exits non-zero before the final
 * `{"survived":true,...}` line.
 *
 * Run: DATABASE_URL_TEST=... node --import tsx test/support/poolIdleTerminate.child.ts
 */
import pg from "pg";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";

const testUrl = process.env["DATABASE_URL_TEST"];
if (!testUrl) {
  console.error("DATABASE_URL_TEST required");
  process.exit(2);
}
const APP_NAME = `pool-idle-terminate-${process.pid}`;
const url = new URL(testUrl);
url.searchParams.set("application_name", APP_NAME);

const config: ApiConfig = {
  env: "development",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-pool-idle-terminate",
  databaseUrl: url.toString(),
  devAuthSecret: "pool-idle-terminate-secret-0123456789",
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
  adminAuthSubjects: [],
};

const events: string[] = [];
process.on("exit", (code) => {
  process.stderr.write(`child exit code=${code} events=${JSON.stringify(events)}\n`);
});

const app = buildApp(config, { queue: new InMemoryJobQueue() });
await app.listen({ port: 0, host: "127.0.0.1" });
const pool = (app as typeof app & { appContext: AppContext }).appContext.pool!;

// Warm exactly one pooled client and return it to the pool idle.
await pool.query("SELECT 1");
events.push(`warm pool=${pool.totalCount}/${pool.idleCount}`);

const admin = new pg.Client({ connectionString: testUrl });
await admin.connect();
const { rows } = await admin.query<{ pid: number; state: string }>(
  "SELECT pid, state FROM pg_stat_activity WHERE application_name = $1",
  [APP_NAME],
);
events.push(`backends:${JSON.stringify(rows)}`);
await admin.query(
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
  [APP_NAME],
);
await new Promise((r) => setTimeout(r, 2000));
events.push(`after-terminate pool=${pool.totalCount}/${pool.idleCount}`);

const health = await app.inject({ method: "GET", url: "/v1/health" });
events.push(`health:${health.statusCode}`);
await admin.end();
await app.close();
console.log(
  JSON.stringify({ survived: true, healthStatus: health.statusCode, backends: rows, events }),
);
process.exit(0);
