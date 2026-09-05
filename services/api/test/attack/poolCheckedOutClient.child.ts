/**
 * ATTACK child (ADJ-04 neighbourhood): PostgreSQL closing a pooled connection
 * that is CHECKED OUT (src/lib/db.ts withTransaction → pool.connect()).
 *
 * The fix's `pool.on("error")` only receives errors from clients that are
 * checked IN (pg-pool removes its idleListener at checkout and `pool.connect()`
 * hands the bare pg.Client to the caller). A checked-out client that loses its
 * connection emits 'error' on itself:
 *   - FATAL 57P01 while no statement is active ('idle in transaction'):
 *     pg Client._handleErrorMessage → _handleErrorEvent → emit('error')
 *   - socket closed without a FATAL (crash, SIGKILL, network drop) while a
 *     statement IS active: Client's 'end' handler errors the active query on
 *     nextTick, then synchronously sees `!_ending` and emits 'error'
 * With no listener either is an unhandled 'error' event → process exit 1.
 *
 * The pool is routed through a local TCP proxy so the abrupt-close scenarios
 * are deterministic (socket.destroy() with no FATAL) and need no docker access.
 *
 * SCENARIO (env):
 *   idle_in_tx_fatal   — withTransaction holding, pg_terminate_backend (FATAL 57P01)
 *   idle_in_tx_abrupt  — withTransaction holding, proxy destroys the socket
 *   active_in_tx_fatal — withTransaction running `pg_sleep`, pg_terminate_backend (FATAL 57P01)
 *   active_in_tx_abrupt— withTransaction running `pg_sleep`, proxy destroys the socket
 *   active_pool_query_abrupt — pool.query running `pg_sleep`, proxy destroys (control: pg-pool guards this)
 *   idle_in_pool_abrupt — checked-in idle client, proxy destroys (control: the fix guards this)
 *
 * Run: SCENARIO=idle_in_tx_fatal DATABASE_URL_TEST=... node --import tsx test/attack/poolCheckedOutClient.child.ts
 * Expected (fixed): exit 0, last stdout line `{"survived":true,...}` for every scenario.
 */
import net from "node:net";
import pg from "pg";
import { InMemoryJobQueue } from "@pickle/queue";
import { ApiSloRecorder } from "@pickle/slo";
import { buildApp } from "../../src/app.js";
import { withTransaction } from "../../src/lib/db.js";
import type { ApiConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";

const SCENARIOS = [
  "idle_in_tx_fatal",
  "idle_in_tx_abrupt",
  "active_in_tx_fatal",
  "active_in_tx_abrupt",
  "active_pool_query_abrupt",
  "idle_in_pool_abrupt",
] as const;
type Scenario = (typeof SCENARIOS)[number];

const testUrl = process.env["DATABASE_URL_TEST"];
const scenario = process.env["SCENARIO"] as Scenario | undefined;
if (!testUrl || !scenario || !SCENARIOS.includes(scenario)) {
  console.error(`DATABASE_URL_TEST and SCENARIO (${SCENARIOS.join("|")}) required`);
  process.exit(2);
}
const HOLD_MS = 1500;
const APP_NAME = `attack-checked-out-${scenario}-${process.pid}`;

// --- TCP proxy in front of Postgres -----------------------------------------
const target = new URL(testUrl);
const upstreamSockets = new Set<net.Socket>();
const proxy = net.createServer((downstream) => {
  const upstream = net.connect(Number(target.port || 5432), target.hostname);
  upstreamSockets.add(downstream);
  downstream.pipe(upstream);
  upstream.pipe(downstream);
  const drop = () => {
    upstreamSockets.delete(downstream);
    downstream.destroy();
    upstream.destroy();
  };
  downstream.on("close", drop);
  upstream.on("close", drop);
  downstream.on("error", drop);
  upstream.on("error", drop);
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = (proxy.address() as net.AddressInfo).port;
function dropAllProxiedConnections(): number {
  const n = upstreamSockets.size;
  for (const s of upstreamSockets) s.destroy();
  return n;
}

const poolUrl = new URL(testUrl);
poolUrl.hostname = "127.0.0.1";
poolUrl.port = String(proxyPort);
poolUrl.searchParams.set("application_name", APP_NAME);

const config: ApiConfig = {
  env: "development",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack-checked-out",
  databaseUrl: poolUrl.toString(),
  devAuthSecret: "attack-checked-out-secret-0123456789",
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
  process.stderr.write(
    `child exit code=${code} scenario=${scenario} events=${JSON.stringify(events)}\n`,
  );
});

const sloRecorder = new ApiSloRecorder();
const app = buildApp(config, { queue: new InMemoryJobQueue(), sloRecorder });
await app.listen({ port: 0, host: "127.0.0.1" });
const pool = (app as typeof app & { appContext: AppContext }).appContext.pool!;
const admin = new pg.Client({ connectionString: testUrl });
await admin.connect();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const describeError = (error: unknown) =>
  error instanceof Error
    ? `${error.message} code=${(error as { code?: string }).code}`
    : String(error);

async function backendStates(): Promise<Array<{ pid: number; state: string }>> {
  const { rows } = await admin.query<{ pid: number; state: string }>(
    "SELECT pid, state FROM pg_stat_activity WHERE application_name = $1",
    [APP_NAME],
  );
  return rows;
}

let work: Promise<unknown>;
let workError: string | null = null;
const capture = (p: Promise<unknown>) =>
  p.catch((error: unknown) => {
    workError = describeError(error);
    events.push(`work-rejected:${workError}`);
  });

switch (scenario) {
  case "idle_in_tx_fatal":
  case "idle_in_tx_abrupt":
    work = capture(
      withTransaction(pool, async (client) => {
        await client.query("SELECT 1");
        events.push(`in-tx pool=${pool.totalCount}/${pool.idleCount}`);
        await sleep(HOLD_MS);
        await client.query("SELECT 2");
      }),
    );
    break;
  case "active_in_tx_fatal":
  case "active_in_tx_abrupt":
    work = capture(
      withTransaction(pool, async (client) => {
        events.push(`in-tx pool=${pool.totalCount}/${pool.idleCount}`);
        await client.query("SELECT pg_sleep($1)", [HOLD_MS / 1000]);
      }),
    );
    break;
  case "active_pool_query_abrupt":
    work = capture(pool.query("SELECT pg_sleep($1)", [HOLD_MS / 1000]));
    break;
  case "idle_in_pool_abrupt":
    await pool.query("SELECT 1");
    work = Promise.resolve();
    break;
}

await sleep(400);
const before = await backendStates();
events.push(`backends:${JSON.stringify(before)}`);
if (scenario === "idle_in_tx_fatal" || scenario === "active_in_tx_fatal") {
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
    [APP_NAME],
  );
  events.push("terminated-via-pg_terminate_backend");
} else {
  events.push(`dropped-proxied-connections:${dropAllProxiedConnections()}`);
}
await work;
await sleep(500);
events.push(`after pool=${pool.totalCount}/${pool.idleCount}`);

const health = await app.inject({ method: "GET", url: "/v1/health" });
events.push(`health:${health.statusCode}`);
const probe = await pool.query<{ ok: number }>("SELECT 1 AS ok");
events.push(`reconnect pool=${pool.totalCount}/${pool.idleCount}`);
await admin.end();
await app.close();
proxy.close();
console.log(
  JSON.stringify({
    survived: true,
    scenario,
    healthStatus: health.statusCode,
    dbRecovered: probe.rows[0]?.ok === 1,
    workError,
    backendsBefore: before,
    events,
  }),
);
process.exit(0);
