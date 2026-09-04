import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Structural audit #2 (mobile-launch-onboarding) — appStore.hydrate() row
 * handling. Each `it` encodes the behaviour the launch-flow contract implies
 * (AGENTS.md "Launch flow", the Gate ErrorState in App.tsx); a failing case is
 * a reproduced defect on the audited commit, not a pinned invariant.
 */

const mockKvTable = new Map<string, string>();
let mockKvReadFailure: Error | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockKvReadFailure) throw mockKvReadFailure;
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

const CANONICAL_OWNER = '66666666-6666-4666-8666-666666666666';
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
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { profileKeyForOwner } from '../../src/data/accountScope';

const serverProfile: Profile = {
  firstName: 'Sam',
  gender: 'male',
  skillLevel: '4.0',
  handedness: 'right',
  goal: 'serve',
  biggestProblem: 'consistency',
  focusCheckpoint: 'sequencing',
};

const stashAnswers: Profile = {
  skillLevel: '3.0',
  handedness: 'left',
  goal: 'dinks',
  biggestProblem: 'control',
  focusCheckpoint: 'contact_position',
};

function signInCanonical() {
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'token',
    canonicalAppUserId: CANONICAL_OWNER,
    provider: 'apple',
  };
  setActiveDataOwner(CANONICAL_OWNER);
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvReadFailure = null;
  mockApiSession = null;
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(null);
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
});

describe('PROBE b — stored profile row shape', () => {
  it('an empty-object profile row must not hydrate as a complete profile', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockKvTable.set(profileKeyForOwner(GUEST_DATA_OWNER), '{}');

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    // Either null (→ in-account questionnaire) or a fully shaped profile is
    // acceptable; a truthy object with no required fields sends the Gate
    // into RootNavigator with profile.focusCheckpoint === undefined.
    if (state.profile !== null) {
      expect(typeof state.profile.focusCheckpoint).toBe('string');
      expect(typeof state.profile.handedness).toBe('string');
      expect(typeof state.profile.goal).toBe('string');
    }
  });

  it('an array profile row must not hydrate as a complete profile', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockKvTable.set(profileKeyForOwner(GUEST_DATA_OWNER), '[]');

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(Array.isArray(state.profile)).toBe(false);
  });
});

describe('PROBE a — corrupt (non-JSON) profile row', () => {
  it('a corrupt local row for a canonical owner must not shadow a good server profile', async () => {
    signInCanonical();
    mockKvTable.set(profileKeyForOwner(CANONICAL_OWNER), '{not json');
    mockFetchCanonical.mockResolvedValue(serverProfile);

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    // The server holds a complete profile for this account; the local cache
    // is the only thing that is broken.
    expect(mockFetchCanonical).toHaveBeenCalled();
    expect(state.profile).toEqual(serverProfile);
    expect(state.hydrateError).toBeNull();
  });

  it('Retry after a corrupt row must eventually recover (row repaired or refetched), not loop on the same error', async () => {
    signInCanonical();
    mockKvTable.set(profileKeyForOwner(CANONICAL_OWNER), '{not json');
    mockFetchCanonical.mockResolvedValue(serverProfile);

    await useAppStore.getState().hydrate();
    const first = useAppStore.getState().hydrateError;
    await useAppStore.getState().hydrate();
    const second = useAppStore.getState();

    // Two consecutive hydrates with a reachable server: the second one must
    // not fail identically to the first (that is the permanent dead end).
    expect(second.profile !== null || second.hydrateError !== first).toBe(true);
  });

  it('hydrateError for a corrupt row must be user-facing copy, not raw JS parser text', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockKvTable.set(profileKeyForOwner(GUEST_DATA_OWNER), '{not json');

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    if (state.hydrateError !== null) {
      expect(state.hydrateError).not.toMatch(/JSON|token|Unexpected|Expected/i);
    }
  });

  it('a SQLite read failure surfaces curated copy rather than the driver message', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockKvReadFailure = new Error(
      'SQLITE_IOERR: disk I/O error (code 10 SQLITE_IOERR)',
    );

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).not.toBeNull();
    expect(state.hydrateError).not.toMatch(/SQLITE/);
  });
});

