import type { Profile } from '../../src/state/profile';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * INT-state-consistency adversarial pass (attacked HEAD 30a40650).
 * appStore hydrate ordering, concurrent updates, interrupted saves, and
 * derived state from corrupt persisted profile bytes.
 */

const mockKvTable = new Map<string, string>();
let mockFailWriteKey: string | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    const db: LocalDb = {
      async execute(sql: string, params: unknown[] = []) {
        if (sql.startsWith('SELECT value FROM kv')) {
          const value = mockKvTable.get(String(params[0]));
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          if (mockFailWriteKey === params[0]) throw new Error('disk full');
          mockKvTable.set(String(params[0]), String(params[1]));
          return { rows: [] };
        }
        return { rows: [] };
      },
      async transaction(operation) {
        const snapshot = new Map(mockKvTable);
        try {
          return await operation(db);
        } catch (error) {
          mockKvTable.clear();
          for (const [key, value] of snapshot) mockKvTable.set(key, value);
          throw error;
        }
      },
      close() {},
    };
    return db;
  },
}));

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;

const mockApiListeners = new Set<(session: typeof mockApiSession) => void>();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
  subscribeToApiSession: (
    listener: (session: typeof mockApiSession) => void,
  ) => {
    mockApiListeners.add(listener);
    return () => mockApiListeners.delete(listener);
  },
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

const OWNER_A = '33333333-3333-4333-8333-333333333333';
const OWNER_B = '44444444-4444-4444-8444-444444444444';

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
  ...answers,
  firstName: 'Server',
  focusCheckpoint: 'contact_position',
};

function installSession(owner: string) {
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'live-token',
    canonicalAppUserId: owner,
    provider: 'apple',
  };
  for (const listener of mockApiListeners) listener(mockApiSession);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let turn = 0; turn < 80; turn += 1) await Promise.resolve();
}

function profileKeyFor(owner: string): string {
  return `profile:${owner}`;
}

beforeEach(() => {
  mockKvTable.clear();
  mockFailWriteKey = null;
  mockApiSession = null;
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    ownerContext: null,
    awaitingApiSession: false,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('ATTACK appStore: hydrate ordering and concurrent updates', () => {
  it('H1 completeOnboarding() that fails while hydrate() is still fetching must leave the store in a terminal, retryable state', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    const canonical = deferred<Profile | null>();
    mockFetchCanonical.mockImplementation(() => canonical.promise);
    mockSaveCanonical.mockRejectedValue(new Error('network lost'));

    const hydration = useAppStore.getState().hydrate();
    await flush();
    expect(useAppStore.getState().hydrated).toBe(false);

    await useAppStore.getState().completeOnboarding(answers);
    expect(useAppStore.getState().onboardingBusy).toBe(false);
    expect(useAppStore.getState().onboardingError).toMatch(/network lost/);

    canonical.resolve(null);
    await hydration;
    await flush();

    const settled = useAppStore.getState();
    expect(settled.profile).toBeNull();
    expect(settled.onboardingBusy).toBe(false);

    // An explicit re-hydrate (Gate retry) does recover, which bounds the blast
    // radius of the assertion below.
    mockFetchCanonical.mockResolvedValue(null);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
      hydrateError: null,
    });

    // Either the read completed (hydrated) or it failed loudly (hydrateError);
    // a silent "still loading" with nothing in flight is a stuck Gate.
    expect(settled.hydrated || settled.hydrateError !== null).toBe(true);
  });

  it('H1b a stale canonical profile that resolves after completeOnboarding() saved newer answers never replaces them', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    const canonical = deferred<Profile | null>();
    mockFetchCanonical.mockImplementation(() => canonical.promise);

    const hydration = useAppStore.getState().hydrate();
    await flush();
    await useAppStore.getState().completeOnboarding(answers);
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(useAppStore.getState().hydrated).toBe(true);

    canonical.resolve(serverProfile);
    await hydration;
    await flush();

    expect(useAppStore.getState().profile).toEqual(answers);
    expect(useAppStore.getState().hydrated).toBe(true);
    expect(mockKvTable.get(profileKeyFor(OWNER_A))).toBe(
      JSON.stringify(answers),
    );
  });

  it('H2 a double-tapped completeOnboarding() performs exactly one canonical save and settles on one profile', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
    });

    const firstSave = deferred<Profile>();
    mockSaveCanonical.mockImplementationOnce(() => firstSave.promise);
    const first = useAppStore.getState().completeOnboarding(answers);
    const second = useAppStore.getState().completeOnboarding({
      ...answers,
      firstName: 'Second',
    });
    await flush();
    firstSave.resolve(answers);
    await Promise.all([first, second]);

    expect(useAppStore.getState()).toMatchObject({
      onboardingBusy: false,
      onboardingError: null,
      hydrated: true,
    });
    expect(useAppStore.getState().profile).not.toBeNull();
    expect(mockKvTable.get(profileKeyFor(OWNER_A))).toBe(
      JSON.stringify(useAppStore.getState().profile),
    );
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
  });

  it('H3 a local write failure after a successful canonical save must not strand the account without its saved profile', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    await useAppStore.getState().hydrate();
    mockFailWriteKey = profileKeyFor(OWNER_A);

    await useAppStore.getState().completeOnboarding(answers);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().onboardingBusy).toBe(false);
    expect(useAppStore.getState().onboardingError).not.toBeNull();
    expect(mockKvTable.has(profileKeyFor(OWNER_A))).toBe(false);

    // Relaunch: the server owns the profile now; hydrate must recover it.
    mockFailWriteKey = null;
    mockFetchCanonical.mockResolvedValue(answers);
    useAppStore.setState({ hydrated: false, profile: null, ownerKey: null });
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: answers,
      hydrateError: null,
    });
    expect(mockKvTable.get(profileKeyFor(OWNER_A))).toBe(
      JSON.stringify(answers),
    );
  });
});

