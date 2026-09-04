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
import { getApiSession, type ApiSession } from '../account/apiSession';
import {
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../account/onboarding';
import { parseProfile, type Profile } from './profile';
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

/** Local kv read failed (SQLite) — the driver text never reaches the user. */
export const LOCAL_PROFILE_UNAVAILABLE_MESSAGE =
  'Pickle Sensei could not load your coaching profile on this device. Try again.';

/** Canonical owner completing onboarding while no bearer is installed. */
export const ONBOARDING_ACCOUNT_UNAVAILABLE_MESSAGE =
  'Pickle Sensei could not reach your account to save your answers. Check your connection and try again.';

/** Parses kv JSON; anything unparseable reads as absent. */
function parseKvJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parsePendingProfile(raw: string | null): Profile | null {
  const parsed = parseKvJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parseProfile((parsed as Record<string, unknown>)['profile']);
}

function parseStoredProfile(raw: string | null): Profile | null {
  return parseProfile(parseKvJson(raw));
}

/** Owners that live on the server (not the guest bucket, not signed-out). */
function isCanonicalOwner(owner: string): boolean {
  return owner !== GUEST_DATA_OWNER && owner !== SIGNED_OUT_DATA_OWNER;
}

/** The bearer-backed session for this owner, or null while none is installed
 * (launch restore still refreshing / offline). A canonical owner without one
 * is never treated like a guest: nothing is saved locally on its behalf. */
function apiSessionFor(owner: string): ApiSession | null {
  const session = getApiSession();
  return session && canonicalDataOwner(session.canonicalAppUserId) === owner
    ? session
    : null;
}

interface AppState {
  hydrated: boolean;
  ownerKey: string | null;
  profile: Profile | null;
  /** Set when hydrate() finished without a profile because the owner's data
   * could not be read (canonical fetch or local read failed) — the Gate shows
   * a retry state instead of re-asking the questionnaire. */
  hydrateError: string | null;
  /** hydrate() finished for a canonical owner with no bearer installed and
   * could not settle the profile (nothing local, or a pre-auth stash still
   * waiting for its canonical save); the Gate re-hydrates once a bearer lands. */
  awaitingBearer: boolean;
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
  hydrateError: null,
  awaitingBearer: false,
  onboardingBusy: false,
  onboardingError: null,
  lastShotType: 'forehand_drive',
  hydrate: async () => {
    const owner = getActiveDataOwner();
    set({
      hydrated: false,
      ownerKey: owner,
      profile: null,
      hydrateError: null,
      awaitingBearer: false,
    });
    try {
      const db = getDb();
      const profileKey = profileKeyForOwner(owner);
      let pending = parsePendingProfile(
        await getKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY),
      );
      let raw = await getKv(db, profileKey);
      if (!raw && owner === GUEST_DATA_OWNER) {
        const legacy = await getKv(db, 'profile');
        if (legacy) {
          await setKv(db, profileKey, legacy);
          await setKv(db, 'profile', '');
          raw = legacy;
        }
      }
      // A row that is not a Profile (corrupt bytes, non-object JSON, missing
      // or mistyped fields) is blanked and treated as absent so the canonical
      // fetch / questionnaire below can repair it instead of it hydrating as
      // a truthy profile the Gate would mount the app on.
      let profile = parseStoredProfile(raw);
      if (raw && !profile) {
        await setKv(db, profileKey, '');
      }
      const canonical = isCanonicalOwner(owner);
      const apiSession = canonical ? apiSessionFor(owner) : null;
      if (!profile && apiSession) {
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
          profile = canonicalProfile;
          await setKv(db, profileKey, JSON.stringify(profile));
        }
      }
      // Adopt the pre-auth questionnaire into the first writable owner that
      // hydrates, REPLACING whatever profile it had (the answers just given
      // on this device are the newest intent); synced accounts save through
      // the canonical endpoint first (server focusCheckpoint wins) exactly
      // like completeOnboarding, so a canonical owner with no bearer leaves
      // the stash untouched for a later hydrate. A failed save keeps both
      // the stash (retried next hydrate) and the existing profile.
      if (
        pending &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        (!canonical || apiSession) &&
        getActiveDataOwner() === owner
      ) {
        try {
          const adopted = apiSession
            ? await saveCanonicalOnboardingProfile(apiSession, pending)
            : pending;
          await setKv(db, profileKey, JSON.stringify(adopted));
          await setKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY, '');
          profile = adopted;
          pending = null;
        } catch {
          // Stash and existing profile both survive for the next attempt.
        }
      }
      if (getActiveDataOwner() !== owner) return;
      const awaitingBearer =
        canonical && !apiSession && (!profile || pending !== null);
      set({
        profile,
        hydrated: true,
        ownerKey: owner,
        // No bearer and nothing local to show: the account could not be
        // consulted, so surface the retryable account state rather than
        // re-asking the questionnaire (its answers could not be saved yet).
        hydrateError:
          awaitingBearer && !profile
            ? CANONICAL_PROFILE_UNAVAILABLE_MESSAGE
            : null,
        awaitingBearer,
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
          hydrateError: LOCAL_PROFILE_UNAVAILABLE_MESSAGE,
          awaitingBearer: false,
        });
      }
    }
  },
  completeOnboarding: async profile => {
    const owner = requireWritableDataOwner();
    set({ onboardingBusy: true, onboardingError: null });
    const apiSession = apiSessionFor(owner);
    if (isCanonicalOwner(owner) && !apiSession) {
      // Canonical answers save through /v1/me/onboarding first; without a
      // bearer there is nothing to save against, and a local-only row would
      // shadow /v1/me on every later hydrate. Retryable: the Gate re-hydrates
      // when the bearer lands and the screen keeps its answers.
      set({
        onboardingBusy: false,
        onboardingError: ONBOARDING_ACCOUNT_UNAVAILABLE_MESSAGE,
      });
      return;
    }
    try {
      const canonicalProfile = apiSession
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
