/**
 * h26-redteam-perception regression suite (Wave H). All fixtures SYNTHETIC,
 * generated in-test; no corpus clips are read and held-out cases are
 * untouched. Each block pins either a FIXED break (the attack must stay
 * defended) or a DEFENDED construction (the existing defense must not rot).
 */
import { describe, expect, it } from "vitest";

import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  otherPlayersWrists,
  selectTargetPlayer,
  type PeopleFile,
} from "../src/playerTracker.js";
import {
  selectPrimaryPaddleTrack,
  wristSeries,
  type PaddleTrackCandidate,
} from "../src/paddleTracker.js";
import type { PoseSequence } from "@pickle/swing-domain";

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

const makeFile = (frames: PeopleFile["frames"]): PeopleFile => ({
  schemaVersion: 1,
  poseModelVersion: "synthetic",
  video: { w: 1920, h: 1080, fps: 30 },
  frames,
});

function poseSequenceOf(
  frames: Array<{
    timestampMs: number;
    joints: Array<{ n: string; x: number; y: number; v: number }>;
    confidence: number;
  }>,
): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "synthetic.h26",
      modelVersion: "synthetic",
      runtime: "vision_framework",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: 1920, height: 1080, fps: 30 },
    frames: frames.map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: frame.confidence,
      landmarks: frame.joints.map((j) => ({ name: j.n, x: j.x, y: j.y, visibility: j.v })),
    })),
  } as PoseSequence;
}

describe("h26-A1b (FIXED P0): silent identity swap through occlusion", () => {
  // Target stands at (0.5, 0.5) for 1s, is occluded for 132ms (< maxGapMs),
  // and a DIFFERENT person appears at x=0.46 — inside the association gate,
  // never co-visible with the target, so no identity contest fires. Pre-fix
  // the tracker stitched the opponent into the target track and both seeding
  // (0.9) and auto selection (0.95) reported high confidence with NO risks.
  const frames: PeopleFile["frames"] = [];
  for (let i = 0; i < 90; i++) {
    const people: PeopleFile["frames"][number]["p"] = [];
    if (i < 30) people.push(person(0.5, 0.5));
    if (i >= 33) people.push(person(Math.min(0.46 + (i - 33) * 0.005, 0.6), 0.5));
    frames.push({ t: i * 33, p: people });
  }

  it("discloses the unverifiable occlusion resume and caps confidence", () => {
    const tracks = buildPlayerTracks(makeFile(frames));
    const stitched = tracks.find((track) => track.lossPeriods.length > 0);
    expect(stitched).toBeDefined();
    expect(stitched!.occlusionResumes.length).toBeGreaterThan(0);

    const seeded = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.5, y: 0.55 },
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(
      seeded.value.identity.risks.some((risk) =>
        risk.startsWith("TARGET_OCCLUSION_RESUME_UNVERIFIED"),
      ),
    ).toBe(true);
    expect(seeded.value.identity.confidence).toBeLessThanOrEqual(0.5);

    const selection = selectTargetPlayer(
      tracks,
      { policy: "auto" },
      { startMs: 1200, endMs: 2900 },
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(
      selection.value.risks.some((risk) => risk.startsWith("TARGET_OCCLUSION_RESUME_UNVERIFIED")),
    ).toBe(true);
    expect(selection.value.confidence).toBeLessThanOrEqual(0.5);
  });

  it("does not flag a same-person resume that continues its motion path", () => {
    // A person walking steadily right, occluded for 132ms mid-walk, resuming
    // on the extrapolated path: a legitimate resume must NOT be flagged
    // (guards against excess-abstention overcorrection).
    const walking: PeopleFile["frames"] = [];
    for (let i = 0; i < 90; i++) {
      if (i >= 30 && i < 34) {
        walking.push({ t: i * 33, p: [] });
        continue;
      }
      walking.push({ t: i * 33, p: [person(0.3 + i * 0.004, 0.5)] });
    }
    const tracks = buildPlayerTracks(makeFile(walking));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.lossPeriods.length).toBeGreaterThan(0);
    expect(tracks[0]!.occlusionResumes).toHaveLength(0);
  });
});

