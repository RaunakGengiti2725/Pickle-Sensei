/**
 * What happens the instant the server confirms deletion
 * (`authStore.completeAccountDeletion`): the runtime is signed out, the
 * device is left in the signed-out owner bucket, the Keychain session record
 * goes with the account (the next launch must not try to refresh a deleted
 * account), every owner-partitioned table and owner-scoped kv namespace for
 * the deleted account is purged in ONE transaction (retried, and its outcome
 * reported through `deletionCleanup`), and the Google SDK is fully
 * disconnected so the deleted account cannot be silently restored on next
 * launch.
 */

type FixtureRow = Record<string, unknown>;
const mockExecuted: Array<{ sql: string; params: unknown[] }> = [];
const mockRows = new Map<string, FixtureRow[]>();
let mockTransaction: Map<string, FixtureRow[]> | null = null;
let mockFailOn: ((sql: string) => boolean) | null = null;

const mockDb: LocalDb = {
  async execute(sql, params = []) {
    mockExecuted.push({ sql, params });
    if (mockFailOn?.(sql)) throw new Error(`sqlite: ${sql}`);
    if (sql === 'BEGIN IMMEDIATE') {
      if (mockTransaction) throw new Error('nested fixture transaction');
      mockTransaction = new Map(
        [...mockRows].map(([table, rows]) => [table, [...rows]]),
      );
    } else if (sql === 'COMMIT') {
      mockTransaction = null;
    } else if (sql === 'ROLLBACK' && mockTransaction) {
      mockRows.clear();
      for (const [table, rows] of mockTransaction) mockRows.set(table, rows);
      mockTransaction = null;
    } else if (sql.startsWith('SELECT uri, payload FROM local_capture')) {
      const rows = mockRows.get('local_capture') ?? [];
      return {
        rows: rows.filter(row =>
          sql.includes('owner_key <> ?')
            ? row.owner_key !== params[0]
            : row.owner_key === params[0],
        ),
      };
    } else if (sql.startsWith('DELETE FROM ')) {
      const table = sql.split(' ')[2]!;
      const key = table === 'kv' ? 'key' : 'owner_key';
      expect(sql).toBe(`DELETE FROM ${table} WHERE ${key} = ?`);
      mockRows.set(
        table,
        (mockRows.get(table) ?? []).filter(row => row[key] !== params[0]),
      );
    } else if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      mockRows.set('kv', [
        ...(mockRows.get('kv') ?? []).filter(row => row.key !== params[0]),
        { key: params[0], value: params[1] },
      ]);
    } else if (sql.startsWith('SELECT value FROM kv')) {
      return {
        rows: (mockRows.get('kv') ?? []).filter(row => row.key === params[0]),
      };
    }
    return { rows: [] };
  },
  close: () => undefined,
};
jest.mock('../../src/data/db', () => ({ getDb: () => mockDb }));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: jest.fn(),
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
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    appVersion: '1.0',
  }),
}));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  revokeAccess: jest.fn(() => Promise.resolve()),
  signOut: jest.fn(() => Promise.resolve()),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

import React from 'react';
import { Modal, NativeModules } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';
import {
  captureAccountDeletionScope,
  useAuthStore,
  type AuthSession,
} from '../../src/auth/authStore';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { showBrandNotice } from '../../src/design/BrandNotice';
import type { LocalDb } from '../../src/data/db';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  savePersistedSession,
} from '../../src/account/sessionVault';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { OWNER_SCOPED_KV_NAMESPACES } from '../../src/data/repository';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// The auto-mock (__mocks__/react-native-keychain.ts) exposes its in-memory
// store so the test can seed the durable session and assert it is gone.
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const CAPTURE_ROOT =
  'file:///synthetic-only/Library/Application%20Support/PickleSensei/Captures/';
const TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
];
const mockDeleteCaptureFiles = jest.fn();
const realFetch = globalThis.fetch;
const renderers: TestRenderer.ReactTestRenderer[] = [];

function signedIn(provider: 'google' | 'apple', owner = OWNER): AuthSession {
  return {
    provider,
    subject: owner,
    canonicalAppUserId: owner,
    localOnly: false,
    displayName: 'Alex Chen',
    email: 'alex@example.com',
  };
}

async function arrange(
  provider: 'google' | 'apple',
  owner = OWNER,
  token = owner,
) {
  useAuthStore.setState({
    hydrated: true,
    session: signedIn(provider, owner),
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `access-${token}`,
    canonicalAppUserId: owner,
    provider,
    refreshToken: `refresh-${token}`,
    bearerExpiresAtMs: Date.now() + 3_600_000,
  });
  // The durable sign-in: what a relaunch would use to come back signed in.
  await savePersistedSession({
    version: 1,
    provider,
    canonicalAppUserId: owner,
    refreshToken: `refresh-${token}`,
    email: 'alex@example.com',
    displayName: 'Alex Chen',
  });
  mockRows.set('kv', [
    ...(mockRows.get('kv') ?? []).filter(
      row => row.key !== 'auth.last-provider',
    ),
    {
      key: 'auth.last-provider',
      value: JSON.stringify({ version: 1, provider }),
    },
  ]);
  expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
}

