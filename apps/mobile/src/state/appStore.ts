import { create } from 'zustand';
import type { ShotTypeSlug } from '@pickle/shared-types';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  GUEST_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
  requireWritableDataOwner,
} from '../data/accountScope';
import { getApiSession } from '../account/apiSession';
import {
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../account/onboarding';
import type { Profile } from './profile';
export { focusForGoal, type Profile } from './profile';

/** Session/UI state (Zustand); durable copies live in SQLite kv. */

interface AppState {
  hydrated: boolean;
  ownerKey: string | null;
  profile: Profile | null;
  onboardingBusy: boolean;
  onboardingError: string | null;
  lastShotType: ShotTypeSlug;
  hydrate: () => Promise<void>;
  completeOnboarding: (profile: Profile) => Promise<void>;
  setLastShotType: (shotType: ShotTypeSlug) => void;
}

export const useAppStore = create<AppState>(set => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  onboardingBusy: false,
  onboardingError: null,
  lastShotType: 'forehand_drive',
  hydrate: async () => {
    const owner = getActiveDataOwner();
    set({ hydrated: false, ownerKey: owner, profile: null });
    try {
      const db = getDb();
      let raw = await getKv(db, profileKeyForOwner(owner));
      if (!raw && owner === GUEST_DATA_OWNER) {
        const legacy = await getKv(db, 'profile');
        if (legacy) {
          await setKv(db, profileKeyForOwner(owner), legacy);
          await setKv(db, 'profile', '');
          raw = legacy;
        }
      }
      const apiSession = getApiSession();
      if (
        !raw &&
        apiSession &&
        canonicalDataOwner(apiSession.canonicalAppUserId) === owner
      ) {
        const canonicalProfile =
          await fetchCanonicalOnboardingProfile(apiSession);
        if (canonicalProfile) {
          raw = JSON.stringify(canonicalProfile);
          await setKv(db, profileKeyForOwner(owner), raw);
        }
      }
      if (getActiveDataOwner() !== owner) return;
      set({
        profile: raw ? (JSON.parse(raw) as Profile) : null,
        hydrated: true,
        ownerKey: owner,
        lastShotType: 'forehand_drive',
        onboardingBusy: false,
        onboardingError: null,
      });
    } catch {
      if (getActiveDataOwner() === owner) {
        set({ hydrated: true, ownerKey: owner, profile: null });
      }
    }
  },
  completeOnboarding: async profile => {
    const owner = requireWritableDataOwner();
    set({ onboardingBusy: true, onboardingError: null });
    try {
      const apiSession = getApiSession();
      const canonicalProfile =
        apiSession &&
        canonicalDataOwner(apiSession.canonicalAppUserId) === owner
          ? await saveCanonicalOnboardingProfile(apiSession, profile)
          : profile;
      await setKv(
        getDb(),
        profileKeyForOwner(owner),
        JSON.stringify(canonicalProfile),
      );
      if (getActiveDataOwner() === owner) {
        set({
          profile: canonicalProfile,
          ownerKey: owner,
          onboardingBusy: false,
          onboardingError: null,
        });
      }
    } catch (error) {
      if (getActiveDataOwner() === owner) {
        set({
          onboardingBusy: false,
          onboardingError:
            error instanceof Error
              ? error.message
              : 'Your coaching profile could not be saved.',
        });
      }
    }
  },
  setLastShotType: shotType => set({ lastShotType: shotType }),
}));
