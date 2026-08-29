import type { PlayerTrack } from "../playerTracker.js";

/**
 * GAMEPLAY VALIDITY — a scene can be correctly segmented and still not be
 * live playable footage. Failure mining produced permanent exhibits: pose
 * fires on GRAPHIC humans (two title-card cases in the Ohana promo) and on
 * non-pickleball segments of multi-sport reels.
 *
 * This module implements the general signal for the first class:
 *
 *   LIVE humans always show RELATIVE joint motion (wrists move against the
 *   torso even when standing); graphic humans — stills, title cards,
 *   portraits, frozen frames — move RIGIDLY (pan/zoom shifts every joint by
 *   the same vector) or not at all. So liveness = wrist motion measured
 *   RELATIVE to the torso, not absolute image motion. No "looks like a
 *   title card" heuristics.
 *
 * Sport-context validity (pickleball vs other sports) is NOT decided here —
 * it needs court/ball evidence and is recorded as future work; wrong-sport
 * exhibits are preserved in the TA bench rejects.
 */

export const GAMEPLAY_VALIDITY_VERSION = "liveness-v1 (wrist-relative-to-torso motion, dense-evidence gate)";

/** Mean per-second wrist motion relative to torso below this = not alive. */
const MIN_RELATIVE_SPEED_PER_SEC = 0.02;
/** Tracks shorter than this can't be judged (too little evidence). */
const MIN_TRACK_MS = 1200;
/** A static verdict requires DENSE wrist evidence (pairs/second). Sparse
 * wrist detection is ambiguous: measured on real exhibits, an ANIMATED title
 * card shows 5.7 pairs/s of pure jitter — but a live player mid-swing with
 * motion blur can look identical (sparse + fast). Sparse tracks therefore
 * stay neutral here and are surfaced by failure mining for human review. */
const MIN_PAIRS_PER_SEC_FOR_VERDICT = 10;

export type Liveness = "live" | "static_or_graphic" | "too_short_to_judge";

export interface LivenessEvidence {
  verdict: Liveness;
  relativeSpeedPerSec: number;
  wristPairsPerSec: number;
  spanSec: number;
}

export function trackLivenessEvidence(track: PlayerTrack): LivenessEvidence {
  const frames = track.frames;
  const spanMs = frames.length >= 2 ? frames[frames.length - 1]!.timestampMs - frames[0]!.timestampMs : 0;
  const spanSec = spanMs / 1000;
  let relativeTravel = 0;
  let comparablePairs = 0;
  const previous: Record<string, { x: number; y: number } | undefined> = {};
  for (const frame of frames) {
    for (const side of ["left_wrist", "right_wrist"]) {
      const mark = frame.joints.find((joint) => joint.n === side && joint.v >= 0.2);
      if (!mark) {
        previous[side] = undefined;
        continue;
      }
      const relative = { x: mark.x - frame.torsoMid.x, y: mark.y - frame.torsoMid.y };
      const prior = previous[side];
      if (prior) {
        relativeTravel += Math.hypot(relative.x - prior.x, relative.y - prior.y);
        comparablePairs += 1;
      }
      previous[side] = relative;
    }
  }
  const relativeSpeedPerSec = spanSec > 0 ? relativeTravel / spanSec : 0;
  const wristPairsPerSec = spanSec > 0 ? comparablePairs / spanSec : 0;
  let verdict: Liveness;
  if (spanMs < MIN_TRACK_MS || comparablePairs < 5) verdict = "too_short_to_judge";
  else if (relativeSpeedPerSec >= MIN_RELATIVE_SPEED_PER_SEC) verdict = "live";
  else if (wristPairsPerSec >= MIN_PAIRS_PER_SEC_FOR_VERDICT) verdict = "static_or_graphic";
  else verdict = "too_short_to_judge"; // sparse & still: not enough to condemn
  return {
    verdict,
    relativeSpeedPerSec: Number(relativeSpeedPerSec.toFixed(4)),
    wristPairsPerSec: Number(wristPairsPerSec.toFixed(1)),
    spanSec: Number(spanSec.toFixed(2)),
  };
}

export function classifyTrackLiveness(track: PlayerTrack): Liveness {
  return trackLivenessEvidence(track).verdict;
}

/** Sparse-wrist high-jitter signature: EITHER an animated graphic human OR a
 * heavily blurred live swing — both deserve human review, neither should be
 * auto-invalidated. Measured exhibit: Ohana animated title card = 5.7
 * pairs/s at 0.12 rel-speed/s. */
export function sparseWristSuspect(evidence: LivenessEvidence): boolean {
  return evidence.spanSec >= 2 && evidence.wristPairsPerSec < 8 && evidence.relativeSpeedPerSec > 0.05;
}

export interface WindowValidity {
  valid: boolean;
  reason: string;
  liveTracks: number;
  staticTracks: number;
}

/** A window is invalid when it has judgeable people and NONE are alive. */
export function windowValidity(tracks: PlayerTrack[]): WindowValidity {
  const judged = tracks.map(classifyTrackLiveness);
  const live = judged.filter((entry) => entry === "live").length;
  const staticCount = judged.filter((entry) => entry === "static_or_graphic").length;
  if (live === 0 && staticCount > 0) {
    return {
      valid: false,
      reason: `all ${staticCount} judgeable person-tracks are static/graphic (title card, portrait, frozen frame)`,
      liveTracks: live,
      staticTracks: staticCount,
    };
  }
  return { valid: true, reason: live > 0 ? `${live} live tracks` : "no judgeable people (neutral)", liveTracks: live, staticTracks: staticCount };
}
