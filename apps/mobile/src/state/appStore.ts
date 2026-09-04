import { create } from 'zustand';
import type { ShotTypeSlug } from '@pickle/shared-types';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
  requireWritableDataOwner,
} from '../data/accountScope';
import {
  getApiSession,
  subscribeToApiSession,
  type ApiSession,
} from '../account/apiSession';
import {
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../account/onboarding';
import type { Profile } from './profile';
export { focusForGoal, type Gender, type Profile } from './profile';

/** Session/UI state (Zustand); durable copies live in SQLite kv. */

/**
 * Pre-auth onboarding (device-level, NOT owner-scoped): the questionnaire
 * runs BEFORE sign-in, so its answers are stashed under a device key until a
 * writable owner exists to adopt them. The stash is single-use and the
 * NEWEST intent wins: hydrate() makes it the profile of the next owner that
 * signs in, replacing any profile that owner already had — someone who chose
 * "Start your first read" and answered every question meant those answers to
 * apply. (Returning players who don't want that take "I already have an
 * account", which never writes a stash.) If the server save fails the stash
 * is kept for the next hydrate and the owner keeps their existing profile
 * meanwhile.
 */
export const PENDING_ONBOARDING_PROFILE_KV_KEY = 'onboarding.pending-profile';

export const CANONICAL_PROFILE_UNAVAILABLE_MESSAGE =
  'Pickle Sensei could not reach your account to load your coaching profile. Check your connection and try again.';

function isCanonicalOwner(owner: string): boolean {
  return owner !== GUEST_DATA_OWNER && owner !== SIGNED_OUT_DATA_OWNER;
}

function apiSessionFor(owner: string): ApiSession | null {
  const apiSession = getApiSession();
  return apiSession &&
    canonicalDataOwner(apiSession.canonicalAppUserId) === owner
    ? apiSession
    : null;
}

/**
 * A signed-in account with no local profile and no bearer yet (restored from
 * the Keychain while its refresh is still out, or offline) has an UNKNOWN
 * profile, not a missing one — the server may well hold it. hydrate() then
 * reports the profile as unavailable (a retryable state, never the
 * questionnaire) and arms this one-shot watch: the moment a bearer for that
 * owner is established, hydration runs again and fetches canonical truth.
 * Any later hydrate() disarms it first, so a single watch exists at a time.
 */
let disarmCanonicalTruthWatch: (() => void) | null = null;

function armCanonicalTruthWatch(owner: string, rehydrate: () => void): void {
  disarmCanonicalTruthWatch?.();
  const unsubscribe = subscribeToApiSession(session => {
    if (!session || canonicalDataOwner(session.canonicalAppUserId) !== owner) {
      return;
    }
    disarm();
    if (getActiveDataOwner() === owner) rehydrate();
  });
  const disarm = () => {
    unsubscribe();
    if (disarmCanonicalTruthWatch === disarm) disarmCanonicalTruthWatch = null;
  };
  disarmCanonicalTruthWatch = disarm;
}

function parsePendingProfile(raw: string | null): Profile | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const profile = (parsed as Record<string, unknown>)['profile'];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return null;
    }
    const candidate = profile as Record<string, unknown>;
    const requiredStrings = [
      'skillLevel',
      'handedness',
      'goal',
      'biggestProblem',
      'focusCheckpoint',
    ] as const;
    for (const key of requiredStrings) {
      if (typeof candidate[key] !== 'string') return null;
    }
    return profile as Profile;
  } catch {
    return null;
  }
}

