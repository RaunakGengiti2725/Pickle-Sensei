import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * F18 analysis over the degradation-ladder artifact: monotonicity checks,
 * band-crossing points, camera-motion separability, and the corpus-gap
 * arithmetic for predictive validation.
 *
 * Usage: pnpm --filter @pickle/capture-envelope eval:f18-analyze
 * Reads:  datasets/experiments/wave-f/f18-degradation-ladders.json
 * Writes: datasets/experiments/wave-f/f18-analysis.json
 */

export interface LadderRow {
  unitId: string;
  sessionKey: string;
  dimension: string;
  injected: number | null;
  measured: number | null;
  bandStatus: string;
}

/** True when values are strictly monotone in the given direction. */
export function isMonotone(values: number[], direction: "increasing" | "decreasing"): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    if (direction === "increasing" ? delta <= 0 : delta >= 0) return false;
  }
  return true;
}

/**
 * Rule of three: exact 95% one-sided upper confidence bound on an event
 * probability after n independent trials with zero events observed.
 */
export function ruleOfThreeUpperBound(n: number): number {
  if (n <= 0) return 1;
  return 1 - Math.pow(0.05, 1 / n);
}

/** Smallest n with zero observed events whose 95% upper bound ≤ target. */
export function trialsForUpperBound(target: number): number {
  return Math.ceil(Math.log(0.05) / Math.log(1 - target));
}

/**
 * First injected magnitude at which the band status differs from the
 * unit's control (injected=null) status; null when it never flips.
 */
export function firstBandFlip(rows: LadderRow[]): number | null {
  const control = rows.find((row) => row.injected === null);
  if (!control) return null;
  const steps = rows
    .filter((row) => row.injected !== null)
    .sort((a, b) => Math.abs(a.injected!) - Math.abs(b.injected!));
  for (const step of steps) {
    if (step.bandStatus !== control.bandStatus) return step.injected;
  }
  return null;
}

const isMain = process.argv[1]?.endsWith("f18Analysis.ts");
if (isMain) {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const outDir = join(repoRoot, "datasets", "experiments", "wave-f");
  const ladders = JSON.parse(
    readFileSync(join(outDir, "f18-degradation-ladders.json"), "utf8"),
  ) as { commit: string; thresholdsVersion: string; rows: LadderRow[] };

  const byUnitDim = new Map<string, LadderRow[]>();
  for (const row of ladders.rows) {
    const key = `${row.unitId}::${row.dimension}`;
    byUnitDim.set(key, [...(byUnitDim.get(key) ?? []), row]);
  }

  const units = [...new Set(ladders.rows.map((row) => row.unitId))];
  const sessions = [...new Set(ladders.rows.map((row) => row.sessionKey))];

  // Construct-validity checks per dimension.
  const dims = ["resolution", "frame_rate", "brightness", "motion_blur", "camera_motion"] as const;
  const construct: Record<string, unknown> = {};
  for (const dimension of dims) {
    const perUnit = units.map((unitId) => {
      const rows = (byUnitDim.get(`${unitId}::${dimension}`) ?? []).filter(
        (row) => row.measured !== null,
      );
      const steps = rows
        .filter((row) => row.injected !== null)
        .sort((a, b) => a.injected! - b.injected!);
      const exact =
        dimension === "resolution" || dimension === "frame_rate"
          ? steps.every((row) => Math.abs(row.measured! - row.injected!) < 0.05)
          : null;
      const monotone =
        dimension === "brightness"
          ? isMonotone(
              steps.map((row) => row.measured!),
              "increasing",
            )
          : dimension === "motion_blur"
            ? isMonotone(
                steps.map((row) => row.measured!),
                "decreasing",
              )
            : dimension === "camera_motion"
              ? isMonotone(
                  steps.map((row) => row.measured!),
                  "increasing",
                )
              : null;
      return { unitId, exact, monotone, firstBandFlip: firstBandFlip(rows) };
    });
    construct[dimension] = {
      unitsExactlyTracking: perUnit.filter((p) => p.exact === true).length,
      unitsMonotone: perUnit.filter((p) => p.monotone === true).length,
      unitsTotal: perUnit.length,
      perUnit,
    };
  }

  // Camera-motion separability: controls (zero injected camera motion,
  // subject motion only) vs injected amplitudes.
  const cmControls = ladders.rows.filter(
    (row) => row.dimension === "camera_motion" && row.injected === 0 && row.measured !== null,
  );
  const cmByAmplitude = new Map<number, number[]>();
  for (const row of ladders.rows) {
    if (row.dimension !== "camera_motion" || row.injected === null || row.measured === null)
      continue;
    cmByAmplitude.set(row.injected, [...(cmByAmplitude.get(row.injected) ?? []), row.measured]);
  }
  const controlValues = cmControls.map((row) => row.measured!).sort((a, b) => a - b);
  const controlMax = controlValues[controlValues.length - 1] ?? null;
  const separability = [...cmByAmplitude.entries()]
    .filter(([amplitude]) => amplitude > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([amplitude, values]) => ({
      amplitudePx320: amplitude,
      min: Math.min(...values),
      max: Math.max(...values),
      unitsBelowControlMax:
        controlMax === null ? null : values.filter((v) => v <= controlMax).length,
      unitsTotal: values.length,
    }));

  const gap = {
    labeledGoodUnits: 9,
    independentGoodSessions: 3,
    ruleOfThree95UpperBound: {
      unitLevel: Number(ruleOfThreeUpperBound(9).toFixed(4)),
      sessionLevel: Number(ruleOfThreeUpperBound(3).toFixed(4)),
    },
    unitsNeededForUpperBound: {
      "10pct": trialsForUpperBound(0.1),
      "5pct": trialsForUpperBound(0.05),
    },
    boundaryBinCoverage:
      "0 labeled units exist in any degraded/unsupported bin of any dimension (all labeled-good units: short side ≥720, fps ≥24, luma in supported band, laplacian ≥100, interval CV ≈ 0)",
  };

  const report = {
    experiment: "F18 analysis over f18-degradation-ladders.json",
    generatedBy: "packages/capture-envelope/src/f18Analysis.ts",
    sourceCommit: ladders.commit,
    thresholdsVersion: ladders.thresholdsVersion,
    unitCount: units.length,
    sessionCount: sessions.length,
    constructValidity: construct,
    cameraMotionSeparability: {
      controlValuesSubjectMotionOnly: controlValues,
      controlMax,
      injected: separability,
    },
    predictiveValidityGap: gap,
  };
  const outPath = join(outDir, "f18-analysis.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${outPath}\n`);
}
