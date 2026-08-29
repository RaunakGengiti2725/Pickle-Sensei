import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import {
  POSE_SEQUENCE_FORMAT,
  POSE_SEQUENCE_SCHEMA_VERSION,
  type PoseSequence,
} from "@pickle/swing-domain";

/**
 * PLAYER IDENTITY as a first-class temporal track.
 *
 * Wrong-player/wrong-paddle association is the most damaging measured error
 * in the pipeline: it poisons contact, stroke side, and everything after.
 * This module turns per-frame multi-person detections into persistent player
 * tracks (greedy association on torso position + scale, gap-tolerant, no
 * interpolation) and selects ONE target player with a defensible policy:
 *
 *   auto     — the player the videographer framed: highest
 *              (coverage × torso size), i.e. most-present largest person
 *   explicit — `--player <trackId>` for research overrides
 *
 * Identity persistence: association prefers the incumbent match and the
 * track never "switches" people silently — a lost target is a recorded LOSS
 * PERIOD, and a candidate that would flip identity must beat the incumbent
 * by a margin (hysteresis) or it starts its own track.
 */

export const PLAYER_TRACKER_VERSION = "player-track-1";

export interface PeopleFile {
  schemaVersion: 1;
  poseModelVersion: string;
  video: { w: number; h: number; fps: number };
  frames: Array<{
    t: number;
    p: Array<{ c: number; l: Array<{ n: string; x: number; y: number; v: number }> }>;
  }>;
}

export interface PlayerFrame {
  timestampMs: number;
  confidence: number;
  joints: Array<{ n: string; x: number; y: number; v: number }>;
  torsoMid: { x: number; y: number };
  torsoSpan: number;
}

export interface PlayerTrack {
  trackId: number;
  frames: PlayerFrame[];
  /** Fraction of clip frames where this player was observed. */
  coverage: number;
  meanTorsoSpan: number;
  /** Gaps longer than one frame interval, as explicit loss periods. */
  lossPeriods: Array<{ fromMs: number; toMs: number }>;
}

export interface TargetSelection {
  target: PlayerTrack;
  policy: "auto" | "explicit";
  /** Heuristic (uncalibrated): margin of the auto score over the runner-up. */
  confidence: number;
  allTracks: PlayerTrack[];
  /** Quality risks for downstream confidence handling. */
  risks: string[];
}

const GATES = {
  matchRadius: 0.12, // torso-mid association gate (normalized)
  scaleRatioMax: 1.6,
  maxGapMs: 400,
  minFrames: 8,
  /** A challenger must beat the incumbent's cost by this factor to steal a
   * frame (hysteresis against identity flips). */
  incumbentAdvantage: 0.7,
} as const;

const TORSO_JOINTS = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"] as const;

