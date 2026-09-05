/**
 * ATTACK child (ADJ-04, server-side timeouts): the two operator settings the
 * fix's comment names — `idle_session_timeout` (FATAL 57P05 on a checked-in
 * idle client) and `idle_in_transaction_session_timeout` (FATAL 25P03 on a
 * client held open by `withTransaction()`).
 *
 * Both are applied per session with SET on the API's own connections via the
 * `options` connection parameter, so nothing about the database is altered.
 *
 * MODE=idle_session      — 3 idle pooled clients, wait for the timeout.
 *                          Expected: survive, three level-40 lines with pgCode 57P05.
 * MODE=idle_in_tx        — withTransaction holds a client past the timeout.
 *                          Expected: survive, the transaction rejects with 25P03,
 *                          next request served.
 *
 * Run: MODE=idle_in_tx DATABASE_URL_TEST=... node --import tsx test/attack/poolServerTimeouts.child.ts
 */
import { InMemoryJobQueue } from "@pickle/queue";
import { ApiSloRecorder } from "@pickle/slo";
import { buildApp } from "../../src/app.js";
import { withTransaction } from "../../src/lib/db.js";
import type { ApiConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";

const testUrl = process.env["DATABASE_URL_TEST"];
const mode = process.env["MODE"];
if (!testUrl || (mode !== "idle_session" && mode !== "idle_in_tx")) {
  console.error("DATABASE_URL_TEST and MODE=idle_session|idle_in_tx required");
  process.exit(2);
}
const TIMEOUT_MS = 700;
const setting =
  mode === "idle_session" ? "idle_session_timeout" : "idle_in_transaction_session_timeout";
const url = new URL(testUrl);
url.searchParams.set("options", `-c ${setting}=${TIMEOUT_MS}`);
url.searchParams.set("application_name", `attack-timeouts-${mode}-${process.pid}`);

const config: ApiConfig = {
  env: "development",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack-timeouts",
  databaseUrl: url.toString(),
  devAuthSecret: "attack-timeouts-secret-0123456789",
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
  process.stderr.write(`child exit code=${code} mode=${mode} events=${JSON.stringify(events)}\n`);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sloRecorder = new ApiSloRecorder();
const app = buildApp(config, { queue: new InMemoryJobQueue(), sloRecorder });
await app.listen({ port: 0, host: "127.0.0.1" });
const pool = (app as typeof app & { appContext: AppContext }).appContext.pool!;

let txError: string | null = null;
if (mode === "idle_session") {
  await Promise.all(Array.from({ length: 3 }, () => pool.query("SELECT pg_sleep(0.2)")));
  events.push(`warm pool=${pool.totalCount}/${pool.idleCount}`);
  await sleep(TIMEOUT_MS * 3);
} else {
  await withTransaction(pool, async (client) => {
    await client.query("SELECT 1");
    events.push(`in-tx pool=${pool.totalCount}/${pool.idleCount}`);
    await sleep(TIMEOUT_MS * 3);
    await client.query("SELECT 2");
  }).catch((error: unknown) => {
    txError =
      error instanceof Error
        ? `${error.message} code=${(error as { code?: string }).code}`
        : String(error);
    events.push(`tx-rejected:${txError}`);
  });
}
await sleep(200);
events.push(`after pool=${pool.totalCount}/${pool.idleCount}`);
const health = await app.inject({ method: "GET", url: "/v1/health" });
const probe = await pool.query<{ ok: number }>("SELECT 1 AS ok");
events.push(`reconnect pool=${pool.totalCount}/${pool.idleCount}`);
await app.close();
console.log(
  JSON.stringify({
    survived: true,
    mode,
    txError,
    healthStatus: health.statusCode,
    dbRecovered: probe.rows[0]?.ok === 1,
    events,
  }),
);
process.exit(0);
