import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * ADVERSARIAL PASS (mobile-launch-onboarding, tester #2, pass 3).
 *
 * appStore.hydrate() is a multi-write, non-transactional sequence over the
 * device kv table. These attacks make ONE specific write fail and observe
 * what the following hydrates do with the half-applied state:
 *
 *   S1  the stash clear (`onboarding.pending-profile` = '') fails after a
 *       successful canonical PUT + owner write
 *   S2  the legacy migration's second write (`profile` = '') fails after the
 *       copy into `profile:device-guest` succeeded
 *   +   rapid concurrent hydrates, owner switch mid-flight, unicode / huge
 *       stash payloads, corrupt kv rows, and the stale-stash resurrection
 *       path that needs no kv fault at all.
 *
 * Every assertion below states the CURRENT behaviour of 4d812e1a; the ones
 * marked `// FINDING` document behaviour the tester classifies as broken
 * (see the pass report) — they still assert what the code does today so the
 * suite is green and the regression is pinned until production is fixed.
 */

const mockKvTable = new Map<string, string>();
type SetKvFault = (key: string, value: string) => Error | null;
let mockSetKvFault: SetKvFault = () => null;
let mockGetKvFault: (key: string) => Error | null = () => null;
const mockKvWrites: Array<{ key: string; value: string }> = [];

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const key = String(params[0]);
        const fault = mockGetKvFault(key);
        if (fault) throw fault;
        const value = mockKvTable.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        const value = String(params[1]);
        const fault = mockSetKvFault(key, value);
        if (fault) throw fault;
        mockKvWrites.push({ key, value });
        mockKvTable.set(key, value);
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

const CANONICAL_OWNER = '33333333-3333-4333-8333-333333333333';
const profileKey = (owner: string) => `profile:${owner}`;

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
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '4.5',
  handedness: 'left',
  goal: 'serve',
  biggestProblem: 'power',
  focusCheckpoint: 'sequencing',
};

const legacy: Profile = {
  skillLevel: '3.0',
  handedness: 'right',
  goal: 'dinks',
  biggestProblem: 'consistency',
  focusCheckpoint: 'contact_position',
};

function stash(profile: unknown) {
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );
}

function writesTo(key: string) {
  return mockKvWrites.filter(w => w.key === key);
}

function signInCanonical(bearer = 'bearer-1') {
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: bearer,
    canonicalAppUserId: CANONICAL_OWNER,
    provider: 'apple',
  };
  setActiveDataOwner(CANONICAL_OWNER);
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvWrites.length = 0;
  mockSetKvFault = () => null;
  mockGetKvFault = () => null;
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
  });
});

describe('S1 — stash clear fails after a successful canonical save', () => {
  it('first hydrate: the PUT and owner write succeed, the failed clear is swallowed, the app opens on the adopted profile with the stash still present', async () => {
    stash(stashed);
    signInCanonical();
    mockSaveCanonical.mockImplementation(async (_s, p) => ({
      ...p,
      focusCheckpoint: 'preparation',
    }));
    let clearAttempts = 0;
    mockSetKvFault = (key, value) => {
      if (key === PENDING_ONBOARDING_PROFILE_KV_KEY && value === '') {
        clearAttempts += 1;
        return new Error('database or disk is full (13)');
      }
      return null;
    };

    await useAppStore.getState().hydrate();

    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(clearAttempts).toBe(1);
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.hydrateError).toBeNull();
    expect(state.profile).toEqual({
      ...stashed,
      focusCheckpoint: 'preparation',
    });
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual({
      ...stashed,
      focusCheckpoint: 'preparation',
    });
    // The stash survived the failed clear.
    expect(
      JSON.parse(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
    ).toEqual({ version: 1, profile: stashed });
  });

  it('FINDING: the next hydrate re-adopts the un-cleared stash — the server PUT is duplicated and a NEWER profile saved in between is overwritten with the stale answers', async () => {
    stash(stashed);
    signInCanonical();
    mockSetKvFault = (key, value) =>
      key === PENDING_ONBOARDING_PROFILE_KV_KEY && value === ''
        ? new Error('database or disk is full (13)')
        : null;
    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    // Disk pressure is gone; the player (in-account) saves a newer profile.
    mockSetKvFault = () => null;
    await useAppStore.getState().completeOnboarding(newer);
    expect(useAppStore.getState().profile).toEqual(newer);
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual(
      newer,
    );
    expect(mockSaveCanonical).toHaveBeenCalledTimes(2);
    expect(mockSaveCanonical.mock.calls[1]?.[1]).toEqual(newer);
    // The server now holds `newer`.
    mockFetchCanonical.mockResolvedValue(newer);

    // Next launch.
    await useAppStore.getState().hydrate();

    // Observed on 4d812e1a: a THIRD PUT goes out carrying the stale stash…
    expect(mockSaveCanonical).toHaveBeenCalledTimes(3);
    expect(mockSaveCanonical.mock.calls[2]?.[1]).toEqual(stashed);
    // …and the newer profile is replaced locally by the stale answers.
    expect(useAppStore.getState().profile).toEqual(stashed);
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual(
      stashed,
    );
    // Only now is the stash cleared.
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
  });

  it('control: when the clear succeeds the next hydrate issues no PUT and keeps the newer profile', async () => {
    stash(stashed);
    signInCanonical();
    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    await useAppStore.getState().completeOnboarding(newer);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(2);
    mockFetchCanonical.mockResolvedValue(newer);

    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().profile).toEqual(newer);
  });
});

