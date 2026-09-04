import type { Profile } from '../../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

/**
 * Execution audit — appStore.hydrate() under stale / missing / corrupt data
 * and under the vault-restore launch window (session restored from the
 * Keychain, refresh still in flight, so `getApiSession()` is null while the
 * data owner is already canonical — authStore.restorePersistedSession()
 * resolves 'offline' after LAUNCH_REFRESH_WAIT_MS and hydrate() proceeds).
 *
 * `it.failing` cases pin CURRENT behaviour that the audit classifies as a
 * defect: they pass only while the defect is present, so a fix flips them red
 * and the assertion inside is the intended behaviour to keep.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/audit/launch-onboarding
 */

const mockKvTable = new Map<string, string>();
const mockKvWrites: Array<[string, string]> = [];

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        mockKvWrites.push([String(params[0]), String(params[1])]);
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

type MockSession = {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
};
let mockApiSession: MockSession | null = null;

jest.mock('../../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>(
  async (_session, profile) => profile,
);

jest.mock('../../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../../src/state/appStore';

const CANONICAL_OWNER = '44444444-4444-4444-8444-444444444444';
const session: MockSession = {
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
const stash = (profile: Profile = answers) =>
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );

beforeEach(() => {
  mockKvTable.clear();
  mockKvWrites.length = 0;
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

describe('vault-restore window: canonical owner, api session not yet established', () => {
  it.failing(
    'FINDING: a pre-auth stash is adopted LOCALLY and cleared, so the answers never reach /v1/me/onboarding — even after the bearer lands and hydrate runs again',
    async () => {
      stash();
      setActiveDataOwner(CANONICAL_OWNER);
      mockApiSession = null; // refresh still in flight / launch proceeded 'offline'

      await useAppStore.getState().hydrate();
      const afterOffline = useAppStore.getState();
      expect(afterOffline.hydrated).toBe(true);
      // Current behaviour (the defect): adopted without a server save and the
      // single-use stash is consumed.
      expect(afterOffline.profile).toEqual(answers);
      expect(mockSaveCanonical).not.toHaveBeenCalled();
      expect(pendingRaw()).toBeNull();

      // The keeper adopts the tokens later; a subsequent hydrate (e.g. owner
      // re-mount) sees a local profile and never syncs it either.
      mockApiSession = session;
      await useAppStore.getState().hydrate();
      expect(mockFetchCanonical).not.toHaveBeenCalled();

      // Intended invariant (AGENTS.md: canonical accounts save through
      // /v1/me/onboarding first; a failed save keeps the stash for retry).
      expect(mockSaveCanonical).toHaveBeenCalled();
    },
  );

  it.failing(
    'FINDING: no local profile + server profile exists → hydrate ends with profile=null and NO hydrateError, which the Gate renders as the in-account questionnaire',
    async () => {
      setActiveDataOwner(CANONICAL_OWNER);
      mockApiSession = null;
      mockFetchCanonical.mockResolvedValue(serverProfile);

      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.profile).toBeNull();
      expect(state.hydrateError).toBeNull();
      expect(mockFetchCanonical).not.toHaveBeenCalled();

      // Intended: either a retryable hydrateError (Gate shows ErrorState) or
      // a deferred fetch once the session lands — not a re-ask of a user who
      // already completed onboarding on the server.
      expect(state.hydrateError).not.toBeNull();
    },
  );

  it('completeOnboarding in the same window saves locally only and does not surface an error', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = null;
    await useAppStore.getState().completeOnboarding(answers);
    const state = useAppStore.getState();
    expect(state.profile).toEqual(answers);
    expect(state.onboardingError).toBeNull();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual(
      answers,
    );
  });
});

describe('corrupt owner profile row', () => {
  it.failing(
    'FINDING: a non-JSON profile row surfaces the raw JSON.parse message as hydrateError and retry cannot recover (server copy never consulted)',
    async () => {
      mockKvTable.set(profileKey(CANONICAL_OWNER), 'not json {');
      setActiveDataOwner(CANONICAL_OWNER);
      mockApiSession = session;
      mockFetchCanonical.mockResolvedValue(serverProfile);

      await useAppStore.getState().hydrate();
      const first = useAppStore.getState();
      expect(first.hydrated).toBe(true);
      expect(first.profile).toBeNull();
      expect(first.hydrateError).toMatch(/JSON/);
      expect(mockFetchCanonical).not.toHaveBeenCalled();

      // Gate's "Try again" re-runs hydrate(): identical outcome, forever.
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().hydrateError).toMatch(/JSON/);

      // Intended: fall back to the canonical copy (or treat the row as
      // missing) instead of a permanent, engineer-worded error.
      expect(useAppStore.getState().profile).toEqual(serverProfile);
    },
  );

  it.failing(
    'FINDING: a well-formed but shapeless profile row ({} / wrong types) is accepted as a complete profile',
    async () => {
      mockKvTable.set(profileKey(GUEST_DATA_OWNER), '{}');
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.hydrateError).toBeNull();
      expect(state.profile).toEqual({});
      // Intended: the same required-key check parsePendingProfile applies to
      // the stash should guard the owner row (RootNavigator renders on
      // `Boolean(profile)`).
      expect(state.profile).toBeNull();
    },
  );

  it('an empty-string profile row is treated as "no profile" (fetches canonical)', async () => {
    mockKvTable.set(profileKey(CANONICAL_OWNER), '');
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = session;
    mockFetchCanonical.mockResolvedValue(serverProfile);
    await useAppStore.getState().hydrate();
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(useAppStore.getState().hydrateError).toBeNull();
  });
});

