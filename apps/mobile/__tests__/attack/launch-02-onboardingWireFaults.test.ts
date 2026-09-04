import type { Profile } from '../../src/state/profile';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * ADVERSARIAL PASS (mobile-launch-onboarding, tester #2, pass 3).
 *
 * The REAL `src/account/onboarding.ts` wire client runs over a mocked
 * `globalThis.fetch`, driven by the REAL appStore, so what the account
 * server answers is attacked end to end:
 *
 *   S3  GET /v1/me → 200 with recommendedCheckpoint:'not_a_checkpoint'
 *   S5  PUT /v1/me/onboarding hangs past the 15 s AbortController budget
 *   S4  (store half) GET /v1/me → 401 stale bearer → typed hydrateError
 *   +   200 non-JSON / HTML bodies, invalid server focus on the PUT, and the
 *       exact abort boundary (14 999 ms vs 15 000 ms).
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

import { OnboardingSyncError } from '../../src/account/onboarding';
import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';

const CANONICAL_OWNER = '44444444-4444-4444-8444-444444444444';
const API = 'https://api.example.test';
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

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}
const calls: Call[] = [];

type Responder = (call: Call, init: RequestInit) => Promise<Response>;
let responder: Responder = async () => json({}, 500);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

/** A fetch that honours AbortSignal the way the platform fetch does. */
function hangingUntilAborted(): Responder {
  return (_call, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      const onAbort = () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    });
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      authorization: headers['Authorization'],
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call, init ?? {});
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function signInCanonical(bearer = 'bearer-1') {
  mockApiSession = {
    apiBaseUrl: API,
    bearerToken: bearer,
    canonicalAppUserId: CANONICAL_OWNER,
    provider: 'apple',
  };
  setActiveDataOwner(CANONICAL_OWNER);
}

function stash(profile: unknown) {
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );
}

const completeServerProfile = {
  onboardingState: 'complete',
  profile: {
    skill_level: '4.0',
    handedness: 'left',
    primary_goal: 'serve',
    biggest_problem: 'power',
    focus_checkpoint: 'sequencing',
  },
};

