import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 adversarial suite against candidate 1ccc95c0 (ManageAccountScreen on
 * deletionOperation / deletionOperationTransport). Every test is an attack at
 * a failure boundary the candidate's own suite does not pin. A FAILING test
 * here is a confirmed break of the candidate; a passing test is an attack the
 * candidate withstood. Same seams as the shipping suite: real screen, real
 * SQLite journal, in-memory Keychain, routed `globalThis.fetch`.
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
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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
    statusExpiresAt: iso(DAY_MS),
  };
}

function statusPayload(state: string) {
  return {
    state,
    completionReceipt: state === 'completed' ? { completedAt: iso(0) } : null,
    appleAuthorizationRevocation: state === 'completed' ? 'revoked' : null,
  };
}

function inProgressError() {
  return {
    error: {
      code: 'account.deletion_in_progress',
      message:
        'Account deletion is already confirmed. Check its status before starting again.',
    },
  };
}

function rateLimitedError() {
  return { error: { message: 'Too many requests.' } };
}

function unavailableError() {
  return { error: { message: 'Account deletion is temporarily unavailable.' } };
}

/** A React Native-shaped fetch Response: `url` is the URL that answered. */
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

function journalRows() {
  return mockDatabase.native
    .prepare(
      'SELECT owner_id, operation_id, phase, document FROM device_account_deletion_journal ORDER BY rowid',
    )
    .all() as Array<{
    owner_id: string;
    operation_id: string | null;
    phase: string;
    document: string;
  }>;
}

/** Valid JSON (the table's CHECK demands it) that is no journal entry —
 * a truncated write or a schema drift the parser rejects. */
function corruptJournalDocument(ownerId: string) {
  const changed = mockDatabase.native
    .prepare(
      'UPDATE device_account_deletion_journal SET document = ? WHERE owner_id = ?',
    )
    .run('{"version":1,"truncated":true}', ownerId).changes;
  expect(changed).toBe(1);
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

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(
    useAuthStore.getState().completeAccountDeletion,
  ).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
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

function expectUnknownOutcome(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).toContain('Deletion status unknown');
  expect(text).not.toContain('Nothing was deleted');
  expect(
    sheetButtons(renderer, 'Permanently delete').filter(
      node => node.props.disabled !== true,
    ),
  ).toHaveLength(0);
  expectNotDeleted(renderer);
}

/** The survey is the honest entry for an owner with nothing to resume. */
function expectFreshEntry(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).toContain("What's making you leave?");
  expect(text).not.toContain('could not be read');
  expect(text).not.toContain('Deletion status unknown');
}

async function loseConfirmation(renderer: TestRenderer.ReactTestRenderer) {
  await armDeletion(renderer);
  await press(renderer, sheetButton(renderer, 'Permanently delete'));
  expectUnknownOutcome(renderer);
  expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
}

