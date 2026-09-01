// Smoke load test: public endpoints (no auth, no user data touched).
//
//   k6 run -e BASE_URL=https://<ref>.supabase.co/functions/v1/api tools/loadtest/smoke.js
//
// Verifies the function stays fast and correct under light concurrent load
// and that the per-IP rate limiter answers 429 (never 5xx) when exceeded.
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Set -e BASE_URL=https://…/functions/v1/api");

const serverErrors = new Rate("server_errors");
const healthLatency = new Trend("health_latency", true);

export const options = {
  scenarios: {
    health: {
      executor: "ramping-vus",
      exec: "health",
      startVUs: 1,
      stages: [
        { duration: "20s", target: 10 },
        { duration: "30s", target: 10 },
        { duration: "10s", target: 0 },
      ],
    },
    legal_pages: {
      executor: "constant-vus",
      exec: "legal",
      vus: 2,
      duration: "60s",
    },
  },
  thresholds: {
    // The function itself must never 5xx under this load; 429 is an
    // acceptable, deliberate answer from the rate limiter.
    server_errors: ["rate<0.01"],
    health_latency: ["p(95)<800"],
  },
};

export function health() {
  const res = http.get(`${BASE_URL}/healthz`);
  healthLatency.add(res.timings.duration);
  serverErrors.add(res.status >= 500);
  check(res, {
    "healthz ok or rate-limited": (r) => r.status === 200 || r.status === 429,
    "rate limit carries Retry-After": (r) => r.status !== 429 || Boolean(r.headers["Retry-After"]),
  });
  sleep(0.3);
}

export function legal() {
  const res = http.get(`${BASE_URL}/privacy`);
  serverErrors.add(res.status >= 500);
  check(res, {
    "privacy serves the policy or rate-limits": (r) =>
      (r.status === 200 && String(r.body).includes("PRIVACY POLICY")) || r.status === 429,
    "privacy is sandboxed by the gateway": (r) =>
      r.status !== 200 ||
      Boolean(r.headers["Content-Security-Policy"] || r.headers["content-security-policy"]),
  });
  sleep(1);
}
