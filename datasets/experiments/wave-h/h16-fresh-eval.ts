// H16 fresh-generalization certification — Stage 1 (LINUX-CPU, label-free).
//
// Runs the pose-free portions of the pre-analysis pipeline over every clip in
// the two never-tuned-against pools (registry freshCandidates label-blind
// holdout pool + devPool label-eligible pool): frame-analyzability +
// pre-analysis OOD gate, and the capture-envelope evaluator. Creates NO
// labels; records only mechanical measurements and gate verdicts.
//
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-h/h16-fresh-eval.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_VERSION,
} from "../../../packages/vision-geometry/src/index.js";
import {
  preAnalysisGate,
  PRE_ANALYSIS_GATE_VERSION,
} from "../../../packages/analysis-pipeline/src/index.js";
import { extractFrameStats } from "../../../packages/swing-lab/src/frameStats.js";
import {
  evaluateCaptureEnvelope,
  measureClip,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
} from "../../../packages/capture-envelope/src/index.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const OUT_DIR = join(ROOT, "datasets/experiments/wave-h");

interface RegistryItem {
  id: string;
  role: string;
  labelBlind: boolean;
  path: string;
  uploader?: string;
  uploaderChannelId?: string;
  media?: { clipDurationSeconds?: number; clipFps?: number; clipWidth?: number };
}

const registry = JSON.parse(
  readFileSync(join(ROOT, "datasets/pickleball/registry.json"), "utf8"),
) as {
  freshCandidates: { items: RegistryItem[] };
  devPool: { items: RegistryItem[] };
};

const items = [...registry.freshCandidates.items, ...registry.devPool.items];

const rows = items.map((item) => {
  const clipPath = join(ROOT, item.path);
  const stats = extractFrameStats(clipPath);
  const frame = evaluateFrameAnalyzability(stats);
  const gate = preAnalysisGate({ frame, pose: null, poseQuality: null });
  const gateFailure = gate.ok ? null : { code: gate.failure.code, message: gate.failure.message };
  const envelopeMeasurements = measureClip(clipPath);
  const envelope = evaluateCaptureEnvelope(envelopeMeasurements);
  return {
    id: item.id,
    role: item.role,
    labelBlind: item.labelBlind,
    session: item.uploaderChannelId ?? item.uploader ?? "unknown",
    durationSeconds: item.media?.clipDurationSeconds ?? null,
    fps: item.media?.clipFps ?? null,
    frameAnalyzable: frame.analyzable,
    frameReasons: frame.reasons,
    gateOk: gate.ok,
    gateFailure,
    envelopeOverall: envelope.overall,
    envelopeDimensions: envelope.dimensions
      .filter((d) => d.status !== "SUPPORTED")
      .map((d) => ({ dimension: d.dimension, status: d.status, measured: d.measured })),
  };
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "h16-stage1-posefree-gates.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      platform: "LINUX-CPU",
      versions: {
        frameAnalyzability: FRAME_ANALYZABILITY_VERSION,
        preAnalysisGate: PRE_ANALYSIS_GATE_VERSION,
        captureEnvelopeThresholds: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
      },
      labelsCreated: 0,
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(rows, null, 1));
