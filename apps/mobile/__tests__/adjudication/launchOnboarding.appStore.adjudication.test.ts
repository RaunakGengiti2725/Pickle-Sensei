import type { Profile } from '../../src/state/profile';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Adjudication repros for area `mobile-launch-onboarding` @ 4d812e1a.
 *
 * Each `it` states the CONTRACT (the behaviour a fix must deliver). Every
 * one of them FAILED on 4d812e1a — that failure is the independent
 * reproduction of the auditor finding named in the describe title. They
 * are audit-only and must not be weakened.
 *
 * This file carries cluster ADJ-D (stale pre-auth stash resurrection) and
 * its companion ADJ-A2 (swallowed stash-adoption PUT failure).
 */

const mockKvTable = new Map<string, string>();
let mockReadFailure: Error | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockReadFailure) throw mockReadFailure;
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

type MockApiSession = {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
};
let mockApiSession: MockApiSession | null = null;

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>(
  async (_session, profile) => profile,
);

jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';

const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);

const apiSession: MockApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'token',
  canonicalAppUserId: CANONICAL_ID,
  provider: 'apple',
};

const stashed: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

const serverProfile: Profile = {
  skillLevel: '4.0',
  handedness: 'left',
  goal: 'drives',
  biggestProblem: 'contact',
  focusCheckpoint: 'preparation',
};

const profileKey = (owner: string) => `profile:${owner}`;
const pendingRaw = () =>
  mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY) || null;
const stash = (profile: Profile = stashed) =>
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );

beforeEach(() => {
  mockKvTable.clear();
  mockReadFailure = null;
  mockApiSession = null;
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_s, profile) => profile);
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

describe('ADJ-D — stale pre-auth stash resurrects over a newer in-account completion', () => {
  it('answers re-given in the in-account questionnaire are not replaced by the older stash on the next hydrate', async () => {
    // 1. Pre-auth answers stashed; sign-in hydrate's PUT fails → stash kept.
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockSaveCanonical.mockRejectedValueOnce(new Error('offline'));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(pendingRaw()).not.toBeNull();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    // 2. The user answers the in-account questionnaire DIFFERENTLY and this
    //    save succeeds.
    const reAnswered: Profile = {
      firstName: 'Sam',
      gender: 'male',
      skillLevel: '4.5',
      handedness: 'right',
      goal: 'volleys',
      biggestProblem: 'consistency',
      focusCheckpoint: 'face_wrist_stability',
    };
    await useAppStore.getState().completeOnboarding(reAnswered);
    expect(useAppStore.getState().profile).toEqual(reAnswered);
    expect(mockSaveCanonical).toHaveBeenLastCalledWith(apiSession, reAnswered);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(2);
    expect(pendingRaw()).toBeNull();

    // 3. Next launch: the newest intent is `reAnswered`, not the stale stash
    //    — nothing is PUT to the server again, least of all the old answers.
    mockSaveCanonical.mockClear();
    mockFetchCanonical.mockResolvedValue(reAnswered);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(reAnswered);
    expect(
      JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER)) ?? ''),
    ).toEqual(reAnswered);
    expect(mockSaveCanonical).not.toHaveBeenCalledWith(apiSession, stashed);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(pendingRaw()).toBeNull();
  });

  it('completeOnboarding supersedes the pending stash (single-use, newest intent wins)', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockSaveCanonical.mockRejectedValueOnce(new Error('offline'));
    await useAppStore.getState().hydrate();
    expect(pendingRaw()).not.toBeNull();

    await useAppStore.getState().completeOnboarding(serverProfile);
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(useAppStore.getState().onboardingError).toBeNull();
    expect(pendingRaw()).toBeNull();
  });
});

describe('ADJ-A2 — stash adoption PUT fails for a canonical owner with no profile yet', () => {
  it('surfaces a retryable hydrateError (answers are on disk) rather than silently re-asking the questionnaire', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockSaveCanonical.mockRejectedValue(new Error('offline'));

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(CANONICAL_OWNER);
    expect(state.profile).toBeNull();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
    expect(JSON.parse(pendingRaw() ?? '')).toEqual({
      version: 1,
      profile: stashed,
    });
    // Gate: `!profile && hydrateError` → ErrorState with Retry;
    // `!profile && !hydrateError` → in-account questionnaire (answers
    // discarded from the user's view).
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
  });
});
