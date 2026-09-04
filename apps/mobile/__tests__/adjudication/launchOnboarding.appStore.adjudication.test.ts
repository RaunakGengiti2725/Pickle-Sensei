import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Adjudication repros for area `mobile-launch-onboarding` @ 4d812e1a
 * (clusters ADJ-A, ADJ-B, ADJ-C).
 *
 * Each `it` states the CONTRACT (the behaviour a fix must deliver). Every
 * one of them FAILED on 4d812e1a — that failure is the independent
 * reproduction of the auditor finding named in the describe title. They
 * must not be weakened.
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

const REQUIRED_KEYS: readonly (keyof Profile)[] = [
  'skillLevel',
  'handedness',
  'goal',
  'biggestProblem',
  'focusCheckpoint',
];

function isWellFormedProfile(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return REQUIRED_KEYS.every(key => typeof record[key] === 'string');
}

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

describe('ADJ-A — canonical owner hydrates while getApiSession() is null (restore deferred/offline, ≤8s launch wait elapsed)', () => {
  it('keeps the pre-auth stash instead of adopting it locally without the canonical PUT', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = null;

    const stashBefore = pendingRaw();

    await useAppStore.getState().hydrate();

    expect(mockSaveCanonical).not.toHaveBeenCalled();
    // Contract: a canonical owner saves through /v1/me/onboarding FIRST.
    // Without a bearer the stash must wait for the next hydrate.
    expect(pendingRaw()).toBe(stashBefore);
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
    // The answers are on disk and the account could not be consulted: the
    // Gate shows the retryable account state, not the questionnaire again.
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
  });

  it('a later hydrate WITH a bearer still PUTs the stashed answers', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = null;
    await useAppStore.getState().hydrate();

    mockApiSession = apiSession;
    await useAppStore.getState().hydrate();

    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(mockSaveCanonical).toHaveBeenCalledWith(apiSession, stashed);
    // Single-use: the stash is cleared once the canonical PUT succeeded.
    expect(pendingRaw()).toBeNull();
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual(
      stashed,
    );
    expect(useAppStore.getState().profile).toEqual(stashed);
  });

  it('completeOnboarding for a canonical owner without a bearer does not mint a local-only profile that shadows /v1/me forever', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = null;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();

    await useAppStore.getState().completeOnboarding(stashed);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    // Contract: PUT or a typed retryable error — never a silent local write.
    const afterSave = useAppStore.getState();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
    expect(afterSave.profile).toBeNull();
    expect(afterSave.onboardingBusy).toBe(false);
    // Typed, retryable, user-facing copy — never raw Error text.
    expect(typeof afterSave.onboardingError).toBe('string');
    expect(afterSave.onboardingError!.length).toBeGreaterThan(0);
    expect(afterSave.onboardingError).not.toMatch(
      /Error|undefined|null|JSON|Unexpected token|SQLITE/,
    );

    // Bearer lands; the next hydrate must consult the server profile.
    mockApiSession = apiSession;
    mockFetchCanonical.mockResolvedValue(serverProfile);
    await useAppStore.getState().hydrate();
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(useAppStore.getState().onboardingError).toBeNull();
  });
});

describe('ADJ-B — stored profile row is JSON but not a Profile (appStore.hydrate `JSON.parse(raw) as Profile`)', () => {
  const badRows: [string, string][] = [
    ['empty object', '{}'],
    ['array', '[]'],
    ['string literal', '"hello"'],
    ['number literal', '1'],
    ['boolean literal', 'true'],
    ['partial object', '{"skillLevel":"3.0"}'],
    [
      'wrong field type',
      '{"skillLevel":3,"handedness":"right","goal":"drops","biggestProblem":"control","focusCheckpoint":"paddle_set"}',
    ],
  ];

  it.each(badRows)(
    'guest owner: a %s row never becomes the live profile (Gate would mount RootNavigator on it)',
    async (_label, row) => {
      mockKvTable.set(profileKey(GUEST_DATA_OWNER), row);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      const { profile, hydrated, hydrateError } = useAppStore.getState();
      expect(hydrated).toBe(true);
      expect(profile === null || isWellFormedProfile(profile)).toBe(true);
      expect(hydrateError ?? '').not.toMatch(
        /JSON|Unexpected token|SyntaxError|SQLITE/i,
      );
    },
  );

  it('canonical owner: a malformed local row does not shadow the server profile', async () => {
    mockKvTable.set(profileKey(CANONICAL_OWNER), '{}');
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockFetchCanonical.mockResolvedValue(serverProfile);

    await useAppStore.getState().hydrate();

    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(useAppStore.getState().hydrateError).toBeNull();
    // The malformed row is replaced by the server profile as valid JSON.
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual(
      serverProfile,
    );
  });
});

describe('ADJ-C — stored profile row is not JSON (corrupt SQLite value)', () => {
  it('canonical owner: the corrupt row does not suppress the canonical fetch and hydrateError is product copy', async () => {
    mockKvTable.set(profileKey(CANONICAL_OWNER), 'not json{');
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockFetchCanonical.mockResolvedValue(serverProfile);

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrateError ?? '').not.toMatch(
      /JSON|Unexpected token|SyntaxError/i,
    );
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(state.profile).toEqual(serverProfile);
    expect(state.hydrateError).toBeNull();
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual(
      serverProfile,
    );
  });

  it('guest owner: Retry (second hydrate) does not loop on the identical parser error forever', async () => {
    mockKvTable.set(profileKey(GUEST_DATA_OWNER), 'not json{');
    setActiveDataOwner(GUEST_DATA_OWNER);

    await useAppStore.getState().hydrate();
    const first = useAppStore.getState();
    expect(first.hydrated).toBe(true);
    expect(first.profile).toBeNull();

    await useAppStore.getState().hydrate();
    const second = useAppStore.getState();
    // Either the row was repaired (questionnaire offered, no error) or the
    // error is curated copy — never the same raw JS parser text twice.
    const stillRawParserError =
      typeof second.hydrateError === 'string' &&
      /JSON|Unexpected token|SyntaxError/i.test(second.hydrateError) &&
      second.hydrateError === first.hydrateError;
    expect(stillRawParserError).toBe(false);
    expect(second.hydrated).toBe(true);
    const converged =
      (second.profile === null && second.hydrateError === null) ||
      (typeof second.hydrateError === 'string' &&
        second.hydrateError.length > 0 &&
        !/JSON|Unexpected token|SyntaxError|SQLITE/i.test(second.hydrateError));
    expect(converged).toBe(true);
  });

  it('a SQLite read failure surfaces curated copy rather than the driver message', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockReadFailure = new Error('SQLITE_IOERR: disk I/O error');
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).not.toBe('SQLITE_IOERR: disk I/O error');
    expect(typeof state.hydrateError).toBe('string');
    expect(state.hydrateError!.length).toBeGreaterThan(0);
    expect(state.hydrateError).not.toMatch(
      /JSON|Unexpected token|SyntaxError|SQLITE|disk I\/O/i,
    );
  });
});
