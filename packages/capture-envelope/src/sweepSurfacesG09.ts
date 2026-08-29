import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EnvelopeDimension, EnvelopeStatus } from "@pickle/shared-types";
import { ENVELOPE_DIMENSIONS } from "@pickle/shared-types";
import {
  classifyDimension,
  evaluateCaptureEnvelope,
  type CaptureEnvelopeMeasurements,
} from "./envelope.js";
import { measureClip } from "./clipProbe.js";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  type DimensionThreshold,
} from "./thresholds.js";

/**
 * g09-f22-surfaces: property/counterfactual sweep of the capture-envelope
 * decision surfaces.
 *
 * Two layers:
 *  1. ANALYTIC surface — the pure evaluator (classifyDimension /
 *     evaluateCaptureEnvelope) swept along per-dimension worsening
 *     trajectories plus a full 3^9 severity lattice, checking that a
 *     strictly-worse measurement vector never yields a strictly-better
 *     verdict.
 *  2. VIDEO-LEVEL surface — parameterized ffmpeg-synthesized degradation
 *     sweeps (brightness, blur sigma, resolution, fps, camera tilt, crop,
 *     occlusion, player scale, player count, body visibility, paddle
 *     visibility) run end-to-end through the real measurement pipeline
 *     (clipProbe.measureClip), on a synthetic scene plus the two committed
 *     non-held-out real corpus clips. Along each axis every step is
 *     strictly worse capture than the previous one; any per-dimension or
 *     overall verdict IMPROVEMENT is a monotonicity violation and is
 *     recorded with its measured values.
 *
 * This maps the surface — it does NOT move it: no thresholds are changed.
 * Held-out cases wm-dink-01 and afn-vic-rally1 are never opened.
 *
 * Usage: pnpm --filter @pickle/capture-envelope exec tsx src/sweepSurfacesG09.ts
 * Output: datasets/experiments/wave-g/g09-f22-decision-surfaces.json
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = join(repoRoot, "datasets", "experiments", "wave-g");

const SEVERITY: Record<EnvelopeStatus, number> = {
  SUPPORTED: 0,
  DEGRADED: 1,
  UNSUPPORTED: 2,
  NOT_MEASURED: -1,
};

// ---------------------------------------------------------------------------
// Layer 1: analytic surface.

export interface AnalyticTrajectory {
  dimension: EnvelopeDimension;
  direction: string;
  /** Values ordered from best capture to strictly worse capture. */
  values: number[];
}

/**
 * Worsening trajectories per dimension (values straddle both band edges).
 * Order is strictly worse capture left→right by the dimension's semantics.
 */
export const ANALYTIC_TRAJECTORIES: AnalyticTrajectory[] = [
  {
    dimension: "resolution",
    direction: "shrinking short side",
    values: [1080, 720, 719, 480, 479, 240, 120],
  },
  {
    dimension: "frame_rate",
    direction: "dropping fps",
    values: [60, 30, 24, 23.9, 15, 14.9, 8, 2],
  },
  { dimension: "brightness", direction: "darkening", values: [130, 60, 59.9, 40, 39.9, 10, 0] },
  {
    dimension: "brightness",
    direction: "blowing out",
    values: [130, 200, 200.1, 220, 220.1, 245, 255],
  },
  {
    dimension: "motion_blur",
    direction: "increasing blur (falling laplacian variance)",
    values: [500, 100, 99.9, 30, 29.9, 5, 0],
  },
  {
    dimension: "camera_motion",
    direction: "increasing global motion",
    values: [5, 33, 33.1, 46, 46.1, 80, 200],
  },
  {
    dimension: "timing_stability",
    direction: "increasing interval jitter",
    values: [0.01, 0.15, 0.151, 0.35, 0.351, 1.0, 5.0],
  },
  {
    dimension: "clip_duration",
    direction: "shortening clip",
    values: [30_000, 2000, 1999, 1000, 999, 200],
  },
  {
    dimension: "clip_duration",
    direction: "overlong clip",
    values: [30_000, 90_000, 90_001, 180_000, 180_001, 400_000],
  },
  {
    dimension: "player_pixel_height",
    direction: "shrinking player",
    values: [0.5, 0.25, 0.249, 0.12, 0.119, 0.05, 0.01],
  },
  {
    dimension: "player_visibility",
    direction: "losing joint visibility",
    values: [0.9, 0.5, 0.49, 0.3, 0.29, 0.1, 0],
  },
];

