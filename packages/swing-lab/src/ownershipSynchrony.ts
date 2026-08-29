import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  buildPaddleTracks,
  type PaddleTrackCandidate,
  type RawPaddleDetectionFile,
} from "./paddleTracker.js";
import { buildPlayerTracks, type PeopleFile, type PlayerTrack } from "./playerTracker.js";
import {
  loadDualFrames,
  pickIncumbent,
  poseContextAt,
  scoreMethod,
  type DualFrame,
  type MethodReport,
  type Pick,
} from "./ownershipBench.js";

/**
 * OWNERSHIP MOTION SYNCHRONY (wave-G g04-f09) — research measurement, no
 * production mutation.
 *
 * Question: does wrist–paddle MOTION SYNCHRONY (correlation of velocity
 * series between a machine paddle track and a player's wrist trajectory)
 * separate target-owned from foreign paddles, and does it add discriminative
 * power beyond the incumbent S3 wrist-proximity features?
 *
 *   pnpm --filter @pickle/swing-lab own:synchrony
 *
 * FROZEN EVALUATION PROTOCOL (fixed before measurement; no post-hoc tuning):
 *  - Cases: dev-only cases where BOTH a committed raw paddle-detection file
 *    and a committed pose file exist (SYNCHRONY_CASES below). The held-out
 *    cases (wm-dink-01, afn-vic-rally1) are structurally excluded — they are
 *    not in the registry and their artifacts are never read.
 *  - Paddle tracks: built by the production tracker (buildPaddleTracks) from
 *    committed detection artifacts (Tier-C machine tracks, never gold).
 *  - Wrist trajectories: per player track, per wrist joint, linearly
 *    interpolated at paddle-observation timestamps (both endpoints within
 *    POSE_INTERP_MAX_GAP_MS and visibility >= WRIST_VISIBILITY_FLOOR).
 *  - Synchrony score: mean of the per-axis Pearson correlations between the
 *    paddle-center velocity series and the wrist velocity series over
 *    aligned consecutive steps (dt <= MAX_STEP_MS). A pair needs at least
 *    MIN_VELOCITY_STEPS steps, else it abstains. The PRIMARY score is at
 *    lag 0; a lag scan over LAG_SCAN_MS is reported as descriptive evidence
 *    only and never feeds the decision rule.
 *  - Ground truth: dual frames from the committed ownership gold
 *    (loadDualFrames, dev only, adjudicated E05 corrections applied). A
 *    labeled candidate point is matched to the machine track that has an
 *    observation within TRACK_MATCH_TOLERANCE_MS whose center is within
 *    TRACK_MATCH_RADIUS of the point; unmatched candidates abstain.
 *  - Grouping: all counts are reported per source-session group (the same
 *    groups as ownership-bench-v1) — never per-frame trials pooled blindly.
 *  - Decision rule (frozen): synchrony ADDS power iff the s2 combination
 *    (incumbent pick, synchrony only where the incumbent abstains) scores
 *    strictly more correct picks than the incumbent on the same scored
 *    frames AND no session group loses correct picks. Otherwise the honest
 *    verdict is that it does not (SCIENTIFIC_NEGATIVE), regardless of how
 *    suggestive the track-level tables look.
 *
 * Data-tier disclosure: pose for the wave-a cases is committed Apple Vision
 * (runs-wave-a); pose for afn-sasebo-rally1 / wm-volley-02 is the committed
 * LINUX-BENCH MediaPipe artifact (tools/latency-bench/artifacts), which its
 * own provenance marks as bench-input-only. This mission explicitly allows
 * Tier-C pose; every row carries its poseTier so the two surfaces are never
 * conflated, and nothing here is canonical Mac cascade evidence.
 */

export const OWNERSHIP_SYNCHRONY_VERSION = "ownership-synchrony-v1";

