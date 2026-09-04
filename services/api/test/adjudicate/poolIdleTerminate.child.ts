/**
 * ADJUDICATION child process: does the legacy Fastify API survive the
 * termination of an IDLE pooled Postgres connection (what a Postgres restart,
 * failover, or server-side idle timeout does to every idle client)?
 *
 * Mirrors src/server.ts: buildApp() + no process-level error handler. A crash
 * (unhandled 'error' event on the idle pg.Client) exits non-zero before the
 * final JSON line; survival exits 0 with `{"survived":true}`.
 *
 * Run: DATABASE_URL_TEST=... node --import tsx test/adjudicate/poolIdleTerminate.child.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";

const testUrl = process.env["DATABASE_URL_TEST"];
if (!testUrl) {
  console.error("DATABASE_URL_TEST required");
  process.exit(2);
}
const APP_NAME = `adjudicate-idle-${process.pid}`;
const SECRET = "adjudicate-secret-0123456789abcdef";
const url = new URL(testUrl);
url.searchParams.set("application_name", APP_NAME);

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-adjudicate",
  databaseUrl: url.toString(),
  devAuthSecret: SECRET,
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
const token = await new DevTokenVerifier("test", SECRET).mint(`adjudicate-idle|${randomUUID()}`);
const auth = { authorization: `Bearer ${token}` };

// Warm exactly one pooled client (401 auth.no_account — but it hit the DB).
const warm = await app.inject({ method: "GET", url: "/v1/me", headers: auth });
events.push(`warm:${warm.statusCode} pool=${pool.totalCount}/${pool.idleCount}`);

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
await new Promise((r) => setTimeout(r, 1000));
events.push(`after-terminate pool=${pool.totalCount}/${pool.idleCount}`);

const next = await app.inject({ method: "GET", url: "/v1/me", headers: auth });
events.push(`next:${next.statusCode}`);
await admin.end();
await app.close();
console.log(JSON.stringify({ survived: true, nextStatus: next.statusCode, events }));
process.exit(0);
