import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, runCell, type CellResult } from "./xcMatrixMedia1/runCell.js";
import { summarize, writeArtifacts } from "./xcMatrixMedia1/report.js";
import {
  enumerateCells,
  enumerateDegenerateCells,
  type CellSpec,
  type MatrixScale,
} from "./xcMatrixMedia1/shapes.js";

/**
 * xc-matrix-media-1 — media-shape scenario matrix through the Linux-runnable
 * capture → analysis path (`@pickle/capture-envelope`, `@pickle/vision-geometry`
 * gates, `@pickle/analysis-pipeline`).
 *
 * Contract under test: every synthetic capture, whatever its container shape,
 * ends in exactly one of {complete scored record, explicit abstention,
 * typed failure}. A scored record must be internally complete; an abstention
 * must be explained; a failure must be typed. Nothing may throw. Cells whose
 * trigger window exceeds the per-scale frame budget are recorded as
 * `not_run` (counted, never a pass).
 *
 * Knobs (all optional, all deterministic):
 *   XC_MATRIX_SCALE=pr|full        default pr (bounded for `pnpm test`)
 *   XC_MATRIX_SEED=<uint32>        default 20260904
 *   XC_MATRIX_OUT=<dir>            default artifacts/xc-matrix-media-1/<scale>-<seed>
 *   XC_MATRIX_SHARD=<i>/<n>        run cells with index % n === i, write to
 *                                  <out>/shards/<i>-of-<n>/ (merge with
 *                                  xcMatrixMedia1/mergeShards.ts)
 *   XC_MATRIX_REPLAY_CELL=<cellId> run one cell only (from violations.json)
 *   XC_MATRIX_REPLAY_SPEC=<path>   run one serialized CellSpec JSON file
 */

const SCALE: MatrixScale = process.env.XC_MATRIX_SCALE === "full" ? "full" : "pr";
const MASTER_SEED = Number.parseInt(process.env.XC_MATRIX_SEED ?? "20260904", 10) >>> 0;
const BUDGET = DEFAULT_BUDGET[SCALE];
const BASE_OUT_DIR = resolve(
  process.env.XC_MATRIX_OUT ??
    resolve(import.meta.dirname, "../../../artifacts/xc-matrix-media-1", `${SCALE}-${MASTER_SEED}`),
);
const SHARD = parseShard(process.env.XC_MATRIX_SHARD);
const OUT_DIR = SHARD
  ? resolve(BASE_OUT_DIR, "shards", `${SHARD.index}-of-${SHARD.count}`)
  : BASE_OUT_DIR;
const REPLAY_CELL = process.env.XC_MATRIX_REPLAY_CELL;
const REPLAY_SPEC = process.env.XC_MATRIX_REPLAY_SPEC;
const NO_TIMEOUT = 6 * 60 * 60 * 1000;

function parseShard(raw: string | undefined): { index: number; count: number } | null {
  if (raw === undefined) return null;
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (!match) throw new Error(`XC_MATRIX_SHARD must look like "<i>/<n>", got "${raw}"`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 0 || index >= count) {
    throw new Error(`XC_MATRIX_SHARD out of range: ${raw}`);
  }
  return { index, count };
}

function shardOf<T>(items: T[]): T[] {
  if (!SHARD) return items;
  return items.filter((_, i) => i % SHARD.count === SHARD.index);
}

// Phase spans are the one invariant family asserted on its own so that a
// segmenter edge overrun is attributable to exactly one test.
const SPAN_BOUND_INVARIANTS: ReadonlySet<string> = new Set([
  "phases_inside_trigger_window",
  "phases_inside_clip",
]);

function describeViolations(results: CellResult[]): string {
  return results
    .filter((r) => r.violations.length > 0)
    .slice(0, 25)
    .map(
      (r) =>
        `${r.spec.cellId} (seed ${r.spec.seed}): ${r.violations
          .map((v) => `${v.invariant} — ${v.detail}`)
          .join("; ")}`,
    )
    .join("\n");
}

async function runAll(specs: CellSpec[]): Promise<CellResult[]> {
  const results: CellResult[] = [];
  for (const spec of specs) {
    results.push(await runCell(spec, BUDGET));
    // Let the worker's RPC channel breathe between long synchronous cells.
    await new Promise<void>((done) => setImmediate(done));
  }
  return results;
}

