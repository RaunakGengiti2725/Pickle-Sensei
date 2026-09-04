/**
 * Adjudication regression (xc-journeys / journey-settings-account-deletion,
 * finding XC-P2-DELETE-CONFIRM-LOST-RESPONSE).
 *
 * POST /v1/me/delete-confirm is the destructive step. When its RESPONSE is
 * lost after the request left the device, the outcome is UNKNOWN — the
 * server may well have executed the deletion — so the client must not tell
 * the player "Nothing was deleted". The retry of that same challenge then
 * answers 401 (the bearer names a user that no longer exists); for a
 * challenge whose confirmation is unresolved that 401 IS the deletion's
 * confirmation and must complete the flow locally (onDeleted →
 * completeAccountDeletion: sign out, clear the Keychain record, purge the
 * deleted owner's local data) instead of dead-ending at "sign in again".
 *
 * On 4d812e1a the first failure asserted "Nothing was deleted" and the retry
 * mapped to deletion.session_expired (retryable=false), so ManageAccountScreen
 * fell back to 'review' and never reached onDeleted.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';
import type { LocalDb } from '../../../src/data/db';

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://edge.example',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: '1.0',
  }),
}));

const mockKv = new Map<string, string>();
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
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockPurgeOwnerData = jest.fn<Promise<void>, [LocalDb, string]>(
  async () => undefined,
);
jest.mock('../../../src/data/repository', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/data/repository')
  >('../../../src/data/repository');
  return {
    ...actual,
    purgeOwnerData: (db: LocalDb, owner: string) =>
      mockPurgeOwnerData(db, owner),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
} from '../../../src/account/deletion';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ManageAccountScreen } from '../../../src/screens/ManageAccountScreen';
import { Button } from '../../../src/design/components';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const canonicalAppUserId = '11111111-1111-4111-8111-111111111111';

const session: ApiSession = {
  apiBaseUrl: 'https://edge.example',
  bearerToken: 'access-token',
  bearerExpiresAtMs: Date.now() + 3_600_000,
  refreshToken: 'refresh-token',
  canonicalAppUserId,
  provider: 'apple',
};

const unauthorized = async (): Promise<Response> =>
  new Response(JSON.stringify({ error: { code: 'auth.required' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });

describe('adjudication: lost delete-confirm response', () => {
  it('does not claim "Nothing was deleted", and the 401 on the retry of that challenge completes the deletion', async () => {
    const challenge = '22222222-2222-4222-8222-222222222222';
    let serverDeleted = false;
    const lostResponse = async (): Promise<Response> => {
      serverDeleted = true; // request reached the server and was executed
      throw new TypeError('Network request failed');
    };
    let first: unknown = null;
    await confirmAccountDeletion(session, challenge, lostResponse).catch(e => {
      first = e;
    });
    expect(serverDeleted).toBe(true);
    expect(first).toBeInstanceOf(AccountDeletionError);
    const firstError = first as AccountDeletionError;
    expect(firstError.message).not.toContain('Nothing was deleted');
    expect(firstError.retryable).toBe(true);

    // Account gone → the same bearer is refused. For an unresolved
    // confirmation that is the deletion completing, not a sign-in problem.
    await expect(
      confirmAccountDeletion(session, challenge, unauthorized),
    ).resolves.toMatchObject({ appleAuthorizationRevocation: 'unknown' });
  });

  it('keeps 401 as "sign in again" for a challenge whose confirmation was never sent', async () => {
    await expect(
      confirmAccountDeletion(
        session,
        '33333333-3333-4333-8333-333333333333',
        unauthorized,
      ),
    ).rejects.toMatchObject({
      code: 'deletion.session_expired',
      retryable: false,
    });
  });

  it('a definitive answer after a lost response clears the unresolved marker', async () => {
    const challenge = '44444444-4444-4444-8444-444444444444';
    await expect(
      confirmAccountDeletion(session, challenge, async () => {
        throw new TypeError('Network request failed');
      }),
    ).rejects.toMatchObject({ code: 'deletion.unavailable', retryable: true });
    // The server answers: the challenge is invalid and the account is still
    // there — so nothing was deleted and the marker must not linger.
    await expect(
      confirmAccountDeletion(
        session,
        challenge,
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'deletion.challenge_invalid', message: 'Gone.' },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    ).rejects.toMatchObject({ code: 'deletion.rejected', retryable: false });
    await expect(
      confirmAccountDeletion(session, challenge, unauthorized),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
  });
});

describe('adjudication: ManageAccountScreen after a lost delete-confirm response', () => {
  const authSession: AuthSession = {
    provider: 'apple',
    subject: canonicalAppUserId,
    canonicalAppUserId,
    localOnly: false,
    displayName: 'Alex Chen',
    email: 'alex@example.com',
  };
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mockKv.clear();
    mockPurgeOwnerData.mockClear();
    __keychainStore.clear();
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId,
        refreshToken: 'refresh-token',
        email: 'alex@example.com',
        displayName: 'Alex Chen',
      }),
    });
    establishApiSession(session);
    setActiveDataOwner(canonicalDataOwner(canonicalAppUserId));
    useAuthStore.setState({
      hydrated: true,
      session: authSession,
      busy: false,
      error: null,
      deletionCleanup: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  function sheetButton(
    renderer: TestRenderer.ReactTestRenderer,
    label: string,
  ) {
    const matches = renderer.root
      .findAllByType(Button)
      .filter(node => String(node.props.label).startsWith(label));
    expect(matches.length).toBeGreaterThan(0);
    return matches[0]!;
  }

  function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
    return renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === label &&
        typeof node.props.onPress === 'function',
    );
  }

  it('lost response → retry answers 401 → onDeleted/completeAccountDeletion: Keychain cleared, owner data purged', async () => {
    jest.useFakeTimers();
    const challenge = '55555555-5555-4555-8555-555555555555';
    const confirmAttempts: string[] = [];
    let serverDeleted = false;
    globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/me/delete-request')) {
        return new Response(
          JSON.stringify({
            challenge,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/v1/me/delete-confirm')) {
        confirmAttempts.push(String(init?.body));
        if (!serverDeleted) {
          serverDeleted = true; // executed server-side; the answer never arrives
          throw new TypeError('Network request failed');
        }
        return unauthorized();
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    try {
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(ManageAccountScreen),
        );
      });
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'Skip the survey')[0]!.props.onPress();
      });
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });

      // Attempt 1: the response is lost after the server deleted the account.
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      expect(confirmAttempts).toHaveLength(1);
      expect(serverDeleted).toBe(true);
      const copy = renderer.root
        .findAll(node => typeof node.props.children === 'string')
        .map(node => String(node.props.children))
        .join(' ');
      expect(copy).not.toContain('Nothing was deleted');
      expect(useAuthStore.getState().session).not.toBeNull();

      // Attempt 2: the same challenge is retried; the bearer is now refused.
      const retry = sheetButton(renderer, 'Permanently delete');
      expect(retry.props.disabled).toBe(false);
      await act(async () => {
        retry.props.onPress();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(confirmAttempts).toHaveLength(2);
      expect(confirmAttempts[1]).toBe(JSON.stringify({ challenge }));

      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.error).toBeNull();
      expect(state.deletionCleanup).toEqual({ localPurge: 'complete' });
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
      expect(mockPurgeOwnerData).toHaveBeenCalledTimes(1);
      expect(mockPurgeOwnerData.mock.calls[0]![1]).toBe(
        canonicalDataOwner(canonicalAppUserId),
      );
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
