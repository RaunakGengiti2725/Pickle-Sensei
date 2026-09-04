import type { Profile } from '../../src/state/profile';
import { setActiveDataOwner } from '../../src/data/accountScope';

/**
 * AUDIT PROBE (structural pass 1, mobile-launch-onboarding).
 *
 * The pre-auth stash is "single-use" and "a failed save keeps both the stash
 * (retried next hydrate) and the existing profile" (AGENTS.md, appStore.ts:
 * 155-179). This probe follows the one path where those two rules collide:
 *
 *   1. pre-auth answers A are stashed; the user signs in (canonical owner,
 *      no server profile yet);
 *   2. hydrate(): GET /v1/me → null; PUT A fails (5xx / timeout) → stash A
 *      kept, profile null, hydrateError null …
 *   3. … so the Gate (App.tsx:224-225) shows the IN-ACCOUNT questionnaire;
 *      the user answers B; completeOnboarding() PUTs B → server + local row
 *      hold B;
 *   4. the next hydrate() (relaunch / foreground owner re-check) still finds
 *      stash A and, per "newest intent wins", REPLACES B with A — on the
 *      server and locally.
 *
 * A is the OLDER intent; B is the answers the user just gave.
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

const CANONICAL_OWNER = '88888888-8888-4888-8888-888888888888';

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => ({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'token',
    canonicalAppUserId: '88888888-8888-4888-8888-888888888888',
    provider: 'apple',
  }),
}));

// In-memory "server": the canonical profile row for this account.
let serverProfile: Profile | null = null;
let failNextPut = false;

const mockFetchCanonical = jest.fn(async (_session: unknown) => serverProfile);
const mockSaveCanonical = jest.fn(
  async (_session: unknown, profile: Profile) => {
    if (failNextPut) {
      failNextPut = false;
      throw new Error('Pickle Sensei could not reach the server.');
    }
    serverProfile = profile;
    return profile;
  },
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

const answersA: Profile = {
  firstName: 'Dana',
  skillLevel: '3.0',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

const answersB: Profile = {
  firstName: 'Dana',
  skillLevel: '4.0',
  handedness: 'left',
  goal: 'serves',
  biggestProblem: 'power',
  focusCheckpoint: 'contact_position',
};

beforeEach(() => {
  mockKvTable.clear();
  serverProfile = null;
  failNextPut = false;
  mockFetchCanonical.mockClear();
  mockSaveCanonical.mockClear();
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  setActiveDataOwner(CANONICAL_OWNER);
});

describe('stash adoption PUT fails for a canonical owner with NO profile yet', () => {
  it('surfaces a retryable hydrateError instead of silently re-asking the questionnaire while the answers sit in the stash', async () => {
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answersA }),
    );
    failNextPut = true;

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    // Stash kept (documented) …
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).not.toBe('');
    // … but the Gate needs `hydrateError` to show "Try again"; with null it
    // renders <OnboardingScreen /> (App.tsx:224-225) — the questionnaire
    // the user already completed.
    expect(state.hydrateError).not.toBeNull();
  });
});

describe('stale stash resurrection', () => {
  it('answers given in the in-account questionnaire (B) are not replaced by the older pre-auth stash (A) on the next hydrate', async () => {
    // 1-2. stash A; sign-in hydrate whose PUT fails.
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answersA }),
    );
    failNextPut = true;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBeNull(); // → re-ask

    // 3. user completes the in-account questionnaire with B; PUT succeeds.
    await useAppStore.getState().completeOnboarding(answersB);
    expect(useAppStore.getState().onboardingError).toBeNull();
    expect(useAppStore.getState().profile).toEqual(answersB);
    expect(serverProfile).toEqual(answersB);

    // 4. next launch.
    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrateError).toBeNull();
    expect(state.profile).toEqual(answersB);
    expect(serverProfile).toEqual(answersB);
    expect(JSON.parse(mockKvTable.get(`profile:${CANONICAL_OWNER}`)!)).toEqual(
      answersB,
    );
  });
});
