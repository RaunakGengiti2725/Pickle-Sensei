import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Mutation pins for appStore.parsePendingProfile (harness:
 * tools/mutation/launch-gate/mutants.mjs).
 *
 * The pre-auth stash is the ONE path by which a profile enters an owner
 * bucket without that owner answering the questionnaire. The existing
 * "malformed stash" pin only covers a stash with no `profile` key; mutant
 * `AS05-stash-validation-dropped` (required-field check removed) survived
 * the full suite on 4d812e1a — with it, `{"version":1,"profile":{}}` is
 * adopted as the owner's profile and the Gate's `Boolean(profile)` check
 * lets an EMPTY profile into the main app. These pins feed every shape of
 * incomplete/ill-typed profile through hydrate() for guest and canonical
 * owners and require: nothing adopted, nothing written, nothing saved
 * server-side, and the stash left alone for a later valid write.
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

const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';

const complete: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

const REQUIRED = [
  'skillLevel',
  'handedness',
  'goal',
  'biggestProblem',
  'focusCheckpoint',
] as const;

function without(key: keyof Profile): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...complete };
  delete copy[key];
  return copy;
}

/** Every stash payload that must NOT become a profile. */
const REJECTED_STASHES: Array<[string, string]> = [
  ['empty profile object', JSON.stringify({ version: 1, profile: {} })],
  ['name only', JSON.stringify({ version: 1, profile: { firstName: 'Dana' } })],
  ...REQUIRED.map(
    key =>
      [
        `missing ${key}`,
        JSON.stringify({ version: 1, profile: without(key) }),
      ] as [string, string],
  ),
  ...REQUIRED.map(
    key =>
      [
        `${key} is null`,
        JSON.stringify({ version: 1, profile: { ...complete, [key]: null } }),
      ] as [string, string],
  ),
  ...REQUIRED.map(
    key =>
      [
        `${key} is a number`,
        JSON.stringify({ version: 1, profile: { ...complete, [key]: 3 } }),
      ] as [string, string],
  ),
  ...REQUIRED.map(
    key =>
      [
        `${key} is an object`,
        JSON.stringify({
          version: 1,
          profile: { ...complete, [key]: { value: 'drops' } },
        }),
      ] as [string, string],
  ),
  ['profile is an array', JSON.stringify({ version: 1, profile: [complete] })],
  ['profile is a string', JSON.stringify({ version: 1, profile: 'drops' })],
  ['profile is null', JSON.stringify({ version: 1, profile: null })],
  [
    'top level is an array',
    JSON.stringify([{ version: 1, profile: complete }]),
  ],
  ['top level is a string', JSON.stringify('profile')],
  ['not JSON', '{version:1,profile:{}}'],
];

function profileKeyFor(owner: string): string {
  return `profile:${owner}`;
}

beforeEach(() => {
  mockKvTable.clear();
  mockApiSession = null;
  mockFetchCanonical.mockClear();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockClear();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
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

describe('pending-profile stash: every incomplete or ill-typed payload is refused', () => {
  it('sanity: the complete payload IS adopted by a guest (so the rejections below mean something)', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: complete }),
    );
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(complete);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
  });

  it.each(REJECTED_STASHES)(
    'guest owner: %s → no profile, no owner write, stash untouched',
    async (_name, raw) => {
      mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, raw);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.ownerKey).toBe(GUEST_DATA_OWNER);
      expect(state.profile).toBeNull();
      expect(state.hydrateError).toBeNull();
      expect(mockKvTable.get(profileKeyFor(GUEST_DATA_OWNER))).toBeUndefined();
      expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(raw);
    },
  );

  it.each(REJECTED_STASHES)(
    'canonical owner: %s → no profile, no owner write, no server save, stash untouched',
    async (_name, raw) => {
      mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, raw);
      mockApiSession = {
        apiBaseUrl: 'https://api.example.test',
        bearerToken: 'token',
        canonicalAppUserId: CANONICAL_ID,
        provider: 'apple',
      };
      const owner = canonicalDataOwner(CANONICAL_ID);
      setActiveDataOwner(owner);
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.ownerKey).toBe(owner);
      expect(state.profile).toBeNull();
      expect(state.hydrateError).toBeNull();
      expect(mockSaveCanonical).not.toHaveBeenCalled();
      expect(mockKvTable.get(profileKeyFor(owner))).toBeUndefined();
      expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(raw);
    },
  );

  it.each(REJECTED_STASHES)(
    'an existing profile is never replaced by a rejected stash (%s)',
    async (_name, raw) => {
      const existing: Profile = { ...complete, firstName: 'Existing' };
      mockKvTable.set(
        profileKeyFor(GUEST_DATA_OWNER),
        JSON.stringify(existing),
      );
      mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, raw);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toEqual(existing);
      expect(
        JSON.parse(mockKvTable.get(profileKeyFor(GUEST_DATA_OWNER))!),
      ).toEqual(existing);
      expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(raw);
    },
  );
});