describe('corrupt / stale pre-auth stash variants', () => {
  const corrupt: Array<[string, string]> = [
    ['non-JSON', 'garbage'],
    ['JSON array', '[1,2]'],
    ['JSON null', 'null'],
    ['profile is array', '{"version":1,"profile":[]}'],
    ['profile is string', '{"version":1,"profile":"x"}'],
    [
      'missing focusCheckpoint',
      '{"version":1,"profile":{"skillLevel":"3.5","handedness":"right","goal":"drops","biggestProblem":"control"}}',
    ],
    [
      'numeric skillLevel',
      '{"version":1,"profile":{"skillLevel":3.5,"handedness":"right","goal":"drops","biggestProblem":"control","focusCheckpoint":"paddle_set"}}',
    ],
  ];

  it.each(corrupt)(
    'ignores a %s stash, writes nothing for the owner, and leaves the corrupt row in place (never garbage-collected)',
    async (_label, raw) => {
      mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, raw);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.profile).toBeNull();
      expect(state.hydrateError).toBeNull();
      expect(mockKvTable.get(profileKey(GUEST_DATA_OWNER))).toBeUndefined();
      expect(mockKvWrites).toHaveLength(0);
      // Observation (not asserted as a defect): the unparseable row persists.
      expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(raw);
    },
  );

  it('a stash with unknown extra fields and a future version is still adopted (forward-compatible)', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({
        version: 9,
        extra: true,
        profile: { ...answers, unknownField: 1 },
      }),
    );
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toMatchObject(answers);
    expect(pendingRaw()).toBeNull();
  });

  it('stale stash surviving a successful in-account save overrides the newer in-account answers on the next hydrate (canonical, online)', async () => {
    // Sequence: stash → sign in → save fails (stash kept) → user re-answers in
    // account mode → completeOnboarding succeeds → relaunch hydrate.
    stash(answers);
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = session;
    mockSaveCanonical.mockRejectedValueOnce(new Error('offline'));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(pendingRaw()).not.toBeNull();

    const reanswered: Profile = {
      ...answers,
      goal: 'serve',
      focusCheckpoint: 'sequencing',
    };
    await useAppStore.getState().completeOnboarding(reanswered);
    expect(useAppStore.getState().profile).toEqual(reanswered);
    expect(pendingRaw()).not.toBeNull();

    await useAppStore.getState().hydrate();
    // Documented "newest intent wins" — but the stash is the OLDER intent here.
    expect(mockSaveCanonical).toHaveBeenLastCalledWith(session, answers);
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(pendingRaw()).toBeNull();
  });
});

