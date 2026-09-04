import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runMatrix, type MatrixReport, type ScenarioSummary } from "./visibilityMatrix/matrix.js";
import { runCase } from "./visibilityMatrix/runner.js";
import { SCENARIOS, buildCase } from "./visibilityMatrix/scenarios.js";

/**
 * Player-visibility matrix (Linux replay proxy — see plane in the report).
 *
 * Seeded keypoint streams derived from the committed synthetic swing fixture
 * are pushed through the shipping composition (capture quality → pre-analysis
 * gate → analyzeCapture, the scorer only when the gate passes). This file
 * pins the abstention / uncertainty paths that DO fire today. Reproduced gaps
 * live in visibilityMatrix.knownGaps.test.ts.
 *
 *   VISIBILITY_MATRIX_SEEDS=200 VISIBILITY_MATRIX_OUT=/tmp/vis npx vitest run test/visibilityMatrix.test.ts
 */
const SEEDS = Number(process.env.VISIBILITY_MATRIX_SEEDS ?? "40");
const OUT_DIR = resolve(
  process.env.VISIBILITY_MATRIX_OUT ?? resolve(__dirname, "../../../artifacts/visibility-matrix"),
);

let reportPromise: Promise<MatrixReport> | null = null;
const report = (): Promise<MatrixReport> => {
  reportPromise ??= runMatrix(SEEDS).then((value) => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(value, null, 2));
    writeFileSync(
      resolve(OUT_DIR, "summary.json"),
      JSON.stringify({ ...value, cases: undefined }, null, 2),
    );
    return value;
  });
  return reportPromise;
};

const scenario = (value: MatrixReport, id: string): ScenarioSummary => {
  const found = value.scenarios.find((entry) => entry.scenarioId === id);
  if (!found) throw new Error(`scenario ${id} missing from report`);
  return found;
};

