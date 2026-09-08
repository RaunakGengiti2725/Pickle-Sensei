/**
 * INT-deletion-managed-media adversary — ManageAccount deletion dialog against
 * the REAL wire client (`src/account/deletion.ts`), with only `fetch` faked.
 *
 *  ADV-M04 slow server / lost confirm response: the server finishes the
 *          deletion after the client's 15 s deadline; every later retry is
 *          answered by the live server (202 lease held, then 401 because the
 *          Auth user is gone). The app must still reach local cleanup for the
 *          deleted owner — a dead-end "sign in again" with the deleted
 *          owner's rows still on the phone is not recovery.
 *  ADV-M05 the client throws away `operationId`/`statusCapability` minted by
 *          delete-request, so confirm cannot be operation-bound and status
 *          can never be queried.
 *  ADV-M06 App Store copy: the iOS success notice must not name Google Play.
 *  ADV-M07 double action: two taps on "Permanently delete" send ONE confirm.
 *  ADV-M08 unknown/malformed completion payloads never become success.
 */
import React from 'react';
import { Platform, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
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
const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { establishApiSession } from '../../src/account/apiSession';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  AccountDeletionError,
  confirmAccountDeletion,
} from '../../src/account/deletion';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const CHALLENGE = '55555555-5555-4555-8555-555555555555';
const syncedSession: AuthSession = {
  provider: 'apple',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};
const apiSession = {
  apiBaseUrl: 'https://api.example.test/functions/v1/api',
  bearerToken: 'access-token',
  canonicalAppUserId: OWNER,
  provider: 'apple' as const,
};
const originalFetch = globalThis.fetch;

