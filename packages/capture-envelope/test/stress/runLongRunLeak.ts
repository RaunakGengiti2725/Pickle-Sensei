import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  clipCampaign,
  envelopeCampaign,
  g08Campaign,
  hasFfmpeg,
  labelFileCampaign,
  pixelCampaign,
} from "./campaigns.js";
import { runCampaign, seedTable, type CampaignReport } from "./leakHarness.js";

/**
 * Long-run leak campaign runner (CLI). From packages/capture-envelope:
 *
 *   node --expose-gc --import tsx test/stress/runLongRunLeak.ts \
 *     --iterations 500 --clip-iterations 500 --seed 20260904 \
 *     --out-dir ../../artifacts/stress/capture-envelope/long-run-leak/<run>
 *
 * Writes <campaign>.report.json (full samples + per-iteration results),
 * <campaign>.seeds.json (seed → outcome table) and summary.json. Exit code 1
 * when any campaign has a BROKEN iteration, a heap leak, resources that did
 * not return to baseline, or time drift; 0 otherwise. Nothing here is
 * skipped silently: an unavailable ffmpeg is reported as "unavailable".
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const iterations = Number(arg("iterations", "500"));
const clipIterations = Number(arg("clip-iterations", "500"));
const seed = Number(arg("seed", "20260904"));
const outDir = resolve(
  arg(
    "out-dir",
    join(
      "..",
      "..",
      "artifacts",
      "stress",
      "capture-envelope",
      "long-run-leak",
      `run-${Date.now()}`,
    ),
  ),
);
const only = arg(
  "campaigns",
  "control,envelope-finite,envelope-pathological,pixel,g08,label-file,clip",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(outDir, { recursive: true });

const gcExposed = typeof (globalThis as { gc?: unknown }).gc === "function";
console.log(`node ${process.version} expose-gc=${gcExposed} out=${outDir}`);

interface CampaignSummary {
  name: string;
  status: "HELD" | "BROKEN" | "unavailable";
  executed: number;
  held: number;
  broken: number;
  heapBaselineBytes: number | null;
  heapFinalBytes: number | null;
  heapSlopePer100Relative: number | null;
  heapLeak: boolean | null;
  resourcesReturnedToBaseline: boolean | null;
  timeDriftRatio: number | null;
  timeDrift: boolean | null;
  firstBrokenSeeds: number[];
  violationClasses: Record<string, number>;
  wallMs: number | null;
  reportFile: string | null;
}

function summarize(report: CampaignReport): CampaignSummary {
  const classes: Record<string, number> = {};
  for (const r of report.results) {
    for (const v of r.violations) {
      const cls = v.split(":")[0]!.replace(/\d+/g, "#");
      classes[cls] = (classes[cls] ?? 0) + 1;
    }
  }
  const reportFile = join(outDir, `${report.name}.report.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  writeFileSync(
    join(outDir, `${report.name}.seeds.json`),
    JSON.stringify(seedTable(report), null, 2),
  );
  const flagged =
    report.broken > 0 ||
    report.leak.heapLeak ||
    !report.leak.resourcesReturnedToBaseline ||
    report.leak.timeDrift;
  return {
    name: report.name,
    status: flagged ? "BROKEN" : "HELD",
    executed: report.executed,
    held: report.held,
    broken: report.broken,
    heapBaselineBytes: report.leak.heapBaseline,
    heapFinalBytes: report.leak.heapFinal,
    heapSlopePer100Relative: report.leak.heapSlopePer100Relative,
    heapLeak: report.leak.heapLeak,
    resourcesReturnedToBaseline: report.leak.resourcesReturnedToBaseline,
    timeDriftRatio: report.leak.timeDriftRatio,
    timeDrift: report.leak.timeDrift,
    firstBrokenSeeds: report.results
      .filter((r) => r.outcome === "BROKEN")
      .slice(0, 10)
      .map((r) => r.seed),
    violationClasses: classes,
    wallMs: report.wallMs,
    reportFile,
  };
}

const summaries: CampaignSummary[] = [];
const run = (name: string, fn: () => CampaignReport): void => {
  if (!only.includes(name)) return;
  console.log(`▶ ${name}`);
  const summary = summarize(fn());
  console.log(
    `  ${summary.status} executed=${summary.executed} broken=${summary.broken} heapSlope/100=${(
      (summary.heapSlopePer100Relative ?? 0) * 100
    ).toFixed(
      2,
    )}% resourcesOk=${summary.resourcesReturnedToBaseline} drift=${summary.timeDriftRatio?.toFixed(2)} wall=${Math.round(summary.wallMs ?? 0)}ms`,
  );
  summaries.push(summary);
};

// Harness floor: no unit code runs; only the harness's own per-iteration
// bookkeeping (result record + ~450-char scenario echo) is retained. Any unit
// campaign whose heap slope is at or below this one is attributable to the
// harness, not to the unit under test.
run("control", () =>
  runCampaign({
    name: "control-noop",
    campaignSeed: seed,
    iterations,
    iterate: (iterationSeedValue) => ({
      violations: [],
      scenario: `noop seed=${iterationSeedValue} ${"x".repeat(430)}`,
    }),
  }),
);
run("envelope-finite", () => envelopeCampaign(seed, iterations, "finite"));
run("envelope-pathological", () => envelopeCampaign(seed + 1, iterations, "pathological"));
run("pixel", () => pixelCampaign(seed + 2, iterations));
run("g08", () => g08Campaign(seed + 3, iterations));
run("label-file", () => labelFileCampaign(seed + 4, iterations));
if (only.includes("clip")) {
  if (hasFfmpeg) run("clip", () => clipCampaign(seed + 5, clipIterations));
  else {
    console.log("▶ clip: ffmpeg/ffprobe unavailable — NOT run (not a pass)");
    summaries.push({
      name: "clip-prober",
      status: "unavailable",
      executed: 0,
      held: 0,
      broken: 0,
      heapBaselineBytes: null,
      heapFinalBytes: null,
      heapSlopePer100Relative: null,
      heapLeak: null,
      resourcesReturnedToBaseline: null,
      timeDriftRatio: null,
      timeDrift: null,
      firstBrokenSeeds: [],
      violationClasses: {},
      wallMs: null,
      reportFile: null,
    });
  }
}

const summary = {
  tool: "capture-envelope long-run-leak stress harness",
  node: process.version,
  exposeGc: gcExposed,
  campaignSeed: seed,
  iterations,
  clipIterations,
  scenariosExecuted: summaries.reduce((acc, s) => acc + s.executed, 0),
  campaigns: summaries,
  finishedAtIso: new Date().toISOString(),
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`summary → ${join(outDir, "summary.json")}`);
process.exitCode = summaries.some((s) => s.status !== "HELD") ? 1 : 0;
