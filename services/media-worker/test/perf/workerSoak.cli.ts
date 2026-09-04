/**
 * CLI for the media-worker soak. One Node process, gc exposed:
 *
 *   cd services/media-worker
 *   node --expose-gc --import tsx test/perf/workerSoak.cli.ts --cycles 500 --out /tmp/media-worker-soak
 *
 * Writes into --out: report.json, <variant>-cycles.ndjson, soak.log.
 * Exit codes: 0 = ran, no finding; 2 = ran, at least one finding; 1 = harness error.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRANSCODER_VARIANTS,
  controlAdjust,
  createScratchRoot,
  deriveWorkerFindings,
  removeScratchRoot,
  runVariant,
  type TranscoderVariant,
  type VariantReport,
  type WorkerSoakReport,
} from "./workerSoak.js";
import { gcAvailable } from "./soakStats.js";

interface CliArgs {
  cycles: number;
  warmup: number;
  window: number;
  thresholdPct: number;
  out: string;
  variants: TranscoderVariant[];
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    cycles: 500,
    warmup: 20,
    window: 100,
    thresholdPct: 5,
    out: join(process.cwd(), "artifacts", "media-worker-soak"),
    variants: [...TRANSCODER_VARIANTS],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const takeNumber = (): number => {
      if (value === undefined || Number.isNaN(Number(value)))
        throw new Error(`${flag} needs a numeric value`);
      i++;
      return Number(value);
    };
    switch (flag) {
      case "--cycles":
        args.cycles = takeNumber();
        break;
      case "--warmup":
        args.warmup = takeNumber();
        break;
      case "--window":
        args.window = takeNumber();
        break;
      case "--threshold-pct":
        args.thresholdPct = takeNumber();
        break;
      case "--out":
        if (value === undefined) throw new Error("--out needs a path");
        args.out = value;
        i++;
        break;
      case "--variants": {
        if (value === undefined) throw new Error("--variants needs a comma list");
        args.variants = [];
        for (const name of value.split(",")) {
          const known = TRANSCODER_VARIANTS.find((v) => v === name);
          if (!known) throw new Error(`unknown variant '${name}'`);
          args.variants.push(known);
        }
        i++;
        break;
      }
      default:
        throw new Error(`unknown flag '${flag}'`);
    }
  }
  return args;
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const logPath = join(args.out, "soak.log");
  writeFileSync(logPath, "");
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(logPath, `${stamped}\n`);
    console.error(stamped);
  };
  const gc = gcAvailable();
  log(`media-worker-soak-1 node=${process.version} gcExposed=${gc} commit=${gitCommit() ?? "?"}`);
  log(`args ${JSON.stringify(args)}`);
  if (!gc) {
    log(
      "WARNING: global.gc is not exposed — heap numbers are un-collected and cannot support a leak verdict. Start node with --expose-gc.",
    );
  }

  // Control first: identical loop and record retention, no runOnce.
  const controlRoot = createScratchRoot();
  let control: VariantReport;
  try {
    control = await runVariant({
      variant: "none",
      cycles: args.cycles,
      warmupCycles: args.warmup,
      windowCycles: args.window,
      thresholdPer100CyclesPct: args.thresholdPct,
      scratchRoot: controlRoot,
      control: true,
    });
  } finally {
    removeScratchRoot(controlRoot);
  }
  log(
    `[control] heap: slope ${control.heap.slopeBytesPerCycle.toFixed(0)} B/cycle = ${control.heap.slopePer100CyclesPct.toFixed(3)}%/100 cycles ` +
      `(r=${control.heap.fit.r.toFixed(3)}), net Δ ${mb(control.heap.netDeltaBytes)}`,
  );

  const variants: VariantReport[] = [];
  for (const variant of args.variants) {
    const scratchRoot = createScratchRoot();
    const ndjson = join(args.out, `${variant}-cycles.ndjson`);
    writeFileSync(ndjson, "");
    try {
      const report = await runVariant({
        variant,
        cycles: args.cycles,
        warmupCycles: args.warmup,
        windowCycles: args.window,
        thresholdPer100CyclesPct: args.thresholdPct,
        scratchRoot,
        onCycle: (record) => {
          appendFileSync(ndjson, `${JSON.stringify(record)}\n`);
          if ((record.cycle + 1) % 100 === 0 || record.threw) {
            log(
              `[${variant}] cycle ${record.cycle + 1}/${args.cycles} ${record.durationMs.toFixed(2)}ms heapUsed=${mb(record.heapUsed)} ` +
                `scratchFiles=${record.scratch.files} deletes=${record.objectDeletesCumulative} queue=${record.queueDepthAfter}` +
                (record.threw ? ` THREW ${record.threw}` : ""),
            );
          }
        },
      });
      variants.push(report);
      log(
        `[${variant}] done: ${report.cycles} cycles, ${report.latency.cyclesPerSec.toFixed(0)} cycles/s, p50 ${report.latency.p50Ms.toFixed(3)}ms p95 ${report.latency.p95Ms.toFixed(3)}ms max ${report.latency.maxMs.toFixed(3)}ms; ` +
          `jobsHandled=${report.jobsHandled} leftOnQueue=${report.jobsLeftOnQueue} objectDeletes=${report.objectDeletes} readyUpdates=${report.readyUpdates} failedUpdates=${report.failedUpdates}; ` +
          `residual scratch ${report.residualScratch.files} files (${mb(report.residualScratch.bytes)}) = ${report.residualFilesPerCycle.toFixed(2)}/cycle; exceptions=${report.exceptions}`,
      );
      log(
        `[${variant}] heap (gc=${report.heap.gcAvailable}): baseline ${mb(report.heap.baselineHeapUsed)}, slope ${report.heap.slopeBytesPerCycle.toFixed(0)} B/cycle = ` +
          `${report.heap.slopePer100CyclesPct.toFixed(3)}%/100 cycles (r=${report.heap.fit.r.toFixed(3)}), net Δ ${mb(report.heap.netDeltaBytes)}, ` +
          `monotone=${report.heap.monotoneAcrossWindows} maxStep=${report.heap.maxWindowGrowthPct.toFixed(3)}% → leakSuspected=${report.heap.leakSuspected}`,
      );
      for (const w of report.heap.windows) {
        log(
          `  [${variant}] heap window ${w.fromCycle}-${w.toCycle}: median ${mb(w.medianHeapUsed)} min ${mb(w.minHeapUsed)} max ${mb(w.maxHeapUsed)}` +
            (w.growthVsPreviousPct === null ? "" : ` growth ${w.growthVsPreviousPct.toFixed(3)}%`),
        );
      }
      const [adj] = controlAdjust([report], control);
      if (adj) {
        log(
          `[${variant}] heap control-adjusted: ${adj.workloadSlopeBytesPerCycle.toFixed(0)} - ${adj.controlSlopeBytesPerCycle.toFixed(0)} = ` +
            `${adj.adjustedSlopeBytesPerCycle.toFixed(0)} B/cycle = ${adj.adjustedSlopePer100CyclesPct.toFixed(3)}%/100 cycles (threshold ${args.thresholdPct}%)`,
        );
      }
      log(`[${variant}] outcomes ${JSON.stringify(report.outcomes)}`);
    } finally {
      removeScratchRoot(scratchRoot);
    }
  }

  const findings = deriveWorkerFindings(variants, control);
  const report: WorkerSoakReport = {
    harness: "media-worker-soak-1",
    environment: {
      node: process.version,
      platform: process.platform,
      gcExposed: gc,
      execArgv: [...process.execArgv],
      startedAtIso: new Date().toISOString(),
      gitCommit: gitCommit(),
    },
    productionTranscoder: {
      configured: "null",
      note:
        "services/media-worker/src/main.ts wires transcoder: null and services/media-worker/Dockerfile installs no ffmpeg; " +
        "production temp-file behaviour is not observable from this repository. All variants above use harness fakes at the WorkerDeps.transcoder seam.",
    },
    control,
    variants,
    controlAdjusted: controlAdjust(variants, control),
    findings,
    finishedAtIso: new Date().toISOString(),
  };
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2));
  log(`findings: ${findings.length}`);
  for (const finding of findings) {
    log(
      `  FINDING [${finding.variant}] ${finding.criterion}: ${finding.detail} — replay: ${finding.replay}`,
    );
  }
  log(`report written to ${join(args.out, "report.json")}`);
  return findings.length > 0 ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      `media-worker soak harness error: ${error instanceof Error ? error.stack : String(error)}`,
    );
    process.exitCode = 1;
  },
);