function seedOwnerRows(owner = OWNER) {
  for (const table of TABLES) {
    mockRows.set(table, [
      ...(mockRows.get(table) ?? []),
      {
        id: `${table}-${owner}`,
        owner_key: owner,
        ...(table === 'local_capture'
          ? {
              uri: `${CAPTURE_ROOT}${owner}.mov`,
              payload: JSON.stringify({
                uri: `${CAPTURE_ROOT}${owner}.mov`,
                posterUri: `${CAPTURE_ROOT}${owner}.jpg`,
                poseSequence: { uri: `${CAPTURE_ROOT}${owner}.pose.json` },
              }),
            }
          : {}),
      },
    ]);
  }
  mockRows.set('kv', [
    ...(mockRows.get('kv') ?? []),
    ...OWNER_SCOPED_KV_NAMESPACES.map(namespace => ({
      key: `${namespace}:${owner}`,
      value: `fixture-${namespace}-${owner}`,
    })),
  ]);
}

function ownerRows(owner: string) {
  return [...mockRows].flatMap(([table, rows]) =>
    rows
      .filter(row =>
        table === 'kv'
          ? String(row.key).endsWith(`:${owner}`)
          : row.owner_key === owner,
      )
      .map(row => ({ table, ...row })),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

async function settle() {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ManageAccountScreen));
  });
  renderers.push(renderer);
  return renderer;
}

function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(Button)
    .find(node => node.props.label === label)!;
}

function control(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0]!;
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    control(renderer, 'Delete account').props.onPress();
  });
  await act(async () => {
    control(renderer, 'Skip the survey').props.onPress();
  });
  await act(async () => {
    button(renderer, 'Continue to delete').props.onPress();
  });
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  expect(button(renderer, 'Permanently delete').props.disabled).toBe(false);
}

function deletionNetwork(
  confirm: Promise<Response>,
  request?: Promise<Response>,
) {
  const network = jest.fn(async (url: string) => {
    if (url.endsWith('/v1/me/delete-request'))
      return (
        request ??
        response({
          challenge: '33333333-3333-4333-8333-333333333333',
          expiresAt: '2099-01-01T00:00:00Z',
        })
      );
    if (url.endsWith('/v1/me/delete-confirm')) return confirm;
    if (url.endsWith('/v1/auth/logout')) return response(null, 204);
    if (url.endsWith('/v1/auth/refresh'))
      return response({
        session: {
          accessToken: 'access-rotated-B',
          refreshToken: 'refresh-rotated-B',
          expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        },
      });
    if (url.endsWith('/v1/account/bootstrap'))
      return response({
        user: { id: OTHER_OWNER, email: 'other@example.test' },
        onboardingState: 'complete',
        session: {
          accessToken: 'access-new-B',
          refreshToken: 'refresh-new-B',
          expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        },
      });
    throw new Error('unconfigured fixture route');
  });
  globalThis.fetch = network as unknown as typeof fetch;
  return network;
}

