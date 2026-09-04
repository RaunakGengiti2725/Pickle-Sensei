import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Adjudication repros for area `mobile-launch-onboarding` @ 4d812e1a.
 *
 * Each `it` states the CONTRACT (the behaviour a fix must deliver). Every
 * one of them FAILS on 4d812e1a — that failure is the independent
 * reproduction of the auditor finding named in the describe title. They
 * are audit-only and must not be weakened; they become green when the
 * corresponding finding is fixed.
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

    await useAppStore.getState().hydrate();

    expect(mockSaveCanonical).not.toHaveBeenCalled();
    // Contract: a canonical owner saves through /v1/me/onboarding FIRST.
    // Without a bearer the stash must wait for the next hydrate.
    expect(pendingRaw()).not.toBeNull();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
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
    const localRow = mockKvTable.get(profileKey(CANONICAL_OWNER));
    const localOnlyCompletion =
      localRow !== undefined && afterSave.profile !== null;
    expect(localOnlyCompletion).toBe(false);

    // Bearer lands; the next hydrate must consult the server profile.
    mockApiSession = apiSession;
    mockFetchCanonical.mockResolvedValue(serverProfile);
    await useAppStore.getState().hydrate();
    expect(mockFetchCanonical).toHaveBeenCalled();
    expect(useAppStore.getState().profile).toEqual(serverProfile);
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
      const { profile, hydrated } = useAppStore.getState();
      expect(hydrated).toBe(true);
      expect(profile === null || isWellFormedProfile(profile)).toBe(true);
    },
  );

  it('canonical owner: a malformed local row does not shadow the server profile', async () => {
    mockKvTable.set(profileKey(CANONICAL_OWNER), '{}');
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockFetchCanonical.mockResolvedValue(serverProfile);

    await useAppStore.getState().hydrate();

    expect(mockFetchCanonical).toHaveBeenCalled();
    expect(useAppStore.getState().profile).toEqual(serverProfile);
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
    expect(mockFetchCanonical).toHaveBeenCalled();
    expect(state.profile).toEqual(serverProfile);
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
  });

  it('a SQLite read failure surfaces curated copy rather than the driver message', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockReadFailure = new Error('SQLITE_IOERR: disk I/O error');
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.hydrateError).not.toBe('SQLITE_IOERR: disk I/O error');
  });
});

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

    // 2. Gate shows the in-account questionnaire; the user re-answers
    //    DIFFERENTLY and this save succeeds.
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

    // 3. Next launch: the newest intent is `reAnswered`, not the stale stash.
    mockFetchCanonical.mockResolvedValue(reAnswered);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(reAnswered);
    expect(mockSaveCanonical).not.toHaveBeenCalledWith(apiSession, stashed);
  });

  it('completeOnboarding supersedes the pending stash (single-use, newest intent wins)', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockSaveCanonical.mockRejectedValueOnce(new Error('offline'));
    await useAppStore.getState().hydrate();

    await useAppStore.getState().completeOnboarding(serverProfile);
    expect(useAppStore.getState().profile).toEqual(serverProfile);
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
    expect(state.profile).toBeNull();
    expect(pendingRaw()).not.toBeNull();
    // Gate: `!profile && hydrateError` → ErrorState with Retry;
    // `!profile && !hydrateError` → in-account questionnaire (answers discarded from the user's view).
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
  });
});

describe('ADJ-E — two overlapping hydrate() calls for the same canonical owner with a stash', () => {
  it('PUT the stash to /v1/me/onboarding exactly once', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockSaveCanonical.mockImplementation(async (_s, profile) => {
      await gate;
      return profile;
    });

    const first = useAppStore.getState().hydrate();
    const second = useAppStore.getState().hydrate();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(pendingRaw()).toBeNull();
  });
});

describe('ADJ-I — slow same-owner canonical fetch resolves after completeOnboarding', () => {
  it('a stale null fetch landing after the owner completed onboarding must not clear the profile', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    let resolveFetch!: (value: Profile | null) => void;
    mockFetchCanonical.mockImplementation(
      () =>
        new Promise<Profile | null>(resolve => {
          resolveFetch = resolve;
        }),
    );

    const slowHydrate = useAppStore.getState().hydrate();
    await Promise.resolve();
    await useAppStore.getState().completeOnboarding(serverProfile);
    expect(useAppStore.getState().profile).toEqual(serverProfile);

    resolveFetch(null);
    await slowHydrate;

    expect(useAppStore.getState().profile).toEqual(serverProfile);
  });
});
