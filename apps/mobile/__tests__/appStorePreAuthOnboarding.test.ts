import type { Profile } from '../src/state/profile';
import type { LocalDb } from '../src/data/db';
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
let mockReadGate: { key: string; promise: Promise<void> } | null = null;
let mockFailWriteKey: string | null = null;
let mockAfterWrite: ((key: string) => void) | null = null;
let mockTransactionCount = 0;

jest.mock('../src/data/db', () => ({
  getDb: () => {
    const db: LocalDb = {
      async execute(sql: string, params: unknown[] = []) {
        if (sql.startsWith('SELECT value FROM kv')) {
          if (mockReadGate && mockReadGate.key === params[0]) {
            const gate = mockReadGate;
            mockReadGate = null;
            await gate.promise;
          }
          const value = mockKvTable.get(String(params[0]));
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          if (mockFailWriteKey === params[0]) throw new Error('disk full');
          mockKvTable.set(String(params[0]), String(params[1]));
          mockAfterWrite?.(String(params[0]));
          return { rows: [] };
        }
        return { rows: [] };
      },
      async transaction(operation) {
        mockTransactionCount += 1;
        const snapshot = new Map(mockKvTable);
        try {
          return await operation(db);
        } catch (error) {
          mockKvTable.clear();
          for (const [key, value] of snapshot) mockKvTable.set(key, value);
          throw error;
        }
      },
      close() {},
    };
    return db;
  },
}));

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;

const mockApiListeners = new Set<(session: typeof mockApiSession) => void>();
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
  subscribeToApiSession: (
    listener: (session: typeof mockApiSession) => void,
  ) => {
    mockApiListeners.add(listener);
    return () => mockApiListeners.delete(listener);
  },
}));

function installLiveSession(owner = CANONICAL_OWNER) {
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'live-token',
    canonicalAppUserId: owner,
    provider: 'apple',
  };
  for (const listener of mockApiListeners) listener(mockApiSession);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushHydration() {
  for (let turn = 0; turn < 80; turn += 1) await Promise.resolve();
}

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
  mockReadGate = null;
  mockFailWriteKey = null;
  mockAfterWrite = null;
  mockTransactionCount = 0;
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
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('invalid stored coaching choices', () => {
  it.each([
    { handedness: 'none' },
    { focusCheckpoint: 'unknown_checkpoint' },
    { skillLevel: ' ' },
    { goal: '' },
    { biggestProblem: '\t' },
  ])('recovers canonical coaching data instead of using %j', async invalid => {
    setActiveDataOwner(CANONICAL_OWNER);
    installLiveSession();
    mockKvTable.set(
      profileKeyFor(CANONICAL_OWNER),
      JSON.stringify({ ...answers, ...invalid }),
    );
    mockFetchCanonical.mockResolvedValue(answers);
    await useAppStore.getState().hydrate();
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(answers);
  });
});

