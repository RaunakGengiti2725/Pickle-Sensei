import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { preAnalysisGate } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "./frameStats.js";

/**
 * Measures the pre-analysis OOD gate's pose-FREE signals over every committed
 * real negative in datasets/ood/registry.json and records the verdicts.
 * Pose-conditioned signals (no_person_found, person_implausible_scale) cannot
 * run here: pose extraction is Apple-Vision/macOS-only, so pose is passed as
 * null and the gate honestly reports it in notEvaluated. Every negative the
 * pose-free gate passes through is a FINDING, recorded as such.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface RegistryItem {
  id: string;
  category: string;
  path: string;
}

interface Measurement {
  id: string;
  category: string;
  path: string;
  frameCount: number;
  durationMs: number;
  meanInterFrameDiff: number | null;
  medianInterFrameDiff: number;
  meanSpatialLumaStd: number | null;
  medianSpatialLumaStd: number;
  letterboxRowFraction: number;
  frameAnalyzable: boolean;
  frameReasons: string[];
  gateOk: boolean;
  gateFailureKind: string | null;
  gateFailureCode: string | null;
  notEvaluated: string[];
  poseFreeDetectable: boolean;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function measureOodNegatives(): Measurement[] {
  const registry = JSON.parse(
    readFileSync(join(repoRoot, "datasets", "ood", "registry.json"), "utf8"),
  ) as { items: RegistryItem[] };
  return registry.items.map((item) => {
    const stats = extractFrameStats(join(repoRoot, item.path));
    const frame = evaluateFrameAnalyzability(stats);
    const gate = preAnalysisGate({ frame, pose: null, poseQuality: null });
    return {
      id: item.id,
      category: item.category,
      path: item.path,
      frameCount: stats.frameCount,
      durationMs: stats.durationMs,
      meanInterFrameDiff: mean(stats.interFrameDiffs),
      medianInterFrameDiff: frame.stats.medianInterFrameDiff,
      meanSpatialLumaStd: mean(stats.spatialLumaStd),
      medianSpatialLumaStd: frame.stats.medianSpatialLumaStd,
      letterboxRowFraction: stats.letterboxRowFraction,
      frameAnalyzable: frame.analyzable,
      frameReasons: frame.reasons,
      gateOk: gate.ok,
      gateFailureKind: gate.ok ? null : gate.failure.kind,
      gateFailureCode: gate.ok ? null : gate.failure.code,
      notEvaluated: gate.ok ? gate.value.notEvaluated : [],
      poseFreeDetectable: !frame.analyzable,
    };
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const measurements = measureOodNegatives();
  const passedThrough = measurements.filter((m) => m.gateOk).map((m) => m.id);
  const out = {
    workstream: "wave-d/d08-ood-corpus",
    measuredAt: new Date().toISOString().slice(0, 10),
    environment:
      "Linux CPU; ffmpeg decode; pose extraction unavailable (Apple Vision is macOS-only) so pose-conditioned signals are notEvaluated by construction",
    gateVersion: "pre-analysis-gate-1",
    measurements,
    findings: {
      poseFreePassedThrough: passedThrough,
      note: "Every id listed here is a real negative that the pose-free signals alone would forward to analysis; rejecting these requires the pose-conditioned checks (macOS) or content-level signals that do not exist yet.",
    },
    additionalFinding: {
      stillImageVideoOverTrigger: measurements
        .filter((m) => m.frameReasons.includes("still_image_video") && m.frameCount > 100)
        .map((m) => ({ id: m.id, medianInterFrameDiff: m.medianInterFrameDiff })),
      note: "still_image_video (median inter-frame diff <= 0.5 at 64x36 grayscale) fires on REAL moving footage shot from fixed distant cameras. These negatives are rejected, but for a reason that conflates low-motion real video with stills; real pickleball footage from similar fixed distant cameras could be rejected the same way. Thresholds NOT changed; reported as a finding.",
    },
  };
  const outPath = join(repoRoot, "datasets", "experiments", "wave-d", "d08-ood-measurements.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  for (const m of measurements) {
    console.log(
      `${m.id} [${m.category}] frameAnalyzable=${m.frameAnalyzable} reasons=[${m.frameReasons.join(",")}] gateOk=${m.gateOk}`,
    );
  }
}
