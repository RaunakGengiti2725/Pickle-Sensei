/**
 * Seeded randomized long-run stress campaign over @pickle/scoring.
 *
 * Every iteration derives a plan of 5..60 legal / near-legal / hostile actions
 * from a 32-bit seed (see test/stress/scoringCampaign.ts for the action
 * vocabulary and the invariant catalogue), executes it against real package
 * objects with an oracle model, checks every invariant after every step and
 * executes the identical plan a second time to prove the trace is
 * byte-for-byte deterministic.
 *
 * Environment:
 *   STRESS_ITER  sequences per run (default 120 — fast enough for the suite)
 *   STRESS_SEED  base seed (default 20260904); per-sequence seeds derive from it
 *   STRESS_OUT   when set, the seed → outcome JSON table is written there
 *
 * Replay one sequence: STRESS_ITER=1 STRESS_SEED=<seed> STRESS_SINGLE=1 …
 * (STRESS_SINGLE makes the run use STRESS_SEED verbatim as the sequence seed).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { SHOT_TYPES } from "@pickle/shared-types";
import type { Measurement } from "@pickle/shared-types";
import {
  buildProgressLine,
  getShotScoringConfig,
  PriorityCoachingRanker,
  scoreShot,
  VersionComparability,
  type VersionedScore,
} from "../src/index.js";
import { canonicalJson, sequenceSeed } from "./stress/rng.js";
import {
  executePlan,
  generatePlan,
  minimizePlan,
  type InputClass,
  type ScoringAction,
  type Violation,
} from "./stress/scoringCampaign.js";

const ITER = Number.parseInt(process.env.STRESS_ITER ?? "120", 10);
const BASE_SEED = Number.parseInt(process.env.STRESS_SEED ?? "20260904", 10);
const SINGLE = process.env.STRESS_SINGLE === "1";
const OUT = process.env.STRESS_OUT;
const MAX_MINIMIZED_PER_INVARIANT = 3;

/**
 * Invariants the campaign has shown the CURRENT implementation violates for
 * in-domain input. They are pinned individually below with a minimal
 * deterministic repro (`it.fails`) so the suite flips when they are fixed;
 * the campaign records but does not fail on them.
 */
const KNOWN_BROKEN: ReadonlySet<string> = new Set(["S7b", "L6", "A4"]);

