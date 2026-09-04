import type { Profile } from '../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
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
  ONBOARDING_ACCOUNT_UNAVAILABLE_MESSAGE,
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
    awaitingBearer: false,
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

  it('ignores a stash whose handedness is out of vocabulary', async () => {
    stashAnswers({ ...answers, handedness: 'both' as Profile['handedness'] });
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockKvTable.get(profileKeyFor(GUEST_DATA_OWNER))).toBeUndefined();
  });
});

describe('canonical owner without a bearer (launch restore still refreshing / offline)', () => {
  const canonicalOwner = canonicalDataOwner(CANONICAL_OWNER);
  const apiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'token',
    canonicalAppUserId: CANONICAL_OWNER,
    provider: 'apple' as const,
  };

  it('flags awaitingBearer while a stash waits, and clears it once the bearer-backed hydrate saves it', async () => {
    stashAnswers();
    setActiveDataOwner(canonicalOwner);

    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().awaitingBearer).toBe(true);
    expect(useAppStore.getState().hydrateError).toBe(
      CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    );
    expect(mockSaveCanonical).not.toHaveBeenCalled();

    mockApiSession = apiSession;
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.awaitingBearer).toBe(false);
    expect(state.hydrateError).toBeNull();
    expect(state.profile).toEqual(answers);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(pendingRaw()).toBeNull();
  });

  it('flags awaitingBearer when there is no local profile, but not when one is already on this device', async () => {
    setActiveDataOwner(canonicalOwner);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().awaitingBearer).toBe(true);
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockFetchCanonical).not.toHaveBeenCalled();

    mockKvTable.set(profileKeyFor(canonicalOwner), JSON.stringify(answers));
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.awaitingBearer).toBe(false);
    expect(state.hydrateError).toBeNull();
    expect(state.profile).toEqual(answers);
  });

  it('never flags awaitingBearer for the guest bucket', async () => {
    stashAnswers();
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.awaitingBearer).toBe(false);
    expect(state.profile).toEqual(answers);
  });

  it('completeOnboarding refuses a local-only write with curated retryable copy', async () => {
    setActiveDataOwner(canonicalOwner);
    await useAppStore.getState().completeOnboarding(answers);
    const state = useAppStore.getState();
    expect(state.onboardingBusy).toBe(false);
    expect(state.onboardingError).toBe(ONBOARDING_ACCOUNT_UNAVAILABLE_MESSAGE);
    expect(state.profile).toBeNull();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(mockKvTable.get(profileKeyFor(canonicalOwner))).toBeUndefined();

    mockApiSession = apiSession;
    await useAppStore.getState().completeOnboarding(answers);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().onboardingError).toBeNull();
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(JSON.parse(mockKvTable.get(profileKeyFor(canonicalOwner))!)).toEqual(
      answers,
    );
  });
});
