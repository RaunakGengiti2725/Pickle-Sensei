import {
  CHECKPOINTS,
  PHASES,
  type CheckpointKey,
  type FaultDirection,
  type PhaseKey,
  type ScoreBand,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import {
  CHECKPOINT_NAMES,
  humanizeToken,
} from '../components/strokeResultModel';

/**
 * FORM REVIEW view model — pure selectors that turn one ShotAnalysis (plus
 * its recorded pose sequence, when one exists) into a guided replay script:
 * where to pause, what was measured there, what to do about it, and which
 * joints to warm on the exoskeleton overlay.
 *
 * HONESTY CONTRACT (hard rule): every stop, headline, cue and arrow traces
 * to a checkpoint the scoring engine actually scored (applicable, finite
 * score) and to a phase span the on-device segmenter actually measured.
 * Pose frames are never interpolated — a frame is either recorded within
 * POSE_FRAME_TOLERANCE_MS of the requested time or it is null.
 *
 * Every cue matches the METRIC behind its checkpoint (packages/scoring
 * config/v1): `paddle_*`, contact and stability checkpoints are measured at
 * the dominant WRIST (no paddle is tracked), so the copy coaches the hand.
 *
 * All functions are pure (no React, no IO) so jest pins them directly.
 */

// ─── Joints and the exoskeleton ─────────────────────────────────────────────

export const REVIEW_JOINTS = [
  'head',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;
export type ReviewJoint = (typeof REVIEW_JOINTS)[number];

/** Bones of the exoskeleton, pairs of joints (12 limb/torso segments; the
 * head↔shoulder-midpoint neck is drawn by callers). */
export const SKELETON_SEGMENTS: ReadonlyArray<
  readonly [ReviewJoint, ReviewJoint]
> = [
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

// ─── Pose sequence (structural mirror of the parsed sidecar) ────────────────

/**
 * Structural subset of @pickle/swing-domain's parsed PoseSequence
 * (`parsePoseSequence` output) and of the legacy shared-types PoseFrame, so
 * callers pass either value directly. Coordinates are normalized to the
 * video frame, top-left origin; timestamps are clip-relative ms.
 */
export interface ReviewPoseLandmark {
  name: string;
  x: number;
  y: number;
  visibility: number;
}

export interface ReviewPoseFrame {
  timestampMs: number;
  landmarks: readonly ReviewPoseLandmark[];
  confidence: number;
}

/** Clip metadata in the parsed shape (`{width,height,fps}`) or the sidecar
 * wire shape (`{w,h,fps}`); `reviewVideoSize` normalizes either. */
export type ReviewVideoMeta =
  | { width: number; height: number; fps: number }
  | { w: number; h: number; fps: number };

export interface ReviewPoseSequence {
  /** Ascending by timestampMs; gaps are real (missed inference), never filled. */
  frames: readonly ReviewPoseFrame[];
  video?: ReviewVideoMeta;
}

export function reviewVideoSize(
  sequence: ReviewPoseSequence | null,
): { width: number; height: number; fps: number } | null {
  const video = sequence?.video;
  if (!video) return null;
  const width = 'width' in video ? video.width : video.w;
  const height = 'height' in video ? video.height : video.h;
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height, fps: finite(video.fps) ? video.fps : 0 };
}

export const POSE_FRAME_TOLERANCE_MS = 120;

/** Same visibility floor the geometry layer applies before it trusts a
 * landmark (packages/vision-geometry kinematics MIN_LANDMARK_VISIBILITY). */
const MIN_LANDMARK_VISIBILITY = 0.3;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Nearest recorded frame to tMs (binary search; frames are time-ordered)
 * within POSE_FRAME_TOLERANCE_MS, else null — never interpolated/invented.
 * Exact ties prefer the earlier frame (the one already shown at tMs).
 */
export function poseFrameAt(
  sequence: ReviewPoseSequence | null,
  tMs: number,
): ReviewPoseFrame | null {
  const frames = sequence?.frames;
  if (!frames || frames.length === 0 || !Number.isFinite(tMs)) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const frame = frames[mid];
    if (frame !== undefined && frame.timestampMs < tMs) low = mid + 1;
    else high = mid;
  }
  // frames[low] is the first frame at/after tMs (or the last frame); the
  // frame before it is the only other nearest candidate.
  const after = frames[low];
  const before = low > 0 ? frames[low - 1] : undefined;
  let best = after ?? null;
  if (
    before &&
    after &&
    Math.abs(before.timestampMs - tMs) <= Math.abs(after.timestampMs - tMs)
  ) {
    best = before;
  }
  if (!best || !(Math.abs(best.timestampMs - tMs) <= POSE_FRAME_TOLERANCE_MS)) {
    return null;
  }
  return best;
}

function jointAt(
  frame: ReviewPoseFrame | null,
  joint: ReviewJoint,
): ReviewPoseLandmark | null {
  if (!frame || !Array.isArray(frame.landmarks)) return null;
  const found = frame.landmarks.find(mark => mark.name === joint);
  if (!found || !finite(found.x) || !finite(found.y)) return null;
  if (!(found.visibility >= MIN_LANDMARK_VISIBILITY)) return null;
  return found;
}

/** Path length of a joint across frames inside [startMs, endMs] in
 * normalized-image units (aspect 1, exactly as the on-device segmenter runs);
 * null when fewer than two measured samples exist — nothing was measured. */
function jointPathLength(
  sequence: ReviewPoseSequence | null,
  joint: ReviewJoint,
  window: { startMs: number; endMs: number },
): number | null {
  const frames = sequence?.frames;
  if (!frames) return null;
  let previous: ReviewPoseLandmark | null = null;
  let samples = 0;
  let total = 0;
  for (const frame of frames) {
    if (
      !frame ||
      !(frame.timestampMs >= window.startMs) ||
      !(frame.timestampMs <= window.endMs)
    ) {
      continue;
    }
    const point = jointAt(frame, joint);
    if (!point) continue;
    samples += 1;
    if (previous)
      total += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return samples >= 2 ? total : null;
}

// ─── Dominant side and facing ───────────────────────────────────────────────

export type DominantSide = 'left' | 'right';

/**
 * The swinging hand, by the phase segmenter's rule: the wrist that travels
 * farthest inside the stroke window wins (measured, not assumed). Only when
 * neither wrist was measured does handedness decide ('left' → left,
 * otherwise right — ambidextrous players default to the right hand).
 */
export function dominantSide(
  sequence: ReviewPoseSequence | null,
  window: { startMs: number; endMs: number },
  handedness: ShotAnalysis['handedness'],
): DominantSide {
  const left = jointPathLength(sequence, 'left_wrist', window);
  const right = jointPathLength(sequence, 'right_wrist', window);
  if (left === null && right === null) {
    return handedness === 'left' ? 'left' : 'right';
  }
  return (right ?? 0) >= (left ?? 0) ? 'right' : 'left';
}

/** Below this normalized x displacement the facing is not measurable. */
const FACING_MIN_DX = 0.002;

/**
 * +1 when the player faces image-right (dominant wrist x increases through
 * accelerate→contact), -1 when facing image-left; derived from the dominant
 * wrist's x displacement between the accelerate phase start and contact;
 * falls back to +1 when unmeasurable (no phases, no frames, still wrist).
 */
export function facingSign(
  sequence: ReviewPoseSequence | null,
  analysis: ShotAnalysis,
  side: DominantSide,
): 1 | -1 {
  const phases = knownPhases(analysis);
  const accelerate = phases.find(phase => phase.key === 'accelerate');
  const contact = phases.find(phase => phase.key === 'contact');
  const startMs = accelerate?.startMs;
  const contactMs = contact?.representativeMs ?? analysis.timestamps?.contactMs;
  if (!finite(startMs) || !finite(contactMs)) return 1;
  const wrist = jointFor(side, 'wrist');
  const start = jointAt(poseFrameAt(sequence, startMs), wrist);
  const end = jointAt(poseFrameAt(sequence, contactMs), wrist);
  if (!start || !end) return 1;
  const dx = end.x - start.x;
  if (!(Math.abs(dx) >= FACING_MIN_DX)) return 1;
  return dx > 0 ? 1 : -1;
}

// ─── Checkpoint ↔ phase ↔ joint vocabulary ──────────────────────────────────

export type StopVerdict = 'strong' | 'watch' | 'fix';

export interface ReviewStopCheckpoint {
  key: CheckpointKey;
  name: string;
  score: number;
  band: ScoreBand;
  direction: FaultDirection;
  severity: number;
}

export interface ReviewArrow {
  joint: ReviewJoint;
  /** Body-relative direction the joint should move toward. */
  direction:
    'up' | 'down' | 'forward' | 'back' | 'wider' | 'narrower' | 'steadier';
  label: string;
}

export interface ReviewStop {
  id: string;
  phase: PhaseKey;
  atMs: number;
  startMs: number;
  endMs: number;
  title: string;
  verdict: StopVerdict;
  /** Worst-first (lowest score first). */
  checkpoints: ReviewStopCheckpoint[];
  headline: string;
  cue: string;
  focusJoints: ReviewJoint[];
  arrow: ReviewArrow | null;
}

export type JointHeat = Partial<Record<ReviewJoint, number>>;

export interface FormReviewScript {
  shotType: ShotTypeSlug;
  dominant: DominantSide;
  facing: 1 | -1;
  stops: ReviewStop[];
  jointHeat: JointHeat;
  strongest: ReviewStopCheckpoint | null;
  weakest: ReviewStopCheckpoint | null;
}

/** The phase whose frames each checkpoint's metric is measured from. */
export const CHECKPOINT_PHASE: Record<CheckpointKey, PhaseKey> = {
  ready_position: 'ready',
  athletic_base: 'ready',
  preparation: 'prepare',
  paddle_set: 'prepare',
  swing_length: 'prepare',
  sequencing: 'accelerate',
  paddle_path: 'accelerate',
  contact_position: 'contact',
  face_wrist_stability: 'contact',
  follow_through: 'follow_through',
  recovery: 'recover',
};

export const PHASE_TITLES: Record<PhaseKey, string> = {
  ready: 'Ready stance',
  prepare: 'Preparation',
  accelerate: 'Acceleration',
  contact: 'Contact',
  follow_through: 'Follow-through',
  recover: 'Recovery',
};

function isCheckpointKey(value: unknown): value is CheckpointKey {
  return (
    typeof value === 'string' &&
    (CHECKPOINTS as readonly string[]).includes(value)
  );
}

function isPhaseKey(value: unknown): value is PhaseKey {
  return (
    typeof value === 'string' && (PHASES as readonly string[]).includes(value)
  );
}

function checkpointName(key: string): string {
  return CHECKPOINT_NAMES[key] ?? humanizeToken(key);
}

type SidePart = 'shoulder' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle';

function jointFor(side: DominantSide, part: SidePart): ReviewJoint {
  return `${side}_${part}`;
}

/**
 * Joints a checkpoint's metric is built from, dominant-side aware. Arm
 * checkpoints (paddle set/path, swing length, contact, stability,
 * follow-through) are measured at the swinging wrist and its arm; the
 * lower-body and turn checkpoints use both sides.
 */
export function checkpointJoints(
  key: CheckpointKey,
  side: DominantSide,
): ReviewJoint[] {
  switch (key) {
    case 'ready_position':
      return [jointFor(side, 'wrist'), 'left_hip', 'right_hip'];
    case 'athletic_base':
      return [
        'left_hip',
        'right_hip',
        'left_knee',
        'right_knee',
        'left_ankle',
        'right_ankle',
      ];
    case 'preparation':
      return [
        'left_shoulder',
        'right_shoulder',
        'left_hip',
        'right_hip',
        jointFor(side, 'elbow'),
      ];
    case 'sequencing':
      return ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];
    case 'recovery':
      return [
        'left_hip',
        'right_hip',
        'left_knee',
        'right_knee',
        'left_ankle',
        'right_ankle',
        'left_wrist',
        'right_wrist',
      ];
    case 'paddle_set':
    case 'swing_length':
    case 'paddle_path':
    case 'contact_position':
    case 'face_wrist_stability':
    case 'follow_through':
    default:
      return [
        jointFor(side, 'wrist'),
        jointFor(side, 'elbow'),
        jointFor(side, 'shoulder'),
      ];
  }
}

// ─── Coaching cues — one per measured direction, shot-aware where it matters ─

/** A cue, optionally specialised per shot; `default` covers the rest. */
type ShotCue =
  string | ({ default: string } & Partial<Record<ShotTypeSlug, string>>);

interface CheckpointCues {
  /** Positive reinforcement — used for 'none' and for strong stops. */
  keep: string;
  /** Corrections keyed by the directions this checkpoint's metrics produce. */
  faults: Partial<Record<FaultDirection, ShotCue>>;
}

const CUES: Record<CheckpointKey, CheckpointCues> = {
  ready_position: {
    keep: 'Ready position held its range — paddle up before the ball arrived. Keep starting from there.',
    faults: {
      low: {
        default:
          'Start with the paddle up — wrist around chest height, out in front — so the first move is toward the ball, not up to it.',
        serve:
          'Hold the paddle out in front before the drop so the swing starts from the same spot on every serve.',
      },
      high: {
        default:
          'Relax the paddle down to chest height in ready — starting too high makes the drop into the swing late.',
        serve:
          'Relax the paddle to hip height before the drop — a high start makes the upward swing rush.',
      },
    },
  },
  athletic_base: {
    keep: 'Athletic base held its range — knees soft, feet set. Keep that platform under every shot.',
    faults: {
      narrow:
        'Widen your base — feet outside your shoulders, weight on the balls of your feet, so you can load and push into the ball.',
      wide: 'Bring your feet in to just outside your shoulders — a base that wide locks the hips and slows your first step.',
      low: 'Sink lower — soften the knees and get your chest over your toes so the legs can drive the shot.',
      high: 'Come up a touch — less knee bend, so you can push off and move instead of sitting in the stance.',
    },
  },
  preparation: {
    keep: 'Preparation held its range — the shoulders turned on time. Keep that unit turn.',
    faults: {
      short: {
        default:
          'Turn the shoulders earlier and further — point the non-paddle shoulder at the ball as it approaches.',
        serve:
          'Turn the shoulders more before the drop — a fuller coil gives the serve pace without arm effort.',
        overhead:
          'Turn sideways sooner — shoulders coiled and the free hand pointing at the ball as it comes down.',
      },
      long: {
        default:
          'Too much shoulder turn — keep the unit turn compact so the paddle gets back to the ball in time.',
        dink: 'Keep the shoulders quiet on the dink — stay square to the net and let the legs and arm lift the ball.',
        volley:
          'No big turn at the net — stay square and punch the volley from the shoulder.',
        third_shot_drop:
          'Ease the shoulder turn on the drop — a compact turn keeps the lift soft and on time.',
      },
    },
  },
  paddle_set: {
    keep: 'Paddle set held its range at the end of the backswing. Keep setting it there.',
    faults: {
      low: {
        default:
          'Set the paddle a little higher at the end of the backswing — about waist height — so it can drop and swing low-to-high.',
        serve:
          'Set the paddle no lower than hip height — a drop that starts too low rushes the upward swing.',
        third_shot_drop:
          'Set the paddle around hip height — a set that low makes the lift long and hard to feel.',
        overhead:
          'Get the paddle set high behind your head — elbow up, tip to the sky — before the ball drops.',
      },
      high: {
        default:
          'Set the paddle lower — around waist height — so the swing travels low-to-high instead of chopping down.',
        serve:
          'Set the paddle lower before the swing — a serve set above the hips tends to come down on the ball.',
        overhead:
          'Keep the set compact — elbow bent, paddle behind your head, not stretched straight up before the ball arrives.',
      },
      late: "Set the paddle out in front of your body — don't let it drift back beside your hip before the swing.",
      early:
        'Bring the paddle set closer to your body — a set that far in front leaves no room to push through the ball.',
    },
  },
  swing_length: {
    keep: 'Swing length held its range for this shot. Keep that length.',
    faults: {
      short: {
        default:
          'Lengthen the backswing a touch — let the paddle travel back so it can build speed smoothly into contact.',
        third_shot_drop:
          'Give the drop a little more backswing so the lift comes from the swing, not a push.',
      },
      long: {
        default:
          'Shorten the backswing — take the paddle back only to your hip line so you can still meet the ball out front.',
        dink: 'Keep the dink compact — almost no backswing; the paddle starts out front and lifts from the shoulder.',
        volley:
          'No backswing on the volley — the paddle stays in front and punches through the ball.',
        serve:
          'Trim the backswing — a compact take-back makes the serve repeatable under pressure.',
        overhead:
          'Shorten the swing — set the paddle behind your head and go straight up to the ball, no extra loop.',
      },
    },
  },
  sequencing: {
    keep: 'Sequencing held its range — hips led, shoulders and paddle followed. Keep that order.',
    faults: {
      short:
        'Start the swing from the ground up — load the back foot, turn the hips first, then let the shoulders and paddle follow.',
      long: {
        default:
          "Keep the chain connected — hips lead, but the shoulders and paddle follow right behind; don't let the body run ahead.",
        dink: "Stay balanced on the dink — a small step in is fine, but don't lunge; let the legs and arm lift the ball.",
        volley:
          'Stay set on the volley — a small lean is plenty; too much drift forward gets you jammed.',
        third_shot_drop:
          'Ease the weight shift on the drop — stay balanced and let the swing, not a lunge, carry the ball.',
      },
    },
  },
  paddle_path: {
    keep: 'Paddle path held its range for this shot. Keep swinging through on that line.',
    faults: {
      low: {
        default:
          'Swing more low-to-high — drop the paddle below the ball and brush up through contact for lift and spin.',
        serve:
          'Drop the paddle below the ball and swing up through it — the serve has to be moving upward at contact.',
        dink: 'Lift the dink from below the ball — a gentle low-to-high push gets it up and over the net.',
        volley:
          "Don't chop down on the volley — keep the paddle path level and punch straight through the ball.",
        overhead:
          'Swing up to the ball — extend fully so contact comes at the top, then hit down through it.',
      },
      high: {
        default:
          'Path too steep — flatten the swing a little so you drive through the ball, not just up it.',
        volley:
          'Too much lift on the volley — keep the paddle level and punch straight through toward your target.',
        dink: 'Too much lift — soften the low-to-high so the dink stays low over the net.',
        serve:
          'Path too steep for a serve — swing up through the ball but also out toward your target.',
        third_shot_drop:
          'Too steep on the drop — soften the lift so the ball arcs to the kitchen instead of popping up.',
      },
    },
  },
  contact_position: {
    keep: 'Contact point held its range — out front at a good height. Keep meeting it there.',
    faults: {
      late: {
        default:
          'Meet the ball further out in front — start the swing earlier so contact happens ahead of your front hip.',
        dink: 'Contact the dink out in front — reach toward the net and take it before it gets to your body.',
        volley:
          'Take the volley earlier — contact out front where you can see both the ball and the paddle.',
        serve:
          'Let the swing catch the ball further in front — contact ahead of the front hip, not beside it.',
      },
      early: {
        default:
          'Contact was too far out front — let the ball come to you and meet it just ahead of your front hip.',
        overhead:
          'Let the ball come a little more overhead — reaching too far forward pulls contact down.',
      },
      low: {
        default:
          'Contact sat low — take the ball nearer the top of the bounce, around waist height.',
        serve:
          'Contact was very low — let the ball rise a touch (still below the waist) so the paddle swings up through it.',
        overhead:
          'Reach up — contact the overhead above your head with the arm fully extended.',
        volley:
          'Contact sat low — step in and take the volley higher, closer to the net.',
        dink: 'Contact sat low — take the dink a touch earlier, before it drops below your knees.',
      },
      high: {
        default:
          'Contact was high — let the ball drop to waist height, or bend the knees to meet it at a comfortable level.',
        serve:
          'Contact was high — the serve must be struck below the waist; let the ball drop before you swing.',
        dink: 'Contact was high on the dink — let the ball drop and lift it from below the net line.',
        volley:
          'Contact was high — bend the knees and keep the paddle at chest height instead of reaching up.',
      },
    },
  },
  face_wrist_stability: {
    keep: 'Wrist stayed firm through contact — a steady paddle face. Keep that quiet hand.',
    faults: {
      unstable: {
        default:
          'Firm up the wrist through contact — lock it and let the shoulder and body drive the paddle so the face stays quiet.',
        dink: 'Quiet the wrist on the dink — lift from the shoulder with a firm wrist so the paddle face stays steady.',
        volley:
          'Keep a firm wrist on the volley — punch from the shoulder, no flick.',
      },
    },
  },
  follow_through: {
    keep: 'Follow-through held its range. Keep finishing the swing like that.',
    faults: {
      short: {
        default:
          'Finish the swing — let the paddle continue up and across toward your opposite shoulder.',
        dink: 'Let the paddle finish toward your target — a short, smooth follow-through, not a stop at the ball.',
        volley:
          "Follow through briefly toward your target — punch and stop, but don't stab at the ball.",
        third_shot_drop:
          'Finish the drop toward your target — a smooth follow-through carries the ball to the kitchen.',
        serve:
          'Finish the serve — let the paddle continue up and across your body after contact.',
      },
      long: {
        default:
          'Shorten the finish — a follow-through that long slows your recovery for the next ball.',
        dink: 'Keep the finish short on the dink — a long swing lifts the ball too high.',
        volley: 'Keep the volley finish short — punch and recover.',
      },
    },
  },
  recovery: {
    keep: 'Recovery held its range — back to ready in time. Keep that habit.',
    faults: {
      long: {
        default:
          'Get back to ready faster — as the follow-through ends, bring the paddle back up in front and reset your feet.',
        dink: 'Reset faster at the kitchen — paddle back up in front the moment the finish ends.',
        volley:
          'Reset faster at the kitchen — paddle back up in front the moment the finish ends.',
      },
    },
  },
};

function resolveCue(cue: ShotCue, shotType: ShotTypeSlug): string {
  if (typeof cue === 'string') return cue;
  return cue[shotType] ?? cue.default;
}

/**
 * ALWAYS a non-empty imperative coaching line (≤ ~150 chars) matching the
 * MEASURED direction of the checkpoint's metric. 'none' — or a direction the
 * checkpoint's metrics never produce — returns the positive "keep it" cue:
 * no correction is invented for a fault that was not measured.
 */
export function coachingCue(
  key: CheckpointKey,
  direction: FaultDirection,
  shotType: ShotTypeSlug,
): string {
  const entry: CheckpointCues | undefined = CUES[key];
  if (!entry) {
    // Stored records are unvalidated JSON: an unknown checkpoint gets a
    // neutral line rather than a fabricated correction.
    return `Keep working on your ${checkpointName(key).toLowerCase()} — repeat the swing and read it again.`;
  }
  const fault: ShotCue | undefined =
    direction === 'none' ? undefined : entry.faults[direction];
  return fault ? resolveCue(fault, shotType) : entry.keep;
}

// ─── Arrows — where the joint should go ─────────────────────────────────────

function arrow(
  joint: ReviewJoint,
  direction: ReviewArrow['direction'],
  label: string,
): ReviewArrow {
  return { joint, direction, label };
}

/**
 * One body-relative arrow for a measured fault, anchored on the dominant-side
 * joint the metric was read from. 'none' (and any direction the checkpoint
 * never produces) draws nothing.
 */
export function reviewArrow(
  key: CheckpointKey,
  direction: FaultDirection,
  side: DominantSide,
): ReviewArrow | null {
  if (direction === 'none') return null;
  const wrist = jointFor(side, 'wrist');
  const shoulder = jointFor(side, 'shoulder');
  const hip = jointFor(side, 'hip');
  const knee = jointFor(side, 'knee');
  const ankle = jointFor(side, 'ankle');
  switch (key) {
    case 'ready_position':
      if (direction === 'low') return arrow(wrist, 'up', 'Paddle up');
      if (direction === 'high') return arrow(wrist, 'down', 'Relax the paddle');
      return null;
    case 'athletic_base':
      if (direction === 'narrow')
        return arrow(ankle, 'wider', 'Widen your base');
      if (direction === 'wide')
        return arrow(ankle, 'narrower', 'Feet in a touch');
      if (direction === 'low') return arrow(knee, 'down', 'Bend more');
      if (direction === 'high')
        return arrow(knee, 'up', 'Stand a touch taller');
      return null;
    case 'preparation':
      if (direction === 'short') return arrow(shoulder, 'back', 'Turn more');
      if (direction === 'long') return arrow(shoulder, 'forward', 'Less turn');
      return null;
    case 'paddle_set':
      if (direction === 'low') return arrow(wrist, 'up', 'Set it higher');
      if (direction === 'high') return arrow(wrist, 'down', 'Set it lower');
      if (direction === 'late')
        return arrow(wrist, 'forward', 'Set it out front');
      if (direction === 'early')
        return arrow(wrist, 'back', 'Bring the set in');
      return null;
    case 'swing_length':
      if (direction === 'long')
        return arrow(wrist, 'forward', 'Shorter backswing');
      if (direction === 'short')
        return arrow(wrist, 'back', 'Longer backswing');
      return null;
    case 'sequencing':
      if (direction === 'short') return arrow(hip, 'forward', 'Hips lead');
      if (direction === 'long') return arrow(hip, 'back', 'Stay connected');
      return null;
    case 'paddle_path':
      if (direction === 'low') return arrow(wrist, 'up', 'Finish higher');
      if (direction === 'high') return arrow(wrist, 'down', 'Level it out');
      return null;
    case 'contact_position':
      if (direction === 'late')
        return arrow(wrist, 'forward', 'Meet it out front');
      if (direction === 'early')
        return arrow(wrist, 'back', 'Let it come to you');
      if (direction === 'low') return arrow(wrist, 'up', 'Take it higher');
      if (direction === 'high') return arrow(wrist, 'down', 'Let it drop');
      return null;
    case 'face_wrist_stability':
      if (direction === 'unstable')
        return arrow(wrist, 'steadier', 'Firm wrist');
      return null;
    case 'follow_through':
      if (direction === 'short')
        return arrow(wrist, 'forward', 'Finish the swing');
      if (direction === 'long') return arrow(wrist, 'back', 'Shorter finish');
      return null;
    case 'recovery':
      if (direction === 'long') return arrow(wrist, 'up', 'Back to ready');
      return null;
    default:
      return null;
  }
}

// ─── Headlines — measured facts, never adjectives ───────────────────────────

const DIRECTION_PHRASES: Record<FaultDirection, string> = {
  late: 'contact came late',
  early: 'contact came early',
  low: 'sat low',
  high: 'sat high',
  short: 'was short',
  long: 'ran long',
  wide: 'was wide',
  narrow: 'was narrow',
  open: 'was open',
  closed: 'was closed',
  unstable: 'wobbled',
  none: 'held its target',
};

/** The measured-direction phrase alone ("contact came late"). An unknown
 * direction (unvalidated JSON) reads as off target. */
export function directionPhrase(direction: FaultDirection): string {
  const phrase: string | undefined = DIRECTION_PHRASES[direction];
  return phrase ?? 'was off target';
}

/** "<Name> scored <round(score)> — <direction phrase>", from the record's
 * own numbers. */
export function stopHeadline(cp: ReviewStopCheckpoint): string {
  return `${cp.name} scored ${Math.round(cp.score)} — ${directionPhrase(
    cp.direction,
  )}`;
}

// ─── Script assembly ────────────────────────────────────────────────────────

interface ReviewSpan {
  key: PhaseKey;
  startMs: number;
  representativeMs: number;
  endMs: number;
}

const BAND_RANK: Record<ScoreBand, number> = {
  unscored: 0,
  green: 1,
  yellow: 2,
  red: 3,
};

/** Only red/yellow bands are measured faults; green holds, 'unscored' claims
 * nothing (a finite score with that band is inconsistent data, not a fault). */
function isFault(cp: ReviewStopCheckpoint): boolean {
  return cp.band === 'red' || cp.band === 'yellow';
}

function verdictFor(checkpoints: readonly ReviewStopCheckpoint[]): StopVerdict {
  let worst = 0;
  for (const cp of checkpoints) {
    const rank: number | undefined = BAND_RANK[cp.band];
    worst = Math.max(worst, rank ?? 0);
  }
  return worst >= 3 ? 'fix' : worst === 2 ? 'watch' : 'strong';
}

/**
 * Checkpoints that participate: known key, not marked inapplicable, finite
 * numeric score. Duplicates keep their first occurrence; the result is in
 * CHECKPOINTS order so every later tie-break is deterministic.
 */
function participatingCheckpoints(
  analysis: ShotAnalysis,
): ReviewStopCheckpoint[] {
  const raw = Array.isArray(analysis.checkpoints) ? analysis.checkpoints : [];
  const seen = new Set<CheckpointKey>();
  const out: ReviewStopCheckpoint[] = [];
  for (const cp of raw) {
    if (!cp || !isCheckpointKey(cp.key) || seen.has(cp.key)) continue;
    if (cp.applicable === false || !finite(cp.score)) continue;
    seen.add(cp.key);
    out.push({
      key: cp.key,
      name: checkpointName(cp.key),
      score: cp.score,
      band: cp.band,
      direction: cp.direction,
      severity: finite(cp.severity)
        ? clamp01(cp.severity)
        : clamp01(1 - cp.score / 100),
    });
  }
  return out.sort(
    (a, b) => CHECKPOINTS.indexOf(a.key) - CHECKPOINTS.indexOf(b.key),
  );
}

/** Phase spans with a known key and finite bounds; unknown keys and
 * duplicates are ignored, a non-finite representative falls to the midpoint. */
function knownPhases(analysis: ShotAnalysis): ReviewSpan[] {
  const raw = Array.isArray(analysis.phases) ? analysis.phases : [];
  const seen = new Set<PhaseKey>();
  const out: ReviewSpan[] = [];
  for (const phase of raw) {
    if (!phase || !isPhaseKey(phase.key) || seen.has(phase.key)) continue;
    if (!finite(phase.startMs) || !finite(phase.endMs)) continue;
    const startMs = phase.startMs;
    const endMs = Math.max(startMs, phase.endMs);
    seen.add(phase.key);
    out.push({
      key: phase.key,
      startMs,
      endMs,
      representativeMs: finite(phase.representativeMs)
        ? phase.representativeMs
        : startMs + (endMs - startMs) / 2,
    });
  }
  return out;
}

/** With no measured phases the whole stroke window is the one stop, placed at
 * the recorded contact time (or the window midpoint when none was recorded). */
function fallbackSpan(analysis: ShotAnalysis): ReviewSpan {
  const timestamps = analysis.timestamps;
  const startMs = finite(timestamps?.startMs) ? timestamps.startMs : 0;
  const endMs = Math.max(
    startMs,
    finite(timestamps?.endMs) ? timestamps.endMs : startMs,
  );
  const contactMs = timestamps?.contactMs;
  return {
    key: 'contact',
    startMs,
    endMs,
    representativeMs: finite(contactMs)
      ? contactMs
      : startMs + (endMs - startMs) / 2,
  };
}

const CONTACT_ONLY_HEADLINE =
  'Contact — the fastest wrist moment in this swing.';
const CONTACT_ONLY_CUE =
  'Watch where the paddle meets the ball relative to your front hip.';

function unionJoints(groups: readonly ReviewJoint[][]): ReviewJoint[] {
  const out: ReviewJoint[] = [];
  for (const group of groups) {
    for (const joint of group) if (!out.includes(joint)) out.push(joint);
  }
  return out;
}

function makeStop(
  span: ReviewSpan,
  checkpoints: readonly ReviewStopCheckpoint[],
  shotType: ShotTypeSlug,
  side: DominantSide,
): ReviewStop {
  // Stable sort on a CHECKPOINTS-ordered input: ties keep canonical order.
  const sorted = [...checkpoints].sort((a, b) => a.score - b.score);
  const worst = sorted[0];
  const verdict = verdictFor(sorted);
  const base = {
    id: `stop-${span.key}`,
    phase: span.key,
    atMs: span.representativeMs,
    startMs: span.startMs,
    endMs: span.endMs,
    title: PHASE_TITLES[span.key],
    verdict,
    checkpoints: sorted,
  };
  if (!worst) {
    // The contact stop exists even when nothing was scored there: it marks
    // the measured wrist-speed peak, and the copy asks the player to look,
    // claiming nothing about what they will see.
    return {
      ...base,
      headline: CONTACT_ONLY_HEADLINE,
      cue: CONTACT_ONLY_CUE,
      focusJoints: [jointFor(side, 'wrist'), 'left_hip', 'right_hip'],
      arrow: null,
    };
  }
  const faults = sorted.filter(isFault);
  const focus = faults.length > 0 ? faults : [worst];
  const strong = verdict === 'strong';
  return {
    ...base,
    headline: stopHeadline(worst),
    cue: coachingCue(worst.key, strong ? 'none' : worst.direction, shotType),
    focusJoints: unionJoints(focus.map(cp => checkpointJoints(cp.key, side))),
    arrow: strong ? null : reviewArrow(worst.key, worst.direction, side),
  };
}

/**
 * The full replay script for one analysis. Stops follow the measured phase
 * spans (one per phase that owns a participating checkpoint; contact always,
 * as the wrist-speed peak), ordered by their representative time. With no
 * phases at all, one contact stop carries every participating checkpoint.
 */
export function buildFormReviewScript(
  analysis: ShotAnalysis,
  sequence: ReviewPoseSequence | null,
): FormReviewScript {
  const shotType = analysis.shotType;
  const participating = participatingCheckpoints(analysis);
  const dominant = dominantSide(
    sequence,
    {
      startMs: finite(analysis.timestamps?.startMs)
        ? analysis.timestamps.startMs
        : Number.NEGATIVE_INFINITY,
      endMs: finite(analysis.timestamps?.endMs)
        ? analysis.timestamps.endMs
        : Number.POSITIVE_INFINITY,
    },
    analysis.handedness,
  );
  const facing = facingSign(sequence, analysis, dominant);

  const phases = knownPhases(analysis);
  const stops: ReviewStop[] = [];
  if (phases.length === 0) {
    stops.push(
      makeStop(fallbackSpan(analysis), participating, shotType, dominant),
    );
  } else {
    for (const phase of phases) {
      const own = participating.filter(
        cp => CHECKPOINT_PHASE[cp.key] === phase.key,
      );
      if (own.length === 0 && phase.key !== 'contact') continue;
      stops.push(makeStop(phase, own, shotType, dominant));
    }
    stops.sort(
      (a, b) =>
        a.atMs - b.atMs || PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase),
    );
  }

  const jointHeat: JointHeat = {};
  for (const cp of participating) {
    if (!isFault(cp)) continue;
    const heat = clamp01(1 - cp.score / 100);
    for (const joint of checkpointJoints(cp.key, dominant)) {
      jointHeat[joint] = Math.max(jointHeat[joint] ?? 0, heat);
    }
  }

  let strongest: ReviewStopCheckpoint | null = null;
  let weakest: ReviewStopCheckpoint | null = null;
  for (const cp of participating) {
    if (strongest === null || cp.score > strongest.score) strongest = cp;
    if (weakest === null || cp.score < weakest.score) weakest = cp;
  }

  return {
    shotType,
    dominant,
    facing,
    stops,
    jointHeat,
    strongest,
    weakest,
  };
}

