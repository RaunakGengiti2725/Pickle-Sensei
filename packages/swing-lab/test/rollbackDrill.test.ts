import { describe, expect, it } from "vitest";
import {
  runRollbackDrill,
  SubsystemReleaseState,
  type RollbackDrillResult,
} from "@pickle/model-registry";
import {
  DEPENDENCIES_V1,
  getShotScoringConfig,
  SCORING_MODEL_VERSION,
  type CheckpointDependency,
  type ShotScoringConfig,
} from "@pickle/scoring";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  classifyDimension,
  type DimensionThreshold,
} from "@pickle/capture-envelope";
import {
  AUTO_RESOLUTION_MIN_CONFIDENCE,
  resolvePredictedProfile,
  type HierarchicalStrokePrediction,
  type PredictedProfileResolution,
} from "@pickle/analysis-pipeline";
import {
  FAULT_DRILL_MAPPING_V1_VERSION,
  FAULT_DRILL_MAPPINGS_V1,
  type FaultDrillMappingV1,
} from "../src/drillLibrary.js";

/**
 * i06-rollback-drill: cross-subsystem rollback drill against the REAL shipped
 * artifacts — scoring model config (sm-v1), fault model (checkpoint
 * dependency graph), fault→drill mappings (fault-drill-mapping-v1), capture
 * envelope thresholds (v0.4), and auto-detect resolution policy. Each drill
 * records the known-good version, puts a deliberately bad candidate live,
 * exercises the kill switch, rolls back, and verifies through behavior that
 * the known-good artifact is back in service.
 *
 * HONESTY: time-to-disable / time-to-rollback below are in-process Linux
 * test-environment measurements. They are NOT production rollback times (no
 * fleet propagation, no client refresh, no cache invalidation).
 */

function expectDrillRecovered(result: RollbackDrillResult): void {
  expect(result.badWasLive).toBe(true);
  expect(result.recovered).toBe(true);
  expect(result.environment).toBe("linux-test");
  expect(result.timeToDisableMs).toBeGreaterThanOrEqual(0);
  expect(result.timeToRollbackMs).toBeGreaterThanOrEqual(0);
}