describe('S2 — legacy migration second write fails after the copy succeeded', () => {
  it('FINDING: the failed best-effort clear of the legacy row aborts the whole hydrate — the guest does NOT open on the legacy profile and the raw driver message becomes hydrateError', async () => {
    mockKvTable.set('profile', JSON.stringify(legacy));
    setActiveDataOwner(GUEST_DATA_OWNER);
    let clearAttempts = 0;
    mockSetKvFault = (key, value) => {
      if (key === 'profile' && value === '') {
        clearAttempts += 1;
        return new Error('SQLITE_BUSY: database is locked');
      }
      return null;
    };

    await useAppStore.getState().hydrate();

    // The copy landed…
    expect(JSON.parse(mockKvTable.get(profileKey(GUEST_DATA_OWNER))!)).toEqual(
      legacy,
    );
    expect(clearAttempts).toBe(1);
    // …but hydrate did not adopt it: error state instead of the app.
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toBe('SQLITE_BUSY: database is locked');
    // The legacy row is still there (never cleared).
    expect(mockKvTable.get('profile')).toBe(JSON.stringify(legacy));
  });

  it('a later hydrate reads profile:device-guest and never re-runs the migration, so a newer guest row is not overwritten by the legacy value', async () => {
    mockKvTable.set('profile', JSON.stringify(legacy));
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockSetKvFault = (key, value) =>
      key === 'profile' && value === ''
        ? new Error('SQLITE_BUSY: database is locked')
        : null;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();

    // Retry (Gate "Try again") with the lock gone: the copied row hydrates.
    mockSetKvFault = () => null;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(legacy);
    expect(useAppStore.getState().hydrateError).toBeNull();

    // The guest answers a newer questionnaire.
    await useAppStore.getState().completeOnboarding(newer);
    expect(JSON.parse(mockKvTable.get(profileKey(GUEST_DATA_OWNER))!)).toEqual(
      newer,
    );

    // Later hydrates: the un-cleared legacy row must not resurrect.
    mockKvWrites.length = 0;
    for (let i = 0; i < 3; i += 1) {
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toEqual(newer);
    }
    expect(writesTo(profileKey(GUEST_DATA_OWNER))).toHaveLength(0);
    // Residue: the legacy row lives on forever (never cleaned up again).
    expect(mockKvTable.get('profile')).toBe(JSON.stringify(legacy));
  });

  it('FINDING (residue): if the guest row is ever emptied again the stale legacy row resurrects as the profile', async () => {
    mockKvTable.set('profile', JSON.stringify(legacy));
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockSetKvFault = (key, value) =>
      key === 'profile' && value === ''
        ? new Error('SQLITE_BUSY: database is locked')
        : null;
    await useAppStore.getState().hydrate();
    mockSetKvFault = () => null;
    await useAppStore.getState().hydrate();
    await useAppStore.getState().completeOnboarding(newer);

    // Any code path that clears profile:device-guest (e.g. a future
    // "reset profile") re-triggers the migration from the stale row.
    mockKvTable.set(profileKey(GUEST_DATA_OWNER), '');
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(legacy);
  });
});

