import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 — the shipping ManageAccount deletion path must run on the durable
 * deletion operation (deletionOperation.ts) over the redirect-rejecting
 * transport (deletionOperationTransport.ts), reached through a real
 * `fetchNoRedirect` adapter over the app's fetch.
 *
 * These tests drive the real screen against a real SQLite journal, the
 * in-memory Keychain mock and a routed `globalThis.fetch`, so the only
 * seams are the ones production uses. They pin that:
 *   - every deletion call goes out redirect-rejecting and bound to the
 *     server operation id; a redirected reply is never trusted;
 *   - a lost or in-progress confirmation is shown as unknown / in progress
 *     and completes ONLY from a verified receipt (confirm or status poll);
 *   - re-entry (same dialog, or a fresh screen after teardown) resumes the
 *     durable operation with the SAME operation id — never a new request;
 *   - the original owner's operation is isolated from a replacement account.
 */

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

let mockDatabase: ReturnType<typeof createSqliteTestDb>;
jest.mock('../src/data/db', () => ({
  getDb: () => mockDatabase.db,
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
jest.mock('../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import { ManageAccountScreen } from '../src/screens/ManageAccountScreen';
import { Button } from '../src/design/components';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import { getRuntimePublicConfig } from '../src/config/runtimeConfig';
import { fetchNoRedirect } from '../src/account/deletion';
import { createSqliteTestDb } from '../testSupport/sqlite';
import {
  DELETION_CAPABILITY,
  deletionId,
  deletionKeychainStore,
} from '../testSupport/deletionOperationFixture';

const ORIGIN = getRuntimePublicConfig().apiBaseUrl;
if (!ORIGIN) throw new Error('runtime config must expose the API origin');

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const BEARER_A = 'session.bearer.owner-a';
const BEARER_B = 'session.bearer.owner-b';

type DeletionPath = 'delete-request' | 'delete-confirm' | 'delete-status';

const sessionA: AuthSession = {
  provider: 'google',
  subject: OWNER_A,
  canonicalAppUserId: OWNER_A,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const apiSessionA = {
  apiBaseUrl: ORIGIN,
  bearerToken: BEARER_A,
  canonicalAppUserId: OWNER_A,
  provider: 'google' as const,
};

const realFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, [string, RequestInit]>();

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function requestPayload(operation = 10) {
  return {
    challenge: deletionId(operation + 1),
    expiresAt: iso(900_000),
    operationId: deletionId(operation),
    statusCapability: DELETION_CAPABILITY,
    statusExpiresAt: iso(86_400_000),
  };
}

function completionPayload(operation = 10) {
  return {
    deleted: true as const,
    operationId: deletionId(operation),
    completionReceipt: { completedAt: iso(0) },
    appleAuthorizationRevocation: 'revoked' as const,
  };
}

function statusPayload(state: string, operation = 10) {
  return {
    operationId: deletionId(operation),
    state,
    completionReceipt: state === 'completed' ? { completedAt: iso(0) } : null,
    appleAuthorizationRevocation: state === 'completed' ? 'revoked' : null,
  };
}

/** A reply shaped like React Native's fetch Response: no `redirected`
 * property at all, `url` = the URL the network stack actually answered. */
function reply(
  path: DeletionPath,
  payload: unknown,
  status = 200,
  options: {
    url?: string;
    redirected?: boolean;
    headers?: Record<string, string>;
  } = {},
): Response {
  const response: Record<string, unknown> = {
    status,
    ok: status >= 200 && status < 300,
    url: options.url ?? `${ORIGIN}/v1/me/${path}`,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
  if (options.redirected !== undefined)
    response.redirected = options.redirected;
  return response as unknown as Response;
}

type Route = (init: RequestInit) => Promise<Response> | Response;

function route(handlers: Partial<Record<DeletionPath, Route>>) {
  mockFetch.mockImplementation(async (input, init) => {
    const path = (Object.keys(handlers) as DeletionPath[]).find(candidate =>
      input.endsWith(`/v1/me/${candidate}`),
    );
    if (!path) throw new Error(`unexpected fetch ${input}`);
    return handlers[path]!(init);
  });
}

function calls(path: DeletionPath) {
  return mockFetch.mock.calls
    .filter(([input]) => input === `${ORIGIN}/v1/me/${path}`)
    .map(([, init]) => init);
}

function bodyOf(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

function journalRows() {
  return mockDatabase.native
    .prepare(
      'SELECT owner_id, operation_id, phase, document FROM device_account_deletion_journal ORDER BY rowid',
    )
    .all();
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

function sheetButtons(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = sheetButtons(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

async function press(
  renderer: TestRenderer.ReactTestRenderer,
  target: { props: { onPress: () => void } },
) {
  await act(async () => {
    target.props.onPress();
  });
}

async function openReview(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, pressable(renderer, 'Delete account')[0]!);
  await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await openReview(renderer);
  await press(renderer, sheetButton(renderer, 'Continue to delete'));
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
}

function signIn(owner: string, bearer: string, provider: 'google' | 'apple') {
  setActiveDataOwner(owner);
  establishApiSession({
    ...apiSessionA,
    bearerToken: bearer,
    canonicalAppUserId: owner,
    provider,
  });
  useAuthStore.setState({
    session: {
      ...sessionA,
      subject: owner,
      canonicalAppUserId: owner,
      provider,
    },
  });
}

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(
    useAuthStore.getState().completeAccountDeletion,
  ).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
}

describe('W08-01 ManageAccount deletion on the durable operation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDatabase = createSqliteTestDb();
    deletionKeychainStore.clear();
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockShowBrandNotice.mockClear();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    signIn(OWNER_A, BEARER_A, 'google');
    useAuthStore.setState({
      hydrated: true,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearApiSession();
    mockDatabase.close();
    jest.useRealTimers();
  });

  it('sends every deletion call redirect-rejecting and bound to the operation id, journaled durably', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const context = { ...captureDataOwnerContext(), provider: 'google' };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      expect(allText(renderer)).toContain('Delete your account?');
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'ready' },
      ]);
      expectNotDeleted(renderer);

      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      const [request] = calls('delete-request');
      expect(request).toMatchObject({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      expect(headerOf(request!, 'Authorization')).toBe(`Bearer ${BEARER_A}`);
      expect(bodyOf(request!)).toEqual({});
      const [confirm] = calls('delete-confirm');
      expect(confirm).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(headerOf(confirm!, 'Authorization')).toBe(`Bearer ${BEARER_A}`);
      expect(bodyOf(confirm!)).toEqual({
        challenge: deletionId(11),
        operationId: deletionId(10),
      });

      const cleanup = useAuthStore.getState().completeAccountDeletion;
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledWith(context);
      expect(mockShowBrandNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Account deleted',
          eyebrow: 'DELETION CONFIRMED',
        }),
      );
      expect(journalRows()).toMatchObject([
        { operation_id: deletionId(10), phase: 'receipt_verified' },
      ]);
      // The capability lives in the Keychain, never the journal; the session
      // bearer is persisted nowhere.
      const secrets = JSON.stringify([...deletionKeychainStore.entries()]);
      expect(secrets).toContain(DELETION_CAPABILITY);
      expect(secrets).not.toContain(BEARER_A);
      const documents = journalRows()
        .map(row => String(row.document))
        .join('\n');
      expect(documents).not.toContain(DELETION_CAPABILITY);
      expect(documents).not.toContain(BEARER_A);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('carries the exit survey on the durable request body', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
    });
    const renderer = renderScreen();
    try {
      await press(renderer, pressable(renderer, 'Delete account')[0]!);
      await press(renderer, pressable(renderer, "It's too expensive")[0]!);
      await press(renderer, sheetButton(renderer, 'Next'));
      await press(
        renderer,
        pressable(renderer, 'A lower price or a free tier')[0]!,
      );
      await press(renderer, sheetButton(renderer, 'Continue'));
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(bodyOf(calls('delete-request')[0]!)).toEqual({
        survey: {
          reason: 'too_expensive',
          wanted: 'price',
          details: null,
          platform: 'ios',
          appVersion: '1.0',
        },
      });
      expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('refuses a redirected step-1 reply, keeps the request unresolved, and retries under the same job', async () => {
    let attempts = 0;
    route({
      'delete-request': () => {
        attempts += 1;
        return attempts === 1
          ? reply('delete-request', requestPayload(), 200, {
              url: 'https://attacker.example/v1/me/delete-request',
            })
          : reply('delete-request', requestPayload(20));
      },
    });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));

      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expect(allText(renderer)).toContain('Nothing has been deleted');
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, phase: 'request_unknown' },
      ]);
      expectNotDeleted(renderer);

      await press(renderer, sheetButton(renderer, 'Retry request'));
      expect(calls('delete-request')).toHaveLength(2);
      expect(journalRows()).toMatchObject([
        { operation_id: deletionId(20), phase: 'ready' },
      ]);
      expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
        'Permanently delete (5)',
      );
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('shows a lost confirmation as unknown and completes only from the status capability receipt', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(allText(renderer)).toContain('may have completed');
      expect(allText(renderer)).not.toContain('Nothing was deleted');
      expect(allText(renderer)).not.toContain('Keep my account');
      expect(sheetButton(renderer, 'Close').props.disabled).toBe(false);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expectNotDeleted(renderer);

      await press(renderer, sheetButton(renderer, 'Retry deletion'));

      const [status] = calls('delete-status');
      expect(status).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(headerOf(status!, 'Authorization')).toBe(
        `Bearer ${DELETION_CAPABILITY}`,
      );
      expect(bodyOf(status!)).toEqual({ operationId: deletionId(10) });
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(mockShowBrandNotice).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Account deleted' }),
      );
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('never renders a redirected confirmation reply as deleted', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply('delete-confirm', completionPayload(), 200, {
          url: 'https://attacker.example/v1/me/delete-confirm',
        }),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('shows a server in-progress confirmation honestly and completes only once the status reports a receipt', async () => {
    const statuses = ['in_progress', 'completed'];
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply(
          'delete-confirm',
          { operationId: deletionId(10), state: 'in_progress' },
          202,
          { headers: { 'retry-after': '2' } },
        ),
      'delete-status': () =>
        reply('delete-status', statusPayload(statuses.shift() ?? 'completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      expect(allText(renderer)).toContain('Deletion in progress');
      expect(allText(renderer)).not.toContain('Nothing was deleted');
      expectNotDeleted(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'observing' }]);

      await act(async () => {
        jest.advanceTimersByTime(2_000);
      });
      await act(async () => {});
      expect(calls('delete-status')).toHaveLength(1);
      expect(allText(renderer)).toContain('Deletion in progress');
      expectNotDeleted(renderer);

      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await act(async () => {});
      expect(calls('delete-status')).toHaveLength(2);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('resumes the same operation after the screen is torn down instead of minting a new request', async () => {
    let confirmAttempts = 0;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => {
        confirmAttempts += 1;
        return confirmAttempts === 1
          ? Promise.reject(new TypeError('Network lost'))
          : reply('delete-confirm', completionPayload());
      },
      'delete-status': () => reply('delete-status', statusPayload('pending')),
    });
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(allText(first)).toContain('Deletion status unknown');
    act(() => first.unmount());

    const second = renderScreen();
    try {
      await press(second, pressable(second, 'Delete account')[0]!);
      expect(allText(second)).not.toContain("What's making you leave?");
      expect(allText(second)).toContain('Deletion status unknown');
      expectNotDeleted(second);

      await press(second, sheetButton(second, 'Retry deletion'));

      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-status')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(2);
      expect(calls('delete-confirm').map(bodyOf)).toEqual([
        { challenge: deletionId(11), operationId: deletionId(10) },
        { challenge: deletionId(11), operationId: deletionId(10) },
      ]);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([
        { operation_id: deletionId(10), phase: 'receipt_verified' },
      ]);
    } finally {
      act(() => second.unmount());
    }
  });

  it('keeps an expired operation honest: no deletion claim until the server says so, then a fresh request', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return reply('delete-request', requestPayload(requests * 10));
      },
      'delete-confirm': () =>
        reply(
          'delete-confirm',
          {
            error: {
              code: 'account.deletion_challenge_expired',
              message: 'The deletion request expired.',
            },
          },
          403,
        ),
      'delete-status': () => reply('delete-status', statusPayload('expired')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain('expired');
      expect(allText(renderer)).not.toContain('Nothing was deleted');
      expectNotDeleted(renderer);

      await press(renderer, sheetButton(renderer, 'Retry deletion'));
      expect(calls('delete-status')).toHaveLength(1);
      expect(allText(renderer)).toContain('Nothing was deleted');
      expectNotDeleted(renderer);

      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(calls('delete-request')).toHaveLength(2);
      expect(journalRows()).toMatchObject([
        { operation_id: deletionId(10), phase: 'observing' },
        { operation_id: deletionId(20), phase: 'ready' },
      ]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("isolates the original owner's operation from a replacement account", async () => {
    route({
      'delete-request': init =>
        reply(
          'delete-request',
          requestPayload(
            headerOf(init, 'Authorization') === `Bearer ${BEARER_A}` ? 10 : 20,
          ),
        ),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
    });
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(journalRows()).toMatchObject([
      { owner_id: OWNER_A, phase: 'confirm_pending' },
    ]);
    act(() => first.unmount());
    const keychainBefore = JSON.stringify([...deletionKeychainStore.entries()]);

    signIn(OWNER_B, BEARER_B, 'apple');
    const second = renderScreen();
    try {
      await press(second, pressable(second, 'Delete account')[0]!);
      expect(allText(second)).toContain("What's making you leave?");
      expect(allText(second)).not.toContain('Deletion status unknown');
      await press(second, pressable(second, 'Skip the survey')[0]!);
      await press(second, sheetButton(second, 'Continue to delete'));

      const requests = calls('delete-request');
      expect(requests).toHaveLength(2);
      expect(headerOf(requests[1]!, 'Authorization')).toBe(
        `Bearer ${BEARER_B}`,
      );
      expect(journalRows()).toMatchObject([
        {
          owner_id: OWNER_A,
          operation_id: deletionId(10),
          phase: 'confirm_pending',
        },
        { owner_id: OWNER_B, operation_id: deletionId(20), phase: 'ready' },
      ]);
      expect(JSON.stringify([...deletionKeychainStore.entries()])).toContain(
        keychainBefore.slice(1, -1),
      );
      expectNotDeleted(second);
    } finally {
      act(() => second.unmount());
    }
  });

  it('never confirms with a replacement account after the owner changes during the countdown', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'google');
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      expect(calls('delete-confirm')).toHaveLength(0);
      expect(allText(renderer)).toContain('The signed-in account changed.');
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  describe('fetchNoRedirect', () => {
    const url = `${ORIGIN}/v1/me/delete-request`;
    const init = {
      method: 'POST' as const,
      redirect: 'error' as const,
      credentials: 'omit' as const,
      cache: 'no-store' as const,
      referrerPolicy: 'no-referrer' as const,
      headers: { Accept: 'application/json' },
      body: '{}',
    };

    it('forwards the redirect-rejecting init and marks an in-place reply as not redirected', async () => {
      mockFetch.mockResolvedValue(reply('delete-request', requestPayload()));
      const response = await fetchNoRedirect(url, init);
      expect(mockFetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
      );
      expect(response.redirected).toBe(false);
      expect(response.url).toBe(url);
    });

    it('marks a reply answered from another URL as redirected', async () => {
      mockFetch.mockResolvedValue(
        reply('delete-request', requestPayload(), 200, {
          url: 'https://attacker.example/v1/me/delete-request',
        }),
      );
      const response = await fetchNoRedirect(url, init);
      expect(response.redirected).toBe(true);
    });

    it('keeps a reply the platform already flagged as redirected', async () => {
      mockFetch.mockResolvedValue(
        reply('delete-request', requestPayload(), 200, { redirected: true }),
      );
      const response = await fetchNoRedirect(url, init);
      expect(response.redirected).toBe(true);
    });

    it('rejects a reply with no URL at all', async () => {
      mockFetch.mockResolvedValue(
        reply('delete-request', requestPayload(), 200, { url: '' }),
      );
      const response = await fetchNoRedirect(url, init);
      expect(response.redirected).toBe(true);
    });
  });
});
