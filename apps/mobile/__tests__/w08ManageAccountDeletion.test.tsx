import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';

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
 *   - the original owner's operation is isolated from a replacement account;
 *   - the failure boundaries stay honest and recoverable: a crash between
 *     the journal and Keychain writes never reads as "may have completed",
 *     a double tap is one request / one confirmation, and abandoned requests
 *     never fill the journal for good;
 *   - an owner change while a confirmation is in flight leaves the UNKNOWN
 *     outcome on screen (never a re-armed challenge);
 *   - when the local database cannot be opened at all, every call still
 *     goes out redirect-rejecting and bound to the operation id, and a
 *     redirected reply is still never rendered as deleted.
 */

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

let mockDatabase: ReturnType<typeof createSqliteTestDb>;
let mockDatabaseUnavailable = false;
jest.mock('../src/data/db', () => ({
  getDb: () => {
    if (mockDatabaseUnavailable) throw new Error('SQLITE_CORRUPT');
    return mockDatabase.db;
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
jest.mock('../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import { ManageAccountScreen } from '../src/screens/ManageAccountScreen';
import { BrandSpinner, Button } from '../src/design/components';
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

/** deletionOperationContracts.DELETION_FOUNDATION_LIMITS.journalEntries. */
const JOURNAL_CAPACITY = 32;
const DAY_MS = 86_400_000;

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
const realSetGenericPassword = Keychain.setGenericPassword;
const realGetGenericPassword = Keychain.getGenericPassword;

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

function statusPayload(state: string) {
  return {
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

/** True when the journal table was never even created on this database. */
function journalAbsent() {
  return (
    mockDatabase.native
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_account_deletion_journal'",
      )
      .all().length === 0
  );
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

function buttonLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Button)
    .map(node => String(node.props.label));
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ownerId(index: number): string {
  const digits = String(index).padStart(12, '0');
  return `33333333-3333-4333-8333-${digits}`;
}

async function press(
  renderer: TestRenderer.ReactTestRenderer,
  target: TestRenderer.ReactTestInstance,
) {
  const onPress: unknown = target.props.onPress;
  if (typeof onPress !== 'function') throw new Error('target is not pressable');
  await act(async () => {
    onPress();
  });
}

/** Presses a paced button: while its label carries a countdown it must be
 * disabled, and the clock is advanced to the moment it re-arms. */
async function pressWhenArmed(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const paced = /\((\d+)\)$/.exec(
    String(sheetButton(renderer, label).props.label),
  );
  if (paced) {
    expect(sheetButton(renderer, label).props.disabled).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(Number(paced[1]) * 1000);
    });
  }
  expect(sheetButton(renderer, label).props.disabled).toBe(false);
  await press(renderer, sheetButton(renderer, label));
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

/** Opens the sheet only: what it shows is decided by the journal. */
async function openDeleteSheet(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, pressable(renderer, 'Delete account')[0]!);
  await act(async () => {});
}

function expectDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(useAuthStore.getState().completeAccountDeletion).toHaveBeenCalledTimes(
    1,
  );
  expect(mockShowBrandNotice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Account deleted' }),
  );
  expect(allText(renderer)).not.toContain('Deletion status unknown');
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

/** The dialog says the outcome is unknown: no re-armed destructive action,
 * no "keep" reassurance, no claim that nothing was deleted. */
function expectUnknownOutcome(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).toContain('Deletion status unknown');
  expect(text).not.toContain('Delete your account?');
  expect(text).not.toContain('Nothing was deleted');
  expect(text).not.toContain('Keep my account');
  expect(
    sheetButtons(renderer, 'Permanently delete').filter(
      node => node.props.disabled !== true,
    ),
  ).toHaveLength(0);
  expect(sheetButton(renderer, 'Close').props.disabled).toBe(false);
}

/** The server refused a new request because a confirmation for this account
 * is already being carried out (409 account.deletion_in_progress): nothing
 * new was sent, so the screen may neither claim nothing was deleted nor
 * offer another request. */
function expectAlreadyConfirmed(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).toContain('Deletion in progress');
  expect(text).not.toContain('Delete your account?');
  expect(text).not.toContain('Deletion status unknown');
  expect(text).not.toContain('Nothing was deleted');
  expect(text).not.toContain('Nothing has been deleted');
  expect(text).not.toContain('Keep my account');
  expect(buttonLabels(renderer)).toEqual(['Close']);
  expect(sheetButton(renderer, 'Close').props.disabled).toBe(false);
}

/** Edge API requestAccountDeletion while a confirmation is in progress. */
function deletionInProgressError() {
  return {
    error: {
      code: 'account.deletion_in_progress',
      message:
        'Account deletion is already confirmed. Check its status before starting again.',
    },
  };
}

/** Edge API once the bearer no longer authenticates (the account behind it
 * is gone, or the session was fenced by the confirmation). */
function sessionInvalidError() {
  return {
    error: { message: 'The session is no longer valid. Sign in again.' },
  };
}

describe('W08-01 ManageAccount deletion on the durable operation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDatabase = createSqliteTestDb();
    mockDatabaseUnavailable = false;
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

      await pressWhenArmed(renderer, 'Retry deletion');

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

      await pressWhenArmed(second, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(allText(second)).toContain('Delete your account?');
      expectNotDeleted(second);

      await pressWhenArmed(second, 'Permanently delete');
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

      await pressWhenArmed(renderer, 'Retry deletion');
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

  it('keeps the UNKNOWN outcome on screen when the owner changes while a confirmation is in flight and its reply is lost — never a re-armed "Permanently delete" or "Keep my account"', async () => {
    const confirm = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => confirm.promise,
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(buttonLabels(renderer)).toContain('Deleting…');

      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'google');
        confirm.reject(new TypeError('Network request failed'));
      });
      await act(async () => {});

      expect(journalRows()).toMatchObject([
        {
          owner_id: OWNER_A,
          operation_id: deletionId(10),
          phase: 'confirm_pending',
        },
      ]);
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(allText(renderer)).toContain('may have completed');

      // The unknown state never re-sends anything under the replacement
      // account, and it never becomes a fresh request either.
      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(calls('delete-status')).toHaveLength(0);
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, phase: 'confirm_pending' },
      ]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('keeps the UNKNOWN outcome on screen when the owner changes while a confirmation is in flight and the reply is redirected', async () => {
    const confirm = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => confirm.promise,
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'apple');
        confirm.resolve(
          reply('delete-confirm', completionPayload(), 200, {
            url: 'https://attacker.example/v1/me/delete-confirm',
          }),
        );
      });
      await act(async () => {});

      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, phase: 'confirm_pending' },
      ]);
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
    } finally {
      act(() => renderer.unmount());
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

  it('treats a Keychain write lost after the `securing` journal write as nothing deleted: no unknown-outcome claim on re-entry, and a fresh request is offered', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return reply('delete-request', requestPayload(requests * 10));
      },
      'delete-confirm': () => reply('delete-confirm', completionPayload(20)),
    });
    // The device Keychain refuses exactly one write — the one that stores
    // the status capability right after the journal moved to `securing`.
    // This is the persisted state a process death between the two writes
    // leaves behind: journal row with an operation id, no capability.
    const keychainWrite = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('errSecInteractionNotAllowed'));

    const first = renderScreen();
    try {
      await openReview(first);
      await press(first, sheetButton(first, 'Continue to delete'));

      expect(sheetButtons(first, 'Permanently delete')).toHaveLength(0);
      expect(allText(first)).toContain('Nothing was deleted');
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'securing' },
      ]);
      expect(deletionKeychainStore.size).toBe(0);
      expectNotDeleted(first);
      act(() => first.unmount());

      // Relaunch: no confirmation was ever sent (the operation never reached
      // `ready`), so the screen must not claim the request may have
      // completed, must not spend a status check on it, and must let the
      // owner start a fresh request.
      const second = renderScreen();
      try {
        await press(second, pressable(second, 'Delete account')[0]!);
        await act(async () => {});
        const text = allText(second);
        expect(text).not.toContain('Deletion status unknown');
        expect(text).not.toContain('may have completed');
        expect(sheetButtons(second, 'Retry deletion')).toHaveLength(0);
        expect(text).toContain("What's making you leave?");
        expect(calls('delete-status')).toHaveLength(0);

        await press(second, pressable(second, 'Skip the survey')[0]!);
        await press(second, sheetButton(second, 'Continue to delete'));
        expect(calls('delete-request')).toHaveLength(2);
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'securing' },
          { owner_id: OWNER_A, operation_id: deletionId(20), phase: 'ready' },
        ]);
        await advance(5_000);
        await press(second, sheetButton(second, 'Permanently delete'));
        expect(calls('delete-confirm').map(bodyOf)).toEqual([
          { challenge: deletionId(21), operationId: deletionId(20) },
        ]);
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'securing' },
          { operation_id: deletionId(20), phase: 'receipt_verified' },
        ]);
      } finally {
        act(() => second.unmount());
      }
    } finally {
      keychainWrite.mockRestore();
    }
  });

  it('mints one request and one journal entry for two presses of "Continue to delete" in one frame', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return reply('delete-request', requestPayload(requests * 10));
      },
    });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await act(async () => {
        const button = sheetButton(renderer, 'Continue to delete');
        button.props.onPress();
        button.props.onPress();
      });
      await act(async () => {});

      expect(calls('delete-request')).toHaveLength(1);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'ready' },
      ]);
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('keeps "Deleting…" on screen for two presses of "Permanently delete" in one frame: one confirmation, no account-changed or unknown copy', async () => {
    const confirm = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => confirm.promise,
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        const button = sheetButton(renderer, 'Permanently delete');
        button.props.onPress();
        button.props.onPress();
      });
      await act(async () => {});

      expect(calls('delete-confirm')).toHaveLength(1);
      const text = allText(renderer);
      expectNotDeleted(renderer);
      expect(text).not.toContain('The signed-in account changed.');
      expect(text).not.toContain('Deletion status unknown');
      expect(text).not.toContain('may have completed');
      expect(buttonLabels(renderer)).toEqual(['Keep my account', 'Deleting…']);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

      await act(async () => {
        confirm.resolve(reply('delete-confirm', completionPayload()));
      });
      await act(async () => {});
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('reclaims expired abandoned requests when the journal is full so the owner can still delete the account', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return reply('delete-request', requestPayload(requests * 10));
      },
    });
    const renderer = renderScreen();
    try {
      for (let day = 0; day < JOURNAL_CAPACITY; day += 1) {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        await press(renderer, sheetButton(renderer, 'Keep my account'));
        // The status window (24h) lapses before the owner comes back.
        await advance(DAY_MS + 60_000);
      }
      expect(calls('delete-request')).toHaveLength(JOURNAL_CAPACITY);
      expect(journalRows()).toHaveLength(JOURNAL_CAPACITY);
      expectNotDeleted(renderer);

      // Day 33: nothing is resumable, so the owner must be able to start a
      // fresh request — the account-deletion path may never go dark.
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(allText(renderer)).not.toContain('could not be recorded');
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
      expect(calls('delete-request')).toHaveLength(JOURNAL_CAPACITY + 1);
      expect(journalRows()).toMatchObject([
        {
          owner_id: OWNER_A,
          operation_id: deletionId((JOURNAL_CAPACITY + 1) * 10),
          phase: 'ready',
        },
      ]);
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('does not reclaim live requests of other accounts and does not promise that retrying will help when the journal cannot be reclaimed', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return reply('delete-request', requestPayload(requests * 10));
      },
    });
    const renderer = renderScreen();
    try {
      for (let index = 0; index < JOURNAL_CAPACITY; index += 1) {
        await act(async () => {
          signIn(ownerId(index), `session.bearer.${index}`, 'google');
        });
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        await press(renderer, sheetButton(renderer, 'Keep my account'));
      }
      expect(journalRows()).toHaveLength(JOURNAL_CAPACITY);

      await act(async () => {
        signIn(OWNER_A, BEARER_A, 'google');
      });
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(calls('delete-request')).toHaveLength(JOURNAL_CAPACITY);
      expect(journalRows()).toHaveLength(JOURNAL_CAPACITY);
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      const text = allText(renderer);
      expect(text).toContain('Nothing was deleted');
      expect(text).not.toContain('please try again');
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('refuses to confirm with a challenge the device clock says has expired and offers a fresh request instead of re-arming silently', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return reply('delete-request', requestPayload(requests * 10));
      },
      'delete-confirm': () => reply('delete-confirm', completionPayload(20)),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      // The owner walks away; the 15-minute challenge lapses.
      await advance(900_000);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      expect(calls('delete-confirm')).toHaveLength(0);
      expect(calls('delete-status')).toHaveLength(0);
      const text = allText(renderer);
      expect(text).toContain('expired');
      expect(text).toContain('Nothing was deleted');
      expect(text).not.toContain('Deletion status unknown');
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expectNotDeleted(renderer);

      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(calls('delete-request')).toHaveLength(2);
      await advance(5_000);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(calls('delete-confirm').map(bodyOf)).toEqual([
        { challenge: deletionId(21), operationId: deletionId(20) },
      ]);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  describe('when the local database cannot be opened', () => {
    beforeEach(() => {
      mockDatabaseUnavailable = true;
    });

    it('still sends redirect-rejecting, operation-bound calls and completes only from an in-place verified reply', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const context = { ...captureDataOwnerContext(), provider: 'google' };
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        const [request] = calls('delete-request');
        expect(request).toMatchObject({
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        expect(headerOf(request!, 'Authorization')).toBe(`Bearer ${BEARER_A}`);
        expectNotDeleted(renderer);

        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        const [confirm] = calls('delete-confirm');
        expect(confirm).toMatchObject({
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        expect(headerOf(confirm!, 'Authorization')).toBe(`Bearer ${BEARER_A}`);
        expect(bodyOf(confirm!)).toEqual({
          challenge: deletionId(11),
          operationId: deletionId(10),
        });
        const cleanup = useAuthStore.getState().completeAccountDeletion;
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledWith(context);
        expect(mockShowBrandNotice).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Account deleted' }),
        );
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('never renders a redirected confirmation reply as deleted and keeps the outcome unknown', async () => {
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
        expect(calls('delete-confirm')).toHaveLength(1);
        expectNotDeleted(renderer);
        expectUnknownOutcome(renderer);
        expect(allText(renderer)).toContain('may have completed');
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('never trusts a confirmation reply that names another operation', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload(20)),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(calls('delete-confirm')).toHaveLength(1);
        expectNotDeleted(renderer);
        expectUnknownOutcome(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('refuses a redirected step-1 reply: nothing is armed and nothing was deleted', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', requestPayload(), 200, {
            url: 'https://attacker.example/v1/me/delete-request',
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(allText(renderer)).toContain('Nothing was deleted');
        expect(allText(renderer)).not.toContain('Deletion status unknown');
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('an attempt stays bound to the flow and outcome it started with', () => {
    it('durable: a 409 deletion_in_progress on the request shows the in-progress deletion, never "nothing deleted" or a new request', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', deletionInProgressError(), 409),
      });
      const renderer = renderScreen();
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expectAlreadyConfirmed(renderer);
      expectNotDeleted(renderer);
      expect(calls('delete-request')).toHaveLength(1);
      expect(journalRows()).toMatchObject([{ phase: 'request_unknown' }]);
      expect(String(journalRows()[0]!.document)).toContain(
        '"lastIssue":"in_progress"',
      );
      act(() => renderer.unmount());

      // Re-entry surfaces the same refusal instead of the survey.
      const reopened = renderScreen();
      try {
        await openDeleteSheet(reopened);
        expect(allText(reopened)).not.toContain("What's making you leave?");
        expectAlreadyConfirmed(reopened);
        expect(calls('delete-request')).toHaveLength(1);
        expectNotDeleted(reopened);
      } finally {
        act(() => reopened.unmount());
      }
    });

    it('fallback: a 409 deletion_in_progress on the request shows the in-progress deletion, never "Delete your account?"', async () => {
      mockDatabaseUnavailable = true;
      route({
        'delete-request': () =>
          reply('delete-request', deletionInProgressError(), 409),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expectAlreadyConfirmed(renderer);
        expectNotDeleted(renderer);
        expect(calls('delete-request')).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('fallback: a 401 on the retry of a lost confirmation stays unknown — the dead bearer proves nothing', async () => {
      mockDatabaseUnavailable = true;
      let confirmAttempts = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirmAttempts += 1;
          return confirmAttempts === 1
            ? Promise.reject(new TypeError('Network lost'))
            : reply('delete-confirm', sessionInvalidError(), 401);
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-confirm')).toHaveLength(2);
        expectUnknownOutcome(renderer);
        expect(allText(renderer)).toContain('does not confirm');
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('fallback: a 429 refusing the first confirmation re-arms the SAME challenge (the server acted on nothing), never a new request', async () => {
      mockDatabaseUnavailable = true;
      let confirmAttempts = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirmAttempts += 1;
          return confirmAttempts === 1
            ? reply(
                'delete-confirm',
                { error: { message: 'Too many requests.' } },
                429,
              )
            : reply('delete-confirm', completionPayload());
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain('Too many requests.');
        expect(allText(renderer)).not.toContain('Deletion status unknown');
        expectNotDeleted(renderer);
        expect(calls('delete-request')).toHaveLength(1);

        await pressWhenArmed(renderer, 'Permanently delete');
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(2);
        expect(bodyOf(calls('delete-confirm')[1]!)).toEqual({
          challenge: deletionId(11),
          operationId: deletionId(10),
        });
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('fallback: a 429 on the retry of a lost confirmation stays unknown — the first send may already have acted', async () => {
      mockDatabaseUnavailable = true;
      let confirmAttempts = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirmAttempts += 1;
          return confirmAttempts === 1
            ? Promise.reject(new TypeError('Network lost'))
            : reply(
                'delete-confirm',
                { error: { message: 'Too many requests.' } },
                429,
              );
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-confirm')).toHaveLength(2);
        expectUnknownOutcome(renderer);
        expect(allText(renderer)).toContain('Too many requests.');
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('fallback: a request minted while the database was down is confirmed exactly once through the same flow after the database recovers', async () => {
      mockDatabaseUnavailable = true;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        expect(allText(renderer)).toContain('Delete your account?');
        mockDatabaseUnavailable = false;

        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(bodyOf(calls('delete-confirm')[0]!)).toEqual({
          challenge: deletionId(11),
          operationId: deletionId(10),
        });
        expect(journalAbsent() || journalRows().length === 0).toBe(true);
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('durable: a request whose confirm step finds the database down still confirms exactly once through the journal', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
        mockDatabaseUnavailable = true;

        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(bodyOf(calls('delete-confirm')[0]!)).toEqual({
          challenge: deletionId(11),
          operationId: deletionId(10),
        });
        expectDeleted(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
        expect(String(journalRows()[0]!.document)).toContain(
          '"serverState":"completed"',
        );
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('durable: a lost confirmation whose status window has lapsed re-enters as unknown, never as the survey', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      } finally {
        act(() => renderer.unmount());
      }

      // The status window (24h) lapses before the owner comes back.
      await advance(2 * DAY_MS);
      const reopened = renderScreen();
      try {
        await openDeleteSheet(reopened);
        expect(allText(reopened)).not.toContain("What's making you leave?");
        expectUnknownOutcome(reopened);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expectNotDeleted(reopened);
      } finally {
        act(() => reopened.unmount());
      }
    });

    it('the account-deleted notice names only the App Store', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectDeleted(renderer);
        expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
        const notice = JSON.stringify(mockShowBrandNotice.mock.calls[0]);
        expect(notice).toContain('App Store');
        expect(notice).not.toMatch(/Google Play|Android/);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  /**
   * Round-4 adversary breaks. After a confirmation has been SENT the server
   * may already have acted on it, so every later signal that is not a
   * verified receipt — `blocked`, a closed status window, an unreadable
   * journal row — is an UNRESOLVED outcome: no "nothing was deleted", no
   * survey, no second request, no spinner or retry that cannot do anything.
   */
  describe('after a sent confirmation, every non-receipt signal stays unresolved', () => {
    const WINDOW_CLOSED = 'The window for checking this deletion has closed';

    /** Close is the only way out; the review copy that mints a request is gone. */
    function expectHeldAfterConfirmation(
      renderer: TestRenderer.ReactTestRenderer,
    ) {
      const text = allText(renderer);
      expect(text).toContain('Deletion status unknown');
      expect(text).not.toContain('Delete your account?');
      expect(text).not.toContain('Keep my account');
      expect(text).not.toContain("What's making you leave?");
      expect(text).not.toContain('Nothing was deleted');
      expect(text).not.toContain('Nothing has been deleted');
      expect(text).not.toContain('Deletion in progress');
      expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expect(sheetButtons(renderer, 'Requesting')).toHaveLength(0);
      expect(sheetButtons(renderer, 'Checking')).toHaveLength(0);
      expect(sheetButton(renderer, 'Close').props.disabled).toBe(false);
      expectNotDeleted(renderer);
    }

    function blockedError() {
      return {
        error: {
          code: 'account.deletion_blocked',
          message: 'This account cannot be deleted right now.',
        },
      };
    }

    /** Mints a request whose confirmation is lost to the network. */
    async function loseConfirmation(renderer: TestRenderer.ReactTestRenderer) {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectUnknownOutcome(renderer);
      expect(journalRows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: 'confirm_pending' }),
        ]),
      );
    }

    it('a status of `blocked` after a lost confirmation stays unresolved and never re-arms a request — in this dialog and on re-entry', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () => reply('delete-status', statusPayload('blocked')),
      });
      const first = renderScreen();
      try {
        await loseConfirmation(first);
        await pressWhenArmed(first, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectHeldAfterConfirmation(first);
        expect(allText(first)).toContain('may have completed');
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'observing' },
        ]);

        // Checking again is allowed; it asks the server, nothing else.
        await pressWhenArmed(first, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(2);
        expectHeldAfterConfirmation(first);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
      } finally {
        act(() => first.unmount());
      }

      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectHeldAfterConfirmation(second);
        expect(calls('delete-request')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
      } finally {
        act(() => second.unmount());
      }
    });

    it('a 409 account.deletion_blocked answering the confirmation itself stays unresolved through the status check and never re-arms a request', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', blockedError(), 409),
        'delete-status': () => reply('delete-status', statusPayload('blocked')),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        expectHeldAfterConfirmation(first);
        expect(allText(first)).toContain('may have completed');
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'confirm_pending' },
        ]);

        await pressWhenArmed(first, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectHeldAfterConfirmation(first);
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'observing' },
        ]);
      } finally {
        act(() => first.unmount());
      }

      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectHeldAfterConfirmation(second);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
      } finally {
        act(() => second.unmount());
      }
    });

    it('a `blocked` operation is never reclaimed from a full journal: the unresolved record outlives the capacity squeeze', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return reply('delete-request', requestPayload(requests * 10));
        },
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () => reply('delete-status', statusPayload('blocked')),
      });
      const renderer = renderScreen();
      try {
        for (let index = 0; index < JOURNAL_CAPACITY - 1; index += 1) {
          await act(async () => {
            signIn(ownerId(index), `session.bearer.${index}`, 'google');
          });
          await openReview(renderer);
          await press(renderer, sheetButton(renderer, 'Continue to delete'));
          expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
          await press(renderer, sheetButton(renderer, 'Keep my account'));
          await advance(DAY_MS + 60_000);
        }
        await act(async () => {
          signIn(OWNER_A, BEARER_A, 'google');
        });
        await loseConfirmation(renderer);
        await pressWhenArmed(renderer, 'Retry deletion');
        expectHeldAfterConfirmation(renderer);
        await press(renderer, sheetButton(renderer, 'Close'));
        expect(journalRows()).toHaveLength(JOURNAL_CAPACITY);

        // Another account squeezes the journal: the lapsed challenges may
        // go, owner A's blocked-after-confirmation row may not.
        await act(async () => {
          signIn(OWNER_B, BEARER_B, 'google');
        });
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(journalRows()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              owner_id: OWNER_A,
              operation_id: deletionId(JOURNAL_CAPACITY * 10),
              phase: 'observing',
            }),
          ]),
        );
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a closed status window while observing stops polling and says the window closed — no 0 ms loop, no spinner, no status calls', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            { operationId: deletionId(10), state: 'in_progress' },
            202,
            { headers: { 'retry-after': '3600' } },
          ),
        'delete-status': () => reply('delete-status', statusPayload('blocked')),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        expect(allText(first)).toContain('Deletion in progress');
        expect(journalRows()).toMatchObject([{ phase: 'observing' }]);
      } finally {
        act(() => first.unmount());
      }

      // Process death; the owner comes back after the 24h status window.
      await advance(25 * 60 * 60 * 1000);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectHeldAfterConfirmation(second);
        expect(allText(second)).toContain(WINDOW_CLOSED);
        expect(buttonLabels(second)).toEqual(['Close']);
        expect(second.root.findAllByType(BrandSpinner)).toHaveLength(0);

        for (let round = 0; round < 25; round += 1) await advance(0);
        await advance(60_000);
        expect(calls('delete-status')).toHaveLength(0);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-request')).toHaveLength(1);
        expectHeldAfterConfirmation(second);
        expect(allText(second)).toContain(WINDOW_CLOSED);
        expect(buttonLabels(second)).toEqual(['Close']);
        expect(journalRows()).toMatchObject([{ phase: 'observing' }]);
      } finally {
        act(() => second.unmount());
      }
    });

    it('a closed status window after a lost confirmation shows the window-closed copy instead of a retry that does nothing', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () => reply('delete-status', statusPayload('blocked')),
      });
      const first = renderScreen();
      try {
        await loseConfirmation(first);
      } finally {
        act(() => first.unmount());
      }

      await advance(25 * 60 * 60 * 1000);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectHeldAfterConfirmation(second);
        expect(allText(second)).toContain(WINDOW_CLOSED);
        expect(allText(second)).not.toContain(
          'Check your connection and retry',
        );
        expect(buttonLabels(second)).toEqual(['Close']);
        expect(sheetButtons(second, 'Retry deletion')).toHaveLength(0);
        expect(calls('delete-status')).toHaveLength(0);
        expect(calls('delete-request')).toHaveLength(1);
      } finally {
        act(() => second.unmount());
      }
    });

    it('a status window that closes while the dialog is open turns the next check into the window-closed state, not a loop', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () => reply('delete-status', statusPayload('blocked')),
      });
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        await advance(25 * 60 * 60 * 1000);
        await pressWhenArmed(renderer, 'Retry deletion');
        expectHeldAfterConfirmation(renderer);
        expect(allText(renderer)).toContain(WINDOW_CLOSED);
        expect(buttonLabels(renderer)).toEqual(['Close']);
        expect(calls('delete-status')).toHaveLength(0);
        expect(calls('delete-request')).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a semantically corrupt journal document over a sent confirmation re-enters as an unresolved record, never as the survey or a second request', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const first = renderScreen();
      try {
        await loseConfirmation(first);
      } finally {
        act(() => first.unmount());
      }

      // The phase column still reads confirm_pending; the document — still
      // valid JSON — no longer agrees with it.
      const [row] = journalRows() as Array<{ document: string }>;
      const corrupt = row!.document.replace(
        '"phase":"confirm_pending"',
        '"phase":"confirm_pendin"',
      );
      expect(corrupt).not.toBe(row!.document);
      mockDatabase.native
        .prepare(
          'UPDATE device_account_deletion_journal SET document = ? WHERE operation_id = ?',
        )
        .run(corrupt, deletionId(10));

      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectHeldAfterConfirmation(second);
        expect(allText(second)).toContain('could not be read');
        expect(buttonLabels(second)).toEqual(['Close']);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  /**
   * Round-5 adversary breaks. Journal rows are owner-scoped: one owner's
   * unreadable row holds THAT owner's re-entry and nobody else's, and a
   * receipt the transport already verified against the operation is the
   * deletion proof — a Keychain that refuses to seal it does not turn the
   * outcome back into "unknown", in this dialog or on any later launch.
   */
  describe('owner-scoped unreadable rows and a journaled verified receipt', () => {
    const WINDOW_CLOSED = 'The window for checking this deletion has closed';
    const UNREADABLE = 'could not be read';

    /** Replaces the owner's journal document with valid JSON that is not a
     * journal entry; the row's columns (owner, phase) stay as they were. */
    function corruptJournalDocument(owner: string) {
      const changed = mockDatabase.native
        .prepare(
          'UPDATE device_account_deletion_journal SET document = ? WHERE owner_id = ?',
        )
        .run('{"version":1,"truncated":true}', owner).changes;
      expect(changed).toBe(1);
    }

    function journalDocument(row: unknown): Record<string, unknown> {
      const { document } = row as { document: string };
      return JSON.parse(document) as Record<string, unknown>;
    }

    function expectFreshEntry(renderer: TestRenderer.ReactTestRenderer) {
      const text = allText(renderer);
      expect(text).toContain("What's making you leave?");
      expect(text).not.toContain(UNREADABLE);
      expect(text).not.toContain('Deletion status unknown');
      expect(text).not.toContain('may have completed');
      expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
    }

    function expectHeldUnreadable(renderer: TestRenderer.ReactTestRenderer) {
      expectUnknownOutcome(renderer);
      expect(allText(renderer)).toContain(UNREADABLE);
      expect(buttonLabels(renderer)).toEqual(['Close']);
      expectNotDeleted(renderer);
    }

    /** Mints a request whose confirmation is lost to the network. */
    async function loseConfirmation(renderer: TestRenderer.ReactTestRenderer) {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectUnknownOutcome(renderer);
      expect(journalRows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner_id: OWNER_A,
            phase: 'confirm_pending',
          }),
        ]),
      );
    }

    /** The device Keychain refuses exactly the SECOND write — the receipt
     * seal that follows a verified `deleted: true` (the first write stored
     * the status capability). Returns the spy so a test can heal it. */
    function refuseReceiptSeal() {
      let writes = 0;
      return jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(async (username, password, options) => {
          writes += 1;
          if (writes === 2) throw new Error('errSecInteractionNotAllowed');
          return realSetGenericPassword(username, password, options);
        });
    }

    it("owner A's unreadable row over a sent confirmation holds only owner A: owner B gets the survey and sends its own request under its own bearer", async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return reply('delete-request', requestPayload(requests * 10));
        },
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const first = renderScreen();
      try {
        await loseConfirmation(first);
      } finally {
        act(() => first.unmount());
      }
      corruptJournalDocument(OWNER_A);

      // Owner B has never touched deletion on this phone.
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'apple');
      });
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectFreshEntry(second);
        await press(second, pressable(second, 'Skip the survey')[0]!);
        await press(second, sheetButton(second, 'Continue to delete'));
        expect(calls('delete-request')).toHaveLength(2);
        expect(headerOf(calls('delete-request')[1]!, 'Authorization')).toBe(
          `Bearer ${BEARER_B}`,
        );
        expect(sheetButtons(second, 'Permanently delete')).toHaveLength(1);
        expect(journalRows()).toMatchObject([
          {
            owner_id: OWNER_A,
            operation_id: deletionId(10),
            phase: 'confirm_pending',
          },
          { owner_id: OWNER_B, operation_id: deletionId(20), phase: 'ready' },
        ]);
        expectNotDeleted(second);
        await press(second, sheetButton(second, 'Keep my account'));
      } finally {
        act(() => second.unmount());
      }

      // Owner A comes back: its own record is still the unreadable one, so
      // its re-entry stays held — no survey, no second request.
      await act(async () => {
        signIn(OWNER_A, BEARER_A, 'google');
      });
      const third = renderScreen();
      try {
        await openDeleteSheet(third);
        expectHeldUnreadable(third);
        expect(calls('delete-request')).toHaveLength(2);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toHaveLength(2);
      } finally {
        act(() => third.unmount());
      }
    });

    it('an unreadable row over a challenge that was never confirmed (phase column `ready`) never claims a confirmation may have happened', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
        expect(calls('delete-confirm')).toHaveLength(0);
      } finally {
        act(() => first.unmount());
      }
      corruptJournalDocument(OWNER_A);
      expect(journalRows()).toMatchObject([
        { phase: 'ready', operation_id: deletionId(10) },
      ]);

      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectFreshEntry(second);
        expect(allText(second)).not.toContain(
          'cannot tell whether a deletion was confirmed',
        );
        expectNotDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });

    it('an unreadable row never blocks reclaiming a full journal for another owner, and is never reclaimed itself', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return reply('delete-request', requestPayload(requests * 10));
        },
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const renderer = renderScreen();
      try {
        for (let index = 0; index < JOURNAL_CAPACITY - 1; index += 1) {
          await act(async () => {
            signIn(ownerId(index), `session.bearer.${index}`, 'google');
          });
          await openReview(renderer);
          await press(renderer, sheetButton(renderer, 'Continue to delete'));
          expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
          await press(renderer, sheetButton(renderer, 'Keep my account'));
          await advance(DAY_MS + 60_000);
        }
        await act(async () => {
          signIn(OWNER_A, BEARER_A, 'google');
        });
        await loseConfirmation(renderer);
        await press(renderer, sheetButton(renderer, 'Close'));
        expect(journalRows()).toHaveLength(JOURNAL_CAPACITY);
        corruptJournalDocument(OWNER_A);

        // Owner B squeezes the full journal: the lapsed challenges go, owner
        // A's unreadable row (a confirmation may be behind it) stays.
        await act(async () => {
          signIn(OWNER_B, BEARER_B, 'google');
        });
        await openDeleteSheet(renderer);
        expectFreshEntry(renderer);
        await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(calls('delete-request')).toHaveLength(JOURNAL_CAPACITY + 1);
        expect(headerOf(calls('delete-request').at(-1)!, 'Authorization')).toBe(
          `Bearer ${BEARER_B}`,
        );
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        expect(journalRows()).toMatchObject([
          {
            owner_id: OWNER_A,
            operation_id: deletionId(JOURNAL_CAPACITY * 10),
            phase: 'confirm_pending',
            document: '{"version":1,"truncated":true}',
          },
          { owner_id: OWNER_B, phase: 'ready' },
        ]);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a server-verified receipt the Keychain refused to seal is shown as completed, not "may have completed"', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const seal = refuseReceiptSeal();
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});

        // The confirmation reply was received in place, bound to the
        // operation and its receipt verified: the journal row holds it,
        // the Keychain does not.
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(0);
        const [row] = journalRows();
        expect(row).toMatchObject({
          owner_id: OWNER_A,
          operation_id: deletionId(10),
          phase: 'receipt_pending',
        });
        expect(journalDocument(row)).toMatchObject({
          serverState: 'completed',
          receipt: {
            completedAt: expect.any(String),
            appleAuthorizationRevocation: 'revoked',
          },
        });
        expect(deletionKeychainStore.size).toBe(1);

        expect(allText(renderer)).not.toContain('may have completed');
        expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
        expectDeleted(renderer);
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledWith(expect.objectContaining({ ownerKey: OWNER_A }));
      } finally {
        act(() => renderer.unmount());
        seal.mockRestore();
      }
    });

    it('a relaunch after the status window with a healthy Keychain completes from the journaled receipt — never "window closed", never a status call', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const seal = refuseReceiptSeal();
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {});
        expect(journalRows()).toMatchObject([{ phase: 'receipt_pending' }]);
        expect(journalDocument(journalRows()[0])).toMatchObject({
          serverState: 'completed',
          receipt: { completedAt: expect.any(String) },
        });
      } finally {
        act(() => first.unmount());
        seal.mockRestore();
      }
      useAuthStore.setState({
        completeAccountDeletion: jest.fn(() => Promise.resolve()),
      });
      mockShowBrandNotice.mockClear();

      // The Keychain works again; the app comes back after 25 hours.
      await advance(25 * 60 * 60 * 1000);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        const text = allText(second);
        expect(text).not.toContain(WINDOW_CLOSED);
        expect(text).not.toContain('contact support');
        expect(sheetButtons(second, 'Retry deletion')).toHaveLength(0);
        expectDeleted(second);
        expect(calls('delete-status')).toHaveLength(0);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
        expect(journalDocument(journalRows()[0])).toMatchObject({
          serverState: 'completed',
          receipt: { completedAt: expect.any(String) },
        });
      } finally {
        act(() => second.unmount());
      }
    });
  });

  /**
   * Round-6 adversary breaks. The Keychain record beside a journal row
   * authorizes cleanup; it is not the deletion proof. A receipt the transport
   * verified against the operation completes the deletion even when the
   * Keychain cannot answer at all (locked / protected data unavailable) or
   * its item is gone after a device restore — on this launch and on the
   * next. And a row whose identifying SQLite COLUMNS are damaged (not just
   * its document) is attributed only as far as its columns still allow:
   * it never locks another owner out, and never turns into a fresh start
   * for the owner it still names.
   */
  describe('receipts the Keychain cannot vouch for, and rows with damaged identifying columns', () => {
    const WINDOW_CLOSED = 'The window for checking this deletion has closed';
    const UNREADABLE = 'could not be read';

    function journalDocument(row: unknown): Record<string, unknown> {
      const { document } = row as { document: string };
      return JSON.parse(document) as Record<string, unknown>;
    }

    function expectFreshEntry(renderer: TestRenderer.ReactTestRenderer) {
      const text = allText(renderer);
      expect(text).toContain("What's making you leave?");
      expect(text).not.toContain(UNREADABLE);
      expect(text).not.toContain('Deletion status unknown');
      expect(text).not.toContain('may have completed');
      expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
    }

    function expectHeldUnreadable(renderer: TestRenderer.ReactTestRenderer) {
      expectUnknownOutcome(renderer);
      expect(allText(renderer)).toContain(UNREADABLE);
      expect(buttonLabels(renderer)).toEqual(['Close']);
      expectNotDeleted(renderer);
    }

    function expectCompletedFromReceipt(
      renderer: TestRenderer.ReactTestRenderer,
    ) {
      const text = allText(renderer);
      expect(text).not.toContain('may have completed');
      expect(text).not.toContain('Check your connection');
      expect(text).not.toContain(UNREADABLE);
      expect(text).not.toContain('contact support');
      expect(text).not.toContain(WINDOW_CLOSED);
      expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
      expectDeleted(renderer);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledWith(expect.objectContaining({ ownerKey: OWNER_A }));
    }

    function resetCleanupSpies() {
      useAuthStore.setState({
        completeAccountDeletion: jest.fn(() => Promise.resolve()),
      });
      mockShowBrandNotice.mockClear();
    }

    /** The Keychain stops answering at all — reads AND writes throw, the
     * way errSecInteractionNotAllowed / errSecNotAvailable surface — once
     * `down()` is called. Every call before that is real. */
    function keychainOutage() {
      let down = false;
      const set = jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(async (username, password, options) => {
          if (down) throw new Error('errSecNotAvailable');
          return realSetGenericPassword(username, password, options);
        });
      const get = jest
        .spyOn(Keychain, 'getGenericPassword')
        .mockImplementation(async options => {
          if (down) throw new Error('errSecNotAvailable');
          return realGetGenericPassword(options);
        });
      return {
        down: () => {
          down = true;
        },
        restore: () => {
          set.mockRestore();
          get.mockRestore();
        },
      };
    }

    /** The Keychain refuses exactly the SECOND write — the receipt seal. */
    function refuseReceiptSeal() {
      let writes = 0;
      return jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(async (username, password, options) => {
          writes += 1;
          if (writes === 2) throw new Error('errSecInteractionNotAllowed');
          return realSetGenericPassword(username, password, options);
        });
    }

    /** Confirms owner A's deletion; the reply is verified in place. */
    async function confirmVerified(renderer: TestRenderer.ReactTestRenderer) {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(journalDocument(journalRows()[0])).toMatchObject({
        serverState: 'completed',
        receipt: {
          completedAt: expect.any(String),
          appleAuthorizationRevocation: 'revoked',
        },
      });
    }

    /** Rewrites one identifying column of owner A's row to a value that
     * satisfies the table's CHECK constraints but is no longer well-formed;
     * the document is untouched. */
    function damageColumn(column: 'owner_id' | 'operation_id') {
      const damaged = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz';
      const changed = mockDatabase.native
        .prepare(
          `UPDATE device_account_deletion_journal SET ${column} = ? WHERE owner_id = ?`,
        )
        .run(damaged, OWNER_A).changes;
      expect(changed).toBe(1);
      return damaged;
    }

    it('a confirmation reply verified while the Keychain is wholly unavailable completes on this launch — not "may have completed", no network hint, no status call', async () => {
      const keychain = keychainOutage();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          // Protected data becomes unavailable between sending the
          // confirmation and receiving its reply; the reply is verified
          // against the operation regardless.
          keychain.down();
          return reply('delete-confirm', completionPayload());
        },
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await confirmVerified(renderer);
        expect(journalRows()).toMatchObject([
          {
            owner_id: OWNER_A,
            operation_id: deletionId(10),
            phase: 'receipt_pending',
          },
        ]);
        expect(deletionKeychainStore.size).toBe(1);
        expect(calls('delete-status')).toHaveLength(0);
        expectCompletedFromReceipt(renderer);
      } finally {
        act(() => renderer.unmount());
        keychain.restore();
      }
    });

    it('a relaunch whose Keychain item is gone over a receipt the Keychain never sealed completes from the journaled receipt — never "could not be read… contact support"', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const seal = refuseReceiptSeal();
      const first = renderScreen();
      try {
        await confirmVerified(first);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_pending' }]);
      } finally {
        act(() => first.unmount());
        seal.mockRestore();
      }
      resetCleanupSpies();

      // THIS_DEVICE_ONLY Keychain items do not come back with a backup
      // restore; the SQLite journal (and its verified receipt) does.
      deletionKeychainStore.clear();
      await advance(60_000);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectCompletedFromReceipt(second);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(0);
        expect(journalRows()).toHaveLength(1);
      } finally {
        act(() => second.unmount());
      }
    });

    it('a relaunch whose Keychain item is gone over a sealed receipt (receipt_verified) still completes from the journaled receipt, without a status call', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const first = renderScreen();
      try {
        await confirmVerified(first);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
        expectDeleted(first);
      } finally {
        act(() => first.unmount());
      }
      resetCleanupSpies();

      deletionKeychainStore.clear();
      await advance(60_000);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectCompletedFromReceipt(second);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(0);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
      } finally {
        act(() => second.unmount());
      }
    });

    it("owner A's row whose owner_id column is no longer a UUID never locks owner B out: B gets the survey and requests under its own bearer", async () => {
      const confirm = deferred<Response>();
      route({
        'delete-request': init =>
          reply(
            'delete-request',
            requestPayload(
              headerOf(init, 'Authorization') === `Bearer ${BEARER_A}`
                ? 10
                : 20,
            ),
          ),
        'delete-confirm': () => confirm.promise,
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {
          confirm.reject(new TypeError('Network request failed'));
        });
        await act(async () => {});
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, phase: 'confirm_pending' },
        ]);
      } finally {
        act(() => first.unmount());
      }
      const damagedOwner = damageColumn('owner_id');

      mockFetch.mockClear();
      resetCleanupSpies();
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'apple');
      });
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectFreshEntry(second);
        await press(second, pressable(second, 'Skip the survey')[0]!);
        await press(second, sheetButton(second, 'Continue to delete'));
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(1);
        expect(headerOf(calls('delete-request')[0]!, 'Authorization')).toBe(
          `Bearer ${BEARER_B}`,
        );
        expect(sheetButtons(second, 'Permanently delete')).toHaveLength(1);
        // The damaged row is left exactly as it was: never rewritten,
        // never reclaimed.
        expect(journalRows()).toMatchObject([
          {
            owner_id: damagedOwner,
            operation_id: deletionId(10),
            phase: 'confirm_pending',
          },
          { owner_id: OWNER_B, operation_id: deletionId(20), phase: 'ready' },
        ]);
        expectNotDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });

    it("owner A's row whose operation_id column is damaged still names owner A over a sent confirmation: A stays held, B gets the survey", async () => {
      const confirm = deferred<Response>();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => confirm.promise,
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {
          confirm.reject(new TypeError('Network request failed'));
        });
        await act(async () => {});
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, phase: 'confirm_pending' },
        ]);
      } finally {
        act(() => first.unmount());
      }
      damageColumn('operation_id');

      // Owner A: the row is still A's and a confirmation left this phone
      // behind it, so A's re-entry stays held — no survey, no new request.
      mockFetch.mockClear();
      resetCleanupSpies();
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectHeldUnreadable(second);
        expect(calls('delete-request')).toHaveLength(0);
      } finally {
        act(() => second.unmount());
      }

      // Owner B has never touched deletion on this phone.
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'apple');
      });
      const third = renderScreen();
      try {
        await openDeleteSheet(third);
        expectFreshEntry(third);
        await press(third, pressable(third, 'Skip the survey')[0]!);
        await press(third, sheetButton(third, 'Continue to delete'));
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(1);
        expect(headerOf(calls('delete-request')[0]!, 'Authorization')).toBe(
          `Bearer ${BEARER_B}`,
        );
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, phase: 'confirm_pending' },
          { owner_id: OWNER_B, operation_id: deletionId(10), phase: 'ready' },
        ]);
        expectNotDeleted(third);
      } finally {
        act(() => third.unmount());
      }
    });
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
