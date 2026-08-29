import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePoseSequence, toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";
import type { PaddleFrameLabel } from "./annotationSchema.js";
import {
  buildPaddleTracks,
  mergePaddleTracklets,
  paddleSpeedSeries,
  selectPrimaryPaddleTrack,
  TRACKER_GATES,
  wristSeries,
  type PaddleTrackCandidate,
  type RawPaddleDetectionFile,
  type TrackedPaddleObservation,
} from "./paddleTracker.js";
import {
  buildPlayerTracks,
  duplicateAliasesOf,
  otherPlayersWrists,
  selectTargetPlayer,
  targetPoseSequence,
  type PeopleFile,
} from "./playerTracker.js";
import { proposeStrokeEventsV2 } from "./strokeEvents.js";

/**
 * PADDLE S4 SELECTION FORENSICS (workstream B — diagnostic only, never runtime).
 *
 * The paddle waterfall (paddleWaterfall.ts) measures S3 ownership R 0.49 →
 * S4 primary-selection R 0.27, with afn-sasebo-rally1 collapsing 9/13 → 0/13.
 * This tool explains that loss PER GOLD LABEL by replaying the exact S4 code
 * path (selectPrimaryPaddleTrack) and dumping every score component the
 * selector actually computes, for every candidate:
 *
 *   score = windowCoverage × meanScore × proximityFactor
 *   proximityFactor = meanWristDistance null ? 0.2
 *                   : max(0.1, min(1, 1.25 − meanWristDistance×4))
 *   eligibility     = !otherPlayers && nObs ≥ 5
 *   plus the flip-truncation (sustainedOtherPlayerFlip) applied BEFORE scoring
 *   plus the post-selection abstain gates (ambiguity / coverage / wristDist).
 *
 * Replay parity notes (measured, see B-selection-forensics.json):
 *  - The waterfall replays S3/S4 with MERGED tracklets + AUTO target + NO
 *    alias suppression; production (runs/&lt;case&gt;/report.json) used user-tapped
 *    seeds WITH aliases and NO merge. Both variants are replayed here so the
 *    waterfall catastrophe and the S5 discrepancy are both explained.
 *  - Everything here is read-only mirroring of paddleTracker.ts internals;
 *    the two private helpers (nearestWrists / sustainedOtherPlayerFlip) are
 *    copied VERBATIM below and parity-checked against the real selector on
 *    every case (winner + status + reason must match, or the case is flagged).
 *
 * Run:  cd packages/swing-lab && npx tsx src/paddleSelectionForensics.ts
 * Artifacts: datasets/experiments/wave-a/B-selection-forensics.json
 */

const HIT_RADIUS = 0.08; // mirror paddleWaterfall.ts
const MATCH_TOLERANCE_MS = 40; // mirror paddleWaterfall.ts
const HERE = dirname(fileURLToPath(import.meta.url));
const PB = resolve(HERE, "../../../datasets/paddle-bench");
const WAVE_A = resolve(HERE, "../../../datasets/experiments/wave-a");

// ── read-only mirrors of paddleTracker.ts PRIVATE helpers (verbatim) ──────

function nearestWrists(
  wrists: ReturnType<typeof wristSeries>,
  timestampMs: number,
): Array<{ x: number; y: number }> | null {
  let best: (typeof wrists)[number] | null = null;
  let bestDelta = Infinity;
  for (const entry of wrists) {
    const delta = Math.abs(entry.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = entry;
    }
  }
  return best && bestDelta <= 60 && best.wrists.length > 0 ? best.wrists : null;
}

function sustainedOtherPlayerFlip(
  observations: readonly TrackedPaddleObservation[],
  wrists: ReturnType<typeof wristSeries>,
  otherWrists: ReturnType<typeof wristSeries>,
): number | null {
  let runStart: number | null = null;
  let runLength = 0;
  for (const [index, observation] of observations.entries()) {
    const target = nearestWrists(wrists, observation.timestampMs);
    const other = nearestWrists(otherWrists, observation.timestampMs);
    if (!target || !other) {
      runStart = null;
      runLength = 0;
      continue;
    }
    const targetDistance = Math.min(
      ...target.map((wrist) =>
        Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
      ),
    );
    const otherDistance = Math.min(
      ...other.map((wrist) =>
        Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
      ),
    );
    if (otherDistance < targetDistance * 0.7) {
      if (runStart === null) runStart = index;
      runLength += 1;
      if (runLength >= 3) return runStart;
    } else {
      runStart = null;
      runLength = 0;
    }
  }
  return null;
}