interface AppState {
  hydrated: boolean;
  ownerKey: string | null;
  profile: Profile | null;
  /** Set when hydrate() finished without a profile because the owner's data
   * could not be read (canonical fetch or local read failed) — the Gate shows
   * a retry state instead of re-asking the questionnaire. */
  hydrateError: string | null;
  onboardingBusy: boolean;
  onboardingError: string | null;
  lastShotType: ShotTypeSlug;
  hydrate: () => Promise<void>;
  /**
   * Accepts the full onboarding profile, including the optional firstName /
   * gender personalization fields; the whole object is persisted to the
   * owner-scoped kv JSON. Signed-in users sync through
   * saveCanonicalOnboardingProfile (server focusCheckpoint wins); guests
   * (localOnly) persist locally only. Older stored profiles without the new
   * fields keep parsing because those fields are optional on Profile.
   */
  completeOnboarding: (profile: Profile) => Promise<void>;
  /**
   * Pre-auth variant: no owner exists yet, so the answers are stashed under
   * the device-level pending key and adopted by hydrate() after sign-in
   * (server-synced for canonical accounts, local-only for guests). Returns
   * whether the stash was durably written — the caller only advances to
   * sign-in on success.
   */
  completePreAuthOnboarding: (profile: Profile) => Promise<boolean>;
  setLastShotType: (shotType: ShotTypeSlug) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  onboardingBusy: false,
  onboardingError: null,
  lastShotType: 'forehand_drive',
  hydrate: async () => {
    disarmCanonicalTruthWatch?.();
    const owner = getActiveDataOwner();
    set({
      hydrated: false,
      ownerKey: owner,
      profile: null,
      hydrateError: null,
    });
    try {
      const db = getDb();
      let pending = parsePendingProfile(
        await getKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY),
      );
      let raw = await getKv(db, profileKeyForOwner(owner));
      if (!raw && owner === GUEST_DATA_OWNER) {
        const legacy = await getKv(db, 'profile');
        if (legacy) {
          await setKv(db, profileKeyForOwner(owner), legacy);
          await setKv(db, 'profile', '');
          raw = legacy;
        }
      }
      const apiSession = apiSessionFor(owner);
      if (!raw && !pending && isCanonicalOwner(owner) && !apiSession) {
        if (getActiveDataOwner() === owner) {
          set({
            hydrated: true,
            ownerKey: owner,
            profile: null,
            hydrateError: CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
          });
          armCanonicalTruthWatch(owner, () => void get().hydrate());
        }
        return;
      }
      if (!raw && apiSession) {
        let canonicalProfile: Profile | null;
        try {
          canonicalProfile = await fetchCanonicalOnboardingProfile(apiSession);
        } catch {
          if (getActiveDataOwner() === owner) {
            set({
              hydrated: true,
              ownerKey: owner,
              profile: null,
              hydrateError: CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
            });
          }
          return;
        }
        if (canonicalProfile) {
          raw = JSON.stringify(canonicalProfile);
          await setKv(db, profileKeyForOwner(owner), raw);
        }
      }
      // Adopt the pre-auth questionnaire into the first writable owner that
      // hydrates, REPLACING whatever profile it had (the answers just given
      // on this device are the newest intent); synced accounts save through
      // the canonical endpoint first (server focusCheckpoint wins) exactly
      // like completeOnboarding. A failed save keeps both the stash (retried
      // next hydrate) and the existing profile.
      if (
        pending &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        getActiveDataOwner() === owner
      ) {
        try {
          const adopted = apiSession
            ? await saveCanonicalOnboardingProfile(apiSession, pending)
            : pending;
          raw = JSON.stringify(adopted);
          await setKv(db, profileKeyForOwner(owner), raw);
          await setKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY, '');
          pending = null;
        } catch {
          // Stash and existing profile both survive for the next attempt.
        }
      }
      if (getActiveDataOwner() !== owner) return;
      set({
        profile: raw ? (JSON.parse(raw) as Profile) : null,
        hydrated: true,
        ownerKey: owner,
        hydrateError: null,
        lastShotType: 'forehand_drive',
        onboardingBusy: false,
        onboardingError: null,
      });
    } catch (error) {
      if (getActiveDataOwner() === owner) {
        set({
          hydrated: true,
          ownerKey: owner,
          profile: null,
          hydrateError:
            error instanceof Error
              ? error.message
              : 'Your coaching profile could not be loaded.',
        });
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
  completePreAuthOnboarding: async profile => {
    set({ onboardingBusy: true, onboardingError: null });
    try {
      await setKv(
        getDb(),
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile }),
      );
      set({ onboardingBusy: false, onboardingError: null });
      return true;
    } catch (error) {
      set({
        onboardingBusy: false,
        onboardingError:
          error instanceof Error
            ? error.message
            : 'Your answers could not be saved.',
      });
      return false;
    }
  },
  setLastShotType: shotType => set({ lastShotType: shotType }),
}));
