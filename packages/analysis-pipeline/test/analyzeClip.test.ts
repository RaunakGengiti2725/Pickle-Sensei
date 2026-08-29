import { beforeAll, describe, expect, it } from "vitest";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { createFixtureVisionProviderSet } from "../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip } from "../src/index.js";

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

function options(shotType: "forehand_drive" | "dink") {
  return {
    analysisId: "3b9f2b60-1111-4222-8333-444455556666",
    sessionId: null,
    shotType,
    handedness: "right" as const,
    cameraView: "side" as const,
    appVersion: "0.1.0",
    modelBundleVersion: "fixture-1",
    capturedAtIso: "2026-08-26T18:00:00.000Z",
  };
}

beforeAll(() => {
  process.env["PICKLE_ENV"] = "development";
});

describe("analyzeClip end-to-end over the fixture provider", () => {
  it("produces a complete, versioned, fixture-tagged ShotAnalysis", async () => {
    const providers = createFixtureVisionProviderSet("forehand_drive");
    const result = await analyzeClip(providers, clip, options("forehand_drive"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const analysis = result.value;

    // Provenance is preserved — fixture data can never masquerade as real.
    expect(analysis.source).toBe("fixture");
    for (const m of analysis.measurements) expect(m.source).toBe("fixture");

    // Complete version vector (spec p. 22).
    expect(analysis.versionVector.scoringModelVersion).toBe("sm-v1");
    expect(analysis.versionVector.shotConfigVersion).toBe("forehand_drive@1");
    expect(analysis.versionVector.poseModelVersion).toBe("fixture-1");

    // Real scoring engine output — the fixture's late contact must surface.
    expect(analysis.resultKind).toBe("scored");
    expect(analysis.overallScore).not.toBeNull();
    expect(analysis.overallScore).toBeGreaterThan(0);
    expect(analysis.overallScore).toBeLessThan(10);
    const contact = analysis.checkpoints.find((c) => c.key === "contact_position");
    expect(contact?.direction).toBe("late");
    expect(analysis.priorityFix?.checkpoint).toBe("contact_position");

    // Six phases with a contact representative timestamp.
    expect(analysis.phases).toHaveLength(6);
    expect(analysis.timestamps.contactMs).not.toBeNull();
  });

  it("propagates typed failures instead of fabricating results", async () => {
    const providers = createFixtureVisionProviderSet("forehand_drive");
    const result = await analyzeClip(
      providers,
      { ...clip, durationMs: 200 },
      options("forehand_drive"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
  });

  it("scores a dink with the dink-specific configuration", async () => {
    const providers = createFixtureVisionProviderSet("dink");
    const result = await analyzeClip(providers, clip, options("dink"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.versionVector.shotConfigVersion).toBe("dink@1");
    expect(result.value.resultKind).toBe("scored");
  });
});
