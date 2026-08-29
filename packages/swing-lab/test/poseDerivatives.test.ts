import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import { classifyStroke } from "../src/strokeHeuristic.js";
import { buildStrokeSequence } from "../src/strokeSequence.js";
import { buildBallTracks, type BallCandidateFile } from "../src/ballTracker.js";
import { wristSeries, wristSeriesFromFrames } from "../src/paddleTracker.js";

/**
 * D4-05 pose-reuse contract: every stage that accepts a precomputed legacy
 * projection must produce output byte-identical (via JSON serialization) to
 * the stage deriving the projection itself. Guards the computed-once cache
 * in analyzeVideo against drift.
 */

const { sequence, window } = generateSwingSequence();
const windowArg = { startMs: window.startMs, endMs: window.endMs };
const legacyFrames = toLegacyPoseFrames(sequence);

function candidateFile(frames: BallCandidateFile["frames"]): BallCandidateFile {
  return {
    schemaVersion: 1,
    generator: { version: "test", method: "test", scale: 0.5, note: "" },
    video: { path: "test.mp4", width: 1000, height: 1000, fps: 25, durationMs: 4000 },
    window: { startMs: 0, endMs: 4000 },
    backgroundActivity: { grid: 24, cells: new Array(24 * 24).fill(0) },
    timing: { framesProcessed: frames.length, wallSecTotal: 0, msPerFrame: 0 },
    frames,
  };
}

function flightFrames(): BallCandidateFile["frames"] {
  const frames: BallCandidateFile["frames"] = [];
  for (let index = 0; index < 50; index += 1) {
    const candidates = [];
    if (index >= 10 && index < 30) {
      const k = index - 10;
      candidates.push({
        x: 0.95 - k * 0.03,
        y: 0.15 + k * 0.012,
        areaPx: 40,
        wNorm: 0.01,
        hNorm: 0.01,
        elong: 1.2,
        score: 500,
      });
    }
    frames.push({ tMs: index * 40, candidates, rawComponentCount: candidates.length });
  }
  return frames;
}

describe("pose-derivative cache parity (cached vs self-derived)", () => {
  it("wristSeriesFromFrames(toLegacyPoseFrames(seq)) === wristSeries(seq)", () => {
    expect(JSON.stringify(wristSeriesFromFrames(legacyFrames))).toBe(
      JSON.stringify(wristSeries(sequence)),
    );
  });

  it("classifyStroke output is identical with and without cached frames", () => {
    const base = {
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right" as const,
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    };
    expect(JSON.stringify(classifyStroke({ ...base, legacyFrames }))).toBe(
      JSON.stringify(classifyStroke(base)),
    );
  });

  it("buildStrokeSequence output is identical with and without cached frames", () => {
    const base = {
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      paddle: null,
      ball: null,
      wristSpeeds: null,
      paddleSpeeds: null,
    };
    expect(JSON.stringify(buildStrokeSequence({ ...base, legacyFrames }))).toBe(
      JSON.stringify(buildStrokeSequence(base)),
    );
  });

  it("buildBallTracks output is identical with and without cached frames", () => {
    const file = candidateFile(flightFrames());
    const strokeWindow = { startMs: 300, endMs: 1400 };
    expect(JSON.stringify(buildBallTracks(file, sequence, strokeWindow, null, legacyFrames))).toBe(
      JSON.stringify(buildBallTracks(file, sequence, strokeWindow, null)),
    );
  });
});