const WRIST_VISIBILITY_FLOOR = 0.2;
const POSE_INTERP_MAX_GAP_MS = 100;
const MAX_STEP_MS = 200;
export const MIN_VELOCITY_STEPS = 8;
const TRACK_MATCH_TOLERANCE_MS = 40;
const TRACK_MATCH_RADIUS = 0.035;
const LAG_SCAN_MS = [-333, -267, -200, -133, -67, 0, 67, 133, 200, 267, 333];

export type PoseTier = "apple-vision" | "mediapipe-linux-bench";

export interface SynchronyCaseInfo {
  group: string;
  detsPath: string;
  peoplePath: string;
  poseTier: PoseTier;
}

/** Dev-only cases with BOTH committed detections and committed pose.
 *  Held-out cases are structurally absent. */
export const SYNCHRONY_CASES: Record<string, SynchronyCaseInfo> = {
  "wavea-944403-dink": {
    group: "dvids-944403",
    detsPath: "datasets/experiments/wave-d4/d4-01-dets/wavea-944403-dink-dets.json",
    peoplePath: "datasets/paddle-bench/runs-wave-a/wavea-944403-dink/people.json",
    poseTier: "apple-vision",
  },
  "wavea-944403-smash": {
    group: "dvids-944403",
    detsPath: "datasets/experiments/wave-d4/d4-01-dets/wavea-944403-smash-dets.json",
    peoplePath: "datasets/paddle-bench/runs-wave-a/wavea-944403-smash/people.json",
    poseTier: "apple-vision",
  },
  "wavea-faead-feed": {
    group: "dvids-faead",
    detsPath: "datasets/experiments/wave-d4/d4-01-dets/wavea-faead-feed-dets.json",
    peoplePath: "datasets/paddle-bench/runs-wave-a/wavea-faead-feed/people.json",
    poseTier: "apple-vision",
  },
  "wavea-faead-rally": {
    group: "dvids-faead",
    detsPath: "datasets/experiments/wave-d4/d4-01-dets/wavea-faead-rally-dets.json",
    peoplePath: "datasets/paddle-bench/runs-wave-a/wavea-faead-rally/people.json",
    poseTier: "apple-vision",
  },
  "wavea-marne-dig": {
    group: "dvids-marne-2024",
    detsPath: "datasets/experiments/wave-d4/d4-01-dets/wavea-marne-dig-dets.json",
    peoplePath: "datasets/paddle-bench/runs-wave-a/wavea-marne-dig/people.json",
    poseTier: "apple-vision",
  },
  "afn-sasebo-rally1": {
    group: "afn-sasebo-2025-06",
    detsPath: "datasets/experiments/wave-a/H-logs/baseline-rerun-afn-sasebo-rally1-dets.json",
    peoplePath: "tools/latency-bench/artifacts/afn-sasebo-rally1/people.json",
    poseTier: "mediapipe-linux-bench",
  },
  "wm-volley-02": {
    group: "wm-tournament-2014",
    detsPath: "datasets/experiments/wave-a/H-logs/baseline-rerun-wm-volley-02-dets.json",
    peoplePath: "tools/latency-bench/artifacts/wm-volley-02/people.json",
    poseTier: "mediapipe-linux-bench",
  },
};

// ── wrist trajectory sampling ─────────────────────────────────────────────

export interface WristSample {
  tMs: number;
  point: { x: number; y: number };
}

/** Linearly interpolated wrist position at tMs, or null when the flanking
 *  pose frames are missing, too far apart, or below the visibility floor. */
