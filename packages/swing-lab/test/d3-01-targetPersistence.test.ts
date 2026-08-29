/**
 * D3-01 red-team regressions — target acquisition/persistence identity.
 *
 * All fixtures here are SYNTHETIC adversarial track/replay constructions
 * (visual impostors: crossing lookalikes, occlusion swaps, exit+reenter,
 * clothing-similar adjacent pairs, ambiguous taps, post-lock challengers).
 * No held-out cases are used. Each test pins a break found during Wave D3
 * red-teaming: the pre-fix behavior silently kept or handed off identity
 * with no risk surfaced; the pinned behavior surfaces an explicit risk /
 * confidence drop while leaving clean single-player geometry untouched.
 */
import { describe, expect, it } from "vitest";

import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  selectTargetPlayer,
  type PeopleFile,
} from "../src/playerTracker.js";
import { replayAcquisition, type ReplayFrame } from "../src/engine/taReplay.js";

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

const SHIPPED = { followerHysteresis: true, ambiguityTimeoutMs: 3000, sustainedGestureFrames: 5 };

describe("D3-01 synthetic: crossing lookalikes (identity contests)", () => {
  it("two similar players crossing produce identityContests and a contested selection risk", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 80; i++) {
      frames.push({
        t: i * 33,
        p: [person(Math.min(0.2 + i * 0.01, 0.5), 0.5), person(0.8 - i * 0.012, 0.5)],
      });
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    expect(tracks.some((track) => track.identityContests.length > 0)).toBe(true);
    const selection = selectTargetPlayer(tracks, { policy: "auto" }, null);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.value.risks.some((risk) => risk.startsWith("TARGET_IDENTITY_CONTESTED"))).toBe(
      true,
    );
    expect(selection.value.confidence).toBeLessThanOrEqual(0.5);
  });

  it("merge-cross (one detection while overlapped) records contests on the surviving track", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 60; i++) {
      const xa = 0.2 + i * 0.01;
      const xb = 0.8 - i * 0.01;
      frames.push(
        i >= 28 && i <= 32
          ? { t: i * 33, p: [person((xa + xb) / 2, 0.5)] }
          : { t: i * 33, p: [person(xa, 0.5), person(xb, 0.5)] },
      );
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    expect(tracks.some((track) => track.identityContests.length > 0)).toBe(true);
  });

  it("target dropout while a bystander passes through (occlusion swap) is contested", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 80; i++) {
      const people: PeopleFile["frames"][number]["p"] = [];
      if (i < 30 || i > 36) people.push(person(0.5, 0.5));
      people.push(person(0.17 + i * 0.01, 0.5));
      frames.push({ t: i * 33, p: people });
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    expect(tracks.some((track) => track.identityContests.length > 0)).toBe(true);
  });
});

describe("D3-01 synthetic: ambiguous tap", () => {
  it("a tap equidistant between two players surfaces TARGET_TAP_AMBIGUOUS with low confidence", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 40; i++)
      frames.push({ t: i * 33, p: [person(0.4, 0.5), person(0.6, 0.5)] });
    const tracks = buildPlayerTracks(makeFile(frames));
    const result = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.5, y: 0.55 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.identity.risks.some((risk) => risk.startsWith("TARGET_TAP_AMBIGUOUS")),
    ).toBe(true);
    expect(result.value.identity.confidence).toBeLessThanOrEqual(0.45);
  });

  it("an unambiguous tap keeps clean high confidence and no tap risk", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 40; i++)
      frames.push({ t: i * 33, p: [person(0.3, 0.5), person(0.8, 0.5)] });
    const tracks = buildPlayerTracks(makeFile(frames));
    const result = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.3, y: 0.55 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.identity.risks.some((risk) => risk.startsWith("TARGET_TAP_AMBIGUOUS")),
    ).toBe(false);
    expect(result.value.identity.confidence).toBeGreaterThan(0.45);
  });
});

describe("D3-01 synthetic: clothing-similar adjacent pair vs true duplicate aliases", () => {
  it("an adjacent DISTINCT person (median torso distance 0.10) is NOT absorbed as an alias", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 40; i++)
      frames.push({ t: i * 33, p: [person(0.5, 0.5), person(0.6, 0.5)] });
    const tracks = buildPlayerTracks(makeFile(frames));
    const result = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.48, y: 0.55 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Break (pre-fix): the second body's frames were silently absorbed,
    // doubling the target's frames and blending two humans into one identity.
    expect(result.value.target.frames.length).toBe(40);
    expect(result.value.identity.risks.some((risk) => risk.startsWith("TARGET_ALIAS_LOOSE"))).toBe(
      true,
    );
    expect(result.value.identity.confidence).toBeLessThanOrEqual(0.5);
  });

  it("a TRUE tight duplicate (median torso distance ~0.03) is still absorbed silently", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 40; i++) {
      frames.push({ t: i * 33, p: [person(0.5, 0.5), person(0.53, 0.5)] });
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    const result = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.5, y: 0.55 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.identity.aliasTrackIds.length).toBeGreaterThan(0);
    expect(result.value.identity.risks.some((risk) => risk.startsWith("TARGET_ALIAS_LOOSE"))).toBe(
      false,
    );
  });
});