describe('pending answers with a corrupt older profile', () => {
  it.each([GUEST_DATA_OWNER, CANONICAL_OWNER])(
    'adopts the newest answers for %s without trusting the old JSON',
    async owner => {
      setActiveDataOwner(owner);
      if (owner === CANONICAL_OWNER) installLiveSession(owner);
      mockKvTable.set(profileKeyFor(owner), '{broken-profile');
      stashAnswers();
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toEqual(answers);
      expect(useAppStore.getState().hydrateError).toBeNull();
      expect(JSON.parse(mockKvTable.get(profileKeyFor(owner))!)).toEqual(
        answers,
      );
      expect(pendingRaw()).toBeNull();
      expect(mockSaveCanonical).toHaveBeenCalledTimes(
        owner === CANONICAL_OWNER ? 1 : 0,
      );
    },
  );

  it('preserves both original bytes and pending answers when canonical adoption fails, then retries', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    installLiveSession();
    const corrupt = '{broken-profile';
    mockKvTable.set(profileKeyFor(CANONICAL_OWNER), corrupt);
    stashAnswers();
    const pending = pendingRaw();
    mockSaveCanonical.mockRejectedValueOnce(new Error('Server unavailable'));
    await useAppStore.getState().hydrate();
    expect(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))).toBe(corrupt);
    expect(pendingRaw()).toBe(pending);
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBe('Server unavailable');
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(pendingRaw()).toBeNull();
  });
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

  it('waits for the restored canonical session instead of adopting a pending profile locally', async () => {
    stashAnswers();
    setActiveDataOwner(CANONICAL_OWNER);

    await useAppStore.getState().hydrate();

    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      awaitingApiSession: true,
      profile: null,
      hydrateError: null,
    });
    expect(mockKvTable.has(profileKeyFor(CANONICAL_OWNER))).toBe(false);
    expect(pendingRaw()).not.toBeNull();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('keeps the cached profile readable offline and waits to adopt new answers through the server', async () => {
    const cached = { ...answers, firstName: 'Cached' };
    mockKvTable.set(profileKeyFor(CANONICAL_OWNER), JSON.stringify(cached));
    stashAnswers();
    setActiveDataOwner(CANONICAL_OWNER);
    await useAppStore.getState().hydrate();

    expect(useAppStore.getState().profile).toEqual(cached);
    expect(useAppStore.getState().awaitingApiSession).toBe(true);
    expect(pendingRaw()).not.toBeNull();

    const gate = deferred<void>();
    mockReadGate = {
      key: PENDING_ONBOARDING_PROFILE_KV_KEY,
      promise: gate.promise,
    };
    const retry = useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(cached);
    expect(useAppStore.getState().hydrated).toBe(true);
    gate.resolve();
    await retry;
    expect(useAppStore.getState().profile).toEqual(cached);
  });

  it('automatically resumes pending adoption when the initial live API session arrives, not on rotations', async () => {
    stashAnswers();
    setActiveDataOwner(CANONICAL_OWNER);
    await useAppStore.getState().hydrate();
    const canonical = { ...answers, focusCheckpoint: 'preparation' as const };
    mockSaveCanonical.mockResolvedValue(canonical);

    installLiveSession();
    await flushHydration();

    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(canonical);
    expect(useAppStore.getState().awaitingApiSession).toBe(false);
    expect(pendingRaw()).toBeNull();
    useAppStore.getState().setLastShotType('backhand_drive');
    installLiveSession();
    await flushHydration();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().lastShotType).toBe('backhand_drive');
  });

  it('loads a missing canonical profile when the initial bearer arrives during local hydration', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    const gate = deferred<void>();
    mockReadGate = {
      key: PENDING_ONBOARDING_PROFILE_KV_KEY,
      promise: gate.promise,
    };
    mockFetchCanonical.mockResolvedValue(answers);
    const offlineHydration = useAppStore.getState().hydrate();

    installLiveSession();
    await flushHydration();
    gate.resolve();
    await offlineHydration;
    await flushHydration();

    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      awaitingApiSession: false,
      profile: answers,
    });
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(answers);
  });

  it('coalesces same-owner hydration while the canonical profile fetch is in flight', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    installLiveSession();
    const remote = deferred<Profile | null>();
    mockFetchCanonical.mockReturnValue(remote.promise);
    const first = useAppStore.getState().hydrate();
    const second = useAppStore.getState().hydrate();
    await flushHydration();
    const calls = mockFetchCanonical.mock.calls.length;
    remote.resolve(answers);
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(useAppStore.getState().profile).toEqual(answers);
  });

  it('rejects a profile fetched by an earlier A generation after A signs out and back in', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    installLiveSession();
    const oldRemote = deferred<Profile | null>();
    mockFetchCanonical.mockReturnValueOnce(oldRemote.promise);
    const oldHydration = useAppStore.getState().hydrate();
    await flushHydration();

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(CANONICAL_OWNER);
    const currentProfile = { ...answers, firstName: 'New session' };
    mockFetchCanonical.mockResolvedValue(currentProfile);
    await useAppStore.getState().hydrate();
    oldRemote.resolve(answers);
    await oldHydration;

    expect(useAppStore.getState().profile).toEqual(currentProfile);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
    ).toEqual(currentProfile);
  });

  it('does not consume a newer stash or persist an adoption from an earlier owner generation', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    installLiveSession();
    stashAnswers();
    const oldSave = deferred<Profile>();
    mockSaveCanonical.mockReturnValueOnce(oldSave.promise);
    const oldHydration = useAppStore.getState().hydrate();
    await flushHydration();

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(CANONICAL_OWNER);
    const newAnswers = { ...answers, firstName: 'New intent' };
    stashAnswers(newAnswers);
    oldSave.resolve(answers);
    await oldHydration;

    expect(mockKvTable.has(profileKeyFor(CANONICAL_OWNER))).toBe(false);
    expect(JSON.parse(pendingRaw()!).profile).toEqual(newAnswers);
  });

  it.each(['pending_write_failure', 'owner_generation_change'])(
    'rolls back profile adoption and stash consumption together on %s',
    async failure => {
      setActiveDataOwner(CANONICAL_OWNER);
      installLiveSession();
      const cached = { ...answers, firstName: 'Cached' };
      mockKvTable.set(profileKeyFor(CANONICAL_OWNER), JSON.stringify(cached));
      stashAnswers();
      if (failure === 'pending_write_failure') {
        mockFailWriteKey = PENDING_ONBOARDING_PROFILE_KV_KEY;
      } else {
        mockAfterWrite = key => {
          if (key !== profileKeyFor(CANONICAL_OWNER)) return;
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
          setActiveDataOwner(CANONICAL_OWNER);
        };
      }

      await useAppStore.getState().hydrate();

      expect(mockTransactionCount).toBe(1);
      expect(
        JSON.parse(mockKvTable.get(profileKeyFor(CANONICAL_OWNER))!),
      ).toEqual(cached);
      expect(JSON.parse(pendingRaw()!).profile).toEqual(answers);
    },
  );

  it('never saves account onboarding locally while its live API session is missing', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    await useAppStore.getState().completeOnboarding(answers);

    expect(mockKvTable.has(profileKeyFor(CANONICAL_OWNER))).toBe(false);
    expect(useAppStore.getState().onboardingBusy).toBe(false);
    expect(useAppStore.getState().onboardingError).toEqual(expect.any(String));
  });
});
