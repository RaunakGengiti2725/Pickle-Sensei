/**
 * Campaign runner: iterates seeded scenarios against one target, records one
 * row per executed scenario (seed → outcome) and optionally writes the table
 * as JSON (STRESS_OUT=<dir>) so a run's evidence can be attached verbatim.
 *
 * Outcomes:
 * - "held"   — every asserted invariant held for this input.
 * - "broken" — an asserted invariant failed (the row carries the reason and a
 *              compact description of the input; the seed replays it).
 * - "note"   — informational observation, not an asserted contract (e.g. an
 *              unbounded string was accepted). Never counted as a failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostileCategory } from "./generators.js";
import { Rng, campaignConfig, iterationSeed, type CampaignConfig } from "./prng.js";

export type OutcomeKind = "held" | "broken" | "note";

export interface OutcomeRow {
  seed: number;
  iteration: number;
  target: string;
  category: HostileCategory | "mixed" | "fixture";
  outcome: OutcomeKind;
  check: string;
  detail?: string;
  input?: string;
  durationMs?: number;
}

export interface CampaignResult {
  name: string;
  config: CampaignConfig;
  executed: number;
  rows: OutcomeRow[];
  broken: OutcomeRow[];
  notes: OutcomeRow[];
  maxDurationMs: number;
}

export interface ScenarioContext {
  rng: Rng;
  seed: number;
  iteration: number;
  /** Record a passed invariant. */
  held(check: string, category?: OutcomeRow["category"], input?: string): void;
  /** Record a failed invariant. */
  broken(check: string, detail: string, input: string, category?: OutcomeRow["category"]): void;
  /** Record an observation that is not a contract violation. */
  note(check: string, detail: string, input: string, category?: OutcomeRow["category"]): void;
  /**
   * Run `fn` asserting it does not throw. Returns the value, or undefined
   * after recording a "broken" row. The throw itself is the failure.
   */
  noThrow<T>(
    check: string,
    input: string,
    fn: () => T,
    category?: OutcomeRow["category"],
  ): T | undefined;
}

export type Scenario = (ctx: ScenarioContext) => void;