type Route = (init?: RequestInit) => Promise<Response>;
interface WireCall {
  path: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installServer(routes: Record<string, Route>) {
  const calls: WireCall[] = [];
  const fetchMock = jest.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname.replace('/functions/v1/api', '');
    calls.push({
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const route = routes[path];
    if (!route) throw new TypeError('Network request failed');
    return route(init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

/** Real press semantics: a disabled Button must not fire. */
function press(button: TestRenderer.ReactTestInstance) {
  if (button.props.disabled) return;
  button.props.onPress();
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
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
}

const deleteRequestRoute: Route = async () =>
  json(200, {
    challenge: CHALLENGE,
    expiresAt: '2099-01-01T00:00:00.000Z',
    operationId: OPERATION,
    statusCapability: 'status-capability-secret',
    statusExpiresAt: '2099-01-02T00:00:00.000Z',
  });

describe('ManageAccount deletion adversary (real wire client)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockShowBrandNotice.mockClear();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER);
    establishApiSession(apiSession);
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() =>
        Promise.resolve({ localPurge: 'complete' as const }),
      ),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('ADV-M04 a confirm whose response is lost after the server completed leaves the app able to finish local cleanup', async () => {
    let confirmAttempt = 0;
    const server = installServer({
      '/v1/me/delete-request': deleteRequestRoute,
      '/v1/me/delete-confirm': () => {
        confirmAttempt += 1;
        if (confirmAttempt === 1) return new Promise<Response>(() => {});
        if (confirmAttempt === 2) {
          return Promise.resolve(
            json(202, { operationId: OPERATION, state: 'in_progress' }),
          );
        }
        return Promise.resolve(
          json(401, {
            error: {
              message: 'The session is no longer valid. Sign in again.',
            },
          }),
        );
      },
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        press(sheetButton(renderer, 'Permanently delete'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(15_000);
      });
      expect(allText(renderer)).toContain('Deletion status unknown');
      await act(async () => {
        press(sheetButton(renderer, 'Retry deletion'));
      });
      expect(allText(renderer)).toContain('Deletion status unknown');
      await act(async () => {
        press(sheetButton(renderer, 'Retry deletion'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });

      expect(confirmAttempt).toBe(3);
      const statusQueries = server.calls.filter(
        call =>
          !['/v1/me/delete-request', '/v1/me/delete-confirm'].includes(
            call.path,
          ),
      );
      const cleanup = useAuthStore.getState()
        .completeAccountDeletion as jest.Mock;
      // Recovery means one of: the deleted owner's local cleanup ran, or the
      // app resolved the operation through the status capability it was
      // handed by delete-request. A "Sign in again" dead end is neither.
      expect(allText(renderer)).not.toContain('Sign in again before retrying');
      expect(cleanup.mock.calls.length > 0 || statusQueries.length > 0).toBe(
        true,
      );
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ADV-M05 confirm is bound to the operation minted by delete-request', async () => {
    const server = installServer({
      '/v1/me/delete-request': deleteRequestRoute,
      '/v1/me/delete-confirm': async () =>
        json(200, {
          deleted: true,
          operationId: OPERATION,
          completionReceipt: { completedAt: '2026-09-08T00:00:00.000Z' },
          appleAuthorizationRevocation: 'revoked',
        }),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        press(sheetButton(renderer, 'Permanently delete'));
      });
      const confirm = server.calls.find(
        call => call.path === '/v1/me/delete-confirm',
      );
      expect(confirm?.body).toEqual({
        challenge: CHALLENGE,
        operationId: OPERATION,
      });
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ADV-M06 the iOS success notice follows the App Store dossier (no Google Play)', async () => {
    expect(Platform.OS).toBe('ios');
    installServer({
      '/v1/me/delete-request': deleteRequestRoute,
      '/v1/me/delete-confirm': async () =>
        json(200, {
          deleted: true,
          operationId: OPERATION,
          appleAuthorizationRevocation: 'revoked',
        }),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        press(sheetButton(renderer, 'Permanently delete'));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
      const notice = mockShowBrandNotice.mock.calls[0]![0] as {
        title: string;
        detail: string;
        eyebrow: string;
      };
      expect(notice.eyebrow).toBe('DELETION CONFIRMED');
      const copy = `${notice.title} ${notice.detail}`;
      for (const banned of [
        'Google Play',
        'Android',
        'guest mode',
        'Live Court',
        'DUPR',
      ]) {
        expect(copy).not.toContain(banned);
      }
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ADV-M07 two taps on Permanently delete send exactly one confirm and one cleanup', async () => {
    let release!: (response: Response) => void;
    const server = installServer({
      '/v1/me/delete-request': deleteRequestRoute,
      '/v1/me/delete-confirm': () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        press(sheetButton(renderer, 'Permanently delete'));
      });
      const deleting = sheetButton(renderer, 'Deleting');
      expect(deleting.props.disabled).toBe(true);
      await act(async () => {
        press(deleting);
        deleting.props.onPress();
      });
      await act(async () => {
        release(
          json(200, {
            deleted: true,
            operationId: OPERATION,
            appleAuthorizationRevocation: 'revoked',
          }),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        server.calls.filter(call => call.path === '/v1/me/delete-confirm'),
      ).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it.each([
    ['202 in_progress', 202, { operationId: OPERATION, state: 'in_progress' }],
    ['deleted as string', 200, { deleted: 'true' }],
    ['deleted as 1', 200, { deleted: 1 }],
    ['nested deleted', 200, { result: { deleted: true } }],
    ['array body', 200, [{ deleted: true }]],
    ['deleted:true on 500', 500, { deleted: true }],
    [
      'deleted:true on 409 blocked',
      409,
      {
        deleted: true,
        error: { code: 'account.deletion_blocked', message: 'blocked' },
      },
    ],
  ])(
    'ADV-M08 %s is never reported as a completed deletion',
    async (_label, status, body) => {
      const fetchFn = jest.fn(async () => json(status, body));
      await expect(
        confirmAccountDeletion(apiSession, CHALLENGE, fetchFn),
      ).rejects.toBeInstanceOf(AccountDeletionError);
      const error = await confirmAccountDeletion(
        apiSession,
        CHALLENGE,
        fetchFn,
      ).catch((e: AccountDeletionError) => e);
      expect(error).toBeInstanceOf(AccountDeletionError);
      expect(['deletion.unknown', 'deletion.rejected']).toContain(
        (error as AccountDeletionError).code,
      );
    },
  );
});
