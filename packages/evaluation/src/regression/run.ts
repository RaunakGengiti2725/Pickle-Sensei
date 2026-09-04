import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  REPO_ROOT,
  TSX_BIN,
  benchDefinitions,
  collectModelVersions,
  type BenchDefinition,
  type SubprocessResult,
  type SubprocessSpec,
} from "./benches.js";
import {
  REGRESSION_CONTRACT_ID,
  REGRESSION_CONTRACT_VERSION,
  REGRESSION_SUMMARY_SCHEMA_VERSION,
  flattenBenchMetrics,
  validateRegressionSummary,
  type BenchRecord,
  type DatasetReleaseRef,
  type RegressionProvenance,
  type RegressionSummary,
} from "./summarySchema.js";

export const DEFAULT_REPORT_DIR = "datasets/reports/regression";

export interface RunOptions {
  /** Directory (relative to repo root or absolute) for the single summary. */
  outDir?: string;
  /** Restrict to these bench ids (all when omitted). */
  only?: string[];
  /** Override the run id (defaults to a filesystem-safe UTC timestamp). */
  runId?: string;
  log?: (line: string) => void;
}

export interface RunResult {
  summary: RegressionSummary;
  outPath: string;
  /** Non-zero when any bench failed or the summary failed validation. */
  exitCode: 0 | 1;
}

function git(args: string[], cwd: string = REPO_ROOT): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** `datasets/` subtrees that hold bench OUTPUT (this runner's own summaries
 *  and baselines among them), so committing a report never looks like a
 *  change of bench input. */
const DATASET_OUTPUT_PREFIXES = ["reports/"];

/**
 * Identity of every committed file the benches READ under `datasets/`:
 * sha1 over the `git ls-tree -r HEAD:datasets` entries minus the output
 * subtrees. Equal for two commits iff their bench inputs are byte-identical.
 */
