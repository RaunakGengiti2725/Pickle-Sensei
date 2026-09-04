/**
 * ADVERSARIAL PASS 3 — mobile-settings-account #2 (target 4d812e1a).
 *
 * S4: the server has already deleted the account. Locally, `purgeOwnerData`
 * fails on every one of its three attempts AND `clearPersistedSession`
 * rejects (the Keychain layer surfaces an error instead of swallowing it).
 * Contract under test: `completeAccountDeletion()` must still resolve, the
 * in-memory session must be cleared, and `deletionCleanup.localPurge` must
 * read 'failed' so ManageAccountScreen can tell the player that rows are
 * still on the phone.
 *
 * `clearPersistedSession` is the real module's export replaced by a
 * rejecting spy; everything else (auth store, apiSession, accountScope, the
 * purge transaction) is production code.
 */

const mockExecuted: Array<{ sql: string; params: unknown[] }> = [];
let mockFailOn: ((sql: string) => boolean) | null = null;

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      mockExecuted.push({ sql, params });
      if (mockFailOn?.(sql)) throw new Error(`sqlite: ${sql}`);
      return { rows: [] };
    },
    close: () => undefined,
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

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

const mockClearPersistedSession = jest.fn<Promise<void>, []>();
jest.mock('../../../src/account/sessionVault', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/account/sessionVault')
  >('../../../src/account/sessionVault');
  return {
    ...actual,
    clearPersistedSession: () => mockClearPersistedSession(),
  };
});

import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import {
  establishApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../../src/data/accountScope';

const OWNER = '11111111-1111-4111-8111-111111111111';

const signedIn: AuthSession = {
  provider: 'google',
  subject: 'google-subject',
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function arrange() {
  useAuthStore.setState({
    hydrated: true,
    session: signedIn,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  setActiveDataOwner(OWNER);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'access-token',
    canonicalAppUserId: OWNER,
    provider: 'google',
    refreshToken: 'refresh-token',
    bearerExpiresAtMs: Date.now() + 3_600_000,
  });
}

beforeEach(() => {
  mockExecuted.length = 0;
  mockFailOn = null;
  mockClearPersistedSession.mockReset();
  mockGoogleSignin.revokeAccess.mockClear();
  mockGoogleSignin.signOut.mockClear();
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('S4 — completeAccountDeletion with purge failing 3× AND the vault clear rejecting', () => {
  it('[BROKEN on 4d812e1a] resolves, clears the in-memory session, attempts the purge 3×, and reports localPurge === "failed"', async () => {
    arrange();
    mockClearPersistedSession.mockRejectedValue(
      Object.assign(new Error('Keychain: errSecInteractionNotAllowed'), {
        code: '-25308',
      }),
    );
    mockFailOn = sql => sql.startsWith('DELETE FROM outbox');

    const outcome = await useAuthStore
      .getState()
      .completeAccountDeletion()
      .then(
        () => ({ settled: 'resolved' as const }),
        (error: unknown) => ({
          settled: 'rejected' as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );

    const state = useAuthStore.getState();
    // The in-memory sign-out happens before the vault write — HELD.
    expect(state.session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(mockClearPersistedSession).toHaveBeenCalledTimes(1);

    const purgeAttempts = mockExecuted.filter(
      c => c.sql === 'BEGIN IMMEDIATE',
    ).length;
    const rollbacks = mockExecuted.filter(c => c.sql === 'ROLLBACK').length;

    // The contract: never rethrow, purge retried 3×, cleanup reported.
    expect({
      settled: outcome.settled,
      purgeAttempts,
      rollbacks,
      deletionCleanup: state.deletionCleanup,
      googleDisconnect: mockGoogleSignin.revokeAccess.mock.calls.length,
    }).toEqual({
      settled: 'resolved',
      purgeAttempts: 3,
      rollbacks: 3,
      deletionCleanup: { localPurge: 'failed' },
      googleDisconnect: 1,
    });
  });

  it('control: with the vault clear resolving, purge 3× failure is reported and the method resolves (HELD — matches wf/flow-account-deletion-store)', async () => {
    arrange();
    mockClearPersistedSession.mockResolvedValue(undefined);
    mockFailOn = sql => sql.startsWith('DELETE FROM outbox');
    await expect(
      useAuthStore.getState().completeAccountDeletion(),
    ).resolves.toBeUndefined();
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockExecuted.filter(c => c.sql === 'BEGIN IMMEDIATE')).toHaveLength(
      3,
    );
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
  });

  it('[BROKEN on 4d812e1a] vault clear rejecting alone (purge healthy) must still run the purge — the deleted owner’s rows must not survive because the Keychain hiccuped', async () => {
    arrange();
    mockClearPersistedSession.mockRejectedValue(new Error('Keychain: -34018'));
    const outcome = await useAuthStore
      .getState()
      .completeAccountDeletion()
      .then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
    expect(useAuthStore.getState().session).toBeNull();
    expect({
      outcome,
      purgeCommitted: mockExecuted.some(c => c.sql === 'COMMIT'),
      deletionCleanup: useAuthStore.getState().deletionCleanup,
      googleDisconnect: mockGoogleSignin.revokeAccess.mock.calls.length,
    }).toEqual({
      outcome: 'resolved',
      purgeCommitted: true,
      deletionCleanup: { localPurge: 'complete' },
      googleDisconnect: 1,
    });
  });

  it('the real sessionVault.clearPersistedSession swallows a Keychain rejection itself (HELD — the store-level gap only opens if that guard is bypassed)', async () => {
    const actual = jest.requireActual<
      typeof import('../../../src/account/sessionVault')
    >('../../../src/account/sessionVault');
    const Keychain = jest.requireMock<{
      resetGenericPassword: (o: { service?: string }) => Promise<boolean>;
    }>('react-native-keychain');
    const original = Keychain.resetGenericPassword;
    Keychain.resetGenericPassword = async () => {
      throw new Error('Keychain: errSecInteractionNotAllowed');
    };
    try {
      await expect(actual.clearPersistedSession()).resolves.toBeUndefined();
    } finally {
      Keychain.resetGenericPassword = original;
    }
  });
});
