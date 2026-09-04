import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main, parseArgs, resolveUserPath } from "./cli.js";
import type { RunResourceUsage } from "./determinism.js";

/**
 * One `bench:regression run` invocation plus a resource-usage sidecar.
 *
 *   tsx src/regression/determinismChild.ts run --out-dir <dir> --run-id <id> [--only a,b]
 *
 * Delegates to the real CLI `main` (same code path as `bench:regression`)
 * and, after it returns, writes `<out-dir>/<run-id>.rusage.json` with the
 * process's peak RSS, heap and CPU figures so the harness can report
 * memory alongside timing. Exit code is the CLI's.
 */
export function collectResourceUsage(): RunResourceUsage {
  const usage = process.resourceUsage();
  const memory = process.memoryUsage();
  return {
    maxRssKb: usage.maxRSS,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    rssBytes: memory.rss,
    userCpuMs: Math.round(usage.userCPUTime / 1000),
    systemCpuMs: Math.round(usage.systemCPUTime / 1000),
  };
}

export function rusageSidecarPath(argv: string[]): string | null {
  const parsed = parseArgs(argv);
  const outDir = parsed.flags.get("out-dir");
  const runId = parsed.flags.get("run-id");
  if (typeof outDir !== "string" || typeof runId !== "string") return null;
  return join(resolveUserPath(outDir), `${runId}.rusage.json`);
}

export function childMain(argv: string[]): number {
  const sidecar = rusageSidecarPath(argv);
  const code = main(argv);
  if (sidecar !== null) {
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, `${JSON.stringify(collectResourceUsage(), null, 2)}\n`);
  }
  return code;
}

if (process.argv[1] && /determinismChild\.(ts|js)$/.test(process.argv[1])) {
  process.exitCode = childMain(process.argv.slice(2));
}
