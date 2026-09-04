import { CHECKPOINTS } from '@pickle/shared-types';
import type { Profile } from '../../src/state/profile';
import { setActiveDataOwner } from '../../src/data/accountScope';

/**
 * AUDIT PROBE (structural pass 1, mobile-launch-onboarding).
 *
 * appStore.hydrate() trusts every byte it reads back from SQLite kv:
 *   - the owner's profile row is `JSON.parse(raw) as Profile` (appStore.ts:182)
 *     with no shape check;
 *   - a row that is not JSON throws, and the catch (appStore.ts:190-200)
 *     surfaces the raw parser message as `hydrateError` — the row is never
 *     repaired, and because the row is non-empty the canonical fetch that
 *     could have replaced it is skipped (appStore.ts:131-135);
 *   - the pre-auth stash parser (appStore.ts:52-62) only checks `typeof
 *     x === 'string'` on five keys — enum/length bounds are not enforced,
 *     and the adopted value is PUT verbatim to the server for canonical
 *     owners.
 *
 * Each `it` states the invariant the store SHOULD hold; failures are the
 * defects.
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
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';

const serverProfile: Profile = {
  skillLevel: '4.0',
  handedness: 'left',
  goal: 'serves',
  biggestProblem: 'power',
  focusCheckpoint: 'contact_position',
};

// @pickle/shared-types Handedness = 'right' | 'left' | 'ambidextrous'.
const VALID_HANDEDNESS: readonly string[] = ['left', 'right', 'ambidextrous'];
const VALID_CHECKPOINTS: readonly string[] = CHECKPOINTS;

function isWellFormedProfile(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['skillLevel'] === 'string' &&
    typeof p['handedness'] === 'string' &&
    typeof p['goal'] === 'string' &&
    typeof p['biggestProblem'] === 'string' &&
    typeof p['focusCheckpoint'] === 'string'
  );
}

beforeEach(() => {
  mockKvTable.clear();
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'token',
    canonicalAppUserId: CANONICAL_OWNER,
    provider: 'apple',
  };
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(serverProfile);
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
});

describe('PROBE b — stored profile row shape (appStore.ts:182)', () => {
  it.each([
    ['empty object', '{}'],
    ['partial object', '{"skillLevel":"3.5"}'],
    ['array', '[]'],
    ['string literal', '"hello"'],
    ['number literal', '42'],
  ])(
    'guest owner: a %s row never becomes the live profile (profile must be null or well-formed)',
    async (_label, row) => {
      setActiveDataOwner(GUEST_DATA_OWNER);
      mockKvTable.set(`profile:${GUEST_DATA_OWNER}`, row);

      await useAppStore.getState().hydrate();

      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      // Invariant: the Gate mounts RootNavigator on any truthy profile, so a
      // truthy value here MUST be a well-formed Profile.
      if (state.profile) {
        expect(isWellFormedProfile(state.profile)).toBe(true);
      }
    },
  );

  it('canonical owner: a malformed local row does not shadow the server profile', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockKvTable.set(`profile:${CANONICAL_OWNER}`, '{}');

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    // Either the server was consulted and won, or the row was rejected.
    if (state.profile) {
      expect(state.profile).toEqual(serverProfile);
    } else {
      expect(state.hydrateError).not.toBeNull();
    }
  });
});

describe('PROBE a — corrupt (non-JSON) profile row (appStore.ts:182, 190-200; App.tsx:217-223)', () => {
  it('canonical owner: the user-facing hydrateError is the product copy, never the JS parser message', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockKvTable.set(`profile:${CANONICAL_OWNER}`, 'not json at all');

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).not.toBeNull();
    // App.tsx renders `hydrateError` verbatim as the ErrorState detail.
    expect(state.hydrateError).not.toMatch(/JSON|token|Unexpected/i);
  });

  it('canonical owner: a corrupt local row does not suppress the canonical fetch that could repair it', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockKvTable.set(`profile:${CANONICAL_OWNER}`, 'not json at all');

    await useAppStore.getState().hydrate();

    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
  });

  it('canonical owner: Retry (a second hydrate) recovers — the row is repaired or replaced, not re-thrown forever', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockKvTable.set(`profile:${CANONICAL_OWNER}`, 'not json at all');

    await useAppStore.getState().hydrate();
    const first = useAppStore.getState().hydrateError;
    expect(first).not.toBeNull();

    // The user taps "Try again" (App.tsx:222) — with the server reachable
    // and holding a good profile.
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.profile).toEqual(serverProfile);
    expect(state.hydrateError).toBeNull();
  });

  it('guest owner: a corrupt row is repaired (blanked) so the next hydrate offers the questionnaire instead of erroring again', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockKvTable.set(`profile:${GUEST_DATA_OWNER}`, '{oops');

    await useAppStore.getState().hydrate();
    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    // The rank record gets this treatment (see wf/flow-splash-hydration-
    // overlays "corrupt rank record ... is repaired"); the profile row should
    // too — otherwise the Gate's ErrorState is a permanent dead end with no
    // sign-out control.
    expect(state.hydrateError).toBeNull();
  });
});

describe('PROBE c — pre-auth stash value bounds (appStore.ts:52-62)', () => {
  const garbage = {
    firstName: 12345,
    gender: {},
    skillLevel: 'x'.repeat(5000),
    handedness: 'both-hands',
    goal: 'drops',
    biggestProblem: 'control',
    focusCheckpoint: 'not_a_checkpoint',
  };

  it('guest owner: a stash with out-of-enum values is ignored (treated like any other malformed stash), not adopted verbatim', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: garbage }),
    );

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    if (state.profile) {
      expect(VALID_HANDEDNESS).toContain(state.profile.handedness);
      expect(VALID_CHECKPOINTS).toContain(state.profile.focusCheckpoint);
      expect(state.profile.skillLevel.length).toBeLessThanOrEqual(40);
      expect(
        state.profile.firstName === undefined ||
          typeof state.profile.firstName === 'string',
      ).toBe(true);
    }
  });

  it('canonical owner: an out-of-enum stash is never PUT to /v1/me/onboarding', async () => {
    setActiveDataOwner(CANONICAL_OWNER);
    mockFetchCanonical.mockResolvedValue(null);
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: garbage }),
    );

    await useAppStore.getState().hydrate();

    for (const [, body] of mockSaveCanonical.mock.calls) {
      expect(VALID_HANDEDNESS).toContain(body.handedness);
      expect(VALID_CHECKPOINTS).toContain(body.focusCheckpoint);
      expect(body.skillLevel.length).toBeLessThanOrEqual(40);
    }
  });

  it('sanity: the documented message constant exists for canonical fetch failures', () => {
    expect(typeof CANONICAL_PROFILE_UNAVAILABLE_MESSAGE).toBe('string');
  });
});
