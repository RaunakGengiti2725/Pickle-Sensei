import type { PeopleFile } from "../playerTracker.js";

/**
 * TARGET-ACQUISITION REPLAY — faithful TS port of the LIVE product logic so
 * the guided-capture UX can be measured offline on real multi-person footage.
 *
 * Ported semantics (sources of truth, kept in sync BY TEST when changed):
 *  - GuidedCaptureViewController.considerTargetAcquisition:
 *      · torsoMid = mean of torso joints with v≥0.2, needs ≥3 of 4
 *      · occupant = torsoMid within 0.17 of the selected region
 *      · ≥2 occupants before lock → ambiguous → SUSTAINED gesture (5
 *        consecutive frames of wristElevation > 0.03) locks the raiser;
 *        after 3s with no gesture the occupant closest to the tapped
 *        region locks (source "ambiguity_timeout")
 *      · exactly 1 occupant → streak+1 · 0 occupants → streak=0
 *      · streak ≥ 9 consecutive frames → lock, seed = occupant torso
 *  - ApplePoseProvider.primaryPerson (post-lock identity following):
 *      · score = torsoSpan / (1 + 3·distance(torsoMid, anchor))
 *      · torsoSpan = |shoulderMid − hipMid| (needs all 4 joints, else 1e-6)
 *      · INCUMBENT HYSTERESIS: nearest-to-anchor candidate (≤0.12) keeps
 *        identity unless a challenger beats its score by 1/0.7 ≈ 1.43×
 *      · anchor updates to the winner's torsoMid when resolvable
 *
 * PROMOTION HISTORY: the pre-2026-08-28 shipped logic (sticky ambiguity,
 * single-frame gesture, no hysteresis) is preserved as LEGACY_VARIANT; the
 * promoted semantics (D-027) were measured on 36 human-verified cases
 * (dev n=31: correct locks 16→22, false gestures 2→0, on-target .543→.612;
 * held-out n=5 one-shot: locks 4/5→5/5, on-target .553→.639).
 *
 * The live loop runs at ~30fps; footage at other rates is resampled to a
 * ≥30ms frame grid so streak counts mean the same wall-clock time.
 */

export const TA_REPLAY_VERSION = "ta-replay-2 (D-027 promoted semantics as shipped)";

/** The promoted live configuration (matches the Swift as of D-027). */
export const SHIPPED_VARIANT: ReplayVariant = {
  followerHysteresis: true,
  ambiguityTimeoutMs: 3000,
  sustainedGestureFrames: 5,
};

/** Pre-promotion behavior, kept replayable for regression comparisons. */
export const LEGACY_VARIANT: ReplayVariant = {};

export const START_REGION_RADIUS = 0.17;
export const OCCUPANCY_FRAMES_TO_LOCK = 9;
export const GESTURE_ELEVATION = 0.03;

/** Post-lock rival within this score ratio of the chosen person = contested. */
export const FOLLOW_CONTEST_SCORE_RATIO = 0.7;
/** Incumbent radius of the live follower (ApplePoseProvider.primaryPerson). */
export const FOLLOW_INCUMBENT_RADIUS = 0.12;

// ── W3 candidate constants (bench-only; not shipped — D-026 gate applies) ──
/** Soft occupancy: people COUNT as region crowd at lower joint confidence… */
export const SOFT_OCCUPANT_MIN_V = 0.1;
/** …and slightly beyond the strict radius (0.17 → ~0.23). */
export const SOFT_REGION_RADIUS_SCALE = 1.35;
/** A dominance streak only continues if the dominant torso moved ≤ this. */
export const DOMINANCE_CONTINUITY_RADIUS = 0.08;

interface Person {
  joints: Array<{ n: string; x: number; y: number; v: number }>;
}

function joint(person: Person, name: string, minV = 0.2) {
  return person.joints.find((entry) => entry.n === name && entry.v >= minV) ?? null;
}

