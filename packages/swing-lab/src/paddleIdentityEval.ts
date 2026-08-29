/**
 * g01 paddle-track identity — REAL-DATA ownership evaluation.
 *
 * Applies the temporal ownership-evidence module
 * (@pickle/vision-geometry assessPaddleTrackIdentity) to the FULL dev
 * ownership dual-label set: per case, the Gold "target" labeled paddle
 * points across dual frames form the target-paddle track and the Gold
 * "other" labeled points form the other-paddle track; wrist trajectories
 * come from the committed windowed people.json runs (full frame rate).
 *
 * Scoring (counts, no thresholds tuned on this data):
 *  - a TARGET-labeled track assessed "foreign" is a REGRESSION (the module
 *    would wrongly exclude the target's own paddle);
 *  - an OTHER-labeled track assessed "foreign" is a correct rejection the
 *    spatial reach tether cannot make;
 *  - "undetermined" is an honest abstention (never counted as a win).
 *
 * Held-out cases (wm-dink-01, afn-vic-rally1) are NEVER loaded.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessPaddleTrackIdentity,
  type PaddleTrackIdentityAssessment,
  type TimedPoint,
} from "@pickle/vision-geometry";
import { loadDualFrames, OWNERSHIP_CASES, type DualFrame } from "./ownershipBench.js";
import { buildPlayerTracks, otherPlayersWrists, type PeopleFile } from "./playerTracker.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PB = join(REPO_ROOT, "datasets/paddle-bench");

interface TrackEval {
  caseId: string;
  group: string;
  owner: "target" | "other";
  points: number;
  verdict: PaddleTrackIdentityAssessment["verdict"];
  notes: string[];
}

/** Greedy per-frame nearest-neighbor linking of same-owner labeled points
 * into tracks (a case can show more than one "other" paddle). */
function linkOwnerTracks(frames: DualFrame[], owner: "target" | "other"): TimedPoint[][] {
  const tracks: TimedPoint[][] = [];
  for (const frame of [...frames].sort((a, b) => a.tMs - b.tMs)) {
    for (const candidate of frame.candidates) {
      if (candidate.owner !== owner) continue;
      const point = { timestampMs: frame.tMs, x: candidate.point.x, y: candidate.point.y };
      let best: TimedPoint[] | null = null;
      let bestDistance = Infinity;
      for (const track of tracks) {
        const last = track[track.length - 1]!;
        if (last.timestampMs >= frame.tMs) continue;
        const distance = Math.hypot(point.x - last.x, point.y - last.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = track;
        }
      }
      if (best !== null && bestDistance <= 0.15) best.push(point);
      else tracks.push([point]);
    }
  }
  return tracks;
}

function wristTracks(people: PeopleFile): {
  target: TimedPoint[][];
  other: TimedPoint[][];
  torsoSpan: number;
  aspect: number;
} {
  const tracks = buildPlayerTracks(people);
  const target = [...tracks].sort(
    (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
  )[0]!;
  const perWrist = new Map<string, TimedPoint[]>();
  for (const frame of target.frames) {
    for (const joint of frame.joints) {
      if (!joint.n.endsWith("wrist") || joint.v < 0.2) continue;
      const track = perWrist.get(joint.n) ?? [];
      track.push({ timestampMs: frame.timestampMs, x: joint.x, y: joint.y });
      perWrist.set(joint.n, track);
    }
  }
  const other: TimedPoint[][] = [];
  const otherEntries = otherPlayersWrists(tracks, target.trackId);
  // Greedy-link the unordered per-frame other wrists into trajectories.
  for (const entry of otherEntries) {
    for (const wrist of entry.wrists) {
      const point = { timestampMs: entry.timestampMs, x: wrist.x, y: wrist.y };
      let best: TimedPoint[] | null = null;
      let bestDistance = Infinity;
      for (const track of other) {
        const last = track[track.length - 1]!;
        if (last.timestampMs >= entry.timestampMs) continue;
        const distance = Math.hypot(point.x - last.x, point.y - last.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = track;
        }
      }
      if (best !== null && bestDistance <= 0.1) best.push(point);
      else other.push([point]);
    }
  }
  return {
    target: [...perWrist.values()],
    other,
    torsoSpan: target.meanTorsoSpan,
    aspect: people.video.h > 0 ? people.video.w / people.video.h : 1,
  };
}

export function runPaddleIdentityEval(): {
  version: string;
  cases: number;
  casesWithPose: number;
  trackEvals: TrackEval[];
  counts: Record<string, Record<string, number>>;
} {
  const frames = loadDualFrames(false, true);
  const byCase = new Map<string, DualFrame[]>();
  for (const frame of frames) {
    byCase.set(frame.caseId, [...(byCase.get(frame.caseId) ?? []), frame]);
  }
  const trackEvals: TrackEval[] = [];
  let casesWithPose = 0;
  for (const [caseId, caseFrames] of byCase) {
    const info = OWNERSHIP_CASES[caseId]!;
    const peoplePath = info.poseRunDir ? join(PB, info.poseRunDir, "people.json") : null;
    if (!peoplePath || !existsSync(peoplePath)) continue;
    casesWithPose += 1;
    const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
    const wrists = wristTracks(people);
    for (const owner of ["target", "other"] as const) {
      for (const track of linkOwnerTracks(caseFrames, owner)) {
        const assessment = assessPaddleTrackIdentity({
          paddleCenters: track,
          targetWristTracks: wrists.target,
          otherWristTracks: wrists.other,
          aspect: wrists.aspect,
          torsoSpan: wrists.torsoSpan,
        });
        trackEvals.push({
          caseId,
          group: info.group,
          owner,
          points: track.length,
          verdict: assessment.verdict,
          notes: assessment.evidence.notes,
        });
      }
    }
  }
  const counts: Record<string, Record<string, number>> = {
    target: { target_consistent: 0, foreign: 0, undetermined: 0 },
    other: { target_consistent: 0, foreign: 0, undetermined: 0 },
  };
  for (const trackEval of trackEvals) {
    counts[trackEval.owner]![trackEval.verdict]! += 1;
  }
  return {
    version: "paddle-identity-eval-1",
    cases: byCase.size,
    casesWithPose,
    trackEvals,
    counts,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const report = runPaddleIdentityEval();
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-g");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "g01-paddle-identity-ownership-eval.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.counts, null, 2));
  console.log(
    `${report.cases} dev cases (${report.casesWithPose} with committed pose), ${report.trackEvals.length} labeled paddle tracks → ${outPath}`,
  );
}