export interface AnalyticTrajectoryResult {
  dimension: EnvelopeDimension;
  direction: string;
  statuses: EnvelopeStatus[];
  comparisons: number;
  violations: Array<{
    fromValue: number;
    toValue: number;
    from: EnvelopeStatus;
    to: EnvelopeStatus;
  }>;
}

export function runAnalyticTrajectories(): AnalyticTrajectoryResult[] {
  return ANALYTIC_TRAJECTORIES.map((traj) => {
    const threshold: DimensionThreshold = CAPTURE_ENVELOPE_THRESHOLDS[traj.dimension];
    const statuses = traj.values.map((value) => classifyDimension(value, threshold));
    const violations: AnalyticTrajectoryResult["violations"] = [];
    for (let index = 1; index < statuses.length; index += 1) {
      if (SEVERITY[statuses[index]!] < SEVERITY[statuses[index - 1]!]) {
        violations.push({
          fromValue: traj.values[index - 1]!,
          toValue: traj.values[index]!,
          from: statuses[index - 1]!,
          to: statuses[index]!,
        });
      }
    }
    return {
      dimension: traj.dimension,
      direction: traj.direction,
      statuses,
      comparisons: statuses.length - 1,
      violations,
    };
  });
}

/** Representative measured values at severity 0/1/2 per dimension. */
const LATTICE_VALUES: Record<EnvelopeDimension, [number, number, number]> = {
  resolution: [1080, 480, 240],
  frame_rate: [30, 15, 8],
  brightness: [130, 45, 10],
  motion_blur: [500, 50, 5],
  camera_motion: [5, 40, 80],
  timing_stability: [0.01, 0.25, 1.0],
  clip_duration: [30_000, 1500, 200],
  player_pixel_height: [0.5, 0.15, 0.05],
  player_visibility: [0.9, 0.4, 0.1],
};

function measurementsFromLevels(
  levels: Record<EnvelopeDimension, number>,
): CaptureEnvelopeMeasurements {
  const v = (d: EnvelopeDimension): number => LATTICE_VALUES[d][levels[d] as 0 | 1 | 2]!;
  return {
    frameWidthPx: v("resolution"),
    frameHeightPx: v("resolution"),
    avgFrameRateFps: v("frame_rate"),
    brightnessMeanLuma: v("brightness"),
    brightnessStdLuma: 5,
    laplacianVarianceMedian: v("motion_blur"),
    meanAbsFrameDiff: v("camera_motion"),
    frameIntervalCv: v("timing_stability"),
    clipDurationMs: v("clip_duration"),
    playerPixelHeightFraction: v("player_pixel_height"),
    playerMeanJointVisibility: v("player_visibility"),
  };
}

export interface LatticeResult {
  vectors: number;
  successorComparisons: number;
  overallMonotonicityViolations: number;
  overallEqualsMaxSeverityViolations: number;
  /** Structural (known, F22 A5): nulling the worst measured dim improves overall. */
  notMeasuredUpgradeCount: number;
  notMeasuredUpgradeChecked: number;
}