export function interpolateWrist(
  frames: Array<{
    timestampMs: number;
    joints: Array<{ n: string; x: number; y: number; v: number }>;
  }>,
  wristName: string,
  tMs: number,
): { x: number; y: number } | null {
  let before: { timestampMs: number; x: number; y: number } | null = null;
  let after: { timestampMs: number; x: number; y: number } | null = null;
  for (const frame of frames) {
    const joint = frame.joints.find(
      (candidate) => candidate.n === wristName && candidate.v >= WRIST_VISIBILITY_FLOOR,
    );
    if (!joint) continue;
    if (frame.timestampMs <= tMs) {
      if (before === null || frame.timestampMs > before.timestampMs) {
        before = { timestampMs: frame.timestampMs, x: joint.x, y: joint.y };
      }
    } else if (after === null || frame.timestampMs < after.timestampMs) {
      after = { timestampMs: frame.timestampMs, x: joint.x, y: joint.y };
    }
  }
  if (before && Math.abs(before.timestampMs - tMs) < 1e-6) return { x: before.x, y: before.y };
  if (!before || !after) return null;
  const span = after.timestampMs - before.timestampMs;
  if (span > POSE_INTERP_MAX_GAP_MS) return null;
  const alpha = (tMs - before.timestampMs) / span;
  return {
    x: before.x + alpha * (after.x - before.x),
    y: before.y + alpha * (after.y - before.y),
  };
}

// ── synchrony metric ──────────────────────────────────────────────────────

export function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2 || n !== b.length) return null;
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < n; index += 1) {
    const da = a[index]! - meanA;
    const db = b[index]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null;
  return cov / Math.sqrt(varA * varB);
}

export interface SynchronyEstimate {
  /** Mean of per-axis Pearson correlations of velocity series (lag as given). */
  score: number;
  steps: number;
}

/** Velocity-series synchrony between a paddle-center series and one wrist of
 *  one player at a fixed lag (wrist sampled at paddle time + lagMs). */
export function synchronyAtLag(
  paddleSeries: WristSample[],
  playerFrames: PlayerTrack["frames"],
  wristName: string,
  lagMs: number,
): SynchronyEstimate | null {
  const aligned: Array<{
    tMs: number;
    paddle: { x: number; y: number };
    wrist: { x: number; y: number };
  }> = [];
  for (const sample of paddleSeries) {
    const wrist = interpolateWrist(playerFrames, wristName, sample.tMs + lagMs);
    if (wrist) aligned.push({ tMs: sample.tMs, paddle: sample.point, wrist });
  }
  const paddleVx: number[] = [];
  const paddleVy: number[] = [];
  const wristVx: number[] = [];
  const wristVy: number[] = [];
  for (let index = 1; index < aligned.length; index += 1) {
    const previous = aligned[index - 1]!;
    const current = aligned[index]!;
    const dt = current.tMs - previous.tMs;
    if (dt <= 0 || dt > MAX_STEP_MS) continue;
    paddleVx.push((current.paddle.x - previous.paddle.x) / dt);
    paddleVy.push((current.paddle.y - previous.paddle.y) / dt);
    wristVx.push((current.wrist.x - previous.wrist.x) / dt);
    wristVy.push((current.wrist.y - previous.wrist.y) / dt);
  }
  if (paddleVx.length < MIN_VELOCITY_STEPS) return null;
  const rx = pearson(paddleVx, wristVx);
  const ry = pearson(paddleVy, wristVy);
  if (rx === null || ry === null) return null;
  return { score: (rx + ry) / 2, steps: paddleVx.length };
}

export interface PlayerSynchrony {
  playerTrackId: number;
  isTarget: boolean;
  /** PRIMARY: best wrist at lag 0. Null = abstain (insufficient overlap). */
  lag0Score: number | null;
  lag0Steps: number | null;
  /** Descriptive only: best (score, lag) over the frozen lag scan. */
  bestLagMs: number | null;
  bestLagScore: number | null;
}

export interface TrackSynchronyRow {
  caseId: string;
  group: string;
  poseTier: PoseTier;
  trackId: number;
  observations: number;
  players: PlayerSynchrony[];
  targetLag0: number | null;
  otherBestLag0: number | null;
  /** targetLag0 - otherBestLag0 (null when either side abstains). */
  margin: number | null;
}

const WRIST_NAMES = ["left_wrist", "right_wrist"];

