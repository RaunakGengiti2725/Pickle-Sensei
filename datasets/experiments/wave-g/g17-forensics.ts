/**
 * G17 worst-slice forensics — per-failure evidence dump for every OBSERVED
 * failure of the ball tracker on the D2-06 hard-slice gold (the worst
 * N>=5 slice at integration head: OBSERVED hits 9/35).
 *
 * Read-only over committed data and production tracker code; writes a JSON
 * evidence file under wave-g. Run from packages/swing-lab:
 *
 *   pnpm exec tsx ../../datasets/experiments/wave-g/g17-forensics.ts
 *
 * For every OBSERVED gold label that is not a hit, this records:
 *  - the eval outcome (miss / wrongLocation) under the exact eval criteria
 *    (BALL_MATCH_TOLERANCE_MS = 40ms, BALL_HIT_RADIUS = 0.05)
 *  - raw candidate evidence near the gold point (was there anything for the
 *    tracker to see at all?)
 *  - the carrier track containing a gold-aligned candidate, if any, with its
 *    full gate/eligibility scorecard (which stage rejected it)
 *  - what the primary track emitted near the gold time instead
 *  - a mechanical stage classification:
 *      CANDIDATE_GEN   no raw motion candidate within the hit radius at ±40ms
 *      ASSOCIATION_DROP raw candidate existed but landed in no >=3-obs chain
 *      GATE_REJECT     carrier track failed stage-C physics/context gates
 *      SELECTION_LOSS  carrier track was gated-in but lost primary selection
 *      PRIMARY_GAP     the primary track itself carried no observation within
 *                      ±40ms of the gold time (association gap on the primary)
 *      PRIMARY_OFFSET  the primary emitted an observation at the gold time but
 *                      at the wrong location (wrong candidate won association)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoseSequence } from "@pickle/swing-domain";
import type { BallFrameLabel } from "../../../packages/swing-lab/src/annotationSchema.js";
import {
  BALL_HIT_RADIUS,
  BALL_MATCH_TOLERANCE_MS,
} from "../../../packages/swing-lab/src/ballBench.js";
import { bucketForBallLabel } from "../../../packages/swing-lab/src/ballOcclusionBench.js";
import {
  BALL_GATES2,
  BALL_OCCLUSION,
  buildBallTracks,
  selectPrimaryBallTrack,
  type BallCandidateFile,
  type BallTrackCandidate,
} from "../../../packages/swing-lab/src/ballTracker.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const experimentDir = join(repoRoot, "datasets/experiments/wave-e/e12-ball-hard-slices");

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
  clock: string;
  windows: ManifestWindow[];
}
interface Manifest {
  cases: ManifestCase[];
  slices: Record<string, Array<{ case: string; tMs: number[] }>>;
}

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

function shiftClock(file: BallCandidateFile, offsetMs: number): BallCandidateFile {
  if (offsetMs === 0) return file;
  return {
    ...file,
    window: { startMs: file.window.startMs - offsetMs, endMs: file.window.endMs - offsetMs },
    frames: file.frames.map((frame) => ({ ...frame, tMs: frame.tMs - offsetMs })),
  };
}

/** The exact stable stage-C gate conditions from buildBallTracks, itemized. */
function gateScorecard(track: BallTrackCandidate): Record<string, boolean> {
  return {
    maxSpeed: track.maxSpeed <= BALL_GATES2.maxSpeedNormPerSec,
    minMedianSpeed: track.medianSpeed >= BALL_GATES2.minMedianSpeedNormPerSec,
    jerkyFraction: track.jerkyFraction <= BALL_GATES2.maxJerkyFraction,
    chronicFraction: track.chronicFraction <= BALL_GATES2.maxChronicFraction,
    inBandFraction: track.inBandFraction >= BALL_GATES2.minInBandFraction,
    medianArea: track.medianArea <= BALL_GATES2.maxMedianAreaPx,
    coherence: track.coherentMotionFraction <= BALL_GATES2.maxCoherentMotionFraction,
  };
}

