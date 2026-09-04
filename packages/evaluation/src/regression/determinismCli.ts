import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSummary, parseArgs, resolveUserPath } from "./cli.js";
import {
  analyzeDeterminism,
  formatDeterminismReport,
  type DeterminismReport,
  type DeterminismRunInput,
  type RunResourceUsage,
} from "./determinism.js";
import { collectResourceUsage } from "./determinismChild.js";
import { runRegression, untrackedDatasetInputs } from "./run.js";

/**
 * Determinism harness for `bench:regression`.
 *
 *   pnpm --filter @pickle/evaluation exec tsx src/regression/determinismCli.ts \
 *     run --repeats 3 --out-dir /tmp/det [--only a,b] [--mode subprocess|in-process] [--concurrency 1]
 *   pnpm --filter @pickle/evaluation exec tsx src/regression/determinismCli.ts \
 *     analyze --out /tmp/det/report.json <summary.json> <summary.json> [...]
 *
 * `run` executes the regression runner N times on the current commit —
 * by default each repeat is its own process (the same code path as
 * `bench:regression`, via determinismChild.ts, which adds a resource-usage
 * sidecar) — captures every summary, stdout/stderr log and rusage sidecar
 * under `<out-dir>/<label>/`, then analyses them. `--mode in-process`
 * calls `runRegression()` repeatedly inside one process, which additionally
 * exposes module-level state carried between runs. `--concurrency N` starts
 * N repeats at once (subprocess mode only) to probe shared-filesystem
 * collisions between simultaneous runs.
 *
 * Exit codes: 0 deterministic and every bench ok; 1 nondeterminism, a
 * failed bench, or leaked files; 2 usage / setup error. `report.json`
 * and `report.txt` are always written when analysis ran.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALUATION_DIR = resolve(HERE, "../..");
const TSX_BIN = join(EVALUATION_DIR, "node_modules/.bin/tsx");
const CHILD_SCRIPT = join(HERE, "determinismChild.ts");

const USAGE = `usage:
  determinism run --repeats <n> --out-dir <dir> [--only <benchId,...>] [--mode subprocess|in-process] [--concurrency <n>] [--label-prefix <p>]
  determinism analyze --out <report.json> <summary.json> <summary.json> [...]`;

export interface RepeatResult {
  label: string;
  summaryPath: string;
  logPath: string | null;
  exitCode: number;
  outerWallMs: number;
  rusage: RunResourceUsage | null;
  leakedDatasetFiles: string[];
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagInt(flags: Map<string, string | true>, name: string, fallback: number): number {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function resolveOutDir(outDir: string): string {
  return isAbsolute(outDir) ? outDir : resolveUserPath(outDir);
}

/** Untracked dataset inputs present now but not in `before`. */
function newUntracked(before: Set<string>): string[] {
  return untrackedDatasetInputs().filter((path) => !before.has(path));
}

interface SpawnOutcome {
  exitCode: number;
  log: string;
  outerWallMs: number;
}

