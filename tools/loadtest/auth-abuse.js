// Auth-abuse simulation: hammers a protected route with INVALID bearer
// tokens from one client, exactly like a token-stuffing bot would.
//
//   k6 run -e BASE_URL=https://<ref>.supabase.co/functions/v1/api tools/loadtest/auth-abuse.js
//
// Expected behavior (all enforced as thresholds):
//   * every response is 401 or 429 — never 200, never 5xx;
//   * after the failure budget (30 failures / 5 min per IP) the limiter
//     answers 429 WITHOUT consulting Supabase Auth, so abuse gets cheaper
//     for the backend the longer it runs.
import http from "k6/http";
import encoding from "k6/encoding";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Set -e BASE_URL=https://…/functions/v1/api");

const rejected = new Counter("auth_rejected");
const limited = new Counter("auth_rate_limited");
const unexpected = new Rate("unexpected_responses");

const b64url = (value) => encoding.b64encode(value, "rawurl");

// A structurally valid JWT with a Google issuer but garbage signature.
const FAKE_TOKEN = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
  JSON.stringify({ iss: "https://accounts.google.com", exp: 4102444800 }),
)}.invalid-signature`;

export const options = {
  scenarios: {
    stuffing: {
      executor: "constant-arrival-rate",
      rate: 2,
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 5,
    },
  },
  thresholds: {
    unexpected_responses: ["rate<0.01"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/v1/me/access`, {
    headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
  });
  if (res.status === 401) rejected.add(1);
  if (res.status === 429) limited.add(1);
  unexpected.add(res.status !== 401 && res.status !== 429);
  check(res, {
    "invalid token never authenticates": (r) => r.status !== 200,
    "no 5xx under abuse": (r) => r.status < 500,
  });
  sleep(0.1);
}