describe("cross-subsystem rollback drills (linux-test measurements)", () => {
  it("scoring model: rollback restores sm-v1 config after a bad candidate", () => {
    const knownGoodConfig = getShotScoringConfig("forehand_drive");
    expect(knownGoodConfig.scoringModelVersion).toBe(SCORING_MODEL_VERSION);
    const badConfig: ShotScoringConfig = {
      ...knownGoodConfig,
      scoringModelVersion: "sm-v99-bad-candidate",
      // A scorer that never abstains is exactly the failure rollback exists for.
      minAnalysisConfidence: 0,
    };

    let live: ShotScoringConfig | null = null;
    const state = new SubsystemReleaseState<ShotScoringConfig>({
      subsystem: "scoring-model",
      initial: { version: SCORING_MODEL_VERSION, artifact: knownGoodConfig },
      apply: (artifact) => {
        live = artifact;
      },
    });

    const result = runRollbackDrill(
      state,
      { version: "sm-v99-bad-candidate", artifact: badConfig },
      {
        knownGoodLive: () =>
          live !== null &&
          live.scoringModelVersion === SCORING_MODEL_VERSION &&
          live.minAnalysisConfidence > 0,
        badLive: () => live !== null && live.minAnalysisConfidence === 0,
      },
    );
    expectDrillRecovered(result);
    expect(result.knownGoodVersion).toBe("sm-v1");
  });

  it("fault model: rollback restores the checkpoint dependency graph", () => {
    let live: readonly CheckpointDependency[] | null = null;
    const state = new SubsystemReleaseState<readonly CheckpointDependency[]>({
      subsystem: "fault-model",
      initial: { version: `${SCORING_MODEL_VERSION}-dependencies`, artifact: DEPENDENCIES_V1 },
      apply: (artifact) => {
        live = artifact;
      },
    });

    const result = runRollbackDrill(
      state,
      // A fault model with no cause→effect edges silently drops propagation.
      { version: "fm-v99-bad-candidate", artifact: [] },
      {
        knownGoodLive: () => live !== null && live.length === DEPENDENCIES_V1.length,
        badLive: () => live !== null && live.length === 0,
      },
    );
    expectDrillRecovered(result);
  });

  it("drill mappings: rollback restores fault-drill-mapping-v1", () => {
    expect(FAULT_DRILL_MAPPINGS_V1.length).toBeGreaterThan(0);
    let live: readonly FaultDrillMappingV1[] | null = null;
    const state = new SubsystemReleaseState<readonly FaultDrillMappingV1[]>({
      subsystem: "drill-mapping",
      initial: { version: FAULT_DRILL_MAPPING_V1_VERSION, artifact: FAULT_DRILL_MAPPINGS_V1 },
      apply: (artifact) => {
        live = artifact;
      },
    });

    const result = runRollbackDrill(
      state,
      { version: "fault-drill-mapping-v99-bad", artifact: [] },
      {
        knownGoodLive: () =>
          live !== null &&
          live.length === FAULT_DRILL_MAPPINGS_V1.length &&
          live.every((mapping) => mapping.version === FAULT_DRILL_MAPPING_V1_VERSION),
        badLive: () => live !== null && live.length === 0,
      },
    );
    expectDrillRecovered(result);
    expect(result.knownGoodVersion).toBe("fault-drill-mapping-v1");
  });

  it("capture envelope: rollback restores v0.4 threshold behavior", () => {
    type Thresholds = {
      [K in keyof typeof CAPTURE_ENVELOPE_THRESHOLDS]: DimensionThreshold;
    };
    const badBrightness: DimensionThreshold = {
      id: "brightness-mean-luma-v99-bad",
      unit: "luma 0-255",
      // Accepts pitch-black footage as SUPPORTED — the regression to catch.
      supported: { min: 0, max: 255 },
      degraded: { min: 0, max: 255 },
    };
    const badThresholds: Thresholds = {
      ...CAPTURE_ENVELOPE_THRESHOLDS,
      brightness: badBrightness,
    };

    let live: Thresholds | null = null;
    const state = new SubsystemReleaseState<Thresholds>({
      subsystem: "capture-envelope",
      initial: {
        version: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
        artifact: CAPTURE_ENVELOPE_THRESHOLDS,
      },
      apply: (artifact) => {
        live = artifact;
      },
    });

    const pitchBlackLuma = 5;
    const result = runRollbackDrill(
      state,
      { version: "capture-envelope-thresholds-v99-bad", artifact: badThresholds },
      {
        knownGoodLive: () =>
          live !== null && classifyDimension(pitchBlackLuma, live.brightness) === "UNSUPPORTED",
        badLive: () =>
          live !== null && classifyDimension(pitchBlackLuma, live.brightness) === "SUPPORTED",
      },
    );
    expectDrillRecovered(result);
    expect(result.knownGoodVersion).toBe("capture-envelope-thresholds-v0.4-provisional");
  });

  it("auto-detect: rollback restores abstention-honoring resolution", () => {
    type AutoResolver = (prediction: HierarchicalStrokePrediction) => PredictedProfileResolution;

    const prediction = (
      overrides: Partial<HierarchicalStrokePrediction>,
    ): HierarchicalStrokePrediction => ({
      taxonomyVersion: "stroke-taxonomy-v1",
      classifierVersion: "stroke-heuristic-7",
      label: "FOREHAND_DRIVE",
      leaf: "FOREHAND_DRIVE",
      taxonomyDepth: 3,
      confidence: 0.9,
      evidence: [],
      limitingFactors: [],
      ...overrides,
    });
    const unknown = prediction({ label: "UNKNOWN", leaf: "UNKNOWN", confidence: 0.9 });
    const lowConfidence = prediction({ confidence: AUTO_RESOLUTION_MIN_CONFIDENCE - 0.01 });
    const confident = prediction({});

    // A resolver that routes UNKNOWN / low-confidence predictions anyway is
    // the dangerous candidate a kill switch and rollback must handle.
    const badResolver: AutoResolver = () => ({
      kind: "leaf",
      canonical: "FOREHAND_DRIVE",
      legacySlug: "forehand_drive",
      profileId: "FOREHAND_DRIVE",
      profileVersion: "bad-v99",
    });

    let live: AutoResolver | null = null;
    const state = new SubsystemReleaseState<AutoResolver>({
      subsystem: "auto-detect",
      initial: { version: "auto-resolution-v1", artifact: resolvePredictedProfile },
      apply: (artifact) => {
        live = artifact;
      },
    });

    const result = runRollbackDrill(
      state,
      { version: "auto-resolution-v99-bad", artifact: badResolver },
      {
        knownGoodLive: () =>
          live !== null &&
          live(unknown).kind === "abstain" &&
          live(lowConfidence).kind === "abstain" &&
          live(confident).kind === "leaf",
        badLive: () => live !== null && live(unknown).kind === "leaf",
      },
    );
    expectDrillRecovered(result);
    // While disabled (between kill switch and rollback) nothing may resolve;
    // the journal proves the disable actually happened before the rollback.
    const actions = state.journal().map((entry) => entry.action);
    expect(actions).toEqual(["record_known_good", "activate", "disable", "rollback"]);
  });
});

