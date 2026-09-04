import type { Profile } from '../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

/**
 * Pre-auth onboarding: the questionnaire runs BEFORE sign-in, stashes its
 * answers device-level, and hydrate() adopts them into the first writable
 * owner that signs in — REPLACING any profile that owner already had (the
 * answers just given on this device are the newest intent). The stash is
 * single-use; a failed server save keeps it, and the existing profile, for
 * the next hydrate.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>(
  async (_session, profile) => profile,
);

jest.mock('../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../src/state/appStore';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../src/account/apiSession';

const CANONICAL_OWNER = '33333333-3333-4333-8333-333333333333';
const OTHER_OWNER = '44444444-4444-4444-8444-444444444444';

const canonicalSession: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'token',
  canonicalAppUserId: CANONICAL_OWNER,
  provider: 'apple',
};

const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function profileKeyFor(owner: string): string {
  return `profile:${owner}`;
}

function pendingRaw(): string | null {
  const value = mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
  return value ? value : null;
}

function stashAnswers(profile: Profile = answers) {
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );
}

beforeEach(() => {
  mockKvTable.clear();
  clearApiSession();
  mockFetchCanonical.mockClear();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockClear();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('completePreAuthOnboarding', () => {
  it('stashes the answers while signed out — the stash is the only device write', async () => {
    await expect(
      useAppStore.getState().completePreAuthOnboarding(answers),
    ).resolves.toBe(true);
    expect(JSON.parse(pendingRaw() ?? '')).toEqual({
      version: 1,
      profile: answers,
    });
    expect([...mockKvTable.keys()]).toEqual([
      PENDING_ONBOARDING_PROFILE_KV_KEY,
    ]);
    // No owner exists yet: nothing was synced or owner-persisted.
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });
});

describe('hydrate with a pre-auth stash', () => {
  it('keeps the stash while signed out', async () => {
    stashAnswers();
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(pendingRaw()).not.toBeNull();
  });

  it('adopts the stash into the guest bucket without any server call', async () => {
    stashAnswers();
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.profile).toEqual(answers);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(GUEST_DATA_OWNER))!),
    ).toEqual(answers);
    expect(pendingRaw()).toBeNull();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('adopts the stash into a fresh canonical account through the server save', async () => {
    stashAnswers();
    establishApiSession(canonicalSession);
    const serverProfile: Profile = {
      ...answers,
      focusCheckpoint: 'preparation',
    };
    mockSaveCanonical.mockResolvedValue(serverProfile);
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(mockSaveCanonical).toHaveBeenCalledWith(canonicalSession, answers);
    // The server's focusCheckpoint wins, exactly like completeOnboarding.
    expect(state.profile).toEqual(serverProfile);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(serverProfile);
    expect(pendingRaw()).toBeNull();
  });

  it('replaces an existing canonical profile with the freshly answered stash (newest intent wins)', async () => {
    stashAnswers();
    establishApiSession(canonicalSession);
    const existing: Profile = {
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'drives',
      biggestProblem: 'contact',
      focusCheckpoint: 'preparation',
    };
    mockFetchCanonical.mockResolvedValue(existing);
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    // Saved through the canonical endpoint like any onboarding completion…
    expect(mockSaveCanonical).toHaveBeenCalledWith(canonicalSession, answers);
    // …and the new answers, not the old profile, are what the owner now has.
    expect(state.profile).toEqual(answers);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(answers);
    expect(pendingRaw()).toBeNull();
  });

  it('replaces an existing guest profile with the freshly answered stash', async () => {
    const existing: Profile = {
      skillLevel: '2.5',
      handedness: 'left',
      goal: 'serve',
      biggestProblem: 'consistency',
      focusCheckpoint: 'sequencing',
    };
    mockKvTable.set(profileKeyFor(GUEST_DATA_OWNER), JSON.stringify(existing));
    stashAnswers();
    setActiveDataOwner(GUEST_DATA_OWNER);

    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(pendingRaw()).toBeNull();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('keeps the existing profile AND the stash when replacing it fails server-side', async () => {
    stashAnswers();
    establishApiSession(canonicalSession);
    const existing: Profile = {
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'drives',
      biggestProblem: 'contact',
      focusCheckpoint: 'preparation',
    };
    mockFetchCanonical.mockResolvedValue(existing);
    mockSaveCanonical.mockRejectedValue(new Error('offline'));
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    // Nothing invented and nothing lost: the old profile still stands…
    expect(state.profile).toEqual(existing);
    // …and the answers wait for the next hydrate.
    expect(pendingRaw()).not.toBeNull();
  });

  it('keeps the stash when the adoption save fails, for the next hydrate', async () => {
    stashAnswers();
    establishApiSession(canonicalSession);
    mockSaveCanonical.mockRejectedValue(new Error('offline'));
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(pendingRaw()).not.toBeNull();
  });

  it('records no device-level onboarding history when an existing profile hydrates', async () => {
    // The launch gate never consults device history, so hydrate must not
    // leave a "this device onboarded" marker behind that could tempt a
    // future gate into skipping the questionnaire for new players.
    mockKvTable.set(profileKeyFor(GUEST_DATA_OWNER), JSON.stringify(answers));
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(answers);
    expect([...mockKvTable.keys()]).toEqual([profileKeyFor(GUEST_DATA_OWNER)]);
  });

  it('ignores a malformed stash instead of adopting garbage', async () => {
    mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, '{"version":1}');
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.profile).toBeNull();
    expect(mockKvTable.get(profileKeyFor(GUEST_DATA_OWNER))).toBeUndefined();
  });
});

/**
 * Canonical profile truth: for a signed-in (canonical) owner, "no profile"
 * may only be concluded from the SERVER. Hydrating before the bearer exists
 * (offline relaunch after a local wipe, a fresh device) must not send a
 * fully onboarded account back into the questionnaire.
 */