/** Capture-side torso mid: mean of visible torso joints, ≥3 required. */
export function captureTorsoMid(person: Person): { x: number; y: number } | null {
  const marks = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"]
    .map((name) => joint(person, name))
    .filter((mark): mark is NonNullable<typeof mark> => mark !== null);
  if (marks.length < 3) return null;
  return {
    x: marks.reduce((total, mark) => total + mark.x, 0) / marks.length,
    y: marks.reduce((total, mark) => total + mark.y, 0) / marks.length,
  };
}

/** Provider-side torso mid/span: all 4 joints required (span falls to 1e-6). */
function providerTorso(person: Person): { mid: { x: number; y: number } | null; span: number } {
  const ls = joint(person, "left_shoulder");
  const rs = joint(person, "right_shoulder");
  const lh = joint(person, "left_hip");
  const rh = joint(person, "right_hip");
  if (!ls || !rs || !lh || !rh) return { mid: null, span: 1e-6 };
  const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  return {
    mid: { x: (ls.x + rs.x + lh.x + rh.x) / 4, y: (ls.y + rs.y + lh.y + rh.y) / 4 },
    span: Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y),
  };
}

export function wristElevation(person: Person): number {
  const shoulders = person.joints.filter((entry) => entry.n.endsWith("shoulder") && entry.v >= 0.2);
  const wrists = person.joints.filter((entry) => entry.n.endsWith("wrist") && entry.v >= 0.2);
  if (shoulders.length === 0 || wrists.length === 0) return -1;
  return Math.min(...shoulders.map((mark) => mark.y)) - Math.min(...wrists.map((mark) => mark.y));
}

export interface ReplayFrame {
  t: number;
  people: Person[];
}

/** Resample to ≤~30fps so a 9-frame streak means the same wall-clock time. */
export function resampleTo30fps(frames: ReplayFrame[]): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  let lastT = -Infinity;
  for (const frame of frames) {
    if (frame.t - lastT >= 30) {
      out.push(frame);
      lastT = frame.t;
    }
  }
  return out;
}

export function peopleFileToReplayFrames(
  file: PeopleFile,
  startMs: number,
  endMs: number,
): ReplayFrame[] {
  return file.frames
    .filter((frame) => frame.t >= startMs && frame.t < endMs)
    .map((frame) => ({ t: frame.t, people: frame.p.map((person) => ({ joints: person.l })) }));
}

/**
 * Lock sources. The first three are the live/shipped sources; the last two
 * only exist in W3 bench candidates (never emitted by shipped/legacy):
 *   occupancy_dominance — crowded region, one occupant stayed clearly
 *     closest for N frames (replaces the silent instant grab).
 *   ambiguity_dominance — ambiguity resolved by sustained occupancy
 *     dominance instead of the blind closest-at-timeout snapshot.
 */
export type LockSource =
  | "start_region_occupancy"
  | "gesture_confirmed"
  | "ambiguity_timeout"
  | "occupancy_dominance"
  | "ambiguity_dominance";

export interface AcquisitionEvent {
  t: number;
  kind: "ambiguous_entered" | "locked";
  source?: LockSource;
  torso?: { x: number; y: number };
}

export interface ReplayResult {
  events: AcquisitionEvent[];
  lock: {
    t: number;
    source: LockSource;
    torso: { x: number; y: number };
  } | null;
  ambiguityEntered: boolean;
  /**
   * Post-lock follower pick per frame: torso of the chosen person, plus
   * ADDITIVE identity-continuity diagnostics (decisions are untouched):
   *   contested — a rival person scored within FOLLOW_CONTEST_SCORE_RATIO of
   *     the chosen one, or ≥2 people sat inside the incumbent radius of the
   *     anchor — the geometry in which the follower can switch humans.
   *   jumped — the anchor moved more than the incumbent radius in one frame
   *     (a discontinuous identity hand-off, e.g. reacquiring after a loss).
   */
  follow: Array<{
    t: number;
    torso: { x: number; y: number } | null;
    contested?: boolean;
    jumped?: boolean;
  }>;
  /** Count of post-lock frames flagged contested. */
  followContestedFrames: number;
  /** Count of post-lock anchor jumps (> incumbent radius in one frame). */
  followJumps: number;
}

