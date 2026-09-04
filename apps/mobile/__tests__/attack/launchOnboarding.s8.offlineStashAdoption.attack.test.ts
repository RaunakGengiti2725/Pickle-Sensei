/**
 * ADVERSARIAL S8 (self-assigned) — a canonical (Apple/Google) account whose
 * launch refresh did not complete (offline: `restorePersistedSession` →
 * 'offline', no bearer, `getApiSession()` null) hydrates with a pending
 * pre-auth stash.
 *
 * AGENTS.md: "canonical accounts save through /v1/me/onboarding first —
 * server focusCheckpoint wins ... a failed server save keeps both the stash
 * (retried next hydrate) and the existing profile."
 *
 * Attack: is the stash consumed WITHOUT ever reaching the server when the
 * account is momentarily offline, and does anything push it later once the
 * bearer arrives?
 */
import type { LocalDb } from '../../src/data/db';
import type { Profile } from '../../src/state/profile';

const mockKv = new Map<string, string>();
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

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
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const OWNER = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

beforeEach(() => {
  mockKv.clear();
  mockFetchCanonical.mockClear();
  mockSaveCanonical.mockClear();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('S8 offline canonical launch with a pending pre-auth stash', () => {
  it('keeps the stash for the next online hydrate instead of consuming it without a server save', async () => {
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    // Signed in from the Keychain record, refresh still pending → no bearer.
    setActiveDataOwner(OWNER);
    clearApiSession();

    await useAppStore.getState().hydrate();

    const offline = {
      saveCalls: mockSaveCanonical.mock.calls.length,
      stash: mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
      localProfile: mockKv.get(profileKeyForOwner(OWNER)),
      storeProfile: useAppStore.getState().profile,
    };

    // The bearer arrives (refresh succeeded a moment later) and the app
    // hydrates again on the next launch / owner change.
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'access-1',
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
    await useAppStore.getState().hydrate();

    const online = {
      saveCalls: mockSaveCanonical.mock.calls.length,
      fetchCalls: mockFetchCanonical.mock.calls.length,
      stash: mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
      storeProfile: useAppStore.getState().profile,
    };
    console.log(JSON.stringify({ scenario: 'S8', offline, online }));

    // The account is personalized locally either way…
    expect(useAppStore.getState().profile).toEqual(answers);
    // …but the questionnaire must reach /v1/me/onboarding exactly once for a
    // canonical account: either the offline hydrate left the stash alone and
    // the online one saved it, or nothing else is acceptable.
    expect(online.saveCalls).toBe(1);
  });
});