describe('legacy guest profile migration (uncovered by the subsystem suites)', () => {
  it('moves the legacy `profile` row into the guest bucket and blanks the legacy key', async () => {
    mockKvTable.set('profile', JSON.stringify(serverProfile));
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(mockKvTable.get(profileKey(GUEST_DATA_OWNER))).toBe(
      JSON.stringify(serverProfile),
    );
    expect(mockKvTable.get('profile')).toBe('');
  });

  it('does not migrate the legacy row for canonical owners', async () => {
    mockKvTable.set('profile', JSON.stringify(serverProfile));
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = session;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
    expect(mockKvTable.get('profile')).toBe(JSON.stringify(serverProfile));
  });
});

describe('owner changes mid-hydrate (stale async results)', () => {
  it('a slow canonical fetch that lands after sign-out does not write into the signed-out state', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = session;
    let release!: (p: Profile | null) => void;
    const fetchStarted = new Promise<void>(started => {
      mockFetchCanonical.mockImplementation(
        () =>
          new Promise<Profile | null>(resolve => {
            release = resolve;
            started();
          }),
      );
    });
    const hydration = useAppStore.getState().hydrate();
    await fetchStarted;
    expect(useAppStore.getState().hydrated).toBe(false);

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    release(serverProfile);
    await hydration;

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(false);
    expect(state.profile).toBeNull();
    // The stale canonical copy IS still persisted under its own owner key,
    // which is correct (owner-scoped) but noted: it happens after sign-out.
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBe(
      JSON.stringify(serverProfile),
    );
  });

  it('a slow canonical fetch that FAILS after sign-out leaves the signed-out state untouched', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = session;
    let reject!: (e: Error) => void;
    const fetchStarted = new Promise<void>(started => {
      mockFetchCanonical.mockImplementation(
        () =>
          new Promise<Profile | null>((_r, rej) => {
            reject = rej;
            started();
          }),
      );
    });
    const hydration = useAppStore.getState().hydrate();
    await fetchStarted;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    reject(new Error('network'));
    await hydration;
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(useAppStore.getState().hydrated).toBe(false);
  });

  it('a stash is NOT adopted when the owner changed while the profile row was loading', async () => {
    stash();
    setActiveDataOwner(GUEST_DATA_OWNER);
    // First kv read resolves after an owner switch.
    const originalGet = mockKvTable.get.bind(mockKvTable);
    let switched = false;
    jest.spyOn(mockKvTable, 'get').mockImplementation((key: string) => {
      if (!switched && key === PENDING_ONBOARDING_PROFILE_KV_KEY) {
        switched = true;
        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      }
      return originalGet(key);
    });
    await useAppStore.getState().hydrate();
    jest.restoreAllMocks();
    expect(pendingRaw()).not.toBeNull();
    expect(mockKvTable.get(profileKey(GUEST_DATA_OWNER))).toBeUndefined();
    expect(useAppStore.getState().hydrated).toBe(false);
  });
});

describe('db failures', () => {
  it('a throwing kv read during hydrate becomes a retryable hydrateError (message = raw error text)', async () => {
    jest.spyOn(mockKvTable, 'get').mockImplementation(() => {
      throw new Error('database disk image is malformed');
    });
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    jest.restoreAllMocks();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    // Observation: SQLite's error text is what App.tsx renders as `detail`.
    expect(state.hydrateError).toBe('database disk image is malformed');
  });

  it('completePreAuthOnboarding reports a failed stash write and returns false (screen stays put)', async () => {
    jest.spyOn(mockKvTable, 'set').mockImplementation(() => {
      throw new Error('SQLITE_FULL');
    });
    const ok = await useAppStore.getState().completePreAuthOnboarding(answers);
    jest.restoreAllMocks();
    expect(ok).toBe(false);
    const state = useAppStore.getState();
    expect(state.onboardingBusy).toBe(false);
    expect(state.onboardingError).toBe('SQLITE_FULL');
  });
});
