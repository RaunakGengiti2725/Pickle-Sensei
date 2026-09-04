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

/**
 * How long hydrate() waits on the canonical profile fetch before letting the
 * launch continue (`hydrated: true`, `canonicalProfilePending: true`). Equal
 * to authStore's LAUNCH_REFRESH_WAIT_MS so a cold launch never blocks past
 * the launch budget on any single network step; the fetch keeps running and
 * its result is adopted whenever it lands.
 */
export const CANONICAL_PROFILE_LAUNCH_BUDGET_MS = 8_000;

/** Serial number of the latest hydrate(); a settle task whose number is stale
 * (a newer hydrate started, or the owner changed) must not touch state. */
let hydrateGeneration = 0;
/** Detaches the API-session wait of the latest hydrate(), if any. */
let stopWaitingForApiSession: (() => void) | null = null;

function sessionForOwner(owner: string): ApiSession | null {
  const apiSession = getApiSession();
  return apiSession &&
    canonicalDataOwner(apiSession.canonicalAppUserId) === owner
    ? apiSession
    : null;
}

function hydrateErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Your coaching profile could not be loaded.';
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
  /** True while a signed-in owner has no local profile and the canonical one
   * is still unknown — the fetch is in flight past the launch budget, or the
   * API session (launch refresh) has not landed yet. The Gate shows a loading
   * affordance, never the questionnaire, until this settles. */
  canonicalProfilePending: boolean;
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

type Db = ReturnType<typeof getDb>;

/** Adopt the pre-auth questionnaire into the first writable owner that
 * hydrates, REPLACING whatever profile it had (the answers just given on
 * this device are the newest intent); synced accounts save through the
 * canonical endpoint first (server focusCheckpoint wins) exactly like
 * completeOnboarding. A failed save keeps both the stash (retried next
 * hydrate) and the existing profile. Returns the profile JSON to hydrate. */
async function adoptPendingProfile(
  db: Db,
  owner: string,
  pending: Profile | null,
  apiSession: ApiSession | null,
  raw: string | null,
): Promise<string | null> {
  if (
    !pending ||
    owner === SIGNED_OUT_DATA_OWNER ||
    getActiveDataOwner() !== owner
  ) {
    return raw;
  }
  try {
    const adopted = apiSession
      ? await saveCanonicalOnboardingProfile(apiSession, pending)
      : pending;
    const adoptedRaw = JSON.stringify(adopted);
    await setKv(db, profileKeyForOwner(owner), adoptedRaw);
    await setKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY, '');
    return adoptedRaw;
  } catch {
    return raw;
  }
}

function settle(owner: string, raw: string | null): void {
  useAppStore.setState({
    profile: raw ? (JSON.parse(raw) as Profile) : null,
    hydrated: true,
    ownerKey: owner,
    hydrateError: null,
    canonicalProfilePending: false,
    lastShotType: 'forehand_drive',
    onboardingBusy: false,
    onboardingError: null,
  });
}

function settleWithError(owner: string, message: string): void {
  useAppStore.setState({
    hydrated: true,
    ownerKey: owner,
    profile: null,
    hydrateError: message,
    canonicalProfilePending: false,
  });
}

/** The signed-in owner has no local profile: ask the account. Runs to
 * completion on its own — hydrate() may already have let the launch
 * continue — and applies the outcome only while it is still the current
 * hydrate for the current owner. */
async function settleCanonicalProfile(
  db: Db,
  owner: string,
  generation: number,
  apiSession: ApiSession,
  pending: Profile | null,
): Promise<void> {
  const live = () =>
    hydrateGeneration === generation && getActiveDataOwner() === owner;
  let canonicalProfile: Profile | null;
  try {
    canonicalProfile = await fetchCanonicalOnboardingProfile(apiSession);
  } catch {
    if (live()) settleWithError(owner, CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
    return;
  }
  try {
    let raw: string | null = null;
    if (canonicalProfile) {
      raw = JSON.stringify(canonicalProfile);
      await setKv(db, profileKeyForOwner(owner), raw);
    }
    if (!live()) return;
    raw = await adoptPendingProfile(db, owner, pending, apiSession, raw);
    if (live()) settle(owner, raw);
  } catch (error) {
    if (live()) settleWithError(owner, hydrateErrorMessage(error));
  }
}

export const useAppStore = create<AppState>(set => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  canonicalProfilePending: false,
  onboardingBusy: false,
  onboardingError: null,
  lastShotType: 'forehand_drive',
  hydrate: async () => {
    const owner = getActiveDataOwner();
    hydrateGeneration += 1;
    const generation = hydrateGeneration;
    stopWaitingForApiSession?.();
    stopWaitingForApiSession = null;
    set({
      hydrated: false,
      ownerKey: owner,
      profile: null,
      hydrateError: null,
      canonicalProfilePending: false,
    });
    try {
      const db = getDb();
      const pending = parsePendingProfile(
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
      const canonicalOwner =
        owner !== GUEST_DATA_OWNER && owner !== SIGNED_OUT_DATA_OWNER;
      if (!raw && canonicalOwner) {
        const apiSession = sessionForOwner(owner);
        if (!apiSession) {
          // The launch refresh has not landed (authStore continues
          // 'offline' after its own budget while the session keeper keeps
          // trying). The account may well have a profile, so the
          // questionnaire must not be shown; fetch it the moment the API
          // session is established for this owner.
          if (getActiveDataOwner() !== owner) return;
          set({
            hydrated: true,
            ownerKey: owner,
            profile: null,
            hydrateError: null,
            canonicalProfilePending: true,
          });
          const unsubscribe = subscribeToApiSession(() => {
            const arrived = sessionForOwner(owner);
            if (!arrived) return;
            unsubscribe();
            if (stopWaitingForApiSession === unsubscribe) {
              stopWaitingForApiSession = null;
            }
            if (hydrateGeneration !== generation) return;
            void settleCanonicalProfile(
              db,
              owner,
              generation,
              arrived,
              pending,
            );
          });
          stopWaitingForApiSession = unsubscribe;
          return;
        }
        // Bound the launch, not the fetch: after the budget the Gate opens
        // with the profile still pending; the fetch settles the state when
        // it completes.
        const settled = settleCanonicalProfile(
          db,
          owner,
          generation,
          apiSession,
          pending,
        );
        let budget: ReturnType<typeof setTimeout> | null = null;
        const withinBudget = await Promise.race([
          settled.then(() => true),
          new Promise<boolean>(resolve => {
            budget = setTimeout(
              () => resolve(false),
              CANONICAL_PROFILE_LAUNCH_BUDGET_MS,
            );
          }),
        ]);
        if (budget !== null) clearTimeout(budget);
        if (
          !withinBudget &&
          hydrateGeneration === generation &&
          getActiveDataOwner() === owner
        ) {
          set({
            hydrated: true,
            ownerKey: owner,
            profile: null,
            hydrateError: null,
            canonicalProfilePending: true,
          });
        }
        return;
      }
      raw = await adoptPendingProfile(
        db,
        owner,
        pending,
        canonicalOwner ? sessionForOwner(owner) : null,
        raw,
      );
      if (getActiveDataOwner() !== owner) return;
      settle(owner, raw);
    } catch (error) {
      if (getActiveDataOwner() === owner) {
        settleWithError(owner, hydrateErrorMessage(error));
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