export function runLatticeSweep(): LatticeResult {
  const dims = [...ENVELOPE_DIMENSIONS];
  const total = 3 ** dims.length;
  let successorComparisons = 0;
  let overallMonotonicityViolations = 0;
  let overallEqualsMaxSeverityViolations = 0;
  let notMeasuredUpgradeCount = 0;
  let notMeasuredUpgradeChecked = 0;

  const levelsOf = (index: number): Record<EnvelopeDimension, number> => {
    const levels = {} as Record<EnvelopeDimension, number>;
    let rest = index;
    for (const dim of dims) {
      levels[dim] = rest % 3;
      rest = Math.floor(rest / 3);
    }
    return levels;
  };

  for (let index = 0; index < total; index += 1) {
    const levels = levelsOf(index);
    const verdict = evaluateCaptureEnvelope(measurementsFromLevels(levels));
    const maxSeverity = Math.max(...dims.map((dim) => levels[dim]));
    if (SEVERITY[verdict.overall] !== maxSeverity) overallEqualsMaxSeverityViolations += 1;

    for (const dim of dims) {
      if (levels[dim] >= 2) continue;
      const worse = { ...levels, [dim]: levels[dim] + 1 };
      const worseVerdict = evaluateCaptureEnvelope(measurementsFromLevels(worse));
      successorComparisons += 1;
      if (SEVERITY[worseVerdict.overall] < SEVERITY[verdict.overall]) {
        overallMonotonicityViolations += 1;
      }
    }

    // Structural NOT_MEASURED probe: only where a single dimension is the
    // unique worst — nulling it removes the evidence and the verdict upgrades.
    const worstDims = dims.filter((dim) => levels[dim] === maxSeverity);
    if (maxSeverity > 0 && worstDims.length === 1 && index % 27 === 0) {
      notMeasuredUpgradeChecked += 1;
      const m = measurementsFromLevels(levels);
      const nulled: CaptureEnvelopeMeasurements = { ...m };
      switch (worstDims[0]!) {
        case "resolution":
          nulled.frameWidthPx = null;
          nulled.frameHeightPx = null;
          break;
        case "frame_rate":
          nulled.avgFrameRateFps = null;
          break;
        case "brightness":
          nulled.brightnessMeanLuma = null;
          break;
        case "motion_blur":
          nulled.laplacianVarianceMedian = null;
          break;
        case "camera_motion":
          nulled.meanAbsFrameDiff = null;
          break;
        case "timing_stability":
          nulled.frameIntervalCv = null;
          break;
        case "clip_duration":
          nulled.clipDurationMs = null;
          break;
        case "player_pixel_height":
          nulled.playerPixelHeightFraction = null;
          break;
        case "player_visibility":
          nulled.playerMeanJointVisibility = null;
          break;
      }
      const nulledVerdict = evaluateCaptureEnvelope(nulled);
      if (SEVERITY[nulledVerdict.overall] < SEVERITY[verdict.overall]) {
        notMeasuredUpgradeCount += 1;
      }
    }
  }

  return {
    vectors: total,
    successorComparisons,
    overallMonotonicityViolations,
    overallEqualsMaxSeverityViolations,
    notMeasuredUpgradeCount,
    notMeasuredUpgradeChecked,
  };
}

// ---------------------------------------------------------------------------
// Layer 2: video-level sweeps.

const REAL_CLIPS: Record<string, string> = {
  "wm-volley-02": join(repoRoot, "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"),
  "afn-sasebo-rally1": join(repoRoot, "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4"),
};

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const ENCODE = [
  "-pix_fmt",
  "yuv420p",
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "18",
];

interface SyntheticSceneOptions {
  players: number;
  /** Player patch height as a fraction of frame height. */
  playerHeightFrac: number;
  /** Fraction of the player's body (from the top) left visible. */
  bodyVisibleFrac: number;
  paddle: boolean;
}

/**
 * Synthetic pickleball-shaped scene: frozen textured background + N moving
 * textured "player" patches (optionally truncated to simulate lost body
 * visibility), each with an optional small bright "paddle" patch moving
 * with it. Purely synthetic: no real players, used ONLY to drive the
 * video-measurable proxies; pose dimensions stay NOT_MEASURED on Linux.
 */
