/**
 * xc-failure-injection-mobile — SQLITE OPEN FAILURE / DISK FULL.
 *
 * `@op-engineering/op-sqlite` is replaced by a controllable handle. The REAL
 * `src/data/db.ts` (singleton + migrations), authStore and appStore run on
 * top of it. Faults:
 *   openFault   'cantopen'         open() throws SQLITE_CANTOPEN
 *               'full_on_migrate'  first CREATE TABLE throws SQLITE_FULL
 *   writeFault  'full'             every INSERT/UPDATE/DELETE rejects SQLITE_FULL
 *   failAtCall  n                  the n-th async execute() rejects (sweep)
 *
 * Ordering matters: open-failure scenarios run FIRST (nothing is cached
 * while open() fails — verified by fix-27), then a recovery scenario caches a
 * healthy handle whose execute() keeps reading the mutable fault flags.
 */
import { NativeModules } from 'react-native';
import {
  runScenario,
  seededRng,
  pick,
  verdictFor,
  type Invariants,
} from '../../../scripts/failure-injection/recorder';

type OpenFault = 'ok' | 'cantopen' | 'full_on_migrate';
type WriteFault = 'ok' | 'full';

const mockSqlite = {
  openFault: 'ok' as OpenFault,
  writeFault: 'ok' as WriteFault,
  failAtCall: null as number | null,
  failMessage: 'database or disk is full (code 13 SQLITE_FULL)',
  opens: 0,
  closes: 0,
  executeCalls: [] as string[],
  kv: new Map<string, string>(),
};

const CANTOPEN =
  '[OP-SQLITE] unable to open database file (code 14 SQLITE_CANTOPEN)';
const FULL = 'database or disk is full (code 13 SQLITE_FULL)';