describe('extra — stale stash resurrection without any kv fault', () => {
  it('FINDING: canonical sign-in with no server profile + failed PUT → in-account questionnaire; the newly answered profile is later overwritten by the OLD stash on the next hydrate', async () => {
    stash(stashed);
    signInCanonical();
    mockFetchCanonical.mockResolvedValue(null);
    mockSaveCanonical.mockRejectedValueOnce(new Error('503 upstream'));

    await useAppStore.getState().hydrate();
    // Silent: no error, no profile → Gate shows the in-account questionnaire.
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBeDefined();

    // Player answers again (network back) → PUT(newer) succeeds.
    await useAppStore.getState().completeOnboarding(newer);
    expect(useAppStore.getState().profile).toEqual(newer);
    expect(mockSaveCanonical).toHaveBeenLastCalledWith(
      expect.anything(),
      newer,
    );
    // completeOnboarding never clears the pre-auth stash.
    expect(
      JSON.parse(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
    ).toEqual({ version: 1, profile: stashed });

    // Next launch: server has `newer`; the stale stash wins anyway.
    mockFetchCanonical.mockResolvedValue(newer);
    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).toHaveBeenLastCalledWith(
      expect.anything(),
      stashed,
    );
    expect(useAppStore.getState().profile).toEqual(stashed);
  });
});

describe('extra — rapid repeats and interleavings', () => {
  it('FINDING (minor): N concurrent hydrates for a canonical owner all read the stash before any clears it → N duplicate PUTs of the same answers', async () => {
    stash(stashed);
    signInCanonical();
    const seed = 20260904;
    // Deterministic burst size from the recorded seed.
    const burst = 3 + (seed % 4); // 3..6
    await Promise.all(
      Array.from({ length: burst }, () => useAppStore.getState().hydrate()),
    );
    expect(mockSaveCanonical).toHaveBeenCalledTimes(burst);
    expect(useAppStore.getState().profile).toEqual(stashed);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
  });

  it('owner switches to signed-out while the canonical fetch is in flight: nothing is adopted and the store never reports the stale owner as hydrated', async () => {
    stash(stashed);
    signInCanonical();
    let release!: (value: Profile | null) => void;
    mockFetchCanonical.mockImplementation(
      () =>
        new Promise<Profile | null>(resolve => {
          release = resolve;
        }),
    );
    const inflight = useAppStore.getState().hydrate();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    // Sign-out mid-flight.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    mockApiSession = null;
    release(null);
    await inflight;

    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(useAppStore.getState().hydrated).toBe(false);
    expect(useAppStore.getState().profile).toBeNull();
    // The stash waits for the next writable owner.
    expect(
      JSON.parse(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
    ).toEqual({ version: 1, profile: stashed });
  });

  it('owner switches canonical → guest while the PUT is in flight: the canonical write still lands under the canonical key, the guest hydrate adopts the stash too (two owners, one set of answers)', async () => {
    stash(stashed);
    signInCanonical();
    let releaseSave!: (value: Profile) => void;
    mockSaveCanonical.mockImplementation(
      () =>
        new Promise<Profile>(resolve => {
          releaseSave = resolve;
        }),
    );
    const canonicalHydrate = useAppStore.getState().hydrate();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    // Switch to guest before the PUT resolves, run the guest hydrate to
    // completion first.
    mockApiSession = null;
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().ownerKey).toBe(GUEST_DATA_OWNER);
    expect(useAppStore.getState().profile).toEqual(stashed);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');

    releaseSave({ ...stashed, focusCheckpoint: 'preparation' });
    await canonicalHydrate;
    // The late canonical adoption still writes its own row (not the guest's)
    // and does not flip the store back to the stale owner.
    expect(JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER))!)).toEqual({
      ...stashed,
      focusCheckpoint: 'preparation',
    });
    expect(useAppStore.getState().ownerKey).toBe(GUEST_DATA_OWNER);
    expect(useAppStore.getState().profile).toEqual(stashed);
  });
});

