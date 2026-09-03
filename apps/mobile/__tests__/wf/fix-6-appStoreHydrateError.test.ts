import type { Profile } from '../../src/state/profile';
import { setActiveDataOwner } from '../../src/data/accountScope';

/**
 * A canonical profile fetch that fails at first sign-in must NOT drop the
 * user into the account questionnaire: the pre-auth stash stays intact, the
 * store surfaces `hydrateError`, and the next hydrate() (retry) adopts the
 * stash once the account is reachable again.
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

const CANONICAL_OWNER = '44444444-4444-4444-8444-444444444444';

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => ({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'token',
    canonicalAppUserId: '44444444-4444-4444-8444-444444444444',
    provider: 'apple',
  }),
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

const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function pendingRaw(): string | null {
  const raw = mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
  return raw ? raw : null;
}

beforeEach(() => {
  mockKvTable.clear();
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  setActiveDataOwner(CANONICAL_OWNER);
});

describe('appStore.hydrate — canonical profile fetch failure', () => {
  it('keeps the pre-auth stash and reports hydrateError instead of re-asking the questionnaire', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    mockFetchCanonical.mockRejectedValue(new Error('offline'));

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(CANONICAL_OWNER);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    // The stash is untouched — still exactly what was answered — and it is
    // the only device-level onboarding row (there is no "device onboarded"
    // marker any more; the launch gate never consults device history).
    expect(JSON.parse(pendingRaw() ?? '')).toEqual({
      version: 1,
      profile: answers,
    });
    expect([...mockKvTable.keys()]).toEqual([
      PENDING_ONBOARDING_PROFILE_KV_KEY,
    ]);
    expect(state).not.toHaveProperty('preAuthOnboarded');
  });

  it('reports hydrateError for a returning account too, so the server profile is never overwritten by a re-answer', async () => {
    mockFetchCanonical.mockRejectedValue(new Error('timeout'));

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
  });

  it('retry adopts the stash once the account is reachable and clears hydrateError', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    mockFetchCanonical.mockRejectedValueOnce(new Error('offline'));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).toBe(
      CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    );

    mockFetchCanonical.mockResolvedValue(null);
    mockSaveCanonical.mockImplementation(async (_session, profile) => ({
      ...profile,
      focusCheckpoint: 'contact_position',
    }));
    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrateError).toBeNull();
    expect(state.profile).toEqual({
      ...answers,
      focusCheckpoint: 'contact_position',
    });
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(pendingRaw()).toBeNull();
  });

  it('clears hydrateError while a new hydrate is in flight', async () => {
    mockFetchCanonical.mockRejectedValueOnce(new Error('offline'));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).not.toBeNull();

    let release!: (value: Profile | null) => void;
    mockFetchCanonical.mockImplementation(
      () => new Promise<Profile | null>(resolve => (release = resolve)),
    );
    const pending = useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrated).toBe(false);
    expect(useAppStore.getState().hydrateError).toBeNull();
    while (mockFetchCanonical.mock.calls.length < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    expect(useAppStore.getState().hydrated).toBe(false);
    release(answers);
    await pending;
    expect(useAppStore.getState().profile).toEqual(answers);
  });
});
