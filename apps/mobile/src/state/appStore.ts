import { create } from 'zustand';
import type { ShotTypeSlug } from '@pickle/shared-types';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import { forDataOwner, withTransaction } from '../data/transactions';
import {
  DataOwnerChangedError,
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  profileKeyForOwner,
  type DataOwnerContext,
} from '../data/accountScope';
import { getApiSession, subscribeToApiSession } from '../account/apiSession';
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

function profileFromValue(value: unknown): Profile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const requiredStrings = [
    'skillLevel',
    'handedness',
    'goal',
    'biggestProblem',
    'focusCheckpoint',
  ] as const;
  if (requiredStrings.some(key => typeof candidate[key] !== 'string'))
    return null;
  if (
    candidate['firstName'] !== undefined &&
    typeof candidate['firstName'] !== 'string'
  )
    return null;
  if (
    candidate['gender'] !== undefined &&
    (typeof candidate['gender'] !== 'string' ||
      !['female', 'male', 'nonbinary', 'prefer_not_to_say'].includes(
        candidate['gender'],
      ))
  )
    return null;
  return value as Profile;
}

function parseStoredProfile(raw: string | null): Profile | null {
  if (!raw) return null;
  try {
    return profileFromValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parsePendingProfile(raw: string | null): Profile | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return profileFromValue((parsed as Record<string, unknown>)['profile']);
  } catch {
    return null;
  }
}

