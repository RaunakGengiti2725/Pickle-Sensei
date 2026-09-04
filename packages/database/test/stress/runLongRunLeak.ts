import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  ITERATION_MODES,
  replayIteration,
  resultDigest,
  runCampaign,
  type Profile,
} from "./longRunLeakHarness.js";

/**
 * Standalone runner for the long-run leak campaign (same harness as the
 * vitest suite, but with a real `--expose-gc` process and a JSON report):
 *
 *   cd packages/database
 *   DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
 *   node --expose-gc --import tsx test/stress/runLongRunLeak.ts \
 *     --iterations 500 --seed 1 --profile mixed --sample-every 50 --out /tmp/leak/mixed.json
 *
 * Replay one iteration of a campaign by index:
 *
 *   node --import tsx test/stress/runLongRunLeak.ts --seed 1 --profile mixed --replay 137
 *
 * Exit code 0 only when every verdict holds; 1 otherwise; 2 on usage errors.
 */

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "500" },
    seed: { type: "string", default: "1" },
    profile: { type: "string", default: "mixed" },
    "sample-every": { type: "string", default: "50" },
    "heap-slope-limit": { type: "string", default: "0.05" },
    out: { type: "string" },
    replay: { type: "string" },
  },
});

function int(name: string, raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive integer (got ${raw})`);
    process.exit(2);
  }
  return n;
}

const databaseUrl = process.env["DATABASE_URL_TEST"];
if (!databaseUrl) {
  console.error(
    "DATABASE_URL_TEST is not set (e.g. postgres://pickle:pickle_test_password@localhost:5433/pickle_test)",
  );
  process.exit(2);
}

const profileRaw = values.profile ?? "mixed";
if (profileRaw !== "mixed" && !(ITERATION_MODES as readonly string[]).includes(profileRaw)) {
  console.error(`--profile must be mixed or one of ${ITERATION_MODES.join(", ")}`);
  process.exit(2);
}
const profile = profileRaw as Profile;
const masterSeed = int("seed", values.seed ?? "1");

if (values.replay !== undefined) {
  const row = await replayIteration(databaseUrl, masterSeed, int("replay", values.replay), profile);
  console.warn(JSON.stringify(row, null, 2));
  process.exit(row.outcome === "ok" ? 0 : 1);
}

const result = await runCampaign({
  databaseUrl,
  iterations: int("iterations", values.iterations ?? "500"),
  masterSeed,
  profile,
  sampleEvery: int("sample-every", values["sample-every"] ?? "50"),
  heapSlopeLimitPer100: Number(values["heap-slope-limit"] ?? "0.05"),
  log: (line) => console.warn(line),
});

const report = { ...result, digest: resultDigest(result) };
if (values.out) {
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(report, null, 2));
  console.warn(`wrote ${values.out}`);
}

console.warn(
  JSON.stringify(
    { verdicts: report.verdicts, analysis: report.analysis, digest: report.digest },
    null,
    2,
  ),
);
const ok = Object.values(report.verdicts).every(Boolean);
process.exit(ok ? 0 : 1);
