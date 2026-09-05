/**
 * Attack variant of test/support/poolIdleTerminate.child.ts (ADJ-04): the
 * PostgreSQL backend is terminated while the pooled client is CHECKED OUT —
 * i.e. a request is in flight when the server restarts / fails over /
 * `pg_terminate_backend` fires. The `pool.on("error")` listener only sees
 * errors from IDLE clients (pg-pool's idleListener); a checked-out pg.Client
 * emits 'error' on itself and nothing in services/api listens for it.
 *
 * Two deterministic variants, selected with ATTACK_VARIANT:
 *   active-locked  (default) — a real route (POST /v1/account/bootstrap) runs
 *                  withTransaction and its SELECT blocks on an ACCESS EXCLUSIVE
 *                  lock held by a second real session; the backend is
 *                  terminated while `state = 'active'` waiting on the lock.
 *   idle-in-tx     — a client is checked out with an open transaction and no
 *                  statement running (`state = 'idle in transaction'`), exactly
 *                  what withTransaction looks like between two awaits.
 *
 * Mirrors src/server.ts (buildApp + listen, no extra process-level handlers).
 * Expected: the in-flight request fails (5xx), the process survives, and the
 * next request is served. Observed on f8f0412a: unhandled 'error' event, exit 1.
 *
 * Run: DATABASE_URL_TEST=... [ATTACK_VARIANT=idle-in-tx] \
 *      node --import tsx test/attack/support/poolCheckedOutTerminate.child.ts
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../../src/app.js";
import { DevTokenVerifier } from "../../../src/auth/tokens.js";
import type { ApiConfig } from "../../../src/config.js";
import type { AppContext } from "../../../src/context.js";

const testUrl = process.env["DATABASE_URL_TEST"];
if (!testUrl) {
  console.error("DATABASE_URL_TEST required");
  process.exit(2);
}
const variant = process.env["ATTACK_VARIANT"] ?? "active-locked";
const APP_NAME = `pool-checkedout-terminate-${process.pid}`;
const url = new URL(testUrl);
url.searchParams.set("application_name", APP_NAME);
const secret = "pool-checkedout-terminate-secret-0123456789";

const config: ApiConfig = {
  env: "development",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-pool-checkedout-terminate",
  databaseUrl: url.toString(),
  devAuthSecret: secret,
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

interface Backend {
  pid: number;
  state: string;
  wait_event_type: string | null;
}

const events: string[] = [];
process.on("exit", (code) => {
  process.stderr.write(
    `child exit code=${code} variant=${variant} events=${JSON.stringify(events)}\n`,
  );
});

const app = buildApp(config, { queue: new InMemoryJobQueue() });
await app.listen({ port: 0, host: "127.0.0.1" });
const pool = (app as typeof app & { appContext: AppContext }).appContext.pool!;
const token = await new DevTokenVerifier("development", secret).mint(`attack|${randomUUID()}`);

const admin = new pg.Client({ connectionString: testUrl });
await admin.connect();

async function findBackend(where: string): Promise<Backend | undefined> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await admin.query<Backend>(
      `SELECT pid, state, wait_event_type FROM pg_stat_activity
       WHERE application_name = $1 AND ${where}`,
      [APP_NAME],
    );
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

let inflight: Promise<{ statusCode: number }> | null = null;
let locker: pg.Client | null = null;
let checkedOut: pg.PoolClient | null = null;

if (variant === "idle-in-tx") {
  // Checked out with an open transaction, no statement running: what
  // withTransaction looks like between `BEGIN` and the callback's first query.
  checkedOut = await pool.connect();
  await checkedOut.query("BEGIN");
} else {
  locker = new pg.Client({ connectionString: testUrl });
  await locker.connect();
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE app_user IN ACCESS EXCLUSIVE MODE");
  events.push("locker holds ACCESS EXCLUSIVE on app_user");
  // Bootstrap runs withTransaction: BEGIN, then SELECT ... FROM app_user, which
  // blocks on the lock → the pooled client is checked out with a query in flight.
  inflight = app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      locale: "en-US",
      timezone: "UTC",
      device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
    },
  });
}

const backend = await findBackend(
  variant === "idle-in-tx" ? "state = 'idle in transaction'" : "wait_event_type = 'Lock'",
);
events.push(`backend:${JSON.stringify(backend)} pool=${pool.totalCount}/${pool.idleCount}`);
if (!backend) {
  console.error("precondition failed: no checked-out backend found");
  process.exit(3);
}
await admin.query("SELECT pg_terminate_backend($1)", [backend.pid]);
events.push("terminated");

let inflightStatus: number | null = null;
if (inflight) {
  inflightStatus = (await inflight).statusCode;
  events.push(`inflight:${inflightStatus}`);
}
await new Promise((r) => setTimeout(r, 2000));
events.push(`after-terminate pool=${pool.totalCount}/${pool.idleCount}`);
if (checkedOut) {
  try {
    await checkedOut.query("ROLLBACK");
  } catch (error) {
    events.push(`rollback failed: ${(error as Error).message}`);
  }
  checkedOut.release(true);
}
if (locker) await locker.query("ROLLBACK");

const health = await app.inject({ method: "GET", url: "/v1/health" });
const next = await app.inject({
  method: "GET",
  url: "/v1/progress",
  headers: { authorization: `Bearer ${token}` },
});
events.push(`health:${health.statusCode} next:${next.statusCode}`);
await admin.end();
if (locker) await locker.end();
await app.close();
console.log(
  JSON.stringify({
    survived: true,
    variant,
    inflightStatus,
    healthStatus: health.statusCode,
    nextStatus: next.statusCode,
    backend,
    events,
  }),
);
process.exit(0);
