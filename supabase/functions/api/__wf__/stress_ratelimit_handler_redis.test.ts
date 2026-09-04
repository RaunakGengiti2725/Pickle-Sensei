// Stress — the REAL edge handler (index.ts in-process) under seeded
// Promise.all bursts with UPSTASH configured: rate-limit counters live in the
// seeded fake Redis, whose request/response latency reorders INCRs and whose
// faults (HTTP 503 flaps, hangs until the 1.2 s timeout) exercise the
// documented fail-open fallback to per-isolate memory.
// Campaign bodies live in stress_ratelimit_handler_campaigns.ts.
//
//   STRESS_ITER=200 deno test -A --no-check --config deno.json stress_ratelimit_handler_redis.test.ts

import { STRESS_ITER, assertTableHeld } from "./stress_ratelimit_harness.ts";
import {
  type CampaignOptions,
  type EdgeHarness,
  campaignAuthFailBurst,
  campaignPublicBurst,
  campaignRefreshBurst,
  campaignUserBudget,
  campaignWebhookBurst,
  loadEdgeHandler,
} from "./stress_ratelimit_handler_campaigns.ts";

const FILE = "stress_ratelimit_handler_redis.test.ts";
const ITER = Math.max(3, Math.ceil(STRESS_ITER / 2));
const options: CampaignOptions = {
  file: FILE,
  iterations: ITER,
  modes: [
    ["redis", 70],
    ["redis-flaky", 22],
    ["redis-hang", 8],
  ],
};

let harness: EdgeHarness | null = null;
async function edge(): Promise<EdgeHarness> {
  harness ??= await loadEdgeHandler(true);
  return harness;
}

Deno.test(
  `stress H1 (redis): public-page same-IP bursts with XFF/cf permutations + cancelled requests (${ITER} iterations)`,
  async () => {
    const table = await campaignPublicBurst(await edge(), options);
    console.log(
      `[stress H1 redis] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(
  `stress H2 (redis): concurrent bad bearers — peek-before-auth gate and post-burst refusal (${ITER} iterations)`,
  async () => {
    const table = await campaignAuthFailBurst(await edge(), options);
    console.log(
      `[stress H2 redis] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(
  `stress H3 (redis): per-user route budgets under duplicate/cancelled bursts, bystander on the same IP, rotation and logout mid-load (${ITER} iterations)`,
  async () => {
    const table = await campaignUserBudget(await edge(), options);
    console.log(
      `[stress H3 redis] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(
  `stress H4 (redis): concurrent junk refreshes — auth_refresh budget then auth-failure lockout (${ITER} iterations)`,
  async () => {
    const table = await campaignRefreshBurst(await edge(), options);
    console.log(
      `[stress H4 redis] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(`stress H5 (redis): webhook bursts with a bad secret (${ITER} iterations)`, async () => {
  const table = await campaignWebhookBurst(await edge(), options);
  console.log(
    `[stress H5 redis] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
  );
  assertTableHeld(table);
});
