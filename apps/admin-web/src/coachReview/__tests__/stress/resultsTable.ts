import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Outcome, ResultRow } from "./faultCatalog";

/**
 * Every harness appends one ResultRow per executed iteration and flushes the
 * table (seed → outcome) to apps/admin-web/e2e/dist/artifacts/stress/, which
 * the root .gitignore already excludes. The table is the evidence artifact the
 * stress report attaches; `scenarios_executed` is `rows.length`.
 */
export const STRESS_ARTIFACTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../e2e/dist/artifacts/stress",
);

export interface ResultsTable {
  harness: string;
  /** Identifies one runner invocation so restarted workers merge into the same table. */
  runToken: string;
  commit: string | null;
  startedAtIso: string;
  finishedAtIso: string | null;
  env: { STRESS_ITER?: string; STRESS_SEED?: string; STRESS_SEEDS?: string };
  executed: number;
  byOutcome: Record<Outcome, number>;
  failingSeeds: Array<{ seed: number; scenario: string; outcome: Outcome }>;
  rows: ResultRow[];
}

export function createResultsTable(harness: string): ResultsTable {
  return {
    harness,
    runToken: `${process.ppid}`,
    commit: process.env["GITHUB_SHA"] ?? process.env["STRESS_COMMIT"] ?? null,
    startedAtIso: new Date().toISOString(),
    finishedAtIso: null,
    env: {
      ...(process.env["STRESS_ITER"] ? { STRESS_ITER: process.env["STRESS_ITER"] } : {}),
      ...(process.env["STRESS_SEED"] ? { STRESS_SEED: process.env["STRESS_SEED"] } : {}),
      ...(process.env["STRESS_SEEDS"] ? { STRESS_SEEDS: process.env["STRESS_SEEDS"] } : {}),
    },
    executed: 0,
    byOutcome: {
      HELD: 0,
      BROKEN_CRASH: 0,
      BROKEN_SILENT: 0,
      BROKEN_FAKE_SUCCESS: 0,
      BROKEN_INFINITE_PENDING: 0,
      BROKEN_NO_RESPONSE: 0,
      BROKEN_STATE: 0,
      BROKEN_NO_RECOVERY: 0,
      BROKEN_WRONG_RESPONSE: 0,
      HARNESS_ERROR: 0,
    },
    failingSeeds: [],
    rows: [],
  };
}

export function recordResult(table: ResultsTable, row: ResultRow): void {
  table.rows.push(row);
  table.executed = table.rows.length;
  table.byOutcome[row.outcome] += 1;
  if (row.outcome !== "HELD") {
    table.failingSeeds.push({ seed: row.seed, scenario: row.scenario, outcome: row.outcome });
  }
}

/**
 * Writes the table. When the file already holds rows from the SAME runner invocation (Playwright
 * restarts its worker process after every failed test, which resets module state), those rows
 * are merged in first so the artifact always covers the whole campaign.
 */
export function flushResultsTable(table: ResultsTable, fileName: string): string {
  mkdirSync(STRESS_ARTIFACTS_DIR, { recursive: true });
  const path = resolve(STRESS_ARTIFACTS_DIR, fileName);
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, "utf8")) as Partial<ResultsTable>;
    if (previous.runToken === table.runToken && Array.isArray(previous.rows)) {
      const seen = new Set(table.rows.map((row) => row.seed));
      const merged = createResultsTable(table.harness);
      merged.startedAtIso = previous.startedAtIso ?? table.startedAtIso;
      for (const row of previous.rows) if (!seen.has(row.seed)) recordResult(merged, row);
      for (const row of table.rows) recordResult(merged, row);
      merged.rows.sort((a, b) => a.seed - b.seed);
      table.rows = merged.rows;
      table.executed = merged.executed;
      table.byOutcome = merged.byOutcome;
      table.failingSeeds = merged.failingSeeds.sort((a, b) => a.seed - b.seed);
      table.startedAtIso = merged.startedAtIso;
    }
  }
  table.finishedAtIso = new Date().toISOString();
  writeFileSync(path, JSON.stringify(table, null, 2));
  return path;
}

export function isBroken(outcome: Outcome): boolean {
  return outcome !== "HELD";
}
