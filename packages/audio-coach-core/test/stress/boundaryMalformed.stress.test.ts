import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCampaign, runScenario, TARGETS, type Violation } from "./boundaryCampaign.js";

/**
 * Boundary / malformed-input stress campaign (lens: boundary-malformed).
 *
 * Default run is small so it lives in the suite; set STRESS_ITER for the full
 * campaign (iterations PER TARGET — 7 targets), STRESS_SEED to change the
 * campaign seed, STRESS_OUT to write the seed → outcome table as JSON.
 *
 *   STRESS_ITER=450 STRESS_OUT=/tmp/boundary.json pnpm --filter @pickle/audio-coach-core test -- stress
 *
 * Replay one row: `runScenario(target, seed)` from ./boundaryCampaign.ts.
 */

const ITER = Number.parseInt(process.env.STRESS_ITER ?? "20", 10);
const SEED = Number.parseInt(process.env.STRESS_SEED ?? "20260904", 10);
const OUT = process.env.STRESS_OUT;

/**
 * Violation classes the campaign is allowed to observe. Every class here is
 * either the graceful outcome for a contract violation (TypeError on a
 * wrong-typed input to a typed pure function) or a KNOWN finding pinned by a
 * minimized repro in ./boundaryFindings.test.ts. Anything else fails.
 */
const TOLERATED: ReadonlySet<Violation> = new Set<Violation>([
  "threw-on-wrong-type",
  // Known findings (see boundaryFindings.test.ts):
  "non-finite-in-text",
  "non-finite-announced-score",
  "non-finite-in-state",
  "text-too-long",
  "garbage-in-text",
  "non-string-phrase",
  "negative-zero-in-text",
  "state-not-json-stable",
]);

describe("boundary-malformed stress campaign", () => {
  const result = runCampaign({ campaignSeed: SEED, iterationsPerTarget: ITER });

  it(`executes ${TARGETS.length} × ${ITER} seeded scenarios and writes the seed table`, () => {
    expect(result.summary.executed).toBe(TARGETS.length * ITER);
    if (OUT) {
      const path = resolve(OUT);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(result, null, 1));
    }
  });

  it("every scenario is replayable from its seed", () => {
    // Replay a deterministic sample (every 37th row) and compare full records.
    for (let i = 0; i < result.records.length; i += 37) {
      const row = result.records[i];
      if (!row) continue;
      const replay = runScenario(row.target, row.seed, row.index);
      expect(replay).toEqual(row);
    }
  });

  it("no scenario mutates its input, pollutes Object.prototype, or is non-deterministic", () => {
    const hard = result.records.filter((r) =>
      r.violations.some(
        (v) => v === "input-mutated" || v === "proto-polluted" || v === "non-deterministic",
      ),
    );
    expect(hard.map((r) => `${r.id} ${r.violations.join(",")} ${r.notes.join(";")}`)).toEqual([]);
  });

  it("live coach always speaks; sparse coach SILENCE ⇔ text === null", () => {
    const contract = result.records.filter((r) =>
      r.violations.some((v) => v === "empty-live-text" || v === "silence-text-mismatch"),
    );
    expect(contract.map((r) => `${r.id} ${r.violations.join(",")} ${r.notes.join(";")}`)).toEqual(
      [],
    );
  });

  it("observes no violation class outside the tolerated/known set", () => {
    const novel = result.records.filter((r) => r.violations.some((v) => !TOLERATED.has(v)));
    expect(novel.map((r) => `${r.id} ${r.violations.join(",")} ${r.notes.join(";")}`)).toEqual([]);
  });
});
