import type { CheckpointKey, Handedness } from '@pickle/shared-types';

export interface Profile {
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
