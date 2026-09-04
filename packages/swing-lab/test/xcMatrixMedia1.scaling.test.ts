import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCell } from "./xcMatrixMedia1/runCell.js";
import { makeCell, RESOLUTIONS, type DurationShape } from "./xcMatrixMedia1/shapes.js";

/**
 * xc-matrix-media-1 scaling probe: `analyzeCapture` wall time and heap as a
 * function of the number of pose frames inside the trigger window, holding
 * everything else fixed (1280×720, 60 fps, full-clip trigger — the imported-
 * video path). The full clip is what `trigger.imported-full-clip` hands to
 * phase segmentation, so this is the shape that scales with clip length.
 *
 * The probe asserts only the completion contract (typed outcome, no throw)
 * and RECORDS the timing; the fitted log–log exponent is written to
 * scaling.json for the report. A bounded frame count keeps the probe inside
 * the pr-tier budget.
 *
 * Knobs: XC_MATRIX_SEED, XC_MATRIX_OUT (same as the matrix), and
 *   XC_MATRIX_SCALING_MAX_FRAMES (default 8000; 16000 for the full run).
 */

const MASTER_SEED = Number.parseInt(process.env.XC_MATRIX_SEED ?? "20260904", 10) >>> 0;
const MAX_FRAMES = Number.parseInt(process.env.XC_MATRIX_SCALING_MAX_FRAMES ?? "8000", 10);
const OUT_DIR = resolve(
  process.env.XC_MATRIX_OUT ??
    resolve(import.meta.dirname, "../../../artifacts/xc-matrix-media-1", `scaling-${MASTER_SEED}`),
);
const FPS = 60;
const FRAME_COUNTS = [250, 500, 1000, 2000, 4000, 8000, 16000].filter((n) => n <= MAX_FRAMES);
const HD = RESOLUTIONS.find((r) => r.id === "hd_1280x720")!;

interface ScalingRow {
  targetFrames: number;
  windowFrames: number;
  clipDurationMs: number;
  outcome: string;
  failureCode: string | null;
  fusionMs: number;
  heapUsedDeltaBytes: number;
  rssAfterBytes: number;
  sidecarBytes: number;
}

/** Least-squares slope of log(fusionMs) against log(windowFrames). */
function logLogSlope(rows: ScalingRow[]): number | null {
  const pts = rows
    .filter((r) => r.fusionMs > 0 && r.windowFrames > 0)
    .map((r) => [Math.log(r.windowFrames), Math.log(r.fusionMs)] as const);
  if (pts.length < 3) return null;
  const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
  const my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  return den === 0 ? null : num / den;
}

describe(`xc-matrix-media-1 scaling probe (seed ${MASTER_SEED}, ≤${MAX_FRAMES} frames)`, () => {
  it(
    "analyzeCapture completes with a typed outcome at every clip length and its cost is recorded",
    async () => {
      const rows: ScalingRow[] = [];
      for (const targetFrames of FRAME_COUNTS) {
        const duration: DurationShape = {
          id: `scaling_${targetFrames}f`,
          kind: "ms",
          ms: Math.round(((targetFrames - 1) * 1000) / FPS),
        };
        const spec = makeCell(MASTER_SEED, HD, FPS, duration, "full_clip");
        const result = await runCell(spec, {
          fusionFrameBudget: Number.MAX_SAFE_INTEGER,
          determinismFrameBudget: 0,
        });
        expect(result.fusion.outcome, spec.cellId).not.toBe("threw");
        expect(result.fusion.outcome, spec.cellId).not.toBe("not_run");
        expect(result.violations, spec.cellId).toEqual([]);
        rows.push({
          targetFrames,
          windowFrames: result.fusion.windowFrames,
          clipDurationMs: result.input.clipDurationMs,
          outcome: result.fusion.outcome,
          failureCode: result.fusion.failure?.code ?? null,
          fusionMs: Number(result.fusion.durationMs.toFixed(1)),
          heapUsedDeltaBytes: result.fusion.heapUsedDeltaBytes,
          rssAfterBytes: result.fusion.rssAfterBytes,
          sidecarBytes: result.input.sidecarBytes,
        });
        await new Promise<void>((done) => setImmediate(done));
      }
      const slope = logLogSlope(rows);
      mkdirSync(OUT_DIR, { recursive: true });
      const path = resolve(OUT_DIR, "scaling.json");
      writeFileSync(
        path,
        JSON.stringify(
          {
            masterSeed: MASTER_SEED,
            resolution: HD,
            fps: FPS,
            trigger: "full_clip",
            node: process.version,
            logLogSlope: slope,
            rows,
          },
          null,
          2,
        ),
      );
      process.stderr.write(
        `[xc-matrix-media-1 scaling] ${rows
          .map((r) => `${r.windowFrames}f=${r.fusionMs}ms`)
          .join(" ")} slope=${slope?.toFixed(2) ?? "n/a"} → ${path}\n`,
      );
      expect(rows.length).toBe(FRAME_COUNTS.length);
    },
    60 * 60 * 1000,
  );
});
