/**
 * Structural-audit probe (native/swing-lab): the `video.fps` that
 * `swing-lab extract` writes into people.json is consumed verbatim by
 * `buildPlayerTracks` as the frame-interval loss gate
 * (`gap > (1000 / fps) * 1.9` → loss period). main.swift:211/237 write
 * `nominalFrameRate` whenever it is > 0 and only fall back to the measured
 * cadence when it is 0, so a clip whose container metadata disagrees with the
 * decoded stream propagates the wrong interval downstream.
 *
 * The fixture mirrors the Mac CI bundle produced on 4d812e1a for
 * datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4: frames decoded
 * every 42 ms (24 fps, 1461 frames, 60.8 s) while the extractor wrote
 * fps = 12 and durationMs = 121750 (see
 * tools/audit/native-swing-lab-camera-engine/check_extract_consistency.py).
 *
 * Set SWING_LAB_EXTRACT_DIR to a real `swing-lab extract --out` bundle to run
 * the same assertion against the actual artifact.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPlayerTracks, type PeopleFile } from "../src/playerTracker.js";

function person(x: number, y: number, span = 0.1, v = 0.9) {
  return {
    c: v,
    l: [
      { n: "left_shoulder", x: x - 0.02, y, v },
      { n: "right_shoulder", x: x + 0.02, y, v },
      { n: "left_hip", x: x - 0.02, y: y + span, v },
      { n: "right_hip", x: x + 0.02, y: y + span, v },
      { n: "left_wrist", x, y: y + span + 0.05, v },
      { n: "right_wrist", x: x + 0.03, y: y + span + 0.05, v },
    ],
  };
}

const FRAME_MS = 42; // decoded cadence of the CI clip (24 fps)

/** One player observed on every decoded frame except frame `dropAt`. */
function peopleFile(writtenFps: number, dropAt: number, frameCount = 60): PeopleFile {
  const frames: PeopleFile["frames"] = [];
  for (let i = 0; i < frameCount; i++) {
    if (i === dropAt) continue;
    frames.push({ t: i * FRAME_MS, p: [person(0.5 + i * 0.001, 0.5)] });
  }
  return {
    schemaVersion: 1,
    poseModelVersion: "synthetic",
    video: { w: 608, h: 1080, fps: writtenFps },
    frames,
  };
}

function medianIntervalMs(timestamps: number[]): number {
  const deltas = timestamps
    .slice(1)
    .map((t, i) => t - timestamps[i]!)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)]!;
}

describe("audit: swing-lab extract video.fps drives the player-track loss gate", () => {
  it("control: with the measured fps a single dropped frame is a loss period", () => {
    const tracks = buildPlayerTracks(peopleFile(1000 / FRAME_MS, 30));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.lossPeriods).toEqual([{ fromMs: 29 * FRAME_MS, toMs: 31 * FRAME_MS }]);
  });

  it("with the fps the extractor wrote for the CI clip (nominal 12) the same dropped frame is invisible", () => {
    // Contract under test: people.json must carry the DECODED cadence so the
    // 1.9-frame loss gate keeps its meaning. fps=12 is what main.swift wrote
    // for a stream decoded at 42 ms intervals.
    const tracks = buildPlayerTracks(peopleFile(12, 30));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.lossPeriods).toEqual([{ fromMs: 29 * FRAME_MS, toMs: 31 * FRAME_MS }]);
  });

  const extractDir = process.env["SWING_LAB_EXTRACT_DIR"];
  const hasBundle = !!extractDir && existsSync(join(extractDir, "people.json"));
  it.skipIf(!hasBundle)(
    "real bundle: people.json video.fps matches the decoded frame cadence",
    () => {
      const people = JSON.parse(
        readFileSync(join(extractDir!, "people.json"), "utf8"),
      ) as PeopleFile;
      const measuredFps = 1000 / medianIntervalMs(people.frames.map((frame) => frame.t));
      expect(Math.abs(people.video.fps - measuredFps) / measuredFps).toBeLessThanOrEqual(0.1);
    },
  );
});