export function buildPlayerTracks(file: PeopleFile): PlayerTrack[] {
  interface Active {
    trackId: number;
    frames: PlayerFrame[];
    lastMs: number;
  }
  const active: Active[] = [];
  const finished: Active[] = [];
  let nextId = 1;

  for (const frame of file.frames) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (frame.t - active[index]!.lastMs > GATES.maxGapMs) {
        finished.push(active.splice(index, 1)[0]!);
      }
    }
    const people = frame.p
      .map((person) => describePerson(frame.t, person))
      .filter((person): person is PlayerFrame => person !== null);

    // Global lowest-cost assignment with incumbent hysteresis.
    const pairs: Array<{ trackIndex: number; personIndex: number; cost: number }> = [];
    for (const [trackIndex, track] of active.entries()) {
      const last = track.frames[track.frames.length - 1]!;
      for (const [personIndex, person] of people.entries()) {
        const distance = Math.hypot(
          person.torsoMid.x - last.torsoMid.x,
          person.torsoMid.y - last.torsoMid.y,
        );
        if (distance > GATES.matchRadius) continue;
        const scaleRatio =
          Math.max(person.torsoSpan, last.torsoSpan) /
          Math.max(1e-6, Math.min(person.torsoSpan, last.torsoSpan));
        if (scaleRatio > GATES.scaleRatioMax) continue;
        // Incumbent advantage: continuing a track is cheaper than starting
        // association churn between adjacent people.
        pairs.push({
          trackIndex,
          personIndex,
          cost: (distance + (scaleRatio - 1) * 0.1) * GATES.incumbentAdvantage,
        });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const takenPeople = new Set<number>();
    const matchedTracks = new Set<number>();
    for (const pair of pairs) {
      if (takenPeople.has(pair.personIndex) || matchedTracks.has(pair.trackIndex)) continue;
      takenPeople.add(pair.personIndex);
      matchedTracks.add(pair.trackIndex);
      const track = active[pair.trackIndex]!;
      track.frames.push(people[pair.personIndex]!);
      track.lastMs = frame.t;
    }
    for (const [personIndex, person] of people.entries()) {
      if (takenPeople.has(personIndex)) continue;
      active.push({ trackId: nextId++, frames: [person], lastMs: frame.t });
    }
  }
  finished.push(...active);

  const clipFrameCount = Math.max(1, file.frames.length);
  const frameIntervalMs = file.video.fps > 0 ? 1000 / file.video.fps : 40;
  return finished
    .filter((track) => track.frames.length >= GATES.minFrames)
    .map((track) => {
      const lossPeriods: Array<{ fromMs: number; toMs: number }> = [];
      for (let index = 1; index < track.frames.length; index += 1) {
        const gap = track.frames[index]!.timestampMs - track.frames[index - 1]!.timestampMs;
        if (gap > frameIntervalMs * 1.9) {
          lossPeriods.push({
            fromMs: track.frames[index - 1]!.timestampMs,
            toMs: track.frames[index]!.timestampMs,
          });
        }
      }
      return {
        trackId: track.trackId,
        frames: track.frames,
        coverage: track.frames.length / clipFrameCount,
        meanTorsoSpan:
          track.frames.reduce((total, frame) => total + frame.torsoSpan, 0) / track.frames.length,
        lossPeriods,
      };
    })
    .sort((a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan);
}

/**
 * PRODUCT-ASSISTED PERCEPTION — the user tells us who they are.
 *
 * One tap during setup ("tap yourself" / "choose your starting side") removes
 * the hardest inference in the stack. The tap is an INITIALIZATION SEED, not a
 * spatial prison: it identifies a physical person at t≈0, after which identity
 * follows that person wherever they move (across the centerline, into the
 * kitchen, behind their partner). Court half never re-decides identity.
 */
export type TargetSeed =
  | { mode: "user_tapped_person"; point: { x: number; y: number } }
  | { mode: "user_selected_court_half"; half: "left" | "right"; nearSide: boolean }
  | { mode: "auto_single_player" };

export interface TargetIdentity {
  trackId: number;
  /** Duplicate detections of the SAME human, absorbed into the target. */
  aliasTrackIds: number[];
  seedMode: TargetSeed["mode"];
  lockedAtMs: number | null;
  /** Heuristic, uncalibrated — explicit selection is more certain than auto. */
  confidence: number;
  risks: string[];
}

/** Frames used to resolve the seed (identity is decided early, then held). */
const SEED_RESOLUTION_MS = 1200;

/**
 * Resolve a user seed to ONE player track, then absorb duplicate tracks of the
 * same human as aliases (waterfall finding: duplicates were being treated as
 * competing players and poisoning paddle ownership).
 */
export function initializeTargetFromSeed(
  tracks: PlayerTrack[],
  seed: TargetSeed,
): Result<{ identity: TargetIdentity; target: PlayerTrack }> {
  if (tracks.length === 0) {
    return fail(failure("low_confidence", "player.no_tracks", "No player tracks were formed."));
  }
  const clipStart = Math.min(...tracks.map((track) => track.frames[0]!.timestampMs));
  const earlyPose = (track: PlayerTrack): PlayerFrame | null => {
    const early = track.frames.filter(
      (frame) => frame.timestampMs <= clipStart + SEED_RESOLUTION_MS,
    );
    return early[Math.floor(early.length / 2)] ?? track.frames[0] ?? null;
  };

  const risks: string[] = [];
  let chosen: PlayerTrack | undefined;
  let confidence = 0.5;

  if (seed.mode === "user_tapped_person") {
    // Nearest track to the tap, scored by torso distance normalized by body
    // scale so a tap anywhere on the body works.
    const ranked = tracks
      .map((track) => {
        const frame = earlyPose(track);
        if (!frame) return null;
        const distance = Math.hypot(
          frame.torsoMid.x - seed.point.x,
          frame.torsoMid.y - seed.point.y,
        );
        return { track, cost: distance / Math.max(0.05, frame.torsoSpan) };
      })
      .filter((entry): entry is { track: PlayerTrack; cost: number } => entry !== null)
      .sort((a, b) => a.cost - b.cost);
    chosen = ranked[0]?.track;
    const runnerUp = ranked[1]?.cost;
    confidence =
      runnerUp !== undefined && ranked[0] !== undefined
        ? Math.max(0.55, Math.min(0.97, 1 - ranked[0].cost / Math.max(1e-6, runnerUp)))
        : 0.9;
    if (ranked[0] && ranked[0].cost > 3) {
      risks.push("TARGET_TAP_FAR_FROM_ANY_PLAYER: the tap did not land near a detected person");
      confidence = Math.min(confidence, 0.5);
    }
  } else if (seed.mode === "user_selected_court_half") {
    // The user's own side of the court, split at the image centerline. Only a
    // SEED: the chosen person keeps identity after crossing it.
    const candidates = tracks
      .map((track) => ({ track, frame: earlyPose(track) }))
      .filter((entry): entry is { track: PlayerTrack; frame: PlayerFrame } => entry.frame !== null)
      // "Near side" players are the larger ones in frame.
      .sort((a, b) => b.frame.torsoSpan - a.frame.torsoSpan)
      .slice(0, seed.nearSide ? 2 : tracks.length);
    const wanted = candidates.filter((entry) =>
      seed.half === "left" ? entry.frame.torsoMid.x < 0.5 : entry.frame.torsoMid.x >= 0.5,
    );
    const pool = wanted.length > 0 ? wanted : candidates;
    if (wanted.length === 0) {
      risks.push(
        `TARGET_HALF_EMPTY: no near-side player started on the ${seed.half}; fell back to the most prominent player`,
      );
    }
    chosen = pool.sort(
      (a, b) => b.track.coverage * b.track.meanTorsoSpan - a.track.coverage * a.track.meanTorsoSpan,
    )[0]?.track;
    confidence = wanted.length === 1 ? 0.9 : wanted.length > 1 ? 0.7 : 0.45;
  } else {
    const ranked = [...tracks].sort(
      (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
    );
    chosen = ranked[0];
    confidence = ranked.length === 1 ? 0.9 : 0.5;
    if (ranked.length > 1) {
      risks.push("TARGET_AUTO_MULTIPLE_CANDIDATES: no explicit user selection was provided");
    }
  }
  if (!chosen) {
    return fail(
      failure("low_confidence", "player.seed_unresolved", "The target seed matched no player."),
    );
  }

  // The tap may land nearest a SHORT duplicate fragment of the right person
  // (measured: afn-sasebo-rally1 resolved to a 7%-coverage fragment whose
  // aliases were the real 88% track). Identity is the PERSON, so promote the
  // best-covered member of the alias family as the base track.
  let aliasTrackIds = duplicateAliasesOf(chosen, tracks);
  if (aliasTrackIds.length > 0) {
    const family = [chosen, ...tracks.filter((track) => aliasTrackIds.includes(track.trackId))];
    const best = family.sort((a, b) => b.coverage - a.coverage)[0]!;
    if (best.trackId !== chosen.trackId) {
      chosen = best;
      aliasTrackIds = duplicateAliasesOf(chosen, tracks);
    }
  }
  return ok({
    identity: {
      trackId: chosen.trackId,
      aliasTrackIds,
      seedMode: seed.mode,
      lockedAtMs: chosen.frames[0]?.timestampMs ?? null,
      confidence,
      risks,
    },
    target: aliasTrackIds.length > 0 ? absorbAliases(chosen, tracks, aliasTrackIds) : chosen,
  });
}

/** Track ids that are duplicate detections of the same human as `target`. */
export function duplicateAliasesOf(target: PlayerTrack, tracks: readonly PlayerTrack[]): number[] {
  const aliases: number[] = [];
  for (const track of tracks) {
    if (track.trackId === target.trackId) continue;
    let coincident = 0;
    let compared = 0;
    for (const frame of track.frames) {
      const targetFrame = target.frames.find(
        (candidate) => Math.abs(candidate.timestampMs - frame.timestampMs) <= 40,
      );
      if (!targetFrame) continue;
      compared += 1;
      if (
        Math.hypot(
          frame.torsoMid.x - targetFrame.torsoMid.x,
          frame.torsoMid.y - targetFrame.torsoMid.y,
        ) < DUPLICATE_TORSO_DISTANCE
      ) {
        coincident += 1;
      }
    }
    if (compared >= 3 && coincident / compared > 0.5) aliases.push(track.trackId);
  }
  return aliases;
}

/**
 * Fold alias frames into the target track, filling moments the primary track
 * missed. Alias observations are real detections of the same person, so this
 * densifies identity without inventing anything.
 */
function absorbAliases(
  target: PlayerTrack,
  tracks: readonly PlayerTrack[],
  aliasIds: readonly number[],
): PlayerTrack {
  const byTime = new Map<number, PlayerFrame>();
  for (const frame of target.frames) byTime.set(frame.timestampMs, frame);
  for (const track of tracks) {
    if (!aliasIds.includes(track.trackId)) continue;
    for (const frame of track.frames) {
      const existing = byTime.get(frame.timestampMs);
      // Prefer the higher-confidence observation at each instant.
      if (!existing || frame.confidence > existing.confidence) byTime.set(frame.timestampMs, frame);
    }
  }
  const frames = [...byTime.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  return {
    ...target,
    frames,
    meanTorsoSpan: frames.reduce((total, frame) => total + frame.torsoSpan, 0) / frames.length,
  };
}

export function selectTargetPlayer(
  tracks: PlayerTrack[],
  options: { policy: "auto" | "explicit"; explicitTrackId?: number },
  window: { startMs: number; endMs: number } | null,
): Result<TargetSelection> {
  if (tracks.length === 0) {
    return fail(failure("low_confidence", "player.no_tracks", "No player tracks were formed."));
  }
  let target: PlayerTrack | undefined;
  let confidence: number;
  if (options.policy === "explicit") {
    target = tracks.find((track) => track.trackId === options.explicitTrackId);
    if (!target) {
      return fail(
        failure(
          "permanent",
          "player.unknown_track",
          `--player ${options.explicitTrackId} does not exist; available: ${tracks
            .map((track) => track.trackId)
            .join(", ")}`,
        ),
      );
    }
    confidence = 0.95;
  } else {
    const scored = tracks
      .map((track) => ({ track, score: track.coverage * track.meanTorsoSpan }))
      .sort((a, b) => b.score - a.score);
    target = scored[0]!.track;
    const runnerUp = scored[1]?.score ?? 0;
    confidence = Math.max(
      0.3,
      Math.min(0.95, runnerUp > 0 ? 1 - runnerUp / scored[0]!.score : 0.95),
    );
  }

  const risks: string[] = [];
  if (window) {
    const inWindowLoss = target.lossPeriods.filter(
      (loss) => loss.toMs >= window.startMs && loss.fromMs <= window.endMs,
    );
    if (inWindowLoss.length > 0) {
      risks.push(
        `TARGET_PLAYER_LOST: ${inWindowLoss.length} loss period(s) inside the stroke window`,
      );
    }
    const first = target.frames[0]!.timestampMs;
    const last = target.frames[target.frames.length - 1]!.timestampMs;
    if (first > window.startMs + 100 || last < window.endMs - 100) {
      risks.push("TARGET_PLAYER_PARTIAL: target track does not span the stroke window");
    }
  }
  if (options.policy === "auto" && confidence < 0.5) {
    risks.push("TARGET_SELECTION_AMBIGUOUS: runner-up player is nearly as prominent");
  }
  return ok({ target, policy: options.policy, confidence, allTracks: tracks, risks });
}

/** Canonical PoseSequence built from the TARGET track only. Gaps stay gaps. */
export function targetPoseSequence(file: PeopleFile, target: PlayerTrack): PoseSequence {
  return {
    schemaVersion: POSE_SEQUENCE_SCHEMA_VERSION,
    format: POSE_SEQUENCE_FORMAT,
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "pose.apple-vision+player-track",
      modelVersion: `${file.poseModelVersion}+${PLAYER_TRACKER_VERSION}`,
      runtime: "vision_framework",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: file.video.w, height: file.video.h, fps: file.video.fps },
    frames: target.frames.map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: frame.confidence,
      landmarks: frame.joints.map((joint) => ({
        name: joint.n,
        x: joint.x,
        y: joint.y,
        visibility: joint.v,
      })),
    })),
  };
}

