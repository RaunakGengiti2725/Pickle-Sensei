// Edge Function served-bundle size + cold-start measurement.
//
// Measures the shipping Supabase Edge Function (supabase/functions/api/index.ts)
// LOCALLY and writes a reproducible report:
//
//   1. Served bundle: `deno bundle --platform deno` (Deno's esbuild-backed bundler)
//      over the real entrypoint with the function's own deno.json import map and
//      lockfile. Reports raw bytes, gzip bytes, module count, bundle time, sha256.
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
//        - "source-tree": the repo checkout itself (what a developer would run).
//        - "bundle": a generated workdir whose function entrypoint is the bundle
//          from step 1. This is the target the acceptance measurement relies on.
//      A target whose CLI process exits before the runtime is healthy is reported
//      as UNAVAILABLE with the CLI's own message; it is never counted as a sample.
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
// Self-tests of the pure helpers:
//   deno test -A tools/diagnostics/edge_cold_start.ts
//
// Artifacts: artifacts/edge-cold-start/<UTC>/report.json, the bundle, the
// generated serve workdir, and one CLI log per serve cycle (artifacts/ is
// git-ignored).
//
// Exit code: 0 only when the bundle was measured AND the "bundle" serve target
// produced a cold-start sample for every requested cycle; 1 otherwise.

import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
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

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { ...DEFAULT_OPTIONS };
  const positiveInt = (flag: string, raw: string | undefined): number => {
    if (raw === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return Number(raw);
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
        if (value === undefined) {
          throw new Error("--out requires a directory");
        }
        options.outDir = value;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}`);
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

export function readProjectId(configToml: string): string {
  const match = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(configToml);
  if (match === null) {
    throw new Error("supabase/config.toml has no project_id");
  }
  return match[1];
}

/** `[api] port = N` from config.toml, or the CLI default when absent. */
export function readApiPort(configToml: string): number {
  const lines = configToml.split(/\r?\n/);
  let inApi = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section !== null) {
      inApi = section[1].trim() === "api";
      continue;
    }
    if (!inApi) {
      continue;
    }
    const port = /^\s*port\s*=\s*(\d+)/.exec(line);
    if (port !== null) {
      return Number(port[1]);
    }
  }
  return DEFAULT_API_PORT;
}

/** config.toml for the generated serve workdir whose entrypoint is the bundle. */
export function renderBundleWorkdirConfig(projectId: string, apiPort: number): string {
  return [
    `project_id = "${projectId}"`,
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
// Process helpers
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function run(cmd: string, args: readonly string[], cwd: string): Promise<RunResult> {
  const startedAt = performance.now();
  const output = await new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    durationMs: performance.now() - startedAt,
  };
}

async function runOrThrow(cmd: string, args: readonly string[], cwd: string): Promise<RunResult> {
  const result = await run(cmd, args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${result.code}\n${tail(result.stderr || result.stdout, 1200)}`,
    );
  }
  return result;
}

