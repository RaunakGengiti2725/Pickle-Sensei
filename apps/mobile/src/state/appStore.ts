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
import { getApiSession } from '../account/apiSession';
import {
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../account/onboarding';
import type { Profile } from './profile';
export { focusForGoal, type Gender, type Profile } from './profile';

/** Session/UI state (Zustand); durable copies live in SQLite kv. */

/**
 * Pre-auth onboarding (device-level, NOT owner-scoped): the questionnaire now
 * runs BEFORE sign-in, so its answers are stashed under a device key until a
 * writable owner exists to adopt them. The stash is single-use: hydrate()
 * moves it into the first owner that has no profile of its own, and discards
 * it when the owner already has one (an existing account always wins over a
 * fresh questionnaire).
 */
export const PENDING_ONBOARDING_PROFILE_KV_KEY = 'onboarding.pending-profile';
/**
 * Durable "this device finished the questionnaire" marker. Survives sign-out
 * and account deletion on purpose: returning users go straight to sign-in
 * instead of re-answering setup questions.
 */
export const DEVICE_ONBOARDED_KV_KEY = 'onboarding.device-complete';
export const DEVICE_ONBOARDED_VALUE = JSON.stringify({ version: 1 });

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
  /** True once this device has completed the pre-auth questionnaire (or a
   * profile has ever hydrated here). Gates the launch flow: false → the
   * onboarding questionnaire runs before sign-in; true → straight to
   * sign-in. */
  preAuthOnboarded: boolean;
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

export const useAppStore = create<AppState>(set => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  preAuthOnboarded: false,
  onboardingBusy: false,
  onboardingError: null,
  lastShotType: 'forehand_drive',
  hydrate: async () => {
    const owner = getActiveDataOwner();
    set({ hydrated: false, ownerKey: owner, profile: null });
    // Read early so the launch gate keeps its answer even when the risky
    // owner-scoped work below fails.
    let preAuthOnboarded = false;
    try {
      const db = getDb();
      let pending = parsePendingProfile(
        await getKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY),
      );
      preAuthOnboarded =
        pending !== null || (await getKv(db, DEVICE_ONBOARDED_KV_KEY)) !== null;
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
        const canonicalProfile = await fetchCanonicalOnboardingProfile(
          apiSession,
        );
        if (canonicalProfile) {
          raw = JSON.stringify(canonicalProfile);
          await setKv(db, profileKeyForOwner(owner), raw);
        }
      }
      // Adopt the pre-auth questionnaire into the first writable owner that
      // hydrates without a profile of its own; synced accounts save through
      // the canonical endpoint first (server focusCheckpoint wins) exactly
      // like completeOnboarding. Owners that already have a profile — local
      // or canonical — win over the stash. Either way it is single-use.
      if (
        pending &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        getActiveDataOwner() === owner
      ) {
        if (!raw) {
          const adopted =
            apiSession &&
            canonicalDataOwner(apiSession.canonicalAppUserId) === owner
              ? await saveCanonicalOnboardingProfile(apiSession, pending)
              : pending;
          raw = JSON.stringify(adopted);
          await setKv(db, profileKeyForOwner(owner), raw);
        }
        await setKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY, '');
        pending = null;
      }
      // Migration backfill: accounts that onboarded before the pre-auth flow
      // existed already answered the questionnaire — never re-ask on this
      // device after a later sign-out.
      if (raw && !preAuthOnboarded) {
        preAuthOnboarded = true;
        await setKv(db, DEVICE_ONBOARDED_KV_KEY, DEVICE_ONBOARDED_VALUE);
      }
      if (getActiveDataOwner() !== owner) return;
      set({
        profile: raw ? (JSON.parse(raw) as Profile) : null,
        hydrated: true,
        ownerKey: owner,
        preAuthOnboarded,
        lastShotType: 'forehand_drive',
        onboardingBusy: false,
        onboardingError: null,
      });
    } catch {
      if (getActiveDataOwner() === owner) {
        set({
          hydrated: true,
          ownerKey: owner,
          profile: null,
          preAuthOnboarded,
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
      try {
        await setKv(getDb(), DEVICE_ONBOARDED_KV_KEY, DEVICE_ONBOARDED_VALUE);
      } catch {
        // Best-effort device marker; the owner-scoped profile write above is
        // the completion of record and already succeeded.
      }
      if (getActiveDataOwner() === owner) {
        set({
          profile: canonicalProfile,
          ownerKey: owner,
          preAuthOnboarded: true,
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
      const db = getDb();
      await setKv(
        db,
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile }),
      );
      await setKv(db, DEVICE_ONBOARDED_KV_KEY, DEVICE_ONBOARDED_VALUE);
      set({
        preAuthOnboarded: true,
        onboardingBusy: false,
        onboardingError: null,
      });
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
