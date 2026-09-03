// Expired-provider-token retry loop: the mobile app keeps the provider ID
// token it signed in with for the whole process lifetime (apiSession.ts —
// there is no refresh), Apple identity tokens expire ~10 min after issue and
// Google's after ~60 min. Once expired, EVERY request from that device is a
// cache miss in authenticate() (failed verifications are never cached) and
// therefore one Supabase Auth /auth/v1/token call, answered 401. The outbox
// treats 401 as transient (sync.ts isPermanentSyncFailure) and retries every
// 30 s (syncRuntime.ts RETRY_INTERVAL_MS), so a device with a pending rating
// and an expired token becomes ~120 uncacheable Auth exchanges per hour.
//
// This script replays DEVICES such devices, each doing ATTEMPTS drain
// attempts (ATTEMPTS=12 ≈ 6 minutes of the 30 s timer) from its own IP.
//
//   k6 run -e BASE_URL=http://127.0.0.1:8000 -e STUB_URL=http://127.0.0.1:54399 \
//     -e DEVICES=20 -e ATTEMPTS=12 tools/loadtest/wf-expired-token-loop.js
//
// Asserts: every attempt is a 401 (never 5xx), and the stub saw exactly one
// Supabase Auth exchange per attempt (no negative caching / no lockout below
// the 30-failure per-IP budget).
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";
import encoding from "k6/encoding";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Set -e BASE_URL=http://127.0.0.1:8000");
const STUB_URL = __ENV.STUB_URL || "";
const DEVICES = Number(__ENV.DEVICES || 20);
const ATTEMPTS = Number(__ENV.ATTEMPTS || 12);
const AUTH_TOKEN_LIMIT_PER_HOUR = 1800;
const OUTBOX_RETRY_INTERVAL_S = 30;

const serverErrors = new Rate("server_errors");
const unauthorized = new Counter("expired_token_401");

export const options = {
  scenarios: {
    expired_devices: {
      executor: "per-vu-iterations",
      vus: DEVICES,
      iterations: ATTEMPTS,
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

/** Apple-issuer ID token whose exp is already in the past. */
function expiredTokenFor(n) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "wf", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      sub: `user-${n}`,
      aud: "wf-audience",
      exp: Math.floor(Date.now() / 1000) - 600,
    }),
  );
  return `${header}.${payload}.wf-signature`;
}

const SHOT_BATCH = JSON.stringify({
  shots: [
    {
      id: "8a0b5b1e-1f7a-4d5c-9c1a-6d4f8e2b3c01",
      analysisPermitId: "3f2c8a6e-7b1d-4e9a-8c2f-1a5b7d9e0f21",
      sessionId: null,
      shotType: "dink",
      cameraView: "side",
      capturedAt: "2026-09-01T12:00:00.000Z",
      timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
      overallScore: 6.5,
      confidence: 0.9,
      resultKind: "scored",
      source: "real",
      phases: [],
      checkpoints: [],
      versionVector: { scoringModelVersion: "wf", shotConfigVersion: "wf" },
    },
  ],
});

export function setup() {
  if (STUB_URL) http.post(`${STUB_URL}/__stub/reset`);
  return {};
}

export default function () {
  const n = __VU;
  const res = http.post(`${BASE_URL}/v1/shots:sync`, SHOT_BATCH, {
    headers: {
      Authorization: `Bearer ${expiredTokenFor(n)}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": `10.99.${(n >> 8) & 255}.${n & 255}`,
    },
  });
  serverErrors.add(res.status >= 500);
  if (res.status === 401) unauthorized.add(1);
  check(res, {
    "expired token is rejected with 401 (never 5xx)": (r) => r.status === 401,
  });
}

export function teardown() {
  if (!STUB_URL) return;
  const stats = http.get(`${STUB_URL}/__stub/stats`).json();
  const exchanges = Number(stats["auth:/auth/v1/token"] || 0);
  const attempts = DEVICES * ATTEMPTS;
  const perDevicePerHour = 3600 / OUTBOX_RETRY_INTERVAL_S;
  console.log(
    `[wf-expired-token-loop] devices=${DEVICES} attempts=${attempts} auth_exchanges=${exchanges} ` +
      `→ ${(exchanges / attempts).toFixed(2)} Supabase Auth calls per retry; ` +
      `${Math.floor(AUTH_TOKEN_LIMIT_PER_HOUR / perDevicePerHour)} such devices saturate the ` +
      `${AUTH_TOKEN_LIMIT_PER_HOUR}/h per-egress-IP token budget`,
  );
  check(stats, {
    "every expired-token retry hit Supabase Auth (no negative cache)": () => exchanges === attempts,
  });
}