function expectCurrentOwnerUntouched(
  owner: string,
  session: AuthSession | null,
  vault: unknown,
  installed = true,
) {
  expect(useAuthStore.getState().session).toBe(session);
  expect(useAuthStore.getState().error).toBeNull();
  expect(getActiveDataOwner()).toBe(installed ? owner : SIGNED_OUT_DATA_OWNER);
  if (installed) {
    expect(getApiSession()?.canonicalAppUserId).toBe(owner);
  } else {
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
  }
  expect(__keychainStore.get(SESSION_VAULT_SERVICE)).toEqual(vault);
  expect(
    mockExecuted
      .filter(call => call.sql.startsWith('DELETE '))
      .every(call =>
        call.params.every(
          param => param !== owner && !String(param).endsWith(`:${owner}`),
        ),
      ),
  ).toBe(true);
  expect(mockGoogleSignin.revokeAccess).not.toHaveBeenCalled();
  expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
  expect(
    mockDeleteCaptureFiles.mock.calls.flatMap(([uris]) => uris),
  ).not.toContain(`${CAPTURE_ROOT}${owner}.mov`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuted.length = 0;
  mockRows.clear();
  mockTransaction = null;
  mockFailOn = null;
  __keychainStore.clear();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockGoogleSignin.revokeAccess.mockReset().mockResolvedValue(undefined);
  mockGoogleSignin.signOut.mockReset().mockResolvedValue(undefined);
  mockGoogleSignin.signIn.mockReset().mockResolvedValue({
    type: 'success',
    data: {
      idToken: 'fixture-google-token',
      user: { name: 'Other', email: null },
    },
  });
  mockDeleteCaptureFiles
    .mockReset()
    .mockImplementation(async (uris: string[]) => ({
      results: uris.map((_, index) => ({ index, status: 'deleted' })),
    }));
  NativeModules.PickleVideoCapture = {
    deleteCaptureFiles: mockDeleteCaptureFiles,
  };
  globalThis.fetch = jest.fn(async () => {
    throw new Error('no real network in deletion tests');
  });
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  stopSessionKeeper();
  clearSyncRuntime();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('completeAccountDeletion', () => {
  it('signs the runtime out before touching local data, then purges every owner-scoped row and kv namespace atomically', async () => {
    await arrange('google');
    await useAuthStore.getState().completeAccountDeletion();

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);

    // The Keychain record dies with the account: the next launch must not
    // try (and fail) to refresh a deleted account.
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    // Silent-restore markers are cleared so the next launch cannot revive
    // the deleted account.
    expect(mockExecuted).toContainEqual({
      sql: expect.stringContaining('kv'),
      params: ['auth.local-mode', ''],
    });
    expect(mockExecuted).toContainEqual({
      sql: expect.stringContaining('kv'),
      params: ['auth.last-provider', ''],
    });

    const begin = mockExecuted.findIndex(c => c.sql === 'BEGIN IMMEDIATE');
    const commit = mockExecuted.findIndex(c => c.sql === 'COMMIT');
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    const tx = mockExecuted.slice(begin + 1, commit);
    for (const table of [
      'local_shot',
      'local_session',
      'local_capture',
      'local_analysis_record',
      'outbox',
      'sync_receipt',
    ]) {
      expect(tx).toContainEqual({
        sql: `DELETE FROM ${table} WHERE owner_key = ?`,
        params: [OWNER],
      });
    }
    // repository.ts pins these five namespaces as the owner-scoped kv set
    // (practice sets joined profile, rank, notifications and consistency).
    expect([...OWNER_SCOPED_KV_NAMESPACES]).toEqual([
      'profile',
      'rank.celebrated',
      'notifications',
      'consistency',
      'practice.set',
    ]);
    const kvDeletes = tx
      .filter(c => c.sql === 'DELETE FROM kv WHERE key = ?')
      .map(c => c.params[0]);
    expect(kvDeletes).toEqual([
      `profile:${OWNER}`,
      `rank.celebrated:${OWNER}`,
      `notifications:${OWNER}`,
      `consistency:${OWNER}`,
      `practice.set:${OWNER}`,
    ]);
    expect(mockExecuted.some(c => c.sql === 'ROLLBACK')).toBe(false);
    // One clean pass: the purge is not retried once it committed.
    expect(mockExecuted.filter(c => c.sql === 'BEGIN IMMEDIATE')).toHaveLength(
      1,
    );
    expect(state.deletionCleanup).toEqual({ localPurge: 'complete' });

    // Google account: full disconnect so the SDK cannot silently restore it.
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signOut).toHaveBeenCalledTimes(1);
  });

  it('Apple accounts skip the Google SDK entirely', async () => {
    await arrange('apple');
    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().session).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    expect(mockGoogleSignin.revokeAccess).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
    expect(mockExecuted.some(c => c.sql === 'COMMIT')).toBe(true);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
  });

  it('a failing local purge rolls back, is retried three times, never rethrows, reports itself, and still leaves the user signed out', async () => {
    await arrange('google');
    mockFailOn = sql => sql.startsWith('DELETE FROM outbox');
    await expect(
      useAuthStore.getState().completeAccountDeletion(),
    ).resolves.toEqual({ localPurge: 'failed' });
    // Every attempt is its own rolled-back transaction; none commits.
    expect(mockExecuted.filter(c => c.sql === 'BEGIN IMMEDIATE')).toHaveLength(
      3,
    );
    expect(mockExecuted.filter(c => c.sql === 'ROLLBACK')).toHaveLength(3);
    expect(mockExecuted.some(c => c.sql === 'COMMIT')).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    // The surface that started the deletion is told the rows are still here.
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    // Provider disconnect still runs after a local persistence failure.
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
  });

  it('a purge that succeeds on a retry is reported as complete', async () => {
    await arrange('google');
    let attempts = 0;
    mockFailOn = sql => {
      if (sql === 'BEGIN IMMEDIATE') attempts += 1;
      return sql.startsWith('DELETE FROM outbox') && attempts === 1;
    };
    await useAuthStore.getState().completeAccountDeletion();
    expect(attempts).toBe(2);
    expect(mockExecuted.filter(c => c.sql === 'ROLLBACK')).toHaveLength(1);
    expect(mockExecuted.filter(c => c.sql === 'COMMIT')).toHaveLength(1);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
  });

  it('a Google SDK failure is swallowed — the account is already gone server-side', async () => {
    await arrange('google');
    mockGoogleSignin.revokeAccess.mockRejectedValueOnce(new Error('sdk down'));
    await expect(
      useAuthStore.getState().completeAccountDeletion(),
    ).resolves.toEqual({ localPurge: 'complete' });
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
  });
});

