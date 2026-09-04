/**
 * Adversarial pass 3 / tester #4 — analyzeClip partial-failure surface.
 *
 * Attacks: a stroke provider that THROWS (not fail()), an unregistered
 * shotType slug, and rapid interleaved runs mixing crashing/healthy
 * providers. The pipeline contract (see analyzeCapture's provider_crash
 * envelope and REVIEW.md "provider crashes are typed failures") is that the
 * orchestrator returns Result<ShotAnalysis> — never an unhandled rejection.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ShotTypeSlug } from "@pickle/shared-types";
import type {
  IFeatureExtractor,
  IStrokeDetector,
  VideoClipRef,
  VisionProviderSet,
} from "@pickle/vision-contracts";
import { createFixtureVisionProviderSet } from "../../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip, type AnalyzeClipOptions } from "../../src/index.js";

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

function options(shotType: ShotTypeSlug): AnalyzeClipOptions {
  return {
    analysisId: "3b9f2b60-1111-4222-8333-444455556666",
    sessionId: null,
    shotType,
    handedness: "right",
    cameraView: "side",
    appVersion: "0.1.0",
    modelBundleVersion: "fixture-1",
    capturedAtIso: "2026-08-26T18:00:00.000Z",
  };
}

class ThrowingStrokeDetector implements IStrokeDetector {
  readonly modelVersion = "attack-1";
  readonly source = "fixture" as const;
  constructor(private readonly mode: "sync" | "async") {}
  detectStrokes(_clip: VideoClipRef): ReturnType<IStrokeDetector["detectStrokes"]> {
    if (this.mode === "sync") throw new Error("stroke provider crashed synchronously");
    return Promise.reject(new Error("stroke provider crashed asynchronously"));
  }
}

function withThrowingStroke(mode: "sync" | "async"): VisionProviderSet {
  const base = createFixtureVisionProviderSet("forehand_drive");
  return { ...base, stroke: new ThrowingStrokeDetector(mode) };
}

/**
 * A feature extractor that always measures as a forehand so the pipeline
 * reaches getShotScoringConfig(options.shotType) with whatever slug the caller
 * passed (the fixture extractor would otherwise fail first on unknown slugs).
 */
function withSlugAgnosticFeatures(): VisionProviderSet {
  const base = createFixtureVisionProviderSet("forehand_drive");
  const features: IFeatureExtractor = {
    version: `${base.features.version}+slug-agnostic`,
    extractMeasurements: (input) =>
      base.features.extractMeasurements({ ...input, shotType: "forehand_drive" }),
  };
  return { ...base, features };
}

/** Resolve to a discriminated outcome so a rejection is an assertion, not a crash. */
async function settle<T>(
  promise: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

beforeAll(() => {
  process.env["PICKLE_ENV"] = "development";
});

describe("[attack] analyzeClip — stroke.detectStrokes that throws instead of fail()", () => {
  it("async rejection from detectStrokes surfaces as a typed failure, not a rejected promise", async () => {
    const outcome = await settle(
      analyzeClip(withThrowingStroke("async"), clip, options("forehand_drive")),
    );
    expect(
      outcome.status,
      `analyzeClip rejected: ${String((outcome as { reason?: unknown }).reason)}`,
    ).toBe("fulfilled");
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.ok).toBe(false);
    if (outcome.value.ok) return;
    expect(outcome.value.failure.kind).toBeTypeOf("string");
    expect(outcome.value.failure.code).toMatch(/provider_crash|stroke/);
  });

  it("synchronous throw from detectStrokes surfaces as a typed failure, not a rejected promise", async () => {
    const outcome = await settle(
      analyzeClip(withThrowingStroke("sync"), clip, options("forehand_drive")),
    );
    expect(
      outcome.status,
      `analyzeClip rejected: ${String((outcome as { reason?: unknown }).reason)}`,
    ).toBe("fulfilled");
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.ok).toBe(false);
  });

  it("rapid interleaving: a crashing provider never poisons a concurrent healthy run", async () => {
    const healthy = createFixtureVisionProviderSet("forehand_drive");
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        settle(
          analyzeClip(
            i % 2 === 0 ? withThrowingStroke("async") : healthy,
            clip,
            options("forehand_drive"),
          ),
        ),
      ),
    );
    for (const [i, run] of runs.entries()) {
      if (i % 2 === 1) {
        expect(run.status).toBe("fulfilled");
        if (run.status === "fulfilled") expect(run.value.ok).toBe(true);
      } else {
        // Attack expectation: crash is typed, not a rejection.
        expect(
          run.status,
          `run ${i} rejected: ${String((run as { reason?: unknown }).reason)}`,
        ).toBe("fulfilled");
      }
    }
  });
});

describe("[attack] analyzeClip — unregistered options.shotType", () => {
  it("returns a typed failure for an unregistered slug instead of throwing from getShotScoringConfig", async () => {
    const providers = withSlugAgnosticFeatures();
    const bogus = "lob_smash_2000" as unknown as ShotTypeSlug;
    const outcome = await settle(analyzeClip(providers, clip, options(bogus)));
    expect(
      outcome.status,
      `analyzeClip rejected: ${String((outcome as { reason?: unknown }).reason)}`,
    ).toBe("fulfilled");
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.ok).toBe(false);
    if (outcome.value.ok) return;
    expect(outcome.value.failure.code).toMatch(/unsupported|scoring/);
  });

  it("'return' is a registered slug and analyzes without throwing", async () => {
    const providers = createFixtureVisionProviderSet("return");
    const outcome = await settle(analyzeClip(providers, clip, options("return")));
    expect(outcome.status).toBe("fulfilled");
  });

  it("prototype-ish slugs ('constructor', '__proto__', 'toString') do not throw", async () => {
    const providers = withSlugAgnosticFeatures();
    for (const slug of ["constructor", "__proto__", "toString", "", " "]) {
      const outcome = await settle(
        analyzeClip(providers, clip, options(slug as unknown as ShotTypeSlug)),
      );
      expect(outcome.status, `slug ${JSON.stringify(slug)} rejected`).toBe("fulfilled");
      if (outcome.status === "fulfilled") expect(outcome.value.ok).toBe(false);
    }
  });
});