describe('ATTACK appStore: corrupt persisted values and account isolation', () => {
  it('H4 corrupt local profile bytes plus canonical fetch failure never mark onboarding complete, and the bytes survive until replaced', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    const corrupt = JSON.stringify({ ...answers, handedness: 'both' });
    mockKvTable.set(profileKeyFor(OWNER_A), corrupt);
    mockFetchCanonical.mockRejectedValue(new Error('offline'));

    await useAppStore.getState().hydrate();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
    });
    expect(useAppStore.getState().hydrateError).not.toBeNull();
    expect(mockKvTable.get(profileKeyFor(OWNER_A))).toBe(corrupt);

    mockFetchCanonical.mockResolvedValue(serverProfile);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: serverProfile,
      hydrateError: null,
    });
    expect(mockKvTable.get(profileKeyFor(OWNER_A))).toBe(
      JSON.stringify(serverProfile),
    );
  });

  it('H5 a pre-auth stash is not adopted into owner A while the live API session belongs to owner B', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_B);

    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      ownerKey: OWNER_A,
      profile: null,
      awaitingApiSession: true,
    });
    expect(mockKvTable.has(profileKeyFor(OWNER_A))).toBe(false);
    expect(mockKvTable.has(profileKeyFor(OWNER_B))).toBe(false);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(
      JSON.stringify({ version: 1, profile: answers }),
    );
  });

  it('H6 a canonical profile for A that resolves after the device switched to B is neither shown to B nor written under B', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    const lateA = deferred<Profile | null>();
    mockFetchCanonical.mockImplementationOnce(() => lateA.promise);
    const hydrationA = useAppStore.getState().hydrate();
    await flush();

    setActiveDataOwner(OWNER_B);
    installSession(OWNER_B);
    mockFetchCanonical.mockResolvedValue(null);
    const hydrationB = useAppStore.getState().hydrate();
    lateA.resolve(serverProfile);
    await Promise.all([hydrationA, hydrationB]);
    await flush();

    expect(useAppStore.getState()).toMatchObject({
      ownerKey: OWNER_B,
      profile: null,
      hydrated: true,
    });
    expect(mockKvTable.has(profileKeyFor(OWNER_A))).toBe(false);
    expect(mockKvTable.has(profileKeyFor(OWNER_B))).toBe(false);
  });
});
