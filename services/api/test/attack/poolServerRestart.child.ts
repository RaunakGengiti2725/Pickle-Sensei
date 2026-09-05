/**
 * ATTACK child (ADJ-04, real server lifecycle): warm IDLE_CLIENTS pooled
 * connections, optionally hold one transaction (withTransaction, HOLD_TX=1),
 * then run ACTION_CMD (e.g. `docker restart <postgres_test container>` or
 * `docker kill -s KILL ...; docker start ...`) and check that the API process
 * survives and reconnects once the server is back.
 *
 * Run: IDLE_CLIENTS=5 HOLD_TX=0 ACTION_CMD='docker restart pickle-sensei-postgres_test-1' \
 *      DATABASE_URL_TEST=... node --import tsx test/attack/poolServerRestart.child.ts
 */
import { execSync } from "node:child_process";
import { InMemoryJobQueue } from "@pickle/queue";
import { ApiSloRecorder } from "@pickle/slo";
import { buildApp } from "../../src/app.js";
import { withTransaction } from "../../src/lib/db.js";
import type { ApiConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";

const testUrl = process.env["DATABASE_URL_TEST"];
const actionCmd = process.env["ACTION_CMD"];
if (!testUrl || !actionCmd) {
  console.error("DATABASE_URL_TEST and ACTION_CMD required");
  process.exit(2);
}
const idleClients = Number(process.env["IDLE_CLIENTS"] ?? "5");
const holdTx = process.env["HOLD_TX"] === "1";
const APP_NAME = `attack-restart-${process.pid}`;
const url = new URL(testUrl);
url.searchParams.set("application_name", APP_NAME);

const config: ApiConfig = {
  env: "development",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack-restart",
  databaseUrl: url.toString(),
  devAuthSecret: "attack-restart-secret-0123456789",
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

// Warm N idle connections at once (all checked out concurrently, then released).
await Promise.all(Array.from({ length: idleClients }, () => pool.query("SELECT pg_sleep(0.2)")));
events.push(`warm pool=${pool.totalCount}/${pool.idleCount}`);

let txError: string | null = null;
let tx: Promise<void> = Promise.resolve();
if (holdTx) {
  tx = withTransaction(pool, async (client) => {
    await client.query("SELECT 1");
    events.push(`in-tx pool=${pool.totalCount}/${pool.idleCount}`);
    await client.query("SELECT pg_sleep(8)");
  }).catch((error: unknown) => {
    txError = error instanceof Error ? error.message : String(error);
    events.push(`tx-rejected:${txError}`);
  });
  await sleep(300);
}

const t0 = Date.now();
execSync(actionCmd, { stdio: "inherit" });
events.push(`action-done ${Date.now() - t0}ms`);
await tx;
await sleep(1500);
events.push(`after-action pool=${pool.totalCount}/${pool.idleCount}`);
const sloPoolAfter = sloRecorder.snapshot().pool;

// Wait for the server to accept connections again (up to 30s).
let recovered = false;
let lastError: string | null = null;
for (let i = 0; i < 60 && !recovered; i++) {
  try {
    const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    recovered = rows[0]?.ok === 1;
  } catch (error) {
    lastError =
      error instanceof Error
        ? `${error.message} code=${(error as { code?: string }).code}`
        : String(error);
    await sleep(500);
  }
}
events.push(
  `recovered=${recovered} pool=${pool.totalCount}/${pool.idleCount} lastError=${lastError}`,
);
const health = await app.inject({ method: "GET", url: "/v1/health/slo" });
events.push(`health-slo:${health.statusCode}`);
await app.close();
console.log(
  JSON.stringify({
    survived: true,
    idleClients,
    holdTx,
    txError,
    sloPoolAfter,
    recovered,
    healthStatus: health.statusCode,
    events,
  }),
);
process.exit(0);