function mockIsWrite(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql);
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    mockSqlite.opens += 1;
    if (mockSqlite.openFault === 'cantopen') throw new Error(CANTOPEN);
    let migrated = 0;
    return {
      executeSync(sql: string) {
        if (
          mockSqlite.openFault === 'full_on_migrate' &&
          /^\s*CREATE TABLE/i.test(sql)
        ) {
          migrated += 1;
          if (migrated === 1) throw new Error(FULL);
        }
        return { rows: [] };
      },
      async execute(sql: string, params: unknown[] = []) {
        mockSqlite.executeCalls.push(sql.trim().replace(/\s+/g, ' '));
        if (mockSqlite.failAtCall === mockSqlite.executeCalls.length) {
          throw new Error(mockSqlite.failMessage);
        }
        if (mockSqlite.writeFault === 'full' && mockIsWrite(sql)) {
          throw new Error(FULL);
        }
        const statement = sql.trim().replace(/\s+/g, ' ');
        if (statement.startsWith('SELECT value FROM kv')) {
          const value = mockSqlite.kv.get(String(params[0]));
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
          mockSqlite.kv.set(String(params[0]), String(params[1]));
          return { rows: [] };
        }
        return { rows: [] };
      },
      close() {
        mockSqlite.closes += 1;
      },
    };
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(),
    signInSilently: jest.fn(async () => ({
      type: 'noSavedCredentialFound',
      data: null,
    })),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(async () => null),
    revokeAccess: jest.fn(async () => null),
  },
}));
jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));
jest.mock('../../../src/account/deviceContext', () => ({
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

import { useAuthStore } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from '../../../src/account/sessionVault';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import type { Profile } from '../../../src/state/profile';

const SUITE = 'sqlite';
const FILES = {
  openMigrated: 'apps/mobile/src/data/db.ts:251-266',
  getDb: 'apps/mobile/src/data/db.ts:268-284',
  authHydrateDb: 'apps/mobile/src/auth/authStore.ts:551-558',
  authHydrateCatch: 'apps/mobile/src/auth/authStore.ts:600-604',
  appHydrate: 'apps/mobile/src/state/appStore.ts:108-203',
  appHydrateSetKv: 'apps/mobile/src/state/appStore.ts:150-153',
  completeOnboarding: 'apps/mobile/src/state/appStore.ts:204-238',
  persistLocalGuest: 'apps/mobile/src/auth/authStore.ts:174-181',
};

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
const sessionBody = (access: string, refresh: string) => ({
  session: {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});
function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
const bootstrapRoutes = () => ({
  '/v1/account/bootstrap': () =>
    response({
      user: { id: canonicalId, email: 'pat@example.com' },
      onboardingState: 'complete',
      ...sessionBody('access-1', 'refresh-1'),
    }),
  '/v1/auth/refresh': () => response(sessionBody('access-2', 'refresh-2')),
  '/v1/auth/logout': () => response({ ok: true }),
  '/v1/me': () =>
    response({
      onboardingState: 'complete',
      profile: {
        skill_level: '3.5',
        handedness: 'right',
        primary_goal: 'dinks',
        biggest_problem: 'consistency',
      },
    }),
});

async function seedVault() {
  await savePersistedSession({
    version: 1,
    provider: 'apple',
    canonicalAppUserId: canonicalId,
    refreshToken: 'refresh-durable',
    email: 'pat@example.com',
    displayName: 'Pat Player',
  });
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

async function resetWorld() {
  mockSqlite.openFault = 'ok';
  mockSqlite.writeFault = 'ok';
  mockSqlite.failAtCall = null;
  mockSqlite.executeCalls.length = 0;
  mockSqlite.kv.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  await clearPersistedSession();
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn(async () => ({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    })),
  };
  installRoutes(bootstrapRoutes());
}

beforeEach(async () => {
  await resetWorld();
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

describe('xc-failure-injection — SQLite open failure / disk full', () => {
  // ── open() fails: nothing cached ──────────────────────────────────────────
  it('SQ-01 SQLITE_CANTOPEN at launch: authStore.hydrate() settles signed-out with error=null although the Keychain still holds a valid durable session', async () => {
    await runScenario(
      {
        id: 'SQ-01',
        failureClass: 'sqlite',
        suite: SUITE,
        title:
          'open() throws SQLITE_CANTOPEN before the durable session is read',
        seed: 11,
        inputs: { openFault: 'cantopen', message: CANTOPEN, vaultSeeded: true },
        files: [
          FILES.authHydrateDb,
          FILES.authHydrateCatch,
          FILES.openMigrated,
        ],
      },
      async () => {
        await seedVault();
        mockSqlite.openFault = 'cantopen';
        const opensBefore = mockSqlite.opens;
        const fetchMock = globalThis.fetch as jest.Mock;
        await expect(
          useAuthStore.getState().hydrate(),
        ).resolves.toBeUndefined();
        const state = useAuthStore.getState();
        expect(state.hydrated).toBe(true);
        expect(state.session).toBeNull();
        expect(state.error).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mockSqlite.opens).toBe(opensBefore + 1);
        expect(await loadPersistedSession()).not.toBeNull();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'fail',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'hydrate() swallowed SQLITE_CANTOPEN (getDb() is called before loadPersistedSession); hydrated=true, session=null, error=null; the Keychain record was never consulted.',
          expected:
            'A local-database open failure should not sign the user out for the launch (the durable session lives in the Keychain, not SQLite) and should surface a reason.',
        };
      },
    );
  });

  it('SQ-02 SQLITE_CANTOPEN at launch: appStore.hydrate() surfaces hydrateError (App.tsx Gate renders ErrorState with Retry) — no spinner', async () => {
    await runScenario(
      {
        id: 'SQ-02',
        failureClass: 'sqlite',
        suite: SUITE,
        title: 'open() throws SQLITE_CANTOPEN during appStore.hydrate()',
        seed: 12,
        inputs: { openFault: 'cantopen', owner: 'guest' },
        files: [FILES.appHydrate, FILES.openMigrated],
      },
      async () => {
        setActiveDataOwner(GUEST_DATA_OWNER);
        mockSqlite.openFault = 'cantopen';
        await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();
        const state = useAppStore.getState();
        expect(state.hydrated).toBe(true);
        expect(state.profile).toBeNull();
        expect(state.hydrateError).toBe(CANTOPEN);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `hydrated=true, hydrateError=${JSON.stringify(state.hydrateError)}.`,
          expected:
            'Surfaced. (Copy note: the raw SQLite driver text is what the user sees.)',
        };
      },
    );
  });

  it('SQ-03 SQLITE_FULL during the first migration: handle closed, not cached; the next hydrate after recovery restores the durable session', async () => {
    await runScenario(
      {
        id: 'SQ-03',
        failureClass: 'sqlite',
        suite: SUITE,
        title: 'CREATE TABLE throws SQLITE_FULL, then the disk recovers',
        seed: 13,
        inputs: { openFault: 'full_on_migrate → ok', vaultSeeded: true },
        files: [FILES.openMigrated, FILES.getDb, FILES.authHydrateDb],
      },
      async () => {
        await seedVault();
        mockSqlite.openFault = 'full_on_migrate';
        const opensBefore = mockSqlite.opens;
        const closesBefore = mockSqlite.closes;
        await useAuthStore.getState().hydrate();
        expect(useAuthStore.getState().hydrated).toBe(true);
        expect(useAuthStore.getState().session).toBeNull();
        expect(mockSqlite.opens).toBe(opensBefore + 1);
        expect(mockSqlite.closes).toBe(closesBefore + 1);

        mockSqlite.openFault = 'ok';
        useAuthStore.setState({ hydrated: false, session: null });
        await useAuthStore.getState().hydrate();
        const restored = useAuthStore.getState();
        expect(restored.hydrated).toBe(true);
        expect(restored.session?.canonicalAppUserId).toBe(canonicalId);
        expect(mockSqlite.opens).toBe(opensBefore + 2);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'n/a',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'Failed handle closed and not cached; after recovery the second hydrate re-opened, migrated and restored the session via /v1/auth/refresh.',
          expected: 'Recoverable without relaunch (fix-27 contract).',
        };
      },
    );
  });

  // ── handle cached from SQ-03; execute() honours writeFault/failAtCall ────
  it('SQ-04 disk full on every write during Apple sign-in: sign-in completes (kv writes are best-effort), durable session still restores on relaunch', async () => {
    await runScenario(
      {
        id: 'SQ-04',
        failureClass: 'sqlite',
        suite: SUITE,
        title:
          'INSERT OR REPLACE INTO kv rejects SQLITE_FULL during signInWithApple',
        seed: 14,
        inputs: { writeFault: 'full' },
        files: [
          FILES.persistLocalGuest,
          'apps/mobile/src/auth/authStore.ts:185-196',
        ],
      },
      async () => {
        mockSqlite.writeFault = 'full';
        await expect(
          useAuthStore.getState().signInWithApple(),
        ).resolves.toBeUndefined();
        const state = useAuthStore.getState();
        expect(state.error).toBeNull();
        expect(state.busy).toBe(false);
        expect(state.session?.canonicalAppUserId).toBe(canonicalId);
        expect(
          mockSqlite.executeCalls.some(sql =>
            sql.startsWith('INSERT OR REPLACE INTO kv'),
          ),
        ).toBe(true);

        stopSessionKeeper();
        clearApiSession();
        useAuthStore.setState({ hydrated: false, session: null });
        await useAuthStore.getState().hydrate();
        expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
          canonicalId,
        );
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'n/a',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'Sign-in succeeded with kv writes rejecting SQLITE_FULL; relaunch restored the account from the Keychain record.',
          expected:
            'kv flags are non-identity, best-effort state; fail-soft is correct.',
        };
      },
    );
  });

  it('SQ-05 disk full while caching the canonical profile: appStore.hydrate() surfaces the raw SQLite text as hydrateError and discards the profile it just fetched', async () => {
    await runScenario(
      {
        id: 'SQ-05',
        failureClass: 'sqlite',
        suite: SUITE,
        title:
          'setKv(profile) rejects SQLITE_FULL after /v1/me returned a profile',
        seed: 15,
        inputs: {
          writeFault: 'full',
          owner: 'canonical',
          localProfile: null,
          canonicalProfile: 'present',
        },
        files: [FILES.appHydrateSetKv, FILES.appHydrate],
      },
      async () => {
        setActiveDataOwner(canonicalDataOwner(canonicalId));
        establishApiSession({
          apiBaseUrl: 'https://api.example.test',
          bearerToken: 'access-1',
          canonicalAppUserId: canonicalId,
          provider: 'apple',
        });
        mockSqlite.writeFault = 'full';
        const fetchMock = globalThis.fetch as jest.Mock;
        await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();
        const state = useAppStore.getState();
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/me')),
        ).toBe(true);
        expect(state.hydrated).toBe(true);
        expect(state.hydrateError).toBe(FULL);
        expect(state.profile).toBeNull();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed:
            '/v1/me returned a complete profile; the local cache write threw SQLITE_FULL; hydrate ended with profile=null and hydrateError="database or disk is full (code 13 SQLITE_FULL)".',
          expected:
            'A failed local cache write should not block a launch that already has the canonical profile in memory; the surfaced copy should be user-facing, not driver text.',
        };
      },
    );
  });

  it('SQ-06 disk full during completeOnboarding: onboardingError surfaced, busy cleared, store intact', async () => {
    await runScenario(
      {
        id: 'SQ-06',
        failureClass: 'sqlite',
        suite: SUITE,
        title:
          'setKv(profile) rejects SQLITE_FULL in completeOnboarding (guest owner)',
        seed: 16,
        inputs: { writeFault: 'full', owner: 'guest' },
        files: [FILES.completeOnboarding],
      },
      async () => {
        setActiveDataOwner(GUEST_DATA_OWNER);
        mockSqlite.writeFault = 'full';
        const profile: Profile = {
          skillLevel: '3.5',
          handedness: 'right',
          goal: 'dinks',
          biggestProblem: 'consistency',
          focusCheckpoint: 'contact_position',
        };
        await expect(
          useAppStore.getState().completeOnboarding(profile),
        ).resolves.toBeUndefined();
        const state = useAppStore.getState();
        expect(state.onboardingBusy).toBe(false);
        expect(state.onboardingError).toBe(FULL);
        expect(state.profile).toBeNull();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'onboardingBusy=false, onboardingError=SQLITE_FULL text, profile unchanged.',
          expected: 'Surfaced and retryable. (Copy note: raw driver text.)',
        };
      },
    );
  });

  it('SQ-07 seeded sweep ×24: the k-th execute() during a signed-in launch rejects — hydrate always settles; matrix shows which statement index drops the durable session', async () => {
    const kinds = [
      'database or disk is full (code 13 SQLITE_FULL)',
      'disk I/O error (code 10 SQLITE_IOERR)',
      'database is locked (code 5 SQLITE_BUSY)',
    ];
    const rows: {
      seed: number;
      failAtCall: number;
      kind: string;
      restored: boolean;
      failedStatement: string | null;
    }[] = [];
    for (let seed = 200; seed < 224; seed += 1) {
      const rng = seededRng(seed);
      const failAtCall = 1 + Math.floor(rng() * 6);
      const kind = pick(rng, kinds);
      await runScenario(
        {
          id: `SQ-07/${seed}`,
          failureClass: 'sqlite',
          suite: SUITE,
          title: 'signed-in launch with one rejecting SQLite statement',
          seed,
          inputs: { failAtCall, kind },
          files: [FILES.authHydrateDb, FILES.authHydrateCatch],
        },
        async () => {
          await resetWorld();
          await seedVault();
          mockSqlite.failAtCall = failAtCall;
          mockSqlite.failMessage = kind;
          await expect(
            useAuthStore.getState().hydrate(),
          ).resolves.toBeUndefined();
          const state = useAuthStore.getState();
          expect(state.hydrated).toBe(true);
          const restored = state.session?.canonicalAppUserId === canonicalId;
          const failedStatement =
            mockSqlite.executeCalls[failAtCall - 1] ?? null;
          // The two kv reads that precede loadPersistedSession are fatal to
          // the launch; anything after the Keychain read is not.
          const readBeforeVault = failAtCall <= 2;
          expect(restored).toBe(!readBeforeVault);
          rows.push({ seed, failAtCall, kind, restored, failedStatement });
          const invariants: Invariants = {
            noInfiniteSpinner: 'pass',
            noStoreCrash: 'pass',
            noSilentFailure: restored ? 'pass' : 'fail',
          };
          return {
            invariants,
            verdict: verdictFor(invariants),
            observed: `execute#${failAtCall} (${failedStatement ?? 'never reached'}) rejected ${kind}; restored=${restored}.`,
            expected:
              'Hydrate settles; a kv read failure before the Keychain read should not drop the durable session.',
          };
        },
      );
    }
    expect(rows).toHaveLength(24);
    expect(rows.some(row => row.restored)).toBe(true);
    expect(rows.some(row => !row.restored)).toBe(true);
  });
});
