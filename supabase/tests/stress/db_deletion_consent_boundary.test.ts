// Suite entry for the boundary/malformed stress harness.
//
//   cd supabase/tests/stress && deno task test
//
// The generator tests are pure and always run. The database campaign runs only
// when PICKLE_STRESS_PG_URL points at a database prepared by
// run_db_deletion_consent_stress.sh (shim + every migration); otherwise that
// test is reported as ignored, never as passing. STRESS_ITER (default 40)
// controls the campaign size so the suite stays fast.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  faultPlan,
  genJsonText,
  genNonNegInt,
  genText,
  genTimestamp,
  genUuid,
  iterationSeed,
  mulberry32,
  valid,
} from "./generators.ts";
import { runCampaign } from "./db_deletion_consent_boundary.ts";

const draw = (seed: number) => {
  const rng = mulberry32(seed);
  return [
    genText(rng, 50, true),
    genJsonText(rng, 4096),
    genTimestamp(rng, false),
    genNonNegInt(rng),
    genUuid(rng, "a", "b"),
  ];
};

Deno.test("generators: identical seed → identical inputs (replayable)", () => {
  for (let i = 0; i < 200; i++) {
    const seed = iterationSeed(20260904, i);
    assertEquals(draw(seed), draw(seed), `seed ${seed}`);
  }
});

Deno.test("generators: iterationSeed spreads a campaign into distinct seeds", () => {
  const seeds = new Set<number>();
  for (let i = 0; i < 3000; i++) seeds.add(iterationSeed(20260904, i));
  assertEquals(seeds.size, 3000);
  assertNotEquals(iterationSeed(1, 0), iterationSeed(2, 0));
});

Deno.test("generators: text edge classes cover the required lens", () => {
  const kinds = new Set<string>();
  const rng = mulberry32(7);
  for (let i = 0; i < 4000; i++) kinds.add(genText(rng, 50, true).kind);
  const required = [
    "at-cap(",
    "cap+1(",
    "64KB+(",
    "nul-byte",
    "control(",
    "path-traversal",
    "injection-ish",
    "lone-surrogate",
    "future-version",
    "unicode-normalization-pair",
    "combining-run(",
    "empty",
  ];
  for (const k of required) {
    assert(
      [...kinds].some((x) => x.startsWith(k)),
      `missing generator class ${k}; have ${[...kinds].join(",")}`,
    );
  }
});

Deno.test("generators: valid() only yields contract-valid values; faultPlan is seeded", () => {
  const rng = mulberry32(99);
  for (let i = 0; i < 500; i++) {
    const g = valid(() => genText(rng, 50, false));
    assertEquals(g.expect, "accept");
    assert(g.value !== null && Array.from(g.value).length <= 50);
  }
  const a = faultPlan(mulberry32(5), 8).mode;
  const b = faultPlan(mulberry32(5), 8).mode;
  assertEquals(a, b);
});

const pgUrl = Deno.env.get("PICKLE_STRESS_PG_URL") ?? "";

Deno.test({
  name: "db-deletion-consent boundary campaign holds (STRESS_ITER, default 40)",
  ignore: pgUrl === "",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const iterations = Number(Deno.env.get("STRESS_ITER") ?? "40");
    const seed = Number(Deno.env.get("STRESS_SEED") ?? "20260904");
    const { results, summary } = await runCampaign({
      pgUrl,
      iterations,
      seed,
      concurrency: 4,
    });
    assertEquals(summary.executed, iterations, "every iteration ran");
    const broken = results.filter((r) => r.outcome === "BROKEN");
    assertEquals(
      broken.length,
      0,
      broken
        .map((r) => `seed=${r.seed} ${r.scenario} observed=${r.observed} ${r.violations.join("|")}`)
        .join("\n"),
    );
  },
});
