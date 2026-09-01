/**
 * auth-session-lifecycle reproduction: what the mobile client does once its
 * bearer stops being accepted (provider identity token past `exp`, Apple
 * credential revoked, account deleted elsewhere…).
 *
 * Facts pinned here, each of which the audit reports as a defect:
 *   1. The bearer stored after bootstrap IS the raw provider identity token
 *      (authStore → bootstrap → apiSession). No server-issued session, no
 *      refresh token, nothing to rotate.
 *   2. Once the server answers 401, every client (generic transport / outbox,
 *      training, billing) surfaces an error but NONE of them touches the auth
 *      store: the user stays "signed in", the dead bearer stays installed, and
 *      the native provider is never asked for a fresh token.
 *   3. The outbox treats 401 as transient, so a stale-bearer row is retried
 *      on every 30 s tick forever without consuming its attempt budget.
 *
 * Mock style follows authHydrateRestore.test.ts (in-memory kv LocalDb,
 * module mocks for the provider SDKs, jest.fn fetch).
 */
import { NativeModules } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
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
  it('generic transport (outbox sync): a 401 leaves the dead bearer + "signed in" state in place and retries forever', async () => {
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

    // The lone request path surfaces a typed 401 and nothing else happens.
    await expect(
      transport.syncShots([analysis as unknown as Record<string, unknown>]),
    ).rejects.toMatchObject({ status: 401 });

    // Simulate three 30 s outbox ticks with the same expired bearer.
    for (let tick = 0; tick < 3; tick++) {
      const result = await drainOutbox(mockCurrentDb(), transport);
      expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    }
    // 4 requests, every one with the same dead token…
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers?.authorization).toBe(`Bearer ${token}`);
    }
    // …the row never consumes its attempt budget (401 is "transient")…
    expect(isPermanentSyncFailure(new ApiError(401, 'unauthorized', 'x'))).toBe(
      false,
    );
    expect(mockOutbox[0]).toMatchObject({
      attempts: 0,
      last_error: expect.stringContaining('could not be verified'),
    });
    // …and no layer reacts: auth store still "signed in" with the same
    // bearer, no error surfaced, provider never re-prompted.
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()?.bearerToken).toBe(token);
    expect(signInWithApple).toHaveBeenCalledTimes(1);
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

  it('billing client: 401 is indistinguishable from a backend outage and has no auth side effect', async () => {
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
    });
    // Same code + message a 503 would produce.
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
    expect((outage as BillingError).code).toBe((caught as BillingError).code);
    expect((outage as BillingError).message).toBe(
      (caught as BillingError).message,
    );
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(getApiSession()?.bearerToken).toBe(token);
  });
});
