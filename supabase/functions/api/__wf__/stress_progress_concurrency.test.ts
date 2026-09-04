// Stress lens `concurrency` for GET /v1/progress — L1 (per-isolate) cache
// only, no Upstash configured. See stress_progress_campaign.ts for the
// families and stress_progress_harness.ts for the in-process environment.
//
//   deno test -A --no-check --config deno.json stress_progress_concurrency.test.ts
//   STRESS_ITER=700 …   (default 96 ≈ 12 per family; ≥ 500 for the report)
//
// Every BROKEN iteration is either attributed to a documented, reproduced
// defect (KNOWN_DEFECTS — pinned below so a fix flips the pin) or fails the
// campaign test. Nothing is skipped or reclassified.

import { assert, assertEquals } from "@std/assert";
import {
  KNOWN_DEFECTS,
  runCampaign,
  runIteration,
} from "./stress_progress_campaign.ts";
import { loadStressHarness } from "./stress_progress_harness.ts";

Deno.test(
  "stress: GET /v1/progress concurrency campaign (L1 only) — every seeded interleaving HELD or a known defect",
  async () => {
    const report = await runCampaign({
      suite: "progress-concurrency-l1",
      file: "stress_progress_concurrency.test.ts",
      redis: false,
    });
    assert(report.scenariosExecuted > 0, "no iterations ran");
    const unexplained = report.failingSeeds.filter((f) => !f.knownDefect);
    assertEquals(
      unexplained.length,
      0,
      `${unexplained.length} BROKEN iteration(s) not explained by a known defect: ${
        JSON.stringify(unexplained.slice(0, 5), null, 1)
      }`,
    );
  },
);

Deno.test(
  `stress: KNOWN DEFECT ${KNOWN_DEFECTS.pagingTorn} — a sync between page 1 and page 2 of a > 1000-row build tears the racing caller's body (flip this pin when fixed)`,
  async () => {
    const h = await loadStressHarness({ redis: false });
    const row = await runIteration(
      h,
      "paging-torn",
      777001,
      4,
      "STRESS_SEED=777001 STRESS_ITER=1 STRESS_FAMILY=paging-torn",
    );
    const torn = row.invariants.find((i) =>
      i.name === "parked-build-body-is-a-snapshot"
    );
    assert(
      torn && !torn.holds,
      `expected the torn body to reproduce; got ${JSON.stringify(torn)}`,
    );
    assertEquals(
      row.knownDefect,
      KNOWN_DEFECTS.pagingTorn,
      JSON.stringify(row.invariants.filter((i) => !i.holds)),
    );
    // The defect is bounded: the torn build is never cached and later GETs are fresh.
    for (
      const name of [
        "torn-or-stale-never-cached",
        "post-sync-gets-see-sync",
        "exactly-two-builds",
      ]
    ) {
      const inv = row.invariants.find((i) => i.name === name);
      assert(inv?.holds, `${name} must hold: ${inv?.detail}`);
    }
  },
);
