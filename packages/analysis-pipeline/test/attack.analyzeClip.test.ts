import { beforeAll, describe, expect, it } from "vitest";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import { fail, failure, ok } from "@pickle/shared-types";
import { createFixtureVisionProviderSet } from "../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip } from "../src/index.js";

/**
 * Adversarial probes against the ADJ-AP-007 Result boundary (`guarded()` in
 * analyzeClip.ts). Each test states the contract it holds the pipeline to;
 * the docblock on analyzeClip.ts promises "the pipeline never leaks a raw
 * rejection to its caller".
 *
 * Status on candidate 9531dd1e (attack branch devin/attack-fix-9531dd1e):
 *   - "rejection reasons the boundary cannot stringify": FAIL — guarded()'s
 *     catch block evaluates `error.message` / `String(error)` unguarded, so a
 *     reason that throws on stringification rejects analyzeClip. Same class of
 *     input also rejects at 4d812e1a (no boundary at all) → not a regression,
 *     but the fix's stated guarantee does not hold for it.
 *   - "providers that resolve with a non-Result": FAIL — `.ok` is read on the
 *     provider's return value outside any boundary. Pre-existing at 4d812e1a
 *     and outside the ADJ-AP-007 acceptance text ("throwing/rejecting"), listed
 *     because the docblock claims no raw rejection ever leaks.
 *   - "boundary properties that DO hold": PASS on 9531dd1e, FAIL on 4d812e1a.
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

type Stage = "stroke" | "pose" | "paddle" | "phase" | "features";
const METHOD = {
  stroke: "detectStrokes",
  pose: "extractPose",
  paddle: "detectPaddle",
  phase: "segmentPhases",
  features: "extractMeasurements",
} as const;

function withStage(stage: Stage, impl: (...args: unknown[]) => unknown): VisionProviderSet {
  const providers = createFixtureVisionProviderSet("forehand_drive");
  const original = providers[stage];
  const patched = Object.create(Object.getPrototypeOf(original) as object) as object;
  Object.assign(patched, original, { [METHOD[stage]]: impl });
  return { ...providers, [stage]: patched } as VisionProviderSet;
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

describe("ATTACK ADJ-AP-007: rejection reasons the boundary cannot stringify", () => {
  it("a null-prototype rejection reason must still settle as ok:false (String(reason) throws)", async () => {
    // Object.create(null) has no toString/valueOf → String(x) throws TypeError
    // inside guarded()'s catch block, so the boundary itself rejects.
    const providers = withStage("stroke", async () => {
      throw Object.create(null) as never;
    });
    const settled = await settle(analyzeClip(providers, clip, options));
    expect(settled.kind).toBe("resolved");
    if (settled.kind !== "resolved") return;
    expect(settled.value.ok).toBe(false);
    if (settled.value.ok) return;
    expect(settled.value.failure.code).toBe("stroke.provider_crash");
  });

  it("an Error whose .message getter throws must still settle as ok:false", async () => {
    const providers = withStage("pose", async () => {
      const error = new Error("boom");
      Object.defineProperty(error, "message", {
        get() {
          throw new TypeError("message unavailable");
        },
      });
      throw error;
    });
    const settled = await settle(analyzeClip(providers, clip, options));
    expect(settled.kind).toBe("resolved");
    if (settled.kind !== "resolved") return;
    expect(settled.value.ok).toBe(false);
    if (settled.value.ok) return;
    expect(settled.value.failure.code).toBe("pose.provider_crash");
  });

  it("an object whose toString throws must still settle as ok:false", async () => {
    const providers = withStage("features", async () => {
      throw {
        toString() {
          throw new Error("toString exploded");
        },
      };
    });
    const settled = await settle(analyzeClip(providers, clip, options));
    expect(settled.kind).toBe("resolved");
    if (settled.kind !== "resolved") return;
    expect(settled.value.ok).toBe(false);
    if (settled.value.ok) return;
    expect(settled.value.failure.code).toBe("features.provider_crash");
  });
});

describe("ATTACK ADJ-AP-007: providers that resolve with a non-Result", () => {
  it.each(["stroke", "pose", "paddle", "phase", "features"] as const)(
    "%s provider resolving `undefined` must not escape as a raw TypeError",
    async (stage) => {
      const providers = withStage(stage, async () => undefined);
      const settled = await settle(analyzeClip(providers, clip, options));
      expect(settled.kind).toBe("resolved");
      if (settled.kind !== "resolved") return;
      expect(settled.value.ok).toBe(false);
    },
  );

  it("stroke provider resolving ok(null) (no array) must not escape as a raw TypeError", async () => {
    const providers = withStage("stroke", async () => ok(null));
    const settled = await settle(analyzeClip(providers, clip, options));
    expect(settled.kind).toBe("resolved");
    if (settled.kind !== "resolved") return;
    expect(settled.value.ok).toBe(false);
  });
});

describe("ATTACK ADJ-AP-007: boundary properties that DO hold (regression guards)", () => {
  it("concurrent pose typed-failure + paddle crash: pose's typed failure wins deterministically", async () => {
    const base = withStage("paddle", async () => {
      throw new Error("paddle_crashed");
    });
    const poseProto = Object.getPrototypeOf(base.pose) as object;
    const pose = Object.assign(Object.create(poseProto) as object, base.pose, {
      extractPose: async () => fail(failure("low_confidence", "pose.too_few_frames", "few")),
    }) as VisionProviderSet["pose"];
    const result = await analyzeClip({ ...base, pose }, clip, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("pose.too_few_frames");
    expect(result.failure.kind).toBe("low_confidence");
  });

  it("a delayed rejection (paddle) racing a fast pose still yields paddle.provider_crash", async () => {
    const providers = withStage(
      "paddle",
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("late_paddle_crash")), 20);
        }),
    );
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("paddle.provider_crash");
    expect(result.failure.message).toBe("late_paddle_crash");
  });

  it("200 concurrent analyzeClip calls with a crashing stage each settle, never reject", async () => {
    const stages: Stage[] = ["stroke", "pose", "paddle", "phase", "features"];
    const runs = Array.from({ length: 200 }, (_, i) => {
      const stage = stages[i % stages.length]!;
      const providers = withStage(stage, async () => {
        await new Promise((r) => setTimeout(r, i % 7));
        throw new Error(`${stage}_${i}`);
      });
      return settle(analyzeClip(providers, { ...clip, uri: `fixture://c-${i}` }, options));
    });
    const settled = await Promise.all(runs);
    for (const [i, s] of settled.entries()) {
      expect(s.kind).toBe("resolved");
      if (s.kind !== "resolved") continue;
      expect(s.value.ok).toBe(false);
      if (s.value.ok) continue;
      expect(s.value.failure.code).toBe(`${stages[i % stages.length]}.provider_crash`);
      expect(s.value.failure.message).toBe(`${stages[i % stages.length]}_${i}`);
    }
  });

  it("unicode / oversized error messages pass through byte-for-byte", async () => {
    const message = "🥒".repeat(10_000) + "\u0000\uFFFF";
    const providers = withStage("phase", async () => {
      throw new Error(message);
    });
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(message);
  });

  it("a rejected Error's `cause` is not carried into OperationFailure.cause (documented drop)", async () => {
    const providers = withStage("stroke", async () => {
      throw new Error("outer", { cause: new Error("inner") });
    });
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.cause).toBeUndefined();
    expect(result.failure.retryable).toBe(false);
  });
});
