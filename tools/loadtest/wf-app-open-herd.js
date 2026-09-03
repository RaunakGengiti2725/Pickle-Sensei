// App-open thundering herd: N DISTINCT signed-in users open the app at the
// same instant. Each open replays exactly what apps/mobile does on a signed-in
// cold start (authStore.establishSyncedAccount → HomeScreen.load →
// PlayerRankBanner):
//
//   POST /v1/account/bootstrap   GET /v1/me/access
//   GET  /v1/progress            GET /v1/rank
//
// Run against the real edge function served locally by Deno with the stub
// Supabase from supabase/functions/api/__wf__/supabase_stub.ts:
//
//   deno run --node-modules-dir=none --allow-net --allow-env \
//     supabase/functions/api/__wf__/supabase_stub.ts &
//   SUPABASE_URL=http://127.0.0.1:54399 SUPABASE_ANON_KEY=x \
//     deno run --node-modules-dir=none --allow-net --allow-env --allow-read \
//     supabase/functions/api/index.ts &
//   k6 run -e BASE_URL=http://127.0.0.1:8000 -e STUB_URL=http://127.0.0.1:54399 \
//     -e USERS=200 tools/loadtest/wf-app-open-herd.js
//
// What it measures (printed at the end and asserted as checks):
//   * Supabase Auth /auth/v1/token exchanges issued by the function — one per
//     distinct user, i.e. the auth cache gives NO cross-user amortization, so
//     an N-user herd costs N exchanges against Supabase Auth's per-IP token
//     limit (1800/h, burst 30) from the function's egress IP.
//   * DB queries per app open (6 today: profiles, access_state rpc,
//     progress_daily, practice_days, player_technique_rating, player_rank_state).
//
// Each VU presents its own X-Forwarded-For so the function's per-IP budget
// sees N devices, not one load generator. Only synthetic users are used.
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import encoding from "k6/encoding";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Set -e BASE_URL=http://127.0.0.1:8000");
const STUB_URL = __ENV.STUB_URL || "";
const USERS = Number(__ENV.USERS || 100);
const AUTH_TOKEN_LIMIT_PER_HOUR = 1800; // supabase.com/docs/guides/auth/rate-limits

const serverErrors = new Rate("server_errors");
const openLatency = new Trend("app_open_latency", true);
const rateLimited = new Counter("rate_limited");

export const options = {
  scenarios: {
    herd: {
      executor: "per-vu-iterations",
      vus: USERS,
      iterations: 1,
      maxDuration: "2m",
    },
  },
  thresholds: {
    server_errors: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

function b64url(value) {
  return encoding.b64encode(value, "rawurl");
}

/** Structurally valid Google-issuer ID token the stub accepts (sub=user-<n>). */
function tokenFor(n) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "wf", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub: `user-${n}`,
      aud: "wf-audience",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.wf-signature`;
}

function ipFor(n) {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export function setup() {
  if (STUB_URL) http.post(`${STUB_URL}/__stub/reset`);
  return {};
}

export default function () {
  const n = __VU;
  const headers = {
    Authorization: `Bearer ${tokenFor(n)}`,
    "Content-Type": "application/json",
    "X-Forwarded-For": ipFor(n),
  };
  const started = Date.now();
  const bootstrap = http.post(`${BASE_URL}/v1/account/bootstrap`, "{}", { headers });
  const access = http.get(`${BASE_URL}/v1/me/access`, { headers });
  const reads = http.batch([
    ["GET", `${BASE_URL}/v1/progress`, null, { headers }],
    ["GET", `${BASE_URL}/v1/rank`, null, { headers }],
  ]);
  openLatency.add(Date.now() - started);
  for (const res of [bootstrap, access, ...reads]) {
    serverErrors.add(res.status >= 500);
    if (res.status === 429) rateLimited.add(1);
    check(res, {
      "app-open request is 2xx or 429": (r) =>
        (r.status >= 200 && r.status < 300) || r.status === 429,
      "401 never happens for a valid token": (r) => r.status !== 401,
    });
  }
}

export function teardown() {
  if (!STUB_URL) return;
  const stats = http.get(`${STUB_URL}/__stub/stats`).json();
  const exchanges = Number(stats["auth:/auth/v1/token"] || 0);
  const dbQueries = Object.keys(stats)
    .filter((k) => k.startsWith("db:"))
    .reduce((sum, k) => sum + Number(stats[k]), 0);
  const hoursToServeHerd = exchanges / AUTH_TOKEN_LIMIT_PER_HOUR;
  console.log(
    `[wf-app-open-herd] users=${USERS} auth_exchanges=${exchanges} ` +
      `db_queries=${dbQueries} (${(dbQueries / USERS).toFixed(1)} per open); ` +
      `at ${AUTH_TOKEN_LIMIT_PER_HOUR}/h per egress IP this herd needs ` +
      `${hoursToServeHerd.toFixed(2)} h of Supabase Auth token budget`,
  );
  console.log(`[wf-app-open-herd] upstream calls: ${JSON.stringify(stats)}`);
  check(stats, {
    "one Supabase Auth exchange per distinct user (no cross-user amortization)": () =>
      exchanges === USERS,
    "six DB queries per app open": () => dbQueries === USERS * 6,
  });
}
