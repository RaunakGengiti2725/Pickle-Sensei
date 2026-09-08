// Edge Function served-bundle size + cold-start measurement.
//
// Measures the shipping Supabase Edge Function (supabase/functions/api/index.ts)
// LOCALLY and writes a reproducible report:
//
//   1. Served bundle: `deno bundle --platform deno` (Deno's esbuild-backed bundler)
//      over the real entrypoint with the function's own deno.json import map and
//      lockfile. The bundler labels every inlined npm module with its path
//      RELATIVE TO THE CWD (`// ../../.cache/deno/npm/registry.npmjs.org/…` and the
//      matching `__commonJS({ "…"(exports, module) {` keys), so the raw output is a
//      property of where the checkout sits relative to $DENO_DIR. The script
//      rewrites that cwd→DENO_DIR prefix to the literal `$DENO_DIR/` before
//      measuring and serving, so bytes, gzip bytes and sha256 identify
//      (commit, deno.lock, Deno version) and are the same on every checkout path.
//      The pre-rewrite byte count is kept in the report for reference only.
//   2. Source graph: `deno info --json` over the same entrypoint. Reports the
//      first-party (file:) module count/bytes and the npm packages in the graph,
//      i.e. what `supabase functions deploy` uploads before the platform bundles it.
//   3. Cold start: `supabase functions serve --no-verify-jwt` against the local
//      stack (Postgres + Kong from `supabase start`), one fresh edge-runtime
//      container per cycle. Per cycle: time from spawning the CLI until the
//      runtime's main service answers `/functions/v1/_internal/health`, then the
//      latency of the FIRST `GET /functions/v1/api/healthz` (user-worker creation +
//      module evaluation + handler = cold start), then N warm requests.
//      Two serve targets are attempted:
//        - "bundle": a generated workdir whose function entrypoint is the bundle
//          from step 1. This is the target the acceptance measurement relies on.
//        - "source-tree": the repo checkout itself (what a developer would run).
//      A target whose CLI process exits before the runtime is healthy is reported
//      as UNAVAILABLE with the CLI's own message; a target whose later cycle fails
//      is reported as PARTIAL with every completed cycle kept. Neither is ever
//      counted as a full sample.
//
// Evidence durability: report.json is (re)written after every completed step and
// every completed cycle, so a run that fails or is interrupted part-way still
// leaves the bundle metrics, the source graph and every measured cycle on disk
// with `status` ≠ "measured" and `ok: false`; only the exit code signals failure.
//
// Process hygiene: SIGINT/SIGTERM/SIGHUP interrupt the whole CLI process tree the
// script spawned (npx → sh → node/supabase), remove the edge-runtime container it
// created, persist the report as "interrupted" and exit 128+signal. Before serving,
// the script refuses to run while another `supabase functions serve` process
// exists (same port and container name), instead of measuring against it.
//
// This proves nothing about the hosted project (ucqnaiwqwjtgvlduiuib); it never
// contacts it. Numbers are for the local containerised runtime on this machine.
//
// Prerequisites: Docker, Node/npx (the pinned Supabase CLI is fetched via
// `npx --yes supabase@<version>`), network access for the first image pull.
// If the local stack is not running the script starts the minimal one it needs
// (`supabase start -x <everything except db and kong>`) and leaves it running;
// stop it with `npx --yes supabase@<version> stop`.
//
// Run (from the repo root):
//   deno run -A tools/diagnostics/edge_cold_start.ts [--cycles N] [--warm-requests N]
//     [--out DIR] [--startup-timeout-ms N]
// Self-tests (pure helpers + process-tree / partial-report / bundle-identity
// regressions; the bundle test runs `deno bundle` twice, no Docker needed):
//   deno test -A tools/diagnostics/edge_cold_start.ts
//
// Artifacts: artifacts/edge-cold-start/<UTC>/report.json, the bundle, the
// generated serve workdir, and one CLI log per serve cycle (artifacts/ is
// git-ignored).
//
// Exit code: 0 only when the bundle was measured AND the "bundle" serve target
// produced a cold-start sample for every requested cycle; 1 when the measurement
// failed (report.json still written when possible); 2 on a usage error;
// 128+signal when interrupted.

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Root eslint forbids console.log in *.ts; this diagnostic's report IS its stdout.
const print = (line: string): void => {
  Deno.stdout.writeSync(encoder.encode(`${line}\n`));
};

export const DEFAULT_SUPABASE_CLI_VERSION = "2.117.0";
export const SUPABASE_CLI_VERSION_ENV = "EDGE_COLD_START_SUPABASE_CLI_VERSION";
export const FUNCTION_SLUG = "api";
export const FUNCTION_DIR = "supabase/functions/api";
export const FUNCTION_ENTRYPOINT = `${FUNCTION_DIR}/index.ts`;
export const FUNCTION_DENO_CONFIG = `${FUNCTION_DIR}/deno.json`;
export const DEFAULT_API_PORT = 54321;
/** Literal that replaces the cwd-relative path to $DENO_DIR inside the bundle. */
export const DENO_DIR_PLACEHOLDER = "$DENO_DIR";
/** Services `supabase start` must NOT bring up: only Postgres and Kong are needed. */
export const START_EXCLUDED_SERVICES = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
] as const;
/** Exit codes: measurement failed / usage error; signals exit 128+n. */
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const SIGNAL_NUMBERS: Readonly<Partial<Record<Deno.Signal, number>>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};
export const HANDLED_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
] as const satisfies readonly Deno.Signal[];

export interface Options {
  cycles: number;
  warmRequests: number;
  outDir: string | null;
  startupTimeoutMs: number;
}

export const DEFAULT_OPTIONS: Options = {
  cycles: 3,
  warmRequests: 10,
  outDir: null,
  startupTimeoutMs: 180_000,
};

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { ...DEFAULT_OPTIONS };
  const positiveInt = (flag: string, raw: string | undefined): number => {
    if (raw === undefined) {
      throw new UsageError(`${flag} requires a value`);
    }
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
      throw new UsageError(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--cycles":
        options.cycles = positiveInt(flag, value);
        index += 1;
        break;
      case "--warm-requests":
        options.warmRequests = positiveInt(flag, value);
        index += 1;
        break;
      case "--startup-timeout-ms":
        options.startupTimeoutMs = positiveInt(flag, value);
        index += 1;
        break;
      case "--out":
        if (value === undefined || value.length === 0 || value.startsWith("-")) {
          throw new UsageError(`--out requires a directory, got ${JSON.stringify(value ?? "")}`);
        }
        options.outDir = value;
        index += 1;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return options;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** `Bundled 62 modules in 74ms` → 62. */
export function parseBundledModuleCount(bundlerOutput: string): number | null {
  const match = /Bundled (\d+) modules? in/.exec(stripAnsi(bundlerOutput));
  return match === null ? null : Number(match[1]);
}

export interface RuntimeVersion {
  edgeRuntime: string;
  denoCompat: string;
}

/** `Using supabase-edge-runtime-1.74.3 (compatible with Deno v2.1.4)`. */
export function parseEdgeRuntimeVersion(serveLog: string): RuntimeVersion | null {
  const match = /Using (supabase-edge-runtime-[^\s()]+) \(compatible with (Deno v[^)]+)\)/.exec(
    stripAnsi(serveLog),
  );
  return match === null ? null : { edgeRuntime: match[1], denoCompat: match[2] };
}

export interface TomlEntry {
  /** Dotted table path ("" for the root table). */
  table: string;
  key: string;
  /** Raw TOML value text, comment stripped. */
  value: string;
}

/** Split `text` on `separator` characters that are outside quoted strings. */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      current += char;
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        current += text[index + 1];
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === separator) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

const TOML_KEY_VALUE = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/;

function joinTomlPath(table: string, key: string): string {
  return table.length === 0 ? key : `${table}.${key}`;
}

/**
 * Enumerate scalar entries of the config.toml subset the Supabase CLI writes:
 * `[table]` / `[[array]]` headers, `key = value`, dotted keys (`api.port = 1`)
 * and inline tables (`api = { port = 1 }`), with `#` comments removed.
 */
export function scanTomlEntries(toml: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  let table = "";
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = splitOutsideQuotes(rawLine, "#")[0].trim();
    if (line.length === 0) {
      continue;
    }
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header !== null) {
      table = header[1].trim();
      continue;
    }
    const kv = TOML_KEY_VALUE.exec(line);
    if (kv === null) {
      continue;
    }
    const keyPath = kv[1];
    const value = kv[2].trim();
    const inline = /^\{(.*)\}$/.exec(value);
    if (inline !== null) {
      for (const part of splitOutsideQuotes(inline[1], ",")) {
        const sub = TOML_KEY_VALUE.exec(part.trim());
        if (sub !== null) {
          entries.push({ table: joinTomlPath(table, keyPath), key: sub[1], value: sub[2].trim() });
        }
      }
      continue;
    }
    const dot = keyPath.lastIndexOf(".");
    if (dot >= 0) {
      entries.push({
        table: joinTomlPath(table, keyPath.slice(0, dot)),
        key: keyPath.slice(dot + 1),
        value,
      });
    } else {
      entries.push({ table, key: keyPath, value });
    }
  }
  return entries;
}