interface AppState {
  hydrated: boolean;
  ownerKey: string | null;
  ownerContext: DataOwnerContext | null;
  awaitingApiSession: boolean;
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

let profileRevision = 0;
let hydrationInFlight: {
  context: DataOwnerContext;
  revision: number;
  hasApiSession: boolean;
  promise: Promise<void>;
} | null = null;

function apiSessionFor(owner: string) {
  const session = getApiSession();
  return session && canonicalDataOwner(session.canonicalAppUserId) === owner
    ? session
    : null;
}

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  ownerKey: null,
  ownerContext: null,
  awaitingApiSession: false,
  profile: null,
  hydrateError: null,
  onboardingBusy: false,
  onboardingError: null,
  lastShotType: 'forehand_drive',
  hydrate: () => {
    watchApiSession();
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) {
      profileRevision += 1;
      hydrationInFlight = null;
      set({
        hydrated: true,
        ownerKey: owner,
        ownerContext: null,
        awaitingApiSession: false,
        profile: null,
        hydrateError: null,
        onboardingBusy: false,
        onboardingError: null,
        lastShotType: 'forehand_drive',
      });
      return Promise.resolve();
    }
    const context = captureDataOwnerContext();
    const hasApiSession = Boolean(apiSessionFor(owner));
    if (
      hydrationInFlight &&
      hydrationInFlight.revision === profileRevision &&
      isDataOwnerContextCurrent(hydrationInFlight.context) &&
      hydrationInFlight.hasApiSession === hasApiSession
    ) {
      return hydrationInFlight.promise;
    }
    const revision = ++profileRevision;
    const current = () =>
      revision === profileRevision && isDataOwnerContextCurrent(context);
    const assertCurrent = () => {
      if (!current()) throw new DataOwnerChangedError();
    };
    const previous = get();
    let profile =
      previous.ownerContext && isDataOwnerContextCurrent(previous.ownerContext)
        ? previous.profile
        : null;
    set({
      hydrated: profile !== null,
      ownerKey: owner,
      ownerContext: context,
      awaitingApiSession: owner !== GUEST_DATA_OWNER && !hasApiSession,
      profile,
      hydrateError: null,
      onboardingBusy: false,
      onboardingError: null,
      lastShotType:
        previous.ownerContext &&
        isDataOwnerContextCurrent(previous.ownerContext)
          ? previous.lastShotType
          : 'forehand_drive',
    });
    const promise = (async () => {
      try {
        const db = forDataOwner(getDb(), context);
        const pendingRaw = await getKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY);
        assertCurrent();
        let pending = parsePendingProfile(pendingRaw);
        let raw = await getKv(db, profileKeyForOwner(owner));
        assertCurrent();
        if (!raw && owner === GUEST_DATA_OWNER) {
          const legacy = await getKv(db, 'profile');
          assertCurrent();
          if (legacy) {
            await withTransaction(db, async transaction => {
              assertCurrent();
              await setKv(transaction, profileKeyForOwner(owner), legacy);
              assertCurrent();
              await setKv(transaction, 'profile', '');
              assertCurrent();
            });
            assertCurrent();
            raw = legacy;
          }
        }
        let hydrateError: string | null = null;
        const storedProfile = parseStoredProfile(raw);
        if (storedProfile) {
          profile = storedProfile;
          set({ profile, hydrated: true });
        }
        // Corrupt local bytes are retained until an authoritative replacement
        // is saved. They cannot mark onboarding complete or block new answers.
        const apiSession = apiSessionFor(owner);
        if (!profile && apiSession && (!pending || !raw)) {
          let canonicalProfile: Profile | null;
          try {
            canonicalProfile =
              await fetchCanonicalOnboardingProfile(apiSession);
          } catch {
            throw new Error(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
          }
          assertCurrent();
          if (canonicalProfile) {
            const canonicalRaw = JSON.stringify(canonicalProfile);
            await withTransaction(db, async transaction => {
              assertCurrent();
              await setKv(transaction, profileKeyForOwner(owner), canonicalRaw);
              assertCurrent();
            });
            assertCurrent();
            raw = canonicalRaw;
            profile = canonicalProfile;
          }
        }
        // Adopt the pre-auth questionnaire into the first writable owner that
        // hydrates, REPLACING whatever profile it had (the answers just given
        // on this device are the newest intent); synced accounts save through
        // the canonical endpoint first (server focusCheckpoint wins) exactly
        // like completeOnboarding. A failed save keeps both the stash (retried
        // next hydrate) and the existing profile.
        if (pending && (owner === GUEST_DATA_OWNER || apiSession)) {
          try {
            const adopted = apiSession
              ? await saveCanonicalOnboardingProfile(apiSession, pending)
              : pending;
            assertCurrent();
            const adoptedRaw = JSON.stringify(adopted);
            const applied = await withTransaction(db, async transaction => {
              assertCurrent();
              const latestPending = await getKv(
                transaction,
                PENDING_ONBOARDING_PROFILE_KV_KEY,
              );
              assertCurrent();
              if (latestPending !== pendingRaw) return false;
              await setKv(transaction, profileKeyForOwner(owner), adoptedRaw);
              assertCurrent();
              await setKv(transaction, PENDING_ONBOARDING_PROFILE_KV_KEY, '');
              assertCurrent();
              return true;
            });
            assertCurrent();
            if (applied) {
              raw = adoptedRaw;
              profile = adopted;
              pending = null;
              hydrateError = null;
            }
          } catch (error) {
            // Stash and existing profile both survive for the next attempt.
            assertCurrent();
            if (!profile) {
              hydrateError =
                error instanceof Error
                  ? error.message
                  : 'Your coaching profile could not be saved.';
            }
          }
        }
        assertCurrent();
        set({
          profile,
          hydrated: true,
          ownerKey: owner,
          awaitingApiSession:
            owner !== GUEST_DATA_OWNER &&
            !apiSession &&
            (!profile || pending !== null),
          hydrateError,
        });
      } catch (error) {
        if (current()) {
          set({
            hydrated: true,
            ownerKey: owner,
            profile,
            hydrateError:
              error instanceof Error
                ? error.message
                : 'Your coaching profile could not be loaded.',
          });
        }
      }
    })();
    const inFlight = { context, revision, hasApiSession, promise };
    hydrationInFlight = inFlight;
    void promise.then(() => {
      if (hydrationInFlight === inFlight) hydrationInFlight = null;
    });
    return promise;
  },
  completeOnboarding: async profile => {
    const context = captureDataOwnerContext();
    const owner = context.ownerKey;
    const revision = ++profileRevision;
    const current = () =>
      revision === profileRevision && isDataOwnerContextCurrent(context);
    const assertCurrent = () => {
      if (!current()) throw new DataOwnerChangedError();
    };
    set({ onboardingBusy: true, onboardingError: null });
    try {
      const apiSession = apiSessionFor(owner);
      if (owner !== GUEST_DATA_OWNER && !apiSession) {
        throw new Error(
          'Your account is still reconnecting. Check your connection and try saving again.',
        );
      }
      const canonicalProfile = apiSession
        ? await saveCanonicalOnboardingProfile(apiSession, profile)
        : profile;
      assertCurrent();
      const db = forDataOwner(getDb(), context);
      await withTransaction(db, async transaction => {
        assertCurrent();
        await setKv(
          transaction,
          profileKeyForOwner(owner),
          JSON.stringify(canonicalProfile),
        );
        assertCurrent();
      });
      if (current()) {
        set({
          profile: canonicalProfile,
          ownerKey: owner,
          ownerContext: context,
          hydrated: true,
          awaitingApiSession: false,
          hydrateError: null,
          onboardingBusy: false,
          onboardingError: null,
        });
      }
    } catch (error) {
      if (current()) {
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

let watchingApiSession = false;
function watchApiSession(): void {
  if (watchingApiSession) return;
  subscribeToApiSession(session => {
    const state = useAppStore.getState();
    if (
      session &&
      state.awaitingApiSession &&
      state.ownerContext &&
      isDataOwnerContextCurrent(state.ownerContext) &&
      canonicalDataOwner(session.canonicalAppUserId) === state.ownerKey
    ) {
      void state.hydrate();
    }
  });
  watchingApiSession = true;
}
