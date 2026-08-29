import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFrameAnalyzability, FRAME_ANALYZABILITY_VERSION } from "@pickle/vision-geometry";
import { preAnalysisGate, PRE_ANALYSIS_GATE_VERSION } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "./frameStats.js";

/**
 * Wave-E OOD gate evaluation over the FULL datasets/ood corpus: the real
 * negatives in registry.items plus the derived/synthetic probes in
 * registry.derivedItems (still images, graphics, corrupt/truncated media,
 * extreme aspect ratios). Records pose-free verdicts per item; pose-conditioned
 * signals cannot run on Linux (Apple-Vision/macOS-only) and are honestly
 * reported in notEvaluated. Every negative the pose-free gate passes through
 * is a FINDING, recorded as such.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface RegistryEntry {
  id: string;
  role: string;
  category: string;
  path: string;
}

interface Measurement {
  id: string;
  role: string;
  category: string;
  path: string;
  frameCount: number;
  durationMs: number;
  frameAnalyzable: boolean;
  frameReasons: string[];
  gateOk: boolean;
  gateFailureKind: string | null;
  gateFailureCode: string | null;
  notEvaluated: string[];
}

export function measureOodCorpusWaveE(): Measurement[] {
  const registry = JSON.parse(
    readFileSync(join(repoRoot, "datasets", "ood", "registry.json"), "utf8"),
  ) as { items: RegistryEntry[]; derivedItems: { items: RegistryEntry[] } };
  const entries = [...registry.items, ...registry.derivedItems.items];
  return entries.map((item) => {
    const stats = extractFrameStats(join(repoRoot, item.path));
    const frame = evaluateFrameAnalyzability(stats);
    const gate = preAnalysisGate({ frame, pose: null, poseQuality: null });
    return {
      id: item.id,
      role: item.role,
      category: item.category,
      path: item.path,
      frameCount: stats.frameCount,
      durationMs: stats.durationMs,
      frameAnalyzable: frame.analyzable,
      frameReasons: frame.reasons,
      gateOk: gate.ok,
      gateFailureKind: gate.ok ? null : gate.failure.kind,
      gateFailureCode: gate.ok ? null : gate.failure.code,
      notEvaluated: gate.ok ? gate.value.notEvaluated : [],
    };
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const measurements = measureOodCorpusWaveE();
  const passedThrough = measurements.filter((m) => m.gateOk).map((m) => m.id);
  const out = {
    workstream: "wave-e/e11-ood-expansion",
    measuredAt: new Date().toISOString().slice(0, 10),
    environment:
      "Linux CPU; ffmpeg decode; pose extraction unavailable (Apple Vision is macOS-only) so pose-conditioned signals are notEvaluated by construction",
    frameAnalyzabilityVersion: FRAME_ANALYZABILITY_VERSION,
    gateVersion: PRE_ANALYSIS_GATE_VERSION,
    corpus: {
      realNegatives: measurements.filter((m) => m.role === "ood_negative").length,
      derivedNegatives: measurements.filter((m) => m.role === "ood_negative_derived").length,
    },
    measurements,
    findings: {
      poseFreePassedThrough: passedThrough,
      note: "Every id listed here is a negative that the pose-free signals alone would forward to analysis; rejecting these requires the pose-conditioned checks (macOS) or content-level signals that do not exist yet. Passing pose-free is NOT a confident-analysis verdict: pose_presence and pose_capture_quality remain notEvaluated.",
    },
  };
  const outDir = join(repoRoot, "datasets", "experiments", "wave-e");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "e11-ood-gate-measurements.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.warn(`wrote ${outPath}`);
  for (const m of measurements) {
    console.warn(
      `${m.id} [${m.category}] frameAnalyzable=${m.frameAnalyzable} reasons=[${m.frameReasons.join(",")}] gateOk=${m.gateOk}`,
    );
  }
}
