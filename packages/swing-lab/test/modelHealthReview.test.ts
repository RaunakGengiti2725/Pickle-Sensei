import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEALTH_REVIEW_VERSION,
  HEALTH_SECTION_IDS,
  buildHealthReview,
  collectHealthReviewInputs,
  renderHealthReviewMarkdown,
  type HealthReviewInputs,
} from "../src/modelHealthReview.js";

const REPO_ROOT = resolve(__dirname, "../../..");
const NOW = "2026-08-29T00:00:00.000Z";

function emptyInputs(): HealthReviewInputs {
  return {
    experimentSummaries: [],
    modelManifestEntries: [],
    coachAgreement: null,
    calibrationCert: null,
    frozenCalibrationGate: null,
    envelopeCert: null,
    confidenceRouting: [],
    hardSliceArtifacts: [],
    latencyArtifacts: [],
    productionTelemetryArtifacts: [],
    complaintArtifacts: [],
    telemetryInfraSummaryPath: null,
    deviceHarnessSummaryPath: null,
    deviceHarnessVerdict: null,
  };
}

describe("buildHealthReview", () => {
  it("emits every required section exactly once, in the declared order", () => {
    const review = buildHealthReview(emptyInputs(), NOW);
    expect(review.reviewVersion).toBe(HEALTH_REVIEW_VERSION);
    expect(review.generatedAtIso).toBe(NOW);
    expect(review.sections.map((s) => s.id)).toEqual([...HEALTH_SECTION_IDS]);
  });

  it("marks every evidence-free section NO_DATA and never fabricates findings", () => {
    const review = buildHealthReview(emptyInputs(), NOW);
    for (const section of review.sections) {
      if (section.id === "next_wave_recommendations") continue;
      expect(section.status, section.id).toBe("NO_DATA");
      // active_models cites the manifest source file even when it is empty.
      if (section.id !== "active_models") expect(section.evidence, section.id).toEqual([]);
    }
    const text = JSON.stringify(review);
    expect(text).not.toMatch(/PASS/);
    expect(text).not.toMatch(/GREEN/);
  });

  it("never claims a trend from a single snapshot (latency, abstention, envelope, calibration)", () => {
    const inputs: HealthReviewInputs = {
      ...emptyInputs(),
      latencyArtifacts: ["datasets/experiments/wave-g/g23-latency-dist-summary.json"],
      confidenceRouting: [{ task: "contact", nUnits: 15, abstained: 4 }],
      envelopeCert: {
        path: "datasets/experiments/wave-h/h17-envelope-cert-summary.json",
        gate: "GATE 5",
        measuredAt: "2026-08-29T18:04:16.102Z",
        thresholdsVersion: "capture-envelope-thresholds-v0.3-provisional",
      },
      calibrationCert: {
        path: "datasets/experiments/wave-h/h18-cert-report.json",
        generatedAtIso: "2026-08-29T18:35:00Z",
        calibrationViews: [{ name: "W14 TA blind overlap", n: 12, ece10: 0.1208, aurc: 0.0765 }],
      },
    };
    const review = buildHealthReview(inputs, NOW);
    const byId = new Map(review.sections.map((s) => [s.id, s]));
    // A single latency snapshot must NOT produce a regression verdict either way.
    expect(byId.get("latency_regressions")!.status).toBe("NO_DATA");
    for (const id of [
      "abstention_increases",
      "envelope_regressions",
      "confidence_anomalies",
    ] as const) {
      const section = byId.get(id)!;
      expect(section.status).toBe("ATTENTION");
      expect(section.findings.join(" ")).toMatch(
        /[Ss]ingle (snapshot|certification|certified snapshot)/,
      );
    }
    expect(byId.get("abstention_increases")!.findings.join(" ")).toContain("4/15");
  });

  it("marks coach disagreements BLOCKED_EXTERNAL when zero real coach reviews exist", () => {
    const inputs: HealthReviewInputs = {
      ...emptyInputs(),
      coachAgreement: {
        path: "datasets/coach-review/agreement/agreement-report.json",
        realReviewCount: 0,
        status: "AWAITING QUALIFIED COACHES",
        banner: "N=0 REAL COACH REVIEWS",
      },
    };
    const review = buildHealthReview(inputs, NOW);
    const section = review.sections.find((s) => s.id === "coach_model_disagreements")!;
    expect(section.status).toBe("BLOCKED_EXTERNAL");
    expect(section.findings.join(" ")).toContain("Zero real coach reviews");
  });

  it("derives next-wave recommendations from blocked/attention sections", () => {
    const inputs: HealthReviewInputs = {
      ...emptyInputs(),
      coachAgreement: {
        path: "datasets/coach-review/agreement/agreement-report.json",
        realReviewCount: 0,
        status: "AWAITING QUALIFIED COACHES",
        banner: null,
      },
      hardSliceArtifacts: ["datasets/experiments/wave-h/h14-ball-hardslice-linux-proxy.json"],
    };
    const review = buildHealthReview(inputs, NOW);
    const recs = review.sections.find((s) => s.id === "next_wave_recommendations")!;
    expect(recs.status).toBe("ATTENTION");
    const text = recs.findings.join(" ");
    expect(text).toContain("Coach/model disagreements");
    expect(text).toContain("hard-slice");
    expect(text).toContain("drift");
  });
});

