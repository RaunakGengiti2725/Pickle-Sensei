/**
 * What happens the instant the server confirms deletion
 * (`authStore.completeAccountDeletion`): the runtime is signed out, the
 * device is left in the signed-out owner bucket, every owner-partitioned
 * table and owner-scoped kv namespace for the deleted account is purged in
 * ONE transaction, and the Google SDK is fully disconnected so the deleted
 * account cannot be silently restored on next launch.
 */

const mockExecuted: Array<{ sql: string; params: unknown[] }> = [];
let mockFailOn: ((sql: string) => boolean) | null = null;

jest.mock('../../src/data/db', () => ({
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

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  establishApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { OWNER_SCOPED_KV_NAMESPACES } from '../../src/data/repository';

const OWNER = '11111111-1111-4111-8111-111111111111';

function signedIn(provider: 'google' | 'apple'): AuthSession {
  return {
    provider,
    subject: `${provider}-subject`,
    canonicalAppUserId: OWNER,
    localOnly: false,
    displayName: 'Alex Chen',
    email: 'alex@example.com',
  };
}

function arrange(provider: 'google' | 'apple') {
  useAuthStore.setState({
    hydrated: true,
    session: signedIn(provider),
    busy: false,
    error: null,
  });
  setActiveDataOwner(OWNER);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'provider-token',
    canonicalAppUserId: OWNER,
    provider,
  });
}

beforeEach(() => {
  mockExecuted.length = 0;
  mockFailOn = null;
  mockGoogleSignin.revokeAccess.mockClear();
  mockGoogleSignin.signOut.mockClear();
});

describe('completeAccountDeletion', () => {
  it('signs the runtime out before touching local data, then purges every owner-scoped row and kv namespace atomically', async () => {
    arrange('google');
    await useAuthStore.getState().completeAccountDeletion();

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);

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
    // AGENTS.md pins these four namespaces as the owner-scoped kv set.
    expect([...OWNER_SCOPED_KV_NAMESPACES]).toEqual([
      'profile',
      'rank.celebrated',
      'notifications',
      'consistency',
    ]);
    const kvDeletes = tx
      .filter(c => c.sql === 'DELETE FROM kv WHERE key = ?')
      .map(c => c.params[0]);
    expect(kvDeletes).toEqual([
      `profile:${OWNER}`,
      `rank.celebrated:${OWNER}`,
      `notifications:${OWNER}`,
      `consistency:${OWNER}`,
    ]);
    expect(mockExecuted.some(c => c.sql === 'ROLLBACK')).toBe(false);

    // Google account: full disconnect so the SDK cannot silently restore it.
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signOut).toHaveBeenCalledTimes(1);
  });

  it('Apple accounts skip the Google SDK entirely', async () => {
    arrange('apple');
    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockGoogleSignin.revokeAccess).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
    expect(mockExecuted.some(c => c.sql === 'COMMIT')).toBe(true);
  });

  it('a failing local purge rolls back, never rethrows, and still leaves the user signed out', async () => {
    arrange('google');
    mockFailOn = sql => sql.startsWith('DELETE FROM outbox');
    await expect(
      useAuthStore.getState().completeAccountDeletion(),
    ).resolves.toBeUndefined();
    expect(mockExecuted.some(c => c.sql === 'ROLLBACK')).toBe(true);
    expect(mockExecuted.some(c => c.sql === 'COMMIT')).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // Provider disconnect still runs after a local persistence failure.
    expect(mockGoogleSignin.revokeAccess).toHaveBeenCalledTimes(1);
  });

  it('a Google SDK failure is swallowed — the account is already gone server-side', async () => {
    arrange('google');
    mockGoogleSignin.revokeAccess.mockRejectedValueOnce(new Error('sdk down'));
    await expect(
      useAuthStore.getState().completeAccountDeletion(),
    ).resolves.toBeUndefined();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });
});