/** Evidence rows stay replayable from their seed; the inline text is a bounded excerpt. */
const MAX_TEXT = 1_000;
function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (len=${text.length})` : text;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}

/**
 * Per-test timeout scaled to the configured campaign size (hostile resolver
 * inputs run ~10 ms each on 1 MB strings).
 */
export function campaignTimeoutMs(defaultIterations = 40): number {
  return Math.max(10_000, campaignConfig(defaultIterations).iterations * 50);
}

export function runCampaign(
  name: string,
  scenario: Scenario,
  options: { defaultIterations?: number; extraSeeds?: readonly number[] } = {},
): CampaignResult {
  const config = campaignConfig(options.defaultIterations ?? 40);
  const rows: OutcomeRow[] = [];
  let executed = 0;
  let maxDurationMs = 0;

  const seeds: Array<{ seed: number; iteration: number }> = [];
  for (let i = 0; i < config.iterations; i += 1) {
    seeds.push({ seed: iterationSeed(config.seed, i), iteration: i });
  }
  for (const seed of options.extraSeeds ?? []) seeds.push({ seed, iteration: -1 });

  for (const { seed, iteration } of seeds) {
    if (config.only !== null && seed !== config.only) continue;
    const rng = new Rng(seed);
    const started = performance.now();
    const ctx: ScenarioContext = {
      rng,
      seed,
      iteration,
      held(check, category = "mixed", input) {
        rows.push({
          seed,
          iteration,
          target: name,
          category,
          outcome: "held",
          check,
          ...(input === undefined ? {} : { input: clip(input) }),
        });
      },
      broken(check, detail, input, category = "mixed") {
        rows.push({
          seed,
          iteration,
          target: name,
          category,
          outcome: "broken",
          check,
          detail: clip(detail),
          input: clip(input),
        });
      },
      note(check, detail, input, category = "mixed") {
        rows.push({
          seed,
          iteration,
          target: name,
          category,
          outcome: "note",
          check,
          detail: clip(detail),
          input: clip(input),
        });
      },
      noThrow(check, input, fn, category = "mixed") {
        try {
          return fn();
        } catch (error) {
          rows.push({
            seed,
            iteration,
            target: name,
            category,
            outcome: "broken",
            check,
            detail: `threw ${errorText(error)}`,
            input: clip(input),
          });
          return undefined;
        }
      },
    };
    try {
      scenario(ctx);
    } catch (error) {
      // A throw escaping the scenario itself (generator bug or an unguarded
      // call) is recorded rather than aborting the campaign.
      rows.push({
        seed,
        iteration,
        target: name,
        category: "mixed",
        outcome: "broken",
        check: "scenario",
        detail: `scenario threw ${errorText(error)}`,
        input: "(see seed)",
      });
    }
    const durationMs = performance.now() - started;
    if (durationMs > maxDurationMs) maxDurationMs = durationMs;
    executed += 1;
  }

  const result: CampaignResult = {
    name,
    config,
    executed,
    rows,
    broken: rows.filter((r) => r.outcome === "broken"),
    notes: rows.filter((r) => r.outcome === "note"),
    maxDurationMs,
  };
  if (config.outDir !== null) writeCampaignJson(result);
  return result;
}

export function writeCampaignJson(result: CampaignResult): void {
  const dir = result.config.outDir;
  if (dir === null) return;
  mkdirSync(dir, { recursive: true });
  const perSeed = new Map<
    number,
    {
      seed: number;
      iteration: number;
      outcome: OutcomeKind;
      checks: number;
      broken: string[];
      notes: string[];
    }
  >();
  for (const row of result.rows) {
    const entry = perSeed.get(row.seed) ?? {
      seed: row.seed,
      iteration: row.iteration,
      outcome: "held" as OutcomeKind,
      checks: 0,
      broken: [],
      notes: [],
    };
    entry.checks += 1;
    if (row.outcome === "broken") {
      entry.outcome = "broken";
      entry.broken.push(`${row.check}: ${row.detail ?? ""} | input=${row.input ?? ""}`);
    } else if (row.outcome === "note") {
      entry.notes.push(`${row.check}: ${row.detail ?? ""}`);
    }
    perSeed.set(row.seed, entry);
  }
  const categories: Record<string, number> = {};
  for (const row of result.rows) categories[row.category] = (categories[row.category] ?? 0) + 1;
  const table = {
    target: result.name,
    campaignSeed: result.config.seed,
    iterations: result.config.iterations,
    executed: result.executed,
    checks: result.rows.length,
    brokenChecks: result.broken.length,
    noteChecks: result.notes.length,
    maxScenarioDurationMs: Number(result.maxDurationMs.toFixed(3)),
    categoryCoverage: categories,
    replay: `STRESS_SEED=${result.config.seed} STRESS_ONLY=<seed> pnpm --filter <pkg> test -- <file>`,
    seeds: [...perSeed.values()],
    brokenRows: result.broken,
    noteRows: result.notes,
  };
  const fileName = `${result.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
  writeFileSync(join(dir, fileName), JSON.stringify(table, null, 2));
}

/** Format the broken rows for an assertion message (bounded). */
export function summarizeBroken(result: CampaignResult): string {
  return result.broken
    .slice(0, 12)
    .map((r) => `seed=${r.seed} [${r.category}] ${r.check}: ${r.detail ?? ""} :: ${r.input ?? ""}`)
    .join("\n");
}

/** Numbers anywhere inside a value must be finite and never -0. */
export function findNonFiniteOrNegativeZero(value: unknown, path = "$"): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${path}=${String(value)}`;
    if (Object.is(value, -0)) return `${path}=-0`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNonFiniteOrNegativeZero(value[i], `${path}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const hit = findNonFiniteOrNegativeZero(inner, `${path}.${key}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** Stable JSON for determinism comparisons (Map/Set free outputs only). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner === "number" && !Number.isFinite(inner)) return `<${String(inner)}>`;
    if (typeof inner === "bigint") return `<bigint ${inner.toString()}>`;
    if (typeof inner === "symbol") return `<${inner.toString()}>`;
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(inner as Record<string, unknown>).sort()) {
        sorted[k] = (inner as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return inner;
  });
}