async function descendantPids(pid: number): Promise<number[]> {
  const result = await run("pgrep", ["-P", String(pid)], Deno.cwd());
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

function signal(pid: number, sig: Deno.Signal): void {
  try {
    Deno.kill(pid, sig);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

/**
 * `npx` does not forward SIGINT to the CLI binary it spawned, and the CLI keeps
 * polling a removed container forever; interrupt the whole tree, deepest first,
 * so the CLI's own cleanup ("Stopped serving …") runs.
 */
async function interruptTree(child: Deno.ChildProcess, timeoutMs: number): Promise<number | null> {
  const pids = await descendantPids(child.pid);
  for (const pid of pids) {
    signal(pid, "SIGINT");
  }
  signal(child.pid, "SIGINT");
  const exited = await Promise.race([
    child.status.then((status) => status.code),
    new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), timeoutMs)),
  ]);
  if (exited === null) {
    for (const pid of [...(await descendantPids(child.pid)), child.pid]) {
      signal(pid, "SIGKILL");
    }
    await child.status;
  }
  return exited;
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

interface BundleReport {
  command: string;
  rawBytes: number;
  gzipBytes: number;
  moduleCount: number | null;
  bundleMs: number;
  sha256: string;
  outputPath: string;
}

async function gzipSize(bytes: Uint8Array): Promise<number> {
  const compressed = await new Response(
    new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return compressed.byteLength;
}

async function measureBundle(repoRoot: string, outputPath: string): Promise<BundleReport> {
  await Deno.mkdir(dirname(outputPath), { recursive: true });
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
  const bytes = await Deno.readFile(outputPath);
  return {
    command: `deno ${args.join(" ")}`,
    rawBytes: bytes.byteLength,
    gzipBytes: await gzipSize(bytes),
    moduleCount: parseBundledModuleCount(`${result.stdout}\n${result.stderr}`),
    bundleMs: round(result.durationMs),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    outputPath,
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

interface ColdStartCycle {
  cycle: number;
  serveReadyMs: number;
  coldStartMs: number;
  coldStatus: number;
  warmMs: number[];
  logPath: string;
}

interface ServeTargetReport {
  target: "source-tree" | "bundle";
  workdir: string;
  command: string;
  status: "measured" | "unavailable";
  reason: string | null;
  runtime: RuntimeVersion | null;
  cycles: ColdStartCycle[];
  coldStart: Summary | null;
  warm: Summary | null;
  serveReady: Summary | null;
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

async function removeEdgeContainer(stack: Stack): Promise<void> {
  await run("docker", ["rm", "-f", stack.edgeContainer], Deno.cwd());
}

class ServeUnavailable extends Error {}

async function serveCycle(
  cli: Cli,
  stack: Stack,
  workdir: string,
  cycle: number,
  logPath: string,
  options: Options,
): Promise<{ cycle: ColdStartCycle; log: string }> {
  await removeEdgeContainer(stack);
  const logChunks: Uint8Array[] = [];
  const spawnedAt = performance.now();
  const child = new Deno.Command(cli.npx, {
    args: cli.args("--workdir", workdir, "functions", "serve", "--no-verify-jwt"),
    cwd: workdir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
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
    if (!exited) {
      await interruptTree(child, 15_000);
    }
    await exitWatch;
    await drained;
    await removeEdgeContainer(stack);
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

async function measureServeTarget(
  cli: Cli,
  stack: Stack,
  target: ServeTargetReport["target"],
  workdir: string,
  outDir: string,
  options: Options,
): Promise<ServeTargetReport> {
  const report: ServeTargetReport = {
    target,
    workdir,
    command: `npx --yes supabase@${cli.version} --workdir ${workdir} functions serve --no-verify-jwt`,
    status: "measured",
    reason: null,
    runtime: null,
    cycles: [],
    coldStart: null,
    warm: null,
    serveReady: null,
  };
  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    const logPath = join(outDir, `serve-${target}-${cycle}.log`);
    print(`  [${target}] cycle ${cycle}/${options.cycles} …`);
    try {
      const result = await serveCycle(cli, stack, workdir, cycle, logPath, options);
      report.cycles.push(result.cycle);
      report.runtime ??= parseEdgeRuntimeVersion(result.log);
      print(
        `  [${target}] cycle ${cycle}: serve ready ${result.cycle.serveReadyMs} ms, ` +
          `cold /healthz ${result.cycle.coldStartMs} ms, warm median ${summarize(result.cycle.warmMs)?.median ?? "n/a"} ms`,
      );
    } catch (error) {
      if (error instanceof ServeUnavailable && report.cycles.length === 0) {
        report.status = "unavailable";
        report.reason = error.message;
        print(`  [${target}] UNAVAILABLE: ${error.message.split("\n")[0]}`);
        break;
      }
      throw error;
    }
  }
  report.coldStart = summarize(report.cycles.map((cycle) => cycle.coldStartMs));
  report.serveReady = summarize(report.cycles.map((cycle) => cycle.serveReadyMs));
  report.warm = summarize(report.cycles.flatMap((cycle) => cycle.warmMs));
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
  print(`  starting local stack: npx --yes supabase@${cli.version} ${args.slice(1).join(" ")}`);
  await runOrThrow(cli.npx, args, repoRoot);
  running = await runningContainers();
  for (const name of [db, kong]) {
    if (!running.has(name)) {
      throw new Error(`${name} is not running after supabase start`);
    }
  }
  return "started by this script";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Report {
  generatedAt: string;
  repoRoot: string;
  gitHead: string | null;
  entrypoint: string;
  environment: {
    os: string;
    arch: string;
    deno: string;
    v8: string;
    typescript: string;
    supabaseCli: string;
    docker: string | null;
    stack: string;
  };
  options: Options;
  bundle: BundleReport;
  sourceGraph: SourceGraphReport;
  serve: ServeTargetReport[];
  ok: boolean;
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

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

  const gitHead = await run("git", ["rev-parse", "HEAD"], repoRoot);
  const cliVersionOut = await runOrThrow(cli.npx, cli.args("--version"), repoRoot);
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

  print("bundle: deno bundle --platform deno …");
  const bundle = await measureBundle(
    repoRoot,
    join(outDir, "workdir", "supabase", "functions", FUNCTION_SLUG, "index.js"),
  );
  print(
    `  raw ${formatBytes(bundle.rawBytes)}, gzip ${formatBytes(bundle.gzipBytes)}, ` +
      `${bundle.moduleCount ?? "?"} modules, ${bundle.bundleMs} ms, sha256 ${bundle.sha256.slice(0, 12)}…`,
  );

  print("source graph: deno info --json …");
  const sourceGraph = await measureSourceGraph(repoRoot);
  print(
    `  ${sourceGraph.firstPartyModules} first-party modules, ${formatBytes(sourceGraph.firstPartyBytes)}, ` +
      `npm: ${sourceGraph.npmPackages.length} packages`,
  );

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
  const stackState = await ensureStack(cli, repoRoot, stack);
  print(`  ${stackState}`);

  const bundleWorkdir = join(outDir, "workdir");
  await Deno.writeTextFile(
    join(bundleWorkdir, "supabase", "config.toml"),
    renderBundleWorkdirConfig(projectId, apiPort),
  );

  print(
    `cold start: ${options.cycles} cycle(s) × (1 cold + ${options.warmRequests} warm GET /healthz)`,
  );
  const serve: ServeTargetReport[] = [];
  serve.push(await measureServeTarget(cli, stack, "source-tree", repoRoot, outDir, options));
  serve.push(await measureServeTarget(cli, stack, "bundle", bundleWorkdir, outDir, options));

  const bundleTarget = serve.find((entry) => entry.target === "bundle");
  const ok =
    bundleTarget !== undefined &&
    bundleTarget.status === "measured" &&
    bundleTarget.cycles.length === options.cycles;

  const report: Report = {
    generatedAt: startedAt.toISOString(),
    repoRoot,
    gitHead: gitHead.code === 0 ? gitHead.stdout.trim() : null,
    entrypoint: FUNCTION_ENTRYPOINT,
    environment: {
      os: Deno.build.os,
      arch: Deno.build.arch,
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
      supabaseCli: stripAnsi(cliVersionOut.stdout).trim(),
      docker: dockerVersion.stdout.trim(),
      stack: stackState,
    },
    options,
    bundle,
    sourceGraph,
    serve,
    ok,
  };
  const reportPath = join(outDir, "report.json");
  await Deno.writeTextFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  print("");
  print("summary");
  print(
    `  deno ${report.environment.deno}, supabase cli ${report.environment.supabaseCli}, docker ${report.environment.docker}, ${report.environment.os}/${report.environment.arch}`,
  );
  print(
    `  served bundle: ${formatBytes(bundle.rawBytes)} raw, ${formatBytes(bundle.gzipBytes)} gzip, ${bundle.moduleCount ?? "?"} modules`,
  );
  print(
    `  source graph: ${sourceGraph.firstPartyModules} first-party modules (${formatBytes(sourceGraph.firstPartyBytes)}), npm ${sourceGraph.npmPackages.join(", ") || "none"}`,
  );
  for (const target of serve) {
    if (target.status === "unavailable") {
      print(`  serve[${target.target}]: UNAVAILABLE — ${target.reason?.split("\n").pop() ?? ""}`);
      continue;
    }
    const cold = target.coldStart;
    const warm = target.warm;
    const ready = target.serveReady;
    print(
      `  serve[${target.target}] ${target.runtime?.edgeRuntime ?? "runtime ?"}: cold /healthz ` +
        `min ${cold?.min} / median ${cold?.median} / max ${cold?.max} ms over ${cold?.count} cycle(s); ` +
        `warm median ${warm?.median} ms (n=${warm?.count}); serve ready median ${ready?.median} ms`,
    );
  }
  print(`  report: ${reportPath}`);
  print(ok ? "RESULT: measured" : "RESULT: FAILED — bundle target did not produce every cycle");
  return ok ? 0 : 1;
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main(Deno.args);
  } catch (error) {
    print(`edge_cold_start: ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
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

function assertThrows(fn: () => unknown, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
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
