import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { measureClip } from "./clipProbe.js";
import { classifyDimension, type CaptureEnvelopeMeasurements } from "./envelope.js";
import { CAPTURE_ENVELOPE_THRESHOLDS, CAPTURE_ENVELOPE_THRESHOLDS_VERSION } from "./thresholds.js";
import {
  F18_VALIDATION_CRITERIA,
  F18_VALIDATION_CRITERIA_VERSION,
} from "./f18ValidationCriteria.js";

/**
 * F18: controlled-degradation ladders over the downstream-GOOD units from
 * E15 — the discriminating experiment for CONSTRUCT validity of the
 * Linux-measurable envelope dimensions (see f18ValidationCriteria.ts).
 *
 * Ground truth here is known BY CONSTRUCTION (the injected degradation
 * magnitude), so no downstream analysis, labels, holdout cases, or
 * fresh-candidate clips are involved. Source units are exactly the E15
 * downstream-good units (label already published in
 * datasets/experiments/wave-e/e15-envelope-corpus-measurements-v0.3.json);
 * held-out cases were never in that set.
 *
 * Usage: pnpm --filter @pickle/capture-envelope eval:f18
 * Output: datasets/experiments/wave-f/f18-degradation-ladders.json
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = join(repoRoot, "datasets", "experiments", "wave-f");

const SHAKE_HZ = 1.5;
const SHAKE_MARGIN_320 = 20;

interface E15Unit {
  unitId: string;
  clip: string;
  sessionKey: string;
  window: { startMs: number; durationMs: number } | null;
  groundTruth: string;
  measurements: { frameWidthPx: number | null; frameHeightPx: number | null };
}

interface LadderStep {
  /** Injected ground truth, in the family's declared unit. */
  injected: number;
  filter: (unit: E15Unit, sourceWidth: number) => string;
}

interface LadderFamily {
  dimension: keyof typeof CAPTURE_ENVELOPE_THRESHOLDS;
  injectionUnit: string;
  /** Which measured field carries this family's signal. */
  measuredField: keyof CaptureEnvelopeMeasurements;
  steps: LadderStep[];
}

function shortSideScaleFilter(target: number): string {
  return `scale=if(gte(iw\\,ih)\\,-2\\,${target}):if(gte(iw\\,ih)\\,${target}\\,-2)`;
}

function shakeFilter(amplitude320: number, sourceWidth: number): string {
  const scale = sourceWidth / 320;
  const amplitude = amplitude320 * scale;
  const margin = Math.ceil(SHAKE_MARGIN_320 * scale);
  const x = `${margin}+${amplitude.toFixed(2)}*sin(2*PI*${SHAKE_HZ}*t)`;
  const y = `${margin}+${amplitude.toFixed(2)}*cos(2*PI*${SHAKE_HZ}*t)`;
  return `crop=iw-${2 * margin}:ih-${2 * margin}:${x}:${y}`;
}

export const F18_LADDER_FAMILIES: LadderFamily[] = [
  {
    dimension: "resolution",
    injectionUnit: "target short side px",
    measuredField: "frameHeightPx",
    steps: [720, 640, 480, 360, 240].map((target) => ({
      injected: target,
      filter: () => shortSideScaleFilter(target),
    })),
  },
  {
    dimension: "frame_rate",
    injectionUnit: "target fps",
    measuredField: "avgFrameRateFps",
    steps: [24, 20, 15, 12, 10, 8].map((target) => ({
      injected: target,
      filter: () => `fps=${target}`,
    })),
  },
  {
    dimension: "brightness",
    injectionUnit: "eq brightness shift (normalized, ≈shift·255 luma)",
    measuredField: "brightnessMeanLuma",
    steps: [-0.3, -0.2, -0.1, 0.1, 0.2, 0.3].map((shift) => ({
      injected: shift,
      filter: () => `eq=brightness=${shift}`,
    })),
  },
  {
    dimension: "motion_blur",
    injectionUnit: "gaussian sigma @320w",
    measuredField: "laplacianVarianceMedian",
    steps: [0.5, 1, 2, 4].map((sigma320) => ({
      injected: sigma320,
      filter: (_unit, sourceWidth) => `gblur=sigma=${((sigma320 * sourceWidth) / 320).toFixed(3)}`,
    })),
  },
  {
    dimension: "camera_motion",
    injectionUnit: "pan amplitude px @320w (sinusoidal, 1.5 Hz)",
    measuredField: "meanAbsFrameDiff",
    steps: [0, 1, 2, 4, 8, 16].map((amplitude320) => ({
      injected: amplitude320,
      filter: (_unit, sourceWidth) => shakeFilter(amplitude320, sourceWidth),
    })),
  },
];

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`${cmd} failed (${res.status}): ${res.stderr?.toString().slice(-2000)}`);
  }
}

