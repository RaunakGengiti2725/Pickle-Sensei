import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KNOWN_BROKEN, runCampaign, type CampaignResult } from "./campaign.js";

/**
 * Boundary / malformed-input stress campaign for packages/evaluation.
 *
 *   STRESS_ITER=3000 STRESS_SEED=1 STRESS_OUT=/tmp/stress.json pnpm --filter @pickle/evaluation test -- stress
 *
 * Default is a small smoke campaign so the file can live in the suite. Every
 * record is replayable: `pnpm --filter @pickle/evaluation exec tsx test/stress/replay.ts <seed>`.
 *
 * The campaign asserts three things:
 *   1. every iteration ran and is deterministic for its seed;
 *   2. no BROKEN record falls outside the documented KNOWN_BROKEN classes
 *      (an unknown class means a *new* escape and fails the suite);
 *   3. the documented classes are still reproducible at scale — when one of
 *      them stops appearing at >= 3000 iterations the finding has been fixed
 *      and this table must be updated.
 */

const iterations = Number.parseInt(process.env.STRESS_ITER ?? "150", 10);
const seedBase = Number.parseInt(process.env.STRESS_SEED ?? "1", 10);
const outPath = process.env.STRESS_OUT;
const scratchDir = mkdtempSync(join(tmpdir(), "pickle-eval-stress-"));

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("boundary/malformed stress campaign", () => {
  let result: CampaignResult;

  it(
    `runs ${iterations} seeded iterations from seed ${seedBase} and replays every seed`,
    async () => {
      result = await runCampaign({
        seedBase,
        iterations,
        scratchDir,
        replay: true,
        includeRunnerRejections: true,
      });
      if (outPath) writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
      expect(result.meta.executed).toBe(iterations);
      expect(result.meta.replayed).toBe(iterations);
    },
    Math.max(60_000, iterations * 200),
  );

  it("is deterministic for the same seed", () => {
    expect(result.meta.nondeterministic).toEqual([]);
  });

  it("never escapes outside the documented BROKEN classes", () => {
    const unexpected = result.records.filter(
      (record) => record.verdict === "BROKEN" && !(record.brokenClass! in KNOWN_BROKEN),
    );
    expect(
      unexpected.map(
        (record) =>
          `${record.seed} ${record.surface}/${record.op} ${record.brokenClass}: ${record.detail}`,
      ),
    ).toEqual([]);
  });

  it("keeps global prototypes clean after the campaign", () => {
    const probe: Record<string, unknown> = {};
    expect(Object.keys(Object.getPrototypeOf(probe) as object)).toEqual([]);
    expect("polluted" in probe).toBe(false);
  });

  it.skipIf(iterations < 3000)("reproduces every documented BROKEN class at scale", () => {
    for (const cls of Object.keys(KNOWN_BROKEN)) {
      expect(result.meta.brokenClasses[cls] ?? 0, cls).toBeGreaterThan(0);
    }
  });
});
