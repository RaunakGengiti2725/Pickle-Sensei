// Authenticated user-flow load test — the app's real request mix.
//
// Requires a REAL Google/Apple ID token for a test account (grab one from a
// debug build's network inspector, or mint one with the Google OAuth
// playground against the app's web client):
//
//   k6 run \
//     -e BASE_URL=https://<ref>.supabase.co/functions/v1/api \
//     -e TOKEN=<google-or-apple-id-token> \
//     -e VUS=20 tools/loadtest/user-flow.js
//
// NOTE: all VUs share one token → one user, so per-user rate limits will
// deliberately kick in at higher VU counts (429s are counted separately,
// not as failures). This measures the backend's hot read path: bootstrap,
// access, rank, progress, drills — the exact calls the app makes on launch
// and between screens. Auth-session caching means only the first request
// per ~10 min pays the Supabase Auth exchange.
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
const TOKEN = __ENV.TOKEN;
if (!BASE_URL) throw new Error("Set -e BASE_URL=https://…/functions/v1/api");
if (!TOKEN) throw new Error("Set -e TOKEN=<real provider ID token>");

const serverErrors = new Rate("server_errors");
const readLatency = new Trend("read_latency", true);
const rateLimited = new Rate("rate_limited");

const VUS = Number(__ENV.VUS || 10);

export const options = {
  scenarios: {
    app_launch_mix: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: VUS },
        { duration: "60s", target: VUS },
        { duration: "15s", target: 0 },
      ],
    },
  },
  thresholds: {
    server_errors: ["rate<0.01"],
    read_latency: ["p(95)<1200"],
  },
};

const AUTH = { headers: { Authorization: `Bearer ${TOKEN}` } };

function hit(name, method, path, body) {
  const url = `${BASE_URL}${path}`;
  const res =
    method === "POST"
      ? http.post(url, JSON.stringify(body ?? {}), {
          ...AUTH,
          headers: { ...AUTH.headers, "Content-Type": "application/json" },
        })
      : http.get(url, AUTH);
  readLatency.add(res.timings.duration, { endpoint: name });
  serverErrors.add(res.status >= 500);
  rateLimited.add(res.status === 429);
  check(res, {
    [`${name}: 2xx or deliberate 429`]: (r) =>
      (r.status >= 200 && r.status < 300) || r.status === 429,
  });
  return res;
}

export default function () {
  // The app's launch sequence…
  hit("bootstrap", "POST", "/v1/account/bootstrap");
  hit("access", "GET", "/v1/me/access");
  sleep(0.5);
  // …then typical screen loads.
  hit("rank", "GET", "/v1/rank");
  hit("progress", "GET", "/v1/progress");
  hit("drills", "GET", "/v1/catalog/drills");
  sleep(1.5);
}