/** Decode a TOML basic (`"…"`, JSON-compatible escapes) or literal (`'…'`) string. */
export function decodeTomlString(value: string): string | null {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return null;
}

function findTomlEntry(toml: string, table: string, key: string): TomlEntry | undefined {
  return scanTomlEntries(toml).find((entry) => entry.table === table && entry.key === key);
}

/** Root-table `project_id` (never one scoped under `[remotes.*]`). */
export function readProjectId(configToml: string): string {
  const entry = findTomlEntry(configToml, "", "project_id");
  const projectId = entry === undefined ? null : decodeTomlString(entry.value);
  if (projectId === null || projectId.length === 0) {
    throw new Error("supabase/config.toml has no top-level project_id string");
  }
  return projectId;
}

/** `[api] port = N` from config.toml, or the CLI default when absent. */
export function readApiPort(configToml: string): number {
  const entry = findTomlEntry(configToml, "api", "port");
  if (entry === undefined) {
    return DEFAULT_API_PORT;
  }
  if (!/^\d+$/.test(entry.value)) {
    throw new Error(`supabase/config.toml [api] port is not an integer: ${entry.value}`);
  }
  return Number(entry.value);
}

/** config.toml for the generated serve workdir whose entrypoint is the bundle. */
export function renderBundleWorkdirConfig(projectId: string, apiPort: number): string {
  return [
    `project_id = ${JSON.stringify(projectId)}`,
    "",
    "[api]",
    `port = ${apiPort}`,
    "",
    `[functions.${FUNCTION_SLUG}]`,
    "verify_jwt = false",
    `entrypoint = "./functions/${FUNCTION_SLUG}/index.js"`,
    "",
  ].join("\n");
}

export interface Summary {
  count: number;
  min: number;
  median: number;
  mean: number;
  max: number;
}

