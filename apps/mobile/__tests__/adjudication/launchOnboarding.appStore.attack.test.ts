import type { Profile } from '../../src/state/profile';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Adversarial probes against the ADJ-D fix (candidate 127a91d9). Each `it`
 * states the contract the fix claims ("a stash older than an in-account
 * completion must never be re-adopted"; "newest intent wins"; "the failed
 * adoption surfaces a retryable error") and drives it through a variant the
 * candidate's own tests do not cover: kv write failures between the server
 * PUT and the local writes, owner switches mid-flight, double hydrate.
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
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';

const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_OWNER = canonicalDataOwner(OTHER_ID);

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

const reAnswered: Profile = {
  firstName: 'Sam',
  gender: 'male',
  skillLevel: '4.5',
  handedness: 'right',
  goal: 'volleys',
  biggestProblem: 'consistency',
  focusCheckpoint: 'face_wrist_stability',
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

/** Stash A on disk, canonical owner signed in, first adoption PUT offline. */
async function stashThenFailedAdoption() {
  stash();
  setActiveDataOwner(CANONICAL_OWNER);
  mockApiSession = apiSession;
  mockSaveCanonical.mockRejectedValueOnce(new Error('offline'));
  await useAppStore.getState().hydrate();
  expect(useAppStore.getState().profile).toBeNull();
  expect(pendingRaw()).not.toBeNull();
  mockSaveCanonical.mockClear();
}

describe('ATTACK completeOnboarding supersession vs local write failures', () => {
  it('a completion the SERVER accepted supersedes the stash even when the local profile write fails (no re-adoption of the older answers on the next hydrate)', async () => {
    await stashThenFailedAdoption();

    // The in-account completion reaches the server (PUT B accepted) but
    // the local profile kv write fails afterwards.
    mockWriteFailures.set(
      profileKey(CANONICAL_OWNER),
      new Error('database is locked'),
    );
    await useAppStore.getState().completeOnboarding(reAnswered);
    expect(savedProfiles()).toEqual([reAnswered]);
    expect(useAppStore.getState().onboardingError).toBe('database is locked');

    // Next launch: the server already holds B (newest intent, accepted).
    mockSaveCanonical.mockClear();
    mockFetchCanonical.mockResolvedValue(reAnswered);
    await useAppStore.getState().hydrate();

    // Contract under test: the older stash is never re-adopted over an
    // in-account completion the server accepted — B must stand and A must
    // never be PUT.
    expect(mockSaveCanonical).not.toHaveBeenCalledWith(apiSession, stashed);
    expect(useAppStore.getState().profile).toEqual(reAnswered);
  });

  it('a completion whose PUT the server APPLIED but whose response was lost (timeout) is not undone by the older stash on the next launch — no kv failure needed', async () => {
    await stashThenFailedAdoption();

    // The PUT B reaches the server and is applied, but the response never
    // arrives (request aborted at the 15s timeout / connection dropped).
    mockSaveCanonical.mockRejectedValueOnce(new Error('timeout'));
    await useAppStore.getState().completeOnboarding(reAnswered);
    expect(savedProfiles()).toEqual([reAnswered]);
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().onboardingError).not.toBeNull();

    // Relaunch: no local profile for this owner, server holds B.
    mockSaveCanonical.mockClear();
    mockFetchCanonical.mockResolvedValue(reAnswered);
    await useAppStore.getState().hydrate();

    // Newest intent wins: the in-account answers B (later than the stash A,
    // already on the server) must not be replaced by A, nor A PUT over B.
    expect(mockSaveCanonical).not.toHaveBeenCalledWith(apiSession, stashed);
    expect(useAppStore.getState().profile).toEqual(reAnswered);
  });

  it('a completion that is fully saved (server + local) is not reported as failed just because the stash-clear write fails, and the stash cannot resurrect afterwards', async () => {
    await stashThenFailedAdoption();

    mockWriteFailures.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      new Error('database is locked'),
    );
    await useAppStore.getState().completeOnboarding(reAnswered);
    expect(savedProfiles()).toEqual([reAnswered]);
    expect(
      JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER)) ?? 'null'),
    ).toEqual(reAnswered);

    // Profile is durably saved on both sides; the state must reflect it.
    expect(useAppStore.getState().onboardingError).toBeNull();
    expect(useAppStore.getState().profile).toEqual(reAnswered);

    // Relaunch: B is on disk; the stash (still on disk) must not win.
    mockSaveCanonical.mockClear();
    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).not.toHaveBeenCalledWith(apiSession, stashed);
    expect(useAppStore.getState().profile).toEqual(reAnswered);
  });
});

describe('ATTACK owner switch while the adoption PUT is in flight', () => {
  it('a PUT that rejects after the user signed out leaves the signed-out state untouched (no hydrateError leak) and keeps the stash', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    const gate = deferred<Profile>();
    mockSaveCanonical.mockReturnValueOnce(gate.promise);
    const inFlight = useAppStore.getState().hydrate();
    await untilSaveCalled(1);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    // Sign-out mid-flight: the signed-out owner hydrates and settles.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    mockApiSession = null;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: SIGNED_OUT_DATA_OWNER,
      profile: null,
      hydrateError: null,
    });

    gate.reject(new Error('offline'));
    await inFlight;
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: SIGNED_OUT_DATA_OWNER,
      profile: null,
      hydrateError: null,
    });
    expect(pendingRaw()).not.toBeNull();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
  });

  it('a PUT that resolves after the user switched to ANOTHER account writes the adopted profile only to the account that PUT it, and the new owner never re-adopts the consumed stash', async () => {
    stash();
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    const gate = deferred<Profile>();
    mockSaveCanonical.mockReturnValueOnce(gate.promise);
    const inFlight = useAppStore.getState().hydrate();
    await untilSaveCalled(1);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    gate.resolve(stashed);
    await inFlight;
    expect(pendingRaw()).toBeNull();

    setActiveDataOwner(OTHER_OWNER);
    mockApiSession = { ...apiSession, canonicalAppUserId: OTHER_ID };
    mockSaveCanonical.mockClear();
    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(mockKvTable.get(profileKey(OTHER_OWNER))).toBeUndefined();
    expect(
      JSON.parse(mockKvTable.get(profileKey(CANONICAL_OWNER)) ?? 'null'),
    ).toEqual(stashed);
  });
});

describe('ATTACK empty-string stash sentinel', () => {
  it("completeOnboarding does not write the device-level key when the stash is already the '' sentinel", async () => {
    mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, '');
    setActiveDataOwner(CANONICAL_OWNER);
    mockApiSession = apiSession;
    await useAppStore.getState().completeOnboarding(reAnswered);
    expect(useAppStore.getState().profile).toEqual(reAnswered);
    expect(
      mockWrites.filter(([k]) => k === PENDING_ONBOARDING_PROFILE_KV_KEY),
    ).toEqual([]);
  });
});
