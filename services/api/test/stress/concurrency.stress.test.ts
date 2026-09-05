import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorld,
  iterationSeed,
  Rng,
  tally,
  writeResults,
  type IterationRow,
  type ResultsTable,
  type World,
} from "./concurrencyHarness.js";
import { SCENARIO_NAMES, SCENARIOS } from "./concurrencyScenarios.js";

/**
 * Seeded concurrency stress campaign for services/api (real PostgreSQL).
 *
 * Every iteration is one seeded interleaving of a scenario family (duplicate
 * calls, call-during-call, cancel-during-call, two actors on one row, account
 * revocation mid-request, clock skew, exact rate-limit budgets). Invariants:
 * idempotency, no double spend of the two lifetime free ratings, no duplicate
 * rows, no lost update, no 5xx, and bounded wall time (a stuck iteration is a
 * deadlock finding, not a hang).
 *
 * Knobs (all optional):
 *   STRESS_ITER      iterations to run              (default 34 = 2 per scenario)
 *   STRESS_SEED      master seed                    (default 20260905)
 *   STRESS_SEEDS     comma-separated iteration seeds to replay exactly
 *   STRESS_SCENARIO  restrict to one scenario name
 *   STRESS_OUT       results directory              (default artifacts/stress/... under the repo)
 *   STRESS_TIMEOUT_MS per-iteration wall-time bound (default 20000)
 *
 * The suite fails when any iteration is BROKEN — the results table names the
 * seed, so `STRESS_SEEDS=<seed> pnpm --filter @pickle/api test -- stress`
 * replays it.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const env = process.env;
const iterations = Number(env["STRESS_ITER"] ?? SCENARIO_NAMES.length * 2);
const masterSeed = Number(env["STRESS_SEED"] ?? 20260905) >>> 0;
const replaySeeds = env["STRESS_SEEDS"]
  ? env["STRESS_SEEDS"]
      .split(",")
      .map((s) => Number(s.trim()) >>> 0)
      .filter((s) => Number.isFinite(s))
  : null;
const onlyScenario = env["STRESS_SCENARIO"];
const iterationTimeoutMs = Number(env["STRESS_TIMEOUT_MS"] ?? 20_000);
const outDir =
  env["STRESS_OUT"] ??
  join(
    process.cwd(),
    "..",
    "..",
    "artifacts",
    "stress",
    "svc-api-legacy-concurrency",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-seed${masterSeed}`,
  );

const scenarioNames = onlyScenario ? [onlyScenario] : SCENARIO_NAMES;

function pickScenario(seed: number): string {
  // The scenario is itself a function of the seed so replaying a seed
  // re-selects the same family without needing the iteration index.
  return scenarioNames[new Rng(seed ^ 0x5bd1e995).int(0, scenarioNames.length - 1)]!;
}

async function runIteration(world: World, index: number, seed: number): Promise<IterationRow> {
  const scenarioName = pickScenario(seed);
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario ${scenarioName}`);
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), iterationTimeoutMs);
  });
  try {
    const outcome = await Promise.race([scenario(world, new Rng(seed)), timeout]);
    const durationMs = Math.round(performance.now() - started);
    if (outcome === "timeout") {
      return {
        index,
        seed,
        scenario: scenarioName,
        outcome: "TIMEOUT",
        durationMs,
        requests: 0,
        violations: [
          `iteration exceeded ${iterationTimeoutMs}ms wall-time bound (possible deadlock)`,
        ],
        statuses: {},
      };
    }
    return {
      index,
      seed,
      scenario: scenarioName,
      outcome: outcome.violations.length === 0 ? "HELD" : "BROKEN",
      durationMs,
      requests: outcome.results.length,
      violations: outcome.violations,
      statuses: tally(outcome.results),
      detail: outcome.detail,
    };
  } catch (error) {
    return {
      index,
      seed,
      scenario: scenarioName,
      outcome: "HARNESS_ERROR",
      durationMs: Math.round(performance.now() - started),
      requests: 0,
      violations: [error instanceof Error ? (error.stack ?? error.message) : String(error)],
      statuses: {},
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!testUrl)("services/api concurrency stress (seeded, real PostgreSQL)", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld(testUrl!);
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it(
    "holds idempotency, accounting, uniqueness and liveness invariants under seeded bursts",
    async () => {
      const seeds =
        replaySeeds ?? Array.from({ length: iterations }, (_, i) => iterationSeed(masterSeed, i));
      const rows: IterationRow[] = [];
      const wallStart = performance.now();
      for (let i = 0; i < seeds.length; i++) {
        rows.push(await runIteration(world, i, seeds[i]!));
      }
      const byScenario: ResultsTable["byScenario"] = {};
      for (const row of rows) {
        const bucket = (byScenario[row.scenario] ??= {
          executed: 0,
          held: 0,
          broken: 0,
          timeouts: 0,
        });
        bucket.executed++;
        if (row.outcome === "HELD") bucket.held++;
        if (row.outcome === "BROKEN") bucket.broken++;
        if (row.outcome === "TIMEOUT") bucket.timeouts++;
      }
      const table: ResultsTable = {
        unit: "svc-api-legacy",
        lens: "concurrency",
        masterSeed: replaySeeds ? null : masterSeed,
        seedsRequested: replaySeeds,
        iterations: seeds.length,
        executed: rows.filter((r) => r.outcome !== "HARNESS_ERROR").length,
        held: rows.filter((r) => r.outcome === "HELD").length,
        broken: rows.filter((r) => r.outcome === "BROKEN").length,
        timeouts: rows.filter((r) => r.outcome === "TIMEOUT").length,
        harnessErrors: rows.filter((r) => r.outcome === "HARNESS_ERROR").length,
        wallMs: Math.round(performance.now() - wallStart),
        iterationTimeoutMs,
        byScenario,
        rows,
      };
      const path = writeResults(outDir, table);
      const failing = rows.filter((r) => r.outcome !== "HELD");
      const summary = failing
        .map(
          (r) =>
            `  seed=${r.seed} ${r.scenario} ${r.outcome}\n    ${r.violations.slice(0, 4).join("\n    ")}`,
        )
        .join("\n");
      expect(
        failing.length,
        `${failing.length}/${rows.length} iterations not HELD (table: ${path})\n${summary}`,
      ).toBe(0);
    },
    // Bounded by the per-iteration timeout so a deadlock is reported as a row,
    // not as a vitest hang.
    Math.max(60_000, iterations * (iterationTimeoutMs + 2_000)),
  );
});
