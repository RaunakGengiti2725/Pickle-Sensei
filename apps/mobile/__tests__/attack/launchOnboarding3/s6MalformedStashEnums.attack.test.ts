/**
 * ADVERSARIAL PASS 3 — scenario 6 (mobile-launch-onboarding).
 *
 * Attack: seed the device-level pre-auth stash (`onboarding.pending-profile`)
 * with values OUTSIDE the `Handedness` / `CHECKPOINTS` vocabularies (plus
 * case/whitespace/unicode variants, a seeded fuzz of random enum strings,
 * and outright garbage JSON) and hydrate the first writable owner.
 *
 * Expected: adoption is refused for out-of-vocabulary values (no profile is
 * installed from them, nothing is sent to the account server) and a stash
 * that failed validation is cleared as malformed instead of surviving for
 * every later hydrate.
 */
import { CHECKPOINTS } from '@pickle/shared-types';
import type { Profile } from '../../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const mockKvTable = new Map<string, string>();

jest.mock('../../../src/data/db', () => ({
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
jest.mock('../../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
/** Mirrors the edge route: handedness must be exactly right|left, else 400. */
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>(
  async (_session, profile) => {
    if (profile.handedness !== 'right' && profile.handedness !== 'left') {
      throw new Error('Invalid onboarding payload.');
    }
    return { ...profile, focusCheckpoint: 'paddle_set' };
  },
);
jest.mock('../../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../../src/state/appStore';

const CANONICAL_ID = '66666666-6666-4666-8666-666666666666';
const HANDEDNESS = ['right', 'left', 'ambidextrous'] as const;

const validAnswers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function profileKeyFor(owner: string): string {
  return `profile:${owner}`;
}

function seedStash(profile: unknown) {
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );
}

function stashRaw(): string | undefined {
  return mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
}

function storedProfile(owner: string): unknown {
  const raw = mockKvTable.get(profileKeyFor(owner));
  return raw ? JSON.parse(raw) : null;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const SEED = 0x5eed06;
const ALPHABET =
  'abcdefghijklmnopqrstuvwxyz_ -ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\u00e9\u4e2d\ud83c\udfd3';

function randomString(rand: () => number, maxLen: number): string {
  const len = 1 + Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
  }
  return out;
}

function isValidHandedness(value: unknown): boolean {
  return HANDEDNESS.includes(value as (typeof HANDEDNESS)[number]);
}
function isValidCheckpoint(value: unknown): boolean {
  return CHECKPOINTS.includes(value as (typeof CHECKPOINTS)[number]);
}

beforeEach(() => {
  mockKvTable.clear();
  mockApiSession = null;
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(null);
  mockSaveCanonical.mockClear();
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
});

describe('S6 — stash with handedness/focusCheckpoint outside the vocabularies', () => {
  it('LOCAL owner: out-of-vocabulary handedness + focusCheckpoint are NOT adopted, and the stash is cleared as malformed', async () => {
    seedStash({
      ...validAnswers,
      handedness: 'southpaw',
      focusCheckpoint: 'not_a_checkpoint',
    });
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(storedProfile(GUEST_DATA_OWNER)).toBeNull();
    // Refused AND not left behind for the next hydrate.
    expect(stashRaw() ?? '').toBe('');
  });

  it('CANONICAL owner: an out-of-vocabulary handedness never reaches PUT /v1/me/onboarding', async () => {
    seedStash({ ...validAnswers, handedness: 'ambidextrous' });
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    };
    setActiveDataOwner(canonicalDataOwner(CANONICAL_ID));
    await useAppStore.getState().hydrate();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(useAppStore.getState().profile).toBeNull();
  });

  it('CANONICAL owner: a stash the server rejects as invalid is not re-PUT on every later hydrate', async () => {
    seedStash({ ...validAnswers, handedness: 'ambidextrous' });
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    };
    setActiveDataOwner(canonicalDataOwner(CANONICAL_ID));
    for (let launch = 0; launch < 5; launch += 1) {
      await useAppStore.getState().hydrate();
    }
    // At most one attempt may reach the network before the stash is judged
    // malformed; it must never be retried launch after launch.
    expect(mockSaveCanonical.mock.calls.length).toBeLessThanOrEqual(1);
    expect(stashRaw() ?? '').toBe('');
  });

  it('CANONICAL owner: an out-of-vocabulary focusCheckpoint does not survive into the installed profile', async () => {
    seedStash({ ...validAnswers, focusCheckpoint: 'zz_top' });
    mockApiSession = {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    };
    setActiveDataOwner(canonicalDataOwner(CANONICAL_ID));
    await useAppStore.getState().hydrate();
    const installed = useAppStore.getState().profile;
    if (installed)
      expect(isValidCheckpoint(installed.focusCheckpoint)).toBe(true);
    const stored = storedProfile(
      canonicalDataOwner(CANONICAL_ID),
    ) as Profile | null;
    if (stored) expect(isValidCheckpoint(stored.focusCheckpoint)).toBe(true);
  });

  it.each([
    ['upper-case', 'RIGHT', 'paddle_set'],
    ['trailing space', 'right ', 'paddle_set'],
    ['unicode confusable', 'r\u0456ght', 'paddle_set'],
    ['checkpoint with zero-width joiner', 'right', 'paddle\u200d_set'],
    ['checkpoint upper-case', 'right', 'PADDLE_SET'],
    ['empty handedness', '', 'paddle_set'],
    ['empty checkpoint', 'right', ''],
  ])(
    'LOCAL owner rejects %s handedness=%j focusCheckpoint=%j',
    async (_label, handedness, focusCheckpoint) => {
      seedStash({ ...validAnswers, handedness, focusCheckpoint });
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toBeNull();
      expect(storedProfile(GUEST_DATA_OWNER)).toBeNull();
    },
  );

  it(`seeded fuzz (seed ${SEED}, 200 stashes): every adopted local profile has in-vocabulary handedness AND focusCheckpoint`, async () => {
    const rand = lcg(SEED);
    const adoptedInvalid: Array<{
      handedness: unknown;
      focusCheckpoint: unknown;
    }> = [];
    for (let i = 0; i < 200; i += 1) {
      mockKvTable.clear();
      useAppStore.setState({ hydrated: false, ownerKey: null, profile: null });
      const handedness =
        rand() < 0.3
          ? HANDEDNESS[Math.floor(rand() * HANDEDNESS.length)]
          : randomString(rand, 16);
      const focusCheckpoint =
        rand() < 0.3
          ? CHECKPOINTS[Math.floor(rand() * CHECKPOINTS.length)]
          : randomString(rand, 24);
      seedStash({ ...validAnswers, handedness, focusCheckpoint });
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      const profile = useAppStore.getState().profile;
      if (
        profile &&
        (!isValidHandedness(profile.handedness) ||
          !isValidCheckpoint(profile.focusCheckpoint))
      ) {
        adoptedInvalid.push({
          handedness: profile.handedness,
          focusCheckpoint: profile.focusCheckpoint,
        });
      }
    }
    expect({
      adoptedInvalidCount: adoptedInvalid.length,
      firstFive: adoptedInvalid.slice(0, 5),
    }).toEqual({ adoptedInvalidCount: 0, firstFive: [] });
  });

  it.each([
    ['not JSON', 'definitely not json'],
    ['profile is a number', JSON.stringify({ version: 1, profile: 42 })],
    ['profile is an array', JSON.stringify({ version: 1, profile: [] })],
    [
      'handedness is a number',
      JSON.stringify({
        version: 1,
        profile: { ...validAnswers, handedness: 1 },
      }),
    ],
  ])(
    'garbage stash (%s) is cleared on the first hydrate instead of lingering',
    async (_label, raw) => {
      mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, raw);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toBeNull();
      expect(stashRaw() ?? '').toBe('');
    },
  );

  it('positive control: an in-vocabulary stash IS adopted and cleared', async () => {
    seedStash(validAnswers);
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toEqual(validAnswers);
    expect(stashRaw()).toBe('');
  });
});
