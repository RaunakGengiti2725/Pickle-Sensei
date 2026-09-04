import { describe, expect, it } from "vitest";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  evaluateCaptureEnvelope,
  validateG08LabelFile,
} from "../../src/index.js";
import { G08_LABEL_SCHEMA_VERSION } from "../../src/g08LabelSchema.js";
import {
  checkEnvelopeInvariants,
  clipCampaign,
  envelopeCampaign,
  g08Campaign,
  generateMeasurements,
  hasFfmpeg,
  labelFileCampaign,
  pixelCampaign,
} from "./campaigns.js";
import type { CampaignReport } from "./leakHarness.js";

/**
 * Long-run leak / property stress for @pickle/capture-envelope.
 *
 * Default (CI) scale is small so the suite stays fast; the full campaign is
 * `STRESS_ITER=500 pnpm --filter @pickle/capture-envelope test -- stress`
 * (or the CLI in runLongRunLeak.ts, run under `node --expose-gc` so heap
 * samples are post-GC). Every iteration is replayable from its seed: the
 * per-iteration seed is `iterationSeed(campaignSeed, i)` and the failing
 * scenario is echoed in the report.
 */
const STRESS_ITER = Number(process.env.STRESS_ITER ?? 40);
const CLIP_ITER = Number(
  process.env.STRESS_CLIP_ITER ?? (process.env.STRESS_ITER ? STRESS_ITER : 8),
);
const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? 20260904);

function expectLeakFree(report: CampaignReport): void {
  expect(report.executed).toBe(report.results.length);
  expect(report.leak.heapLeak, `heap slope ${report.leak.heapSlopePer100Relative}`).toBe(false);
  expect(report.leak.resourcesReturnedToBaseline, JSON.stringify(report.leak)).toBe(true);
  expect(report.leak.timeDrift, `time drift ratio ${report.leak.timeDriftRatio}`).toBe(false);
}

function brokenSeeds(report: CampaignReport): string {
  return report.results
    .filter((r) => r.outcome === "BROKEN")
    .slice(0, 5)
    .map((r) => `seed=${r.seed} ${r.scenario ?? ""} ${r.violations.join("; ")}`)
    .join("\n");
}

describe(`long-run leak stress (STRESS_ITER=${STRESS_ITER})`, () => {
  it("evaluateCaptureEnvelope over finite seeded measurements: HELD", () => {
    const report = envelopeCampaign(CAMPAIGN_SEED, STRESS_ITER, "finite");
    expect(report.broken, brokenSeeds(report)).toBe(0);
    expectLeakFree(report);
  });

  it("evaluateCaptureEnvelope over pathological measurements: deterministic, leak-free; only the known non-finite gap", () => {
    const report = envelopeCampaign(CAMPAIGN_SEED + 1, STRESS_ITER, "pathological");
    expectLeakFree(report);
    const unexpected = report.results.flatMap((r) =>
      r.violations.filter((v) => !/nonfinite measured|JSON round trip alters verdict/.test(v)),
    );
    expect(unexpected, brokenSeeds(report)).toEqual([]);
  });

  it("pixel math over seeded synthetic frames: HELD", () => {
    const report = pixelCampaign(CAMPAIGN_SEED + 2, STRESS_ITER);
    expect(report.broken, brokenSeeds(report)).toBe(0);
    expectLeakFree(report);
  });

  it("g08 gate metrics over seeded rows: HELD", () => {
    const report = g08Campaign(CAMPAIGN_SEED + 3, STRESS_ITER);
    expect(report.broken, brokenSeeds(report)).toBe(0);
    expectLeakFree(report);
  });

  it("validateG08LabelFile over seeded mutations: deterministic, leak-free; only the known supersede-cycle gap", () => {
    const report = labelFileCampaign(CAMPAIGN_SEED + 4, STRESS_ITER);
    expectLeakFree(report);
    const unexpected = report.results.flatMap((r) =>
      r.violations.filter((v) => !v.startsWith("supersede_cycle:")),
    );
    expect(unexpected, brokenSeeds(report)).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)(
    "measureClip / computeBypassSignals over seeded ffmpeg fixtures: HELD, no child processes left",
    { timeout: 600_000 },
    () => {
      const report = clipCampaign(CAMPAIGN_SEED + 5, CLIP_ITER);
      expect(report.broken, brokenSeeds(report)).toBe(0);
      expectLeakFree(report);
    },
  );
});

describe("minimized seeds pinning the reproduced gaps (documented, not fixed here)", () => {
  it("classifyDimension lets ±Infinity through as a measured SUPPORTED/UNSUPPORTED verdict", () => {
    const m = generateMeasurements(0, "finite");
    const verdict = evaluateCaptureEnvelope({ ...m, avgFrameRateFps: Number.POSITIVE_INFINITY });
    const frameRate = verdict.dimensions.find((d) => d.dimension === "frame_rate");
    expect(frameRate?.status).toBe("SUPPORTED");
    expect(frameRate?.measured).toBe(Number.POSITIVE_INFINITY);
    expect("max" in CAPTURE_ENVELOPE_THRESHOLDS.frame_rate.supported).toBe(false);
    const roundTrip = JSON.parse(JSON.stringify(verdict)) as typeof verdict;
    expect(roundTrip.dimensions.find((d) => d.dimension === "frame_rate")?.measured).toBeNull();
    expect(
      checkEnvelopeInvariants({ ...m, avgFrameRateFps: Number.POSITIVE_INFINITY }).some((v) =>
        v.startsWith("frame_rate: nonfinite"),
      ),
    ).toBe(true);
  });

  it("validateG08LabelFile accepts a two-record supersede cycle and drops both labels", () => {
    const base = {
      candidateId: null,
      clip: "datasets/clips/x.mp4",
      windowMs: { startMs: 0, durationMs: 1000 },
      sessionKey: "s",
      family: "camera_shake",
      capture: "SAFE",
      downstream: "USABLE",
      annotatorKind: "human",
      annotator: "ab",
      labeledAtIso: "2026-09-04T00:00:00.000Z",
      notes: "",
    };
    const result = validateG08LabelFile({
      schemaVersion: G08_LABEL_SCHEMA_VERSION,
      provenance: "stress",
      labels: [
        { ...base, labelId: "a", supersedesLabelId: "b" },
        { ...base, labelId: "b", supersedesLabelId: "a" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.effective).toEqual([]);
  });
});
