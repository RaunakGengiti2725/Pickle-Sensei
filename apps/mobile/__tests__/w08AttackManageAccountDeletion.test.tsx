import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';

/**
 * W08-01 adversarial suite against candidate 7847209a.
 *
 * Each test is one attack at a failure boundary of the shipping
 * ManageAccount deletion path (durable operation over the redirect-rejecting
 * transport). The assertions state the EXPECTED behaviour, so a failing test
 * here is a reproduced break of the candidate, not a broken test. Attacks
 * that the candidate withstands pass and are still reported as tried.
 *
 * Drives the real screen against a real SQLite journal, the in-memory
 * Keychain mock and a routed `globalThis.fetch` — the same seams the
 * candidate's own suite uses; nothing in the candidate is modified.
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
import { BrandSpinner, Button } from '../src/design/components';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import { getRuntimePublicConfig } from '../src/config/runtimeConfig';
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

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** deletionOperationTransport default request deadline. */
const TRANSPORT_TIMEOUT_MS = 15_000;

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

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function requestPayload(operation = 10) {
  return {
    challenge: deletionId(operation + 1),
    expiresAt: iso(900_000),
    operationId: deletionId(operation),
    statusCapability: DELETION_CAPABILITY,
    statusExpiresAt: iso(DAY_MS),
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

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

interface JournalRow {
  owner_id: string;
  operation_id: string | null;
  phase: string;
  document: string;
}

function journalRows(): JournalRow[] {
  return mockDatabase.native
    .prepare(
      'SELECT owner_id, operation_id, phase, document FROM device_account_deletion_journal ORDER BY rowid',
    )
    .all() as JournalRow[];
}

function journalDocument(row: JournalRow): Record<string, unknown> {
  return JSON.parse(row.document) as Record<string, unknown>;
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

/** Presses a paced button once its countdown (if any) has run out. */
async function pressWhenArmed(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const paced = /\((\d+)\)$/.exec(
    String(sheetButton(renderer, label).props.label),
  );
  if (paced) {
    expect(sheetButton(renderer, label).props.disabled).toBe(true);
    await advance(Number(paced[1]) * 1000);
  }
  expect(sheetButton(renderer, label).props.disabled).toBe(false);
  await press(renderer, sheetButton(renderer, label));
  await act(async () => {});
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

async function openDeleteSheet(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, pressable(renderer, 'Delete account')[0]!);
  await act(async () => {});
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

function expectDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(useAuthStore.getState().completeAccountDeletion).toHaveBeenCalledTimes(
    1,
  );
  expect(mockShowBrandNotice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Account deleted' }),
  );
  expect(allText(renderer)).not.toContain('Deletion status unknown');
}

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(
    useAuthStore.getState().completeAccountDeletion,
  ).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
}

/** After a confirmation was SENT: no "nothing deleted" claim, no re-armed
 * request or challenge for the same account. */
function expectSentConfirmationHonest(
  renderer: TestRenderer.ReactTestRenderer,
) {
  const text = allText(renderer);
  expect(text).not.toContain('Nothing was deleted');
  expect(text).not.toContain('Nothing has been deleted');
  expect(text).not.toContain('Delete your account?');
  expect(text).not.toContain('Keep my account');
  expect(text).not.toContain("What's making you leave?");
  expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
  expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
}

/** Drives owner A to a sent-but-unresolved confirmation (reply lost). */
async function loseConfirmation(renderer: TestRenderer.ReactTestRenderer) {
  await armDeletion(renderer);
  await press(renderer, sheetButton(renderer, 'Permanently delete'));
  expect(allText(renderer)).toContain('Deletion status unknown');
  expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
}

/** The device Keychain accepts the capability write but refuses the ONE
 * write that seals the completion receipt (errSecInteractionNotAllowed —
 * the Keychain is momentarily unavailable). Installed before the screen
 * creates the foundation, which captures the Keychain functions once. */
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

describe('W08-01 adversarial: ManageAccount deletion at its failure boundaries', () => {
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
    jest.restoreAllMocks();
    globalThis.fetch = realFetch;
    clearApiSession();
    mockDatabase.close();
    jest.useRealTimers();
  });

  describe('A. crash between steps: Keychain refuses the receipt seal after the server verified `deleted: true`', () => {
    it('A1. a server-verified completion receipt already in the journal is shown as completed, not as "may have completed"', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      refuseReceiptSeal();
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});

        // The confirmation reply was received in place, bound to the
        // operation, and the receipt verified: the journal row holds it.
        expect(calls('delete-confirm')).toHaveLength(1);
        const [row] = journalRows();
        expect(row).toMatchObject({
          owner_id: OWNER_A,
          operation_id: deletionId(10),
        });
        expect(journalDocument(row!)).toMatchObject({
          serverState: 'completed',
          receipt: { completedAt: expect.any(String) },
        });
        expect(deletionKeychainStore.size).toBe(1);

        // Expected: the account IS deleted (the server said so and the
        // receipt was verified) — hand off to onDeleted, never "unknown".
        expect(allText(renderer)).not.toContain('may have completed');
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('A2. relaunching after the status window with a healthy Keychain still completes from the journaled receipt instead of "contact support"', async () => {
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
        expect(journalDocument(journalRows()[0]!)).toMatchObject({
          serverState: 'completed',
          receipt: { completedAt: expect.any(String) },
        });
      } finally {
        act(() => first.unmount());
      }
      // The Keychain works again; the app comes back after 25 hours.
      seal.mockRestore();
      jest.setSystemTime(Date.now() + 25 * HOUR_MS);

      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        // Whatever the first render shows, the one action offered (if any)
        // must not end in "contact support" for a deletion the phone holds
        // the server's receipt for.
        const retry = sheetButtons(second, 'Retry deletion');
        if (retry.length > 0) {
          await press(second, retry[0]!);
          await act(async () => {});
        }
        const text = allText(second);
        expect(text).not.toContain(
          'The window for checking this deletion has closed',
        );
        expect(text).not.toContain('Deletion status unknown');
        expectDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('B. 429 + Retry-After on the request step', () => {
    it('B1. the rate-limit copy is not self-duplicating and does not promise "a moment" against a one-hour Retry-After', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', { error: { message: 'slow down' } }, 429, {
            headers: { 'retry-after': '3600' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await act(async () => {});
        const text = allText(renderer);
        expectNotDeleted(renderer);
        expect(journalRows()).toMatchObject([
          { phase: 'request_unknown', operation_id: null },
        ]);
        // One "nothing deleted" sentence, not two back to back.
        expect(
          [
            text.includes('Nothing was deleted'),
            text.includes('Nothing has been deleted'),
          ].filter(Boolean),
        ).toHaveLength(1);
        // The server asked for an hour; the copy must not say "a moment".
        expect(text).not.toContain('in a moment');
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('B2. pressing "Retry request" inside the Retry-After window sends nothing and mints nothing', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', { error: { message: 'slow down' } }, 429, {
            headers: { 'retry-after': '3600' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(1);
        for (let round = 0; round < 3; round += 1) {
          const retry = sheetButtons(renderer, 'Retry request');
          if (retry.length === 0 || retry[0]!.props.disabled === true) break;
          await press(renderer, retry[0]!);
          await act(async () => {});
        }
        expect(calls('delete-request')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
        expectNotDeleted(renderer);
        // After the window, the SAME job retries and arms.
        await advance(HOUR_MS);
        route({
          'delete-request': () => reply('delete-request', requestPayload()),
        });
        await press(renderer, sheetButton(renderer, 'Retry request'));
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(2);
        expect(journalRows()).toMatchObject([
          { phase: 'ready', operation_id: deletionId(10) },
        ]);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('C. clocks', () => {
    it('C1. a device clock rolled back an hour between request and confirmation does not re-arm the button with an hour-long unexplained countdown', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
          false,
        );
        // NTP correction: the wall clock jumps back an hour.
        jest.setSystemTime(Date.now() - HOUR_MS);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expectNotDeleted(renderer);
        expect(calls('delete-confirm')).toHaveLength(0);
        const label = String(
          sheetButton(renderer, 'Permanently delete').props.label,
        );
        const paced = /\((\d+)\)$/.exec(label);
        // Either the button stays armed (pacing was already served on this
        // screen) or it explains itself; a silent ~3600 s countdown is
        // neither.
        if (paced) {
          expect(Number(paced[1])).toBeLessThanOrEqual(5);
        }
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('C2. a device clock 25 hours fast over a lost confirmation makes the phone declare the window closed without asking the server (documented, self-heals when the clock is corrected)', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const first = renderScreen();
      try {
        await loseConfirmation(first);
      } finally {
        act(() => first.unmount());
      }
      const realNow = Date.now();
      jest.setSystemTime(realNow + 25 * HOUR_MS);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectNotDeleted(second);
        expectSentConfirmationHonest(second);
        expect(allText(second)).toContain(
          'The window for checking this deletion has closed',
        );
        expect(buttonLabels(second)).toEqual(['Close']);
        expect(calls('delete-status')).toHaveLength(0);
        await press(second, sheetButton(second, 'Close'));
      } finally {
        act(() => second.unmount());
      }
      // Clock corrected: the same operation is checked and completes.
      jest.setSystemTime(realNow + 60_000);
      const third = renderScreen();
      try {
        await openDeleteSheet(third);
        await pressWhenArmed(third, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectDeleted(third);
      } finally {
        act(() => third.unmount());
      }
    });
  });

  describe('D. status replies that must never render as deleted', () => {
    it('D1. a status `completed` WITHOUT a completion receipt stays unknown and calls nothing', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', {
            state: 'completed',
            completionReceipt: null,
            appleAuthorizationRevocation: 'revoked',
          }),
      });
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectNotDeleted(renderer);
        expectSentConfirmationHonest(renderer);
        expect(allText(renderer)).toContain('Deletion status unknown');
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
        expect(journalDocument(journalRows()[0]!)).toMatchObject({
          receipt: null,
        });
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('D2. a redirected status reply claiming `completed` with a receipt is never trusted', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed'), 200, {
            url: 'https://api.example.test/v1/me/delete-status',
          }),
      });
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectNotDeleted(renderer);
        expectSentConfirmationHonest(renderer);
        expect(allText(renderer)).toContain('Deletion status unknown');
        expect(journalDocument(journalRows()[0]!)).toMatchObject({
          receipt: null,
        });
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('D3. a confirmation reply `deleted: true` bound to the operation but WITHOUT a receipt is never rendered as deleted', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', {
            deleted: true,
            operationId: deletionId(10),
            completionReceipt: null,
            appleAuthorizationRevocation: 'revoked',
          }),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expect(calls('delete-confirm')).toHaveLength(1);
        expectNotDeleted(renderer);
        expectSentConfirmationHonest(renderer);
        expect(allText(renderer)).toContain('Deletion status unknown');
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('E. network failure at the confirm and status steps', () => {
    it('E1. a confirmation that hangs past the transport deadline is shown as unknown after exactly one send, then settles from the status receipt', async () => {
      const hang = deferred<Response>();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => hang.promise,
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(sheetButton(renderer, 'Deleting…').props.disabled).toBe(true);
        expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
          true,
        );
        await advance(TRANSPORT_TIMEOUT_MS - 1);
        expect(allText(renderer)).not.toContain('Deletion status unknown');
        await advance(1);
        expect(allText(renderer)).toContain('Deletion status unknown');
        expectNotDeleted(renderer);
        expectSentConfirmationHonest(renderer);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

        // The late reply must not be trusted after the deadline resolved
        // the step as unknown — and must not complete anything by itself.
        await act(async () => {
          hang.resolve(reply('delete-confirm', completionPayload()));
        });
        await act(async () => {});
        expectNotDeleted(renderer);

        // Recovery is a status check of the SAME operation, never a resend.
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(1);
        expect(headerOf(calls('delete-status')[0]!, 'Authorization')).toBe(
          `Bearer ${DELETION_CAPABILITY}`,
        );
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('E2. a 503 on the confirmation and then a 503 on the status check stay unknown with one confirmation sent; a later verified status completes', async () => {
      let statusCalls = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', { error: { message: 'unavailable' } }, 503),
        'delete-status': () => {
          statusCalls += 1;
          return statusCalls === 1
            ? reply('delete-status', { error: { message: 'unavailable' } }, 503)
            : reply('delete-status', statusPayload('completed'));
        },
      });
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        expectSentConfirmationHonest(renderer);
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectNotDeleted(renderer);
        expectSentConfirmationHonest(renderer);
        expect(allText(renderer)).toContain('Deletion status unknown');
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(2);
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('E3. a 429 with Retry-After 86400 on the confirmation never gets a status check inside the window (documented boundary: the honoured wait outlives the status capability)', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', { error: { message: 'slow down' } }, 429, {
            headers: { 'retry-after': '86400' },
          }),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expectNotDeleted(renderer);
        expectSentConfirmationHonest(renderer);
        expect(allText(renderer)).toContain('Deletion status unknown');
        const retry = sheetButton(renderer, 'Retry deletion');
        expect(retry.props.disabled).toBe(true);
        expect(String(retry.props.label)).toBe('Retry deletion (86400)');
        await advance(DAY_MS);
        await press(renderer, sheetButton(renderer, 'Retry deletion'));
        await act(async () => {});
        expect(calls('delete-status')).toHaveLength(0);
        expect(allText(renderer)).toContain(
          'The window for checking this deletion has closed',
        );
        expect(buttonLabels(renderer)).toEqual(['Close']);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('F. interleaved account switch and reentrancy', () => {
    it('F1. an account switch while the server carries the deletion out: the poll for owner A never goes out under owner B, and the outcome stays unknown/in progress', async () => {
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
          reply('delete-status', statusPayload('in_progress')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain('Deletion in progress');
        // Owner B signs in on this phone before the next poll fires.
        act(() => {
          signIn(OWNER_B, BEARER_B, 'apple');
        });
        await advance(2_000);
        await advance(5_000);
        expectNotDeleted(renderer);
        for (const init of calls('delete-status')) {
          expect(headerOf(init, 'Authorization')).not.toBe(
            `Bearer ${BEARER_B}`,
          );
        }
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expectSentConfirmationHonest(renderer);
        const text = allText(renderer);
        expect(
          text.includes('Deletion in progress') ||
            text.includes('Deletion status unknown'),
        ).toBe(true);
        expect(text).not.toContain('start again');
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('F2. re-entering the screen while the confirmation is still in flight must not tell the owner that the signed-in account changed', async () => {
      const hang = deferred<Response>();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => hang.promise,
      });
      const first = renderScreen();
      await armDeletion(first);
      await press(first, sheetButton(first, 'Permanently delete'));
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      // The same owner navigates away and back to Manage account while the
      // send is still unanswered (the in-flight operation outlives the
      // first screen instance).
      act(() => first.unmount());
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectSentConfirmationHonest(second);
        expect(allText(second)).not.toContain('signed-in account changed');
        await act(async () => {
          hang.resolve(reply('delete-confirm', completionPayload()));
        });
        await act(async () => {});
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('G. replayed server verdicts', () => {
    it('G1. a 409 deletion_in_progress recorded once is replayed as a live claim a week later without re-asking the server (documented: mirrors the server, which refuses new requests while a confirmation exists)', async () => {
      route({
        'delete-request': () =>
          reply(
            'delete-request',
            {
              error: {
                code: 'account.deletion_in_progress',
                message: 'Account deletion is already confirmed.',
              },
            },
            409,
            { headers: { 'retry-after': '30' } },
          ),
      });
      const first = renderScreen();
      try {
        await openReview(first);
        await press(first, sheetButton(first, 'Continue to delete'));
        await act(async () => {});
        expect(allText(first)).toContain('Deletion in progress');
        expect(buttonLabels(first)).toEqual(['Close']);
      } finally {
        act(() => first.unmount());
      }
      jest.setSystemTime(Date.now() + 7 * DAY_MS);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectNotDeleted(second);
        expect(allText(second)).toContain('Deletion in progress');
        expect(buttonLabels(second)).toEqual(['Close']);
        expect(calls('delete-request')).toHaveLength(1);
        expect(second.root.findAllByType(BrandSpinner)).toHaveLength(0);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('H. copy policy', () => {
    it('H1. no state of the dialog renders forbidden store copy', async () => {
      const forbidden = [
        /android/i,
        /google play/i,
        /\bguest\b/i,
        /live court/i,
        /dupr/i,
        /\d+\s?%/,
      ];
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const renderer = renderScreen();
      try {
        for (const pattern of forbidden)
          expect(allText(renderer)).not.toMatch(pattern);
        await press(renderer, pressable(renderer, 'Delete account')[0]!);
        for (const pattern of forbidden)
          expect(allText(renderer)).not.toMatch(pattern);
        await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
        for (const pattern of forbidden)
          expect(allText(renderer)).not.toMatch(pattern);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await advance(5_000);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain('Deletion status unknown');
        for (const pattern of forbidden)
          expect(allText(renderer)).not.toMatch(pattern);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });
});
