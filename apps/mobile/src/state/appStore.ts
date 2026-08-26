import { create } from 'zustand';
import type {
  CheckpointKey,
  Handedness,
  ShotTypeSlug,
} from '@pickle/shared-types';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';

/** Session/UI state (Zustand); durable copies live in SQLite kv. */

export interface Profile {
  skillLevel: string;
  handedness: Handedness;
  goal: string;
  biggestProblem: string;
  focusCheckpoint: CheckpointKey;
}

interface AppState {
  hydrated: boolean;
  profile: Profile | null;
  lastShotType: ShotTypeSlug;
  hydrate: () => Promise<void>;
  completeOnboarding: (profile: Profile) => Promise<void>;
  setLastShotType: (shotType: ShotTypeSlug) => void;
}

const GOAL_FOCUS: Record<string, CheckpointKey> = {
  dinks: 'contact_position',
  drives: 'preparation',
  drops: 'paddle_set',
  serve: 'sequencing',
  volleys: 'face_wrist_stability',
  footwork: 'athletic_base',
  'all-around': 'contact_position',
};

export function focusForGoal(goal: string): CheckpointKey {
  return GOAL_FOCUS[goal] ?? 'contact_position';
}

export const useAppStore = create<AppState>(set => ({
  hydrated: false,
  profile: null,
  lastShotType: 'forehand_drive',
  hydrate: async () => {
    try {
      const raw = await getKv(getDb(), 'profile');
      set({
        profile: raw ? (JSON.parse(raw) as Profile) : null,
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },
  completeOnboarding: async profile => {
    await setKv(getDb(), 'profile', JSON.stringify(profile));
    set({ profile });
  },
  setLastShotType: shotType => set({ lastShotType: shotType }),
}));