/** The primary-eligibility conditions from selectPrimaryBallTrack, itemized
 * (pose-free proxy: paddleTrackExists=false). */
function eligibilityScorecard(track: BallTrackCandidate): Record<string, boolean> {
  return {
    windowOverlap: track.windowOverlapMs >= BALL_GATES2.minWindowOverlapMs,
    minObservations: track.observations.length >= BALL_OCCLUSION.minPrimaryObservations,
    minPrimaryMedianSpeed: track.medianSpeed >= BALL_GATES2.minPrimaryMedianSpeed,
    bodyDwell: track.bodyDwellFraction <= BALL_GATES2.maxBodyDwellFraction,
    paddleProximity:
      track.minPaddleDistance !== null
        ? track.minPaddleDistance <= BALL_GATES2.maxPrimaryPaddleDistance
        : true,
  };
}

interface TrackSummary {
  trackId: number;
  observations: number;
  firstMs: number;
  lastMs: number;
  medianSpeed: number;
  maxSpeed: number;
  jerkyFraction: number;
  chronicFraction: number;
  straightness: number;
  coherentMotionFraction: number;
  medianArea: number;
  windowOverlapMs: number;
}

function summarize(track: BallTrackCandidate): TrackSummary {
  return {
    trackId: track.trackId,
    observations: track.observations.length,
    firstMs: Math.round(track.observations[0]!.timestampMs),
    lastMs: Math.round(track.observations[track.observations.length - 1]!.timestampMs),
    medianSpeed: round3(track.medianSpeed),
    maxSpeed: round3(track.maxSpeed),
    jerkyFraction: round3(track.jerkyFraction),
    chronicFraction: round3(track.chronicFraction),
    straightness: round3(track.straightness),
    coherentMotionFraction: round3(track.coherentMotionFraction),
    medianArea: round3(track.medianArea),
    windowOverlapMs: Math.round(track.windowOverlapMs),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const manifest = JSON.parse(readFileSync(join(experimentDir, "manifest.json"), "utf8")) as Manifest;

const failures: unknown[] = [];
let observedN = 0;
let observedHits = 0;

for (const benchCase of manifest.cases) {
  const annotation = JSON.parse(readFileSync(resolve(experimentDir, benchCase.labels), "utf8")) as {
    ballFrames?: BallFrameLabel[];
  };
  const labels = annotation.ballFrames ?? [];
  const rawFile = JSON.parse(
    readFileSync(resolve(experimentDir, benchCase.candidates), "utf8"),
  ) as BallCandidateFile;
  const file = shiftClock(rawFile, benchCase.clockOffsetMs);

  // Per-window tracker state, exactly as the eval runs it.
  const windowRuns = benchCase.windows.map((window) => {
    const { gated, all, fragments, ablation } = buildBallTracks(file, EMPTY_POSE, window, null);
    const outcome = selectPrimaryBallTrack(gated, ablation, window, {
      paddleTrackExists: false,
      fragments,
    });
    return { window, gated, all, fragments, ablation, outcome };
  });
  const predictions = windowRuns.flatMap((run) =>
    run.outcome.status === "tracked"
      ? run.outcome.track.observations.map((observation) => ({
          t: observation.timestampMs,
          x: observation.x,
          y: observation.y,
        }))
      : [],
  );

  // Slice membership lookup (which named D2-06 hard slices reference this label).
  const sliceNames = (tMs: number): string[] =>
    Object.entries(manifest.slices)
      .filter(([, members]) =>
        members.some((member) => member.case === benchCase.id && member.tMs.includes(tMs)),
      )
      .map(([name]) => name);

  for (const label of labels) {
    if (bucketForBallLabel(label) !== "OBSERVED") continue;
    observedN += 1;
    const gold = label.point!;

    // Eval criterion: nearest canonical observation in time, then distance.
    let nearest: { t: number; x: number; y: number } | null = null;
    let nearestDelta = Infinity;
    for (const prediction of predictions) {
      const delta = Math.abs(prediction.t - label.tMs);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearest = prediction;
      }
    }
    const matched = nearest && nearestDelta <= BALL_MATCH_TOLERANCE_MS ? nearest : null;
    const matchedError = matched ? Math.hypot(matched.x - gold.x, matched.y - gold.y) : null;
    if (matched && matchedError! <= BALL_HIT_RADIUS) {
      observedHits += 1;
      continue;
    }
    const outcome = matched ? "wrongLocation" : "miss";

    // The window this label falls in (the eval concatenates all windows).
    const run =
      windowRuns.find(
        (candidate) => label.tMs >= candidate.window.startMs && label.tMs <= candidate.window.endMs,
      ) ?? windowRuns[0]!;

    // Raw candidate evidence within the eval time tolerance of the gold time.
    const rawNearby = file.frames
      .filter((frame) => Math.abs(frame.tMs - label.tMs) <= BALL_MATCH_TOLERANCE_MS)
      .flatMap((frame) =>
        frame.candidates.map((candidate) => ({
          tMs: Math.round(frame.tMs),
          distance: round3(Math.hypot(candidate.x - gold.x, candidate.y - gold.y)),
          areaPx: candidate.areaPx,
          score: round3(candidate.score),
          x: round3(candidate.x),
          y: round3(candidate.y),
        })),
      )
      .sort((a, b) => a.distance - b.distance);
    const bestRaw = rawNearby[0] ?? null;
    const detectionPresent = bestRaw !== null && bestRaw.distance <= BALL_HIT_RADIUS;

    // Carrier track: any described track (gated / all / fragments) holding a
    // gold-aligned observation.
    const described: Array<{ pool: "gated" | "all" | "fragments"; track: BallTrackCandidate }> = [
      ...run.gated.map((track) => ({ pool: "gated" as const, track })),
      ...run.all.map((track) => ({ pool: "all" as const, track })),
      ...run.fragments.map((track) => ({ pool: "fragments" as const, track })),
    ];
    let carrier: (typeof described)[number] | null = null;
    let carrierObs: { tMs: number; distance: number } | null = null;
    for (const entry of described) {
      for (const observation of entry.track.observations) {
        if (Math.abs(observation.timestampMs - label.tMs) > BALL_MATCH_TOLERANCE_MS) continue;
        const distance = Math.hypot(observation.x - gold.x, observation.y - gold.y);
        if (distance > BALL_HIT_RADIUS) continue;
        // Prefer gated carriers over merely-associated ones.
        if (
          carrier === null ||
          (carrier.pool !== "gated" && entry.pool === "gated") ||
          (carrier.pool === entry.pool && distance < carrierObs!.distance)
        ) {
          carrier = entry;
          carrierObs = { tMs: Math.round(observation.timestampMs), distance: round3(distance) };
        }
      }
    }

    // Counterfactuals (measured, not speculated):
    //  - goldAlignedCount: how many of this case's OBSERVED gold labels the
    //    carrier track matches within the eval criteria (what a perfect
    //    gate/selection fix could recover from THIS track alone)
    //  - wouldWinSelectionIfGated: re-run primary selection with the carrier
    //    force-included in the gated pool
    let goldAlignedCount: number | null = null;
    let wouldWinSelectionIfGated: boolean | null = null;
    if (carrier !== null) {
      goldAlignedCount = labels.filter((other) => {
        if (bucketForBallLabel(other) !== "OBSERVED") return false;
        return carrier!.track.observations.some(
          (observation) =>
            Math.abs(observation.timestampMs - other.tMs) <= BALL_MATCH_TOLERANCE_MS &&
            Math.hypot(observation.x - other.point!.x, observation.y - other.point!.y) <=
              BALL_HIT_RADIUS,
        );
      }).length;
      const pool = run.gated.some((track) => track.trackId === carrier.track.trackId)
        ? run.gated
        : [...run.gated, carrier.track];
      const counterfactual = selectPrimaryBallTrack(
        pool,
        structuredClone(run.ablation),
        run.window,
        { paddleTrackExists: false, fragments: run.fragments },
      );
      wouldWinSelectionIfGated =
        counterfactual.status === "tracked" && counterfactual.lab.trackId === carrier.track.trackId;
    }

    const primaryTrackId = run.outcome.status === "tracked" ? run.outcome.lab.trackId : null;
    const primaryIsCarrier =
      carrier !== null && primaryTrackId !== null && carrier.track.trackId === primaryTrackId;

    let stage: string;
    if (!detectionPresent) {
      stage = "CANDIDATE_GEN";
    } else if (carrier === null) {
      stage = "ASSOCIATION_DROP";
    } else if (primaryIsCarrier) {
      stage = outcome === "miss" ? "PRIMARY_GAP" : "PRIMARY_OFFSET";
    } else {
      const gatedIn = run.gated.some((track) => track.trackId === carrier!.track.trackId);
      stage = gatedIn ? "SELECTION_LOSS" : "GATE_REJECT";
    }
    // PRIMARY_GAP/PRIMARY_OFFSET when the primary itself is not the carrier
    // but no better story exists: if the carrier is the primary we said so;
    // if outcome is wrongLocation the emitted point came from the primary.

    failures.push({
      case: benchCase.id,
      tMs: label.tMs,
      gold: { x: gold.x, y: gold.y },
      slices: sliceNames(label.tMs),
      window: run.window,
      outcome,
      nearestEmitted: nearest
        ? {
            t: Math.round(nearest.t),
            deltaMs: Math.round(nearestDelta),
            x: round3(nearest.x),
            y: round3(nearest.y),
            distanceToGold: round3(Math.hypot(nearest.x - gold.x, nearest.y - gold.y)),
            withinTolerance: nearestDelta <= BALL_MATCH_TOLERANCE_MS,
          }
        : null,
      rawEvidence: {
        candidatesWithinTolerance: rawNearby.length,
        best: bestRaw,
        detectionPresentAtGold: detectionPresent,
      },
      carrierTrack: carrier
        ? {
            pool: carrier.pool,
            gatedIn: run.gated.some((track) => track.trackId === carrier!.track.trackId),
            isPrimary: primaryIsCarrier,
            goldAlignedObservation: carrierObs,
            goldAlignedCount,
            wouldWinSelectionIfGated,
            summary: summarize(carrier.track),
            gateScorecard: gateScorecard(carrier.track),
            eligibilityScorecard: eligibilityScorecard(carrier.track),
          }
        : null,
      primary:
        run.outcome.status === "tracked"
          ? {
              trackId: primaryTrackId,
              selection: run.outcome.selection,
              summary: summarize(run.outcome.lab),
            }
          : { untracked: run.outcome.reason },
      stage,
    });
  }
}

const output = {
  id: "g17-worst-slice-forensics",
  generatedBy: "datasets/experiments/wave-g/g17-forensics.ts",
  criteria: {
    hitRadius: BALL_HIT_RADIUS,
    matchToleranceMs: BALL_MATCH_TOLERANCE_MS,
    poseFreeProxy: true,
    paddleTrack: null,
  },
  slice: "BALL OBSERVED bucket, D2-06 hard-slice gold (LINUX-CPU pose-free proxy)",
  observed: { n: observedN, hits: observedHits, failures: failures.length },
  stageHistogram: failures.reduce<Record<string, number>>((histogram, failure) => {
    const stage = (failure as { stage: string }).stage;
    histogram[stage] = (histogram[stage] ?? 0) + 1;
    return histogram;
  }, {}),
  failures,
};

const outPath = join(here, "g17-forensics-evidence.json");
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`observed n=${observedN} hits=${observedHits} failures=${failures.length}`);
console.log(JSON.stringify(output.stageHistogram, null, 2));
console.log(`written to ${outPath}`);
