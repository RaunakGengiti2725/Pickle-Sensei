/**
 * ATTACK child (ADJ-04, concurrency): a burst of authenticated GET /v1/me
 * requests (plain `pool.query`, no explicit transaction) while a second
 * session repeatedly terminates EVERY backend of the API's pool.
 *
 * Expected: the process survives; failed requests are 503 (retryable, the
 * datastore-unavailable class), never 500; once terminations stop, GET /v1/me
 * is 200 again and the pool refills.
 *
 * ROUTE_MODE=bootstrap sends the burst to POST /v1/account/bootstrap instead
 * (a `withTransaction()` route) — same expectation.
 *
 * Run: DATABASE_URL_TEST=... node --import tsx test/attack/poolConcurrentRequestsTerminate.child.ts
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
const DEV_SECRET = "attack-concurrent-secret-0123456789";
const APP_NAME = `attack-concurrent-${process.pid}`;
const BURSTS = Number(process.env["BURSTS"] ?? "4");
const CONCURRENCY = Number(process.env["CONCURRENCY"] ?? "30");
const ROUTE_MODE = process.env["ROUTE_MODE"] === "bootstrap" ? "bootstrap" : "me";
const url = new URL(testUrl);
url.searchParams.set("application_name", APP_NAME);

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack-concurrent",
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
  `auth0|attack-concurrent-${randomUUID()}`,
);
const auth = { authorization: `Bearer ${token}` };
const injectBootstrap = () =>
  app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    headers: auth,
    payload: {
      locale: "en-US",
      timezone: "America/Los_Angeles",
      device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
    },
  });
const injectBurstRequest = () =>
  ROUTE_MODE === "bootstrap"
    ? injectBootstrap()
    : app.inject({ method: "GET", url: "/v1/me", headers: auth });
const bootstrap = await injectBootstrap();
events.push(`bootstrap:${bootstrap.statusCode}`);

const admin = new pg.Client({ connectionString: testUrl });
await admin.connect();

const statusCounts = new Map<number, number>();
const bodies500: string[] = [];
let terminated = 0;
for (let burst = 0; burst < BURSTS; burst++) {
  const requests = Array.from({ length: CONCURRENCY }, () => injectBurstRequest());
  // Terminate everything the API has open, twice per burst, while requests run.
  for (let k = 0; k < 2; k++) {
    await sleep(15);
    const { rowCount } = await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [APP_NAME],
    );
    terminated += rowCount ?? 0;
  }
  const results = await Promise.all(requests);
  for (const res of results) {
    statusCounts.set(res.statusCode, (statusCounts.get(res.statusCode) ?? 0) + 1);
    if (res.statusCode >= 500 && res.statusCode !== 503) bodies500.push(res.body.slice(0, 300));
  }
  events.push(`burst${burst} pool=${pool.totalCount}/${pool.idleCount}/${pool.waitingCount}`);
}
await sleep(300);
const after = await app.inject({ method: "GET", url: "/v1/me", headers: auth });
const slo = await app.inject({ method: "GET", url: "/v1/health/slo" });
await admin.end();
await app.close();
console.log(
  JSON.stringify({
    survived: true,
    routeMode: ROUTE_MODE,
    terminated,
    statusCounts: Object.fromEntries(statusCounts),
    non503ServerErrors: bodies500.slice(0, 5),
    afterStatus: after.statusCode,
    sloStatus: slo.statusCode,
    events,
  }),
);
process.exit(0);