// ─── Time-weighted heat for the overlay ─────────────────────────────────────

/** Narrowest bell (ms) a stop's heat spreads over, so brief contact spans
 * still read as a visible pulse rather than a single frame. */
const MIN_HEAT_SIGMA_MS = 180;
/** Static-heat floor keeps fault regions faintly warm throughout the replay. */
const HEAT_FLOOR_FACTOR = 0.35;

function worstCheckpointForJoint(
  stop: ReviewStop,
  joint: ReviewJoint,
  side: DominantSide,
): ReviewStopCheckpoint | null {
  // stop.checkpoints is worst-first, so the first owner of the joint wins.
  for (const cp of stop.checkpoints) {
    if (checkpointJoints(cp.key, side).includes(joint)) return cp;
  }
  return stop.checkpoints[0] ?? null;
}

/**
 * Heat per joint at replay time tMs: each non-strong stop contributes a
 * Gaussian pulse w = exp(-0.5·((tMs − atMs)/σ)²), σ = max(180ms, half the
 * span), scaled by (1 − score/100) of the stop's worst checkpoint owning the
 * joint; joints take the max over stops, floored at 0.35 × the static heat
 * so fault regions never go fully cold. Clamped to 0..1.
 */
export function jointHeatAt(script: FormReviewScript, tMs: number): JointHeat {
  const heat: JointHeat = {};
  if (Number.isFinite(tMs)) {
    for (const stop of script.stops) {
      if (stop.verdict === 'strong') continue;
      const sigma = Math.max(
        MIN_HEAT_SIGMA_MS,
        (stop.endMs - stop.startMs) / 2,
      );
      const weight = Math.exp(-0.5 * ((tMs - stop.atMs) / sigma) ** 2);
      if (!(weight > 0)) continue;
      for (const joint of stop.focusJoints) {
        const worst = worstCheckpointForJoint(stop, joint, script.dominant);
        if (!worst) continue;
        const value = clamp01(weight * (1 - worst.score / 100));
        heat[joint] = Math.max(heat[joint] ?? 0, value);
      }
    }
  }
  for (const joint of REVIEW_JOINTS) {
    const base = script.jointHeat[joint];
    if (!finite(base)) continue;
    heat[joint] = clamp01(
      Math.max(heat[joint] ?? 0, HEAT_FLOOR_FACTOR * clamp01(base)),
    );
  }
  return heat;
}

