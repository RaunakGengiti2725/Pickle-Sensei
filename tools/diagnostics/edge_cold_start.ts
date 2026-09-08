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
