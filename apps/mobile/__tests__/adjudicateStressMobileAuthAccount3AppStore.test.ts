import type { Profile } from '../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';

/**
 * Adjudication reproductions for stress area mobile-auth-account-3
 * (appStore hydrate / pre-auth stash adoption / persisted profile rows),
 * baseline 1fb0efd7f3157060af4c61342f5102e068d2ddc5.
 *
 *   cd apps/mobile && npx jest --ci __tests__/adjudicateStressMobileAuthAccount3AppStore.test.ts
 *
 * `hazard` blocks pin the defective behaviour observed on the baseline so the
 * trap stays documented; `test.failing` blocks assert the product contract
 * and are the acceptance tests — a fix promotes them to plain `test` and the
 * matching `hazard` block is removed.
 */

const mockKvTable = new Map<string, string>();
/** kv keys whose INSERT OR REPLACE throws (SQLITE_FULL-style write fault). */
const mockWriteFaults = new Set<string>();

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        if (mockWriteFaults.has(key)) {
          throw new Error('database or disk is full (code 13 SQLITE_FULL)');
        }
        mockKvTable.set(key, String(params[1]));
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
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../src/state/appStore';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const stashed: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

const newer: Profile = {
  skillLevel: '4.0',
  handedness: 'left',
  goal: 'serve',
  biggestProblem: 'power',
  focusCheckpoint: 'sequencing',
};

const profileKey = (owner: string) => `profile:${owner}`;
const pendingRaw = () =>
  mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY) || null;
const stash = (profile: Profile = stashed) =>
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );
const signIn = (id: string) => {
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `bearer-${id}`,
    canonicalAppUserId: id,
    provider: 'apple',
  };
  setActiveDataOwner(canonicalDataOwner(id));
};
const store = () => useAppStore.getState();

beforeEach(() => {
  mockKvTable.clear();
  mockWriteFaults.clear();
  mockApiSession = null;
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockReset();
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

describe('A. failed stash adoption is swallowed and the stash later resurrects', () => {
  async function failedAdoption() {
    stash();
    signIn(USER_A);
    mockSaveCanonical.mockRejectedValueOnce(new Error('503 upstream'));
    await store().hydrate();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(pendingRaw()).not.toBeNull(); // stash kept (by design)
  }

  test('hazard: the failed save lands on the questionnaire with no error', async () => {
    await failedAdoption();
    expect(store().hydrated).toBe(true);
    expect(store().profile).toBeNull();
    expect(store().hydrateError).toBeNull();
  });

  test.failing(
    'expected: a failed stash save is surfaced (retry state), not a silent questionnaire',
    async () => {
      await failedAdoption();
      expect(store().hydrateError).not.toBeNull();
    },
  );

  test('hazard: in-account completeOnboarding leaves the stale stash live and the next hydrate re-adopts it over the newer answers', async () => {
    await failedAdoption();
    await store().completeOnboarding(newer);
    expect(store().profile).toEqual(newer);
    expect(mockKvTable.get(profileKey(canonicalDataOwner(USER_A)))).toBe(
      JSON.stringify(newer),
    );
    expect(pendingRaw()).not.toBeNull();

    // App relaunch / owner re-hydrate for the SAME account.
    await store().hydrate();
    expect(mockSaveCanonical).toHaveBeenLastCalledWith(
      expect.anything(),
      stashed,
    );
    expect(store().profile).toEqual(stashed);
    expect(mockKvTable.get(profileKey(canonicalDataOwner(USER_A)))).toBe(
      JSON.stringify(stashed),
    );
    expect(pendingRaw()).toBeNull();
  });

  test.failing(
    'expected: completing onboarding in the signed-in account retires the pre-auth stash',
    async () => {
      await failedAdoption();
      await store().completeOnboarding(newer);
      expect(pendingRaw()).toBeNull();
    },
  );

  test.failing(
    'expected: the newest answers survive a later hydrate of the same account',
    async () => {
      await failedAdoption();
      await store().completeOnboarding(newer);
      await store().hydrate();
      expect(store().profile).toEqual(newer);
    },
  );

  test('hazard: a permanent 4xx rejection is retried on every hydrate and never surfaced', async () => {
    stash();
    signIn(USER_A);
    mockSaveCanonical.mockRejectedValue(new Error('400 invalid identity'));
    for (let launch = 0; launch < 3; launch += 1) {
      await store().hydrate();
      expect(store().hydrateError).toBeNull();
      expect(store().profile).toBeNull();
    }
    expect(mockSaveCanonical).toHaveBeenCalledTimes(3);
    expect(pendingRaw()).not.toBeNull();
  });
});

describe('B. stash adoption is not atomic: server accepted, local write failed', () => {
  async function adoptWithLocalWriteFault() {
    stash();
    signIn(USER_A);
    mockWriteFaults.add(profileKey(canonicalDataOwner(USER_A)));
    await store().hydrate();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
  }

  test('hazard: an unpersisted profile is published and the consumed stash stays live', async () => {
    await adoptWithLocalWriteFault();
    expect(store().profile).toEqual(stashed);
    expect(store().hydrateError).toBeNull();
    expect(mockKvTable.has(profileKey(canonicalDataOwner(USER_A)))).toBe(false);
    expect(pendingRaw()).not.toBeNull();
  });

  test("hazard: the next account on the device adopts the first account's answers into its own server profile", async () => {
    await adoptWithLocalWriteFault();
    mockWriteFaults.clear();
    signIn(USER_B);
    await store().hydrate();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(2);
    expect(mockSaveCanonical.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ canonicalAppUserId: USER_B }),
    );
    expect(mockSaveCanonical.mock.calls[1]![1]).toEqual(stashed);
    expect(store().profile).toEqual(stashed);
  });

  test.failing(
    'expected: once the server accepted the stash for account A it is never saved into account B',
    async () => {
      await adoptWithLocalWriteFault();
      mockWriteFaults.clear();
      signIn(USER_B);
      await store().hydrate();
      expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    },
  );

  test.failing(
    'expected: memory never reports a profile the device did not persist',
    async () => {
      await adoptWithLocalWriteFault();
      const persisted = mockKvTable.get(profileKey(canonicalDataOwner(USER_A)));
      expect(store().profile === null || persisted !== undefined).toBe(true);
    },
  );
});