/**
 * Replay variants. SHIPPED_VARIANT is the promoted D-027 configuration that
 * the Swift now implements; LEGACY_VARIANT ({}) replays the pre-promotion
 * behavior. Ablations remain measurable individually:
 *   followerHysteresis — post-lock: challenger must beat the incumbent's
 *     score by a margin before identity moves (playerTracker's cure applied
 *     to the live follower).
 *   ambiguityTimeoutMs — ambiguity falls back after N ms to locking the
 *     occupant closest to the region center (measured dead-end fix).
 *   sustainedGestureFrames — gesture needs N consecutive elevated frames,
 *     not a single-frame wrist flick (natural false-gesture fix).
 *
 * W3 BENCH CANDIDATES (wave-b; measured against the n=54 dev gold — NOT
 * shipped, D-026 gate applies):
 *   occupancyDominance — when the region is CROWDED (any second person at
 *     soft visibility/radius), the silent instant single-occupant lock is
 *     forbidden. Lock requires the occupant to stay clearly closest to the
 *     region center (marginRatio× closer than every other soft occupant,
 *     same person by continuity) for framesToDominate frames; if crowding
 *     persists without dominance for stallFramesToAmbiguity frames, enter
 *     honest ambiguity instead (targets the 9 silent instant wrong grabs).
 *     MEASURED GAP (dev n=54): in the 9 wrong instant grabs the true target
 *     is not pose-detected AT ALL early (first detection 0.5–6.5s into the
 *     window), so no crowd detector can fire. The decision-time signal that
 *     separates them is DISTANCE TO THE TAPPED POINT: 23/25 correct instant
 *     locks sit ≤0.04 from it, 8/9 wrong grabs ≥0.056. Hence:
 *       centeredRadius — the instant/dominance lock additionally requires
 *         the occupant within this of the tapped point;
 *       patienceFrames — an OFF-CENTER sole occupant never insta-locks;
 *         after this many sole-occupant frames it enters honest ambiguity
 *         (recoverable: gesture, later-appearing centered target, or the
 *         last-resort timeout still resolve it).
 *   ambiguityDominance — ambiguity can resolve by sustained occupancy
 *     dominance (same margin semantics, frames frames), not only by
 *     gesture or the blind closest-at-timeout snapshot (targets the 6
 *     wrong timeout defaults). Its optional centeredRadius applies the
 *     same tap-proximity bar to the dominance candidate — in particular a
 *     SOLE occupant (no rivals ⇒ vacuous margin) cannot claim dominance
 *     from far off the tapped point. Combine with a LONGER
 *     ambiguityTimeoutMs as a last resort.
 */
export interface ReplayVariant {
  followerHysteresis?: boolean;
  ambiguityTimeoutMs?: number;
  sustainedGestureFrames?: number;
  occupancyDominance?: {
    marginRatio: number;
    framesToDominate: number;
    stallFramesToAmbiguity: number;
    centeredRadius?: number;
    patienceFrames?: number;
  };
  ambiguityDominance?: {
    marginRatio: number;
    frames: number;
    centeredRadius?: number;
  };
}

/** Soft torso mid for crowd detection: ≥2 torso joints at v ≥ SOFT_OCCUPANT_MIN_V. */
function softTorsoMid(person: Person): { x: number; y: number } | null {
  const marks = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"]
    .map((name) => joint(person, name, SOFT_OCCUPANT_MIN_V))
    .filter((mark): mark is NonNullable<typeof mark> => mark !== null);
  if (marks.length < 2) return null;
  return {
    x: marks.reduce((total, mark) => total + mark.x, 0) / marks.length,
    y: marks.reduce((total, mark) => total + mark.y, 0) / marks.length,
  };
}

