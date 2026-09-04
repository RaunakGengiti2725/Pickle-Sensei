// Edge-function fuzz campaign CLI.
//
//   cd supabase/functions/api/__wf__
//   deno run -A fuzz/run.ts --seed <seed> --count 5000 --out <dir>
//   deno run -A fuzz/run.ts --replay <seed>:<index>[,<seed>:<index>…] --epoch <s> [--out <dir>]
//   deno run -A fuzz/run.ts --replay-file <dir>/failures.json [--out <dir>]
//
// Every outbound call stays in-process (routesHarness + fuzz/upstream.ts).
// Exit code: 0 when no case failed, 1 otherwise, 2 on usage error.

import { loadHarness } from "../routesHarness.ts";
import {
  buildCase,
  type CaseResult,
  createRunner,
  type FailureRecord,
  makeUsers,
  memorySample,
  STRATEGIES,
} from "./campaign.ts";
import { ROUTES } from "./routes.ts";
import { installFuzzUpstream } from "./upstream.ts";

interface Manifest {
  seed: string;
  count: number;
  startIndex: number;
  epochSeconds: number;
  users: number;
  commit: string | null;
  deno: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  replayOf: string[] | null;
}

type Flag =
  "seed" | "count" | "out" | "replay" | "replay-file" | "epoch" | "users" | "start" | "timeout";
const FLAGS: readonly Flag[] = [
  "seed",
  "count",
  "out",
  "replay",
  "replay-file",
  "epoch",
  "users",
  "start",
  "timeout",
];

function parseFlags(argv: readonly string[]): Partial<Record<Flag, string>> & { quiet: boolean } {
  const out: Partial<Record<Flag, string>> & { quiet: boolean } = { quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      out.quiet = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)) as Flag;
    if (!arg.startsWith("--") || !FLAGS.includes(name)) {
      console.error(`unknown argument ${arg}`);
      Deno.exit(2);
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) {
      console.error(`--${name} needs a value`);
      Deno.exit(2);
    }
    out[name] = value;
  }
  return out;
}

const args = parseFlags(Deno.args);
const quiet = args.quiet;
const outDir = args.out ?? `fuzz-artifacts/${new Date().toISOString().replace(/[:.]/g, "-")}`;
await Deno.mkdir(outDir, { recursive: true });
const write = (name: string, value: unknown) =>
  Deno.writeTextFile(`${outDir}/${name}`, JSON.stringify(value, null, 2));

async function gitCommit(): Promise<string | null> {
  try {
    const out = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}

interface Target {
  seed: string;
  index: number;
}

let targets: Target[];
let epochSeconds: number;
let replayOf: string[] | null = null;
let seed: string;

if (args.replay || args["replay-file"]) {
  if (args["replay-file"]) {
    const failures = JSON.parse(await Deno.readTextFile(args["replay-file"])) as FailureRecord[];
    targets = failures.map((f) => ({ seed: f.result.label.split(":")[1], index: f.result.index }));
    const epochFromReplay = failures[0]?.replay.match(/--epoch (\d+)/)?.[1];
    epochSeconds = Number(args.epoch ?? epochFromReplay ?? Math.floor(Date.now() / 1000));
    replayOf = failures.map((f) => f.result.label);
  } else {
    targets = String(args.replay)
      .split(",")
      .map((pair) => {
        const at = pair.lastIndexOf(":");
        return { seed: pair.slice(0, at), index: Number(pair.slice(at + 1)) };
      });
    if (!args.epoch) {
      console.error("--replay requires --epoch <seconds> (copy it from the campaign manifest)");
      Deno.exit(2);
    }
    epochSeconds = Number(args.epoch);
    replayOf = targets.map((t) => `fuzz-edge:${t.seed}:${t.index}`);
  }
  seed = targets[0]?.seed ?? "replay";
} else {
  seed = args.seed ?? `edge-${Date.now().toString(36)}`;
  const count = Number(args.count ?? 5000);
  const start = Number(args.start ?? 0);
  epochSeconds = Number(args.epoch ?? Math.floor(Date.now() / 1000));
  targets = Array.from({ length: count }, (_, i) => ({ seed, index: start + i }));
}

if (!Number.isFinite(epochSeconds) || epochSeconds * 1000 < Date.now() - 3 * 3600 * 1000) {
  console.error(
    `epoch ${epochSeconds} is too old: session tokens minted from it are expired and every authed case would 401.`,
  );
  Deno.exit(2);
}

const userCount = Number(args.users ?? 256);
const manifest: Manifest = {
  seed,
  count: targets.length,
  startIndex: targets[0]?.index ?? 0,
  epochSeconds,
  users: userCount,
  commit: await gitCommit(),
  deno: Deno.version.deno,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationMs: null,
  replayOf,
};
await write("manifest.json", manifest);

const harness = await loadHarness();
const upstream = installFuzzUpstream(harness);
const runner = createRunner(harness, upstream, {
  epochSeconds,
  timeoutMs: Number(args.timeout ?? 20_000),
});
const usersBySeed = new Map<string, ReturnType<typeof makeUsers>>();

const results: CaseResult[] = [];
const failures: FailureRecord[] = [];
const memory: ReturnType<typeof memorySample>[] = [memorySample(0)];
const started = performance.now();

for (let i = 0; i < targets.length; i += 1) {
  const target = targets[i];
  let users = usersBySeed.get(target.seed);
  if (!users) {
    users = makeUsers(target.seed, userCount);
    usersBySeed.set(target.seed, users);
  }
  const spec = buildCase(target.seed, target.index, { users, epochSeconds });
  const { result, failure } = await runner.run(spec);
  results.push(result);
  if (failure) {
    failures.push(failure);
    if (!quiet) {
      console.error(
        `FAIL ${result.label} ${result.strategy} ${result.method} ${result.routeId} → ${result.status} [${result.failures.join(", ")}]`,
      );
    }
  }
  if ((i + 1) % 250 === 0 || i === targets.length - 1) {
    memory.push(memorySample(target.index));
    if (!quiet) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      console.error(
        `[fuzz] ${i + 1}/${targets.length} cases, ${failures.length} failures, ${elapsed}s, heapUsed ${(memory.at(-1)!.heapUsed / 1e6).toFixed(1)} MB`,
      );
    }
  }
}