describe("D3-01 synthetic: exit + reenter", () => {
  it("a target that leaves and returns keeps explicit loss periods (no silent stitch)", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 90; i++) {
      const people: PeopleFile["frames"][number]["p"] = [];
      if (i < 30 || i >= 60) people.push(person(0.5, 0.5));
      frames.push({ t: i * 33, p: people });
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    // Gap (≈990ms) exceeds maxGapMs: re-entry MUST be a new track, never a
    // silently-stitched continuation of the old identity.
    expect(tracks.length).toBe(2);
    for (const track of tracks) expect(track.identityContests.length).toBe(0);
  });
});

describe("D3-01 synthetic: post-lock follower (replay, shipped variant)", () => {
  it("target dropout while a mover passes = contested frames + an anchor jump surfaced", () => {
    const frames: ReplayFrame[] = [];
    for (let i = 0; i < 120; i++) {
      const people: ReplayFrame["people"] = [];
      if (i <= 40 || i >= 51) people.push({ joints: person(0.5, 0.5).l });
      const xb = 0.95 - i * 0.01;
      if (xb > 0.05) people.push({ joints: person(xb, 0.48).l });
      frames.push({ t: i * 33, people });
    }
    const result = replayAcquisition(frames, { x: 0.5, y: 0.5 }, SHIPPED);
    // Break (pre-fix): during the dropout the follower silently handed the
    // anchor to the passing body with zero surfaced signal.
    expect(result.followContestedFrames).toBeGreaterThan(0);
    expect(result.followJumps).toBeGreaterThan(0);
  });

  it("a decisively larger challenger stealing the follow is surfaced as contested + jump", () => {
    const frames: ReplayFrame[] = [];
    for (let i = 0; i < 120; i++) {
      const people: ReplayFrame["people"] = [{ joints: person(0.5, 0.5, 0.1).l }];
      const xb = 0.95 - i * 0.008;
      if (xb > 0.05) people.push({ joints: person(xb, 0.55, 0.22).l });
      frames.push({ t: i * 33, people });
    }
    const result = replayAcquisition(frames, { x: 0.5, y: 0.5 }, SHIPPED);
    expect(result.followContestedFrames).toBeGreaterThan(0);
    expect(result.followJumps).toBeGreaterThan(0);
  });

  it("a clean single-player follow stays uncontested with zero jumps", () => {
    const frames: ReplayFrame[] = [];
    for (let i = 0; i < 60; i++)
      frames.push({ t: i * 33, people: [{ joints: person(0.5, 0.5).l }] });
    const result = replayAcquisition(frames, { x: 0.5, y: 0.5 }, SHIPPED);
    expect(result.lock).not.toBeNull();
    expect(result.followContestedFrames).toBe(0);
    expect(result.followJumps).toBe(0);
  });
});

describe("D3-01 coverage guard: clean geometry is untouched by the hardening", () => {
  it("solo player: no contests, no new risks, confidence unchanged", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 60; i++) frames.push({ t: i * 33, p: [person(0.5, 0.5)] });
    const tracks = buildPlayerTracks(makeFile(frames));
    expect(tracks[0]!.identityContests.length).toBe(0);
    const selection = selectTargetPlayer(tracks, { policy: "auto" }, null);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.value.risks).toEqual([]);
    const seeded = initializeTargetFromSeed(tracks, {
      mode: "user_tapped_person",
      point: { x: 0.5, y: 0.55 },
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.identity.risks).toEqual([]);
    expect(seeded.value.identity.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("two well-separated players: auto-selection stays risk-free for identity contests", () => {
    const frames: PeopleFile["frames"] = [];
    for (let i = 0; i < 60; i++) {
      frames.push({ t: i * 33, p: [person(0.3, 0.5, 0.14), person(0.8, 0.3, 0.06)] });
    }
    const tracks = buildPlayerTracks(makeFile(frames));
    for (const track of tracks) expect(track.identityContests.length).toBe(0);
    const selection = selectTargetPlayer(tracks, { policy: "auto" }, null);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.value.risks.some((risk) => risk.startsWith("TARGET_IDENTITY_CONTESTED"))).toBe(
      false,
    );
  });
});
