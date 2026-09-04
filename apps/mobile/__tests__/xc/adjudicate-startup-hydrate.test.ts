/**
 * Adjudication repro (xc-performance / perf-startup-hydrate).
 *
 * Gate (App.tsx) keeps the splash overlay up until `useAppStore.hydrated` is
 * true. On a device whose SQLite has no local profile for the signed-in owner
 * (fresh reinstall keeps the Keychain session but not the database):
 *
 *  A. with an established API session, appStore.hydrate() awaits GET /v1/me
 *     under the onboarding request's own 15 s AbortController — no launch
 *     budget bounds that step, so `hydrated` stays false for the full 15 s;
 *  B. when the launch refresh has NOT landed yet (authStore gives up waiting
 *     after LAUNCH_REFRESH_WAIT_MS = 8 s and continues 'offline'),
 *     getApiSession() is null, so hydrate() resolves with
 *     { hydrated: true, profile: null, hydrateError: null } — the exact state
 *     Gate renders as <OnboardingScreen /> for an account that already has a
 *     canonical profile; nothing re-hydrates when the tokens land later.
 */
import type { Profile } from '../../src/state/profile';
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

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

import { useAppStore } from '../../src/state/appStore';

const CANONICAL_USER = '33333333-3333-4333-8333-333333333333';
const OWNER = canonicalDataOwner(CANONICAL_USER);

const serverProfile: Profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

beforeEach(() => {
  mockKvTable.clear();
  setActiveDataOwner(OWNER);
});

afterEach(() => {
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('adjudicate: startup hydrate without a local profile', () => {
  it('A: GET /v1/me holds hydrated=false for the request timeout (15 s), beyond the 8 s launch budget', async () => {
    jest.useFakeTimers();
    mockApiSession = {
      apiBaseUrl: 'https://api.test',
      bearerToken: 'bearer',
      canonicalAppUserId: CANONICAL_USER,
      provider: 'apple',
    };
    const calls: string[] = [];
    // A stalled network: the promise only settles when the caller aborts.
    globalThis.fetch = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          calls.push(String(input));
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('AbortError')),
          );
        }),
    ) as unknown as typeof fetch;

    const hydration = useAppStore.getState().hydrate();
    await Promise.resolve();
    await Promise.resolve();
    // Drain microtasks up to the fetch call.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(calls).toEqual(['https://api.test/v1/me']);

    await jest.advanceTimersByTimeAsync(8_000);
    expect(useAppStore.getState().hydrated).toBe(false);
    await jest.advanceTimersByTimeAsync(6_999);
    expect(useAppStore.getState().hydrated).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await hydration;
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.hydrateError).toMatch(/could not/i);
  });

  it('B: with the refresh still pending (no API session), hydrate lands on the OnboardingScreen branch for a profiled account', async () => {
    mockApiSession = null; // refresh has not landed → establishApiSession() not yet called
    globalThis.fetch = jest.fn(async () => {
      throw new Error('fetch must not be called without an API session');
    }) as unknown as typeof fetch;

    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    // Gate: ready && session && !profile && !hydrateError → <OnboardingScreen />
    expect(state).toMatchObject({
      hydrated: true,
      ownerKey: OWNER,
      profile: null,
      hydrateError: null,
    });

    // Tokens land later: the store exposes no subscription that re-hydrates,
    // and the canonical profile is still not fetched.
    mockApiSession = {
      apiBaseUrl: 'https://api.test',
      bearerToken: 'bearer',
      canonicalAppUserId: CANONICAL_USER,
      provider: 'apple',
    };
    globalThis.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ profile: serverProfile }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    await new Promise<void>(resolve => setTimeout(() => resolve(), 20));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().profile).toBeNull();
  });
});