describe('extra — hostile payloads in the stash and profile rows', () => {
  it('unicode (RTL, ZWJ emoji, combining marks) survives adoption byte-for-byte', async () => {
    const unicode: Profile = {
      ...stashed,
      firstName: '\u202Eانad\u200D👩🏽‍🎤 é\u0301 𝔇𝔞𝔫𝔞 ',
      goal: 'drops',
    };
    stash(unicode);
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(unicode);
  });

  it('a 2 MiB firstName is adopted without truncation or error (no client-side size cap)', async () => {
    const huge: Profile = {
      ...stashed,
      firstName: 'D'.repeat(2 * 1024 * 1024),
    };
    stash(huge);
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(useAppStore.getState().profile?.firstName).toHaveLength(
      2 * 1024 * 1024,
    );
  });

  it('FINDING (minor): a stash whose focusCheckpoint is not a real checkpoint passes parsePendingProfile (string-typed only) and is adopted verbatim by a guest', async () => {
    stash({ ...stashed, focusCheckpoint: 'not_a_checkpoint' });
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile?.focusCheckpoint).toBe(
      'not_a_checkpoint',
    );
  });

  it('a stash with focusCheckpoint missing is rejected (parsePendingProfile requires every core key) and the guest lands in the in-account questionnaire', async () => {
    const { focusCheckpoint: _dropped, ...noFocus } = stashed;
    void _dropped;
    stash(noFocus);
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBeNull();
    // The unusable stash is left in place (never cleaned).
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBeDefined();
  });

  it.each([
    ['truncated JSON', '{"skillLevel":"3.5","handed'],
    ['unquoted text', 'corrupted row'],
    ['NaN literal', 'NaN'],
  ])(
    'FINDING: a corrupt profile row (%s) makes JSON.parse throw AFTER the kv reads → hydrateError carries the raw parser message and EVERY retry fails the same way (owner is locked out)',
    async (_label, corrupt) => {
      mockKvTable.set(profileKey(GUEST_DATA_OWNER), corrupt);
      setActiveDataOwner(GUEST_DATA_OWNER);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await useAppStore.getState().hydrate();
        const state = useAppStore.getState();
        expect(state.hydrated).toBe(true);
        expect(state.profile).toBeNull();
        expect(state.hydrateError).toEqual(expect.any(String));
        // Raw JSON.parse text is what the Gate's ErrorState will show.
        expect(state.hydrateError).toMatch(/JSON|token|Unexpected/i);
      }
      // Nothing repaired or reset the row.
      expect(mockKvTable.get(profileKey(GUEST_DATA_OWNER))).toBe(corrupt);
    },
  );

  it('a profile row holding the JSON literal "null" hydrates as no profile (in-account questionnaire), not as an error', async () => {
    mockKvTable.set(profileKey(GUEST_DATA_OWNER), 'null');
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBeNull();
  });

  it.each([
    ['JSON array', '[1,2,3]'],
    ['JSON string', '"just a string"'],
    ['JSON number', '42'],
  ])(
    'FINDING (minor): a profile row holding a non-object JSON value (%s) is accepted as the profile without shape validation',
    async (_label, row) => {
      mockKvTable.set(profileKey(GUEST_DATA_OWNER), row);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().hydrateError).toBeNull();
      expect(useAppStore.getState().profile).toEqual(JSON.parse(row));
    },
  );

  it('a kv READ failure on the pending key surfaces as hydrateError with the driver message and a retry with the read healed succeeds', async () => {
    mockKvTable.set(profileKey(GUEST_DATA_OWNER), JSON.stringify(legacy));
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockGetKvFault = key =>
      key === PENDING_ONBOARDING_PROFILE_KV_KEY
        ? new Error('SQLITE_IOERR: disk I/O error')
        : null;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBe(
      'SQLITE_IOERR: disk I/O error',
    );
    mockGetKvFault = () => null;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(legacy);
  });
});
