// Rank/progress cache stampede for ONE user: N requests for the same user's
// GET /v1/rank and GET /v1/progress arrive while the 60s response cache is
// cold. The function caches AFTER the DB reads complete and does not coalesce
// concurrent misses, so every request in the miss window pays the full DB
// fan-out (2 queries per route) instead of the 2+2 a coalesced miss would.
//
// The mobile app produces exactly this shape: HomeScreen.load() fires
// /v1/progress on every focus while PlayerRankBanner (and PlayerRankCard on
// Progress) fire /v1/rank from their own effects — and the cache is
// invalidated on every accepted shot sync (index.ts cacheDel), so the miss
// window reopens right after each practice sync.
//
//   k6 run -e BASE_URL=http://127.0.0.1:8000 -e STUB_URL=http://127.0.0.1:54399 \
//     -e CONCURRENCY=40 tools/loadtest/wf-cache-stampede.js
//
// Prints db_queries_per_route; a coalesced implementation would report 2.
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";
import encoding from "k6/encoding";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Set -e BASE_URL=http://127.0.0.1:8000");
const STUB_URL = __ENV.STUB_URL || "";
const CONCURRENCY = Number(__ENV.CONCURRENCY || 40);

const serverErrors = new Rate("server_errors");
const readLatency = new Trend("read_latency", true);

export const options = {
  scenarios: {
    stampede: {
      executor: "per-vu-iterations",
      vus: CONCURRENCY,
      iterations: 1,
      maxDuration: "1m",
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

const TOKEN = (() => {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "wf", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub: "user-777",
      aud: "wf-audience",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.wf-signature`;
})();

function headersFor(vu) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "X-Forwarded-For": `10.77.${(vu >> 8) & 255}.${vu & 255}`,
  };
}

export function setup() {
  // Warm the auth cache so the stampede measures the response cache only,
  // then zero the upstream counters. The rank/progress cache is still cold.
  const warm = http.post(`${BASE_URL}/v1/account/bootstrap`, "{}", { headers: headersFor(0) });
  if (warm.status !== 200) throw new Error(`warm-up bootstrap failed: ${warm.status}`);
  if (STUB_URL) http.post(`${STUB_URL}/__stub/reset`);
  return {};
}

export default function () {
  const headers = headersFor(__VU);
  const reads = http.batch([
    ["GET", `${BASE_URL}/v1/rank`, null, { headers }],
    ["GET", `${BASE_URL}/v1/progress`, null, { headers }],
  ]);
  for (const res of reads) {
    readLatency.add(res.timings.duration);
    serverErrors.add(res.status >= 500);
    check(res, {
      "read is 2xx or 429": (r) => (r.status >= 200 && r.status < 300) || r.status === 429,
    });
  }
}

export function teardown() {
  if (!STUB_URL) return;
  const stats = http.get(`${STUB_URL}/__stub/stats`).json();
  const rankQueries =
    Number(stats["db:GET /player_technique_rating"] || 0) +
    Number(stats["db:GET /player_rank_state"] || 0);
  const progressQueries =
    Number(stats["db:GET /progress_daily"] || 0) + Number(stats["db:GET /practice_days"] || 0);
  console.log(
    `[wf-cache-stampede] concurrency=${CONCURRENCY} rank_db_queries=${rankQueries} ` +
      `progress_db_queries=${progressQueries} (coalesced miss would be 2 each); ` +
      `auth_exchanges=${Number(stats["auth:/auth/v1/token"] || 0)}`,
  );
  check(stats, {
    "auth cache absorbed every request (0 exchanges)": () =>
      Number(stats["auth:/auth/v1/token"] || 0) === 0,
    "cold-cache misses were NOT coalesced (rank fan-out > 2 queries)": () => rankQueries > 2,
    "cold-cache misses were NOT coalesced (progress fan-out > 2 queries)": () =>
      progressQueries > 2,
  });
}