describe('hydrate for a canonical owner before the API session exists', () => {
  const serverProfile: Profile = {
    ...answers,
    focusCheckpoint: 'preparation',
  };

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  it('reports the profile as unavailable (retryable), then fetches and persists the canonical profile once the session is configured — same owner throughout', async () => {
    mockFetchCanonical.mockResolvedValue(serverProfile);
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    const before = useAppStore.getState();
    expect(before.hydrated).toBe(true);
    expect(before.ownerKey).toBe(CANONICAL_OWNER);
    expect(before.profile).toBeNull();
    // Not "no profile" — unknown until the server answers.
    expect(before.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))).toBeUndefined();

    establishApiSession(canonicalSession);
    await settle();

    const after = useAppStore.getState();
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonical).toHaveBeenCalledWith(canonicalSession);
    expect(after.hydrated).toBe(true);
    expect(after.ownerKey).toBe(CANONICAL_OWNER);
    expect(after.profile).toEqual(serverProfile);
    expect(after.hydrateError).toBeNull();
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(serverProfile);
  });

  it('offers the questionnaire only after the server has answered "no profile"', async () => {
    mockFetchCanonical.mockResolvedValue(null);
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBe(
      CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    );

    establishApiSession(canonicalSession);
    await settle();

    const state = useAppStore.getState();
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(CANONICAL_OWNER);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toBeNull();
  });

  it('ignores a session for a different account and a session cleared again', async () => {
    mockFetchCanonical.mockResolvedValue(serverProfile);
    setActiveDataOwner(CANONICAL_OWNER);
    await useAppStore.getState().hydrate();

    establishApiSession({
      ...canonicalSession,
      canonicalAppUserId: OTHER_OWNER,
    });
    await settle();
    clearApiSession();
    await settle();

    const state = useAppStore.getState();
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(state.ownerKey).toBe(CANONICAL_OWNER);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
  });

  it('a locally persisted profile is truth enough: no wait, no fetch', async () => {
    mockKvTable.set(profileKeyFor(CANONICAL_OWNER), JSON.stringify(answers));
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.profile).toEqual(answers);
    expect(state.hydrateError).toBeNull();

    establishApiSession(canonicalSession);
    await settle();
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(useAppStore.getState().profile).toEqual(answers);
  });

  it('a signed-out or guest owner never waits for a session', async () => {
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).toBeNull();
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(mockFetchCanonical).not.toHaveBeenCalled();
  });
});
