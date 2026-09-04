// Stress lens `concurrency` for GET /v1/progress with the L2 (fake Upstash)
// cache configured and seeded Redis faults injected (STRESS_REDIS_FAULT,
// default 0.1 = 10% of pipelines fail with HTTP 500 or a network error).
//
//   deno test -A --no-check --config deno.json stress_progress_redis.test.ts
//   STRESS_ITER=500 STRESS_REDIS_FAULT=0.1 …
//
// BROKEN iterations attributed to a KNOWN_DEFECTS entry (the three L2 stale-
// read mechanisms pinned below) stay BROKEN in the JSON table; anything else
// fails the campaign test.

import { assert, assertEquals } from "@std/assert";
import {
  KNOWN_DEFECTS,
  runCampaign,
  runIteration,
} from "./stress_progress_campaign.ts";
import { envFloat, loadStressHarness } from "./stress_progress_harness.ts";

Deno.test(
  "stress: GET /v1/progress concurrency campaign (L1 + fake Upstash L2, faults injected) — every seeded interleaving HELD or a known defect",
  async () => {
    const redisFaultRate = envFloat("STRESS_REDIS_FAULT", 0.1);
    const report = await runCampaign({
      suite: "progress-concurrency-redis",
      file: "stress_progress_redis.test.ts",
      redis: true,
      redisFaultRate,
      extraEnv: `STRESS_REDIS_FAULT=${redisFaultRate} `,
    });
    assert(report.scenariosExecuted > 0, "no iterations ran");
    assert(
      report.rows.some((r) => Number(r.observations.redisPipelines) > 0),
      "fake Upstash was never called — L2 path not exercised",
    );
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
  `stress: KNOWN DEFECT ${KNOWN_DEFECTS.l2DelFault} — a failed cacheDel pipeline leaves the L2 row; the next GETs serve the pre-sync payload (flip this pin when fixed)`,
  async () => {
    const h = await loadStressHarness({ redis: true });
    const row = await runIteration(
      h,
      "l2-del-fault",
      777001,
      4,
      "STRESS_SEED=777001 STRESS_ITER=1 STRESS_FAMILY=l2-del-fault",
    );
    for (
      const name of [
        "warm-correct",
        "sync-accepted",
        "del-pipeline-was-failed",
        "statuses-in-contract",
        "no-deadlock",
      ]
    ) {
      const inv = row.invariants.find((i) => i.name === name);
      assert(inv?.holds, `${name} must hold: ${inv?.detail}`);
    }
    const stale = row.invariants.find((i) => i.name === "post-sync-gets-fresh");
    assert(
      stale && !stale.holds,
      `expected the stale read to reproduce; got ${JSON.stringify(stale)}`,
    );
    assertEquals(
      row.knownDefect,
      KNOWN_DEFECTS.l2DelFault,
      JSON.stringify(row.invariants.filter((i) => !i.holds)),
    );
  },
);

Deno.test(
  `stress: KNOWN DEFECT ${KNOWN_DEFECTS.l2UndoWindow} — a GET between a losing fenced SET and its compensating DEL reads the stale row into L1 (flip this pin when fixed)`,
  async () => {
    const h = await loadStressHarness({ redis: true });
    const row = await runIteration(
      h,
      "l2-undo-window",
      777001,
      4,
      "STRESS_SEED=777001 STRESS_ITER=1 STRESS_FAMILY=l2-undo-window",
    );
    for (
      const name of [
        "fenced-set-reached",
        "sync-accepted",
        "losing-set-undone-with-del",
        "statuses-in-contract",
        "no-deadlock",
      ]
    ) {
      const inv = row.invariants.find((i) => i.name === name);
      assert(inv?.holds, `${name} must hold: ${inv?.detail}`);
    }
    const stale = row.invariants.find((i) =>
      i.name === "get-in-undo-window-fresh"
    );
    assert(
      stale && !stale.holds,
      `expected the in-window stale read to reproduce; got ${
        JSON.stringify(stale)
      }`,
    );
    assertEquals(
      row.knownDefect,
      KNOWN_DEFECTS.l2UndoWindow,
      JSON.stringify(row.invariants.filter((i) => !i.holds)),
    );
  },
);

Deno.test(
  `stress: KNOWN DEFECT ${KNOWN_DEFECTS.l2ReadThroughRace} — a GET whose L2 read lands while cacheDel's DEL is in flight copies the pre-sync row into L1 after the invalidation (flip this pin when fixed)`,
  async () => {
    const h = await loadStressHarness({ redis: true });
    const row = await runIteration(
      h,
      "l2-readthrough-race",
      777001,
      4,
      "STRESS_SEED=777001 STRESS_ITER=1 STRESS_FAMILY=l2-readthrough-race",
    );
    for (
      const name of [
        "warm-correct",
        "invalidation-del-reached",
        "sync-accepted",
        "during-body-admissible",
        "statuses-in-contract",
        "no-deadlock",
      ]
    ) {
      const inv = row.invariants.find((i) => i.name === name);
      assert(inv?.holds, `${name} must hold: ${inv?.detail}`);
    }
    const stale = row.invariants.find((i) => i.name === "post-sync-gets-fresh");
    assert(
      stale && !stale.holds,
      `expected the post-sync stale read to reproduce; got ${
        JSON.stringify(stale)
      }`,
    );
    // The L2 row is gone (the DEL did land); the only stale copy is L1.
    assertEquals(row.observations.l2RowAfter, "absent");
    assertEquals(
      row.knownDefect,
      KNOWN_DEFECTS.l2ReadThroughRace,
      JSON.stringify(row.invariants.filter((i) => !i.holds)),
    );
  },
);

Deno.test(
  `stress: KNOWN DEFECT ${KNOWN_DEFECTS.coalesceGap} — a GET whose L2 read was in flight while the build completed rebuilds instead of serving L1 (efficiency only; flip this pin when fixed)`,
  async () => {
    const h = await loadStressHarness({ redis: true });
    const row = await runIteration(
      h,
      "l2-coalesce-gap",
      777001,
      4,
      "STRESS_SEED=777001 STRESS_ITER=1 STRESS_FAMILY=l2-coalesce-gap",
    );
    for (
      const name of [
        "second-l2-read-parked",
        "fence-read-was-failed",
        "all-bodies-correct",
        "statuses-in-contract",
        "no-deadlock",
      ]
    ) {
      const inv = row.invariants.find((i) => i.name === name);
      assert(inv?.holds, `${name} must hold: ${inv?.detail}`);
    }
    const dup = row.invariants.find((i) =>
      i.name === "concurrent-gets-share-one-build"
    );
    assert(
      dup && !dup.holds,
      `expected the duplicate build to reproduce; got ${JSON.stringify(dup)}`,
    );
    assertEquals(row.observations.buildsAfterA, 1);
    assertEquals(
      row.knownDefect,
      KNOWN_DEFECTS.coalesceGap,
      JSON.stringify(row.invariants.filter((i) => !i.holds)),
    );
  },
);