/** analyzeVideo.ts private helper, mirrored for the event-gated counterfactual. */
function dominantWristSpeeds(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number },
): Array<{ timestampMs: number; value: number }> {
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  const perWrist: Record<"left" | "right", Array<{ timestampMs: number; value: number }>> = {
    left: [],
    right: [],
  };
  const legacy = toLegacyPoseFrames(sequence);
  for (const frame of legacy) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[sideName];
      if (prior) {
        const series = perWrist[sideName];
        const dtSec =
          series.length > 0
            ? (frame.timestampMs - series[series.length - 1]!.timestampMs) / 1000
            : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          series.push({ timestampMs: frame.timestampMs, value: step / dtSec });
          if (frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs) {
            travel[sideName] += step;
          }
        }
      }
      last[sideName] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}

// ── scoring explainer (mirror of selectPrimaryPaddleTrack internals) ──────

interface ExplainedCandidate {
  trackId: number;
  nObsFull: number;
  nObsAfterFlip: number;
  flipAtMs: number | null;
  firstMs: number;
  lastMs: number;
  /** score TERMS exactly as the selector computes them */
  windowCoverage: number;
  meanScore: number;
  meanWristDistance: number | null;
  meanOtherDistance: number | null;
  proximityFactor: number;
  handAffinity: number; // computed by the selector but UNUSED in the score
  score: number;
  otherPlayers: boolean; // ownership rejection
  eligible: boolean;
  rankAll: number; // 1-based rank by score over all candidates
  rankEligible: number | null;
  /** gold coverage */
  hitsFull: Set<number>; // label indices hit by the FULL observation list
  hitsAfterFlip: Set<number>; // label indices hit AFTER flip truncation
  observationsAfterFlip: TrackedPaddleObservation[];
}

function labelHits(
  observations: readonly TrackedPaddleObservation[],
  visibleLabels: readonly PaddleFrameLabel[],
): Set<number> {
  const hit = new Set<number>();
  for (const [index, label] of visibleLabels.entries()) {
    if (!label.point) continue;
    for (const observation of observations) {
      if (Math.abs(observation.timestampMs - label.tMs) > MATCH_TOLERANCE_MS) continue;
      if (
        Math.hypot(observation.center.x - label.point.x, observation.center.y - label.point.y) <=
        HIT_RADIUS
      ) {
        hit.add(index);
        break;
      }
    }
  }
  return hit;
}

function explainCandidates(
  candidates: readonly PaddleTrackCandidate[],
  wrists: ReturnType<typeof wristSeries>,
  window: { startMs: number; endMs: number },
  otherWrists: ReturnType<typeof wristSeries>,
  visibleLabels: readonly PaddleFrameLabel[],
): ExplainedCandidate[] {
  const explained = candidates.map((candidate) => {
    let observations = candidate.observations;
    let flipAtMs: number | null = null;
    if (otherWrists.length > 0) {
      const flipIndex = sustainedOtherPlayerFlip(observations, wrists, otherWrists);
      if (flipIndex !== null && flipIndex >= TRACKER_GATES.minObservations) {
        flipAtMs = observations[flipIndex]!.timestampMs;
        observations = observations.slice(0, flipIndex);
      }
    }
    const inWindow = observations.filter(
      (observation) =>
        observation.timestampMs >= window.startMs && observation.timestampMs <= window.endMs,
    );
    const judged = inWindow.length > 0 ? inWindow : observations;
    const targetDistances: number[] = [];
    const otherDistances: number[] = [];
    for (const observation of judged) {
      const nearest = nearestWrists(wrists, observation.timestampMs);
      if (nearest) {
        targetDistances.push(
          Math.min(
            ...nearest.map((wrist) =>
              Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
            ),
          ),
        );
      }
      const nearestOther = nearestWrists(otherWrists, observation.timestampMs);
      if (nearestOther) {
        otherDistances.push(
          Math.min(
            ...nearestOther.map((wrist) =>
              Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
            ),
          ),
        );
      }
    }
    const meanWristDistance = targetDistances.length > 0 ? mean(targetDistances) : null;
    const meanOtherDistance = otherDistances.length > 0 ? mean(otherDistances) : null;
    const otherPlayers =
      meanWristDistance !== null &&
      meanOtherDistance !== null &&
      meanOtherDistance < meanWristDistance * 0.85;
    const handHits = targetDistances.filter(
      (distance) => distance <= TRACKER_GATES.handAffinityRadius,
    ).length;
    const handAffinity = targetDistances.length > 0 ? handHits / targetDistances.length : 0;
    const proximityFactor =
      meanWristDistance === null ? 0.2 : Math.max(0.1, Math.min(1, 1.25 - meanWristDistance * 4));
    const score = candidate.windowCoverage * candidate.meanScore * proximityFactor;
    const entry: ExplainedCandidate = {
      trackId: candidate.trackId,
      nObsFull: candidate.observations.length,
      nObsAfterFlip: observations.length,
      flipAtMs,
      firstMs: candidate.observations[0]!.timestampMs,
      lastMs: candidate.observations[candidate.observations.length - 1]!.timestampMs,
      windowCoverage: candidate.windowCoverage,
      meanScore: candidate.meanScore,
      meanWristDistance,
      meanOtherDistance,
      proximityFactor,
      handAffinity,
      score,
      otherPlayers,
      eligible: !otherPlayers && observations.length >= TRACKER_GATES.minObservations,
      rankAll: 0,
      rankEligible: null,
      hitsFull: labelHits(candidate.observations, visibleLabels),
      hitsAfterFlip: labelHits(observations, visibleLabels),
      observationsAfterFlip: observations,
    };
    return entry;
  });
  const byScore = [...explained].sort((a, b) => b.score - a.score);
  for (const [index, entry] of byScore.entries()) entry.rankAll = index + 1;
  let eligibleRank = 0;
  for (const entry of byScore) {
    if (entry.eligible) {
      eligibleRank += 1;
      entry.rankEligible = eligibleRank;
    }
  }
  return explained;
}

