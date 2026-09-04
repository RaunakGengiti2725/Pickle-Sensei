import { describe, expect, it } from "vitest";
import { loadGoldCases, loadPeople, resamplePeople } from "../src/fpsTemporalSegmentation.js";
import { buildPlayerTracks, type PeopleFile } from "../src/playerTracker.js";

/**
 * ADVERSARIAL (xc-cv::XC-CV-4 candidate 5ee6b8ea): `buildPlayerTracks` now
 * derives the loss threshold from the interquartile mean of the observed
 * frame intervals (`observedFrameIntervalMs`). On a stream whose cadence is
 * legitimately irregular — 30 → 24 fps integer decimation (33,33,33,33,67 ms),
 * i.e. exactly what a throttled capture or the fps-temporal harness produces —
 * the IQR mean (~35 ms) makes the 1.9× gate fall UNDER the 67 ms "long" frame,
 * so a person detected in EVERY frame of the file is reported as lost on every
 * fifth frame. Pre-fix (declared 24 fps → 79 ms gate) reported 0.
 *
 * Invariant under attack: a track observed in every consecutive frame of the
 * file has no loss period, whatever the sample cadence looks like.
 */

function person(x: number) {
  return {
    c: 0.9,
    l: [
      { n: "left_shoulder", x: x - 0.05, y: 0.4, v: 0.9 },
      { n: "right_shoulder", x: x + 0.05, y: 0.4, v: 0.9 },
      { n: "left_hip", x: x - 0.04, y: 0.6, v: 0.9 },
      { n: "right_hip", x: x + 0.04, y: 0.6, v: 0.9 },
    ],
  };
}

/** 30 fps capture decimated to 24 fps by dropping every 5th frame (the
 * fps-temporal harness's real, non-synthetic decimation): timestamps advance
 * 33,33,33,33,67 ms. One person, present in every frame. */
function decimated30to24(frameCount: number): PeopleFile {
  const frames: PeopleFile["frames"] = [];
  let sourceIndex = 0;
  for (let index = 0; index < frameCount; index += 1) {
    frames.push({ t: Math.round((sourceIndex * 1000) / 30), p: [person(0.4 + index * 0.001)] });
    sourceIndex += index % 4 === 3 ? 2 : 1;
  }
  return {
    schemaVersion: 1,
    poseModelVersion: "test",
    video: { w: 1080, h: 1920, fps: 24 },
    frames,
  };
}

describe("XC-CV-4 attack: observed-cadence loss gate on an irregular (decimated) cadence", () => {
  it("a person detected in every frame of a 30→24 fps decimated file has no loss periods", () => {
    const file = decimated30to24(96);
    const tracks = buildPlayerTracks(file);
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.frames.length).toBe(96);
    expect(tracks[0]!.lossPeriods, JSON.stringify(tracks[0]!.lossPeriods.slice(0, 5))).toEqual([]);
  });

  it("committed wave-a bundle wavea-sasebo-volleys (native 30 fps) decimated to 24 fps: the full-coverage track has no loss periods", () => {
    const gold = loadGoldCases().find((item) => item.bundle === "wavea-sasebo-volleys");
    expect(gold).toBeDefined();
    const people = loadPeople(gold!.runDir);
    const { file } = resamplePeople(people, {
      bundle: gold!.bundle,
      fps: 24,
      phase: 0,
      jitterMs: 0,
      dropRate: 0,
      seed: 0,
    });
    const tracks = buildPlayerTracks(file);
    const fullCoverage = tracks.filter((track) => track.frames.length === file.frames.length);
    expect(fullCoverage.length).toBeGreaterThan(0);
    for (const track of fullCoverage) {
      expect(track.lossPeriods, JSON.stringify(track.lossPeriods.slice(0, 5))).toEqual([]);
    }
  });
});
