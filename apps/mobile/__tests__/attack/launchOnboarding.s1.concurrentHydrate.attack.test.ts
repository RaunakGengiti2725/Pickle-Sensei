/**
 * ADVERSARIAL S1 — two concurrent appStore.hydrate() calls for the SAME
 * canonical owner while a pre-auth stash is pending and the canonical save
 * is slow.
 *
 * Contract under attack (AGENTS.md "Launch flow"): the stash is single-use
 * and canonical accounts save it through /v1/me/onboarding. Two overlapping
 * hydrates (Gate's owner effect + an ErrorState retry, or two rapid owner
 * changes back to the same owner) must produce exactly ONE server save and
 * clear the stash once.
 *
 * Seeded randomness: the interleaving of the two save resolutions is drawn
 * from a tiny LCG seeded by ATTACK_SEED (default 20260904) so the run is
 * reproducible; the seed is printed in the test name.
 */
import type { Profile } from '../../src/state/profile';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
const kvWrites: Array<{ key: string; value: string }> = [];

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        kvWrites.push({ key: String(params[0]), value: String(params[1]) });
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
const ATTACK_SEED = Number(
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.['ATTACK_SEED'] ?? '20260904',
);

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

beforeEach(() => {
  mockKvTable.clear();
  kvWrites.length = 0;
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'bearer',
    canonicalAppUserId: CANONICAL_OWNER,
    provider: 'apple',
  };
  mockFetchCanonical.mockClear();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockClear();
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile: answers }),
  );
  setActiveDataOwner(CANONICAL_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe(`S1 concurrent hydrate() with pending stash (seed ${ATTACK_SEED})`, () => {
  it('two overlapping hydrates for the same canonical owner save the stash to the server exactly once and clear it once', async () => {
    const saves: Array<ReturnType<typeof deferred<Profile>>> = [];
    mockSaveCanonical.mockImplementation((_session, profile) => {
      const d = deferred<Profile>();
      saves.push(d);
      void profile;
      return d.promise;
    });

    const h1 = useAppStore.getState().hydrate();
    const h2 = useAppStore.getState().hydrate();
    await flush(20);

    const pendingSavesBeforeResolve = saves.length;

    // Resolve the in-flight saves in a seeded random order.
    const rnd = lcg(ATTACK_SEED);
    const order = saves.map((_, i) => i).sort(() => rnd() - 0.5);
    for (const i of order) {
      saves[i]!.resolve(answers);
      await flush(5);
    }
    await Promise.all([h1, h2]);

    const stashClears = kvWrites.filter(
      w => w.key === PENDING_ONBOARDING_PROFILE_KV_KEY && w.value === '',
    ).length;

    // Evidence for the report regardless of pass/fail.
    console.log(
      JSON.stringify({
        scenario: 'S1',
        seed: ATTACK_SEED,
        saveCalls: mockSaveCanonical.mock.calls.length,
        pendingSavesBeforeResolve,
        stashClears,
        finalStash: mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
        profile: useAppStore.getState().profile,
      }),
    );

    expect(useAppStore.getState().profile).toEqual(answers);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(stashClears).toBe(1);
  });

  it('a hydrate started while a first hydrate already cleared the stash does not re-save', async () => {
    const first = deferred<Profile>();
    mockSaveCanonical.mockImplementationOnce(() => first.promise);

    const h1 = useAppStore.getState().hydrate();
    await flush(20);
    first.resolve(answers);
    await h1;
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(answers);
  });
});
