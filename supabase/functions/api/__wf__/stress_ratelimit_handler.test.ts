// Stress — the REAL edge handler (index.ts in-process) under seeded
// Promise.all bursts, MEMORY rate-limit path (no Upstash configured — the
// production fallback when UPSTASH_* secrets are absent or Redis is down).
// Campaign bodies live in stress_ratelimit_handler_campaigns.ts.
//
//   STRESS_ITER=200 deno test -A --no-check --config deno.json stress_ratelimit_handler.test.ts

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

const FILE = "stress_ratelimit_handler.test.ts";
const ITER = Math.max(3, Math.ceil(STRESS_ITER / 2));
const options: CampaignOptions = { file: FILE, iterations: ITER, modes: [["memory", 1]] };

let harness: EdgeHarness | null = null;
async function edge(): Promise<EdgeHarness> {
  harness ??= await loadEdgeHandler(false);
  return harness;
}

Deno.test(
  `stress H1 (memory): public-page same-IP bursts with XFF/cf permutations + cancelled requests (${ITER} iterations)`,
  async () => {
    const table = await campaignPublicBurst(await edge(), options);
    console.log(
      `[stress H1 memory] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(
  `stress H2 (memory): concurrent bad bearers — peek-before-auth gate and post-burst refusal (${ITER} iterations)`,
  async () => {
    const table = await campaignAuthFailBurst(await edge(), options);
    console.log(
      `[stress H2 memory] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(
  `stress H3 (memory): per-user route budgets under duplicate/cancelled bursts, bystander on the same IP, rotation and logout mid-load (${ITER} iterations)`,
  async () => {
    const table = await campaignUserBudget(await edge(), options);
    console.log(
      `[stress H3 memory] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(
  `stress H4 (memory): concurrent junk refreshes — auth_refresh budget then auth-failure lockout (${ITER} iterations)`,
  async () => {
    const table = await campaignRefreshBurst(await edge(), options);
    console.log(
      `[stress H4 memory] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
    );
    assertTableHeld(table);
  },
);

Deno.test(`stress H5 (memory): webhook bursts with a bad secret (${ITER} iterations)`, async () => {
  const table = await campaignWebhookBurst(await edge(), options);
  console.log(
    `[stress H5 memory] ${table.held} HELD / ${table.broken} BROKEN; requests=${table.totals.requests}; ${table.durationMs}ms`,
  );
  assertTableHeld(table);
});
