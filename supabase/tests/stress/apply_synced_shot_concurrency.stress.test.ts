/**
 * Suite entry for the apply_synced_shot concurrency stress campaign.
 *
 * Skips (ignore) when STRESS_PG_URL is unset so the suite stays green on
 * machines without Docker; a skipped run is NOT a pass — the campaign run
 * that counts is the one whose summary.json is attached to the evidence.
 *
 *   ./stress_pg_up.sh
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres deno task test
 *   STRESS_ITER=600 STRESS_PG_URL=... deno task campaign      # full campaign
 */
import { assertEquals } from "@std/assert";
import { configFromEnv, runCampaign } from "./campaign.ts";

const cfg = configFromEnv();

Deno.test({
  name: `apply_synced_shot concurrency stress campaign (STRESS_ITER=${cfg.iterations}, seed=${cfg.baseSeed})`,
  ignore: !cfg.pgUrl,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { summary } = await runCampaign(cfg, (s) => console.log(s));
    assertEquals(
      summary.setupErrors,
      0,
      `scenario setup errors: ${JSON.stringify(summary.failedSeeds, null, 2)}`,
    );
    assertEquals(
      summary.failed,
      0,
      `failing seeds:\n${summary.failedSeeds
        .map(
          (f) =>
            `  iter=${f.iter} seed=${f.seed} ${f.scenario}\n    ${f.failed.join(
              "\n    ",
            )}\n    replay: ${f.replay}`,
        )
        .join("\n")}`,
    );
    assertEquals(summary.executed, cfg.replay !== undefined ? 1 : cfg.iterations);
  },
});
