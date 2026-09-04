import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * PRE-EXISTING behaviour probes (informational — NOT counted as breaks of
 * candidate 127a91d9). Every `it` here fails IDENTICALLY on baseline
 * 4d812e1a and on the candidate: hydrate() sets `raw` to the adopted profile
 * BEFORE the local kv writes, so a local write failure after a successful
 * (or guest, no-PUT) adoption is classified as "existing profile stands in"
 * and the in-memory profile disagrees with disk while the stash stays; and a
 * late-settling earlier hydrate for the SAME owner overwrites a newer one.
 * Kept separate so the attack suite's failures are only in-scope findings.
 */

const mockKvTable = new Map<string, string>();
let mockReadFailure: Error | null = null;
/** Keys whose NEXT write must fail (consumed one write at a time). */
const mockWriteFailures = new Map<string, Error>();
const mockWrites: Array<[string, string]> = [];

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockReadFailure) throw mockReadFailure;
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        const failure = mockWriteFailures.get(key);
        if (failure) {
          mockWriteFailures.delete(key);
          throw failure;
        }
        mockWrites.push([key, String(params[1])]);
        mockKvTable.set(key, String(params[1]));
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

const existing: Profile = {
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
const savedProfiles = () => mockSaveCanonical.mock.calls.map(([, p]) => p);

/** Flushes microtasks until the adoption PUT has been issued. */
async function untilSaveCalled(times: number) {
  for (let i = 0; i < 50 && mockSaveCanonical.mock.calls.length < times; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockKvTable.clear();
  mockWriteFailures.clear();
  mockWrites.length = 0;
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

describe('ATTACK hydrate adoption vs local write failures', () => {
  it('adoption PUT accepted but local profile write fails: the stash is still consumed (single-use) or the state reflects the failure — never a half-state that re-PUTs the stash forever', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockWriteFailures.set(
      profileKey(CANONICAL_OWNER),
      new Error('database is locked'),
    );
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(savedProfiles()).toEqual([stashed]);
    // Either outcome is acceptable: (a) hydrateError with the stash kept for
    // retry, or (b) profile adopted AND stash cleared. What is NOT
    // acceptable: profile shown as adopted while the stash still waits and
    // nothing is on disk for this owner.
    const adoptedInState = state.profile !== null;
    if (adoptedInState) {
      expect(pendingRaw()).toBeNull();
    } else {
      expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
      expect(pendingRaw()).not.toBeNull();
    }
  });

  it('owner with an existing profile P: adoption PUT accepted (server now A) but the local profile write fails — the state must not show A while disk keeps P and the stash', async () => {
    stash();
    mockKvTable.set(profileKey(CANONICAL_OWNER), JSON.stringify(existing));
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    mockWriteFailures.set(
      profileKey(CANONICAL_OWNER),
      new Error('database is locked'),
    );
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(savedProfiles()).toEqual([stashed]);
    const onDisk = JSON.parse(
      mockKvTable.get(profileKey(CANONICAL_OWNER)) ?? 'null',
    );
    // State and disk must agree on which profile this owner has.
    expect(state.profile).toEqual(onDisk);
  });
});

describe('ATTACK guest owner variants', () => {
  it('guest adoption whose local write fails surfaces an error instead of re-asking the questionnaire, and keeps the stash', async () => {
    stash();
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockWriteFailures.set(
      profileKey(GUEST_DATA_OWNER),
      new Error('database is locked'),
    );
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).not.toBeNull();
    expect(pendingRaw()).not.toBeNull();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('guest with an existing local profile keeps it when adopting the stash fails locally', async () => {
    stash();
    mockKvTable.set(profileKey(GUEST_DATA_OWNER), JSON.stringify(existing));
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockWriteFailures.set(
      profileKey(GUEST_DATA_OWNER),
      new Error('database is locked'),
    );
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(existing);
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(pendingRaw()).not.toBeNull();
  });
});

describe('ATTACK double hydrate (Retry tapped while a retry is settling)', () => {
  it('a late failure from an earlier hydrate cannot overwrite a newer successful adoption for the same owner', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    const first = deferred<Profile>();
    mockSaveCanonical.mockReturnValueOnce(first.promise);
    const firstHydrate = useAppStore.getState().hydrate();
    await untilSaveCalled(1);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    // Second hydrate for the SAME owner adopts successfully.
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(stashed);
    expect(pendingRaw()).toBeNull();

    first.reject(new Error('offline'));
    await firstHydrate;
    // The newer, successful hydrate's result must stand.
    expect(useAppStore.getState().profile).toEqual(stashed);
    expect(useAppStore.getState().hydrateError).toBeNull();
  });
});
