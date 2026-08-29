import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import type { BallFrameLabel } from "../src/annotationSchema.js";
import { BALL_HIT_RADIUS, BALL_MATCH_TOLERANCE_MS } from "../src/ballBench.js";
import { runCaseWindows } from "../src/ballHardSliceEval.js";
import {
  aggregateBallOcclusionResults,
  bucketForBallLabel,
  scoreBallOcclusionCase,
} from "../src/ballOcclusionBench.js";
import {
  BALL_GATES2,
  buildBallTracks,
  selectPrimaryBallTrack,
  type BallCandidateFile,
  type BallTrackCandidate,
} from "../src/ballTracker.js";

/**
 * G17 regression pins — pins the tracker's CURRENT behavior on the worst
 * N>=5 slice at the Wave C integration head: the BALL OBSERVED bucket of the
 * D2-06 hard-slice gold (LINUX-CPU pose-free proxy; hits 9/35).
 *
 * These pins document known failures, not desired behavior. A future ball fix
 * is EXPECTED to flip the hit-count and ghost-flight assertions — flip them
 * consciously with the fix, citing this file and
 * datasets/experiments/wave-g/g17-forensics-evidence.json.
 *
 * The dominant failure signature (19/26 failures) is a "ghost flight": a
 * track exists in the association output that carries many gold-aligned
 * observations (the evidence IS there), but it is rejected by the stage-C
 *
 * jerkyFraction / chronicFraction gates — and even force-gating it in does
 * not make it primary, so a gate-only fix cannot recover these failures.
 */

