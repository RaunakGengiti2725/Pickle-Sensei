/**
 * Fuzz: Keychain session-vault payloads → sessionVault + authStore.hydrate.
 *
 * The vault item (`com.picklesensei.auth.session`) is replaced with
 * adversarial content and the real launch path runs against a fetch stub
 * whose `/v1/auth/refresh` accepts any refresh token. Contract under test
 * (AGENTS.md "Auth sessions"): a malformed record is DISCARDED (parser
 * returns null AND the item is cleared) and the launch lands signed-out with
 * `hydrated: true`; a well-formed record signs the canonical account in and
 * scopes the data owner to it; nothing throws out of the store.
 *
 * Scale: FUZZ_CASES (default 200) cases × 15 generators × 2 surfaces.
 * Replay one case: FUZZ_SEED=<seed> FUZZ_REPLAY=<surface>:<generator>:<index>
 * Report: artifacts/fuzz-mobile-persisted-state/<FUZZ_RUN_ID>/vault.json
 */
import { FuzzDb } from '../__fuzz__/support/fakeDb';
import {
  FUZZ_TEST_TIMEOUT_MS,
  FuzzRun,
  accepted,
  invariant,
  rejected,
  type Surface,
} from '../__fuzz__/support/harness';
import { VAULT_RECORD_TEMPLATE } from '../__fuzz__/support/templates';
import type { GeneratedInput } from '../__fuzz__/support/generators';

const mockFuzzDb = new FuzzDb();
jest.mock('../src/data/db', () => ({ getDb: () => mockFuzzDb }));

jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));
jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
  },
}));
jest.mock('../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

import * as Keychain from 'react-native-keychain';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../src/account/sessionVault';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { useAuthStore } from '../src/auth/authStore';
import { stopSessionKeeper } from '../src/account/sessionKeeper';
import { clearSyncRuntime } from '../src/data/syncRuntime';
import { clearApiSession } from '../src/account/apiSession';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const run = new FuzzRun('vault');
/** Same shape `accountScope.ts` enforces for owner keys. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_ID = (VAULT_RECORD_TEMPLATE as { canonicalAppUserId: string })
  .canonicalAppUserId;

const realFetch = globalThis.fetch;
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function installRefreshRoute(): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.endsWith('/v1/auth/refresh')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          session: {
            accessToken: 'access-rotated',
            refreshToken: 'refresh-rotated',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
      } as unknown as Response;
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function seedVault(input: GeneratedInput): void {
  __keychainStore.clear();
  // Real Keychain reads are strings; the typed_value generator stands in for
  // a native bridge handing back something else (null, a number, bytes).
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: input.value as string,
  });
}

function vaultCleared(): boolean {
  return !__keychainStore.has(SESSION_VAULT_SERVICE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionConforms(session: unknown): string | null {
  if (!isPlainObject(session)) return 'not an object';
  if (session['version'] !== 1) return `version=${String(session['version'])}`;
  if (session['provider'] !== 'apple' && session['provider'] !== 'google') {
    return `provider=${String(session['provider'])}`;
  }
  if (
    typeof session['canonicalAppUserId'] !== 'string' ||
    !session['canonicalAppUserId']
  ) {
    return 'canonicalAppUserId missing';
  }
  if (typeof session['refreshToken'] !== 'string' || !session['refreshToken']) {
    return 'refreshToken missing';
  }
  if (session['email'] !== null && typeof session['email'] !== 'string') {
    return `email is ${typeof session['email']}`;
  }
  if (
    session['displayName'] !== null &&
    typeof session['displayName'] !== 'string'
  ) {
    return `displayName is ${typeof session['displayName']}`;
  }
  return null;
}

function resetAuth(): void {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockFuzzDb.reset();
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
}

const surfaces: Surface[] = [
  {
    name: 'sessionVault.loadPersistedSession',
    template: VAULT_RECORD_TEMPLATE,
    run: async input => {
      seedVault(input);
      const session = await loadPersistedSession();
      if (session === null) {
        return vaultCleared()
          ? rejected('discarded and cleared')
          : invariant('malformed record rejected but LEFT in the Keychain');
      }
      const problem = sessionConforms(session);
      if (problem)
        return invariant(`non-conforming session returned: ${problem}`);
      if (vaultCleared()) return invariant('valid record was cleared');
      return accepted();
    },
  },
  {
    name: 'authStore.hydrate.vault',
    template: VAULT_RECORD_TEMPLATE,
    knownInvariant: {
      finding:
        'vault record with a non-UUID canonicalAppUserId passes parsePersistedSession, then canonicalDataOwner() throws inside restorePersistedSession; hydrate() lands signed out but the record is never cleared, so every launch repeats the silent sign-out until the user signs in again',
      files: [
        'apps/mobile/src/account/sessionVault.ts:56-65',
        'apps/mobile/src/auth/authStore.ts:393',
        'apps/mobile/src/auth/authStore.ts:600-604',
        'apps/mobile/src/data/accountScope.ts:15-21',
      ],
      detail: /signed out but vault item kept \(non-UUID canonicalAppUserId/,
    },
    run: async input => {
      resetAuth();
      seedVault(input);
      const fetchMock = installRefreshRoute();
      try {
        await useAuthStore.getState().hydrate();
      } finally {
        stopSessionKeeper();
      }
      const state = useAuthStore.getState();
      if (!state.hydrated) return invariant('hydrated stayed false');
      if (state.session === null) {
        if (!vaultCleared()) {
          const kept = __keychainStore.get(SESSION_VAULT_SERVICE)?.password;
          const parsed = await loadPersistedSession();
          const id = parsed?.canonicalAppUserId ?? '';
          const nonUuid = parsed !== null && !UUID_PATTERN.test(id.trim());
          return invariant(
            nonUuid
              ? `signed out but vault item kept (non-UUID canonicalAppUserId ${JSON.stringify(id.slice(0, 48))})`
              : `signed out but vault item kept (record ${JSON.stringify((kept ?? '').slice(0, 80))})`,
          );
        }
        if (getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER) {
          return invariant(`signed out but owner=${getActiveDataOwner()}`);
        }
        if (fetchMock.mock.calls.length !== 0) {
          return invariant('refresh attempted for a discarded record');
        }
        return rejected('signed out; vault cleared');
      }
      if (state.session.localOnly)
        return invariant('vault produced a local session');
      const id = state.session.canonicalAppUserId;
      if (typeof id !== 'string' || !id)
        return invariant('session without canonical id');
      if (getActiveDataOwner() !== canonicalDataOwner(id)) {
        return invariant(`owner=${getActiveDataOwner()} for session ${id}`);
      }
      if (fetchMock.mock.calls.length === 0) {
        return invariant('signed in without attempting a refresh');
      }
      return id === CANONICAL_ID
        ? accepted()
        : accepted(`different canonical id ${id.slice(0, 12)}…`);
    },
  },
];

describe('fuzz: Keychain vault payloads → session restore', () => {
  afterEach(() => {
    stopSessionKeeper();
  });
  afterAll(() => {
    resetAuth();
    __keychainStore.clear();
    globalThis.fetch = realFetch;
    const path = run.write();
    console.info(`[fuzz vault] report: ${path}\n${run.renderMatrix()}`);
  });

  for (const surface of surfaces) {
    (run.targets(surface.name) ? it : it.skip)(
      `${surface.name}: malformed records are discarded, never thrown, never trusted`,
      async () => {
        const summary = await run.fuzzSurface(surface);
        expect(summary.cases).toBeGreaterThan(0);
        expect(run.assertions(surface)).toEqual([]);
      },
      FUZZ_TEST_TIMEOUT_MS,
    );
  }
});