export function summarize(samples: readonly number[]): Summary | null {
  if (samples.length === 0) {
    return null;
  }
  const bad = samples.find((value) => !Number.isFinite(value));
  if (bad !== undefined) {
    throw new RangeError(`non-finite sample ${String(bad)} in ${JSON.stringify(samples)}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(median),
    mean: round(mean),
    max: round(sorted[sorted.length - 1]),
  };
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} B (${(bytes / 1024).toFixed(1)} KiB)`;
}

/** Last `maxChars` characters of a log, ANSI-stripped, one line per log line. */
export function tail(text: string, maxChars = 600): string {
  const clean = stripAnsi(text).trim();
  return clean.length <= maxChars ? clean : `…${clean.slice(clean.length - maxChars)}`;
}

// ---------------------------------------------------------------------------
// Process helpers + shutdown
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class Interrupted extends Error {
  constructor(readonly signal: Deno.Signal) {
    super(`interrupted by ${signal}`);
  }
}

interface TrackedProcess {
  child: Deno.ChildProcess;
  label: string;
  /** Runs after the process is gone (e.g. removes the container it owned). */
  cleanup: (() => Promise<void>) | null;
}

/**
 * Owns every process this script spawns. `shutdown()` interrupts each tracked
 * process TREE (deepest descendants first — `npx` does not forward signals to the
 * CLI binary it spawned, and the CLI keeps polling a removed container forever),
 * escalates to SIGKILL after the grace period, removes the containers the
 * processes owned, then runs the registered hooks (report persistence etc.).
 */
export class ShutdownController {
  #tracked = new Map<Deno.ChildProcess, TrackedProcess>();
  #hooks: Array<() => Promise<void>> = [];
  #inFlight: Promise<void> | null = null;
  interrupted: Deno.Signal | null = null;

  track(
    child: Deno.ChildProcess,
    label: string,
    cleanup: (() => Promise<void>) | null = null,
  ): void {
    if (this.interrupted !== null) {
      signalPid(child.pid, "SIGKILL");
      throw new Interrupted(this.interrupted);
    }
    this.#tracked.set(child, { child, label, cleanup });
  }

  untrack(child: Deno.ChildProcess): void {
    this.#tracked.delete(child);
  }

  /** Throws once a shutdown has begun so the main flow stops spawning work. */
  checkpoint(): void {
    if (this.interrupted !== null) {
      throw new Interrupted(this.interrupted);
    }
  }

  onShutdown(hook: () => Promise<void>): void {
    this.#hooks.push(hook);
  }

  get trackedLabels(): string[] {
    return [...this.#tracked.values()].map((entry) => entry.label);
  }

  shutdown(signal: Deno.Signal, graceMs: number): Promise<void> {
    if (this.#inFlight === null) {
      this.interrupted = signal;
      this.#inFlight = this.#run(graceMs);
    }
    return this.#inFlight;
  }

  async #run(graceMs: number): Promise<void> {
    const entries = [...this.#tracked.values()].reverse();
    for (const entry of entries) {
      await interruptTree(entry.child, graceMs);
      this.#tracked.delete(entry.child);
    }
    for (const entry of entries) {
      if (entry.cleanup !== null) {
        await entry.cleanup().catch((error: unknown) => {
          print(`edge_cold_start: cleanup of ${entry.label} failed: ${errorMessage(error)}`);
        });
      }
    }
    for (const hook of this.#hooks) {
      await hook();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const shutdown = new ShutdownController();

/** Wire SIGINT/SIGTERM/SIGHUP to a full teardown followed by exit 128+signal. */
export function installSignalHandlers(
  controller: ShutdownController,
  graceMs: number,
  exit: (code: number) => void,
): void {
  for (const sig of HANDLED_SIGNALS) {
    Deno.addSignalListener(sig, () => {
      print(
        `edge_cold_start: ${sig} received — stopping ${controller.trackedLabels.join(", ") || "nothing"} …`,
      );
      controller
        .shutdown(sig, graceMs)
        .catch((error: unknown) => {
          print(`edge_cold_start: teardown error: ${errorMessage(error)}`);
        })
        .finally(() => exit(128 + (SIGNAL_NUMBERS[sig] ?? 0)));
    });
  }
}

function spawn(
  cmd: string,
  args: readonly string[],
  cwd: string,
  label: string,
  cleanup: (() => Promise<void>) | null,
): Deno.ChildProcess {
  shutdown.checkpoint();
  const child = new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  shutdown.track(child, label, cleanup);
  return child;
}

/** Commands that must work during teardown itself (pgrep, docker rm, ps). */
async function runUntracked(cmd: string, args: readonly string[]): Promise<RunResult> {
  const startedAt = performance.now();
  try {
    const output = await new Deno.Command(cmd, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { code: 127, stdout: "", stderr: `${cmd}: command not found`, durationMs: 0 };
    }
    throw error;
  }
}

async function run(cmd: string, args: readonly string[], cwd: string): Promise<RunResult> {
  const startedAt = performance.now();
  let child: Deno.ChildProcess;
  try {
    child = spawn(cmd, args, cwd, `${cmd} ${args.slice(0, 3).join(" ")}`, null);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { code: 127, stdout: "", stderr: `${cmd}: command not found`, durationMs: 0 };
    }
    throw error;
  }
  try {
    const output = await child.output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      durationMs: performance.now() - startedAt,
    };
  } finally {
    shutdown.untrack(child);
  }
}

async function runOrThrow(cmd: string, args: readonly string[], cwd: string): Promise<RunResult> {
  const result = await run(cmd, args, cwd);
  if (result.code !== 0) {
    shutdown.checkpoint();
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${result.code}\n${tail(result.stderr || result.stdout, 1200)}`,
    );
  }
  return result;
}

export async function descendantPids(pid: number): Promise<number[]> {
  const result = await runUntracked("pgrep", ["-P", String(pid)]);
  if (result.code !== 0) {
    return [];
  }
  const children = result.stdout
    .split(/\s+/)
    .filter((token) => /^\d+$/.test(token))
    .map(Number);
  const nested: number[] = [];
  for (const child of children) {
    nested.push(...(await descendantPids(child)));
  }
  return [...nested, ...children];
}

export async function processAlive(pid: number): Promise<boolean> {
  const result = await runUntracked("ps", ["-o", "pid=", "-p", String(pid)]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

function signalPid(pid: number, sig: Deno.Signal): void {
  try {
    Deno.kill(pid, sig);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

/**
 * Interrupt a process tree deepest-first so the CLI's own cleanup ("Stopped
 * serving …") runs; SIGKILL whatever is still alive after `timeoutMs`.
 * Returns the root's exit code, or null when it had to be killed.
 */
export async function interruptTree(
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  const pids = await descendantPids(child.pid);
  for (const pid of pids) {
    signalPid(pid, "SIGINT");
  }
  signalPid(child.pid, "SIGINT");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    child.status.then((status) => status.code),
    new Promise<null>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(null), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  const survivors = [...pids, ...(await descendantPids(child.pid))].filter(
    (pid, index, all) => all.indexOf(pid) === index,
  );
  if (exited === null) {
    survivors.push(child.pid);
  }
  for (const pid of survivors) {
    if (await processAlive(pid)) {
      signalPid(pid, "SIGKILL");
    }
  }
  await child.status;
  return exited;
}

const CLI_PROJECT_LABEL = "com.supabase.cli.project";

/**
 * Remove the edge-runtime container ONLY if the Supabase CLI created it for this
 * project (its `com.supabase.cli.project` label) — a leftover from an earlier run
 * or a killed CLI. Anything else holding the name belongs to someone else and
 * makes the run refuse rather than destroy foreign state.
 */
export function classifyContainer(
  inspectCode: number,
  inspectStdout: string,
  projectId: string,
): "absent" | "cli-owned" | "foreign" {
  if (inspectCode !== 0) {
    return "absent";
  }
  return inspectStdout.trim() === projectId ? "cli-owned" : "foreign";
}

async function removeEdgeContainer(stack: Stack): Promise<void> {
  const inspect = await runUntracked("docker", [
    "inspect",
    "--format",
    `{{index .Config.Labels "${CLI_PROJECT_LABEL}"}}`,
    stack.edgeContainer,
  ]);
  switch (classifyContainer(inspect.code, inspect.stdout, stack.projectId)) {
    case "absent":
      return;
    case "cli-owned":
      await runUntracked("docker", ["rm", "-f", stack.edgeContainer]);
      return;
    case "foreign":
      throw new Error(
        `container ${stack.edgeContainer} exists but carries ${CLI_PROJECT_LABEL}=${JSON.stringify(inspect.stdout.trim())}, ` +
          `not ${JSON.stringify(stack.projectId)} — it was not created by the Supabase CLI for this project; ` +
          `refusing to remove it (inspect it, then \`docker rm -f ${stack.edgeContainer}\` yourself)`,
      );
  }
}

/**
 * One measurement per machine at a time: the CLI binds the fixed API port and the
 * fixed edge-runtime container name, so a sibling run would corrupt both samples.
 * The lock lives in the OS temp dir (shared across checkouts) and holds the owner
 * pid; a lock whose owner is dead is stale and reclaimed.
 */
export class RunLock {
  private constructor(readonly path: string) {}

  static async acquire(path: string, ownerPid: number): Promise<RunLock> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const file = await Deno.open(path, { write: true, createNew: true });
        try {
          await file.write(encoder.encode(`${ownerPid}\n`));
        } finally {
          file.close();
        }
        return new RunLock(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) {
          throw error;
        }
        const holder = Number((await Deno.readTextFile(path).catch(() => "")).trim());
        if (Number.isSafeInteger(holder) && holder > 0 && (await processAlive(holder))) {
          throw new Error(
            `another edge_cold_start run (pid ${holder}) holds ${path}; wait for it or remove the lock if that pid is not a measurement`,
          );
        }
        await Deno.remove(path).catch(() => undefined);
      }
    }
    throw new Error(`could not acquire ${path}`);
  }

  async release(): Promise<void> {
    await Deno.remove(this.path).catch(() => undefined);
  }
}

export function runLockPath(projectId: string): string {
  return join(tmpdir(), `edge-cold-start-${projectId}.lock`);
}

function collect(
  stream: ReadableStream<Uint8Array>,
  sink: (chunk: Uint8Array) => void,
): Promise<void> {
  return stream.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        sink(chunk);
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export interface BundleReport {
  command: string;
  /** Bytes of the served (path-normalised) bundle — the identity metric. */
  rawBytes: number;
  gzipBytes: number;
  moduleCount: number | null;
  bundleMs: number;
  /** sha256 of the served (path-normalised) bundle. */
  sha256: string;
  outputPath: string;
  /** Bytes exactly as `deno bundle` wrote them (depends on cwd ↔ $DENO_DIR layout). */
  unnormalizedBytes: number;
  pathNormalization: PathNormalization;
}

export interface PathNormalization {
  denoDir: string;
  /** `relative(cwd, denoDir)` as the bundler spelled it, or null when not applicable. */
  denoDirRelative: string | null;
  placeholder: string;
  rewrites: number;
  /** Path labels still pointing outside the checkout after the rewrite (0 = identity is path-independent). */
  unresolved: number;
}

async function gzipSize(bytes: Uint8Array): Promise<number> {
  const compressed = await new Response(
    new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return compressed.byteLength;
}

/** Path label lines the bundler emits (`// <path>`) that escape the cwd. */
const OUTSIDE_CWD_LABEL = /^\/\/ (?:\.\.\/|\/)/gm;

/**
 * Replace the bundler's cwd-relative spelling of $DENO_DIR (in `// path` labels
 * and `__commonJS({ "path"(…) {` keys) with `$DENO_DIR/` so the served bundle is
 * byte-identical for the same (commit, lockfile, Deno version) on any checkout
 * path. `unresolved` counts label lines that still point outside the checkout.
 */
export function normalizeBundlePaths(
  text: string,
  denoDirRelative: string | null,
): { text: string; rewrites: number; unresolved: number } {
  let rewrites = 0;
  let normalized = text;
  if (denoDirRelative !== null && denoDirRelative.length > 0) {
    const needle = `${denoDirRelative.replace(/\/+$/, "")}/`;
    const parts = text.split(needle);
    rewrites = parts.length - 1;
    normalized = parts.join(`${DENO_DIR_PLACEHOLDER}/`);
  }
  const unresolved = normalized.match(OUTSIDE_CWD_LABEL)?.length ?? 0;
  return { text: normalized, rewrites, unresolved };
}

async function readDenoDir(cwd: string): Promise<string> {
  const result = await runOrThrow(Deno.execPath(), ["info", "--json"], cwd);
  const parsed: unknown = JSON.parse(result.stdout);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { denoDir?: unknown }).denoDir !== "string"
  ) {
    throw new Error("deno info --json did not report denoDir");
  }
  return (parsed as { denoDir: string }).denoDir;
}

export async function measureBundle(repoRoot: string, outputPath: string): Promise<BundleReport> {
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  const denoDir = await readDenoDir(repoRoot);
  const args = [
    "bundle",
    "--config",
    FUNCTION_DENO_CONFIG,
    "--platform",
    "deno",
    "-o",
    outputPath,
    FUNCTION_ENTRYPOINT,
  ];
  const result = await runOrThrow(Deno.execPath(), args, repoRoot);
  const unnormalized = await Deno.readTextFile(outputPath);
  const rel = relative(repoRoot, denoDir).split("\\").join("/");
  const denoDirRelative = rel.length > 0 && rel !== "." ? rel : null;
  const normalized = normalizeBundlePaths(unnormalized, denoDirRelative);
  const bytes = encoder.encode(normalized.text);
  await Deno.writeFile(outputPath, bytes);
  return {
    command: `deno ${args.join(" ")}`,
    rawBytes: bytes.byteLength,
    gzipBytes: await gzipSize(bytes),
    moduleCount: parseBundledModuleCount(`${result.stdout}\n${result.stderr}`),
    bundleMs: round(result.durationMs),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    outputPath,
    unnormalizedBytes: encoder.encode(unnormalized).byteLength,
    pathNormalization: {
      denoDir,
      denoDirRelative,
      placeholder: DENO_DIR_PLACEHOLDER,
      rewrites: normalized.rewrites,
      unresolved: normalized.unresolved,
    },
  };
}

interface SourceGraphReport {
  command: string;
  firstPartyModules: number;
  firstPartyBytes: number;
  npmPackages: string[];
}

interface DenoInfoModule {
  specifier?: unknown;
  size?: unknown;
}

interface DenoInfoJson {
  modules?: unknown;
  npmPackages?: unknown;
}

export function summarizeDenoInfo(info: DenoInfoJson): Omit<SourceGraphReport, "command"> {
  const modules = Array.isArray(info.modules) ? (info.modules as DenoInfoModule[]) : [];
  let firstPartyModules = 0;
  let firstPartyBytes = 0;
  for (const module of modules) {
    if (typeof module.specifier === "string" && module.specifier.startsWith("file:")) {
      firstPartyModules += 1;
      firstPartyBytes += typeof module.size === "number" ? module.size : 0;
    }
  }
  const npmPackages =
    info.npmPackages !== null && typeof info.npmPackages === "object"
      ? Object.values(info.npmPackages as Record<string, { name?: unknown; version?: unknown }>)
          .filter((pkg) => typeof pkg.name === "string" && typeof pkg.version === "string")
          .map((pkg) => `${pkg.name}@${pkg.version}`)
          .sort()
      : [];
  return { firstPartyModules, firstPartyBytes, npmPackages };
}

async function measureSourceGraph(repoRoot: string): Promise<SourceGraphReport> {
  const args = ["info", "--json", "--config", FUNCTION_DENO_CONFIG, FUNCTION_ENTRYPOINT];
  const result = await runOrThrow(Deno.execPath(), args, repoRoot);
  const parsed: unknown = JSON.parse(result.stdout);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("deno info --json did not return an object");
  }
  return { command: `deno ${args.join(" ")}`, ...summarizeDenoInfo(parsed as DenoInfoJson) };
}

