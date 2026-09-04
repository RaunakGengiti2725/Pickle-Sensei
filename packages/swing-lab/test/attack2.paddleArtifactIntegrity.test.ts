import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mergePaddleDetectionFiles, planTwoPassSchedule } from "../src/paddleSchedule.js";
import { buildPaddleTracks, type RawPaddleDetectionFile } from "../src/paddleTracker.js";

/**
 * Adversarial pass #2, scenario S4 (artifact side): what happens when the
 * paddle-dets.json a worker leaves behind is INCOMPLETE?
 *
 * Two shapes are distinguished:
 *   (a) a half-WRITTEN file (process died mid-write) — syntactically broken;
 *   (b) a syntactically VALID file whose frames cover only part of the
 *       declared window / planned sparse grid (a detector that stopped early
 *       but still closed its JSON).
 *
 * MEASURED on 4d812e1a:
 *   (a) HELD — JSON.parse (the only consumer path, analyzeVideo.ts:1170,
 *       1188, 1254) throws SyntaxError; nothing downstream sees partial frames.
 *   (b) BROKEN(P3) — mergePaddleDetectionFiles / buildPaddleTracks accept the
 *       artifact without any self-consistency check (frames vs
 *       timing.framesProcessed, frames vs schedule.sparse.plannedFrames,
 *       frame tMs vs declared window, schemaVersion) and produce a track
 *       whose windowCoverage silently reflects the missing half.
 *
 * The BROKEN cases pin the measured behaviour (repo "KNOWN OPEN GAP"
 * convention) so a fix must flip them deliberately.
 */

const dir = mkdtempSync(join(tmpdir(), "paddle-artifact-attack2-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SPAN = { startMs: 0, endMs: 3000 };
const FRAME_MS = 20; // 50 fps

function detsFile(
  tMsList: number[],
  options: { framesProcessed?: number; score?: number; window?: typeof SPAN } = {},
): RawPaddleDetectionFile {
  return {
    schemaVersion: 1,
    detector: {
      modelId: "test",
      version: "test",
      license: "Apache-2.0",
      device: "cpu",
      proxyLabels: ["tennis racket"],
      proxyNote: "",
      scoreFloor: 0.08,
    },
    video: { path: "test.mp4", width: 1000, height: 1000, fps: 50, durationMs: 4000 },
    window: options.window ?? { ...SPAN },
    timing: {
      modelLoadSec: 0,
      framesProcessed: options.framesProcessed ?? tMsList.length,
      inferenceSecTotal: tMsList.length * 0.1,
      inferenceMsPerFrame: 100,
      wallSecTotal: tMsList.length * 0.1,
    },
    frames: tMsList.map((tMs, index) => ({
      tMs,
      detections: [
        {
          // x0,y0,x1,y1 in pixels; slow drift so the tracker links every
          // frame into ONE track
          box: [400 + index, 400, 500 + index, 500],
          score: options.score ?? 0.5,
          label: "tennis racket",
        },
      ],
      extras: [],
    })),
  };
}

const grid = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let tMs = from; tMs <= to; tMs += step) out.push(tMs);
  return out;
};

const schedule = planTwoPassSchedule({
  detectSpan: SPAN,
  frameIntervalMs: FRAME_MS,
  primaryTrack: null,
  paddleSpeeds: null,
  eventPeaksMs: [1500],
});

/** analyzeVideo.ts:1170 / 1188 / 1254 — the only way artifacts are read. */
const load = (path: string): RawPaddleDetectionFile =>
  JSON.parse(readFileSync(path, "utf8")) as RawPaddleDetectionFile;

