import { describe, expect, it } from "vitest";
import { resolveAnalysisPlan, type AnalysisPlanContext } from "../src/analysisPlan.js";

const developmentIPhone: AnalysisPlanContext = {
  platform: "ios",
  osMajorVersion: 17,
  isDevelopmentBuild: true,
  nativeReconstructionAvailable: true,
};

describe("canonical analysis plan", () => {
  it("selects one real reconstruction path for a supported development iPhone", () => {
    expect(resolveAnalysisPlan(developmentIPhone)).toEqual({
      engine: "motion_3d",
      policyVersion: "analysis-plan-3d-validation-1",
      purpose: "development_validation",
      providerId: "pose.apple-vision-3d",
      permits: "none",
      scoring: "blocked",
      fallbackAfterFailure: false,
    });
  });

  it("does not require a pre-existing 3D artifact to select reconstruction", () => {
    expect(resolveAnalysisPlan(developmentIPhone).engine).toBe("motion_3d");
  });

  it.each([17, 18, 26])("keeps release builds on the current engine on iOS %i", (version) => {
    expect(
      resolveAnalysisPlan({
        ...developmentIPhone,
        osMajorVersion: version,
        isDevelopmentBuild: false,
      }),
    ).toMatchObject({ engine: "legacy_2d", reason: "3d_release_not_approved" });
  });

  it.each(["android", "web", "unknown"])("does not pretend %s has an iOS adapter", (platform) => {
    expect(resolveAnalysisPlan({ ...developmentIPhone, platform })).toMatchObject({
      engine: "legacy_2d",
      reason: "unsupported_platform",
    });
  });

  it.each([15, 16, 0, -1, NaN, Infinity, 17.5])(
    "does not raise the supported app floor or guess OS support from %s",
    (osMajorVersion) => {
      expect(resolveAnalysisPlan({ ...developmentIPhone, osMajorVersion })).toMatchObject({
        engine: "legacy_2d",
        reason: "unsupported_os",
      });
    },
  );

  it("does not select an absent native implementation", () => {
    expect(
      resolveAnalysisPlan({ ...developmentIPhone, nativeReconstructionAvailable: false }),
    ).toMatchObject({ engine: "legacy_2d", reason: "native_reconstruction_unavailable" });
  });

  it("freezes the policy for a run instead of following later context changes", () => {
    const context = { ...developmentIPhone };
    const plan = resolveAnalysisPlan(context);
    context.isDevelopmentBuild = false;
    expect(plan.engine).toBe("motion_3d");
    expect(Object.isFrozen(plan)).toBe(true);
  });
});