export function computeTrackSynchrony(
  caseId: string,
  info: SynchronyCaseInfo,
  track: PaddleTrackCandidate,
  players: PlayerTrack[],
  targetTrackId: number,
): TrackSynchronyRow {
  const paddleSeries: WristSample[] = track.observations.map((observation) => ({
    tMs: observation.timestampMs,
    point: observation.center,
  }));
  const rows: PlayerSynchrony[] = [];
  for (const player of players) {
    let lag0: SynchronyEstimate | null = null;
    let bestLagMs: number | null = null;
    let bestLagScore: number | null = null;
    for (const wrist of WRIST_NAMES) {
      const estimate = synchronyAtLag(paddleSeries, player.frames, wrist, 0);
      if (estimate && (lag0 === null || estimate.score > lag0.score)) lag0 = estimate;
      for (const lag of LAG_SCAN_MS) {
        const lagged = synchronyAtLag(paddleSeries, player.frames, wrist, lag);
        if (lagged && (bestLagScore === null || lagged.score > bestLagScore)) {
          bestLagScore = lagged.score;
          bestLagMs = lag;
        }
      }
    }
    rows.push({
      playerTrackId: player.trackId,
      isTarget: player.trackId === targetTrackId,
      lag0Score: lag0 ? Number(lag0.score.toFixed(4)) : null,
      lag0Steps: lag0 ? lag0.steps : null,
      bestLagMs,
      bestLagScore: bestLagScore === null ? null : Number(bestLagScore.toFixed(4)),
    });
  }
  const target = rows.find((row) => row.isTarget) ?? null;
  const otherScores = rows.filter((row) => !row.isTarget && row.lag0Score !== null);
  const otherBest =
    otherScores.length > 0 ? Math.max(...otherScores.map((row) => row.lag0Score!)) : null;
  const targetLag0 = target?.lag0Score ?? null;
  return {
    caseId,
    group: info.group,
    poseTier: info.poseTier,
    trackId: track.trackId,
    observations: track.observations.length,
    players: rows,
    targetLag0,
    otherBestLag0: otherBest,
    margin:
      targetLag0 !== null && otherBest !== null
        ? Number((targetLag0 - otherBest).toFixed(4))
        : null,
  };
}

// ── case assembly ─────────────────────────────────────────────────────────

export interface SynchronyCaseData {
  caseId: string;
  info: SynchronyCaseInfo;
  tracks: PaddleTrackCandidate[];
  players: PlayerTrack[];
  targetTrackId: number;
  people: PeopleFile;
  rows: TrackSynchronyRow[];
}