/**
 * Wrist positions per timestamp for genuinely OTHER players.
 *
 * Critical correctness issue (found by the paddle loss waterfall, 2026-08-28):
 * Vision returns overlapping detections of the SAME person, so the tracker can
 * emit several tracks for one human (measured on afn-sasebo-rally1: the target
 * P1 plus duplicates P9 and P13 with torso-center distances of 0.058 / 0.068).
 * Feeding those duplicates in as "other players" put the TARGET'S OWN WRIST on
 * the other-player side of every ownership comparison, so the target's real
 * paddle was always "closer to another player" and was rejected. That single
 * bug cost 74 points of paddle recall (S2 0.96 → S3 0.22).
 *
 * Two levels of suppression, both identity-preserving rather than threshold
 * tuning:
 *  1. TRACK level — a track whose torso co-locates with the target (same
 *     person, duplicate detection) is not another player.
 *  2. WRIST level — an individual wrist sitting on top of a target wrist at
 *     the same instant is the same physical hand.
 */
const DUPLICATE_TORSO_DISTANCE = 0.12;
const DUPLICATE_WRIST_DISTANCE = 0.05;

export function otherPlayersWrists(
  tracks: PlayerTrack[],
  targetId: number,
  /** Known duplicate tracks of the target — never treated as opponents. */
  aliasTrackIds: readonly number[] = [],
): Array<{ timestampMs: number; wrists: Array<{ x: number; y: number }> }> {
  const target = tracks.find((track) => track.trackId === targetId);
  const targetByTime = new Map<number, PlayerFrame>();
  for (const frame of target?.frames ?? []) targetByTime.set(frame.timestampMs, frame);
  const nearestTargetFrame = (timestampMs: number): PlayerFrame | null => {
    let best: PlayerFrame | null = null;
    let bestDelta = Infinity;
    for (const [time, frame] of targetByTime) {
      const delta = Math.abs(time - timestampMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = frame;
      }
    }
    return best && bestDelta <= 40 ? best : null;
  };

  const byTime = new Map<number, Array<{ x: number; y: number }>>();
  for (const track of tracks) {
    if (track.trackId === targetId || aliasTrackIds.includes(track.trackId)) continue;
    // (1) Is this track a duplicate detection of the target person?
    let coincident = 0;
    let compared = 0;
    for (const frame of track.frames) {
      const targetFrame = nearestTargetFrame(frame.timestampMs);
      if (!targetFrame) continue;
      compared += 1;
      const distance = Math.hypot(
        frame.torsoMid.x - targetFrame.torsoMid.x,
        frame.torsoMid.y - targetFrame.torsoMid.y,
      );
      if (distance < DUPLICATE_TORSO_DISTANCE) coincident += 1;
    }
    if (compared > 0 && coincident / compared > 0.5) continue; // same person

    for (const frame of track.frames) {
      const targetFrame = nearestTargetFrame(frame.timestampMs);
      const targetWrists = (targetFrame?.joints ?? []).filter(
        (joint) => joint.n.endsWith("wrist") && joint.v >= 0.2,
      );
      const wrists = frame.joints
        .filter((joint) => joint.n.endsWith("wrist") && joint.v >= 0.2)
        // (2) Drop wrists that coincide with a target wrist (same hand).
        .filter(
          (joint) =>
            !targetWrists.some(
              (targetJoint) =>
                Math.hypot(joint.x - targetJoint.x, joint.y - targetJoint.y) <
                DUPLICATE_WRIST_DISTANCE,
            ),
        )
        .map((joint) => ({ x: joint.x, y: joint.y }));
      if (wrists.length === 0) continue;
      byTime.set(frame.timestampMs, [...(byTime.get(frame.timestampMs) ?? []), ...wrists]);
    }
  }
  return [...byTime.entries()]
    .map(([timestampMs, wrists]) => ({ timestampMs, wrists }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function describePerson(
  timestampMs: number,
  person: { c: number; l: Array<{ n: string; x: number; y: number; v: number }> },
): PlayerFrame | null {
  const byName = new Map(person.l.map((joint) => [joint.n, joint]));
  const torso = TORSO_JOINTS.map((name) => byName.get(name)).filter(
    (joint): joint is NonNullable<typeof joint> => !!joint && joint.v >= 0.2,
  );
  if (torso.length < 3) return null; // torso-less fragments cannot carry identity
  const midX = torso.reduce((total, joint) => total + joint.x, 0) / torso.length;
  const midY = torso.reduce((total, joint) => total + joint.y, 0) / torso.length;
  const shoulder =
    byName.get("left_shoulder") && byName.get("right_shoulder")
      ? {
          x: (byName.get("left_shoulder")!.x + byName.get("right_shoulder")!.x) / 2,
          y: (byName.get("left_shoulder")!.y + byName.get("right_shoulder")!.y) / 2,
        }
      : null;
  const hip =
    byName.get("left_hip") && byName.get("right_hip")
      ? {
          x: (byName.get("left_hip")!.x + byName.get("right_hip")!.x) / 2,
          y: (byName.get("left_hip")!.y + byName.get("right_hip")!.y) / 2,
        }
      : null;
  const torsoSpan = shoulder && hip ? Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) : 0.02;
  return {
    timestampMs,
    confidence: person.c,
    joints: person.l,
    torsoMid: { x: midX, y: midY },
    torsoSpan,
  };
}