interface ManifestWindow {
  startMs: number;
  endMs: number;
  note?: string;
}
interface ManifestCase {
  id: string;
  labels: string;
  candidates: string;
  clockOffsetMs: number;
  windows: ManifestWindow[];
}
interface Manifest {
  cases: ManifestCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const experimentDir = resolve(here, "../../../datasets/experiments/wave-e/e12-ball-hard-slices");
const manifest = JSON.parse(readFileSync(join(experimentDir, "manifest.json"), "utf8")) as Manifest;

const EMPTY_POSE: PoseSequence = {
  schemaVersion: 1,
  format: "pickle.pose-sequence.v1",
  coordinateSystem: "normalized_image_top_left",
  producedBy: {
    providerId: "pose.none-linux-proxy",
    modelVersion: "absent (Apple Vision is macOS-only)",
    runtime: "deterministic",
    executionTarget: "server",
    artifactHash: null,
  },
  video: { width: 1920, height: 1080, fps: 30 },
  frames: [],
};

function loadCase(id: string): {
  benchCase: ManifestCase;
  labels: BallFrameLabel[];
  file: BallCandidateFile;
} {
  const benchCase = manifest.cases.find((candidate) => candidate.id === id);
  if (!benchCase) throw new Error(`case not in e12 manifest: ${id}`);
  const annotation = JSON.parse(readFileSync(resolve(experimentDir, benchCase.labels), "utf8")) as {
    ballFrames?: BallFrameLabel[];
  };
  const rawFile = JSON.parse(
    readFileSync(resolve(experimentDir, benchCase.candidates), "utf8"),
  ) as BallCandidateFile;
  const offset = benchCase.clockOffsetMs;
  const file: BallCandidateFile =
    offset === 0
      ? rawFile
      : {
          ...rawFile,
          window: {
            startMs: rawFile.window.startMs - offset,
            endMs: rawFile.window.endMs - offset,
          },
          frames: rawFile.frames.map((frame) => ({ ...frame, tMs: frame.tMs - offset })),
        };
  return { benchCase, labels: annotation.ballFrames ?? [], file };
}

function goldAlignedCount(track: BallTrackCandidate, labels: BallFrameLabel[]): number {
  return labels.filter((label) => {
    if (bucketForBallLabel(label) !== "OBSERVED") return false;
    return track.observations.some(
      (observation) =>
        Math.abs(observation.timestampMs - label.tMs) <= BALL_MATCH_TOLERANCE_MS &&
        Math.hypot(observation.x - label.point!.x, observation.y - label.point!.y) <=
          BALL_HIT_RADIUS,
    );
  }).length;
}

describe("g17 ball hard-slice regression pins (D2-06 gold, LINUX-CPU pose-free proxy)", () => {
  it("OBSERVED bucket aggregate is pinned at head: n=35, hits 9, miss 16, wrongLoc 10, zero violations", () => {
    const caseResults = manifest.cases.map(({ id }) => {
      const { benchCase, labels, file } = loadCase(id);
      const runs = runCaseWindows(file, benchCase.windows);
      const predictions = runs.flatMap((run) => run.predictions);
      const result = scoreBallOcclusionCase(id, labels, predictions, null);
      for (const run of runs) {
        if (!run.timeline) continue;
        const bridgeCheck = scoreBallOcclusionCase(id, [], run.predictions, run.timeline);
        result.violations.push(...bridgeCheck.violations);
      }
      return result;
    });
    const aggregate = aggregateBallOcclusionResults(caseResults);
    const observed = aggregate.find((bucket) => bucket.bucket === "OBSERVED")!;
    expect(observed.n).toBe(35);
    expect(observed.hits).toBe(9);
    expect(observed.misses).toBe(16);
    expect(observed.wrongLocation).toBe(10);
    const occluded = aggregate.find((bucket) => bucket.bucket === "OCCLUDED")!;
    expect(occluded.abstained).toBe(occluded.n);
    expect(caseResults.flatMap((result) => result.violations)).toHaveLength(0);
  });

  const GHOST_FLIGHT_FIXTURES = [
    {
      caseId: "afn-sasebo-rally2",
      window: { startMs: 1200, endMs: 4200 },
      minGoldAligned: 6,
      failingGates: { jerkyFraction: true, chronicFraction: true },
    },
    {
      caseId: "wavea-wgm-wheelchair",
      window: { startMs: 181600, endMs: 183600 },
      minGoldAligned: 7,
      failingGates: { jerkyFraction: true, chronicFraction: false },
    },
    {
      caseId: "wavea-sasebo-volleys",
      window: { startMs: 52700, endMs: 54300 },
      minGoldAligned: 7,
      failingGates: { jerkyFraction: false, chronicFraction: true },
    },
  ] as const;

  it.each(GHOST_FLIGHT_FIXTURES)(
    "ghost flight in $caseId $window.startMs-$window.endMs: a track carrying >=$minGoldAligned gold points exists but is gate-rejected, and force-gating it does not make it primary (known failure)",
    ({ caseId, window, minGoldAligned, failingGates }) => {
      const { labels, file } = loadCase(caseId);
      const { gated, all, fragments, ablation } = buildBallTracks(file, EMPTY_POSE, window, null);

      const ghost = all
        .map((track) => ({ track, aligned: goldAlignedCount(track, labels) }))
        .filter((entry) => entry.aligned >= minGoldAligned)
        .sort((a, b) => b.aligned - a.aligned)[0];
      expect(ghost).toBeDefined();
      const { track } = ghost!;

      // The evidence is present but the stage-C gates reject the track.
      expect(gated.some((candidate) => candidate.trackId === track.trackId)).toBe(false);
      expect(track.jerkyFraction > BALL_GATES2.maxJerkyFraction).toBe(failingGates.jerkyFraction);
      expect(track.chronicFraction > BALL_GATES2.maxChronicFraction).toBe(
        failingGates.chronicFraction,
      );

      // Even force-gated in, primary selection does not pick it: a gate-only
      // relaxation cannot recover these failures at head.
      const counterfactual = selectPrimaryBallTrack(
        [...gated, track],
        structuredClone(ablation),
        window,
        { paddleTrackExists: false, fragments },
      );
      const pickedGhost =
        counterfactual.status === "tracked" && counterfactual.lab.trackId === track.trackId;
      expect(pickedGhost).toBe(false);
    },
  );
});
