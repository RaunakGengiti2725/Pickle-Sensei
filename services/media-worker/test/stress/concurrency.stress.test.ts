import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { deriveSeed, withWallClock, type IterationResult } from "./harness.js";
import { SCENARIOS, runScenario, type ScenarioName } from "./scenarios.js";

/**
 * Seeded concurrency stress campaign for services/media-worker.
 *
 * Every iteration is replayable from (STRESS_SEED, scenario, index) or
 * directly from its derived seed. Knobs (all optional):
 *
 *   STRESS_ITER=N        total iterations across all scenarios (default 24 —
 *                        fast enough for the normal suite; the campaign used
 *                        STRESS_ITER=600)
 *   STRESS_SEED=N        base seed (default 20260904)
 *   STRESS_SCENARIOS=a,b restrict to these scenarios
 *   STRESS_REPLAY=scenario:seed[,scenario:seed...]  replay exact seeds
 *   STRESS_OUT=path      write the seed → outcome JSON table here
 *   STRESS_STRICT=1      also fail on the violations listed in KNOWN_VIOLATIONS
 *                        (open findings; by default they are recorded in the
 *                        table and summarised on stderr, but do not fail)
 *
 * Replay one seed:
 *   DATABASE_URL_TEST=... STRESS_REPLAY=process_vs_delete:123456 \
 *     pnpm --filter @pickle/media-worker exec vitest run test/stress
 *
 * Wall time per iteration is capped; a cap hit is reported as
 * `wall_time_exceeded` (hang / deadlock class), never silently retried.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

const TOTAL_ITER = Math.max(1, Number(process.env["STRESS_ITER"] ?? 24));
const BASE_SEED = Number(process.env["STRESS_SEED"] ?? 20260904);
const WALL_CAP_MS = Number(process.env["STRESS_WALL_CAP_MS"] ?? 30_000);
const OUT = process.env["STRESS_OUT"];
const STRICT = process.env["STRESS_STRICT"] === "1";

/**
 * Violations reproduced by the 2026-09-04 campaign and reported as findings
 * (see the campaign report). They stay visible in the JSON table and in the
 * stderr summary; STRESS_STRICT=1 turns them into failures once fixed so the
 * fix is pinned. Anything NOT in this list always fails the suite.
 */
const KNOWN_VIOLATIONS = [
  "process_job_poison:row_exists_object_key_null",
  "retry_budget_exhausted",
  "user_not_deleted",
  "orphan_objects",
  "task_not_done:final_hard_delete",
  "done_task_reclaimed_as_processing",
  "ledger_latest_eligible_after_withdrawal",
];

const selectedScenarios: ScenarioName[] = (() => {
  const raw = process.env["STRESS_SCENARIOS"];
  if (!raw) return [...SCENARIOS];
  const wanted = raw.split(",").map((s) => s.trim());
  return SCENARIOS.filter((s) => wanted.includes(s));
})();

interface Plan {
  scenario: ScenarioName;
  seed: number;
  index: number;
}

function buildPlan(): Plan[] {
  const replay = process.env["STRESS_REPLAY"];
  if (replay) {
    return replay.split(",").map((entry, index) => {
      const [scenario, seed] = entry.split(":");
      if (!SCENARIOS.includes(scenario as ScenarioName) || seed === undefined) {
        throw new Error(`bad STRESS_REPLAY entry: ${entry}`);
      }
      return { scenario: scenario as ScenarioName, seed: Number(seed) >>> 0, index };
    });
  }
  const perScenario = Math.ceil(TOTAL_ITER / selectedScenarios.length);
  const plan: Plan[] = [];
  for (const scenario of selectedScenarios) {
    for (let i = 0; i < perScenario; i++) {
      plan.push({ scenario, seed: deriveSeed(BASE_SEED, scenario, i), index: i });
    }
  }
  return plan;
}

const plan = buildPlan();
const results: IterationResult[] = [];

function isKnown(violation: string): boolean {
  return KNOWN_VIOLATIONS.some((k) => violation.startsWith(k));
}

function writeTable(): void {
  if (!OUT) return;
  mkdirSync(dirname(OUT), { recursive: true });
  const byScenario: Record<
    string,
    { ran: number; ok: number; failed: number; failedSeeds: number[] }
  > = {};
  for (const r of results) {
    const bucket = (byScenario[r.scenario] ??= { ran: 0, ok: 0, failed: 0, failedSeeds: [] });
    bucket.ran++;
    if (r.ok) bucket.ok++;
    else {
      bucket.failed++;
      bucket.failedSeeds.push(r.seed);
    }
  }
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        baseSeed: BASE_SEED,
        totalIterations: results.length,
        wallCapMs: WALL_CAP_MS,
        byScenario,
        results,
      },
      null,
      2,
    ),
  );
}

describe.skipIf(!testUrl)("media-worker concurrency stress (seeded, real PostgreSQL)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl, max: 20 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
  }, 120_000);

  afterAll(async () => {
    writeTable();
    const known = new Map<string, number>();
    for (const r of results) {
      for (const v of r.violations) {
        if (isKnown(v)) known.set(v.split(":")[0] ?? v, (known.get(v.split(":")[0] ?? v) ?? 0) + 1);
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    console.error(
      `[stress] ${results.length} iterations, ${failed} with violations` +
        (known.size > 0
          ? `; known (open findings): ${[...known].map(([k, n]) => `${k}×${n}`).join(", ")}`
          : ""),
    );
    await pool?.end();
  });

  for (const scenario of selectedScenarios) {
    const entries = plan.filter((p) => p.scenario === scenario);
    if (entries.length === 0) continue;
    it(
      `${scenario}: ${entries.length} seeded interleavings hold their invariants`,
      async () => {
        const unexpected: string[] = [];
        for (const entry of entries) {
          const run = await withWallClock(WALL_CAP_MS, () =>
            runScenario(scenario, { pool, seed: entry.seed, index: entry.index }),
          );
          const result: IterationResult = run.result
            ? { ...run.result, ok: run.result.violations.length === 0, durationMs: run.durationMs }
            : {
                scenario,
                seed: entry.seed,
                index: entry.index,
                ok: false,
                violations: ["wall_time_exceeded"],
                params: {},
                metrics: {},
                durationMs: run.durationMs,
              };
          results.push(result);
          const blocking = result.violations.filter((v) => STRICT || !isKnown(v));
          if (blocking.length > 0) {
            unexpected.push(`${scenario}:${result.seed} → ${blocking.join(" | ")}`);
          }
        }
        expect(unexpected, `failing seeds (replay with STRESS_REPLAY)`).toEqual([]);
      },
      Math.max(60_000, entries.length * (WALL_CAP_MS + 2_000)),
    );
  }
});
