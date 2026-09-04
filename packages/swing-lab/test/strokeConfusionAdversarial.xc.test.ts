import { describe, expect, it } from "vitest";
import {
  buildSweepRows,
  buildVariants,
  classifyTransition,
  hashSeed,
  makeRng,
  perturbChiralitySwap,
  perturbDropout,
  perturbFramerate,
  perturbNoise,
  perturbReflect,
  replayEvaluation,
  runSweep,
  seedFor,
} from "../src/strokeConfusionAdversarial.js";
import type { StrokePrediction } from "../src/strokeHeuristic.js";

/**
 * xc-cv-classification-confusion — pins for the adversarial sweep.
 *
 * Invariants that MUST hold (the classifier is unchanged by this branch, so
 * these document the shipped decision surface):
 *  - the sweep is byte-deterministic and every evaluation is replayable
 *    from (rowId, variantId) alone;
 *  - mirror reflection (x→1−x, joint names swapped, handedness flipped)
 *    never changes a label — stroke identity is mirror-invariant;
 *  - Lab and Lite classifiers agree on every perturbed input (parity);
 *  - unperturbed rows reproduce the contract (exactly one confidently-wrong
 *    baseline row: wavea-wgm-wheelchair@182400/target).
 *
 * Recorded transitions are asserted by REPLAY EQUALITY, not by hard-coding
 * the perturbed label, so the pins keep passing if a future classifier
 * version closes a knife-edge — the harness's job is to measure, not to
 * freeze a weakness in place.
 */

function prediction(partial: Partial<StrokePrediction>): StrokePrediction {
  return {
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "test",
    label: "UNKNOWN",
    leaf: "UNKNOWN",
    taxonomyDepth: 1,
    confidence: 0.2,
    evidence: [],
    limitingFactors: [],
    ...partial,
  };
}

describe("deterministic RNG and perturbations", () => {
  it("hashSeed/makeRng are pure and seedFor is a function of (rowId, variantId) only", () => {
    expect(hashSeed("a|b")).toBe(hashSeed("a|b"));
    expect(hashSeed("a|b")).not.toBe(hashSeed("a|c"));
    const first = makeRng(42);
    const second = makeRng(42);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    expect(seedFor("row", "variant")).toBe(hashSeed("row|variant"));
  });

  const sequence = {
    frames: [
      {
        timestampMs: 0,
        landmarks: [
          { name: "left_wrist", x: 0.2, y: 0.5, visibility: 0.9 },
          { name: "right_wrist", x: 0.7, y: 0.5, visibility: 0.9 },
          { name: "nose", x: 0.5, y: 0.2, visibility: 0.9 },
        ],
      },
      { timestampMs: 33, landmarks: [{ name: "nose", x: 0.5, y: 0.2, visibility: 0.9 }] },
      { timestampMs: 66, landmarks: [{ name: "nose", x: 0.5, y: 0.2, visibility: 0.9 }] },
    ],
  } as unknown as Parameters<typeof perturbNoise>[0];

  it("noise with the same seed is identical, and a different seed differs", () => {
    const a = perturbNoise(sequence, 0.01, 7);
    const b = perturbNoise(sequence, 0.01, 7);
    const c = perturbNoise(sequence, 0.01, 8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.frames[0]!.landmarks[0]!.x).not.toBe(0.2);
  });

  it("chirality swap renames without moving; reflect renames and mirrors x", () => {
    const swapped = perturbChiralitySwap(sequence).frames[0]!.landmarks;
    expect(swapped.map((mark) => [mark.name, mark.x])).toEqual([
      ["right_wrist", 0.2],
      ["left_wrist", 0.7],
      ["nose", 0.5],
    ]);
    const reflected = perturbReflect(sequence).frames[0]!.landmarks;
    expect(reflected.map((mark) => [mark.name, Number(mark.x.toFixed(3))])).toEqual([
      ["right_wrist", 0.8],
      ["left_wrist", 0.3],
      ["nose", 0.5],
    ]);
  });

  it("framerate decimation keeps one of `step` frames from `phase`; dropout is seeded", () => {
    expect(perturbFramerate(sequence, 2, 0).frames.map((frame) => frame.timestampMs)).toEqual([
      0, 66,
    ]);
    expect(perturbFramerate(sequence, 2, 1).frames.map((frame) => frame.timestampMs)).toEqual([33]);
    expect(
      perturbDropout(sequence, 1, 1).frames.every((frame) => frame.landmarks.length === 0),
    ).toBe(true);
    expect(perturbDropout(sequence, 0, 1)).toEqual(sequence);
  });
});

