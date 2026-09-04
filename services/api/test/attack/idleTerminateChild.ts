/**
 * Child process for the "idle pooled connection terminated" attack.
 *
 * Builds the real Fastify app against DATABASE_URL_TEST, warms exactly one
 * pooled client with an authenticated request, then (from a second
 * connection) runs pg_terminate_backend on that now-IDLE pooled backend —
 * what a Postgres restart / failover / idle-timeout does to every idle
 * connection. Prints a JSON line describing whether the process survived
 * and whether the next request succeeded. Exit code 0 = survived; a crash
 * (unhandled 'error' event) exits non-zero before the final line.
 *
 * Run: node --import tsx test/attack/idleTerminateChild.ts
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
const APP_NAME = `attack3-idle-${process.pid}`;
const SECRET = "attack-pass3-idle-secret-0123456789";

const url = new URL(testUrl);
url.searchParams.set("application_name", APP_NAME);

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack3",
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
};

const events: string[] = [];
if (!process.env["ATTACK_NO_HANDLER"]) {
  process.on("uncaughtException", (error) => {
    // Record what would have killed the process, then exit non-zero exactly as
    // the un-instrumented server would (server.ts installs no handler). Set
    // ATTACK_NO_HANDLER=1 to observe Node's default behaviour instead.
    events.push(`uncaughtException:${(error as Error).message}`);
    console.log(JSON.stringify({ survived: false, events }));
    process.exit(3);
  });
}

const app = buildApp(config, { queue: new InMemoryJobQueue() });
const pool = (app as typeof app & { appContext: AppContext }).appContext.pool!;
const token = await new DevTokenVerifier("test", SECRET).mint(`attack3-idle|${randomUUID()}`);
const auth = { authorization: `Bearer ${token}` };

// Warm: /v1/me → 401 auth.no_account (token valid, no account) — but it hit
// the database, so exactly one pooled client now sits idle.
const warm = await app.inject({ method: "GET", url: "/v1/me", headers: auth });
events.push(`warm:${warm.statusCode}:${pool.totalCount}/${pool.idleCount}`);

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
await new Promise((r) => setTimeout(r, 750));
events.push(`after-kill:${pool.totalCount}/${pool.idleCount}`);

const next = await app.inject({ method: "GET", url: "/v1/me", headers: auth });
events.push(
  `next:${next.statusCode}:${(next.json() as { error?: { code?: string } }).error?.code}`,
);
await admin.end();
await app.close();
console.log(JSON.stringify({ survived: true, nextStatus: next.statusCode, events }));
process.exit(0);
