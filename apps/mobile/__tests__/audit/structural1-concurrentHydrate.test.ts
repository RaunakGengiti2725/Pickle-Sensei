import type { Profile } from '../../src/state/profile';
import { setActiveDataOwner } from '../../src/data/accountScope';

/**
 * AUDIT PROBE (structural pass 1, mobile-launch-onboarding).
 *
 * appStore.hydrate() guards every write with `getActiveDataOwner() === owner`
 * (appStore.ts:140/164/180/191) — a STALE owner never writes. Two hydrates
 * for the SAME owner pass every guard; this probe asks whether the stash
 * adoption (appStore.ts:161-179) is idempotent under that overlap.
 *
 * Reachability (INFERRED, not demonstrated here): the Gate calls hydrate()
 * on every `desiredOwner` change and on Retry; the same owner can be
 * re-hydrated while a previous hydrate is still awaiting the network
 * (15 s request timeout in account/onboarding.ts:41) — e.g. sign-out and
 * sign back in to the same account within that window.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
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

const CANONICAL_OWNER = '77777777-7777-4777-8777-777777777777';

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => ({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'token',
    canonicalAppUserId: '77777777-7777-4777-8777-777777777777',
    provider: 'apple',
  }),
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

const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

beforeEach(() => {
  mockKvTable.clear();
  mockFetchCanonical.mockReset();
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  setActiveDataOwner(CANONICAL_OWNER);
});

describe('two overlapping hydrate() calls for the SAME canonical owner with a stash on disk', () => {
  it('PUT the stash to /v1/me/onboarding exactly once (single-use stash)', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );
    // The canonical fetch is slow for the first call and instant for the
    // second, so the second hydrate reaches adoption first.
    let releaseFirst!: () => void;
    mockFetchCanonical
      .mockImplementationOnce(
        () =>
          new Promise<Profile | null>(resolve => {
            releaseFirst = () => resolve(null);
          }),
      )
      .mockImplementation(async () => null);

    const first = useAppStore.getState().hydrate();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const second = useAppStore.getState().hydrate();
    await second;
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;

    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    expect(useAppStore.getState().profile).toEqual(answers);
  });
});
