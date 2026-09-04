import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { constants as osConstants, tmpdir } from "node:os";
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

/** The two ways a working tree can fail to be identified by `gitSha` +
 *  `datasetsTreeSha`; each list holds repo-relative paths. */
export interface TreeDirt {
  /** Tracked paths with uncommitted modifications (staged or not). */
  trackedChanges: string[];
  /** Untracked files under `datasets/` outside the output subtrees. */
  untrackedDatasetInputs: string[];
}

export function describeTreeDirt(root: string = REPO_ROOT): TreeDirt {
  return {
    trackedChanges: git(["diff", "--name-only", "HEAD", "--"], root)
      .split("\n")
      .filter((line) => line.length > 0)
      .sort(),
    untrackedDatasetInputs: untrackedDatasetInputs(root),
  };
}

export function isTreeDirty(root: string = REPO_ROOT): boolean {
  const dirt = describeTreeDirt(root);
  return dirt.trackedChanges.length > 0 || dirt.untrackedDatasetInputs.length > 0;
}

const MAX_LISTED_DIRTY_PATHS = 20;

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_DIRTY_PATHS).join(", ");
  const hidden = paths.length - MAX_LISTED_DIRTY_PATHS;
  return hidden > 0 ? `${shown}, … ${hidden} more` : shown;
}

/** One caveat per kind of dirt actually present, naming the paths. */
export function dirtyTreeCaveats(dirt: TreeDirt): string[] {
  const caveats: string[] = [];
  if (dirt.trackedChanges.length > 0) {
    caveats.push(
      `Working tree had uncommitted tracked changes (${dirt.trackedChanges.length}: ${listPaths(dirt.trackedChanges)}): gitSha does not fully identify the measured code.`,
    );
  }
  if (dirt.untrackedDatasetInputs.length > 0) {
    caveats.push(
      `Working tree had untracked dataset inputs (${dirt.untrackedDatasetInputs.length}: ${listPaths(dirt.untrackedDatasetInputs)}): bench loaders enumerate these directories, so datasetsTreeSha does not fully identify the measured inputs.`,
    );
  }
  return caveats;
}

export function collectProvenance(dirt: TreeDirt = describeTreeDirt()): RegressionProvenance {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    gitSha: git(["rev-parse", "HEAD"]),
    gitBranch: branch === "HEAD" ? null : branch,
    gitDirty: dirt.trackedChanges.length > 0 || dirt.untrackedDatasetInputs.length > 0,
    datasetsTreeSha: datasetsInputTreeSha(),
    datasetReleases: collectDatasetReleases(),
    modelVersions: collectModelVersions(),
    evidenceClass: "linux_replay_proxy",
  };
}

export const HANDLED_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/** Thrown out of `runRegression` when the runner received SIGINT/SIGTERM:
 *  the children are gone, the scratch dir is removed, no summary is written. */
export class RunInterruptedError extends Error {
  readonly signal: HandledSignal;
  constructor(signal: HandledSignal) {
    super(`regression run interrupted by ${signal}`);
    this.name = "RunInterruptedError";
    this.signal = signal;
  }
  /** Shell convention: 128 + signal number (130 for SIGINT, 143 for SIGTERM). */
  get exitCode(): number {
    return 128 + osConstants.signals[this.signal];
  }
}

/**
 * Sends `signal` to the child's whole process group. `runSubprocess` spawns
 * every child as a group leader (`detached: true`), so the group covers the
 * node process `tsx` spawns underneath itself — killing only `child.pid`
 * would orphan that grandchild, which is the one running the bench script.
 */
export function killProcessGroup(child: ChildProcess, signal: HandledSignal): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    // The group can vanish between the liveness check above and the kill.
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/**
 * Runs a `tsx` script asynchronously so the runner's event loop keeps
 * turning while the child works: that is what lets a SIGINT/SIGTERM handler
 * run while a bench is still executing (with `spawnSync` the signal is only
 * seen once the child exits on its own). While the child is alive it is a
 * member of `live`, which the signal handler walks to kill process groups.
 */
export function runSubprocess(
  spec: SubprocessSpec,
  live: Set<ChildProcess> = new Set(),
): Promise<SubprocessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX_BIN, [spec.script, ...spec.args], {
      cwd: spec.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    live.add(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      live.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      live.delete(child);
      resolvePromise({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
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
export async function executeBench(
  definition: BenchDefinition,
  lastSubprocessExit: () => number | null,
): Promise<BenchRecord> {
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
    const output = await definition.run();
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

/**
 * Runs the selected benches and writes one summary. Rejects with
 * `RunInterruptedError` when SIGINT/SIGTERM arrives mid-run: every live child
 * process group is killed, the scratch dir is removed and no summary is
 * written, so an interrupted run leaves nothing behind.
 */
export async function runRegression(options: RunOptions = {}): Promise<RunResult> {
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
  const dirt = describeTreeDirt();
  const provenance = collectProvenance(dirt);
  log(
    `regression run ${runId} @ ${provenance.gitSha.slice(0, 12)}${provenance.gitDirty ? " (dirty tree)" : ""}`,
  );

  const liveChildren = new Set<ChildProcess>();
  let interruptedBy: HandledSignal | null = null;
  const onSignal = (signal: HandledSignal): void => {
    interruptedBy ??= signal;
    for (const child of liveChildren) killProcessGroup(child, signal);
  };
  const throwIfInterrupted = (): void => {
    if (interruptedBy !== null) throw new RunInterruptedError(interruptedBy);
  };

  let lastExit: number | null = null;
  const tracked = async (spec: SubprocessSpec): Promise<SubprocessResult> => {
    const result = await runSubprocess(spec, liveChildren);
    lastExit = result.exitCode;
    return result;
  };

  const benches: BenchRecord[] = [];
  for (const signal of HANDLED_SIGNALS) process.on(signal, onSignal);
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
      throwIfInterrupted();
      lastExit = null;
      const record = await executeBench(definition, () => lastExit);
      throwIfInterrupted();
      benches.push(record);
      const metricCount = Object.keys(record.metrics).length;
      log(
        `  ${record.status === "ok" ? "ok    " : "FAILED"} ${record.id.padEnd(22)} ${String(record.wallClockMs).padStart(6)}ms  ${metricCount} metrics${record.error ? `\n    ${record.error.split("\n")[0]}` : ""}`,
      );
    }
  } finally {
    for (const signal of HANDLED_SIGNALS) process.off(signal, onSignal);
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
      ...dirtyTreeCaveats(dirt),
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