const replaying = REPLAY_CELL !== undefined || REPLAY_SPEC !== undefined;

describe.skipIf(replaying)(
  `xc-matrix-media-1 (${SCALE}, seed ${MASTER_SEED}${SHARD ? `, shard ${SHARD.index}/${SHARD.count}` : ""})`,
  () => {
    const specs = shardOf(enumerateCells(MASTER_SEED, SCALE));
    // Degenerate containers are cheap; every shard runs them so each shard's
    // artifact set is self-contained.
    const degenerateSpecs = enumerateDegenerateCells(MASTER_SEED);
    let results: CellResult[] = [];
    let degenerate: CellResult[] = [];

    it(
      "every cell completes, abstains explicitly, or fails with a typed failure — never partially",
      async () => {
        const startedAtIso = new Date().toISOString();
        const started = performance.now();
        results = await runAll(specs);
        degenerate = await runAll(degenerateSpecs);
        const summary = summarize(results, degenerate, {
          masterSeed: MASTER_SEED,
          scale: SCALE,
          startedAtIso,
          finishedAtIso: new Date().toISOString(),
          wallClockMs: performance.now() - started,
        });
        const paths = writeArtifacts(OUT_DIR, summary, results, degenerate);
        process.stderr.write(
          `[xc-matrix-media-1] ${summary.cells} cells + ${summary.degenerateCells} degenerate, ` +
            `${summary.notRun.length} not_run (budget), ${summary.violatingCells} violating → ${paths.summaryPath}\n`,
        );
        const outsideSpanBounds = [...results, ...degenerate].filter((r) =>
          r.violations.some((v) => !SPAN_BOUND_INVARIANTS.has(v.invariant)),
        );
        expect(
          outsideSpanBounds.length,
          `invariant violations (replay bundles in ${paths.violationsPath}):\n${describeViolations(
            outsideSpanBounds,
          )}`,
        ).toBe(0);
      },
      NO_TIMEOUT,
    );

    it("every phase span of a scored record lies inside the trigger window and the clip", () => {
      expect(results.length).toBeGreaterThan(0);
      const overrun = [...results, ...degenerate].filter((r) =>
        r.violations.some((v) => SPAN_BOUND_INVARIANTS.has(v.invariant)),
      );
      expect(
        overrun.map((r) => r.spec.cellId),
        describeViolations(overrun),
      ).toEqual([]);
    });

    it("nothing throws, and every skipped fusion names the budget it exceeded", () => {
      expect(results.length).toBeGreaterThan(0);
      expect(results.filter((r) => r.fusion.outcome === "threw").map((r) => r.spec.cellId)).toEqual(
        [],
      );
      for (const r of results) {
        if (r.fusion.outcome === "not_run") {
          expect(r.fusion.skipped, r.spec.cellId).toMatch(/^over_fusion_frame_budget\(\d+>\d+\)$/);
          expect(r.fusion.windowFrames, r.spec.cellId).toBeGreaterThan(BUDGET.fusionFrameBudget);
        } else {
          expect(r.fusion.skipped, r.spec.cellId).toBeNull();
          expect(r.fusion.windowFrames, r.spec.cellId).toBeLessThanOrEqual(
            BUDGET.fusionFrameBudget,
          );
        }
      }
    });

    it.skipIf(SHARD !== null)(
      "the matrix is not degenerate: it produces scored, failed and gate-refused cells",
      () => {
        const outcomes = new Set(results.map((r) => r.fusion.outcome));
        expect(outcomes.has("scored")).toBe(true);
        expect(outcomes.has("failed")).toBe(true);
        expect(results.some((r) => !r.preGate.ok)).toBe(true);
        expect(results.some((r) => r.envelope.mobileWouldBlock)).toBe(true);
        expect(results.some((r) => r.envelope.overall !== "UNSUPPORTED")).toBe(true);
      },
    );

    it("degenerate containers (0 / NaN / negative dimensions) are rejected by the sidecar parser", () => {
      expect(degenerate.length).toBeGreaterThan(0);
      for (const r of degenerate) {
        expect(r.sidecar.ok, r.spec.cellId).toBe(false);
        expect(r.sidecar.failure?.kind, r.spec.cellId).toBe("corrupted_media");
        // analyzeCapture is still run on the in-memory sequence to record what
        // the package does with a container the parser refused (it trusts its
        // typed input; see summary.gateCrossTab.scoredOnParserRejectedInput).
        // Guided path checks the envelope before the sidecar; either way no rating.
        expect(r.delivery.guided, r.spec.cellId).toBe(
          r.envelope.mobileWouldBlock ? "quality_blocked" : "unavailable",
        );
      }
    });

    it("sub-swing clips (1 frame, 2 frames, 300 ms) never score and are named by a measured gate", () => {
      const tooShort = results.filter(
        (r) =>
          r.spec.duration.kind === "frames" ||
          (r.spec.duration.kind === "ms" && r.spec.duration.ms < 500),
      );
      if (SHARD === null) expect(tooShort.length).toBeGreaterThan(0);
      for (const r of tooShort) {
        expect(r.fusion.outcome, r.spec.cellId).not.toBe("scored");
        expect(r.fusion.outcome, r.spec.cellId).not.toBe("not_run");
        expect(!r.preGate.ok || !r.poseQuality.analyzable, r.spec.cellId).toBe(true);
      }
    });

    it("below-minimum frame rates are named by the pose-quality gate; below-degraded ones block the guided path", () => {
      const slow = results.filter((r) => r.spec.fps < 24 && r.input.poseFrameCount >= 2);
      if (SHARD === null) expect(slow.length).toBeGreaterThan(0);
      for (const r of slow) {
        expect(r.poseQuality.analyzable, r.spec.cellId).toBe(false);
        expect(r.poseQuality.reasons.length, r.spec.cellId).toBeGreaterThan(0);
        if (r.spec.fps < 15) {
          expect(r.envelope.unsupported, r.spec.cellId).toContain("frame_rate");
          expect(r.delivery.guided, r.spec.cellId).toBe("quality_blocked");
        } else {
          expect(r.envelope.degraded, r.spec.cellId).toContain("frame_rate");
        }
      }
    });

    it("beyond-4:1 aspect containers are refused by the frame gate and the composite pre-analysis gate", () => {
      const odd = results.filter((r) => {
        const a = r.spec.resolution.width / r.spec.resolution.height;
        return a > 4 || a < 0.25;
      });
      if (SHARD === null) expect(odd.length).toBeGreaterThan(0);
      for (const r of odd) {
        expect(r.frameGate.reasons, r.spec.cellId).toContain("implausible_aspect_ratio");
        expect(r.preGate.ok, r.spec.cellId).toBe(false);
        expect(r.preGate.failure?.kind, r.spec.cellId).toBe("corrupted_media");
      }
    });

    it("the envelope UNSUPPORTED block is the only shape gate on the guided path; imports have none", () => {
      for (const r of results) {
        if (r.envelope.overall === "UNSUPPORTED") {
          expect(r.delivery.guided, r.spec.cellId).toBe("quality_blocked");
        } else if (r.sidecar.ok) {
          // Guided delivery follows the fusion outcome exactly: no other gate
          // between the envelope and analyzeCapture exists on that path.
          expect(r.delivery.guided, r.spec.cellId).not.toBe("quality_blocked");
        }
        if (r.spec.trigger === "full_clip" && r.sidecar.ok) {
          expect(r.delivery.imported, r.spec.cellId).not.toBe("quality_blocked");
        }
      }
    });
  },
);

describe.skipIf(!replaying)("xc-matrix-media-1 replay", () => {
  it(
    "replays one cell from its serialized spec and reports its invariants",
    async () => {
      let spec: CellSpec | undefined;
      if (REPLAY_SPEC !== undefined) {
        expect(existsSync(REPLAY_SPEC), REPLAY_SPEC).toBe(true);
        spec = JSON.parse(readFileSync(REPLAY_SPEC, "utf8")) as CellSpec;
      } else {
        spec = [
          ...enumerateCells(MASTER_SEED, "full"),
          ...enumerateDegenerateCells(MASTER_SEED),
        ].find((s) => s.cellId === REPLAY_CELL);
      }
      expect(spec, `cell ${String(REPLAY_CELL)} not found for seed ${MASTER_SEED}`).toBeDefined();
      if (!spec) return;
      const result = await runCell(spec, DEFAULT_BUDGET.full);
      process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
      expect(result.violations, describeViolations([result])).toEqual([]);
    },
    NO_TIMEOUT,
  );
});
