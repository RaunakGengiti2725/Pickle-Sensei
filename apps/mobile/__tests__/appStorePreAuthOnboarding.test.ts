import type { Profile } from '../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

/**
 * Pre-auth onboarding: the questionnaire runs BEFORE sign-in, stashes its
 * answers device-level, and hydrate() adopts them into the first writable
 * owner without a profile of its own. Existing profiles — local or canonical
 * — always win over the stash, and the stash is single-use.
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
  DEVICE_ONBOARDED_KV_KEY,
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
  mockKvTable.set(DEVICE_ONBOARDED_KV_KEY, JSON.stringify({ version: 1 }));
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
    preAuthOnboarded: false,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('completePreAuthOnboarding', () => {
  it('stashes the answers while signed out and marks the device onboarded', async () => {
    await expect(
      useAppStore.getState().completePreAuthOnboarding(answers),
    ).resolves.toBe(true);
    expect(JSON.parse(pendingRaw() ?? '')).toEqual({
      version: 1,
      profile: answers,
    });
    expect(mockKvTable.get(DEVICE_ONBOARDED_KV_KEY)).toBe(
      JSON.stringify({ version: 1 }),
    );
    expect(useAppStore.getState().preAuthOnboarded).toBe(true);
    // No owner exists yet: nothing was synced or owner-persisted.
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });
});

describe('hydrate with a pre-auth stash', () => {
  it('keeps the stash while signed out and reports the device as onboarded', async () => {
    stashAnswers();
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.preAuthOnboarded).toBe(true);
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

  it('discards the stash when the account already has a canonical profile', async () => {
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
    expect(state.profile).toEqual(existing);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(pendingRaw()).toBeNull();
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
    expect(state.preAuthOnboarded).toBe(true);
    expect(pendingRaw()).not.toBeNull();
  });

  it('backfills the device marker for accounts that onboarded in-app before this flow', async () => {
    mockKvTable.set(profileKeyFor(GUEST_DATA_OWNER), JSON.stringify(answers));
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().preAuthOnboarded).toBe(true);
    expect(mockKvTable.get(DEVICE_ONBOARDED_KV_KEY)).toBe(
      JSON.stringify({ version: 1 }),
    );
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
