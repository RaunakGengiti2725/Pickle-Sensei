import { describe, expect, it } from "vitest";
import { generateAdversarialContactFixtures } from "@pickle/evaluation";
import { estimateContact, paddleOwnershipFromHandAffinity } from "../src/index.js";
import { foreignPaddleScene, genuinePaddleScene } from "./ownershipScenes.js";

/**
 * ownership-posterior-v1 (wave-g g05): flag-gated conditioning of the contact
 * posterior on a general paddle-ownership confidence. The flag is OFF by
 * default; these tests pin (1) default-path byte-equivalence, (2) degradation
 * of paddle-derived confirmation under weak ownership, (3) full-trust
 * behavior under decisive ownership, and (4) monotonicity: ownership doubt
 * never raises confidence.
 */
describe("ownership posterior: default OFF is byte-identical", () => {
  it("flag omitted, flag false, and flag ON with unmeasured confidence all match on every adversarial fixture", () => {
    for (const fixture of generateAdversarialContactFixtures()) {
      const base = {
        sequence: fixture.sequence,
        window: fixture.window,
        ballObservations: fixture.ballObservations,
        paddleSpeeds: fixture.paddleSpeeds,
        paddleCenters: fixture.paddleCenters,
        targetWrists: fixture.targetWrists,
        strokeFamily: fixture.strokeFamily,
      };
      const omitted = estimateContact(base);
      const off = estimateContact({ ...base, ownershipConditionedPosterior: false });
      const onUnmeasured = estimateContact({
        ...base,
        ownershipConditionedPosterior: true,
        paddleOwnershipConfidence: null,
      });
      expect(off, fixture.id).toEqual(omitted);
      expect(onUnmeasured, fixture.id).toEqual(omitted);
    }
  });

  it("confidence input is ignored while the flag is OFF", () => {
    const scene = foreignPaddleScene();
    const base = {
      sequence: scene.sequence,
      window: scene.window,
      ballObservations: scene.ball,
      paddleSpeeds: scene.paddleSpeeds,
      paddleCenters: scene.paddleCenters,
    };
    expect(estimateContact({ ...base, paddleOwnershipConfidence: 0 })).toEqual(
      estimateContact(base),
    );
  });
});

describe("ownership posterior: weak ownership degrades paddle-derived confirmation", () => {
  it("hand-affinity confidence separates the foreign paddle from the genuine one", () => {
    const foreign = foreignPaddleScene();
    const genuine = genuinePaddleScene();
    const foreignOwnership = paddleOwnershipFromHandAffinity({
      sequence: foreign.sequence,
      paddleCenters: foreign.paddleCenters,
    })!;
    const genuineOwnership = paddleOwnershipFromHandAffinity({
      sequence: genuine.sequence,
      paddleCenters: genuine.paddleCenters,
    })!;
    expect(genuineOwnership.confidence).toBeGreaterThan(foreignOwnership.confidence);
    expect(genuineOwnership.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("the F3 foreign-paddle scene stops being a confident, modality-confirmed wrong contact", () => {
    const scene = foreignPaddleScene();
    const ownership = paddleOwnershipFromHandAffinity({
      sequence: scene.sequence,
      paddleCenters: scene.paddleCenters,
    })!;
    const estimate = estimateContact({
      sequence: scene.sequence,
      window: scene.window,
      ballObservations: scene.ball,
      paddleSpeeds: scene.paddleSpeeds,
      paddleCenters: scene.paddleCenters,
      ownershipConditionedPosterior: true,
      paddleOwnershipConfidence: ownership.confidence,
    });
    if (estimate.status === "abstained") return; // honest outcome
    const errorMs = Math.abs(estimate.estimatedContactMs - scene.trueContactMs);
    // No confident-but-wrong under conditioning: either near truth, or the
    // wrong moment is neither confirmed nor confident.
    if (errorMs > 150) {
      expect(estimate.paddleConfirmed).toBe(false);
      expect(estimate.confidence).toBeLessThan(0.6);
    }
  });

  it("decisive ownership keeps the genuine paddle fully trusted", () => {
    const scene = genuinePaddleScene();
    const ownership = paddleOwnershipFromHandAffinity({
      sequence: scene.sequence,
      paddleCenters: scene.paddleCenters,
    })!;
    const estimate = estimateContact({
      sequence: scene.sequence,
      window: scene.window,
      ballObservations: null,
      paddleSpeeds: scene.paddleSpeeds,
      paddleCenters: scene.paddleCenters,
      ownershipConditionedPosterior: true,
      paddleOwnershipConfidence: ownership.confidence,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(Math.abs(estimate.estimatedContactMs - scene.trueContactMs)).toBeLessThanOrEqual(60);
    expect(estimate.paddleConfirmed).toBe(true);
    expect(estimate.limitingFactors).not.toContain("paddle_ownership_uncertain");
  });

  it("ownership doubt never raises confidence (monotone in the confidence input)", () => {
    const scene = genuinePaddleScene();
    const confidences = [1, 0.7, 0.5, 0.3, 0.15, 0];
    let previous: number | null = null;
    for (const ownershipConfidence of confidences) {
      const estimate = estimateContact({
        sequence: scene.sequence,
        window: scene.window,
        ballObservations: null,
        paddleSpeeds: scene.paddleSpeeds,
        paddleCenters: scene.paddleCenters,
        ownershipConditionedPosterior: true,
        paddleOwnershipConfidence: ownershipConfidence,
      });
      if (estimate.status !== "estimated") continue;
      if (previous !== null) {
        expect(estimate.confidence, `ownership ${ownershipConfidence}`).toBeLessThanOrEqual(
          previous + 1e-9,
        );
      }
      previous = estimate.confidence;
    }
  });

  it("a contradicted paddle cannot CONFIRM even when present at the estimate", () => {
    const scene = genuinePaddleScene();
    const estimate = estimateContact({
      sequence: scene.sequence,
      window: scene.window,
      ballObservations: null,
      paddleSpeeds: scene.paddleSpeeds,
      paddleCenters: scene.paddleCenters,
      ownershipConditionedPosterior: true,
      paddleOwnershipConfidence: 0.2,
    });
    if (estimate.status !== "estimated") return;
    expect(estimate.paddleConfirmed).toBe(false);
    expect(estimate.limitingFactors).toContain("paddle_ownership_unconfirmed");
  });
});
