/**
 * auth-session-lifecycle reproduction: what the mobile client does once its
 * bearer stops being accepted (provider identity token past `exp`, Apple
 * credential revoked, account deleted elsewhere…).
 *
 * Facts pinned here:
 *   1. The bearer stored after bootstrap IS the raw provider identity token
 *      (authStore → bootstrap → apiSession). No server-issued session, no
 *      refresh token, nothing to rotate.
 *   2. Once the server answers 401, the generic transport and the billing
 *      client report the rejected bearer to the auth store, which stops every
 *      retry loop and (for Apple, which has no silent restore) lands the user
 *      signed out with an honest "sign-in expired" reason.
 *   3. The outbox treats 401 as transient: the queued row keeps its attempt
 *      budget for the next sign-in instead of being abandoned, and the dead
 *      bearer is not replayed once the session is torn down.
 *
 * Mock style follows authHydrateRestore.test.ts (in-memory kv LocalDb,
 * module mocks for the provider SDKs, jest.fn fetch).
 */
import { NativeModules } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  SESSION_EXPIRED_MESSAGE,
  useAuthStore,
} from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { ApiError, createTransport } from '../../src/data/api';
import { drainOutbox, isPermanentSyncFailure } from '../../src/data/sync';
import { createTrainingApi } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import { BillingError } from '../../src/billing/types';

// ─── Module seams ────────────────────────────────────────────────────────────

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

const mockKv = new Map<string, string>();
const mockOutbox: OutboxRow[] = [];

function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('SELECT id, kind, payload')) {
        return {
          rows: mockOutbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .map(r => ({ ...r })),
        };
      }
      if (statement.startsWith('UPDATE outbox')) {
        const row = mockOutbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (statement.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (statement.startsWith('SELECT count(*)')) {
        return {
          rows: [
            {
              n: mockOutbox.filter(row => row.owner_key === params[0]).length,
            },
          ],
        };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../../src/account/deviceContext', () => ({
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const API = 'https://api.example.test';

/** Stand-in for an Apple identity token (RS256 JWT, `exp` minutes after
 * issue). Nothing on the client decodes it — it is an opaque bearer — so a
 * three-segment string tagged with its exp is sufficient here. */
function appleIdentityToken(expSeconds: number): string {
  return `eyJhbGciOiJSUzI1NiJ9.apple-identity-exp-${expSeconds}.sig`;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

const bootstrapOk = () =>
  response({
    user: { id: canonicalId, email: 'pat@example.com' },
    onboardingState: 'complete',
  });
const unauthorized = () =>
  response(
    {
      error: {
        code: 'unauthorized',
        message: 'The identity token could not be verified.',
      },
    },
    401,
  );

const analysis: ShotAnalysis & { analysisPermitId: string } = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

const realFetch = globalThis.fetch;
const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockOutbox.length = 0;
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
});

afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
});

