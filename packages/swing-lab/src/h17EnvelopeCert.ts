import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  evaluateCaptureEnvelope,
  measureClip,
  type CaptureEnvelopeMeasurements,
} from "@pickle/capture-envelope";
import { evaluateFrameAnalyzability, FRAME_ANALYZABILITY_VERSION } from "@pickle/vision-geometry";
import { preAnalysisGate, PRE_ANALYSIS_GATE_VERSION } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "./frameStats.js";

/**
 * Wave-H h17 envelope certification harness.
 *
 * For each probe clip, runs the two production-facing pose-free safety layers
 * exactly as their production callers compose them:
 *
 *  1. capture-envelope: measureClip → evaluateCaptureEnvelope (the verdict
 *     runCaptureAnalysis blocks on when overall === UNSUPPORTED);
 *  2. pre-analysis OOD gate: extractFrameStats → evaluateFrameAnalyzability →
 *     preAnalysisGate({frame, pose: null, poseQuality: null}) — pose-conditioned
 *     signals cannot run on Linux (Apple Vision is macOS/iOS-only) and are
 *     honestly reported in notEvaluated, never assumed to pass.
 *
 * The harness records verdicts only; it never fabricates pose, labels, or
 * downstream scores.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface H17Probe {
  id: string;
  category: string;
  path: string;
}

export interface H17Measurement {
  id: string;
  category: string;
  path: string;
  envelope: {
    overall: string;
    unsupportedDimensions: string[];
    degradedDimensions: string[];
    notMeasured: string[];
    measurements: CaptureEnvelopeMeasurements;
  } | null;
  envelopeError: string | null;
  frameAnalyzable: boolean;
  frameReasons: string[];
  gateOk: boolean;
  gateFailureKind: string | null;
  gateFailureCode: string | null;
  gateMessage: string | null;
  notEvaluated: string[];
}

export function measureH17Probe(probe: H17Probe): H17Measurement {
  const abs = probe.path.startsWith("/") ? probe.path : join(repoRoot, probe.path);
  let envelope: H17Measurement["envelope"] = null;
  let envelopeError: string | null = null;
  try {
    const measurements = measureClip(abs);
    const verdict = evaluateCaptureEnvelope(measurements);
    envelope = {
      overall: verdict.overall,
      unsupportedDimensions: verdict.dimensions
        .filter((d) => d.status === "UNSUPPORTED")
        .map((d) => d.dimension),
      degradedDimensions: verdict.dimensions
        .filter((d) => d.status === "DEGRADED")
        .map((d) => d.dimension),
      notMeasured: verdict.notMeasured,
      measurements,
    };
  } catch (error) {
    envelopeError = error instanceof Error ? error.message : String(error);
  }
  const stats = extractFrameStats(abs);
  const frame = evaluateFrameAnalyzability(stats);
  const gate = preAnalysisGate({ frame, pose: null, poseQuality: null });
  return {
    id: probe.id,
    category: probe.category,
    path: probe.path,
    envelope,
    envelopeError,
    frameAnalyzable: frame.analyzable,
    frameReasons: frame.reasons,
    gateOk: gate.ok,
    gateFailureKind: gate.ok ? null : gate.failure.kind,
    gateFailureCode: gate.ok ? null : gate.failure.code,
    gateMessage: gate.ok ? null : gate.failure.message,
    notEvaluated: gate.ok ? gate.value.notEvaluated : [],
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const mediaDir = process.argv[2];
  if (!mediaDir || !existsSync(mediaDir)) {
    console.error("usage: tsx src/h17EnvelopeCert.ts <media-dir> [out.json]");
    process.exit(2);
  }
  const probes: H17Probe[] = [
    { id: "black", category: "black_input", path: join(mediaDir, "black.mp4") },
    {
      id: "corrupt-truncated",
      category: "corrupt_input",
      path: join(mediaDir, "corrupt_truncated.mp4"),
    },
    {
      id: "corrupt-garbage",
      category: "corrupt_input",
      path: join(mediaDir, "corrupt_garbage.mp4"),
    },
    { id: "tiny-player", category: "tiny_player", path: join(mediaDir, "tiny_player.mp4") },
    { id: "cropped-limbs", category: "cropped_limbs", path: join(mediaDir, "cropped_limbs.mp4") },
    {
      id: "paddle-offscreen",
      category: "paddle_offscreen",
      path: join(mediaDir, "paddle_offscreen.mp4"),
    },
    { id: "dark-scene", category: "dark_scene", path: join(mediaDir, "dark_scene.mp4") },
    {
      id: "extreme-backlight",
      category: "extreme_backlight",
      path: join(mediaDir, "extreme_backlight.mp4"),
    },
    { id: "severe-blur", category: "severe_blur", path: join(mediaDir, "severe_blur.mp4") },
    {
      id: "multiple-players",
      category: "multiple_players",
      path: join(mediaDir, "multiple_players.mp4"),
    },
    {
      id: "camera-obstruction",
      category: "camera_obstruction",
      path: join(mediaDir, "camera_obstruction.mp4"),
    },
    { id: "ood-smpte", category: "non_pickleball_ood", path: join(mediaDir, "ood_smpte.mp4") },
    {
      id: "ood-real-tennis",
      category: "non_pickleball_ood",
      path: "datasets/ood/negatives/yt--wE27MoX2AM-tennis.mp4",
    },
    {
      id: "ood-real-badminton",
      category: "non_pickleball_ood",
      path: "datasets/ood/negatives/yt-Iw55LinAF0U-badminton.mp4",
    },
  ];
  const measurements = probes.map(measureH17Probe);
  const out = {
    workstream: "wave-h/h17-envelope-cert",
    measuredAt: new Date().toISOString(),
    environment:
      "Linux CPU; ffmpeg decode; pose extraction unavailable (Apple Vision is macOS/iOS-only) so pose-conditioned signals are notEvaluated by construction",
    thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    frameAnalyzabilityVersion: FRAME_ANALYZABILITY_VERSION,
    gateVersion: PRE_ANALYSIS_GATE_VERSION,
    measurements,
  };
  const dest = process.argv[3] ?? join(mediaDir, "h17-measurements.json");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.error(`wrote ${dest}`);
}