describe('C. canonical owner hydrates before its ApiSession exists (offline / slow launch restore)', () => {
  function restoreOffline(id: string) {
    // authStore.restorePersistedSession sets the owner synchronously; the
    // ApiSession is only installed when the launch refresh lands.
    mockApiSession = null;
    setActiveDataOwner(canonicalDataOwner(id));
  }

  test('hazard: the stash is consumed locally and never reaches the server', async () => {
    stash();
    restoreOffline(USER_A);
    await store().hydrate();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(pendingRaw()).toBeNull();
    expect(store().profile).toEqual(stashed);
  });

  test.failing(
    'expected: a synced account only retires the stash through the canonical save',
    async () => {
      stash();
      restoreOffline(USER_A);
      await store().hydrate();
      expect(pendingRaw() === null).toBe(
        mockSaveCanonical.mock.calls.length > 0,
      );
    },
  );

  test('hazard: an onboarded account with no local row lands on the questionnaire instead of a retry state', async () => {
    restoreOffline(USER_A);
    await store().hydrate();
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(store().profile).toBeNull();
    expect(store().hydrateError).toBeNull();
  });

  test.failing(
    'expected: no local row and no reachable server is a retry state, not a fresh questionnaire',
    async () => {
      restoreOffline(USER_A);
      await store().hydrate();
      expect(store().hydrateError).not.toBeNull();
    },
  );
});

describe('D. persisted profile rows are installed without validation', () => {
  test('hazard: a non-Profile JSON row is published as the profile (main app renders)', async () => {
    mockKvTable.set(
      profileKey(canonicalDataOwner(USER_A)),
      '{"hello":"world"}',
    );
    signIn(USER_A);
    await store().hydrate();
    expect(store().hydrateError).toBeNull();
    expect(store().profile).toEqual({ hello: 'world' });
  });

  test.failing(
    'expected: a row that is not a Profile never becomes the profile',
    async () => {
      mockKvTable.set(
        profileKey(canonicalDataOwner(USER_A)),
        '{"hello":"world"}',
      );
      signIn(USER_A);
      await store().hydrate();
      const profile = store().profile;
      expect(
        profile === null || typeof profile.focusCheckpoint === 'string',
      ).toBe(true);
    },
  );

  test('hazard: a non-JSON row is a permanent error state — Retry re-reads the same row and the canonical copy is never consulted', async () => {
    mockKvTable.set(profileKey(canonicalDataOwner(USER_A)), 'not json {');
    signIn(USER_A);
    mockFetchCanonical.mockResolvedValue(newer);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store().hydrate();
      expect(store().profile).toBeNull();
      expect(store().hydrateError).toMatch(/JSON|token/i);
    }
    expect(mockFetchCanonical).not.toHaveBeenCalled();
  });

  test.failing(
    'expected: an unreadable local row is healed from the canonical copy instead of locking the account out',
    async () => {
      mockKvTable.set(profileKey(canonicalDataOwner(USER_A)), 'not json {');
      signIn(USER_A);
      mockFetchCanonical.mockResolvedValue(newer);
      await store().hydrate();
      expect(store().profile).toEqual(newer);
    },
  );

  test.failing(
    'expected: raw parser text never becomes user-facing error copy',
    async () => {
      mockKvTable.set(profileKey(canonicalDataOwner(USER_A)), 'not json {');
      signIn(USER_A);
      await store().hydrate();
      expect(store().hydrateError ?? '').not.toMatch(/JSON|token/i);
    },
  );

  test('hazard: a rejected legacy guest row is copied to the owner key before it is parsed', async () => {
    mockKvTable.set('profile', 'not json {');
    setActiveDataOwner(GUEST_DATA_OWNER);
    await store().hydrate();
    expect(store().hydrateError).not.toBeNull();
    expect(mockKvTable.get(profileKey(GUEST_DATA_OWNER))).toBe('not json {');
    expect(mockKvTable.get('profile')).toBe('');
  });

  test.failing(
    'expected: bytes the parser rejects are never written under the owner key',
    async () => {
      mockKvTable.set('profile', 'not json {');
      setActiveDataOwner(GUEST_DATA_OWNER);
      await store().hydrate();
      expect(mockKvTable.get(profileKey(GUEST_DATA_OWNER))).not.toBe(
        'not json {',
      );
    },
  );
});
