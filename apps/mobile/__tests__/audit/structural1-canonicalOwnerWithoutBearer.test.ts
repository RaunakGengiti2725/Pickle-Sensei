import type { Profile } from '../../src/state/profile';
import { setActiveDataOwner } from '../../src/data/accountScope';

/**
 * AUDIT PROBE (structural pass 1, mobile-launch-onboarding).
 *
 * Pre-condition pinned by the repo itself (authDurableSession.test.ts,
 * "offline launch"): after `authStore.hydrate()` restores a Keychain session
 * whose refresh has not landed within LAUNCH_REFRESH_WAIT_MS, the user IS
 * signed in (session set, active data owner = canonical UUID) while
 * `getApiSession()` is still `null`. The Gate then calls appStore.hydrate()
 * for that canonical owner.
 *
 * Documented invariants under test (AGENTS.md "Launch flow", appStore.ts
 * comments): canonical accounts save the pre-auth stash through
 * `/v1/me/onboarding` FIRST (server focusCheckpoint wins); the stash is kept
 * when the server save cannot happen; a canonical fetch that cannot be made
 * surfaces `hydrateError` instead of re-asking the questionnaire; a server
 * failure never becomes local completion.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../src/data/db', () => ({
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

const CANONICAL_OWNER = '55555555-5555-4555-8555-555555555555';

// The live ApiSession store: null until the launch refresh lands.
let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;

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
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';

const answers: Profile = {
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
  goal: 'serves',
  biggestProblem: 'power',
  focusCheckpoint: 'contact_position',
};

function profileRow(): string | null {
  return mockKvTable.get(`profile:${CANONICAL_OWNER}`) ?? null;
}

function pendingRaw(): string | null {
  const raw = mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
  return raw ? raw : null;
}

beforeEach(() => {
  mockKvTable.clear();
  mockApiSession = null;
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(serverProfile);
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  setActiveDataOwner(CANONICAL_OWNER);
});

describe('appStore.hydrate — canonical owner signed in from the Keychain record, bearer not yet available (getApiSession() === null)', () => {
  it('does NOT adopt the pre-auth stash locally: canonical owners save through the server first, so the stash must survive until a bearer exists', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(CANONICAL_OWNER);
    // Invariant: "canonical accounts save through /v1/me/onboarding first"
    // and "a failed server save keeps the stash". With no bearer the save
    // cannot happen, so the stash must still be on disk and no local
    // profile row may have been minted for the canonical bucket.
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(pendingRaw()).not.toBeNull();
    expect(profileRow()).toBeNull();
  });

  it('a later hydrate WITH a bearer still PUTs the stashed answers (the stash was not consumed by the bearer-less hydrate)', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    await useAppStore.getState().hydrate();

    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_OWNER,
      provider: 'apple',
    };
    mockFetchCanonical.mockResolvedValue(null);
    await useAppStore.getState().hydrate();

    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(mockSaveCanonical.mock.calls[0]![1]).toEqual(answers);
    expect(pendingRaw()).toBeNull();
  });

  it('with no local row and no bearer, surfaces hydrateError (retry state) rather than an empty profile that re-asks the questionnaire for an account that already has a server profile', async () => {
    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(CANONICAL_OWNER);
    expect(state.profile).toBeNull();
    // App.tsx Gate: `!profile && hydrateError` → ErrorState with retry;
    // `!profile && !hydrateError` → in-account OnboardingScreen (re-ask).
    expect(state.hydrateError).not.toBeNull();
  });
});

describe('appStore.completeOnboarding — canonical owner, bearer not yet available', () => {
  it('does not turn the account questionnaire into a LOCAL-ONLY completion: a canonical owner must PUT or fail, never silently skip the server', async () => {
    await useAppStore.getState().completeOnboarding(answers);

    const state = useAppStore.getState();
    // Either the server was written, or the failure was surfaced. What must
    // not happen: profile set + no error + no server call.
    const serverWritten = mockSaveCanonical.mock.calls.length > 0;
    const surfaced = state.onboardingError !== null;
    expect(serverWritten || surfaced).toBe(true);
    if (!serverWritten) {
      expect(state.profile).toBeNull();
      expect(profileRow()).toBeNull();
    }
  });

  it('a local-only row minted for a canonical owner shadows the server profile on every later hydrate (fetch is skipped whenever a local row exists)', async () => {
    await useAppStore.getState().completeOnboarding(answers);
    if (mockSaveCanonical.mock.calls.length > 0) {
      // Server was written — no shadowing possible; nothing further to probe.
      return;
    }
    // Bearer lands (keeper's first rotation), but the Gate never re-hydrates
    // for the same owner; even when it does, the local row wins.
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_OWNER,
      provider: 'apple',
    };
    await useAppStore.getState().hydrate();
    expect(mockFetchCanonical).toHaveBeenCalled();
    expect(useAppStore.getState().profile).toEqual(serverProfile);
  });
});