describe('PROBE d — stash survives an in-account re-answer', () => {
  it('a re-answered in-account profile must not be replaced by an older pre-auth stash on the next hydrate', async () => {
    signInCanonical();
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: stashAnswers }),
    );
    // First launch after sign-in: the stash PUT fails (offline) — by contract
    // the stash is kept and the account has no profile yet.
    mockSaveCanonical.mockRejectedValueOnce(new Error('offline'));
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBeTruthy();

    // The Gate now shows the in-account questionnaire; the user answers it
    // again (newer intent) and the server accepts.
    const reAnswered: Profile = {
      ...serverProfile,
      skillLevel: '4.5',
      goal: 'volleys',
      focusCheckpoint: 'face_wrist_stability',
    };
    await useAppStore.getState().completeOnboarding(reAnswered);
    expect(useAppStore.getState().profile).toEqual(reAnswered);
    expect(useAppStore.getState().onboardingError).toBeNull();

    // Next launch, server reachable.
    mockSaveCanonical.mockImplementation(async (_s, profile) => profile);
    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.profile).toEqual(reAnswered);
    expect(
      mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY) || null,
    ).toBeNull();
  });
});

describe('PROBE c — stash parser accepts semantically invalid payloads', () => {
  it('a stash with an unknown checkpoint / handedness and non-string identity is not adopted verbatim', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({
        version: 1,
        profile: {
          firstName: 12345,
          gender: {},
          skillLevel: 'x'.repeat(5000),
          handedness: 'ambidextrous',
          goal: 'dinks',
          biggestProblem: 'control',
          focusCheckpoint: 'not_a_checkpoint',
        },
      }),
    );

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    if (state.profile !== null) {
      expect(state.profile.focusCheckpoint).not.toBe('not_a_checkpoint');
      expect(
        typeof state.profile.firstName === 'string' ||
          state.profile.firstName === undefined,
      ).toBe(true);
    }
  });

  it('a permanently rejected stash is discarded instead of being re-PUT on every launch forever', async () => {
    signInCanonical();
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: stashAnswers }),
    );
    // Server-side validation refuses this body every time (4xx).
    mockSaveCanonical.mockRejectedValue(new Error('400 Bad Request'));

    for (let launch = 0; launch < 5; launch += 1) {
      await useAppStore.getState().hydrate();
    }

    // After repeated deterministic refusals the stash should not still be
    // queued for another PUT.
    expect(mockSaveCanonical.mock.calls.length).toBeLessThan(5);
  });
});

describe('PROBE e — concurrent same-owner hydrates', () => {
  it('two overlapping hydrates for one canonical owner PUT the stash once', async () => {
    signInCanonical();
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: stashAnswers }),
    );
    let releaseFirst!: (profile: Profile) => void;
    mockSaveCanonical
      .mockImplementationOnce(
        (_s, profile) =>
          new Promise<Profile>(resolve => {
            releaseFirst = () => resolve(profile);
          }),
      )
      .mockImplementation(async (_s, profile) => profile);

    const a = useAppStore.getState().hydrate();
    const b = useAppStore.getState().hydrate();
    while (mockSaveCanonical.mock.calls.length < 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    releaseFirst(stashAnswers);
    await Promise.all([a, b]);

    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(stashAnswers);
    expect(useAppStore.getState().hydrateError).toBeNull();
  });
});

describe('verified — canonical fetch failure keeps the curated message', () => {
  it('uses CANONICAL_PROFILE_UNAVAILABLE_MESSAGE and keeps the stash', async () => {
    signInCanonical();
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: stashAnswers }),
    );
    mockFetchCanonical.mockRejectedValue(new Error('offline'));
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
    expect(state.profile).toBeNull();
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBeTruthy();
  });
});
