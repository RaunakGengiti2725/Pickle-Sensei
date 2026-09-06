import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_MANIFEST, ModelRegistry } from "../src/index.js";

describe("real 3D reconstruction release boundary", () => {
  const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);

  it("registers the native implementation without claiming production validation", () => {
    const entry = registry.resolve({
      task: "pose_reconstruction_3d",
      platform: "ios",
      status: "experimental",
    });
    expect(entry).toMatchObject({
      id: "pose.apple-vision-3d",
      version: "apple-vision-3d-raw-1",
      runtime: "vision_framework",
      executionTarget: "on_device",
      deploymentStatus: "experimental",
      calibrationVersion: null,
      metrics: null,
      trainingDatasetVersion: null,
      evaluationDatasetVersion: null,
    });
  });

  it("does not resolve an experimental native estimator as a production or Android release", () => {
    expect(registry.resolve({ task: "pose_reconstruction_3d", platform: "ios" })).toBeNull();
    expect(
      registry.resolve({
        task: "pose_reconstruction_3d",
        platform: "android",
        status: "experimental",
      }),
    ).toBeNull();
  });
});
