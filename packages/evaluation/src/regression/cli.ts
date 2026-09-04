import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { compareSummaries, formatCompareReport } from "./compare.js";
import { REPO_ROOT } from "./benches.js";
import { DEFAULT_REPORT_DIR, runRegression } from "./run.js";
import { validateRegressionSummary, type RegressionSummary } from "./summarySchema.js";
import { validateToleranceConfig, type ToleranceConfig } from "./tolerances.js";

/**
 * pnpm --filter @pickle/evaluation bench:regression [--out-dir <dir>] [--only a,b]
 * pnpm --filter @pickle/evaluation bench:compare <baseline.json> <candidate.json> [--tolerances <path>] [--json]
 *
 * Exit codes — run: 0 all benches ok, 1 a bench failed (summary still written),
 * 2 usage / setup error.  compare: 0 no regressions beyond tolerance,
 * 1 regressions, 2 usage or invalid input, 3 non-comparable documents.
 */
export const DEFAULT_TOLERANCES_PATH = "packages/evaluation/regression.tolerances.json";

const USAGE = `usage:
  bench:regression run [--out-dir <dir>] [--only <benchId,...>] [--run-id <id>]
  bench:compare compare <baseline.json> <candidate.json> [--tolerances <path>] [--json]`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * `pnpm --filter <pkg> <script>` runs the script with cwd = the package dir but
 * exports the directory pnpm was invoked from as INIT_CWD. User-supplied paths
 * are resolved against that directory so repo-relative arguments work.
 */
export function resolveUserPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(path)) return path;
  return resolve(env.INIT_CWD ?? process.cwd(), path);
}

export function loadSummary(path: string): RegressionSummary {
  const validated = validateRegressionSummary(readJson(path));
  if (!validated.ok) throw new Error(`${path}: ${validated.failure.message}`);
  return validated.value;
}

export function loadTolerances(path: string): ToleranceConfig {
  const validated = validateToleranceConfig(readJson(path));
  if (!validated.ok) throw new Error(`${path}: ${validated.failure.message}`);
  return validated.value;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (name === "json") {
      flags.set(name, true);
    } else if (next === undefined || next.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }
  return { positional, flags };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function main(argv: string[]): number {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const [command, ...rest] = parsed.positional;

  if (command === "run") {
    if (rest.length > 0) {
      console.error(`unexpected arguments: ${rest.join(" ")}\n${USAGE}`);
      return 2;
    }
    try {
      const only = flagString(parsed.flags, "only")
        ?.split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      const runId = flagString(parsed.flags, "run-id");
      const outDir = flagString(parsed.flags, "out-dir");
      const result = runRegression({
        outDir: outDir ? resolveUserPath(outDir) : DEFAULT_REPORT_DIR,
        ...(only ? { only } : {}),
        ...(runId ? { runId } : {}),
      });
      return result.exitCode;
    } catch (error) {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      return 2;
    }
  }

  if (command === "compare") {
    const [baselinePath, candidatePath, ...extra] = rest;
    if (!baselinePath || !candidatePath || extra.length > 0) {
      console.error(USAGE);
      return 2;
    }
    try {
      const tolerancesPath = flagString(parsed.flags, "tolerances");
      const config = loadTolerances(
        tolerancesPath ? resolveUserPath(tolerancesPath) : join(REPO_ROOT, DEFAULT_TOLERANCES_PATH),
      );
      const baseline = loadSummary(resolveUserPath(baselinePath));
      const candidate = loadSummary(resolveUserPath(candidatePath));
      const report = compareSummaries(baseline, candidate, config);
      if (parsed.flags.get("json") === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatCompareReport(baseline, candidate, report)}\n`);
      }
      return report.exitCode;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  console.error(USAGE);
  return 2;
}

const isMain = process.argv[1]?.endsWith("cli.ts") === true;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
