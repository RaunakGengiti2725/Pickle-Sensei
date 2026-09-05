import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ddmin } from "./ddmin.js";
import { Rng, sequenceSeed } from "./rng.js";

/**
 * Shared runner for the seeded randomized long-run campaigns.
 *
 * A family = generator (seed → op list) + replayer (op list → trace +
 * invariant failures). The runner drives N sequences, replays every sequence
 * a second time to prove determinism, minimizes every failing op list with
 * ddmin, and emits one JSON table (seed → outcome) per family.
 *
 * Environment knobs (all optional):
 *   STRESS_ITER     sequences per family (default 40 — keeps `pnpm test` fast)
 *   STRESS_SEED     campaign base seed (default 20260904)
 *   STRESS_OUT      directory to write `<family>.json` tables into
 *   STRESS_MINIMIZE "0" disables ddmin on failing seeds
 */

export interface Failure {
  invariant: string;
  step: number;
  detail: string;
}

export interface Replay {
  trace: string;
  failures: Failure[];
  /** Coverage counters (how often each interesting state was actually reached). */
  coverage: Record<string, number>;
}

export function bump(coverage: Record<string, number>, key: string, by = 1): void {
  coverage[key] = (coverage[key] ?? 0) + by;
}

export interface Family<Op> {
  name: string;
  generate(rng: Rng, length: number): Op[];
  run(ops: readonly Op[]): Promise<Replay>;
}

export type Outcome = "held" | "broken" | "nondeterministic";

export interface SequenceResult {
  index: number;
  seed: number;
  length: number;
  outcome: Outcome;
  traceHash: string;
  failures: Failure[];
  minimized?: {
    length: number;
    replays: number;
    failures: Failure[];
    ops: unknown[];
  };
}

export interface CampaignReport {
  family: string;
  baseSeed: number;
  sequences: number;
  totalOps: number;
  held: number;
  broken: number;
  nondeterministic: number;
  failuresByInvariant: Record<string, number>;
  seedsByInvariant: Record<string, number[]>;
  coverage: Record<string, number>;
  results: SequenceResult[];
}

export interface CampaignOptions {
  baseSeed: number;
  count: number;
  minLength: number;
  maxLength: number;
  minimize: boolean;
}

export const SEQUENCE_MIN_LENGTH = 5;
export const SEQUENCE_MAX_LENGTH = 60;

export function campaignOptionsFromEnv(): CampaignOptions {
  const iter = Number.parseInt(process.env["STRESS_ITER"] ?? "", 10);
  const seed = Number.parseInt(process.env["STRESS_SEED"] ?? "", 10);
  return {
    baseSeed: Number.isFinite(seed) ? seed >>> 0 : 20260904,
    count: Number.isFinite(iter) && iter > 0 ? iter : 40,
    minLength: SEQUENCE_MIN_LENGTH,
    maxLength: SEQUENCE_MAX_LENGTH,
    minimize: process.env["STRESS_MINIMIZE"] !== "0",
  };
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** JSON with NaN/±Infinity/undefined preserved as tagged strings. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v)) return { $num: String(v) };
    if (v === undefined) return { $undefined: true };
    if (v instanceof Map) return { $map: [...v.entries()] };
    return v;
  });
}

function sameFailures(a: readonly Failure[], b: readonly Failure[]): boolean {
  return stableJson(a) === stableJson(b);
}

export async function runCampaign<Op>(
  family: Family<Op>,
  options: CampaignOptions,
): Promise<CampaignReport> {
  const results: SequenceResult[] = [];
  const failuresByInvariant: Record<string, number> = {};
  const seedsByInvariant: Record<string, number[]> = {};
  const coverage: Record<string, number> = {};
  let totalOps = 0;

  for (let index = 0; index < options.count; index++) {
    const seed = sequenceSeed(options.baseSeed, index);
    const length = new Rng(seed ^ 0x5bd1e995).int(options.minLength, options.maxLength);
    const ops = family.generate(new Rng(seed), length);
    const opsAgain = family.generate(new Rng(seed), length);
    totalOps += ops.length;

    const first = await family.run(ops);
    const second = await family.run(ops);
    const deterministic =
      stableJson(ops) === stableJson(opsAgain) &&
      first.trace === second.trace &&
      sameFailures(first.failures, second.failures) &&
      stableJson(first.coverage) === stableJson(second.coverage);
    for (const [key, n] of Object.entries(first.coverage)) bump(coverage, key, n);

    let outcome: Outcome = "held";
    const failures = [...first.failures];
    if (!deterministic) {
      outcome = "nondeterministic";
      failures.push({
        invariant: "DETERMINISM",
        step: -1,
        detail: `trace ${fnv1a(first.trace)} vs ${fnv1a(second.trace)}; failures ${stableJson(
          first.failures,
        )} vs ${stableJson(second.failures)}`,
      });
    } else if (failures.length > 0) {
      outcome = "broken";
    }

    const result: SequenceResult = {
      index,
      seed,
      length: ops.length,
      outcome,
      traceHash: fnv1a(first.trace),
      failures,
    };

    for (const invariant of new Set(failures.map((f) => f.invariant))) {
      failuresByInvariant[invariant] = (failuresByInvariant[invariant] ?? 0) + 1;
      (seedsByInvariant[invariant] ??= []).push(seed);
    }

    if (outcome === "broken" && options.minimize) {
      const targetInvariants = new Set(first.failures.map((f) => f.invariant));
      const stillFails = async (candidate: readonly Op[]): Promise<boolean> => {
        const replay = await family.run(candidate);
        const seen = new Set(replay.failures.map((f) => f.invariant));
        return [...targetInvariants].every((inv) => seen.has(inv));
      };
      const minimized = await ddmin(ops, stillFails);
      const replay = await family.run(minimized.ops);
      result.minimized = {
        length: minimized.ops.length,
        replays: minimized.replays,
        failures: replay.failures,
        ops: minimized.ops,
      };
    }

    results.push(result);
  }

  return {
    family: family.name,
    baseSeed: options.baseSeed,
    sequences: results.length,
    totalOps,
    held: results.filter((r) => r.outcome === "held").length,
    broken: results.filter((r) => r.outcome === "broken").length,
    nondeterministic: results.filter((r) => r.outcome === "nondeterministic").length,
    failuresByInvariant,
    seedsByInvariant,
    coverage: Object.fromEntries(Object.entries(coverage).sort(([a], [b]) => (a < b ? -1 : 1))),
    results,
  };
}

/** Write the report when STRESS_OUT is set; returns the path written (or null). */
export function persistReport(report: CampaignReport): string | null {
  const outDir = process.env["STRESS_OUT"];
  if (!outDir) return null;
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${report.family}.json`);
  writeFileSync(path, stableJson(report), "utf8");
  return path;
}

/** Seeds that broke `invariant`, for assertion messages. */
export function describeBreaks(report: CampaignReport, invariant: string): string {
  const seeds = report.seedsByInvariant[invariant] ?? [];
  const sample = report.results.find((r) => r.failures.some((f) => f.invariant === invariant));
  const detail = sample?.failures.find((f) => f.invariant === invariant)?.detail ?? "";
  const minimized = sample?.minimized ? ` minimized→${sample.minimized.length} ops` : "";
  return `${invariant}: ${seeds.length}/${report.sequences} seeds broke (e.g. seed ${
    seeds[0] ?? "-"
  }${minimized}): ${detail}`;
}

/** Invariants that never fired across the campaign. */
export function heldInvariants(report: CampaignReport, all: readonly string[]): string[] {
  return all.filter((invariant) => !(invariant in report.failuresByInvariant));
}
