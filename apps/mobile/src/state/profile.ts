import {
  CHECKPOINTS,
  type CheckpointKey,
  type Handedness,
} from '@pickle/shared-types';

export type Gender = 'female' | 'male' | 'nonbinary' | 'prefer_not_to_say';

const HANDEDNESS: readonly Handedness[] = ['right', 'left', 'ambidextrous'];
const GENDERS: readonly Gender[] = [
  'female',
  'male',
  'nonbinary',
  'prefer_not_to_say',
];

function isHandedness(value: unknown): value is Handedness {
  return (
    typeof value === 'string' &&
    (HANDEDNESS as readonly string[]).includes(value)
  );
}

function isCheckpointKey(value: unknown): value is CheckpointKey {
  return (
    typeof value === 'string' &&
    (CHECKPOINTS as readonly string[]).includes(value)
  );
}

function isGender(value: unknown): value is Gender {
  return (
    typeof value === 'string' && (GENDERS as readonly string[]).includes(value)
  );
}

export interface Profile {
  /** Optional: older stored profiles predate name/gender collection. */
  firstName?: string;
  gender?: Gender;
  skillLevel: string;
  handedness: Handedness;
  goal: string;
  biggestProblem: string;
  focusCheckpoint: CheckpointKey;
}

const GOAL_FOCUS: Record<string, CheckpointKey> = {
  dinks: 'contact_position',
  drives: 'preparation',
  drops: 'paddle_set',
  serve: 'sequencing',
  return: 'athletic_base',
  volleys: 'face_wrist_stability',
  footwork: 'athletic_base',
  'all-around': 'contact_position',
};

export function focusForGoal(goal: string): CheckpointKey {
  return GOAL_FOCUS[goal] ?? 'contact_position';
}

/**
 * Validates an untrusted value (a persisted kv row, the pre-auth stash, a
 * server body) into a Profile, or returns null when it is not one. Required
 * fields must be non-empty strings and handedness must be in vocabulary; an
 * unknown focusCheckpoint is repaired from the goal and unknown optional
 * fields are dropped, so a returned Profile is always safe to render and to
 * write back.
 */
export function parseProfile(value: unknown): Profile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const { skillLevel, handedness, goal, biggestProblem, focusCheckpoint } =
    candidate;
  if (
    typeof skillLevel !== 'string' ||
    !skillLevel ||
    !isHandedness(handedness) ||
    typeof goal !== 'string' ||
    !goal ||
    typeof biggestProblem !== 'string' ||
    !biggestProblem
  ) {
    return null;
  }
  const firstName = candidate['firstName'];
  const gender = candidate['gender'];
  return {
    ...(typeof firstName === 'string' && firstName ? { firstName } : {}),
    ...(isGender(gender) ? { gender } : {}),
    skillLevel,
    handedness,
    goal,
    biggestProblem,
    focusCheckpoint: isCheckpointKey(focusCheckpoint)
      ? focusCheckpoint
      : focusForGoal(goal),
  };
}