/** People near the region under the RELAXED thresholds (crowd detector). */
function softRegionOccupants(
  people: Person[],
  region: { x: number; y: number },
): Array<{ person: Person; dist: number }> {
  const out: Array<{ person: Person; dist: number }> = [];
  for (const person of people) {
    const torso = softTorsoMid(person);
    if (!torso) continue;
    const dist = Math.hypot(torso.x - region.x, torso.y - region.y);
    if (dist <= START_REGION_RADIUS * SOFT_REGION_RADIUS_SCALE) out.push({ person, dist });
  }
  return out;
}

export function replayAcquisition(
  frames: ReplayFrame[],
  region: { x: number; y: number },
  variant: ReplayVariant = {},
): ReplayResult {
  const events: AcquisitionEvent[] = [];
  let ambiguous = false;
  let ambiguousSinceMs: number | null = null;
  const gestureStreaks = new Map<number, number>();
  let streak = 0;
  let lock: ReplayResult["lock"] = null;
  let anchor: { x: number; y: number } | null = null;
  const follow: ReplayResult["follow"] = [];
  // W3 candidate state — inert unless the variant opts in.
  let dominanceStreak = 0;
  let lastDominantTorso: { x: number; y: number } | null = null;
  let crowdStall = 0;
  let offCenterPatience = 0;
  let ambDominanceStreak = 0;
  let lastAmbDominantTorso: { x: number; y: number } | null = null;

  const lockAt = (
    t: number,
    source: NonNullable<ReplayResult["lock"]>["source"],
    torso: { x: number; y: number },
  ) => {
    lock = { t, source, torso };
    anchor = torso;
    events.push({ t, kind: "locked", source, torso });
  };

  for (const frame of frames) {
    if (lock) {
      // ApplePoseProvider.primaryPerson with the anchor seeded at lock.
      // Decisions below are the pinned live semantics; the contested/jumped
      // flags are additive observation only.
      let best: { span: number; mid: { x: number; y: number } | null; score: number } | null = null;
      let incumbent: { span: number; mid: { x: number; y: number } | null; score: number } | null =
        null;
      const scored: Array<{ mid: { x: number; y: number } | null; score: number }> = [];
      let inRadius = 0;
      for (const person of frame.people) {
        const torso = providerTorso(person);
        const score: number =
          anchor && torso.mid
            ? torso.span / (1 + 3 * Math.hypot(torso.mid.x - anchor.x, torso.mid.y - anchor.y))
            : torso.span;
        scored.push({ mid: torso.mid, score });
        if (
          anchor &&
          torso.mid &&
          Math.hypot(torso.mid.x - anchor.x, torso.mid.y - anchor.y) <= FOLLOW_INCUMBENT_RADIUS
        ) {
          inRadius += 1;
        }
        if (!best || score > best.score) best = { ...torso, score };
        if (
          variant.followerHysteresis &&
          anchor &&
          torso.mid &&
          Math.hypot(torso.mid.x - anchor.x, torso.mid.y - anchor.y) <= FOLLOW_INCUMBENT_RADIUS &&
          (!incumbent || score > incumbent.score)
        ) {
          incumbent = { ...torso, score };
        }
      }
      let chosen = best;
      if (variant.followerHysteresis && incumbent) {
        // The incumbent (near the previous anchor) keeps identity unless the
        // challenger is decisively better (1/0.7 ≈ 1.43×, playerTracker gate).
        if (!best || best.score <= incumbent.score / 0.7) chosen = incumbent;
      }
      const rivalContest =
        chosen !== null &&
        scored.some(
          (entry) =>
            entry !== null &&
            entry.mid !== null &&
            chosen!.mid !== null &&
            (entry.mid.x !== chosen!.mid.x || entry.mid.y !== chosen!.mid.y) &&
            entry.score >= FOLLOW_CONTEST_SCORE_RATIO * chosen!.score,
        );
      const contested = rivalContest || inRadius >= 2;
      const jumped =
        anchor !== null &&
        chosen?.mid != null &&
        Math.hypot(chosen.mid.x - anchor.x, chosen.mid.y - anchor.y) > FOLLOW_INCUMBENT_RADIUS;
      if (chosen?.mid) anchor = chosen.mid;
      follow.push({
        t: frame.t,
        torso: chosen?.mid ?? null,
        ...(contested ? { contested: true } : {}),
        ...(jumped ? { jumped: true } : {}),
      });
      continue;
    }

    const occupants = frame.people
      .map((person) => ({ person, torso: captureTorsoMid(person) }))
      .filter((entry): entry is { person: Person; torso: { x: number; y: number } } => {
        if (!entry.torso) return false;
        return (
          Math.hypot(entry.torso.x - region.x, entry.torso.y - region.y) <= START_REGION_RADIUS
        );
      });

    if (ambiguous) {
      ambiguousSinceMs ??= frame.t;
      for (const [index, occupant] of occupants.entries()) {
        const elevated = wristElevation(occupant.person) > GESTURE_ELEVATION;
        const needed = variant.sustainedGestureFrames ?? 1;
        const streakNow = elevated ? (gestureStreaks.get(index) ?? 0) + 1 : 0;
        gestureStreaks.set(index, streakNow);
        if (streakNow >= needed) {
          lockAt(frame.t, "gesture_confirmed", occupant.torso);
          break;
        }
      }
      if (!lock && variant.ambiguityDominance && occupants.length > 0) {
        // W3 (b): ambiguity may resolve by SUSTAINED occupancy dominance —
        // the closest resolvable occupant stays marginRatio× closer than
        // every other (soft) occupant for `frames` consecutive frames.
        // Unlike the timeout it is a sustained condition, not a snapshot.
        const config = variant.ambiguityDominance;
        const candidate = occupants.reduce((bestOccupant, occupant) =>
          Math.hypot(occupant.torso.x - region.x, occupant.torso.y - region.y) <
          Math.hypot(bestOccupant.torso.x - region.x, bestOccupant.torso.y - region.y)
            ? occupant
            : bestOccupant,
        );
        const candidateDist = Math.hypot(
          candidate.torso.x - region.x,
          candidate.torso.y - region.y,
        );
        const others = softRegionOccupants(frame.people, region).filter(
          (soft) => soft.person !== candidate.person,
        );
        const centered =
          config.centeredRadius === undefined || candidateDist <= config.centeredRadius;
        if (centered && others.every((other) => other.dist >= config.marginRatio * candidateDist)) {
          const continuous =
            !lastAmbDominantTorso ||
            Math.hypot(
              candidate.torso.x - lastAmbDominantTorso.x,
              candidate.torso.y - lastAmbDominantTorso.y,
            ) <= DOMINANCE_CONTINUITY_RADIUS;
          ambDominanceStreak = continuous ? ambDominanceStreak + 1 : 1;
          lastAmbDominantTorso = candidate.torso;
          if (ambDominanceStreak >= config.frames)
            lockAt(frame.t, "ambiguity_dominance", candidate.torso);
        } else {
          ambDominanceStreak = 0;
          lastAmbDominantTorso = null;
        }
      }
      if (
        !lock &&
        variant.ambiguityTimeoutMs !== undefined &&
        frame.t - ambiguousSinceMs >= variant.ambiguityTimeoutMs &&
        occupants.length > 0
      ) {
        const closest = occupants.reduce((bestOccupant, occupant) =>
          Math.hypot(occupant.torso.x - region.x, occupant.torso.y - region.y) <
          Math.hypot(bestOccupant.torso.x - region.x, bestOccupant.torso.y - region.y)
            ? occupant
            : bestOccupant,
        );
        lockAt(frame.t, "ambiguity_timeout", closest.torso);
      }
      continue;
    }
    if (occupants.length >= 2) {
      ambiguous = true;
      events.push({ t: frame.t, kind: "ambiguous_entered" });
      continue;
    }
    const occupant = occupants[0];
    if (!occupant) {
      streak = 0;
      dominanceStreak = 0;
      lastDominantTorso = null;
      offCenterPatience = 0;
      continue;
    }
    streak += 1;
    if (variant.occupancyDominance) {
      const gate = variant.occupancyDominance;
      const others = softRegionOccupants(frame.people, region).filter(
        (soft) => soft.person !== occupant.person,
      );
      const occupantDist = Math.hypot(occupant.torso.x - region.x, occupant.torso.y - region.y);
      const centered = gate.centeredRadius === undefined || occupantDist <= gate.centeredRadius;
      if (others.length > 0) {
        // W3 (a): CROWDED region (a second person at soft visibility/radius).
        // The silent instant single-occupant lock is FORBIDDEN here — the
        // occupant must stay clearly closest (marginRatio×, same person,
        // near the tapped point) for framesToDominate frames; sustained
        // crowding without dominance goes to honest ambiguity, which
        // resolves via the normal paths.
        if (centered && others.every((other) => other.dist >= gate.marginRatio * occupantDist)) {
          const continuous =
            !lastDominantTorso ||
            Math.hypot(
              occupant.torso.x - lastDominantTorso.x,
              occupant.torso.y - lastDominantTorso.y,
            ) <= DOMINANCE_CONTINUITY_RADIUS;
          dominanceStreak = continuous ? dominanceStreak + 1 : 1;
          lastDominantTorso = occupant.torso;
          if (dominanceStreak >= gate.framesToDominate) {
            lockAt(frame.t, "occupancy_dominance", occupant.torso);
            continue;
          }
        } else {
          dominanceStreak = 0;
          lastDominantTorso = null;
        }
        crowdStall += 1;
        if (crowdStall >= gate.stallFramesToAmbiguity) {
          ambiguous = true;
          events.push({ t: frame.t, kind: "ambiguous_entered" });
        }
        continue;
      }
      // Crowd left: dominance bookkeeping resets and the plain path resumes.
      dominanceStreak = 0;
      lastDominantTorso = null;
      crowdStall = 0;
      if (!centered) {
        // W3 (a2): sole occupant OFF the tapped point — the measured wrong-
        // grab signature (the tapped target is often not pose-detected yet).
        // Never insta-lock; after patienceFrames go to honest ambiguity,
        // where a later-appearing centered target, a gesture, or the
        // last-resort timeout resolve it.
        offCenterPatience += 1;
        if (gate.patienceFrames !== undefined && offCenterPatience >= gate.patienceFrames) {
          ambiguous = true;
          events.push({ t: frame.t, kind: "ambiguous_entered" });
        }
        continue;
      }
      offCenterPatience = 0;
    }
    if (streak >= OCCUPANCY_FRAMES_TO_LOCK) {
      lockAt(frame.t, "start_region_occupancy", occupant.torso);
    }
  }
  return {
    events,
    lock,
    ambiguityEntered: ambiguous,
    follow,
    followContestedFrames: follow.filter((entry) => entry.contested === true).length,
    followJumps: follow.filter((entry) => entry.jumped === true).length,
  };
}