export function loadSynchronyCase(
  caseId: string,
  info: SynchronyCaseInfo,
): SynchronyCaseData | null {
  const detsPath = join(REPO_ROOT, info.detsPath);
  const peoplePath = join(REPO_ROOT, info.peoplePath);
  if (!existsSync(detsPath) || !existsSync(peoplePath)) return null;
  const dets = JSON.parse(readFileSync(detsPath, "utf8")) as RawPaddleDetectionFile;
  const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
  const tracks = buildPaddleTracks(dets, dets.window);
  const players = buildPlayerTracks(people);
  if (players.length === 0) return null;
  // Same auto target policy as ownership-bench-v1 / the pipeline pre-seed.
  const target = [...players].sort(
    (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
  )[0]!;
  const rows = tracks.map((track) =>
    computeTrackSynchrony(caseId, info, track, players, target.trackId),
  );
  return { caseId, info, tracks, players, targetTrackId: target.trackId, people, rows };
}

// ── truth matching: labeled candidate point -> machine track ──────────────

export function matchTrack(
  tracks: PaddleTrackCandidate[],
  tMs: number,
  point: { x: number; y: number },
): PaddleTrackCandidate | null {
  let best: { track: PaddleTrackCandidate; distance: number } | null = null;
  for (const track of tracks) {
    for (const observation of track.observations) {
      if (Math.abs(observation.timestampMs - tMs) > TRACK_MATCH_TOLERANCE_MS) continue;
      const distance = Math.hypot(observation.center.x - point.x, observation.center.y - point.y);
      if (distance <= TRACK_MATCH_RADIUS && (best === null || distance < best.distance)) {
        best = { track, distance };
      }
    }
  }
  return best?.track ?? null;
}

// ── dual-frame pick methods ───────────────────────────────────────────────

/** s1 — pure synchrony: pick the candidate whose matched track has the best
 *  positive lag-0 margin (target synchrony minus best foreign synchrony);
 *  abstain when no candidate has a matched track with a positive margin. */
export function pickSynchrony(frame: DualFrame, data: SynchronyCaseData): Pick {
  let best: { index: number; margin: number } | null = null;
  for (const [index, candidate] of frame.candidates.entries()) {
    const track = matchTrack(data.tracks, frame.tMs, candidate.point);
    if (!track) continue;
    const row = data.rows.find((candidateRow) => candidateRow.trackId === track.trackId);
    if (!row || row.margin === null) continue;
    if (best === null || row.margin > best.margin) best = { index, margin: row.margin };
  }
  if (best === null) return { index: null, reason: "no candidate with a synchrony-scored track" };
  if (best.margin <= 0)
    return { index: null, reason: "no candidate with positive synchrony margin" };
  return { index: best.index, reason: `best synchrony margin ${best.margin.toFixed(3)}` };
}

/** s2 — incumbent-plus-synchrony: the incumbent's pick where it answers;
 *  synchrony only fills incumbent abstentions. Measures ADDITIVE power. */
export function pickIncumbentPlusSynchrony(frame: DualFrame, data: SynchronyCaseData): Pick {
  const incumbent = pickIncumbent(frame);
  if (incumbent.index !== null) return incumbent;
  const synchrony = pickSynchrony(frame, data);
  return synchrony.index !== null
    ? { index: synchrony.index, reason: `incumbent abstained; ${synchrony.reason}` }
    : { index: null, reason: `incumbent + synchrony both abstained` };
}

// ── report ────────────────────────────────────────────────────────────────

export interface SeparabilityRow {
  group: string;
  poseTier: PoseTier;
  targetOwnedTracks: number;
  targetOwnedPositiveMargin: number;
  foreignTracks: number;
  foreignNegativeMargin: number;
  abstainedTracks: number;
  conflictedTracks: number;
}

export interface SynchronyReport {
  version: string;
  generatedAtIso: string;
  holdoutStatement: string;
  protocol: string[];
  cases: Record<
    string,
    {
      group: string;
      poseTier: PoseTier;
      paddleTracks: number;
      playerTracks: number;
      dualFrames: number;
      trackRows: TrackSynchronyRow[];
    }
  >;
  trackTruth: Array<{
    caseId: string;
    group: string;
    trackId: number;
    truth: "target" | "foreign" | "conflicted";
    matchedLabels: number;
    targetLag0: number | null;
    otherBestLag0: number | null;
    margin: number | null;
    bestLagMsTarget: number | null;
  }>;
  separabilityByGroup: SeparabilityRow[];
  methods: MethodReport[];
  decisionRule: string;
  decision: {
    incumbentCorrect: number;
    s2Correct: number;
    scoredFrames: number;
    groupsWorse: string[];
    addsPower: boolean;
  };
}

export function runSynchronyEval(): SynchronyReport {
  const caseData = new Map<string, SynchronyCaseData>();
  for (const [caseId, info] of Object.entries(SYNCHRONY_CASES)) {
    const data = loadSynchronyCase(caseId, info);
    if (data) caseData.set(caseId, data);
  }

  // Dev-only dual frames, adjudicated corrections applied, restricted to the
  // synchrony-capable cases.
  const dualFrames = loadDualFrames(false, true).filter((frame) => caseData.has(frame.caseId));
  // Attach pose context from THIS protocol's people files so the incumbent
  // baseline answers on exactly the same surface (including the two
  // mediapipe-linux-bench cases the ownership bench has no pose for).
  for (const frame of dualFrames) {
    if (frame.pose === null) {
      frame.pose = poseContextAt(caseData.get(frame.caseId)!.people, frame.tMs);
    }
  }

  // Track-level truth from matched gold labels.
  const trackTruth: SynchronyReport["trackTruth"] = [];
  for (const [caseId, data] of caseData) {
    const owners = new Map<number, { target: number; other: number }>();
    for (const frame of dualFrames) {
      if (frame.caseId !== caseId) continue;
      for (const candidate of frame.candidates) {
        const track = matchTrack(data.tracks, frame.tMs, candidate.point);
        if (!track) continue;
        const row = owners.get(track.trackId) ?? { target: 0, other: 0 };
        row[candidate.owner] += 1;
        owners.set(track.trackId, row);
      }
    }
    for (const [trackId, counts] of owners) {
      const row = data.rows.find((candidateRow) => candidateRow.trackId === trackId)!;
      const truth =
        counts.target > 0 && counts.other > 0
          ? "conflicted"
          : counts.target > 0
            ? "target"
            : "foreign";
      const targetPlayer = row.players.find((player) => player.isTarget);
      trackTruth.push({
        caseId,
        group: data.info.group,
        trackId,
        truth,
        matchedLabels: counts.target + counts.other,
        targetLag0: row.targetLag0,
        otherBestLag0: row.otherBestLag0,
        margin: row.margin,
        bestLagMsTarget: targetPlayer?.bestLagMs ?? null,
      });
    }
  }

  // Separability with counts, per group.
  const byGroup = new Map<string, SeparabilityRow>();
  for (const entry of trackTruth) {
    const poseTier = caseData.get(entry.caseId)!.info.poseTier;
    const row =
      byGroup.get(entry.group) ??
      ({
        group: entry.group,
        poseTier,
        targetOwnedTracks: 0,
        targetOwnedPositiveMargin: 0,
        foreignTracks: 0,
        foreignNegativeMargin: 0,
        abstainedTracks: 0,
        conflictedTracks: 0,
      } satisfies SeparabilityRow);
    if (entry.truth === "conflicted") {
      row.conflictedTracks += 1;
    } else if (entry.margin === null) {
      row.abstainedTracks += 1;
    } else if (entry.truth === "target") {
      row.targetOwnedTracks += 1;
      if (entry.margin > 0) row.targetOwnedPositiveMargin += 1;
    } else {
      row.foreignTracks += 1;
      if (entry.margin < 0) row.foreignNegativeMargin += 1;
    }
    byGroup.set(entry.group, row);
  }

  // Dual-frame methods on the identical frame set.
  const incumbentPicks = dualFrames.map((frame) => pickIncumbent(frame));
  const synchronyPicks = dualFrames.map((frame) =>
    pickSynchrony(frame, caseData.get(frame.caseId)!),
  );
  const combinedPicks = dualFrames.map((frame) =>
    pickIncumbentPlusSynchrony(frame, caseData.get(frame.caseId)!),
  );
  const methods = [
    scoreMethod("incumbent_wrist_ratio", dualFrames, incumbentPicks),
    scoreMethod("s1_synchrony", dualFrames, synchronyPicks),
    scoreMethod("s2_incumbent_plus_synchrony", dualFrames, combinedPicks),
  ];

  const incumbentReport = methods[0]!;
  const combinedReport = methods[2]!;
  const groupsWorse: string[] = [];
  for (const [group, row] of Object.entries(combinedReport.byGroup)) {
    const incumbentRow = incumbentReport.byGroup[group];
    if (incumbentRow && row.correct < incumbentRow.correct) groupsWorse.push(group);
  }
  const addsPower = combinedReport.correct > incumbentReport.correct && groupsWorse.length === 0;

  const report: SynchronyReport = {
    version: OWNERSHIP_SYNCHRONY_VERSION,
    generatedAtIso: new Date().toISOString(),
    holdoutStatement:
      "Held-out cases wm-dink-01 and afn-vic-rally1 were never read: they are structurally absent from SYNCHRONY_CASES and loadDualFrames(false, …) excludes held_out splits.",
    protocol: [
      "cases: dev-only, committed detections + committed pose (poseTier disclosed per case; mediapipe-linux-bench pose is Tier-C bench input, not canonical)",
      "paddle tracks: production buildPaddleTracks over committed detection artifacts (Tier-C machine tracks, never gold)",
      `synchrony: mean per-axis Pearson r of velocity series at lag 0; wrist = best of ${WRIST_NAMES.join("/")}; >= ${MIN_VELOCITY_STEPS} aligned steps (dt <= ${MAX_STEP_MS}ms) else abstain`,
      `lag scan ${LAG_SCAN_MS[0]}..${LAG_SCAN_MS[LAG_SCAN_MS.length - 1]}ms is DESCRIPTIVE ONLY; the decision rule uses lag 0`,
      `truth: gold candidate point -> track match within ${TRACK_MATCH_TOLERANCE_MS}ms and ${TRACK_MATCH_RADIUS} normalized units`,
      "grouping: source-session groups (ownership-bench-v1 groups); no per-frame pooling without the per-group table",
      "corrections: adjudicated E05 ownership corrections applied (append-only, in memory)",
    ],
    cases: Object.fromEntries(
      [...caseData.entries()].map(([caseId, data]) => [
        caseId,
        {
          group: data.info.group,
          poseTier: data.info.poseTier,
          paddleTracks: data.tracks.length,
          playerTracks: data.players.length,
          dualFrames: dualFrames.filter((frame) => frame.caseId === caseId).length,
          trackRows: data.rows,
        },
      ]),
    ),
    trackTruth,
    separabilityByGroup: [...byGroup.values()],
    methods,
    decisionRule:
      "synchrony adds power iff s2 (incumbent + synchrony on incumbent abstentions) has strictly more correct picks than the incumbent on the same scored frames AND no session group loses correct picks",
    decision: {
      incumbentCorrect: incumbentReport.correct,
      s2Correct: combinedReport.correct,
      scoredFrames: incumbentReport.scoredFrames,
      groupsWorse,
      addsPower,
    },
  };
  return report;
}

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const isMain = process.argv[1]?.endsWith("ownershipSynchrony.ts");
if (isMain) {
  const report = runSynchronyEval();
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-g");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "g04-f09-synchrony-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  say(`${OWNERSHIP_SYNCHRONY_VERSION}`);
  for (const [caseId, summary] of Object.entries(report.cases)) {
    say(
      `${caseId} [${summary.group}] pose=${summary.poseTier} tracks=${summary.paddleTracks} players=${summary.playerTracks} duals=${summary.dualFrames}`,
    );
  }
  say("\ntrack truth:");
  for (const row of report.trackTruth) {
    say(
      `  ${row.caseId} track ${row.trackId}: ${row.truth} (labels ${row.matchedLabels}) targetR=${row.targetLag0} otherBestR=${row.otherBestLag0} margin=${row.margin} bestLagTarget=${row.bestLagMsTarget}ms`,
    );
  }
  say("\nseparability by group:");
  for (const row of report.separabilityByGroup) {
    say(
      `  ${row.group} (${row.poseTier}): target ${row.targetOwnedPositiveMargin}/${row.targetOwnedTracks} positive-margin · foreign ${row.foreignNegativeMargin}/${row.foreignTracks} negative-margin · abstained ${row.abstainedTracks} · conflicted ${row.conflictedTracks}`,
    );
  }
  say("\nmethods:");
  for (const method of report.methods) {
    say(
      `  ${method.method}: acc ${method.accuracy} (${method.correct}/${method.scoredFrames}) · answering ${method.accuracyWhenAnswering} · coverage ${method.coverage}`,
    );
    for (const [group, row] of Object.entries(method.byGroup)) {
      say(`    [${group}] n=${row.n} correct=${row.correct} abstain=${row.abstained}`);
    }
  }
  say(
    `\ndecision: incumbent ${report.decision.incumbentCorrect} vs s2 ${report.decision.s2Correct} of ${report.decision.scoredFrames} · groupsWorse=[${report.decision.groupsWorse.join(",")}] · addsPower=${report.decision.addsPower}`,
  );
  say(`report → ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
