import type { CheckpointKey, Handedness } from '@pickle/shared-types';

export type Gender = 'female' | 'male' | 'nonbinary' | 'prefer_not_to_say';

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