describe("collectHealthReviewInputs", () => {
  it("returns honest empty inputs for a repo with no artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "health-review-empty-"));
    mkdirSync(join(root, "datasets", "experiments"), { recursive: true });
    const inputs = collectHealthReviewInputs(root);
    expect(inputs.experimentSummaries).toEqual([]);
    expect(inputs.coachAgreement).toBeNull();
    expect(inputs.calibrationCert).toBeNull();
    expect(inputs.envelopeCert).toBeNull();
    expect(inputs.hardSliceArtifacts).toEqual([]);
    expect(inputs.latencyArtifacts).toEqual([]);
    expect(inputs.complaintArtifacts).toEqual([]);
    expect(inputs.productionTelemetryArtifacts).toEqual([]);
    // The model manifest is code, not data — it is always present.
    expect(inputs.modelManifestEntries.length).toBeGreaterThan(0);
  });

  it("tolerates malformed JSON without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "health-review-bad-"));
    const wave = join(root, "datasets", "experiments", "wave-x");
    mkdirSync(wave, { recursive: true });
    writeFileSync(join(wave, "x01-summary.json"), "{ not json");
    const inputs = collectHealthReviewInputs(root);
    expect(inputs.experimentSummaries).toHaveLength(1);
    expect(inputs.experimentSummaries[0]!.workstream).toBeNull();
  });

  it("collects the real repo artifacts (integration against committed datasets/)", () => {
    const inputs = collectHealthReviewInputs(REPO_ROOT);
    expect(inputs.experimentSummaries.length).toBeGreaterThan(50);
    expect(inputs.coachAgreement).not.toBeNull();
    expect(inputs.coachAgreement!.realReviewCount).toBe(0);
    expect(inputs.calibrationCert).not.toBeNull();
    expect(inputs.calibrationCert!.calibrationViews.length).toBeGreaterThan(0);
    expect(inputs.frozenCalibrationGate).not.toBeNull();
    expect(inputs.frozenCalibrationGate!.status).toBe("FROZEN");
    expect(inputs.envelopeCert).not.toBeNull();
    expect(inputs.hardSliceArtifacts.length).toBeGreaterThan(0);
    expect(inputs.latencyArtifacts.length).toBeGreaterThan(0);
    // Honest zeros: no production telemetry, no complaints exist today.
    expect(inputs.productionTelemetryArtifacts).toEqual([]);
    expect(inputs.complaintArtifacts).toEqual([]);

    const review = buildHealthReview(inputs, NOW);
    const byId = new Map(review.sections.map((s) => [s.id, s]));
    expect(byId.get("drift")!.status).toBe("NO_DATA");
    expect(byId.get("complaints")!.status).toBe("NO_DATA");
    expect(byId.get("coach_model_disagreements")!.status).toBe("BLOCKED_EXTERNAL");
    expect(byId.get("device_specific_problems")!.status).toBe("BLOCKED_EXTERNAL");
    expect(byId.get("latency_regressions")!.status).toBe("NO_DATA");
    for (const section of review.sections) {
      for (const evidence of section.evidence) {
        expect(evidence.startsWith("/"), evidence).toBe(false);
      }
    }
  });
});

describe("renderHealthReviewMarkdown", () => {
  it("renders every section with its status and evidence paths", () => {
    const inputs: HealthReviewInputs = {
      ...emptyInputs(),
      hardSliceArtifacts: ["datasets/experiments/wave-h/h14-ball-hardslice-linux-proxy.json"],
    };
    const markdown = renderHealthReviewMarkdown(buildHealthReview(inputs, NOW));
    expect(markdown).toContain("# Model-Health Review");
    expect(markdown).toContain("| New hard slices | ATTENTION |");
    expect(markdown).toContain("`datasets/experiments/wave-h/h14-ball-hardslice-linux-proxy.json`");
    expect(markdown).toContain("## User complaints / feedback — NO_DATA");
  });
});
