// Adversarial pass 3 — probe (not a test: real timers, ~25 s). Measures what a
// single POST /v1/auth/refresh costs while GoTrue answers 503: how long the
// edge holds the request and how many upstream attempts supabase-js fires
// before the edge finally answers 503.
//
//   cd supabase/functions/api/__wf__ && deno run -A --no-check --config deno.json attack3_refresh_outage_probe.ts
//
// Context: apps/mobile/src/account/sessionLifecycle.ts aborts the refresh at
// REQUEST_TIMEOUT_MS = 15 000 and sessionKeeper retries with backoff, so any
// edge answer slower than 15 s is never seen by the app.

import { edgeRequest, jsonResponse, loadAttack3 } from "./attack3_harness.ts";

const attack = await loadAttack3();
const attemptsAtMs: number[] = [];
const startedAt = performance.now();
attack.setOverride((request, url) => {
  if (request.method === "POST" && url.pathname === "/auth/v1/token") {
    attemptsAtMs.push(Math.round(performance.now() - startedAt));
    return jsonResponse(503, { code: 503, msg: "service unavailable" });
  }
  return null;
});

const response = await attack.harness.handler(
  edgeRequest("POST", "/v1/auth/refresh", {
    ip: "198.51.100.99",
    body: JSON.stringify({ refreshToken: "rt-live-device" }),
    headers: { "Content-Type": "application/json" },
  }),
);
const elapsedMs = Math.round(performance.now() - startedAt);
const body = await response.text();

const result = {
  probe: "refresh while GoTrue answers 503",
  edgeStatus: response.status,
  edgeBody: body,
  elapsedMs,
  upstreamAttempts: attemptsAtMs.length,
  upstreamAttemptOffsetsMs: attemptsAtMs,
  mobileRefreshTimeoutMs: 15_000,
  edgeAnsweredBeforeMobileTimeout: elapsedMs < 15_000,
};
console.log(JSON.stringify(result, null, 2));
if (Deno.args[0]) {
  await Deno.writeTextFile(Deno.args[0], JSON.stringify(result, null, 2));
}