runner.dispose();
upstream.uninstall();
manifest.finishedAt = new Date().toISOString();
manifest.durationMs = Math.round(performance.now() - started);

// ─── Matrices ────────────────────────────────────────────────────────────────

type Matrix = Record<string, Record<string, number>>;
const bump = (m: Matrix, row: string, col: string) => {
  m[row] ??= {};
  m[row][col] = (m[row][col] ?? 0) + 1;
};
const routeByStatus: Matrix = {};
const strategyByStatus: Matrix = {};
const strategyByRoute: Matrix = {};
const failureKinds: Record<string, number> = {};
const anomalyKinds: Record<string, number> = {};
const statusTotals: Record<string, number> = {};
const writesByRoute: Matrix = {};
let totalUpstream = 0;
let maxDuration = results[0] ?? null;
for (const r of results) {
  const status = String(r.status ?? "none");
  bump(routeByStatus, r.routeId, status);
  bump(strategyByStatus, r.strategy, status);
  bump(strategyByRoute, r.strategy, r.routeId);
  statusTotals[status] = (statusTotals[status] ?? 0) + 1;
  for (const f of r.failures)
    failureKinds[f.split(":")[0]] = (failureKinds[f.split(":")[0]] ?? 0) + 1;
  for (const a of r.anomalies)
    anomalyKinds[a.split(":")[0]] = (anomalyKinds[a.split(":")[0]] ?? 0) + 1;
  for (const w of r.writes) bump(writesByRoute, r.routeId, w);
  totalUpstream += r.upstreamCalls;
  if (maxDuration === null || r.durationMs > maxDuration.durationMs) maxDuration = r;
}
const routesCovered = new Set(results.map((r) => r.routeId));
const uncovered = ROUTES.map((r) => r.id).filter((id) => !routesCovered.has(id));
const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
const pct = (p: number) =>
  durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] ?? 0;

const summary = {
  manifest,
  cases: results.length,
  failures: failures.length,
  failureKinds,
  anomalyKinds,
  statusTotals,
  routesCovered: routesCovered.size,
  routesUncovered: uncovered,
  strategiesCovered: STRATEGIES.filter((s) => results.some((r) => r.strategy === s)),
  upstreamCalls: totalUpstream,
  latencyMs: {
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: maxDuration?.durationMs ?? 0,
    maxCase: maxDuration?.label ?? null,
  },
  memory: {
    start: memory[0],
    end: memory.at(-1),
    peakRss: Math.max(...memory.map((m) => m.rss)),
    peakHeapUsed: Math.max(...memory.map((m) => m.heapUsed)),
  },
};

await Promise.all([
  write("manifest.json", manifest),
  write("summary.json", summary),
  write("results.json", results),
  write("failures.json", failures),
  write("memory.json", memory),
  write("matrix_route_by_status.json", routeByStatus),
  write("matrix_strategy_by_status.json", strategyByStatus),
  write("matrix_strategy_by_route.json", strategyByRoute),
  write("matrix_writes_by_route.json", writesByRoute),
  Deno.writeTextFile(
    `${outDir}/results.jsonl`,
    results.map((r) => JSON.stringify(r)).join("\n") + "\n",
  ),
]);

if (!quiet) {
  console.error(JSON.stringify({ ...summary, manifest: undefined }, null, 2));
  console.error(`[fuzz] artifacts → ${outDir}`);
}
Deno.exit(failures.length === 0 ? 0 : 1);
