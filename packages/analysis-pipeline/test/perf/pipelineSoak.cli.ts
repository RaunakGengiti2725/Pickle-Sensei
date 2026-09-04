/**
 * CLI for the pipeline soak harness. Run it in ONE Node process with gc exposed:
 *
 *   cd packages/analysis-pipeline
 *   node --expose-gc --import ../evaluation/node_modules/tsx/dist/loader.mjs \
 *     test/perf/pipelineSoak.cli.ts --runs 500 --out /tmp/pipeline-soak
 *
 * (tsx is resolved from @pickle/evaluation's devDependencies; analysis-pipeline
 * itself deliberately has no runtime deps beyond the workspace packages.)
 *
 * Writes into --out:
 *   report.json            full report (options, per-run records, heap verdicts, findings)
 *   capture-runs.ndjson    one line per analyzeCapture run (seed, latency, heap, outcome)
 *   clip-runs.ndjson       one line per analyzeClip run
 *   session-windows.ndjson one line per live-session push window
 *   heap-windows.json      per-100-run heap window table for analyzeCapture
 *   soak.log               human-readable progress + verdict
 *
 * Exit codes: 0 = ran, no finding; 2 = ran, at least one finding; 1 = harness error.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  controlAdjust,
  deriveFindings,
  describeEnvironment,
  runCaptureSoak,
  runClipSoak,
  runSessionSoak,
  type SoakReport,
} from "./pipelineSoak.js";

interface CliArgs {
  runs: number;
  baseSeed: number;
  warmup: number;
  window: number;
  thresholdPct: number;
  out: string;
  providersPerRun: boolean;
  scenarios: Set<"capture" | "clip" | "session">;
  sessionStrokes: number;
  sessionFps: number;
  sessionStrokeEveryMs: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    runs: 500,
    baseSeed: 1_000,
    warmup: 20,
    window: 100,
    thresholdPct: 5,
    out: join(process.cwd(), "artifacts", "pipeline-soak"),
    providersPerRun: true,
    scenarios: new Set(["capture", "clip", "session"]),
    sessionStrokes: 500,
    sessionFps: 60,
    sessionStrokeEveryMs: 1_500,
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
      case "--runs":
        args.runs = takeNumber();
        break;
      case "--seed":
        args.baseSeed = takeNumber();
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
      case "--shared-providers":
        args.providersPerRun = false;
        break;
      case "--scenarios": {
        if (value === undefined) throw new Error("--scenarios needs a comma list");
        args.scenarios = new Set();
        for (const name of value.split(",")) {
          if (name === "capture" || name === "clip" || name === "session") args.scenarios.add(name);
          else throw new Error(`unknown scenario '${name}'`);
        }
        i++;
        break;
      }
      case "--session-strokes":
        args.sessionStrokes = takeNumber();
        break;
      case "--session-fps":
        args.sessionFps = takeNumber();
        break;
      case "--session-stroke-every-ms":
        args.sessionStrokeEveryMs = takeNumber();
        break;
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
  const environment = describeEnvironment(gitCommit());
  log(
    `pipeline-soak-1 node=${environment.node} gcExposed=${environment.gcExposed} commit=${environment.gitCommit ?? "?"}`,
  );
  log(`args ${JSON.stringify({ ...args, scenarios: [...args.scenarios] })}`);
  if (!environment.gcExposed) {
    log(
      "WARNING: global.gc is not exposed — heap numbers are un-collected and cannot support a leak verdict. Start node with --expose-gc.",
    );
  }

  const partial: Omit<SoakReport, "findings" | "finishedAtIso"> = {
    harness: "pipeline-soak-1",
    environment,
    control: null,
    captureControlAdjusted: null,
    capture: null,
    clip: null,
    session: null,
  };

  if (args.scenarios.has("capture")) {
    // Control first: same loop, same record retention, no analyzeCapture.
    partial.control = await runCaptureSoak({
      runs: args.runs,
      baseSeed: args.baseSeed,
      warmupRuns: args.warmup,
      windowRuns: args.window,
      thresholdPer100RunsPct: args.thresholdPct,
      providersPerRun: args.providersPerRun,
      noop: true,
    });
    log(
      `control (noop loop) heap: slope ${partial.control.heap.slopeBytesPerRun.toFixed(0)} B/run = ` +
        `${partial.control.heap.slopePer100RunsPct.toFixed(3)}%/100 runs (r=${partial.control.heap.fit.r.toFixed(3)}), net Δ ${mb(partial.control.heap.netDeltaBytes)}`,
    );
    const ndjson = join(args.out, "capture-runs.ndjson");
    writeFileSync(ndjson, "");
    partial.capture = await runCaptureSoak({
      runs: args.runs,
      baseSeed: args.baseSeed,
      warmupRuns: args.warmup,
      windowRuns: args.window,
      thresholdPer100RunsPct: args.thresholdPct,
      providersPerRun: args.providersPerRun,
      onRun: (record) => {
        appendFileSync(ndjson, `${JSON.stringify(record)}\n`);
        if ((record.run + 1) % 50 === 0 || record.threw) {
          log(
            `capture run ${record.run + 1}/${args.runs} seed=${record.seed} declared=${record.input.declared} ` +
              `outcome=${record.outcome} ${record.durationMs.toFixed(2)}ms heapUsed=${mb(record.heap.heapUsed)} rss=${mb(record.heap.rss)}` +
              (record.threw ? ` THREW ${record.threw}` : ""),
          );
        }
      },
    });
    const c = partial.capture;
    partial.captureControlAdjusted = controlAdjust(c.heap, partial.control.heap);
    log(
      `capture done: ${c.latency.runs} runs in ${c.latency.totalMs.toFixed(0)}ms → ${c.latency.throughputPerSec.toFixed(1)} analyses/s; ` +
        `p50 ${c.latency.p50Ms.toFixed(2)}ms p95 ${c.latency.p95Ms.toFixed(2)}ms p99 ${c.latency.p99Ms.toFixed(2)}ms max ${c.latency.maxMs.toFixed(2)}ms; ` +
        `latency slope ${(c.latency.latencySlopeMsPerRun * 1000).toFixed(2)}µs/run`,
    );
    log(
      `capture heap (gc=${c.heap.gcAvailable}): baseline ${mb(c.heap.baselineHeapUsed)}, slope ${c.heap.slopeBytesPerRun.toFixed(0)} B/run ` +
        `= ${c.heap.slopePer100RunsPct.toFixed(3)}%/100 runs (r=${c.heap.fit.r.toFixed(3)}), net Δ ${mb(c.heap.netDeltaBytes)}, ` +
        `windows monotone=${c.heap.monotoneAcrossWindows} maxStep=${c.heap.maxWindowGrowthPct.toFixed(3)}% → raw leakSuspected=${c.heap.leakSuspected}`,
    );
    const adj = partial.captureControlAdjusted;
    log(
      `capture heap control-adjusted: ${adj.workloadSlopeBytesPerRun.toFixed(0)} - ${adj.controlSlopeBytesPerRun.toFixed(0)} = ` +
        `${adj.adjustedSlopeBytesPerRun.toFixed(0)} B/run = ${adj.adjustedSlopePer100RunsPct.toFixed(3)}%/100 runs (threshold ${args.thresholdPct}%)`,
    );
    for (const w of c.heap.windows) {
      log(
        `  heap window runs ${w.fromRun}-${w.toRun}: median ${mb(w.medianHeapUsed)} min ${mb(w.minHeapUsed)} max ${mb(w.maxHeapUsed)}` +
          (w.growthVsPreviousPct === null ? "" : ` growth ${w.growthVsPreviousPct.toFixed(3)}%`),
      );
    }
    log(`capture outcomes ${JSON.stringify(c.outcomes)}`);
    log(`capture byDeclared ${JSON.stringify(c.byDeclared)}`);
    writeFileSync(join(args.out, "heap-windows.json"), JSON.stringify(c.heap, null, 2));
  }

  if (args.scenarios.has("clip")) {
    partial.clip = await runClipSoak({
      runs: args.runs,
      baseSeed: args.baseSeed,
      warmupRuns: args.warmup,
      windowRuns: args.window,
      thresholdPer100RunsPct: args.thresholdPct,
    });
    const c = partial.clip;
    writeFileSync(
      join(args.out, "clip-runs.ndjson"),
      c.records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    log(
      `clip done: ${c.latency.runs} runs → ${c.latency.throughputPerSec.toFixed(1)}/s; p50 ${c.latency.p50Ms.toFixed(2)}ms p95 ${c.latency.p95Ms.toFixed(2)}ms; ` +
        `heap slope ${c.heap.slopePer100RunsPct.toFixed(3)}%/100 runs monotone=${c.heap.monotoneAcrossWindows} leakSuspected=${c.heap.leakSuspected}; outcomes ${JSON.stringify(c.outcomes)}`,
    );
  }

  if (args.scenarios.has("session")) {
    partial.session = runSessionSoak({
      seed: args.baseSeed,
      strokes: args.sessionStrokes,
      fps: args.sessionFps,
      strokeEveryMs: args.sessionStrokeEveryMs,
      windowSamples: 1_000,
    });
    const s = partial.session;
    writeFileSync(
      join(args.out, "session-windows.ndjson"),
      s.windows.map((w) => JSON.stringify(w)).join("\n") + "\n",
    );
    log(
      `session done: ${s.samples} samples (${(s.sessionDurationMs / 1000).toFixed(0)}s of session at ${s.options.fps}fps), ` +
        `${s.eventsClosed} events closed live + ${s.flushClosed} on flush; total push time ${s.totalPushMs.toFixed(0)}ms; ` +
        `push cost first window ${s.windows[0]?.pushMeanUs.toFixed(1) ?? "?"}µs → last ${s.windows[s.windows.length - 1]?.pushMeanUs.toFixed(1) ?? "?"}µs ` +
        `(×${s.lastToFirstWindowRatio.toFixed(2)}, slope ${s.pushCostFit.slope.toFixed(4)}µs/sample, r=${s.pushCostFit.r.toFixed(3)}); ` +
        `last-window mean = ${(s.lastWindowMeanPushShareOfFrameBudget * 100).toFixed(1)}% of frame budget` +
        (s.projectedFrameBudgetExhaustionAtSample === null
          ? ""
          : `, fitted cost = full frame budget at sample ${s.projectedFrameBudgetExhaustionAtSample}`) +
        `; gc'd heap ${mb(s.heapFirstWindow)} → ${mb(s.heapLastWindow)} = ${s.retainedBytesPerSample.toFixed(0)} B retained/sample (series retained by design)` +
        (s.threw ? ` THREW ${s.threw}` : ""),
    );
    for (const w of s.windows) {
      log(
        `  session window ${w.fromSample}-${w.toSample}: mean ${w.pushMeanUs.toFixed(1)}µs p95 ${w.pushP95Us.toFixed(1)}µs max ${w.pushMaxUs.toFixed(1)}µs events ${w.eventsClosed} heap ${mb(w.heapUsedAfterWindow)}`,
      );
    }
  }

  const findings = deriveFindings(partial);
  const report: SoakReport = { ...partial, findings, finishedAtIso: new Date().toISOString() };
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2));
  log(`findings: ${findings.length}`);
  for (const finding of findings) {
    log(
      `  FINDING [${finding.scenario}] ${finding.criterion}: ${finding.detail} — replay: ${finding.replay}`,
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
      `pipeline-soak harness error: ${error instanceof Error ? error.stack : String(error)}`,
    );
    process.exitCode = 1;
  },
);
