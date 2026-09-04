/**
 * Seeded randomized long-run campaign over the `@pickle/evaluation` public
 * API (lens: randomized-seeded).
 *
 *   pnpm --filter @pickle/evaluation exec tsx test/stress/campaign.ts \
 *     --iterations 2000 --seed-base 20260904 --out /tmp/stress/results.json
 *   pnpm --filter @pickle/evaluation exec tsx test/stress/campaign.ts --seed 123456789
 *
 * Every row of the results table is replayable from its `seed` alone. The
 * whole campaign is executed twice and the per-step trace digests must match
 * (determinism invariant I9). Failing seeds are shrunk to a minimal step list
 * and re-run 10x to measure flakiness.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MAX_SEQUENCE_LENGTH,
  MIN_SEQUENCE_LENGTH,
  executeSequence,
  generateActions,
  runSeed,
  shrinkFailure,
  type SequenceOutcome,
  type Step,
} from "./model.js";
import { deriveSeed, digest } from "./seededRng.js";

export interface CampaignRow {
  index: number;
  seed: number;
  start: "committed" | "minimal";
  length: number;
  outcome: "ok" | "invariant_failed" | "crash" | "nondeterministic";
  stepsCompleted: number;
  traceDigest: string;
  replayDigest: string;
  actionHistogram: Record<string, number>;
  failure: SequenceOutcome["failure"];
  minimized: null | {
    steps: Step[];
    length: number;
    invariant: string;
    message: string;
    rerunFailures: number;
    reruns: number;
  };
}

export interface CampaignResult {
  lens: "randomized-seeded";
  unit: "pkg-evaluation";
  seedBase: number;
  iterations: number;
  minLength: number;
  maxLength: number;
  node: string;
  startedAtIso: string;
  wallClockMs: number;
  scenariosExecuted: number;
  stepsExecuted: number;
  okCount: number;
  failedSeeds: number[];
  nondeterministicSeeds: number[];
  invariantHistogram: Record<string, number>;
  actionHistogram: Record<string, number>;
  rows: CampaignRow[];
}

function histogram(steps: readonly Step[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const step of steps) out[step.action.kind] = (out[step.action.kind] ?? 0) + 1;
  return out;
}

export function runCampaign(options: {
  iterations: number;
  seedBase: number;
  reruns?: number;
  onProgress?: (done: number, total: number) => void;
}): CampaignResult {
  const startedAt = Date.now();
  const reruns = options.reruns ?? 10;
  const rows: CampaignRow[] = [];
  const invariantHistogram: Record<string, number> = {};
  const actionHistogram: Record<string, number> = {};
  let stepsExecuted = 0;
  for (let index = 0; index < options.iterations; index += 1) {
    const seed = deriveSeed(options.seedBase, index);
    const { start, steps } = generateActions(seed);
    const first = executeSequence(seed, start, steps);
    // Same seed twice: the generator must reproduce the steps and the second
    // execution must reproduce the per-step trace.
    const regenerated = generateActions(seed);
    const replay = executeSequence(seed, regenerated.start, regenerated.steps);
    stepsExecuted += first.steps + replay.steps;
    const deterministic =
      digest(regenerated) === digest({ start, steps }) && first.traceDigest === replay.traceDigest;
    const hist = histogram(steps);
    for (const [kind, count] of Object.entries(hist)) {
      actionHistogram[kind] = (actionHistogram[kind] ?? 0) + count;
    }
    let outcome: CampaignRow["outcome"] = "ok";
    if (!deterministic) outcome = "nondeterministic";
    else if (!first.ok)
      outcome = first.failure?.invariant === "crash" ? "crash" : "invariant_failed";
    let minimized: CampaignRow["minimized"] = null;
    if (first.failure) {
      invariantHistogram[first.failure.invariant] =
        (invariantHistogram[first.failure.invariant] ?? 0) + 1;
      const small = shrinkFailure(seed, start, steps, first.failure.invariant);
      const shrunk = executeSequence(seed, start, small);
      let rerunFailures = 0;
      for (let attempt = 0; attempt < reruns; attempt += 1) {
        if (!executeSequence(seed, start, small).ok) rerunFailures += 1;
      }
      minimized = {
        steps: small,
        length: small.length,
        invariant: shrunk.failure?.invariant ?? first.failure.invariant,
        message: shrunk.failure?.message ?? first.failure.message,
        rerunFailures,
        reruns,
      };
    }
    rows.push({
      index,
      seed,
      start,
      length: steps.length,
      outcome,
      stepsCompleted: first.steps,
      traceDigest: first.traceDigest,
      replayDigest: replay.traceDigest,
      actionHistogram: hist,
      failure: first.failure,
      minimized,
    });
    options.onProgress?.(index + 1, options.iterations);
  }
  return {
    lens: "randomized-seeded",
    unit: "pkg-evaluation",
    seedBase: options.seedBase,
    iterations: options.iterations,
    minLength: MIN_SEQUENCE_LENGTH,
    maxLength: MAX_SEQUENCE_LENGTH,
    node: process.version,
    startedAtIso: new Date(startedAt).toISOString(),
    wallClockMs: Date.now() - startedAt,
    scenariosExecuted: rows.length,
    stepsExecuted,
    okCount: rows.filter((row) => row.outcome === "ok").length,
    failedSeeds: rows.filter((row) => row.outcome !== "ok").map((row) => row.seed),
    nondeterministicSeeds: rows
      .filter((row) => row.outcome === "nondeterministic")
      .map((row) => row.seed),
    invariantHistogram,
    actionHistogram,
    rows,
  };
}

function parseArgs(argv: readonly string[]): {
  iterations: number;
  seedBase: number;
  out: string | null;
  seed: number | null;
} {
  const options = {
    iterations: 200,
    seedBase: 20260904,
    out: null as string | null,
    seed: null as number | null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--iterations":
        options.iterations = Number.parseInt(value ?? "", 10);
        index += 1;
        break;
      case "--seed-base":
        options.seedBase = Number.parseInt(value ?? "", 10) >>> 0;
        index += 1;
        break;
      case "--out":
        options.out = value ?? null;
        index += 1;
        break;
      case "--seed":
        options.seed = Number.parseInt(value ?? "", 10) >>> 0;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument ${String(flag)}`);
    }
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  return options;
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  if (options.seed !== null) {
    const outcome = runSeed(options.seed);
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.ok ? 0 : 1;
  }
  let lastReported = 0;
  const result = runCampaign({
    iterations: options.iterations,
    seedBase: options.seedBase,
    onProgress: (done, total) => {
      if (done - lastReported >= 250 || done === total) {
        lastReported = done;
        process.stderr.write(`  ${done}/${total} sequences\n`);
      }
    },
  });
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`wrote ${options.out}\n`);
  }
  const summary = {
    seedBase: result.seedBase,
    scenariosExecuted: result.scenariosExecuted,
    stepsExecuted: result.stepsExecuted,
    okCount: result.okCount,
    failedSeeds: result.failedSeeds,
    nondeterministicSeeds: result.nondeterministicSeeds,
    invariantHistogram: result.invariantHistogram,
    wallClockMs: result.wallClockMs,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return result.failedSeeds.length === 0 ? 0 : 1;
}

if (process.argv[1] && /campaign\.ts$/.test(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
