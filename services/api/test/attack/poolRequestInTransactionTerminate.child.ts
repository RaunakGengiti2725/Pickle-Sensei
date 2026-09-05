/**
 * ATTACK child (ADJ-04, real HTTP route): PostgreSQL terminates the backend of
 * a connection that a live request holds inside `withTransaction()`.
 *
 * A second session holds `LOCK TABLE app_user IN ACCESS EXCLUSIVE MODE` so the
 * route's first statement (`SELECT ... FROM app_user`) blocks deterministically;
 * the blocked backend is then `pg_terminate_backend`-ed (same signal a fast
 * shutdown / failover / idle_in_transaction_session_timeout sends).
 *
 * Expected (ADJ-04 "expected"): the request fails (5xx, ideally 503 retryable),
 * the process survives, the next request is served.
 *
 * Run: DATABASE_URL_TEST=... node --import tsx test/attack/poolRequestInTransactionTerminate.child.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { InMemoryJobQueue } from "@pickle/queue";
import { ApiSloRecorder } from "@pickle/slo";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";

const testUrl = process.env["DATABASE_URL_TEST"];
if (!testUrl) {
  console.error("DATABASE_URL_TEST required");
  process.exit(2);
}
const DEV_SECRET = "attack-request-in-tx-secret-0123456789";
const APP_NAME = `attack-request-in-tx-${process.pid}`;
const url = new URL(testUrl);
url.searchParams.set("application_name", APP_NAME);

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack-request-in-tx",
  databaseUrl: url.toString(),
  devAuthSecret: DEV_SECRET,
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sloRecorder = new ApiSloRecorder();
const app = buildApp(config, { queue: new InMemoryJobQueue(), sloRecorder });
await app.listen({ port: 0, host: "127.0.0.1" });
const pool = (app as typeof app & { appContext: AppContext }).appContext.pool!;
const token = await new DevTokenVerifier("test", DEV_SECRET).mint(
  `auth0|attack-request-in-tx-${randomUUID()}`,
);
const bootstrapPayload = {
  locale: "en-US",
  timezone: "America/Los_Angeles",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};
const inject = () =>
  app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    headers: { authorization: `Bearer ${token}` },
    payload: bootstrapPayload,
  });

const locker = new pg.Client({ connectionString: testUrl });
const admin = new pg.Client({ connectionString: testUrl });
await locker.connect();
await admin.connect();

await locker.query("BEGIN");
await locker.query("LOCK TABLE app_user IN ACCESS EXCLUSIVE MODE");
events.push("locker holds ACCESS EXCLUSIVE on app_user");

const pending = inject();

let blocked: { pid: number; state: string; wait_event_type: string | null } | undefined;
for (let i = 0; i < 100 && !blocked; i++) {
  const { rows } = await admin.query<{
    pid: number;
    state: string;
    wait_event_type: string | null;
  }>(
    `SELECT pid, state, wait_event_type FROM pg_stat_activity
       WHERE application_name = $1 AND wait_event_type = 'Lock'`,
    [APP_NAME],
  );
  blocked = rows[0];
  if (!blocked) await sleep(50);
}
if (!blocked) {
  events.push("route never blocked on the lock");
  await locker.query("ROLLBACK");
  process.exit(3);
}
events.push(
  `route backend pid=${blocked.pid} state=${blocked.state} pool=${pool.totalCount}/${pool.idleCount}`,
);

await admin.query("SELECT pg_terminate_backend($1)", [blocked.pid]);
events.push("terminated route backend");
await locker.query("ROLLBACK");

const first = await pending;
events.push(`first request status=${first.statusCode} body=${first.body.slice(0, 200)}`);
await sleep(300);
const second = await inject();
events.push(`second request status=${second.statusCode}`);

await locker.end();
await admin.end();
await app.close();
console.log(
  JSON.stringify({
    survived: true,
    firstStatus: first.statusCode,
    secondStatus: second.statusCode,
    events,
  }),
);
process.exit(0);