// ─── Fix / strength lists ───────────────────────────────────────────────────

export interface FixItem {
  key: CheckpointKey;
  name: string;
  score: number;
  band: ScoreBand;
  direction: FaultDirection;
  headline: string;
  cue: string;
  phase: PhaseKey;
  isPriority: boolean;
}

/**
 * Applicable, scored checkpoints below green — worst score first, with the
 * engine's priorityFix checkpoint promoted to the top when it is among them.
 * Empty when nothing is below green: no fix is invented for a clean stroke.
 */
export function fixList(analysis: ShotAnalysis, limit = 3): FixItem[] {
  const priority = analysis.priorityFix?.checkpoint ?? null;
  const faults = participatingCheckpoints(analysis)
    .filter(isFault)
    .sort((a, b) => {
      if (a.key === priority) return -1;
      if (b.key === priority) return 1;
      return a.score - b.score;
    });
  return faults.slice(0, Math.max(0, limit)).map(cp => ({
    key: cp.key,
    name: cp.name,
    score: cp.score,
    band: cp.band,
    direction: cp.direction,
    headline: stopHeadline(cp),
    cue: coachingCue(cp.key, cp.direction, analysis.shotType),
    phase: CHECKPOINT_PHASE[cp.key],
    isPriority: cp.key === priority,
  }));
}

/** Best green checkpoints, highest score first (ties in CHECKPOINTS order). */
export function strengthList(
  analysis: ShotAnalysis,
  limit = 2,
): ReviewStopCheckpoint[] {
  return participatingCheckpoints(analysis)
    .filter(cp => cp.band === 'green')
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}
