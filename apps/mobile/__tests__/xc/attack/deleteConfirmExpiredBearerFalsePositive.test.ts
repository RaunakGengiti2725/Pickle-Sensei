/**
 * Adversarial regression for candidate 91db4fb3 (XC-P2-DELETE-CONFIRM-LOST-
 * RESPONSE fix): `confirmAccountDeletion` remembers a challenge whose confirm
 * request got no response and treats ANY 401 on its retry as "the account is
 * gone" → ManageAccountScreen runs completeAccountDeletion (sign out, clear
 * the Keychain record, purge the owner's local rows) and shows "Account
 * deleted".
 *
 * But the edge fn answers 401 for an EXPIRED access token exactly like it
 * does for a deleted user (`authenticate()` → "The session token has
 * expired." vs "The session is no longer valid."), and the lost-response
 * path is entered precisely under flaky connectivity — the same condition
 * that keeps `sessionKeeper` from rotating the bearer ahead of expiry
 * (offline backoff, or the app suspended on the armed screen). The client
 * KNOWS the bearer is stale (`ApiSession.bearerExpiresAtMs`), so a 401 for a
 * bearer that is already expired must not be read as a deletion.
 *
 * Timeline reproduced here:
 *   1. bearer valid → "Permanently delete" → fetch rejects (request may or
 *      may not have reached the server; the server did NOT delete).
 *   2. bearer passes its expiry while the keeper is still backing off.
 *   3. user taps "Permanently delete" again → 401 "The session token has
 *      expired." → candidate resolves { appleAuthorizationRevocation:
 *      'unknown' } → local account state destroyed, account still exists.
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
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ManageAccountScreen } from '../../../src/screens/ManageAccountScreen';
import { Button } from '../../../src/design/components';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const canonicalAppUserId = '11111111-1111-4111-8111-111111111111';

const liveSession: ApiSession = {
  apiBaseUrl: 'https://edge.example',
  bearerToken: 'access-token',
  bearerExpiresAtMs: Date.now() + 3_600_000,
  refreshToken: 'refresh-token',
  canonicalAppUserId,
  provider: 'apple',
};

/** The SAME bearer, past its recorded expiry — the keeper has not rotated
 * it yet (offline backoff / app was suspended). */
const expiredSession: ApiSession = {
  ...liveSession,
  bearerExpiresAtMs: Date.now() - 1_000,
};

/** Exactly what `authenticate()` in supabase/functions/api/index.ts returns
 * for an expired Supabase access token — status-identical to the deleted-
 * user refusal. */
const expiredBearerRefusal = async (): Promise<Response> =>
  new Response(
    JSON.stringify({ error: { message: 'The session token has expired.' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );

describe('attack: lost delete-confirm response, then a 401 caused by bearer expiry (account NOT deleted)', () => {
  it('confirmAccountDeletion must not infer deletion from a 401 for a bearer it knows is expired', async () => {
    const challenge = '66666666-6666-4666-8666-666666666666';
    const lost = async (): Promise<Response> => {
      // Request never completed server-side (or never arrived): nothing
      // was deleted. The client cannot know that — only that no answer came.
      throw new TypeError('Network request failed');
    };
    await expect(
      confirmAccountDeletion(liveSession, challenge, lost),
    ).rejects.toMatchObject({ code: 'deletion.unavailable', retryable: true });

    // The bearer expired while offline; the retry goes out with it.
    const retry = confirmAccountDeletion(
      expiredSession,
      challenge,
      expiredBearerRefusal,
    );
    // A 401 for an already-expired bearer says nothing about the account;
    // the flow must NOT complete as a deletion (the server still has the
    // account; local purge + Keychain clear + "Account deleted" would be
    // wrong). Any AccountDeletionError is acceptable here; a resolved
    // deletion result is not.
    await expect(retry).rejects.toBeInstanceOf(AccountDeletionError);
  });
});

describe('attack: ManageAccountScreen destroys local account state for a live account', () => {
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
    establishApiSession(liveSession);
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

  it('lost response → bearer expires → retry 401 must NOT purge owner data, clear the Keychain or claim "Account deleted"', async () => {
    jest.useFakeTimers();
    const challenge = '77777777-7777-4777-8777-777777777777';
    const confirmAttempts: string[] = [];
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
        confirmAttempts.push(
          String(
            init?.headers &&
              (init.headers as Record<string, string>)['Authorization'],
          ),
        );
        if (confirmAttempts.length === 1) {
          // Dropped on the way out: the server never ran the deletion.
          throw new TypeError('Network request failed');
        }
        // The retry carries the now-expired bearer.
        return expiredBearerRefusal();
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

      // Attempt 1: no response.
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      expect(confirmAttempts).toHaveLength(1);
      expect(useAuthStore.getState().session).not.toBeNull();

      // The access token expires while the keeper is backing off; nothing
      // rotated it. Same bearer string, now known-stale to the client.
      establishApiSession(expiredSession);

      // Attempt 2 with the expired bearer → 401 (token expired).
      const retry = sheetButton(renderer, 'Permanently delete');
      expect(retry.props.disabled).toBe(false);
      await act(async () => {
        retry.props.onPress();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(confirmAttempts).toHaveLength(2);

      const state = useAuthStore.getState();
      const copy = renderer.root
        .findAll(node => typeof node.props.children === 'string')
        .map(node => String(node.props.children))
        .join(' ');
      // The account still exists on the server: nothing local may be
      // destroyed and the player must not be told it was deleted.
      expect(mockPurgeOwnerData).not.toHaveBeenCalled();
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
      expect(state.session).not.toBeNull();
      expect(state.deletionCleanup).toBeNull();
      expect(copy).not.toContain('Account deleted');
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
