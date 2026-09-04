/**
 * Regression pin (xc-performance / XCP-3): startup hydrate without a local
 * profile.
 *
 * Gate (App.tsx) keeps the splash overlay up until `useAppStore.hydrated` is
 * true. On a device whose SQLite has no local profile for the signed-in owner
 * (fresh reinstall keeps the Keychain session but not the database):
 *
 *  A. with an established API session, GET /v1/me may stall for the request's
 *     own 15 s abort. The launch must not: `hydrated` flips no later than the
 *     8 s launch budget with `canonicalProfilePending` raised (the Gate shows
 *     a loading affordance, not the questionnaire) and the profile is adopted
 *     when the fetch finally lands.
 *  B. when the launch refresh has NOT landed yet (authStore continues
 *     'offline' after LAUNCH_REFRESH_WAIT_MS), getApiSession() is null. The
 *     store must not settle into { profile: null, hydrateError: null } — the
 *     OnboardingScreen branch — for an account that may well have a profile;
 *     it stays pending and fetches the canonical profile (once) the moment
 *     establishApiSession() lands, with no second hydrate() from an owner
 *     change.
 */
import { focusForGoal, type Profile } from '../../src/state/profile';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

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

type MockApiSession = {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
};

let mockApiSession: MockApiSession | null = null;
const mockApiSessionListeners = new Set<
  (session: MockApiSession | null) => void
>();

// Mirrors src/account/apiSession.ts: an in-memory session plus the change
// subscription authStore drives through establishApiSession().
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
  establishApiSession: (session: MockApiSession) => {
    mockApiSession = session;
    for (const listener of [...mockApiSessionListeners]) listener(session);
  },
  subscribeToApiSession: (listener: (s: MockApiSession | null) => void) => {
    mockApiSessionListeners.add(listener);
    return () => mockApiSessionListeners.delete(listener);
  },
}));

import { useAppStore } from '../../src/state/appStore';
import { establishApiSession } from '../../src/account/apiSession';

const CANONICAL_USER = '33333333-3333-4333-8333-333333333333';
const OWNER = canonicalDataOwner(CANONICAL_USER);
const API_SESSION: MockApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'bearer',
  canonicalAppUserId: CANONICAL_USER,
  provider: 'apple',
};

// GET /v1/me wire shape (parseServerProfile) and the Profile it hydrates to.
const serverProfile: Profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: focusForGoal('drops'),
};

function profileResponse(): Response {
  return new Response(
    JSON.stringify({
      onboardingState: 'complete',
      profile: {
        skill_level: '3.5',
        handedness: 'right',
        primary_goal: 'drops',
        biggest_problem: 'control',
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  mockKvTable.clear();
  mockApiSession = null;
  mockApiSessionListeners.clear();
  setActiveDataOwner(OWNER);
});

afterEach(() => {
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('startup hydrate without a local profile', () => {
  it('A: the launch continues at the 8 s budget while GET /v1/me is still pending, and the late profile is adopted', async () => {
    jest.useFakeTimers();
    mockApiSession = API_SESSION;
    const calls: string[] = [];
    let release!: () => void;
    // A stalled network: the promise settles only when the test releases it
    // (or the caller aborts).
    globalThis.fetch = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          calls.push(String(input));
          release = () => resolve(profileResponse());
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('AbortError')),
          );
        }),
    ) as unknown as typeof fetch;

    const hydration = useAppStore.getState().hydrate();
    await flushMicrotasks();
    expect(calls).toEqual(['https://api.test/v1/me']);
    expect(useAppStore.getState().hydrated).toBe(false);

    await jest.advanceTimersByTimeAsync(7_999);
    expect(useAppStore.getState().hydrated).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await hydration;
    // Launch budget reached: the Gate is unblocked, the profile is still
    // unknown, and no error/questionnaire state is reported.
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: OWNER,
      profile: null,
      hydrateError: null,
      canonicalProfilePending: true,
    });

    // The response lands well after the budget (but before the 15 s abort).
    await jest.advanceTimersByTimeAsync(4_000);
    release();
    await flushMicrotasks();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: OWNER,
      profile: serverProfile,
      hydrateError: null,
      canonicalProfilePending: false,
    });
    expect(JSON.parse(mockKvTable.get(`profile:${OWNER}`) ?? 'null')).toEqual(
      serverProfile,
    );
    expect(calls).toHaveLength(1);
  });

  it('A2: a fetch that fails after the budget surfaces hydrateError (retry state), never the questionnaire', async () => {
    jest.useFakeTimers();
    mockApiSession = API_SESSION;
    globalThis.fetch = jest.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('AbortError')),
          );
        }),
    ) as unknown as typeof fetch;

    const hydration = useAppStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydration;
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
      hydrateError: null,
      canonicalProfilePending: true,
    });
    // onboarding.ts aborts its request at 15 s → the pending state resolves
    // into the retryable error state.
    await jest.advanceTimersByTimeAsync(7_000);
    await flushMicrotasks();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
      hydrateError: expect.stringMatching(/could not reach your account/i),
      canonicalProfilePending: false,
    });
  });

  it('B: with the refresh still pending (no API session), the store stays pending and adopts the canonical profile once the session is established', async () => {
    mockApiSession = null; // refresh has not landed → establishApiSession() not yet called
    globalThis.fetch = jest.fn(async () => {
      throw new Error('fetch must not be called without an API session');
    }) as unknown as typeof fetch;

    await useAppStore.getState().hydrate();
    // Gate: ready && session && !profile && !hydrateError would render
    // <OnboardingScreen /> — so the pending flag MUST be raised here.
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: OWNER,
      profile: null,
      hydrateError: null,
      canonicalProfilePending: true,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Tokens land: authStore.installApiSession/adoptRotatedTokens call
    // establishApiSession() — desiredOwner does not change, so no second
    // hydrate() happens. The store must fetch the canonical profile itself.
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      void input;
      return profileResponse();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    establishApiSession(API_SESSION);
    await flushMicrotasks();
    for (let i = 0; i < 50 && useAppStore.getState().profile === null; i += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.test/v1/me');
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: OWNER,
      profile: serverProfile,
      hydrateError: null,
      canonicalProfilePending: false,
    });
    expect(JSON.parse(mockKvTable.get(`profile:${OWNER}`) ?? 'null')).toEqual(
      serverProfile,
    );

    // A later rotation (establishApiSession again) fetches nothing more.
    establishApiSession({ ...API_SESSION, bearerToken: 'rotated' });
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('B2: an API session for a DIFFERENT owner does not settle the wait', async () => {
    mockApiSession = null;
    const fetchMock = jest.fn(async () => profileResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().canonicalProfilePending).toBe(true);

    establishApiSession({
      ...API_SESSION,
      canonicalAppUserId: '99999999-9999-4999-8999-999999999999',
    });
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      profile: null,
      canonicalProfilePending: true,
    });
  });
});