export function loadE15GoodUnits(root: string): E15Unit[] {
  const e15 = JSON.parse(
    readFileSync(
      join(root, "datasets/experiments/wave-e/e15-envelope-corpus-measurements-v0.3.json"),
      "utf8",
    ),
  ) as { perUnit: E15Unit[] };
  return e15.perUnit.filter((unit) => unit.groundTruth === "GOOD");
}

const isMain = process.argv[1]?.endsWith("f18DegradationLadder.ts");
if (isMain) {
  const goodUnits = loadE15GoodUnits(repoRoot);
  const workDir = mkdtempSync(join(tmpdir(), "f18-ladders-"));
  const rows: Array<{
    unitId: string;
    sessionKey: string;
    dimension: string;
    injectionUnit: string;
    injected: number | null;
    measured: number | null;
    bandStatus: string;
    measurements: CaptureEnvelopeMeasurements;
  }> = [];

  try {
    for (const unit of goodUnits) {
      const clipPath = join(repoRoot, unit.clip);
      const windowArgs = unit.window
        ? [
            "-ss",
            (unit.window.startMs / 1000).toFixed(3),
            "-t",
            (unit.window.durationMs / 1000).toFixed(3),
          ]
        : [];
      // Common re-encoded control so codec effects are shared by every step.
      const basePath = join(workDir, `${unit.unitId.replace(/[^a-z0-9]+/gi, "-")}-base.mp4`);
      run("ffmpeg", [
        "-v",
        "error",
        "-y",
        ...windowArgs,
        "-i",
        clipPath,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        basePath,
      ]);
      const baseMeasurements = measureClip(basePath);
      const sourceWidth = baseMeasurements.frameWidthPx ?? 0;

      for (const family of F18_LADDER_FAMILIES) {
        const threshold = CAPTURE_ENVELOPE_THRESHOLDS[family.dimension];
        const controlValue =
          family.dimension === "resolution"
            ? Math.min(baseMeasurements.frameWidthPx ?? 0, baseMeasurements.frameHeightPx ?? 0)
            : (baseMeasurements[family.measuredField] as number | null);
        rows.push({
          unitId: unit.unitId,
          sessionKey: unit.sessionKey,
          dimension: family.dimension,
          injectionUnit: family.injectionUnit,
          injected: null,
          measured: controlValue,
          bandStatus: classifyDimension(controlValue, threshold),
          measurements: baseMeasurements,
        });
        for (const step of family.steps) {
          const variantPath = join(
            workDir,
            `${unit.unitId.replace(/[^a-z0-9]+/gi, "-")}-${family.dimension}-${step.injected}.mp4`,
          );
          run("ffmpeg", [
            "-v",
            "error",
            "-y",
            "-i",
            basePath,
            "-vf",
            step.filter(unit, sourceWidth),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            variantPath,
          ]);
          const measurements = measureClip(variantPath);
          const measured =
            family.dimension === "resolution"
              ? Math.min(measurements.frameWidthPx ?? 0, measurements.frameHeightPx ?? 0)
              : (measurements[family.measuredField] as number | null);
          rows.push({
            unitId: unit.unitId,
            sessionKey: unit.sessionKey,
            dimension: family.dimension,
            injectionUnit: family.injectionUnit,
            injected: step.injected,
            measured,
            bandStatus: classifyDimension(measured, threshold),
            measurements,
          });
          rmSync(variantPath, { force: true });
          process.stderr.write(
            `${unit.unitId} ${family.dimension} inj=${step.injected}: measured=${measured === null ? "null" : measured.toFixed(3)} ${rows[rows.length - 1]!.bandStatus}\n`,
          );
        }
      }
      rmSync(basePath, { force: true });
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const ffmpegVersion = execSync("ffmpeg -version").toString().split("\n")[0] ?? "unknown";
  const report = {
    experiment:
      "F18 controlled-degradation ladders: construct validity of Linux-measurable capture-envelope dimensions on E15 downstream-good units (ground truth by construction)",
    generatedBy: "packages/capture-envelope/src/f18DegradationLadder.ts",
    date: new Date().toISOString().slice(0, 10),
    commit: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
    thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    criteriaVersion: F18_VALIDATION_CRITERIA_VERSION,
    criteria: F18_VALIDATION_CRITERIA,
    method: {
      tooling: ffmpegVersion,
      sourceUnits:
        "the 9 E15 downstream-good units (7 corpus scenes from 2 DVIDS recordings, sha-verified re-downloads; 1 committed bundle clip); held-out cases and fresh-candidate clips never touched",
      control:
        "each unit re-encoded once (libx264 crf18) as the shared control; every ladder step derives from that control so codec effects cancel",
      grouping: "rows carry sessionKey (3 independent sessions); no random-frame splits",
    },
    rows,
  };
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "f18-degradation-ladders.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${outPath} (${rows.length} rows)\n`);
}