function spawnChild(args: string[]): Promise<SpawnOutcome> {
  return new Promise((resolvePromise, reject) => {
    const started = process.hrtime.bigint();
    const chunks: Buffer[] = [];
    const child = spawn(TSX_BIN, [CHILD_SCRIPT, ...args], {
      cwd: EVALUATION_DIR,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({
        exitCode: code ?? (signal ? -1 : -2),
        log: Buffer.concat(chunks).toString("utf8"),
        outerWallMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
  });
}

function readRusage(path: string): RunResourceUsage | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RunResourceUsage;
}

export interface RunHarnessOptions {
  repeats: number;
  outDir: string;
  only?: string[];
  mode: "subprocess" | "in-process";
  concurrency: number;
  labelPrefix: string;
  log?: (line: string) => void;
}

async function runSubprocessRepeat(
  options: RunHarnessOptions,
  label: string,
  before: Set<string>,
): Promise<RepeatResult> {
  const repeatDir = join(options.outDir, label);
  const summaryPath = join(repeatDir, `${label}.json`);
  const logPath = join(options.outDir, `${label}.log`);
  const args = ["run", "--out-dir", repeatDir, "--run-id", label];
  if (options.only && options.only.length > 0) args.push("--only", options.only.join(","));
  const outcome = await spawnChild(args);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(logPath, outcome.log);
  return {
    label,
    summaryPath,
    logPath,
    exitCode: outcome.exitCode,
    outerWallMs: outcome.outerWallMs,
    rusage: readRusage(join(repeatDir, `${label}.rusage.json`)),
    leakedDatasetFiles: newUntracked(before),
  };
}

function runInProcessRepeat(
  options: RunHarnessOptions,
  label: string,
  before: Set<string>,
): RepeatResult {
  const repeatDir = join(options.outDir, label);
  const lines: string[] = [];
  const started = process.hrtime.bigint();
  let exitCode: number;
  let summaryPath = join(repeatDir, `${label}.json`);
  try {
    const result = runRegression({
      outDir: repeatDir,
      runId: label,
      ...(options.only && options.only.length > 0 ? { only: options.only } : {}),
      log: (line) => lines.push(line),
    });
    exitCode = result.exitCode;
    summaryPath = result.outPath;
  } catch (error) {
    lines.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    exitCode = 2;
  }
  const outerWallMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  mkdirSync(options.outDir, { recursive: true });
  const logPath = join(options.outDir, `${label}.log`);
  writeFileSync(logPath, `${lines.join("\n")}\n`);
  return {
    label,
    summaryPath,
    logPath,
    exitCode,
    outerWallMs,
    rusage: collectResourceUsage(),
    leakedDatasetFiles: newUntracked(before),
  };
}

export async function runHarness(
  options: RunHarnessOptions,
): Promise<{ repeats: RepeatResult[]; report: DeterminismReport | null; exitCode: 0 | 1 | 2 }> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (options.repeats < 2) throw new Error("--repeats must be >= 2");
  if (options.mode === "in-process" && options.concurrency > 1) {
    throw new Error("--concurrency > 1 requires --mode subprocess");
  }
  mkdirSync(options.outDir, { recursive: true });
  const labels = Array.from(
    { length: options.repeats },
    (_, index) => `${options.labelPrefix}${index + 1}`,
  );
  for (const label of labels) {
    const path = join(options.outDir, label, `${label}.json`);
    if (existsSync(path)) throw new Error(`refusing to overwrite existing summary ${path}`);
  }
  const before = new Set(untrackedDatasetInputs());
  if (before.size > 0) {
    log(
      `warning: ${before.size} untracked dataset input(s) present before the harness started; provenance.gitDirty will be true`,
    );
  }

  const repeats: RepeatResult[] = [];
  if (options.mode === "in-process") {
    for (const label of labels) {
      const result = runInProcessRepeat(options, label, before);
      repeats.push(result);
      log(`  ${label}: exit ${result.exitCode}, ${result.outerWallMs}ms`);
    }
  } else {
    for (let start = 0; start < labels.length; start += options.concurrency) {
      const batch = labels.slice(start, start + options.concurrency);
      const results = await Promise.all(
        batch.map((label) => runSubprocessRepeat(options, label, before)),
      );
      for (const result of results) {
        repeats.push(result);
        log(
          `  ${result.label}: exit ${result.exitCode}, ${result.outerWallMs}ms outer${result.rusage ? `, maxRSS ${result.rusage.maxRssKb}kB` : ""}${result.leakedDatasetFiles.length > 0 ? `, LEAKED ${result.leakedDatasetFiles.join(" ")}` : ""}`,
        );
      }
    }
  }

  writeFileSync(
    join(options.outDir, "repeats.json"),
    `${JSON.stringify({ options: { ...options, log: undefined }, repeats }, null, 2)}\n`,
  );

  const missing = repeats.filter((repeat) => !existsSync(repeat.summaryPath));
  if (missing.length > 0) {
    log(
      `no summary written for ${missing.map((repeat) => repeat.label).join(", ")} — see ${missing.map((repeat) => repeat.logPath).join(", ")}`,
    );
    return { repeats, report: null, exitCode: 2 };
  }

  const inputs: DeterminismRunInput[] = repeats.map((repeat) => ({
    label: repeat.label,
    summary: loadSummary(repeat.summaryPath),
    outerWallMs: repeat.outerWallMs,
    rusage: repeat.rusage,
    leakedDatasetFiles: repeat.leakedDatasetFiles,
  }));
  const report = analyzeDeterminism(inputs);
  writeReport(options.outDir, report, log);
  return { repeats, report, exitCode: report.deterministic && report.allBenchesOk ? 0 : 1 };
}

function writeReport(outDir: string, report: DeterminismReport, log: (line: string) => void) {
  const jsonPath = join(outDir, "report.json");
  const textPath = join(outDir, "report.txt");
  const text = formatDeterminismReport(report);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(textPath, `${text}\n`);
  log(text);
  log(`wrote ${jsonPath} and ${textPath}`);
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  const [command, ...rest] = parsed.positional;

  if (command === "run") {
    if (rest.length > 0) {
      process.stderr.write(`unexpected arguments: ${rest.join(" ")}\n${USAGE}\n`);
      return 2;
    }
    try {
      const outDir = flagString(parsed.flags, "out-dir");
      if (!outDir) throw new Error("--out-dir is required");
      const mode = flagString(parsed.flags, "mode") ?? "subprocess";
      if (mode !== "subprocess" && mode !== "in-process") {
        throw new Error(`--mode must be subprocess or in-process, got "${mode}"`);
      }
      const only = flagString(parsed.flags, "only")
        ?.split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      const result = await runHarness({
        repeats: flagInt(parsed.flags, "repeats", 3),
        outDir: resolveOutDir(outDir),
        ...(only ? { only } : {}),
        mode,
        concurrency: flagInt(parsed.flags, "concurrency", 1),
        labelPrefix: flagString(parsed.flags, "label-prefix") ?? "rep",
      });
      return result.exitCode;
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      return 2;
    }
  }

  if (command === "analyze") {
    const out = flagString(parsed.flags, "out");
    if (!out || rest.length < 2) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    try {
      const inputs: DeterminismRunInput[] = rest.map((path, index) => {
        const summaryPath = resolveUserPath(path);
        const rusagePath = summaryPath.replace(/\.json$/, ".rusage.json");
        return {
          label: `run${index + 1}`,
          summary: loadSummary(summaryPath),
          outerWallMs: null,
          rusage: rusagePath !== summaryPath ? readRusage(rusagePath) : null,
          leakedDatasetFiles: [],
        };
      });
      const report = analyzeDeterminism(inputs);
      const reportPath = resolveOutDir(out);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${formatDeterminismReport(report)}\nwrote ${reportPath}\n`);
      return report.deterministic && report.allBenchesOk ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }

  process.stderr.write(`${USAGE}\n`);
  return 2;
}

if (process.argv[1] && /determinismCli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 2;
    },
  );
}
