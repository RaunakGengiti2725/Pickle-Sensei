import { beforeAll, describe, expect, it } from "vitest";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import type { ShotTypeSlug } from "@pickle/shared-types";
import { createFixtureVisionProviderSet } from "../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip } from "../src/index.js";

/**
 * STRUCTURAL AUDIT #2 (pass 1) — analyzeClip reproducers.
 * Contract under test (analyzeClip.ts header + analyzeClip.test.ts
 * "propagates typed failures instead of fabricating results"): the
 * orchestrator returns Result<ShotAnalysis>; it must never reject.
 */

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

function options(shotType: ShotTypeSlug) {
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

async function settle<T>(
  promise: Promise<T>,
): Promise<{ kind: "ok"; value: T } | { kind: "threw"; message: string }> {
  try {
    return { kind: "ok", value: await promise };
  } catch (error) {
    return { kind: "threw", message: error instanceof Error ? error.message : String(error) };
  }
}

describe("AUDIT analyzeClip — provider crash containment", () => {
  it("C2-A: a stroke detector that rejects yields a typed failure, not a rejected analyzeClip()", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      stroke: {
        ...base.stroke,
        detectStrokes: async () => {
          throw new Error("native decoder crashed");
        },
      },
    };
    const outcome = await settle(analyzeClip(providers, clip, options("forehand_drive")));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.ok).toBe(false);
  });

  it("C2-B: a paddle detector that rejects (while pose succeeds) yields a typed failure, not a rejected analyzeClip()", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      paddle: {
        ...base.paddle,
        detectPaddle: async () => {
          throw new Error("paddle model failed to load");
        },
      },
    };
    const outcome = await settle(analyzeClip(providers, clip, options("forehand_drive")));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.ok).toBe(false);
  });

  it("C2-C: an unsupported shot slug yields a typed failure (scoring.unsupported_stroke), not a thrown Error", async () => {
    const providers = createFixtureVisionProviderSet("forehand_drive");
    const outcome = await settle(
      analyzeClip(providers, clip, options("around_the_post" as ShotTypeSlug)),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.ok).toBe(false);
  });

  it("C2-D: a never-settling stroke detector must not hang analyzeClip() forever (no timeout/cancellation seam)", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      stroke: { ...base.stroke, detectStrokes: () => new Promise(() => {}) },
    };
    const raced = await Promise.race([
      analyzeClip(providers, clip, options("forehand_drive")).then(() => "SETTLED" as const),
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 300)),
    ]);
    expect(raced).toBe("SETTLED");
  });
});