describe('capture cleanup before the account row purge', () => {
  it('awaits native video, poster, and pose deletion before deleting any account rows', async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const own = ownerRows(OWNER);
    const other = ownerRows(OTHER_OWNER);
    const gate = deferred<{
      results: Array<{ index: number; status: string }>;
    }>();
    mockDeleteCaptureFiles.mockReturnValue(gate.promise);
    const completion = useAuthStore.getState().completeAccountDeletion();
    try {
      await settle();
      expect(useAuthStore.getState().session).toBeNull();
      expect(mockDeleteCaptureFiles).toHaveBeenCalledWith([
        `${CAPTURE_ROOT}${OWNER}.mov`,
        `${CAPTURE_ROOT}${OWNER}.jpg`,
        `${CAPTURE_ROOT}${OWNER}.pose.json`,
      ]);
      expect(ownerRows(OWNER)).toEqual(own);
      expect(mockExecuted.some(call => call.sql.startsWith('DELETE '))).toBe(
        false,
      );
    } finally {
      gate.resolve({
        results: [0, 1, 2].map(index => ({ index, status: 'deleted' })),
      });
      await completion;
    }
    expect(ownerRows(OWNER)).toEqual([]);
    expect(ownerRows(OTHER_OWNER)).toEqual(other);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
  });

  it.each([
    'rejection',
    'partial acknowledgement',
    'missing bridge',
    'unreadable payload',
  ])(
    '%s retains every owner row and the capture retry references, reports failed, and stays signed out',
    async failure => {
      await arrange('google');
      seedOwnerRows();
      seedOwnerRows(OTHER_OWNER);
      if (failure === 'rejection')
        mockDeleteCaptureFiles.mockRejectedValue(
          new Error('private native failure'),
        );
      if (failure === 'partial acknowledgement')
        mockDeleteCaptureFiles.mockResolvedValue({
          results: [
            { index: 0, status: 'deleted' },
            { index: 1, status: 'failed' },
            { index: 2, status: 'missing' },
          ],
        });
      if (failure === 'missing bridge')
        NativeModules.PickleVideoCapture = undefined;
      if (failure === 'unreadable payload')
        mockRows.get('local_capture')![0]!.payload = '{';
      const own = ownerRows(OWNER);
      const other = ownerRows(OTHER_OWNER);
      await useAuthStore.getState().completeAccountDeletion();
      expect(useAuthStore.getState().deletionCleanup).toEqual({
        localPurge: 'failed',
      });
      expect(ownerRows(OWNER)).toEqual(own);
      expect(ownerRows(OTHER_OWNER)).toEqual(other);
      expect(
        mockExecuted.filter(
          call =>
            call.sql ===
            'SELECT uri, payload FROM local_capture WHERE owner_key = ?',
        ),
      ).toHaveLength(3);
      expect(mockExecuted.some(call => call.sql === 'BEGIN IMMEDIATE')).toBe(
        false,
      );
      expect(useAuthStore.getState().session).toBeNull();
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
      expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
    },
  );

  it('retries the same file references after a partial failure, accepting already-missing files', async () => {
    await arrange('apple');
    seedOwnerRows();
    mockDeleteCaptureFiles
      .mockResolvedValueOnce({
        results: [
          { index: 0, status: 'deleted' },
          { index: 1, status: 'failed' },
          { index: 2, status: 'missing' },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          { index: 0, status: 'missing' },
          { index: 1, status: 'deleted' },
          { index: 2, status: 'missing' },
        ],
      });
    await useAuthStore.getState().completeAccountDeletion();
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(2);
    expect(mockDeleteCaptureFiles.mock.calls[1]).toEqual(
      mockDeleteCaptureFiles.mock.calls[0],
    );
    expect(ownerRows(OWNER)).toEqual([]);
    expect(mockExecuted.filter(call => call.sql === 'COMMIT')).toHaveLength(1);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
  });
});

