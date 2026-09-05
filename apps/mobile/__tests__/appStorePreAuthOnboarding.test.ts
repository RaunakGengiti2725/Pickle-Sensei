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

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;

jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
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

const CANONICAL_OWNER = '33333333-3333-4333-8333-333333333333';

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
  mockApiSession = null;
  mockFetchCanonical.mockClear();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockClear();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

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
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_OWNER,
      provider: 'apple',
    };
    const serverProfile: Profile = {
      ...answers,
      focusCheckpoint: 'preparation',
    };
    mockSaveCanonical.mockResolvedValue(serverProfile);
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(mockSaveCanonical).toHaveBeenCalledWith(mockApiSession, answers);
    // The server's focusCheckpoint wins, exactly like completeOnboarding.
    expect(state.profile).toEqual(serverProfile);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(serverProfile);
    expect(pendingRaw()).toBeNull();
  });

  it('replaces an existing canonical profile with the freshly answered stash (newest intent wins)', async () => {
    stashAnswers();
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_OWNER,
      provider: 'apple',
    };
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
    expect(mockSaveCanonical).toHaveBeenCalledWith(mockApiSession, answers);
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
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_OWNER,
      provider: 'apple',
    };
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
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_OWNER,
      provider: 'apple',
    };
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

describe('canonical profile hydration before a restored bearer is available', () => {
  const existing: Profile = {
    skillLevel: '4.0',
    handedness: 'left',
    goal: 'drives',
    biggestProblem: 'contact',
    focusCheckpoint: 'preparation',
  };
  const session = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'restored-bearer',
    canonicalAppUserId: CANONICAL_OWNER,
    provider: 'apple' as const,
  };

  it.each([false, true])(
    'shows a retryable load error without a local profile or bearer (pending answers: %s)',
    async pending => {
      if (pending) stashAnswers();
      const before = [...mockKvTable.entries()];
      setActiveDataOwner(CANONICAL_OWNER);

      await useAppStore.getState().hydrate();

      expect(useAppStore.getState()).toMatchObject({
        hydrated: true,
        ownerKey: CANONICAL_OWNER,
        profile: null,
        hydrateError: CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
      });
      expect([...mockKvTable.entries()]).toEqual(before);
      expect(mockFetchCanonical).not.toHaveBeenCalled();
      expect(mockSaveCanonical).not.toHaveBeenCalled();
    },
  );

  it('uses the cached profile offline without consuming pending answers locally', async () => {
    stashAnswers();
    mockKvTable.set(profileKeyFor(CANONICAL_OWNER), JSON.stringify(existing));
    const before = [...mockKvTable.entries()];
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();

    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: existing,
      hydrateError: null,
    });
    expect([...mockKvTable.entries()]).toEqual(before);
    expect(mockSaveCanonical).not.toHaveBeenCalled();

    mockApiSession = session;
    mockSaveCanonical.mockRejectedValueOnce(new Error('still offline'));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(existing);
    expect([...mockKvTable.entries()]).toEqual(before);

    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).toHaveBeenLastCalledWith(session, answers);
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(pendingRaw()).toBeNull();
  });

  it('does not mistake a different account bearer for a reachable canonical profile', async () => {
    stashAnswers();
    mockApiSession = {
      ...session,
      canonicalAppUserId: '44444444-4444-4444-8444-444444444444',
    };
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().hydrateError).toBe(
      CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    );
    expect(useAppStore.getState().profile).toBeNull();
    expect(pendingRaw()).not.toBeNull();
    expect(mockKvTable.has(profileKeyFor(CANONICAL_OWNER))).toBe(false);
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('retries an interrupted canonical fetch without overwriting the server profile or consuming the stash', async () => {
    stashAnswers();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = session;
    mockFetchCanonical.mockRejectedValueOnce(new Error('offline'));

    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).toBe(
      CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    );
    expect(pendingRaw()).not.toBeNull();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(mockKvTable.has(profileKeyFor(CANONICAL_OWNER))).toBe(false);

    mockFetchCanonical.mockResolvedValue(existing);
    mockSaveCanonical.mockRejectedValueOnce(new Error('save interrupted'));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(existing);
    expect(pendingRaw()).not.toBeNull();

    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(pendingRaw()).toBeNull();
  });

  it('requires onboarding only once the server confirms there is no profile', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).toBe(
      CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    );

    mockApiSession = session;
    await useAppStore.getState().hydrate();
    expect(mockFetchCanonical).toHaveBeenCalledWith(session);
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
      hydrateError: null,
    });
  });

  it('does not cache or apply an older concurrent hydrate after a successful retry', async () => {
    let finish!: (profile: Profile | null) => void;
    mockApiSession = session;
    setActiveDataOwner(CANONICAL_OWNER);
    mockFetchCanonical.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const interrupted = useAppStore.getState().hydrate();
    for (let i = 0; i < 10 && !finish; i += 1) await Promise.resolve();
    expect(finish).toBeDefined();

    mockFetchCanonical.mockResolvedValue(existing);
    await useAppStore.getState().hydrate();
    finish(answers);
    await interrupted;

    expect(useAppStore.getState().profile).toEqual(existing);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(existing);
  });

  it.each(['switch', 'return-to-owner'] as const)(
    'does not persist a late canonical fetch after %s',
    async change => {
      let finish!: (profile: Profile | null) => void;
      mockApiSession = session;
      setActiveDataOwner(CANONICAL_OWNER);
      mockFetchCanonical.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          }),
      );
      const interrupted = useAppStore.getState().hydrate();
      for (let i = 0; i < 10 && !finish; i += 1) await Promise.resolve();
      expect(finish).toBeDefined();
      setActiveDataOwner('44444444-4444-4444-8444-444444444444');
      if (change === 'return-to-owner') setActiveDataOwner(CANONICAL_OWNER);
      finish(existing);
      await interrupted;

      expect(mockKvTable.has(profileKeyFor(CANONICAL_OWNER))).toBe(false);
      expect(useAppStore.getState().profile).toBeNull();
    },
  );

  it('cannot complete canonical onboarding as a local-only save when the bearer is missing', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    await useAppStore.getState().completeOnboarding(answers);

    expect(useAppStore.getState()).toMatchObject({
      profile: null,
      onboardingBusy: false,
      onboardingError: CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    });
    expect(mockKvTable.has(profileKeyFor(CANONICAL_OWNER))).toBe(false);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });
});
