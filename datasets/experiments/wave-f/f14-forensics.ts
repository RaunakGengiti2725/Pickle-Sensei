/**
 * F14 forensics — per-candidate evidence dump for the incumbent's wrong-pick
 * failures on the post-E05 corrected ownership gold. Read-only over committed
 * data; writes a JSON evidence file under wave-f. Run from packages/swing-lab:
 *
 *   pnpm exec tsx ../../datasets/experiments/wave-f/f14-forensics.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../../packages/swing-lab/src/engine/corpus.js";
import { TRACKER_GATES } from "../../../packages/swing-lab/src/paddleTracker.js";
import {
  loadDualFrames,
  pickIncumbent,
  type DualFrame,
} from "../../../packages/swing-lab/src/ownershipBench.js";

const FOCUS: Array<{ caseId: string; tMs: number }> = [
  { caseId: "wavea-944403-dink", tMs: 21171.15 },
  { caseId: "wavea-944403-dink", tMs: 22088.73 },
  { caseId: "wavea-944403-dink", tMs: 22338.98 },
  { caseId: "wavea-944403-dink", tMs: 22589.23 },
];

function nearest(
  point: { x: number; y: number },
  wrists: Array<{ x: number; y: number }>,
): number | null {
  if (wrists.length === 0) return null;
  return Math.min(...wrists.map((w) => Math.hypot(w.x - point.x, w.y - point.y)));
}

function describe(frame: DualFrame) {
  const pick = pickIncumbent(frame);
  const factor = TRACKER_GATES.otherOwnershipFactor;
  return {
    caseId: frame.caseId,
    tMs: frame.tMs,
    buckets: frame.buckets,
    otherOwnershipFactor: factor,
    pose: frame.pose
      ? {
          targetWrists: frame.pose.targetWrists,
          otherWrists: frame.pose.otherWrists,
          torsoMid: frame.pose.torsoMid,
          torsoSpan: frame.pose.torsoSpan,
        }
      : null,
    candidates: frame.candidates.map((candidate, index) => {
      const dTarget = frame.pose ? nearest(candidate.point, frame.pose.targetWrists) : null;
      const dOther = frame.pose ? nearest(candidate.point, frame.pose.otherWrists) : null;
      return {
        index,
        goldOwner: candidate.owner,
        annotatorId: candidate.annotatorId,
        point: candidate.point,
        dTargetWrist: dTarget === null ? null : Number(dTarget.toFixed(4)),
        dOtherWrist: dOther === null ? null : Number(dOther.toFixed(4)),
        otherOwnedByVeto: dTarget !== null && dOther !== null ? dOther < factor * dTarget : null,
        picked: pick.index === index,
      };
    }),
    pick: { index: pick.index, reason: pick.reason },
    pickedOwner: pick.index === null ? null : frame.candidates[pick.index]!.owner,
  };
}

const frames = loadDualFrames(false, true);
const out = FOCUS.map((focus) => {
  const frame = frames.find((f) => f.caseId === focus.caseId && Math.abs(f.tMs - focus.tMs) < 1);
  if (!frame) throw new Error(`frame not found: ${focus.caseId} @ ${focus.tMs}`);
  return describe(frame);
});
const outPath = join(REPO_ROOT, "datasets/experiments/wave-f/f14-forensics-evidence.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