// ── Variant registry ──────────────────────────────────────────────────────

/** W3 defaults: dominance = 1.5× closer than every rival, ~300ms sustained. */
export const W3_OCCUPANCY_DOMINANCE: NonNullable<ReplayVariant["occupancyDominance"]> = {
  marginRatio: 1.5,
  framesToDominate: 9, // same wall-clock bar as the plain occupancy streak
  stallFramesToAmbiguity: 12, // ~400ms of crowding without dominance → ambiguity
};

export const W3_AMBIGUITY_DOMINANCE: NonNullable<ReplayVariant["ambiguityDominance"]> = {
  marginRatio: 1.5,
  frames: 12, // ~400ms sustained — deliberately above the 9-frame gate bar
};

/**
 * W3.2 tap-proximity bar, chosen from the measured dev separation (shipped
 * locks, n=54): correct instant locks sit ≤0.04 of the tapped point in
 * 23/25 cases; wrong instant grabs sit ≥0.056 in 8/9. 0.05 splits them.
 */
export const W3_CENTERED_RADIUS = 0.05;

export const W3_OCCUPANCY_DOMINANCE_CENTERED: NonNullable<ReplayVariant["occupancyDominance"]> = {
  ...W3_OCCUPANCY_DOMINANCE,
  centeredRadius: W3_CENTERED_RADIUS,
  patienceFrames: 30, // ~1s of off-center sole occupancy → honest ambiguity
};