/** Signs in with Apple through the real store + real bootstrap client. */
async function signInWithAppleToken(identityToken: string): Promise<jest.Mock> {
  const signInWithApple = jest.fn().mockResolvedValue({
    user: '001234.abcdef.5678',
    identityToken,
    email: 'pat@privaterelay.appleid.com',
    givenName: 'Pat',
    familyName: 'Player',
  });
  nativeModules.PickleAuth = { signInWithApple };
  const fetchMock = jest.fn().mockResolvedValueOnce(bootstrapOk());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().error).toBeNull();
  expect(useAuthStore.getState().session?.provider).toBe('apple');
  return signInWithApple;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('auth-session-lifecycle: bearer is the provider identity token', () => {
  it('installs the raw Apple identity token as the API bearer — no server session, no refresh material', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = appleIdentityToken(exp);
    await signInWithAppleToken(token);

    const apiSession = getApiSession();
    expect(apiSession).not.toBeNull();
    expect(apiSession?.bearerToken).toBe(token);
    expect(Object.keys(apiSession ?? {}).sort()).toEqual([
      'apiBaseUrl',
      'bearerToken',
      'canonicalAppUserId',
      'provider',
    ]);
    // The bootstrap call itself carried the same identity token.
    const fetchMock = globalThis.fetch as unknown as jest.Mock;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/v1/account/bootstrap`);
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe(
      `Bearer ${token}`,
    );
    // Nothing durable is written for Apple: on the next cold start the user
    // is signed out (no silent path), so this bearer's usable life is bounded
    // by the token's own `exp`.
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
    for (const value of mockKv.values()) {
      expect(value).not.toContain(token);
    }
  });
});

describe('auth-session-lifecycle: 401 handling on every API caller', () => {
  it('generic transport (outbox sync): a 401 tears down the session with an honest reason, keeps the row for the next sign-in, and stops replaying the dead bearer', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = appleIdentityToken(exp);
    const signInWithApple = await signInWithAppleToken(token);
    const owner = canonicalDataOwner(canonicalId);
    expect(getActiveDataOwner()).toBe(owner);

    // Wall clock moves past the token's exp; server now answers 401.
    const fetchMock = jest.fn().mockResolvedValue(unauthorized());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockOutbox.push({
      id: 1,
      owner_key: owner,
      kind: 'shot.sync',
      payload: JSON.stringify(analysis),
      attempts: 0,
      last_error: null,
    });
    const session = getApiSession()!;
    const transport = createTransport({
      baseUrl: session.apiBaseUrl,
      token: session.bearerToken,
    });

    // The first drain records the transient 401 on the row: no attempt is
    // consumed, so the rating is still syncable after the next sign-in.
    const result = await drainOutbox(mockCurrentDb(), transport);
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.authorization).toBe(
      `Bearer ${token}`,
    );
    expect(isPermanentSyncFailure(new ApiError(401, 'unauthorized', 'x'))).toBe(
      false,
    );
    expect(mockOutbox[0]).toMatchObject({
      attempts: 0,
      last_error: expect.stringContaining('could not be verified'),
    });

    // The auth layer reacted: Apple has no silent restore, so the user lands
    // signed out with an honest reason, the bearer is gone, and the sync
    // runtime is torn down. The provider is not re-prompted behind their back.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toMatchObject({
      code: 'auth.session_expired',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(signInWithApple).toHaveBeenCalledTimes(1);

    // A stray tick after teardown sends nothing: the signed-out owner has no
    // rows, so the dead bearer is never replayed and the row stays queued.
    const afterTeardown = await drainOutbox(mockCurrentDb(), transport);
    expect(afterTeardown).toMatchObject({ synced: 0, failed: 0, remaining: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockOutbox).toHaveLength(1);
    expect(mockOutbox[0]).toMatchObject({ owner_key: owner, attempts: 0 });
  });

  it('training client: 401 becomes a non-retryable TrainingError with no auth side effect', async () => {
    const token = appleIdentityToken(Math.floor(Date.now() / 1000) + 600);
    await signInWithAppleToken(token);
    const fetchFn = jest.fn().mockResolvedValue(unauthorized());
    const api = createTrainingApi({ baseUrl: API, token, fetchFn });

    let caught: unknown;
    try {
      await api.listCatalogDrills({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TrainingError);
    expect(caught).toMatchObject({ status: 401, retryable: false });
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(getApiSession()?.bearerToken).toBe(token);
  });

  it('billing client: 401 is a distinct, non-retryable sign-in-expired error and tears down the session', async () => {
    const token = appleIdentityToken(Math.floor(Date.now() / 1000) + 600);
    await signInWithAppleToken(token);
    const fetchFn = jest.fn().mockResolvedValue(unauthorized());
    const client = createCanonicalAccessClient({
      baseUrl: API,
      token,
      fetchFn,
    });

    let caught: unknown;
    try {
      await client.getAccess();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BillingError);
    expect(caught).toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
      message:
        'Your sign-in has expired. Sign in again to check membership access.',
    });
    // A 503 is a retryable outage with different copy.
    const outageFetch = jest.fn().mockResolvedValue(response({}, 503));
    let outage: unknown;
    try {
      await createCanonicalAccessClient({
        baseUrl: API,
        token,
        fetchFn: outageFetch,
      }).getAccess();
    } catch (error) {
      outage = error;
    }
    expect(outage).toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
      message: 'Membership verification is temporarily unavailable.',
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toMatchObject({
      code: 'auth.session_expired',
    });
    expect(getApiSession()).toBeNull();
  });
});