export function datasetsInputTreeSha(root: string = REPO_ROOT): string {
  const entries = git(["ls-tree", "-r", "HEAD:datasets"], root)
    .split("\n")
    .filter((line) => {
      const path = line.split("\t")[1] ?? "";
      return line.length > 0 && !DATASET_OUTPUT_PREFIXES.some((prefix) => path.startsWith(prefix));
    });
  return createHash("sha1").update(entries.join("\n")).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `datasets/releases/<dir>/manifest.json`, identified by id + hash. */
export function collectDatasetReleases(root: string = REPO_ROOT): DatasetReleaseRef[] {
  const releasesDir = join(root, "datasets/releases");
  if (!existsSync(releasesDir)) return [];
  const refs: DatasetReleaseRef[] = [];
  for (const dir of readdirSync(releasesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifestPath = join(releasesDir, dir.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const raw = readFileSync(manifestPath);
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!isRecord(parsed)) throw new Error(`${manifestPath}: manifest is not an object`);
    const releaseId =
      typeof parsed.releaseId === "string"
        ? parsed.releaseId
        : typeof parsed.version === "string"
          ? parsed.version
          : null;
    if (releaseId === null) {
      throw new Error(`${manifestPath}: manifest has neither releaseId nor version`);
    }
    refs.push({
      releaseDir: dir.name,
      releaseId,
      datasetId: typeof parsed.datasetId === "string" ? parsed.datasetId : null,
      manifestSha256: sha256(raw),
    });
  }
  return refs.sort((a, b) => a.releaseDir.localeCompare(b.releaseDir));
}

/**
 * Untracked files under `datasets/` outside the output subtrees. Bench
 * loaders enumerate annotation directories, so an uncommitted JSON there
 * changes metrics while `gitSha` and `datasetsTreeSha` stay the same.
 */
export function untrackedDatasetInputs(root: string = REPO_ROOT): string[] {
  return git(["ls-files", "--others", "--exclude-standard", "--", "datasets"], root)
    .split("\n")
    .filter((path) => path.length > 0)
    .map((path) => path.replace(/^datasets\//, ""))
    .filter((path) => !DATASET_OUTPUT_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .map((path) => `datasets/${path}`)
    .sort();
}

export function isTreeDirty(root: string = REPO_ROOT): boolean {
  return (
    git(["status", "--porcelain", "--untracked-files=no"], root).length > 0 ||
    untrackedDatasetInputs(root).length > 0
  );
}

export function collectProvenance(): RegressionProvenance {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    gitSha: git(["rev-parse", "HEAD"]),
    gitBranch: branch === "HEAD" ? null : branch,
    gitDirty: isTreeDirty(),
    datasetsTreeSha: datasetsInputTreeSha(),
    datasetReleases: collectDatasetReleases(),
    modelVersions: collectModelVersions(),
    evidenceClass: "linux_replay_proxy",
  };
}

export function runSubprocess(spec: SubprocessSpec): SubprocessResult {
  const result = spawnSync(TSX_BIN, [spec.script, ...spec.args], {
    cwd: spec.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** UTC timestamp safe for filenames: 2026-09-04T02-03-04.567Z */
export function timestampRunId(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-");
}

/** A run id is a single filename component: no separators, no leading dot. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid run id "${runId}": must match ${RUN_ID_PATTERN}`);
  }
  return runId;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/**
 * Runs one bench, timing it and turning any thrown error into a `failed`
 * record. `lastSubprocessExit` reports the exit code of the most recent
 * subprocess the bench spawned (null when it spawned none); in-process
 * benches always record `exitCode: null`.
 */
export function executeBench(
  definition: BenchDefinition,
  lastSubprocessExit: () => number | null,
): BenchRecord {
  const started = process.hrtime.bigint();
  const base = {
    id: definition.id,
    title: definition.title,
    kind: definition.kind,
    command: definition.command,
    cwd: relative(REPO_ROOT, definition.cwd) || ".",
    inputs: definition.inputs,
    caveats: definition.caveats,
  };
  try {
    const output = definition.run();
    const wallClockMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    return {
      ...base,
      status: "ok",
      exitCode: definition.kind === "subprocess" ? (lastSubprocessExit() ?? 0) : null,
      wallClockMs,
      error: null,
      metrics: output.metrics,
      labels: output.labels,
    };
  } catch (error) {
    const wallClockMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    return {
      ...base,
      status: "failed",
      exitCode: definition.kind === "subprocess" ? (lastSubprocessExit() ?? -1) : null,
      wallClockMs,
      error: errorText(error),
      metrics: {},
      labels: {},
    };
  }
}

export function runRegression(options: RunOptions = {}): RunResult {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runId = assertValidRunId(options.runId ?? timestampRunId());
  const outDir = options.outDir
    ? isAbsolute(options.outDir)
      ? options.outDir
      : join(REPO_ROOT, options.outDir)
    : join(REPO_ROOT, DEFAULT_REPORT_DIR);
  const outPath = join(outDir, `${runId}.json`);
  if (existsSync(outPath)) throw new Error(`refusing to overwrite existing summary ${outPath}`);

  const scratchDir = mkdtempSync(join(tmpdir(), "pickle-regression-"));
  const startedAll = process.hrtime.bigint();
  const provenance = collectProvenance();
  log(
    `regression run ${runId} @ ${provenance.gitSha.slice(0, 12)}${provenance.gitDirty ? " (dirty tree)" : ""}`,
  );

  let lastExit: number | null = null;
  const tracked = (spec: SubprocessSpec): SubprocessResult => {
    const result = runSubprocess(spec);
    lastExit = result.exitCode;
    return result;
  };

  const benches: BenchRecord[] = [];
  try {
    let definitions = benchDefinitions(tracked, scratchDir);
    if (options.only && options.only.length > 0) {
      const wanted = new Set(options.only);
      const known = new Set(definitions.map((definition) => definition.id));
      for (const id of wanted) {
        if (!known.has(id))
          throw new Error(`unknown bench id "${id}" (known: ${[...known].join(", ")})`);
      }
      definitions = definitions.filter((definition) => wanted.has(definition.id));
    }
    for (const definition of definitions) {
      lastExit = null;
      const record = executeBench(definition, () => lastExit);
      benches.push(record);
      const metricCount = Object.keys(record.metrics).length;
      log(
        `  ${record.status === "ok" ? "ok    " : "FAILED"} ${record.id.padEnd(22)} ${String(record.wallClockMs).padStart(6)}ms  ${metricCount} metrics${record.error ? `\n    ${record.error.split("\n")[0]}` : ""}`,
      );
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  const failed = benches.filter((bench) => bench.status === "failed");
  const summary: RegressionSummary = {
    schemaVersion: REGRESSION_SUMMARY_SCHEMA_VERSION,
    contract: REGRESSION_CONTRACT_ID,
    contractVersion: REGRESSION_CONTRACT_VERSION,
    runId,
    generatedAtIso: new Date().toISOString(),
    runner: { node: process.version, platform: process.platform, arch: process.arch },
    provenance,
    benches,
    metrics: flattenBenchMetrics(benches),
    caveats: [
      "All benches replay COMMITTED artifacts on Linux (Apple-Vision pose captured earlier on macOS, oracle ball, no paddle track). They are proxies for the on-device pipeline, never Mac/device results.",
      "Gold counts are small (single-digit to low tens per bench); treat every delta as a per-case finding, not a rate estimate.",
      "Abstentions are first-class outcomes. A metric value of null means 'not measurable in this run', never zero.",
      ...(provenance.gitDirty
        ? [
            "Working tree had uncommitted tracked changes: gitSha does not fully identify the measured code.",
          ]
        : []),
      ...(options.only && options.only.length > 0
        ? [
            `Partial run: only ${options.only.join(", ")} executed; not comparable to a full baseline.`,
          ]
        : []),
    ],
    totalWallClockMs: Number((process.hrtime.bigint() - startedAll) / 1_000_000n),
  };

  const validated = validateRegressionSummary(summary);
  if (!validated.ok) {
    throw new Error(`generated summary failed schema validation: ${validated.failure.message}`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(validated.value, null, 2)}\n`);
  log(`wrote ${outPath} (${summary.totalWallClockMs}ms total, ${failed.length} failed bench(es))`);
  return { summary: validated.value, outPath, exitCode: failed.length > 0 ? 1 : 0 };
}