describe("attack2 S4(a): half-WRITTEN paddle-dets.json", () => {
  const full = JSON.stringify(detsFile(grid(0, 3000, 60)));

  it("HELD: every prefix of the artifact (1%…99%) is rejected by JSON.parse — no partial-frame object ever exists", () => {
    let rejected = 0;
    for (let percent = 1; percent < 100; percent += 1) {
      const path = join(dir, `half-${percent}.json`);
      writeFileSync(path, full.slice(0, Math.floor((full.length * percent) / 100)));
      try {
        load(path);
      } catch (error) {
        expect(error).toBeInstanceOf(SyntaxError);
        rejected += 1;
      }
    }
    expect(rejected).toBe(99);
  });

  it("HELD: a prefix cut exactly at a frame boundary inside `frames` is still a SyntaxError", () => {
    // Cut right after a complete frame object + comma: `…},` — the array and
    // object are unclosed, so this must not parse to a shorter frame list.
    const cut = full.indexOf("},{", full.indexOf('"frames":[')) + 2;
    const path = join(dir, "half-frame-boundary.json");
    writeFileSync(path, full.slice(0, cut));
    expect(() => load(path)).toThrow(SyntaxError);
  });

  it("HELD: an EMPTY file (worker killed before its first write flushed) is a SyntaxError, not an empty artifact", () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, "");
    expect(() => load(path)).toThrow(SyntaxError);
  });
});

describe("attack2 S4(b): syntactically valid but INCOMPLETE artifact", () => {
  it("BROKEN(P3): sparse frames stop at half the declared window; merge accepts and the tracker reports ~50% coverage instead of rejecting", () => {
    // Detector claims the full planned sparse grid was processed …
    const planned = schedule.sparse.plannedFrames;
    const halfGrid = grid(0, 1500, FRAME_MS * schedule.sparse.stride);
    const sparse = detsFile(halfGrid, { framesProcessed: planned });
    expect(sparse.frames.length).toBeLessThan(planned);

    // … and nothing notices: no throw, no flag, frames simply end at 1500.
    const merged = mergePaddleDetectionFiles(sparse, [], schedule);
    expect(merged.file.frames).toHaveLength(halfGrid.length);
    expect(merged.file.timing.framesProcessed).toBe(planned);
    expect(merged.file.window).toEqual(SPAN);
    expect(Math.max(...merged.file.frames.map((frame) => frame.tMs))).toBe(1500);

    // The tracker then happily tracks on the partial frames.
    const tracks = buildPaddleTracks(merged.file, SPAN);
    expect(tracks.length).toBeGreaterThan(0);
    const best = tracks[0]!;
    expect(best.observations.length).toBe(halfGrid.length);
    expect(best.windowCoverage).toBeLessThan(0.55);
    expect(best.windowCoverage).toBeGreaterThan(0.45);
  });

  it("BROKEN(P3): a dense-pass artifact whose frames lie OUTSIDE its planned region and the detect span is merged verbatim", () => {
    const sparse = detsFile(grid(0, 3000, FRAME_MS * schedule.sparse.stride));
    // dense frames at 5000..5100 — past the span AND every dense region
    const rogue = detsFile(grid(5000, 5100, FRAME_MS), {
      window: { startMs: 5000, endMs: 5100 },
      score: 0.95,
    });
    const merged = mergePaddleDetectionFiles(sparse, [rogue], schedule);
    const outside = merged.file.frames.filter((frame) => frame.tMs > SPAN.endMs);
    expect(outside).toHaveLength(6);
    expect(merged.passes.filter((record) => record.pass === "dense")).toHaveLength(6);
  });

  it("BROKEN(P3): schemaVersion is never checked — a future-schema artifact merges as if it were v1", () => {
    const sparse = detsFile(grid(0, 3000, 60));
    (sparse as { schemaVersion: number }).schemaVersion = 2;
    const merged = mergePaddleDetectionFiles(sparse, [], schedule);
    expect(merged.file.schemaVersion).toBe(2);
    expect(merged.file.frames.length).toBe(sparse.frames.length);
  });

  it("HELD: frames.length vs timing.framesProcessed mismatch is at least OBSERVABLE on the merged file (a fixer can gate on it)", () => {
    const planned = schedule.sparse.plannedFrames;
    const sparse = detsFile(grid(0, 1500, 60), { framesProcessed: planned });
    const merged = mergePaddleDetectionFiles(sparse, [], schedule);
    expect(merged.file.timing.framesProcessed).toBe(planned);
    expect(merged.file.frames.length).toBeLessThan(merged.file.timing.framesProcessed);
    expect(schedule.sparse.plannedFrames).toBeGreaterThan(merged.file.frames.length);
  });
});