describe("h26-B1 (FIXED P0): adjacent distinct opponent erased from ownership evidence", () => {
  // Two DISTINCT people 0.10 apart for the whole clip (above the 0.08
  // true-duplicate median, below the 0.12 majority gate). Pre-fix: (a) the
  // loose track was returned in identity.aliasTrackIds, and (b)
  // otherPlayersWrists suppressed it as a duplicate — so a paddle glued to
  // the OPPONENT's wrist was accepted as the target's with zero risks.
  const frames: PeopleFile["frames"] = [];
  for (let i = 0; i < 60; i++) {
    frames.push({ t: i * 33, p: [person(0.5, 0.5), person(0.6, 0.5)] });
  }
  const tracks = buildPlayerTracks(makeFile(frames));

  it("keeps loose coincident tracks out of aliasTrackIds", () => {
    const seeded = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.48, y: 0.55 },
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.identity.aliasTrackIds).toHaveLength(0);
    expect(seeded.value.identity.risks.some((risk) => risk.startsWith("TARGET_ALIAS_LOOSE"))).toBe(
      true,
    );
  });

  it("keeps the adjacent opponent's wrists as other-player evidence and rejects their paddle", () => {
    const seeded = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.48, y: 0.55 },
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const others = otherPlayersWrists(
      tracks,
      seeded.value.identity.trackId,
      seeded.value.identity.aliasTrackIds,
    );
    expect(others.length).toBeGreaterThan(0);

    // Foreign paddle glued to the opponent's wrist (0.605, 0.655).
    const observations = Array.from({ length: 60 }, (_, i) => ({
      timestampMs: i * 33,
      center: { x: 0.605, y: 0.655 },
      box: { x: 0.59, y: 0.64, w: 0.03, h: 0.03 },
      detectorScore: 0.9,
      interpolated: false,
    }));
    const candidate: PaddleTrackCandidate = {
      trackId: 1,
      observations: observations as never,
      meanScore: 0.9,
      windowCoverage: 1,
      meanWristDistance: null,
    };
    const wrists = wristSeries(poseSequenceOf(seeded.value.target.frames));
    const outcome = selectPrimaryPaddleTrack(
      [candidate],
      wrists,
      { startMs: 0, endMs: 59 * 33 },
      others,
      {},
    );
    expect(outcome.status).toBe("untracked");
  });
});

describe("h26-B2 (FIXED P1): distinct opponent's reaching wrist deleted at the net", () => {
  it("keeps a clearly-distinct player's wrist even when it nears the target's", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 60; i++) {
      const opponent = person(0.8, 0.5);
      if (i >= 25 && i <= 35) {
        opponent.l = opponent.l.map((joint) =>
          joint.n === "left_wrist" ? { ...joint, x: 0.52, y: 0.65 } : joint,
        );
      }
      frames.push({ t: i * 33, p: [person(0.5, 0.5), opponent] });
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    const target = tracks.find((track) => Math.abs(track.frames[0]!.torsoMid.x - 0.5) < 0.02)!;
    const others = otherPlayersWrists(tracks, target.trackId, []);
    const duringReach = others.filter(
      (entry) => entry.timestampMs >= 25 * 33 && entry.timestampMs <= 35 * 33,
    );
    // The reaching left wrist (0.52, 0.65) must survive in every reach frame.
    expect(duringReach.length).toBe(11);
    for (const entry of duringReach) {
      expect(
        entry.wrists.some(
          (wrist) => Math.abs(wrist.x - 0.52) < 1e-6 && Math.abs(wrist.y - 0.65) < 1e-6,
        ),
      ).toBe(true);
    }
  });
});

describe("h26-F1 (DEFENDED): tap during a player crossing stays ambiguity-flagged", () => {
  it("flags the tap as ambiguous when players swap positions inside the seed window", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 60; i++) {
      const a = 0.3 + Math.min(i, 36) * 0.01;
      const b = 0.66 - Math.min(i, 36) * 0.01;
      frames.push({ t: i * 33, p: [person(a, 0.5), person(b, 0.7)] });
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    const seeded = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.3, y: 0.55 },
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(
      seeded.value.identity.risks.some((risk) => risk.startsWith("TARGET_TAP_AMBIGUOUS")),
    ).toBe(true);
    expect(seeded.value.identity.confidence).toBeLessThanOrEqual(0.45);
  });
});
