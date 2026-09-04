// Adversarial companion to tools/loadtest/wf-expired-token-loop.js.
//
// The expired-token loop is answered by the function BEFORE Supabase Auth
// (index.ts bearerExpired → 401), so it costs zero upstream exchanges. The
// expensive storm is the one this script replays: tokens that are well
// formed and NOT expired but can never verify (forged subject) — each one is
// an auth-cache miss and therefore a Supabase Auth /auth/v1/token exchange
// until the per-IP auth-failure budget (AUTH_FAILURE_LIMIT = 30 / 300 s)
// trips and the function starts answering 429 without calling upstream.
//
//   k6 run -e BASE_URL=http://127.0.0.1:8000 -e STUB_URL=http://127.0.0.1:54399 \
//     -e DEVICES=20 -e ATTEMPTS=60 tools/attack/security-secrets-deps-2/k6-forged-token-storm.js
//
// Asserts (thresholds, so a failure fails the run — unlike a bare check):
//   * never 5xx;
//   * every answer is 401 or 429;
//   * the stub saw at most DEVICES × AUTH_FAILURE_BUDGET auth exchanges
//     (the budget really caps upstream cost per IP);
//   * at least one 429 per device once ATTEMPTS > budget;
//   * malformed-clock variants (exp as string / huge / missing / 1 s ahead)
//     are all 401 or 429 — never 5xx.
//
// Seeded: every VU's token subject derives from SEED (default 20260904) so a
// run is byte-for-byte reproducible.
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";
import encoding from "k6/encoding";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Set -e BASE_URL=http://127.0.0.1:8000");
const STUB_URL = __ENV.STUB_URL || "";
const DEVICES = Number(__ENV.DEVICES || 20);
const ATTEMPTS = Number(__ENV.ATTEMPTS || 60);
const SEED = Number(__ENV.SEED || 20260904);
const AUTH_FAILURE_BUDGET = 30; // index.ts AUTH_FAILURE_LIMIT.limit

const serverErrors = new Rate("server_errors");
const unexpectedStatus = new Rate("unexpected_status");
const unauthorized = new Counter("forged_401");
const throttled = new Counter("forged_429");
const budgetHeld = new Rate("auth_exchange_budget_held");
const everyDeviceThrottled = new Rate("every_device_throttled");

export const options = {
  scenarios: {
    forged_devices: {
      executor: "per-vu-iterations",
      vus: DEVICES,
      iterations: ATTEMPTS,
      maxDuration: "3m",
    },
  },
  thresholds: {
    server_errors: ["rate<0.001"],
    unexpected_status: ["rate<0.001"],
    auth_exchange_budget_held: ["rate>0.999"],
    every_device_throttled: ["rate>0.999"],
    checks: ["rate>0.999"],
  },
};

function b64url(value) {
  return encoding.b64encode(value, "rawurl");
}

/** Deterministic per-VU subject: sha-free LCG on (SEED, vu). */
function forgedSubject(vu) {
  let x = (SEED ^ (vu * 2654435761)) >>> 0;
  x = (x * 1664525 + 1013904223) >>> 0;
  return `forged-${x.toString(16)}`;
}

function tokenWith(payloadOverrides) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "wf", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify(
      Object.assign(
        {
          iss: "https://appleid.apple.com",
          aud: "wf-audience",
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        payloadOverrides,
      ),
    ),
  );
  return `${header}.${payload}.wf-signature`;
}

function ipFor(n) {
  return `10.98.${(n >> 8) & 255}.${n & 255}`;
}

export function setup() {
  if (STUB_URL) http.post(`${STUB_URL}/__stub/reset`);
  return {};
}

const throttledSeen = {};

export default function () {
  const n = __VU;
  const sub = forgedSubject(n);
  // Clock-skew / malformed-exp variants ride along on a few iterations of
  // every device (never 5xx, never something other than 401/429).
  let overrides = { sub };
  switch (__ITER % 6) {
    case 1:
      overrides = { sub, exp: String(Math.floor(Date.now() / 1000) + 600) };
      break;
    case 2:
      overrides = { sub, exp: Number.MAX_SAFE_INTEGER };
      break;
    case 3:
      overrides = { sub, exp: undefined };
      break;
    case 4:
      overrides = { sub, exp: Math.floor(Date.now() / 1000) + 1 };
      break;
    case 5:
      overrides = { sub: "\u0000\ud83e\udd52".repeat(64) };
      break;
    default:
      break;
  }
  const res = http.get(`${BASE_URL}/v1/me/access`, {
    headers: {
      Authorization: `Bearer ${tokenWith(overrides)}`,
      "X-Forwarded-For": ipFor(n),
    },
  });
  serverErrors.add(res.status >= 500);
  unexpectedStatus.add(res.status !== 401 && res.status !== 429);
  if (res.status === 401) unauthorized.add(1);
  if (res.status === 429) {
    throttled.add(1);
    throttledSeen[n] = true;
  }
  check(res, {
    "forged token answered 401 or 429 (never 5xx)": (r) => r.status === 401 || r.status === 429,
    "429 carries Retry-After": (r) => r.status !== 429 || Boolean(r.headers["Retry-After"]),
    "body never names an internal secret": (r) =>
      !/SERVICE_ROLE|PRIVATE_KEY|ENCRYPTION_KEY|BEGIN [A-Z ]*PRIVATE/.test(r.body || ""),
  });
  if (__ITER === ATTEMPTS - 1) {
    everyDeviceThrottled.add(ATTEMPTS <= AUTH_FAILURE_BUDGET || Boolean(throttledSeen[n]));
  }
}

export function teardown() {
  if (!STUB_URL) return;
  const stats = http.get(`${STUB_URL}/__stub/stats`).json();
  const exchanges = Number(stats["auth:/auth/v1/token"] || 0);
  const cap = DEVICES * AUTH_FAILURE_BUDGET;
  budgetHeld.add(exchanges <= cap);
  console.log(
    `[forged-token-storm] seed=${SEED} devices=${DEVICES} attempts=${DEVICES * ATTEMPTS} ` +
      `auth_exchanges=${exchanges} cap=${cap} (${AUTH_FAILURE_BUDGET}/device)`,
  );
}