export const W3_AMBIGUITY_DOMINANCE_CENTERED: NonNullable<ReplayVariant["ambiguityDominance"]> = {
  ...W3_AMBIGUITY_DOMINANCE,
  centeredRadius: W3_CENTERED_RADIUS,
};

/**
 * Named variants runnable by the bench (`pnpm lab:ta-bench run --variant X`).
 * shipped/legacy are the pinned product semantics (regression-tested); the
 * wave-b entries are W3 BENCH-ONLY candidates targeting the measured n=54
 * failure anatomy (9 silent instant wrong grabs, 6 wrong timeout defaults,
 * 2 false gesture locks — see datasets/experiments/wave-a/K-summary.json).
 */
export const REPLAY_VARIANTS: Record<string, ReplayVariant> = {
  shipped: SHIPPED_VARIANT, // D-027 promoted config (matches current Swift)
  legacy: LEGACY_VARIANT, // pre-2026-08-28 behavior, for regression comparison
  hysteresis: { followerHysteresis: true },
  "ambiguity-timeout": { ambiguityTimeoutMs: 3000 },
  "sustained-gesture": { sustainedGestureFrames: 5 },
  candidate: SHIPPED_VARIANT, // historical alias from the D-027 promotion experiment
  // ── wave-b (W3) candidates ──
  "dominance-gate": { ...SHIPPED_VARIANT, occupancyDominance: W3_OCCUPANCY_DOMINANCE },
  "sustained-ambiguity": {
    ...SHIPPED_VARIANT,
    ambiguityTimeoutMs: 6000, // last resort only — dominance/gesture resolve first
    ambiguityDominance: W3_AMBIGUITY_DOMINANCE,
  },
  "acquire-v3": {
    ...SHIPPED_VARIANT,
    occupancyDominance: W3_OCCUPANCY_DOMINANCE,
    ambiguityTimeoutMs: 6000,
    ambiguityDominance: W3_AMBIGUITY_DOMINANCE,
  },
  "acquire-v3-strict-gesture": {
    ...SHIPPED_VARIANT,
    occupancyDominance: W3_OCCUPANCY_DOMINANCE,
    ambiguityTimeoutMs: 6000,
    ambiguityDominance: W3_AMBIGUITY_DOMINANCE,
    sustainedGestureFrames: 8, // the 2 false gesture locks survived 5 frames
  },
  // W3.2 — adds the measured tap-proximity bar (see W3_CENTERED_RADIUS):
  // the 9 instant wrong grabs happen with the true target entirely
  // pose-undetected, so only the distance-to-tap signal exists at decision
  // time. Off-center sole occupants defer to honest ambiguity instead of
  // silently locking.
  "centered-gate": { ...SHIPPED_VARIANT, occupancyDominance: W3_OCCUPANCY_DOMINANCE_CENTERED },
  "acquire-v4": {
    ...SHIPPED_VARIANT,
    occupancyDominance: W3_OCCUPANCY_DOMINANCE_CENTERED,
    ambiguityTimeoutMs: 6000,
    ambiguityDominance: W3_AMBIGUITY_DOMINANCE_CENTERED,
  },
  "acquire-v4-strict-gesture": {
    ...SHIPPED_VARIANT,
    occupancyDominance: W3_OCCUPANCY_DOMINANCE_CENTERED,
    ambiguityTimeoutMs: 6000,
    ambiguityDominance: W3_AMBIGUITY_DOMINANCE_CENTERED,
    sustainedGestureFrames: 8,
  },
};