interface Row {
  seed: number;
  length: number;
  actions: Record<string, number>;
  traceHash: string;
  deterministic: boolean;
  outcome: "held" | "violated" | "hostile_only" | "known_broken_only";
  violations: Violation[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classify(violations: Violation[]): Row["outcome"] {
  if (violations.length === 0) return "held";
  const inDomain = violations.filter((v) => v.inputClass !== "hostile");
  if (inDomain.length === 0) return "hostile_only";
  if (inDomain.every((v) => KNOWN_BROKEN.has(v.invariant))) return "known_broken_only";
  return "violated";
}

describe("stress: seeded randomized long-run over @pickle/scoring", () => {
  it(
    `holds every invariant over ${ITER} seeded action sequences (len 5-60) and replays deterministically`,
    { timeout: 30 * 60_000 },
    async () => {
      const rows: Row[] = [];
      let scenarios = 0;
      let steps = 0;
      for (let i = 0; i < ITER; i++) {
        const seed = SINGLE ? BASE_SEED : sequenceSeed(BASE_SEED, i);
        const plan = generatePlan(seed);
        const planAgain = generatePlan(seed);
        expect(canonicalJson(planAgain), `plan generation for seed ${seed} is deterministic`).toBe(
          canonicalJson(plan),
        );
        const first = await executePlan(plan);
        const second = await executePlan(plan);
        const traceHash = hash(canonicalJson(first.trace));
        const deterministic = traceHash === hash(canonicalJson(second.trace));
        const violations = [...first.violations];
        if (!deterministic) {
          violations.push({
            step: -1,
            action: "score_shot",
            invariant: "DETERMINISM",
            inputClass: "legal",
            detail: "same plan executed twice produced different traces",
          });
        }
        scenarios++;
        steps += plan.length;
        rows.push({
          seed,
          length: plan.length,
          actions: first.actionCounts,
          traceHash,
          deterministic,
          outcome: classify(violations),
          violations,
        });
      }

      // Minimise failing seeds (per invariant, capped) so each failure has a
      // small replayable plan attached to the artifact.
      const minimized: Array<{
        seed: number;
        invariant: string;
        inputClass: InputClass;
        originalLength: number;
        minimizedLength: number;
        detail: string;
        actions: ScoringAction[];
      }> = [];
      const perInvariant = new Map<string, number>();
      for (const row of rows) {
        const seen = new Set<string>();
        for (const v of row.violations) {
          if (v.invariant === "DETERMINISM") continue;
          const key = `${v.inputClass}:${v.invariant}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const n = perInvariant.get(key) ?? 0;
          if (n >= MAX_MINIMIZED_PER_INVARIANT) continue;
          perInvariant.set(key, n + 1);
          const plan = generatePlan(row.seed);
          const result = await minimizePlan(plan, v.invariant);
          minimized.push({
            seed: row.seed,
            invariant: v.invariant,
            inputClass: result.violation?.inputClass ?? v.inputClass,
            originalLength: plan.length,
            minimizedLength: result.actions.length,
            detail: result.violation?.detail ?? v.detail,
            actions: result.actions,
          });
        }
      }

      const byInvariant: Record<
        string,
        { sequences: number; steps: number; classes: Record<string, number> }
      > = {};
      for (const row of rows) {
        const seenInRow = new Set<string>();
        for (const v of row.violations) {
          const entry = (byInvariant[v.invariant] ??= { sequences: 0, steps: 0, classes: {} });
          entry.steps++;
          entry.classes[v.inputClass] = (entry.classes[v.inputClass] ?? 0) + 1;
          if (!seenInRow.has(v.invariant)) {
            seenInRow.add(v.invariant);
            entry.sequences++;
          }
        }
      }
      const summary = {
        package: "@pickle/scoring",
        baseSeed: BASE_SEED,
        iterations: ITER,
        scenariosExecuted: scenarios,
        stepsExecuted: steps,
        minLength: Math.min(...rows.map((r) => r.length)),
        maxLength: Math.max(...rows.map((r) => r.length)),
        deterministicSequences: rows.filter((r) => r.deterministic).length,
        outcomes: {
          held: rows.filter((r) => r.outcome === "held").length,
          known_broken_only: rows.filter((r) => r.outcome === "known_broken_only").length,
          hostile_only: rows.filter((r) => r.outcome === "hostile_only").length,
          violated: rows.filter((r) => r.outcome === "violated").length,
        },
        knownBroken: [...KNOWN_BROKEN],
        violationsByInvariant: byInvariant,
      };
      if (OUT) {
        mkdirSync(dirname(OUT), { recursive: true });
        writeFileSync(OUT, canonicalJson({ summary, minimized, rows }) + "\n");
      }

      expect(scenarios).toBe(ITER);
      expect(rows.every((r) => r.length >= 5 && r.length <= 60)).toBe(true);
      expect(rows.filter((r) => !r.deterministic).map((r) => r.seed)).toEqual([]);
      const unexpected = rows
        .flatMap((r) => r.violations.map((v) => ({ seed: r.seed, ...v })))
        .filter((v) => v.inputClass !== "hostile" && !KNOWN_BROKEN.has(v.invariant));
      expect(unexpected, JSON.stringify(unexpected.slice(0, 5), null, 2)).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Pinned minimal repros for the invariants the campaign found BROKEN. Each is
// `it.fails`: the assertion states the intended behaviour, and the test turns
// red the day the behaviour is fixed (then move it to a regular `it`).
// ---------------------------------------------------------------------------

function m(metricKey: string, value: number, confidence: number): Measurement {
  return { metricKey, value, confidence, unit: "normalized", source: "fixture" };
}

describe("stress findings pinned (currently failing on purpose)", () => {
  it.fails("S7b: a zero-confidence measurement must not decide the checkpoint direction", () => {
    // forehand_drive.contact_position has two metrics; the c=0 one is far
    // outside its range, the c=0.9 one is dead centre.
    const config = getShotScoringConfig("forehand_drive");
    const cp = config.checkpoints.find((c) => c.key === "contact_position")!;
    const [a, b] = cp.metrics;
    expect(a && b).toBeTruthy();
    const outcome = scoreShot(config, [
      m(a!.metricKey, a!.lower - 100 * a!.sigma, 0),
      m(b!.metricKey, (b!.lower + b!.upper) / 2, 0.9),
    ]);
    const result = outcome.checkpointResults.find((r) => r.key === "contact_position")!;
    expect(result.score).toBeCloseTo(100, 6);
    expect(result.direction).toBe("none");
  });

  it.fails("L6: a versioning progress segment must not span two incomparable versions", () => {
    const comparability = new VersionComparability([
      { versionA: "sm-v1", versionB: "sm-v2", rationale: "calibrated v1↔v2" },
      { versionA: "sm-v2", versionB: "sm-v3", rationale: "calibrated v2↔v3" },
    ]);
    const point = (runId: string, version: string, day: string): VersionedScore => ({
      runId,
      shotId: "shot-a",
      scoringModelVersion: version,
      overallScore: 5,
      capturedAt: `2026-01-${day}T00:00:00.000Z`,
      scoredAt: `2026-01-${day}T00:00:00.000Z`,
    });
    const line = buildProgressLine(
      [point("r1", "sm-v2", "01"), point("r2", "sm-v1", "02"), point("r3", "sm-v3", "03")],
      comparability,
    );
    for (const element of line) {
      if (element.kind !== "segment") continue;
      const versions = [...new Set(element.segment.points.map((p) => p.scoringModelVersion))];
      for (const x of versions) {
        for (const y of versions) {
          expect(comparability.isComparable(x, y), `${x} vs ${y} in one segment`).toBe(true);
        }
      }
    }
  });

  it.fails(
    "A4: PriorityCoachingRanker.rank returns a Result failure for an unknown stroke",
    async () => {
      const ranker = new PriorityCoachingRanker();
      const unknownStroke = "lob" as (typeof SHOT_TYPES)[number];
      const result = await ranker.rank({
        shotType: unknownStroke,
        scorerInternal: { checkpointResults: [], shotType: unknownStroke },
      });
      expect(result.ok).toBe(false);
    },
  );
});
