import { describe, expect, it } from "vitest";
import {
  replayAcquisition,
  OCCUPANCY_FRAMES_TO_LOCK,
  REPLAY_VARIANTS,
  SHIPPED_VARIANT,
  W3_AMBIGUITY_DOMINANCE,
  W3_OCCUPANCY_DOMINANCE,
  type ReplayFrame,
} from "../src/engine/taReplay.js";

/**
 * W3 (wave-b) BENCH-ONLY variant semantics. These tests pin:
 *  1. the SHIPPED wrong-grab class stays byte-semantically unchanged
 *     (a soft-visibility bystander cannot alter shipped behavior), and
 *  2. the candidate occupancy-dominance gate / ambiguity sustained
 *     resolution behave as designed on synthetic scenes.
 * Nothing here ships — D-026 gates any Swift change on bench dominance.
 */

const region = { x: 0.5, y: 0.5 };

function person(x: number, y: number, opts: { wristRaised?: boolean; v?: number } = {}) {
  const v = opts.v ?? 0.9;
  const joints = [
    { n: "left_shoulder", x: x - 0.02, y, v },
    { n: "right_shoulder", x: x + 0.02, y, v },
    { n: "left_hip", x: x - 0.02, y: y + 0.1, v },
    { n: "right_hip", x: x + 0.02, y: y + 0.1, v },
    { n: "left_wrist", x, y: opts.wristRaised ? y - 0.1 : y + 0.15, v },
    { n: "right_wrist", x: x + 0.03, y: y + 0.15, v },
  ];
  return { joints };
}

function frames(count: number, build: (index: number) => ReplayFrame["people"]): ReplayFrame[] {
  return Array.from({ length: count }, (_, index) => ({ t: index * 33, people: build(index) }));
}

// A person only the SOFT crowd detector can see: torso joints at v=0.15
// (≥ SOFT_OCCUPANT_MIN_V 0.1 but below the strict 0.2 occupancy bar).
const softBystander = (x: number, y: number) => person(x, y, { v: 0.15 });

describe("W3 regression pins — shipped/legacy unchanged by the new fields", () => {
  it("SHIPPED still instantly grabs a lone resolvable occupant even with a soft bystander closer to the region (the measured 9-case wrong-grab class)", () => {
    const result = replayAcquisition(
      frames(20, () => [person(0.56, 0.5), softBystander(0.5, 0.5)]),
      region,
      SHIPPED_VARIANT,
    );
    expect(result.ambiguityEntered).toBe(false);
    expect(result.lock?.source).toBe("start_region_occupancy");
    expect(result.lock?.t).toBe((OCCUPANCY_FRAMES_TO_LOCK - 1) * 33);
    expect(result.lock?.torso.x).toBeCloseTo(0.56, 5);
  });

  it("registry: shipped/legacy entries carry none of the W3 fields", () => {
    for (const name of [
      "shipped",
      "legacy",
      "hysteresis",
      "ambiguity-timeout",
      "sustained-gesture",
      "candidate",
    ]) {
      expect(REPLAY_VARIANTS[name]?.occupancyDominance).toBeUndefined();
      expect(REPLAY_VARIANTS[name]?.ambiguityDominance).toBeUndefined();
    }
  });
});

describe("W3 (a) occupancy-dominance gate", () => {
  const gate = REPLAY_VARIANTS["dominance-gate"]!;

  it("forbids the silent instant grab when a soft bystander contests the region → honest ambiguity after the stall window", () => {
    const result = replayAcquisition(
      frames(60, () => [person(0.56, 0.5), softBystander(0.5, 0.5)]),
      region,
      gate,
    );
    // The lone strict occupant (d=0.06) is NOT 1.5× closer than the soft
    // bystander sitting on the region center → never dominant → ambiguity.
    expect(result.events[0]?.kind).toBe("ambiguous_entered");
    expect(result.events[0]?.t).toBe((W3_OCCUPANCY_DOMINANCE.stallFramesToAmbiguity - 1) * 33);
    expect(result.lock?.source ?? "none").not.toBe("start_region_occupancy");
  });

  it("locks via occupancy_dominance when the occupant is clearly closest, sustained", () => {
    const result = replayAcquisition(
      frames(20, () => [person(0.52, 0.5), softBystander(0.65, 0.5)]),
      region,
      gate,
    );
    // d0=0.02, rival at 0.15 ≥ 1.5×0.02 → dominant every frame → lock at 9.
    expect(result.ambiguityEntered).toBe(false);
    expect(result.lock?.source).toBe("occupancy_dominance");
    expect(result.lock?.t).toBe((W3_OCCUPANCY_DOMINANCE.framesToDominate - 1) * 33);
    expect(result.lock?.torso.x).toBeCloseTo(0.52, 5);
  });

  it("keeps the plain instant lock (identical timing) when the region is genuinely solo", () => {
    const result = replayAcquisition(
      frames(15, () => [person(0.5, 0.5)]),
      region,
      gate,
    );
    expect(result.lock?.source).toBe("start_region_occupancy");
    expect(result.lock?.t).toBe((OCCUPANCY_FRAMES_TO_LOCK - 1) * 33);
  });

  it("two strict occupants still enter ambiguity immediately (unchanged path)", () => {
    const result = replayAcquisition(
      frames(10, () => [person(0.46, 0.5), person(0.54, 0.5)]),
      region,
      gate,
    );
    expect(result.events[0]?.kind).toBe("ambiguous_entered");
    expect(result.events[0]?.t).toBe(0);
  });
});

