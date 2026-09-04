import { beforeAll, describe, expect, it } from "vitest";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import { createFixtureVisionProviderSet } from "../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip } from "../src/index.js";

/**
 * ADJ-AP-007 — analyzeClip() must hold a Result boundary around every provider
 * call. A provider that throws or rejects (a native bridge crash, a bug in an
 * adapter) is an analysis FAILURE, not an unhandled promise rejection that
 * escapes the pipeline and takes the caller down. analyzeCapture.run() already
 * does this; analyzeClip is held to the same contract.
 */

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

const options = {
  analysisId: "3b9f2b60-1111-4222-8333-444455556666",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: "fixture-1",
  capturedAtIso: "2026-08-26T18:00:00.000Z",
};

beforeAll(() => {
  process.env["PICKLE_ENV"] = "development";
});

function rejecting(message: string): () => Promise<never> {
  return async () => {
    throw new Error(message);
  };
}

function throwingSync(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

async function settle<T>(
  promise: Promise<T>,
): Promise<{ kind: "resolved"; value: T } | { kind: "rejected"; error: unknown }> {
  try {
    return { kind: "resolved", value: await promise };
  } catch (error) {
    return { kind: "rejected", error };
  }
}

type Stage = "stroke" | "pose" | "paddle" | "phase" | "features";
type StageMethod = {
  stroke: "detectStrokes";
  pose: "extractPose";
  paddle: "detectPaddle";
  phase: "segmentPhases";
  features: "extractMeasurements";
};

/** Fixture provider set with ONE stage's method replaced by `impl`. */
function withStage<S extends Stage>(
  stage: S,
  method: StageMethod[S],
  impl: () => unknown,
): VisionProviderSet {
  const providers = createFixtureVisionProviderSet("forehand_drive");
  const original = providers[stage];
  const patched = Object.create(Object.getPrototypeOf(original) as object) as VisionProviderSet[S];
  Object.assign(patched, original, { [method]: impl });
  return { ...providers, [stage]: patched };
}

describe("ADJ-AP-007: analyzeClip converts provider crashes into typed failures", () => {
  it("a rejecting stroke detector settles as result.ok === false (never a raw rejection)", async () => {
    const providers = withStage(
      "stroke",
      "detectStrokes",
      rejecting("native_stroke_detector_crashed"),
    );
    const settled = await settle(analyzeClip(providers, clip, options));
    expect(settled.kind).toBe("resolved");
    if (settled.kind !== "resolved") return;
    const result = settled.value;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("permanent");
    expect(result.failure.code).toBe("stroke.provider_crash");
    expect(result.failure.message).toBe("native_stroke_detector_crashed");
    expect(result.failure.retryable).toBe(false);
  });

  it.each([
    ["pose", "extractPose", "pose.provider_crash"],
    ["paddle", "detectPaddle", "paddle.provider_crash"],
    ["phase", "segmentPhases", "phase.provider_crash"],
    ["features", "extractMeasurements", "features.provider_crash"],
  ] as const)(
    "a rejecting %s provider surfaces as %s.provider_crash",
    async (stage, method, expectedCode) => {
      const providers = withStage(stage, method, rejecting(`${stage}_crashed`));
      const settled = await settle(analyzeClip(providers, clip, options));
      expect(settled.kind).toBe("resolved");
      if (settled.kind !== "resolved") return;
      const result = settled.value;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe("permanent");
      expect(result.failure.code).toBe(expectedCode);
      expect(result.failure.message).toBe(`${stage}_crashed`);
    },
  );

  it("a provider that throws synchronously (before returning a promise) is caught the same way", async () => {
    const providers = withStage("stroke", "detectStrokes", throwingSync("sync_throw"));
    const settled = await settle(analyzeClip(providers, clip, options));
    expect(settled.kind).toBe("resolved");
    if (settled.kind !== "resolved") return;
    const result = settled.value;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stroke.provider_crash");
    expect(result.failure.message).toBe("sync_throw");
  });

  it("a non-Error rejection reason is stringified into the failure message", async () => {
    const providers = withStage("pose", "extractPose", async () => {
      throw "pose bridge unavailable";
    });
    const settled = await settle(analyzeClip(providers, clip, options));
    expect(settled.kind).toBe("resolved");
    if (settled.kind !== "resolved") return;
    const result = settled.value;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("pose.provider_crash");
    expect(result.failure.message).toBe("pose bridge unavailable");
  });

  it("when pose and paddle run concurrently and one crashes, the crash wins over the sibling's success", async () => {
    const providers = withStage("paddle", "detectPaddle", rejecting("paddle_crashed"));
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("paddle.provider_crash");
  });

  it("typed provider failures are still propagated unchanged (no re-wrapping)", async () => {
    const providers = createFixtureVisionProviderSet("forehand_drive");
    const result = await analyzeClip(providers, { ...clip, durationMs: 200 }, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
    expect(result.failure.code).not.toContain("provider_crash");
  });

  it("the happy path is untouched by the boundary", async () => {
    const providers = createFixtureVisionProviderSet("forehand_drive");
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultKind).toBe("scored");
    expect(result.value.source).toBe("fixture");
  });
});