// ── counterfactual selection objectives (diagnostic only) ─────────────────

interface CounterfactualResult {
  name: string;
  winnerTrackId: number | null;
  winnerHits: number;
  winnerScore: number | null;
  oracleRank: number | null; // rank of the oracle track under this objective
  top2UnionHits: number;
  top3UnionHits: number;
}

function unionHits(entries: readonly ExplainedCandidate[], useFull: boolean): number {
  const set = new Set<number>();
  for (const entry of entries) {
    for (const index of useFull ? entry.hitsFull : entry.hitsAfterFlip) set.add(index);
  }
  return set.size;
}

function rankCounterfactual(
  name: string,
  explained: readonly ExplainedCandidate[],
  scoreOf: (entry: ExplainedCandidate) => number,
  oracleTrackId: number | null,
): CounterfactualResult {
  const eligible = explained.filter((entry) => entry.nObsFull >= TRACKER_GATES.minObservations);
  const ranked = [...eligible].sort((a, b) => scoreOf(b) - scoreOf(a));
  const positives = ranked.filter((entry) => scoreOf(entry) > 0);
  const winner = positives[0] ?? null;
  const oracleRank =
    oracleTrackId === null
      ? null
      : (() => {
          const index = ranked.findIndex((entry) => entry.trackId === oracleTrackId);
          return index >= 0 ? index + 1 : null;
        })();
  return {
    name,
    winnerTrackId: winner ? winner.trackId : null,
    winnerHits: winner ? winner.hitsFull.size : 0,
    winnerScore: winner ? round(scoreOf(winner)) : null,
    oracleRank,
    top2UnionHits: unionHits(positives.slice(0, 2), true),
    top3UnionHits: unionHits(positives.slice(0, 3), true),
  };
}

function pearson(pairs: ReadonlyArray<[number, number]>): number | null {
  if (pairs.length < 6) return null;
  const n = pairs.length;
  const meanA = pairs.reduce((total, pair) => total + pair[0], 0) / n;
  const meanB = pairs.reduce((total, pair) => total + pair[1], 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const [a, b] of pairs) {
    cov += (a - meanA) * (b - meanB);
    varA += (a - meanA) ** 2;
    varB += (b - meanB) ** 2;
  }
  if (varA <= 1e-12 || varB <= 1e-12) return null;
  return cov / Math.sqrt(varA * varB);
}

// ── utilities ──────────────────────────────────────────────────────────────

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

interface Span {
  startMs: number;
  endMs: number;
}

function inAnySpan(timestampMs: number, spans: readonly Span[]): boolean {
  return spans.some((span) => timestampMs >= span.startMs && timestampMs <= span.endMs);
}

