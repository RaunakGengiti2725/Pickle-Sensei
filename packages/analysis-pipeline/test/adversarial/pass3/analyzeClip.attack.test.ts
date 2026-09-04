import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fail, failure, ok } from "@pickle/shared-types";
import type {
  IPaddleDetector,
  IPoseProvider,
  VideoClipRef,
  VisionProviderSet,
} from "@pickle/vision-contracts";
import { createFixtureVisionProviderSet } from "../../../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip, type AnalyzeClipOptions } from "../../../src/index.js";

/**
 * Adversarial pass 3 — scenario S7 against `analyzeClip` at 4d812e1a:
 * pose.extractPose returns a typed failure while paddle.detectPaddle
 * REJECTS inside the `Promise.all([...])` fan-out (analyzeClip.ts ~L50).
 *
 * The assertion under attack: no `unhandledRejection` may escape the
 * process. Every rejection must be observed either by analyzeClip
 * returning a typed failure or by the analyzeClip promise itself rejecting
 * (which the caller can catch) — never by an orphaned promise.
 */

const clip: VideoClipRef = {
  uri: "fixture://attack-pass3/clip.mov",
  durationMs: 2_000,
  fps: 30,
  width: 1080,
  height: 1920,
};

const options: AnalyzeClipOptions = {
  analysisId: "clip-attack-3",
  sessionId: null,
  shotType: "forehand_drive",
  handedness: "right",
  cameraView: "side",
  appVersion: "0.1.0",
  modelBundleVersion: "fixture-attack",
  capturedAtIso: "2026-08-27T18:00:00.000Z",
};

const failingPose: IPoseProvider = {
  modelVersion: "attack-pose-fail",
  source: "fixture",
  extractPose: async () =>
    fail(failure("low_confidence", "vision.pose.person_not_found", "No person in frame.")),
};

const rejectingPaddle = (message: string): IPaddleDetector => ({
  modelVersion: "attack-paddle-reject",
  source: "fixture",
  detectPaddle: async () => {
    throw new Error(message);
  },
});

const rejectingPose = (message: string): IPoseProvider => ({
  modelVersion: "attack-pose-reject",
  source: "fixture",
  extractPose: async () => {
    throw new Error(message);
  },
});

const laterRejectingPaddle = (message: string, delayMs: number): IPaddleDetector => ({
  modelVersion: "attack-paddle-late-reject",
  source: "fixture",
  detectPaddle: () =>
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), delayMs)),
});

function providersWith(overrides: Partial<VisionProviderSet>): VisionProviderSet {
  const base = createFixtureVisionProviderSet("forehand_drive");
  return { ...base, ...overrides };
}

function nonFiniteNumbers(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path}=${String(value)}`);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nonFiniteNumbers(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      nonFiniteNumbers(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

/** Let the microtask queue and a macrotask tick settle so Node can emit
 * 'unhandledRejection' for anything orphaned. */
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("analyzeClip — pose fails, paddle rejects inside Promise.all (attack pass 3 / S7)", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("CONTROL: the fixture provider set scores the clip and emits no unhandled rejection", async () => {
    const result = await analyzeClip(providersWith({}), clip, options);
    expect(result.ok).toBe(true);
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("HELD: pose typed-fail + paddle reject → analyzeClip rejects with the paddle error, NO unhandledRejection is emitted", async () => {
    const providers = providersWith({
      pose: failingPose,
      paddle: rejectingPaddle("paddle detector crashed"),
    });
    await expect(analyzeClip(providers, clip, options)).rejects.toThrow("paddle detector crashed");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("HELD: pose reject + paddle typed-fail (mirror) → analyzeClip rejects with the pose error, NO unhandledRejection", async () => {
    const providers = providersWith({
      pose: rejectingPose("pose bridge crashed"),
      paddle: {
        modelVersion: "attack-paddle-fail",
        source: "fixture",
        detectPaddle: async () =>
          fail(failure("low_confidence", "vision.paddle.not_found", "No paddle.")),
      },
    });
    await expect(analyzeClip(providers, clip, options)).rejects.toThrow("pose bridge crashed");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("HELD: BOTH reject (second one later) → the losing rejection is swallowed by Promise.all, NO unhandledRejection", async () => {
    const providers = providersWith({
      pose: rejectingPose("pose crashed first"),
      paddle: laterRejectingPaddle("paddle crashed later", 10),
    });
    await expect(analyzeClip(providers, clip, options)).rejects.toThrow("pose crashed first");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("HELD: pose typed-fail + paddle rejecting 50 ms LATER → analyzeClip still waits for both and rejects; no orphan", async () => {
    const providers = providersWith({
      pose: failingPose,
      paddle: laterRejectingPaddle("late paddle crash", 50),
    });
    const started = Date.now();
    await expect(analyzeClip(providers, clip, options)).rejects.toThrow("late paddle crash");
    // Promise.all does not short-circuit on a fulfilled typed failure: the
    // pose failure is NOT returned early, the paddle rejection wins.
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("HELD: 25 rapid back-to-back attacked calls (interleaved) each reject individually with no unhandledRejection", async () => {
    const providers = providersWith({
      pose: failingPose,
      paddle: rejectingPaddle("burst paddle crash"),
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) =>
        analyzeClip(providers, clip, { ...options, analysisId: `clip-burst-${index}` }),
      ),
    );
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect((outcome.reason as Error).message).toBe("burst paddle crash");
      }
    }
    await settle();
    expect(unhandled).toEqual([]);
  });

  /**
   * FINDING (P3 latent, 4d812e1a): unlike analyzeCapture, analyzeClip has
   * NO crash conversion — a rejecting pose/paddle/phase/features provider
   * rejects the whole analyzeClip promise instead of yielding a typed
   * `Result` failure. The only shipped caller (apps/mobile/src/flow/
   * liveCourt.ts:68) awaits it without try/catch; a provider throw there
   * propagates out of `LiveCourtSession.analyzeRep`. Shipped providers are
   * `async` and return typed failures today, so no production repro.
   */
  it.fails(
    "FINDING: a rejecting paddle detector is converted into a typed Result failure by analyzeClip",
    async () => {
      const providers = providersWith({
        pose: failingPose,
        paddle: rejectingPaddle("paddle detector crashed"),
      });
      const result = await analyzeClip(providers, clip, options);
      expect(result.ok).toBe(false);
    },
  );

  it("HELD: a stroke detector rejecting BEFORE the fan-out also surfaces as a caught analyzeClip rejection, not an orphan", async () => {
    const providers = providersWith({
      stroke: {
        modelVersion: "attack-stroke-reject",
        source: "fixture",
        detectStrokes: async () => {
          throw new Error("stroke detector crashed");
        },
      },
      paddle: rejectingPaddle("paddle would crash too"),
    });
    await expect(analyzeClip(providers, clip, options)).rejects.toThrow("stroke detector crashed");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("HELD: typed pose failure alone (paddle ok) returns the pose failure as a Result, unchanged", async () => {
    const result = await analyzeClip(providersWith({ pose: failingPose }), clip, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("vision.pose.person_not_found");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("HELD: an empty pose frame list with a fine paddle → typed failure (phase gate), never NaN", async () => {
    const result = await analyzeClip(
      providersWith({
        pose: { modelVersion: "attack-empty", source: "fixture", extractPose: async () => ok([]) },
      }),
      clip,
      options,
    );
    // The fixture phase segmenter is scripted; downstream measurements from
    // the fixture extractor are seeded by frame count (0) and remain finite.
    expect(nonFiniteNumbers(result)).toEqual([]);
    await settle();
    expect(unhandled).toEqual([]);
  });
});