describe("player visibility matrix", () => {
  it("runs every scenario for every seed and writes the replayable report", async () => {
    const value = await report();
    expect(value.plane).toBe("linux_replay_proxy");
    expect(value.totalCases).toBe(SEEDS * SCENARIOS.length);
    for (const entry of value.cases) {
      expect(entry.seed).toBeGreaterThanOrEqual(1);
      expect(entry.params).toBeDefined();
    }
  }, 600_000);

  it("is deterministic: the same scenario id + seed replays to the same outcome", async () => {
    const definition = SCENARIOS.find((entry) => entry.id === "exit_reenter_through_contact");
    if (!definition) throw new Error("scenario missing");
    const first = buildCase(definition, 7);
    const second = buildCase(definition, 7);
    expect(JSON.stringify(second.sequence)).toBe(JSON.stringify(first.sequence));
    expect(second.params).toEqual(first.params);
    const [a, b] = await Promise.all([runCase(first), runCase(second)]);
    expect(b.fusion).toEqual(a.fusion);
    expect(b.quality).toEqual(a.quality);
  });

  it("clean control: every seed scores", async () => {
    const control = scenario(await report(), "full_body_clean");
    expect(control.outcomes.scored).toBe(SEEDS);
    expect(control.violations).toEqual({});
  });

  it("no player / no tracked wrist: the pre-analysis gate abstains on every seed before the scorer runs", async () => {
    const value = await report();
    for (const id of [
      "no_player_no_frames",
      "no_player_empty_frames",
      "no_player_subthreshold_visibility",
      "arms_missing_both",
    ]) {
      const summary = scenario(value, id);
      expect(summary.outcomes.scored ?? 0, id).toBe(0);
      expect(summary.outcomes.gated, id).toBe(SEEDS);
      expect(summary.preGateRejects, id).toBe(SEEDS);
      expect(summary.failureCodes, id).toEqual({});
    }
    expect(scenario(value, "no_player_no_frames").preGateReasons).toEqual({
      no_person_found: SEEDS,
    });
    for (const id of ["no_player_empty_frames", "no_player_subthreshold_visibility"]) {
      expect(scenario(value, id).preGateReasons.low_pose_confidence, id).toBe(SEEDS);
    }
    expect(scenario(value, "arms_missing_both").preGateReasons.body_not_fully_visible).toBe(SEEDS);
  });

  it("spectator gesture: a body that never swings passes the gate and fusion abstains on every seed", async () => {
    const summary = scenario(await report(), "spectator_gesture");
    expect(summary.outcomes.scored ?? 0).toBe(0);
    expect(summary.outcomes.failed).toBe(SEEDS);
    expect(summary.failureCodes).toEqual({ "phase.no_distinct_stroke": SEEDS });
  });

  it("dominant arm missing / upper body only: never produces a score", async () => {
    const value = await report();
    for (const id of ["arms_missing_dominant", "partial_body_upper_only"]) {
      expect(scenario(value, id).outcomes.scored ?? 0, id).toBe(0);
      expect(scenario(value, id).poseQualityRejects, id).toBe(SEEDS);
      expect(scenario(value, id).outcomes.gated, id).toBe(SEEDS);
      expect(scenario(value, id).preGateReasons.body_not_fully_visible, id).toBe(SEEDS);
    }
  });

  it("legs missing, legs cropped, too close: the pose-quality gate rejects and no seed presents as normal", async () => {
    const value = await report();
    for (const id of ["legs_missing", "legs_cropped_by_frame", "close_camera"]) {
      const summary = scenario(value, id);
      expect(summary.poseQualityRejects, id).toBe(SEEDS);
      expect(summary.presentations.normal ?? 0, id).toBe(0);
      expect(summary.violations, id).toEqual({});
    }
    expect(scenario(value, "legs_missing").poseQualityReasons.body_not_fully_visible).toBe(SEEDS);
  });

  it("far camera: the committed pose-quality gate and pre-analysis gate reject every seed, and none is scored", async () => {
    const value = await report();
    for (const id of ["far_camera", "far_camera_noiseless"]) {
      const summary = scenario(value, id);
      expect(summary.poseQualityReasons.player_too_small_in_frame, id).toBe(SEEDS);
      expect(summary.preGateReasons.person_implausible_scale, id).toBe(SEEDS);
      expect(summary.outcomes.gated, id).toBe(SEEDS);
      expect(summary.violations, id).toEqual({});
    }
  });

  it("exit/re-enter through contact: the pose-quality gate flags the dropout gap whenever it exceeds 700 ms and the stream is never scored", async () => {
    const value = await report();
    const gapCases = value.cases.filter(
      (entry) =>
        entry.scenarioId === "exit_reenter_through_contact" && entry.quality.largestGapMs > 700,
    );
    expect(gapCases.length).toBeGreaterThan(0);
    for (const entry of gapCases) {
      expect(entry.quality.reasons, `seed ${entry.seed}`).toContain("tracking_dropout_gap");
      expect(entry.preGate.reasons, `seed ${entry.seed}`).toContain("tracking_dropout_gap");
      expect(entry.fusion.kind, `seed ${entry.seed}`).toBe("gated");
    }
    const summary = scenario(value, "exit_reenter_through_contact");
    expect(summary.outcomes.scored ?? 0).toBe(0);
    expect(summary.violations).toEqual({});
  });

  it("occlusion through contact: torso + swinging arm hidden across contact is a torso tracking gap on every seed", async () => {
    const summary = scenario(await report(), "occlusion_through_contact");
    expect(summary.preGateReasons.torso_tracking_gap).toBe(SEEDS);
    expect(summary.outcomes.gated).toBe(SEEDS);
    expect(summary.presentations.normal ?? 0).toBe(0);
    expect(summary.violations).toEqual({});
  });

  it("every gated case carries the reasons the gate decided on (never an empty abstention)", async () => {
    const value = await report();
    const gated = value.cases.filter((entry) => entry.fusion.kind === "gated");
    expect(gated.length).toBeGreaterThan(0);
    for (const entry of gated) {
      expect(entry.preGate.analyzable, `${entry.scenarioId}#${entry.seed}`).toBe(false);
      if (entry.fusion.kind === "gated") {
        expect(entry.fusion.reasons, `${entry.scenarioId}#${entry.seed}`).toEqual(
          entry.preGate.reasons,
        );
      }
    }
  });

  it("no score ever carries confidence at/above the normal-presentation threshold while below the scoring floor", async () => {
    const value = await report();
    for (const entry of value.cases) {
      if (entry.fusion.kind === "scored") {
        expect(
          entry.fusion.analysisConfidence,
          `${entry.scenarioId}#${entry.seed}`,
        ).toBeGreaterThanOrEqual(0.65);
        if (entry.fusion.presentation === "normal") {
          expect(
            entry.fusion.analysisConfidence,
            `${entry.scenarioId}#${entry.seed}`,
          ).toBeGreaterThanOrEqual(0.8);
        }
      }
      if (entry.fusion.kind === "low_confidence") {
        expect(entry.fusion.analysisConfidence, `${entry.scenarioId}#${entry.seed}`).toBeLessThan(
          0.65,
        );
      }
    }
  });
});
