import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ITERATION_MODES,
  replayIteration,
  runCampaign,
  type CampaignResult,
  type Profile,
} from "./longRunLeakHarness.js";

/**
 * Long-run leak stress (lens: long-run-leak) for @pickle/database.
 *
 * Default scale is small so the suite stays fast; the full campaign is
 * opt-in through the environment:
 *
 *   STRESS_ITER=500 STRESS_SEED=1 STRESS_PROFILE=mixed STRESS_OUT=/tmp/leak.json \
 *   DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
 *   pnpm --filter @pickle/database test -- test/stress/longRunLeak.stress.test.ts
 *
 * Same gate as the other integration suites: skipped (visibly) without
 * DATABASE_URL_TEST.
 */

const testUrl = process.env["DATABASE_URL_TEST"];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function envProfile(): Profile {
  const raw = process.env["STRESS_PROFILE"] ?? "mixed";
  if (raw === "mixed" || (ITERATION_MODES as readonly string[]).includes(raw)) {
    return raw as Profile;
  }
  throw new Error(`STRESS_PROFILE must be mixed or one of ${ITERATION_MODES.join(", ")}`);
}

const iterations = envInt("STRESS_ITER", 20);
const masterSeed = envInt("STRESS_SEED", 1);
const sampleEvery = envInt(
  "STRESS_SAMPLE_EVERY",
  iterations >= 100 ? 50 : Math.max(5, Math.floor(iterations / 4)),
);
const profile = envProfile();
const HEAP_SLOPE_LIMIT_PER_100 = 0.05;

async function persist(result: CampaignResult): Promise<void> {
  const out = process.env["STRESS_OUT"];
  if (!out) return;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));
}

describe.skipIf(!testUrl)("long-run leak: migrate/seed invoked repeatedly in one process", () => {
  it(
    `holds heap, handles, advisory locks and connections steady over ${iterations} iterations (seed ${masterSeed}, ${profile})`,
    async () => {
      const result = await runCampaign({
        databaseUrl: testUrl!,
        iterations,
        masterSeed,
        profile,
        sampleEvery,
        heapSlopeLimitPer100: HEAP_SLOPE_LIMIT_PER_100,
      });
      await persist(result);

      expect(result.iterationsExecuted).toBe(iterations);
      const failed = result.rows.filter((r) => r.outcome === "fail");
      expect(
        failed,
        failed.map((r) => `#${r.i} seed=${r.seed} ${r.mode}: ${r.detail}`).join("\n"),
      ).toEqual([]);

      // Every seeding path converges to one canonical catalog — same fingerprint each time.
      const catalogFps = new Set(
        result.rows
          .filter((r) => !["tampered_dir_rejects", "concurrent_noop_pair"].includes(r.mode))
          .map((r) => r.fingerprint),
      );
      expect(catalogFps.size).toBe(1);

      expect(result.verdicts.fingerprintsFinite).toBe(true);
      expect(result.verdicts.noAdvisoryLockLeak, `advisory locks at end`).toBe(true);
      // Idle pool sockets may be reaped (pg default 10s idle timeout) so counts
      // can drop below baseline; any growth in a handle type is a leak.
      for (const [kind, delta] of Object.entries(result.analysis.resourceDelta)) {
        expect(delta, `libuv handle growth for ${kind}`).toBeLessThanOrEqual(0);
      }
      expect(result.analysis.processListenerDelta).toBeLessThanOrEqual(0);
      expect(result.analysis.serverConnectionDelta).toBeLessThanOrEqual(0);
      expect(result.final.poolWaiting).toBe(0);
      // A heap slope needs steady-state samples to mean anything: at the small
      // default scale the estimate is dominated by JIT warm-up, so the slope
      // verdict is asserted only for campaigns sampled >= 4 times past warm-up.
      if (result.samples.length >= 6 && result.analysis.heapSlopePer100Fraction !== null) {
        expect(
          result.analysis.heapSlopePer100Fraction,
          `heap slope per 100 iterations (fraction of first post-warmup sample)`,
        ).toBeLessThanOrEqual(HEAP_SLOPE_LIMIT_PER_100);
      }
    },
    60_000 + iterations * 5_000,
  );

  it("replays the same iteration seed to the same mode and fingerprint", async () => {
    const indices = [1, 2, 3];
    for (const index of indices) {
      const a = await replayIteration(testUrl!, masterSeed, index, profile);
      const b = await replayIteration(testUrl!, masterSeed, index, profile);
      expect(a.outcome, a.detail).toBe("ok");
      expect(b.mode).toBe(a.mode);
      expect(b.seed).toBe(a.seed);
      expect(b.fingerprint).toBe(a.fingerprint);
    }
  });
});
