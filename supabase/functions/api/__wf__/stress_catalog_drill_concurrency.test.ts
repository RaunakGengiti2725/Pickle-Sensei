/**
 * stress — `GET /v1/catalog/drills/:slug` under concurrency (modelled database).
 *
 * Real handler in-process (index.ts via loadXcHarness), fake GoTrue /
 * RevenueCat / PostgREST, `user_saved_drills` served by MemorySavedDrills.
 * Scenarios: stress_catalog_drill_scenarios.ts. Every iteration is a seed;
 * the JSON row of a failing iteration carries its replay command.
 *
 *   deno test -A --no-check --config deno.json stress_catalog_drill_concurrency.test.ts
 *   STRESS_ITER=60 STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json \
 *     stress_catalog_drill_concurrency.test.ts          # the ≥500-interleaving campaign
 *
 * Artifacts: <STRESS_OUT_DIR>/<scenario>.json and seeds.model.json.
 */
import { assertEquals } from "@std/assert";
import {
  loadStressHarness,
  MemorySavedDrills,
  runScenario,
  STRESS_ITER,
  writeSeedTable,
} from "./stress_catalog_drill_harness.ts";
import { SCENARIOS } from "./stress_catalog_drill_scenarios.ts";

const TEST_FILE = "stress_catalog_drill_concurrency.test.ts";
const store = new MemorySavedDrills();

SCENARIOS.forEach((scenario, index) => {
  Deno.test(`${scenario.label} — ${scenario.name} (model, ${STRESS_ITER} seeds)`, async () => {
    const h = await loadStressHarness(store);
    const result = await runScenario(
      h,
      TEST_FILE,
      index,
      scenario.name,
      scenario.label,
      scenario.run,
    );
    const notHeld = result.iterations.filter((i) => i.outcome !== "HELD");
    assertEquals(
      notHeld.map((i) =>
        `seed=${i.seed} ${i.outcome}: ${i.failed.join(" | ")}\n  replay: ${i.replay}`
      ),
      [],
      `${scenario.name}: ${notHeld.length}/${result.iterations.length} iterations did not hold`,
    );
  });
});

Deno.test("stress — seed table written (model)", async () => {
  const path = await writeSeedTable("seeds.model.json");
  const table = JSON.parse(await Deno.readTextFile(path)) as { totals: { iterations: number } };
  assertEquals(table.totals.iterations, SCENARIOS.length * STRESS_ITER);
});