describe("transition taxonomy", () => {
  const abstainA = prediction({ limitingFactors: ["no_swing_energy_in_window"] });
  const abstainB = prediction({ limitingFactors: ["no_contact_point_measurable"] });
  const forehand = prediction({ label: "FOREHAND", leaf: null, taxonomyDepth: 2, confidence: 0.8 });
  const backhand = prediction({ label: "BACKHAND", leaf: null, taxonomyDepth: 2, confidence: 0.6 });

  it("distinguishes stable/changed abstention, direction of commit changes, and flips", () => {
    expect(classifyTransition(abstainA, abstainA)).toBe("stable_abstain");
    expect(classifyTransition(abstainA, abstainB)).toBe("abstain_reason_changed");
    expect(classifyTransition(abstainA, forehand)).toBe("abstain_to_label");
    expect(classifyTransition(forehand, abstainA)).toBe("label_to_abstain");
    expect(classifyTransition(forehand, forehand)).toBe("stable_label");
    expect(classifyTransition(forehand, backhand)).toBe("confident_label_flip");
  });
});

describe("sweep over the committed gold substrate (linux_replay_proxy)", () => {
  const report = runSweep();

  it("covers 18 rows × 80 variants with only the structurally inapplicable pairs skipped", () => {
    expect(report.rowCount).toBe(18);
    expect(report.variantCount).toBe(80);
    expect(buildVariants().map((variant) => variant.variantId)).toHaveLength(
      new Set(buildVariants().map((v) => v.variantId)).size,
    );
    expect(report.totalEvaluations + report.skippedNotApplicable).toBe(
      report.rowCount * report.variantCount,
    );
    expect(report.overall.n).toBe(report.totalEvaluations);
    expect(report.evaluations).toHaveLength(report.totalEvaluations);
  });

  it("unperturbed rows reproduce the contract: one confidently-wrong baseline row, Lab↔Lite parity", () => {
    expect(report.baselineParityViolations).toEqual([]);
    expect(report.baselines.filter((row) => row.confidentlyWrong).map((row) => row.rowId)).toEqual([
      "wavea-wgm-wheelchair@182400/target",
    ]);
    expect(report.baselines.filter((row) => row.label !== "UNKNOWN")).toHaveLength(3);
  });

  it("mirror reflection never changes a label (stroke identity is mirror-invariant)", () => {
    const reflect = report.byFamily.reflect!;
    expect(reflect.n).toBe(18);
    expect(reflect.confident_label_flip).toBe(0);
    expect(reflect.label_to_abstain).toBe(0);
    expect(reflect.abstain_to_label).toBe(0);
    expect(reflect.abstain_reason_changed).toBe(0);
    expect(reflect.expectation_violations).toBe(0);
  });

  it("Lab and Lite agree on every perturbed input", () => {
    expect(report.parityViolations).toEqual([]);
    expect(report.overall.parity_violations).toBe(0);
  });

  it("every recorded dangerous transition replays identically from (rowId, variantId)", () => {
    const context = { rows: buildSweepRows(), variants: buildVariants() };
    const dangerous = [
      ...report.confidentLabelFlips,
      ...report.newlyConfidentlyWrong,
      ...report.abstainToLabel,
      ...report.expectationViolations,
    ];
    expect(dangerous.length).toBeGreaterThan(0);
    for (const recorded of dangerous) {
      const replayed = replayEvaluation(recorded.rowId, recorded.variantId, undefined, context);
      expect(replayed).not.toBeNull();
      expect(replayed!.seed).toBe(recorded.seed);
      expect(replayed!.perturbedLabel).toBe(recorded.perturbedLabel);
      expect(replayed!.perturbedConfidence).toBe(recorded.perturbedConfidence);
      expect(replayed!.perturbedReason).toBe(recorded.perturbedReason);
      expect(replayed!.transition).toBe(recorded.transition);
    }
  });

  it("classifies newly-confidently-wrong strictly: committed, wrong vs gold, baseline not wrong", () => {
    for (const evaluation of report.newlyConfidentlyWrong) {
      expect(evaluation.perturbedLabel).not.toBe("UNKNOWN");
      expect(evaluation.baselineConfidentlyWrong).toBe(false);
      expect(evaluation.perturbedL1 === "wrong" || evaluation.perturbedL2 === "wrong").toBe(true);
    }
    const wheelchair = report.byRow["wavea-wgm-wheelchair@182400/target"]!;
    expect(wheelchair.newly_confidently_wrong).toBe(0);
    expect(wheelchair.perturbed_confidently_wrong).toBe(wheelchair.stable_label);
  });

  it("gold-unknown rows are never counted wrong under any perturbation", () => {
    for (const evaluation of report.evaluations) {
      const baseline = report.baselines.find((row) => row.rowId === evaluation.rowId)!;
      if (baseline.goldL1 === "unknown") expect(evaluation.perturbedL1).toBe("gold_unknown");
      if (baseline.goldL2 === "unknown") expect(evaluation.perturbedL2).toBe("gold_unknown");
    }
  });

  it("is deterministic across two independent runs", () => {
    const again = runSweep();
    expect(again.evaluations).toEqual(report.evaluations);
    expect(again.overall).toEqual(report.overall);
  });

  it("row substrate matches the bench's evaluable set", () => {
    const rows = buildSweepRows();
    expect(rows.map((row) => row.rowId)).toEqual(report.baselines.map((row) => row.rowId));
    for (const row of rows) {
      expect(row.caseId).not.toBe("wm-dink-01");
      expect(row.caseId).not.toBe("afn-vic-rally1");
    }
  });
});