beforeEach(() => {
  jest.useRealTimers();
  mockKvTable.clear();
  calls.length = 0;
  responder = async () => json({}, 500);
  mockApiSession = null;
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

describe('S3 — GET /v1/me answers 200 with an invalid recommendedCheckpoint', () => {
  it('HELD (with a twist): the invalid recommendation is never adopted — the GET parser ignores recommendedCheckpoint entirely and derives focus from primary_goal, so hydrate SUCCEEDS instead of erroring', async () => {
    signInCanonical();
    responder = async () =>
      json({
        ...completeServerProfile,
        recommendedCheckpoint: 'not_a_checkpoint',
        plan: { focusCheckpoint: 'not_a_checkpoint' },
      });

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(calls).toEqual([
      expect.objectContaining({ method: 'GET', url: `${API}/v1/me` }),
    ]);
    expect(state.hydrateError).toBeNull();
    expect(state.profile).toEqual({
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'serve',
      biggestProblem: 'power',
      focusCheckpoint: 'sequencing', // focusForGoal('serve'), not the wire value
    });
    expect(state.profile?.focusCheckpoint).not.toBe('not_a_checkpoint');
  });

  it('HELD: an invalid profile.focus_checkpoint on GET /v1/me is likewise ignored — the client trusts its own goal→focus table, never the server column', async () => {
    signInCanonical();
    responder = async () =>
      json({
        onboardingState: 'complete',
        profile: {
          ...completeServerProfile.profile,
          focus_checkpoint: 'not_a_checkpoint',
        },
      });
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile?.focusCheckpoint).toBe('sequencing');
    expect(useAppStore.getState().hydrateError).toBeNull();
  });

  it('PUT /v1/me/onboarding answering an invalid recommendedCheckpoint during STASH ADOPTION is swallowed: no hydrateError, no profile, stash kept → the Gate re-asks the questionnaire in-account', async () => {
    stash(stashed);
    signInCanonical();
    responder = async call =>
      call.method === 'GET'
        ? json({ onboardingState: 'pending', profile: null })
        : json({
            recommendedCheckpoint: 'not_a_checkpoint',
            profile: {},
          });

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    // A 200 with a bad focus is a payload error, not a request failure, so
    // the identity-field fallback PUT is (correctly) not attempted.
    expect(calls.map(c => c.method)).toEqual(['GET', 'PUT']);
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    // FINDING (degraded): the typed OnboardingSyncError copy is dropped here
    // — hydrateError stays null, so the Gate shows the questionnaire rather
    // than "invalid training focus" + retry.
    expect(state.hydrateError).toBeNull();
    expect(state.onboardingError).toBeNull();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
    expect(
      JSON.parse(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
    ).toEqual({ version: 1, profile: stashed });
  });

  it('HELD: the same invalid PUT answer through completeOnboarding surfaces the typed copy as onboardingError and busy clears', async () => {
    signInCanonical();
    responder = async () =>
      json({ recommendedCheckpoint: 'not_a_checkpoint', profile: {} });
    await useAppStore.getState().completeOnboarding(stashed);
    const state = useAppStore.getState();
    expect(state.onboardingBusy).toBe(false);
    expect(state.onboardingError).toBe(
      'The account server returned an invalid training focus.',
    );
    expect(state.profile).toBeNull();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
  });

  it('FINDING (degraded UX): GET /v1/me → 200 with a non-JSON body (captive portal / HTML) is read as "no server profile" — an onboarded account is sent back through the questionnaire instead of a retry state', async () => {
    signInCanonical();
    responder = async () =>
      text('<html><body>Wi-Fi sign-in required</body></html>');
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.hydrateError).toBeNull();
    expect(state.profile).toBeNull();
  });

  it('FINDING (degraded UX): GET /v1/me → 200 whose profile fails the client parser (unknown handedness) is also read as "no profile" → questionnaire, and the answers then REPLACE the server profile', async () => {
    signInCanonical();
    responder = async call =>
      call.method === 'GET'
        ? json({
            onboardingState: 'complete',
            profile: { ...completeServerProfile.profile, handedness: 'both' },
          })
        : json({ recommendedCheckpoint: 'paddle_set', profile: {} });
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBeNull();
    await useAppStore.getState().completeOnboarding(stashed);
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
    expect(useAppStore.getState().profile).toEqual(stashed);
  });
});

describe('S4 (store half) — GET /v1/me → 401 stale bearer', () => {
  it('HELD: hydrate lands in hydrateError with the typed offline copy, no profile is invented, nothing is written, the stash survives', async () => {
    stash(stashed);
    signInCanonical('stale-bearer');
    responder = async () =>
      json(
        { error: { code: 'unauthorized', message: 'Bearer expired.' } },
        401,
      );

    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe('Bearer stale-bearer');
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
    expect(
      JSON.parse(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
    ).toEqual({ version: 1, profile: stashed });
    // No PUT went out under the stale bearer.
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('HELD: after the session refreshes, the retry sends the NEW bearer on both GET and PUT and adopts the stash', async () => {
    stash(stashed);
    signInCanonical('stale-bearer');
    responder = async () => json({ error: { message: 'expired' } }, 401);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().hydrateError).toBe(
      CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
    );

    calls.length = 0;
    signInCanonical('fresh-bearer');
    responder = async call =>
      call.method === 'GET'
        ? json({ onboardingState: 'pending', profile: null })
        : json({ recommendedCheckpoint: 'preparation', profile: {} });
    await useAppStore.getState().hydrate();

    expect(calls.map(c => [c.method, c.authorization])).toEqual([
      ['GET', 'Bearer fresh-bearer'],
      ['PUT', 'Bearer fresh-bearer'],
    ]);
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(useAppStore.getState().profile).toEqual({
      ...stashed,
      focusCheckpoint: 'preparation',
    });
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
  });
});

describe('S5 — PUT /v1/me/onboarding hangs past 15 s (fake timers)', () => {
  it('HELD: completeOnboarding aborts at exactly 15 000 ms; OnboardingSyncError copy lands in onboardingError, onboardingBusy clears, nothing is persisted', async () => {
    jest.useFakeTimers();
    signInCanonical();
    responder = hangingUntilAborted();

    const run = useAppStore.getState().completeOnboarding(stashed);
    await Promise.resolve();
    expect(useAppStore.getState().onboardingBusy).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'PUT',
        url: `${API}/v1/me/onboarding`,
      }),
    ]);

    // One millisecond short of the budget: still busy, still hanging.
    await jest.advanceTimersByTimeAsync(14_999);
    expect(useAppStore.getState().onboardingBusy).toBe(true);
    expect(useAppStore.getState().onboardingError).toBeNull();

    // The budget elapses → abort → identity-field fallback retry ALSO hangs
    // for its own 15 s → abort → typed error.
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2); // fallback PUT (core body) started
    expect(calls[1]?.body).toEqual({
      skillLevel: '3.5',
      handedness: 'right',
      goal: 'drops',
      biggestProblem: 'control',
    });
    expect(useAppStore.getState().onboardingBusy).toBe(true);
    await jest.advanceTimersByTimeAsync(15_000);
    await run;

    const state = useAppStore.getState();
    expect(state.onboardingBusy).toBe(false);
    expect(state.onboardingError).toBe(
      'Your coaching profile could not be securely saved. Check your connection and try again.',
    );
    expect(state.profile).toBeNull();
    expect(mockKvTable.get(profileKey(CANONICAL_OWNER))).toBeUndefined();
  });

  it('OBSERVED: with identity fields present the worst-case wait is 30 s (15 s + 15 s fallback), not 15 s; a core-only profile fails after one 15 s budget', async () => {
    jest.useFakeTimers();
    signInCanonical();
    responder = hangingUntilAborted();
    const { firstName: _n, gender: _g, ...core } = stashed;
    void _n;
    void _g;
    const run = useAppStore.getState().completeOnboarding(core as Profile);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(15_000);
    await run;
    expect(calls).toHaveLength(1);
    expect(useAppStore.getState().onboardingBusy).toBe(false);
    expect(useAppStore.getState().onboardingError).toMatch(
      /could not be securely saved/,
    );
  });

  it('HELD: the same hang during hydrate stash adoption is swallowed after the abort — the app opens on the existing server profile, the stash survives for the next hydrate', async () => {
    jest.useFakeTimers();
    stash(stashed);
    signInCanonical();
    responder = async (call, init) =>
      call.method === 'GET'
        ? json(completeServerProfile)
        : hangingUntilAborted()(call, init);

    const run = useAppStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(30_000);
    await run;

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.hydrateError).toBeNull();
    expect(state.onboardingBusy).toBe(false);
    expect(state.profile).toEqual({
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'serve',
      biggestProblem: 'power',
      focusCheckpoint: 'sequencing',
    });
    expect(
      JSON.parse(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
    ).toEqual({ version: 1, profile: stashed });
    expect(calls.map(c => c.method)).toEqual(['GET', 'PUT', 'PUT']);
  });

  it('HELD: the wire client throws a typed OnboardingSyncError (not a raw AbortError) when aborted', async () => {
    jest.useFakeTimers();
    responder = hangingUntilAborted();
    const { saveCanonicalOnboardingProfile } = jest.requireActual<
      typeof import('../../src/account/onboarding')
    >('../../src/account/onboarding');
    const pending = saveCanonicalOnboardingProfile(
      {
        apiBaseUrl: API,
        bearerToken: 'b',
        canonicalAppUserId: CANONICAL_OWNER,
        provider: 'apple',
      },
      { ...stashed, firstName: undefined, gender: undefined },
    );
    const settled = pending.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(15_000);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(OnboardingSyncError);
    expect((outcome as Error).name).toBe('OnboardingSyncError');
  });
});
