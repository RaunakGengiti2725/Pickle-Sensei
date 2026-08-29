import { describe, expect, it } from "vitest";
import { TRACKER_GATES } from "../src/paddleTracker.js";
import { loadDualFrames, pickIncumbent, type DualFrame } from "../src/ownershipBench.js";

/**
 * F14 regression fixtures — pins the incumbent's CURRENT wrong-pick behavior
 * on the worst ownership slice (wavea-944403-dink, dark_on_dark ∩ multi_paddle
 * dual frames, post-E05 corrected gold). Every wrong pick shares one failure
 * signature: an other-owned paddle sits closer to a target wrist than the true
 * target paddle, and its owning player's wrist is NOT in the pose other-wrist
 * set, so the otherOwnershipFactor veto cannot fire.
 *
 * These pins document a known failure, not desired behavior. A Wave G
 * ownership fix is EXPECTED to flip the pickedOwner assertions — flip them
 * consciously with the fix, citing this file and
 * datasets/experiments/wave-f/f14-forensics-evidence.json.
 */

const WRONG_PICK_FIXTURES = [
  { tMs: 21171.15, pickedPoint: { x: 0.3177, y: 0.3611 } },
  { tMs: 22088.73, pickedPoint: { x: 0.3255, y: 0.3773 } },
  { tMs: 22338.98, pickedPoint: { x: 0.3141, y: 0.3815 } },
  { tMs: 22589.23, pickedPoint: { x: 0.295, y: 0.385 } },
] as const;

function nearest(
  point: { x: number; y: number },
  wrists: Array<{ x: number; y: number }>,
): number | null {
  if (wrists.length === 0) return null;
  return Math.min(...wrists.map((w) => Math.hypot(w.x - point.x, w.y - point.y)));
}

function findFrame(frames: DualFrame[], tMs: number): DualFrame {
  const frame = frames.find(
    (candidate) => candidate.caseId === "wavea-944403-dink" && Math.abs(candidate.tMs - tMs) < 1,
  );
  if (!frame) throw new Error(`dual frame not found: wavea-944403-dink @ ${tMs}`);
  return frame;
}

describe("f14 ownership forensics regression pins (corrected gold, dev split)", () => {
  const frames = loadDualFrames(false, true);

  it.each(WRONG_PICK_FIXTURES)(
    "incumbent picks the other-owned paddle at dink t=$tMs (known failure)",
    ({ tMs, pickedPoint }) => {
      const frame = findFrame(frames, tMs);
      const pick = pickIncumbent(frame);
      expect(pick.index).not.toBeNull();
      const picked = frame.candidates[pick.index!]!;
      expect(picked.owner).toBe("other");
      expect(picked.point.x).toBeCloseTo(pickedPoint.x, 3);
      expect(picked.point.y).toBeCloseTo(pickedPoint.y, 3);
    },
  );

  it.each(WRONG_PICK_FIXTURES)(
    "failure signature at t=$tMs: picked other paddle beats gold target on wrist distance and escapes the other-wrist veto",
    ({ tMs }) => {
      const frame = findFrame(frames, tMs);
      const pick = pickIncumbent(frame);
      const picked = frame.candidates[pick.index!]!;
      const goldTarget = frame.candidates.find((candidate) => candidate.owner === "target")!;
      const dPicked = nearest(picked.point, frame.pose!.targetWrists)!;
      const dGold = nearest(goldTarget.point, frame.pose!.targetWrists)!;
      expect(dPicked).toBeLessThan(dGold);
      const dOther = nearest(picked.point, frame.pose!.otherWrists);
      expect(dOther === null || dOther >= TRACKER_GATES.otherOwnershipFactor * dPicked).toBe(true);
    },
  );

  it("the gold target paddle itself is never vetoed on these frames — ranking, not the veto, is what fails", () => {
    for (const { tMs } of WRONG_PICK_FIXTURES) {
      const frame = findFrame(frames, tMs);
      const goldTarget = frame.candidates.find((candidate) => candidate.owner === "target")!;
      const dTarget = nearest(goldTarget.point, frame.pose!.targetWrists)!;
      const dOther = nearest(goldTarget.point, frame.pose!.otherWrists);
      const vetoed = dOther !== null && dOther < TRACKER_GATES.otherOwnershipFactor * dTarget;
      expect(vetoed).toBe(false);
    }
  });
});