describe("W3 (b) ambiguity sustained-resolution", () => {
  const sustained = REPLAY_VARIANTS["sustained-ambiguity"]!;

  it("resolves ambiguity by sustained dominance (ambiguity_dominance) long before any timeout", () => {
    const result = replayAcquisition(
      frames(60, () => [person(0.54, 0.5), person(0.62, 0.5)]),
      region,
      sustained,
    );
    // Both are strict occupants (ambiguity at t=0); closest d=0.04 vs rival
    // 0.12 ≥ 1.5×0.04 → dominant, sustained 12 frames → dominance lock.
    expect(result.ambiguityEntered).toBe(true);
    expect(result.lock?.source).toBe("ambiguity_dominance");
    expect(result.lock?.t).toBe(W3_AMBIGUITY_DOMINANCE.frames * 33); // ambiguity consumed frame 0
    expect(result.lock?.torso.x).toBeCloseTo(0.54, 5);
  });

  it("falls back to the LONGER last-resort timeout when nobody dominates or gestures", () => {
    const result = replayAcquisition(
      frames(200, () => [person(0.44, 0.5), person(0.56, 0.5)]),
      region,
      sustained,
    );
    // Equidistant (0.06 vs 0.06) → dominance never fires; blind lock only at 6s.
    expect(result.lock?.source).toBe("ambiguity_timeout");
    expect(result.lock!.t).toBeGreaterThanOrEqual(6000);
    const shipped = replayAcquisition(
      frames(200, () => [person(0.44, 0.5), person(0.56, 0.5)]),
      region,
      SHIPPED_VARIANT,
    );
    expect(shipped.lock?.source).toBe("ambiguity_timeout");
    expect(shipped.lock!.t).toBeLessThan(3100); // shipped snapshots at 3s
  });

  it("a sustained wrist raise still wins ambiguity (acquire-v3 keeps the gesture path)", () => {
    const result = replayAcquisition(
      frames(60, (index) => [person(0.44, 0.5), person(0.56, 0.5, { wristRaised: index >= 20 })]),
      region,
      REPLAY_VARIANTS["acquire-v3"],
    );
    expect(result.lock?.source).toBe("gesture_confirmed");
    expect(result.lock?.torso.x).toBeCloseTo(0.56, 5);
  });

  it("W3 (a2) acquire-v4: an off-center sole occupant never insta-locks; the later-appearing centered target wins via ambiguity dominance", () => {
    // Measured wrong-grab anatomy: the tapped target is pose-undetected for
    // seconds while a bystander (d=0.09 from the tap point) is the only
    // resolvable occupant. The target's pose appears at frame 40, on point.
    // (The helper's torso mid sits at y+0.05, hence the y=0.45 placement.)
    const result = replayAcquisition(
      frames(80, (index) =>
        index >= 40 ? [person(0.59, 0.45), person(0.5, 0.45)] : [person(0.59, 0.45)],
      ),
      region,
      REPLAY_VARIANTS["acquire-v4"],
    );
    expect(result.ambiguityEntered).toBe(true); // honest ambiguity, no silent grab
    expect(result.lock?.source).toBe("ambiguity_dominance");
    expect(result.lock?.torso.x).toBeCloseTo(0.5, 5); // the true target, not the bystander
  });

  it("W3 (a2) acquire-v4: a CENTERED sole occupant keeps the fast instant lock", () => {
    const result = replayAcquisition(
      frames(15, () => [person(0.52, 0.45)]),
      region,
      REPLAY_VARIANTS["acquire-v4"],
    );
    expect(result.lock?.source).toBe("start_region_occupancy");
    expect(result.lock?.t).toBe((OCCUPANCY_FRAMES_TO_LOCK - 1) * 33);
  });

  it("W3 (a2) acquire-v4: vacuous dominance is blocked — an off-center loner only falls to the 6s last-resort timeout", () => {
    const result = replayAcquisition(
      frames(250, () => [person(0.59, 0.5)]),
      region,
      REPLAY_VARIANTS["acquire-v4"],
    );
    // patience (30 frames ≈1s) → ambiguity; a sole occupant far from the tap
    // point can never claim dominance (no rivals ⇒ vacuous margin), so only
    // the blind timeout resolves — 6s after ambiguity entry, not at 400ms.
    expect(result.lock?.source).toBe("ambiguity_timeout");
    expect(result.lock!.t).toBeGreaterThanOrEqual(6990);
  });

  it("acquire-v3-strict-gesture: a 6-frame raise does NOT lock, 8 sustained frames do", () => {
    const strict = REPLAY_VARIANTS["acquire-v3-strict-gesture"];
    const brief = replayAcquisition(
      frames(60, (index) => [
        person(0.44, 0.5),
        person(0.56, 0.5, { wristRaised: index >= 20 && index < 26 }),
      ]),
      region,
      strict,
    );
    expect(brief.lock?.source ?? "none").not.toBe("gesture_confirmed");
    const sustainedRaise = replayAcquisition(
      frames(60, (index) => [
        person(0.44, 0.5),
        person(0.56, 0.5, { wristRaised: index >= 20 && index < 30 }),
      ]),
      region,
      strict,
    );
    expect(sustainedRaise.lock?.source).toBe("gesture_confirmed");
  });
});
