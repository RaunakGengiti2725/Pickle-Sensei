import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarize, writeArtifacts } from "./report.js";
import type { CellResult } from "./runCell.js";
import type { MatrixScale } from "./shapes.js";

/**
 * Merge sharded matrix runs (`XC_MATRIX_SHARD=<i>/<n>`) back into one
 * artifact set at the parent directory:
 *
 *   pnpm --filter @pickle/swing-lab exec tsx test/xcMatrixMedia1/mergeShards.ts \
 *     artifacts/xc-matrix-media-1/full-20260904
 *
 * Every shard ran the degenerate cells; they are de-duplicated by cellId.
 * Exits 1 when any shard directory is missing its results.json so a partial
 * merge can never masquerade as a complete run.
 */

const baseDir = resolve(process.argv[2] ?? "");
if (!baseDir || !existsSync(join(baseDir, "shards"))) {
  process.stderr.write(`usage: mergeShards.ts <matrix out dir containing shards/>\n`);
  process.exit(2);
}
const shardsDir = join(baseDir, "shards");
const shardNames = readdirSync(shardsDir).sort();
const expectedCount = new Set(shardNames.map((n) => Number(n.split("-of-")[1])));
if (expectedCount.size !== 1) {
  process.stderr.write(`inconsistent shard counts in ${shardsDir}: ${shardNames.join(", ")}\n`);
  process.exit(1);
}
const count = [...expectedCount][0]!;
const missing: string[] = [];
const results: CellResult[] = [];
const degenerate = new Map<string, CellResult>();
let scale: MatrixScale = "full";
let masterSeed = 0;
let startedAtIso = "";
let finishedAtIso = "";
let wallClockMs = 0;
for (let i = 0; i < count; i += 1) {
  const dir = join(shardsDir, `${i}-of-${count}`);
  const resultsPath = join(dir, "results.json");
  const summaryPath = join(dir, "summary.json");
  if (!existsSync(resultsPath) || !existsSync(summaryPath)) {
    missing.push(dir);
    continue;
  }
  const all = JSON.parse(readFileSync(resultsPath, "utf8")) as CellResult[];
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    scale: MatrixScale;
    masterSeed: number;
    startedAtIso: string;
    finishedAtIso: string;
    wallClockMs: number;
  };
  scale = summary.scale;
  masterSeed = summary.masterSeed;
  if (!startedAtIso || summary.startedAtIso < startedAtIso) startedAtIso = summary.startedAtIso;
  if (summary.finishedAtIso > finishedAtIso) finishedAtIso = summary.finishedAtIso;
  wallClockMs = Math.max(wallClockMs, summary.wallClockMs);
  for (const r of all) {
    if (r.spec.resolution.family === "degenerate") degenerate.set(r.spec.cellId, r);
    else results.push(r);
  }
}
if (missing.length > 0) {
  process.stderr.write(`missing shard artifacts:\n${missing.join("\n")}\n`);
  process.exit(1);
}
const merged = summarize(results, [...degenerate.values()], {
  masterSeed,
  scale,
  startedAtIso,
  finishedAtIso,
  wallClockMs,
});
const paths = writeArtifacts(baseDir, merged, results, [...degenerate.values()]);
process.stdout.write(
  `${JSON.stringify(
    {
      shards: count,
      cells: merged.cells,
      degenerateCells: merged.degenerateCells,
      notRun: merged.notRun.length,
      violatingCells: merged.violatingCells,
      violationsByInvariant: merged.violationsByInvariant,
      outcomes: merged.outcomes,
      ...paths,
    },
    null,
    2,
  )}\n`,
);