describe('session-bound completion retries and in-flight cleanup', () => {
  it('coalesces duplicate completions and remains idempotent after B signs in', async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const other = ownerRows(OTHER_OWNER);
    deletionNetwork(Promise.resolve(response({ deleted: true })));
    const scope = captureAccountDeletionScope();
    const completion = useAuthStore.getState().completeAccountDeletion(scope);
    expect(useAuthStore.getState().completeAccountDeletion(scope)).toBe(
      completion,
    );
    await expect(completion).resolves.toEqual({ localPurge: 'complete' });
    await useAuthStore.getState().signInWithGoogle();
    const current = useAuthStore.getState().session;
    const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
    mockExecuted.length = 0;
    mockGoogleSignin.revokeAccess.mockClear();
    mockGoogleSignin.signOut.mockClear();
    await expect(
      useAuthStore.getState().completeAccountDeletion(scope),
    ).resolves.toEqual({ localPurge: 'complete' });
    expectCurrentOwnerUntouched(OTHER_OWNER, current, vault);
    expect(ownerRows(OTHER_OWNER)).toEqual(other);
    expect(mockExecuted).toEqual([]);
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
  });

  it('retries an explicitly retained A scope after media failure without ever retargeting B', async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const other = ownerRows(OTHER_OWNER);
    deletionNetwork(Promise.resolve(response({ deleted: true })));
    const scope = captureAccountDeletionScope();
    mockDeleteCaptureFiles.mockRejectedValue(
      new Error('fixture media unavailable'),
    );
    await expect(
      useAuthStore.getState().completeAccountDeletion(scope),
    ).resolves.toEqual({ localPurge: 'failed' });
    expect(ownerRows(OWNER)).not.toEqual([]);
    await useAuthStore.getState().signInWithGoogle();
    const current = useAuthStore.getState().session;
    const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
    mockExecuted.length = 0;
    mockGoogleSignin.revokeAccess.mockClear();
    mockGoogleSignin.signOut.mockClear();
    mockDeleteCaptureFiles.mockImplementation(async (uris: string[]) => ({
      results: uris.map((_, index) => ({ index, status: 'missing' })),
    }));
    await expect(
      useAuthStore.getState().completeAccountDeletion(scope),
    ).resolves.toEqual({ localPurge: 'complete' });
    expectCurrentOwnerUntouched(OTHER_OWNER, current, vault);
    expect(ownerRows(OWNER)).toEqual([]);
    expect(ownerRows(OTHER_OWNER)).toEqual(other);
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])(
    'finishes inactive A cleanup when B signs in during blocked media deletion (B still busy: %s)',
    async holdCredentials => {
      await arrange('google');
      seedOwnerRows();
      seedOwnerRows(OTHER_OWNER);
      const own = ownerRows(OWNER);
      const other = ownerRows(OTHER_OWNER);
      const ownFiles = ['mov', 'jpg', 'pose.json'].map(
        extension => `${CAPTURE_ROOT}${OWNER}.${extension}`,
      );
      const otherFiles = ['mov', 'jpg', 'pose.json'].map(
        extension => `${CAPTURE_ROOT}${OTHER_OWNER}.${extension}`,
      );
      const files = new Set([...ownFiles, ...otherFiles]);
      deletionNetwork(Promise.resolve(response({ deleted: true })));
      const media = deferred<void>();
      mockDeleteCaptureFiles.mockImplementation(async (uris: string[]) => {
        await media.promise;
        return {
          results: uris.map((uri, index) => ({
            index,
            status: files.delete(uri) ? 'deleted' : 'missing',
          })),
        };
      });
      const completion = useAuthStore
        .getState()
        .completeAccountDeletion(captureAccountDeletionScope());
      await settle();
      expect(mockDeleteCaptureFiles).toHaveBeenCalledWith(ownFiles);
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(ownerRows(OWNER)).toEqual(own);
      expect([...files]).toEqual([...ownFiles, ...otherFiles]);
      const credentials = deferred<void>();
      if (holdCredentials) {
        const nativeSet = Keychain.setGenericPassword;
        jest
          .spyOn(Keychain, 'setGenericPassword')
          .mockImplementationOnce(async (...args) => {
            await credentials.promise;
            return nativeSet(...args);
          });
      }
      const signingIn = useAuthStore.getState().signInWithGoogle();
      try {
        await settle();
        expect(getActiveDataOwner()).toBe(
          holdCredentials ? SIGNED_OUT_DATA_OWNER : OTHER_OWNER,
        );
        expect(useAuthStore.getState().busy).toBe(holdCredentials);
        const current = useAuthStore.getState().session;
        const api = getApiSession();
        const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
        if (holdCredentials) {
          expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
          expect(current).toBeNull();
          expect(api).toBeNull();
          expect(vault).toBeUndefined();
        }
        const markers = (mockRows.get('kv') ?? []).filter(row =>
          String(row.key).startsWith('auth.'),
        );
        expect(markers).toContainEqual({
          key: 'auth.logout-intent',
          value: holdCredentials
            ? JSON.stringify({ version: 1, guest: false })
            : '',
        });
        for (const credential of [
          OWNER,
          OTHER_OWNER,
          'access-new-B',
          'refresh-new-B',
        ]) {
          expect(JSON.stringify(markers)).not.toContain(credential);
        }
        const successorCleanup = { localPurge: 'not_needed' as const };
        useAuthStore.setState({ deletionCleanup: successorCleanup });
        media.resolve();
        await expect(completion).resolves.toEqual({ localPurge: 'complete' });
        expectCurrentOwnerUntouched(
          OTHER_OWNER,
          current,
          vault,
          !holdCredentials,
        );
        expect(getApiSession()).toBe(api);
        expect(useAuthStore.getState().busy).toBe(holdCredentials);
        expect(useAuthStore.getState().deletionCleanup).toBe(successorCleanup);
        expect(ownerRows(OWNER)).toEqual([]);
        expect(ownerRows(OTHER_OWNER)).toEqual(other);
        expect([...files]).toEqual(otherFiles);
        expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
        expect(
          (mockRows.get('kv') ?? []).filter(row =>
            String(row.key).startsWith('auth.'),
          ),
        ).toEqual(markers);
      } finally {
        media.resolve();
        credentials.resolve();
        await Promise.all([completion, signingIn]);
      }
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        OTHER_OWNER,
      );
      expect(getActiveDataOwner()).toBe(OTHER_OWNER);
      expect(getApiSession()).toMatchObject({
        canonicalAppUserId: OTHER_OWNER,
        bearerToken: 'access-new-B',
        refreshToken: 'refresh-new-B',
      });
      expect(useAuthStore.getState().busy).toBe(false);
      expect(useAuthStore.getState().error).toBeNull();
      expect(mockRows.get('kv')).toContainEqual({
        key: 'auth.logout-intent',
        value: '',
      });
      expect(
        JSON.parse(__keychainStore.get(SESSION_VAULT_SERVICE)!.password),
      ).toMatchObject({
        canonicalAppUserId: OTHER_OWNER,
        refreshToken: 'refresh-new-B',
      });
      expect(mockRows.get('kv')).toContainEqual({
        key: 'auth.last-provider',
        value: JSON.stringify({ version: 1, provider: 'google' }),
      });
    },
  );

  it('a pure B keeper rotation does not fail inactive A cleanup or overwrite B deletion state', async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const other = ownerRows(OTHER_OWNER);
    const scope = captureAccountDeletionScope();
    const network = deletionNetwork(
      Promise.resolve(response({ deleted: true })),
    );
    await useAuthStore.getState().signOut();
    await useAuthStore.getState().signInWithGoogle();
    mockGoogleSignin.signOut.mockClear();
    const successorScope = captureAccountDeletionScope();
    const successorCleanup = { localPurge: 'not_needed' as const };
    useAuthStore.setState({ deletionCleanup: successorCleanup });
    const media = deferred<{
      results: Array<{ index: number; status: string }>;
    }>();
    mockDeleteCaptureFiles.mockReturnValue(media.promise);
    const completion = useAuthStore.getState().completeAccountDeletion(scope);
    try {
      await settle();
      expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
      refreshSessionNow();
      await settle();
      expect(
        network.mock.calls.filter(([url]) => url.endsWith('/v1/auth/refresh')),
      ).toHaveLength(1);
      expect(captureAccountDeletionScope()).toEqual(successorScope);
      const current = useAuthStore.getState().session;
      const api = getApiSession();
      const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
      expect(api?.bearerToken).toBe('access-rotated-B');
      expect(JSON.parse(vault!.password).refreshToken).toBe(
        'refresh-rotated-B',
      );
      media.resolve({
        results: [0, 1, 2].map(index => ({ index, status: 'deleted' })),
      });
      await expect(completion).resolves.toEqual({ localPurge: 'complete' });
      expectCurrentOwnerUntouched(OTHER_OWNER, current, vault);
      expect(getApiSession()).toBe(api);
      expect(ownerRows(OWNER)).toEqual([]);
      expect(ownerRows(OTHER_OWNER)).toEqual(other);
      expect(useAuthStore.getState().deletionCleanup).toBe(successorCleanup);
    } finally {
      media.resolve({
        results: [0, 1, 2].map(index => ({ index, status: 'deleted' })),
      });
      await completion;
    }
  });

  it('keeps all A references and spends the three media attempts on a genuine failure after B signs in', async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const own = ownerRows(OWNER);
    const other = ownerRows(OTHER_OWNER);
    deletionNetwork(Promise.resolve(response({ deleted: true })));
    const media = deferred<void>();
    mockDeleteCaptureFiles.mockImplementation(async () => {
      await media.promise;
      throw new Error('fixture filesystem unavailable');
    });
    const completion = useAuthStore
      .getState()
      .completeAccountDeletion(captureAccountDeletionScope());
    await settle();
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
    await useAuthStore.getState().signInWithGoogle();
    const current = useAuthStore.getState().session;
    const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
    const successorCleanup = { localPurge: 'not_needed' as const };
    useAuthStore.setState({ deletionCleanup: successorCleanup });
    media.resolve();
    await expect(completion).resolves.toEqual({ localPurge: 'failed' });
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(3);
    expectCurrentOwnerUntouched(OTHER_OWNER, current, vault);
    expect(ownerRows(OWNER)).toEqual(own);
    expect(ownerRows(OTHER_OWNER)).toEqual(other);
    expect(useAuthStore.getState().deletionCleanup).toBe(successorCleanup);
    expect(mockExecuted.some(call => call.sql === 'BEGIN IMMEDIATE')).toBe(
      false,
    );
  });

  it('does not purge fresh A rows when A returns during the blocked native cleanup', async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const other = ownerRows(OTHER_OWNER);
    deletionNetwork(Promise.resolve(response({ deleted: true })));
    const media = deferred<{
      results: Array<{ index: number; status: string }>;
    }>();
    mockDeleteCaptureFiles.mockReturnValue(media.promise);
    const completion = useAuthStore
      .getState()
      .completeAccountDeletion(captureAccountDeletionScope());
    await settle();
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
    await useAuthStore.getState().signInWithGoogle();
    await useAuthStore.getState().signOut();
    await arrange('google', OWNER, 'fresh-A');
    const freshUri = `${CAPTURE_ROOT}fresh-A.mov`;
    mockRows.get('local_capture')!.push({
      id: 'fresh-A',
      owner_key: OWNER,
      uri: freshUri,
      payload: null,
    });
    const own = ownerRows(OWNER);
    const current = useAuthStore.getState().session;
    const api = getApiSession();
    const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
    const successorCleanup = { localPurge: 'not_needed' as const };
    useAuthStore.setState({ deletionCleanup: successorCleanup });
    mockGoogleSignin.signOut.mockClear();
    media.resolve({
      results: [0, 1, 2].map(index => ({ index, status: 'deleted' })),
    });
    await expect(completion).resolves.toEqual({ localPurge: 'failed' });
    expect(useAuthStore.getState().session).toBe(current);
    expect(getApiSession()).toBe(api);
    expect(__keychainStore.get(SESSION_VAULT_SERVICE)).toEqual(vault);
    expect(ownerRows(OWNER)).toEqual(own);
    expect(ownerRows(OTHER_OWNER)).toEqual(other);
    expect(useAuthStore.getState().deletionCleanup).toBe(successorCleanup);
    expect(mockExecuted.some(call => call.sql.startsWith('DELETE '))).toBe(
      false,
    );
    expect(
      mockDeleteCaptureFiles.mock.calls.flatMap(([uris]) => uris),
    ).not.toContain(freshUri);
    expect(mockGoogleSignin.revokeAccess).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
  });

  it("a delayed deletion Keychain clear runs before B's save without blocking inactive A cleanup", async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const other = ownerRows(OTHER_OWNER);
    deletionNetwork(Promise.resolve(response({ deleted: true })));
    const gate = deferred<void>();
    const nativeReset = Keychain.resetGenericPassword;
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeReset(...args);
      });
    const completion = useAuthStore
      .getState()
      .completeAccountDeletion(captureAccountDeletionScope());
    await settle();
    const signingIn = useAuthStore.getState().signInWithGoogle();
    await settle();
    gate.resolve();
    const [cleanup] = await Promise.all([completion, signingIn]);
    expect(cleanup).toEqual({ localPurge: 'complete' });
    expect(getApiSession()?.canonicalAppUserId).toBe(OTHER_OWNER);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      OTHER_OWNER,
    );
    expect(
      JSON.parse(__keychainStore.get(SESSION_VAULT_SERVICE)!.password),
    ).toMatchObject({
      canonicalAppUserId: OTHER_OWNER,
      refreshToken: 'refresh-new-B',
    });
    expect(ownerRows(OWNER)).toEqual([]);
    expect(ownerRows(OTHER_OWNER)).toEqual(other);
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.revokeAccess).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
  });

  it('waits for an already-dispatched Google disconnect before allowing B into the SDK', async () => {
    await arrange('google');
    seedOwnerRows();
    deletionNetwork(Promise.resolve(response({ deleted: true })));
    const gate = deferred<void>();
    mockGoogleSignin.revokeAccess.mockReturnValueOnce(gate.promise);
    const completion = useAuthStore
      .getState()
      .completeAccountDeletion(captureAccountDeletionScope());
    await settle();
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
    const signingIn = useAuthStore.getState().signInWithGoogle();
    try {
      await settle();
      expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await Promise.all([completion, signingIn]);
    }
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
    expect(getApiSession()?.canonicalAppUserId).toBe(OTHER_OWNER);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      OTHER_OWNER,
    );
    expect(
      JSON.parse(__keychainStore.get(SESSION_VAULT_SERVICE)!.password),
    ).toMatchObject({
      canonicalAppUserId: OTHER_OWNER,
      refreshToken: 'refresh-new-B',
    });
  });
});