function makeSyntheticScene(path: string, opts: SyntheticSceneOptions): void {
  const W = 1280;
  const H = 720;
  const dur = 4;
  const rate = 30;
  const ph = Math.max(16, Math.round(H * opts.playerHeightFrac));
  const pw = Math.max(8, Math.round(ph * 0.4));
  const visH = Math.max(8, Math.round(ph * opts.bodyVisibleFrac));
  const inputs: string[] = [
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${W}x${H}:rate=${rate}:duration=${dur}`,
  ];
  let chain = `[0:v]select=eq(n\\,0),loop=loop=${dur * rate}:size=1:start=0,setpts=N/${rate}/TB[bg];`;
  let last = "bg";
  for (let p = 0; p < opts.players; p += 1) {
    inputs.push("-f", "lavfi", "-i", `testsrc2=size=${pw}x${ph}:rate=${rate}:duration=${dur}`);
    const idx = inputs.filter((a) => a === "-i").length - 1;
    const x0 = 160 + p * Math.floor((W - 400) / Math.max(1, opts.players));
    const amp = 80;
    const freq = 0.8 + p * 0.2;
    chain += `[${idx}:v]crop=${pw}:${visH}:0:0[pl${p}];`;
    chain += `[${last}][pl${p}]overlay=x='${x0}+${amp}*sin(2*PI*${freq}*t)':y=${Math.round(H * 0.55) - visH}[s${p}];`;
    last = `s${p}`;
    if (opts.paddle) {
      inputs.push(
        "-f",
        "lavfi",
        "-i",
        `color=c=white:size=${Math.max(6, Math.round(pw * 0.35))}x${Math.max(6, Math.round(ph * 0.12))}:rate=${rate}:duration=${dur}`,
      );
      const pidx = inputs.filter((a) => a === "-i").length - 1;
      chain += `[${last}][${pidx}:v]overlay=x='${x0 + pw}+${amp}*sin(2*PI*${freq}*t)':y='${Math.round(H * 0.55) - visH + Math.round(ph * 0.3)}+${Math.round(ph * 0.15)}*sin(2*PI*2.5*t)'[p${p}];`;
      last = `p${p}`;
    }
  }
  chain = chain.replace(new RegExp(`\\[${last}\\];$`), "");
  ffmpeg([...inputs, "-filter_complex", chain, ...ENCODE, "-t", String(dur), path]);
}

interface VideoStep {
  /** Axis parameter; null marks the control (re-encoded base). */
  param: number | null;
  label: string;
  vf: string | null;
}

interface VideoAxis {
  axis: string;
  worseDirection: string;
  /** Dimensions whose proxy this axis is designed to drive (may be empty = blindness axis). */
  targetDimensions: EnvelopeDimension[];
  appliesTo: "all" | "synthetic-only";
  steps: (srcW: number, srcH: number) => VideoStep[];
}

const VIDEO_AXES: VideoAxis[] = [
  {
    axis: "brightness-darken",
    worseDirection: "increasingly underexposed",
    targetDimensions: ["brightness"],
    appliesTo: "all",
    steps: () => [
      { param: null, label: "control", vf: null },
      ...[-0.1, -0.2, -0.3, -0.45].map((s) => ({
        param: s,
        label: `eq=${s}`,
        vf: `eq=brightness=${s}`,
      })),
    ],
  },
  {
    axis: "brightness-blowout",
    worseDirection: "increasingly overexposed",
    targetDimensions: ["brightness"],
    appliesTo: "all",
    steps: () => [
      { param: null, label: "control", vf: null },
      ...[0.1, 0.2, 0.3, 0.45].map((s) => ({
        param: s,
        label: `eq=+${s}`,
        vf: `eq=brightness=${s}`,
      })),
    ],
  },
  {
    axis: "blur-sigma",
    worseDirection: "increasing gaussian blur",
    targetDimensions: ["motion_blur"],
    appliesTo: "all",
    steps: (srcW) => [
      { param: null, label: "control", vf: null },
      ...[0.5, 1, 2, 4, 8].map((sigma320) => ({
        param: sigma320,
        label: `gblur@320w=${sigma320}`,
        vf: `gblur=sigma=${((sigma320 * srcW) / 320).toFixed(3)}`,
      })),
    ],
  },
  {
    axis: "resolution",
    worseDirection: "shrinking short side",
    targetDimensions: ["resolution"],
    appliesTo: "all",
    steps: () => [
      { param: null, label: "control", vf: null },
      ...[720, 640, 480, 360, 240].map((target) => ({
        param: target,
        label: `short=${target}`,
        vf: `scale=if(gte(iw\\,ih)\\,-2\\,${target}):if(gte(iw\\,ih)\\,${target}\\,-2)`,
      })),
    ],
  },
  {
    axis: "fps",
    worseDirection: "dropping frame rate",
    targetDimensions: ["frame_rate"],
    appliesTo: "all",
    steps: () => [
      { param: null, label: "control", vf: null },
      ...[24, 20, 15, 12, 10, 8].map((fps) => ({
        param: fps,
        label: `fps=${fps}`,
        vf: `fps=${fps}`,
      })),
    ],
  },
  {
    axis: "camera-tilt",
    worseDirection: "increasing camera tilt",
    targetDimensions: [],
    appliesTo: "all",
    steps: () => [
      { param: null, label: "control", vf: null },
      ...[2, 5, 10, 20, 45].map((deg) => ({
        param: deg,
        label: `tilt=${deg}deg`,
        vf: `rotate=${deg}*PI/180:fillcolor=black`,
      })),
    ],
  },
  {
    axis: "crop",
    worseDirection: "shrinking field of view",
    targetDimensions: ["resolution"],
    appliesTo: "all",
    steps: () => [
      { param: null, label: "control", vf: null },
      ...[0.9, 0.75, 0.5, 0.35].map((keep) => ({
        param: keep,
        label: `keep=${keep}`,
        vf: `crop=floor(iw*${keep}/2)*2:floor(ih*${keep}/2)*2`,
      })),
    ],
  },
  {
    axis: "occlusion",
    worseDirection: "growing static foreground occluder",
    targetDimensions: [],
    appliesTo: "all",
    steps: (srcW, srcH) => [
      { param: null, label: "control", vf: null },
      ...[0.1, 0.25, 0.5, 0.75].map((frac) => {
        const bw = Math.round(srcW * Math.sqrt(frac));
        const bh = Math.round(srcH * Math.sqrt(frac));
        return {
          param: frac,
          label: `occlude=${frac}`,
          vf: `drawbox=x=${Math.round((srcW - bw) / 2)}:y=${Math.round((srcH - bh) / 2)}:w=${bw}:h=${bh}:color=black:t=fill`,
        };
      }),
    ],
  },
];

interface SyntheticAxis {
  axis: string;
  worseDirection: string;
  targetDimensions: EnvelopeDimension[];
  variants: Array<{ param: number; label: string; opts: SyntheticSceneOptions }>;
}

const BASE_SCENE: SyntheticSceneOptions = {
  players: 1,
  playerHeightFrac: 0.35,
  bodyVisibleFrac: 1,
  paddle: true,
};

const SYNTHETIC_AXES: SyntheticAxis[] = [
  {
    axis: "player-scale",
    worseDirection: "shrinking player pixel height",
    targetDimensions: ["player_pixel_height"],
    variants: [0.5, 0.35, 0.25, 0.15, 0.08, 0.04].map((frac) => ({
      param: frac,
      label: `heightFrac=${frac}`,
      opts: { ...BASE_SCENE, playerHeightFrac: frac },
    })),
  },
  {
    axis: "body-visibility",
    worseDirection: "losing body below the frame",
    targetDimensions: ["player_visibility"],
    variants: [1, 0.75, 0.5, 0.25].map((frac) => ({
      param: frac,
      label: `visibleFrac=${frac}`,
      opts: { ...BASE_SCENE, bodyVisibleFrac: frac },
    })),
  },
  {
    axis: "paddle-visibility",
    worseDirection: "paddle leaves the frame",
    targetDimensions: [],
    variants: [1, 0].map((has) => ({
      param: has,
      label: has ? "paddle" : "no-paddle",
      opts: { ...BASE_SCENE, paddle: has === 1 },
    })),
  },
  {
    axis: "player-count",
    worseDirection: "more players (harder target acquisition)",
    targetDimensions: [],
    variants: [1, 2, 3, 4].map((n) => ({
      param: n,
      label: `players=${n}`,
      opts: { ...BASE_SCENE, players: n },
    })),
  },
];

export interface SweepRow {
  base: string;
  axis: string;
  param: number | null;
  label: string;
  measured: Record<string, number | null>;
  dimensionStatuses: Record<EnvelopeDimension, EnvelopeStatus>;
  overall: EnvelopeStatus;
}

export interface Violation {
  kind: "dimension" | "overall";
  base: string;
  axis: string;
  dimension: EnvelopeDimension | null;
  fromLabel: string;
  toLabel: string;
  from: EnvelopeStatus;
  to: EnvelopeStatus;
  fromMeasured: number | null;
  toMeasured: number | null;
}

function measuredSummary(m: CaptureEnvelopeMeasurements): Record<string, number | null> {
  return {
    shortSidePx:
      m.frameWidthPx !== null && m.frameHeightPx !== null
        ? Math.min(m.frameWidthPx, m.frameHeightPx)
        : null,
    avgFrameRateFps: m.avgFrameRateFps,
    brightnessMeanLuma: m.brightnessMeanLuma,
    laplacianVarianceMedian: m.laplacianVarianceMedian,
    meanAbsFrameDiff: m.meanAbsFrameDiff,
    frameIntervalCv: m.frameIntervalCv,
    clipDurationMs: m.clipDurationMs,
  };
}

function rowFromClip(
  base: string,
  axis: string,
  step: { param: number | null; label: string },
  clip: string,
): SweepRow {
  const m = measureClip(clip);
  const verdict = evaluateCaptureEnvelope(m);
  const statuses = {} as Record<EnvelopeDimension, EnvelopeStatus>;
  for (const d of verdict.dimensions) statuses[d.dimension] = d.status;
  return {
    base,
    axis,
    param: step.param,
    label: step.label,
    measured: measuredSummary(m),
    dimensionStatuses: statuses,
    overall: verdict.overall,
  };
}

const MEASURED_KEY_FOR_DIMENSION: Record<EnvelopeDimension, string> = {
  resolution: "shortSidePx",
  frame_rate: "avgFrameRateFps",
  brightness: "brightnessMeanLuma",
  motion_blur: "laplacianVarianceMedian",
  camera_motion: "meanAbsFrameDiff",
  timing_stability: "frameIntervalCv",
  clip_duration: "clipDurationMs",
  player_pixel_height: "shortSidePx",
  player_visibility: "shortSidePx",
};

/** Adjacent-step verdict-improvement detection along one worsening axis. */
export function findAxisViolations(rows: SweepRow[]): Violation[] {
  const violations: Violation[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1]!;
    const curr = rows[index]!;
    for (const dim of ENVELOPE_DIMENSIONS) {
      const from = prev.dimensionStatuses[dim];
      const to = curr.dimensionStatuses[dim];
      if (SEVERITY[from] >= 0 && SEVERITY[to] >= 0 && SEVERITY[to] < SEVERITY[from]) {
        const key = MEASURED_KEY_FOR_DIMENSION[dim];
        violations.push({
          kind: "dimension",
          base: curr.base,
          axis: curr.axis,
          dimension: dim,
          fromLabel: prev.label,
          toLabel: curr.label,
          from,
          to,
          fromMeasured: prev.measured[key] ?? null,
          toMeasured: curr.measured[key] ?? null,
        });
      }
    }
    if (SEVERITY[curr.overall] < SEVERITY[prev.overall]) {
      violations.push({
        kind: "overall",
        base: curr.base,
        axis: curr.axis,
        dimension: null,
        fromLabel: prev.label,
        toLabel: curr.label,
        from: prev.overall,
        to: curr.overall,
        fromMeasured: null,
        toMeasured: null,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Main.

const isMain = process.argv[1]?.endsWith("sweepSurfacesG09.ts");
if (isMain) {
  const workDir = mkdtempSync(join(tmpdir(), "g09-surfaces-"));
  const rows: SweepRow[] = [];
  const violations: Violation[] = [];
  let adjacentPairs = 0;

  const analytic = runAnalyticTrajectories();
  const lattice = runLatticeSweep();
  process.stderr.write(
    `analytic: ${analytic.reduce((a, t) => a + t.comparisons, 0)} comparisons, ` +
      `${analytic.reduce((a, t) => a + t.violations.length, 0)} violations; ` +
      `lattice: ${lattice.vectors} vectors, ${lattice.successorComparisons} successor comparisons, ` +
      `${lattice.overallMonotonicityViolations} overall violations\n`,
  );

  try {
    // Bases: synthetic scene + the two committed non-held-out real clips.
    const bases: Record<string, string> = {};
    const synthBase = join(workDir, "synthetic-base.mp4");
    makeSyntheticScene(synthBase, BASE_SCENE);
    bases["synthetic-scene"] = synthBase;
    for (const [id, src] of Object.entries(REAL_CLIPS)) {
      const reencoded = join(workDir, `${id}-base.mp4`);
      ffmpeg(["-i", src, ...ENCODE, reencoded]);
      bases[id] = reencoded;
    }

    for (const [baseId, basePath] of Object.entries(bases)) {
      const baseMeasure = measureClip(basePath);
      const srcW = baseMeasure.frameWidthPx ?? 1280;
      const srcH = baseMeasure.frameHeightPx ?? 720;
      for (const axis of VIDEO_AXES) {
        const axisRows: SweepRow[] = [];
        for (const step of axis.steps(srcW, srcH)) {
          let clip = basePath;
          if (step.vf !== null) {
            clip = join(workDir, "variant.mp4");
            ffmpeg(["-i", basePath, "-vf", step.vf, ...ENCODE, clip]);
          }
          const row = rowFromClip(baseId, axis.axis, step, clip);
          axisRows.push(row);
          process.stderr.write(`${baseId} ${axis.axis} ${step.label}: overall=${row.overall}\n`);
        }
        rows.push(...axisRows);
        adjacentPairs += axisRows.length - 1;
        violations.push(...findAxisViolations(axisRows));
      }
    }

    // Synthetic-only content axes (player scale/count, body/paddle visibility).
    for (const axis of SYNTHETIC_AXES) {
      const axisRows: SweepRow[] = [];
      for (const variant of axis.variants) {
        const clip = join(workDir, "synth-variant.mp4");
        makeSyntheticScene(clip, variant.opts);
        const row = rowFromClip("synthetic-scene", axis.axis, variant, clip);
        axisRows.push(row);
        process.stderr.write(`synthetic ${axis.axis} ${variant.label}: overall=${row.overall}\n`);
      }
      rows.push(...axisRows);
      adjacentPairs += axisRows.length - 1;
      violations.push(...findAxisViolations(axisRows));
    }

    // Cross-dimension counterfactuals: a capture that is already
    // camera-motion-degraded made STRICTLY WORSE (blur / darkening on top).
    // The frame-diff proxy is content-dependent, so blurring or darkening a
    // shaken clip can pull camera_motion back toward SUPPORTED — if the
    // overall verdict improves, a strictly-worse capture got a strictly
    // better verdict.
    const shakeVf = "crop=iw-96:ih-96:x='48+40*sin(n*1.7)':y='48+40*cos(n*2.3)',scale=1280:720";
    for (const baseId of ["afn-sasebo-rally1", "synthetic-scene"]) {
      const shaken = join(workDir, "shaken.mp4");
      ffmpeg(["-i", bases[baseId]!, "-vf", shakeVf, ...ENCODE, shaken]);
      for (const [family, mk] of [
        ["shake-plus-blur", (p: number) => `gblur=sigma=${(p * 4).toFixed(3)}`],
        ["shake-plus-darken", (p: number) => `eq=brightness=${(-0.15 * p).toFixed(3)}`],
      ] as const) {
        const axisRows: SweepRow[] = [
          rowFromClip(baseId, family, { param: null, label: "shaken-control" }, shaken),
        ];
        for (const p of [1, 2, 3]) {
          const clip = join(workDir, "cf-variant.mp4");
          ffmpeg(["-i", shaken, "-vf", mk(p), ...ENCODE, clip]);
          const row = rowFromClip(baseId, family, { param: p, label: `${family}=${p}` }, clip);
          axisRows.push(row);
          process.stderr.write(`${baseId} ${family} step=${p}: overall=${row.overall}\n`);
        }
        rows.push(...axisRows);
        adjacentPairs += axisRows.length - 1;
        violations.push(...findAxisViolations(axisRows));
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const ffmpegVersion = execSync("ffmpeg -version").toString().split("\n")[0] ?? "unknown";
  const report = {
    workstream: "g09-f22-surfaces",
    experiment:
      "Property/counterfactual sweep of the capture-envelope decision surfaces: analytic evaluator trajectories + 3^9 severity lattice + parameterized ffmpeg degradation sweeps through the real measurement pipeline",
    generatedBy: "packages/capture-envelope/src/sweepSurfacesG09.ts",
    date: new Date().toISOString(),
    commit: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
    thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    method: {
      tooling: ffmpegVersion,
      bases:
        "1 synthetic scene (frozen testsrc2 background + moving textured player patches) + 2 committed non-held-out real corpus clips (wm-volley-02, afn-sasebo-rally1), each re-encoded once (libx264 crf18) as shared control",
      holdout: "wm-dink-01 and afn-vic-rally1 never opened, read, or referenced by any sweep",
      monotonicityRule:
        "along each axis every step is strictly-worse capture than the previous; any measured dimension or overall verdict IMPROVEMENT between adjacent steps is a violation",
      noTuning: "no thresholds changed; this maps the surface without moving it",
    },
    analytic,
    lattice,
    videoRows: rows,
    videoViolations: violations,
    counts: {
      analyticComparisons: analytic.reduce((a, t) => a + t.comparisons, 0),
      analyticViolations: analytic.reduce((a, t) => a + t.violations.length, 0),
      videoRows: rows.length,
      videoAdjacentStepPairs: adjacentPairs,
      videoViolations: violations.length,
      videoDimensionViolations: violations.filter((v) => v.kind === "dimension").length,
      videoOverallViolations: violations.filter((v) => v.kind === "overall").length,
    },
  };
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "g09-f22-decision-surfaces.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    `wrote ${outPath} (${rows.length} video rows, ${violations.length} video violations)\n`,
  );
}
