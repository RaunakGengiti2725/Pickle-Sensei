import { describe, expect, it } from "vitest";
import {
  DrillCompletionCreateRequest,
  TrainingPlanCreateRequest,
  TrainingPlanReassessmentRequest,
} from "../src/schemas.js";

describe("training request contracts", () => {
  it("requires a real source-shot identity for deterministic plan generation", () => {
    expect(
      TrainingPlanCreateRequest.safeParse({ sourceShotId: "49f9b315-d670-4051-b4e3-5eed41798b52" })
        .success,
    ).toBe(true);
    expect(TrainingPlanCreateRequest.safeParse({ sourceShotId: "forehand-drive" }).success).toBe(
      false,
    );
  });

  it("requires actual completion evidence instead of a bare completed flag", () => {
    const base = {
      id: "3ad79898-09e5-4aaa-a759-8e4890d8af57",
      drillSlug: "contact-out-front",
      completedAt: "2026-08-27T17:30:00.000Z",
    };
    expect(DrillCompletionCreateRequest.safeParse(base).success).toBe(false);
    expect(DrillCompletionCreateRequest.safeParse({ ...base, actualRepetitions: 30 }).success).toBe(
      true,
    );
  });

  it("requires a real shot identity for reassessment", () => {
    expect(
      TrainingPlanReassessmentRequest.safeParse({
        shotId: "a834c6c0-a027-4518-8f75-239e069a92a8",
      }).success,
    ).toBe(true);
    expect(TrainingPlanReassessmentRequest.safeParse({ shotId: null }).success).toBe(false);
  });
});
