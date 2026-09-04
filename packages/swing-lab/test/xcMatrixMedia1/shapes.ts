import { deriveSeed } from "./rng.js";

/**
 * Media-shape catalog for xc-matrix-media-1.
 *
 * Every axis value is a plain serializable literal so a failing cell's
 * `CellSpec` can be written to disk verbatim and replayed later with
 * `runCell(spec)`. Nothing here is a gold label: the shapes describe the
 * CONTAINER (resolution / frame rate / duration / trigger semantics), and the
 * body motion inside is the synthetic swing generator's deterministic
 * skeleton plus seeded sensor-style jitter.
 */

export interface ResolutionShape {
  id: string;
  width: number;
  height: number;
  /** Human-facing family tag used in the summary tables. */
  family: "tiny" | "small" | "hd" | "fhd" | "square" | "odd" | "huge" | "degenerate";
}

export const RESOLUTIONS: readonly ResolutionShape[] = [
  { id: "tiny_160x120", width: 160, height: 120, family: "tiny" },
  { id: "tiny_120x160", width: 120, height: 160, family: "tiny" },
  { id: "small_640x480", width: 640, height: 480, family: "small" },
  { id: "hd_1280x720", width: 1280, height: 720, family: "hd" },
  { id: "fhd_portrait_1080x1920", width: 1080, height: 1920, family: "fhd" },
  { id: "fhd_landscape_1920x1080", width: 1920, height: 1080, family: "fhd" },
  { id: "square_1080x1080", width: 1080, height: 1080, family: "square" },
  { id: "odd_wide_4to1_3840x960", width: 3840, height: 960, family: "odd" },
  { id: "odd_ultrawide_5to1_4000x800", width: 4000, height: 800, family: "odd" },
  { id: "odd_tall_1to5_800x4000", width: 800, height: 4000, family: "odd" },
  { id: "huge_8k_7680x4320", width: 7680, height: 4320, family: "huge" },
  { id: "huge_8k_portrait_4320x7680", width: 4320, height: 7680, family: "huge" },
];

/**
 * Degenerate containers that must be rejected by the pose-sequence parser
 * (`pose_sequence.invalid_video`) before any analysis can run. They are kept
 * separate from RESOLUTIONS so the main cross product only contains shapes a
 * real container can declare.
 */
export const DEGENERATE_RESOLUTIONS: readonly ResolutionShape[] = [
  { id: "degenerate_0x1080", width: 0, height: 1080, family: "degenerate" },
  { id: "degenerate_1080x0", width: 1080, height: 0, family: "degenerate" },
  { id: "degenerate_nan_width", width: Number.NaN, height: 1080, family: "degenerate" },
  { id: "degenerate_negative", width: -1920, height: 1080, family: "degenerate" },
];

export const FRAME_RATES: readonly number[] = [1, 5, 12, 15, 24, 30, 60, 120, 240];

export type DurationShape =
  { id: string; kind: "frames"; frames: number } | { id: string; kind: "ms"; ms: number };

export const DURATIONS: readonly DurationShape[] = [
  { id: "frames_1", kind: "frames", frames: 1 },
  { id: "frames_2", kind: "frames", frames: 2 },
  { id: "ms_300", kind: "ms", ms: 300 },
  { id: "ms_900", kind: "ms", ms: 900 },
  { id: "ms_1970_swing_only", kind: "ms", ms: 1970 },
  { id: "ms_10000", kind: "ms", ms: 10_000 },
  { id: "ms_95000_over_supported", kind: "ms", ms: 95_000 },
  { id: "ms_200000_over_degraded", kind: "ms", ms: 200_000 },
  { id: "ms_620000_over_frame_gate", kind: "ms", ms: 620_000 },
];

/**
 * How the analysis window is declared to `analyzeCapture`:
 * - `swing_window`: the trigger brackets the synthetic stroke (the live
 *   automatic_pose_trigger path).
 * - `full_clip`: the trigger is the whole clip with no peak hint (the
 *   imported-video path, `trigger.imported-full-clip`).
 */
export type TriggerMode = "swing_window" | "full_clip";
export const TRIGGER_MODES: readonly TriggerMode[] = ["swing_window", "full_clip"];

export interface CellSpec {
  cellId: string;
  masterSeed: number;
  seed: number;
  resolution: ResolutionShape;
  fps: number;
  duration: DurationShape;
  trigger: TriggerMode;
  handed: "right" | "left";
}

export type MatrixScale = "pr" | "full";

/**
 * The PR-tier subset keeps `pnpm --filter @pickle/swing-lab test` bounded;
 * the full tier is the adversarial run whose artifacts are uploaded.
 */
const PR_RESOLUTION_IDS = new Set([
  "tiny_160x120",
  "small_640x480",
  "fhd_portrait_1080x1920",
  "fhd_landscape_1920x1080",
  "square_1080x1080",
  "odd_ultrawide_5to1_4000x800",
  "huge_8k_7680x4320",
]);
const PR_FRAME_RATES = new Set([1, 12, 24, 30, 60, 240]);
const PR_DURATION_IDS = new Set([
  "frames_1",
  "frames_2",
  "ms_900",
  "ms_1970_swing_only",
  "ms_10000",
  "ms_95000_over_supported",
]);

export function enumerateCells(masterSeed: number, scale: MatrixScale): CellSpec[] {
  const resolutions =
    scale === "full" ? RESOLUTIONS : RESOLUTIONS.filter((r) => PR_RESOLUTION_IDS.has(r.id));
  const frameRates =
    scale === "full" ? FRAME_RATES : FRAME_RATES.filter((f) => PR_FRAME_RATES.has(f));
  const durations =
    scale === "full" ? DURATIONS : DURATIONS.filter((d) => PR_DURATION_IDS.has(d.id));
  const cells: CellSpec[] = [];
  for (const resolution of resolutions) {
    for (const fps of frameRates) {
      for (const duration of durations) {
        for (const trigger of TRIGGER_MODES) {
          cells.push(makeCell(masterSeed, resolution, fps, duration, trigger));
        }
      }
    }
  }
  return cells;
}

export function enumerateDegenerateCells(masterSeed: number): CellSpec[] {
  return DEGENERATE_RESOLUTIONS.map((resolution) =>
    makeCell(masterSeed, resolution, 30, DURATIONS[4]!, "swing_window"),
  );
}

export function makeCell(
  masterSeed: number,
  resolution: ResolutionShape,
  fps: number,
  duration: DurationShape,
  trigger: TriggerMode,
): CellSpec {
  const cellId = `${resolution.id}|fps_${fps}|${duration.id}|${trigger}`;
  const seed = deriveSeed(masterSeed, cellId);
  return {
    cellId,
    masterSeed,
    seed,
    resolution,
    fps,
    duration,
    trigger,
    // Handedness alternates deterministically from the seed so both mirror
    // paths are exercised without doubling the matrix.
    handed: seed % 2 === 0 ? "right" : "left",
  };
}