export interface ColdStartCycle {
  cycle: number;
  serveReadyMs: number;
  coldStartMs: number;
  coldStatus: number;
  warmMs: number[];
  logPath: string;
}

export type ServeTargetStatus = "running" | "measured" | "partial" | "unavailable";

export interface ServeTargetReport {
  target: "source-tree" | "bundle";
  workdir: string;
  command: string;
  /** measured: every cycle sampled; partial: some cycles then a failure; unavailable: no cycle. */
  status: ServeTargetStatus;
  reason: string | null;
  runtime: RuntimeVersion | null;
  cycles: ColdStartCycle[];
  coldStart: Summary | null;
  warm: Summary | null;
  serveReady: Summary | null;
}

export function newServeTargetReport(
  target: ServeTargetReport["target"],
  workdir: string,
  command: string,
): ServeTargetReport {
  return {
    target,
    workdir,
    command,
    status: "running",
    reason: null,
    runtime: null,
    cycles: [],
    coldStart: null,
    warm: null,
    serveReady: null,
  };
}

interface Stack {
  projectId: string;
  apiPort: number;
  baseUrl: string;
  edgeContainer: string;
}

interface Cli {
  npx: string;
  version: string;
  args(...rest: string[]): string[];
}

async function fetchStatus(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

class ServeUnavailable extends Error {}

export interface CycleResult {
  cycle: ColdStartCycle;
  log: string;
}

export type CycleRunner = (cycle: number, logPath: string) => Promise<CycleResult>;

async function serveCycle(
  cli: Cli,
  stack: Stack,
  workdir: string,
  cycle: number,
  logPath: string,
  options: Options,
): Promise<CycleResult> {
  await removeEdgeContainer(stack);
  const logChunks: Uint8Array[] = [];
  const spawnedAt = performance.now();
  const child = spawn(
    cli.npx,
    cli.args("--workdir", workdir, "functions", "serve", "--no-verify-jwt"),
    workdir,
    `supabase functions serve (${workdir})`,
    () => removeEdgeContainer(stack),
  );
  const sink = (chunk: Uint8Array): void => {
    logChunks.push(chunk);
  };
  const drained = Promise.all([collect(child.stdout, sink), collect(child.stderr, sink)]);
  const logText = (): string => decoder.decode(concat(logChunks));
  let exited = false;
  const exitWatch = child.status.then(() => {
    exited = true;
  });
  try {
    let serveReadyMs: number | null = null;
    while (serveReadyMs === null) {
      shutdown.checkpoint();
      if (exited) {
        await drained;
        throw new ServeUnavailable(
          `supabase functions serve exited before the runtime became healthy:\n${tail(logText())}`,
        );
      }
      if (performance.now() - spawnedAt > options.startupTimeoutMs) {
        throw new Error(`runtime not healthy after ${options.startupTimeoutMs}ms`);
      }
      const status = await fetchStatus(`${stack.baseUrl}/functions/v1/_internal/health`);
      if (status === 200) {
        serveReadyMs = performance.now() - spawnedAt;
      } else {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
    const coldStartedAt = performance.now();
    const cold = await fetch(`${stack.baseUrl}/functions/v1/${FUNCTION_SLUG}/healthz`, {
      signal: AbortSignal.timeout(60_000),
    });
    await cold.body?.cancel();
    const coldStartMs = performance.now() - coldStartedAt;
    if (cold.status !== 200) {
      throw new Error(`cold GET /healthz returned ${cold.status}`);
    }
    const warmMs: number[] = [];
    for (let index = 0; index < options.warmRequests; index += 1) {
      shutdown.checkpoint();
      const startedAt = performance.now();
      const warm = await fetch(`${stack.baseUrl}/functions/v1/${FUNCTION_SLUG}/healthz`, {
        signal: AbortSignal.timeout(10_000),
      });
      await warm.body?.cancel();
      if (warm.status !== 200) {
        throw new Error(`warm GET /healthz #${index + 1} returned ${warm.status}`);
      }
      warmMs.push(round(performance.now() - startedAt));
    }
    return {
      cycle: {
        cycle,
        serveReadyMs: round(serveReadyMs),
        coldStartMs: round(coldStartMs),
        coldStatus: cold.status,
        warmMs,
        logPath,
      },
      log: logText(),
    };
  } finally {
    // During a shutdown the controller owns the tree and the container.
    if (shutdown.interrupted === null && !exited) {
      await interruptTree(child, 15_000);
    }
    await exitWatch;
    await drained;
    shutdown.untrack(child);
    if (shutdown.interrupted === null) {
      await removeEdgeContainer(stack);
    }
    await Deno.writeTextFile(logPath, stripAnsi(logText()));
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Run `cycles` serve cycles into `report`, persisting after every completed
 * cycle. A failure with no completed cycle marks the target "unavailable"; a
 * failure after ≥1 completed cycle marks it "partial" and KEEPS those cycles.
 * Only an interruption propagates.
 */
export async function measureCycles(
  report: ServeTargetReport,
  cycles: number,
  outDir: string,
  runCycle: CycleRunner,
  persist: () => Promise<void>,
): Promise<void> {
  const target = report.target;
  const finalize = (): void => {
    report.coldStart = summarize(report.cycles.map((cycle) => cycle.coldStartMs));
    report.serveReady = summarize(report.cycles.map((cycle) => cycle.serveReadyMs));
    report.warm = summarize(report.cycles.flatMap((cycle) => cycle.warmMs));
  };
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const logPath = join(outDir, `serve-${target}-${cycle}.log`);
    print(`  [${target}] cycle ${cycle}/${cycles} …`);
    try {
      const result = await runCycle(cycle, logPath);
      report.cycles.push(result.cycle);
      report.runtime ??= parseEdgeRuntimeVersion(result.log);
      finalize();
      await persist();
      print(
        `  [${target}] cycle ${cycle}: serve ready ${result.cycle.serveReadyMs} ms, ` +
          `cold /healthz ${result.cycle.coldStartMs} ms, warm median ${summarize(result.cycle.warmMs)?.median ?? "n/a"} ms`,
      );
    } catch (error) {
      if (error instanceof Interrupted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      report.status = report.cycles.length === 0 ? "unavailable" : "partial";
      report.reason = message;
      finalize();
      await persist();
      print(
        `  [${target}] ${report.status.toUpperCase()} after ${report.cycles.length}/${cycles} cycle(s): ${message.split("\n")[0]}`,
      );
      return;
    }
  }
  report.status = "measured";
  finalize();
  await persist();
}

async function measureServeTarget(
  cli: Cli,
  stack: Stack,
  target: ServeTargetReport["target"],
  workdir: string,
  outDir: string,
  options: Options,
  reportFile: ReportFile,
): Promise<ServeTargetReport> {
  const report = newServeTargetReport(
    target,
    workdir,
    `npx --yes supabase@${cli.version} --workdir ${workdir} functions serve --no-verify-jwt`,
  );
  reportFile.report.serve.push(report);
  await reportFile.persist();
  await measureCycles(
    report,
    options.cycles,
    outDir,
    (cycle, logPath) => serveCycle(cli, stack, workdir, cycle, logPath, options),
    () => reportFile.persist(),
  );
  return report;
}

// ---------------------------------------------------------------------------
// Local stack
// ---------------------------------------------------------------------------

async function runningContainers(): Promise<Set<string>> {
  const result = await runOrThrow("docker", ["ps", "--format", "{{.Names}}"], Deno.cwd());
  return new Set(result.stdout.split(/\r?\n/).filter((name) => name.length > 0));
}

async function ensureStack(cli: Cli, repoRoot: string, stack: Stack): Promise<string> {
  const db = `supabase_db_${stack.projectId}`;
  const kong = `supabase_kong_${stack.projectId}`;
  let running = await runningContainers();
  if (running.has(db) && running.has(kong)) {
    return "already running";
  }
  if (running.has(db)) {
    throw new Error(
      `${db} is running but ${kong} is not; the measurement needs Kong on :${stack.apiPort}. ` +
        `Run \`npx --yes supabase@${cli.version} stop\` and re-run this script (it starts db + kong).`,
    );
  }
  const args = cli.args("start", "-x", START_EXCLUDED_SERVICES.join(","));
  const command = `${cli.npx} ${args.join(" ")}`;
  print(`  starting local stack: ${command}`);
  await runOrThrow(cli.npx, args, repoRoot);
  running = await runningContainers();
  for (const name of [db, kong]) {
    if (!running.has(name)) {
      throw new Error(`${name} is not running after supabase start`);
    }
  }
  return `started by this script: ${command}`;
}

/**
 * Another `supabase functions serve` (a developer's, a concurrent run, or the
 * orphan of a SIGKILLed run) shares the API port and the edge container name;
 * measuring beside it would sample the wrong runtime, so refuse instead.
 */
export function parseForeignServeProcesses(
  psOutput: string,
  ownPids: ReadonlySet<number>,
): Array<{ pid: number; command: string }> {
  const found: Array<{ pid: number; command: string }> = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    if (!ownPids.has(pid) && /\bfunctions\s+serve\b/.test(match[2])) {
      found.push({ pid, command: match[2] });
    }
  }
  return found;
}

async function refuseForeignServe(): Promise<void> {
  const result = await runUntracked("ps", ["-axo", "pid=,args="]);
  const own = new Set<number>([Deno.pid, ...(await descendantPids(Deno.pid))]);
  const foreign = parseForeignServeProcesses(result.stdout, own);
  if (foreign.length > 0) {
    throw new Error(
      "another `supabase functions serve` is running; it shares the API port and the edge-runtime " +
        `container name, so this measurement would sample the wrong runtime. Stop it first:\n` +
        foreign.map((entry) => `  pid ${entry.pid}: ${entry.command}`).join("\n"),
    );
  }
}

/**
 * The CLI rewrites the TRACKED marker `supabase/.temp/cli-latest` and
 * `supabase start` creates `supabase/.branches/`; put both back the way they
 * were so a measurement never dirties the checkout.
 */
class CheckoutMarkers {
  readonly #cliLatest: string;
  readonly #branches: string;
  #cliLatestBefore: string | null = null;
  #branchesExisted = false;

  constructor(repoRoot: string) {
    this.#cliLatest = join(repoRoot, "supabase", ".temp", "cli-latest");
    this.#branches = join(repoRoot, "supabase", ".branches");
  }

  async snapshot(): Promise<void> {
    this.#cliLatestBefore = await readTextOrNull(this.#cliLatest);
    this.#branchesExisted = await exists(this.#branches);
  }

  async restore(): Promise<void> {
    if (this.#cliLatestBefore !== null) {
      const now = await readTextOrNull(this.#cliLatest);
      if (now !== this.#cliLatestBefore) {
        await Deno.writeTextFile(this.#cliLatest, this.#cliLatestBefore);
      }
    }
    if (!this.#branchesExisted && (await exists(this.#branches))) {
      await Deno.remove(this.#branches, { recursive: true });
    }
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type ReportStatus = "running" | "measured" | "failed" | "interrupted";

export interface Report {
  generatedAt: string;
  updatedAt: string;
  /** running while the script works; measured/failed/interrupted once it stops. */
  status: ReportStatus;
  error: string | null;
  repoRoot: string;
  gitHead: string | null;
  entrypoint: string;
  environment: {
    os: string;
    arch: string;
    deno: string;
    v8: string;
    typescript: string;
    supabaseCli: string | null;
    docker: string | null;
    stack: string | null;
  };
  options: Options;
  bundle: BundleReport | null;
  sourceGraph: SourceGraphReport | null;
  serve: ServeTargetReport[];
  ok: boolean;
}

/** Writes report.json atomically (tmp + rename) after every completed step. */
export class ReportFile {
  constructor(
    readonly path: string,
    readonly report: Report,
  ) {}

  async persist(): Promise<void> {
    this.report.updatedAt = new Date().toISOString();
    const tmp = `${this.path}.tmp`;
    await Deno.writeTextFile(tmp, `${JSON.stringify(this.report, null, 2)}\n`);
    await Deno.rename(tmp, this.path);
  }
}

/** Sets `ok` (bundle measured AND every requested "bundle" cycle sampled) and the final status. */
export function finalizeReport(report: Report): boolean {
  const bundleTarget = report.serve.find((entry) => entry.target === "bundle");
  report.ok =
    report.bundle !== null &&
    bundleTarget !== undefined &&
    bundleTarget.status === "measured" &&
    bundleTarget.cycles.length === report.options.cycles;
  for (const target of report.serve) {
    if (target.status === "running") {
      target.status = target.cycles.length === 0 ? "unavailable" : "partial";
      target.reason ??= report.error ?? "run ended before the target completed";
    }
  }
  if (report.status === "running") {
    report.status = report.ok ? "measured" : "failed";
  }
  return report.ok;
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const startedAt = new Date();
  const outDir = resolve(
    repoRoot,
    options.outDir ?? join("artifacts", "edge-cold-start", utcStamp(startedAt)),
  );
  await Deno.mkdir(outDir, { recursive: true });

  const cliVersion = Deno.env.get(SUPABASE_CLI_VERSION_ENV) ?? DEFAULT_SUPABASE_CLI_VERSION;
  const cli: Cli = {
    npx: "npx",
    version: cliVersion,
    args: (...rest) => ["--yes", `supabase@${cliVersion}`, ...rest],
  };

  print(`edge_cold_start: ${FUNCTION_ENTRYPOINT} (local only; artifacts → ${outDir})`);

  const markers = new CheckoutMarkers(repoRoot);
  await markers.snapshot();
  const gitHead = await run("git", ["rev-parse", "HEAD"], repoRoot);
  const reportFile = new ReportFile(join(outDir, "report.json"), {
    generatedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    status: "running",
    error: null,
    repoRoot,
    gitHead: gitHead.code === 0 ? gitHead.stdout.trim() : null,
    entrypoint: FUNCTION_ENTRYPOINT,
    environment: {
      os: Deno.build.os,
      arch: Deno.build.arch,
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
      supabaseCli: null,
      docker: null,
      stack: null,
    },
    options,
    bundle: null,
    sourceGraph: null,
    serve: [],
    ok: false,
  });
  const report = reportFile.report;
  let lock: RunLock | null = null;
  shutdown.onShutdown(async () => {
    report.status = "interrupted";
    report.error = `interrupted by ${shutdown.interrupted}`;
    finalizeReport(report);
    await reportFile.persist();
    await markers.restore();
    await lock?.release();
    print(`edge_cold_start: interrupted — partial report: ${reportFile.path}`);
  });

  try {
    await reportFile.persist();

    print("bundle: deno bundle --platform deno …");
    const bundle = await measureBundle(
      repoRoot,
      join(outDir, "workdir", "supabase", "functions", FUNCTION_SLUG, "index.js"),
    );
    report.bundle = bundle;
    await reportFile.persist();
    print(
      `  served ${formatBytes(bundle.rawBytes)}, gzip ${formatBytes(bundle.gzipBytes)}, ` +
        `${bundle.moduleCount ?? "?"} modules, ${bundle.bundleMs} ms, sha256 ${bundle.sha256.slice(0, 12)}…`,
    );
    print(
      `  path labels: ${bundle.pathNormalization.rewrites} × ${JSON.stringify(bundle.pathNormalization.denoDirRelative)} → ` +
        `${DENO_DIR_PLACEHOLDER}/ (${bundle.pathNormalization.unresolved} unresolved); ` +
        `pre-rewrite ${formatBytes(bundle.unnormalizedBytes)}`,
    );
    if (bundle.pathNormalization.unresolved > 0) {
      print(
        `  WARNING: ${bundle.pathNormalization.unresolved} module label(s) still point outside the checkout; ` +
          "raw bytes/sha256 of this run are NOT path-independent (gzip/module count remain comparable)",
      );
    }

    print("source graph: deno info --json …");
    const sourceGraph = await measureSourceGraph(repoRoot);
    report.sourceGraph = sourceGraph;
    await reportFile.persist();
    print(
      `  ${sourceGraph.firstPartyModules} first-party modules, ${formatBytes(sourceGraph.firstPartyBytes)}, ` +
        `npm: ${sourceGraph.npmPackages.length} packages`,
    );

    const cliVersionOut = await runOrThrow(cli.npx, cli.args("--version"), repoRoot);
    report.environment.supabaseCli = stripAnsi(cliVersionOut.stdout).trim();
    const dockerVersion = await run(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      repoRoot,
    );
    if (dockerVersion.code !== 0) {
      throw new Error(
        `docker is required for supabase functions serve:\n${tail(dockerVersion.stderr)}`,
      );
    }
    report.environment.docker = dockerVersion.stdout.trim();
    await reportFile.persist();

    const configToml = await Deno.readTextFile(join(repoRoot, "supabase", "config.toml"));
    const projectId = readProjectId(configToml);
    const apiPort = readApiPort(configToml);
    const stack: Stack = {
      projectId,
      apiPort,
      baseUrl: `http://127.0.0.1:${apiPort}`,
      edgeContainer: `supabase_edge_runtime_${projectId}`,
    };
    print(`local stack: project_id=${projectId}, api ${stack.baseUrl}`);
    lock = await RunLock.acquire(runLockPath(projectId), Deno.pid);
    await refuseForeignServe();
    const stackState = await ensureStack(cli, repoRoot, stack);
    report.environment.stack = stackState;
    await reportFile.persist();
    print(`  ${stackState}`);
    if ((await runningContainers()).has(stack.edgeContainer)) {
      print(
        `  ${stack.edgeContainer} is present with no serve process — removing it if the CLI created it`,
      );
    }

    const bundleWorkdir = join(outDir, "workdir");
    await Deno.writeTextFile(
      join(bundleWorkdir, "supabase", "config.toml"),
      renderBundleWorkdirConfig(projectId, apiPort),
    );

    print(
      `cold start: ${options.cycles} cycle(s) × (1 cold + ${options.warmRequests} warm GET /healthz)`,
    );
    await measureServeTarget(cli, stack, "bundle", bundleWorkdir, outDir, options, reportFile);
    await measureServeTarget(cli, stack, "source-tree", repoRoot, outDir, options, reportFile);
  } catch (error) {
    if (error instanceof Interrupted || shutdown.interrupted !== null) {
      throw error;
    }
    report.error = error instanceof Error ? error.message : String(error);
    print(`edge_cold_start: ${report.error}`);
  } finally {
    if (shutdown.interrupted === null) {
      finalizeReport(report);
      await reportFile.persist();
      await markers.restore();
      await lock?.release();
    }
  }

  print("");
  print("summary");
  print(
    `  deno ${report.environment.deno}, supabase cli ${report.environment.supabaseCli ?? "?"}, docker ${report.environment.docker ?? "?"}, ${report.environment.os}/${report.environment.arch}`,
  );
  if (report.bundle !== null) {
    print(
      `  served bundle: ${formatBytes(report.bundle.rawBytes)} raw, ${formatBytes(report.bundle.gzipBytes)} gzip, ` +
        `${report.bundle.moduleCount ?? "?"} modules, sha256 ${report.bundle.sha256}`,
    );
  }
  if (report.sourceGraph !== null) {
    print(
      `  source graph: ${report.sourceGraph.firstPartyModules} first-party modules (${formatBytes(report.sourceGraph.firstPartyBytes)}), npm ${report.sourceGraph.npmPackages.join(", ") || "none"}`,
    );
  }
  for (const target of report.serve) {
    const cold = target.coldStart;
    const warm = target.warm;
    const ready = target.serveReady;
    const samples =
      cold === null
        ? "no cycle sampled"
        : `cold /healthz min ${cold.min} / median ${cold.median} / max ${cold.max} ms over ${cold.count} cycle(s); ` +
          `warm median ${warm?.median} ms (n=${warm?.count}); serve ready median ${ready?.median} ms`;
    const note = target.reason === null ? "" : ` — ${target.reason.split("\n").pop() ?? ""}`;
    print(
      `  serve[${target.target}] ${target.status.toUpperCase()} ${target.runtime?.edgeRuntime ?? ""}: ${samples}${note}`,
    );
  }
  print(`  report: ${reportFile.path}`);
  print(
    report.ok
      ? "RESULT: measured"
      : `RESULT: FAILED — ${report.error ?? "bundle target did not produce every cycle"}`,
  );
  return report.ok ? 0 : EXIT_FAILED;
}

if (import.meta.main) {
  installSignalHandlers(shutdown, 3_000, (code) => Deno.exit(code));
  let code = EXIT_FAILED;
  try {
    code = await main(Deno.args);
  } catch (error) {
    if (error instanceof Interrupted || shutdown.interrupted !== null) {
      // The signal handler owns teardown and the exit code; never race it.
      await new Promise<never>(() => {});
    }
    print(`edge_cold_start: ${error instanceof Error ? error.message : String(error)}`);
    code = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  }
  Deno.exit(code);
}

// ---------------------------------------------------------------------------
// Self-tests (deno test -A tools/diagnostics/edge_cold_start.ts)
// ---------------------------------------------------------------------------

function assertEquals<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

function assertThrows(fn: () => unknown, label: string, messageIncludes?: string): void {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    if (messageIncludes !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(messageIncludes)) {
        throw new Error(`${label}: error ${JSON.stringify(message)} lacks ${messageIncludes}`);
      }
    }
  }
  if (!threw) {
    throw new Error(`${label}: expected an error`);
  }
}

Deno.test("parseArgs: defaults and overrides", () => {
  assertEquals(parseArgs([]), DEFAULT_OPTIONS, "defaults");
  assertEquals(
    parseArgs([
      "--cycles",
      "5",
      "--warm-requests",
      "2",
      "--out",
      "x",
      "--startup-timeout-ms",
      "10",
    ]),
    { cycles: 5, warmRequests: 2, outDir: "x", startupTimeoutMs: 10 },
    "overrides",
  );
  assertThrows(() => parseArgs(["--cycles", "0"]), "zero cycles");
  assertThrows(() => parseArgs(["--cycles"]), "missing value");
  assertThrows(() => parseArgs(["--bogus"]), "unknown flag");
});

Deno.test("parseArgs: rejects unsafe integers, empty --out and a flag as --out value", () => {
  assertThrows(() => parseArgs(["--cycles", "99999999999999999999"]), "unsafe cycles");
  assertThrows(() => parseArgs(["--warm-requests", "18446744073709551616"]), "unsafe warm");
  for (const bad of ["+3", "3.0", " 3", "1e3", "0x10", "-1", ""]) {
    assertThrows(() => parseArgs(["--cycles", bad]), `cycles ${JSON.stringify(bad)}`);
  }
  assertThrows(() => parseArgs(["--out", ""]), "empty out");
  assertThrows(() => parseArgs(["--out", "--cycles"]), "flag as out");
  let usage = false;
  try {
    parseArgs(["--out", ""]);
  } catch (error) {
    usage = error instanceof UsageError;
  }
  assertEquals(usage, true, "UsageError type");
});

Deno.test("parseBundledModuleCount reads Deno's coloured bundler line", () => {
  assertEquals(
    parseBundledModuleCount("\u001b[0m\u001b[32mBundled\u001b[0m 62 modules in 74ms\n"),
    62,
    "coloured",
  );
  assertEquals(parseBundledModuleCount("Bundled 1 module in 3ms"), 1, "singular");
  assertEquals(parseBundledModuleCount("nothing here"), null, "absent");
});

Deno.test("parseEdgeRuntimeVersion reads the serve banner", () => {
  assertEquals(
    parseEdgeRuntimeVersion(
      "2026-09-08T18:32:02Z Using supabase-edge-runtime-1.74.3 (compatible with Deno v2.1.4)\n",
    ),
    { edgeRuntime: "supabase-edge-runtime-1.74.3", denoCompat: "Deno v2.1.4" },
    "banner",
  );
  assertEquals(parseEdgeRuntimeVersion("Setting up Edge Functions runtime..."), null, "absent");
});

Deno.test("readProjectId / readApiPort parse config.toml", () => {
  const toml = 'project_id = "pickle-sensei"\n\n[functions.api]\nverify_jwt = false\n';
  assertEquals(readProjectId(toml), "pickle-sensei", "project id");
  assertEquals(readApiPort(toml), DEFAULT_API_PORT, "default port");
  assertEquals(readApiPort(`${toml}\n[api]\nport = 55321\n[db]\nport = 1\n`), 55321, "api port");
  assertEquals(readApiPort(`${toml}\n[db]\nport = 1\n`), DEFAULT_API_PORT, "db port ignored");
  assertThrows(() => readProjectId("[api]\nport = 1\n"), "missing project id");
  assertEquals(readProjectId("project_id = 'literal-id' # c\n"), "literal-id", "literal string");
  assertEquals(readProjectId('project_id = "a\\"b"\n'), 'a"b', "escaped quote");
  assertThrows(
    () => readProjectId('[remotes.production]\nproject_id = "abcdefghijklmnopqrst"\n'),
    "remote-scoped project_id is not the local one",
  );
  assertEquals(readApiPort('project_id = "p"\napi.port = 55555\n'), 55555, "dotted key");
  assertEquals(readApiPort('project_id = "p"\napi = { port = 55556 }\n'), 55556, "inline table");
  assertEquals(
    readApiPort('project_id = "p"\n[api]\n# port = 1\nport = 54321\n'),
    54321,
    "comment",
  );
  assertEquals(
    readApiPort("[api]\nenabled = true # port = 9\n"),
    DEFAULT_API_PORT,
    "trailing comment",
  );
  assertThrows(() => readApiPort('[api]\nport = "x"\n'), "non-integer port");
  const projectId = readProjectId('project_id = "a\\"b"');
  assertEquals(
    readProjectId(renderBundleWorkdirConfig(projectId, 54321)),
    projectId,
    "render/read round trip with escapes",
  );
});

Deno.test("renderBundleWorkdirConfig points the slug at the bundled entrypoint", () => {
  const rendered = renderBundleWorkdirConfig("pickle-sensei", 54321);
  assertEquals(readProjectId(rendered), "pickle-sensei", "project id round-trip");
  assertEquals(readApiPort(rendered), 54321, "port round-trip");
  assertEquals(
    rendered.includes('entrypoint = "./functions/api/index.js"') &&
      rendered.includes("[functions.api]\nverify_jwt = false"),
    true,
    "entrypoint + verify_jwt",
  );
});

Deno.test("summarize: median/mean over odd and even sample counts", () => {
  assertEquals(summarize([]), null, "empty");
  assertEquals(summarize([3, 1, 2]), { count: 3, min: 1, median: 2, mean: 2, max: 3 }, "odd");
  assertEquals(
    summarize([4, 1, 3, 2]),
    { count: 4, min: 1, median: 2.5, mean: 2.5, max: 4 },
    "even",
  );
  assertThrows(() => summarize([1, NaN, 3]), "NaN is refused", "non-finite");
  assertThrows(() => summarize([Infinity]), "Infinity is refused", "non-finite");
});

Deno.test("summarizeDenoInfo counts only file: modules and lists npm packages", () => {
  assertEquals(
    summarizeDenoInfo({
      modules: [
        { specifier: "file:///a.ts", size: 10 },
        { specifier: "file:///b.ts", size: 5 },
        { specifier: "npm:/jose@6.2.10/index.js", size: 999 },
        { specifier: "file:///c.ts" },
      ],
      npmPackages: {
        "jose@6.2.10": { name: "jose", version: "6.2.10" },
        "canonicalize@4.0.0": { name: "canonicalize", version: "4.0.0" },
      },
    }),
    {
      firstPartyModules: 3,
      firstPartyBytes: 15,
      npmPackages: ["canonicalize@4.0.0", "jose@6.2.10"],
    },
    "graph",
  );
  assertEquals(
    summarizeDenoInfo({}),
    { firstPartyModules: 0, firstPartyBytes: 0, npmPackages: [] },
    "empty",
  );
});

Deno.test("tail keeps the end of long logs", () => {
  assertEquals(tail("short"), "short", "short");
  assertEquals(tail("abcdef", 3), "…def", "truncated");
});

Deno.test("parseForeignServeProcesses ignores our own tree and unrelated matches", () => {
  const output = [
    "100 node /x/supabase --workdir /tmp/a functions serve --no-verify-jwt",
    "101 sh -c npx --yes supabase@2.117.0 --workdir /tmp/a functions serve",
    "102 ps -axo pid=,args=",
    "103 deno test edge_cold_start.ts --filter functions-serve",
    "garbage line",
  ].join("\n");
  assertEquals(
    parseForeignServeProcesses(output, new Set([101, 102])),
    [{ pid: 100, command: "node /x/supabase --workdir /tmp/a functions serve --no-verify-jwt" }],
    "foreign only",
  );
  assertEquals(parseForeignServeProcesses("", new Set()), [], "empty");
});

// --- Regression: a failed later cycle keeps the completed cycles (partial) ----

function fakeCycle(cycle: number, logPath: string): CycleResult {
  return {
    cycle: {
      cycle,
      serveReadyMs: 1000 + cycle,
      coldStartMs: 50 + cycle,
      coldStatus: 200,
      warmMs: [2, 3],
      logPath,
    },
    log: "Using supabase-edge-runtime-1.74.3 (compatible with Deno v2.1.4)",
  };
}

Deno.test(
  "measureCycles: a failing later cycle records a PARTIAL target and keeps cycle 1",
  async () => {
    const report = newServeTargetReport("bundle", "/wd", "cmd");
    const snapshots: string[] = [];
    let calls = 0;
    await measureCycles(
      report,
      3,
      "/out",
      (cycle, logPath) => {
        calls += 1;
        if (cycle === 2) {
          return Promise.reject(new Error("bundle deleted between cycles"));
        }
        return Promise.resolve(fakeCycle(cycle, logPath));
      },
      () => {
        snapshots.push(JSON.stringify(report));
        return Promise.resolve();
      },
    );
    assertEquals(calls, 2, "stops after the failing cycle");
    assertEquals(report.status, "partial", "status");
    assertEquals(report.reason, "bundle deleted between cycles", "reason");
    assertEquals(report.cycles.length, 1, "completed cycle kept");
    assertEquals(report.cycles[0].logPath, join("/out", "serve-bundle-1.log"), "log path");
    assertEquals(report.runtime?.edgeRuntime, "supabase-edge-runtime-1.74.3", "runtime parsed");
    assertEquals(report.coldStart?.count, 1, "summary over the kept cycle");
    assertEquals(snapshots.length, 2, "persisted after cycle 1 and after the failure");
    const afterCycleOne = JSON.parse(snapshots[0]) as ServeTargetReport;
    assertEquals(afterCycleOne.cycles.length, 1, "cycle 1 persisted before cycle 2 ran");
    assertEquals(afterCycleOne.status, "running", "still running after cycle 1");
  },
);

Deno.test("measureCycles: no completed cycle → UNAVAILABLE; all cycles → MEASURED", async () => {
  const unavailable = newServeTargetReport("source-tree", "/wd", "cmd");
  await measureCycles(
    unavailable,
    2,
    "/out",
    () => Promise.reject(new Error("cli exited")),
    () => Promise.resolve(),
  );
  assertEquals(unavailable.status, "unavailable", "unavailable");
  assertEquals(unavailable.cycles.length, 0, "no cycles");

  const measured = newServeTargetReport("bundle", "/wd", "cmd");
  let persisted = 0;
  await measureCycles(
    measured,
    2,
    "/out",
    (cycle, logPath) => Promise.resolve(fakeCycle(cycle, logPath)),
    () => {
      persisted += 1;
      return Promise.resolve();
    },
  );
  assertEquals(measured.status, "measured", "measured");
  assertEquals(measured.cycles.length, 2, "both cycles");
  assertEquals(measured.warm?.count, 4, "warm samples pooled");
  assertEquals(persisted, 3, "persist after each cycle + final");
});

Deno.test("finalizeReport: ok only when the bundle target measured every cycle", () => {
  const base = (): Report => ({
    generatedAt: "t",
    updatedAt: "t",
    status: "running",
    error: null,
    repoRoot: "/r",
    gitHead: null,
    entrypoint: FUNCTION_ENTRYPOINT,
    environment: {
      os: "linux",
      arch: "x86_64",
      deno: "2",
      v8: "1",
      typescript: "5",
      supabaseCli: null,
      docker: null,
      stack: null,
    },
    options: { ...DEFAULT_OPTIONS, cycles: 2 },
    bundle: null,
    sourceGraph: null,
    serve: [],
    ok: false,
  });
  const partial = base();
  partial.bundle = {} as BundleReport;
  const target = newServeTargetReport("bundle", "/wd", "cmd");
  target.cycles.push(fakeCycle(1, "/l").cycle);
  target.status = "partial";
  partial.serve.push(target);
  assertEquals(finalizeReport(partial), false, "partial is not ok");
  assertEquals(partial.status, "failed", "failed status");

  const interrupted = base();
  interrupted.bundle = {} as BundleReport;
  const running = newServeTargetReport("bundle", "/wd", "cmd");
  running.cycles.push(fakeCycle(1, "/l").cycle);
  interrupted.serve.push(running);
  interrupted.status = "interrupted";
  interrupted.error = "interrupted by SIGTERM";
  assertEquals(finalizeReport(interrupted), false, "interrupted is not ok");
  assertEquals(running.status, "partial", "running target closed as partial");
  assertEquals(running.reason, "interrupted by SIGTERM", "reason from the run error");
  assertEquals(interrupted.status, "interrupted", "status kept");

  const good = base();
  good.bundle = {} as BundleReport;
  const measured = newServeTargetReport("bundle", "/wd", "cmd");
  measured.cycles.push(fakeCycle(1, "/l").cycle, fakeCycle(2, "/l").cycle);
  measured.status = "measured";
  good.serve.push(measured);
  assertEquals(finalizeReport(good), true, "ok");
  assertEquals(good.status, "measured", "measured status");
});

Deno.test("ReportFile.persist writes valid JSON atomically", async () => {
  const dir = await Deno.makeTempDir({ prefix: "edge-cold-start-report-" });
  try {
    const file = new ReportFile(join(dir, "report.json"), {
      generatedAt: "t",
      updatedAt: "t",
      status: "running",
      error: null,
      repoRoot: "/r",
      gitHead: null,
      entrypoint: FUNCTION_ENTRYPOINT,
      environment: {
        os: "linux",
        arch: "x86_64",
        deno: "2",
        v8: "1",
        typescript: "5",
        supabaseCli: null,
        docker: null,
        stack: null,
      },
      options: DEFAULT_OPTIONS,
      bundle: null,
      sourceGraph: null,
      serve: [],
      ok: false,
    });
    await file.persist();
    const parsed = JSON.parse(await Deno.readTextFile(file.path)) as Report;
    assertEquals(parsed.status, "running", "round trip");
    assertEquals(await exists(`${file.path}.tmp`), false, "tmp renamed away");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Regression: shutdown tears down the whole spawned process tree -----------

Deno.test(
  "ShutdownController.shutdown interrupts every descendant of a tracked process",
  async () => {
    const controller = new ShutdownController();
    const child = new Deno.Command("sh", {
      args: ["-c", "sleep 300; sleep 300"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    controller.track(child, "sleeper", null);
    let grandchildren: number[] = [];
    const deadline = Date.now() + 5_000;
    while (grandchildren.length === 0 && Date.now() < deadline) {
      grandchildren = await descendantPids(child.pid);
      if (grandchildren.length === 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    assertEquals(grandchildren.length > 0, true, "sh forked its sleep");

    let hookRan = false;
    controller.onShutdown(() => {
      hookRan = true;
      return Promise.resolve();
    });
    await controller.shutdown("SIGTERM", 2_000);
    assertEquals(controller.interrupted, "SIGTERM", "interrupted signal recorded");
    assertEquals(hookRan, true, "hooks run after the tree is gone");
    assertEquals((await child.status).success, false, "root did not exit cleanly");
    for (const pid of grandchildren) {
      let alive = await processAlive(pid);
      const until = Date.now() + 2_000;
      while (alive && Date.now() < until) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        alive = await processAlive(pid);
      }
      assertEquals(alive, false, `descendant ${pid} still alive after shutdown`);
    }
    assertEquals(controller.trackedLabels, [], "nothing left tracked");

    let refused = false;
    const late = new Deno.Command("sleep", { args: ["300"], stdin: "null" }).spawn();
    try {
      controller.track(late, "late", null);
    } catch (error) {
      refused = error instanceof Interrupted;
    }
    await late.status;
    assertEquals(refused, true, "tracking after shutdown is refused (and the process killed)");
  },
);

Deno.test("ShutdownController runs per-process cleanup and tolerates its failure", async () => {
  const controller = new ShutdownController();
  const child = new Deno.Command("sleep", { args: ["300"], stdin: "null" }).spawn();
  const order: string[] = [];
  controller.track(child, "sleeper", () => {
    order.push("cleanup");
    return Promise.reject(new Error("docker unavailable"));
  });
  controller.onShutdown(() => {
    order.push("hook");
    return Promise.resolve();
  });
  await controller.shutdown("SIGINT", 2_000);
  assertEquals((await child.status).success, false, "process interrupted");
  assertEquals(order, ["cleanup", "hook"], "cleanup precedes hooks; a failing cleanup is reported");
});

Deno.test("classifyContainer: absent / CLI-owned / foreign", () => {
  assertEquals(classifyContainer(1, "", "pickle-sensei"), "absent", "inspect failed → absent");
  assertEquals(classifyContainer(0, "pickle-sensei\n", "pickle-sensei"), "cli-owned", "label");
  assertEquals(classifyContainer(0, "\n", "pickle-sensei"), "foreign", "unlabelled");
  assertEquals(classifyContainer(0, "other\n", "pickle-sensei"), "foreign", "other project");
});

Deno.test("RunLock: refuses a live holder, reclaims a dead one, releases", async () => {
  const dir = await Deno.makeTempDir({ prefix: "edge-cold-start-lock-" });
  const path = join(dir, "run.lock");
  try {
    const first = await RunLock.acquire(path, Deno.pid);
    let refused = "";
    try {
      await RunLock.acquire(path, Deno.pid);
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    assertEquals(refused.includes(`pid ${Deno.pid}`), true, `live holder refused: ${refused}`);
    await first.release();

    const dead = new Deno.Command("true", { stdin: "null" }).spawn();
    await dead.status;
    await Deno.writeTextFile(path, `${dead.pid}\n`);
    const reclaimed = await RunLock.acquire(path, Deno.pid);
    assertEquals((await Deno.readTextFile(path)).trim(), String(Deno.pid), "stale lock reclaimed");
    await reclaimed.release();
    await Deno.writeTextFile(path, "not a pid\n");
    const garbage = await RunLock.acquire(path, Deno.pid);
    await garbage.release();
    let exists = true;
    try {
      await Deno.stat(path);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "release removes the lock");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Regression: bundle identity does not depend on the checkout path ----------

Deno.test("normalizeBundlePaths rewrites the cwd→DENO_DIR prefix in labels and keys", () => {
  const text = [
    "// ../../.cache/deno/npm/registry.npmjs.org/tslib/2.8.1/tslib.js",
    "var require_tslib = __commonJS({",
    '  "../../.cache/deno/npm/registry.npmjs.org/tslib/2.8.1/tslib.js"(exports, module) {',
    "  }",
    "});",
    "// supabase/functions/api/index.ts",
    "",
  ].join("\n");
  const result = normalizeBundlePaths(text, "../../.cache/deno");
  assertEquals(result.rewrites, 2, "two rewrites");
  assertEquals(result.unresolved, 0, "nothing left outside the checkout");
  assertEquals(result.text.includes("../../.cache"), false, "prefix gone");
  assertEquals(
    result.text.split("$DENO_DIR/npm/registry.npmjs.org/tslib/2.8.1/tslib.js").length,
    3,
    "placeholder in label and key",
  );
  assertEquals(
    result.text.includes("// supabase/functions/api/index.ts"),
    true,
    "repo labels untouched",
  );
  assertEquals(
    normalizeBundlePaths("// ../elsewhere/x.js\n// /abs/y.js\n// ok/z.js\n", "../../.cache/deno"),
    { text: "// ../elsewhere/x.js\n// /abs/y.js\n// ok/z.js\n", rewrites: 0, unresolved: 2 },
    "labels that escape the checkout are counted, not hidden",
  );
  assertEquals(normalizeBundlePaths("// a\n", null).rewrites, 0, "no relative dir → no rewrite");
});

Deno.test("measureBundle: same bytes + sha256 from a checkout at a different path", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const other = await Deno.makeTempDir({ prefix: "edge-cold-start-checkout-" });
  const out = await Deno.makeTempDir({ prefix: "edge-cold-start-bundle-" });
  try {
    for (const rel of [
      "deno.json",
      "deno.lock",
      "package.json",
      FUNCTION_DIR,
      "packages/shared-types/src",
    ]) {
      await Deno.mkdir(dirname(join(other, rel)), { recursive: true });
      const copy = await new Deno.Command("cp", {
        args: ["-R", join(repoRoot, rel), join(other, rel)],
        stdin: "null",
      }).output();
      assertEquals(copy.success, true, `copy ${rel}`);
    }
    const here = await measureBundle(repoRoot, join(out, "here", "index.js"));
    const there = await measureBundle(other, join(out, "there", "index.js"));
    assertEquals(
      here.pathNormalization.rewrites > 0,
      true,
      "the bundler did label npm modules by path",
    );
    assertEquals(here.pathNormalization.unresolved, 0, "no label escapes the checkout (here)");
    assertEquals(there.pathNormalization.unresolved, 0, "no label escapes the checkout (there)");
    assertEquals(
      here.pathNormalization.denoDirRelative === there.pathNormalization.denoDirRelative,
      false,
      "the two checkouts spell $DENO_DIR differently (otherwise this test proves nothing)",
    );
    assertEquals(there.sha256, here.sha256, "sha256 identical across checkout paths");
    assertEquals(there.rawBytes, here.rawBytes, "served bytes identical across checkout paths");
    assertEquals(there.gzipBytes, here.gzipBytes, "gzip bytes identical");
    assertEquals(there.moduleCount, here.moduleCount, "module count identical");
    const served = await Deno.readTextFile(here.outputPath);
    assertEquals(
      served.includes(here.pathNormalization.denoDirRelative ?? "\u0000"),
      false,
      "served file carries no cwd-relative DENO_DIR path",
    );
  } finally {
    await Deno.remove(other, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});
