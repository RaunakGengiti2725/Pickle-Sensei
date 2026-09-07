import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_MODEL_MANIFEST } from "@pickle/model-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_REVIEW_VERSION,
  HEALTH_SECTION_IDS,
  buildHealthReview,
  collectHealthReviewInputs,
  renderHealthReviewMarkdown,
  type HealthReviewInputs,
} from "../src/modelHealthReview.js";

// Call through to the real filesystem: budgets must cover the actual walk, not
// a synthetic directory listing, and the committed-artifact integration stays real.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: vi.fn(fs.existsSync),
    statSync: vi.fn(fs.statSync),
    lstatSync: vi.fn(fs.lstatSync),
    readdirSync: vi.fn(fs.readdirSync),
  };
});

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
  const tempRoots: string[] = [];

  function tempRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "health-review-inventory-"));
    tempRoots.push(root);
    return root;
  }

  function artifact(root: string, path: string, content: unknown = {}): void {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
  }

  function manifestOnlyInputs(): HealthReviewInputs {
    return { ...emptyInputs(), modelManifestEntries: DEFAULT_MODEL_MANIFEST.entries };
  }

  afterEach(() => {
    vi.resetAllMocks();
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("walks datasets once with root-only metadata probes and preserves every collected input", () => {
    const root = tempRepo();
    // Deliberately create paths out of order, including an experiments-* sibling,
    // non-JSON bench files, malformed summaries, and every fixed-path snapshot.
    const files: Record<string, unknown> = {
      "datasets/experiments/z-summary.json": {
        workstream: "root",
        workstreamId: "ignored",
        experiment: "ignored",
        gate: "ROOT",
      },
      "datasets/experiments/wave-z/nested/z-summary.json": { workstreamId: "nested" },
      "datasets/experiments/wave-z/timing-summary.json": { workstream: "timing" },
      "datasets/experiments/wave-z/hard-slice-summary.json": { workstream: "slices" },
      "datasets/experiments/wave-a/b-summary.json": "{ not json",
      "datasets/experiments/wave-a/a-summary.JSON": { experiment: "a01", gate: "A" },
      "datasets/experiments/wave-a/summary.json.bak": { workstream: "ignored" },
      "datasets/experiments/wave-a/notes.json": { workstream: "ignored" },
      "datasets/experiments-archive/latency-summary.json": { workstream: "not an experiment" },
      "datasets/bench/z-latency.csv": "sample,ms\n1,10\n",
      "datasets/bench/a-hard-slice.csv": "slice,n\nexample,1\n",
      "datasets/bench/user-feedback.json": {},
      "datasets/evaluation-trials/trial.json": {},
      "datasets/evaluation-trial/single.json": {},
      "datasets/coach-review/agreement/agreement-report.json": {
        realReviewCount: 2,
        status: "REVIEWED",
        banner: "test fixture",
      },
      "datasets/experiments/wave-h/h18-cert-report.json": {
        generatedAtIso: NOW,
        riskCoverageViews: {
          calibration: [{ name: "test", n: 5, ece10: 0.05, aurc: 0.01 }, null, { name: 7 }],
        },
        confidenceRouting: {
          contact: { nUnits: 5, bands: { accept: 2, abstain: 1, ABSTAIN_low: 2 } },
          stroke: { nUnits: 1, bands: { accept: 1 } },
          ignored: null,
        },
      },
      "datasets/experiments/wave-h/h18-frozen-release-gate-g6-v1.json": {
        gate: "GATE 6",
        status: "FROZEN",
        frozenAtIso: NOW,
      },
      "datasets/experiments/wave-h/h17-envelope-cert-summary.json": {
        gate: "GATE 5",
        measuredAt: NOW,
        versions: { captureEnvelopeThresholds: "test-v1" },
      },
      "datasets/experiments/wave-g2/h06-device-harness-summary.json": {
        workstream: "h06",
        verdict: "BLOCKED_EXTERNAL",
      },
      "datasets/experiments/wave-g2/h07-distribution-telemetry-summary.json": {
        experiment: "h07",
      },
    };
    const directories = new Set<string>();
    for (const [path, content] of Object.entries(files)) {
      artifact(root, path, content);
      for (let dir = dirname(join(root, path)); dir !== root; dir = dirname(dir)) {
        directories.add(dir);
      }
    }
    vi.clearAllMocks();

    expect(collectHealthReviewInputs(root)).toEqual({
      modelManifestEntries: DEFAULT_MODEL_MANIFEST.entries,
      experimentSummaries: [
        {
          path: "datasets/experiments/wave-a/a-summary.JSON",
          wave: "wave-a",
          workstream: "a01",
          gate: "A",
        },
        {
          path: "datasets/experiments/wave-a/b-summary.json",
          wave: "wave-a",
          workstream: null,
          gate: null,
        },
        {
          path: "datasets/experiments/wave-g2/h06-device-harness-summary.json",
          wave: "wave-g2",
          workstream: "h06",
          gate: null,
        },
        {
          path: "datasets/experiments/wave-g2/h07-distribution-telemetry-summary.json",
          wave: "wave-g2",
          workstream: "h07",
          gate: null,
        },
        {
          path: "datasets/experiments/wave-h/h17-envelope-cert-summary.json",
          wave: "wave-h",
          workstream: null,
          gate: "GATE 5",
        },
        {
          path: "datasets/experiments/wave-z/hard-slice-summary.json",
          wave: "wave-z",
          workstream: "slices",
          gate: null,
        },
        {
          path: "datasets/experiments/wave-z/nested/z-summary.json",
          wave: "wave-z",
          workstream: "nested",
          gate: null,
        },
        {
          path: "datasets/experiments/wave-z/timing-summary.json",
          wave: "wave-z",
          workstream: "timing",
          gate: null,
        },
        {
          path: "datasets/experiments/z-summary.json",
          wave: null,
          workstream: "root",
          gate: "ROOT",
        },
      ],
      coachAgreement: {
        path: "datasets/coach-review/agreement/agreement-report.json",
        realReviewCount: 2,
        status: "REVIEWED",
        banner: "test fixture",
      },
      calibrationCert: {
        path: "datasets/experiments/wave-h/h18-cert-report.json",
        generatedAtIso: NOW,
        calibrationViews: [{ name: "test", n: 5, ece10: 0.05, aurc: 0.01 }],
      },
      frozenCalibrationGate: {
        path: "datasets/experiments/wave-h/h18-frozen-release-gate-g6-v1.json",
        gate: "GATE 6",
        status: "FROZEN",
        frozenAtIso: NOW,
      },
      envelopeCert: {
        path: "datasets/experiments/wave-h/h17-envelope-cert-summary.json",
        gate: "GATE 5",
        measuredAt: NOW,
        thresholdsVersion: "test-v1",
      },
      confidenceRouting: [
        { task: "contact", nUnits: 5, abstained: 3 },
        { task: "stroke", nUnits: 1, abstained: null },
      ],
      hardSliceArtifacts: [
        "datasets/bench/a-hard-slice.csv",
        "datasets/experiments/wave-z/hard-slice-summary.json",
      ],
      latencyArtifacts: [
        "datasets/bench/z-latency.csv",
        "datasets/experiments-archive/latency-summary.json",
        "datasets/experiments/wave-z/timing-summary.json",
      ],
      productionTelemetryArtifacts: [
        "datasets/evaluation-trial/single.json",
        "datasets/evaluation-trials/trial.json",
      ],
      complaintArtifacts: ["datasets/bench/user-feedback.json"],
      deviceHarnessSummaryPath: "datasets/experiments/wave-g2/h06-device-harness-summary.json",
      deviceHarnessVerdict: "BLOCKED_EXTERNAL",
      telemetryInfraSummaryPath:
        "datasets/experiments/wave-g2/h07-distribution-telemetry-summary.json",
    } satisfies HealthReviewInputs);
    // Deterministic filesystem-call budgets, not a machine-dependent time limit.
    expect
      .soft(
        vi
          .mocked(readdirSync)
          .mock.calls.map(([path]) => path)
          .sort(),
      )
      .toEqual([...directories].sort());
    expect.soft(vi.mocked(existsSync).mock.calls).toEqual([[join(root, "datasets")]]);
    expect.soft(vi.mocked(statSync).mock.calls).toEqual([[join(root, "datasets")]]);
    expect.soft(lstatSync).not.toHaveBeenCalled();
  });

  it("follows a datasets root symlink but ignores nested file, directory and dangling symlinks", () => {
    const root = tempRepo();
    artifact(root, "inventory/experiments/wave-a/a-summary.json", { workstream: "a01" });
    artifact(root, "inventory/bench/latency.csv");
    artifact(root, "outside/x-summary.json", { workstream: "not collected" });
    symlinkSync(join(root, "inventory"), join(root, "datasets"), "dir");
    const wave = join(root, "inventory/experiments/wave-a");
    symlinkSync(join(wave, "a-summary.json"), join(wave, "linked-summary.json"), "file");
    symlinkSync(join(root, "outside"), join(wave, "linked-hard-slice"), "dir");
    symlinkSync(join(root, "missing"), join(wave, "dangling-summary.json"), "file");

    expect(collectHealthReviewInputs(root)).toEqual({
      ...manifestOnlyInputs(),
      experimentSummaries: [
        {
          path: "datasets/experiments/wave-a/a-summary.json",
          wave: "wave-a",
          workstream: "a01",
          gate: null,
        },
      ],
      latencyArtifacts: ["datasets/bench/latency.csv"],
    });
  });

  it("follows an experiments root symlink for summaries and fixed snapshots, not dataset lists", () => {
    const root = tempRepo();
    artifact(root, "archive/wave-x/x-summary.json", { workstream: "x01" });
    artifact(root, "archive/wave-x/hard-slice-latency.json");
    artifact(root, "archive/wave-g2/h06-device-harness-summary.json", {
      verdict: "BLOCKED_EXTERNAL",
    });
    mkdirSync(join(root, "datasets"));
    symlinkSync(join(root, "archive"), join(root, "datasets/experiments"), "dir");

    expect(collectHealthReviewInputs(root)).toEqual({
      ...manifestOnlyInputs(),
      experimentSummaries: [
        {
          path: "datasets/experiments/wave-g2/h06-device-harness-summary.json",
          wave: "wave-g2",
          workstream: null,
          gate: null,
        },
        {
          path: "datasets/experiments/wave-x/x-summary.json",
          wave: "wave-x",
          workstream: "x01",
          gate: null,
        },
      ],
      deviceHarnessSummaryPath: "datasets/experiments/wave-g2/h06-device-harness-summary.json",
      deviceHarnessVerdict: "BLOCKED_EXTERNAL",
    });
  });

  it.each(["datasets", "datasets/experiments"])(
    "handles absent, file and dangling-symlink roots at %s",
    (path) => {
      const root = tempRepo();
      mkdirSync(dirname(join(root, path)), { recursive: true });
      expect(collectHealthReviewInputs(root)).toEqual(manifestOnlyInputs());
      artifact(root, path);
      expect(collectHealthReviewInputs(root)).toEqual(manifestOnlyInputs());
      rmSync(join(root, path));
      symlinkSync(join(root, "missing"), join(root, path), "dir");
      expect(collectHealthReviewInputs(root)).toEqual(manifestOnlyInputs());
    },
  );

  it.each(["EACCES", "EIO"])(
    "propagates %s directory read errors instead of returning partial evidence",
    async (code) => {
      const root = tempRepo();
      const wave = join(root, "datasets/experiments/wave-x");
      mkdirSync(wave, { recursive: true });
      const error = Object.assign(new Error("cannot read directory"), { code });
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(readdirSync).mockImplementation((path, options) => {
        if (path === wave) throw error;
        return fs.readdirSync(path, options);
      });
      expect(() => collectHealthReviewInputs(root)).toThrow(error);
    },
  );

  it.each(["removed", "replaced with a file"])(
    "ignores a child directory %s after enumeration",
    async (change) => {
      const root = tempRepo();
      const experiments = join(root, "datasets/experiments");
      const wave = join(experiments, "wave-x");
      mkdirSync(wave, { recursive: true });
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      let changed = false;
      vi.mocked(readdirSync).mockImplementation((path, options) => {
        const entries = fs.readdirSync(path, options);
        if (path === experiments && !changed) {
          changed = true;
          rmSync(wave, { recursive: true });
          if (change === "replaced with a file") writeFileSync(wave, "{}");
        }
        return entries;
      });
      expect(collectHealthReviewInputs(root)).toEqual(manifestOnlyInputs());
      expect(changed).toBe(true);
    },
  );

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