describe('real ManageAccount network callback → real authStore', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
  });

  it.each([false, true])(
    'cleans the original account after a confirmed deletion (unmounted: %s)',
    async unmount => {
      await arrange('google');
      seedOwnerRows();
      seedOwnerRows(OTHER_OWNER);
      const other = ownerRows(OTHER_OWNER);
      const gate = deferred<Response>();
      const network = deletionNetwork(gate.promise);
      const renderer = renderScreen();
      await armDeletion(renderer);
      await act(async () => {
        button(renderer, 'Permanently delete').props.onPress();
      });
      expect(network).toHaveBeenCalledTimes(2);
      if (unmount) act(() => renderer.unmount());
      await act(async () => {
        gate.resolve(response({ deleted: true }));
        await settle();
      });
      expect(useAuthStore.getState().session).toBeNull();
      expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
      expect(ownerRows(OWNER)).toEqual([]);
      expect(ownerRows(OTHER_OWNER)).toEqual(other);
      expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().deletionCleanup).toEqual({
        localPurge: 'complete',
      });
    },
  );

  it.each([false, true])(
    'a late A confirmation cannot erase B credentials, SDK, files, or rows (unmounted: %s)',
    async unmount => {
      await arrange('google');
      seedOwnerRows();
      seedOwnerRows(OTHER_OWNER);
      const other = ownerRows(OTHER_OWNER);
      const gate = deferred<Response>();
      deletionNetwork(gate.promise);
      const renderer = renderScreen();
      await armDeletion(renderer);
      await act(async () => {
        button(renderer, 'Permanently delete').props.onPress();
      });
      await act(async () => {
        await useAuthStore.getState().signOut();
        await arrange('google', OTHER_OWNER);
      });
      if (unmount) {
        act(() => renderer.unmount());
      } else {
        await act(async () => {
          control(renderer, 'Delete account').props.onPress();
        });
      }
      const current = useAuthStore.getState().session;
      const api = getApiSession();
      const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
      const successorCleanup = useAuthStore.getState().deletionCleanup;
      mockExecuted.length = 0;
      mockGoogleSignin.signOut.mockClear();
      await act(async () => {
        gate.resolve(response({ deleted: true }));
        await settle();
      });
      expect(ownerRows(OTHER_OWNER)).toEqual(other);
      expectCurrentOwnerUntouched(OTHER_OWNER, current, vault);
      expect(getApiSession()).toBe(api);
      expect(ownerRows(OWNER)).toEqual([]);
      expect(useAuthStore.getState().deletionCleanup).toBe(successorCleanup);
      if (!unmount)
        expect(renderer.root.findByType(Modal).props.visible).toBe(true);
      expect(mockRows.get('kv')).toContainEqual({
        key: 'auth.last-provider',
        value: JSON.stringify({ version: 1, provider: 'google' }),
      });
    },
  );

  it("does not cancel B's in-flight sign-in when A's confirmation arrives before B finishes", async () => {
    await arrange('google');
    seedOwnerRows();
    const own = ownerRows(OWNER);
    const original = useAuthStore.getState().session;
    const confirmation = deferred<Response>();
    deletionNetwork(confirmation.promise);
    const renderer = renderScreen();
    await armDeletion(renderer);
    await act(async () => {
      button(renderer, 'Permanently delete').props.onPress();
    });
    const nativeSignIn = deferred<unknown>();
    mockGoogleSignin.signIn.mockReturnValueOnce(nativeSignIn.promise);
    let signingIn!: Promise<void>;
    await act(async () => {
      signingIn = useAuthStore.getState().signInWithGoogle();
      await settle();
    });
    try {
      expect(useAuthStore.getState().busy).toBe(true);
      await act(async () => {
        confirmation.resolve(response({ deleted: true }));
        await settle();
      });
      expect(useAuthStore.getState().busy).toBe(true);
      expect(useAuthStore.getState().session).toBe(original);
      expect(ownerRows(OWNER)).toEqual(own);
      expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
      expect(mockGoogleSignin.revokeAccess).not.toHaveBeenCalled();
      expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        nativeSignIn.resolve({
          type: 'success',
          data: {
            idToken: 'fixture-google-token',
            user: { name: 'Other', email: null },
          },
        });
        await signingIn;
      });
    }
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      OTHER_OWNER,
    );
    expect(
      JSON.parse(__keychainStore.get(SESSION_VAULT_SERVICE)!.password),
    ).toMatchObject({
      canonicalAppUserId: OTHER_OWNER,
      refreshToken: 'refresh-new-B',
    });
  });

  it.each([false, true])(
    'A → B → A does not treat the newly signed-in A session as the deleted session (reused descriptor: %s)',
    async reuseDescriptor => {
      await arrange('google');
      const original = useAuthStore.getState().session;
      seedOwnerRows();
      seedOwnerRows(OTHER_OWNER);
      const own = ownerRows(OWNER);
      const other = ownerRows(OTHER_OWNER);
      const gate = deferred<Response>();
      deletionNetwork(gate.promise);
      const renderer = renderScreen();
      await armDeletion(renderer);
      await act(async () => {
        button(renderer, 'Permanently delete').props.onPress();
      });
      await act(async () => {
        await useAuthStore.getState().signOut();
        await arrange('google', OTHER_OWNER);
        await useAuthStore.getState().signOut();
        await arrange('google', OWNER, 'new-A');
        if (reuseDescriptor) useAuthStore.setState({ session: original });
      });
      const current = useAuthStore.getState().session;
      const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
      mockExecuted.length = 0;
      mockGoogleSignin.signOut.mockClear();
      await act(async () => {
        gate.resolve(response({ deleted: true }));
        await settle();
      });
      expectCurrentOwnerUntouched(OWNER, current, vault);
      expect(ownerRows(OWNER)).toEqual(own);
      expect(ownerRows(OTHER_OWNER)).toEqual(other);
      expect(useAuthStore.getState().deletionCleanup).toBeNull();
      expect(showBrandNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          eyebrow: 'LOCAL CLEANUP NEEDED',
          detail: expect.stringContaining('delete the app'),
        }),
      );
    },
  );

  it('a failed media cleanup is reported by the initiating surface after sign-out/unmount', async () => {
    await arrange('google');
    seedOwnerRows();
    const own = ownerRows(OWNER);
    mockDeleteCaptureFiles.mockRejectedValue(
      new Error('synthetic media failure'),
    );
    const gate = deferred<Response>();
    deletionNetwork(gate.promise);
    const renderer = renderScreen();
    await armDeletion(renderer);
    await act(async () => {
      button(renderer, 'Permanently delete').props.onPress();
    });
    act(() => renderer.unmount());
    await act(async () => {
      gate.resolve(response({ deleted: true }));
      await settle();
    });
    expect(ownerRows(OWNER)).toEqual(own);
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(showBrandNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        eyebrow: 'LOCAL CLEANUP NEEDED',
        detail: expect.stringContaining('delete the app'),
      }),
    );
  });

  it('duplicate successful confirmations share one cleanup instead of canceling it or deleting another session', async () => {
    await arrange('google');
    seedOwnerRows();
    seedOwnerRows(OTHER_OWNER);
    const other = ownerRows(OTHER_OWNER);
    const gate = deferred<Response>();
    deletionNetwork(gate.promise);
    const renderer = renderScreen();
    await armDeletion(renderer);
    const confirm = button(renderer, 'Permanently delete').props.onPress;
    await act(async () => {
      confirm();
      confirm();
    });
    await act(async () => {
      gate.resolve(response({ deleted: true }));
      await settle();
    });
    expect(ownerRows(OWNER)).toEqual([]);
    expect(ownerRows(OTHER_OWNER)).toEqual(other);
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
    expect(mockExecuted.filter(call => call.sql === 'COMMIT')).toHaveLength(1);
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
  });

  it("an owner change while the challenge request is pending never arms A's challenge for B", async () => {
    await arrange('google');
    const request = deferred<Response>();
    const network = deletionNetwork(
      Promise.resolve(response({ deleted: true })),
      request.promise,
    );
    const renderer = renderScreen();
    await act(async () => {
      control(renderer, 'Delete account').props.onPress();
    });
    await act(async () => {
      control(renderer, 'Skip the survey').props.onPress();
    });
    await act(async () => {
      button(renderer, 'Continue to delete').props.onPress();
    });
    await act(async () => {
      await useAuthStore.getState().signOut();
      await arrange('google', OTHER_OWNER);
    });
    await act(async () => {
      request.resolve(
        response({ challenge: 'old-A', expiresAt: '2099-01-01T00:00:00Z' }),
      );
      await settle();
      jest.advanceTimersByTime(5_000);
    });
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    expect(
      network.mock.calls.filter(([url]) =>
        url.endsWith('/v1/me/delete-confirm'),
      ),
    ).toEqual([]);
    expect(mockExecuted.some(call => call.sql.startsWith('DELETE '))).toBe(
      false,
    );
  });
});
