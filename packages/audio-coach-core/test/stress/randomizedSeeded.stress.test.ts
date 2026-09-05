import { afterAll, describe, expect, it } from "vitest";

import {
  runCampaign,
  runSequence,
  runSessionEndCampaign,
  type CampaignSummary,
  type Engine,
  type SessionEndResult,
} from "./campaign.js";
import type { InputMode } from "./generators.js";
import { writeReport } from "./report.js";

/**
 * Seeded randomized long-run stress campaign for the audio-coach-core cue
 * engines (see campaign.ts / invariants.ts for the model-checked properties).
 *
 * Default scale keeps the suite fast; the full campaign runs with
 *   STRESS_ITER=2000 STRESS_OUT=/tmp/stress pnpm --filter @pickle/audio-coach-core test
 * STRESS_OUT writes the seed → outcome JSON table, minimized failing
 * sequences and flake rates; STRESS_SEED overrides the base seed. Every row
 * is replayable from `runSequence(engine, mode, row.seed)`.
 */
const ITER = Number.parseInt(process.env.STRESS_ITER ?? "", 10) || 40;
const BASE_SEED = Number.parseInt(process.env.STRESS_SEED ?? "", 10) || 0x9e3779b9;
const OUT = process.env.STRESS_OUT ?? "";

const ENGINES: Engine[] = ["cue", "live"];
const ROBUSTNESS = new Set(["X1.threw", "D1.determinism"]);
const LEGAL_MODES: InputMode[] = ["legal", "near-legal"];

const campaigns: CampaignSummary[] = [];
const sessionEnd: SessionEndResult[] = [];

function describeBroken(rows: CampaignSummary["rows"]): string {
  return rows
    .filter((r) => r.outcome === "BROKEN")
    .slice(0, 5)
    .map(
      (r) => `${r.engine}/${r.mode} seed=${r.seed} ${JSON.stringify(r.hardViolations.slice(0, 3))}`,
    )
    .join("\n");
}

describe(`randomized seeded long-run (STRESS_ITER=${ITER})`, () => {
  afterAll(() => {
    if (OUT.length > 0) {
      writeReport(OUT, campaigns, sessionEnd, {
        iter: ITER,
        baseSeed: BASE_SEED,
        generatedAt: new Date().toISOString(),
      });
    }
  });

  for (const engine of ENGINES) {
    for (const mode of LEGAL_MODES) {
      it(`${engine} engine holds every hard invariant on ${mode} sequences`, () => {
        const summary = runCampaign(engine, mode, ITER, BASE_SEED);
        campaigns.push(summary);
        expect(summary.sequences).toBe(ITER);
        expect(summary.steps).toBeGreaterThanOrEqual(ITER * 5);
        expect(summary.rows.every((r) => r.length >= 5 && r.length <= 60)).toBe(true);
        expect(summary.broken, describeBroken(summary.rows)).toBe(0);
        expect(summary.rows.every((r) => r.deterministic)).toBe(true);
        expect(summary.rows.every((r) => r.roundTripStable)).toBe(true);
        expect(summary.rows.every((r) => r.threw === null)).toBe(true);
      });
    }

    // Hostile (NaN/±Infinity) inputs: the engines carry no input-validation
    // contract, so only crash-freedom and determinism are asserted here; every
    // other violation (e.g. a non-finite score reaching spoken text) is kept in
    // the campaign table for the report.
    it(`${engine} engine never throws and stays deterministic on hostile inputs`, () => {
      const summary = runCampaign(engine, "hostile", ITER, BASE_SEED);
      campaigns.push(summary);
      const rows = summary.rows.filter((r) =>
        r.hardViolations.some((v) => ROBUSTNESS.has(v.invariant)),
      );
      expect(rows, describeBroken(rows)).toHaveLength(0);
    });
  }

  it("sessionEndLine holds on legal and near-legal inputs", () => {
    for (const mode of LEGAL_MODES) {
      const rows = runSessionEndCampaign(mode, ITER, BASE_SEED);
      sessionEnd.push(...rows);
      const broken = rows.filter((r) => r.violations.some((v) => v.strength === "hard"));
      expect(broken.map((r) => `${mode} seed=${r.seed} ${JSON.stringify(r.violations)}`)).toEqual(
        [],
      );
    }
  });

  it("sessionEndLine never throws and stays deterministic on hostile inputs", () => {
    const rows = runSessionEndCampaign("hostile", ITER, BASE_SEED);
    sessionEnd.push(...rows);
    const broken = rows.filter((r) => r.violations.some((v) => ROBUSTNESS.has(v.invariant)));
    expect(broken.map((r) => `hostile seed=${r.seed} ${JSON.stringify(r.violations)}`)).toEqual([]);
  });

  it("same seed twice yields an identical result row", () => {
    for (const engine of ENGINES) {
      const a = runSequence(engine, "legal", BASE_SEED);
      const b = runSequence(engine, "legal", BASE_SEED);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