describe('W08-01 adversarial: ManageAccount deletion on candidate 1ccc95c0', () => {
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

  describe('A1/A2 — corrupt persisted state must stay scoped to the row it damages', () => {
    it('A1: an unreadable journal document belonging to owner A must not lock a replacement account (owner B) out of deleting its own account', async () => {
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
        expect(
          (calls('delete-request')[1]!.headers as Record<string, string>)
            .Authorization,
        ).toBe(`Bearer ${BEARER_B}`);
        expectNotDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });

    it('A2: an unreadable document over a challenge the phone never confirmed (phase column `ready`) must not claim a confirmation may have happened', async () => {
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
        const text = allText(second);
        expect(text).not.toContain(
          'cannot tell whether a deletion was confirmed',
        );
        expect(text).not.toContain('Deletion status unknown');
        expectNotDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('A3 — a stale server refusal is not durable truth', () => {
    it('A3: a 409 in-progress refusal cached in the journal must be re-asked after the server-side retention window, not shown as in progress forever with zero network calls', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', inProgressError(), 409, {
            headers: { 'retry-after': '3' },
          }),
      });
      const first = renderScreen();
      try {
        await openReview(first);
        await press(first, sheetButton(first, 'Continue to delete'));
        expect(allText(first)).toContain('Deletion in progress');
        expect(buttonLabels(first)).toEqual(['Close']);
        expect(journalRows()).toMatchObject([
          { phase: 'request_unknown', operation_id: null },
        ]);
        await press(first, sheetButton(first, 'Close'));
      } finally {
        act(() => first.unmount());
      }

      // The server keeps a confirmed operation 7 days (retain_until) and
      // would mint a fresh challenge now; the client never asks it again.
      await advance(8 * DAY_MS);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        for (let round = 0; round < 10; round += 1) await advance(0);
        await advance(60_000);
        const text = allText(second);
        const reAsked = calls('delete-request').length >= 2;
        const offersRetry =
          sheetButtons(second, 'Retry request').length > 0 ||
          sheetButtons(second, 'Continue to delete').length > 0;
        expect({
          reAskedOrRetryOffered: reAsked || offersRetry,
          buttons: buttonLabels(second),
          requestCalls: calls('delete-request').length,
          statusCalls: calls('delete-status').length,
          heading: /Deletion in progress/.test(text)
            ? 'Deletion in progress'
            : 'other',
        }).toEqual(expect.objectContaining({ reAskedOrRetryOffered: true }));
        expectNotDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('A4 — `superseded` is answered only while nothing was confirmed', () => {
    it('A4: a `superseded` status after a lost confirmation proves the account is present and must read like `expired` — not as an unknown outcome whose copy says to start again while offering no way to', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('superseded')),
      });
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        const text = allText(renderer);
        expectNotDeleted(renderer);
        expect(text).toContain('A newer deletion request replaced this one');
        expect({
          buttons: buttonLabels(renderer),
          heading: /Deletion status unknown/.test(text)
            ? 'Deletion status unknown'
            : 'Delete your account?',
        }).toEqual(
          expect.objectContaining({
            buttons: expect.arrayContaining(['Continue to delete']),
            heading: 'Delete your account?',
          }),
        );
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('A5/A6 — network failure on the status and confirm steps', () => {
    it('A5: a redirected delete-status reply that carries a completed receipt is never rendered as deleted and never seals a receipt', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed'), 200, {
            url: 'https://attacker.example/v1/me/delete-status',
          }),
      });
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectUnknownOutcome(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
        expect(journalRows()[0]!.document).not.toContain('completedAt');
        expect(deletionKeychainStore.size).toBe(1);
        for (const value of deletionKeychainStore.values()) {
          expect(JSON.stringify(value)).not.toContain('completedAt');
        }
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('A6: a 503 on the confirmation is an unknown outcome (never re-armed, never "nothing deleted") and completes only from a verified status receipt', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', unavailableError(), 503),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(allText(renderer)).not.toContain('Nothing has been deleted');
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(1);
        expectDeleted(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('A7 — clock rollback', () => {
    it('A7: a device clock that moves back after a lost confirmation must not stretch the retry wait past the foundation cap (60 s)', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const first = renderScreen();
      try {
        await loseConfirmation(first);
      } finally {
        act(() => first.unmount());
      }

      jest.setSystemTime(Date.now() - HOUR_MS);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectUnknownOutcome(second);
        const label = String(sheetButton(second, 'Retry deletion').props.label);
        const paced = /\((\d+)\)$/.exec(label);
        const waitSeconds = paced ? Number(paced[1]) : 0;
        expect({ label, waitSeconds }).toMatchObject({
          waitSeconds: expect.any(Number),
        });
        expect(waitSeconds).toBeLessThanOrEqual(60);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('A8 — process/lifecycle: teardown mid-poll', () => {
    it('A8: tearing the screen down while a status poll is in flight must not leave a detached poll loop making network calls', async () => {
      const poll = deferred<Response>();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            { operationId: deletionId(10), state: 'in_progress' },
            202,
            { headers: { 'retry-after': '3' } },
          ),
        'delete-status': () =>
          calls('delete-status').length === 1
            ? poll.promise
            : reply('delete-status', statusPayload('in_progress')),
      });
      const renderer = renderScreen();
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain('Deletion in progress');
      await advance(3_000);
      expect(calls('delete-status')).toHaveLength(1);

      act(() => renderer.unmount());
      await act(async () => {
        poll.resolve(reply('delete-status', statusPayload('in_progress')));
      });
      await advance(3_000);
      await advance(3_000);
      await advance(60_000);
      expect(calls('delete-status')).toHaveLength(1);
    });
  });

  describe('A9 — copy on a refused request', () => {
    it('A9: a 429 on the request must not stack two "nothing deleted" sentences', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', rateLimitedError(), 429, {
            headers: { 'retry-after': '30' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        const text = allText(renderer);
        expectNotDeleted(renderer);
        expect(text).toContain('Too many attempts');
        expect(text).not.toMatch(
          /Nothing was deleted\.\s+Nothing has been deleted\./,
        );
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('A10/A11 — concurrency', () => {
    it('A10: two "Retry deletion" taps in one frame are one status call and never a second confirmation', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        await advance(3_000);
        const retry = sheetButton(renderer, 'Retry deletion');
        expect(retry.props.disabled).toBe(false);
        await act(async () => {
          retry.props.onPress();
          retry.props.onPress();
        });
        expect(calls('delete-status')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('A11: an account switch between an in-progress confirmation and its poll never polls or completes for the replacement account and never mints a request', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            { operationId: deletionId(10), state: 'in_progress' },
            202,
            { headers: { 'retry-after': '3' } },
          ),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain('Deletion in progress');

        await act(async () => {
          signIn(OWNER_B, BEARER_B, 'apple');
        });
        await advance(3_000);
        await advance(3_000);
        expect(calls('delete-status')).toHaveLength(0);
        expect(calls('delete-request')).toHaveLength(1);
        expectNotDeleted(renderer);
        expect(allText(renderer)).not.toContain('Delete your account?');
        expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, phase: 'observing' },
        ]);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });
});