// ── main ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("paddleSelectionForensics.ts");
if (isMain) {
  const bench = JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
  };

  interface CaseArtifact {
    id: string;
    role: string;
    visible: number;
    window: Span;
    parity: { matchesRealSelector: boolean; realStatus: string; realReason: string | null };
    selection: {
      status: string;
      reason: string | null;
      winnerTrackId: number | null;
      rejectedOtherPlayerTracks: number;
      switchEvents: Array<{ atMs: number }>;
      firedGate: string | null;
    };
    candidates: Array<Record<string, unknown>>;
    labels: Array<{
      tMs: number;
      matchedTrackIds: number[];
      matchedEligibleTrackIds: number[];
      s3Survived: boolean;
      s4WinnerCoversFull: boolean;
      s4WinnerCoversAfterFlip: boolean;
    }>;
    oracle: {
      trackId: number | null;
      hits: number;
      rankAll: number | null;
      rankEligible: number | null;
      verdict: string;
      termRatiosVsWinner: Record<string, number> | null;
    };
    lossWaterfall: { top1: number; top2: number; top3: number };
    counterfactuals: CounterfactualResult[];
    aliasVariant: {
      note: string;
      winnerTrackId: number | null;
      flipAtMs: number | null;
      hitsFull: number;
      hitsAfterFlip: number;
    };
    productionParity: {
      note: string;
      winnerTrackId: number | null;
      winnerHitsFull: number;
      status: string;
    };
  }

  const artifacts: CaseArtifact[] = [];
  const aggregates = new Map<string, Map<string, { hits: number; visible: number }>>();
  const bump = (cfName: string, role: string, hits: number, visible: number) => {
    const byRole = aggregates.get(cfName) ?? new Map<string, { hits: number; visible: number }>();
    const entry = byRole.get(role) ?? { hits: 0, visible: 0 };
    entry.hits += hits;
    entry.visible += visible;
    byRole.set(role, entry);
    aggregates.set(cfName, byRole);
  };

  for (const benchCase of bench.cases) {
    const role = (benchCase.role ?? "unassigned").includes("held_out") ? "held_out" : "dev";
    const runDir = join(PB, benchCase.runDir);
    const detsPath = join(runDir, "paddle-dets.json");
    const posePath = join(runDir, "pose.json");
    const peoplePath = join(runDir, "people.json");
    const reportPath = join(runDir, "report.json");
    if (!existsSync(detsPath) || !existsSync(posePath) || !existsSync(reportPath)) continue;
    const annotation = JSON.parse(readFileSync(join(PB, benchCase.labels), "utf8")) as {
      paddleFrames?: PaddleFrameLabel[];
    };
    const labels = annotation.paddleFrames ?? [];
    if (labels.length === 0) continue;
    const visibleLabels = labels.filter((label) => label.visibility === "visible" && label.point);
    const dets = JSON.parse(readFileSync(detsPath, "utf8")) as RawPaddleDetectionFile;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      window?: Span | null;
    };
    const window = report.window ?? { startMs: 0, endMs: 1e9 };

    // Candidate formation — waterfall parity (ALWAYS merged).
    const rawCandidates = buildPaddleTracks(dets, window);
    const { merged: candidates } = mergePaddleTracklets(rawCandidates, window);

    // Identity — waterfall parity (auto target, NO alias suppression).
    const poseParsed = parsePoseSequence(readFileSync(posePath, "utf8"), {
      providerId: "pose.apple-vision",
      runtime: "vision_framework",
      executionTarget: "on_device",
      artifactHash: null,
    });
    let targetSequence = poseParsed.ok ? poseParsed.value : null;
    let otherWrists: ReturnType<typeof otherPlayersWrists> = [];
    let aliasOtherWrists: ReturnType<typeof otherPlayersWrists> = [];
    if (existsSync(peoplePath) && targetSequence) {
      const peopleFile = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
      const tracks = buildPlayerTracks(peopleFile);
      const selection = selectTargetPlayer(tracks, { policy: "auto" }, null);
      if (selection.ok) {
        targetSequence = targetPoseSequence(peopleFile, selection.value.target);
        otherWrists = otherPlayersWrists(selection.value.allTracks, selection.value.target.trackId);
        // Production parity: alias tracks of the same human suppressed.
        const aliases = duplicateAliasesOf(selection.value.target, selection.value.allTracks);
        aliasOtherWrists = otherPlayersWrists(
          selection.value.allTracks,
          selection.value.target.trackId,
          aliases,
        );
      }
    }
    const wrists = targetSequence ? wristSeries(targetSequence) : [];

    // ── real selector (parity reference) ─────────────────────────────────
    const outcome = selectPrimaryPaddleTrack(candidates, wrists, window, otherWrists);

    // ── explained replica of the SAME call ───────────────────────────────
    const explained = explainCandidates(candidates, wrists, window, otherWrists, visibleLabels);
    const byScore = [...explained].sort((a, b) => a.rankAll - b.rankAll);
    const eligibleByScore = byScore.filter((entry) => entry.eligible);
    const rejectedOtherPlayerTracks = explained.filter((entry) => entry.otherPlayers).length;

    // Replicate the post-selection gates to name the fired gate.
    let replicaStatus = "untracked";
    let replicaWinner: ExplainedCandidate | null = null;
    let firedGate: string | null = null;
    if (eligibleByScore.length === 0) {
      firedGate =
        rejectedOtherPlayerTracks > 0
          ? "only_other_players_paddles_found"
          : "no_tracks_formed_near_target";
    } else {
      const best = eligibleByScore[0]!;
      const runnerUp = eligibleByScore[1];
      const margin = runnerUp && runnerUp.score > 0 ? best.score / runnerUp.score : null;
      if (
        runnerUp &&
        margin !== null &&
        margin < 1.25 &&
        runnerUp.meanWristDistance !== null &&
        best.meanWristDistance !== null &&
        Math.abs(runnerUp.meanWristDistance - best.meanWristDistance) > 0.05
      ) {
        firedGate = "paddle_association_ambiguous";
      } else if (best.windowCoverage < TRACKER_GATES.minWindowCoverage) {
        firedGate = "best_track_low_window_coverage";
      } else if (
        best.meanWristDistance === null ||
        best.meanWristDistance > TRACKER_GATES.maxMeanWristDistance
      ) {
        firedGate =
          best.meanWristDistance === null
            ? "no_wrist_measurements_to_gate_against"
            : "best_track_far_from_wrists";
      } else {
        replicaStatus = "tracked";
        replicaWinner = best;
      }
    }
    const realWinnerId = outcome.status === "tracked" ? outcome.lab.trackId : null;
    const parityOk =
      (outcome.status === "tracked") === (replicaStatus === "tracked") &&
      realWinnerId === (replicaWinner ? replicaWinner.trackId : null);

    // ── per-label S3→S4 accounting ───────────────────────────────────────
    // Waterfall S3 definition: if nothing was ownership-rejected all
    // candidates survive; otherwise only the tracked winner (FULL obs list,
    // because the waterfall scores `candidates`, not the truncated lab).
    const s3Survivors =
      rejectedOtherPlayerTracks === 0
        ? explained
        : replicaWinner
          ? explained.filter((entry) => entry.trackId === replicaWinner!.trackId)
          : [];
    const labelRows = visibleLabels.map((label, index) => {
      const matched = explained.filter((entry) => entry.hitsFull.has(index));
      return {
        tMs: label.tMs,
        matchedTrackIds: matched.map((entry) => entry.trackId),
        matchedEligibleTrackIds: matched
          .filter((entry) => entry.eligible)
          .map((entry) => entry.trackId),
        s3Survived: s3Survivors.some((entry) => entry.hitsFull.has(index)),
        s4WinnerCoversFull: replicaWinner ? replicaWinner.hitsFull.has(index) : false,
        s4WinnerCoversAfterFlip: replicaWinner ? replicaWinner.hitsAfterFlip.has(index) : false,
      };
    });

    // ── oracle analysis ──────────────────────────────────────────────────
    const oracle = explained.reduce<ExplainedCandidate | null>(
      (best, entry) => (entry.hitsFull.size > (best?.hitsFull.size ?? 0) ? entry : best),
      null,
    );
    let verdict = "no oracle track (no candidate touches any gold label)";
    let termRatios: Record<string, number> | null = null;
    if (oracle) {
      const winner = replicaWinner;
      if (winner && winner.trackId === oracle.trackId) {
        const lost = oracle.hitsFull.size - oracle.hitsAfterFlip.size;
        verdict =
          lost > 0
            ? `selector PICKED the oracle track, but sustainedOtherPlayerFlip truncated it at ${oracle.flipAtMs}ms ` +
              `(${oracle.nObsFull}→${oracle.nObsAfterFlip} obs), deleting ${lost}/${oracle.hitsFull.size} gold hits ` +
              `before the waterfall scored S4`
            : "selector picked the oracle track intact";
      } else if (!oracle.eligible) {
        verdict = oracle.otherPlayers
          ? `oracle track ${oracle.trackId} was REJECTED by ownership: meanOtherDistance ` +
            `${round(oracle.meanOtherDistance ?? Number.NaN, 3)} < 0.85 × meanWristDistance ` +
            `${round(oracle.meanWristDistance ?? Number.NaN, 3)}`
          : `oracle track ${oracle.trackId} ineligible: only ${oracle.nObsAfterFlip} obs after flip truncation (< ${TRACKER_GATES.minObservations})`;
      } else if (firedGate) {
        verdict = `selector abstained (${firedGate}); oracle track ${oracle.trackId} was rank ${oracle.rankEligible} among eligibles`;
      } else if (winner) {
        termRatios = {
          coverageRatio: round(winner.windowCoverage / Math.max(1e-9, oracle.windowCoverage)),
          meanScoreRatio: round(winner.meanScore / Math.max(1e-9, oracle.meanScore)),
          proximityRatio: round(winner.proximityFactor / Math.max(1e-9, oracle.proximityFactor)),
          scoreRatio: round(winner.score / Math.max(1e-9, oracle.score)),
        };
        const contributions: Array<[string, number]> = [
          ["windowCoverage", Math.log(termRatios["coverageRatio"] ?? 1)],
          ["meanScore", Math.log(termRatios["meanScoreRatio"] ?? 1)],
          ["proximityFactor", Math.log(termRatios["proximityRatio"] ?? 1)],
        ];
        contributions.sort((a, b) => b[1] - a[1]);
        verdict =
          `oracle track ${oracle.trackId} (rank ${oracle.rankAll}) lost to ${winner.trackId}: ` +
          contributions
            .filter(([, value]) => value > 0)
            .map(([name, value]) => `${name} ×${Math.exp(value).toFixed(2)}`)
            .join(", ");
      }
    }

    // ── loss waterfall: keep top-K eligible candidates by CURRENT score ──
    const lossWaterfall = {
      top1: unionHits(eligibleByScore.slice(0, 1), true),
      top2: unionHits(eligibleByScore.slice(0, 2), true),
      top3: unionHits(eligibleByScore.slice(0, 3), true),
    };

    // ── counterfactual objectives ────────────────────────────────────────
    // Event spans from POSE-ONLY pre-pass proposals (production-available;
    // mirrors analyzeVideo's detect-span gating incl. its 600ms context pad).
    const wristSpeeds = targetSequence ? dominantWristSpeeds(targetSequence, window) : [];
    const prePass = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds,
      clipStartMs: window.startMs,
      clipEndMs: window.endMs,
    });
    const EVENT_PAD_MS = 600;
    const eventSpans: Span[] =
      prePass.events.length > 0
        ? prePass.events.map((event) => ({
            startMs: Math.max(window.startMs, event.startMs - EVENT_PAD_MS),
            endMs: Math.min(window.endMs, event.endMs + EVENT_PAD_MS),
          }))
        : [window];
    const eventSpanLength = Math.max(
      1,
      eventSpans.reduce((total, span) => total + (span.endMs - span.startMs), 0),
    );

    const inHandMass = (entry: ExplainedCandidate, spans: readonly Span[] | null): number => {
      let mass = 0;
      for (const observation of entry.observationsAfterFlip) {
        if (spans && !inAnySpan(observation.timestampMs, spans)) continue;
        if (
          !spans &&
          (observation.timestampMs < window.startMs || observation.timestampMs > window.endMs)
        )
          continue;
        const nearest = nearestWrists(wrists, observation.timestampMs);
        if (!nearest) continue;
        const distance = Math.min(
          ...nearest.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        );
        mass += Math.exp(-((distance / TRACKER_GATES.handAffinityRadius) ** 2));
      }
      return mass;
    };

    const eventGatedCoverage = (entry: ExplainedCandidate): number => {
      const inEvent = entry.observationsAfterFlip.filter((observation) =>
        inAnySpan(observation.timestampMs, eventSpans),
      );
      if (inEvent.length < 2) return 0;
      const span = inEvent[inEvent.length - 1]!.timestampMs - inEvent[0]!.timestampMs;
      const coverage = Math.min(1, span / eventSpanLength);
      const proximity =
        entry.meanWristDistance === null
          ? 0.2
          : Math.max(0.1, Math.min(1, 1.25 - entry.meanWristDistance * 4));
      return coverage * entry.meanScore * proximity;
    };

    const speedCorrelation = (entry: ExplainedCandidate): number => {
      const paddleSpeeds = paddleSpeedSeries(entry.observationsAfterFlip);
      const pairs: Array<[number, number]> = [];
      for (const sample of paddleSpeeds) {
        let best: { delta: number; value: number } | null = null;
        for (const wristSample of wristSpeeds) {
          const delta = Math.abs(wristSample.timestampMs - sample.timestampMs);
          if (delta <= MATCH_TOLERANCE_MS && (!best || delta < best.delta)) {
            best = { delta, value: wristSample.value };
          }
        }
        if (best) pairs.push([sample.value, best.value]);
      }
      const r = pearson(pairs);
      return r === null ? 0 : Math.max(0, r) * Math.sqrt(pairs.length);
    };

    const oracleId = oracle ? oracle.trackId : null;
    // CF5: same scoring, same merged candidates, but IDENTITY inputs as
    // production builds them (duplicate-alias suppression) — isolates how
    // much of the S4 loss is the waterfall replay's missing alias pass.
    const explainedAlias = explainCandidates(
      candidates,
      wrists,
      window,
      aliasOtherWrists,
      visibleLabels,
    );
    const aliasWinner =
      [...explainedAlias].sort((a, b) => a.rankAll - b.rankAll).find((entry) => entry.eligible) ??
      null;
    const counterfactuals: CounterfactualResult[] = [
      // CF0 keeps the current ranking objective but reports the winner's FULL
      // track hits — i.e. current scoring WITHOUT the flip-truncation deletion.
      rankCounterfactual(
        "CF0 current ranking, no flip deletion",
        explained,
        (entry) => (entry.eligible ? entry.score : 0),
        oracleId,
      ),
      rankCounterfactual("CF1 event-gated coverage", explained, eventGatedCoverage, oracleId),
      rankCounterfactual(
        "CF2 in-hand mass (window)",
        explained,
        (entry) => inHandMass(entry, null),
        oracleId,
      ),
      rankCounterfactual("CF3 wrist-speed correlation", explained, speedCorrelation, oracleId),
      rankCounterfactual(
        "CF4 event-gated in-hand mass",
        explained,
        (entry) => inHandMass(entry, eventSpans),
        oracleId,
      ),
      {
        name: "CF5 current + alias-suppressed identity",
        winnerTrackId: aliasWinner ? aliasWinner.trackId : null,
        // what S4 would MEASURE: the kept (possibly flip-truncated) obs list
        winnerHits: aliasWinner ? aliasWinner.hitsAfterFlip.size : 0,
        winnerScore: aliasWinner ? round(aliasWinner.score, 6) : null,
        oracleRank:
          oracleId === null
            ? null
            : (explainedAlias.find((entry) => entry.trackId === oracleId)?.rankAll ?? null),
        top2UnionHits: unionHits(
          [...explainedAlias]
            .sort((a, b) => a.rankAll - b.rankAll)
            .filter((entry) => entry.eligible)
            .slice(0, 2),
          false,
        ),
        top3UnionHits: unionHits(
          [...explainedAlias]
            .sort((a, b) => a.rankAll - b.rankAll)
            .filter((entry) => entry.eligible)
            .slice(0, 3),
          false,
        ),
      },
    ];
    for (const cf of counterfactuals) {
      bump(cf.name, role, cf.winnerHits, visibleLabels.length);
      bump(`${cf.name} +top2merge`, role, cf.top2UnionHits, visibleLabels.length);
    }
    // Oracle ceiling for reference in aggregates.
    bump(
      "oracle single-track ceiling",
      role,
      oracle ? oracle.hitsFull.size : 0,
      visibleLabels.length,
    );

    // ── production parity replay (raw tracklets + alias suppression) ─────
    const productionOutcome = selectPrimaryPaddleTrack(
      rawCandidates,
      wrists,
      window,
      aliasOtherWrists,
    );
    const productionWinnerHits =
      productionOutcome.status === "tracked"
        ? labelHits(
            rawCandidates.find((entry) => entry.trackId === productionOutcome.lab.trackId)
              ?.observations ?? [],
            visibleLabels,
          ).size
        : 0;

    artifacts.push({
      id: benchCase.id,
      role,
      visible: visibleLabels.length,
      window,
      parity: {
        matchesRealSelector: parityOk,
        realStatus: outcome.status,
        realReason: outcome.status === "untracked" ? outcome.reason : null,
      },
      selection: {
        status: replicaStatus,
        reason: firedGate,
        winnerTrackId: replicaWinner ? replicaWinner.trackId : null,
        rejectedOtherPlayerTracks,
        switchEvents:
          outcome.association?.switchEvents.map((event) => ({ atMs: event.atMs })) ?? [],
        firedGate,
      },
      candidates: byScore.map((entry) => ({
        trackId: entry.trackId,
        rankAll: entry.rankAll,
        rankEligible: entry.rankEligible,
        eligible: entry.eligible,
        otherPlayers: entry.otherPlayers,
        nObsFull: entry.nObsFull,
        nObsAfterFlip: entry.nObsAfterFlip,
        flipAtMs: entry.flipAtMs,
        spanMs: [Math.round(entry.firstMs), Math.round(entry.lastMs)],
        windowCoverage: round(entry.windowCoverage),
        meanScore: round(entry.meanScore),
        meanWristDistance: entry.meanWristDistance === null ? null : round(entry.meanWristDistance),
        meanOtherDistance: entry.meanOtherDistance === null ? null : round(entry.meanOtherDistance),
        proximityFactor: round(entry.proximityFactor),
        handAffinity: round(entry.handAffinity),
        score: round(entry.score, 6),
        goldHitsFull: entry.hitsFull.size,
        goldHitsAfterFlip: entry.hitsAfterFlip.size,
      })),
      labels: labelRows,
      oracle: {
        trackId: oracleId,
        hits: oracle ? oracle.hitsFull.size : 0,
        rankAll: oracle ? oracle.rankAll : null,
        rankEligible: oracle ? oracle.rankEligible : null,
        verdict,
        termRatiosVsWinner: termRatios,
      },
      lossWaterfall,
      counterfactuals,
      aliasVariant: {
        note: "merged candidates + current scoring, but otherWrists built with duplicateAliasesOf (production identity)",
        winnerTrackId: aliasWinner ? aliasWinner.trackId : null,
        flipAtMs: aliasWinner ? aliasWinner.flipAtMs : null,
        hitsFull: aliasWinner ? aliasWinner.hitsFull.size : 0,
        hitsAfterFlip: aliasWinner ? aliasWinner.hitsAfterFlip.size : 0,
      },
      productionParity: {
        note: "raw tracklets (no merge) + duplicate-alias suppression, as analyzeVideo runs it",
        winnerTrackId:
          productionOutcome.status === "tracked" ? productionOutcome.lab.trackId : null,
        winnerHitsFull: productionWinnerHits,
        status: productionOutcome.status,
      },
    });
  }

  // ── console report ────────────────────────────────────────────────────
  const fmtNull = (value: number | null, digits = 3) =>
    value === null ? "  n/a" : value.toFixed(digits);
  for (const artifact of artifacts) {
    console.log("═".repeat(78));
    console.log(
      `${artifact.id} [${artifact.role}] · ${artifact.visible} visible gold labels · ` +
        `window ${Math.round(artifact.window.startMs)}–${Math.round(artifact.window.endMs)}ms`,
    );
    console.log(
      `S4 outcome: ${artifact.selection.status}` +
        (artifact.selection.firedGate ? ` (gate: ${artifact.selection.firedGate})` : "") +
        ` · winner ${artifact.selection.winnerTrackId ?? "—"} · ` +
        `ownership-rejected ${artifact.selection.rejectedOtherPlayerTracks} · ` +
        `parity with real selector: ${artifact.parity.matchesRealSelector ? "OK" : "MISMATCH!"}`,
    );
    console.log(
      "  track  rank elig own  obs(full→cut) flip@ms   cover meanSc wristD otherD prox  affin score    gold(full→cut)",
    );
    for (const candidate of artifact.candidates.slice(0, 8)) {
      const c = candidate;
      const asNullableNumber = (value: unknown): number | null =>
        typeof value === "number" ? value : null;
      console.log(
        `  T${String(c["trackId"]).padEnd(5)}` +
          `${String(c["rankAll"]).padStart(3)} ${String(c["rankEligible"] ?? "—").padStart(4)} ` +
          `${c["otherPlayers"] ? "REJ" : " ok"}  ` +
          `${String(c["nObsFull"]).padStart(4)}→${String(c["nObsAfterFlip"]).padEnd(5)} ` +
          `${String(c["flipAtMs"] ?? "—").padStart(7)} ` +
          `${Number(c["windowCoverage"]).toFixed(3)} ${Number(c["meanScore"]).toFixed(3)}  ` +
          `${fmtNull(asNullableNumber(c["meanWristDistance"]))} ${fmtNull(asNullableNumber(c["meanOtherDistance"]))} ` +
          `${Number(c["proximityFactor"]).toFixed(2)} ${Number(c["handAffinity"]).toFixed(2)} ` +
          `${Number(c["score"]).toFixed(5)}  ${String(c["goldHitsFull"])}→${String(c["goldHitsAfterFlip"])}`,
      );
    }
    console.log(`  ORACLE: ${artifact.oracle.verdict}`);
    console.log(
      `  loss waterfall (current scoring, union of top-K eligible): ` +
        `top1 ${artifact.lossWaterfall.top1}/${artifact.visible} · ` +
        `top2 ${artifact.lossWaterfall.top2}/${artifact.visible} · ` +
        `top3 ${artifact.lossWaterfall.top3}/${artifact.visible}`,
    );
    for (const cf of artifact.counterfactuals) {
      console.log(
        `  ${cf.name.padEnd(38)} winner T${cf.winnerTrackId ?? "—"} ` +
          `hits ${cf.winnerHits}/${artifact.visible} · oracleRank ${cf.oracleRank ?? "—"} · ` +
          `top2∪ ${cf.top2UnionHits} · top3∪ ${cf.top3UnionHits}`,
      );
    }
    console.log(
      `  alias-suppressed identity variant: winner T${artifact.aliasVariant.winnerTrackId ?? "—"} ` +
        `flip@${artifact.aliasVariant.flipAtMs ?? "—"} · gold ${artifact.aliasVariant.hitsFull}→${artifact.aliasVariant.hitsAfterFlip} (full→kept)`,
    );
    console.log(
      `  production parity (no-merge + aliases): ${artifact.productionParity.status} ` +
        `winner T${artifact.productionParity.winnerTrackId ?? "—"} ` +
        `gold hits ${artifact.productionParity.winnerHitsFull}/${artifact.visible}`,
    );
  }

  console.log("═".repeat(78));
  console.log("AGGREGATE GOLD-MATCH RECALL BY OBJECTIVE (dev vs held-out, single selected track):");
  for (const [cfName, byRole] of aggregates) {
    const dev = byRole.get("dev") ?? { hits: 0, visible: 0 };
    const held = byRole.get("held_out") ?? { hits: 0, visible: 0 };
    const all = { hits: dev.hits + held.hits, visible: dev.visible + held.visible };
    console.log(
      `  ${cfName.padEnd(44)} DEV ${String(dev.hits).padStart(2)}/${dev.visible} (${(dev.hits / Math.max(1, dev.visible)).toFixed(2)}) · ` +
        `HELD-OUT ${held.hits}/${held.visible} (${(held.hits / Math.max(1, held.visible)).toFixed(2)}) · ` +
        `ALL ${all.hits}/${all.visible} (${(all.hits / Math.max(1, all.visible)).toFixed(2)})`,
    );
  }

  mkdirSync(WAVE_A, { recursive: true });
  const artifactPath = join(WAVE_A, "B-selection-forensics.json");
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        tool: "paddleSelectionForensics",
        generatedAtIso: new Date().toISOString(),
        hitRadius: HIT_RADIUS,
        matchToleranceMs: MATCH_TOLERANCE_MS,
        cases: artifacts,
        aggregates: Object.fromEntries(
          [...aggregates.entries()].map(([name, byRole]) => [
            name,
            Object.fromEntries(byRole.entries()),
          ]),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`written: ${artifactPath}`);
}