describe("rollback drill candidate validation against shipped artifacts (ADJ-05)", () => {
  function scoringState() {
    const knownGoodConfig = getShotScoringConfig("forehand_drive");
    let live: ShotScoringConfig | null = null;
    const state = new SubsystemReleaseState<ShotScoringConfig>({
      subsystem: "scoring-model",
      initial: { version: SCORING_MODEL_VERSION, artifact: knownGoodConfig },
      apply: (artifact) => {
        live = artifact;
      },
    });
    const verify = {
      knownGoodLive: () => live !== null && live.scoringModelVersion === SCORING_MODEL_VERSION,
      badLive: () => live !== null && live.scoringModelVersion !== SCORING_MODEL_VERSION,
    };
    return { state, verify, knownGoodConfig };
  }

  it("refuses a drill whose bad candidate is the active artifact itself", () => {
    const { state, verify } = scoringState();
    const active = state.active()!;
    expect(() => runRollbackDrill(state, active, verify)).toThrow(
      new RegExp(`bad candidate version "${SCORING_MODEL_VERSION}" is already the active version`),
    );
    // Nothing was recorded or transitioned: the drill aborted before touching state.
    expect(state.journal()).toHaveLength(0);
    expect(state.knownGood()).toBeNull();
    expect(state.active()?.version).toBe(SCORING_MODEL_VERSION);
  });

  it("refuses a bad candidate that reuses the active version string", () => {
    const { state, verify, knownGoodConfig } = scoringState();
    const disguised: ShotScoringConfig = { ...knownGoodConfig, minAnalysisConfidence: 0 };
    expect(() =>
      runRollbackDrill(state, { version: SCORING_MODEL_VERSION, artifact: disguised }, verify),
    ).toThrow(/already the active version/);
    expect(state.journal()).toHaveLength(0);
    expect(state.active()?.artifact).toBe(knownGoodConfig);
  });

  it("a bad candidate that fails to apply never displaces sm-v1 and the failure is journaled", () => {
    const knownGoodConfig = getShotScoringConfig("forehand_drive");
    let live: ShotScoringConfig | null = null;
    const state = new SubsystemReleaseState<ShotScoringConfig>({
      subsystem: "scoring-model",
      initial: { version: SCORING_MODEL_VERSION, artifact: knownGoodConfig },
      clock: () => 1_000,
      apply: (artifact) => {
        if (artifact !== null && artifact.minAnalysisConfidence <= 0) {
          throw new Error("scoring config rejected: minAnalysisConfidence must be positive");
        }
        live = artifact;
      },
    });
    const badConfig: ShotScoringConfig = {
      ...knownGoodConfig,
      scoringModelVersion: "sm-v99-bad-candidate",
      minAnalysisConfidence: 0,
    };
    expect(() =>
      runRollbackDrill(
        state,
        { version: "sm-v99-bad-candidate", artifact: badConfig },
        {
          knownGoodLive: () => live !== null && live.scoringModelVersion === SCORING_MODEL_VERSION,
          badLive: () => live !== null && live.minAnalysisConfidence === 0,
        },
      ),
    ).toThrow(/minAnalysisConfidence must be positive/);

    expect(live).toBe(knownGoodConfig);
    expect(state.active()?.version).toBe(SCORING_MODEL_VERSION);
    expect(state.knownGood()?.version).toBe(SCORING_MODEL_VERSION);
    expect(state.journal()).toEqual([
      expect.objectContaining({
        action: "record_known_good",
        outcome: "applied",
        atEpochMs: 1_000,
      }),
      expect.objectContaining({
        action: "activate",
        fromVersion: SCORING_MODEL_VERSION,
        toVersion: "sm-v99-bad-candidate",
        outcome: "failed",
        atEpochMs: 1_000,
      }),
    ]);
    // The kill switch and rollback still work after the failed activation.
    state.disable();
    expect(live).toBeNull();
    state.rollback();
    expect(live).toBe(knownGoodConfig);
  });
});
